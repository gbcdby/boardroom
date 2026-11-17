import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client, type QueryResult } from "pg";
import { postgresAuditFixture } from "./fixtures/maintenance-source-audit-postgres.ts";
import { controllerWriterFixture, historicalControllerProcess, historicalControllerRow } from "./fixtures/maintenance-controller-history.ts";
import type { ControllerCommandScope } from "../src/server/storage/maintenance/controller-write.ts";
import type { SourceLock } from "../src/server/storage/maintenance/types.ts";
const pgTest = process.env.AGENT_STUDIO_PG_TEST_URL ? test : test.skip;

// Only these new capture/restore engineering fixtures use the Linux source-FD bridge.
// The existing native audit cases keep their original cross-platform gate.
const pgCaptureTest = process.platform === "linux" ? pgTest : test.skip;

pgCaptureTest("C3 PostgreSQL actual factory keeps staged registration invisible until COMMIT and promotes on a fresh lock", async () => {
  const f = await controllerWriterFixture("postgres"), query = Client.prototype.query, end = Client.prototype.end;
  const sessions = new WeakSet<Client>(), events: string[] = [];
  let scope: ControllerCommandScope | undefined, firstAnchor = "", sampled = false;
  try {
    Client.prototype.query = async function(this: Client, ...args: unknown[]) {
      const value = await Reflect.apply(query, this, args) as QueryResult;
      const sql = typeof args[0] === "string" ? args[0] : "";
      const database = (this as unknown as { connectionParameters: { database: string } }).connectionParameters.database;
      if (database !== f.database) return value;
      if (sql.startsWith("LOCK TABLE") && sql.includes("SHARE ROW EXCLUSIVE")) sessions.add(this);
      if (sessions.has(this) && sql === "COMMIT") events.push("commit-returned");
      if (sessions.has(this) && sql.startsWith("INSERT INTO storage_source_clients")) {
        const outside = await f.connect();
        try {
          const actual = (await outside.query("SELECT journal_record_ref,(SELECT count(*)::text FROM storage_source_clients) AS count FROM storage_maintenance")).rows[0];
          assert.equal(actual.journal_record_ref, firstAnchor); assert.equal(actual.count, "1"); sampled = true;
        } finally { await f.closeClient(outside); }
      }
      return value;
    } as typeof query;
    Client.prototype.end = async function(this: Client) {
      await Reflect.apply(end, this, []); if (sessions.has(this)) events.push("source-closed");
    } as typeof end;
    const first = await f.adapter.withSourceLock("control", async lock => {
      const begun = await f.writer.beginControllerCommand(f.adapter, f.mutex, lock, { operation: "resume-migration", request: f.request });
      scope = begun.scope; return f.writer.commitControllerStep(scope, lock, { kind: "first-capture" });
    });
    firstAnchor = first.node.reference.ref;
    const takeover = await f.adapter.withSourceLock("control", lock => f.writer.commitControllerStep(scope!, lock, { kind: "takeover" }));
    assert.equal(takeover.node.record.formatVersion === 3 ? takeover.node.record.controlProof?.facts.actor.clientId : undefined, null);
    const recapture = await f.adapter.withSourceLock("control", async lock => {
      const audit = await lock.readSourceClientAudit(f.reference); assert(audit.facts.actor.clientId);
      return f.writer.commitControllerStep(scope!, lock, { kind: "recapture" });
    });
    assert(sampled); assert.deepEqual(events, ["commit-returned", "source-closed", "commit-returned", "source-closed", "commit-returned", "source-closed"]);
    assert.deepEqual(recapture.node.record.frozen, first.node.record.frozen);
    assert.equal((await f.adapter.observeSourceClients()).rows.length, 2);
  } finally { Client.prototype.query = query; Client.prototype.end = end; await f.close(); }
});

pgCaptureTest("C3 PostgreSQL original callback undefined waits for forgotten restore parent and child before source end", async () => {
  const f = await controllerWriterFixture("postgres", { legacyCapture: true });
  let scope: ControllerCommandScope | undefined, original: SourceLock | undefined, release!: () => void, reached!: () => void;
  let operation: Promise<void> | undefined, outer: Promise<void> | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { reached = resolve; });
  try {
    await f.adapter.withSourceLock("control", async lock => {
      ({ scope } = await f.writer.beginControllerCommand(f.adapter, f.mutex, lock, { operation: "resume-migration", request: f.request }));
    });
    const before = await f.adapter.observeSourceClients(); let completed = false;
    outer = f.adapter.withSourceLock("snapshot", async lock => {
      original = lock;
      const read = lock.observeSourceClients.bind(lock); let child = false;
      lock.observeSourceClients = async () => { if (child) { reached(); await gate; } return read(); };
      operation = f.consumers.withControllerRestoreCallback(scope!, lock, () => {
        child = true; return f.consumers.prepareControllerSnapshot(scope!, lock);
      });
      void operation.catch(() => undefined); await entered; throw undefined;
    });
    void outer.then(() => { completed = true; }, () => { completed = true; });
    await entered; await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(completed, false); assert.notEqual(f.sql.controlSqlOutcome(original!).commitReturned, true);
    assert.equal(f.sql.controlSqlOutcome(original!).localSourceHandleClosed, false);
    await original!.assertHeld(); release();
    let rejected = false;
    try { await outer; } catch (error) { rejected = true; assert.equal(error, undefined); }
    assert(rejected); await assert.rejects(operation!, { code: "maintenance_lost" });
    assert.equal(f.sql.controlSqlOutcome(original!).failureObserved, true);
    assert.equal(f.sql.controlSqlOutcome(original!).originalError, undefined);
    assert.equal(f.sql.controlSqlOutcome(original!).localSourceHandleClosed, true);
    assert.deepEqual(f.sql.controlSqlOutcome(original!).cleanupEvents, [], "the single private close marker is not a second cleanup failure");
    assert.deepEqual(await f.adapter.observeSourceClients(), before);
  } finally { release(); await Promise.allSettled([...(outer ? [outer] : []), ...(operation ? [operation] : [])]); await f.close(); }
});

async function fixture(encoding: "UTF8" | "LATIN1" = "UTF8") {
  const actor = await historicalControllerProcess();
  let source: Awaited<ReturnType<typeof postgresAuditFixture>> | undefined;
  try {
    source = await postgresAuditFixture(encoding, { beforeRegister: async descriptor => {
      const client = new Client(descriptor); await client.connect();
      // Carried open state, not proof that a historical controller was ever registered by this product.
      try { await client.query("UPDATE storage_maintenance SET fence_epoch=2"); }
      finally { await client.end(); }
    } });
    const row = historicalControllerRow(source.plan.source, actor), writer = await source.connect();
    try {
      const names = Object.keys(row);
      await writer.query(`INSERT INTO storage_source_clients (${names.join(",")}) VALUES (${names.map((_, index) => `$${index + 1}`).join(",")})`, Object.values(row));
    } finally { await source.closeClient(writer); }
    const ready = source;
    return { ...ready, actor, row, async close() { await actor.close(); await ready.close(); } };
  } catch (error) { await actor.close(); await source?.close(); throw error; }
}

pgTest("A12-B historical PostgreSQL controller preserves actual raw rows, ordinary sessions and readonly anchor", async t => {
  for (const encoding of ["UTF8", "LATIN1"] as const) await t.test(encoding, async () => {
    const f = await fixture(encoding);
    try {
      await f.actor.exit();
      await f.adapter.withSourceLock("control", async lock => {
        const before = await lock.observeSourceClients(), packet = await lock.readSourceClientAudit(f.reference);
        assert.equal(before.state.fenceEpoch, 3); assert.equal(before.textEncoding.name, encoding);
        assert.equal(packet.kind, "untrusted-source-client-audit"); assert.equal(packet.origin.capture, null);
        assert.equal(packet.facts.actor.clientId, null);
        assert.deepEqual(packet.observation, before); assert.equal(before.rows.length, 2);
        assert(before.rows.every(row => Object.keys(row).length === 16));
        const old = packet.facts.clients.find(value => Buffer.from(value.subject[1], "hex").toString("utf8") === f.row.client_id)!;
        assert.equal(old.kind, "maintenance-controller");
        if (old.kind !== "maintenance-controller") assert.fail("historical controller fact required");
        assert.equal(old.classification, "exited-actor"); assert.equal(old.registration, "R0-historical");
        assert.equal(old.processCheck.kind, process.platform === "linux" ? "linux-absent" : "darwin-absent");
        assert.deepEqual(old.process, f.actor.identity);
        const raw = before.rows.find(row => row.client_id[1] === old.subject[1])!;
        assert.deepEqual(raw.ended_at, ["null"]);
        const registration = JSON.parse(Buffer.from(raw.db_sessions_json[1], "hex").toString("utf8"));
        assert.equal(registration.creation.ownerGeneration, "7", "historical generation remains its original value");
        assert(packet.facts.clients.some(value => value.kind === "ordinary-client" && value.classification === "current-client"));
        const sessions = packet.facts.sessions;
        assert.equal(sessions.kind, "postgres-session-audit-v1");
        if (sessions.kind !== "postgres-session-audit-v1") assert.fail("actual PostgreSQL session audit required");
        assert.equal(sessions.activity.length, 3); assert.equal(sessions.preparedQueryRows, 0);
        assert.equal(sessions.registeredSessions.length, 2, "all ordinary registration positions remain represented");
        assert(sessions.registeredSessions.every(session => session.subject[1] !== old.subject[1]));
        assert.deepEqual(await lock.observeSourceClients(), before);
      });
      await f.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(f.reference, async facts => {
        assert.equal(facts.observation.textEncoding.name, encoding);
        const historical = facts.clients.find(client => client.clientId === f.row.client_id)!;
        assert.equal(historical.classification, "historical-controller"); assert.equal(historical.process.status, "exited");
        await facts.assertCurrent();
      }));
    } finally { await f.close(); }
  });
});

pgTest("A12-B historical PostgreSQL controller requires actual exit even with ended_at", async () => {
  const f = await fixture();
  const read = () => f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference));
  try {
    const writer = await f.connect();
    try { await writer.query("UPDATE storage_source_clients SET ended_at=$1 WHERE client_id=$2", ["2026-11-01T00:00:01.000Z", f.row.client_id]); }
    finally { await f.closeClient(writer); }
    await assert.rejects(read(), { code: "source_writer_unknown" });
    await f.actor.exit();
    assert.equal((await read()).facts.clients.find(value => value.kind === "maintenance-controller")?.classification, "exited-actor");
  } finally { await f.close(); }
});

pgTest("A12-B historical PostgreSQL controller cannot exempt a foreign backend or prepared transaction", async t => {
  const f = await fixture(); await f.actor.exit();
  const read = () => f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference));
  try {
    await t.test("copied historical controller tag is not a session capability", async () => {
      const foreign = await f.connect(`boardroom-source:${f.row.client_id}`);
      try { await assert.rejects(read(), { code: "source_writer_unknown" }); }
      finally { await f.closeClient(foreign); }
    });
    await t.test("real prepared transaction survives its backend", async () => {
      const gid = `a12b_history_${randomUUID().replaceAll("-", "")}`, writer = await f.connect(); let prepared = false;
      try {
        assert(Number((await writer.query("SHOW max_prepared_transactions")).rows[0].max_prepared_transactions) > 0);
        await writer.query("BEGIN"); await writer.query("SELECT 1");
        await writer.query(`PREPARE TRANSACTION '${gid}'`); prepared = true;
      } finally { await f.closeClient(writer); }
      try { await assert.rejects(read(), { code: "source_writer_unknown" }); }
      finally {
        if (prepared) {
          const cleanup = await f.connect();
          try { await cleanup.query(`ROLLBACK PREPARED '${gid}'`); }
          finally { await f.closeClient(cleanup); }
        }
      }
    });
    assert.equal((await read()).facts.clients.find(value => value.kind === "maintenance-controller")?.classification, "exited-actor");
  } finally { await f.close(); }
});

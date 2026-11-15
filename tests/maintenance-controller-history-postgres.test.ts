import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { postgresAuditFixture } from "./fixtures/maintenance-source-audit-postgres.ts";
import { historicalControllerProcess, historicalControllerRow } from "./fixtures/maintenance-controller-history.ts";
const pgTest = process.env.AGENT_STUDIO_PG_TEST_URL ? test : test.skip;

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
      await assert.rejects(f.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(f.reference, async () => assert.fail("default A11 must reject controllers"))),
        { code: "source_writer_unknown" });
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

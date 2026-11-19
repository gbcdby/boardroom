import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { protocolPostgresAuditFixture as postgresAuditFixture } from "./fixtures/maintenance-source-audit-postgres.ts";
import { registerExitedAuditClient } from "./fixtures/maintenance-audit-history-child.ts";
import { checkFactsShape, eventFactsSchema } from "../src/server/storage/maintenance/control-candidate/schema.ts";
import { storageReceiptDigest } from "../src/server/storage/source-client.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";
import type { SourceLock } from "../src/server/storage/maintenance/types.ts";
const pgTest = process.env.AGENT_STUDIO_PG_TEST_URL ? test : test.skip;

pgTest("A12-B preserves actual PostgreSQL sessions, registration positions and bootstrap identity", async () => {
  const f = await postgresAuditFixture();
  try {
    let entryType: string | undefined;
    const packet = await f.adapter.withSourceLock("control", async lock => {
      const before = await lock.observeSourceClients();
      entryType = typeof lock.readSourceClientAudit;
      if (entryType !== "function") return undefined;
      const result = await lock.readSourceClientAudit(f.reference);
      assert.deepEqual(result.observation, before);
      assert.deepEqual(await lock.observeSourceClients(), before);
      return result;
    });
    assert.equal(entryType, "function", "real PostgreSQL audit entry is required"); assert(packet);
    const facts = eventFactsSchema.parse(packet.facts); checkFactsShape(facts, packet.observation.source);
    assert.equal(facts.actor.clientId, null); assert.equal(facts.actor.process.pid, process.pid);
    assert.equal(facts.clients[0]!.kind, "ordinary-client");
    assert.equal(facts.clients[0]!.receipt?.digest, storageReceiptDigest(f.receipt));
    const sessions = facts.sessions; assert.equal(sessions.kind, "postgres-session-audit-v1");
    if (sessions.kind !== "postgres-session-audit-v1") assert.fail("actual backend audit mismatch");
    assert.equal(sessions.preparedQueryRows, 0);
    assert.deepEqual(sessions.ownedSessions.map(item => item.role).sort(), ["inspection", "operation-mutex", "source-control"]);
    assert.equal(sessions.activity.length, 3);
    for (const observed of sessions.activity) {
      assert(sessions.ownedSessions.some(owned => owned.pid === observed.pid && owned.backendStart === observed.backendStart));
      assert.equal(observed.backendType, "client backend"); assert.equal(typeof observed.writeLock, "boolean");
    }
    assert.equal(sessions.registeredSessions.length, 2);
    assert.deepEqual(sessions.registeredSessions.map(item => item.owner).sort(), ["client-control", "local-driver"]);
    const raw = packet.observation.rows[0]!;
    const envelope = JSON.parse(Buffer.from(raw.db_sessions_json[1], "hex").toString("utf8"));
    await f.admin.query("SET TimeZone='UTC'");
    for (const entry of sessions.registeredSessions) {
      assert.deepEqual(entry.subject, raw.client_id);
      const original = envelope.sessions[entry.sessionIndex].observedBackends[entry.backendIndex];
      assert.equal(entry.pid, original.pid); assert.equal(entry.originalBackendStart, original.backend_start);
      const expected = (await f.admin.query("SELECT $1::timestamptz::text AS normalized", [original.backend_start])).rows[0].normalized;
      assert.equal(entry.normalizedBackendStart, expected);
    }
    assert.equal("authorized" in packet, false);
    assert(Object.isFrozen(packet.facts.sessions));
  } finally { await f.close(); }
});

pgTest("A12-B records all real registration positions beyond the diagnostic cap", async () => {
  const f = await postgresAuditFixture("UTF8", { clientCount: 17 });
  try {
    const packet = await f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference));
    const audit = packet.facts.sessions; assert.equal(audit.kind, "postgres-session-audit-v1");
    assert.equal(packet.facts.clients.length, 17); assert.equal(audit.registeredSessions.length, 34);
    const positions = audit.registeredSessions.map(entry => `${entry.subject[1]}:${entry.sessionIndex}:${entry.backendIndex}`);
    assert.equal(new Set(positions).size, 34);
    for (const raw of packet.observation.rows) {
      const envelope = JSON.parse(Buffer.from(raw.db_sessions_json[1], "hex").toString("utf8"));
      for (const [sessionIndex, session] of envelope.sessions.entries()) for (const [backendIndex, backend] of session.observedBackends.entries()) {
        const actual: (typeof audit.registeredSessions)[number] = audit.registeredSessions.find(item => item.subject[1] === raw.client_id[1]
          && item.sessionIndex === sessionIndex && item.backendIndex === backendIndex)!;
        assert.equal(actual.pid, backend.pid); assert.equal(actual.owner, session.owner);
        assert.equal(actual.originalBackendStart, backend.backend_start);
      }
    }
  } finally { await f.close(); }
});

pgTest("A12-B PostgreSQL preserves historical exit evidence and actual non-UTF8 raw rows", async t => {
  for (const encoding of ["LATIN1", "SQL_ASCII"] as const) await t.test(encoding, async () => {
    let historicalId = "";
    const f = await postgresAuditFixture(encoding, { beforeRegister: async descriptor => {
      historicalId = await registerExitedAuditClient(descriptor);
    } });
    try {
      const packet = await f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference));
      assert.equal(packet.observation.textEncoding.name, encoding);
      const old = packet.facts.clients.find(item => Buffer.from(item.subject[1], "hex").toString("utf8") === historicalId)!;
      assert.equal(old.kind, "ordinary-client"); assert.equal(old.classification, "historical-client"); assert.equal(old.receipt, null);
      assert.equal(old.processCheck.kind, process.platform === "linux" ? "linux-absent" : "darwin-absent");
      const audit = packet.facts.sessions; assert.equal(audit.kind, "postgres-session-audit-v1");
      assert.equal(audit.registeredSessions.length, 4);
    } finally { await f.close(); }
  });
});

pgTest("A12-B still rejects a real foreign backend and a real prepared transaction", async t => {
  const f = await postgresAuditFixture();
  const read = () => f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference));
  try {
    await t.test("copied maintenance tag does not confer ownership", async () => {
      const foreign = await f.connect("boardroom-maintenance:copied-a12-actor");
      try { await assert.rejects(read(), { code: "source_writer_unknown" }); } finally { await f.closeClient(foreign); }
    });
    await t.test("prepared transaction remains blocking after its session closes", async () => {
      const gid = `a12b_${randomUUID().replaceAll("-", "")}`, writer = await f.connect(); let prepared = false;
      try {
        assert(Number((await writer.query("SHOW max_prepared_transactions")).rows[0].max_prepared_transactions) > 0);
        await writer.query("BEGIN"); await writer.query("SELECT 1"); await writer.query(`PREPARE TRANSACTION '${gid}'`); prepared = true;
      } finally { await f.closeClient(writer); }
      try { await assert.rejects(read(), { code: "source_writer_unknown" }); }
      finally {
        if (prepared) { const cleanup = await f.connect(); try { await cleanup.query(`ROLLBACK PREPARED '${gid}'`); } finally { await f.closeClient(cleanup); } }
      }
    });
    const after = await read(); assert.equal(after.kind, "untrusted-source-client-audit");
  } finally { await f.close(); }
});

pgTest("A12-B rejects an actual backend arriving between collection and final fresh recheck", async t => {
  const f = await postgresAuditFixture(), original = Client.prototype.query;
  let foreign: Client | undefined, injected = false, activityCalls = 0, fulfilled = false;
  t.mock.method(Client.prototype, "query", function(this: Client, ...args: unknown[]) {
    const sql = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string })?.text ?? "";
    if (sql.startsWith("SELECT pid,backend_start::text,backend_type,state,")) activityCalls++;
    const result = Reflect.apply(original, this, args);
    if (!injected && sql === "SELECT 1 FROM pg_catalog.pg_prepared_xacts WHERE database=current_database() LIMIT 1") {
      injected = true;
      return result.then(async (value: unknown) => { foreign = await f.connect("boardroom-maintenance:late-actual-backend"); return value; });
    }
    return result;
  });
  try {
    await assert.rejects(f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference))
      .then(value => { fulfilled = true; return value; }), { code: "source_writer_unknown" });
    assert(injected); assert.equal(activityCalls, 2); assert.equal(fulfilled, false);
  } finally { t.mock.restoreAll(); if (foreign) await f.closeClient(foreign); await f.close(); }
});

pgTest("A12-B PostgreSQL bootstrap follows the real mutex invocation and native lock loss", async t => {
  const f = await postgresAuditFixture(); let escaped: SourceLock | undefined;
  let tickTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const first = await f.adapter.withSourceLock("control", async lock => { escaped = lock; return lock.readSourceClientAudit(f.reference); });
    const second = await f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference));
    assert.deepEqual(second.facts.actor, first.facts.actor);
    await f.mutex.release();
    const query = Client.prototype.query, end = Client.prototype.end, interval = globalThis.setInterval;
    let mutexClient: Client | undefined, pendingQueries = 0, mutexQueries = 0, mutexEnds = 0, capturedTimers = 0;
    let lossObserved = false, observedLostTick!: () => void;
    const lostTick = new Promise<void>(resolve => { observedLostTick = resolve; });
    t.mock.method(Client.prototype, "query", function(this: Client, ...args: unknown[]) {
      const sql = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string })?.text ?? "";
      if (!mutexClient && sql.startsWith("SELECT pg_catalog.pg_try_advisory_lock(")) mutexClient = this;
      if (this !== mutexClient) return Reflect.apply(query, this, args);
      pendingQueries++; mutexQueries++;
      try {
        return (Reflect.apply(query, this, args) as Promise<unknown>).then(
          value => { pendingQueries--; return value; }, error => { pendingQueries--; throw error; });
      } catch (error) { pendingQueries--; throw error; }
    });
    t.mock.method(Client.prototype, "end", function(this: Client, ...args: unknown[]) {
      if (this === mutexClient) mutexEnds++;
      return Reflect.apply(end, this, args);
    });
    // Capture only the timer created by this acquisition, preserving its real
    // callback/this/arguments and 1s interval. Never invoke or shorten a tick.
    const captureInterval = t.mock.method(globalThis, "setInterval", ((callback: (...args: unknown[]) => unknown,
      milliseconds?: number, ...args: unknown[]) => {
      assert.equal(milliseconds, 1_000); assert.equal(capturedTimers++, 0);
      return Reflect.apply(interval, globalThis, [function(this: unknown, ...values: unknown[]) {
        const idle = pendingQueries === 0;
        const result = Reflect.apply(callback, this, values);
        // An older pending query is not evidence of a fresh post-loss check.
        if (lossObserved && idle) observedLostTick();
        return result;
      }, milliseconds, ...args]);
    }) as typeof setInterval);
    let nextMutex!: Awaited<ReturnType<typeof f.adapter.acquireMutex>>;
    try { nextMutex = await f.adapter.acquireMutex(f.store.identity, (await f.adapter.observe()).state); }
    finally { captureInterval.mock.restore(); }
    assert.equal(capturedTimers, 1); assert(mutexClient);
    await assert.rejects(async () => escaped!.readSourceClientAudit(f.reference), { code: "maintenance_lost" });
    let actualStopped = false, newActorId = "", mutexPid = 0, mutexBackendStart = "";
    await assert.rejects(f.adapter.withSourceLock("control", async lock => {
      const packet = await lock.readSourceClientAudit(f.reference); newActorId = packet.facts.actor.actorId;
      const sessions = packet.facts.sessions; assert.equal(sessions.kind, "postgres-session-audit-v1");
      const holder = sessions.ownedSessions.find(item => item.role === "source-control")!;
      const mutexHolder = sessions.ownedSessions.find(item => item.role === "operation-mutex")!;
      mutexPid = mutexHolder.pid; mutexBackendStart = mutexHolder.backendStart;
      assert.equal((mutexClient as unknown as { processID: number }).processID, mutexPid);
      actualStopped = (await f.admin.query("SELECT pg_terminate_backend($1,1000) AS stopped", [holder.pid])).rows[0].stopped === true;
      return lock.readSourceClientAudit(f.reference);
    }), { code: "maintenance_lost" });
    assert(actualStopped); assert.notEqual(newActorId, first.facts.actor.actorId);
    await assert.rejects(f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference)), { code: "maintenance_lost" });
    lossObserved = true;
    await Promise.race([lostTick, new Promise<never>((_, reject) => {
      tickTimeout = setTimeout(() => reject(new Error("the owned natural heartbeat did not observe the lost source")), 20_000);
    })]);
    clearTimeout(tickTimeout); tickTimeout = undefined;
    const queriesBeforeRelease = mutexQueries;
    await assert.rejects(nextMutex.release(), { code: "maintenance_lost" });
    assert.equal(mutexEnds, 1); assert.equal(mutexQueries, queriesBeforeRelease, "cleanup cannot replay source SQL");
    assert.equal((await f.admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid=$1 AND backend_start::text=$2 AND datname=$3",
      [mutexPid, mutexBackendStart, f.database])).rows[0].count, 0);
    await assert.rejects(f.adapter.observe(), { code: "maintenance_lost" });
  } finally { clearTimeout(tickTimeout); t.mock.restoreAll(); await f.close(); }
});

pgTest("A12-B PostgreSQL strict inspection-close failure cannot fulfill the audit", async t => {
  const f = await postgresAuditFixture(), query = Client.prototype.query, end = Client.prototype.end;
  const inspectionClients = new WeakSet<Client>(); let closes = 0, injected = false, fulfilled = false;
  t.mock.method(Client.prototype, "query", function(this: Client, ...args: unknown[]) {
    if (typeof args[0] === "string" && args[0].startsWith("SELECT pid,backend_start::text,backend_type,state,")) inspectionClients.add(this);
    return Reflect.apply(query, this, args);
  });
  t.mock.method(Client.prototype, "end", function(this: Client, ...args: unknown[]) {
    const result = Reflect.apply(end, this, args);
    if (inspectionClients.has(this) && ++closes === 2) return Promise.resolve(result).then(() => {
      injected = true; throw Object.assign(new Error("controlled native end uncertainty"), { code: "EIO" });
    });
    return result;
  });
  try {
    await assert.rejects(f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference))
      .then(value => { fulfilled = true; return value; }), error => error instanceof MaintenanceFailure
        && error.code === "maintenance_lost"
        && error.message === new MaintenanceFailure("maintenance_lost", "source-client-facts").message);
    assert(injected); assert.equal(closes, 2); assert.equal(fulfilled, false);
    // The injected uncertain close invalidates this adapter. A natural heartbeat
    // may have retained that same loss before release; consume only that expected
    // failure here so the fixture still verifies every session closes before DROP.
    let releaseOutcome = "released";
    try { await f.mutex.release(); }
    catch (error) {
      assert(error instanceof MaintenanceFailure);
      assert.equal(error.code, "maintenance_lost");
      assert.equal(error.message, new MaintenanceFailure("maintenance_lost").message);
      releaseOutcome = "expected-monitor-loss";
    }
    t.diagnostic(`inspection-close injection confirmed; audit rejected; mutex release: ${releaseOutcome}`);
    await assert.rejects(f.adapter.observe(), error => error instanceof MaintenanceFailure
      && error.code === "maintenance_lost"
      && error.message === new MaintenanceFailure("maintenance_lost").message);
  } finally { t.mock.restoreAll(); await f.close(); }
});

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { setImmediate as immediate, setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Client, type ClientConfig, type QueryResult } from "pg";
import ts from "typescript";
import { canonicalJson } from "../src/server/storage/maintenance/canonical.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";
import { assertPostgresServerCapability, stablePostgresSourceIdentity } from "../src/server/storage/maintenance/postgres-identity.ts";
import { parsePostgresConnection } from "../src/server/storage/maintenance/postgres-tools.ts";
import type { OperationMutex } from "../src/server/storage/maintenance/types.ts";
import { postgresAuditFixture } from "./fixtures/maintenance-source-audit-postgres.ts";

const pgTest = process.env.AGENT_STUDIO_PG_TEST_URL ? test : test.skip;
const sqlText = (value: unknown) => typeof value === "string" ? value : typeof value === "object" && value !== null && "text" in value ? String(value.text) : "";

/** Whole production acquire/timer/release/identity/guard bodies, with the installed
 * pg Client query queue and end behavior. Only its wire is controlled. No server,
 * fake clock or manually invoked heartbeat callback is used by these controls. */
async function controlledHeartbeat() {
  const text = await readFile(new URL("../src/server/storage/maintenance/postgres.ts", import.meta.url), "utf8");
  const source = ts.createSourceFile("postgres.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = ["same", "safeError", "throwResourceFailures", "checkedReader", "assertOpen", "endSession", "connect", "readIdentity", "assertMutex", "acquireMutex"];
  const found = new Map<string, string>(); let invalidation: string | undefined;
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) found.set(node.name.text, node.getText(source));
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "invalidate") invalidation = `const ${node.getText(source)};`;
    ts.forEachChild(node, visit);
  }
  visit(source); assert.equal(found.size, names.length); assert.ok(invalidation);
  const body = ts.transpileModule(invalidation + "\n" + [...found.values()].join("\n"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const sourceConnection = parsePostgresConnection({ kind: "postgres", connectionString: "postgresql://test@127.0.0.1/test" });
  assert.equal(sourceConnection.clientConfig.query_timeout, 15_000);
  const identityRow = { system_identifier: "1", database_oid: "7", database_name: "test", schema_oid: "9", server_address: "127.0.0.1", server_port: 5432,
    postmaster_started_at: "fixed", server_version: "160006", fsync: "on", in_recovery: false };
  const root = { hostIdentityDigest: "fixed-host" };
  const keySource = { systemIdentifier: "1", databaseOid: "7", schemaOid: "9", databaseInstanceId: "fixed-instance" };
  const digest = createHash("sha256").update(canonicalJson({ protocol: "boardroom-maintenance-v1", ...keySource })).digest();
  const identity = { formatVersion: 1, kind: "postgres-session-advisory", source: keySource, key: [digest.readInt32BE(0), digest.readInt32BE(4)] };
  const expected = { databaseInstanceId: "fixed-instance", controlRootJson: canonicalJson(root), mutexIdentityJson: canonicalJson(identity) };
  const heldRow = { held: true, marker: expected.databaseInstanceId, root: expected.controlRootJson, mutex: expected.mutexIdentityJson };
  let armed = false, allowResponse = false, changedIdentity = false;
  let endFault: false | "before" | "after" = false;
  let dispatch!: () => void;
  const dispatched = new Promise<void>(resolve => { dispatch = resolve; });
  const events: string[] = [], sql: string[] = [];
  const wires: Wire[] = [];
  const closeFailure = new MaintenanceFailure("maintenance_lost", "controlled-mutex-close");
  class Wire extends EventEmitter {
    _connecting = false; parsedStatements = {}; submittedNamedStatements = {};
    pending = ""; closed = false;
    stream = { destroy: () => { events.push("stream.destroy"); this.finish(); } };
    constructor() { super(); wires.push(this); }
    connect() { this._connecting = true; setImmediate(() => this.emit("connect")); }
    startup() { setImmediate(() => this.emit("readyForQuery", { status: "I" })); }
    parse(value: { text: string }) { this.pending = value.text; events.push("native.query"); dispatch(); }
    bind() {} describe() {} execute() {}
    sync() { if (allowResponse) setImmediate(() => this.respond()); }
    finish() { if (!this.closed) { this.closed = true; setImmediate(() => this.emit("end")); } }
    end() { events.push("wire.end"); this.finish(); }
    respond() {
      if (!this.pending || this.closed) return;
      const row = this.pending.includes("SELECT control.system_identifier")
        ? { ...identityRow, system_identifier: changedIdentity ? "2" : identityRow.system_identifier } : heldRow;
      this.pending = "";
      const entries = Object.entries(row);
      this.emit("rowDescription", { fields: entries.map(([name, value]) => ({ name, format: "text", dataTypeID: typeof value === "boolean" ? 16 : typeof value === "number" ? 23 : 25 })) });
      this.emit("dataRow", { fields: entries.map(([, value]) => typeof value === "boolean" ? value ? "t" : "f" : String(value)) });
      this.emit("commandComplete", { text: "SELECT 1" });
      this.emit("readyForQuery", { status: "I" });
      events.push("native.response");
    }
  }
  class ControlledClient extends Client {
    constructor(config: ClientConfig) { super({ ...config, connection: new Wire() } as ClientConfig); }
    override query(...args: unknown[]): never {
      const statement = sqlText(args[0]); sql.push(statement);
      if (armed) return Reflect.apply(Client.prototype.query, this, args) as never;
      const row = statement.includes("SELECT control.system_identifier") ? identityRow
        : statement.includes("SELECT pid,backend_start") ? { pid: 123, backend_start: "fixed" }
        : statement.includes("pg_try_advisory_lock") ? { acquired: true }
        : statement.includes("SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks") ? heldRow
        : statement === "SELECT * FROM storage_maintenance FOR UPDATE NOWAIT" ? expected : undefined;
      return Promise.resolve({ rows: row ? [row] : [], command: statement === "COMMIT" ? "COMMIT" : "" }) as never;
    }
    override end(...args: unknown[]): never {
      events.push("client.end");
      if (endFault === "before") return Promise.reject(closeFailure) as never;
      const result = Reflect.apply(Client.prototype.end, this, args) as Promise<void>;
      return (endFault === "after" ? result.then(() => { throw closeFailure; }) : result) as never;
    }
  }
  const factory = new Function("Client", "MaintenanceFailure", "canonicalJson", "createHash", "randomUUID", "assertPostgresServerCapability", "stablePostgresSourceIdentity", "expected", "sourceConnection", `
    const sessions=new Set(), auditFactories=new WeakMap(), abort=new AbortController();
    const writerObservation={hasSubscribers:false},note=()=>{},sessionMetadata=()=>({});
    let closed=false,lost=false,mutex,lockActive=false,closingStarted=false,firstSourceIdentity,firstServerIdentity,mutexTimer;
    const maintenanceHostIdentityDigest=async()=> 'fixed-host';
    const readPostgresMaintenanceState=async()=>expected,parseStorageMaintenanceState=()=>expected,quote=value=>value;
    ${body}
    return {acquire:root=>acquireMutex(root,expected),guard:assertOpen,
      inspect:()=>({lost,sessions:sessions.size,mutexPresent:!!mutex,released:mutex?.released,ending:mutex?.session.ending}),
      shutdown:async()=>{clearInterval(mutexTimer);await Promise.allSettled([...sessions].map(item=>endSession(item,true)));}};
  `)(ControlledClient, MaintenanceFailure, canonicalJson, createHash, randomUUID, assertPostgresServerCapability, stablePostgresSourceIdentity, expected, sourceConnection) as {
    acquire(root: unknown): Promise<OperationMutex>; guard(): void;
    inspect(): { lost: boolean; sessions: number; mutexPresent: boolean; released?: boolean; ending?: boolean };
    shutdown(): Promise<void>;
  };
  return { root, factory, events, sql, dispatched, closeFailure,
    arm() { armed = true; }, disarm() { armed = false; }, failEnd(value: false | "before" | "after") { endFault = value; },
    respond(changed = false) { changedIdentity = changed; allowResponse = true; for (const wire of wires) wire.respond(); },
    async cleanup() { endFault = false; allowResponse = true; for (const wire of wires) wire.respond(); await factory.shutdown(); } };
}

test("#152 real pg driver and natural heartbeat settle before release and adapter reuse", { timeout: 8_000 }, async () => {
  const f = await controlledHeartbeat();
  try {
    const held = await f.factory.acquire(f.root); f.arm(); await f.dispatched;
    const released = held.release(); void released.catch(() => {});
    await immediate();
    assert.equal(f.events.filter(value => value === "client.end").length, 0, "native end cannot interrupt its in-flight heartbeat");
    f.respond(); await released;
    f.factory.guard(); assert.equal(f.factory.inspect().sessions, 0);
    assert.equal(f.events.filter(value => value === "client.end").length, 1);
    f.disarm(); const next = await f.factory.acquire(f.root);
    const before = [...f.sql]; await Promise.all([held.release(), held.release()]);
    assert.deepEqual(f.sql, before, "old release cannot dispatch or replay SQL");
    await next.assertHeld(); assert.equal(f.factory.inspect().mutexPresent, true);
    await next.release(); f.factory.guard(); assert.equal(f.factory.inspect().sessions, 0);
  } finally { await f.cleanup(); }
});

test("#152 concurrent releases retain unknown native end ownership and retry only cleanup", { timeout: 8_000 }, async t => {
  for (const point of ["before", "after"] as const) await t.test(point, async () => {
    const f = await controlledHeartbeat();
    try {
      const held = await f.factory.acquire(f.root); f.failEnd(point);
      const before = [...f.sql];
      const results = await Promise.allSettled([held.release(), held.release()]);
      for (const result of results) { assert.equal(result.status, "rejected"); if (result.status === "rejected") assert.equal(result.reason, f.closeFailure); }
      assert.equal(f.events.filter(value => value === "client.end").length, 1);
      assert.deepEqual(f.sql, before); assert.equal(f.factory.inspect().released, false);
      assert.equal(f.factory.inspect().mutexPresent, true); assert.equal(f.factory.inspect().sessions, 1);
      await assert.rejects(f.factory.acquire(f.root), error => error instanceof MaintenanceFailure && error.code === "maintenance_busy");
      f.failEnd(false); await held.release();
      assert.equal(f.events.filter(value => value === "client.end").length, 2);
      assert.deepEqual(f.sql, before, "an explicit cleanup attempt cannot replay any source SQL");
      assert.equal(f.factory.inspect().sessions, 0); f.factory.guard();
    } finally { await f.cleanup(); }
  });
});

test("#152 release preserves real in-flight identity loss and a later native close failure", { timeout: 8_000 }, async () => {
  const f = await controlledHeartbeat();
  try {
    const held = await f.factory.acquire(f.root); f.arm(); await f.dispatched;
    f.failEnd("before");
    const released = Promise.allSettled([held.release(), held.release()]);
    f.respond(true);
    const results = await released;
    assert.equal(results[0]!.status, "rejected"); assert.equal(results[1]!.status, "rejected");
    if (results[0]!.status !== "rejected" || results[1]!.status !== "rejected") assert.fail("release lost its failure");
    const error = results[0]!.reason;
    assert.equal(results[1]!.reason, error, "concurrent callers consume the same exact attempt");
    assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 2);
    assert.ok(error.errors[0] instanceof MaintenanceFailure); assert.equal(error.errors[0].code, "maintenance_lost");
    assert.equal(error.cause, error.errors[0]); assert.equal(error.errors[1], f.closeFailure);
    assert.throws(() => f.factory.guard(), value => value instanceof MaintenanceFailure && value.code === "maintenance_lost");
    assert.equal(f.factory.inspect().released, false); assert.equal(f.factory.inspect().sessions, 1);
    assert.equal(f.events.filter(value => value === "client.end").length, 1);
    const before = [...f.sql]; f.failEnd(false); await held.release();
    assert.deepEqual(f.sql, before); assert.equal(f.factory.inspect().sessions, 0);
    assert.throws(() => f.factory.guard(), { code: "maintenance_lost" }, "cleanup cannot revive an actually lost adapter");
  } finally { await f.cleanup(); }
});

test("#152 heartbeat drain uses the actual configured pg query timeout, then closes its owner", { timeout: 30_000 }, async () => {
  const f = await controlledHeartbeat();
  try {
    const held = await f.factory.acquire(f.root); f.arm(); await f.dispatched;
    const started = performance.now();
    await assert.rejects(held.release(), error => error instanceof MaintenanceFailure && error.code === "maintenance_lost");
    assert.ok(performance.now() - started >= 14_000, "the real 15s driver timer, without a shortened test override, performed the rejection");
    assert.equal(f.events.filter(value => value === "native.query").length, 1, "failed first query cannot start the second heartbeat query");
    assert.equal(f.events.filter(value => value === "client.end").length, 1);
    assert.equal(f.factory.inspect().sessions, 0); assert.equal(f.factory.inspect().mutexPresent, false);
    assert.throws(() => f.factory.guard(), { code: "maintenance_lost" });
  } finally { await f.cleanup(); }
});

pgTest("#152 native PostgreSQL in-flight heartbeat drains before release and same-adapter reacquisition", { timeout: 30_000 }, async t => {
  const f = await postgresAuditFixture();
  const gateKey = createHash("sha256").update(f.database).digest().readBigInt64BE(0).toString();
  let controller: Client;
  try {
    controller = await f.connect("heartbeat-test-gate");
    await controller.query("SELECT pg_advisory_lock($1::bigint)", [gateKey]);
  } catch (error) { await f.close(); throw error; }
  const originalQuery = Client.prototype.query, originalEnd = Client.prototype.end;
  let heldClient: Client | undefined, identityCompleted = false, endCalls = 0;
  let dispatch!: () => void;
  const dispatched = new Promise<void>(resolve => { dispatch = resolve; });
  let next: OperationMutex | undefined;
  t.mock.method(Client.prototype, "query", function(this: Client, ...args: unknown[]) {
    const statement = sqlText(args[0]);
    const database = (this as unknown as { connectionParameters: { database: string } }).connectionParameters.database;
    if (!heldClient && database === f.database && statement.startsWith("SELECT control.system_identifier")) {
      heldClient = this;
      // The private test owns the blocking advisory lock. Both actual production
      // query deadlines remain unchanged; there is no sleep-based race window.
      const delayed = "WITH heartbeat_delay AS MATERIALIZED (SELECT pg_advisory_xact_lock($2::bigint)) "
        + statement.replace("FROM pg_catalog.pg_database d", "FROM heartbeat_delay,pg_catalog.pg_database d");
      const pending = Reflect.apply(originalQuery, this, [delayed, [...args[1] as unknown[], gateKey]]) as Promise<QueryResult>;
      dispatch();
      return pending.then(value => { identityCompleted = true; return value; });
    }
    return Reflect.apply(originalQuery, this, args);
  });
  t.mock.method(Client.prototype, "end", function(this: Client, ...args: unknown[]) {
    if (this === heldClient) { endCalls++; assert.equal(identityCompleted, true, "release must await its real server query"); }
    return Reflect.apply(originalEnd, this, args);
  });
  try {
    await dispatched;
    const deadline = performance.now() + 5_000;
    let activity: QueryResult;
    do {
      activity = await f.admin.query("SELECT pid,wait_event FROM pg_stat_activity WHERE datname=$1 AND query LIKE 'WITH heartbeat_delay%'", [f.database]);
      if (activity.rows.length === 1 && activity.rows[0].wait_event === "advisory") break;
      assert.ok(performance.now() < deadline, "the actual heartbeat query must reach the private server gate");
      await delay(20);
    } while (true);
    const released = Promise.all([f.mutex.release(), f.mutex.release()]); void released.catch(() => {});
    await immediate(); assert.equal(endCalls, 0);
    assert.equal((await controller.query("SELECT pg_advisory_unlock($1::bigint) AS unlocked", [gateKey])).rows[0].unlocked, true);
    await released;
    assert.equal(endCalls, 1); assert.equal(identityCompleted, true);
    t.mock.restoreAll();
    const observation = await f.adapter.observe(); assert.equal(observation.state.databaseInstanceId, f.plan.source.databaseInstanceId);
    next = await f.adapter.acquireMutex(f.store.identity, observation.state); await next.assertHeld();
    await f.mutex.release(); await next.assertHeld(); await next.release(); next = undefined;
    assert.equal((await f.admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid=$1", [activity.rows[0].pid])).rows[0].count, 0);
  } finally {
    t.mock.restoreAll(); await controller.query("SELECT pg_advisory_unlock($1::bigint)", [gateKey]);
    await f.closeClient(controller); await next?.release(); await f.close();
  }
});

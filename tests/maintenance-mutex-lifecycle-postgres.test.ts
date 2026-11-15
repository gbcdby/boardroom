import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { inspect } from "node:util";
import { Client, type QueryResult } from "pg";
import { postgresAuditFixture } from "./fixtures/maintenance-source-audit-postgres.ts";
import { createPostgresMaintenanceAdapter } from "../src/server/storage/maintenance/postgres.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";

// The native cases require the private CI PostgreSQL service. Pure end controls below are not PostgreSQL evidence.
const pgTest = process.env.AGENT_STUDIO_PG_TEST_URL ? test : test.skip;
const invokeEnd = (end: typeof Client.prototype.end, client: Client) => Reflect.apply(end, client, []) as Promise<void>;
const invokeQuery = (query: typeof Client.prototype.query, client: Client, args: unknown[]) => Reflect.apply(query, client, args) as Promise<QueryResult>;
const sqlText = (value: unknown) => typeof value === "string" ? value : typeof value === "object" && value !== null && "text" in value ? String(value.text) : "";
const database = (client: Client) => (client as unknown as { connectionParameters: { database: string } }).connectionParameters.database;

async function isolatedEnd() {
  const text = await readFile(new URL("../src/server/storage/maintenance/postgres.ts", import.meta.url), "utf8");
  const source = ts.createSourceFile("postgres.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let declaration: ts.FunctionDeclaration | undefined;
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "endSession") declaration = node;
    ts.forEachChild(node, visit);
  }
  visit(source); assert.ok(declaration);
  const body = ts.transpileModule(declaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const sessions = new Set<unknown>();
  const end = new Function("sessions", "writerObservation", "note", "sessionMetadata", body + "\nreturn endSession;")(
    sessions, { hasSubscribers: false }, () => {}, () => ({})) as (session: unknown, confirmed?: boolean) => Promise<boolean>;
  return { sessions, end };
}

test("#152 PostgreSQL private end control never retires an unconfirmed owned session", async t => {
  for (const phase of ["sync", "reject", "undefined"] as const) await t.test(phase, async () => {
    const { sessions, end } = await isolatedEnd(), primary = phase === "undefined" ? undefined : new Error("private-end-failure");
    let reject = true, calls = 0;
    const session = { ending: false, ended: false, client: { end() {
      calls++;
      if (!reject) return Promise.resolve();
      if (phase === "sync") throw primary;
      return Promise.reject(primary);
    } } };
    sessions.add(session);
    assert.equal(await end(session), false);
    assert.equal(sessions.has(session), true); assert.equal(session.ended, false);
    let failed = false;
    try { await end(session, true); } catch (error) { failed = true; assert.equal(error, primary); }
    assert.equal(failed, true); assert.equal(sessions.has(session), true);
    reject = false;
    assert.equal(await end(session, true), true);
    assert.equal(sessions.has(session), false); assert.equal(session.ended, true); assert.equal(calls, 3);
  });
});

test("#152 PostgreSQL failed connect cleanup keeps a safe first error and an owned session", async t => {
  const secret = new Error("postgres://user:mutex-sensitive-password@host/private-database");
  const adapter = await createPostgresMaintenanceAdapter({ kind: "postgres", connectionString: "postgres://unused@127.0.0.1:1/mutex_controls" }, undefined);
  let calls = 0, allowClose = false;
  try {
    t.mock.method(Client.prototype, "connect", function () { throw undefined; });
    t.mock.method(Client.prototype, "end", function () { calls++; return allowClose ? Promise.resolve() : Promise.reject(secret); });
    await assert.rejects(adapter.observe(), error => {
      assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 2);
      assert.ok(error.errors[0] instanceof MaintenanceFailure); assert.equal(error.errors[0].code, "source_missing");
      assert.ok(error.errors[1] instanceof MaintenanceFailure); assert.equal(error.errors[1].code, "maintenance_lost");
      assert.equal(error.cause, error.errors[0]); assert.doesNotMatch(inspect(error), /mutex-sensitive|private-database/); return true;
    });
    assert.equal(calls, 1); allowClose = true;
    await adapter.close(); assert.equal(calls, 2, "failed setup remains owned until a confirmed end");
  } finally { allowClose = true; await adapter.close(); t.mock.restoreAll(); }
});

test("#152 PostgreSQL adapter close attempts every owned session and shares concurrent completion", async t => {
  const adapter = await createPostgresMaintenanceAdapter({ kind: "postgres", connectionString: "postgres://unused@127.0.0.1:1/mutex_controls" }, undefined);
  const clients: Client[] = [], calls = new Map<Client, number>();
  let phase: "setup" | "partial" | "pending" | "done" = "setup", finish: (() => void) | undefined;
  try {
    t.mock.method(Client.prototype, "connect", function (this: Client) { clients.push(this); return Promise.reject(undefined); });
    t.mock.method(Client.prototype, "end", function (this: Client) {
      calls.set(this, (calls.get(this) ?? 0) + 1);
      if (phase === "setup" || phase === "partial" && this === clients[0]) throw undefined;
      if (phase === "pending") return new Promise<void>(resolve => { finish = resolve; });
      return Promise.resolve();
    });
    await assert.rejects(adapter.observe()); await assert.rejects(adapter.observe());
    phase = "partial"; await assert.rejects(adapter.close());
    assert.deepEqual(clients.map(client => calls.get(client)), [2, 2], "one rejected end cannot skip another owned session");
    await assert.rejects(adapter.observe(), /maintenance_lost/);
    phase = "pending";
    let firstSettled = false, secondSettled = false;
    const first = adapter.close().then(() => { firstSettled = true; });
    const second = adapter.close().then(() => { secondSettled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(firstSettled, false); assert.equal(secondSettled, false);
    assert.deepEqual(clients.map(client => calls.get(client)), [3, 2], "concurrent cleanup shares one native end");
    assert.ok(finish); phase = "done"; finish(); await Promise.all([first, second]);
    await adapter.close(); assert.deepEqual(clients.map(client => calls.get(client)), [3, 2]);
  } finally { phase = "done"; finish?.(); await adapter.close(); t.mock.restoreAll(); }
});

pgTest("#152 PostgreSQL real mutex end failures retain ownership and second-controller exclusion", async t => {
  for (const phase of ["before", "after", "undefined", "sync"] as const) await t.test(phase, async child => {
    const f = await postgresAuditFixture(), end = Client.prototype.end;
    const other = await createPostgresMaintenanceAdapter(f.descriptor, undefined);
    const secret = new Error("postgres://mutex-sensitive-password@host/private-database");
    let owned: Client | undefined;
    try {
      child.mock.method(Client.prototype, "end", function (this: Client) {
        if (database(this) === f.database && !owned) owned = this;
        if (this === owned) {
          if (phase === "sync") throw secret;
          if (phase === "after") return invokeEnd(end, this).then(() => { throw secret; });
          return Promise.reject(phase === "undefined" ? undefined : secret);
        }
        return invokeEnd(end, this);
      });
      await assert.rejects(f.mutex.release(), error => {
        assert.ok(error instanceof MaintenanceFailure); assert.equal(error.code, "maintenance_lost");
        assert.doesNotMatch(inspect(error), /mutex-sensitive|private-database/); return true;
      });
      assert.ok(owned); await assert.rejects(f.mutex.assertHeld(), /maintenance_lost/);
      if (phase !== "after") await assert.rejects(other.acquireMutex(f.store.identity, (await other.observe()).state), /maintenance_busy/);
      child.mock.restoreAll(); await f.mutex.release();
      const next = await other.acquireMutex(f.store.identity, (await other.observe()).state); await next.assertHeld(); await next.release();
    } finally { child.mock.restoreAll(); await other.close(); if (owned) await invokeEnd(end, owned); await f.close(); }
  });
});

pgTest("#152 PostgreSQL real observation preserves primary and end failures without exposing raw native errors", async t => {
  for (const withPrimary of [false, true]) await t.test(withPrimary ? "two-errors" : "end-only", async child => {
    const f = await postgresAuditFixture(), query = Client.prototype.query, end = Client.prototype.end;
    const secret = Object.assign(new Error("postgres://mutex-sensitive-password@host/private-database"), { code: "55P03" });
    let owned: Client | undefined, cleanupRetried = false;
    try {
      if (withPrimary) child.mock.method(Client.prototype, "query", function (this: Client, ...args: unknown[]) {
        if (database(this) === f.database && sqlText(args[0]) === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY") {
          owned = this; throw secret;
        }
        return invokeQuery(query, this, args);
      });
      child.mock.method(Client.prototype, "end", function (this: Client) {
        if (database(this) === f.database && !owned) owned = this;
        if (this === owned) throw new Error("mutex-sensitive-end");
        return invokeEnd(end, this);
      });
      await assert.rejects(f.adapter.observe(), error => {
        assert.doesNotMatch(inspect(error), /mutex-sensitive|private-database/);
        if (withPrimary) {
          assert.ok(error instanceof AggregateError); assert.equal(error.errors[0].code, "maintenance_busy");
          assert.equal(error.errors[1].code, "maintenance_lost"); assert.equal(error.cause, error.errors[0]);
        } else { assert.ok(error instanceof MaintenanceFailure); assert.equal(error.code, "maintenance_lost"); }
        return true;
      });
      assert.ok(owned); child.mock.restoreAll();
      child.mock.method(Client.prototype, "end", function (this: Client) { if (this === owned) cleanupRetried = true; return invokeEnd(end, this); });
      await f.adapter.close(); assert.equal(cleanupRetried, true);
      assert.equal((await f.admin.query("SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname=$1 AND application_name LIKE 'boardroom-maintenance:%'", [f.database])).rows[0].n, "0");
    } finally { child.mock.restoreAll(); if (owned) await invokeEnd(end, owned); await f.close(); }
  });
});

pgTest("#152 PostgreSQL real mutex bind preserves primary through synchronous rollback and end failures", async t => {
  const f = await postgresAuditFixture(), query = Client.prototype.query, end = Client.prototype.end;
  await f.mutex.release();
  const expected = (await f.adapter.observe()).state, primary = new MaintenanceFailure("source_changed", "mutex-bind-first");
  let owned: Client | undefined, rollback = false;
  try {
    t.mock.method(Client.prototype, "query", function (this: Client, ...args: unknown[]) {
      const sql = sqlText(args[0]);
      if (database(this) === f.database && sql === "SELECT * FROM storage_maintenance FOR UPDATE NOWAIT") { owned = this; throw primary; }
      if (this === owned && sql === "ROLLBACK") { rollback = true; throw undefined; }
      return invokeQuery(query, this, args);
    });
    t.mock.method(Client.prototype, "end", function (this: Client) {
      if (this === owned) return Promise.reject(new Error("mutex-sensitive-end")); return invokeEnd(end, this);
    });
    await assert.rejects(f.adapter.acquireMutex(f.store.identity, expected), error => {
      assert.ok(error instanceof AggregateError); assert.equal(error.errors[0], primary); assert.equal(error.cause, primary);
      assert.equal(error.errors.length, 3); assert.equal(error.errors[1].code, "maintenance_lost"); assert.equal(error.errors[2].code, "maintenance_lost");
      assert.doesNotMatch(inspect(error), /mutex-sensitive/); return true;
    });
    assert.equal(rollback, true); t.mock.restoreAll(); await f.adapter.close();
    const other = await createPostgresMaintenanceAdapter(f.descriptor, undefined);
    try { const next = await other.acquireMutex(f.store.identity, (await other.observe()).state); await next.release(); }
    finally { await other.close(); }
    const reader = await f.connect("mutex-bind-independent");
    try { assert.equal((await reader.query("SELECT control_root_json FROM storage_maintenance")).rows[0].control_root_json, expected.controlRootJson); }
    finally { await f.closeClient(reader); }
  } finally { t.mock.restoreAll(); if (owned) await invokeEnd(end, owned); await f.close(); }
});

pgTest("#152 PostgreSQL real adapter close rejects an unended mutex and retries its exact owner", async t => {
  const f = await postgresAuditFixture(), end = Client.prototype.end, before = (await f.adapter.observe()).state;
  const other = await createPostgresMaintenanceAdapter(f.descriptor, undefined);
  let owned: Client | undefined;
  try {
    t.mock.method(Client.prototype, "end", function (this: Client) {
      if (database(this) === f.database && !owned) owned = this;
      if (this === owned) return Promise.reject(undefined);
      return invokeEnd(end, this);
    });
    await assert.rejects(f.adapter.close(), error => error instanceof MaintenanceFailure && error.code === "maintenance_lost");
    assert.ok(owned); await assert.rejects(f.adapter.observe(), /maintenance_lost/);
    await assert.rejects(other.acquireMutex(f.store.identity, (await other.observe()).state), /maintenance_busy/);
    t.mock.restoreAll(); await f.adapter.close();
    const next = await other.acquireMutex(f.store.identity, (await other.observe()).state); await next.assertHeld(); await next.release();
    assert.deepEqual((await other.observe()).state, before, "teardown changes no maintenance row or business transaction");
  } finally { t.mock.restoreAll(); await other.close(); if (owned) await invokeEnd(end, owned); await f.close(); }
});

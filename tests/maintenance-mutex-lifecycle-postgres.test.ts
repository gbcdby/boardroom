import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync } from "node:fs";
import { mkdtemp, open, readFile, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
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

/** Exact production catch/finally and whole-adapter cleanup, with only the native restore body
 * replaced by controlled results. Real FileHandles below are not native PostgreSQL evidence. */
async function isolatedVerification(controls: { input: FileHandle; end(): Promise<void>; failPrimary?: boolean; first?: unknown }) {
  const text = await readFile(new URL("../src/server/storage/maintenance/postgres.ts", import.meta.url), "utf8");
  const source = ts.createSourceFile("postgres.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = ["safeError", "throwResourceFailures", "endSession", "closeVerificationInput", "verifyDatabaseOperation"];
  const found = new Map<string, ts.FunctionDeclaration>(); let closeBody: string | undefined;
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) found.set(node.name.text, node);
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "adapter" && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      const close = node.initializer.properties.find(item => ts.isMethodDeclaration(item) && item.name.getText(source) === "close");
      if (close && ts.isMethodDeclaration(close)) closeBody = close.body!.getText(source);
    }
    ts.forEachChild(node, visit);
  }
  visit(source); assert.ok(closeBody);
  const operation = found.get("verifyDatabaseOperation")!, nativeTry = operation.body!.statements.find(ts.isTryStatement)!;
  assert.ok(nativeTry.catchClause && nativeTry.finallyBlock);
  const original = operation.getText(source), offset = operation.getStart(source);
  const nativeStub = `{
    input = controls.input; const owner = {fd:input.fd}; verificationInputs.set(input, owner);
    const info = await input.stat({bigint:true}); owner.identity = String(info.dev)+':'+String(info.ino);
    if (controls.failPrimary) throw controls.first;
    result = {kind:'controlled-restore-result'};
  }`;
  const operationControl = original.slice(0, nativeTry.tryBlock.getStart(source) - offset) + nativeStub + original.slice(nativeTry.tryBlock.end - offset);
  const body = ts.transpileModule(names.filter(name => name !== "verifyDatabaseOperation").flatMap(name => {
    const declaration = found.get(name); return declaration ? [declaration.getText(source)] : [];
  }).join("\n") + "\n" + operationControl + "\nasync function closeAdapter()" + closeBody,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const session = { ending: false, ended: false, client: { end: controls.end } }, sessions = new Set([session]);
  const owners = new Map<FileHandle, { fd: number; identity?: string }>();
  const invoke = new Function("MaintenanceFailure", "fstatSync", "controls", "targetSession", "sessions", "verificationInputs", `
    const sourceConnection={schema:'app'}, verificationConnection={schema:'app'}, expected={schema:{profile:'boardroom-pg16-closed-schema-v1'}};
    const writerObservation={hasSubscribers:false}, activeVerifications=new Set(), auditFactories=new WeakMap(), abort=new AbortController();
    let closed=false, closingStarted=false, closeAttempt, mutex, mutexTimer;
    function note(){} function sessionMetadata(){return {};} function randomUUID(){return 'control';}
    async function assertMutex(){} async function assertSnapshotLock(){} async function privateDirectory(){}
    async function connect(){return targetSession;} async function waitForPostgresTools(){}
    function object(value){return value;} function buildDatabaseManifests(){return expected;}
    function same(a,b){return JSON.stringify(a)===JSON.stringify(b);} function checkedReader(value){return value;}
    ${body}
    return {run:()=>verifyDatabaseOperation('unused-input',expected,'unused-restore'),close:closeAdapter};
  `)(MaintenanceFailure, fstatSync, controls, session, sessions, owners) as { run(): Promise<unknown>; close(): Promise<void> };
  return { ...invoke, session, sessions, owners };
}

test("#152 PostgreSQL exact verification cleanup preserves first errors and attempts every owned resource", async t => {
  for (const phase of ["success", "target-sync", "target-async", "target-undefined", "primary-and-close", "input-and-target", "all-errors"] as const) {
    await t.test(phase, async child => {
      const directory = await mkdtemp(path.join(process.cwd(), "verification-close-control-"));
      const input = await open(path.join(directory, "private-input"), "wx+", 0o600), realClose = input.close.bind(input);
      const first = phase === "all-errors" ? undefined : new MaintenanceFailure("source_changed", "verification-first");
      const order: string[] = []; let released = false;
      const canary = new Error("postgres://verification-private-canary@host/private-db");
      const badInput = phase === "input-and-target" || phase === "all-errors";
      child.mock.method(input, "close", async () => {
        order.push("input"); if (badInput && !released) throw canary; await realClose();
      });
      const f = await isolatedVerification({ input, failPrimary: phase === "primary-and-close" || phase === "all-errors", first,
        end() {
          order.push("target"); if (released || phase === "success") return Promise.resolve();
          if (phase === "target-async") return Promise.reject(canary);
          throw phase === "target-undefined" ? undefined : canary;
        } });
      try {
        if (phase === "success") assert.deepEqual(await f.run(), { kind: "controlled-restore-result" });
        else await assert.rejects(f.run(), error => {
          assert.doesNotMatch(inspect(error), /verification-private-canary|private-db|postgres:\/\//);
          const failures = error instanceof AggregateError ? error.errors : [error];
          const expectedCount = phase === "all-errors" ? 3 : ["primary-and-close", "input-and-target"].includes(phase) ? 2 : 1;
          assert.equal(failures.length, expectedCount);
          if (expectedCount > 1) {
            assert.ok(error instanceof AggregateError); assert.equal(Object.hasOwn(error, "cause"), true); assert.equal(error.cause, failures[0]);
          }
          if (phase === "primary-and-close") assert.equal(failures[0], first);
          if (phase === "all-errors") assert.equal(failures[0].message, "storage_maintenance: restore_verification_unavailable (source)");
          if (badInput) assert.equal(failures.at(-2)!.message, "storage_maintenance: maintenance_lost (verification-input-close)");
          assert.equal(failures.at(-1)!.message, "storage_maintenance: maintenance_lost (verification-target-close)");
          return true;
        });
        assert.deepEqual(order, ["input", "target"], "input failure cannot skip the target end attempt");
        assert.equal(f.owners.size, badInput ? 1 : 0); assert.equal(f.sessions.size, phase === "success" ? 0 : 1);
        if (badInput) assert.ok((await input.stat()).isFile(), "the actual open input retains its FileHandle owner");
        released = true; await f.close();
        assert.equal(f.owners.size, 0); assert.equal(f.sessions.size, 0); assert.equal(input.fd, -1);
        await assert.rejects(input.stat(), { code: "EBADF" });
        assert.deepEqual(order, phase === "success" ? ["input", "target"] : badInput
          ? ["input", "target", "input", "target"] : ["input", "target", "target"]);
      } finally { released = true; child.mock.restoreAll(); await f.close(); if (input.fd !== -1) await realClose(); await rm(directory, { recursive: true }); }
    });
  }
});

test("#152 PostgreSQL verification input close response failure never closes a reused same-inode descriptor", async t => {
  const directory = await mkdtemp(path.join(process.cwd(), "verification-close-reuse-")), file = path.join(directory, "input");
  const input = await open(file, "wx+", 0o600), fd = input.fd, realClose = input.close.bind(input);
  let replacement: number | undefined;
  const f = await isolatedVerification({ input, end: async () => {} });
  t.mock.method(input, "close", async () => {
    await realClose(); replacement = openSync(file, "r"); assert.equal(replacement, fd); throw undefined;
  });
  try {
    await assert.rejects(f.run(), error => error instanceof MaintenanceFailure
      && error.message === "storage_maintenance: maintenance_lost (verification-input-close)");
    assert.equal(f.sessions.size, 0); assert.equal(f.owners.size, 1);
    await assert.rejects(f.close(), /verification-input-close-unknown/);
    assert.equal(f.owners.size, 1); assert.ok(fstatSync(replacement!).isFile());
    closeSync(replacement!); replacement = undefined;
    await f.close(); assert.equal(f.owners.size, 0);
  } finally { t.mock.restoreAll(); if (replacement !== undefined) closeSync(replacement); if (input.fd !== -1) await realClose(); await f.close(); await rm(directory, { recursive: true }); }
});

test("#152 PostgreSQL verification input close-after error rejects while confirmed closure retires its owner", async t => {
  const directory = await mkdtemp(path.join(process.cwd(), "verification-close-after-"));
  const input = await open(path.join(directory, "input"), "wx+", 0o600), realClose = input.close.bind(input);
  let targetEnds = 0;
  const f = await isolatedVerification({ input, end: async () => { targetEnds++; } });
  t.mock.method(input, "close", async () => { await realClose(); throw undefined; });
  try {
    await assert.rejects(f.run(), error => error instanceof MaintenanceFailure
      && error.message === "storage_maintenance: maintenance_lost (verification-input-close)");
    assert.equal(targetEnds, 1); assert.equal(input.fd, -1); assert.equal(f.owners.size, 0); assert.equal(f.sessions.size, 0);
    await f.close(); assert.equal(targetEnds, 1);
  } finally { t.mock.restoreAll(); if (input.fd !== -1) await realClose(); await f.close(); await rm(directory, { recursive: true }); }
});

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

test("#152 PostgreSQL private ordinary inspection preserves safe first and close failures", async t => {
  const text = await readFile(new URL("../src/server/storage/maintenance/postgres.ts", import.meta.url), "utf8");
  const source = ts.createSourceFile("postgres.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = ["safeError", "endSession", "inspectWriters"], found = new Map<string, string>();
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) found.set(node.name.text, node.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source); assert.equal(found.size, names.length);
  const body = ts.transpileModule(names.map(name => found.get(name)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const phase of ["first", "undefined", "alone"] as const) await t.test(phase, async () => {
    const first = phase === "undefined" ? undefined : new MaintenanceFailure("source_changed", "inspection-first");
    let ends = 0;
    const session = { ending: false, ended: false, client: {
      async end() { ends++; throw new Error("mutex-sensitive-inspection-end"); }, async query() { return { rows: [] }; },
    } }, sessions = new Set([session]);
    const invoke = new Function("MaintenanceFailure", "sessions", "session", "first", "failFirst", "writerObservation",
      "const sourceConnection={}; const observationRows=32; let inspectionSequence=0; function note(){} function sessionMetadata(){return {};}" +
      "async function connect(){return session;} async function readIdentity(){if(failFirst)throw first; return {databaseOid:'1'};}" +
      "function same(){return true;} function stablePostgresSourceIdentity(){return {};}\n" + body + "\nreturn inspectWriters;")(
      MaintenanceFailure, sessions, session, first, phase !== "alone", { hasSubscribers: false }) as (current: unknown) => Promise<unknown>;
    await assert.rejects(invoke({ sourceIdentity: {}, state: { databaseInstanceId: "fixture" }, clients: [] }), error => {
      assert.doesNotMatch(inspect(error), /mutex-sensitive/);
      if (phase === "alone") { assert.ok(error instanceof MaintenanceFailure); assert.equal(error.code, "maintenance_lost"); }
      else {
        assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 2); assert.equal(error.cause, error.errors[0]);
        if (phase === "first") assert.equal(error.errors[0], first); else assert.equal(error.errors[0].code, "source_writer_unknown");
        assert.ok(error.errors[1] instanceof MaintenanceFailure); assert.equal(error.errors[1].code, "maintenance_lost");
      }
      return true;
    });
    assert.equal(ends, 1); assert.equal(sessions.has(session), true); assert.equal(session.ended, false);
  });
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

pgTest("#152 PostgreSQL real ordinary writer inspection rejects sole and combined temporary end failures", async t => {
  for (const withPrimary of [false, true]) await t.test(withPrimary ? "first-and-end" : "end-only", async child => {
    const f = await postgresAuditFixture(), current = await f.adapter.observe(), query = Client.prototype.query, end = Client.prototype.end;
    const primary = new MaintenanceFailure("source_changed", "inspection-first");
    let owned: Client | undefined, completed = false, ended = false;
    try {
      child.mock.method(Client.prototype, "query", function (this: Client, ...args: unknown[]) {
        const sql = sqlText(args[0]);
        if (database(this) === f.database && sql.includes("FROM pg_catalog.pg_stat_activity a WHERE datid=")) {
          owned = this; if (withPrimary) throw primary;
        }
        return invokeQuery(query, this, args).then(result => {
          if (this === owned && sql.startsWith("SELECT 1 FROM pg_catalog.pg_prepared_xacts")) completed = true;
          return result;
        });
      });
      child.mock.method(Client.prototype, "end", function (this: Client) {
        if (this === owned) return Promise.reject(new Error("mutex-sensitive-inspection-end"));
        return invokeEnd(end, this);
      });
      await assert.rejects(f.adapter.inspectWriters(current), error => {
        assert.doesNotMatch(inspect(error), /mutex-sensitive/);
        if (withPrimary) {
          assert.ok(error instanceof AggregateError); assert.equal(error.errors[0], primary); assert.equal(error.cause, primary);
          assert.ok(error.errors[1] instanceof MaintenanceFailure); assert.equal(error.errors[1].code, "maintenance_lost");
        } else { assert.ok(error instanceof MaintenanceFailure); assert.equal(error.code, "maintenance_lost"); }
        return true;
      });
      assert.ok(owned); assert.equal(completed, !withPrimary);
      child.mock.restoreAll();
      child.mock.method(Client.prototype, "end", function (this: Client) { if (this === owned) ended = true; return invokeEnd(end, this); });
      await f.adapter.close(); assert.equal(ended, true);
      assert.equal((await f.admin.query("SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname=$1 AND application_name LIKE 'boardroom-maintenance:%'", [f.database])).rows[0].n, "0");
    } finally { child.mock.restoreAll(); if (owned) await invokeEnd(end, owned); await f.close(); }
  });
});

pgTest("#152 PostgreSQL real restored target cannot succeed after sync or async end failure", async t => {
  const f = await postgresAuditFixture(), end = Client.prototype.end;
  try {
    // Physical verification fixture only: this native sealed anchor is not an Fs/Jq
    // qualification claim and is never consumed by the finite journal closure reader.
    await f.adapter.withSourceLock("control", async lock => {
      const current = await lock.observe(), prior = await f.store.readJson(f.head, "journal") as Record<string, unknown>;
      const captured = await f.store.putJson("journal", { ...prior, sequence: 2, previous: f.head,
        phase: "quiesced", event: "capture", requestId: "verification-close-fixture" });
      await lock.anchor({ expected: current.state, admission: "sealed", fenceEpoch: current.state.fenceEpoch,
        ownerGeneration: current.state.ownerGeneration, activeMigrationId: f.plan.migrationId, planDigest: f.reference.planDigest,
        controlRootIdentity: f.store.identity as never, mutexIdentity: f.mutex.identity, journal: captured, journalSequence: 2 });
    });
    await f.mutex.release(); await f.adapter.close();
    for (const phase of ["sync-before", "async-after"] as const) await t.test(phase, async child => {
      const targetName = `br_verify_close_${randomUUID().replaceAll("-", "")}`;
      const targetUrl = new URL(process.env.AGENT_STUDIO_PG_TEST_URL!); targetUrl.pathname = `/${targetName}`;
      await f.admin.query(`CREATE DATABASE "${targetName}" TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
      const adapter = await createPostgresMaintenanceAdapter(f.descriptor, { kind: "postgres", connectionString: targetUrl.toString() });
      let owned: Client | undefined, ends = 0, cleanup = 0;
      try {
        const initial = await adapter.observe(), mutex = await adapter.acquireMutex(f.store.identity, initial.state);
        const attempt = await f.store.createAttempt(initial.state.ownerGeneration), file = path.join(attempt, "snapshot.dump");
        await adapter.withSourceLock("snapshot", async lock => {
          const backup = await lock.backup(file);
          child.mock.method(Client.prototype, "end", function (this: Client) {
            if (database(this) !== targetName) return invokeEnd(end, this);
            owned = this; ends++;
            const canary = new Error("postgres://verification-private-canary@host/private-db");
            if (phase === "sync-before") throw canary;
            return invokeEnd(end, this).then(() => { throw canary; });
          });
          await assert.rejects(adapter.verifyDatabase(file, backup.manifests, attempt), error => {
            assert.ok(error instanceof MaintenanceFailure);
            assert.equal(error.message, "storage_maintenance: maintenance_lost (verification-target-close)");
            assert.doesNotMatch(inspect(error), /verification-private-canary|private-db|postgres:\/\//); return true;
          });
          assert.ok(owned); assert.equal(ends, 1); child.mock.restoreAll();
        });
        const pid = (owned as unknown as { processID: number }).processID;
        assert.ok(Number.isSafeInteger(pid) && pid > 0);
        assert.equal((await f.admin.query("SELECT count(*)::text AS count FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0].count,
          phase === "sync-before" ? "1" : "0");
        child.mock.method(Client.prototype, "end", function (this: Client) {
          if (this === owned) cleanup++; return invokeEnd(end, this);
        });
        await mutex.release(); await adapter.close(); assert.equal(cleanup, 1);
        assert.equal((await f.admin.query("SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=$1", [targetName])).rows[0].count, "0");
        child.mock.restoreAll();
        const restored = new Client({ connectionString: targetUrl.toString() }); await restored.connect();
        try {
          const state = (await restored.query("SELECT admission,journal_digest,journal_sequence FROM storage_maintenance")).rows[0];
          assert.equal(state.admission, "sealed"); assert.equal(state.journal_digest, initial.state.journalDigest);
          assert.equal(String(state.journal_sequence), String(initial.state.journalSequence));
        } finally { await restored.end(); }
        const reader = await f.connect("verification-close-independent");
        try {
          const state = (await reader.query("SELECT admission,journal_digest,journal_sequence FROM storage_maintenance")).rows[0];
          assert.equal(state.admission, initial.state.admission); assert.equal(state.journal_digest, initial.state.journalDigest);
          assert.equal(String(state.journal_sequence), String(initial.state.journalSequence));
        } finally { await f.closeClient(reader); }
      } finally {
        child.mock.restoreAll(); await adapter.close();
        await f.admin.query(`DROP DATABASE "${targetName}"`);
      }
    });
  } finally { await f.close(); }
});

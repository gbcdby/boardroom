import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { closeSync, renameSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import * as api from "../src/server/storage/internal/sqlite-profile-client-owner.ts";
import { AuditRequest, AUDIT_LIMITS } from "../src/server/identity/internal/m2-audit-boundary.ts";
import { SQLITE_PROFILE_GUARD_DEFINITIONS, SQLITE_PROFILE_UDF_ABI } from "../src/server/storage/internal/sqlite-profile-guard-source.ts";
import { SQLITE_PROFILE_RULE_SOURCE } from "../src/server/storage/internal/sqlite-profile-rules.ts";

type Cell = readonly ["null"] | readonly ["integer" | "real64be" | "text" | "blob", string];
function decoded(cell: readonly string[]): null | string {
  return cell[0] === "null" ? null : cell[0] === "text" ? Buffer.from(cell[1]!, "hex").toString("utf8") : cell[1]!;
}

test("CF17-I04-01 original zero-argument entry: actual birth, B transactions and seven-cell retirement", () => {
  const result = api.inspectIsolatedSqliteProfileClientLifecycle();
  assert.ok(result.ok, JSON.stringify(result));
  if (!result.ok) return;
  const v = result.value;
  assert.equal(v.scope, "isolated-sqlite-native-management-lifecycle");
  assert.equal(v.qualification, "component-only; not-P1-admission");
  assert.equal(v.retirement, "closed");
  assert.deepEqual(v.transactions, { committed: 1, rolledBack: 1, notAdmitted: 0 });
  assert.equal(v.birth.rowid, "1");
  assert.equal(v.ended.rowid, v.birth.rowid);
  assert.equal(v.birth.cells.length, 17);
  assert.equal(v.ended.cells.length, 17);
  const born = v.birth.cells.map(decoded), ended = v.ended.cells.map(decoded);
  assert.equal(born[2], "local-management");
  assert.equal(born[3], "boardroom-native-management-v1");
  assert.equal(born[4], "2");
  assert.equal(born[8], "0");
  assert.equal(born[9], "0");
  assert.equal(born[10], null);
  assert.equal(born[11], "none");
  assert.equal(born[12], null);
  assert.equal(born[13], born[14]);
  assert.equal(born[15], null);
  for (const i of [0, 1, 2, 3, 4, 5, 6, 8, 13, 16]) assert.deepEqual(v.ended.cells[i], v.birth.cells[i]);
  assert.equal(ended[9], "0");
  assert.equal(ended[10], null);
  assert.equal(ended[11], "none");
  assert.equal(ended[12], null);
  assert.equal(ended[14], ended[15]);
  assert.match(ended[15]!, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  const open = JSON.parse(born[7]!), closed = JSON.parse(ended[7]!);
  assert.equal(open.formatVersion, 1);
  assert.equal(open.sessions.length, 1);
  assert.equal(open.sessions[0].kind, "sqlite");
  assert.equal(open.sessions[0].owner, "native-management");
  assert.equal(open.sessions[0].state, "open");
  assert.deepEqual(open.sessions[0].nativeTransactions, { committed: 0, notAdmitted: 0, rolledBack: 0 });
  assert.deepEqual(closed.sourceIdentity, open.sourceIdentity);
  assert.equal(closed.sessions[0].connectionId, open.sessions[0].connectionId);
  assert.equal(closed.sessions[0].state, "closed");
  assert.deepEqual(closed.sessions[0].nativeTransactions, { committed: 1, notAdmitted: 0, rolledBack: 1 });
  assert.equal(closed.drainReceipt, null);
  assert.equal(existsSync(open.sourceIdentity.sqlitePath), false);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(v));
  assert.ok(Object.isFrozen(v.birth.cells));
  assert.ok(v.birth.cells.every(Object.isFrozen));
});

type Native = null | bigint | number | string | Buffer;
type Row = { rowid: bigint; types: string[]; cells: Native[] };
type T = { handle: Handle; generation: number; program: string; active: boolean; executing: boolean;
  failed: boolean; admitted: boolean; outcome: string; control: Row | null };
type Step = { transaction: T; event: string; oldRowid: bigint | null; newRowid: bigint; before: Native[]; after: Native[] };
type Handle = { db: Database.Database; role: string; generation: number; transaction: T | null; step: Step | null;
  closeAttempted: boolean; closeReturned: boolean };
type State = { request: AuditRequest; clientId: string; processInstanceId: string; connectionId: string;
  databaseInstanceId: string; hostJson: string; processJson: string;
  phase: string; file: string; directory: string; pinFd: number; pinCloseAttempted: boolean; pinCloseReturned: boolean;
  uncertain: boolean; handles: Handle[]; B: Handle; birthC: Handle | null; endC: Handle | null;
  counters: { committed: number; rolledBack: number; notAdmitted: number };
  birth: Row | null; plannedBirth: Row | null; ended: Row | null; plannedEnd: Row | null;
  failures: { phase: string; error: unknown }[] };
type Observation = {
  owners: WeakMap<object, State>; pendingOwners: Set<State>; SQL: Record<string, string>;
  createOwner(r: AuditRequest): object; register(owner: object, r: AuditRequest): void;
  runObservation(owner: object, terminal: "commit" | "rollback", r: AuditRequest): void;
  end(owner: object, r: AuditRequest): void; abandon(owner: object): void;
  rowAllowed(s: State, h: Handle, args: unknown[]): boolean;
  kernelCode(error: unknown): string | undefined;
};
async function derived(t: { diagnostic(text: string): void }, replacement?: { from: string; to: string }) {
  const directory = await mkdtemp(path.join(tmpdir(), "boardroom-cf17-private-"));
  const url = new URL("../src/server/storage/internal/sqlite-profile-client-owner.ts", import.meta.url);
  const original = await readFile(url, "utf8");
  let source = original.replace(/from "([^"]+)"/g, (_match, specifier: string) =>
    `from ${JSON.stringify(specifier.startsWith(".") ? new URL(specifier, url).href : import.meta.resolve(specifier))}`);
  if (replacement) {
    assert.equal(source.split(replacement.from).length, 2, "exactly one disclosed fault site");
    source = source.replace(replacement.from, replacement.to);
  }
  source += "\nexport const privateObservation = { owners, pendingOwners, SQL, createOwner, register, runObservation, end, abandon, rowAllowed, kernelCode };\n";
  const filename = path.join(directory, "derived-private-client-owner.ts");
  await writeFile(filename, source);
  t.diagnostic(JSON.stringify({ scope: "isolated-derived-private-observation", fault: replacement?.from ?? null,
    originalBytes: Buffer.byteLength(original), originalSha256: createHash("sha256").update(original).digest("hex"),
    derivedBytes: Buffer.byteLength(source), derivedSha256: createHash("sha256").update(source).digest("hex") }));
  const module = await import(pathToFileURL(filename).href) as typeof api & { privateObservation: Observation };
  return { ...module, dispose: () => rm(directory, { recursive: true, force: true }) };
}
function throwsCode(o: Observation, f: () => unknown, code: string): unknown {
  let error: unknown, thrown = false;
  try { f(); } catch (caught) { error = caught; thrown = true; }
  assert.equal(thrown, true); assert.equal(o.kernelCode(error), code); return error;
}
function restore(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(target, key, descriptor); else Reflect.deleteProperty(target, key);
}
function setPrepare(target: object, value: (this: Database.Database, sql: string) => unknown): void {
  Object.defineProperty(target, "prepare", { configurable: true, writable: true, value });
}
// Test harness disposal has direct ownership of its isolated fixture. This is not a product retry path.
async function disposeState(s: State, pinActuallyClosed = false): Promise<void> {
  for (const h of s.handles) {
    if (h.db.open) {
      if (h.db.inTransaction) Database.prototype.exec.call(h.db, "ROLLBACK;");
      Database.prototype.close.call(h.db);
    }
  }
  if (!s.pinCloseReturned && !pinActuallyClosed) closeSync(s.pinFd);
  await rm(s.directory, { recursive: true, force: true });
}

test("CF17-I04-02 end COMMIT unknown retains the exact proposed after row and actual C", async t => {
  const module = await derived(t), o = module.privateObservation, r = new AuditRequest();
  const owner = o.createOwner(r), s = o.owners.get(owner)!;
  o.register(owner, r); o.runObservation(owner, "commit", r);
  const original = Database.prototype.exec, descriptor = Object.getOwnPropertyDescriptor(Database.prototype, "exec");
  const nativeError = new Error("observed native COMMIT returned via a throwing boundary");
  let commits = 0;
  try {
    Database.prototype.exec = function (sql: string) {
      const result = original.call(this, sql);
      if (this === s.endC?.db && sql === o.SQL["C-COMMIT"]) { commits++; throw nativeError; }
      return result;
    };
    throwsCode(o, () => o.end(owner, r), "transaction_unknown");
    assert.equal(commits, 1);
    assert.equal(s.B.db.open, false);
    assert.equal(s.endC!.db.open, true);
    assert.equal(s.endC!.db.inTransaction, false);
    assert.equal(s.endC!.transaction!.outcome, "unknown");
    assert.equal(s.ended, null);
    assert.ok(s.plannedEnd, "the proposed exact after must survive unknown commit");
    assert.equal(s.plannedEnd.cells[15], s.plannedEnd.cells[14]);
    const actual = s.endC!.db.prepare("SELECT ended_at,db_sessions_json FROM main.storage_source_clients").get() as Record<string, unknown>;
    assert.equal(actual.ended_at, s.plannedEnd.cells[15]);
    assert.equal(actual.db_sessions_json, s.plannedEnd.cells[7]);
    assert.ok(o.pendingOwners.has(s));
    assert.ok(s.failures.some(f => f.error === nativeError));
    o.abandon(owner);
    assert.equal(s.endC!.db.open, true);
    throwsCode(o, () => o.end(owner, r), "owner_not_live");
    assert.equal(commits, 1);
  } finally { restore(Database.prototype, "exec", descriptor); await disposeState(s); await module.dispose(); }
});

test("CF17-I04-03 actual source rename refuses the next B transaction with source_changed", async t => {
  const module = await derived(t), o = module.privateObservation, r = new AuditRequest();
  const owner = o.createOwner(r), s = o.owners.get(owner)!;
  o.register(owner, r);
  const moved = s.file + ".moved";
  try {
    renameSync(s.file, moved);
    throwsCode(o, () => o.runObservation(owner, "commit", r), "source_changed");
    assert.equal(s.B.db.inTransaction, false);
    assert.equal(s.counters.committed, 0);
    assert.equal(s.counters.notAdmitted, 1);
    assert.equal(s.phase, "failed");
  } finally {
    if (existsSync(moved)) renameSync(moved, s.file);
    await disposeState(s); await module.dispose();
  }
});

test("CF17-I04-04 original API has no caller-selected path, owner, callback or budget", () => {
  assert.deepEqual(Object.keys(api), ["inspectIsolatedSqliteProfileClientLifecycle"]);
  let touched = 0;
  const trap = () => { touched++; throw new Error("no caller execution"); };
  const proxy = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
  const call = api.inspectIsolatedSqliteProfileClientLifecycle as (...args: unknown[]) => unknown;
  for (const argument of [undefined, null, {}, proxy, trap, ":memory:", { path: "/tmp/elsewhere", limits: {} }])
    assert.deepEqual(call(argument), { ok: false, error: { code: "unsupported_shape" } });
  assert.equal(touched, 0);
});

test("CF17-I04-05 actual B/C order, immutable open envelope and full38 pure native step", async t => {
  const module = await derived(t), o = module.privateObservation, r = new AuditRequest();
  const owner = o.createOwner(r), s = o.owners.get(owner)!;
  const descriptors = { exec: Object.getOwnPropertyDescriptor(Database.prototype, "exec"),
    prepare: Object.getOwnPropertyDescriptor(Database.prototype, "prepare"), close: Object.getOwnPropertyDescriptor(Database.prototype, "close") };
  const originals = { exec: Database.prototype.exec, prepare: Database.prototype.prepare, close: Database.prototype.close };
  const trace: string[] = [];
  let exactCalls = 0, staleArgs: unknown[] | undefined, captured: { h: Handle; t: T; step: Step } | undefined;
  try {
    Database.prototype.exec = function (sql: string) {
      const h = s.handles.find(h => h.db === this);
      if (h && [o.SQL["C-BEGIN"], o.SQL["C-COMMIT"], o.SQL["C-ROLLBACK"]].includes(sql)) {
        trace.push(`${h.role}:${sql}`);
        if (h.role === "B") assert.equal(s.birthC!.closeReturned, true);
        if (h.role === "end-C") assert.equal(s.B.db.open, false);
      }
      return originals.exec.call(this, sql);
    };
    Database.prototype.close = function () {
      const h = s.handles.find(h => h.db === this);
      if (h) {
        trace.push(`${h.role}:close`);
        assert.equal(h.step, null);
        assert.equal(h.transaction?.active ?? false, false);
        if (h.role === "birth-C") { assert.ok(s.birth); assert.equal(s.B.db.open, true); }
        if (h.role === "end-C") { assert.ok(s.ended); assert.equal(s.B.db.open, false); }
      }
      return originals.close.call(this);
    };
    setPrepare(Database.prototype, function (sql: string) {
      const h = s.handles.find(h => h.db === this);
      if (h && (sql === o.SQL["C-BIRTH"] || sql === o.SQL["C-NATIVE-END-OPEN"])) {
        const step = h.step!, tr = h.transaction!;
        const args = ["storage_source_clients", step.event, step.oldRowid, step.newRowid, ...step.before, ...step.after];
        assert.equal(o.rowAllowed(s, h, args), true);
        const before = { generation: h.generation, transaction: h.transaction, step: h.step,
          active: tr.active, executing: tr.executing, failed: tr.failed };
        for (let i = 0; i < 38; i++) {
          const changed = [...args]; changed[i] = typeof args[i] === "string" ? `${args[i]}!` : 777n;
          assert.equal(o.rowAllowed(s, h, changed), false, `ABI argument ${i}`);
        }
        assert.equal(o.rowAllowed(s, s.B, args), false);
        assert.equal(o.rowAllowed(s, h, [...args, null]), false);
        h.generation++; assert.equal(o.rowAllowed(s, h, args), false); h.generation--;
        tr.failed = true; assert.equal(o.rowAllowed(s, h, args), false); tr.failed = false;
        assert.deepEqual({ generation: h.generation, transaction: h.transaction, step: h.step,
          active: tr.active, executing: tr.executing, failed: tr.failed }, before);
        staleArgs = args; captured = { h, t: tr, step }; exactCalls++;
      }
      return originals.prepare.call(this, sql);
    });
    o.register(owner, r);
    assert.equal(o.rowAllowed(s, captured!.h, staleArgs!), false);
    assert.equal(captured!.t.outcome, "committed");
    const originalEnvelope = s.birth!.cells[7];
    o.runObservation(owner, "rollback", r); o.runObservation(owner, "commit", r);
    const actual = s.B.db.prepare("SELECT db_sessions_json FROM main.storage_source_clients").get() as { db_sessions_json: string };
    assert.equal(actual.db_sessions_json, originalEnvelope);
    assert.deepEqual(s.counters, { committed: 1, rolledBack: 1, notAdmitted: 0 });
    o.end(owner, r);
    assert.equal(exactCalls, 2);
    assert.deepEqual(trace, ["birth-C:BEGIN IMMEDIATE;", "birth-C:COMMIT;", "birth-C:close",
      "B:BEGIN IMMEDIATE;", "B:ROLLBACK;", "B:BEGIN IMMEDIATE;", "B:COMMIT;", "B:close",
      "end-C:BEGIN IMMEDIATE;", "end-C:COMMIT;", "end-C:close"]);
    assert.equal(s.phase, "retired"); assert.equal(s.pinCloseReturned, true);
    assert.equal(o.pendingOwners.size, 0); assert.equal(existsSync(s.directory), false);
  } finally {
    for (const key of ["exec", "prepare", "close"] as const) restore(Database.prototype, key, descriptors[key]);
    await disposeState(s); await module.dispose();
  }
});

test("CF17-I04-06 birth C close unknown retains B and C and never admits or re-registers", async t => {
  for (const nativeCloseReturned of [false, true]) {
    const module = await derived(t), o = module.privateObservation, r = new AuditRequest();
    const owner = o.createOwner(r), s = o.owners.get(owner)!;
    const original = Database.prototype.close, descriptor = Object.getOwnPropertyDescriptor(Database.prototype, "close");
    const nativeError = new Error("birth C close unknown"); let closes = 0;
    try {
      Database.prototype.close = function () {
        if (this === s.birthC?.db) { closes++; if (nativeCloseReturned) original.call(this); throw nativeError; }
        return original.call(this);
      };
      throwsCode(o, () => o.register(owner, r), "native_retirement_unknown");
      assert.ok(s.birth); assert.equal(s.birth!.cells[0], s.clientId);
      assert.equal(s.birthC!.db.open, !nativeCloseReturned);
      assert.equal(s.birthC!.closeReturned, false);
      assert.equal(s.B.db.open, true); assert.equal(s.B.transaction, null);
      assert.equal(s.B.closeAttempted, false); assert.equal(s.endC, null);
      assert.ok(o.pendingOwners.has(s)); assert.ok(s.failures.some(f => f.error === nativeError));
      o.abandon(owner);
      throwsCode(o, () => o.runObservation(owner, "commit", r), "owner_not_live");
      throwsCode(o, () => o.register(owner, r), "owner_not_live");
      assert.equal(closes, 1); assert.equal(s.B.db.open, true);
    } finally { restore(Database.prototype, "close", descriptor); await disposeState(s); await module.dispose(); }
  }
});

test("CF17-I04-07 B and end C close unknown never produce an exited fact or retry a native close", async t => {
  for (const role of ["B", "end-C"]) {
    const module = await derived(t), o = module.privateObservation, r = new AuditRequest();
    const owner = o.createOwner(r), s = o.owners.get(owner)!;
    o.register(owner, r); o.runObservation(owner, "commit", r);
    const original = Database.prototype.close, descriptor = Object.getOwnPropertyDescriptor(Database.prototype, "close");
    const nativeError = new Error(`${role} close unknown`); let closes = 0;
    try {
      Database.prototype.close = function () {
        const h = s.handles.find(h => h.db === this);
        if (h?.role === role) { closes++; original.call(this); throw nativeError; }
        return original.call(this);
      };
      throwsCode(o, () => o.end(owner, r), "native_retirement_unknown");
      assert.equal(s.B.db.open, false); assert.equal(s.phase, "unknown");
      assert.equal(s.pinCloseAttempted, false); assert.equal(existsSync(s.file), true);
      if (role === "B") { assert.equal(s.endC, null); assert.equal(s.ended, null); assert.equal(s.plannedEnd, null); }
      else { assert.ok(s.ended); assert.equal(s.endC!.db.open, false); assert.equal(s.endC!.closeReturned, false); }
      assert.ok(o.pendingOwners.has(s)); assert.ok(s.failures.some(f => f.error === nativeError));
      o.abandon(owner); throwsCode(o, () => o.end(owner, r), "owner_not_live");
      assert.equal(closes, 1); assert.equal(s.pinCloseAttempted, false);
    } finally { restore(Database.prototype, "close", descriptor); await disposeState(s); await module.dispose(); }
  }
});

test("CF17-I04-08 birth COMMIT and B COMMIT/ROLLBACK unknown preserve actual transaction identity", async t => {
  for (const phase of ["birth", "commit", "rollback"] as const) {
    const module = await derived(t), o = module.privateObservation, r = new AuditRequest();
    const owner = o.createOwner(r), s = o.owners.get(owner)!;
    if (phase !== "birth") o.register(owner, r);
    const original = Database.prototype.exec, descriptor = Object.getOwnPropertyDescriptor(Database.prototype, "exec");
    const nativeError = new Error(`${phase} terminal unknown`); let terminals = 0;
    try {
      Database.prototype.exec = function (sql: string) {
        const result = original.call(this, sql);
        const target = phase === "birth" ? s.birthC?.db : s.B.db;
        if (this === target && sql === o.SQL[phase === "rollback" ? "C-ROLLBACK" : "C-COMMIT"]) { terminals++; throw nativeError; }
        return result;
      };
      throwsCode(o, () => phase === "birth" ? o.register(owner, r) : o.runObservation(owner, phase, r), "transaction_unknown");
      const h = phase === "birth" ? s.birthC! : s.B;
      assert.equal(h.transaction!.outcome, "unknown"); assert.equal(h.transaction!.active, false);
      assert.equal(h.db.inTransaction, false); assert.equal(h.db.open, true);
      assert.deepEqual(s.counters, { committed: 0, rolledBack: 0, notAdmitted: 0 });
      if (phase === "birth") { assert.equal(s.birth, null); assert.ok(s.plannedBirth); assert.equal(s.plannedBirth.cells[0], s.clientId); }
      assert.ok(o.pendingOwners.has(s)); assert.ok(s.failures.some(f => f.error === nativeError));
      assert.throws(() => h.db.prepare("UPDATE main.storage_source_clients SET last_observed_at=last_observed_at").run(), /BR_M2_PROFILE_FORMAT_BLOCKED/);
      assert.equal(h.transaction!.outcome, "unknown");
      o.abandon(owner); throwsCode(o, () => o.register(owner, r), "owner_not_live");
      throwsCode(o, () => o.runObservation(owner, "commit", r), "owner_not_live");
      assert.equal(terminals, 1); assert.equal(h.closeAttempted, false);
    } finally { restore(Database.prototype, "exec", descriptor); await disposeState(s); await module.dispose(); }
  }
});

const columns = ["client_id", "database_instance_id", "entrypoint", "build_id", "protocol_version", "host_identity_json",
  "process_identity_json", "db_sessions_json", "registered_epoch", "observed_epoch", "drain_epoch", "drain_state",
  "drain_receipt_digest", "registered_at", "last_observed_at", "ended_at", "writer_format_digest"];

test("CF17-I04-09 real CAS rejects drift in each of 17 typed cells and rowid, then actually rolls back", async t => {
  const module = await derived(t), o = module.privateObservation;
  const original = Database.prototype.prepare, descriptor = Object.getOwnPropertyDescriptor(Database.prototype, "prepare");
  try {
    for (let changed = 0; changed < 18; changed++) {
      const r = new AuditRequest(), owner = o.createOwner(r), s = o.owners.get(owner)!;
      try {
        o.register(owner, r);
        // Isolated fault fixture: remove its local step guard so the actual fixed SQL's CAS is independently exercised.
        s.B.db.exec('DROP TRIGGER "br_m2_g1_storage_source_clients_update"');
        let affected: number | undefined, injected = false;
        setPrepare(Database.prototype, function (sql: string) {
          if (this === s.endC?.db && sql === o.SQL["C-NATIVE-END-OPEN"]) {
            assert.equal(injected, false); injected = true;
            const cell = s.birth!.cells[changed];
            const replacement = changed === 17 ? 123n : typeof cell === "string" ? Buffer.from(cell, "utf8")
              : typeof cell === "bigint" ? 1.5 : "changed";
            const name = changed === 17 ? "rowid" : columns[changed]!;
            original.call(this, `UPDATE main.storage_source_clients SET "${name}"=?`).run(replacement);
            const statement = original.call(this, sql), run = statement.run;
            statement.run = function (...args: unknown[]) {
              const result = Reflect.apply(run, this, args) as Database.RunResult;
              affected = result.changes; return result;
            };
            return statement;
          }
          return original.call(this, sql);
        });
        throwsCode(o, () => o.end(owner, r), "step_mismatch");
        assert.equal(affected, 0, `CAS ${changed}`);
        assert.equal(s.endC!.db.inTransaction, false); assert.equal(s.ended, null);
        const actual = s.endC!.db.prepare("SELECT rowid AS _rowid,* FROM main.storage_source_clients").get() as Record<string, Native>;
        assert.equal(actual._rowid, s.birth!.rowid);
        for (let i = 0; i < 17; i++) assert.deepEqual(actual[columns[i]!], s.birth!.cells[i], `rolled back ${changed}/${i}`);
        assert.equal(s.phase, "failed"); assert.equal(o.pendingOwners.has(s), false);
      } finally { restore(Database.prototype, "prepare", descriptor); await disposeState(s); }
    }
  } finally { restore(Database.prototype, "prepare", descriptor); await module.dispose(); }
});

function seedClient(s: State, o: Observation, rowid: bigint, collide?: "client" | "process"): void {
  const trigger = s.B.db.prepare("SELECT sql FROM main.sqlite_schema WHERE name='br_m2_g1_storage_source_clients_insert'").get() as { sql: string };
  s.B.db.exec('DROP TRIGGER "br_m2_g1_storage_source_clients_insert"');
  const identity = JSON.parse(s.processJson);
  if (collide !== "process") identity.instanceId = "other-process-instance";
  s.B.db.prepare(o.SQL["C-BIRTH"]!).run(rowid, collide === "client" ? s.clientId : "other-client", s.databaseInstanceId,
    "local-management", "boardroom-native-management-v1", 2n, s.hostJson, JSON.stringify(identity), "{}", 0n, 0n,
    null, "none", null, "2026-11-20T00:00:00.000Z", "2026-11-20T00:00:00.000Z", null, "other-isolated-format");
  s.B.db.exec(trigger.sql);
}

test("CF17-I04-10 rowid is allocated under real BEGIN IMMEDIATE with exact signed int64 and collision checks", async t => {
  const module = await derived(t), o = module.privateObservation;
  try {
    for (const maximum of [-9n, 0n, 1n, 9223372036854775806n, 9223372036854775807n]) {
      const r = new AuditRequest(), owner = o.createOwner(r), s = o.owners.get(owner)!;
      seedClient(s, o, maximum);
      const original = Database.prototype.prepare, descriptor = Object.getOwnPropertyDescriptor(Database.prototype, "prepare");
      let observed = false;
      try {
        setPrepare(Database.prototype, function (sql: string) {
          if (this === s.birthC?.db && sql === o.SQL["C-NEXT-ROWID"]) { observed = true; assert.equal(this.inTransaction, true); }
          return original.call(this, sql);
        });
        if (maximum === 9223372036854775807n) {
          throwsCode(o, () => o.register(owner, r), "rowid_exhausted");
          assert.equal(s.plannedBirth, null); assert.equal(s.birth, null); assert.equal(s.birthC!.db.inTransaction, false);
          assert.equal((s.B.db.prepare("SELECT count(*) AS n FROM main.storage_source_clients").get() as { n: bigint }).n, 1n);
        } else {
          o.register(owner, r);
          assert.equal(s.birth!.rowid, maximum < 1n ? 1n : maximum + 1n);
          o.runObservation(owner, "commit", r); o.end(owner, r);
        }
        assert.equal(observed, true);
      } finally { restore(Database.prototype, "prepare", descriptor); await disposeState(s); }
    }
    for (const collision of ["client", "process"] as const) {
      const r = new AuditRequest(), owner = o.createOwner(r), s = o.owners.get(owner)!;
      try {
        seedClient(s, o, 1n, collision);
        throwsCode(o, () => o.register(owner, r), "step_mismatch");
        assert.equal(s.birth, null); assert.equal(s.plannedBirth, null); assert.equal(s.B.transaction, null);
      } finally { await disposeState(s); }
    }
  } finally { await module.dispose(); }
});

test("CF17-I04-11 copied owners, another request and swallowed reentry cannot authorize B commit", async t => {
  const module = await derived(t), o = module.privateObservation, r = new AuditRequest();
  const owner = o.createOwner(r), s = o.owners.get(owner)!;
  const descriptor = Object.getOwnPropertyDescriptor(s.B.db, "prepare"), original = s.B.db.prepare;
  let touched = 0, reentered = false;
  try {
    const proxy = new Proxy(owner, { get() { touched++; throw new Error("no"); } });
    for (const copy of [{ ...owner }, proxy]) throwsCode(o, () => o.register(copy, r), "owner_not_live");
    throwsCode(o, () => o.register(owner, new AuditRequest()), "owner_not_live"); assert.equal(touched, 0);
    o.register(owner, r);
    setPrepare(s.B.db, function (sql: string) {
      if (!reentered && sql === o.SQL["Q-META-FIRST-storage_maintenance"]) {
        reentered = true;
        throwsCode(o, () => o.runObservation(owner, "commit", r), "owner_reentry");
        assert.equal(s.B.transaction!.failed, true);
      }
      return original.call(this, sql);
    });
    throwsCode(o, () => o.runObservation(owner, "commit", r), "step_mismatch");
    assert.equal(reentered, true); assert.equal(s.B.db.inTransaction, false); assert.equal(s.B.transaction, null);
    assert.equal(s.counters.committed, 0); assert.equal(s.counters.notAdmitted, 1); assert.equal(s.phase, "failed");
  } finally { restore(s.B.db, "prepare", descriptor); await disposeState(s); await module.dispose(); }
});

test("CF17-I04-12 real source pin close followed by throw is retained without numeric-fd retry", async t => {
  const module = await derived(t, { from: "closeSync(s.pinFd); s.pinCloseReturned = true;",
    to: 'closeSync(s.pinFd); throw new Error("injected after actual source pin close");' });
  const o = module.privateObservation, r = new AuditRequest(), owner = o.createOwner(r), s = o.owners.get(owner)!;
  try {
    o.register(owner, r);
    throwsCode(o, () => o.end(owner, r), "native_retirement_unknown");
    assert.ok(s.ended); assert.equal(s.handles.every(h => h.closeReturned), true);
    assert.equal(s.pinCloseAttempted, true); assert.equal(s.pinCloseReturned, false);
    assert.ok(o.pendingOwners.has(s)); assert.equal(s.phase, "unknown"); assert.equal(existsSync(s.file), true);
    o.abandon(owner); throwsCode(o, () => o.end(owner, r), "owner_not_live");
    assert.equal(s.failures.filter(f => f.phase === "source-pin-close").length, 1);
  } finally { await disposeState(s, true); await module.dispose(); }
});

test("CF17-I04-13 oversized native text is rejected from metadata before the client value/hex producer", async t => {
  const module = await derived(t), o = module.privateObservation, r = new AuditRequest(), owner = o.createOwner(r), s = o.owners.get(owner)!;
  o.register(owner, r);
  const original = s.B.db.prepare, descriptor = Object.getOwnPropertyDescriptor(s.B.db, "prepare");
  let clientValues = 0, caught: unknown;
  try {
    s.B.db.exec('DROP TRIGGER "br_m2_g1_storage_source_clients_update"');
    s.B.db.prepare("UPDATE main.storage_source_clients SET host_identity_json=?").run("x".repeat(AUDIT_LIMITS.field + 1));
    setPrepare(s.B.db, function (sql: string) { if (sql === o.SQL["Q-VALUE-storage_source_clients"]) clientValues++; return original.call(this, sql); });
    try { o.runObservation(owner, "commit", r); } catch (error) { caught = error; }
    assert.ok(caught && typeof caught === "object");
    const known = r.failures.get(caught); assert.ok(known && !known.ok); if (known && !known.ok) assert.equal(known.error.code, "resource_limit");
    assert.equal(clientValues, 0); assert.equal(s.B.db.inTransaction, false); assert.equal(s.phase, "failed");
    assert.equal(s.counters.notAdmitted, 1); assert.equal(s.counters.committed, 0);
  } finally { restore(s.B.db, "prepare", descriptor); await disposeState(s); await module.dispose(); }
});

test("CF17-I04-14 one cumulative request budget rejects before native producers and still settles known resources", async t => {
  const module = await derived(t), o = module.privateObservation;
  const expectResource = (r: AuditRequest, f: () => unknown) => {
    let caught: unknown; try { f(); } catch (error) { caught = error; }
    assert.ok(caught && typeof caught === "object");
    const known = r.failures.get(caught); assert.ok(known && !known.ok);
    if (known && !known.ok) assert.equal(known.error.code, "resource_limit");
  };
  try {
    const emptyBudget = new AuditRequest();
    emptyBudget.text(AUDIT_LIMITS.characters - 2048 - 1);
    expectResource(emptyBudget, () => o.createOwner(emptyBudget));
    assert.equal(o.pendingOwners.size, 0);
    for (const phase of ["B", "C"] as const) {
      const r = new AuditRequest(), owner = o.createOwner(r), s = o.owners.get(owner)!;
      try {
        o.register(owner, r); o.runObservation(owner, "commit", r);
        const used = (r as unknown as { characters: number }).characters;
        assert.ok(used > 2048); assert.equal(s.request, r);
        // Private derived observation consumes the existing real meter; no new product limit/hook is introduced.
        r.text(AUDIT_LIMITS.characters - used - (phase === "B" ? 10_000 : 1));
        if (phase === "B") {
          expectResource(r, () => o.runObservation(owner, "commit", r));
          assert.equal(s.B.db.inTransaction, false); assert.equal(s.counters.committed, 1);
          assert.equal(s.counters.notAdmitted, 1);
        } else {
          expectResource(r, () => o.end(owner, r));
          assert.equal(s.B.closeReturned, true); assert.equal(s.endC, null); assert.equal(s.handles.length, 2);
        }
        o.abandon(owner);
        assert.equal(s.phase, "retired"); assert.equal(s.pinCloseReturned, true);
        assert.equal(existsSync(s.directory), false); assert.equal(o.pendingOwners.size, 0);
      } finally { await disposeState(s); }
    }
  } finally { await module.dispose(); }
});

test("CF17-I04-15 current control and the seventeenth own cell are checked again in each B transaction", async t => {
  const module = await derived(t), o = module.privateObservation;
  try {
    for (const drift of ["control", "writer-format"] as const) {
      const r = new AuditRequest(), owner = o.createOwner(r), s = o.owners.get(owner)!;
      try {
        o.register(owner, r); o.runObservation(owner, "commit", r);
        if (drift === "control") {
          s.B.db.exec('DROP TRIGGER "br_i04_control_update"');
          s.B.db.prepare("UPDATE main.storage_maintenance SET fence_epoch=1").run();
        } else {
          s.B.db.exec('DROP TRIGGER "br_m2_g1_storage_source_clients_update"');
          s.B.db.prepare("UPDATE main.storage_source_clients SET writer_format_digest='different'").run();
        }
        throwsCode(o, () => o.runObservation(owner, "commit", r), drift === "control" ? "source_changed" : "step_mismatch");
        assert.equal(s.B.db.inTransaction, false); assert.equal(s.counters.committed, 1); assert.equal(s.counters.notAdmitted, 1);
        assert.equal(s.phase, "failed"); assert.equal(s.ended, null);
      } finally { await disposeState(s); }
    }
  } finally { await module.dispose(); }
});

test("CF17-I04-16 actual fixed client guards call private original six-argument format ABI", async t => {
  const module = await derived(t), o = module.privateObservation, r = new AuditRequest();
  const guards = SQLITE_PROFILE_GUARD_DEFINITIONS.filter(g => g.table === "storage_source_clients");
  const installed: string[] = [], original = Database.prototype.exec;
  const descriptor = Object.getOwnPropertyDescriptor(Database.prototype, "exec");
  let s: State | undefined;
  try {
    Database.prototype.exec = function (sql: string) {
      if (guards.some(g => g.sql === sql)) installed.push(sql);
      return original.call(this, sql);
    };
    const owner = o.createOwner(r); s = o.owners.get(owner)!;
    const format = s.B.db.prepare("SELECT narg,flags FROM pragma_function_list WHERE name='br_m2_private_format_v1'").get() as { narg: bigint; flags: bigint } | undefined;
    assert.ok(format, "the original private format UDF must actually be registered");
    assert.equal(format.narg, 6n);
    assert.equal(format.flags & 0x800n, 0n); // SQLITE_DETERMINISTIC is forbidden for live L/T/O checks.
    assert.deepEqual(installed, guards.map(g => g.sql));
    const triggerNames = s.B.db.prepare("SELECT name FROM main.sqlite_schema WHERE type='trigger' AND tbl_name='storage_source_clients' ORDER BY name").all() as { name: string }[];
    assert.deepEqual(triggerNames.map(g => g.name), guards.map(g => g.name).sort());
    assert.equal((s.B.db.prepare("SELECT br_m2_private_format_v1(?,?,?,?,?,?) AS allowed").get("storage_source_clients", "insert",
      s.databaseInstanceId, 0n, "I04_ISOLATED_NOT_G1", SQLITE_PROFILE_RULE_SOURCE.basis.writerDescriptor.sha256) as { allowed: number }).allowed, 0);
    o.register(owner, r); o.runObservation(owner, "commit", r); o.end(owner, r);
  } finally { restore(Database.prototype, "exec", descriptor); if (s) await disposeState(s); await module.dispose(); }
});

function nativeFormat(db: Database.Database, args: unknown[]): number {
  return (db.prepare("SELECT br_m2_private_format_v1(?,?,?,?,?,?) AS allowed").get(...args) as { allowed: number }).allowed;
}

test("CF17-I04-17 native format strictly checks six values, actual owner/T/generation and exact planned pre/post", async t => {
  const module = await derived(t), o = module.privateObservation, r = new AuditRequest();
  const owner = o.createOwner(r), s = o.owners.get(owner)!;
  const original = Database.prototype.prepare, descriptor = Object.getOwnPropertyDescriptor(Database.prototype, "prepare");
  let checked = 0;
  try {
    setPrepare(Database.prototype, function (sql: string) {
      const h = s.handles.find(h => h.db === this);
      if (h && (sql === o.SQL["C-BIRTH"] || sql === o.SQL["C-NATIVE-END-OPEN"])) {
        const tr = h.transaction!, step = h.step!, control = tr.control!;
        const args = ["storage_source_clients", step.event, s.databaseInstanceId, control.cells[4], control.cells[13], SQLITE_PROFILE_RULE_SOURCE.basis.writerDescriptor.sha256];
        const counters = r as unknown as { characters: number; nodes: number; work: number };
        const before = { characters: counters.characters, nodes: counters.nodes, work: counters.work };
        assert.equal(nativeFormat(this, args), 1);
        for (let i = 0; i < 6; i++) {
          const wrong = [...args]; wrong[i] = typeof args[i] === "string" ? `${args[i]}!` : 1n;
          assert.equal(nativeFormat(this, wrong), 0, `format argument ${i}`);
        }
        const coerced = [...args]; coerced[3] = Number(args[3]); assert.equal(nativeFormat(this, coerced), 0);
        if (s.B.db.open) assert.equal(nativeFormat(s.B.db, args), 0);
        else assert.throws(() => nativeFormat(s.B.db, args), /connection is not open/);
        h.transaction = { ...tr }; assert.equal(nativeFormat(this, args), 0); h.transaction = tr;
        h.generation++; assert.equal(nativeFormat(this, args), 0); h.generation--;
        tr.active = false; assert.equal(nativeFormat(this, args), 0); tr.active = true;
        tr.executing = false; assert.equal(nativeFormat(this, args), 0); tr.executing = true;
        tr.failed = true; assert.equal(nativeFormat(this, args), 0); tr.failed = false;
        h.step = null; assert.equal(nativeFormat(this, args), 0); h.step = step;
        const wrongPre = [...step.before]; wrongPre[0] = "forged preimage";
        h.step = { ...step, before: wrongPre }; assert.equal(nativeFormat(this, args), 0);
        const wrongPost = [...step.after]; wrongPost[14] = "forged after";
        h.step = { ...step, after: wrongPost }; assert.equal(nativeFormat(this, args), 0); h.step = step;
        const wrongControl = [...control.cells]; wrongControl[4] = 5n;
        tr.control = { ...control, cells: wrongControl }; assert.equal(nativeFormat(this, args), 0); tr.control = control;
        assert.equal(nativeFormat(this, args), 1);
        assert.deepEqual({ characters: counters.characters, nodes: counters.nodes, work: counters.work }, before,
          "the native callbacks never mutate the audit budget");
        checked++;
      }
      return original.call(this, sql);
    });
    o.register(owner, r); o.runObservation(owner, "commit", r); o.end(owner, r);
    assert.equal(checked, 2);
  } finally { restore(Database.prototype, "prepare", descriptor); await disposeState(s); await module.dispose(); }
});

test("CF17-I04-18 actual fixed row guard rejects a wrong native birth/end postimage and failure stays sticky", async t => {
  const module = await derived(t), o = module.privateObservation;
  const original = Database.prototype.prepare, descriptor = Object.getOwnPropertyDescriptor(Database.prototype, "prepare");
  try {
    for (const program of ["birth", "end"] as const) {
      const r = new AuditRequest(), owner = o.createOwner(r), s = o.owners.get(owner)!;
      if (program === "end") o.register(owner, r);
      let changed = false;
      try {
        setPrepare(Database.prototype, function (sql: string) {
          const target = program === "birth" ? s.birthC?.db : s.endC?.db;
          const statement = original.call(this, sql);
          if (this === target && sql === o.SQL[program === "birth" ? "C-BIRTH" : "C-NATIVE-END-OPEN"]) {
            const run = statement.run;
            statement.run = function (...args: unknown[]) {
              assert.equal(changed, false); changed = true;
              if (program === "birth") args[1] = "wrong-native-client-id";
              else args[0] = { ...(args[0] as Record<string, unknown>), new_ended_at: "2000-01-01T00:00:00.000Z" };
              return Reflect.apply(run, this, args) as Database.RunResult;
            };
          }
          return statement;
        });
        assert.throws(() => program === "birth" ? o.register(owner, r) : o.end(owner, r), /BR_M2_PROFILE_ROW_BLOCKED/);
        const h = program === "birth" ? s.birthC! : s.endC!;
        assert.equal(changed, true); assert.equal(h.db.inTransaction, false); assert.equal(h.transaction, null); assert.equal(h.step, null);
        assert.equal(s.phase, "failed"); assert.equal(s.ended, null);
        const rows = h.db.prepare("SELECT ended_at FROM main.storage_source_clients").all() as { ended_at: null }[];
        assert.deepEqual(rows, program === "birth" ? [] : [{ ended_at: null }]);
        throwsCode(o, () => o.runObservation(owner, "commit", r), "owner_not_live");
      } finally { restore(Database.prototype, "prepare", descriptor); await disposeState(s); }
    }
  } finally { restore(Database.prototype, "prepare", descriptor); await module.dispose(); }
});

test("CF17-I04-19 actual native writes are refused after O/T revocation while COMMIT has not yet run", async t => {
  const module = await derived(t), o = module.privateObservation, r = new AuditRequest(), owner = o.createOwner(r), s = o.owners.get(owner)!;
  const original = Database.prototype.exec, descriptor = Object.getOwnPropertyDescriptor(Database.prototype, "exec");
  let checked = 0;
  try {
    assert.throws(() => s.B.db.prepare(o.SQL["C-BIRTH"]!).run(1n, "unowned", s.databaseInstanceId,
      "local-management", "boardroom-native-management-v1", 2n, s.hostJson, s.processJson, "{}", 0n, 0n,
      null, "none", null, "2026-11-20T00:00:00.000Z", "2026-11-20T00:00:00.000Z", null,
      SQLITE_PROFILE_RULE_SOURCE.basis.writerDescriptor.sha256), /BR_M2_PROFILE_FORMAT_BLOCKED/);
    Database.prototype.exec = function (sql: string) {
      const h = s.handles.find(h => h.db === this);
      if (h && h.role !== "B" && sql === o.SQL["C-COMMIT"]) {
        assert.equal(this.inTransaction, true); assert.equal(h.step, null); assert.equal(h.transaction!.active, false);
        const event = h.role === "birth-C" ? "insert" : "update";
        assert.equal(nativeFormat(this, ["storage_source_clients", event, s.databaseInstanceId, 0n,
          "I04_ISOLATED_NOT_G1", SQLITE_PROFILE_RULE_SOURCE.basis.writerDescriptor.sha256]), 0);
        assert.throws(() => this.prepare("UPDATE main.storage_source_clients SET last_observed_at=last_observed_at").run(), /BR_M2_PROFILE_FORMAT_BLOCKED/);
        assert.throws(() => this.prepare("DELETE FROM main.storage_source_clients").run(), /BR_M2_PROFILE_OPERATION_BLOCKED/);
        checked++;
      }
      return original.call(this, sql);
    };
    o.register(owner, r); o.runObservation(owner, "commit", r); o.end(owner, r);
    assert.equal(checked, 2);
  } finally { restore(Database.prototype, "exec", descriptor); await disposeState(s); await module.dispose(); }
});

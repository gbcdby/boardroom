import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import * as publicApi from "../src/server/storage/internal/sqlite-profile-owner.ts";
import { inspectSqliteProfileCellTransport } from "../src/server/storage/internal/sqlite-profile-owner.ts";
import { AuditRequest, AUDIT_LIMITS } from "../src/server/identity/internal/m2-audit-boundary.ts";

const cells = [
  ["null"], ["integer", "-9223372036854775808"], ["integer", "9223372036854775807"],
  ["real64be", "3ff0000000000000"], ["real64be", "0000000000000001"],
  ["text", "00efbbbff09f8ca8e4b8ad"], ["text", ""], ["blob", "0001ff8000"], ["blob", ""],
];

test("SQO-01 original module: native typed transport rolls back, commits, reads exact cells and closes", () => {
  const wire = JSON.stringify({ cells });
  const result = inspectSqliteProfileCellTransport(wire);
  assert.deepEqual(result, { ok: true, value: { scope: "isolated-sqlite-cell-transport", cells,
    transactions: { rolledBack: 1, committed: 1 }, retirement: "closed" } });
  assert.deepEqual(inspectSqliteProfileCellTransport(wire), result);
  assert.ok(Object.isFrozen(result));
  if (result.ok) {
    assert.ok(Object.isFrozen(result.value)); assert.ok(Object.isFrozen(result.value.cells));
    for (const cell of result.value.cells) assert.ok(Object.isFrozen(cell));
  }
});

function reject(value: unknown, code: string): void {
  const result = inspectSqliteProfileCellTransport(value);
  assert.deepEqual(result, { ok: false, error: { code } });
  assert.ok(Object.isFrozen(result));
  if (!result.ok) assert.ok(Object.isFrozen(result.error));
}

test("SQO-02 original boundary: one value export, no caller object execution or extra capability fields", () => {
  assert.deepEqual(Object.keys(publicApi), ["inspectSqliteProfileCellTransport"]);
  let calls = 0;
  const trap = () => { calls++; throw new Error("must not execute"); };
  const hostile = new Proxy({ get cells() { return trap(); } }, {
    get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap,
  });
  for (const value of [null, undefined, {}, [], hostile, new String('{"cells":[]}'), trap, 1, true])
    reject(value, "unsupported_shape");
  assert.equal(calls, 0);
  for (const key of ["path", "handle", "SQL", "callback", "limits", "permit", "verified", "source"])
    reject(JSON.stringify({ cells: [], [key]: true }), "unsupported_shape");
  for (const wire of ['{"cells":[],"cells":[]}', '{"cells":[]} {}', '{"cells":[["text","\\ud800"]]}'])
    reject(wire, "invalid_value");
  for (const wire of ["[]", "null", '{"cells":{}}', '{"cells":[{}]}']) reject(wire, "unsupported_shape");
  assert.ok(inspectSqliteProfileCellTransport('{"cells":[]}').ok);
});

test("SQO-03 original typed cells: exact ranges/encoding and explicit unsupported lossless domains", () => {
  for (const integer of ["-9223372036854775809", "9223372036854775808", "-0", "+1", "01", "1.0", "1e2", ""])
    reject(JSON.stringify({ cells: [["integer", integer]] }), "invalid_value");
  for (const cell of [["blob", "A0"], ["blob", "0"], ["blob", "zz"], ["real64be", "00"]])
    reject(JSON.stringify({ cells: [cell] }), "invalid_value");
  reject('{"cells":[["null","extra"]]}', "unsupported_shape");
  reject('{"cells":[["text","a","extra"]]}', "invalid_value");
  reject('{"cells":[["integer",1]]}', "invalid_value");
  reject('{"cells":[["boolean","true"]]}', "unsupported_shape");
  for (const hex of ["80", "c0af", "eda080", "f4908080", "efbf"])
    reject(JSON.stringify({ cells: [["text", hex]] }), "semantic_unsupported");
  for (const hex of ["7ff0000000000000", "fff0000000000000", "7ff8000000000001", "8000000000000000"])
    reject(JSON.stringify({ cells: [["real64be", hex]] }), "semantic_unsupported");
  const extremes = [["real64be", "0000000000000000"], ["real64be", "7fefffffffffffff"],
    ["real64be", "ffefffffffffffff"], ["real64be", "8000000000000001"], ["integer", "0"],
    ["text", "efbfbdefbbbf00"], ["blob", "eda080"]];
  const result = inspectSqliteProfileCellTransport(JSON.stringify({ cells: extremes }));
  assert.ok(result.ok);
  if (result.ok) assert.deepEqual(result.value.cells, extremes);
});

test("SQO-04 original finite budgets: input, depth, row count and detached output caps", () => {
  reject(" ".repeat(AUDIT_LIMITS.input + 1), "resource_limit");
  reject('['.repeat(AUDIT_LIMITS.depth + 1) + '0' + ']'.repeat(AUDIT_LIMITS.depth + 1), "resource_limit");
  reject(JSON.stringify({ cells: Array.from({ length: AUDIT_LIMITS.rows + 1 }, () => ["null"]) }), "resource_limit");
  reject(JSON.stringify({ cells: [["blob", "00".repeat(AUDIT_LIMITS.output / 2)]] }), "resource_limit");
  // A finite useful batch succeeds without a test-selected product limit.
  const result = inspectSqliteProfileCellTransport(JSON.stringify({ cells: Array.from({ length: 256 }, () => ["blob", "0000ff"]) }));
  assert.ok(result.ok);
});

type NativeCell = null | bigint | number | string | Buffer;
type PreparedCell = { wire: readonly string[]; native: NativeCell; storage: string };
type Transaction = { handle: Database.Database; generation: number; active: boolean; executing: boolean; failed: boolean; outcome: string };
type Step = { transaction: Transaction; table: string; event: string; oldRowid: bigint | null; newRowid: bigint | null;
  before: readonly NativeCell[]; after: readonly NativeCell[] };
type Owner = { db: Database.Database; failures: { phase: string; error: unknown }[]; phase: string; generation: number;
  transaction: Transaction | null; step: Step | null; closeAttempted: boolean; closeReturned: boolean };
type Observer = {
  owners: WeakMap<object, Owner>; pendingOwners: Set<Owner>; TABLE: string;
  createOwner(r: AuditRequest): object; closeOwner(owner: object): void; live(owner: object): Owner;
  current(s: Owner, t: Transaction): void; rowAllowed(s: Owner, args: readonly unknown[]): boolean;
  prepareCells(value: unknown, r: AuditRequest): PreparedCell[];
  insertCell(s: Owner, t: Transaction, index: number, cell: PreparedCell, r: AuditRequest): void;
  runProgram(owner: object, cells: readonly PreparedCell[], terminal: "commit" | "rollback", r: AuditRequest): string;
  kernelCode(error: unknown): string | undefined;
};
async function derived(t: { diagnostic(message: string): void }) {
  const directory = await mkdtemp(path.join(tmpdir(), "boardroom-sqlite-owner-private-"));
  const url = new URL("../src/server/storage/internal/sqlite-profile-owner.ts", import.meta.url);
  const original = await readFile(url, "utf8");
  const source = original.replace(/from "([^"]+)"/g, (_match, specifier: string) =>
    `from ${JSON.stringify(specifier.startsWith(".") ? new URL(specifier, url).href : import.meta.resolve(specifier))}`)
    + "\nexport const privateObservation = { owners, pendingOwners, TABLE, createOwner, closeOwner, live, current, rowAllowed, prepareCells, insertCell, runProgram, kernelCode };\n";
  const filename = path.join(directory, "derived-private-owner.ts");
  await writeFile(filename, source);
  t.diagnostic(JSON.stringify({ scope: "isolated-derived-private-observation", originalBytes: Buffer.byteLength(original),
    originalSha256: createHash("sha256").update(original).digest("hex"), derivedBytes: Buffer.byteLength(source),
    derivedSha256: createHash("sha256").update(source).digest("hex") }));
  const module = await import(pathToFileURL(filename).href) as typeof publicApi & { privateObservation: Observer };
  return { ...module, dispose: () => rm(directory, { recursive: true, force: true }) };
}
function throwsCode(o: Observer, run: () => unknown, expected: string): unknown {
  let thrown: unknown, didThrow = false;
  try { run(); } catch (error) { thrown = error; didThrow = true; }
  assert.equal(didThrow, true); assert.equal(o.kernelCode(thrown), expected); return thrown;
}
function restoreMethod(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(target, key, descriptor); else Reflect.deleteProperty(target, key);
}

test("SQO-05 derived private observation: exact native ABI, copied/cross owners, stale generations and escaped statements", async t => {
  const module = await derived(t), o = module.privateObservation, r = new AuditRequest();
  const owner = o.createOwner(r), otherOwner = o.createOwner(r), s = o.live(owner), other = o.live(otherOwner);
  const prepared = o.prepareCells({ cells: [["blob", "0001ff"]] }, r);
  let captured: { t: Transaction; step: Step } | undefined, escaped: Database.Statement | undefined, observations = 0;
  const descriptor = Object.getOwnPropertyDescriptor(s.db, "prepare"), originalPrepare = s.db.prepare;
  let proxyReads = 0;
  const copiedOwner = Object.freeze({ ...owner }), proxyOwner = new Proxy(owner, { get() { proxyReads++; throw new Error("no"); } });
  throwsCode(o, () => o.live(copiedOwner), "owner_not_live");
  throwsCode(o, () => o.live(proxyOwner), "owner_not_live");
  assert.equal(proxyReads, 0);
  try {
    s.db.prepare = function(this: Database.Database, sql: string) {
      if (sql.startsWith("INSERT INTO")) {
        const current = s.transaction!, step = s.step!, args = [o.TABLE, "insert", null, 1n, null, null, 1n, Buffer.from("0001ff", "hex")];
        assert.equal(o.rowAllowed(s, args), true);
        assert.notEqual(step.after[1], prepared[0]!.native); // Private BLOB snapshot, not an alias to the bind value.
        const before = { active: current.active, executing: current.executing, failed: current.failed, generation: s.generation, step: s.step };
        for (let index = 0; index < args.length; index++) {
          const wrong = [...args]; wrong[index] = index === 0 ? "other_table" : index === 1 ? "update" : index === 7 ? Buffer.from("0001fe", "hex") : 2n;
          assert.equal(o.rowAllowed(s, wrong), false);
        }
        assert.equal(o.rowAllowed(s, [...args, null]), false);
        assert.equal(o.rowAllowed(s, args.slice(1)), false);
        const handle = current.handle; current.handle = other.db;
        assert.equal(o.rowAllowed(s, args), false); current.handle = handle;
        const originalT = step.transaction;
        s.step = { ...step, transaction: { ...originalT } };
        assert.equal(o.rowAllowed(s, args), false); s.step = step;
        if (captured) {
          // A real second BEGIN is active; restore old references only in this isolated observer.
          const old = captured.t, oldActive = old.active, oldExecuting = old.executing;
          old.active = true; old.executing = true; s.transaction = old; s.step = captured.step;
          assert.equal(o.rowAllowed(s, args), false);
          s.transaction = current; s.step = step; old.active = oldActive; old.executing = oldExecuting;
          assert.ok(current.generation > old.generation);
          throwsCode(o, () => o.current(s, old), "step_mismatch");
        }
        assert.deepEqual({ active: current.active, executing: current.executing, failed: current.failed, generation: s.generation, step: s.step }, before);
        captured = { t: current, step }; observations++;
        escaped = originalPrepare.call(this, sql); return escaped;
      }
      return originalPrepare.call(this, sql);
    } as typeof s.db.prepare;
    assert.equal(o.runProgram(owner, prepared, "rollback", r), "rolled-back");
    assert.equal(captured!.t.active, false); assert.equal(captured!.t.executing, false);
    assert.equal(captured!.t.outcome, "rolled-back"); assert.equal(s.step, null); assert.equal(s.transaction, null);
    assert.throws(() => escaped!.run(2n, Buffer.from("0001ff", "hex")), /BR_PROFILE_STEP_REJECTED/);
    assert.equal(o.runProgram(owner, prepared, "commit", r), "committed");
    assert.equal(observations, 2); assert.equal(captured!.t.outcome, "committed");
    assert.equal(o.rowAllowed(s, [o.TABLE, "insert", null, 1n, null, null, 1n, prepared[0]!.native]), false);
    assert.throws(() => s.db.prepare(`UPDATE ${o.TABLE} SET cell=cell`).run(), /BR_PROFILE_STEP_REJECTED/);
    assert.throws(() => s.db.prepare(`DELETE FROM ${o.TABLE}`).run(), /BR_PROFILE_STEP_REJECTED/);
    o.closeOwner(owner); throwsCode(o, () => o.live(owner), "owner_not_live");
    assert.throws(() => escaped!.run(3n, null), /not open/);
  } finally {
    restoreMethod(s.db, "prepare", descriptor); o.closeOwner(owner); o.closeOwner(otherOwner); await module.dispose();
  }
});

test("SQO-06 derived private observation: caught reentry stays failed, native errors rollback, bind mutation cannot alter O", async t => {
  const module = await derived(t), o = module.privateObservation;
  try {
    for (const fault of ["reentry", "throw", "bind-mutation"] as const) {
      const r = new AuditRequest(), owner = o.createOwner(r), s = o.live(owner);
      const cells = o.prepareCells({ cells: [["blob", "0001ff"]] }, r);
      const descriptor = Object.getOwnPropertyDescriptor(s.db, "prepare"), originalPrepare = s.db.prepare;
      let observedT: Transaction | undefined, caughtReentry = false, reads = 0;
      const unknownError = Object.defineProperties({}, { code: { get() { reads++; throw 1; } }, message: { get() { reads++; throw 2; } } });
      s.db.prepare = function(this: Database.Database, sql: string) {
        if (sql.startsWith("INSERT INTO")) {
          observedT = s.transaction!;
          if (fault === "reentry") {
            throwsCode(o, () => o.runProgram(owner, cells, "commit", r), "owner_reentry"); caughtReentry = true;
          } else if (fault === "throw") throw unknownError;
          else (cells[0]!.native as Buffer)[2] = 0;
        }
        return originalPrepare.call(this, sql);
      } as typeof s.db.prepare;
      try {
        let thrown: unknown;
        assert.throws(() => { try { o.runProgram(owner, cells, "commit", r); } catch (error) { thrown = error; throw error; } });
        assert.equal(s.db.inTransaction, false); assert.equal(s.transaction, null); assert.equal(s.step, null);
        assert.equal(observedT!.failed, true); assert.equal(observedT!.active, false); assert.equal(observedT!.outcome, "rolled-back");
        assert.equal((s.db.prepare(`SELECT count(*) AS n FROM ${o.TABLE}`).get() as { n: bigint }).n, 0n);
        assert.equal(reads, 0);
        if (fault === "throw") { assert.equal(thrown, unknownError); assert.ok(s.failures.some(f => f.error === unknownError)); }
        if (fault === "reentry") assert.equal(caughtReentry, true);
        restoreMethod(s.db, "prepare", descriptor);
        assert.equal(o.runProgram(owner, o.prepareCells({ cells: [["integer", "7"]] }, r), "commit", r), "committed");
      } finally { restoreMethod(s.db, "prepare", descriptor); o.closeOwner(owner); }
    }
  } finally { await module.dispose(); }
});

test("SQO-07 derived private observation: throwing terminals stay unknown despite native post-state or cleanup", async t => {
  const module = await derived(t), o = module.privateObservation;
  try {
    for (const terminal of ["commit", "rollback"] as const) {
      for (const afterNative of [false, true]) {
        const r = new AuditRequest(), owner = o.createOwner(r), s = o.live(owner);
        const descriptor = Object.getOwnPropertyDescriptor(s.db, "exec"), originalExec = s.db.exec;
        const originalError = Object.freeze({ label: "observed-native-terminal-failure" });
        let observedT: Transaction | undefined;
        s.db.exec = function(this: Database.Database, sql: string) {
          if (sql === terminal.toUpperCase()) {
            observedT = s.transaction ?? observedT;
            assert.equal(s.step, null); assert.equal(observedT!.active, false); assert.equal(observedT!.executing, false);
            if (afterNative) originalExec.call(this, sql);
            throw originalError;
          }
          return originalExec.call(this, sql);
        };
        try {
          throwsCode(o, () => o.runProgram(owner, o.prepareCells({ cells: [["integer", "9"]] }, r), terminal, r), "transaction_unknown");
          assert.equal(s.phase, "unknown"); assert.equal(observedT!.outcome, "unknown"); assert.equal(observedT!.failed, true);
          assert.equal(s.step, null); assert.equal(s.transaction, null); assert.ok(s.failures.some(f => f.error === originalError));
          throwsCode(o, () => o.runProgram(owner, [], "commit", r), "owner_not_live");
          if (afterNative) {
            assert.equal(s.db.inTransaction, false);
            const row = s.db.prepare(`SELECT count(*) AS n FROM ${o.TABLE}`).get() as { n: bigint };
            assert.equal(row.n, terminal === "commit" ? 1n : 0n);
          }
        } finally { restoreMethod(s.db, "exec", descriptor); o.closeOwner(owner); }
      }
    }
  } finally { await module.dispose(); }
});

test("SQO-08 derived private observation: revoke before close, unknown close is strong and never retried", async t => {
  const module = await derived(t), o = module.privateObservation;
  try {
    for (const afterNative of [false, true]) {
      const r = new AuditRequest(), owner = o.createOwner(r), s = o.live(owner);
      assert.equal(o.runProgram(owner, o.prepareCells({ cells: [["null"]] }, r), "rollback", r), "rolled-back");
      const descriptor = Object.getOwnPropertyDescriptor(s.db, "close"), originalClose = s.db.close;
      const originalError = Object.freeze({ label: "observed-native-close-failure" });
      let closes = 0;
      s.db.close = function() {
        closes++;
        assert.equal(s.phase, "retiring"); assert.equal(s.step, null); assert.equal(s.transaction, null);
        assert.equal(o.pendingOwners.has(s), true);
        if (afterNative) originalClose.call(this);
        throw originalError;
      };
      try {
        throwsCode(o, () => o.closeOwner(owner), "native_retirement_unknown");
        assert.equal(s.phase, "unknown"); assert.equal(s.closeReturned, false); assert.equal(s.closeAttempted, true);
        assert.equal(s.db.open, !afterNative); assert.equal(o.pendingOwners.has(s), true);
        assert.ok(s.failures.some(f => f.error === originalError));
        throwsCode(o, () => o.live(owner), "owner_not_live");
        throwsCode(o, () => o.closeOwner(owner), "native_retirement_unknown");
        assert.equal(closes, 1);
      } finally {
        restoreMethod(s.db, "close", descriptor);
        // Test-owned physical cleanup does not manufacture a product retirement observation.
        if (s.db.open) originalClose.call(s.db);
        assert.equal(o.pendingOwners.has(s), true);
      }
    }
    const owner = o.createOwner(new AuditRequest()), s = o.live(owner);
    o.closeOwner(owner); o.closeOwner(owner);
    assert.equal(s.phase, "retired"); assert.equal(s.closeReturned, true); assert.equal(o.pendingOwners.has(s), false);

    const activeRequest = new AuditRequest(), activeOwner = o.createOwner(activeRequest), active = o.live(activeOwner);
    const prepareDescriptor = Object.getOwnPropertyDescriptor(active.db, "prepare"), originalPrepare = active.db.prepare;
    const closeDescriptor = Object.getOwnPropertyDescriptor(active.db, "close"), originalClose = active.db.close;
    let interrupted: Transaction | undefined, observedRevocation = false;
    active.db.prepare = function(this: Database.Database, sql: string) {
      if (sql.startsWith("INSERT INTO")) {
        interrupted = active.transaction!;
        assert.equal(interrupted.active, true); assert.equal(interrupted.executing, true); assert.ok(active.step);
        o.closeOwner(activeOwner);
      }
      return originalPrepare.call(this, sql);
    } as typeof active.db.prepare;
    active.db.close = function() {
      assert.equal(active.step, null); assert.equal(interrupted!.active, false); assert.equal(interrupted!.executing, false);
      assert.equal(this.inTransaction, false); observedRevocation = true;
      return originalClose.call(this);
    };
    try {
      assert.throws(() => o.runProgram(activeOwner, o.prepareCells({ cells: [["null"]] }, activeRequest), "commit", activeRequest));
      assert.equal(observedRevocation, true); assert.equal(active.phase, "retired");
      assert.equal(interrupted!.outcome, "rolled-back"); assert.equal(active.db.open, false);
      throwsCode(o, () => o.live(activeOwner), "owner_not_live");
    } finally {
      restoreMethod(active.db, "prepare", prepareDescriptor); restoreMethod(active.db, "close", closeDescriptor);
      o.closeOwner(activeOwner);
    }
  } finally { await module.dispose(); }
});

test("SQO-09 derived private observation: caught precondition, actual budget and snapshot failures poison T and revoke O", async t => {
  const module = await derived(t), o = module.privateObservation;
  try {
    for (const fault of ["precharge", "current", "snapshot"] as const) await t.test(fault, () => {
      const r = new AuditRequest(), owner = o.createOwner(r), s = o.live(owner);
      const cells = o.prepareCells({ cells: [["blob", "0001ff"]] }, r);
      const descriptor = Object.getOwnPropertyDescriptor(s.db, "prepare"), originalPrepare = s.db.prepare;
      const originalText = r.text, originalFrom = Buffer.from, snapshotError = Object.freeze({ label: "snapshot" });
      let invoked = false, caught = false, sticky = false, revoked = false, currentBlocked = false, outerFailed = false;
      function caughtHelper(): void {
        const actual = s.transaction!;
        if (fault === "precharge") {
          // Consume the original finite request through its real method; no limit or usage field is changed.
          const used = (r as unknown as { characters: number }).characters;
          originalText.call(r, AUDIT_LIMITS.characters - used - 1);
        }
        if (fault === "snapshot") Buffer.from = function(value: unknown, ...args: unknown[]) {
          if (Buffer.isBuffer(value)) throw snapshotError;
          return Reflect.apply(originalFrom, Buffer, [value, ...args]);
        } as typeof Buffer.from;
        try { o.insertCell(s, fault === "current" ? { ...actual } : actual, 0, cells[0]!, r); }
        catch (error) {
          caught = true;
          if (fault === "precharge") {
            const failure = error !== null && typeof error === "object" ? r.failures.get(error) : undefined;
            assert.ok(failure && !failure.ok && failure.error.code === "resource_limit");
          } else if (fault === "current") assert.equal(o.kernelCode(error), "step_mismatch");
          else assert.equal(error, snapshotError);
        } finally { Buffer.from = originalFrom; }
        sticky = actual.failed; revoked = s.step === null && !actual.executing;
        try { o.current(s, actual); } catch (error) { currentBlocked = o.kernelCode(error) === "step_mismatch"; }
      }
      if (fault === "current") s.db.prepare = function(this: Database.Database, sql: string) {
        if (!invoked && sql.startsWith("INSERT INTO")) { invoked = true; caughtHelper(); }
        return originalPrepare.call(this, sql);
      } as typeof s.db.prepare;
      else r.text = function(bytes: number, passes = 1) {
        if (!invoked && bytes === 3 && passes === 4) { invoked = true; caughtHelper(); }
        return originalText.call(this, bytes, passes);
      };
      try {
        try { o.runProgram(owner, cells, "commit", r); } catch { outerFailed = true; }
        assert.equal(invoked, true); assert.equal(caught, true);
        assert.equal(sticky, true, "the inner failure is sticky before the fixed outer program can resume");
        assert.equal(revoked, true); assert.equal(currentBlocked, true); assert.equal(outerFailed, true);
        assert.equal(s.db.inTransaction, false); assert.equal(s.transaction, null); assert.equal(s.step, null);
        const count = s.db.prepare(`SELECT count(*) AS n FROM ${o.TABLE}`).get() as { n: bigint };
        assert.equal(count.n, 0n);
      } finally {
        Buffer.from = originalFrom; r.text = originalText; restoreMethod(s.db, "prepare", descriptor); o.closeOwner(owner);
      }
    });
  } finally { await module.dispose(); }
});

test("SQO-10 original public inputs: actual character exhaustion precedes decode/output/step/readback producers", t => {
  const hex = "a5".repeat(64), wire = JSON.stringify({ cells: [["blob", hex]] }), outputReserve = Buffer.byteLength(wire) + 512;
  const text = AuditRequest.prototype.text, from = Buffer.from;
  const exec = Database.prototype.exec, prepare = Database.prototype.prepare, close = Database.prototype.close;
  let before: Record<string, number> = {}, events = { decoded: 0, snapshots: 0, created: 0, inserts: 0, selects: 0, rolledBack: 0, closes: 0 };
  const reset = () => { before = {}; events = { decoded: 0, snapshots: 0, created: 0, inserts: 0, selects: 0, rolledBack: 0, closes: 0 }; };
  AuditRequest.prototype.text = function(bytes, passes = 1) {
    const label = bytes === 64 && passes === 3 ? "decode" : bytes === outputReserve && passes === 2 ? "output"
      : bytes === 64 && passes === 4 ? "step" : bytes === 160 && passes === 3 ? "readback" : null;
    if (label && before[label] === undefined) before[label] = (this as unknown as { characters: number }).characters;
    return text.call(this, bytes, passes);
  };
  Buffer.from = function(value: unknown, ...args: unknown[]) {
    if (Buffer.isBuffer(value)) events.snapshots++;
    else if (value === hex && args[0] === "hex") events.decoded++;
    return Reflect.apply(from, Buffer, [value, ...args]);
  } as typeof Buffer.from;
  Database.prototype.exec = function(sql) {
    if (sql.startsWith("CREATE TABLE br_profile_cell_transport")) events.created++;
    if (sql === "ROLLBACK") events.rolledBack++;
    return exec.call(this, sql);
  };
  Database.prototype.prepare = function(this: Database.Database, sql: string) {
    if (sql.startsWith("INSERT INTO br_profile_cell_transport")) events.inserts++;
    if (sql.startsWith("SELECT ")) events.selects++;
    return prepare.call(this, sql);
  } as typeof Database.prototype.prepare;
  Database.prototype.close = function() { events.closes++; return close.call(this); };
  try {
    assert.ok(inspectSqliteProfileCellTransport(wire).ok);
    assert.deepEqual(events, { decoded: 1, snapshots: 2, created: 1, inserts: 2, selects: 4, rolledBack: 1, closes: 1 });
    const calibration = { ...before };
    for (const label of ["decode", "output", "step", "readback"]) {
      const padding = Math.floor((AUDIT_LIMITS.characters - calibration[label]! - 1) / 7);
      assert.ok(padding > 0 && padding + wire.length <= AUDIT_LIMITS.input);
      const input = " ".repeat(padding) + wire;
      reset(); reject(input, "resource_limit");
      assert.equal(before[label], calibration[label]! + padding * 7);
      const remaining = AUDIT_LIMITS.characters - before[label]!;
      assert.ok(remaining >= 1 && remaining <= 7);
      const later = label === "step" || label === "readback", wrote = label === "readback";
      assert.deepEqual(events, { decoded: label === "decode" ? 0 : 1, snapshots: wrote ? 1 : 0,
        created: later ? 1 : 0, inserts: wrote ? 1 : 0, selects: 0, rolledBack: later ? 1 : 0, closes: later ? 1 : 0 });
      t.diagnostic(JSON.stringify({ scope: "original-module-actual-public-input", label, inputBytes: Buffer.byteLength(input),
        inputSha256: createHash("sha256").update(input).digest("hex"), padding, before: before[label], limit: AUDIT_LIMITS.characters,
        remaining, events: { ...events } }));
    }
  } finally {
    AuditRequest.prototype.text = text; Buffer.from = from;
    Database.prototype.exec = exec; Database.prototype.prepare = prepare; Database.prototype.close = close;
  }
});

test("SQO-11 original public input: actual node exhaustion precedes step snapshots and native INSERT", t => {
  const allocate = AuditRequest.prototype.allocateNodes, from = Buffer.from;
  const exec = Database.prototype.exec, prepare = Database.prototype.prepare, close = Database.prototype.close;
  let before = -1, events = { decoded: 0, snapshots: 0, inserts: 0, rolledBack: 0, closes: 0 };
  AuditRequest.prototype.allocateNodes = function(n, depth = 0) {
    if (n === 32 && before < 0) before = (this as unknown as { nodes: number }).nodes;
    return allocate.call(this, n, depth);
  };
  Buffer.from = function(value: unknown, ...args: unknown[]) {
    if (Buffer.isBuffer(value)) events.snapshots++;
    else if (value === "" && args[0] === "hex") events.decoded++;
    return Reflect.apply(from, Buffer, [value, ...args]);
  } as typeof Buffer.from;
  Database.prototype.exec = function(sql) { if (sql === "ROLLBACK") events.rolledBack++; return exec.call(this, sql); };
  Database.prototype.prepare = function(this: Database.Database, sql: string) { if (sql.startsWith("INSERT INTO")) events.inserts++; return prepare.call(this, sql); } as typeof Database.prototype.prepare;
  Database.prototype.close = function() { events.closes++; return close.call(this); };
  try {
    const input = (n: number) => JSON.stringify({ cells: Array.from({ length: n }, () => ["blob", ""]) });
    assert.ok(inspectSqliteProfileCellTransport(input(1)).ok); const one = before;
    before = -1; assert.ok(inspectSqliteProfileCellTransport(input(2)).ok); const perRow = before - one, fixed = one - perRow;
    assert.equal(perRow, 9);
    const rows = Math.floor((AUDIT_LIMITS.nodes - fixed) / perRow), wire = input(rows);
    assert.ok(rows <= AUDIT_LIMITS.rows && wire.length < AUDIT_LIMITS.output);
    before = -1; events = { decoded: 0, snapshots: 0, inserts: 0, rolledBack: 0, closes: 0 };
    reject(wire, "resource_limit");
    assert.equal(before, fixed + rows * perRow);
    assert.ok(AUDIT_LIMITS.nodes - before >= 0 && AUDIT_LIMITS.nodes - before < 32);
    assert.deepEqual(events, { decoded: rows, snapshots: 0, inserts: 0, rolledBack: 1, closes: 1 });
    t.diagnostic(JSON.stringify({ scope: "original-module-actual-public-input", label: "step-nodes", inputBytes: Buffer.byteLength(wire),
      inputSha256: createHash("sha256").update(wire).digest("hex"), rows, before, limit: AUDIT_LIMITS.nodes, remaining: AUDIT_LIMITS.nodes - before, events }));
  } finally {
    AuditRequest.prototype.allocateNodes = allocate; Buffer.from = from;
    Database.prototype.exec = exec; Database.prototype.prepare = prepare; Database.prototype.close = close;
  }
});

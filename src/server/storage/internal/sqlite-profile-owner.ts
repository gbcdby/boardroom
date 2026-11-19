/** G1-SQ-D01 的内部 typed transport / 固定程序核。没有 production source/factory 准入。
 * 唯一值入口只拥有自己创建的 :memory:；不接受路径、handle、SQL、callback 或预算选项。
 */
import Database from "better-sqlite3";
import { boundary, record, AuditRequest, AUDIT_LIMITS } from "../../identity/internal/m2-audit-boundary.ts";

type Cell = readonly ["null"] | readonly ["integer" | "real64be" | "text" | "blob", string];
type NativeCell = null | bigint | number | string | Buffer;
type PreparedCell = { readonly wire: Cell; readonly native: NativeCell; readonly storage: string };
type KernelCode = "semantic_unsupported" | "owner_not_live" | "owner_reentry" | "step_mismatch"
  | "native_failure" | "transaction_unknown" | "native_retirement_unknown";
type Outcome = "starting" | "active" | "committed" | "rolled-back" | "unknown";
type Transaction = {
  readonly handle: Database.Database; readonly generation: number;
  active: boolean; executing: boolean; failed: boolean; outcome: Outcome;
};
type Step = {
  readonly transaction: Transaction; readonly table: string; readonly event: "insert";
  readonly oldRowid: null; readonly newRowid: bigint;
  readonly before: readonly NativeCell[]; readonly after: readonly NativeCell[];
};
type OwnerState = {
  readonly db: Database.Database; readonly failures: { phase: string; error: unknown }[];
  phase: "live" | "retiring" | "retired" | "unknown";
  generation: number; transaction: Transaction | null; step: Step | null;
  closeAttempted: boolean; closeReturned: boolean;
};
const owners = new WeakMap<object, OwnerState>();
// A throwing native close retains its concrete owner, even when db.open subsequently says false.
const pendingOwners = new Set<OwnerState>();
const kernelFailures = new WeakMap<object, KernelCode>();
const TABLE = "br_profile_cell_transport";
const INSERT = `INSERT INTO ${TABLE}(ordinal,cell) VALUES(?,?)`;
const INSERT_REAL = `INSERT INTO ${TABLE}(ordinal,cell) VALUES(?,CAST(? AS REAL))`;
const READ = `SELECT ordinal,typeof(cell) AS storage,cell FROM ${TABLE} ORDER BY ordinal`;
const COUNT = `SELECT count(*) AS n FROM ${TABLE}`;
const SCHEMA = `CREATE TABLE ${TABLE}(ordinal INTEGER PRIMARY KEY CHECK(ordinal>0),cell);
CREATE TRIGGER br_profile_transport_insert BEFORE INSERT ON ${TABLE} BEGIN
 SELECT CASE WHEN br_m2_private_row_v1('${TABLE}','insert',NULL,NEW.rowid,NULL,NULL,NEW.ordinal,NEW.cell) IS NOT 1 THEN RAISE(ABORT,'BR_PROFILE_STEP_REJECTED') END; END;
CREATE TRIGGER br_profile_transport_update BEFORE UPDATE ON ${TABLE} BEGIN
 SELECT CASE WHEN br_m2_private_row_v1('${TABLE}','update',OLD.rowid,NEW.rowid,OLD.ordinal,OLD.cell,NEW.ordinal,NEW.cell) IS NOT 1 THEN RAISE(ABORT,'BR_PROFILE_STEP_REJECTED') END; END;
CREATE TRIGGER br_profile_transport_delete BEFORE DELETE ON ${TABLE} BEGIN
 SELECT CASE WHEN br_m2_private_row_v1('${TABLE}','delete',OLD.rowid,NULL,OLD.ordinal,OLD.cell,NULL,NULL) IS NOT 1 THEN RAISE(ABORT,'BR_PROFILE_STEP_REJECTED') END; END;`;

function stop(code: KernelCode): never {
  const token = {}; kernelFailures.set(token, code); throw token;
}
function kernelCode(error: unknown): KernelCode | undefined {
  return error !== null && (typeof error === "object" || typeof error === "function") ? kernelFailures.get(error) : undefined;
}
function sameCell(left: NativeCell, right: unknown): boolean {
  return Buffer.isBuffer(left) ? Buffer.isBuffer(right) && left.equals(right) : Object.is(left, right);
}
function cellCost(value: NativeCell): number {
  return typeof value === "string" ? value.length * 3 : Buffer.isBuffer(value) ? value.length : 24;
}
function copyCell(value: NativeCell): NativeCell { return Buffer.isBuffer(value) ? Buffer.from(value) : value; }

/** Pure native callback: no SQL, I/O, budget mutation, consumed token, or exported registration hook. */
function rowAllowed(s: OwnerState, args: readonly unknown[]): boolean {
  const t = s.transaction, o = s.step;
  if (s.phase !== "live" || !t?.active || !t.executing || t.failed || !o || o.transaction !== t
    || t.generation !== s.generation || t.handle !== s.db || !s.db.open || !s.db.memory || !s.db.inTransaction)
    return false;
  if (args.length !== 4 + o.before.length + o.after.length || args[0] !== o.table || args[1] !== o.event
    || args[2] !== o.oldRowid || args[3] !== o.newRowid) return false;
  for (let i = 0; i < o.before.length; i++) if (!sameCell(o.before[i]!, args[4 + i])) return false;
  for (let i = 0; i < o.after.length; i++) if (!sameCell(o.after[i]!, args[4 + o.before.length + i])) return false;
  return true;
}
function live(owner: object): OwnerState {
  const s = owners.get(owner);
  if (!s || s.phase !== "live" || !s.db.open || !s.db.memory) stop("owner_not_live");
  return s;
}
function closeOwner(owner: object): void {
  const s = owners.get(owner);
  if (!s) stop("owner_not_live");
  if (s.closeReturned) return;
  if (s.closeAttempted) stop("native_retirement_unknown");
  s.phase = "retiring"; s.step = null;
  const transaction = s.transaction;
  if (transaction) { transaction.active = false; transaction.executing = false; }
  pendingOwners.add(s);
  try {
    if (s.db.inTransaction) {
      try {
        s.db.exec("ROLLBACK");
        if (s.db.inTransaction) stop("transaction_unknown");
        if (transaction && (transaction.outcome === "starting" || transaction.outcome === "active")) transaction.outcome = "rolled-back";
      } catch (error) {
        if (transaction) transaction.outcome = "unknown";
        s.failures.push({ phase: "close-rollback", error });
      }
    }
    s.closeAttempted = true;
    s.db.close();
    if (s.db.open) stop("native_retirement_unknown");
    s.closeReturned = true; s.phase = "retired"; pendingOwners.delete(s);
  } catch (error) {
    s.phase = "unknown"; s.failures.push({ phase: "close", error });
    stop("native_retirement_unknown");
  }
}
function createOwner(r: AuditRequest): object {
  // 32: L/handle/options/UDF closure and two pragma statement/results. Another 32 reserves the
  // finite failure-record/token graph (at most five records) so retirement cannot need new budget.
  r.allocateNodes(64); r.units(128); r.text(SCHEMA.length + 64, 4);
  let db: Database.Database;
  try { db = new Database(":memory:"); } catch { stop("native_failure"); }
  const owner = Object.freeze({});
  const s: OwnerState = { db, failures: [], phase: "live", generation: 0, transaction: null, step: null,
    closeAttempted: false, closeReturned: false };
  owners.set(owner, s);
  try {
    if (!db.memory || !db.open) stop("owner_not_live");
    db.pragma("foreign_keys=ON"); db.pragma("recursive_triggers=ON");
    db.defaultSafeIntegers(true);
    db.function("br_m2_private_row_v1", { safeIntegers: true, varargs: true, deterministic: false, directOnly: false },
      (...args: unknown[]) => rowAllowed(s, args) ? 1 : 0);
    db.exec(SCHEMA);
    return owner;
  } catch (error) {
    s.failures.push({ phase: "initialization", error }); closeOwner(owner); stop(kernelCode(error) ?? "native_failure");
  }
}

function current(s: OwnerState, t: Transaction): void {
  if (s.phase !== "live" || s.transaction !== t || t.generation !== s.generation || t.handle !== s.db
    || !t.active || t.failed || !s.db.open || !s.db.memory || !s.db.inTransaction) stop("step_mismatch");
}
function insertCell(s: OwnerState, t: Transaction, index: number, cell: PreparedCell, r: AuditRequest): void {
  try {
    current(s, t);
    if (t.executing || s.step !== null) stop("owner_reentry");
    // O's graph (12), native argument graph (9), statement/result/bind graphs (at most 8).
    // Four payload passes cover snapshot, bind, UDF materialization and exact comparison.
    r.allocateNodes(32); r.units(32); r.text(INSERT_REAL.length + 32, 2); r.text(cellCost(cell.native), 4);
    current(s, t);
    const ordinal = BigInt(index + 1), after = Object.freeze([ordinal, copyCell(cell.native)]);
    current(s, t);
    const step: Step = Object.freeze({ transaction: t, table: TABLE, event: "insert", oldRowid: null,
      newRowid: ordinal, before: Object.freeze([null, null]), after });
    s.step = step; t.executing = true;
    const result = s.db.prepare(cell.storage === "real" ? INSERT_REAL : INSERT).run(ordinal, cell.native);
    if (result.changes !== 1) stop("step_mismatch");
    current(s, t);
  } catch (error) {
    t.failed = true;
    if (s.transaction) s.transaction.failed = true;
    s.failures.push({ phase: "step", error });
    throw error;
  } finally {
    t.executing = false;
    if (s.transaction) s.transaction.executing = false;
    s.step = null;
  }
}
function verifyCells(s: OwnerState, expected: readonly PreparedCell[], r: AuditRequest): void {
  // Each row is an object plus three typed cells. The fixed 32 covers statement/all array and
  // better-sqlite3's three-column rowFactory keys/maps/generated function, before prepare/all.
  r.allocateNodes(expected.length * 4 + 32); r.units(expected.length * 12 + 32);
  let cost = 0;
  for (const cell of expected) cost += cellCost(cell.native);
  r.text(READ.length + 256, 3); r.text(cost + expected.length * 32 + 64, 3);
  const rows = s.db.prepare(READ).all() as
    { ordinal: bigint; storage: string; cell: NativeCell }[];
  if (rows.length !== expected.length) stop("step_mismatch");
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!, cell = expected[i]!;
    if (row.ordinal !== BigInt(i + 1) || row.storage !== cell.storage || !sameCell(cell.native, row.cell)) stop("semantic_unsupported");
  }
}
function runProgram(owner: object, cells: readonly PreparedCell[], terminal: "rollback" | "commit", r: AuditRequest): Outcome {
  const s = live(owner);
  if (s.transaction) { s.transaction.failed = true; stop("owner_reentry"); }
  if (s.db.inTransaction) stop("step_mismatch");
  // T's graph and fixed native terminal statements; reserve cleanup before BEGIN, not in catch.
  r.allocateNodes(16); r.units(64); r.text(128, 2);
  r.require(s.generation < Number.MAX_SAFE_INTEGER, "resource_limit");
  const t: Transaction = { handle: s.db, generation: ++s.generation, active: false, executing: false, failed: false, outcome: "starting" };
  s.transaction = t;
  let terminalAttempted = false;
  try {
    s.db.exec("BEGIN IMMEDIATE");
    if (!s.db.inTransaction) stop("transaction_unknown");
    t.active = true; t.outcome = "active";
    for (let i = 0; i < cells.length; i++) insertCell(s, t, i, cells[i]!, r);
    verifyCells(s, cells, r); current(s, t);
    // Revoke the statement/transaction admission before the unique terminal native call.
    s.step = null; t.executing = false; t.active = false; terminalAttempted = true;
    s.db.exec(terminal === "commit" ? "COMMIT" : "ROLLBACK");
    if (s.db.inTransaction) stop("transaction_unknown");
    t.outcome = terminal === "commit" ? "committed" : "rolled-back";
    return t.outcome;
  } catch (error) {
    t.failed = true; t.active = false; t.executing = false; s.step = null;
    s.failures.push({ phase: terminalAttempted ? "terminal" : "program", error });
    // An internal close can already have acknowledged ROLLBACK. A throwing program terminal
    // itself is still unknown; a later catch must never undo an acknowledged physical retirement.
    if (terminalAttempted || t.outcome !== "rolled-back") t.outcome = "unknown";
    try {
      if (s.db.inTransaction) {
        s.db.exec("ROLLBACK");
        // Cleanup cannot reclassify a throwing COMMIT/ROLLBACK as a known original terminal.
        if (!terminalAttempted && !s.db.inTransaction) t.outcome = "rolled-back";
      }
    } catch (rollbackError) { s.failures.push({ phase: "rollback", error: rollbackError }); }
    if (t.outcome === "unknown" && !s.closeReturned) s.phase = "unknown";
    if (terminalAttempted) stop("transaction_unknown");
    throw error;
  } finally { t.active = false; t.executing = false; s.step = null; s.transaction = null; }
}

function prepareCells(value: unknown, r: AuditRequest): PreparedCell[] {
  const v = record(value, ["cells"], r);
  r.require(Array.isArray(v.cells), "unsupported_shape");
  const cells: unknown[] = v.cells;
  r.rowCount(cells.length); r.allocateNodes(cells.length * 4 + 1); r.units(cells.length);
  const prepared: PreparedCell[] = [];
  for (const value of cells) {
    r.require(Array.isArray(value), "unsupported_shape");
    const cell: unknown[] = value;
    if (cell.length === 1 && cell[0] === "null") { prepared.push({ wire: cell as unknown as Cell, native: null, storage: "null" }); continue; }
    r.require(cell.length === 2 && typeof cell[1] === "string");
    const tag = cell[0], encoded = cell[1];
    let native: NativeCell, storage: string;
    if (tag === "integer") {
      r.require(encoded.length <= 20); r.allocateNodes(1); r.text(encoded.length, 2); r.units(2);
      r.require(/^(0|-?[1-9][0-9]*)$/.test(encoded)); native = BigInt(encoded);
      r.require(native >= -9223372036854775808n && native <= 9223372036854775807n); storage = "integer";
    } else if (tag === "text" || tag === "blob" || tag === "real64be") {
      const hex = r.hex(encoded, tag === "real64be" ? 8 : undefined), bytes = hex.length / 2;
      if (tag === "text") {
        // decodeText pays its six byte passes; reserve raw/round-trip Buffers, decoder and text value.
        r.allocateNodes(4);
        try { native = r.decodeText(hex); }
        catch (error) {
          const known = error !== null && typeof error === "object" ? r.failures.get(error) : undefined;
          if (known && !known.ok && known.error.code === "source_contract_mismatch") stop("semantic_unsupported");
          throw error;
        }
        storage = "text";
      } else {
        r.allocateNodes(tag === "real64be" ? 2 : 1); r.text(bytes, 3); r.units(2); const raw = Buffer.from(hex, "hex");
        if (tag === "blob") { native = raw; storage = "blob"; }
        else {
          native = raw.readDoubleBE(); storage = "real";
          // SQLite/JS transport does not promise nonfinite payloads or a persisted negative zero bit.
          if (!Number.isFinite(native) || Object.is(native, -0)) stop("semantic_unsupported");
        }
      }
    } else r.fail("unsupported_shape");
    // The primitive-string parser and exact checks above established this closed wire union.
    prepared.push({ wire: cell as unknown as Cell, native, storage });
  }
  return prepared;
}

/** 检查 native typed transport 与固定程序闭包；输出不是 source/factory 准入或可搬运权限。 */
export function inspectSqliteProfileCellTransport(input: unknown) {
  let specific: KernelCode | undefined;
  const result = boundary(input, (value, r) => {
    let owner: object | undefined;
    try {
      r.allocateNodes(8); r.units(16); // Compact result/error graph; C2's original 2048 reserve is unchanged.
      const cells = prepareCells(value, r);
      const outputCost = r.measure(value, AUDIT_LIMITS.output - 512);
      r.reserveOutput(outputCost.bytes + 512); r.allocateNodes(cells.length + 12); r.text(outputCost.bytes + 512, 2);
      owner = createOwner(r);
      const rolledBack = runProgram(owner, cells, "rollback", r);
      const s = live(owner);
      // One-column rowFactory/statement/result and exact count cell, paid before prepare/get.
      r.allocateNodes(24); r.units(24); r.text(COUNT.length + 128, 3);
      const count = s.db.prepare(COUNT).get() as { n: bigint };
      if (rolledBack !== "rolled-back" || count.n !== 0n) stop("step_mismatch");
      const committed = runProgram(owner, cells, "commit", r);
      if (committed !== "committed") stop("transaction_unknown");
      verifyCells(s, cells, r);
      closeOwner(owner);
      return { scope: "isolated-sqlite-cell-transport" as const, cells: cells.map(cell => cell.wire),
        transactions: { rolledBack: 1 as const, committed: 1 as const }, retirement: "closed" as const };
    } catch (error) { specific = kernelCode(error); throw error; }
    finally {
      if (owner) try { closeOwner(owner); }
      catch (error) { specific = kernelCode(error) ?? "native_retirement_unknown"; throw error; }
    }
  });
  if (result.ok) return result;
  return Object.freeze({ ok: false as const, error: Object.freeze({ code: specific ?? result.error.code }) });
}

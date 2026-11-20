/** SQ-D02 I04 的隔离 local-management 资源组件。仅创建自己的临时库。
 * fixture 没有 final G1、receipt 或 terminal；此模块不读取 selected source，不提供生产 writer。
 */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, realpathSync,
  rmdirSync, unlinkSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { AuditRequest, AUDIT_LIMITS, boundary } from "../../identity/internal/m2-audit-boundary.ts";
import { SQLITE_PROFILE_FIXED_QUERIES, SQLITE_PROFILE_READ_TABLES } from "./sqlite-profile-read-source.ts";
import { SQLITE_PROFILE_GUARD_DEFINITIONS, SQLITE_PROFILE_UDF_ABI } from "./sqlite-profile-guard-source.ts";
import { SQLITE_PROFILE_RULE_SOURCE } from "./sqlite-profile-rules.ts";

type Cell = null | bigint | number | string | Buffer;
type WireCell = readonly ["null"] | readonly ["integer" | "real64be" | "text" | "blob", string];
type Storage = "null" | "integer" | "real" | "text" | "blob";
type RawRow = { readonly rowid: bigint; readonly types: readonly Storage[]; readonly cells: readonly Cell[] };
type Code = "source_changed" | "owner_not_live" | "owner_reentry" | "step_mismatch" | "rowid_exhausted"
  | "native_failure" | "transaction_unknown" | "native_retirement_unknown" | "semantic_unsupported";
type Outcome = "starting" | "active" | "committed" | "rolled-back" | "unknown";
type Program = "birth" | "observe" | "end-open";
type Transaction = { readonly handle: Handle; readonly generation: number; readonly program: Program;
  active: boolean; executing: boolean; failed: boolean; admitted: boolean; outcome: Outcome; control: RawRow | null };
type Step = { readonly transaction: Transaction; readonly event: "insert" | "update";
  readonly oldRowid: bigint | null; readonly newRowid: bigint; readonly before: readonly Cell[]; readonly after: readonly Cell[] };
type Handle = { readonly db: Database.Database; readonly role: "B" | "birth-C" | "end-C";
  generation: number; transaction: Transaction | null; step: Step | null;
  closeAttempted: boolean; closeReturned: boolean };
type Owner = {
  readonly request: AuditRequest; readonly clientId: string; readonly processInstanceId: string;
  readonly connectionId: string; readonly databaseInstanceId: string;
  readonly failures: { phase: string; error: unknown }[]; readonly handles: Handle[];
  readonly counters: { committed: number; rolledBack: number; notAdmitted: number };
  phase: "opening" | "live" | "retiring" | "failed" | "unknown" | "retired";
  directory: string | null; file: string | null; directoryIdentity: { device: bigint; inode: bigint } | null;
  pinFd: number | null; pinCloseAttempted: boolean; pinCloseReturned: boolean;
  identity: { device: string; inode: string } | null; B: Handle | null; birthC: Handle | null; endC: Handle | null;
  control: RawRow | null; birth: RawRow | null; plannedBirth: RawRow | null; ended: RawRow | null; plannedEnd: RawRow | null;
  rawProduced: number; uncertain: boolean; hostJson: string; processJson: string;
};
const owners = new WeakMap<object, Owner>();
// Unknown results retain the actual handles, original row/identity and original native throws.
const pendingOwners = new Set<Owner>();
const errors = new WeakMap<object, Code>();
const CLIENTS = "storage_source_clients", CONTROL = "storage_maintenance";
const CLIENT_COLUMNS = SQLITE_PROFILE_READ_TABLES.find(t => t.table === CLIENTS)!.columns;
const CONTROL_COLUMNS = SQLITE_PROFILE_READ_TABLES.find(t => t.table === CONTROL)!.columns;
const SQL = Object.freeze(Object.fromEntries(SQLITE_PROFILE_FIXED_QUERIES.map(q => [q.id, q.sql])));
const MAX_ROWID = 9223372036854775807n;
// The fixed guard's compiled writer literal is a component input, never a receipt/currentFormat proof.
const FIXTURE_WRITER = SQLITE_PROFILE_RULE_SOURCE.basis.writerDescriptor.sha256;
// Deliberately not a valid G1 digest; this two-table fixture has no receipt or terminal.
const FIXTURE_GUARD = "I04_ISOLATED_NOT_G1";
const CLIENT_GUARDS = SQLITE_PROFILE_GUARD_DEFINITIONS.filter(g => g.table === CLIENTS);
const quoted = (name: string) => `"${name}"`; // Only compiled column names reach this function.
const FIXTURE_SCHEMA = [CONTROL_COLUMNS, CLIENT_COLUMNS].map((columns, i) =>
  `CREATE TABLE ${quoted(i === 0 ? CONTROL : CLIENTS)} (${columns.map(c =>
    `${quoted(c.name)} ${c.type}${c.notnull ? " NOT NULL" : ""}${c.pk ? " PRIMARY KEY" : ""}`
  ).join(",")});`).join("\n");
const FIXTURE_CONTROL_INSERT = `INSERT INTO "main"."storage_maintenance" VALUES (${CONTROL_COLUMNS.map(() => "?").join(",")})`;
const FIXTURE_CONTROL_GUARDS = ["insert", "update", "delete"].map(event =>
  `CREATE TRIGGER "br_i04_control_${event}" BEFORE ${event.toUpperCase()} ON "${CONTROL}" BEGIN SELECT RAISE(ABORT,'BR_I04_CONTROL_IMMUTABLE'); END;`
).join("\n");

function stop(code: Code): never { const token = {}; errors.set(token, code); throw token; }
function kernelCode(error: unknown): Code | undefined {
  return error !== null && (typeof error === "object" || typeof error === "function") ? errors.get(error) : undefined;
}
function sameCell(a: Cell, b: unknown): boolean {
  return Buffer.isBuffer(a) ? Buffer.isBuffer(b) && a.equals(b) : Object.is(a, b);
}
function sameRow(a: RawRow, b: RawRow | undefined): boolean {
  return b !== undefined && a.rowid === b.rowid && a.cells.length === b.cells.length
    && a.types.every((type, i) => type === b.types[i] && sameCell(a.cells[i]!, b.cells[i]));
}
function cellBytes(value: Cell): number {
  return typeof value === "string" ? value.length * 3 : Buffer.isBuffer(value) ? value.length : 24;
}
function storage(value: Cell): Storage {
  return value === null ? "null" : typeof value === "bigint" ? "integer" : typeof value === "number" ? "real"
    : typeof value === "string" ? "text" : "blob";
}
function snapshot(rowid: bigint, cells: readonly Cell[], r: AuditRequest): RawRow {
  r.allocateNodes(4 + cells.length * 3); r.text(cells.reduce<number>((n, c) => n + cellBytes(c), 0), 3);
  const copy = cells.map(c => Buffer.isBuffer(c) ? Buffer.from(c) : c);
  return Object.freeze({ rowid, cells: Object.freeze(copy), types: Object.freeze(copy.map(storage)) });
}
// Used only on locally produced bounded objects or a bounded JSON.parse result, never caller objects.
function canonical(value: unknown, r: AuditRequest, depth = 0): string {
  r.allocateNodes(2, depth);
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return r.stringify(value, AUDIT_LIMITS.field);
  if (Array.isArray(value)) {
    r.allocateNodes(value.length + 1, depth); const parts = value.map(v => canonical(v, r, depth + 1));
    const n = parts.reduce((n, p) => n + p.length, 2 + Math.max(0, parts.length - 1));
    r.text(n * 3, 2); return `[${parts.join(",")}]`;
  }
  if (value === null || typeof value !== "object") stop("semantic_unsupported");
  r.allocateNodes(1); const keys = Object.keys(value);
  r.allocateNodes(keys.length * 3); r.units(keys.length * Math.ceil(Math.log2(Math.max(2, keys.length))));
  r.text(keys.reduce((n, k) => n + k.length * 3, 0), Math.ceil(Math.log2(Math.max(2, keys.length))) + 1);
  keys.sort();
  const parts = keys.map(key => {
    const name = r.stringify(key, AUDIT_LIMITS.field), child = canonical((value as Record<string, unknown>)[key], r, depth + 1);
    r.text((name.length + child.length + 1) * 3, 2);
    return `${name}:${child}`;
  });
  const n = parts.reduce((n, p) => n + p.length, 2 + Math.max(0, parts.length - 1));
  r.text(n * 3, 3); return `{${parts.join(",")}}`;
}
function requireOwner(owner: object, r: AuditRequest): Owner {
  const s = owners.get(owner);
  if (!s || s.request !== r || s.phase === "retired" || s.phase === "unknown" || s.phase === "failed") stop("owner_not_live");
  return s;
}
function recordFailure(s: Owner, phase: string, error: unknown): void {
  // At most twelve records in the fixed one-birth/two-B/one-end graph; space reserved before resources.
  if (s.failures.length < 12) s.failures.push({ phase, error });
}
function uncertain(s: Owner, phase: string, error: unknown): void {
  recordFailure(s, phase, error); s.uncertain = true; s.phase = "unknown"; pendingOwners.add(s);
}
function source(s: Owner, r: AuditRequest): void {
  r.allocateNodes(96); r.units(96); r.text((s.file?.length ?? 0) * 3 + 512, 3);
  if (s.pinFd === null || s.pinCloseAttempted || !s.file || !s.directory || !s.identity || !s.directoryIdentity) stop("source_changed");
  try {
    const pin = fstatSync(s.pinFd, { bigint: true }), file = lstatSync(s.file, { bigint: true });
    const directory = lstatSync(s.directory, { bigint: true });
    if (!pin.isFile() || !file.isFile() || pin.nlink !== 1n || file.nlink !== 1n
      || String(pin.dev) !== s.identity.device || String(pin.ino) !== s.identity.inode
      || file.dev !== pin.dev || file.ino !== pin.ino || !directory.isDirectory()
      || directory.dev !== s.directoryIdentity.device || directory.ino !== s.directoryIdentity.inode) stop("source_changed");
  } catch (error) { recordFailure(s, "source", error); stop("source_changed"); }
}
function reserveQuery(sql: string, columns: number, r: AuditRequest): void {
  // prepare/get wrappers, fixed rowFactory keys/maps/generated code and at most one native row.
  r.allocateNodes(32 + columns * 6); r.units(32 + columns * 6); r.text(sql.length + 256 + columns * 128, 4);
}
function readRows(s: Owner, h: Handle, table: typeof CLIENTS | typeof CONTROL, r: AuditRequest): RawRow[] {
  const n = table === CLIENTS ? 17 : 15;
  r.allocateNodes(1); const rows: RawRow[] = [];
  let last: bigint | undefined;
  for (;;) {
    const query = SQL[`Q-META-${last === undefined ? "FIRST" : "NEXT"}-${table}`]!;
    reserveQuery(query, 1 + n * 2, r);
    const statement = h.db.prepare(query);
    const meta = (last === undefined ? statement.get() : statement.get(last)) as Record<string, unknown> | undefined;
    if (!meta) break;
    r.rowCount(1);
    if (typeof meta._rowid !== "bigint" || (last !== undefined && meta._rowid <= last)) stop("semantic_unsupported");
    r.allocateNodes(n * 2 + 2); const types: Storage[] = [];
    let payload = 0;
    for (let i = 0; i < n; i++) {
      const type = meta[`t${i}`], size = meta[`n${i}`];
      if (type !== "null" && type !== "integer" && type !== "real" && type !== "text" && type !== "blob") stop("semantic_unsupported");
      if (type === "null") { if (size !== null) stop("semantic_unsupported"); }
      else {
        if (typeof size !== "bigint" || size < 0n) stop("semantic_unsupported");
        r.require(size <= BigInt(AUDIT_LIMITS.field), "resource_limit");
        if (type === "text" || type === "blob") payload += Number(size);
      }
      types.push(type);
    }
    s.rawProduced += payload;
    r.require(s.rawProduced <= AUDIT_LIMITS.rawTotal, "resource_limit");
    // Before hex/CAST/lower or any returned value: n + 2n + 2n + 2n plus native/JS traversal/copies.
    r.text(payload, 14); r.allocateNodes(n * 9 + 4);
    const valueQuery = SQL[`Q-VALUE-${table}`]!; reserveQuery(valueQuery, 1 + n, r);
    const value = h.db.prepare(valueQuery).get(meta._rowid) as Record<string, unknown> | undefined;
    if (!value || value._rowid !== meta._rowid) stop("step_mismatch");
    const cells: Cell[] = [];
    for (let i = 0; i < n; i++) {
      const type = types[i]!, raw = value[`v${i}`];
      if (type === "null") { if (raw !== null) stop("semantic_unsupported"); cells.push(null); }
      else if (type === "integer") { if (typeof raw !== "bigint") stop("semantic_unsupported"); cells.push(raw); }
      else if (type === "real") {
        if (typeof raw !== "number" || !Number.isFinite(raw) || Object.is(raw, -0)) stop("semantic_unsupported"); cells.push(raw);
      } else {
        if (typeof raw !== "string" || raw.length !== Number(meta[`n${i}`]) * 2) stop("semantic_unsupported");
        const hex = r.hex(raw);
        cells.push(type === "text" ? r.decodeText(hex) : Buffer.from(hex, "hex"));
      }
    }
    rows.push(Object.freeze({ rowid: meta._rowid, types: Object.freeze(types), cells: Object.freeze(cells) }));
    last = meta._rowid;
  }
  return rows;
}
function current(s: Owner, h: Handle, t: Transaction): void {
  if (s.uncertain || s.phase === "failed" || s.phase === "retired" || h.transaction !== t || !t.active || t.failed
    || t.handle !== h || h.generation !== t.generation || !h.db.open || !h.db.inTransaction || h.closeAttempted) stop("step_mismatch");
}
function window(s: Owner, h: Handle, t: Transaction, r: AuditRequest): void {
  current(s, h, t); source(s, r);
  reserveQuery(SQL["Q-ENCODING"]!, 1, r);
  const encoding = h.db.prepare(SQL["Q-ENCODING"]!).get() as { encoding: string };
  if (encoding.encoding !== "UTF-8") stop("semantic_unsupported");
  const rows = readRows(s, h, CONTROL, r);
  if (!s.control || rows.length !== 1 || !sameRow(s.control, rows[0]) || rows[0]!.cells[5] !== "open") stop("source_changed");
  t.control = rows[0]!;
}
function ownRow(s: Owner, h: Handle, t: Transaction, r: AuditRequest): RawRow {
  current(s, h, t);
  const rows = readRows(s, h, CLIENTS, r), row = rows.find(row => row.cells[0] === s.clientId);
  if (!s.birth || !sameRow(s.birth, row)) stop("step_mismatch");
  // The original birth envelope remains byte-identical while private actual counters advance.
  if (!s.B || s.B.closeAttempted || !s.B.db.open || s.phase !== "live" || h !== s.B) stop("owner_not_live");
  return row!;
}
/** Shared pure L/T/O predicate: only the actual birth/end C, actual T and exact internally planned O. */
function activeStep(s: Owner, h: Handle): Step | null {
  const t = h.transaction, o = h.step;
  if (s.uncertain || !t?.active || !t.executing || t.failed || !t.control || !o || o.transaction !== t
    || t.handle !== h || t.generation !== h.generation || !h.db.open || !h.db.inTransaction || h.closeAttempted
    || (h !== s.birthC && h !== s.endC) || !s.control || !sameRow(s.control, t.control)) return null;
  let planned: RawRow | null;
  if (t.program === "birth") {
    if (s.phase !== "opening" || h !== s.birthC || s.birth !== null || o.event !== "insert" || !s.B?.db.open
      || s.B.closeAttempted || s.B.transaction !== null || o.oldRowid !== null) return null;
    planned = s.plannedBirth;
    for (let i = 0; i < 17; i++) if (o.before[i] !== null) return null;
  } else if (t.program === "end-open") {
    if (s.phase !== "retiring" || h !== s.endC || !s.B?.closeReturned || s.B.db.open || s.B.transaction !== null
      || o.event !== "update" || !s.birth || o.oldRowid !== s.birth.rowid) return null;
    planned = s.plannedEnd;
    for (let i = 0; i < 17; i++) if (!sameCell(s.birth.cells[i]!, o.before[i])) return null;
  } else return null;
  if (!planned || planned.rowid !== o.newRowid || o.before.length !== 17 || o.after.length !== 17
    || o.after[1] !== s.databaseInstanceId || o.after[4] !== 2n || o.after[16] !== FIXTURE_WRITER) return null;
  for (let i = 0; i < 17; i++) if (!sameCell(planned.cells[i]!, o.after[i])) return null;
  return o;
}
/** Pure native callbacks: no SQL, I/O, budget changes, registry registration or reusable token. */
function formatAllowed(s: Owner, h: Handle, table: unknown, event: unknown, databaseInstanceId: unknown,
  fenceEpoch: unknown, guardManifestDigest: unknown, writerFormatDigest: unknown): boolean {
  const o = activeStep(s, h);
  if (!o) return false;
  const control = o.transaction.control!;
  return table === CLIENTS && event === o.event && databaseInstanceId === control.cells[1]
    && fenceEpoch === control.cells[4] && guardManifestDigest === control.cells[13] && writerFormatDigest === FIXTURE_WRITER;
}
function rowAllowed(s: Owner, h: Handle, args: readonly unknown[]): boolean {
  const o = activeStep(s, h);
  if (!o || args.length !== 38 || args[0] !== CLIENTS || args[1] !== o.event || args[2] !== o.oldRowid || args[3] !== o.newRowid) return false;
  for (let i = 0; i < 17; i++) if (!sameCell(o.before[i]!, args[4 + i]) || !sameCell(o.after[i]!, args[21 + i])) return false;
  return true;
}
function openHandle(s: Owner, role: Handle["role"], r: AuditRequest): Handle {
  // Includes finite native close/rollback and failure graph, reserved before opening the handle.
  r.allocateNodes(96); r.units(256); r.text((s.file?.length ?? 0) * 3 + 1024, 5);
  if (!s.file) stop("owner_not_live");
  const db = new Database(s.file, { fileMustExist: true });
  const h: Handle = { db, role, generation: 0, transaction: null, step: null, closeAttempted: false, closeReturned: false };
  s.handles.push(h);
  if (role === "B") s.B = h; else if (role === "birth-C") s.birthC = h; else s.endC = h;
  db.defaultSafeIntegers(true); db.pragma("foreign_keys=ON"); db.pragma("recursive_triggers=ON");
  db.function(SQLITE_PROFILE_UDF_ABI.format.name, SQLITE_PROFILE_UDF_ABI.format.options,
    function (table: unknown, event: unknown, databaseInstanceId: unknown, fenceEpoch: unknown, guardManifestDigest: unknown, writerFormatDigest: unknown) {
      return formatAllowed(s, h, table, event, databaseInstanceId, fenceEpoch, guardManifestDigest, writerFormatDigest) ? 1 : 0;
    });
  db.function(SQLITE_PROFILE_UDF_ABI.row.name, SQLITE_PROFILE_UDF_ABI.row.options,
    (...args: unknown[]) => rowAllowed(s, h, args) ? 1 : 0);
  return h;
}
function closeHandle(s: Owner, h: Handle): void {
  if (h.closeReturned) return;
  if (h.closeAttempted) stop("native_retirement_unknown");
  h.step = null; h.generation++;
  if (h.transaction) { h.transaction.active = false; h.transaction.executing = false; }
  h.closeAttempted = true;
  try {
    h.db.close();
    if (h.db.open) stop("native_retirement_unknown");
    h.closeReturned = true;
  } catch (error) { uncertain(s, `${h.role}-close`, error); stop("native_retirement_unknown"); }
}
function settleFiles(s: Owner): void {
  if (s.uncertain || s.handles.some(h => !h.closeReturned)) stop("native_retirement_unknown");
  if (s.pinFd !== null && !s.pinCloseReturned) {
    if (s.pinCloseAttempted) stop("native_retirement_unknown");
    s.pinCloseAttempted = true;
    try { closeSync(s.pinFd); s.pinCloseReturned = true; }
    catch (error) { uncertain(s, "source-pin-close", error); stop("native_retirement_unknown"); }
  }
  try {
    if (s.directory) {
      const stat = lstatSync(s.directory, { bigint: true });
      if (!stat.isDirectory() || (s.directoryIdentity && (stat.dev !== s.directoryIdentity.device || stat.ino !== s.directoryIdentity.inode))) stop("source_changed");
    }
    if (s.file && s.identity) {
      const stat = lstatSync(s.file, { bigint: true });
      if (!stat.isFile() || String(stat.dev) !== s.identity.device || String(stat.ino) !== s.identity.inode || stat.nlink !== 1n) stop("source_changed");
      unlinkSync(s.file);
    }
    if (s.directory) rmdirSync(s.directory); // No recursive removal, guessed sidecars or external paths.
    s.phase = "retired"; pendingOwners.delete(s);
  } catch (error) { uncertain(s, "isolated-files-retirement", error); stop("native_retirement_unknown"); }
}
function abandon(owner: object): void {
  const s = owners.get(owner);
  if (!s || s.phase === "retired" || s.uncertain) return;
  s.phase = "failed";
  for (const h of s.handles) closeHandle(s, h);
  settleFiles(s);
}
function createOwner(r: AuditRequest): object {
  // Reserve fixed identity/native resource/failure and eventual filesystem-retirement producers first.
  r.allocateNodes(512); r.units(2048); r.text(16 * 1024, 4);
  const owner = Object.freeze({});
  const s: Owner = { request: r, clientId: randomUUID(), processInstanceId: randomUUID(), connectionId: randomUUID(),
    databaseInstanceId: randomUUID(), failures: [], handles: [], counters: { committed: 0, rolledBack: 0, notAdmitted: 0 },
    phase: "opening", directory: null, file: null, directoryIdentity: null, pinFd: null, pinCloseAttempted: false,
    pinCloseReturned: false, identity: null, B: null, birthC: null, endC: null, control: null, birth: null,
    plannedBirth: null, ended: null, plannedEnd: null, rawProduced: 0, uncertain: false, hostJson: "", processJson: "" };
  owners.set(owner, s);
  try {
    const temporary = tmpdir(); r.require(temporary.length <= 4096, "resource_limit");
    s.directory = mkdtempSync(path.join(temporary, "boardroom-cf17-i04-"));
    s.directory = realpathSync(s.directory);
    const directory = lstatSync(s.directory, { bigint: true });
    s.directoryIdentity = { device: directory.dev, inode: directory.ino };
    s.file = path.join(s.directory, "owned.sqlite");
    s.pinFd = openSync(s.file, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    const pin = fstatSync(s.pinFd, { bigint: true }); s.identity = { device: String(pin.dev), inode: String(pin.ino) };
    const host = hostname(); r.require(host.length <= 255, "resource_limit");
    s.hostJson = canonical({ version: 1, hostname: host }, r);
    // Actual local process identity, with its original limited verification spelling. No CF03/native inventory claim.
    s.processJson = canonical({ version: 1, platform: process.platform, pid: process.pid,
      instanceId: s.processInstanceId, verification: "process_local_only" }, r);
    const B = openHandle(s, "B", r);
    r.allocateNodes(112); r.text(FIXTURE_SCHEMA.length + FIXTURE_CONTROL_GUARDS.length + FIXTURE_CONTROL_INSERT.length
      + CLIENT_GUARDS.reduce((n, g) => n + g.bytes, 0), 5);
    B.db.exec(FIXTURE_SCHEMA);
    s.control = snapshot(1n, [1n, s.databaseInstanceId, null, null, 0n, "open", null, null, 0n, null, null, 0n, 2n, FIXTURE_GUARD, null], r);
    B.db.prepare(FIXTURE_CONTROL_INSERT).run(...s.control.cells);
    B.db.exec(FIXTURE_CONTROL_GUARDS);
    for (const guard of CLIENT_GUARDS) B.db.exec(guard.sql);
    source(s, r);
    return owner;
  } catch (error) {
    recordFailure(s, "create", error);
    abandon(owner); throw error;
  }
}
function sessions(s: Owner, closed: boolean, r: AuditRequest): string {
  r.allocateNodes(32);
  return canonical({ formatVersion: 1, sourceIdentity: { kind: "sqlite", sourcePath: s.file,
    sqlitePath: s.file, ...s.identity }, sessions: [{ kind: "sqlite", owner: "native-management",
    connectionId: s.connectionId, state: closed ? "closed" : "open",
    nativeTransactions: closed ? { ...s.counters } : { committed: 0, rolledBack: 0, notAdmitted: 0 } }], drainReceipt: null }, r);
}
function nextRowid(h: Handle, r: AuditRequest): bigint {
  const sql = SQL["C-NEXT-ROWID"]!; reserveQuery(sql, 1, r);
  const row = h.db.prepare(sql).get() as { maximum: bigint | null };
  if (row.maximum === null || (typeof row.maximum === "bigint" && row.maximum < 1n)) return 1n;
  if (typeof row.maximum !== "bigint" || row.maximum >= MAX_ROWID) stop("rowid_exhausted");
  return row.maximum + 1n;
}
function executeStep(s: Owner, h: Handle, t: Transaction, before: RawRow | null, after: RawRow, r: AuditRequest): void {
  try {
    current(s, h, t);
    if (t.executing || h.step !== null) stop("owner_reentry");
    r.allocateNodes(160); r.text(after.cells.reduce<number>((n, c) => n + cellBytes(c), 0)
      + (before?.cells.reduce<number>((n, c) => n + cellBytes(c), 0) ?? 0), 8);
    const sql = SQL[before === null ? "C-BIRTH" : "C-NATIVE-END-OPEN"]!; reserveQuery(sql, 38, r);
    // Native format's six arguments/subqueries and both pure L/T/O predicates compare the full frozen control/plan.
    r.allocateNodes(48); r.text(t.control!.cells.reduce<number>((n, c) => n + cellBytes(c), 0) + 128, 8);
    const old = before === null ? Object.freeze(Array<Cell>(17).fill(null)) : snapshot(before.rowid, before.cells, r).cells;
    const next = snapshot(after.rowid, after.cells, r).cells;
    let parameters: Record<string, Cell> | undefined;
    if (before) {
      parameters = { oldRowid: before.rowid };
      for (let i = 0; i < 17; i++) { parameters[`t${i}`] = before.types[i]!; parameters[`v${i}`] = before.cells[i]!; }
      for (const i of [7, 9, 10, 11, 12, 14, 15]) parameters[`new_${CLIENT_COLUMNS[i]!.name}`] = after.cells[i]!;
    }
    current(s, h, t);
    h.step = Object.freeze({ transaction: t, event: before === null ? "insert" : "update", oldRowid: before?.rowid ?? null,
      newRowid: after.rowid, before: old, after: next }); t.executing = true;
    const statement = h.db.prepare(sql), result = parameters ? statement.run(parameters) : statement.run(after.rowid, ...after.cells);
    if (result.changes !== 1) stop("step_mismatch");
    current(s, h, t);
  } catch (error) { t.failed = true; recordFailure(s, "step", error); throw error; }
  finally { h.step = null; t.executing = false; }
}
function birthProgram(s: Owner, h: Handle, t: Transaction, r: AuditRequest): RawRow {
  window(s, h, t, r);
  const before = readRows(s, h, CLIENTS, r);
  for (const row of before) {
    const encoded = row.cells[6];
    if (row.cells[0] === s.clientId || typeof encoded !== "string") stop("step_mismatch");
    // Parse/canonical allocation is bounded before JSON.parse; canonical equality also rejects duplicate keys.
    r.allocateNodes(encoded.length + 4); r.text(encoded.length * 3, 5);
    const processIdentity: unknown = JSON.parse(encoded);
    if (canonical(processIdentity, r) !== encoded || processIdentity === null || typeof processIdentity !== "object"
      || Array.isArray(processIdentity) || (processIdentity as Record<string, unknown>).instanceId === s.processInstanceId) stop("step_mismatch");
  }
  const rowid = nextRowid(h, r); r.allocateNodes(4); r.text(64, 3);
  const now = new Date().toISOString(), epoch = t.control!.cells[4]!;
  const after = snapshot(rowid, [s.clientId, s.databaseInstanceId, "local-management", "boardroom-native-management-v1", 2n,
    s.hostJson, s.processJson, sessions(s, false, r), epoch, epoch, null, "none", null, now, now, null, FIXTURE_WRITER], r);
  s.plannedBirth = after;
  executeStep(s, h, t, null, after, r);
  const readback = readRows(s, h, CLIENTS, r);
  if (readback.length !== before.length + 1 || !sameRow(after, readback.find(row => row.rowid === rowid))
    || before.some(row => !sameRow(row, readback.find(after => after.rowid === row.rowid)))) stop("step_mismatch");
  window(s, h, t, r); return after;
}
function endProgram(s: Owner, h: Handle, t: Transaction, r: AuditRequest): RawRow {
  if (!s.B?.closeReturned || s.B.db.open || !s.birth || s.phase !== "retiring") stop("owner_not_live");
  window(s, h, t, r);
  const rows = readRows(s, h, CLIENTS, r), before = rows.find(row => row.cells[0] === s.clientId);
  if (!sameRow(s.birth, before)) stop("step_mismatch");
  r.allocateNodes(24); r.text(64, 3);
  const cells = [...before!.cells], now = new Date().toISOString();
  cells[7] = sessions(s, true, r); cells[9] = t.control!.cells[4]!;
  cells[10] = null; cells[11] = "none"; cells[12] = null; cells[14] = now; cells[15] = now;
  const after = snapshot(before!.rowid, cells, r);
  s.plannedEnd = after;
  executeStep(s, h, t, before!, after, r);
  const readback = readRows(s, h, CLIENTS, r);
  if (readback.length !== rows.length || !sameRow(after, readback.find(row => row.rowid === after.rowid))
    || rows.some(row => row.rowid !== after.rowid && !sameRow(row, readback.find(after => after.rowid === row.rowid)))) stop("step_mismatch");
  window(s, h, t, r); return after;
}
function transact(s: Owner, h: Handle, program: Program, terminal: "commit" | "rollback", r: AuditRequest): RawRow | null {
  if (h.transaction) { h.transaction.failed = true; stop("owner_reentry"); }
  if (h.closeAttempted || !h.db.open || h.db.inTransaction || s.uncertain) stop("owner_not_live");
  r.allocateNodes(32); r.units(192); r.text(512, 4); // Includes rollback on any later failure.
  r.require(h.generation < Number.MAX_SAFE_INTEGER, "resource_limit");
  const t: Transaction = { handle: h, generation: ++h.generation, program, active: true, executing: false,
    failed: false, admitted: false, outcome: "starting", control: null };
  h.transaction = t;
  try {
    h.db.exec(SQL["C-BEGIN"]!); t.outcome = "active";
    let after: RawRow | null;
    if (program === "birth") after = birthProgram(s, h, t, r);
    else if (program === "end-open") after = endProgram(s, h, t, r);
    else {
      window(s, h, t, r); ownRow(s, h, t, r); t.admitted = true;
      // This finite component performs no business DML. Its actual B transaction still verifies its own row twice.
      window(s, h, t, r); ownRow(s, h, t, r); after = null;
    }
    current(s, h, t); h.step = null; t.active = false;
    try {
      h.db.exec(SQL[terminal === "commit" ? "C-COMMIT" : "C-ROLLBACK"]!);
      if (h.db.inTransaction) stop("transaction_unknown");
      t.outcome = terminal === "commit" ? "committed" : "rolled-back";
    } catch (error) { t.outcome = "unknown"; uncertain(s, `${h.role}-${terminal}`, error); stop("transaction_unknown"); }
    if (program === "observe") s.counters[terminal === "commit" ? "committed" : "rolledBack"]++;
    return after;
  } catch (error) {
    t.failed = true; t.active = false; t.executing = false; h.step = null;
    recordFailure(s, `${h.role}-transaction`, error);
    if (t.outcome !== "unknown") {
      try {
        if (h.db.inTransaction) { h.db.exec(SQL["C-ROLLBACK"]!); if (h.db.inTransaction) stop("transaction_unknown"); }
        t.outcome = "rolled-back";
        if (program === "observe") s.counters[t.admitted ? "rolledBack" : "notAdmitted"]++;
      } catch (rollbackError) { t.outcome = "unknown"; uncertain(s, `${h.role}-rollback`, rollbackError); stop("transaction_unknown"); }
      s.phase = "failed";
    }
    throw error;
  } finally {
    h.step = null; t.active = false; t.executing = false;
    if (t.outcome !== "unknown") h.transaction = null;
  }
}
function register(owner: object, r: AuditRequest): void {
  const s = requireOwner(owner, r);
  if (s.phase !== "opening" || s.birthC || s.birth || !s.B || s.B.transaction) stop("owner_not_live");
  const C = openHandle(s, "birth-C", r);
  s.birth = transact(s, C, "birth", "commit", r);
  closeHandle(s, C); // Known birth commit alone does not release B.
  s.phase = "live";
}
function runObservation(owner: object, terminal: "commit" | "rollback", r: AuditRequest): void {
  const s = requireOwner(owner, r);
  if (s.phase !== "live" || !s.B || !s.birthC?.closeReturned || !s.birth) stop("owner_not_live");
  transact(s, s.B, "observe", terminal, r);
}
function end(owner: object, r: AuditRequest): void {
  const s = requireOwner(owner, r);
  if (s.phase !== "live" || !s.B || s.B.transaction || !s.birthC?.closeReturned) stop("owner_not_live");
  s.phase = "retiring";
  closeHandle(s, s.B); // Revoke and physically close B before opening C or planning an ended row.
  const C = openHandle(s, "end-C", r);
  s.ended = transact(s, C, "end-open", "commit", r);
  closeHandle(s, C);
  settleFiles(s);
}
function wire(row: RawRow, r: AuditRequest): { rowid: string; cells: WireCell[] } {
  r.allocateNodes(row.cells.length * 4 + 4); r.text(row.cells.reduce<number>((n, c) => n + cellBytes(c), 0) + 24, 5);
  return { rowid: String(row.rowid), cells: row.cells.map((value): WireCell => {
    if (value === null) return ["null"];
    if (typeof value === "bigint") return ["integer", String(value)];
    if (typeof value === "number") { const bytes = Buffer.alloc(8); bytes.writeDoubleBE(value); return ["real64be", bytes.toString("hex")]; }
    return [typeof value === "string" ? "text" : "blob", Buffer.from(value).toString("hex")];
  }) };
}

/** 零参数、detached 的有限机制观察；不返回 owner/handle/permit，也不选择已有源。 */
export function inspectIsolatedSqliteProfileClientLifecycle() {
  if (arguments.length !== 0) return Object.freeze({ ok: false as const, error: Object.freeze({ code: "unsupported_shape" as const }) });
  let specific: Code | undefined;
  const result = boundary("null", (_value, r) => {
    let owner: object | undefined;
    try {
      owner = createOwner(r);
      register(owner, r);
      runObservation(owner, "rollback", r);
      runObservation(owner, "commit", r);
      end(owner, r);
      const s = owners.get(owner)!;
      const outputBound = 512 + s.birth!.cells.reduce<number>((n, c) => n + cellBytes(c) * 2 + 32, 0)
        + s.ended!.cells.reduce<number>((n, c) => n + cellBytes(c) * 2 + 32, 0);
      r.reserveOutput(outputBound);
      r.allocateNodes(16); const birth = wire(s.birth!, r), ended = wire(s.ended!, r);
      const value = { scope: "isolated-sqlite-native-management-lifecycle" as const,
        qualification: "component-only; not-P1-admission" as const, birth, ended,
        transactions: { ...s.counters }, retirement: "closed" as const };
      return value;
    } catch (error) {
      const audit = error !== null && (typeof error === "object" || typeof error === "function") && r.failures.has(error);
      specific = kernelCode(error) ?? (audit ? undefined : "native_failure"); throw error;
    }
    finally { if (owner) try { abandon(owner); } catch (error) { specific = kernelCode(error); throw error; } }
  });
  if (result.ok) return result;
  return Object.freeze({ ok: false as const, error: Object.freeze({ code: specific ?? result.error.code }) });
}

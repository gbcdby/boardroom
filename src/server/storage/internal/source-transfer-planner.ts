/** SRC-I1a：完整 SQLite typed frame 的有界纯值规划。不能执行、准入或发布许可。 */
import { boundary, record, encoding, AuditRequest, AUDIT_LIMITS } from "../../identity/internal/m2-audit-boundary.ts";
import type { AuditResult } from "../../identity/internal/m2-audit-boundary.ts";
import { M2_HISTORY_TABLES } from "../../identity/m2-history-contracts.ts";
import type { RawCell } from "../../identity/m2-history-contracts.ts";
import type { SourceRef } from "../../identity/m2-value-contracts.ts";
import { SQLITE_PROFILE_TABLE_RULES } from "./sqlite-profile-rules.ts";
import { SOURCE_TRANSFER_STRUCTURE, SOURCE_TRANSFER_UNCHANGED, SOURCE_TRANSFER_HISTORY,
  SOURCE_TRANSFER_REPLACE, SOURCE_TRANSFER_DELETE_ORDER, SOURCE_TRANSFER_INSERT_ORDER,
  SOURCE_TRANSFER_UNIQUES, SOURCE_TRANSFER_FOREIGN_KEYS, SOURCE_TRANSFER_TRIGGERS } from "./source-transfer-catalog.ts";
import type { TransferUnique } from "./source-transfer-catalog.ts";

export type TransferRow = { rowid: string; cells: RawCell[] };
export type TransferTable = { name: string; columns: string[]; count: string; rows: TransferRow[] };
export type TransferFrame = { source: SourceRef; textEncoding: { backend: "sqlite"; name: "UTF-8" }; tables: TransferTable[] };
export type SourceTransferInput = { contract: "m2-src-transfer-values/v1"; operation: "replace" | "clear";
  source: TransferFrame | null; target: TransferFrame };
type NativeRowid = { kind: "native-rowid-readback"; memberId: RawCell; factKind: RawCell };
type PlannedRow = { rowid: string | NativeRowid; cells: RawCell[] };
type Effect = { trigger: string; table: "member_fact_revisions"; event: "insert" | "update";
  before: PlannedRow | null; after: PlannedRow };
type Phase = "append-history" | "delete-replaced" | "insert-replaced" | "delete-provisional-facts" | "restore-source-facts";
type Step = { ordinal: number; phase: Phase; table: string; event: "insert" | "delete";
  before: PlannedRow | null; after: PlannedRow | null; effects: Effect[] };
type Requirement = { frame: "source" | "target"; table: string; rowid: string; primaryKey: RawCell[];
  kind: "evidence-ref" | "strict-m2-row-and-artifact-refs" | "strict-audit-history";
  column: string | null; value: RawCell | null };
type Charges = { scope: "planner-additions-on-shared-C2-ledger"; workUnits: number; characterPassBytes: number;
  allocatedNodes: number; outputBytesReserved: number; sourceRows: number; targetRows: number; steps: number; triggerEffects: number };
type Plan = { classification: "pure-value-plan"; contract: "m2-src-transfer-plan/v1"; operation: "replace" | "clear";
  source: TransferFrame | null; before: TransferFrame; after: TransferFrame;
  stableBefore: TransferTable[]; stableAfter: TransferTable[]; steps: Step[]; artifactRequirements: Requirement[];
  requirementCoverage: "direct-ref-columns-and-strict-row-locations; transitive-extraction-pending";
  structure: typeof SOURCE_TRANSFER_STRUCTURE;
  policies: { replace: typeof SOURCE_TRANSFER_REPLACE; historyUnion: typeof SOURCE_TRANSFER_HISTORY; unchanged: typeof SOURCE_TRANSFER_UNCHANGED };
  constraints: { uniques: typeof SOURCE_TRANSFER_UNIQUES; foreignKeys: typeof SOURCE_TRANSFER_FOREIGN_KEYS };
  triggers: { name: string; table: string; event: string; sha256: string; invocations: number; disposition: string }[];
  charges: Charges; remainingChecks: readonly string[] };

const REMAINING = Object.freeze(["strict-domain-and-CHECK-semantics", "artifact-bytes-and-retained-reference-closure",
  "source-and-target-own-authority-terminal-and-journal", "target-current-runtime-and-CF17", "source-current-runtime-and-CF17",
  "physical-source-and-full-native-catalog", "lossless-native-read-and-bind", "provisional-native-rowid-readback",
  "accepted-SRC-I0-and-final-G1-owner-assembly", "same-handle-native-window-and-all-readback", "native-commit-rollback-and-close"]);
const MIN64 = -9223372036854775808n, MAX64 = 9223372036854775807n, MAX_FACT = 9007199254740991n;
const KINDS = Object.freeze(["authored-messages", "deliveries", "memory-requests", "memory-receipts", "memory-counters", "memory-checkpoints"]);
// Fixed trigger literals are encoded once, outside any request-dependent walk.
const kindCells = new Map(KINDS.map(kind => { const c: RawCell = ["text", Buffer.from(kind).toString("hex")]; Object.freeze(c); return [kind, c] as const; }));
const FACT_EVENTS: Readonly<Record<string, { kind: string; member: string | null }>> = Object.freeze({
  messages: { kind: "authored-messages", member: "sender_member_id" },
  message_deliveries: { kind: "deliveries", member: "member_id" },
  memory_summary_requests: { kind: "memory-requests", member: "recipient_member_id" },
  memory_message_receipts: { kind: "memory-receipts", member: null },
  memory_trigger_counters: { kind: "memory-counters", member: null },
  memory_scan_checkpoints: { kind: "memory-checkpoints", member: null },
});
const unchanged = new Set<string>(SOURCE_TRANSFER_UNCHANGED), history = new Set<string>(SOURCE_TRANSFER_HISTORY);
const rules = new Map(SQLITE_PROFILE_TABLE_RULES.map(t => [t.table, t]));
const columns = new Map(M2_HISTORY_TABLES.map(t => [t.name, new Map(t.columnsP1.map((c, i) => [c.name, i]))]));
const contracts = new Map(M2_HISTORY_TABLES.map(t => [t.name, t]));
const uniques = new Map(M2_HISTORY_TABLES.map(t => [t.name, SOURCE_TRANSFER_UNIQUES.filter(u => u.table === t.name)]));
const selfReferences = new Map(SOURCE_TRANSFER_FOREIGN_KEYS.filter(f => !f.deferred && f.sourceTable === f.targetTable).map(f => [f.sourceTable, f]));
// Static compile-time sources only. No caller catalog, predicate, comparator or SQL.
if (SOURCE_TRANSFER_REPLACE.length !== 65 || SOURCE_TRANSFER_HISTORY.length !== 3 || SOURCE_TRANSFER_UNCHANGED.length !== 4
  || new Set([...SOURCE_TRANSFER_REPLACE, ...SOURCE_TRANSFER_HISTORY, ...SOURCE_TRANSFER_UNCHANGED]).size !== 72) throw new Error("SRC fixed partition drift");
for (const t of M2_HISTORY_TABLES) {
  const original = rules.get(t.name);
  if (!original || original.columns.length !== t.columnsP1.length || original.columns.some((c, i) =>
    c.name !== t.columnsP1[i]!.name || c.type !== t.columnsP1[i]!.sqliteDeclaredType)) throw new Error("SRC fixed column source drift");
}
for (const f of SOURCE_TRANSFER_FOREIGN_KEYS) {
  if (f.deferred && f.onDelete !== "NO ACTION") throw new Error("SRC unexpected deferred action");
  if (f.sourceTable === f.targetTable || f.deferred) continue;
  const child = SOURCE_TRANSFER_INSERT_ORDER.indexOf(f.sourceTable as typeof SOURCE_TRANSFER_INSERT_ORDER[number]);
  const parent = SOURCE_TRANSFER_INSERT_ORDER.indexOf(f.targetTable as typeof SOURCE_TRANSFER_INSERT_ORDER[number]);
  if (child >= 0 && parent >= 0 && parent >= child) throw new Error("SRC immediate insertion order drift");
  if (child >= 0 && parent >= 0 && SOURCE_TRANSFER_DELETE_ORDER.indexOf(f.sourceTable as typeof SOURCE_TRANSFER_DELETE_ORDER[number])
    >= SOURCE_TRANSFER_DELETE_ORDER.indexOf(f.targetTable as typeof SOURCE_TRANSFER_DELETE_ORDER[number])) throw new Error("SRC immediate deletion order drift");
  if (child < 0 && parent >= 0) throw new Error("SRC preserved child references replaced parent");
}

/** All work below is additional to, and consumes, the SAME original C2 ledger.
 * Its boundary parse/freeze/serialization and hex/decode costs remain charged by C2;
 * the public receipt deliberately does not claim to expose its private counters. */
class Meter {
  readonly r: AuditRequest;
  readonly charges: Charges = { scope: "planner-additions-on-shared-C2-ledger", workUnits: 0, characterPassBytes: 0,
    allocatedNodes: 0, outputBytesReserved: 0, sourceRows: 0, targetRows: 0, steps: 0, triggerEffects: 0 };
  constructor(r: AuditRequest) { this.r = r; }
  work(n: number): void { this.r.units(n); this.charges.workUnits += n; }
  text(n: number, passes = 1): void { this.r.text(n, passes); this.charges.characterPassBytes += n * passes; }
  nodes(n: number): void { this.r.allocateNodes(n); this.charges.allocatedNodes += n; }
  output(value: unknown): void {
    const measured = this.r.measure(value, AUDIT_LIMITS.output);
    this.r.reserveOutput(measured.bytes); this.charges.outputBytesReserved += measured.bytes;
    // Prepay both later serialization and freeze walks of this occurrence, even
    // when immutable raw cells are shared between multiple returned projections.
    this.text(measured.bytes, 2); this.work(measured.nodes);
  }
  outputItem(value: unknown): void {
    this.output(value); this.r.reserveOutput(1); this.charges.outputBytesReserved++; // Array delimiter, before push.
  }
  key(value: unknown): string { return this.r.stringify(value, AUDIT_LIMITS.input); }
  compare(a: string, b: string): number { this.work(1); this.text(a.length + b.length); return a < b ? -1 : a > b ? 1 : 0; }
}
function array(value: unknown, m: Meter): unknown[] { m.r.require(Array.isArray(value), "unsupported_shape"); return value; }
function decimal(value: unknown, m: Meter): string {
  m.r.require(typeof value === "string" && value.length <= 20); m.text(value.length);
  m.r.require(/^(0|-?[1-9][0-9]*)$/.test(value)); m.work(2);
  const n = BigInt(value); m.r.require(n >= MIN64 && n <= MAX64); return value;
}
function digest(value: unknown, length: number, m: Meter): string {
  m.r.require(typeof value === "string" && value.length === length); m.text(length);
  m.r.require(/^[0-9a-f]+$/.test(value)); return value;
}
function cell(value: unknown, m: Meter): RawCell {
  const v = array(value, m);
  if (v[0] === "null") m.r.require(v.length === 1);
  else {
    m.r.require(v.length === 2);
    if (v[0] === "integer") decimal(v[1], m);
    else if (v[0] === "text") m.r.decodeText(m.r.hex(v[1]));
    else if (v[0] === "blob") m.r.hex(v[1]);
    else if (v[0] === "real64be") {
      const hex = m.r.hex(v[1], 8); m.work(1); m.text(8, 2);
      m.r.require(Number.isFinite(Buffer.from(hex, "hex").readDoubleBE()), "unsupported_shape");
    } else m.r.fail("unsupported_shape");
  }
  return v as RawCell;
}
function col(row: PlannedRow, table: string, name: string): RawCell { return row.cells[columns.get(table)!.get(name)!]!; }
function rawText(c: RawCell, m: Meter): string {
  m.r.require(c[0] === "text", "unsupported_shape"); return m.r.decodeText(c[1]);
}
function integer(c: RawCell, m: Meter): bigint {
  m.r.require(c[0] === "integer", "unsupported_shape"); m.work(1); return BigInt(c[1]);
}
function sameCells(a: readonly RawCell[], b: readonly RawCell[], m: Meter): boolean {
  m.work(a.length + b.length); if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = b[i]!;
    if (x.length !== y.length) return false;
    for (let j = 0; j < x.length; j++) {
      m.text(String(x[j]).length + String(y[j]).length);
      if (x[j] !== y[j]) return false;
    }
  }
  return true;
}
function tuple(row: PlannedRow, table: string, names: readonly string[], m: Meter): RawCell[] {
  m.nodes(names.length + 1); m.work(names.length); return names.map(name => col(row, table, name));
}
function typedKey(row: PlannedRow, table: string, m: Meter): string {
  return m.key(tuple(row, table, contracts.get(table)!.primaryKey, m));
}
// BINARY collation, with exact INTEGER/REAL equality. No Number(int64) rounding.
// A TEXT-affinity numeric key or INTEGER-affinity text key is outside this finite
// component's comparison domain; never silently equate it using an incomplete cast.
function sqlKey(row: PlannedRow, table: string, names: readonly string[], m: Meter): string | null {
  m.nodes(names.length + 1); const parts: string[] = [];
  for (const name of names) {
    m.work(1); const c = col(row, table, name), declared = rules.get(table)!.columns[columns.get(table)!.get(name)!]!.type;
    if (c[0] === "null") return null;
    if (c[0] === "blob") { m.text(c[1].length); parts.push("b:" + c[1]); }
    else if (declared === "TEXT") {
      m.r.require(c[0] === "text", "unsupported_shape"); m.text(c[1].length); parts.push("t:" + c[1]);
    } else if (c[0] === "integer") { m.text(c[1].length); parts.push("n:" + c[1]); }
    else if (c[0] === "real64be") {
      m.text(320, 2); m.work(2); const n = Buffer.from(c[1], "hex").readDoubleBE();
      parts.push(Number.isInteger(n) ? "n:" + BigInt(n).toString() : "r:" + n.toString());
    } else m.r.fail("unsupported_shape");
  }
  return m.key(parts);
}
function qualifies(row: TransferRow, unique: TransferUnique, m: Meter): boolean {
  const p = unique.where; if (!p) return true;
  m.work(1); const c = col(row, unique.table, p.column);
  if (p.kind === "null") return c[0] === "null";
  if (p.kind === "not-null") return c[0] !== "null";
  if (c[0] === "null" || c[0] === "blob") return false;
  return rawText(c, m) === p.value;
}
function ordered(rows: readonly TransferRow[], table: string, m: Meter): TransferRow[] {
  m.nodes(rows.length * 5 + 3); m.work(rows.length);
  const keyed = rows.map(row => ({ row, key: typedKey(row, table, m) }));
  keyed.sort((a, b) => m.compare(a.key, b.key));
  return keyed.map(v => v.row);
}
function validateTable(t: TransferTable, m: Meter): void {
  const pk = contracts.get(t.name)!.primaryKey;
  const uniqueCount = uniques.get(t.name)!.length;
  m.nodes(t.rows.length * (4 + uniqueCount * 2) + uniqueCount + 3);
  const ids = new Set<string>(), keys = new Set<string>();
  for (const row of t.rows) {
    m.work(2); m.text(row.rowid.length);
    m.r.require(!ids.has(row.rowid), "semantic_invariant_failed", "duplicate-key"); ids.add(row.rowid);
    const key = sqlKey(row, t.name, pk, m);
    m.r.require(key !== null, "unsupported_shape");
    m.r.require(!keys.has(key), "semantic_invariant_failed", "duplicate-key"); keys.add(key);
  }
  for (const u of uniques.get(t.name)!) {
    const seen = new Set<string>();
    for (const row of t.rows) {
      m.work(1); if (!qualifies(row, u, m)) continue;
      const key = sqlKey(row, t.name, u.columns, m); if (key === null) continue;
      m.r.require(!seen.has(key), "semantic_invariant_failed", "duplicate-key"); seen.add(key);
    }
  }
}
function parseFrame(value: unknown, role: "source" | "target", m: Meter): TransferFrame {
  const f = record(value, ["source", "textEncoding", "tables"], m.r);
  const s = record(f.source, ["kind", "databaseInstanceId", "identityDigest"], m.r);
  m.r.require(s.kind === "sqlite", "unsupported_shape"); encoding(f.textEncoding, "sqlite", m.r);
  m.nodes(3);
  const source: SourceRef = { kind: "sqlite", databaseInstanceId: digest(s.databaseInstanceId, 32, m), identityDigest: digest(s.identityDigest, 64, m) };
  const values = array(f.tables, m); m.r.require(values.length === 72, "source_contract_mismatch");
  m.nodes(values.length * 3 + 1); const tables: TransferTable[] = [];
  for (const [i, v] of values.entries()) {
    const d = M2_HISTORY_TABLES[i]!, t = record(v, ["name", "columns", "count", "rows"], m.r);
    m.r.require(t.name === d.name, "source_contract_mismatch"); const cs = array(t.columns, m);
    m.work(cs.length); m.r.require(cs.length === d.columnsP1.length && cs.every((c, j) => c === d.columnsP1[j]!.name), "source_contract_mismatch");
    const inputRows = array(t.rows, m); m.r.rowCount(inputRows.length);
    m.r.require(typeof t.count === "string" && /^(0|[1-9][0-9]{0,5})$/.test(t.count));
    m.r.require(t.count === String(inputRows.length), "semantic_invariant_failed", "count-mismatch");
    m.charges[role === "source" ? "sourceRows" : "targetRows"] += inputRows.length;
    m.nodes(inputRows.length * 2 + 1); const rows: TransferRow[] = [];
    for (const v of inputRows) {
      const row = record(v, ["rowid", "cells"], m.r), id = decimal(row.rowid, m), cells = array(row.cells, m);
      m.r.require(cells.length === cs.length, "source_contract_mismatch");
      for (const [index, raw] of cells.entries()) {
        const c = cell(raw, m); m.work(1);
        m.r.require(c[0] !== "null" || rules.get(d.name)!.columns[index]!.notnull === 0, "semantic_invariant_failed");
      }
      const parsed: TransferRow = { rowid: id, cells: cells as RawCell[] };
      if (d.sqliteRowidAlias !== null) {
        const alias = col(parsed, d.name, d.sqliteRowidAlias);
        m.r.require(alias[0] === "integer" && alias[1] === id, "semantic_invariant_failed");
      }
      rows.push(parsed);
    }
    const parsed: TransferTable = { name: d.name, columns: cs as string[], count: t.count, rows };
    validateTable(parsed, m); tables.push(parsed);
  }
  return { source, textEncoding: { backend: "sqlite", name: "UTF-8" }, tables };
}
function tableMap(frame: TransferFrame, m: Meter): Map<string, TransferTable> {
  m.nodes(frame.tables.length * 3 + 2); m.work(frame.tables.length);
  return new Map(frame.tables.map(t => [t.name, t]));
}
function validateForeignKeys(frame: TransferFrame, m: Meter): void {
  m.nodes(SOURCE_TRANSFER_FOREIGN_KEYS.length * 2 + 1); const tables = tableMap(frame, m), indexes = new Map<string, Set<string>>();
  for (const f of SOURCE_TRANSFER_FOREIGN_KEYS) {
    const cacheKey = f.targetTable + ":" + f.targetColumns.join(","); m.work(1);
    let parent = indexes.get(cacheKey);
    if (!parent) {
      const rows = tables.get(f.targetTable)!.rows; m.nodes(rows.length + 1); parent = new Set<string>();
      for (const row of rows) { const key = sqlKey(row, f.targetTable, f.targetColumns, m); if (key !== null) parent.add(key); }
      indexes.set(cacheKey, parent);
    }
    for (const row of tables.get(f.sourceTable)!.rows) {
      const key = sqlKey(row, f.sourceTable, f.columns, m); m.work(1);
      m.r.require(key === null || parent.has(key), "semantic_invariant_failed", "identity-mismatch");
    }
  }
}
function rowOrder(t: TransferTable, m: Meter, reverse = false): TransferRow[] {
  const sorted = ordered(t.rows, t.name, m), self = selfReferences.get(t.name);
  if (!self) { if (reverse) { m.work(sorted.length); sorted.reverse(); } return sorted; }
  m.nodes(sorted.length * 12 + 10);
  const byKey = new Map<string, TransferRow>(), parents = new Map<TransferRow, TransferRow | null>();
  for (const row of sorted) byKey.set(sqlKey(row, t.name, self.targetColumns, m)!, row);
  for (const row of sorted) {
    const key = sqlKey(row, t.name, self.columns, m);
    const parent = key === null ? null : byKey.get(key);
    m.r.require(parent !== undefined, "semantic_invariant_failed"); parents.set(row, parent);
  }
  const done = new Set<TransferRow>(), visiting = new Set<TransferRow>(), result: TransferRow[] = [];
  for (const row of sorted) {
    const chain: TransferRow[] = []; let at: TransferRow | null = row;
    while (at !== null && !done.has(at)) {
      m.work(2); m.r.require(!visiting.has(at), "semantic_invariant_failed"); visiting.add(at); chain.push(at); at = parents.get(at)!;
    }
    while (chain.length) { m.work(2); const item = chain.pop()!; visiting.delete(item); done.add(item); result.push(item); }
  }
  if (reverse) { m.work(result.length); result.reverse(); } return result;
}
function resulting(source: TransferFrame | null, target: TransferFrame, m: Meter): TransferFrame {
  m.nodes(72 * 6 + 2); const from = source ? tableMap(source, m) : null; const tables: TransferTable[] = [];
  for (const before of target.tables) {
    if (unchanged.has(before.name) || (!source && history.has(before.name))) { tables.push(before); continue; }
    if (!history.has(before.name)) {
      tables.push(source ? from!.get(before.name)! : { name: before.name, columns: before.columns, count: "0", rows: [] }); continue;
    }
    m.nodes(before.rows.length * 6 + from!.get(before.name)!.rows.length * 3 + 8);
    const old = new Map(before.rows.map(row => [sqlKey(row, before.name, contracts.get(before.name)!.primaryKey, m)!, row]));
    const used = new Set(before.rows.map(row => row.rowid)), rows = [...before.rows]; let next = 1n;
    for (const row of ordered(from!.get(before.name)!.rows, before.name, m)) {
      const existing = old.get(sqlKey(row, before.name, contracts.get(before.name)!.primaryKey, m)!);
      if (existing) { m.r.require(sameCells(existing.cells, row.cells, m), "semantic_invariant_failed"); continue; }
      m.text(20); m.work(2); let rowid = next.toString();
      while (used.has(rowid)) { m.text(20); m.work(2); next++; rowid = next.toString(); }
      m.r.require(next <= MAX64, "resource_limit"); m.work(2); m.nodes(3);
      rows.push({ rowid, cells: row.cells }); used.add(rowid); next++;
    }
    const after = { name: before.name, columns: before.columns, count: String(rows.length), rows };
    validateTable(after, m); tables.push(after);
  }
  return { source: target.source, textEncoding: target.textEncoding, tables };
}
function stable(frame: TransferFrame, m: Meter): TransferTable[] {
  m.nodes(72 * 6 + 1); const result: TransferTable[] = [];
  for (const table of frame.tables) if (table.name !== "storage_source_clients") {
    result.push({ name: table.name, columns: table.columns, count: table.count, rows: ordered(table.rows, table.name, m) });
  }
  return result;
}
function facts(frame: TransferFrame, m: Meter): Map<string, PlannedRow> {
  const tables = tableMap(frame, m), members = tables.get("members")!.rows, rows = tables.get("member_fact_revisions")!.rows;
  m.nodes(rows.length * 2 + members.length + 2); const result = new Map<string, PlannedRow>();
  for (const row of rows) {
    const kind = rawText(row.cells[1]!, m), revision = integer(row.cells[2]!, m);
    m.r.require(KINDS.includes(kind) && revision >= 1n && revision <= MAX_FACT, "semantic_invariant_failed");
    result.set(typedKey(row, "member_fact_revisions", m), row);
  }
  m.r.require(rows.length === members.length * 6, "semantic_invariant_failed");
  for (const member of members) for (const kind of KINDS) {
    m.nodes(2); const key = m.key([col(member, "members", "id"), kindCells.get(kind)!]);
    m.r.require(result.has(key), "semantic_invariant_failed");
  }
  return result;
}
function memberGuard(row: TransferRow, m: Meter): void {
  const removed = col(row, "members", "removed_at"); if (removed[0] === "null") return;
  m.r.require(rawText(col(row, "members", "status"), m) === "disabled" && col(row, "members", "node_id")[0] === "null"
    && rawText(col(row, "members", "role"), m) === "normal", "semantic_invariant_failed");
}
function compileSteps(source: TransferFrame | null, target: TransferFrame, after: TransferFrame, m: Meter): { steps: Step[]; counts: Map<string, number> } {
  const beforeTables = tableMap(target, m), afterTables = tableMap(after, m);
  const currentFacts = facts(target, m); if (source) facts(source, m);
  m.nodes(40);
  const counts = new Map<string, number>(), steps: Step[] = [];
  const members = new Map<string, TransferRow>();
  const memberScopes = new Map<string, Set<string>>();
  const memberId = (row: PlannedRow) => m.key(col(row, "members", "id"));
  const scopeKey = (row: PlannedRow, table: string) => m.key(tuple(row, table, ["project_id", "agent_id"], m));
  const addMember = (row: TransferRow) => {
    m.nodes(8); const id = memberId(row); members.set(id, row); const key = scopeKey(row, "members");
    let group = memberScopes.get(key); if (!group) { group = new Set(); memberScopes.set(key, group); } group.add(id);
  };
  for (const row of beforeTables.get("members")!.rows) addMember(row);
  const count = (name: string) => { m.work(1); counts.set(name, (counts.get(name) ?? 0) + 1); };
  const emit = (phase: Phase, table: string, event: "insert" | "delete", row: PlannedRow): void => {
    m.work(1); m.nodes(10); const effects: Effect[] = [];
    if (table === "members") {
      if (event === "insert") {
        memberGuard(row as TransferRow, m); count("member_lifecycle_insert"); addMember(row as TransferRow);
        count("member_facts_initialize");
        for (const kind of KINDS) {
          m.text(kind.length, 3); m.nodes(24); const id = col(row, "members", "id"), factKind = kindCells.get(kind)!;
          const provisional: PlannedRow = { rowid: { kind: "native-rowid-readback", memberId: id, factKind }, cells: [id, factKind, ["integer", "1"]] };
          const key = typedKey(provisional, "member_fact_revisions", m); m.r.require(!currentFacts.has(key), "semantic_invariant_failed");
          currentFacts.set(key, provisional); effects.push({ trigger: "member_facts_initialize", table: "member_fact_revisions", event: "insert", before: null, after: provisional });
        }
      } else {
        const id = memberId(row); members.delete(id); memberScopes.get(scopeKey(row, "members"))!.delete(id);
      }
    }
    if (table === "work_event_delivery_invalidations" && event === "insert") {
      integer(col(row, table, "cause_from_revision"), m); integer(col(row, table, "cause_to_revision"), m); count("work_event_invalidation_integer_guard");
    }
    const fact = FACT_EVENTS[table];
    if (fact) {
      const trigger = "fact_" + table + "_" + event; count(trigger);
      m.nodes(2); const direct = fact.member === null ? null : m.key(col(row, table, fact.member));
      const affected = direct === null ? memberScopes.get(scopeKey(row, table)) ?? new Set<string>() : members.has(direct) ? [direct] : [];
      for (const id of affected) {
        m.work(4); m.nodes(20); m.text(fact.kind.length, 3); m.text(20, 2);
        const member = members.get(id)!, key = m.key([col(member, "members", "id"), kindCells.get(fact.kind)!]);
        const before = currentFacts.get(key); m.r.require(before !== undefined, "semantic_invariant_failed");
        const revision = integer(before.cells[2]!, m); m.r.require(revision < MAX_FACT, "semantic_invariant_failed");
        const changed: PlannedRow = { rowid: before.rowid, cells: [before.cells[0]!, before.cells[1]!, ["integer", (revision + 1n).toString()]] };
        currentFacts.set(key, changed); effects.push({ trigger, table: "member_fact_revisions", event: "update", before, after: changed });
      }
    }
    const step: Step = { ordinal: steps.length + 1, phase, table, event, before: event === "delete" ? row : null,
      after: event === "insert" ? row : null, effects };
    // The effect list is entirely prepaid before it becomes a returned program step.
    m.outputItem(step); m.charges.steps++; m.charges.triggerEffects += effects.length; steps.push(step);
  };
  for (const name of SOURCE_TRANSFER_HISTORY) {
    m.nodes(beforeTables.get(name)!.rows.length * 2 + 2);
    const retained = new Set(beforeTables.get(name)!.rows.map(row => row.rowid));
    for (const row of ordered(afterTables.get(name)!.rows, name, m)) if (!retained.has(row.rowid)) emit("append-history", name, "insert", row);
  }
  for (const name of SOURCE_TRANSFER_DELETE_ORDER) for (const original of rowOrder(beforeTables.get(name)!, m, true)) {
    const key = name === "member_fact_revisions" ? typedKey(original, name, m) : null;
    const row = key === null ? original : currentFacts.get(key)!;
    m.r.require(row !== undefined, "semantic_invariant_failed"); emit("delete-replaced", name, "delete", row);
    if (key !== null) currentFacts.delete(key);
  }
  m.r.require(currentFacts.size === 0 && members.size === 0, "semantic_invariant_failed");
  if (source) for (const name of SOURCE_TRANSFER_INSERT_ORDER) {
    if (name === "member_fact_revisions") {
      m.nodes(currentFacts.size * 2 + 1);
      const provisional = [...currentFacts].sort((a, b) => m.compare(b[0], a[0]));
      for (const [key, row] of provisional) { emit("delete-provisional-facts", name, "delete", row); currentFacts.delete(key); }
    }
    for (const row of rowOrder(afterTables.get(name)!, m)) emit(name === "member_fact_revisions" ? "restore-source-facts" : "insert-replaced", name, "insert", row);
  }
  return { steps, counts };
}
function requirements(source: TransferFrame | null, target: TransferFrame, m: Meter): Requirement[] {
  m.nodes(6);
  const result: Requirement[] = [];
  const reserve = () => { m.r.require(result.length < 2048, "resource_limit"); m.nodes(12); };
  const add = (requirement: Requirement) => { m.outputItem(requirement); result.push(requirement); };
  for (const [origin, frame] of [["source", source], ["target", target]] as const) {
    if (!frame) continue;
    for (const table of frame.tables) for (const row of table.rows) {
      m.work(1); const d = contracts.get(table.name)!;
      if (d.category === "m2-history" || table.name === "audit_log") {
        reserve();
        add({ frame: origin, table: table.name, rowid: row.rowid, primaryKey: tuple(row, table.name, d.primaryKey, m),
          kind: table.name === "audit_log" ? "strict-audit-history" : "strict-m2-row-and-artifact-refs", column: null, value: null });
      }
      for (const name of ["physical_source_ref", "snapshot_receipt_ref", "allowed_delta_ref", "source_to_target_manifest_ref", "source_binding_ref"]) {
        if (!columns.get(table.name)!.has(name)) continue;
        const c = col(row, table.name, name); if (c[0] === "null") continue;
        m.r.require(rawText(c, m).length > 0, "semantic_invariant_failed");
        reserve();
        add({ frame: origin, table: table.name, rowid: row.rowid, primaryKey: tuple(row, table.name, d.primaryKey, m),
          kind: "evidence-ref", column: name, value: c });
      }
    }
  }
  return result;
}

/** Primitive JSON text only. The returned data is never accepted by a native O.
 * An eventual owner must collect current frames itself and close every remaining check. */
export function planSourceTransferValues(input: unknown): AuditResult<Plan> {
  return boundary(input, (value, r: AuditRequest) => {
    const m = new Meter(r), v = record(value, ["contract", "operation", "source", "target"], r);
    r.require(v.contract === "m2-src-transfer-values/v1" && (v.operation === "replace" || v.operation === "clear"), "unsupported_shape");
    r.require(v.operation === "clear" ? v.source === null : v.source !== null, "unsupported_shape");
    const target = parseFrame(v.target, "target", m), source = v.source === null ? null : parseFrame(v.source, "source", m);
    if (source) {
      m.text(192); r.require(source.source.identityDigest !== target.source.identityDigest
        && source.source.databaseInstanceId !== target.source.databaseInstanceId, "source_contract_mismatch");
      validateForeignKeys(source, m);
    }
    validateForeignKeys(target, m); const after = resulting(source, target, m); validateForeignKeys(after, m);
    // Self DAGs are validated even for source/preserved rows with no emitted step.
    for (const frame of source ? [source, target, after] : [target, after]) for (const table of frame.tables) {
      if (selfReferences.has(table.name)) rowOrder(table, m);
    }
    const stableBefore = stable(target, m), stableAfter = stable(after, m);
    for (const frame of [source, target, after, stableBefore, stableAfter]) m.output(frame);
    m.output(SOURCE_TRANSFER_STRUCTURE); m.output(SOURCE_TRANSFER_UNIQUES); m.output(SOURCE_TRANSFER_FOREIGN_KEYS); m.output(REMAINING);
    const policies = { replace: SOURCE_TRANSFER_REPLACE, historyUnion: SOURCE_TRANSFER_HISTORY, unchanged: SOURCE_TRANSFER_UNCHANGED }; m.output(policies);
    const artifactRequirements = requirements(source, target, m), { steps, counts } = compileSteps(source, target, after, m);
    m.nodes(34 * 8 + 1); const triggers = SOURCE_TRANSFER_TRIGGERS.map(t => ({ name: t.name, table: t.table, event: t.event,
      sha256: t.sha256, invocations: counts.get(t.name) ?? 0,
      disposition: t.event === "update" ? "not-triggered-no-primary-update" : t.name.startsWith("fact_") || t.name === "member_facts_initialize"
        ? "exact-fact-effects" : "insert-guard-evaluated" }));
    m.output(triggers); m.r.reserveOutput(4096); m.charges.outputBytesReserved += 4096; m.work(256); m.nodes(32);
    return { classification: "pure-value-plan", contract: "m2-src-transfer-plan/v1", operation: v.operation,
      source, before: target, after, stableBefore, stableAfter, steps, artifactRequirements,
      requirementCoverage: "direct-ref-columns-and-strict-row-locations; transitive-extraction-pending",
      structure: SOURCE_TRANSFER_STRUCTURE, policies, constraints: { uniques: SOURCE_TRANSFER_UNIQUES, foreignKeys: SOURCE_TRANSFER_FOREIGN_KEYS },
      triggers, charges: m.charges, remainingChecks: REMAINING };
  });
}

import { boundary, record, encoding, observeDisplaySyntax, AuditRequest, AUDIT_LIMITS } from "./m2-audit-boundary.ts";
import type { AuditResult, JsonKind } from "./m2-audit-boundary.ts";
import { parseM2Value } from "../m2-value-codecs.ts";
import { M2_HISTORY_TABLES } from "../m2-history-contracts.ts";
import type { RawCell, RawRow, RawTable } from "../m2-history-contracts.ts";
import type { SourceRef, LegacyCaptureBody } from "../m2-value-contracts.ts";

type ChangedSyntaxObservation = { classification: "syntax-observation"; field: "audit_log.changed";
  syntax: "sql-null" | "json" | "invalid-json"; jsonType: JsonKind | null; semanticChecks: "not-performed" };

/** Old display syntax only. Never accepts a row or downgrades registered WE/reversal/M2 semantics. */
export function observeLegacyAuditChangedSyntax(input: unknown): AuditResult<ChangedSyntaxObservation> {
  return boundary(input, (value, r: AuditRequest) => {
    const v = record(value, ["backend", "textEncoding", "cell"], r);
    r.require(v.backend === "sqlite" || v.backend === "postgres", "unsupported_shape");
    encoding(v.textEncoding, v.backend, r);
    r.at("audit_log", null, 10);
    r.require(Array.isArray(v.cell), "unsupported_shape");
    const cell: unknown[] = v.cell;
    const base = { classification: "syntax-observation" as const, field: "audit_log.changed" as const, semanticChecks: "not-performed" as const };
    if (cell[0] === "null") { r.require(cell.length === 1); return { ...base, syntax: "sql-null", jsonType: null }; }
    const sqlite = v.backend === "sqlite";
    r.require(sqlite ? cell.length === 2 && cell[0] === "text" : cell.length === 3 && cell[0] === "pg-binary" && cell[1] === "25", "source_contract_mismatch");
    const text = r.decodeText(r.hex(cell[sqlite ? 1 : 2])), kind = observeDisplaySyntax(text, r);
    return { ...base, syntax: kind === null ? "invalid-json" : "json", jsonType: kind };
  });
}

type Backend = "sqlite" | "postgres";
type TextEncoding = { backend: "sqlite"; name: "UTF-8" } | { backend: "postgres"; name: "UTF8" };
export type TakeoverAuditProjectionInput = {
  seed: { source: SourceRef; planId: string; activationId: string; captureId: string; createdAt: string;
    actor: { kind: "human"; name: string; memberId: null }; agents: { agentId: string; profileRevision: 1; auditId: string }[] };
  capture: LegacyCaptureBody;
  previousAudit: { source: SourceRef; textEncoding: TextEncoding; table: RawTable };
  rowids: { agentId: string; rowid: string | null }[];
};
type Projection = { classification: "projection"; coverage: "takeover-audit-seventeen-columns"; source: SourceRef; captureId: string;
  additions: { table: "audit_log"; columns: string[]; count: string; rows: RawRow[] }; remaining: readonly string[] };
const AUDIT_COLUMNS = M2_HISTORY_TABLES.find(t => t.name === "audit_log")!.columnsP0.map(c => c.name);
const AGENT_COLUMNS = M2_HISTORY_TABLES.find(t => t.name === "agents")!.columnsP0.map(c => c.name);
const REMAINING = Object.freeze(["capture-and-previous-audit-selection-provenance", "complete-before-audit-population",
  "legacy-audit-we-reversal-and-m2-semantics", "full-takeover-seed-and-a-delta", "physical-source-and-writer-transaction"]);

function scalar(value: unknown, r: AuditRequest, minimum = 1): string {
  r.require(typeof value === "string"); r.text(value.length * 3);
  // EG Id/actor.name count Unicode code points, not UTF-16 units; no trim or normalization.
  let count = 0;
  for (let i = 0; i < value.length; i++, count++) if (value.charCodeAt(i) >= 0xd800 && value.charCodeAt(i) <= 0xdbff) i++;
  r.require(count >= minimum && count <= 1024 * 1024);
  return value;
}
function digest(value: unknown, r: AuditRequest, length = 64): string {
  r.require(typeof value === "string"); r.text(value.length);
  r.require(value.length === length && /^[0-9a-f]+$/.test(value)); return value;
}
function source(value: unknown, r: AuditRequest): SourceRef {
  const v = record(value, ["kind", "databaseInstanceId", "identityDigest"], r);
  r.require(v.kind === "sqlite" || v.kind === "postgres", "unsupported_shape");
  return { kind: v.kind, databaseInstanceId: digest(v.databaseInstanceId, r, 32), identityDigest: digest(v.identityDigest, r) };
}
function sameSource(a: SourceRef, b: SourceRef, r: AuditRequest): void {
  r.units(3); r.text(2 * (a.kind.length + a.databaseInstanceId.length + a.identityDigest.length));
  r.require(a.kind === b.kind && a.databaseInstanceId === b.databaseInstanceId && a.identityDigest === b.identityDigest, "source_contract_mismatch");
}
function int64(value: unknown, r: AuditRequest): string {
  r.require(typeof value === "string" && value.length <= 20); r.text(value.length);
  r.require(/^(0|-?[1-9][0-9]*)$/.test(value)); r.units(2);
  const n = BigInt(value);
  r.require(n >= -9223372036854775808n && n <= 9223372036854775807n); return value;
}
function rowid(value: unknown, backend: Backend, r: AuditRequest): string | null {
  if (backend === "postgres") { r.require(value === null, "source_contract_mismatch"); return null; }
  return int64(value, r);
}
function rawCell(value: unknown, backend: Backend, nativeCapture: boolean, r: AuditRequest): readonly unknown[] {
  r.require(Array.isArray(value), "unsupported_shape");
  if (value[0] === "null") { r.require(value.length === 1); return value; }
  if (backend === "postgres" && !nativeCapture) {
    r.require(value.length === 3 && value[0] === "pg-binary" && value[1] === "25", "source_contract_mismatch");
    r.hex(value[2]); return value;
  }
  r.require(value.length === 2);
  if (value[0] === "integer") int64(value[1], r);
  else if (value[0] === "text" || value[0] === "blob") r.hex(value[1]);
  else if (value[0] === "real64be") r.hex(value[1], 8);
  else r.fail("unsupported_shape");
  return value;
}
function textCell(cell: readonly unknown[], backend: Backend, nativeCapture: boolean, r: AuditRequest): string {
  const native = backend === "sqlite" || nativeCapture;
  r.require(native ? cell[0] === "text" : cell[0] === "pg-binary" && cell[1] === "25", "unsupported_shape");
  const text = r.decodeText(cell[native ? 1 : 2] as string);
  if (backend === "postgres") { r.text(text.length * 3); r.require(!text.includes("\0"), "source_contract_mismatch"); }
  return text;
}
function array(value: unknown, r: AuditRequest): unknown[] { r.require(Array.isArray(value), "unsupported_shape"); return value; }
function countedRows(count: unknown, value: unknown, r: AuditRequest): unknown[] {
  const rows = array(value, r); r.rowCount(rows.length);
  r.require(typeof count === "string" && count.length <= 6 && /^(0|[1-9][0-9]*)$/.test(count));
  r.require(count === String(rows.length), "semantic_invariant_failed", "count-mismatch"); return rows;
}
function columns(value: unknown, expected: readonly string[], r: AuditRequest): void {
  const actual = array(value, r); r.units(actual.length + expected.length);
  r.require(actual.length === expected.length && expected.every((c, i) => actual[i] === c), "source_contract_mismatch");
}
function artifact(value: unknown, r: AuditRequest): void {
  const v = record(value, ["ref", "sha256", "bytes"], r);
  scalar(v.ref, r); digest(v.sha256, r);
  r.require(typeof v.bytes === "string"); r.text(v.bytes.length);
  r.require(/^(0|[1-9][0-9]*)$/.test(v.bytes));
}
function timestamp(value: unknown, r: AuditRequest): string {
  r.require(typeof value === "string" && value.length <= 64); r.text(value.length);
  const m = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/.exec(value);
  r.require(m !== null);
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  r.require(month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]! && Number(m[4]) <= 23
    && Number(m[5]) <= 59 && Number(m[6]) <= 60 && (m[7] === undefined || Number(m[8]) <= 23 && Number(m[9]) <= 59));
  return value; // Exact observed RFC3339 text, never Date conversion or current time.
}
function indexPut<T>(index: Map<string, T>, key: string, value: T, r: AuditRequest): void {
  r.units(1); r.text(key.length * 3);
  r.require(!index.has(key), "semantic_invariant_failed", "identity-mismatch"); index.set(key, value);
}

function captureAgents(value: unknown, identity: SourceRef, captureId: string, r: AuditRequest): Map<string, string> {
  const v = record(value, ["contract", "captureId", "physicalSourceRef", "snapshotReceiptRef", "source", "textEncoding", "persistedAliases", "legacySourceDigest", "tables"], r);
  const cost = r.measure(value, AUDIT_LIMITS.capture);
  sameSource(source(v.source, r), identity, r); encoding(v.textEncoding, identity.kind, r);
  r.text(captureId.length * 3);
  r.require(v.captureId === captureId, "source_contract_mismatch");
  const tables = array(v.tables, r);
  r.require(tables.length === 10, "source_contract_mismatch");
  let loopWork = 0;
  for (const [index, table] of tables.entries()) {
    const t = record(table, ["name", "columnContract", "columns", "count", "rows"], r), cols = array(t.columns, r);
    if (index === 0) {
      r.at("agents"); r.require(t.name === "agents", "source_contract_mismatch"); columns(cols, AGENT_COLUMNS, r); r.at();
    }
    const rows = countedRows(t.count, t.rows, r);
    loopWork += rows.length * (256 + cols.length * 3);
    for (const item of rows) {
      const row = record(item, ["rowid", "cells"], r); rowid(row.rowid, identity.kind, r);
      const cells = array(row.cells, r); r.require(cells.length === cols.length, "source_contract_mismatch");
      for (const cell of cells) rawCell(cell, identity.kind, true, r);
    }
  }
  // Original P-A: one descriptor-safe copy and Zod copy; scalar scans/union checks,
  // fixed prototype admission, per-row PK indexOf + canonical key construction.
  // Native cells are leaves and PK tuples have at most two cells: no hidden quadratic graph walk.
  r.allocateNodes(cost.nodes * 2 + 512);
  r.units(cost.nodes * 64 + 2048 + loopWork); r.text(cost.bytes, 16);
  const parsed = parseM2Value({ kind: "legacy-capture", value });
  if (!parsed.ok) {
    // P-A's unchanged public invalid_value also represents its unknown caught throws.
    // That identity is already lost; never invent a located input fault for this ambiguous result.
    if (parsed.error.code === "invalid_value") r.unlocatedInvalid();
    r.fail(parsed.error.code === "budget_exceeded" ? "resource_limit" : parsed.error.code === "value_conflict"
      ? "semantic_invariant_failed" : parsed.error.code === "unsupported_shape" ? "unsupported_shape" : "invalid_value");
  }
  r.require(parsed.value.kind === "legacy-capture");
  const agents = parsed.value.value.tables[0]!;
  r.at("agents"); columns(agents.columns, AGENT_COLUMNS, r);
  const index = new Map<string, string>();
  agents.rows.forEach((row, i) => {
    r.at("agents", i, 0);
    const id = textCell(row.cells[0]!, identity.kind, true, r); r.require(id.length > 0);
    r.at("agents", i, 1); const name = textCell(row.cells[1]!, identity.kind, true, r);
    r.at("agents", i, 0, "PC1B-KEY01"); indexPut(index, id, name, r);
  });
  return index;
}
function oldAudit(value: unknown, identity: SourceRef, r: AuditRequest): { ids: Set<string>; rowids: Set<string> } {
  r.at("audit_log");
  const v = record(value, ["source", "textEncoding", "table"], r);
  sameSource(source(v.source, r), identity, r); encoding(v.textEncoding, identity.kind, r);
  const t = record(v.table, ["name", "columnContract", "columnContractValueDigest", "columns", "count", "rows"], r);
  r.require(t.name === "audit_log", "source_contract_mismatch"); columns(t.columns, AUDIT_COLUMNS, r);
  artifact(t.columnContract, r); digest(t.columnContractValueDigest, r);
  const rows = countedRows(t.count, t.rows, r), ids = new Set<string>(), rowids = new Set<string>();
  rows.forEach((item, i) => {
    r.at("audit_log", i, null, "PC1B-KEY01");
    const row = record(item, ["rowid", "cells"], r), rid = rowid(row.rowid, identity.kind, r);
    if (rid !== null) { r.units(1); r.text(rid.length); r.require(!rowids.has(rid), "semantic_invariant_failed"); rowids.add(rid); }
    const cells = array(row.cells, r); r.require(cells.length === AUDIT_COLUMNS.length, "source_contract_mismatch");
    cells.forEach((cell, c) => { r.at("audit_log", i, c); rawCell(cell, identity.kind, false, r); });
    r.at("audit_log", i, 0);
    const id = textCell(cells[0] as unknown[], identity.kind, false, r); r.require(id.length > 0);
    r.at("audit_log", i, 0, "PC1B-KEY01");
    r.units(1); r.text(id.length * 3); r.require(!ids.has(id), "semantic_invariant_failed"); ids.add(id);
  });
  return { ids, rowids };
}

/** Exact new audit rows relative to supplied values. No full seed/history verdict or writer permission. */
export function projectM2TakeoverAuditAdditions(input: unknown): AuditResult<Projection> {
  return boundary(input, (value, r: AuditRequest) => {
    const v = record(value, ["seed", "capture", "previousAudit", "rowids"], r);
    const s = record(v.seed, ["source", "planId", "activationId", "captureId", "createdAt", "actor", "agents"], r);
    const identity = source(s.source, r), planId = scalar(s.planId, r), activationId = scalar(s.activationId, r), captureId = scalar(s.captureId, r);
    const createdAt = timestamp(s.createdAt, r), actor = record(s.actor, ["kind", "name", "memberId"], r), actorName = scalar(actor.name, r, 0);
    r.require(actor.kind === "human" && actor.memberId === null);
    const agents = captureAgents(v.capture, identity, captureId, r), previous = oldAudit(v.previousAudit, identity, r);
    r.at(null, null, null, "PC1B-AUD01");
    const seedAgents = array(s.agents, r), planned = array(v.rowids, r);
    r.require(seedAgents.length === agents.size && planned.length === agents.size, "semantic_invariant_failed", "count-mismatch");
    const auditIds = new Map<string, string>(), ids = previous.ids, rowids = new Map<string, string | null>(), usedRowids = previous.rowids;
    for (const item of seedAgents) {
      r.at();
      const agent = record(item, ["agentId", "profileRevision", "auditId"], r), id = scalar(agent.agentId, r), auditId = scalar(agent.auditId, r);
      r.units(2); r.text(id.length * 3 + auditId.length * 3);
      r.at(null, null, null, "PC1B-AUD01"); r.require(agent.profileRevision === 1 && agents.has(id), "semantic_invariant_failed");
      r.at(null, null, null, "PC1B-KEY01"); r.require(!ids.has(auditId), "semantic_invariant_failed");
      indexPut(auditIds, id, auditId, r); ids.add(auditId);
    }
    for (const item of planned) {
      r.at();
      const entry = record(item, ["agentId", "rowid"], r), id = scalar(entry.agentId, r), rid = rowid(entry.rowid, identity.kind, r);
      r.units(2); r.text(id.length * 3 + (rid?.length ?? 0));
      r.at(null, null, null, "PC1B-AUD01"); r.require(agents.has(id), "semantic_invariant_failed");
      r.at(null, null, null, "PC1B-KEY01"); r.require(rid === null || !usedRowids.has(rid), "semantic_invariant_failed");
      indexPut(rowids, id, rid, r); if (rid !== null) usedRowids.add(rid);
    }
    r.at(null, null, null, "PC1B-AUD01");
    // These fixed ASCII key orders are C-R3. Explicit changed avoids diffChanged's old object grammar.
    const changed = '["configuration_authority"]', before = '{"owner":"legacy"}';
    const after = r.stringify({ activationId, owner: "profile", profileRevision: 1 }, AUDIT_LIMITS.field);
    const detail = r.stringify({ captureId, contract: "m2-takeover-audit/r1", planId, sourceIdentityDigest: identity.identityDigest }, AUDIT_LIMITS.field);
    r.rowCount(agents.size);
    const result: Projection = { classification: "projection", coverage: "takeover-audit-seventeen-columns", source: identity, captureId,
      additions: { table: "audit_log", columns: [...AUDIT_COLUMNS], count: String(agents.size), rows: [] }, remaining: REMAINING };
    r.reserveOutput(r.measure({ ok: true, value: result }, AUDIT_LIMITS.output).bytes);
    const framed: { row: RawRow; frame: Buffer }[] = [];
    for (const [id, name] of agents) {
      const rid = rowids.get(id)!, values: (string | null)[] = [auditIds.get(id)!, "user", null, "human", null, actorName, "configuration.takeover", "agent", id, name,
        changed, before, after, detail, null, null, createdAt];
      // Reserve exact JSON result expansion before allocating any row's hex or sort frame.
      let rowBytes = 21 + (rid === null ? 4 : r.quotedBytes(rid)) + values.length - 1;
      const sizes = values.map(text => {
        if (text === null) { rowBytes += 8; return 0; }
        const bytes = r.utf8Bytes(text);
        if (identity.kind === "postgres") { r.text(bytes); r.require(!text.includes("\0"), "source_contract_mismatch"); }
        rowBytes += (identity.kind === "sqlite" ? 11 : 21) + bytes * 2; return bytes;
      });
      r.reserveOutput(rowBytes + (framed.length ? 1 : 0)); r.allocateNodes(identity.kind === "sqlite" ? 50 : 64);
      const cells: RawCell[] = values.map((text, i) => {
        if (text === null) return ["null"];
        r.text(sizes[i]!, 3); const hex = Buffer.from(text, "utf8").toString("hex");
        return identity.kind === "sqlite" ? ["text", hex] : ["pg-binary", "25", hex];
      });
      const row = { rowid: rid, cells }, frame = r.stringify([rid, cells], AUDIT_LIMITS.output);
      r.text(frame.length); framed.push({ row, frame: Buffer.from(frame, "utf8") });
    }
    framed.sort((a, b) => { r.units(1); r.text(a.frame.length + b.frame.length); return Buffer.compare(a.frame, b.frame); });
    result.additions.rows = framed.map(item => item.row);
    return result;
  });
}

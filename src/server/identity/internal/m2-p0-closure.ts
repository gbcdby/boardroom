import { M2_HISTORY_TABLES } from "../m2-history-contracts.ts";
import type { RawCell } from "../m2-history-contracts.ts";
import type { ReadonlyDeep } from "../m2-value-contracts.ts";
import type { ClosureAvailability, ClosureNativeCheck, ClosureResult, ClosureValue } from "../m2-history-closure-contracts.ts";
import { canonicalP0, chargeP0, checkP0Keys, createP0TupleIndex, failP0,
  p0RowSite, retainP0Rows, withP0Guard } from "./m2-p0.ts";
import { makeP0Site, p0State } from "./m2-p0-budget.ts";
import { P0_RULES, P0_TABLE_NAMES } from "./m2-p0-types.ts";
import type { P0Input, P0KeyPart, P0Request, P0Result, P0Row, P0Rule, P0Site, P0Table, P0View } from "./m2-p0-types.ts";
import { checkP0IdentityFamily } from "./m2-p0-identity-family.ts";
import { checkP0TaskDecisionWorkEvents, P0_C_RULES } from "./m2-p0-task-decision-work-events.ts";
import { checkP0AuditMemory, P0_D_RULES } from "./m2-p0-audit-memory.ts";
import { checkP0ConfigurationFamily } from "./m2-p0-config-family.ts";
import { E_RULES } from "./m2-p0-e-context.ts";
import { checkP0Artifacts, checkM2OriginalP0Artifacts } from "./m2-p0-artifacts.ts";
import { getP0OriginalClientClassifications } from "./m2-p0-artifacts-clients.ts";
import type { P0OriginalClientClassification } from "./m2-p0-artifacts-clients.ts";
import { ClosureEncoder, freezeClosureOutput, sortedClosureFrames } from "./m2-p0-closure-output.ts";

const A_RULES = ["PC1B-RAW01", "PC1B-KEY01"] as const;
const B_RULES = ["PC1B-ID01", "PC1B-ROLE01", "PC1B-ROLE02", "PC1B-ORG01", "PC1B-CHAT01"] as const;
const NA_RULES = new Set<P0Rule>(["PC1B-M201", "PC1B-M202", "PC1B-M203", "PC1B-M204"]);
const ALL_REQUIRED = P0_RULES.filter(rule => !NA_RULES.has(rule) && rule !== "PC1B-DEL01");
const CATALOG = M2_HISTORY_TABLES.filter(table => table.columnsP0.length);
const PRIMARY_KEYS = CATALOG.map(table => table.primaryKey.map(name => table.columnsP0.findIndex(column => column.name === name)));
const CLIENT_ID_COLUMN = CATALOG.find(table => table.name === "storage_source_clients")!.columnsP0.findIndex(column => column.name === "client_id");
const NATIVE: readonly ClosureNativeCheck[] = ["physical_source_authenticity", "native_snapshot_window", "actual_catalog_identity",
  "strict_p1_native_outer_join", "g1_exclusion", "sequence_exclusion", "current_authorization", "native_commit",
  "lossless_native_writer", "full_ab_budget", "fs_profile", "production_tuple"];

interface CompletedPass {
  readonly view: P0View;
  readonly checked: ReadonlySet<P0Rule>;
  readonly completeHistoryDigest: string;
  readonly availability: readonly ClosureAvailability[];
}
type Selection = NonNullable<P0Input["proposedDeletion"]>["rows"][number];
interface RetainedSelection { readonly view: P0View; readonly sorted: readonly Selection[]; }

function obligation(request: P0Request, checked: Set<P0Rule>, rules: readonly P0Rule[], actual: readonly P0Rule[]): void {
  chargeP0(request, { work: rules.length * 3 + actual.length, tuples: rules.length });
  if (rules.length !== actual.length || rules.some((rule, ordinal) => rule !== actual[ordinal])) {
    failP0(request, { code: "semantic_unsupported", rule: null, condition: "undefined-grammar" });
  }
  for (const rule of rules) {
    if (checked.has(rule)) failP0(request, { code: "invalid_value", rule: null });
    checked.add(rule);
  }
}
function phase(request: P0Request, view: P0View, actual: P0View["phase"]): void {
  chargeP0(request, { work: 1 });
  if (actual !== view.phase) failP0(request, { code: "invalid_value", rule: null });
}

/** The compiled ownership sequence is the only route to a pass. Every receipt
 * follows the real synchronous consumer for this exact request and view. */
function completePass(request: P0Request, view: P0View, withinM2 = false): P0Result<CompletedPass> {
  chargeP0(request, { work: 8, tuples: 2 });
  const checked = new Set<P0Rule>();
  const a = checkP0Keys(request, view); if (!a.ok) return a;
  phase(request, view, a.value.phase);
  if (a.value.classification !== "sql-constraint-observation" || a.value.tables !== 61 || a.value.rows !== view.rowCount)
    failP0(request, { code: "invalid_value", rule: null });
  // RAW01 was admitted by A from the original immutable scanner tree. A's
  // authenticated retained view can contain only those same original row objects.
  obligation(request, checked, A_RULES, A_RULES);
  const b = checkP0IdentityFamily(request, view); if (!b.ok) return b;
  if (b.value.classification !== "identity-organization-chat-observation") failP0(request, { code: "invalid_value", rule: null });
  phase(request, view, b.value.phase); obligation(request, checked, B_RULES, b.value.checkedRules);
  const c = checkP0TaskDecisionWorkEvents(request, view); if (!c.ok) return c;
  if (c.value.classification !== "task-decision-work-event-observation") failP0(request, { code: "invalid_value", rule: null });
  phase(request, view, c.value.phase); obligation(request, checked, P0_C_RULES, c.value.rules);
  const d = checkP0AuditMemory(request, c.value.completion, view); if (!d.ok) return d;
  if (d.value.classification !== "audit-memory-observation") failP0(request, { code: "invalid_value", rule: null });
  phase(request, view, d.value.phase); obligation(request, checked, P0_D_RULES, d.value.rules);
  const e = checkP0ConfigurationFamily(request, view); if (!e.ok) return e;
  if (e.value.classification !== "configuration-observation") failP0(request, { code: "invalid_value", rule: null });
  phase(request, view, e.value.phase); obligation(request, checked, E_RULES, e.value.checkedRules);
  const f = withinM2 ? checkM2OriginalP0Artifacts(request, view) : checkP0Artifacts(request, view); if (!f.ok) return f;
  if (f.value.classification !== "artifact-value-observation") failP0(request, { code: "invalid_value", rule: null });
  phase(request, view, f.value.phase); obligation(request, checked, ["PC1B-ART01"], [f.value.rule]);
  if (!withinM2 && (f.value.artifacts !== request.input.artifacts.length || f.value.evidence !== request.input.evidence.length))
    failP0(request, { code: "artifact_semantic_mismatch", rule: "PC1B-ART01", condition: "count-mismatch" });
  chargeP0(request, { work: ALL_REQUIRED.length + 3 });
  if (checked.size !== 43 || ALL_REQUIRED.some(rule => !checked.has(rule)))
    failP0(request, { code: "semantic_unsupported", rule: null, condition: "undefined-grammar" });
  const availability: ClosureAvailability[] = [];
  chargeP0(request, { work: d.value.availability.length, tuples: d.value.availability.length });
  for (const entry of d.value.availability) availability.push({ kind: entry.code, location: entry.location });
  for (const entry of e.value.runtimeUsability) {
    chargeP0(request, { work: 1 });
    if (entry.usable) continue;
    const row = request.original.rows(entry.table)[entry.rowOrdinal];
    if (!row) failP0(request, { code: "invalid_value", rule: null });
    // E's usability observation identifies the owning row but does not identify
    // one failing column. Do not guess a column or echo its configuration values.
    chargeP0(request, { tuples: 1 });
    availability.push({ kind: "unusable-unselected-runtime",
      location: p0RowSite(request, view, row, undefined, "PC1B-RT01.P01").location });
  }
  return Object.freeze({ ok: true, value: { view, checked, availability, completeHistoryDigest: f.value.originalHistoryDigest } });
}

function deletionSite(request: P0Request, tableOrdinal: number): P0Site {
  return makeP0Site(p0State(request), { depth: 2, phase: "input", location: {
    inputPart: "input", artifactOrdinal: null, table: P0_TABLE_NAMES[tableOrdinal]!, rowOrdinal: null, columnOrdinal: null, pathId: "PC1B-DEL01.P01" } });
}
function exactKey(request: P0Request, table: number, cells: readonly ReadonlyDeep<RawCell>[], rowid: string | null): P0KeyPart[] {
  chargeP0(request, { work: cells.length * 4 + 3, tuples: 1 });
  const key: P0KeyPart[] = [table];
  for (const cell of cells) key.push(cell.length, ...cell);
  key.push(rowid); return key;
}
function retainedDeletionSite(request: P0Request, original: CompletedPass, row: P0Row): P0Site {
  chargeP0(request, { work: 3, tuples: 6 });
  const originalSite = p0RowSite(request, original.view, row, undefined, "PC1B-DEL01.P01");
  return makeP0Site(p0State(request), { depth: 2, phase: "retained-graph", location: originalSite.location });
}

function protectOriginalClients(request: P0Request, original: CompletedPass, deleted: ReadonlySet<P0Row>): P0Result<null> {
  // F projects immutable data from the exact original receipt cut after its real
  // consumer has passed. This is neither a semantic receipt nor a native permit.
  const data = getP0OriginalClientClassifications(request); if (!data.ok) return data;
  const index = createP0TupleIndex<P0OriginalClientClassification["classification"]>(request);
  for (const client of data.value.clients) {
    chargeP0(request, { work: 4, tuples: 1 });
    if (index.insert([client.subject.length, ...client.subject], client.classification) !== undefined)
      failP0(request, { code: "invalid_value", rule: null });
  }
  // Visit original ordinals, independently of selector order or F's fact order.
  // The supported F domain is SQLite; its subject is the exact UTF-8 raw cell.
  for (const row of original.view.rows("storage_source_clients")) {
    chargeP0(request, { work: 1 });
    if (!deleted.has(row)) continue;
    chargeP0(request, { work: 7, tuples: 1 });
    const cell = row.raw.cells[CLIENT_ID_COLUMN]!;
    const classification = index.get([cell.length, ...cell]);
    if (classification === undefined) failP0(request, { code: "invalid_value", rule: null });
    if (classification === "current-client" || classification === "active-actor")
      failP0(request, { code: "semantic_invariant_failed", rule: "PC1B-DEL01", condition: "negative-invariant",
        site: retainedDeletionSite(request, original, row) });
    if (classification === "unresolved-controller")
      failP0(request, { code: "semantic_unsupported", rule: "PC1B-DEL01", condition: "unsupported-value",
        site: retainedDeletionSite(request, original, row) });
  }
  chargeP0(request, { work: 1, tuples: 1 });
  return { ok: true, value: null };
}

function exactRetained(request: P0Request, original: CompletedPass): P0Result<RetainedSelection> {
  const deletion = request.input.proposedDeletion!;
  chargeP0(request, { work: deletion.rows.length + 61, tuples: deletion.rows.length + 3 });
  const index = createP0TupleIndex<P0Row>(request), deleted = new Set<P0Row>(), requestedTables = new Set<P0Table>();
  for (const selector of deletion.rows) requestedTables.add(selector.table);
  for (const [ordinal, table] of P0_TABLE_NAMES.entries()) {
    if (!requestedTables.has(table)) continue;
    for (const row of original.view.rows(table)) {
      chargeP0(request, { work: PRIMARY_KEYS[ordinal]!.length, tuples: 1 });
      const key = PRIMARY_KEYS[ordinal]!.map(column => row.raw.cells[column]!);
      if (index.insert(exactKey(request, ordinal, key, row.raw.rowid), row))
        failP0(request, { code: "semantic_invariant_failed", rule: "PC1B-KEY01", condition: "duplicate-key", site: p0RowSite(request, original.view, row) });
    }
  }
  const frames: string[] = [], selectors = createP0TupleIndex<Selection>(request);
  for (const selector of deletion.rows) {
    chargeP0(request, { work: 61 });
    const ordinal = (P0_TABLE_NAMES as readonly string[]).indexOf(selector.table), site = deletionSite(request, ordinal);
    const row = index.get(exactKey(request, ordinal, selector.key, selector.rowid));
    if (!row) failP0(request, { code: "invalid_value", rule: "PC1B-DEL01", condition: "missing-target", site });
    if (deleted.has(row)) failP0(request, { code: "invalid_value", rule: "PC1B-DEL01", condition: "duplicate-key", site });
    deleted.add(row);
    const frame = `${String(ordinal).padStart(2, "0")}:${canonicalP0(request, [selector.key, selector.rowid])}`;
    selectors.insert([frame], selector); frames.push(frame);
  }
  // DEL01 preserves the registered schema and unique maintenance identity.
  // The original graph has already passed all families before this check.
  for (const table of ["schema_migrations", "storage_maintenance"] as const) for (const row of original.view.rows(table)) {
    chargeP0(request, { work: 1 });
    if (deleted.has(row)) {
      const site = retainedDeletionSite(request, original, row);
      failP0(request, { code: "semantic_invariant_failed", rule: "PC1B-DEL01", condition: "negative-invariant", site });
    }
  }
  chargeP0(request, { work: 1 });
  if (requestedTables.has("storage_source_clients")) {
    const protectedClients = protectOriginalClients(request, original, deleted); if (!protectedClients.ok) return protectedClients;
  }
  chargeP0(request, { work: original.view.rowCount, tuples: original.view.rowCount });
  const kept: P0Row[] = [];
  for (const table of P0_TABLE_NAMES) for (const row of original.view.rows(table)) if (!deleted.has(row)) kept.push(row);
  const sorted = sortedClosureFrames(request, frames).map(frame => selectors.get([frame])!);
  chargeP0(request, { work: 1, tuples: 1 });
  return { ok: true, value: { view: retainP0Rows(request, kept), sorted } };
}

function finish(request: P0Request, original: CompletedPass, retained: CompletedPass | null, selected: RetainedSelection | null): ClosureValue {
  const observation = request.input.graph.observation;
  const encoder = new ClosureEncoder(request);
  if (retained && retained.completeHistoryDigest !== original.completeHistoryDigest)
    failP0(request, { code: "artifact_semantic_mismatch", rule: "PC1B-ART01", condition: "immutable-history-mismatch" });
  chargeP0(request, { work: 1, tuples: 1 });
  const tables: { table: P0Table; rows: string; rowMultisetDigest: string }[] = [];
  for (const [ordinal, table] of observation.tables.entries()) {
    chargeP0(request, { work: 1, tuples: 1 });
    const rowMultisetDigest = encoder.tableRowsDigest(ordinal);
    tables.push({ table: P0_TABLE_NAMES[ordinal]!, rows: table.count, rowMultisetDigest });
  }
  let deletion: ClosureValue["deletion"] = null;
  if (retained && selected) {
    // The authenticated retained view is a subset of these exact original rows,
    // in their original order. An unchanged table can reuse its immutable byte
    // data; this never replaces the retained semantic pass completed above.
    let retainedTables = observation.tables, retainedRawView = observation;
    if (selected.sorted.length) {
      chargeP0(request, { work: 61 * 2 + 12, tuples: 61 + 2 });
      retainedTables = observation.tables.map((table, ordinal) => {
        const rows = retained.view.rows(P0_TABLE_NAMES[ordinal]!);
        if (rows.length === table.rows.length) return table;
        chargeP0(request, { work: rows.length + 8, tuples: rows.length + 2, bytes: 32 });
        return { ...table, rows: rows.map(row => row.raw), count: String(rows.length) };
      });
      retainedRawView = { ...observation, tables: retainedTables };
    }
    chargeP0(request, { work: 61 * 2 + 2, tuples: 61 + 6, bytes: 32 });
    deletion = { requestedCount: String(request.input.proposedDeletion!.rows.length),
      retainedHistoryDigest: encoder.digest(["m2-pc-retained-history/r2", original.completeHistoryDigest, selected.sorted, retainedRawView]),
      retainedCounts: retainedTables.map((table, ordinal) => ({ table: P0_TABLE_NAMES[ordinal]!, rows: table.count })), valueConsistent: true };
  }
  chargeP0(request, { work: P0_RULES.length + request.input.artifacts.length + NATIVE.length,
    tuples: P0_RULES.length + request.input.artifacts.length + NATIVE.length });
  const historicalAvailability: ClosureAvailability[] = [], availabilityIndex = createP0TupleIndex<true>(request);
  for (const pass of retained ? [original, retained] : [original]) for (const entry of pass.availability) {
    const location = entry.location;
    const key: P0KeyPart[] = [entry.kind, location.inputPart, location.artifactOrdinal, location.table,
      location.rowOrdinal, location.columnOrdinal, location.pathId];
    if (availabilityIndex.insert(key, true) === undefined) historicalAvailability.push(entry);
  }
  const value: ClosureValue = {
    classification: "observation", coverage: "complete-history-value-closure", graphKind: "m2-observation", phase: "p0",
    source: observation.source, catalog: "legacy-p0", inputDigest: encoder.digest(["m2-pc-closure-input/r2", request.input]),
    completeHistoryDigest: original.completeHistoryDigest, tables,
    selectedArtifacts: request.input.artifacts.map((item, artifactOrdinal) => ({ kind: item.kind, artifactOrdinal,
      byteDigest: item.artifact.sha256, bytes: item.artifact.bytes })),
    checks: { legacySemanticGraph: "verified", m2SemanticGraph: "not-applicable", layoutSemanticGraph: "not-applicable",
      artifactBytes: "verified", artifactSemantics: "verified", sourceProvenance: "verified-values",
      retainedReferenceClosure: retained ? "verified" : "not-requested" },
    deletion,
    ruleCoverage: P0_RULES.map(rule => ({ rule, status: NA_RULES.has(rule) || rule === "PC1B-DEL01" && !retained ? "not-applicable" : "verified" })),
    historicalAvailability,
    remaining: NATIVE.map(check => ({ check, status: check === "strict_p1_native_outer_join"
      || check === "sequence_exclusion" && observation.backend === "sqlite" ? "not-applicable" : "unproven" })),
  };
  return freezeClosureOutput(request, value, encoder);
}

/** Private authenticated composition. The public facade alone admits raw input. */
export function runP0Closure(request: P0Request): ClosureResult {
  const guarded = withP0Guard(request, (): ClosureResult => {
    const original = completePass(request, request.original); if (!original.ok) return original;
    let selected: RetainedSelection | null = null, retained: CompletedPass | null = null;
    if (request.input.proposedDeletion !== null) {
      const selection = exactRetained(request, original.value); if (!selection.ok) return selection;
      selected = selection.value;
      const checked = completePass(request, selected.view); if (!checked.ok) return checked;
      retained = checked.value;
    }
    return Object.freeze({ ok: true, value: finish(request, original.value, retained, selected) });
  });
  return guarded.ok ? guarded.value : guarded;
}

/** Fixed internal M2 consumer of the actual captured P0 history. No partial
 * result escapes as a public complete-history result or a native permit. */
export function runP0M2Predecessor(request: P0Request): P0Result<{ readonly completeHistoryDigest: string }> {
  const guarded = withP0Guard(request, () => {
    if(request.input.graph.observation.phase!=="p0" || request.input.proposedDeletion!==null)
      failP0(request,{code:"unsupported_shape",rule:"PC1B-RAW01"});
    const result=completePass(request,request.original,true);
    return result.ok ? Object.freeze({ok:true as const,value:Object.freeze({completeHistoryDigest:result.value.completeHistoryDigest})}) : result;
  });
  return guarded.ok?guarded.value:guarded;
}

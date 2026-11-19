import { M2_HISTORY_TABLES } from "../m2-history-contracts.ts";
import { validateHistoryObservationValue, historyValueFailure } from "./m2-history-observation-core.ts";
import { encodeHistoryCarrierValue } from "./m2-history-carrier.ts";
import type { HistoryCarrierAccounting } from "./m2-history-carrier.ts";
import { bindP0State, catchP0, chargeState, fixedError, makeP0Site, newP0State, p0State, P0_LIMITS, throwP0 } from "./m2-p0-budget.ts";
import type { P0State } from "./m2-p0-budget.ts";
import { scanP0Json, wellFormedP0 } from "./m2-p0-lexical.ts";
import { buildP0View } from "./m2-p0-raw.ts";
import { P0_TABLE_NAMES } from "./m2-p0-types.ts";
import type { P0Code, P0Input, P0Location, P0Request, P0Result, P0Row, P0Site, P0Table } from "./m2-p0-types.ts";

const contracts = M2_HISTORY_TABLES.filter(t => t.columnsP0.length);
const hash = /^[0-9a-f]{64}$/, hex = /^(?:[0-9a-f]{2})*$/;
function expect(state: P0State, condition: unknown, code: P0Code = "invalid_value", site?: P0Site): asserts condition {
  if (!condition) throwP0(state, { code, rule: "PC1B-RAW01", ...(site ? { site } : {}) });
}
function object(state: P0State, value: unknown, keys: readonly string[]): Record<string, unknown> {
  expect(state, value !== null && typeof value === "object" && !Array.isArray(value), "unsupported_shape");
  const own = Object.keys(value);
  chargeState(state, { work: own.length + keys.length });
  expect(state, own.length === keys.length && keys.every(key => Object.hasOwn(value, key)), "unsupported_shape");
  return value as Record<string, unknown>;
}
function decimal(state: P0State, value: unknown): asserts value is string {
  expect(state, typeof value === "string" && value.length <= 20 && /^(?:0|[1-9][0-9]*)$/.test(value));
  chargeState(state, { work: 1, bytes: value.length });
}
function int64(state: P0State, value: unknown): asserts value is string {
  expect(state, typeof value === "string" && value.length <= 20 && /^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(value));
  chargeState(state, { work: 1, bytes: value.length });
  const number = BigInt(value); expect(state, number >= -9223372036854775808n && number <= 9223372036854775807n);
}
function ref(state: P0State, value: unknown): Record<string, unknown> {
  const result = object(state, value, ["ref", "sha256", "bytes"]);
  expect(state, typeof result.ref === "string" && result.ref.length > 0 && typeof result.sha256 === "string" && hash.test(result.sha256));
  decimal(state, result.bytes); chargeState(state, { bytes: result.ref.length * 2 + 64, work: 1 });
  return result;
}
function evidenceRef(state: P0State, value: unknown): void {
  const result = object(state, value, ["artifactId", "digest"]);
  expect(state, typeof result.artifactId === "string" && result.artifactId.length > 0 && typeof result.digest === "string" && hash.test(result.digest));
  chargeState(state, { bytes: (result.artifactId as string).length * 2 + 64, work: 1 });
}
function selections(state: P0State, artifacts: unknown, evidence: unknown): void {
  expect(state, Array.isArray(artifacts) && Array.isArray(evidence), "unsupported_shape");
  expect(state, artifacts.length <= P0_LIMITS.artifacts && evidence.length <= P0_LIMITS.evidence, "resource_limit");
  for (const [index, value] of artifacts.entries()) {
    const selected = object(state, value, ["kind", "artifact", "bytesHex"]), artifact = ref(state, selected.artifact);
    const site = makeP0Site(state, { depth: (state.depths.get(selected) ?? 2) + 2, phase: "artifact",
      location: { inputPart: "artifact", artifactOrdinal: index, table: null, rowOrdinal: null, columnOrdinal: null, pathId: "artifact.root" } });
    expect(state, typeof selected.kind === "string" && selected.kind.length > 0 && typeof selected.bytesHex === "string", "unsupported_shape", site);
    const bytesHex = selected.bytesHex as string;
    expect(state, bytesHex.length <= 2 * P0_LIMITS.artifactBytes, "resource_limit", site);
    chargeState(state, { bytes: bytesHex.length, work: 1 }, site);
    expect(state, hex.test(bytesHex), "invalid_value", site);
    const bytes = bytesHex.length / 2;
    expect(state, state.usage.selectedBytes + bytes <= P0_LIMITS.selectedBytes, "resource_limit", site);
    state.usage.selectedBytes += bytes;
    expect(state, BigInt(artifact.bytes as string) === BigInt(bytes), "artifact_bytes_mismatch", site);
  }
  for (const value of evidence) {
    const selection = object(state, value, ["kind", "artifact", "evidence"]);
    expect(state, typeof selection.kind === "string" && selection.kind.length > 0, "unsupported_shape");
    ref(state, selection.artifact); evidenceRef(state, selection.evidence);
  }
}
function rawDeletion(state: P0State, value: unknown, backend: "sqlite" | "postgres"): void {
  if (value === null) return;
  const deletion = object(state, value, ["rows"]); expect(state, Array.isArray(deletion.rows), "unsupported_shape");
  chargeState(state, { work: deletion.rows.length, tuples: deletion.rows.length });
  for (const item of deletion.rows) {
    const row = object(state, item, ["table", "key", "rowid"]);
    chargeState(state, { work: contracts.length });
    const contract = contracts.find(c => c.name === row.table);
    expect(state, contract && Array.isArray(row.key) && row.key.length === contract.primaryKey.length, "unsupported_shape");
    if (backend === "sqlite") int64(state, row.rowid); else expect(state, row.rowid === null, "source_contract_mismatch");
    for (const [index, cell] of row.key.entries()) {
      expect(state, Array.isArray(cell) && typeof cell[0] === "string", "unsupported_shape");
      if (cell[0] === "null") { expect(state, cell.length === 1, "unsupported_shape"); continue; }
      if (backend === "postgres") {
        const oid = contract.columnsP0.find(c => c.name === contract.primaryKey[index])!.postgresTypeOid;
        expect(state, cell[0] === "pg-binary" && cell.length === 3 && cell[1] === oid && typeof cell[2] === "string", "source_contract_mismatch");
        chargeState(state, { bytes: cell[2].length, work: 1 }); expect(state, hex.test(cell[2]));
        if (oid !== "25") expect(state, cell[2].length === (oid === "23" ? 8 : 16), "source_contract_mismatch");
      } else {
        expect(state, cell.length === 2, "unsupported_shape");
        if (cell[0] === "integer") int64(state, cell[1]);
        else if (cell[0] === "text" || cell[0] === "blob" || cell[0] === "real64be") {
          expect(state, typeof cell[1] === "string"); chargeState(state, { bytes: cell[1].length, work: 1 });
          expect(state, hex.test(cell[1]) && (cell[0] !== "real64be" || cell[1].length === 16));
        } else expect(state, false, "unsupported_shape");
      }
    }
  }
}
function countAndCheck(state: P0State, value: unknown, site?: P0Site): number {
  let count = 0;
  const visit = (node: unknown): void => {
    chargeState(state, { work: 1 }, site); count++;
    if (typeof node === "string") {
      chargeState(state, { bytes: node.length * 2 }, site); expect(state, wellFormedP0(node), "invalid_value", site);
    } else if (typeof node === "number") expect(state, Number.isSafeInteger(node) && !Object.is(node, -0), "invalid_value", site);
    else if (Array.isArray(node)) node.forEach(visit);
    else if (node !== null && typeof node === "object") for (const key of Object.keys(node)) { count++; chargeState(state, { work: 1, bytes: key.length * 2 }, site); expect(state, wellFormedP0(key)); visit((node as Record<string, unknown>)[key]); }
    else expect(state, node === null || typeof node === "boolean", "unsupported_shape", site);
  };
  visit(value); return count;
}
function accounting(state: P0State, nodes: number, site?: P0Site): HistoryCarrierAccounting {
  let localNodes = nodes, localRows = 0;
  return { encodings: new WeakMap(),
    get nodes() { return localNodes; }, set nodes(value) { chargeState(state, { nodes: value - localNodes }, site); localNodes = value; },
    get rows() { return localRows; }, set rows(value) { expect(state, value <= P0_LIMITS.rows, "resource_limit", site); localRows = value; },
    units(count) { chargeState(state, { work: count }, site); },
    text(bytes, passes = 1) { chargeState(state, { bytes: bytes * passes, work: Math.max(0, passes - 1) }, site); },
    fail(code = "invalid_value"): never { throwP0(state, { code, rule: "PC1B-RAW01", ...(site ? { site } : {}) }); },
  };
}
export function canonicalP0(request: P0Request, value: unknown, site?: P0Site): string {
  const state = p0State(request), count = countAndCheck(state, value, site);
  return encodeHistoryCarrierValue(value, accounting(state, count, site));
}
// The scanner already owns a frozen, well-formed exact-integer tree. Reserve only
// the shared typed grammar, not a second parse, carrier encoding or unused table digests.
// Retain the prior consumer's bound of four string reads and 12 operations/node.
// The UTF-8 size scan is separately prepaid (at most three bytes per UTF-16 unit).
function reserveOwnedObservationShape(state: P0State, value: unknown, site: P0Site): void {
  let nodes = 0, stringBytes = 0;
  const string = (text: string): void => {
    chargeState(state, { bytes: text.length * 3 }, site);
    stringBytes += Buffer.byteLength(text, "utf8");
  };
  const visit = (node: unknown): void => {
    chargeState(state, { work: 1 }, site); nodes++;
    if (typeof node === "string") string(node);
    else if (Array.isArray(node)) node.forEach(visit);
    else if (node !== null && typeof node === "object") for (const key of Object.keys(node)) {
      chargeState(state, { work: 1 }, site); nodes++; string(key); visit((node as Record<string, unknown>)[key]);
    }
  };
  visit(value);
  // Fixed punctuation/short tags and repeated phase/contract checks are bounded
  // by four bytes/node plus the original finite 72-table overhead.
  chargeState(state, { work: nodes * 12 + 72 * 72, bytes: stringBytes * 4 + nodes * 4 + 72 * 72 }, site);
}
function ownerSite(state: P0State, observation: Record<string, unknown>, path: readonly string[]): P0Site {
  const location: P0Location = { inputPart: "observation", artifactOrdinal: null, table: null,
    rowOrdinal: null, columnOrdinal: null, pathId: "observation.root" };
  const contract = path[0] === "tables" ? contracts.find(t => t.name === path[1]) : undefined;
  let rowOrdinal: number | null = null, columnOrdinal: number | null = null;
  if (contract && Array.isArray(observation.tables) && path[2] === "rows" && /^(0|[1-9][0-9]*)$/.test(path[3] ?? "")) {
    const rawTable = observation.tables[contracts.indexOf(contract)] as { rows?: unknown } | undefined;
    const ordinal = Number(path[3]);
    if (Number.isSafeInteger(ordinal) && Array.isArray(rawTable?.rows) && ordinal < rawTable.rows.length) rowOrdinal = ordinal;
    if (rowOrdinal !== null && path[4] === "cells" && /^(0|[1-9][0-9]*)$/.test(path[5] ?? "")) {
      const column = Number(path[5]); if (Number.isSafeInteger(column) && column < contract.columnsP0.length) columnOrdinal = column + 1;
    }
  }
  return makeP0Site(state, { depth: 2, phase: "original-graph", location: { ...location, table: contract?.name as P0Table ?? null,
    rowOrdinal, columnOrdinal, pathId: columnOrdinal === null ? "observation.root" : "row.cell" } });
}
// #153/7010276882: discriminate only the fixed, known future branches after this
// request's scanner. This is no second parse, budget or semantic success path.
function knownBranchRef(state: P0State, value: unknown): void {
  const item = object(state, value, ["ref", "sha256", "bytes"]);
  expect(state, typeof item.ref === "string" && item.ref.length > 0
    && typeof item.sha256 === "string" && hash.test(item.sha256)
    && typeof item.bytes === "string" && item.bytes.length <= 20 && /^(?:0|[1-9][0-9]*)$/.test(item.bytes), "unsupported_shape");
  chargeState(state, { work: 3, bytes: (item.ref as string).length * 2 + 84 });
}
function knownBranchOrigin(state: P0State, value: unknown): void {
  const origin = object(state, value, ["sourceHistory", "importManifest"]);
  knownBranchRef(state, origin.sourceHistory);
  if (origin.importManifest !== null) knownBranchRef(state, origin.importManifest);
}
function knownBranchEnvelope(state: P0State, envelope: Record<string, unknown>): void {
  expect(state, Array.isArray(envelope.artifacts) && Array.isArray(envelope.evidence), "unsupported_shape");
  expect(state, envelope.artifacts.length <= P0_LIMITS.artifacts && envelope.evidence.length <= P0_LIMITS.evidence, "resource_limit");
  for (const entry of envelope.artifacts) {
    const artifact = object(state, entry, ["kind", "artifact", "bytesHex"]);
    expect(state, typeof artifact.kind === "string" && artifact.kind.length > 0 && typeof artifact.bytesHex === "string", "unsupported_shape");
    knownBranchRef(state, artifact.artifact);
  }
  for (const entry of envelope.evidence) {
    const selected = object(state, entry, ["kind", "artifact", "evidence"]);
    expect(state, typeof selected.kind === "string" && selected.kind.length > 0, "unsupported_shape");
    knownBranchRef(state, selected.artifact);
    const evidence = object(state, selected.evidence, ["artifactId", "digest"]);
    expect(state, typeof evidence.artifactId === "string" && evidence.artifactId.length > 0
      && typeof evidence.digest === "string" && hash.test(evidence.digest), "unsupported_shape");
  }
  if (envelope.proposedDeletion !== null) {
    const deletion = object(state, envelope.proposedDeletion, ["rows"]);
    expect(state, Array.isArray(deletion.rows), "unsupported_shape");
    for (const item of deletion.rows) {
      const selector = object(state, item, ["table", "key", "rowid"]);
      expect(state, typeof selector.table === "string" && Array.isArray(selector.key)
        && (selector.rowid === null || typeof selector.rowid === "string"), "unsupported_shape");
    }
  }
}
function knownP1Observation(state: P0State, value: unknown): void {
  const observation = object(state, value, ["contract", "backend", "phase", "configFormat", "source",
    "physicalSourceRef", "snapshotReceiptRef", "catalog", "textEncoding", "tables", "sequences"]);
  expect(state, observation.phase === "p1", "unsupported_shape");
  const site = makeP0Site(state, { depth: 2, phase: "input", location: {
    inputPart: "observation", artifactOrdinal: null, table: null, rowOrdinal: null,
    columnOrdinal: null, pathId: "observation.root" } });
  reserveOwnedObservationShape(state, observation, site);
  try { validateHistoryObservationValue(observation); }
  catch (error) {
    if (!historyValueFailure(error)) throw error;
    throwP0(state, { code: "unsupported_shape", rule: "PC1B-RAW01", site });
  }
}
function unimplementedBranch(state: P0State): never {
  throwP0(state, { code: "semantic_unsupported", rule: "PC1B-RAW01", condition: "undefined-grammar" });
}
function otherKnownGraph(state: P0State, envelope: Record<string, unknown>): void {
  chargeState(state, { work: 1 });
  const value = envelope.graph;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "p1-source-cut") {
    knownBranchEnvelope(state, envelope);
    const graph = object(state, value, ["kind", "cut", "origin"]);
    knownBranchRef(state, graph.cut); knownBranchOrigin(state, graph.origin); unimplementedBranch(state);
  }
  if (kind === "p1-source-history") {
    knownBranchEnvelope(state, envelope);
    const graph = object(state, value, ["kind", "observation", "snapshotLink", "origin"]);
    knownP1Observation(state, graph.observation); knownBranchRef(state, graph.snapshotLink);
    knownBranchOrigin(state, graph.origin); unimplementedBranch(state);
  }
  if (kind === "layout-history") {
    knownBranchEnvelope(state, envelope);
    const graph = object(state, value, ["kind", "history", "origin"]);
    knownBranchRef(state, graph.history); knownBranchOrigin(state, graph.origin); unimplementedBranch(state);
  }
}
export function createP0Request(input: unknown): P0Result<P0Request> {
  if (typeof input !== "string") return Object.freeze({ ok: false, error: fixedError("unsupported_shape") });
  const state = newP0State();
  try {
    const parsed = scanP0Json(state, input, state.rootSite, { policy: "reference", outer: true });
    const envelope = object(state, parsed, ["contract", "graph", "artifacts", "evidence", "proposedDeletion"]);
    expect(state, envelope.contract === "m2-history-closure-input/r2", "unsupported_shape");
    otherKnownGraph(state, envelope);
    const graph = object(state, envelope.graph, ["kind", "observation", "origin"]);
    expect(state, graph.kind === "m2-observation", "unsupported_shape");
    expect(state, graph.observation !== null && typeof graph.observation === "object" && !Array.isArray(graph.observation), "unsupported_shape");
    const observation = graph.observation as Record<string, unknown>;
    if (observation.phase === "p1") {
      knownBranchEnvelope(state, envelope); knownP1Observation(state, observation);
      knownBranchOrigin(state, graph.origin); unimplementedBranch(state);
    }
    expect(state, graph.origin === null, "unsupported_shape");
    expect(state, observation.phase === "p0", "unsupported_shape");
    expect(state, observation.backend === "sqlite" || observation.backend === "postgres", "unsupported_shape");
    selections(state, envelope.artifacts, envelope.evidence);
    ref(state, observation.catalog); evidenceRef(state, observation.physicalSourceRef); evidenceRef(state, observation.snapshotReceiptRef);
    const encoding = object(state, observation.textEncoding, ["backend", "name"]);
    expect(state, encoding.backend === observation.backend && encoding.name === (observation.backend === "sqlite" ? "UTF-8" : "UTF8"), "source_contract_mismatch");
    expect(state, Array.isArray(observation.tables), "unsupported_shape");
    let rows = 0;
    for (const table of observation.tables) {
      expect(state, table !== null && typeof table === "object" && !Array.isArray(table), "unsupported_shape");
      const rawTable = table as Record<string, unknown>; ref(state, rawTable.columnContract);
      expect(state, Array.isArray(rawTable.rows), "unsupported_shape");
      rows += rawTable.rows.length;
      expect(state, rows <= P0_LIMITS.rows, "resource_limit");
    }
    state.usage.rows = rows;
    if (Array.isArray(observation.sequences)) for (const sequence of observation.sequences) {
      expect(state, sequence !== null && typeof sequence === "object" && !Array.isArray(sequence), "unsupported_shape");
      ref(state, (sequence as Record<string, unknown>).relationIdentity);
    }
    rawDeletion(state, envelope.proposedDeletion, observation.backend);
    const site = ownerSite(state, observation, []);
    reserveOwnedObservationShape(state, observation, site);
    try { validateHistoryObservationValue(observation); }
    catch (error) {
      const known = historyValueFailure(error);
      if (!known) throw error;
      const code = known.code === "budget_exceeded" ? "resource_limit"
        : known.code === "incomplete_universe" || known.code === "column_contract_mismatch" ? "source_contract_mismatch"
        : known.code === "row_mismatch" ? "semantic_invariant_failed" : known.code;
      throwP0(state, { code, rule: "PC1B-RAW01", site: ownerSite(state, observation, known.path) });
    }
    const value = parsed as P0Input;
    const handles: P0Row[] = [];
    for (const [tableOrdinal, table] of value.graph.observation.tables.entries()) for (const [rowOrdinal, raw] of table.rows.entries()) {
      chargeState(state, { work: 1 });
      const row = Object.freeze({ table: P0_TABLE_NAMES[tableOrdinal]!, tableOrdinal, rowOrdinal, raw }) as P0Row;
      state.rows.add(row); state.rowDepths.set(row, (state.depths.get(raw) ?? 6) + 4); handles.push(row);
    }
    const original = buildP0View(state, handles, "original-graph");
    const request = Object.freeze({ input: value, original }) as P0Request;
    bindP0State(request, state);
    return Object.freeze({ ok: true, value: request });
  } catch (error) { return Object.freeze({ ok: false, error: catchP0(state, error) }); }
}

import { P0_RULES, M2_ALL_TABLE_NAMES } from "./m2-p0-types.ts";
import type { P0Code, P0Condition, P0Cost, P0Error, P0Failure, P0Location, P0Path, P0Request,
  P0Result, P0Row, P0Site, P0Usage, P0View } from "./m2-p0-types.ts";

export const P0_LIMITS = Object.freeze({ outerBytes: 16 * 1024 * 1024, selectedBytes: 8 * 1024 * 1024,
  artifactBytes: 4 * 1024 * 1024, artifacts: 4096, evidence: 4096, nodes: 250_000, depth: 64,
  rows: 100_000, tuples: 250_000, bytes: 64 * 1024 * 1024, work: 4_000_000, output: 1024 * 1024 });
const inputLocation: P0Location = Object.freeze({ inputPart: "input", artifactOrdinal: null, table: null,
  rowOrdinal: null, columnOrdinal: null, pathId: "input.root" });
const CODES = new Set<P0Code>(["unsupported_shape", "invalid_value", "source_contract_mismatch", "semantic_unsupported",
  "semantic_invariant_failed", "artifact_missing", "artifact_bytes_mismatch", "artifact_kind_unsupported",
  "artifact_semantic_mismatch", "retained_reference_conflict", "format_unregistered", "resource_limit"]);
const CONDITIONS = new Set<P0Condition>(["missing-target", "scope-mismatch", "state-mismatch", "count-mismatch", "history-gap",
  "identity-mismatch", "source-mismatch", "format-mismatch", "bytes-mismatch", "immutable-history-mismatch", "phase-mismatch",
  "duplicate-key", "conditional-target-required", "negative-invariant", "unsupported-value", "undefined-grammar", "budget-exceeded"]);
const PATHS = new Set<P0Path>(["input.root", "observation.root", "artifact.root", "row.cell", ...P0_RULES.map(r => `${r}.P01` as const)]);
const rules = new Set<string>(P0_RULES), tables = new Set<string>(M2_ALL_TABLE_NAMES);
export interface P0SiteData { readonly depth: number; readonly location: P0Location; readonly phase: P0Site["phase"] }
type Usage = { -readonly [K in keyof P0Usage]: P0Usage[K] };
export interface P0State {
  readonly failures: WeakMap<object, P0Error>;
  readonly sites: WeakMap<object, P0SiteData>;
  readonly rows: WeakSet<object>;
  readonly views: WeakMap<object, ReadonlySet<P0Row>>;
  readonly rowDepths: WeakMap<object, number>;
  readonly depths: WeakMap<object, number>;
  readonly jsonHeights: WeakMap<object, number>;
  readonly parsedCells: WeakMap<object, Map<string, unknown>>;
  readonly textCells: WeakMap<object, Map<string, { readonly value: string; readonly bytes: number }>>;
  readonly usage: Usage;
  readonly rootSite: P0Site;
  poisoned: object | null;
  request: P0Request | null;
}
const states = new WeakMap<object, P0State>();
const actualStates = new WeakSet<object>();
const isObject = (v: unknown): v is object => (typeof v === "object" && v !== null) || typeof v === "function";
export function fixedError(code: P0Code = "invalid_value", location: P0Location | null = null): P0Error {
  const conflict = location ? Object.freeze({ rule: "PC1B-RAW01" as const, source: location, target: null,
    condition: code === "resource_limit" ? "budget-exceeded" as const : "unsupported-value" as const }) : null;
  return Object.freeze({ code, phase: "input", rule: location ? "PC1B-RAW01" : null, location,
    conflicts: Object.freeze(conflict ? [conflict] : []), moreConflicts: false });
}
export function newP0State(): P0State {
  const rootSite = Object.freeze({ location: inputLocation, phase: "input" }) as P0Site;
  const state: P0State = { failures: new WeakMap(), sites: new WeakMap(), rows: new WeakSet(), views: new WeakMap(),
    rowDepths: new WeakMap(), depths: new WeakMap(), jsonHeights: new WeakMap(), parsedCells: new WeakMap(), textCells: new WeakMap(),
    // Reserve finite unknown/failure serialization even after exhaustion; never expose raw selectors.
    usage: { work: 128, bytes: 4096, tuples: 0, nodes: 0, rows: 0, selectedBytes: 0 }, rootSite, poisoned: null, request: null };
  state.sites.set(rootSite, { depth: 0, location: inputLocation, phase: "input" });
  actualStates.add(state);
  return state;
}
export function assertP0State(state: P0State): void {
  if (!isObject(state) || !actualStates.has(state)) throw UNKNOWN_REQUEST;
}
export function bindP0State(request: P0Request, state: P0State): void { states.set(request, state); state.request = request; }
export function p0State(request: P0Request): P0State {
  const state = isObject(request) ? states.get(request) : undefined;
  if (!state) throw UNKNOWN_REQUEST;
  return state;
}
const UNKNOWN_REQUEST = Object.freeze({});
export function catchP0(state: P0State | undefined, error: unknown): P0Error {
  if (state?.poisoned) return state.failures.get(state.poisoned)!;
  return isObject(error) ? state?.failures.get(error) ?? fixedError() : fixedError();
}
export function siteData(state: P0State, site: P0Site | undefined): P0SiteData {
  if (site === undefined) return state.sites.get(state.rootSite)!;
  const data = isObject(site) ? state.sites.get(site) : undefined;
  if (!data) throw UNKNOWN_REQUEST;
  return data;
}
export function makeP0Site(state: P0State, data: P0SiteData): P0Site {
  if (!Number.isSafeInteger(data.depth) || data.depth < 0 || data.depth > P0_LIMITS.depth) {
    throwP0(state, { code: "resource_limit", rule: "PC1B-RAW01" });
  }
  const location = data.location;
  if (!PATHS.has(location.pathId) || location.table !== null && !tables.has(location.table)) throw UNKNOWN_REQUEST;
  const site = Object.freeze({ location: Object.freeze({ ...location }), phase: data.phase }) as P0Site;
  state.sites.set(site, { ...data, location: site.location }); return site;
}
export function throwP0(state: P0State, failure: P0Failure): never {
  if (!CODES.has(failure.code) || failure.rule !== null && !rules.has(failure.rule)
    || failure.condition !== undefined && !CONDITIONS.has(failure.condition)) throw UNKNOWN_REQUEST;
  const { location, phase } = siteData(state, failure.site);
  const target = failure.target === undefined || failure.target === null ? null : siteData(state, failure.target).location;
  const code = phase === "retained-graph" && failure.code === "semantic_invariant_failed"
    ? "retained_reference_conflict" : failure.code;
  const condition = failure.condition ?? (code === "resource_limit" ? "budget-exceeded" : "unsupported-value");
  const conflict = failure.rule === null ? null : Object.freeze({ rule: failure.rule, source: location, target, condition });
  const error: P0Error = Object.freeze({ code, phase, rule: failure.rule,
    location: failure.rule === null ? null : location, conflicts: Object.freeze(conflict ? [conflict] : []), moreConflicts: false });
  const token = Object.freeze({}); state.failures.set(token, error);
  if (code === "resource_limit") state.poisoned = token;
  throw token;
}
export function failP0(request: P0Request, failure: P0Failure): never { throwP0(p0State(request), failure); }
export function chargeState(state: P0State, cost: P0Cost, site?: P0Site): void {
  if (state.poisoned) throw state.poisoned;
  const work = (cost.work ?? 0) + Math.ceil((cost.bytes ?? 0) / 64);
  const charges = { work, bytes: cost.bytes ?? 0, tuples: cost.tuples ?? 0, nodes: cost.nodes ?? 0 };
  for (const key of ["work", "bytes", "tuples", "nodes"] as const) {
    const amount = charges[key], next = state.usage[key] + amount;
    if (!Number.isSafeInteger(amount) || amount < 0 || !Number.isSafeInteger(next) || next > P0_LIMITS[key]) {
      throwP0(state, { code: "resource_limit", rule: "PC1B-RAW01", ...(site ? { site } : {}) });
    }
  }
  for (const key of ["work", "bytes", "tuples", "nodes"] as const) state.usage[key] += charges[key];
}
export function chargeP0(request: P0Request, cost: P0Cost, site?: P0Site): void { chargeState(p0State(request), cost, site); }
export function p0Usage(request: P0Request): P0Usage { return Object.freeze({ ...p0State(request).usage }); }
export function withP0Guard<T>(request: P0Request, work: () => T): P0Result<T> {
  let state: P0State | undefined;
  try { state = p0State(request); if (state.poisoned) throw state.poisoned;
    const value = work(); if (state.poisoned) throw state.poisoned;
    return Object.freeze({ ok: true, value }); }
  catch (error) { return Object.freeze({ ok: false, error: catchP0(state, error) }); }
}
export function assertRow(state: P0State, row: P0Row): void {
  if (!isObject(row) || !state.rows.has(row)) throw UNKNOWN_REQUEST;
}
export function assertView(state: P0State, view: P0View): ReadonlySet<P0Row> {
  const rows = isObject(view) ? state.views.get(view) : undefined;
  if (!rows) throw UNKNOWN_REQUEST; return rows;
}
// Public only to sibling P0 family modules. No state, rows, map or proof bit escapes.
export function assertP0View(request: P0Request, view: P0View): void { assertView(p0State(request), view); }
export function freezeP0Data<T>(state: P0State, value: T): T {
  const visit = (node: unknown): void => {
    chargeState(state, { work: 1 });
    if (node !== null && typeof node === "object" && !Object.isFrozen(node)) {
      for (const key of Object.keys(node)) { chargeState(state, { work: 1 }); visit((node as Record<string, unknown>)[key]); }
      Object.freeze(node);
    }
  };
  visit(value); return value;
}

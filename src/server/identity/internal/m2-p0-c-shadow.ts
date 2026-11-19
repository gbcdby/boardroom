import type { z } from 'zod';
import { M2_HISTORY_TABLES } from '../m2-history-contracts.ts';
import { DECISION_TABLE_NAMES } from '../../decisions/tables.ts';
import { assertP0View, canonicalP0, chargeP0, createP0TupleIndex, failP0, p0RowSite, readP0Json, readP0SafeInteger, readP0Text } from './m2-p0.ts';
import type { P0Condition, P0JsonPolicy, P0Request, P0Row, P0Rule, P0Site, P0Table, P0TupleIndex, P0View } from './m2-p0.ts';

export type CScalar = string | number | null;
export interface CRow { readonly origin: P0Row; readonly values: Readonly<Record<string, CScalar>>; }
export type CObject = Record<string, unknown>;
declare const storageSyntaxFrameBrand: unique symbol;
export interface P0CStorageSyntaxFrame { readonly [storageSyntaxFrameBrand]: true; }
interface StorageSyntaxState {
  readonly request: P0Request;
  readonly view: P0View;
  readonly graph: P0CContext['graph'];
  readonly rows: WeakMap<object, CRow>;
}
const contexts = new WeakMap<P0CContext, StorageSyntaxState>();
const syntaxFrames = new WeakMap<P0CStorageSyntaxFrame, StorageSyntaxState>();
const unknownContext = Object.freeze({});
/** The caller supplies an actual pass, never a parsed value or success flag. */
export function createP0CStorageSyntaxFrame(context: P0CContext): P0CStorageSyntaxFrame {
  const state = contexts.get(context); if (!state) throw unknownContext;
  chargeP0(state.request, { work: 2, tuples: 2 });
  const frame = Object.freeze({}) as P0CStorageSyntaxFrame; syntaxFrames.set(frame, state); return frame;
}
export function assertP0CStorageSyntaxFrame(frame: P0CStorageSyntaxFrame, graph: object): void {
  const state = syntaxFrames.get(frame); if (!state || state.graph !== graph) throw unknownContext;
  chargeP0(state.request, { work: 1 });
}
/** Only A's private syntax failure can make legacy display unavailable. Native
 * parser failures never enter this result; valid values are still parsed by the
 * actual old consumer. Binding includes this exact pass's shadow and A row. */
export function p0CAuditDetailUnavailable(frame: P0CStorageSyntaxFrame, audit: object): boolean {
  const state = syntaxFrames.get(frame); if (!state) throw unknownContext;
  chargeP0(state.request, { work: 8, tuples: 4 });
  const row = state.rows.get(audit); if (!row || row.origin.table !== 'audit_log') throw unknownContext;
  const site = p0RowSite(state.request, state.view, row.origin, 'detail', 'PC1B-WE03.P01');
  return readP0Json(state.request, row.origin, 'detail', 'legacy-display', site) === undefined;
}
const FULL = new Set<string>([...DECISION_TABLE_NAMES, 'tasks', 'task_review_rounds', 'task_review_reports',
  'task_history', 'task_comments', 'task_message_links', 'project_task_settings', 'work_events', 'work_event_delivery_invalidations']);
const PARTIAL: Readonly<Partial<Record<P0Table, readonly string[]>>> = Object.freeze({
  projects: ['id'], members: ['id', 'project_id', 'kind', 'agent_id', 'removed_at', 'membership_revision'],
  groups: ['id', 'project_id'], messages: ['id', 'group_id'],
  audit_log: ['id', 'scope', 'project_id', 'action', 'target_kind', 'target_id', 'created_at', 'before', 'after', 'detail'],
  policy_documents: ['scope_key', 'scope', 'project_id'],
  policy_document_versions: ['document_id', 'revision', 'content_digest'],
});

/** Only caller-inaccessible rows from A are projected. No original bytes are rewritten. */
export class P0CContext {
  readonly request: P0Request;
  readonly view: P0View;
  readonly graph: Readonly<Record<string, readonly Readonly<Record<string, CScalar>>[]>>;
  private readonly tables = new Map<P0Table, readonly CRow[]>();
  private readonly indexes = new Map<string, P0TupleIndex<CRow>>();
  private readonly parsed = new WeakMap<CRow, Map<string, unknown>>();
  private readonly measures = new WeakMap<object, number>();
  private readonly origins = new WeakMap<object, CRow>();
  constructor(request: P0Request, view: P0View) {
    assertP0View(request, view);
    this.request = request; this.view = view;
    const graph: Record<string, readonly Readonly<Record<string, CScalar>>[]> = {};
    for (const table of M2_HISTORY_TABLES) {
      const name = table.name as P0Table, selected = FULL.has(name) ? table.columnsP0.map(c => c.name) : PARTIAL[name];
      if (!selected) continue;
      const rows: CRow[] = [];
      for (const origin of view.rows(name)) {
        chargeP0(request, { work: selected.length + 1, tuples: 1 }, p0RowSite(request, view, origin));
        const values: Record<string, CScalar> = {};
        for (const column of selected) {
          const spec = table.columnsP0.find(c => c.name === column)!;
          const site = p0RowSite(request, view, origin, column);
          values[column] = spec.sqliteDeclaredType === 'INTEGER' || spec.sqliteDeclaredType === 'BIGINT'
            ? readP0SafeInteger(request, origin, column, site) : readP0Text(request, origin, column, site);
        }
        const row = Object.freeze({ origin, values: Object.freeze(values) });
        this.origins.set(values, row); rows.push(row);
      }
      const frozen = Object.freeze(rows); this.tables.set(name, frozen);
      graph[name] = Object.freeze(rows.map(row => row.values));
    }
    this.graph = Object.freeze(graph);
    chargeP0(request, { work: 6, tuples: 2 });
    contexts.set(this, Object.freeze({ request, view, graph: this.graph, rows: this.origins }));
  }
  rows(table: P0Table): readonly CRow[] { return this.tables.get(table) ?? []; }
  originalRow(shadow: object): CRow | undefined { return this.origins.get(shadow); }
  site(row: CRow, rule: P0Rule, column?: string) { return p0RowSite(this.request, this.view, row.origin, column, `${rule}.P01`); }
  fail(row: CRow, rule: P0Rule, condition: P0Condition, column?: string, target?: CRow | null): never {
    return failP0(this.request, { code: 'semantic_invariant_failed', rule, condition, site: this.site(row, rule, column),
      target: target ? this.site(target, rule) : null });
  }
  invalid(row: CRow, rule: P0Rule, column?: string): never {
    return failP0(this.request, { code: 'invalid_value', rule, condition: 'format-mismatch', site: this.site(row, rule, column) });
  }
  find(table: P0Table, value: CScalar, column = 'id'): CRow | undefined {
    if (value === null) return undefined;
    const name = `${table}.${column}`;
    let index = this.indexes.get(name);
    if (!index) {
      index = createP0TupleIndex<CRow>(this.request);
      for (const row of this.rows(table)) {
        const key = row.values[column];
        if (key !== undefined && key !== null && index.insert([key], row)) this.fail(row, 'PC1B-KEY01', 'duplicate-key', column);
      }
      this.indexes.set(name, index);
    }
    return index.get([value]);
  }
  text(row: CRow, column: string, rule: P0Rule, nullable = false): string | null {
    const value = row.values[column];
    if (typeof value === 'string' || nullable && value === null) return value;
    return this.invalid(row, rule, column);
  }
  integer(row: CRow, column: string, rule: P0Rule, minimum = 1, nullable = false): number | null {
    const value = row.values[column];
    if (nullable && value === null || typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum) return value as number | null;
    return this.invalid(row, rule, column);
  }
  json(row: CRow, column: string, rule: P0Rule, policy: P0JsonPolicy = 'reference'): unknown {
    let cache = this.parsed.get(row); if (!cache) { cache = new Map(); this.parsed.set(row, cache); }
    const key = `${column}/${policy}`;
    if (cache.has(key)) { chargeP0(this.request, { work: 1 }, this.site(row, rule, column)); return cache.get(key); }
    const value = readP0Json(this.request, row.origin, column, policy, this.site(row, rule, column));
    cache.set(key, value); return value;
  }
  bytes(row: CRow, column?: string): number {
    const columns = M2_HISTORY_TABLES[row.origin.tableOrdinal]?.name === row.origin.table
      ? M2_HISTORY_TABLES[row.origin.tableOrdinal]!.columnsP0
      : M2_HISTORY_TABLES.find(table => table.name === row.origin.table)!.columnsP0;
    let bytes = 0;
    for (let i = 0; i < columns.length; i++) {
      if (column !== undefined && columns[i]!.name !== column) continue;
      const cell = row.origin.raw.cells[i]!;
      if (cell[0] === 'text' || cell[0] === 'blob') bytes += cell[1]!.length / 2;
      else if (cell[0] === 'pg-binary') bytes += cell[2]!.length / 2;
      else if (cell[0] !== 'null') bytes += cell[1]!.length;
    }
    return bytes;
  }
  nodeCount(value: unknown): number {
    if (value === null || typeof value !== 'object') { chargeP0(this.request, { work: 1 }); return 1; }
    const cached = this.measures.get(value); if (cached !== undefined) return cached;
    chargeP0(this.request, { work: 1 }); let count = 1;
    if (Array.isArray(value)) for (const item of value) count += this.nodeCount(item);
    else for (const key in value) {
      chargeP0(this.request, { work: 1 });
      if (Object.hasOwn(value, key)) count += 1 + this.nodeCount((value as CObject)[key]);
    }
    this.measures.set(value, count); return count;
  }
  /** A legacy native sort has no injected comparator meter. Reserve a quadratic
   * comparison bound, including both UTF-16 operands, before entering it. */
  reserveStringSort(value: unknown, field?: string, passes = 1, site?: P0Site): void {
    if (!Array.isArray(value)) return;
    const length = value.length;
    chargeP0(this.request, { work: (length * length + length) * passes }, site);
    let units = 0;
    for (const item of value) {
      const text = field === undefined ? item : cObject(item) ? item[field] : undefined;
      if (typeof text === 'string') units += text.length;
    }
    chargeP0(this.request, { bytes: units * 4 * length * passes }, site);
  }
  reserveCanonicalKeys(value: unknown, passes: number, site?: P0Site): void {
    // Count the already-owned tree without cloning it. Reserve the walk, stack
    // records and key arrays before allocating them. Legacy whole-row values
    // need not have the bounded nesting of a strict Decision TEXT schema.
    const nodes = this.nodeCount(value);
    chargeP0(this.request, { work: nodes * 4, tuples: nodes * 2 }, site);
    const pending: { value: unknown; depth: number }[] = [{ value, depth: 1 }];
    while (pending.length) {
      const { value: current, depth } = pending.pop()!;
      let encodedBytes: number;
      if (Array.isArray(current)) {
        encodedBytes = 4 + Math.max(0, current.length - 1) * 2;
        for (const entry of current) pending.push({ value: entry, depth: depth + 1 });
      }
      else if (cObject(current)) {
        const keys = Object.keys(current); this.reserveStringSort(keys, undefined, passes, site);
        encodedBytes = 4 + Math.max(0, keys.length - 1) * 2;
        for (const key of keys) {
          encodedBytes += key.length * 12 + 6;
          pending.push({ value: current[key], depth: depth + 1 });
        }
      } else encodedBytes = typeof current === 'string' ? current.length * 12 + 4 : typeof current === 'number' ? 64 : 10;
      // One UTF-16 unit may escape to six ASCII units (two bytes each); a
      // finite JS number needs at most 32 output units, even if input used an
      // exponent. Six copies/scans per ancestor bound stringify, key/value
      // interpolation, join and the enclosing braces/brackets. Charge every
      // level of every actual native pass before entering the old encoder.
      chargeP0(this.request, { bytes: encodedBytes * depth * 6 * passes }, site);
    }
  }
  schema<T>(row: CRow, column: string, rule: P0Rule, schema: z.ZodType<T>, value = this.json(row, column, rule)): T {
    const nodes = this.nodeCount(value);
    chargeP0(this.request, { bytes: this.bytes(row, column) * 2, work: nodes * 2, nodes }, this.site(row, rule, column));
    const parsed = schema.safeParse(value);
    if (!parsed.success) return this.invalid(row, rule, column);
    // The persistent value, including transformed schema fields, must remain unchanged.
    if (!this.equal(value, parsed.data, row, rule, column)) return this.invalid(row, rule, column);
    return value as T;
  }
  equal(left: unknown, right: unknown, row: CRow, rule: P0Rule, column?: string): boolean {
    const site = this.site(row, rule, column);
    return canonicalP0(this.request, left, site) === canonicalP0(this.request, right, site);
  }
  sameScope(source: CRow, target: CRow | undefined, rule: P0Rule, column?: string, task = false): CRow {
    if (!target) return this.fail(source, rule, 'missing-target', column);
    if (source.values.project_id !== target.values.project_id || task && source.values.task_id !== (target.origin.table === 'tasks' ? target.values.id : target.values.task_id))
      return this.fail(source, rule, 'scope-mismatch', column, target);
    return target;
  }
}

export const cObject = (value: unknown): value is CObject => value !== null && typeof value === 'object' && !Array.isArray(value);

import { M2_HISTORY_TABLES } from '../m2-history-contracts.ts';
import { assertP0View, chargeP0, createP0TupleIndex, failP0, p0RowSite, readP0Json, readP0SafeInteger, readP0Text } from './m2-p0.ts';
import type { P0Condition, P0JsonPolicy, P0Request, P0Row, P0Rule, P0Site, P0Table, P0TupleIndex, P0View } from './m2-p0.ts';

export type DScalar = string | number | null;
export type DObject = Record<string, unknown>;
export interface DRow { readonly origin: P0Row; readonly values: Readonly<Record<string, DScalar>>; }
const FULL = new Set<P0Table>(['audit_log', 'memory_documents', 'memory_versions', 'memory_summary_requests',
  'memory_message_receipts', 'memory_trigger_counters', 'memory_scan_checkpoints', 'work_events']);
const PARTIAL: Readonly<Partial<Record<P0Table, readonly string[]>>> = Object.freeze({
  projects: ['id'], agents: ['id'], members: ['id', 'project_id', 'kind', 'agent_id'],
  groups: ['id', 'project_id'], messages: ['id', 'group_id'], tasks: ['id', 'project_id'],
});

/** A authenticates the view before any property read; all projected values retain
 * their original row identity and ordinal. A owns decoding and its shared meter. */
export class P0DContext {
  readonly request: P0Request;
  readonly view: P0View;
  private readonly tables = new Map<P0Table, readonly DRow[]>();
  private readonly indexes = new Map<string, P0TupleIndex<DRow>>();
  private readonly origins = new WeakMap<object, DRow>();
  constructor(request: P0Request, view: P0View) {
    assertP0View(request, view); this.request = request; this.view = view;
    for (const table of M2_HISTORY_TABLES) {
      const name = table.name as P0Table;
      const columns = FULL.has(name) ? table.columnsP0 : table.columnsP0.filter(column => PARTIAL[name]?.includes(column.name));
      if (!columns.length) continue;
      const rows: DRow[] = [];
      for (const origin of view.rows(name)) {
        chargeP0(request, { work: columns.length + 2, tuples: 1 }, p0RowSite(request, view, origin));
        const values: Record<string, DScalar> = {};
        for (const column of columns) {
          const site = p0RowSite(request, view, origin, column.name);
          values[column.name] = column.sqliteDeclaredType === 'INTEGER' || column.sqliteDeclaredType === 'BIGINT'
            ? readP0SafeInteger(request, origin, column.name, site) : readP0Text(request, origin, column.name, site);
        }
        const row = Object.freeze({ origin, values: Object.freeze(values) });
        this.origins.set(values, row); rows.push(row);
      }
      this.tables.set(name, Object.freeze(rows));
    }
  }
  rows(table: P0Table): readonly DRow[] { return this.tables.get(table) ?? []; }
  originalRow(value: object): DRow | undefined { return this.origins.get(value); }
  site(row: DRow, rule: P0Rule, column?: string): P0Site { return p0RowSite(this.request, this.view, row.origin, column, `${rule}.P01`); }
  fail(row: DRow, rule: P0Rule, condition: P0Condition, column?: string, target?: DRow | null): never {
    return failP0(this.request, { code: 'semantic_invariant_failed', rule, condition, site: this.site(row, rule, column),
      target: target ? this.site(target, rule) : null });
  }
  invalid(row: DRow, rule: P0Rule, column?: string): never {
    return failP0(this.request, { code: 'invalid_value', rule, condition: 'format-mismatch', site: this.site(row, rule, column) });
  }
  unsupported(row: DRow, rule: P0Rule, column?: string): never {
    return failP0(this.request, { code: 'semantic_unsupported', rule, condition: 'undefined-grammar', site: this.site(row, rule, column) });
  }
  find(table: P0Table, value: DScalar, column = 'id'): DRow | undefined {
    if (value === null) return undefined;
    const name = `${table}.${column}`;
    let index = this.indexes.get(name);
    if (!index) {
      index = createP0TupleIndex<DRow>(this.request);
      for (const row of this.rows(table)) {
        const key = row.values[column];
        if (key !== null && key !== undefined && index.insert([key], row)) this.fail(row, 'PC1B-KEY01', 'duplicate-key', column);
      }
      this.indexes.set(name, index);
    }
    return index.get([value]);
  }
  text(row: DRow, column: string, rule: P0Rule, nullable = false): string | null {
    const value = row.values[column];
    if (typeof value === 'string' || nullable && value === null) return value;
    return this.invalid(row, rule, column);
  }
  id(row: DRow, column: string, rule: P0Rule, nullable = false): string | null {
    const value = this.text(row, column, rule, nullable);
    if (value === null) return null;
    chargeP0(this.request, { work: 2, bytes: value.length * 4 }, this.site(row, rule, column));
    if (value.length > 512 || !value.trim() || value.includes('\0')) this.invalid(row, rule, column);
    return value;
  }
  integer(row: DRow, column: string, rule: P0Rule, minimum = 1, nullable = false): number | null {
    const value = row.values[column];
    if (nullable && value === null || typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum) return value as number | null;
    return this.invalid(row, rule, column);
  }
  json(row: DRow, column: string, rule: P0Rule, policy: P0JsonPolicy = 'reference'): unknown {
    return readP0Json(this.request, row.origin, column, policy, this.site(row, rule, column));
  }
  bytes(row: DRow, column: string): number {
    const table = M2_HISTORY_TABLES[row.origin.tableOrdinal]?.name === row.origin.table
      ? M2_HISTORY_TABLES[row.origin.tableOrdinal]! : M2_HISTORY_TABLES.find(table => table.name === row.origin.table)!;
    const ordinal = table.columnsP0.findIndex(value => value.name === column), cell = row.origin.raw.cells[ordinal]!;
    if (cell[0] === 'text' || cell[0] === 'blob') return cell[1]!.length / 2;
    if (cell[0] === 'pg-binary') return cell[2]!.length / 2;
    return cell[0] === 'null' ? 0 : cell[1]!.length;
  }
  same(left: DScalar | undefined, right: DScalar | undefined, site?: P0Site): boolean {
    chargeP0(this.request, { work: 1, bytes: (typeof left === 'string' ? left.length * 2 : 0)
      + (typeof right === 'string' ? right.length * 2 : 0) }, site);
    return left === right;
  }
  sameScope(row: DRow, target: DRow | undefined, rule: P0Rule, column: string): DRow {
    if (!target) this.fail(row, rule, 'missing-target', column);
    if (!this.same(row.values.project_id, target.values.project_id, this.site(row, rule, column)))
      this.fail(row, rule, 'scope-mismatch', column, target);
    return target;
  }
}
export const dObject = (value: unknown): value is DObject => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Only called on A-owned finite JSON trees. No unknown thrown value is inspected. */
export function dClosed(value: unknown, keys: readonly string[]): value is DObject {
  return dObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

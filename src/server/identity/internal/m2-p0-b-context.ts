// Private B adapter. Each graph pass owns fresh semantic indexes; the request owns all cost.
import { chargeP0, createP0TupleIndex, equalP0Text, failP0, p0RowSite, readP0Int64,
  readP0Json, readP0Real, readP0Text } from "./m2-p0.ts";
import type { P0Condition, P0JsonPolicy, P0KeyPart, P0Request, P0Row, P0Rule, P0Table,
  P0TupleIndex, P0View } from "./m2-p0.ts";
export class P0BContext {
  readonly request: P0Request;
  readonly view: P0View;
  private readonly identities = new Map<P0Table, P0TupleIndex<P0Row>>();
  private readonly scalars = new Map<P0Row, Map<string, string | bigint | number | null>>();
  constructor(request: P0Request, view: P0View) { this.request = request; this.view = view; this.cost(1, 0, 2); }
  cost(work = 1, bytes = 0, tuples = 0, nodes = 0): void { chargeP0(this.request, { work, bytes, tuples, nodes }); }
  rows(table: P0Table): readonly P0Row[] { const rows = this.view.rows(table); this.cost(rows.length); return rows; }
  site(row: P0Row, rule: P0Rule, column?: string) { return p0RowSite(this.request, this.view, row, column, `${rule}.P01`); }
  fail(row: P0Row, rule: P0Rule, condition: P0Condition, column?: string, target?: P0Row): never {
    return failP0(this.request, { code: "semantic_invariant_failed", rule, condition, site: this.site(row, rule, column),
      target: target ? this.site(target, rule) : null });
  }
  private scalar(row: P0Row, column: string, read: () => string | bigint | number | null) {
    this.cost(1);
    let values = this.scalars.get(row);
    if (values?.has(column)) return values.get(column)!;
    const value = read(); this.cost(1, 0, values ? 1 : 2);
    if (!values) { values = new Map(); this.scalars.set(row, values); }
    values.set(column, value); return value;
  }
  text(row: P0Row, column: string, rule: P0Rule, nullable = false, nonempty = false): string | null {
    const value = this.scalar(row, column, () => readP0Text(this.request, row, column, this.site(row, rule, column)));
    if (value === null && nullable) return null;
    if (typeof value !== "string") this.fail(row, rule, "unsupported-value", column);
    if (nonempty) { this.cost(1, value.length * 3); if (value.trim() === "") this.fail(row, rule, "unsupported-value", column); }
    return value;
  }
  id(row: P0Row, column: string, rule: P0Rule): string { return this.text(row, column, rule, false, true)!; }
  int(row: P0Row, column: string, rule: P0Rule, nullable = false): bigint | null {
    const value = this.scalar(row, column, () => readP0Int64(this.request, row, column, this.site(row, rule, column)));
    if (value === null && nullable) return null;
    if (typeof value !== "bigint") this.fail(row, rule, "unsupported-value", column); return value;
  }
  safe(row: P0Row, column: string, rule: P0Rule, minimum = 1n, nullable = false): bigint | null {
    const value = this.int(row, column, rule, nullable); this.cost(3);
    if (value !== null && (value < -9007199254740991n || value > 9007199254740991n))
      failP0(this.request, { code: "semantic_unsupported", rule, condition: "unsupported-value", site: this.site(row, rule, column) });
    if (value !== null && value < minimum) this.fail(row, rule, "unsupported-value", column);
    return value;
  }
  real(row: P0Row, column: string, rule: P0Rule): number {
    const value = this.scalar(row, column, () => readP0Real(this.request, row, column, this.site(row, rule, column)));
    if (typeof value !== "number") this.fail(row, rule, "unsupported-value", column); return value;
  }
  json(row: P0Row, column: string, rule: P0Rule, policy: P0JsonPolicy = "reference"): unknown {
    return readP0Json(this.request, row, column, policy, this.site(row, rule, column));
  }
  equal(a: string, b: string): boolean { return equalP0Text(this.request, a, b); }
  oneOf(row: P0Row, column: string, rule: P0Rule, choices: readonly string[]): string {
    const value = this.text(row, column, rule)!;
    for (const choice of choices) if (this.equal(value, choice)) return value;
    return this.fail(row, rule, "unsupported-value", column);
  }
  index<T>(): P0TupleIndex<T> { return createP0TupleIndex<T>(this.request); }
  insert<T>(index: P0TupleIndex<T>, key: readonly P0KeyPart[], value: T, row: P0Row, rule: P0Rule, column?: string): void {
    if (index.insert(key, value) !== undefined) this.fail(row, rule, "duplicate-key", column);
  }
  byId(table: P0Table, rule: P0Rule): P0TupleIndex<P0Row> {
    this.cost(1); const previous = this.identities.get(table); if (previous) return previous;
    const index = this.index<P0Row>();
    for (const row of this.rows(table)) this.insert(index, [this.id(row, "id", rule)], row, row, rule, "id");
    this.cost(1, 0, 1); this.identities.set(table, index); return index;
  }
  require(index: P0TupleIndex<P0Row>, key: readonly P0KeyPart[], row: P0Row, rule: P0Rule, column: string): P0Row {
    const target = index.get(key); if (!target) this.fail(row, rule, "missing-target", column); return target;
  }
}

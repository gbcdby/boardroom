import { z } from "zod";
import { chargeP0, createP0TupleIndex, equalP0Text, failP0, p0RowSite, readP0Json, readP0SafeInteger, readP0Text } from "./m2-p0.ts";
import type { P0Code, P0Condition, P0JsonPolicy, P0KeyPart, P0Request, P0Row, P0Rule, P0Site, P0Table, P0TupleIndex, P0View } from "./m2-p0.ts";

export const E_RULES = Object.freeze(["PC1B-POL01", "PC1B-MCP01", "PC1B-MCP02", "PC1B-MCP03", "PC1B-WS01", "PC1B-RT01", "PC1B-RT02"] as const);
export type ERule = typeof E_RULES[number];
export interface EJsonCost { nodes: number; encoded: number; recursiveBytes: number; textBytes: number; sortBytes: number; sortWork: number }
export const objectValue = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export const safeUnits = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const safeRevision = safeUnits.min(1);
export const digestValue = z.string().regex(/^[0-9a-f]{64}$/);
export const timestampValue = z.string().refine(value => value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);

/** Only instantiated after the authentic request/view check. No caller context or decoder is accepted. */
export class EContext {
  readonly request: P0Request;
  readonly view: P0View;
  constructor(request: P0Request, view: P0View) { this.request = request; this.view = view; }
  site(row: P0Row, rule: ERule, column?: string): P0Site { return p0RowSite(this.request, this.view, row, column, `${rule}.P01`); }
  charge(work: number, bytes = 0, site?: P0Site, nodes = 0, tuples = 0): void {
    chargeP0(this.request, { work, bytes, nodes, tuples }, site);
  }
  fail(row: P0Row, rule: ERule, condition: P0Condition = "state-mismatch", column?: string,
    code: P0Code = "semantic_invariant_failed", target?: P0Row): never {
    return failP0(this.request, { code, rule, condition, site: this.site(row, rule, column), target: target ? this.site(target, rule) : null });
  }
  rows(table: P0Table): readonly P0Row[] { const rows = this.view.rows(table); this.charge(rows.length); return rows; }
  text(row: P0Row, column: string, rule: ERule): string {
    const value = this.nullableText(row, column, rule);
    if (value === null) this.fail(row, rule, "format-mismatch", column, "semantic_unsupported");
    return value;
  }
  nullableText(row: P0Row, column: string, rule: ERule): string | null { return readP0Text(this.request, row, column, this.site(row, rule, column)); }
  integer(row: P0Row, column: string, rule: ERule, minimum = 0): number {
    const value = this.nullableInteger(row, column, rule, minimum);
    if (value === null) this.fail(row, rule, "format-mismatch", column, "semantic_unsupported");
    return value;
  }
  nullableInteger(row: P0Row, column: string, rule: ERule, minimum = 0): number | null {
    const value = readP0SafeInteger(this.request, row, column, this.site(row, rule, column));
    if (value !== null && value < minimum) this.fail(row, rule, "format-mismatch", column, "semantic_unsupported");
    return value;
  }
  bool(row: P0Row, column: string, rule: ERule): boolean {
    const value = this.integer(row, column, rule); if (value !== 0 && value !== 1) this.fail(row, rule, "format-mismatch", column, "semantic_unsupported");
    return value === 1;
  }
  oneOf(row: P0Row, column: string, rule: ERule, values: readonly string[]): string {
    const value = this.text(row, column, rule); this.charge(values.length, value.length * 3, this.site(row, rule, column));
    if (!values.includes(value)) this.fail(row, rule, "format-mismatch", column, "semantic_unsupported"); return value;
  }
  json(row: P0Row, column: string, rule: ERule, policy: P0JsonPolicy = "reference"): unknown {
    return readP0Json(this.request, row, column, policy, this.site(row, rule, column));
  }
  equal(a: unknown, b: unknown, row: P0Row, rule: ERule, column?: string, condition: P0Condition = "identity-mismatch", target?: P0Row): void {
    const same = typeof a === "string" && typeof b === "string" ? equalP0Text(this.request, a, b, this.site(row, rule, column)) : a === b;
    this.charge(1); if (!same) this.fail(row, rule, condition, column, "semantic_invariant_failed", target);
  }
  index(table: P0Table, columns: readonly (string | readonly [string, "integer"])[], rule: ERule): P0TupleIndex<P0Row> {
    const index = createP0TupleIndex<P0Row>(this.request);
    for (const row of this.rows(table)) {
      this.charge(columns.length, 0, this.site(row, rule), 0, 1);
      const key: P0KeyPart[] = columns.map(c => typeof c === "string" ? this.text(row, c, rule) : this.integer(row, c[0], rule));
      const old = index.insert(key, row); if (old) this.fail(row, rule, "duplicate-key", undefined, "semantic_invariant_failed", old);
    }
    return index;
  }
  target(index: P0TupleIndex<P0Row>, key: readonly P0KeyPart[], row: P0Row, rule: ERule, column?: string): P0Row {
    const target = index.get(key); if (!target) this.fail(row, rule, "missing-target", column); return target;
  }
  /** Measured on owned JSON only. This traversal reserves its own scans before visiting values.
   * Recursive encoders copy child output at every ancestor; count those bytes, not just raw length.
   * Object sort uses a conservative n² comparison bound including maximum key length. */
  measure(value: unknown, site: P0Site): EJsonCost {
    this.charge(1, 0, site, 0, 1);
    if (typeof value === "string") {
      this.charge(1, value.length * 3, site);
      let encoded = 2;
      for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        if (c < 32) encoded += c === 8 || c === 9 || c === 10 || c === 12 || c === 13 ? 2 : 6;
        else if (c === 34 || c === 92) encoded += 2;
        else if (c < 128) encoded++;
        else if (c < 2048) encoded += 2;
        else if (c >= 0xd800 && c <= 0xdbff && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { encoded += 4; i++; }
        else encoded += c >= 0xd800 && c <= 0xdfff ? 6 : 3;
      }
      return { nodes: 1, encoded, recursiveBytes: encoded * 3, textBytes: value.length * 3, sortBytes: 0, sortWork: 0 };
    }
    if (value === null || typeof value !== "object") {
      this.charge(1, 32, site); const encoded = typeof value === "number" ? JSON.stringify(value).length : value === null ? 4 : 5;
      return { nodes: 1, encoded, recursiveBytes: encoded * 3, textBytes: 32, sortBytes: 0, sortWork: 0 };
    }
    let nodes = 1, encoded = 2, recursiveBytes = 0, textBytes = 0, sortBytes = 0, sortWork = 0, count = 0, maxKey = 0;
    // No keys/entries/clone array is allocated by the cost traversal.
    for (const key in value) if (Object.hasOwn(value, key)) {
      this.charge(2, key.length * 3, site); count++;
      const child = this.measure((value as Record<string, unknown>)[key], site);
      nodes += child.nodes; encoded += child.encoded + 1; recursiveBytes += child.recursiveBytes;
      textBytes += child.textBytes; sortBytes += child.sortBytes; sortWork += child.sortWork;
      if (!Array.isArray(value)) {
        const cost = this.measure(key, site); nodes++; encoded += cost.encoded + 1; recursiveBytes += cost.encoded * 2;
        textBytes += cost.textBytes; maxKey = Math.max(maxKey, key.length * 3);
      }
    }
    if (count) encoded--;
    if (!Array.isArray(value)) { sortWork += count * count; sortBytes += count * count * (maxKey * 2 + 1); }
    return { nodes, encoded, recursiveBytes: recursiveBytes + encoded * 3, textBytes, sortBytes, sortWork };
  }
  reserve(value: unknown, site: P0Site, clones: number, canonicals = 0, traversals = 4): EJsonCost {
    const s = this.measure(value, site);
    this.charge(s.nodes * (traversals + clones) + s.sortWork * (clones + canonicals),
      s.textBytes * (traversals + clones) + s.sortBytes * (clones + canonicals) + s.recursiveBytes * canonicals,
      site, s.nodes * clones, s.nodes * clones);
    return s;
  }
  schema<S extends z.ZodTypeAny>(schema: S, value: unknown, row: P0Row, rule: ERule, column: string): z.infer<S> {
    this.reserve(value, this.site(row, rule, column), 1);
    const result = schema.safeParse(value);
    if (!result.success) this.fail(row, rule, "format-mismatch", column, "semantic_unsupported");
    return result.data;
  }
}

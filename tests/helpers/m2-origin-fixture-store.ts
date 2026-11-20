import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJson } from "../../src/server/storage/maintenance/canonical.ts";
import type { ArtifactRef } from "../../src/server/identity/m2-value-contracts.ts";
import type { RawCell, RawRow, RawTable } from "../../src/server/identity/m2-history-contracts.ts";

export type OriginSelection = { artifact: ArtifactRef; kind: string; bytesHex: string };
export const ORIGIN_TIME = "2026-11-19T00:00:00.000Z";
export const originSha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function codepoint(a: string, b: string): number {
  const left = Array.from(a, c => c.codePointAt(0)!), right = Array.from(b, c => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i]! - right[i]!;
  return left.length - right.length;
}
/** Test data encoder, following the frozen R3 key ordering; it never invokes a product validator. */
export function originCanonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(originCanonical).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.keys(value).sort(codepoint).map(k =>
    JSON.stringify(k) + ":" + originCanonical((value as Record<string, unknown>)[k])).join(",") + "}";
  const text = JSON.stringify(value); assert.notEqual(text, undefined); return text;
}
export const originDigest = (value: unknown) => originSha(originCanonical(value));
export const originEvidence = (artifact: ArtifactRef, value: unknown) => ({ artifactId: artifact.ref, digest: originDigest(value) });
export const originAnchor = (artifact: ArtifactRef, sequence: number) => ({ record: { artifactId: artifact.ref, digest: artifact.sha256 }, sequence });
export function originCell(value: string | number | bigint | null): RawCell {
  return value === null ? ["null"] : typeof value === "string" ? ["text", Buffer.from(value).toString("hex")] : ["integer", String(value)];
}
export function originRawValue(cell: RawCell): string | bigint | null {
  if (cell[0] === "null") return null;
  if (cell[0] === "integer") return BigInt(cell[1]);
  assert.equal(cell[0], "text"); return Buffer.from(cell[1]!, "hex").toString("utf8");
}
export function originRow(table: RawTable, index = 0): Record<string, string | bigint | null> {
  return Object.fromEntries(table.columns.map((name, i) => [name, originRawValue(table.rows[index]!.cells[i]!)]));
}
export function originSet(table: RawTable, column: string, value: string | number | bigint | null, index = 0): void {
  const i = table.columns.indexOf(column); assert(i >= 0, column); table.rows[index]!.cells[i] = originCell(value);
}
export function originRowDigest(table: RawTable, backend: "sqlite" | "postgres" = "sqlite"): string {
  const frames = table.rows.map(row => originCanonical([row.rowid, row.cells])).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return originDigest(["m2-pc-table-rows/r1", backend, table.name, table.columnContractValueDigest, table.count, frames]);
}
export type OriginChange = (label: string, value: any) => void;
/** Only a fixture builder. Explicit edges make two selected subgraphs reproducible;
 * the product's independent strict role walker still has to validate every edge. */
export class OriginStore {
  readonly entries = new Map<string, { selected: OriginSelection; value: any; dependencies: ArtifactRef[] }>();
  readonly refs: Record<string, ArtifactRef> = {};
  readonly change: OriginChange | undefined;
  constructor(change?: OriginChange) { this.change = change; }
  raw(label: string, kind: string, bytes: Uint8Array, ref: ArtifactRef, dependencies: ArtifactRef[] = [], value?: any): ArtifactRef {
    assert.equal(String(bytes.length), ref.bytes); assert.equal(originSha(bytes), ref.sha256);
    const selected = { artifact: ref, kind, bytesHex: Buffer.from(bytes).toString("hex") };
    const prior = this.entries.get(ref.ref);
    if (prior) { assert.deepEqual(prior.selected, selected); assert.deepEqual(prior.dependencies, dependencies); }
    else this.entries.set(ref.ref, { selected, value, dependencies: [...dependencies] });
    this.refs[label] = ref; return ref;
  }
  add(label: string, kind: string, original: any, dependencies: ArtifactRef[] = [], format: "wrapped" | "raw" | "legacy" | "binary" = "wrapped"): ArtifactRef {
    const value = format === "binary" ? original : structuredClone(original);
    this.change?.(label, value);
    const envelope = format === "wrapped" ? { formatVersion: 1, kind, payload: value } : value;
    const bytes = format === "binary" ? Buffer.from(value) : Buffer.from(format === "raw" ? originCanonical(envelope) : canonicalJson(envelope));
    const sha256 = originSha(bytes);
    const path = kind === "plan" ? `plans/${sha256}.json` : kind === "journal" ? `journals/${value.migrationId}/${value.sequence}-${sha256}.json`
      : format === "legacy" || format === "binary" ? `snapshots/${sha256}/${kind}.${format === "binary" ? "bin" : "json"}`
      : `m2/sha256/${sha256}/${kind}.json`;
    return this.raw(label, kind, bytes, { ref: path, sha256, bytes: String(bytes.length) }, dependencies, value);
  }
  value(label: string): any { const ref = this.refs[label]; assert(ref, label); return this.entries.get(ref.ref)!.value; }
  all(): OriginSelection[] { return [...this.entries.values()].map(e => structuredClone(e.selected)); }
  reachable(roots: ArtifactRef[]): OriginSelection[] {
    const seen = new Set<string>(), active = new Set<string>();
    const visit = (ref: ArtifactRef) => {
      assert(!active.has(ref.ref), "fixture dependency cycle");
      if (seen.has(ref.ref)) return;
      const entry = this.entries.get(ref.ref); assert(entry, "missing fixture dependency: " + ref.ref); assert.deepEqual(entry.selected.artifact, ref);
      active.add(ref.ref); for (const child of entry.dependencies) visit(child); active.delete(ref.ref); seen.add(ref.ref);
    };
    for (const root of roots) visit(root);
    return [...this.entries.values()].filter(e => seen.has(e.selected.artifact.ref)).map(e => structuredClone(e.selected));
  }
}

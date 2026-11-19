// Private syntax bindings for one real ART01 pass. No parser, predicate or permit
// is accepted from a caller; old consumers still execute their own native codecs.
import { isUtf8 } from 'node:buffer';
import { assertP0View, parseP0Json, p0NestedSite } from './m2-p0.ts';
import type { P0View } from './m2-p0.ts';
import { assertP0FState } from './m2-p0-artifacts-common.ts';
import type { FState } from './m2-p0-artifacts-common.ts';
import type { SourceClientRawRow, SourceClientsRosterV1 } from '../../storage/maintenance/types.ts';
import type { Json } from '../../storage/maintenance/types.ts';
import { rowDigest } from './m2-p0-artifacts-md.ts';

declare const frameBrand: unique symbol;
export interface P0FArtifactSyntaxFrame { readonly [frameBrand]: true; }
type Encoding = SourceClientsRosterV1['textEncoding'];
type JsonColumn = 'host_identity_json' | 'process_identity_json' | 'db_sessions_json';
interface Pass { readonly view: P0View; }
interface Frame {
  readonly f: FState; readonly pass: Pass; readonly scope: object;
  readonly role: 'journal' | 'manifests' | 'rows' | 'codec';
  readonly texts: readonly unknown[];
  readonly rows: WeakSet<object>; readonly encoding: Encoding | null;
  readonly rowJson: WeakMap<object, Map<JsonColumn, { readonly text: string; readonly nodes: number;readonly value:unknown }>>;
}
const passes = new WeakMap<FState, Pass>();
const frames = new WeakMap<P0FArtifactSyntaxFrame, Frame>();
const unknownFrame = Object.freeze({});
// Only synchronous fixed consumers enter this stack. It never survives an await
// or generator step; finally restores the prior authenticated frame on every throw.
let nativeFrame: P0FArtifactSyntaxFrame | undefined;

export function withP0FNativeConsumer<T>(frame: P0FArtifactSyntaxFrame, consume: () => T): T {
  state(frame);
  const previous = nativeFrame; nativeFrame = frame;
  try { return consume(); } finally { nativeFrame = previous; }
}
function nativeState(): FState | undefined { return nativeFrame === undefined ? undefined : state(nativeFrame).f; }
/** Cost seams only: the original consumer still makes every semantic decision. */
export function reserveP0FNativeNodes(nodes: number, tuples = 0): void { nativeState()?.charge(nodes, 0, tuples, nodes); }
export function reserveP0FNativeClone(value: unknown): void {
  const f = nativeState(); if (!f) return;
  const size = f.size(value); f.charge(size.nodes * 8, size.text * 2, 0, size.nodes);
}
export function reserveP0FNativeShallow(value: object, copies = 1): void {
  const f = nativeState(); if (!f) return;
  let nodes = 1, edges = 0;
  for (const key in value) if (Object.hasOwn(value, key)) {
    f.charge(1); edges++; nodes++;
    const item = (value as Record<string, unknown>)[key];
    if (item === null || typeof item !== 'object') nodes++;
  }
  f.charge(nodes * copies, 0, edges * copies, nodes * copies);
}
export function reserveP0FNativeCanonical(value: unknown): void { nativeState()?.reserveCanonical(value); }
export function reuseP0FNativeCanonical(value: unknown): string | undefined {
  const f = nativeState(); if (!f) return undefined;
  const encoded = f.nativeEncoding(value); if (!encoded) return undefined;
  const source = f.sourceText(encoded); if (source !== undefined) return source;
  // Existing text is just a reference. First flatten must pay the original
  // UTF-16 read+write upper bound before encodedText's actual join.
  if (encoded.flat === undefined) f.charge(1, encoded.bytes * 3);
  return f.encodedText(encoded);
}
/** Called only at the fixed native literal/array production sites below. It
 * owns that new shell, never recursively freezes child state. Unknown child
 * ownership or shape leaves the original native algorithm in place. */
export function encodeP0FNativeShell<T>(value:T):T{
  const f=nativeState();if(!f)return value;
  if(value===null||typeof value!=='object')return value;
  f.charge(1);const prototype=Object.getPrototypeOf(value);
  if(prototype!==Object.prototype&&prototype!==Array.prototype)return value;
  for(const key in value)if(Object.hasOwn(value,key)){
    f.charge(1);const child=(value as Record<string,unknown>)[key];
    if(child!==null&&typeof child==='object'&&(!f.immutable.has(child)||!Object.isFrozen(child)))return value;
    if(typeof child==='undefined'||typeof child==='function'||typeof child==='symbol'||typeof child==='bigint')return value;
  }
  f.charge(1,0,1);Object.freeze(value);f.immutable.add(value);f.encode(value);return value;
}
export function reuseP0FNativeDigest(value:unknown):string|undefined{
  const f=nativeState();if(!f)return undefined;
  const encoded=f.nativeEncoding(value);return encoded===undefined?undefined:f.digestEncoding(encoded);
}
export function reuseP0FNativeEquality(a:unknown,b:unknown):boolean|undefined{
  const f=nativeState();if(!f)return undefined;
  const left=f.nativeEncoding(a),right=f.nativeEncoding(b);
  return left===undefined||right===undefined?undefined:f.encodingEqual(left,right);
}
export function reuseP0FNativeRowDigest(rows:readonly Json[]):{count:string;digest:string}|undefined{
  const f=nativeState();if(!f)return undefined;
  f.charge(rows.length);
  for(const row of rows)if(row===null||typeof row!=='object'||!f.immutable.has(row)||!Object.isFrozen(row))return undefined;
  return rowDigest(f,rows);
}
export function reserveP0FNativeText(text: string, utf8 = false): void {
  const f = nativeState(); if (!f) return;
  // UTF-8 uses at most three bytes per UTF-16 code unit. Include both encode
  // output and hash/compare input, as well as the original UTF-16 scan.
  f.charge(1, text.length * (utf8 ? 2 + 3 + 3 : 2));
}
export function reserveP0FNativeSort(values: readonly string[]): void {
  const f = nativeState(); if (!f) return;
  let maximum = 0; for (const value of values) { f.charge(1); maximum = Math.max(maximum, value.length); }
  f.charge(values.length * values.length, values.length * values.length * maximum * 2, values.length);
}
export function reserveP0FNativeComparisons(a:string,b:string,count=1):void{
  nativeState()?.charge(count,(a.length+b.length)*2*count);
}
/** Exact actual enumerable key-list allocation and its following native sort.
 * Runs before Object.keys allocates even for a malformed extra-field value. */
export function reserveP0FNativeKeyListSort(value:object):void{
  const f=nativeState();if(!f)return;
  let count=0,maximum=0;
  for(const key in value)if(Object.hasOwn(value,key)){f.charge(1);count++;maximum=Math.max(maximum,key.length);}
  f.charge(1+count+count*count,count*count*maximum*4,count,1+count);
}

export function beginP0FArtifactPass(f: FState, view: P0View): void {
  assertP0FState(f);
  assertP0View(f.request, view); f.charge(2, 0, 2);
  passes.set(f, Object.freeze({ view }));
}
export function endP0FArtifactPass(f: FState): void { passes.delete(f); }
function state(frame: P0FArtifactSyntaxFrame): Frame {
  const value = frames.get(frame);
  if (!value || passes.get(value.f) !== value.pass) throw unknownFrame;
  value.f.charge(1); return value;
}
function ownedScope(f: FState, scope: object): Pass {
  const pass = passes.get(f);
  if (!pass || !f.immutable.has(scope)) throw unknownFrame;
  return pass;
}
function create(f: FState, scope: object, role: Frame['role'], texts: readonly unknown[],
  rows: readonly SourceClientRawRow[] = [], encoding: Encoding | null = null): P0FArtifactSyntaxFrame {
  const pass = ownedScope(f, scope);
  f.charge(rows.length + 6, 0, rows.length + 6);
  for (const row of rows) if (!f.immutable.has(row)) throw unknownFrame;
  const frame = Object.freeze({}) as P0FArtifactSyntaxFrame;
  frames.set(frame, { f, pass, scope, role, texts, rows: new WeakSet(rows), encoding, rowJson: new WeakMap() });
  return frame;
}
export function p0FJournalSyntaxFrame(f: FState, value: object): P0FArtifactSyntaxFrame {
  ownedScope(f, value);
  const record = value as { controlProof?: { kind?: unknown; maintenanceInvariant?: { controlRootJson?: unknown; mutexIdentityJson?: unknown } } };
  const invariant = record.controlProof?.kind === 'capture-controls' ? record.controlProof.maintenanceInvariant : undefined;
  return create(f, value, 'journal', [invariant?.controlRootJson, invariant?.mutexIdentityJson]);
}
export function p0FCodecSyntaxFrame(f: FState, value: object): P0FArtifactSyntaxFrame { return create(f, value, 'codec', []); }
export function p0FManifestSyntaxFrame(f: FState, value: object): P0FArtifactSyntaxFrame {
  ownedScope(f, value);
  const md = value as { controlRows: { storage_maintenance: readonly Record<string, unknown>[] } };
  const row = md.controlRows.storage_maintenance[0];
  return create(f, value, 'manifests', [row?.control_root_json, row?.mutex_identity_json]);
}
export function p0FRowsSyntaxFrame(f: FState, scope: object, rows: readonly SourceClientRawRow[], encoding: Encoding): P0FArtifactSyntaxFrame {
  return create(f, scope, 'rows', [], rows, encoding);
}
export function assertP0FSyntaxScope(frame: P0FArtifactSyntaxFrame, role: Frame['role'], scope: object): void {
  const s = state(frame); if (s.role !== role || s.scope !== scope) throw unknownFrame;
}
function rowState(frame: P0FArtifactSyntaxFrame, row: SourceClientRawRow, encoding?: Encoding): Frame {
  const s = state(frame);
  if (s.role !== 'rows' || !s.rows.has(row) || !s.encoding
    || encoding && (s.encoding.backend !== encoding.backend || s.encoding.name !== encoding.name)) throw unknownFrame;
  return s;
}
export function assertP0FRow(frame: P0FArtifactSyntaxFrame, row: SourceClientRawRow, encoding: Encoding): void {
  rowState(frame, row, encoding);
}
/** Recognize malformed owned bytes before the real fatal decoder. An arbitrary
 * decoder exception is never caught, inspected or relabelled. */
export function preflightP0FRowText(frame: P0FArtifactSyntaxFrame, row: SourceClientRawRow, encoding: Encoding, bytes: Uint8Array): void {
  const s = rowState(frame, row, encoding); const f: FState = s.f; f.charge(bytes.length + 1, bytes.length);
  if (encoding.name === 'UTF8' || encoding.name === 'UTF-8') { f.require(isUtf8(bytes)); return; }
  f.require(encoding.backend === 'sqlite' && (encoding.name === 'UTF-16le' || encoding.name === 'UTF-16be'));
  f.require(bytes.length % 2 === 0);
  const unit = (at: number) => encoding.name === 'UTF-16le' ? bytes[at]! | bytes[at + 1]! << 8 : bytes[at]! << 8 | bytes[at + 1]!;
  for (let at = 0; at < bytes.length; at += 2) {
    const code = unit(at);
    if (code >= 0xd800 && code <= 0xdbff) {
      at += 2; f.require(at < bytes.length); const low = unit(at); f.require(low >= 0xdc00 && low <= 0xdfff);
    } else f.require(code < 0xdc00 || code > 0xdfff);
  }
}
/** The same fixed roster field and A scanner used by the old F reservation,
 * now retained as syntax data for that exact row and pass. */
export function preparseP0FRowJson(frame: P0FArtifactSyntaxFrame, row: SourceClientRawRow, column: JsonColumn): { value: unknown; text: string } {
  const s = rowState(frame, row); const f: FState = s.f; const cell = row[column]; f.require(cell[0] === 'text');
  const hex = cell[1]; f.charge(2, hex.length * 3);
  const bytes = Buffer.from(hex, 'hex'); preflightP0FRowText(frame, row, s.encoding!, bytes);
  const name = s.encoding!.backend === 'postgres' ? 'utf-8' : s.encoding!.name;
  const text = new TextDecoder(name, { fatal: true, ignoreBOM: true }).decode(bytes);
  f.require(f.currentSite);
  const value = parseP0Json(f.request, text, p0NestedSite(f.request, f.currentSite, 8), 'reference');
  f.freeze(value);f.encode(value);
  let known = s.rowJson.get(row);
  if (!known) { f.charge(1, 0, 1); known = new Map(); s.rowJson.set(row, known); }
  const nodes = f.size(value).nodes;
  f.charge(1, 0, 1, 10); known.set(column, { text, nodes,value }); return { value, text };
}
export function assertP0FRowJson(frame: P0FArtifactSyntaxFrame, row: SourceClientRawRow, column: JsonColumn, text: string): void {
  const s = rowState(frame, row), expected = s.rowJson.get(row)?.get(column);
  if (expected === undefined || !s.f.sameText(expected.text, text)) throw unknownFrame;
  // Every old native parse allocates again, including repeated profile reads.
  s.f.charge(expected.nodes, text.length * 2, 0, expected.nodes);
}
/** The actual second native parse has already happened and paid its nodes.
 * Only exact data equality can share the first parse's canonical encoding.
 * These fresh row JSON values are read-only in the original native consumers;
 * replay state/row arrays and invariant JSON are never adopted here. */
export function bindP0FRowJsonEncoding(frame:P0FArtifactSyntaxFrame,row:SourceClientRawRow,column:JsonColumn,value:unknown):void{
  const s=rowState(frame,row),original=s.rowJson.get(row)?.get(column);if(original===undefined)throw unknownFrame;
  if(s.f.copyEncoding(original.value,value))s.f.freeze(value);
}
export function preparseP0FInvariantJson(frame: P0FArtifactSyntaxFrame, text: string): void {
  const s = state(frame); const f: FState = s.f;
  if (s.role === 'rows' || !s.texts.some(value => typeof value === 'string' && f.sameText(value, text))) throw unknownFrame;
  f.require(f.currentSite);
  // Only A's private syntax token becomes the old known malformed rejection.
  // Resource failures and arbitrary native exceptions retain their identities.
  const value = parseP0Json(f.request, text, p0NestedSite(f.request, f.currentSite, 8), 'legacy-display');
  f.require(value !== undefined);
  const size = f.size(value); f.charge(size.nodes, text.length * 2, 0, size.nodes);
}

// Private syntax bindings for one real ART01 pass. No parser, predicate or permit
// is accepted from a caller; old consumers still execute their own native codecs.
import { isUtf8 } from 'node:buffer';
import { assertP0View, parseP0Json, p0NestedSite } from './m2-p0.ts';
import type { P0View } from './m2-p0.ts';
import { assertP0FState } from './m2-p0-artifacts-common.ts';
import type { FState } from './m2-p0-artifacts-common.ts';
import type { SourceClientRawRow, SourceClientsRosterV1 } from '../../storage/maintenance/types.ts';
import type { Json } from '../../storage/maintenance/types.ts';
import type { JournalValueContext } from '../../storage/maintenance/journal-values.ts';
import { rowDigest } from './m2-p0-artifacts-md.ts';
import { p0State } from './m2-p0-budget.ts';

declare const frameBrand: unique symbol;
export interface P0FArtifactSyntaxFrame { readonly [frameBrand]: true; }
type Encoding = SourceClientsRosterV1['textEncoding'];
type JsonColumn = 'host_identity_json' | 'process_identity_json' | 'db_sessions_json';
interface Pass { readonly view: P0View; }
interface Frame {
  readonly f: FState; readonly pass: Pass; readonly scope: object;
  readonly role: 'journal' | 'manifests' | 'rows' | 'codec';
  readonly firstText: unknown; readonly secondText: unknown;
  readonly rows: WeakSet<object>; readonly encoding: Encoding | null;
  readonly rowJson: WeakMap<object, Map<JsonColumn, { readonly text: string; readonly nodes: number;readonly value:unknown }>>;
  embeddedNodes:number;
}
const passes = new WeakMap<FState, Pass>();
const frames = new WeakMap<P0FArtifactSyntaxFrame, Frame>();
const journalContexts = new WeakMap<JournalValueContext,P0FArtifactSyntaxFrame>();
const knownJournalContexts = new WeakSet<JournalValueContext>();
const utf8DecoderOptions=Object.freeze({fatal:true,ignoreBOM:true});
const noRows:readonly SourceClientRawRow[]=Object.freeze([]);
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
/** Only fixed M2 codec production sites call this after their original input
 * isolation/schema has produced data. It records those actual immutable values
 * for this synchronous request; a standalone call has no such frame. */
export function encodeP0FM2CodecProduced<T>(value:T):T {
  if(nativeFrame===undefined)return value;
  const owner=state(nativeFrame),f:FState=owner.f;
  if(owner.role!=='codec'||!f.durable||!f.immutable.has(owner.scope))return value;
  f.freeze(value);f.encode(value);return value;
}
/** The fixed DTOs normally have ASCII keys, where UTF-16 and C-R3 key order
 * coincide. Non-ASCII keys keep the original full codepoint encoder. No decoded
 * value or semantic decision is cached here; only exact owned byte data is used. */
export function reuseP0FM2CodecR3(value:unknown):string|undefined {
  if(nativeFrame===undefined)return undefined;
  const owner=state(nativeFrame),f:FState=owner.f;
  if(owner.role!=='codec'||!f.durable||!f.immutable.has(owner.scope))return undefined;
  const ascii=(item:unknown):boolean=>{
    f.charge(1);if(item===null||typeof item!=='object')return true;
    if(!f.immutable.has(item))return false;
    for(const key in item)if(Object.hasOwn(item,key)){
      f.charge(1,key.length*2);if(!/^[\x00-\x7f]*$/.test(key)||!ascii((item as Record<string,unknown>)[key]))return false;
    }
    return true;
  };
  return ascii(value)?f.cr3(value):undefined;
}
/** Membership is established only by this request's actual scanner or fixed
 * data production. Object.isFrozen alone, foreign request data and caller
 * flags cannot enter this branch. The local codec still traverses the value
 * and applies its original byte/node/depth limits. */
export function isP0FM2CodecOwned(value:unknown):boolean {
  if(nativeFrame===undefined||value===null||typeof value!=='object')return false;
  const owner=state(nativeFrame),f:FState=owner.f;
  return owner.role==='codec'&&f.durable&&f.immutable.has(owner.scope)&&f.immutable.has(value)&&Object.isFrozen(value);
}
export function reserveP0FM2CodecRead(value:unknown):void {
  if(!isP0FM2CodecOwned(value))throw unknownFrame;
  const f=nativeState()!,size=f.size(value);
  // The private path performs a readonly local-budget traversal. It allocates
  // no reflection map, property descriptors or clone nodes.
  f.charge(size.nodes*2,size.text);
}
/** Cost seams only: the original consumer still makes every semantic decision. */
export function reserveP0FNativeNodes(nodes: number, tuples = 0): void { nativeState()?.charge(nodes, 0, tuples, nodes); }
/** Fixed isolated-copy consumers use the authenticated request's accounting.
 * A standalone public call has no frame and keeps its existing local boundary. */
export function reserveP0FIsolatedCopy(value: unknown): void {
  const f = nativeState(); if (!f) return;
  const size = f.size(value);
  f.charge(size.nodes * 16, size.text * 4, size.nodes * 3, size.nodes);
}
/** Strict embedded JSON in a P-A consumer is part of this same logical graph. */
export function parseP0FNativeJson(text: string, depth: number): { readonly value: unknown } | undefined {
  const owner = nativeState(); if (!owner) return undefined;
  const f: FState = owner;
  f.require(f.currentSite);
  const ownerFrame=nativeFrame===undefined?undefined:state(nativeFrame),ledger=p0State(f.request),nodes=ledger.usage.nodes;
  const value = parseP0Json(f.request, text, p0NestedSite(f.request, f.currentSite, depth), 'reference');
  if(ownerFrame?.role==='codec'&&f.durable)ownerFrame.embeddedNodes+=ledger.usage.nodes-nodes;
  f.freeze(value); f.charge(1, 0, 1); return { value };
}
/** Explicit project-owned metadata only, separate from semantic JSON nodes. */
export function reserveP0FNativeMetadata(tuples:number):void { nativeState()?.charge(tuples,0,tuples); }
/** A dynamic frame-bound schema's explicit configuration is produced even
 * when called outside the synchronous native-consumer stack. */
export function reserveP0FSchemaMetadata(frame:P0FArtifactSyntaxFrame,tuples:number):void { state(frame).f.charge(tuples,0,tuples); }
export function reserveP0FNativeWork(work:number):void { nativeState()?.charge(work); }
export function reserveP0FNativeKeyList(value:object):void {
  const f=nativeState();if(!f)return;
  let count=0;for(const key in value)if(Object.hasOwn(value,key)){f.charge(1);count++;}
  f.charge(count+1,0,count+1);
}
export function reserveP0FNativeSplit(text:string,separator:'/'|':'):void {
  const f=nativeState();if(!f)return;
  f.charge(1,text.length*2);let count=1;const code=separator.charCodeAt(0);
  for(let i=0;i<text.length;i++)if(text.charCodeAt(i)===code)count++;
  f.charge(count+1,0,count+1);
}
export function reserveP0FNativeSetBinding<T>(set:ReadonlySet<T>,value:T):void {
  const f=nativeState();if(f)f.charge(1,0,set.has(value)?0:1);
}
export function reserveP0FNativeMapBinding<K>(map:ReadonlyMap<K,unknown>,key:K):void {
  const f=nativeState();if(f)f.charge(1,0,map.has(key)?0:1);
}
/** F fallback preserves the original prototype test without its temporary list. */
export function checkP0FNativePrototype(value:object):boolean|undefined {
  const f=nativeState();if(!f)return undefined;
  f.charge(1);const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype||prototype===null;
}
/** The already reserved key-list is also the sort storage. No native scratch
 * allocation is assumed free; UTF16 comparisons and moves are prepaid here. */
export function sortP0FNativeKeys(keys:string[]):boolean {
  const f=nativeState();if(!f)return false;
  for(let i=1;i<keys.length;i++){
    f.charge(1);const key=keys[i]!;let at=i;
    while(at>0&&f.compareText(keys[at-1]!,key)>0){f.charge(1);keys[at]=keys[at-1]!;at--;}
    f.charge(1);keys[at]=key;
  }
  return true;
}
export function reserveP0FNativeClone(value: unknown): void {
  const f = nativeState(); if (!f) return;
  const size = f.size(value); f.charge(size.nodes * 8, size.text * 2, 0, size.nodes);
}
/** The fixed manifests codec's generic JSON branches use an unchecked Zod
 * string. It returns each primitive unchanged; there is no character-copy or
 * validation scan at those leaves. All keys, strict/refined fields, clone nodes
 * and the original conservative work bound remain prepaid. */
export function reserveP0FNativeManifestsClone(value:unknown):boolean {
  if(nativeFrame===undefined)return false;
  const owner=state(nativeFrame),f:FState=owner.f;
  if(owner.scope!==value||f.nativeEncoding(value)===undefined){reserveP0FNativeClone(value);return false;}
  const size=f.size(value);let plainText=0,unchanged=true;
  const json=(item:unknown):void=>{
    f.charge(1);
    if(typeof item==='string'){plainText+=item.length*2;return;}
    if(item===null||typeof item!=='object')return;
    for(const key in item)if(Object.hasOwn(item,key)){
      // Zod's record merger drops this one key even when it parses successfully.
      // Test every generic record before allowing exact immutable-data reuse.
      f.charge(1);if(key.length===9){f.charge(1,18);if(key==='__proto__')unchanged=false;}
      json((item as Record<string,unknown>)[key]);
    }
  };
  if(value!==null&&typeof value==='object'&&!Array.isArray(value)){
    const v=value as Record<string,unknown>;json(v.schema);
    if(Array.isArray(v.tables))for(const table of v.tables){f.charge(1);if(table!==null&&typeof table==='object'&&!Array.isArray(table))json(table.columns);}
    const controls=v.controlRows;
    if(controls!==null&&typeof controls==='object'&&!Array.isArray(controls)){
      const rows=controls as Record<string,unknown>;
      if(Array.isArray(rows.storage_maintenance))for(const row of rows.storage_maintenance){f.charge(1);json(row);}
      if(Array.isArray(rows.storage_source_clients))for(const row of rows.storage_source_clients){f.charge(1);json(row);}
    }
  }
  f.require(plainText<=size.text);f.charge(size.nodes*8,(size.text-plainText)*2,0,size.nodes);
  return unchanged;
}
/** Fixed caller of the readonly native source-client equality consumer. Its
 * rows are ordinary enumerable data records from the strict JSON codec or the
 * fixed decodeRow constructor: no symbol/accessor/nonenumerable user keys exist.
 * Each dataRow call allocates a prototype list, own-key list and descriptors;
 * even the same object supplied twice executes both original input checks. */
export function reserveP0FNativeClientEquality(left:Readonly<Record<string,Json>>,right:Readonly<Record<string,Json>>):void {
  const f=nativeState();if(!f)return;
  const count=(row:Readonly<Record<string,Json>>):number=>{
    f.charge(1);
    if(row===null||typeof row!=='object'||Array.isArray(row))return 0;
    const prototype=Object.getPrototypeOf(row);
    if(prototype!==Object.prototype&&prototype!==null)return 3;
    let keys=0;for(const key in row)if(Object.hasOwn(row,key)){f.charge(1);keys++;}
    return 3+1+keys+(keys===16?16:0);
  };
  const tuples=count(left)+count(right);f.charge(tuples,0,tuples);
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
  const owner = nativeState(); if (!owner) return undefined;
  const f: FState = owner;
  const encoded = f.nativeEncoding(value); if (!encoded) return undefined;
  const source = f.sourceText(encoded); if (source !== undefined) return source;
  // encodedText prepays its own actual join reads and canonical output for
  // every caller, including this native reuse path.
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
/** Extra work in the original row-digest expression, separate from its row
 * UTF8/SHA fee: byteLength scans again, then a decimal prefix is produced,
 * encoded and hashed. No frame means the original native expression is free
 * of P0 accounting, as before. */
export function reserveP0FNativeRowPrefix(text:string):void{
  const f=nativeState();if(!f)return;
  f.charge(2,text.length*2);let upper=text.length*3,digits=1;
  while(upper>=10){f.charge(2);upper=Math.floor(upper/10);digits++;}
  const prefix=digits+1;
  // number output <=2D; concatenation reads2D/outputsP; prefix UTF8 reads2P,
  // outputsP; SHA readsP. All happen after this complete reservation.
  f.charge(5,digits*2+(digits*2+prefix)+(prefix*2+prefix)+prefix);
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
  f.charge(1+count+count*count,count*count*maximum*4,count+1,1+count);
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
function create(f: FState, scope: object, role: Frame['role'], firstText:unknown=undefined,secondText:unknown=undefined,
  rows: readonly SourceClientRawRow[] = noRows, encoding: Encoding | null = null): P0FArtifactSyntaxFrame {
  const pass = ownedScope(f, scope);
  f.charge(rows.length + 5, 0, rows.length + 5);
  for (const row of rows) if (!f.immutable.has(row)) throw unknownFrame;
  const frame = Object.freeze({}) as P0FArtifactSyntaxFrame;
  frames.set(frame, { f, pass, scope, role, firstText,secondText, rows: new WeakSet(rows), encoding, rowJson: new WeakMap(),embeddedNodes:0 });
  return frame;
}
export function p0FJournalSyntaxFrame(f: FState, value: object): P0FArtifactSyntaxFrame {
  ownedScope(f, value);
  const record = value as { controlProof?: { kind?: unknown; maintenanceInvariant?: { controlRootJson?: unknown; mutexIdentityJson?: unknown } } };
  const invariant = record.controlProof?.kind === 'capture-controls' ? record.controlProof.maintenanceInvariant : undefined;
  return create(f, value, 'journal', invariant?.controlRootJson, invariant?.mutexIdentityJson);
}
export function p0FCodecSyntaxFrame(f: FState, value: object): P0FArtifactSyntaxFrame { return create(f, value, 'codec'); }
export function p0FM2CodecEmbeddedNodes(frame:P0FArtifactSyntaxFrame):number {
  const owner=state(frame);if(owner.role!=='codec'||!owner.f.durable)throw unknownFrame;return owner.embeddedNodes;
}
export function p0FManifestSyntaxFrame(f: FState, value: object): P0FArtifactSyntaxFrame {
  ownedScope(f, value);
  const md = value as { controlRows: { storage_maintenance: readonly Record<string, unknown>[] } };
  const row = md.controlRows.storage_maintenance[0];
  return create(f, value, 'manifests', row?.control_root_json, row?.mutex_identity_json);
}
export function p0FRowsSyntaxFrame(f: FState, scope: object, rows: readonly SourceClientRawRow[], encoding: Encoding): P0FArtifactSyntaxFrame {
  return create(f, scope, 'rows', undefined,undefined, rows, encoding);
}
/** The math owner constructs its one fixed context; this module only binds
 * opaque data identities and never imports or accepts a replacement validator. */
export function assertP0FJournalFrame(frame:P0FArtifactSyntaxFrame,f:FState):void {
  const s=state(frame);if(s.role!=='codec'||s.f!==f)throw unknownFrame;
}
export function bindP0FJournalContext(frame:P0FArtifactSyntaxFrame,context:JournalValueContext):void {
  const s=state(frame);if(s.role!=='codec'||knownJournalContexts.has(context)||!Object.isFrozen(context))throw unknownFrame;
  s.f.charge(2,0,2);
  journalContexts.set(context,frame);knownJournalContexts.add(context);
}
export function assertP0FJournalContext(frame:P0FArtifactSyntaxFrame,context:JournalValueContext):void {
  state(frame);if(journalContexts.get(context)!==frame)throw unknownFrame;
}
export function releaseP0FJournalContext(context:JournalValueContext):void { journalContexts.delete(context); }
export function reserveP0FJournalMetadata(context:JournalValueContext,tuples:number):void {
  const frame=journalContexts.get(context);
  if(frame===undefined){if(knownJournalContexts.has(context))throw unknownFrame;return;}
  state(frame).f.charge(tuples,0,tuples);
}
export function reserveP0FJournalProjection(context:JournalValueContext,nodes:number):void {
  const frame=journalContexts.get(context);
  if(frame===undefined){if(knownJournalContexts.has(context))throw unknownFrame;return;}
  state(frame).f.charge(nodes,0,0,nodes);
}
/** Prepay the exact temporary slash-token list before String.split. */
export function reserveP0FJournalPathParts(context:JournalValueContext,text:string):void {
  const frame=journalContexts.get(context);
  if(frame===undefined){if(knownJournalContexts.has(context))throw unknownFrame;return;}
  const f=state(frame).f;f.charge(1,text.length*2);let count=1;
  for(let i=0;i<text.length;i++)if(text.charCodeAt(i)===47)count++;
  f.charge(count+1,0,count+1);
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
  const text = new TextDecoder(name, utf8DecoderOptions).decode(bytes);
  f.require(f.currentSite);
  const value = parseP0Json(f.request, text, p0NestedSite(f.request, f.currentSite, 8), 'reference');
  f.freeze(value);f.encode(value);
  let known = s.rowJson.get(row);
  if (!known) { f.charge(1, 0, 2); known = new Map(); s.rowJson.set(row, known); }
  const nodes = f.size(value).nodes;
  f.charge(1, 0, known.has(column)?2:3, 10); known.set(column, { text, nodes,value }); return { value, text };
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
  if (s.role === 'rows' || !(typeof s.firstText==='string'&&f.sameText(s.firstText,text)
    ||typeof s.secondText==='string'&&f.sameText(s.secondText,text))) throw unknownFrame;
  f.require(f.currentSite);
  // Only A's private syntax token becomes the old known malformed rejection.
  // Resource failures and arbitrary native exceptions retain their identities.
  const value = parseP0Json(f.request, text, p0NestedSite(f.request, f.currentSite, 8), 'legacy-display');
  f.require(value !== undefined);
  const size = f.size(value); f.charge(size.nodes, text.length * 2, 0, size.nodes);
}

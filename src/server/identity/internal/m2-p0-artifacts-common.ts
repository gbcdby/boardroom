// Request-private ART01 machinery. No ArtifactStore, IO, caller roots or public success token.
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { wellFormedP0 } from "./m2-p0-lexical.ts";
import { maintenanceFailureCode } from "../../storage/maintenance/error.ts";
import { decodeJournalParsed } from "../../storage/maintenance/journal-codecs.ts";
import type { JournalDecodedKind } from "../../storage/maintenance/journal-codecs.ts";
import type { ArtifactRef, EvidenceRef } from "../m2-value-contracts.ts";
import { chargeP0, createP0TupleIndex, failP0, p0ArtifactSite, parseP0Json } from "./m2-p0.ts";
import type { P0Code, P0Request, P0SelectedArtifact, P0Site, P0TupleIndex } from "./m2-p0.ts";
import { p0FJournalSyntaxFrame, p0FCodecSyntaxFrame, withP0FNativeConsumer } from './m2-p0-artifacts-frame.ts';

const registered = new Set(["pc-observation","pc-catalog","pc-column-contract","pc-typed-table","pc-typed-row","pc-dependency-domain","pc-pg-sequence-relation","m2-physical-source",
  "plan","journal","source-files","source-file-payload","database-snapshot","database-manifests","capability","restore-bundle","publication","verification","receipt"]);
const pc = new Set(["pc-observation","pc-catalog","pc-column-contract","pc-typed-table","pc-typed-row","pc-dependency-domain","pc-pg-sequence-relation","m2-physical-source"]);
const binary = new Set(["database-snapshot","source-file-payload"]);
export type FObject = Record<string, unknown>;
interface Size { nodes: number; text: number; encoded: number; sortWork: number; sortBytes: number }
interface NativeCanonicalCost { work: number; bytes: number; tuples: number }
/** Immutable canonical byte data. Child encodings are shared without joining/copying
 * them at every ancestor. Cached text and SHA are data derived from these exact parts;
 * no role, context, reachability or semantic-success result is stored here. */
interface FSourceSpan { readonly bytes: Buffer; readonly text: string; readonly byteStart: number; readonly unitStart: number; readonly unitEnd: number }
export interface FEncoding { readonly parts: readonly (string|FEncoding)[]; readonly bytes: number; readonly size: Size; text?: string; digest?: string; source?: FSourceSpan }
export interface FEntry { readonly selected: P0SelectedArtifact; readonly ordinal: number; readonly site: P0Site; bytes?: Buffer; verified?: boolean; parsed?: unknown; decoded?: unknown }
const caches = new WeakMap<P0Request, FState>();
const authenticatedStates = new WeakSet<FState>();
const unknownState = Object.freeze({});
export function fState(request: P0Request): FState {
  let value=caches.get(request); if(!value){value=new FState(request);caches.set(request,value);authenticatedStates.add(value);} return value;
}
export function assertP0FState(value: FState): void { if(!authenticatedStates.has(value))throw unknownState; }
export class FState {
  readonly request: P0Request;
  readonly entries: P0TupleIndex<FEntry>;
  readonly evidence: P0TupleIndex<number>;
  readonly used = new Set<number>();
  readonly usedEvidence = new Set<number>();
  readonly immutable = new WeakSet<object>();
  readonly sizes = new WeakMap<object,Size>();
  readonly encodings = new WeakMap<object,FEncoding>();
  readonly nativeCanonicalCosts = new WeakMap<object, NativeCanonicalCost>();
  readonly strings = new Map<string,FEncoding>();
  readonly decodedKinds:WeakMap<object,JournalDecodedKind>;
  currentSite: P0Site | undefined;
  historyDigest: string | undefined;
  constructor(request:P0Request){
    this.request=request;this.charge(1,0,1);this.decodedKinds=new WeakMap(); this.entries=createP0TupleIndex(request);this.evidence=createP0TupleIndex(request);
    for(const [ordinal,selected] of request.input.artifacts.entries()){
      const site=p0ArtifactSite(request,ordinal);this.currentSite=site;
      this.charge(1,selected.kind.length*2);
      this.require(registered.has(selected.kind),'artifact_kind_unsupported','undefined-grammar');
      this.require(this.entries.insert([selected.artifact.ref],{selected,ordinal,site})===undefined,'artifact_semantic_mismatch','duplicate-key');
    }
    for(const [ordinal,selected] of request.input.evidence.entries()){
      this.charge(1,selected.kind.length*2);
      this.require(registered.has(selected.kind),'artifact_kind_unsupported','undefined-grammar');
      this.require(this.evidence.insert([selected.evidence.artifactId],ordinal)===undefined,'artifact_semantic_mismatch','duplicate-key');
    }
    this.currentSite=undefined;
    // A already admitted and froze these exact SQLite tuples. Their tags,
    // signed decimals and lowercase hex are ASCII without JSON escapes. Keep
    // those existing strings as segments rather than stringify/copying them.
    if(request.input.graph.observation.backend==='sqlite'){
      const tags=new Map<string,FEncoding>();this.charge(1,0,1);
      for(const table of request.input.graph.observation.tables)for(const row of table.rows)for(const cell of row.cells){
        this.charge(1);this.require(Object.isFrozen(cell));
        const tag=cell[0]!;this.charge(1,tag.length*2);let name=tags.get(tag);
        if(name===undefined){this.charge(1,tag.length*4+4,3);const text=JSON.stringify(tag);name={parts:[text],text,bytes:tag.length+2,size:{nodes:1,text:tag.length*2,encoded:tag.length+2,sortWork:0,sortBytes:0}};tags.set(tag,name);}
        this.charge(1,0,3);
        const parts:(string|FEncoding)[]=['[',name];let encoded=name.bytes+2,text=name.size.text,nodes=2;
        if(cell.length===2){const payload=cell[1]!;this.charge(1,0,2);const quoted:FEncoding={parts:['"',payload,'"'],bytes:payload.length+2,size:{nodes:1,text:payload.length*2,encoded:payload.length+2,sortWork:0,sortBytes:0}};
          parts.push(',',quoted);encoded+=quoted.bytes+1;text+=quoted.size.text;nodes++;
        }
        parts.push(']');const size:Size={nodes,text,encoded,sortWork:0,sortBytes:0};
        this.immutable.add(cell);this.encodings.set(cell,{parts,bytes:encoded,size});this.sizes.set(cell,size);
      }
    }
  }
  charge(work=0,bytes=0,tuples=0,nodes=0):void{chargeP0(this.request,{work,bytes,tuples,nodes},this.currentSite);}
  require(condition:unknown,code:P0Code='artifact_semantic_mismatch',conditionCode:'undefined-grammar'|'duplicate-key'|'source-mismatch'|'format-mismatch'|'bytes-mismatch'|'missing-target'|'scope-mismatch'|'immutable-history-mismatch'|'count-mismatch'='immutable-history-mismatch'):asserts condition{
    if(!condition)failP0(this.request,{code,rule:'PC1B-ART01',condition:conditionCode,...(this.currentSite?{site:this.currentSite}:{})});
  }
  object(value:unknown,keys?:readonly string[]):FObject{
    this.require(value!==null&&typeof value==='object'&&!Array.isArray(value));
    const result=value as FObject;
    if(keys){const own=Object.keys(result);this.charge(own.length+keys.length);this.require(own.length===keys.length&&keys.every(k=>Object.hasOwn(result,k)));}
    return result;
  }
  array(value:unknown):unknown[]{this.require(Array.isArray(value));return value;}
  text(value:unknown):string{this.require(typeof value==='string');return value;}
  sameText(a:string,b:string):boolean{this.charge(1,Math.min(a.length,b.length)*2);return a===b;}
  utf8Bytes(text:string):number{this.charge(1,text.length*2);return Buffer.byteLength(text);}
  reference(value:unknown):ArtifactRef{
    const v=this.object(value,['ref','sha256','bytes']);
    this.require(typeof v.ref==='string'&&v.ref.length>0&&typeof v.sha256==='string'&&typeof v.bytes==='string');
    this.charge(3,(v.ref.length+v.sha256.length+v.bytes.length)*2);
    this.require(/^[a-f0-9]{64}$/.test(v.sha256)&&v.bytes.length<=20&&/^(0|[1-9][0-9]*)$/.test(v.bytes));
    return v as ArtifactRef;
  }
  refEqual(a:ArtifactRef,b:ArtifactRef):boolean{return this.sameText(a.ref,b.ref)&&this.sameText(a.sha256,b.sha256)&&this.sameText(a.bytes,b.bytes);}
  select(reference:ArtifactRef,kind?:string):FEntry{
    const entry=this.entries.get([reference.ref]);this.require(entry,'artifact_missing','missing-target');this.currentSite=entry.site;
    this.require(this.refEqual(reference,entry.selected.artifact),'artifact_bytes_mismatch','bytes-mismatch');
    if(kind!==undefined)this.require(this.sameText(entry.selected.kind,kind),'artifact_kind_unsupported','format-mismatch');
    const k=entry.selected.kind;let pathMatches=false;
    if(pc.has(k))pathMatches=reference.ref===`m2/sha256/${reference.sha256}/${k}.json`;
    else if(k==='plan')pathMatches=reference.ref===`plans/${reference.sha256}.json`;
    else if(k==='journal')pathMatches=new RegExp(`^journals/[A-Za-z0-9_-]{1,100}/[1-9][0-9]*-${reference.sha256}\\.json$`).test(reference.ref);
    else pathMatches=reference.ref===`snapshots/${reference.sha256}/${k}.${binary.has(k)?'bin':'json'}`;
    this.charge(1,reference.ref.length*2);this.require(pathMatches,'artifact_semantic_mismatch','format-mismatch');
    this.used.add(entry.ordinal);
    if(binary.has(k)){
      if(!entry.verified){const hex=entry.selected.bytesHex;this.charge(1,hex.length+hex.length/2);
        // Consume the immutable hex directly: no separately retained binary Buffer is copied.
        this.require(createHash('sha256').update(hex,'hex').digest('hex')===reference.sha256,'artifact_bytes_mismatch','bytes-mismatch');entry.verified=true;}
    }else this.bytes(entry);
    return entry;
  }
  bytes(entry:FEntry):Buffer{
    if(entry.bytes)return entry.bytes;
    const hex=entry.selected.bytesHex,n=hex.length/2;
    this.charge(2,hex.length+n*2); // hex decode input/output, then SHA input
    const bytes=Buffer.from(hex,'hex');
    this.require(createHash('sha256').update(bytes).digest('hex')===entry.selected.artifact.sha256,'artifact_bytes_mismatch','bytes-mismatch');
    entry.bytes=bytes;return bytes;
  }
  json(entry:FEntry):unknown{
    if(Object.hasOwn(entry,'parsed'))return entry.parsed;
    const bytes=this.bytes(entry);this.charge(1,bytes.length*2);
    this.require(isUtf8(bytes),'artifact_semantic_mismatch','format-mismatch');
    const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
    // The exact canonical-byte comparison below also rejects a BOM, whitespace and lexical rounding.
    const value=parseP0Json(this.request,text!,entry.site,pc.has(entry.selected.kind)?'reference':'finite');
    this.freeze(value);
    if(pc.has(entry.selected.kind))this.scanCr3(value);
    const encoded=this.encode(value);
    this.require(this.matchSource(encoded,bytes,text!),'artifact_semantic_mismatch','format-mismatch');
    encoded.text=text!;encoded.digest=entry.selected.artifact.sha256;
    this.freeze(value);entry.parsed=value;return value;
  }
  decode<K extends JournalDecodedKind>(reference:ArtifactRef,kind:K):ReturnType<typeof decodeJournalParsed<K>>{
    const entry=this.select(reference,kind);if(Object.hasOwn(entry,'decoded'))return entry.decoded as ReturnType<typeof decodeJournalParsed<K>>;
    const value=this.json(entry),size=this.size(value);
    const version=this.object(value).formatVersion;
    this.require(kind==='journal'?[1,2,3].includes(version as number):version===(kind==='source-files'?2:1),'format_unregistered','format-mismatch');
    if(kind==='source-files'){
      const v=this.object(value),n=this.array(v.entries).length,r=this.array(v.roots).length;
      this.charge(n*(r+2)+r*r,size.text*3); // source path/member scans; bounded cross-root checks
    }
    const frame=kind==='journal'?p0FJournalSyntaxFrame(this,value as object):p0FCodecSyntaxFrame(this,value as object);
    try{entry.decoded=withP0FNativeConsumer(frame,()=>decodeJournalParsed(kind,value,kind==='journal'?frame:undefined));}
    catch(error){if(maintenanceFailureCode(error)!==undefined)this.require(false);throw error;}
    this.freeze(entry.decoded);this.copyEncoding(value,entry.decoded);
    this.charge(1,0,1);this.decodedKinds.set(entry.decoded as object,kind);return entry.decoded as ReturnType<typeof decodeJournalParsed<K>>;
  }
  bridge(evidence:EvidenceRef,kind:string):FEntry{
    const ordinal=this.evidence.get([evidence.artifactId]);this.require(ordinal!==undefined,'artifact_missing','missing-target');
    const selected=this.request.input.evidence[ordinal]!;this.require(this.sameText(selected.kind,kind),'artifact_kind_unsupported','format-mismatch');
    this.require(this.sameText(evidence.digest,selected.evidence.digest));
    const entry=this.select(selected.artifact,kind);
    // The selected PC value has already passed json()'s complete R3 syntax
    // admission. Its immutable payload retains that domain; context equations
    // and selected kind/reference checks above still run on every bridge.
    const value=this.json(entry),digest=kind==='m2-physical-source'?this.digest(this.object(value).payload):this.digest(value);
    this.require(this.sameText(evidence.digest,digest));this.usedEvidence.add(ordinal);return entry;
  }
  finish():void{
    this.charge(this.request.input.artifacts.length+this.request.input.evidence.length);
    this.require(this.used.size===this.request.input.artifacts.length&&this.usedEvidence.size===this.request.input.evidence.length,'artifact_semantic_mismatch','scope-mismatch');
  }
  freeze(value:unknown):void{
    if(value===null||typeof value!=='object'||this.immutable.has(value))return;
    this.charge(1);this.immutable.add(value);
    for(const item of Object.values(value)){this.charge(1);this.freeze(item);}Object.freeze(value);
  }
  // Strict legacy codecs clone their output. Reuse immutable encodings only after exact
  // structural equality of each cloned subtree; codec-normalized subtrees keep their own bytes.
  copyEncoding(original:unknown,decoded:unknown):boolean{
    this.charge(1);
    if(original===null||typeof original!=='object'){
      if(typeof original==='string'&&typeof decoded==='string')return this.sameText(original,decoded);
      return Object.is(original,decoded);
    }
    if(decoded===null||typeof decoded!=='object'||Array.isArray(original)!==Array.isArray(decoded))return false;
    const keys=Object.keys(original),other=Object.keys(decoded);this.charge(keys.length+other.length);
    let same=keys.length===other.length;
    for(const key of keys){this.charge(1,key.length*2);if(!Object.hasOwn(decoded,key)||!this.copyEncoding((original as FObject)[key],(decoded as FObject)[key]))same=false;}
    if(same){const text=this.encodings.get(original),size=this.sizes.get(original);if(text!==undefined)this.encodings.set(decoded,text);if(size!==undefined)this.sizes.set(decoded,size);}
    return same;
  }
  size(value:unknown):Size{
    if(value!==null&&typeof value==='object'){const old=this.sizes.get(value);if(old&&this.immutable.has(value))return old;}
    this.charge(1);const size:Size={nodes:1,text:0,encoded:0,sortWork:0,sortBytes:0};
    const stringSize=(text:string)=>{
      this.charge(1,text.length*2);let n=2;
      for(let i=0;i<text.length;i++){const c=text.charCodeAt(i);if(c===34||c===92)n+=2;else if(c<32)n+=c===8||c===9||c===10||c===12||c===13?2:6;else if(c<128)n++;else if(c<2048)n+=2;else if(c>=0xd800&&c<=0xdbff&&i+1<text.length&&text.charCodeAt(i+1)>=0xdc00&&text.charCodeAt(i+1)<=0xdfff){n+=4;i++;}else n+=c>=0xd800&&c<=0xdfff?6:3;}
      return n;
    };
    if(typeof value==='string'){size.text=value.length*2;size.encoded=stringSize(value);}
    else if(value===null||typeof value==='boolean')size.encoded=value===null?4:value?4:5;
    else if(typeof value==='number'){this.charge(1,32);size.encoded=String(value).length;}
    else if(Array.isArray(value)){
      size.encoded=2+Math.max(0,value.length-1);
      for(const item of value){const s=this.size(item);for(const k of ['nodes','text','encoded','sortWork','sortBytes'] as const)size[k]+=s[k];}
    }else{
      const v=this.object(value);size.encoded=2;
      let count=0,max=0;for(const key in v)if(Object.hasOwn(v,key)){this.charge(1);count++;size.nodes++;size.text+=key.length*2;size.encoded+=stringSize(key)+1;max=Math.max(max,key.length);const s=this.size(v[key]);for(const k of ['nodes','text','encoded','sortWork','sortBytes'] as const)size[k]+=s[k];}
      size.encoded+=Math.max(0,count-1);size.sortWork+=count*count;size.sortBytes+=count*count*max*2;
    }
    if(value!==null&&typeof value==='object'&&this.immutable.has(value))this.sizes.set(value,size);return size;
  }
  reserveCanonical(value:unknown):Size{
    const cost=(item:unknown):NativeCanonicalCost=>{
      // The original native encoder now reads this existing immutable byte data
      // at this node. Its parent still pays for any real template/join copies;
      // a required first flatten is charged by the reuse seam before allocation.
      if(this.nativeEncoding(item)!==undefined)return {work:1,bytes:0,tuples:0};
      if(item!==null&&typeof item==='object'&&this.immutable.has(item)){
        const cached=this.nativeCanonicalCosts.get(item);if(cached)return cached;
      }
      this.charge(1);const size=this.size(item);
      const result:NativeCanonicalCost={work:1,bytes:0,tuples:0};
      if(item===null||typeof item!=='object'){
        // JSON.stringify scans the primitive and materializes its quoted result.
        result.bytes=size.text+size.encoded*2;
      }else{
        const array=Array.isArray(item);let count=0,fields=0,maxKey=0;
        // The estimator walks existing properties; it does not allocate the
        // original algorithm's key/map/sort arrays before reserving them.
        for(const key in item)if(Object.hasOwn(item,key)){
          this.charge(1);count++;
          const child=(item as FObject)[key],part=cost(child);result.work+=part.work;result.bytes+=part.bytes;result.tuples+=part.tuples;
          if(!array){
            const quoted=this.size(key).encoded;maxKey=Math.max(maxKey,key.length);
            result.bytes+=key.length*2+quoted*2; // stringify(key)
            fields+=quoted+1+this.size(child).encoded;
          }
        }
        result.work+=count;result.tuples+=count*(array?2:3)+1; // Object.keys, ownKeys, map, seen
        if(!array){
          result.work+=count*count;result.bytes+=count*count*maxKey*2;
          result.bytes+=fields*4; // each key:value template reads and emits
        }
        const joined=Math.max(0,size.encoded-2);
        // At EVERY ancestor: join input+output, then wrapper input+output.
        // UTF-8 encoded length bounds UTF-16 code units even for escaped text.
        result.bytes+=joined*4+joined*2+size.encoded*2;
        if(this.immutable.has(item)){this.charge(1,0,1);this.nativeCanonicalCosts.set(item,result);}
      }
      return result;
    };
    const size=this.size(value),reserved=cost(value);
    // One resulting text equality is included; native hashing charges its own
    // UTF-8 conversion/read at sha256. Cached costs still debit every invocation.
    this.charge(reserved.work,reserved.bytes+size.encoded*2,reserved.tuples);return size;
  }
  encode(value:unknown):FEncoding{
    if(value!==null&&typeof value==='object'&&this.immutable.has(value)){const old=this.encodings.get(value);if(old!==undefined){this.charge(1);return old;}}
    this.charge(1);
    const parts:(string|FEncoding)[]=[],size:Size={nodes:1,text:0,encoded:0,sortWork:0,sortBytes:0};
    const emit=(part:string|FEncoding)=>{this.charge(1);parts.push(part);if(typeof part==='string')size.encoded+=part.length;else for(const k of ['nodes','text','encoded','sortWork','sortBytes'] as const)size[k]+=part.size[k];};
    const quote=(v:string):FEncoding=>{
      this.charge(1,v.length*2);const old=this.strings.get(v);if(old!==undefined)return old;
      this.charge(1,v.length*2);let encoded=2;
      for(let i=0;i<v.length;i++){const c=v.charCodeAt(i);if(c===34||c===92)encoded+=2;else if(c<32)encoded+=c===8||c===9||c===10||c===12||c===13?2:6;else if(c<128)encoded++;else if(c<2048)encoded+=2;else if(c>=0xd800&&c<=0xdbff&&i+1<v.length&&v.charCodeAt(i+1)>=0xdc00&&v.charCodeAt(i+1)<=0xdfff){encoded+=4;i++;}else encoded+=c>=0xd800&&c<=0xdfff?6:3;}
      this.charge(1,v.length*2+encoded,1);const text=JSON.stringify(v),result:FEncoding={parts:[text],bytes:encoded,text,size:{nodes:1,text:v.length*2,encoded,sortWork:0,sortBytes:0}};
      this.strings.set(v,result);return result;
    };
    if(value===null)emit('null');
    else if(typeof value==='string')return quote(value);
    else if(typeof value==='boolean')emit(value?'true':'false');
    else if(typeof value==='number'){this.charge(1,64);this.require(Number.isFinite(value)&&!Object.is(value,-0)&&(!Number.isInteger(value)||Number.isSafeInteger(value)));emit(JSON.stringify(value));}
    else if(Array.isArray(value)){emit('[');for(let i=0;i<value.length;i++){if(i)emit(',');emit(this.encode(value[i]));}emit(']');}
    else{
        const object=this.object(value);let keys=Object.keys(object),target=new Array<string>(keys.length);this.charge(keys.length*2);
        for(let width=1;width<keys.length;width*=2){for(let start=0;start<keys.length;start+=2*width){const middle=Math.min(start+width,keys.length),end=Math.min(start+2*width,keys.length);let l=start,r=middle;for(let out=start;out<end;out++){this.charge(1);let left=r===end;if(!left&&l<middle){this.charge(1,Math.min(keys[l]!.length,keys[r]!.length)*2);left=keys[l]!<=keys[r]!;}target[out]=left?keys[l++]!:keys[r++]!;}}[keys,target]=[target,keys];}
        let max=0;emit('{');for(let i=0;i<keys.length;i++){if(i)emit(',');const key=keys[i]!;max=Math.max(max,key.length);emit(quote(key));emit(':');emit(this.encode(object[key]));}emit('}');
        // Legacy consumers still use native key sorting. Keep their conservative bound;
        // only this private encoder uses the metered stable merge above.
        size.sortWork+=keys.length*keys.length;size.sortBytes+=keys.length*keys.length*max*2;
    }
    const result:FEncoding={parts,bytes:size.encoded,size};
    if(value!==null&&typeof value==='object'&&this.immutable.has(value)){this.charge(1,0,1);this.encodings.set(value,result);this.sizes.set(value,size);}
    return result;
  }
  *encodingParts(value:FEncoding):Generator<string>{
    this.charge(1);if(value.text!==undefined){yield value.text;return;}
    for(const part of value.parts){this.charge(1);if(typeof part==='string')yield part;else yield* this.encodingParts(part);}
  }
  encodedText(value:FEncoding):string{
    this.charge(1);if(value.text!==undefined)return value.text;
    // The UTF-8 count was computed while encoding; no second length scan or nested join.
    this.charge(1,value.bytes);const parts=[...this.encodingParts(value)];this.charge(parts.length);
    value.text=parts.join('');return value.text;
  }
  canonical(value:unknown):string{return this.encodedText(this.encode(value));}
  /** Match once and stage existing source intervals during that same walk.
   * Nothing is bound until the COMPLETE canonical byte equality succeeds. */
  private matchSource(value:FEncoding,bytes:Buffer,text:string):boolean{
    this.charge(2,0,2);const pending:([FEncoding,FSourceSpan])[]=[],staged=new Set<FEncoding>();
    let byteAt=0,unitAt=0;
    const match=(item:FEncoding):boolean=>{
      this.charge(1);const byteStart=byteAt,unitStart=unitAt;
      for(const part of item.parts){
        this.charge(1);
        if(typeof part==='string'){
          if(unitAt+part.length>text.length)return false;
          this.charge(1,part.length*2);if(!text.startsWith(part,unitAt))return false;
          unitAt+=part.length;
          // A scalar has one complete canonical token. All other direct
          // strings in the structural rope are ASCII punctuation.
          byteAt+=item.parts.length===1?item.bytes:part.length;
        }else if(!match(part))return false;
      }
      if(item.source===undefined&&!staged.has(item)){
        this.charge(1,0,4);pending.push([item,{bytes,text,byteStart,unitStart,unitEnd:unitAt}]);staged.add(item);
      }
      return true;
    };
    if(!match(value)||unitAt!==text.length||byteAt!==bytes.length)return false;
    for(const [item,source] of pending){this.charge(1);item.source=source;}
    return true;
  }
  sourceText(value:FEncoding):string|undefined{
    this.charge(1);if(value.text!==undefined)return value.text;
    const source=value.source;if(source===undefined)return undefined;
    this.charge(1,(source.unitEnd-source.unitStart)*4);
    value.text=source.text.slice(source.unitStart,source.unitEnd);return value.text;
  }
  /** Data reuse only. Cache presence alone does not establish immutability. */
  nativeEncoding(value:unknown):FEncoding|undefined{
    this.charge(1);
    return value!==null&&typeof value==='object'&&this.immutable.has(value)&&Object.isFrozen(value)?this.encodings.get(value):undefined;
  }
  compareText(a:string,b:string):number{
    this.charge(1);const length=Math.min(a.length,b.length);
    for(let at=0;at<length;at+=64){
      const end=Math.min(at+64,length);this.charge(1,(end-at)*4);
      for(let i=at;i<end;i++){const x=a.charCodeAt(i),y=b.charCodeAt(i);if(x!==y)return x<y?-1:1;}
    }
    return a.length<b.length?-1:a.length>b.length?1:0;
  }
  compareEncodings(a:FEncoding,b:FEncoding):number{
    this.charge(1);if(a===b)return 0;
    const left=this.encodingParts(a),right=this.encodingParts(b);let x=left.next(),y=right.next(),i=0,j=0;
    while(!x.done&&!y.done){
      const count=Math.min(64,x.value.length-i,y.value.length-j);this.charge(1,count*4);
      for(let k=0;k<count;k++){const p=x.value.charCodeAt(i+k),q=y.value.charCodeAt(j+k);if(p!==q)return p<q?-1:1;}
      i+=count;j+=count;
      if(i===x.value.length){x=left.next();i=0;}if(j===y.value.length){y=right.next();j=0;}
    }
    return x.done?(y.done?0:-1):1;
  }
  digestEncoding(value:FEncoding):string{
    this.charge(1);if(value.digest!==undefined)return value.digest;
    this.charge(1,value.bytes);const hash=createHash('sha256');this.hashEncoding(hash,value);
    value.digest=hash.digest('hex');return value.digest;
  }
  /** Caller reserves the complete SHA input once. Views retain the original
   * bytes and cannot invoke a decoder, source checker or semantic callback. */
  hashEncoding(hash:ReturnType<typeof createHash>,value:FEncoding):void{
    this.charge(1);
    if(value.source!==undefined){const s=value.source;this.charge(1,0,1);hash.update(s.bytes.subarray(s.byteStart,s.byteStart+value.bytes));return;}
    if(value.text!==undefined){hash.update(value.text);return;}
    for(const part of value.parts){this.charge(1);if(typeof part==='string')hash.update(part);else this.hashEncoding(hash,part);}
  }
  digest(value:unknown):string{return this.digestEncoding(this.encode(value));}
  // All PC-owned grammars here have ASCII keys; values still use the R3 Unicode/integer domain.
  scanCr3(value:unknown):void{
    const scan=(v:unknown):void=>{this.charge(1);if(typeof v==='string'){this.charge(1,v.length*2);this.require(wellFormedP0(v));}else if(typeof v==='number')this.require(Number.isSafeInteger(v)&&!Object.is(v,-0));else if(v!==null&&typeof v==='object')for(const key of Object.keys(v)){this.charge(1,key.length*2);this.require(/^[\x00-\x7f]*$/.test(key));scan((v as FObject)[key]);}};
    scan(value);
  }
  cr3(value:unknown):string{this.scanCr3(value);return this.canonical(value);}
  digestCr3(value:unknown):string{this.scanCr3(value);return this.digest(value);}
  encodingEqual(a:FEncoding,b:FEncoding):boolean{
    this.charge(1);if(a===b)return true;
    if(a.bytes!==b.bytes)return false;
    // Proven ASCII strings may retain three existing segments instead of one
    // newly quoted string. Compare bytes when the two data layouts differ.
    if(a.parts.length!==b.parts.length)return this.compareEncodings(a,b)===0;
    // Canonical JSON has one fixed token tree for each value: sorted object keys,
    // ordered arrays and one quoted/number token per scalar. Compare that tree
    // directly; equal immutable children require only their identity comparison.
    // This is a data comparison on every call, never a cached semantic result.
    for(let i=0;i<a.parts.length;i++){
      this.charge(1);const x=a.parts[i]!,y=b.parts[i]!;
      if(typeof x==='string'){if(typeof y!=='string'||!this.sameText(x,y))return false;}
      else if(typeof y==='string'||!this.encodingEqual(x,y))return false;
    }
    return true;
  }
  equal(a:unknown,b:unknown):boolean{return this.encodingEqual(this.encode(a),this.encode(b));}
  hash(text:string):string{this.charge(1,this.utf8Bytes(text));return createHash('sha256').update(text).digest('hex');}
}

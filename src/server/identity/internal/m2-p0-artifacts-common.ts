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

const referenceKeys=Object.freeze(['ref','sha256','bytes']);

const registered = new Set(["pc-observation","pc-catalog","pc-column-contract","pc-typed-table","pc-typed-row","pc-dependency-domain","pc-pg-sequence-relation","m2-physical-source",
  "plan","journal","source-files","source-file-payload","database-snapshot","database-manifests","capability","restore-bundle","publication","verification","receipt"]);
const pc = new Set(["pc-observation","pc-catalog","pc-column-contract","pc-typed-table","pc-typed-row","pc-dependency-domain","pc-pg-sequence-relation","m2-physical-source"]);
const binary = new Set(["database-snapshot","source-file-payload"]);
export type FObject = Record<string, unknown>;
interface Size { nodes: number; text: number; encoded: number; sortWork: number; sortBytes: number }
interface NativeCanonicalCost { work: number; bytes: number; tuples: number }
interface FKeyShape { readonly keys:readonly string[]; readonly quoted:readonly FEncoding[]; readonly sortWork:number; readonly sortBytes:number }
interface FKeyTrie { readonly children:Map<string,FKeyTrie>; shape?:FKeyShape }
/** Immutable canonical byte data. Size fields live in this one record. Arrays
 * retain only child references; object key slots are reused after in-place sort.
 * JSON punctuation is fixed grammar, never a separately allocated token list.
 * No role, context, reachability or semantic-success result is cached here. */
interface FSourceSpan { readonly bytes: Buffer; readonly text: string; readonly byteStart: number; readonly unitStart: number; readonly unitEnd: number }
export interface FEncoding extends Size {
  readonly kind:'scalar'|'array'|'object'|'cell'; bytes:number;
  readonly children?:readonly FEncoding[]; readonly keys?:readonly FEncoding[];
  readonly cell?:readonly string[]; readonly tagText?:string;
  flat?:string; digest?:string; source?:FSourceSpan;
}
export interface FEntry { readonly selected: P0SelectedArtifact; readonly ordinal: number; readonly site: P0Site; bytes?: Buffer; verified?: boolean; parsed?: unknown; decoded?: unknown }
const caches = new WeakMap<P0Request, FState>();
const authenticatedStates = new WeakSet<FState>();
const unknownState = Object.freeze({});
export function fState(request: P0Request): FState {
  let value=caches.get(request);
  if(!value){chargeP0(request,{work:3,tuples:3});value=new FState(request);caches.set(request,value);authenticatedStates.add(value);}
  return value;
}
export function assertP0FState(value: FState): void { if(!authenticatedStates.has(value))throw unknownState; }
export class FState {
  readonly request: P0Request;
  readonly entries: P0TupleIndex<FEntry>;
  readonly evidence: P0TupleIndex<number>;
  readonly used:Set<number>;
  readonly usedEvidence:Set<number>;
  readonly immutable:WeakSet<object>;
  readonly sizes:WeakMap<object,Size>;
  readonly encodings:WeakMap<object,FEncoding>;
  readonly nativeCanonicalCosts:WeakMap<object,NativeCanonicalCost>;
  readonly strings:Map<string,FEncoding>;
  readonly atoms:Map<null|boolean|number,FEncoding>;
  readonly keyData:FKeyTrie;
  readonly decodedKinds:WeakMap<object,JournalDecodedKind>;
  currentSite: P0Site | undefined;
  historyDigest: string | undefined;
  constructor(request:P0Request){
    this.request=request;this.charge(11,0,11);
    this.used=new Set();this.usedEvidence=new Set();this.immutable=new WeakSet();
    this.sizes=new WeakMap();this.encodings=new WeakMap();this.nativeCanonicalCosts=new WeakMap();
    this.strings=new Map();this.atoms=new Map();this.decodedKinds=new WeakMap();
    this.keyData={children:new Map()};
    this.entries=createP0TupleIndex(request);this.evidence=createP0TupleIndex(request);
    for(const [ordinal,selected] of request.input.artifacts.entries()){
      const site=p0ArtifactSite(request,ordinal);this.currentSite=site;
      this.charge(1,selected.kind.length*2);
      this.require(registered.has(selected.kind),'artifact_kind_unsupported','undefined-grammar');
      this.charge(1,0,3); // one key-list shell/slot and one entry record
      this.require(this.entries.insert([selected.artifact.ref],{selected,ordinal,site})===undefined,'artifact_semantic_mismatch','duplicate-key');
    }
    for(const [ordinal,selected] of request.input.evidence.entries()){
      this.charge(1,selected.kind.length*2);
      this.require(registered.has(selected.kind),'artifact_kind_unsupported','undefined-grammar');
      this.charge(1,0,2);
      this.require(this.evidence.insert([selected.evidence.artifactId],ordinal)===undefined,'artifact_semantic_mismatch','duplicate-key');
    }
    this.currentSite=undefined;
    // A already admitted and froze these exact SQLite tuples. Their tags,
    // signed decimals and lowercase hex are ASCII without JSON escapes. Keep
    // those existing strings as segments rather than stringify/copying them.
    if(request.input.graph.observation.backend==='sqlite'){
      for(const table of request.input.graph.observation.tables)for(const row of table.rows)for(const cell of row.cells){
        this.charge(1);this.require(Object.isFrozen(cell));
        const tag=cell[0]!;this.charge(1,tag.length*2);
        const tagText=tag==='null'?'"null"':tag==='integer'?'"integer"':tag==='text'?'"text"':tag==='blob'?'"blob"':tag==='real64be'?'"real64be"':undefined;
        this.require(tagText!==undefined);
        const payload=cell.length===2?cell[1]!:undefined;
        const encoded=tagText.length+2+(payload===undefined?0:payload.length+3);
        this.charge(1,0,3); // record, encodings binding, immutable binding
        const data:FEncoding={kind:'cell',cell,tagText,bytes:encoded,nodes:payload===undefined?2:3,
          text:(tag.length+(payload?.length??0))*2,encoded,sortWork:0,sortBytes:0};
        this.immutable.add(cell);this.encodings.set(cell,data);
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
    if(keys){let count=0;for(const key in result)if(Object.hasOwn(result,key)){this.charge(1);count++;}
      this.charge(keys.length);this.require(count===keys.length&&keys.every(k=>Object.hasOwn(result,k)));}
    return result;
  }
  array(value:unknown):unknown[]{this.require(Array.isArray(value));return value;}
  text(value:unknown):string{this.require(typeof value==='string');return value;}
  sameText(a:string,b:string):boolean{this.charge(1,Math.min(a.length,b.length)*2);return a===b;}
  utf8Bytes(text:string):number{this.charge(1,text.length*2);return Buffer.byteLength(text);}
  reference(value:unknown):ArtifactRef{
    const v=this.object(value,referenceKeys);
    this.require(typeof v.ref==='string'&&v.ref.length>0&&typeof v.sha256==='string'&&typeof v.bytes==='string');
    this.charge(3,(v.ref.length+v.sha256.length+v.bytes.length)*2);
    this.require(/^[a-f0-9]{64}$/.test(v.sha256)&&v.bytes.length<=20&&/^(0|[1-9][0-9]*)$/.test(v.bytes));
    return v as ArtifactRef;
  }
  refEqual(a:ArtifactRef,b:ArtifactRef):boolean{return this.sameText(a.ref,b.ref)&&this.sameText(a.sha256,b.sha256)&&this.sameText(a.bytes,b.bytes);}
  select(reference:ArtifactRef,kind?:string):FEntry{
    this.charge(1,0,2);const entry=this.entries.get([reference.ref]);this.require(entry,'artifact_missing','missing-target');this.currentSite=entry.site;
    this.require(this.refEqual(reference,entry.selected.artifact),'artifact_bytes_mismatch','bytes-mismatch');
    if(kind!==undefined)this.require(this.sameText(entry.selected.kind,kind),'artifact_kind_unsupported','format-mismatch');
    const k=entry.selected.kind;let pathMatches=false;
    if(pc.has(k))pathMatches=reference.ref===`m2/sha256/${reference.sha256}/${k}.json`;
    else if(k==='plan')pathMatches=reference.ref===`plans/${reference.sha256}.json`;
    else if(k==='journal')pathMatches=new RegExp(`^journals/[A-Za-z0-9_-]{1,100}/[1-9][0-9]*-${reference.sha256}\\.json$`).test(reference.ref);
    else pathMatches=reference.ref===`snapshots/${reference.sha256}/${k}.${binary.has(k)?'bin':'json'}`;
    this.charge(1,reference.ref.length*2);this.require(pathMatches,'artifact_semantic_mismatch','format-mismatch');
    if(!this.used.has(entry.ordinal)){this.charge(1,0,1);this.used.add(entry.ordinal);}
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
    encoded.flat=text!;encoded.digest=entry.selected.artifact.sha256;
    this.freeze(value);entry.parsed=value;return value;
  }
  decode<K extends JournalDecodedKind>(reference:ArtifactRef,kind:K):ReturnType<typeof decodeJournalParsed<K>>{
    const entry=this.select(reference,kind);if(Object.hasOwn(entry,'decoded'))return entry.decoded as ReturnType<typeof decodeJournalParsed<K>>;
    const value=this.json(entry),size=this.size(value);
    const version=this.object(value).formatVersion;
    this.require(kind==='journal'?(version===1||version===2||version===3):version===(kind==='source-files'?2:1),'format_unregistered','format-mismatch');
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
    this.charge(1,0,2);const ordinal=this.evidence.get([evidence.artifactId]);this.require(ordinal!==undefined,'artifact_missing','missing-target');
    const selected=this.request.input.evidence[ordinal]!;this.require(this.sameText(selected.kind,kind),'artifact_kind_unsupported','format-mismatch');
    this.require(this.sameText(evidence.digest,selected.evidence.digest));
    const entry=this.select(selected.artifact,kind);
    // The selected PC value has already passed json()'s complete R3 syntax
    // admission. Its immutable payload retains that domain; context equations
    // and selected kind/reference checks above still run on every bridge.
    const value=this.json(entry),digest=kind==='m2-physical-source'?this.digest(this.object(value).payload):this.digest(value);
    this.require(this.sameText(evidence.digest,digest));
    if(!this.usedEvidence.has(ordinal)){this.charge(1,0,1);this.usedEvidence.add(ordinal);}return entry;
  }
  finish():void{
    this.charge(this.request.input.artifacts.length+this.request.input.evidence.length);
    this.require(this.used.size===this.request.input.artifacts.length&&this.usedEvidence.size===this.request.input.evidence.length,'artifact_semantic_mismatch','scope-mismatch');
  }
  freeze(value:unknown):void{
    if(value===null||typeof value!=='object'||this.immutable.has(value))return;
    this.charge(1,0,1);this.immutable.add(value);
    for(const key in value)if(Object.hasOwn(value,key)){this.charge(1);this.freeze((value as FObject)[key]);}Object.freeze(value);
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
    let count=0,other=0,same=true;
    for(const key in decoded)if(Object.hasOwn(decoded,key)){this.charge(1);other++;}
    for(const key in original)if(Object.hasOwn(original,key)){
      this.charge(2,key.length*2);count++;
      if(!Object.hasOwn(decoded,key)||!this.copyEncoding((original as FObject)[key],(decoded as FObject)[key]))same=false;
    }
    same= same&&count===other;
    if(same){const encoded=this.encodings.get(original),size=this.sizes.get(original);
      if(encoded!==undefined){this.charge(1,0,this.encodings.has(decoded)?0:1);this.encodings.set(decoded,encoded);}
      else if(size!==undefined){this.charge(1,0,this.sizes.has(decoded)?0:1);this.sizes.set(decoded,size);}
    }
    return same;
  }
  size(value:unknown):Size{
    if(value!==null&&typeof value==='object'&&this.immutable.has(value)){const old=this.encodings.get(value)??this.sizes.get(value);if(old)return old;}
    if(typeof value==='string'){
      this.charge(1,value.length*2);const old=this.strings.get(value);if(old!==undefined)return old;
    }else if(value===null||typeof value==='boolean'||typeof value==='number'){
      this.charge(1);const old=this.atoms.get(value);if(old!==undefined)return old;
    }
    this.charge(1,0,1);const size:Size={nodes:1,text:0,encoded:0,sortWork:0,sortBytes:0};
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
      for(const item of value){const s=this.size(item);this.addSize(size,s);}
    }else{
      const v=this.object(value);size.encoded=2;
      let count=0,max=0;for(const key in v)if(Object.hasOwn(v,key)){this.charge(1);count++;size.nodes++;size.text+=key.length*2;size.encoded+=stringSize(key)+1;max=Math.max(max,key.length);const s=this.size(v[key]);this.addSize(size,s);}
      size.encoded+=Math.max(0,count-1);size.sortWork+=count*count;size.sortBytes+=count*count*max*2;
    }
    if(value!==null&&typeof value==='object'&&this.immutable.has(value)){this.charge(1,0,this.sizes.has(value)?0:1);this.sizes.set(value,size);}return size;
  }
  private addSize(target:Size,part:Size):void{
    target.nodes+=part.nodes;target.text+=part.text;target.encoded+=part.encoded;target.sortWork+=part.sortWork;target.sortBytes+=part.sortBytes;
  }
  reserveCanonical(value:unknown):Size{
    const cost=(item:unknown):NativeCanonicalCost=>{
      // The original native encoder now reads this existing immutable byte data
      // at this node. Its parent still pays for any real template/join copies;
      // a required first flatten is charged by the reuse seam before allocation.
      if(this.nativeEncoding(item)!==undefined){this.charge(1,0,1);return {work:1,bytes:0,tuples:0};}
      if(item!==null&&typeof item==='object'&&this.immutable.has(item)){
        const cached=this.nativeCanonicalCosts.get(item);if(cached)return cached;
      }
      this.charge(1,0,1);const size=this.size(item);
      const result:NativeCanonicalCost={work:1,bytes:0,tuples:0};
      if(item===null||typeof item!=='object'){
        // JSON.stringify scans the primitive and materializes its quoted result.
        result.bytes=size.text+size.encoded*2;
      }else{
        const array=Array.isArray(item);let count=0,fields=0;
        // The estimator walks existing properties; it does not allocate the
        // original algorithm's key/map/sort arrays before reserving them.
        for(const key in item)if(Object.hasOwn(item,key)){
          this.charge(1);count++;
          const child=(item as FObject)[key],part=cost(child);result.work+=part.work;result.bytes+=part.bytes;result.tuples+=part.tuples;
          if(!array){
            const quoted=this.size(key).encoded;
            result.bytes+=key.length*2+quoted*2; // stringify(key)
            fields+=quoted+1+this.size(child).encoded;
          }
        }
        // Each real native node adds one seen binding. The temporary key and
        // result lists each own a shell and their slots; objects also own an
        // ownKeys list and one explicit descriptor record per key. The F-only
        // key sorter works in the original list and pays its actual reads.
        result.work+=count;result.tuples+=array?count*2+3:count*4+4;
        if(!array){
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
    this.charge(reserved.work,reserved.bytes+size.encoded*2,reserved.tuples+1);return size; // outer seen Set
  }
  encode(value:unknown):FEncoding{
    if(value!==null&&typeof value==='object'&&this.immutable.has(value)){const old=this.encodings.get(value);if(old!==undefined){this.charge(1);return old;}}
    this.charge(1);
    if(typeof value==='string')return this.quote(value);
    if(value===null||typeof value==='boolean'||typeof value==='number'){
      if(typeof value==='number'){this.charge(1,64);this.require(Number.isFinite(value)&&!Object.is(value,-0)&&(!Number.isInteger(value)||Number.isSafeInteger(value)));}
      const old=this.atoms.get(value);if(old!==undefined)return old;
      this.charge(1,0,2); // scalar record and one primitive-data cache binding
      const flat=value===null?'null':typeof value==='boolean'?(value?'true':'false'):JSON.stringify(value);
      const result:FEncoding={kind:'scalar',flat,bytes:flat.length,nodes:1,text:0,encoded:flat.length,sortWork:0,sortBytes:0};
      this.atoms.set(value,result);return result;
    }
    let result:FEncoding;
    if(Array.isArray(value)){
      this.charge(value.length+2,0,value.length+2);
      const children=new Array<FEncoding>(value.length);
      result={kind:'array',children,bytes:0,nodes:1,text:0,encoded:2+Math.max(0,value.length-1),sortWork:0,sortBytes:0};
      for(let i=0;i<value.length;i++){this.charge(1);const child=this.encode(value[i]);children[i]=child;this.addSize(result,child);}
    }else{
      const object=this.object(value),shape=this.objectKeyData(object),count=shape.keys.length;
      this.charge(count+2,0,count+2);const children=new Array<FEncoding>(count);
      result={kind:'object',children,keys:shape.quoted,bytes:0,nodes:1,text:0,encoded:2+Math.max(0,count-1)+count,sortWork:0,sortBytes:0};
      for(let i=0;i<count;i++){
        this.charge(1);const quoted=shape.quoted[i]!,child=this.encode(object[shape.keys[i]!]);children[i]=child;
        this.addSize(result,quoted);this.addSize(result,child);
      }
      // Native fallback consumers retain the original conservative sort bound.
      result.sortWork+=shape.sortWork;result.sortBytes+=shape.sortBytes;
    }
    result.bytes=result.encoded;
    if(this.immutable.has(value as object)){this.charge(1,0,this.encodings.has(value as object)?0:1);this.encodings.set(value as object,result);}
    return result;
  }
  private objectKeyData(value:FObject):FKeyShape{
    let node=this.keyData,count=0;
    for(const key in value)if(Object.hasOwn(value,key)){
      this.charge(1,key.length*2);count++;
      let next=node.children.get(key);
      if(next===undefined){
        this.charge(1,0,3); // trie record, child Map, exact edge binding
        next={children:new Map()};node.children.set(key,next);
      }
      node=next;
    }
    if(node.shape!==undefined)return node.shape;
    // One exact own-key sequence pays for its actual key-list production once.
    this.charge(count+1,0,count+1);const keys=Object.keys(value);
    // Stable in-place insertion sort: no native sort, target array or swap tuple.
    for(let i=1;i<keys.length;i++){
      this.charge(1);const key=keys[i]!;let at=i;
      while(at>0&&this.compareText(keys[at-1]!,key)>0){this.charge(1);keys[at]=keys[at-1]!;at--;}
      this.charge(1);keys[at]=key;
    }
    this.charge(count+2,0,count+2);const quoted=new Array<FEncoding>(count);let maximum=0;
    for(let i=0;i<count;i++){this.charge(1);const key=keys[i]!;maximum=Math.max(maximum,key.length);quoted[i]=this.quote(key);}
    const result:FKeyShape={keys,quoted,sortWork:count*count,sortBytes:count*count*maximum*2};
    this.charge(count*2+3);Object.freeze(keys);Object.freeze(quoted);Object.freeze(result);
    node.shape=result;return result;
  }
  private quote(value:string):FEncoding{
    this.charge(1,value.length*2);const old=this.strings.get(value);if(old!==undefined)return old;
    this.charge(1,value.length*2);let encoded=2;
    for(let i=0;i<value.length;i++){const c=value.charCodeAt(i);if(c===34||c===92)encoded+=2;else if(c<32)encoded+=c===8||c===9||c===10||c===12||c===13?2:6;else if(c<128)encoded++;else if(c<2048)encoded+=2;else if(c>=0xd800&&c<=0xdbff&&i+1<value.length&&value.charCodeAt(i+1)>=0xdc00&&value.charCodeAt(i+1)<=0xdfff){encoded+=4;i++;}else encoded+=c>=0xd800&&c<=0xdfff?6:3;}
    this.charge(1,value.length*2+encoded,2);
    const flat=JSON.stringify(value),result:FEncoding={kind:'scalar',flat,bytes:encoded,nodes:1,text:value.length*2,encoded,sortWork:0,sortBytes:0};
    this.strings.set(value,result);return result;
  }
  *encodingParts(value:FEncoding):Generator<string>{
    this.charge(1);if(value.flat!==undefined){yield value.flat;return;}
    if(value.kind==='cell'){
      yield '[';yield value.tagText!;
      if(value.cell!.length===2){this.charge(1);yield ',"';yield value.cell![1]!;yield '"';}
      yield ']';return;
    }
    const children=value.children!;yield value.kind==='object'?'{':'[';
    for(let i=0;i<children.length;i++){
      this.charge(1);if(i)yield ',';
      if(value.kind==='object'){yield* this.encodingParts(value.keys![i]!);yield ':';}
      yield* this.encodingParts(children[i]!);
    }
    yield value.kind==='object'?'}':']';
  }
  encodedText(value:FEncoding):string{
    this.charge(1);if(value.flat!==undefined)return value.flat;
    // The UTF-8 count was computed while encoding; no second length scan or nested join.
    this.charge(1,value.bytes,1);const parts:string[]=[];
    for(const part of this.encodingParts(value)){this.charge(1,0,1);parts.push(part);}
    value.flat=parts.join('');return value.flat;
  }
  canonical(value:unknown):string{return this.encodedText(this.encode(value));}
  /** Match once and stage existing source intervals during that same walk.
   * Nothing is bound until the COMPLETE canonical byte equality succeeds. */
  private matchSource(value:FEncoding,bytes:Buffer,text:string):boolean{
    this.charge(2,0,2);const pending:(FSourceSpan&{readonly encoding:FEncoding})[]=[],staged=new Set<FEncoding>();
    let byteAt=0,unitAt=0;
    const token=(part:string,byteLength=part.length):boolean=>{
      if(unitAt+part.length>text.length)return false;
      this.charge(1,part.length*2);if(!text.startsWith(part,unitAt))return false;
      unitAt+=part.length;byteAt+=byteLength;return true;
    };
    const match=(item:FEncoding):boolean=>{
      this.charge(1);const byteStart=byteAt,unitStart=unitAt;
      if(item.kind==='scalar'){
        if(!token(item.flat!,item.bytes))return false;
      }else if(item.kind==='cell'){
        if(!token('[')||!token(item.tagText!))return false;
        if(item.cell!.length===2&&(!token(',"')||!token(item.cell![1]!)||!token('"')))return false;
        if(!token(']'))return false;
      }else{
        if(!token(item.kind==='object'?'{':'['))return false;
        for(let i=0;i<item.children!.length;i++){
          this.charge(1);if(i&&!token(','))return false;
          if(item.kind==='object'&&(!match(item.keys![i]!)||!token(':')))return false;
          if(!match(item.children![i]!))return false;
        }
        if(!token(item.kind==='object'?'}':']'))return false;
      }
      // A scalar already owns its complete canonical flat token. All consumers
      // can read that same token without a second source-span/index record.
      // Every token still participates in the complete original-wire match.
      if(!(item.kind==='scalar'&&item.flat!==undefined)&&item.source===undefined&&!staged.has(item)){
        // One span record contains its target; no extra [encoding, span] array.
        this.charge(1,0,3);pending.push({encoding:item,bytes,text,byteStart,unitStart,unitEnd:unitAt});staged.add(item);
      }
      return true;
    };
    if(!match(value)||unitAt!==text.length||byteAt!==bytes.length)return false;
    for(const source of pending){this.charge(1);source.encoding.source=source;}
    return true;
  }
  sourceText(value:FEncoding):string|undefined{
    this.charge(1);if(value.flat!==undefined)return value.flat;
    const source=value.source;if(source===undefined)return undefined;
    this.charge(1,(source.unitEnd-source.unitStart)*4);
    value.flat=source.text.slice(source.unitStart,source.unitEnd);return value.flat;
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
    if(value.flat!==undefined){
      // A scalar without a redundant source span now follows this real string
      // path. Prepay its UTF16 read and UTF8 encoding; the caller separately
      // reserved the complete SHA input. No Buffer view was produced here.
      this.charge(1,value.flat.length*2+value.bytes);hash.update(value.flat);return;
    }
    if(value.kind==='cell'){
      hash.update('[');hash.update(value.tagText!);
      if(value.cell!.length===2){this.charge(1);hash.update(',"');hash.update(value.cell![1]!);hash.update('"');}
      hash.update(']');return;
    }
    hash.update(value.kind==='object'?'{':'[');
    for(let i=0;i<value.children!.length;i++){
      this.charge(1);if(i)hash.update(',');
      if(value.kind==='object'){this.hashEncoding(hash,value.keys![i]!);hash.update(':');}
      this.hashEncoding(hash,value.children![i]!);
    }
    hash.update(value.kind==='object'?'}':']');
  }
  digest(value:unknown):string{return this.digestEncoding(this.encode(value));}
  // All PC-owned grammars here have ASCII keys; values still use the R3 Unicode/integer domain.
  scanCr3(value:unknown):void{
    const scan=(v:unknown):void=>{this.charge(1);if(typeof v==='string'){this.charge(1,v.length*2);this.require(wellFormedP0(v));}else if(typeof v==='number')this.require(Number.isSafeInteger(v)&&!Object.is(v,-0));else if(v!==null&&typeof v==='object')for(const key in v)if(Object.hasOwn(v,key)){this.charge(1,key.length*2);this.require(/^[\x00-\x7f]*$/.test(key));scan((v as FObject)[key]);}};
    scan(value);
  }
  cr3(value:unknown):string{this.scanCr3(value);return this.canonical(value);}
  digestCr3(value:unknown):string{this.scanCr3(value);return this.digest(value);}
  encodingEqual(a:FEncoding,b:FEncoding):boolean{
    this.charge(1);if(a===b)return true;
    if(a.bytes!==b.bytes)return false;
    // The admitted raw-cell layout and the generic array layout can encode the
    // same bytes. Different layouts still compare the actual canonical stream.
    if(a.kind!==b.kind)return this.compareEncodings(a,b)===0;
    if(a.kind==='scalar')return this.sameText(a.flat!,b.flat!);
    if(a.kind==='cell')return this.compareEncodings(a,b)===0;
    // Canonical JSON has one fixed token tree for each value: sorted object keys,
    // ordered arrays and one quoted/number token per scalar. Compare that tree
    // directly; equal immutable children require only their identity comparison.
    // This is a data comparison on every call, never a cached semantic result.
    if(a.children!.length!==b.children!.length)return false;
    for(let i=0;i<a.children!.length;i++){
      this.charge(1);
      if(a.kind==='object'&&!this.encodingEqual(a.keys![i]!,b.keys![i]!))return false;
      if(!this.encodingEqual(a.children![i]!,b.children![i]!))return false;
    }
    return true;
  }
  equal(a:unknown,b:unknown):boolean{return this.encodingEqual(this.encode(a),this.encode(b));}
  hash(text:string):string{this.charge(1,this.utf8Bytes(text));return createHash('sha256').update(text).digest('hex');}
}

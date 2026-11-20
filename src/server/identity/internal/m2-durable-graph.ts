import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { parseP0Json } from "./m2-p0-lexical.ts";
import { M2_HISTORY_TABLES } from "../m2-history-contracts.ts";
import type { HistoryObservationInput, RawCell, RawRow, RawTable } from "../m2-history-contracts.ts";
import { M2_COLUMN_CONTRACT } from "../m2-value-contracts.ts";
import type { M2DecodedRow, M2Cell } from "../m2-value-contracts.ts";
import { decodeM2RowValue } from "../m2-row-codecs.ts";
import { parseM2Value, checkM2SnapshotMappingValues, checkM2DetachValues, checkM2AuthorityValues } from "../m2-value-codecs.ts";
import { parseProfileOriginHistoryValue } from "../profile-authority-values.ts";
import type { M2ValueTypes, ReadonlyDeep } from "../m2-value-contracts.ts";
import { F_COLUMNS, F_MIGRATIONS } from "./m2-p0-artifacts-catalog.ts";
import { fState } from "./m2-p0-artifacts-common.ts";
import type { FState, FEntry } from "./m2-p0-artifacts-common.ts";
import { p0FCodecSyntaxFrame, withP0FNativeConsumer,p0FM2CodecEmbeddedNodes } from "./m2-p0-artifacts-frame.ts";
import { p0State,makeP0Site,siteData } from './m2-p0-budget.ts';
import { p0RowSite } from './m2-p0-raw.ts';
import { ownedM2HistoryView, m2RequestData, countM2OwnedCutRows } from "./m2-p0-request.ts";
import type { P0Request, P0View,P0Site,P0Table } from "./m2-p0-types.ts";
import { m2Definition } from "./m2-durable-schema.ts";
import type { ArtifactRef, EvidenceRef, CaptureRef, M2Definitions, CompleteHistorySelection, TableSelection, SourceRef, SP_RowCut } from "./m2-durable-types.ts";
import { M2_CONTRACT_SOURCES } from "./m2-durable-fixed-sources.ts";
import { CONTROLLED_M22 } from "./m2-controlled-migration-contract.ts";
import { buildMdValue, rowDigest, pgTimestampValue } from "./m2-p0-artifacts-md.ts";
import type { Json } from "../../storage/maintenance/types.ts";
import extraCatalog from "./m2-durable-catalog.json" with { type: "json" };

const wrappers = Object.freeze({
  "m2-physical-source":"Envelope_m2_physical_source", "m2-upgrade-descriptor":"Envelope_m2_upgrade_descriptor",
  "m2-control-observation":"Envelope_m2_control_observation", "m2-takeover-seed":"Envelope_m2_takeover_seed",
  "m2-target-rows":"Envelope_m2_target_rows", "m2-source-to-target":"Envelope_m2_source_to_target",
  "m2-allowed-delta":"Envelope_m2_allowed_delta", "m2-takeover-plan":"Envelope_m2_takeover_plan",
  "m2-activation-receipt":"Envelope_m2_activation_receipt", "m2-observation-domain":"Envelope_m2_observation_domain",
  "m2-exact-delta-check":"Envelope_m2_exact_delta_check", "m2-post-a-proof":"Envelope_m2_post_a_proof",
  "m2-source-client-delta":"Envelope_m2_source_client_delta", "m2-source-client-facts":"Envelope_m2_source_client_facts",
  "m2-migration22-entry":"Envelope_m2_migration22_entry", "m2-workspace-observation":"Envelope_m2_workspace_observation",
  "m2-advanced-equivalence":"Envelope_m2_advanced_equivalence", "profile-journal-closure":"Envelope_profile_journal_closure",
  "profile-origin-history":"Envelope_profile_origin_history",
} as const);
export type M2WrapperKind = keyof typeof wrappers;
export type M2Payload<K extends M2WrapperKind> = M2Definitions[typeof wrappers[K]]["payload"];
const columnKeys = ["ordinal","name","declaredType","nullable","primaryKeyOrdinal","hidden","generated","identity","defaultExpression","collation"] as const;
const tableContracts = new Map(M2_HISTORY_TABLES.map(t => [t.name,t]));
const oldColumns = new Map(F_COLUMNS);
const addedColumns = extraCatalog.columns as Readonly<Record<string, readonly { ordinal:number; name:string; declaredType:string; nullable:boolean;
  primaryKeyOrdinal:number; hidden:number; generated:null; identity:null; defaultExpression:string|null; collation:string|null;
  pgType?:string|null; pgOid:string; pgCollation?:string|null }[]>>;
export interface M2HistoryData {
  readonly observation: ReadonlyDeep<HistoryObservationInput>;
  readonly view: P0View;
  readonly completeHistoryDigest: string;
}
interface RowValue {readonly raw:ReadonlyDeep<RawRow>;readonly depth:number;readonly embeddedNodes:number;readonly value:M2DecodedRow;}
export class M2Graph {
  readonly request: P0Request;
  readonly f: FState;
  private readonly rows:WeakMap<object, Map<string, RowValue>>;
  private readonly rowBytes:Map<string,RowValue>;
  private readonly rowSites:WeakMap<object,P0Site>;
  private readonly captures:WeakMap<object,M2ValueTypes['legacy-capture']>;
  private readonly tableDigests:WeakMap<object,Map<string,string>>;
  private readonly texts:WeakMap<object,string>;
  constructor(request:P0Request) {
    this.request=request; this.f=fState(request); this.f.require(m2RequestData(request)!==undefined);
    this.f.charge(1,0,6);
    this.rows=new WeakMap();this.rowBytes=new Map();this.rowSites=new WeakMap();this.captures=new WeakMap();this.tableDigests=new WeakMap();this.texts=new WeakMap();
  }
  ref(value:unknown):ArtifactRef { return m2Definition(this.f,"ArtifactRef",value); }
  same(left:unknown,right:unknown):void {
    const same=this.f.ownedM2Equal(left,right);this.f.require(same===undefined?this.f.equal(left,right):same);
  }
  selected(reference:ArtifactRef,kind:string):FEntry { this.f.charge(1,0,1); return this.f.select(reference,kind); }
  payload<K extends M2WrapperKind>(reference:ArtifactRef,kind:K):M2Payload<K> {
    const selected=this.selected(reference,kind), raw=this.f.json(selected);
    return m2Definition(this.f,wrappers[kind],raw).payload as M2Payload<K>;
  }
  evidence<K extends M2WrapperKind>(reference:EvidenceRef,kind:K):M2Payload<K> {
    const f:FState=this.f; m2Definition(f,"EvidenceRef",reference); f.charge(1,0,2);
    const item=f.entries.get([reference.artifactId]);f.require(item,"artifact_missing","missing-target");
    const result=this.payload(item.selected.artifact,kind);
    // Original P1 history remains C-S4; M2 payloads retain their fixed C-R3 domain.
    const digest=kind==='profile-origin-history'?f.digest(result):f.digestCr3(result);
    f.require(f.sameText(reference.digest,digest)); return result;
  }
  evidenceArtifact(reference:EvidenceRef,kind:string):ArtifactRef {
    const f:FState=this.f;m2Definition(f,"EvidenceRef",reference);f.charge(1,0,2);
    const item=f.entries.get([reference.artifactId]);f.require(item,"artifact_missing","missing-target");
    this.selected(item.selected.artifact,kind);return item.selected.artifact;
  }
  fixed(reference:ArtifactRef,role:typeof M2_CONTRACT_SOURCES[number]['roles'][number]):void {
    const f:FState=this.f;f.charge(M2_CONTRACT_SOURCES.length);
    const source=M2_CONTRACT_SOURCES.find(source=>(source.roles as readonly string[]).includes(role));
    f.require(source&&f.refEqual(source.artifact,reference));this.selected(reference,'fixed-contract-source');
  }
  value<K extends keyof M2ValueTypes>(kind:K,value:unknown):M2ValueTypes[K] {
    if(kind==='legacy-capture'&&value!==null&&typeof value==='object'){
      this.f.charge(1);const known=this.captures.get(value);if(known)return known as M2ValueTypes[K];
    }
    const f:FState=this.f;f.charge(1,0,1,3);const input={kind,value};f.freeze(input);
    const frame=p0FCodecSyntaxFrame(f,input);
    const result=withP0FNativeConsumer(frame,()=>parseM2Value(input));
    f.require(result.ok,result.ok?'invalid_value':result.error.code==='budget_exceeded'?'resource_limit':result.error.code==='unsupported_shape'?'semantic_unsupported':'artifact_semantic_mismatch');
    f.freeze(result.value.value);
    if(kind==='legacy-capture'&&value!==null&&typeof value==='object'){
      f.charge(1,0,1);this.captures.set(value,result.value.value as M2ValueTypes['legacy-capture']);
    }
    return result.value.value as M2ValueTypes[K];
  }
  join(kind:'mapping'|'detach'|'authority',input:unknown):void {
    const f:FState=this.f;f.freeze(input);const frame=p0FCodecSyntaxFrame(f,input as object);
    const result=withP0FNativeConsumer(frame,()=>kind==='mapping'?checkM2SnapshotMappingValues(input)
      :kind==='detach'?checkM2DetachValues(input):checkM2AuthorityValues(input));
    f.require(result.ok,result.ok?'invalid_value':result.error.code==='budget_exceeded'?'resource_limit':result.error.code==='unsupported_shape'?'semantic_unsupported':'artifact_semantic_mismatch');
  }
  originHistory(reference:ArtifactRef):M2Payload<'profile-origin-history'> {
    const f:FState=this.f,value=this.payload(reference,'profile-origin-history'),frame=p0FCodecSyntaxFrame(f,value);
    const parsed=withP0FNativeConsumer(frame,()=>parseProfileOriginHistoryValue(value));
    this.same(parsed,value);f.freeze(parsed);return value;
  }
  capture(reference:CaptureRef):M2ValueTypes['legacy-capture'] {
    const f:FState=this.f;m2Definition(f,'CaptureRef',reference);let match:FEntry|undefined;
    for(const selected of this.request.input.artifacts){
      f.charge(1);if(selected.kind!=='legacy-capture'||selected.artifact.sha256!==reference.artifactDigest)continue;
      f.require(match===undefined);match=this.selected(selected.artifact,'legacy-capture');
    }
    f.require(match,'artifact_missing','missing-target');const value=this.value('legacy-capture',f.json(match));
    f.require(value.captureId===reference.captureId&&value.legacySourceDigest===reference.sourceDigest
      &&f.digestCr3(value)===reference.artifactDigest);return value;
  }
  jsonText(text:string,canonical=false):unknown {
    const f:FState=this.f;f.require(f.currentSite);const value=parseP0Json(this.request,text,f.currentSite,'reference');
    f.freeze(value);if(canonical)f.require(f.canonical(value)===text);return value;
  }
  hashText(text:string):string {const f:FState=this.f;f.charge(2,text.length*5);return createHash('sha256').update(text,'utf8').digest('hex');}
  tableOf(history:M2HistoryData,name:string):ReadonlyDeep<RawTable>{
    const f:FState=this.f;f.charge(history.observation.tables.length);const table=history.observation.tables.find(t=>t.name===name);f.require(table);return table;
  }
  count(value:bigint|null):number {
    const f:FState=this.f;f.require(value!==null&&value>=0n&&value<=BigInt(Number.MAX_SAFE_INTEGER));return Number(value);
  }
  rawText(value:string,backend:'sqlite'|'postgres'):ReadonlyDeep<RawCell>{
    this.f.charge(2,value.length*9,1,3);const hex=Buffer.from(value,'utf8').toString('hex');return backend==='sqlite'?['text',hex]:['pg-binary','25',hex];
  }
  rawInteger(value:number|bigint,backend:'sqlite'|'postgres',oid='20'):ReadonlyDeep<RawCell>{
    const f:FState=this.f;f.charge(2,80,1,3);const n=BigInt(value);f.require(n>=-9223372036854775808n&&n<=9223372036854775807n);
    if(backend==='sqlite')return ['integer',String(n)];const bytes=Buffer.alloc(oid==='23'?4:8);
    if(oid==='23'){f.require(n>=-2147483648n&&n<=2147483647n);bytes.writeInt32BE(Number(n));}else bytes.writeBigInt64BE(n);
    return ['pg-binary',oid,bytes.toString('hex')];
  }
  text(cell:ReadonlyDeep<RawCell>):string|null {
    const f:FState=this.f;if(cell[0]==='null')return null;
    const hex=cell[0]==='text'?cell[1]:cell[0]==='pg-binary'&&cell[1]==='25'?cell[2]:null;
    f.require(typeof hex==='string','semantic_unsupported','format-mismatch');f.charge(1);
    const owned=f.immutable.has(cell),prior=owned?this.texts.get(cell):undefined;if(prior!==undefined)return prior;
    f.charge(2,hex.length*3);
    const bytes=Buffer.from(hex,'hex');f.require(isUtf8(bytes),'semantic_unsupported','format-mismatch');
    const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
    // Exact immutable raw-cell bytes, not a row/domain/schema verdict. All
    // callers still execute their own current relation and text comparisons.
    if(owned){f.charge(1,0,1);this.texts.set(cell,text);}return text;
  }
  integer(cell:ReadonlyDeep<RawCell>):bigint|null {
    const f:FState=this.f;if(cell[0]==='null')return null;f.charge(1,40);
    if(cell[0]==='integer'){const value=BigInt(cell[1]!);f.require(value>=-9223372036854775808n&&value<=9223372036854775807n);return value;}
    f.require(cell[0]==='pg-binary'&&(cell[1]==='23'||cell[1]==='20'),'semantic_unsupported','format-mismatch');
    const hex=cell[2];f.require(typeof hex==='string');f.require(hex.length===(cell[1]==='23'?8:16));f.charge(2,hex.length*3);
    const bytes=Buffer.from(hex,'hex');return cell[1]==='23'?BigInt(bytes.readInt32BE()):bytes.readBigInt64BE();
  }
  scalar(table:string,row:ReadonlyDeep<RawRow>,column:string,phase:'p0'|'p1'='p1'):string|bigint|null {
    const f:FState=this.f,contract=tableContracts.get(table);f.require(contract);const cols=phase==='p0'?contract.columnsP0:contract.columnsP1;
    f.charge(cols.length);const ordinal=cols.findIndex(c=>c.name===column);f.require(ordinal>=0);const c=cols[ordinal]!;
    return c.postgresTypeOid==='25'||c.postgresTypeOid==='1184'?this.text(row.cells[ordinal]!):this.integer(row.cells[ordinal]!);
  }
  column(reference:ArtifactRef,digest:string,table:string,backend:'sqlite'|'postgres',phase:'p0'|'p1'):void {
    const f:FState=this.f,v=f.object(f.json(this.selected(reference,'pc-column-contract')),['contract','backend','stage','table','columns','rowid']);
    f.require(v.contract==='m2-pc-column-contract/r1'&&v.backend===backend&&v.stage===(phase==='p0'?'schema1-21':'schema22')&&v.table===table
      &&v.rowid===(backend==='sqlite'?'signed-int64':'none')&&f.digestCr3(v)===digest);
    const old=oldColumns.get(table)??[],added=phase==='p1'?addedColumns[table]??[]:[],columns=f.array(v.columns);
    f.require(columns.length===old.length+added.length);
    for(let i=0;i<columns.length;i++){
      const col=f.object(columns[i],columnKeys),base=old[i];f.charge(10);
      if(base){f.require(col.ordinal===i+1&&col.name===base[0]&&col.primaryKeyOrdinal===base[3]&&col.hidden===0);
        if(backend==='sqlite')f.require(col.declaredType===base[1]&&col.nullable===!base[2]&&col.defaultExpression===base[4]&&col.generated===null&&col.identity===null&&col.collation===null);
        else f.require(col.nullable===!base[6]&&col.defaultExpression===base[9]&&col.generated===(base[8]||null)&&col.identity===(base[7]||null));
      }else{
        const fixed=added[i-old.length]!;
        for(const key of columnKeys){const expected=key==='declaredType'&&backend==='postgres'?fixed.pgType??(fixed.pgOid==='25'?'text':'bigint')
          :key==='collation'&&backend==='postgres'?fixed.pgCollation??null:fixed[key];f.require(f.equal(col[key],expected));}
      }
    }
  }
  rowDigest(backend:'sqlite'|'postgres',table:ReadonlyDeep<RawTable>):string {
    const f:FState=this.f;f.charge(1);
    const owned=f.immutable.has(table),prior=owned?this.tableDigests.get(table):undefined,cached=prior?.get(backend);
    if(cached!==undefined)return cached;
    f.charge(table.rows.length,0,table.rows.length+1,table.rows.length+1);
    const frames=table.rows.map(row=>f.canonical([row.rowid,row.cells]));
    const sorted=this.sort(frames,(a,b)=>this.compareText(a,b));
    f.charge(1,0,1,7);const digest=f.digestCr3(['m2-pc-table-rows/r1',backend,table.name,table.columnContractValueDigest,table.count,sorted]);
    // Exact immutable byte-domain data, scoped by backend and object identity.
    // Every caller still performs its own selected/domain/context comparisons.
    if(owned){f.charge(1,0,prior?1:3);const values=prior??new Map<string,string>();values.set(backend,digest);if(!prior)this.tableDigests.set(table,values);}
    return digest;
  }
  compareText(a:string,b:string):number {
    // UTF-8 lexical order is scalar order. Compare only the actually inspected
    // prefix; no complete pair of temporary UTF-8 Buffers is constructed.
    const f:FState=this.f;let left=0,right=0;
    while(left<a.length&&right<b.length){
      f.charge(1,8);const x=a.codePointAt(left)!,y=b.codePointAt(right)!;
      const p=x>=0xd800&&x<=0xdfff?0xfffd:x,q=y>=0xd800&&y<=0xdfff?0xfffd:y;
      if(p!==q)return p<q?-1:1;left+=x>0xffff?2:1;right+=y>0xffff?2:1;
    }
    f.charge(1);return left<a.length?1:right<b.length?-1:0;
  }
  sort<T>(input:readonly T[],compare:(a:T,b:T)=>number):T[] {
    const f:FState=this.f;f.charge(input.length,0,input.length*2+2);let result=[...input],other=new Array<T>(input.length);
    for(let width=1;width<input.length;width*=2){for(let start=0;start<input.length;start+=2*width){
      const middle=Math.min(start+width,input.length),end=Math.min(start+2*width,input.length);let a=start,b=middle;
      for(let at=start;at<end;at++){f.charge(1);other[at]=b===end||a<middle&&compare(result[a]!,result[b]!)<=0?result[a++]!:result[b++]!;}
    }const prior=result;result=other;other=prior;}f.freeze(result);return result;
  }
  table(selection:TableSelection,source:SourceRef,backend:'sqlite'|'postgres',phase:'p0'|'p1'):ReadonlyDeep<RawTable> {
    const f:FState=this.f;m2Definition(f,'TableSelection',selection);
    const v=f.object(f.json(this.selected(selection.typedRows,'pc-typed-table')),['contract','backend','phase','source','table','rowMultisetDigest']);
    f.require(v.contract==='m2-pc-typed-table/r1'&&v.backend===backend&&v.phase===phase&&f.equal(v.source,source));
    const table=f.object(v.table,['name','columnContract','columnContractValueDigest','columns','count','rows']);
    f.require(table.name===selection.table&&table.count===selection.count&&table.columnContractValueDigest===selection.columnContractValueDigest
      &&f.equal(table.columnContract,selection.columnContract));
    const contract=tableContracts.get(selection.table);f.require(contract);const cols=phase==='p0'?contract.columnsP0:contract.columnsP1;
    f.require(f.equal(table.columns,cols.map(c=>c.name))&&Array.isArray(table.rows)&&table.count===String(table.rows.length));
    for(const row of table.rows){const raw=m2Definition(f,'RawRow',row);f.require(raw.cells.length===cols.length&&(backend==='sqlite'?raw.rowid!==null:raw.rowid===null));
      for(let i=0;i<raw.cells.length;i++){const cell=raw.cells[i]!;if(backend==='postgres')f.require(cell[0]==='null'||cell[0]==='pg-binary'&&cell[1]===cols[i]!.postgresTypeOid);else f.require(cell[0]!=='pg-binary');}}
    this.column(selection.columnContract,selection.columnContractValueDigest,selection.table,backend,phase);
    const raw=table as unknown as ReadonlyDeep<RawTable>,actual=this.rowDigest(backend,raw);
    f.require(actual===selection.rowMultisetDigest&&actual===v.rowMultisetDigest);return raw;
  }
  observation(value:unknown):M2HistoryData {
    const f:FState=this.f,view=ownedM2HistoryView(this.request,value),o=value as ReadonlyDeep<HistoryObservationInput>;
    f.require(o.phase==='p0'||o.phase==='p1');
    const ledger=p0State(this.request);
    for(const table of o.tables)for(const row of view.rows(table.name as P0Table)){
      const site=p0RowSite(this.request,view,row),data=siteData(ledger,site);
      f.charge(1,0,1);this.rowSites.set(row.raw,makeP0Site(ledger,{...data,depth:data.depth-4}));
    }
    const catalog=f.object(f.json(this.selected(o.catalog,'pc-catalog')),['contract','source','backend','phase','constraints','migrations','tables','sequences']);
    f.require(catalog.contract==='m2-pc-catalog/r1'&&catalog.backend===o.backend&&catalog.phase===o.phase&&catalog.constraints==='boardroom-p0-1-21-p1-22/r1'&&f.equal(catalog.source,o.source));
    const migrations=f.array(catalog.migrations);f.require(migrations.length===(o.phase==='p0'?21:22));
    for(let i=0;i<21;i++)this.same(migrations[i],F_MIGRATIONS[o.backend][i]);
    if(o.phase==='p1')this.same(migrations[21],{version:22,name:CONTROLLED_M22.name,checksum:CONTROLLED_M22.dialects[o.backend].checksum});
    const tables=f.array(catalog.tables);f.require(tables.length===o.tables.length);
    for(let i=0;i<tables.length;i++){
      const t=f.object(tables[i],['name','columnContract','columnContractValueDigest']),raw=o.tables[i]!;
      f.require(t.name===raw.name&&t.columnContractValueDigest===raw.columnContractValueDigest&&f.equal(t.columnContract,raw.columnContract));
      this.column(raw.columnContract,raw.columnContractValueDigest,raw.name,o.backend,o.phase);
    }
    const sequences=f.array(catalog.sequences);f.require(sequences.length===o.sequences.length);
    for(let i=0;i<sequences.length;i++){const value=f.object(sequences[i],['name','relationIdentity']),raw=o.sequences[i]!;f.require(value.name===raw.name&&f.equal(value.relationIdentity,raw.relationIdentity));}
    f.charge(1,0,1,2);return {observation:o,view,completeHistoryDigest:f.digestCr3(['m2-pc-complete-history/r1',o])};
  }
  history(selection:CompleteHistorySelection):M2HistoryData {
    const f:FState=this.f;m2Definition(f,'CompleteHistorySelection',selection);f.require(selection.phase==='p0'||selection.phase==='p1');
    const result=this.observation(f.json(this.selected(selection.observation,'pc-observation'))),o=result.observation;
    f.require(o.phase===selection.phase&&o.backend===selection.backend&&f.equal(o.source,selection.source)&&result.completeHistoryDigest===selection.completeHistoryDigest&&selection.tables.length===o.tables.length);
    for(let i=0;i<selection.tables.length;i++){const selected=selection.tables[i]!,raw=o.tables[i]!;f.require(selected.table===raw.name);this.same(this.table(selected,o.source,o.backend,selection.phase),raw);}
    return result;
  }
  /** Complete fixed P1 raw cut used by CF's runtime/control joins. The original
   * Md hashes are recomputed from these exact cells; this grants no native claim. */
  rawCut(reference:ArtifactRef):SP_RowCut {
    const f:FState=this.f,wrapper=f.object(f.json(this.selected(reference,'s4p-row-cut')),['formatVersion','kind','payload']);
    f.require(wrapper.formatVersion===1&&wrapper.kind==='s4p-row-cut');const cut=m2Definition(f,'SP_RowCut',wrapper.payload);
    f.require(cut.stage==='p1-source'&&cut.backend===cut.source.kind&&cut.tables.length===72&&cut.textEncoding==='UTF-8','semantic_unsupported');
    countM2OwnedCutRows(this.request,cut);this.fixed(cut.logicalCatalog,'AllowedDeltaManifest.schemaAfter');
    const md=f.decode(cut.physicalCatalog,'database-manifests');f.require(md.dialect===cut.backend);
    this.same(buildMdValue(f,md.dialect,md.schema,md.tables,md.controlRows),md);
    f.require(md.tables.length===72+(cut.backend==='postgres'?1:0));const tableMap=new Map(md.tables.map(table=>[table.name,table]));
    f.charge(md.tables.length,0,md.tables.length+1);f.require(tableMap.size===md.tables.length);
    for(let at=0;at<cut.tables.length;at++){
      const table=cut.tables[at]!,contract=M2_HISTORY_TABLES[at]!;f.require(table.name===contract.name&&table.count===String(table.rows.length));
      this.same(table.columns,contract.columnsP1.map(column=>column.name));const metadata=tableMap.get(table.name);f.require(metadata);const nativeColumns=f.array(metadata.columns);f.require(nativeColumns.length===table.columns.length);
      const old=oldColumns.get(table.name)??[],added=addedColumns[table.name]??[];
      for(let c=0;c<table.columns.length;c++){
        const meta=f.object(nativeColumns[c]),prior=old[c],extra=added[c-old.length];
        if(cut.backend==='sqlite'){
          const type=prior?.[1]??extra!.declaredType,notNull=prior?.[2]??!extra!.nullable,pk=prior?.[3]??extra!.primaryKeyOrdinal,defaultValue=prior?.[4]??extra?.defaultExpression??null;
          f.object(meta,['cid','name','type','notnull','dflt_value','pk','hidden']);
          f.require(meta.cid===String(c)&&meta.name===table.columns[c]&&meta.type===type&&meta.notnull===(notNull?'1':'0')&&meta.pk===String(pk)&&meta.hidden==='0'&&meta.dflt_value===defaultValue);
        }else f.require(meta.name===table.columns[c]&&meta.position===String(c+1)&&meta.table_name===table.name&&meta.type_oid===contract.columnsP1[c]!.postgresTypeOid&&meta.type_modifier===-1);
      }
      const isControl=table.name==='storage_maintenance'||table.name==='storage_source_clients';
      const ids=new Set<string>(),native:Json[]=[],controls:Record<string,Json>[]=[];f.charge(table.rows.length,0,table.rows.length*3+3);
      for(const row of table.rows){f.require(row.cells.length===table.columns.length&&(cut.backend==='sqlite'?row.rowid!==null:row.rowid===null));
        if(row.rowid!==null){f.require(!ids.has(row.rowid));ids.add(row.rowid);}const values:Json[]=[],control:Record<string,Json>={};f.charge(row.cells.length,0,row.cells.length+2,row.cells.length+2);
        for(let i=0;i<row.cells.length;i++){
          const cell=row.cells[i]!,oid=contract.columnsP1[i]!.postgresTypeOid;let value:Json,scalar:Json=null;
          if(cut.backend==='sqlite'){
            f.require(cell[0]!=='pg-binary');value=cell as unknown as Json;
            if(cell[0]==='real64be'){f.require((BigInt('0x'+cell[1])>>52n&0x7ffn)!==0x7ffn,'semantic_unsupported');value=['real-ieee754',cell[1]!];}
            if(isControl)scalar=cell[0]==='null'?null:cell[0]==='integer'?cell[1]!:this.text(cell);
          }else{
            f.require(cell[0]==='null'||cell[0]==='pg-binary'&&cell[1]===oid);scalar=null;
            if(cell[0]!=='null'){
              if(oid==='25')scalar=this.text(cell);
              else if(oid==='1184'){f.charge(2,48);scalar=pgTimestampValue(f,Buffer.from(cell[2]!,'hex').readBigInt64BE());}
              else {const n=this.integer(cell);f.require(n!==null);scalar=oid==='23'?Number(n):String(n);}
            }value=['pg:'+oid,scalar===null?null:String(scalar)];
          }values.push(value);if(isControl)control[table.columns[i]!]=scalar;
        }native.push(values);if(isControl)controls.push(control);
      }
      f.freeze(native);const digest=rowDigest(f,native);f.require(digest.count===metadata.count&&digest.digest===metadata.digest);
      if(isControl){
        const key=table.name==='storage_maintenance'?'singleton':'client_id';const ordered=this.sort(controls,(a,b)=>this.compareText(String(a[key]),String(b[key])));
        this.same(ordered,md.controlRows[table.name]);
      }
    }
    if(cut.backend==='sqlite')f.require(cut.sequences.length===0);
    else {f.require(cut.sequences.length===1);const seq=cut.sequences[0]!;this.selected(seq.relationIdentity,'pc-pg-sequence-relation');
      const metadata=tableMap.get(seq.name);f.require(metadata);const digest=rowDigest(f,[[['pg:20',seq.lastValue],['pg:16',seq.isCalled?'true':'false']]]);
      f.require(metadata.count===digest.count&&metadata.digest===digest.digest);}
    if(cut.predecessor)this.selected(cut.predecessor,'journal');return cut;
  }
  row(table:string,raw:ReadonlyDeep<RawRow>,backend:'sqlite'|'postgres'):M2DecodedRow {
    const f:FState=this.f,ledger=p0State(this.request),depth=ledger.depths.get(raw);
    f.require(depth!==undefined);const previousSite=f.currentSite;
    f.currentSite=this.rowSites.get(raw)??makeP0Site(ledger,{...siteData(ledger,previousSite),depth});
    try {
    const slot=`${backend}:${table}`,prior=this.rows.get(raw)?.get(slot);if(prior&&depth<=prior.depth)return prior.value;
    const dataKey=`${slot}:${f.digest(raw.cells)}`;f.charge(1,dataKey.length*2);
    const sameBytes=this.rowBytes.get(dataKey);
    const remember=(value:RowValue):M2DecodedRow=>{
      let map=this.rows.get(raw);if(!map){f.charge(1,0,1);map=new Map();this.rows.set(raw,map);}f.charge(1,0,1);map.set(slot,value);return value.value;
    };
    // Same-table/backend immutable syntax data may be reused only after exact
    // cells comparison. A deeper occurrence runs its original decoder again;
    // shallower occurrences still pay their own logical embedded JSON nodes.
    if(sameBytes&&depth<=sameBytes.depth&&f.equal(sameBytes.raw.cells,raw.cells)){
      f.charge(1,0,0,sameBytes.embeddedNodes);return remember(sameBytes);
    }
    const relation=M2_COLUMN_CONTRACT.relations.find(t=>t.table===table),fragment=M2_COLUMN_CONTRACT.executionFragments.find(t=>t.table===table);
    f.require(relation||fragment,'semantic_unsupported','undefined-grammar');const columns=(relation??fragment)!.columns;
    const contract=tableContracts.get(table)!;f.charge(columns.length,0,columns.length+2,columns.length*3+4);
    const cells: Record<string,M2Cell>={};
    for(const column of columns){
      const i=contract.columnsP1.findIndex(c=>c.name===column.name);f.require(i>=0);const cell=raw.cells[i]!;
      if(cell[0]==='null')cells[column.name]={kind:'null'};
      else if(contract.columnsP1[i]!.postgresTypeOid==='25'){
        const value=this.text(cell);f.require(value!==null);cells[column.name]={kind:'text',value};
      }else{const value=this.integer(cell);f.require(value!==null);cells[column.name]={kind:'integer',decimal:String(value)};}
    }
    const identityName=table==='agent_runtime_bindings'?'id':'binding_id';
    const input=relation?{contract:'m2-row-projection/r1',table,cells}:
      {contract:'m2-execution-reference-projection/r1',table,identity:{[identityName]:this.scalar(table,raw,identityName)},cells};
    f.freeze(input);const frame=p0FCodecSyntaxFrame(f,input),result=withP0FNativeConsumer(frame,()=>decodeM2RowValue(input));
    f.require(result.ok,result.ok?'invalid_value':result.error.code==='budget_exceeded'?'resource_limit':result.error.code==='unsupported_shape'?'semantic_unsupported':'artifact_semantic_mismatch');
    f.freeze(result.value);const decoded={raw,depth,embeddedNodes:p0FM2CodecEmbeddedNodes(frame),value:result.value as M2DecodedRow};
    f.charge(1,0,2);this.rowBytes.set(dataKey,decoded);return remember(decoded);
    }finally{f.currentSite=previousSite;}
  }
}

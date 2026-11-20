import { ordinaryProfile, controllerRegistration, runtimeRelations, sessionSources, supportedEncoding,
  sourceClientEpochClassification } from '../../storage/maintenance/control-candidate/rows.ts';
import type { RowContext } from '../../storage/maintenance/control-candidate/rows.ts';
import { eventFactsSchema, checkFactsShape, processDisposition } from '../../storage/maintenance/control-candidate/schema.ts';
import type { EventFacts, ClientFact } from '../../storage/maintenance/control-candidate/schema.ts';
import { maintenanceFailureCode } from '../../storage/maintenance/error.ts';
import type { MigrationPlan, SourceClientRawRow } from '../../storage/maintenance/types.ts';
import type { RawTable, RawRow, RawCell } from '../m2-history-contracts.ts';
import type { ReadonlyDeep } from '../m2-value-contracts.ts';
import { M2Graph } from './m2-durable-graph.ts';
import type { M2HistoryData } from './m2-durable-graph.ts';
import { readM2Control } from './m2-durable-controls.ts';
import { m2Definition } from './m2-durable-schema.ts';
import { p0FCodecSyntaxFrame, withP0FNativeConsumer, reserveP0FNativeClone } from './m2-p0-artifacts-frame.ts';
import type { FState } from './m2-p0-artifacts-common.ts';
import type { ArtifactRef, EvidenceRef, SourceRef, M2ControlValue, ProfileCurrentClientFormat,
  ProfileClientFacts, ClientTextEncoding, SP_RowCut, SP_RawTable } from './m2-durable-types.ts';

const columns = Object.freeze(['client_id','database_instance_id','entrypoint','build_id','protocol_version',
  'host_identity_json','process_identity_json','db_sessions_json','registered_epoch','observed_epoch','drain_epoch',
  'drain_state','drain_receipt_digest','registered_at','last_observed_at','ended_at','writer_format_digest'] as const);
type SemanticRow = Omit<SourceClientRawRow, 'protocol_version'>;
type Decoded = { -readonly [K in keyof SourceClientRawRow]: string | null };
type Pair = { readonly protocolVersion: number; readonly writerFormatDigest: string };
export interface M2ClientRegistration {
  readonly creation: { readonly migrationId: string; readonly plan: ArtifactRef; readonly fenceEpoch: string;
    readonly ownerGeneration: string; readonly previousAnchor: ArtifactRef | null; readonly targetSequence: string };
  readonly actorId: string;
  /** Absent only for an original v1 registration replayed before A. */
  readonly birthFormat?: Pair;
}
export interface M2OwnerClientsInput {
  readonly delta: EvidenceRef;
  readonly source: SourceRef;
  readonly plan: ArtifactRef;
  readonly actualPlan: MigrationPlan;
  readonly migrationId: string;
  readonly previous: ArtifactRef;
  readonly targetSequence: number;
  readonly fromGeneration: number;
  readonly toGeneration: number;
  readonly fenceEpoch: number;
  readonly originCapture: ArtifactRef;
  readonly receiptGeneration: number;
  readonly currentFormat: ProfileCurrentClientFormat;
  readonly before: ReadonlyDeep<RawTable>;
  readonly beforeControl: M2ControlValue;
  readonly frozenHistory: M2HistoryData;
  readonly knownRegistrations: ReadonlyMap<string, M2ClientRegistration>;
}
interface ClientRow {
  readonly raw: ReadonlyDeep<RawRow>;
  readonly key: string;
  readonly semantic: SemanticRow;
  readonly decoded: Decoded;
  readonly protocol: number;
  readonly format: string | null;
}

function textCell(g:M2Graph, value:string, encoding:ClientTextEncoding):ReadonlyDeep<RawCell> {
  const f:FState=g.f;f.require(supportedEncoding(encoding),'semantic_unsupported','format-mismatch');
  f.charge(2,value.length*10,1,3);
  const bytes=Buffer.from(value,encoding.name==='UTF-16le'||encoding.name==='UTF-16be'?'utf16le':'utf8');
  if(encoding.name==='UTF-16be')bytes.swap16();
  const hex=bytes.toString('hex');return encoding.backend==='postgres'?['pg-binary','25',hex]:['text',hex];
}
function decodeText(g:M2Graph, cell:ReadonlyDeep<RawCell>, encoding:ClientTextEncoding):string|null {
  const f:FState=g.f;if(cell[0]==='null')return null;
  f.require(encoding.backend==='sqlite'?cell[0]==='text':cell[0]==='pg-binary'&&cell[1]==='25');
  const hex=cell[cell[0]==='text'?1:2]!;f.require(typeof hex==='string');f.charge(3,hex.length*7);
  let value:string;
  try{value=new TextDecoder(encoding.backend==='postgres'?'utf-8':encoding.name,{fatal:true,ignoreBOM:true}).decode(Buffer.from(hex,'hex'));}
  catch{f.require(false,'semantic_unsupported','format-mismatch');}
  g.same(textCell(g,value!,encoding),cell);return value!;
}
function key(g:M2Graph,row:ReadonlyDeep<RawRow>,encoding:ClientTextEncoding):string {
  const f:FState=g.f,cell=row.cells[0];f.require(cell);
  f.require(encoding.backend==='sqlite'?cell[0]==='text':cell[0]==='pg-binary'&&cell[1]==='25');
  return cell[cell[0]==='text'?1:2]!;
}
function orderedRows(g:M2Graph,table:ReadonlyDeep<RawTable>,encoding:ClientTextEncoding):ReadonlyDeep<RawRow>[] {
  const f:FState=g.f;f.require(table.name==='storage_source_clients'&&table.count===String(table.rows.length));
  g.same(table.columns,columns);f.charge(table.rows.length,0,table.rows.length+1);
  const rowids=new Set<string>();
  for(const row of table.rows){
    m2Definition(f,'RawRow',row);f.require(row.cells.length===17);
    if(encoding.backend==='sqlite'){f.require(row.rowid!==null&&!rowids.has(row.rowid));rowids.add(row.rowid);}
    else f.require(row.rowid===null);
  }
  const result=g.sort(table.rows,(a,b)=>g.compareText(key(g,a,encoding),key(g,b,encoding)));
  for(let i=1;i<result.length;i++)f.require(g.compareText(key(g,result[i-1]!,encoding),key(g,result[i]!,encoding))<0);
  return result;
}
function sameTable(g:M2Graph,left:ReadonlyDeep<RawTable>,right:ReadonlyDeep<RawTable>,encoding:ClientTextEncoding):void {
  g.same(left.columnContract,right.columnContract);g.f.require(left.columnContractValueDigest===right.columnContractValueDigest);
  g.same(orderedRows(g,left,encoding),orderedRows(g,right,encoding));
}
type DigestDomain={readonly source:SourceRef;readonly textEncoding:ClientTextEncoding;
  readonly columnContract:ArtifactRef;readonly columnContractValueDigest:string};
function rowDigest(g:M2Graph,domain:DigestDomain,row:ReadonlyDeep<RawRow>):string {
  g.f.charge(1,0,3,10);
  return g.f.digest(['profile-source-client-row/r2',domain.source,domain.textEncoding,
    domain.columnContract,domain.columnContractValueDigest,[row.rowid,row.cells]]);
}
function rowsDigest(g:M2Graph,domain:DigestDomain,rows:readonly ReadonlyDeep<RawRow>[]):string {
  g.f.charge(rows.length+1,0,rows.length*3+2,rows.length*3+9);
  return g.f.digest(['profile-source-clients-live-rows/r2',domain.source,domain.textEncoding,
    domain.columnContract,domain.columnContractValueDigest,String(rows.length),rows.map(row=>[row.rowid,row.cells])]);
}
/** Only a typed metadata projection is sent to the existing pure refinements.
 * Protocol/format and all hashes use the original complete 17-cell frame. */
function clientRow(g:M2Graph,row:ReadonlyDeep<RawRow>,encoding:ClientTextEncoding,current:Pair):ClientRow {
  const f:FState=g.f;f.charge(34,0,35,70);const semantic:Record<string,unknown>={},decoded:Record<string,string|null>={};
  let protocol=0,format:string|null=null;
  for(let i=0;i<17;i++){
    const cell=row.cells[i]!,name=columns[i]!,integer=i===4||i===8||i===9||i===10;
    const nullable=i===10||i===12||i===15||i===16;
    f.require(nullable||cell[0]!=='null');
    if(integer){
      if(encoding.backend==='postgres')f.require(cell[0]==='null'||cell[0]==='pg-binary'&&cell[1]===(i===4?'23':'20'));
      else f.require(cell[0]==='null'||cell[0]==='integer');
      const value=g.integer(cell);f.require(value===null||value>=0n);decoded[name]=value===null?null:String(value);
      if(i===4){f.require(value!==null&&value>0n);protocol=g.count(value);}
      else semantic[name]=value===null?['null']:['integer',String(value)];
    }else{
      const value=decodeText(g,cell,encoding);decoded[name]=value;
      if(i===16)format=value;else semantic[name]=cell[0]==='null'?['null']:['text',cell[cell[0]==='text'?1:2]];
    }
  }
  f.require(decoded.client_id!==null&&decoded.client_id!==''
    &&(protocol===1?format===null:protocol===current.protocolVersion&&format===current.writerFormatDigest));
  f.freeze(semantic);f.freeze(decoded);return {raw:row,key:key(g,row,encoding),semantic:semantic as SemanticRow,
    decoded:decoded as Decoded,protocol,format};
}
/** Typed CF01/CF02 frames after the caller has checked the exact selected table
 * and column contract. This returns values only, not facts or a live authority. */
export function readM2ClientFrames(g:M2Graph,table:ReadonlyDeep<RawTable>,encoding:ClientTextEncoding,current:Pair,source:SourceRef) {
  const f:FState=g.f;f.require(encoding.backend===source.kind&&supportedEncoding(encoding),'semantic_unsupported','format-mismatch');
  const rows=orderedRows(g,table,encoding),domain={source,textEncoding:encoding,columnContract:table.columnContract,
    columnContractValueDigest:table.columnContractValueDigest};
  f.charge(rows.length,0,rows.length*2+4);
  const decoded=rows.map(row=>clientRow(g,row,encoding,current));
  return {rows,decoded,rowDigests:rows.map(row=>rowDigest(g,domain,row)),rowsDigest:rowsDigest(g,domain,rows)};
}
function expectedCreation(input:M2OwnerClientsInput) {
  return {migrationId:input.migrationId,plan:input.plan,fenceEpoch:String(input.fenceEpoch),
    ownerGeneration:String(input.toGeneration),previousAnchor:input.previous,targetSequence:String(input.targetSequence)};
}
function controller(g:M2Graph,row:ClientRow,fact:Extract<ClientFact,{kind:'maintenance-controller'}>,
  input:M2OwnerClientsInput,metadata:EventFacts):void {
  const f:FState=g.f,prior=input.knownRegistrations.get(row.key),s=row.semantic,d=row.decoded;
  const body=g.jsonText(d.db_sessions_json!,true);
  if(prior?.birthFormat){
    f.charge(1,0,4,20);g.same(body,{formatVersion:2,kind:'profile-maintenance-controller-registration',source:input.source,
      sourceIdentityDigest:input.source.identityDigest,creation:prior.creation,writerFormat:prior.birthFormat,
      sessionBinding:'per-source-lock-native-inventory-v1',drainReceipt:null});
    f.require(d.database_instance_id===input.source.databaseInstanceId&&d.entrypoint==='maintenance-controller'
      &&d.build_id==='boardroom-maintenance-control-v1'&&d.drain_state==='none'&&s.drain_epoch[0]==='null'
      &&s.drain_receipt_digest[0]==='null'&&d.registered_epoch===d.observed_epoch
      &&d.registered_epoch===prior.creation.fenceEpoch);
    f.require(d.host_identity_json===f.canonical(fact.host)&&d.process_identity_json===f.canonical(fact.process));
  }else{
    // The original v1 creation is immutable, including after A changes the two
    // format cells. The old pure registration decoder still checks every field.
    const parsed=controllerRegistration(s,d,fact,input.source);
    if(prior)g.same(parsed.creation,prior.creation);
  }
  if(prior){f.require(fact.registration==='current-chain'&&prior.actorId===fact.process.instanceId
      &&d.registered_epoch===String(input.fenceEpoch));}
  else f.require(fact.registration==='R0-historical'&&BigInt(d.registered_epoch!)<BigInt(input.fenceEpoch)
    &&fact.classification==='exited-actor'&&row.protocol===1);
  if(fact.classification==='active-actor'){
    f.require(s.ended_at[0]==='null'&&row.protocol===input.currentFormat.protocolVersion
      &&row.format===input.currentFormat.writerFormatDigest&&metadata.actor.clientId!==null);
    g.same(fact.host,metadata.actor.host);g.same(fact.process,metadata.actor.process);
  }
}
function runtimeTable(g:M2Graph,cut:SP_RowCut,name:string):SP_RawTable {
  g.f.charge(cut.tables.length);const t=cut.tables.find(t=>t.name===name);g.f.require(t);return t;
}
function runtime(g:M2Graph,cut:SP_RowCut,metadata:EventFacts):void {
  const f:FState=g.f,bindings=runtimeTable(g,cut,'agent_runtime_bindings'),runners=runtimeTable(g,cut,'agent_runner_states'),
    owners=runtimeTable(g,cut,'agent_runtime_members');
  f.charge(bindings.rows.length,0,bindings.rows.length+1);const members=new Map<string,string>();
  const text=(table:string,row:ReadonlyDeep<RawRow>,name:string):string=>{const v=g.scalar(table,row,name);f.require(typeof v==='string');return v;};
  const nullable=(table:string,row:ReadonlyDeep<RawRow>,name:string):string|null=>{const v=g.scalar(table,row,name);f.require(typeof v==='string'||v===null);return v;};
  const number=(table:string,row:ReadonlyDeep<RawRow>,name:string):number=>{const v=g.scalar(table,row,name);f.require(typeof v==='bigint');return g.count(v);};
  for(const row of bindings.rows){const id=text(bindings.name,row,'id');f.require(!members.has(id));members.set(id,text(bindings.name,row,'member_id'));}
  const ordered=g.sort(runners.rows,(a,b)=>g.compareText(text(runners.name,a,'binding_id'),text(runners.name,b,'binding_id')));
  f.require(ordered.length===metadata.runtime.runners.length);
  for(let i=0;i<ordered.length;i++){
    const row=ordered[i]!,fact=metadata.runtime.runners[i]!,bindingId=text(runners.name,row,'binding_id'),memberId=members.get(bindingId);
    f.require(memberId!==undefined);const identity=nullable(runners.name,row,'process_identity_json');
    f.charge(1,0,1,8);g.same({bindingId,memberId,generation:number(runners.name,row,'generation'),
      leaseOwner:nullable(runners.name,row,'lease_owner'),exitConfirmed:number(runners.name,row,'exit_confirmed'),
      processIdentity:identity===null?null:g.jsonText(identity)},
      {bindingId:fact.bindingId,memberId:fact.memberId,generation:fact.generation,leaseOwner:fact.leaseOwner,
        exitConfirmed:fact.exitConfirmed,processIdentity:fact.processIdentity});
  }
  const actual=g.sort(owners.rows,(a,b)=>g.compareText(text(owners.name,a,'member_id'),text(owners.name,b,'member_id')));
  f.require(actual.length===metadata.runtime.owners.length);
  for(let i=0;i<actual.length;i++){
    const row=actual[i]!;f.charge(1,0,1,6);g.same({memberId:text(owners.name,row,'member_id'),bindingId:nullable(owners.name,row,'binding_id'),
      generation:number(owners.name,row,'generation'),leaseOwner:nullable(owners.name,row,'lease_owner'),
      leaseExpiresAt:nullable(owners.name,row,'lease_expires_at')},metadata.runtime.owners[i]);
  }
  runtimeRelations(metadata);
}

/** R22/CF01–06 for M2's finite after-A owner branch. The caller supplies only
 * state derived from the same fully replayed origin. No live permit is returned. */
export function checkM2OwnerClients(g:M2Graph,input:M2OwnerClientsInput) {
  const f:FState=g.f;
  const delta=g.evidence(input.delta,'m2-source-client-delta'),facts=g.payload(delta.facts,'m2-source-client-facts');
  g.same(f.decode(input.plan,'plan'),input.actualPlan);
  g.same(delta.source,input.source);m2Definition(f,'ProfileCurrentClientFormat',input.currentFormat);
  f.require(input.currentFormat.kind==='m2-profile','semantic_unsupported','undefined-grammar');
  const receipt=g.payload(input.currentFormat.activationReceipt,'m2-activation-receipt');
  f.require(input.currentFormat.protocolVersion===receipt.guardTransition.protocolAfter
    &&input.currentFormat.writerFormatDigest===receipt.guardTransition.writerFormatDigest);
  f.require(input.fromGeneration<Number.MAX_SAFE_INTEGER&&input.toGeneration===input.fromGeneration+1
    &&input.beforeControl.ownerGeneration===input.fromGeneration&&input.beforeControl.fenceEpoch===input.fenceEpoch
    &&input.beforeControl.admission==='sealed'&&input.beforeControl.protocolVersion===2
    &&input.beforeControl.profileTakeoverTerminal===null&&input.beforeControl.activeMigrationId===input.migrationId
    &&input.beforeControl.planDigest===input.plan.sha256&&input.beforeControl.databaseInstanceId===input.source.databaseInstanceId);
  g.same(input.beforeControl.journal,{record:{artifactId:input.previous.ref,digest:input.previous.sha256},sequence:input.targetSequence-1});
  g.same(facts.context,{source:input.source,migrationId:input.migrationId,plan:input.plan,event:'s2_profile_owner_acquired',
    phase:'s2_profile_committed',epochBefore:input.fenceEpoch,epochAfter:input.fenceEpoch,fromGeneration:input.fromGeneration,
    toGeneration:input.toGeneration,previousAnchor:input.previous,targetSequence:input.targetSequence,originCapture:input.originCapture,
    receiptGeneration:input.receiptGeneration,currentFormat:input.currentFormat});
  const encoding=facts.textEncoding;f.require(encoding.backend===input.source.kind&&supportedEncoding(encoding),'semantic_unsupported','format-mismatch');
  g.same(delta.before,facts.before);g.same(delta.after,facts.after);
  g.same(facts.before.columnContract,facts.columnContract);g.same(facts.after.columnContract,facts.columnContract);
  f.require(facts.before.columnContractValueDigest===facts.columnContractValueDigest&&facts.after.columnContractValueDigest===facts.columnContractValueDigest);
  const before=g.table(delta.before,input.source,input.source.kind,'p1'),after=g.table(delta.after,input.source,input.source.kind,'p1');
  sameTable(g,before,input.before,encoding);
  const checked=readM2ClientFrames(g,before,encoding,input.currentFormat,input.source),checkedAfter=readM2ClientFrames(g,after,encoding,input.currentFormat,input.source);
  const rows=checked.rows,nextRows=checkedAfter.rows;
  f.require(facts.observation.beforeCount===String(rows.length)&&facts.observation.beforeRowsDigest===checked.rowsDigest
    &&facts.afterCount===String(nextRows.length)&&facts.afterRowsDigest===checkedAfter.rowsDigest);
  const cut=g.rawCut(facts.runtimeCut);g.same(cut.source,input.source);g.same(cut.predecessor,input.previous);
  f.require(cut.stage==='p1-source'&&cut.backend===input.source.kind);
  const frozen=input.frozenHistory.observation;
  g.same(frozen.textEncoding,encoding);
  g.same(frozen.source,input.source);f.require(frozen.backend===input.source.kind&&frozen.phase==='p1'&&cut.tables.length===frozen.tables.length);
  for(const table of cut.tables){
    const original=g.tableOf(input.frozenHistory,table.name);g.same(table.columns,original.columns);
    if(table.name==='storage_maintenance'||table.name==='storage_source_clients')continue;
    f.require(table.count===original.count);
    g.same(g.sort(table.rows,(a,b)=>g.compareText(f.canonical(a),f.canonical(b))),
      g.sort(original.rows,(a,b)=>g.compareText(f.canonical(a),f.canonical(b))));
  }
  g.same(cut.sequences,frozen.sequences);
  // SP_RowCut/r1 currently defines UTF-8 only. Other row encodings do not turn
  // this strict cut into a different producer format.
  f.require(encoding.name===(encoding.backend==='sqlite'?'UTF-8':'UTF8'),'semantic_unsupported','format-mismatch');
  const cutClients=runtimeTable(g,cut,'storage_source_clients');g.same(cutClients.columns,before.columns);
  f.require(cutClients.count===before.count);g.same(g.sort(cutClients.rows,(a,b)=>g.compareText(key(g,a,encoding),key(g,b,encoding))),rows);
  g.same(readM2Control(g,runtimeTable(g,cut,'storage_maintenance'),'p1'),input.beforeControl);

  // Only the header is projected for the original JS refinements. CF digests,
  // raw tables, context and runtime joins above remain their r2 originals.
  f.charge(1,0,1,13);const projected={...facts.observation,formatVersion:1,kind:'source-control-event-facts',collector:'boardroom-source-control-facts-v1'};
  f.freeze(projected);const frame=p0FCodecSyntaxFrame(f,projected);
  try{return withP0FNativeConsumer(frame,()=>{
    reserveP0FNativeClone(projected);const parsed=eventFactsSchema.safeParse(projected);f.require(parsed.success);
    const metadata=parsed.data;f.freeze(metadata);const size=f.size(metadata),n=metadata.clients.length+metadata.runtime.runners.length+metadata.runtime.owners.length+metadata.runtime.results.length+1;
    f.charge(size.nodes*(n+4),size.text*4,n*n);
    checkFactsShape(metadata,input.source);f.require(metadata.clients.length===rows.length);
    f.charge(rows.length,0,rows.length*2+4);const decoded=checked.decoded;
    const byKey=new Map(decoded.map(row=>[row.key,row]));
    const record={source:input.source,migrationId:input.migrationId,plan:input.plan,ownerGeneration:input.toGeneration,sequence:input.targetSequence};
    const context:RowContext={plan:input.actualPlan,record,fenceEpoch:input.fenceEpoch,encoding,receiptGeneration:String(input.receiptGeneration),
      registrations:new Map(),unresolvedEncoding:new Set()};
    f.freeze(record);const expected:ReturnType<typeof ordinaryProfile>=[];
    for(let i=0;i<decoded.length;i++){
      const row=decoded[i]!,fact=metadata.clients[i]!;g.same(fact.subject,['text',row.key]);
      f.require(fact.rowDigest===checked.rowDigests[i]);
      g.same(g.jsonText(row.decoded.host_identity_json!),fact.host);g.same(g.jsonText(row.decoded.process_identity_json!),fact.process);
      // Apply the shared duplicate-key/depth/number parser before the existing
      // session refinement's own JSON decoder consumes this same immutable text.
      g.jsonText(row.decoded.db_sessions_json!);
      const legacy=f.size(row.semantic);
      // The old pure profile functions retain their own JSON parse/clone. Pay
      // for that additional work before entering those fixed consumers.
      f.charge(legacy.nodes*8,legacy.text*4,legacy.nodes*2,legacy.nodes);
      if(fact.kind==='maintenance-controller')controller(g,row,fact,input,metadata);
      else{
        f.require(BigInt(row.decoded.registered_epoch!)<BigInt(input.fenceEpoch)
          &&fact.classification===sourceClientEpochClassification(row.semantic,input.fenceEpoch));
        const selected=ordinaryProfile(row.semantic,row.decoded,fact,context);f.charge(selected.length,0,selected.length);expected.push(...selected);
      }
    }
    runtime(g,cut,metadata);sessionSources(metadata,context,expected,true);
    const registrations=new Map(input.knownRegistrations);f.charge(registrations.size,0,registrations.size+1);
    const applied=new Map(rows.map(row=>[key(g,row,encoding),row]));f.charge(rows.length,0,rows.length*3+2);
    let priorKey:string|undefined,added=0,actorClientId:string|undefined;
    const active=metadata.clients.filter(fact=>fact.kind==='maintenance-controller'&&fact.classification==='active-actor');f.charge(metadata.clients.length,0,active.length+1);
    f.require(active.length<2);
    if(metadata.actor.clientId!==null){f.require(active.length===1);const row=byKey.get(metadata.actor.clientId[1]);f.require(row);actorClientId=row.decoded.client_id!;}
    const observedAt=textCell(g,metadata.observedAt,encoding);
    for(const change of delta.changes){
      const changed=clientRow(g,change.after,encoding,input.currentFormat),k=changed.key;
      f.require(priorKey===undefined||g.compareText(priorKey,k)<0);priorKey=k;f.require(change.clientId===changed.decoded.client_id);
      if(change.kind==='maintenance-registration'){
        f.require(++added===1&&!applied.has(k)&&!registrations.has(k)&&metadata.actor.clientId===null&&active.length===0
          &&change.actorId===metadata.actor.actorId);
        for(const fact of metadata.clients){f.charge(1);f.require(fact.process.instanceId!==change.actorId);}
        for(const registration of registrations.values()){f.charge(1);f.require(registration.actorId!==change.actorId);}
        const creation=expectedCreation(input),pair={protocolVersion:input.currentFormat.protocolVersion,writerFormatDigest:input.currentFormat.writerFormatDigest};
        const session={formatVersion:2,kind:'profile-maintenance-controller-registration',source:input.source,sourceIdentityDigest:input.source.identityDigest,
          creation,writerFormat:pair,sessionBinding:'per-source-lock-native-inventory-v1',drainReceipt:null};
        f.charge(1,0,6,30);const wanted=[textCell(g,change.clientId,encoding),textCell(g,input.source.databaseInstanceId,encoding),
          textCell(g,'maintenance-controller',encoding),textCell(g,'boardroom-maintenance-control-v1',encoding),g.rawInteger(pair.protocolVersion,input.source.kind,'23'),
          textCell(g,f.canonical(metadata.actor.host),encoding),textCell(g,f.canonical(metadata.actor.process),encoding),textCell(g,f.canonical(session),encoding),
          g.rawInteger(input.fenceEpoch,input.source.kind),g.rawInteger(input.fenceEpoch,input.source.kind),['null'],textCell(g,'none',encoding),['null'],
          observedAt,observedAt,['null'],textCell(g,pair.writerFormatDigest,encoding)];
        g.same(change.after.cells,wanted);f.charge(1,0,2);registrations.set(k,{creation,actorId:change.actorId,birthFormat:pair});actorClientId=change.clientId;
      }else{
        const original=applied.get(k);f.require(original);g.same(original,change.before);f.require(!f.equal(change.before,change.after));
        f.require(change.before.rowid===change.after.rowid);
        for(let i=0;i<17;i++)if(i!==14&&i!==15)g.same(change.before.cells[i],change.after.cells[i]);
        g.same(change.after.cells[14],observedAt);
        const fact=metadata.clients.find(fact=>fact.subject[1]===k);f.charge(metadata.clients.length);f.require(fact);
        if(change.effect==='observed')g.same(change.after.cells[15],change.before.cells[15]);
        else{f.require(!(fact.kind==='maintenance-controller'&&fact.classification==='active-actor')&&processDisposition(fact.process,fact.processCheck)==='exited');g.same(change.after.cells[15],observedAt);}
      }
      f.charge(1,0,applied.has(k)?0:1);applied.set(k,change.after);
    }
    // This finite entry is specifically owner_acquired with G+1. An existing
    // actor's ordinary observation keeps G and cannot satisfy this transition.
    f.require(added===1&&actorClientId!==undefined);f.charge(applied.size,0,applied.size+1);
    g.same(g.sort([...applied.values()],(a,b)=>g.compareText(key(g,a,encoding),key(g,b,encoding))),nextRows);
    return {after,actorClientId,registrations:registrations as ReadonlyMap<string,M2ClientRegistration>};
  });}catch(error){if(maintenanceFailureCode(error)!==undefined)f.require(false);throw error;}
}

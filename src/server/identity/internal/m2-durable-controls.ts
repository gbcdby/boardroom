import type { RawRow, RawTable } from '../m2-history-contracts.ts';
import type { ReadonlyDeep } from '../m2-value-contracts.ts';
import type { SourceClientRawRow } from '../../storage/maintenance/types.ts';
import type { RowContext } from '../../storage/maintenance/control-candidate/rows.ts';
import type { SnapshotValueClosure } from '../../storage/maintenance/journal-values.ts';
import { M2_PROFILE_WRITER_CONTRACT } from './m2-profile-writer-contract.ts';
import { M2Graph } from './m2-durable-graph.ts';
import type { M2HistoryData } from './m2-durable-graph.ts';
import type { FState } from './m2-p0-artifacts-common.ts';
import { m2Definition } from './m2-durable-schema.ts';
import type { ArtifactRef, EvidenceRef, M2ControlValue, ProfileCompletionBinding, SourceRef } from './m2-durable-types.ts';

const clientColumns=Object.freeze(['client_id','database_instance_id','entrypoint','build_id','protocol_version','host_identity_json',
  'process_identity_json','db_sessions_json','registered_epoch','observed_epoch','drain_epoch','drain_state','drain_receipt_digest',
  'registered_at','last_observed_at','ended_at']);

export function readM2Control(g:M2Graph,table:Pick<ReadonlyDeep<RawTable>,'name'|'count'|'rows'>,phase:'p0'|'p1'):M2ControlValue {
  const f:FState=g.f;f.require(table.name==='storage_maintenance'&&table.rows.length===1&&table.count==='1');
  const row=table.rows[0]!,s=(name:string)=>g.scalar(table.name,row,name,phase);
  const text=(name:string):string=>{const value=s(name);f.require(typeof value==='string');return value;};
  const nullable=(name:string):string|null=>{const value=s(name);f.require(typeof value==='string'||value===null);return value;};
  const counter=(name:string)=>{const value=s(name);f.require(typeof value==='bigint');return g.count(value);};
  const sequence=counter('journal_sequence'),reference=nullable('journal_record_ref'),digest=nullable('journal_digest');
  f.require(sequence===0?reference===null&&digest===null:reference!==null&&digest!==null);
  const rawTerminal=phase==='p0'?null:nullable('profile_takeover_terminal_json');
  const terminal=rawTerminal===null?null:m2Definition(f,'ProfileCompletionBinding',g.jsonText(rawTerminal,true));
  if(terminal)f.require(terminal.epochBefore<Number.MAX_SAFE_INTEGER&&terminal.epochAfter===terminal.epochBefore+1);
  f.charge(15,0,4,20);
  const result={singleton:counter('singleton'),databaseInstanceId:text('database_instance_id'),controlRootJson:text('control_root_json'),
    mutexIdentityJson:text('mutex_identity_json'),fenceEpoch:counter('fence_epoch'),admission:text('admission'),
    activeMigrationId:nullable('active_migration_id'),planDigest:nullable('plan_digest'),protocolVersion:counter('protocol_version'),
    guardManifestDigest:text('guard_manifest_digest'),ownerGeneration:counter('owner_generation'),
    journal:sequence===0?null:{record:{artifactId:reference!,digest:digest!},sequence},profileTakeoverTerminal:terminal};
  g.jsonText(result.controlRootJson,true);g.jsonText(result.mutexIdentityJson,true);
  return m2Definition(f,'M2ControlValue',result);
}
export function selectedM2Control(g:M2Graph,reference:EvidenceRef,source:SourceRef,phase:'p0'|'p1') {
  const value=g.evidence(reference,'m2-control-observation');g.same(value.source,source);
  const maintenance=g.table(value.maintenanceTable,source,source.kind,phase),clients=g.table(value.sourceClientsTable,source,source.kind,phase);
  g.f.require(clients.name==='storage_source_clients');const control=readM2Control(g,maintenance,phase);g.same(control,value.control);
  return {value,maintenance,clients,control};
}
function clientKey(g:M2Graph,row:ReadonlyDeep<RawRow>):string {
  const value=g.text(row.cells[0]!);g.f.require(value!==null&&value.length>0);return value;
}
export function clientMap(g:M2Graph,table:ReadonlyDeep<RawTable>):Map<string,ReadonlyDeep<RawRow>> {
  const f:FState=g.f;f.require(table.name==='storage_source_clients');f.charge(table.rows.length*2,0,table.rows.length*2+2);
  const rows=new Map<string,ReadonlyDeep<RawRow>>(),rowids=new Set<string>();
  for(const row of table.rows){const key=clientKey(g,row);f.require(!rows.has(key));rows.set(key,row);
    if(row.rowid!==null){f.require(!rowids.has(row.rowid));rowids.add(row.rowid);}}
  return rows;
}
/** The complete old parser/replay has already checked every proof. Derive its
 * actual latest cells, keeping capture and ready/control observations distinct. */
export function checkM2OldControlTail(g:M2Graph,ready:SnapshotValueClosure,before:M2HistoryData,
  selected:ReturnType<typeof selectedM2Control>):void {
  const f:FState=g.f,chain=ready.chain.nodes,origin=chain.find(n=>n.record.event==='capture'),last=chain.at(-1)!;
  f.require(origin&&origin.record.formatVersion!==1&&origin.record.sourceClients!==null&&last.record.phase==='snapshot_ready');
  const rows=new Map<string,SourceClientRawRow>();f.charge(origin.record.sourceClients.rows.length,0,origin.record.sourceClients.rows.length+1);
  for(const row of origin.record.sourceClients.rows)rows.set(row.client_id[1],row);
  for(const node of chain){f.charge(1);const proof=node.record.formatVersion===3?node.record.controlProof:null;
    if(proof&&(proof.kind==='control-successor'||proof.kind==='legacy-first-capture-bridge'))for(const change of proof.changes){
      f.charge(1,0,rows.has(change.after.client_id[1])?0:1);rows.set(change.after.client_id[1],change.after);}}
  const observed=clientMap(g,selected.clients);f.require(observed.size===rows.size);
  for(const row of selected.clients.rows){const key=row.cells[0]![row.cells[0]![0]==='pg-binary'?2:1];f.require(typeof key==='string');const expected=rows.get(key);f.require(expected);
    for(let i=0;i<16;i++){
      const cell=row.cells[i]!,native=expected[clientColumns[i]! as keyof SourceClientRawRow];
      if(cell[0]==='pg-binary'){if(cell[1]==='25')g.same(['text',cell[2]],native);else g.same(['integer',String(g.integer(cell))],native);}
      else g.same(cell,native);
    }
  }
  const original=clientMap(g,g.tableOf(before,'storage_source_clients'));
  for(const [id,row] of original){const current=observed.get(id);f.require(current&&current.rowid===row.rowid);}
  const capture=readM2Control(g,g.tableOf(before,'storage_maintenance'),'p0');
  g.same(selected.control,{...capture,ownerGeneration:last.record.ownerGeneration,fenceEpoch:last.record.fenceEpoch,
    journal:{record:{artifactId:last.reference.ref,digest:last.reference.sha256},sequence:last.record.sequence}});
  f.require(selected.control.admission==='sealed'&&selected.control.protocolVersion===1&&selected.control.profileTakeoverTerminal===null);
}
export function checkM2ActivationControls(g:M2Graph,before:ReturnType<typeof selectedM2Control>,after:Pick<ReturnType<typeof selectedM2Control>,'maintenance'|'clients'|'control'>,
  activation:ArtifactRef,sequence:number,guard:string,coordinator:string):void {
  const f:FState=g.f,backend=before.value.source.kind;
  g.same(readM2Control(g,after.maintenance,'p1'),after.control);
  g.same(after.control,{...before.control,protocolVersion:2,guardManifestDigest:guard,
    journal:{record:{artifactId:activation.ref,digest:activation.sha256},sequence}});
  f.require(after.maintenance.rows[0]!.rowid===before.maintenance.rows[0]!.rowid);
  const prior=clientMap(g,before.clients),next=clientMap(g,after.clients);f.require(prior.size===next.size&&prior.has(coordinator));
  const pair=M2_PROFILE_WRITER_CONTRACT.profileFormatPair;
  for(const [id,row] of prior){const actual=next.get(id);f.require(actual&&actual.rowid===row.rowid);const cells=[...row.cells];f.charge(18,0,18,20);
    if(id===coordinator){f.require(g.integer(row.cells[4]!)===1n&&g.text(row.cells[2]!)==='maintenance-controller'
        &&g.text(row.cells[3]!)==='boardroom-maintenance-control-v1'&&row.cells[15]![0]==='null');
      cells[4]=g.rawInteger(2,backend,'23');cells.push(g.rawText(pair.writerFormatDigest,backend));
    }else cells.push(['null']);g.same(actual.cells,cells);
  }
}
export function checkM2TerminalControl(g:M2Graph,before:M2HistoryData,after:M2HistoryData,terminal:ArtifactRef,
  completion:ProfileCompletionBinding):void {
  const f:FState=g.f,a=before.observation,b=after.observation;f.require(b.phase==='p1'&&a.backend===b.backend);g.same(a.source,b.source);
  const initial=readM2Control(g,g.tableOf(before,'storage_maintenance'),'p1'),final=readM2Control(g,g.tableOf(after,'storage_maintenance'),'p1');
  f.require(initial.profileTakeoverTerminal===null&&initial.admission==='sealed'&&initial.fenceEpoch===completion.epochBefore);
  g.same(final,{...initial,admission:'open',activeMigrationId:null,planDigest:null,fenceEpoch:completion.epochAfter,
    journal:{record:{artifactId:terminal.ref,digest:terminal.sha256},sequence:completion.terminal.sequence},profileTakeoverTerminal:completion});
  for(const table of a.tables){const other=g.tableOf(after,table.name);g.same(table.columnContract,other.columnContract);f.require(table.columnContractValueDigest===other.columnContractValueDigest);
    if(table.name==='storage_maintenance')f.require(table.rows[0]!.rowid===other.rows[0]!.rowid);
    else g.same(g.sort(table.rows,(x,y)=>g.compareText(f.canonical(x),f.canonical(y))),g.sort(other.rows,(x,y)=>g.compareText(f.canonical(x),f.canonical(y))));}
  g.same(a.sequences,b.sequences);
}

/** Data projection of registrations already authenticated by the complete old
 * readJournalValues/applyControlNode chain; never accepted from caller metadata. */
export function deriveM2OldRegistrations(g:M2Graph,ready:SnapshotValueClosure):ReadonlyMap<string,RowContext['registrations'] extends Map<string,infer T>?T:never>{
  const f:FState=g.f;const registrations:RowContext['registrations']=new Map();f.charge(1,0,1);
  for(const {record} of ready.chain.nodes){const proof=record.formatVersion===3?record.controlProof:null;
    if(proof&&(proof.kind==='control-successor'||proof.kind==='legacy-first-capture-bridge'))for(const change of proof.changes){
      f.charge(1);if(change.kind!=='maintenance-registration')continue;f.require(record.previous!==null);f.charge(10,0,4,12);
      registrations.set(change.after.client_id[1],{actorId:change.actorId,creation:{migrationId:record.migrationId,plan:record.plan,
        fenceEpoch:String(record.fenceEpoch),ownerGeneration:String(record.ownerGeneration),previousAnchor:record.previous,targetSequence:String(record.sequence)}});
    }
  }return registrations;
}

import { M2_HISTORY_TABLES } from '../m2-history-contracts.ts';
import type { RawRow, RawTable, RawCell } from '../m2-history-contracts.ts';
import type { ActivationReceipt, ReadonlyDeep } from '../m2-value-contracts.ts';
import type { SnapshotValueClosure } from '../../storage/maintenance/journal-values.ts';
import { M2Graph } from './m2-durable-graph.ts';
import type { M2HistoryData } from './m2-durable-graph.ts';
import type { FState } from './m2-p0-artifacts-common.ts';
import type { AllowedDeltaManifest, ArtifactRef, FixedRowProjection, RegisteredUpgradeDescriptor, TakeoverPlan, TakeoverSeed, TargetRowsManifest } from './m2-durable-types.ts';
import { CONTROLLED_M22 } from './m2-controlled-migration-contract.ts';
import { M2_PROFILE_WRITER_CONTRACT } from './m2-profile-writer-contract.ts';

export const M2_INITIAL_TABLES=Object.freeze(['agent_profile_versions','agent_profiles','config_detach_snapshots','config_mutation_receipts',
  'config_snapshots','config_workspace_mappings','group_binding_config_versions','group_bindings','legacy_config_captures']);
const contracts=new Map(M2_HISTORY_TABLES.map(t=>[t.name,t]));
const executionColumns=Object.freeze({agent_runtime_bindings:['id','group_binding_id','attachment_state','detach_config_snapshot_id','detached_at','requested_config_snapshot_id','requested_workspace_mapping_id'],
  agent_runner_states:['binding_id','applied_config_snapshot_id','applied_workspace_mapping_id']});
function ordered(g:M2Graph,rows:readonly ReadonlyDeep<RawRow>[]):string[]{
  const f:FState=g.f;f.charge(rows.length,0,rows.length+1);return g.sort(rows.map(row=>f.canonical([row.rowid,row.cells])),(a,b)=>g.compareText(a,b));
}
function sameRows(g:M2Graph,a:readonly ReadonlyDeep<RawRow>[],b:readonly ReadonlyDeep<RawRow>[]):void {g.same(ordered(g,a),ordered(g,b));}
export function projectionRows(g:M2Graph,p:FixedRowProjection,columns:readonly string[],backend:'sqlite'|'postgres'):void {
  const f:FState=g.f;g.same(p.columns,columns);f.require(p.count===String(p.rows.length));let last:string|undefined;const ids=new Set<string>();
  f.charge(p.rows.length,0,p.rows.length+1);
  for(const row of p.rows){f.require(row.cells.length===columns.length&&(backend==='sqlite'?row.rowid!==null:row.rowid===null));
    if(row.rowid!==null){f.require(!ids.has(row.rowid));ids.add(row.rowid);}const frame=f.canonical([row.rowid,row.cells]);
    if(last!==undefined)f.require(g.compareText(last,frame)<=0);last=frame;
  }
}
function project(g:M2Graph,table:ReadonlyDeep<RawTable>,columns:readonly string[]):readonly ReadonlyDeep<RawRow>[] {
  const f:FState=g.f;f.charge(columns.length,0,columns.length+1);const ordinals=columns.map(name=>{const i=table.columns.indexOf(name);f.require(i>=0);return i;});
  f.charge(table.rows.length*columns.length,0,table.rows.length*(columns.length+2)+1,table.rows.length*2);
  return table.rows.map(row=>({rowid:row.rowid,cells:ordinals.map(i=>row.cells[i]!)}));
}
/** Exact R16 transformed domain, with every table/column/count/frame retained. */
export function checkM2TargetRows(g:M2Graph,target:TargetRowsManifest,seed:TakeoverSeed,seedRef:ArtifactRef,after:M2HistoryData):void {
  const f:FState=g.f,o=after.observation;g.same(target.source,seed.source);g.same(target.rows.source,seed.source);g.same(target.seed,seedRef);
  f.require(target.capture.captureId===seed.captureId&&target.rows.newTables.length===9&&target.rows.executionReferences.length===2);
  for(let i=0;i<9;i++){const p=target.rows.newTables[i]!;f.require(p.table===M2_INITIAL_TABLES[i]);
    const columns=contracts.get(p.table)!.columnsP1.map(c=>c.name);projectionRows(g,p,columns,o.backend);sameRows(g,p.rows,g.tableOf(after,p.table).rows);}
  for(let i=0;i<2;i++){const name=i===0?'agent_runtime_bindings':'agent_runner_states',p=target.rows.executionReferences[i]!;f.require(p.table===name);
    const columns=executionColumns[name];projectionRows(g,p,columns,o.backend);sameRows(g,p.rows,project(g,g.tableOf(after,name),columns));}
  f.require(target.rows.auditAdditions.table==='audit_log');projectionRows(g,target.rows.auditAdditions,contracts.get('audit_log')!.columnsP1.map(c=>c.name),o.backend);
  f.charge(1,0,1,6);f.require(target.targetRowsDigest===f.digestCr3(['m2-transformed-business-rows/r1',target.source,target.rows.newTables,target.rows.executionReferences,target.rows.auditAdditions]));
}
function migrationTimestamp(g:M2Graph,text:string,backend:'sqlite'|'postgres'):ReadonlyDeep<RawCell> {
  if(backend==='sqlite')return g.rawText(text,backend);
  const f:FState=g.f;f.charge(25,4096,4,4);
  const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):?(\d{2}))$/.exec(text);
  f.require(m&&m[1]!=='0000','semantic_unsupported');const fraction=m[7]??'';f.require(!/[1-9]/.test(fraction.slice(6)),'semantic_unsupported');
  const year=Number(m[1]),month=Number(m[2]),day=Number(m[3]),hour=Number(m[4]),minute=Number(m[5]),second=Number(m[6]);
  const beforeYear=(y:number)=>365*(y-1)+Math.floor((y-1)/4)-Math.floor((y-1)/100)+Math.floor((y-1)/400);
  const daysIn=[31,year%4===0&&(year%100!==0||year%400===0)?29:28,31,30,31,30,31,31,30,31,30,31];
  f.require(month>=1&&month<=12&&day>=1&&day<=daysIn[month-1]!&&hour<24&&minute<60&&second<60);
  const offset=m[8]==='Z'?0:(m[9]==='+'?1:-1)*(Number(m[10])*60+Number(m[11]));
  let days=beforeYear(year)-beforeYear(2000)+day-1;for(let i=1;i<month;i++)days+=daysIn[i-1]!;
  const micro=(BigInt(days)*86400n+BigInt(hour*3600+minute*60+second-offset*60))*1000000n+BigInt(fraction.slice(0,6).padEnd(6,'0'));
  const bytes=Buffer.alloc(8);bytes.writeBigInt64BE(micro);return ['pg-binary','1184',bytes.toString('hex')];
}
export function checkM2Upgrade(g:M2Graph,plan:TakeoverPlan,receipt:ActivationReceipt,old:SnapshotValueClosure):RegisteredUpgradeDescriptor {
  const f:FState=g.f,upgrade=g.evidence(plan.guardTransition.registeredUpgrade,'m2-upgrade-descriptor');
  f.require(upgrade.sourceBackend===plan.source.kind&&upgrade.writerFormatDigest===M2_PROFILE_WRITER_CONTRACT.profileFormatPair.writerFormatDigest);
  for(const key of ['schemaBeforeDigest','schemaAfterDigest','guardBeforeDigest','guardAfterDigest','writerFormatDigest','writerFormat','protocolBefore','protocolAfter'] as const)
    g.same(upgrade[key],plan.guardTransition[key]);
  g.same(receipt.guardTransition,plan.guardTransition);
  f.require(upgrade.schemaBeforeDigest===old.manifests.schemaManifestDigest&&upgrade.guardBeforeDigest===old.chain.plan.guardManifestDigest);
  for(const role of ['sqliteTargetSchemaRef','postgresTargetSchemaRef','guardTransitionRef','strictDecoderContractRef','sourceClientFormatContractRef'] as const)
    g.fixed(upgrade[role],`RegisteredUpgradeDescriptor.${role}`);
  return upgrade;
}
/** R17 compares actual native cells, including the two rows excluded from the
 * target-business digest. Control changes are verified by the journal replay. */
export function checkM2AllowedDelta(g:M2Graph,delta:AllowedDeltaManifest,plan:TakeoverPlan,seed:TakeoverSeed,
  target:TargetRowsManifest,before:M2HistoryData,after:M2HistoryData,receipt:ActivationReceipt):void {
  const f:FState=g.f,backend=before.observation.backend;f.require(before.observation.phase==='p0'&&after.observation.phase==='p1'&&after.observation.backend===backend);
  g.same(delta.source,plan.source);g.same(delta.seed,plan.seed);g.same(delta.before,seed.before);g.same(delta.sourceToTarget,plan.sourceToTargetManifest);
  g.same(delta.upgrade,plan.guardTransition.registeredUpgrade);f.require(delta.planId===plan.planId);g.same(before.observation.source,after.observation.source);
  g.fixed(delta.schemaBefore,'AllowedDeltaManifest.schemaBefore');g.fixed(delta.schemaAfter,'AllowedDeltaManifest.schemaAfter');
  for(const old of before.observation.tables){if(['storage_maintenance','storage_source_clients','schema_migrations','audit_log'].includes(old.name))continue;
    sameRows(g,old.rows,project(g,g.tableOf(after,old.name),old.columns));}
  const oldAudit=g.tableOf(before,'audit_log'),newAudit=g.tableOf(after,'audit_log');
  sameRows(g,[...oldAudit.rows,...target.rows.auditAdditions.rows],newAudit.rows);
  const entry=g.payload(delta.migrationRule.entry,'m2-migration22-entry');g.fixed(entry.registeredMigration,'Migration22Entry.registeredMigration');
  f.require(entry.backend===backend&&entry.version===22&&entry.name===CONTROLLED_M22.name&&entry.checksum===CONTROLLED_M22.dialects[backend].checksum
    &&entry.appliedAt===seed.createdAt&&entry.rowid===(backend==='sqlite'?'22':null));
  f.charge(6,0,3,8);const migration={rowid:entry.rowid,cells:[g.rawInteger(22,backend,'23'),g.rawText(entry.name,backend),g.rawText(entry.checksum,backend),migrationTimestamp(g,entry.appliedAt,backend)]};
  sameRows(g,[...g.tableOf(before,'schema_migrations').rows,migration],g.tableOf(after,'schema_migrations').rows);
  if(backend==='sqlite')f.require(delta.migrationRule.sequenceBefore===null&&delta.migrationRule.sequenceAfter===null);
  else{
    f.require(before.observation.sequences.length===1&&after.observation.sequences.length===1&&delta.migrationRule.sequenceBefore&&delta.migrationRule.sequenceAfter);
    g.same(delta.migrationRule.sequenceBefore,before.observation.sequences[0]!.relationIdentity);g.same(delta.migrationRule.sequenceAfter,after.observation.sequences[0]!.relationIdentity);
    g.same(f.json(g.selected(delta.migrationRule.sequenceBefore,'pc-pg-sequence-relation')),f.json(g.selected(delta.migrationRule.sequenceAfter,'pc-pg-sequence-relation')));
  }
  g.same(before.observation.sequences,after.observation.sequences);
  const authority=g.tableOf(after,'config_authority'),receipts=g.tableOf(after,'config_activation_receipts');f.require(authority.rows.length===1&&receipts.rows.length===1);
  const actualReceipt=g.row('config_activation_receipts',receipts.rows[0]!,backend),actualAuthority=g.row('config_authority',authority.rows[0]!,backend);
  f.require(actualReceipt.table==='config_activation_receipts'&&actualAuthority.table==='config_authority');g.same(actualReceipt.value,receipt);
  g.same(actualAuthority.value,{singleton:1,formatVersion:1,owner:'profile',activationId:seed.activationId,
    sourceBinding:{contract:'m2-source-binding/r1',kind:'local',physicalSourceRef:receipt.physicalSourceRef,activation:receipt.ref}});
}
export function checkM2AuditAdditions(g:M2Graph,seed:TakeoverSeed,before:M2HistoryData,projection:FixedRowProjection):void {
  const f:FState=g.f,agents=g.tableOf(before,'agents'),backend=before.observation.backend;f.require(projection.rows.length===seed.agents.length);
  const source=new Map<string,ReadonlyDeep<RawRow>>();f.charge(agents.rows.length,0,agents.rows.length+1);
  for(const row of agents.rows){const id=g.scalar('agents',row,'id','p0');f.require(typeof id==='string');source.set(id,row);}
  const additions=new Map<string,ReadonlyDeep<RawRow>>();f.charge(projection.rows.length,0,projection.rows.length+1);
  for(const row of projection.rows){const id=g.text(row.cells[0]!);f.require(id!==null&&!additions.has(id));additions.set(id,row);}
  const detail=f.canonical({contract:'m2-takeover-audit/r1',planId:seed.planId,captureId:seed.captureId,sourceIdentityDigest:seed.source.identityDigest});
  for(const item of seed.agents){const agent=source.get(item.agentId),actual=additions.get(item.auditId);f.require(agent&&actual);const name=g.scalar('agents',agent,'display_name','p0');f.require(typeof name==='string');
    f.charge(18,0,18,18);const values=[item.auditId,'user',null,'human',null,seed.actor.name,'configuration.takeover','agent',item.agentId,name,
      f.canonical(['configuration_authority']),f.canonical({owner:'legacy'}),f.canonical({owner:'profile',activationId:seed.activationId,profileRevision:1}),detail,null,null,seed.createdAt];
    g.same(actual.cells,values.map(value=>value===null?['null']:g.rawText(value,backend)));
  }
}

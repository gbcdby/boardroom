import { M2_HISTORY_TABLES } from '../m2-history-contracts.ts';
import type { RawRow, RawTable } from '../m2-history-contracts.ts';
import type { M2RowTypes, M2DecodedRow, ReadonlyDeep, LegacyCaptureBody, ConfigSnapshot, CaptureRef, WorkspaceMapping,
  CurrentAdvancedSelection, BindingVersion, ProfileVersion } from '../m2-value-contracts.ts';
import { M2Graph } from './m2-durable-graph.ts';
import type { M2HistoryData } from './m2-durable-graph.ts';
import type { FState } from './m2-p0-artifacts-common.ts';
import { createP0TupleIndex } from './m2-p0-keys.ts';
import type { P0KeyPart, P0TupleIndex } from './m2-p0-types.ts';
import type { SourceRowLocator, SourceCellLocator, TakeoverSeed, SourceToTargetManifest, BindingMapping, SourceSlot, SlotSeed, ProfileMapping } from './m2-durable-types.ts';
import catalog from './m2-durable-catalog.json' with {type:'json'};
import { snapshotRuntimeConfig } from '../../runtime/config.ts';
import type { RuntimeBackend, RuntimeConfig } from '../../runtime/types.ts';

type Row=ReadonlyDeep<RawRow>;
const contracts=new Map(M2_HISTORY_TABLES.map(table=>[table.name,table]));
const capturedNames=Object.freeze(['agents','agent_runtimes','agent_runtime_bindings','agent_runner_states','agent_runtime_members','members','projects','groups','group_participants','agent_legacy_aliases']);
const captureOrder:Readonly<Record<string,readonly string[]>>=Object.freeze({agents:['id'],agent_runtimes:['id'],agent_runtime_bindings:['id'],agent_runner_states:['binding_id'],
  agent_runtime_members:['member_id'],members:['id'],projects:['id'],groups:['id'],group_participants:['group_id','member_id'],agent_legacy_aliases:['display_name','host_type','agent_id','created_at','retired_at']});
export class M2Business {
  readonly g:M2Graph;readonly history:M2HistoryData;
  private readonly indexes=new Map<string,P0TupleIndex<Row>>();
  constructor(g:M2Graph,history:M2HistoryData){this.g=g;this.history=history;g.f.charge(1,0,2);}
  rows(table:string):readonly Row[]{return this.g.tableOf(this.history,table).rows;}
  scalar(table:string,row:Row,column:string):string|bigint|null{return this.g.scalar(table,row,column,this.history.observation.phase as 'p0'|'p1');}
  text(table:string,row:Row,column:string):string{const f:FState=this.g.f,value=this.scalar(table,row,column);f.require(typeof value==='string');return value;}
  number(table:string,row:Row,column:string):number {const f:FState=this.g.f,value=this.scalar(table,row,column);f.require(typeof value==='bigint');return this.g.count(value);}
  json(table:string,row:Row,column:string):unknown {const value=this.scalar(table,row,column);return value===null?null:this.g.jsonText(this.text(table,row,column));}
  index(table:string,columns:readonly string[]):P0TupleIndex<Row>{
    const f:FState=this.g.f;f.charge(columns.length,0,1);const key=table+':'+columns.join(',');let index=this.indexes.get(key);if(index)return index;
    index=createP0TupleIndex<Row>(this.g.request);for(const row of this.rows(table)){
      f.charge(columns.length,0,1);const tuple=columns.map(column=>this.scalar(table,row,column));if(tuple.some(v=>v===null))continue;
      f.require(!index.insert(tuple,row),'semantic_invariant_failed','duplicate-key');
    }f.charge(1,0,1);this.indexes.set(key,index);return index;
  }
  find(table:string,columns:readonly string[],key:readonly P0KeyPart[]):Row|undefined {return this.index(table,columns).get(key);}
  one(table:string,columns:readonly string[],key:readonly P0KeyPart[]):Row {const f:FState=this.g.f,row=this.find(table,columns,key);f.require(row,'artifact_semantic_mismatch','missing-target');return row;}
  value<K extends keyof M2RowTypes>(table:K,row:Row):M2RowTypes[K]{
    const actual=table==='execution-binding-references'?'agent_runtime_bindings':table==='runner-applied-references'?'agent_runner_states':table;
    const f:FState=this.g.f,decoded=this.g.row(actual,row,this.history.observation.backend);f.require(decoded.table===table);return decoded.value as M2RowTypes[K];
  }
  values<K extends keyof M2RowTypes>(table:K):readonly M2RowTypes[K][]{
    const actual=table==='execution-binding-references'?'agent_runtime_bindings':table==='runner-applied-references'?'agent_runner_states':table;
    this.g.f.charge(this.rows(actual).length,0,this.rows(actual).length+1);return this.rows(actual).map(row=>this.value(table,row));
  }
  profile(ref:{agentId:string;profileRevision:number;contentDigest:string}):ProfileVersion{
    const value=this.value('agent_profile_versions',this.one('agent_profile_versions',['agent_id','revision'],[ref.agentId,ref.profileRevision]));this.g.same(value.version.ref,ref);return value.version;
  }
  binding(ref:{groupBindingId:string;bindingConfigRevision:number;contentDigest:string}):BindingVersion{
    const row=this.value('group_binding_config_versions',this.one('group_binding_config_versions',['binding_id','revision'],[ref.groupBindingId,ref.bindingConfigRevision]));this.g.same(row.ref,ref);
    const head=this.value('group_bindings',this.one('group_bindings',['id'],[ref.groupBindingId]));this.g.f.charge(1,0,1,8);
    return {ref:row.ref,content:row.content,agentId:head.agentId,projectId:head.projectId,groupId:head.groupId,memberId:head.memberId};
  }
  snapshot(ref:{snapshotId:string;contentDigest:string}):ConfigSnapshot {const value=this.value('config_snapshots',this.one('config_snapshots',['id'],[ref.snapshotId]));this.g.same(value.ref,ref);return value;}
  mapping(ref:{mappingId:string;contentDigest:string}):WorkspaceMapping {const value=this.value('config_workspace_mappings',this.one('config_workspace_mappings',['id'],[ref.mappingId]));this.g.same(value.ref,ref);return value;}
  locator(value:SourceRowLocator,expected:string):Row {
    const f:FState=this.g.f;f.require(value.table===expected);const table=contracts.get(expected)!;f.require(value.key.length===table.primaryKey.length);
    const key:P0KeyPart[]=[];f.charge(value.key.length,0,value.key.length+1);
    for(let i=0;i<value.key.length;i++){const part=value.key[i]!;f.require(part.column===table.primaryKey[i]);const col=table.columnsP0.find(c=>c.name===part.column)!;
      key.push(col.postgresTypeOid==='25'?this.g.text(part.cell):this.g.integer(part.cell));}
    const row=this.one(expected,table.primaryKey,key),raw=this.g.tableOf(this.history,expected);
    for(const part of value.key)this.g.same(part.cell,row.cells[raw.columns.indexOf(part.column)]);return row;
  }
  /** All 51 original tuple FKs, declared new uniques and full P-A projections. */
  keys():void {
    const f:FState=this.g.f;
    for(const info of catalog.keys){
      if(info.table==='storage_maintenance'||info.table==='storage_source_clients')continue;
      const table=this.g.tableOf(this.history,info.table);this.index(info.table,info.primaryKey);
      for(const key of info.uniqueKeys)if(!key.partial)this.index(info.table,key.columns);
      const ids=new Set<string>();f.charge(table.rows.length,0,table.rows.length+1);
      for(const row of table.rows){if(row.rowid!==null){f.require(!ids.has(row.rowid),'semantic_invariant_failed','duplicate-key');ids.add(row.rowid);}
        const decoded=info.table==='agent_runtime_members'?null:this.g.row(info.table,row,this.history.observation.backend);
        for(const foreign of decoded?.foreignKeys??[]){
          f.charge(foreign.key.length,0,foreign.key.length+1);const key=foreign.key.map(cell=>cell.kind==='null'?null:cell.kind==='text'?cell.value:BigInt(cell.decimal));
          if(key.some(value=>value===null))continue;this.one(foreign.targetTable,foreign.targetColumns,key);
        }
        // Compare the frozen catalog's full tuples too; an omitted P-A edge cannot
        // silently remove a declared FK from the final graph.
        for(const foreign of info.foreignKeys){f.charge(foreign.columns.length,0,1);const key=foreign.columns.map(column=>this.scalar(info.table,row,column));
          if(!key.some(value=>value===null))this.one(foreign.targetTable,foreign.targetColumns,key);}
      }
    }
    for(const columns of [['runtime_id','project_id','group_id'],['member_id','group_id'],['group_binding_id']]){
      const index=createP0TupleIndex<Row>(this.g.request);for(const row of this.rows('agent_runtime_bindings')){
        if(this.text('agent_runtime_bindings',row,'attachment_state')!=='attached')continue;f.charge(columns.length,0,1);
        f.require(!index.insert(columns.map(c=>this.scalar('agent_runtime_bindings',row,c)),row),'semantic_invariant_failed','duplicate-key');}}
  }
}

function legacyCanonical(g:M2Graph,value:unknown):string {
  const f:FState=g.f;f.charge(1);
  if(Array.isArray(value)){f.charge(value.length,0,value.length+1);const parts=value.map(item=>legacyCanonical(g,item));const length=parts.reduce((n,s)=>n+s.length,0)+value.length+2;f.charge(1,length*3);return '['+parts.join(',')+']';}
  if(value!==null&&typeof value==='object'){
    const object=value as Record<string,unknown>,keys=g.sort(Object.keys(object),(a,b)=>{f.charge(1,(a.length+b.length)*3);return a.localeCompare(b);});
    f.charge(keys.length,0,keys.length+1);const parts=keys.map(key=>{f.charge(1,key.length*8);return JSON.stringify(key)+':'+legacyCanonical(g,object[key]);});
    const length=parts.reduce((n,s)=>n+s.length,0)+keys.length+2;f.charge(1,length*3);return '{'+parts.join(',')+'}';
  }
  f.charge(1,typeof value==='string'?value.length*8+4:64);return JSON.stringify(value);
}
export function checkM2Capture(g:M2Graph,reference:CaptureRef,before:M2HistoryData):LegacyCaptureBody {
  const f:FState=g.f,capture=g.capture(reference),old=new M2Business(g,before);g.same(capture.source,before.observation.source);
  g.same(capture.physicalSourceRef,before.observation.physicalSourceRef);g.same(capture.snapshotReceiptRef,before.observation.snapshotReceiptRef);g.same(capture.textEncoding,before.observation.textEncoding);
  f.require(capture.persistedAliases&&capture.tables.length===10);const values:Record<string,unknown>={};f.charge(10,0,11,11);
  for(let i=0;i<10;i++){
    const selected=capture.tables[i]!,name=capturedNames[i]!,table=g.tableOf(before,name);f.require(selected.name===name&&selected.count===table.count);g.same(selected.columns,table.columns);g.same(selected.columnContract,table.columnContract);
    const ordered=g.sort(table.rows,(a,b)=>{for(const col of captureOrder[name]!){const x=old.scalar(name,a,col),y=old.scalar(name,b,col);f.charge(1);
      if(x===y)continue;if(x===null)return before.observation.backend==='sqlite'?-1:1;if(y===null)return before.observation.backend==='sqlite'?1:-1;
      if(typeof x==='bigint'&&typeof y==='bigint')return x<y?-1:1;f.require(typeof x==='string'&&typeof y==='string');return g.compareText(x,y);}return 0;});
    f.require(ordered.length===selected.rows.length);const rows:Record<string,unknown>[]=[];f.charge(ordered.length,0,ordered.length+1,ordered.length+1);
    for(let j=0;j<ordered.length;j++){
      const actual=ordered[j]!,chosen=selected.rows[j]!;f.require(actual.rowid===chosen.rowid&&chosen.cells.length===table.columns.length);const row:Record<string,unknown>={};f.charge(table.columns.length,0,table.columns.length,table.columns.length);
      for(let c=0;c<table.columns.length;c++){
        const raw=actual.cells[c]!,cell=chosen.cells[c]!;
        if(raw[0]==='pg-binary')g.same(cell,raw[1]==='25'?['text',raw[2]]:['integer',String(g.integer(raw))]);else g.same(cell,raw);
        const scalar=old.scalar(name,actual,table.columns[c]!);if(typeof scalar==='bigint'){f.require(scalar>=BigInt(Number.MIN_SAFE_INTEGER)&&scalar<=BigInt(Number.MAX_SAFE_INTEGER),'semantic_unsupported');row[table.columns[c]!]=Number(scalar);}
        else row[table.columns[c]!]=scalar;
      }rows.push(row);
    }values[name]=rows;
  }
  f.require(g.hashText(legacyCanonical(g,values))===reference.sourceDigest);return capture;
}

const ordinaryFields=Object.freeze(['model','workdir','tools','systemPrompt','permissionMode']);
function runtimeConfig(g:M2Graph,value:unknown,partial=false):Record<string,unknown>{
  const f:FState=g.f,v=f.object(value);let count=0;for(const key in v){f.charge(1);f.require(ordinaryFields.includes(key));count++;}
  if(!partial)f.require(count===5&&ordinaryFields.every(key=>Object.hasOwn(v,key)));
  for(const key of ordinaryFields){if(!Object.hasOwn(v,key))continue;const x=v[key];f.charge(1);
    if(key==='model')f.require(x===null||typeof x==='string');
    else if(key==='tools')f.require(x===null||Array.isArray(x)&&x.every(item=>typeof item==='string'));
    else if(key==='permissionMode')f.require(x==='auto'||x==='manual'||x==='workspace-write');
    else f.require(typeof x==='string'&&(key!=='workdir'||x.length>0));
  }return v;
}
function originalSnapshot(g:M2Graph,backend:string,config:unknown,versions:{runtimeRevision:number;bindingRevision:number},advanced:'bypassPermissions'|null){
  const f:FState=g.f;f.require(['claude-code','codex-cli','dsh'].includes(backend),'semantic_unsupported');runtimeConfig(g,config);
  const size=f.size(config);f.charge(size.nodes*4+20,(size.encoded+size.text)*4+1024,size.nodes+5,size.nodes+5);
  return snapshotRuntimeConfig(backend as RuntimeBackend,config as RuntimeConfig,versions,advanced);
}
function sourceAdvanced(g:M2Graph,value:unknown):{strategy:'bypassPermissions';runtimeRevision:number;bindingRevision:number}|null{
  if(value===null)return null;const f:FState=g.f,v=f.object(value,['strategy','runtimeRevision','bindingRevision']);f.require(v.strategy==='bypassPermissions');
  for(const key of ['runtimeRevision','bindingRevision'])f.require(typeof v[key]==='number'&&Number.isSafeInteger(v[key])&&v[key]>0);
  return v as {strategy:'bypassPermissions';runtimeRevision:number;bindingRevision:number};
}
function slotInputs(g:M2Graph,old:M2Business,inputs:readonly SourceCellLocator[],expected:readonly (readonly [string,Row,string])[],capture:CaptureRef):void{
  const f:FState=g.f;f.require(inputs.length===expected.length);const seen=new Set<string>();f.charge(inputs.length,0,inputs.length+1);
  for(const input of inputs){const row=old.locator(input.row,input.row.table),table=g.tableOf(old.history,input.row.table),key=input.row.table+':'+input.column;
    f.require(!seen.has(key));seen.add(key);f.require(expected.some(([name,source,column])=>name===input.row.table&&source===row&&column===input.column));
    const ordinal=table.columns.indexOf(input.column);f.require(ordinal>=0);
    f.require(input.cellDigest===f.digestCr3(['m2-source-cell/r1',capture.artifactDigest,input.row.table,input.row.key,input.column,row.cells[ordinal]]));
  }
}
function checkWorkspace(g:M2Graph,current:M2Business,old:M2Business,slot:Extract<SourceSlot,{state:'present'}>,seed:SlotSeed,snapshot:ConfigSnapshot):void{
  const f:FState=g.f;if(slot.workspace.state==='blocked'){
    f.require(seed.mappingId===null);const reasons=['workspace_mapping_required','workspace_reference_missing','physical_root_unavailable','physical_root_mismatch','migration_reconfirmation_required'];
    let at=-1;for(const reason of slot.workspace.reasons){const next=reasons.indexOf(reason);f.require(next>at);at=next;}
    if(slot.workspace.reasons.includes('workspace_reference_missing')){
      const project=old.one('projects',['id'],[snapshot.projectId]),revision=old.number('projects',project,'workspace_revision');
      f.require(revision===0||old.find('project_workspace_versions',['project_id','workspace_revision'],[snapshot.projectId,revision])===undefined);
    }return;
  }
  f.require(seed.mappingId===slot.workspace.mappingRef.mappingId);const mapping=current.mapping(slot.workspace.mappingRef);
  g.same(mapping.configSnapshotRef,snapshot.ref);f.require(mapping.originalWorkdir===snapshot.config.workdir&&mapping.workspaceRef.projectId===snapshot.projectId);
  const observation=g.payload(slot.workspace.workspaceObservation,'m2-workspace-observation');f.require(snapshot.origin.kind==='legacy');
  g.same(observation.source,old.history.observation.source);g.same(observation.capture,snapshot.origin.raw.captureRef);g.same(observation.legacyRef,snapshot.origin.legacyRef);
  for(const key of ['workspaceRef','originalWorkdir','canonicalRoot','rootIdentity','physicalResourceKey','observedAt'] as const)g.same(observation[key],mapping[key]);
  const workspace=old.one('project_workspace_versions',['project_id','workspace_revision'],[mapping.workspaceRef.projectId,mapping.workspaceRef.workspaceRevision]);
  f.require(old.text('project_workspace_versions',workspace,'canonical_root')===mapping.canonicalRoot&&old.text('project_workspace_versions',workspace,'physical_resource_key')===mapping.physicalResourceKey);
  g.same(old.json('project_workspace_versions',workspace,'root_identity_json'),mapping.rootIdentity);
}
/** Complete R09–R15 transformation from the selected capture, never current heads. */
export function checkM2InitialBusiness(g:M2Graph,seed:TakeoverSeed,map:SourceToTargetManifest,capture:CaptureRef,
  before:M2HistoryData,after:M2HistoryData):void {
  const f:FState=g.f,old=new M2Business(g,before),current=new M2Business(g,after),source=before.observation.source;
  g.same(seed.source,source);g.same(map.source,source);g.same(map.capture,capture);f.require(map.planId===seed.planId&&capture.captureId===seed.captureId);
  const agents=old.rows('agents');f.require(seed.agents.length===agents.length&&map.profiles.length===agents.length);
  const newIds=new Set<string>(),oldIds=new Set<string>();f.charge(2,0,2);
  for(const table of before.observation.tables)for(const column of contracts.get(table.name)!.primaryKey){if(column!=='id'&&!column.endsWith('_id'))continue;
    for(const row of table.rows){const value=old.scalar(table.name,row,column);if(typeof value==='string'){f.charge(1,value.length*2,1);oldIds.add(value);}}}
  const fresh=(id:string):void=>{f.charge(1,id.length*4,1);f.require(!newIds.has(id)&&!oldIds.has(id));newIds.add(id);};fresh(seed.activationId);fresh(seed.captureId);
  const agentSeeds=new Map(seed.agents.map(item=>[item.agentId,item]));f.charge(seed.agents.length,0,seed.agents.length+1);f.require(agentSeeds.size===agents.length);
  for(let i=0;i<seed.agents.length;i++){const item=seed.agents[i]!;if(i)f.require(g.compareText(seed.agents[i-1]!.agentId,item.agentId)<0);f.require(item.profileRevision===1);fresh(item.auditId);old.one('agents',['id'],[item.agentId]);}
  const profiles=new Map<string,ProfileMapping>();f.charge(map.profiles.length,0,map.profiles.length+1);
  for(const item of map.profiles){const agent=old.locator(item.agent,'agents'),id=old.text('agents',agent,'id');f.require(agentSeeds.has(id)&&!profiles.has(id));profiles.set(id,item);
    const runtime=old.find('agent_runtimes',['agent_id'],[id]),alias=old.locator(item.alias,'agent_legacy_aliases');
    f.require(old.text('agent_legacy_aliases',alias,'agent_id')===id&&old.scalar('agent_legacy_aliases',alias,'retired_at')===null
      &&old.text('agent_legacy_aliases',alias,'display_name')===old.text('agents',agent,'display_name')&&old.text('agent_legacy_aliases',alias,'host_type')===old.text('agents',agent,'host_type'));
    const head=current.value('agent_profiles',current.one('agent_profiles',['agent_id'],[id]));
    const version=current.value('agent_profile_versions',current.one('agent_profile_versions',['agent_id','revision'],[id,1]));g.same(version.version.ref,item.profile);
    let expected:unknown;if(runtime){f.require(item.runtime!==null&&old.locator(item.runtime,'agent_runtimes')===runtime);
      const defaults=runtimeConfig(g,old.json('agent_runtimes',runtime,'defaults_json')),revision=old.number('agent_runtimes',runtime,'revision');
      f.require(old.number('agent_runtimes',runtime,'config_version')===1&&revision>0);
      expected={preferredHost:old.text('agents',agent,'host_type'),model:defaults.model,instructions:defaults.systemPrompt,defaultRoleRef:null,skillSelection:[],toolSelection:[],memorySelection:[],maxConcurrentInstances:1,legacyCompatibility:{tools:defaults.tools,permissionMode:defaults.permissionMode}};
      f.require(item.compatRuntimeRevision===revision&&version.compatRuntimeRevision===revision);g.same(head,{agentId:id,currentRevision:1,legacyRuntimeId:old.text('agent_runtimes',runtime,'id'),compatRuntimeRevision:revision});
    }else{f.require(item.runtime===null&&item.compatRuntimeRevision===null&&version.compatRuntimeRevision===null);
      expected={preferredHost:null,model:null,instructions:'',defaultRoleRef:null,skillSelection:[],toolSelection:[],memorySelection:[],maxConcurrentInstances:1,legacyCompatibility:null};
      g.same(head,{agentId:id,currentRevision:1,legacyRuntimeId:null,compatRuntimeRevision:null});}
    g.same(version.version.content,g.value('profile-content',expected));f.require(item.profile.agentId===id&&item.profile.profileRevision===1);
  }
  f.require(current.rows('agent_profiles').length===agents.length&&current.rows('agent_profile_versions').length===agents.length);
  const eligible:Row[]=[];f.charge(old.rows('group_participants').length,0,old.rows('group_participants').length+1);
  for(const participant of old.rows('group_participants')){const member=old.one('members',['id'],[old.text('group_participants',participant,'member_id')]);if(old.text('members',member,'kind')==='agent')eligible.push(participant);}
  f.require(seed.bindings.length===eligible.length&&map.bindings.length===eligible.length&&current.rows('group_bindings').length===eligible.length&&current.rows('group_binding_config_versions').length===eligible.length);
  const bindingSeeds=new Map<string,typeof seed.bindings[number]>(),bindingMappings=new Map<string,BindingMapping>();f.charge(seed.bindings.length*2,0,seed.bindings.length*2+2);
  for(let i=0;i<seed.bindings.length;i++){
    const item=seed.bindings[i]!,key=f.canonical([item.memberId,item.groupId]);f.require(!bindingSeeds.has(key));bindingSeeds.set(key,item);
    if(i){const previous=seed.bindings[i-1]!,order=g.compareText(previous.memberId,item.memberId);f.require(order<0||order===0&&g.compareText(previous.groupId,item.groupId)<0);}
    f.require(item.bindingRevision===1);if(item.legacyExecutionId===null)fresh(item.groupBindingId);else f.require(item.legacyExecutionId===item.groupBindingId);
    for(const slot of [item.requested,item.applied,item.effective])if(slot){fresh(slot.snapshotId);if(slot.mappingId!==null)fresh(slot.mappingId);}
  }
  for(const item of map.bindings){const member=old.locator(item.member,'members'),group=old.locator(item.group,'groups'),participant=old.locator(item.groupParticipant,'group_participants');
    const memberId=old.text('members',member,'id'),groupId=old.text('groups',group,'id'),key=f.canonical([memberId,groupId]);f.require(!bindingMappings.has(key)&&bindingSeeds.has(key));bindingMappings.set(key,item);
    f.require(old.text('group_participants',participant,'member_id')===memberId&&old.text('group_participants',participant,'group_id')===groupId);
  }
  let snapshotCount=0,mappingCount=0,executions=0;
  for(const participant of eligible){
    const memberId=old.text('group_participants',participant,'member_id'),groupId=old.text('group_participants',participant,'group_id'),key=f.canonical([memberId,groupId]);
    const spec=bindingSeeds.get(key),mapping=bindingMappings.get(key);f.require(spec&&mapping);
    const member=old.one('members',['id'],[memberId]),group=old.one('groups',['id'],[groupId]),projectId=old.text('members',member,'project_id'),agentId=old.text('members',member,'agent_id');
    f.require(old.text('groups',group,'project_id')===projectId&&mapping.agentId===agentId&&old.locator(mapping.project,'projects')===old.one('projects',['id'],[projectId]));
    const runtime=old.find('agent_runtimes',['agent_id'],[agentId]),execution=old.find('agent_runtime_bindings',['member_id','group_id'],[memberId,groupId]);
    const head=current.value('group_bindings',current.one('group_bindings',['id'],[spec.groupBindingId]));
    const version=current.value('group_binding_config_versions',current.one('group_binding_config_versions',['binding_id','revision'],[spec.groupBindingId,1]));g.same(version.ref,mapping.binding);
    f.require(version.ref.bindingConfigRevision===1&&version.ref.groupBindingId===spec.groupBindingId);
    if(!runtime){f.require(!execution&&mapping.execution===null&&mapping.runner===null&&spec.legacyExecutionId===null&&spec.requested===null&&spec.applied===null&&spec.effective===null
        &&mapping.requested.state==='not-applicable'&&mapping.applied.state==='not-applicable'&&mapping.effective.state==='not-applicable'&&mapping.selectedKind===null&&mapping.advancedRule==='none'&&mapping.advancedEvidence===null);
      g.same(head,{id:spec.groupBindingId,projectId,groupId,memberId,agentId,currentRevision:1,originalLegacyBindingId:null,currentAttachmentId:null,currentCompatBindingRevision:null,retiredAt:null});
      g.same(version.content,{roleRef:null,profileOverrides:{},currentAdvanced:{state:'none'}});f.require(version.compatibility===null);continue;
    }
    executions++;f.require(execution&&mapping.execution!==null&&old.locator(mapping.execution,'agent_runtime_bindings')===execution);
    const executionId=old.text('agent_runtime_bindings',execution,'id'),runtimeId=old.text('agent_runtimes',runtime,'id');f.require(spec.groupBindingId===executionId&&spec.legacyExecutionId===executionId);
    const runner=old.one('agent_runner_states',['binding_id'],[executionId]);f.require(mapping.runner!==null&&old.locator(mapping.runner,'agent_runner_states')===runner);
    const revision=old.number('agent_runtime_bindings',execution,'revision'),runtimeRevision=old.number('agent_runtimes',runtime,'revision');f.require(revision>0&&runtimeRevision>0);
    g.same(head,{id:executionId,projectId,groupId,memberId,agentId,currentRevision:1,originalLegacyBindingId:executionId,currentAttachmentId:executionId,currentCompatBindingRevision:revision,retiredAt:null});
    g.same(version.compatibility,{executionBindingId:executionId,bindingRevision:revision});
    const defaults=runtimeConfig(g,old.json('agent_runtimes',runtime,'defaults_json')),overrides=runtimeConfig(g,old.json('agent_runtime_bindings',execution,'overrides_json'),true),expectedOverrides:Record<string,unknown>={};
    for(const [oldKey,newKey] of [['model','model'],['systemPrompt','instructions'],['tools','legacyTools'],['permissionMode','legacyPermissionMode']])if(Object.hasOwn(overrides,oldKey!))expectedOverrides[newKey!]=overrides[oldKey!];
    f.require(version.content.roleRef===null);g.same(version.content.profileOverrides,expectedOverrides);
    const agent=old.one('agents',['id'],[agentId]),backend=old.text('agents',agent,'host_type'),advanced=sourceAdvanced(g,old.json('agent_runtime_bindings',execution,'advanced_json'));
    const advancedRaw=old.scalar('agent_runtime_bindings',execution,'advanced_json');f.require(advancedRaw===null||typeof advancedRaw==='string');
    const validity=advanced===null?'not_selected':advanced.runtimeRevision===runtimeRevision&&advanced.bindingRevision===revision?'effective':'invalidated_by_revision';
    const effective=originalSnapshot(g,backend,{...defaults,...overrides},{runtimeRevision,bindingRevision:revision},validity==='effective'?'bypassPermissions':null);
    const slots=[['requested','requestedSnapshot',execution,'agent_runtime_bindings','requested_snapshot_json'],['applied','applied',runner,'agent_runner_states','applied_json'],['effective','effective',execution,'agent_runtime_bindings','overrides_json']] as const;
    for(const [name,kind,rawRow,rawTable,column] of slots){const slot=mapping[name],slotSeed=spec[name],rawJson=kind==='effective'?null:old.scalar(rawTable,rawRow,column);
      if(kind!=='effective'&&rawJson===null){f.require(slot.state==='absent'&&slotSeed===null);slotInputs(g,old,[slot.rawCell],[[rawTable,rawRow,column]],capture);continue;}
      f.require(slot.state==='present'&&slotSeed!==null);snapshotCount++;const snapshot=current.snapshot(slot.snapshotRef);f.require(snapshot.ref.snapshotId===slotSeed.snapshotId);
      const stored=kind==='effective'?effective:f.object(g.jsonText(rawJson as string),['backend','config','versions','advancedStrategy','digest']);
      const versions=f.object(stored.versions,['runtimeRevision','bindingRevision']);for(const v of [versions.runtimeRevision,versions.bindingRevision])f.require(typeof v==='number'&&Number.isSafeInteger(v)&&v>0);
      f.require(stored.backend===backend&&(stored.advancedStrategy===null||stored.advancedStrategy==='bypassPermissions'&&backend==='claude-code'));
      const actual=originalSnapshot(g,backend,stored.config,{runtimeRevision:versions.runtimeRevision as number,bindingRevision:versions.bindingRevision as number},stored.advancedStrategy as 'bypassPermissions'|null);f.require(actual.digest===stored.digest);
      g.same(slot.legacyRef,{authority:'legacy',kind,sourceId:executionId,runtimeId,bindingId:executionId,agentId,digest:actual.digest,versions:actual.versions,configVersion:1});
      f.require(snapshot.origin.kind==='legacy'&&snapshot.advancedBasis.kind==='legacy');g.same(snapshot.origin.legacyRef,slot.legacyRef);
      g.same(snapshot.origin.raw,{captureRef:capture,rawJson,rawDigest:rawJson===null?null:g.hashText(rawJson as string),rawAdvancedJson:advancedRaw,rawAdvancedDigest:advancedRaw===null?null:g.hashText(advancedRaw)});
      for(const [field,value] of Object.entries({agentId,groupBindingId:executionId,executionBindingId:executionId,memberId,projectId,groupId,backend,config:actual.config,advancedStrategy:actual.advancedStrategy,semanticDigest:actual.digest}))g.same(snapshot[field as keyof ConfigSnapshot],value);
      g.same(snapshot.legacyAlias,{displayName:old.text('agents',agent,'display_name'),hostType:backend});
      g.same(snapshot.advancedBasis.legacy.originalSelection,advanced);f.require(snapshot.advancedBasis.legacy.originalValidity===validity);
      const inputs:readonly (readonly [string,Row,string])[]=kind==='effective'?[['agent_runtimes',runtime,'defaults_json'],['agent_runtime_bindings',execution,'overrides_json'],['agent_runtime_bindings',execution,'advanced_json'],['agent_runtimes',runtime,'revision'],['agent_runtime_bindings',execution,'revision'],['agents',agent,'host_type'],['agent_runtimes',runtime,'config_version']]
        :[[rawTable,rawRow,column],['agent_runtime_bindings',execution,'advanced_json'],['agent_runtimes',runtime,'config_version'],['agents',agent,'host_type']];
      slotInputs(g,old,slot.rawInputs,inputs,capture);checkWorkspace(g,current,old,slot,slotSeed,snapshot);if(slot.workspace.state==='mapped')mappingCount++;
    }
    const chosen=mapping.requested.state==='present'?'requestedSnapshot':mapping.applied.state==='present'?'applied':'effective';f.require(mapping.selectedKind===chosen);
    const requested=mapping.requested,applied=mapping.applied;
    g.same(current.value('execution-binding-references',current.one('agent_runtime_bindings',['id'],[executionId])),{executionBindingId:executionId,groupBindingId:executionId,attachmentState:'attached',detachSnapshotId:null,detachedAt:null,
      requestedSnapshotId:requested.state==='present'?requested.snapshotRef.snapshotId:null,requestedMappingId:requested.state==='present'&&requested.workspace.state==='mapped'?requested.workspace.mappingRef.mappingId:null});
    g.same(current.value('runner-applied-references',current.one('agent_runner_states',['binding_id'],[executionId])),{bindingId:executionId,appliedSnapshotId:applied.state==='present'?applied.snapshotRef.snapshotId:null,appliedMappingId:applied.state==='present'&&applied.workspace.state==='mapped'?applied.workspace.mappingRef.mappingId:null});
    if(advanced===null){g.same(version.content.currentAdvanced,{state:'none'});f.require(mapping.advancedRule==='none'&&mapping.advancedEvidence===null);}
    else checkInitialAdvanced(g,old,current,mapping,version.content.currentAdvanced,advanced,validity as 'effective'|'invalidated_by_revision',profiles.get(agentId)!.profile,version.ref,capture,effective,member);
  }
  f.require(executions===old.rows('agent_runtime_bindings').length&&current.rows('config_snapshots').length===snapshotCount&&current.rows('config_workspace_mappings').length===mappingCount
    &&current.rows('config_detach_snapshots').length===0&&current.rows('config_mutation_receipts').length===0&&current.rows('legacy_config_captures').length===1);
  const saved=current.value('legacy_config_captures',current.rows('legacy_config_captures')[0]!);g.same(saved.ref,capture);g.same(saved.capture,g.capture(capture));
  g.same(map.auditIds,seed.agents.map(agent=>agent.auditId));
}
function checkInitialAdvanced(g:M2Graph,old:M2Business,current:M2Business,mapping:BindingMapping,advanced:CurrentAdvancedSelection,
  original:{strategy:'bypassPermissions';runtimeRevision:number;bindingRevision:number},validity:'effective'|'invalidated_by_revision',
  profileRef:ProfileVersion['ref'],bindingRef:BindingVersion['ref'],capture:CaptureRef,effective:ReturnType<typeof snapshotRuntimeConfig>,member:Row):void {
  const f:FState=g.f;
  if(advanced.state==='retained_inactive'){
    f.require(mapping.advancedRule==='retained-inactive'&&mapping.advancedEvidence===null);g.same(advanced.captureRef,capture);g.same(advanced.original,original);
    f.require(advanced.reason===(validity==='effective'?'migration_reconfirmation_required':'invalidated_by_revision'));
  }else{
    f.require(advanced.state==='selected'&&mapping.advancedRule==='legacy-equivalence'&&mapping.advancedEvidence!==null&&validity==='effective'&&advanced.origin.kind==='legacy_equivalence');
    const evidence=g.payload(mapping.advancedEvidence,'m2-advanced-equivalence'),selected=mapping.selectedKind==='requestedSnapshot'?mapping.requested:mapping.selectedKind==='applied'?mapping.applied:mapping.effective;
    f.require(selected.state==='present'&&selected.workspace.state==='mapped');const snapshot=current.snapshot(selected.snapshotRef),workspace=current.mapping(selected.workspace.mappingRef);
    f.require(snapshot.advancedBasis.kind==='legacy'&&snapshot.advancedBasis.legacy.mappedValidity==='equivalent'
      &&snapshot.advancedBasis.legacy.equivalenceEvidenceDigest===f.digestCr3(evidence));
    g.same(evidence.source,old.history.observation.source);g.same(evidence.capture,capture);g.same(evidence.legacyRef,selected.legacyRef);g.same(evidence.profileRef,profileRef);g.same(evidence.bindingRef,bindingRef);
    g.same(evidence.rootObservation,selected.workspace.workspaceObservation);g.same(evidence.compatibilityBasis,{runtimeRevision:original.runtimeRevision,bindingRevision:original.bindingRevision});
    g.same(advanced.origin.captureRef,capture);g.same(advanced.origin.legacyRef,selected.legacyRef);g.same(advanced.basis.profileRef,profileRef);
    f.require(advanced.basis.bindingConfigRevision===bindingRef.bindingConfigRevision&&advanced.basis.backend==='claude-code');
    const ordinary=f.digestCr3({backend:snapshot.backend,config:snapshot.config});f.require(evidence.ordinaryConfigDigest===ordinary&&advanced.basis.ordinaryConfigDigest===ordinary);
    f.require(evidence.legacyAdvancedRawDigest===g.hashText(old.text('agent_runtime_bindings',old.locator(mapping.execution!,'agent_runtime_bindings'),'advanced_json')));
    g.same(advanced.basis.existingScope,evidence.existingScope);f.require(evidence.existingScope.sourceIdentityDigest===old.history.observation.source.identityDigest
      &&evidence.existingPermissionScopeDigest===f.digestCr3(evidence.existingScope)&&advanced.basis.existingPermissionScopeDigest===evidence.existingPermissionScopeDigest);
    g.same(advanced.basis.root,{workspaceRef:workspace.workspaceRef,canonicalRoot:workspace.canonicalRoot,physicalResourceKey:workspace.physicalResourceKey,rootIdentity:workspace.rootIdentity});
    g.same(advanced.basis.compatibilityBasis,evidence.compatibilityBasis);const scope=evidence.existingScope;
    f.require(scope.agentId===snapshot.agentId&&scope.executionBindingId===snapshot.executionBindingId&&scope.projectId===snapshot.projectId&&scope.groupId===snapshot.groupId&&scope.memberId===snapshot.memberId
      &&scope.membershipRevision===old.number('members',member,'membership_revision')&&scope.permissionMode===snapshot.config.permissionMode);g.same(scope.tools,snapshot.config.tools);
    // Reconfirmation never invents equivalence with another captured ordinary source.
    g.same(snapshot.config,effective.config);
  }
  for(const slot of [mapping.requested,mapping.applied,mapping.effective])if(slot.state==='present'){
    const snapshot=current.snapshot(slot.snapshotRef);f.require(snapshot.advancedBasis.kind==='legacy');const basis=snapshot.advancedBasis.legacy;
    if(advanced.state==='selected'&&basis.mappedValidity==='equivalent'){
      f.require(mapping.advancedEvidence!==null);const payload=g.payload(mapping.advancedEvidence,'m2-advanced-equivalence');
      g.same(slot.legacyRef,payload.legacyRef);f.require(basis.equivalenceEvidenceDigest===f.digestCr3(payload));
    }else f.require(basis.mappedValidity===(validity==='effective'?'migration_reconfirmation_required':'invalidated_by_revision')&&basis.equivalenceEvidenceDigest===null);
  }
}

/** Legacy snapshots retain their own original source cut, independently of all
 * current Profile/Binding heads and the other two captured snapshot slots. */
export function checkM2CapturedLegacySnapshot(g:M2Graph,snapshot:ConfigSnapshot,before:M2HistoryData):void {
  const f:FState=g.f;f.require(snapshot.origin.kind==='legacy'&&snapshot.advancedBasis.kind==='legacy');
  const old=new M2Business(g,before),reference=snapshot.origin.legacyRef,raw=snapshot.origin.raw;
  const execution=old.one('agent_runtime_bindings',['id'],[reference.bindingId]),runtime=old.one('agent_runtimes',['id'],[reference.runtimeId]);
  const agent=old.one('agents',['id'],[reference.agentId]),memberId=old.text('agent_runtime_bindings',execution,'member_id');
  f.require(old.text('agent_runtime_bindings',execution,'runtime_id')===reference.runtimeId&&old.text('agent_runtimes',runtime,'agent_id')===reference.agentId
    &&snapshot.agentId===reference.agentId&&snapshot.memberId===memberId&&snapshot.projectId===old.text('agent_runtime_bindings',execution,'project_id')
    &&snapshot.groupId===old.text('agent_runtime_bindings',execution,'group_id')&&snapshot.groupBindingId===reference.bindingId
    &&old.number('agent_runtimes',runtime,'config_version')===1);
  const backend=old.text('agents',agent,'host_type'),runtimeRevision=old.number('agent_runtimes',runtime,'revision'),bindingRevision=old.number('agent_runtime_bindings',execution,'revision');
  const advanced=sourceAdvanced(g,old.json('agent_runtime_bindings',execution,'advanced_json'));
  const advancedRaw=old.scalar('agent_runtime_bindings',execution,'advanced_json');f.require(advancedRaw===null||typeof advancedRaw==='string');
  g.same(raw.rawAdvancedJson,advancedRaw);g.same(snapshot.advancedBasis.legacy.originalSelection,advanced);
  const validity=advanced===null?'not_selected':advanced.runtimeRevision===runtimeRevision&&advanced.bindingRevision===bindingRevision?'effective':'invalidated_by_revision';
  f.require(snapshot.advancedBasis.legacy.originalValidity===validity&&snapshot.backend===backend);
  let stored:unknown;
  if(reference.kind==='effective'){
    const defaults=runtimeConfig(g,old.json('agent_runtimes',runtime,'defaults_json')),overrides=runtimeConfig(g,old.json('agent_runtime_bindings',execution,'overrides_json'),true);
    stored=originalSnapshot(g,backend,{...defaults,...overrides},{runtimeRevision,bindingRevision},validity==='effective'?'bypassPermissions':null);f.require(raw.rawJson===null);
  }else{
    const table=reference.kind==='requestedSnapshot'?'agent_runtime_bindings':'agent_runner_states',row=reference.kind==='requestedSnapshot'?execution:old.one(table,['binding_id'],[reference.bindingId]);
    const text=old.text(table,row,reference.kind==='requestedSnapshot'?'requested_snapshot_json':'applied_json');f.require(raw.rawJson===text);stored=g.jsonText(text);
  }
  const value=f.object(stored,['backend','config','versions','advancedStrategy','digest']);
  f.require(value.backend===snapshot.backend&&value.digest===snapshot.semanticDigest);g.same(value.config,snapshot.config);g.same(value.versions,reference.versions);g.same(value.advancedStrategy,snapshot.advancedStrategy);
  g.same(snapshot.legacyAlias,{displayName:old.text('agents',agent,'display_name'),hostType:backend});
}

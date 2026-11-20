import assert from 'node:assert/strict';
import { m2OriginFixture } from './m2-origin-fixture.ts';
import { OriginStore, originCell, originRawValue, originRow, originEvidence, originSha } from './m2-origin-fixture-store.ts';
import type { OriginChange } from './m2-origin-fixture-store.ts';
import { originTypedTable, originControl } from './m2-origin-fixture-history.ts';
import { canonicalJson, digestJson } from '../../src/server/storage/maintenance/canonical.ts';
import { buildDatabaseManifests, digestRowMultiset } from '../../src/server/storage/maintenance/manifests.ts';
import { controlVector, historicalClient } from '../fixtures/maintenance-control-candidate.ts';
import { createM2HistoryRequest } from '../../src/server/identity/internal/m2-p0-request.ts';
import { withP0Guard, p0State, P0_LIMITS } from '../../src/server/identity/internal/m2-p0-budget.ts';
import { beginP0FArtifactPass, endP0FArtifactPass } from '../../src/server/identity/internal/m2-p0-artifacts-frame.ts';
import { M2Graph } from '../../src/server/identity/internal/m2-durable-graph.ts';
import { checkM2OwnerClients, readM2ClientFrames } from '../../src/server/identity/internal/m2-durable-clients.ts';
import type { M2OwnerClientsInput, M2ClientRegistration } from '../../src/server/identity/internal/m2-durable-clients.ts';
import type { ClientTextEncoding } from '../../src/server/identity/internal/m2-durable-types.ts';
import type { RawTable, RawRow, RawCell } from '../../src/server/identity/m2-history-contracts.ts';
import type { Json } from '../../src/server/storage/maintenance/types.ts';

/** CF-only value fixture. The complete nonempty business graph is reused, while
 * this unit explicitly supplies the already-replayed before roster. It does not
 * claim a complete origin with an owner successor, native facts or installed DDL. */
export async function m2ClientFactsFixture(options:{mutate?:OriginChange;priorP1Birth?:boolean;existingActorObservation?:boolean}={}) {
  const origin=await m2OriginFixture(), store=new OriginStore(options.mutate);
  for(const [i,item] of origin.selected.entries()){
    const original=origin.store.entries.get(item.artifact.ref)!;
    store.raw('original:'+i,item.kind,Buffer.from(item.bytesHex,'hex'),item.artifact,original.dependencies,original.value);
  }
  const current=structuredClone(origin.afterA),source=current.source;
  const before=current.tables.find(t=>t.name==='storage_source_clients')!;
  const actorBefore=origin.store.value('preA').controlProof.facts;
  const plan=origin.store.value('plan');
  const vector=controlVector({mechanism:{sourceIdentity:plan.sourceIdentity,databaseInstanceId:source.databaseInstanceId,
    root:origin.store.value('physical').controlRoot,mutex:{kind:'fixture-only-mutex'},schemaManifestDigest:'a'.repeat(64),guardManifestDigest:'b'.repeat(64)}});
  const historical=historicalClient(vector,'historical-旧');
  const legacyCells=before.columns.slice(0,16).map(name=>[...historical.row[name as keyof typeof historical.row]] as RawCell);
  before.rows.unshift({rowid:'91',cells:[...legacyCells,['null']]});before.count='2';
  const coordinator=before.rows.find(row=>originRawValue(row.cells[0]!)==='origin-coordinator')!;
  // This finite unit supplies an already-verified prior registration. It does
  // not reinterpret the origin's original v1 birth or prove a second full root.
  let priorP1Registration:Omit<M2ClientRegistration,'actorId'>|undefined;
  if(options.priorP1Birth){
    const previous=JSON.parse(String(originRawValue(coordinator.cells[7]!)));
    const birthFormat={protocolVersion:2,writerFormatDigest:origin.receipt.guardTransition.writerFormatDigest};
    priorP1Registration={creation:structuredClone(previous.creation),birthFormat};
    const body={formatVersion:2,kind:'profile-maintenance-controller-registration',source,
      sourceIdentityDigest:source.identityDigest,creation:structuredClone(previous.creation),
      writerFormat:structuredClone(birthFormat),sessionBinding:'per-source-lock-native-inventory-v1',drainReceipt:null};
    options.mutate?.('clientPriorP1Registration',body);
    coordinator.cells[7]=originCell(canonicalJson(body));
  }
  const coordinatorValues=originRow({...before,rows:[coordinator],count:'1'});
  const host=JSON.parse(String(coordinatorValues.host_identity_json)),process=JSON.parse(String(coordinatorValues.process_identity_json));
  const actorId=options.existingActorObservation?process.instanceId:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const actorProcess=options.existingActorObservation?{...process}:{...process,pid:125,startTicks:'901',instanceId:actorId};
  const actorCheck={...actorBefore.actor.processCheck,pid:actorProcess.pid,
    startTicksBefore:actorProcess.startTicks,startTicksAfter:actorProcess.startTicks};
  const encoding={backend:'sqlite' as const,name:'UTF-8' as const};
  const currentFormat={kind:'m2-profile' as const,activationReceipt:origin.refs.activationReceipt!,protocolVersion:2 as const,
    writerFormatDigest:origin.receipt.guardTransition.writerFormatDigest};
  const context={source,migrationId:'a12',plan:origin.refs.plan!,event:'s2_profile_owner_acquired',phase:'s2_profile_committed',
    epochBefore:2,epochAfter:2,fromGeneration:7,toGeneration:8,previousAnchor:origin.refs.J_A!,targetSequence:7,
    originCapture:origin.refs.capture!,receiptGeneration:7,currentFormat};
  const observedAt='2026-11-19T00:01:00.000Z';
  const rowDigest=(row:RawRow)=>digestJson(['profile-source-client-row/r2',source,encoding,before.columnContract,
    before.columnContractValueDigest,[row.rowid,row.cells]]);
  const ordered=(rows:RawRow[])=>[...rows].sort((a,b)=>Buffer.compare(Buffer.from(a.cells[0]![1]!),Buffer.from(b.cells[0]![1]!)));
  const rowsDigest=(rows:RawRow[])=>digestJson(['profile-source-clients-live-rows/r2',source,encoding,before.columnContract,
    before.columnContractValueDigest,String(rows.length),ordered(rows).map(row=>[row.rowid,row.cells])]);
  const coordinatorFact={kind:'maintenance-controller',subject:coordinator.cells[0],rowDigest:rowDigest(coordinator),host,process,
    processCheck:options.existingActorObservation?actorCheck:{kind:'linux-absent',observerUid:1000,kernelBootId:process.kernelBootId,pidNamespace:process.pidNamespace,
      pid:process.pid,stage:'proc-open',errno:'ENOENT'},classification:options.existingActorObservation?'active-actor':'exited-actor',registration:'current-chain'};
  const clientFacts=[{...historical.fact,rowDigest:rowDigest(before.rows[0]!)},coordinatorFact]
    .sort((a,b)=>Buffer.compare(Buffer.from(a.subject![1]!),Buffer.from(b.subject![1]!)));
  const sessions=structuredClone(actorBefore.sessions);
  sessions.observer={host,process:actorProcess};
  if(sessions.matches)for(const match of sessions.matches){match.pid=actorProcess.pid;match.startTicks=actorProcess.startTicks;}
  const observation={formatVersion:2,kind:'profile-source-control-event-facts',collector:'boardroom-profile-control-facts-v2',
    observedAt,actor:{actorId,clientId:options.existingActorObservation?coordinator.cells[0]:null,host,process:actorProcess,processCheck:actorCheck},beforeCount:'2',
    beforeRowsDigest:rowsDigest(before.rows),clients:clientFacts,runtime:structuredClone(actorBefore.runtime),sessions};
  const creation={migrationId:'a12',plan:origin.refs.plan!,fenceEpoch:'2',ownerGeneration:'8',previousAnchor:origin.refs.J_A!,targetSequence:'7'};
  const registration={formatVersion:2,kind:'profile-maintenance-controller-registration',source,sourceIdentityDigest:source.identityDigest,
    creation,writerFormat:{protocolVersion:2,writerFormatDigest:currentFormat.writerFormatDigest},
    sessionBinding:'per-source-lock-native-inventory-v1',drainReceipt:null};
  const newborn:RawRow={rowid:'92',cells:['新-owner',source.databaseInstanceId,'maintenance-controller','boardroom-maintenance-control-v1',2,
    canonicalJson(host),canonicalJson(actorProcess),canonicalJson(registration),2,2,null,'none',null,observedAt,observedAt,null,
    currentFormat.writerFormatDigest].map(originCell)};
  const ended=structuredClone(coordinator);ended.cells[14]=originCell(observedAt);
  if(!options.existingActorObservation)ended.cells[15]=originCell(observedAt);
  const after:RawTable={...structuredClone(before),count:options.existingActorObservation?'2':'3',
    rows:ordered([before.rows[0]!,ended,...options.existingActorObservation?[]:[newborn]])};
  const beforeSelection=originTypedTable(store,'clientBefore',current,before),afterSelection=originTypedTable(store,'clientAfter',current,after);
  const control=originControl(store,'cfBeforeControl',current,origin.refs.J_A!);
  // Full fixed raw columns and native row-multiset formulas; catalog bytes are
  // deliberately synthetic value metadata, not an installed native S1 claim.
  const tables=current.tables.map(table=>{
    const contract=JSON.parse(Buffer.from(store.entries.get(table.columnContract.ref)!.selected.bytesHex,'hex').toString('utf8'));
    const columns=contract.columns.map((column:any,i:number)=>({cid:String(i),name:column.name,type:column.declaredType,
      notnull:column.nullable?'0':'1',dflt_value:column.defaultExpression,pk:String(column.primaryKeyOrdinal),hidden:String(column.hidden)}));
    const rows=table.rows.map(row=>row.cells.map(cell=>cell[0]==='real64be'?['real-ieee754',cell[1]]:cell)) as Json[];
    return {name:table.name,columns, ...digestRowMultiset(rows)};
  });
  const controls={storage_maintenance:current.tables.find(t=>t.name==='storage_maintenance')!.rows.map((_,i)=>originRow(current.tables.find(t=>t.name==='storage_maintenance')!,i)) as Record<string,Json>[],
    storage_source_clients:ordered(before.rows).map(row=>{
      const values=originRow({...before,rows:[row],count:'1'});
      return Object.fromEntries(Object.entries(values).map(([name,value])=>[name,typeof value==='bigint'?String(value):value])) as Record<string,Json>;
    })};
  controls.storage_maintenance=controls.storage_maintenance.map(row=>Object.fromEntries(Object.entries(row).map(([name,value])=>[name,typeof value==='bigint'?String(value):value])));
  const md=buildDatabaseManifests('sqlite',{kind:'CF17-value-only-catalog-not-native-installation'},tables,controls);
  const physicalCatalog=store.add('clientPhysicalCatalog','database-manifests',md,[],'legacy');
  const logicalCatalog=origin.sources.find(item=>item.name==='PC-TABLE-UNIVERSE.json')!.artifact;
  const cut={contract:'s4p-row-cut/r1',source,backend:'sqlite',stage:'p1-source',logicalCatalog,physicalCatalog,textEncoding:'UTF-8',
    predecessor:origin.refs.J_A!,tables:current.tables.map(({name,columns,count,rows})=>({name,columns,count,rows})),sequences:current.sequences};
  options.mutate?.('clientRuntimeCut',cut);
  const cutBytes=Buffer.from(canonicalJson({formatVersion:1,kind:'s4p-row-cut',payload:cut})),cutHash=originSha(cutBytes);
  const runtimeCut=store.raw('clientRuntimeCut','s4p-row-cut',cutBytes,
    {ref:`s4-provider/sha256/${cutHash}/s4p-row-cut.json`,sha256:cutHash,bytes:String(cutBytes.length)},[],cut);
  const facts={contract:'profile-source-client-facts/r2',context,textEncoding:encoding,columnContract:before.columnContract,
    columnContractValueDigest:before.columnContractValueDigest,before:beforeSelection,after:afterSelection,afterCount:after.count,
    afterRowsDigest:rowsDigest(after.rows),observation,runtimeCut};
  const factsRef=store.add('clientFacts','m2-source-client-facts',facts);
  const delta={contract:'m2-source-client-delta/r2',source,before:beforeSelection,after:afterSelection,
    changes:[{kind:'client-observation',clientId:'origin-coordinator',before:coordinator,after:ended,
      effect:options.existingActorObservation?'observed':'ended-observed'},
      ...options.existingActorObservation?[]:[{kind:'maintenance-registration',clientId:'新-owner',before:null,after:newborn,actorId}]],facts:factsRef,
    rule:'profile-maintenance-only-registration-and-observation/r2'};
  const deltaRef=store.add('clientDelta','m2-source-client-delta',delta);
  const input={...origin.pcInput,artifacts:store.all()};
  const oldRegistration=JSON.parse(String(coordinatorValues.db_sessions_json));
  const registrations=new Map<string,M2ClientRegistration>([[coordinator.cells[0]![1]!,{
    ...(priorP1Registration??{creation:oldRegistration.creation}),actorId:process.instanceId}]]);
  const parameters={delta:originEvidence(deltaRef,store.value('clientDelta')),source,plan:origin.refs.plan!,actualPlan:plan,
    migrationId:'a12',previous:origin.refs.J_A!,targetSequence:7,fromGeneration:7,toGeneration:8,fenceEpoch:2,
    originCapture:origin.refs.capture!,receiptGeneration:7,currentFormat,before,beforeControl:control.value.control,
    knownRegistrations:registrations};
  function runWith(mode:'facts'|ClientTextEncoding,exhaust?:'bytes'|'work',changeTable?:(table:RawTable)=>void){
    const admitted=createM2HistoryRequest(JSON.stringify(input));assert(admitted.ok,JSON.stringify(admitted));
    const request=admitted.value;
    if(exhaust)p0State(request).usage[exhaust]=P0_LIMITS[exhaust];
    return withP0Guard(request,()=>{
      const g=new M2Graph(request);beginP0FArtifactPass(g.f,request.original);
      try{
        if(mode==='facts')return checkM2OwnerClients(g,{...parameters,frozenHistory:g.observation(request.input.graph.observation)} as M2OwnerClientsInput);
        const table=structuredClone(before);
        for(const row of table.rows){
          if(mode.backend==='postgres')row.rowid=null;
          row.cells=row.cells.map((cell,i):RawCell=>{
            if(cell[0]==='null')return cell;
            if(cell[0]==='integer'&&mode.backend==='postgres'){
              const bytes=Buffer.alloc(i===4?4:8);if(i===4)bytes.writeInt32BE(Number(cell[1]));else bytes.writeBigInt64BE(BigInt(cell[1]));
              return ['pg-binary',i===4?'23':'20',bytes.toString('hex')];
            }
            if(cell[0]!=='text')return cell;
            const text=Buffer.from(cell[1],'hex').toString('utf8'),bytes=Buffer.from(text,mode.name==='UTF-16le'||mode.name==='UTF-16be'?'utf16le':'utf8');
            if(mode.name==='UTF-16be')bytes.swap16();
            return mode.backend==='postgres'?['pg-binary','25',bytes.toString('hex')]:['text',bytes.toString('hex')];
          });
        }
        changeTable?.(table);
        // CF01/02 only: this deliberately does not claim a PG/UTF16 runtimeCut
        // or reinterpret the original SQLite column selection as a PG catalog.
        return readM2ClientFrames(g,table,mode,currentFormat,{...source,kind:mode.backend});
      }
      finally{endP0FArtifactPass(g.f);}
    });
  }
  return {expectedAfter:after,store,input,parameters,
    run:(exhaust?:'bytes'|'work')=>runWith('facts',exhaust) as ReturnType<typeof withP0Guard<ReturnType<typeof checkM2OwnerClients>>>,
    frames:(encoding:ClientTextEncoding,changeTable?:(table:RawTable)=>void)=>runWith(encoding,undefined,changeTable) as ReturnType<typeof withP0Guard<ReturnType<typeof readM2ClientFrames>>>};
}

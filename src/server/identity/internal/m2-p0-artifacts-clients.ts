import type { ArtifactRef, SourceClientRawRow, SourceClientTextCell, SourceRef, VerificationJournalRecord } from '../../storage/maintenance/types.ts';
import type { SnapshotValueClosure } from '../../storage/maintenance/journal-values.ts';
import { sourceClientEpochClassification,validateHistoricalControllerProfile } from '../../storage/maintenance/control-candidate/rows.ts';
import { maintenanceFailureCode } from '../../storage/maintenance/error.ts';
import { sourceClientColumns } from '../../storage/maintenance/source-clients-read.ts';
import { readP0Text,withP0Guard } from './m2-p0.ts';
import type { P0Request,P0Result,P0Row } from './m2-p0.ts';
import { p0State } from './m2-p0-budget.ts';
import { fState } from './m2-p0-artifacts-common.ts';
import type { FState } from './m2-p0-artifacts-common.ts';
import { beginP0FArtifactPass,endP0FArtifactPass,p0FRowsSyntaxFrame,preparseP0FRowJson,withP0FNativeConsumer } from './m2-p0-artifacts-frame.ts';

const controllerValueKeys=Object.freeze(['client_id','database_instance_id','entrypoint','build_id','drain_state','db_sessions_json','host_identity_json','process_identity_json']);

interface OriginalCut { readonly journal:ArtifactRef; readonly source:SourceRef; readonly record:VerificationJournalRecord }
const cuts=new WeakMap<P0Request,OriginalCut>();
export type P0OriginalClientClassification = Readonly<{subject:SourceClientTextCell;kind:'ordinary-client'|'native-management-client'|'maintenance-controller'|'legacy-client';
  classification:'current-client'|'historical-client'|'active-actor'|'exited-actor'|'historical-profile'|'unresolved-controller'}>;
export interface P0OriginalClientClassifications { readonly basis:'capture-facts-v3'|'legacy-v2-data';readonly captureJournal:ArtifactRef;
  readonly source:SourceRef;readonly clients:readonly P0OriginalClientClassification[]; }

/** Remember only immutable source data from the exact receipt cut. The G caller
 * must still complete every original family and every deletion relation. */
export function rememberP0OriginalClientCut(f:FState,closure:SnapshotValueClosure):void{
  let selected:VerificationJournalRecord|undefined;
  for(const node of closure.chain.nodes){f.charge(1);if(f.refEqual(node.reference,closure.receipt.capture.journal)){f.require(selected===undefined);selected=node.record;}}
  f.require(selected&&selected.event==='capture'&&selected.formatVersion!==1);
  f.charge(1,0,2,4);const data:OriginalCut={journal:closure.receipt.capture.journal,source:closure.receipt.capture.source,record:selected};
  f.freeze(data);cuts.set(f.request,data);
}
function legacyRow(f:FState,row:P0Row):SourceClientRawRow{
  f.charge(sourceClientColumns.length,0,sourceClientColumns.length,1+sourceClientColumns.length);
  const value:Record<string,unknown>={};
  for(const [index,column] of sourceClientColumns.entries())value[column.name]=row.raw.cells[index];
  f.freeze(value);return value as unknown as SourceClientRawRow;
}
/** This new v2 caller has no v3 controlCost reservation. Prepay its fixed
 * original controllerRegistration comparisons/conversions explicitly; codec
 * clones, actual JSON parses and canonical materialization keep their own fees.
 * Missing/wrong-shaped fields cannot reach these operations past the original
 * strict registration schema. Reading them here supplies only a cost bound. */
function historicalControllerReads(f:FState,cut:OriginalCut,raw:SourceClientRawRow,values:Record<string,unknown>,registration:unknown,host:unknown,process:unknown):void{
  const record=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
  const text=(value:unknown):string=>typeof value==='string'?value:'';
  f.charge(6);const body=record(registration),creation=record(body?.creation),plan=record(creation?.plan),previous=record(creation?.previousAnchor);
  const compare=(a:string,b:string)=>f.charge(1,(a.length+b.length)*2);
  compare(text(values.database_instance_id),cut.source.databaseInstanceId);
  compare(text(values.entrypoint),'maintenance-controller');compare(text(values.build_id),'boardroom-maintenance-control-v1');compare(text(values.drain_state),'none');
  compare(raw.drain_epoch[0],'null');compare(raw.drain_receipt_digest[0],'null');
  compare(raw.registered_epoch[1],raw.observed_epoch[1]);compare(text(creation?.fenceEpoch),raw.registered_epoch[1]);
  compare(text(body?.sourceIdentityDigest),cut.source.identityDigest);compare(raw.protocol_version[1],'1');
  const canonicalComparison=(value:unknown,display:unknown)=>{if(value===undefined)return;const encoded=f.encode(value);f.charge(1,(encoded.bytes+text(display).length)*2);};
  canonicalComparison(registration,values.db_sessions_json);canonicalComparison(host,values.host_identity_json);canonicalComparison(process,values.process_identity_json);
  if(body?.source!==undefined){const actual=f.encode(body.source),expected=f.encode(cut.source);f.charge(1,(actual.bytes+expected.bytes)*2);}
  const planUnits=11+text(plan?.sha256).length;
  const sequence=text(creation?.targetSequence),priorUnits=15+text(creation?.migrationId).length+sequence.length+text(previous?.sha256).length;
  // "plans/" + digest + ".json", and "journals/" + migration + "/" +
  // (targetSequence - 1) + "-" + digest + ".json": read+write UTF16.
  // Strict positive decimal targetSequence means its predecessor has no more digits.
  f.charge(2,(planUnits+priorUnits)*4);
  f.charge(2,(text(plan?.ref).length+planUnits+text(previous?.ref).length+priorUnits)*2);
  // targetSequence is parsed twice; predecessor string emitted once; creation
  // epoch parsed once. The numeric current epoch, subtraction/order and the
  // null/empty client-id checks need work but produce no additional JSON nodes.
  f.charge(10,sequence.length*6+text(creation?.fenceEpoch).length*2);
}
function legacyController(f:FState,cut:OriginalCut,row:P0Row,raw:SourceClientRawRow):'historical-profile'|'unresolved-controller'{
  const encoding=f.request.input.graph.observation.textEncoding;
  f.charge(1,0,2,1);
  const frame=p0FRowsSyntaxFrame(f,raw,[raw],encoding);
  try{
    // The original registration helper owns the complete source/profile byte
    // relationship. These are syntax values for its same three actual fields.
    const host=preparseP0FRowJson(frame,raw,'host_identity_json').value;
    const process=preparseP0FRowJson(frame,raw,'process_identity_json').value;
    const registration=preparseP0FRowJson(frame,raw,'db_sessions_json').value;
    f.charge(8,0,0,17);const values:Record<string,unknown>={};
    for(const key of controllerValueKeys)values[key]=readP0Text(f.request,row,key);
    historicalControllerReads(f,cut,raw,values,registration,host,process);
    f.charge(3,0,0,3);
    withP0FNativeConsumer(frame,()=>validateHistoricalControllerProfile(raw,values,cut.source,cut.record.fenceEpoch,{host,process},frame));
    return 'historical-profile';
  }catch(error){
    // Only owned, known data rejection becomes unresolved profile data.
    // Exhaustion and arbitrary exceptions keep their original identities.
    if(maintenanceFailureCode(error)!==undefined)return 'unresolved-controller';
    const known=error!==null&&(typeof error==='object'||typeof error==='function')?p0State(f.request).failures.get(error):undefined;
    if(known&&known.code!=='resource_limit')return 'unresolved-controller';
    throw error;
  }
}
/** Private data getter after original F. No success permit, classifier callback,
 * frame or meter is accepted. Unknown v2 controllers are never an empty set. */
export function getP0OriginalClientClassifications(request:P0Request):P0Result<P0OriginalClientClassifications>{
  return withP0Guard(request,()=>{
    const f:FState=fState(request),cut=cuts.get(request);f.require(cut,'artifact_semantic_mismatch','scope-mismatch');
    beginP0FArtifactPass(f,request.original);
    try{
      const record=cut.record;let clients:P0OriginalClientClassification[];let basis:P0OriginalClientClassifications['basis'];
      if(record.formatVersion===3){
        f.require(record.controlProof!==null);const facts=record.controlProof.facts.clients;
        f.charge(facts.length,0,0,1+facts.length*6);clients=facts.map(fact=>({subject:fact.subject,kind:fact.kind,classification:fact.classification}));basis='capture-facts-v3';
      }else{
        const rows=request.original.rows('storage_source_clients');f.charge(rows.length,0,0,1+rows.length*6);clients=[];basis='legacy-v2-data';
        for(const row of rows){
          const raw=legacyRow(f,row),entrypoint=readP0Text(request,row,'entrypoint'),build=readP0Text(request,row,'build_id');
          f.require(raw.client_id[0]==='text');
          f.charge(2,Math.min(entrypoint?.length??0,22)*2+Math.min(build?.length??0,32)*2);
          if(entrypoint==='maintenance-controller'||build==='boardroom-maintenance-control-v1')clients.push({subject:raw.client_id,kind:'maintenance-controller',classification:legacyController(f,cut,row,raw)});
          else{
            // The original predicate's two cell tags, decimal formatting,
            // equality, two BigInts, subtraction and comparison. A validated
            // safe integer epoch has at most 16 decimal units: String output
            // plus its comparison reads take at most 64 UTF16 bytes.
            f.charge(8,(raw.registered_epoch[1].length+(raw.drain_epoch[1]?.length??0))*2+64);
            clients.push({subject:raw.client_id,kind:'legacy-client',classification:sourceClientEpochClassification(raw,record.fenceEpoch)});
          }
        }
      }
      f.charge(1,0,0,6);const result:P0OriginalClientClassifications={basis,captureJournal:cut.journal,source:cut.source,clients};f.freeze(result);return result;
    }finally{endP0FArtifactPass(f);}
  });
}

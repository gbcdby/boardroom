import {JOURNAL_VALUE_MATH,readReceiptValues} from '../../storage/maintenance/journal-values.ts';
import type {JournalValueContext, SnapshotValueClosure} from '../../storage/maintenance/journal-values.ts';
import {maintenanceFailureCode} from '../../storage/maintenance/error.ts';
import {parseP0Json} from './m2-p0.ts';
import type {ArtifactRef,ControlRootIdentity,SourceClientRawRow, SourceClientsRosterV1, MigrationPlan, VerificationJournalRecord} from '../../storage/maintenance/types.ts';
import type {ControlReplayNode,ControlReplayBindings} from '../../storage/maintenance/control-candidate/replay-core.ts';
import type {FState} from './m2-p0-artifacts-common.ts';
import {buildMdValue} from './m2-p0-artifacts-md.ts';
import {p0FRowsSyntaxFrame,p0FManifestSyntaxFrame,p0FCodecSyntaxFrame,withP0FNativeConsumer,preparseP0FRowJson,assertP0FJournalFrame,bindP0FJournalContext,assertP0FJournalContext,releaseP0FJournalContext,type P0FArtifactSyntaxFrame} from './m2-p0-artifacts-frame.ts';

/** Native pure consumer bounds. Array products account for find/filter/member relations;
 * bytes count repeated codecs/canonical/hash passes, not just the first selected parse. */
type NativeReadSite='sequence'|'control-identities'|'control-rows'|'control-facts'|'binder'|'invariant';
const formatterSites:Readonly<Record<NativeReadSite,true>>=Object.freeze({sequence:true,'control-identities':true,'control-rows':true,'control-facts':true,binder:true,invariant:true});
function legacy(f:FState,value:unknown,passes:number,relations:number,site:NativeReadSite):void{
    const s=f.size(value);
    // These six fixed sites retain the original field/regex/Map/decode bounds.
    // Owned canonical equality/SHA and private typed-row formatting now execute
    // their own metered data operations. Native ID comparisons, UTF8 ordering
    // and invariant key sorting are prepaid at their actual consumer sites.
    // PG conversion and any unowned/new parsed value keep the whole old bound.
    const owned=formatterSites[site]&&f.request.input.graph.observation.backend==='sqlite'&&f.nativeEncoding(value)!==undefined;
    const formatter=owned?0:1;
    f.charge((s.nodes+s.sortWork*formatter)*passes*relations,(s.text+(s.encoded+s.sortBytes)*formatter)*passes*relations);
}
const rowJsonColumns=['host_identity_json','process_identity_json','db_sessions_json'] as const;
const noChanges=Object.freeze([]);
function rowJsonCost(f:FState,row:SourceClientRawRow,frame:P0FArtifactSyntaxFrame):void{
  for(const key of rowJsonColumns){const cell=row[key];if(cell[0]!=='text')continue;
    // Strong semantic JSON nested inside the roster keeps the artifact's depth and same meter.
    preparseP0FRowJson(frame,row,key);
  }
}
// These fixed sequence fields are only passed to the original, separately
// metered canonical equality/hash consumers. Keep traversal work; no native
// operation scans all their characters outside those consumers.
function sequenceData(f:FState,value:unknown,passes:number):void {
  const size=f.size(value);f.charge((size.nodes+size.sortWork)*passes);
}
function sequenceCost(f:FState,nodes:readonly ControlReplayNode[]):void{
  f.charge(nodes.length*8,0,nodes.length*3);
  for(const {reference,record} of nodes){f.select(reference,'journal');sequenceData(f,reference,2);sequenceData(f,record.source,2);sequenceData(f,record.plan,2);sequenceData(f,record.previous,2);
    if(record.frozen){sequenceData(f,record.frozen,3);const roster=record.formatVersion!==1?record.sourceClients:null;
      if(roster!==null&&f.request.input.graph.observation.backend==='sqlite'&&f.nativeEncoding(roster)!==undefined&&f.nativeEncoding(roster.rows)!==undefined){
        // validateJournalSequence only passes rows to the separately metered
        // digest/equality operations. It reads the top-level binding fields.
        const whole=f.size(roster),rows=f.size(roster.rows);
        f.charge(whole.nodes*3,(whole.text-rows.text)*3);
      }else legacy(f,roster,3,1,'sequence');}
    f.charge(record.evidence.length,0,record.evidence.length);}
}
function controlCost(f:FState,plan:MigrationPlan,node:ControlReplayNode,roster:SourceClientsRosterV1,bindings:ControlReplayBindings,rows:readonly SourceClientRawRow[],frame:P0FArtifactSyntaxFrame):void{
  f.select(node.reference,'journal');const record=node.record;f.require(record.formatVersion===3&&record.controlProof!==null);const proof=record.controlProof;
  legacy(f,node.reference,2,1,'control-identities');legacy(f,record.source,2,1,'control-identities');legacy(f,record.plan,2,1,'control-identities');legacy(f,record.previous,2,1,'control-identities');legacy(f,bindings.controlRoot,2,1,'control-identities');legacy(f,bindings.mutexIdentity,2,1,'control-identities');legacy(f,proof.kind==='capture-controls'?proof.maintenanceInvariant:null,2,1,'control-identities');
  legacy(f,record.source,3,1,'control-rows');legacy(f,roster.textEncoding,3,1,'control-rows');legacy(f,rows,3,1,'control-rows');
  for(const row of rows){legacy(f,row,2,1,'control-rows');rowJsonCost(f,row,frame);}
  if(proof.kind==='control-successor'||proof.kind==='legacy-first-capture-bridge'){
    for(const change of proof.changes){legacy(f,change,4,1,'control-rows');rowJsonCost(f,change.after,frame);}legacy(f,roster,2,1,'control-rows');
  }
  // Runtime/client/session joins traverse these arrays. Reserve their actual products,
  // charging only their compared fields/JSON, rather than multiplying the whole journal.
  const facts=proof.facts,n=facts.clients.length+facts.runtime.runners.length+facts.runtime.owners.length+facts.runtime.results.length+1;
  legacy(f,facts,4,1,'control-facts');const shape=f.size(facts);// Repeated direct field comparisons are now prepaid at their actual native
  // join sites. Keep the conservative traversal/metadata bound, not n scans of
  // unrelated host/process/session payload strings.
  f.charge(shape.nodes*n,0,n*n);
  legacy(f,plan.sourceIdentity,2,1,'control-identities');legacy(f,plan.fileRoots,2,1,'control-identities');
}
export function mathP0(f:FState):JournalValueContext['math']{
  f.charge(1,0,1); // the fixed private math protocol record
  return {...JOURNAL_VALUE_MATH,
    equal:(a,b)=>f.equal(a,b),digestJson:v=>f.digest(v),
    buildDatabaseManifests:(d,s,t,c)=>buildMdValue(f,d,s,t,c),
    restorePointDigest:v=>{f.charge(9,0,0,9);return f.digest({capture:v.capture,sourceFilesManifest:v.sourceFilesManifest,database:v.database,manifests:v.manifests,schemaManifestDigest:v.schemaManifestDigest,frozenBusinessManifestDigest:v.frozenBusinessManifestDigest});},
    visit:v=>{const s=f.size(v);
      // The strict decoded MD root is known by identity, never a caller kind.
      // Its schema subtree is only passed to this context's metered buildMD /
      // equality / SHA data operations. The old extra whole-schema traversal
      // no longer occurs; keep the schema key and every other MD field here.
      if(v!==null&&typeof v==='object'&&f.decodedKinds.get(v)==='database-manifests'){
        const schema=f.nativeEncoding((v as {schema:unknown}).schema);
        if(schema!==undefined&&s.nodes>=schema.nodes&&s.text>=schema.text){f.charge(s.nodes-schema.nodes,s.text-schema.text);return;}
      }
      f.charge(s.nodes,s.text);
    },
    json:text=>{f.require(f.currentSite);return parseP0Json(f.request,text,f.currentSite,'reference');},
    canonicalText:text=>{f.require(f.currentSite);const value=parseP0Json(f.request,text,f.currentSite,'finite');f.require(f.sameText(f.canonical(value),text));return value;},
    validateJournalSequence:nodes=>{sequenceCost(f,nodes);f.require(nodes.length>0);
      return withP0FNativeConsumer(p0FCodecSyntaxFrame(f,nodes[0]!.record),()=>JOURNAL_VALUE_MATH.validateJournalSequence(nodes));},
    applyControlNode:(plan,node,previous,origin,roster,bindings,state)=>{
      const proof=node.record.formatVersion===3?node.record.controlProof:null;
      const changes=proof&&(proof.kind==='control-successor'||proof.kind==='legacy-first-capture-bridge')?proof.changes:noChanges;
      f.charge(state.rows.length+changes.length+1,0,state.rows.length+changes.length+1,2);
      const frameRows=[...state.rows];for(const change of changes)frameRows.push(change.after);
      const frame=p0FRowsSyntaxFrame(f,plan,frameRows,roster.textEncoding);
      controlCost(f,plan,node,roster,bindings,state.rows,frame);
      return withP0FNativeConsumer(frame,()=>JOURNAL_VALUE_MATH.applyControlNode(plan,node,previous,origin,roster,bindings,state,frame));
    },
    replayVerificationControls:(plan,nodes,bindings)=>{
      sequenceCost(f,nodes);const origin=nodes.find(n=>n.record.event==='capture');
      f.require(origin&&origin.record.formatVersion!==1&&origin.record.sourceClients!==null);
      const roster=origin.record.sourceClients;let rows=roster.rows;
      f.charge(rows.length+1,0,rows.length+1,1);const frameRows=[...rows];
      for(const node of nodes){const proof=node.record.formatVersion===3?node.record.controlProof:null;
        if(proof&&(proof.kind==='control-successor'||proof.kind==='legacy-first-capture-bridge'))for(const change of proof.changes){f.charge(1,0,1);frameRows.push(change.after);}}
      const frame=p0FRowsSyntaxFrame(f,plan,frameRows,roster.textEncoding);
      for(const node of nodes){if(node.record.formatVersion===3&&node.record.controlProof){controlCost(f,plan,node,roster,bindings,rows,frame);
        const proof=node.record.controlProof;if(proof.kind==='control-successor'||proof.kind==='legacy-first-capture-bridge'){
          f.charge(rows.length+1,0,rows.length+1);
          const next=new Map<string,SourceClientRawRow>();for(const row of rows)next.set(row.client_id[1],row);
          for(const change of proof.changes){f.charge(1,0,next.has(change.after.client_id[1])?0:1);next.set(change.after.client_id[1],change.after);}
          f.charge(next.size+1,0,next.size+1,1);rows=[...next.values()];
        }}}
      return withP0FNativeConsumer(frame,()=>JOURNAL_VALUE_MATH.replayVerificationControls(plan,nodes,bindings,frame));
    },
    bindSourceClientManifestRows:(md,rows,encoding)=>{
      // The old binder only reads the client table/controls, not schema or unrelated business tables.
      const table=md.tables.find(t=>t.name==='storage_source_clients');f.charge(md.tables.length);
      legacy(f,table,8,Math.max(1,rows.length),'binder');legacy(f,md.controlRows.storage_source_clients,8,Math.max(1,rows.length),'binder');legacy(f,rows,8,Math.max(1,rows.length),'binder');legacy(f,encoding,8,Math.max(1,rows.length),'binder');
      const frame=p0FRowsSyntaxFrame(f,md,rows,encoding);
      return withP0FNativeConsumer(frame,()=>JOURNAL_VALUE_MATH.bindSourceClientManifestRows(md,rows,encoding,undefined,frame));
    },
    invariantFromManifests:(md,captured,root,mutex)=>{
      legacy(f,md.controlRows.storage_maintenance,4,1,'invariant');legacy(f,captured.reference,4,1,'invariant');legacy(f,captured.record.source,4,1,'invariant');legacy(f,captured.record.frozen,4,1,'invariant');legacy(f,root,4,1,'invariant');legacy(f,mutex,4,1,'invariant');
      const frame=p0FManifestSyntaxFrame(f,md);
      return withP0FNativeConsumer(frame,()=>JOURNAL_VALUE_MATH.invariantFromManifests(md,captured,root,mutex,frame));
    },
  };
}
/** Fixed private factory. Its math is always constructed from the exact frame
 * owner; no generator, context, validator or replacement meter is accepted. */
export function createP0FJournalContext(f:FState,frame:P0FArtifactSyntaxFrame,root:ControlRootIdentity):JournalValueContext {
  assertP0FJournalFrame(frame,f);const math=mathP0(f);
  f.charge(1,0,1);const context:JournalValueContext=Object.freeze({root:root.path,identity:root,math});
  try{bindP0FJournalContext(frame,context);return context;}
  catch(error){releaseP0FJournalContext(context);throw error;}
}
/** Closed factory: callers cannot supply a generator, context, validator or meter. */
export function runP0Journal(f:FState,plan:MigrationPlan,root:ControlRootIdentity,receipt:ArtifactRef):SnapshotValueClosure{
  const frame=p0FCodecSyntaxFrame(f,plan);
  const context=createP0FJournalContext(f,frame,root);
  try{
    const program=readReceiptValues(context,receipt);
    assertP0FJournalContext(frame,context);let step=program.next();
    while(!step.done){f.charge(1);const op=step.value;let value:unknown;
      if(op.operation==='decode')value=f.decode(op.reference,op.as);
      else{const e=f.select(op.reference);value=op.operation==='kind'?e.selected.kind:undefined;}
      assertP0FJournalContext(frame,context);step=program.next(value);
    }
    return step.value;
  }catch(error){if(maintenanceFailureCode(error)!==undefined)f.require(false);throw error;}
  finally{releaseP0FJournalContext(context);}
}

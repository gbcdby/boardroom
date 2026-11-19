import {readReceiptValues} from '../../storage/maintenance/journal-values.ts';
import {withP0Guard,assertP0View} from './m2-p0.ts';
import type {P0Request,P0View,P0Result} from './m2-p0.ts';
import {fState} from './m2-p0-artifacts-common.ts';
import type {FState} from './m2-p0-artifacts-common.ts';
import {catalogP0,physicalP0} from './m2-p0-artifacts-columns.ts';
import {compareP0Manifests} from './m2-p0-artifacts-md.ts';
import {mathP0,runP0Journal} from './m2-p0-artifacts-math.ts';
import {beginP0FArtifactPass,endP0FArtifactPass} from './m2-p0-artifacts-frame.ts';
import {rememberP0OriginalClientCut} from './m2-p0-artifacts-clients.ts';

function sequenceP0(f:FState,namespace:string,mdSequence:unknown):void{
  const o=f.request.input.graph.observation;
  for(const seq of o.sequences){
    const entry=f.select(seq.relationIdentity,'pc-pg-sequence-relation'),v=f.object(f.json(entry),['contract','source','namespace','relationOid','name','ownedBy','typeOid','start','increment','minimum','maximum','cache','cycle','identity','dependencyType','incomingDependencies','persistence','tablespace']);
    f.require(v.contract==='m2-pc-pg-sequence-relation/r1'&&f.equal(v.source,o.source)&&v.namespace===namespace&&v.name===seq.name);
    const owner=f.object(v.ownedBy,['table','column','tableOid']);f.require(owner.table==='schema_migrations'&&owner.column==='version');
    for(const value of [v.relationOid,owner.tableOid]){const text=f.text(value);f.charge(1,text.length*2);f.require(text.length<=20&&/^(0|[1-9][0-9]*)$/.test(text)&&BigInt(text)>0n&&BigInt(text)<=4294967295n);}
    const exact={typeOid:'23',start:'1',increment:'1',minimum:'1',maximum:'2147483647',cache:'1',cycle:false,identity:'d',dependencyType:'i',incomingDependencies:'0',persistence:'p',tablespace:'0'};
    for(const [k,value] of Object.entries(exact))f.require(v[k]===value);
    const s=f.object(mdSequence);const fields={name:'name',type_oid:'typeOid',start:'start',increment:'increment',minimum:'minimum',maximum:'maximum',cache:'cache',cycle:'cycle',identity:'identity',dependency_type:'dependencyType',incoming_dependencies:'incomingDependencies',persistence:'persistence',tablespace:'tablespace'};
    for(const [native,pc] of Object.entries(fields))f.require(s[native]===v[pc]);
    f.require(s.owner_schema===namespace&&s.owner_table===owner.table&&s.owner_column===owner.column);
  }
}
export interface P0ArtifactObservation {
  readonly classification:'artifact-value-observation'; readonly phase:P0View['phase'];readonly rule:'PC1B-ART01';
  readonly artifacts:number;readonly evidence:number;readonly originalHistoryDigest:string;
  readonly receiptAnchor:'capture-prefix';readonly fullSemanticClosure:'not-performed';
}
/** Only the authenticated private P0 request/view enter here. No caller-supplied roots or contexts. */
export function checkP0Artifacts(request:P0Request,view:P0View):P0Result<P0ArtifactObservation>{
  return withP0Guard(request,()=>{
    assertP0View(request,view);const f:FState=fState(request);beginP0FArtifactPass(f,view);
    try {
    f.used.clear();f.usedEvidence.clear();
    const columns=catalogP0(f),physical=physicalP0(f),o=request.input.graph.observation;
    const receipt=f.bridge(o.snapshotReceiptRef,'receipt');
    const closure=runP0Journal(f,readReceiptValues({root:physical.root.path,identity:physical.root,math:mathP0(f)},receipt.selected.artifact));
    f.require(f.equal(closure.chain.plan,physical.plan)&&f.equal(closure.receipt.capture.source,o.source));
    for(const node of closure.chain.nodes)if(node.record.formatVersion!==1&&node.record.sourceClients!==null)f.require(f.equal(node.record.sourceClients.textEncoding,o.textEncoding));
    const schema=f.object(closure.manifests.schema);
    if(o.backend==='postgres'){
      const identity=f.object(physical.plan.sourceIdentity),scope=f.object(schema.scope);
      f.require(identity.kind==='postgres'&&scope.name===identity.schemaName);
      sequenceP0(f,f.text(identity.schemaName),schema.migrationIdentitySequence);
    }
    // Retained views preserve S/original G and rerun these equations; they do not re-sign its old snapshot.
    compareP0Manifests(f,closure.manifests,columns);
    f.finish();
    // A's outer scanner admitted every string/integer in this exact frozen
    // observation, and its closed table/source/row grammar has only ASCII
    // object keys. The fixed two-element wrapper therefore is already R3.
    if(f.historyDigest===undefined)f.historyDigest=f.digest(['m2-pc-complete-history/r1',o]);
    if(view.phase==='original-graph')rememberP0OriginalClientCut(f,closure);
    return Object.freeze({classification:'artifact-value-observation',phase:view.phase,rule:'PC1B-ART01',artifacts:f.used.size,evidence:f.usedEvidence.size,originalHistoryDigest:f.historyDigest,receiptAnchor:'capture-prefix',fullSemanticClosure:'not-performed'});
    } finally { endP0FArtifactPass(f); }
  });
}

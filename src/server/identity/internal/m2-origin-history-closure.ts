import type { ClosureResult, ClosureValue, ClosureAvailability, ClosureNativeCheck } from '../m2-history-closure-contracts.ts';
import type { P0Request, P0Table } from './m2-p0-types.ts';
import { P0_RULES } from './m2-p0-types.ts';
import { withP0Guard,chargeP0,failP0,P0_LIMITS } from './m2-p0-budget.ts';
import { m2RequestData, createM2HistoryContext } from './m2-p0-request.ts';
import type { FState } from './m2-p0-artifacts-common.ts';
import { beginP0FArtifactPass, endP0FArtifactPass } from './m2-p0-artifacts-frame.ts';
import { M2Graph } from './m2-durable-graph.ts';
import { checkM2Origin } from './m2-durable-origin.ts';
import { checkM2CurrentValues, } from './m2-durable-current.ts';
import { checkM2TerminalControl, readM2Control } from './m2-durable-controls.ts';
import { checkM2LegacyKeys } from './m2-p0-keys.ts';
import { checkP0IdentityFamily } from './m2-p0-identity-family.ts';
import { checkP0TaskDecisionWorkEvents } from './m2-p0-task-decision-work-events.ts';
import { checkP0AuditMemory } from './m2-p0-audit-memory.ts';
import { checkP0ConfigurationFamily } from './m2-p0-config-family.ts';
import { m2OwnedInputDigest } from './m2-owned-input-digest.ts';

const nativeChecks:readonly ClosureNativeCheck[]=['physical_source_authenticity','native_snapshot_window','actual_catalog_identity',
  'strict_p1_native_outer_join','g1_exclusion','sequence_exclusion','current_authorization','native_commit','lossless_native_writer','full_ab_budget','fs_profile','production_tuple'];
/** Resolve the sole fixed origin role to its captured predecessor. This is
 * admission of immutable data; the full consumer below replays every relation. */
function originContext(parent:P0Request):P0Request {
  const g=new M2Graph(parent),f:FState=g.f,data=m2RequestData(parent)!;
  f.require(data.rootKind==='profile-origin-history'&&parent.input.graph.origin?.importManifest===null,'semantic_unsupported');
  const history=g.payload(data.root,'profile-origin-history'),closure=g.payload(history.journalClosure,'profile-journal-closure');
  f.require(closure.purpose==='m2-origin'&&closure.originHistory===null);
  let committed:Record<string,unknown>|undefined;const seen=new Set<string>();f.charge(1,0,1);
  for(const reference of closure.nodes){f.charge(1,0,1);f.require(!seen.has(reference.ref));seen.add(reference.ref);
    const record=f.object(f.json(g.selected(reference,'journal')));if(record.formatVersion===4&&record.event==='s2_profile_committed'){f.require(!committed);committed=record;}}
  f.require(committed);const binding=f.object(committed.bindings,['activationReceipt','takeoverPlan']);
  const plan=g.payload(g.ref(binding.takeoverPlan),'m2-takeover-plan'),seed=g.payload(plan.seed,'m2-takeover-seed');
  const before=f.json(g.selected(seed.before.observation,'pc-observation'));return createM2HistoryContext(parent,before);
}
export function runM2OriginHistoryClosure(parent:P0Request):ClosureResult {
  const guarded=withP0Guard(parent,():ClosureResult=>{
    const request=originContext(parent),locator=new M2Graph(request),data=m2RequestData(request)!;
    const preliminary=locator.payload(data.root,'profile-origin-history'),origin=checkM2Origin(request,preliminary.journalClosure),g=origin.graph,f:FState=g.f;
    const current=g.observation(parent.input.graph.observation),o=current.observation;
    g.same(o.source,origin.before.observation.source);g.same(o.physicalSourceRef,origin.before.observation.physicalSourceRef);g.same(o.snapshotReceiptRef,origin.before.observation.snapshotReceiptRef);
    beginP0FArtifactPass(f,current.view);
    try {
      const history=g.originHistory(data.root);g.same(history.source,o.source);g.same(history.activation,origin.activation.ref);
      g.same(history.activationReceipt,origin.activationArtifact);g.same(history.completion,origin.completion);g.same(history.journalClosure,preliminary.journalClosure);
      const selected=f.object(f.json(g.selected(history.authorityRow,'pc-typed-row')),['contract','source','backend','phase','table','columnContract','columnContractValueDigest','row']);
      const authorityTable=g.tableOf(current,'config_authority');f.require(authorityTable.rows.length===1&&selected.contract==='m2-pc-typed-row/r1'
        &&selected.backend===o.backend&&selected.phase==='p1'&&selected.table==='config_authority'&&selected.columnContractValueDigest===authorityTable.columnContractValueDigest);
      g.same(selected.source,o.source);g.same(selected.columnContract,authorityTable.columnContract);g.same(selected.row,authorityTable.rows[0]);
      const authority=g.row('config_authority',authorityTable.rows[0]!,o.backend);f.require(authority.table==='config_authority');
      g.join('authority',{authority:authority.value,receipt:origin.activation,receiptArtifact:origin.activationArtifact,sourceHistory:history,importSelection:null});
      // The r2 inline M2 branch is exactly the original A/post-A or B projection.
      // Later ordinary edits need their own p1-source-cut/history source window.
      const control=readM2Control(g,g.tableOf(current,'storage_maintenance'),'p1');
      if(control.profileTakeoverTerminal===null){
        g.same(control,origin.controlBeforeB);g.same(o.sequences,origin.preB.observation.sequences);
        for(const table of o.tables)g.sameTable(o.backend,g.tableOf(origin.preB,table.name),table);
      }else checkM2TerminalControl(g,origin.preB,current,origin.terminal,origin.completion);
      const keys=checkM2LegacyKeys(request,current.view);if(!keys.ok)return keys;
      const identities=checkP0IdentityFamily(request,current.view);if(!identities.ok)return identities;
      const tasks=checkP0TaskDecisionWorkEvents(request,current.view);if(!tasks.ok)return tasks;
      const audit=checkP0AuditMemory(request,tasks.value.completion,current.view);if(!audit.ok)return audit;
      const config=checkP0ConfigurationFamily(request,current.view);if(!config.ok)return config;
      checkM2CurrentValues(g,current,origin);f.finish();
      const availability:ClosureAvailability[]=[];f.charge(audit.value.availability.length+config.value.runtimeUsability.length,0,audit.value.availability.length+config.value.runtimeUsability.length+1);
      for(const item of audit.value.availability)availability.push({kind:item.code,location:item.location});
      // No full success is issued for a current configuration the original
      // consumer could not actually interpret in this exact A/B projection.
      f.require(config.value.runtimeUsability.every(item=>item.usable));
      f.charge(o.tables.length+parent.input.artifacts.length+P0_RULES.length+nativeChecks.length,0,o.tables.length+parent.input.artifacts.length+P0_RULES.length+nativeChecks.length+8);
      const value:ClosureValue={classification:'observation',coverage:'complete-history-value-closure',graphKind:'m2-observation',phase:'p1',source:o.source,catalog:'m2-p1',
        inputDigest:m2OwnedInputDigest(parent),completeHistoryDigest:current.completeHistoryDigest,
        tables:o.tables.map(table=>({table:table.name as P0Table,rows:table.count,rowMultisetDigest:g.rowDigest(o.backend,table)})),
        selectedArtifacts:parent.input.artifacts.map((item,artifactOrdinal)=>({kind:item.kind,artifactOrdinal,byteDigest:item.artifact.sha256,bytes:item.artifact.bytes})),
        checks:{legacySemanticGraph:'verified',m2SemanticGraph:'verified',layoutSemanticGraph:'not-applicable',artifactBytes:'verified',artifactSemantics:'verified',
          sourceProvenance:'verified-values',retainedReferenceClosure:'not-requested'},deletion:null,
        ruleCoverage:P0_RULES.map(rule=>({rule,status:rule==='PC1B-DEL01'?'not-applicable':'verified'})),historicalAvailability:availability,
        remaining:nativeChecks.map(check=>({check,status:check==='sequence_exclusion'&&o.backend==='sqlite'?'not-applicable':'unproven'}))};
      f.freeze(value);
      // The new fixed result is already this request's immutable value tree.
      // Measure its exact canonical bytes without allocating a second token
      // tree solely to count them. Keep the original full-result/envelope cap
      // and prepayment for eventual serialization, including the 20-byte shell.
      const outputBytes=f.size(value).encoded+20;
      if(outputBytes>P0_LIMITS.output)failP0(parent,{code:'resource_limit',rule:null});
      chargeP0(parent,{work:1,bytes:outputBytes*2,tuples:1});
      return Object.freeze({ok:true,value});
    } finally {endP0FArtifactPass(f);}
  });return guarded.ok?guarded.value:guarded;
}

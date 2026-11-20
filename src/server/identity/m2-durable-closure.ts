import type { ReadonlyDeep } from './m2-value-contracts.ts';
import type { ArtifactRef, ProfileCompletionBinding, SourceRef, JournalAnchor } from './internal/m2-durable-types.ts';
import type { P0Error } from './internal/m2-p0-types.ts';
import { createM2DurableRequest, m2RequestData } from './internal/m2-p0-request.ts';
import { withP0Guard } from './internal/m2-p0-budget.ts';
import { checkM2Origin } from './internal/m2-durable-origin.ts';

export type M2DurableErrorCode='invalid_value'|'unsupported_shape'|'artifact_missing'|'artifact_integrity'|'reference_conflict'|'value_conflict'
  |'journal_invalid'|'unsupported_source'|'semantic_unsupported'|'format_unregistered'|'resource_limit'|'unused_artifact';
export type M2DurableError=Readonly<{code:M2DurableErrorCode;ruleId:string;path:string}>;
const nativeChecks=Object.freeze(['physical_source_authenticity','snapshot_native_restore','native_window','full_native_catalog','G1/native_guard',
  'sequence_exclusion','current_authorization','native_commit_and_close','filesystem_durability','production_registration'] as const);
export type M2DurableClosureValue=ReadonlyDeep<{
  classification:'observation';coverage:'durable-m2-origin-values';selectedRoots:{kind:'m2-origin';closure:ArtifactRef};checkedArtifacts:number;
  originCompletion:ProfileCompletionBinding;layoutCompletion:null;
  state:{authoritySource:SourceRef;ownerGeneration:number;fenceEpoch:number;cursor:JournalAnchor;resumeAt:JournalAnchor;cancellation:null};
  remaining:{check:typeof nativeChecks[number];status:'unproven'|'not-applicable'}[];
}>;
export type M2DurableClosureResult={readonly ok:true;readonly value:M2DurableClosureValue}|{readonly ok:false;readonly error:M2DurableError};
function failure(error:P0Error):M2DurableClosureResult {
  const code:M2DurableErrorCode=error.code==='artifact_bytes_mismatch'?'artifact_integrity':error.code==='artifact_kind_unsupported'?'unsupported_shape'
    :error.code==='source_contract_mismatch'?'unsupported_source':error.code==='artifact_semantic_mismatch'||error.code==='semantic_invariant_failed'||error.code==='retained_reference_conflict'?'value_conflict':error.code;
  return Object.freeze({ok:false,error:Object.freeze({code,ruleId:code==='resource_limit'?'R42':error.phase==='input'?'R01':'R04',path:error.location?.inputPart==='artifact'
    ?`selectedArtifacts[${error.location.artifactOrdinal}].bytesHex`:'$'})});
}
/** Full historical origin values only. All other known root branches remain
 * explicit unsupported until their own complete consumers are implemented. */
export function verifyM2DurableClosure(input:unknown):M2DurableClosureResult {
  const admitted=createM2DurableRequest(input);if(!admitted.ok)return failure(admitted.error);
  const guarded=withP0Guard(admitted.value,():M2DurableClosureResult=>{
    const data=m2RequestData(admitted.value)!,result=checkM2Origin(admitted.value,data.root),f=result.graph.f;
    f.charge(admitted.value.input.artifacts.length+admitted.value.input.evidence.length);
    if(f.used.size!==admitted.value.input.artifacts.length)return Object.freeze({ok:false,error:Object.freeze({code:'unused_artifact',ruleId:'R26',path:'selectedArtifacts'})});
    f.finish();f.charge(nativeChecks.length+20,2048,nativeChecks.length+10,64);
    const value:M2DurableClosureValue={classification:'observation',coverage:'durable-m2-origin-values',selectedRoots:{kind:'m2-origin',closure:data.root},
      checkedArtifacts:f.used.size,originCompletion:result.completion,layoutCompletion:null,
      state:{authoritySource:result.before.observation.source,ownerGeneration:result.ownerGeneration,fenceEpoch:result.completion.epochAfter,
        cursor:result.completion.terminal,resumeAt:result.completion.terminal,cancellation:null},
      remaining:nativeChecks.map(check=>({check,status:check==='sequence_exclusion'&&result.before.observation.backend==='sqlite'?'not-applicable':'unproven'}))};
    f.freeze(value);return Object.freeze({ok:true,value});
  });return guarded.ok?guarded.value:failure(guarded.error);
}

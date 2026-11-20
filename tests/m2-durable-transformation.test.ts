import assert from 'node:assert/strict';
import test from 'node:test';
import { createM2DurableRequest } from '../src/server/identity/internal/m2-p0-request.ts';
import { withP0Guard, p0State } from '../src/server/identity/internal/m2-p0-budget.ts';
import { M2Graph } from '../src/server/identity/internal/m2-durable-graph.ts';
import { beginP0FArtifactPass,endP0FArtifactPass } from '../src/server/identity/internal/m2-p0-artifacts-frame.ts';
import { checkM2Capture,checkM2InitialBusiness,M2Business } from '../src/server/identity/internal/m2-durable-business.ts';
import { checkM2TargetRows,checkM2AuditAdditions,checkM2AllowedDelta } from '../src/server/identity/internal/m2-durable-delta.ts';
import { m2OriginFixture } from './helpers/m2-origin-fixture.ts';

test('complete source transformation consumes real nonempty 61-table capture and all 72 target tables',async()=>{
  const fixture=await m2OriginFixture(),admitted=createM2DurableRequest(fixture.durableWire);assert(admitted.ok,JSON.stringify(admitted));
  const result=withP0Guard(admitted.value,()=>{
    const g=new M2Graph(admitted.value),f=g.f;beginP0FArtifactPass(f,admitted.value.original);
    try{
      const plan=g.payload(fixture.refs.takeover!,'m2-takeover-plan'),seed=g.payload(plan.seed,'m2-takeover-seed');
      const before=g.history(seed.before),proof=g.payload(fixture.refs.proof!,'m2-post-a-proof'),exact=g.evidence(proof.exactAllowedDeltaCheck,'m2-exact-delta-check'),after=g.history(exact.after);
      const delta=g.evidence(plan.allowedDeltaManifest,'m2-allowed-delta'),target=g.payload(delta.targetRows,'m2-target-rows'),map=g.evidence(plan.sourceToTargetManifest,'m2-source-to-target');
      const receipt=g.value('activation-receipt',g.payload(fixture.refs.activationReceipt!,'m2-activation-receipt'));
      checkM2Capture(g,plan.captureRef,before);new M2Business(g,after).keys();checkM2TargetRows(g,target,seed,plan.seed,after);
      checkM2InitialBusiness(g,seed,map,plan.captureRef,before,after);checkM2AuditAdditions(g,seed,before,target.rows.auditAdditions);
      checkM2AllowedDelta(g,delta,plan,seed,target,before,after,receipt);return {before:before.observation.tables.length,after:after.observation.tables.length};
    }finally{endP0FArtifactPass(f);}
  });
  assert(result.ok,JSON.stringify({result,usage:p0State(admitted.value).usage}));assert.deepEqual(result.value,{before:61,after:72});
});

import type { RepositorySet } from '../../src/server/db/repositories.ts';
import { initializePolicyConfiguration,createPolicyConfiguration } from '../../src/server/policy/configuration.ts';
import { ownerActor } from '../../src/server/authz/actors.ts';
/** 旧 Task 行为测试明确配置当前 auto 策略；默认 owner 行为由 Decision 接缝另验。 */
export async function allowCurrentReviewerForTaskFixture(repos:RepositorySet) {
  await initializePolicyConfiguration(repos);
  const service=createPolicyConfiguration({repos}),owner={actor:ownerActor()},global=await service.getGlobal(owner);
  if(global.document.rules.some(r=>r.ruleId==='default.review.decide'&&r.outcome!=='auto'))await service.updateGlobal(owner,
    {expectedRevision:global.ref.revision,rules:global.document.rules.map(r=>r.ruleId==='default.review.decide'?{...r,outcome:'auto',reason:'Task domain fixture: explicitly authorized reviewer'}:r)});
}

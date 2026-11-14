import assert from 'node:assert/strict';
import { repositoryDriver,type RepositorySet } from '../../src/server/db/repositories.ts';
import { randomUUID } from 'node:crypto';
import { appendAuditEntry } from '../../src/server/audit.ts';
import { actorForMember, ownerActor } from '../../src/server/authz/actors.ts';
import { createTaskService } from '../../src/server/tasks/service.ts';
import type { ReviewCandidate, ReviewEvidence } from '../../src/shared/tasks.ts';

const at='2026-11-13T00:00:00.000Z';
const candidate:ReviewCandidate={repositoryRoot:'/fixture',fixedPointInput:'base',baseCommit:'a'.repeat(40),candidateCommit:'b'.repeat(40),policy:'committed-clean',gitVersion:'synthetic',diff:'+ synthetic',diffSha256:'c'.repeat(64),commits:[],commands:[],capturedAt:at};
function evidence(axis:string):ReviewEvidence {
  const completedAt='2026-11-13T00:01:00.000Z';
  return {provenance:'reviewer-declared',host:'fixture',hostVersion:'not-a-real-model-run',parentRunId:'one',invocationId:`inv-${axis}`,contextId:`ctx-${axis}`,startedAt:at,completedAt,
    command:{argv:['declared-fixture'],cwd:'/fixture',startedAt:at,completedAt,exitCode:0},promptSha256:'d'.repeat(64),transcriptSha256:'e'.repeat(64),evidenceRef:'synthetic-control',baseCommit:candidate.baseCommit,candidateCommit:candidate.candidateCommit,diffSha256:candidate.diffSha256};
}
/** 原Task服务与真实DB；候选/模型证据是明确声明的测试输入。 */
export async function decisionDomainFixture(repos:RepositorySet,state:'ready'|'running'|'reported'|'decided'='reported') {
  const project=await repos.projects.create({name:'Decision来源'});
  const add=async(name:string)=>{const agent=await repos.agents.create({displayName:`${name}-${project.id}`,hostType:'other'});return repos.members.create({projectId:project.id,agentId:agent.id,kind:'agent',displayName:name,role:name==='manager'?'manager':'normal'});};
  const worker=await add('worker'),reviewer=await add('reviewer'),manager=await add('manager');
  const owner={actor:ownerActor()},workerAccess={actor:actorForMember(worker)},reviewerAccess={actor:actorForMember(reviewer)};
  const service=createTaskService({repos,captureCandidate:async()=>candidate,now:()=>new Date(at)});
  let task=await service.create(owner,project.id,{title:'数据库评审',body:'保留原内容',deliveryKind:'code',acceptanceText:'有意义验证',assigneeMemberId:worker.id,reviewerMemberId:reviewer.id,repoPath:'/fixture',fixedPoint:'base'});
  task=await service.transition(workerAccess,project.id,task.id,{expectedRevision:task.revision,state:'in-progress'});
  const started=await service.startReview(workerAccess,project.id,task.id,{expectedRevision:task.revision});assert.equal(started.ready,true);task=started.task;let round=started.round;
  if(state!=='ready')round=await service.beginReview(reviewerAccess,project.id,task.id,round.id,{expectedTaskRevision:task.revision,expectedRoundRevision:round.revision});
  if(state==='reported'||state==='decided')for(const axis of ['spec','standards'] as const) {
    await service.submitReport(reviewerAccess,project.id,task.id,round.id,{expectedTaskRevision:task.revision,expectedRoundRevision:round.revision,axis,verdict:'pass',body:'原报告',sources:['declared-fixture'],evidence:evidence(axis)});
    round=(await repos.tasks.getRound(project.id,task.id,round.id))!;
  }
  if(state==='decided') {
    // 只播种 v19 历史来源；新生产 resolver 不保留无来源的旧 mutation 分支。
    assert.ok((await repositoryDriver(repos).migrationState()).version<20,'historical decided fixture requires pre-v20 schema');
    for(const verdict of ['pass','changes_requested'] as const)await repos.mutations.run({projectIds:[project.id],
      discover:async()=>({memberIds:[worker.id,reviewer.id,manager.id],groupIds:[],runtimeIds:[]})},async()=>{
      const previous=round.decision,before=task;
      const updated=await repos.tasks.updateCas(project.id,task.id,task.revision,{state:verdict==='pass'?'done':'in-progress',blockedReason:null},at);
      const author={kind:'human' as const,actorId:'human:local',displayName:'历史 fixture'};
      const decision={verdict,actor:author,reason:`历史${verdict}\0\ud800`,override:true,taskRevision:updated.revision};
      const detail={roundId:round.id,previousDecision:previous,decision};
      await repos.tasks.appendHistory({id:randomUUID(),projectId:project.id,taskId:task.id,action:'task.review_decided',actor:author,taskRevision:updated.revision,detail,createdAt:at});
      await appendAuditEntry(repos.audit,{projectId:project.id,actor:{kind:'human',name:'历史 fixture',memberId:null},action:'task.review_decided',targetKind:'task',targetId:task.id,targetName:task.title,detail});
      round=await repos.tasks.updateRoundCas(project.id,round.id,round.revision,{state:'decided',decision},at);
      await repos.tasks.enqueueWorkEvent({id:randomUUID(),projectId:project.id,taskId:task.id,recipientMemberId:worker.id,kind:'task.review_decided',
        eventKey:`historical:${round.id}:${round.revision}`,payload:{taskId:task.id,revision:updated.revision,roundId:round.id,decision,
          enteredDone:before.state!=='done'&&updated.state==='done',completionRevision:updated.revision,assigneeAgentId:worker.agentId},
        deliveryState:'pending',attempts:0,createdAt:at,firstDeliveredAt:null,lastDeliveredAt:null,ackedAt:null});
      task=(await service.get(owner,project.id,task.id)).task;
    });
  }
  return {project,worker,reviewer,manager,owner,workerAccess,reviewerAccess,service,task,round,slot:{projectId:project.id,taskId:task.id,roundId:round.id}};
}

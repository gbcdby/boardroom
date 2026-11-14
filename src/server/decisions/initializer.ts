import { createHash, randomUUID } from 'node:crypto';
import type { DbDriver } from '../db/driver.ts';
import { createRepositories } from '../db/repositories.ts';
import type { Member } from '../db/types.ts';
import { actorForMember } from '../authz/actors.ts';
import { orgActorForMember } from '../authz/org-actors.ts';
import { authorize } from '../authz/authorize.ts';
import { normalizePolicyAction } from '../policy/canonical.ts';
import { assertPolicyConfigurationInitialized, readLockedReviewPolicy } from '../policy/configuration.ts';
import { evaluateDbReviewPolicyV1, type DbReviewHandlerDescriptorV1, type ReviewPolicyActionV1 } from '../policy/db-review.ts';
import { assessTaskMaterials } from '../tasks/materials.ts';
import { submitReviewReportSchema } from '../tasks/schemas.ts';
import { withLockedReviewTransactions } from './locked-transaction.ts';
import { createDecisionRepository } from './repository.ts';
import { planLegacyImport } from './legacy.ts';
import { candidateDigest, encode } from './text-codec.ts';
import type { ReviewSlot, ReviewCandidateEnvelopeV1 } from './types.ts';

export const UNAVAILABLE_DB_REVIEW_HANDLER:DbReviewHandlerDescriptorV1=Object.freeze({handlerId:'s1.review-decide.db/v1',revision:1,kind:'review.decide',available:false,effects:'single-database-transaction',resources:'database-only',delegation:'none',deferredEffects:'none',grantUse:'none'});
interface InitializerOptions {batchSize?:number;now?:()=>Date;handler?:DbReviewHandlerDescriptorV1;
  materialize?:(guard:import('./types.ts').ReviewLockedTransaction,at:string)=>Promise<{created:boolean}>}
interface Diagnostic {projectId:string;taskId:string;roundId:string|null;code:string}
interface LegacyBatch {lastRoundId:string|null;complete:boolean;imported:number;diagnostics:Diagnostic[]}
/** 库内显式调用；A不接启动入口，不注册效果handler，也不修改Task/Round/history/WorkEvent。 */
export async function initializeDecisionStorage(db:DbDriver,options:InitializerOptions={}) {
  const batchSize=options.batchSize??100;if(!Number.isInteger(batchSize)||batchSize<1||batchSize>100)throw new Error('decision_initializer_batch_invalid');
  const repos=createRepositories(db),store=createDecisionRepository(db),now=()=> (options.now?.()??new Date()).toISOString();
  await assertPolicyConfigurationInitialized(repos);
  if(!(await db.migrationState()).applied.some(m=>m.version===20))throw new Error('decision_schema_not_initialized');
  const diagnostics:Diagnostic[]=[];let batches=0,legacyImported=0,pendingCreated=0;
  const projects=await db.query<{id:string;archived_at:string|null}>('SELECT id,archived_at FROM projects ORDER BY id');
  for(const project of projects) {
    const tasks=await db.query<{id:string}>('SELECT id FROM tasks WHERE project_id=? ORDER BY id',[project.id]);
    for(const task of tasks) {
      let afterRoundId:string|null=null;
      for(;;) {
        // One physical project-lock transaction per bounded set of Round slots.
        // Re-read source rows inside each lock; never carry a prior batch's
        // history/projection snapshot into a later transaction.
        const cursor:string|null=afterRoundId,first:boolean=cursor===null;
        const batch:LegacyBatch|null=await repos.mutations.run<LegacyBatch|null>({projectIds:[project.id],discover:async()=>({memberIds:[],groupIds:[],runtimeIds:[]})},async()=>{
          await db.exec("UPDATE policy_documents SET updated_at=updated_at WHERE scope_key='user'");await assertPolicyConfigurationInitialized(repos);
          const rounds=await db.query<{id:string}>(`SELECT * FROM task_review_rounds WHERE project_id=? AND task_id=?${first?'':' AND id>?'} ORDER BY id LIMIT ?`,
            first?[project.id,task.id,batchSize]:[project.id,task.id,cursor,batchSize]);
          if(!first&&!rounds.length)return null;
          const histories=await db.query('SELECT * FROM task_history WHERE project_id=? AND task_id=? ORDER BY task_revision,id',[project.id,task.id]);
          const live=new Set((await db.query<{task_history_id:string|null}>('SELECT task_history_id FROM decision_executions WHERE project_id=? AND task_id=?',[project.id,task.id])).flatMap(r=>r.task_history_id?[r.task_history_id]:[]));
          // Orphan/malformed histories have no Round slot. Diagnose them only
          // in the first batch, using the current complete ID set under lock.
          const known=first?new Set<unknown>((await db.query<{id:string}>('SELECT id FROM task_review_rounds WHERE project_id=? AND task_id=?',[project.id,task.id])).map(r=>r.id)):null;
          const ids=new Set<unknown>(rounds.map(r=>r.id));
          const selected=histories.filter(h=>{try{const roundId=(JSON.parse(h.detail as string) as {roundId?:unknown}).roundId;return ids.has(roundId)||first&&!known!.has(roundId);}catch{return first;}});
          const plan=planLegacyImport({projectId:project.id,taskId:task.id,histories:selected,rounds,at:now(),liveHistoryIds:live});
          let imported=0;const batchDiagnostics:Diagnostic[]=[];
          for(let i=0;i<plan.rows.length;i+=100)imported+=await store.importLegacy(project.id,plan.rows.slice(i,i+100),[]);
          for(let i=0;i<plan.projections.length;i+=100)await store.importLegacy(project.id,[],plan.projections.slice(i,i+100));
          for(const row of plan.rows)if(row.chain_status==='malformed'||row.chain_status==='ambiguous')batchDiagnostics.push({projectId:project.id,taskId:task.id,roundId:row.round_id as string|null,code:`legacy_${row.chain_status}`});
          return {lastRoundId:rounds.at(-1)?.id??null,complete:rounds.length<batchSize,imported,diagnostics:batchDiagnostics};
        });
        if(!batch)break;
        legacyImported+=batch.imported;diagnostics.push(...batch.diagnostics);
        if(batch.complete)break;
        afterRoundId=batch.lastRoundId;
      }
    }
    if(project.archived_at!==null)continue;
    const candidates=await db.query<{task_id:string;round_id:string}>(`SELECT t.id AS task_id,r.id AS round_id FROM tasks t JOIN task_review_rounds r ON r.id=t.current_review_round_id
      WHERE t.project_id=? AND r.project_id=t.project_id AND r.task_id=t.id AND r.state='reported' ORDER BY t.id,r.id`,[project.id]);
    for(let start=0;start<candidates.length;start+=batchSize) {
      const slots:ReviewSlot[]=candidates.slice(start,start+batchSize).map(r=>({projectId:project.id,taskId:r.task_id,roundId:r.round_id}));
      await withLockedReviewTransactions(db,null,slots,async guards=>{
        for(const guard of guards) {
          const slot=guard.slot,diag=(code:string)=>diagnostics.push({...slot,code});
          if((await db.query('SELECT * FROM decision_review_heads WHERE project_id=? AND task_id=? AND round_id=?',[slot.projectId,slot.taskId,slot.roundId])).length)continue;
          const currentProject=await repos.projects.get(slot.projectId);if(!currentProject||currentProject.archivedAt!==null){diag('project_archived');continue;}
          let task,round,reports;
          try {task=await repos.tasks.get(slot.projectId,slot.taskId);round=await repos.tasks.getRound(slot.projectId,slot.taskId,slot.roundId);reports=await repos.tasks.listReports(slot.projectId,slot.taskId,slot.roundId);}
          catch(error){if(error instanceof SyntaxError){diag('source_json_invalid');continue;}throw error;}
          if(!task||!round||task.currentReviewRoundId!==round.id||task.state!=='review'||round.state!=='reported'||round.taskRevision!==task.revision){diag('subject_stale');continue;}
          const assignee=task.assigneeMemberId?await repos.members.get(task.assigneeMemberId):null,reviewer=task.reviewerMemberId?await repos.members.get(task.reviewerMemberId):null;
          const active=(member:Member|null)=>!!member&&member.projectId===slot.projectId&&member.status==='active'&&member.removedAt===null;
          if(!active(reviewer)||reviewer!.kind!=='agent'||reviewer!.id!==round.reviewerMemberId){diag('evaluation_incomplete');continue;}
          if(assessTaskMaterials(task,{assigneeValid:active(assignee),reviewerValid:active(reviewer)&&reviewer!.kind==='agent'}).complete.reasonCodes.length){diag('task_materials_incomplete');continue;}
          const candidate=round.candidate;
          if(!candidate||reports.length!==2||!['spec','standards'].every(axis=>reports.some(r=>r.axis===axis))){diag('review_reports_invalid');continue;}
          let reportsValid=true;
          for(const report of reports) {
            // 公开报告DTO还含id/author等；严格入口只复验原提交字段，不放宽schema。
            const submitted=submitReviewReportSchema.safeParse({expectedTaskRevision:task.revision,expectedRoundRevision:round.revision,axis:report.axis,verdict:report.verdict,body:report.body,sources:report.sources,evidence:report.evidence});
            if(!submitted.success){reportsValid=false;break;}
            const e=report.evidence;
            // Preserve TaskService.verifyEvidence: the successful command covers the review interval.
            if(e.baseCommit!==candidate.baseCommit||e.candidateCommit!==candidate.candidateCommit||e.diffSha256!==candidate.diffSha256||e.command.exitCode!==0||Date.parse(e.startedAt)>=Date.parse(e.completedAt)||Date.parse(e.command.startedAt)>Date.parse(e.startedAt)||Date.parse(e.command.completedAt)<Date.parse(e.completedAt)||Date.parse(e.command.startedAt)>Date.parse(e.command.completedAt))reportsValid=false;
            const digest=createHash('sha256').update(JSON.stringify({axis:report.axis,verdict:report.verdict,body:report.body,sources:report.sources,evidence:report.evidence})).digest('hex');
            if(digest!==report.contentSha256)reportsValid=false;
          }
          const [a,b]=reports;
          if(!reportsValid||!a||!b||a.evidence.parentRunId!==b.evidence.parentRunId||a.evidence.invocationId===b.evidence.invocationId||a.evidence.contextId===b.evidence.contextId||Math.max(Date.parse(a.evidence.startedAt),Date.parse(b.evidence.startedAt))>=Math.min(Date.parse(a.evidence.completedAt),Date.parse(b.evidence.completedAt))){diag('review_reports_invalid');continue;}
          const sorted=[...reports].sort((a,b)=>a.axis<b.axis?-1:1);
          const envelope:ReviewCandidateEnvelopeV1={...slot,task:{title:task.title,body:task.body,labels:[...new Set(task.labels)].sort(),deliveryKind:task.deliveryKind,acceptanceText:task.acceptanceText,acceptanceSource:task.acceptanceSource,assigneeMemberId:task.assigneeMemberId,reviewerMemberId:task.reviewerMemberId,repoPath:task.repoPath,fixedPoint:task.fixedPoint},roundSpecSnapshot:round.specSnapshot,
            candidate:{repositoryRoot:candidate.repositoryRoot,fixedPointInput:candidate.fixedPointInput,baseCommit:candidate.baseCommit,candidateCommit:candidate.candidateCommit,policy:candidate.policy,diffSha256:candidate.diffSha256,commits:candidate.commits},
            reports:sorted.map(r=>({axis:r.axis,id:r.id,contentSha256:r.contentSha256,verdict:r.verdict})) as unknown as ReviewCandidateEnvelopeV1['reports']};
          let encodedEnvelope:string;try{encodedEnvelope=encode('decision_action_requests.candidate_envelope_json',envelope);}catch{diag('candidate_invalid');continue;}
          const hash=candidateDigest(envelope),verdict=reports.every(r=>r.verdict==='pass')?'pass':'changes_requested';
          const normalized=normalizePolicyAction({schemaVersion:1,kind:'review.decide',projectId:slot.projectId,subjectRef:{kind:'review-round',id:slot.roundId},expectedSubjectRevisions:[{subjectRef:{kind:'task',id:slot.taskId},revision:task.revision},{subjectRef:{kind:'review-round',id:slot.roundId},revision:round.revision}],candidateDigest:hash,payload:{choice:verdict}});
          if(options.materialize) {if((await options.materialize(guard,now())).created)pendingCreated++;continue;}
          const cfg=await readLockedReviewPolicy(guard),actor=(await orgActorForMember(repos,reviewer!.id))??actorForMember(reviewer!);
          const read=authorize(actor,'task:view',{projectId:slot.projectId}).allowed,canReview=authorize(actor,'task:review',{projectId:slot.projectId,memberId:reviewer!.id}).allowed;
          const at=now(),policy={policyRevision:cfg.policyRevision,global:{revision:cfg.global.ref.revision,contentDigest:cfg.global.ref.contentDigest},project:cfg.project?{revision:cfg.project.ref.revision,contentDigest:cfg.project.ref.contentDigest}:null,defaultRevision:cfg.defaultRevision};
          const observation=evaluateDbReviewPolicyV1({contractVersion:'s1.db-review-policy/v1',action:normalized.action as ReviewPolicyActionV1,stage:'proposal',policy,documents:{global:cfg.global.document,...(cfg.project?{project:cfg.project.document}:{})},handler:options.handler??UNAVAILABLE_DB_REVIEW_HANDLER,evaluatedAt:at,
            facts:{factsContract:'s1.db-review-locked/v1',authorityBasis:'same-transaction-current-permissions',purpose:'eligibility-observation',principal:{actorId:reviewer!.id,active:true,membershipRevision:reviewer!.membershipRevision,currentMembershipRevision:reviewer!.membershipRevision},project:{projectId:slot.projectId,active:true},subjects:(normalized.action as ReviewPolicyActionV1).expectedSubjectRevisions.map(s=>({...s,active:true,candidateDigest:hash})),proposal:{readAllowed:read,createAllowed:canReview,inScope:read,kindAllowed:true,delegable:false,prohibited:false},execution:{resourceAccess:true,capabilityAllowed:canReview,inScope:canReview,authorizationCurrent:true,hostSupported:true,prohibited:false},authorization:{existingAuthorization:false,grants:[]},budget:{requiredUnits:0,availableUnits:0,mayRequestIncrease:false},retries:{requested:0,available:0,mayRequestIncrease:false},userReserved:false}});
          const required=observation.status==='evaluation_incomplete'||observation.outcome==='deny'?null:observation.requiresFreshHuman?'human':observation.outcome;
          let assigned:string|null=required==='auto'?reviewer!.id:null;
          if(required==='owner') {
            // 锁范围已覆盖管理岗位；按实际组织链选最近有task:override权限的在岗管理者。
            let nodeId=assignee?.nodeId??null;const seen=new Set<string>();
            while(nodeId&&!seen.has(nodeId)&&assigned===null){seen.add(nodeId);const node=(await db.query<{parent_id:string|null}>('SELECT parent_id FROM org_nodes WHERE id=?',[nodeId]))[0];const members=await db.query<{id:string}>('SELECT id FROM members WHERE project_id=? AND node_id=? ORDER BY id',[slot.projectId,nodeId]);
              for(const m of members){const member=await repos.members.get(m.id);if(!active(member))continue;const manager=(await orgActorForMember(repos,m.id))??actorForMember(member!);if(authorize(manager,'task:override',{projectId:slot.projectId,nodeId:assignee?.nodeId??null}).allowed){assigned=m.id;break;}}nodeId=node?.parent_id??null;}
            if(!assigned){const managers=await db.query<{id:string}>("SELECT id FROM members WHERE project_id=? AND role='manager' ORDER BY id",[slot.projectId]);for(const m of managers){const member=await repos.members.get(m.id);if(active(member)&&authorize(actorForMember(member!),'task:override',{projectId:slot.projectId,nodeId:assignee?.nodeId??null}).allowed){assigned=m.id;break;}}}
          }
          const blocked=required===null?(observation.status==='evaluation_incomplete'?'evaluation_incomplete':observation.reasons[0]?.code??'policy_denied'):required==='owner'&&!assigned?'owner_unavailable':null;
          const requestId=randomUUID(),decisionId=randomUUID(),rowSlot={project_id:slot.projectId,task_id:slot.taskId,round_id:slot.roundId};
          await store.write(guard,async writer=>{
            await writer.insert('decision_action_requests',{id:requestId,...rowSlot,action_json:encode('decision_action_requests.action_json',normalized.action),candidate_envelope_json:encodedEnvelope,action_digest:normalized.actionDigest,candidate_digest:hash,expected_task_revision:task.revision,expected_round_revision:round.revision,proposed_verdict:verdict,proposal_reason_json:encode('decision_action_requests.proposal_reason_json','根据两轴评审报告生成待裁决提案'),requested_path:'materializer',origin:'legacy-bootstrap',created_by_kind:'system',created_by_id:'review-materializer',created_at:at});
            await writer.insert('decision_records',{id:decisionId,...rowSlot,action_request_id:requestId,action_digest:normalized.actionDigest,generation:1,revision:1,status:'pending',required_authority:required,assignee_member_id:assigned,blocked_reason_code:blocked,policy_evaluation_json:encode('decision_records.policy_evaluation_json',observation),predecessor_decision_id:null,predecessor_legacy_id:null,created_at:at,updated_at:at});
            await writer.replaceHead({...rowSlot,head_revision:1,current_decision_id:decisionId},null);
            await writer.appendChange({decisionId,decisionRevision:1,kind:'created',at});
          });pendingCreated++;
        }
      });batches++;
    }
  }
  return {complete:true as const,batches,legacyImported,pendingCreated,diagnostics};
}

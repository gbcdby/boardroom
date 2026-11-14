import { createHash } from 'node:crypto';
import type { RepositorySet } from '../db/repositories.ts';
import type { Member } from '../db/types.ts';
import { ArchivedError, NotFoundError } from '../db/errors.ts';
import { actorForMember } from '../authz/actors.ts';
import { orgActorForMember } from '../authz/org-actors.ts';
import { authorize, authorizeOrThrow, ForbiddenError, type Actor } from '../authz/authorize.ts';
import type { DomainAccess } from '../mutation-access.ts';
import type { ReviewRound, ReviewReport, Task, TaskView } from '../../shared/tasks.ts';
import type { ReviewSlot, ReviewCandidateEnvelopeV1, ReviewPolicyActionV1, PolicyRef, ReviewLockedTransaction,
  PolicyObservation, ActorRef, PermissionSnapshotV1 } from './types.ts';
import type { DbReviewHandlerDescriptorV1 } from '../policy/db-review.ts';
import { evaluateDbReviewPolicyV1 } from '../policy/db-review.ts';
import { readLockedReviewPolicy } from '../policy/configuration.ts';
import { normalizePolicyAction } from '../policy/index.ts';
import { assessTaskMaterials } from '../tasks/materials.ts';
import { submitReviewReportSchema } from '../tasks/schemas.ts';
import { assertReviewTransaction } from './locked-transaction.ts';
import { candidateDigest } from './text-codec.ts';
import { DecisionCommandError } from './errors.ts';

export const actorRef = (actor: Actor): ActorRef => ({ kind: actor.kind, id: actor.actorId });
export const activeMember = (member: Member | null, projectId: string): member is Member =>
  !!member && member.projectId === projectId && member.removedAt === null && member.status === 'active';

/** 身份只来自服务端 access；Agent 每次按当前成员/岗位/连接代际重建。 */
export async function decisionActor(repos: RepositorySet, access: DomainAccess, projectId: string, write = false): Promise<Actor> {
  const denied = (reason: string): never => { throw new ForbiddenError({ allowed: false, capability: 'task:view', code: 'out_of_connection', reason }); };
  if (access.connection && (access.connection.projectId !== projectId || access.connection.memberId !== access.actor.actorId)) denied('连接不属于请求项目或成员。');
  if (access.actor.projectId !== null && access.actor.projectId !== projectId) denied('不能访问其他项目的决定。');
  let actor = access.actor;
  if (actor.kind === 'agent') {
    const member = await repos.members.get(actor.actorId);
    if (!activeMember(member, projectId) || member.kind !== 'agent') denied('成员不存在或已离岗。');
    if (access.connection && access.connection.membershipRevision !== member!.membershipRevision) denied('成员代际已变化，请重新加入会话。');
    actor = (await orgActorForMember(repos, member!.id)) ?? actorForMember(member!);
  }
  authorizeOrThrow(actor, 'task:view', { projectId });
  const project = await repos.projects.get(projectId);
  if (!project) throw new NotFoundError('项目不存在。');
  if (write && project.archivedAt !== null) throw new ArchivedError('项目已归档。');
  return actor;
}

export async function decisionTaskView(repos: RepositorySet, task: Task): Promise<TaskView> {
  const assignee = task.assigneeMemberId ? await repos.members.get(task.assigneeMemberId) : null;
  const reviewer = task.reviewerMemberId ? await repos.members.get(task.reviewerMemberId) : null;
  return { ...task, materialStatus: assessTaskMaterials(task, { assigneeValid: activeMember(assignee, task.projectId),
    reviewerValid: activeMember(reviewer, task.projectId) && reviewer.kind === 'agent' }) };
}

export interface CurrentReview {
  task: Task; round: ReviewRound; reports: ReviewReport[]; assignee: Member | null; reviewer: Member | null;
  envelope: ReviewCandidateEnvelopeV1; candidateDigest: string;
}
export async function readCurrentReview(repos: RepositorySet, slot: ReviewSlot): Promise<CurrentReview> {
  const task = await repos.tasks.get(slot.projectId, slot.taskId);
  const round = await repos.tasks.getRound(slot.projectId, slot.taskId, slot.roundId);
  if (!task || !round) throw new NotFoundError('任务或评审轮次不存在。');
  if (task.currentReviewRoundId !== round.id || !['reported', 'decided'].includes(round.state)
    || (round.state === 'decided' ? round.decision?.taskRevision !== task.revision : round.taskRevision !== task.revision || task.state !== 'review')) {
    throw new DecisionCommandError('review_candidate_stale', '任务已离开本评审候选。');
  }
  const assignee = task.assigneeMemberId ? await repos.members.get(task.assigneeMemberId) : null;
  const reviewer = task.reviewerMemberId ? await repos.members.get(task.reviewerMemberId) : null;
  const reports = await repos.tasks.listReports(slot.projectId, slot.taskId, slot.roundId);
  const candidate = round.candidate;
  if (!candidate || reports.length !== 2 || !['spec', 'standards'].every(axis => reports.some(r => r.axis === axis))) {
    throw new DecisionCommandError('review_reports_required', '固定候选及两份独立轴报告尚未齐备。');
  }
  for (const report of reports) {
    const parsed = submitReviewReportSchema.safeParse({ expectedTaskRevision: task.revision, expectedRoundRevision: round.revision,
      axis: report.axis, verdict: report.verdict, body: report.body, sources: report.sources, evidence: report.evidence });
    const e = report.evidence;
    const digest = createHash('sha256').update(JSON.stringify({ axis: report.axis, verdict: report.verdict, body: report.body,
      sources: report.sources, evidence: e })).digest('hex');
    if (!parsed.success || digest !== report.contentSha256 || e.baseCommit !== candidate.baseCommit || e.candidateCommit !== candidate.candidateCommit
      || e.diffSha256 !== candidate.diffSha256 || e.command.exitCode !== 0 || Date.parse(e.startedAt) >= Date.parse(e.completedAt)
      || Date.parse(e.command.startedAt) > Date.parse(e.startedAt) || Date.parse(e.command.completedAt) < Date.parse(e.completedAt)
      || Date.parse(e.command.startedAt) > Date.parse(e.command.completedAt)) throw new DecisionCommandError('review_reports_required', '评审报告与固定候选或声明时间不一致。');
  }
  const [first, second] = reports;
  if (first!.evidence.parentRunId !== second!.evidence.parentRunId || first!.evidence.invocationId === second!.evidence.invocationId
    || first!.evidence.contextId === second!.evidence.contextId
    || Math.max(Date.parse(first!.evidence.startedAt), Date.parse(second!.evidence.startedAt)) >= Math.min(Date.parse(first!.evidence.completedAt), Date.parse(second!.evidence.completedAt))) {
    throw new DecisionCommandError('review_reports_required', '两份报告缺少同候选的独立并行上下文。');
  }
  const envelope: ReviewCandidateEnvelopeV1 = { projectId: slot.projectId, taskId: slot.taskId, roundId: slot.roundId,
    task: { title: task.title, body: task.body, labels: [...new Set(task.labels)].sort(),
    deliveryKind: task.deliveryKind, acceptanceText: task.acceptanceText, acceptanceSource: task.acceptanceSource,
    assigneeMemberId: task.assigneeMemberId, reviewerMemberId: task.reviewerMemberId, repoPath: task.repoPath, fixedPoint: task.fixedPoint },
    roundSpecSnapshot: round.specSnapshot,
    candidate: { repositoryRoot: candidate.repositoryRoot, fixedPointInput: candidate.fixedPointInput, baseCommit: candidate.baseCommit,
      candidateCommit: candidate.candidateCommit, policy: candidate.policy, diffSha256: candidate.diffSha256, commits: candidate.commits },
    reports: [...reports].sort((a, b) => a.axis < b.axis ? -1 : 1).map(r => ({ axis: r.axis, id: r.id, contentSha256: r.contentSha256, verdict: r.verdict })) as unknown as ReviewCandidateEnvelopeV1['reports'] };
  return { task, round, reports, assignee, reviewer, envelope, candidateDigest: candidateDigest(envelope) };
}

export function reviewAction(subject: CurrentReview, verdict: 'pass' | 'changes_requested') {
  return normalizePolicyAction({ schemaVersion: 1, kind: 'review.decide', projectId: subject.task.projectId,
    subjectRef: { kind: 'review-round', id: subject.round.id }, expectedSubjectRevisions: [
      { subjectRef: { kind: 'task', id: subject.task.id }, revision: subject.task.revision },
      { subjectRef: { kind: 'review-round', id: subject.round.id }, revision: subject.round.revision }],
    candidateDigest: subject.candidateDigest, payload: { choice: verdict } });
}

export function assertReviewPath(actor: Actor, subject: CurrentReview, path: 'reviewer' | 'management', verdict: 'pass' | 'changes_requested'): void {
  const { task, round, reviewer, assignee } = subject;
  if (path === 'management') authorizeOrThrow(actor, 'task:override', { projectId: task.projectId, nodeId: assignee?.nodeId ?? null });
  else {
    if (!activeMember(reviewer, task.projectId) || reviewer.kind !== 'agent' || actor.kind !== 'agent'
      || actor.actorId !== task.reviewerMemberId || actor.actorId !== round.reviewerMemberId || round.state === 'decided') {
      throw new DecisionCommandError('forbidden', '只有当前指定评审人可执行普通评审。', 403);
    }
    authorizeOrThrow(actor, 'task:review', { projectId: task.projectId, memberId: reviewer.id });
    if (verdict === 'pass' && subject.reports.some(r => r.verdict !== 'pass')) throw new DecisionCommandError('review_axis_rejected', '仍有评审轴要求修改，不能普通通过。');
  }
  const status = assessTaskMaterials(task, { assigneeValid: activeMember(assignee, task.projectId),
    reviewerValid: activeMember(reviewer, task.projectId) && reviewer.kind === 'agent' });
  if (status[verdict === 'pass' ? 'complete' : 'startExecution'].reasonCodes.length) {
    throw new DecisionCommandError('task_materials_incomplete', '任务资料未满足该评审动作要求。');
  }
}

export async function observeReviewPolicy(guard: ReviewLockedTransaction, subject: CurrentReview, actor: Actor,
  path: 'reviewer' | 'management', action: ReviewPolicyActionV1, handler: DbReviewHandlerDescriptorV1,
  purpose: 'eligibility-observation' | 'resolver-check', stage: 'proposal' | 'execution', at: string): Promise<PolicyObservation> {
  const { repos } = assertReviewTransaction(guard);
  let permitted = true;
  try { assertReviewPath(actor, subject, path, action.payload.choice); }
  catch (error) { if (error instanceof ForbiddenError || error instanceof DecisionCommandError) permitted = false; else throw error; }
  const member = actor.kind === 'agent' ? await repos.members.get(actor.actorId) : null;
  const cfg = await readLockedReviewPolicy(guard);
  const policy: PolicyRef = { policyRevision: cfg.policyRevision, global: { revision: cfg.global.ref.revision, contentDigest: cfg.global.ref.contentDigest },
    project: cfg.project ? { revision: cfg.project.ref.revision, contentDigest: cfg.project.ref.contentDigest } : null, defaultRevision: cfg.defaultRevision };
  const project = await repos.projects.get(subject.task.projectId);
  return evaluateDbReviewPolicyV1({ contractVersion: 's1.db-review-policy/v1', action, stage, policy,
    documents: { global: cfg.global.document, ...(cfg.project ? { project: cfg.project.document } : {}) }, handler, evaluatedAt: at,
    facts: { factsContract: 's1.db-review-locked/v1', authorityBasis: 'same-transaction-current-permissions', purpose,
      principal: { actorId: actor.actorId, active: actor.kind === 'human' || activeMember(member, subject.task.projectId),
        membershipRevision: member?.membershipRevision ?? null, currentMembershipRevision: member?.membershipRevision ?? null },
      project: { projectId: subject.task.projectId, active: !!project && project.archivedAt === null },
      subjects: action.expectedSubjectRevisions.map(s => ({ ...s, active: true, candidateDigest: subject.candidateDigest })),
      proposal: { readAllowed: authorize(actor, 'task:view', { projectId: subject.task.projectId }).allowed,
        createAllowed: permitted, inScope: permitted, kindAllowed: handler.kind === action.kind,
        delegable: handler.available && permitted, prohibited: false },
      execution: { resourceAccess: permitted, capabilityAllowed: permitted, inScope: permitted,
        authorizationCurrent: permitted, hostSupported: handler.available, prohibited: false },
      authorization: { existingAuthorization: permitted, grants: [] },
      budget: { requiredUnits: 0, availableUnits: 0, mayRequestIncrease: false }, retries: { requested: 0, available: 0, mayRequestIncrease: false }, userReserved: false } });
}

export async function routeReviewOwner(repos: RepositorySet, subject: CurrentReview): Promise<string | null> {
  const projectId = subject.task.projectId, nodes = await repos.org.listNodes(projectId), members = await repos.members.listByProject(projectId);
  const byNode = new Map(nodes.map(n => [n.id, n]));
  let parent = subject.assignee?.nodeId ? byNode.get(subject.assignee.nodeId)?.parentId ?? null : null;
  const seen = new Set<string>();
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const node = byNode.get(parent);
    if (!node) break;
    for (const member of members.filter(m => m.nodeId === parent && m.id !== subject.task.assigneeMemberId)) {
      if (activeMember(member, projectId) && member.kind === 'agent') {
        const actor = (await orgActorForMember(repos, member.id)) ?? actorForMember(member);
        if (authorize(actor, 'task:override', { projectId, nodeId: subject.assignee?.nodeId ?? null }).allowed) return member.id;
      }
    }
    parent = node.parentId;
  }
  if (!await repos.org.getRootNode(projectId)) {
    const manager = await repos.members.getManager(projectId);
    if (activeMember(manager, projectId) && manager.id !== subject.task.assigneeMemberId
      && authorize(actorForMember(manager), 'task:override', { projectId }).allowed) return manager.id;
  }
  return null;
}

export async function reviewOwnerAvailable(repos: RepositorySet, subject: CurrentReview, id: string | null): Promise<boolean> {
  if (!id || id === subject.task.assigneeMemberId) return false;
  const member = await repos.members.get(id);
  if (!activeMember(member, subject.task.projectId) || member.kind !== 'agent') return false;
  const actor = (await orgActorForMember(repos, member.id)) ?? actorForMember(member);
  return authorize(actor, 'task:override', { projectId: subject.task.projectId, nodeId: subject.assignee?.nodeId ?? null }).allowed;
}

export async function permissionSnapshot(repos: RepositorySet, subject: CurrentReview, actor: Actor,
  path: 'reviewer' | 'management', at: string, noEffect = false): Promise<PermissionSnapshotV1> {
  const member = actor.kind === 'agent' ? await repos.members.get(actor.actorId) : null;
  const capability = path === 'management' ? 'task:override' : 'task:review';
  const allowed = authorize(actor, capability, {projectId:subject.task.projectId,
    ...(path==='management'?{nodeId:subject.assignee?.nodeId??null}:{memberId:subject.reviewer?.id??''})}).allowed;
  return { schemaVersion: 'db-review-permissions/v1', projectId: subject.task.projectId, taskId: subject.task.id, roundId: subject.round.id,
    actor: actorRef(actor), active: actor.kind === 'human' || activeMember(member, subject.task.projectId),
    membershipRevision: member?.membershipRevision ?? null, currentMembershipRevision: member?.membershipRevision ?? null,
    projectActive: (await repos.projects.get(subject.task.projectId))?.archivedAt === null,
    readAllowed: authorize(actor, 'task:view', { projectId: subject.task.projectId }).allowed,
    capability, capabilityAllowed: allowed, inScope: allowed,
    actualPath: noEffect ? 'no-effect' : path, checkedAt: at };
}

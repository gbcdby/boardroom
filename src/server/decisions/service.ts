import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DbDriver, DbReadSnapshot } from '../db/driver.ts';
import { createRepositories } from '../db/repositories.ts';
import { InvalidArgumentError, NotFoundError } from '../db/errors.ts';
import { authorize, type Actor } from '../authz/authorize.ts';
import { actorForMember } from '../authz/actors.ts';
import { appendAuditEntry, auditActorFrom } from '../audit.ts';
import { discoverDomainMutation, type DomainAccess } from '../mutation-access.ts';
import type { MutationDiscover } from '../db/mutation-scope.ts';
import { notifyResourceChange } from '../resource-changes.ts';
import { notifyWorkEventCommit } from '../tasks/events.ts';
import type { DecideReviewInput } from '../../shared/tasks.ts';
import { decideTaskReviewSchema, parseTaskInput } from '../tasks/schemas.ts';
import type { DbReviewHandlerDescriptorV1 } from '../policy/db-review.ts';
import { canonicalJson } from '../policy/canonical.ts';
import { createDecisionRepository, readDecisionProjectGraph, type DecisionWriter } from './repository.ts';
import type { StorageRow } from './storage-validation.ts';
import { storageInteger } from './row-validation.ts';
import { withLockedReviewTransaction, assertReviewTransaction } from './locked-transaction.ts';
import { encode, commandDigest, permissionDigest } from './text-codec.ts';
import { actionOf, currentPolicyRef, headRef, legacyView, observationOf, presentDecision, recordRef, responseOf } from './read-model.ts';
import { activeMember, actorRef, assertReviewPath, decisionActor, decisionTaskView, observeReviewPolicy, permissionSnapshot,
  readCurrentReview, reviewAction, routeReviewOwner, type CurrentReview } from './review-state.ts';
import { applyReviewEffect, currentReviewEffect, DB_REVIEW_HANDLER } from './effect.ts';
import { DecisionCommandError } from './errors.ts';
import { assertTrustedLocalRequest, type TrustedLocalDecisionRequest } from './trusted-local.ts';
import { parseDecisionInput, requestReviewDecisionSchema, resolveDecisionSchema, chooseLocalDecisionSchema,
  refreshDecisionSchema, listDecisionsSchema } from './schemas.ts';
import type { CanonicalDecisionCommandV1, ChooseLocalUiDecisionInput, DbReviewExecution, DecisionChange,
  DecisionChoice, DecisionCommandResult, DecisionRef, DecisionStoredResponseV1, DecisionView, LiveDecisionView,
  PolicyObservation, RefreshDecisionInput, RequestReviewDecisionInput, RequiredAuthority, ResolveAgentDecisionInput,
  ReviewHeadRef, ReviewLockedTransaction, ReviewPolicyActionV1, ReviewSlot } from './types.ts';

interface DecisionAccess extends DomainAccess {
  readonly runMutation?: <T>(operation: 'write' | 'consume', body: () => Promise<T>, discover?: MutationDiscover) => Promise<T>;
}
export interface DecisionService {
  list(access: DecisionAccess, projectId: string, filter?: { taskId?: string; status?: string }): Promise<{ decisions: DecisionView[]; cursor: number }>;
  get(access: DecisionAccess, projectId: string, id: string): Promise<DecisionView>;
  changes(access: DecisionAccess, projectId: string, afterRevision: number): Promise<{ changes: DecisionChange[]; cursor: number }>;
  request(access: DecisionAccess, slot: ReviewSlot, input: Omit<RequestReviewDecisionInput, 'expectedHead'> & { expectedHead?: ReviewHeadRef | undefined }): Promise<DecisionCommandResult>;
  resolve(access: DecisionAccess, projectId: string, id: string, input: ResolveAgentDecisionInput): Promise<DecisionCommandResult>;
  chooseLocal(access: DecisionAccess, projectId: string, id: string, input: ChooseLocalUiDecisionInput, proof: TrustedLocalDecisionRequest): Promise<DecisionCommandResult>;
  refresh(access: DecisionAccess, projectId: string, id: string, input: RefreshDecisionInput): Promise<DecisionCommandResult>;
  requestAndMaybeResolveReview(access: DecisionAccess, slot: ReviewSlot, input: DecideReviewInput, proof?: TrustedLocalDecisionRequest): Promise<DecisionCommandResult>;
}
type Replay = DecisionCommandResult['replay'];
type Saved = { response: DecisionStoredResponseV1; replay: Replay };
type CommandContext = { guard: ReviewLockedTransaction; actor: Actor; command: CanonicalDecisionCommandV1; key: string; at: string };
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const rowSlot = (s: ReviewSlot) => ({ project_id: s.projectId, task_id: s.taskId, round_id: s.roundId });

/** The only production review command owner. Every effect consumes a freshly
 * checked private guard, on the same physical transaction as its receipt. */
export function createDecisionService(db: DbDriver, options: { now?: () => Date; handler?: DbReviewHandlerDescriptorV1 } = {}): DecisionService {
  const repos = createRepositories(db), store = createDecisionRepository(db), handler = options.handler ?? DB_REVIEW_HANDLER;
  const now = () => (options.now?.() ?? new Date()).toISOString();
  const snapshot = <T>(body: (read: DbReadSnapshot) => Promise<T>) => db.currentTransactionContext() ? body(db) : db.readSnapshot(body);

  async function show(access: DecisionAccess, projectId: string, id: string): Promise<DecisionView> {
    return snapshot(async read => {
      const actor = await decisionActor(repos, access, projectId);
      const graph = await readDecisionProjectGraph(read, projectId);
      const row = graph.decision_records!.find(r => r.id === id);
      if (row) return presentDecision(repos, graph, actor, await currentPolicyRef(read, projectId), row);
      const legacy = graph.decision_legacy_records!.find(r => r.id === id);
      if (legacy) return legacyView(legacy);
      throw new NotFoundError('决策不存在或不属于当前项目。');
    });
  }
  async function finish(access: DecisionAccess, saved: Saved): Promise<DecisionCommandResult> {
    const current = await show(access, saved.response.decisionRef.projectId, saved.response.decisionRef.decisionId);
    if (current.recordKind !== 'live-review-decision') throw new DecisionCommandError('decision_storage_invalid', '回执指向的决策类型错误。', 500);
    return { ...saved.response, replay: saved.replay, current };
  }
  async function slotFor(access: DecisionAccess, projectId: string, id: string): Promise<ReviewSlot> {
    return snapshot(async read => {
      await decisionActor(repos, access, projectId);
      const row = (await read.query('SELECT task_id,round_id FROM decision_records WHERE project_id=? AND id=?', [projectId, id]))[0];
      if (!row) {
        if ((await read.query('SELECT id FROM decision_legacy_records WHERE project_id=? AND id=?', [projectId, id])).length)
          throw new DecisionCommandError('legacy_fact_not_resolvable', '历史评审事实不能重新裁决。');
        throw new NotFoundError('决策不存在或不属于当前项目。');
      }
      return { projectId, taskId: String(row.task_id), roundId: String(row.round_id) };
    });
  }
  async function command(access: DecisionAccess, slot: ReviewSlot, key: string,
    build: (actor: Actor) => CanonicalDecisionCommandV1, body: (ctx: CommandContext) => Promise<Saved>): Promise<DecisionCommandResult> {
    // Preserve not-found/domain errors before the opaque guard is issued.
    await decisionActor(repos, access, slot.projectId);
    if (!await repos.tasks.get(slot.projectId, slot.taskId) || !await repos.tasks.getRound(slot.projectId, slot.taskId, slot.roundId))
      throw new NotFoundError('任务或评审轮次不存在。');
    const work = () => withLockedReviewTransaction(db, access, slot, async guard => {
      const actor = await decisionActor(repos, access, slot.projectId), normalized = build(actor), digest = commandDigest(normalized);
      const old = await repos.context.one('SELECT * FROM decision_command_receipts WHERE project_id=? AND actor_kind=? AND actor_id=? AND operation=? AND idempotency_key=?',
        [slot.projectId, actor.kind, actor.actorId, normalized.operation, key]);
      if (old) {
        if (old.request_digest !== digest) throw new DecisionCommandError('idempotency_conflict', '同一请求键已用于不同命令。');
        // Current read authorization precedes every immutable historical replay.
        await store.readProject(slot.projectId);
        return { response: responseOf(old), replay: 'same-key' as const };
      }
      await decisionActor(repos, access, slot.projectId, true);
      return body({ guard, actor, command: normalized, key, at: now() });
    });
    const discover = discoverDomainMutation(access, slot.projectId, { taskId: slot.taskId, roundId: slot.roundId, escalation: true });
    const result = await (access.runMutation ? access.runMutation('write', work, discover) : work());
    return finish(access, result);
  }
  async function head(slot: ReviewSlot): Promise<StorageRow | undefined> {
    return repos.context.one('SELECT * FROM decision_review_heads WHERE project_id=? AND task_id=? AND round_id=?', [slot.projectId, slot.taskId, slot.roundId]);
  }
  async function row(id: string, projectId: string): Promise<StorageRow> {
    const found = await repos.context.one('SELECT * FROM decision_records WHERE project_id=? AND id=?', [projectId, id]);
    if (!found) throw new NotFoundError('决策不存在。');
    return found;
  }
  function conflict(record: StorageRow, currentHead: StorageRow, reason: 'decision_terminal' | 'decision_revision_conflict' | 'head_revision_conflict'): never {
    throw new DecisionCommandError(reason, reason === 'decision_terminal' ? '该提案已终结，请阅读当前决定或明确提出后继。' : '决策或当前提案版本已变化。', 409,
      { currentRef: recordRef(record), head: headRef(currentHead) });
  }
  function pathFor(actor: Actor, subject: CurrentReview): 'reviewer' | 'management' {
    return actor.kind === 'human' || authorize(actor, 'task:override', { projectId: subject.task.projectId, nodeId: subject.assignee?.nodeId ?? null }).allowed
      ? 'management' : 'reviewer';
  }
  function expectCandidate(subject: CurrentReview, input: { expectedTaskRevision: number; expectedRoundRevision: number }): void {
    if (subject.task.revision !== input.expectedTaskRevision || subject.round.revision !== input.expectedRoundRevision)
      throw new DecisionCommandError('candidate_changed', 'Task 或评审轮次版本已变化，请读取当前候选。');
  }
  async function evaluationFields(subject: CurrentReview, evaluation: PolicyObservation) {
    const required: RequiredAuthority | null = evaluation.status === 'evaluation_incomplete' || evaluation.outcome === 'deny' ? null
      : evaluation.requiresFreshHuman ? 'human' : evaluation.outcome;
    const assignee = required === 'auto' ? subject.reviewer!.id : required === 'owner' ? await routeReviewOwner(repos, subject) : null;
    const blocked = required === null ? evaluation.status === 'evaluation_incomplete' ? 'evaluation_incomplete' : evaluation.reasons[0]?.code ?? 'policy_denied'
      : required === 'owner' && !assignee ? 'assignee_unavailable' : null;
    return { required, assignee, blocked };
  }
  async function changed(ctx: CommandContext, writer: DecisionWriter, record: StorageRow, kind: DecisionChange['kind']): Promise<void> {
    await writer.appendChange({ decisionId: String(record.id), decisionRevision: Number(record.revision), kind, at: ctx.at });
    await appendAuditEntry(repos.audit, { projectId: ctx.command.projectId, actor: auditActorFrom(ctx.actor), action: `decision.${kind === 'created' ? 'requested' : kind}`,
      targetKind: 'decision', targetId: String(record.id), targetName: ctx.command.taskId,
      detail: { taskId: ctx.command.taskId, roundId: ctx.command.roundId, decisionId: record.id, decisionRevision: record.revision,
        requiredAuthority: record.required_authority, blockedReason: record.blocked_reason_code } }, { createdAt: ctx.at });
    await notifyResourceChange(db, { projectId: ctx.command.projectId, entity: 'decision', id: String(record.id), revision: Number(record.revision) });
  }
  async function saveReceipt(ctx: CommandContext, writer: DecisionWriter, record: StorageRow, currentHead: StorageRow,
    state: DecisionStoredResponseV1['state'], inputRef: DecisionRef | null, extra: { receiptId?: string; resolutionId?: string; initiationId?: string; execution?: DbReviewExecution } = {}): Promise<Saved> {
    const ref = recordRef(record), pinnedHead = headRef(currentHead), receiptId = extra.receiptId ?? randomUUID();
    const task = await repos.tasks.get(ctx.command.projectId, ctx.command.taskId);
    if (!task) throw new NotFoundError('任务不存在。');
    const response: DecisionStoredResponseV1 = { schemaVersion: 'decision-response/v1', state, reason: state === 'refreshed' ? 'policy_changed' : null,
      task: await decisionTaskView(repos, task), decisionRef: ref, head: pinnedHead, requiredAuthority: record.required_authority as RequiredAuthority | null,
      blockedReason: record.blocked_reason_code as string | null,
      receipt: { receiptId, operation: ctx.command.operation, actor: actorRef(ctx.actor), requestDigest: commandDigest(ctx.command), inputDecisionRef: inputRef,
        resultDecisionRef: ref, head: pinnedHead, result: state, httpStatus: state === 'pending' ? 202 : state === 'refreshed' ? 409 : 200,
        command: ctx.command, resolutionId: extra.resolutionId ?? null, execution: extra.execution ?? null, committedAt: ctx.at } };
    await writer.insert('decision_command_receipts', { id: receiptId, ...rowSlot(ctx.command), actor_kind: ctx.actor.kind, actor_id: ctx.actor.actorId,
      operation: ctx.command.operation, idempotency_key: ctx.key, request_digest: response.receipt.requestDigest,
      input_decision_id: inputRef?.decisionId ?? null, input_decision_revision: inputRef?.revision ?? null,
      result_decision_id: ref.decisionId, result_decision_revision: ref.revision, result_action_digest: ref.actionDigest,
      head_revision: pinnedHead.headRevision, result_state: state, http_status: response.receipt.httpStatus,
      resolution_id: extra.resolutionId ?? null, initiation_id: extra.initiationId ?? null,
      response_json: encode('decision_command_receipts.response_json', response), committed_at: ctx.at });
    return { response, replay: 'none' };
  }
  async function proposal(ctx: CommandContext, subject: CurrentReview, input: Omit<RequestReviewDecisionInput, 'idempotencyKey'>): Promise<{ record: StorageRow; head: StorageRow }> {
    expectCandidate(subject, input); assertReviewPath(ctx.actor, subject, input.requestedPath, input.proposedVerdict);
    const normalized = reviewAction(subject, input.proposedVerdict), oldHead = await head(ctx.command);
    const previous = oldHead ? await row(String(oldHead.current_decision_id), ctx.command.projectId) : undefined;
    if (input.expectedHead && (!oldHead || !same(input.expectedHead, headRef(oldHead)))) {
      if (oldHead && previous) conflict(previous, oldHead, 'head_revision_conflict');
      throw new DecisionCommandError('head_revision_conflict', '当前 slot 尚无该 head。');
    }
    if (previous?.status === 'pending' && previous.action_digest === normalized.actionDigest)
      return { record: previous, head: oldHead! };
    if (previous && !input.expectedHead) {
      if (previous.status !== 'pending') conflict(previous, oldHead!, 'decision_terminal');
      conflict(previous, oldHead!, 'head_revision_conflict');
    }
    const evaluation = await observeReviewPolicy(ctx.guard, subject, ctx.actor, input.requestedPath, normalized.action as ReviewPolicyActionV1,
      handler, 'eligibility-observation', 'proposal', ctx.at);
    const fields = await evaluationFields(subject, evaluation), id = randomUUID(), requestId = randomUUID();
    const generation = oldHead ? Number(oldHead.head_revision) + 1 : 1;
    const projection = !oldHead ? await repos.context.one("SELECT legacy_id FROM decision_review_projections WHERE project_id=? AND task_id=? AND round_id=? AND source_kind='legacy'",
      [ctx.command.projectId, ctx.command.taskId, ctx.command.roundId]) : undefined;
    const record = { id, ...rowSlot(ctx.command), action_request_id: requestId, action_digest: normalized.actionDigest, generation, revision: 1,
      status: 'pending', required_authority: fields.required, assignee_member_id: fields.assignee, blocked_reason_code: fields.blocked,
      policy_evaluation_json: encode('decision_records.policy_evaluation_json', evaluation), predecessor_decision_id: previous?.id ?? null,
      predecessor_legacy_id: projection?.legacy_id ?? null, created_at: ctx.at, updated_at: ctx.at };
    const nextHead = { ...rowSlot(ctx.command), head_revision: generation, current_decision_id: id };
    await store.write(ctx.guard, async writer => {
      if (previous?.status === 'pending') {
        await writer.terminate(String(previous.id), Number(previous.revision), 'superseded', ctx.at);
        await changed(ctx, writer, { ...previous, status: 'superseded', revision: Number(previous.revision) + 1 }, 'superseded');
      }
      await writer.insert('decision_action_requests', { id: requestId, ...rowSlot(ctx.command), action_json: encode('decision_action_requests.action_json', normalized.action),
        candidate_envelope_json: encode('decision_action_requests.candidate_envelope_json', subject.envelope), action_digest: normalized.actionDigest,
        candidate_digest: subject.candidateDigest, expected_task_revision: subject.task.revision, expected_round_revision: subject.round.revision,
        proposed_verdict: input.proposedVerdict, proposal_reason_json: encode('decision_action_requests.proposal_reason_json', input.reason),
        requested_path: input.requestedPath, origin: ctx.actor.kind === 'human' ? 'user-request' : 'agent-request',
        created_by_kind: ctx.actor.kind, created_by_id: ctx.actor.actorId, created_at: ctx.at });
      await writer.insert('decision_records', record); await writer.replaceHead(nextHead, oldHead ? Number(oldHead.head_revision) : null);
      await changed(ctx, writer, record, 'created');
      if (fields.assignee) {
        const event = await repos.tasks.enqueueWorkEvent({ id: randomUUID(), projectId: ctx.command.projectId, taskId: ctx.command.taskId,
          recipientMemberId: fields.assignee, kind: 'decision.requested', eventKey: `decision:${id}:1:${fields.assignee}:requested`,
          payload: { taskId: ctx.command.taskId, decisionId: id, decisionRevision: 1 }, deliveryState: 'pending', attempts: 0,
          createdAt: ctx.at, firstDeliveredAt: null, lastDeliveredAt: null, ackedAt: null });
        await notifyWorkEventCommit(db, [event]);
      }
    });
    return { record, head: nextHead };
  }
  async function refreshRecord(ctx: CommandContext, record: StorageRow, currentHead: StorageRow, subject: CurrentReview,
    evaluation: PolicyObservation, inputRef: DecisionRef | null): Promise<Saved> {
    const fields = await evaluationFields(subject, evaluation);
    const next = { ...record, revision: Number(record.revision) + 1, required_authority: fields.required, assignee_member_id: fields.assignee,
      blocked_reason_code: fields.blocked, policy_evaluation_json: encode('decision_records.policy_evaluation_json', evaluation), updated_at: ctx.at };
    return store.write(ctx.guard, async writer => {
      await writer.updatePending(String(record.id), Number(record.revision), { status: 'pending', requiredAuthority: fields.required,
        assigneeMemberId: fields.assignee, blockedReason: fields.blocked, policyEvaluation: next.policy_evaluation_json, at: ctx.at });
      await changed(ctx, writer, next, 'refreshed');
      return saveReceipt(ctx, writer, next, currentHead, 'refreshed', inputRef);
    });
  }
  async function choose(ctx: CommandContext, record: StorageRow, currentHead: StorageRow, inputRef: DecisionRef, choice: DecisionChoice,
    reason: string, proof?: TrustedLocalDecisionRequest, explicitRefresh = false, legacyPath?: 'reviewer' | 'management'): Promise<Saved> {
    if (currentHead.current_decision_id !== record.id) conflict(record, currentHead, 'decision_terminal');
    if (record.status !== 'pending') {
      // A new key can only observe the original exact terminal choice. It cannot
      // amend its reason, actor, provenance or introduce another receipt/effect.
      if (!explicitRefresh && same(inputRef, { ...recordRef(record), revision: Number(record.revision) - 1 })) {
        const resolution = await repos.context.one('SELECT * FROM decision_resolutions WHERE project_id=? AND decision_id=?', [ctx.command.projectId, record.id]);
        if (resolution?.choice_id === choice) {
          const receipt = await repos.context.one('SELECT * FROM decision_command_receipts WHERE id=?', [resolution.command_receipt_id]);
          if (receipt) return { response: responseOf(receipt), replay: 'equivalent' };
        }
      }
      conflict(record, currentHead, 'decision_terminal');
    }
    if (!same(inputRef, recordRef(record))) conflict(record, currentHead, 'decision_revision_conflict');
    const subject = await readCurrentReview(repos, ctx.command);
    const actionRow = await repos.context.one('SELECT * FROM decision_action_requests WHERE project_id=? AND id=?', [ctx.command.projectId, record.action_request_id]);
    if (!actionRow) throw new DecisionCommandError('decision_storage_invalid', '决策缺少原始提案。', 500);
    const action = actionOf(actionRow).action, path = legacyPath ?? pathFor(ctx.actor, subject);
    if (reviewAction(subject, action.payload.choice).actionDigest !== record.action_digest)
      throw new DecisionCommandError('candidate_changed', '当前 Task、Round 或两轴报告已不再匹配提案。', 409, { currentRef: recordRef(record), head: headRef(currentHead) });
    assertReviewPath(ctx.actor, subject, path, action.payload.choice);
    const evaluation = await observeReviewPolicy(ctx.guard, subject, ctx.actor, path, action, handler,
      explicitRefresh ? 'eligibility-observation' : 'resolver-check', explicitRefresh ? 'proposal' : 'execution', ctx.at);
    if (explicitRefresh || !same(observationOf(record).policy, evaluation.policy)) return refreshRecord(ctx, record, currentHead, subject, evaluation, inputRef);
    const fields = await evaluationFields(subject, evaluation), legacy = ctx.command.operation === 'legacy-decide';
    if (fields.required === null || ctx.actor.kind === 'agent' && (fields.required === 'human' || fields.required === 'owner' && path !== 'management')) {
      if (legacy) return store.write(ctx.guard, writer => saveReceipt(ctx, writer, record, currentHead, 'pending', inputRef));
      if (fields.required === 'human') throw new DecisionCommandError('human_intent_required', '此选择须由当前可信本地 UI 人工确认。');
      if (evaluation.status === 'evaluation_incomplete') throw new DecisionCommandError('evaluation_incomplete', '当前评估缺少必需事实。', 409, { missingFacts: evaluation.missingFacts });
      if (evaluation.reasons.some(r => r.code === 'handler_unavailable')) throw new DecisionCommandError('handler_unavailable', '本数据库动作处理器不可用。');
      if (fields.required === 'owner' && !fields.assignee) throw new DecisionCommandError('assignee_unavailable', '当前没有有效的负责人路由。');
      throw new DecisionCommandError('forbidden', '当前权限或策略不允许处理此选择。', 403);
    }
    if (ctx.actor.kind === 'human') assertTrustedLocalRequest(proof, ctx.actor);
    const authority: RequiredAuthority = ctx.actor.kind === 'human' ? 'human' : fields.required!;
    const receiptId = randomUUID(), resolutionId = randomUUID(), executionId = randomUUID();
    const resultRef = { ...inputRef, revision: inputRef.revision + 1 }, digest = commandDigest(ctx.command);
    const permissions = await permissionSnapshot(repos, subject, ctx.actor, path, ctx.at, choice !== 'approve');
    return store.write(ctx.guard, async writer => {
      let initiationId: string | undefined;
      const binding = { ...rowSlot(ctx.command), decision_id: record.id, input_decision_revision: inputRef.revision, action_digest: inputRef.actionDigest,
        choice_id: choice, actor_kind: ctx.actor.kind, actor_id: ctx.actor.actorId, request_digest: digest };
      if (ctx.actor.kind === 'human') {
        assertReviewTransaction(ctx.guard); assertTrustedLocalRequest(proof, ctx.actor);
        const userEventId = randomUUID(), nonce = randomBytes(32), nonceHash = createHash('sha256').update(nonce).digest('hex');
        initiationId = randomUUID();
        const commandKind = legacy ? 'legacy-decide' : 'ui-decision-choice';
        await writer.insert('decision_user_events', { id: userEventId, ...binding, command_kind: commandKind, client_mutation_id: ctx.key,
          command_json: encode('decision_user_events.command_json', { kind: commandKind, command: ctx.command, clientMutationId: ctx.key }), issued_at: ctx.at });
        await writer.insert('decision_local_initiations', { id: initiationId, ...binding, user_event_id: userEventId, nonce_hash: nonceHash,
          source_contract: 's1.local-db-decision-choice/v1', authority_basis: 'same-transaction-current-permissions', transfer_mode: 'same-transaction-only',
          consumed_receipt_id: receiptId, issued_at: ctx.at, consumed_at: ctx.at });
        const source = await repos.context.one('SELECT * FROM decision_local_initiations WHERE id=?', [initiationId]);
        // PostgreSQL exposes BIGINT as canonical decimal text. Normalize only
        // this typed revision; all other source bindings remain exact values.
        if (!source || Object.entries(binding).some(([key, value]) => (key === 'input_decision_revision'
          ? storageInteger(source[key], 'decision_local_initiations.input_decision_revision') : source[key]) !== value) || source.nonce_hash !== createHash('sha256').update(nonce).digest('hex') ||
          source.user_event_id !== userEventId || source.consumed_receipt_id !== receiptId) throw new DecisionCommandError('source_binding_mismatch', '本地命令来源绑定不一致。');
        nonce.fill(0);
      }
      await writer.insert('decision_resolutions', { id: resolutionId, ...binding, authority, reason_json: encode('decision_resolutions.reason_json', reason),
        actual_execution_path: choice === 'approve' ? path : 'no-effect', initiation_id: initiationId ?? null, command_receipt_id: receiptId,
        policy_evaluation_json: encode('decision_resolutions.policy_evaluation_json', evaluation),
        permission_snapshot_json: encode('decision_resolutions.permission_snapshot_json', permissions), permission_snapshot_digest: permissionDigest(permissions), resolved_at: ctx.at });
      const execution: DbReviewExecution = choice === 'approve' ? await applyReviewEffect(await currentReviewEffect(ctx.guard,
        { actor: ctx.actor, path, action, observation: evaluation, resultRef, reason, executionId, resolutionId, at: ctx.at }))
        : { kind: 'db-review-execution/v1', id: executionId, decisionId: inputRef.decisionId, effectKey: `decision:${inputRef.decisionId}`, status: 'not_required', verdict: null };
      await writer.insert('decision_executions', { id: executionId, ...rowSlot(ctx.command), decision_id: inputRef.decisionId, resolution_id: resolutionId,
        choice_id: choice, effect_key: execution.effectKey, status: execution.status, verdict: execution.verdict,
        before_task_revision: execution.status === 'succeeded' ? execution.before.taskRevision : null,
        before_round_revision: execution.status === 'succeeded' ? execution.before.roundRevision : null,
        after_task_revision: execution.status === 'succeeded' ? execution.after.taskRevision : null,
        after_round_revision: execution.status === 'succeeded' ? execution.after.roundRevision : null,
        task_history_id: execution.status === 'succeeded' ? execution.taskHistoryId : null,
        work_event_ids_json: encode('decision_executions.work_event_ids_json', execution.status === 'succeeded' ? execution.workEventIds : []), committed_at: ctx.at });
      if (execution.status === 'succeeded') await writer.replaceProjection({ ...rowSlot(ctx.command), source_kind: 'live', execution_id: executionId, legacy_id: null, applied_at: ctx.at });
      const next = { ...record, revision: resultRef.revision, status: 'resolved', required_authority: fields.required,
        assignee_member_id: fields.assignee, blocked_reason_code: null, policy_evaluation_json: encode('decision_records.policy_evaluation_json', evaluation), updated_at: ctx.at };
      await writer.updatePending(inputRef.decisionId, inputRef.revision, { status: 'resolved', requiredAuthority: fields.required,
        assigneeMemberId: fields.assignee, blockedReason: null, policyEvaluation: next.policy_evaluation_json, at: ctx.at });
      await changed(ctx, writer, next, 'resolved');
      // Result notifications are durable references, independent of the actual
      // Task effect. Reject/return must never masquerade as task completion.
      const outcome = { taskId: ctx.command.taskId, roundId: ctx.command.roundId, decisionRef: resultRef,
        choiceId: choice, executionStatus: execution.status, verdict: execution.verdict };
      const actor = { kind: ctx.actor.kind, actorId: ctx.actor.actorId,
        displayName: ctx.actor.kind === 'human' ? '人（owner）' : (await repos.members.get(ctx.actor.actorId))?.displayName ?? ctx.actor.actorId };
      await repos.tasks.appendHistory({ id: randomUUID(), projectId: ctx.command.projectId, taskId: ctx.command.taskId,
        action: 'decision.resolved', actor, taskRevision: execution.status === 'succeeded' ? execution.after.taskRevision : subject.task.revision,
        detail: outcome, createdAt: ctx.at });
      const recipients = new Map([subject.reviewer, subject.assignee].filter(member => activeMember(member, ctx.command.projectId))
        .map(member => [member.id, member]));
      for (const recipient of recipients.values()) {
        if (!authorize(actorForMember(recipient), 'task:view', { projectId: ctx.command.projectId }).allowed) continue;
        const event = await repos.tasks.enqueueWorkEvent({ id: randomUUID(), projectId: ctx.command.projectId, taskId: ctx.command.taskId,
          recipientMemberId: recipient.id, kind: 'decision.resolved',
          eventKey: `decision:${resultRef.decisionId}:${resultRef.revision}:${recipient.id}:resolved`, payload: outcome,
          deliveryState: 'pending', attempts: 0, createdAt: ctx.at, firstDeliveredAt: null, lastDeliveredAt: null, ackedAt: null });
        await notifyWorkEventCommit(db, [event]);
      }
      return saveReceipt(ctx, writer, next, currentHead, execution.status === 'succeeded' ? 'applied' : 'not_required', inputRef,
        { receiptId, resolutionId, ...(initiationId ? { initiationId } : {}), execution });
    });
  }
  async function resolveCommand(access: DecisionAccess, projectId: string, id: string, input: ResolveAgentDecisionInput,
    proof?: TrustedLocalDecisionRequest): Promise<DecisionCommandResult> {
    const slot = await slotFor(access, projectId, id), { idempotencyKey, ...semantic } = input;
    if (input.decisionRef.projectId !== projectId || input.decisionRef.decisionId !== id) throw new DecisionCommandError('decision_revision_conflict', '命令引用与请求目标不一致。');
    return command(access, slot, idempotencyKey, actor => ({ ...slot, actor: actorRef(actor), operation: 'resolve', input: semantic }), async ctx =>
      choose(ctx, await row(id, projectId), (await head(slot))!, input.decisionRef, input.choiceId, input.reason, proof));
  }
  return {
    get: show,
    async list(access, projectId, filter = {}) {
      const value = parseDecisionInput(listDecisionsSchema, filter);
      return snapshot(async read => {
        const actor = await decisionActor(repos, access, projectId), graph = await readDecisionProjectGraph(read, projectId);
        const policy = await currentPolicyRef(read, projectId), decisions: DecisionView[] = [];
        const live = [...graph.decision_records!].filter(r => (!value.taskId || r.task_id === value.taskId) && (!value.status || r.status === value.status));
        live.sort((a, b) => Number(b.generation) - Number(a.generation) || String(b.created_at).localeCompare(String(a.created_at)) || String(a.id).localeCompare(String(b.id)));
        for (const record of live) decisions.push(await presentDecision(repos, graph, actor, policy, record));
        if (!value.status) for (const legacy of graph.decision_legacy_records!) if (!value.taskId || legacy.task_id === value.taskId) decisions.push(legacyView(legacy));
        return { decisions, cursor: Number(graph.decision_change_heads![0]?.revision ?? 0) };
      });
    },
    async changes(access, projectId, afterRevision) {
      if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) throw new InvalidArgumentError('变更游标必须为非负安全整数。');
      return snapshot(async read => {
        await decisionActor(repos, access, projectId);
        const rows = await read.query('SELECT * FROM decision_changes WHERE project_id=? AND revision>? ORDER BY revision LIMIT 1000', [projectId, afterRevision]);
        const changes: DecisionChange[] = rows.map(r => ({ projectId, revision: Number(r.revision), taskId: String(r.task_id), decisionId: String(r.decision_id),
          decisionRevision: Number(r.decision_revision), kind: r.kind as DecisionChange['kind'] }));
        // Advancing only through returned rows cannot skip a page of changes.
        return { changes, cursor: changes.at(-1)?.revision ?? afterRevision };
      });
    },
    async request(access, slot, raw) {
      const { idempotencyKey, expectedHead, ...rest } = parseDecisionInput(requestReviewDecisionSchema, raw);
      const input = { ...rest, ...(expectedHead ? { expectedHead } : {}) };
      return command(access, slot, idempotencyKey, actor => ({ ...slot, actor: actorRef(actor), operation: 'request-review', input }), async ctx => {
        const proposed = await proposal(ctx, await readCurrentReview(repos, slot), input);
        return store.write(ctx.guard, writer => saveReceipt(ctx, writer, proposed.record, proposed.head, 'pending', null));
      });
    },
    async resolve(access, projectId, id, input) {
      if (access.actor.kind !== 'agent') throw new DecisionCommandError('source_binding_mismatch', '人工裁决须由可信本地选择入口提交。', 403);
      return resolveCommand(access, projectId, id, parseDecisionInput(resolveDecisionSchema, input));
    },
    async chooseLocal(access, projectId, id, raw, proof) {
      const { clientMutationId, ...input } = parseDecisionInput(chooseLocalDecisionSchema, raw);
      assertTrustedLocalRequest(proof, access.actor);
      return resolveCommand(access, projectId, id, { ...input, idempotencyKey: clientMutationId }, proof);
    },
    async refresh(access, projectId, id, raw) {
      const { idempotencyKey, ...input } = parseDecisionInput(refreshDecisionSchema, raw), slot = await slotFor(access, projectId, id);
      if (input.decisionRef.projectId !== projectId || input.decisionRef.decisionId !== id) throw new DecisionCommandError('decision_revision_conflict', '命令引用与请求目标不一致。');
      return command(access, slot, idempotencyKey, actor => ({ ...slot, actor: actorRef(actor), operation: 'refresh', input }), async ctx =>
        choose(ctx, await row(id, projectId), (await head(slot))!, input.decisionRef, 'approve', '', undefined, true));
    },
    async requestAndMaybeResolveReview(access, slot, raw, proof) {
      const parsed = parseTaskInput(decideTaskReviewSchema, raw), input = { ...parsed, override: parsed.override ?? false };
      const key = createHash('sha256').update(JSON.stringify([access.actor.kind, access.actor.actorId, slot.projectId, slot.taskId, slot.roundId,
        input.expectedTaskRevision, input.expectedRoundRevision, 'legacy-decide/v1'])).digest('hex');
      return command(access, slot, key, actor => ({ ...slot, actor: actorRef(actor), operation: 'legacy-decide', input }), async ctx => {
        const subject = await readCurrentReview(repos, slot), path = input.override ? 'management' : 'reviewer';
        expectCandidate(subject, input); assertReviewPath(ctx.actor, subject, path, input.verdict);
        const currentHead = await head(slot), current = currentHead ? await row(String(currentHead.current_decision_id), slot.projectId) : undefined;
        const digest = reviewAction(subject, input.verdict).actionDigest;
        // Rejection leaves Task/Round CAS unchanged. That old command cannot
        // silently create a replacement approval after a terminal choice.
        if (current && current.status !== 'pending' && current.action_digest === digest) conflict(current, currentHead!, 'decision_terminal');
        // Only the established decided-round compatibility correction carries
        // an implicit successor intent. A reported pending proposal requires an
        // explicit native expectedHead; never manufacture the caller's head CAS.
        if (current && current.action_digest !== digest && subject.round.state !== 'decided') conflict(current, currentHead!, 'head_revision_conflict');
        const proposed = current?.status === 'pending' && current.action_digest === digest ? { record: current, head: currentHead! }
          : await proposal(ctx, subject, { expectedTaskRevision: input.expectedTaskRevision, expectedRoundRevision: input.expectedRoundRevision,
            proposedVerdict: input.verdict, reason: input.reason, requestedPath: path, ...(currentHead ? { expectedHead: headRef(currentHead) } : {}) });
        return choose(ctx, proposed.record, proposed.head, recordRef(proposed.record), 'approve', input.reason, proof, false, path);
      });
    },
  };
}

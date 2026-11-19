import { z } from 'zod';
import { validateWorkEventInvalidations, decodeInvalidationClosure, getWorkEventStorageInvalidIdentity } from '../../tasks/work-event-storage.ts';
import { chargeP0, createP0TupleIndex, failP0, withP0Guard } from './m2-p0.ts';
import type { P0Request, P0Result, P0Rule, P0Table, P0View } from './m2-p0.ts';
import { cObject, createP0CStorageSyntaxFrame, type CObject, type CRow, P0CContext } from './m2-p0-c-shadow.ts';
import { prepareP0DecisionRows, consumeP0DecisionGraph } from './m2-p0-decision-grammar.ts';
import { buildP0CompletionIndex, type P0CompletionIndex } from './m2-p0-completion.ts';
import { P0_HISTORY_SCHEMAS, p0DecisionRequestedSchema, p0EvidenceAxesIndependent, p0EvidenceMatchesCandidate,
  p0LifecycleEventSchema, p0MemoryNoticeSchema, p0OrdinaryAssignedSchema, p0OrdinaryBlockedSchema,
  p0ResolvedOutcomeSchema, p0ReviewCandidateSchema, p0ReviewDecisionSchema, p0ReviewEvidenceSchema, p0ReviewFailureSchema,
  p0ReviewReadySchema, p0ReviewSnapshotSchema, p0StringArraySchema, p0TaskAuthorSchema } from './m2-p0-task-grammar.ts';

export const P0_C_RULES = Object.freeze(['PC1B-TASK01', 'PC1B-TASK02', 'PC1B-TASK03',
  'PC1B-DEC01', 'PC1B-DEC02', 'PC1B-DEC03', 'PC1B-DEC04', 'PC1B-DEC05', 'PC1B-DEC06', 'PC1B-DEC07',
  'PC1B-DEC08', 'PC1B-DEC09', 'PC1B-DEC10', 'PC1B-DEC11', 'PC1B-DEC12', 'PC1B-DEC13',
  'PC1B-WE01', 'PC1B-WE02', 'PC1B-WE03', 'PC1B-WE04'] as const);
export interface P0TaskDecisionWorkEventObservation {
  readonly classification: 'task-decision-work-event-observation';
  readonly phase: 'original-graph' | 'retained-graph';
  readonly rules: typeof P0_C_RULES;
  readonly fullSemanticClosure: 'not-performed';
  readonly completion: P0CompletionIndex;
}

const REQUIRED: Readonly<Partial<Record<P0Table, readonly string[]>>> = Object.freeze({
  tasks: ['id', 'project_id', 'title', 'body', 'labels', 'state', 'author', 'created_at', 'updated_at', 'acceptance_text', 'acceptance_source'],
  task_review_rounds: ['id', 'task_id', 'project_id', 'state', 'reviewer_member_id', 'spec_snapshot', 'created_at', 'updated_at'],
  task_review_reports: ['id', 'round_id', 'task_id', 'project_id', 'axis', 'verdict', 'body', 'sources', 'evidence', 'content_sha256', 'author', 'created_at'],
  task_comments: ['id', 'task_id', 'project_id', 'kind', 'author', 'author_actor_id', 'body', 'created_at'],
  task_history: ['id', 'task_id', 'project_id', 'action', 'actor', 'detail', 'created_at'],
  task_message_links: ['task_id', 'message_id', 'project_id', 'group_id', 'created_at'],
  project_task_settings: ['project_id'],
  work_events: ['id', 'project_id', 'recipient_member_id', 'kind', 'event_key', 'payload', 'delivery_state', 'created_at'],
});
const STATES = ['todo', 'in-progress', 'review', 'blocked', 'done'];
const ROUND_STATES = ['ready', 'running', 'reported', 'decided', 'failed', 'superseded'];
function enumValue(c: P0CContext, row: CRow, column: string, allowed: readonly string[], rule: P0Rule, nullable = false): void {
  if (nullable && row.values[column] === null) return;
  if (!allowed.includes(row.values[column] as string)) c.invalid(row, rule, column);
}
function targetTask(c: P0CContext, row: CRow, rule: P0Rule): CRow {
  return c.sameScope(row, c.find('tasks', row.values.task_id!), rule, 'task_id', true);
}
function member(c: P0CContext, row: CRow, column: string, reviewer = false): void {
  const id = row.values[column]; if (id === null) return;
  const found = c.sameScope(row, c.find('members', id!), 'PC1B-TASK01', column);
  if (reviewer && found.values.kind !== 'agent') c.fail(row, 'PC1B-TASK01', 'identity-mismatch', column, found);
}
function boundedHistory(c: P0CContext, row: CRow, task: CRow, column: string, rule: P0Rule): void {
  if ((c.integer(row, column, rule)! as number) > (task.values.revision as number)) c.fail(row, rule, 'history-gap', column, task);
}

interface LegacySources { history: WeakSet<CRow>; malformedRound: WeakSet<CRow>; }
function legacySources(c: P0CContext): LegacySources {
  const history = new WeakSet<CRow>(), malformedRound = new WeakSet<CRow>();
  const bindings = createP0TupleIndex<CRow>(c.request);
  for (const row of c.rows('decision_legacy_records')) {
    const table = row.values.source_table as 'task_history' | 'task_review_rounds';
    const source = c.find(table, row.values.source_id!);
    if (!source) c.fail(row, 'PC1B-DEC11', 'missing-target', 'source_id');
    c.sameScope(row, source, 'PC1B-DEC11', 'source_id', true);
    if (bindings.insert([table, row.values.source_id!], row)) c.fail(row, 'PC1B-DEC11', 'duplicate-key', 'source_id');
    const raw = c.json(row, 'raw_text', 'PC1B-DEC11');
    const diagnostics = c.schema(row, 'diagnostics_json', 'PC1B-DEC11', p0StringArraySchema);
    chargeP0(c.request, { work: diagnostics.length ** 2, bytes: c.bytes(row, 'diagnostics_json') * Math.max(1, diagnostics.length) });
    if (!c.equal(diagnostics, [...new Set(diagnostics)].sort(), row, 'PC1B-DEC11', 'diagnostics_json')) c.invalid(row, 'PC1B-DEC11', 'diagnostics_json');
    if (!cObject(raw) || raw.id !== source.values.id || raw.project_id !== row.values.project_id || raw.task_id !== row.values.task_id
      || Object.keys(raw).length !== Object.keys(source.values).length || Object.keys(source.values).some(key => !Object.hasOwn(raw, key)))
      c.fail(row, 'PC1B-DEC11', 'immutable-history-mismatch', 'raw_text', source);
    if (table === 'task_history') {
      if (!c.equal(raw, source.values, row, 'PC1B-DEC11', 'raw_text')) c.fail(row, 'PC1B-DEC11', 'immutable-history-mismatch', 'raw_text', source);
      if (source.values.action !== 'task.review_decided') c.fail(row, 'PC1B-DEC11', 'state-mismatch', 'source_id', source);
      history.add(source);
    } else {
      if (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 1 || (raw.revision as number) > (source.values.revision as number))
        c.fail(row, 'PC1B-DEC11', 'history-gap', 'raw_text', source);
      if (row.values.chain_status === 'malformed' && diagnostics.includes('final_projection_invalid') && raw.decision === source.values.decision)
        malformedRound.add(source);
    }
  }
  return { history, malformedRound };
}

function prepareTaskRows(c: P0CContext, legacy: LegacySources): void {
  for (const [table, required] of Object.entries(REQUIRED)) for (const row of c.rows(table as P0Table)) {
    chargeP0(c.request, { work: 128, bytes: c.bytes(row) * 2 }, c.site(row, 'PC1B-TASK01'));
    for (const column of required) c.text(row, column, 'PC1B-TASK01');
    if (!c.find('projects', row.values.project_id!)) c.fail(row, 'PC1B-TASK01', 'missing-target', 'project_id');
  }
  for (const row of c.rows('tasks')) {
    c.integer(row, 'revision', 'PC1B-TASK01'); enumValue(c, row, 'state', STATES, 'PC1B-TASK01');
    enumValue(c, row, 'delivery_kind', ['code', 'artifact', 'finding'], 'PC1B-TASK01', true);
    enumValue(c, row, 'acceptance_source', ['explicit', 'legacy_task_body'], 'PC1B-TASK01');
    c.schema(row, 'author', 'PC1B-TASK01', p0TaskAuthorSchema); c.schema(row, 'labels', 'PC1B-TASK01', p0StringArraySchema);
    member(c, row, 'assignee_member_id'); member(c, row, 'reviewer_member_id', true);
    if (row.values.current_review_round_id !== null) {
      const round = c.find('task_review_rounds', row.values.current_review_round_id!);
      if (!round) c.fail(row, 'PC1B-TASK01', 'missing-target', 'current_review_round_id');
      if (round.values.project_id !== row.values.project_id || round.values.task_id !== row.values.id)
        c.fail(row, 'PC1B-TASK01', 'scope-mismatch', 'current_review_round_id', round);
    }
  }
  for (const row of c.rows('project_task_settings')) {
    c.integer(row, 'revision', 'PC1B-TASK01'); member(c, row, 'default_reviewer_member_id', true);
  }
  for (const row of c.rows('task_review_rounds')) {
    const task = targetTask(c, row, 'PC1B-TASK01'); c.integer(row, 'revision', 'PC1B-TASK01');
    boundedHistory(c, row, task, 'task_revision', 'PC1B-TASK01'); enumValue(c, row, 'state', ROUND_STATES, 'PC1B-TASK01');
    member(c, row, 'reviewer_member_id', true); c.schema(row, 'spec_snapshot', 'PC1B-TASK01', p0ReviewSnapshotSchema);
    if (row.values.candidate !== null) c.schema(row, 'candidate', 'PC1B-TASK01', p0ReviewCandidateSchema);
    if (row.values.failure !== null) c.schema(row, 'failure', 'PC1B-TASK01', p0ReviewFailureSchema);
    if (row.values.decision !== null && !legacy.malformedRound.has(row)) c.schema(row, 'decision', 'PC1B-TASK01', p0ReviewDecisionSchema);
  }
  const reportsByRound = createP0TupleIndex<CRow>(c.request);
  for (const row of c.rows('task_review_reports')) {
    targetTask(c, row, 'PC1B-TASK02');
    const round = c.sameScope(row, c.find('task_review_rounds', row.values.round_id!), 'PC1B-TASK02', 'round_id', true);
    enumValue(c, row, 'axis', ['spec', 'standards'], 'PC1B-TASK02'); enumValue(c, row, 'verdict', ['pass', 'changes_requested'], 'PC1B-TASK02');
    c.schema(row, 'sources', 'PC1B-TASK02', p0StringArraySchema); c.schema(row, 'author', 'PC1B-TASK02', p0TaskAuthorSchema);
    const evidence = c.schema(row, 'evidence', 'PC1B-TASK02', p0ReviewEvidenceSchema);
    if (round.values.candidate === null) c.fail(row, 'PC1B-TASK02', 'missing-target', 'evidence', round);
    const candidate = c.json(round, 'candidate', 'PC1B-TASK01') as z.infer<typeof p0ReviewCandidateSchema>;
    if (!p0EvidenceMatchesCandidate(evidence, candidate)) c.fail(row, 'PC1B-TASK02', 'immutable-history-mismatch', 'evidence', round);
    const other = reportsByRound.insert([row.values.round_id!], row);
    if (other) {
      const otherEvidence = c.json(other, 'evidence', 'PC1B-TASK02') as z.infer<typeof p0ReviewEvidenceSchema>;
      if (other.values.axis === row.values.axis || !p0EvidenceAxesIndependent(evidence, otherEvidence))
        c.fail(row, 'PC1B-TASK02', 'immutable-history-mismatch', 'evidence', other);
    }
  }
  for (const row of c.rows('task_comments')) {
    targetTask(c, row, 'PC1B-TASK01'); enumValue(c, row, 'kind', ['comment', 'review_report'], 'PC1B-TASK01');
    const author = c.schema(row, 'author', 'PC1B-TASK01', p0TaskAuthorSchema);
    if (author.actorId !== row.values.author_actor_id) c.fail(row, 'PC1B-TASK01', 'identity-mismatch', 'author_actor_id');
    if ((row.values.kind === 'review_report') !== (row.values.review_report_id !== null)) c.invalid(row, 'PC1B-TASK01', 'review_report_id');
    if (row.values.review_report_id !== null) c.sameScope(row, c.find('task_review_reports', row.values.review_report_id!), 'PC1B-TASK01', 'review_report_id', true);
  }
  for (const row of c.rows('task_message_links')) {
    targetTask(c, row, 'PC1B-TASK01');
    const group = c.sameScope(row, c.find('groups', row.values.group_id!), 'PC1B-TASK01', 'group_id');
    const message = c.find('messages', row.values.message_id!);
    if (!message) c.fail(row, 'PC1B-TASK01', 'missing-target', 'message_id');
    if (message.values.group_id !== group.values.id) c.fail(row, 'PC1B-TASK01', 'scope-mismatch', 'message_id', message);
  }
}

function resolvedOutcome(c: P0CContext, row: CRow, column: string): void {
  const outcome = c.schema(row, column, 'PC1B-DEC13', p0ResolvedOutcomeSchema);
  const record = c.find('decision_records', outcome.decisionRef.decisionId);
  if (!record) c.fail(row, 'PC1B-DEC13', 'missing-target', column);
  if (row.values.project_id !== record.values.project_id || row.values.task_id !== record.values.task_id
    || outcome.taskId !== record.values.task_id || outcome.roundId !== record.values.round_id)
    c.fail(row, 'PC1B-DEC13', 'scope-mismatch', column, record);
  const resolution = c.find('decision_resolutions', record.values.id!, 'decision_id');
  const execution = c.find('decision_executions', record.values.id!, 'decision_id');
  if (!resolution || !execution) c.fail(row, 'PC1B-DEC13', 'missing-target', column);
  const expectedRef = { decisionId: record.values.id, projectId: record.values.project_id,
    revision: record.values.revision, actionDigest: record.values.action_digest };
  if (record.values.status !== 'resolved' || !c.equal(outcome.decisionRef, expectedRef, row, 'PC1B-DEC13', column)
    || resolution.values.project_id !== record.values.project_id || resolution.values.task_id !== record.values.task_id
    || resolution.values.round_id !== record.values.round_id || execution.values.project_id !== record.values.project_id
    || execution.values.task_id !== record.values.task_id || execution.values.round_id !== record.values.round_id
    || outcome.choiceId !== resolution.values.choice_id || execution.values.resolution_id !== resolution.values.id
    || outcome.executionStatus !== execution.values.status || outcome.verdict !== execution.values.verdict)
    c.fail(row, 'PC1B-DEC13', 'immutable-history-mismatch', column, record);
  if (row.origin.table === 'task_history') {
    const actor = c.json(row, 'actor', 'PC1B-DEC13') as CObject;
    if (actor.kind !== resolution.values.actor_kind || actor.actorId !== resolution.values.actor_id
      || row.values.created_at !== resolution.values.resolved_at
      || execution.values.status === 'succeeded' && row.values.task_revision !== execution.values.after_task_revision)
      c.fail(row, 'PC1B-DEC13', 'immutable-history-mismatch', column, resolution);
  } else if (row.values.event_key !== `decision:${record.values.id}:${outcome.decisionRef.revision}:${row.values.recipient_member_id}:resolved`)
    c.fail(row, 'PC1B-DEC13', 'identity-mismatch', 'event_key', record);
}

function checkTaskHistory(c: P0CContext, legacy: LegacySources): void {
  const liveHistory = createP0TupleIndex<CRow>(c.request);
  for (const execution of c.rows('decision_executions')) if (execution.values.task_history_id !== null)
    liveHistory.insert([execution.values.task_history_id!], execution);
  for (const row of c.rows('task_history')) {
    const task = targetTask(c, row, 'PC1B-TASK03'); boundedHistory(c, row, task, 'task_revision', 'PC1B-TASK03');
    c.schema(row, 'actor', 'PC1B-TASK02', p0TaskAuthorSchema);
    const action = row.values.action as string;
    if (action === 'task.review_decided' && !liveHistory.has([row.values.id!])) {
      if (!legacy.history.has(row)) c.fail(row, 'PC1B-DEC11', 'missing-target', 'detail');
      // Exact raw legacy source/diagnostics were bound above. Malformed embedded
      // decisions remain historical text and are never promoted to a live effect.
      continue;
    }
    const rule = action === 'decision.resolved' ? 'PC1B-DEC13' : action === 'task.review_decided' ? 'PC1B-DEC10' : 'PC1B-TASK03';
    const detail = c.json(row, 'detail', rule);
    if (!cObject(detail)) c.invalid(row, rule, 'detail');
    if (Object.hasOwn(P0_HISTORY_SCHEMAS, action)) c.schema(row, 'detail', rule, P0_HISTORY_SCHEMAS[action]!, detail);
    if (action === 'task.updated' && (detail.previousRevision as number) + 1 !== row.values.task_revision) c.fail(row, rule, 'history-gap', 'detail');
    if (action === 'task.transitioned' && cObject(detail.escalation) && detail.escalation.unresolved !== (detail.escalation.recipientMemberId === null))
      c.fail(row, rule, 'state-mismatch', 'detail');
    if (action === 'task.commented') {
      const comment = c.sameScope(row, c.find('task_comments', detail.commentId as string), rule, 'detail', true);
      if (row.values.created_at !== comment.values.created_at || !c.equal(c.json(row, 'actor', rule), c.json(comment, 'author', rule), row, rule, 'detail'))
        c.fail(row, rule, 'immutable-history-mismatch', 'detail', comment);
    }
    if (['task.review_failed', 'task.review_started', 'task.review_begun', 'task.review_reported'].includes(action)) {
      const round = c.sameScope(row, c.find('task_review_rounds', detail.roundId as string), rule, 'detail', true);
      if (action === 'task.review_failed' && !c.equal(detail.failure, c.json(round, 'failure', rule), row, rule, 'detail')) c.fail(row, rule, 'immutable-history-mismatch', 'detail', round);
      if (action === 'task.review_started') {
        const candidate = c.json(round, 'candidate', rule);
        if (!cObject(candidate) || ['baseCommit', 'candidateCommit', 'diffSha256'].some(key => detail[key] !== candidate[key])) c.fail(row, rule, 'immutable-history-mismatch', 'detail', round);
      }
      if (action === 'task.review_begun' && (detail.roundRevision as number) > (round.values.revision as number)) c.fail(row, rule, 'history-gap', 'detail', round);
      if (action === 'task.review_reported') {
        const report = c.sameScope(row, c.find('task_review_reports', detail.reportId as string), rule, 'detail', true);
        if (report.values.round_id !== round.values.id || report.values.axis !== detail.axis || report.values.verdict !== detail.verdict) c.fail(row, rule, 'immutable-history-mismatch', 'detail', report);
      }
    }
    if (action === 'member_removed' || action === 'member_restored') {
      c.sameScope(row, c.find('members', detail.memberId as string), rule, 'detail');
      const audit = c.sameScope(row, c.find('audit_log', detail.auditId as string), rule, 'detail');
      if (audit.values.scope !== 'project' || audit.values.target_kind !== 'member' || audit.values.target_id !== detail.memberId
        || !['member.add', 'member.remove', 'member.revoke'].includes(audit.values.action as string) || audit.values.created_at !== row.values.created_at)
        c.fail(row, rule, 'immutable-history-mismatch', 'detail', audit);
    }
    if (action === 'decision.resolved') resolvedOutcome(c, row, 'detail');
  }
}

function checkWorkPayloads(c: P0CContext): void {
  const lifecycle = createP0TupleIndex<CRow[]>(c.request);
  for (const history of c.rows('task_history')) if (history.values.action === 'member_removed' || history.values.action === 'member_restored') {
    const detail = c.json(history, 'detail', 'PC1B-TASK03') as CObject;
    const key = [history.values.project_id!, history.values.task_id!, history.values.task_revision!, detail.memberId as string] as const;
    const previous = lifecycle.insert(key, [history]); if (previous) previous.push(history);
  }
  for (const row of c.rows('work_events')) {
    const rule: P0Rule = row.values.kind === 'decision.requested' || row.values.kind === 'decision.resolved' ? 'PC1B-DEC13' : 'PC1B-TASK03';
    c.sameScope(row, c.find('members', row.values.recipient_member_id!), rule, 'recipient_member_id');
    if (row.values.context_group_id !== null) c.sameScope(row, c.find('groups', row.values.context_group_id!), rule, 'context_group_id');
    enumValue(c, row, 'delivery_state', ['pending', 'delivered', 'acked'], rule); c.integer(row, 'attempts', rule, 0);
    const payload = c.json(row, 'payload', rule);
    if (!cObject(payload)) c.invalid(row, rule, 'payload');
    const kind = row.values.kind;
    if (kind === 'memory.summary_requested') {
      c.schema(row, 'payload', rule, p0MemoryNoticeSchema, payload);
      if (row.values.task_id !== null) c.fail(row, rule, 'state-mismatch', 'task_id');
      continue; // The strong notification -> summary request edge is D / MEM05.
    }
    if (kind === 'task.review_decided') {
      // Pre-Decision source rows may have a NULL optional task FK. MEM04 observes
      // the original fields and cannot promote that row to a consumable source.
      // A live key/ref is independently bound to its exact execution below.
      if (row.values.task_id !== null) targetTask(c, row, rule);
      continue;
    }
    const task = targetTask(c, row, rule);
    if (kind === 'task.assigned' || kind === 'task.blocked') {
      let revision: number;
      if (Object.hasOwn(payload, 'taskRevision')) {
        const value = c.schema(row, 'payload', rule, p0LifecycleEventSchema, payload); revision = value.taskRevision;
        c.sameScope(row, c.find('members', value.memberId), rule, 'payload');
        const candidates = lifecycle.get([row.values.project_id!, row.values.task_id!, revision, value.memberId]) ?? [];
        chargeP0(c.request, { work: candidates.length * 8, tuples: candidates.length,
          bytes: candidates.reduce((sum, history) => sum + c.bytes(history, 'detail'), 0) + c.bytes(row, 'event_key') * candidates.length });
        const matches = candidates.filter(history => {
          const detail = c.json(history, 'detail', rule) as CObject;
          return row.values.event_key === `${detail.auditId}:${row.values.task_id}:${revision}:${row.values.recipient_member_id}`
            && history.values.created_at === row.values.created_at;
        });
        if (matches.length !== 1) c.fail(row, rule, 'missing-target', 'event_key');
      } else {
        const value = kind === 'task.assigned' ? c.schema(row, 'payload', rule, p0OrdinaryAssignedSchema, payload)
          : c.schema(row, 'payload', rule, p0OrdinaryBlockedSchema, payload);
        revision = value.revision;
        if (row.values.event_key !== `task:${row.values.task_id}:revision:${revision}:${kind === 'task.assigned' ? 'assigned' : 'blocked'}`)
          c.fail(row, rule, 'identity-mismatch', 'event_key');
      }
      if (payload.taskId !== row.values.task_id || revision > (task.values.revision as number)) c.fail(row, rule, 'history-gap', 'payload', task);
    } else if (kind === 'task.review_ready') {
      const value = c.schema(row, 'payload', rule, p0ReviewReadySchema, payload);
      c.sameScope(row, c.find('task_review_rounds', value.roundId), rule, 'payload', true);
      if (value.taskId !== row.values.task_id || value.revision > (task.values.revision as number) || row.values.event_key !== `review:${value.roundId}:ready`)
        c.fail(row, rule, 'identity-mismatch', 'payload', task);
    } else if (kind === 'decision.requested') {
      const value = c.schema(row, 'payload', rule, p0DecisionRequestedSchema, payload);
      const record = c.sameScope(row, c.find('decision_records', value.decisionId), rule, 'payload', true);
      if (value.taskId !== row.values.task_id || value.decisionRevision > (record.values.revision as number)
        || row.values.event_key !== `decision:${value.decisionId}:${value.decisionRevision}:${row.values.recipient_member_id}:requested`)
        c.fail(row, rule, 'immutable-history-mismatch', 'payload', record);
    } else if (kind === 'decision.resolved') resolvedOutcome(c, row, 'payload');
    else c.invalid(row, rule, 'kind');
  }
}

function workInvalidations(c: P0CContext): void {
  const closures = new WeakMap<CRow, ReturnType<typeof decodeInvalidationClosure>>();
  const closureFor = (audit: CRow) => {
    const found = closures.get(audit); if (found) return found;
    const detail = c.json(audit, 'detail', 'PC1B-WE03');
    if (!cObject(detail)) c.invalid(audit, 'PC1B-WE03', 'detail');
    chargeP0(c.request, { work: c.nodeCount(detail) * 4, bytes: c.bytes(audit, 'detail') * 8 });
    const closure = detail.workEventInvalidations;
    // Prove the fixed key count before the original decoder sorts Object.keys.
    if (!cObject(closure) || Object.keys(closure).length !== 2 || !Object.hasOwn(closure, 'schema') || !Object.hasOwn(closure, 'eventIds'))
      c.invalid(audit, 'PC1B-WE03', 'detail');
    c.reserveStringSort(closure.eventIds);
    let value: ReturnType<typeof decodeInvalidationClosure>;
    try { value = decodeInvalidationClosure(closure); }
    catch (error) { if (!getWorkEventStorageInvalidIdentity(error)) throw error; return c.invalid(audit, 'PC1B-WE03', 'detail'); }
    closures.set(audit, value); return value;
  };
  const listBytes = (value: unknown, fields?: readonly string[]): number => {
    if (!Array.isArray(value)) return 0;
    chargeP0(c.request, { work: value.length * (fields?.length ?? 1) });
    let bytes = 0;
    for (const entry of value) {
      if (!fields) { if (typeof entry === 'string') bytes += entry.length * 2; }
      else if (cObject(entry)) for (const field of fields) if (typeof entry[field] === 'string') bytes += (entry[field] as string).length * 2;
    }
    return bytes;
  };
  for (const audit of c.rows('audit_log')) {
    const detail = c.json(audit, 'detail', 'PC1B-WE03', 'legacy-display');
    if (!cObject(detail) || !Object.hasOwn(detail, 'workEventInvalidations')) continue;
    for (const id of closureFor(audit).eventIds) {
      const event = c.find('work_events', id); if (!event) continue;
      const marker = c.find('work_event_delivery_invalidations', id, 'work_event_id');
      if (!marker || marker.values.cause_audit_id !== audit.values.id) c.fail(audit, 'PC1B-WE03', 'conditional-target-required', 'detail', marker ?? null);
    }
  }
  let legacyWork = 0, legacyBytes = 0, legacyNodes = 0;
  for (const marker of c.rows('work_event_delivery_invalidations')) {
    const from = c.integer(marker, 'cause_from_revision', 'PC1B-WE01')!, to = c.integer(marker, 'cause_to_revision', 'PC1B-WE01')!;
    enumValue(c, marker, 'cause_action', ['removed', 'restored'], 'PC1B-WE01');
    if (to !== from + 1 || !c.text(marker, 'invalidated_at', 'PC1B-WE01')) c.invalid(marker, 'PC1B-WE01', 'cause_to_revision');
    const event = c.sameScope(marker, c.find('work_events', marker.values.work_event_id!), 'PC1B-WE01', 'work_event_id');
    const causeMember = c.sameScope(marker, c.find('members', marker.values.cause_member_id!), 'PC1B-WE01', 'cause_member_id');
    const audit = c.sameScope(marker, c.find('audit_log', marker.values.cause_audit_id!), 'PC1B-WE01', 'cause_audit_id');
    if (!c.find('projects', marker.values.project_id!) || audit.values.scope !== 'project' || audit.values.target_kind !== 'member'
      || audit.values.target_id !== marker.values.cause_member_id || !['member.add', 'member.remove', 'member.revoke'].includes(audit.values.action as string)
      || audit.values.created_at !== marker.values.invalidated_at || (causeMember.values.membership_revision as number) < to)
      c.fail(marker, 'PC1B-WE01', 'immutable-history-mismatch', 'cause_audit_id', audit);
    const closure = closureFor(audit), closureBytes = listBytes(closure.eventIds);
    // The original validator decodes this detail once per marker as well as in
    // its separate zero-marker audit scan. Its sort and parsed nodes both count.
    c.reserveStringSort(closure.eventIds);
    legacyNodes += c.nodeCount(c.json(audit, 'detail', 'PC1B-WE03')) + 3;
    for (const column of ['before', 'after']) {
      const value = c.json(audit, column, 'PC1B-WE02'); const nodes = c.nodeCount(value);
      const object = cObject(value) ? value : {};
      const tasks = Array.isArray(object.tasks) ? object.tasks.length : 0, rounds = Array.isArray(object.invalidatedRounds) ? object.invalidatedRounds.length : 0;
      const cost = nodes * 20 + tasks * rounds * 2 + tasks ** 2 + rounds ** 2;
      legacyWork += cost; legacyBytes += c.bytes(audit, column) * 12; legacyNodes += nodes * 2;
      // A proves the nested lexical domain; the real WE consumer calls every
      // validateMemberSnapshot branch and annotates its actual marker row.
      const transient = cObject(object.transient) ? object.transient : {};
      const ids = Array.isArray(transient.workEventIds) ? transient.workEventIds.length : 0;
      for (const [list, field] of [[object.participants, 'groupId'], [object.tasks, 'taskId'], [object.invalidatedRounds, 'roundId']] as const)
        c.reserveStringSort(list, field);
      for (const list of ['workEventIds', 'mcpSessionIds', 'runtimeBindingIds']) c.reserveStringSort(transient[list]);
      legacyWork += (ids + 4) * closure.eventIds.length + tasks;
      legacyBytes += listBytes(object.tasks, ['taskId', 'currentReviewRoundId']) * rounds * 2
        + listBytes(object.invalidatedRounds, ['roundId', 'taskId']) * tasks * 2
        + closureBytes * (ids + 4) + listBytes(transient.workEventIds) * (closure.eventIds.length + 1)
        + (marker.values.work_event_id as string).length * 2 * (ids + closure.eventIds.length)
        + listBytes(object.tasks, ['taskId']) + (typeof event.values.task_id === 'string' ? event.values.task_id.length * 2 * tasks : 0);
    }
    legacyBytes += c.bytes(audit, 'detail') * 8;
  }
  for (const event of c.rows('work_events')) {
    const recipient = c.find('members', event.values.recipient_member_id!);
    if (recipient?.values.removed_at != null && !c.find('work_event_delivery_invalidations', event.values.id!, 'work_event_id'))
      c.fail(event, 'PC1B-WE04', 'conditional-target-required', 'recipient_member_id', recipient);
  }
  // All repeated legacy member snapshot/cross-set traversals are charged before
  // the original validator, including its audit scan with no surviving markers.
  const auditBytes = c.rows('audit_log').reduce((sum, row) => sum + c.bytes(row, 'detail'), 0);
  for (const audit of c.rows('audit_log')) {
    const value = c.json(audit, 'detail', 'PC1B-WE03', 'legacy-display');
    legacyNodes += value === undefined ? c.bytes(audit, 'detail') : c.nodeCount(value);
    if (cObject(value) && Object.hasOwn(value, 'workEventInvalidations')) c.reserveStringSort(closureFor(audit).eventIds);
  }
  chargeP0(c.request, { work: legacyWork + (c.rows('audit_log').length + c.rows('members').length + c.rows('projects').length + c.rows('work_events').length) * 16,
    bytes: legacyBytes + auditBytes * 4, nodes: legacyNodes,
    tuples: c.rows('work_event_delivery_invalidations').length * 8 });
  const syntax = createP0CStorageSyntaxFrame(c);
  try { validateWorkEventInvalidations(c.graph, syntax); }
  catch (error) {
    const identity = getWorkEventStorageInvalidIdentity(error); if (!identity) throw error;
    const rules: Readonly<Record<string, P0Rule>> = { audit_snapshot: 'PC1B-WE02', audit_lifecycle: 'PC1B-WE02',
      audit_closure: 'PC1B-WE03', audit_event_set: 'PC1B-WE03', recipient_closure: 'PC1B-WE03', task_closure: 'PC1B-WE03',
      incomplete_closure: 'PC1B-WE03', removed_member_unmarked_event: 'PC1B-WE04' };
    const row = identity.row && c.originalRow(identity.row), rule = rules[identity.stage] ?? 'PC1B-WE01';
    if (row) c.fail(row, rule, 'immutable-history-mismatch', row.origin.table === 'audit_log' ? 'detail'
      : row.origin.table === 'work_events' ? 'recipient_member_id' : rule === 'PC1B-WE01' ? 'work_event_id' : 'cause_audit_id');
    failP0(c.request, { code: 'semantic_invariant_failed', rule, condition: 'immutable-history-mismatch' });
  }
}

/** A finite family observation; only G may issue complete P0 success. */
export function checkP0TaskDecisionWorkEvents(request: P0Request, selectedView?: P0View): P0Result<P0TaskDecisionWorkEventObservation> {
  return withP0Guard(request, () => {
    const view = selectedView ?? request.original;
    const c = new P0CContext(request, view);
    prepareP0DecisionRows(c);
    const legacy = legacySources(c);
    prepareTaskRows(c, legacy); checkTaskHistory(c, legacy); checkWorkPayloads(c);
    consumeP0DecisionGraph(c); workInvalidations(c);
    const completion = buildP0CompletionIndex(c);
    return Object.freeze({ classification: 'task-decision-work-event-observation', phase: view.phase,
      rules: P0_C_RULES, fullSemanticClosure: 'not-performed', completion });
  });
}

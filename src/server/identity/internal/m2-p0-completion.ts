import { chargeP0, createP0TupleIndex, failP0 } from './m2-p0.ts';
import type { P0Request, P0Row, P0View } from './m2-p0.ts';
import { cObject, type CObject, type CRow, P0CContext } from './m2-p0-c-shadow.ts';
import { p0LiveCompletionSchema } from './m2-p0-task-grammar.ts';

declare const completionBrand: unique symbol;
export interface P0CompletionIndex { readonly [completionBrand]: true; }
export interface P0CompletionSource {
  readonly branch: 'legacy' | 'decision'; readonly event: P0Row; readonly execution: P0Row | null;
  readonly projectId: string; readonly taskId: string | null; readonly recipientMemberId: string;
  readonly enteredDone: boolean; readonly completionRevision: number | null;
  readonly assigneeAgentId: string | null; readonly invalidated: boolean;
}
type PrivateIndex = { request: P0Request; view: P0View; values: WeakMap<P0Row, P0CompletionSource | null> };
const indexes = new WeakMap<P0CompletionIndex, PrivateIndex>();

/** D supplies its current view explicitly because retained views reuse original row objects. */
export function lookupP0CompletionSource(request: P0Request, view: P0View, index: P0CompletionIndex, event: P0Row): P0CompletionSource | null {
  const state = indexes.get(index);
  if (!state || state.request !== request || state.view !== view || !state.values.has(event))
    return failP0(request, { code: 'invalid_value', rule: null });
  chargeP0(request, { work: 1, tuples: 1 });
  return state.values.get(event)!;
}

/** Pure indexed counterpart of validateLiveCompletionSource. It independently binds the
 * same immutable action/history/member values, and never queries current Task state. */
export function buildP0CompletionIndex(c: P0CContext): P0CompletionIndex {
  const executionByEvent = createP0TupleIndex<CRow>(c.request);
  const previousHistories = createP0TupleIndex<CRow | false>(c.request);
  for (const history of c.rows('task_history')) {
    if (history.values.action !== 'task.review_decided') continue;
    const key = [history.values.project_id!, history.values.task_id!, history.values.task_revision!] as const;
    const old = previousHistories.insert(key, history);
    // Ambiguous legacy history remains legal on its own diagnostic branch. A live
    // predecessor must identify one immutable source, not pick whichever row is first.
    if (old !== undefined) { /* Duplicate is detected using the separate count index below. */ }
  }
  const historyCounts = createP0TupleIndex<{ count: number }>(c.request);
  for (const history of c.rows('task_history')) if (history.values.action === 'task.review_decided') {
    const key = [history.values.project_id!, history.values.task_id!, history.values.task_revision!] as const;
    const found = historyCounts.insert(key, { count: 1 }); if (found) found.count++;
  }
  for (const execution of c.rows('decision_executions')) {
    const ids = c.json(execution, 'work_event_ids_json', 'PC1B-DEC10') as string[];
    for (const id of ids) {
      chargeP0(c.request, { work: 1, tuples: 1 }, c.site(execution, 'PC1B-DEC10', 'work_event_ids_json'));
      const previous = executionByEvent.insert([id], execution);
      if (previous) c.fail(execution, 'PC1B-DEC10', 'duplicate-key', 'work_event_ids_json', previous);
    }
  }
  const values = new WeakMap<P0Row, P0CompletionSource | null>();
  for (const event of c.rows('work_events')) {
    if (event.values.kind !== 'task.review_decided') { values.set(event.origin, null); continue; }
    const payload = c.json(event, 'payload', 'PC1B-DEC10');
    if (!cObject(payload)) c.invalid(event, 'PC1B-TASK02', 'payload');
    const execution = executionByEvent.get([event.values.id!]);
    if (!execution) {
      if (Object.hasOwn(payload, 'decisionRef') || (event.values.event_key as string).startsWith('decision:'))
        c.fail(event, 'PC1B-DEC10', 'missing-target', 'payload');
    } else {
      const parsed = c.schema(event, 'payload', 'PC1B-DEC10', p0LiveCompletionSchema, payload);
      const record = c.find('decision_records', execution.values.decision_id!);
      const action = record && c.find('decision_action_requests', record.values.action_request_id!);
      const history = c.find('task_history', execution.values.task_history_id!);
      if (!record || !action || !history) c.fail(event, 'PC1B-DEC10', 'missing-target', 'payload');
      const envelope = c.json(action, 'candidate_envelope_json', 'PC1B-DEC10') as CObject;
      const candidate = envelope.task as CObject, member = c.find('members', candidate.assigneeMemberId as string);
      const detail = c.json(history, 'detail', 'PC1B-DEC10') as CObject;
      if (!cObject(detail) || !cObject(detail.decision)) c.invalid(history, 'PC1B-DEC10', 'detail');
      const decision = detail.decision, previous = detail.previousDecision;
      const ref = { decisionId: record.values.id, projectId: record.values.project_id,
        revision: record.values.revision, actionDigest: record.values.action_digest };
      const sameSlot = (row: CRow) => ['project_id', 'task_id', 'round_id'].every(key => row.values[key] === execution.values[key]);
      chargeP0(c.request, { work: 96, bytes: (c.bytes(event) + c.bytes(execution)) * 2 }, c.site(event, 'PC1B-DEC10'));
      const ids = c.json(execution, 'work_event_ids_json', 'PC1B-DEC10') as string[];
      if (execution.values.status !== 'succeeded' || execution.values.decision_id !== record.values.id
        || record.values.action_request_id !== action.values.id || !sameSlot(record) || !sameSlot(action)
        || history.values.project_id !== execution.values.project_id || history.values.task_id !== execution.values.task_id
        || history.values.action !== 'task.review_decided' || history.values.task_revision !== execution.values.after_task_revision
        || ids.length !== 1 || ids[0] !== event.values.id || !member || member.values.id !== candidate.assigneeMemberId
        || member.values.project_id !== execution.values.project_id || event.values.project_id !== execution.values.project_id
        || event.values.task_id !== execution.values.task_id || event.values.recipient_member_id !== member.values.id
        || event.values.event_key !== `decision:${record.values.id}:effect`)
        c.fail(event, 'PC1B-DEC10', 'immutable-history-mismatch', 'payload', execution);
      if (previous !== null) {
        if (!cObject(previous)) c.invalid(history, 'PC1B-DEC10', 'detail');
        const key = [execution.values.project_id!, execution.values.task_id!, execution.values.before_task_revision!] as const;
        const prior = previousHistories.get(key);
        if (!prior || historyCounts.get(key)?.count !== 1 || !['pass', 'changes_requested'].includes(previous.verdict as string)
          || previous.taskRevision !== execution.values.before_task_revision) c.fail(history, 'PC1B-DEC10', 'missing-target', 'detail');
        const priorDetail = c.json(prior, 'detail', 'PC1B-DEC10') as CObject;
        if (!cObject(priorDetail) || priorDetail.roundId !== execution.values.round_id || !c.equal(priorDetail.decision, previous, history, 'PC1B-DEC10', 'detail'))
          c.fail(history, 'PC1B-DEC10', 'immutable-history-mismatch', 'detail', prior);
      }
      if (detail.roundId !== execution.values.round_id || !c.equal(detail.decisionRef ?? decision.decisionRef, ref, event, 'PC1B-DEC10', 'payload')
        || decision.verdict !== execution.values.verdict || parsed.taskId !== execution.values.task_id
        || parsed.revision !== execution.values.after_task_revision || parsed.roundId !== execution.values.round_id
        || !c.equal(parsed.decisionRef ?? parsed.decision.decisionRef, ref, event, 'PC1B-DEC10', 'payload')
        || !c.equal(parsed.decision, decision, event, 'PC1B-DEC10', 'payload') || parsed.completionRevision !== execution.values.after_task_revision
        || parsed.assigneeAgentId !== (member!.values.kind === 'agent' ? member!.values.agent_id : null)
        || parsed.enteredDone !== (execution.values.verdict === 'pass' && (cObject(previous) ? previous.verdict : null) !== 'pass'))
        c.fail(event, 'PC1B-DEC10', 'immutable-history-mismatch', 'payload', execution);
    }
    values.set(event.origin, Object.freeze({ branch: execution ? 'decision' : 'legacy', event: event.origin,
      execution: execution?.origin ?? null, projectId: event.values.project_id as string, taskId: event.values.task_id as string | null,
      recipientMemberId: event.values.recipient_member_id as string, enteredDone: payload.enteredDone === true,
      completionRevision: typeof payload.completionRevision === 'number' && Number.isSafeInteger(payload.completionRevision) && payload.completionRevision > 0
        ? payload.completionRevision : null,
      assigneeAgentId: typeof payload.assigneeAgentId === 'string' ? payload.assigneeAgentId : null,
      invalidated: c.find('work_event_delivery_invalidations', event.values.id!, 'work_event_id') !== undefined }));
  }
  const index = Object.freeze({}) as P0CompletionIndex;
  indexes.set(index, { request: c.request, view: c.view, values }); return index;
}

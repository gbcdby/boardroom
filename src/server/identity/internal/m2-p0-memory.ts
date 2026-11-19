import { getMemoryRowFailure, validateLegacyMemoryRows } from '../../storage/maintenance/layout-memory-inventory.ts';
import type { MemoryRowsInput } from '../../storage/maintenance/layout-memory-inventory.ts';
import { getLayoutValueErrorCode } from '../../storage/maintenance/layout-values.ts';
import { chargeP0, createP0TupleIndex, failP0 } from './m2-p0.ts';
import { lookupP0CompletionSource } from './m2-p0-completion.ts';
import type { P0CompletionIndex, P0CompletionSource } from './m2-p0-completion.ts';
import type { P0Rule } from './m2-p0.ts';
import { dClosed, dObject, P0DContext } from './m2-p0-d-context.ts';
import type { DObject, DRow } from './m2-p0-d-context.ts';
import { noteDAvailability } from './m2-p0-audit.ts';
import type { P0DAvailability } from './m2-p0-audit.ts';

const TRIGGERS = ['task_completed', 'message_threshold', 'session_end', 'retry'];
const memoryId = (value: unknown): value is string => typeof value === 'string' && value.length <= 512 && value.trim().length > 0 && !value.includes('\0');
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const safePositive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

function reserveRowCore(c: P0DContext, row: DRow, rule: P0Rule, authorColumn?: string): void {
  // Fixed legacy schemas: at most 25 scalar fields and one flat four-field
  // author; reserve Zod's typed clone, the row projection and finite indexes.
  chargeP0(c.request, { work: 256, nodes: 80, tuples: 24 }, c.site(row, rule));
  for (const [column, value] of Object.entries(row.values)) {
    if (typeof value !== 'string') continue;
    if (column === 'markdown') {
      // byteLength + UTF-8 allocation + SHA-256 + the two possible exact byte
      // comparisons (same-digest version and document head), including operands.
      chargeP0(c.request, { bytes: value.length * 2 + c.bytes(row, column) * 7 }, c.site(row, rule, column));
    } else if (column === authorColumn) {
      chargeP0(c.request, { bytes: value.length * 8 }, c.site(row, rule, column));
    } else {
      // Three fixed tuple encodings/maps and bounded schema string scans. JSON
      // quoting may expand a UTF-16 unit sixfold; reserve before those natives.
      chargeP0(c.request, { bytes: value.length * 48 }, c.site(row, rule, column));
    }
  }
}
function requireProjectAgent(c: P0DContext, row: DRow, rule: P0Rule): void {
  const project = c.id(row, 'project_id', rule), agent = c.id(row, 'agent_id', rule);
  if (!c.find('projects', project)) c.fail(row, rule, 'missing-target', 'project_id');
  if (!c.find('agents', agent)) c.fail(row, rule, 'missing-target', 'agent_id');
}
function matchDocumentKey(c: P0DContext, row: DRow, document: DRow, rule: P0Rule, column: string): void {
  if (document.values.scope !== 'project-agent' || !c.same(row.values.project_id, document.values.project_id)
    || !c.same(row.values.agent_id, document.values.agent_id)) c.fail(row, rule, 'scope-mismatch', column, document);
}
function evidence(c: P0DContext, row: DRow): DObject | null {
  const value = c.json(row, 'evidence', 'PC1B-MEM02');
  if (value === null) return null;
  chargeP0(c.request, { work: 40, bytes: c.bytes(row, 'evidence') * 8 }, c.site(row, 'PC1B-MEM02', 'evidence'));
  if (!dClosed(value, ['provenance', 'host', 'hostVersion', 'invocationId', 'contextId', 'startedAt', 'completedAt', 'promptSha256', 'outputSha256', 'evidenceRef'])
    || value.provenance !== 'agent-declared') c.invalid(row, 'PC1B-MEM02', 'evidence');
  for (const name of ['host', 'hostVersion', 'invocationId', 'contextId', 'evidenceRef']) {
    const text = value[name];
    if (typeof text !== 'string' || text.length > 8192 || !text.trim() || text.includes('\0')) c.invalid(row, 'PC1B-MEM02', 'evidence');
  }
  if (typeof value.promptSha256 !== 'string' || typeof value.outputSha256 !== 'string'
    || !/^[a-f0-9]{64}$/i.test(value.promptSha256) || !/^[a-f0-9]{64}$/i.test(value.outputSha256)
    || typeof value.startedAt !== 'string' || typeof value.completedAt !== 'string') c.invalid(row, 'PC1B-MEM02', 'evidence');
  const start = Date.parse(value.startedAt), end = Date.parse(value.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) c.invalid(row, 'PC1B-MEM02', 'evidence');
  return value;
}

export function checkP0Memory(c: P0DContext, completion: P0CompletionIndex, availability: P0DAvailability[]): void {
  const sources = new WeakMap<DRow, P0CompletionSource | null>();
  // Every actual event identity is checked against C's request/view-bound token.
  // An empty event set is vacuous and creates no fake event or substitute proof.
  for (const row of c.rows('work_events')) sources.set(row, lookupP0CompletionSource(c.request, c.view, completion, row.origin));
  const documents = c.rows('memory_documents'), versions = c.rows('memory_versions'), requests = c.rows('memory_summary_requests');
  const input: MemoryRowsInput = {
    documents: documents.map(row => { reserveRowCore(c, row, 'PC1B-MEM01', 'updated_by'); return { row: row.values, author: c.json(row, 'updated_by', 'PC1B-MEM01') }; }),
    versions: versions.map(row => { reserveRowCore(c, row, 'PC1B-MEM01', 'author'); return { row: row.values, author: c.json(row, 'author', 'PC1B-MEM01') }; }),
    summaries: requests.map(row => { reserveRowCore(c, row, 'PC1B-MEM02'); return row.values; }),
  };
  // Native sort in the shared core: the full comparator bound is reserved using
  // original document/version IDs, not only the number of surviving head rows.
  let idUnits = 0;
  for (const row of versions) idUnits += (typeof row.values.id === 'string' ? row.values.id.length : 0)
    + (typeof row.values.document_id === 'string' ? row.values.document_id.length : 0);
  chargeP0(c.request, { work: versions.length * versions.length, bytes: idUnits * 4 * versions.length, tuples: versions.length });
  let checked: ReturnType<typeof validateLegacyMemoryRows>;
  try { checked = validateLegacyMemoryRows(input); }
  catch (error) {
    const code = getLayoutValueErrorCode(error), failure = getMemoryRowFailure(error);
    if (code !== undefined) {
      const row = failure && c.originalRow(failure.row), rule = row?.origin.table === 'memory_summary_requests' ? 'PC1B-MEM02' : 'PC1B-MEM01';
      if (code === 'budget_exceeded') failP0(c.request, { code: 'resource_limit', rule, ...(row ? { site: c.site(row, rule, failure!.column) } : {}) });
      if (row) c.fail(row, rule, code === 'incomplete_inventory' ? 'history-gap' : 'immutable-history-mismatch', failure!.column);
      failP0(c.request, { code: 'semantic_invariant_failed', rule, condition: 'count-mismatch' });
    }
    throw error;
  }
  const byKey = createP0TupleIndex<DRow>(c.request), versionBySlot = createP0TupleIndex<DRow>(c.request);
  for (const row of documents) {
    for (const column of ['id', 'project_id', 'agent_id']) c.id(row, column, 'PC1B-MEM01', column !== 'id');
    if (row.values.project_id !== null && !c.find('projects', row.values.project_id!)) c.fail(row, 'PC1B-MEM01', 'missing-target', 'project_id');
    if (row.values.agent_id !== null && !c.find('agents', row.values.agent_id!)) c.fail(row, 'PC1B-MEM01', 'missing-target', 'agent_id');
    if (byKey.insert([row.values.scope!, row.values.project_id!, row.values.agent_id!], row)) c.fail(row, 'PC1B-MEM01', 'duplicate-key', 'scope');
  }
  for (const row of versions) {
    versionBySlot.insert([row.values.document_id!, row.values.version!], row);
    const old = row.values.summary_request_id;
    if (old === null) continue;
    const summary = c.find('memory_summary_requests', old!), document = c.find('memory_documents', row.values.document_id!)!;
    if (summary) {
      if (document.values.scope !== 'project-agent' || !c.same(summary.values.project_id, document.values.project_id)
        || !c.same(summary.values.agent_id, document.values.agent_id))
        c.fail(row, 'PC1B-MEM02', 'scope-mismatch', 'summary_request_id', summary);
    } else noteDAvailability(c, availability, row, 'PC1B-MEM02', 'summary_request_id', 'missing-soft-source');
  }
  // Core has proved every actual body hash. This per-pass map is a value index;
  // it is not a cross-request/pass semantic-success cache.
  const bodyHashes = new WeakMap<object, string>();
  for (const version of checked.versions) { chargeP0(c.request, { work: 1, tuples: 1 }); bodyHashes.set(version.row, version.bodySha256); }
  for (const row of requests) {
    const rule = 'PC1B-MEM02'; requireProjectAgent(c, row, rule);
    for (const column of ['id', 'recipient_member_id', 'trigger_key']) c.id(row, column, rule);
    for (const column of ['context_group_id', 'document_id', 'task_id', 'source_work_event_id', 'retry_of_request_id', 'attempt_id', 'begin_mutation_id']) c.id(row, column, rule, true);
    const recipient = c.sameScope(row, c.find('members', row.values.recipient_member_id!), rule, 'recipient_member_id');
    if (recipient.values.kind !== 'agent' || !c.same(recipient.values.agent_id, row.values.agent_id)) c.fail(row, rule, 'identity-mismatch', 'recipient_member_id', recipient);
    if (row.values.context_group_id !== null) c.sameScope(row, c.find('groups', row.values.context_group_id!), rule, 'context_group_id');
    if (row.values.task_id !== null) c.sameScope(row, c.find('tasks', row.values.task_id!), rule, 'task_id');
    if (row.values.document_id !== null) {
      const document = c.find('memory_documents', row.values.document_id!);
      if (!document) c.fail(row, rule, 'missing-target', 'document_id');
      matchDocumentKey(c, row, document, rule, 'document_id');
    }
    const messages = c.json(row, 'message_ids', 'PC1B-MEM03');
    if (!Array.isArray(messages)) c.invalid(row, 'PC1B-MEM03', 'message_ids');
    chargeP0(c.request, { work: messages.length + 1, bytes: c.bytes(row, 'message_ids') * 4 }, c.site(row, 'PC1B-MEM03', 'message_ids'));
    if (!messages.every(memoryId)) c.invalid(row, 'PC1B-MEM03', 'message_ids');
    for (const id of messages) {
      const message = c.find('messages', id);
      if (!message) { noteDAvailability(c, availability, row, 'PC1B-MEM03', 'message_ids', 'missing-soft-source'); continue; }
      const group = c.find('groups', message.values.group_id!);
      if (!group || !c.same(group.values.project_id, row.values.project_id)
        || row.values.context_group_id !== null && !c.same(message.values.group_id, row.values.context_group_id))
        c.fail(row, rule, 'scope-mismatch', 'message_ids', message);
    }
    const error = c.json(row, 'error', rule);
    chargeP0(c.request, { work: 8, bytes: c.bytes(row, 'error') * 2 }, c.site(row, rule, 'error'));
    if (error !== null && (!dClosed(error, ['code', 'message']) || typeof error.code !== 'string' || typeof error.message !== 'string')) c.invalid(row, rule, 'error');
    const executed = evidence(c, row);
    if (executed !== null && row.values.state !== 'completed') c.fail(row, rule, 'state-mismatch', 'evidence');
    if (row.values.result_sha256 !== null && (typeof row.values.result_sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(row.values.result_sha256))) c.invalid(row, rule, 'result_sha256');
    if (row.values.state === 'completed') {
      const document = byKey.get(['project-agent', row.values.project_id!, row.values.agent_id!]);
      if (!document) c.fail(row, rule, 'missing-target', 'result_version');
      const version = versionBySlot.get([document.values.id!, row.values.result_version!]);
      if (!version) c.fail(row, rule, 'missing-target', 'result_version', document);
      if (!c.same(version.values.summary_request_id, row.values.id) || !c.same(row.values.result_sha256, bodyHashes.get(version.values)))
        c.fail(row, rule, 'immutable-history-mismatch', 'result_version', version);
      if (executed && !c.same(executed.outputSha256 as string, row.values.result_sha256)) c.fail(row, rule, 'bytes-mismatch', 'evidence', version);
    }
    if (row.values.retry_of_request_id !== null) {
      const previous = c.find('memory_summary_requests', row.values.retry_of_request_id!);
      if (!previous) noteDAvailability(c, availability, row, rule, 'retry_of_request_id', 'missing-soft-source');
      else if (previous === row || !c.same(previous.values.project_id, row.values.project_id) || !c.same(previous.values.agent_id, row.values.agent_id)
        || !c.same(previous.values.task_id, row.values.task_id) || !c.same(previous.values.context_group_id, row.values.context_group_id)
        || !c.same(previous.values.source_work_event_id, row.values.source_work_event_id)) c.fail(row, rule, 'scope-mismatch', 'retry_of_request_id', previous);
    }
    if (row.values.source_work_event_id !== null) {
      const event = c.find('work_events', row.values.source_work_event_id!);
      if (!event) noteDAvailability(c, availability, row, rule, 'source_work_event_id', 'missing-soft-source');
      else {
        const source = sources.get(event);
        if (!source || !c.same(source.projectId, row.values.project_id) || !c.same(source.taskId, row.values.task_id)
          || !c.same(source.recipientMemberId, row.values.recipient_member_id) || !c.same(source.assigneeAgentId, row.values.agent_id)
          || !source.enteredDone || source.completionRevision === null) c.fail(row, 'PC1B-MEM04', 'source-mismatch', 'source_work_event_id', event);
        if (row.values.trigger === 'task_completed') {
          chargeP0(c.request, { work: 1, bytes: ((source.taskId?.length ?? 0) + (source.assigneeAgentId?.length ?? 0) + 64) * 4 }, c.site(row, 'PC1B-MEM04', 'trigger_key'));
          if (row.values.completed_task_revision !== source.completionRevision
            || !c.same(row.values.trigger_key, `task:${source.taskId}:done:${source.completionRevision}:agent:${source.assigneeAgentId}`))
            c.fail(row, 'PC1B-MEM04', 'immutable-history-mismatch', 'trigger_key', event);
        }
        // source.invalidated is current eligibility, not a prohibition on
        // already-created historical requests. ACK and current Task are absent.
      }
    }
  }
  checkScans(c);
  for (const row of c.rows('work_events')) if (row.values.kind === 'memory.summary_requested') {
    const rule = 'PC1B-MEM05', value = c.json(row, 'payload', rule);
    chargeP0(c.request, { work: 24, bytes: c.bytes(row, 'payload') * 6 }, c.site(row, rule, 'payload'));
    if (!dClosed(value, ['requestId', 'requestRevision', 'trigger']) || !memoryId(value.requestId) || !safePositive(value.requestRevision)
      || typeof value.trigger !== 'string' || !TRIGGERS.includes(value.trigger)) c.invalid(row, rule, 'payload');
    const request = c.find('memory_summary_requests', value.requestId);
    if (!request) c.fail(row, rule, 'missing-target', 'payload');
    if (row.values.task_id !== null || !c.same(row.values.project_id, request.values.project_id)
      || !c.same(row.values.recipient_member_id, request.values.recipient_member_id) || !c.same(row.values.context_group_id, request.values.context_group_id)
      || !c.same(value.trigger, request.values.trigger) || value.requestRevision > (request.values.revision as number)) c.fail(row, rule, 'immutable-history-mismatch', 'payload', request);
    chargeP0(c.request, { work: 2, bytes: value.requestId.length * 4 + 128 }, c.site(row, rule, 'event_key'));
    if (!c.same(row.values.id, `memory-summary:${value.requestId}`) || !c.same(row.values.event_key, `memory.summary_requested:${value.requestId}`))
      c.fail(row, rule, 'identity-mismatch', 'event_key', request);
  }
}

function checkScans(c: P0DContext): void {
  const rule = 'PC1B-MEM03';
  for (const table of ['memory_message_receipts', 'memory_trigger_counters', 'memory_scan_checkpoints'] as const) for (const row of c.rows(table)) {
    chargeP0(c.request, { work: 32 }, c.site(row, rule)); requireProjectAgent(c, row, rule);
    c.id(row, 'group_id', rule, table === 'memory_scan_checkpoints');
    if (row.values.group_id !== null) c.sameScope(row, c.find('groups', row.values.group_id!), rule, 'group_id');
    if (table === 'memory_message_receipts') {
      c.id(row, 'message_id', rule); c.integer(row, 'counter_value', rule); c.text(row, 'first_observed_at', rule);
      const message = c.find('messages', row.values.message_id!);
      if (!message) c.fail(row, rule, 'missing-target', 'message_id');
      if (!c.same(message.values.group_id, row.values.group_id)) c.fail(row, rule, 'scope-mismatch', 'message_id', message);
    } else if (table === 'memory_trigger_counters') {
      for (const column of ['lifetime_count', 'threshold_sequence']) c.integer(row, column, rule, 0);
      for (const column of ['next_threshold', 'configured_n', 'revision']) c.integer(row, column, rule);
      if ((row.values.configured_n as number) > 10000) c.invalid(row, rule, 'configured_n');
    } else {
      c.integer(row, 'sweep', rule, 0); c.integer(row, 'revision', rule); c.text(row, 'updated_at', rule); c.text(row, 'id', rule);
      if (row.values.kind !== 'message_threshold' && row.values.kind !== 'task_completed'
        || (row.values.kind === 'task_completed') !== (row.values.group_id === null)) c.fail(row, rule, 'scope-mismatch', 'kind');
      const tuple = [row.values.kind, row.values.project_id, row.values.agent_id, row.values.group_id];
      chargeP0(c.request, { work: 5, bytes: tuple.reduce<number>((total, item) => total + (typeof item === 'string' ? item.length * 36 : 16), 32) }, c.site(row, rule, 'id'));
      if (!c.same(row.values.id, JSON.stringify(tuple))) c.fail(row, rule, 'identity-mismatch', 'id');
      const cursors = ['after_cursor', 'through_cursor'].map(column => {
        const value = c.json(row, column, rule);
        chargeP0(c.request, { work: 8, bytes: c.bytes(row, column) * 8 }, c.site(row, rule, column));
        if (value !== null && (!dClosed(value, ['at', 'id']) || !nonempty(value.at) || !nonempty(value.id))) c.invalid(row, rule, column);
        return value as { at: string; id: string } | null;
      });
      const [after, through] = cursors;
      if (after && (!through || after.at > through.at || after.at === through.at && after.id > through.id)) c.fail(row, rule, 'state-mismatch', 'after_cursor');
    }
  }
}

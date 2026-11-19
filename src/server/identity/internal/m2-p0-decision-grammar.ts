import { DECISION_TABLES, DECISION_TABLE_NAMES } from '../../decisions/tables.ts';
import { TEXT_COLUMNS, validateCopyRow, createDecisionDecodedFrame, assertDecisionDecodedFrame } from '../../decisions/text-codec.ts';
import type { DecisionDecodedFrame } from '../../decisions/text-codec.ts';
import { getStorageInvalidIdentity } from '../../decisions/storage-error.ts';
import { validateDecisionStorageGraph } from '../../decisions/storage-validation.ts';
import { chargeP0, createP0TupleIndex, failP0 } from './m2-p0.ts';
import type { P0Rule, P0Table } from './m2-p0.ts';
import { cObject, type CObject, type CRow, P0CContext } from './m2-p0-c-shadow.ts';

const decisionFrames = new WeakMap<P0CContext,DecisionDecodedFrame>();

const TEXT_RULE: Readonly<Record<string, P0Rule>> = Object.freeze({
  'decision_action_requests.action_json': 'PC1B-DEC02',
  'decision_action_requests.candidate_envelope_json': 'PC1B-DEC02',
  'decision_action_requests.proposal_reason_json': 'PC1B-DEC02',
  'decision_records.policy_evaluation_json': 'PC1B-DEC03',
  'decision_resolutions.policy_evaluation_json': 'PC1B-DEC03',
  'decision_resolutions.permission_snapshot_json': 'PC1B-DEC03',
  'decision_resolutions.reason_json': 'PC1B-DEC06',
  'decision_user_events.command_json': 'PC1B-DEC04',
  'decision_command_receipts.response_json': 'PC1B-DEC04',
  'decision_executions.work_event_ids_json': 'PC1B-DEC10',
});
const STAGE_RULE: Readonly<Record<string, P0Rule>> = Object.freeze({
  record_binding: 'PC1B-DEC08', subject_binding: 'PC1B-DEC08', round_spec: 'PC1B-DEC08', candidate_identity: 'PC1B-DEC08',
  report_binding: 'PC1B-DEC08', content_digest: 'PC1B-DEC08', missing_head: 'PC1B-DEC05', predecessor: 'PC1B-DEC05',
  initial_generation: 'PC1B-DEC05', terminal_graph_incomplete: 'PC1B-DEC05', missing_or_changed_action: 'PC1B-DEC05',
  head_slot_or_generation: 'PC1B-DEC05', input_ref: 'PC1B-DEC09', input_record: 'PC1B-DEC09', result_ref: 'PC1B-DEC09',
  receipt_binding: 'PC1B-DEC06', missing_receipt: 'PC1B-DEC06', resolution_input_binding: 'PC1B-DEC06',
  receipt_reason_or_fingerprint: 'PC1B-DEC06', execution_binding: 'PC1B-DEC06', execution_slot_binding: 'PC1B-DEC06',
  receipt_execution_values: 'PC1B-DEC06', legacy_input_revisions: 'PC1B-DEC06', action_execution_values: 'PC1B-DEC06',
  command_choice_binding: 'PC1B-DEC06', no_effect_row_has_effect: 'PC1B-DEC06', execution_shape: 'PC1B-DEC06',
  human_authority_required: 'PC1B-DEC07', source_receipt_cycle: 'PC1B-DEC07', source_binding: 'PC1B-DEC07',
  false_human_source: 'PC1B-DEC07', consumption: 'PC1B-DEC07', actual_history: 'PC1B-DEC10', history_values: 'PC1B-DEC10',
  completion_event_set: 'PC1B-DEC10', actual_event: 'PC1B-DEC10', completion_binding: 'PC1B-DEC10',
  previous_effect_binding: 'PC1B-DEC10', completion_values: 'PC1B-DEC10', not_applied: 'PC1B-DEC11',
  actual_projection: 'PC1B-DEC11', source_row: 'PC1B-DEC11', source_values: 'PC1B-DEC11',
  cursor: 'PC1B-DEC12', decision_revision: 'PC1B-DEC12',
});

function copyRule(table: P0Table, column: string, stage: string): P0Rule {
  const textRule = TEXT_RULE[column];
  if (textRule) return textRule;
  if (table === 'decision_legacy_records' && ['raw_text', 'raw_digest', 'diagnostics_json'].some(key => column === `${table}.${key}`))
    return 'PC1B-DEC11';
  if (stage === 'binding_or_digest') {
    if (table === 'decision_action_requests') return 'PC1B-DEC02';
    if (table === 'decision_resolutions') return 'PC1B-DEC03';
    if (table === 'decision_user_events' || table === 'decision_command_receipts') return 'PC1B-DEC04';
  }
  return 'PC1B-DEC01';
}

function rowFailure(c: P0CContext, row: CRow, error: unknown): never {
  const identity = getStorageInvalidIdentity(error);
  if (!identity) throw error;
  const column = identity.column.startsWith(`${row.origin.table}.`) ? identity.column.slice(row.origin.table.length + 1) : undefined;
  const spec = DECISION_TABLES.find(table => table.name === row.origin.table)!;
  const knownColumn = spec.columns.some(item => item.name === column) ? column : undefined;
  const rule = copyRule(row.origin.table, identity.column, identity.stage);
  return c.invalid(row, rule, knownColumn);
}

/** One real decoder per registered field in this pass. Six tree equivalents and
 * 48 byte traversals cover parse/schema/normalization, owned-value freezing,
 * canonical output and digests. Later calls still check raw rows/equalities but
 * obtain the exact decoded values and derived encodings from the private frame. */
function reserveRow(c: P0CContext, row: CRow): void {
  let nodes = 0, fields = 0;
  for (const key of TEXT_COLUMNS) {
    if (!key.startsWith(`${row.origin.table}.`)) continue;
    const column = key.slice(row.origin.table.length + 1);
    const value = c.json(row, column, TEXT_RULE[key]!);
    nodes += c.nodeCount(value); fields++;
    if (key === 'decision_action_requests.candidate_envelope_json' && cObject(value) && cObject(value.task))
      c.reserveStringSort(value.task.labels, undefined, 2, c.site(row, 'PC1B-DEC02', column));
  }
  if (row.origin.table === 'decision_legacy_records') {
    nodes += c.nodeCount(c.json(row, 'diagnostics_json', 'PC1B-DEC11'));
    const raw = c.json(row, 'raw_text', 'PC1B-DEC11');
    nodes += c.nodeCount(raw); c.reserveCanonicalKeys(raw, 4, c.site(row, 'PC1B-DEC11', 'raw_text'));
  }
  chargeP0(c.request, { bytes: c.bytes(row) * 48, work: nodes * 32 + 128, nodes: nodes * 6,
    tuples: fields * 3 + 1 }, c.site(row, 'PC1B-DEC01'));
}

/** Both old graph entry and binding entry still execute validateCopyRow.
 * They no longer parse/clone/re-encode registered TEXT. Sixteen row-byte scans
 * cover their two raw scalar passes, repeated legacy raw hashes/diagnostics and
 * comparisons with the saved encoding results. No semantic-success bit exists.
 * Logical execution construction and its schema clone are reserved separately. */
function reserveReusedRow(c: P0CContext, row: CRow): void {
  chargeP0(c.request, { bytes: c.bytes(row) * 16, work: 256 }, c.site(row, 'PC1B-DEC01'));
}

export function prepareP0DecisionRows(c: P0CContext): void {
  chargeP0(c.request, { work: 61 * 4, tuples: 1 });
  const tables = Object.keys(c.graph), count = tables.reduce((sum, table) => sum + c.graph[table]!.length, 0);
  chargeP0(c.request, { work: tables.length * 16 + count * 64, tuples: count + tables.length });
  const frame = createDecisionDecodedFrame(c.graph, c.request, c.view, c);
  decisionFrames.set(c, frame);
  for (const name of DECISION_TABLE_NAMES) for (const row of c.rows(name as P0Table)) {
    // A proves exact SQL scalar representation and lexical JSON before any legacy parser.
    reserveRow(c, row);
    try { validateCopyRow(name, row.values, frame); } catch (error) { rowFailure(c, row, error); }
  }
  // Stored policy identities protect their exact historical version, never current authority.
  const versions = createP0TupleIndex<CRow>(c.request);
  for (const row of c.rows('policy_document_versions')) versions.insert([row.values.document_id!, row.values.revision!], row);
  for (const table of ['decision_records', 'decision_resolutions'] as const) for (const row of c.rows(table)) {
    const observation = c.json(row, 'policy_evaluation_json', 'PC1B-DEC03') as CObject;
    const policy = observation.policy as CObject;
    for (const [key, documentId] of [['global', 'user'], ['project', `project:${row.values.project_id}`]] as const) {
      const ref = policy[key]; if (ref === null) continue;
      if (!cObject(ref)) c.invalid(row, 'PC1B-DEC03', 'policy_evaluation_json');
      const version = versions.get([documentId, ref.revision as number]);
      if (!version) c.fail(row, 'PC1B-DEC03', 'missing-target', 'policy_evaluation_json');
      if (version.values.content_digest !== ref.contentDigest) c.fail(row, 'PC1B-DEC03', 'identity-mismatch', 'policy_evaluation_json', version);
    }
  }
}

/** Consume the real legacy graph validator after scalar/grammar preparation. */
export function consumeP0DecisionGraph(c: P0CContext): void {
  const frame = decisionFrames.get(c)!;
  assertDecisionDecodedFrame(frame, c.graph, c.request, c.view, c);
  const n = (name: P0Table) => c.rows(name).length;
  const fieldBytes = new Map<string, number>();
  const lengths = (table: P0Table, columns: readonly string[]): number => {
    const key = `${table}.${columns.join(',')}`, cached = fieldBytes.get(key);
    if (cached !== undefined) return cached;
    chargeP0(c.request, { work: n(table) * columns.length });
    let bytes = 0;
    for (const row of c.rows(table)) for (const column of columns) {
      const value = row.values[column]; if (typeof value === 'string') bytes += value.length * 2;
    }
    fieldBytes.set(key, bytes); return bytes;
  };
  const crossBytes = (left: P0Table, leftColumns: readonly string[], right: P0Table, rightColumns: readonly string[]) =>
    lengths(left, leftColumns) * n(right) + lengths(right, rightColumns) * n(left);
  const actions = n('decision_action_requests'), records = n('decision_records'), executions = n('decision_executions');
  const resolutions = n('decision_resolutions'), initiations = n('decision_local_initiations');
  // These are actual filter/find/some loops in the frozen consumer, including the
  // legacy byId reconstruction per record, not an assumed linear graph pass.
  const products = actions * records + records * n('decision_review_heads') + initiations * resolutions
    + n('decision_user_events') * initiations + executions * (n('members') + n('task_history'))
    + n('decision_review_projections') * executions + n('decision_change_heads') * n('decision_changes')
    + n('decision_changes') * n('decision_change_heads')
    + n('decision_legacy_records') * (n('task_history') + n('task_review_rounds'));
  const slots = ['project_id', 'task_id', 'round_id'];
  const comparisonBytes = crossBytes('decision_action_requests', ['id'], 'decision_records', ['action_request_id'])
    + crossBytes('decision_records', slots, 'decision_review_heads', slots)
    + crossBytes('decision_local_initiations', ['id'], 'decision_resolutions', ['initiation_id'])
    + crossBytes('decision_user_events', ['id'], 'decision_local_initiations', ['user_event_id'])
    // The compared candidate assignee has already passed the fixed max-200 Id codec.
    + executions * (n('members') * 400 + lengths('members', ['id']))
    + crossBytes('decision_executions', ['project_id', 'task_id'], 'task_history', ['project_id', 'task_id', 'action'])
    + crossBytes('decision_review_projections', ['execution_id'], 'decision_executions', ['id'])
    + crossBytes('decision_change_heads', ['project_id'], 'decision_changes', ['project_id']) * 2
    + n('decision_legacy_records') * (lengths('task_history', ['id']) + lengths('task_review_rounds', ['id']));
  let rows = 0, bytes = 0;
  for (const table of DECISION_TABLE_NAMES) for (const row of c.rows(table as P0Table)) {
    reserveReusedRow(c, row); rows++; bytes += c.bytes(row);
  }
  // These parses/hashes are per reference occurrence, not per unique source row:
  // multiple historical actions can reference the same round/report.
  let semanticNodes = 0, semanticBytes = 0, executionNodes = 0;
  const read = (row: CRow | undefined, columns: readonly string[], count = 1): void => {
    if (!row) return;
    for (const column of columns) {
      if (row.values[column] === null) continue;
      semanticNodes += c.nodeCount(c.json(row, column, 'PC1B-DEC10')) * count;
      semanticBytes += c.bytes(row, column) * count;
    }
  };
  for (const action of c.rows('decision_action_requests')) {
    read(c.find('task_review_rounds', action.values.round_id!), ['spec_snapshot', 'candidate']);
    const envelope = c.json(action, 'candidate_envelope_json', 'PC1B-DEC08') as CObject;
    for (const ref of envelope.reports as CObject[]) {
      const report = c.find('task_review_reports', ref.id as string);
      read(report, ['sources', 'evidence']);
      // JSON.stringify and SHA traverse body/axis/verdict as well as parsed JSON.
      if (report) semanticBytes += c.bytes(report, 'body') + c.bytes(report, 'axis') + c.bytes(report, 'verdict');
    }
  }
  const previous = createP0TupleIndex<CRow>(c.request);
  for (const history of c.rows('task_history')) if (history.values.action === 'task.review_decided')
    previous.insert([history.values.project_id!, history.values.task_id!, history.values.task_revision!], history);
  for (const execution of c.rows('decision_executions')) {
    const ids = c.json(execution, 'work_event_ids_json', 'PC1B-DEC10') as string[];
    // executionValueFromRow builds a logical object and safeParse clones it.
    // The fixed object keys/values take at most 64 nodes over those two trees.
    executionNodes += 64 + c.nodeCount(ids) * 2;
    if (execution.values.status !== 'succeeded') continue;
    const history = c.find('task_history', execution.values.task_history_id!);
    read(history, ['detail', 'actor']);
    if (ids.length === 1) {
      read(history, ['detail']); read(c.find('work_events', ids[0]!), ['payload']);
      const detail = history && c.json(history, 'detail', 'PC1B-DEC10');
      if (cObject(detail) && cObject(detail.previousDecision))
        read(previous.get([execution.values.project_id!, execution.values.task_id!, execution.values.before_task_revision!]), ['detail'], 2);
    }
  }
  for (const projection of c.rows('decision_review_projections')) if (projection.values.source_kind === 'live') {
    const execution = c.find('decision_executions', projection.values.execution_id!);
    read(execution && c.find('task_history', execution.values.task_history_id!), ['detail']);
    read(c.find('task_review_rounds', projection.values.round_id!), ['decision']);
  }
  let targets = 0, targetBytes = 0;
  for (const table of ['projects', 'tasks', 'task_review_rounds', 'task_review_reports', 'task_history', 'work_events', 'members'] as const) {
    targets += n(table); targetBytes += lengths(table, ['id', 'project_id', 'task_id', 'round_id']);
  }
  chargeP0(c.request, { work: products * 8 + rows * 256 + semanticNodes * 16 + targets * 32,
    bytes: bytes * 4 + semanticBytes * 12 + comparisonBytes + targetBytes * 16,
    nodes: semanticNodes * 2 + executionNodes, tuples: rows * 32 + targets * 4 });
  try { validateDecisionStorageGraph(c.graph, frame); }
  catch (error) {
    const identity = getStorageInvalidIdentity(error); if (!identity) throw error;
    const rule = STAGE_RULE[identity.stage] ?? TEXT_RULE[identity.column] ?? 'PC1B-DEC01';
    const row = identity.row && c.originalRow(identity.row);
    if (row) {
      const column = identity.column.startsWith(`${row.origin.table}.`) ? identity.column.slice(row.origin.table.length + 1) : undefined;
      const fallback: Readonly<Partial<Record<P0Table, string>>> = { decision_action_requests: 'candidate_envelope_json',
        decision_records: 'status', decision_review_heads: 'current_decision_id', decision_command_receipts: 'response_json',
        decision_resolutions: 'decision_id', decision_executions: 'work_event_ids_json', decision_local_initiations: 'consumed_receipt_id',
        decision_user_events: 'id', decision_review_projections: 'execution_id', decision_legacy_records: 'raw_text',
        decision_change_heads: 'revision', decision_changes: 'decision_id' };
      const locatedColumn = column !== undefined && Object.hasOwn(row.values, column) ? column : fallback[row.origin.table];
      c.fail(row, rule, 'immutable-history-mismatch', locatedColumn);
    }
    // Only genuinely graph-wide failures (e.g. absent table) have no row scope.
    failP0(c.request, { code: 'semantic_invariant_failed', rule, condition: 'immutable-history-mismatch' });
  }
}

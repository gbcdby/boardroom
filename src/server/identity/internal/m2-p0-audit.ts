import { isReversible } from '../../audit.ts';
import { auditChainSteps, auditReversalMetadataValue, getAuditSnapshotFailure, validateAuditSnapshotPairValues } from '../../audit-compensation.ts';
import type { AuditChainValue } from '../../audit-compensation.ts';
import { getRepositoryErrorCode } from '../../db/errors.ts';
import { validateMemberSnapshotValue } from '../../org/member-relations.ts';
import { chargeP0 } from './m2-p0.ts';
import type { P0Location, P0Rule } from './m2-p0.ts';
import { dClosed, dObject, P0DContext } from './m2-p0-d-context.ts';
import type { DObject, DRow } from './m2-p0-d-context.ts';

export type P0DAvailability = Readonly<{ code: 'legacy-nonreversible-audit' | 'missing-soft-source' | 'legacy-display-unavailable'; location: P0Location }>;
const availabilityKeys = new WeakMap<P0DAvailability[], Set<string>>();
export function noteDAvailability(c: P0DContext, output: P0DAvailability[], row: DRow, rule: P0Rule,
  column: string, code: P0DAvailability['code']): void {
  chargeP0(c.request, { work: 3, bytes: 256 }, c.site(row, rule, column));
  let keys = availabilityKeys.get(output);
  const key = `${row.origin.tableOrdinal}/${row.origin.rowOrdinal}/${column}/${code}`;
  if (keys?.has(key)) return;
  chargeP0(c.request, { tuples: 2 }, c.site(row, rule, column));
  if (!keys) { keys = new Set(); availabilityKeys.set(output, keys); }
  keys.add(key);
  output.push(Object.freeze({ code, location: c.site(row, rule, column).location }));
}

/** Bounds the actual structural validator walks and native UTF-16 comparisons.
 * Member/task crossrefs and the original native ID sorts are reserved separately. */
function reserveSnapshot(c: P0DContext, row: DRow, column: string, value: unknown): void {
  const site = c.site(row, 'PC1B-AUD03', column);
  function visit(current: unknown): void {
    chargeP0(c.request, { work: 20, tuples: 4 }, site);
    if (typeof current === 'string') { chargeP0(c.request, { bytes: current.length * 20 }, site); return; }
    if (Array.isArray(current)) { for (const item of current) visit(item); return; }
    if (dObject(current)) for (const key in current) {
      chargeP0(c.request, { work: 1 }, site);
      if (Object.hasOwn(current, key)) visit(current[key]);
    }
  }
  visit(value);
  if (!dObject(value)) return;
  function sort(array: unknown, key?: string): void {
    if (!Array.isArray(array)) return;
    chargeP0(c.request, { work: array.length * array.length + array.length, tuples: array.length * 2 }, site);
    let units = 0;
    for (const item of array) {
      const text = key === undefined ? item : dObject(item) ? item[key] : undefined;
      if (typeof text === 'string') units += text.length;
    }
    chargeP0(c.request, { bytes: units * 4 * array.length }, site);
  }
  if (value.schema === 'org-graph/v2') { sort(value.directChildIds); sort(value.childEdges, 'nodeId'); sort(value.assignments, 'memberId'); }
  if (value.schema === 'org-assignment/v2') sort(value.assignments, 'memberId');
  if (value.schema === 'member-relations/v2') {
    sort(value.participants, 'groupId'); sort(value.tasks, 'taskId'); sort(value.invalidatedRounds, 'roundId');
    if (dObject(value.transient)) for (const key of ['workEventIds', 'mcpSessionIds', 'runtimeBindingIds']) sort(value.transient[key]);
    const tasks = Array.isArray(value.tasks) ? value.tasks : [], rounds = Array.isArray(value.invalidatedRounds) ? value.invalidatedRounds : [];
    chargeP0(c.request, { work: tasks.length * rounds.length * 2 }, site);
    // Each some() comparison sees both original UTF-16 identifiers. Count the
    // bounded operands before entering the shared legacy kernel.
    let taskUnits = 0, roundUnits = 0;
    for (const task of tasks) if (dObject(task)) for (const key of ['taskId', 'currentReviewRoundId']) if (typeof task[key] === 'string') taskUnits += task[key].length;
    for (const round of rounds) if (dObject(round)) for (const key of ['taskId', 'roundId']) if (typeof round[key] === 'string') roundUnits += round[key].length;
    chargeP0(c.request, { bytes: 4 * (taskUnits * rounds.length + roundUnits * tasks.length) }, site);
  }
}

/** Prove registered scalar domains before the old validators' String()/trim()
 * operations, and inspect both v2 sides even on the known missing-generation
 * branch. The original value kernel still consumes every admitted pair. */
function snapshotGrammar(c: P0DContext, row: DRow, column: string, value: unknown, rootAction: string): void {
  const rule = 'PC1B-AUD03', bad = (): never => c.invalid(row, rule, column);
  const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
  const ref = (v: unknown): boolean => v === null || text(v);
  const revision = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
  const node = (v: unknown): void => {
    if (!dObject(v) || !text(v.id) || !text(v.projectId) || !ref(v.parentId) || !text(v.name) || typeof v.role !== 'string'
      || !['top_manager', 'sub_manager', 'member'].includes(v.role) || typeof v.sortOrder !== 'number' || !Number.isFinite(v.sortOrder)
      || !text(v.createdAt) || !text(v.updatedAt)) return bad();
    if (v.id !== row.values.target_id || v.projectId !== row.values.project_id || v.parentId === v.id
      || (v.parentId === null) !== (v.role === 'top_manager')) bad();
  };
  const sorted = (ids: readonly unknown[]): void => {
    for (let i = 0; i < ids.length; i++) if (!text(ids[i]) || i > 0 && (ids[i - 1] as string) >= (ids[i] as string)) bad();
  };
  if (dObject(value) && typeof value.schema === 'string') {
    if (value.projectId !== row.values.project_id || value.targetId !== row.values.target_id) bad();
    if (value.schema === 'org-graph/v2') {
      if (!['org.node_create', 'org.node_update', 'org.node_delete'].includes(rootAction) || row.values.target_kind !== 'node') bad();
      if (value.node !== null) node(value.node);
      if (!Array.isArray(value.childEdges) || !Array.isArray(value.assignments) || !Array.isArray(value.directChildIds)
        || value.childEdges.length > 512 || value.assignments.length > 512 || value.directChildIds.length > 512) return bad();
      const childIds: string[] = [], memberIds: string[] = []; let direct = 0;
      for (const edge of value.childEdges) {
        if (!dObject(edge) || !text(edge.nodeId) || !ref(edge.parentId) || edge.nodeId === row.values.target_id || edge.nodeId === edge.parentId) bad();
        childIds.push(edge.nodeId as string);
        if (edge.parentId === row.values.target_id && value.directChildIds[direct++] !== edge.nodeId) bad();
      }
      for (const assignment of value.assignments) {
        if (!dObject(assignment) || !text(assignment.memberId) || !ref(assignment.nodeId)
          || typeof assignment.legacyRole !== 'string' || !['manager', 'normal'].includes(assignment.legacyRole)
          || assignment.membershipRevision !== undefined && !revision(assignment.membershipRevision)) bad();
        memberIds.push(assignment.memberId as string);
      }
      sorted(childIds); sorted(memberIds); sorted(value.directChildIds);
      if (direct !== value.directChildIds.length || value.node === null && direct !== 0) bad();
    } else if (value.schema === 'org-assignment/v2') {
      if (!['org.assign', 'org.auto_place'].includes(rootAction) || row.values.target_kind !== (rootAction === 'org.assign' ? 'member' : 'node')
        || !Array.isArray(value.assignments) || !value.assignments.length || value.assignments.length > 512) return bad();
      const ids: string[] = [];
      for (const assignment of value.assignments) {
        if (!dObject(assignment) || !text(assignment.memberId) || !ref(assignment.nodeId) || typeof assignment.legacyRole !== 'string'
          || !['manager', 'normal'].includes(assignment.legacyRole) || !revision(assignment.membershipRevision)) bad();
        ids.push(assignment.memberId as string);
      }
      sorted(ids); if (rootAction === 'org.assign' && !ids.includes(row.values.target_id as string)) bad();
    } else if (value.schema === 'member-status/v2') {
      if (!['member.pause', 'member.resume', 'member.status_change'].includes(rootAction) || row.values.target_kind !== 'member'
        || typeof value.status !== 'string' || !['active', 'disabled', 'pending'].includes(value.status) || !revision(value.membershipRevision)) bad();
    } else if (value.schema === 'member-relations/v2') {
      if (!['member.add', 'member.remove'].includes(rootAction) || row.values.target_kind !== 'member') bad();
      // The legacy absent branch inspects .length on every transient value;
      // JSON null must be a known grammar error, not a native TypeError.
      if (dObject(value.transient) && Object.values(value.transient).some(item => item === null)) bad();
      reserveSnapshot(c, row, column, value);
      validateMemberSnapshotValue(value, row.values.project_id as string, row.values.target_id as string);
    } else c.unsupported(row, rule, column);
    return;
  }
  if (['member.add', 'member.remove', 'org.node_delete'].includes(rootAction)) return; // explicit legacy-incomplete branch
  if (rootAction === 'org.node_create' || rootAction === 'org.node_update') { if (value !== null) node(value); return; }
  if (!dObject(value) || !text(value.id) || !text(value.projectId) || !ref(value.nodeId) || typeof value.role !== 'string'
    || !['manager', 'normal'].includes(value.role) || typeof value.status !== 'string' || !['active', 'disabled', 'pending'].includes(value.status)
    || typeof value.kind !== 'string' || !['human', 'agent'].includes(value.kind) || !ref(value.agentId)
    || !text(value.displayName) || !text(value.createdAt) || !text(value.updatedAt)) bad();
}

function snapshotPairGrammar(c: P0DContext, row: DRow, before: unknown, after: unknown): void {
  if (!dObject(before) || typeof before.schema !== 'string') return;
  if (!dObject(after) || before.schema !== after.schema) c.invalid(row, 'PC1B-AUD03', 'after');
  if (before.schema === 'org-assignment/v2') {
    const site = c.site(row, 'PC1B-AUD03', 'after');
    const left = before.assignments as DObject[], right = after.assignments as DObject[];
    chargeP0(c.request, { work: 1 }, site);
    if (left.length !== right.length) c.fail(row, 'PC1B-AUD03', 'immutable-history-mismatch', 'after');
    for (let i = 0; i < left.length; i++) {
      // Both sides have passed their registered grammar. Compare the exact
      // ordered identities and generations required by the real undo consumer.
      if (!c.same(left[i]!.memberId as string, right[i]!.memberId as string, site)
        || !c.same(left[i]!.membershipRevision as number, right[i]!.membershipRevision as number, site))
        c.fail(row, 'PC1B-AUD03', 'immutable-history-mismatch', 'after');
    }
    return;
  }
  if (before.schema === 'member-status/v2') {
    if (!c.same(before.membershipRevision as number, after.membershipRevision as number, c.site(row, 'PC1B-AUD03', 'after')))
      c.fail(row, 'PC1B-AUD03', 'immutable-history-mismatch', 'after');
    return;
  }
  if (before.schema !== 'org-graph/v2') return;
  // Both schemas have already been proved. Check all pair relations before the
  // original legacy missing-generation exception can end snapshotPair early.
  const leftChildren = before.childEdges as DObject[], rightChildren = after.childEdges as DObject[];
  const leftMembers = before.assignments as DObject[], rightMembers = after.assignments as DObject[];
  if (leftChildren.length !== rightChildren.length || leftMembers.length !== rightMembers.length
    || leftChildren.some((value, i) => value.nodeId !== rightChildren[i]!.nodeId)
    || leftMembers.some((value, i) => value.memberId !== rightMembers[i]!.memberId || value.membershipRevision !== rightMembers[i]!.membershipRevision))
    c.fail(row, 'PC1B-AUD03', 'immutable-history-mismatch', 'after');
}

/** 原消费者会为旧快照创建新的语义树，原 TEXT 的解析缓存不能支付这些分配。
 * assignment 每侧18节点；statusSnapshot 与展开后的状态树每侧各11节点；
 * graph 每侧最多15个新节点，node 本身复用已计费的原解析对象。
 * 仅预留实际分支的有界成本，不替换原验证器；retained 每次仍重新收费。 */
function reserveLegacySnapshotNodes(c: P0DContext, row: DRow, before: unknown, rootAction: string): void {
  if (dObject(before) && typeof before.schema === 'string') return;
  let nodes = 0;
  if (rootAction === 'org.assign' || rootAction === 'org.auto_place') nodes = 36;
  else if (rootAction === 'member.pause' || rootAction === 'member.resume' || rootAction === 'member.status_change') nodes = 44;
  else if (rootAction === 'org.node_create' || rootAction === 'org.node_update') nodes = 30;
  if (nodes) chargeP0(c.request, { nodes, work: 1 }, c.site(row, 'PC1B-AUD03', 'before'));
}

export function checkP0Audits(c: P0DContext, availability: P0DAvailability[]): void {
  const packets = new WeakMap<DRow, AuditChainValue>();
  for (const row of c.rows('audit_log')) {
    chargeP0(c.request, { work: 32 }, c.site(row, 'PC1B-AUD01'));
    for (const column of ['id', 'scope', 'actor_kind', 'actor_name', 'action', 'target_kind', 'target_id', 'target_name', 'created_at']) c.text(row, column, 'PC1B-AUD01');
    for (const column of ['project_id', 'actor_member_id', 'changed', 'before', 'after', 'detail', 'reversed_at', 'reversed_by_audit_id']) c.text(row, column, 'PC1B-AUD01', true);
    if (row.values.scope !== 'project' && row.values.scope !== 'user' || (row.values.scope === 'user') !== (row.values.project_id === null))
      c.fail(row, 'PC1B-AUD01', 'scope-mismatch', 'scope');
    // All four historical fields retain display compatibility; known consumers
    // below cannot turn malformed required data into a display-only success.
    for (const column of ['changed', 'before', 'after', 'detail']) {
      if (c.json(row, column, 'PC1B-AUD01', 'legacy-display') === undefined)
        noteDAvailability(c, availability, row, 'PC1B-AUD01', column, 'legacy-display-unavailable');
    }
  }
  function packet(row: DRow): AuditChainValue {
    const cached = packets.get(row); if (cached) return cached;
    if (row.values.scope !== 'project' || row.values.project_id === null) c.fail(row, 'PC1B-AUD02', 'scope-mismatch', 'project_id');
    const display = c.json(row, 'detail', 'PC1B-AUD02', 'legacy-display');
    if (display === undefined) c.unsupported(row, 'PC1B-AUD02', 'detail');
    const detail = c.json(row, 'detail', 'PC1B-AUD02', 'finite');
    if (dObject(detail) && Object.hasOwn(detail, 'reversal')) {
      if (!dClosed(detail.reversal, ['version', 'rootAuditId', 'rootAction', 'undoesAuditId', 'direction'])
        || typeof detail.reversal.direction !== 'string') c.unsupported(row, 'PC1B-AUD02', 'detail');
    }
    const values = row.values;
    const value: AuditChainValue = Object.freeze({ row: Object.freeze({ id: values.id as string, projectId: values.project_id as string,
      action: values.action as string, targetKind: values.target_kind as AuditChainValue['row']['targetKind'], targetId: values.target_id as string,
      detail: values.detail as string | null, reversedAt: values.reversed_at as string | null, reversedByAuditId: values.reversed_by_audit_id as string | null }), detail });
    packets.set(row, value); return value;
  }
  function step<T>(row: DRow, rule: P0Rule, column: string, run: () => T): T {
    try { return run(); }
    catch (error) {
      if (getRepositoryErrorCode(error) !== undefined) c.fail(row, rule, 'immutable-history-mismatch', column);
      throw error;
    }
  }
  function chainCost(row: DRow): void {
    // Each transition performs at most a fixed number of metadata/target text
    // comparisons; the predecessor's payload is consumed only on that step.
    chargeP0(c.request, { work: 64, tuples: 2, bytes: ['id', 'project_id', 'action', 'target_kind', 'target_id', 'detail', 'reversed_by_audit_id']
      .reduce((total, column) => total + c.bytes(row, column), 0) * 12 }, c.site(row, 'PC1B-AUD02', 'detail'));
  }
  for (const row of c.rows('audit_log')) {
    if (!isReversible(row.values.action as string)) continue;
    chainCost(row); const current = packet(row);
    const walker = auditChainSteps(current);
    let progress = step(row, 'PC1B-AUD02', 'detail', () => walker.next()), cursor = row;
    while (!progress.done) {
      const previous = c.find('audit_log', progress.value);
      if (!previous) c.fail(cursor, 'PC1B-AUD02', 'missing-target', 'detail');
      chainCost(previous); const next = packet(previous);
      progress = step(previous, 'PC1B-AUD02', 'detail', () => walker.next(next)); cursor = previous;
    }
    // The old no-v2/no-undoes revoke branch consumes this column as its
    // predecessor. That exact edge was proved by the shared walker above;
    // interpreting it a second time as a child would reject admitted history.
    const legacyPredecessor = ['org.revoke', 'member.revoke'].includes(current.row.action)
      && !(dObject(current.detail) && current.detail.reversal !== undefined)
      && !(dObject(current.detail) && typeof current.detail.undoes === 'string' && current.detail.undoes.trim());
    // A surviving forward reverse link is a real edge even when the walk
    // started at its root. The linked child must point back through its branch.
    if (!legacyPredecessor && row.values.reversed_by_audit_id !== null) {
      const reverse = c.find('audit_log', row.values.reversed_by_audit_id!);
      if (!reverse) c.fail(row, 'PC1B-AUD02', 'missing-target', 'reversed_by_audit_id');
      chainCost(reverse); const next = packet(reverse);
      const meta = step(reverse, 'PC1B-AUD02', 'detail', () => auditReversalMetadataValue(next.detail));
      const predecessor = meta ? meta.undoesAuditId : dObject(next.detail) && typeof next.detail.undoes === 'string' && next.detail.undoes.trim()
        ? next.detail.undoes : reverse.values.reversed_by_audit_id;
      if (row.values.reversed_at === null || !['org.revoke', 'member.revoke'].includes(next.row.action)
        || !c.same(predecessor as string | null, row.values.id) || !c.same(next.row.projectId, row.values.project_id)
        || !c.same(next.row.targetId, row.values.target_id) || !c.same(next.row.targetKind, row.values.target_kind))
        c.fail(row, 'PC1B-AUD02', 'immutable-history-mismatch', 'reversed_by_audit_id', reverse);
    } else if (!legacyPredecessor && row.values.reversed_at !== null) c.fail(row, 'PC1B-AUD02', 'missing-target', 'reversed_by_audit_id');
    const rootAction = progress.value.rootAction;
    const values = ['before', 'after'].map(column => {
      if (c.json(row, column, 'PC1B-AUD03', 'legacy-display') === undefined) c.unsupported(row, 'PC1B-AUD03', column);
      const value = c.json(row, column, 'PC1B-AUD03', 'finite'); reserveSnapshot(c, row, column, value);
      step(row, 'PC1B-AUD03', column, () => snapshotGrammar(c, row, column, value, rootAction)); return value;
    });
    snapshotPairGrammar(c, row, values[0], values[1]);
    reserveLegacySnapshotNodes(c, row, values[0], rootAction);
    try {
      const pair = validateAuditSnapshotPairValues(current.row, progress.value.rootAction, values[0], values[1]);
      // 旧 Member 由原消费者归一化后也必须满足同一代际等式；缺省仍用其 ?? 1。
      // 已带 schema 的分支已在上方检查，避免重复比较和重复收费。
      if (!dObject(values[0]) || typeof values[0].schema !== 'string')
        snapshotPairGrammar(c, row, pair.before, pair.after);
    }
    catch (error) {
      const code = getRepositoryErrorCode(error);
      if (code === 'legacy_incomplete_snapshot') noteDAvailability(c, availability, row, 'PC1B-AUD03', 'before', 'legacy-nonreversible-audit');
      else if (code !== undefined) c.fail(row, 'PC1B-AUD03', 'immutable-history-mismatch', getAuditSnapshotFailure(error)?.column ?? 'before');
      else throw error;
    }
  }
}

import { isDeepStrictEqual } from 'node:util';
import type { DbDriver } from '../db/driver.ts';
import type { RepoCtx } from '../db/repositories.ts';
import type { TasksRepository } from './repository.ts';
import { getMutationScopeCoordinator } from '../db/mutation-scope.ts';
import { RepositoryError } from '../db/errors.ts';
import type { MemberRelationsSnapshotV2 } from '../org/compensation-types.ts';
import { CaptureBudget, boundedText } from '../org/capture-budget.ts';
import { eligibleWorkEventSql, validateWorkEventInvalidations, type WorkEventInvalidationClosure } from './work-event-storage.ts';

const owners = new WeakMap<TasksRepository, { ctx: RepoCtx; db: DbDriver }>();
const permitsKey = Symbol('work-event-lifecycle-permits');
const invalid = (): never => { throw new RepositoryError('mutation_scope_changed', '工作事件失效必须消费当前生命周期事务的完整闭包。'); };
/** Installed only by the task repository factory. No HTTP/MCP method exposes this owner. */
export function registerWorkEventLifecycleOwner(repo: TasksRepository, ctx: RepoCtx, db: DbDriver): void { owners.set(repo, { ctx, db }); }
export interface PreparedWorkEventInvalidations {
  readonly auditDetail: WorkEventInvalidationClosure;
  apply(): Promise<void>;
  assertAudit(): Promise<void>;
}
/** Read-only preflight before the first lifecycle write, on the same physical client. */
export async function prepareWorkEventInvalidations(repo: TasksRepository, input: {
  before: MemberRelationsSnapshotV2; eventIds: readonly string[]; auditId: string; restored: boolean; at: string;
}): Promise<PreparedWorkEventInvalidations> {
  const owner = owners.get(repo); if (!owner) return invalid();
  const { ctx, db } = owner, context = db.currentTransactionContext(), scope = getMutationScopeCoordinator(db).current();
  if (!context || !scope || !input.before.member) return invalid();
  const before = structuredClone(input.before), member = before.member!, token = Object.freeze({});
  const { at, auditId, restored } = input;
  const ids = [...new Set(input.eventIds)].sort(), tasks = before.tasks.map(t => t.taskId);
  if (ids.length !== input.eventIds.length || ids.length > 512) return invalid();
  const live = await ctx.one<{ project_id: string; membership_revision: number; removed_at: string | null }>(
    'SELECT project_id, membership_revision, removed_at FROM members WHERE id = ?', [member.id]);
  if (!live || live.project_id !== before.projectId || Number(live.membership_revision) !== member.membershipRevision || live.removed_at !== member.removedAt) return invalid();
  const eligibility = await eligibleWorkEventSql(ctx), actual: Array<{ id: string; recipient_member_id: string }> = [];
  if (!eligibility) return invalid();
  const tracker = CaptureBudget.current(); let after = '';
  do {
    const limit = Math.min(tracker?.pageSize() ?? 32, 513 - actual.length);
    const batch = await ctx.query<{ id: string; recipient_member_id: string; id_complete: number; recipient_complete: number }>(
      `SELECT substr(id,1,1025) AS id, substr(recipient_member_id,1,1025) AS recipient_member_id,
        length(id || '.') - length(id) AS id_complete, length(recipient_member_id || '.') - length(recipient_member_id) AS recipient_complete
       FROM work_events WHERE project_id = ? AND (recipient_member_id = ?${tasks.length ? ` OR (task_id IN (${tasks.map(() => '?').join(',')}) AND delivery_state IN ('pending','delivered'))` : ''})
       ${eligibility} AND id > ? ORDER BY id LIMIT ?`, [before.projectId, member.id, ...tasks, after, limit]);
    for (const row of batch) {
      if (Number(row.id_complete) !== 1 || Number(row.recipient_complete) !== 1) return invalid();
      boundedText(row.id); boundedText(row.recipient_member_id);
      actual.push({ id: row.id, recipient_member_id: row.recipient_member_id }); after = row.id;
    }
    if (actual.length > 512) return invalid();
    if (batch.length < limit) break;
  } while (true);
  if (!isDeepStrictEqual(actual.map(r => r.id), ids)) return invalid();
  scope.assertCovers([before.projectId], [member.id, ...actual.map(r => r.recipient_member_id)]);
  const old = context.values.get(permitsKey);
  context.values.set(permitsKey, Object.freeze([...(Array.isArray(old) ? old : []), token]));
  const assertCurrent = () => {
    const held = db.currentTransactionContext(), permits = held?.values.get(permitsKey);
    if (held !== context || !Array.isArray(permits) || !permits.includes(token) || getMutationScopeCoordinator(db).current() !== scope) return invalid();
    scope.assertCovers([before.projectId], [member.id, ...actual.map(r => r.recipient_member_id)]);
  };
  let applied = false;
  const auditDetail: WorkEventInvalidationClosure = { schema: 'work-event-invalidation/v1', eventIds: ids };
  Object.freeze(ids); Object.freeze(auditDetail);
  return {
    auditDetail,
    async apply() {
      assertCurrent(); if (applied) return invalid();
      const current = await ctx.one<{ membership_revision: number; removed_at: string | null; updated_at: string }>(
        'SELECT membership_revision, removed_at, updated_at FROM members WHERE project_id = ? AND id = ?', [before.projectId, member.id]);
      if (!current || Number(current.membership_revision) !== member.membershipRevision + 1 || current.updated_at !== at ||
        (restored ? current.removed_at !== null : current.removed_at !== at)) return invalid();
      for (const id of ids) {
        if (await ctx.exec(`INSERT INTO work_event_delivery_invalidations
          (work_event_id,project_id,cause_member_id,cause_from_revision,cause_to_revision,cause_action,cause_audit_id,invalidated_at)
          VALUES (?,?,?,?,?,?,?,?)`, [id,before.projectId,member.id,member.membershipRevision,member.membershipRevision + 1,
          restored ? 'restored' : 'removed',auditId,at]) !== 1) return invalid();
      }
      applied = true;
    },
    async assertAudit() {
      assertCurrent(); if (!applied) return invalid();
      const audit = await ctx.one('SELECT * FROM audit_log WHERE id = ?', [auditId]);
      if (!audit || typeof audit.detail !== 'string' || !isDeepStrictEqual(JSON.parse(audit.detail).workEventInvalidations, auditDetail) ||
        typeof audit.before !== 'string' || !isDeepStrictEqual(JSON.parse(audit.before), before)) return invalid();
      const rows = await ctx.query('SELECT * FROM work_event_delivery_invalidations WHERE cause_audit_id = ?', [auditId]);
      if (!isDeepStrictEqual(rows.map(r => r.work_event_id).sort(), ids)) return invalid();
      // These rows have just been created from the verified exact closure. Read
      // only that bounded set, not an unbounded project's historical payloads.
      const events = [];
      for (let start = 0; start < ids.length; start += 32) {
        const batch = ids.slice(start, start + 32);
        events.push(...await ctx.query('SELECT id,project_id,recipient_member_id,task_id,delivery_state FROM work_events WHERE id IN (' + batch.map(() => '?').join(',') + ')', batch));
      }
      validateWorkEventInvalidations({ work_event_delivery_invalidations: rows, work_events: events,
        members: await ctx.query('SELECT id,project_id,membership_revision,removed_at FROM members WHERE id = ?', [member.id]),
        projects: [{ id: before.projectId }], audit_log: [audit] });
    },
  };
}

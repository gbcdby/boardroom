import { isDeepStrictEqual } from 'node:util';
import type { DbRow } from '../db/driver.ts';
import type { RepoCtx } from '../db/repositories.ts';
import { validateMemberSnapshot } from '../org/member-relations.ts';

export const WORK_EVENT_INVALIDATION_TABLE = 'work_event_delivery_invalidations';
export const WORK_EVENT_INVALIDATION_COLUMNS = ['work_event_id','project_id','cause_member_id','cause_from_revision',
  'cause_to_revision','cause_action','cause_audit_id','invalidated_at'] as const;
export interface WorkEventInvalidationClosure { schema: 'work-event-invalidation/v1'; eventIds: string[] }
export class WorkEventStorageInvalid extends Error {
  readonly code = 'work_event_storage_invalid';
  readonly stage: string;
  constructor(stage: string) { super(`work_event_storage_invalid:${stage}`); this.stage = stage; }
}
function invalid(stage: string): never { throw new WorkEventStorageInvalid(stage); }
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('object');
  return value as Record<string, unknown>;
};
const json = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'string') return invalid('text');
  try { return object(JSON.parse(value)); } catch (error) { if (error instanceof WorkEventStorageInvalid) throw error; return invalid('json'); }
};
export async function hasWorkEventInvalidations(ctx: Pick<RepoCtx, 'one'>): Promise<boolean> {
  return Boolean(await ctx.one('SELECT version FROM schema_migrations WHERE version = 21'));
}
/** The same predicate is used by lifecycle capture and every new-consumption path. */
export async function eligibleWorkEventSql(ctx: Pick<RepoCtx, 'one'>, alias = 'work_events'): Promise<string> {
  return await hasWorkEventInvalidations(ctx)
    ? ` AND NOT EXISTS (SELECT 1 FROM work_event_delivery_invalidations wi WHERE wi.work_event_id = ${alias}.id)` : '';
}
export async function isWorkEventEligible(ctx: Pick<RepoCtx, 'one'>, projectId: string, id: string): Promise<boolean> {
  return Boolean(await ctx.one(`SELECT id FROM work_events WHERE project_id = ? AND id = ?${await eligibleWorkEventSql(ctx)}`, [projectId, id]));
}
export function decodeInvalidationClosure(value: unknown): WorkEventInvalidationClosure {
  const closure = object(value), ids = closure.eventIds;
  if (!isDeepStrictEqual(Object.keys(closure).sort(), ['eventIds','schema']) || closure.schema !== 'work-event-invalidation/v1' ||
    !Array.isArray(ids) || ids.length > 512 || ids.some(id => typeof id !== 'string' || !id.trim()) ||
    !isDeepStrictEqual(ids, [...new Set(ids)].sort())) return invalid('audit_closure');
  return { schema: 'work-event-invalidation/v1', eventIds: ids as string[] };
}

/** M1 consumes the actual materialized batch, including raw original event/audit text. */
export function validateWorkEventInvalidations(graph: Readonly<Record<string, readonly Readonly<DbRow>[]>>): void {
  const rows = graph[WORK_EVENT_INVALIDATION_TABLE] ?? [];
  const index = (table: string, key = 'id') => new Map((graph[table] ?? []).map(row => [row[key], row]));
  const events = index('work_events'), members = index('members'), audits = index('audit_log'), projects = index('projects');
  const markers = index(WORK_EVENT_INVALIDATION_TABLE, 'work_event_id');
  if (markers.size !== rows.length) invalid('duplicate_event');
  for (const row of rows) {
    if (!isDeepStrictEqual(Object.keys(row).sort(), [...WORK_EVENT_INVALIDATION_COLUMNS].sort())) invalid('columns');
    const from = Number(row.cause_from_revision), to = Number(row.cause_to_revision);
    if (!Number.isSafeInteger(from) || from < 1 || !Number.isSafeInteger(to) || to !== from + 1 ||
      !['removed','restored'].includes(String(row.cause_action)) || typeof row.invalidated_at !== 'string' || !row.invalidated_at) invalid('cause_domain');
    const event = events.get(row.work_event_id), member = members.get(row.cause_member_id), audit = audits.get(row.cause_audit_id);
    if (!event || !member || !audit || !projects.has(row.project_id) || event.project_id !== row.project_id ||
      member.project_id !== row.project_id || audit.project_id !== row.project_id || audit.scope !== 'project' ||
      audit.target_kind !== 'member' || audit.target_id !== row.cause_member_id ||
      !['member.add','member.remove','member.revoke'].includes(String(audit.action)) || audit.created_at !== row.invalidated_at ||
      Number(member.membership_revision) < to) invalid('cause_reference');
    let before, after;
    try {
      before = validateMemberSnapshot(json(audit.before), String(row.project_id), String(row.cause_member_id));
      after = validateMemberSnapshot(json(audit.after), String(row.project_id), String(row.cause_member_id));
    } catch { return invalid('audit_snapshot'); }
    const restored = row.cause_action === 'restored', detail = json(audit.detail), reversal = object(detail.reversal);
    if (!['member.add','member.remove'].includes(String(reversal.rootAction)) || reversal.version !== 2 ||
      before.member?.membershipRevision !== from || after.member?.membershipRevision !== to ||
      before.presence !== (restored ? 'removed' : 'present') ||
      after.presence !== (restored ? 'present' : 'removed') || after.member.updatedAt !== row.invalidated_at ||
      (restored ? after.member.removedAt !== null : after.member.removedAt !== row.invalidated_at) ||
      before.member.id !== after.member.id || before.member.agentId !== after.member.agentId ||
      before.member.createdAt !== after.member.createdAt) invalid('audit_lifecycle');
    const closure = decodeInvalidationClosure(detail.workEventInvalidations);
    if (!closure.eventIds.includes(String(row.work_event_id)) || before.transient.workEventIds.some(id => !closure.eventIds.includes(id))) invalid('audit_event_set');
    // Original rows are immutable after invalidation. A different recipient must be
    // an actually affected task's pending/delivered event, never an unrelated ACK.
    if (event.recipient_member_id === row.cause_member_id) {
      if (!before.transient.workEventIds.includes(String(row.work_event_id))) invalid('recipient_closure');
    } else if (!before.tasks.some(task => task.taskId === event.task_id) || !['pending','delivered'].includes(String(event.delivery_state))) invalid('task_closure');
    for (const eventId of closure.eventIds) {
      // A permitted group purge can remove an original and its marker together;
      // surviving events still require the same first cause. Audit bytes stay intact.
      if (events.has(eventId) && markers.get(eventId)?.cause_audit_id !== row.cause_audit_id) invalid('incomplete_closure');
    }
  }
  // The producer's immutable audit commits the exact invalidation set. Check it
  // even when every sidecar row was omitted from a materialized source batch.
  // Old audits without this field remain their original pre-v21 facts.
  for (const audit of graph.audit_log ?? []) {
    let detail: unknown;
    try { detail = typeof audit.detail === 'string' ? JSON.parse(audit.detail) : null; } catch { continue; }
    if (!detail || typeof detail !== 'object' || Array.isArray(detail) || !Object.hasOwn(detail, 'workEventInvalidations')) continue;
    const closure = decodeInvalidationClosure((detail as Record<string, unknown>).workEventInvalidations);
    for (const id of closure.eventIds) {
      if (events.has(id) && markers.get(id)?.cause_audit_id !== audit.id) invalid('incomplete_closure');
    }
  }
  // A pre-upgrade DELETE cannot be repaired by inventing a lifecycle cause.
  for (const event of graph.work_events ?? []) {
    const member = members.get(event.recipient_member_id);
    if (member?.removed_at != null && !markers.has(event.id)) invalid('removed_member_unmarked_event');
  }
}

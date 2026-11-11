import type { MemoryRepository, ScanCheckpoint, ScanScope, TaskCompletionSource } from "./repository.ts";

/** 每次调用只扫描一页原始来源；由领域层在同一事务内组合来源、请求、事件和 checkpoint。 */
const PAGE_SIZE = 50;

async function sweep(repo: MemoryRepository, scope: ScanScope): Promise<{ checkpoint: ScanCheckpoint; through: NonNullable<ScanCheckpoint["through"]> } | null> {
  const checkpoint = await repo.getScanCheckpoint(scope);
  const through = checkpoint.through ?? await repo.scanHighWater(scope);
  return through ? { checkpoint, through } : null;
}

async function advance(repo: MemoryRepository, state: NonNullable<Awaited<ReturnType<typeof sweep>>>, page: { hasMore: boolean; nextCursor: ScanCheckpoint["after"] }): Promise<void> {
  const { checkpoint, through } = state;
  await repo.updateScanCheckpointCas({ scope: checkpoint.scope, after: page.hasMore ? page.nextCursor : null,
    through: page.hasMore ? through : null, sweep: checkpoint.sweep + (checkpoint.through === null ? 1 : 0),
    revision: checkpoint.revision + 1 }, checkpoint.revision);
}

export async function reconcileTaskCompletionPage(options: {
  repo: MemoryRepository; projectId: string; agentId: string;
  materialize: (source: TaskCompletionSource) => Promise<boolean>;
}): Promise<number> {
  const scope: ScanScope = { kind: "task_completed", projectId: options.projectId, agentId: options.agentId, groupId: null };
  const state = await sweep(options.repo, scope); if (!state) return 0;
  const page = await options.repo.scanUnmaterializedTaskCompletions(options.projectId, options.agentId,
    { after: state.checkpoint.after, through: state.through, limit: PAGE_SIZE });
  let scheduled = 0;
  for (const source of page.rows) if (await options.materialize(source)) scheduled++;
  // 始终用仓储返回的 raw cursor，解析不合格/已经物化的前缀也必须前进。
  await advance(options.repo, state, page); return scheduled;
}

export async function reconcileMessageThresholdPage(options: {
  repo: MemoryRepository; projectId: string; agentId: string; memberId: string; groupId: string; threshold: number; at: string;
  visibleIds: (ids: readonly string[]) => Promise<ReadonlySet<string>>;
  materialize: (sequence: number, messageIds: string[]) => Promise<boolean>;
}): Promise<number> {
  const scope: ScanScope = { kind: "message_threshold", projectId: options.projectId, agentId: options.agentId, groupId: options.groupId };
  const state = await sweep(options.repo, scope); if (!state) return 0;
  const page = await options.repo.unobservedDeliveries(options.projectId, options.memberId, options.groupId,
    { after: state.checkpoint.after, through: state.through, limit: PAGE_SIZE });
  const visible = await options.visibleIds(page.rows.map(row => row.messageId));
  let scheduled = 0;
  for (const row of page.rows) {
    if (row.groupId !== options.groupId || !visible.has(row.messageId)) continue;
    const observed = await options.repo.observeDeliveredMessage({ projectId: options.projectId, agentId: options.agentId,
      groupId: options.groupId, messageId: row.messageId, threshold: options.threshold, at: options.at });
    if (observed.thresholdSequence !== null && await options.materialize(observed.thresholdSequence, observed.messageIds)) scheduled++;
  }
  // 不可见行不造 receipt，但必须越过；下一 sweep 再按当时的权限回访。
  await advance(options.repo, state, page); return scheduled;
}

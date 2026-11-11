import type { DbDriver } from "../db/driver.ts";
import type { MemoryConfig } from "../../shared/memory.ts";
import { resolveMemoryConfig } from "../config.ts";
import { createMemoryInjectionReader, type MemoryDatabaseDescriptor, type MemoryInjectionReader } from "./injection-reader.ts";
import { unavailableMemory } from "./injection.ts";

export interface MemoryRuntime { config: MemoryConfig; reader: MemoryInjectionReader }
const runtimes = new WeakMap<DbDriver, MemoryRuntime>();
type ReconciliationJob = { run: () => Promise<void>; onFailure?: () => void };
type ReconciliationQueue = { jobs: Map<string, ReconciliationJob>; timer: ReturnType<typeof setImmediate> | null;
  active: Promise<void> | null; closed: boolean };
const reconciliations = new WeakMap<DbDriver, ReconciliationQueue>();
const defaults = Object.freeze(resolveMemoryConfig());
const unavailable: MemoryRuntime = { config: defaults, reader: {
  readOwn: async () => unavailableMemory(defaults, "memory_reader_unconfigured"), close: async () => {},
} };

/** server/stdio 各装配一次；同一驱动上的 HTTP、普通及 managed MCP 共用资源。 */
export function registerMemoryRuntime(db: DbDriver, options: {
  database: MemoryDatabaseDescriptor; config?: MemoryConfig; onDiagnostic?: (code: string) => void;
}): MemoryRuntime {
  if (runtimes.has(db)) throw new Error("memory_runtime_already_configured");
  const config = Object.freeze(resolveMemoryConfig(options.config));
  const runtime = { config, reader: createMemoryInjectionReader({
    database: { ...options.database }, config,
    ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
  }) };
  runtimes.set(db, runtime);
  return runtime;
}

/** 未装配的测试/嵌入场景明确 unavailable，不从主库补读或偷偷启动进程。 */
export function getMemoryRuntime(db: DbDriver): MemoryRuntime { return runtimes.get(db) ?? unavailable; }

/** 持久来源可在后续安全点补扫；队列满时不阻塞主消息，也不声称已完成补偿。 */
export function scheduleMemoryReconciliation(db: DbDriver, key: string, run: () => Promise<void>, onFailure?: () => void): boolean {
  let queue = reconciliations.get(db);
  if (!queue) {
    queue = { jobs: new Map(), timer: null, active: null, closed: false };
    reconciliations.set(db, queue);
  }
  if (queue.closed || (!queue.jobs.has(key) && queue.jobs.size >= 64)) return false;
  queue.jobs.set(key, { run, ...(onFailure ? { onFailure } : {}) });
  armReconciliation(queue);
  return true;
}
function armReconciliation(queue: ReconciliationQueue): void {
  if (queue.closed || queue.active || queue.timer || queue.jobs.size === 0) return;
  queue.timer = setImmediate(() => {
    queue.timer = null;
    if (queue.closed) return;
    const first = queue.jobs.entries().next().value as [string, ReconciliationJob] | undefined;
    if (!first) return;
    queue.jobs.delete(first[0]);
    queue.active = (async () => {
      try { await first[1].run(); }
      catch { try { first[1].onFailure?.(); } catch { /* 诊断不能阻断后续绑定。 */ } }
    })();
    void queue.active.finally(() => { queue.active = null; armReconciliation(queue); });
  });
}
/** 一个 core 只撤回自己的待办；已开始的真实事务由拥有它的驱动等待完成。 */
export function cancelMemoryReconciliations(db: DbDriver, keyPrefix: string): void {
  const queue = reconciliations.get(db);
  if (queue) for (const key of queue.jobs.keys()) if (key.startsWith(keyPrefix)) queue.jobs.delete(key);
}

/** 只有资源拥有者关闭；某个 MCP core 关闭不能结束其他会话共用的 reader。 */
export async function closeMemoryRuntime(db: DbDriver): Promise<void> {
  const queue = reconciliations.get(db);
  if (queue) {
    queue.closed = true;
    queue.jobs.clear();
    if (queue.timer) clearImmediate(queue.timer);
    queue.timer = null;
    await queue.active;
    if (reconciliations.get(db) === queue) reconciliations.delete(db);
  }
  const runtime = runtimes.get(db);
  if (!runtime) return;
  await runtime.reader.close();
  if (runtimes.get(db) === runtime) runtimes.delete(db);
}

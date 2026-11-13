import type { DbDriver } from "./db/driver.ts";
import { afterCommit } from "./db/after-commit.ts";
import type { ResourceChange } from "../shared/resource-changes.ts";

type Listener = (change: ResourceChange) => void | Promise<void>;
const listeners = new WeakMap<DbDriver, Set<Listener>>();

export function onResourceChange(db: DbDriver, listener: Listener): () => void {
  const set = listeners.get(db) ?? new Set<Listener>();
  listeners.set(db, set); set.add(listener);
  return () => { set.delete(listener); };
}

/** HTTP/MCP 共用 driver。独立 stdio 进程依赖可见页的条件 GET，不承诺跨进程广播。 */
export async function notifyResourceChange(db: DbDriver, change: ResourceChange): Promise<void> {
  // 明确投影允许字段；源对象及调用方附加字段不能进入通知。
  const event: ResourceChange = { projectId: change.projectId, entity: change.entity, id: change.id, revision: change.revision };
  await afterCommit(db, async () => {
    await Promise.allSettled([...listeners.get(db) ?? []].map(async listener => listener(event)));
  });
}

import type { DbDriver } from "../db/driver.ts";

/** 提交后提示，不承担可靠队列；丢提示由 dispatcher 的持久查询恢复。 */
type Listener = (messageId?: string) => void | Promise<void>;
const listeners = new WeakMap<DbDriver, Set<Listener>>();

export function onMessageCommit(db: DbDriver, listener: Listener): () => void {
  let set = listeners.get(db);
  if (!set) { set = new Set(); listeners.set(db, set); }
  set.add(listener);
  return () => { set!.delete(listener); };
}

export async function notifyMessageCommit(db: DbDriver, messageId?: string): Promise<void> {
  // 观察失败不能回滚已提交消息；await 使连接关闭时不遗留后台数据库写入。
  await Promise.allSettled([...listeners.get(db) ?? []].map(async listener => listener(messageId)));
}

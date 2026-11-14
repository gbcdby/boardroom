import type { DbDriver } from "../db/driver.ts";
import { afterCommit } from "../db/after-commit.ts";
import type { WorkEvent } from "../../shared/tasks.ts";

type Listener = (events: readonly WorkEvent[]) => void | Promise<void>;
const listeners = new WeakMap<DbDriver, Set<Listener>>();

/** 仅为提交后的即时提示；可靠性由持久化未 ACK 事件与等待时补投提供。 */
export function onWorkEventCommit(db: DbDriver, listener: Listener): () => void {
  let set = listeners.get(db);
  if (!set) { set = new Set(); listeners.set(db, set); }
  set.add(listener);
  return () => { set!.delete(listener); };
}

export async function notifyWorkEventCommit(db: DbDriver, events: readonly WorkEvent[]): Promise<void> {
  await afterCommit(db, async () => {
    await Promise.allSettled([...listeners.get(db) ?? []].map(listener => listener(events)));
  });
}

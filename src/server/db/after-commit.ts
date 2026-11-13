import type { DbDriver, DbTransactionContext } from "./driver.ts";

export type CommitCallback = () => void | Promise<void>;
const callbacksKey = Symbol("boardroom.after-commit");

/** 不可变替换队列，使 driver 的保存点元数据恢复也丢弃已回滚的通知。 */
export async function afterCommit(db: DbDriver, callback: CommitCallback): Promise<void> {
  const context = db.currentTransactionContext();
  if (!context) { await runCommitCallbacks([callback]); return; }
  const callbacks = context.values.get(callbacksKey) as readonly CommitCallback[] | undefined;
  context.values.set(callbacksKey, [...callbacks ?? [], callback]);
}

export function commitCallbacks(context: DbTransactionContext): readonly CommitCallback[] {
  return context.values.get(callbacksKey) as readonly CommitCallback[] | undefined ?? [];
}

/** 必须在最外 COMMIT 成功、上下文及连接占用释放后调用；通知错误不改变提交结果。 */
export async function runCommitCallbacks(callbacks: readonly CommitCallback[]): Promise<void> {
  for (const callback of callbacks) {
    try { await callback(); } catch { /* 提示不可靠；客户端条件 GET 兜底。 */ }
  }
}

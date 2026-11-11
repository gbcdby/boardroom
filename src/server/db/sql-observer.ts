import { AsyncLocalStorage } from "node:async_hooks";
/** server-only 操作预算；多 RepositorySet 共用同一异步事务链，不另开连接。 */
export interface RepositorySqlObserver {
  readonly bounded: true;
  before(sql: string): void;
  after(sql: string, result: unknown, kind: "query" | "exec"): void;
}
const observers = new AsyncLocalStorage<RepositorySqlObserver>();
export function repositorySqlObserver(): RepositorySqlObserver | undefined { return observers.getStore(); }
export function withRepositorySqlObserver<T>(observer: RepositorySqlObserver, body: () => Promise<T>): Promise<T> {
  if (observers.getStore()) return body();
  return observers.run(observer, body);
}
export async function observeSql<T>(sql: string, kind: "query" | "exec", body: () => Promise<T>): Promise<T> {
  const observer = observers.getStore(); observer?.before(sql);
  const result = await body(); observer?.after(sql, result, kind); return result;
}

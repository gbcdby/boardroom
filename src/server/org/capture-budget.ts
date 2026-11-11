import { RepositoryError } from "../db/errors.ts";
import { repositorySqlObserver, withRepositorySqlObserver, type RepositorySqlObserver } from "../db/sql-observer.ts";
import { MEMBER_CAPTURE_BUDGET, type MemberCaptureBudget } from "./compensation-types.ts";

function exceeded(message: string): never { throw new RepositoryError("audit_capture_budget_exceeded", `${message}；本次事务将完整回滚，请缩小操作范围。`); }
/** 各有界投影须从 SQL 字段宽度证明此上界，不能只在接收后截断整行。 */
export const MAX_CAPTURE_ROW_BYTES = 65536;
/** 500ms 是语句间/语句返回后的真实检查，绝不以 Promise 超时伪装 native SQLite 已取消。 */
export class CaptureBudget implements RepositorySqlObserver {
  readonly bounded = true;
  readonly limits: Readonly<MemberCaptureBudget>;
  readonly stats = { rows: 0, bytes: 0, sql: 0, changedRows: 0, phase: "preflight" as "preflight" | "apply" };
  private startedAt: number | null = null;
  private signal: AbortSignal | undefined;
  static current(): CaptureBudget | undefined { const current = repositorySqlObserver(); return current instanceof CaptureBudget ? current : undefined; }
  constructor(limits: Readonly<MemberCaptureBudget> = MEMBER_CAPTURE_BUDGET, signal?: AbortSignal) {
    if (Object.keys(limits).length !== Object.keys(MEMBER_CAPTURE_BUDGET).length ||
      Object.entries(MEMBER_CAPTURE_BUDGET).some(([key, value]) => limits[key as keyof MemberCaptureBudget] !== value)) exceeded("不接受调用者扩大固定采集预算");
    this.limits = MEMBER_CAPTURE_BUDGET; this.signal = signal;
  }
  adoptScope(startedAt: number): void { this.startedAt ??= startedAt; this.check(); }
  check(): void {
    if (this.signal?.aborted) exceeded("操作已取消");
    if (this.startedAt !== null && performance.now() - this.startedAt > this.limits.maxWorkMs) exceeded("有界采集/应用超过 500ms 工作预算");
  }
  before(sql: string): void {
    this.check(); if (++this.stats.sql > this.limits.maxSqlStatements) exceeded("SQL 语句预算已耗尽");
    if (this.stats.phase === 'preflight' && /^\s*(INSERT|UPDATE|DELETE)/i.test(sql) && !/^\s*UPDATE \w+ SET updated_at = updated_at/i.test(sql)) exceeded("完整写入计划尚未通过预算预检");
  }
  after(sql: string, result: unknown, kind: "query" | "exec"): void {
    if (this.startedAt === null && /^\s*UPDATE projects SET updated_at = updated_at/i.test(sql)) this.startedAt = performance.now();
    if (kind === "query" && Array.isArray(result)) {
      let oversizedRow = false;
      for (const row of result) {
        const bytes = Buffer.byteLength(JSON.stringify(row, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value), "utf8");
        this.stats.rows++; this.stats.bytes += bytes;
        oversizedRow ||= bytes > MAX_CAPTURE_ROW_BYTES;
      }
      // 驱动已将整批数组交回；即使第一行越界，后续行也已经消耗资源，必须全部计费。
      if (oversizedRow || this.stats.rows > this.limits.maxRows || this.stats.bytes > this.limits.maxReturnedBytes) exceeded("返回行/UTF-8 字节预算已耗尽");
    } else if (kind === "exec" && typeof result === "number" && !/^\s*(SET|UPDATE \w+ SET updated_at = updated_at)/i.test(sql)) {
      this.stats.changedRows += result;
      if (this.stats.changedRows > this.limits.maxPlannedChangedRows) exceeded("实际写入行预算已耗尽");
    }
    this.check();
  }
  /** 业务 DML 前预留 after/审计/CAS 的预算；执行阶段仍按真实返回逐语句计费。 */
  plan(cost: { rows: number; bytes: number; sql: number; changedRows: number }): void {
    this.check();
    if (this.stats.rows + cost.rows > this.limits.maxRows || this.stats.bytes + cost.bytes > this.limits.maxReturnedBytes ||
      this.stats.sql + cost.sql > this.limits.maxSqlStatements || this.stats.changedRows + cost.changedRows > this.limits.maxPlannedChangedRows) exceeded("完整补偿计划与读回预留超出预算");
    this.stats.phase = "apply";
  }
  pageSize(): number {
    this.check();
    // 最后一行是完整性哨兵：返回量至多为剩余预算 + 一行，而非再取一整页。
    const byteRows = Math.floor((this.limits.maxReturnedBytes - this.stats.bytes) / MAX_CAPTURE_ROW_BYTES) + 1;
    return Math.max(1, Math.min(this.limits.pageRows, this.limits.maxRows - this.stats.rows + 1, byteRows));
  }
  run<T>(body: () => Promise<T>): Promise<T> { return withRepositorySqlObserver(this, body); }
}
/** DB 端 substr(n+1) 后按真实 UTF-8 再检查，超长时不加载剩余正文。 */
export function boundedText(value: unknown, maxBytes = 1024, nullable = false): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maxBytes) exceeded("关系字段缺失或超长");
  return value;
}
export function safeRevision(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number >= Number.MAX_SAFE_INTEGER) exceeded("关系 revision 无效或无法继续递增");
  return number;
}
export function captureExceeded(message: string): never { return exceeded(message); }

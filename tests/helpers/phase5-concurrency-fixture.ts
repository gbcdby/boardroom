import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { Client } from "pg";
import { createDbDriver, type DbDriver } from "../../src/server/db/driver.ts";
import { createRepositories, type RepositorySet } from "../../src/server/db/repositories.ts";
import { createT1ApiRouter } from "../../src/server/api.ts";
import { createLogger } from "../../src/server/logger.ts";
import { CaptureBudget } from "../../src/server/org/capture-budget.ts";
import { memoryFixture, memoryPgUrl } from "./memory-fixture.ts";

type Writer = "first" | "second";
type CleanupError = (stage: string, error: unknown) => void;
function errorEvidence(error: unknown) {
  const chain: Array<{ name: string; code: string; message: string }> = [], seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && current !== null && !seen.has(current) && chain.length < 8) {
    seen.add(current);
    const value = current as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    // No stack, SQL parameters, PG detail/row data, or connection URI is emitted.
    const message = String(value.message ?? current).replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, "[URI redacted]")
      .replace(/\b(password|token|secret)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]");
    chain.push({ name: String(value.name ?? "UNKNOWN"), code: String(value.code ?? "UNKNOWN"), message: message.slice(0, 4096) });
    current = value.cause;
  }
  return { chain, remainingCause: current === undefined || current === null ? null : "UNKNOWN: cycle or depth limit" };
}

/** Same production counters/checks; only the last observer boundary is retained in memory. */
class DiagnosticBudget extends CaptureBudget {
  private lastSql: { text: string; beforeAt: number; beforeReturned: boolean; afterAt: number | null; afterAccepted: boolean } | undefined;
  override before(sql: string): void {
    this.lastSql = { text: sql, beforeAt: performance.now(), beforeReturned: false, afterAt: null, afterAccepted: false };
    super.before(sql); this.lastSql.beforeReturned = true;
  }
  override after(sql: string, result: unknown, kind: "query" | "exec"): void {
    if (this.lastSql) this.lastSql.afterAt = performance.now();
    super.after(sql, result, kind);
    if (this.lastSql) this.lastSql.afterAccepted = true;
  }
  evidence() {
    const last = this.lastSql, normalized = last?.text.replace(/\s+/g, " ").trim();
    return { limits: this.limits, stats: { ...this.stats }, workStartedAt: "UNKNOWN: production private clock is not exposed",
      lastSql: last && normalized ? { sha256: createHash("sha256").update(normalized).digest("hex"),
        kind: /^UPDATE projects SET updated_at = updated_at WHERE id = \?$/.test(normalized) ? "project-lock" : normalized.match(/^\w+/)?.[0] ?? "UNKNOWN",
        beforeAt: last.beforeAt, beforeReturned: last.beforeReturned, afterAt: last.afterAt, afterAccepted: last.afterAccepted } : null };
  }
}

/** Opt-in for PG member pairs; never logs during the lock/barrier path. */
export class RemovePairDiagnostics {
  private budgets = { first: new DiagnosticBudget(), second: new DiagnosticBudget() };
  private transactions = new WeakMap<object, number>();
  private nextTransaction = 0;
  private events: Array<{ event: string; at: number; detail: unknown }> = [];
  private droppedEvents = 0;
  private backends: Partial<Record<Writer, { pid: number; schema: string; transaction: number }>> = {};
  private outcomes: Partial<Record<Writer, { ok: boolean; error?: unknown }>> = {};
  private checks: Array<{ stage: string; ok: boolean; error?: unknown }> = [];
  private failures: Array<{ stage: string; error: unknown }> = [];
  private observations: Record<string, unknown> = {};
  private anchor = { monotonicMs: performance.now(), utc: new Date().toISOString() };
  readonly projectId: string;
  readonly testName: string;
  constructor(projectId: string, testName: string) { this.projectId = projectId; this.testName = testName; }
  budget(writer: Writer): CaptureBudget { return this.budgets[writer]; }
  event(event: string, detail: unknown = null) {
    if (this.events.length < 32) this.events.push({ event, at: performance.now(), detail }); else this.droppedEvents++;
  }
  backend(writer: Writer, pid: number, schema: string, transaction: object) {
    let id = this.transactions.get(transaction);
    if (id === undefined) { id = ++this.nextTransaction; this.transactions.set(transaction, id); }
    this.backends[writer] = { pid, schema, transaction: id };
  }
  settled(writer: Writer, outcome: Outcome<unknown>) {
    this.outcomes[writer] = outcome.ok ? { ok: true } : { ok: false, error: outcome.error };
    this.event(`${writer}_settled`);
  }
  failure(stage: string, error: unknown) { this.failures.push({ stage, error }); this.checks.push({ stage, ok: false, error }); }
  async check(stage: string, body: () => Promise<void>) {
    try { await body(); this.checks.push({ stage, ok: true }); } catch (error) { this.failure(stage, error); }
  }
  relations(before: Record<string, unknown[]>, after: Record<string, unknown[]>) {
    const digest = (rows: unknown[] | undefined) => rows === undefined ? null : createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    this.observations.tables = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().map(table => ({ table,
      beforeRows: before[table]?.length ?? null, afterRows: after[table]?.length ?? null,
      beforeSha256: digest(before[table]), afterSha256: digest(after[table]) }));
    // Synthetic fixture state only: keep the values needed by the original assertions, never text/JSON payloads.
    const fields: Record<string, string[]> = {
      members: ["id", "removed_at", "membership_revision", "status", "node_id"],
      tasks: ["id", "revision", "state", "assignee_member_id", "reviewer_member_id", "current_review_round_id"],
      project_task_settings: ["project_id", "revision", "default_reviewer_member_id"],
      audit_log: ["id", "action", "target_id", "reversed_at", "reversed_by_audit_id"],
      memory_summary_requests: ["id", "state", "revision"],
    };
    const project = (snapshot: Record<string, unknown[]>) => Object.fromEntries(Object.entries(fields).map(([table, keys]) => [table,
      snapshot[table]?.map(row => Object.fromEntries(keys.map(key => [key, (row as Record<string, unknown>)[key] ?? null]))) ?? null]));
    this.observations.relationState = { before: project(before), after: project(after) };
  }
  async inspectConnections(firstDb: DbDriver, secondDb: DbDriver, probe: Client) {
    for (const [writer, db] of [["first", firstDb], ["second", secondDb]] as const) await this.check(`${writer}_connection`, async () => {
      const callerTransactionContext = db.currentTransactionContext() === undefined ? "absent" : "present";
      const row = (await db.query("SELECT pg_backend_pid() AS pid, current_schema() AS schema"))[0]!;
      this.observations[`${writer}Connection`] = { callerTransactionContext, pid: Number(row.pid), schema: String(row.schema), querySucceeded: true,
        sameBackendAsOperation: this.backends[writer] ? Number(row.pid) === this.backends[writer]!.pid : "UNKNOWN" };
    });
    await this.check("post_settlement_activity", async () => {
      const result = await probe.query(`SELECT pg_backend_pid() AS probe_pid, current_schema() AS schema,
        (SELECT json_agg(json_build_object('pid', pid, 'state', state, 'xactStart', xact_start::text))
          FROM pg_stat_activity WHERE pid = ANY($1::int[])) AS writers`, [Object.values(this.backends).map(value => value.pid)]);
      this.observations.postSettlementActivity = result.rows[0] ?? "UNKNOWN";
    });
  }
  report() {
    return { format: "phase5-remove-remove-diagnostic/v1", testName: this.testName, projectId: this.projectId,
      candidate: /^[a-f0-9]{40}$/i.test(process.env.GITHUB_SHA ?? "") ? process.env.GITHUB_SHA : "UNKNOWN",
      tree: "UNKNOWN: bind through the CI full-suite child-identity receipt", anchor: this.anchor,
      backends: this.backends, events: this.events, droppedEvents: this.droppedEvents,
      outcomes: Object.fromEntries(Object.entries(this.outcomes).map(([writer, value]) => [writer, { ok: value.ok, ...(value.ok ? {} : { error: errorEvidence(value.error) }) }])),
      budgets: { first: this.budgets.first.evidence(), second: this.budgets.second.evidence() },
      checks: this.checks.map(check => ({ stage: check.stage, ok: check.ok, ...(check.ok ? {} : { error: errorEvidence(check.error) }) })),
      ...this.observations, timingBoundary: "Observer times include fixture pauses; settled is after commit/rollback and may include after-commit callbacks." };
  }
  throwIfFailed() {
    // A cleanup observation may precede the original outcome assertion; it must not replace that assertion.
    const failures = [...this.failures.filter(value => value.stage === "outcome_assertions"),
      ...this.failures.filter(value => value.stage !== "outcome_assertions")].map(value => value.error);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "原用例失败与诊断/清理失败一并保留", { cause: failures[0] });
  }
}

export function barrier<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

export interface LockRecord { table: string; id: string; phase: "attempt" | "acquired"; transaction: object }
export function observeLocks(db: DbDriver, pause?: (record: LockRecord) => Promise<void>, diagnostic?: { collector: RemovePairDiagnostics; writer: Writer }) {
  const exec = db.exec.bind(db), query = db.query.bind(db);
  const locks: LockRecord[] = [], errors: string[] = [];
  const first = barrier<{ table: string; pid: number }>();
  let reported = false;
  db.exec = async (sql, params) => {
    const match = sql.trim().match(/^UPDATE (projects|members|groups|agent_runtimes) SET updated_at = updated_at/);
    const transaction = db.currentTransactionContext();
    let record: LockRecord | undefined;
    if (match) {
      assert.ok(transaction, "锁操作必须在真实驱动事务内");
      record = { table: match[1]!, id: String(params?.[0]), phase: "attempt", transaction };
      locks.push(record);
      await pause?.(record);
    }
    let pid = 0;
    if (record && !reported && db.kind === "postgres") {
      const row = (await query(diagnostic ? "SELECT pg_backend_pid() AS pid, current_schema() AS schema" : "SELECT pg_backend_pid() AS pid"))[0]!;
      pid = Number(row.pid); diagnostic?.collector.backend(diagnostic.writer, pid, String(row.schema), record.transaction);
    }
    if (record?.table === "projects") diagnostic?.collector.event(`${diagnostic.writer}_project_attempt`);
    const running = exec(sql, params);
    if (record && !reported) { reported = true; first.resolve({ table: record.table, pid }); }
    try {
      const result = await running;
      if (record) {
        const acquired: LockRecord = { ...record, phase: "acquired" };
        if (record.table === "projects") diagnostic?.collector.event(`${diagnostic.writer}_project_exec_returned`);
        locks.push(acquired); await pause?.(acquired);
      }
      return result;
    } catch (error) { errors.push(String((error as { code?: unknown }).code ?? "unknown")); throw error; }
  };
  return { locks, errors, first: first.promise, restore() { db.exec = exec; } };
}

export function assertProjectBeforeLowerLocks(locks: readonly LockRecord[]) {
  assert.ok(locks.length > 0, "入口必须实际到达共同锁协议");
  const projects = new Map<object, Set<string>>();
  for (const lock of locks) {
    if (lock.table === "projects" && lock.phase === "acquired") {
      let held = projects.get(lock.transaction); if (!held) projects.set(lock.transaction, held = new Set());
      held.add(lock.id);
    }
    if (lock.table !== "projects") assert.ok(projects.get(lock.transaction)?.size,
      `${lock.table}/${lock.phase} 不得发生在本物理事务取得项目锁之前`);
  }
}

/** Real pg_stat_activity/pg_blocking_pids is the barrier. A wall-clock limit only fails a stuck test. */
export async function observeDatabaseWait(probe: Client, workerPid: number, holderPid: number, diagnostic?: RemovePairDiagnostics) {
  const deadline = performance.now() + 1500;
  while (performance.now() < deadline) {
    await probe.query("SELECT pg_stat_clear_snapshot()");
    const result = await probe.query(diagnostic
      ? "SELECT pid AS worker_pid, wait_event_type, wait_event, pg_blocking_pids(pid) AS blockers, query_start::text, clock_timestamp()::text AS database_time, pg_backend_pid() AS probe_pid, current_schema() AS schema FROM pg_stat_activity WHERE pid = $1"
      : "SELECT wait_event_type, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid = $1", [workerPid]);
    const row = result.rows[0];
    if (row?.wait_event_type === "Lock" && row.blockers.map(Number).includes(holderPid)) { diagnostic?.event("database_wait_observed", row); return; }
  }
  assert.fail(`未观察到真实 PostgreSQL 锁等待：worker ${workerPid} / holder ${holderPid}`);
}

export async function withIndependentPgDrivers(body: (first: RepositorySet, firstDb: DbDriver, second: RepositorySet, secondDb: DbDriver, probe: Client) => Promise<void>, onCleanupError?: CleanupError) {
  await memoryFixture(async (repos, db) => {
    const schema = String((await db.query("SELECT current_schema() AS name"))[0]!.name);
    assert.match(schema, /^[a-zA-Z_][a-zA-Z0-9_]*$/);
    const secondDb = createDbDriver({ dbDriver: "postgres", pgConnectionString: memoryPgUrl!, pgSchema: schema });
    const probe = new Client({ connectionString: memoryPgUrl });
    let connected = false;
    try {
      await secondDb.connect(); await probe.connect(); connected = true;
      await probe.query(`SET search_path TO "${schema}"`);
      await body(repos, db, createRepositories(secondDb), secondDb, probe);
    } finally {
      if (onCleanupError) {
        if (connected) {
          await probe.query("ROLLBACK").catch(error => onCleanupError("fixture_probe_rollback", error));
          await probe.end().catch(error => onCleanupError("fixture_probe_close", error));
        }
        await secondDb.close().catch(error => onCleanupError("fixture_second_close", error));
      } else {
        if (connected) { await probe.query("ROLLBACK").catch(() => {}); await probe.end(); }
        await secondDb.close();
      }
    }
  }, "postgres");
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
function settled<T>(operation: () => Promise<T>, diagnostic?: RemovePairDiagnostics, writer: Writer = "first"): Promise<Outcome<T>> {
  const running = diagnostic ? diagnostic.budget(writer).run(operation) : operation();
  return running.then(value => { const outcome = { ok: true as const, value }; diagnostic?.settled(writer, outcome); return outcome; },
    error => { const outcome = { ok: false as const, error }; diagnostic?.settled(writer, outcome); return outcome; });
}

/** Pause a real first operation after its real project UPDATE; let a second real entry hit that lock. */
export async function interleaveProjectWriters<T, U>(input: {
  firstDb: DbDriver; secondDb: DbDriver; probe: Client; first: () => Promise<T>; second: () => Promise<U>; projectId: string;
  diagnostic?: RemovePairDiagnostics;
  /** Observe the second writer while the first's completed work is still uncommitted. */
  secondAfterFirstWork?: boolean;
}) {
  const held = barrier<number>(), release = barrier(), workComplete = barrier(), commitAllowed = barrier();
  let paused = false, released = false;
  const releaseFirst = () => { if (!released) { input.diagnostic?.event("release"); released = true; } release.resolve(); };
  const releaseCommit = () => { input.diagnostic?.event("commit_release"); commitAllowed.resolve(); };
  const firstTrace = observeLocks(input.firstDb, async lock => {
    if (!paused && lock.table === "projects" && lock.phase === "acquired") {
      paused = true;
      held.resolve(Number((await input.firstDb.query("SELECT pg_backend_pid() AS pid"))[0]!.pid));
      await release.promise;
    }
  }, input.diagnostic ? { collector: input.diagnostic, writer: "first" } : undefined);
  // A caller-owned real transaction keeps the completed mutation uncommitted.
  // Starting the second writer here avoids charging the first's entire 500ms
  // work allowance to the second's unchanged 200ms project-lock statement.
  const first = settled(() => input.secondAfterFirstWork ? input.firstDb.transaction(async () => {
    const result = await input.first();
    assert.ok(input.firstDb.currentTransactionContext(), "首操作工作完成后仍须保留真实物理事务");
    input.diagnostic?.event("first_work_complete_before_commit"); workComplete.resolve();
    await commitAllowed.promise; return result;
  }) : input.first(), input.diagnostic);
  let second: Promise<Outcome<U>> | undefined, secondTrace: ReturnType<typeof observeLocks> | undefined;
  const probeLowerLocks = async () => {
    await input.probe.query("BEGIN");
    await input.probe.query("SELECT id FROM members WHERE project_id = $1 FOR UPDATE NOWAIT", [input.projectId]);
    await input.probe.query("SELECT id FROM agent_runtimes WHERE id IN (SELECT runtime_id FROM agent_runtime_bindings WHERE project_id = $1) FOR UPDATE NOWAIT", [input.projectId]);
    await input.probe.query("ROLLBACK");
    input.diagnostic?.event("lower_lock_probe_finished");
  };
  try {
    const holderPid = await Promise.race([held.promise, first.then(r => { throw r.ok ? new Error("首入口未经过项目锁") : r.error; })]);
    if (input.secondAfterFirstWork) {
      // Preserve the original real NOWAIT proof before the first operation is
      // allowed to acquire its legitimate lower locks and apply its mutation.
      await probeLowerLocks(); releaseFirst();
      await Promise.race([workComplete.promise, first.then(r => { throw r.ok ? new Error("首入口未停在真实提交前") : r.error; })]);
    }
    secondTrace = observeLocks(input.secondDb, undefined, input.diagnostic ? { collector: input.diagnostic, writer: "second" } : undefined);
    second = settled(input.second, input.diagnostic, "second");
    const waiting = await Promise.race([secondTrace.first, second.then(r => { throw r.ok ? new Error("第二入口绕过了项目锁") : r.error; })]);
    assert.equal(waiting.table, "projects"); assert.notEqual(waiting.pid, holderPid, "两个入口必须使用真实独立 PG 连接");
    await observeDatabaseWait(input.probe, waiting.pid, holderPid, input.diagnostic);
    if (input.secondAfterFirstWork) {
      const lower = await input.probe.query(`SELECT c.relname, l.mode FROM pg_locks l
        JOIN pg_class c ON c.oid = l.relation JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE l.pid = $1 AND l.granted AND n.nspname = current_schema()
          AND c.relname IN ('members', 'agent_runtimes') AND l.mode <> 'AccessShareLock'`, [waiting.pid]);
      assert.deepEqual(lower.rows, [], "第二入口等待项目锁时不得持有下层成员/runtime锁");
      input.diagnostic?.event("second_lower_locks_verified", { pid: waiting.pid, lockCount: lower.rows.length });
    } else await probeLowerLocks();
    assert.equal(secondTrace.locks.some(l => l.table !== "projects"), false);
    if (input.secondAfterFirstWork) releaseCommit(); else releaseFirst();
    const outcomes = { first: await first, second: await second, firstLocks: firstTrace.locks, secondLocks: secondTrace.locks };
    assertProjectBeforeLowerLocks(firstTrace.locks); assertProjectBeforeLowerLocks(secondTrace.locks);
    assert.equal([...firstTrace.errors, ...secondTrace.errors].includes("40P01"), false, "40P01 一律为失败，不能接受为稳定业务冲突");
    return outcomes;
  } finally {
    await input.probe.query("ROLLBACK").catch(error => input.diagnostic?.failure("interleave_probe_rollback", error)); releaseFirst(); commitAllowed.resolve();
    await first; if (second) await second;
    firstTrace.restore(); secondTrace?.restore();
  }
}

export async function startActualApi(db: DbDriver) {
  const router = createT1ApiRouter({ db, logger: createLogger({ level: "error", write() {} }) });
  const server: Server = createServer((request, response) => {
    void router.handle(request, response, request.url ?? "/").then(handled => {
      if (!handled) { response.writeHead(404); response.end(); }
    }).catch(() => { response.writeHead(500); response.end(); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return {
    async call(method: string, url: string) {
      const response = await fetch(`http://127.0.0.1:${address.port}${url}`, { method });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : null };
    },
    async close() { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { Client } from "pg";
import { createDbDriver, type DbDriver } from "../../src/server/db/driver.ts";
import { createRepositories, type RepositorySet } from "../../src/server/db/repositories.ts";
import { createT1ApiRouter } from "../../src/server/api.ts";
import { createLogger } from "../../src/server/logger.ts";
import { memoryFixture, memoryPgUrl } from "./memory-fixture.ts";

export function barrier<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

export interface LockRecord { table: string; id: string; phase: "attempt" | "acquired"; transaction: object }
export function observeLocks(db: DbDriver, pause?: (record: LockRecord) => Promise<void>) {
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
    const pid = record && !reported && db.kind === "postgres"
      ? Number((await query("SELECT pg_backend_pid() AS pid"))[0]!.pid) : 0;
    const running = exec(sql, params);
    if (record && !reported) { reported = true; first.resolve({ table: record.table, pid }); }
    try {
      const result = await running;
      if (record) {
        const acquired: LockRecord = { ...record, phase: "acquired" };
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
export async function observeDatabaseWait(probe: Client, workerPid: number, holderPid: number) {
  const deadline = performance.now() + 1500;
  while (performance.now() < deadline) {
    await probe.query("SELECT pg_stat_clear_snapshot()");
    const result = await probe.query("SELECT wait_event_type, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid = $1", [workerPid]);
    const row = result.rows[0];
    if (row?.wait_event_type === "Lock" && row.blockers.map(Number).includes(holderPid)) return;
  }
  assert.fail(`未观察到真实 PostgreSQL 锁等待：worker ${workerPid} / holder ${holderPid}`);
}

export async function withIndependentPgDrivers(body: (first: RepositorySet, firstDb: DbDriver, second: RepositorySet, secondDb: DbDriver, probe: Client) => Promise<void>) {
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
      if (connected) { await probe.query("ROLLBACK").catch(() => {}); await probe.end(); }
      await secondDb.close();
    }
  }, "postgres");
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
function settled<T>(operation: () => Promise<T>): Promise<Outcome<T>> {
  return operation().then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
}

/** Pause a real first operation after its real project UPDATE; let a second real entry hit that lock. */
export async function interleaveProjectWriters<T, U>(input: {
  firstDb: DbDriver; secondDb: DbDriver; probe: Client; first: () => Promise<T>; second: () => Promise<U>; projectId: string;
}) {
  const held = barrier<number>(), release = barrier();
  let paused = false;
  const firstTrace = observeLocks(input.firstDb, async lock => {
    if (!paused && lock.table === "projects" && lock.phase === "acquired") {
      paused = true;
      held.resolve(Number((await input.firstDb.query("SELECT pg_backend_pid() AS pid"))[0]!.pid));
      await release.promise;
    }
  });
  const first = settled(input.first);
  let second: Promise<Outcome<U>> | undefined, secondTrace: ReturnType<typeof observeLocks> | undefined;
  try {
    const holderPid = await Promise.race([held.promise, first.then(r => { throw r.ok ? new Error("首入口未经过项目锁") : r.error; })]);
    secondTrace = observeLocks(input.secondDb);
    second = settled(input.second);
    const waiting = await Promise.race([secondTrace.first, second.then(r => { throw r.ok ? new Error("第二入口绕过了项目锁") : r.error; })]);
    assert.equal(waiting.table, "projects"); assert.notEqual(waiting.pid, holderPid, "两个入口必须使用真实独立 PG 连接");
    await observeDatabaseWait(input.probe, waiting.pid, holderPid);
    await input.probe.query("BEGIN");
    await input.probe.query("SELECT id FROM members WHERE project_id = $1 FOR UPDATE NOWAIT", [input.projectId]);
    await input.probe.query("SELECT id FROM agent_runtimes WHERE id IN (SELECT runtime_id FROM agent_runtime_bindings WHERE project_id = $1) FOR UPDATE NOWAIT", [input.projectId]);
    await input.probe.query("ROLLBACK");
    assert.equal(secondTrace.locks.some(l => l.table !== "projects"), false);
    release.resolve();
    const outcomes = { first: await first, second: await second, firstLocks: firstTrace.locks, secondLocks: secondTrace.locks };
    assertProjectBeforeLowerLocks(firstTrace.locks); assertProjectBeforeLowerLocks(secondTrace.locks);
    assert.equal([...firstTrace.errors, ...secondTrace.errors].includes("40P01"), false, "40P01 一律为失败，不能接受为稳定业务冲突");
    return outcomes;
  } finally {
    await input.probe.query("ROLLBACK").catch(() => {}); release.resolve();
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

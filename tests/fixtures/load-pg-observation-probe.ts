/** Directed verification only. The launcher must supply a new, owned localhost cluster. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { LoadDiagnostics, installLoadQueryDiagnostics, finishLoadReport } from '../helpers/load-pg-diagnostics.ts';

const port = Number(process.env['PGLOAD_OBSERVER_TEST_PORT']);
const output = process.env['PGLOAD_OBSERVER_TEST_OUT'];
assert.ok(port > 0 && port <= 65535 && output);
const base = { host: '127.0.0.1', port, database: 'postgres', connectionTimeoutMillis: 250 };
const admin = new Client({ ...base, user: 'pgload_admin', statement_timeout: 1000 });
const url = `postgresql://pgload_user@127.0.0.1:${port}/postgres`;
const clients = Array.from({ length: 4 }, () => new Client({ ...base, user: 'pgload_user', statement_timeout: 200, lock_timeout: 200 }));
const [holder, middle, target, gone] = clients as [Client, Client, Client, Client];
const lock = 'UPDATE projects SET updated_at = updated_at WHERE id = $1';
const pid = (client: Client) => Object.getOwnPropertyDescriptor(client, 'processID')!.value as number;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const pending: Promise<unknown>[] = [];
const monitors: Client[] = [];
const diagnostics: LoadDiagnostics[] = [];
const checks: string[] = [];
const canary = randomUUID();
const report: Record<string, unknown> = { schema: 'pgload-observer-directed-check/v1',
  scope: 'owned synthetic PG; original CI is not reproduced and its cause remains unknown',
  productBudgetsUnchanged: true, checks, status: 'RUNNING' };
let restore: (() => void) | undefined;
function make() {
  const observer = new LoadDiagnostics(config => { const client = new Client(config); monitors.push(client); return client; });
  diagnostics.push(observer); return observer;
}
function start(observer: LoadDiagnostics, branch: 'mutation' | 'heartbeat', step: number, client: Client, sql: string, args: unknown[] = []) {
  const promise = observer.run(branch, 1000, step, () => client.query(sql, args));
  void promise.catch(() => {}); pending.push(promise); return promise;
}
try {
  await admin.connect();
  await admin.query('CREATE ROLE pgload_user LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION');
  await admin.query('CREATE SCHEMA pgload_probe AUTHORIZATION pgload_user');
  report['role'] = (await admin.query(`SELECT rolsuper, rolcreaterole, rolcreatedb,
    pg_has_role('pgload_user', 'pg_read_all_stats', 'MEMBER') AS read_all_stats FROM pg_roles WHERE rolname = 'pgload_user'`)).rows[0];
  assert.deepEqual(report['role'], { rolsuper: false, rolcreaterole: false, rolcreatedb: false, read_all_stats: false });
  report['settings'] = (await admin.query("SELECT current_setting('fsync') AS fsync, current_setting('synchronous_commit') AS synchronous_commit")).rows[0];
  for (const client of clients) { await client.connect(); await client.query('SET search_path = pgload_probe'); }
  await holder.query('CREATE TABLE projects (id text PRIMARY KEY, updated_at integer NOT NULL)');
  await holder.query('INSERT INTO projects VALUES ($1, 1)', [canary]);
  const observer = make(); restore = installLoadQueryDiagnostics(observer);
  await observer.prepareMonitor(url);
  assert.equal(observer.snapshot().server.reason, 'ready');
  await start(observer, 'heartbeat', 0, holder, 'BEGIN');
  await start(observer, 'heartbeat', 0, holder, lock, [canary]);
  await start(observer, 'heartbeat', 0, middle, 'BEGIN');
  const waitingMiddle = start(observer, 'heartbeat', 0, middle, lock, [canary]);
  // Client call order does not establish server lock queue order. One bounded
  // independent fixture check proves the first waiter before starting the next.
  await delay(10);
  const established = await admin.query('SELECT pg_blocking_pids($1) AS blockers', [pid(middle)]);
  assert.ok(established.rows[0].blockers.includes(pid(holder)));
  report['fixtureOrderReadbacks'] = 1;
  await start(observer, 'heartbeat', 0, target, 'BEGIN');
  const waitingTarget = start(observer, 'mutation', 0, target, lock, [canary]);
  await delay(75);
  const first = observer.snapshot().server.samples[0];
  assert.ok(first, 'first 50 ms sample returned');
  const middleRow = first.rows.find(row => row.pid === pid(middle));
  const targetRow = first.rows.find(row => row.pid === pid(target));
  assert.ok(middleRow?.blockingPids.includes(pid(holder)));
  assert.ok(targetRow?.blockingPids.includes(pid(middle)));
  assert.equal(targetRow?.waitEventType, 'Lock');
  checks.push('real direct and multi-level blocker edges');
  await holder.query('COMMIT'); await waitingMiddle;
  await delay(40);
  const changed = observer.snapshot().server.samples.at(-1)!;
  assert.equal(changed.opportunityMs, 100);
  assert.equal(changed.rows.find(row => row.pid === pid(middle))?.state, 'idle in transaction');
  assert.ok(changed.rows.find(row => row.pid === pid(target))?.blockingPids.includes(pid(middle)));
  checks.push('fresh snapshot after release changes holder state');
  await middle.query('ROLLBACK'); await waitingTarget; await target.query('ROLLBACK');
  await start(observer, 'heartbeat', 1, admin, 'SELECT 1');
  await gone.end();
  await start(observer, 'heartbeat', 1, gone, 'SELECT 1').catch(() => {});
  const sleeping = start(observer, 'mutation', 1, target,
    `${lock} AND $2::text IS NOT NULL AND (SELECT pg_sleep(0.13)) IS NULL`, [canary, canary]);
  await sleeping;
  const nonLock = observer.snapshot().server.samples.filter(sample => sample.origin.step === 1);
  assert.ok(nonLock.some(sample => sample.rows.some(row => row.pid === pid(target) && row.waitEventType === 'Timeout' && row.waitEvent === 'PgSleep' && row.blockingPids.length === 0)));
  assert.ok(nonLock.some(sample => sample.rows.some(row => row.pid === pid(admin) && row.visibility === 'unknown')));
  assert.ok(nonLock.some(sample => sample.missingPids.includes(pid(gone))));
  checks.push('non-lock wait, invisible other-role backend and disappeared PID stay distinct');
  await observer.close(); restore(); restore = undefined;
  assert.equal(observer.snapshot().server.cleanup.verified, true);
  assert.ok(!observer.snapshot().events?.some(event => event.backendPid === pid(monitors[0]!)), 'monitor is excluded from client trace');
  checks.push('monitor excluded, actual normal transport end and promise convergence');

  // Withhold an actual observer response; server timeout stays 50 ms. Closing
  // must really destroy the active, non-pipeline own transport and reject SQL.
  const slow = make(); restore = installLoadQueryDiagnostics(slow);
  await slow.prepareMonitor(url);
  const slowMonitor = monitors.at(-1)!;
  slowMonitor.connection.stream.pause();
  const running = start(slow, 'mutation', 2, target, `${lock} AND (SELECT pg_sleep(0.16)) IS NULL`, [canary]);
  await delay(65);
  const originalFailure = new Error('primary-canary');
  let failure: unknown;
  try { throw originalFailure; }
  catch (error) { failure = error; }
  finally { await finishLoadReport(slow, async () => { throw new Error('report-canary'); }, true, () => {}); }
  assert.equal(failure, originalFailure);
  await running;
  assert.equal(slow.snapshot().server.cleanup.forced, true);
  assert.equal(slow.snapshot().server.cleanup.verified, true);
  assert.equal(slow.snapshot().server.queryPending, false);
  restore(); restore = undefined;
  checks.push('real active-query teardown converges with report failure and original failure preserved');

  const disconnected = make(); restore = installLoadQueryDiagnostics(disconnected);
  await disconnected.prepareMonitor(url);
  monitors.at(-1)!.connection.stream.destroy();
  await delay(20); await disconnected.close();
  assert.equal(disconnected.snapshot().server.reason, 'transport');
  assert.equal(disconnected.snapshot().server.cleanup.verified, true);
  restore(); restore = undefined;
  checks.push('real monitor disconnect is unavailable and closed');

  await admin.query('REVOKE EXECUTE ON FUNCTION pg_catalog.pg_blocking_pids(integer) FROM PUBLIC');
  const denied = make(); restore = installLoadQueryDiagnostics(denied);
  try {
    await denied.prepareMonitor(url);
    assert.equal(denied.snapshot().server.sqlState, '42501');
    assert.equal(denied.snapshot().server.cleanup.verified, true);
  } finally { await admin.query('GRANT EXECUTE ON FUNCTION pg_catalog.pg_blocking_pids(integer) TO PUBLIC'); }
  restore(); restore = undefined;
  checks.push('real low-privilege capability failure closes without elevation');
  assert.ok(!JSON.stringify(diagnostics.map(value => value.snapshot())).includes(canary));
  checks.push('query/parameter/error canary absent from all diagnostic records');
  report['status'] = 'PASS';
} catch (error) {
  report['status'] = 'FAIL';
  report['failure'] = { name: error instanceof Error ? error.name : 'unknown',
    message: String(error instanceof Error ? error.message : error).replaceAll(canary, '[canary]') };
  process.exitCode = 1;
} finally {
  for (const observer of diagnostics) await observer.close();
  if (restore) restore();
  for (const client of clients) { try { await client.query('ROLLBACK'); } catch {} }
  const pendingResults = await Promise.allSettled(pending);
  const ownedPids = [...clients, ...monitors].map(pid);
  for (const client of clients) await client.end();
  await delay(20);
  const remaining = await admin.query('SELECT pid FROM pg_stat_activity WHERE pid = ANY($1::integer[])', [ownedPids]);
  report['cleanup'] = { remainingOwnedBackendPids: remaining.rows.map(row => row.pid), pendingSettled: pendingResults.length,
    pendingRejected: pendingResults.filter(result => result.status === 'rejected').length, backendExitReadbacks: 1 };
  if (remaining.rows.length) { report['status'] = 'FAIL'; process.exitCode = 1; }
  report['diagnostics'] = diagnostics.map(value => value.snapshot());
  await admin.end();
  await writeFile(path.join(output!, 'RESULT.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report['status'], checks, cleanup: report['cleanup'], failure: report['failure'] }));
}

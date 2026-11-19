import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Client as PgClient, type ClientConfig } from 'pg';
import { LoadDiagnostics, installLoadQueryDiagnostics, finishLoadReport } from './helpers/load-pg-diagnostics.ts';

const lock = 'UPDATE projects SET updated_at = updated_at WHERE id = $1';
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const row = (pid: number, overrides: Record<string, unknown> = {}) => ({ pid,
  observed_at: new Date('2026-01-01T00:00:00Z'), backend_start: new Date('2025-12-31T00:00:00Z'),
  xact_start: null, query_start: new Date('2026-01-01T00:00:00Z'), state_change: new Date('2026-01-01T00:00:00Z'),
  state: 'active', wait_event_type: 'Lock', wait_event: 'transactionid', blocking_pids: [99], blockers_truncated: false, ...overrides });

class Monitor extends EventEmitter {
  processID = 999;
  connection = new EventEmitter();
  calls: Array<{ sql: string; args: unknown[] }> = [];
  samples: (args: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> = async () => ({ rows: [row(42)] });
  config: ClientConfig | undefined;
  connect = async () => this;
  query = (sql: string, args: unknown[] = []) => {
    this.calls.push({ sql, args });
    if (sql.startsWith('SET ')) return Promise.resolve({ rows: [] });
    if (sql.includes('observer_capability')) return Promise.resolve({ rows: [{ timeout_ok: true, activities: true, blockers: true }] });
    return this.samples(args);
  };
  end = async () => { this.connection.emit('end'); this.emit('end'); };
  client() { return this as unknown as PgClient; }
}

function harness(monitor = new Monitor(), target: 'first-project-lock' | 'mutation-commit' = 'first-project-lock') {
  const diagnostics = new LoadDiagnostics(config => { monitor.config = config; return monitor.client(); }, target);
  const client = Object.assign(new EventEmitter(), { processID: 42 }) as unknown as PgClient;
  return { diagnostics, monitor, client };
}

// The public snapshot cannot prove that an evicted object is no longer strongly
// held. Inspect only the private test helper's actual slots for this memory gate.
type RingView<T> = { events: Array<{ value: T; bytes: number } | undefined>; head: number; count: number;
  bytes: number; dropped: number; maxEvents: number; maxBytes: number; push(value: T): void; replace(previous: T, value: T): void; values(): T[] };
function smallRing<T>(maxEvents: number, maxBytes: number): RingView<T> {
  const trace = new LoadDiagnostics() as unknown as { events: { constructor: new (count: number, bytes: number) => RingView<T> } };
  return new trace.events.constructor(maxEvents, maxBytes);
}
function assertStored<T>(ring: RingView<T>, expected: T[], dropped: number) {
  const stored = ring.events.filter((entry): entry is { value: T; bytes: number } => entry !== undefined);
  const actualBytes = stored.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry.value)), 0);
  assert.deepEqual(ring.values(), expected, 'last-N order is preserved');
  assert.equal(ring.count, expected.length);
  assert.equal(ring.dropped, dropped);
  assert.equal(stored.length, expected.length, 'no evicted entry remains strongly held in an array slot');
  assert.ok(stored.every(entry => expected.includes(entry.value)));
  assert.ok(actualBytes <= ring.maxBytes, 'actual strong references obey the byte limit');
  assert.equal(actualBytes, ring.bytes, 'reported bytes equal all physically retained records');
  assert.ok(ring.events.length <= ring.maxEvents);
  for (let index = 0; index < ring.events.length; index++) {
    const live = Array.from({ length: ring.count }, (_, offset) => (ring.head + offset) % ring.maxEvents).includes(index);
    if (live) assert.notEqual(ring.events[index], undefined);
    else assert.equal(ring.events[index], undefined, 'every non-live slot releases its record reference');
  }
  return { strongEntries: stored.length, actualBytes, dropped };
}

test('PGLOAD-OBS-02 R2: byte eviction releases every removed slot through consecutive eviction and wrap', () => {
  const ring = smallRing<string>(5, 17);
  assertStored(ring, [], 0);
  for (const value of ['a', 'b', 'c', 'd', 'e']) ring.push(value);
  assertStored(ring, ['a', 'b', 'c', 'd', 'e'], 0);
  const large = 'x'.repeat(12); // JSON bytes: 14; one 3-byte entry fits exactly alongside it.
  ring.push(large);
  assertStored(ring, ['e', large], 4);
  ring.push('z');
  assertStored(ring, [large, 'z'], 5);
  ring.push('h');
  assertStored(ring, ['z', 'h'], 6);
  for (const value of ['i', 'j', 'k']) ring.push(value);
  assertStored(ring, ['z', 'h', 'i', 'j', 'k'], 6);
  ring.push('l');
  assertStored(ring, ['h', 'i', 'j', 'k', 'l'], 7);
  ring.push(large);
  assertStored(ring, ['l', large], 11);
  ring.push('q'.repeat(16)); // The oversized new value must not evict any existing record.
  assertStored(ring, ['l', large], 12);
});

test('PGLOAD-OBS-02 R2: count eviction preserves only the newest objects over repeated wraps', () => {
  const ring = smallRing<{ id: number }>(3, 1024);
  const values = Array.from({ length: 12 }, (_, id) => ({ id }));
  assertStored(ring, [], 0);
  values.forEach((value, index) => {
    ring.push(value);
    assertStored(ring, values.slice(0, index + 1).slice(-3), Math.max(0, index - 2));
  });
});

test('CI273-PG-02: upgrading a pending record releases its old slot and keeps the shared byte/count caps', () => {
  const ring = smallRing<string>(3, 17);
  for (const value of ['a', 'b', 'p']) ring.push(value);
  const sample = 'x'.repeat(12); // 14 JSON bytes; only one 3-byte record can remain alongside it.
  ring.replace('a', sample);
  assertStored(ring, ['p', sample], 1);
  ring.replace('p', 'q');
  assertStored(ring, [sample, 'q'], 1);
  ring.replace('already-evicted', 'z');
  assertStored(ring, ['q', 'z'], 2);
});

test('PGLOAD-OBS-02: only the current in-flight mutation gets 50/100/150 ms opportunities', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const advance = async (ms: number) => { now += ms; t.mock.timers.tick(ms); await tick(); };
  const { diagnostics, monitor, client } = harness();
  await diagnostics.prepareMonitor('postgresql://private-canary');
  assert.equal(monitor.config?.connectionTimeoutMillis, 250);
  assert.equal(monitor.config?.statement_timeout, 50);
  assert.equal(monitor.config?.pipeline, false);
  const result = deferred<unknown>();
  const query = diagnostics.wrapQuery((() => result.promise) as unknown as typeof PgClient.prototype.query);
  assert.equal(diagnostics.run('mutation', 1000, 0, () => Reflect.apply(query, client, [lock, ['parameter-canary']])), result.promise);
  await advance(49);
  assert.equal(monitor.calls.length, 2);
  for (const ms of [1, 50, 50]) await advance(ms);
  assert.equal(monitor.calls.length, 5);
  result.resolve({}); await tick();
  await advance(500);
  await diagnostics.close();
  const observed = diagnostics.snapshot().server!;
  assert.equal(observed.target, 'first-project-lock');
  assert.equal(observed.snapshotCount, 3);
  assert.deepEqual(observed.samples.map(value => value.opportunityMs), [50, 100, 150]);
  assert.deepEqual(observed.samples.map(value => value.sentAtMs), [50, 100, 150]);
  assert.equal(observed.pendingTimers, 0);
  assert.equal(observed.cleanup.transportEnded, true);
  assert.equal(observed.cleanup.pendingSettled, true);
  assert.ok(!JSON.stringify(diagnostics.snapshot()).includes('canary'));
});

test('CI273-PG-01: commit mode reserves the three opportunities for COMMIT after a fast first lock', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const advance = async (ms: number) => { now += ms; t.mock.timers.tick(ms); await tick(); };
  const { diagnostics, monitor, client } = harness(new Monitor(), 'mutation-commit');
  await diagnostics.prepareMonitor('private-canary');
  const locked = deferred<unknown>(), committed = deferred<unknown>();
  const query = diagnostics.wrapQuery(((sql: string) => sql === lock ? locked.promise : committed.promise) as typeof PgClient.prototype.query);
  const operation = diagnostics.run('mutation', 10000, 3, async () => {
    await Reflect.apply(query, client, [lock]);
    return Reflect.apply(query, client, ['COMMIT']);
  });
  await advance(20); locked.resolve({}); await tick();
  for (let index = 0; index < 3; index++) await advance(50);
  committed.resolve({ command: 'COMMIT' }); await operation; await tick(); await diagnostics.close();
  const server = diagnostics.snapshot().server;
  assert.equal(server.snapshotCount, 3, 'the first lock must not consume COMMIT sampling');
  assert.equal(server.scheduledOpportunities, 3);
  assert.equal(server.target, 'mutation-commit');
  assert.deepEqual(server.samples.map(value => value.sentAtMs), [70, 120, 170]);
  assert.ok(server.samples.every(value => value.category === 'commit' && value.origin.step === 3));
  assert.deepEqual(server.opportunities.map(value => value.dueAtMs), [70, 120, 170]);
  assert.deepEqual(server.opportunities.map(value => value.firedAtMs), [70, 120, 170]);
  assert.ok(server.opportunities.every(value => value.disposition === 'sample-attempted'
    && value.queryId === server.samples[0]!.queryId && value.origin.branch === 'mutation'));
  assert.equal(monitor.calls.length, 5);
});

test('CI273-PG-01: cancellation distinguishes early settlement from overdue timers without sampling afterwards', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const { diagnostics, monitor, client } = harness(new Monitor(), 'mutation-commit');
  await diagnostics.prepareMonitor('private-canary');
  for (const [step, settledAt] of [[0, 20], [1, 220]] as const) {
    const committed = deferred<unknown>();
    const query = diagnostics.wrapQuery((() => committed.promise) as typeof PgClient.prototype.query);
    diagnostics.run('mutation', 10000, step, () => Reflect.apply(query, client, ['COMMIT']));
    // Advance only the monotonic clock: callbacks have not been scheduled yet.
    now = settledAt; committed.resolve({}); await tick();
  }
  const opportunities = diagnostics.snapshot().server.opportunities;
  assert.equal(opportunities.length, 6);
  assert.deepEqual(opportunities.map(value => value.dueAtMs), [50, 100, 150, 70, 120, 170]);
  assert.deepEqual(opportunities.map(value => value.cancelledAtMs), [20, 20, 20, 220, 220, 220]);
  assert.deepEqual(opportunities.map(value => value.latenessMs), [0, 0, 0, 150, 100, 50]);
  assert.ok(opportunities.every(value => value.firedAtMs === null && value.disposition === 'cancelled'
    && value.cancellationReason === 'query-settled'));
  t.mock.timers.tick(500); await tick(); await diagnostics.close();
  assert.equal(monitor.calls.length, 2, 'cancelled opportunities never catch up with SQL');
  assert.equal(diagnostics.snapshot().server.snapshotCount, 0);
});

test('CI273-PG-01: a late callback records its due time and real firing independently of sample return', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const { diagnostics, monitor, client } = harness(new Monitor(), 'mutation-commit');
  await diagnostics.prepareMonitor('private-canary');
  const committed = deferred<unknown>(), sampled = deferred<{ rows: Record<string, unknown>[] }>();
  monitor.samples = () => sampled.promise;
  const query = diagnostics.wrapQuery((() => committed.promise) as typeof PgClient.prototype.query);
  diagnostics.run('mutation', 10000, 3, () => Reflect.apply(query, client, ['COMMIT']));
  now = 80; t.mock.timers.tick(50); await tick();
  now = 90; sampled.resolve({ rows: [row(42, { wait_event_type: 'IO', wait_event: 'WALSync', blocking_pids: [] })] }); await tick();
  now = 91; committed.resolve({}); await tick(); await diagnostics.close();
  const server = diagnostics.snapshot().server;
  const opportunity = server.opportunities.find(value => value.disposition === 'sample-attempted')!;
  assert.equal(opportunity.dueAtMs, 50); assert.equal(opportunity.firedAtMs, 80);
  assert.equal(opportunity.cancelledAtMs, null); assert.equal(opportunity.latenessMs, 30);
  assert.equal(server.samples[0]?.returnedAtMs, 90);
  assert.equal(server.samples[0]?.timerLatenessMs, 30);
  assert.equal(server.samples[0]?.rows[0]?.waitEvent, 'WALSync');
  assert.equal(server.opportunities.length, 3);
});

test('CI273-PG-01: a fired opportunity is retained while its observer response is still pending', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const { diagnostics, monitor, client } = harness(new Monitor(), 'mutation-commit');
  await diagnostics.prepareMonitor('private-canary');
  const committed = deferred<unknown>(), sampled = deferred<{ rows: Record<string, unknown>[] }>();
  monitor.samples = () => sampled.promise;
  const query = diagnostics.wrapQuery((() => committed.promise) as typeof PgClient.prototype.query);
  diagnostics.run('mutation', 10000, 3, () => Reflect.apply(query, client, ['COMMIT']));
  now = 50; t.mock.timers.tick(50); await tick();
  const pending = diagnostics.snapshot().server;
  assert.equal(pending.queryPending, true); assert.equal(pending.samples.length, 0);
  assert.equal(pending.opportunities.length, 1, 'a missing observer response must not erase the actual firing');
  assert.equal(pending.opportunities[0]?.dueAtMs, 50); assert.equal(pending.opportunities[0]?.firedAtMs, 50);
  sampled.resolve({ rows: [row(42)] }); await tick();
  const completed = diagnostics.snapshot().server;
  assert.equal(completed.opportunities.length, 1, 'the returned sample replaces the same opportunity record');
  assert.equal(completed.samples.length, 1);
  committed.resolve({}); await tick(); await diagnostics.close();
});

test('CI273-PG-02: commit mode ignores other branches and cannot exceed the original cumulative opportunity budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { diagnostics, monitor, client } = harness(new Monitor(), 'mutation-commit');
  await diagnostics.prepareMonitor('private-canary');
  const immediate = diagnostics.wrapQuery((() => Promise.resolve({})) as unknown as typeof PgClient.prototype.query);
  for (const branch of ['wait', 'heartbeat', 'traffic'] as const) {
    await diagnostics.run(branch, 10000, 0, () => Reflect.apply(immediate, client, ['COMMIT']));
  }
  assert.equal(diagnostics.snapshot().server.scheduledOpportunities, 0);
  for (let step = 0; step < 13; step++) {
    const committed = deferred<unknown>();
    const query = diagnostics.wrapQuery(((sql: string) => sql === lock ? Promise.resolve({}) : committed.promise) as typeof PgClient.prototype.query);
    const operation = diagnostics.run('mutation', 10000, step, async () => {
      await Reflect.apply(query, client, [lock]); return Reflect.apply(query, client, ['COMMIT']);
    });
    await tick();
    for (let sample = 0; sample < 3; sample++) { t.mock.timers.tick(50); await tick(); }
    committed.resolve({}); await operation; await tick();
  }
  await diagnostics.close();
  const server = diagnostics.snapshot().server;
  assert.equal(server.scheduledOpportunities, 36); assert.equal(server.snapshotCount, 36);
  assert.equal(server.limitSkips, 1); assert.equal(monitor.calls.length, 38);
  assert.equal(server.pendingTimers, 0); assert.equal(server.queryPending, false);
  assert.ok(server.opportunities.every(value => value.category === 'commit' && value.origin.branch === 'mutation'));
  assert.ok(server.retainedOpportunityCount <= 36 && server.retainedBytes <= 128 * 1024);
  assert.deepEqual(server.limits, { opportunityMs: [50, 100, 150], snapshots: 36, rows: 180,
    pids: 5, blockersPerRow: 8, snapshotBytes: 8192, retainedBytes: 128 * 1024,
    connectMs: 250, statementMs: 50, setupQueries: 2, cleanupQueries: 0, cleanupMs: 250 });
});

test('PGLOAD-OBS-05: wrapper preserves callback/config/custom/Promise/synchronous throw identity', async () => {
  const { diagnostics, client } = harness();
  const returned = {};
  const callback = () => {};
  const custom = { submit() {}, text: lock };
  const config = { text: lock, values: ['canary'], callback };
  for (const args of [[lock, ['canary'], callback], [config], [custom]]) {
    let actual: unknown[] = [];
    const query = diagnostics.wrapQuery(function (this: PgClient, ...input: unknown[]) { assert.equal(this, client); actual = input; return returned; } as typeof PgClient.prototype.query);
    assert.equal(Reflect.apply(query, client, args), returned);
    assert.deepEqual(actual, args);
    args.forEach((arg, index) => assert.equal(actual[index], arg));
  }
  const failure = Object.assign(new Error('secret-error-canary'), { code: '57014' });
  const thrown = diagnostics.wrapQuery((() => { throw failure; }) as typeof PgClient.prototype.query);
  assert.throws(() => Reflect.apply(thrown, client, [lock]), error => error === failure);
  const promise = Promise.reject(failure);
  const rejected = diagnostics.wrapQuery((() => promise) as typeof PgClient.prototype.query);
  assert.equal(Reflect.apply(rejected, client, [lock]), promise);
  await assert.rejects(promise, error => error === failure);
  await tick();
  assert.ok(!JSON.stringify(diagnostics.snapshot()).includes('canary'));
  const original = Object.getOwnPropertyDescriptor(PgClient.prototype, 'query');
  const restore = installLoadQueryDiagnostics(diagnostics);
  restore();
  assert.deepEqual(Object.getOwnPropertyDescriptor(PgClient.prototype, 'query'), original);
});

test('PGLOAD-OBS-02/06: busy opportunities are skipped without a queue; a prior result stays late', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { diagnostics, monitor, client } = harness();
  await diagnostics.prepareMonitor('private-canary');
  const sample = deferred<{ rows: Record<string, unknown>[] }>();
  monitor.samples = () => sample.promise;
  const first = deferred<unknown>();
  const query = diagnostics.wrapQuery((() => first.promise) as typeof PgClient.prototype.query);
  diagnostics.run('mutation', 1000, 0, () => Reflect.apply(query, client, [lock]));
  t.mock.timers.tick(50); await tick();
  t.mock.timers.tick(100); await tick();
  assert.equal(monitor.calls.length, 3);
  assert.equal(diagnostics.snapshot().server.busySkips, 2);
  first.resolve('original value'); await tick();
  const next = deferred<unknown>();
  const nextQuery = diagnostics.wrapQuery((() => next.promise) as typeof PgClient.prototype.query);
  diagnostics.run('mutation', 10000, 1, () => Reflect.apply(nextQuery, client, [lock]));
  sample.resolve({ rows: [row(42)] }); await tick();
  const prior = diagnostics.snapshot().server.samples[0]!;
  assert.equal(prior.origin.step, 0);
  assert.equal(prior.late, true); assert.equal(prior.censored, true);
  assert.notEqual(prior.targetSettledAtMs, null);
  next.resolve(null); await tick();
  t.mock.timers.tick(500); await tick();
  assert.equal(monitor.calls.length, 3, 'no queued sampling catches up after completion');
  await diagnostics.close();
});

test('PGLOAD-OBS-02/04: 36 snapshots, 180 rows, 8 blockers, byte caps and canary allowlist', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { diagnostics, monitor, client } = harness();
  await diagnostics.prepareMonitor('dsn-canary');
  const clients = [client, ...[43, 44, 45, 46].map(processID => Object.assign(new EventEmitter(), { processID }) as unknown as PgClient)];
  const immediate = diagnostics.wrapQuery((() => Promise.resolve({})) as unknown as typeof PgClient.prototype.query);
  for (const current of clients) await diagnostics.run('heartbeat', 1000, 0, () => Reflect.apply(immediate, current, ['SELECT 1']));
  monitor.samples = async args => ({ rows: (args[0] as number[]).map(value => row(value, {
    blocking_pids: [0, 2147483647, 2147483646, 2147483645, 2147483644, 2147483643, 2147483642, 2147483641, 2147483640], blockers_truncated: true,
    state: 'idle in transaction (aborted)', xact_start: new Date('2026-01-01T00:00:00Z'),
    wait_event: 'W'.repeat(64), query: 'sql-canary', query_id: 'query-id-canary',
    application_name: 'app-canary', usename: 'user-canary', client_addr: 'address-canary', params: ['param-canary'],
  })) });
  for (let operation = 0; operation < 13; operation++) {
    const result = deferred<unknown>();
    const query = diagnostics.wrapQuery((() => result.promise) as unknown as typeof PgClient.prototype.query);
    diagnostics.run('mutation', 10000, operation, () => Reflect.apply(query, client, [lock, ['param-canary']]));
    for (let sample = 0; sample < 3; sample++) { t.mock.timers.tick(50); await tick(); }
    result.resolve(null); await tick();
  }
  await diagnostics.close();
  const server = diagnostics.snapshot().server;
  assert.equal(server.snapshotCount, 36); assert.equal(server.rowCount, 180);
  assert.equal(server.scheduledOpportunities, 36); assert.equal(server.limitSkips, 1);
  assert.equal(monitor.calls.length, 38);
  assert.ok(server.retainedBytes <= 128 * 1024); assert.ok(server.dropCount > 0);
  type RetainedRecord = { sample?: (typeof server.samples)[number] };
  const ring = (diagnostics as unknown as { server: { records: RingView<RetainedRecord> } }).server.records;
  const records = ring.values();
  const retained = assertStored(ring, records, server.dropCount);
  assert.equal(retained.actualBytes, server.retainedBytes, 'opportunities and samples use one byte budget');
  assert.deepEqual(records.flatMap(record => record.sample ? [record.sample] : []), server.samples);
  assert.equal(records.length, server.opportunities.length);
  assert.ok(records.every(record => Buffer.byteLength(JSON.stringify(record)) <= 8192));
  t.diagnostic(JSON.stringify({ snapshots: server.snapshotCount, rows: server.rowCount, cap: server.limits.retainedBytes,
    reportedBytes: server.retainedBytes, publicSamples: server.samples.length, ...retained }));
  for (const sample of server.samples) {
    assert.ok(Buffer.byteLength(JSON.stringify(sample)) <= 8192);
    assert.equal(sample.rows.length, 5);
    for (const current of sample.rows) {
      assert.equal(current.blockingPids.length, 8); assert.equal(current.blockersTruncated, true);
      assert.deepEqual(current.unknownBlockerPids, [0, 2147483647, 2147483646, 2147483645, 2147483644, 2147483643, 2147483642, 2147483641]);
    }
  }
  assert.ok(!JSON.stringify(diagnostics.snapshot()).includes('canary'));
  assert.ok(monitor.calls.slice(2).every(call => JSON.stringify(call.args) === '[[42,43,44,45,46]]'), 'unknown blockers never expand the query set');
});

test('PGLOAD-OBS-04/06: short/settled, custom and old mutation ancestry create no sampling work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { diagnostics, monitor, client } = harness();
  await diagnostics.prepareMonitor('canary');
  const fast = diagnostics.wrapQuery((() => Promise.resolve({})) as unknown as typeof PgClient.prototype.query);
  await diagnostics.run('mutation', 1000, 0, () => Reflect.apply(fast, client, [lock]));
  let oldWork!: () => void;
  await diagnostics.run('mutation', 1000, 1, () => {
    setTimeout(() => oldWork(), 200);
    return Promise.resolve({});
  });
  oldWork = () => { Reflect.apply(fast, client, [lock]); };
  t.mock.timers.tick(200); await tick();
  const custom = { submit() {}, text: lock };
  const query = diagnostics.wrapQuery((() => custom) as unknown as typeof PgClient.prototype.query);
  await diagnostics.run('mutation', 1000, 2, async () => { assert.equal(Reflect.apply(query, client, [custom]), custom); });
  t.mock.timers.tick(500); await tick();
  assert.equal(monitor.calls.length, 2);
  assert.equal(diagnostics.snapshot().server.pendingTimers, 0);
  await diagnostics.close();
});

test('PGLOAD-OBS-06: permission and malformed data remain unknown without changing the original outcome', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { diagnostics, monitor, client } = harness();
  await diagnostics.prepareMonitor('dsn-canary');
  const result = deferred<string>();
  const query = diagnostics.wrapQuery((() => result.promise) as unknown as typeof PgClient.prototype.query);
  const returned = diagnostics.run('mutation', 1000, 0, () => Reflect.apply(query, client, [lock]));
  monitor.samples = async () => { throw Object.assign(new Error('error-canary'), { code: '42501', detail: 'detail-canary' }); };
  t.mock.timers.tick(50); await tick();
  result.resolve('unchanged');
  assert.equal(await returned, 'unchanged');
  await diagnostics.close();
  const server = diagnostics.snapshot().server;
  assert.equal(server.reason, 'query'); assert.equal(server.sqlState, '42501');
  assert.equal(server.samples[0]?.outcome, 'rejected'); assert.equal(server.samples[0]?.late, false);
  assert.equal(server.samples[0]?.censored, true);
  assert.ok(!JSON.stringify(diagnostics.snapshot()).includes('canary'));
});

test('PGLOAD-OBS-06: closing cancels timers and ends a slow own transport, then observes its rejection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { diagnostics, monitor, client } = harness();
  await diagnostics.prepareMonitor('canary');
  const sample = deferred<{ rows: Record<string, unknown>[] }>();
  monitor.samples = () => sample.promise;
  monitor.end = async () => {
    sample.reject(new Error('transport-error-canary'));
    monitor.connection.emit('end'); monitor.emit('end');
  };
  const result = deferred<unknown>();
  const query = diagnostics.wrapQuery((() => result.promise) as unknown as typeof PgClient.prototype.query);
  diagnostics.run('mutation', 1000, 0, () => Reflect.apply(query, client, [lock]));
  t.mock.timers.tick(50); await tick();
  const closing = diagnostics.close();
  t.mock.timers.tick(50); await tick();
  await closing;
  const server = diagnostics.snapshot().server;
  assert.equal(server.cleanup.forced, true); assert.equal(server.cleanup.verified, true);
  assert.equal(server.cleanup.transportEnded, true); assert.equal(server.cleanup.pendingSettled, true);
  assert.equal(server.queryPending, false); assert.equal(server.pendingTimers, 0);
  t.mock.timers.tick(500); await tick(); assert.equal(monitor.calls.length, 3);
  result.resolve('business still controlled by its owner'); await tick();
  assert.ok(!JSON.stringify(diagnostics.snapshot()).includes('canary'));
});

test('PGLOAD-OBS-06: monitor connection/setup failure and disabled tracking remain unavailable', async t => {
  for (const mode of ['connect', 'setup', 'tracking'] as const) {
    const { diagnostics, monitor } = harness();
    if (mode === 'connect') monitor.connect = async () => { throw new Error('dsn-canary'); };
    if (mode === 'setup') monitor.query = () => Promise.reject(Object.assign(new Error('setup-canary'), { code: '42501' }));
    if (mode === 'tracking') monitor.query = async sql => ({ rows: sql.startsWith('SET ') ? [] : [{ timeout_ok: true, activities: false, blockers: true }] });
    await diagnostics.prepareMonitor('dsn-canary');
    assert.equal(diagnostics.snapshot().server.available, false);
    assert.equal(diagnostics.snapshot().server.cleanup.verified, true);
    assert.ok(!JSON.stringify(diagnostics.snapshot()).includes('canary'));
  }
});

test('PGLOAD-OBS-06: report failure closes the monitor and preserves an existing primary failure', async () => {
  for (const alreadyFailed of [true, false]) {
    const { diagnostics } = harness();
    await diagnostics.prepareMonitor('private');
    const original = Object.getOwnPropertyDescriptor(PgClient.prototype, 'query');
    const restore = installLoadQueryDiagnostics(diagnostics);
    const reportFailure = new Error('report-write-canary');
    let reported = false;
    try {
      const finishing = finishLoadReport(diagnostics, async () => { throw reportFailure; }, alreadyFailed, () => { reported = true; });
      if (alreadyFailed) await finishing;
      else await assert.rejects(finishing, error => error === reportFailure);
      assert.equal(diagnostics.snapshot().server.cleanup.verified, true);
      assert.equal(reported, true);
    } finally { restore(); }
    assert.deepEqual(Object.getOwnPropertyDescriptor(PgClient.prototype, 'query'), original);
  }
});

test('PGLOAD-OBS-04/06: invalid fields, missing PIDs and changed backend lifetime cannot look complete', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { diagnostics, monitor, client } = harness();
  await diagnostics.prepareMonitor('canary');
  let sample = 0;
  monitor.samples = async () => ({ rows: sample++ === 0 ? [row(42)] : sample === 2 ? [row(42, {
    backend_start: new Date('2026-01-01T01:00:00Z'), state: 'state-canary', wait_event_type: 'type-canary',
    wait_event: 'wait-canary'.repeat(30), xact_start: 'time-canary', blocking_pids: null,
  })] : [] });
  const result = deferred<unknown>();
  const query = diagnostics.wrapQuery((() => result.promise) as unknown as typeof PgClient.prototype.query);
  diagnostics.run('mutation', 1000, 0, () => Reflect.apply(query, client, [lock]));
  for (let index = 0; index < 3; index++) { t.mock.timers.tick(50); await tick(); }
  result.resolve(null); await tick(); await diagnostics.close();
  const samples = diagnostics.snapshot().server.samples;
  assert.equal(samples[1]?.rows[0]?.backendLifetime, 'changed');
  assert.equal(samples[1]?.rows[0]?.visibility, 'unknown');
  assert.equal(samples[1]?.censored, true); assert.equal(samples[2]?.censored, true);
  assert.deepEqual(samples[2]?.missingPids, [42]);
  assert.ok(!JSON.stringify(diagnostics.snapshot()).includes('canary'));
});

test('PGLOAD-OBS-06: an unproved transport close is reported as unverified, not as cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { diagnostics, monitor } = harness();
  await diagnostics.prepareMonitor('canary');
  let destroyed = false;
  Object.assign(monitor.connection, { stream: { destroy() { destroyed = true; } } });
  monitor.end = () => new Promise<void>(() => {});
  const closing = diagnostics.close();
  t.mock.timers.tick(250); await tick(); await closing;
  const cleanup = diagnostics.snapshot().server.cleanup;
  assert.equal(destroyed, true); assert.equal(cleanup.deadlineExceeded, true);
  assert.equal(cleanup.transportEnded, false); assert.equal(cleanup.verified, false);
});

test('PGLOAD-OBS-06: unexpected end lets pg finish its own end listener before Client.end', async () => {
  const { diagnostics, monitor } = harness();
  await diagnostics.prepareMonitor('private');
  let driverEnded = false;
  monitor.connection.once('end', () => { driverEnded = true; });
  monitor.end = () => driverEnded ? Promise.resolve() : new Promise<void>(() => {});
  monitor.connection.emit('end');
  await tick(); await diagnostics.close();
  assert.equal(diagnostics.snapshot().server.cleanup.verified, true);
});

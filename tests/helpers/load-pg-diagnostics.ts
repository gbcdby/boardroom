import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Client as PgClient, type ClientConfig, type QueryResult } from 'pg';

const rounded = (n: number) => Number(n.toFixed(3));

export type LoadBranch = 'wait' | 'mutation' | 'heartbeat' | 'traffic';
type LoadOrigin = { branch: LoadBranch; historyMessages: number; step: number; branchId: number };
type QueryCategory = 'begin' | 'commit' | 'rollback' | 'rollback-savepoint' | 'savepoint' | 'release-savepoint'
  | 'project-lock' | 'lock-timeout-100' | 'lock-timeout-200' | 'statement-timeout-200' | 'statement-timeout-250' | 'other';
type DiagnosticEvent = {
  event: 'query-start' | 'query-end' | 'query-end-unobserved' | 'branch-start' | 'branch-end';
  origin?: LoadOrigin; queryId?: number; clientId?: number; backendPid?: number | null; category?: QueryCategory;
  outcome?: 'fulfilled' | 'rejected' | 'sync-throw'; elapsedMs?: number; sqlState?: string | null;
};
type QueryObservation = { startedAt: number; data: DiagnosticEvent; custom: boolean; settledAt?: number };

/** Same last-N algorithm for the existing client trace and the smaller server log. */
class LastN<T> {
  private readonly events: Array<{ value: T; bytes: number } | undefined> = [];
  private head = 0; private count = 0;
  bytes = 0; dropped = 0;
  readonly maxEvents: number; readonly maxBytes: number;
  constructor(maxEvents: number, maxBytes: number) { this.maxEvents = maxEvents; this.maxBytes = maxBytes; }
  push(value: T): void {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > this.maxBytes) { this.dropped++; return; }
    while (this.count && (this.count === this.maxEvents || this.bytes + bytes > this.maxBytes)) {
      this.bytes -= this.events[this.head]!.bytes;
      this.events[this.head] = undefined; // Release the evicted record even if this slot is not overwritten next.
      this.head = (this.head + 1) % this.maxEvents;
      this.count--; this.dropped++;
    }
    this.events[(this.head + this.count) % this.maxEvents] = { value, bytes }; this.count++; this.bytes += bytes;
  }
  values(): T[] { return Array.from({ length: this.count }, (_, index) => this.events[(this.head + index) % this.maxEvents]!.value); }
}

/** 仅此接受门的被动 last-N 观察；不是 PG 锁图，也不把异步来源认定为锁拥有者。 */
export class LoadDiagnostics {
  private readonly origin = new AsyncLocalStorage<LoadOrigin>();
  private readonly clients = new WeakMap<object, number>();
  private readonly startedAt = performance.now();
  private readonly wallStartedAt = new Date().toISOString();
  private sequence = 0;
  private queryId = 0; private clientId = 0; private branchId = 0;
  private errors = 0; private unobservedEnds = 0;
  private readonly maxEvents = 4096;
  private readonly maxBytes = 4 * 1024 * 1024;
  private readonly events = new LastN<DiagnosticEvent & { sequence: number; atMs: number }>(this.maxEvents, this.maxBytes);
  private readonly server: ServerObserver;
  constructor(createMonitor: (config: ClientConfig) => PgClient = config => new PgClient(config)) {
    this.server = new ServerObserver(this.startedAt, createMonitor);
  }
  prepareMonitor(connectionString: string): Promise<void> { return this.server.prepare(connectionString); }
  close(): Promise<void> { return this.server.close(); }
  private record(data: DiagnosticEvent): void {
    try {
      const value = { ...data, sequence: ++this.sequence, atMs: rounded(performance.now() - this.startedAt) };
      this.events.push(value);
    } catch { this.errors++; }
  }
  private state(error: unknown): string | null {
    try {
      const code: unknown = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
      return code === '55P03' || code === '57014' || code === '40P01' || code === '25P02' ? code : null;
    } catch { return null; }
  }
  private start(client: object, input: unknown): QueryObservation | undefined {
    try {
      const text: unknown = typeof input === 'string' ? input
        : input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'text')?.value : undefined;
      const sql = typeof text === 'string' ? text.slice(0, 256).trim() : '';
      let category: QueryCategory = 'other';
      if (/^BEGIN\b/i.test(sql)) category = 'begin';
      else if (/^COMMIT\b/i.test(sql)) category = 'commit';
      else if (/^ROLLBACK TO\b/i.test(sql)) category = 'rollback-savepoint';
      else if (/^ROLLBACK\b/i.test(sql)) category = 'rollback';
      else if (/^SAVEPOINT\b/i.test(sql)) category = 'savepoint';
      else if (/^RELEASE SAVEPOINT\b/i.test(sql)) category = 'release-savepoint';
      else if (/^UPDATE projects SET updated_at = updated_at WHERE id = /i.test(sql)) category = 'project-lock';
      else if (/^SET LOCAL lock_timeout = '100ms'$/i.test(sql)) category = 'lock-timeout-100';
      else if (/^SET LOCAL lock_timeout = '200ms'$/i.test(sql)) category = 'lock-timeout-200';
      else if (/^SET LOCAL statement_timeout = '200ms'$/i.test(sql)) category = 'statement-timeout-200';
      else if (/^SET LOCAL statement_timeout = '250ms'$/i.test(sql)) category = 'statement-timeout-250';
      let clientId = this.clients.get(client);
      if (clientId === undefined) { clientId = ++this.clientId; this.clients.set(client, clientId); }
      const pid: unknown = Object.getOwnPropertyDescriptor(client, 'processID')?.value;
      const origin = this.origin.getStore();
      const data: DiagnosticEvent = { event: 'query-start', queryId: ++this.queryId, clientId, category,
        backendPid: typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : null,
        ...(origin ? { origin } : {}) };
      const custom = Boolean(input && typeof input === 'object' && typeof Object.getOwnPropertyDescriptor(input, 'submit')?.value === 'function');
      const observed = { startedAt: performance.now(), data, custom };
      this.record(data); this.server.noteClient(client, observed); return observed;
    } catch { this.errors++; return undefined; }
  }
  private end(observed: QueryObservation | undefined, outcome: NonNullable<DiagnosticEvent['outcome']>, error?: unknown): void {
    try {
      if (observed) {
        observed.settledAt = performance.now(); this.server.queryEnded(observed);
        this.record({ ...observed.data, event: 'query-end', outcome,
          elapsedMs: rounded(observed.settledAt - observed.startedAt), sqlState: this.state(error) });
      }
    } catch { this.errors++; }
  }
  wrapQuery(original: typeof PgClient.prototype.query): typeof PgClient.prototype.query {
    const trace = this;
    return function(this: PgClient, ...args: unknown[]) {
      if (trace.server.isMonitor(this)) return Reflect.apply(original, this, args);
      const observed = trace.start(this, args[0]);
      let result: unknown;
      try { result = Reflect.apply(original, this, args); }
      catch (error) { trace.end(observed, 'sync-throw', error); throw error; }
      // Do not replace callback/config arguments or custom Query objects. The
      // ordinary driver's native Promise is observed without replacing it.
      try {
        if (result instanceof Promise && !observed?.custom) {
          void Promise.prototype.then.call(result, () => trace.end(observed, 'fulfilled'), (error: unknown) => trace.end(observed, 'rejected', error));
          if (observed) trace.server.queryStarted(observed);
        } else {
          trace.unobservedEnds++;
          if (observed) trace.record({ ...observed.data, event: 'query-end-unobserved' });
        }
      } catch { trace.errors++; }
      return result;
    } as typeof PgClient.prototype.query;
  }
  run<T>(branch: LoadBranch, historyMessages: number, step: number, body: () => Promise<T>): Promise<T> {
    const origin = { branch, historyMessages, step, branchId: ++this.branchId }, startedAt = performance.now();
    if (branch === 'mutation') this.server.beginOperation(origin.branchId);
    try { this.record({ event: 'branch-start', origin }); } catch { this.errors++; }
    const finish = (outcome: NonNullable<DiagnosticEvent['outcome']>, error?: unknown) => {
      if (branch === 'mutation') this.server.endOperation(origin.branchId);
      try { this.record({ event: 'branch-end', origin, outcome, elapsedMs: rounded(performance.now() - startedAt), sqlState: this.state(error) }); }
      catch { this.errors++; }
    };
    let result: Promise<T>;
    try { result = this.origin.run(origin, body); }
    catch (error) { finish('sync-throw', error); throw error; }
    try { void Promise.prototype.then.call(result, () => finish('fulfilled'), (error: unknown) => finish('rejected', error)); }
    catch { this.errors++; }
    return result;
  }
  snapshot() {
    try {
      const events = this.events.values();
      return { schema: 'load-pg-query-observation/v1', wallStartedAt: this.wallStartedAt,
        maxEvents: this.maxEvents, maxBytes: this.maxBytes, retainedBytes: this.events.bytes, dropCount: this.events.dropped,
        diagnosticErrors: this.errors, unobservedQueryEnds: this.unobservedEnds,
        firstRetainedAtMs: events[0]?.atMs ?? null, observedUntilMs: rounded(performance.now() - this.startedAt),
        semantics: 'client query elapsed includes local queue/network/server; origin is inherited ancestry, not lock ownership; callback/custom/non-Promise ends are unobserved; pre-query gaps unattributed; server samples are sparse observations, not an ownership claim', events,
        server: this.server.snapshot() };
    } catch { return { schema: 'load-pg-query-observation/v1', diagnosticUnavailable: true, diagnosticErrors: ++this.errors, server: this.server.snapshot() }; }
  }
}

/** No MockTracker: its per-call history would retain SQL parameters/results. */
export function installLoadQueryDiagnostics(diagnostics: LoadDiagnostics): () => void {
  const original = Object.getOwnPropertyDescriptor(PgClient.prototype, 'query');
  assert.ok(original && typeof original.value === 'function', 'pg query must be an own data method');
  const installed = { ...original, value: diagnostics.wrapQuery(original.value as typeof PgClient.prototype.query) };
  Object.defineProperty(PgClient.prototype, 'query', installed);
  return () => {
    assert.deepEqual(Object.getOwnPropertyDescriptor(PgClient.prototype, 'query'), installed, 'pg query diagnostics installation owner changed');
    Object.defineProperty(PgClient.prototype, 'query', original);
  };
}

/** Called only after the unchanged foreground measurement/settlement path. */
export async function finishLoadReport(diagnostics: LoadDiagnostics | undefined, write: () => Promise<void>,
  alreadyFailed: boolean, reportFailure: () => void): Promise<void> {
  await diagnostics?.close();
  try { await write(); }
  catch (error) {
    try { reportFailure(); } catch { /* A diagnostic must not replace the original failure. */ }
    if (!alreadyFailed) throw error;
  }
}

const serverLimits = Object.freeze({ opportunityMs: [50, 100, 150] as const, snapshots: 36, rows: 180,
  pids: 5, blockersPerRow: 8, snapshotBytes: 8192, retainedBytes: 128 * 1024,
  connectMs: 250, statementMs: 50, setupQueries: 2, cleanupQueries: 0, cleanupMs: 250 });

// One fresh autocommit snapshot. No query text, parameters, roles or addresses.
// The MATERIALIZED CTE calls pg_blocking_pids only once per selected backend.
const sampleSql = `WITH targets AS MATERIALIZED (
  SELECT pid, backend_start, xact_start, query_start, state_change, state, wait_event_type, wait_event
    FROM pg_catalog.pg_stat_activity
   WHERE datid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
     AND pid = ANY($1::integer[]) AND pid <> pg_backend_pid() ORDER BY pid LIMIT 5
), edges AS MATERIALIZED (
  SELECT targets.*, pg_catalog.pg_blocking_pids(pid) AS blockers FROM targets
)
SELECT clock_timestamp() AS observed_at, pid, backend_start, xact_start, query_start,
       state_change, state, wait_event_type, wait_event, blockers[1:8] AS blocking_pids,
       cardinality(blockers) > 8 AS blockers_truncated FROM edges ORDER BY pid`;
const capabilitySql = `SELECT /* observer_capability */ current_setting('statement_timeout') = '50ms' AS timeout_ok,
  current_setting('track_activities') = 'on' AS activities,
  pg_catalog.pg_blocking_pids(pg_backend_pid()) IS NOT NULL AS blockers`;

function own(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
}
function pid(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647 ? value : null;
}
function serverError(error: unknown): string | null {
  const code = own(error, 'code');
  return typeof code === 'string' && ['42501', '57014', '57P01', '57P02', '57P03', '08000', '08003', '08006',
    '53300', '3D000', '28P01', '28000'].includes(code) ? code : null;
}
function timestamp(value: unknown): string | null {
  try {
    if (value instanceof Date) return new Date(Date.prototype.getTime.call(value)).toISOString();
    if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value)) return new Date(value).toISOString();
  } catch { /* Unknown is safer than a raw field. */ }
  return null;
}
function waitName(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? value : null;
}
async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise.then(() => true, () => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, ms)); })]);
  } finally { clearTimeout(timer); }
}

type Backend = { client: PgClient; clientId: number; pid: number; lastQuery: QueryObservation;
  backendStart: string | null; onEnd: () => void };
type ServerRow = { pid: number; clientId: number; observedAt: string | null; backendStart: string | null;
  xactStart: string | null; queryStart: string | null; stateChange: string | null;
  state: string | null; waitEventType: string | null; waitEvent: string | null;
  blockingPids: number[]; unknownBlockerPids: number[]; blockersTruncated: boolean; blockersKnown: boolean;
  visibility: 'observed' | 'unknown'; backendLifetime: 'first-observed' | 'matches' | 'changed' | 'unknown';
  queryIdAtSend: number | null; queryIdAtReturn: number | null; queryUnchanged: boolean };
type ServerSample = { queryId: number; clientId: number; backendPid: number; origin: LoadOrigin;
  opportunityMs: number; requestedAtMs: number; sentAtMs: number; returnedAtMs: number;
  targetSettledAtMs: number | null; timerLatenessMs: number; late: boolean; censored: boolean;
  outcome: 'fulfilled' | 'rejected'; sqlState: string | null; missingPids: number[]; rowsTruncated: boolean; rows: ServerRow[] };

/** Private to this acceptance diagnostic; it owns exactly one independent Client. */
class ServerObserver {
  private monitor: PgClient | undefined;
  private readonly createMonitor: (config: ClientConfig) => PgClient;
  private readonly startedAt: number;
  private readonly backends = new Map<number, Backend>();
  private readonly samples = new LastN<ServerSample>(serverLimits.snapshots, serverLimits.retainedBytes);
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private target: QueryObservation | undefined;
  private operation: number | undefined;
  private operationScheduled = false;
  private prepared = false; private closed = false; private available = false;
  private pending: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private resolveTransport: () => void = () => {};
  private readonly transportEnd = new Promise<void>(resolve => { this.resolveTransport = resolve; });
  private reason: 'not-prepared' | 'ready' | 'connect' | 'setup' | 'capability' | 'query' | 'transport' = 'not-prepared';
  private errorState: string | null = null;
  private scheduled = 0; private snapshots = 0; private rows = 0; private setupQueries = 0;
  private busySkips = 0; private limitSkips = 0; private staleSkips = 0; private cancelled = 0;
  private late = 0; private errors = 0; private pidEvictions = 0;
  private cleanup = { attempted: false, transportEnded: false, pendingSettled: true, endSettled: false,
    forced: false, deadlineExceeded: false, verified: false, backendExit: 'not-read-back' as const, elapsedMs: 0 };
  constructor(startedAt: number, createMonitor: (config: ClientConfig) => PgClient) {
    this.startedAt = startedAt; this.createMonitor = createMonitor;
  }
  isMonitor(client: object): boolean { return client === this.monitor; }
  private at(value = performance.now()): number { return rounded(value - this.startedAt); }
  private cancelTimers(): void {
    this.cancelled += this.timers.size;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
  private unavailable(reason: typeof this.reason, error?: unknown): void {
    this.available = false; this.reason = reason; this.errorState = serverError(error);
    this.errors++; this.cancelTimers();
  }
  private track<T>(promise: Promise<T>): Promise<T> {
    const pending = promise.then(() => {}, () => {});
    this.pending = pending;
    void pending.then(() => { if (this.pending === pending) this.pending = undefined; });
    return promise;
  }
  async prepare(connectionString: string): Promise<void> {
    if (this.prepared || this.closed) return;
    this.prepared = true;
    try {
      this.reason = 'connect';
      this.monitor = this.createMonitor({ connectionString, connectionTimeoutMillis: serverLimits.connectMs,
        statement_timeout: serverLimits.statementMs, query_timeout: 0, pipeline: false });
      this.monitor.on('error', error => {
        this.unavailable('transport', error);
        // Do not leave an independently failed monitor connected until the case ends.
        void this.close();
      });
      this.monitor.connection.once('end', () => {
        this.cleanup.transportEnded = true; this.resolveTransport();
        // pg's own connection-end listener must first mark Client._ended. Calling
        // Client.end from this earlier listener would wait for an end already emitting.
        queueMicrotask(() => { if (!this.closed) { this.unavailable('transport'); void this.close(); } });
      });
      const connected = this.track(this.monitor.connect());
      if (!await within(connected, serverLimits.connectMs)) throw null;
      await connected;
      this.reason = 'setup';
      // Explicit SET defeats a conflicting timeout in URL startup options; only this Client changes.
      for (const sql of ["SET statement_timeout = '50ms'", capabilitySql]) {
        this.setupQueries++;
        const query = this.track(this.monitor.query(sql));
        if (!await within(query, serverLimits.connectMs)) throw null;
        const result = await query;
        if (sql === capabilitySql && (!result.rows[0]?.timeout_ok || !result.rows[0]?.activities || !result.rows[0]?.blockers)) {
          this.reason = 'capability'; throw null;
        }
      }
      if (!this.closed) { this.reason = 'ready'; this.available = true; }
    } catch (error) { this.unavailable(this.reason, error); await this.close(); }
  }
  beginOperation(branchId: number): void {
    this.cancelTimers(); this.target = undefined; this.operation = branchId; this.operationScheduled = false;
  }
  endOperation(branchId: number): void {
    if (this.operation === branchId) { this.operation = undefined; this.cancelTimers(); }
  }
  noteClient(client: object, observed: QueryObservation): void {
    const data = observed.data;
    if (this.closed || !data.origin || !data.backendPid || !data.clientId) return;
    const previous = this.backends.get(data.clientId);
    if (previous?.pid === data.backendPid) { previous.lastQuery = observed; return; }
    if (previous) { previous.client.removeListener('end', previous.onEnd); this.backends.delete(data.clientId); }
    if (this.backends.size === serverLimits.pids) {
      const oldest = this.backends.values().next().value!;
      oldest.client.removeListener('end', oldest.onEnd); this.backends.delete(oldest.clientId); this.pidEvictions++;
    }
    const backend: Backend = { client: client as PgClient, clientId: data.clientId, pid: data.backendPid,
      lastQuery: observed, backendStart: null, onEnd: () => {
        if (this.backends.get(backend.clientId) === backend) this.backends.delete(backend.clientId);
        if (this.target?.data.clientId === backend.clientId) this.cancelTimers();
      } };
    backend.client.once('end', backend.onEnd); this.backends.set(backend.clientId, backend);
  }
  private current(target: QueryObservation): boolean {
    return !this.closed && this.target === target && target.settledAt === undefined
      && this.operation === target.data.origin?.branchId
      && this.backends.get(target.data.clientId!)?.pid === target.data.backendPid;
  }
  queryStarted(target: QueryObservation): void {
    const data = target.data;
    if (this.closed || !this.available || data.category !== 'project-lock' || data.origin?.branch !== 'mutation'
      || this.operation !== data.origin.branchId || !data.backendPid || this.operationScheduled) return;
    this.operationScheduled = true;
    if (this.scheduled + 3 > serverLimits.snapshots) { this.limitSkips++; return; }
    this.target = target; this.scheduled += 3;
    for (const opportunity of serverLimits.opportunityMs) {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        if (!this.available || !this.current(target)) { this.staleSkips++; return; }
        if (this.pending) { this.busySkips++; return; }
        void this.sample(target, opportunity);
      }, Math.max(0, Math.ceil(target.startedAt + opportunity - performance.now())));
      this.timers.add(timer);
    }
  }
  queryEnded(target: QueryObservation): void { if (this.target === target) this.cancelTimers(); }
  private async sample(target: QueryObservation, opportunityMs: number): Promise<void> {
    const sent = performance.now(), data = target.data;
    const selected = [...this.backends.values()].slice(0, serverLimits.pids)
      .map(backend => ({ backend, queryId: backend.lastQuery.data.queryId ?? null }));
    const selectedPids = selected.map(value => value.backend.pid);
    this.snapshots++;
    let result: QueryResult | undefined, failed = false, sqlState: string | null = null;
    try { result = await this.track(this.monitor!.query(sampleSql, [selectedPids])); }
    catch (error) { failed = true; sqlState = serverError(error); this.unavailable('query', error); }
    try {
      const late = !this.current(target);
      if (late) this.late++;
      const rawRows: unknown[] = Array.isArray(result?.rows) ? result.rows : [];
      const rows: ServerRow[] = [];
      for (const raw of rawRows.slice(0, serverLimits.pids)) {
        const backendPid = pid(own(raw, 'pid'));
        const binding = selected.find(value => value.backend.pid === backendPid);
        if (!binding || rows.some(value => value.pid === backendPid)) continue;
        const backend = binding.backend, backendStart = timestamp(own(raw, 'backend_start'));
        const stillSameClient = this.backends.get(backend.clientId) === backend && pid(own(backend.client, 'processID')) === backend.pid;
        const backendLifetime = !stillSameClient || !backendStart ? 'unknown'
          : !backend.backendStart ? 'first-observed' : backend.backendStart === backendStart ? 'matches' : 'changed';
        if (stillSameClient && backendStart && !backend.backendStart) backend.backendStart = backendStart;
        const rawState = own(raw, 'state');
        const state = typeof rawState === 'string' && ['active', 'idle', 'idle in transaction', 'idle in transaction (aborted)',
          'fastpath function call', 'disabled'].includes(rawState) ? rawState : null;
        const rawType = own(raw, 'wait_event_type');
        const waitEventType = typeof rawType === 'string' && ['Activity', 'BufferPin', 'Client', 'Extension', 'IO', 'IPC', 'Lock', 'LWLock', 'Timeout'].includes(rawType) ? rawType : null;
        const blockers = own(raw, 'blocking_pids');
        const blockingPids = Array.isArray(blockers) ? blockers.slice(0, serverLimits.blockersPerRow)
          .filter((value): value is number => value === 0 || pid(value) !== null) : [];
        const blockersKnown = Array.isArray(blockers) && blockers.slice(0, serverLimits.blockersPerRow)
          .every(value => value === 0 || pid(value) !== null);
        const queryIdAtReturn = stillSameClient ? backend.lastQuery.data.queryId ?? null : null;
        rows.push({ pid: backend.pid, clientId: backend.clientId, observedAt: timestamp(own(raw, 'observed_at')), backendStart,
          xactStart: timestamp(own(raw, 'xact_start')), queryStart: timestamp(own(raw, 'query_start')), stateChange: timestamp(own(raw, 'state_change')),
          state, waitEventType, waitEvent: waitName(own(raw, 'wait_event')), blockingPids, blockersKnown,
          unknownBlockerPids: blockingPids.filter(value => !selectedPids.includes(value)),
          blockersTruncated: own(raw, 'blockers_truncated') === true || (Array.isArray(blockers) && blockers.length > serverLimits.blockersPerRow),
          visibility: state && state !== 'disabled' && backendStart ? 'observed' : 'unknown', backendLifetime,
          queryIdAtSend: binding.queryId, queryIdAtReturn, queryUnchanged: binding.queryId === queryIdAtReturn });
      }
      this.rows += rows.length;
      const missingPids = selectedPids.filter(value => !rows.some(row => row.pid === value));
      const value: ServerSample = { queryId: data.queryId!, clientId: data.clientId!, backendPid: data.backendPid!, origin: data.origin!,
        opportunityMs, requestedAtMs: this.at(target.startedAt + opportunityMs), sentAtMs: this.at(sent), returnedAtMs: this.at(),
        targetSettledAtMs: target.settledAt === undefined ? null : this.at(target.settledAt),
        timerLatenessMs: rounded(Math.max(0, sent - target.startedAt - opportunityMs)), late,
        censored: failed || late || !!missingPids.length || rawRows.length > serverLimits.pids || rows.some(row => row.visibility === 'unknown'
          || !row.blockersKnown || !row.observedAt || row.blockersTruncated || row.unknownBlockerPids.length > 0
          || row.backendLifetime === 'unknown' || row.backendLifetime === 'changed' || !row.queryUnchanged),
        outcome: failed ? 'rejected' : 'fulfilled', sqlState, missingPids, rowsTruncated: rawRows.length > serverLimits.pids, rows };
      while (Buffer.byteLength(JSON.stringify(value)) > serverLimits.snapshotBytes && value.rows.length) {
        value.rows.pop(); value.rowsTruncated = true; value.censored = true;
      }
      this.samples.push(value);
    } catch { this.errors++; }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.available = false; this.cancelTimers();
    for (const backend of this.backends.values()) backend.client.removeListener('end', backend.onEnd);
    this.backends.clear();
    this.closing = this.finishClose().catch(() => {
      this.errors++; this.cleanup.verified = false;
      try { this.monitor?.connection.stream.destroy(); } catch { /* Cleanup remains explicitly unverified. */ }
    });
    return this.closing;
  }
  private async finishClose(): Promise<void> {
    const started = performance.now();
    this.cleanup.attempted = true;
    if (!this.monitor) { this.cleanup.verified = true; return; }
    const pending = this.pending;
    this.cleanup.pendingSettled = !pending;
    if (pending) void pending.then(() => { this.cleanup.pendingSettled = true; });
    // A small grace within the total 250 ms close window; then end only our Client.
    if (pending) this.cleanup.forced = !await within(pending, serverLimits.statementMs);
    try {
      const ended = this.monitor.end().then(() => { this.cleanup.endSettled = true; }, () => { this.errors++; });
      const complete = await within(Promise.all([ended, this.transportEnd, pending]),
        serverLimits.cleanupMs - (performance.now() - started));
      this.cleanup.deadlineExceeded = !complete;
      if (!complete) {
        this.cleanup.forced = true;
        // This is an actual transport action, never a claim that the race cancelled SQL.
        this.monitor.connection.stream.destroy();
      }
    } catch { this.errors++; this.cleanup.forced = true; this.monitor.connection.stream.destroy(); }
    this.cleanup.elapsedMs = rounded(performance.now() - started);
    this.cleanup.verified = this.cleanup.transportEnded && this.cleanup.pendingSettled && this.cleanup.endSettled;
  }
  snapshot() {
    return { schema: 'load-pg-server-observation/v1', limits: serverLimits, available: this.available, closed: this.closed, reason: this.reason,
      sqlState: this.errorState, scheduledOpportunities: this.scheduled, snapshotCount: this.snapshots, rowCount: this.rows,
      setupQueryCount: this.setupQueries, cleanupQueryCount: 0, retainedBytes: this.samples.bytes, dropCount: this.samples.dropped,
      busySkips: this.busySkips, limitSkips: this.limitSkips, staleSkips: this.staleSkips, cancelledTimers: this.cancelled,
      lateCount: this.late, diagnosticErrors: this.errors, pidEvictions: this.pidEvictions, pendingTimers: this.timers.size,
      queryPending: !!this.pending, cleanup: { ...this.cleanup },
      semantics: 'sparse autocommit server samples; unavailable/null/missing/late/truncated data remain unknown; direct blockers can be waiters; origin is ancestry, never ownership; no out-of-set expansion; first-observed lifetime is not a prior lifetime proof; timings retain observer CPU/scheduling/lock-manager interference; no cleanup SQL or backend-exit readback',
      samples: this.samples.values() };
  }
}


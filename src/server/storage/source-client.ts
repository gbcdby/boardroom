import Database from "better-sqlite3";
import { Client } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readlink } from "node:fs/promises";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import type { DbDriver, DbDriverOptions, DbRow } from "../db/driver.ts";
import { OperationQueue } from "../db/operation-queue.ts";
import { assertSqliteSourceUnchanged, databaseDriverOptions, type DatabaseDescriptor,
  type ResolvedBoardroomEnvironment } from "../environment.ts";
import type { RunnerFence } from "../runtime/types.ts";
import type { OwnedProcessIdentity } from "../runtime/hosts/types.ts";
import { assertStorageAdmission, parseStorageMaintenanceState, StorageMaintenanceError,
  type StorageAdmissionIdentity, type StorageMaintenanceState } from "./admission.ts";
import { bindStorageDrainBoundary, type StorageDrainBoundary } from "./drain-boundary.ts";

export const STORAGE_CLIENT_BUILD = "boardroom-storage-drain-v1";
export type StorageClientEntrypoint = "http" | "stdio" | "owned-background";
export interface StorageOwnedExitEvidence {
  readonly fence: RunnerFence;
  readonly processIdentity: OwnedProcessIdentity;
  readonly observation: "owned_handle_exited";
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly observedAt: string;
}
export interface StorageRuntimeDrainEvidence {
  readonly ownedExits: readonly StorageOwnedExitEvidence[];
  readonly unknownOwners: readonly string[];
}
export interface StorageDrainReceipt {
  readonly formatVersion: 1;
  readonly kind: "source-client-drain";
  readonly clientId: string;
  readonly entrypoint: StorageClientEntrypoint | "local-management";
  readonly buildId: typeof STORAGE_CLIENT_BUILD | "boardroom-native-management-v1";
  readonly databaseInstanceId: string;
  readonly sourceIdentityDigest: string;
  readonly processIdentityDigest: string;
  readonly registeredEpoch: number;
  readonly drainEpoch: number;
  readonly ownerGeneration: number;
  readonly migrationId: string;
  readonly planDigest: string;
  readonly quiescence: Readonly<{ activeTransactions: 0; activeJobs: 0; openFileWriters: 0; businessConnectionsClosed: true }>;
  readonly ownedExits: readonly StorageOwnedExitEvidence[];
  readonly completedAt: string;
  readonly nativeTransactions?: Readonly<{ committed: number; rolledBack: number; notAdmitted: number }>;
}
export interface StorageClientSessionEnvelope {
  readonly formatVersion: 1;
  readonly sourceIdentity: Readonly<Record<string, unknown>>;
  readonly sessions: readonly Readonly<Record<string, unknown>>[];
  readonly drainReceipt: StorageDrainReceipt | null;
}
export interface StorageClientDiagnostic {
  readonly code: "storage_maintenance" | "migration_incomplete" | null;
  readonly status: "open" | "draining" | "drained" | "blocked" | "restart_required" | "closed";
  readonly clientId: string;
  readonly registeredEpoch: number;
  readonly observedEpoch: number;
  readonly blocker: "drain_incomplete" | "source_changed" | "source_writer_unknown" | "epoch_changed" | null;
}
export interface StorageClientLifecycle {
  /** Only stop admission/timers here. No database writes or user stop intent. */
  stopNewWork(epoch: number): void;
  disconnectSessions(): Promise<void>;
  stopOwnedRuntime(): Promise<StorageRuntimeDrainEvidence>;
  /** Only exact internally registered owned-exit tokens are accepted by the supervisor. */
  observeOwnedExit(input: unknown): Promise<unknown>;
  closeMemory(): Promise<void>;
}
export interface StorageSourceClient {
  readonly clientId: string;
  readonly identity: StorageAdmissionIdentity;
  readonly accepting: boolean;
  readonly diagnostic: StorageClientDiagnostic;
  bind(lifecycle: StorageClientLifecycle): Promise<void>;
  startWatching(pollMs?: number): void;
  refresh(): Promise<void>;
  assertAdmission(): Promise<void>;
  run<T>(operation: () => Promise<T>): Promise<T>;
  waitForDrain(): Promise<StorageDrainReceipt>;
  observeOwnedExit(input: unknown): Promise<unknown>;
  close(): Promise<void>;
}

const clients = new WeakMap<DbDriver, StorageSourceClient>();
export function storageWorkMayStart(db: DbDriver): boolean { return clients.get(db)?.accepting ?? true; }
export function runStorageWork<T>(db: DbDriver, operation: () => Promise<T>): Promise<T> {
  return clients.get(db)?.run(operation) ?? operation();
}

/** Tag every PG pool connection before it exists. A tag is an inventory key, never exit proof. */
export function storageClientDriverOptions(environment: ResolvedBoardroomEnvironment, clientId: string): DbDriverOptions {
  const options = databaseDriverOptions(environment);
  if (options.dbDriver !== "postgres") return options;
  const url = new URL(options.pgConnectionString!);
  url.searchParams.set("application_name", `boardroom-source:${clientId}`);
  return { ...options, pgConnectionString: url.toString() };
}

/** Canonical receipt body: sorted object keys, ordered arrays, no implicit undefined/coercion. */
export function canonicalStorageJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStorageJson).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalStorageJson((value as DbRow)[key])}`).join(",")}}`;
  throw new Error("storage_receipt_invalid");
}
export function storageReceiptDigest(value: unknown): string {
  return createHash("sha256").update(canonicalStorageJson(value)).digest("hex");
}

/** D must additionally check the current sealed marker/source/OS inventory under its own mutex.
 * expected.ownerGeneration is the legally captured receipt generation. Reusing an older
 * generation requires D's anchored capture-to-current journal proof, not this verifier.
 */
export function verifyStorageDrainReceipt(row: DbRow, expected: {
  databaseInstanceId: string; fenceEpoch: number; ownerGeneration: number; migrationId: string; planDigest: string;
}): StorageDrainReceipt {
  try {
    const envelope = JSON.parse(String(row.db_sessions_json)) as StorageClientSessionEnvelope;
    const r = envelope.drainReceipt;
    const fields = ["formatVersion", "kind", "clientId", "entrypoint", "buildId", "databaseInstanceId", "sourceIdentityDigest",
      "processIdentityDigest", "registeredEpoch", "drainEpoch", "ownerGeneration", "migrationId", "planDigest", "quiescence", "ownedExits", "completedAt"];
    const native = r?.buildId === "boardroom-native-management-v1" && r.entrypoint === "local-management";
    if (native) fields.push("nativeTransactions");
    if (envelope.formatVersion !== 1 || !Array.isArray(envelope.sessions) || !r || r.formatVersion !== 1
      || Object.keys(envelope).sort().join() !== ["formatVersion", "sourceIdentity", "sessions", "drainReceipt"].sort().join()
      || Object.keys(r).sort().join() !== fields.sort().join()
      || r.kind !== "source-client-drain" || (!native && (r.buildId !== STORAGE_CLIENT_BUILD || !["http", "stdio", "owned-background"].includes(r.entrypoint)))
      || row.build_id !== r.buildId
      || row.protocol_version !== 1 || row.drain_state !== "drained" || row.client_id !== r.clientId
      || row.entrypoint !== r.entrypoint || row.database_instance_id !== r.databaseInstanceId
      || r.databaseInstanceId !== expected.databaseInstanceId || r.drainEpoch !== expected.fenceEpoch
      || r.ownerGeneration !== expected.ownerGeneration || Number(row.drain_epoch) !== r.drainEpoch
      || r.migrationId !== expected.migrationId || r.planDigest !== expected.planDigest
      || !Number.isSafeInteger(r.registeredEpoch) || r.registeredEpoch < 0
      || !Number.isSafeInteger(r.drainEpoch) || !Number.isSafeInteger(r.ownerGeneration) || r.ownerGeneration < 1
      || Number(row.registered_epoch) !== r.registeredEpoch || r.drainEpoch !== r.registeredEpoch + 1
      || Number(row.observed_epoch) !== r.drainEpoch
      || storageReceiptDigest(envelope.sourceIdentity) !== r.sourceIdentityDigest
      || storageReceiptDigest(JSON.parse(String(row.process_identity_json))) !== r.processIdentityDigest
      || row.drain_receipt_digest !== storageReceiptDigest(r)
      || !r.migrationId || !/^[a-f0-9]{64}$/.test(r.planDigest)
      || !Number.isFinite(Date.parse(r.completedAt)) || !Array.isArray(r.ownedExits)
      || canonicalStorageJson(r.quiescence) !== canonicalStorageJson({ activeTransactions: 0, activeJobs: 0, openFileWriters: 0, businessConnectionsClosed: true }))
      throw new Error();
    if (native && (!r.nativeTransactions || Object.keys(r.nativeTransactions).sort().join() !== "committed,notAdmitted,rolledBack"
      || Object.values(r.nativeTransactions).some(value => !Number.isSafeInteger(value) || value < 0))) throw new Error();
    for (const exit of r.ownedExits) if (exit.observation !== "owned_handle_exited" || !exit.processIdentity
      || exit.processIdentity.version !== 1 || exit.processIdentity.launcherProtocol !== "linux-private-net-v1"
      || !Number.isSafeInteger(exit.processIdentity.pid) || exit.processIdentity.pid < 1
      || !/^[0-9a-f-]{36}$/.test(exit.processIdentity.kernelBootId) || !/^pid:\[\d+\]$/.test(exit.processIdentity.pidNamespace)
      || !/^\d+$/.test(exit.processIdentity.startTicks)
      || !exit.fence?.owner || !Number.isSafeInteger(exit.fence.generation) || exit.fence.generation < 1
      || (exit.exitCode !== null && !Number.isInteger(exit.exitCode)) || (exit.signal !== null && typeof exit.signal !== "string")
      || !Number.isFinite(Date.parse(exit.observedAt))) throw new Error();
    return r;
  } catch { throw new Error("storage_drain_receipt_invalid"); }
}

async function currentProcessIdentity(): Promise<Record<string, unknown>> {
  const local = { version: 1, platform: process.platform, pid: process.pid, instanceId: randomUUID() };
  if (process.platform === "darwin") {
    try {
      const { darwinCurrentProcessIdentity } = await import("./maintenance/darwin.ts");
      return { ...local, ...darwinCurrentProcessIdentity() };
    } catch { return { ...local, verification: "process_local_only" }; }
  }
  if (process.platform !== "linux") return { ...local, verification: "process_local_only" };
  try {
    const [boot, namespace, stat] = await Promise.all([readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      readlink("/proc/self/ns/pid"), readFile("/proc/self/stat", "utf8")]);
    const ticks = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19];
    if (Number(stat.slice(0, stat.indexOf(" "))) !== process.pid || !ticks || !/^\d+$/.test(ticks)
      || !/^pid:\[\d+\]$/.test(namespace) || !/^[a-f0-9-]{36}$/.test(boot.trim())) throw new Error();
    return { ...local, verification: "linux_proc_identity_v1", kernelBootId: boot.trim(), pidNamespace: namespace, startTicks: ticks };
  } catch { return { ...local, verification: "process_local_only" }; }
}

interface ControlConnection {
  query(sql: string, params?: readonly unknown[]): Promise<DbRow[]>;
  exec(sql: string, params?: readonly unknown[]): Promise<number>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  verifySource(): Promise<void>;
  verifyBusinessClosed(): Promise<void>;
  retireWrites(): Promise<void>;
  close(): Promise<void>;
  readonly sourceIdentity: Record<string, unknown>;
  readonly sessions: readonly Record<string, unknown>[];
}

async function openControl(database: DatabaseDescriptor, clientId: string, requireBusiness = true): Promise<ControlConnection> {
  if (database.kind === "sqlite") {
    assertSqliteSourceUnchanged(database);
    let db: Database.Database | null = new Database(database.sqlitePath, { fileMustExist: true, timeout: 0 });
    try {
      assertSqliteSourceUnchanged(database);
      db.pragma("synchronous=FULL");
      return {
        sourceIdentity: { kind: "sqlite", sourcePath: database.sourcePath, sqlitePath: database.sqlitePath, ...database.identity },
        sessions: [{ kind: "sqlite", owner: "local-driver" }, { kind: "sqlite", owner: "client-control" }],
        async query(sql, params = []) {
          if (db) return db.prepare(sql).all(...params) as DbRow[];
          assertSqliteSourceUnchanged(database);
          const diagnostic = new Database(database.sqlitePath, { readonly: true, fileMustExist: true, timeout: 0 });
          try {
            diagnostic.pragma("query_only=ON");
            const rows = diagnostic.prepare(sql).all(...params) as DbRow[];
            assertSqliteSourceUnchanged(database); return rows;
          } finally { diagnostic.close(); }
        },
        async exec(sql, params = []) { if (!db) throw new StorageMaintenanceError("active"); return db.prepare(sql).run(...params).changes; },
        async begin() { if (!db) throw new StorageMaintenanceError("active"); db.exec("BEGIN IMMEDIATE"); },
        async commit() { if (!db) throw new StorageMaintenanceError("active"); db.exec("COMMIT"); },
        async rollback() { if (db?.inTransaction) db.exec("ROLLBACK"); },
        async verifySource() { assertSqliteSourceUnchanged(database); }, async verifyBusinessClosed() {},
        async retireWrites() { db?.close(); db = null; },
        async close() { db?.close(); db = null; },
      };
    } catch (error) { db?.close(); throw error; }
  }
  if (database.schema !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(database.schema)) throw new StorageMaintenanceError("metadata_invalid");
  const connectionUrl = new URL(database.connectionString); connectionUrl.searchParams.set("application_name", `boardroom-control:${clientId}`);
  const client = new Client({ connectionString: connectionUrl.toString(),
    ...(database.schema === undefined ? {} : { options: `-c search_path=${database.schema}` }) });
  client.on("error", () => {});
  await client.connect();
  let writable = true;
  const diagnosticQuery = async (sql: string, params: readonly unknown[] = []) => {
    const readUrl = new URL(database.connectionString); readUrl.searchParams.set("application_name", `boardroom-diagnostic:${clientId}`);
    const reader = new Client({ connectionString: readUrl.toString(),
      options: `${database.schema === undefined ? "" : `-c search_path=${database.schema} `}-c default_transaction_read_only=on` });
    reader.on("error", () => {}); await reader.connect();
    try {
      // A connectionString may itself contain options, so enforce the diagnostic
      // read-only setting on the actual session before its first source query.
      await reader.query("SET default_transaction_read_only=on");
      return await reader.query(sql, [...params]);
    } finally { await reader.end(); }
  };
  const render = (sql: string) => { let index = 0; return sql.replace(/\?/g, () => `$${++index}`); };
  try {
    const identitySql = `SELECT d.oid::text AS database_oid,n.oid::text AS schema_oid,
      current_database() AS database_name,current_schema() AS schema_name
      FROM pg_database d,pg_namespace n WHERE d.datname=current_database() AND n.nspname=current_schema()`;
    const original = (await client.query(identitySql)).rows[0] as DbRow | undefined;
    if (!original) throw new StorageMaintenanceError("metadata_invalid");
    const own = (await client.query("SELECT pid,backend_start::text,application_name FROM pg_stat_activity WHERE pid=pg_backend_pid()")).rows;
    const businessName = `boardroom-source:${clientId}`;
    const business = (await client.query("SELECT pid,backend_start::text,application_name FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1", [businessName])).rows;
    if (requireBusiness && !business.length) throw new StorageMaintenanceError("metadata_invalid");
    return {
      sourceIdentity: { kind: "postgres", ...original, configurationDigest: createHash("sha256").update(database.connectionString).digest("hex") },
      sessions: [{ kind: "postgres", owner: "local-driver", applicationName: businessName, observedBackends: business },
        { kind: "postgres", owner: "client-control", observedBackends: own }],
      async query(sql, params = []) { return (await (writable ? client.query(render(sql), [...params]) : diagnosticQuery(render(sql), params))).rows; },
      async exec(sql, params = []) { if (!writable) throw new StorageMaintenanceError("active"); return (await client.query(render(sql), [...params])).rowCount ?? 0; },
      async begin() { if (!writable) throw new StorageMaintenanceError("active"); await client.query("BEGIN"); await client.query("SET LOCAL synchronous_commit=on"); },
      async commit() { await client.query("COMMIT"); }, async rollback() { await client.query("ROLLBACK"); },
      async verifySource() {
        if (canonicalStorageJson((await (writable ? client.query(identitySql) : diagnosticQuery(identitySql))).rows[0]) !== canonicalStorageJson(original))
          throw new StorageMaintenanceError("metadata_invalid");
      },
      async verifyBusinessClosed() {
        for (let attempt = 0; ; attempt += 1) {
          const remaining = await client.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1", [businessName]);
          if (!remaining.rows.length) return;
          if (attempt >= 9) throw new Error("storage_drain_incomplete");
          await delay(20);
        }
      },
      async retireWrites() { if (writable) { await client.end(); writable = false; } },
      async close() { if (writable) { await client.end(); writable = false; } },
    };
  } catch (error) { await client.end().catch(() => {}); throw error; }
}

/** One process-owned registration per driver. No raw connection or arbitrary control SQL escapes. */
export async function registerStorageSourceClient(options: {
  db: DbDriver; database: DatabaseDescriptor; entrypoint: StorageClientEntrypoint; clientId?: string;
}): Promise<StorageSourceClient> {
  const { db, database, entrypoint } = options;
  if (clients.has(db)) throw new StorageMaintenanceError("metadata_invalid");
  const clientId = options.clientId ?? randomUUID();
  const processIdentity = await currentProcessIdentity();
  const control = await openControl(database, clientId);
  const queue = new OperationQueue();
  const envelope: StorageClientSessionEnvelope = { formatVersion: 1, sourceIdentity: control.sourceIdentity, sessions: control.sessions, drainReceipt: null };
  const registeredAt = new Date().toISOString();
  let initial: StorageMaintenanceState;
  try {
    initial = await db.transaction(async tx => {
      await control.verifySource();
      const state = parseStorageMaintenanceState(await tx.query("SELECT * FROM storage_maintenance"));
      assertStorageAdmission(state);
      await tx.exec(`INSERT INTO storage_source_clients(client_id,database_instance_id,entrypoint,build_id,protocol_version,
        host_identity_json,process_identity_json,db_sessions_json,registered_epoch,observed_epoch,registered_at,last_observed_at)
        VALUES(?,?,?,?,1,?,?,?,?,?,?,?)`, [clientId, state.databaseInstanceId, entrypoint, STORAGE_CLIENT_BUILD,
        canonicalStorageJson({ version: 1, hostname: hostname(), platform: process.platform }), canonicalStorageJson(processIdentity),
        canonicalStorageJson(envelope), state.fenceEpoch, state.fenceEpoch, registeredAt, registeredAt]);
      await control.verifySource();
      return state;
    });
  } catch (error) { await control.close(); throw error; }
  const identity = Object.freeze({ databaseInstanceId: initial.databaseInstanceId, fenceEpoch: initial.fenceEpoch });
  let accepting = true, ended = false;
  let boundary: StorageDrainBoundary | null = null, lifecycle: StorageClientLifecycle | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pendingDrain: Promise<StorageDrainReceipt> | null = null, closePromise: Promise<void> | null = null;
  let drainState: StorageMaintenanceState | null = null;
  let newWorkStopped = false;
  let diagnostic: StorageClientDiagnostic = { code: null, status: "open", clientId, registeredEpoch: identity.fenceEpoch,
    observedEpoch: identity.fenceEpoch, blocker: null };
  const active = new Set<Promise<unknown>>();
  const stopNewWork = (epoch: number) => {
    accepting = false;
    if (!newWorkStopped) { newWorkStopped = true; lifecycle?.stopNewWork(epoch); }
  };
  const changed = (status: StorageClientDiagnostic["status"], blocker: StorageClientDiagnostic["blocker"] = null) => {
    diagnostic = { ...diagnostic, status, blocker, code: status === "open" ? null : blocker === "source_changed" ? "migration_incomplete" : "storage_maintenance" };
  };
  const readState = async (locked = false) => {
    await control.verifySource();
    const state = parseStorageMaintenanceState(await control.query(`SELECT * FROM storage_maintenance${locked && db.kind === "postgres" ? " FOR SHARE" : ""}`));
    if (state.databaseInstanceId !== identity.databaseInstanceId) throw new StorageMaintenanceError("metadata_invalid");
    return state;
  };
  const mutateOwn = <T>(fn: (state: StorageMaintenanceState, row: DbRow) => Promise<T>): Promise<T> => queue.run(async () => {
    // Two cooperating clients can publish their own short control updates at once.
    // Retry only lock acquisition with a fixed bound, never a lifecycle callback.
    for (let attempt = 0; ; attempt += 1) {
      await control.verifySource();
      try { await control.begin(); break; }
      catch (error) {
        if (db.kind !== "sqlite" || (error as { code?: string }).code !== "SQLITE_BUSY" || attempt >= 49) throw error;
        await delay(10);
      }
    }
    try {
      const state = await readState(true);
      const rows = await control.query("SELECT * FROM storage_source_clients WHERE client_id=?", [clientId]);
      const row = rows[0];
      if (rows.length !== 1 || !row || row.database_instance_id !== identity.databaseInstanceId
        || Number(row.registered_epoch) !== identity.fenceEpoch || row.ended_at !== null
        || row.process_identity_json !== canonicalStorageJson(processIdentity)) throw new StorageMaintenanceError("metadata_invalid");
      const result = await fn(state, row);
      await control.verifySource(); await control.commit(); return result;
    } catch (error) { await control.rollback(); throw error; }
  });
  async function waitForOrdinaryWork(): Promise<void> {
    while (active.size) await Promise.allSettled([...active]);
  }
  async function performDrain(state: StorageMaintenanceState): Promise<StorageDrainReceipt> {
    if (!boundary || !lifecycle) throw new Error("storage_drain_incomplete");
    await mutateOwn(async (current, row) => {
      if (current.admission !== "draining" || current.fenceEpoch !== identity.fenceEpoch + 1
        || current.fenceEpoch !== state.fenceEpoch || current.ownerGeneration !== state.ownerGeneration
        || current.activeMigrationId !== state.activeMigrationId
        || (!["none", "requested"].includes(String(row.drain_state)) && !(row.drain_state === "draining" && Number(row.drain_epoch) === state.fenceEpoch)))
        throw new StorageMaintenanceError("active");
      await control.exec(`UPDATE storage_source_clients SET observed_epoch=?,drain_epoch=?,drain_state='draining',last_observed_at=?
        WHERE client_id=? AND registered_epoch=? AND ended_at IS NULL`, [state.fenceEpoch, state.fenceEpoch, new Date().toISOString(), clientId, identity.fenceEpoch]);
    });
    const results = await Promise.allSettled([
      boundary.invoke("disconnect_sessions", state.fenceEpoch), boundary.invoke("stop_owned_runtime", state.fenceEpoch),
      boundary.invoke("close_memory", state.fenceEpoch),
    ]);
    await waitForOrdinaryWork();
    if (results.some(result => result.status === "rejected")) throw new Error("storage_drain_incomplete");
    const runtime = (results[1] as PromiseFulfilledResult<StorageRuntimeDrainEvidence>).value;
    if (!runtime || !Array.isArray(runtime.ownedExits) || !Array.isArray(runtime.unknownOwners) || runtime.unknownOwners.length)
      throw new Error("storage_source_writer_unknown");
    await db.close();
    await queue.run(() => control.verifyBusinessClosed());
    const receipt: StorageDrainReceipt = { formatVersion: 1, kind: "source-client-drain", clientId, entrypoint,
      buildId: STORAGE_CLIENT_BUILD, databaseInstanceId: identity.databaseInstanceId,
      sourceIdentityDigest: storageReceiptDigest(control.sourceIdentity), processIdentityDigest: storageReceiptDigest(processIdentity),
      registeredEpoch: identity.fenceEpoch, drainEpoch: state.fenceEpoch, ownerGeneration: state.ownerGeneration,
      migrationId: state.activeMigrationId!, planDigest: state.planDigest!,
      quiescence: { activeTransactions: 0, activeJobs: 0, openFileWriters: 0, businessConnectionsClosed: true },
      ownedExits: runtime.ownedExits, completedAt: new Date().toISOString() };
    await mutateOwn(async (current, row) => {
      if (current.admission !== "draining" || current.fenceEpoch !== state.fenceEpoch
        || current.ownerGeneration !== state.ownerGeneration || current.activeMigrationId !== state.activeMigrationId
        || current.planDigest !== state.planDigest || Number(row.drain_epoch) !== state.fenceEpoch || row.drain_state !== "draining")
        throw new StorageMaintenanceError("active");
      const count = await control.exec(`UPDATE storage_source_clients SET drain_state='drained',drain_receipt_digest=?,db_sessions_json=?,last_observed_at=?
        WHERE client_id=? AND registered_epoch=? AND drain_epoch=? AND drain_state='draining' AND ended_at IS NULL`,
        [storageReceiptDigest(receipt), canonicalStorageJson({ ...envelope, drainReceipt: receipt }), receipt.completedAt,
          clientId, identity.fenceEpoch, state.fenceEpoch]);
      if (count !== 1) throw new StorageMaintenanceError("active");
    });
    await queue.run(() => control.retireWrites());
    clearInterval(timer); timer = undefined;
    boundary.revoke(); changed("drained"); return receipt;
  }
  const client: StorageSourceClient = {
    clientId, identity,
    get accepting() { return accepting && !ended; }, get diagnostic() { return { ...diagnostic }; },
    async bind(callbacks) {
      if (boundary || lifecycle || ended) throw new StorageMaintenanceError("metadata_invalid");
      lifecycle = callbacks;
      boundary = await bindStorageDrainBoundary(db, { clientId, identity, callbacks: {
        disconnect_sessions: () => callbacks.disconnectSessions(), stop_owned_runtime: () => callbacks.stopOwnedRuntime(),
        observe_owned_exit: input => callbacks.observeOwnedExit(input), close_memory: () => callbacks.closeMemory(),
      } });
    },
    startWatching(pollMs = 100) {
      if (!boundary || timer || ended) throw new StorageMaintenanceError("metadata_invalid");
      timer = setInterval(() => { void client.refresh().catch(() => {}); }, pollMs); timer.unref();
    },
    async refresh() {
      if (ended) return;
      let state: StorageMaintenanceState;
      try { state = await queue.run(() => readState()); }
      catch (error) { changed("blocked", "source_changed"); stopNewWork(identity.fenceEpoch + 1); throw error; }
      diagnostic = { ...diagnostic, observedEpoch: state.fenceEpoch };
      if (state.admission === "open" && state.fenceEpoch === identity.fenceEpoch && accepting) return;
      stopNewWork(state.fenceEpoch);
      if (state.admission === "open") { changed("restart_required", "epoch_changed"); return; }
      if (!pendingDrain) {
        drainState = state; changed("draining");
        pendingDrain = performDrain(state).catch(error => {
          changed("blocked", error instanceof Error && error.message === "storage_source_writer_unknown" ? "source_writer_unknown" : "drain_incomplete");
          throw error;
        });
        void pendingDrain.catch(() => {});
      }
    },
    async assertAdmission() {
      await client.refresh();
      if (!accepting || ended) throw new StorageMaintenanceError(diagnostic.blocker === "epoch_changed" ? "epoch_changed" : "active");
    },
    async run(operation) {
      await client.assertAdmission();
      if (!accepting || ended) throw new StorageMaintenanceError("active");
      const pending = Promise.resolve().then(operation); active.add(pending);
      try { return await pending; } finally { active.delete(pending); }
    },
    async waitForDrain() {
      await client.refresh();
      if (!pendingDrain) throw new Error("storage_drain_not_requested");
      return pendingDrain;
    },
    async observeOwnedExit(input) {
      if (!lifecycle) throw new Error("storage_drain_incomplete");
      await client.refresh();
      if (drainState && boundary) {
        const result = await boundary.invoke("observe_owned_exit", drainState.fenceEpoch, input);
        // Only a new, actual owned-exit observation can retry a previously blocked
        // lifecycle here. Repeated polling never re-runs arbitrary failed cleanup.
        if (diagnostic.status === "blocked" && ["drain_incomplete", "source_writer_unknown"].includes(diagnostic.blocker ?? "")) {
          changed("draining");
          pendingDrain = performDrain(drainState).catch(error => {
            changed("blocked", error instanceof Error && error.message === "storage_source_writer_unknown" ? "source_writer_unknown" : "drain_incomplete");
            throw error;
          });
          void pendingDrain.catch(() => {});
        }
        return result;
      }
      if (!accepting || ended) throw new StorageMaintenanceError("active");
      return lifecycle.observeOwnedExit(input);
    },
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        clearInterval(timer); accepting = false;
        try {
          if (pendingDrain) await pendingDrain;
          await waitForOrdinaryWork(); await db.close();
          // A sealed receipt is frozen. The controller may later journal OS/ended observations.
          if (!pendingDrain) await mutateOwn(async (state) => {
            if (state.admission !== "open" || state.fenceEpoch !== identity.fenceEpoch) return;
            await control.exec("UPDATE storage_source_clients SET ended_at=?,last_observed_at=? WHERE client_id=? AND ended_at IS NULL",
              [new Date().toISOString(), new Date().toISOString(), clientId]);
          });
          else if ((await queue.run(() => readState())).admission === "open") {
            // After cancel, end only this historical registration. Its sealed
            // receipt and old admission epoch remain unchanged and auditable.
            const endControl = await openControl(database, clientId, false);
            try {
              await endControl.begin();
              const state = parseStorageMaintenanceState(await endControl.query(`SELECT * FROM storage_maintenance${db.kind === "postgres" ? " FOR SHARE" : ""}`));
              if (state.databaseInstanceId !== identity.databaseInstanceId) throw new StorageMaintenanceError("metadata_invalid");
              if (state.admission === "open" && state.fenceEpoch > identity.fenceEpoch) {
                await endControl.exec(`UPDATE storage_source_clients SET ended_at=?,last_observed_at=?
                  WHERE client_id=? AND database_instance_id=? AND registered_epoch=? AND process_identity_json=? AND ended_at IS NULL`,
                  [new Date().toISOString(), new Date().toISOString(), clientId, identity.databaseInstanceId, identity.fenceEpoch, canonicalStorageJson(processIdentity)]);
              }
              await endControl.verifySource(); await endControl.commit();
            } catch (error) { await endControl.rollback(); throw error; }
            finally { await endControl.close(); }
          }
        } finally { ended = true; boundary?.revoke(); await queue.run(() => control.close()); }
        if (diagnostic.status === "open") changed("closed");
      })();
      return closePromise;
    },
  };
  clients.set(db, client); return client;
}

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { assertSqliteSourceUnchanged, type SqliteDatabaseDescriptor } from "../../environment.ts";
import { inspectOwnedProcess } from "../../runtime/hosts/process-identity.ts";
import { parseStorageMaintenanceState, readSqliteMaintenanceState, type StorageMaintenanceState } from "../admission.ts";
import { assertSqliteGuardCoverage } from "../schema-guards.ts";
import { canonicalJson, digestJson } from "./canonical.ts";
import { MaintenanceFailure } from "./error.ts";
import { maintenanceHostIdentityDigest } from "./host.ts";
import { ArtifactStore } from "./objects.ts";
import { assertDarwinSqliteSource, bindDarwinSqliteSource, darwinSourceHandles, darwinSourceInventory } from "./darwin.ts";
import { inspectLinuxSourceProcesses, linuxMappedSourceHandles, linuxSourceMappingIdentities } from "./linux-mappings.ts";
import { fullSyncDarwinDatabaseHandle, syncMaintenanceHandle } from "./platform.ts";
import { readSqliteManifests } from "./sqlite-manifests.ts";
import { readSqliteSourceClients } from "./sqlite-source-clients.ts";
import { readSourceClientAudit, withCancellationSourceClientFacts, withControllerSourceClientFacts, withSourceClientFacts, type SourceFactsAccess } from "./source-writers.ts";
import { readAnchoredControllerArchive, type ControllerSourceAccess } from "./controller-write.ts";
import { finishControllerRestoreCallback, retainPendingControllerRestoreFailures } from "./restore-authorization.ts";
import { BootstrapAuditFactory, type SessionAuditCollection } from "./native-audit.ts";
import type { EventFacts } from "./control-candidate/schema.ts";
import { decodeSqliteSourceRows } from "./source-facts.ts";
import { assertControlSqlAnchorAllowed, assertControlSqlCommit, bindControlSql, finishControlSqlCallback, noteControlSql, retainPendingControlSqlFailure, validateControlSqlCommit } from "./control-sql.ts";
import { writeSqliteControlSql } from "./control-sql-write.ts";
import type { AnchorChange, Blocker, ControlRootIdentity, DatabaseManifests, Json, MaintenanceAdapter, OperationMutex, SourceClientsObservation, SourceLock, SourceObservation } from "./types.ts";

function same(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }
class ResourceCleanupFailure extends AggregateError {
  constructor(errors: readonly unknown[]) { super(errors, "maintenance resource cleanup failed", { cause: errors[0] }); }
}
function appendResourceFailure(errors: unknown[], error: unknown): void {
  if (error instanceof ResourceCleanupFailure) errors.push(...error.errors); else errors.push(error);
}
function throwResourceFailures(errors: readonly unknown[]): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new ResourceCleanupFailure(errors);
}
function failure(error: unknown, fallback: "snapshot_invalid" | "maintenance_busy" = "snapshot_invalid"): never {
  if (error instanceof ResourceCleanupFailure) {
    try { failure(error.errors[0], fallback); }
    catch (mapped) { throw new ResourceCleanupFailure([mapped, ...error.errors.slice(1)]); }
  }
  if (error instanceof MaintenanceFailure) throw error;
  if (["SQLITE_BUSY", "SQLITE_LOCKED"].includes(String((error as { code?: string } | null)?.code))) throw new MaintenanceFailure("maintenance_busy");
  throw new MaintenanceFailure(fallback);
}
function fileIdentity(file: string) {
  const info = lstatSync(file, { bigint: true });
  if (!info.isFile() || info.nlink !== 1n) throw new MaintenanceFailure("source_changed");
  return { path: file, device: String(info.dev), inode: String(info.ino) };
}
function directoryChain(file: string) {
  const result = [];
  for (let current = path.dirname(file); ; current = path.dirname(current)) {
    const info = lstatSync(current, { bigint: true });
    if (!info.isDirectory()) throw new MaintenanceFailure("source_changed");
    result.push({ path: current, device: String(info.dev), inode: String(info.ino) });
    if (current === path.dirname(current)) return result;
  }
}
interface MutexLease extends OperationMutex { readonly root: ControlRootIdentity; readonly db: Database.Database; active: boolean }
interface BackupFileOwner {
  readonly handle: FileHandle;
  readonly fd: number;
  identity?: string;
  nativeCloseAttempt?: Promise<void>;
  closeAttempt?: Promise<void>;
  closed: boolean;
}
interface BackupDatabaseOwner { readonly db: Database.Database; closeAttempted: boolean }
interface ArchiveVerificationOwner {
  readonly mutex: MutexLease;
  readonly lock: SourceLock;
  readonly selected: NonNullable<Awaited<ReturnType<typeof readAnchoredControllerArchive>>>;
  readonly input: BackupFileOwner;
  readonly identity: string;
}
function archiveIdentity(value: BigIntStats): string {
  if (!value.isFile() || value.nlink !== 1n || (value.mode & 0o7777n) !== 0o600n || value.size < 100n || value.size > BigInt(Number.MAX_SAFE_INTEGER)
    || typeof process.getuid === "function" && value.uid !== BigInt(process.getuid())) throw new MaintenanceFailure("snapshot_invalid");
  return canonicalJson({ device: String(value.dev), inode: String(value.ino), size: String(value.size),
    mode: String(value.mode), uid: String(value.uid), links: String(value.nlink), mtime: String(value.mtimeNs), ctime: String(value.ctimeNs) });
}
const originalSqliteAdapters = new WeakSet<object>();
const controllerSources = new WeakMap<SourceLock, { adapter: MaintenanceAdapter; mutex: OperationMutex;
  select(): void; readonly selected: () => boolean; access: ControllerSourceAccess }>();
/** Lookup only; no caller can populate the adapter's original native binding. */
export async function sqliteControllerSourceAccess(adapter: MaintenanceAdapter, mutex: OperationMutex, lock: SourceLock): Promise<ControllerSourceAccess> {
  const binding = controllerSources.get(lock);
  if (!originalSqliteAdapters.has(adapter) || binding?.adapter !== adapter || binding.mutex !== mutex)
    throw new MaintenanceFailure("maintenance_lost");
  await binding.access.assertHeld(); binding.select(); return binding.access;
}

function configureDurableSqlite(db: Database.Database): void {
  db.pragma("synchronous=FULL");
  if (process.platform !== "darwin") return;
  db.pragma("fullfsync=ON"); db.pragma("checkpoint_fullfsync=ON");
  if (db.pragma("synchronous", { simple: true }) !== 2 || db.pragma("fullfsync", { simple: true }) !== 1
    || db.pragma("checkpoint_fullfsync", { simple: true }) !== 1) throw new MaintenanceFailure("unsupported_durability");
}

class SqliteMaintenanceAdapter implements MaintenanceAdapter {
  private static readonly pendingInitializations = new Set<SqliteMaintenanceAdapter>();
  readonly dialect = "sqlite" as const;
  private readonly source: SqliteDatabaseDescriptor;
  private sourceFd: number | undefined;
  private sourceFdIdentity: string | undefined;
  private sourceDirectories: ReturnType<typeof directoryChain> = [];
  private readonly ownFds = new Map<string, string>();
  private readonly auditFactories = new WeakMap<object, BootstrapAuditFactory>();
  private readonly darwinConnections = new Set<Database.Database>();
  private readonly sourceConnections = new Set<Database.Database>();
  private readonly mutexConnections = new Set<Database.Database>();
  private readonly verificationConnections = new Set<Database.Database>();
  private readonly verificationTasks = new Set<Promise<Json>>();
  private readonly verificationFailures = new WeakMap<SourceLock, unknown[]>();
  private readonly archiveOwners = new WeakMap<SourceLock, ArchiveVerificationOwner>();
  private currentSourceLock: SourceLock | undefined;
  private readonly bindFiles = new Map<FileHandle, { fd: number; identity?: string }>();
  private readonly backupFiles = new Set<BackupFileOwner>();
  private readonly backupDatabases = new Set<BackupDatabaseOwner>();
  private readonly backupTasks = new Set<Promise<unknown>>();
  private readonly backupCleanupErrors: unknown[] = [];
  private backupFailed = false;
  private closeAttempt: Promise<void> | undefined;
  private mutex: MutexLease | null = null;
  private currentLock: Database.Database | null = null;
  private closed = false;
  private closing = false;
  private sourceFdClosed = false;
  private sourceFdCloseUnknown = false;
  private constructor(source: SqliteDatabaseDescriptor) {
    if (!source.identity) throw new MaintenanceFailure("source_missing");
    this.source = { ...source, identity: { ...source.identity } };
  }
  static async create(source: SqliteDatabaseDescriptor): Promise<MaintenanceAdapter> {
    const adapter = new SqliteMaintenanceAdapter(source);
    originalSqliteAdapters.add(adapter);
    for (const pending of this.pendingInitializations) {
      if (path.resolve(pending.source.sqlitePath) !== path.resolve(adapter.source.sqlitePath)
        && (pending.source.identity!.device !== adapter.source.identity!.device || pending.source.identity!.inode !== adapter.source.identity!.inode)) continue;
      // Re-enter only through the retained owner. A previous unknown numeric close is not retried.
      await pending.close();
      if (!pending.closed) throw new MaintenanceFailure("maintenance_lost", "initialization-close-unknown");
      this.pendingInitializations.delete(pending);
    }
    try { adapter.initializeSource(); await adapter.observe(); return adapter; }
    catch (error) {
      const errors = [error];
      this.pendingInitializations.add(adapter);
      try { await adapter.close(); } catch (closeError) { appendResourceFailure(errors, closeError); }
      if (adapter.closed) this.pendingInitializations.delete(adapter);
      throwResourceFailures(errors); throw error;
    }
  }
  private initializeSource(): void {
    const source = this.source;
    try {
      assertSqliteSourceUnchanged(source);
      this.sourceDirectories = directoryChain(source.sqlitePath);
      this.sourceFd = openSync(source.sqlitePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(this.sourceFd, { bigint: true });
      this.sourceFdIdentity = `${info.dev}:${info.ino}`;
      if (String(info.dev) !== source.identity!.device || String(info.ino) !== source.identity!.inode || info.nlink !== 1n) {
        throw new MaintenanceFailure("source_changed");
      }
      this.ownFds.set(`fd:${this.sourceFd}`, `${info.dev}:${info.ino}`);
    } catch { throw new MaintenanceFailure("source_changed"); }
  }
  private assertSource(): void {
    if (this.closed || this.closing || this.backupFailed) throw new MaintenanceFailure("maintenance_lost");
    try {
      assertSqliteSourceUnchanged(this.source);
      const info = fstatSync(this.sourceFd!, { bigint: true });
      if (info.nlink !== 1n || String(info.dev) !== this.source.identity!.device || String(info.ino) !== this.source.identity!.inode
        || !same(directoryChain(this.source.sqlitePath), this.sourceDirectories)) throw new Error("changed");
      for (const suffix of ["-wal", "-shm"]) {
        try { fileIdentity(this.source.sqlitePath + suffix); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      if (process.platform === "darwin") {
        for (const database of this.darwinConnections) {
          if (!database.open) { this.darwinConnections.delete(database); this.sourceConnections.delete(database); continue; }
          assertDarwinSqliteSource(database);
        }
        const current = new Set([`${info.dev}:${info.ino}`]);
        for (const suffix of ["-wal", "-shm"]) {
          try { const identity = fileIdentity(this.source.sqlitePath + suffix); current.add(`${identity.device}:${identity.inode}`); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        // A still-open native sidecar must remain the same named file. Renaming it is not "closed".
        for (const [key, expected] of this.ownFds) if (key.startsWith("fd:")) {
          try {
            const native = fstatSync(Number(key.slice(3)), { bigint: true });
            if (`${native.dev}:${native.ino}` === expected && (native.nlink !== 1n || !current.has(expected))) throw new Error("native source changed");
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error; }
        }
      }
    } catch { throw new MaintenanceFailure("source_changed"); }
  }
  private relevantFds(): Map<string, string> {
    if (process.platform === "darwin") return darwinSourceHandles([this.source.sqlitePath, this.source.sqlitePath + "-wal", this.source.sqlitePath + "-shm"]);
    const result = new Map<string, string>();
    if (process.platform !== "linux") return result;
    for (const entry of readdirSync("/proc/self/fd")) {
      try {
        const file = `/proc/self/fd/${entry}`, target = readlinkSync(file).replace(/ \(deleted\)$/, "");
        if (![this.source.sqlitePath, this.source.sqlitePath + "-wal", this.source.sqlitePath + "-shm"].includes(target)) continue;
        const info = statSync(file, { bigint: true }); result.set(`fd:${entry}`, `${info.dev}:${info.ino}`);
      } catch (error) { if (!["ENOENT", "EBADF"].includes(String((error as NodeJS.ErrnoException).code))) throw error; }
    }
    const sources = linuxSourceMappingIdentities([this.source.sqlitePath, this.source.sqlitePath + "-wal", this.source.sqlitePath + "-shm"]);
    const mapped = linuxMappedSourceHandles("/proc/self", sources);
    if (mapped.empty) throw new MaintenanceFailure("source_writer_unknown");
    for (const [key, identity] of mapped.handles) result.set(key, identity);
    return result;
  }
  private purgeClosedFds(): void {
    const current = this.relevantFds();
    for (const [fd, identity] of this.ownFds) if (current.get(fd) !== identity) this.ownFds.delete(fd);
  }
  private openSource(readonly: boolean): Database.Database {
    this.assertSource(); this.purgeClosedFds(); const before = this.relevantFds();
    const db = new Database(this.source.sqlitePath, { readonly, fileMustExist: true, timeout: 0 });
    this.sourceConnections.add(db);
    try {
      this.assertSource();
      if (process.platform === "darwin") { bindDarwinSqliteSource(db); this.darwinConnections.add(db); }
      if (readonly) db.pragma("query_only=ON"); else configureDurableSqlite(db);
      db.pragma("busy_timeout=0");
      if (["linux", "darwin"].includes(process.platform)) db.pragma("schema_version"); // Open the real WAL/SHM reader handles before attributing them.
      const opened = this.relevantFds();
      for (const [fd, identity] of opened) if (before.get(fd) !== identity) this.ownFds.set(fd, identity);
      if (!readonly) this.fullSyncSource();
      return db;
    } catch (error) {
      const errors = [error];
      try { this.closeSource(db); } catch (closeError) { appendResourceFailure(errors, closeError); }
      throwResourceFailures(errors); throw error;
    }
  }
  private closeSource(db: Database.Database): void {
    const errors: unknown[] = [];
    try { if (db.open) db.close(); } catch (error) { errors.push(error); }
    if (!db.open) {
      this.sourceConnections.delete(db); this.darwinConnections.delete(db);
      try { this.purgeClosedFds(); } catch (error) { errors.push(error); }
    }
    throwResourceFailures(errors);
  }
  private finishSource(db: Database.Database, errors: unknown[]): void {
    try { if (db.inTransaction) db.exec("ROLLBACK"); } catch (error) { errors.push(error); }
    try { this.closeSource(db); } catch (error) { appendResourceFailure(errors, error); }
    throwResourceFailures(errors);
  }
  private finishMutex(db: Database.Database, errors: unknown[]): void {
    if (db.open) {
      try { if (db.inTransaction) db.exec("ROLLBACK"); } catch (error) { errors.push(error); }
      try { db.close(); } catch (error) { errors.push(error); }
    }
    if (!db.open) this.mutexConnections.delete(db);
    throwResourceFailures(errors);
  }
  private finishVerification(db: Database.Database, errors: unknown[]): void {
    if (db.open) {
      try { if (db.inTransaction) db.exec("ROLLBACK"); } catch (error) { errors.push(error); }
      try { db.close(); } catch (error) { errors.push(error); }
    }
    if (!db.open) this.verificationConnections.delete(db);
    throwResourceFailures(errors);
  }
  private async closeBindFile(handle: FileHandle): Promise<void> {
    const owned = this.bindFiles.get(handle);
    if (!owned) return;
    const observedClosed = () => {
      if (handle.fd !== -1) return false;
      try { const info = fstatSync(owned.fd, { bigint: true }); return owned.identity !== undefined && `${info.dev}:${info.ino}` !== owned.identity; }
      catch (error) { return (error as NodeJS.ErrnoException)?.code === "EBADF"; }
    };
    if (handle.fd === -1) {
      if (observedClosed()) { this.bindFiles.delete(handle); return; }
      // A retired JS handle is not proof that the native close completed. Never close a reused fd by number.
      throw new MaintenanceFailure("maintenance_lost", "bind-close-unknown");
    }
    try { await handle.close(); this.bindFiles.delete(handle); }
    catch (error) { if (observedClosed()) this.bindFiles.delete(handle); throw error; }
  }
  private async withBindFile(handle: FileHandle, callback: () => Promise<void>): Promise<void> {
    const owned: { fd: number; identity?: string } = { fd: handle.fd };
    this.bindFiles.set(handle, owned);
    const errors: unknown[] = [];
    try {
      const info = fstatSync(handle.fd, { bigint: true }); owned.identity = `${info.dev}:${info.ino}`;
      await callback();
    } catch (error) { errors.push(error); }
    try { await this.closeBindFile(handle); } catch (error) { errors.push(error); }
    throwResourceFailures(errors);
  }
  private closeSourceDescriptor(): void {
    if (this.sourceFdClosed) return;
    const fd = this.sourceFd;
    if (fd === undefined) { this.sourceFdClosed = true; return; }
    const observedClosed = () => {
      try {
        const info = fstatSync(fd, { bigint: true });
        return this.sourceFdIdentity !== undefined && `${info.dev}:${info.ino}` !== this.sourceFdIdentity;
      } catch (error) { if ((error as NodeJS.ErrnoException)?.code === "EBADF") return true; throw error; }
    };
    if ((this.sourceFdCloseUnknown || this.sourceFdIdentity !== undefined) && observedClosed()) { this.sourceFdClosed = true; return; }
    // A close error can follow the real close and fd reuse, including a new open of the same inode.
    // Preserve uncertainty instead of treating file identity as ownership of the original description.
    if (this.sourceFdCloseUnknown) throw new MaintenanceFailure("maintenance_lost", "source-close-unknown");
    this.sourceFdCloseUnknown = true;
    try { closeSync(fd); this.sourceFdClosed = true; }
    catch (error) {
      try { if (observedClosed()) this.sourceFdClosed = true; } catch { /* Still unknown; retain the original close error. */ }
      throw error;
    }
  }
  private closeFactsSource(db: Database.Database): void {
    try { this.closeSource(db); }
    catch { if (this.mutex) this.auditFactories.get(this.mutex)?.close(); throw new MaintenanceFailure("maintenance_lost", "source-client-facts"); }
  }
  private beginSourceWrite(db: Database.Database): void {
    if (!["linux", "darwin"].includes(process.platform)) { db.exec("BEGIN IMMEDIATE"); return; }
    const before = this.relevantFds();
    db.exec("BEGIN IMMEDIATE");
    // A first write may create WAL/SHM after open. Only this synchronous native operation owns its new handles.
    for (const [key, identity] of this.relevantFds()) if (before.get(key) !== identity) this.ownFds.set(key, identity);
    this.assertSource(); this.fullSyncSource();
  }
  private fullSyncSource(): void {
    if (process.platform !== "darwin") return;
    this.assertSource();
    const current = this.relevantFds();
    for (const [key, identity] of this.ownFds) if (key.startsWith("fd:") && current.get(key) === identity)
      fullSyncDarwinDatabaseHandle(Number(key.slice(3)), identity);
    this.assertSource();
  }
  private observation(db: Database.Database): SourceObservation {
    this.assertSource();
    const state = readSqliteMaintenanceState(db, true)!;
    const sourceIdentity = { kind: "sqlite", sourcePath: this.source.sourcePath, sqlitePath: this.source.sqlitePath,
      device: this.source.identity!.device, inode: this.source.identity!.inode };
    const manifests = readSqliteManifests(db);
    const clients = db.prepare("SELECT * FROM storage_source_clients ORDER BY client_id").all() as Record<string, Json>[];
    this.assertSource();
    return { source: { kind: "sqlite", databaseInstanceId: state.databaseInstanceId, identityDigest: digestJson(sourceIdentity) },
      sourceIdentity, state, manifests, clients };
  }
  async observe(): Promise<SourceObservation> {
    const db = this.openSource(true);
    const errors: unknown[] = [];
    try { db.exec("BEGIN"); const result = this.observation(db); db.exec("COMMIT"); return result; }
    catch (error) { errors.push(error); throw error; }
    finally { this.finishSource(db, errors); }
  }
  private sourceClientsObservation(db: Database.Database): SourceClientsObservation {
    this.assertSource();
    let rows: Record<string, unknown>[];
    try { rows = db.prepare("SELECT * FROM storage_maintenance").all() as Record<string, unknown>[]; }
    catch (error) {
      // The fixed query's missing/invalid schema is distinct from native BUSY/LOCKED or I/O failure.
      if ((error as { code?: string }).code === "SQLITE_ERROR") throw new MaintenanceFailure("schema_guard_incomplete", "source-clients");
      throw error;
    }
    let state: StorageMaintenanceState;
    try { state = parseStorageMaintenanceState(rows); }
    catch { throw new MaintenanceFailure("schema_guard_incomplete", "source-clients"); }
    const sourceIdentity = { kind: "sqlite", sourcePath: this.source.sourcePath, sqlitePath: this.source.sqlitePath,
      device: this.source.identity!.device, inode: this.source.identity!.inode };
    const raw = readSqliteSourceClients(db);
    this.assertSource();
    return { source: { kind: "sqlite", databaseInstanceId: state.databaseInstanceId, identityDigest: digestJson(sourceIdentity) },
      sourceIdentity, state, ...raw };
  }
  async observeSourceClients(): Promise<SourceClientsObservation> {
    try {
      const db = this.openSource(true);
      try { db.exec("BEGIN"); const result = this.sourceClientsObservation(db); db.exec("COMMIT"); return result; }
      finally { try { if (db.inTransaction) db.exec("ROLLBACK"); } finally { this.closeSource(db); } }
    } catch (error) {
      if (error instanceof MaintenanceFailure) throw error;
      if (["SQLITE_BUSY", "SQLITE_LOCKED"].includes(String((error as { code?: string })?.code))) throw new MaintenanceFailure("maintenance_busy");
      throw new MaintenanceFailure("snapshot_invalid", "source-clients");
    }
  }
  async acquireMutex(root: ControlRootIdentity, expected: StorageMaintenanceState): Promise<OperationMutex> {
    if (this.mutex) throw new MaintenanceFailure("maintenance_busy");
    if (root.hostIdentityDigest !== await maintenanceHostIdentityDigest()) throw new MaintenanceFailure("control_root_mismatch");
    const observed = await this.observe(); const store = await ArtifactStore.open(root.path, observed.source);
    if (!same(root, store.identity)) throw new MaintenanceFailure("control_root_mismatch");
    const control = this.openSource(false); const mutexFile = path.join(root.path, "mutex.sqlite");
    const errors: unknown[] = [];
    let mutexIdentity: Json;
    try {
      this.beginSourceWrite(control);
      const state = readSqliteMaintenanceState(control, true)!;
      if (!same(state, expected)) throw new MaintenanceFailure("maintenance_lost");
      if (state.controlRootJson === null && state.mutexIdentityJson === null) {
        if (state.admission !== "open") throw new MaintenanceFailure("control_root_mismatch");
        // An unbound but valid lock file can be an orphan of the same root's interrupted first bind.
        let created: FileHandle | undefined;
        try { created = await open(mutexFile, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
        catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error; }
        if (created) await this.withBindFile(created, async () => {});
        fileIdentity(mutexFile);
        const initial = new Database(mutexFile, { fileMustExist: true, timeout: 0 });
        this.mutexConnections.add(initial);
        const initialErrors: unknown[] = [];
        try {
          configureDurableSqlite(initial);
          const schema = initial.prepare("SELECT name FROM sqlite_schema").all();
          if (!schema.length) initial.exec("BEGIN IMMEDIATE; CREATE TABLE maintenance_mutex(id INTEGER PRIMARY KEY CHECK(id=1)); INSERT INTO maintenance_mutex VALUES(1); COMMIT");
          this.checkMutexSchema(initial);
        } catch (error) { initialErrors.push(error); }
        finally { this.finishMutex(initial, initialErrors); }
        const handle = await open(mutexFile, constants.O_RDONLY | constants.O_NOFOLLOW);
        await this.withBindFile(handle, () => syncMaintenanceHandle(handle));
        const directory = await open(root.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        await this.withBindFile(directory, () => syncMaintenanceHandle(directory));
        mutexIdentity = { kind: "sqlite-operation-mutex", ...fileIdentity(mutexFile) };
        control.prepare("UPDATE storage_maintenance SET control_root_json=?,mutex_identity_json=? WHERE singleton=1")
          .run(canonicalJson(root), canonicalJson(mutexIdentity));
      } else {
        if (state.controlRootJson !== canonicalJson(root) || !state.mutexIdentityJson) throw new MaintenanceFailure("control_root_mismatch");
        mutexIdentity = JSON.parse(state.mutexIdentityJson) as Json;
        try { if (!same(mutexIdentity, { kind: "sqlite-operation-mutex", ...fileIdentity(mutexFile) })) throw new Error(); }
        catch { throw new MaintenanceFailure("control_root_mismatch"); }
      }
      this.assertSource(); await store.assertRoot(); control.exec("COMMIT"); this.fullSyncSource();
    } catch (error) {
      try { failure(error); } catch (mapped) { appendResourceFailure(errors, mapped); }
    } finally { this.finishSource(control, errors); }
    let db: Database.Database | undefined;
    try {
      db = new Database(mutexFile, { fileMustExist: true, timeout: 0 }); this.mutexConnections.add(db);
      configureDurableSqlite(db); this.checkMutexSchema(db); db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      const errors: unknown[] = [];
      try { failure(error); } catch (mapped) { appendResourceFailure(errors, mapped); }
      if (db) this.finishMutex(db, errors);
      throwResourceFailures(errors); throw error;
    }
    const lease: MutexLease = { root, identity: mutexIdentity!, db: db!, active: true,
      assertHeld: async () => {
        try {
          this.assertSource(); await store.assertRoot();
          if (!lease.active || !lease.db.open || !lease.db.inTransaction || !same(lease.identity, { kind: "sqlite-operation-mutex", ...fileIdentity(mutexFile) }))
            throw new MaintenanceFailure("maintenance_lost");
        } catch (error) {
          if (error instanceof MaintenanceFailure && error.code === "maintenance_lost") this.auditFactories.get(lease)?.close();
          throw error;
        }
      },
      release: async () => {
        this.auditFactories.get(lease)?.close(); lease.active = false;
        const errors: unknown[] = [];
        try { this.finishMutex(lease.db, []); } catch (error) { appendResourceFailure(errors, error); }
        // A failed close can leave the real lock held. Retain its owner for the next cleanup call.
        if (!lease.db.open && this.mutex === lease) this.mutex = null;
        throwResourceFailures(errors);
      },
    };
    // Establish the private lifetime before any public lease check; native identity remains audit-only.
    this.auditFactories.set(lease, new BootstrapAuditFactory(this, lease));
    this.mutex = lease;
    try { await lease.assertHeld(); return lease; }
    catch (error) {
      const errors = [error];
      try { await lease.release(); } catch (closeError) { appendResourceFailure(errors, closeError); }
      throwResourceFailures(errors); throw error;
    }
  }
  private checkMutexSchema(db: Database.Database): void {
    const schema = db.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY name").all();
    if (!same(schema, [{ type: "table", name: "maintenance_mutex", sql: "CREATE TABLE maintenance_mutex(id INTEGER PRIMARY KEY CHECK(id=1))" }])
      || !same(db.prepare("SELECT * FROM maintenance_mutex").all(), [{ id: 1 }])) throw new MaintenanceFailure("control_root_mismatch");
  }
  async withSourceLock<T>(kind: "control" | "snapshot", callback: (lock: SourceLock) => Promise<T>): Promise<T> {
    if (!originalSqliteAdapters.has(this)) throw new MaintenanceFailure("maintenance_lost");
    const mutex = this.mutex;
    if (!mutex || this.currentLock) throw new MaintenanceFailure(this.currentLock ? "maintenance_busy" : "maintenance_lost");
    await mutex.assertHeld();
    const db = this.openSource(false); let active = true, factsInvalidated = false, factsUsed = false, controlSqlUsed = false, failed = false;
    let controllerUsed = false, registrationCandidate = false;
    const factory = this.auditFactories.get(mutex);
    if (!factory) { this.closeSource(db); throw new MaintenanceFailure("maintenance_lost"); }
    let trackedLock: SourceLock | undefined;
    try {
      this.beginSourceWrite(db); this.currentLock = db;
      try { assertSqliteGuardCoverage(db); } catch { throw new MaintenanceFailure("schema_guard_incomplete"); }
      if (kind === "snapshot" && readSqliteMaintenanceState(db, true)!.admission !== "sealed") throw new MaintenanceFailure("maintenance_lost");
      const assertHeld = async () => {
        await mutex.assertHeld();
        if (!active || !db.open || !db.inTransaction || this.currentLock !== db || this.backupFailed) throw new MaintenanceFailure("maintenance_lost");
      };
      const factsAccess: SourceFactsAccess = { root: mutex.root, mutexIdentity: mutex.identity,
          assertUnchangedLock: async () => { await assertHeld(); if (factsInvalidated) throw new MaintenanceFailure("maintenance_lost"); },
          observe: () => lock.observeSourceClients(),
          decodedRows: async observation => decodeSqliteSourceRows(observation),
          validateSource: (value, observation) => { if (!same(value, observation.sourceIdentity)) throw new MaintenanceFailure("source_changed"); },
          inspectWriters: async (_observation, _rows, audit) => this.inspectCurrentWriters(true, audit),
          runtimeRows: async () => ({
            runners: db.prepare(`SELECT b.id AS binding_id,b.member_id,r.generation,r.lease_owner,r.exit_confirmed,
              r.process_identity_json,r.state FROM agent_runtime_bindings b LEFT JOIN agent_runner_states r ON r.binding_id=b.id`).all() as Record<string, unknown>[],
            owners: db.prepare("SELECT member_id,binding_id,generation,lease_owner,lease_expires_at FROM agent_runtime_members").all() as Record<string, unknown>[],
          }),
        };
      const lock: SourceLock = {
        assertHeld,
        observe: async () => { await assertHeld(); return this.observation(db); },
        observeSourceClients: async () => {
          await assertHeld();
          try { const result = this.sourceClientsObservation(db); await assertHeld(); return result; }
          catch (error) {
            if (error instanceof MaintenanceFailure) throw error;
            if (["SQLITE_BUSY", "SQLITE_LOCKED"].includes(String((error as { code?: string })?.code))) throw new MaintenanceFailure("maintenance_busy");
            throw new MaintenanceFailure("snapshot_invalid", "source-clients");
          }
        },
        withSourceClientFacts: (plan, consume) => {
          factsUsed = true;
          return withSourceClientFacts(factsAccess, plan, consume,
            { lease: factory.bind(this, mutex, lock, factsAccess.assertUnchangedLock), lock });
        },
        readSourceClientAudit: plan => {
          factsUsed = true;
          return readSourceClientAudit(factsAccess, plan, factory.bind(this, mutex, lock, factsAccess.assertUnchangedLock), lock);
        },
        anchor: async change => {
          assertControlSqlAnchorAllowed(lock); await assertHeld(); assertControlSqlAnchorAllowed(lock);
          factsInvalidated = true; this.anchor(db, change, mutex);
        },
        backup: destination => {
          const task = (async () => {
            try {
              await assertHeld();
              if (kind !== "snapshot") throw new MaintenanceFailure("maintenance_lost");
              const result = await this.runBackup(db, mutex, destination); await assertHeld(); return result;
            } catch (error) { this.backupFailed = true; throw error; }
          })();
          // Own the complete call before its first held check can yield to the callback.
          this.backupTasks.add(task);
          void task.then(() => this.backupTasks.delete(task), () => this.backupTasks.delete(task));
          return task;
        },
      };
      trackedLock = lock;
      this.currentSourceLock = lock; this.verificationFailures.set(lock, []);
      controllerSources.set(lock, { adapter: this, mutex, select: () => { controllerUsed = true; }, selected: () => controllerUsed,
        access: Object.freeze({ kind, root: mutex.root, assertHeld,
        withAdvanceFacts: (plan, consume) => {
          controllerUsed = true; factsUsed = true;
          return withControllerSourceClientFacts(factsAccess, plan, factory.bind(this, mutex, lock, factsAccess.assertUnchangedLock), lock, consume);
        },
        withCancellationFacts: (plan, consume) => {
          controllerUsed = true; factsUsed = true;
          return withCancellationSourceClientFacts(factsAccess, plan, factory.bind(this, mutex, lock, factsAccess.assertUnchangedLock), lock, consume);
        },
        stageRegistration: () => factory.stageRegistration(this, mutex, lock),
        stageCandidate: async (reference, record) => { await factory.stageControlCandidate(this, mutex, lock, reference, record); registrationCandidate = true; },
        invalidate: () => factory.close(),
      } satisfies ControllerSourceAccess) });
      bindControlSql(lock, { adapter: this, root: mutex.root, control: kind === "control", assertHeld,
        invalidateFacts: () => { factsInvalidated = true; controlSqlUsed = true; },
        observe: () => lock.observeSourceClients(), manifests: () => lock.observe(),
        write: async plan => writeSqliteControlSql(db, plan), sourceHandleClosed: () => !db.open, mutexHandleClosed: () => !mutex.db.open });
      const result = await callback(lock), pending = finishControlSqlCallback(lock), restore = finishControllerRestoreCallback(lock);
      if (pending) { await pending; assertControlSqlCommit(lock); }
      if (restore) await restore;
      if (this.backupTasks.size) await Promise.allSettled([...this.backupTasks]);
      if (this.verificationTasks.size) await Promise.allSettled([...this.verificationTasks]);
      const verificationFailures = this.verificationFailures.get(lock)!;
      if (verificationFailures.length) throw verificationFailures[0];
      await assertHeld(); await validateControlSqlCommit(lock); assertControlSqlCommit(lock); noteControlSql(lock, "committing");
      db.exec("COMMIT"); noteControlSql(lock, "committed");
      if (registrationCandidate) factory.noteCommitReturned(this, mutex, lock);
      this.fullSyncSource();
      return result;
    } catch (error) {
      // Cleanup observations cannot replace the callback/COMMIT failure, including throw undefined.
      failed = true;
      if (controllerUsed) factory.close();
      noteControlSql(trackedLock, "failure", error);
      retainPendingControlSqlFailure(trackedLock); retainPendingControllerRestoreFailures(trackedLock);
      const pending = finishControlSqlCallback(trackedLock), restore = finishControllerRestoreCallback(trackedLock);
      await Promise.allSettled([...(pending ? [pending] : []), ...(restore ? [restore] : [])]);
      if (this.backupTasks.size) { this.backupFailed = true; await Promise.allSettled([...this.backupTasks]); }
      if (this.verificationTasks.size) await Promise.allSettled([...this.verificationTasks]);
      if (controllerUsed) factory.close();
      try { if (db.inTransaction) db.exec("ROLLBACK"); }
      catch (rollbackError) { noteControlSql(trackedLock, "rollback-failure", rollbackError); }
      if (error instanceof MaintenanceFailure && error.code === "maintenance_lost") this.auditFactories.get(mutex)?.close();
      if (error instanceof MaintenanceFailure) throw error;
      if (["SQLITE_BUSY", "SQLITE_LOCKED"].includes(String((error as { code?: string } | null)?.code))) throw new MaintenanceFailure("maintenance_busy");
      throw error;
    } finally {
      active = false; this.currentLock = null; this.currentSourceLock = undefined;
      if (trackedLock) this.archiveOwners.delete(trackedLock);
      try {
        if (factsUsed && !controlSqlUsed && !controllerUsed) this.closeFactsSource(db); else this.closeSource(db);
        if (registrationCandidate && !failed) {
          if (db.open || !trackedLock) throw new MaintenanceFailure("maintenance_lost");
          factory.noteSourceClosed(this, mutex, trackedLock);
        }
      }
      catch (error) {
        if (factsUsed) this.auditFactories.get(mutex)?.close();
        noteControlSql(trackedLock, "close-failure", error); if (!failed) throw error;
      }
    }
  }
  private anchor(db: Database.Database, change: AnchorChange, mutex: MutexLease): void {
    this.assertSource();
    try { assertSqliteGuardCoverage(db); } catch { throw new MaintenanceFailure("schema_guard_incomplete"); }
    const old = readSqliteMaintenanceState(db, true)!;
    if (!same(old, change.expected) || !same(change.controlRootIdentity, mutex.root) || !same(change.mutexIdentity, mutex.identity)
      || old.controlRootJson !== canonicalJson(mutex.root) || old.mutexIdentityJson !== canonicalJson(mutex.identity)
      || !Number.isSafeInteger(change.fenceEpoch) || !Number.isSafeInteger(change.ownerGeneration)
      || !Number.isSafeInteger(change.journalSequence) || change.journalSequence < 1
      || !/^[a-f0-9]{64}$/.test(change.journal.sha256)) throw new MaintenanceFailure("maintenance_lost");
    const enter = old.admission === "open" && change.admission === "draining";
    const cancel = old.admission !== "open" && change.admission === "open";
    const next = old.admission !== "open" && (old.admission === change.admission || old.admission === "draining" && change.admission === "sealed");
    if (!(enter || cancel || next) || change.fenceEpoch !== old.fenceEpoch + (enter || cancel ? 1 : 0)
      || change.ownerGeneration < old.ownerGeneration || change.ownerGeneration > old.ownerGeneration + 1
      || enter && (change.ownerGeneration !== old.ownerGeneration + 1 || change.journalSequence !== 1)
      || !enter && change.journalSequence !== old.journalSequence + 1
      || cancel && (change.activeMigrationId !== null || change.planDigest !== null)
      || !cancel && (!change.activeMigrationId || !change.planDigest || !/^[a-f0-9]{64}$/.test(change.planDigest))
      || next && (change.activeMigrationId !== old.activeMigrationId || change.planDigest !== old.planDigest)) throw new MaintenanceFailure("maintenance_lost");
    const update = db.prepare(`UPDATE storage_maintenance SET admission=?,fence_epoch=?,owner_generation=?,active_migration_id=?,plan_digest=?,
      journal_record_ref=?,journal_digest=?,journal_sequence=? WHERE singleton=1 AND database_instance_id=? AND fence_epoch=? AND owner_generation=?
      AND journal_sequence=? AND admission=? AND journal_digest IS ?`).run(change.admission, change.fenceEpoch, change.ownerGeneration,
      change.activeMigrationId, change.planDigest, change.journal.ref, change.journal.sha256, change.journalSequence,
      old.databaseInstanceId, old.fenceEpoch, old.ownerGeneration, old.journalSequence, old.admission, old.journalDigest);
    if (update.changes !== 1) throw new MaintenanceFailure("maintenance_lost");
    this.assertSource();
  }
  private async openBackupFile(destination: string, flags: number, owners: BackupFileOwner[]): Promise<BackupFileOwner> {
    const handle = await open(destination, flags, 0o600);
    const owner: BackupFileOwner = { handle, fd: handle.fd, closed: false };
    this.backupFiles.add(owner); owners.push(owner);
    // Register the actual owner before even the identity observation can fail.
    const info = fstatSync(owner.fd, { bigint: true }); owner.identity = `${info.dev}:${info.ino}`;
    return owner;
  }
  private backupFileRetired(owner: BackupFileOwner): boolean {
    if (owner.handle.fd !== -1) return false;
    try {
      const info = fstatSync(owner.fd, { bigint: true });
      return owner.identity !== undefined && `${info.dev}:${info.ino}` !== owner.identity;
    } catch (error) { return (error as NodeJS.ErrnoException | null)?.code === "EBADF"; }
  }
  private async closeBackupFile(owner: BackupFileOwner): Promise<void> {
    if (owner.closed) return;
    if (owner.closeAttempt) {
      // Never replace a rejected original native attempt with FileHandle's fd=-1 no-op.
      try { await owner.closeAttempt; } catch { /* Its original error remains in backupCleanupErrors. */ }
      if (owner.closed || this.backupFileRetired(owner)) {
        owner.closed = true; this.backupFiles.delete(owner); return;
      }
      throw new MaintenanceFailure("maintenance_lost", "backup-file-close-unknown");
    }
    const attempt = (async () => {
      try {
        owner.nativeCloseAttempt = owner.handle.close();
        await owner.nativeCloseAttempt;
        if (owner.handle.fd !== -1) throw new MaintenanceFailure("maintenance_lost", "backup-file-close-unknown");
        owner.closed = true; this.backupFiles.delete(owner);
      } catch (error) {
        this.backupCleanupErrors.push(error);
        if (this.backupFileRetired(owner)) { owner.closed = true; this.backupFiles.delete(owner); }
        throw error;
      }
    })();
    owner.closeAttempt = attempt;
    await attempt;
  }
  private closeBackupDatabase(owner: BackupDatabaseOwner): void {
    // open=false after a throwing close is not its successful completion receipt.
    if (!owner.db.open) throw new MaintenanceFailure("maintenance_lost", "backup-database-close-unknown");
    owner.closeAttempted = true;
    try {
      owner.db.close();
      if (owner.db.open) throw new MaintenanceFailure("maintenance_lost", "backup-database-close-unknown");
      this.backupDatabases.delete(owner);
    } catch (error) { this.backupCleanupErrors.push(error); throw error; }
  }
  private async runBackup(control: Database.Database, mutex: MutexLease, destination: string) {
    const files: BackupFileOwner[] = [], databases: BackupDatabaseOwner[] = [];
    let reader: Database.Database | undefined, failed = false, first: unknown;
    const fail = (error: unknown) => { if (!failed) { failed = true; first = error; } this.backupFailed = true; };
    let result: { manifests: DatabaseManifests; toolchain: Json } | undefined;
    try {
      this.assertSource();
      if (!path.isAbsolute(destination) || !destination.startsWith(`${mutex.root.path}/attempts/`)
        || realpathSync(path.dirname(destination)) !== path.dirname(destination)) throw new MaintenanceFailure("snapshot_invalid");
      const created = await this.openBackupFile(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, files);
      await this.closeBackupFile(created);
      try { reader = this.openSource(true); }
      catch (error) {
        // openSource owns acquisition cleanup. Its private envelope separates the
        // original initialization failure from each independent cleanup event.
        if (error instanceof ResourceCleanupFailure) {
          this.backupCleanupErrors.push(...error.errors.slice(1)); throw error.errors[0];
        }
        throw error;
      }
      reader.exec("BEGIN"); const observation = this.observation(reader);
      if (observation.state.admission !== "sealed" || !same(observation.state, readSqliteMaintenanceState(control, true))) throw new MaintenanceFailure("maintenance_lost");
      const manifests = observation.manifests;
      const progress = await reader.backup(destination, { progress: () => {
        this.assertSource(); if (!mutex.active || !mutex.db.inTransaction || !control.inTransaction) throw new MaintenanceFailure("maintenance_lost"); return 100;
      } });
      if (progress.remainingPages !== 0 || !same(manifests, readSqliteManifests(reader))) throw new MaintenanceFailure("snapshot_invalid");
      reader.exec("COMMIT");
      const target: BackupDatabaseOwner = { db: new Database(destination, { fileMustExist: true }), closeAttempted: false };
      this.backupDatabases.add(target); databases.push(target);
      configureDurableSqlite(target.db); target.db.pragma("wal_checkpoint(TRUNCATE)"); target.db.pragma("journal_mode=DELETE");
      this.closeBackupDatabase(target);
      const info = await stat(destination, { bigint: true });
      const targetFile = await this.openBackupFile(destination, constants.O_RDONLY | constants.O_NOFOLLOW, files);
      const header = Buffer.alloc(16); await targetFile.handle.read(header, 0, 16, 0);
      if (info.size < 512n || header.toString("binary") !== "SQLite format 3\0") throw new MaintenanceFailure("snapshot_invalid");
      await syncMaintenanceHandle(targetFile.handle);
      await this.closeBackupFile(targetFile);
      try { if ((await stat(destination + "-wal")).size !== 0) throw new MaintenanceFailure("snapshot_invalid"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await mutex.assertHeld(); this.assertSource();
      result = { manifests, toolchain: { kind: "sqlite-backup", node: process.version,
        sqlite: String((control.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version),
        independentReader: true, committedWalIncluded: true } };
    } catch (error) { fail(error); }
    for (const owner of databases) if (this.backupDatabases.has(owner) && !owner.closeAttempted) {
      try { this.closeBackupDatabase(owner); } catch (error) { fail(error); }
    }
    for (const owner of files) if (this.backupFiles.has(owner) && !owner.closeAttempt) {
      try { await this.closeBackupFile(owner); } catch (error) { fail(error); }
    }
    if (reader) {
      try { this.finishSource(reader, []); }
      catch (error) {
        const errors = error instanceof ResourceCleanupFailure ? error.errors : [error];
        // This existing reader's first error is delivered by backup itself. Only its
        // additional cleanup errors (or all of them after a body failure) remain due.
        this.backupCleanupErrors.push(...(failed ? errors : errors.slice(1)));
        fail(errors[0]);
      }
    }
    if (failed) throw first;
    return result!;
  }
  verifyDatabase(databaseFile: string, expected: DatabaseManifests, restoreDirectory: string): Promise<Json> {
    const sourceLock = this.currentSourceLock;
    const operation = this.verifyDatabaseOperation(databaseFile, expected, restoreDirectory);
    this.verificationTasks.add(operation);
    void operation.then(() => this.verificationTasks.delete(operation), error => {
      this.verificationTasks.delete(operation);
      if (sourceLock) this.verificationFailures.get(sourceLock)?.push(error);
    });
    return operation;
  }
  private async verifyDatabaseOperation(databaseFile: string, expected: DatabaseManifests, restoreDirectory: string): Promise<Json> {
    const mutex = this.mutex, lock = this.currentSourceLock;
    if (!mutex || !lock) throw new MaintenanceFailure("maintenance_lost");
    const selected = await readAnchoredControllerArchive(this, mutex, lock);
    if (!selected) return this.verifyDatabaseFromFile(databaseFile, expected, restoreDirectory,
      controllerSources.get(lock)?.selected() === true);
    if (databaseFile !== selected.databaseFile || !same(expected, selected.manifests) || this.archiveOwners.has(lock))
      throw new MaintenanceFailure("snapshot_invalid");
    const files: BackupFileOwner[] = [], errors: unknown[] = [];
    let result: Json | undefined;
    try {
      const input = await this.openBackupFile(databaseFile, constants.O_RDONLY | constants.O_NOFOLLOW, files);
      const identity = archiveIdentity(fstatSync(input.fd, { bigint: true }));
      const owned: ArchiveVerificationOwner = { mutex, lock, selected, input, identity };
      this.archiveOwners.set(lock, owned);
      const assertInput = async () => {
        await lock.assertHeld(); await mutex.assertHeld();
        if (this.archiveOwners.get(lock) !== owned || this.mutex !== mutex || this.currentSourceLock !== lock || input.closed
          || input.handle.fd !== input.fd || archiveIdentity(fstatSync(input.fd, { bigint: true })) !== identity
          || archiveIdentity(lstatSync(databaseFile, { bigint: true })) !== identity || String(fstatSync(input.fd, { bigint: true }).size) !== selected.database.bytes)
          throw new MaintenanceFailure("source_changed");
      };
      await assertInput();
      const header = Buffer.alloc(16); await input.handle.read(header, 0, header.length, 0);
      if (!header.equals(Buffer.from("SQLite format 3\0", "ascii"))) throw new MaintenanceFailure("snapshot_invalid");
      const hash = createHash("sha256"), buffer = Buffer.alloc(128 * 1024); let position = 0;
      while (true) {
        await assertInput(); const { bytesRead } = await input.handle.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
      }
      if (String(position) !== selected.database.bytes || hash.digest("hex") !== selected.database.sha256)
        throw new MaintenanceFailure("snapshot_invalid");
      await assertInput();
      // The actual original descriptor supplies the copy; a replaced pathname
      // cannot redirect the isolated restore after the private owner was issued.
      result = await this.verifyDatabaseFromFile(`/dev/fd/${input.fd}`, selected.manifests, restoreDirectory, true);
      await assertInput();
      const current = await readAnchoredControllerArchive(this, mutex, lock);
      if (!current || !same(current, selected)) throw new MaintenanceFailure("source_changed");
    } catch (error) { appendResourceFailure(errors, error); }
    finally {
      this.archiveOwners.delete(lock);
      for (const file of files) { try { await this.closeArchiveInput(file); } catch (error) { appendResourceFailure(errors, error); } }
    }
    throwResourceFailures(errors); return result!;
  }
  private async closeArchiveInput(owner: BackupFileOwner): Promise<void> {
    if (owner.closed) return;
    // This operation delivers its complete error graph directly. Do not also add
    // the same close occurrence to D's delayed cleanup ledger.
    owner.closeAttempt ??= (async () => {
      try {
        owner.nativeCloseAttempt = owner.handle.close(); await owner.nativeCloseAttempt;
        if (owner.handle.fd !== -1) throw new MaintenanceFailure("maintenance_lost", "archive-input-close-unknown");
        owner.closed = true; this.backupFiles.delete(owner);
      } catch (error) {
        if (this.backupFileRetired(owner)) { owner.closed = true; this.backupFiles.delete(owner); }
        throw error;
      }
    })();
    await owner.closeAttempt;
  }
  private async verifyDatabaseFromFile(databaseFile: string, expected: DatabaseManifests, restoreDirectory: string,
    preserveFailure = false): Promise<Json> {
    if (!this.mutex?.active || !this.currentLock) throw new MaintenanceFailure("maintenance_lost");
    if (this.verificationConnections.size) throw new MaintenanceFailure("maintenance_lost", "verification-close-unknown");
    await this.mutex.assertHeld();
    if (!restoreDirectory.startsWith(`${this.mutex.root.path}/attempts/`) || realpathSync(path.dirname(restoreDirectory)) !== path.dirname(restoreDirectory))
      throw new MaintenanceFailure("snapshot_invalid");
    await mkdir(restoreDirectory, { mode: 0o700 });
    const restored = path.join(restoreDirectory, "restored.sqlite");
    await copyFile(databaseFile, restored, constants.COPYFILE_EXCL); await chmod(restored, 0o600);
    const identity = fileIdentity(restored);
    if (identity.device === this.source.identity!.device && identity.inode === this.source.identity!.inode) throw new MaintenanceFailure("snapshot_invalid");
    const db = new Database(restored, { readonly: true, fileMustExist: true });
    this.verificationConnections.add(db);
    const errors: unknown[] = []; let result: Json | undefined;
    try {
      db.pragma("query_only=ON"); db.exec("BEGIN");
      const integrity = db.pragma("integrity_check") as { integrity_check: string }[];
      if (integrity.length !== 1 || integrity[0]!.integrity_check !== "ok" || (db.pragma("foreign_key_check") as unknown[]).length
        || !same(readSqliteManifests(db), expected)) throw new MaintenanceFailure("snapshot_invalid");
      db.exec("COMMIT");
      result = { kind: "sqlite-restore-verification", ...identity, fullDataManifestDigest: expected.fullDataManifestDigest,
        capturedControlManifestDigest: expected.capturedControlManifestDigest, integrityCheck: "ok", foreignKeyViolations: 0 };
    } catch (error) {
      if (preserveFailure) errors.push(error);
      else try { failure(error); } catch (mapped) { errors.push(mapped); }
    }
    this.finishVerification(db, errors);
    return result!;
  }
  async inspectWriters(_observation: SourceObservation): Promise<readonly Blocker[]> {
    return this.inspectCurrentWriters();
  }
  private async inspectCurrentWriters(strictClose = false, audit?: SessionAuditCollection): Promise<readonly Blocker[]> {
    this.assertSource();
    if (!["linux", "darwin"].includes(process.platform) || process.getuid === undefined) return [{ code: "source_writer_unknown", subjectRef: "os-inventory-unavailable" }];
    this.purgeClosedFds(); const blockers: Blocker[] = [];
    const sourcePaths = [this.source.sqlitePath, this.source.sqlitePath + "-wal", this.source.sqlitePath + "-shm"];
    const sessions = path.join(this.source.dataDir, "managed", "sessions");
    if (process.platform === "darwin") {
      try {
        const nativeAudit: import("./darwin.ts").DarwinSourceAudit | undefined = audit ? {} : undefined;
        const ownedResources = audit ? [...this.ownFds].map(([key, value]) => {
          const [device, inode] = value.split(":"); return { key, device: device!, inode: inode! };
        }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : undefined;
        const inventory = darwinSourceInventory({ files: sourcePaths, trees: [sessions] }, false, nativeAudit);
        for (const item of inventory.items) {
          if (item.kind === "unreadable") blockers.push({ code: "source_writer_unknown", subjectRef: `unreadable-process:${item.pid}` });
          else if (item.pid !== process.pid || this.ownFds.get(item.key) !== `${item.device}:${item.inode}`)
            blockers.push({ code: "source_writer_unknown", subjectRef: `os-process:${item.pid}` });
        }
        if (audit && nativeAudit?.sourceFiles && blockers.length === 0) {
          const items = inventory.items as Extract<EventFacts["sessions"], { kind: "sqlite-darwin-session-audit-v1" }>["inventory"]["items"];
          items.sort((a, b) => a.pid - b.pid || (BigInt(a.startSeconds) < BigInt(b.startSeconds) ? -1 : BigInt(a.startSeconds) > BigInt(b.startSeconds) ? 1 : 0)
            || (BigInt(a.startMicroseconds) < BigInt(b.startMicroseconds) ? -1 : BigInt(a.startMicroseconds) > BigInt(b.startMicroseconds) ? 1 : 0)
            || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
          const sourceFiles = nativeAudit.sourceFiles.map((file, i) => ({ ...file, role: (["main", "wal", "shm"] as const)[i]! }));
          audit.value = { kind: "sqlite-darwin-session-audit-v1", observer: { host: audit.actor.host, process: audit.actor.process }, uid: process.getuid!(),
            sourceFiles: sourceFiles as Extract<EventFacts["sessions"], { kind: "sqlite-darwin-session-audit-v1" }>["sourceFiles"], sessionsTree: sessions,
            ownedResources: ownedResources!, inventory: { version: 1, scope: "current-uid", items } };
        }
      } catch { blockers.push({ code: "source_writer_unknown", subjectRef: "os-inventory-unavailable" }); }
    } else {
      const nativeAudit = audit ? { sourceFiles: [] as Extract<EventFacts["sessions"], { kind: "sqlite-linux-session-audit-v1" }>["sourceFiles"][number][],
        matches: [] as Extract<EventFacts["sessions"], { kind: "sqlite-linux-session-audit-v1" }>["matches"] } : undefined;
      const ownedResources = audit ? [...this.ownFds].map(([key, value]) => {
        const [device, inode] = value.split(":"); return { key, device: device!, inode: inode! };
      }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : undefined;
      blockers.push(...await inspectLinuxSourceProcesses(sourcePaths, sessions, this.ownFds, nativeAudit));
      if (audit && nativeAudit && blockers.length === 0) {
        nativeAudit.matches.sort((a, b) => a.pid - b.pid || (BigInt(a.startTicks) < BigInt(b.startTicks) ? -1 : BigInt(a.startTicks) > BigInt(b.startTicks) ? 1 : 0)
          || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        audit.value = { kind: "sqlite-linux-session-audit-v1", observer: { host: audit.actor.host, process: audit.actor.process },
          uid: process.getuid!(), sourceFiles: nativeAudit.sourceFiles as Extract<EventFacts["sessions"], { kind: "sqlite-linux-session-audit-v1" }>["sourceFiles"],
          sessionsTree: sessions, ownedResources: ownedResources!, matches: nativeAudit.matches };
      }
    }
    const db = this.openSource(true);
    try {
      for (const row of db.prepare("SELECT binding_id,process_identity_json FROM agent_runner_states WHERE exit_confirmed=0").all() as { binding_id: string; process_identity_json: string | null }[]) {
        let exited = false;
        try { exited = row.process_identity_json !== null && (await inspectOwnedProcess(JSON.parse(row.process_identity_json))).status === "wrapper_exited"; } catch { /* unknown remains blocking */ }
        if (!exited) blockers.push({ code: "source_writer_active", subjectRef: `runtime-binding:${row.binding_id}` });
      }
    } finally { if (strictClose) this.closeFactsSource(db); else this.closeSource(db); }
    return [...new Map(blockers.map(blocker => [canonicalJson(blocker), blocker])).values()];
  }
  async close(): Promise<void> {
    if (this.closeAttempt) return this.closeAttempt;
    if (this.currentLock) throw new MaintenanceFailure("maintenance_busy");
    if (this.closed) return;
    this.closing = true;
    const attempt = this.closeResources(); this.closeAttempt = attempt;
    try { await attempt; } finally { if (this.closeAttempt === attempt) this.closeAttempt = undefined; }
  }
  private async closeResources(): Promise<void> {
    const errors: unknown[] = [];
    await Promise.allSettled([...this.backupTasks]);
    await Promise.allSettled([...this.verificationTasks]);
    const pendingErrors = this.backupCleanupErrors.splice(0);
    for (const owner of [...this.backupDatabases]) {
      const eventsBefore = this.backupCleanupErrors.length;
      try { this.closeBackupDatabase(owner); }
      catch (error) { if (this.backupCleanupErrors.length === eventsBefore) errors.push(error); }
    }
    for (const owner of [...this.backupFiles]) {
      const eventsBefore = this.backupCleanupErrors.length;
      try { await this.closeBackupFile(owner); }
      catch (error) { if (this.backupCleanupErrors.length === eventsBefore) errors.push(error); }
    }
    errors.unshift(...pendingErrors, ...this.backupCleanupErrors.splice(0));
    const leased = this.mutex?.db;
    try { await this.mutex?.release(); } catch (error) { appendResourceFailure(errors, error); }
    for (const db of this.mutexConnections) if (db !== leased) {
      try { this.finishMutex(db, []); } catch (error) { appendResourceFailure(errors, error); }
    }
    for (const db of this.sourceConnections) {
      try { this.finishSource(db, []); } catch (error) { appendResourceFailure(errors, error); }
    }
    for (const handle of this.bindFiles.keys()) {
      try { await this.closeBindFile(handle); } catch (error) { appendResourceFailure(errors, error); }
    }
    for (const db of this.verificationConnections) {
      try { this.finishVerification(db, []); } catch (error) { appendResourceFailure(errors, error); }
    }
    try { this.closeSourceDescriptor(); } catch (error) { appendResourceFailure(errors, error); }
    if (this.sourceFdClosed && !this.sourceConnections.size && !this.mutexConnections.size && !this.verificationConnections.size && !this.bindFiles.size && !this.mutex
      && !this.backupFiles.size && !this.backupDatabases.size && !this.backupTasks.size && !this.verificationTasks.size) {
      this.closed = true; this.ownFds.clear();
    }
    throwResourceFailures(errors);
  }
}

export async function createSqliteMaintenanceAdapter(source: SqliteDatabaseDescriptor): Promise<MaintenanceAdapter> {
  return SqliteMaintenanceAdapter.create(source);
}

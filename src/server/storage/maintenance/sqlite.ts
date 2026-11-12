import Database from "better-sqlite3";
import { constants, closeSync, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readdir, readlink, stat } from "node:fs/promises";
import path from "node:path";
import { assertSqliteSourceUnchanged, type SqliteDatabaseDescriptor } from "../../environment.ts";
import { inspectOwnedProcess } from "../../runtime/hosts/process-identity.ts";
import { readSqliteMaintenanceState, type StorageMaintenanceState } from "../admission.ts";
import { assertSqliteGuardCoverage } from "../schema-guards.ts";
import { canonicalJson, digestJson } from "./canonical.ts";
import { MaintenanceFailure } from "./error.ts";
import { maintenanceHostIdentityDigest } from "./host.ts";
import { ArtifactStore } from "./objects.ts";
import { readSqliteManifests } from "./sqlite-manifests.ts";
import type { AnchorChange, Blocker, ControlRootIdentity, DatabaseManifests, Json, MaintenanceAdapter, OperationMutex, SourceLock, SourceObservation } from "./types.ts";

function same(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }
function failure(error: unknown, fallback: "snapshot_invalid" | "maintenance_busy" = "snapshot_invalid"): never {
  if (error instanceof MaintenanceFailure) throw error;
  if (["SQLITE_BUSY", "SQLITE_LOCKED"].includes(String((error as { code?: string }).code))) throw new MaintenanceFailure("maintenance_busy");
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

class SqliteMaintenanceAdapter implements MaintenanceAdapter {
  readonly dialect = "sqlite" as const;
  private readonly source: SqliteDatabaseDescriptor;
  private readonly sourceFd: number;
  private readonly sourceDirectories: ReturnType<typeof directoryChain>;
  private readonly ownFds = new Map<number, string>();
  private mutex: MutexLease | null = null;
  private currentLock: Database.Database | null = null;
  private closed = false;
  constructor(source: SqliteDatabaseDescriptor) {
    if (!source.identity) throw new MaintenanceFailure("source_missing");
    this.source = source;
    try {
      assertSqliteSourceUnchanged(source);
      this.sourceDirectories = directoryChain(source.sqlitePath);
      this.sourceFd = openSync(source.sqlitePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(this.sourceFd, { bigint: true });
      if (String(info.dev) !== source.identity.device || String(info.ino) !== source.identity.inode || info.nlink !== 1n) {
        closeSync(this.sourceFd); throw new MaintenanceFailure("source_changed");
      }
      this.ownFds.set(this.sourceFd, `${info.dev}:${info.ino}`);
    } catch { throw new MaintenanceFailure("source_changed"); }
  }
  private assertSource(): void {
    if (this.closed) throw new MaintenanceFailure("maintenance_lost");
    try {
      assertSqliteSourceUnchanged(this.source);
      const info = fstatSync(this.sourceFd, { bigint: true });
      if (info.nlink !== 1n || String(info.dev) !== this.source.identity!.device || String(info.ino) !== this.source.identity!.inode
        || !same(directoryChain(this.source.sqlitePath), this.sourceDirectories)) throw new Error("changed");
      for (const suffix of ["-wal", "-shm"]) {
        try { fileIdentity(this.source.sqlitePath + suffix); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    } catch { throw new MaintenanceFailure("source_changed"); }
  }
  private relevantFds(): Map<number, string> {
    const result = new Map<number, string>();
    if (process.platform !== "linux") return result;
    for (const entry of readdirSync("/proc/self/fd")) {
      try {
        const file = `/proc/self/fd/${entry}`, target = readlinkSync(file).replace(/ \(deleted\)$/, "");
        if (![this.source.sqlitePath, this.source.sqlitePath + "-wal", this.source.sqlitePath + "-shm"].includes(target)) continue;
        const info = statSync(file, { bigint: true }); result.set(Number(entry), `${info.dev}:${info.ino}`);
      } catch (error) { if (!["ENOENT", "EBADF"].includes(String((error as NodeJS.ErrnoException).code))) throw error; }
    }
    return result;
  }
  private purgeClosedFds(): void {
    const current = this.relevantFds();
    for (const [fd, identity] of this.ownFds) if (current.get(fd) !== identity) this.ownFds.delete(fd);
  }
  private openSource(readonly: boolean): Database.Database {
    this.assertSource(); this.purgeClosedFds(); const before = this.relevantFds();
    const db = new Database(this.source.sqlitePath, { readonly, fileMustExist: true, timeout: 0 });
    try {
      this.assertSource();
      if (readonly) db.pragma("query_only=ON"); else db.pragma("synchronous=FULL");
      db.pragma("busy_timeout=0");
      for (const [fd, identity] of this.relevantFds()) if (before.get(fd) !== identity) this.ownFds.set(fd, identity);
      return db;
    } catch (error) { db.close(); this.purgeClosedFds(); throw error; }
  }
  private closeSource(db: Database.Database): void { db.close(); this.purgeClosedFds(); }
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
    try { db.exec("BEGIN"); const result = this.observation(db); db.exec("COMMIT"); return result; }
    finally { if (db.inTransaction) db.exec("ROLLBACK"); this.closeSource(db); }
  }
  async acquireMutex(root: ControlRootIdentity, expected: StorageMaintenanceState): Promise<OperationMutex> {
    if (this.mutex?.active) throw new MaintenanceFailure("maintenance_busy");
    if (root.hostIdentityDigest !== await maintenanceHostIdentityDigest()) throw new MaintenanceFailure("control_root_mismatch");
    const observed = await this.observe(); const store = await ArtifactStore.open(root.path, observed.source);
    if (!same(root, store.identity)) throw new MaintenanceFailure("control_root_mismatch");
    const control = this.openSource(false); const mutexFile = path.join(root.path, "mutex.sqlite");
    let mutexIdentity: Json;
    try {
      control.exec("BEGIN IMMEDIATE");
      const state = readSqliteMaintenanceState(control, true)!;
      if (!same(state, expected)) throw new MaintenanceFailure("maintenance_lost");
      if (state.controlRootJson === null && state.mutexIdentityJson === null) {
        if (state.admission !== "open") throw new MaintenanceFailure("control_root_mismatch");
        // An unbound but valid lock file can be an orphan of the same root's interrupted first bind.
        try { const handle = await open(mutexFile, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); await handle.close(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        fileIdentity(mutexFile);
        const initial = new Database(mutexFile, { fileMustExist: true, timeout: 0 });
        try {
          initial.pragma("synchronous=FULL");
          const schema = initial.prepare("SELECT name FROM sqlite_schema").all();
          if (!schema.length) initial.exec("BEGIN IMMEDIATE; CREATE TABLE maintenance_mutex(id INTEGER PRIMARY KEY CHECK(id=1)); INSERT INTO maintenance_mutex VALUES(1); COMMIT");
          this.checkMutexSchema(initial);
        } finally { initial.close(); }
        const handle = await open(mutexFile, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { await handle.sync(); } finally { await handle.close(); }
        const directory = await open(root.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await directory.sync(); } finally { await directory.close(); }
        mutexIdentity = { kind: "sqlite-operation-mutex", ...fileIdentity(mutexFile) };
        control.prepare("UPDATE storage_maintenance SET control_root_json=?,mutex_identity_json=? WHERE singleton=1")
          .run(canonicalJson(root), canonicalJson(mutexIdentity));
      } else {
        if (state.controlRootJson !== canonicalJson(root) || !state.mutexIdentityJson) throw new MaintenanceFailure("control_root_mismatch");
        mutexIdentity = JSON.parse(state.mutexIdentityJson) as Json;
        try { if (!same(mutexIdentity, { kind: "sqlite-operation-mutex", ...fileIdentity(mutexFile) })) throw new Error(); }
        catch { throw new MaintenanceFailure("control_root_mismatch"); }
      }
      this.assertSource(); await store.assertRoot(); control.exec("COMMIT");
    } catch (error) { if (control.inTransaction) control.exec("ROLLBACK"); failure(error); }
    finally { this.closeSource(control); }
    let db: Database.Database | undefined;
    try { db = new Database(mutexFile, { fileMustExist: true, timeout: 0 }); db.pragma("synchronous=FULL"); this.checkMutexSchema(db); db.exec("BEGIN IMMEDIATE"); }
    catch (error) { db?.close(); return failure(error); }
    const lease: MutexLease = { root, identity: mutexIdentity!, db: db!, active: true,
      assertHeld: async () => {
        this.assertSource(); await store.assertRoot();
        if (!lease.active || !lease.db.open || !lease.db.inTransaction || !same(lease.identity, { kind: "sqlite-operation-mutex", ...fileIdentity(mutexFile) }))
          throw new MaintenanceFailure("maintenance_lost");
      },
      release: async () => { if (!lease.active) return; lease.active = false; if (lease.db.inTransaction) lease.db.exec("ROLLBACK"); lease.db.close(); if (this.mutex === lease) this.mutex = null; },
    };
    this.mutex = lease; await lease.assertHeld(); return lease;
  }
  private checkMutexSchema(db: Database.Database): void {
    const schema = db.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY name").all();
    if (!same(schema, [{ type: "table", name: "maintenance_mutex", sql: "CREATE TABLE maintenance_mutex(id INTEGER PRIMARY KEY CHECK(id=1))" }])
      || !same(db.prepare("SELECT * FROM maintenance_mutex").all(), [{ id: 1 }])) throw new MaintenanceFailure("control_root_mismatch");
  }
  async withSourceLock<T>(kind: "control" | "snapshot", callback: (lock: SourceLock) => Promise<T>): Promise<T> {
    const mutex = this.mutex;
    if (!mutex || this.currentLock) throw new MaintenanceFailure(this.currentLock ? "maintenance_busy" : "maintenance_lost");
    await mutex.assertHeld();
    const db = this.openSource(false); let active = true;
    try {
      db.exec("BEGIN IMMEDIATE"); this.currentLock = db;
      try { assertSqliteGuardCoverage(db); } catch { throw new MaintenanceFailure("schema_guard_incomplete"); }
      if (kind === "snapshot" && readSqliteMaintenanceState(db, true)!.admission !== "sealed") throw new MaintenanceFailure("maintenance_lost");
      const assertHeld = async () => {
        await mutex.assertHeld();
        if (!active || !db.open || !db.inTransaction || this.currentLock !== db) throw new MaintenanceFailure("maintenance_lost");
      };
      const lock: SourceLock = {
        assertHeld,
        observe: async () => { await assertHeld(); return this.observation(db); },
        anchor: async change => { await assertHeld(); this.anchor(db, change, mutex); },
        backup: async destination => {
          await assertHeld();
          if (kind !== "snapshot") throw new MaintenanceFailure("maintenance_lost");
          const result = await this.backup(db, mutex, destination); await assertHeld(); return result;
        },
      };
      const result = await callback(lock); await assertHeld(); db.exec("COMMIT"); return result;
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK");
      if (error instanceof MaintenanceFailure) throw error;
      if (["SQLITE_BUSY", "SQLITE_LOCKED"].includes(String((error as { code?: string }).code))) throw new MaintenanceFailure("maintenance_busy");
      throw error;
    } finally { active = false; this.currentLock = null; this.closeSource(db); }
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
  private async backup(control: Database.Database, mutex: MutexLease, destination: string) {
    if (!path.isAbsolute(destination) || !destination.startsWith(`${mutex.root.path}/attempts/`)
      || realpathSync(path.dirname(destination)) !== path.dirname(destination)) throw new MaintenanceFailure("snapshot_invalid");
    const handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); await handle.close();
    const reader = this.openSource(true);
    try {
      reader.exec("BEGIN"); const observation = this.observation(reader);
      if (observation.state.admission !== "sealed" || !same(observation.state, readSqliteMaintenanceState(control, true))) throw new MaintenanceFailure("maintenance_lost");
      const manifests = observation.manifests;
      const progress = await reader.backup(destination, { progress: () => {
        this.assertSource(); if (!mutex.active || !mutex.db.inTransaction || !control.inTransaction) throw new MaintenanceFailure("maintenance_lost"); return 100;
      } });
      if (progress.remainingPages !== 0 || !same(manifests, readSqliteManifests(reader))) throw new MaintenanceFailure("snapshot_invalid");
      reader.exec("COMMIT");
      const target = new Database(destination, { fileMustExist: true });
      try { target.pragma("wal_checkpoint(TRUNCATE)"); target.pragma("journal_mode=DELETE"); }
      finally { target.close(); }
      const info = await stat(destination, { bigint: true });
      const targetFile = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const header = Buffer.alloc(16); await targetFile.read(header, 0, 16, 0);
        if (info.size < 512n || header.toString("binary") !== "SQLite format 3\0") throw new MaintenanceFailure("snapshot_invalid");
        await targetFile.sync();
      } finally { await targetFile.close(); }
      try { if ((await stat(destination + "-wal")).size !== 0) throw new MaintenanceFailure("snapshot_invalid"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await mutex.assertHeld(); this.assertSource();
      return { manifests, toolchain: { kind: "sqlite-backup", node: process.version,
        sqlite: String((control.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version),
        independentReader: true, committedWalIncluded: true } };
    } catch (error) { return failure(error); }
    finally { if (reader.inTransaction) reader.exec("ROLLBACK"); this.closeSource(reader); }
  }
  async verifyDatabase(databaseFile: string, expected: DatabaseManifests, restoreDirectory: string): Promise<Json> {
    if (!this.mutex?.active || !this.currentLock) throw new MaintenanceFailure("maintenance_lost");
    await this.mutex.assertHeld();
    if (!restoreDirectory.startsWith(`${this.mutex.root.path}/attempts/`) || realpathSync(path.dirname(restoreDirectory)) !== path.dirname(restoreDirectory))
      throw new MaintenanceFailure("snapshot_invalid");
    await mkdir(restoreDirectory, { mode: 0o700 });
    const restored = path.join(restoreDirectory, "restored.sqlite");
    await copyFile(databaseFile, restored, constants.COPYFILE_EXCL); await chmod(restored, 0o600);
    const identity = fileIdentity(restored);
    if (identity.device === this.source.identity!.device && identity.inode === this.source.identity!.inode) throw new MaintenanceFailure("snapshot_invalid");
    const db = new Database(restored, { readonly: true, fileMustExist: true });
    try {
      db.pragma("query_only=ON"); db.exec("BEGIN");
      const integrity = db.pragma("integrity_check") as { integrity_check: string }[];
      if (integrity.length !== 1 || integrity[0]!.integrity_check !== "ok" || (db.pragma("foreign_key_check") as unknown[]).length
        || !same(readSqliteManifests(db), expected)) throw new MaintenanceFailure("snapshot_invalid");
      db.exec("COMMIT");
      return { kind: "sqlite-restore-verification", ...identity, fullDataManifestDigest: expected.fullDataManifestDigest,
        capturedControlManifestDigest: expected.capturedControlManifestDigest, integrityCheck: "ok", foreignKeyViolations: 0 };
    } catch (error) { return failure(error); }
    finally { if (db.inTransaction) db.exec("ROLLBACK"); db.close(); }
  }
  async inspectWriters(_observation: SourceObservation): Promise<readonly Blocker[]> {
    this.assertSource();
    if (process.platform !== "linux" || process.getuid === undefined) return [{ code: "source_writer_unknown", subjectRef: "os-inventory-unavailable" }];
    this.purgeClosedFds(); const blockers: Blocker[] = [];
    const sourcePaths = [this.source.sqlitePath, this.source.sqlitePath + "-wal", this.source.sqlitePath + "-shm"];
    const sessions = path.join(this.source.dataDir, "managed", "sessions");
    for (const pid of (await readdir("/proc")).filter(entry => /^[1-9][0-9]*$/.test(entry))) {
      try {
        if ((await stat(`/proc/${pid}`)).uid !== process.getuid()) continue;
        for (const fd of await readdir(`/proc/${pid}/fd`)) {
          try {
            const file = `/proc/${pid}/fd/${fd}`, target = (await readlink(file)).replace(/ \(deleted\)$/, "");
            if (!sourcePaths.includes(target) && target !== sessions && !target.startsWith(`${sessions}/`)) continue;
            const info = await stat(file, { bigint: true });
            if (Number(pid) === process.pid && this.ownFds.get(Number(fd)) === `${info.dev}:${info.ino}`) continue;
            blockers.push({ code: "source_writer_unknown", subjectRef: `os-process:${pid}` });
          } catch (error) { if (!["ENOENT", "ESRCH", "EBADF"].includes(String((error as NodeJS.ErrnoException).code))) blockers.push({ code: "source_writer_unknown", subjectRef: `unreadable-process:${pid}` }); }
        }
      } catch (error) { if (!["ENOENT", "ESRCH"].includes(String((error as NodeJS.ErrnoException).code))) blockers.push({ code: "source_writer_unknown", subjectRef: `unreadable-process:${pid}` }); }
    }
    const db = this.openSource(true);
    try {
      for (const row of db.prepare("SELECT binding_id,process_identity_json FROM agent_runner_states WHERE exit_confirmed=0").all() as { binding_id: string; process_identity_json: string | null }[]) {
        let exited = false;
        try { exited = row.process_identity_json !== null && (await inspectOwnedProcess(JSON.parse(row.process_identity_json))).status === "wrapper_exited"; } catch { /* unknown remains blocking */ }
        if (!exited) blockers.push({ code: "source_writer_active", subjectRef: `runtime-binding:${row.binding_id}` });
      }
    } finally { this.closeSource(db); }
    return [...new Map(blockers.map(blocker => [canonicalJson(blocker), blocker])).values()];
  }
  async close(): Promise<void> {
    if (this.currentLock) throw new MaintenanceFailure("maintenance_busy");
    await this.mutex?.release();
    if (!this.closed) { this.closed = true; closeSync(this.sourceFd); this.ownFds.clear(); }
  }
}

export async function createSqliteMaintenanceAdapter(source: SqliteDatabaseDescriptor): Promise<MaintenanceAdapter> {
  const adapter = new SqliteMaintenanceAdapter(source);
  try { await adapter.observe(); return adapter; }
  catch (error) { await adapter.close(); throw error; }
}

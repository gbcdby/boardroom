import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Client } from "pg";
import { parseStorageMaintenanceState, readPostgresMaintenanceState, type StorageMaintenanceState } from "../admission.ts";
import { canonicalJson, digestJson, sha256 } from "./canonical.ts";
import { MaintenanceFailure } from "./error.ts";
import { maintenanceHostIdentityDigest } from "./host.ts";
import { buildDatabaseManifests } from "./manifests.ts";
import { listPostgresTables, quotePostgresIdentifier as quote, readPostgresCatalog, readPostgresEnvironment, readPostgresManifests,
  readPostgresRoles, type PostgresReader, type PostgresTable } from "./postgres-manifests.ts";
import { assertPostgresServerCapability, stablePostgresSourceIdentity, type PostgresDatabaseIdentity } from "./postgres-identity.ts";
import { parsePostgresConnection, postgresDatabaseArgument, postgresToolVersions, runPostgresTool, waitForPostgresTools,
  type PostgresConnection, type PostgresDescriptor } from "./postgres-tools.ts";
import { postgresFileDigest, restorePostgresPublic } from "./postgres-public-restore.ts";
import { readPublicRestoreCatalogBinding, type PublicRestoreCatalogBinding } from "./postgres-public-toc.ts";
import type { AnchorChange, Blocker, BlockerCode, ControlRootIdentity, DatabaseManifests, Json,
  MaintenanceAdapter, OperationMutex, SourceLock, SourceObservation } from "./types.ts";

interface Session {
  readonly client: Client;
  readonly source: boolean;
  readonly critical: boolean;
  pid: number;
  backendStart: string;
  ending: boolean;
  ended: boolean;
}
interface HeldMutex {
  readonly session: Session;
  readonly root: ControlRootIdentity;
  readonly identity: Json;
  readonly sourceIdentity: PostgresDatabaseIdentity;
  readonly marker: string;
  readonly high: number;
  readonly low: number;
  released: boolean;
}
const stateColumns: Readonly<Record<keyof StorageMaintenanceState, string>> = {
  databaseInstanceId: "database_instance_id", admission: "admission", fenceEpoch: "fence_epoch",
  ownerGeneration: "owner_generation", activeMigrationId: "active_migration_id", planDigest: "plan_digest",
  controlRootJson: "control_root_json", mutexIdentityJson: "mutex_identity_json", journalRecordRef: "journal_record_ref",
  journalDigest: "journal_digest", journalSequence: "journal_sequence", protocolVersion: "protocol_version",
  guardManifestDigest: "guard_manifest_digest",
};
function object(value: Json): Readonly<Record<string, Json>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MaintenanceFailure("snapshot_invalid");
  return value as Readonly<Record<string, Json>>;
}
function same(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }
function safeError(error: unknown, fallback: BlockerCode): MaintenanceFailure {
  if (error instanceof MaintenanceFailure) return error;
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  return new MaintenanceFailure(code === "55P03" ? "maintenance_busy" : ["40001", "40P01"].includes(code) ? "source_changed" : fallback);
}
function checkedCounter(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
/** Internal readers use promise queries. Bound every actual query dispatch and its
 * real completion; a failed check never leaves a detached query running. */
function checkedReader(reader: PostgresReader, check?: () => void): PostgresReader {
  if (!check) return reader;
  return { query: ((...args: unknown[]) => {
    check();
    return (Reflect.apply(reader.query, reader, args) as Promise<unknown>).then(value => { check(); return value; });
  }) as PostgresReader["query"] };
}
function cas(expected: StorageMaintenanceState, start: number): { clause: string; parameters: unknown[] } {
  const entries = Object.entries(stateColumns) as [keyof StorageMaintenanceState, string][];
  return { clause: entries.map(([, column], index) => `${quote(column)} IS NOT DISTINCT FROM $${start + index}`).join(" AND "),
    parameters: entries.map(([property]) => expected[property]) };
}

function assertAnchor(change: AnchorChange, mutex: HeldMutex): void {
  const before = change.expected;
  if (before.databaseInstanceId !== mutex.marker || !same(change.controlRootIdentity, mutex.root)
    || !same(change.mutexIdentity, mutex.identity) || before.controlRootJson !== canonicalJson(mutex.root)
    || before.mutexIdentityJson !== canonicalJson(mutex.identity)) throw new MaintenanceFailure("source_changed");
  if (![change.fenceEpoch, change.ownerGeneration, change.journalSequence].every(checkedCounter)
    || ![before.ownerGeneration, before.ownerGeneration + 1].includes(change.ownerGeneration)
    || !/^[a-f0-9]{64}$/.test(change.journal.sha256) || !change.journal.ref || !/^[1-9][0-9]*$/.test(change.journal.bytes))
    throw new MaintenanceFailure("phase_conflict");
  if (before.admission === "open") {
    if (change.admission !== "draining" || change.fenceEpoch !== before.fenceEpoch + 1
      || change.ownerGeneration !== before.ownerGeneration + 1 || !change.activeMigrationId
      || !/^[a-f0-9]{64}$/.test(change.planDigest ?? "") || change.journalSequence !== 1)
      throw new MaintenanceFailure("phase_conflict");
    return;
  }
  if (change.journalSequence !== before.journalSequence + 1) throw new MaintenanceFailure("phase_conflict");
  if (change.admission === "open") {
    if (change.fenceEpoch !== before.fenceEpoch + 1 || change.activeMigrationId !== null || change.planDigest !== null)
      throw new MaintenanceFailure("phase_conflict");
    return;
  }
  if (before.admission === "sealed" && change.admission !== "sealed"
    || change.fenceEpoch !== before.fenceEpoch || change.activeMigrationId !== before.activeMigrationId
    || change.planDigest !== before.planDigest) throw new MaintenanceFailure("phase_conflict");
}

async function privateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
    || typeof process.getuid === "function" && info.uid !== process.getuid())
    throw new MaintenanceFailure("target_conflict");
}

export async function createPostgresMaintenanceAdapter(source: PostgresDescriptor,
  verification: PostgresDescriptor | undefined): Promise<MaintenanceAdapter> {
  const sourceConnection = parsePostgresConnection(source);
  const verificationConnection = verification ? parsePostgresConnection(verification) : undefined;
  const sessions = new Set<Session>();
  const abort = new AbortController();
  let closed = false, lost = false, mutex: HeldMutex | undefined, lockActive = false;
  let firstSourceIdentity: Json | undefined, mutexTimer: ReturnType<typeof setInterval> | undefined;
  let firstServerIdentity: PostgresDatabaseIdentity | undefined;
  let assertSnapshotLock: ((check?: () => void) => Promise<void>) | undefined;
  let publicBackup: { readonly sha256: string; readonly manifestDigest: string; readonly binding: PublicRestoreCatalogBinding } | undefined;
  const activeVerifications = new Set<Promise<Json>>();
  const invalidate = () => { lost = true; abort.abort(); };
  function assertOpen(): void {
    if (closed || lost) throw new MaintenanceFailure("maintenance_lost");
  }
  async function endSession(session: Session): Promise<void> {
    session.ending = true;
    await session.client.end().catch(() => {});
    session.ended = true; sessions.delete(session);
  }
  async function connect(connection: PostgresConnection, sourceSession: boolean, critical = false): Promise<Session> {
    assertOpen();
    const client = new Client({ ...connection.clientConfig,
      application_name: `boardroom-maintenance:${randomUUID()}` });
    const session: Session = { client, source: sourceSession, critical, pid: 0, backendStart: "", ending: false, ended: false };
    client.on("error", () => { if (critical && !session.ending) invalidate(); });
    client.on("end", () => { session.ended = true; if (critical && !session.ending) invalidate(); });
    try {
      await client.connect(); sessions.add(session);
      await client.query(`SET search_path TO ${quote(connection.schema)},pg_catalog`);
      await client.query("SET DateStyle='ISO,YMD'; SET TimeZone='UTC'; SET bytea_output='hex'; SET extra_float_digits=3; SET IntervalStyle='postgres'");
      const row = (await client.query("SELECT pid,backend_start::text FROM pg_catalog.pg_stat_activity WHERE pid=pg_backend_pid()")).rows[0];
      if (!Number.isSafeInteger(row?.pid) || typeof row?.backend_start !== "string") throw new MaintenanceFailure("source_changed");
      session.pid = row.pid; session.backendStart = row.backend_start;
      return session;
    } catch (error) {
      await endSession(session);
      throw safeError(error, sourceSession ? "source_missing" : "restore_verification_unavailable");
    }
  }
  async function readIdentity(session: Session, connection: PostgresConnection, requireSchema: boolean,
    check?: () => void): Promise<PostgresDatabaseIdentity> {
    const row = (await checkedReader(session.client, check).query(`SELECT control.system_identifier::text AS system_identifier,
      d.oid::text AS database_oid,d.datname AS database_name,n.oid::text AS schema_oid,
      inet_server_addr()::text AS server_address,inet_server_port() AS server_port,
      pg_postmaster_start_time()::text AS postmaster_started_at,current_setting('server_version_num') AS server_version,
      current_setting('fsync') AS fsync,pg_is_in_recovery() AS in_recovery
      FROM pg_catalog.pg_database d CROSS JOIN pg_catalog.pg_control_system() control
      LEFT JOIN pg_catalog.pg_namespace n ON n.nspname=$1 WHERE d.datname=current_database()`, [connection.schema])).rows[0];
    if (!row || requireSchema && !row.schema_oid || row.database_name !== connection.database)
      throw new MaintenanceFailure("source_missing");
    const actual: PostgresDatabaseIdentity = { systemIdentifier: row.system_identifier, databaseOid: row.database_oid, databaseName: row.database_name,
      schemaOid: row.schema_oid, schemaName: connection.schema, serverAddress: row.server_address, serverPort: row.server_port,
      postmasterStartedAt: row.postmaster_started_at, serverVersion: row.server_version, fsync: row.fsync, inRecovery: row.in_recovery };
    // Even a readonly adapter that currently holds no session cannot silently reconnect across a
    // restart. The caller must build a new adapter and reacquire every physical/session capability.
    if (session.source) {
      if (firstServerIdentity && !same(firstServerIdentity, actual)) { invalidate(); throw new MaintenanceFailure("maintenance_lost"); }
      firstServerIdentity ??= actual;
    }
    assertPostgresServerCapability(actual, "observe");
    return actual;
  }
  async function observation(session: Session): Promise<SourceObservation> {
    const actual = await readIdentity(session, sourceConnection, true);
    const manifests = await readPostgresManifests(session.client, sourceConnection.schema);
    const state = parseStorageMaintenanceState(manifests.controlRows.storage_maintenance.map(row => ({ ...row })));
    const sourceIdentity = stablePostgresSourceIdentity(actual, sourceConnection.descriptorDigest, state.databaseInstanceId);
    if (firstSourceIdentity !== undefined && !same(firstSourceIdentity, sourceIdentity)) throw new MaintenanceFailure("source_changed");
    firstSourceIdentity ??= sourceIdentity;
    return { source: { kind: "postgres", databaseInstanceId: state.databaseInstanceId, identityDigest: digestJson(sourceIdentity) },
      sourceIdentity, state, manifests, clients: manifests.controlRows.storage_source_clients };
  }
  async function observe(): Promise<SourceObservation> {
    const session = await connect(sourceConnection, true);
    try {
      await session.client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await observation(session);
      await session.client.query("COMMIT"); return result;
    } catch (error) { throw safeError(error, "schema_guard_incomplete"); }
    finally { await endSession(session); }
  }
  async function assertMutex(held = mutex, check?: () => void): Promise<void> {
    check?.(); assertOpen();
    if (!held || held.released || held.session.ended) throw new MaintenanceFailure("maintenance_lost");
    try {
      const live = await readIdentity(held.session, sourceConnection, true, check);
      const row = (await checkedReader(held.session.client, check).query(`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks
        WHERE locktype='advisory' AND mode='ExclusiveLock' AND granted AND pid=$1 AND database=$2::oid
        AND classid=$3::oid AND objid=$4::oid AND objsubid=2) AS held,
        (SELECT database_instance_id FROM ${quote(sourceConnection.schema)}.storage_maintenance WHERE singleton=1) AS marker,
        (SELECT control_root_json FROM ${quote(sourceConnection.schema)}.storage_maintenance WHERE singleton=1) AS root,
        (SELECT mutex_identity_json FROM ${quote(sourceConnection.schema)}.storage_maintenance WHERE singleton=1) AS mutex`,
      [held.session.pid, held.sourceIdentity.databaseOid, String(held.high >>> 0), String(held.low >>> 0)])).rows[0];
      if (!same(live, held.sourceIdentity) || row?.held !== true || row.marker !== held.marker
        || row.root !== canonicalJson(held.root) || row.mutex !== canonicalJson(held.identity)) throw new Error("lost");
    } catch {
      // Expiry after a completed query is a budget failure, not proof that this
      // source lock was lost. The public monitor still cancels on either failure.
      check?.(); invalidate(); throw new MaintenanceFailure("maintenance_lost");
    }
  }
  async function acquireMutex(root: ControlRootIdentity, expected: StorageMaintenanceState): Promise<OperationMutex> {
    assertOpen();
    if (mutex && !mutex.released) throw new MaintenanceFailure("maintenance_busy");
    if (root.hostIdentityDigest !== await maintenanceHostIdentityDigest()) throw new MaintenanceFailure("control_root_mismatch");
    const session = await connect(sourceConnection, true, true);
    let acquired = false;
    try {
      const actual = await readIdentity(session, sourceConnection, true);
      assertPostgresServerCapability(actual, "execute");
      const current = await readPostgresMaintenanceState(session.client, { required: true });
      if (!same(current, expected)) throw new MaintenanceFailure("source_changed");
      if (firstSourceIdentity && !same(firstSourceIdentity, stablePostgresSourceIdentity(actual,
        sourceConnection.descriptorDigest, expected.databaseInstanceId)))
        throw new MaintenanceFailure("source_changed");
      const keySource = { systemIdentifier: actual.systemIdentifier, databaseOid: actual.databaseOid,
        schemaOid: actual.schemaOid, databaseInstanceId: expected.databaseInstanceId };
      const bytes = createHash("sha256").update(canonicalJson({ protocol: "boardroom-maintenance-v1", ...keySource })).digest();
      const high = bytes.readInt32BE(0), low = bytes.readInt32BE(4);
      if ((await session.client.query("SELECT pg_catalog.pg_try_advisory_lock($1::integer,$2::integer) AS acquired", [high, low])).rows[0]?.acquired !== true)
        throw new MaintenanceFailure("maintenance_busy");
      acquired = true;
      const identity: Json = { formatVersion: 1, kind: "postgres-session-advisory", source: keySource, key: [high, low] };
      await session.client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE");
      await session.client.query("SET LOCAL synchronous_commit=on");
      const locked = parseStorageMaintenanceState((await session.client.query("SELECT * FROM storage_maintenance FOR UPDATE NOWAIT")).rows);
      if (!same(locked, expected)) throw new MaintenanceFailure("source_changed");
      const rootJson = canonicalJson(root), identityJson = canonicalJson(identity);
      if ((locked.controlRootJson === null) !== (locked.mutexIdentityJson === null)) throw new MaintenanceFailure("control_root_mismatch");
      if (locked.controlRootJson === null) {
        if (locked.admission !== "open" || locked.journalSequence !== 0) throw new MaintenanceFailure("control_root_mismatch");
        const expectedCas = cas(locked, 3);
        const bound = await session.client.query(`UPDATE storage_maintenance SET control_root_json=$1,mutex_identity_json=$2
          WHERE singleton=1 AND ${expectedCas.clause}`, [rootJson, identityJson, ...expectedCas.parameters]);
        if (bound.rowCount !== 1) throw new MaintenanceFailure("source_changed");
      } else if (locked.controlRootJson !== rootJson || locked.mutexIdentityJson !== identityJson)
        throw new MaintenanceFailure("control_root_mismatch");
      if ((await session.client.query("COMMIT")).command !== "COMMIT") throw new MaintenanceFailure("maintenance_lost");
      const held: HeldMutex = { session, root, identity, sourceIdentity: actual, marker: expected.databaseInstanceId, high, low, released: false };
      mutex = held;
      let heartbeatRunning = false;
      mutexTimer = setInterval(() => {
        if (heartbeatRunning || held.released || closed) return;
        heartbeatRunning = true;
        void assertMutex(held).catch(invalidate).finally(() => { heartbeatRunning = false; });
      }, 1_000); mutexTimer.unref();
      return { identity,
        assertHeld: () => assertMutex(held),
        async release() {
          if (held.released) return;
          if (lockActive) throw new MaintenanceFailure("maintenance_busy");
          held.released = true; clearInterval(mutexTimer); mutexTimer = undefined;
          await endSession(session);
          if (mutex === held) mutex = undefined;
        },
      };
    } catch (error) {
      if (acquired) await session.client.query("ROLLBACK").catch(() => {});
      await endSession(session); throw safeError(error, "maintenance_lost");
    }
  }
  async function inspectWriters(current: SourceObservation): Promise<readonly Blocker[]> {
    const session = await connect(sourceConnection, true);
    try {
      const identity = await readIdentity(session, sourceConnection, true);
      if (!same(current.sourceIdentity, stablePostgresSourceIdentity(identity,
        sourceConnection.descriptorDigest, current.state.databaseInstanceId))) throw new MaintenanceFailure("source_changed");
      const registered = new Set<string>();
      for (const client of current.clients) {
        if (typeof client.db_sessions_json !== "string") continue;
        try {
          const envelope = JSON.parse(client.db_sessions_json) as { sessions?: { observedBackends?: { pid?: unknown; backend_start?: unknown }[] }[] };
          for (const entry of envelope.sessions ?? []) for (const backend of entry.observedBackends ?? []) {
            if (Number.isSafeInteger(backend.pid) && typeof backend.backend_start === "string")
              registered.add(`${backend.pid}:${backend.backend_start}`);
          }
        } catch { /* An invalid registration cannot exempt any real backend. */ }
      }
      const actual = (await session.client.query(`SELECT pid,backend_start::text,backend_type,state,
        EXISTS(SELECT 1 FROM pg_catalog.pg_locks l WHERE l.pid=a.pid AND l.granted
          AND l.mode IN ('RowExclusiveLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock')) AS write_lock
        FROM pg_catalog.pg_stat_activity a WHERE datid=$1::oid ORDER BY pid`, [identity.databaseOid])).rows;
      const blockers: Blocker[] = [];
      for (const backend of actual) {
        const own = [...sessions].some(candidate => candidate.source && !candidate.ended
          && candidate.pid === backend.pid && candidate.backendStart === backend.backend_start);
        if (own) continue;
        const known = registered.has(`${backend.pid}:${backend.backend_start}`);
        blockers.push({ code: known ? "source_writer_active" : "source_writer_unknown",
          subjectRef: `postgres-backend:${sha256(`${backend.pid}:${backend.backend_start}`).slice(0, 24)}` });
      }
      // A prepared transaction survives its backend and can later commit; pg_stat_activity alone misses it.
      if ((await session.client.query("SELECT 1 FROM pg_catalog.pg_prepared_xacts WHERE database=current_database() LIMIT 1")).rows.length)
        blockers.push({ code: "source_writer_unknown", subjectRef: "postgres-prepared-transaction" });
      return blockers;
    } catch (error) { throw safeError(error, "source_writer_unknown"); }
    finally { await endSession(session); }
  }
  async function withPassfile<T>(connection: PostgresConnection, directory: string,
    callback: (environment: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
    await privateDirectory(directory);
    const path = join(directory, `.pgpass-${randomUUID()}`);
    const passfile = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await passfile.close();
    try { return await callback({ ...connection.childEnvironment, PGPASSFILE: path }); }
    finally { await unlink(path).catch(() => {}); }
  }
  async function withSourceLock<T>(kind: "control" | "snapshot", callback: (lock: SourceLock) => Promise<T>): Promise<T> {
    await assertMutex();
    if (lockActive) throw new MaintenanceFailure("maintenance_busy");
    lockActive = true;
    let session: Session | undefined, active = false, transactionId = "", changed = false, backupUsed = false;
    let tables: readonly PostgresTable[] = [], lockedSchemaDigest: string | undefined;
    let frozenCapture: DatabaseManifests | undefined;
    try {
      session = await connect(sourceConnection, true, true);
      // This inventory precedes BEGIN. The snapshot's first SELECT must occur only after LOCK.
      tables = await listPostgresTables(session.client, sourceConnection.schema);
      await session.client.query(kind === "snapshot" ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE" : "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE");
      await session.client.query("SET LOCAL synchronous_commit=on");
      await session.client.query(`LOCK TABLE ${tables.map(table => `${quote(sourceConnection.schema)}.${quote(table.name)}`).join(",")}
        IN ${kind === "snapshot" ? "SHARE" : "SHARE ROW EXCLUSIVE"} MODE NOWAIT`);
      active = true;
      transactionId = (await session.client.query("SELECT pg_catalog.pg_current_xact_id()::text AS id")).rows[0].id;
      if (!same(tables, await listPostgresTables(session.client, sourceConnection.schema))) throw new MaintenanceFailure("source_changed");
      const locked = session;
      const assertHeld = async (check?: () => void) => {
        await assertMutex(mutex, check);
        if (!active || locked.ended) throw new MaintenanceFailure("maintenance_lost");
        const actual = (await checkedReader(locked.client, check).query(`SELECT pg_catalog.pg_current_xact_id_if_assigned()::text AS id,
          (SELECT count(*)::text FROM pg_catalog.pg_locks WHERE pid=pg_backend_pid() AND locktype='relation'
           AND granted AND mode=$1 AND relation=ANY($2::oid[])) AS count`,
        [kind === "snapshot" ? "ShareLock" : "ShareRowExclusiveLock", tables.map(table => table.oid)])).rows[0];
        if (actual?.id !== transactionId || actual.count !== String(tables.length)) { invalidate(); throw new MaintenanceFailure("maintenance_lost"); }
      };
      if (kind === "snapshot") assertSnapshotLock = assertHeld;
      const lock: SourceLock = {
        async observe() {
          await assertHeld(); const result = await observation(locked);
          lockedSchemaDigest ??= result.manifests.schemaManifestDigest;
          if (lockedSchemaDigest !== result.manifests.schemaManifestDigest) throw new MaintenanceFailure("source_changed");
          return result;
        },
        async anchor(change) {
          await assertHeld(); assertAnchor(change, mutex!);
          const current = await readPostgresMaintenanceState(locked.client, { required: true });
          if (!same(current, change.expected)) throw new MaintenanceFailure("source_changed");
          const expectedCas = cas(change.expected, 12);
          const result = await locked.client.query(`UPDATE storage_maintenance SET admission=$1,fence_epoch=$2,owner_generation=$3,
            active_migration_id=$4,plan_digest=$5,control_root_json=$6,mutex_identity_json=$7,journal_record_ref=$8,
            journal_digest=$9,journal_sequence=$10 WHERE singleton=$11 AND ${expectedCas.clause}`,
          [change.admission, change.fenceEpoch, change.ownerGeneration, change.activeMigrationId, change.planDigest,
            canonicalJson(change.controlRootIdentity), canonicalJson(change.mutexIdentity), change.journal.ref,
            change.journal.sha256, change.journalSequence, 1, ...expectedCas.parameters]);
          if (result.rowCount !== 1) throw new MaintenanceFailure("source_changed");
          changed = true;
        },
        async backup(destination) {
          await assertHeld();
          if (kind !== "snapshot" || changed || backupUsed) throw new MaintenanceFailure("phase_conflict");
          backupUsed = true;
          const capture = await lock.observe();
          if (capture.state.admission !== "sealed") throw new MaintenanceFailure("phase_conflict");
          const writers = await inspectWriters(capture);
          if (writers.length) throw new MaintenanceFailure(writers[0]!.code);
          const versions = await postgresToolVersions(sourceConnection.childEnvironment, abort.signal, "backup_capability_unavailable");
          const publicBinding = sourceConnection.schema === "public"
            ? await readPublicRestoreCatalogBinding(locked.client, await readIdentity(locked, sourceConnection, true), capture.manifests, versions.pgDump) : undefined;
          const snapshotId = (await locked.client.query("SELECT pg_catalog.pg_export_snapshot() AS id")).rows[0]?.id;
          if (typeof snapshotId !== "string" || !/^[0-9A-Fa-f-]+$/.test(snapshotId)) throw new MaintenanceFailure("snapshot_invalid");
          await privateDirectory(dirname(destination));
          const output = await open(destination, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          let monitorBusy = false;
          let publicArchiveDigest: string | undefined;
          const monitor = setInterval(() => {
            if (monitorBusy) return; monitorBusy = true;
            void assertHeld().catch(invalidate).finally(() => { monitorBusy = false; });
          }, 500); monitor.unref();
          try {
            await withPassfile(sourceConnection, dirname(destination), async environment => {
              const result = await runPostgresTool("pg_dump", ["--format=custom", `--snapshot=${snapshotId}`,
                `--schema=${quote(sourceConnection.schema)}`, "--strict-names", "--lock-wait-timeout=5000", "--no-password"],
              environment, { failure: "backup_capability_unavailable", signal: abort.signal, outputFd: output.fd });
              if (result.stderrPresent) throw new MaintenanceFailure("backup_capability_unavailable");
            });
            await output.sync();
            const info = await output.stat();
            const header = Buffer.alloc(5); await output.read(header, 0, 5, 0);
            if (!info.isFile() || info.size <= 5 || info.nlink !== 1 || (info.mode & 0o077) !== 0 || header.toString("ascii") !== "PGDMP")
              throw new MaintenanceFailure("snapshot_invalid");
            if (publicBinding) publicArchiveDigest = await postgresFileDigest(output, () => {
              if (abort.signal.aborted) throw new MaintenanceFailure("maintenance_lost");
            });
          } finally { clearInterval(monitor); await output.close(); }
          await assertHeld();
          const after = await observe();
          if (!same(after.manifests, capture.manifests) || !same(after.source, capture.source)) throw new MaintenanceFailure("source_changed");
          if ((await inspectWriters(after)).length) throw new MaintenanceFailure("source_writer_unknown");
          const identity = await readIdentity(locked, sourceConnection, true);
          frozenCapture = capture.manifests;
          if (publicBinding && publicArchiveDigest) publicBackup = { sha256: publicArchiveDigest,
            manifestDigest: digestJson(capture.manifests), binding: publicBinding };
          return { manifests: capture.manifests, toolchain: { formatVersion: 1, engine: "postgres", format: "custom",
            pgDump: versions.pgDump, pgRestore: versions.pgRestore, serverVersion: identity.serverVersion,
            scope: object(capture.manifests.schema).scope!, sourceIdentityDigest: capture.source.identityDigest,
            exportedSnapshotIdDigest: sha256(snapshotId), fsync: identity.fsync, synchronousCommit: "on",
            sequenceConsistency: { profile: "single-migration-identity-v1", sealedAndNoOtherBackends: true,
              beforeAfterTypedStateMatched: true, sequenceIsNotMvccFrozen: true } } };
        },
        assertHeld,
      };
      const result = await callback(lock);
      await assertHeld();
      if (frozenCapture) {
        const final = await observation(locked);
        if (final.manifests.frozenBusinessManifestDigest !== frozenCapture.frozenBusinessManifestDigest)
          throw new MaintenanceFailure("source_changed");
        if ((await inspectWriters(final)).length) throw new MaintenanceFailure("source_writer_unknown");
      }
      if (lockedSchemaDigest) {
        const fresh = await connect(sourceConnection, true);
        try {
          await fresh.client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
          const catalog = await readPostgresCatalog(fresh.client, sourceConnection.schema);
          if (digestJson(catalog.schema) !== lockedSchemaDigest) throw new MaintenanceFailure("source_changed");
          await fresh.client.query("COMMIT");
        } finally { await endSession(fresh); }
      }
      if ((await session.client.query("COMMIT")).command !== "COMMIT") throw new MaintenanceFailure("maintenance_lost");
      active = false; return result;
    } catch (error) {
      if (session) await session.client.query("ROLLBACK").catch(() => {});
      throw safeError(error, "snapshot_invalid");
    } finally { active = false; lockActive = false; assertSnapshotLock = undefined; publicBackup = undefined; if (session) await endSession(session); }
  }
  function verifyDatabase(databaseFile: string, expected: DatabaseManifests, restoreDirectory: string): Promise<Json> {
    const operation = verifyDatabaseOperation(databaseFile, expected, restoreDirectory);
    activeVerifications.add(operation);
    void operation.then(() => activeVerifications.delete(operation), () => activeVerifications.delete(operation));
    return operation;
  }
  async function verifyDatabaseOperation(databaseFile: string, expected: DatabaseManifests, restoreDirectory: string): Promise<Json> {
    await assertMutex();
    if (!assertSnapshotLock) throw new MaintenanceFailure("maintenance_lost");
    await assertSnapshotLock();
    if (!verificationConnection || verificationConnection.schema !== sourceConnection.schema) throw new MaintenanceFailure("restore_verification_unavailable");
    if (!same(expected, buildDatabaseManifests("postgres", expected.schema, expected.tables, expected.controlRows))
      || object(expected.schema).profile !== "boardroom-pg16-closed-schema-v1") throw new MaintenanceFailure("snapshot_invalid");
    await privateDirectory(restoreDirectory);
    const isPublic = sourceConnection.schema === "public";
    const target = await connect(verificationConnection, false, isPublic);
    let input: Awaited<ReturnType<typeof open>> | undefined;
    let monitor: ReturnType<typeof setInterval> | undefined, monitorPending: Promise<void> | undefined;
    let targetIdentity: PostgresDatabaseIdentity | undefined, verifiedTargetIdentity: PostgresDatabaseIdentity | undefined;
    const applicationName = `boardroom-public-restore:${randomUUID()}`;
    let publicPipelineStarted = false;
    let publicDeadline: number | undefined;
    const checkPublicDeadline = () => {
      if (publicDeadline !== undefined && performance.now() >= publicDeadline)
        throw new MaintenanceFailure("restore_verification_unavailable");
    };
    const checkSuccess = isPublic ? () => { checkPublicDeadline(); assertOpen(); } : undefined;
    const targetReader = checkedReader(target.client, checkSuccess);
    let assertPublicCurrent: (() => Promise<void>) | undefined;
    let result: Json | undefined;
    try {
      const identity = await readIdentity(target, verificationConnection, false, checkSuccess);
      targetIdentity = identity;
      const sourceIdentity = mutex!.sourceIdentity;
      if (identity.systemIdentifier === sourceIdentity.systemIdentifier
        && (identity.databaseOid === sourceIdentity.databaseOid || identity.databaseName === sourceIdentity.databaseName))
        throw new MaintenanceFailure("restore_verification_unavailable");
      if (identity.fsync !== "on" || identity.inRecovery) throw new MaintenanceFailure("restore_verification_unavailable");
      const verificationKey = createHash("sha256").update(`boardroom-verification-v1:${identity.systemIdentifier}:${identity.databaseOid}`).digest();
      if ((await targetReader.query("SELECT pg_catalog.pg_try_advisory_lock($1::integer,$2::integer) AS held",
        [verificationKey.readInt32BE(0), verificationKey.readInt32BE(4)])).rows[0]?.held !== true)
        throw new MaintenanceFailure("restore_verification_unavailable");
      const assertEmpty = async () => {
        const empty = (await targetReader.query(`SELECT
        NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' AND n.nspname !~ '^pg_temp')
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname NOT IN ('pg_catalog','information_schema'))
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
          WHERE n.nspname NOT IN ('pg_catalog','information_schema'))
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname NOT IN ('public','pg_catalog','information_schema')
          AND nspname !~ '^pg_toast' AND nspname !~ '^pg_temp')
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_extension WHERE extname<>'plpgsql')
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_largeobject_metadata)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend WHERE refclassid='pg_namespace'::regclass
          AND refobjid=(SELECT oid FROM pg_catalog.pg_namespace WHERE nspname='public'))
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_foreign_server)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_publication)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_prepared_xacts WHERE database=current_database())
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity WHERE datid=$1::oid AND pid<>pg_backend_pid()) AS empty`, [identity.databaseOid])).rows[0]?.empty;
      if (empty !== true) throw new MaintenanceFailure("restore_verification_unavailable");
      };
      await assertEmpty();
      if (!same(await readPostgresEnvironment(targetReader), object(expected.schema).environment))
        throw new MaintenanceFailure("restore_verification_unavailable");
      const expectedRoles = object(expected.schema).requiredRoles;
      if (!Array.isArray(expectedRoles)) throw new MaintenanceFailure("snapshot_invalid");
      const roleNames = expectedRoles.map(role => String(object(role).name));
      if (!same(await readPostgresRoles(targetReader, roleNames), expectedRoles)) throw new MaintenanceFailure("restore_verification_unavailable");
      let restoredWith: Json;
      if (isPublic) {
        const backup = publicBackup;
        if (!backup || backup.manifestDigest !== digestJson(expected)) throw new MaintenanceFailure("snapshot_invalid");
        const assertCurrent = async () => {
          await assertMutex(mutex, checkSuccess); if (!assertSnapshotLock) throw new MaintenanceFailure("maintenance_lost"); await assertSnapshotLock(checkSuccess);
          const live = await readIdentity(target, verificationConnection, false, checkSuccess);
          const { schemaOid: _oldSchema, ...oldIdentity } = identity, { schemaOid: _newSchema, ...liveIdentity } = live;
          const held = (await targetReader.query(`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory'
            AND pid=pg_backend_pid() AND database=$1::oid AND classid=$2::oid AND objid=$3::oid AND objsubid=2
            AND mode='ExclusiveLock' AND granted) AS held`, [identity.databaseOid,
          String(verificationKey.readUInt32BE(0)), String(verificationKey.readUInt32BE(4))])).rows[0]?.held;
          if (!same(oldIdentity, liveIdentity) || verifiedTargetIdentity && !same(verifiedTargetIdentity, live) || held !== true) {
            invalidate(); throw new MaintenanceFailure("maintenance_lost");
          }
          assertOpen();
        };
        assertPublicCurrent = assertCurrent;
        monitor = setInterval(() => {
          if (monitorPending) return;
          monitorPending = assertCurrent().catch(invalidate).finally(() => { monitorPending = undefined; });
        }, 500); monitor.unref();
        publicPipelineStarted = true;
        restoredWith = await withPassfile(verificationConnection, restoreDirectory, environment => {
          // Start at the same first native stage as before, never at connection setup or
          // once per child. Keep this deadline after the helper and its file cleanup finish.
          publicDeadline = performance.now() + 300_000;
          return restorePostgresPublic({ archivePath: databaseFile, archiveDigest: backup.sha256, binding: backup.binding, restoreDirectory,
            environment: { ...environment, PGAPPNAME: applicationName }, signal: abort.signal, deadline: publicDeadline, assertCurrent,
            beforeExecute: async () => { await assertCurrent(); await assertEmpty(); },
          });
        });
        checkPublicDeadline();
        await waitForOwnedVerificationBackendExit(target, identity, applicationName, checkPublicDeadline);
        checkPublicDeadline();
      } else {
        const versions = await postgresToolVersions(verificationConnection.childEnvironment, abort.signal, "restore_verification_unavailable");
        input = await open(databaseFile, constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = await input.stat();
        const header = Buffer.alloc(5); await input.read(header, 0, 5, 0);
        if (!info.isFile() || info.nlink !== 1 || info.size <= 5 || (info.mode & 0o077) !== 0 || header.toString("ascii") !== "PGDMP")
          throw new MaintenanceFailure("snapshot_invalid");
        await withPassfile(verificationConnection, restoreDirectory, environment => runPostgresTool("pg_restore",
          [postgresDatabaseArgument(verificationConnection.database), "--format=custom", "--single-transaction", "--exit-on-error", "--no-password"],
          environment, { failure: "restore_verification_unavailable", signal: abort.signal, inputFd: input!.fd }));
        restoredWith = { pgRestore: versions.pgRestore, singleTransaction: true, ownershipPreserved: true, aclPreserved: true };
      }
      await assertMutex(mutex, checkSuccess);
      await assertSnapshotLock(checkSuccess);
      checkPublicDeadline();
      await targetReader.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const restoredIdentity = await readIdentity(target, verificationConnection, true, checkSuccess);
      checkPublicDeadline();
      if (restoredIdentity.databaseOid !== identity.databaseOid || restoredIdentity.systemIdentifier !== identity.systemIdentifier)
        throw new MaintenanceFailure("restore_verification_unavailable");
      verifiedTargetIdentity = restoredIdentity;
      const actual = await readPostgresManifests(targetReader, verificationConnection.schema);
      checkPublicDeadline();
      if (!same(expected, actual)) throw new MaintenanceFailure("snapshot_invalid");
      if ((await targetReader.query("SELECT 1 FROM pg_catalog.pg_stat_activity WHERE datid=$1::oid AND pid<>pg_backend_pid() LIMIT 1", [identity.databaseOid])).rows.length)
        throw new MaintenanceFailure("restore_verification_unavailable");
      checkPublicDeadline();
      if (isPublic) assertOpen();
      const committed = await targetReader.query("COMMIT");
      if (isPublic && committed.command !== "COMMIT") throw new MaintenanceFailure("restore_verification_unavailable");
      checkPublicDeadline();
      result = { formatVersion: 1, engine: "postgres", verificationTargetIdentity: { ...restoredIdentity,
        descriptorDigest: verificationConnection.descriptorDigest }, restoredWith, schemaManifestDigest: actual.schemaManifestDigest,
        fullDataManifestDigest: actual.fullDataManifestDigest, frozenBusinessManifestDigest: actual.frozenBusinessManifestDigest,
        capturedControlManifestDigest: actual.capturedControlManifestDigest, exactFullDataAndControlMatched: true };
    } catch (error) {
      // A deadline discovered by the monitor aborts native work as well. Preserve
      // the timeout failure instead of reclassifying that cancellation as lock loss.
      checkPublicDeadline(); throw safeError(error, "restore_verification_unavailable");
    }
    finally {
      clearInterval(monitor);
      try {
        // The monitor can discover a loss after COMMIT. Its catch invalidates the
        // adapter; consume that result before deciding whether a receipt may escape.
        await monitorPending;
        if (publicPipelineStarted && targetIdentity) await waitForOwnedVerificationBackendExit(target, targetIdentity, applicationName);
        if (result !== undefined && assertPublicCurrent) {
          checkPublicDeadline(); await assertPublicCurrent(); checkPublicDeadline();
        }
      } finally { await input?.close(); await endSession(target); }
    }
    // Failure cleanup may wait beyond the budget for real exits; that never extends
    // the success budget, including monitor completion and target session release.
    checkPublicDeadline();
    if (isPublic) {
      // The target was checked while its advisory lock was still held, then ended
      // deliberately. Recheck the source after that final await and linearize the
      // receipt with synchronous cancellation and deadline checks, with no await left.
      await assertMutex(mutex, checkSuccess);
      if (!assertSnapshotLock) throw new MaintenanceFailure("maintenance_lost");
      await assertSnapshotLock(checkSuccess);
      assertOpen(); checkPublicDeadline();
    }
    if (result === undefined) throw new MaintenanceFailure("restore_verification_unavailable");
    return result;
  }

  /** A native child close is not a PostgreSQL backend exit receipt. Keep cleanup outside the
   * restore deadline and abort signal: cancelling cleanup could release the target too early. */
  async function waitForOwnedVerificationBackendExit(target: Session, identity: PostgresDatabaseIdentity, applicationName: string,
    checkSuccess?: () => void): Promise<void> {
    let cleanup: Client | undefined;
    try {
      while (true) {
        checkSuccess?.();
        const client = cleanup ?? target.client;
        try {
          const current = (await client.query(`SELECT (pg_catalog.pg_control_system()).system_identifier::text AS system_identifier,
            d.oid::text AS database_oid,d.datname AS database_name,inet_server_addr()::text AS address,inet_server_port() AS port,
            pg_postmaster_start_time()=$1::timestamptz AS same_postmaster
            FROM pg_catalog.pg_database d WHERE datname=current_database()`, [identity.postmasterStartedAt])).rows[0];
          if (current?.system_identifier !== identity.systemIdentifier || current.database_oid !== identity.databaseOid
            || current.database_name !== identity.databaseName || current.address !== identity.serverAddress || current.port !== identity.serverPort)
            throw new MaintenanceFailure("maintenance_lost");
          // A confirmed restart of this physical cluster retired every backend from this invocation.
          if (current.same_postmaster === false) return;
          const backends = (await client.query(`SELECT pid,backend_start::text FROM pg_catalog.pg_stat_activity
            WHERE datid=$1::oid AND application_name=$2 AND usename=current_user AND pid<>pg_backend_pid()`,
          [identity.databaseOid, applicationName])).rows;
          if (!backends.length) return;
          for (const backend of backends) await client.query(`SELECT pg_catalog.pg_terminate_backend(pid,1000)
            FROM pg_catalog.pg_stat_activity WHERE datid=$1::oid AND application_name=$2 AND usename=current_user
              AND pid=$3 AND backend_start=$4::timestamptz`, [identity.databaseOid, applicationName, backend.pid, backend.backend_start]);
        } catch (error) {
          checkSuccess?.();
          // No permission/network failure is an exit proof. An unavailable verification server
          // leaves this cleanup pending; it never reports a successful release or retries restore.
          if (cleanup) await cleanup.end().catch(() => {});
          cleanup = new Client({ ...verificationConnection!.clientConfig, application_name: `boardroom-cleanup:${randomUUID()}` });
          cleanup.on("error", () => {});
          try { await cleanup.connect(); }
          catch { await cleanup.end().catch(() => {}); cleanup = undefined; }
          if (error instanceof MaintenanceFailure) invalidate();
        }
        await new Promise<void>(resolve => setTimeout(resolve, 100));
      }
    } finally { if (cleanup) await cleanup.end().catch(() => {}); }
  }
  return { dialect: "postgres", observe, acquireMutex, withSourceLock, inspectWriters, verifyDatabase,
    async close() {
      if (closed) return; closed = true; clearInterval(mutexTimer); abort.abort();
      await waitForPostgresTools(abort.signal);
      await Promise.allSettled([...activeVerifications]);
      await Promise.all([...sessions].map(endSession)); mutex = undefined;
    },
  };
}

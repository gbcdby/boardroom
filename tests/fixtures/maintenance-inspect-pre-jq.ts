import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runMigrations } from "../../src/server/db/migrate.ts";
import { migrations } from "../../src/server/db/migrations/index.ts";
import { SqliteDriver } from "../../src/server/db/drivers/sqlite.ts";
import { resolveBoardroomEnvironment } from "../../src/server/environment.ts";
import { canonicalJson, digestJson, sha256 } from "../../src/server/storage/maintenance/canonical.ts";
import { ArtifactStore } from "../../src/server/storage/maintenance/objects.ts";
import { createPreviewGraph, planMigration, persistMigrationPlan } from "./maintenance-preview-graph.ts";
import { createSqliteMaintenanceAdapter } from "../../src/server/storage/maintenance/sqlite.ts";
import { buildSourceClientsRoster, sourceClientsDigest } from "../../src/server/storage/maintenance/source-clients.ts";
import { registerStorageSourceClient, storageReceiptDigest } from "../../src/server/storage/source-client.ts";
import type { ArtifactRef, ContinueRequest, JournalRecordV2, MaintenanceServiceOptions, OperationMutex, SourceFilesManifest } from "../../src/server/storage/maintenance/types.ts";
import { postgresAuditFixture } from "./maintenance-source-audit-postgres.ts";

/** Actual registration, native locks and committed planned anchor; no capture/Fs producer. */
export async function sqliteInspectFixture(commitFault?: "before" | "after", generation = 1,
  configSource: "file" | "none" = "file") {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "br-inspect-prejq-")));
  const dataDir = path.join(directory, "data"); await mkdir(dataDir);
  const file = path.join(dataDir, "agent-studio.db"), configFile = path.join(directory, "config.json");
  const initial = new Database(file);
  try {
    runMigrations(initial, migrations); initial.pragma("journal_mode=WAL");
    // A carried open epoch is controlled fixture state, not evidence of a previous maintenance run.
    if (generation > 1) initial.prepare("UPDATE storage_maintenance SET owner_generation=?,fence_epoch=?")
      .run(generation - 1, 2 * (generation - 1));
  } finally { initial.close(); }
  if (configSource === "file") await writeFile(configFile, JSON.stringify({ dataDir }));
  const environment = await resolveBoardroomEnvironment({ cwd: directory, homeDir: directory,
    env: { ...(configSource === "file" ? { AGENT_STUDIO_CONFIG: configFile } : { AGENT_STUDIO_DATA_DIR: dataDir }),
      BOARDROOM_HOME: path.join(directory, "home") } });
  assert.equal(environment.databaseDescriptor.kind, "sqlite");
  const adapter = await createSqliteMaintenanceAdapter(environment.databaseDescriptor as never);
  let mutex: OperationMutex | undefined;
  let client: Awaited<ReturnType<typeof registerStorageSourceClient>> | undefined;
  let preview: Awaited<ReturnType<typeof createPreviewGraph>> | undefined;
  try {
    preview = await createPreviewGraph(directory, configSource === "none" ? "production" : "qualified-linux");
    const driver = new SqliteDriver({ dataDir }); await driver.connect();
    client = await registerStorageSourceClient({ db: driver, database: environment.databaseDescriptor, entrypoint: "http" });
    await client.bind({ stopNewWork() {}, async disconnectSessions() {}, async closeMemory() {},
      async stopOwnedRuntime() { return { ownedExits: [], unknownOwners: [] }; },
      async observeOwnedExit() { throw new Error("fixture owns no child"); } });
    const options: MaintenanceServiceOptions = { environment, originalCwd: directory,
      expectedSourceId: environment.inventory.selectedSourceId!, controlRoot: path.join(dataDir, "control"),
      targetRoot: path.join(directory, "target") };
    const plan = await planMigration(options, adapter), reference = await persistMigrationPlan(plan, options, adapter);
    const store = await ArtifactStore.open(reference.controlRoot, plan.source);
    mutex = await adapter.acquireMutex(store.identity, (await adapter.observe()).state);
    const enterRequest: ContinueRequest = { plan: reference, expectedSource: plan.source,
      expectedPhase: null, expectedJournalDigest: null, requestId: "inspect-fixture-enter" };
    let head: ArtifactRef | undefined, commitFailure: unknown, commitFailed = false, faultReached = false;
    const originalExec = Database.prototype.exec;
    if (commitFault) Database.prototype.exec = function (sql: string) {
      if (!faultReached && this.name === file && sql === "COMMIT"
        && (this.prepare("SELECT journal_sequence AS seq FROM storage_maintenance").get() as { seq: number }).seq === 1) {
        faultReached = true;
        if (commitFault === "after") originalExec.call(this, sql);
        throw new Error("fixture enter COMMIT response unavailable");
      }
      return originalExec.call(this, sql);
    };
    try {
      await adapter.withSourceLock("control", async lock => {
        const observed = await lock.observeSourceClients();
        const journal = await store.putJson("journal", { formatVersion: 2, kind: "journal", migrationId: plan.migrationId,
          sequence: 1, previous: null, phase: "planned", event: "enter", requestId: enterRequest.requestId,
          requestDigest: digestJson({ operation: "internal-enter", request: enterRequest }), source: plan.source,
          plan: reference.immutablePlan, fenceEpoch: observed.state.fenceEpoch + 1, ownerGeneration: generation,
          evidence: [], snapshot: null, sourceClients: null, frozen: null });
        head = journal;
        await lock.anchor({ expected: observed.state, admission: "draining", fenceEpoch: observed.state.fenceEpoch + 1,
          ownerGeneration: generation, activeMigrationId: plan.migrationId, planDigest: reference.planDigest,
          controlRootIdentity: { ...store.identity }, mutexIdentity: mutex!.identity, journal, journalSequence: 1 });
      });
    } catch (error) { commitFailure = error; commitFailed = true; }
    finally { Database.prototype.exec = originalExec; }
    if (commitFault) assert(faultReached && commitFailed, "the real source COMMIT fault must run");
    else if (commitFailed) throw commitFailure;
    if (commitFault !== "before") { await client.refresh(); await client.waitForDrain(); }
    return { directory, dataDir, file, configFile, options, adapter, mutex, client, plan, reference, store, head: head!, enterRequest,
      commitFailed, commitFailure, preview,
      async close() { await client!.close(); await mutex!.release(); await adapter.close(); await preview!.close(); await rm(directory, { recursive: true }); } };
  } catch (error) {
    await client?.close(); await mutex?.release(); await adapter.close(); await preview?.close(); await rm(directory, { recursive: true }); throw error;
  }
}

export async function postgresInspectFixture(configSource: "file" | "none" = "file") {
  return postgresAuditFixture("UTF8", { configSource });
}

export function protocolSqliteInspectFixture(commitFault?: "before" | "after", generation = 1) {
  return sqliteInspectFixture(commitFault, generation, process.platform === "darwin" ? "none" : "file");
}
export function protocolPostgresInspectFixture() {
  return postgresInspectFixture(process.platform === "darwin" ? "none" : "file");
}

export function inspectRequest(fixture: { reference: ContinueRequest["plan"]; plan: { source: ContinueRequest["expectedSource"] }; head: ArtifactRef }): ContinueRequest {
  return { plan: fixture.reference, expectedSource: fixture.plan.source, expectedPhase: "planned",
    expectedJournalDigest: fixture.head.sha256, requestId: "inspect-current-prefix" };
}

export async function artifactInventory(store: ArtifactStore): Promise<string[]> {
  const values: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) values.push(`${path.relative(store.root, file)}:${sha256(await readFile(file))}`);
    }
  };
  for (const name of ["plans", "journals", "snapshots"]) {
    try { await walk(path.join(store.root, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return values.sort();
}

export async function appendPlanned(fixture: Awaited<ReturnType<typeof sqliteInspectFixture>>, event: "observation" | "takeover") {
  return fixture.adapter.withSourceLock("control", async lock => {
    const before = await lock.observeSourceClients();
    const previous = await fixture.store.readAnchoredJournal({ ref: before.state.journalRecordRef!, sha256: before.state.journalDigest! });
    const prior = await fixture.store.readJson(previous, "journal") as JournalRecordV2;
    const record = { ...prior, previous, sequence: prior.sequence + 1, event, requestId: `fixture-${event}`,
      requestDigest: digestJson({ fixture: event }), ownerGeneration: prior.ownerGeneration + (event === "takeover" ? 1 : 0) };
    const head = await fixture.store.putJson("journal", record);
    await lock.anchor({ expected: before.state, admission: "draining", fenceEpoch: record.fenceEpoch,
      ownerGeneration: record.ownerGeneration, activeMigrationId: fixture.plan.migrationId, planDigest: fixture.reference.planDigest,
      controlRootIdentity: JSON.parse(canonicalJson(fixture.store.identity)), mutexIdentity: fixture.mutex.identity,
      journal: head, journalSequence: record.sequence });
    return head;
  });
}

export function changeReceiptGeneration(file: string, generation: number) {
  const db = new Database(file);
  try {
    const row = db.prepare("SELECT client_id,db_sessions_json FROM storage_source_clients").get() as { client_id: string; db_sessions_json: string };
    const envelope = JSON.parse(row.db_sessions_json);
    envelope.drainReceipt.ownerGeneration = generation;
    db.prepare("UPDATE storage_source_clients SET db_sessions_json=?,drain_receipt_digest=? WHERE client_id=?")
      .run(JSON.stringify(envelope), storageReceiptDigest(envelope.drainReceipt), row.client_id);
  } finally { db.close(); }
}

/** Valid persisted capture shape solely for refusal tests; these fixed FID bytes confer no Fs qualification. */
export async function appendStructuralCapture(f: Awaited<ReturnType<typeof sqliteInspectFixture>>, cancel: boolean) {
  const incarnation = { type: 1 as const, byteCount: 8 as const, hex: "0123456789abcdef" };
  const entries: SourceFilesManifest["entries"][number][] = [];
  for (const root of f.plan.fileRoots) {
    if (root.expected.absentSegments.length) entries.push({ sourceRoot: root.label, sourceRelativePath: "", kind: "absent",
      identity: null, mode: null, size: null, payload: null, sourceWitness: null });
    else {
      const info = await stat(root.path, { bigint: true }); assert(info.isFile());
      const payload = await f.store.putBytes("source-file-payload", await readFile(root.path));
      entries.push({ sourceRoot: root.label, sourceRelativePath: "", kind: "file", identity: root.expected.existingAncestor,
        mode: (info.mode & 0o777n).toString(8).padStart(3, "0"), size: payload.bytes, payload,
        sourceWitness: { kind: "file", incarnation, change: { mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs), observedBirthtimeNs: null } } });
    }
  }
  const files: SourceFilesManifest = { formatVersion: 2, kind: "source-files", source: f.plan.source, roots: f.plan.fileRoots,
    entries, rootBindings: f.plan.fileRoots.map(root => ({ sourceRoot: root.label, profile: "linux-native-ext4-fid-fsuuid-v1",
      filesystemType: "ext4", filesystemUuidHex: "4".repeat(32), hostIdentityDigest: f.store.identity.hostIdentityDigest,
      anchorPath: root.expected.existingAncestor.path, anchorKind: root.expected.absentSegments.length ? "directory" : "file", anchorHandle: incarnation })),
    sourceMembershipExclusions: ["database-files", "entire-maintenance-control-root", "all-maintenance-artifacts"] };
  const filesRef = await f.store.putJson("source-files", files);
  const capture = await f.adapter.withSourceLock("control", async lock => {
    const raw = await lock.observeSourceClients(), full = await lock.observe();
    const prior = await f.store.readJson(f.head, "journal") as JournalRecordV2;
    const roster = buildSourceClientsRoster({ formatVersion: 1, kind: "source-clients-roster", source: raw.source,
      migrationId: f.plan.migrationId, plan: f.reference.immutablePlan, fenceEpoch: String(raw.state.fenceEpoch),
      receiptGeneration: String(raw.state.ownerGeneration), textEncoding: raw.textEncoding, rows: raw.rows });
    const record: JournalRecordV2 = { ...prior, sequence: 2, previous: f.head, phase: "quiesced", event: "capture",
      requestId: "fixture-capture", sourceClients: roster, frozen: { sourceFilesManifest: filesRef,
        schemaManifestDigest: full.manifests.schemaManifestDigest, frozenBusinessManifestDigest: full.manifests.frozenBusinessManifestDigest,
        guardManifestDigest: raw.state.guardManifestDigest, sourceClientsDigest: sourceClientsDigest(roster) } };
    const head = await f.store.putJson("journal", record);
    await lock.anchor({ expected: raw.state, admission: "sealed", fenceEpoch: raw.state.fenceEpoch, ownerGeneration: raw.state.ownerGeneration,
      activeMigrationId: f.plan.migrationId, planDigest: f.reference.planDigest, controlRootIdentity: { ...f.store.identity },
      mutexIdentity: f.mutex.identity, journal: head, journalSequence: 2 });
    return { head, record };
  });
  if (!cancel) return capture.head;
  return f.adapter.withSourceLock("control", async lock => {
    const raw = await lock.observeSourceClients();
    const head = await f.store.putJson("journal", { ...capture.record, previous: capture.head, sequence: 3,
      event: "cancel_intent", requestId: "fixture-cancel", sourceClients: null, frozen: null });
    await lock.anchor({ expected: raw.state, admission: "sealed", fenceEpoch: raw.state.fenceEpoch, ownerGeneration: raw.state.ownerGeneration,
      activeMigrationId: f.plan.migrationId, planDigest: f.reference.planDigest, controlRootIdentity: { ...f.store.identity },
      mutexIdentity: f.mutex.identity, journal: head, journalSequence: 3 });
    return head;
  });
}

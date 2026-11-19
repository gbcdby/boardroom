import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runMigrations } from "../../src/server/db/migrate.ts";
import { migrations } from "../../src/server/db/migrations/index.ts";
import { SqliteDriver } from "../../src/server/db/drivers/sqlite.ts";
import { resolveBoardroomEnvironment, type DatabaseDescriptor } from "../../src/server/environment.ts";
import { createSqliteMaintenanceAdapter } from "../../src/server/storage/maintenance/sqlite.ts";
import { createPreviewGraph, planMigration, persistMigrationPlan } from "./maintenance-preview-graph.ts";
import { ArtifactStore } from "../../src/server/storage/maintenance/objects.ts";
import { registerStorageSourceClient } from "../../src/server/storage/source-client.ts";
import type { OperationMutex } from "../../src/server/storage/maintenance/types.ts";

/** Actual private source/registration/enter fixture. No capture or Fs qualification. */
export async function sqliteAuditFixture(withClient = true,
  encoding: "UTF-8" | "UTF-16le" | "UTF-16be" = "UTF-8",
  beforePlan?: (input: { database: DatabaseDescriptor; dataDir: string; directory: string }) => Promise<void>,
  configSource: "file" | "none" = "file") {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "br-native-audit-")));
  const dataDir = path.join(directory, "data"); await mkdir(dataDir);
  const file = path.join(dataDir, "agent-studio.db"), configFile = path.join(directory, "config.json");
  const db = new Database(file);
  try { db.pragma(`encoding='${encoding}'`); runMigrations(db, migrations); db.pragma("journal_mode=WAL"); }
  finally { db.close(); }
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
    await beforePlan?.({ database: environment.databaseDescriptor, dataDir, directory });
    if (withClient) {
      const driver = new SqliteDriver({ dataDir }); await driver.connect();
      client = await registerStorageSourceClient({ db: driver, database: environment.databaseDescriptor, entrypoint: "http" });
      await client.bind({ stopNewWork() {}, async disconnectSessions() {}, async closeMemory() {},
        async stopOwnedRuntime() { return { ownedExits: [], unknownOwners: [] }; },
        async observeOwnedExit() { throw new Error("no owned child in this fixture"); } });
    }
    const options = { environment, originalCwd: directory, expectedSourceId: environment.inventory.selectedSourceId!,
      controlRoot: path.join(dataDir, "control"), targetRoot: path.join(directory, "target") };
    const plan = await planMigration(options, adapter), reference = await persistMigrationPlan(plan, options, adapter);
    const store = await ArtifactStore.open(reference.controlRoot, plan.source);
    mutex = await adapter.acquireMutex(store.identity, (await adapter.observe()).state);
    const head = await adapter.withSourceLock("control", async lock => {
      const observed = await lock.observeSourceClients();
      const journal = await store.putJson("journal", { formatVersion: 2, kind: "journal", migrationId: plan.migrationId,
        sequence: 1, previous: null, phase: "planned", event: "enter", requestId: "audit-fixture-enter", requestDigest: "a".repeat(64),
        source: plan.source, plan: reference.immutablePlan, fenceEpoch: observed.state.fenceEpoch + 1, ownerGeneration: 1,
        evidence: [], snapshot: null, sourceClients: null, frozen: null });
      await lock.anchor({ expected: observed.state, admission: "draining", fenceEpoch: observed.state.fenceEpoch + 1, ownerGeneration: 1,
        activeMigrationId: plan.migrationId, planDigest: reference.planDigest, controlRootIdentity: store.identity as never,
        mutexIdentity: mutex!.identity, journal, journalSequence: 1 });
      return journal;
    });
    await client?.refresh(); const receipt = await client?.waitForDrain();
    return { directory, dataDir, file, adapter, mutex, reference, head, receipt, plan, store, options, preview,
      async close() { await client?.close(); await mutex!.release(); await adapter.close(); await preview!.close(); await rm(directory, { recursive: true }); } };
  } catch (error) {
    await client?.close(); await mutex?.release(); await adapter.close(); await preview?.close(); await rm(directory, { recursive: true }); throw error;
  }
}

export function protocolSqliteAuditFixture(...args: [withClient?: boolean,
  encoding?: "UTF-8" | "UTF-16le" | "UTF-16be",
  beforePlan?: Parameters<typeof sqliteAuditFixture>[2]]) {
  return sqliteAuditFixture(args[0], args[1], args[2], process.platform === "darwin" ? "none" : "file");
}

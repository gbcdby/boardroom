import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, readdir, rm, stat, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { runMigrations } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { resolveBoardroomEnvironment } from "../src/server/environment.ts";
import { createSqliteMaintenanceAdapter } from "../src/server/storage/maintenance/sqlite.ts";
import { assertUnqualifiedConfiguration, createPreviewGraph, loadPersistedPlan, persistMigrationPlan, planMigration, revalidatePlan } from "./fixtures/maintenance-preview-graph.ts";
import * as planning from "./fixtures/maintenance-preview-graph.ts";
import { digestJson } from "../src/server/storage/maintenance/canonical.ts";
import { postgresDescriptorDigest } from "../src/server/storage/maintenance/postgres-tools.ts";
import type { MaintenanceAdapter } from "../src/server/storage/maintenance/types.ts";

const platformTest = ["linux", "darwin"].includes(process.platform) ? test : test.skip;
const protocolConfig = process.platform === "darwin" ? "none" : "file";
async function fixture(configSource: "file" | "none" = "file",
  previewMode: "qualified-linux" | "production" = configSource === "file" && process.platform === "linux" ? "qualified-linux" : "production") {
  const dir = await mkdtemp(path.join(path.dirname(process.cwd()), "br-plan-"));
  const preview = await createPreviewGraph(dir, previewMode);
  const dataDir = path.join(dir, "data"); await mkdir(dataDir);
  const file = path.join(dataDir, "agent-studio.db"), configFile = path.join(dir, "config.json");
  const writer = new Database(file); writer.exec("CREATE TABLE plan_observation(value TEXT)");
  runMigrations(writer, migrations); writer.pragma("journal_mode=WAL");
  if (configSource === "file") await writeFile(configFile, JSON.stringify({ dataDir }));
  const environment = await resolveBoardroomEnvironment({ cwd: dir, homeDir: dir, env: {
    ...(configSource === "file" ? { AGENT_STUDIO_CONFIG: configFile } : { AGENT_STUDIO_DATA_DIR: dataDir }),
    BOARDROOM_HOME: path.join(dir, "home") } });
  assert.equal(environment.databaseDescriptor.kind, "sqlite");
  const adapter = await createSqliteMaintenanceAdapter(environment.databaseDescriptor as never);
  const options = { environment, originalCwd: dir, expectedSourceId: environment.inventory.selectedSourceId!, controlRoot: path.join(dataDir, "maintenance-control"), targetRoot: path.join(dir, "target") };
  return { dir, dataDir, file, configFile, writer, adapter, options, preview,
    async close() { await adapter.close(); writer.close(); await preview.close(); await rm(dir, { recursive: true, force: true }); } };
}

platformTest("#152 explicit plan is a readonly observation; persist only writes the selected private control root", async () => {
  const f = await fixture(protocolConfig);
  try {
    const before = await f.adapter.observe(), names = await readdir(f.dataDir);
    const plan = await planMigration(f.options, f.adapter);
    if (protocolConfig === "none") assert.equal(plan.configDigest, digestJson({ configFile: null }));
    assert.equal(plan.source.databaseInstanceId, before.source.databaseInstanceId);
    assert.equal(plan.preview.tableCounts.plan_observation, "0");
    assert.deepEqual(await readdir(f.dataDir), names);
    await assert.rejects(stat(f.options.controlRoot), { code: "ENOENT" });
    await assert.rejects(stat(f.options.targetRoot), { code: "ENOENT" });
    assert.deepEqual((await f.adapter.observe()).state, before.state);
    const ref = await persistMigrationPlan(plan, f.options, f.adapter);
    assert.deepEqual(await loadPersistedPlan(ref, plan.source), plan);
    assert.equal((await stat(f.options.controlRoot)).mode & 0o777, 0o700);
    assert.deepEqual((await f.adapter.observe()).state, before.state);
    await assert.rejects(stat(f.options.targetRoot), { code: "ENOENT" });
  } finally { await f.close(); }
});

platformTest("#152 preview data is not an execution fence; schema/config/target drift requires a new immutable plan", async () => {
  const f = await fixture(protocolConfig);
  try {
    const plan = await planMigration(f.options, f.adapter);
    f.writer.exec("INSERT INTO plan_observation VALUES('normal work after preview')");
    await revalidatePlan(plan, f.options, f.adapter);
    assert.equal(plan.preview.tableCounts.plan_observation, "0");
    const ref = await persistMigrationPlan(plan, f.options, f.adapter);
    await revalidatePlan(await loadPersistedPlan(ref, plan.source), f.options, f.adapter);
    await mkdir(f.options.targetRoot);
    await assert.rejects(revalidatePlan(plan, f.options, f.adapter), /plan_stale/);
    await rm(f.options.targetRoot, { recursive: true });
    if (protocolConfig === "file") {
      await writeFile(f.configFile, JSON.stringify({ dataDir: f.dataDir, port: 12345 }));
      await assert.rejects(revalidatePlan(plan, f.options, f.adapter), /plan_stale/);
    } else {
      const unsupported = await fixture("file", "production");
      try { await assertUnqualifiedConfiguration(unsupported.options, unsupported.adapter); }
      finally { await unsupported.close(); }
    }
  } finally { await f.close(); }
});

platformTest("#152 selection leaves config bytes to the current native preview during revalidation", async () => {
  const f = await fixture();
  try {
    if (process.platform === "darwin") { await assertUnqualifiedConfiguration(f.options, f.adapter); return; }
    const plan = await planMigration(f.options, f.adapter);
    await persistMigrationPlan(plan, f.options, f.adapter);
    await writeFile(f.configFile, JSON.stringify({ dataDir: f.dataDir, port: 12345 }));
    const observation = await planning.observeCapturePlanSelection(plan, f.options, f.adapter);
    assert.deepEqual(observation.source, plan.source);
    await assert.rejects(revalidatePlan(plan, f.options, f.adapter), { code: "plan_stale" });
    await assert.rejects(planning.observeCapturePlanSelection(plan, { ...f.options, originalCwd: f.dataDir }, f.adapter),
      { code: "plan_stale" });
  } finally { await f.close(); }
});

platformTest("#152 plan rejects missing/replaced source, an unrecognized control root and protected destination overlap", async () => {
  const f = await fixture(protocolConfig);
  try {
    await assert.rejects(planMigration({ ...f.options, controlRoot: path.join(f.options.environment.runtimeRoot, "control") }, f.adapter), /control_root_mismatch/);
    const plan = await planMigration(f.options, f.adapter);
    await mkdir(f.options.controlRoot);
    await assert.rejects(persistMigrationPlan(plan, f.options, f.adapter), /plan_stale|control_root_mismatch/);
    await rm(f.options.controlRoot, { recursive: true });
    f.writer.exec("CREATE VIEW schema_changed AS SELECT value FROM plan_observation");
    await assert.rejects(revalidatePlan(plan, f.options, f.adapter), /plan_stale/);
    await rename(f.file, `${f.file}.moved`);
    await assert.rejects(planMigration(f.options, f.adapter), /source_changed/);
    await assert.rejects(stat(f.file), { code: "ENOENT" });
  } finally { await f.close(); }
});

platformTest("#152 plan binds a PG observation to the selected descriptor digest (unit boundary, no PG claim)", async () => {
  const f = await fixture(protocolConfig);
  try {
    const original = await f.adapter.observe();
    const descriptor = { kind: "postgres" as const, connectionString: "postgres://fixture:unused@127.0.0.1/selected" };
    const sourceIdentity = { kind: "postgres", schemaName: "public", descriptorDigest: postgresDescriptorDigest({ ...descriptor,
      connectionString: "postgres://fixture:unused@127.0.0.1/different" }) };
    // Only test the pure trusted-assembly boundary. There is deliberately no PG connect/backup here.
    const adapter = { ...f.adapter, dialect: "postgres", observe: async () => ({ ...original, sourceIdentity,
      source: { ...original.source, kind: "postgres", identityDigest: digestJson(sourceIdentity) }, manifests: { ...original.manifests, dialect: "postgres" } }),
      inspectWriters: async () => [] } as unknown as MaintenanceAdapter;
    const options = { ...f.options, environment: { ...f.options.environment, databaseDescriptor: descriptor } };
    await assert.rejects(planMigration(options, adapter), /source_changed/);
  } finally { await f.close(); }
});

platformTest("#152 production non-null plan refuses unavailable CFP2 qualification without phase or artifact writes", async () => {
  const f = await fixture("file", "production");
  try { await assertUnqualifiedConfiguration(f.options, f.adapter); }
  finally { await f.close(); }
});

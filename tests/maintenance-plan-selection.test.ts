import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as planning from "../src/server/storage/maintenance/plan.ts";
import { digestJson } from "../src/server/storage/maintenance/canonical.ts";
import { buildDatabaseManifests } from "../src/server/storage/maintenance/manifests.ts";
import type { MaintenanceAdapter, MaintenanceServiceOptions, MigrationPlan, SourceObservation } from "../src/server/storage/maintenance/types.ts";

// Pure trusted-assembly selection boundary. No native provider, source lock,
// configuration reader, real database or qualification is supplied by this fixture.
function fixture() {
  const root = "/boardroom-selection-unit", dataDir = `${root}/data`, configFile = `${root}/config.json`;
  const config = { port: 4310, dataDir, heartbeat: { intervalMs: 5000, timeoutMs: 15000 } };
  const sourceIdentity = { kind: "sqlite", sourcePath: dataDir, sqlitePath: `${dataDir}/agent-studio.db`, device: "7", inode: "11" };
  const source = { kind: "sqlite" as const, databaseInstanceId: "1".repeat(32), identityDigest: digestJson(sourceIdentity) };
  const manifests = buildDatabaseManifests("sqlite", { unit: "selection" }, [], { storage_maintenance: [], storage_source_clients: [] });
  let observation: SourceObservation = { source, sourceIdentity, manifests, clients: [], state: {
    databaseInstanceId: source.databaseInstanceId, admission: "open", fenceEpoch: 0, ownerGeneration: 0,
    activeMigrationId: null, planDigest: null, controlRootJson: null, mutexIdentityJson: null,
    journalRecordRef: null, journalDigest: null, journalSequence: 0, protocolVersion: 1, guardManifestDigest: "2".repeat(64) } };
  const planned = (value: string) => ({ path: value, existingAncestor: { path: root, device: "7", inode: "9" },
    absentSegments: [value.slice(root.length + 1)] });
  const plan: MigrationPlan = { formatVersion: 1, kind: "plan", migrationId: "selection-unit", source, sourceIdentity,
    originalCwd: root, originalConfigPath: configFile, configDigest: "3".repeat(64),
    effectiveConfigDigest: digestJson({ ...config, antiLoop: null, memory: null, dbDriver: "sqlite",
      postgresConnectionDigest: null, postgresSchema: null }),
    schemaManifestDigest: manifests.schemaManifestDigest, guardManifestDigest: observation.state.guardManifestDigest,
    controlRoot: planned(`${root}/control`), targetRoot: planned(`${root}/target`),
    fileRoots: [{ label: "config", path: configFile, expected: planned(configFile) },
      { label: "managed-sessions", path: `${root}/runtime/sessions`, expected: planned(`${root}/runtime/sessions`) }],
    preview: { observedAt: "2026-11-20T00:00:00.000Z", dataDigest: manifests.fullDataManifestDigest, tableCounts: {}, clientInventory: [] },
    requiredCapabilities: [], blockers: [] };
  const options = { originalCwd: root, expectedSourceId: "selected-unit", controlRoot: plan.controlRoot.path,
    targetRoot: plan.targetRoot.path, environment: { layoutVersion: 1, startupState: "legacy_found",
      inventory: { selectedSourceId: "selected-unit" }, databaseDescriptor: { kind: "sqlite", sourcePath: dataDir,
        sqlitePath: sourceIdentity.sqlitePath, identity: { device: "7", inode: "11" } },
      config, configFile, runtimeRoot: `${root}/runtime`, workspacesRoot: `${root}/workspaces`, artifactsRoot: `${root}/artifacts` } } as unknown as MaintenanceServiceOptions;
  let observations = 0;
  const adapter = { dialect: "sqlite", observe: async () => { observations++; return observation; } } as MaintenanceAdapter;
  return { plan, options, adapter, get observations() { return observations; }, get observation() { return observation; },
    setObservation(next: SourceObservation) { observation = next; } };
}
const selection = (planning as typeof planning & {
  observeCapturePlanSelection: typeof planning.observeCapturePlanBindings;
}).observeCapturePlanSelection;

test("#152 selection validates immutable values without any source/config/location lookup", async t => {
  const f = fixture(), forbidden = new Error("selection must not resolve or open paths");
  assert.equal(typeof selection, "function", "the separate selection-only entry must exist");
  for (const method of ["lstat", "stat", "open", "realpath", "readdir"] as const)
    t.mock.method(fs.promises, method, async () => { throw forbidden; });
  for (const method of ["lstatSync", "statSync", "openSync", "realpathSync", "readdirSync"] as const)
    t.mock.method(fs, method, () => { throw forbidden; });
  syncBuiltinESMExports();
  try {
    assert.strictEqual(await selection(f.plan, f.options, f.adapter), f.observation);
    assert.equal(f.observations, 1);
    // Location metadata and config bytes are deliberately not claimed by selection.
    const laterMetadata: MigrationPlan = { ...f.plan, configDigest: "4".repeat(64),
      fileRoots: f.plan.fileRoots.map(root => ({ ...root, expected: { ...root.expected,
        existingAncestor: { ...root.expected.existingAncestor, inode: "999" } } })) };
    assert.strictEqual(await selection(laterMetadata, f.options, f.adapter), f.observation);
    assert.equal(f.observations, 2);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("#152 selection rejects request path and effective configuration drift before metadata admission", async () => {
  const f = fixture();
  assert.equal(typeof selection, "function");
  for (const changed of [
    { ...f.options, originalCwd: `${f.options.originalCwd}/other` },
    { ...f.options, controlRoot: `${f.options.controlRoot}-other` },
    { ...f.options, targetRoot: `${f.options.targetRoot}-other` },
    { ...f.options, environment: { ...f.options.environment, configFile: `${f.options.environment.configFile}.other` } },
    { ...f.options, environment: { ...f.options.environment, runtimeRoot: `${f.options.environment.runtimeRoot}-other` } },
    { ...f.options, environment: { ...f.options.environment, config: { ...f.options.environment.config, port: 4311 } } },
  ]) await assert.rejects(selection(f.plan, changed, f.adapter), { code: "plan_stale" });
  assert.equal(f.observations, 6);
});

test("#152 selection observes every call, rejects descriptor/schema/guard/source drift, and permits business preview changes", async () => {
  const f = fixture(), original = f.observation;
  assert.equal(typeof selection, "function");
  f.setObservation({ ...original, manifests: { ...original.manifests, fullDataManifestDigest: "5".repeat(64) } });
  assert.strictEqual(await selection(f.plan, f.options, f.adapter), f.observation);
  for (const changed of [
    { ...original, manifests: { ...original.manifests, schemaManifestDigest: "5".repeat(64) } },
    { ...original, state: { ...original.state, guardManifestDigest: "5".repeat(64) } },
    { ...original, source: { ...original.source, databaseInstanceId: "6".repeat(32) },
      state: { ...original.state, databaseInstanceId: "6".repeat(32) } },
  ]) {
    f.setObservation(changed); await assert.rejects(selection(f.plan, f.options, f.adapter), { code: "plan_stale" });
  }
  f.setObservation({ ...original, sourceIdentity: { ...original.sourceIdentity as object, inode: "12" } });
  await assert.rejects(selection(f.plan, f.options, f.adapter), { code: "source_changed" });
  assert.equal(f.observations, 5);
  await assert.rejects(selection(f.plan, { ...f.options, expectedSourceId: "different" }, f.adapter), { code: "source_changed" });
  assert.equal(f.observations, 5, "invalid selection cannot observe the database");
});

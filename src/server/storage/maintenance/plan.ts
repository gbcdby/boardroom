import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { canonicalizePath } from "../../environment.ts";
import { canonicalJson, digestJson, sha256 } from "./canonical.ts";
import { MaintenanceFailure } from "./error.ts";
import { ArtifactStore } from "./objects.ts";
import { parsePlan } from "./parse.ts";
import { postgresDescriptorDigest } from "./postgres-tools.ts";
import type { FileRoot, MaintenanceAdapter, MaintenanceServiceOptions, MigrationPlan, PersistedPlanRef, PlannedPath, SourceObservation, SourceRef } from "./types.ts";

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const contains = (parent: string, child: string) => parent === child || child.startsWith(`${parent}${path.sep}`);
const overlaps = (a: string, b: string) => contains(a, b) || contains(b, a);

/** Captures an existing inode or a missing suffix without creating directories. */
export async function observePlannedPath(file: string): Promise<PlannedPath> {
  if (!path.isAbsolute(file) || path.resolve(file) !== file || canonicalizePath(file) !== file) throw new MaintenanceFailure("plan_stale");
  let ancestor = file; const absent: string[] = [];
  for (;;) {
    try {
      const info = await lstat(ancestor, { bigint: true });
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) || absent.length > 0 && !info.isDirectory()) throw new MaintenanceFailure("plan_stale");
      return { path: file, existingAncestor: { path: ancestor, device: String(info.dev), inode: String(info.ino) }, absentSegments: absent.reverse() };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(ancestor) === ancestor) throw error;
      absent.push(path.basename(ancestor)); ancestor = path.dirname(ancestor);
    }
  }
}

async function configDigest(file: string | null): Promise<string> {
  if (file === null) return digestJson({ configFile: null });
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 1024n * 1024n) throw new MaintenanceFailure("plan_stale");
    const bytes = await handle.readFile(), after = await handle.stat({ bigint: true }), current = await lstat(file, { bigint: true });
    for (const item of [after, current]) if (item.dev !== before.dev || item.ino !== before.ino || item.size !== before.size
      || item.mtimeNs !== before.mtimeNs || item.ctimeNs !== before.ctimeNs) throw new MaintenanceFailure("plan_stale");
    return sha256(bytes);
  } finally { await handle.close(); }
}

function effectiveConfigDigest(options: MaintenanceServiceOptions): string {
  const config = options.environment.config, database = options.environment.databaseDescriptor;
  // A private in-memory digest binds effective secrets without serializing them into the plan.
  return digestJson({ port: config.port, dataDir: config.dataDir, heartbeat: config.heartbeat,
    antiLoop: config.antiLoop ?? null, memory: config.memory ?? null, dbDriver: database.kind,
    postgresConnectionDigest: database.kind === "postgres" ? sha256(Buffer.from(database.connectionString)) : null,
    postgresSchema: database.kind === "postgres" ? database.schema ?? "public" : null });
}

function assertSelection(options: MaintenanceServiceOptions, adapter: MaintenanceAdapter): void {
  const environment = options.environment;
  if (environment.layoutVersion !== 1 || environment.startupState !== "legacy_found" || environment.inventory.selectedSourceId !== options.expectedSourceId
    || !options.expectedSourceId || environment.databaseDescriptor.kind !== adapter.dialect) throw new MaintenanceFailure("source_changed");
}
function assertObservedDescriptor(options: MaintenanceServiceOptions, observation: SourceObservation): void {
  const descriptor = options.environment.databaseDescriptor;
  if (observation.source.kind !== descriptor.kind || observation.manifests.dialect !== descriptor.kind || digestJson(observation.sourceIdentity) !== observation.source.identityDigest
    || observation.state.databaseInstanceId !== observation.source.databaseInstanceId) throw new MaintenanceFailure("source_changed");
  if (descriptor.kind === "sqlite") {
    if (!descriptor.identity || !same(observation.sourceIdentity, { kind: "sqlite", sourcePath: descriptor.sourcePath,
      sqlitePath: descriptor.sqlitePath, device: descriptor.identity.device, inode: descriptor.identity.inode })) throw new MaintenanceFailure("source_changed");
  } else {
    const identity = observation.sourceIdentity as Record<string, unknown>;
    if (!identity || identity.kind !== "postgres" || identity.schemaName !== (descriptor.schema ?? "public")
      || identity.descriptorDigest !== postgresDescriptorDigest(descriptor)) throw new MaintenanceFailure("source_changed");
  }
}

async function observeLocations(options: MaintenanceServiceOptions): Promise<{ controlRoot: PlannedPath; targetRoot: PlannedPath; fileRoots: FileRoot[] }> {
  const environment = options.environment;
  const control = path.resolve(options.originalCwd, options.controlRoot), target = path.resolve(options.originalCwd, options.targetRoot);
  const repo = path.resolve(import.meta.dirname, "../../../..");
  const forbidden = [repo, environment.runtimeRoot, environment.workspacesRoot, environment.artifactsRoot];
  if (forbidden.some(root => overlaps(root, control)) || overlaps(control, target) || contains(control, environment.config.dataDir)
    || environment.configFile !== null && overlaps(control, environment.configFile)) throw new MaintenanceFailure("control_root_mismatch");
  if (overlaps(target, environment.config.dataDir) || forbidden.some(root => overlaps(root, target))
    || environment.configFile !== null && overlaps(target, environment.configFile)) throw new MaintenanceFailure("target_conflict");
  const controlRoot = await observePlannedPath(control), targetRoot = await observePlannedPath(target);
  // ArtifactStore creates exactly the selected root, never an unreviewed ancestor chain.
  if (controlRoot.absentSegments.length > 1) throw new MaintenanceFailure("control_root_mismatch");
  if (controlRoot.absentSegments.length === 0 && !(await lstat(control)).isDirectory()) throw new MaintenanceFailure("control_root_mismatch");
  if (targetRoot.absentSegments.length === 0 && (!(await lstat(target)).isDirectory() || (await readdir(target)).length > 0)) throw new MaintenanceFailure("target_conflict");
  const fileRoots: FileRoot[] = [];
  if (environment.configFile !== null) fileRoots.push({ label: "config", path: environment.configFile, expected: await observePlannedPath(environment.configFile) });
  const sessions = path.join(environment.runtimeRoot, "sessions");
  fileRoots.push({ label: "managed-sessions", path: sessions, expected: await observePlannedPath(sessions) });
  return { controlRoot, targetRoot, fileRoots };
}

/**
 * Readonly planning over the resolver-selected native adapter. Trusted assembly must create that
 * adapter from options.environment.databaseDescriptor; this is not a request-facing injection API.
 * No connect/migrate/mutex/fence operation occurs here. Writer/workspace/file clearance remains an
 * execution obligation, not a promise derived from this preview.
 */
export async function planMigration(options: MaintenanceServiceOptions, adapter: MaintenanceAdapter): Promise<MigrationPlan> {
  assertSelection(options, adapter);
  const locations = await observeLocations(options);
  const observation = await adapter.observe(); assertObservedDescriptor(options, observation);
  if (locations.controlRoot.absentSegments.length === 0) await ArtifactStore.open(locations.controlRoot.path, observation.source);
  const blockers = [...await adapter.inspectWriters(observation)];
  if (observation.state.admission !== "open") blockers.push({ code: "maintenance_busy", subjectRef: "source-admission" });
  if (process.platform !== "linux") blockers.push({ code: "unsupported_durability", subjectRef: "host-platform" });
  return parsePlan({ formatVersion: 1, kind: "plan", migrationId: randomUUID(), source: observation.source, sourceIdentity: observation.sourceIdentity,
    originalCwd: path.resolve(options.originalCwd), originalConfigPath: options.environment.configFile,
    configDigest: await configDigest(options.environment.configFile), effectiveConfigDigest: effectiveConfigDigest(options),
    schemaManifestDigest: observation.manifests.schemaManifestDigest, guardManifestDigest: observation.state.guardManifestDigest, ...locations,
    preview: { observedAt: new Date().toISOString(), dataDigest: observation.manifests.fullDataManifestDigest,
      tableCounts: Object.fromEntries(observation.manifests.tables.map(table => [table.name, table.count])), clientInventory: observation.clients },
    requiredCapabilities: ["physical-source-lock", "all-source-writers-quiesced", "source-files-inventory", "known-workspace-root-clearance", "filesystem-durable-publication", "actual-database-restore"], blockers });
}

/** Immutable binding check only: successful revalidation is never write/seal authorization. */
export async function revalidatePlan(planValue: MigrationPlan, options: MaintenanceServiceOptions, adapter: MaintenanceAdapter): Promise<SourceObservation> {
  const plan = parsePlan(planValue); assertSelection(options, adapter);
  const observation = await adapter.observe(); assertObservedDescriptor(options, observation);
  const locations = await observeLocations(options);
  let controlMatches = same(locations.controlRoot, plan.controlRoot);
  if (!controlMatches && plan.controlRoot.absentSegments.length === 1 && locations.controlRoot.absentSegments.length === 0
    && locations.controlRoot.path === plan.controlRoot.path) {
    await ArtifactStore.open(plan.controlRoot.path, plan.source);
    const ancestor = await observePlannedPath(plan.controlRoot.existingAncestor.path);
    controlMatches = same(ancestor.existingAncestor, plan.controlRoot.existingAncestor) && ancestor.absentSegments.length === 0;
  }
  if (!same(observation.source, plan.source) || !same(observation.sourceIdentity, plan.sourceIdentity)
    || observation.manifests.schemaManifestDigest !== plan.schemaManifestDigest || observation.state.guardManifestDigest !== plan.guardManifestDigest
    || plan.originalCwd !== path.resolve(options.originalCwd) || plan.originalConfigPath !== options.environment.configFile
    || plan.configDigest !== await configDigest(plan.originalConfigPath) || plan.effectiveConfigDigest !== effectiveConfigDigest(options)
    || !controlMatches || !same(locations.targetRoot, plan.targetRoot) || !same(locations.fileRoots, plan.fileRoots)) throw new MaintenanceFailure("plan_stale");
  return observation;
}

/** Explicit persistence creates P only. There is no phase, DB binding, journal or activation here. */
export async function persistMigrationPlan(planValue: MigrationPlan, options: MaintenanceServiceOptions, adapter: MaintenanceAdapter): Promise<PersistedPlanRef> {
  const plan = parsePlan(planValue); await revalidatePlan(plan, options, adapter);
  const store = await ArtifactStore.create(plan.controlRoot.path, plan.source);
  const immutablePlan = await store.putJson("plan", plan);
  return { migrationId: plan.migrationId, planDigest: immutablePlan.sha256, immutablePlan, controlRoot: store.root };
}

export async function loadPersistedPlan(reference: PersistedPlanRef, expectedSource: SourceRef): Promise<MigrationPlan> {
  const store = await ArtifactStore.open(reference.controlRoot, expectedSource);
  const plan = parsePlan(await store.readJson(reference.immutablePlan, "plan"));
  if (plan.migrationId !== reference.migrationId || reference.planDigest !== reference.immutablePlan.sha256
    || plan.controlRoot.path !== store.root || !same(plan.source, expectedSource)) throw new MaintenanceFailure("plan_stale");
  return plan;
}

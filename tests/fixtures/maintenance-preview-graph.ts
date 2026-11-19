import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { MaintenanceAdapter, MaintenanceServiceOptions } from "../../src/server/storage/maintenance/types.ts";
import { SourceFilesFailure } from "../../src/server/storage/maintenance/source-files.ts";

type Plan = typeof import("../../src/server/storage/maintenance/plan.ts");
type Enter = typeof import("../../src/server/storage/maintenance/enter.ts");
type Inspect = typeof import("../../src/server/storage/maintenance/inspect.ts");
type PreJq = typeof import("../../src/server/storage/maintenance/inspect-pre-jq.ts");
type Service = typeof import("../../src/server/storage/maintenance/service.ts");
const originalDirectory = fileURLToPath(new URL("../../src/server/storage/maintenance/", import.meta.url));
const originalProfile = new URL("./maintenance-source-files.ts", import.meta.url);
const defaultSourceFiles = new URL("../../src/server/storage/maintenance/source-files.ts", import.meta.url).href;

interface PreviewState {
  readonly handles: Set<unknown>;
  readonly events: string[];
  hook: (operation: string, file: string, value?: unknown) => void;
}
interface AttachedPreview {
  readonly state: PreviewState;
  close(): void;
}
interface PreviewGraph {
  readonly directory: string;
  readonly root: string;
  readonly planUrl: string;
  readonly state: PreviewState | null;
  readonly plan: Plan;
  readonly enter: Enter;
  readonly inspect: Inspect;
  readonly preJq: PreJq;
  readonly service: Service;
  close(): Promise<void>;
}
const graphs = new Map<string, PreviewGraph>();

function rewrite(code: string, original: string, names: ReadonlySet<string>, destination: string): string {
  const target = (relative: string) => pathToFileURL(relative.startsWith("./") && names.has(relative.slice(2))
    ? path.join(destination, relative.slice(2)) : path.resolve(path.dirname(original), relative)).href;
  return code.replace(/from "(\.{1,2}\/[^"\n]+)"/g, (_, relative: string) => "from " + JSON.stringify(target(relative)))
    .replace(/import\("(\.{1,2}\/[^"\n]+)"\)/g, (_, relative: string) => "import(" + JSON.stringify(target(relative)) + ")")
    // Relocation must not change the product's repository exclusion boundary.
    .replaceAll("import.meta.dirname", JSON.stringify(path.dirname(original)));
}

/** TEST ONLY. Own a separate module/state for CFP2 preview over this fixture's
 * existing private directory. The original legacy S fixture/state is untouched.
 * Native R/F owners/read/close are real; qualification, tail and health facts
 * remain explicitly synthetic. Production has no registry override. */
export async function attachPreviewModules(destination: string, directory: string,
  sourceFilesUrl = defaultSourceFiles): Promise<AttachedPreview> {
  assert.equal(await realpath(directory), directory);
  const info = await stat(directory);
  assert(info.isDirectory() && info.uid === process.getuid!(), "preview source is this test's real private directory");
  const original = fileURLToPath(originalProfile);
  let bridge = rewrite(await readFile(original, "utf8"), original, new Set(), destination)
    .replaceAll("import.meta.url", JSON.stringify(originalProfile.href));
  bridge += `\nexport async function attachPreviewDirectory(directory: string) {
    await prepareNativeFixture();
    if (states.has(directory)) throw new Error("duplicate private preview root");
    const state: State = { directory, handles: new Set(), roots: new WeakSet(), events: [],
      identities: new Map(), attributes: new Map(), flags: new Map(), hook: () => {},
      windows: 0, maxHandles: 0, health: "0\\n", mountDelta: 0n, prepare: true };
    states.set(directory, state);
    return { state, close() {
      if (state.handles.size) throw new Error("preview native owners remain active");
      states.delete(directory);
    } };
  }\n`;
  const profileFile = path.join(destination, "preview-source-profile.ts"), profileUrl = pathToFileURL(profileFile).href;
  await writeFile(profileFile, bridge, { mode: 0o600 });
  const profile = await import(profileUrl) as { attachPreviewDirectory(directory: string): Promise<AttachedPreview> };
  const attached = await profile.attachPreviewDirectory(directory);
  const names = new Set(["plan.ts", "source-file-preview.ts"]);
  try {
    for (const name of names) {
      const original = path.join(originalDirectory, name);
      let code = await readFile(original, "utf8");
      if (name === "source-file-preview.ts") code = code
        .replaceAll('from "./source-file-native.ts"', "from " + JSON.stringify(profileUrl))
        .replaceAll('from "./source-file-profile.ts"', "from " + JSON.stringify(profileUrl))
        .replaceAll('from "./source-files.ts"', "from " + JSON.stringify(sourceFilesUrl));
      await writeFile(path.join(destination, name), rewrite(code, original, names, destination), { mode: 0o600 });
    }
    return attached;
  } catch (error) { attached.close(); throw error; }
}

/** These entry copies differ only in import locations. Their native source-file
 * consumers still use the actual empty production qualification registry; only
 * the preview provider is connected to the declared engineering fixture. */
export async function createPreviewGraph(directory: string,
  mode: "qualified-linux" | "production" = "qualified-linux"): Promise<PreviewGraph> {
  assert(!graphs.has(directory), "one preview graph owns each private directory");
  if (mode === "production") {
    // Explicit config-null protocol fixtures use the unchanged production modules.
    // A non-null call through this graph still reaches the empty native registry.
    const graph: PreviewGraph = { directory: "", root: directory, planUrl: new URL("../../src/server/storage/maintenance/plan.ts", import.meta.url).href,
      state: null, plan: await import("../../src/server/storage/maintenance/plan.ts"),
      enter: await import("../../src/server/storage/maintenance/enter.ts"),
      inspect: await import("../../src/server/storage/maintenance/inspect.ts"),
      preJq: await import("../../src/server/storage/maintenance/inspect-pre-jq.ts"),
      service: await import("../../src/server/storage/maintenance/service.ts"),
      async close() { graphs.delete(directory); } };
    graphs.set(directory, graph); return graph;
  }
  assert.equal(process.platform, "linux", "qualified preview fixture uses the actual Linux R/F owner");
  const destination = await mkdtemp(path.join(process.cwd(), ".agent-output-preview-graph-"));
  let attached: AttachedPreview | undefined;
  try {
    attached = await attachPreviewModules(destination, directory);
    const names = new Set(["plan.ts", "enter.ts", "inspect.ts", "inspect-pre-jq.ts", "service.ts"]);
    for (const name of names) if (name !== "plan.ts") {
      const original = path.join(originalDirectory, name);
      await writeFile(path.join(destination, name), rewrite(await readFile(original, "utf8"), original, names, destination), { mode: 0o600 });
    }
    const url = (name: string) => pathToFileURL(path.join(destination, name)).href;
    const graph: PreviewGraph = { directory: destination, root: directory, planUrl: url("plan.ts"), state: attached.state,
      plan: await import(url("plan.ts")) as Plan, enter: await import(url("enter.ts")) as Enter,
      inspect: await import(url("inspect.ts")) as Inspect, preJq: await import(url("inspect-pre-jq.ts")) as PreJq,
      service: await import(url("service.ts")) as Service,
      async close() { attached!.close(); graphs.delete(directory); await rm(destination, { recursive: true }); } };
    graphs.set(directory, graph); return graph;
  } catch (error) { attached?.close(); await rm(destination, { recursive: true, force: true }); throw error; }
}

/** Actual production refusal, with no synthetic registry or native replacement.
 * This is the non-null branch on Darwin and the empty-registry branch on Linux. */
export async function assertUnqualifiedConfiguration(options: MaintenanceServiceOptions, adapter: MaintenanceAdapter) {
  assert(options.environment.configFile, "the capability test must select a real non-null file");
  if (process.platform === "linux") {
    const { sourceFilesFixture } = await import("./maintenance-source-files.ts");
    const builder = await sourceFilesFixture();
    await builder.close(); // Build the real binding; production has no qualification override.
  }
  const before = await adapter.observe();
  for (const root of [options.controlRoot, options.targetRoot]) await assert.rejects(stat(root), { code: "ENOENT" });
  const { planMigration } = await import("../../src/server/storage/maintenance/plan.ts");
  await assert.rejects(planMigration(options, adapter), error => error instanceof SourceFilesFailure
    && error.code === "backup_capability_unavailable");
  assert.deepEqual(await adapter.observe(), before, "non-null refusal cannot change source admission/state");
  for (const root of [options.controlRoot, options.targetRoot]) await assert.rejects(stat(root), { code: "ENOENT" });
}

/** Preserve a real non-null refusal alongside an explicitly null protocol fixture. */
export async function assertProtocolNonNullRefusal(options: MaintenanceServiceOptions, adapter: MaintenanceAdapter) {
  const file = path.join(options.originalCwd, "unsupported-preview-config.json"), database = options.environment.databaseDescriptor;
  await writeFile(file, JSON.stringify({ dataDir: options.environment.config.dataDir,
    ...(database.kind === "postgres" ? { dbDriver: "postgres", pgConnectionString: database.connectionString } : {}) }), { mode: 0o600, flag: "wx" });
  try {
    const { resolveBoardroomEnvironment } = await import("../../src/server/environment.ts");
    const environment = await resolveBoardroomEnvironment({ cwd: options.originalCwd, homeDir: options.originalCwd,
      env: { AGENT_STUDIO_CONFIG: file, BOARDROOM_HOME: path.join(options.originalCwd, "home") } });
    await assertUnqualifiedConfiguration({ ...options, environment,
      controlRoot: path.join(options.environment.config.dataDir, "unqualified-control"),
      targetRoot: path.join(options.originalCwd, "unqualified-target") }, adapter);
  } finally { await rm(file); }
}

function selected(options: MaintenanceServiceOptions): PreviewGraph {
  const graph = graphs.get(options.originalCwd) ?? [...graphs.values()].find(item =>
    options.environment.config.dataDir.startsWith(item.root + path.sep));
  assert(graph, "only an explicitly attached private fixture may consume synthetic preview qualification");
  return graph;
}

// Fixed delegates select the original product implementation in that fixture's
// isolated graph. They do not synthesize a digest, return PASS, bypass a failure,
// or supply a provider/qualification hook to any production function.
export const planMigration: Plan["planMigration"] = (options, adapter) => selected(options).plan.planMigration(options, adapter);
export const persistMigrationPlan: Plan["persistMigrationPlan"] = (plan, options, adapter) => selected(options).plan.persistMigrationPlan(plan, options, adapter);
export const revalidatePlan: Plan["revalidatePlan"] = (plan, options, adapter) => selected(options).plan.revalidatePlan(plan, options, adapter);
export const enterMaintenance: Enter["enterMaintenance"] = (options, request) => selected(options).enter.enterMaintenance(options, request);
export const stageControllerEnter: Enter["stageControllerEnter"] = (scope, lock, options) => selected(options).enter.stageControllerEnter(scope, lock, options);
export const inspectMaintenance: Inspect["inspectMaintenance"] = (options, request) => selected(options).inspect.inspectMaintenance(options, request);
export const inspectPreJq: PreJq["inspectPreJq"] = (options, adapter, mutex, lock, request) => selected(options).preJq.inspectPreJq(options, adapter, mutex, lock, request);
export const runMaintenanceServiceCommand: Service["runMaintenanceServiceCommand"] = (options, request) => selected(options).service.runMaintenanceServiceCommand(options, request);
export { loadPersistedPlan, observeCapturePlanSelection, observeCapturePlanBindings, observePlannedPath } from "../../src/server/storage/maintenance/plan.ts";

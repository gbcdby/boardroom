import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";
import { recoveryFixture } from "./maintenance-capture-recovery.ts";
import type { enterFixture } from "./maintenance-enter.ts";
import type { ControllerOwner } from "../../src/server/storage/maintenance/controller-owner.ts";
import type { ControllerCommandScope } from "../../src/server/storage/maintenance/controller-write.ts";
import type { ArtifactStore } from "../../src/server/storage/maintenance/objects.ts";
import type { ContinueRequest, MaintenanceCommand, MaintenanceResult, MaintenanceServiceOptions, OperationMutex, SourceLock } from "../../src/server/storage/maintenance/types.ts";

type OwnerModule = typeof import("../../src/server/storage/maintenance/controller-owner.ts");
export interface ServiceEvent {
  readonly event: "owner" | "mutex-acquired" | "mutex-release-begin" | "mutex-release-end"
    | "source-begin" | "callback-end" | "source-end" | "adapter-close-begin" | "adapter-close-end";
  readonly owner: ControllerOwner;
  readonly stage?: number;
  readonly kind?: "control" | "snapshot";
  readonly lock?: SourceLock;
}
interface State {
  readonly owners: OwnerModule;
  readonly events: ServiceEvent[];
  readonly scopes: ControllerCommandScope[];
  onOwner?: (owner: ControllerOwner) => void;
  beforeSource?: (lock: SourceLock, stage: number, kind: "control" | "snapshot") => Promise<void> | void;
  afterSourceClose?: (lock: SourceLock, stage: number, kind: "control" | "snapshot") => Promise<void> | void;
}
const states = new Map<string, State>();
const ownerStates = new WeakMap<ControllerOwner, State>();
function stateFor(owner: ControllerOwner): State { const state = ownerStates.get(owner); assert(state); return state; }
export function recordServiceCommandScope(root: string, scope: ControllerCommandScope): void {
  const state = states.get(root); assert(state); state.scopes.push(scope);
}

/** Actual repository CLI, fixed executor and production service. No isolated
 * service, preload, native/profile fixture or substitute worker is used here. */
export function runActualMaintenanceCli(source: Pick<Awaited<ReturnType<typeof enterFixture>>,
  "directory" | "dataDir" | "configFile" | "options" | "request">,
  command: "execute" | "resume" | "cancel" | "inspect", request: ContinueRequest = source.request) {
  const { plan, expectedSource } = request;
  const args = [fileURLToPath(new URL("../../scripts/storage-maintenance.ts", import.meta.url)), command,
    "--expected-source-id", source.options.expectedSourceId, "--control-root", source.options.controlRoot,
    "--target-root", source.options.targetRoot, "--data-dir", source.dataDir,
    "--migration-id", plan.migrationId, "--plan-digest", plan.planDigest, "--plan-bytes", plan.immutablePlan.bytes,
    "--expected-source-kind", expectedSource.kind, "--expected-database-instance-id", expectedSource.databaseInstanceId,
    "--expected-source-identity-digest", expectedSource.identityDigest];
  if (command !== "inspect") args.push("--request-id", request.requestId, "--expected-phase", request.expectedPhase ?? "none",
    "--expected-journal-digest", request.expectedJournalDigest ?? "none");
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("AGENT_STUDIO_") || ["BOARDROOM_HOME", "NODE_OPTIONS", "NODE_PATH"].includes(key)) delete env[key];
  const result = spawnSync(process.execPath, args, { cwd: source.directory,
    env: { ...env, HOME: source.directory, AGENT_STUDIO_CONFIG: source.configFile, BOARDROOM_HOME: path.join(source.directory, "home") },
    encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.error, undefined); assert.equal(result.signal, null); return result;
}

/** Delegates in a private test module graph observe the service's own factory.
 * They never supply a pre-created adapter, mutex, scope, proof or success bit. */
export async function createControllerOwner(...args: Parameters<OwnerModule["createControllerOwner"]>) {
  const state = states.get(args[1].controlRoot.path); assert(state);
  const owner = await state.owners.createControllerOwner(...args); ownerStates.set(owner, state);
  state.events.push({ event: "owner", owner });
  const acquire = owner.adapter.acquireMutex.bind(owner.adapter);
  owner.adapter.acquireMutex = async (...args) => {
    const mutex = await acquire(...args), release = mutex.release.bind(mutex);
    state.events.push({ event: "mutex-acquired", owner });
    mutex.release = async () => {
      state.events.push({ event: "mutex-release-begin", owner }); await release();
      state.events.push({ event: "mutex-release-end", owner });
    };
    return mutex;
  };
  let stage = 0;
  const withSourceLock = owner.adapter.withSourceLock.bind(owner.adapter);
  owner.adapter.withSourceLock = async <T>(kind: "control" | "snapshot", consume: (lock: SourceLock) => Promise<T>): Promise<T> => {
    const current = ++stage; let original: SourceLock | undefined;
    state.events.push({ event: "source-begin", owner, stage: current, kind });
    const result = await withSourceLock(kind, async lock => {
      original = lock; await state.beforeSource?.(lock, current, kind);
      const value = await consume(lock);
      state.events.push({ event: "callback-end", owner, stage: current, kind, lock }); return value;
    });
    assert(original);
    state.events.push({ event: "source-end", owner, stage: current, kind, lock: original });
    await state.afterSourceClose?.(original, current, kind);
    return result;
  };
  const close = owner.adapter.close.bind(owner.adapter);
  owner.adapter.close = async () => {
    state.events.push({ event: "adapter-close-begin", owner }); await close();
    state.events.push({ event: "adapter-close-end", owner });
  };
  state.onOwner?.(owner); return owner;
}
export function awaitControllerAdmission(owner: ControllerOwner) { return stateFor(owner).owners.awaitControllerAdmission(owner); }
export function rememberControllerStore(owner: ControllerOwner, store: ArtifactStore) {
  return stateFor(owner).owners.rememberControllerStore(owner, store);
}
export function recordControllerFailure(owner: ControllerOwner, failures: unknown[], error: unknown) {
  return stateFor(owner).owners.recordControllerFailure(owner, failures, error);
}
export function finishControllerOwner(owner: ControllerOwner, mutex: OperationMutex | undefined,
  lock: SourceLock | undefined, failures: unknown[], subject: string) {
  return stateFor(owner).owners.finishControllerOwner(owner, mutex, lock, failures, subject);
}
export function finishControllerCommandOwner(owner: ControllerOwner, mutex: OperationMutex | undefined,
  lock: SourceLock | undefined, failures: unknown[], subject: string) {
  return stateFor(owner).owners.finishControllerCommandOwner(owner, mutex, lock, failures, subject);
}

/** Test-only process assembly. It installs observation delegates around the
 * child's actual owner factory; no owner, mutex, scope or native fact is sent. */
export async function attachServiceChildGraph(directory: string, controlRoot: string) {
  const owners = await import(pathToFileURL(path.join(directory, "controller-owner.ts")).href) as OwnerModule;
  states.set(controlRoot, { owners, events: [], scopes: [] });
  return await import(pathToFileURL(path.join(directory, "service.ts")).href) as typeof import("../../src/server/storage/maintenance/service.ts");
}

/** Runs the original service graph in a real child. Its result is deliberately
 * separated from actual exit/stdio close. Only the established synthetic Fs
 * profile is attached to the same private files; all controller identities,
 * transactions, archive/restore and owner cleanup are produced by that child. */
export async function startServiceChild(source: { directory: string; moduleDirectory: string; options: MaintenanceServiceOptions },
  command: MaintenanceCommand) {
  const directory = await mkdtemp(path.join(source.moduleDirectory, "child-"));
  const originalProfile = new URL("./maintenance-source-files.ts", import.meta.url);
  const profile = await readFile(originalProfile, "utf8");
  const start = profile.indexOf("  const state: State = { directory, handles:");
  const end = profile.indexOf("  const resetReadTimes =", start);
  assert(start >= 0 && end > start);
  const relocated = profile.replace(/from "(\.{1,2}\/[^"\n]+)"/g,
    (_, relative: string) => "from " + JSON.stringify(new URL(relative, originalProfile).href));
  const profilePath = path.join(directory, "attached-source-profile.ts");
  await writeFile(profilePath, relocated + "\nexport function attachSourceFileFixture(directory: string) {\n"
    + profile.slice(start, end) + "}\n", { mode: 0o600 });
  const before = pathToFileURL(source.moduleDirectory + path.sep).href, after = pathToFileURL(directory + path.sep).href;
  for (const file of await readdir(source.moduleDirectory, { withFileTypes: true })) if (file.isFile()) {
    let code = (await readFile(path.join(source.moduleDirectory, file.name), "utf8")).replaceAll(before, after);
    if (file.name === "source-files.ts") code = code.replaceAll(originalProfile.href, pathToFileURL(profilePath).href);
    await writeFile(path.join(directory, file.name), code, { mode: 0o600 });
  }
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import { attachServiceChildGraph } from ${JSON.stringify(import.meta.url)};
    import { attachSourceFileFixture } from ${JSON.stringify(pathToFileURL(profilePath).href)};
    let done = false, stopping = false;
    process.on('message', value => { if (value === 'stop') { stopping = true; if (done && process.connected) process.disconnect(); } });
    process.once('message', async value => {
      try {
        attachSourceFileFixture(${JSON.stringify(source.directory)});
        const service = await attachServiceChildGraph(${JSON.stringify(directory)}, value.command.request.plan.controlRoot);
        const result = await service.runMaintenanceServiceCommand(value.options, value.command);
        done = true;
        process.send({ kind: 'result', result, pid: process.pid }, () => { if (stopping && process.connected) process.disconnect(); });
      } catch (error) {
        done = true; process.exitCode = 1;
        process.send({ kind: 'failure', code: typeof error?.code === 'string' ? error.code : 'unclassified',
          subject: typeof error?.subjectRef === 'string' ? error.subjectRef : null }, () => { if (process.connected) process.disconnect(); });
      }
    });
  `], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stdout = "", stderr = "";
  child.stdout!.on("data", value => { stdout = (stdout + String(value)).slice(-16_384); });
  child.stderr!.on("data", value => { stderr = (stderr + String(value)).slice(-16_384); });
  type Exit = { code: number | null; signal: NodeJS.Signals | null };
  const exited = new Promise<Exit>(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  const closed = new Promise<Exit>(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  const failed = new Promise<never>((_resolve, reject) => child.once("error", reject));
  void failed.catch(() => undefined);
  let stopping: Promise<{ exit: Exit; close: Exit; stdout: string; stderr: string }> | undefined;
  const stop = () => stopping ??= (async () => {
    if (child.connected) child.send("stop");
    const exit = await Promise.race([exited, failed]), close = await Promise.race([closed, failed]);
    assert.deepEqual(exit, { code: 0, signal: null }); assert.deepEqual(close, exit);
    return { exit, close, stdout, stderr };
  })();
  try {
    const message = new Promise<unknown>(resolve => child.once("message", resolve));
    child.send({ options: source.options, command });
    const value = await Promise.race([message, failed, closed.then(result => {
      throw new Error(`service child closed before result: ${result.code}/${result.signal}: ${stderr}`);
    })]);
    assert(value !== null && typeof value === "object");
    const packet = value as { kind?: string; result?: MaintenanceResult; pid?: number; code?: string; subject?: string };
    assert.equal(packet.kind, "result", `actual service child failed: ${packet.code}/${packet.subject}`);
    assert(packet.result); assert.equal(packet.pid, child.pid); assert.equal(child.exitCode, null);
    return { result: packet.result, pid: child.pid!, exited, closed, stop };
  } catch (error) {
    const failures: unknown[] = [error];
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    try { await closed; } catch (failure) { failures.push(failure); }
    try { await rm(directory, { recursive: true, force: true }); } catch (failure) { failures.push(failure); }
    if (failures.length === 1) throw error;
    throw new AggregateError(failures, "service child fixture cleanup failed", { cause: error });
  }
}

/** The source starts at a real legacy planned anchor. Each tested public resume
 * creates its own actual owner and mutex, then executes the untouched C3 graph.
 * Only the established Fs native/profile fixture is synthetic. Neither this
 * fixture nor any successful restore constitutes production qualification. */
export async function serviceFixture(kind: "sqlite" | "postgres" = "sqlite",
  options: NonNullable<Parameters<typeof recoveryFixture>[1]> = {}) {
  assert.equal(process.platform, "linux", "this engineering Fs fixture uses the actual Linux source-FD bridge");
  const source = await recoveryFixture(kind, options);
  let directory: string | undefined;
  let admin: Client | undefined, target: { name: string; oid: string | null } | undefined;
  let serviceOptions: MaintenanceServiceOptions = source.options;
  const dropTarget = async () => {
    if (!target) return;
    assert(admin);
    const current = (await admin.query("SELECT oid::text AS oid FROM pg_database WHERE datname=$1", [target.name])).rows;
    if (target.oid === null && current.length === 0) { target = undefined; return; }
    assert(target.oid !== null, "private target identity was not confirmed; preserve the original initialization failure and refuse an unbound DROP");
    assert.deepEqual(current, [{ oid: target.oid }], "the exact private verification database must still be owned");
    assert.equal((await admin.query("SELECT count(*)::text AS count FROM pg_stat_activity WHERE datid=$1::oid", [target.oid])).rows[0].count, "0");
    await admin.query(`DROP DATABASE "${target.name}"`); target = undefined;
  };
  const freshVerificationTarget = async () => {
    if (kind !== "postgres") return;
    assert(process.env.AGENT_STUDIO_PG_TEST_URL && source.descriptor.kind === "postgres");
    if (!admin) { admin = new Client({ connectionString: process.env.AGENT_STUDIO_PG_TEST_URL }); admin.on("error", () => {}); await admin.connect(); }
    await dropTarget();
    const name = `br_c3_service_${randomUUID().replaceAll("-", "")}`, encoding = options.postgresEncoding ?? "UTF8";
    assert(["UTF8", "LATIN1", "SQL_ASCII"].includes(encoding));
    target = { name, oid: null };
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0 ENCODING '${encoding}' LC_COLLATE 'C' LC_CTYPE 'C'`);
    const oid = (await admin.query("SELECT oid::text AS oid FROM pg_database WHERE datname=$1", [name])).rows[0]?.oid;
    assert(typeof oid === "string"); target = { name, oid };
    const url = new URL(process.env.AGENT_STUDIO_PG_TEST_URL); url.pathname = `/${name}`;
    assert.notEqual(url.pathname, new URL(source.descriptor.connectionString).pathname);
    serviceOptions = { ...source.options, postgresVerification: { kind: "postgres", connectionString: url.toString() } };
  };
  const names = new Set(["service.ts", "cancel.ts", "verified-maintenance.ts", "controller-owner.ts", "enter.ts", "inspect.ts",
    "controller-write.ts", "control-sql.ts", "control-sql-write.ts", "sqlite.ts", "postgres.ts", "snapshot-bundle.ts",
    "verify-bundle.ts", "snapshot-ready.ts", "verification-source-client-binding.ts", "restore-authorization.ts", "source-files.ts"]);
  try {
    await freshVerificationTarget();
    directory = await mkdtemp(path.join(process.cwd(), ".agent-output-c3-service-"));
    const copyDirectory = directory;
    for (const name of names) {
      const original = fileURLToPath(new URL("../../src/server/storage/maintenance/" + name, import.meta.url));
      let code = await readFile(original, "utf8");
      if (name === "source-files.ts") {
        const profile = new URL("./maintenance-source-files.ts", import.meta.url).href;
        code = code.replaceAll('from "./source-file-native.ts"', "from " + JSON.stringify(profile))
          .replaceAll('from "./source-file-profile.ts"', "from " + JSON.stringify(profile));
      }
      if (["service.ts", "enter.ts", "inspect.ts"].includes(name))
        code = code.replaceAll('from "./controller-owner.ts"', "from " + JSON.stringify(import.meta.url));
      if (name === "service.ts") code = code.replaceAll('from "./controller-write.ts"',
        "from " + JSON.stringify(pathToFileURL(path.join(copyDirectory, "controller-entry.mjs")).href));
      const target = (relative: string) => pathToFileURL(relative.startsWith("./") && names.has(relative.slice(2))
        ? path.join(copyDirectory, relative.slice(2)) : path.resolve(path.dirname(original), relative)).href;
      code = code.replace(/from "(\.{1,2}\/[^"\n]+)"/g, (_, relative: string) => "from " + JSON.stringify(target(relative)))
        .replace(/import\("(\.{1,2}\/[^"\n]+)"\)/g, (_, relative: string) => "import(" + JSON.stringify(target(relative)) + ")");
      await writeFile(path.join(copyDirectory, name), code, { mode: 0o600 });
    }
    // Observe the actual factory return without modifying it or adding a
    // production hook. Every private check continues to use the original object.
    const writerUrl = pathToFileURL(path.join(copyDirectory, "controller-write.ts")).href;
    await writeFile(path.join(copyDirectory, "controller-entry.mjs"),
      `import { beginControllerCommand as begin } from ${JSON.stringify(writerUrl)};\n`
      + `import { recordServiceCommandScope } from ${JSON.stringify(import.meta.url)};\n`
      + `export * from ${JSON.stringify(writerUrl)};\n`
      + "export async function beginControllerCommand(...args) { const result = await begin(...args); "
      + "recordServiceCommandScope(args[3].request.plan.controlRoot, result.scope); return result; }\n", { mode: 0o600 });
    const owners = await import(pathToFileURL(path.join(copyDirectory, "controller-owner.ts")).href) as OwnerModule;
    const state: State = { owners, events: [], scopes: [] }; states.set(source.reference.controlRoot, state);
    const service = await import(pathToFileURL(path.join(copyDirectory, "service.ts")).href) as typeof import("../../src/server/storage/maintenance/service.ts");
    const writer = await import(pathToFileURL(path.join(copyDirectory, "controller-write.ts")).href) as typeof import("../../src/server/storage/maintenance/controller-write.ts");
    const consumers = await import(pathToFileURL(path.join(copyDirectory, "restore-authorization.ts")).href) as typeof import("../../src/server/storage/maintenance/restore-authorization.ts");
    const guard = await import(pathToFileURL(path.join(copyDirectory, "verified-maintenance.ts")).href) as typeof import("../../src/server/storage/maintenance/verified-maintenance.ts");
    const sql = await import(pathToFileURL(path.join(copyDirectory, "control-sql.ts")).href) as typeof import("../../src/server/storage/maintenance/control-sql.ts");
    return { ...source, state, service, writer, consumers, guard, sql, moduleDirectory: copyDirectory,
      get options() { return serviceOptions; }, freshVerificationTarget,
      async close() {
        const failures: unknown[] = [];
        for (const cleanup of [dropTarget, () => admin?.end(), () => source.close(), () => rm(copyDirectory, { recursive: true, force: true })])
          try { await cleanup(); } catch (error) { failures.push(error); }
        states.delete(source.reference.controlRoot);
        if (failures.length === 1) throw failures[0];
        if (failures.length) throw new AggregateError(failures, "service fixture cleanup failed", { cause: failures[0] });
      } };
  } catch (error) {
    const failures: unknown[] = [error];
    for (const cleanup of [dropTarget, () => admin?.end(), () => source.close(), () => directory && rm(directory, { recursive: true, force: true })])
      try { await cleanup(); } catch (failure) { failures.push(failure); }
    states.delete(source.reference.controlRoot);
    if (failures.length === 1) throw error;
    throw new AggregateError(failures, "service fixture initialization failed", { cause: error });
  }
}

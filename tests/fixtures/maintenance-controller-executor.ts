/** Fixed transport fixtures only. These do not issue a native controller or qualify maintenance. */
import { appendFileSync } from "node:fs";
import { appendFile, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { ControllerFrameReader, controllerDescriptorAliases, controllerLimits, encodeControllerFrame, parseParentControllerFrame,
  resolveControllerOptions } from "../../src/server/storage/maintenance/controller-command.ts";
import type { ControllerOutcome, ControllerRequest, ControllerServiceCommand } from "../../src/server/storage/maintenance/controller-command.ts";
import type { MaintenanceResult, MaintenanceServiceOptions } from "../../src/server/storage/maintenance/types.ts";
import { parsePostgresConnection } from "../../src/server/storage/maintenance/postgres-tools.ts";

export const executorSecret = "executor-private-canary-DO-NOT-PRINT";
export type ExecutorFixtureMode = "paused" | "throw-undefined" | "throw-aggregate" | "hold-service" | "large-result" | "secret-blocker"
  | "hold-result" | "hold-stdio" | "abnormal-exit" | "duplicate-result" | "out-of-order" | "invalid-version" | "oversized-frame";
const entryModes = new Set<ExecutorFixtureMode>(["hold-result", "hold-stdio", "abnormal-exit", "duplicate-result", "out-of-order", "invalid-version", "oversized-frame"]);
const repo = fileURLToPath(new URL("../..", import.meta.url));
async function event(dir: string, name: string, extra: Record<string, unknown> = {}) {
  await appendFile(path.join(dir, "events.jsonl"), JSON.stringify({ event: name, pid: process.pid, ...extra }) + "\n");
}
async function released(dir: string, name: string) {
  for (;;) {
    try { await readFile(path.join(dir, name)); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await delay(10);
  }
}
function paused(command: ControllerServiceCommand): MaintenanceResult {
  const journalDigest = "b".repeat(64);
  return { status: "paused", phase: "planned", ref: { migrationId: command.request.plan.migrationId, source: command.request.expectedSource,
    planDigest: command.request.plan.planDigest, fenceEpoch: 1, journal: { ref: `journals/${command.request.plan.migrationId}/1-${journalDigest}.json`,
      sha256: journalDigest, bytes: "1" }, journalSequence: 1, ownerGeneration: 1 } };
}
export async function runFixedService(mode: ExecutorFixtureMode, dir: string, options: MaintenanceServiceOptions,
  command: ControllerServiceCommand): Promise<MaintenanceResult> {
  await event(dir, "service", { execPath: process.execPath, argv: process.argv, execArgv: process.execArgv,
    nodeOptions: process.env["NODE_OPTIONS"] ?? null, nodePath: process.env["NODE_PATH"] ?? null, operation: command.operation,
    verificationConfigured: options.postgresVerification !== undefined,
    verificationSchema: options.postgresVerification ? parsePostgresConnection(options.postgresVerification).schema : null,
    verificationDescriptorDigest: options.postgresVerification ? parsePostgresConnection(options.postgresVerification).descriptorDigest : null });
  process.stdout.write(executorSecret); process.stderr.write(executorSecret);
  if (mode === "throw-undefined") throw undefined;
  if (mode === "throw-aggregate") {
    const error = new Error(executorSecret);
    throw new AggregateError([undefined, error, error, undefined], executorSecret, { cause: undefined });
  }
  if (mode === "hold-service") await released(dir, "release-service");
  if (mode === "large-result") return { status: "blocked", lastVerifiedPhase: null,
    blockers: Array.from({ length: 10_000 }, () => ({ code: "source_writer_unknown", subjectRef: executorSecret })) };
  if (mode === "secret-blocker") return { status: "blocked", lastVerifiedPhase: null,
    blockers: [{ code: "source_writer_unknown", subjectRef: executorSecret }] };
  return paused(command);
}

/** A fixed malformed/closing peer exercises the production parent against real ChildProcess events. */
export async function runFixedPeer(mode: ExecutorFixtureMode, dir: string): Promise<void> {
  const ipc = new Socket({ fd: 3, readable: true, writable: true, allowHalfOpen: true });
  let request: ControllerRequest | undefined;
  let continued!: () => void;
  const continuation = new Promise<void>(resolve => { continued = resolve; });
  const send = (value: unknown) => ipc.write(encodeControllerFrame(value, 2 * controllerLimits.resultBytes));
  const reader = new ControllerFrameReader(controllerLimits.commandBytes, value => {
    const frame = parseParentControllerFrame(value);
    if (frame.type === "command") { request = frame.request; void run(); }
    else continued();
  });
  ipc.on("data", (chunk: Buffer) => { try { reader.push(chunk); } catch { process.exitCode = 2; ipc.end(); } });
  ipc.on("end", () => { ipc.end(); });
  ipc.on("error", () => { process.exitCode = 2; });
  process.on("exit", () => appendFileSync(path.join(dir, "events.jsonl"), JSON.stringify({ event: "exit", pid: process.pid }) + "\n"));
  async function run() {
    await event(dir, "peer", { execPath: process.execPath, argv: process.argv, execArgv: process.execArgv });
    const options = await resolveControllerOptions(request!.selection), result = paused(request!.command);
    if (mode === "out-of-order") { send({ version: 1, sequence: 1, type: "result", result }); ipc.end(); return; }
    if (mode === "invalid-version") { send({ version: 2, sequence: 0, type: "resolved", aliases: controllerDescriptorAliases(options.environment.databaseDescriptor) }); ipc.end(); return; }
    if (mode === "oversized-frame") { ipc.end(Buffer.from('"' + "x".repeat(controllerLimits.resultBytes) + '"\n')); return; }
    send({ version: 1, sequence: 0, type: "resolved", aliases: controllerDescriptorAliases(options.environment.databaseDescriptor) });
    await continuation;
    send({ version: 1, sequence: 1, type: "result", result });
    if (mode === "duplicate-result") send({ version: 1, sequence: 1, type: "result", result });
    ipc.end();
    await event(dir, "result-sent");
    if (mode === "hold-result") await released(dir, "release-exit");
    if (mode === "hold-stdio") {
      const holder = spawn(process.execPath, [fileURLToPath(import.meta.url), "--hold-stdio", dir], { stdio: ["ignore", 1, 2] });
      holder.unref();
    }
    if (mode === "abnormal-exit") process.exitCode = 7;
  }
}
if (process.argv[2] === "--hold-stdio") {
  await event(process.argv[3]!, "stdio-holder");
  await released(process.argv[3]!, "release-stdio");
}

export async function executorFixture(mode: ExecutorFixtureMode, backend: "sqlite" | "postgres" = "sqlite") {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "boardroom-c3-executor-")));
  const checkout = path.join(dir, "checkout"), sourceDir = path.join(dir, "source"), dataDir = path.join(sourceDir, "data");
  await mkdir(dataDir, { recursive: true }); await mkdir(checkout);
  await cp(path.join(repo, "src"), path.join(checkout, "src"), { recursive: true });
  await mkdir(path.join(checkout, "scripts"));
  await cp(path.join(repo, "scripts/storage-maintenance.ts"), path.join(checkout, "scripts/storage-maintenance.ts"));
  await cp(path.join(repo, "package.json"), path.join(checkout, "package.json"));
  await symlink(path.join(repo, "node_modules"), path.join(checkout, "node_modules"), "dir");
  if (backend === "sqlite") {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(path.join(dataDir, "agent-studio.db"));
    db.exec("CREATE TABLE executor_transport_fixture(id INTEGER PRIMARY KEY, value TEXT)"); db.close();
  }
  await writeFile(path.join(sourceDir, "config.json"), JSON.stringify({ dataDir, dbDriver: backend,
    ...(backend === "postgres" ? { pgConnectionString: "postgres://fixture:source-fixture-password@localhost/source_fixture" } : {}) }));
  await writeFile(path.join(dir, "events.jsonl"), "");
  const maintenance = path.join(checkout, "src/server/storage/maintenance"), fixtureModule = JSON.stringify(import.meta.url);
  if (entryModes.has(mode)) await writeFile(path.join(maintenance, "controller-worker-entry.ts"),
    `import { runFixedPeer } from ${fixtureModule};\nawait runFixedPeer(${JSON.stringify(mode)}, ${JSON.stringify(dir)});\n`);
  else await writeFile(path.join(maintenance, "service.ts"),
    `import { runFixedService } from ${fixtureModule};\nexport function runMaintenanceServiceCommand(options, command) { return runFixedService(${JSON.stringify(mode)}, ${JSON.stringify(dir)}, options, command); }\n`);
  const { resolveBoardroomEnvironment } = await import("../../src/server/environment.ts");
  const environment = await resolveBoardroomEnvironment({ cwd: sourceDir });
  if (!environment.inventory.selectedSourceId) throw new Error("transport fixture source missing");
  const digest = createHash("sha256").update(dir).digest("hex"), controlRoot = path.join(dataDir, "control");
  const request: ControllerRequest = { selection: { originalCwd: sourceDir, expectedSourceId: environment.inventory.selectedSourceId,
    controlRoot, targetRoot: path.join(dir, "target"), knownLegacyCwds: [] }, command: { operation: "execute-migration", request: {
      plan: { migrationId: "executor-fixture", planDigest: digest, immutablePlan: { ref: `plans/${digest}.json`, sha256: digest, bytes: "1" }, controlRoot },
      expectedSource: { kind: backend, databaseInstanceId: digest.slice(0, 32), identityDigest: digest },
      expectedPhase: null, expectedJournalDigest: null, requestId: "executor-request" } } };
  const { runControllerCommand } = await import(pathToFileURL(path.join(maintenance, "controller-executor.ts")).href) as {
    runControllerCommand: (value: unknown) => Promise<ControllerOutcome> };
  const promises = new Set<Promise<ControllerOutcome>>();
  const events = async (): Promise<Record<string, unknown>[]> => (await readFile(path.join(dir, "events.jsonl"), "utf8")).split("\n").slice(0, -1).map(line => JSON.parse(line));
  const release = async (name: "exit" | "stdio" | "service") => { await writeFile(path.join(dir, `release-${name}`), "release"); };
  return { dir, checkout, sourceDir, dataDir, request, events, release,
    run(value: unknown = request) { const promise = runControllerCommand(value); promises.add(promise); return promise; },
    async waitFor(name: string) {
      for (let i = 0; i < 500; i++) { const found = (await events()).find(item => item.event === name); if (found) return found; await delay(10); }
      throw new Error(`transport fixture event missing: ${name}`);
    },
    async close() {
      await Promise.all([release("exit"), release("stdio"), release("service")]);
      await Promise.allSettled([...promises]);
      await rm(dir, { recursive: true, force: true });
    } };
}

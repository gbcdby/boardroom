import { spawn, type ChildProcess } from "node:child_process";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { digestJson } from "./canonical.ts";
import { MaintenanceFailure } from "./error.ts";
import { ControllerFrameReader, controllerDescriptorAliases, controllerFailureOutcome, controllerLimits, controllerRequestAliases,
  encodeControllerFrame, parseControllerRequest, parseWorkerControllerFrame, projectControllerFailure, resolveControllerOptions } from "./controller-command.ts";
import type { ControllerOutcome, ControllerRequest, SafeControllerFailure } from "./controller-command.ts";

interface ExecutorOwner {
  readonly request: ControllerRequest;
  readonly digest: string;
  readonly aliases: Set<string>;
  readonly promise: Promise<ControllerOutcome>;
  readonly resolve: (outcome: ControllerOutcome) => void;
  child?: ChildProcess;
}
const pending = new Map<string, ExecutorOwner>();
const workerEntry = fileURLToPath(new URL("./controller-worker-entry.ts", import.meta.url));

function busy(): ControllerOutcome {
  return { result: { status: "blocked", lastVerifiedPhase: null,
    blockers: [{ code: "maintenance_busy", subjectRef: "controller-executor" }] }, failure: null };
}
function claimAliases(owner: ExecutorOwner, aliases: readonly string[]): boolean {
  if (aliases.some(alias => pending.has(alias) && pending.get(alias) !== owner)) return false;
  for (const alias of aliases) { pending.set(alias, owner); owner.aliases.add(alias); }
  return true;
}
function finish(owner: ExecutorOwner, outcome: ControllerOutcome): void {
  for (const alias of owner.aliases) if (pending.get(alias) === owner) pending.delete(alias);
  owner.resolve(outcome);
}
function combineFailures(failures: readonly SafeControllerFailure[]): SafeControllerFailure {
  const events: SafeControllerFailure["events"] = [];
  let truncated = failures.some(failure => failure.truncated);
  let omittedBranches = failures.reduce((count, failure) => count + failure.omittedBranches, 0);
  for (const failure of failures) {
    const offset = events.length;
    for (let i = 0; i < failure.events.length; i++) {
      const event = failure.events[i]!;
      if (events.length === 64) { truncated = true; omittedBranches += failure.events.length - i; break; }
      events.push({ ...event, parent: event.parent === null ? null : event.parent + offset });
    }
  }
  return { occurred: true, code: failures[0]!.code, events, truncated, omittedBranches };
}

/** This function is deliberately not async: identical re-entry receives the original registered Promise. */
export function runControllerCommand(value: unknown): Promise<ControllerOutcome> {
  const request = parseControllerRequest(value), digest = digestJson(request), aliases = controllerRequestAliases(request);
  const existing = aliases.map(alias => pending.get(alias)).find(owner => owner !== undefined);
  if (existing) return existing.digest === digest ? existing.promise : Promise.resolve(busy());
  let resolve!: ExecutorOwner["resolve"];
  const promise = new Promise<ControllerOutcome>(done => { resolve = done; });
  const owner: ExecutorOwner = { request, digest, aliases: new Set(), promise, resolve };
  claimAliases(owner, aliases);
  // The owner and its original completion are visible before resolver I/O or the first await.
  void start(owner).then(outcome => finish(owner, outcome), error => finish(owner, controllerFailureOutcome(projectControllerFailure(error), false)));
  return promise;
}

async function start(owner: ExecutorOwner): Promise<ControllerOutcome> {
  const options = await resolveControllerOptions(owner.request.selection);
  if (!claimAliases(owner, controllerDescriptorAliases(options.environment.databaseDescriptor))) return busy();
  const env = { ...process.env };
  // Fixed entry/argv, no inherited preloads or alternative dependency search path.
  delete env["NODE_OPTIONS"]; delete env["NODE_PATH"];
  const child = spawn(process.execPath, [workerEntry], { cwd: owner.request.selection.originalCwd, env,
    shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "pipe"] });
  owner.child = child;
  return await joinChild(owner, child);
}

function joinChild(owner: ExecutorOwner, child: ChildProcess): Promise<ControllerOutcome> {
  return new Promise(resolve => {
    const ipc = child.stdio[3] as Duplex;
    const failures: SafeControllerFailure[] = [];
    let state: "resolving" | "running" | "finished" = "resolving";
    let result: ControllerOutcome["result"] | undefined;
    let exitObserved = false, closeObserved = false, ipcClosed = false, spawnFailed = false, enteredService = false, resolved = false;
    const record = (error: unknown, code: "controller_protocol_invalid" | "controller_process_failed" | "controller_output_limit") => {
      failures.push(projectControllerFailure(error, code));
    };
    const settle = () => {
      // A result, EOF, a signal request, or ChildProcess.exitCode is never this observation.
      if (resolved || !closeObserved || !ipcClosed || !exitObserved && !spawnFailed) return;
      resolved = true;
      if (!result && failures.length === 0) record(undefined, "controller_protocol_invalid");
      resolve(failures.length ? controllerFailureOutcome(combineFailures(failures), enteredService) : { result: result!, failure: null });
    };
    const send = (frame: unknown) => {
      try {
        const bytes = encodeControllerFrame(frame, controllerLimits.commandBytes);
        ipc.write(bytes, error => { if (error) record(error, "controller_process_failed"); });
      } catch (error) { record(error, "controller_process_failed"); ipc.end(); }
    };
    const reader = new ControllerFrameReader(controllerLimits.resultBytes, value => {
      const frame = parseWorkerControllerFrame(value, owner.request);
      if (state === "finished") throw new MaintenanceFailure("request_conflict", "controller-duplicate-result");
      if (frame.type === "resolved") {
        if (state !== "resolving" || failures.length) throw new MaintenanceFailure("request_conflict", "controller-frame-order");
        if (!claimAliases(owner, frame.aliases)) {
          failures.push(projectControllerFailure(new MaintenanceFailure("maintenance_busy", "controller-executor")));
          state = "finished"; ipc.end(); return;
        }
        state = "running"; enteredService = true;
        send({ version: 1, sequence: 1, type: "continue" });
      } else if (frame.type === "failure") {
        if (frame.sequence !== (state === "resolving" ? 0 : 1)) throw new MaintenanceFailure("request_conflict", "controller-frame-order");
        failures.push(frame.failure); state = "finished";
      } else {
        if (state !== "running" || failures.length) throw new MaintenanceFailure("request_conflict", "controller-frame-order");
        result = frame.result; state = "finished";
      }
    });
    ipc.on("data", (chunk: Buffer) => {
      try { reader.push(chunk); }
      catch (error) { record(error, "controller_protocol_invalid"); ipc.end(); }
    });
    ipc.on("end", () => {
      try { reader.end(); } catch (error) { record(error, "controller_protocol_invalid"); }
      if (state !== "finished") record(undefined, "controller_protocol_invalid");
      ipc.end();
    });
    ipc.on("error", error => { record(error, "controller_process_failed"); });
    ipc.on("close", () => { ipcClosed = true; settle(); });
    for (const stream of [child.stdout, child.stderr]) {
      let count = 0, limitObserved = false;
      // No raw worker/tool output is retained or forwarded, including on abnormal death.
      stream?.on("data", (chunk: Buffer) => {
        count += chunk.length;
        if (count > controllerLimits.resultBytes && !limitObserved) { limitObserved = true; record(undefined, "controller_output_limit"); }
      });
      stream?.on("error", error => { record(error, "controller_process_failed"); });
    }
    child.on("error", error => { spawnFailed = child.pid === undefined; record(error, "controller_process_failed"); settle(); });
    child.on("exit", (code, signal) => {
      exitObserved = true;
      if (code !== 0 || signal !== null) record(undefined, "controller_process_failed");
      settle();
    });
    child.on("close", () => { closeObserved = true; settle(); });
    send({ version: 1, sequence: 0, type: "command", request: owner.request });
  });
}

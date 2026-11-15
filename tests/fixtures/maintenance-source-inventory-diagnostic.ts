import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, type Hash } from "node:crypto";
import fs from "node:fs";
import promises, { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Call = (...args: unknown[]) => unknown;
type Identity = { pid: string | null; state: string | null; threads: string | null; startTicks: string | null };
type ReadSummary = { bytes: number; reads: number; eof: boolean; closed: boolean; sha256: string;
  endsWithNewline: boolean; shortPositiveReads: number; identity?: Identity; identitySummaryTruncated?: boolean };
type Proc = { pid: number; errors: object[]; droppedErrors: number; observationErrors: number;
  stats: ReadSummary[]; maps: ReadSummary[]; uids: string[]; fdDirectoryCounts: number[]; droppedSummaries: number };
type Capture = { proc: Proc; subject: "stat" | "maps"; hash: Hash; bytes: number; reads: number; eof: boolean;
  lastByte: number | null; shortPositiveReads: number; statBytes: Buffer[]; statCaptured: number };
type Frame = { index: number; phase: string; processes: Map<number, Proc>; pins: Map<number, Proc>;
  descriptors: Map<number, Capture>; droppedProcesses: number; observationErrors: number; finished: boolean };
const limits = { inspections: 2, failedPidsPerInspection: 16, processesPerInspection: 512, errorsPerProcess: 32,
  summariesPerProcess: 4, statIdentityBytes: 8192 } as const;
const root = fileURLToPath(new URL("../../", import.meta.url));
const defaultOutput = path.join(root, ".agent-output", "maintenance-native-diagnostics", "source-inventory");
const syncNames = ["openSync", "readSync", "closeSync", "fstatSync"] as const;
const asyncNames = ["readdir", "readlink", "stat"] as const;
const context = new AsyncLocalStorage<Frame>();
function safeError(error: unknown) {
  const value = error as { name?: unknown; code?: unknown; syscall?: unknown } | null;
  return { name: ["Error", "TypeError", "RangeError", "MaintenanceFailure"].includes(String(value?.name)) ? String(value!.name) : "other",
    code: typeof value?.code === "string" && /^E[A-Z0-9_]{1,30}$/.test(value.code) ? value.code : null,
    syscall: typeof value?.syscall === "string" && ["open", "read", "close", "fstat", "stat", "readlink", "scandir"].includes(value.syscall) ? value.syscall : null };
}
function observe(frame: Frame, proc: Proc | undefined, work: () => void) {
  try { work(); } catch { if (proc) proc.observationErrors++; else frame.observationErrors++; }
}
function getProcess(frame: Frame, pid: number): Proc | undefined {
  let result = frame.processes.get(pid);
  if (!result) {
    if (frame.processes.size === limits.processesPerInspection) { frame.droppedProcesses++; return undefined; }
    result = { pid, errors: [], droppedErrors: 0, observationErrors: 0, stats: [], maps: [], uids: [], fdDirectoryCounts: [], droppedSummaries: 0 };
    frame.processes.set(pid, result);
  }
  return result;
}
function subject(frame: Frame, value: unknown): { proc: Proc; subject: string } | undefined {
  if (typeof value !== "string") return;
  const pin = /^\/proc\/([1-9][0-9]*)$/.exec(value);
  if (pin) { const proc = getProcess(frame, Number(pin[1])); return proc ? { proc, subject: "proc-directory" } : undefined; }
  const item = /^\/proc\/self\/fd\/([0-9]+)\/(stat|maps|fd)(?:\/[0-9]+)?$/.exec(value);
  const proc = item && frame.pins.get(Number(item[1]));
  if (proc && item) return { proc, subject: item[2] === "fd" && value.endsWith("/fd") ? "fd-directory" : item[2] === "fd" ? "process-fd" : item[2]! };
}
function recordError(frame: Frame, proc: Proc | undefined, operation: string, category: string, error: unknown) {
  if (!proc) return;
  observe(frame, proc, () => {
    const safe = safeError(error);
    if (proc.errors.length < limits.errorsPerProcess) proc.errors.push({ operation, subject: category, error: safe,
      originalHandling: category === "process-fd" && ["ENOENT", "ESRCH", "EBADF"].includes(safe.code ?? "")
        ? "ignored-fd-race" : "requires-original-path-context" });
    else proc.droppedErrors++;
  });
}
function finishRead(capture: Capture, closed: boolean): ReadSummary {
  const result: ReadSummary = { bytes: capture.bytes, reads: capture.reads, eof: capture.eof, closed,
    sha256: capture.hash.copy().digest("hex"), endsWithNewline: capture.lastByte === 10, shortPositiveReads: capture.shortPositiveReads };
  if (capture.subject === "stat") {
    // Minimal fields from the original returned bytes; never emit comm, raw stat/maps or reread proc.
    const text = Buffer.concat(capture.statBytes, capture.statCaptured).toString("latin1"), end = text.lastIndexOf(") ");
    const fields = end < 0 ? [] : text.slice(end + 2).trim().split(/\s+/), first = /^([1-9][0-9]*) \(/.exec(text);
    const numeric = (value: string | undefined) => value && /^[0-9]{1,24}$/.test(value) ? value : null;
    result.identity = { pid: first?.[1] ?? null, state: /^[A-Za-z]$/.test(fields[0] ?? "") ? fields[0]! : null,
      threads: numeric(fields[17]), startTicks: numeric(fields[19]) };
    result.identitySummaryTruncated = capture.bytes !== capture.statCaptured;
  }
  capture.statBytes = []; return result;
}
function stageHint(proc: Proc): string {
  if (proc.errors.some(item => (item as { originalHandling?: string }).originalHandling !== "ignored-fd-race")) return "original-syscall-error";
  const before = proc.stats[0]?.identity, after = proc.stats.at(-1)?.identity;
  if (before && after && proc.stats.length > 1 && (before.pid !== after.pid || before.startTicks !== after.startTicks)
    || proc.uids.length > 1 && proc.uids[0] !== proc.uids.at(-1)) return "identity-check";
  const maps = proc.maps.at(-1);
  if (maps?.eof && maps.bytes > 0 && !maps.endsWithNewline) return "maps-input-shape";
  if (maps?.eof && maps.bytes === 0) return "empty-maps-with-stat-evidence";
  if (maps?.eof && proc.stats.length === 1) return "after-maps-read-before-final-stat";
  if (maps && !maps.eof) return "maps-read-not-complete";
  return "unclassified-original-blocker";
}

/** Test-only passive observer. Original native calls, promises, return values and exceptions are forwarded once. */
export async function withSqliteSourceInventoryDiagnostics<T>(adapter: object,
  operation: (phase: (value: string) => void) => Promise<T>, outputRoot = defaultOutput): Promise<T> {
  if (process.platform !== "linux") return operation(() => {});
  const target = adapter as { inspectCurrentWriters: Call }, prior = Object.getOwnPropertyDescriptor(target, "inspectCurrentWriters");
  const originalInspect = target.inspectCurrentWriters;
  const mutable = fs as unknown as Record<typeof syncNames[number], Call>;
  const asyncMutable = promises as unknown as Record<typeof asyncNames[number], Call>;
  const syncOriginal = Object.fromEntries(syncNames.map(name => [name, mutable[name]])) as typeof mutable;
  const asyncOriginal = Object.fromEntries(asyncNames.map(name => [name, asyncMutable[name]])) as typeof asyncMutable;
  let phase = "before-consume", inspectionCalls = 0, failedInspections = 0, droppedFailures = 0, restorationErrors = 0;
  let setupComplete = false, threw = false, originalError: unknown, result: T | undefined;
  const failures: object[] = [];
  const restore = () => {
    for (const name of syncNames) try { mutable[name] = syncOriginal[name]; } catch { restorationErrors++; }
    for (const name of asyncNames) try { asyncMutable[name] = asyncOriginal[name]; } catch { restorationErrors++; }
    try { syncBuiltinESMExports(); } catch { restorationErrors++; }
    try { if (prior) Object.defineProperty(target, "inspectCurrentWriters", prior); else delete (target as Partial<typeof target>).inspectCurrentWriters; }
    catch { restorationErrors++; }
  };
  const finish = (frame: Frame, value: unknown) => observe(frame, undefined, () => {
    frame.finished = true;
    const pids = Array.isArray(value) ? [...new Set(value.flatMap(item => {
      if (item?.code !== "source_writer_unknown" || typeof item.subjectRef !== "string") return [];
      const match = /^unreadable-process:([1-9][0-9]*)$/.exec(item.subjectRef); return match ? [Number(match[1])] : [];
    }))] : [];
    if (!pids.length) return;
    if (++failedInspections > limits.inspections) { droppedFailures += pids.length; return; }
    for (const pid of pids.slice(0, limits.failedPidsPerInspection)) {
      const proc = frame.processes.get(pid);
      failures.push({ inspection: frame.index, phase: frame.phase, pid, observationErrors: frame.observationErrors,
        droppedProcesses: frame.droppedProcesses, frame: proc ? { ...proc, stageHint: stageHint(proc) } : null });
    }
    droppedFailures += Math.max(0, pids.length - limits.failedPidsPerInspection);
  });
  try {
    if (typeof originalInspect !== "function") throw new Error("diagnostic_boundary_unavailable");
    for (const name of syncNames) mutable[name] = function(this: unknown, ...args: unknown[]) {
      const frame = context.getStore(), enabled = frame && !frame.finished;
      let item: ReturnType<typeof subject>, capture: Capture | undefined, pinned: Proc | undefined;
      if (enabled) observe(frame, undefined, () => {
        item = subject(frame, args[0]); capture = frame.descriptors.get(Number(args[0])); pinned = frame.pins.get(Number(args[0]));
      });
      let value: unknown;
      try { value = Reflect.apply(syncOriginal[name], this, args); }
      catch (error) {
        if (enabled) recordError(frame, item?.proc ?? capture?.proc ?? pinned, name, item?.subject ?? capture?.subject ?? "proc-directory", error);
        throw error;
      }
      if (enabled) observe(frame, item?.proc ?? capture?.proc ?? pinned, () => {
        if (name === "openSync" && item && typeof value === "number") {
          if (item.subject === "proc-directory") frame.pins.set(value, item.proc);
          if (item.subject === "stat" || item.subject === "maps") frame.descriptors.set(value, { proc: item.proc, subject: item.subject,
            hash: createHash("sha256"), bytes: 0, reads: 0, eof: false, lastByte: null, shortPositiveReads: 0, statBytes: [], statCaptured: 0 });
        } else if (name === "readSync" && capture && typeof value === "number") {
          capture.reads++; capture.bytes += value;
          if (value === 0) capture.eof = true;
          if (value > 0 && Buffer.isBuffer(args[1]) && typeof args[2] === "number") {
            const bytes = args[1].subarray(args[2], args[2] + value); capture.hash.update(bytes); capture.lastByte = bytes.at(-1) ?? null;
            if (typeof args[3] === "number" && value < args[3]) capture.shortPositiveReads++;
            if (capture.subject === "stat") {
              const count = Math.min(bytes.length, limits.statIdentityBytes - capture.statCaptured);
              if (count > 0) capture.statBytes.push(Buffer.from(bytes.subarray(0, count))); capture.statCaptured += count;
            }
          }
        } else if (name === "fstatSync" && pinned) {
          if (pinned.uids.length < limits.summariesPerProcess) pinned.uids.push(String((value as fs.Stats).uid)); else pinned.droppedSummaries++;
        } else if (name === "closeSync") {
          if (capture) {
            const destination = capture.subject === "stat" ? capture.proc.stats : capture.proc.maps;
            if (destination.length < limits.summariesPerProcess) destination.push(finishRead(capture, true)); else capture.proc.droppedSummaries++;
            frame.descriptors.delete(Number(args[0]));
          }
          frame.pins.delete(Number(args[0]));
        }
      });
      return value;
    };
    for (const name of asyncNames) asyncMutable[name] = function(this: unknown, ...args: unknown[]) {
      const frame = context.getStore(), enabled = frame && !frame.finished;
      let item: ReturnType<typeof subject>;
      if (enabled) observe(frame, undefined, () => { item = subject(frame, args[0]); });
      let pending: unknown;
      try { pending = Reflect.apply(asyncOriginal[name], this, args); }
      catch (error) { if (enabled) recordError(frame, item?.proc, name, item?.subject ?? "other", error); throw error; }
      if (enabled && item) {
        const observed = item;
        observe(frame, observed.proc, () => { (pending as Promise<unknown>).then(value => observe(frame, observed.proc, () => {
          if (name === "readdir" && observed.subject === "fd-directory" && Array.isArray(value)) {
            if (observed.proc.fdDirectoryCounts.length < limits.summariesPerProcess) observed.proc.fdDirectoryCounts.push(value.length); else observed.proc.droppedSummaries++;
          }
        }), error => recordError(frame, observed.proc, name, observed.subject, error)); });
      }
      return pending; // Keep the original promise, including its original rejection object and native call order.
    };
    syncBuiltinESMExports();
    Object.defineProperty(target, "inspectCurrentWriters", { configurable: true, writable: true, value: function(this: unknown, ...args: unknown[]) {
      const frame: Frame = { index: ++inspectionCalls, phase, processes: new Map(), pins: new Map(), descriptors: new Map(),
        droppedProcesses: 0, observationErrors: 0, finished: false };
      let value: unknown;
      try { value = context.run(frame, () => Reflect.apply(originalInspect, this, args)); }
      catch (error) { frame.finished = true; throw error; }
      observe(frame, undefined, () => {
        if (value && typeof (value as Promise<unknown>).then === "function")
          (value as Promise<unknown>).then(result => finish(frame, result), () => { frame.finished = true; });
        else finish(frame, value);
      });
      return value;
    } });
    setupComplete = true;
  } catch { restore(); }
  try { result = await operation(value => { phase = /^[a-z0-9-]{1,64}$/.test(value) ? value : "other"; }); }
  catch (error) { threw = true; originalError = error; }
  finally { if (setupComplete) restore(); }
  if (failures.length) try {
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(path.join(outputRoot, "inspection-"));
    await writeFile(path.join(directory, "report.json"), JSON.stringify({ setupComplete, restorationErrors, inspectionCalls,
      originalOperationThrew: threw, droppedFailures, limits, pid: process.pid, uid: process.getuid?.() ?? null,
      node: process.version, candidate: /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? "") ? process.env.GITHUB_SHA : null,
      provenance: "Original calls and returned bytes only. Failed PID summaries only; no proc/source reread, dump, retry or qualification change.",
      stageHintScope: "Derived interval/input hints, not a caught internal parser exception or a root-cause conclusion.", failures }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  } catch { /* Artifact capture is best-effort; preserve the original operation's outcome. */ }
  // Do not report through stderr: its own synchronous or asynchronous failure can affect the original operation.
  if (threw) throw originalError;
  return result as T;
}

import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { release } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Call = (...args: unknown[]) => unknown;
type ConnectionState = { open: boolean | null; inTransaction: boolean | null };
type Capture = { kind: string; fd: number; parts: Buffer[]; observedBytes: number; capturedBytes: number;
  reads: number; eof: boolean; closed: boolean; truncated: boolean };
type Frame = { index: number; phase: string; nativeCloseCalls: number; nativeCloseReturned: boolean;
  beforeNativeState: ConnectionState | null; afterNativeState: ConnectionState | null;
  events: object[]; droppedEvents: number; observationErrors: number; captures: Capture[];
  descriptors: Map<number, Capture>; sourceDescriptors: Map<number, string>; capturedBytes: number; error?: object };
const root = fileURLToPath(new URL("../../", import.meta.url));
const defaultOutput = path.join(root, ".agent-output", "maintenance-native-diagnostics", "source-close");
const operations = ["openSync", "readSync", "closeSync", "accessSync", "fstatSync", "lstatSync", "statSync", "readlinkSync", "readdirSync"] as const;
const limits = { eventsPerClose: 128, capturesPerClose: 8, bytesPerCapture: 256 * 1024,
  bytesPerClose: 1024 * 1024, failedCloses: 2 } as const;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function safeError(error: unknown) {
  const value = error as { name?: unknown; code?: unknown; syscall?: unknown; message?: unknown; stack?: unknown } | null;
  return {
    name: ["Error", "TypeError", "RangeError", "SqliteError", "MaintenanceFailure"].includes(String(value?.name)) ? String(value!.name) : "other",
    code: typeof value?.code === "string" && /^(?:E[A-Z0-9_]{1,30}|SQLITE_[A-Z0-9_]{1,25})$/.test(value.code) ? value.code : null,
    syscall: typeof value?.syscall === "string" && ["open", "read", "close", "access", "fstat", "lstat", "stat", "readlink", "scandir"].includes(value.syscall) ? value.syscall : null,
    category: value?.message === "linux_mapping_inventory_unavailable" ? "linux-mapping-inventory-unavailable" : "unclassified",
    frames: typeof value?.stack === "string"
      ? [...value.stack.matchAll(/\/maintenance\/(sqlite|linux-mappings)\.ts:(\d+):(\d+)/g)]
        .slice(0, 8).map(match => ({ file: `${match[1]}.ts`, line: Number(match[2]), column: Number(match[3]) })) : [],
  };
}
function observe(frame: Frame, work: () => void) {
  // Diagnostic failures cannot replace the original operation's return or exception.
  try { work(); } catch { frame.observationErrors++; }
}
function connectionState(frame: Frame, db: object): ConnectionState {
  const state: ConnectionState = { open: null, inTransaction: null };
  for (const key of ["open", "inTransaction"] as const) observe(frame, () => {
    const value = (db as Record<typeof key, unknown>)[key];
    if (typeof value === "boolean") state[key] = value;
  });
  return state;
}

/** Observe the original private close boundary once. No DB/proc reread, retry, altered result or production hook. */
export async function withSqliteSourceCloseDiagnostics<T>(
  mode: "control" | "snapshot", sourceFile: string, adapter: object,
  operation: () => Promise<T>, outputRoot = defaultOutput,
): Promise<T> {
  const target = adapter as { closeSource: Call }, priorOwn = Object.getOwnPropertyDescriptor(target, "closeSource");
  const originalCloseSource = target.closeSource;
  const mutable = fs as unknown as Record<typeof operations[number], Call>;
  const originals = Object.fromEntries(operations.map(name => [name, mutable[name]])) as typeof mutable;
  const failures: Frame[] = []; let active: Frame | undefined, closeCount = 0, droppedFailures = 0;
  let setupComplete = false, restorationErrors = 0, threw = false, originalError: unknown, result: T | undefined;
  const subject = (value: unknown) => {
    if (typeof value !== "string") return "other";
    const index = [sourceFile, sourceFile + "-wal", sourceFile + "-shm"].indexOf(value);
    if (index >= 0) return ["source-main", "source-wal", "source-shm"][index]!;
    if (value === "/proc/self/maps") return "self-maps";
    if (value === "/proc/self/mountinfo") return "self-mountinfo";
    if (/^\/proc\/self\/fdinfo\/[0-9]+$/.test(value)) return "self-fdinfo";
    if (/^\/proc\/self\/fd(?:\/[0-9]+)?$/.test(value)) return "self-fd";
    return "other";
  };
  const event = (frame: Frame, value: object) => {
    if (frame.events.length < limits.eventsPerClose) frame.events.push(value); else frame.droppedEvents++;
  };
  const restore = () => {
    for (const name of operations) try { mutable[name] = originals[name]; } catch { restorationErrors++; }
    try { syncBuiltinESMExports(); } catch { restorationErrors++; }
    try { if (priorOwn) Object.defineProperty(target, "closeSource", priorOwn); else delete (target as Partial<typeof target>).closeSource; }
    catch { restorationErrors++; }
  };
  try {
    if (typeof originalCloseSource !== "function") throw new Error("diagnostic_boundary_unavailable");
    for (const name of operations) mutable[name] = function(this: unknown, ...args: unknown[]) {
      const frame = active;
      let value: unknown;
      try { value = Reflect.apply(originals[name], this, args); }
      catch (error) {
        if (frame) observe(frame, () => event(frame, { operation: name, phase: frame.phase, subject: subject(args[0]), error: safeError(error) }));
        throw error;
      }
      if (frame) observe(frame, () => {
        const category = subject(args[0]);
        if (name === "openSync" && typeof value === "number") {
          if (category.startsWith("source-")) frame.sourceDescriptors.set(value, category);
          if (["self-maps", "self-mountinfo", "self-fdinfo"].includes(category)) {
            if (frame.captures.length < limits.capturesPerClose) {
              const capture: Capture = { kind: category, fd: value, parts: [], observedBytes: 0, capturedBytes: 0,
                reads: 0, eof: false, closed: false, truncated: false };
              frame.captures.push(capture); frame.descriptors.set(value, capture);
            } else frame.observationErrors++;
          }
          event(frame, { operation: name, phase: frame.phase, subject: category, fd: value,
            flags: typeof args[1] === "number" ? args[1] : null });
        } else if (name === "readSync") {
          const capture = frame.descriptors.get(Number(args[0]));
          if (capture && typeof value === "number") {
            capture.reads++; capture.observedBytes += value; if (value === 0) capture.eof = true;
            if (value > 0 && Buffer.isBuffer(args[1]) && typeof args[2] === "number") {
              const count = Math.min(value, limits.bytesPerCapture - capture.capturedBytes, limits.bytesPerClose - frame.capturedBytes);
              if (count > 0) capture.parts.push(Buffer.from(args[1].subarray(args[2], args[2] + count)));
              capture.capturedBytes += count; frame.capturedBytes += count; if (count !== value) capture.truncated = true;
            } else if (value !== 0) capture.truncated = true;
            event(frame, { operation: name, phase: frame.phase, subject: capture.kind, fd: capture.fd, bytes: value });
          }
        } else if (name === "closeSync") {
          const fd = Number(args[0]), capture = frame.descriptors.get(fd);
          if (capture) capture.closed = true;
          event(frame, { operation: name, phase: frame.phase, subject: capture?.kind ?? frame.sourceDescriptors.get(fd) ?? "other", fd });
          frame.descriptors.delete(fd); frame.sourceDescriptors.delete(fd);
        } else if (["fstatSync", "lstatSync", "statSync"].includes(name)) {
          const info = value as fs.Stats | fs.BigIntStats;
          event(frame, { operation: name, phase: frame.phase, subject: name === "fstatSync" ? frame.sourceDescriptors.get(Number(args[0])) ?? "other" : category,
            device: String(info.dev), inode: String(info.ino), links: String(info.nlink), mode: String(info.mode) });
        } else if (name === "readdirSync") {
          event(frame, { operation: name, phase: frame.phase, subject: category, count: Array.isArray(value) ? value.length : null });
        } else if (name === "readlinkSync") {
          event(frame, { operation: name, phase: frame.phase, subject: category, target: subject(value) });
        } else event(frame, { operation: name, phase: frame.phase, subject: category });
      });
      return value;
    };
    syncBuiltinESMExports();
    Object.defineProperty(target, "closeSource", { configurable: true, writable: true, value: function(this: unknown, ...args: unknown[]) {
      const db = args[0] as { name: string; close: Call };
      if (db?.name !== sourceFile) return Reflect.apply(originalCloseSource, this, args);
      const priorClose = Object.getOwnPropertyDescriptor(db, "close"), original = db.close;
      const frame: Frame = { index: ++closeCount, phase: "before-native-close", nativeCloseCalls: 0, nativeCloseReturned: false,
        beforeNativeState: null, afterNativeState: null,
        events: [], droppedEvents: 0, observationErrors: 0, captures: [], descriptors: new Map(), sourceDescriptors: new Map(), capturedBytes: 0 };
      const parentFrame = active; active = frame; let nativeHookInstalled = false;
      try {
        observe(frame, () => {
          Object.defineProperty(db, "close", { configurable: true, writable: true, value: function(this: unknown, ...closeArgs: unknown[]) {
            frame.phase = "native-close"; frame.nativeCloseCalls++;
            observe(frame, () => { frame.beforeNativeState = connectionState(frame, db); });
            try {
              const value = Reflect.apply(original, this, closeArgs);
              frame.nativeCloseReturned = true; frame.phase = "post-close-inventory"; return value;
            } finally { observe(frame, () => { frame.afterNativeState = connectionState(frame, db); }); }
          } });
          nativeHookInstalled = true;
        });
        return Reflect.apply(originalCloseSource, this, args);
      } catch (error) {
        observe(frame, () => { frame.error = safeError(error); });
        if (failures.length < limits.failedCloses) failures.push(frame); else droppedFailures++;
        throw error;
      } finally {
        active = parentFrame;
        if (nativeHookInstalled) observe(frame, () => {
          if (priorClose) Object.defineProperty(db, "close", priorClose); else delete (db as Partial<typeof db>).close;
        });
      }
    } });
    setupComplete = true;
  } catch { restore(); }
  try { result = await operation(); }
  catch (error) { threw = true; originalError = error; }
  finally { if (setupComplete) restore(); }
  if (failures.length) {
    try {
      await mkdir(outputRoot, { recursive: true, mode: 0o700 });
      const directory = await mkdtemp(path.join(outputRoot, `${mode}-`));
      const rows = [];
      for (const frame of failures) {
        const captures = [];
        for (const [index, capture] of frame.captures.entries()) {
          const bytes = Buffer.concat(capture.parts, capture.capturedBytes), file = `close-${frame.index}-${capture.kind}-${index}.bin`;
          await writeFile(path.join(directory, file), bytes, { mode: 0o600, flag: "wx" });
          const { parts: _parts, ...metadata } = capture;
          captures.push({ ...metadata, file, sha256: hash(bytes) });
        }
        rows.push({ index: frame.index, phase: frame.phase, nativeCloseCalls: frame.nativeCloseCalls,
          nativeCloseReturned: frame.nativeCloseReturned, beforeNativeState: frame.beforeNativeState,
          afterNativeState: frame.afterNativeState, error: frame.error, events: frame.events,
          droppedEvents: frame.droppedEvents, observationErrors: frame.observationErrors, captures });
      }
      const sources = ["src/server/storage/maintenance/sqlite.ts", "src/server/storage/maintenance/linux-mappings.ts",
        "tests/maintenance-source-facts-sqlite.test.ts", "tests/fixtures/maintenance-source-close-diagnostic.ts"];
      const sourceSha256 = Object.fromEntries(await Promise.all(sources.map(async name => [name, hash(await readFile(path.join(root, name)))])));
      const report = { mode, setupComplete, restorationErrors, originalOperationThrew: threw, closeCount, droppedFailures, limits,
        provenance: "Original close/fs calls, their original returned self proc bytes and bounded connection properties around the same close; no SQL/proc reread/retry/source DB open.",
        pid: process.pid, uid: process.getuid?.() ?? null, platform: process.platform, node: process.version, kernel: release(),
        candidate: /^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA ?? "") ? process.env.GITHUB_SHA : null,
        sourceSha256, failures: rows };
      await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    } catch { /* Artifact capture is best-effort; preserve the original operation's outcome. */ }
  }
  // Do not report through stderr: its own synchronous or asynchronous failure can affect the original operation.
  if (threw) throw originalError;
  return result as T;
}

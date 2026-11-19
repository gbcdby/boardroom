import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { release } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const defaultOutput = path.join(root, ".agent-output", "maintenance-native-diagnostics", "self-maps");
const limits = { captures: 4, bytesPerCapture: 1024 * 1024, readsPerCapture: 4096, fieldsPerRead: 7 } as const;
type Capture = { slot: number; ordinal: number; fd: number; active: boolean; observedBytes: number; capturedBytes: number;
  readCount: number; retainedReads: number; droppedReads: number; readErrors: number; closeErrors: number;
  eof: boolean; closed: boolean; truncated: boolean };
type Frame = { slab: Buffer; readSlots: Float64Array; captures: Capture[]; opens: number; openErrors: number;
  evictedCaptures: number; observationErrors: number; skippedScopes: number; finished: boolean };
const context = new AsyncLocalStorage<Frame | undefined>();
let activeFrame: Frame | undefined;

// Allocate and touch every capture slot before the original plan/persist starts.
// Hot wrappers never create Buffer views, strings, arrays, hashes or artifacts.
function allocateFrame(): Frame {
  const slab = Buffer.alloc(limits.captures * limits.bytesPerCapture, 1); slab.fill(0);
  const readSlots = new Float64Array(limits.captures * limits.readsPerCapture * limits.fieldsPerRead); readSlots.fill(-1);
  return { slab, readSlots,
    captures: Array.from({ length: limits.captures }, (_, slot) => ({ slot, ordinal: 0, fd: -1, active: false,
      observedBytes: 0, capturedBytes: 0, readCount: 0, retainedReads: 0, droppedReads: 0, readErrors: 0, closeErrors: 0,
      eof: false, closed: false, truncated: false })),
    opens: 0, openErrors: 0, evictedCaptures: 0, observationErrors: 0, skippedScopes: 0, finished: false };
}
function current(): Frame | undefined {
  const frame = context.getStore(); return frame && !frame.finished ? frame : undefined;
}
function captureFor(frame: Frame, fd: unknown): Capture | undefined {
  for (let i = 0; i < limits.captures; i++) {
    const capture = frame.captures[i]!;
    if (capture.active && capture.fd === fd) return capture;
  }
  return undefined;
}
function opened(frame: Frame, fd: number): void {
  const capture = frame.captures[frame.opens % limits.captures]!;
  if (capture.ordinal) frame.evictedCaptures++;
  capture.ordinal = ++frame.opens; capture.fd = fd; capture.active = true;
  capture.observedBytes = 0; capture.capturedBytes = 0; capture.readCount = 0; capture.retainedReads = 0;
  capture.droppedReads = 0; capture.readErrors = 0; capture.closeErrors = 0;
  capture.eof = false; capture.closed = false; capture.truncated = false;
}
function readReturned(frame: Frame, fd: unknown, buffer: unknown, offset: unknown, length: unknown,
  position: unknown, returned: number, failed: boolean): void {
  const capture = captureFor(frame, fd); if (!capture) return;
  capture.readCount++;
  if (failed) capture.readErrors++;
  else if (returned === 0) capture.eof = true;
  else if (Number.isSafeInteger(returned) && returned > 0) capture.observedBytes += returned;
  if (capture.retainedReads >= limits.readsPerCapture) { capture.droppedReads++; capture.truncated = true; return; }
  const index = (capture.slot * limits.readsPerCapture + capture.retainedReads++) * limits.fieldsPerRead;
  const slots = frame.readSlots;
  slots[index] = returned; slots[index + 1] = typeof offset === "number" ? offset : -1;
  slots[index + 2] = typeof length === "number" ? length : -1;
  slots[index + 3] = position === null ? -1 : typeof position === "number" ? position : -2;
  slots[index + 4] = capture.capturedBytes; slots[index + 5] = 0; slots[index + 6] = failed ? 1 : 0;
  if (failed) return;
  if (!Buffer.isBuffer(buffer) || !Number.isSafeInteger(returned) || returned < 0
    || typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0
    || typeof length !== "number" || !Number.isSafeInteger(length) || length < returned
    || offset + returned > buffer.length || position !== null) {
    capture.truncated = true; frame.observationErrors++; return;
  }
  if (returned === 0) return;
  const count = Math.min(returned, limits.bytesPerCapture - capture.capturedBytes);
  if (count) buffer.copy(frame.slab, capture.slot * limits.bytesPerCapture + capture.capturedBytes, offset, offset + count);
  capture.capturedBytes += count; slots[index + 5] = count;
  if (count !== returned) capture.truncated = true;
}

// This is cold analysis of the exact retained bytes, never a second proc read or
// a replacement for the product parser. Truncated captures remain incomplete.
function headerAnalysis(bytes: Buffer) {
  const text = bytes.toString("latin1"); let offset = 0, line = 0, previousEnd = 0n;
  while (offset < text.length) {
    const next = text.indexOf("\n", offset);
    if (next < 0) return { lines: line, firstRejection: { line: line + 1, byteOffset: offset, reason: "missing-final-newline" } };
    line++;
    const match = /^([0-9a-f]{1,16})-([0-9a-f]{1,16}) ([r-][w-][x-][ps]) ([0-9a-f]{1,16}) ([0-9a-f]{1,8}):([0-9a-f]{1,8}) ([0-9]{1,20})(?:[ \t][^\n]*)?$/.exec(text.slice(offset, next));
    if (!match || line > 131072) return { lines: line, firstRejection: { line, byteOffset: offset, reason: !match ? "header-shape" : "line-limit" } };
    const start = BigInt(`0x${match[1]}`), end = BigInt(`0x${match[2]}`), inode = BigInt(match[7]!);
    const reason = end <= start ? "end-not-after-start" : start < previousEnd ? "start-before-previous-end"
      : inode > (1n << 64n) - 1n ? "inode-over-uint64" : null;
    if (reason) return { lines: line, firstRejection: { line, byteOffset: offset, headerLength: match[0].length,
      start: match[1], end: match[2], permissions: match[3], offset: match[4], deviceMajor: match[5],
      deviceMinor: match[6], inode: match[7], previousEnd: previousEnd.toString(16), reason } };
    previousEnd = end; offset = next + 1;
  }
  return { lines: line, firstRejection: null };
}

/** Best-effort same-read witness around a test fixture's original plan/persist. */
export async function withSelfMapsDiagnostics<T>(operation: () => Promise<T>, outputRoot = defaultOutput): Promise<T> {
  if (process.platform !== "linux") return operation();
  // Never replace another scope's hooks or allocate a second slab while it is
  // observing. The owner records this coverage gap; the other operation still
  // runs once, immediately, outside the diagnostic context.
  if (activeFrame) { activeFrame.skippedScopes++; return context.run(undefined, operation); }
  let frame: Frame;
  try { frame = allocateFrame(); } catch { return operation(); }
  activeFrame = frame;
  const original = { openSync: fs.openSync, readSync: fs.readSync, closeSync: fs.closeSync };
  const openWrapper = function(this: unknown, file: unknown) {
    let value: number;
    try { value = Reflect.apply(original.openSync, this, arguments); }
    catch (error) { const observing = current(); if (observing && file === "/proc/self/maps") observing.openErrors++; throw error; }
    const observing = current();
    if (observing && file === "/proc/self/maps") {
      try { opened(observing, value); } catch { observing.observationErrors++; }
    }
    return value;
  } as typeof fs.openSync;
  const readWrapper = function(this: unknown, fd: unknown, buffer: unknown, offset: unknown, length: unknown, position: unknown) {
    let value: number;
    try { value = Reflect.apply(original.readSync, this, arguments); }
    catch (error) {
      const observing = current();
      if (observing) { try { readReturned(observing, fd, buffer, offset, length, position, -1, true); } catch { observing.observationErrors++; } }
      throw error;
    }
    const observing = current();
    if (observing) { try { readReturned(observing, fd, buffer, offset, length, position, value, false); } catch { observing.observationErrors++; } }
    return value;
  } as typeof fs.readSync;
  const closeWrapper = function(this: unknown, fd: unknown) {
    let value: void;
    try { value = Reflect.apply(original.closeSync, this, arguments); }
    catch (error) {
      const observing = current(), capture = observing && captureFor(observing, fd);
      if (capture) { capture.closeErrors++; capture.active = false; }
      throw error;
    }
    const observing = current(), capture = observing && captureFor(observing, fd);
    if (capture) { capture.closed = true; capture.active = false; }
    return value;
  } as typeof fs.closeSync;
  let setupComplete = false, restorationErrors = 0, operationThrew = false, operationError: unknown, result: T | undefined;
  const restore = () => {
    for (const [name, wrapper] of [["openSync", openWrapper], ["readSync", readWrapper], ["closeSync", closeWrapper]] as const) {
      try {
        if (fs[name] === wrapper) Object.assign(fs, { [name]: original[name] });
        else if (fs[name] !== original[name]) restorationErrors++;
      } catch { restorationErrors++; }
    }
    try { syncBuiltinESMExports(); } catch { restorationErrors++; }
  };
  try { fs.openSync = openWrapper; fs.readSync = readWrapper; fs.closeSync = closeWrapper; syncBuiltinESMExports(); setupComplete = true; }
  catch { frame.observationErrors++; restore(); }
  try { result = await context.run(setupComplete ? frame : undefined, operation); }
  catch (error) { operationThrew = true; operationError = error; }
  finally { frame.finished = true; restore(); activeFrame = undefined; }

  // All allocations, decoding, hashing and artifact writes below are after the
  // original outcome and hook restoration. Failure never replaces that outcome.
  if (operationThrew || !setupComplete || restorationErrors || frame.observationErrors || frame.skippedScopes) {
    try {
      await mkdir(outputRoot, { recursive: true, mode: 0o700 });
      const destination = await mkdtemp(path.join(outputRoot, "same-read-"));
      const captures = [];
      for (const capture of frame.captures.filter(value => value.ordinal).sort((a, b) => a.ordinal - b.ordinal)) {
        const bytes = frame.slab.subarray(capture.slot * limits.bytesPerCapture, capture.slot * limits.bytesPerCapture + capture.capturedBytes);
        const bytesFile = `maps-${capture.ordinal}.bin`;
        await writeFile(path.join(destination, bytesFile), bytes, { mode: 0o600, flag: "wx" });
        const reads = [];
        for (let i = 0; i < capture.retainedReads; i++) {
          const index = (capture.slot * limits.readsPerCapture + i) * limits.fieldsPerRead, slots = frame.readSlots;
          reads.push({ ordinal: i + 1, returnedBytes: slots[index], requestedOffset: slots[index + 1], requestedLength: slots[index + 2],
            position: slots[index + 3] === -1 ? null : slots[index + 3], capturedOffset: slots[index + 4],
            capturedBytes: slots[index + 5], threw: slots[index + 6] === 1 });
        }
        captures.push({ ordinal: capture.ordinal, fd: capture.fd, observedBytes: capture.observedBytes, capturedBytes: capture.capturedBytes,
          readCount: capture.readCount, droppedReads: capture.droppedReads, readErrors: capture.readErrors, closeErrors: capture.closeErrors,
          eof: capture.eof, closed: capture.closed, truncated: capture.truncated, reads, bytesFile,
          complete: setupComplete && !restorationErrors && !frame.observationErrors && !frame.skippedScopes
            && capture.eof && capture.closed && !capture.truncated && !capture.readErrors && !capture.closeErrors,
          sha256: createHash("sha256").update(bytes).digest("hex"), headerAnalysis: headerAnalysis(bytes) });
      }
      const sources = ["src/server/storage/maintenance/linux-mappings.ts", "tests/maintenance-source-facts-sqlite.test.ts",
        "tests/fixtures/maintenance-self-maps-diagnostic.ts"];
      const sourceSha256 = Object.fromEntries(await Promise.all(sources.map(async source =>
        [source, createHash("sha256").update(await readFile(path.join(root, source))).digest("hex")])));
      const report = { schema: "self-maps-same-read/v1", setupComplete, restorationErrors, operationThrew,
        scopeComplete: setupComplete && !restorationErrors && !frame.observationErrors && !frame.skippedScopes
          && !frame.evictedCaptures && !frame.openErrors && captures.length > 0 && captures.every(capture => capture.complete),
        limits, openCount: frame.opens, openErrors: frame.openErrors, evictedCaptures: frame.evictedCaptures,
        observationErrors: frame.observationErrors, skippedScopes: frame.skippedScopes,
        pid: process.pid, uid: process.getuid?.() ?? null, node: process.version, kernel: release(),
        candidate: /^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA ?? "") ? process.env.GITHUB_SHA : null,
        sourceSha256, captures,
        provenance: "Original same-call open/read/close; fixed preallocated capture and numeric event slots; no proc reread/retry. Cold header analysis is not the product outcome. Observer timing/initial allocations may affect mappings." };
      await writeFile(path.join(destination, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    } catch { /* Preserve the original result/error, including undefined. */ }
  }
  if (operationThrew) throw operationError;
  return result as T;
}

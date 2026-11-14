// Passive per-process evidence for the macOS full-suite investigation. This
// module neither changes test outcomes nor makes a process stay alive.
import { channel } from "node:diagnostics_channel";
import { execFileSync } from "node:child_process";
import { appendFileSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as schedule } from "node:timers";
import { fileURLToPath } from "node:url";

const MAX_PROCESSES = 256;
const MAX_BYTES = 128 * 1024;
const TRACE_BYTES = 96 * 1024;
const MAX_ACTIVE = 256;
const MAX_RUNNERS = 8;
const MAX_ENTRYPOINT_BYTES = 128 * 1024;
const MAX_ENTRYPOINTS = 1024;
const SNAPSHOTS = [60_000, 180_000];
// Existing tests mock Date. Keep observation timestamps on the original clock.
const WallDate = Date;
const monotonicNow = performance.now.bind(performance);

function within(root, path) {
  const result = relative(root, path);
  return result !== ".." && !result.startsWith("../") && !isAbsolute(result);
}

export function prepareEntrypoints(root) {
  // Only the actual --test parent records its tracked selection metadata. npm
  // and ordinary helpers do not create a manifest or per-test process log.
  const entries = execFileSync("git", ["-C", root, "ls-files", "-z", "--", "tests"], {
    encoding: "utf8", timeout: 3000, maxBuffer: MAX_ENTRYPOINT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  }).split("\0").filter(path => path.startsWith("tests/") && path.endsWith(".test.ts"));
  if (!entries.length || entries.length > MAX_ENTRYPOINTS) return;
  const text = JSON.stringify({ schema: "boardroom-test-entrypoints/v1", status: "READY",
    runnerPid: process.pid, ppid: process.ppid, node: process.version,
    at: new WallDate().toISOString(), source: "git ls-files", entries });
  if (Buffer.byteLength(text) > MAX_ENTRYPOINT_BYTES) return;
  const directory = join(root, ".agent-output", "macos-tests", "test-entrypoints");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (let slot = 0; slot < MAX_RUNNERS; slot++) {
    const path = join(directory, `slot-${slot}`);
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) { if (error.code === "EEXIST") continue; throw error; }
    writeFileSync(join(path, "entrypoints.json"), text + "\n", { flag: "wx", mode: 0o600 });
    return;
  }
}

function trackedEntrypoint(root, path) {
  for (let slot = 0; slot < MAX_RUNNERS; slot++) {
    const manifest = join(root, ".agent-output", "macos-tests", "test-entrypoints", `slot-${slot}`, "entrypoints.json");
    try {
      const stat = lstatSync(manifest);
      if (!stat.isFile() || stat.size > MAX_ENTRYPOINT_BYTES) continue;
      const value = JSON.parse(readFileSync(manifest, "utf8"));
      if (value.schema === "boardroom-test-entrypoints/v1" && value.status === "READY" &&
          value.runnerPid === process.ppid && Array.isArray(value.entries) &&
          value.entries.length <= MAX_ENTRYPOINTS && value.entries.includes(path)) return true;
    } catch { /* No matching ready manifest means this child is not observed. */ }
  }
  return false;
}

function entry() {
  if (process.env.NODE_TEST_CONTEXT !== "child-v8" || !process.argv[1]) return null;
  const root = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
  const requested = resolve(process.argv[1]);
  if (!requested.endsWith(".test.ts") || !lstatSync(requested).isFile()) return null;
  const path = realpathSync(requested);
  if (!within(join(root, "tests"), path)) return null;
  const selected = relative(root, path);
  if (!trackedEntrypoint(root, selected)) return null;
  return { root, path: selected };
}

function observe({ root, path }) {
  const directory = join(root, ".agent-output", "macos-tests", "test-processes");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let output;
  // Atomic slots put a hard bound on all process logs, including nested runners.
  for (let attempt = 0; attempt < MAX_PROCESSES; attempt++) {
    const slot = join(directory, `slot-${(process.pid + attempt) % MAX_PROCESSES}`);
    try { mkdirSync(slot, { mode: 0o700 }); }
    catch (error) { if (error.code === "EEXIST") continue; throw error; }
    output = join(slot, "process.jsonl");
    closeSync(openSync(output, "wx", 0o600));
    break;
  }
  if (!output) return; // Missing ready always means NOT_OBSERVED, never completion.

  const started = monotonicNow();
  let bytes = 0;
  let traceBytes = 0;
  let traceCapped = false;
  let recordingFailed = false;
  let sequence = 0;
  let startedSpans = 0;
  let endedSpans = 0;
  let errorEvents = 0;
  let unmatchedEnds = 0;
  let trackingOverflow = false;
  const ids = new WeakMap();
  const active = new Map();

  function record(event, data, control = false) {
    if (recordingFailed || (!control && traceCapped)) return;
    const line = JSON.stringify({ schema: "boardroom-test-process/v1", event,
      pid: process.pid, at: new WallDate().toISOString(),
      elapsedMs: Math.round(monotonicNow() - started), ...data }) + "\n";
    const size = Buffer.byteLength(line);
    if (!control && traceBytes + size > TRACE_BYTES) {
      traceCapped = true;
      record("trace-cap", { coverage: "TRUNCATED", traceBytes: TRACE_BYTES }, true);
      return;
    }
    if (bytes + size > MAX_BYTES) return;
    try { appendFileSync(output, line); }
    catch { recordingFailed = true; return; }
    bytes += size;
    if (!control) traceBytes += size;
  }

  function metadata(data) {
    return {
      name: typeof data.name === "string" ? data.name.slice(0, 160) : undefined,
      nesting: Number.isSafeInteger(data.nesting) ? data.nesting : undefined,
      type: data.type === "suite" ? "suite" : data.type === "test" ? "test" : "unspecified",
    };
  }

  function counts() {
    return { startedSpans, endedSpans, errorEvents, unmatchedEnds,
      observedActiveSpans: active.size, trackingOverflow, traceCapped,
      traceEvidence: startedSpans === 0 ? "NO_START_OBSERVED" : "START_OBSERVED",
      // A zero count does not cover imports, before hooks, or child output pipes.
      coverage: "OBSERVED_SPANS_ONLY_NOT_TEST_COMPLETION" };
  }

  function resources() {
    const values = process.getActiveResourcesInfo();
    const types = new Map();
    for (const value of values.slice(0, 4096)) {
      const name = value.slice(0, 64);
      if (types.has(name)) types.set(name, types.get(name) + 1);
      else if (types.size < 32) types.set(name, 1);
    }
    return { total: values.length, sampled: Math.min(values.length, 4096),
      types: Object.fromEntries(types), truncated: values.length > 4096 || types.size === 32 };
  }

  function subscribe(phase, callback) {
    channel(`tracing:node.test:${phase}`).subscribe(data => {
      // Observer failures must not throw into the application or mask its errors.
      try { if (data && typeof data === "object") callback(data); }
      catch { recordingFailed = true; }
    });
  }

  // v24.22.2 Test.run starts tracing only at body invocation, AFTER before hooks;
  // end is published in finally AFTER awaiting the body/subtests/after hooks,
  // on failure as well as success. Suite start is its declaration phase; its end
  // follows suite execution. Hooks have no separate trace; asyncStart/asyncEnd
  // are not emitted by this runner. End is not PASS. Correlate runner complete.
  // https://github.com/nodejs/node/blob/v24.22.2/lib/internal/test_runner/test.js
  subscribe("start", data => {
    startedSpans++;
    const id = ++sequence;
    ids.set(data, id);
    const value = { spanId: id, ...metadata(data), startedMs: Math.round(monotonicNow() - started) };
    if (active.size < MAX_ACTIVE) active.set(id, value);
    else trackingOverflow = true;
    record("trace-start", value);
  });
  subscribe("end", data => {
    endedSpans++;
    const id = ids.get(data);
    if (id === undefined) unmatchedEnds++;
    else active.delete(id);
    record("trace-end", { spanId: id, matchedStart: id !== undefined, ...metadata(data) });
  });
  subscribe("error", data => {
    errorEvents++;
    // Do not serialize the error, stack, cause, environment or application data.
    record("trace-error", metadata(data));
  });

  for (const afterMs of SNAPSHOTS) {
    schedule(() => {
      try {
        record("snapshot", { requestedAfterMs: afterMs, ...counts(),
          activeSample: [...active.values()].slice(0, 8), activeSampleTruncated: active.size > 8,
          resources: resources() }, true);
      } catch { recordingFailed = true; }
    }, afterMs).unref();
  }
  process.once("beforeExit", code => record("before-exit", { code, ...counts() }, true));
  process.once("exit", code => record("process-exit", { code, ...counts() }, true));
  record("observer-ready", {
    entryFile: path, ppid: process.ppid, node: process.version,
    platform: process.platform, arch: process.arch, maxBytes: MAX_BYTES,
    maxProcessLogs: MAX_PROCESSES, snapshotAfterMs: SNAPSHOTS,
    sourceSemantics: "node-v24.22.2", channels: ["start", "end", "error"],
    runtimeSourceReviewed: process.version === "v24.22.2",
    entrypointGate: "child-v8 + direct parent tracked manifest + real regular repository test entrypoint",
    coverage: "before-main-module; trace starts after before hooks; end includes failure; no asyncStart/asyncEnd",
  }, true);
}

try {
  const selected = entry();
  if (selected) observe(selected);
} catch {
  // No ready marker means observation is unavailable, not that the test ended.
  // Do not add signal/error handlers or change process.exitCode to obtain logs.
}

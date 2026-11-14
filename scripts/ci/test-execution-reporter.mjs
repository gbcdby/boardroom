// Node v24.22.2 runner.js forwards these execution-ordered events before its
// per-file pass/fail buffer. Keep the original spec reporter as a separate sink.
// https://github.com/nodejs/node/blob/v24.22.2/lib/internal/test_runner/runner.js
import { appendFileSync, closeSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareEntrypoints } from "./test-process-observer.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_RUNNERS = 8;
const RESERVED_BYTES = 4096;
const EVENTS = new Set(["test:enqueue", "test:dequeue", "test:complete", "test:summary"]);

// --import runs in isolated test children, not their parent. Reporter setup runs
// before those children are launched, so prepare the bounded tracked manifest
// here. A missing manifest/ready marker remains an explicit observation gap.
if (process.env.NODE_TEST_CONTEXT === undefined && process.execArgv.includes("--test")) {
  try { prepareEntrypoints(realpathSync(ROOT)); } catch { /* NOT_OBSERVED */ }
}

function text(value, limit = 240) {
  return typeof value === "string" ? value.slice(0, limit) : undefined;
}

function file(value) {
  if (typeof value !== "string") return undefined;
  const result = relative(ROOT, value);
  return result === ".." || result.startsWith("../") || isAbsolute(result)
    ? "[outside-repository]" : text(result, 512);
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function flag(value) {
  return typeof value === "string" ? true : typeof value === "boolean" ? value : undefined;
}

function openLog() {
  const directory = join(ROOT, ".agent-output", "macos-tests", "test-execution");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (let slot = 0; slot < MAX_RUNNERS; slot++) {
    const path = join(directory, `slot-${slot}`);
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) { if (error.code === "EEXIST") continue; throw error; }
    const output = join(path, `runner-${process.pid}.jsonl`);
    closeSync(openSync(output, "wx", 0o600));
    return output;
  }
  return null;
}

export default async function* executionReporter(source) {
  const started = performance.now();
  const encode = (event, data) => JSON.stringify({
    schema: "boardroom-test-execution/v1", event,
    at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), ...data,
  }) + "\n";
  let bytes = 0;
  let seen = 0;
  let dropped = 0;
  let capped = false;
  let sourceEnded = false;
  let output;
  try { output = openLog(); } catch { /* Missing reporter-ready is NOT_OBSERVED. */ }
  function write(line) {
    if (!output) return;
    try { appendFileSync(output, line); }
    catch { output = null; }
  }
  // NODE_OPTIONS is inherited by nested runners. A fixed destination would let
  // them truncate the parent's log. Each invocation owns an exclusive PID log;
  // this generator emits no stdout, leaving spec output intact.
  const ready = encode("reporter-ready", {
    pid: process.pid, ppid: process.ppid, node: process.version, maxBytes: MAX_BYTES,
    maxRunnerLogs: MAX_RUNNERS, runtimeSourceReviewed: process.version === "v24.22.2",
    sourceSemantics: "node-v24.22.2", events: [...EVENTS],
    completionRule: "test:complete is execution-ordered; trace/end or missing events are not PASS",
  });
  bytes += Buffer.byteLength(ready);
  write(ready);
  try {
    for await (const { type, data } of source) {
      if (!EVENTS.has(type)) continue;
      seen++;
      if (capped) { dropped++; continue; }
      const line = encode(type, {
        scope: data.entryFile === undefined ? "runner-or-summary" : "test-file",
        entryFile: file(data.entryFile), file: file(data.file), name: text(data.name),
        testId: number(data.testId), parentId: number(data.parentId),
        nesting: number(data.nesting), line: number(data.line), column: number(data.column),
        testNumber: number(data.testNumber),
        passed: typeof data.details?.passed === "boolean" ? data.details.passed : undefined,
        durationMs: number(data.details?.duration_ms),
        skipped: flag(data.skip),
        todo: flag(data.todo),
        counts: data.counts === undefined ? undefined : Object.fromEntries(
          ["tests", "passed", "failed", "cancelled", "skipped", "todo", "suites"]
            .map(key => [key, number(data.counts[key])]),
        ),
      });
      const size = Buffer.byteLength(line);
      if (bytes + size > MAX_BYTES - RESERVED_BYTES) {
        capped = true;
        dropped++;
        const marker = encode("reporter-cap", { maxBytes: MAX_BYTES, coverage: "TRUNCATED" });
        bytes += Buffer.byteLength(marker);
        write(marker);
      } else {
        bytes += size;
        write(line);
      }
    }
    sourceEnded = true;
  } finally {
    // This may be absent after a killed runner. Its absence is incomplete evidence.
    write(encode("reporter-end", { sourceEnded, seen, dropped, capped }));
  }
}

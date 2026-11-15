import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import promises from "node:fs/promises";
import { mkdtemp, mkdir, readdir, readlink, readFile, writeFile, rm, stat, realpath } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { release as kernelRelease } from "node:os";
import type { Duplex } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { runMigrations } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createSqliteMaintenanceAdapter } from "../src/server/storage/maintenance/sqlite.ts";
import { withSqliteSourceInventoryDiagnostics } from "./fixtures/maintenance-source-inventory-diagnostic.ts";
import { linuxMappingIdentity, linuxMappingIdentityAvailable, linuxSourceMappingIdentities, parseLinuxMappings } from "../src/server/storage/maintenance/linux-mappings.ts";

const linuxTest = process.platform === "linux" ? test : test.skip;
const fixtureScript = fileURLToPath(new URL("./fixtures/maintenance-linux-mapped-user.py", import.meta.url));
const row = "1000-2000 rw-s 00000000 0a:01 9007199254740993 /a path (deleted)\n";

type ThreadExitEvent = { phase: string; pid: number; leaderTid: number; workerTid: number; uid: number; gid: number;
  workerStack: number; limits: Record<string, number[]> };
function parseThreadExitEvent(line: string, phase: string, pid: number, uid: number, gid: number): ThreadExitEvent {
  assert.ok(Buffer.byteLength(line) <= 4096, "bounded thread-exit protocol");
  const value = JSON.parse(line) as ThreadExitEvent;
  assert.equal(value.phase, phase); assert.equal(value.pid, pid); assert.equal(value.leaderTid, pid);
  assert.ok(Number.isSafeInteger(value.workerTid) && value.workerTid > 0 && value.workerTid !== pid);
  assert.ok(uid > 0); assert.equal(value.uid, uid); assert.equal(value.gid, gid); assert.equal(value.workerStack, 262144);
  assert.deepEqual(value.limits, { as: [67108864, 67108864], cpu: [5, 5], core: [0, 0], nofile: [16, 16], fsize: [1048576, 1048576] });
  return value;
}
type ThreadExitOwner = { reaped(): boolean; release(): Promise<void>; wait(milliseconds: number): Promise<boolean>;
  signal(signal: "SIGTERM" | "SIGKILL"): Promise<boolean> };
async function finishThreadExitOwner(owner: ThreadExitOwner, remaining: () => number) {
  const errors: string[] = [], signals: string[] = [];
  for (const [phase, grace] of [["release", 3000], ["SIGTERM", 2000], ["SIGKILL", 2000]] as const) {
    if (owner.reaped()) break;
    try {
      if (phase === "release") await owner.release();
      else if (!owner.reaped()) {
        if (await owner.signal(phase)) signals.push(phase); else errors.push(`${phase}-not-sent`);
      }
    } catch { errors.push(phase); }
    const milliseconds = Math.max(0, Math.min(grace, remaining()));
    if (!milliseconds) { errors.push("deadline"); break; }
    try { if (await owner.wait(milliseconds)) break; } catch { errors.push(`${phase}-wait`); }
  }
  return { reaped: owner.reaped(), errors, signals };
}

function threadIncarnation(text: string, pid: number) {
  const end = text.lastIndexOf(") "), fields = text.slice(end + 2).trim().split(/\s+/);
  assert.equal(/^([1-9][0-9]*) \(/.exec(text)?.[1], String(pid)); assert.ok(end > 0);
  assert.match(fields[19] ?? "", /^[0-9]+$/);
  return { pid, startTicks: fields[19]!, state: fields[0]!, threads: fields[17]! };
}

type InventoryRead = { bytes: number; eof: boolean; closed: boolean; endsWithNewline: boolean;
  identity?: { pid: string | null; startTicks: string | null } };
type InventoryProc = { stats: InventoryRead[]; maps: InventoryRead[]; uids: string[]; fdDirectoryCounts: number[];
  errors: { originalHandling: string }[]; unfinished: unknown[] };
function threadExitInputFacts(proc: InventoryProc, pid: number, startTicks: string, uid: number) {
  const completeRead = (read: InventoryRead) => read.bytes > 0 && read.eof && read.closed && read.endsWithNewline;
  const sameIdentity = (read: InventoryRead) => read.identity?.pid === String(pid) && read.identity.startTicks === startTicks;
  const syscallErrors = proc.errors.filter(item => item.originalHandling !== "ignored-fd-race").length;
  const statComplete = proc.stats.length >= 2 && proc.stats.every(read => completeRead(read) && sameIdentity(read));
  const uidComplete = proc.uids.length >= 2 && proc.uids.every(value => value === String(uid));
  const mapsComplete = proc.maps.length === 1 && proc.maps.every(completeRead);
  const fdDirectoryObserved = proc.fdDirectoryCounts.length === 1;
  const incomplete = syscallErrors > 0 || proc.stats.some(read => !completeRead(read) || !sameIdentity(read))
    || proc.maps.some(read => !completeRead(read)) || proc.uids.some(value => value !== String(uid));
  return { syscallErrors, statComplete, uidComplete, mapsComplete, fdDirectoryObserved,
    unfinishedReads: proc.unfinished.length, confirmedIncompleteInput: incomplete,
    completeInput: statComplete && uidComplete && mapsComplete && fdDirectoryObserved && !syscallErrors && !proc.unfinished.length };
}
function threadExitCompileTimeout(remaining: number) {
  const milliseconds = Math.floor(Math.min(30_000, remaining));
  assert.ok(Number.isFinite(remaining) && Number.isSafeInteger(milliseconds) && milliseconds > 0, "compile deadline exhausted before spawn");
  return milliseconds;
}

linuxTest("#152 a joined leader and live worker retain one original inventory observation per phase", { timeout: 30_000 }, async t => {
  const started = performance.now(), remaining = () => 30_000 - (performance.now() - started);
  const attemptDirectory = path.join(process.cwd(), ".agent-output", "maintenance-native-diagnostics", "thread-exit");
  // An explicitly authorized preparation continuation keeps the same one-child claim.
  // It cannot follow an attempted compile or child, and ordinary CI never selects it.
  const continuation = process.env.BOARDROOM_SCA_THREAD_EXIT_CONTINUATION === "1";
  const directory = continuation ? `${attemptDirectory}-continuation` : attemptDirectory;
  await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 }); // Existing attempt evidence is never overwritten or reused.
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const record: Record<string, unknown> = { kind: "test-only-thread-exit-observation", candidate: process.env.GITHUB_SHA ?? null,
    node: process.version, kernel: kernelRelease(), platform: process.platform, architecture: process.arch,
    uid: process.getuid!(), gid: process.getgid!(), qualification: "no historical CI207 root-cause or provider qualification claim" };
  let f: Awaited<ReturnType<typeof fixture>> | undefined, child: ReturnType<typeof spawn> | undefined;
  let releasePipe: Duplex | undefined, identity: ReturnType<typeof threadIncarnation> | undefined;
  let closed = false, exited = false, exitResult: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let resolveClosed: () => void = () => {}; const done = new Promise<void>(resolve => { resolveClosed = resolve; });
  const timers = new Set<NodeJS.Timeout>(), stdout: Buffer[] = [], stderr: Buffer[] = [], lines: string[] = [];
  let stdoutBytes = 0, stderrBytes = 0, pending = "", notify: (() => void) | undefined, transportError: Error | undefined;
  const cleanupErrors: string[] = [], signalHistory: string[] = [];
  const waitClosed = async (milliseconds: number) => {
    if (closed) return true;
    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => { timers.delete(timer); resolve(false); }, milliseconds); timers.add(timer);
      void done.then(() => { clearTimeout(timer); timers.delete(timer); resolve(true); });
    });
  };
  const nextEvent = async (phase: string) => {
    const deadline = performance.now() + Math.min(5000, Math.max(0, remaining() - 7000));
    while (!lines.length) {
      if (transportError) throw transportError;
      assert.equal(closed, false, "owned helper exited before its phase handshake");
      const milliseconds = deadline - performance.now(); assert.ok(milliseconds > 0, "owned helper phase deadline");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { timers.delete(timer); notify = undefined; reject(new Error("owned helper phase timeout")); }, milliseconds);
        timers.add(timer); notify = () => { clearTimeout(timer); timers.delete(timer); notify = undefined; resolve(); };
      });
    }
    if (transportError) throw transportError;
    return parseThreadExitEvent(lines.shift()!, phase, child!.pid!, process.getuid!(), process.getgid!());
  };
  try {
    assert.ok(process.getuid!() > 0, "ordinary UID required");
    if (continuation) {
      const priorBytes = await readFile(path.join(attemptDirectory, "RESULT.json")), prior = JSON.parse(priorBytes.toString("utf8"));
      assert.equal(prior.originalError?.name, "RangeError"); assert.match(prior.originalError.message, /timeout.*unsigned integer/);
      assert.equal(prior.compile, undefined); assert.equal(prior.ready, undefined); assert.equal(prior.joined, undefined);
      assert.equal(prior.exit, null); assert.equal(prior.exitObserved, false); assert.equal(prior.closeObserved, false);
      assert.equal(fs.existsSync(path.join(attemptDirectory, "EXECUTION-ATTEMPT.json")), false);
      assert.equal(fs.existsSync(path.join(attemptDirectory, "thread-exit")), false);
      record.continuationOf = { path: path.join(attemptDirectory, "RESULT.json"), sha256: digest(priorBytes), candidate: prior.candidate };
    }
    record.parentStatus = await readFile("/proc/self/status", "utf8");
    const source = fileURLToPath(new URL("./fixtures/maintenance-linux-thread-exit.c", import.meta.url));
    const binary = path.join(directory, "thread-exit"), compiler = await realpath("/usr/bin/cc");
    const version = spawnSync(compiler, ["--version"], { encoding: "utf8", timeout: Math.min(5000, threadExitCompileTimeout(remaining())), maxBuffer: 65536 });
    assert.equal(version.status, 0); assert.equal(version.error, undefined);
    const argv = ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-pthread", source, "-o", binary];
    const compileStarted = performance.now();
    const compile = spawnSync(compiler, argv, { encoding: "utf8", timeout: threadExitCompileTimeout(remaining()),
      killSignal: "SIGKILL", maxBuffer: 65536 });
    record.compile = { compiler, compilerSha256: digest(await readFile(compiler)), version: version.stdout,
      argv, sourceSha256: digest(await readFile(source)), status: compile.status, signal: compile.signal,
      elapsedMs: performance.now() - compileStarted, stdout: compile.stdout, stderr: compile.stderr };
    assert.equal(compile.status, 0); assert.equal(compile.error, undefined);
    const elf = spawnSync("/usr/bin/readelf", ["-W", "-l", "-d", "-n", binary], { encoding: "utf8", timeout: Math.min(5000, threadExitCompileTimeout(remaining())), maxBuffer: 65536 });
    assert.equal(elf.status, 0); assert.equal(elf.error, undefined);
    record.binary = { sha256: digest(await readFile(binary)), bytes: (await stat(binary)).size, elf: elf.stdout };
    record.sourceSha256 = Object.fromEntries(await Promise.all([
      "src/server/storage/maintenance/linux-mappings.ts", "src/server/storage/maintenance/sqlite.ts",
      "tests/fixtures/maintenance-source-inventory-diagnostic.ts", "tests/maintenance-linux-mappings.test.ts",
      "tests/fixtures/maintenance-linux-thread-exit.c",
    ].map(async file => [file, digest(await readFile(path.join(process.cwd(), file)))])));
    f = await fixture(); assert.ok(remaining() > 12_000, "retain handshake and cleanup budget before spawn");
    const claimPath = path.join(attemptDirectory, "EXECUTION-ATTEMPT.json"); record.claimPath = claimPath;
    await writeFile(claimPath, JSON.stringify({ pid: process.pid, outputDirectory: directory,
      candidate: record.candidate, sourceSha256: record.sourceSha256, binary: record.binary, maximumChildCount: 1 }) + "\n",
      { flag: "wx", mode: 0o600 });
    child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
    releasePipe = child.stdio[3] as Duplex;
    child.once("error", error => { transportError = error; notify?.(); });
    child.once("exit", (code, signal) => { exited = true; exitResult = { code, signal }; notify?.(); });
    child.once("close", (code, signal) => { closed = true; exitResult = { code, signal }; resolveClosed(); notify?.(); });
    child.stdin!.on("error", () => {}); releasePipe.on("error", () => {});
    child.stdout!.on("data", (value: Buffer) => {
      stdoutBytes += value.length;
      if (stdoutBytes > 4096) { transportError = new Error("owned helper stdout limit"); notify?.(); return; }
      stdout.push(Buffer.from(value)); pending += value.toString("utf8");
      while (pending.includes("\n")) { const end = pending.indexOf("\n"); lines.push(pending.slice(0, end)); pending = pending.slice(end + 1); }
      if (lines.length > 3) transportError = new Error("owned helper event limit"); notify?.();
    });
    child.stderr!.on("data", (value: Buffer) => {
      stderrBytes += value.length;
      if (stderrBytes > 4096) { transportError = new Error("owned helper stderr limit"); notify?.(); return; }
      stderr.push(Buffer.from(value));
    });
    const ready = await nextEvent("READY"); record.ready = ready;
    identity = threadIncarnation(await readFile(`/proc/${child.pid}/stat`, "utf8"), child.pid!);
    record.initialIdentity = identity;
    record.childStatus = await readFile(`/proc/${child.pid}/status`, "utf8");
    const phaseResults: object[] = [];
    await withSqliteSourceInventoryDiagnostics(f.adapter, async phase => {
      phase("baseline");
      const baseline = await f!.adapter.inspectWriters(await f!.adapter.observe());
      phaseResults.push({ phase: "baseline", blockers: baseline }); record.phaseResults = phaseResults;
      assert.deepEqual(baseline, [], "baseline must be complete; no retries for unrelated blockers");
      child!.stdin!.end("L");
      const joined = await nextEvent("LEADER_JOINED"); record.joined = joined;
      assert.equal(joined.workerTid, ready.workerTid); assert.equal(exited, false);
      phase("leader-joined");
      const result = await f!.adapter.inspectWriters(await f!.adapter.observe());
      phaseResults.push({ phase: "leader-joined", blockers: result });
      assert.equal(exited, false, "worker remains owned and alive during the original scan");
      return result;
    }, path.join(directory, "inventory"), child.pid);
    const reports = await readdir(path.join(directory, "inventory")); assert.equal(reports.length, 1);
    const reportBytes = await readFile(path.join(directory, "inventory", reports[0]!, "report.json"));
    assert.ok(reportBytes.length <= 1024 * 1024);
    const report = JSON.parse(reportBytes.toString("utf8"));
    record.inventoryReport = { path: `inventory/${reports[0]}/report.json`, sha256: digest(reportBytes) };
    assert.equal(report.inspectionCalls, 2); assert.equal(report.observations.length, 2);
    assert.equal(report.setupComplete, true); assert.equal(report.restorationErrors, 0);
    assert.equal(report.ownedPid, child.pid); assert.equal(report.droppedFailures, 0);
    assert.equal(report.requestEvidenceState, "OBSERVED"); assert.equal(report.droppedObservations, 0);
    assert.deepEqual(report.observations.map((item: { inspection: number; phase: string; pid: number }) => [item.inspection, item.phase, item.pid]),
      [[1, "baseline", child.pid], [2, "leader-joined", child.pid]]);
    const inputFacts = report.observations.map((item: { evidenceState: string; frame: InventoryProc }) => {
      assert.equal(item.evidenceState, "OBSERVED");
      return threadExitInputFacts(item.frame, child!.pid!, identity!.startTicks, process.getuid!());
    });
    record.originalInputFacts = inputFacts;
    assert.equal(report.observations[0].result, "CLEAR"); assert.equal(inputFacts[0].completeInput, true);
    const current = report.observations[1], proc = current.frame;
    assert.ok(["CLEAR", "BLOCKERS"].includes(current.result));
    record.mechanism = { originalResult: current.result, sameCallIncompleteInput: inputFacts[1].confirmedIncompleteInput,
      stageHint: proc.stageHint, historicalCause: "UNKNOWN" };
    if (current.result === "CLEAR") {
      assert.equal(inputFacts[1].confirmedIncompleteInput, false, "live worker with confirmed incomplete original input was reported clear");
      assert.equal(inputFacts[1].completeInput, true, "clear result lacks sufficient same-call input evidence");
    }
  } catch (error) {
    record.originalError = error instanceof Error ? { name: error.name, message: error.message } : { name: "non-Error" };
    throw error;
  } finally {
    if (child) {
      const owned = child;
      record.cleanup = await finishThreadExitOwner({ reaped: () => closed,
        async release() { owned.stdin?.end(); if (releasePipe && !releasePipe.destroyed) releasePipe.end("Q"); }, wait: waitClosed,
        async signal(signal) {
          if (closed || owned.exitCode !== null || owned.signalCode !== null) return false;
          if (identity) {
            const current = threadIncarnation(await readFile(`/proc/${owned.pid}/stat`, "utf8"), owned.pid!);
            assert.equal(current.startTicks, identity.startTicks, "signal must address the owned incarnation");
          }
          const sent = owned.kill(signal); if (sent) signalHistory.push(signal); return sent;
        },
      }, remaining);
      owned.stdin?.destroy(); releasePipe?.destroy(); owned.stdout?.destroy(); owned.stderr?.destroy();
      record.transportClosed = [owned.stdin, releasePipe, owned.stdout, owned.stderr].every(stream => !stream || stream.destroyed);
      if (closed && exitResult?.code === 0) {
        try {
          assert.equal(lines.length, 1); assert.equal(pending, "");
          record.done = parseThreadExitEvent(lines[0]!, "DONE", owned.pid!, process.getuid!(), process.getgid!());
        } catch { cleanupErrors.push("done-handshake"); }
      }
      if (closed && identity) {
        try { record.ownedIncarnationGone = threadIncarnation(await readFile(`/proc/${owned.pid}/stat`, "utf8"), owned.pid!).startTicks !== identity.startTicks; }
        catch (error) { record.ownedIncarnationGone = (error as NodeJS.ErrnoException).code === "ENOENT"; }
      }
    }
    for (const timer of timers) clearTimeout(timer); timers.clear(); notify = undefined;
    if (f && (!child || closed)) try { await f.close(); } catch { cleanupErrors.push("fixture-close"); }
    if (child && !closed) cleanupErrors.push("owned-child-not-reaped");
    record.exit = exitResult ?? null; record.exitObserved = exited; record.closeObserved = closed;
    record.transportError = transportError ? { name: transportError.name, message: transportError.message } : null;
    if (transportError) cleanupErrors.push("transport-error");
    record.stdoutBytes = stdoutBytes; record.stderrBytes = stderrBytes; record.signals = signalHistory;
    record.cleanupErrors = cleanupErrors; record.elapsedMs = performance.now() - started;
    try {
      await writeFile(path.join(directory, "stdout.raw"), Buffer.concat(stdout), { flag: "wx", mode: 0o600 });
      await writeFile(path.join(directory, "stderr.raw"), Buffer.concat(stderr), { flag: "wx", mode: 0o600 });
      const bytes = JSON.stringify(record, null, 2) + "\n"; assert.ok(Buffer.byteLength(bytes) <= 1024 * 1024);
      await writeFile(path.join(directory, "RESULT.json"), bytes, { flag: "wx", mode: 0o600 });
    } catch { cleanupErrors.push("evidence-write"); }
    t.diagnostic(JSON.stringify({ control: "one-owned-thread-exit-child", output: directory,
      elapsedMs: record.elapsedMs, exit: record.exit, cleanup: record.cleanup, cleanupErrors }));
  }
  assert.equal(record.transportClosed, true); assert.equal(record.ownedIncarnationGone, true);
  assert.deepEqual(record.cleanup, { reaped: true, errors: [], signals: [] });
  assert.ok(stdoutBytes <= 4096); assert.ok(stderrBytes <= 4096);
  assert.deepEqual(exitResult, { code: 0, signal: null }); assert.deepEqual(signalHistory, []);
  assert.deepEqual(cleanupErrors, []); assert.ok(Number(record.elapsedMs) <= 30_000);
});

test("#152 thread-exit protocol rejects a changed identity or unproved resource bounds", () => {
  const message = { phase: "READY", pid: 1101, leaderTid: 1101, workerTid: 1102, uid: 1000, gid: 1000,
    workerStack: 262144, limits: { as: [67108864, 67108864], cpu: [5, 5], core: [0, 0], nofile: [16, 16], fsize: [1048576, 1048576] } };
  assert.deepEqual(parseThreadExitEvent(JSON.stringify(message), "READY", 1101, 1000, 1000), message);
  for (const changed of [ { ...message, pid: 1103 }, { ...message, leaderTid: 1103 },
    { ...message, workerTid: 1101 }, { ...message, uid: 0 }, { ...message, phase: "LEADER_JOINED" },
    { ...message, workerStack: 8388608 }, { ...message, limits: { ...message.limits, as: [67108864, -1] } } ]) {
    assert.throws(() => parseThreadExitEvent(JSON.stringify(changed), "READY", 1101, 1000, 1000));
  }
  assert.throws(() => parseThreadExitEvent("x".repeat(4097), "READY", 1101, 1000, 1000));
});

test("#152 thread-exit compile budget rejects an expired or submillisecond deadline before spawn", () => {
  for (const remaining of [0, -1, 0.5, NaN, Infinity]) assert.throws(() => threadExitCompileTimeout(remaining));
  assert.equal(threadExitCompileTimeout(29916.459201), 29916);
  assert.equal(threadExitCompileTimeout(1.5), 1); assert.equal(threadExitCompileTimeout(30_001), 30_000);
});

test("#152 thread-exit cleanup escalates only for the owned unreaped child", async () => {
  for (const phase of ["already-reaped", "release", "TERM", "KILL"] as const) {
    const events: string[] = []; let closed = phase === "already-reaped", current = "release";
    const owner = { reaped: () => closed, async release() { events.push("release"); },
      async wait(milliseconds: number) { events.push(`wait:${milliseconds}`); if (phase === current) closed = true; return closed; },
      async signal(signal: "SIGTERM" | "SIGKILL") { assert.equal(closed, false); events.push(signal); current = signal.slice(3); return true; } };
    const result = await finishThreadExitOwner(owner, () => 30_000);
    assert.equal(result.reaped, true); assert.deepEqual(result.errors, []);
    assert.deepEqual(events, phase === "already-reaped" ? [] : phase === "release" ? ["release", "wait:3000"]
      : phase === "TERM" ? ["release", "wait:3000", "SIGTERM", "wait:2000"]
        : ["release", "wait:3000", "SIGTERM", "wait:2000", "SIGKILL", "wait:2000"]);
  }
  let waits = 0;
  const result = await finishThreadExitOwner({ reaped: () => false,
    async release() { throw new Error("release fault"); }, async wait() { waits++; return false; },
    async signal() { throw new Error("identity unavailable"); } }, () => 30_000);
  assert.equal(result.reaped, false); assert.equal(waits, 3);
  assert.deepEqual(result.errors, ["release", "SIGTERM", "SIGKILL"]);
});

test("#152 thread-exit evidence distinguishes complete, incomplete and missing original inputs", () => {
  const read = { bytes: 100, eof: true, closed: true, endsWithNewline: true };
  const proc: InventoryProc = { stats: [0, 1].map(() => ({ ...read, identity: { pid: "1101", startTicks: "123" } })),
    maps: [{ ...read }], uids: ["1000", "1000"], fdDirectoryCounts: [4], errors: [], unfinished: [] };
  assert.equal(threadExitInputFacts(proc, 1101, "123", 1000).completeInput, true);
  const missing = threadExitInputFacts({ ...proc, maps: [] }, 1101, "123", 1000);
  assert.equal(missing.completeInput, false); assert.equal(missing.confirmedIncompleteInput, false);
  const empty = threadExitInputFacts({ ...proc, maps: [{ ...read, bytes: 0, endsWithNewline: false }] }, 1101, "123", 1000);
  assert.equal(empty.completeInput, false); assert.equal(empty.confirmedIncompleteInput, true);
  for (const changed of [ { ...proc, uids: ["1001", "1001"] }, { ...proc, errors: [{ originalHandling: "requires-original-path-context" }] } ]) {
    const fact = threadExitInputFacts(changed, 1101, "123", 1000);
    assert.equal(fact.completeInput, false); assert.equal(fact.confirmedIncompleteInput, true);
  }
});

test("#152 Linux maps uses exact kernel device/inode, preserves readonly users, and ignores display-path identity", () => {
  const identity = linuxMappingIdentity("pos:\t0\nflags:\t02500000\nmnt_id:\t287\nino:\t9007199254740993\n",
    "287 261 10:1 / /fixture rw - overlay overlay rw\n");
  assert.equal(identity, "10:1:9007199254740993");
  assert.equal(parseLinuxMappings(row)[0]!.mappedIdentity, identity);
  assert.equal(parseLinuxMappings(row.replace("/a path (deleted)", "/unrelated display name"))[0]!.mappedIdentity, identity);
  assert.equal(parseLinuxMappings(row.replace("rw-s", "r--p"))[0]!.mappedIdentity, identity);
  assert.notEqual(parseLinuxMappings(row.replace("0a:01", "0a:02"))[0]!.mappedIdentity, identity);
  assert.notEqual(parseLinuxMappings(row.replace("9007199254740993", "9007199254740992"))[0]!.mappedIdentity, identity);
});

test("#152 incomplete, malformed, overlapping maps and ambiguous source metadata stay unknown", () => {
  for (const text of [row.slice(0, -1), "not maps\n", row + row, row.replace("2000", "1000"),
    row.replace("rw-s", "rwxq"), row.replace("9007199254740993", "18446744073709551616"), "x".repeat(8 * 1024 * 1024 + 1)])
    assert.throws(() => parseLinuxMappings(text), /inventory_unavailable/);
  const info = "mnt_id:\t287\nino:\t99\n", mounts = "287 261 0:27 / /fixture rw - overlay overlay rw\n";
  for (const [fdinfo, mountinfo] of [[info + "ino:\t100\n", mounts], [info, mounts + mounts], [info, ""], [info.slice(0, -1), mounts]])
    assert.throws(() => linuxMappingIdentity(fdinfo!, mountinfo!), /inventory_unavailable/);
  assert.equal(linuxMappingIdentityAvailable("6.7.12"), false);
  assert.equal(linuxMappingIdentityAvailable("unknown"), false);
  assert.equal(linuxMappingIdentityAvailable("6.8.0-azure"), true);
  assert.equal(linuxMappingIdentityAvailable("6.18.57"), true);
});

async function fixture() {
  const dir = await mkdtemp(path.join(process.cwd(), "br-linux-mapped-")), file = path.join(dir, "agent-studio.db");
  const db = new Database(file); runMigrations(db, migrations); db.pragma("journal_mode=WAL"); db.close();
  const info = await stat(file, { bigint: true });
  const descriptor = { kind: "sqlite" as const, dataDir: dir, sourcePath: file, sqlitePath: file,
    identity: { device: String(info.dev), inode: String(info.ino) } };
  const adapter = await createSqliteMaintenanceAdapter(descriptor);
  return { dir, file, adapter, descriptor, async close() { await adapter.close(); await rm(dir, { recursive: true, force: true }); } };
}
async function startUser(file: string, mode: string) {
  const child = spawn("/usr/bin/python3", [fixtureScript, file, mode], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("close", (code, signal) => resolve({ code, signal })); child.once("error", reject);
  });
  try {
    const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
      let text = "", errors = "";
      const timer = setTimeout(() => reject(new Error("own mapped-user readiness timeout")), 5000);
      child.stderr.on("data", value => { errors += String(value); });
      child.stdout.on("data", value => {
        text += String(value); if (!text.includes("\n")) return;
        clearTimeout(timer); try { resolve(JSON.parse(text.split("\n")[0]!)); } catch (error) { reject(error); }
      });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", () => { clearTimeout(timer); if (!text.includes("\n")) reject(new Error(errors || "own child exited before readiness")); });
    });
    return { child, ready, async stop() {
      child.stdin.end("finish\n");
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      try { return await exited; } finally { clearTimeout(timer); }
    } };
  } catch (error) { child.kill("SIGKILL"); await exited.catch(() => undefined); throw error; }
}

// Setup/release need a current complete inventory; an unrelated same-UID process can change between scans.
// This bounded test-only observation never reclassifies blockers or retries the live-user/fault assertions.
async function assertCompleteInventory(t: TestContext, f: Awaited<ReturnType<typeof fixture>>,
  phase: "PREPARE" | "RELEASE", ownPid?: number) {
  const started = performance.now();
  for (let attempt = 1; attempt <= 4; attempt++) {
    const attemptStarted = performance.now();
    assert.ok(attemptStarted - started < 2000, `${phase}: complete inventory window exhausted`);
    let operation = "observe", blockers: Awaited<ReturnType<typeof f.adapter.inspectWriters>> | undefined;
    try {
      const observation = await f.adapter.observe(); operation = "inspectWriters";
      blockers = await f.adapter.inspectWriters(observation); operation = "complete";
    } finally {
      t.diagnostic(JSON.stringify({ phase, attempt, operation, ownPid: ownPid ?? null, testPid: process.pid,
        elapsedMs: performance.now() - started, attemptElapsedMs: performance.now() - attemptStarted, blockers: blockers ?? null }));
    }
    // Await the complete scan, but never accept even a clear result that arrived outside the fixed window.
    assert.ok(performance.now() - started <= 2000, `${phase}: complete inventory exceeded 2 seconds`);
    if (blockers.length === 0) { assert.deepEqual(blockers, []); return; }
    const mayObserveAgain = blockers.every(blocker => {
      const pid = /^unreadable-process:([1-9][0-9]*)$/.exec(blocker.subjectRef ?? "")?.[1];
      return blocker.code === "source_writer_unknown" && pid !== undefined && pid !== String(process.pid)
        && (phase !== "RELEASE" || pid !== String(ownPid));
    });
    if (!mayObserveAgain || attempt === 4) assert.deepEqual(blockers, []);
    await new Promise<void>(resolve => setTimeout(resolve, 50));
  }
}

for (const mode of ["shared-writer", "private-reader", "fd-reader"]) linuxTest(`#152 real Linux ${mode} remains a blocker until the same-UID process releases its source`, async t => {
  const f = await fixture(); let user: Awaited<ReturnType<typeof startUser>> | undefined;
  try {
    await assertCompleteInventory(t, f, "PREPARE");
    user = await startUser(f.file, mode);
    assert.equal(user.ready.uid, process.getuid!());
    const sourceFds = [];
    for (const fd of await readdir(`/proc/${user.child.pid}/fd`)) {
      try { if ((await readlink(`/proc/${user.child.pid}/fd/${fd}`)) === f.file) sourceFds.push(fd); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (mode === "fd-reader") assert.equal(sourceFds.length, 1);
    else {
      assert.deepEqual(sourceFds, []); assert.equal(user.ready.sourceFdClosed, true);
      const actual = parseLinuxMappings(`${user.ready.mapping}\n`)[0]!;
      const source = linuxSourceMappingIdentities([f.file])[0]!;
      assert.equal(actual.mappedIdentity, source.mappedIdentity);
      assert.equal(source.identity, `${f.descriptor.identity.device}:${f.descriptor.identity.inode}`);
      if (mode === "shared-writer") assert.equal(user.ready.sameByteWrite, true);
      t.diagnostic(JSON.stringify({ sourceStat: f.descriptor.identity, sourceKernelIdentity: source.mappedIdentity, child: user.ready, sourceFds }));
    }
    const blockers = await f.adapter.inspectWriters(await f.adapter.observe());
    assert.ok(blockers.some(blocker => blocker.code === "source_writer_unknown" && blocker.subjectRef === `os-process:${user!.child.pid}`));
    const ownPid = user.child.pid!;
    assert.deepEqual(await user.stop(), { code: 0, signal: null }); user = undefined;
    await assertCompleteInventory(t, f, "RELEASE", ownPid);
  } finally { await user?.stop(); await f.close(); }
});

linuxTest("#152 per-process maps access, partial/empty data and observation limits never produce a clear inventory", async t => {
  const f = await fixture(); const user = await startUser(f.file, "idle");
  try {
    const observation = await f.adapter.observe();
    for (const fault of ["EACCES", "EPERM", "ENOENT", "malformed", "empty", "over-limit", "identity-changed"]) {
      const processFds = new Set<number>(), mapFds = new Set<number>(), changedStatFds = new Set<number>(); let reads = 0, injected = 0;
      const original = { open: fs.openSync, close: fs.closeSync, read: fs.readSync };
      t.mock.method(fs, "openSync", ((file: fs.PathLike, ...args: unknown[]) => {
        const name = String(file), match = /^\/proc\/self\/fd\/([0-9]+)\/maps$/.exec(name);
        const target = match && processFds.has(Number(match[1]));
        if (target) { injected++; if (["EACCES", "EPERM", "ENOENT"].includes(fault)) throw Object.assign(new Error(fault), { code: fault }); }
        const fd = Reflect.apply(original.open, fs, [file, ...args]) as number;
        if (name === `/proc/${user.child.pid}`) processFds.add(fd);
        if (target) mapFds.add(fd);
        const identity = /^\/proc\/self\/fd\/([0-9]+)\/stat$/.exec(name);
        if (fault === "identity-changed" && injected && identity && processFds.has(Number(identity[1]))) changedStatFds.add(fd);
        return fd;
      }) as typeof fs.openSync);
      t.mock.method(fs, "readSync", ((fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
        if (changedStatFds.has(fd)) {
          const size = original.read(fd, buffer, offset, length, position);
          if (!size) return size;
          const text = buffer.toString("latin1", offset, offset + size), end = text.lastIndexOf(") ");
          const fields = text.slice(end + 2).trim().split(/\s+/); fields[19] = String(BigInt(fields[19]!) + 1n);
          const changed = text.slice(0, end + 2) + fields.join(" ") + "\n";
          assert.ok(Buffer.byteLength(changed) <= length);
          return buffer.write(changed, offset, length, "latin1");
        }
        if (!mapFds.has(fd) || fault === "identity-changed") return original.read(fd, buffer, offset, length, position);
        reads++;
        if (fault === "empty" || (fault === "malformed" && reads > 1)) return 0;
        const text = fault === "malformed" ? "incomplete maps row\n" : "x".repeat(length);
        return buffer.write(text, offset, Math.min(length, Buffer.byteLength(text)), "latin1");
      }) as typeof fs.readSync);
      t.mock.method(fs, "closeSync", (fd: number) => { processFds.delete(fd); mapFds.delete(fd); changedStatFds.delete(fd); original.close(fd); });
      syncBuiltinESMExports();
      try {
        const blockers = await f.adapter.inspectWriters(observation);
        assert.ok(injected > 0, `${fault}: reached the original child maps operation`);
        assert.ok(blockers.some(blocker => blocker.code === "source_writer_unknown" && blocker.subjectRef === `unreadable-process:${user.child.pid}`), fault);
        assert.ok(reads <= 130, `${fault}: read budget remains bounded`);
        assert.equal(user.child.exitCode, null);
      } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    }
    assert.deepEqual(await user.stop(), { code: 0, signal: null });
    assert.deepEqual(await f.adapter.inspectWriters(await f.adapter.observe()), []);
  } finally { if (user.child.exitCode === null) await user.stop(); await f.close(); }
});

linuxTest("#152 an observed exit during the pinned proc walk is distinguished from a missing maps file on a live process", async t => {
  const f = await fixture(), user = await startUser(f.file, "shared-writer"); let released = false;
  try {
    const observation = await f.adapter.observe(), original = promises.readdir;
    t.mock.method(promises, "readdir", (async (file: fs.PathLike, ...args: unknown[]) => {
      const result = await Reflect.apply(original, promises, [file, ...args]);
      const match = /^\/proc\/self\/fd\/([0-9]+)\/fd$/.exec(String(file));
      if (match && !released && fs.readlinkSync(`/proc/self/fd/${match[1]}`) === `/proc/${user.child.pid}`) {
        assert.deepEqual(await user.stop(), { code: 0, signal: null }); released = true;
      }
      return result;
    }) as typeof promises.readdir);
    syncBuiltinESMExports();
    try { assert.deepEqual(await f.adapter.inspectWriters(observation), []); assert.equal(released, true); }
    finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  } finally { if (!released) await user.stop(); await f.close(); }
});


linuxTest("#152 inventory diagnostics distinguish original denied, missing-live, partial maps and incarnation faults", async t => {
  const f = await fixture(), user = await startUser(f.file, "idle");
  try {
    for (const fault of ["EACCES", "ENOENT", "partial-maps", "identity-changed"] as const) await t.test(fault, async st => {
      const original = { open: fs.openSync, read: fs.readSync, close: fs.closeSync };
      const pins = new Set<number>(), maps = new Set<number>(), laterStats = new Set<number>();
      let mapsOpened = false, mapReads = 0, injections = 0;
      const output = path.join(f.dir, `diagnostic-${fault}`);
      st.mock.method(fs, "openSync", ((file: fs.PathLike, ...args: unknown[]) => {
        const name = String(file), mapped = /^\/proc\/self\/fd\/([0-9]+)\/maps$/.exec(name);
        const target = mapped !== null && pins.has(Number(mapped[1]));
        if (target) {
          mapsOpened = true;
          if (fault === "EACCES" || fault === "ENOENT") { injections++; throw Object.assign(new Error("private diagnostic canary"), { code: fault, syscall: "open" }); }
        }
        const fd = Reflect.apply(original.open, fs, [file, ...args]) as number;
        if (name === `/proc/${user.child.pid}`) pins.add(fd);
        if (target) maps.add(fd);
        const identity = /^\/proc\/self\/fd\/([0-9]+)\/stat$/.exec(name);
        if (fault === "identity-changed" && mapsOpened && identity && pins.has(Number(identity[1]))) laterStats.add(fd);
        return fd;
      }) as typeof fs.openSync);
      st.mock.method(fs, "readSync", ((fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
        if (maps.has(fd) && fault === "partial-maps") {
          mapReads++; if (mapReads > 1) return 0;
          injections++; return buffer.write(row.slice(0, -1), offset, length, "latin1");
        }
        const size = original.read(fd, buffer, offset, length, position);
        if (laterStats.has(fd) && size) {
          const value = buffer.toString("latin1", offset, offset + size), end = value.lastIndexOf(") ");
          const fields = value.slice(end + 2).trim().split(/\s+/); fields[19] = String(BigInt(fields[19]!) + 1n);
          const changed = value.slice(0, end + 2) + fields.join(" ") + "\n";
          assert(changed.length <= length); injections++; return buffer.write(changed, offset, length, "latin1");
        }
        return size;
      }) as typeof fs.readSync);
      st.mock.method(fs, "closeSync", (fd: number) => { pins.delete(fd); maps.delete(fd); laterStats.delete(fd); original.close(fd); });
      syncBuiltinESMExports();
      try {
        const observed = await f.adapter.observe(); let originalResult: unknown;
        const returned = await withSqliteSourceInventoryDiagnostics(f.adapter, async phase => {
          phase("canary-single-inspection");
          originalResult = await f.adapter.inspectWriters(observed); return originalResult;
        }, output) as Awaited<ReturnType<typeof f.adapter.inspectWriters>>;
        assert.strictEqual(returned, originalResult, "observer preserves the original return object");
        assert.equal(injections, 1, "the target original fault point is invoked once"); assert.equal(user.child.exitCode, null);
        assert(returned.some(item => item.code === "source_writer_unknown" && item.subjectRef === `unreadable-process:${user.child.pid}`));
        const directories = await readdir(output);
        assert.equal(directories.length, 1);
        const report = JSON.parse(await readFile(path.join(output, directories[0]!, "report.json"), "utf8"));
        assert.equal(report.inspectionCalls, 1);
        assert.equal(report.restorationErrors, 0);
        const failure = report.failures.find((item: { pid: number }) => item.pid === user.child.pid);
        assert(failure); assert.equal(failure.phase, "canary-single-inspection");
        assert.equal(failure.frame.observationErrors, 0);
        if (fault === "EACCES" || fault === "ENOENT") {
          assert(failure.frame.errors.some((event: { subject: string; error: { code: string; syscall: string } }) =>
            event.subject === "maps" && event.error.code === fault && event.error.syscall === "open"));
        } else if (fault === "partial-maps") {
          assert.equal(failure.frame.maps[0].eof, true);
          assert.equal(failure.frame.maps[0].endsWithNewline, false);
          assert.equal(failure.frame.stageHint, "maps-input-shape");
        } else {
          assert.equal(failure.frame.stageHint, "identity-check");
          assert.notEqual(failure.frame.stats[0].identity.startTicks, failure.frame.stats.at(-1).identity.startTicks);
        }
        assert(!JSON.stringify(report).includes("private diagnostic canary"), "raw error messages are not diagnostic output");
        st.diagnostic(JSON.stringify({ fault, originalBlockerPreserved: true, inspectionCalls: report.inspectionCalls,
          phase: failure.phase, pid: failure.pid, evidence: failure.frame }));
      } finally { st.mock.restoreAll(); syncBuiltinESMExports(); }
    });
  } finally { await user.stop(); await f.close(); }
});

linuxTest("#152 inventory diagnostic failure cannot replace the original exception or retry its boundary", async () => {
  const directory = await mkdtemp(path.join(process.cwd(), "br-inventory-diagnostic-"));
  try {
    const output = path.join(directory, "not-a-directory"); await writeFile(output, "fixed diagnostic failure");
    const originalError = Object.assign(new Error("original boundary marker"), { code: "EIO" });
    const blockers = [{ code: "source_writer_unknown", subjectRef: `unreadable-process:${process.pid}` }];
    let calls = 0;
    const adapter = { async inspectCurrentWriters() { calls++; return blockers; } };
    await assert.rejects(withSqliteSourceInventoryDiagnostics(adapter, async () => {
      assert.strictEqual(await adapter.inspectCurrentWriters(), blockers); throw originalError;
    }, output), error => error === originalError);
    assert.equal(calls, 1);
    let throws = 0;
    const throwing = { async inspectCurrentWriters() { throws++; throw originalError; } };
    const originalMethod = throwing.inspectCurrentWriters;
    await assert.rejects(withSqliteSourceInventoryDiagnostics(throwing,
      () => throwing.inspectCurrentWriters(), output), error => error === originalError);
    assert.equal(throws, 1); assert.strictEqual(throwing.inspectCurrentWriters, originalMethod);
  } finally { await rm(directory, { recursive: true }); }
});

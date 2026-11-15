import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import promises from "node:fs/promises";
import { mkdtemp, readdir, readlink, readFile, writeFile, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
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

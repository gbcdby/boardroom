import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { observePlannedPath } from "../src/server/storage/maintenance/plan.ts";
import { inspectSourceFileWriters, withSourceFileObservationWindow, chargeSourceFileObservation } from "../src/server/storage/maintenance/source-file-writers.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";
import { readLinuxProcText } from "../src/server/storage/maintenance/linux-mappings.ts";
import type { FileRoot } from "../src/server/storage/maintenance/types.ts";

const linuxTest = process.platform === "linux" ? test : test.skip;
if (process.platform === "linux") test.before(() => {
  // Build this candidate's fixed directory owner; no other test's order or
  // leftover addon may determine whether the inventory can preserve atime.
  const built = spawnSync(process.execPath,
    [fileURLToPath(new URL("../scripts/build-maintenance-platform.mjs", import.meta.url)), "--source-files"],
    { cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 65_000 });
  assert.equal(built.error, undefined); assert.equal(built.signal, null); assert.equal(built.status, 0, built.stderr);
});
async function fixture(config = true, sessions = true) {
  const directory = await promises.realpath(await promises.mkdtemp(path.join(tmpdir(), "br-wr1-")));
  const configFile = path.join(directory, "config.json"), sessionRoot = path.join(directory, "sessions");
  const sessionFile = path.join(sessionRoot, "nested", "session.json");
  if (config) await promises.writeFile(configFile, '{"private":"writer-canary"}\n', { mode: 0o600 });
  if (sessions) {
    await promises.mkdir(path.dirname(sessionFile), { recursive: true, mode: 0o700 });
    await promises.writeFile(sessionFile, '{"private":"session-canary"}\n', { mode: 0o600 });
  }
  const roots: FileRoot[] = [
    ...(config ? [{ label: "config" as const, path: configFile, expected: await observePlannedPath(configFile) }] : []),
    { label: "managed-sessions", path: sessionRoot, expected: await observePlannedPath(sessionRoot) },
  ];
  return { directory, configFile, sessionRoot, sessionFile, roots,
    inspect: () => withSourceFileObservationWindow(async () => {}, () => inspectSourceFileWriters(roots)),
    close: () => promises.rm(directory, { recursive: true }) };
}
async function mappedUser(file: string, mode: "private-reader" | "shared-writer" | "fd-reader" | "idle") {
  const script = fileURLToPath(new URL("./fixtures/maintenance-linux-mapped-user.py", import.meta.url));
  const child = spawn("python3", [script, file, mode], { stdio: ["pipe", "pipe", "pipe"], timeout: 30_000 });
  let stderr = "", stdout = "";
  child.stderr.setEncoding("utf8"); child.stderr.on("data", value => { stderr += value; });
  const ended = once(child, "close");
  const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("owned mapping helper startup timeout")), 5000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", () => { clearTimeout(timer); reject(new Error("owned mapping helper exited before readiness")); });
    child.stdout.setEncoding("utf8"); child.stdout.on("data", value => {
      stdout += value;
      if (stdout.length > 16_384) { clearTimeout(timer); reject(new Error("mapping helper output bound")); }
      if (stdout.endsWith("\n")) {
        clearTimeout(timer);
        try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
      }
    });
  });
  try {
    const observation = await ready;
    assert.equal(observation.pid, child.pid); assert.equal(observation.uid, process.getuid!());
    assert.equal(observation.sourceFdClosed, mode !== "fd-reader");
    let closing: Promise<void> | undefined;
    return { observation, close() {
      return closing ??= (async () => {
        child.stdin.end("release\n"); const [code, signal] = await ended;
        assert.equal(code, 0, stderr); assert.equal(signal, null); assert.equal(stderr, "");
      })();
    } };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await ended; throw error;
  }
}

linuxTest("WR1 closed config and nested sessions need no original writer FD; null/absence stays literal", async t => {
  for (const [config, sessions] of [[true, true], [false, true], [false, false], [true, false]]) {
    const f = await fixture(config, sessions);
    try { await f.inspect(); } finally { await f.close(); }
  }
});

linuxTest("WR1 metadata inventory preserves old root and nested-directory atime without timestamp repair", async () => {
  const f = await fixture();
  const files = [f.configFile, f.sessionRoot, path.dirname(f.sessionFile), f.sessionFile];
  try {
    for (const file of files) await promises.utimes(file, new Date("2000-01-01T00:00:00Z"), new Date("2000-01-01T00:00:00Z"));
    const before = await Promise.all(files.map(file => promises.stat(file, { bigint: true })));
    await f.inspect();
    const after = await Promise.all(files.map(file => promises.stat(file, { bigint: true })));
    for (let i = 0; i < files.length; i++) for (const field of ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "atimeNs", "mtimeNs", "ctimeNs"] as const)
      assert.equal(after[i]![field], before[i]![field], `${path.relative(f.directory, files[i]!)} ${field} must remain unchanged`);
  } finally { await f.close(); }
});

linuxTest("WR1 native directory names charge the original retained-byte budget before opening descendants", async t => {
  const f = await fixture(false), originalOpen = fs.openSync;
  let descendantOpens = 0;
  try {
    for (let i = 0; i < 800; i++) fs.writeFileSync(path.join(f.sessionRoot, `entry-${String(i).padStart(4, "0")}-${"n".repeat(180)}`), "", { mode: 0o600 });
    t.mock.method(fs, "openSync", ((file: fs.PathLike, flags: number, ...args: unknown[]) => {
      if ((flags & 0x200000) !== 0 && path.basename(String(file)).startsWith("entry-")) descendantOpens++;
      return Reflect.apply(originalOpen, fs, [file, flags, ...args]);
    }) as typeof fs.openSync); syncBuiltinESMExports();
    await assert.rejects(withSourceFileObservationWindow(async () => {}, async () => {
      chargeSourceFileObservation(0, 16 * 1024 * 1024 - 128 * 1024);
      await inspectSourceFileWriters(f.roots);
    }), { code: "backup_capability_unavailable" });
    assert.equal(descendantOpens, 0, "retain the complete bounded name result before starting any child lookup");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
});

linuxTest("WR1 native directory close uncertainty blocks a fresh same-source window with different roots", async () => {
  const packageRoot = await promises.mkdtemp(path.join(tmpdir(), "br-wr1-close-link-"));
  const f = await fixture(), other = await fixture(false, false);
  try {
    const root = fileURLToPath(new URL("../", import.meta.url));
    for (const relative of ["src/server/storage/maintenance", "src/server/identity"])
      await promises.cp(path.join(root, relative), path.join(packageRoot, relative), { recursive: true });
    await promises.symlink(path.join(root, "node_modules"), path.join(packageRoot, "node_modules"), "dir");
    await promises.writeFile(path.join(packageRoot, "package.json"), '{"type":"module"}\n');
    const output = path.join(packageRoot, "build/maintenance-platform"); await promises.mkdir(output, { recursive: true });
    const addon = path.join(output, `maintenance-source-files-linux-${process.arch}.node`);
    // The existing fixed negative fixture performs the actual closedir and then
    // returns EIO. No synthetic owner, injected result or production override.
    const built = spawnSync("/usr/bin/cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-DNAPI_VERSION=8",
      "-DNODE_GYP_MODULE_NAME=boardroom_wr1_directory_close", "-DP3_TEST_DIRECTORY_CLOSE_FAILURE", "-shared", "-fPIC",
      "-I", path.join(root, "native/node-api/v24.22.1"), path.join(root, "native/maintenance-source-files.c"),
      path.join(root, "tests/fixtures/maintenance-source-file-getter-errors.c"), "-Wl,--wrap=ioctl", "-Wl,--wrap=syscall",
      "-Wl,--wrap=closedir", "-o", addon], { encoding: "utf8", timeout: 30_000 });
    assert.equal(built.error, undefined); assert.equal(built.status, 0, built.stderr); await promises.chmod(addon, 0o700);
    const api = await import(pathToFileURL(path.join(packageRoot, "src/server/storage/maintenance/source-file-writers.ts")).href) as
      typeof import("../src/server/storage/maintenance/source-file-writers.ts");
    const info = await promises.stat(f.directory, { bigint: true });
    const origin = { path: f.directory, device: String(info.dev), inode: String(info.ino), hostIdentityDigest: "a".repeat(64) };
    await assert.rejects(api.withSourceFileObservationWindow(async () => {}, () => api.inspectSourceFileWriters(f.roots),
      { lock: {}, root: origin }), error => {
      assert.equal((error as { code?: string }).code, "source_writer_unknown");
      assert((error as Error).cause instanceof AggregateError); return true;
    });
    // The second selection is absent and disjoint: the native directory module
    // will never run. Only WR1's same-source owner retention can reject it.
    await assert.rejects(api.withSourceFileObservationWindow(async () => {}, () => api.inspectSourceFileWriters(other.roots),
      { lock: {}, root: origin }), { code: "source_writer_unknown" });
  } finally { await f.close(); await other.close(); await promises.rm(packageRoot, { recursive: true, force: true }); }
});

linuxTest("WR1 real mapping-only config and nested-session users are rejected", { timeout: 30_000 }, async t => {
  const f = await fixture();
  try {
    for (const [label, file, mode] of [["config", f.configFile, "private-reader"],
      ["session", f.sessionFile, "shared-writer"]] as const) await t.test(label, async () => {
      const user = await mappedUser(file, mode);
      try { await assert.rejects(f.inspect(), { code: "source_writer_unknown" }); }
      finally { await user.close(); }
      await f.inspect();
    });
  } finally { await f.close(); }
});

linuxTest("WR1 an unregistered same-PID readonly descriptor is not an owned reader", async () => {
  const f = await fixture(), reader = await promises.open(f.sessionFile, "r");
  try { await assert.rejects(f.inspect(), { code: "source_writer_unknown" }); }
  finally { await reader.close(); await f.close(); }
});

linuxTest("WR1 G2 rejects the actual selected inode after its open name changes, before new source lookup", async t => {
  const f = await fixture(), reader = await promises.open(f.configFile, "r");
  const originalOpen = fs.openSync; let sourceLookups = 0;
  try {
    await promises.rename(f.configFile, path.join(f.directory, "renamed.json"));
    t.mock.method(fs, "openSync", ((file: fs.PathLike, flags: number, ...args: unknown[]) => {
      if ((flags & 0x200000) !== 0) sourceLookups++;
      return Reflect.apply(originalOpen, fs, [file, flags, ...args]);
    }) as typeof fs.openSync); syncBuiltinESMExports();
    await assert.rejects(f.inspect(), { code: "source_writer_unknown" });
    assert.equal(sourceLookups, 0);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await reader.close(); await f.close(); }
});

linuxTest("WR1 replacement, membership and absent-root changes invalidate the current local window", async t => {
  for (const change of ["config", "member", "absent"] as const) await t.test(change, async () => {
    const f = await fixture(true, change !== "absent");
    try {
      await assert.rejects(withSourceFileObservationWindow(async () => {}, async () => {
        await inspectSourceFileWriters(f.roots);
        if (change === "config") {
          await promises.rename(f.configFile, path.join(f.directory, "old.json"));
          await promises.writeFile(f.configFile, "replacement\n", { mode: 0o600 });
        } else if (change === "member") await promises.writeFile(path.join(f.sessionRoot, "new.json"), "member\n", { mode: 0o600 });
        else await promises.mkdir(f.sessionRoot, { mode: 0o700 });
        await inspectSourceFileWriters(f.roots);
      }), { code: "source_changed" });
    } finally { await f.close(); }
  });
});

linuxTest("WR1 unknown live-process maps stay blocking and preserve source content privacy", async t => {
  const f = await fixture(), original = fs.openSync;
  let injected = false, sourceLookups = 0;
  try {
    t.mock.method(fs, "openSync", ((file: fs.PathLike, flags: number, ...args: unknown[]) => {
      if ((flags & 0x200000) !== 0) sourceLookups++;
      if (String(file).endsWith("/maps") && !injected) {
        injected = true; throw Object.assign(new Error("private-writer-canary"), { code: "EACCES", syscall: "open", path: String(file) });
      }
      return Reflect.apply(original, fs, [file, flags, ...args]);
    }) as typeof fs.openSync); syncBuiltinESMExports();
    await assert.rejects(f.inspect(), error => {
      assert.equal((error as { code?: string }).code, "source_writer_unknown");
      assert(!String(error).includes("private-writer-canary")); return true;
    });
    assert.equal(injected, true); assert.equal(sourceLookups, 0);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
});

linuxTest("WR1 an old metadata FD reused for an ordinary reader is neither exempted nor closed", async t => {
  const f = await fixture(), originalOpen = fs.openSync, originalClose = fs.closeSync;
  let metadataFd: number | undefined, replacement: number | undefined, replaced = false;
  try {
    t.mock.method(fs, "openSync", ((file: fs.PathLike, flags: number, ...args: unknown[]) => {
      if (!replaced && metadataFd !== undefined && /^\/proc\/[1-9][0-9]*$/.test(String(file))) {
        replaced = true; originalClose(metadataFd);
        replacement = originalOpen(f.configFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        assert.equal(replacement, metadataFd, "the fixture must actually reuse this descriptor integer");
      }
      const fd = Reflect.apply(originalOpen, fs, [file, flags, ...args]) as number;
      if ((flags & 0x200000) !== 0 && String(file).endsWith("/config.json")) metadataFd = fd;
      return fd;
    }) as typeof fs.openSync); syncBuiltinESMExports();
    await assert.rejects(f.inspect(), { code: "source_writer_unknown" });
    assert.equal(replaced, true);
    assert.equal(fs.fstatSync(replacement!).isFile(), true, "only the fixture owns the replacement FD");
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    if (replacement !== undefined) {
      try { fs.fstatSync(replacement); originalClose(replacement); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error; }
    }
    await f.close();
  }
});

linuxTest("WR1 a reused proc-directory FD cannot make cleanup close another owner's source reader", async t => {
  const f = await fixture(), originalRead = promises.readdir;
  let replacement: number | undefined, injected = false;
  try {
    t.mock.method(promises, "readdir", (async (file: fs.PathLike, ...args: unknown[]) => {
      const match = /^\/proc\/self\/fd\/([0-9]+)\/fd$/.exec(String(file));
      if (!injected && match && fs.readlinkSync(`/proc/self/fd/${match[1]}`) === `/proc/${process.pid}`) {
        injected = true; const old = Number(match[1]); fs.closeSync(old);
        replacement = fs.openSync(f.configFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        assert.equal(replacement, old, "the actual proc FD number must be reused");
      }
      return Reflect.apply(originalRead, promises, [file, ...args]);
    }) as typeof promises.readdir); syncBuiltinESMExports();
    await assert.rejects(f.inspect(), { code: "source_writer_unknown" });
    assert.equal(injected, true);
    assert.equal(fs.fstatSync(replacement!).isFile(), true, "the fixture retains the replacement descriptor");
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    if (replacement !== undefined) {
      try { fs.fstatSync(replacement); fs.closeSync(replacement); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error; }
    }
    await f.close();
  }
});

linuxTest("WR1 a genuine child exit during pinned proc enumeration still closes its original directory owner", async t => {
  const f = await fixture(), child = await mappedUser(f.configFile, "idle"), original = promises.readdir;
  let exitedWhilePinned = false;
  try {
    t.mock.method(promises, "readdir", (async (file: fs.PathLike, ...args: unknown[]) => {
      const match = /^\/proc\/self\/fd\/([0-9]+)\/fd$/.exec(String(file));
      if (!exitedWhilePinned && match && fs.readlinkSync(`/proc/self/fd/${match[1]}`) === `/proc/${child.observation.pid}`) {
        exitedWhilePinned = true; await child.close();
      }
      return Reflect.apply(original, promises, [file, ...args]);
    }) as typeof promises.readdir); syncBuiltinESMExports();
    await f.inspect(); assert.equal(exitedWhilePinned, true);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await child.close(); await f.close(); }
});

linuxTest("WR1 the original D0 and cancellation stop new observations but settle every owned metadata close", async t => {
  for (const fault of ["deadline", "cancel"] as const) await t.test(fault, async t => {
    const f = await fixture(), originalOpen = fs.openSync, originalClose = fs.closeSync;
    const owned = new Set<number>(); let armed = false, now = 0, afterStop = 0;
    const cancelled = new MaintenanceFailure("maintenance_lost", "fixture-cancel");
    try {
      t.mock.method(performance, "now", () => now);
      t.mock.method(fs, "openSync", ((file: fs.PathLike, flags: number, ...args: unknown[]) => {
        if (armed && (flags & 0x200000) !== 0) afterStop++;
        const fd = Reflect.apply(originalOpen, fs, [file, flags, ...args]) as number;
        if ((flags & 0x200000) !== 0) {
          owned.add(fd);
          if (String(file).endsWith("/config.json")) { armed = true; if (fault === "deadline") now = 120_001; }
        }
        return fd;
      }) as typeof fs.openSync);
      t.mock.method(fs, "closeSync", (fd: number) => { originalClose(fd); owned.delete(fd); }); syncBuiltinESMExports();
      await assert.rejects(withSourceFileObservationWindow(async () => { if (fault === "cancel" && armed) throw cancelled; },
        () => inspectSourceFileWriters(f.roots)), { code: fault === "deadline" ? "backup_capability_unavailable" : "maintenance_lost" });
      assert.equal(armed, true); assert.equal(afterStop, 0); assert.equal(owned.size, 0);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
  });
});

linuxTest("WR1 a proc read failure retains its original error and the independent actual close failure", t => {
  const originalOpen = fs.openSync, originalRead = fs.readSync, originalClose = fs.closeSync;
  const readError = new Error("private-read-error"), closeError = new Error("private-close-error");
  let selected: number | undefined, closeCount = 0;
  try {
    t.mock.method(fs, "openSync", ((file: fs.PathLike, ...args: unknown[]) => {
      const fd = Reflect.apply(originalOpen, fs, [file, ...args]) as number;
      if (String(file) === "/proc/self/stat") selected = fd;
      return fd;
    }) as typeof fs.openSync);
    t.mock.method(fs, "readSync", ((fd: number, ...args: unknown[]) => {
      if (fd === selected) throw readError;
      return Reflect.apply(originalRead, fs, [fd, ...args]);
    }) as typeof fs.readSync);
    t.mock.method(fs, "closeSync", (fd: number) => {
      originalClose(fd); if (fd === selected) { closeCount++; throw closeError; }
    }); syncBuiltinESMExports();
    assert.throws(() => readLinuxProcText("/proc/self/stat", 8192), error => {
      assert(error instanceof AggregateError); assert.deepEqual(error.errors, [readError, closeError]);
      assert.equal(error.cause, readError); assert(!String(error).includes("private")); return true;
    });
    assert.equal(closeCount, 1);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

linuxTest("WR1 metadata failure keeps first cause, finishes other owners and never retries an uncertain close", async t => {
  const f = await fixture(), originalOpen = fs.openSync, originalClose = fs.closeSync, originalLstat = fs.lstatSync;
  const readError = Object.assign(new Error("private-metadata-error"), { code: "EIO" }), closeError = new Error("private-close-error");
  let selected: number | undefined, closeCount = 0, injected = false;
  const owned = new Set<number>();
  try {
    t.mock.method(fs, "openSync", ((file: fs.PathLike, flags: number, ...args: unknown[]) => {
      const fd = Reflect.apply(originalOpen, fs, [file, flags, ...args]) as number;
      if ((flags & 0x200000) !== 0) { owned.add(fd); if (String(file).endsWith("/config.json")) selected = fd; }
      return fd;
    }) as typeof fs.openSync);
    t.mock.method(fs, "lstatSync", ((file: fs.PathLike, ...args: unknown[]) => {
      if (selected !== undefined && String(file) === f.configFile && !injected) { injected = true; throw readError; }
      return Reflect.apply(originalLstat, fs, [file, ...args]);
    }) as typeof fs.lstatSync);
    t.mock.method(fs, "closeSync", (fd: number) => {
      const selectedOwner = fd === selected && fs.readlinkSync(`/proc/self/fd/${fd}`) === f.configFile;
      originalClose(fd); owned.delete(fd);
      if (selectedOwner) { closeCount++; throw closeError; }
    }); syncBuiltinESMExports();
    await assert.rejects(f.inspect(), error => {
      assert.equal((error as { code?: string }).code, "source_writer_unknown");
      assert.equal((error as Error).cause, readError);
      assert.deepEqual((error as Error & { closeErrors: unknown[] }).closeErrors, [closeError]);
      assert(!String(error).includes("private")); return true;
    });
    assert.equal(injected, true); assert.equal(closeCount, 1); assert.equal(owned.size, 0);
    t.mock.restoreAll(); syncBuiltinESMExports();
    await assert.rejects(f.inspect(), { code: "source_writer_unknown" });
    assert.equal(closeCount, 1);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
});

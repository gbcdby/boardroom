import test from "node:test";
import Database from "better-sqlite3";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { chmod, mkdtemp, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactStore } from "../src/server/storage/maintenance/objects.ts";
import { assertDarwinSqliteSource, bindDarwinSqliteSource, darwinCurrentProcessIdentity, darwinFileSystem, darwinProcessObservation, darwinSourceInventory } from "../src/server/storage/maintenance/darwin.ts";
import { maintenanceHostIdentityDigest } from "../src/server/storage/maintenance/host.ts";
import { syncMaintenanceHandle } from "../src/server/storage/maintenance/platform.ts";
import { sha256 } from "../src/server/storage/maintenance/canonical.ts";

// Dedicated CI entry: absence of the required OS/architecture/helper is a failure, never a skip.
assert.equal(process.platform, "darwin", "requires the actual macOS runner");
assert.equal(process.arch, "arm64", "requires the accepted macOS arm64 target");
const fixtureSource = { kind: "sqlite" as const, databaseInstanceId: "1".repeat(32), identityDigest: "2".repeat(64) };
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const darwinModule = new URL("../src/server/storage/maintenance/darwin.ts", import.meta.url).href;
const hostModule = new URL("../src/server/storage/maintenance/host.ts", import.meta.url).href;
async function temporary() { return mkdtemp(path.join(path.dirname(process.cwd()), "br-macos-maintenance-")); }
function compile(source: string, target: string, library = false) {
  const result = spawnSync("/usr/bin/cc", ["-std=c11", "-D_DARWIN_C_SOURCE", "-Wall", "-Wextra", "-Werror",
    ...(library ? ["-dynamiclib"] : []), source, "-o", target], { encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr || "native fixture compiler unavailable");
}

test("#152 macOS APFS uses successful no-fallback file and directory F_FULLFSYNC on the exact filesystem", async t => {
  const dir = await temporary();
  try {
    const operations: string[] = [];
    const store = await ArtifactStore.create(path.join(dir, "control"), fixtureSource, { after: point => { operations.push(point); } });
    const capability = await store.capability();
    assert.equal(capability.platform, "darwin"); assert.equal(capability.filesystemType, "apfs");
    assert.equal(capability.guarantee, "observed-file-and-directory-fullfsync-rename"); assert.equal(capability.powerLossTested, false);
    assert.deepEqual(operations, ["temp_written", "file_synced", "renamed", "directory_synced"]);
    const file = await open(path.join(dir, "exact-file"), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
    const directory = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await file.writeFile("durability capability, no power-loss claim");
      assert.equal(darwinFileSystem(file.fd, true).kind, "file");
      assert.equal(darwinFileSystem(directory.fd, true).kind, "directory");
      await syncMaintenanceHandle(file); await syncMaintenanceHandle(directory);
    } finally { await file.close(); await directory.close(); }
    t.diagnostic(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, libuv: process.versions.uv,
      filesystemType: capability.filesystemType, guarantee: capability.guarantee, observed: operations, powerLossTested: false }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("#152 macOS host binding survives a separate process and libproc verifies the real current process", async () => {
  const digest = await maintenanceHostIdentityDigest();
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import { maintenanceHostIdentityDigest } from ${JSON.stringify(hostModule)}; console.log(await maintenanceHostIdentityDigest());`], { encoding: "utf8", timeout: 15_000 });
  assert.equal(child.status, 0); assert.equal(child.stdout.trim(), digest);
  const identity = darwinCurrentProcessIdentity();
  const observed = darwinProcessObservation(process.pid);
  assert.equal(observed.status, "present");
  if (observed.status !== "present") throw new Error("missing current process");
  assert.equal(identity.verification, "darwin_proc_identity_v1"); assert.equal(identity.startSeconds, observed.startSeconds);
  assert.equal(identity.startMicroseconds, observed.startMicroseconds); assert.equal(identity.bootSessionUuid, observed.bootSessionUuid);
  assert.equal(identity.uid, process.getuid!());
});

test("#152 macOS fullsync failure blocks publication even when ordinary fsync is available", async () => {
  const dir = await temporary();
  try {
    const library = path.join(dir, "reject-fullsync.dylib"), file = path.join(dir, "file");
    compile(fixture("maintenance-darwin-fullsync-fault.c"), library, true);
    await writeFile(file, "private fault fixture", { mode: 0o600 });
    const handle = await open(file, "r+");
    try {
      const injected = spawnSync(path.resolve(`build/maintenance-platform/maintenance-darwin-${process.arch}`), ["fullsync"],
        { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe", handle.fd], env: { ...process.env, DYLD_INSERT_LIBRARIES: library } });
      assert.equal(injected.status, 1); assert.match(injected.stderr, /injected_fullfsync_failure/);
    } finally { await handle.close(); }
    const script = `import { open } from 'node:fs/promises'; import { darwinFileSystem } from ${JSON.stringify(darwinModule)};
      const handle = await open(${JSON.stringify(file)}, 'r+');
      await handle.sync();
      try { darwinFileSystem(handle.fd, true); process.exitCode = 3; }
      catch (error) { if (error.code !== 'unsupported_durability') throw error; console.log('fullfsync-failed-closed'); }
      finally { await handle.close(); }`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 30_000,
      env: { ...process.env, DYLD_INSERT_LIBRARIES: library } });
    assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout.trim(), "fullfsync-failed-closed");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("#152 macOS verifies the actual SQLite connection when its opened source is exchanged", async () => {
  const dir = await temporary(); const file = path.join(dir, "source.sqlite"); const db = new Database(file);
  try {
    db.exec("CREATE TABLE original(value)"); bindDarwinSqliteSource(db); assertDarwinSqliteSource(db);
    await rename(file, file + ".moved");
    const replacement = new Database(file); replacement.exec("CREATE TABLE replacement(value)"); replacement.close();
    assert.throws(() => assertDarwinSqliteSource(db), /source_changed/);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test("#152 macOS rejects extended ACL grants even when POSIX source and artifact modes remain private", async () => {
  const dir = await temporary();
  try {
    const file = path.join(dir, "source"); await writeFile(file, "known source", { mode: 0o600 });
    const grant = (target: string) => {
      const result = spawnSync("/bin/chmod", ["+a", "everyone allow write", target], { encoding: "utf8", timeout: 10_000 });
      assert.equal(result.status, 0, result.stderr);
    };
    grant(file); assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.throws(() => darwinSourceInventory({ files: [file] }, false), /source_writer_unknown/);
    const store = await ArtifactStore.create(path.join(dir, "control"), fixtureSource);
    const artifact = await store.putBytes("source-file-payload", Buffer.from("private artifact"));
    grant(store.pathFor(artifact)); assert.equal((await stat(store.pathFor(artifact))).mode & 0o777, 0o600);
    await assert.rejects(store.confirmDurable(artifact), /unsupported_durability/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("#152 macOS source inventory finds a different process's mapped writer after its FD closes", async () => {
  const dir = await temporary(); let child: ReturnType<typeof spawn> | undefined;
  try {
    const file = path.join(dir, "source"), executable = path.join(dir, "mapped-writer");
    await writeFile(file, Buffer.alloc(4096), { mode: 0o600 }); compile(fixture("maintenance-darwin-mapped-writer.c"), executable);
    child = spawn(executable, [file], { stdio: ["pipe", "pipe", "pipe"] });
    const exited = once(child, "exit");
    const [ready] = await once(child.stdout!, "data", { signal: AbortSignal.timeout(10_000) }); assert.equal(String(ready).trim(), "mapped");
    const result = darwinSourceInventory({ files: [file] }, false);
    assert.ok(result.items.some(item => item.kind === "handle" && item.pid === child!.pid && item.key.startsWith("map:")));
    assert.equal(result.items.some(item => item.kind === "handle" && item.pid === child!.pid && item.key.startsWith("fd:")), false);
    child.stdin!.end(); const [code, signal] = await exited; assert.equal(code, 0); assert.equal(signal, null);
    assert.equal(darwinSourceInventory({ files: [file] }, false).items.some(item => item.pid === child!.pid), false);
    assert.equal(darwinProcessObservation(child.pid!).status, "absent");
    await chmod(file, 0o666);
    assert.throws(() => darwinSourceInventory({ files: [file] }, false), /source_writer_unknown/);
  } finally {
    child?.stdin?.end();
    if (child && child.exitCode === null && child.signalCode === null) await once(child, "exit");
    await rm(dir, { recursive: true, force: true });
  }
});

test("#152 Darwin range refinement keeps the target vnode after an empty guard and rejects unresolved ranges", async t => {
  const dir = await temporary();
  try {
    const file = path.join(dir, "source"), executable = path.join(dir, "region-scan");
    await writeFile(file, Buffer.alloc(65536), { mode: 0o600 });
    const compiled = spawnSync("/usr/bin/cc", ["-std=c11", "-D_DARWIN_C_SOURCE", "-Wall", "-Wextra", "-Werror", "-O2",
      fixture("maintenance-darwin-region-scan.c"), "-lproc", "-o", executable], { encoding: "utf8", timeout: 60_000 });
    assert.equal(compiled.status, 0, compiled.stderr || "native range fixture compiler unavailable");
    const cases: { name: string; calls: number; reason: string | null }[] = [
      { name: "normal-target", calls: 2, reason: null },
      { name: "guard-target", calls: 3, reason: null },
      { name: "guard-anonymous-target", calls: 4, reason: null },
      ...["guard-vnode", "guard-other-tag", "guard-writable", "guard-max-write", "guard-submap", "guard-nonempty",
        "guard-counter", "guard-offset", "guard-nonprogress"].map(name => ({ name, calls: 1, reason: "mapped-file-range" })),
      ...["guard-backward", "normal-nonprogress", "confirm-zero", "confirm-forward-zero", "confirm-forward", "confirm-backward",
        "confirm-overflow"].map(name => ({ name, calls: 2, reason: "mapped-file-range" })),
      ...["confirm-short", "confirm-einval", "confirm-esrch", "confirm-denied"].map(name => ({ name, calls: 2, reason: "mapped-file-info" })),
      { name: "normal-overflow", calls: 1, reason: "mapped-file-range" },
      { name: "normal-denied", calls: 1, reason: "mapped-file-info" },
      { name: "budget", calls: 262144, reason: "mapped-file-limit" },
      { name: "guard-budget", calls: 524288, reason: "mapped-file-limit" },
    ];
    for (const scenario of cases) await t.test(scenario.name, () => {
      const child = spawnSync(executable, [scenario.name, file], { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
      assert.equal(child.status, 0, child.stderr || "native range fixture failed");
      const observed = JSON.parse(child.stdout) as { items: ReturnType<typeof darwinSourceInventory>["items"]; queryCount: number;
        queries: string[]; mappedBegin: string; mappedSize: string; device: string; inode: string; targetFdClosed: boolean };
      assert.equal(observed.targetFdClosed, true); assert.equal(observed.queryCount, scenario.calls);
      assert.equal(observed.items.length, 1);
      const item = observed.items[0]!;
      if (scenario.reason === null) {
        assert.equal(item.kind, "handle");
        if (item.kind !== "handle") throw new Error("mapped target was lost");
        assert.equal(item.device, observed.device); assert.equal(item.inode, observed.inode); assert.equal(item.fd, -1);
        assert.equal(item.key, `map:${observed.mappedBegin}:${observed.mappedSize}`);
        if (scenario.name === "guard-target") assert.equal(observed.queries[1], observed.mappedBegin);
        if (scenario.name === "guard-anonymous-target") {
          assert.equal(observed.queries[1], String(BigInt(observed.mappedBegin) - 16384n));
          assert.equal(observed.queries[2], observed.mappedBegin);
        }
      } else {
        assert.equal(item.kind, "unreadable");
        if (item.kind !== "unreadable") throw new Error("unresolved range was accepted");
        assert.equal(item.reason, scenario.reason);
      }
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const point of ["temp_written", "file_synced", "renamed", "directory_synced"] as const) {
  test(`#152 macOS actual child crash at ${point} leaves only an unanchored object and permits verified republish`, async () => {
    const dir = await temporary();
    try {
      const root = path.join(dir, "control"); await ArtifactStore.create(root, fixtureSource);
      const child = spawnSync(process.execPath, [fixture("maintenance-darwin-crash.ts"), root, point], { encoding: "utf8", timeout: 30_000 });
      assert.equal(child.signal, "SIGKILL", child.stderr); assert.equal(child.status, null);
      const bytes = Buffer.from("macos-publication-crash-fixture"), digest = sha256(bytes);
      const ref = { ref: `snapshots/${digest}/source-file-payload.bin`, sha256: digest, bytes: String(bytes.length) };
      const reopened = await ArtifactStore.open(root, fixtureSource);
      if (point === "temp_written" || point === "file_synced") await assert.rejects(stat(reopened.pathFor(ref)), { code: "ENOENT" });
      else assert.deepEqual(await reopened.readBytes(ref), bytes);
      assert.deepEqual(await reopened.putBytes("source-file-payload", bytes), ref);
      assert.deepEqual((await reopened.confirmDurable(ref)).completed, ["file_sync", "immutable_name_verified", "directory_sync"]);
      assert.deepEqual(await readFile(reopened.pathFor(ref)), bytes);
      // A root replacement remains a failure after a real process restart.
      await rename(root, `${root}.moved`);
      await assert.rejects(reopened.assertRoot(), /control_root_mismatch/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

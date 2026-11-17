import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { constants } from "node:fs";
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir, constants as osConstants } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withNativeSourceRoot, observeSourceFile, sourceFileNativePath } from "../src/server/storage/maintenance/source-file-native.ts";
import type { SourceFileExtendedObservation } from "../src/server/storage/maintenance/source-file-native.ts";
import { matchSourceFileProfile } from "../src/server/storage/maintenance/source-file-profile.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";

const linuxTest = process.platform === "linux" ? test : test.skip;
const root = fileURLToPath(new URL("../", import.meta.url));
type NativeBinding = {
  openRoot(path: string): object;
  openChild(parent: object, leaf: string, kind: "file" | "directory"): object;
  observe(owner: object): { kind: string; dev: bigint; ino: bigint; size: bigint };
  observeStatx(owner: object): unknown;
  observeExtended(owner: object): unknown;
  readAt(owner: object, offset: bigint, length: number): Buffer;
  readDirectory(owner: object): string[];
  close(owner: object): void;
};

linuxTest("#152 P0 Linux source FD builds against fixed checked Node-API 8 headers", { timeout: 90_000 }, () => {
  const build = spawnSync(process.execPath, ["scripts/build-maintenance-platform.mjs", "--source-files"],
    { cwd: root, encoding: "utf8", timeout: 65_000 });
  assert.equal(build.error, undefined, "native bridge compilation must actually run");
  assert.equal(build.status, 0, build.stderr.slice(0, 1000));
  const native = createRequire(import.meta.url)(sourceFileNativePath) as NativeBinding;
  for (const name of ["openRoot", "openChild", "observe", "observeStatx", "observeExtended", "readAt", "readDirectory", "close"] as const)
    assert.equal(typeof native[name], "function");
});

linuxTest("#152 P2 extended facts use the live owner and retain explicit syscall outcomes", async t => {
  const tmp = await mkdtemp(path.join(tmpdir(), "br-p2-facts-"));
  try {
    await writeFile(path.join(tmp, "file"), "ordinary-read-only-fixture", { mode: 0o600 });
    await withNativeSourceRoot(tmp, rootHandle => {
      const file = rootHandle.openChild("file", "file");
      try {
        for (const handle of [rootHandle, file]) {
          const initial = handle.observe(), result = handle.observeExtended();
          assert.equal(result.before.kind, handle.kind);
          assert.equal(result.before.dev, initial.dev); assert.equal(result.before.ino, initial.ino);
          assert.deepEqual(result.after, result.before);
          assert.equal(typeof result.before.gid, "bigint"); assert.equal(typeof result.before.atimeNs, "bigint");
          assert.equal(Object.hasOwn(result, "qualified"), false);
          for (const key of ["uuid", "fid", "inodeFlags", "xattrs"] as const) {
            const fact = result[key];
            assert.ok(["observed", "unavailable"].includes(fact.status));
            assert.ok(fact.calls.length > 0);
            for (const call of fact.calls) {
              if (call.rc === null) { assert.equal(call.errno, null); continue; }
              assert.equal(typeof call.rc, "bigint"); assert.equal(typeof call.errno, "bigint");
              if (call.rc < 0n) assert.ok(call.errno! > 0n);
              else assert.equal(call.errno, 0n);
            }
            if (fact.status === "observed") {
              assert.equal(fact.reason, null); assert.notEqual(fact.value, null);
              assert.ok(fact.calls.every(call => call.rc !== null && call.rc >= 0n && call.errno === 0n));
            } else {
              assert.equal(fact.value, null); assert.equal(typeof fact.reason, "string");
            }
          }
          assert.throws(() => matchSourceFileProfile(handle), { code: "backup_capability_unavailable" });
          t.diagnostic(JSON.stringify({ kind: handle.kind,
            uuid: result.uuid.status, fid: result.fid.status, inodeFlags: result.inodeFlags.status, xattrs: result.xattrs.status }));
        }
      } finally { file.close(); }
      assert.throws(() => file.observeExtended(), { code: "maintenance_lost" });
    });
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

linuxTest("#152 P2 accessible xattr names and values stay raw, bounded and on the same file", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "br-p2-xattr-"));
  try {
    const file = path.join(tmp, "file");
    await writeFile(file, "xattr-fixture", { mode: 0o600 });
    const seed = spawnSync("python3", ["-c", "import os,sys; p=sys.argv[1]; os.setxattr(p,b'user.boardroom-raw-\\xff',bytes([0,255,128,1])); os.setxattr(p,b'user.boardroom-empty',b'')", file],
      { encoding: "utf8", timeout: 5000 });
    assert.equal(seed.error, undefined); assert.equal(seed.status, 0, seed.stderr);
    await withNativeSourceRoot(tmp, handle => {
      const child = handle.openChild("file", "file");
      try {
        const result = child.observeExtended();
        assert.equal(result.xattrs.status, "observed");
        if (result.xattrs.status !== "observed") assert.fail("xattr fixture must be read");
        const attrs = result.xattrs.value;
        const raw = Buffer.concat([Buffer.from("user.boardroom-raw-"), Buffer.from([255])]);
        assert.deepEqual(attrs.find(entry => entry.name.equals(raw))?.value, Buffer.from([0,255,128,1]));
        assert.deepEqual(attrs.find(entry => entry.name.equals(Buffer.from("user.boardroom-empty")))?.value, Buffer.alloc(0));
        assert.deepEqual(child.observeExtended(), result, "ordinary metadata getters do not alter their source");
        const rootFacts = handle.observeExtended();
        assert.equal(rootFacts.xattrs.status, "observed");
        if (rootFacts.xattrs.status === "observed") assert.equal(rootFacts.xattrs.value.some(entry => entry.name.equals(raw)), false);
        assert.equal(result.xattrs.calls[0]!.operation, "flistxattr-before");
        assert.equal(result.xattrs.calls.at(-1)!.operation, "flistxattr-after");
      } finally { child.close(); }
    });
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

linuxTest("#152 P2 xattr count overflow is explicitly unavailable and never a partial list", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "br-p2-xattr-budget-"));
  try {
    const file = path.join(tmp, "file");
    await writeFile(file, "bounded-fixture", { mode: 0o600 });
    const seed = spawnSync("python3", ["-c", "import os,sys; [os.setxattr(sys.argv[1],('user.b%02d'%i).encode(),b'') for i in range(65)]", file],
      { encoding: "utf8", timeout: 5000 });
    assert.equal(seed.error, undefined); assert.equal(seed.status, 0, seed.stderr);
    await withNativeSourceRoot(tmp, handle => {
      const child = handle.openChild("file", "file");
      try {
        const facts = child.observeExtended();
        assert.equal(facts.xattrs.status, "unavailable"); assert.equal(facts.xattrs.reason, "budget");
        assert.equal(facts.xattrs.value, null);
        assert.ok(facts.xattrs.calls[0]!.rc! > 0n);
        assert.deepEqual(facts.xattrs.calls.at(-1), { operation: "flistxattr-after", rc: null, errno: null });
        assert.throws(() => matchSourceFileProfile(child), { code: "backup_capability_unavailable" });
      } finally { child.close(); }
    });
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

linuxTest("#152 P2 native stale owner and changed ordinary permissions cannot yield facts", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "br-p2-owner-"));
  try {
    const native = createRequire(import.meta.url)(sourceFileNativePath) as NativeBinding;
    const previous = native.openRoot(tmp);
    native.close(previous);
    const current = native.openRoot(tmp);
    try {
      assert.throws(() => native.observeExtended(previous), { code: "ERR_SOURCE_HANDLE" });
      assert.throws(() => native.observeExtended({}), { code: "ERR_SOURCE_HANDLE" });
      assert.ok(native.observeExtended(current));
    } finally { native.close(current); }
    await withNativeSourceRoot(tmp, handle => {
      const changed = chmod(tmp, 0o777);
      return changed.then(() => {
        assert.throws(() => handle.observeExtended(), { code: "ERR_SOURCE_IDENTITY" });
      });
    });
  } finally { await chmod(tmp, 0o700); await rm(tmp, { recursive: true, force: true }); }
});

linuxTest("#152 P2 fixed syscall fault fixture keeps EACCES/EOVERFLOW unavailable without fabricated values", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "br-p2-call-errors-"));
  try {
    const addon = path.join(tmp, "getter-errors.node");
    const build = spawnSync("/usr/bin/cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-DNAPI_VERSION=8",
      "-DNODE_GYP_MODULE_NAME=boardroom_source_file_test_errors", "-shared", "-fPIC", "-I", path.join(root, "native/node-api/v24.22.1"),
      path.join(root, "native/maintenance-source-files.c"), path.join(root, "tests/fixtures/maintenance-source-file-getter-errors.c"),
      "-Wl,--wrap=ioctl", "-Wl,--wrap=syscall", "-o", addon], { encoding: "utf8", timeout: 30_000 });
    assert.equal(build.error, undefined); assert.equal(build.status, 0, build.stderr);
    const native = createRequire(import.meta.url)(addon) as NativeBinding;
    const owner = native.openRoot(tmp);
    try {
      const result = native.observeExtended(owner) as SourceFileExtendedObservation;
      for (const key of ["uuid", "inodeFlags"] as const) {
        assert.equal(result[key].status, "unavailable"); assert.equal(result[key].reason, "syscall");
        assert.equal(result[key].value, null);
        assert.equal(result[key].calls[0]!.rc, -1n); assert.equal(result[key].calls[0]!.errno, BigInt(osConstants.errno.EACCES));
      }
      assert.equal(result.fid.status, "unavailable"); assert.equal(result.fid.value, null);
      assert.equal(result.fid.calls[0]!.rc, -1n); assert.equal(result.fid.calls[0]!.errno, BigInt(osConstants.errno.EOVERFLOW));
      assert.equal(result.xattrs.status, "observed");
      assert.deepEqual(result.before, result.after);
    } finally { native.close(owner); }
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

linuxTest("#152 P0 pinned native file owner never changes FD across two real reads or reuses closed handles", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "br-p0-source-")), source = path.join(tmp, "source");
  try {
    await mkdir(source, { mode: 0o700 });
    const bytes = Buffer.from([0, 255, 128, 42, 10, 0]);
    await writeFile(path.join(source, "file.bin"), bytes, { mode: 0o600 });
    await mkdir(path.join(source, "nested"), { mode: 0o700 });
    await withNativeSourceRoot(source, async handle => {
      const base = observeSourceFile(handle);
      assert.equal(base.kind, "directory");
      assert.ok(base.dev > 0n && base.ino > 0n);
      const rootStatx = handle.observeStatx();
      assert.equal(rootStatx.kind, "directory");
      assert.equal(rootStatx.ino, base.ino);
      assert.equal(rootStatx.mask & 0x7ffn, 0x7ffn);
      assert.equal(rootStatx.mountId === null || rootStatx.mountId > 0n, true);
      assert.equal(rootStatx.birthtimeNs === null || typeof rootStatx.birthtimeNs === "bigint", true);
      assert.deepEqual(handle.readDirectory(), ["file.bin", "nested"]);
      assert.deepEqual(handle.readDirectory(), ["file.bin", "nested"], "enumeration is repeatable");
      const file = handle.openChild("file.bin", "file");
      const initial = file.observe();
      assert.equal(initial.kind, "file");
      assert.equal(initial.size, BigInt(bytes.length));
      const pinnedFacts = file.observeStatx();
      assert.equal(pinnedFacts.kind, "file");
      assert.equal(pinnedFacts.ino, initial.ino);
      assert.equal(pinnedFacts.mask & 0x7ffn, 0x7ffn);
      assert.equal(pinnedFacts.attributes & ~pinnedFacts.attributesMask, 0n,
        "unadvertised statx attribute bits must not be interpreted as facts");
      assert.deepEqual(file.readAt(0n, 6), bytes);
      assert.deepEqual(file.readAt(2n, 3), bytes.subarray(2, 5));
      assert.deepEqual(file.readAt(6n, 1), Buffer.alloc(0));
      assert.deepEqual(file.observe(), initial, "same live object and unchanged typed metadata");
      assert.deepEqual(file.observeStatx(), pinnedFacts, "statx uses the same stable owned FD");
      assert.throws(() => file.readAt(-1n, 1), { code: "source_changed" });
      assert.throws(() => file.readAt(0n, 65537), { code: "source_changed" });
      file.close();
      assert.throws(() => file.readAt(0n, 1), { code: "maintenance_lost" });
      assert.throws(() => file.observeStatx(), { code: "maintenance_lost" });
      assert.throws(() => file.close(), { code: "maintenance_lost" });
      const nested = handle.openChild("nested", "directory");
      assert.deepEqual(nested.readDirectory(), []);
      nested.close();
      assert.throws(() => matchSourceFileProfile(handle),
        error => error instanceof MaintenanceFailure && error.code === "backup_capability_unavailable");
    });
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

linuxTest("#152 P0 real native openat2 rejects symlink, hardlink, leaf escape and stale owned directory", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "br-p0-reject-")), source = path.join(tmp, "source");
  try {
    await mkdir(source, { mode: 0o700 });
    await writeFile(path.join(source, "multi"), "original", { mode: 0o600 });
    await link(path.join(source, "multi"), path.join(source, "alias"));
    await writeFile(path.join(source, "ordinary"), "ok", { mode: 0o600 });
    await symlink("ordinary", path.join(source, "sym"));
    await withNativeSourceRoot(source, async rootHandle => {
      for (const name of ["", ".", "..", "../escape", "a/b", "a\0b", "x".repeat(4097)])
        assert.throws(() => rootHandle.openChild(name, "file"));
      assert.throws(() => rootHandle.openChild("alias", "file"));
      assert.throws(() => rootHandle.openChild("multi", "file"));
      assert.throws(() => rootHandle.openChild("sym", "file"));
      assert.throws(() => rootHandle.openChild("ordinary", "directory"));
      assert.throws(() => rootHandle.readAt(0n, 1));
    });
    await symlink(source, path.join(tmp, "source-link"));
    await assert.rejects(withNativeSourceRoot(path.join(tmp, "source-link"), async () => {}),
      error => error instanceof Error);
    const native = createRequire(import.meta.url)(sourceFileNativePath) as NativeBinding;
    const raw = native.openRoot(source);
    native.close(raw);
    assert.throws(() => native.openChild(raw, "ordinary", "file"));
    assert.throws(() => native.observe(raw));
    assert.throws(() => native.observeStatx(raw));
    assert.throws(() => native.close(raw));
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

linuxTest("#152 P0 invalid source bytes/permissions and leaked children fail closed without issuing Fs", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "br-p0-cleanup-")), source = path.join(tmp, "source");
  try {
    await mkdir(source, { mode: 0o700 });
    await writeFile(path.join(source, "file"), "safe", { mode: 0o600 });
    await assert.rejects(withNativeSourceRoot(source, async rootHandle => {
      rootHandle.openChild("file", "file"); // The child's owner is intentionally not closed.
    }), error => error instanceof MaintenanceFailure && error.code === "maintenance_lost");
    let observed = false;
    try { await withNativeSourceRoot(source, async () => { throw undefined; }); }
    catch (error) { observed = true; assert.equal(error, undefined, "undefined is the original error"); }
    assert.equal(observed, true);
    await chmod(path.join(source, "file"), 0o666);
    await assert.rejects(withNativeSourceRoot(source, async rootHandle => {
      rootHandle.openChild("file", "file");
    }), error => error instanceof Error);
    await chmod(path.join(source, "file"), 0o600);
    await withNativeSourceRoot(source, async rootHandle => {
      const child = rootHandle.openChild("file", "file");
      assert.equal(child.observe().size, 4n);
      child.close();
    });
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

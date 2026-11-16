import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { constants } from "node:fs";
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withNativeSourceRoot, observeSourceFile, sourceFileNativePath } from "../src/server/storage/maintenance/source-file-native.ts";
import { matchSourceFileProfile } from "../src/server/storage/maintenance/source-file-profile.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";

const linuxTest = process.platform === "linux" ? test : test.skip;
const root = fileURLToPath(new URL("../", import.meta.url));
type NativeBinding = {
  openRoot(path: string): object;
  openChild(parent: object, leaf: string, kind: "file" | "directory"): object;
  observe(owner: object): { kind: string; dev: bigint; ino: bigint; size: bigint };
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
  for (const name of ["openRoot", "openChild", "observe", "readAt", "readDirectory", "close"] as const)
    assert.equal(typeof native[name], "function");
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
      assert.deepEqual(handle.readDirectory(), ["file.bin", "nested"]);
      assert.deepEqual(handle.readDirectory(), ["file.bin", "nested"], "enumeration is repeatable");
      const file = handle.openChild("file.bin", "file");
      const initial = file.observe();
      assert.equal(initial.kind, "file");
      assert.equal(initial.size, BigInt(bytes.length));
      assert.deepEqual(file.readAt(0n, 6), bytes);
      assert.deepEqual(file.readAt(2n, 3), bytes.subarray(2, 5));
      assert.deepEqual(file.readAt(6n, 1), Buffer.alloc(0));
      assert.deepEqual(file.observe(), initial, "same live object and unchanged typed metadata");
      assert.throws(() => file.readAt(-1n, 1), { code: "source_changed" });
      assert.throws(() => file.readAt(0n, 65537), { code: "source_changed" });
      file.close();
      assert.throws(() => file.readAt(0n, 1), { code: "maintenance_lost" });
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

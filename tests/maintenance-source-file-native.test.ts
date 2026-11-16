import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openSourceRoot, sourceFileNativePath } from "../src/server/storage/maintenance/source-file-native.ts";

const nativeTest = process.platform === "linux" ? test : test.skip;
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boardroom-native-source-p0-"));
  await chmod(directory, 0o700);
  const first = path.join(directory, "第一个.txt");
  const nested = path.join(directory, "nested");
  await mkdir(nested, { mode: 0o700 });
  await writeFile(first, Buffer.from("original source bytes"), { mode: 0o600 });
  await writeFile(path.join(nested, "empty.bin"), Buffer.alloc(0), { mode: 0o600 });
  return { directory, first, nested, close: () => rm(directory, { recursive: true, force: true }) };
}

nativeTest("#152 P0 real Node-API handle: same FD metadata, UTF-8 directory and bounded pread", async () => {
  const f = await fixture();
  let root, child, directory;
  try {
    assert.equal((await lstat(sourceFileNativePath)).isFile(), true);
    root = await openSourceRoot(f.directory);
    const seen = await root.readDirectory();
    assert.deepEqual(seen.map(item => item.name), ["nested", "第一个.txt"]);
    assert.ok(seen.every(item => Number.isInteger(item.type)));
    const rootIdentity = await root.observe();
    assert.equal(rootIdentity.kind, "directory");
    assert.equal(rootIdentity.uid, BigInt(process.getuid!()));
    assert.ok(rootIdentity.ino > 0n && rootIdentity.dev >= 0n);
    child = await root.openChild("第一个.txt");
    const actual = await lstat(f.first, { bigint: true });
    const identity = await child.observe();
    assert.equal(identity.kind, "file");
    assert.equal(identity.dev, actual.dev);
    assert.equal(identity.ino, actual.ino);
    assert.equal(identity.size, actual.size);
    assert.equal(identity.nlink, 1n);
    assert.deepEqual(await child.readAt(0n, 21), Buffer.from("original source bytes"));
    assert.deepEqual(await child.readAt(20n, 65_536), Buffer.alloc(0));
    directory = await root.openChild("nested");
    assert.deepEqual((await directory.readDirectory()).map(item => item.name), ["empty.bin"]);
    const zero = await directory.openChild("empty.bin");
    try { assert.deepEqual(await zero.readAt(0n, 0), Buffer.alloc(0)); }
    finally { await zero.close(); }
  } finally {
    await directory?.close(); await child?.close(); await root?.close(); await f.close();
  }
});

nativeTest("#152 P0 read-only parent FD resists path replacement and symbolic-link escapes", async () => {
  const f = await fixture();
  let original, renamed;
  try {
    original = await openSourceRoot(f.directory);
    const newRoot = f.directory + "-moved";
    await rename(f.directory, newRoot); renamed = newRoot;
    await mkdir(f.directory, { mode: 0o700 });
    await writeFile(path.join(f.directory, "第一个.txt"), "replacement");
    const before = await original.openChild("第一个.txt");
    try { assert.deepEqual(await before.readAt(0n, 21), Buffer.from("original source bytes")); }
    finally { await before.close(); }
    await symlink("/etc/passwd", path.join(newRoot, "escape"));
    await assert.rejects(original.openChild("escape"), { code: "source_changed" });
    await assert.rejects(original.openChild("../"), { code: "source_changed" });
    await assert.rejects(original.openChild(".."), { code: "source_changed" });
    await assert.rejects(original.openChild("nested/empty.bin"), { code: "source_changed" });
    await assert.rejects(original.openChild(""), { code: "source_changed" });
  } finally {
    await original?.close();
    await f.close();
    if (renamed) await rm(renamed, { recursive: true, force: true });
  }
});

nativeTest("#152 P0 a closed descriptor cannot be reused even after OS FD reuse", async () => {
  const f = await fixture(); let root;
  try {
    root = await openSourceRoot(f.directory);
    const stale = await root.openChild("第一个.txt");
    await stale.close();
    const replacement = await root.openChild("第一个.txt");
    try {
      await assert.rejects(stale.observe(), { code: "source_changed" });
      await assert.rejects(stale.readAt(0n, 1), { code: "source_changed" });
      await assert.rejects(stale.close(), { code: "source_changed" });
      assert.deepEqual(await replacement.readAt(0n, 8), Buffer.from("original"));
      await assert.rejects(replacement.readAt(-1n, 1), { code: "source_changed" });
      await assert.rejects(replacement.readAt(0n, 65_537), { code: "source_changed" });
      await assert.rejects(replacement.readAt(0n, 1.5), { code: "source_changed" });
    } finally { await replacement.close(); }
    await root.close();
    await assert.rejects(root.readDirectory(), { code: "source_changed" });
    await assert.rejects(root.openChild("nested"), { code: "source_changed" });
    root = undefined;
  } finally { await root?.close(); await f.close(); }
});

nativeTest("#152 P0 links and special-file owners are rejected, not interpreted as Fs qualification", async () => {
  const f = await fixture();
  let root;
  try {
    root = await openSourceRoot(f.directory);
    await symlink(f.first, path.join(f.directory, "linked"));
    await assert.rejects(root.openChild("linked"), { code: "source_changed" });
    await assert.rejects(root.readAt(0n, 2), { code: "source_changed" });
    const file = await root.openChild("第一个.txt");
    try { await assert.rejects(file.readDirectory(), { code: "source_changed" }); }
    finally { await file.close(); }
    assert.ok((await root.observe()).fsType > 0n);
  } finally { await root?.close(); await f.close(); }
});

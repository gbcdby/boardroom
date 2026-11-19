import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const linuxTest = process.platform === "linux" ? test : test.skip;
const root = fileURLToPath(new URL("../", import.meta.url));
interface Binding {
  openRoot(file: string): object;
  openChild(parent: object, leaf: string, kind: "file" | "directory"): object;
  readAt(owner: object, offset: bigint, size: number): Buffer;
  synchronize(owner: object): Promise<void>;
  closeAsync(owner: object): Promise<void>;
  closeUnstarted(owner: object): boolean;
  close(owner: object): void;
  reopenFile(owner: object): object;
  retainMetadata(owner: object): object;
  transferCarrier(metadata: object, carrier: object): void;
  observeEnvironment(owner: object): any;
  rootInfo(owner: object): any;
}

linuxTest("CFP2 actual ordinary R/V sync and close settle while the event loop remains available", async () => {
  const built = spawnSync(process.execPath, ["scripts/build-maintenance-platform.mjs", "--source-files"],
    { cwd: root, encoding: "utf8", timeout: 65_000 });
  assert.equal(built.status, 0, built.stderr);
  const native = createRequire(import.meta.url)(path.join(root, "build/maintenance-platform/maintenance-source-files-linux-" + process.arch + ".node")) as Binding;
  assert.equal(typeof native.synchronize, "function");
  assert.equal(typeof native.closeAsync, "function");
  const directory = await mkdtemp(path.join(tmpdir(), "br-cfp2-native-"));
  await chmod(directory, 0o700);
  const bytes = Buffer.from([0, 4, 255, 19, 64]);
  await writeFile(path.join(directory, "source"), bytes, { mode: 0o600 });
  const owners = new Set<object>();
  try {
    const parent = native.openRoot(directory); owners.add(parent);
    const r = native.openChild(parent, "source", "file"); owners.add(r);
    assert.equal(native.closeUnstarted(r), false, "a fresh owner without failed close startup cannot use fallback");
    assert.deepEqual(native.readAt(r, 0n, bytes.length), bytes);
    const v = native.reopenFile(r); owners.add(v);
    const metadata = native.retainMetadata(r); owners.add(metadata);
    const syncing = native.synchronize(r);
    assert(syncing instanceof Promise);
    assert.throws(() => native.close(r), { code: "ERR_SOURCE_BUSY" });
    assert.throws(() => native.closeUnstarted(r), { code: "ERR_SOURCE_BUSY" });
    assert.throws(() => native.readAt(r, 0n, 1), { code: "ERR_SOURCE_ARGUMENT" });
    await syncing;
    assert.deepEqual(native.readAt(r, 0n, bytes.length), bytes);
    const fresh = native.reopenFile(r); owners.add(fresh);
    await native.closeAsync(fresh); owners.delete(fresh);
    const closing = native.closeAsync(r);
    assert(closing instanceof Promise);
    assert.throws(() => native.close(r), { code: "ERR_SOURCE_BUSY" });
    await closing; owners.delete(r);
    assert.equal(native.closeUnstarted(r), true, "known actual completion is observable without another close");
    assert.throws(() => native.close(r), { code: "ERR_SOURCE_HANDLE" });
    await native.synchronize(v);
    assert.deepEqual(native.readAt(v, 0n, bytes.length), bytes);
    await native.closeAsync(v); owners.delete(v);
    await native.synchronize(parent);
    native.transferCarrier(metadata, parent); owners.delete(parent);
    assert.throws(() => native.rootInfo(parent), { code: "ERR_SOURCE_HANDLE" });
    assert.throws(() => native.close(parent), { code: "ERR_SOURCE_HANDLE" });
    const tail = native.observeEnvironment(metadata);
    assert.equal(tail.abiVersion, 3);
    assert.equal(tail.source.filesystemCarrier.role, "tail-carrier");
    assert.deepEqual(tail.source.filesystemCarrier.mount.before, tail.source.filesystemCarrier.mount.after);
    await native.closeAsync(metadata); owners.delete(metadata);
    assert.deepEqual(await readFile(path.join(directory, "source")), bytes);
  } finally {
    for (const owner of [...owners].reverse()) {
      try { await native.closeAsync(owner); } catch { /* Preserve the original test failure. */ }
    }
    await rm(directory, { recursive: true, force: true });
  }
});

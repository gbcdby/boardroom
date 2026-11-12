import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, rename, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalJson, digestJson } from "../src/server/storage/maintenance/canonical.ts";
import { ArtifactStore } from "../src/server/storage/maintenance/objects.ts";

const source = { kind: "sqlite" as const, databaseInstanceId: "1".repeat(32), identityDigest: "2".repeat(64) };
const linuxTest = process.platform === "linux" ? test : test.skip;

test("#152 canonical bodies preserve order-sensitive arrays and refuse lossy/non-JSON values", () => {
  assert.equal(canonicalJson({ z: [2, 1], a: "中" }), '{"a":"中","z":[2,1]}');
  assert.equal(digestJson({ z: [2, 1], a: "中" }), digestJson({ a: "中", z: [2, 1] }));
  for (const value of [undefined, NaN, Infinity, 9007199254740992, -0, 1n, new Date(), { a: undefined }, { a: () => 1 }, [, 1]])
    assert.throws(() => canonicalJson(value), /journal_invalid/);
  const cycle: unknown[] = []; cycle.push(cycle);
  assert.throws(() => canonicalJson(cycle), /journal_invalid/);
});

linuxTest("#152 immutable artifact publication reads exact bytes and refuses corruption or root replacement", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "br-objects-"));
  const root = path.join(dir, "control");
  try {
    const store = await ArtifactStore.create(root, source);
    const ref = await store.putBytes("source-file-payload", Buffer.from([0, 255, 33]));
    assert.deepEqual(await store.readBytes(ref), Buffer.from([0, 255, 33]));
    assert.equal((await stat(store.pathFor(ref))).mode & 0o777, 0o600);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.deepEqual(await store.putBytes("source-file-payload", Buffer.from([0, 255, 33])), ref);
    const publication = await store.confirmDurable(ref);
    assert.deepEqual(publication.completed, ["file_sync", "immutable_name_verified", "directory_sync"]);
    await writeFile(store.pathFor(ref), Buffer.from([0, 254, 33]));
    await assert.rejects(store.readBytes(ref), /snapshot_invalid/);
    await rename(root, `${root}.moved`);
    await symlink(`${root}.moved`, root);
    await assert.rejects(store.readBytes(ref), /control_root_mismatch/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

linuxTest("#152 publication fault before directory sync never yields a successful reference; orphan bytes remain untrusted", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "br-objects-crash-"));
  try {
    const store = await ArtifactStore.create(path.join(dir, "control"), source, { after: point => {
      if (point === "renamed") throw new Error("injected publication crash");
    } });
    await assert.rejects(store.putBytes("source-file-payload", Buffer.from("body")), /injected publication crash/);
    const reopened = await ArtifactStore.open(path.join(dir, "control"), source);
    const ref = await reopened.putBytes("source-file-payload", Buffer.from("body"));
    assert.equal(await readFile(reopened.pathFor(ref), "utf8"), "body");
    await assert.rejects(reopened.readBytes({ ...ref, ref: "../outside" }), /snapshot_invalid/);
    await assert.rejects(ArtifactStore.open(path.join(dir, "control"), { ...source, databaseInstanceId: "3".repeat(32) }), /control_root_mismatch/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

linuxTest("#152 capability probes the actual control filesystem and reports only observed syscalls", async t => {
  const dir = await mkdtemp(path.join(process.cwd(), "maintenance-capability-test-"));
  try {
    const operations: string[] = [];
    const store = await ArtifactStore.create(path.join(dir, "control"), source, { after: point => { operations.push(point); } });
    const capability = await store.capability();
    assert.deepEqual(operations, ["temp_written", "file_synced", "renamed", "directory_synced"]);
    assert.equal(capability.powerLossTested, false);
    assert.equal(capability.rootIdentity.path, store.root);
    t.diagnostic(JSON.stringify({ platform: capability.platform, filesystemType: capability.filesystemType,
      node: capability.node, observed: operations, powerLossTested: capability.powerLossTested }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

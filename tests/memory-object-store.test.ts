import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, rename, rm, stat, symlink, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { MemoryHeadCommitHeadValue } from "../src/server/memory/head-commit-value.ts";
import {
  createMemoryObjectStore, getMemoryObjectStoreErrorCode, MemoryObjectStoreError,
} from "../src/server/memory/object-store.ts";
import type { MemoryObjectStoreErrorCode, PublishPoint } from "../src/server/memory/object-store.ts";
import { memoryObjectRelativeKey, parseMemoryObjectRef } from "../src/server/memory/object-ref.ts";
import type { MemoryObjectRef } from "../src/server/memory/object-ref.ts";
import type { MemoryPublicationPlanValue } from "../src/server/memory/publication-plan.ts";
import { digestJson } from "../src/server/storage/maintenance/canonical.ts";

const platformTest = ["linux", "darwin"].includes(process.platform) ? test : test.skip;
const storageId = "memory-object-store-test";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

async function temporary(): Promise<string> {
  return mkdtemp(path.join(process.cwd(), "memory-object-store-"));
}
async function rejectsWith(promise: Promise<unknown>, code: MemoryObjectStoreErrorCode): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof MemoryObjectStoreError, "expected MemoryObjectStoreError");
    assert.equal(error.name, "MemoryObjectStoreError");
    assert.equal(error.code, code);
    assert.equal(error.message, `memory_object_store:${code}`);
    assert.equal(getMemoryObjectStoreErrorCode(error), code);
    assert.equal(Object.hasOwn(error, "cause"), false);
    return true;
  });
}
function refFor(bytes: Uint8Array): Readonly<MemoryObjectRef> {
  return parseMemoryObjectRef({
    objectFormat: "utf8-sha256-v1", storageId,
    contentSha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength,
  });
}
function head(version: number, seed: string, mutationKey: string, contentDigest: string): Readonly<MemoryHeadCommitHeadValue> {
  return Object.freeze({ version, receipt: sha(`receipt:${seed}`), digest: sha(`head:${seed}`), mutationKey, contentDigest });
}
function planFixture(refs: readonly Readonly<MemoryObjectRef>[]): Readonly<MemoryPublicationPlanValue> {
  const objects = Object.freeze(refs.map(ref => Object.freeze({
    relativePath: memoryObjectRelativeKey(ref), refDigest: digestJson(ref),
    byteLength: ref.byteLength, objectDigest: ref.contentSha256,
  })));
  const payload = { contract: "memory-publication-plan-value/r1", authorityDigest: sha("authority-fixture"), objects };
  return Object.freeze({ ...payload, digest: digestJson(payload) }) as Readonly<MemoryPublicationPlanValue>;
}

platformTest("MOBJSTORE-S4-T3: put/read 返回精确字节、ref 摘要与 UTF-8 正文", async () => {
  const root = await temporary();
  try {
    const store = await createMemoryObjectStore({ root, storageId });
    const markdown = "# 标题\n中文与 emoji 😀\n";
    const bytes = Buffer.from(markdown, "utf8");
    const ref = await store.put(markdown);
    assert.equal(ref.objectFormat, "utf8-sha256-v1");
    assert.equal(ref.storageId, storageId);
    assert.equal(ref.contentSha256, sha(markdown));
    assert.equal(ref.byteLength, bytes.byteLength);
    assert.equal(await store.read(ref), markdown);
    const file = path.join(root, memoryObjectRelativeKey(ref));
    assert.deepEqual(await readFile(file), bytes);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(root, "staging"))).mode & 0o777, 0o700);
  } finally { await rm(root, { recursive: true, force: true }); }
});

platformTest("MOBJSTORE-S4-T3: 同正文重复 put 复用 ref 且不覆盖目标", async () => {
  const root = await temporary();
  try {
    const store = await createMemoryObjectStore({ root, storageId });
    const first = await store.put("immutable body 中");
    const file = path.join(root, memoryObjectRelativeKey(first));
    const before = await stat(file, { bigint: true });
    const second = await store.put("immutable body 中");
    const after = await stat(file, { bigint: true });
    assert.deepEqual(second, first);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.deepEqual(await readFile(file), Buffer.from("immutable body 中", "utf8"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

platformTest("MOBJSTORE-S4-T3: 不同正文产生不同 ref 与不同 shard 路径", async () => {
  const root = await temporary();
  try {
    const store = await createMemoryObjectStore({ root, storageId });
    let other: string | undefined;
    for (let index = 1; index < 128; index++) {
      const candidate = `body-${index}`;
      if (sha(candidate).slice(0, 2) !== sha("body-0").slice(0, 2)) { other = candidate; break; }
    }
    assert.ok(other, "two distinct shard prefixes were not found");
    const first = await store.put("body-0");
    const second = await store.put(other);
    const keyA = memoryObjectRelativeKey(first), keyB = memoryObjectRelativeKey(second);
    assert.notEqual(first.contentSha256, second.contentSha256);
    assert.notEqual(path.dirname(keyA), path.dirname(keyB));
    assert.equal(keyA, `objects/sha256/${first.contentSha256.slice(0, 2)}/${first.contentSha256}.md`);
    assert.equal(keyB, `objects/sha256/${second.contentSha256.slice(0, 2)}/${second.contentSha256}.md`);
    assert.equal(await store.read(first), "body-0");
    assert.equal(await store.read(second), other);
  } finally { await rm(root, { recursive: true, force: true }); }
});

platformTest("MOBJSTORE-S4-T3: 缺文件、篡改、非法 UTF-8、超限、穿越与同形 ref 均受控拒绝", async () => {
  const root = await temporary();
  try {
    const store = await createMemoryObjectStore({ root, storageId });
    const ref = await store.put("original body");
    const file = path.join(root, memoryObjectRelativeKey(ref));
    await unlink(file);
    await rejectsWith(store.read(ref), "missing_object");
    await rejectsWith(store.confirmDurable(ref), "missing_object");

    const tampered = await store.put("tampered body");
    const tamperedFile = path.join(root, memoryObjectRelativeKey(tampered));
    await writeMode600(tamperedFile, Buffer.from("tampered bytes"));
    await rejectsWith(store.read(tampered), "object_integrity");

    const invalidBytes = Buffer.from([0xff, 0xfe, 0x00]);
    const invalid = refFor(invalidBytes);
    const invalidFile = path.join(root, memoryObjectRelativeKey(invalid));
    await mkShard(root, invalid);
    await writeMode600(invalidFile, invalidBytes);
    await rejectsWith(store.read(invalid), "object_integrity");

    await rejectsWith(store.put("x".repeat(1_048_577)), "body_limit_exceeded");
    await rejectsWith(store.read("../outside"), "invalid_ref");
    await rejectsWith(store.read({ ...ref, contentSha256: "../../outside" }), "invalid_ref");
    await rejectsWith(store.read({ ...ref, extra: true }), "invalid_ref");
    await rejectsWith(store.read(Object.assign(Object.create(null), { ...ref, extra: 1 })), "invalid_ref");
    await rejectsWith(store.read({ ...ref, storageId: "other-store" }), "invalid_ref");
    await rejectsWith(store.read({ ...ref, byteLength: 1_048_577 }), "invalid_ref");
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function writeMode600(file: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); } finally { await handle.close(); }
}
async function mkShard(root: string, ref: Readonly<MemoryObjectRef>): Promise<void> {
  const shard = path.join(root, path.dirname(memoryObjectRelativeKey(ref)));
  await mkdir(shard, { recursive: true, mode: 0o700 });
  await chmod(shard, 0o700);
}

platformTest("MOBJSTORE-S4-T3: 发布前失败不返回成功 ref，重试可成功且钩子顺序固定", async () => {
  const root = await temporary();
  try {
    const points: PublishPoint[] = [];
    const failing = await createMemoryObjectStore({ root, storageId }, { after: point => {
      points.push(point);
      if (point === "file_synced") throw new Error("injected publication crash");
    } });
    await rejectsWith(failing.put("crash-body"), "publication_failed");
    assert.deepEqual(points, ["temp_written", "file_synced"]);
    const unpublished = refFor(Buffer.from("crash-body", "utf8"));
    await assert.rejects(lstat(path.join(root, memoryObjectRelativeKey(unpublished))),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT");

    const retryPoints: PublishPoint[] = [];
    const retry = await createMemoryObjectStore({ root, storageId }, { after: point => { retryPoints.push(point); } });
    const ref = await retry.put("crash-body");
    assert.deepEqual(retryPoints, ["temp_written", "file_synced", "renamed", "directory_synced"]);
    assert.equal(await retry.read(ref), "crash-body");
    const confirmation = await retry.confirmDurable(ref);
    assert.deepEqual(confirmation.completed, ["file_sync", "immutable_name_verified", "directory_sync"]);
    assert.equal(confirmation.objectDigest, ref.contentSha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});

platformTest("MOBJSTORE-S4-T3: after 回调重入 put 受控拒绝，不死锁", async () => {
  const root = await temporary();
  try {
    let store: Awaited<ReturnType<typeof createMemoryObjectStore>>;
    let reentrantCode: MemoryObjectStoreErrorCode | undefined;
    store = await createMemoryObjectStore({ root, storageId }, { after: async point => {
      if (point !== "temp_written") return;
      try { await store.put("reentrant body"); }
      catch (error) {
        assert.ok(error instanceof MemoryObjectStoreError);
        reentrantCode = error.code;
        throw error;
      }
    } });
    await rejectsWith(store.put("outer body"), "publication_failed");
    assert.equal(reentrantCode, "publication_failed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

platformTest("MOBJSTORE-S4-T3: 并发同正文 put 原子不覆盖，目标 inode 保持不变", async () => {
  const root = await temporary();
  try {
    const body = "concurrent identical body";
    const file = path.join(root, memoryObjectRelativeKey(refFor(Buffer.from(body, "utf8"))));
    let publishedInode: bigint | undefined;
    const store = await createMemoryObjectStore({ root, storageId }, { after: async point => {
      if (point === "renamed") publishedInode = (await stat(file, { bigint: true })).ino;
    } });
    const [left, right] = await Promise.all([store.put(body), store.put(body)]);
    assert.deepEqual(left, right);
    assert.ok(publishedInode !== undefined, "first published inode was not observed");
    assert.equal((await stat(file, { bigint: true })).ino, publishedInode);
    const third = await store.put(body);
    assert.deepEqual(third, left);
    assert.equal((await stat(file, { bigint: true })).ino, publishedInode);
    assert.equal(await store.read(left), body);
  } finally { await rm(root, { recursive: true, force: true }); }
});

platformTest("MOBJSTORE-S4-T3: 并发异正文 put 产生两个独立对象，互不覆盖", async () => {
  const root = await temporary();
  try {
    const store = await createMemoryObjectStore({ root, storageId });
    const [left, right] = await Promise.all([store.put("parallel-a"), store.put("parallel-b")]);
    assert.notEqual(left.contentSha256, right.contentSha256);
    const leftFile = path.join(root, memoryObjectRelativeKey(left));
    const rightFile = path.join(root, memoryObjectRelativeKey(right));
    assert.notEqual(leftFile, rightFile);
    assert.deepEqual(await readFile(leftFile), Buffer.from("parallel-a", "utf8"));
    assert.deepEqual(await readFile(rightFile), Buffer.from("parallel-b", "utf8"));
    assert.equal(await store.read(left), "parallel-a");
    assert.equal(await store.read(right), "parallel-b");
  } finally { await rm(root, { recursive: true, force: true }); }
});

platformTest("MOBJSTORE-S4-T3: 共享 root 的跨实例并发同正文受控拒绝或复用，不覆盖不损坏", async () => {
  const root = await temporary();
  try {
    const body = "cross-instance concurrent body";
    const ref = refFor(Buffer.from(body, "utf8"));
    const file = path.join(root, memoryObjectRelativeKey(ref));
    let observedIno: bigint | undefined;
    const successes: Readonly<MemoryObjectRef>[] = [];
    const observe = async () => {
      try {
        const info = await stat(file, { bigint: true });
        assert.deepEqual(await readFile(file), Buffer.from(body, "utf8"));
        if (observedIno === undefined) observedIno = info.ino;
        assert.equal(info.ino, observedIno);
      } catch (error) {
        assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
      }
    };
    for (let round = 0; round < 5; round++) {
      const left = await createMemoryObjectStore({ root, storageId });
      const right = await createMemoryObjectStore({ root, storageId });
      const settled = await Promise.allSettled([left.put(body), right.put(body)]);
      for (const result of settled) {
        if (result.status === "fulfilled") {
          assert.deepEqual(result.value, ref);
          successes.push(result.value);
        } else {
          assert.ok(result.reason instanceof MemoryObjectStoreError, "cross-instance failure must be controlled");
          assert.ok(result.reason.code === "unsupported_durability" || result.reason.code === "object_integrity",
            `unexpected cross-instance code: ${String(result.reason.code)}`);
          assert.equal(Object.hasOwn(result.reason, "cause"), false);
        }
      }
      await observe();
    }
    const final = await (await createMemoryObjectStore({ root, storageId })).put(body);
    assert.deepEqual(final, ref);
    successes.push(final);
    await observe();
    assert.ok(successes.length > 0);
    assert.ok(observedIno !== undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

platformTest("MOBJSTORE-S4-T3: 已发布对象 chmod 0644 或 nlink>1 时拒绝读取、确认与复用", async () => {
  const root = await temporary();
  try {
    const store = await createMemoryObjectStore({ root, storageId });
    const ref = await store.put("committed body");
    const file = path.join(root, memoryObjectRelativeKey(ref));
    await chmod(file, 0o644);
    const modeBefore = await stat(file, { bigint: true });
    await rejectsWith(store.read(ref), "object_integrity");
    await rejectsWith(store.confirmDurable(ref), "object_integrity");
    await rejectsWith(store.put("committed body"), "object_integrity");
    const modeAfter = await stat(file, { bigint: true });
    assert.equal(modeAfter.ino, modeBefore.ino);
    assert.equal(modeAfter.mtimeNs, modeBefore.mtimeNs);
    assert.equal(modeAfter.mode & 0o777n, 0o644n);

    await chmod(file, 0o600);
    await link(file, path.join(root, "staging", "extra-hardlink"));
    assert.equal((await stat(file, { bigint: true })).nlink, 2n);
    await rejectsWith(store.read(ref), "object_integrity");
    await rejectsWith(store.confirmDurable(ref), "object_integrity");
    await rejectsWith(store.put("committed body"), "object_integrity");
  } finally { await rm(root, { recursive: true, force: true }); }
});

platformTest("MOBJSTORE-S4-T3: 拒绝非绝对根、符号链接根、非 0700 根及运行期根替换", async () => {
  const parent = await temporary();
  try {
    await rejectsWith(createMemoryObjectStore({ root: "relative/root", storageId }), "invalid_root");
    const root = path.join(parent, "root");
    await mkdir(root, { mode: 0o700 });
    const symlinkPath = path.join(parent, "link");
    await symlink(root, symlinkPath);
    await rejectsWith(createMemoryObjectStore({ root: symlinkPath, storageId }), "control_root_mismatch");
    await chmod(root, 0o755);
    await rejectsWith(createMemoryObjectStore({ root, storageId }), "control_root_mismatch");
    await chmod(root, 0o700);

    const store = await createMemoryObjectStore({ root, storageId });
    const ref = await store.put("root-bound body");
    const moved = path.join(parent, "moved");
    await rename(root, moved);
    await symlink(moved, root);
    await rejectsWith(store.read(ref), "control_root_mismatch");
  } finally { await rm(parent, { recursive: true, force: true }); }
});

platformTest("MOBJSTORE-S4-T3: head 门控按耐久证据裁决，缺任一对象 incomplete_durability", async () => {
  const root = await temporary();
  try {
    const store = await createMemoryObjectStore({ root, storageId });
    const first = await store.put("head-body-a");
    const second = await store.put("head-body-b");
    const digests = Object.freeze([(await store.confirmDurable(first)).objectDigest,
      (await store.confirmDurable(second)).objectDigest]);
    const plan = planFixture([first, second]);
    const current = head(1, "v1", "mutation-1", first.contentSha256);
    const target = head(2, "v2", "mutation-1", first.contentSha256);
    const mutation = Object.freeze({ key: "mutation-1", contentDigest: first.contentSha256 });
    const input = { durableObjectDigests: digests, plan, currentHead: current, expectedHead: current,
      targetHead: target, mutation };
    const allowed = store.decideHeadCommit(input);
    assert.equal(allowed.outcome, "commit-allowed");
    if (allowed.outcome !== "commit-allowed") return;
    assert.deepEqual(allowed.objectDigests, [...digests].sort());
    assert.deepEqual(allowed.head, target);

    const incomplete = store.decideHeadCommit({ ...input, durableObjectDigests: Object.freeze([digests[0]!]) });
    assert.equal(incomplete.outcome, "rejected");
    if (incomplete.outcome !== "rejected") return;
    assert.equal(incomplete.code, "incomplete_durability");
    assert.throws(() => store.decideHeadCommit({ ...input, durableObjectDigests: Object.freeze(["bad"]) }),
      (error: unknown) => {
        assert.ok(error instanceof MemoryObjectStoreError);
        assert.equal(error.code, "invalid_gate_input");
        assert.equal(Object.hasOwn(error, "cause"), false);
        return true;
      });
  } finally { await rm(root, { recursive: true, force: true }); }
});

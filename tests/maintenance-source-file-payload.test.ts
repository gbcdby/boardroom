import test from "node:test";
import assert from "node:assert/strict";
import promises, { lstat, mkdtemp, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { ArtifactStore } from "../src/server/storage/maintenance/objects.ts";
import { sha256 } from "../src/server/storage/maintenance/canonical.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";

const nativeTest = ["linux", "darwin"].includes(process.platform) ? test : test.skip;
const source = { kind: "sqlite" as const, databaseInstanceId: "1".repeat(32), identityDigest: "2".repeat(64) };
async function fixture() {
  const directory = await mkdtemp(path.join(process.cwd(), "maintenance-stream-payload-test-"));
  const store = await ArtifactStore.create(path.join(directory, "control"), source);
  return { store, close: () => rm(directory, { recursive: true, force: true }) };
}
async function rejected(work: Promise<unknown>) {
  try { await work; } catch (error) { return { failed: true, error }; }
  return { failed: false, error: undefined };
}

nativeTest("#152 payload: bounded chunks, exact bytes and same-owner publication", async () => {
  const f = await fixture();
  try {
    const expected = Buffer.concat([Buffer.alloc(64 * 1024, 0x61), Buffer.from([0, 0xff, 1]), Buffer.alloc(32 * 1024, 0x7a)]);
    async function* sourceChunks() {
      yield expected.subarray(0, 64 * 1024);
      yield expected.subarray(64 * 1024, 64 * 1024 + 3);
      yield expected.subarray(64 * 1024 + 3);
    }
    const ref = await f.store.putSourceFilePayload(sourceChunks(), BigInt(expected.length));
    assert.equal(ref.sha256, sha256(expected)); assert.equal(ref.bytes, String(expected.length));
    assert.equal(f.store.kindFor(ref), "source-file-payload");
    assert.deepEqual(await f.store.readBytes(ref), expected);
    await f.store.confirmDurable(ref);
    const result = f.store.publicationOutcomes().records.at(-1)!;
    assert.deepEqual(result.artifact, ref); assert.equal(result.handleOpened, true);
    assert.equal(result.handleClosed, true); assert.equal(result.operationFinished, true);
    assert.equal(result.pendingCleanup, false); assert.equal(result.failureObserved, false);
  } finally { await f.close(); }
});

nativeTest("#152 payload: short native writes and a reused producer buffer preserve exact bytes", async t => {
  const f = await fixture(), originalOpen = promises.open; let writes = 0;
  try {
    t.mock.method(promises, "open", async (...args: Parameters<typeof promises.open>) => {
      const handle = await Reflect.apply(originalOpen, promises, args);
      if (typeof args[0] === "string" && args[0].includes("/stream-") && args[0].endsWith(".tmp")) {
        const originalWrite = handle.write.bind(handle);
        Object.defineProperty(handle, "write", { configurable: true,
          value: async (buffer: Uint8Array, offset: number, length: number, position: number | null) => {
            writes++;
            return originalWrite(buffer, offset, Math.min(length, 7), position);
          } });
      }
      return handle;
    });
    syncBuiltinESMExports();
    async function* chunks() {
      const reused = Buffer.alloc(23, 0x34);
      yield reused;
      reused.fill(0x56);
      yield reused;
    }
    const expected = Buffer.concat([Buffer.alloc(23, 0x34), Buffer.alloc(23, 0x56)]);
    const ref = await f.store.putSourceFilePayload(chunks(), BigInt(expected.length));
    assert.ok(writes >= 8, "both chunks must actually handle partial native writes");
    assert.equal(ref.sha256, sha256(expected));
    assert.deepEqual(await f.store.readBytes(ref), expected);
    assert.equal(f.store.publicationOutcomes().records.at(-1)!.handleClosed, true);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
});

nativeTest("#152 payload: changing the current root/source guard before rename forbids publication", async () => {
  const f = await fixture(); let current = true;
  const bytes = Buffer.from([1, 2, 3, 4]), digest = sha256(bytes);
  try {
    const guarded = await ArtifactStore.open(f.store.root, source, {
      assertCurrent: async () => { if (!current) throw new MaintenanceFailure("source_changed"); },
      after: point => { if (point === "file_synced") current = false; }
    });
    await assert.rejects(guarded.putSourceFilePayload((async function* () { yield bytes; })(), BigInt(bytes.length)),
      error => error instanceof MaintenanceFailure && error.code === "source_changed");
    await assert.rejects(lstat(f.store.pathFor({
      ref: `snapshots/${digest}/source-file-payload.bin`, sha256: digest, bytes: String(bytes.length)
    })), { code: "ENOENT" });
    const outcome = f.store.publicationOutcomes().records.at(-1)!;
    assert.equal(outcome.handleClosed, true);
    assert.equal(outcome.failureObserved, true);
    assert.equal(outcome.pendingCleanup, false);
  } finally { await f.close(); }
});

nativeTest("#152 payload: an existing matching name is verified, never accepted when corrupted", async () => {
  const f = await fixture(), bytes = Buffer.from([11, 22, 33, 44]);
  try {
    const chunks = async function* () { yield bytes; };
    const ref = await f.store.putSourceFilePayload(chunks(), BigInt(bytes.length));
    const second = await f.store.putSourceFilePayload(chunks(), BigInt(bytes.length));
    assert.deepEqual(second, ref);
    await promises.writeFile(f.store.pathFor(ref), Buffer.from([11, 22, 33, 45]));
    await assert.rejects(f.store.putSourceFilePayload(chunks(), BigInt(bytes.length)),
      error => error instanceof MaintenanceFailure && error.code === "snapshot_invalid");
    assert.deepEqual(await promises.readFile(f.store.pathFor(ref)), Buffer.from([11, 22, 33, 45]));
    const outcome = f.store.publicationOutcomes().records.at(-1)!;
    assert.equal(outcome.handleClosed, true);
    assert.equal(outcome.failureObserved, true);
    assert.equal(outcome.pendingCleanup, false);
  } finally { await f.close(); }
});

nativeTest("#152 payload: a close-after failure retires its owner but cannot publish success", async t => {
  const f = await fixture(), originalOpen = promises.open, secondary = new Error("close-after");
  let injected = false;
  try {
    t.mock.method(promises, "open", async (...args: Parameters<typeof promises.open>) => {
      const handle = await Reflect.apply(originalOpen, promises, args);
      if (!injected && typeof args[0] === "string" && args[0].includes("/stream-") && args[0].endsWith(".tmp")) {
        injected = true;
        const originalClose = handle.close.bind(handle);
        handle.close = async () => { await originalClose(); throw secondary; };
      }
      return handle;
    });
    syncBuiltinESMExports();
    const bytes = Buffer.from([8, 9, 10]);
    const chunks = async function* () { yield bytes; };
    const outcome = await rejected(f.store.putSourceFilePayload(chunks(), BigInt(bytes.length)));
    assert.equal(outcome.failed, true); assert.strictEqual(outcome.error, secondary);
    const record = f.store.publicationOutcomes().records.at(-1)!;
    assert.equal(record.closeFailureObserved, true);
    assert.equal(record.handleClosed, true);
    assert.equal(record.pendingCleanup, false);
    await assert.rejects(lstat(f.store.pathFor({
      ref: `snapshots/${sha256(bytes)}/source-file-payload.bin`, sha256: sha256(bytes), bytes: String(bytes.length)
    })), { code: "ENOENT" });
    const ref = await f.store.putSourceFilePayload(chunks(), BigInt(bytes.length));
    assert.deepEqual(await f.store.readBytes(ref), bytes);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
});

nativeTest("#152 payload: empty source completes with the empty SHA-256 and no implicit chunk", async () => {
  const f = await fixture();
  try {
    async function* empty() {}
    const ref = await f.store.putSourceFilePayload(empty(), 0n);
    assert.equal(ref.sha256, sha256(Buffer.alloc(0)));
    assert.equal(ref.bytes, "0"); assert.deepEqual(await f.store.readBytes(ref), Buffer.alloc(0));
    await f.store.confirmDurable(ref);
  } finally { await f.close(); }
});

nativeTest("#152 payload: exact length, 1..64KiB chunks and safe-integer budget are enforced", async () => {
  const f = await fixture();
  try {
    const chunks = async function* (value: Uint8Array) { yield value; };
    for (const [payload, length] of [
      [Buffer.from([1]), 2n], [Buffer.from([1, 2]), 1n],
      [Buffer.alloc(0), 0n], [Buffer.alloc(64 * 1024 + 1), BigInt(64 * 1024 + 1)]
    ] as const) {
      await assert.rejects(f.store.putSourceFilePayload(chunks(payload), length),
        error => error instanceof MaintenanceFailure && error.code === "snapshot_invalid");
    }
    await assert.rejects(f.store.putSourceFilePayload(chunks(Buffer.from([1])), BigInt(Number.MAX_SAFE_INTEGER) + 1n),
      { code: "snapshot_invalid" });
    assert.equal(f.store.publicationOutcomes().records.every(item => item.handleClosed), true);
  } finally { await f.close(); }
});

nativeTest("#152 payload: source throw undefined survives a second iterator.return failure and settles owner", async () => {
  const f = await fixture(); let returned = 0;
  try {
    const sourceChunks: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => { throw undefined; },
          return: async () => { returned++; throw new MaintenanceFailure("snapshot_invalid", "secondary-return"); }
        };
      }
    };
    const result = await rejected(f.store.putSourceFilePayload(sourceChunks, 1n));
    assert.equal(result.failed, true); assert.strictEqual(result.error, undefined);
    assert.equal(returned, 1);
    const outcome = f.store.publicationOutcomes().records.at(-1)!;
    assert.equal(outcome.artifact, null); assert.equal(outcome.failureObserved, true);
    assert.equal(outcome.handleOpened, true); assert.equal(outcome.handleClosed, true);
    assert.equal(outcome.pendingCleanup, false);
  } finally { await f.close(); }
});

nativeTest("#245 payload: a throwing return getter preserves the source error and closes its owner", async t => {
  for (const first of [undefined, new Error("source-first")]) await t.test(first === undefined ? "undefined first" : "error first", async () => {
    const f = await fixture(); let reads = 0;
    try {
      const sourceChunks: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]() {
          const iterator = { next: async () => { throw first; } };
          Object.defineProperty(iterator, "return", { get() { reads++; throw new Error("secondary-return-getter"); } });
          return iterator;
        }
      };
      const result = await rejected(f.store.putSourceFilePayload(sourceChunks, 1n));
      assert.equal(result.failed, true); assert.strictEqual(result.error, first); assert.equal(reads, 1);
      const outcome = f.store.publicationOutcomes().records.at(-1)!;
      assert.equal(outcome.failureObserved, true); assert.equal(outcome.handleClosed, true); assert.equal(outcome.pendingCleanup, false);
    } finally { await f.store.cleanupPublications(); await f.close(); }
  });
});

nativeTest("#245 payload: iterator return is obtained once and called on the original iterator", async () => {
  const f = await fixture(), first = new Error("source-first"); let reads = 0, calls = 0;
  try {
    const sourceChunks: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        const iterator = { next: async () => { throw first; } };
        Object.defineProperty(iterator, "return", { get() {
          reads++;
          return async function(this: unknown) {
            assert.strictEqual(this, iterator); calls++; return { done: true as const, value: undefined };
          };
        } });
        return iterator;
      }
    };
    const result = await rejected(f.store.putSourceFilePayload(sourceChunks, 1n));
    assert.equal(result.failed, true); assert.strictEqual(result.error, first); assert.equal(reads, 1); assert.equal(calls, 1);
    assert.equal(f.store.publicationOutcomes().records.at(-1)!.handleClosed, true);
  } finally { await f.store.cleanupPublications(); await f.close(); }
});

nativeTest("#152 payload: cancellation settles iterator before publication", async () => {
  const f = await fixture(), abort = new AbortController(); let released = 0;
  try {
    const sourceChunks: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        let count = 0;
        return { next: async () => {
          if (count++) return { done: true as const, value: undefined };
          abort.abort(); return { done: false as const, value: Buffer.from([1]) };
        }, return: async () => { released++; return { done: true as const, value: undefined }; } };
      }
    };
    await assert.rejects(f.store.putSourceFilePayload(sourceChunks, 1n, { signal: abort.signal }), { code: "snapshot_invalid" });
    assert.equal(released, 1);
    const outcome = f.store.publicationOutcomes().records.at(-1)!;
    assert.equal(outcome.artifact, null); assert.equal(outcome.handleClosed, true);
  } finally { await f.close(); }
});


nativeTest("#152 payload: cancellation after sync still prevents immutable name publication", async () => {
  const f = await fixture(), abort = new AbortController();
  const bytes = Buffer.from([0x10, 0x20, 0x30, 0x40]);
  const digest = sha256(bytes);
  const reference = { ref: "snapshots/" + digest + "/source-file-payload.bin", sha256: digest, bytes: String(bytes.length) };
  try {
    const guarded = await ArtifactStore.open(f.store.root, source, {
      after(point) { if (point === "file_synced") abort.abort(); }
    });
    const chunks = (async function* () { yield bytes; })();
    await assert.rejects(guarded.putSourceFilePayload(chunks, BigInt(bytes.length), { signal: abort.signal }),
      error => error instanceof MaintenanceFailure && error.code === "snapshot_invalid");
    await assert.rejects(lstat(f.store.pathFor(reference)), { code: "ENOENT" });
    const result = f.store.publicationOutcomes().records.at(-1)!;
    assert.equal(result.operationFinished, true); assert.equal(result.handleClosed, true);
    assert.equal(result.failureObserved, true); assert.equal(result.pendingCleanup, false);
  } finally { await f.close(); }
});

nativeTest("#152 payload: original close owner remains pending until explicit cleanup", async t => {
  const f = await fixture(), originalOpen = promises.open;
  let owned: FileHandle | undefined, close: (() => Promise<void>) | undefined, closes = 0;
  const second = new MaintenanceFailure("snapshot_invalid", "secondary-close");
  try {
    t.mock.method(promises, "open", async (...args: Parameters<typeof promises.open>) => {
      const handle = await Reflect.apply(originalOpen, promises, args);
      if (typeof args[0] === "string" && args[0].includes("/stream-") && args[0].endsWith(".tmp")) {
        owned = handle; close = handle.close.bind(handle);
        handle.close = async () => { closes++; throw second; };
      }
      return handle;
    });
    syncBuiltinESMExports();
    const sourceChunks: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return { next: async () => { throw undefined; }, return: async () => ({ done: true as const, value: undefined }) };
      }
    };
    const result = await rejected(f.store.putSourceFilePayload(sourceChunks, 1n));
    assert.equal(result.failed, true); assert.strictEqual(result.error, undefined);
    assert.equal(closes, 1); assert.ok(owned && close);
    const outcome = f.store.publicationOutcomes().records.at(-1)!;
    assert.equal(outcome.handleClosed, false); assert.equal(outcome.closeFailureObserved, true);
    assert.equal(outcome.pendingCleanup, true);
    await assert.rejects(f.store.putSourceFilePayload((async function* () { yield Buffer.from([1]); })(), 1n),
      { code: "snapshot_invalid" });
    assert.equal(closes, 1);
    owned.close = close;
    await f.store.cleanupPublications();
    assert.equal(closes, 1); assert.equal(owned.fd, -1);
    assert.equal(f.store.publicationOutcomes().records.at(-1)!.pendingCleanup, false);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports();
    if (owned && close) { owned.close = close; await close().catch(() => {}); }
    await f.store.cleanupPublications(); await f.close(); }
});

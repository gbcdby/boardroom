import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, linkSync, mkdirSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import promises, { readFile, readdir, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { canonicalJson, sha256 } from "../src/server/storage/maintenance/canonical.ts";
import { ArtifactStore } from "../src/server/storage/maintenance/objects.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";
import type { SourceFileExtendedObservation } from "../src/server/storage/maintenance/source-file-native.ts";
import type { ArtifactRef } from "../src/server/storage/maintenance/types.ts";
import { readSourceFiles } from "../src/server/storage/maintenance/parse.ts";
import { isolatedSourceFiles, sourceFilesFixture } from "./fixtures/maintenance-source-files.ts";

const linuxTest = process.platform === "linux" ? test : test.skip;
async function rejected(work: Promise<unknown>) {
  try { await work; } catch (error) { return { rejected: true, error: error as { code: string; cause: unknown; closeErrors: unknown[]; tcutReached: boolean } }; }
  assert.fail("operation unexpectedly succeeded");
}
async function manifests(store: ArtifactStore): Promise<string[]> {
  const names: string[] = [];
  try {
    for (const digest of await readdir(path.join(store.root, "snapshots")))
      for (const leaf of await readdir(path.join(store.root, "snapshots", digest))) if (leaf === "source-files.json") names.push(digest);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return names;
}
linuxTest("#152 S fixture loads the real native owner bridge (no profile qualification)", () => {
  const result = spawnSync(process.execPath, ["scripts/build-maintenance-platform.mjs", "--source-files"],
    { cwd: process.cwd(), encoding: "utf8", timeout: 65_000 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
});
linuxTest("#152 S captures exact streamed bytes, full roots and durable canonical payload closure", async () => {
  const copy = await isolatedSourceFiles(), f = await sourceFilesFixture();
  try {
    const result = await copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference);
    assert.deepEqual(await readSourceFiles(f.store, result.ref), result.manifest);
    assert.deepEqual(result.manifest.entries.map(entry => entry.sourceRoot + "/" + entry.sourceRelativePath),
      ["config/", "managed-sessions/", "managed-sessions/empty", "managed-sessions/nested", "managed-sessions/nested/binary"]);
    const binary = result.manifest.entries.find(entry => entry.sourceRelativePath === "nested/binary")!;
    assert.equal(binary.kind, "file"); assert.equal(binary.payload?.sha256, sha256(f.expected));
    assert.deepEqual(await f.store.readBytes(binary.payload!), f.expected);
    assert.equal(f.state.handles.size, 0); assert.ok(f.state.maxHandles <= 7);
    await copy.module.verifyLiveSourceFiles(f.store, f.lock, f.mutex, f.reference, result.ref);
    assert.equal(f.state.handles.size, 0);
  } finally { await f.close(); await copy.close(); }
});
linuxTest("#152 S absent root binds its actual nearest ancestor without inventing an entry handle", async () => {
  const copy = await isolatedSourceFiles(), f = await sourceFilesFixture({ sessions: "absent", config: false });
  try {
    const result = await copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference);
    assert.equal(result.manifest.entries.length, 1); assert.equal(result.manifest.entries[0]!.kind, "absent");
    assert.equal(result.manifest.rootBindings[0]!.anchorPath, f.directory);
    assert.equal(f.state.events.some(value => value.startsWith("read:")), false);
    await copy.module.verifyLiveSourceFiles(f.store, f.lock, f.mutex, f.reference, result.ref);
  } finally { await f.close(); await copy.close(); }
});

linuxTest("#152 S live allows directory member restoration and fresh mount/environment observations", async () => {
  const copy = await isolatedSourceFiles(), f = await sourceFilesFixture();
  try {
    const captured = await copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference);
    const originalBytes = await f.store.readBytes(captured.ref);
    const transient = path.join(f.sessions, "transient"); mkdirSync(transient, { mode: 0o700 }); rmdirSync(transient);
    f.state.mountDelta = 70n;
    await copy.module.verifyLiveSourceFiles(f.store, f.lock, f.mutex, f.reference, captured.ref);
    assert.deepEqual(await f.store.readBytes(captured.ref), originalBytes, "live does not re-sign frozen readEvidence");
    assert.equal((await manifests(f.store)).length, 1);
  } finally { await f.close(); await copy.close(); }
});

linuxTest("#152 S live rejects content, file change, mode, xattr, flags, identity and membership changes", async t => {
  const cases: readonly [string, (f: Awaited<ReturnType<typeof sourceFilesFixture>>) => void][] = [
    ["bytes", f => writeFileSync(path.join(f.sessions, "nested/binary"), Buffer.from("changed bytes"))],
    ["same bytes after write", f => writeFileSync(path.join(f.sessions, "nested/binary"), f.expected)],
    ["mode", f => chmodSync(path.join(f.sessions, "empty"), 0o400)],
    ["raw xattr", f => f.state.attributes.set(path.join(f.sessions, "empty"), [{ name: Buffer.from([0x75, 0xff]), value: Buffer.from([0, 0xff, 0x80]) }])],
    ["flags", f => f.state.flags.set(path.join(f.sessions, "empty"), 0x40n)],
    ["same-stat different opaque identity", f => f.state.identities.set(path.join(f.sessions, "empty"), "ab".repeat(8))],
    ["new member", f => writeFileSync(path.join(f.sessions, "added"), "new", { mode: 0o600 })],
    ["missing member", f => unlinkSync(path.join(f.sessions, "empty"))],
    ["replaced directory", f => { const old = f.sessions + "-old"; renameSync(f.sessions, old); mkdirSync(f.sessions, { mode: 0o700 }); }],
  ];
  for (const [name, change] of cases) await t.test(name, async () => {
    const copy = await isolatedSourceFiles(), f = await sourceFilesFixture();
    try {
      const captured = await copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference);
      change(f); const result = await rejected(copy.module.verifyLiveSourceFiles(f.store, f.lock, f.mutex, f.reference, captured.ref));
      assert.equal(result.error.code, "source_changed"); assert.equal(f.state.handles.size, 0);
      assert.equal((await manifests(f.store)).length, 1);
    } finally { await f.close(); await copy.close(); }
  });
});

linuxTest("#152 S rejects lost locks, changed state/schema/roster and bad root selection", async t => {
  for (const name of ["lock", "state", "schema", "source", "bad-reference"] as const) await t.test(name, async () => {
    const copy = await isolatedSourceFiles(), f = await sourceFilesFixture();
    try {
      if (name === "lock") f.loseLock();
      if (name === "state") f.changeObservation(value => ({ ...value, state: { ...value.state, activeMigrationId: "another-plan" } }));
      if (name === "schema") f.changeObservation(value => ({ ...value, manifests: { ...value.manifests, schemaManifestDigest: "2".repeat(64) } }));
      if (name === "source") f.changeObservation(value => ({ ...value, source: { ...value.source, identityDigest: "2".repeat(64) } }));
      const reference = name === "bad-reference" ? { ...f.reference, controlRoot: f.directory } : f.reference;
      const result = await rejected(copy.module.captureSourceFiles(f.store, f.lock, f.mutex, reference));
      assert.ok(["maintenance_lost", "source_changed", "plan_stale"].includes(result.error.code));
      assert.equal((await manifests(f.store)).length, 0); assert.equal(f.state.handles.size, 0);
    } finally { await f.close(); await copy.close(); }
  });
});

linuxTest("#152 S bounds contents, entries, depth, accumulated metadata and elapsed work without truncation", async t => {
  const cases = [
    ["single file", "const MAX_FILE_BYTES = 256n * 1024n * 1024n", "const MAX_FILE_BYTES = 4n"],
    ["total contents", "MAX_CONTENT_BYTES = 1024n * 1024n * 1024n", "MAX_CONTENT_BYTES = 4n"],
    ["entries", "const MAX_ENTRIES = 250_000", "const MAX_ENTRIES = 2"],
    ["depth", "MAX_DEPTH = 128", "MAX_DEPTH = 0"],
    ["accumulated metadata", "const MAX_MANIFEST_BYTES = 16 * 1024 * 1024", "const MAX_MANIFEST_BYTES = 2_000"],
    ["work", "const MAX_WORK_MS = 120_000", "const MAX_WORK_MS = 0"],
  ];
  for (const [name, original, replacement] of cases) await t.test(name!, async () => {
    const copy = await isolatedSourceFiles({ [original!]: replacement! }), f = await sourceFilesFixture();
    try {
      const result = await rejected(copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference));
      assert.equal(result.error.code, "backup_capability_unavailable");
      assert.equal((await manifests(f.store)).length, 0); assert.equal(f.state.handles.size, 0);
    } finally { await f.close(); await copy.close(); }
  });
});

linuxTest("#152 S missing native facts and invalid UUID/FID/unique-mount evidence fail closed", async t => {
  for (const name of ["unavailable", "zero-uuid", "wrong-fid", "missing-unique", "unique-mismatch"] as const) await t.test(name, async () => {
    const copy = await isolatedSourceFiles(), f = await sourceFilesFixture();
    try {
      f.state.hook = (operation, _, value) => {
        if (operation === "extended-result") {
          const facts = value as unknown as { [key: string]: unknown };
          const extended = value as SourceFileExtendedObservation;
          if (name === "unavailable") facts.fid = { status: "unavailable", reason: "syscall", value: null,
            calls: [{ operation: "name-to-handle-at", rc: -1n, errno: 95n }] };
          if (name === "zero-uuid" && extended.uuid.status === "observed") extended.uuid.value.bytes.fill(0);
          if (name === "wrong-fid" && extended.fid.status === "observed") facts.fid = { ...extended.fid, value: { ...extended.fid.value, handleType: 2n } };
        }
        if (operation === "statx-unique-result") {
          const statx = value as { uniqueMountId: bigint | null; mask: bigint };
          if (name === "missing-unique") { statx.uniqueMountId = null; statx.mask &= ~0x4000n; }
          if (name === "unique-mismatch") statx.uniqueMountId = 71n;
        }
      };
      const result = await rejected(copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference));
      assert.ok(["source_changed", "backup_capability_unavailable"].includes(result.error.code));
      assert.equal((await manifests(f.store)).length, 0); assert.equal(f.state.handles.size, 0);
    } finally { await f.close(); await copy.close(); }
  });
});

linuxTest("#152 S intra-window content/namespace/mount/health/lock changes do not publish Fs", async t => {
  for (const name of ["content", "namespace", "mount", "health", "lock"] as const) await t.test(name, async () => {
    const copy = await isolatedSourceFiles(), f = await sourceFilesFixture();
    try {
      let changed = false;
      f.state.hook = (operation, file) => {
        if (changed) return;
        if (name === "health" && operation === "profile:after") { changed = true; f.state.health = "1\n"; }
        if (operation === "read" && file.endsWith("/binary")) {
          changed = true;
          if (name === "content") writeFileSync(file, Buffer.alloc(f.expected.length, 0x31));
          if (name === "namespace") renameSync(file, file + "-moved");
          if (name === "mount") f.state.mountDelta++;
          if (name === "lock") f.loseLock();
        }
      };
      const result = await rejected(copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference));
      assert.ok(["source_changed", "backup_capability_unavailable", "maintenance_lost"].includes(result.error.code));
      assert.equal((await manifests(f.store)).length, 0); assert.equal(f.state.handles.size, 0);
    } finally { await f.close(); await copy.close(); }
  });
});

linuxTest("#152 S symlink, hardlink and special roots cannot become source entries", async t => {
  for (const name of ["symlink", "hardlink"] as const) await t.test(name, async () => {
    const copy = await isolatedSourceFiles(), f = await sourceFilesFixture();
    try {
      const target = path.join(f.sessions, "empty"), extra = path.join(f.sessions, "alias");
      if (name === "symlink") symlinkSync(target, extra); else linkSync(target, extra);
      const result = await rejected(copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference));
      assert.equal(result.error.code, "source_changed"); assert.equal((await manifests(f.store)).length, 0);
      assert.equal(f.state.handles.size, 0);
    } finally { await f.close(); await copy.close(); }
  });
});

linuxTest("#152 S preserves a thrown undefined before independent child close failure", async () => {
  const copy = await isolatedSourceFiles(), f = await sourceFilesFixture(), closeError = new Error("synthetic-child-close");
  try {
    f.state.hook = (operation, file) => {
      if (file.endsWith("/binary") && operation === "read") throw undefined;
      if (file.endsWith("/binary") && operation === "closed") throw closeError;
    };
    const result = await rejected(copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference));
    assert.equal(result.error.cause, undefined); assert.ok(result.error.closeErrors.includes(closeError));
    assert.equal(result.error.tcutReached, false); assert.equal(f.state.handles.size, 0);
    assert.equal((await manifests(f.store)).length, 0);
  } finally { await f.close(); await copy.close(); }
});

linuxTest("#152 S root close uncertainty is retained independently and prevents Tcut", async () => {
  const copy = await isolatedSourceFiles(), f = await sourceFilesFixture({ config: false }), closeError = new Error("synthetic-root-close");
  try {
    let afterHealth = false;
    f.state.hook = (operation, file) => {
      if (file === f.sessions && operation === "profile:after") afterHealth = true;
      if (file === f.sessions && operation === "closed" && afterHealth) throw closeError;
    };
    const result = await rejected(copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference));
    assert.equal(result.error.cause, closeError); assert.ok(result.error.closeErrors.includes(closeError));
    assert.equal(result.error.tcutReached, false); assert.equal(f.state.handles.size, 0);
    assert.equal((await manifests(f.store)).length, 0);
  } finally { await f.close(); await copy.close(); }
});

linuxTest("#152 S Tcut does not turn a later durability rejection into success", async t => {
  const copy = await isolatedSourceFiles(), f = await sourceFilesFixture();
  const original = ArtifactStore.prototype.confirmDurable, failure = new MaintenanceFailure("snapshot_invalid", "synthetic-final-sync");
  try {
    t.mock.method(ArtifactStore.prototype, "confirmDurable", async function(this: ArtifactStore, reference: ArtifactRef) {
      if (this.kindFor(reference) === "source-files") throw failure;
      return original.call(this, reference);
    });
    const result = await rejected(copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference));
    assert.equal(result.error.cause, failure); assert.equal(result.error.code, "snapshot_invalid");
    assert.equal(result.error.tcutReached, true); assert.equal(f.state.handles.size, 0);
    const attempts = await readdir(path.join(f.store.root, "attempts")); let record: { tcutReached: boolean; outcome: string } | undefined;
    for (const name of attempts) {
      try { record = JSON.parse(await readFile(path.join(f.store.root, "attempts", name, "source-files-read.json"), "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    assert.equal(record?.tcutReached, true); assert.equal(record?.outcome, "failed");
  } finally { await f.close(); await copy.close(); }
});

linuxTest("#152 S live keeps archive damage in snapshot_invalid and leaves frozen bytes unchanged", async t => {
  for (const name of ["payload", "strict-fs"] as const) await t.test(name, async () => {
    const copy = await isolatedSourceFiles(), f = await sourceFilesFixture();
    try {
      const captured = await copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference);
      let reference = captured.ref;
      if (name === "payload") {
        const payload = captured.manifest.entries.find(entry => entry.payload?.bytes === String(f.expected.length))!.payload!;
        await writeFile(f.store.pathFor(payload), Buffer.alloc(f.expected.length, 0x23));
      } else reference = await f.store.putJson("source-files", { ...captured.manifest, unknown: true });
      const result = await rejected(copy.module.verifyLiveSourceFiles(f.store, f.lock, f.mutex, f.reference, reference));
      assert.equal(result.error.code, "snapshot_invalid"); assert.equal(f.state.handles.size, 0);
      assert.equal(canonicalJson(await readSourceFiles(f.store, captured.ref)), canonicalJson(captured.manifest));
    } finally { await f.close(); await copy.close(); }
  });
});

linuxTest("#152 S production fixed matcher keeps an empty registry fail-closed", async () => {
  const production = await import("../src/server/storage/maintenance/source-files.ts");
  const f = await sourceFilesFixture({ config: false });
  try {
    const result = await rejected(production.captureSourceFiles(f.store, f.lock, f.mutex, f.reference));
    assert.equal(result.error.code, "backup_capability_unavailable");
    assert.equal((await manifests(f.store)).length, 0);
    assert.equal(f.state.events.length, 0, "production never invokes the test profile/owner module");
    await f.mutex.assertHeld(); await f.lock.assertHeld();
  } finally { await f.close(); }
});

linuxTest("#152 S live rejects a newly present absent root and never updates its frozen proof", async () => {
  const copy = await isolatedSourceFiles(), f = await sourceFilesFixture({ config: false, sessions: "absent" });
  try {
    const captured = await copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference);
    const bytes = await f.store.readBytes(captured.ref);
    mkdirSync(f.sessions, { mode: 0o700 });
    const result = await rejected(copy.module.verifyLiveSourceFiles(f.store, f.lock, f.mutex, f.reference, captured.ref));
    assert.equal(result.error.code, "source_changed"); assert.deepEqual(await f.store.readBytes(captured.ref), bytes);
    assert.equal(f.state.handles.size, 0);
  } finally { await f.close(); await copy.close(); }
});

linuxTest("#152 S within-window directory time changes remain guarded even if membership is restored", async () => {
  const copy = await isolatedSourceFiles(), f = await sourceFilesFixture({ config: false });
  try {
    let changed = false;
    f.state.hook = (operation, file) => {
      if (changed || operation !== "read" || !file.endsWith("/binary")) return;
      changed = true;
      const temporary = path.join(f.sessions, "transient"); mkdirSync(temporary, { mode: 0o700 }); rmdirSync(temporary);
    };
    const result = await rejected(copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference));
    assert.equal(result.error.code, "source_changed"); assert.equal((await manifests(f.store)).length, 0);
    assert.equal(f.state.handles.size, 0);
  } finally { await f.close(); await copy.close(); }
});

linuxTest("#152 S long metadata reaches its cumulative limit before retaining the remaining tree", async () => {
  const copy = await isolatedSourceFiles({ "const MAX_MANIFEST_BYTES = 16 * 1024 * 1024": "const MAX_MANIFEST_BYTES = 3_000" });
  const f = await sourceFilesFixture({ config: false });
  try {
    for (let i = 0; i < 16; i++) writeFileSync(path.join(f.sessions, String(i).padStart(2, "0") + "x".repeat(180)), "", { mode: 0o600 });
    f.resetReadTimes();
    const result = await rejected(copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference));
    assert.equal(result.error.code, "backup_capability_unavailable");
    assert.ok(f.state.events.filter(event => event.startsWith("read:")).length < 16, "budget rejects during traversal");
    assert.equal((await manifests(f.store)).length, 0); assert.equal(f.state.handles.size, 0);
  } finally { await f.close(); await copy.close(); }
});

linuxTest("#152 S a known historical profile is unavailable rather than silently upgraded", async () => {
  const copy = await isolatedSourceFiles(), f = await sourceFilesFixture();
  try {
    const captured = await copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference);
    const legacy = { ...captured.manifest, rootBindings: captured.manifest.rootBindings.map(binding => {
      assert.equal(binding.profile, "linux-native-ext4-fid-fsuuid-source-state-v1");
      const { readEvidence: _, ...fields } = binding as Extract<typeof binding, { profile: "linux-native-ext4-fid-fsuuid-source-state-v1" }>;
      return { ...fields, profile: "linux-native-ext4-fid-fsuuid-v1" };
    }) };
    const reference = await f.store.putJson("source-files", legacy);
    const result = await rejected(copy.module.verifyLiveSourceFiles(f.store, f.lock, f.mutex, f.reference, reference));
    assert.equal(result.error.code, "backup_capability_unavailable");
    assert.deepEqual(await f.store.readBytes(reference), Buffer.from(canonicalJson(legacy)));
  } finally { await f.close(); await copy.close(); }
});

linuxTest("#152 S root context binds complete getter facts to the actual scan observation", async () => {
  const copy = await isolatedSourceFiles(), f = await sourceFilesFixture({ config: false });
  try {
    let observations = 0;
    f.state.hook = (operation, file) => {
      if (file === f.sessions && operation === "extended" && ++observations === 2) f.state.flags.set(file, 0x40n);
    };
    const result = await rejected(copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference));
    assert.equal(result.error.code, "source_changed"); assert.equal((await manifests(f.store)).length, 0);
    assert.equal(f.state.handles.size, 0);
  } finally { await f.close(); await copy.close(); }
});

linuxTest("#152 S private attempt close errors retain their actual owner and cannot authorize another window", async t => {
  const copy = await isolatedSourceFiles(), f = await sourceFilesFixture(), closeError = new Error("synthetic-attempt-close");
  const originalOpen = promises.open;
  try {
    t.mock.method(promises, "open", async (...args: Parameters<typeof promises.open>) => {
      const handle = await Reflect.apply(originalOpen, promises, args);
      if (typeof args[0] === "string" && args[0].endsWith("/source-files-read.json")) {
        const close = handle.close.bind(handle);
        Object.defineProperty(handle, "close", { configurable: true, value: async () => { await close(); throw closeError; } });
      }
      return handle;
    });
    syncBuiltinESMExports();
    const result = await rejected(copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference));
    assert.equal(result.error.cause, closeError); assert.ok(result.error.closeErrors.includes(closeError));
    assert.equal(result.error.tcutReached, true); assert.equal(f.state.handles.size, 0);
    t.mock.restoreAll(); syncBuiltinESMExports(); f.state.events.length = 0;
    const second = await rejected(copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference));
    assert.equal(second.error.code, "backup_capability_unavailable");
    assert.equal(f.state.events.length, 0, "a fresh source scope cannot erase an unresolved auxiliary close");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); await copy.close(); }
});

linuxTest("#152 S rechecks the actual lock after private record cleanup before returning", async t => {
  const copy = await isolatedSourceFiles(), f = await sourceFilesFixture();
  const originalOpen = promises.open;
  try {
    t.mock.method(promises, "open", async (...args: Parameters<typeof promises.open>) => {
      const handle = await Reflect.apply(originalOpen, promises, args);
      if (typeof args[0] === "string" && args[0].endsWith("/source-files-read.json")) {
        const close = handle.close.bind(handle);
        Object.defineProperty(handle, "close", { configurable: true, value: async () => { await close(); f.loseLock(); } });
      }
      return handle;
    });
    syncBuiltinESMExports();
    const result = await rejected(copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference));
    assert.equal(result.error.code, "maintenance_lost"); assert.equal(result.error.tcutReached, true);
    assert.equal(f.state.handles.size, 0);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); await copy.close(); }
});

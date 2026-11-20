import test from "node:test";
import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import { chmodSync, linkSync, lstatSync, mkdirSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import promises, { readFile, readdir, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalJson, sha256 } from "../src/server/storage/maintenance/canonical.ts";
import { ArtifactStore } from "../src/server/storage/maintenance/objects.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";
import type { SourceFileExtendedObservation, SourceFileNativeCall } from "../src/server/storage/maintenance/source-file-native.ts";
import type { SourceFileRootObservation } from "../src/server/storage/maintenance/source-file-profile.ts";
import type { ArtifactRef } from "../src/server/storage/maintenance/types.ts";
import { readSourceFiles } from "../src/server/storage/maintenance/parse.ts";
import { isolatedSourceFiles, sourceFilesFixture, withNativeSourceRoot } from "./fixtures/maintenance-source-files.ts";

const linuxTest = process.platform === "linux" ? test : test.skip;
async function rejected(work: Promise<unknown>) {
  try { await work; } catch (error) { return { rejected: true, error: error as { code: string; cause: unknown; closeErrors: unknown[]; tcutReached: boolean } }; }
  assert.fail("operation unexpectedly succeeded");
}

linuxTest("#152 IG1 RED capture rejects a non-narrow child before its payload", async () => {
  const copy = await isolatedSourceFiles(), f = await sourceFilesFixture({ config: false, prepare: true });
  try {
    f.state.flags.set(path.join(f.sessions, "nested", "binary"), 0x40n);
    const result = await rejected(copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference));
    assert.equal(result.error.code, "backup_capability_unavailable");
    assert(!f.state.events.includes("read:sessions/nested/binary"));
    assert.equal(result.error.tcutReached, false); assert.equal(f.state.handles.size, 0);
  } finally { await f.close(); await copy.close(); }
});

linuxTest("#152 IG1 RED same-source parent is admitted before child enumeration or payload", async () => {
  const copy = await isolatedSourceFiles(), f = await sourceFilesFixture({ config: false, prepare: true });
  try {
    f.state.flags.set(f.directory, 0x40n);
    const result = await rejected(copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference));
    assert.equal(result.error.code, "backup_capability_unavailable");
    assert(!f.state.events.some(event => /^(read|enumerate|synchronize):/.test(event)));
    assert.equal(result.error.tcutReached, false); assert.equal(f.state.handles.size, 0);
  } finally { await f.close(); await copy.close(); }
});
async function manifests(store: ArtifactStore): Promise<string[]> {
  const names: string[] = [];
  try {
    for (const digest of await readdir(path.join(store.root, "snapshots")))
      for (const leaf of await readdir(path.join(store.root, "snapshots", digest))) if (leaf === "source-files.json") names.push(digest);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return names;
}
interface EntryWindowRecord {
  readonly sourceRoot: string;
  readonly sourceRelativePath: string;
  readonly before: { readonly metadata: Record<string, string>; readonly legacy: { readonly mountId: string };
    readonly unique: { readonly uniqueMountId: string } };
  readonly after: EntryWindowRecord["before"] | null;
}
interface ReadAttemptRecord {
  readonly entries: readonly EntryWindowRecord[];
  readonly roots: readonly { readonly sourceRoot: string; readonly before: HealthWindowRecord; readonly after: HealthWindowRecord | null }[];
  readonly tcutReached: boolean;
  readonly outcome: string;
}
interface HealthWindowRecord {
  readonly health: Readonly<Record<string, { readonly bytes: string; readonly device: string; readonly inode: string;
    readonly mode: string; readonly filesystemType: string;
    readonly calls: readonly { readonly operation: string; readonly rc: string | null; readonly errno: string | null }[] }>>;
}
function successfulKernelReadCalls(bytes: Buffer, fd: bigint, split: boolean): readonly SourceFileNativeCall[] {
  const call = (operation: string, rc = 0n) => ({ operation, rc, errno: 0n });
  return [call("open-kernel-read", fd), call("fstat-kernel-before"), call("fstatfs-kernel-before"),
    ...(split ? [call("read-kernel", 1n), call("read-kernel", BigInt(bytes.length - 1))] : [call("read-kernel", BigInt(bytes.length))]),
    call("read-kernel"), call("fstatfs-kernel-after"), call("fstat-kernel-after"), call("close-kernel-read")];
}
async function readAttempts(store: ArtifactStore): Promise<ReadAttemptRecord[]> {
  const records: ReadAttemptRecord[] = [];
  for (const directory of await readdir(path.join(store.root, "attempts"))) {
    try { records.push(JSON.parse(await readFile(path.join(store.root, "attempts", directory, "source-files-read.json"), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return records;
}
linuxTest("#152 S fixture loads the real native owner bridge (no profile qualification)", () => {
  const result = spawnSync(process.execPath, ["scripts/build-maintenance-platform.mjs", "--source-files"],
    { cwd: process.cwd(), encoding: "utf8", timeout: 65_000 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
});
linuxTest("#152 S shared fixture prepares the current native bridge once before actual owner use", async t => {
  const original = childProcess.spawnSync;
  const script = fileURLToPath(new URL("../scripts/build-maintenance-platform.mjs", import.meta.url));
  const fixtures: Awaited<ReturnType<typeof sourceFilesFixture>>[] = [];
  let builds = 0;
  t.mock.method(childProcess, "spawnSync", function(...args: Parameters<typeof original>) {
    if (args[0] === process.execPath && Array.isArray(args[1]) && args[1][0] === script) builds++;
    return Reflect.apply(original, childProcess, args);
  });
  syncBuiltinESMExports();
  try {
    for (let index = 0; index < 2; index++) {
      const f = await sourceFilesFixture(); fixtures.push(f);
      await withNativeSourceRoot(f.sessions, handle => assert.equal(handle.kind, "directory"));
      assert.equal(f.state.handles.size, 0);
    }
    assert.equal(builds, 1, "an existing addon is rebuilt, then the second fixture shares that completed preparation");
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    for (const f of fixtures) await f.close();
  }
});
linuxTest("#152 S shared fixture preserves an actual compiler failure without retry or fixture creation", async t => {
  const directory = await promises.mkdtemp(path.join(process.cwd(), ".agent-output-s-build-failure-"));
  const originalFixture = new URL("./fixtures/maintenance-source-files.ts", import.meta.url);
  const fixtureDirectory = path.join(directory, "tests", "fixtures"), nativeDirectory = path.join(directory, "native");
  const addon = path.join(directory, "build", "maintenance-platform", "maintenance-source-files-linux-" + process.arch + ".node");
  let creations = 0;
  try {
    await promises.mkdir(fixtureDirectory, { recursive: true });
    await promises.mkdir(path.join(directory, "scripts"));
    await promises.mkdir(nativeDirectory);
    await promises.copyFile(new URL("../scripts/build-maintenance-platform.mjs", import.meta.url), path.join(directory, "scripts", "build-maintenance-platform.mjs"));
    await promises.cp(new URL("../native/node-api", import.meta.url), path.join(nativeDirectory, "node-api"), { recursive: true });
    await writeFile(path.join(nativeDirectory, "maintenance-source-files.c"), "#error controlled fixture compiler failure\n");
    const code = (await readFile(originalFixture, "utf8")).replace(/from "(\.{1,2}\/[^"\n]+)"/g,
      (_, relative: string) => "from " + JSON.stringify(new URL(relative, originalFixture).href));
    const fixtureFile = path.join(fixtureDirectory, "maintenance-source-files.ts"); await writeFile(fixtureFile, code);
    const fixture = await import(pathToFileURL(fixtureFile).href) as typeof import("./fixtures/maintenance-source-files.ts");
    const mkdtemp = promises.mkdtemp;
    t.mock.method(promises, "mkdtemp", ((...args: Parameters<typeof mkdtemp>) => {
      if (String(args[0]).endsWith("maintenance-s-test-")) creations++;
      return Reflect.apply(mkdtemp, promises, args);
    }) as typeof mkdtemp);
    syncBuiltinESMExports();
    let first: unknown;
    await assert.rejects(fixture.sourceFilesFixture(), error => {
      first = error; assert(error instanceof Error);
      assert.match(error.message, /source-files fixture native build failed \(1\/null\)/);
      assert.match(error.message, /Linux source-file native compiler failed/); return true;
    });
    // A fresh build would now succeed, but this same failed initialization must
    // remain failed. Only this test's private native input/output is changed.
    await promises.copyFile(new URL("../native/maintenance-source-files.c", import.meta.url), path.join(nativeDirectory, "maintenance-source-files.c"));
    await assert.rejects(fixture.sourceFilesFixture(), error => error === first);
    assert.equal(creations, 0); await assert.rejects(promises.access(addon), { code: "ENOENT" });
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    await promises.rm(directory, { recursive: true, force: true });
  }
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

linuxTest("C3 readonly S revalidates the full source without creating an attempt or publication", async t => {
  const copy = await isolatedSourceFiles(), f = await sourceFilesFixture();
  try {
    const captured = await copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference);
    const before = (await readdir(f.store.root, { recursive: true })).sort(), frozen = await f.store.readBytes(captured.ref);
    const windows = f.state.windows;
    for (const method of ["createAttempt", "putJson", "putBytes", "putSourceFilePayload", "confirmDurable"] as const)
      t.mock.method(ArtifactStore.prototype, method, () => { assert.fail("readonly S must not publish or create attempts"); });
    await copy.module.verifyLiveSourceFilesReadOnly(f.store, f.lock, f.mutex, f.reference, captured.ref);
    assert(f.state.windows > windows, "the fixed entry actually reopens and scans native source windows");
    assert.equal(f.state.handles.size, 0);
    assert.deepEqual((await readdir(f.store.root, { recursive: true })).sort(), before);
    assert.deepEqual(await f.store.readBytes(captured.ref), frozen);
    f.state.health = "1\n";
    const failed = await rejected(copy.module.verifyLiveSourceFilesReadOnly(f.store, f.lock, f.mutex, f.reference, captured.ref));
    assert.equal(failed.error.code, "backup_capability_unavailable");
    assert.equal(f.state.handles.size, 0);
    assert.deepEqual((await readdir(f.store.root, { recursive: true })).sort(), before);
    f.state.health = "0\n";
    writeFileSync(path.join(f.sessions, "nested", "binary"), "changed source bytes", { mode: 0o600 });
    f.resetReadTimes();
    const changed = await rejected(copy.module.verifyLiveSourceFilesReadOnly(f.store, f.lock, f.mutex, f.reference, captured.ref));
    assert.equal(changed.error.code, "source_changed");
    assert.deepEqual((await readdir(f.store.root, { recursive: true })).sort(), before);
  } finally { t.mock.restoreAll(); await f.close(); await copy.close(); }
});

linuxTest("C3 readonly S enforces retained metadata and final diagnostic envelope budgets without attempts", async t => {
  const copy = await isolatedSourceFiles(), f = await sourceFilesFixture();
  try {
    const captured = await copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference);
    const before = (await readdir(f.store.root, { recursive: true })).sort();
    for (const [name, limits] of [
      ["retained metadata", { "const MAX_MANIFEST_BYTES = 16 * 1024 * 1024": "const MAX_MANIFEST_BYTES = 2_000" }],
      ["final envelope", { "Buffer.byteLength(encoded) <= MAX_MANIFEST_BYTES": "Buffer.byteLength(encoded) <= 1" }],
    ] as const) await t.test(name, async () => {
      const bounded = await isolatedSourceFiles(limits);
      try {
        const failed = await rejected(bounded.module.verifyLiveSourceFilesReadOnly(f.store, f.lock, f.mutex, f.reference, captured.ref));
        assert.equal(failed.error.code, "backup_capability_unavailable");
        assert.match(String(failed.error.cause), /source-files-budget/);
        assert.equal(f.state.handles.size, 0);
        assert.deepEqual((await readdir(f.store.root, { recursive: true })).sort(), before);
      } finally { await bounded.close(); }
    });
  } finally { await f.close(); await copy.close(); }
});

linuxTest("C3 readonly S retains a thrown undefined and independent real-owner close failure", async () => {
  const copy = await isolatedSourceFiles(), f = await sourceFilesFixture(), closeError = new Error("readonly-child-close");
  try {
    const captured = await copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference);
    const before = (await readdir(f.store.root, { recursive: true })).sort();
    f.state.hook = (operation, file) => {
      if (file.endsWith("/binary") && operation === "read") throw undefined;
      if (file.endsWith("/binary") && operation === "closed") throw closeError;
    };
    const failed = await rejected(copy.module.verifyLiveSourceFilesReadOnly(f.store, f.lock, f.mutex, f.reference, captured.ref));
    assert.equal(failed.error.cause, undefined); assert(failed.error.closeErrors.includes(closeError));
    assert.equal(failed.error.tcutReached, false); assert.equal(f.state.handles.size, 0);
    assert.deepEqual((await readdir(f.store.root, { recursive: true })).sort(), before);
  } finally { await f.close(); await copy.close(); }
});
linuxTest("#152 S private entry windows retain nested directory times and child atime in capture and live", async () => {
  const copy = await isolatedSourceFiles(), f = await sourceFilesFixture();
  try {
    const captured = await copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference);
    const frozen = await f.store.readBytes(captured.ref), records = await readAttempts(f.store);
    assert.equal(records.length, 1);
    const capture = records[0]!;
    assert.equal(capture.entries.length, captured.manifest.entries.length);
    for (const relative of ["nested", "nested/binary"]) {
      const entry = capture.entries.find(value => value.sourceRoot === "managed-sessions" && value.sourceRelativePath === relative)!;
      const actual = lstatSync(path.join(f.sessions, relative), { bigint: true });
      assert.ok(entry.after, "the actual after observation is retained separately");
      for (const field of ["atimeNs", "mtimeNs", "ctimeNs"] as const) {
        assert.equal(entry.before.metadata[field], String(actual[field]));
        assert.equal(entry.after.metadata[field], String(actual[field]));
      }
      assert.equal(entry.before.legacy.mountId, "71"); assert.equal(entry.after.unique.uniqueMountId, "9001");
    }
    assert.equal(canonicalJson(captured.manifest).includes("atimeNs"), false, "window times do not enter persistent Fs identity");
    const temporary = path.join(f.sessions, "nested", "temporary"); mkdirSync(temporary, { mode: 0o700 }); rmdirSync(temporary);
    f.state.mountDelta = 70n;
    await copy.module.verifyLiveSourceFiles(f.store, f.lock, f.mutex, f.reference, captured.ref);
    const attempts = await readAttempts(f.store);
    assert.equal(attempts.length, 2);
    const live = attempts.find(record => record.entries.some(entry => entry.before.legacy.mountId === "141"))!;
    const before = capture.entries.find(entry => entry.sourceRelativePath === "nested")!;
    const after = live.entries.find(entry => entry.sourceRelativePath === "nested")!;
    assert.notEqual(after.before.metadata.ctimeNs, before.before.metadata.ctimeNs, "each window records its own directory time");
    assert.deepEqual(after.after, after.before);
    assert.deepEqual(await f.store.readBytes(captured.ref), frozen, "live evidence never rewrites frozen Fs");
    assert.equal(f.state.handles.size, 0);
  } finally { await f.close(); await copy.close(); }
});
linuxTest("#152 S independent health reads allow fresh auxiliary FDs and valid read segments while retaining their traces", async t => {
  for (const change of ["auxiliary-fd", "read-segments"] as const) await t.test(change, async () => {
    const copy = await isolatedSourceFiles(), f = await sourceFilesFixture({ config: false });
    try {
      f.state.hook = (operation, _, value) => {
        if (operation !== "profile:before-result" && operation !== "profile:after-result") return;
        const after = operation === "profile:after-result", observed = value as SourceFileRootObservation;
        for (const [index, item] of Object.values(observed.health).entries()) Object.assign(item, {
          calls: successfulKernelReadCalls(item.bytes, BigInt(100 + index + (after && change === "auxiliary-fd" ? 1 : 0)),
            after && change === "read-segments"),
        });
      };
      const captured = await copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference);
      await copy.module.verifyLiveSourceFiles(f.store, f.lock, f.mutex, f.reference, captured.ref);
      const attempts = await readAttempts(f.store); assert.equal(attempts.length, 2);
      for (const attempt of attempts) {
        const root = attempt.roots[0]!; assert.ok(root.after);
        assert.equal(Object.keys(root.before.health).length, 13); assert.equal(Object.keys(root.after.health).length, 13);
        const before = root.before.health.errors_count!, after = root.after.health.errors_count!;
        assert.equal(before.bytes, after.bytes); assert.equal(before.inode, after.inode);
        assert.notDeepEqual(before.calls, after.calls, "raw call evidence is kept independently for each sample");
        assert.equal(after.calls.at(-1)?.operation, "close-kernel-read"); assert.equal(after.calls.at(-1)?.rc, "0");
      }
      assert.equal(f.state.handles.size, 0);
    } finally { await f.close(); await copy.close(); }
  });
});
linuxTest("#152 S health field bytes and same-source identities remain guarded and getter failures propagate", async t => {
  for (const field of ["bytes", "device", "inode", "mode", "filesystemType", "field-set", "getter-failure"] as const)
    await t.test(field, async () => {
      const copy = await isolatedSourceFiles(), f = await sourceFilesFixture({ config: false });
      const failure = new MaintenanceFailure("backup_capability_unavailable", "fixture-health-getter");
      try {
        f.state.hook = (operation, _, value) => {
          if (operation === "profile:after" && field === "getter-failure") throw failure;
          if (operation !== "profile:after-result") return;
          const health = (value as SourceFileRootObservation).health, item = health.errors_count;
          if (field === "bytes") item.bytes[0] = 0x31;
          else if (field === "field-set") Reflect.deleteProperty(health, "last_error_func");
          else if (field !== "getter-failure") Object.assign(item, { [field]: item[field] + 1n });
        };
        const result = await rejected(copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference));
        if (field === "getter-failure") assert.equal(result.error.cause, failure);
        else assert.equal(result.error.code, "source_changed");
        const [attempt] = await readAttempts(f.store); assert.ok(attempt);
        if (field === "getter-failure") assert.equal(attempt.roots[0]!.after, null);
        else assert.ok(attempt.roots[0]!.after, "an obtained but changed health observation remains evidence");
        assert.equal(result.error.tcutReached, false); assert.equal(f.state.handles.size, 0);
        assert.equal((await manifests(f.store)).length, 0);
      } finally { await f.close(); await copy.close(); }
    });
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
    const [attempt] = await readAttempts(f.store); assert.ok(attempt);
    const partial = attempt.entries.find(entry => entry.sourceRelativePath === "nested/binary")!;
    assert.equal(partial.before.metadata.atimeNs, String(lstatSync(path.join(f.sessions, "nested", "binary"), { bigint: true }).atimeNs));
    assert.equal(partial.after, null, "a failed read never fabricates the unobserved after snapshot");
    const root = attempt.roots.find(entry => entry.sourceRoot === "managed-sessions")!;
    assert.equal(Object.keys(root.before.health).length, 13); assert.equal(root.after, null);
    assert.equal(attempt.tcutReached, false); assert.equal(attempt.outcome, "failed");
  } finally { await f.close(); await copy.close(); }
});
linuxTest("#152 S retains an actual differing after snapshot before rejecting its window", async () => {
  const copy = await isolatedSourceFiles(), f = await sourceFilesFixture({ config: false });
  try {
    let observations = 0;
    f.state.hook = (operation, file, value) => {
      if (operation !== "extended-result" || !file.endsWith("/binary") || ++observations !== 3) return;
      const observed = value as { before: { atimeNs: bigint }; after: { atimeNs: bigint } };
      observed.before.atimeNs++; observed.after.atimeNs++;
    };
    const result = await rejected(copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference));
    assert.equal(result.error.code, "source_changed"); assert.equal(observations, 3);
    const [attempt] = await readAttempts(f.store); assert.ok(attempt);
    const entry = attempt.entries.find(value => value.sourceRelativePath === "nested/binary")!;
    assert.ok(entry.after);
    assert.equal(BigInt(entry.after.metadata.atimeNs!), BigInt(entry.before.metadata.atimeNs!) + 1n);
    assert.equal(attempt.roots[0]!.after, null); assert.equal(attempt.outcome, "failed");
    assert.equal(result.error.tcutReached, false); assert.equal((await manifests(f.store)).length, 0);
    assert.equal(f.state.handles.size, 0);
  } finally { await f.close(); await copy.close(); }
});
linuxTest("#152 S diagnostic write and close errors cannot replace an earlier thrown undefined", async t => {
  const copy = await isolatedSourceFiles(), f = await sourceFilesFixture();
  const originalOpen = promises.open, writeError = new Error("synthetic-diagnostic-write"), closeError = new Error("synthetic-diagnostic-close");
  try {
    f.state.hook = (operation, file) => { if (operation === "read" && file.endsWith("/binary")) throw undefined; };
    t.mock.method(promises, "open", async (...args: Parameters<typeof promises.open>) => {
      const handle = await Reflect.apply(originalOpen, promises, args);
      if (typeof args[0] === "string" && args[0].endsWith("/source-files-read.json")) {
        const close = handle.close.bind(handle);
        Object.defineProperty(handle, "writeFile", { configurable: true, value: async () => { throw writeError; } });
        Object.defineProperty(handle, "close", { configurable: true, value: async () => { await close(); throw closeError; } });
      }
      return handle;
    });
    syncBuiltinESMExports();
    const result = await rejected(copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference));
    assert.equal(result.error.cause, undefined); assert.ok(result.error.closeErrors.includes(closeError));
    assert.equal(result.error.tcutReached, false); assert.equal((await manifests(f.store)).length, 0);
    assert.equal(f.state.handles.size, 0);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); await copy.close(); }
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
linuxTest("#152 S window diagnostics share the metadata budget and stop before retaining the remaining entries", async () => {
  const limit = 20_000;
  const copy = await isolatedSourceFiles({ "const MAX_MANIFEST_BYTES = 16 * 1024 * 1024": "const MAX_MANIFEST_BYTES = " + limit });
  const f = await sourceFilesFixture({ config: false });
  try {
    for (let i = 0; i < 12; i++) writeFileSync(path.join(f.sessions, "budget-" + String(i).padStart(2, "0")), "", { mode: 0o600 });
    f.resetReadTimes();
    const result = await rejected(copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference));
    const reads = f.state.events.filter(event => event.startsWith("read:sessions/budget-")).length;
    assert.ok(reads > 0 && reads < 12, "the accumulated window evidence stops traversal before reading the full tree");
    assert.equal(result.error.code, "backup_capability_unavailable"); assert.equal(result.error.tcutReached, false);
    const attempts = await readAttempts(f.store); assert.equal(attempts.length, 1);
    assert.ok(Buffer.byteLength(canonicalJson(attempts[0])) <= limit, "the complete private JSON envelope is bounded too");
    assert.ok(attempts[0]!.entries.length > 0 && attempts[0]!.entries.length < 12);
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

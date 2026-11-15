import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, stat, readdir, rm, chmod, open, opendir, symlink, link, rename, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArtifactStore } from "../src/server/storage/maintenance/objects.ts";
import { parseSourceFiles } from "../src/server/storage/maintenance/parse.ts";
import { assertRestoreArtifactSeparation, restoreSourceFiles, SourceFilesRestoreFailure } from "../src/server/storage/maintenance/restore-files.ts";
import type { SourceFileEntry, SourceRef } from "../src/server/storage/maintenance/types.ts";

const platformTest = ["linux", "darwin"].includes(process.platform) ? test : test.skip;
const bytes = Buffer.from([0, 255, 128, 13, 10, 65, 0]);

async function fixture(configAbsent = false) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "br-restore-files-")));
  const original = path.join(directory, "original"), sessions = path.join(original, "sessions"), config = path.join(original, "config");
  await mkdir(original, { mode: 0o700 });
  await mkdir(sessions, { mode: 0o750 }); await chmod(sessions, 0o750);
  await mkdir(path.join(sessions, "deep"), { mode: 0o710 }); await chmod(path.join(sessions, "deep"), 0o710);
  await mkdir(path.join(sessions, "empty"), { mode: 0o700 });
  await writeFile(path.join(sessions, "deep", "data.bin"), bytes, { mode: 0o640 });
  await chmod(path.join(sessions, "deep", "data.bin"), 0o640);
  await writeFile(path.join(sessions, "zero"), Buffer.alloc(0), { mode: 0o600 });
  if (!configAbsent) { await writeFile(config, bytes, { mode: 0o640 }); await chmod(config, 0o640); }
  const source: SourceRef = { kind: "sqlite", databaseInstanceId: "1".repeat(32), identityDigest: "2".repeat(64) };
  const store = await ArtifactStore.create(path.join(directory, "control"), source);
  const identity = async (file: string) => { const s = await stat(file, { bigint: true }); return { path: file, device: String(s.dev), inode: String(s.ino) }; };
  const handle = (n: number) => ({ type: 1 as const, byteCount: 8 as const, hex: n.toString(16).padStart(16, "0") });
  // These persisted protocol fixtures have real payload bytes and filesystem identities.
  // Synthetic native witnesses do not claim Fs provider or source-scan qualification.
  const entries: SourceFileEntry[] = [];
  for (const [root, relative, n] of [["managed-sessions", "deep/data.bin", 3], ["managed-sessions", "", 2],
    ["managed-sessions", "zero", 4], ["managed-sessions", "empty", 5], ["managed-sessions", "deep", 6], ["config", "", 1]] as const) {
    const file = root === "config" ? config : path.join(sessions, relative);
    if (root === "config" && configAbsent) {
      entries.push({ sourceRoot: root, sourceRelativePath: relative, kind: "absent", identity: null, mode: null, size: null, payload: null, sourceWitness: null });
      continue;
    }
    const s = await stat(file, { bigint: true }), id = await identity(file), mode = (s.mode & 0o7777n).toString(8);
    if (s.isDirectory()) entries.push({ sourceRoot: root, sourceRelativePath: relative, kind: "directory", identity: id, mode,
      size: String(s.size), payload: null, sourceWitness: { kind: "directory", incarnation: handle(n) } });
    else entries.push({ sourceRoot: root, sourceRelativePath: relative, kind: "file", identity: id, mode, size: String(s.size),
      payload: await store.putBytes("source-file-payload", await readFile(file)), sourceWitness: { kind: "file", incarnation: handle(n),
        change: { mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs), observedBirthtimeNs: null } } });
  }
  const configAncestor = await identity(configAbsent ? original : config), sessionsIdentity = await identity(sessions);
  const manifest = parseSourceFiles({ formatVersion: 2, kind: "source-files", source,
    roots: [
      { label: "config", path: config, expected: { path: config, existingAncestor: configAncestor, absentSegments: configAbsent ? ["config"] : [] } },
      { label: "managed-sessions", path: sessions, expected: { path: sessions, existingAncestor: sessionsIdentity, absentSegments: [] } },
    ],
    rootBindings: [
      { sourceRoot: "config", anchorPath: configAncestor.path, anchorKind: configAbsent ? "directory" : "file", hostIdentityDigest: "3".repeat(64), filesystemUuidHex: "4".repeat(32),
        profile: "linux-native-ext4-fid-fsuuid-v1", filesystemType: "ext4", anchorHandle: handle(1) },
      { sourceRoot: "managed-sessions", anchorPath: sessions, anchorKind: "directory", hostIdentityDigest: "3".repeat(64), filesystemUuidHex: "4".repeat(32),
        profile: "linux-native-ext4-fid-fsuuid-v1", filesystemType: "ext4", anchorHandle: handle(2) },
    ], entries, sourceMembershipExclusions: ["database-files", "entire-maintenance-control-root", "all-maintenance-artifacts"] });
  const reference = await store.putJson("source-files", manifest), attempt = await store.createAttempt(1), destination = path.join(attempt, "files");
  return { directory, original, config, sessions, source, store, manifest, reference, attempt, destination,
    async close() { await rm(directory, { recursive: true, force: true }); } };
}

platformTest("#152 isolated file restore reads actual binary payloads, preserves modes and complete membership", async () => {
  const f = await fixture();
  try {
    const before = await f.store.readBytes(f.reference);
    const result = await restoreSourceFiles(f.store, f.reference, f.destination);
    assert.equal(result.kind, "isolated-source-files-restore");
    assert.deepEqual(result.sourceFilesManifest, f.reference);
    assert.equal(result.target.path, f.destination);
    assert.equal((await stat(f.destination)).mode & 0o7777, 0o700);
    assert.deepEqual((await readdir(f.destination)).sort(), ["config", "managed-sessions"]);
    assert.deepEqual((await readdir(path.join(f.destination, "managed-sessions"))).sort(), ["deep", "empty", "zero"]);
    assert.deepEqual(await readFile(path.join(f.destination, "config")), bytes);
    assert.deepEqual(await readFile(path.join(f.destination, "managed-sessions", "deep", "data.bin")), bytes);
    assert.equal((await stat(path.join(f.destination, "managed-sessions", "zero"))).size, 0);
    assert.equal((await stat(path.join(f.destination, "config"))).mode & 0o7777, 0o640);
    assert.equal((await stat(path.join(f.destination, "managed-sessions"))).mode & 0o7777, 0o750);
    assert.equal((await stat(path.join(f.destination, "managed-sessions", "deep"))).mode & 0o7777, 0o710);
    assert.equal(result.entries.length, f.manifest.entries.length);
    assert.deepEqual(await readFile(f.config), bytes); assert.deepEqual(await readFile(path.join(f.sessions, "deep", "data.bin")), bytes);
    assert.deepEqual(await f.store.readBytes(f.reference), before);
  } finally { await f.close(); }
});

platformTest("#152 isolated file restore preserves absent roots, empty directories and restrictive numeric modes", async () => {
  const f = await fixture(true);
  try {
    const manifest = { ...f.manifest, entries: f.manifest.entries.map(entry => entry.kind === "directory"
      ? { ...entry, size: "900719925474099312345", mode: entry.sourceRelativePath === "deep" ? "0000" : entry.mode }
      : entry.kind === "file" && entry.sourceRelativePath === "zero" ? { ...entry, mode: "0000" } : entry) };
    const reference = await f.store.putJson("source-files", manifest);
    const result = await restoreSourceFiles(f.store, reference, f.destination);
    await assert.rejects(stat(path.join(f.destination, "config")), { code: "ENOENT" });
    assert.equal((await stat(path.join(f.destination, "managed-sessions", "deep"))).mode & 0o7777, 0);
    assert.equal((await stat(path.join(f.destination, "managed-sessions", "zero"))).mode & 0o7777, 0);
    assert.deepEqual(await readdir(path.join(f.destination, "managed-sessions", "empty")), []);
    assert.equal(result.entries.find(entry => entry.kind === "absent")?.identity, null);
    assert.ok(result.entries.filter(entry => entry.kind === "directory").every(entry => entry.bytes === null));
  } finally {
    await chmod(path.join(f.destination, "managed-sessions", "deep"), 0o700).catch(() => {});
    await f.close();
  }
});

platformTest("#152 file restore rejects invalid or incomplete persisted closures before any target creation", async t => {
  for (const scenario of ["missing-leaf", "wrong-hash", "wrong-size", "duplicate", "missing-directory", "file-parent", "invalid-mode", "extra-field", "wrong-source", "traversal", "absolute-relative"] as const) {
    await t.test(scenario, async () => {
      const f = await fixture();
      try {
        let value: any = structuredClone(f.manifest);
        const leaf = value.entries.find((entry: SourceFileEntry) => entry.kind === "file" && entry.sourceRelativePath !== "");
        if (scenario === "missing-leaf") await rm(f.store.pathFor(leaf.payload));
        if (scenario === "wrong-hash") await writeFile(f.store.pathFor(leaf.payload), Buffer.alloc(bytes.length, 42));
        if (scenario === "wrong-size") { leaf.size = "999"; leaf.payload.bytes = "999"; }
        if (scenario === "duplicate") value.entries.push(structuredClone(leaf));
        if (scenario === "missing-directory") value.entries = value.entries.filter((entry: SourceFileEntry) => entry.sourceRelativePath !== "deep");
        if (scenario === "file-parent") {
          const parent = value.entries.find((entry: SourceFileEntry) => entry.sourceRelativePath === "deep");
          Object.assign(parent, { ...leaf, sourceRelativePath: "deep", identity: parent.identity });
        }
        if (scenario === "invalid-mode") leaf.mode = "0999";
        if (scenario === "extra-field") value.verified = true;
        if (scenario === "wrong-source") value.source.databaseInstanceId = "f".repeat(32);
        if (scenario === "traversal") leaf.sourceRelativePath = "../outside";
        if (scenario === "absolute-relative") leaf.sourceRelativePath = "/outside";
        const reference = await f.store.putJson("source-files", value);
        await assert.rejects(restoreSourceFiles(f.store, reference, f.destination), (error: unknown) => {
          assert.ok(error instanceof SourceFilesRestoreFailure); assert.equal(error.partialTarget, null); return true;
        });
        await assert.rejects(stat(f.destination), { code: "ENOENT" });
        assert.deepEqual(await readFile(f.config), bytes);
      } finally { await f.close(); }
    });
  }
});

platformTest("#152 file restore refuses outside, reused, symbolic-link and hard-link boundaries", async t => {
  for (const scenario of ["outside", "existing-empty", "existing-content", "target-symlink", "attempt-symlink", "payload-hardlink", "payload-symlink"] as const) {
    await t.test(scenario, async () => {
      const f = await fixture();
      try {
        const outside = path.join(f.directory, "outside"); await mkdir(outside, { mode: 0o700 });
        let target = f.destination;
        if (scenario === "outside") target = path.join(outside, "files");
        if (scenario === "existing-empty" || scenario === "existing-content") await mkdir(target, { mode: 0o700 });
        if (scenario === "existing-content") await writeFile(path.join(target, "keep"), "do not replace");
        if (scenario === "target-symlink") await symlink(outside, target, "dir");
        if (scenario === "attempt-symlink") { await rename(f.attempt, `${f.attempt}-original`); await symlink(outside, f.attempt, "dir"); }
        const payload = f.manifest.entries.find((entry): entry is Extract<SourceFileEntry, {kind: "file"}> => entry.kind === "file")!.payload;
        if (scenario === "payload-hardlink") await link(f.store.pathFor(payload), path.join(outside, "alias"));
        if (scenario === "payload-symlink") {
          await rename(f.store.pathFor(payload), path.join(outside, "alias")); await symlink(path.join(outside, "alias"), f.store.pathFor(payload));
        }
        await assert.rejects(restoreSourceFiles(f.store, f.reference, target), SourceFilesRestoreFailure);
        assert.deepEqual((await readdir(outside)).sort(), scenario.startsWith("payload-") ? ["alias"] : []);
        if (scenario === "existing-content") assert.equal(await readFile(path.join(target, "keep"), "utf8"), "do not replace");
        assert.deepEqual(await readFile(f.config), bytes);
      } finally { await f.close(); }
    });
  }
});

async function fileHandlePrototype(directory: string) {
  const handle = await open(path.join(directory, "fault-control"), "w");
  const prototype = Object.getPrototypeOf(handle); await handle.close(); return prototype;
}

platformTest("#152 file restore retains a failed write's owned target and original failure", async t => {
  const f = await fixture(), failure = new Error("controlled-write-failure");
  try {
    const prototype = await fileHandlePrototype(f.directory);
    t.mock.method(prototype, "write", () => { throw failure; });
    await assert.rejects(restoreSourceFiles(f.store, f.reference, f.destination), (error: unknown) => {
      assert.ok(error instanceof SourceFilesRestoreFailure); assert.equal(error.cause, failure);
      assert.equal(error.stage, "materialize"); assert.equal(error.partialTarget?.path, f.destination); return true;
    });
    assert.ok((await stat(f.destination)).isDirectory());
    assert.deepEqual(await readFile(f.config), bytes); assert.equal((await stat(f.destination)).mode & 0o7777, 0o700);
    assert.deepEqual((await readdir(f.store.root)).sort(), ["attempts", "control-root.json", "snapshots"]);
  } finally { t.mock.restoreAll(); await f.close(); }
});

platformTest("#152 file restore cannot report success when a final owned file close fails", async t => {
  const f = await fixture(), failure = new Error("controlled-close-failure");
  try {
    const prototype = await fileHandlePrototype(f.directory), write = prototype.write;
    let instrumented = false, injected = false;
    t.mock.method(prototype, "write", function (this: {close: () => Promise<void>}, ...args: any[]) {
      if (!instrumented) {
        instrumented = true; const close = this.close;
        t.mock.method(this, "close", async () => { await close(); injected = true; throw failure; });
      }
      return write.apply(this, args);
    });
    await assert.rejects(restoreSourceFiles(f.store, f.reference, f.destination), (error: unknown) => {
      assert.ok(error instanceof SourceFilesRestoreFailure); assert.equal(error.cause, failure); assert.equal(error.stage, "close");
      assert.equal(error.partialTarget?.path, f.destination); return true;
    });
    assert.equal(injected, true); assert.ok((await stat(f.destination)).isDirectory());
  } finally { t.mock.restoreAll(); await f.close(); }
});

test("#152 file restore refuses failed file and directory fsync without a success record", { skip: process.platform !== "linux" }, async t => {
  for (const targetKind of ["file", "directory"] as const) await t.test(targetKind, async t => {
    const f = await fixture(), failure = new Error(`controlled-${targetKind}-sync-failure`);
    try {
      const prototype = await fileHandlePrototype(f.directory), sync = prototype.sync; let injected = false;
      t.mock.method(prototype, "sync", async function (this: {stat: () => Promise<any>}, ...args: any[]) {
        const info = await this.stat();
        if (!injected && (targetKind === "file" ? info.isFile() : info.isDirectory())) { injected = true; throw failure; }
        return sync.apply(this, args);
      });
      await assert.rejects(restoreSourceFiles(f.store, f.reference, f.destination), (error: unknown) => {
        assert.ok(error instanceof SourceFilesRestoreFailure); assert.equal(error.cause, failure); assert.equal(error.stage, "sync"); return true;
      });
      assert.equal(injected, true); assert.ok((await stat(f.destination)).isDirectory());
    } finally { t.mock.restoreAll(); await f.close(); }
  });
});

platformTest("#152 restored-file readback, permissions and namespace are checked from disk", async t => {
  for (const scenario of ["readback", "mode", "extra-entry", "replaced-target"] as const) await t.test(scenario, async t => {
    const f = await fixture();
    try {
      const prototype = await fileHandlePrototype(f.directory), read = prototype.read, write = prototype.write;
      let changed = false, outputIdentity: {dev: bigint; ino: bigint} | undefined;
      t.mock.method(prototype, "write", async function (this: {stat: (options: object) => Promise<any>}, ...args: any[]) {
        const value = await write.apply(this, args); outputIdentity = await this.stat({ bigint: true });
        if (!changed && scenario === "extra-entry") { changed = true; await writeFile(path.join(f.destination, "unexpected"), "unexpected"); }
        if (!changed && scenario === "replaced-target") {
          changed = true; const outside = path.join(f.directory, "untouched"); await mkdir(outside, { mode: 0o700 });
          await rename(f.destination, `${f.destination}-owned`); await symlink(outside, f.destination, "dir");
        }
        return value;
      });
      if (scenario === "readback") t.mock.method(prototype, "read", async function (this: {stat: (options: object) => Promise<any>}, ...args: any[]) {
        const value = await read.apply(this, args), info = await this.stat({ bigint: true });
        if (!changed && value.bytesRead > 0 && outputIdentity !== undefined && outputIdentity.dev === info.dev && outputIdentity.ino === info.ino) {
          changed = true; args[0][0] ^= 1;
        }
        return value;
      });
      if (scenario === "mode") t.mock.method(prototype, "chmod", async () => { changed = true; });
      await assert.rejects(restoreSourceFiles(f.store, f.reference, f.destination), SourceFilesRestoreFailure);
      assert.equal(changed, true);
      if (scenario === "replaced-target") assert.deepEqual(await readdir(path.join(f.directory, "untouched")), []);
      assert.deepEqual(await readFile(f.config), bytes);
    } finally { t.mock.restoreAll(); await f.close(); }
  });
});

platformTest("#152 a write error remains primary when owned cleanup also reports an error", async t => {
  const f = await fixture(), first = new Error("first-write"), secondary = new Error("secondary-close");
  try {
    const prototype = await fileHandlePrototype(f.directory); let injected = false;
    t.mock.method(prototype, "write", function (this: {close: () => Promise<void>}) {
      if (!injected) {
        injected = true; const close = this.close;
        t.mock.method(this, "close", async () => { await close(); throw secondary; });
      }
      throw first;
    });
    await assert.rejects(restoreSourceFiles(f.store, f.reference, f.destination), (error: unknown) => {
      assert.ok(error instanceof SourceFilesRestoreFailure); assert.equal(error.cause, first);
      assert.equal(error.stage, "materialize"); assert.deepEqual(error.closeErrors, [secondary]); return true;
    });
  } finally { t.mock.restoreAll(); await f.close(); }
});

platformTest("#152 unsupported platforms do not create a verification target", async () => {
  const f = await fixture(), platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    await assert.rejects(restoreSourceFiles(f.store, f.reference, f.destination), (error: unknown) => {
      assert.ok(error instanceof SourceFilesRestoreFailure); assert.equal(error.code, "unsupported_durability");
      assert.equal(error.partialTarget, null); return true;
    });
    await assert.rejects(stat(f.destination), { code: "ENOENT" });
  } finally { Object.defineProperty(process, "platform", platform); await f.close(); }
});

platformTest("#152 materialization bounds directory handles before creating a target", async () => {
  const f = await fixture();
  try {
    const value = structuredClone({ ...f.manifest, entries: [...f.manifest.entries] });
    const original = value.entries.find(entry => entry.kind === "directory" && entry.sourceRelativePath === "empty")!;
    for (let index = 0; index < 512; index++) value.entries.push({ ...original, sourceRelativePath: `extra-${index}`,
      identity: { ...original.identity!, path: path.join(f.sessions, `extra-${index}`) } } as SourceFileEntry);
    const reference = await f.store.putJson("source-files", value);
    await assert.rejects(restoreSourceFiles(f.store, reference, f.destination), (error: unknown) => {
      assert.ok(error instanceof SourceFilesRestoreFailure); assert.equal(error.code, "restore_verification_unavailable");
      assert.equal(error.partialTarget, null); return true;
    });
    await assert.rejects(stat(f.destination), { code: "ENOENT" });
  } finally { await f.close(); }
});

platformTest("#152 retained file handles and final witnesses share a pre-materialization budget", async () => {
  const f = await fixture();
  try {
    const value = structuredClone({ ...f.manifest, entries: [...f.manifest.entries] });
    const original = value.entries.find((entry): entry is Extract<SourceFileEntry, {kind: "file"}> => entry.kind === "file" && entry.sourceRelativePath === "zero")!;
    for (let index = 0; index < 246; index++) value.entries.push({ ...original, sourceRelativePath: `extra-${index}`,
      identity: { ...original.identity, path: path.join(f.sessions, `extra-${index}`) } });
    const reference = await f.store.putJson("source-files", value);
    await assert.rejects(restoreSourceFiles(f.store, reference, f.destination), (error: unknown) => {
      assert.ok(error instanceof SourceFilesRestoreFailure); assert.equal(error.code, "restore_verification_unavailable");
      assert.equal(error.partialTarget, null); return true;
    });
    await assert.rejects(stat(f.destination), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("#152 final directory sync cannot hide a changed target or directory membership", { skip: process.platform !== "linux" }, async t => {
  for (const scenario of ["target", "membership"] as const) await t.test(scenario, async t => {
    const f = await fixture();
    try {
      const prototype = await fileHandlePrototype(f.directory), sync = prototype.sync; let replaced = false;
      t.mock.method(prototype, "sync", async function (this: {stat: () => Promise<any>}, ...args: any[]) {
        const info = await this.stat();
        if (!replaced && info.isDirectory()) {
          replaced = true;
          if (scenario === "target") {
            const outside = path.join(f.directory, "outside"); await mkdir(outside, { mode: 0o700 });
            await rename(f.destination, `${f.destination}-original`); await symlink(outside, f.destination, "dir");
          } else await rename(path.join(f.destination, "managed-sessions", "deep"), path.join(f.destination, "managed-sessions", "renamed"));
        }
        return sync.apply(this, args);
      });
      await assert.rejects(restoreSourceFiles(f.store, f.reference, f.destination), SourceFilesRestoreFailure);
      assert.equal(replaced, true);
      if (scenario === "target") assert.deepEqual(await readdir(path.join(f.directory, "outside")), []);
    } finally { t.mock.restoreAll(); await f.close(); }
  });
});

test("#152 RF-001 final directory sync cannot return stale regular-file bytes or permissions", { skip: process.platform !== "linux" }, async t => {
  for (const scenario of ["bytes", "mode"] as const) await t.test(scenario, async t => {
    const f = await fixture();
    try {
      const prototype = await fileHandlePrototype(f.directory), sync = prototype.sync; let changed = false;
      t.mock.method(prototype, "sync", async function (this: {stat: () => Promise<any>}, ...args: any[]) {
        const info = await this.stat();
        if (!changed && info.isDirectory()) {
          changed = true;
          if (scenario === "bytes") await writeFile(path.join(f.destination, "config"), Buffer.alloc(bytes.length, 42));
          else await chmod(path.join(f.destination, "config"), 0o600);
        }
        return sync.apply(this, args);
      });
      await assert.rejects(restoreSourceFiles(f.store, f.reference, f.destination), SourceFilesRestoreFailure);
      assert.equal(changed, true); assert.ok((await stat(f.destination)).isDirectory());
      assert.deepEqual(await readFile(f.config), bytes);
    } finally { t.mock.restoreAll(); await f.close(); }
  });
});

platformTest("#152 RF-001 final directory facts still match the manifest after later chmod operations", async t => {
  const f = await fixture();
  try {
    const prototype = await fileHandlePrototype(f.directory), actualChmod = prototype.chmod; let changed = false;
    t.mock.method(prototype, "chmod", async function (this: {stat: () => Promise<any>}, ...args: any[]) {
      const result = await actualChmod.apply(this, args);
      if (!changed && args[0] === 0o750 && (await this.stat()).isDirectory()) {
        changed = true; await chmod(path.join(f.destination, "managed-sessions", "deep"), 0o600);
      }
      return result;
    });
    await assert.rejects(restoreSourceFiles(f.store, f.reference, f.destination), SourceFilesRestoreFailure);
    assert.equal(changed, true);
  } finally { t.mock.restoreAll(); await chmod(path.join(f.destination, "managed-sessions", "deep"), 0o700).catch(() => {}); await f.close(); }
});

platformTest("#152 STD-RF-001 source-open window cannot redirect payload writes through a replaced target ancestor", async t => {
  const f = await fixture();
  try {
    const outside = path.join(f.directory, "outside");
    await mkdir(path.join(outside, "managed-sessions", "deep"), { recursive: true, mode: 0o700 });
    const prototype = await fileHandlePrototype(f.directory), actualStat = prototype.stat;
    const leaf = f.manifest.entries.find((entry): entry is Extract<SourceFileEntry, {kind: "file"}> => entry.kind === "file")!;
    const leafInfo = await stat(f.store.pathFor(leaf.payload), { bigint: true }); let swapped = false;
    t.mock.method(prototype, "stat", async function (this: unknown, ...args: any[]) {
      const info = await actualStat.apply(this, args);
      if (!swapped && info.isFile() && String(info.dev) === String(leafInfo.dev) && String(info.ino) === String(leafInfo.ino)
        && await stat(f.destination).then(() => true, () => false)) {
        swapped = true; await rename(f.destination, `${f.destination}-owned`); await symlink(outside, f.destination, "dir");
      }
      return info;
    });
    await assert.rejects(restoreSourceFiles(f.store, f.reference, f.destination), SourceFilesRestoreFailure);
    assert.equal(swapped, true);
    assert.deepEqual(await readdir(path.join(outside, "managed-sessions", "deep")), []);
    assert.deepEqual(await readFile(f.config), bytes);
  } finally { t.mock.restoreAll(); await f.close(); }
});

platformTest("#152 STD-RF-002 a renamed source inode cannot be adopted as a restore ancestor", async () => {
  const f = await fixture();
  try {
    await chmod(f.sessions, 0o700);
    const manifest = { ...f.manifest,
      rootBindings: f.manifest.rootBindings.map(binding => ({ ...binding, hostIdentityDigest: f.store.identity.hostIdentityDigest })),
      entries: f.manifest.entries.map(entry => entry.sourceRoot === "managed-sessions" && entry.sourceRelativePath === ""
        ? { ...entry, mode: "0700" } : entry) };
    const reference = await f.store.putJson("source-files", manifest);
    await rename(f.attempt, `${f.attempt}-unused`); await rename(f.sessions, f.attempt);
    const before = (await readdir(f.attempt)).sort();
    await assert.rejects(restoreSourceFiles(f.store, reference, f.destination), (error: unknown) => {
      assert.ok(error instanceof SourceFilesRestoreFailure); assert.equal(error.partialTarget, null); return true;
    });
    assert.deepEqual((await readdir(f.attempt)).sort(), before);
  } finally { await f.close(); }
});

platformTest("#152 RF-001 final async read and close cannot leave stale directory or absence facts", async t => {
  for (const phase of ["read", "close"] as const) for (const changed of ["directory-mode", "absent"] as const) {
    await t.test(`${phase}/${changed}`, async t => {
      const f = await fixture(changed === "absent");
      try {
        const prototype = await fileHandlePrototype(f.directory), actualRead = prototype.read;
        const counts = new Map<object, number>(); let installed = false, injected = false;
        const mutate = async () => {
          injected = true;
          if (changed === "absent") await writeFile(path.join(f.destination, "config"), "late-unexpected", { mode: 0o600 });
          else await chmod(path.join(f.destination, "managed-sessions", "deep"), 0o600);
        };
        t.mock.method(prototype, "read", async function (this: {close(): Promise<void>}, ...args: any[]) {
          const result = await actualRead.apply(this, args);
          if (args[3] === 0n) {
            const count = (counts.get(this) ?? 0) + 1; counts.set(this, count);
            if (!installed && count === 2) {
              installed = true;
              if (phase === "read") await mutate();
              else {
                const actualClose = this.close.bind(this);
                t.mock.method(this, "close", async () => { await actualClose(); await mutate(); });
              }
            }
          }
          return result;
        });
        await assert.rejects(restoreSourceFiles(f.store, f.reference, f.destination), SourceFilesRestoreFailure);
        assert.equal(injected, true);
      } finally {
        t.mock.restoreAll(); await chmod(path.join(f.destination, "managed-sessions", "deep"), 0o700).catch(() => {}); await f.close();
      }
    });
  }
});

platformTest("#152 STD-RF-003 protected descendant identities cannot become writable attempts", async () => {
  const f = await fixture();
  try {
    const actualIdentity = async (file: string) => { const info = await stat(file, { bigint: true });
      return { path: file, device: String(info.dev), inode: String(info.ino) }; };
    await assertRestoreArtifactSeparation(f.store, [await actualIdentity(f.attempt)]);
    // These are real protected inodes. The guard consumes the same inode facts
    // that a pre-existing bind alias exposes, without requiring mount privileges.
    const payloadDirectory = path.dirname(f.store.pathFor(f.reference));
    const nested = path.join(f.store.root, "journals", "protected", "nested");
    await mkdir(nested, { recursive: true, mode: 0o700 });
    for (const directory of [payloadDirectory, nested])
      await assert.rejects(assertRestoreArtifactSeparation(f.store, [await actualIdentity(directory)]), { code: "snapshot_invalid" });
    await assert.rejects(stat(f.destination), { code: "ENOENT" });
  } finally { await f.close(); }
});

platformTest("#152 incomplete protected directory inspection cannot create a restore target", async t => {
  for (const scenario of ["symlink", "permissions", "depth"] as const) await t.test(scenario, async () => {
    const f = await fixture();
    try {
      const protectedRoot = path.join(f.store.root, "journals"); await mkdir(protectedRoot, { mode: 0o700 });
      if (scenario === "symlink") await symlink(f.original, path.join(protectedRoot, "unresolved"), "dir");
      if (scenario === "permissions") await chmod(protectedRoot, 0o500);
      if (scenario === "depth") await mkdir(path.join(protectedRoot, ...Array.from({ length: 65 }, () => "d")), { recursive: true, mode: 0o700 });
      await assert.rejects(restoreSourceFiles(f.store, f.reference, f.destination), (error: unknown) => {
        assert.ok(error instanceof SourceFilesRestoreFailure); assert.equal(error.partialTarget, null); return true;
      });
      await assert.rejects(stat(f.destination), { code: "ENOENT" });
    } finally { await chmod(path.join(f.store.root, "journals"), 0o700).catch(() => {}); await f.close(); }
  });
});

platformTest("#152 final witness close errors reject success and preserve an earlier write error", async t => {
  for (const primary of [false, true]) await t.test(primary ? "write-then-close" : "close-only", async t => {
    const f = await fixture(), writeFailure = new Error("controlled-primary-write"), closeFailure = new Error("controlled-witness-close");
    const rawOpen = fs.openSync, rawClose = fs.closeSync, owned = new Set<number>(); let injected = false;
    try {
      t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
        const fd = rawOpen(...args);
        if (/^\/(proc\/self\/fd|dev\/fd)\/[0-9]+$/.test(String(args[0]))) owned.add(fd);
        return fd;
      });
      t.mock.method(fs, "closeSync", (fd: number) => {
        const witness = owned.delete(fd); rawClose(fd);
        if (witness && !injected) { injected = true; throw closeFailure; }
      });
      syncBuiltinESMExports();
      if (primary) t.mock.method(await fileHandlePrototype(f.directory), "write", () => { throw writeFailure; });
      await assert.rejects(restoreSourceFiles(f.store, f.reference, f.destination), (error: unknown) => {
        assert.ok(error instanceof SourceFilesRestoreFailure);
        assert.equal(error.cause, primary ? writeFailure : closeFailure);
        assert.equal(error.stage, primary ? "materialize" : "close");
        assert.deepEqual(error.closeErrors, [closeFailure]); return true;
      });
      assert.equal(injected, true); assert.equal(owned.size, 0);
      assert.deepEqual(await readFile(f.config), bytes);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); for (const fd of owned) rawClose(fd); await f.close(); }
  });
});

platformTest("#152 protected inventory close failures retain the first enumeration error", async t => {
  for (const primary of [false, true]) await t.test(primary ? "read-then-close" : "close-only", async t => {
    const f = await fixture(), readFailure = new Error("controlled-inventory-read"), closeFailure = new Error("controlled-inventory-close");
    try {
      const stream = await opendir(f.store.root), prototype = Object.getPrototypeOf(stream), close = prototype.close;
      await stream.close(); let injected = false;
      if (primary) t.mock.method(prototype, "read", async () => { throw readFailure; });
      t.mock.method(prototype, "close", function (this: unknown, callback?: (error: unknown) => void) {
        // Dir builds a promisified method at construction. Keep the callback
        // form intact, and invoke the original callback form without recursion.
        if (callback) return close.call(this, (error: unknown) => { injected = true; callback(error ?? closeFailure); });
        return new Promise((_, reject) => close.call(this, (error: unknown) => { injected = true; reject(error ?? closeFailure); }));
      });
      await assert.rejects(restoreSourceFiles(f.store, f.reference, f.destination), (error: unknown) => {
        assert.ok(error instanceof SourceFilesRestoreFailure); assert.equal(error.cause, primary ? readFailure : closeFailure);
        assert.equal(error.stage, primary ? "target" : "close"); assert.equal(error.partialTarget, null);
        assert.deepEqual(error.closeErrors, [closeFailure]); return true;
      });
      assert.equal(injected, true); await assert.rejects(stat(f.destination), { code: "ENOENT" });
    } finally { t.mock.restoreAll(); await f.close(); }
  });
});

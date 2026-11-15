import { constants, closeSync, fstatSync, lstatSync, openSync, realpathSync, type BigIntStats } from "node:fs";
import { lstat, open, opendir, readdir, realpath, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { MaintenanceFailure } from "./error.ts";
import { verifySourceFilesClosure } from "./journal.ts";
import { ArtifactStore } from "./objects.ts";
import { readSourceFiles } from "./parse.ts";
import { assertMaintenancePlatform, syncMaintenanceHandle } from "./platform.ts";
import { assertRestoreDirectoryAvailable, restoreDirectory, RestoreDirectoryFailure, type RestoreDirectory } from "./restore-directory.ts";
import type { ArtifactRef, PathIdentity, SourceFileEntry, SourceFilesManifest } from "./types.ts";

type Stage = "input" | "target" | "materialize" | "verify" | "permissions" | "sync" | "close";
interface ObservedEntry {
  readonly sourceRoot: string;
  readonly relativePath: string;
  readonly kind: SourceFileEntry["kind"];
  readonly identity: PathIdentity | null;
  readonly mode: string | null;
  /** Only file sizes are portable content facts; directory st_size is not. */
  readonly bytes: string | null;
  readonly sha256: string | null;
}
export interface RestoredSourceFiles {
  readonly kind: "isolated-source-files-restore";
  readonly sourceFilesManifest: ArtifactRef;
  readonly target: PathIdentity;
  readonly entries: readonly ObservedEntry[];
}

/** Internal evidence only. The message does not expose paths or source bytes. */
export class SourceFilesRestoreFailure extends MaintenanceFailure {
  readonly stage: Stage;
  readonly partialTarget: { readonly path: string; readonly identity: PathIdentity | null } | null;
  override readonly cause: unknown;
  readonly closeErrors: readonly unknown[];
  constructor(cause: unknown, stage: Stage, partialTarget: SourceFilesRestoreFailure["partialTarget"], closeErrors: readonly unknown[]) {
    super(cause instanceof MaintenanceFailure ? cause.code : "restore_verification_unavailable", `file-restore-${stage}`);
    this.stage = stage; this.partialTarget = partialTarget; this.cause = cause; this.closeErrors = closeErrors;
  }
}

interface HeldDirectory {
  readonly file: string; readonly identity: PathIdentity; readonly handle: FileHandle;
  readonly access: RestoreDirectory; readonly witness: number | undefined;
}
interface HeldFile {
  readonly entry: Extract<SourceFileEntry, {kind: "file"}>;
  readonly identity: PathIdentity;
  readonly handle: FileHandle;
  readonly witness: number;
  facts: BigIntStats;
}
const identity = (file: string, info: BigIntStats): PathIdentity => ({ path: file, device: String(info.dev), inode: String(info.ino) });
const sameIdentity = (a: PathIdentity, b: PathIdentity) => a.path === b.path && a.device === b.device && a.inode === b.inode;
const modeOf = (info: BigIntStats) => (info.mode & 0o7777n).toString(8).padStart(4, "0");
const modeNumber = (mode: string) => Number.parseInt(mode, 8);
const invalid = (): never => { throw new MaintenanceFailure("snapshot_invalid"); };
const isOwned = (info: BigIntStats) => process.getuid !== undefined && info.uid === BigInt(process.getuid());
const factFields = ["dev", "ino", "mode", "uid", "nlink", "size", "mtimeNs", "ctimeNs"] as const;
const sameFacts = (a: BigIntStats, b: BigIntStats) => factFields.every(field => a[field] === b[field]);
const key = (entry: SourceFileEntry) => `${entry.sourceRoot}/${entry.sourceRelativePath}`;
const relative = (entry: SourceFileEntry) => path.join(entry.sourceRoot, entry.sourceRelativePath);
// Local execution budgets, not new Fs codec or provider eligibility rules.
const MAX_MANIFEST_BYTES = 16n * 1024n * 1024n;
const MAX_ENTRIES = 4096, MAX_DIRECTORIES = 256, MAX_TARGET_HANDLES = 512;
const MAX_PROTECTED_ENTRIES = 16384, MAX_PROTECTED_DEPTH = 64;

/** Read-only internal guard; successful inspection grants no source or restore authority. */
export async function assertRestoreArtifactSeparation(store: ArtifactStore, targets: readonly PathIdentity[]): Promise<void> {
  const forbidden = new Set(targets.map(item => `${item.device}:${item.inode}`));
  const visited = new Set<string>(), checked = new Map<string, BigIntStats>();
  const pending: { file: string; depth: number; expected: BigIntStats }[] = [];
  let count = 0;
  const directory = (info: BigIntStats) => {
    const id = `${info.dev}:${info.ino}`;
    if (!info.isDirectory() || !isOwned(info) || (info.mode & 0o7777n) !== 0o700n || forbidden.has(id) || visited.has(id)) invalid();
    visited.add(id);
  };
  for (const name of ["plans", "journals", "snapshots"]) {
    const file = path.join(store.root, name);
    let info: BigIntStats;
    try { info = await lstat(file, { bigint: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    directory(info); pending.push({ file, depth: 0, expected: info });
  }
  // Inspect the entire protected directory domain, not only the three top-level
  // names. A pre-existing bind alias retains the protected descendant's dev/ino.
  for (let index = 0; index < pending.length; index++) {
    const { file, depth, expected } = pending[index]!;
    const before = await lstat(file, { bigint: true });
    if (!sameFacts(before, expected) || await realpath(file) !== file) invalid();
    const stream = await opendir(file, { bufferSize: 32 });
    let failed = false, firstError: unknown;
    try {
      for (;;) {
        const entry = await stream.read(); if (entry === null) break;
        if (++count > MAX_PROTECTED_ENTRIES) throw new MaintenanceFailure("restore_verification_unavailable", "file-restore-artifact-budget");
        const child = path.join(file, entry.name), info = await lstat(child, { bigint: true });
        if (info.isDirectory()) {
          if (depth >= MAX_PROTECTED_DEPTH) throw new MaintenanceFailure("restore_verification_unavailable", "file-restore-artifact-budget");
          directory(info); pending.push({ file: child, depth: depth + 1, expected: info });
        } else if (!info.isFile() || !isOwned(info) || info.nlink !== 1n || (info.mode & 0o7777n) !== 0o600n) invalid();
      }
      if (!sameFacts(before, await lstat(file, { bigint: true }))) invalid();
      checked.set(file, before);
    } catch (error) { failed = true; firstError = error; }
    try { await stream.close(); }
    catch (error) { throw new RestoreDirectoryFailure(failed ? firstError : error, [error], !failed); }
    if (failed) throw firstError;
  }
  // An earlier directory must not have changed while its descendants were read.
  for (const [file, before] of checked) if (!sameFacts(before, await lstat(file, { bigint: true }))) invalid();
  await store.assertRoot();
}

function completeTopology(manifest: SourceFilesManifest): void {
  const entries = new Map(manifest.entries.map(entry => [key(entry), entry]));
  for (const entry of manifest.entries) {
    // The strict codec fixes each root; materialization also needs every intermediate directory.
    let parent = path.posix.dirname(entry.sourceRelativePath);
    while (entry.sourceRelativePath !== "" && parent !== ".") {
      if (entries.get(`${entry.sourceRoot}/${parent}`)?.kind !== "directory") invalid();
      parent = path.posix.dirname(parent);
    }
    if (entry.sourceRelativePath !== "" && entries.get(`${entry.sourceRoot}/`)?.kind !== "directory") invalid();
  }
}

async function readDigest(handle: FileHandle, expectedBytes: bigint): Promise<{ bytes: string; sha256: string }> {
  const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024); let count = 0n;
  for (;;) {
    // Positional reads allow a retained read-only FD to be checked again after mode 000.
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, count);
    if (bytesRead === 0) break;
    count += BigInt(bytesRead); if (count > expectedBytes) invalid(); hash.update(buffer.subarray(0, bytesRead));
  }
  return { bytes: String(count), sha256: hash.digest("hex") };
}

/**
 * Restore an exact persisted Fs payload closure into a new private verification directory.
 * This does not observe the live source, qualify a provider, create V/R/Jr or grant DB access.
 * The destination must be a new direct child of one existing ArtifactStore attempt.
 * Failures retain the owned incomplete destination; this function never deletes or reuses it.
 */
export async function restoreSourceFiles(store: ArtifactStore, reference: ArtifactRef, destination: string): Promise<RestoredSourceFiles> {
  let stage: Stage = "input", partialTarget: SourceFilesRestoreFailure["partialTarget"] = null;
  let result: RestoredSourceFiles | undefined, failed = false, firstError: unknown, failureStage: Stage | undefined;
  const handles = new Set<FileHandle>(), witnesses = new Set<number>(), closeErrors: unknown[] = [];
  let finalize: (() => RestoredSourceFiles) | undefined;
  const own = (handle: FileHandle) => { handles.add(handle); return handle; };
  const close = async (handle: FileHandle) => {
    const previous = stage; stage = "close";
    handles.delete(handle); await handle.close(); stage = previous;
  };
  const witness = (handle: FileHandle, expected: BigIntStats): number => {
    // Acquire before chmod, including mode 000. These are terminal descriptors,
    // never a directory path through which a target child could be redirected.
    const fd = openSync(`${process.platform === "linux" ? "/proc/self/fd" : "/dev/fd"}/${handle.fd}`,
      constants.O_RDONLY | (process.platform === "darwin" ? constants.O_NOFOLLOW : 0));
    witnesses.add(fd);
    if (!sameFacts(expected, fstatSync(fd, { bigint: true }))) invalid();
    return fd;
  };
  try {
    assertMaintenancePlatform(); assertRestoreDirectoryAvailable();
    if (store.kindFor(reference) !== "source-files") invalid();
    if (BigInt(reference.bytes) > MAX_MANIFEST_BYTES) throw new MaintenanceFailure("restore_verification_unavailable", "file-restore-budget");
    const fixedReference = { ref: reference.ref, sha256: reference.sha256, bytes: reference.bytes };
    const manifest = await readSourceFiles(store, fixedReference);
    if (manifest.entries.length > MAX_ENTRIES || manifest.entries.filter(entry => entry.kind === "directory").length > MAX_DIRECTORIES
      // Two retained descriptors per target, plus target root, three anchors,
      // and the bounded transient source/output/native acquisition descriptors.
      || 2 * manifest.entries.filter(entry => entry.kind !== "absent").length + 10 > MAX_TARGET_HANDLES)
      throw new MaintenanceFailure("restore_verification_unavailable", "file-restore-budget");
    // Re-open the real marker to bind this Fs source to this store, not a caller assertion.
    await ArtifactStore.open(store.root, manifest.source);
    completeTopology(manifest);
    await verifySourceFilesClosure(store, manifest);

    // A pathname may have moved since capture. Only identities from this host are
    // comparable; fixed source roots, absent-root anchors and entries stay read-only.
    const localRoots = new Set<string>(manifest.rootBindings.filter(binding => binding.hostIdentityDigest === store.identity.hostIdentityDigest)
      .map(binding => binding.sourceRoot));
    const sourceIdentities = new Set<string>();
    for (const root of manifest.roots) if (localRoots.has(root.label))
      sourceIdentities.add(`${root.expected.existingAncestor.device}:${root.expected.existingAncestor.inode}`);
    for (const entry of manifest.entries) if (entry.identity && localRoots.has(entry.sourceRoot))
      sourceIdentities.add(`${entry.identity.device}:${entry.identity.inode}`);
    const assertNotSource = (info: BigIntStats) => { if (sourceIdentities.has(`${info.dev}:${info.ino}`)) invalid(); };

    stage = "target";
    const attempts = path.join(store.root, "attempts"), parent = path.dirname(destination);
    if (!path.isAbsolute(destination) || destination !== path.resolve(destination) || destination.includes("\0")
      || path.dirname(parent) !== attempts
      || !/^(0|[1-9][0-9]*)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(path.basename(parent))) invalid();
    const ancestors: HeldDirectory[] = [], directories: HeldDirectory[] = [];
    const openDirectory = async (file: string, opened?: FileHandle, retainWitness = false): Promise<HeldDirectory> => {
      const handle = own(opened ?? await open(file, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
      const info = await handle.stat({ bigint: true });
      assertNotSource(info);
      if (!info.isDirectory() || !isOwned(info) || (info.mode & 0o7777n) !== 0o700n
        || await realpath(file) !== file || !sameIdentity(identity(file, info), identity(file, await lstat(file, { bigint: true })))) invalid();
      if ([...ancestors, ...directories].some(existing => existing.identity.device === String(info.dev) && existing.identity.inode === String(info.ino))) invalid();
      return { file, identity: identity(file, info), handle, access: restoreDirectory(handle, info),
        witness: retainWitness ? witness(handle, info) : undefined };
    };
    const root = await openDirectory(store.root);
    if (!sameIdentity(root.identity, store.identity)) invalid();
    ancestors.push(root);
    const attemptRoot = await openDirectory(attempts, await root.access.directory("attempts")); ancestors.push(attemptRoot);
    const attempt = await openDirectory(parent, await attemptRoot.access.directory(path.basename(parent))); ancestors.push(attempt);
    await assertRestoreArtifactSeparation(store, [attemptRoot.identity, attempt.identity]);
    const assertBoundaries = async () => {
      await store.assertRoot();
      for (const directory of [...ancestors, ...directories]) {
        const info = await lstat(directory.file, { bigint: true }), opened = await directory.handle.stat({ bigint: true });
        if (!info.isDirectory() || !isOwned(info) || (info.mode & 0o7777n) !== 0o700n || await realpath(directory.file) !== directory.file
          || !sameIdentity(directory.identity, identity(directory.file, info))
          || !sameIdentity(directory.identity, identity(directory.file, opened))) invalid();
      }
    };
    await assertBoundaries();
    // mkdir is exclusive even for an existing empty directory. No old target is adopted.
    await attempt.access.mkdir(path.basename(destination), () => { partialTarget = { path: destination, identity: null }; });
    const target = await openDirectory(destination, await attempt.access.directory(path.basename(destination)), true);
    directories.push(target); partialTarget = { path: destination, identity: target.identity };

    stage = "materialize";
    const created = new Map<string, PathIdentity>(), observations = new Map<string, ObservedEntry>(), files: HeldFile[] = [];
    const orderedDirectories = manifest.entries.filter(entry => entry.kind === "directory")
      .sort((a, b) => relative(a).split(path.sep).length - relative(b).split(path.sep).length);
    for (const entry of orderedDirectories) {
      await assertBoundaries();
      const file = path.join(destination, relative(entry)), parentDirectory = directories.find(item => item.file === path.dirname(file))!;
      await parentDirectory.access.mkdir(path.basename(file), () => {});
      const directory = await openDirectory(file, await parentDirectory.access.directory(path.basename(file)), true);
      directories.push(directory); created.set(key(entry), directory.identity);
    }
    for (const entry of manifest.entries) {
      if (entry.kind !== "file") continue;
      await assertBoundaries();
      const file = path.join(destination, relative(entry)), parentDirectory = directories.find(item => item.file === path.dirname(file))!;
      const source = own(await open(store.pathFor(entry.payload), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
      const before = await source.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o7777n) !== 0o600n || String(before.size) !== entry.size) invalid();
      const output = own(await parentDirectory.access.create(path.basename(file)));
      const outputInfo = await output.stat({ bigint: true }), outputIdentity = identity(file, outputInfo);
      if (!outputInfo.isFile() || outputInfo.nlink !== 1n || !isOwned(outputInfo)
        || outputInfo.dev === before.dev && outputInfo.ino === before.ino) invalid();
      created.set(key(entry), outputIdentity);
      const buffer = Buffer.alloc(64 * 1024), hash = createHash("sha256"); let size = 0n;
      for (;;) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        size += BigInt(bytesRead); if (size > BigInt(entry.size)) invalid(); hash.update(buffer.subarray(0, bytesRead));
        let offset = 0;
        while (offset < bytesRead) {
          const written = await output.write(buffer, offset, bytesRead - offset, null);
          if (written.bytesWritten <= 0 || written.bytesWritten > bytesRead - offset) invalid();
          offset += written.bytesWritten;
        }
      }
      const after = await source.stat({ bigint: true });
      if (String(size) !== entry.size || hash.digest("hex") !== entry.payload.sha256 || before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) invalid();
      await close(source);
      stage = "sync"; await syncMaintenanceHandle(output);
      stage = "verify";
      await assertBoundaries();
      const reader = own(await parentDirectory.access.read(path.basename(file)));
      const readInfo = await reader.stat({ bigint: true });
      if (!readInfo.isFile() || readInfo.nlink !== 1n || !sameIdentity(outputIdentity, identity(file, readInfo))) invalid();
      const retained = witness(reader, readInfo);
      const observed = await readDigest(reader, BigInt(entry.size));
      if (observed.bytes !== entry.size || observed.sha256 !== entry.payload.sha256) invalid();
      stage = "permissions"; await output.chmod(modeNumber(entry.mode));
      stage = "sync"; await syncMaintenanceHandle(output);
      const finalInfo = await output.stat({ bigint: true });
      if (!finalInfo.isFile() || finalInfo.nlink !== 1n || !sameIdentity(outputIdentity, identity(file, finalInfo))
        || Number(finalInfo.mode & 0o7777n) !== modeNumber(entry.mode) || String(finalInfo.size) !== entry.size) invalid();
      await close(output);
      files.push({ entry, identity: outputIdentity, handle: reader, witness: retained, facts: finalInfo });
      observations.set(key(entry), { sourceRoot: entry.sourceRoot, relativePath: entry.sourceRelativePath, kind: "file",
        identity: outputIdentity, mode: modeOf(finalInfo), bytes: observed.bytes, sha256: observed.sha256 });
      stage = "materialize";
    }

    stage = "verify";
    await assertBoundaries();
    const expectedNames = new Map(directories.map(directory => [directory.file, new Set<string>()]));
    for (const entry of manifest.entries) {
      const file = path.join(destination, relative(entry));
      if (entry.kind === "absent") {
        try { await lstat(file); invalid(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        observations.set(key(entry), { sourceRoot: entry.sourceRoot, relativePath: entry.sourceRelativePath,
          kind: "absent", identity: null, mode: null, bytes: null, sha256: null });
      } else {
        expectedNames.get(path.dirname(file))!.add(path.basename(file));
        const info = await lstat(file, { bigint: true });
        if ((entry.kind === "file" ? !info.isFile() || info.nlink !== 1n : !info.isDirectory())
          || !sameIdentity(created.get(key(entry))!, identity(file, info))) invalid();
      }
    }
    const membershipFacts = new Map<HeldDirectory, BigIntStats>();
    for (const directory of directories) {
      const before = await directory.handle.stat({ bigint: true });
      const names = await readdir(directory.file), expected = expectedNames.get(directory.file)!;
      if (names.length !== expected.size || names.some(name => !expected.has(name))) invalid();
      const after = await directory.handle.stat({ bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.nlink !== after.nlink || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) invalid();
      membershipFacts.set(directory, after);
    }
    // Recheck persisted artifacts; source filesystem paths are never opened or altered.
    await store.verifyFile(fixedReference);
    await verifySourceFilesClosure(store, manifest);

    stage = "permissions";
    const finalDirectoryFacts = new Map<HeldDirectory, BigIntStats>([[target, membershipFacts.get(target)!]]);
    // Keep directory FDs until closure: even mode 000 is verifiable without reopening it.
    for (const entry of [...orderedDirectories].reverse()) {
      const file = path.join(destination, relative(entry)), directory = directories.find(item => item.file === file)!;
      await directory.handle.chmod(modeNumber(entry.mode!));
      const info = await directory.handle.stat({ bigint: true });
      const membership = membershipFacts.get(directory)!;
      if (!info.isDirectory() || !sameIdentity(directory.identity, identity(file, info))
        || Number(info.mode & 0o7777n) !== modeNumber(entry.mode!) || info.nlink !== membership.nlink
        || info.size !== membership.size || info.mtimeNs !== membership.mtimeNs) invalid();
      finalDirectoryFacts.set(directory, info);
      observations.set(key(entry), { sourceRoot: entry.sourceRoot, relativePath: entry.sourceRelativePath, kind: "directory",
        identity: directory.identity, mode: modeOf(info), bytes: null, sha256: null });
    }
    stage = "sync";
    for (const directory of [...directories].reverse()) await syncMaintenanceHandle(directory.handle);
    for (const directory of [...ancestors].reverse()) await syncMaintenanceHandle(directory.handle);
    await store.assertRoot();
    // Revalidate the fixed private anchors after the last sync await. Restricted payload
    // directories are checked through their retained FDs, without reopening mode-000 paths.
    for (const directory of [...ancestors, target]) {
      const info = await lstat(directory.file, { bigint: true });
      if (!info.isDirectory() || !isOwned(info) || (info.mode & 0o7777n) !== 0o700n
        || await realpath(directory.file) !== directory.file || !sameIdentity(directory.identity, identity(directory.file, info))) invalid();
    }
    for (const directory of directories) {
      const before = finalDirectoryFacts.get(directory)!, after = await directory.handle.stat({ bigint: true });
      const entry = orderedDirectories.find(item => path.join(destination, relative(item)) === directory.file);
      if (!after.isDirectory() || !sameIdentity(directory.identity, identity(directory.file, after))
        || !isOwned(after) || Number(after.mode & 0o7777n) !== (entry ? modeNumber(entry.mode!) : 0o700)
        || before.mode !== after.mode || before.uid !== after.uid || before.nlink !== after.nlink || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) invalid();
      if (entry) observations.set(key(entry), { sourceRoot: entry.sourceRoot, relativePath: entry.sourceRelativePath, kind: "directory",
        identity: directory.identity, mode: modeOf(after), bytes: null, sha256: null });
    }
    stage = "verify";
    for (const file of files) {
      const before = await file.handle.stat({ bigint: true }), expected = file.facts;
      if (!before.isFile() || before.nlink !== 1n || !sameIdentity(file.identity, identity(file.identity.path, before))
        || before.mode !== expected.mode || before.uid !== expected.uid || before.size !== expected.size
        || before.mtimeNs !== expected.mtimeNs || before.ctimeNs !== expected.ctimeNs) invalid();
      const observed = await readDigest(file.handle, BigInt(file.entry.size)), after = await file.handle.stat({ bigint: true });
      if (observed.bytes !== file.entry.size || observed.sha256 !== file.entry.payload.sha256
        || !after.isFile() || after.nlink !== 1n || !sameIdentity(file.identity, identity(file.identity.path, after))
        || after.mode !== before.mode || after.uid !== before.uid || after.size !== before.size
        || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) invalid();
      file.facts = after;
      observations.set(key(file.entry), { sourceRoot: file.entry.sourceRoot, relativePath: file.entry.sourceRelativePath, kind: "file",
        identity: file.identity, mode: modeOf(after), bytes: observed.bytes, sha256: observed.sha256 });
    }
    finalize = () => {
      // All asynchronous reads, syncs and closes finish before this bounded,
      // synchronous final fact boundary. No pending owned callback may then
      // invalidate an earlier directory/absence observation before success.
      for (const directory of [...ancestors, target]) {
        const info = lstatSync(directory.file, { bigint: true });
        if (!info.isDirectory() || !isOwned(info) || (info.mode & 0o7777n) !== 0o700n
          || realpathSync(directory.file) !== directory.file || !sameIdentity(directory.identity, identity(directory.file, info))) invalid();
      }
      for (const directory of directories) {
        const info = fstatSync(directory.witness!, { bigint: true }), expected = finalDirectoryFacts.get(directory)!;
        const entry = orderedDirectories.find(item => path.join(destination, relative(item)) === directory.file);
        if (!info.isDirectory() || !isOwned(info) || !sameFacts(info, expected)
          || Number(info.mode & 0o7777n) !== (entry ? modeNumber(entry.mode!) : 0o700)) invalid();
      }
      for (const file of files) {
        const info = fstatSync(file.witness, { bigint: true });
        if (!info.isFile() || info.nlink !== 1n || !isOwned(info) || !sameFacts(info, file.facts)
          || Number(info.mode & 0o7777n) !== modeNumber(file.entry.mode) || String(info.size) !== file.entry.size) invalid();
      }
      for (const entry of manifest.entries) if (entry.kind === "absent") {
        try { lstatSync(path.join(destination, relative(entry))); invalid(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      return { kind: "isolated-source-files-restore", sourceFilesManifest: fixedReference, target: target.identity,
        entries: manifest.entries.map(entry => observations.get(key(entry))!) };
    };
  } catch (error) {
    failed = true;
    if (error instanceof RestoreDirectoryFailure) {
      firstError = error.cause; closeErrors.push(...error.closeErrors); failureStage = error.closing ? "close" : stage;
    } else { firstError = error; failureStage = stage; }
  }
  finally {
    for (const handle of [...handles].reverse()) {
      try { await close(handle); }
      catch (error) { closeErrors.push(error); if (!failed) { failed = true; firstError = error; failureStage = "close"; } }
    }
    if (!failed) {
      stage = "verify";
      try { result = finalize!(); }
      catch (error) { failed = true; firstError = error; failureStage = stage; }
    }
    // No await after the final fact check. A raw close failure is still a failure,
    // and cleanup never retries a descriptor whose numeric FD may be reused.
    for (const fd of [...witnesses].reverse()) {
      witnesses.delete(fd);
      try { closeSync(fd); }
      catch (error) { closeErrors.push(error); if (!failed) { failed = true; firstError = error; failureStage = "close"; } }
    }
  }
  if (failed) throw new SourceFilesRestoreFailure(firstError, failureStage!, partialTarget, closeErrors);
  return result!;
}

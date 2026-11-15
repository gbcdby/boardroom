import { constants, createReadStream, fstatSync } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { canonicalJson, parseCanonical, sha256 } from "./canonical.ts";
import { MaintenanceFailure } from "./error.ts";
import { maintenanceHostIdentityDigest } from "./host.ts";
import { assertMaintenancePlatform, maintenanceFilesystem, syncMaintenanceHandle } from "./platform.ts";
import type { ArtifactRef, ControlRootIdentity, DurabilityCapability, ObjectKind, PathIdentity, SourceRef } from "./types.ts";

type PublishPoint = "temp_written" | "file_synced" | "renamed" | "directory_synced";
interface StoreOptions { readonly assertCurrent?: () => Promise<void>; readonly after?: (point: PublishPoint) => void | Promise<void> }
interface RootMarker {
  readonly formatVersion: 1;
  readonly kind: "maintenance-control-root";
  readonly source: SourceRef;
  readonly host: string;
  readonly root: ControlRootIdentity;
  readonly ancestors: readonly PathIdentity[];
}
const DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[a-zA-Z0-9_-]{1,100}$/;
const RAW = new Set<ObjectKind>(["source-file-payload", "database-snapshot"]);
const KINDS = new Set<ObjectKind>(["plan", "journal", "source-files", "source-file-payload", "database-snapshot", "database-manifests", "capability", "restore-bundle", "publication", "verification", "receipt"]);
const uid = () => process.getuid?.();
const id = (file: string, value: { dev: bigint; ino: bigint }): PathIdentity => ({ path: file, device: String(value.dev), inode: String(value.ino) });

interface PublicationOutcome {
  invocation: number; artifact: ArtifactRef | null; failureObserved: boolean; closeFailureObserved: boolean;
  cleanupFailureObserved: boolean; handleOpened: boolean; handleClosed: boolean; operationFinished: boolean;
}
interface PublicationOwner { handle: FileHandle; fd: number; identity?: string; outcome: PublicationOutcome }
interface PublicationState {
  epoch: string; next: number; discarded: number; records: PublicationOutcome[];
  active: Set<number>; owners: Map<FileHandle, PublicationOwner>; cleanup: Promise<void> | undefined;
}
const publicationLimits = Object.freeze({ roots: 64, records: 32 } as const);
// A guarded store can become unreachable when its caller fails. Pending owners
// therefore belong to an actually validated root identity, not a transient wrapper.
// Idle history may be evicted; active or uncertain owners are never evicted.
const publications = new Map<string, PublicationState>();
function publicationState(key: string): PublicationState {
  const known = publications.get(key); if (known) return known;
  if (publications.size >= publicationLimits.roots) {
    const idle = [...publications].find(([, state]) => !state.active.size && !state.owners.size && !state.cleanup);
    if (!idle) throw new MaintenanceFailure("snapshot_invalid", "publication-owner-budget");
    publications.delete(idle[0]);
  }
  const state: PublicationState = { epoch: randomUUID(), next: 0, discarded: 0, records: [], active: new Set(), owners: new Map(), cleanup: undefined };
  publications.set(key, state); return state;
}
function assertNoPendingPublication(state: PublicationState): void {
  if (state.cleanup || [...state.owners.values()].some(owner => !state.active.has(owner.outcome.invocation)))
    throw new MaintenanceFailure("snapshot_invalid", "publication-cleanup-required");
}
function beginPublication(state: PublicationState, artifact: ArtifactRef | null): PublicationOutcome {
  assertNoPendingPublication(state);
  if (state.next === Number.MAX_SAFE_INTEGER) throw new MaintenanceFailure("snapshot_invalid", "publication-sequence-budget");
  if (state.records.length === publicationLimits.records) {
    const index = state.records.findIndex(record => !state.active.has(record.invocation)
      && ![...state.owners.values()].some(owner => owner.outcome === record));
    if (index < 0) throw new MaintenanceFailure("snapshot_invalid", "publication-owner-budget");
    state.records.splice(index, 1); state.discarded++;
  }
  const record: PublicationOutcome = { invocation: ++state.next, artifact: artifact ? { ...artifact } : null, failureObserved: false,
    closeFailureObserved: false, cleanupFailureObserved: false, handleOpened: false, handleClosed: false, operationFinished: false };
  state.records.push(record); state.active.add(record.invocation); return record;
}
async function closePublicationOwner(state: PublicationState, owner: PublicationOwner): Promise<void> {
  const retire = () => { state.owners.delete(owner.handle); owner.outcome.handleClosed = true; };
  const observedClosed = () => {
    if (owner.handle.fd !== -1) return false;
    try { const info = fstatSync(owner.fd, { bigint: true }); return owner.identity !== undefined && `${info.dev}:${info.ino}` !== owner.identity; }
    catch (error) { return (error as NodeJS.ErrnoException)?.code === "EBADF"; }
  };
  if (owner.handle.fd === -1) {
    if (observedClosed()) { retire(); return; }
    // A retired FileHandle plus an ambiguous reused fd is not close evidence.
    // Never close a replacement descriptor by its numeric value.
    throw new MaintenanceFailure("snapshot_invalid", "publication-close-unknown");
  }
  try {
    await owner.handle.close();
    if (owner.handle.fd !== -1) throw new MaintenanceFailure("snapshot_invalid", "publication-close-unknown");
    retire();
  } catch (error) { if (observedClosed()) retire(); throw error; }
}

async function directoryIdentity(file: string, privateDirectory = false): Promise<PathIdentity> {
  const value = await lstat(file, { bigint: true });
  if (!value.isDirectory() || privateDirectory && ((value.mode & 0o777n) !== 0o700n || uid() !== undefined && value.uid !== BigInt(uid()!)))
    throw new MaintenanceFailure("control_root_mismatch");
  return id(file, value);
}
async function ancestors(file: string): Promise<PathIdentity[]> {
  const result: PathIdentity[] = [];
  for (let current = file; ; current = path.dirname(current)) {
    result.push(await directoryIdentity(current));
    if (path.dirname(current) === current) return result;
  }
}
async function syncDirectory(file: string): Promise<void> {
  const handle = await open(file, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await syncMaintenanceHandle(handle); } finally { await handle.close(); }
}
async function writeNew(file: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await syncMaintenanceHandle(handle); } finally { await handle.close(); }
}
function assertRef(ref: ArtifactRef): ObjectKind {
  if (!ref || Object.keys(ref).sort().join() !== "bytes,ref,sha256" || !DIGEST.test(ref.sha256) || !/^(0|[1-9][0-9]*)$/.test(ref.bytes))
    throw new MaintenanceFailure("snapshot_invalid");
  if (ref.ref === `plans/${ref.sha256}.json`) return "plan";
  if (new RegExp(`^journals/[a-zA-Z0-9_-]{1,100}/[1-9][0-9]*-${ref.sha256}\\.json$`).test(ref.ref)) return "journal";
  const match = /^snapshots\/([a-f0-9]{64})\/([a-z-]+)\.(json|bin)$/.exec(ref.ref);
  if (!match || match[1] !== ref.sha256 || !KINDS.has(match[2] as ObjectKind)
    || ["plan", "journal"].includes(match[2]!) || match[3] !== (RAW.has(match[2] as ObjectKind) ? "bin" : "json"))
    throw new MaintenanceFailure("snapshot_invalid");
  return match[2] as ObjectKind;
}

/** Private immutable content store; presence alone never advances a journal or DB anchor. */
export class ArtifactStore {
  readonly root: string;
  readonly identity: ControlRootIdentity;
  private readonly marker: RootMarker;
  private readonly options: StoreOptions;
  readonly #publicationRootKey: string;
  private constructor(marker: RootMarker, options: StoreOptions) {
    this.root = marker.root.path; this.identity = marker.root; this.marker = marker; this.options = options;
    this.#publicationRootKey = canonicalJson(marker.root);
  }
  static async create(root: string, source: SourceRef, options: StoreOptions = {}): Promise<ArtifactStore> {
    assertMaintenancePlatform();
    if (!path.isAbsolute(root) || path.resolve(root) !== root || await realpath(path.dirname(root)) !== path.dirname(root))
      throw new MaintenanceFailure("control_root_mismatch");
    try { await lstat(root); return await ArtifactStore.open(root, source, options); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await mkdir(root, { mode: 0o700 });
    const marker: RootMarker = { formatVersion: 1, kind: "maintenance-control-root", source, host: hostname(),
      root: { ...await directoryIdentity(root, true), hostIdentityDigest: await maintenanceHostIdentityDigest() }, ancestors: await ancestors(path.dirname(root)) };
    const temp = path.join(root, `.root-${randomUUID()}.tmp`);
    await writeNew(temp, Buffer.from(canonicalJson(marker)));
    await rename(temp, path.join(root, "control-root.json"));
    await syncDirectory(root); await syncDirectory(path.dirname(root));
    const store = new ArtifactStore(marker, options);
    await store.assertRoot();
    return store;
  }
  static async open(root: string, source: SourceRef, options: StoreOptions = {}): Promise<ArtifactStore> {
    try {
      const before = { ...await directoryIdentity(root, true), hostIdentityDigest: await maintenanceHostIdentityDigest() };
      const markerPath = path.join(root, "control-root.json");
      const handle = await open(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let marker: RootMarker;
      try {
        const info = await handle.stat({ bigint: true });
        if (!info.isFile() || info.nlink !== 1n || (info.mode & 0o777n) !== 0o600n || info.size > 64_000n) throw new Error("invalid marker");
        marker = parseCanonical(await handle.readFile()) as RootMarker;
      } finally { await handle.close(); }
      if (marker.formatVersion !== 1 || marker.kind !== "maintenance-control-root" || marker.host !== hostname()
        || canonicalJson(marker.source) !== canonicalJson(source) || canonicalJson(before) !== canonicalJson(marker.root)
        || !Array.isArray(marker.ancestors)) throw new Error("mismatched root");
      const store = new ArtifactStore(marker, options); await store.assertRoot(); return store;
    } catch { throw new MaintenanceFailure("control_root_mismatch"); }
  }
  async assertRoot(): Promise<void> {
    try {
      if (await realpath(this.root) !== this.root || canonicalJson({ ...await directoryIdentity(this.root, true), hostIdentityDigest: await maintenanceHostIdentityDigest() }) !== canonicalJson(this.identity)
        || canonicalJson(await ancestors(path.dirname(this.root))) !== canonicalJson(this.marker.ancestors)) throw new Error("root changed");
    } catch { throw new MaintenanceFailure("control_root_mismatch"); }
  }
  private async assertCurrent(): Promise<void> { await this.assertRoot(); await this.options.assertCurrent?.(); }
  private assertPublicationAvailable(): void {
    if (canonicalJson(this.identity) !== this.#publicationRootKey) throw new MaintenanceFailure("control_root_mismatch");
    const state = publications.get(this.#publicationRootKey); if (state) assertNoPendingPublication(state);
  }
  /** Bounded process-local observations, never success, COMMIT or qualification evidence.
   * An epoch change or absent epoch means idle history was discarded; it does not
   * mean prior calls succeeded. Caller mutation cannot alter records or root binding.
   */
  publicationOutcomes() {
    const state = publications.get(this.#publicationRootKey);
    return Object.freeze({ epoch: state?.epoch ?? null, discarded: state?.discarded ?? 0,
      limits: publicationLimits, records: Object.freeze((state?.records ?? []).map(record => Object.freeze({ ...record,
        artifact: record.artifact ? Object.freeze({ ...record.artifact }) : null, pendingCleanup: !!state && !state.active.has(record.invocation)
          && [...state.owners.values()].some(owner => owner.outcome === record) }))) });
  }
  /** Explicit cleanup of this validated root's original publication handles only.
   * No path lookup opens a replacement, and no write/rename/source SQL is replayed.
   * Cleanup remains possible through the original store even if a path later moves.
   */
  async cleanupPublications(): Promise<void> {
    const state = publications.get(this.#publicationRootKey); if (!state) return;
    if (state.cleanup) return state.cleanup;
    if (state.active.size) throw new MaintenanceFailure("snapshot_invalid", "publication-active");
    const task = Promise.resolve().then(async () => {
      let failed = false, first: unknown;
      for (const owner of [...state.owners.values()]) {
        try { await closePublicationOwner(state, owner); }
        catch (error) { owner.outcome.cleanupFailureObserved = true; if (!failed) { failed = true; first = error; } }
      }
      if (failed) throw first;
    });
    state.cleanup = task;
    try { await task; } finally { if (state.cleanup === task) state.cleanup = undefined; }
  }
  pathFor(ref: ArtifactRef): string { assertRef(ref); return path.join(this.root, ref.ref); }
  kindFor(ref: ArtifactRef): ObjectKind { return assertRef(ref); }
  private async mkdirPrivate(relative: string): Promise<void> {
    const parts = relative.split("/"); let current = this.root;
    for (const part of parts) {
      if (!/^[a-zA-Z0-9_-]+$/.test(part)) throw new MaintenanceFailure("snapshot_invalid");
      const parent = current; current = path.join(current, part);
      await this.assertCurrent();
      try { await mkdir(current, { mode: 0o700 }); await syncDirectory(current); await syncDirectory(parent); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      await directoryIdentity(current, true);
    }
  }
  async createAttempt(generation: number): Promise<string> {
    assertMaintenancePlatform();
    if (!Number.isSafeInteger(generation) || generation < 0) throw new MaintenanceFailure("maintenance_lost");
    const relative = `attempts/${generation}-${randomUUID()}`;
    await this.mkdirPrivate(relative); return path.join(this.root, relative);
  }
  async capability(): Promise<DurabilityCapability> {
    assertMaintenancePlatform(); await this.assertCurrent();
    const filesystem = await maintenanceFilesystem(this.root);
    // Runtime probe on this exact filesystem. It records successful syscalls, not power-loss tests.
    const ref = await this.putBytes("source-file-payload", Buffer.from(`durability-probe:${randomUUID()}`));
    await this.confirmDurable(ref);
    return { formatVersion: 1, kind: "capability", ...filesystem,
      node: process.version, rootIdentity: this.identity,
      powerLossTested: false, probeDigest: ref.sha256 };
  }
  private reference(kind: ObjectKind, bytes: Uint8Array, body?: unknown): ArtifactRef {
    if (!KINDS.has(kind)) throw new MaintenanceFailure("snapshot_invalid");
    const hash = sha256(bytes); let ref: string;
    if (kind === "plan") ref = `plans/${hash}.json`;
    else if (kind === "journal") {
      const value = body as { migrationId?: unknown; sequence?: unknown };
      if (typeof value?.migrationId !== "string" || !UUID.test(value.migrationId)
        || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1) throw new MaintenanceFailure("journal_invalid");
      ref = `journals/${value.migrationId}/${value.sequence}-${hash}.json`;
    } else ref = `snapshots/${hash}/${kind}.${RAW.has(kind) ? "bin" : "json"}`;
    return { ref, sha256: hash, bytes: String(bytes.byteLength) };
  }
  async putJson(kind: Exclude<ObjectKind, "source-file-payload" | "database-snapshot">, body: unknown): Promise<ArtifactRef> {
    const bytes = Buffer.from(canonicalJson(body)); return this.publish(this.reference(kind, bytes, body), bytes);
  }
  async putBytes(kind: "source-file-payload" | "database-snapshot", bytes: Uint8Array): Promise<ArtifactRef> {
    return this.publish(this.reference(kind, bytes), bytes);
  }

  /** Streams untrusted source-file bytes into one owned private temp file.
   * The digest is not known until EOF and the same open file is reread and
   * synchronized.  A published payload alone never qualifies a source Fs.
   */
  async putSourceFilePayload(chunks: AsyncIterable<Uint8Array>, expectedBytes: bigint,
    options: { signal?: AbortSignal } = {}): Promise<ArtifactRef> {
    if (typeof expectedBytes !== "bigint" || expectedBytes < 0n || expectedBytes > BigInt(Number.MAX_SAFE_INTEGER)
      || !chunks || typeof chunks[Symbol.asyncIterator] !== "function")
      throw new MaintenanceFailure("snapshot_invalid", "source-file-payload-input");
    assertMaintenancePlatform();
    await this.assertCurrent();
    if (canonicalJson(this.identity) !== this.#publicationRootKey) throw new MaintenanceFailure("control_root_mismatch");
    const state = publicationState(this.#publicationRootKey);
    const outcome = beginPublication(state, null);
    const checkCancel = () => {
      if (options.signal?.aborted) throw new MaintenanceFailure("snapshot_invalid", "source-file-payload-cancelled");
    };
    try {
      const attempt = "attempts/0-" + randomUUID();
      await this.mkdirPrivate(attempt);
      const temp = path.join(this.root, attempt, "stream-" + randomUUID() + ".tmp");
      const handle = await open(temp, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const owner: PublicationOwner = { handle, fd: handle.fd, outcome };
      state.owners.set(handle, owner);
      outcome.handleOpened = true;

      let failed = false, first: unknown, closeFailed = false, closeError: unknown;
      let iterator: AsyncIterator<Uint8Array> | undefined, ended = false;
      let total = 0n, digest: string | undefined;
      try {
        const info = fstatSync(handle.fd, { bigint: true });
        owner.identity = String(info.dev) + ":" + String(info.ino);
        iterator = chunks[Symbol.asyncIterator]();
        if (!iterator || typeof iterator.next !== "function")
          throw new MaintenanceFailure("snapshot_invalid", "source-file-payload-iterator");
        const hash = createHash("sha256");
        while (true) {
          checkCancel();
          const step = await iterator.next();
          checkCancel();
          if (step.done) { ended = true; break; }
          if (!(step.value instanceof Uint8Array) || step.value.byteLength === 0
            || step.value.byteLength > 64 * 1024)
            throw new MaintenanceFailure("snapshot_invalid", "source-file-payload-chunk");
          // Never hold a caller-owned buffer across asynchronous writes.
          const owned = Buffer.from(step.value);
          if (total + BigInt(owned.byteLength) > expectedBytes)
            throw new MaintenanceFailure("snapshot_invalid", "source-file-payload-overflow");
          let written = 0;
          while (written < owned.length) {
            checkCancel();
            const result = await handle.write(owned, written, owned.length - written, Number(total) + written);
            if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0
              || result.bytesWritten > owned.length - written)
              throw new MaintenanceFailure("snapshot_invalid", "source-file-payload-short-write");
            written += result.bytesWritten;
          }
          hash.update(owned);
          total += BigInt(owned.length);
        }
        if (total !== expectedBytes) throw new MaintenanceFailure("snapshot_invalid", "source-file-payload-length");
        digest = hash.digest("hex");
        const reference: ArtifactRef = { ref: "snapshots/" + digest + "/source-file-payload.bin",
          sha256: digest, bytes: String(total) };
        outcome.artifact = { ...reference };

        // Re-read the very same open owner; a path reopen is not byte identity.
        const stat = await handle.stat({ bigint: true });
        if (!stat.isFile() || stat.nlink !== 1n || stat.size !== total || (stat.mode & 0o777n) !== 0o600n)
          throw new MaintenanceFailure("snapshot_invalid", "source-file-payload-identity");
        const actualHash = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024);
        let at = 0n;
        while (at < total) {
          checkCancel();
          const size = Number(total - at > BigInt(buffer.length) ? BigInt(buffer.length) : total - at);
          const result = await handle.read(buffer, 0, size, Number(at));
          if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead <= 0 || result.bytesRead > size)
            throw new MaintenanceFailure("snapshot_invalid", "source-file-payload-reread");
          actualHash.update(buffer.subarray(0, result.bytesRead));
          at += BigInt(result.bytesRead);
        }
        if (actualHash.digest("hex") !== digest) throw new MaintenanceFailure("snapshot_invalid", "source-file-payload-digest");
        await this.options.after?.("temp_written");
        await syncMaintenanceHandle(handle);
        await this.options.after?.("file_synced");
      } catch (error) { failed = true; first = error; outcome.failureObserved = true; }
      // This settles the source iterator before retiring the owner, even if the
      // first thrown value was undefined. Return failure is only secondary.
      if (!ended && iterator?.return) {
        try { await iterator.return(); }
        catch (error) { if (!failed) { failed = true; first = error; outcome.failureObserved = true; } }
      }
      try { await closePublicationOwner(state, owner); }
      catch (error) { closeFailed = true; closeError = error; outcome.closeFailureObserved = true; }
      if (failed) throw first;
      if (closeFailed) throw closeError;
      if (!digest || !outcome.artifact) throw new MaintenanceFailure("snapshot_invalid", "source-file-payload-digest");
      assertNoPendingPublication(state);
      const ref = outcome.artifact;
      await this.mkdirPrivate("snapshots/" + digest);
      const target = this.pathFor(ref);
      try {
        await lstat(target);
        await this.confirmDurable(ref);
        await unlink(temp); await syncDirectory(path.dirname(temp));
        await this.verifyFile(ref);
        assertNoPendingPublication(state);
        return ref;
      } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error; }
      await this.assertCurrent();
      await rename(temp, target); await this.options.after?.("renamed");
      await syncDirectory(path.dirname(target)); await syncDirectory(path.dirname(temp));
      await this.options.after?.("directory_synced");
      await this.verifyFile(ref);
      assertNoPendingPublication(state);
      return ref;
    } catch (error) { if (!outcome.closeFailureObserved) outcome.failureObserved = true; throw error; }
    finally { state.active.delete(outcome.invocation); outcome.operationFinished = true; }
  }

  /** Import only an already closed regular file inside our unique attempt subtree. */
  async importDatabase(file: string): Promise<ArtifactRef> {
    assertMaintenancePlatform(); await this.assertCurrent();
    this.assertPublicationAvailable();
    if (!file.startsWith(`${this.root}/attempts/`) || await realpath(file) !== file) throw new MaintenanceFailure("snapshot_invalid");
    const info = await lstat(file, { bigint: true });
    if (!info.isFile() || info.nlink !== 1n || info.size === 0n) throw new MaintenanceFailure("snapshot_invalid");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    const sha = hash.digest("hex");
    const ref = { ref: `snapshots/${sha}/database-snapshot.bin`, sha256: sha, bytes: String(info.size) };
    await this.mkdirPrivate(`snapshots/${sha}`);
    const source = await open(file, constants.O_RDWR | constants.O_NOFOLLOW);
    try { await source.chmod(0o600); await syncMaintenanceHandle(source); } finally { await source.close(); }
    await this.assertCurrent();
    try { await lstat(this.pathFor(ref)); await this.confirmDurable(ref); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await rename(file, this.pathFor(ref)); await this.options.after?.("renamed");
      await syncDirectory(path.dirname(this.pathFor(ref))); await syncDirectory(path.dirname(file));
      await this.options.after?.("directory_synced");
    }
    await this.verifyFile(ref); this.assertPublicationAvailable(); return ref;
  }
  private async publish(ref: ArtifactRef, bytes: Uint8Array): Promise<ArtifactRef> {
    assertMaintenancePlatform(); await this.assertCurrent();
    if (canonicalJson(this.identity) !== this.#publicationRootKey) throw new MaintenanceFailure("control_root_mismatch");
    const state = publicationState(this.#publicationRootKey), outcome = beginPublication(state, ref);
    try {
      await this.mkdirPrivate(path.posix.dirname(ref.ref));
      const target = this.pathFor(ref);
      try { await lstat(target); await this.confirmDurable(ref); assertNoPendingPublication(state); return ref; }
      catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error; }
      const temp = `${target}.${randomUUID()}.tmp`;
      const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const owner: PublicationOwner = { handle, fd: handle.fd, outcome }; state.owners.set(handle, owner); outcome.handleOpened = true;
      let failed = false, first: unknown, closeFailed = false, closeError: unknown;
      try {
        const info = fstatSync(handle.fd, { bigint: true }); owner.identity = `${info.dev}:${info.ino}`;
        await handle.writeFile(bytes); await this.options.after?.("temp_written");
        await syncMaintenanceHandle(handle); await this.options.after?.("file_synced");
      } catch (error) { failed = true; first = error; outcome.failureObserved = true; }
      try { await closePublicationOwner(state, owner); }
      catch (error) { closeFailed = true; closeError = error; outcome.closeFailureObserved = true; }
      if (failed) throw first;
      if (closeFailed) throw closeError;
      assertNoPendingPublication(state);
      await this.assertCurrent(); await rename(temp, target); await this.options.after?.("renamed");
      await syncDirectory(path.dirname(target)); await this.options.after?.("directory_synced");
      await this.verifyFile(ref); assertNoPendingPublication(state); return ref;
    } catch (error) { if (!outcome.closeFailureObserved) outcome.failureObserved = true; throw error; }
    finally { state.active.delete(outcome.invocation); outcome.operationFinished = true; }
  }
  private async verifiedHandle(ref: ArtifactRef) {
    await this.assertRoot(); const file = this.pathFor(ref);
    let current = path.dirname(file);
    while (current !== this.root) { await directoryIdentity(current, true); current = path.dirname(current); }
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat({ bigint: true });
      if (!info.isFile() || info.nlink !== 1n || String(info.size) !== ref.bytes || (info.mode & 0o777n) !== 0o600n)
        throw new MaintenanceFailure("snapshot_invalid");
      return handle;
    } catch (error) { await handle.close(); throw error; }
  }
  async readBytes(ref: ArtifactRef): Promise<Buffer> {
    const handle = await this.verifiedHandle(ref);
    try {
      const bytes = await handle.readFile();
      if (sha256(bytes) !== ref.sha256) throw new MaintenanceFailure("snapshot_invalid");
      await this.assertRoot(); return bytes;
    } finally { await handle.close(); }
  }
  async readJson(ref: ArtifactRef, expectedKind: ObjectKind): Promise<unknown> {
    if (this.kindFor(ref) !== expectedKind || RAW.has(expectedKind)) throw new MaintenanceFailure("journal_invalid");
    return parseCanonical(await this.readBytes(ref));
  }
  /** Size comes from this exact existing DB-selected object, never a directory search. */
  async readAnchoredJournal(pointer: { readonly ref: string; readonly sha256: string }): Promise<ArtifactRef> {
    const candidate = { ...pointer, bytes: "0" };
    if (this.kindFor(candidate) !== "journal") throw new MaintenanceFailure("journal_invalid");
    await this.assertRoot();
    const file = this.pathFor(candidate);
    let current = path.dirname(file);
    while (current !== this.root) { await directoryIdentity(current, true); current = path.dirname(current); }
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let reference: ArtifactRef;
    try {
      const info = await handle.stat({ bigint: true });
      if (!info.isFile() || info.nlink !== 1n || (info.mode & 0o777n) !== 0o600n) throw new MaintenanceFailure("journal_invalid");
      reference = { ...pointer, bytes: String(info.size) };
    } finally { await handle.close(); }
    await this.readBytes(reference);
    return reference;
  }
  async verifyFile(ref: ArtifactRef): Promise<void> {
    const handle = await this.verifiedHandle(ref);
    try {
      const hash = createHash("sha256");
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
      if (hash.digest("hex") !== ref.sha256) throw new MaintenanceFailure("snapshot_invalid");
      await this.assertRoot();
    } finally { await handle.close(); }
  }
  /** Resync an already published immutable name; this invocation does not perform a rename. */
  async confirmDurable(ref: ArtifactRef): Promise<{ artifact: ArtifactRef; completed: readonly ["file_sync", "immutable_name_verified", "directory_sync"] }> {
    assertMaintenancePlatform(); await this.assertCurrent(); this.assertPublicationAvailable(); await this.verifyFile(ref);
    const handle = await this.verifiedHandle(ref);
    try { await syncMaintenanceHandle(handle); } finally { await handle.close(); }
    for (let parent = path.dirname(this.pathFor(ref)); ; parent = path.dirname(parent)) {
      await syncDirectory(parent); if (parent === this.root) break;
    }
    await this.assertCurrent(); this.assertPublicationAvailable();
    return { artifact: ref, completed: ["file_sync", "immutable_name_verified", "directory_sync"] };
  }
}

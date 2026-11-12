import { constants, createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, statfs } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { canonicalJson, parseCanonical, sha256 } from "./canonical.ts";
import { MaintenanceFailure } from "./error.ts";
import { maintenanceHostIdentityDigest } from "./host.ts";
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
  try { await handle.sync(); } finally { await handle.close(); }
}
async function writeNew(file: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
function ensureLinux(): void {
  if (process.platform !== "linux") throw new MaintenanceFailure("unsupported_durability");
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
  private constructor(marker: RootMarker, options: StoreOptions) {
    this.root = marker.root.path; this.identity = marker.root; this.marker = marker; this.options = options;
  }
  static async create(root: string, source: SourceRef, options: StoreOptions = {}): Promise<ArtifactStore> {
    ensureLinux();
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
    ensureLinux();
    if (!Number.isSafeInteger(generation) || generation < 0) throw new MaintenanceFailure("maintenance_lost");
    const relative = `attempts/${generation}-${randomUUID()}`;
    await this.mkdirPrivate(relative); return path.join(this.root, relative);
  }
  async capability(): Promise<DurabilityCapability> {
    ensureLinux(); await this.assertCurrent();
    const stats = await statfs(this.root);
    // Runtime probe on this exact filesystem. It records successful syscalls, not power-loss tests.
    if (![0x794c7630, 0xef53, 0x58465342].includes(stats.type)) throw new MaintenanceFailure("unsupported_durability");
    const ref = await this.putBytes("source-file-payload", Buffer.from(`durability-probe:${randomUUID()}`));
    await this.confirmDurable(ref);
    return { formatVersion: 1, kind: "capability", platform: "linux", filesystemType: String(stats.type),
      node: process.version, rootIdentity: this.identity,
      guarantee: "observed-file-fsync-rename-directory-fsync", powerLossTested: false, probeDigest: ref.sha256 };
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
  /** Import only an already closed regular file inside our unique attempt subtree. */
  async importDatabase(file: string): Promise<ArtifactRef> {
    ensureLinux(); await this.assertCurrent();
    if (!file.startsWith(`${this.root}/attempts/`) || await realpath(file) !== file) throw new MaintenanceFailure("snapshot_invalid");
    const info = await lstat(file, { bigint: true });
    if (!info.isFile() || info.nlink !== 1n || info.size === 0n) throw new MaintenanceFailure("snapshot_invalid");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    const sha = hash.digest("hex");
    const ref = { ref: `snapshots/${sha}/database-snapshot.bin`, sha256: sha, bytes: String(info.size) };
    await this.mkdirPrivate(`snapshots/${sha}`);
    const source = await open(file, constants.O_RDWR | constants.O_NOFOLLOW);
    try { await source.chmod(0o600); await source.sync(); } finally { await source.close(); }
    await this.assertCurrent();
    try { await lstat(this.pathFor(ref)); await this.confirmDurable(ref); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await rename(file, this.pathFor(ref)); await this.options.after?.("renamed");
      await syncDirectory(path.dirname(this.pathFor(ref))); await syncDirectory(path.dirname(file));
      await this.options.after?.("directory_synced");
    }
    await this.verifyFile(ref); return ref;
  }
  private async publish(ref: ArtifactRef, bytes: Uint8Array): Promise<ArtifactRef> {
    ensureLinux(); await this.assertCurrent();
    await this.mkdirPrivate(path.posix.dirname(ref.ref));
    const target = this.pathFor(ref);
    try { await lstat(target); await this.confirmDurable(ref); return ref; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temp = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(bytes); await this.options.after?.("temp_written");
      await handle.sync(); await this.options.after?.("file_synced");
    } finally { await handle.close(); }
    await this.assertCurrent(); await rename(temp, target); await this.options.after?.("renamed");
    await syncDirectory(path.dirname(target)); await this.options.after?.("directory_synced");
    await this.verifyFile(ref); return ref;
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
    ensureLinux(); await this.assertCurrent(); await this.verifyFile(ref);
    const handle = await this.verifiedHandle(ref);
    try { await handle.sync(); } finally { await handle.close(); }
    for (let parent = path.dirname(this.pathFor(ref)); ; parent = path.dirname(parent)) {
      await syncDirectory(parent); if (parent === this.root) break;
    }
    await this.assertCurrent();
    return { artifact: ref, completed: ["file_sync", "immutable_name_verified", "directory_sync"] };
  }
}

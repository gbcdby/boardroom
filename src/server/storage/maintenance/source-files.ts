import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { canonicalJson, digestJson } from "./canonical.ts";
import { MaintenanceFailure } from "./error.ts";
import { ArtifactStore } from "./objects.ts";
import { hash, id, ref, text } from "./parse-primitives.ts";
import { parsePlan, parseSourceFiles, readSourceFiles } from "./parse.ts";
import { observePlannedPath } from "./plan.ts";
import { syncMaintenanceHandle } from "./platform.ts";
import { withNativeSourceRoot } from "./source-file-native.ts";
import type { SourceFileHandle, SourceFileExtendedMetadata, SourceFileExtendedObservation,
  SourceFileStatxObservation, SourceFileUniqueStatxObservation } from "./source-file-native.ts";
import { matchSourceFileProfile } from "./source-file-profile.ts";
import type { SourceFileRootObservation } from "./source-file-profile.ts";
import type { ArtifactRef, BlockerCode, FileRoot, Json, MigrationPlan, OperationMutex, PersistedPlanRef,
  SourceFileEntry, SourceFilesManifest, SourceLock, SourceObservation, SourceClientsObservation, SourceRootBinding } from "./types.ts";

type Stage = "input" | "boundary" | "profile" | "scan" | "health" | "close" | "source-postcheck" | "tcut" | "durable";
/** Private diagnostics retain the first thrown value, including undefined, and
 * independent cleanup results. The safe message contains no source data/path. */
export class SourceFilesFailure extends MaintenanceFailure {
  readonly stage: Stage;
  override readonly cause: unknown;
  readonly closeErrors: readonly unknown[];
  readonly tcutReached: boolean;
  constructor(cause: unknown, stage: Stage, closeErrors: readonly unknown[], tcutReached: boolean) {
    super(failureCode(cause), "source-files-" + stage);
    this.cause = cause; this.stage = stage; this.closeErrors = [...closeErrors]; this.tcutReached = tcutReached;
  }
}
function failureCode(error: unknown): BlockerCode {
  if (error instanceof MaintenanceFailure) return error.code;
  if (error instanceof AggregateError && error.errors.length) return failureCode(error.errors[0]);
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ERR_SOURCE_HANDLE") return "maintenance_lost";
  if (["ERR_SOURCE_IDENTITY", "ENOENT", "ENOTDIR", "ELOOP"].includes(String(code))) return "source_changed";
  return "backup_capability_unavailable";
}
const MAX_ENTRIES = 250_000, MAX_DEPTH = 128;
const MAX_FILE_BYTES = 256n * 1024n * 1024n, MAX_CONTENT_BYTES = 1024n * 1024n * 1024n;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024, MAX_PLAN_BYTES = 4n * 1024n * 1024n;
const MAX_WORK_MS = 120_000, MAX_PROTECTED_ENTRIES = 16_384;
const CHUNK_BYTES = 65_536;
const PROFILE = "linux-native-ext4-fid-fsuuid-source-state-v1";
// Retain the actual auxiliary owner after an uncertain close. A later call may
// not silently create a new successful window over unresolved local resources;
// no numeric descriptor is re-closed or adopted. Trusted recovery is separate.
const uncertainAuxiliaries = new Map<string, Set<object>>();
function retainUncertainAuxiliary(scan: Scan, owner: object): void {
  const key = canonicalJson(scan.store.identity);
  let owners = uncertainAuxiliaries.get(key);
  if (!owners) { owners = new Set(); uncertainAuxiliaries.set(key, owners); }
  owners.add(owner);
}
const referenceSchema = z.object({ migrationId: id, planDigest: hash, immutablePlan: ref, controlRoot: text }).strict();
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const contains = (parent: string, child: string) => parent === child || child.startsWith(parent === "/" ? "/" : parent + "/");
const overlaps = (left: string, right: string) => contains(left, right) || contains(right, left);
const keyOf = (value: { dev: bigint; ino: bigint }) => String(value.dev) + ":" + String(value.ino);
const modeOf = (value: { mode: bigint }) => (value.mode & 0o7777n).toString(8).padStart(4, "0");
const pathIdentity = (file: string, value: { dev: bigint; ino: bigint }) => ({ path: file, device: String(value.dev), inode: String(value.ino) });
function requireValue(value: unknown, code: BlockerCode = "source_changed", subject = "source-files"): asserts value {
  if (!value) throw new MaintenanceFailure(code, subject);
}
function serial(value: unknown): Json {
  if (typeof value === "bigint") return String(value);
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (Array.isArray(value)) return value.map(serial);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serial(item)]));
  requireValue(value === null || ["string", "number", "boolean"].includes(typeof value), "backup_capability_unavailable");
  return value as Json;
}
const metadataFields = ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "atimeNs", "mtimeNs", "ctimeNs"] as const;
function sameMetadata(left: SourceFileExtendedMetadata, right: SourceFileExtendedMetadata | BigIntStats): boolean {
  return metadataFields.every(field => left[field] === right[field])
    && ("fsType" in right ? left.fsType === right.fsType && left.kind === right.kind : true);
}
function validPath(file: string): boolean {
  return path.posix.isAbsolute(file) && path.posix.resolve(file) === file && !file.includes("\0")
    && Buffer.byteLength(file) <= 4096 && new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(file)) === file;
}
function validLeaf(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\0")
    && Buffer.byteLength(name) <= 255 && new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(name)) === name;
}
function names(handle: SourceFileHandle): readonly string[] {
  const values = handle.readDirectory();
  requireValue(values.length <= 4096 && values.every(validLeaf) && new Set(values).size === values.length);
  return [...values].sort();
}
function encodedDevice(major: bigint, minor: bigint): bigint {
  requireValue(major >= 0n && major <= 0xffffffffn && minor >= 0n && minor <= 0xffffffffn);
  return (minor & 0xffn) | ((major & 0xfffn) << 8n) | ((minor & ~0xffn) << 12n) | ((major & ~0xfffn) << 32n);
}
interface Snapshot {
  readonly metadata: SourceFileExtendedMetadata;
  readonly legacy: SourceFileStatxObservation;
  readonly unique: SourceFileUniqueStatxObservation;
  readonly uuid: string;
  readonly incarnation: { readonly type: 1; readonly byteCount: 8; readonly hex: string };
  readonly flags: string;
  readonly xattrsDigest: string;
}
function snapshot(handle: SourceFileHandle): Snapshot {
  const basic = handle.observe(), extended = handle.observeExtended(), legacy = handle.observeStatx(), unique = handle.observeStatxUnique();
  const metadata = extended.before;
  requireValue(sameMetadata(metadata, extended.after)
    && Object.entries(basic).every(([field, value]) => value === metadata[field as keyof SourceFileExtendedMetadata]));
  requireValue(metadata.fsType === 0xef53n && metadata.kind === handle.kind && metadata.ino > 0n
    && process.getuid !== undefined && metadata.uid === BigInt(process.getuid()) && (metadata.mode & 0o22n) === 0n
    && (metadata.kind === "directory" ? (metadata.mode & 0o170000n) === 0o040000n && metadata.nlink > 0n
      : (metadata.mode & 0o170000n) === 0o100000n && metadata.nlink === 1n && metadata.size >= 0n));
  for (const observed of [legacy, unique]) requireValue((observed.mask & 0x7ffn) === 0x7ffn
    && observed.kind === metadata.kind && observed.ino === metadata.ino
    && encodedDevice(observed.devMajor, observed.devMinor) === metadata.dev);
  requireValue((legacy.mask & 0x1000n) !== 0n && legacy.mountId !== null && legacy.mountId > 0n
    && (unique.mask & 0x4000n) !== 0n && unique.uniqueMountId !== null && unique.uniqueMountId > 0n,
  "backup_capability_unavailable", "source-files-mount-mask");
  requireValue(legacy.birthtimeNs === unique.birthtimeNs && legacy.attributes === unique.attributes
    && legacy.attributesMask === unique.attributesMask);
  for (const fact of [extended.uuid, extended.fid, extended.inodeFlags, extended.xattrs])
    requireValue(fact.status === "observed", "backup_capability_unavailable", "source-files-native-fact");
  // The fixed P getter remains broad; this S profile accepts precisely ext4's
  // reviewed UUID/opaque FID representation, never a stat-only replacement.
  requireValue(extended.uuid.status === "observed" && extended.fid.status === "observed"
    && extended.inodeFlags.status === "observed" && extended.xattrs.status === "observed");
  const uuid = extended.uuid.value, fid = extended.fid.value, attributes = extended.xattrs.value;
  requireValue(uuid.length === 16n && uuid.bytes.length === 16 && uuid.bytes.some(byte => byte !== 0)
    && fid.handleType === 1n && fid.handleBytes === 8n && fid.bytes.length === 8
    && fid.mountId === unique.uniqueMountId, "backup_capability_unavailable", "source-files-native-codec");
  let count = 0, previous: Buffer | undefined;
  requireValue(attributes.length <= 64, "backup_capability_unavailable");
  for (const attribute of attributes) {
    requireValue(Buffer.isBuffer(attribute.name) && attribute.name.length > 0 && attribute.name.length <= 255
      && !attribute.name.includes(0) && Buffer.isBuffer(attribute.value) && (!previous || Buffer.compare(previous, attribute.name) < 0),
    "backup_capability_unavailable");
    count += attribute.name.length + attribute.value.length;
    requireValue(count <= 65_536, "backup_capability_unavailable"); previous = attribute.name;
  }
  return { metadata, legacy, unique, uuid: uuid.bytes.toString("hex"), incarnation: { type: 1, byteCount: 8, hex: fid.bytes.toString("hex") },
    flags: String(extended.inodeFlags.value), xattrsDigest: digestJson(serial(attributes)) };
}
function sameSnapshot(left: Snapshot, right: Snapshot): boolean { return same(serial(left), serial(right)); }
function sameMount(anchor: Snapshot, entry: Snapshot): boolean {
  return anchor.metadata.dev === entry.metadata.dev && anchor.legacy.mountId === entry.legacy.mountId
    && anchor.unique.uniqueMountId === entry.unique.uniqueMountId && anchor.uuid === entry.uuid;
}
function rootObservationMatches(context: SourceFileRootObservation, root: Snapshot): void {
  requireValue(sameMetadata(root.metadata, context.root.before) && sameMetadata(root.metadata, context.root.after)
    && context.root.uuid.status === "observed" && context.root.uuid.value.length === 16n
    && context.root.uuid.value.bytes.toString("hex") === root.uuid
    && context.root.fid.status === "observed" && context.root.fid.value.handleType === 1n && context.root.fid.value.handleBytes === 8n
    && context.root.fid.value.bytes.toString("hex") === root.incarnation.hex
    && context.root.fid.value.mountId === root.unique.uniqueMountId
    && context.root.inodeFlags.status === "observed" && String(context.root.inodeFlags.value) === root.flags
    && context.root.xattrs.status === "observed" && digestJson(serial(context.root.xattrs.value)) === root.xattrsDigest
    && same(serial(context.uniqueStatx), serial(root.unique))
    && context.mount.legacyMountId === root.legacy.mountId && context.mount.uniqueMountId === root.unique.uniqueMountId
    && context.mount.devMajor === root.legacy.devMajor && context.mount.devMinor === root.legacy.devMinor
    && context.mount.filesystemType === "ext4" && /^[a-f0-9]{64}$/.test(context.runtimeEnvironmentDigest));
}

interface Scan {
  readonly store: ArtifactStore; readonly lock: SourceLock; readonly mutex: OperationMutex;
  readonly reference: PersistedPlanRef; readonly plan: MigrationPlan;
  readonly initial: SourceObservation; readonly raw: SourceClientsObservation;
  readonly start: number; readonly forbidden: Set<string>; readonly seen: Set<string>;
  readonly entries: SourceFileEntry[]; readonly bindings: SourceRootBinding[];
  readonly closeErrors: unknown[]; readonly stages: { stage: Stage; at: string }[];
  readonly rootsEvidence: Json[];
  count: number; keptBytes: number; contentBytes: bigint; stage: Stage; tcut: boolean;
  attempt: string | undefined;
}
function stage(scan: Scan, value: Stage): void {
  scan.stage = value; scan.stages.push({ stage: value, at: new Date().toISOString() });
}
function budget(scan: Scan): void {
  requireValue(performance.now() - scan.start <= MAX_WORK_MS && scan.count <= MAX_ENTRIES
    && scan.keptBytes <= MAX_MANIFEST_BYTES && scan.contentBytes <= MAX_CONTENT_BYTES,
  "backup_capability_unavailable", "source-files-budget");
}
function retain(scan: Scan, value: unknown): void { scan.keptBytes += Buffer.byteLength(canonicalJson(value)) + 1; budget(scan); }
async function held(scan: Scan): Promise<void> { budget(scan); await scan.mutex.assertHeld(); await scan.lock.assertHeld(); }
async function current(scan: Scan): Promise<void> {
  await held(scan); await scan.store.assertRoot();
  const observed = await scan.lock.observe(), raw = await scan.lock.observeSourceClients();
  requireValue(same(observed.state, scan.initial.state), "maintenance_lost");
  requireValue(same(observed, scan.initial) && same(raw, scan.raw)); await held(scan);
}
async function child<T>(scan: Scan, owner: SourceFileHandle, consume: () => Promise<T>): Promise<T> {
  let failed = false, first: unknown, result: T | undefined;
  try { result = await consume(); } catch (error) { failed = true; first = error; }
  try { owner.close(); } catch (error) {
    scan.closeErrors.push(error);
    if (!failed) { failed = true; first = error; scan.stage = "close"; }
  }
  if (failed) throw first;
  return result!;
}
async function nativeScope<T>(scan: Scan, file: string, consume: (handle: SourceFileHandle) => Promise<T>): Promise<T> {
  let completed = false;
  try {
    return await withNativeSourceRoot(file, async handle => {
      const value = await consume(handle); completed = true; return value;
    });
  } catch (error) {
    // A callback result is not evidence that its native scope actually closed.
    // The scope aggregate keeps its primary first, even when that value is undefined.
    if (error instanceof AggregateError && error.errors.length) {
      scan.closeErrors.push(...error.errors.slice(completed ? 0 : 1));
      if (completed) scan.stage = "close";
      throw error.errors[0];
    }
    if (completed) { scan.closeErrors.push(error); scan.stage = "close"; }
    throw error;
  }
}
async function pathFacts(file: string): Promise<BigIntStats> {
  requireValue(validPath(file)); const value = await lstat(file, { bigint: true });
  requireValue(!value.isSymbolicLink() && (value.isFile() || value.isDirectory()) && await realpath(file) === file);
  return value;
}
async function assertPath(file: string, expected: SourceFileExtendedMetadata): Promise<void> {
  requireValue(sameMetadata(expected, await pathFacts(file)));
}
function stableTuple(file: string, relative: string, item: Snapshot): Record<string, Json> {
  const value = item.metadata;
  return { path: file, relative, kind: value.kind, identity: pathIdentity(file, value),
    filesystemUuidHex: item.uuid, incarnation: item.incarnation, mode: modeOf(value), uid: String(value.uid), gid: String(value.gid),
    nlink: String(value.nlink), inodeFlags: item.flags, xattrsDigest: item.xattrsDigest };
}
async function protectedIdentities(scan: Scan): Promise<void> {
  const pending = [{ file: scan.store.root, depth: 0 }]; let count = 0;
  scan.count++; retain(scan, scan.store.root);
  for (let index = 0; index < pending.length; index++) {
    await held(scan); const { file, depth } = pending[index]!, before = await pathFacts(file);
    requireValue(before.isDirectory() && before.uid === BigInt(process.getuid!()) && (before.mode & 0o7777n) === 0o700n,
      "control_root_mismatch");
    scan.forbidden.add(keyOf(before));
    const directory = await opendir(file, { bufferSize: 32 }); let failed = false, first: unknown;
    try {
      for (;;) {
        const item = await directory.read(); if (item === null) break;
        requireValue(++count <= MAX_PROTECTED_ENTRIES && depth <= MAX_DEPTH, "backup_capability_unavailable", "source-files-protected-budget");
        scan.count++; await held(scan);
        const childFile = path.join(file, item.name); retain(scan, childFile); const info = await pathFacts(childFile);
        requireValue(info.uid === BigInt(process.getuid!()) && (info.isDirectory() ? (info.mode & 0o7777n) === 0o700n
          : info.nlink === 1n && (info.mode & 0o7777n) === 0o600n), "control_root_mismatch");
        scan.forbidden.add(keyOf(info)); if (info.isDirectory()) pending.push({ file: childFile, depth: depth + 1 });
      }
    } catch (error) { failed = true; first = error; }
    try { await directory.close(); } catch (error) {
      retainUncertainAuxiliary(scan, directory); scan.closeErrors.push(error); if (!failed) { failed = true; first = error; }
    }
    if (failed) throw first;
    const after = await lstat(file, { bigint: true });
    requireValue(["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs"].every(
      key => before[key as keyof BigIntStats] === after[key as keyof BigIntStats]), "control_root_mismatch");
  }
  const identity = scan.plan.sourceIdentity as Record<string, Json>;
  const excluded = [scan.plan.targetRoot.path];
  if (scan.plan.source.kind === "sqlite") {
    requireValue(identity.kind === "sqlite" && typeof identity.sqlitePath === "string" && validPath(identity.sqlitePath), "plan_stale");
    excluded.push(identity.sqlitePath, identity.sqlitePath + "-wal", identity.sqlitePath + "-shm", identity.sqlitePath + "-journal");
  }
  for (const file of excluded) {
    try { scan.forbidden.add(keyOf(await pathFacts(file))); }
    catch (error) { if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error; }
  }
}
async function initialScan(store: ArtifactStore, lock: SourceLock, mutex: OperationMutex, value: PersistedPlanRef): Promise<Scan> {
  const parsed = referenceSchema.safeParse(value); requireValue(parsed.success, "plan_stale");
  const reference = parsed.data;
  requireValue(reference.planDigest === reference.immutablePlan.sha256 && reference.controlRoot === store.root
    && reference.immutablePlan.bytes.length <= 20 && BigInt(reference.immutablePlan.bytes) <= MAX_PLAN_BYTES, "plan_stale");
  await mutex.assertHeld(); await lock.assertHeld(); await store.assertRoot();
  requireValue(!uncertainAuxiliaries.has(canonicalJson(store.identity)) && uncertainAuxiliaries.size < 64,
    "backup_capability_unavailable", "source-files-auxiliary-close-unresolved");
  const bytes = await store.readBytes(reference.immutablePlan);
  requireValue(store.kindFor(reference.immutablePlan) === "plan", "plan_stale");
  const plan = parsePlan(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)));
  requireValue(Buffer.from(canonicalJson(plan)).equals(bytes) && plan.migrationId === reference.migrationId
    && plan.controlRoot.path === store.root && digestJson(plan.sourceIdentity) === plan.source.identityDigest, "plan_stale");
  const initial = await lock.observe(), raw = await lock.observeSourceClients(), state = initial.state;
  requireValue(state.admission === "draining" || state.admission === "sealed", "phase_conflict");
  requireValue(same(initial.source, plan.source) && same(initial.sourceIdentity, plan.sourceIdentity)
    && same(raw.source, initial.source) && same(raw.sourceIdentity, initial.sourceIdentity) && same(raw.state, state)
    && raw.schemaManifestDigest === initial.manifests.schemaManifestDigest
    && state.databaseInstanceId === plan.source.databaseInstanceId);
  requireValue(state.activeMigrationId === plan.migrationId && state.planDigest === reference.planDigest
    && initial.manifests.schemaManifestDigest === plan.schemaManifestDigest && state.guardManifestDigest === plan.guardManifestDigest,
  "plan_stale");
  requireValue(state.controlRootJson === canonicalJson(store.identity) && state.mutexIdentityJson === canonicalJson(mutex.identity), "control_root_mismatch");
  const guarded = await ArtifactStore.open(store.root, plan.source, { assertCurrent: async () => { await mutex.assertHeld(); await lock.assertHeld(); } });
  requireValue(same(guarded.identity, store.identity), "control_root_mismatch");
  requireValue(plan.fileRoots.length >= 1 && plan.fileRoots.length <= 2
    && new Set(plan.fileRoots.map(root => root.label)).size === plan.fileRoots.length
    && plan.fileRoots.some(root => root.label === "managed-sessions")
    && plan.fileRoots.filter(root => root.label === "config").length === (plan.originalConfigPath === null ? 0 : 1), "plan_stale");
  const sourceIdentity = plan.sourceIdentity as Record<string, Json>;
  const sqliteFile = plan.source.kind === "sqlite" && typeof sourceIdentity.sqlitePath === "string" ? sourceIdentity.sqlitePath : null;
  const forbiddenPaths = [store.root, plan.targetRoot.path,
    ...(sqliteFile === null ? [] : [sqliteFile, sqliteFile + "-wal", sqliteFile + "-shm", sqliteFile + "-journal"])];
  for (const root of plan.fileRoots) {
    requireValue(validPath(root.path) && root.expected.path === root.path && validPath(root.expected.existingAncestor.path)
      && root.expected.absentSegments.every(validLeaf) && root.expected.absentSegments.length <= MAX_DEPTH
      && path.join(root.expected.existingAncestor.path, ...root.expected.absentSegments) === root.path
      && (root.label !== "config" || root.path === plan.originalConfigPath), "plan_stale");
    requireValue(!forbiddenPaths.some(file => overlaps(root.path, file))
      && !plan.fileRoots.some(other => other !== root && overlaps(root.path, other.path)), "source_changed");
  }
  const scan: Scan = { store: guarded, lock, mutex, reference, plan, initial, raw, start: performance.now(), forbidden: new Set(), seen: new Set(),
    entries: [], bindings: [], closeErrors: [], stages: [], rootsEvidence: [], count: 0, keptBytes: 0, contentBytes: 0n, stage: "input", tcut: false, attempt: undefined };
  try {
    retain(scan, plan.fileRoots); await current(scan); stage(scan, "boundary"); await protectedIdentities(scan);
    scan.attempt = await guarded.createAttempt(state.ownerGeneration);
  } catch (error) { throw new SourceFilesFailure(error, scan.stage, scan.closeErrors, false); }
  return scan;
}

async function readPayload(scan: Scan, handle: SourceFileHandle, before: Snapshot, capture: boolean): Promise<ArtifactRef> {
  const expected = before.metadata.size;
  requireValue(expected <= MAX_FILE_BYTES, "backup_capability_unavailable", "source-files-file-budget");
  scan.contentBytes += expected; budget(scan);
  const hash = createHash("sha256"); let offset = 0n;
  async function* chunks(): AsyncGenerator<Buffer> {
    while (offset < expected) {
      await held(scan); const observed = handle.observe();
      requireValue(Object.entries(observed).every(([field, value]) => before.metadata[field as keyof SourceFileExtendedMetadata] === value));
      const remaining = expected - offset, requested = Number(remaining > BigInt(CHUNK_BYTES) ? BigInt(CHUNK_BYTES) : remaining);
      const bytes = handle.readAt(offset, requested);
      requireValue(bytes.length > 0 && bytes.length <= requested); hash.update(bytes); offset += BigInt(bytes.length);
      await held(scan); yield bytes;
    }
    await held(scan); requireValue(handle.readAt(expected, 1).length === 0);
  }
  let payload: ArtifactRef | undefined;
  if (capture) payload = await scan.store.putSourceFilePayload(chunks(), expected);
  else for await (const _ of chunks()) { /* Live observes source bytes without republishing payloads. */ }
  const sha256 = hash.digest("hex"), result = { ref: "snapshots/" + sha256 + "/source-file-payload.bin", sha256, bytes: String(offset) };
  requireValue(offset === expected && (!payload || same(payload, result)), "snapshot_invalid"); return result;
}
async function visit(scan: Scan, root: FileRoot, owner: SourceFileHandle, relative: string,
  anchor: Snapshot, capture: boolean, rows: { relative: string; tuple: Json }[], depth: number,
  parent?: { handle: SourceFileHandle; before: Snapshot; file: string }): Promise<SourceFileEntry> {
  await held(scan); requireValue(depth <= MAX_DEPTH, "backup_capability_unavailable", "source-files-depth");
  scan.count++; budget(scan); const file = path.join(root.path, relative), before = snapshot(owner);
  requireValue(sameMount(anchor, before) && !scan.forbidden.has(keyOf(before.metadata)) && !scan.seen.has(keyOf(before.metadata)));
  scan.seen.add(keyOf(before.metadata)); await assertPath(file, before.metadata);
  if (parent) { requireValue(sameSnapshot(parent.before, snapshot(parent.handle))); await assertPath(parent.file, parent.before.metadata); }
  const tuple = stableTuple(file, relative, before), identity = pathIdentity(file, before.metadata);
  let entry: SourceFileEntry;
  if (owner.kind === "file") {
    const payload = await readPayload(scan, owner, before, capture);
    const change = { mtimeNs: String(before.metadata.mtimeNs), ctimeNs: String(before.metadata.ctimeNs),
      observedBirthtimeNs: before.legacy.birthtimeNs === null ? null : String(before.legacy.birthtimeNs) };
    entry = { sourceRoot: root.label, sourceRelativePath: relative, kind: "file", identity, mode: modeOf(before.metadata),
      size: String(before.metadata.size), payload, sourceWitness: { kind: "file", incarnation: before.incarnation, change } };
    Object.assign(tuple, { size: entry.size, bytesDigest: payload.sha256, change });
    if (root.label === "config" && relative === "") requireValue(payload.sha256 === scan.plan.configDigest, "plan_stale");
  } else {
    const members = names(owner), membership: Json[] = [];
    entry = { sourceRoot: root.label, sourceRelativePath: relative, kind: "directory", identity, mode: modeOf(before.metadata), size: null,
      payload: null, sourceWitness: { kind: "directory", incarnation: before.incarnation } };
    // Directory times and st_size are guarded inside this scan, but do not
    // become persistent identity across an allowed member-create/delete cycle.
    for (const name of members) {
      await held(scan); const childFile = path.join(file, name), facts = await pathFacts(childFile);
      requireValue(facts.isDirectory() || facts.isFile());
      const opened = owner.openChild(name, facts.isDirectory() ? "directory" : "file");
      const found = await child(scan, opened, async () => {
        const observed = snapshot(opened); requireValue(sameMetadata(observed.metadata, facts));
        const result = await visit(scan, root, opened, relative ? relative + "/" + name : name, anchor, capture, rows, depth + 1,
          { handle: owner, before, file });
        // Re-resolve precisely this basename from the still-held original parent.
        // This verification owner never supplies the captured content bytes.
        const currentOwner = owner.openChild(name, opened.kind);
        await child(scan, currentOwner, async () => { requireValue(sameSnapshot(observed, snapshot(currentOwner))); });
        return result;
      });
      requireValue(found.kind !== "absent");
      membership.push({ name, kind: found.kind, identity: { ...found.identity }, incarnation: found.sourceWitness.incarnation });
    }
    requireValue(same(members, names(owner))); tuple.members = membership;
  }
  requireValue(sameSnapshot(before, snapshot(owner))); await assertPath(file, before.metadata);
  if (parent) { requireValue(sameSnapshot(parent.before, snapshot(parent.handle))); await assertPath(parent.file, parent.before.metadata); }
  retain(scan, entry); retain(scan, tuple); scan.entries.push(entry); rows.push({ relative, tuple });
  await held(scan); return entry;
}

async function scanRoot(scan: Scan, root: FileRoot, capture: boolean): Promise<void> {
  await current(scan); requireValue(same(await observePlannedPath(root.path), root.expected));
  const anchorPath = root.expected.existingAncestor.path, parentPath = path.dirname(anchorPath);
  requireValue(anchorPath !== parentPath, "backup_capability_unavailable", "source-files-root-boundary");
  stage(scan, "profile");
  await nativeScope(scan, parentPath, async parent => {
    // The parent only guards pathname membership. It never supplies the file
    // root's profile, UUID/FID, bytes, or rootBinding anchor.
    const parentBefore = parent.observe(), parentFacts = await pathFacts(parentPath);
    requireValue(parent.kind === "directory" && parentBefore.dev === parentFacts.dev && parentBefore.ino === parentFacts.ino);
    await nativeScope(scan, anchorPath, async anchorOwner => {
      requireValue(root.label === "config" ? anchorOwner.kind === "file" && root.expected.absentSegments.length === 0
        : anchorOwner.kind === "directory", "plan_stale");
      const profile = matchSourceFileProfile(anchorOwner);
      requireValue(profile.profile === PROFILE && /^[a-f0-9]{64}$/.test(profile.profileEntryDigest)
        && /^[a-f0-9]{64}$/.test(profile.qualificationDigest), "backup_capability_unavailable");
      const beforeContext = profile.beforeContent(), anchor = snapshot(anchorOwner);
      rootObservationMatches(beforeContext, anchor);
      requireValue(same(pathIdentity(anchorPath, anchor.metadata), root.expected.existingAncestor)
        && !scan.forbidden.has(keyOf(anchor.metadata)));
      await assertPath(anchorPath, anchor.metadata);
      const rows: { relative: string; tuple: Json }[] = [];
      stage(scan, "scan");
      if (root.expected.absentSegments.length) {
        requireValue(anchorOwner.kind === "directory");
        const beforeNames = names(anchorOwner);
        requireValue(!beforeNames.includes(root.expected.absentSegments[0]!));
        requireValue(same(await observePlannedPath(root.path), root.expected));
        const tuple: Json = { kind: "absent", path: root.path, suffix: root.expected.absentSegments,
          ancestor: stableTuple(anchorPath, "", anchor) };
        const absent: SourceFileEntry = { sourceRoot: root.label, sourceRelativePath: "", kind: "absent", identity: null,
          mode: null, size: null, payload: null, sourceWitness: null };
        scan.count++; retain(scan, tuple); retain(scan, absent); rows.push({ relative: "", tuple }); scan.entries.push(absent);
        requireValue(same(beforeNames, names(anchorOwner)) && sameSnapshot(anchor, snapshot(anchorOwner)));
      } else await visit(scan, root, anchorOwner, "", anchor, capture, rows, 0);
      requireValue(same(await observePlannedPath(root.path), root.expected));
      // A root may itself be a mount point. Its fresh root lookup permits that
      // explicit boundary; child lookup below it always remains NO_XDEV.
      await nativeScope(scan, anchorPath, async currentOwner => { requireValue(sameSnapshot(anchor, snapshot(currentOwner))); });
      await assertPath(anchorPath, anchor.metadata);
      stage(scan, "health"); const afterContext = profile.afterContent();
      rootObservationMatches(afterContext, anchor);
      requireValue(same(serial(beforeContext.mount), serial(afterContext.mount))
        && same(serial(beforeContext.health), serial(afterContext.health)));
      requireValue(same(serial(parentBefore), serial(parent.observe())));
      const parentAfter = await pathFacts(parentPath);
      requireValue(["dev", "ino", "mode", "uid", "gid", "nlink", "size", "atimeNs", "mtimeNs", "ctimeNs"].every(
        field => parentFacts[field as keyof BigIntStats] === parentAfter[field as keyof BigIntStats]));
      rows.sort((left, right) => left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0);
      const sourceStateDigest = digestJson({ formatVersion: 1, kind: "source-files-root-state", sourceRoot: root.label,
        rootPath: root.path, entries: rows.map(row => row.tuple) });
      const binding: SourceRootBinding = { sourceRoot: root.label, profile: PROFILE, filesystemType: "ext4",
        hostIdentityDigest: scan.store.identity.hostIdentityDigest, filesystemUuidHex: anchor.uuid,
        anchorPath, anchorKind: anchorOwner.kind, anchorHandle: anchor.incarnation,
        readEvidence: { policy: "application-source-preservation-v1", kernelDiagnosticPolicy: "ext4-last-mounted-v1",
          profileEntryDigest: profile.profileEntryDigest, qualificationDigest: profile.qualificationDigest,
          runtimeEnvironmentDigest: afterContext.runtimeEnvironmentDigest, sourceStateDigest,
          blockEffectsObservation: "not-observed-at-runtime" } };
      retain(scan, binding); scan.bindings.push(binding);
      // The private record keeps full window guards; none are silently omitted
      // from this scan merely because directory times/mount IDs are not durable identity.
      scan.rootsEvidence.push({ sourceRoot: root.label, before: serial(beforeContext), after: serial(afterContext) });
      stage(scan, "close");
    });
    requireValue(same(serial(parentBefore), serial(parent.observe())));
  });
  stage(scan, "source-postcheck"); await current(scan);
}
function persistentManifest(manifest: SourceFilesManifest): unknown {
  return { ...manifest, rootBindings: manifest.rootBindings.map(binding => {
    requireValue(binding.profile === PROFILE, "backup_capability_unavailable", "source-files-profile");
    const { runtimeEnvironmentDigest: _, ...stable } = binding.readEvidence;
    return { ...binding, readEvidence: stable };
  }) };
}
async function writeAttempt(scan: Scan, successful: boolean): Promise<void> {
  if (!scan.attempt) return;
  const bytes = Buffer.from(canonicalJson({ formatVersion: 1, kind: "source-files-read-attempt", plan: scan.reference.immutablePlan,
    stages: scan.stages, roots: scan.rootsEvidence, tcutReached: scan.tcut, outcome: successful ? "pending-close" : "failed",
    objectsInspected: scan.count, contentBytes: String(scan.contentBytes), closeFailureCount: scan.closeErrors.length }));
  await scan.store.assertRoot();
  const directory = await pathFacts(scan.attempt);
  requireValue(directory.isDirectory() && directory.uid === BigInt(process.getuid!()) && (directory.mode & 0o7777n) === 0o700n,
    "control_root_mismatch");
  const handle = await open(path.join(scan.attempt, "source-files-read.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let failed = false, first: unknown;
  try { await handle.writeFile(bytes); await syncMaintenanceHandle(handle); } catch (error) { failed = true; first = error; }
  try { await handle.close(); } catch (error) {
    retainUncertainAuxiliary(scan, handle); scan.closeErrors.push(error); if (!failed) { failed = true; first = error; }
  }
  if (failed) throw first;
}
async function run(store: ArtifactStore, lock: SourceLock, mutex: OperationMutex, reference: PersistedPlanRef,
  existing?: ArtifactRef): Promise<{ ref: ArtifactRef; manifest: SourceFilesManifest }> {
  let scan: Scan | undefined, result: { ref: ArtifactRef; manifest: SourceFilesManifest } | undefined;
  let failed = false, first: unknown;
  try {
    scan = await initialScan(store, lock, mutex, reference);
    let expected: SourceFilesManifest | undefined;
    if (existing) {
      requireValue(store.kindFor(existing) === "source-files" && existing.bytes.length <= 20
        && BigInt(existing.bytes) <= BigInt(MAX_MANIFEST_BYTES), "snapshot_invalid");
      expected = await readSourceFiles(scan.store, existing);
      requireValue(same(expected.source, scan.plan.source) && same(expected.roots, scan.plan.fileRoots), "source_changed");
      persistentManifest(expected);
      requireValue(expected.entries.length <= MAX_ENTRIES, "backup_capability_unavailable", "source-files-budget");
      let archivedBytes = 0n;
      for (const entry of expected.entries) if (entry.payload) {
        requireValue(entry.payload.bytes.length <= 20 && BigInt(entry.payload.bytes) <= MAX_FILE_BYTES,
          "backup_capability_unavailable", "source-files-file-budget");
        archivedBytes += BigInt(entry.payload.bytes);
        requireValue(archivedBytes <= MAX_CONTENT_BYTES, "backup_capability_unavailable", "source-files-budget");
        await held(scan); await scan.store.verifyFile(entry.payload);
      }
    }
    for (const root of scan.plan.fileRoots) await scanRoot(scan, root, !existing);
    // Deterministic code-unit order, independent of readdir return order and DFS shape.
    scan.entries.sort((left, right) => {
      const a = left.sourceRoot + "/" + left.sourceRelativePath, b = right.sourceRoot + "/" + right.sourceRelativePath;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const manifest = parseSourceFiles({ formatVersion: 2, kind: "source-files", source: scan.plan.source, roots: scan.plan.fileRoots,
      rootBindings: scan.bindings, entries: scan.entries,
      sourceMembershipExclusions: ["database-files", "entire-maintenance-control-root", "all-maintenance-artifacts"] });
    requireValue(Buffer.byteLength(canonicalJson(manifest)) <= MAX_MANIFEST_BYTES, "backup_capability_unavailable", "source-files-budget");
    if (expected) requireValue(same(persistentManifest(manifest), persistentManifest(expected)));
    stage(scan, "source-postcheck"); await current(scan);
    for (const root of scan.plan.fileRoots) requireValue(same(await observePlannedPath(root.path), root.expected));
    await held(scan); stage(scan, "tcut"); scan.tcut = true;
    if (existing) result = { ref: existing, manifest: expected! };
    else {
      stage(scan, "durable");
      for (const entry of manifest.entries) if (entry.payload) { await held(scan); await scan.store.confirmDurable(entry.payload); }
      await current(scan);
      const ref = await scan.store.putJson("source-files", manifest);
      await scan.store.confirmDurable(ref); requireValue(same(await readSourceFiles(scan.store, ref), manifest), "snapshot_invalid");
      await current(scan); result = { ref, manifest };
    }
  } catch (error) { failed = true; first = error; }
  if (scan) {
    try { await writeAttempt(scan, !failed); } catch (error) { if (!failed) { failed = true; first = error; scan.stage = "close"; } }
    if (!failed) {
      try { stage(scan, "source-postcheck"); await current(scan); }
      catch (error) { failed = true; first = error; }
    }
  }
  if (failed) {
    if (first instanceof SourceFilesFailure) throw first;
    const closeErrors = scan?.closeErrors ?? [];
    if (first instanceof AggregateError) {
      closeErrors.push(...first.errors.slice(1)); first = first.errors[0];
    }
    throw new SourceFilesFailure(first, scan?.stage ?? "input", closeErrors, scan?.tcut ?? false);
  }
  return result!;
}

/** Internal S only. The caller retains the actual source lock/mutex and the
 * outer withSourceClientFacts window. Fs is neither quiescence nor Jq authority. */
export async function captureSourceFiles(store: ArtifactStore, lock: SourceLock, mutex: OperationMutex,
  plan: PersistedPlanRef): Promise<{ ref: ArtifactRef; manifest: SourceFilesManifest }> {
  return run(store, lock, mutex, plan);
}
/** A new full source/profile/health window. Never rewrites or supplements Fs,
 * upgrades a historical profile, or treats old readEvidence as current permission. */
export async function verifyLiveSourceFiles(store: ArtifactStore, lock: SourceLock, mutex: OperationMutex,
  plan: PersistedPlanRef, reference: ArtifactRef): Promise<void> {
  await run(store, lock, mutex, plan, reference);
}

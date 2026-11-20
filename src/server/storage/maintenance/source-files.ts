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
import { sourceFileObservationStart, chargeSourceFileObservation } from "./source-file-writers.ts";
import type { SourceFileHandle, SourceFileExtendedMetadata, SourceFileExtendedObservation,
  SourceFileStatxObservation, SourceFileUniqueStatxObservation, SourceFileExpectedProfile } from "./source-file-native.ts";
import { matchSourceFileProfile, SOURCE_PREPARE_PROFILE, sourceFileInodePermitted } from "./source-file-profile.ts";
import type { QualifiedSourceFileProfile, SourceFileRootObservation } from "./source-file-profile.ts";
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
// A new CFP2 FD/profile object cannot erase a failure under the identical
// actual source lock. A trusted recovery must obtain its own lock/window.
const failedSourceWindows = new WeakMap<SourceLock, SourceFilesFailure>();
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
interface WindowEvidence {
  readonly sourceRoot: FileRoot["label"];
  readonly before: Json;
  // Null means no complete after observation was retained. Never substitute
  // the before observation when reading, validation or the budget has failed.
  after: Json | null;
  tail?: Json;
}
interface EntryWindowEvidence extends WindowEvidence { readonly sourceRelativePath: string; }
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
function admitSnapshot(scan: Scan, root: FileRoot, value: Snapshot): void {
  requireValue(sourceFileInodePermitted(value.metadata.kind, BigInt(value.flags), value.unique.attributes, value.unique.attributesMask),
    scan.expectedBindings.has(root.label) ? "source_changed" : "backup_capability_unavailable", "source-file-inode-attributes");
}
function sameMount(anchor: Snapshot, entry: Snapshot): boolean {
  return anchor.metadata.dev === entry.metadata.dev && anchor.legacy.mountId === entry.legacy.mountId
    && anchor.unique.uniqueMountId === entry.unique.uniqueMountId && anchor.uuid === entry.uuid;
}
function healthMaterial(health: SourceFileRootObservation["health"]): Json {
  // P independently validates each fresh collector's calls before returning.
  // Auxiliary FD numbers and valid read segmentation are per-call diagnostics;
  // compare every health field's actual bytes and identity, keeping raw calls
  // separately in the full before/after private evidence.
  return serial(Object.fromEntries(Object.entries(health).map(([name, { calls: _, ...value }]) => [name, value])));
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
  readonly mode: "record-attempt" | "read-only";
  readonly syncedDirectories: Set<string>;
  readonly expectedBindings: Map<FileRoot["label"], SourceRootBinding>;
  readonly windows: { review(): Promise<void>; closeOrdinary(): Promise<void>; closeTail(): Promise<void> }[];
  readonly entries: SourceFileEntry[]; readonly bindings: SourceRootBinding[];
  readonly closeErrors: unknown[]; readonly stages: { stage: Stage; at: string }[];
  readonly rootsEvidence: WindowEvidence[]; readonly entriesEvidence: EntryWindowEvidence[];
  count: number; keptBytes: number; contentBytes: bigint; stage: Stage; tcut: boolean;
  chargedCount: number; chargedBytes: number; chargedContentBytes: bigint;
  preparePolicy: boolean;
  attempt: string | undefined;
}
function stage(scan: Scan, value: Stage): void {
  scan.stage = value; scan.stages.push({ stage: value, at: new Date().toISOString() });
}
function budget(scan: Scan): void {
  chargeSourceFileObservation(scan.count - scan.chargedCount, scan.keptBytes - scan.chargedBytes,
    scan.contentBytes - scan.chargedContentBytes);
  scan.chargedCount = scan.count; scan.chargedBytes = scan.keptBytes; scan.chargedContentBytes = scan.contentBytes;
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
  try { await owner.closeAsync(); } catch (error) {
    scan.closeErrors.push(error);
    if (!failed) { failed = true; first = error; scan.stage = "close"; }
  }
  if (failed) throw first;
  return result!;
}
async function nativeScope<T>(scan: Scan, file: string, consume: (handle: SourceFileHandle) => Promise<T>,
  expected?: SourceFileExpectedProfile): Promise<T> {
  let completed = false;
  try {
    return await withNativeSourceRoot(file, async handle => {
      const value = await consume(handle); completed = true; return value;
    }, expected);
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
async function initialScan(store: ArtifactStore, lock: SourceLock, mutex: OperationMutex, value: PersistedPlanRef,
  mode: "record-attempt" | "read-only", start: number): Promise<Scan> {
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
  const scan: Scan = { store: guarded, lock, mutex, reference, plan, initial, raw, start, mode, forbidden: new Set(), seen: new Set(),
    syncedDirectories: new Set(), expectedBindings: new Map(), windows: [],
    entries: [], bindings: [], closeErrors: [], stages: [], rootsEvidence: [], entriesEvidence: [],
    count: 0, keptBytes: 0, contentBytes: 0n, chargedCount: 0, chargedBytes: 0, chargedContentBytes: 0n,
    stage: "input", tcut: false, preparePolicy: false, attempt: undefined };
  try {
    retain(scan, plan.fileRoots); await current(scan); stage(scan, "boundary"); await protectedIdentities(scan);
    if (mode === "record-attempt") scan.attempt = await guarded.createAttempt(state.ownerGeneration);
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
interface RootProtocol {
  readonly profile: QualifiedSourceFileProfile;
  readonly root: SourceFileHandle;
  afterRoot?: SourceFileRootObservation;
}
async function synchronizeDirectory(scan: Scan, owner: SourceFileHandle, before: Snapshot): Promise<void> {
  requireValue(owner.kind === "directory" && sameSnapshot(before, snapshot(owner)));
  const key = String(before.unique.uniqueMountId) + ":" + keyOf(before.metadata);
  if (scan.mode === "record-attempt" && !scan.syncedDirectories.has(key)) {
    await held(scan); await owner.synchronize();
    scan.syncedDirectories.add(key); await held(scan);
  }
  requireValue(sameSnapshot(before, snapshot(owner)));
}
/** R/V are separate open file descriptions. Every fresh F ends before R and
 * the last V sync; no later regular owner is opened by a parent/root caller. */
async function readCurrentFile(scan: Scan, owner: SourceFileHandle, before: Snapshot, file: string,
  capture: boolean, protocol: RootProtocol, evidence: EntryWindowEvidence,
  parent?: { handle: SourceFileHandle; before: Snapshot; file: string }): Promise<ArtifactRef> {
  let verifier: SourceFileHandle | undefined, failed = false, first: unknown, result: ArtifactRef | undefined;
  const postcheck = async (handle: SourceFileHandle) => {
    const after = snapshot(handle); requireValue(sameSnapshot(before, after));
    await assertPath(file, before.metadata);
    if (parent) { requireValue(sameSnapshot(parent.before, snapshot(parent.handle))); await assertPath(parent.file, parent.before.metadata); }
    return after;
  };
  try {
    await held(scan);
    if (scan.mode === "record-attempt") {
      verifier = owner.reopenFile(); requireValue(sameSnapshot(before, snapshot(verifier)));
      await held(scan); await owner.synchronize(); await held(scan);
    }
    result = await readPayload(scan, owner, before, capture);
    await held(scan);
    const fresh = owner.reopenFile();
    await child(scan, fresh, async () => { await postcheck(fresh); });
    const after = await postcheck(owner), material = serial(after);
    retain(scan, material); evidence.after = material;
    if (owner === protocol.root) protocol.afterRoot = protocol.profile.afterContent();
    await held(scan); await owner.closeAsync(); await held(scan);
    if (verifier) {
      await verifier.synchronize(); await held(scan); await postcheck(verifier);
      if (owner === protocol.root) {
        const currentProfile = matchSourceFileProfile(verifier);
        requireValue(currentProfile.profile === protocol.profile.profile
          && currentProfile.profileEntryDigest === protocol.profile.profileEntryDigest
          && currentProfile.qualificationDigest === protocol.profile.qualificationDigest);
        protocol.afterRoot = currentProfile.afterContent();
      }
    }
  } catch (error) { failed = true; first = error; }
  // closeAsync retains the original in-flight promise. Reaching this cleanup
  // after an earlier successful close cannot issue another close syscall.
  for (const handle of [owner, verifier]) if (handle) {
    try { await handle.closeAsync(); }
    catch (error) {
      if (!scan.closeErrors.some(value => Object.is(value, error))) scan.closeErrors.push(error);
      if (!failed) { failed = true; first = error; scan.stage = "close"; }
    }
  }
  if (failed) throw first;
  await held(scan); return result!;
}
async function visit(scan: Scan, root: FileRoot, owner: SourceFileHandle, relative: string,
  anchor: Snapshot, expectedBefore: Snapshot, capture: boolean, rows: { relative: string; tuple: Json }[], depth: number,
  parent?: { handle: SourceFileHandle; before: Snapshot; file: string }, protocol?: RootProtocol): Promise<SourceFileEntry> {
  await held(scan); requireValue(depth <= MAX_DEPTH, "backup_capability_unavailable", "source-files-depth");
  scan.count++; budget(scan); const file = path.join(root.path, relative), before = snapshot(owner);
  requireValue(sameSnapshot(expectedBefore, before));
  const evidence: EntryWindowEvidence = { sourceRoot: root.label, sourceRelativePath: relative, before: serial(before), after: null };
  retain(scan, evidence); scan.entriesEvidence.push(evidence);
  requireValue(sameMount(anchor, before) && !scan.forbidden.has(keyOf(before.metadata)) && !scan.seen.has(keyOf(before.metadata)));
  scan.seen.add(keyOf(before.metadata)); await assertPath(file, before.metadata);
  if (parent) { requireValue(sameSnapshot(parent.before, snapshot(parent.handle))); await assertPath(parent.file, parent.before.metadata); }
  admitSnapshot(scan, root, before);
  const tuple = stableTuple(file, relative, before), identity = pathIdentity(file, before.metadata);
  let entry: SourceFileEntry;
  if (owner.kind === "file") {
    const payload = protocol ? await readCurrentFile(scan, owner, before, file, capture, protocol, evidence, parent)
      : await readPayload(scan, owner, before, capture);
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
        const result = await visit(scan, root, opened, relative ? relative + "/" + name : name, anchor, observed, capture, rows, depth + 1,
          { handle: owner, before, file }, protocol);
        // Re-resolve precisely this basename from the still-held original parent.
        // This verification owner never supplies the captured content bytes.
        if (!protocol || opened.kind === "directory") {
          const currentOwner = owner.openChild(name, opened.kind);
          await child(scan, currentOwner, async () => { requireValue(sameSnapshot(observed, snapshot(currentOwner))); });
          if (protocol) await synchronizeDirectory(scan, opened, observed);
        }
        return result;
      });
      requireValue(found.kind !== "absent");
      membership.push({ name, kind: found.kind, identity: { ...found.identity }, incarnation: found.sourceWitness.incarnation });
    }
    requireValue(same(members, names(owner))); tuple.members = membership;
  }
  if (!protocol || owner.kind === "directory") {
    const after = snapshot(owner), afterEvidence = serial(after);
    retain(scan, afterEvidence); evidence.after = afterEvidence;
    requireValue(sameSnapshot(before, after)); await assertPath(file, before.metadata);
    if (parent) { requireValue(sameSnapshot(parent.before, snapshot(parent.handle))); await assertPath(parent.file, parent.before.metadata); }
  }
  retain(scan, entry); retain(scan, tuple); scan.entries.push(entry); rows.push({ relative, tuple });
  await held(scan); return entry;
}

async function scanRoot(scan: Scan, root: FileRoot, capture: boolean, next: () => Promise<void>): Promise<void> {
  await current(scan); requireValue(same(await observePlannedPath(root.path), root.expected));
  const anchorPath = root.expected.existingAncestor.path, parentPath = path.dirname(anchorPath);
  requireValue(anchorPath !== parentPath, "backup_capability_unavailable", "source-files-root-boundary");
  let continued = false, parentTransferred = false;
  const frozen = scan.expectedBindings.get(root.label);
  const expected = frozen && (frozen.profile === PROFILE || frozen.profile === SOURCE_PREPARE_PROFILE) ? { profile: frozen.profile,
    profileEntryDigest: frozen.readEvidence.profileEntryDigest, qualificationDigest: frozen.readEvidence.qualificationDigest } : undefined;
  stage(scan, "profile");
  await nativeScope(scan, parentPath, async parent => {
    // A cross-filesystem prefix only guards membership. It never supplies the
    // source profile or becomes a same-filesystem carrier by assertion.
    const parentBefore = parent.observe(), parentFacts = await pathFacts(parentPath);
    requireValue(parent.kind === "directory" && parentBefore.dev === parentFacts.dev && parentBefore.ino === parentFacts.ino);
    await nativeScope(scan, anchorPath, async anchorOwner => {
      requireValue(root.label === "config" ? anchorOwner.kind === "file" && root.expected.absentSegments.length === 0
        : anchorOwner.kind === "directory", "plan_stale");
      const profile = matchSourceFileProfile(anchorOwner), modern = profile.profile === SOURCE_PREPARE_PROFILE;
      if (modern) scan.preparePolicy = true;
      if (expected) requireValue(profile.profile === expected.profile && profile.profileEntryDigest === expected.profileEntryDigest
        && profile.qualificationDigest === expected.qualificationDigest);
      requireValue((profile.profile === PROFILE || modern) && /^[a-f0-9]{64}$/.test(profile.profileEntryDigest)
        && /^[a-f0-9]{64}$/.test(profile.qualificationDigest), "backup_capability_unavailable");
      const beforeContext = profile.beforeContent();
      const evidence: WindowEvidence = { sourceRoot: root.label, before: serial(beforeContext), after: null };
      retain(scan, evidence); scan.rootsEvidence.push(evidence);
      const anchor = snapshot(anchorOwner);
      rootObservationMatches(beforeContext, anchor);
      requireValue(same(pathIdentity(anchorPath, anchor.metadata), root.expected.existingAncestor)
        && !scan.forbidden.has(keyOf(anchor.metadata)));
      await assertPath(anchorPath, anchor.metadata);
      admitSnapshot(scan, root, anchor);
      let parentSnapshot: Snapshot | undefined;
      // Preserve the original eligibility gate. A foreign filesystem prefix
      // guards only membership and must not be sent through ext4 getters.
      if (parentBefore.dev === anchor.metadata.dev && parentBefore.fsType === anchor.metadata.fsType) {
        await held(scan);
        const observed = snapshot(parent);
        requireValue(sameMetadata(observed.metadata, parentFacts));
        if (sameMount(anchor, observed)) {
          admitSnapshot(scan, root, observed); retain(scan, serial(observed)); parentSnapshot = observed;
        }
      }
      const sameFilesystemParent = parentSnapshot !== undefined;
      const rows: { relative: string; tuple: Json }[] = [];
      const protocol: RootProtocol | undefined = modern ? { profile, root: anchorOwner } : undefined;
      // M exists before the last ordinary R/D release. Retaining it is an
      // actual O_PATH open, not a copied observation or a late content reopen.
      const tail = modern ? profile.retainMetadata() : undefined;
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
      } else await visit(scan, root, anchorOwner, "", anchor, anchor, capture, rows, 0, undefined, protocol);
      const parentCurrent = async () => {
        requireValue(same(serial(parentBefore), serial(parent.observe())));
        const after = await pathFacts(parentPath);
        requireValue(metadataFields.every(field => parentFacts[field] === after[field]));
      };
      const rootCurrent = async () => {
        requireValue(same(await observePlannedPath(root.path), root.expected));
        await assertPath(anchorPath, anchor.metadata);
      };
      const observeAfter = (afterContext: SourceFileRootObservation) => {
        const afterEvidence = serial(afterContext); retain(scan, afterEvidence); evidence.after = afterEvidence;
        rootObservationMatches(afterContext, anchor);
        requireValue(same(serial(beforeContext.mount), serial(afterContext.mount))
          && same(healthMaterial(beforeContext.health), healthMaterial(afterContext.health)));
      };
      const bind = (runtimeEnvironmentDigest: string) => {
        rows.sort((left, right) => left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0);
        const sourceStateDigest = digestJson({ formatVersion: 1, kind: "source-files-root-state", sourceRoot: root.label,
          rootPath: root.path, entries: rows.map(row => row.tuple) });
        const common = { sourceRoot: root.label, filesystemType: "ext4" as const,
          hostIdentityDigest: scan.store.identity.hostIdentityDigest, filesystemUuidHex: anchor.uuid,
          anchorPath, anchorKind: anchorOwner.kind, anchorHandle: anchor.incarnation };
        const readEvidence = { kernelDiagnosticPolicy: "ext4-last-mounted-v1" as const,
          profileEntryDigest: profile.profileEntryDigest, qualificationDigest: profile.qualificationDigest,
          runtimeEnvironmentDigest, sourceStateDigest, blockEffectsObservation: "not-observed-at-runtime" as const };
        const binding: SourceRootBinding = modern
          ? { ...common, profile: SOURCE_PREPARE_PROFILE, readEvidence: { ...readEvidence, policy: "application-source-preservation-with-prepare-v1" } }
          : { ...common, profile: PROFILE, readEvidence: { ...readEvidence, policy: "application-source-preservation-v1" } };
        retain(scan, binding); scan.bindings.push(binding);
      };
      if (!protocol || !tail) {
        await rootCurrent();
        await nativeScope(scan, anchorPath, async fresh => { requireValue(sameSnapshot(anchor, snapshot(fresh))); });
        stage(scan, "health"); const after = profile.afterContent(); observeAfter(after);
        await parentCurrent();
        if (parentSnapshot) requireValue(sameSnapshot(parentSnapshot, snapshot(parent)));
        bind(after.runtimeEnvironmentDigest); stage(scan, "close");
        return;
      }
      scan.windows.push({
        async review() {
          await held(scan); await rootCurrent(); await parentCurrent();
          if (anchorOwner.kind === "directory") {
            // Explicit root mount boundaries remain allowed; descendants still
            // use the native BENEATH/NO_XDEV child path.
            await nativeScope(scan, anchorPath, async fresh => { requireValue(sameSnapshot(anchor, snapshot(fresh))); });
          }
        },
        async closeOrdinary() {
          await held(scan); await rootCurrent(); await parentCurrent();
          if (anchorOwner.kind === "directory") await synchronizeDirectory(scan, anchorOwner, anchor);
          if (sameFilesystemParent) await synchronizeDirectory(scan, parent, parentSnapshot!);
          if (anchorOwner.kind === "file") requireValue(sameFilesystemParent, "backup_capability_unavailable", "source-files-carrier-mount");
          stage(scan, "health");
          const after = anchorOwner.kind === "directory" ? profile.afterContent() : protocol.afterRoot;
          requireValue(after); observeAfter(after); await rootCurrent(); await parentCurrent();
          // D/Dp's only sync and all F checks have ended. Moving this exact
          // readable descriptor to A creates no open/dup and is not a close.
          tail.transferCarrier(anchorOwner.kind === "file" ? parent : anchorOwner);
          if (anchorOwner.kind === "file") parentTransferred = true;
          else {
            try { await parent.closeAsync(); }
            catch (error) { scan.closeErrors.push(error); scan.stage = "close"; throw error; }
            parentTransferred = true; // The old scope no longer owns a live Dp.
          }
          await held(scan);
        },
        async closeTail() {
          // Every root's ordinary R/V/F/D/Dp has now settled. Only the actual
          // metadata M and transferred A remain live for this final context.
          await held(scan); stage(scan, "health");
          const observed = profile.afterSourceClosed(tail), material = serial(observed);
          retain(scan, material); evidence.tail = material;
          requireValue(sameMetadata(anchor.metadata, observed.metadata)
            && same(serial(beforeContext.mount), serial(observed.mount))
            && same(healthMaterial(beforeContext.health), healthMaterial(observed.health)));
          await rootCurrent(); stage(scan, "close");
          try { await tail.closeAsync(); }
          catch (error) { scan.closeErrors.push(error); throw error; }
          await held(scan); bind(observed.runtimeEnvironmentDigest);
        },
      });
      // At most two source roots. Nest only their scopes, then finish every
      // ordinary owner before any tail; a shared D/Dp sync occurs once after
      // all selected children and all fresh directory checks have completed.
      continued = true; await next();
    }, expected);
    if (!parentTransferred) requireValue(same(serial(parentBefore), serial(parent.observe())));
  });
  stage(scan, "source-postcheck"); await current(scan);
  if (!continued) await next();
}
function persistentManifest(manifest: SourceFilesManifest): unknown {
  return { ...manifest, rootBindings: manifest.rootBindings.map(binding => {
    requireValue(binding.profile === PROFILE || binding.profile === SOURCE_PREPARE_PROFILE, "backup_capability_unavailable", "source-files-profile");
    const { runtimeEnvironmentDigest: _, ...stable } = binding.readEvidence;
    return { ...binding, readEvidence: stable };
  }) };
}
async function writeAttempt(scan: Scan, successful: boolean): Promise<void> {
  // Full per-entry window guards and root health stay private. Their retained
  // bytes share the traversal budget with Fs metadata; the final envelope is
  // also bounded before a buffer or diagnostic file is created.
  const encoded = canonicalJson({ formatVersion: 1, kind: "source-files-read-attempt", plan: scan.reference.immutablePlan,
    stages: scan.stages, roots: scan.rootsEvidence, entries: scan.entriesEvidence,
    tcutReached: scan.tcut, outcome: successful ? "pending-close" : "failed",
    objectsInspected: scan.count, contentBytes: String(scan.contentBytes), closeFailureCount: scan.closeErrors.length });
  requireValue(Buffer.byteLength(encoded) <= MAX_MANIFEST_BYTES, "backup_capability_unavailable", "source-files-budget");
  // Read-only verification retains and bounds the same complete envelope, but
  // never creates a diagnostic file or an attempt directory.
  if (!scan.attempt) return;
  const bytes = Buffer.from(encoded);
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
  existing?: ArtifactRef, mode: "record-attempt" | "read-only" = "record-attempt"): Promise<{ ref: ArtifactRef; manifest: SourceFilesManifest }> {
  const start = sourceFileObservationStart() ?? performance.now();
  const previous = failedSourceWindows.get(lock);
  if (previous) throw previous;
  let scan: Scan | undefined, result: { ref: ArtifactRef; manifest: SourceFilesManifest } | undefined;
  let failed = false, first: unknown;
  try {
    requireValue(mode !== "read-only" || existing !== undefined, "snapshot_invalid");
    scan = await initialScan(store, lock, mutex, reference, mode, start);
    let expected: SourceFilesManifest | undefined;
    if (existing) {
      requireValue(store.kindFor(existing) === "source-files" && existing.bytes.length <= 20
        && BigInt(existing.bytes) <= BigInt(MAX_MANIFEST_BYTES), "snapshot_invalid");
      expected = await readSourceFiles(scan.store, existing);
      requireValue(same(expected.source, scan.plan.source) && same(expected.roots, scan.plan.fileRoots), "source_changed");
      persistentManifest(expected);
      for (const binding of expected.rootBindings) {
        scan.expectedBindings.set(binding.sourceRoot, binding);
        if (binding.profile === SOURCE_PREPARE_PROFILE) scan.preparePolicy = true;
      }
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
    const currentScan = scan;
    const roots = async (index: number): Promise<void> => {
      const root = currentScan.plan.fileRoots[index];
      if (root) return scanRoot(currentScan, root, !existing, () => roots(index + 1));
      for (const window of currentScan.windows) await window.review();
      for (const window of currentScan.windows) await window.closeOrdinary();
      for (const window of currentScan.windows) await window.closeTail();
    };
    await roots(0);
    scan.bindings.sort((left, right) => currentScan.plan.fileRoots.findIndex(root => root.label === left.sourceRoot)
      - currentScan.plan.fileRoots.findIndex(root => root.label === right.sourceRoot));
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
    if (first instanceof SourceFilesFailure) {
      if (scan?.preparePolicy) failedSourceWindows.set(lock, first);
      throw first;
    }
    const closeErrors = scan?.closeErrors ?? [];
    if (first instanceof AggregateError) {
      closeErrors.push(...first.errors.slice(1)); first = first.errors[0];
    }
    const failure = new SourceFilesFailure(first, scan?.stage ?? "input", closeErrors, scan?.tcut ?? false);
    if (scan?.preparePolicy) failedSourceWindows.set(lock, failure);
    throw failure;
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

/** Fixed read-only consumer entry. It runs the same native/profile/content and
 * complete diagnostic budgets without creating attempts, payloads or permits.
 * The caller still owns the original native lock and outer source-client window. */
export async function verifyLiveSourceFilesReadOnly(store: ArtifactStore, lock: SourceLock, mutex: OperationMutex,
  plan: PersistedPlanRef, reference: ArtifactRef): Promise<void> {
  await run(store, lock, mutex, plan, reference, "read-only");
}

import { lstatSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MaintenanceFailure } from "./error.ts";

/** P0: immutable, read-only native FD facts. Not an Fs/provider qualification. */
export interface SourceFileMetadata {
  readonly kind: "file" | "directory";
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly uid: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly fsType: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

/** P1 raw Linux statx(AT_EMPTY_PATH) facts from the identical owned FD.
 * Null means the kernel omitted that mask bit, never an inferred value.
 * No FID, filesystem UUID, source health, or provider eligibility is issued. */
export interface SourceFileStatxObservation {
  readonly kind: "file" | "directory";
  readonly mask: bigint;
  readonly devMajor: bigint;
  readonly devMinor: bigint;
  readonly ino: bigint;
  readonly mountId: bigint | null;
  readonly birthtimeNs: bigint | null;
  readonly attributes: bigint;
  readonly attributesMask: bigint;
}
/** A separate STATX_MNT_ID_UNIQUE call; its ID must never be filled from
 * observeStatx()'s legacy mount namespace. */
export interface SourceFileUniqueStatxObservation extends Omit<SourceFileStatxObservation, "mountId"> {
  readonly uniqueMountId: bigint | null;
}

export interface SourceFileNativeCall {
  readonly operation: string;
  /** Null means this call was not made; errors retain actual rc and errno. */
  readonly rc: bigint | null;
  readonly errno: bigint | null;
}
export type SourceFileNativeFact<T> = {
  readonly status: "observed"; readonly reason: null; readonly value: T;
  readonly calls: readonly SourceFileNativeCall[];
} | {
  readonly status: "unavailable";
  readonly reason: "syscall" | "length" | "identity" | "budget" | "enumeration" | "abi";
  readonly value: null; readonly calls: readonly SourceFileNativeCall[];
};
export interface SourceFileExtendedMetadata extends SourceFileMetadata {
  readonly gid: bigint;
  readonly atimeNs: bigint;
}
/** P2 ordinary getters from one private live owner. Accessible xattrs are raw
 * bytes; unavailable/hidden facts are never filled in or promoted to a profile.
 * This is not an atomic source-preservation window or an Fs qualification. */
export interface SourceFileExtendedObservation {
  readonly before: SourceFileExtendedMetadata;
  readonly after: SourceFileExtendedMetadata;
  readonly metadataCalls: readonly SourceFileNativeCall[];
  readonly uuid: SourceFileNativeFact<{ readonly length: bigint; readonly bytes: Buffer }>;
  readonly fid: SourceFileNativeFact<{ readonly handleType: bigint; readonly handleBytes: bigint;
    readonly mountId: bigint; readonly bytes: Buffer }>;
  readonly inodeFlags: SourceFileNativeFact<bigint>;
  readonly xattrs: SourceFileNativeFact<readonly { readonly name: Buffer; readonly value: Buffer }[]>;
}
export const SOURCE_FILE_HEALTH_NAMES = Object.freeze([
  "errors_count", "first_error_errcode", "last_error_errcode", "first_error_ino", "last_error_ino",
  "first_error_block", "last_error_block", "first_error_line", "last_error_line", "first_error_time",
  "last_error_time", "first_error_func", "last_error_func",
] as const);
export type SourceFileHealthName = typeof SOURCE_FILE_HEALTH_NAMES[number];
export type SourceFileContextFact<T> = {
  readonly status: "observed"; readonly reason: null; readonly value: T;
  readonly calls: readonly SourceFileNativeCall[];
} | {
  readonly status: "unavailable";
  readonly reason: "syscall" | "length" | "identity" | "budget" | "enumeration" | "abi" | "binding" | "format" | "unsupported";
  readonly value: null; readonly calls: readonly SourceFileNativeCall[];
};
export interface SourceFileKernelReadValue {
  readonly bytes: Buffer;
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: bigint;
  readonly filesystemType: bigint;
}
export interface SourceFileRootInfo {
  readonly abiVersion: 1;
  readonly kind: SourceFileMetadata["kind"];
  readonly stage: "metadata-only" | "readable";
  readonly metadata: SourceFileExtendedMetadata;
}
export interface SourceFileNativeIdentity {
  readonly device: bigint; readonly inode: bigint; readonly mode: bigint; readonly filesystemType: bigint;
}
export interface SourceFileDeviceBinding {
  readonly sourceDevMajor: bigint; readonly sourceDevMinor: bigint;
  readonly sysfs: SourceFileNativeIdentity;
  readonly kernelName: Buffer; readonly resolved: Buffer; readonly sbId: Buffer;
}
export interface SourceFileHealthBinding {
  readonly sourceDevMajor: bigint; readonly sourceDevMinor: bigint;
  readonly device: SourceFileNativeIdentity; readonly health: SourceFileNativeIdentity; readonly sbId: Buffer;
}
export interface SourceFileDeviceGraphNode {
  readonly index: number; readonly major: bigint; readonly minor: bigint;
  readonly identity: SourceFileNativeIdentity; readonly kernelName: Buffer; readonly resolved: Buffer;
  readonly dev: SourceFileContextFact<SourceFileKernelReadValue>;
  readonly uevent: SourceFileContextFact<SourceFileKernelReadValue>;
  readonly partition: SourceFileContextFact<SourceFileKernelReadValue>;
  readonly backing: {
    readonly loopBackingFile: SourceFileContextFact<SourceFileKernelReadValue>;
    readonly dmName: SourceFileContextFact<SourceFileKernelReadValue>;
    readonly dmUuid: SourceFileContextFact<SourceFileKernelReadValue>;
  };
  readonly holders: readonly Buffer[]; readonly slaves: readonly Buffer[];
  readonly enumerationCalls: readonly SourceFileNativeCall[];
}
export interface SourceFileDeviceGraph {
  readonly nodes: readonly SourceFileDeviceGraphNode[];
  readonly edges: readonly { readonly kind: "parent" | "holder" | "slave"; readonly from: number; readonly to: number }[];
}
export interface SourceFileBlockAttributes {
  readonly readerRevision: 1;
  readonly sourceNodeIndex: 0;
  readonly size: SourceFileContextFact<SourceFileKernelReadValue>;
  readonly readOnly: SourceFileContextFact<SourceFileKernelReadValue>;
  readonly diskSequence: SourceFileContextFact<SourceFileKernelReadValue>;
}
export interface SourceFileRootEnvironment {
  readonly abiVersion: 2 | 3;
  readonly rootKind: SourceFileMetadata["kind"];
  readonly rootStage: SourceFileRootInfo["stage"];
  readonly source: {
    readonly before: SourceFileExtendedMetadata; readonly after: SourceFileExtendedMetadata;
    readonly metadataCalls: readonly SourceFileNativeCall[];
    readonly filesystemCarrier: { readonly role: "root" | "bootstrap-parent" | "tail-carrier";
      readonly before: SourceFileExtendedMetadata; readonly after: SourceFileExtendedMetadata;
      readonly mount?: { readonly before: { readonly legacyMountId: bigint; readonly uniqueMountId: bigint };
        readonly after: { readonly legacyMountId: bigint; readonly uniqueMountId: bigint } } };
    readonly carrierCalls: readonly SourceFileNativeCall[];
  };
  readonly process: {
    readonly identity: SourceFileContextFact<{ readonly pid: bigint; readonly tid: bigint;
      readonly uid: readonly bigint[]; readonly gid: readonly bigint[]; readonly groups: readonly bigint[]; readonly noNewPrivileges: bigint }>;
    readonly threadStatus: SourceFileContextFact<SourceFileKernelReadValue>;
    readonly processStat: SourceFileContextFact<SourceFileKernelReadValue>;
    readonly namespaces: SourceFileContextFact<Readonly<Record<"pid" | "mount" | "user", SourceFileKernelReadValue>>>;
  };
  readonly kernel: { readonly uname: SourceFileContextFact<Buffer>;
    readonly notes: SourceFileContextFact<SourceFileKernelReadValue>; readonly config: SourceFileContextFact<SourceFileKernelReadValue> };
  readonly mount: { readonly legacyStatx: SourceFileContextFact<Buffer>; readonly uniqueStatx: SourceFileContextFact<Buffer>;
    readonly statmount: SourceFileContextFact<{ readonly request: Buffer; readonly result: Buffer }>;
    readonly mountinfo: SourceFileContextFact<SourceFileKernelReadValue> };
  readonly configuration: { readonly tune: SourceFileContextFact<Buffer>;
    readonly options: SourceFileContextFact<SourceFileKernelReadValue>; readonly mbGroups: SourceFileContextFact<SourceFileKernelReadValue>;
    readonly mbStructsSummary: SourceFileContextFact<SourceFileKernelReadValue>;
    readonly journalTaskBefore: SourceFileContextFact<SourceFileKernelReadValue>;
    readonly journalIoprio: SourceFileContextFact<{ readonly which: bigint; readonly who: bigint; readonly rawValue: bigint }>;
    readonly journalTaskAfter: SourceFileContextFact<SourceFileKernelReadValue> };
  readonly device: { readonly binding: SourceFileContextFact<SourceFileDeviceBinding>;
    readonly dev: SourceFileContextFact<SourceFileKernelReadValue>; readonly uevent: SourceFileContextFact<SourceFileKernelReadValue>;
    readonly topology: SourceFileContextFact<SourceFileDeviceGraph>; readonly blockAttributes: SourceFileBlockAttributes };
  readonly health: { readonly binding: SourceFileContextFact<SourceFileHealthBinding>;
    readonly fields: readonly { readonly name: SourceFileHealthName; readonly fact: SourceFileContextFact<SourceFileKernelReadValue> }[] };
  readonly auxiliaryCalls: readonly SourceFileNativeCall[];
}
export interface SourceFileRootContext {
  readonly info: SourceFileRootInfo;
  readonly root: SourceFileExtendedObservation;
  readonly legacyStatx: SourceFileStatxObservation;
  readonly uniqueStatx: SourceFileUniqueStatxObservation;
  readonly environment: SourceFileRootEnvironment;
}
export interface SourceFileBootstrapContext {
  readonly info: SourceFileRootInfo;
  readonly environment: SourceFileRootEnvironment;
}

interface NativeSourceBinding {
  openRoot(path: string): object;
  rootInfo(owner: object): unknown;
  openRootContent(bootstrap: object): object;
  observeEnvironment(root: object): unknown;
  openChild(parent: object, leaf: string, kind: SourceFileMetadata["kind"]): object;
  observe(owner: object): unknown;
  observeStatx(owner: object): unknown;
  observeStatxUnique(owner: object): unknown;
  observeExtended(owner: object): unknown;
  readAt(owner: object, offset: bigint, length: number): unknown;
  readDirectory(owner: object): unknown;
  close(owner: object): void;
  reopenFile(owner: object): object;
  synchronize(owner: object): Promise<void>;
  closeAsync(owner: object): Promise<void>;
  closeUnstarted(owner: object): boolean;
  retainMetadata(owner: object): object;
  transferCarrier(metadata: object, carrier: object): void;
}
export interface SourceFileHandle {
  readonly kind: SourceFileMetadata["kind"];
  observe(): SourceFileMetadata;
  observeStatx(): SourceFileStatxObservation;
  observeStatxUnique(): SourceFileUniqueStatxObservation;
  observeExtended(): SourceFileExtendedObservation;
  openChild(leaf: string, kind: SourceFileMetadata["kind"]): SourceFileHandle;
  readAt(offset: bigint, length: number): Buffer;
  readDirectory(): readonly string[];
  close(): void;
  reopenFile(): SourceFileHandle;
  synchronize(): Promise<void>;
  closeAsync(): Promise<void>;
}
/** Private native provenance still applies: a copied object cannot acquire M/A. */
export interface SourceFileMetadataTail {
  transferCarrier(carrier: SourceFileHandle): void;
  observe(): SourceFileBootstrapContext;
  closeAsync(): Promise<void>;
}
/** A comparison with an already strictly decoded Fs. It can only reject a
 * fixed qualified profile; it cannot register, select or authorize one. */
export interface SourceFileExpectedProfile {
  readonly profile: string;
  readonly profileEntryDigest: string;
  readonly qualificationDigest: string;
}
interface SourceScope {
  readonly root: string;
  readonly binding: NativeSourceBinding;
  readonly opened: Set<OwnedSourceFile>;
  readonly failures: unknown[];
  active: boolean;
  readonly pending: Set<Promise<void>>;
  readonly tails: Set<SourceFileMetadataTail>;
}
interface SourceOwnerState {
  readonly owner: object;
  readonly scope: SourceScope;
  readonly kind: SourceFileMetadata["kind"];
  readonly root: boolean;
  bootstrap?: object;
  closed: boolean;
  pending?: Promise<void>;
  closing?: Promise<void>;
}
const sourceOwners = new WeakMap<object, SourceOwnerState>();
interface SourceBootstrapState {
  readonly owner: object;
  readonly scope: SourceScope;
  readonly initial: SourceFileRootInfo;
  attempted: boolean;
  closed: boolean;
  closeUnknown: boolean;
  promoted?: OwnedSourceFile;
}
const sourceBootstraps = new WeakMap<object, SourceBootstrapState>();
function activeOwner(handle: unknown, closing = false): SourceOwnerState {
  const state = handle && typeof handle === "object" ? sourceOwners.get(handle) : undefined;
  if (!state || !state.scope.active || state.closed || !closing && (state.scope.failures.length > 0 || state.pending || state.closing))
    throw new MaintenanceFailure("maintenance_lost", "source-file-owner");
  return state;
}
function activeRoot(handle: unknown): SourceOwnerState {
  const state = activeOwner(handle);
  if (!state.root) throw unavailable();
  if (state.bootstrap) {
    const bootstrap = sourceBootstraps.get(state.bootstrap);
    if (!bootstrap || !bootstrap.closed || bootstrap.closeUnknown || bootstrap.promoted !== handle)
      throw new MaintenanceFailure("maintenance_lost", "source-file-bootstrap");
  }
  return state;
}
function activeBootstrap(token: object): SourceBootstrapState {
  const state = sourceBootstraps.get(token);
  if (!state || !state.scope.active || state.closed || state.closeUnknown || state.scope.failures.length)
    throw new MaintenanceFailure("maintenance_lost", "source-file-bootstrap");
  return state;
}
const unavailable = () => new MaintenanceFailure("backup_capability_unavailable", "source-file-native");
const sourceChanged = () => new MaintenanceFailure("source_changed", "source-file-native");
const invalidContext = () => new MaintenanceFailure("backup_capability_unavailable", "source-file-context-abi");
export const sourceFileNativePath = path.join(
  fileURLToPath(new URL("../../../../", import.meta.url)), "build", "maintenance-platform",
  "maintenance-source-files-linux-" + process.arch + ".node",
);
let cached: NativeSourceBinding | undefined;
function binding(): NativeSourceBinding {
  if (process.platform !== "linux" || Number(process.versions.napi) < 8 ||
    typeof process.getuid !== "function") throw unavailable();
  if (cached) return cached;
  let stats;
  try { stats = lstatSync(sourceFileNativePath); } catch { throw unavailable(); }
  if (!stats.isFile() || stats.nlink !== 1 || stats.uid !== process.getuid() ||
    (stats.mode & 0o7777) !== 0o700) throw unavailable();
  let native: NativeSourceBinding;
  try { native = createRequire(import.meta.url)(sourceFileNativePath) as NativeSourceBinding; }
  catch { throw unavailable(); }
  for (const method of ["openRoot", "rootInfo", "openRootContent", "observeEnvironment", "openChild", "observe",
    "observeStatx", "observeStatxUnique", "observeExtended", "readAt", "readDirectory", "close",
    "reopenFile", "synchronize", "closeAsync", "closeUnstarted", "retainMetadata", "transferCarrier"] as const) {
    if (typeof native[method] !== "function") throw unavailable();
  }
  cached = native;
  return native;
}
function checkedObservation(value: unknown, kind: SourceFileMetadata["kind"]): SourceFileMetadata {
  if (!value || typeof value !== "object" || (value as { kind?: unknown }).kind !== kind) throw sourceChanged();
  const fields = ["dev", "ino", "mode", "uid", "nlink", "size", "fsType", "mtimeNs", "ctimeNs"] as const;
  const candidate = value as unknown as Record<(typeof fields)[number], unknown>;
  if (!fields.every(name => typeof candidate[name] === "bigint")) throw sourceChanged();
  return value as SourceFileMetadata;
}
function checkedStatxFields(value: unknown, kind: SourceFileMetadata["kind"], unique: boolean): Record<string, unknown> {
  const item = object(value), id = unique ? "uniqueMountId" : "mountId", flag = unique ? 0x4000n : 0x1000n;
  if (item.kind !== kind || Object.keys(item).sort().join() !==
    ["kind", "mask", "devMajor", "devMinor", "ino", "attributes", "attributesMask", "birthtimeNs", id].sort().join()) throw sourceChanged();
  for (const key of ["mask", "devMajor", "devMinor", "ino", "attributes", "attributesMask"] as const) {
    if (typeof item[key] !== "bigint" || item[key] < 0n || item[key] > 0xffffffffffffffffn) throw sourceChanged();
  }
  const mask = item.mask as bigint;
  if ((mask & 0x7ffn) !== 0x7ffn || mask > 0xffffffffn || (item.devMajor as bigint) > 0xffffffffn
    || (item.devMinor as bigint) > 0xffffffffn || (item.ino as bigint) <= 0n
    || ((item.attributes as bigint) & ~(item.attributesMask as bigint)) !== 0n
    || (item[id] !== null && (typeof item[id] !== "bigint" || item[id] <= 0n || item[id] > 0xffffffffffffffffn))
    || (item.birthtimeNs !== null && typeof item.birthtimeNs !== "bigint")
    || ((mask & flag) !== 0n) !== (item[id] !== null)
    || ((mask & 0x800n) !== 0n) !== (item.birthtimeNs !== null)) throw sourceChanged();
  return Object.freeze({ ...item });
}
function checkedStatx(value: unknown, kind: SourceFileMetadata["kind"]): SourceFileStatxObservation {
  return checkedStatxFields(value, kind, false) as unknown as SourceFileStatxObservation;
}
function checkedUniqueStatx(value: unknown, kind: SourceFileMetadata["kind"]): SourceFileUniqueStatxObservation {
  return checkedStatxFields(value, kind, true) as unknown as SourceFileUniqueStatxObservation;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw sourceChanged();
  return value as Record<string, unknown>;
}
function exactObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidContext();
  const item = value as Record<string, unknown>;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(item)) || Reflect.ownKeys(item).length !== fields.length
    || Object.keys(item).sort().join() !== [...fields].sort().join()
    || fields.some(key => !("value" in Object.getOwnPropertyDescriptor(item, key)!))) throw invalidContext();
  return item;
}
const metadataFields = ["kind", "dev", "ino", "mode", "uid", "gid", "nlink", "size", "fsType", "atimeNs", "mtimeNs", "ctimeNs"] as const;
function checkedExtendedMetadata(value: unknown, kind: SourceFileMetadata["kind"]): SourceFileExtendedMetadata {
  const item = exactObject(value, metadataFields);
  if (item.kind !== kind) throw invalidContext();
  for (const key of metadataFields) {
    if (key === "kind") continue;
    if (typeof item[key] !== "bigint" || item[key] < (key.endsWith("Ns") ? -0x8000000000000000n : 0n)
      || item[key] > (key.endsWith("Ns") ? 0x7fffffffffffffffn : 0xffffffffffffffffn)) throw invalidContext();
  }
  if (((item.mode as bigint) & 0o170000n) !== (kind === "directory" ? 0o040000n : 0o100000n)
    || (item.ino as bigint) < 1n || (item.nlink as bigint) < 1n) throw invalidContext();
  return Object.freeze({ ...item }) as unknown as SourceFileExtendedMetadata;
}
function sameMetadata(left: SourceFileExtendedMetadata, right: SourceFileExtendedMetadata): boolean {
  return metadataFields.every(key => left[key] === right[key]);
}
function checkedRootInfo(value: unknown, tail = false): SourceFileRootInfo {
  const item = exactObject(value, ["abiVersion", "kind", "stage", "metadata"]);
  if (item.abiVersion !== 1 || item.kind !== "file" && item.kind !== "directory"
    || item.stage !== "metadata-only" && item.stage !== "readable"
    || !tail && item.kind === "directory" && item.stage !== "readable") throw invalidContext();
  return Object.freeze({ abiVersion: 1, kind: item.kind, stage: item.stage,
    metadata: checkedExtendedMetadata(item.metadata, item.kind) });
}
function checkedCalls(value: unknown, operations: readonly string[]): readonly SourceFileNativeCall[] {
  if (!Array.isArray(value) || value.length !== operations.length) throw sourceChanged();
  for (let i = 0; i < value.length; i++) {
    const call = object(value[i]);
    if (call.operation !== operations[i] || Object.keys(call).sort().join() !== "errno,operation,rc") throw sourceChanged();
    if (call.rc === null) { if (call.errno !== null) throw sourceChanged(); }
    else if (typeof call.rc !== "bigint" || call.rc < -1n || typeof call.errno !== "bigint" || call.errno < 0n
      || (call.rc === -1n ? call.errno === 0n : call.errno !== 0n)) throw sourceChanged();
  }
  return Object.freeze((value as SourceFileNativeCall[]).map(call => Object.freeze({ ...call })));
}
function checkedContextCalls(value: unknown, operations: readonly string[]): readonly SourceFileNativeCall[] {
  if (!Array.isArray(value)) throw invalidContext();
  for (const call of value) exactObject(call, ["operation", "rc", "errno"]);
  try { return checkedCalls(value, operations); }
  catch { throw invalidContext(); }
}
const contextReasons = ["syscall", "length", "identity", "budget", "enumeration", "abi", "binding", "format", "unsupported"] as const;
function checkedContextFact<T>(value: unknown, operations: readonly string[], decode: (value: unknown) => T): SourceFileContextFact<T> {
  const item = exactObject(value, ["status", "reason", "value", "calls"]);
  const calls = checkedContextCalls(item.calls, operations);
  if (item.status === "observed") {
    if (item.reason !== null || !calls.every(call => call.rc !== null && call.rc >= 0n && call.errno === 0n)) throw invalidContext();
    return Object.freeze({ status: "observed", reason: null, value: decode(item.value), calls });
  }
  if (item.status !== "unavailable" || item.value !== null || typeof item.reason !== "string"
    || !contextReasons.some(reason => reason === item.reason)) throw invalidContext();
  return Object.freeze({ status: "unavailable", reason: item.reason as typeof contextReasons[number], value: null, calls });
}
function checkedKernelReadValue(value: unknown, limit: number): SourceFileKernelReadValue {
  const item = exactObject(value, ["bytes", "device", "inode", "mode", "filesystemType"]);
  if (!Buffer.isBuffer(item.bytes) || item.bytes.length > limit) throw invalidContext();
  for (const key of ["device", "inode", "mode", "filesystemType"] as const)
    if (typeof item[key] !== "bigint" || item[key] < 0n || item[key] > 0xffffffffffffffffn) throw invalidContext();
  if ((item.inode as bigint) < 1n || ((item.mode as bigint) & 0o170000n) !== 0o100000n) throw invalidContext();
  return Object.freeze({ bytes: Buffer.from(item.bytes), device: item.device as bigint, inode: item.inode as bigint,
    mode: item.mode as bigint, filesystemType: item.filesystemType as bigint });
}
function checkedKernelReadFact(value: unknown, limit: number, samples: 1 | 2 = 1): SourceFileContextFact<SourceFileKernelReadValue> {
  return checkedReadFact(value, limit, samples, ["open-kernel-read", "fstat-kernel-before", "fstatfs-kernel-before",
    "read-kernel", "fstatfs-kernel-after", "fstat-kernel-after", "close-kernel-read"]);
}
function checkedReadFact(value: unknown, limit: number, samples: 1 | 2, template: readonly string[]): SourceFileContextFact<SourceFileKernelReadValue> {
  const item = exactObject(value, ["status", "reason", "value", "calls"]);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1048576 || samples !== 1 && samples !== 2 || !Array.isArray(item.calls)
    || item.calls.length < 7 * samples || item.calls.length > 256 + 7 * samples) throw invalidContext();
  const rawOperations = item.calls.map(raw => exactObject(raw, ["operation", "rc", "errno"]).operation);
  const operations: string[] = [], lengths: number[] = [];
  let offset = 0;
  for (let phase = 0; phase < samples; phase++) {
    const suffix = phase ? "-after" : "", end = rawOperations.indexOf(`${template[6]}${suffix}`, offset);
    const reads = end - offset - 5;
    if (reads < 1 || reads > 257) throw invalidContext();
    const stage = [...template.slice(0, 3), ...Array<string>(reads).fill(template[3]!), ...template.slice(4)];
    operations.push(...stage.map(operation => operation + suffix)); lengths.push(stage.length); offset = end + 1;
  }
  const fact = checkedContextFact(value, operations, raw => checkedKernelReadValue(raw, limit));
  offset = 0;
  let actualReads = 0;
  for (const length of lengths) {
    const calls = fact.calls.slice(offset, offset + length); offset += length;
    const open = calls[0]!, close = calls.at(-1)!, readCalls = calls.slice(3, -3);
    actualReads += readCalls.filter(call => call.rc !== null).length;
    if (actualReads > 256) throw invalidContext();
    if (open.rc === null || open.rc === -1n) {
      if (fact.status === "observed" || calls.slice(1).some(call => call.rc !== null)) throw invalidContext();
      continue;
    }
    if (close.rc === null || ![0n, -1n].includes(close.rc)
      || calls.at(-3)!.rc === null || calls.at(-2)!.rc === null) throw invalidContext();
    for (const index of [1, 2, calls.length - 3, calls.length - 2]) {
      const rc = calls[index]!.rc;
      if (rc !== null && rc !== 0n && rc !== -1n) throw invalidContext();
    }
    let ended = false, total = 0n;
    for (const call of readCalls) {
      if (ended && call.rc !== null) throw invalidContext();
      if (call.rc === null || call.rc <= 0n) ended = true;
      else {
        if (call.rc > BigInt(limit + 1)) throw invalidContext();
        total += call.rc;
      }
    }
    // The common value must account for each complete phase independently.
    // Its length is not the sum of the two observations of the same object.
    if (fact.status === "observed" && (readCalls.at(-1)!.rc !== 0n
      || readCalls.slice(0, -1).some(call => call.rc === null || call.rc <= 0n)
      || close.rc !== 0n || total !== BigInt(fact.value.bytes.length))) throw invalidContext();
  }
  return fact;
}
function unsigned(value: unknown, maximum = 0xffffffffffffffffn, minimum = 0n): bigint {
  if (typeof value !== "bigint" || value < minimum || value > maximum) throw invalidContext();
  return value;
}
function copiedBytes(value: unknown, minimum: number, maximum = minimum): Buffer {
  if (!Buffer.isBuffer(value) || value.length < minimum || value.length > maximum) throw invalidContext();
  return Buffer.from(value);
}
function checkedIdentity(value: unknown, filesystemType: bigint, mode: bigint): SourceFileNativeIdentity {
  const item = exactObject(value, ["device", "inode", "mode", "filesystemType"]);
  const identity = { device: unsigned(item.device), inode: unsigned(item.inode, 0xffffffffffffffffn, 1n),
    mode: unsigned(item.mode, 0xffffffffn), filesystemType: unsigned(item.filesystemType) };
  if (identity.filesystemType !== filesystemType || (identity.mode & 0o170000n) !== mode) throw invalidContext();
  return Object.freeze(identity);
}
function asciiName(value: unknown, maximum = 255): Buffer {
  const bytes = copiedBytes(value, 1, maximum);
  if (!/^[A-Za-z0-9_.-]+$/.test(bytes.toString("ascii")) || bytes.some(byte => byte > 0x7f)
    || bytes.equals(Buffer.from(".")) || bytes.equals(Buffer.from(".."))) throw invalidContext();
  return bytes;
}
function resolvedDevice(value: unknown, name: Buffer): Buffer {
  const bytes = copiedBytes(value, 1, 4096);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw invalidContext(); }
  if (text.includes("\0") || !text.startsWith("/sys/devices/") || text.split("/").slice(1).some(part => !part || part === "." || part === "..")
    || !Buffer.from(text).equals(bytes) || path.posix.basename(text) !== name.toString("ascii")) throw invalidContext();
  return bytes;
}
function onlyZeroCalls(fact: SourceFileContextFact<unknown>): void {
  if (fact.status === "observed" && fact.calls.some(call => call.rc !== 0n)) throw invalidContext();
}
const namespaceOperations = ["", "-after"].flatMap(suffix => ["pid", "mount", "user"].flatMap(kind =>
  ["open", "fstat", "fstatfs", "readlink", "close"].map(operation => `${operation}-namespace-${kind}${suffix}`)));
function checkedNamespaces(value: unknown): SourceFileRootEnvironment["process"]["namespaces"] {
  const fact = checkedContextFact(value, namespaceOperations, raw => {
    const row = exactObject(raw, ["pid", "mount", "user"]);
    return Object.freeze(Object.fromEntries((["pid", "mount", "user"] as const).map(kind => {
      const node = exactObject(row[kind], ["device", "inode", "mode", "filesystemType", "bytes"]);
      const identity = checkedIdentity({ device: node.device, inode: node.inode, mode: node.mode,
        filesystemType: node.filesystemType }, 0x6e736673n, 0o100000n);
      const bytes = copiedBytes(node.bytes, 1, 4096), label = kind === "mount" ? "mnt" : kind;
      if (!bytes.equals(Buffer.from(`${label}:[${identity.inode}]`, "ascii"))) throw invalidContext();
      return [kind, Object.freeze({ ...identity, bytes })];
    }))) as Readonly<Record<"pid" | "mount" | "user", SourceFileKernelReadValue>>;
  });
  for (let i = 0; i < namespaceOperations.length; i += 5) {
    const calls = fact.calls.slice(i, i + 5), open = calls[0]!;
    if (open.rc === null || open.rc === -1n) {
      if (calls.slice(1).some(call => call.rc !== null)) throw invalidContext();
    } else if (calls[4]!.rc === null) throw invalidContext();
    if (fact.status === "observed") {
      const kind = (["pid", "mount", "user"] as const)[(i / 5) % 3]!;
      if (calls[1]!.rc !== 0n || calls[2]!.rc !== 0n || calls[4]!.rc !== 0n
        || calls[3]!.rc !== BigInt(fact.value[kind].bytes.length)) throw invalidContext();
    }
  }
  return fact;
}
function checkedProcessIdentity(value: unknown): SourceFileRootEnvironment["process"]["identity"] {
  const fact = checkedContextFact(value, ["getpid", "gettid", "getresuid", "getresgid", "getgroups-count", "getgroups",
    "prctl-get-no-new-privs", "getresuid-after", "getresgid-after", "getgroups-count-after", "getgroups-after", "prctl-get-no-new-privs-after"], raw => {
    const row = exactObject(raw, ["pid", "tid", "uid", "gid", "groups", "noNewPrivileges"]);
    function ids(value: unknown, length?: number): readonly bigint[] {
      if (!Array.isArray(value) || value.length > 256 || length !== undefined && value.length !== length) throw invalidContext();
      return Object.freeze(value.map(entry => unsigned(entry, 0xffffffffn)));
    }
    return Object.freeze({ pid: unsigned(row.pid, 0x7fffffffn, 1n), tid: unsigned(row.tid, 0x7fffffffn, 1n),
      uid: ids(row.uid, 4), gid: ids(row.gid, 4), groups: ids(row.groups), noNewPrivileges: unsigned(row.noNewPrivileges, 1n) });
  });
  if (fact.status === "observed") {
    const expected = [fact.value.pid, fact.value.tid, 0n, 0n, BigInt(fact.value.groups.length), BigInt(fact.value.groups.length),
      fact.value.noNewPrivileges, 0n, 0n, BigInt(fact.value.groups.length), BigInt(fact.value.groups.length), fact.value.noNewPrivileges];
    if (fact.calls.some((call, index) => call.rc !== expected[index])) throw invalidContext();
  }
  return fact;
}
const blockReaders = [
  { field: "size", label: "block-size" },
  { field: "readOnly", label: "block-ro" },
  { field: "diskSequence", label: "block-diskseq" },
] as const;
type BlockLabel = typeof blockReaders[number]["label"];
const blockReadTemplate = (label: BlockLabel): readonly string[] => [
  `open-${label}`, `fstat-${label}-before`, `fstatfs-${label}-before`, `read-${label}`,
  `fstatfs-${label}-after`, `fstat-${label}-after`, `close-${label}`,
];
// This finite table distinguishes the before phase's post-stat from the
// after phase. A suffix/prefix heuristic would confuse their ownership.
const blockOperations = new Map(blockReaders.flatMap(({ label }) => ["", "-after"].flatMap(suffix =>
  blockReadTemplate(label).map(operation => [operation + suffix, label + suffix] as const))));
const blockReadCalls = new Set(blockReaders.flatMap(({ label }) => [`read-${label}`, `read-${label}-after`]));
function denseDataArray(value: unknown, maximum: number): asserts value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) throw invalidContext();
  for (let index = 0; index < value.length; index++)
    if (!Object.getOwnPropertyDescriptor(value, String(index))?.hasOwnProperty("value")) throw invalidContext();
}
const kernelReadOperations = new Set(["open-kernel-read", "fstat-kernel-before", "fstatfs-kernel-before", "read-kernel",
  "fstatfs-kernel-after", "fstat-kernel-after", "close-kernel-read"]);
function auxiliaryResource(operation: string): string | null {
  const block = blockOperations.get(operation);
  if (block !== undefined) return block;
  if (kernelReadOperations.has(operation)) return "kernel-read";
  if (operation.endsWith("-after") && kernelReadOperations.has(operation.slice(0, -6))) return "kernel-read-after";
  let match = /^(?:open|fstat|fstatfs|readlink|close)-(namespace-(?:pid|mount|user)(?:-after)?)$/.exec(operation);
  if (match) return match[1]!;
  match = /^(?:open|fstat|fstatfs|close)-(proc-root|sysfs-root)$/.exec(operation);
  if (match) return match[1]!;
  match = /^(?:open|close)-(health-directory|ext4-proc-directory)$/.exec(operation)
    ?? /^(?:fstat|fstatfs)-(health-directory|ext4-proc-directory)-(?:before|after)$/.exec(operation);
  if (match) return match[1]!;
  match = /^stat-(health-directory|ext4-proc-directory)-link-after$/.exec(operation);
  if (match) return match[1]!;
  match = /^(?:open|readlink|close)-(device-node-(?:[0-9]|[1-5][0-9]|6[0-3]))$/.exec(operation)
    ?? /^readlink-(device-node-(?:[0-9]|[1-5][0-9]|6[0-3]))-after$/.exec(operation)
    ?? /^(?:fstat|fstatfs)-(device-node-(?:[0-9]|[1-5][0-9]|6[0-3]))-(?:before|after)$/.exec(operation);
  if (match) return match[1]!;
  for (const suffix of ["", "-after"]) {
    if (suffix && !operation.endsWith(suffix)) continue;
    const original = suffix ? operation.slice(0, -suffix.length) : operation;
    match = /^(?:open|getdents|close)-((?:holders|slaves|partitions)-(?:[0-9]|[1-5][0-9]|6[0-3]))$/.exec(original)
      ?? /^(?:fstat|fstatfs)-((?:holders|slaves|partitions)-(?:[0-9]|[1-5][0-9]|6[0-3]))-(?:before|after)$/.exec(original);
    if (match) return match[1]! + suffix;
  }
  match = /^stat-partition-entry-([0-9]|[1-5][0-9]|6[0-3])(?:-after)?$/.exec(operation);
  if (match) return `device-node-${match[1]}`;
  match = /^stat-device-link-([0-9]|[1-5][0-9]|6[0-3])(?:-after)?$/.exec(operation);
  return match ? `device-node-${match[1]}` : null;
}
function checkedAuxiliaryCalls(value: unknown, complete = false, unavailableGraph = false): readonly SourceFileNativeCall[] {
  if (!Array.isArray(value) || value.length > 32768) throw invalidContext();
  if (complete) denseDataArray(value, 32768);
  const operations = value.map(raw => {
    const item = exactObject(raw, ["operation", "rc", "errno"]);
    if (item.operation === "enumerate-device-graph" && unavailableGraph) {
      if (item.rc !== null || item.errno !== null) throw invalidContext();
      return item.operation;
    }
    if (typeof item.operation !== "string" || auxiliaryResource(item.operation) === null) throw invalidContext();
    return item.operation;
  });
  const calls = checkedContextCalls(value, operations);
  if (operations.filter(operation => operation === "enumerate-device-graph").length > 1) throw invalidContext();
  if (!complete) return calls;
  const opened = new Map<string, bigint>();
  const firstBlock = calls.findIndex(call => blockOperations.has(call.operation) && call.rc !== null);
  const lastBlock = calls.findLastIndex(call => blockOperations.has(call.operation) && call.rc !== null);
  let bytes = 0n;
  for (const [index, call] of calls.entries()) {
    if (call.operation === "enumerate-device-graph") continue; // Fixed null/null diagnostic; it owns no FD.
    const resource = auxiliaryResource(call.operation)!;
    if (blockOperations.has(call.operation) && call.rc !== null
      && (!opened.has("sysfs-root") || !opened.has("device-node-0"))) throw invalidContext();
    if (index > firstBlock && index < lastBlock && call.rc !== null
      && ["open-sysfs-root", "close-sysfs-root", "open-device-node-0", "close-device-node-0"].includes(call.operation)) throw invalidContext();
    if (call.operation.startsWith("open-")) {
      if (call.rc !== null && call.rc >= 0n) {
        if (call.rc > 0x7fffffffn || opened.has(resource) || [...opened.values()].includes(call.rc)) throw invalidContext();
        opened.set(resource, call.rc);
      }
    } else if (call.operation.startsWith("close-")) {
      if (opened.has(resource)) {
        if (call.rc !== 0n && call.rc !== -1n) throw invalidContext();
        opened.delete(resource);
      } else if (call.rc !== null) throw invalidContext();
    } else if (call.rc !== null && !opened.has(resource)) throw invalidContext();
    if (call.operation.startsWith("stat-device-link-") && call.rc !== null && !opened.has("sysfs-root")) throw invalidContext();
    if (call.operation === "stat-health-directory-link-after" && call.rc !== null && !opened.has("sysfs-root")
      || call.operation === "stat-ext4-proc-directory-link-after" && call.rc !== null && !opened.has("proc-root")) throw invalidContext();
    if ((/^read-kernel(?:-after)?$/.test(call.operation) || blockReadCalls.has(call.operation)
      || call.operation.startsWith("readlink-") || call.operation.startsWith("getdents-"))
      && call.rc !== null && call.rc > 0n) bytes += call.rc;
    if (bytes > 2097152n) throw invalidContext();
  }
  if (opened.size) throw invalidContext();
  return calls;
}
function checkedBlockAttributes(value: unknown, source: SourceFileExtendedMetadata,
  device: Pick<SourceFileRootEnvironment["device"], "binding" | "dev" | "topology">,
  auxiliary: readonly SourceFileNativeCall[]): SourceFileBlockAttributes {
  const item = exactObject(value, ["readerRevision", "sourceNodeIndex", "size", "readOnly", "diskSequence"]);
  if (item.readerRevision !== 1 || item.sourceNodeIndex !== 0) throw invalidContext();
  const phases: SourceFileNativeCall[][] = [[], []];
  const fields = blockReaders.map(({ field, label }) => {
    const raw = exactObject(item[field], ["status", "reason", "value", "calls"]);
    denseDataArray(raw.calls, 270);
    const fact = checkedReadFact(raw, 4096, 2, blockReadTemplate(label));
    if (fact.status === "unavailable" && !["syscall", "length", "binding", "budget", "format"].includes(fact.reason)) throw invalidContext();
    const split = fact.calls.findIndex(call => call.operation === `open-${label}-after`);
    const samples = [fact.calls.slice(0, split), fact.calls.slice(split)];
    const lengths: bigint[] = [];
    for (const [phase, calls] of samples.entries()) {
      const reads = calls.slice(3, -3);
      if (reads.every(call => call.rc === null) && reads.length !== 1
        || reads.some(call => call.rc === null) && reads.some(call => call.rc !== null)) throw invalidContext();
      if ((calls[0]!.rc === null || calls[0]!.rc === -1n) && calls.length !== 7) throw invalidContext();
      if (fact.status === "unavailable" && fact.reason === "format") {
        if (calls.some(call => call.rc === null || call.rc < 0n) || reads.at(-1)!.rc !== 0n
          || reads.slice(0, -1).some(call => call.rc! <= 0n)
          || [1, 2, calls.length - 3, calls.length - 2, calls.length - 1].some(index => calls[index]!.rc !== 0n)) throw invalidContext();
        const total = reads.reduce((sum, call) => sum + call.rc!, 0n);
        if (total > 4096n) throw invalidContext();
        lengths.push(total);
      }
      phases[phase]!.push(...calls);
    }
    if (lengths.length === 2 && lengths[0] !== lengths[1]) throw invalidContext();
    if (fact.status === "unavailable" && fact.reason === "syscall" && !fact.calls.some(call => call.rc === -1n)) throw invalidContext();
    if (fact.status === "observed") {
      const bytes = fact.value.bytes, text = bytes.toString("ascii");
      if (fact.value.filesystemType !== 0x62656572n || bytes.some(byte => byte > 0x7f)
        || (field === "readOnly" ? text !== "0\n" && text !== "1\n" : bytes.length > 21
          || !/^(0|[1-9][0-9]*)\n$/.test(text) || BigInt(text.slice(0, -1)) > 0xffffffffffffffffn)) throw invalidContext();
    }
    return [field, fact] as const;
  });
  const expected = phases.flat(), actual = auxiliary.filter(call => blockOperations.has(call.operation));
  if (expected.length !== actual.length || expected.some((call, index) => call.operation !== actual[index]!.operation
    || call.rc !== actual[index]!.rc || call.errno !== actual[index]!.errno)) throw invalidContext();
  if (fields.some(([, fact]) => fact.status === "observed")) {
    if (device.binding.status !== "observed" || device.dev.status !== "observed") throw invalidContext();
    const binding = device.binding.value, major = ((source.dev >> 8n) & 0xfffn) | ((source.dev >> 32n) & 0xfffff000n);
    const minor = (source.dev & 0xffn) | ((source.dev >> 12n) & 0xffffff00n);
    if (binding.sourceDevMajor !== major || binding.sourceDevMinor !== minor
      || !device.dev.value.bytes.equals(Buffer.from(`${major}:${minor}\n`))
      || device.dev.value.device !== binding.sysfs.device
      || fields.some(([, fact]) => fact.status === "observed" && fact.value.device !== binding.sysfs.device)) throw sourceChanged();
    if (device.topology.status === "observed") {
      const node = device.topology.value.nodes[0];
      if (!node || node.index !== 0 || node.major !== major || node.minor !== minor
        || ["device", "inode", "mode", "filesystemType"].some(key => node.identity[key as keyof SourceFileNativeIdentity]
          !== binding.sysfs[key as keyof SourceFileNativeIdentity]) || !node.kernelName.equals(binding.kernelName)
        || !node.resolved.equals(binding.resolved) || !node.kernelName.equals(binding.sbId)
        || node.dev.status !== "observed" || !node.dev.value.bytes.equals(device.dev.value.bytes)) throw sourceChanged();
    }
    const scope = auxiliary.filter(call => deviceScopeOperations(0).includes(call.operation));
    if (scope.length !== device.binding.calls.length || scope.some((call, index) => call.operation !== device.binding.calls[index]!.operation
      || call.rc !== device.binding.calls[index]!.rc || call.errno !== device.binding.calls[index]!.errno)) throw invalidContext();
  }
  return Object.freeze({ readerRevision: 1, sourceNodeIndex: 0, ...Object.fromEntries(fields) }) as SourceFileBlockAttributes;
}
const deviceScopeOperations = (index: number) => [`open-device-node-${index}`, `fstat-device-node-${index}-before`,
  `fstatfs-device-node-${index}-before`, `readlink-device-node-${index}`, `fstat-device-node-${index}-after`,
  `fstatfs-device-node-${index}-after`, `readlink-device-node-${index}-after`, `close-device-node-${index}`];
const healthScopeOperations = ["open-health-directory", "fstat-health-directory-before", "fstatfs-health-directory-before",
  "fstat-health-directory-after", "fstatfs-health-directory-after", "stat-health-directory-link-after", "close-health-directory"];
function checkedDeviceBinding(value: unknown): SourceFileContextFact<SourceFileDeviceBinding> {
  const fact = checkedContextFact(value, deviceScopeOperations(0), raw => {
    const row = exactObject(raw, ["sourceDevMajor", "sourceDevMinor", "sysfs", "kernelName", "resolved", "sbId"]);
    const kernelName = asciiName(row.kernelName);
    return Object.freeze({ sourceDevMajor: unsigned(row.sourceDevMajor, 0xffffffffn), sourceDevMinor: unsigned(row.sourceDevMinor, 0xffffffffn),
      sysfs: checkedIdentity(row.sysfs, 0x62656572n, 0o040000n), kernelName, resolved: resolvedDevice(row.resolved, kernelName), sbId: asciiName(row.sbId, 31) });
  });
  if (fact.status === "observed" && (fact.calls[3]!.rc !== BigInt(fact.value.resolved.length)
    || fact.calls[6]!.rc !== BigInt(fact.value.resolved.length)
    || [1, 2, 4, 5, 7].some(index => fact.calls[index]!.rc !== 0n))) throw invalidContext();
  return fact;
}
function checkedHealthBinding(value: unknown): SourceFileContextFact<SourceFileHealthBinding> {
  const fact = checkedContextFact(value, healthScopeOperations, raw => {
    const row = exactObject(raw, ["sourceDevMajor", "sourceDevMinor", "device", "health", "sbId"]);
    return Object.freeze({ sourceDevMajor: unsigned(row.sourceDevMajor, 0xffffffffn), sourceDevMinor: unsigned(row.sourceDevMinor, 0xffffffffn),
      device: checkedIdentity(row.device, 0x62656572n, 0o040000n), health: checkedIdentity(row.health, 0x62656572n, 0o040000n), sbId: asciiName(row.sbId, 31) });
  });
  if (fact.status === "observed" && fact.calls.slice(1).some(call => call.rc !== 0n)) throw invalidContext();
  return fact;
}
function kernelAbsent(fact: SourceFileContextFact<SourceFileKernelReadValue>): boolean {
  return fact.status === "unavailable" && fact.reason === "syscall" && fact.calls.length === 14
    && [0, 7].every(index => fact.calls[index]!.rc === -1n && fact.calls[index]!.errno === 2n
      && fact.calls.slice(index + 1, index + 7).every(call => call.rc === null));
}
function checkedEnumeration(value: unknown, index: number): readonly SourceFileNativeCall[] {
  const calls = checkedAuxiliaryCalls(value);
  const partition = `stat-partition-entry-${index}`, link = `stat-device-link-${index}`;
  if (!Number.isSafeInteger(index) || index < 0 || index > 63
    || calls.some(call => call.rc === null || call.rc < 0n
      && (![partition, `${partition}-after`].includes(call.operation) || call.errno !== 2n))) throw invalidContext();
  const readCounts = new Map<string, number>();
  let offset = 0;
  for (const suffix of ["", "-after"]) {
    for (const kind of ["holders", "slaves", "partitions"]) {
      const resource = `${kind}-${index}`, end = calls.findIndex((call, position) => position >= offset && call.operation === `close-${resource}${suffix}`);
      if (end < offset + 6) throw invalidContext();
      const rows = calls.slice(offset, end + 1), reads = rows.slice(3, -3);
      const expected = [`open-${resource}`, `fstat-${resource}-before`, `fstatfs-${resource}-before`,
        ...Array<string>(reads.length).fill(`getdents-${resource}`), `fstat-${resource}-after`, `fstatfs-${resource}-after`, `close-${resource}`];
      if (rows.some((call, position) => call.operation !== expected[position]! + suffix)
        || reads.at(-1)!.rc !== 0n || reads.slice(0, -1).some(call => call.rc! <= 0n)
        || [rows[1], rows[2], ...rows.slice(-3)].some(call => call!.rc !== 0n)) throw invalidContext();
      const actualReads = (readCounts.get(kind) ?? 0) + reads.filter(call => call.rc !== null).length;
      if (actualReads > 256) throw invalidContext();
      readCounts.set(kind, actualReads); offset = end + 1;
    }
    if (!suffix) while (offset < calls.length && [partition, link].includes(calls[offset]!.operation)) {
      const call = calls[offset++]!;
      if (call.rc !== 0n && (call.operation !== partition || call.rc !== -1n || call.errno !== 2n)) throw invalidContext();
    }
  }
  const beforePartitions = calls.filter(call => call.operation === partition), afterPartitions: SourceFileNativeCall[] = [];
  while (offset < calls.length && calls[offset]!.operation === `${partition}-after`) afterPartitions.push(calls[offset++]!);
  if (beforePartitions.length !== afterPartitions.length || beforePartitions.some((call, position) =>
    call.rc !== afterPartitions[position]!.rc || call.errno !== afterPartitions[position]!.errno)) throw invalidContext();
  while (offset < calls.length && calls[offset]!.operation === `${link}-after`) {
    if (calls[offset++]!.rc !== 0n) throw invalidContext();
  }
  if (offset !== calls.length) throw invalidContext();
  return calls;
}
function checkedGraphFact(value: unknown): SourceFileContextFact<SourceFileDeviceGraph> {
  const item = exactObject(value, ["status", "reason", "value", "calls"]);
  if (item.status === "unavailable") {
    if (item.value !== null || typeof item.reason !== "string" || !contextReasons.some(reason => reason === item.reason)) throw invalidContext();
    const calls = checkedAuxiliaryCalls(item.calls, false, true);
    if (!calls.length) throw invalidContext();
    return Object.freeze({ status: "unavailable", reason: item.reason as typeof contextReasons[number], value: null, calls });
  }
  if (item.status !== "observed" || item.reason !== null) throw invalidContext();
  const calls = checkedAuxiliaryCalls(item.calls);
  if (!calls.length || calls.some(call => call.rc === -1n && (call.errno !== 2n
    || !/^open-kernel-read(?:-after)?$/.test(call.operation) && !/^stat-partition-entry-(?:[0-9]|[1-5][0-9]|6[0-3])(?:-after)?$/.test(call.operation)))) throw invalidContext();
  const row = exactObject(item.value, ["nodes", "edges"]);
  if (!Array.isArray(row.nodes) || row.nodes.length < 1 || row.nodes.length > 64
    || !Array.isArray(row.edges) || row.edges.length > 128) throw invalidContext();
  const nodes: SourceFileDeviceGraphNode[] = row.nodes.map((raw, index) => {
    const node = exactObject(raw, ["index", "major", "minor", "identity", "kernelName", "resolved", "dev", "uevent", "partition", "backing",
      "holders", "slaves", "enumerationCalls"]);
    if (node.index !== index) throw invalidContext();
    const kernelName = asciiName(node.kernelName), major = unsigned(node.major, 0xffffffffn), minor = unsigned(node.minor, 0xffffffffn);
    const dev = checkedKernelReadFact(node.dev, 4096, 2), uevent = checkedKernelReadFact(node.uevent, 4096, 2);
    if (dev.status !== "observed" || uevent.status !== "observed" || dev.value.filesystemType !== 0x62656572n
      || uevent.value.filesystemType !== 0x62656572n || !dev.value.bytes.equals(Buffer.from(`${major}:${minor}\n`))) throw invalidContext();
    const partition = checkedKernelReadFact(node.partition, 4096, 2);
    if (partition.status === "observed") {
      if (partition.value.filesystemType !== 0x62656572n || !/^[1-9][0-9]*\n$/.test(partition.value.bytes.toString("ascii"))
        || partition.value.bytes.some(byte => byte > 0x7f)) throw invalidContext();
    } else if (!kernelAbsent(partition)) throw invalidContext();
    const backing = exactObject(node.backing, ["loopBackingFile", "dmName", "dmUuid"]);
    const checkedBacking = Object.fromEntries(["loopBackingFile", "dmName", "dmUuid"].map(name => {
      const fact = checkedKernelReadFact(backing[name], 4096, 2);
      if (fact.status === "observed" ? fact.value.filesystemType !== 0x62656572n : !kernelAbsent(fact)) throw invalidContext();
      return [name, fact];
    })) as SourceFileDeviceGraphNode["backing"];
    function names(value: unknown): readonly Buffer[] {
      if (!Array.isArray(value) || value.length > 64) throw invalidContext();
      const entries = value.map(raw => asciiName(raw));
      if (new Set(entries.map(name => name.toString("hex"))).size !== entries.length) throw invalidContext();
      return Object.freeze(entries);
    }
    return Object.freeze({ index, major, minor, identity: checkedIdentity(node.identity, 0x62656572n, 0o040000n),
      kernelName, resolved: resolvedDevice(node.resolved, kernelName), dev, uevent, partition,
      backing: Object.freeze(checkedBacking), holders: names(node.holders), slaves: names(node.slaves), enumerationCalls: checkedEnumeration(node.enumerationCalls, index) });
  });
  if (new Set(nodes.map(node => `${node.major}:${node.minor}`)).size !== nodes.length
    || new Set(nodes.map(node => node.kernelName.toString("hex"))).size !== nodes.length) throw invalidContext();
  const edges = row.edges.map(raw => {
    const edge = exactObject(raw, ["kind", "from", "to"]);
    if (edge.kind !== "parent" && edge.kind !== "holder" && edge.kind !== "slave"
      || !Number.isSafeInteger(edge.from) || !Number.isSafeInteger(edge.to) || typeof edge.from !== "number" || typeof edge.to !== "number"
      || edge.from < 0 || edge.to < 0 || edge.from >= nodes.length || edge.to >= nodes.length || edge.from === edge.to) throw invalidContext();
    return Object.freeze({ kind: edge.kind as "parent" | "holder" | "slave", from: edge.from, to: edge.to });
  });
  const edgeKeys = new Set(edges.map(edge => `${edge.kind}:${edge.from}:${edge.to}`));
  if (edgeKeys.size !== edges.length) throw invalidContext();
  for (const node of nodes) {
    if (node.enumerationCalls.filter(call => call.operation === `stat-device-link-${node.index}-after`).length
      !== edges.filter(edge => edge.from === node.index).length) throw invalidContext();
    for (const [list, kind] of [[node.holders, "holder"], [node.slaves, "slave"]] as const) {
      const references = edges.filter(edge => edge.kind === kind && edge.from === node.index);
      if (references.length !== list.length || references.some(edge => !list.some(name => name.equals(nodes[edge.to]!.kernelName)))) throw invalidContext();
      for (const edge of references) if (!edgeKeys.has(`${kind === "holder" ? "slave" : "holder"}:${edge.to}:${edge.from}`)) throw invalidContext();
    }
    const parents = edges.filter(edge => edge.kind === "parent" && edge.from === node.index);
    if (parents.length !== (node.partition.status === "observed" ? 1 : 0)
      || parents.some(edge => path.posix.dirname(node.resolved.toString("utf8")) !== nodes[edge.to]!.resolved.toString("utf8"))) throw invalidContext();
  }
  const reached = new Set([0]);
  for (let iteration = 0; iteration < nodes.length; iteration++) for (const edge of edges) {
    if (reached.has(edge.from) || reached.has(edge.to)) { reached.add(edge.from); reached.add(edge.to); }
  }
  if (reached.size !== nodes.length) throw invalidContext();
  function depth(index: number, path: Set<number>): void {
    if (path.has(index) || path.size > 16) throw invalidContext();
    const next = new Set(path); next.add(index);
    for (const edge of edges) if (edge.from === index && edge.kind !== "holder") depth(edge.to, next);
  }
  for (const node of nodes) depth(node.index, new Set());
  return Object.freeze({ status: "observed", reason: null, value: Object.freeze({ nodes: Object.freeze(nodes), edges: Object.freeze(edges) }), calls });
}
function checkedEnvironment(value: unknown, info: SourceFileRootInfo, tail = false): SourceFileRootEnvironment {
  const item = exactObject(value, ["abiVersion", "rootKind", "rootStage", "source", "process", "kernel", "mount", "configuration", "device", "health", "auxiliaryCalls"]);
  if (item.abiVersion !== (tail ? 3 : 2) || item.rootKind !== info.kind || item.rootStage !== info.stage) throw invalidContext();
  const source = exactObject(item.source, ["before", "after", "metadataCalls", "filesystemCarrier", "carrierCalls"]);
  const carrier = exactObject(source.filesystemCarrier, tail ? ["role", "before", "after", "mount"] : ["role", "before", "after"]), parent = info.stage === "metadata-only";
  if (carrier.role !== (tail ? "tail-carrier" : parent ? "bootstrap-parent" : "root") || tail && !parent) throw invalidContext();
  const before = checkedExtendedMetadata(source.before, info.kind), after = checkedExtendedMetadata(source.after, info.kind);
  const carrierBefore = checkedExtendedMetadata(carrier.before, parent ? "directory" : info.kind);
  const carrierAfter = checkedExtendedMetadata(carrier.after, parent ? "directory" : info.kind);
  const metadataCalls = checkedContextCalls(source.metadataCalls, ["fstat-before", "fstatfs-before", "fstatfs-after", "fstat-after"]);
  const carrierCalls = checkedContextCalls(source.carrierCalls, ["carrier-fstat-before", "carrier-fstatfs-before", "carrier-fstatfs-after", "carrier-fstat-after"]);
  if (!sameMetadata(before, after) || !sameMetadata(before, info.metadata) || !sameMetadata(carrierBefore, carrierAfter)
    || carrierBefore.dev !== before.dev || carrierBefore.fsType !== before.fsType || !parent && !sameMetadata(before, carrierBefore)
    || [...metadataCalls, ...carrierCalls].some(call => call.rc !== 0n)) throw sourceChanged();
  const process = exactObject(item.process, ["identity", "threadStatus", "processStat", "namespaces"]);
  const kernel = exactObject(item.kernel, ["uname", "notes", "config"]);
  const mount = exactObject(item.mount, ["legacyStatx", "uniqueStatx", "statmount", "mountinfo"]);
  const configuration = exactObject(item.configuration, ["tune", "options", "mbGroups", "mbStructsSummary", "journalTaskBefore", "journalIoprio", "journalTaskAfter"]);
  const device = exactObject(item.device, ["binding", "dev", "uevent", "topology", "blockAttributes"]);
  const health = exactObject(item.health, ["binding", "fields"]);
  function read(raw: unknown, limit: number, magic: bigint, samples: 1 | 2 = 1): SourceFileContextFact<SourceFileKernelReadValue> {
    const fact = checkedKernelReadFact(raw, limit, samples);
    if (fact.status === "observed" && fact.value.filesystemType !== magic) throw invalidContext();
    return fact;
  }
  function abi(raw: unknown, operation: string, length: number, samples: 1 | 2 = 1): SourceFileContextFact<Buffer> {
    const fact = checkedContextFact(raw, samples === 2 ? [operation, `${operation}-after`] : [operation], value => copiedBytes(value, length)); onlyZeroCalls(fact); return fact;
  }
  const config = checkedContextFact<SourceFileKernelReadValue>(kernel.config, ["read-kernel-config"], () => { throw invalidContext(); });
  if (config.status !== "unavailable" || config.reason !== "unsupported" || config.calls[0]!.rc !== null) throw invalidContext();
  const statmount = checkedContextFact(mount.statmount, ["statmount", "statmount-after"], raw => {
    const result = exactObject(raw, ["request", "result"]);
    return Object.freeze({ request: copiedBytes(result.request, 32), result: copiedBytes(result.result, 512, 16384) });
  });
  onlyZeroCalls(statmount);
  const ioprio = checkedContextFact(configuration.journalIoprio, ["ioprio-get", "ioprio-get-after"], raw => {
    const row = exactObject(raw, ["which", "who", "rawValue"]);
    if (row.which !== 1n) throw invalidContext();
    return Object.freeze({ which: 1n, who: unsigned(row.who, 0x7fffffffn, 1n), rawValue: unsigned(row.rawValue, 0x7fffffffn) });
  });
  if (ioprio.status === "observed" && ioprio.calls.some(call => call.rc !== ioprio.value.rawValue)) throw invalidContext();
  if (!Array.isArray(health.fields) || health.fields.length !== SOURCE_FILE_HEALTH_NAMES.length) throw invalidContext();
  const fields = health.fields.map((raw, index) => {
    const row = exactObject(raw, ["name", "fact"]), name = SOURCE_FILE_HEALTH_NAMES[index]!;
    if (row.name !== name) throw invalidContext();
    return Object.freeze({ name, fact: read(row.fact, 4096, 0x62656572n) });
  });
  const topology = checkedGraphFact(device.topology);
  const binding = checkedDeviceBinding(device.binding), dev = read(device.dev, 4096, 0x62656572n, 2);
  const auxiliaryCalls = checkedAuxiliaryCalls(item.auxiliaryCalls, true, topology.status === "unavailable");
  const blockAttributes = checkedBlockAttributes(device.blockAttributes, before, { binding, dev, topology }, auxiliaryCalls);
  let carrierMount: SourceFileRootEnvironment["source"]["filesystemCarrier"]["mount"];
  if (tail) {
    const pair = exactObject(carrier.mount, ["before", "after"]);
    const parsePair = (value: unknown) => {
      const row = exactObject(value, ["legacyMountId", "uniqueMountId"]);
      return Object.freeze({ legacyMountId: unsigned(row.legacyMountId, 0xffffffffffffffffn, 1n),
        uniqueMountId: unsigned(row.uniqueMountId, 0xffffffffffffffffn, 1n) });
    };
    const first = parsePair(pair.before), last = parsePair(pair.after);
    const legacy = abi(mount.legacyStatx, "statx-legacy", 256, 2), unique = abi(mount.uniqueStatx, "statx-unique", 256, 2);
    if (first.legacyMountId !== last.legacyMountId || first.uniqueMountId !== last.uniqueMountId
      || legacy.status !== "observed" || unique.status !== "observed"
      || legacy.value.readBigUInt64LE(144) !== first.legacyMountId || unique.value.readBigUInt64LE(144) !== first.uniqueMountId) throw sourceChanged();
    carrierMount = Object.freeze({ before: first, after: last });
  }
  return Object.freeze({ abiVersion: tail ? 3 : 2, rootKind: info.kind, rootStage: info.stage,
    source: Object.freeze({ before, after, metadataCalls, filesystemCarrier: Object.freeze({
      role: tail ? "tail-carrier" : parent ? "bootstrap-parent" : "root", before: carrierBefore, after: carrierAfter,
      ...(carrierMount ? { mount: carrierMount } : {}) }), carrierCalls }),
    process: Object.freeze({ identity: checkedProcessIdentity(process.identity), threadStatus: read(process.threadStatus, 65536, 0x9fa0n),
      processStat: read(process.processStat, 8192, 0x9fa0n), namespaces: checkedNamespaces(process.namespaces) }),
    kernel: Object.freeze({ uname: abi(kernel.uname, "uname", 390), notes: read(kernel.notes, 1048576, 0x62656572n), config }),
    mount: Object.freeze({ legacyStatx: abi(mount.legacyStatx, "statx-legacy", 256, 2), uniqueStatx: abi(mount.uniqueStatx, "statx-unique", 256, 2),
      statmount, mountinfo: read(mount.mountinfo, 1048576, 0x9fa0n) }),
    configuration: Object.freeze({ tune: abi(configuration.tune, "ioctl-get-tune", 232, 2), options: read(configuration.options, 16384, 0x9fa0n, 2),
      mbGroups: read(configuration.mbGroups, 16384, 0x9fa0n, 2), journalTaskBefore: read(configuration.journalTaskBefore, 4096, 0x62656572n),
      mbStructsSummary: read(configuration.mbStructsSummary, 16384, 0x9fa0n, 2),
      journalIoprio: ioprio, journalTaskAfter: read(configuration.journalTaskAfter, 4096, 0x62656572n) }),
    device: Object.freeze({ binding, dev, uevent: read(device.uevent, 4096, 0x62656572n, 2), topology, blockAttributes }),
    health: Object.freeze({ binding: checkedHealthBinding(health.binding), fields: Object.freeze(fields) }),
    auxiliaryCalls });
}
function checkedFact<T>(value: unknown, operations: readonly string[], validate: (value: unknown) => void): SourceFileNativeFact<T> {
  const item = object(value);
  if (Object.keys(item).sort().join() !== "calls,reason,status,value") throw sourceChanged();
  const calls = checkedCalls(item.calls, operations);
  if (item.status === "observed") {
    if (item.reason !== null || !calls.every(call => call.rc !== null && call.rc >= 0n && call.errno === 0n)) throw sourceChanged();
    validate(item.value);
  } else if (item.status !== "unavailable" || item.value !== null
    || !["syscall", "length", "identity", "budget", "enumeration", "abi"].includes(String(item.reason))) throw sourceChanged();
  return item as SourceFileNativeFact<T>;
}
function checkedExtended(value: unknown, kind: SourceFileMetadata["kind"]): SourceFileExtendedObservation {
  const item = object(value);
  if (Object.keys(item).sort().join() !== "after,before,fid,inodeFlags,metadataCalls,uuid,xattrs") throw sourceChanged();
  checkedObservation(item.before, kind); checkedObservation(item.after, kind);
  const before = object(item.before), after = object(item.after);
  const fields = ["kind", "dev", "ino", "mode", "uid", "gid", "nlink", "size", "fsType", "atimeNs", "mtimeNs", "ctimeNs"];
  if (Object.keys(before).sort().join() !== [...fields].sort().join() || Object.keys(after).sort().join() !== [...fields].sort().join()
    || typeof before.gid !== "bigint" || typeof before.atimeNs !== "bigint"
    || fields.some(key => before[key] !== after[key])) throw sourceChanged();
  const metadataCalls = checkedCalls(item.metadataCalls, ["fstat-before", "fstatfs-before", "fstatfs-after", "fstat-after"]);
  if (!metadataCalls.every(call => call.rc === 0n && call.errno === 0n)) throw sourceChanged();
  checkedFact(item.uuid, ["ioctl-getfsuuid"], value => {
    const uuid = object(value);
    if (Object.keys(uuid).sort().join() !== "bytes,length" || typeof uuid.length !== "bigint" || uuid.length < 1n || uuid.length > 16n
      || !Buffer.isBuffer(uuid.bytes) || BigInt(uuid.bytes.length) !== uuid.length) throw sourceChanged();
  });
  checkedFact(item.fid, ["name-to-handle-at"], value => {
    const fid = object(value);
    if (Object.keys(fid).sort().join() !== "bytes,handleBytes,handleType,mountId" || typeof fid.handleType !== "bigint"
      || fid.handleType < 1n || fid.handleType > 0x7fffffffn || fid.handleType === 255n
      || typeof fid.mountId !== "bigint" || fid.mountId < 1n || fid.mountId > 0xffffffffffffffffn
      || typeof fid.handleBytes !== "bigint" || fid.handleBytes < 1n || fid.handleBytes > 128n || fid.handleBytes % 4n !== 0n
      || !Buffer.isBuffer(fid.bytes) || BigInt(fid.bytes.length) !== fid.handleBytes) throw sourceChanged();
  });
  checkedFact(item.inodeFlags, ["ioctl-getflags"], value => {
    if (typeof value !== "bigint" || value < 0n || value > 0xffffffffn) throw sourceChanged();
  });
  const xattrs = object(item.xattrs);
  const xattrCalls = xattrs.calls;
  if (!Array.isArray(xattrCalls) || xattrCalls.length < 2 || xattrCalls.length > 66) throw sourceChanged();
  checkedFact(item.xattrs, ["flistxattr-before", ...Array<string>(xattrCalls.length - 2).fill("fgetxattr"), "flistxattr-after"], value => {
    if (!Array.isArray(value) || value.length > 64 || xattrCalls.length !== value.length + 2) throw sourceChanged();
    let total = 0, previous: Buffer | undefined;
    for (let i = 0; i < value.length; i++) {
      const entry = object(value[i]);
      if (Object.keys(entry).sort().join() !== "name,value" || !Buffer.isBuffer(entry.name) || entry.name.length < 1 || entry.name.length > 255
        || entry.name.includes(0) || !Buffer.isBuffer(entry.value) || previous && Buffer.compare(previous, entry.name) >= 0) throw sourceChanged();
      total += entry.name.length + entry.value.length;
      if (total > 65536 || (xattrs.calls as SourceFileNativeCall[])[i+1]!.rc !== BigInt(entry.value.length)) throw sourceChanged();
      previous = entry.name;
    }
    const nameBytes = value.reduce((sum: number, entry: { name: Buffer }) => sum + entry.name.length + 1, 0);
    if ((xattrs.calls as SourceFileNativeCall[])[0]!.rc !== BigInt(nameBytes)
      || (xattrs.calls as SourceFileNativeCall[]).at(-1)!.rc !== BigInt(nameBytes)) throw sourceChanged();
  });
  return item as unknown as SourceFileExtendedObservation;
}

function sourceCall<T>(scope: SourceScope, consume: () => T, handle?: OwnedSourceFile): T {
  try { return consume(); }
  catch (error) {
    // Rejected argument syntax starts no syscall and is not observed source
    // I/O. All actual native/decoder failures remain sticky for this scope.
    if ((error as { code?: unknown } | null)?.code !== "ERR_SOURCE_ARGUMENT"
      && !scope.failures.some(value => Object.is(value, error))) scope.failures.push(error);
    const state = handle && sourceOwners.get(handle);
    const native = error as { nativeCleanupOwner?: unknown; cleanupCalls?: unknown } | null;
    if (state && native?.nativeCleanupOwner === state.owner && Array.isArray(native.cleanupCalls)) {
      const source = native.cleanupCalls.find(call => call?.operation === "close-source");
      const parent = native.cleanupCalls.find(call => call?.operation === "close-bootstrap-parent");
      if (source?.rc === 0n && source.errno === 0n && parent && (parent.rc === null || parent.rc === 0n && parent.errno === 0n)) {
        // The actual native error path already joined and closed these slots.
        // Retain the error, but never issue a new close against reused integers.
        state.closed = true; scope.opened.delete(handle); state.closing = Promise.resolve();
      }
    }
    throw error;
  }
}

interface NativeCloseState {
  readonly owner: object;
  readonly scope: SourceScope;
  closed: boolean;
}
// Retain the concrete original owner/scope, not just a rejected Promise or a
// numeric descriptor. No fresh overlapping source window may bypass it.
const unresolvedNativeCloses = new Set<NativeCloseState>();
function unresolvedClose(state: NativeCloseState, cause: unknown = state.scope.failures[0]): MaintenanceFailure {
  const error = new MaintenanceFailure("maintenance_lost", "source-file-close-unresolved");
  Object.defineProperties(error, { nativeCleanupOwner: { value: state.owner }, cause: { value: cause } });
  return error;
}
async function closeNativeOwner(state: NativeCloseState): Promise<void> {
  let first: unknown;
  try {
    const work = state.scope.binding.closeAsync(state.owner);
    if (!(work instanceof Promise)) throw invalidContext();
    await work; state.closed = true; return;
  } catch (error) { first = error; state.scope.failures.push(error); }
  // Only native state can establish that no close syscall was started. The
  // fallback does not allocate/queue another worker and cannot retry an
  // attempted/unknown close. It may block until its real syscall returns;
  // this is failed-window cleanup, never a new success budget or a sync.
  try { state.closed = state.scope.binding.closeUnstarted(state.owner) === true; }
  catch (error) { state.scope.failures.push(error); }
  if (!state.closed) {
    unresolvedNativeCloses.add(state);
    state.scope.failures.push(unresolvedClose(state, first));
  }
  // Even successful actual cleanup cannot erase the original start/I/O error.
  throw first;
}

class OwnedSourceFile implements SourceFileHandle {
  readonly kind: SourceFileMetadata["kind"];
  constructor(owner: object, kind: SourceFileMetadata["kind"], scope: SourceScope, root = false) {
    this.kind = kind;
    sourceOwners.set(this, { owner, scope, kind, root, closed: false });
    scope.opened.add(this);
    Object.freeze(this);
  }
  observe(): SourceFileMetadata {
    return observeSourceFile(this);
  }
  observeStatx(): SourceFileStatxObservation {
    const { scope, owner, kind } = activeOwner(this);
    return sourceCall(scope, () => checkedStatx(scope.binding.observeStatx(owner), kind), this);
  }
  observeStatxUnique(): SourceFileUniqueStatxObservation {
    const { scope, owner, kind } = activeOwner(this);
    return sourceCall(scope, () => {
      if (typeof scope.binding.observeStatxUnique !== "function") throw unavailable();
      return checkedUniqueStatx(scope.binding.observeStatxUnique(owner), kind);
    }, this);
  }
  observeExtended(): SourceFileExtendedObservation {
    const { scope, owner, kind } = activeOwner(this);
    return sourceCall(scope, () => checkedExtended(scope.binding.observeExtended(owner), kind), this);
  }
  openChild(leaf: string, kind: SourceFileMetadata["kind"]): SourceFileHandle {
    const state = activeOwner(this);
    if (state.kind !== "directory") throw sourceChanged();
    return sourceCall(state.scope, () => {
      return new OwnedSourceFile(state.scope.binding.openChild(state.owner, leaf, kind), kind, state.scope);
    }, this);
  }
  readAt(offset: bigint, length: number): Buffer {
    const { scope, owner, kind } = activeOwner(this);
    if (kind !== "file" || typeof offset !== "bigint" || offset < 0n ||
      !Number.isSafeInteger(length) || length < 1 || length > 65536) throw sourceChanged();
    return sourceCall(scope, () => {
      const data = scope.binding.readAt(owner, offset, length);
      if (!Buffer.isBuffer(data) || data.length > length) throw sourceChanged();
      return data;
    }, this);
  }
  readDirectory(): readonly string[] {
    const { scope, owner, kind } = activeOwner(this);
    if (kind !== "directory") throw sourceChanged();
    return sourceCall(scope, () => {
      const names = scope.binding.readDirectory(owner);
      if (!Array.isArray(names) || names.length > 4096 || names.some(value =>
        typeof value !== "string" || !value || value === "." || value === ".." ||
        value.includes("/") || value.includes("\0")) || new Set(names).size !== names.length) throw sourceChanged();
      return [...names].sort();
    }, this);
  }
  close(): void {
    const state = activeOwner(this, true);
    if (state.pending || state.closing) throw new MaintenanceFailure("maintenance_lost", "source-file-native-pending");
    try { state.scope.binding.close(state.owner); }
    catch (error) {
      state.scope.failures.push(error);
      state.closed = true;
      state.scope.opened.delete(this);
      throw error;
    }
    state.closed = true;
    state.scope.opened.delete(this);
  }
  reopenFile(): SourceFileHandle {
    const state = activeOwner(this);
    if (state.kind !== "file") throw sourceChanged();
    try { return new OwnedSourceFile(state.scope.binding.reopenFile(state.owner), "file", state.scope, state.root); }
    catch (error) { state.scope.failures.push(error); throw error; }
  }
  synchronize(): Promise<void> {
    const state = activeOwner(this);
    if (state.pending || state.closing) throw new MaintenanceFailure("maintenance_lost", "source-file-native-pending");
    let work: Promise<void>;
    try { work = state.scope.binding.synchronize(state.owner); }
    catch (error) { state.scope.failures.push(error); throw error; }
    const original = work.catch(error => { state.scope.failures.push(error); throw error; }).finally(() => {
      if (state.pending === original) delete state.pending;
      state.scope.pending.delete(original);
    });
    state.pending = original; state.scope.pending.add(original);
    void original.catch(() => undefined);
    return original;
  }
  closeAsync(): Promise<void> {
    const state = sourceOwners.get(this);
    if (state?.closing) return state.closing;
    if (!state || !state.scope.active || state.closed)
      return Promise.reject(new MaintenanceFailure("maintenance_lost", "source-file-owner"));
    const pending = state.pending;
    const original = Promise.resolve().then(async () => {
      // A sync rejection is already sticky. Its actual completion still must
      // precede this owner's unique close, including failure cleanup.
      if (pending) await Promise.allSettled([pending]);
      await closeNativeOwner(state);
    }).finally(() => {
      if (state.closed) state.scope.opened.delete(this);
      state.scope.pending.delete(original);
    });
    state.closing = original; state.scope.pending.add(original);
    void original.catch(() => undefined);
    return original;
  }
}
Object.freeze(OwnedSourceFile.prototype);

interface MetadataTailState {
  readonly owner: object; readonly source: SourceFileHandle; readonly scope: SourceScope;
  attached: boolean; closed: boolean; closing?: Promise<void>;
}
const metadataTails = new WeakMap<object, MetadataTailState>();
function activeTail(tail: object): MetadataTailState {
  const state = metadataTails.get(tail);
  if (!state || !state.scope.active || state.closed || state.closing || state.scope.failures.length)
    throw new MaintenanceFailure("maintenance_lost", "source-file-tail");
  return state;
}
class OwnedMetadataTail implements SourceFileMetadataTail {
  constructor(owner: object, source: SourceFileHandle, scope: SourceScope) {
    metadataTails.set(this, { owner, source, scope, attached: false, closed: false });
    scope.tails.add(this); Object.freeze(this);
  }
  transferCarrier(carrier: SourceFileHandle): void {
    const state = activeTail(this), original = activeOwner(carrier);
    if (state.attached || original.kind !== "directory" || state.scope.binding !== original.scope.binding)
      throw sourceChanged();
    try { state.scope.binding.transferCarrier(state.owner, original.owner); }
    catch (error) { state.scope.failures.push(error); throw error; }
    // The native descriptor moved; this is not its release. Only the M/A owner
    // may now close it, and the old scope must never retry that numeric slot.
    original.closed = true; original.scope.opened.delete(carrier as OwnedSourceFile);
    state.attached = true;
  }
  observe(): SourceFileBootstrapContext {
    const state = activeTail(this), source = sourceOwners.get(state.source);
    if (!state.attached || !source?.closed || state.scope.opened.size || state.scope.pending.size)
      throw new MaintenanceFailure("maintenance_lost", "source-file-tail-before-source-close");
    try {
      const before = checkedRootInfo(state.scope.binding.rootInfo(state.owner), true);
      if (before.stage !== "metadata-only") throw invalidContext();
      const environment = checkedEnvironment(nativeEnvironment(state.scope, state.owner), before, true);
      recordAuxiliaryFailure(state.scope, environment);
      const after = checkedRootInfo(state.scope.binding.rootInfo(state.owner), true);
      if (after.kind !== before.kind || after.stage !== before.stage || !sameMetadata(before.metadata, after.metadata)) throw sourceChanged();
      return Object.freeze({ info: before, environment });
    } catch (error) { if (!state.scope.failures.some(value => Object.is(value, error))) state.scope.failures.push(error); throw error; }
  }
  closeAsync(): Promise<void> {
    const state = metadataTails.get(this);
    if (state?.closing) return state.closing;
    if (!state || !state.scope.active || state.closed)
      return Promise.reject(new MaintenanceFailure("maintenance_lost", "source-file-tail"));
    const original = Promise.resolve().then(() => closeNativeOwner(state))
      .finally(() => {
        if (state.closed) state.scope.tails.delete(this);
        state.scope.pending.delete(original);
      });
    state.closing = original; state.scope.pending.add(original); void original.catch(() => undefined);
    return original;
  }
}
Object.freeze(OwnedMetadataTail.prototype);
export function retainSourceFileMetadata(root: SourceFileHandle): SourceFileMetadataTail {
  const state = activeRoot(root);
  try { return new OwnedMetadataTail(state.scope.binding.retainMetadata(state.owner), root, state.scope); }
  catch (error) { state.scope.failures.push(error); throw error; }
}
export function assertSourceFileTailFor(tail: SourceFileMetadataTail, root: SourceFileHandle): void {
  if (activeTail(tail).source !== root) throw new MaintenanceFailure("maintenance_lost", "source-file-tail-origin");
}

function closeBootstrap(state: SourceBootstrapState): void {
  if (state.closed) return;
  state.closed = true;
  try { state.scope.binding.close(state.owner); }
  catch (error) { state.closeUnknown = true; state.scope.failures.push(error); throw error; }
}
/** Package-internal capability: only the factory-created private token works.
 * No caller proof, boolean or native numeric FD is accepted. */
export function promoteSourceFileBootstrap(token: object): SourceFileHandle {
  const state = activeBootstrap(token), native = state.scope.binding;
  if (state.attempted || state.initial.kind !== "file" || state.initial.stage !== "metadata-only")
    throw new MaintenanceFailure("maintenance_lost", "source-file-bootstrap");
  state.attempted = true;
  const before = checkedRootInfo(native.rootInfo(state.owner));
  if (before.kind !== "file" || before.stage !== "metadata-only" || !sameMetadata(before.metadata, state.initial.metadata))
    throw sourceChanged();
  const owner = native.openRootContent(state.owner);
  const handle = new OwnedSourceFile(owner, "file", state.scope, true);
  sourceOwners.get(handle)!.bootstrap = token;
  state.promoted = handle;
  const content = checkedRootInfo(native.rootInfo(owner)), after = checkedRootInfo(native.rootInfo(state.owner));
  if (content.kind !== "file" || content.stage !== "readable" || after.kind !== "file" || after.stage !== "metadata-only"
    || !sameMetadata(before.metadata, content.metadata) || !sameMetadata(before.metadata, after.metadata)) throw sourceChanged();
  // The new content owner is already registered for deterministic cleanup if
  // this close or a subsequent fixed profile check fails.
  closeBootstrap(state);
  return handle;
}
function detached<T>(value: T): T {
  if (Buffer.isBuffer(value)) return Buffer.from(value) as T;
  if (Array.isArray(value)) return Object.freeze(value.map(entry => detached(entry))) as T;
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, detached(entry)]))) as T;
  return value;
}
function recordAuxiliaryFailure(scope: SourceScope, environment: SourceFileRootEnvironment): void {
  const calls = environment.auxiliaryCalls.filter(call => call.operation.startsWith("close-") && call.rc === -1n);
  if (calls.length) {
    const failure = new MaintenanceFailure("backup_capability_unavailable", "source-file-auxiliary-close");
    Object.defineProperty(failure, "nativeCalls", { value: calls });
    scope.failures.push(failure);
  }
}
function nativeEnvironment(scope: SourceScope, owner: object): unknown {
  try { return scope.binding.observeEnvironment(owner); }
  catch (error) {
    // The fixed collector invalidates this actual owner on a fatal observation
    // or cleanup error. A callback catching it cannot restore scope success.
    scope.failures.push(error);
    throw error;
  }
}
/** Package-internal provenance check; copied objects and genuine child owners
 * cannot register a root context, even when they expose the same method names. */
export function assertSourceFileRootActive(root: SourceFileHandle): void { activeRoot(root); }
export function observeSourceFileRootContext(root: SourceFileHandle): SourceFileRootContext {
  const state = activeRoot(root), native = state.scope.binding;
  return sourceCall(state.scope, () => {
    if (typeof native.observeEnvironment !== "function") throw unavailable();
    const before = checkedRootInfo(native.rootInfo(state.owner));
    if (before.kind !== state.kind || before.stage !== "readable") throw sourceChanged();
    const extended = checkedExtended(native.observeExtended(state.owner), state.kind);
    const legacy = checkedStatx(native.observeStatx(state.owner), state.kind);
    const unique = checkedUniqueStatx(native.observeStatxUnique(state.owner), state.kind);
    const environment = checkedEnvironment(nativeEnvironment(state.scope, state.owner), before);
    recordAuxiliaryFailure(state.scope, environment);
    const after = checkedRootInfo(native.rootInfo(state.owner));
    if (after.kind !== before.kind || after.stage !== before.stage || !sameMetadata(before.metadata, after.metadata)
      || !sameMetadata(before.metadata, extended.before) || !sameMetadata(extended.before, extended.after)) throw sourceChanged();
    return Object.freeze({ info: before, root: detached(extended), legacyStatx: legacy, uniqueStatx: unique, environment });
  }, root as OwnedSourceFile);
}
/** This token is never handed to S. Its metadata-only owner cannot call any
 * readable getter, and a caller-created record cannot pass this private map. */
export function observeSourceFileBootstrap(token: object): SourceFileBootstrapContext {
  const state = activeBootstrap(token), native = state.scope.binding;
  return sourceCall(state.scope, () => {
    if (typeof native.observeEnvironment !== "function") throw unavailable();
    const before = checkedRootInfo(native.rootInfo(state.owner));
    if (before.kind !== "file" || before.stage !== "metadata-only" || !sameMetadata(before.metadata, state.initial.metadata)) throw sourceChanged();
    const environment = checkedEnvironment(nativeEnvironment(state.scope, state.owner), before);
    recordAuxiliaryFailure(state.scope, environment);
    const after = checkedRootInfo(native.rootInfo(state.owner));
    if (after.kind !== "file" || after.stage !== "metadata-only" || !sameMetadata(before.metadata, after.metadata)) throw sourceChanged();
    return Object.freeze({ info: before, environment });
  }, undefined);
}

/** A one-shot native-owned resource scope. All owned child handles must be
 * explicitly closed before callback return; otherwise this operation fails
 * even if the deterministic final cleanup succeeds. */
async function sourceRoot<T>(
  root: string, consume: (handle: SourceFileHandle) => Promise<T> | T,
  expected: SourceFileExpectedProfile | undefined, preview: boolean,
): Promise<T> {
  const selected = path.resolve(root);
  const contains = (parent: string, child: string) => parent === child || child.startsWith(parent === "/" ? "/" : parent + "/");
  const unresolved = [...unresolvedNativeCloses].find(state => contains(state.scope.root, selected) || contains(selected, state.scope.root));
  if (unresolved) throw unresolvedClose(unresolved);
  const native = binding();
  const scope: SourceScope = { root: selected, binding: native, opened: new Set(), failures: [], pending: new Set(), tails: new Set(), active: true };
  let handle: SourceFileHandle | undefined, raw: object | undefined, bootstrap: SourceBootstrapState | undefined;
  let failed = false, firstError: unknown, result: T | undefined;
  try {
    raw = native.openRoot(root);
    const info = checkedRootInfo(native.rootInfo(raw));
    if (preview && info.kind !== "file") throw sourceChanged();
    if (info.kind === "directory" && info.stage === "readable") {
      handle = new OwnedSourceFile(raw, info.kind, scope, true); raw = undefined;
      if (expected) {
        const profile = await import("./source-file-profile.ts");
        profile.assertExpectedSourceFileProfile(profile.matchSourceFileProfile(handle), expected);
      }
    } else {
      if (info.kind !== "file" || info.stage !== "metadata-only") throw sourceChanged();
      const token = Object.freeze({});
      bootstrap = { owner: raw, scope, initial: info, attempted: false, closed: false, closeUnknown: false };
      sourceBootstraps.set(token, bootstrap); raw = undefined;
      const profile = await import("./source-file-profile.ts");
      handle = preview ? profile.initializeSourceFilePreviewBootstrap(token) : profile.initializeSourceFileBootstrap(token, expected);
      const state = activeRoot(handle);
      if (state.scope !== scope || state.bootstrap !== token || bootstrap.promoted !== handle) throw sourceChanged();
    }
    result = await consume(handle);
  } catch (error) { failed = true; firstError = error; }
  if (scope.pending.size) {
    if (!failed) { failed = true; firstError = new MaintenanceFailure("maintenance_lost", "unsettled-source-native-work"); }
    await Promise.allSettled([...scope.pending]);
  }
  if (raw) {
    try { native.close(raw); } catch (error) { scope.failures.push(error); }
  }
  if (bootstrap && !bootstrap.closed) {
    try { closeBootstrap(bootstrap); } catch { /* Already recorded, never close again. */ }
  }
  const pending = [...scope.opened];
  if (!failed && scope.failures.length === 0 && (pending.some(owner => owner !== handle) || scope.tails.size > 0)) {
    failed = true;
    firstError = new MaintenanceFailure("maintenance_lost", "unclosed-source-children");
  }
  for (const owner of pending.reverse()) {
    try { await owner.closeAsync(); } catch { /* The real owner's close records its error. */ }
  }
  for (const tail of [...scope.tails]) {
    try { await tail.closeAsync(); } catch { /* The actual tail records A and M close errors. */ }
  }
  scope.active = false;
  if (scope.failures.length) {
    throw new AggregateError(failed ? [firstError, ...scope.failures.filter(error => error !== firstError)] :
      [...scope.failures], "source-file-native-close", { cause: failed ? firstError : scope.failures[0] });
  }
  if (failed) throw firstError;
  return result as T;
}
export function withNativeSourceRoot<T>(root: string, consume: (handle: SourceFileHandle) => Promise<T> | T,
  expected?: SourceFileExpectedProfile): Promise<T> {
  return sourceRoot(root, consume, expected, false);
}
/** Fixed preview consumer. No caller mode or proof can enable this policy. */
export function withNativeSourcePreviewFile<T>(root: string, consume: (handle: SourceFileHandle) => Promise<T> | T): Promise<T> {
  return sourceRoot(root, consume, undefined, true);
}
export function observeSourceFile(handle: SourceFileHandle): SourceFileMetadata {
  const { scope, owner, kind } = activeOwner(handle);
  return sourceCall(scope, () => checkedObservation(scope.binding.observe(owner), kind), handle as OwnedSourceFile);
}

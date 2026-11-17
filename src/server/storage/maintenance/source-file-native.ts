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

interface NativeSourceBinding {
  openRoot(path: string): object;
  openChild(parent: object, leaf: string, kind: SourceFileMetadata["kind"]): object;
  observe(owner: object): unknown;
  observeStatx(owner: object): unknown;
  observeExtended(owner: object): unknown;
  readAt(owner: object, offset: bigint, length: number): unknown;
  readDirectory(owner: object): unknown;
  close(owner: object): void;
}
export interface SourceFileHandle {
  readonly kind: SourceFileMetadata["kind"];
  observe(): SourceFileMetadata;
  observeStatx(): SourceFileStatxObservation;
  observeExtended(): SourceFileExtendedObservation;
  openChild(leaf: string, kind: SourceFileMetadata["kind"]): SourceFileHandle;
  readAt(offset: bigint, length: number): Buffer;
  readDirectory(): readonly string[];
  close(): void;
}
interface SourceScope {
  readonly binding: NativeSourceBinding;
  readonly opened: Set<OwnedSourceFile>;
  readonly failures: unknown[];
  active: boolean;
}
const unavailable = () => new MaintenanceFailure("backup_capability_unavailable", "source-file-native");
const sourceChanged = () => new MaintenanceFailure("source_changed", "source-file-native");
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
  for (const method of ["openRoot", "openChild", "observe", "observeStatx", "observeExtended", "readAt", "readDirectory", "close"] as const) {
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
function checkedStatx(value: unknown, kind: SourceFileMetadata["kind"]): SourceFileStatxObservation {
  if (!value || typeof value !== "object" || (value as { kind?: unknown }).kind !== kind) throw sourceChanged();
  const item = value as Partial<SourceFileStatxObservation>;
  for (const key of ["mask", "devMajor", "devMinor", "ino", "attributes", "attributesMask"] as const) {
    if (typeof item[key] !== "bigint") throw sourceChanged();
  }
  if ((item.mask! & 0x7ffn) !== 0x7ffn || item.ino! <= 0n
    || (item.mountId !== null && typeof item.mountId !== "bigint")
    || (item.birthtimeNs !== null && typeof item.birthtimeNs !== "bigint")
    || ((item.mask! & 0x1000n) !== 0n) !== (item.mountId !== null)
    || ((item.mask! & 0x800n) !== 0n) !== (item.birthtimeNs !== null)) throw sourceChanged();
  return item as SourceFileStatxObservation;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw sourceChanged();
  return value as Record<string, unknown>;
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
  return value as SourceFileNativeCall[];
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

class OwnedSourceFile implements SourceFileHandle {
  readonly kind: SourceFileMetadata["kind"];
  private readonly owner: object;
  private readonly scope: SourceScope;
  private closed = false;
  constructor(owner: object, kind: SourceFileMetadata["kind"], scope: SourceScope) {
    this.owner = owner;
    this.kind = kind;
    this.scope = scope;
    scope.opened.add(this);
  }
  private assertActive(): void {
    if (!this.scope.active || this.closed) throw new MaintenanceFailure("maintenance_lost", "source-file-owner");
  }
  observe(): SourceFileMetadata {
    this.assertActive();
    return checkedObservation(this.scope.binding.observe(this.owner), this.kind);
  }
  observeStatx(): SourceFileStatxObservation {
    this.assertActive();
    return checkedStatx(this.scope.binding.observeStatx(this.owner), this.kind);
  }
  observeExtended(): SourceFileExtendedObservation {
    this.assertActive();
    return checkedExtended(this.scope.binding.observeExtended(this.owner), this.kind);
  }
  openChild(leaf: string, kind: SourceFileMetadata["kind"]): SourceFileHandle {
    this.assertActive();
    if (this.kind !== "directory") throw sourceChanged();
    return new OwnedSourceFile(this.scope.binding.openChild(this.owner, leaf, kind), kind, this.scope);
  }
  readAt(offset: bigint, length: number): Buffer {
    this.assertActive();
    if (this.kind !== "file" || typeof offset !== "bigint" || offset < 0n ||
      !Number.isSafeInteger(length) || length < 1 || length > 65536) throw sourceChanged();
    const data = this.scope.binding.readAt(this.owner, offset, length);
    if (!Buffer.isBuffer(data) || data.length > length) throw sourceChanged();
    return data;
  }
  readDirectory(): readonly string[] {
    this.assertActive();
    if (this.kind !== "directory") throw sourceChanged();
    const names = this.scope.binding.readDirectory(this.owner);
    if (!Array.isArray(names) || names.length > 4096 || names.some(value =>
      typeof value !== "string" || !value || value === "." || value === ".." ||
      value.includes("/") || value.includes("\0")) || new Set(names).size !== names.length) throw sourceChanged();
    return [...names].sort();
  }
  close(): void {
    this.assertActive();
    try { this.scope.binding.close(this.owner); }
    catch (error) {
      this.scope.failures.push(error);
      this.closed = true;
      this.scope.opened.delete(this);
      throw error;
    }
    this.closed = true;
    this.scope.opened.delete(this);
  }
}

/** A one-shot native-owned resource scope. All owned child handles must be
 * explicitly closed before callback return; otherwise this operation fails
 * even if the deterministic final cleanup succeeds. */
export async function withNativeSourceRoot<T>(
  root: string, consume: (handle: SourceFileHandle) => Promise<T> | T,
): Promise<T> {
  const native = binding();
  const scope: SourceScope = { binding: native, opened: new Set(), failures: [], active: true };
  const handle = new OwnedSourceFile(native.openRoot(root), "directory", scope);
  let failed = false, firstError: unknown, result: T | undefined;
  try { result = await consume(handle); } catch (error) { failed = true; firstError = error; }
  const pending = [...scope.opened];
  if (!failed && pending.some(owner => owner !== handle)) {
    failed = true;
    firstError = new MaintenanceFailure("maintenance_lost", "unclosed-source-children");
  }
  const closeFailures: unknown[] = [];
  for (const owner of pending.reverse()) {
    try { owner.close(); } catch (error) { closeFailures.push(error); }
  }
  scope.active = false;
  if (closeFailures.length || scope.failures.length) {
    throw new AggregateError(failed ? [firstError, ...closeFailures, ...scope.failures] :
      [...closeFailures, ...scope.failures], "source-file-native-close", { cause: firstError });
  }
  if (failed) throw firstError;
  return result as T;
}
export function observeSourceFile(handle: SourceFileHandle): SourceFileMetadata {
  return handle.observe();
}

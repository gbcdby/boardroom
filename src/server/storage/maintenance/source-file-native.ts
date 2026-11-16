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
interface NativeSourceBinding {
  openRoot(path: string): object;
  openChild(parent: object, leaf: string, kind: SourceFileMetadata["kind"]): object;
  observe(owner: object): unknown;
  readAt(owner: object, offset: bigint, length: number): unknown;
  readDirectory(owner: object): unknown;
  close(owner: object): void;
}
export interface SourceFileHandle {
  readonly kind: SourceFileMetadata["kind"];
  observe(): SourceFileMetadata;
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
  for (const method of ["openRoot", "openChild", "observe", "readAt", "readDirectory", "close"] as const) {
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
class OwnedSourceFile implements SourceFileHandle {
  readonly kind: SourceFileMetadata["kind"];
  private closed = false;
  constructor(private readonly owner: object, kind: SourceFileMetadata["kind"], private readonly scope: SourceScope) {
    this.kind = kind;
    scope.opened.add(this);
  }
  private assertActive(): void {
    if (!this.scope.active || this.closed) throw new MaintenanceFailure("maintenance_lost", "source-file-owner");
  }
  observe(): SourceFileMetadata {
    this.assertActive();
    return checkedObservation(this.scope.binding.observe(this.owner), this.kind);
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

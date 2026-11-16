import { lstatSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MaintenanceFailure } from "./error.ts";

/**
 * #152 P0. This is an opaque *read-only* native FD, not a proof of source
 * preservation, provider qualification or source-file capture eligibility.
 * P's statx/FID/xattr/registry checks and S's live enumeration are separate.
 */
interface NativeOwner { readonly __opaqueSourceOwner?: never }
interface NativeObservation {
  readonly kind: "file" | "directory";
  readonly dev: bigint; readonly ino: bigint; readonly uid: bigint; readonly gid: bigint;
  readonly mode: bigint; readonly nlink: bigint; readonly size: bigint;
  readonly mtimeNs: bigint; readonly ctimeNs: bigint;
  readonly fsType: bigint; readonly fsBlockSize: bigint;
}
interface NativeDirent { readonly name: Uint8Array; readonly type: number }
interface NativeSourceBinding {
  openRoot(root: string): NativeOwner;
  openChild(parent: NativeOwner, leaf: string): NativeOwner;
  observe(owner: NativeOwner): NativeObservation;
  readAt(owner: NativeOwner, position: bigint, length: number): Uint8Array;
  readDirectory(owner: NativeOwner): readonly NativeDirent[];
  close(owner: NativeOwner): void;
}
const methods = ["openRoot", "openChild", "observe", "readAt", "readDirectory", "close"] as const;
const statFields = ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeNs", "ctimeNs", "fsType", "fsBlockSize"] as const;
const decoder = new TextDecoder("utf-8", { fatal: true });
export const sourceFileNativePath = fileURLToPath(new URL(
  "../../../../build/maintenance-platform/maintenance-source-files-" + process.arch + ".node", import.meta.url));
let installed: NativeSourceBinding | undefined;

function unavailable(): MaintenanceFailure { return new MaintenanceFailure("unsupported_durability", "source-file-native-p0"); }
function mapNative(error: unknown): MaintenanceFailure {
  if (error instanceof MaintenanceFailure) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ERR_SOURCE_UNSUPPORTED") return unavailable();
  if (code === "ERR_SOURCE_MISSING") return new MaintenanceFailure("source_missing", "source-file-native");
  return new MaintenanceFailure("source_changed", "source-file-native");
}
function load(): NativeSourceBinding {
  if (process.platform !== "linux" || Number(process.versions.napi) < 8 || process.getuid === undefined) throw unavailable();
  try {
    const info = lstatSync(sourceFileNativePath);
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o700 ||
      info.uid !== process.getuid() || realpathSync(sourceFileNativePath) !== sourceFileNativePath) throw unavailable();
    installed ??= createRequire(import.meta.url)(sourceFileNativePath) as NativeSourceBinding;
    if (!installed || methods.some(method => typeof installed![method] !== "function")) throw unavailable();
    return installed;
  } catch { throw unavailable(); }
}
function checkedObservation(value: NativeObservation): NativeObservation {
  if (!value || !["file", "directory"].includes(value.kind) ||
      statFields.some(key => typeof value[key] !== "bigint") ||
      value.dev < 0n || value.ino < 0n || value.size < 0n ||
      value.uid !== BigInt(process.getuid!()) ||
      (value.kind === "file" && value.nlink !== 1n)) throw new MaintenanceFailure("source_changed", "source-file-native");
  return Object.freeze({ ...value });
}
function checkLeaf(name: string): void {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0") ||
    Buffer.byteLength(name) > 1024) throw new MaintenanceFailure("source_changed", "source-file-native");
}

/** The constructor is not an input seam: only the native module can mint its owner. */
export class SourceFileHandle {
  readonly #owner: NativeOwner;
  readonly #binding: NativeSourceBinding;
  #closed = false;
  #unknown = false;
  private constructor(owner: NativeOwner, binding: NativeSourceBinding) {
    this.#owner = owner;
    this.#binding = binding;
  }
  static async openRoot(root: string): Promise<SourceFileHandle> {
    if (!path.isAbsolute(root) || path.resolve(root) !== root) throw new MaintenanceFailure("source_changed", "source-file-root");
    const binding = load();
    try { return new SourceFileHandle(binding.openRoot(root), binding); }
    catch (error) { throw mapNative(error); }
  }
  #requireOpen(): void {
    if (this.#closed || this.#unknown) throw new MaintenanceFailure("source_changed", "source-file-owner-closed");
  }
  async openChild(name: string): Promise<SourceFileHandle> {
    this.#requireOpen();
    checkLeaf(name);
    try { return new SourceFileHandle(this.#binding.openChild(this.#owner, name), this.#binding); }
    catch (error) { throw mapNative(error); }
  }
  async observe(): Promise<NativeObservation> {
    this.#requireOpen();
    try { return checkedObservation(this.#binding.observe(this.#owner)); }
    catch (error) { throw mapNative(error); }
  }
  async readAt(position: bigint, length: number): Promise<Buffer> {
    this.#requireOpen();
    if (typeof position !== "bigint" || position < 0n || position > BigInt(Number.MAX_SAFE_INTEGER) ||
      !Number.isInteger(length) || length < 0 || length > 65_536 ||
      position + BigInt(length) > BigInt(Number.MAX_SAFE_INTEGER))
      throw new MaintenanceFailure("source_changed", "source-file-read-budget");
    try {
      const result = this.#binding.readAt(this.#owner, position, length);
      if (!(result instanceof Uint8Array) || result.byteLength > length) throw new MaintenanceFailure("source_changed", "source-file-read");
      return Buffer.from(result);
    } catch (error) { throw mapNative(error); }
  }
  async readDirectory(): Promise<readonly { readonly name: string; readonly type: number }[]> {
    this.#requireOpen();
    try {
      const entries = this.#binding.readDirectory(this.#owner);
      if (!Array.isArray(entries) || entries.length > 4096) throw new MaintenanceFailure("source_changed", "source-file-enumeration");
      const seen = new Set<string>(), result: { name: string; type: number }[] = [];
      for (const item of entries) {
        if (!(item.name instanceof Uint8Array) || !Number.isInteger(item.type) ||
          item.type < 0 || item.type > 255) throw new MaintenanceFailure("source_changed", "source-file-enumeration");
        const name = decoder.decode(item.name);
        checkLeaf(name);
        if (seen.has(name)) throw new MaintenanceFailure("source_changed", "source-file-duplicate");
        seen.add(name); result.push({ name, type: item.type });
      }
      result.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
      return Object.freeze(result.map(entry => Object.freeze(entry)));
    } catch (error) { throw mapNative(error); }
  }
  /** Close is never retried by numeric fd. An unknown result stays unknown. */
  async close(): Promise<void> {
    this.#requireOpen();
    try { this.#binding.close(this.#owner); this.#closed = true; }
    catch (error) { this.#unknown = true; throw mapNative(error); }
  }
}
export const openSourceRoot = (root: string): Promise<SourceFileHandle> => SourceFileHandle.openRoot(root);

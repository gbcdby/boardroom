import { constants, close as closeRaw, fstat as statRaw, fstatSync, lstatSync, realpathSync, type BigIntStats } from "node:fs";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { MaintenanceFailure } from "./error.ts";

/** A restore-only seam. Names are single leaves, never paths relative to an unpinned ancestor. */
export interface RestoreDirectoryNativeBinding {
  mkdirAt(fd: number, name: string, device: bigint, inode: bigint): Promise<void>;
  openDirectoryAt(fd: number, name: string, device: bigint, inode: bigint): Promise<number>;
  createAt(fd: number, name: string, device: bigint, inode: bigint): Promise<number>;
  readAt(fd: number, name: string, device: bigint, inode: bigint): Promise<number>;
}
export interface RestoreDirectory {
  mkdir(name: string, created: () => void): Promise<void>;
  directory(name: string): Promise<FileHandle>;
  create(name: string): Promise<FileHandle>;
  read(name: string): Promise<FileHandle>;
}
/** Preserve the first acquisition failure if closing another owned FD also fails. */
export class RestoreDirectoryFailure extends Error {
  override readonly cause: unknown;
  readonly closeErrors: readonly unknown[];
  readonly closing: boolean;
  constructor(cause: unknown, closeErrors: readonly unknown[], closing: boolean) {
    super("file-restore-descriptor"); this.cause = cause; this.closeErrors = closeErrors; this.closing = closing;
  }
}
type Identity = Pick<BigIntStats, "dev" | "ino">;
const unavailable = () => new MaintenanceFailure("restore_verification_unavailable");
const invalid = () => new MaintenanceFailure("snapshot_invalid");
const fields = ["dev", "ino", "mode", "uid", "nlink", "size", "mtimeNs", "ctimeNs"] as const;
const same = (a: BigIntStats, b: BigIntStats) => fields.every(field => a[field] === b[field]);
const rawStat = (fd: number): Promise<BigIntStats> => new Promise((resolve, reject) => {
  statRaw(fd, { bigint: true }, (error, info) => error ? reject(error) : resolve(info));
});
const rawClose = (fd: number): Promise<void> => new Promise((resolve, reject) => closeRaw(fd, error => error ? reject(error) : resolve()));
function nativeFailure(error: unknown): never {
  const facts = error as { syscall?: unknown; closeErrors?: unknown } | null;
  if (facts?.syscall === "close-borrowed-directory" || Array.isArray(facts?.closeErrors) && facts.closeErrors.length > 0)
    throw new RestoreDirectoryFailure(error, Array.isArray(facts.closeErrors) ? facts.closeErrors : [], facts.syscall === "close-borrowed-directory");
  throw error;
}
function argumentsFor(directory: FileHandle, identity: Identity, name: string): [number, string, bigint, bigint] {
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\0")
    || Buffer.byteLength(name) > 4096 || !Number.isSafeInteger(directory.fd) || directory.fd < 0) throw invalid();
  const info = fstatSync(directory.fd, { bigint: true });
  if (!info.isDirectory() || info.uid !== BigInt(process.getuid!()) || (info.mode & 0o7777n) !== 0o700n
    || info.dev !== identity.dev || info.ino !== identity.ino) throw invalid();
  return [directory.fd, name, identity.dev, identity.ino];
}
function checkOpened(info: BigIntStats, directory: boolean): void {
  if (info.uid !== BigInt(process.getuid!()) || (info.mode & 0o7777n) !== (directory ? 0o700n : 0o600n)
    || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1n || info.size < 0n)) throw invalid();
}

/** Production uses only the checked package binding; the constructor also permits portable ABI controls. */
export class NativeRestoreDirectory implements RestoreDirectory {
  private readonly parent: FileHandle;
  private readonly identity: Identity;
  private readonly binding: RestoreDirectoryNativeBinding;
  constructor(parent: FileHandle, identity: Identity, binding: RestoreDirectoryNativeBinding) {
    this.parent = parent; this.identity = identity; this.binding = binding;
  }
  async mkdir(name: string, created: () => void): Promise<void> {
    try { await this.binding.mkdirAt(...argumentsFor(this.parent, this.identity, name)); }
    catch (error) {
      // The native syscall may have succeeded before a borrowed-directory close failed.
      if ((error as { created?: unknown } | null)?.created === true) created();
      nativeFailure(error);
    }
    created();
  }
  private async acquire(name: string, action: "directory" | "create" | "read"): Promise<FileHandle> {
    const args = argumentsFor(this.parent, this.identity, name);
    const method = action === "directory" ? this.binding.openDirectoryAt : action === "create" ? this.binding.createAt : this.binding.readAt;
    const raw = await method(...args).catch(nativeFailure);
    let rawOwned = Number.isSafeInteger(raw) && raw >= 0, handle: FileHandle | undefined;
    let failed = false, firstError: unknown, closing = false; const closeErrors: unknown[] = [];
    try {
      if (!rawOwned) throw unavailable();
      const before = await rawStat(raw); checkOpened(before, action === "directory");
      // This is the terminal FD itself. Darwin cannot traverse /dev/fd/N/child.
      handle = await open(`/dev/fd/${raw}`, (action === "create" ? constants.O_RDWR : constants.O_RDONLY)
        | (process.platform === "darwin" ? constants.O_NOFOLLOW : 0));
      const adopted = await handle.stat({ bigint: true }); checkOpened(adopted, action === "directory");
      if (!same(before, adopted) || !same(before, await rawStat(raw))) throw invalid();
      rawOwned = false; closing = true; await rawClose(raw); closing = false;
      const result = handle; handle = undefined; return result;
    } catch (error) { failed = true; firstError = error; }
    finally {
      if (rawOwned) {
        rawOwned = false;
        try { await rawClose(raw); } catch (error) { closeErrors.push(error); if (!failed) { failed = true; firstError = error; closing = true; } }
      }
      if (handle) {
        const owned = handle; handle = undefined;
        try { await owned.close(); } catch (error) { closeErrors.push(error); if (!failed) { failed = true; firstError = error; closing = true; } }
      }
    }
    throw new RestoreDirectoryFailure(firstError, closeErrors, closing);
  }
  directory(name: string): Promise<FileHandle> { return this.acquire(name, "directory"); }
  create(name: string): Promise<FileHandle> { return this.acquire(name, "create"); }
  read(name: string): Promise<FileHandle> { return this.acquire(name, "read"); }
}

export const restoreDirectoryNativePath = fileURLToPath(new URL(
  `../../../../build/maintenance-platform/maintenance-restore-directory-${process.arch}.node`, import.meta.url));
let loaded: RestoreDirectoryNativeBinding | undefined;
function loadNative(): RestoreDirectoryNativeBinding {
  if (process.platform !== "darwin" || Number(process.versions.napi) < 8) throw unavailable();
  try {
    const info = lstatSync(restoreDirectoryNativePath);
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o7777) !== 0o700 || info.uid !== process.getuid?.()
      || realpathSync(restoreDirectoryNativePath) !== restoreDirectoryNativePath) throw unavailable();
    loaded ??= createRequire(import.meta.url)(restoreDirectoryNativePath) as RestoreDirectoryNativeBinding;
    if ([loaded.mkdirAt, loaded.openDirectoryAt, loaded.createAt, loaded.readAt].some(method => typeof method !== "function")) throw unavailable();
    return loaded;
  } catch { throw unavailable(); }
}
export function assertRestoreDirectoryAvailable(): void {
  if (process.platform === "linux") return;
  if (process.platform === "darwin") { loadNative(); return; }
  throw unavailable();
}
export function restoreDirectory(parent: FileHandle, identity: Identity): RestoreDirectory {
  if (process.platform === "darwin") return new NativeRestoreDirectory(parent, identity, loadNative());
  if (process.platform !== "linux") throw unavailable();
  const leafPath = (name: string) => { const [fd] = argumentsFor(parent, identity, name); return `/proc/self/fd/${fd}/${name}`; };
  const acquire = async (name: string, flags: number, directory: boolean) => {
    const handle = await open(leafPath(name), flags, 0o600);
    try { checkOpened(await handle.stat({ bigint: true }), directory); return handle; }
    catch (error) {
      const closeErrors: unknown[] = [];
      try { await handle.close(); } catch (closeError) { closeErrors.push(closeError); }
      throw new RestoreDirectoryFailure(error, closeErrors, false);
    }
  };
  return {
    mkdir: async (name, created) => { await mkdir(leafPath(name), { mode: 0o700 }); created(); },
    directory: name => acquire(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW, true),
    create: name => acquire(name, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, false),
    read: name => acquire(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, false),
  };
}

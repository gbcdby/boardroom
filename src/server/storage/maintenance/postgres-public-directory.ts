import { constants, close as closeRaw, fstat as statRaw, lstatSync, realpathSync, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MaintenanceFailure } from "./error.ts";

export type PublicFileStat = Pick<BigIntStats, "dev" | "ino" | "mode" | "uid" | "nlink" | "size" | "mtimeNs" | "ctimeNs" | "isFile">;
type NativeStat = Omit<PublicFileStat, "isFile">;
export interface PublicDirectoryNativeBinding {
  createAt(fd: number, name: string, device: bigint, inode: bigint): Promise<number>;
  readAt(fd: number, name: string, device: bigint, inode: bigint): Promise<number>;
  statAt(fd: number, name: string, device: bigint, inode: bigint): Promise<NativeStat>;
}
export interface PublicDirectoryFiles {
  create(name: string): Promise<FileHandle>;
  read(name: string): Promise<FileHandle>;
  stat(name: string): Promise<PublicFileStat>;
}
const fields = ["dev", "ino", "mode", "uid", "nlink", "size", "mtimeNs", "ctimeNs"] as const;
const leaf = /^\.public-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}-(archive\.dump|complete\.toc|namespace\.list|body\.list|namespace\.sql|body\.sql)$/;
const unavailable = () => new MaintenanceFailure("restore_verification_unavailable");
const same = (a: NativeStat, b: NativeStat) => fields.every(field => a[field] === b[field]);
const fdStat = (fd: number): Promise<BigIntStats> => new Promise((resolve, reject) => {
  statRaw(fd, { bigint: true }, (error, stat) => error ? reject(error) : resolve(stat));
});
const fdClose = (fd: number): Promise<void> => new Promise((resolve, reject) => {
  closeRaw(fd, error => error ? reject(error) : resolve());
});
function nativeStat(value: NativeStat): PublicFileStat {
  if (!value || fields.some(field => typeof value[field] !== "bigint")
    || (value.mode & 0o170000n) !== 0o100000n || (value.mode & 0o777n) !== 0o600n || value.nlink !== 1n
    || value.uid !== BigInt(process.getuid!()) || value.size < 0n) throw new MaintenanceFailure("snapshot_invalid");
  return { ...value, isFile: () => true };
}
function nativeError(error: unknown): never {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ERR_DIRECTORY_IDENTITY") throw new MaintenanceFailure("target_conflict");
  if (code === "ERR_FILE_IDENTITY") throw new MaintenanceFailure("snapshot_invalid");
  throw error;
}

/** Internal seam: production supplies only the package's checked native binding. */
export class NativePublicDirectory implements PublicDirectoryFiles {
  private readonly directory: FileHandle;
  private readonly identity: Pick<BigIntStats, "dev" | "ino">;
  private readonly binding: PublicDirectoryNativeBinding;
  private readonly check: () => void;
  constructor(directory: FileHandle, identity: Pick<BigIntStats, "dev" | "ino">,
    binding: PublicDirectoryNativeBinding, check: () => void) {
    this.directory = directory; this.identity = identity; this.binding = binding; this.check = check;
  }

  private arguments(name: string): [number, string, bigint, bigint] {
    this.check();
    if (!leaf.test(name) || !Number.isSafeInteger(this.directory.fd) || this.directory.fd < 0) throw unavailable();
    return [this.directory.fd, name, this.identity.dev, this.identity.ino];
  }
  async stat(name: string): Promise<PublicFileStat> {
    const value = await this.binding.statAt(...this.arguments(name)).catch(nativeError);
    this.check(); return nativeStat(value);
  }
  private async acquire(name: string, create: boolean): Promise<FileHandle> {
    // This precheck rejects already visible nonregular entries. The native read still
    // uses O_NONBLOCK|O_NOFOLLOW and fstat, because the entry may change after statAt.
    if (!create) await this.stat(name);
    const args = this.arguments(name);
    const raw = await (create ? this.binding.createAt(...args) : this.binding.readAt(...args)).catch(nativeError);
    let rawOwned = Number.isSafeInteger(raw) && raw >= 0;
    let handle: FileHandle | undefined;
    try {
      // From the first operation after receipt, all metadata/cancellation/adoption
      // errors are covered by the finally block that owns this exact descriptor.
      if (!rawOwned) throw unavailable();
      this.check();
      const before = nativeStat(await fdStat(raw));
      this.check();
      // Darwin fdesc duplicates this newly opened file description. This is a
      // terminal descriptor path, never directory-FD/leaf traversal.
      handle = await open(`/dev/fd/${raw}`, (create ? constants.O_RDWR : constants.O_RDONLY)
        | (process.platform === "darwin" ? constants.O_NOFOLLOW : 0));
      if (!same(before, nativeStat(await handle.stat({ bigint: true })))
        || !same(before, nativeStat(await fdStat(raw)))) throw new MaintenanceFailure("snapshot_invalid");
      this.check();
      // Attempt close once; a failure prevents success and also closes adoption.
      rawOwned = false; await fdClose(raw);
      this.check();
      const result = handle; handle = undefined; return result;
    } finally {
      try { if (rawOwned) { rawOwned = false; await fdClose(raw); } }
      finally { await handle?.close(); }
    }
  }
  create(name: string): Promise<FileHandle> { return this.acquire(name, true); }
  read(name: string): Promise<FileHandle> { return this.acquire(name, false); }
}

export const publicDirectoryNativePath = fileURLToPath(new URL(
  `../../../../build/maintenance-platform/postgres-public-directory-${process.arch}.node`, import.meta.url));
let loaded: PublicDirectoryNativeBinding | undefined;
export function loadPublicDirectoryNative(): PublicDirectoryNativeBinding {
  if (process.platform !== "darwin" || Number(process.versions.napi) < 8) throw unavailable();
  try {
    const info = lstatSync(publicDirectoryNativePath);
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.()
      || realpathSync(publicDirectoryNativePath) !== publicDirectoryNativePath) throw unavailable();
    loaded ??= createRequire(import.meta.url)(publicDirectoryNativePath) as PublicDirectoryNativeBinding;
    if ([loaded.createAt, loaded.readAt, loaded.statAt].some(value => typeof value !== "function")) throw unavailable();
    return loaded;
  } catch { throw unavailable(); }
}

export function publicDirectoryFiles(directory: FileHandle, identity: Pick<BigIntStats, "dev" | "ino">,
  check: () => void): PublicDirectoryFiles {
  if (process.platform === "darwin") return new NativePublicDirectory(directory, identity, loadPublicDirectoryNative(), check);
  if (process.platform !== "linux") throw unavailable();
  // Keep the already validated Linux mechanism and flags. The Darwin branch does
  // not retry with this path if its native capability or identity checks fail.
  const path = (name: string) => { check(); if (!leaf.test(name)) throw unavailable(); return join(`/dev/fd/${directory.fd}`, name); };
  return {
    create: name => open(path(name), constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR, 0o600),
    read: name => open(path(name), constants.O_RDONLY | constants.O_NOFOLLOW),
    stat: name => lstat(path(name), { bigint: true }),
  };
}

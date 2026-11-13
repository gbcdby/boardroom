import { constants, fstatSync } from "node:fs";
import { open, statfs, type FileHandle } from "node:fs/promises";
import { darwinFileSystem, assertDarwinMaintenanceAvailable } from "./darwin.ts";
import { MaintenanceFailure } from "./error.ts";

export function assertMaintenancePlatform(): void {
  if (process.platform === "linux") return;
  if (process.platform === "darwin") { assertDarwinMaintenanceAvailable(); return; }
  throw new MaintenanceFailure("unsupported_durability");
}
/** Darwin uses a no-fallback native call, not libuv's F_FULLFSYNC -> barrier -> fsync chain. */
export async function syncMaintenanceHandle(handle: FileHandle): Promise<void> {
  if (process.platform === "darwin") { darwinFileSystem(handle.fd, true); return; }
  assertMaintenancePlatform(); await handle.sync();
}
/** Used only for native SQLite FDs already proved to belong to this adapter. */
export function fullSyncDarwinDatabaseHandle(fd: number, identity: string): void {
  if (process.platform !== "darwin") return;
  const info = fstatSync(fd, { bigint: true });
  if (!info.isFile() || info.nlink !== 1n || `${info.dev}:${info.ino}` !== identity) throw new MaintenanceFailure("source_changed");
  darwinFileSystem(fd, true);
}
export async function maintenanceFilesystem(root: string): Promise<
  | { platform: "linux"; filesystemType: string; guarantee: "observed-file-fsync-rename-directory-fsync" }
  | { platform: "darwin"; filesystemType: "apfs"; guarantee: "observed-file-and-directory-fullfsync-rename" }
> {
  assertMaintenancePlatform();
  if (process.platform === "darwin") {
    const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { darwinFileSystem(directory.fd); } finally { await directory.close(); }
    return { platform: "darwin", filesystemType: "apfs", guarantee: "observed-file-and-directory-fullfsync-rename" };
  }
  const stats = await statfs(root);
  if (![0x794c7630, 0xef53, 0x58465342].includes(stats.type)) throw new MaintenanceFailure("unsupported_durability");
  return { platform: "linux", filesystemType: String(stats.type), guarantee: "observed-file-fsync-rename-directory-fsync" };
}

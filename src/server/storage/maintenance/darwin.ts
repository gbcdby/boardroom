import { spawnSync } from "node:child_process";
import { fstatSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { MaintenanceFailure } from "./error.ts";
import type Database from "better-sqlite3";

const binary = fileURLToPath(new URL(`../../../../build/maintenance-platform/maintenance-darwin-${process.arch}`, import.meta.url));
const sqliteBinary = fileURLToPath(new URL(`../../../../build/maintenance-platform/maintenance-sqlite-darwin-${process.arch}.dylib`, import.meta.url));
const numberText = z.string().regex(/^\d+$/);
const handle = z.object({ kind: z.literal("handle"), pid: z.number().int().positive(), startSeconds: numberText, startMicroseconds: numberText,
  key: z.string().regex(/^(fd:\d+|map:\d+:\d+)$/), fd: z.number().int().min(-1), path: z.string().max(4096),
  device: numberText, inode: numberText, links: numberText }).strict();
const unreadable = z.object({ kind: z.literal("unreadable"), pid: z.number().int().positive(), reason: z.string().regex(/^[a-z-]+$/) }).strict();
const inventory = z.object({ version: z.literal(1), scope: z.enum(["parent", "current-uid"]), items: z.array(z.discriminatedUnion("kind", [handle, unreadable])) }).strict();
const filesystem = z.object({ version: z.literal(1), filesystemType: z.literal("apfs"), local: z.literal(true), ownershipEnforced: z.literal(true), acl: z.literal("none"), fullfsync: z.boolean(),
  kind: z.enum(["file", "directory"]), device: numberText, inode: numberText }).strict();
export type DarwinSourceHandle = z.infer<typeof handle>;
export type DarwinSourceInventory = z.infer<typeof inventory>;
export interface DarwinSourceScope { readonly files: readonly string[]; readonly trees?: readonly string[] }

/** The executable is fixed by this package; callers cannot supply a command, shell or executable. */
function native(command: "host" | "filesystem" | "fullsync" | "parent-handles" | "source-users" | "process", arguments_: readonly string[] = [], fd?: number): unknown {
  assertDarwinMaintenanceAvailable();
  const result = spawnSync(binary, [command, ...arguments_], { encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
    stdio: fd === undefined ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe", fd] });
  if (result.error || result.status !== 0 || result.signal !== null) throw new MaintenanceFailure("unsupported_durability");
  try { return JSON.parse(result.stdout); } catch { throw new MaintenanceFailure("unsupported_durability"); }
}
const processBase = { version: z.literal(1), pid: z.number().int().positive(), bootSessionUuid: z.string().uuid() };
const processObservation = z.discriminatedUnion("status", [
  z.object({ ...processBase, status: z.literal("absent") }).strict(),
  z.object({ ...processBase, status: z.literal("present"), uid: z.number().int().nonnegative(), startSeconds: numberText, startMicroseconds: numberText }).strict(),
]);
/** Read-only, current-user process identity. This is not a managed-wrapper exit proof. */
export function darwinProcessObservation(pid: number): z.infer<typeof processObservation> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new MaintenanceFailure("source_writer_unknown");
  try {
    const parsed = processObservation.safeParse(native("process", [String(pid)]));
    if (!parsed.success || parsed.data.pid !== pid || parsed.data.status === "present" && parsed.data.uid !== process.getuid?.()) throw new Error();
    return parsed.data;
  } catch { throw new MaintenanceFailure("source_writer_unknown"); }
}
export function darwinCurrentProcessIdentity(): Record<string, unknown> {
  const observed = darwinProcessObservation(process.pid);
  if (observed.status !== "present") throw new MaintenanceFailure("source_writer_unknown");
  return { version: 1, platform: "darwin", pid: observed.pid, verification: "darwin_proc_identity_v1", uid: observed.uid,
    bootSessionUuid: observed.bootSessionUuid, startSeconds: observed.startSeconds, startMicroseconds: observed.startMicroseconds };
}
export function assertDarwinMaintenanceAvailable(): void {
  try {
    if (process.platform !== "darwin") throw new Error();
    for (const file of [binary, sqliteBinary]) {
      const info = lstatSync(file);
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.()
        || realpathSync(file) !== file) throw new Error();
    }
  } catch { throw new MaintenanceFailure("unsupported_durability"); }
}
export function bindDarwinSqliteSource(database: Database.Database): void {
  assertDarwinMaintenanceAvailable();
  try { database.loadExtension(sqliteBinary); assertDarwinSqliteSource(database); }
  catch { throw new MaintenanceFailure("source_changed"); }
}
export function assertDarwinSqliteSource(database: Database.Database): void {
  try {
    if ((database.prepare("SELECT boardroom_maintenance_source_unchanged() AS unchanged").get() as { unchanged: number }).unchanged !== 1) throw new Error();
  } catch { throw new MaintenanceFailure("source_changed"); }
}
let hostUuid: string | undefined;
export function darwinHostUuid(): string {
  if (hostUuid !== undefined) return hostUuid;
  const result = z.object({ version: z.literal(1), hostUuid: z.string().uuid() }).strict().safeParse(native("host"));
  if (!result.success || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(result.data.hostUuid)) throw new MaintenanceFailure("unsupported_durability");
  return hostUuid = result.data.hostUuid;
}
export function darwinFileSystem(fd: number, fullSync = false): z.infer<typeof filesystem> {
  if (!Number.isSafeInteger(fd) || fd < 0) throw new MaintenanceFailure("unsupported_durability");
  try {
    const before = fstatSync(fd, { bigint: true });
    const parsed = filesystem.safeParse(native(fullSync ? "fullsync" : "filesystem", [], fd));
    const after = fstatSync(fd, { bigint: true });
    if (!parsed.success || parsed.data.fullfsync !== fullSync || parsed.data.device !== String(before.dev) || parsed.data.inode !== String(before.ino)
      || before.dev !== after.dev || before.ino !== after.ino || before.nlink !== after.nlink
      || parsed.data.kind !== (before.isDirectory() ? "directory" : "file")) throw new Error();
    return parsed.data;
  } catch { throw new MaintenanceFailure("unsupported_durability"); }
}
export function darwinSourceInventory(scope: DarwinSourceScope, parentOnly: boolean): DarwinSourceInventory {
  const arguments_: string[] = [];
  for (const [kind, values] of [["f", scope.files], ["d", scope.trees ?? []]] as const) for (const file of values) {
    if (!path.isAbsolute(file) || path.resolve(file) !== file || file === "/" || file.includes("\0")) throw new MaintenanceFailure("source_changed");
    arguments_.push(`${kind}:${file}`);
  }
  if (!arguments_.length || arguments_.length > 16) throw new MaintenanceFailure("source_changed");
  try {
    const parsed = inventory.safeParse(native(parentOnly ? "parent-handles" : "source-users", arguments_));
    if (!parsed.success || parsed.data.scope !== (parentOnly ? "parent" : "current-uid")
      || parentOnly && parsed.data.items.some(item => item.pid !== process.pid)) throw new Error();
    return parsed.data;
  } catch { throw new MaintenanceFailure("source_writer_unknown"); }
}
export function darwinSourceHandles(files: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const item of darwinSourceInventory({ files }, true).items) {
    if (item.kind === "unreadable" || item.links !== "1") throw new MaintenanceFailure("source_writer_unknown");
    if (result.has(item.key)) throw new MaintenanceFailure("source_writer_unknown");
    result.set(item.key, `${item.device}:${item.inode}`);
  }
  return result;
}

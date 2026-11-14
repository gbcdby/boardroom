import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { readdir, readlink, stat } from "node:fs/promises";
import { release } from "node:os";
import type { Blocker } from "./types.ts";

const MAP_LIMIT = 8 * 1024 * 1024;
const METADATA_LIMIT = 2 * 1024 * 1024;
const READ_LIMIT = 4096;
const UINT64 = (1n << 64n) - 1n;
function unavailable(): never { throw new Error("linux_mapping_inventory_unavailable"); }
function absent(error: unknown): boolean { return ["ENOENT", "ESRCH"].includes(String((error as NodeJS.ErrnoException).code)); }

// Bound both allocation and the number of reads. Reaching a limit is unknown, never EOF.
function procText(file: string, limit: number): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const parts: Buffer[] = [], chunk = Buffer.allocUnsafe(64 * 1024); let bytes = 0;
    for (let reads = 0; reads < READ_LIMIT; reads++) {
      const size = readSync(fd, chunk, 0, Math.min(chunk.length, limit + 1 - bytes), null);
      if (size === 0) return Buffer.concat(parts, bytes).toString("latin1");
      bytes += size;
      if (bytes > limit) unavailable();
      parts.push(Buffer.from(chunk.subarray(0, size)));
    }
    return unavailable();
  } finally { closeSync(fd); }
}

export interface LinuxSourceMappingIdentity {
  readonly file: string;
  readonly identity: string; // stat identity, still bound to the selected source
  readonly mappedIdentity: string; // kernel s_dev major/minor + i_ino
}
export interface LinuxMapping { readonly key: string; readonly mappedIdentity: string }

/** Paths and permissions are not identity evidence; retain every file-backed mapping, including readonly ones. */
export function parseLinuxMappings(text: string): readonly LinuxMapping[] {
  if (text.length > MAP_LIMIT || (text.length && !text.endsWith("\n"))) unavailable();
  const result: LinuxMapping[] = []; let previousEnd = 0n;
  for (const line of text.split("\n").slice(0, -1)) {
    const match = /^([0-9a-f]{1,16})-([0-9a-f]{1,16}) ([r-][w-][x-][ps]) ([0-9a-f]{1,16}) ([0-9a-f]{1,8}):([0-9a-f]{1,8}) ([0-9]{1,20})(?:[ \t][^\n]*)?$/.exec(line);
    if (!match || result.length >= 131072) unavailable();
    const start = BigInt(`0x${match[1]}`), end = BigInt(`0x${match[2]}`), inode = BigInt(match[7]!);
    if (end <= start || start < previousEnd || inode > UINT64) unavailable();
    previousEnd = end;
    result.push({ key: `map:${start}:${end}:${BigInt(`0x${match[4]}`)}:${match[3]}`,
      mappedIdentity: `${BigInt(`0x${match[5]}`)}:${BigInt(`0x${match[6]}`)}:${inode}` });
  }
  return result;
}

/** fdinfo and mountinfo expose the kernel inode/superblock used by maps, even when getattr synthesizes stat values. */
export function linuxMappingIdentity(fdinfo: string, mountinfo: string): string {
  if (!fdinfo.endsWith("\n") || !mountinfo.endsWith("\n")) unavailable();
  const fields = (name: string) => fdinfo.split("\n").filter(line => line.startsWith(`${name}:`));
  const mounts = fields("mnt_id"), inodes = fields("ino");
  if (mounts.length !== 1 || inodes.length !== 1) unavailable();
  const mount = /^mnt_id:\s+([1-9][0-9]*)$/.exec(mounts[0]!), inode = /^ino:\s+([1-9][0-9]{0,19})$/.exec(inodes[0]!);
  if (!mount || !inode || BigInt(inode[1]!) > UINT64) unavailable();
  const records = mountinfo.split("\n").filter(line => line.split(" ")[0] === mount[1]);
  if (records.length !== 1) unavailable();
  const parts = records[0]!.split(" "), separator = parts.indexOf("-");
  const device = /^([0-9]{1,10}):([0-9]{1,10})$/.exec(parts[2] ?? "");
  if (!device || separator < 6 || parts.length !== separator + 4
    || BigInt(device[1]!) > 0xffffffffn || BigInt(device[2]!) > 0xffffffffn) unavailable();
  return `${BigInt(device[1]!)}:${BigInt(device[2]!)}:${BigInt(inode[1]!)}`;
}

export function linuxSourceMappingIdentities(files: readonly string[]): readonly LinuxSourceMappingIdentity[] {
  const mounts = procText("/proc/self/mountinfo", METADATA_LIMIT), result: LinuxSourceMappingIdentity[] = [];
  for (const [index, file] of files.entries()) {
    let fd: number;
    try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (index !== 0 && (error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    try {
      const native = fstatSync(fd, { bigint: true });
      if (!native.isFile() || native.nlink !== 1n) unavailable();
      const mappedIdentity = linuxMappingIdentity(procText(`/proc/self/fdinfo/${fd}`, 64 * 1024), mounts);
      const named = lstatSync(file, { bigint: true });
      if (!named.isFile() || named.nlink !== 1n || named.dev !== native.dev || named.ino !== native.ino) unavailable();
      if (result.some(source => source.mappedIdentity === mappedIdentity)) unavailable();
      result.push({ file, identity: `${native.dev}:${native.ino}`, mappedIdentity });
    } finally { closeSync(fd); }
  }
  return result;
}

export function linuxMappedSourceHandles(directory: string, sources: readonly LinuxSourceMappingIdentity[]) {
  const text = procText(`${directory}/maps`, MAP_LIMIT), handles = new Map<string, string>();
  const identities = new Map(sources.map(source => [source.mappedIdentity, source.identity]));
  for (const mapping of parseLinuxMappings(text)) {
    const identity = identities.get(mapping.mappedIdentity);
    if (identity !== undefined) handles.set(mapping.key, identity);
  }
  return { handles, empty: text.length === 0 };
}

function processIdentity(directory: string) {
  const text = procText(`${directory}/stat`, 8192), end = text.lastIndexOf(") ");
  const pid = /^([1-9][0-9]*) \(/.exec(text), fields = text.slice(end + 2).trim().split(/\s+/);
  if (!pid || end < 0 || !/^[A-Za-z]$/.test(fields[0] ?? "") || !/^[1-9][0-9]*$/.test(fields[17] ?? "")
    || !/^[0-9]{1,20}$/.test(fields[19] ?? "")) unavailable();
  return { pid: pid[1]!, startTicks: fields[19]!, state: fields[0]!, threads: fields[17]! };
}
function processGone(directory: string): boolean {
  try { processIdentity(directory); return false; }
  catch (error) { return absent(error); }
}

// Upstream 6.8 fixed stacked-file maps to use file_user_inode (3efdc78fdc21).
// Older/vendor kernels without that contract must not claim an empty, complete inventory.
export function linuxMappingIdentityAvailable(kernelRelease: string): boolean {
  const match = /^([0-9]+)\.([0-9]+)(?:\.|-)/.exec(kernelRelease);
  return !!match && (Number(match[1]) > 6 || (Number(match[1]) === 6 && Number(match[2]) >= 8));
}

export async function inspectLinuxSourceProcesses(files: readonly string[], sessions: string, ownHandles: ReadonlyMap<string, string>): Promise<Blocker[]> {
  const blockers: Blocker[] = [], uid = process.getuid!();
  const unknown = (pid: string) => blockers.push({ code: "source_writer_unknown", subjectRef: `unreadable-process:${pid}` });
  let sources: readonly LinuxSourceMappingIdentity[] | undefined;
  try { if (!linuxMappingIdentityAvailable(release())) unavailable(); sources = linuxSourceMappingIdentities(files); }
  catch { blockers.push({ code: "source_writer_unknown", subjectRef: "os-inventory-unavailable" }); }
  let pids: string[];
  try { pids = (await readdir("/proc")).filter(entry => /^[1-9][0-9]*$/.test(entry)); }
  catch { return [...blockers, { code: "source_writer_unknown", subjectRef: "os-inventory-unavailable" }]; }
  for (const pid of pids) {
    let processFd: number | undefined, directory: string | undefined;
    try {
      processFd = openSync(`/proc/${pid}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      if (fstatSync(processFd).uid !== uid) continue;
      // The open proc directory pins this process identity, not the numeric PID after possible reuse.
      directory = `/proc/self/fd/${processFd}`;
      const before = processIdentity(directory);
      if (before.pid !== pid) unavailable();
      for (const fd of await readdir(`${directory}/fd`)) {
        try {
          const file = `${directory}/fd/${fd}`, target = (await readlink(file)).replace(/ \(deleted\)$/, "");
          if (!files.includes(target) && target !== sessions && !target.startsWith(`${sessions}/`)) continue;
          const info = await stat(file, { bigint: true });
          if (Number(pid) === process.pid && ownHandles.get(`fd:${fd}`) === `${info.dev}:${info.ino}`) continue;
          blockers.push({ code: "source_writer_unknown", subjectRef: `os-process:${pid}` });
        } catch (error) { if (!["ENOENT", "ESRCH", "EBADF"].includes(String((error as NodeJS.ErrnoException).code))) unknown(pid); }
      }
      const mapped = sources === undefined ? undefined : linuxMappedSourceHandles(directory, sources);
      for (const [key, identity] of mapped?.handles ?? [])
        if (Number(pid) !== process.pid || ownHandles.get(key) !== identity)
          blockers.push({ code: "source_writer_unknown", subjectRef: `os-process:${pid}` });
      const after = processIdentity(directory);
      if (after.pid !== before.pid || after.startTicks !== before.startTicks || fstatSync(processFd).uid !== uid) unavailable();
      // An empty maps read while a userspace process is alive is not proof of absence (e.g. exec/main-thread races).
      if (mapped?.empty && !(before.state === "Z" && after.state === "Z" && before.threads === "1" && after.threads === "1")) unavailable();
    } catch (error) {
      if (!absent(error) || (directory !== undefined && !processGone(directory))) unknown(pid);
    } finally { if (processFd !== undefined) closeSync(processFd); }
  }
  if (sources !== undefined) {
    try { if (JSON.stringify(sources) !== JSON.stringify(linuxSourceMappingIdentities(files))) unavailable(); }
    catch { blockers.push({ code: "source_writer_unknown", subjectRef: "os-inventory-unavailable" }); }
  }
  return blockers;
}

import { AsyncLocalStorage } from "node:async_hooks";
import { constants, fstatSync, lstatSync, openSync, closeSync, type BigIntStats } from "node:fs";
import path from "node:path";
import { types as utilTypes } from "node:util";
import { canonicalJson } from "./canonical.ts";
import { MaintenanceFailure, maintenanceFailureCode } from "./error.ts";
import { inspectLinuxFileProcesses, linuxMappingIdentity, readLinuxProcText,
  type LinuxFileProcessOwner, type LinuxFileProcessSelection } from "./linux-mappings.ts";
import type { ControlRootIdentity, FileRoot } from "./types.ts";
import { withNativeSourceRoot } from "./source-file-native.ts";

const O_PATH = 0x200000;
const MAX_WORK_MS = 120_000, MAX_ENTRIES = 250_000, MAX_DEPTH = 128, MAX_BYTES = 16 * 1024 * 1024;
const MAX_CONTENT_BYTES = 1024n * 1024n * 1024n;
interface Window {
  readonly start: number;
  readonly sourceKey?: string;
  entries: number;
  bytes: number;
  contentBytes: bigint;
  failed: boolean;
  failure?: unknown;
  selection?: string;
  baseline?: string;
}
interface Scope {
  readonly state: Window;
  readonly assertHeld: () => Promise<void>;
  readonly parent: Scope | undefined;
  active: boolean;
}
const windows = new AsyncLocalStorage<Scope>();
const failedLocks = new WeakMap<object, unknown>();
// Retain the actual failed owners, never retry or adopt their FD integers. An
// uncertain close cannot be bypassed by a new local window over the same roots.
const unresolved = new Map<string, Set<object>>();
const contains = (parent: string, child: string) => parent === child || child.startsWith(parent === "/" ? "/" : `${parent}/`);
const overlaps = (a: string, b: string) => contains(a, b) || contains(b, a);
const identity = (info: { dev: bigint; ino: bigint }) => `${info.dev}:${info.ino}`;
function fail(code: "source_changed" | "plan_stale" | "source_writer_unknown" | "backup_capability_unavailable" = "source_changed"): never {
  throw new MaintenanceFailure(code, "source-file-writers");
}
function checkedWindow(): Window {
  const scope = windows.getStore();
  if (!scope) throw new MaintenanceFailure("maintenance_lost", "source-file-writers-window");
  for (let current: Scope | undefined = scope; current; current = current.parent)
    if (!current.active) throw new MaintenanceFailure("maintenance_lost", "source-file-writers-window");
  const state = scope.state;
  if (state.failed) throw state.failure;
  if (performance.now() - state.start > MAX_WORK_MS || state.entries > MAX_ENTRIES || state.bytes > MAX_BYTES
    || state.contentBytes > MAX_CONTENT_BYTES) {
    state.failed = true; state.failure = new MaintenanceFailure("backup_capability_unavailable", "source-files-budget");
    throw state.failure;
  }
  return state;
}
function rememberFailure(state: Window, error: unknown): void {
  if (!state.failed) { state.failed = true; state.failure = error; }
}
async function current(): Promise<void> {
  const state = checkedWindow();
  try {
    for (let scope = windows.getStore(); scope; scope = scope.parent) { await scope.assertHeld(); checkedWindow(); }
  }
  catch (error) { rememberFailure(state, error); throw error; }
}
/** Only the actual facts collector creates this dynamic scope. No public mode,
 * clock, deadline or observation value can reset/extend its success budget. */
export async function withSourceFileObservationWindow<T>(assertHeld: () => Promise<void>, consume: () => Promise<T>,
  origin?: { readonly lock: object; readonly root: ControlRootIdentity }): Promise<T> {
  if (origin && failedLocks.has(origin.lock)) throw failedLocks.get(origin.lock);
  const outer = windows.getStore();
  if (outer) checkedWindow();
  const sourceKey = origin ? "source:" + canonicalJson(origin.root) : undefined;
  if (outer && sourceKey !== outer.state.sourceKey) throw new MaintenanceFailure("maintenance_lost", "source-file-writers-window");
  const state: Window = outer?.state ?? { start: performance.now(), ...(sourceKey ? { sourceKey } : {}),
    entries: 0, bytes: 0, contentBytes: 0n, failed: false };
  const scope: Scope = { state, assertHeld, active: true, parent: outer };
  return windows.run(scope, async () => {
    try { await current(); const result = await consume(); await current(); return result; }
    catch (error) { rememberFailure(state, error); if (origin) failedLocks.set(origin.lock, state.failure); throw error; }
    finally { scope.active = false; }
  });
}
/** Source S borrows the same original D0 and charges its real incremental work.
 * Standalone S fixtures retain their original local budget without a facts scope. */
export function sourceFileObservationStart(): number | undefined {
  return windows.getStore() ? checkedWindow().start : undefined;
}
export function chargeSourceFileObservation(entries = 0, bytes = 0, contentBytes = 0n): void {
  if (!windows.getStore()) return;
  const state = checkedWindow();
  if (!Number.isSafeInteger(entries) || entries < 0 || !Number.isSafeInteger(bytes) || bytes < 0 || contentBytes < 0n)
    fail("backup_capability_unavailable");
  state.entries += entries; state.bytes += bytes; state.contentBytes += contentBytes; checkedWindow();
}
function keep(value: unknown): void { chargeSourceFileObservation(0, Buffer.byteLength(canonicalJson(value)) + 1); }
function validLeaf(name: string): boolean {
  return !!name && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\0")
    && Buffer.byteLength(name) <= 255 && new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(name)) === name;
}
function validPath(file: string): boolean {
  return path.posix.isAbsolute(file) && path.posix.resolve(file) === file && !file.includes("\0")
    && Buffer.byteLength(file) <= 4096 && (file === "/" || file.split("/").slice(1).every(validLeaf));
}
const fields = ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "atimeNs", "mtimeNs", "ctimeNs"] as const;
function metadata(info: BigIntStats): readonly string[] { return fields.map(field => String(info[field])); }
function sameMetadata(a: BigIntStats, b: BigIntStats): boolean { return fields.every(field => a[field] === b[field]); }
function mappedFromStat(device: string, inode: string): string {
  // Node's bigint stat can expose ino_t's high bit as a signed int64 (for
  // example an ancestor on a stacked filesystem). fdinfo/maps use uint64.
  // Only normalize this kernel comparison; plan/stat identity stays verbatim.
  const dev = BigInt.asUintN(64, BigInt(device));
  const major = (dev >> 8n & 0xfffn) | (dev >> 32n & 0xfffff000n);
  const minor = (dev & 0xffn) | (dev >> 12n & 0xffffff00n);
  return `${major}:${minor}:${BigInt.asUintN(64, BigInt(inode))}`;
}
interface MetadataOwner {
  readonly fd: number;
  readonly file: string;
  readonly before: BigIntStats;
  readonly mount: string;
  readonly mapped: string;
  readonly flags: bigint;
  selected: boolean;
  attempted: boolean;
}
interface Binding {
  readonly file: string;
  readonly before: BigIntStats;
  readonly mount: string;
  readonly mapped: string;
}

/** Current fileRoots guard. It is assembled only by the SQLite/PG facts adapters
 * from collect's verified plan, never by a request or a persisted audit. */
export async function inspectSourceFileWriters(roots: readonly FileRoot[]): Promise<void> {
  if (process.platform !== "linux") return; // Existing Darwin inventory/profile behavior is unchanged.
  const state = checkedWindow(), owners = new Map<number, MetadataOwner>();
  const closeErrors: unknown[] = [], bindings: Binding[] = [], retainedRoots: MetadataOwner[] = [];
  const seen = new Set<string>();
  const absences: { owner: MetadataOwner; leaf: string }[] = [];
  let failed = false, first: unknown;
  let rootNames: string[] = [];
  const descriptorFlags = (text: string): bigint => {
    const rows = text.split("\n").filter(line => line.startsWith("flags:"));
    const match = rows.length === 1 ? /^flags:\s*([0-7]{1,12})\s*$/.exec(rows[0]!) : null;
    if (!match) fail("source_writer_unknown");
    return BigInt(`0o${match[1]}`);
  };
  const isCurrentOwner = (owner: MetadataOwner): boolean => {
    const actual = fstatSync(owner.fd, { bigint: true });
    const flags = descriptorFlags(readLinuxProcText(`/proc/self/fdinfo/${owner.fd}`, 65_536, undefined, uncertain));
    return identity(actual) === identity(owner.before) && flags === owner.flags && (flags & BigInt(O_PATH)) !== 0n;
  };
  const uncertain = (owner: object, error: unknown) => {
    closeErrors.push(error);
    for (const file of [...rootNames, ...(state.sourceKey ? [state.sourceKey] : [])]) {
      let values = unresolved.get(file); if (!values) { values = new Set(); unresolved.set(file, values); }
      values.add(owner);
    }
  };
  // Failure-only diagnostics from the actual native scope. Read own data
  // properties without invoking a thrown getter/Proxy; they can only retain a
  // rejected owner, never authorize an FD or clear a source failure.
  const data = (value: unknown, key: string): unknown => value !== null && typeof value === "object" && !utilTypes.isProxy(value)
    ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
  const nativeCloseFailures = (error: unknown) => {
    const pending: unknown[] = [error], visited = new Set<unknown>(), retained = new Set<object>();
    for (let i = 0; i < pending.length && i < 64; i++) {
      const value = pending[i]; if (visited.has(value)) continue; visited.add(value);
      const owner = data(value, "nativeCleanupOwner"), calls = data(value, "cleanupCalls");
      let failedClose = maintenanceFailureCode(value) === "maintenance_lost";
      if (Array.isArray(calls) && !utilTypes.isProxy(calls) && calls.length <= 64)
        for (let j = 0; j < calls.length; j++) {
          const call = data(calls, String(j)), operation = data(call, "operation");
          if (typeof operation === "string" && (operation.startsWith("close-") || operation.startsWith("closedir-"))
            && data(call, "rc") === -1n) failedClose = true;
        }
      if (failedClose && owner !== null && typeof owner === "object" && !retained.has(owner)) {
        retained.add(owner); uncertain(owner, value);
      }
      const errors = data(value, "errors");
      if (Array.isArray(errors) && !utilTypes.isProxy(errors) && errors.length <= 32)
        for (let j = 0; j < errors.length && pending.length < 64; j++) pending.push(data(errors, String(j)));
    }
  };
  const censusOwner: LinuxFileProcessOwner = {
    check: current, checkSync: () => { checkedWindow(); }, observedEntry: () => chargeSourceFileObservation(1),
    ownsDescriptor(fd, selected) {
      const owner = owners.get(fd);
      if (!owner || owner.attempted || identity(owner.before) !== selected) return false;
      return isCurrentOwner(owner) && sameMetadata(owner.before, fstatSync(owner.fd, { bigint: true }));
    },
    uncertainClose: uncertain,
  };
  const close = (owner: MetadataOwner) => {
    if (owner.attempted) return;
    owner.attempted = true; owners.delete(owner.fd);
    try {
      if (!isCurrentOwner(owner)) throw new MaintenanceFailure("maintenance_lost", "source-file-writers-owner-replaced");
      closeSync(owner.fd);
    } catch (error) { uncertain(owner, error); throw error; }
  };
  const openMetadata = (file: string, at: string): MetadataOwner => {
    checkedWindow(); chargeSourceFileObservation(1);
    const fd = openSync(at, O_PATH | constants.O_NOFOLLOW);
    let adopted = false;
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() && !before.isDirectory()) fail();
      const fdinfo = readLinuxProcText(`/proc/self/fdinfo/${fd}`, 65_536, censusOwner.checkSync, uncertain);
      const flags = descriptorFlags(fdinfo);
      if ((flags & BigInt(O_PATH)) === 0n) fail("source_writer_unknown");
      const mount = /^mnt_id:\s*([1-9][0-9]*)\s*$/m.exec(fdinfo)?.[1];
      if (!mount) fail("source_writer_unknown");
      const mapped = linuxMappingIdentity(fdinfo, readLinuxProcText("/proc/self/mountinfo", 2 * 1024 * 1024, censusOwner.checkSync, uncertain));
      if (mapped !== mappedFromStat(String(before.dev), String(before.ino))) fail("source_writer_unknown");
      const owner = { fd, file, before, mount, mapped, flags, selected: false, attempted: false };
      owners.set(fd, owner); adopted = true; return owner;
    } finally {
      if (!adopted) {
        const owner = { fd, file, attempted: true };
        try { closeSync(fd); } catch (error) { uncertain(owner, error); }
      }
    }
  };
  const checkOwner = (owner: MetadataOwner) => {
    checkedWindow();
    const same = (info: BigIntStats) => owner.selected ? sameMetadata(owner.before, info)
      : (["dev", "ino", "mode", "uid", "gid"] as const).every(field => owner.before[field] === info[field]);
    if (owner.attempted || !same(fstatSync(owner.fd, { bigint: true }))) fail();
    const named = lstatSync(owner.file, { bigint: true });
    if (!same(named) || named.isSymbolicLink()) fail();
    if (linuxMappingIdentity(readLinuxProcText(`/proc/self/fdinfo/${owner.fd}`, 65_536, censusOwner.checkSync, uncertain),
      readLinuxProcText("/proc/self/mountinfo", 2 * 1024 * 1024, censusOwner.checkSync, uncertain)) !== owner.mapped) fail();
  };
  const bind = (owner: MetadataOwner) => {
    owner.selected = true;
    const info = owner.before;
    if (info.uid !== BigInt(process.getuid!()) || (info.mode & 0o22n) !== 0n
      || info.isFile() && info.nlink !== 1n || info.nlink < 1n) fail();
    if (seen.has(identity(info))) fail(); seen.add(identity(info));
    const value = { file: owner.file, before: info, mount: owner.mount, mapped: owner.mapped };
    bindings.push(value); keep([value.file, metadata(info), value.mount, value.mapped]);
  };
  const walk = async (owner: MetadataOwner, depth: number): Promise<void> => {
    await current(); if (depth > MAX_DEPTH) fail("backup_capability_unavailable");
    bind(owner);
    if (!owner.before.isDirectory()) return;
    // Reuse the existing native directory owner: its fixed NOATIME open and
    // fdopendir(dup) preserve the open-file-description flags. Node opendir on
    // /proc/self/fd/<O_PATH>/. would reopen without NOATIME and mutate atime.
    // Settle this real owner's close before G3; no PID/FD exception is added.
    checkOwner(owner);
    let names: readonly string[];
    try {
      names = await withNativeSourceRoot(owner.file, directory => {
        checkedWindow();
        const actual = directory.observe(), mount = directory.observeStatx();
        if (directory.kind !== "directory" || mount.mountId !== BigInt(owner.mount)
          || (["dev", "ino", "mode", "uid", "nlink", "size", "mtimeNs", "ctimeNs"] as const)
            .some(field => actual[field] !== owner.before[field])) fail();
        checkOwner(owner);
        const result = directory.readDirectory();
        checkedWindow(); checkOwner(owner);
        return result;
      });
    } catch (error) { nativeCloseFailures(error); throw error; }
    await current(); checkOwner(owner);
    if (names.length > 4096 || names.some(name => !validLeaf(name)) || new Set(names).size !== names.length)
      fail("backup_capability_unavailable");
    // The native result is one bounded retained array, so charge all names
    // before descending; per-child metadata charging alone would miss it.
    keep(names);
    for (const name of names) {
      await current();
      const file = path.join(owner.file, name), child = openMetadata(file, `/proc/self/fd/${owner.fd}/${name}`);
      let childFailed = false, childError: unknown;
      try {
        if (child.before.dev !== owner.before.dev || child.mount !== owner.mount) fail();
        await walk(child, depth + 1); checkOwner(child);
      } catch (error) { childFailed = true; childError = error; }
      try { close(child); } catch (error) { if (!childFailed) { childFailed = true; childError = error; } }
      if (childFailed) throw childError;
    }
    checkOwner(owner);
  };
  try {
    if (roots.length < 1 || roots.length > 2 || new Set(roots.map(root => root.label)).size !== roots.length
      || !roots.some(root => root.label === "managed-sessions")) fail("plan_stale");
    rootNames = roots.map(root => root.path);
    for (const root of roots) {
      if (!validPath(root.path) || !validPath(root.expected.existingAncestor.path) || root.expected.path !== root.path
        || root.expected.absentSegments.length > MAX_DEPTH || !root.expected.absentSegments.every(validLeaf)
        || path.join(root.expected.existingAncestor.path, ...root.expected.absentSegments) !== root.path
        || roots.some(other => other !== root && overlaps(other.path, root.path))) fail("plan_stale");
      if (unresolved.size >= 64 || state.sourceKey !== undefined && unresolved.has(state.sourceKey)
        || [...unresolved.keys()].some(file => file.startsWith("/") && overlaps(file, root.path))) fail("source_writer_unknown");
    }
    const selectionKey = canonicalJson(roots);
    if (state.selection !== undefined && state.selection !== selectionKey) fail("plan_stale");
    state.selection = selectionKey;
    const existing = roots.filter(root => root.expected.absentSegments.length === 0);
    const selection: LinuxFileProcessSelection = {
      files: roots.filter(root => root.label === "config").map(root => root.path),
      trees: roots.filter(root => root.label === "managed-sessions").map(root => root.path),
      identities: new Set(existing.map(root => `${root.expected.existingAncestor.device}:${root.expected.existingAncestor.inode}`)),
      mappedIdentities: new Set(existing.map(root => mappedFromStat(root.expected.existingAncestor.device, root.expected.existingAncestor.inode))),
    };
    // G2 precedes the first new source pathname lookup, including ancestors.
    const prefilter = await inspectLinuxFileProcesses(selection, censusOwner);
    if (prefilter.length) throw new MaintenanceFailure(prefilter[0]!.code, prefilter[0]!.subjectRef);
    for (const root of roots) {
      await current();
      const components = root.expected.existingAncestor.path.split("/").slice(1);
      if (components.length > MAX_DEPTH) fail("backup_capability_unavailable");
      let parent = openMetadata("/", "/"); retainedRoots.push(parent);
      for (const leaf of components) {
        await current();
        if (!parent.before.isDirectory()) fail();
        const child = openMetadata(path.join(parent.file, leaf), `/proc/self/fd/${parent.fd}/${leaf}`);
        retainedRoots.push(child); parent = child;
      }
      if (identity(parent.before) !== `${root.expected.existingAncestor.device}:${root.expected.existingAncestor.inode}`) fail();
      if (root.expected.absentSegments.length) {
        if (!parent.before.isDirectory()) fail();
        absences.push({ owner: parent, leaf: root.expected.absentSegments[0]! });
      } else {
        if (root.label === "config" ? !parent.before.isFile() : !parent.before.isDirectory()) fail();
        await walk(parent, 0);
      }
    }
    const assertAbsence = () => {
      for (const value of absences) {
        let absent = false;
        try { lstatSync(`/proc/self/fd/${value.owner.fd}/${value.leaf}`); }
        catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error; absent = true; }
        if (!absent) fail();
      }
    };
    assertAbsence();
    const bound = [...bindings].sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
    const baseline = canonicalJson(bound.map(value => [value.file, metadata(value.before), value.mount, value.mapped]));
    if (state.baseline !== undefined && state.baseline !== baseline) fail();
    // G3 repeats the genuine proc observation against actual kernel identities,
    // including mapping-only users and aliases whose displayed path differs.
    const blockers = await inspectLinuxFileProcesses({ ...selection,
      identities: new Set(bound.map(value => identity(value.before))),
      mappedIdentities: new Set(bound.map(value => value.mapped)) }, censusOwner);
    if (blockers.length) throw new MaintenanceFailure(blockers[0]!.code, blockers[0]!.subjectRef);
    for (const owner of retainedRoots) checkOwner(owner);
    for (const value of bindings) {
      await current();
      if (!sameMetadata(value.before, lstatSync(value.file, { bigint: true }))) fail();
    }
    assertAbsence(); await current();
    state.baseline ??= baseline;
  } catch (error) { failed = true; first = error; }
  for (const owner of [...owners.values()].reverse()) {
    try { close(owner); } catch (error) { if (!failed) { failed = true; first = error; } }
  }
  if (closeErrors.length && !failed) { failed = true; first = closeErrors[0]; }
  if (!failed) {
    try { await current(); } catch (error) { failed = true; first = error; }
  }
  if (failed) {
    const error = new MaintenanceFailure(maintenanceFailureCode(state.failed ? state.failure : first) ?? "source_writer_unknown", "source-file-writers");
    Object.defineProperties(error, { cause: { value: first }, closeErrors: { value: Object.freeze([...closeErrors]) } });
    rememberFailure(state, error); throw error;
  }
}

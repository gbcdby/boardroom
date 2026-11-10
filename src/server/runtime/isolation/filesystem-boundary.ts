import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, readFile, readlink, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

// Linux O_PATH 尚未由 Node fs.constants 导出；它只取得对象，不读取文件或打开 FIFO/设备。
const O_PATH = 0x200000;
// 只限制启动检查的资源消耗；不会给已运行 CLI 增加计时或改写工作目录。
const MAX_SCAN_DEPTH = 128;
const MAX_SCAN_ENTRIES = 250_000;

interface ScanBudget { remaining: number; }

interface PinnedDescriptor {
  readonly handle: FileHandle;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mountId: string;
}

interface PinnedPath { readonly descriptor: PinnedDescriptor; readonly suffix: readonly string[]; }
interface MountRecord { readonly device: bigint; readonly root: string; readonly point: string; }
interface FilesystemLocation { readonly device: bigint; readonly path: string; }
type RootConstraint = { readonly protectedPaths: readonly PinnedPath[] } |
  { readonly parent: PinnedDescriptor; readonly relativePath: string };
interface PinnedRoot extends PinnedDescriptor { readonly constraint: RootConstraint; }

export type WritableFilesystemRoot = { readonly handle: FileHandle } & (
  { readonly protectedPaths: readonly string[] } |
  { readonly parent: FileHandle; readonly relativePath: string }
);

export interface WritableFilesystemBoundary {
  /** 重扫原先持有的根 FD；不通过工作目录的原路径重新定位。 */
  verify(): Promise<void>;
  /** 仅回收保护路径的元数据 FD；调用方仍拥有可写根及其可信父目录 FD。 */
  close(): Promise<void>;
}

function unsafe(): never { throw new Error("workdir_unsafe"); }

async function mountId(handle: FileHandle): Promise<string> {
  const lines = (await readFile(`/proc/self/fdinfo/${handle.fd}`, "utf8")).split("\n").filter(line => line.startsWith("mnt_id:"));
  const match = lines.length === 1 ? /^mnt_id:\s+([1-9][0-9]*)$/.exec(lines[0]!) : null;
  if (!match?.[1]) unsafe();
  return match[1];
}

function overlaps(a: string, b: string): boolean {
  return a === b || a === "/" || b === "/" || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function unescapeMountPath(value: string): string {
  if (/\\(?!040|011|012|134)/.test(value)) unsafe();
  const decoded = value.replace(/\\(040|011|012|134)/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
  if (!path.posix.isAbsolute(decoded) || decoded.includes("\0")) unsafe();
  return path.posix.normalize(decoded);
}

async function readMounts(): Promise<Map<string, MountRecord>> {
  const bytes = await readFile("/proc/self/mountinfo");
  const contents = bytes.toString("utf8");
  if (!Buffer.from(contents).equals(bytes)) unsafe();
  const mounts = new Map<string, MountRecord>();
  for (const line of contents.split("\n")) {
    if (!line) continue;
    const fields = line.split(" "); const separator = fields.indexOf("-");
    const id = fields[0]; const device = fields[2]; const root = fields[3]; const point = fields[4];
    if (!id || !/^[1-9][0-9]*$/.test(id) || mounts.has(id) || separator < 6 || fields.length < separator + 4 || !device || !root || !point) unsafe();
    const numbers = /^([0-9]+):([0-9]+)$/.exec(device);
    if (!numbers?.[1] || !numbers[2]) unsafe();
    const major = BigInt(numbers[1]); const minor = BigInt(numbers[2]);
    if (major > 0xffff_ffffn || minor > 0xffff_ffffn) unsafe();
    // Linux dev_t 编码；将 mountinfo 的设备号与同一 FD 的 fstat.dev 相互核对。
    const encoded = (minor & 0xffn) | ((major & 0xfffn) << 8n) | ((minor & ~0xffn) << 12n) | ((major & ~0xfffn) << 32n);
    mounts.set(id, { device: encoded, root: unescapeMountPath(root), point: unescapeMountPath(point) });
  }
  if (mounts.size === 0) unsafe();
  return mounts;
}

async function descriptor(handle: FileHandle): Promise<PinnedDescriptor> {
  const metadata = await handle.stat({ bigint: true });
  return { handle, dev: metadata.dev, ino: metadata.ino, mountId: await mountId(handle) };
}

async function descriptorPath(handle: FileHandle): Promise<string> {
  const bytes = await readlink(`/proc/self/fd/${handle.fd}`, { encoding: "buffer" });
  const value = bytes.toString("utf8");
  if (!Buffer.from(value).equals(bytes) || !path.posix.isAbsolute(value) || value.endsWith(" (deleted)")) unsafe();
  return value;
}

async function locate(pinned: PinnedDescriptor, mounts: ReadonlyMap<string, MountRecord>): Promise<FilesystemLocation> {
  const metadata = await pinned.handle.stat({ bigint: true });
  if (metadata.dev !== pinned.dev || metadata.ino !== pinned.ino || metadata.nlink === 0n || await mountId(pinned.handle) !== pinned.mountId) unsafe();
  const mount = mounts.get(pinned.mountId);
  if (!mount || mount.device !== metadata.dev) unsafe();
  const current = await descriptorPath(pinned.handle);
  if (current !== mount.point && !(mount.point === "/" || current.startsWith(`${mount.point}/`))) unsafe();
  const relative = path.posix.relative(mount.point, current);
  const result = { device: mount.device, path: path.posix.join(mount.root, relative) };
  if (await descriptorPath(pinned.handle) !== current || await mountId(pinned.handle) !== pinned.mountId) unsafe();
  return result;
}

function sameLocation(a: FilesystemLocation, b: FilesystemLocation): boolean { return a.device === b.device && a.path === b.path; }

function relativeLocation(base: FilesystemLocation, relative: string): FilesystemLocation {
  if (!relative || path.posix.isAbsolute(relative) || relative.split("/").some(part => !part || part === "." || part === "..")) unsafe();
  return { device: base.device, path: path.posix.join(base.path, relative) };
}

async function stableLocations(pinned: readonly PinnedDescriptor[], mounts: ReadonlyMap<string, MountRecord>, locations: ReadonlyMap<PinnedDescriptor, FilesystemLocation>): Promise<void> {
  for (const item of pinned) if (!sameLocation(locations.get(item)!, await locate(item, mounts))) unsafe();
  const current = await readMounts();
  for (const item of pinned) {
    const before = mounts.get(item.mountId); const after = current.get(item.mountId);
    if (!before || !after || before.device !== after.device || before.root !== after.root || before.point !== after.point) unsafe();
  }
}

/** 在 mkdir/预建挂载点等写操作前确认子目录确实位于可信父目录的预期文件系统位置。 */
export async function verifyExpectedDirectoryLocation(handle: FileHandle, parent: FileHandle, relativePath: string): Promise<void> {
  try {
    if (!(await handle.stat()).isDirectory() || !(await parent.stat()).isDirectory()) unsafe();
    const child = await descriptor(handle); const base = await descriptor(parent); const pinned = [child, base];
    const mounts = await readMounts(); const locations = new Map<PinnedDescriptor, FilesystemLocation>();
    for (const item of pinned) locations.set(item, await locate(item, mounts));
    if (!sameLocation(locations.get(child)!, relativeLocation(locations.get(base)!, relativePath))) unsafe();
    await stableLocations(pinned, mounts, locations);
  } catch { unsafe(); }
}

async function pinProtectedPath(source: string, handles: FileHandle[]): Promise<PinnedPath> {
  if (!source || source.includes("\0")) unsafe();
  // 保留 symlink/.. 的文件系统语义，不能在 realpath 之前做词法归一。
  let current = path.isAbsolute(source) ? source : `${process.cwd()}${path.sep}${source}`;
  const suffix: string[] = [];
  for (;;) {
    let canonical: string;
    try { canonical = await realpath(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") unsafe();
      // dangling symlink 不等于不存在；不能把它错误归到原路径的父目录。
      try { await lstat(current); unsafe(); }
      catch (entryError) { if ((entryError as NodeJS.ErrnoException).code !== "ENOENT") unsafe(); }
      const parent = path.dirname(current);
      if (parent === current) unsafe();
      suffix.unshift(path.basename(current)); current = parent; continue;
    }
    const handle = await open(canonical, O_PATH | constants.O_NOFOLLOW); handles.push(handle);
    const metadata = await handle.stat();
    if (metadata.isSymbolicLink() || suffix.length > 0 && !metadata.isDirectory() || await descriptorPath(handle) !== canonical) unsafe();
    return { descriptor: await descriptor(handle), suffix };
  }
}

function unchanged(before: BigIntStats, after: BigIntStats): void {
  // atime 会因目录枚举而改变；其余对象身份/元数据在单轮扫描内变化即失败关闭。
  if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode || before.nlink !== after.nlink ||
      before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) unsafe();
}

async function scanDirectory(handle: FileHandle, expectedMountId: string, before: BigIntStats, budget: ScanBudget, depth: number): Promise<void> {
  if (depth > MAX_SCAN_DEPTH) unsafe();
  if (!before.isDirectory() || before.nlink === 0n || await mountId(handle) !== expectedMountId) unsafe();
  const directory = `/proc/self/fd/${handle.fd}`;
  // 小批枚举限制内存；latin1 一字节对应一字符，可无损恢复非 UTF-8 文件名。
  const entries = await opendir(directory, { encoding: "latin1", bufferSize: 32 });
  for await (const item of entries) {
    if (--budget.remaining < 0) unsafe();
    const entryPath = Buffer.concat([Buffer.from(`${directory}/`), Buffer.from(item.name, "latin1")]);
    const entry = await open(entryPath, O_PATH | constants.O_NOFOLLOW);
    try {
      const entryBefore = await entry.stat({ bigint: true });
      // st_dev 无法识别同一文件系统的 bind mount，必须比较实际 mount ID。
      if (await mountId(entry) !== expectedMountId) unsafe();
      if (entryBefore.isDirectory()) await scanDirectory(entry, expectedMountId, entryBefore, budget, depth + 1);
      else if (entryBefore.isFile()) {
        // 包括项目内部硬链接：不能仅凭 inode 判断它是否还有隔离外别名。
        if (entryBefore.nlink !== 1n) unsafe();
      } else if (!entryBefore.isSymbolicLink()) unsafe();
      // symlink 只检查本身，目标可见性仍由私有 mount namespace 决定。
      unchanged(entryBefore, await entry.stat({ bigint: true }));
      const current = await open(entryPath, O_PATH | constants.O_NOFOLLOW);
      try {
        unchanged(entryBefore, await current.stat({ bigint: true }));
        if (await mountId(current) !== expectedMountId) unsafe();
      } finally { await current.close(); }
    } finally { await entry.close(); }
  }
  unchanged(before, await handle.stat({ bigint: true }));
  if (await mountId(handle) !== expectedMountId) unsafe();
}

/**
 * 检查即将 RW 挂载的真实对象；调用方负责根 FD 的生命周期和 CLI 启动门禁。
 * 这不是跨宿主并发写者的快照：#72 不覆盖未受此运行约束的其他恶意同 UID 宿主进程注入。
 */
export async function createWritableFilesystemBoundary(inputs: readonly WritableFilesystemRoot[]): Promise<WritableFilesystemBoundary> {
  const metadataHandles: FileHandle[] = [];
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await Promise.all(metadataHandles.map(handle => handle.close().catch(() => {})));
  };
  try {
    if (process.platform !== "linux" || inputs.length === 0) unsafe();
    const roots: PinnedRoot[] = [];
    const pinned: PinnedDescriptor[] = [];
    for (const input of inputs) {
      if (!(await input.handle.stat()).isDirectory()) unsafe();
      let constraint: RootConstraint;
      if ("protectedPaths" in input) {
        const protectedPaths: PinnedPath[] = [];
        for (const source of input.protectedPaths) {
          const protectedPath = await pinProtectedPath(source, metadataHandles);
          protectedPaths.push(protectedPath); pinned.push(protectedPath.descriptor);
        }
        constraint = { protectedPaths };
      } else {
        if (!(await input.parent.stat()).isDirectory()) unsafe();
        const parent = await descriptor(input.parent); pinned.push(parent);
        constraint = { parent, relativePath: input.relativePath };
      }
      const root = { ...await descriptor(input.handle), constraint }; roots.push(root); pinned.push(root);
    }
    const boundary: WritableFilesystemBoundary = {
      close,
      async verify() {
        try {
          if (closed) unsafe();
          const mounts = await readMounts(); const locations = new Map<PinnedDescriptor, FilesystemLocation>();
          for (const item of pinned) locations.set(item, await locate(item, mounts));
          const budget = { remaining: MAX_SCAN_ENTRIES };
          for (const root of roots) {
            const location = locations.get(root)!;
            if ("protectedPaths" in root.constraint) {
              for (const protectedPath of root.constraint.protectedPaths) {
                const base = locations.get(protectedPath.descriptor)!;
                const protectedLocation = protectedPath.suffix.length ? relativeLocation(base, protectedPath.suffix.join("/")) : base;
                if (location.device === protectedLocation.device && overlaps(location.path, protectedLocation.path)) unsafe();
              }
            } else if (!sameLocation(location, relativeLocation(locations.get(root.constraint.parent)!, root.constraint.relativePath))) unsafe();
            const before = await root.handle.stat({ bigint: true });
            if (before.dev !== root.dev || before.ino !== root.ino) unsafe();
            await scanDirectory(root.handle, root.mountId, before, budget, 0);
          }
          await stableLocations(pinned, mounts, locations);
        } catch { unsafe(); }
      },
    };
    await boundary.verify();
    return boundary;
  } catch { await close(); unsafe(); }
}

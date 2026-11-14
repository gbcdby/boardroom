import { constants } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalizePath, type ResolvedBoardroomEnvironment } from "../environment.ts";
import type { SkillInspectionIssue, SkillPackagePreview } from "../../shared/skills.ts";
import { canonical, sha256 } from "./common.ts";
import { inspectLocalSkillPackages, readRegular, type InspectLocalSkillOptions } from "./inventory.ts";

export interface PrepareLocalSkillSnapshotInput {
  /** 仅消费保护范围；writable、skillsRoot、storageId 都不是本函数的写入许可。 */
  readonly environment: ResolvedBoardroomEnvironment;
  readonly inventory: InspectLocalSkillOptions;
  readonly expectedInventoryDigest: string;
  readonly selectedPackage: { readonly canonicalRoot: string; readonly contentDigest: string };
}

export type SkillSnapshotCleanup = { readonly state: "removed" | "already-removed" }
  | { readonly state: "retained"; readonly path: string; readonly reason: "identity-changed" | "cleanup-failed" };
type FailureCode = "inventory_invalid" | "source_changed" | "selection_invalid" | "temporary_root_unsafe"
  | "temporary_root_changed" | "copy_failed" | "snapshot_mismatch";

export class SkillSnapshotPreparationError extends Error {
  readonly code: FailureCode;
  readonly cleanup: SkillSnapshotCleanup | { readonly state: "not-created" };
  readonly inspectionIssues: readonly SkillInspectionIssue[];
  constructor(code: FailureCode, cleanup: SkillSnapshotPreparationError["cleanup"], inspectionIssues: readonly SkillInspectionIssue[] = []) {
    super(`技能临时快照准备失败：${code}`);
    this.name = "SkillSnapshotPreparationError"; this.code = code; this.cleanup = cleanup;
    this.inspectionIssues = structuredClone(inspectionIssues);
  }
}

export interface PreparedLocalSkillSnapshot {
  readonly state: "prepared-temp";
  readonly versionId: null;
  readonly activationAllowed: false;
  readonly invocationEligible: false;
  /** 原来源元数据；裸目标重扫不能覆盖清单携带的更严格调用限制。 */
  readonly sourcePackage: SkillPackagePreview;
  /** 仅供受信内部检查的临时路径；不是 catalog、装配或 Agent 资源入口。 */
  readonly snapshotPath: string;
  readonly cleanup: () => Promise<SkillSnapshotCleanup>;
}

class PreparationFailure extends Error {
  readonly code: FailureCode;
  readonly issues: readonly SkillInspectionIssue[];
  constructor(code: FailureCode, issues: readonly SkillInspectionIssue[] = []) {
    super(code); this.code = code; this.issues = issues;
  }
}
function fail(code: FailureCode, issues: readonly SkillInspectionIssue[] = []): never { throw new PreparationFailure(code, issues); }
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
async function directoryIdentity(directory: string): Promise<string> {
  const info = await fs.lstat(directory, { bigint: true });
  if (!info.isDirectory() || await fs.realpath(directory) !== directory) fail("temporary_root_changed");
  return `${info.dev}:${info.ino}`;
}
async function sourceIdentities(source: SkillPackagePreview): Promise<string> {
  const facts: unknown[] = [];
  for (const relative of ["", ...source.files.map(file => file.path)]) {
    const file = path.join(source.canonicalRoot, relative), info = await fs.lstat(file, { bigint: true }), actual = await fs.realpath(file);
    if (!inside(source.canonicalRoot, actual)) fail("source_changed");
    facts.push([relative, actual, String(info.dev), String(info.ino), String(info.mode), String(info.nlink),
      String(info.size), String(info.mtimeNs), String(info.ctimeNs)]);
  }
  return canonical(facts);
}
function builtinMetadata(source: SkillPackagePreview) {
  return { skillName: source.skillName, description: source.description, declaredVersion: source.declaredVersion,
    resources: source.resources, dependencies: source.dependencies };
}

/**
 * #163 阶段 A 的内部准备内核。只在自行创建的私有临时目录写入，不激活 S4 根，
 * 不登记版本、不执行包代码、不提供正文接口。正式持久导入仍等待 #162。
 */
export async function prepareLocalSkillSnapshot(input: PrepareLocalSkillSnapshotInput): Promise<PreparedLocalSkillSnapshot> {
  let arena: string | null = null, arenaIdentity: string | null = null, removed = false;
  const cleanup = async (): Promise<SkillSnapshotCleanup> => {
    if (removed) return { state: "already-removed" };
    const owned = arena;
    if (!owned) throw new Error("尚未创建临时目录");
    try {
      if (!arenaIdentity || await directoryIdentity(owned) !== arenaIdentity) return { state: "retained", path: owned, reason: "identity-changed" };
    } catch { return { state: "retained", path: owned, reason: "identity-changed" }; }
    try {
      await fs.rm(owned, { recursive: true, force: false }); removed = true;
      return { state: "removed" };
    } catch { return { state: "retained", path: owned, reason: "cleanup-failed" }; }
  };
  try {
    // 在首次 await 前固定调用方输入；不保留其可变数组或完整环境（可能含凭据）。
    const options = structuredClone(input.inventory), selected = { ...input.selectedPackage };
    const expectedInventoryDigest = input.expectedInventoryDigest, protectedPaths = [...input.environment.protectedPaths];
    const inventory = await inspectLocalSkillPackages(options);
    if (inventory.issues.length) fail("inventory_invalid", inventory.issues);
    if (inventory.digest !== expectedInventoryDigest) fail("source_changed");
    const source = inventory.packages.find(item => item.canonicalRoot === selected.canonicalRoot && item.contentDigest === selected.contentDigest);
    if (!source) fail("selection_invalid");
    const sourceIdentity = await sourceIdentities(source);
    const boundaries = [...protectedPaths, ...(options.packageRoots ?? []), ...(options.collectionRoots ?? []),
      ...(options.workSuites ?? []).map(suite => suite.rootPath), ...inventory.packages.map(item => item.canonicalRoot)].map(canonicalizePath);
    // 必须按原路径 realpath；预先 path.resolve 会错误折叠符号链接后的 ..。
    const temporary = tmpdir();
    if (!path.isAbsolute(temporary)) fail("temporary_root_unsafe");
    const parent = await fs.realpath(temporary);
    if (!(await fs.stat(parent)).isDirectory() || boundaries.some(boundary => inside(boundary, parent))) fail("temporary_root_unsafe");
    arena = await fs.mkdtemp(path.join(parent, "boardroom-skill-snapshot-"));
    arenaIdentity = await directoryIdentity(arena);
    if (boundaries.some(boundary => inside(boundary, arena!) || inside(arena!, boundary))) fail("temporary_root_unsafe");
    await fs.chmod(arena, 0o700);
    const assertOwned = async () => { if (await directoryIdentity(arena!) !== arenaIdentity) fail("temporary_root_changed"); };
    const pending = path.join(arena, "package.pending"), ready = path.join(arena, "package");
    await assertOwned(); await fs.mkdir(pending, { mode: 0o700 });
    const pendingIdentity = await directoryIdentity(pending);
    // inventory 会列出目录链接展开后的逻辑后代；它们不能再次写穿刚创建的链接。
    const links = new Set(source.files.filter(entry => entry.kind === "symlink").map(entry => entry.path));
    const physical = source.files.filter(entry => {
      const parts = entry.path.split("/");
      return !parts.slice(0, -1).some((_part, index) => links.has(parts.slice(0, index + 1).join("/")));
    });
    for (const entry of physical.filter(entry => entry.kind !== "symlink")) {
      await assertOwned();
      const target = path.join(pending, entry.path);
      if (entry.kind === "directory") await fs.mkdir(target, { mode: 0o700 });
      else if (entry.kind === "file") {
        let bytes: Buffer;
        try { bytes = await readRegular(path.join(source.canonicalRoot, entry.path), source.canonicalRoot, entry.byteLength); }
        catch { fail("source_changed"); }
        if (bytes.length !== entry.byteLength || sha256(bytes) !== entry.sha256) fail("source_changed");
        const file = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await file.writeFile(bytes); } finally { await file.close(); }
      }
    }
    // 先完成实体目录和文件，再保留经过原检查器验证的相对链接文本。
    for (const entry of physical.filter(entry => entry.kind === "symlink")) {
      await assertOwned();
      await fs.symlink(entry.target!, path.join(pending, entry.path));
    }
    const afterSource = await inspectLocalSkillPackages(options);
    if (afterSource.issues.length || afterSource.digest !== expectedInventoryDigest || await sourceIdentities(source) !== sourceIdentity) fail("source_changed");
    const copied = await inspectLocalSkillPackages({ packageRoots: [pending], ...(options.limits ? { limits: options.limits } : {}) });
    const target = copied.packages[0];
    if (copied.issues.length || copied.packages.length !== 1 || !target || target.contentDigest !== source.contentDigest
      || canonical(target.files) !== canonical(source.files) || canonical(builtinMetadata(target)) !== canonical(builtinMetadata(source))) fail("snapshot_mismatch");
    await assertOwned();
    if (await directoryIdentity(pending) !== pendingIdentity) fail("temporary_root_changed");
    try { await fs.lstat(ready); fail("copy_failed"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await fs.rename(pending, ready);
    await assertOwned();
    if (await directoryIdentity(ready) !== pendingIdentity) fail("temporary_root_changed");
    return Object.freeze({ state: "prepared-temp", versionId: null, activationAllowed: false, invocationEligible: false,
      sourcePackage: freeze(structuredClone(source)), snapshotPath: ready, cleanup });
  } catch (error) {
    const result = arena ? await cleanup() : { state: "not-created" as const };
    throw new SkillSnapshotPreparationError(error instanceof PreparationFailure ? error.code : "copy_failed", result,
      error instanceof PreparationFailure ? error.issues : []);
  }
}

import { constants } from "node:fs";
import { access, lstat, readFile, readlink, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { canonicalizePath, type ResolvedBoardroomEnvironment } from "../environment.ts";
import type { WorkspacePreflight, WorkspaceRepositoryInfo, WorkspaceRootIdentity } from "../../shared/workspace.ts";
import { WorkspaceError } from "./errors.ts";

const exec = promisify(execFile);
const comparison = "raw_bytes_no_filters" as const;
const within = (root: string, candidate: string) => { const relative = path.relative(root, candidate); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); };
const failure = (reason: string, message: string): never => { throw new WorkspaceError(reason, message); };
function pathFailure(error: unknown): never {
  if (error instanceof WorkspaceError) throw error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return failure("path_missing", "工作目录不存在；请先选择已有目录。");
  if (code === "ENOTDIR") return failure("path_not_directory", "工作目录必须指向现有目录。");
  return failure("path_inaccessible", "无法读取或进入工作目录，请检查权限及符号链接。");
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1",
    // 空白名单覆盖仓库级 protocol.*.allow=always，连本地/ext 自定义 helper 也不能启动。
    GIT_ALLOW_PROTOCOL: "", LC_ALL: "C" };
}
async function git(root: string, ...args: string[]): Promise<string> {
  // 命令行开关必须被当前 Git 识别；旧版本会明确失败为 unavailable，不能静默忽略变量后 lazy fetch。
  const result = await exec("git", ["--no-lazy-fetch", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
    "-c", "core.untrackedCache=false", "-c", "core.preloadIndex=false", "-c", "core.pager=cat", ...args],
  { cwd: root, env: gitEnvironment(), encoding: "utf8", timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
  return result.stdout;
}
function unknownRepository(kind: "not_git" | "unavailable", reason: string | null): WorkspaceRepositoryInfo {
  return { kind, topLevel: null, head: null, dirty: null, trackedChangedCount: null, untrackedCount: null,
    indexChanged: null, complete: kind === "not_git", comparison, reason };
}
async function repository(root: string): Promise<WorkspaceRepositoryInfo> {
  let topLevel: string;
  try {
    if ((await git(root, "rev-parse", "--is-inside-work-tree")).trim() !== "true") return unknownRepository("unavailable", "not_a_worktree");
    topLevel = await realpath((await git(root, "rev-parse", "--show-toplevel")).trim());
  } catch (error) {
    return (error as { stderr?: string }).stderr?.includes("not a git repository")
      ? unknownRepository("not_git", null) : unknownRepository("unavailable", "git_metadata_unavailable");
  }
  try {
    let head: string | null = null;
    try { head = (await git(root, "rev-parse", "--verify", "HEAD")).trim(); } catch { /* 未提交的仓库没有 HEAD。 */ }
    const algorithm = (await git(root, "rev-parse", "--show-object-format")).trim();
    if (algorithm !== "sha1" && algorithm !== "sha256") return unknownRepository("unavailable", "git_object_format_unavailable");
    const indexed = (await git(root, "ls-files", "--stage", "-z", "--", ".")).split("\0").filter(Boolean);
    const untracked = (await git(root, "ls-files", "--others", "--exclude-standard", "-z", "--", ".")).split("\0").filter(Boolean);
    let indexChanged = indexed.length > 0;
    if (head !== null) indexChanged = (await git(root, "diff-index", "--cached", "--no-ext-diff", "--no-textconv", "--name-only", "-z", head, "--", ".")).length > 0;
    let changed = 0, complete = true, bytesRead = 0;
    for (const entry of indexed.slice(0, 10000)) {
      const match = /^(\d+) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(entry);
      if (!match) { complete = false; continue; }
      const [, mode, oid, stage, relative] = match;
      if (stage !== "0") { changed++; continue; }
      // 子模块的实际内容属于另一工作根；不能把未检查的内容报告为干净。
      if (mode === "160000") { complete = false; continue; }
      const file = path.resolve(root, relative!);
      if (!within(root, file) || relative!.includes("\ufffd")) { complete = false; continue; }
      try {
        const info = await lstat(file);
        if ((mode === "120000") !== info.isSymbolicLink()) { changed++; continue; }
        if (!info.isFile() && !info.isSymbolicLink()) { changed++; continue; }
        if (info.size > 8 * 1024 * 1024 || bytesRead + info.size > 64 * 1024 * 1024) { complete = false; continue; }
        const bytes = info.isSymbolicLink() ? Buffer.from(await readlink(file)) : await readFile(file);
        bytesRead += bytes.length;
        const hash = createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
        const modeChanged = info.isFile() && ((info.mode & 0o111) !== 0) !== (mode === "100755");
        if (hash !== oid || modeChanged) changed++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") changed++; else complete = false;
      }
    }
    if (indexed.length > 10000) complete = false;
    const dirty = indexChanged || changed > 0 || untracked.length > 0;
    return { kind: "git", topLevel, head, dirty: dirty ? true : complete ? false : null, trackedChangedCount: changed,
      untrackedCount: untracked.length, indexChanged, complete, comparison, reason: complete ? null : "git_observation_incomplete" };
  } catch { return { ...unknownRepository("unavailable", "git_observation_unavailable"), topLevel }; }
}

async function rootFacts(rootPath: string, environment: ResolvedBoardroomEnvironment) {
  if (typeof rootPath !== "string" || rootPath.length === 0 || rootPath.length > 4096 || rootPath.includes("\0")) failure("path_invalid", "工作目录必须是有效路径字符串或 null。");
  if (!path.isAbsolute(rootPath)) failure("path_not_absolute", "工作目录必须使用绝对路径。");
  try {
    // 现有根先按文件系统语义解析原输入；path.resolve 会提前折叠 link/..，指向另一目录。
    const canonicalRoot = await realpath(rootPath);
    const info = await stat(canonicalRoot, { bigint: true });
    if (!info.isDirectory()) failure("path_not_directory", "工作目录必须指向现有目录。");
    await access(canonicalRoot, constants.R_OK | constants.X_OK);
    for (const protectedPath of environment.protectedPaths) {
      const canonicalProtected = canonicalizePath(protectedPath);
      if (within(canonicalProtected, canonicalRoot) || within(canonicalRoot, canonicalProtected)) failure("protected_path", "工作目录与系统数据、技能、记忆或应用目录重叠，请选择项目专用目录。");
    }
    const rootIdentity: WorkspaceRootIdentity = { device: String(info.dev), inode: String(info.ino), birthtimeNs: String(info.birthtimeNs) };
    const physicalResourceKey = `filesystem-root:${createHash("sha256").update(JSON.stringify(rootIdentity)).digest("hex")}`;
    return { canonicalRoot, rootIdentity, physicalResourceKey };
  } catch (error) { return pathFailure(error); }
}

/** 原输入按现有目录真实语义解析，保护范围仍由 S4 提供；不激活 planned 根或写入工作目录。 */
export async function inspectWorkspaceRoot(rootPath: string | null, environment: ResolvedBoardroomEnvironment,
  now: () => Date = () => new Date()): Promise<WorkspacePreflight> {
  const base = { rootPath, observationOnly: true as const, requiresRevalidation: true as const, runReady: false as const };
  if (rootPath === null) return { ...base, canonicalRoot: null, rootIdentity: null, physicalResourceKey: null, repositoryInfo: null, observedAt: now().toISOString() };
  const root = await rootFacts(rootPath, environment);
  const repositoryInfo = await repository(root.canonicalRoot);
  const after = await rootFacts(rootPath, environment);
  if (JSON.stringify(after) !== JSON.stringify(root)) throw new WorkspaceError("workspace_changed", "观察期间目录身份已变化，请重新选择并预检。", "rootPath", true);
  return { ...base, ...root, repositoryInfo, observedAt: now().toISOString() };
}

/** 此检查不取得物理资源租约；下游执行仍需重新核对授权和实际宿主目录。 */
export async function revalidateWorkspaceRoot(previous: WorkspacePreflight, environment: ResolvedBoardroomEnvironment): Promise<void> {
  if (previous.rootPath === null) return;
  try {
    const current = await rootFacts(previous.rootPath, environment);
    if (current.canonicalRoot !== previous.canonicalRoot || current.physicalResourceKey !== previous.physicalResourceKey) throw new Error("changed");
  } catch { throw new WorkspaceError("workspace_changed", "保存的工作目录已变化或不可用，请重新预检并保存。", "rootPath", true); }
}

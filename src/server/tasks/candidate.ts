import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { devNull } from "node:os";
import path from "node:path";
import type { ReviewCandidate, ReviewCommand } from "../../shared/tasks.ts";
import { TaskError } from "./errors.ts";

const DIFF_LIMIT = 2 * 1024 * 1024;
const INVENTORY_LIMIT = 4 * 1024 * 1024;
const MAX_TRACKED_BYTES = 128 * 1024 * 1024;
const COMMIT_LIMIT = 200;
const COMMAND_TIMEOUT_MS = 10_000;
type Entry = { mode: string; oid: string; file: string };

/** 仅按提交对象、index 与原始文件字节核验；不调用 status，避免 clean/process filters。 */
export async function captureReviewCandidate(input: { repoPath: string; fixedPoint: string }): Promise<ReviewCandidate> {
  if (!input.repoPath || !input.fixedPoint || input.fixedPoint.length > 512 || input.fixedPoint.includes("\0")) {
    throw new TaskError("review_input_required", "评审需要有效的仓库路径和 fixed point。");
  }
  let cwd: string;
  try { cwd = await realpath(input.repoPath); }
  catch { throw new TaskError("review_repository_unavailable", "仓库路径不存在或不可读取。"); }
  const commands: ReviewCommand[] = [];
  const environment: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  Object.assign(environment, { GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_PAGER: "cat" });
  async function git(args: string[], maxBuffer = INVENTORY_LIMIT): Promise<Buffer> {
    const argv = ["--no-pager", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${devNull}`, "-c", "core.untrackedCache=false", ...args];
    const startedAt = new Date().toISOString();
    try {
      const stdout = await new Promise<Buffer>((resolve, reject) => {
        execFile("git", argv, { cwd, env: environment, encoding: "buffer", timeout: COMMAND_TIMEOUT_MS, maxBuffer, windowsHide: true },
          (error, out) => error ? reject(error) : resolve(out));
      });
      commands.push({ argv: ["git", ...argv], cwd, startedAt, completedAt: new Date().toISOString(), exitCode: 0 });
      return stdout;
    } catch (cause) {
      const error = cause as { code?: number | string; killed?: boolean };
      const reason = error.killed ? "review_capture_timeout" : error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "review_capture_too_large" : "review_git_failed";
      throw new TaskError(reason, reason === "review_capture_timeout" ? "读取 Git 候选超时，请缩小评审范围后重试。" : reason === "review_capture_too_large" ? "Git 候选超过大小上限，请缩小评审范围。" : "无法读取 Git 候选，请检查仓库和引用。", "invalid_argument", { argv: ["git", ...argv] });
    }
  }
  const text = async (args: string[]) => (await git(args)).toString("utf8").trim();
  try {
    if (await text(["rev-parse", "--is-bare-repository"]) !== "false") throw new TaskError("review_unsupported_worktree", "评审需要完整的 Git 工作树，不能使用裸仓库。");
    cwd = await realpath(await text(["rev-parse", "--show-toplevel"]));
  } catch (error) {
    if (error instanceof TaskError && error.reason === "review_unsupported_worktree") throw error;
    throw new TaskError("review_repository_unavailable", "所选路径不是可读取的 Git 工作树。");
  }
  const gitVersion = await text(["--version"]);
  const format = await text(["rev-parse", "--show-object-format"]);
  if (format !== "sha1" && format !== "sha256") throw new TaskError("review_unsupported_worktree", "仓库对象格式暂不支持。");
  const oidPattern = format === "sha1" ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/;
  const resolveCommit = async (ref: string, reason: string): Promise<string> => {
    try {
      const sha = await text(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
      if (!oidPattern.test(sha)) throw new Error("invalid commit output");
      return sha;
    } catch { throw new TaskError(reason, "fixed point 或 HEAD 不是可解析的提交，请使用有效 commit、分支或 tag。"); }
  };
  const baseCommit = await resolveCommit(input.fixedPoint, "review_invalid_ref");
  const candidateCommit = await resolveCommit("HEAD", "review_invalid_head");

  function entries(buffer: Buffer, kind: "tree" | "index"): Entry[] {
    const source = buffer.toString("utf8");
    if (!Buffer.from(source, "utf8").equals(buffer)) throw new TaskError("review_unsupported_worktree", "候选包含无法表示的文件路径。");
    return source.split("\0").filter(Boolean).map(record => {
      const separator = record.indexOf("\t");
      const header = record.slice(0, separator).split(" ");
      const mode = header[0] ?? "";
      const oid = header[kind === "tree" ? 2 : 1] ?? "";
      const file = record.slice(separator + 1);
      if (separator < 0 || !oidPattern.test(oid) || !file || path.isAbsolute(file) || file.split("/").some(part => part === ".." || part === ".")) {
        throw new TaskError("review_unsupported_worktree", "候选文件清单无法可靠解析。");
      }
      if (mode === "160000" || !["100644", "100755", "120000"].includes(mode)) throw new TaskError("review_unsupported_worktree", "首版评审不支持 submodule 或特殊工作树条目。");
      if (kind === "index" && header[2] !== "0") throw new TaskError("review_dirty_worktree", "仓库存在未解决的合并项，请先提交干净候选。");
      return { mode, oid, file };
    });
  }

  async function verifyClean(): Promise<void> {
    const index = entries(await git(["ls-files", "--stage", "-z"]), "index");
    const tree = entries(await git(["ls-tree", "-r", "--full-tree", "-z", candidateCommit]), "tree");
    if (index.length !== tree.length || index.some((item, i) => item.file !== tree[i]?.file || item.mode !== tree[i]?.mode || item.oid !== tree[i]?.oid)) {
      throw new TaskError("review_dirty_worktree", "index 与 HEAD 不一致，请先提交暂存改动。");
    }
    // skip-worktree 位意味着 sparse/手动跳过检查；不能把缺失或被隐藏的文件当作干净。
    const flags = (await git(["ls-files", "-v", "-z"])).toString("utf8").split("\0").filter(Boolean);
    if (flags.some(line => line[0]?.toUpperCase() === "S")) throw new TaskError("review_unsupported_worktree", "首版评审不支持 sparse/skip-worktree 工作树。");
    if ((await git(["ls-files", "--others", "--exclude-standard", "-z"])).length > 0) throw new TaskError("review_dirty_worktree", "仓库存在未跟踪文件，请先提交或使用干净工作树。");
    let total = 0;
    for (const item of index) {
      const file = path.join(cwd, item.file);
      let stat;
      try { stat = await lstat(file); } catch { throw new TaskError("review_dirty_worktree", "候选中的工作树文件缺失，请先恢复或提交。"); }
      const hash = createHash(format);
      if (item.mode === "120000") {
        if (!stat.isSymbolicLink()) throw new TaskError("review_dirty_worktree", "候选中的符号链接类型已改变。");
        const bytes = await readlink(file, { encoding: "buffer" });
        hash.update(`blob ${bytes.length}\0`); hash.update(bytes); total += bytes.length;
      } else {
        if (!stat.isFile() || stat.isSymbolicLink()) throw new TaskError("review_dirty_worktree", "候选中的文件类型已改变。");
        if ((item.mode === "100755") !== Boolean(stat.mode & 0o111)) throw new TaskError("review_dirty_worktree", "候选中的文件执行位已改变。");
        const real = await realpath(file);
        if (!real.startsWith(cwd + path.sep)) throw new TaskError("review_unsupported_worktree", "候选文件经目录链接指向工作树之外。");
        total += stat.size;
        if (total > MAX_TRACKED_BYTES) throw new TaskError("review_capture_too_large", "候选文件总量超过 128 MiB，请缩小仓库范围。");
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const observed = await handle.stat();
          if (!observed.isFile() || observed.size !== stat.size) throw new TaskError("review_candidate_changed", "读取期间候选文件发生变化，请重试。");
          hash.update(`blob ${observed.size}\0`);
          for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes as Buffer);
        } finally { await handle.close(); }
      }
      if (hash.digest("hex") !== item.oid) throw new TaskError("review_dirty_worktree", "工作树原始字节与提交不一致；请提交改动，转换过滤器工作树暂不支持。");
    }
    if (await resolveCommit("HEAD", "review_invalid_head") !== candidateCommit) throw new TaskError("review_candidate_changed", "采集过程中 HEAD 变化，请重新提交评审。");
  }
  await verifyClean();
  const diffBytes = await git(["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--binary", "--full-index", baseCommit, candidateCommit, "--"], DIFF_LIMIT);
  if (diffBytes.length === 0) throw new TaskError("review_empty_diff", "fixed point 与候选没有差异，不能开始评审。");
  const diff = diffBytes.toString("utf8");
  if (!Buffer.from(diff, "utf8").equals(diffBytes)) throw new TaskError("review_unsupported_diff", "候选强制文本 diff 包含无效 UTF-8，无法完整表示；请调整文件编码或按二进制评审。");
  const rawLog = (await git(["log", "-z", "--format=%H%x00%s", `--max-count=${COMMIT_LIMIT + 1}`, `${baseCommit}..${candidateCommit}`, "--"])).toString("utf8").split("\0");
  if (rawLog.at(-1) === "") rawLog.pop();
  const commits: ReviewCandidate["commits"] = [];
  for (let i = 0; i < rawLog.length; i += 2) {
    const sha = rawLog[i] ?? ""; const subject = rawLog[i + 1];
    if (!oidPattern.test(sha) || subject === undefined) throw new TaskError("review_capture_failed", "Git commit 列表无法可靠解析。");
    commits.push({ sha, subject });
  }
  if (commits.length > COMMIT_LIMIT) throw new TaskError("review_capture_too_large", "评审范围超过 200 个提交，请缩小 fixed point 范围。");
  await verifyClean();
  return { repositoryRoot: cwd, fixedPointInput: input.fixedPoint, baseCommit, candidateCommit,
    policy: "committed-clean", gitVersion, diff, diffSha256: createHash("sha256").update(diffBytes).digest("hex"),
    commits, commands, capturedAt: new Date().toISOString() };
}

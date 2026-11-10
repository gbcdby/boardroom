/** 在使用者已授权的真实 Codex CLI 上并行收集独立两轴；不提交报告、不替代 reviewer 裁决。 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { captureReviewCandidate } from "../src/server/tasks/candidate.ts";

if (process.argv.includes("--help") || !process.argv[2]) {
  console.log("用法：node scripts/run-review-axes.mjs <read_task或HTTP任务详情.json> [codex可执行文件]\n使用当前登录环境；两个只读、独立、并行执行；输出在.agent-output/model-review/。不修改登录目录或提交平台报告。");
  process.exit(0);
}
const detail = JSON.parse(await readFile(process.argv[2], "utf8"));
const round = detail.rounds?.find(item => item.id === detail.task?.currentReviewRoundId);
if (!round?.candidate || !["ready", "running"].includes(round.state)) throw new Error("需要当前有效且待评审的固定候选。");
const candidate = round.candidate;
const observed = await captureReviewCandidate({ repoPath: candidate.repositoryRoot, fixedPoint: candidate.baseCommit });
if (observed.candidateCommit !== candidate.candidateCommit || observed.diffSha256 !== candidate.diffSha256) throw new Error("工作区已不匹配固定候选，不能继续评审。");
const executable = process.argv[3] ?? "codex";
const version = (await promisify(execFile)(executable, ["--version"], { timeout: 10000 })).stdout.trim();
const parentRunId = randomUUID();
const outputDir = path.resolve(".agent-output/model-review", parentRunId);
await mkdir(outputDir, { recursive: true });
const hash = text => createHash("sha256").update(text).digest("hex");
const source = { taskId: detail.task.id, roundId: round.id, taskRevision: round.taskRevision,
  specSnapshot: round.specSnapshot, baseCommit: candidate.baseCommit, candidateCommit: candidate.candidateCommit,
  diffSha256: candidate.diffSha256, diff: candidate.diff, commits: candidate.commits };
await writeFile(path.join(outputDir, "source.json"), JSON.stringify(source, null, 2));
async function axisRun(axis) {
  const instruction = axis === "spec"
    ? "仅作为需求轴审查固定任务快照：完整性、错误实现和范围蔓延。逐项指出代码证据和未覆盖项。"
    : "仅作为标准轴审查：先读取本仓库已文档化规范（记录具体来源），仓库规范优先；Fowler代码坏味道仅作为有依据的判断提示。";
  const prompt = `${instruction}\n这是只读评审。不要修改文件、调用网络写入、提交报告或裁决。不要读取其他评审输出或 .agent-output。两个轴互相独立；只用本提示、当前固定候选和仓库规范。输出独立Markdown报告，结论为PASS或CHANGES_REQUESTED，并列事实依据、风险与未执行检查。不要把没有运行的测试写成通过。\n固定输入：\n${JSON.stringify(source, null, 2)}\n`;
  const lastPath = path.join(outputDir, `${axis}.md`);
  const argv = ["exec", "--sandbox", "read-only", "--ephemeral", "--json", "--output-last-message", lastPath, "-"];
  await writeFile(path.join(outputDir, `${axis}.prompt.md`), prompt);
  const startedAt = new Date().toISOString();
  const invocationId = randomUUID();
  let stdout = "", stderr = "", pending = "", contextId = null, modelStart = null, modelEnd = null, agentOutput = null, exceeded = false;
  const child = spawn(executable, argv, { cwd: candidate.repositoryRoot, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  const timer = setTimeout(() => child.kill("SIGTERM"), 15 * 60 * 1000);
  timer.unref();
  child.stdout.on("data", chunk => {
    if (stdout.length + chunk.length > 16 * 1024 * 1024) { exceeded = true; child.kill("SIGTERM"); return; }
    stdout += chunk; pending += chunk;
    let end;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      try {
        const event = JSON.parse(line);
        if (event.type === "thread.started") contextId = event.thread_id;
        if (event.type === "turn.started") modelStart = new Date().toISOString();
        if (event.type === "turn.completed") modelEnd = new Date().toISOString();
        if (event.type === "item.completed" && event.item?.type === "agent_message") agentOutput = event.item.text;
      } catch { /* 原始JSONL完整保存；非事件行不据此认定模型运行。 */ }
    }
  });
  child.stderr.on("data", chunk => { if (stderr.length < 1024 * 1024) stderr += chunk.toString(); });
  const exitCode = await new Promise(resolve => {
    child.once("error", error => { stderr += `${error.message}\n`; resolve(-1); });
    child.once("close", code => resolve(code ?? -1));
    child.stdin.on("error", () => {}); child.stdin.end(prompt);
  });
  clearTimeout(timer);
  const completedAt = new Date().toISOString();
  const output = await readFile(lastPath, "utf8").catch(() => "");
  await writeFile(path.join(outputDir, `${axis}.jsonl`), stdout);
  await writeFile(path.join(outputDir, `${axis}.stderr.log`), stderr);
  const collected = !exceeded && exitCode === 0 && contextId && modelStart && modelEnd && output.trim() && agentOutput?.trim() === output.trim();
  return { axis, status: collected ? "MODEL_OUTPUT_COLLECTED" : "BLOCKED_OR_FAILED", evidence: {
    provenance: "reviewer-declared", host: "codex-cli", hostVersion: version, parentRunId, invocationId, contextId,
    startedAt: modelStart, completedAt: modelEnd, command: { argv: [executable, ...argv], cwd: candidate.repositoryRoot, startedAt, completedAt, exitCode },
    promptSha256: hash(prompt), transcriptSha256: hash(stdout), evidenceRef: outputDir,
    baseCommit: candidate.baseCommit, candidateCommit: candidate.candidateCommit, diffSha256: candidate.diffSha256,
  } };
}
const results = await Promise.all([axisRun("spec"), axisRun("standards")]);
const after = await captureReviewCandidate({ repoPath: candidate.repositoryRoot, fixedPoint: candidate.baseCommit }).catch(() => null);
const independent = results[0].evidence.contextId !== results[1].evidence.contextId;
const overlap = Math.max(...results.map(item => Date.parse(item.evidence.startedAt))) < Math.min(...results.map(item => Date.parse(item.evidence.completedAt)));
const collected = results.every(item => item.status === "MODEL_OUTPUT_COLLECTED") && independent && overlap
  && after?.candidateCommit === candidate.candidateCommit && after?.diffSha256 === candidate.diffSha256;
await writeFile(path.join(outputDir, "evidence.json"), JSON.stringify({ status: collected ? "READY_FOR_REVIEWER" : "BLOCKED_OR_FAILED",
  taskId: detail.task.id, roundId: round.id, results, independent, overlap, platformReportsSubmitted: false }, null, 2));
console.log(JSON.stringify({ outputDir, status: collected ? "READY_FOR_REVIEWER" : "BLOCKED_OR_FAILED", platformReportsSubmitted: false }));
if (!collected) process.exitCode = 1;

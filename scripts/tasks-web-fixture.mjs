#!/usr/bin/env node
/** 阶段 3 浏览器验收：独立 SQLite + 干净 Git 候选。合成报告仅验证 UI，绝不作为真实模型证据。 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLogger } from "../src/server/logger.ts";
import { startServer } from "../src/server/server.ts";
import { createRepositories } from "../src/server/db/repositories.ts";
import { createTaskService } from "../src/server/tasks/service.ts";
import { actorForMember, ownerActor } from "../src/server/authz/actors.ts";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), "boardroom-tasks-web-"));
const repoPath = path.join(root, "candidate");
let server;
let closing;
function close(code = 0) {
  closing ??= (async () => { try { await server?.close(); } finally { await rm(root, { recursive: true, force: true }); } })().then(() => process.exit(code), () => process.exit(1));
  return closing;
}
process.on("SIGTERM", () => { void close(); });
process.on("SIGINT", () => { void close(); });
process.stdin.resume(); process.stdin.on("end", () => { void close(); });

try {
  await mkdir(repoPath);
  const git = (...args) => execFileAsync("git", args, { cwd: repoPath });
  await git("init", "--quiet");
  await writeFile(path.join(repoPath, "README.md"), "# 浏览器测试候选\n规范：使用明确命名，保持函数职责单一。\n");
  await git("add", "README.md");
  await git("-c", "user.name=Boardroom UI Fixture", "-c", "user.email=ui-fixture@example.invalid", "commit", "--quiet", "-m", "固定基准");
  const fixedPoint = (await git("rev-parse", "HEAD")).stdout.trim();
  await writeFile(path.join(repoPath, "greeting.js"), "export const greeting = (name) => `你好，${name}`;\n");
  await git("add", "greeting.js");
  await git("-c", "user.name=Boardroom UI Fixture", "-c", "user.email=ui-fixture@example.invalid", "commit", "--quiet", "-m", "增加问候函数");
  server = await startServer({
    config: { port: 0, dbDriver: "sqlite", dataDir: path.join(root, "data"), heartbeat: { intervalMs: 1000, timeoutMs: 10000 }, configFile: null },
    logger: createLogger({ write: () => {} }), webRoot: path.resolve(import.meta.dirname, "../dist/web"),
  });
  const repos = createRepositories(server.database);
  const service = createTaskService({ repos });
  const records = [];
  for (const name of ["任务与评审验收", "独立项目乙"]) {
    const project = await repos.projects.create({ name });
    const members = [];
    for (const label of ["实现者", "需求评审", "备用评审"]) {
      const agent = await repos.agents.create({ displayName: `${name} · ${label}`, hostType: "codex-cli" });
      members.push(await repos.members.create({ projectId: project.id, kind: "agent", agentId: agent.id, displayName: label }));
    }
    const owner = { actor: ownerActor(project.id) };
    const settings = await service.getSettings(owner, project.id);
    await service.setSettings(owner, project.id, { expectedRevision: settings.revision, defaultReviewerMemberId: members[1].id });
    records.push({ project, members });
  }
  const first = records[0], owner = { actor: ownerActor(first.project.id) };
  const create = (title, assigneeMemberId = first.members[0].id) => service.create(owner, first.project.id, { title, body: "完成目标，保留清楚的验收与评审记录。", deliveryKind: "code", acceptanceText: "目标实现、评审和交付记录完整可核对。", labels: ["浏览器验收"], assigneeMemberId, repoPath, fixedPoint });
  await create("整理交付目标");
  let active = await create("进行中的协作任务");
  active = await service.transition(owner, first.project.id, active.id, { expectedRevision: active.revision, state: "in-progress" });
  let blocked = await create("等待协作支持");
  blocked = await service.transition(owner, first.project.id, blocked.id, { expectedRevision: blocked.revision, state: "blocked", reason: "需要确认验收样本" });

  async function reportedTask(title, assigneeMemberId) {
    let task = await create(title, assigneeMemberId);
    task = await service.transition(owner, first.project.id, task.id, { expectedRevision: task.revision, state: "in-progress" });
    const started = await service.startReview(owner, first.project.id, task.id, { expectedRevision: task.revision });
    if (!started.ready) throw new Error(`浏览器候选失败：${started.error.message}`);
    const reviewer = { actor: actorForMember(first.members[1]) };
    let round = await service.beginReview(reviewer, first.project.id, task.id, started.round.id, { expectedTaskRevision: started.task.revision, expectedRoundRevision: started.round.revision });
    const startedAt = new Date(Date.now() - 2000).toISOString(), completedAt = new Date(Date.now() - 1000).toISOString();
    for (const axis of ["spec", "standards"]) {
      const candidate = started.round.candidate;
      await service.submitReport(reviewer, first.project.id, task.id, round.id, {
        expectedTaskRevision: started.task.revision, expectedRoundRevision: round.revision, axis, verdict: "pass",
        body: `${axis === "spec" ? "需求轴" : "标准轴"}的浏览器合成报告。仅用于界面与持久化链路验证，不作为真实模型评审证据。`,
        sources: [axis === "spec" ? `task:${task.id}` : `${repoPath}/README.md`],
        evidence: { provenance: "reviewer-declared", host: "ui-fixture", hostVersion: "1", parentRunId: `fixture-${task.id}`, invocationId: `${task.id}-${axis}`, contextId: `context-${task.id}-${axis}`, startedAt, completedAt,
          command: { argv: ["fixture", axis], cwd: repoPath, startedAt, completedAt, exitCode: 0 }, promptSha256: "a".repeat(64), transcriptSha256: (axis === "spec" ? "b" : "c").repeat(64), evidenceRef: `fixture://ui/${task.id}/${axis}`,
          baseCommit: candidate.baseCommit, candidateCommit: candidate.candidateCommit, diffSha256: candidate.diffSha256 },
      });
      round = (await service.get(owner, first.project.id, task.id)).rounds.find((entry) => entry.id === round.id);
    }
    return (await service.get(owner, first.project.id, task.id)).task;
  }
  const review = await reportedTask("两轴报告等待管理者裁决");
  const complete = await reportedTask("已完成的交付任务");
  const completeDetail = await service.get(owner, first.project.id, complete.id);
  const completeRound = completeDetail.rounds.find((round) => round.id === complete.currentReviewRoundId);
  await service.decideReview(owner, first.project.id, complete.id, completeRound.id, { expectedTaskRevision: complete.revision, expectedRoundRevision: completeRound.revision, verdict: "pass", reason: "浏览器样本：已有交付完成", override: true });
  const recoveryTasks = [];
  for (const lifecycle of ["disabled", "removed"]) {
    const agent = await repos.agents.create({ displayName: `重开验收 · ${lifecycle}`, hostType: "codex-cli" });
    const member = await repos.members.create({ projectId: first.project.id, kind: "agent", agentId: agent.id, displayName: `将${lifecycle}的负责人` });
    const recovery = await reportedTask(`负责人${lifecycle}后需要重开的任务`, member.id);
    const detail = await service.get(owner, first.project.id, recovery.id);
    const round = detail.rounds.find(item => item.id === recovery.currentReviewRoundId);
    await service.decideReview(owner, first.project.id, recovery.id, round.id, { expectedTaskRevision: recovery.revision,
      expectedRoundRevision: round.revision, verdict: "pass", reason: "恢复入口的完整生命周期 fixture", override: true });
    recoveryTasks.push({ taskId: recovery.id, assigneeMemberId: member.id, lifecycle });
  }
  const second = records[1];
  await service.create({ actor: ownerActor(second.project.id) }, second.project.id, { title: "乙项目独立任务", body: "仅属于项目乙", assigneeMemberId: second.members[0].id });
  process.stdout.write(`${JSON.stringify({ url: server.url, records, repoPath, fixedPoint, reviewTaskId: review.id, recoveryTasks, evidenceScope: "synthetic-ui-reports-not-model-acceptance" })}\n`);
} catch (error) {
  process.stderr.write(`tasks_web_fixture_failed: ${error instanceof Error ? error.stack : "unknown"}\n`);
  await close(1);
}

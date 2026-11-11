/** 真 HTTP + MCP SDK + Git + 数据库任务链。报告正文为协议夹具，不是 AC-REVIEW-04 模型证据。 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer } from "../src/server/server.ts";
import { createLogger } from "../src/server/logger.ts";

const exec = promisify(execFile);
const dir = await mkdtemp(path.join(tmpdir(), "boardroom-task-e2e-"));
const repository = path.join(dir, "candidate");
await mkdir(repository);
const git = async (...args) => (await exec("git", args, { cwd: repository, timeout: 10000 })).stdout.trim();
const config = { port: 0, dataDir: path.join(dir, "data"), configFile: null,
  heartbeat: { intervalMs: 1000, timeoutMs: 60000 },
  dbDriver: process.env.AGENT_STUDIO_DB_DRIVER === "postgres" ? "postgres" : "sqlite",
  ...(process.env.AGENT_STUDIO_PG_CONNECTION_STRING ? { pgConnectionString: process.env.AGENT_STUDIO_PG_CONNECTION_STRING } : {}),
};
const clients = [];
const checks = [];
let server;
let projectId;
function checked(name, assertion) { assertion(); checks.push(name); }
const hash = text => createHash("sha256").update(text).digest("hex");
async function http(method, url, body, expected = 200) {
  const response = await fetch(`http://127.0.0.1:${server.port}${url}`, { method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  assert.equal(response.status, expected, JSON.stringify(result));
  return result;
}
async function connect(name, groupId, role) {
  const client = new Client({ name, version: "tasks-protocol-fixture" });
  const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl));
  await client.connect(transport);
  clients.push({ client, transport });
  async function call(name, args) {
    const response = await client.callTool({ name, arguments: args });
    return JSON.parse(response.content.find(item => item.type === "text").text);
  }
  const joined = await call("join", { displayName: name, hostType: "other", projectId, groupId, ...(role ? { role } : {}) });
  assert.equal(joined.ok, true, JSON.stringify(joined));
  return { call, joined };
}
try {
  await git("init", "--quiet");
  await git("config", "user.name", "Boardroom protocol fixture");
  await git("config", "user.email", "protocol-fixture@example.invalid");
  await writeFile(path.join(repository, "README.md"), "# Fixture\nInitial state.\n");
  await git("add", "README.md"); await git("commit", "--quiet", "-m", "base");
  const baseCommit = await git("rev-parse", "HEAD");
  await writeFile(path.join(repository, "README.md"), "# Fixture\nTask candidate with a documented outcome.\n");
  await git("add", "README.md"); await git("commit", "--quiet", "-m", "candidate");
  const candidateCommit = await git("rev-parse", "HEAD");
  server = await startServer({ config, logger: createLogger({ write: () => {} }) });
  projectId = (await http("POST", "/api/projects", { name: `任务协议验收 ${Date.now()}` }, 201)).project.id;
  const groupId = (await http("POST", `/api/projects/${projectId}/groups`, { name: "任务协作" }, 201)).group.id;
  const worker = await connect(`执行者-${projectId}`, groupId);
  const reviewer = await connect(`评审者-${projectId}`, groupId);
  const manager = await connect(`统筹-${projectId}`, groupId, "manager");
  const prefix = `/api/projects/${projectId}`;
  const quick = await manager.call("create_task", { title: "先记下待整理的需求", reviewerMemberId: null });
  checked("MCP 标题录入持久 todo，缺分派不误发执行或评审通知", () => {
    assert.equal(quick.ok, true, JSON.stringify(quick)); assert.equal(quick.task.state, "todo");
    assert.equal(quick.task.body, ""); assert.equal(quick.task.assigneeMemberId, null); assert.equal(quick.task.reviewerMemberId, null);
    assert.equal(quick.task.deliveryKind, null); assert.equal(quick.task.acceptanceSource, "explicit");
  });
  const quickRead = await http("GET", `${prefix}/tasks/${quick.task.id}`);
  const httpGate = await http("POST", `${prefix}/tasks/${quick.task.id}/transitions`, { expectedRevision: quick.task.revision, state: "in-progress" }, 400);
  const mcpGate = await manager.call("transition_task", { taskId: quick.task.id, expectedRevision: quick.task.revision, state: "in-progress" });
  checked("HTTP 与 MCP 使用相同资料门禁，缺条件不能经旧 transition 推进", () => {
    assert.deepEqual(quickRead.task, quick.task);
    assert.equal(mcpGate.ok, false); assert.equal(mcpGate.error.details.reason, "task_materials_incomplete");
    assert.deepEqual(httpGate.error.details.reasonCodes, mcpGate.error.details.reasonCodes);
    assert.deepEqual(httpGate.error.details.reasonCodes, quick.task.materialStatus.startExecution.reasonCodes);
    assert.equal(quick.task.materialStatus.executionAdmission, "not-issued");
    assert.equal("allowed" in quick.task.materialStatus.startExecution, false);
  });
  const forbiddenQuick = await worker.call("create_task", { title: "普通执行人不能借未分派取得创建权" });
  const noQuickEvent = await worker.call("wait_for_messages", { timeoutMs: 100 });
  checked("nullable 录入保持 MCP 权限，未分派不投递工作事件", () => {
    assert.equal(forbiddenQuick.error.code, "FORBIDDEN"); assert.equal(noQuickEvent.status, "timeout");
  });
  await http("PUT", `${prefix}/task-settings`, { expectedRevision: 0, defaultReviewerMemberId: reviewer.joined.memberId });
  let task = (await http("POST", `${prefix}/tasks`, { title: "验证任务协议链", body: "README 应记录候选结果。", labels: ["protocol"],
    deliveryKind: "code", acceptanceText: "README 应记录候选结果，并通过指定候选两轴检查。",
    assigneeMemberId: worker.joined.memberId, repoPath: repository, fixedPoint: baseCommit }, 201)).task;
  checked("人通过 HTTP 创建完整任务并使用明确默认 reviewer", () => assert.equal(task.reviewerMemberId, reviewer.joined.memberId));
  const notification = await worker.call("wait_for_messages", { timeoutMs: 100 });
  checked("指派事件经 MCP 投递", () => assert.equal(notification.workEvents?.[0]?.taskId, task.id));
  assert.equal((await worker.call("acknowledge_work_event", { eventId: notification.workEvents[0].id })).ok, true);
  const afterAck = await http("GET", `${prefix}/tasks/${task.id}`);
  checked("ACK 不推进任务", () => assert.equal(afterAck.task.state, "todo"));
  task = (await worker.call("transition_task", { taskId: task.id, expectedRevision: task.revision, state: "in-progress" })).task;
  const start = await worker.call("start_task_review", { taskId: task.id, expectedRevision: task.revision });
  checked("真实 Git 固定点与候选提交可追溯", () => {
    assert.equal(start.ready, true, JSON.stringify(start));
    assert.equal(start.round.candidate.baseCommit, baseCommit);
    assert.equal(start.round.candidate.candidateCommit, candidateCommit);
    assert.ok(start.round.candidate.diff.includes("documented outcome"));
  });
  task = start.task;
  let round = (await reviewer.call("begin_task_review", { taskId: task.id, roundId: start.round.id,
    expectedTaskRevision: task.revision, expectedRoundRevision: start.round.revision })).round;
  const time = Date.now();
  const iso = offset => new Date(time + offset).toISOString();
  const report = axis => ({ taskId: task.id, roundId: round.id, expectedTaskRevision: task.revision, expectedRoundRevision: round.revision,
    axis, verdict: "pass", body: `${axis} 协议夹具：验证独立保存；没有执行模型评审。`, sources: [axis === "spec" ? "task.specSnapshot" : "README.md"],
    evidence: { provenance: "reviewer-declared", host: "sdk-protocol-fixture", hostVersion: process.version,
      parentRunId: "protocol-parent", invocationId: `protocol-${axis}`, contextId: `isolated-${axis}`,
      startedAt: iso(-3000), completedAt: iso(-1000), promptSha256: hash(`fixture-prompt-${axis}`), transcriptSha256: hash(`fixture-output-${axis}`),
      evidenceRef: "scripts/e2e-tasks.mjs (synthetic report fixture; not model execution)",
      baseCommit, candidateCommit, diffSha256: start.round.candidate.diffSha256,
      command: { argv: ["node", "scripts/e2e-tasks.mjs"], cwd: process.cwd(), startedAt: iso(-5000), completedAt: iso(0), exitCode: 0 } },
  });
  const inputs = [report("spec"), report("standards")];
  const concurrent = await Promise.all(inputs.map(input => reviewer.call("submit_task_review_report", input)));
  checked("两轴并发 CAS 只接受一个旧令牌", () => {
    assert.equal(concurrent.filter(result => result.ok).length, 1);
    assert.equal(concurrent.find(result => !result.ok)?.error.code, "CONFLICT");
  });
  let detail = await reviewer.call("read_task", { taskId: task.id });
  round = detail.rounds.find(item => item.id === round.id);
  const loser = concurrent.findIndex(result => !result.ok);
  assert.equal((await reviewer.call("submit_task_review_report", { ...inputs[loser], expectedRoundRevision: round.revision })).ok, true);
  detail = await reviewer.call("read_task", { taskId: task.id });
  round = detail.rounds.find(item => item.id === round.id);
  checked("两轴分别呈现并写入评论", () => {
    assert.deepEqual(detail.reports.map(item => item.axis).sort(), ["spec", "standards"]);
    assert.equal(detail.comments.filter(item => item.kind === "review_report").length, 2);
  });
  task = (await reviewer.call("decide_task_review", { taskId: task.id, roundId: round.id,
    expectedTaskRevision: task.revision, expectedRoundRevision: round.revision, verdict: "pass", reason: "协议夹具两轴已提交" })).task;
  checked("指定 reviewer 裁决进入 done", () => assert.equal(task.state, "done"));
  detail = await http("GET", `${prefix}/tasks/${task.id}`);
  round = detail.rounds.find(item => item.id === round.id);
  task = (await http("POST", `${prefix}/tasks/${task.id}/reviews/${round.id}/decision`, {
    expectedTaskRevision: task.revision, expectedRoundRevision: round.revision, verdict: "changes_requested", reason: "人要求补充真实模型验收", override: true,
  })).task;
  detail = await http("GET", `${prefix}/tasks/${task.id}`);
  checked("管理者覆盖保留原裁决和两份报告", () => {
    assert.equal(task.state, "in-progress"); assert.equal(detail.reports.length, 2);
    assert.ok(detail.history.some(item => item.detail.previousDecision?.verdict === "pass"));
  });
  const applicationCommit = (await exec("git", ["rev-parse", "HEAD"], { cwd: process.cwd() })).stdout.trim();
  const applicationTree = (await exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: process.cwd() })).stdout.trim();
  const output = { status: "PASS", applicationCommit, applicationTree, driver: config.dbDriver, checks, realModelReview: "NOT_RUN", baseCommit, candidateCommit };
  await mkdir(".agent-output/tasks-e2e", { recursive: true });
  await writeFile(`.agent-output/tasks-e2e/${config.dbDriver}.json`, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
} finally {
  for (const { client, transport } of clients.reverse()) {
    await transport.terminateSession().catch(() => {}); await client.close();
  }
  if (server) await server.close();
  await rm(dir, { recursive: true, force: true });
}

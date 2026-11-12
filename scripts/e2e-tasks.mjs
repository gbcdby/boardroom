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
  const result = response.status === 204 ? null : await response.json();
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
  let assignedQuick = (await http("PATCH", `${prefix}/tasks/${quick.task.id}`, { expectedRevision: quick.task.revision, assigneeMemberId: worker.joined.memberId })).task;
  const firstAssignment = await worker.call("wait_for_messages", { timeoutMs: 100 });
  assert.equal(firstAssignment.workEvents?.[0]?.taskId, quick.task.id);
  await worker.call("acknowledge_work_event", { eventId: firstAssignment.workEvents[0].id });
  const noChange = await manager.call("update_task", { taskId: quick.task.id, expectedRevision: assignedQuick.revision, assigneeMemberId: worker.joined.memberId });
  const staleAssignment = await http("PATCH", `${prefix}/tasks/${quick.task.id}`, { expectedRevision: quick.task.revision, assigneeMemberId: worker.joined.memberId }, 409);
  const noRepeatedAssignment = await worker.call("wait_for_messages", { timeoutMs: 100 });
  checked("实际分派从null产生一次事件，无变化MCP更新与旧CAS不重复通知", () => {
    assert.equal(noChange.ok, true); assert.equal(noChange.task.revision, assignedQuick.revision);
    assert.equal(staleAssignment.error.code, "conflict"); assert.equal(noRepeatedAssignment.status, "timeout");
  });
  assignedQuick = (await manager.call("update_task", { taskId: quick.task.id, expectedRevision: assignedQuick.revision, assigneeMemberId: reviewer.joined.memberId })).task;
  const reassigned = await reviewer.call("wait_for_messages", { timeoutMs: 100 });
  const oldRecipient = await worker.call("wait_for_messages", { timeoutMs: 100 });
  checked("实际改派只通知新负责人，不通知旧负责人", () => {
    assert.equal(reassigned.workEvents?.length, 1); assert.equal(reassigned.workEvents[0].taskId, quick.task.id);
    assert.equal(oldRecipient.status, "timeout");
  });
  await reviewer.call("acknowledge_work_event", { eventId: reassigned.workEvents[0].id });
  assignedQuick = (await http("PATCH", `${prefix}/tasks/${quick.task.id}`, { expectedRevision: assignedQuick.revision, assigneeMemberId: null })).task;
  assert.equal(assignedQuick.assigneeMemberId, null);
  const finding = (await http("PATCH", `${prefix}/tasks/${quick.task.id}`, { expectedRevision: assignedQuick.revision, assigneeMemberId: worker.joined.memberId,
    reviewerMemberId: reviewer.joined.memberId, deliveryKind: "finding", body: "整理事实与来源", acceptanceText: "结论可以复核", repoPath: repository, fixedPoint: baseCommit })).task;
  const findingAssignment = await worker.call("wait_for_messages", { timeoutMs: 100 });
  await worker.call("acknowledge_work_event", { eventId: findingAssignment.workEvents[0].id });
  const findingStarted = await worker.call("transition_task", { taskId: finding.id, expectedRevision: finding.revision, state: "in-progress" });
  const findingReview = await http("POST", `${prefix}/tasks/${finding.id}/reviews`, { expectedRevision: findingStarted.task.revision }, 400);
  const findingDetail = await http("GET", `${prefix}/tasks/${finding.id}`);
  const noFindingReviewEvent = await reviewer.call("wait_for_messages", { timeoutMs: 100 });
  checked("非代码任务即使附真实Git也不能使用旧评审，不创建轮次或评审就绪事件", () => {
    assert.equal(findingStarted.ok, true); assert.ok(findingReview.error.details.reasonCodes.includes("candidate_type_requires_v2"));
    assert.equal(findingDetail.task.state, "in-progress"); assert.deepEqual(findingDetail.rounds, []); assert.equal(noFindingReviewEvent.status, "timeout");
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
  async function completedTask(title, assigneeMemberId) {
    let current = (await http("POST", `${prefix}/tasks`, { title, body: "可继续完善的目标", deliveryKind: "code",
      acceptanceText: "既有候选与评审历史完整保留", assigneeMemberId, repoPath: repository, fixedPoint: baseCommit }, 201)).task;
    current = (await manager.call("transition_task", { taskId: current.id, expectedRevision: current.revision, state: "in-progress" })).task;
    const prepared = await manager.call("start_task_review", { taskId: current.id, expectedRevision: current.revision });
    assert.equal(prepared.ready, true, JSON.stringify(prepared)); current = prepared.task;
    assert.equal(prepared.round.candidate.diffSha256, start.round.candidate.diffSha256);
    let currentRound = (await reviewer.call("begin_task_review", { taskId: current.id, roundId: prepared.round.id,
      expectedTaskRevision: current.revision, expectedRoundRevision: prepared.round.revision })).round;
    for (const axis of ["spec", "standards"]) {
      const input = report(axis);
      const submitted = await reviewer.call("submit_task_review_report", { ...input, taskId: current.id, roundId: currentRound.id,
        expectedTaskRevision: current.revision, expectedRoundRevision: currentRound.revision,
        evidence: { ...input.evidence, parentRunId: `recovery-${current.id}`, invocationId: `${current.id}-${axis}`, contextId: `${current.id}-${axis}` } });
      assert.equal(submitted.ok, true, JSON.stringify(submitted));
      currentRound = (await http("GET", `${prefix}/tasks/${current.id}`)).rounds.find(item => item.id === currentRound.id);
    }
    const decided = await reviewer.call("decide_task_review", { taskId: current.id, roundId: currentRound.id,
      expectedTaskRevision: current.revision, expectedRoundRevision: currentRound.revision, verdict: "pass", reason: "恢复路径的两轴协议 fixture 已完成" });
    assert.equal(decided.ok, true, JSON.stringify(decided)); assert.equal(decided.task.state, "done");
    return decided.task;
  }
  const taskEvents = id => server.database.query("SELECT * FROM work_events WHERE task_id = ? ORDER BY id", [id]);
  for (const lifecycle of ["disabled", "removed"]) {
    const departing = await connect(`将${lifecycle}的执行者-${projectId}`, groupId);
    let recovery = await completedTask(`${lifecycle} 后重新打开`, departing.joined.memberId);
    const beforeDenied = await http("GET", `${prefix}/tasks/${recovery.id}`);
    const forbidden = await departing.call("transition_task", { taskId: recovery.id, expectedRevision: recovery.revision, state: "todo", reason: "普通负责人没有覆盖权" });
    const noReason = await manager.call("transition_task", { taskId: recovery.id, expectedRevision: recovery.revision, state: "todo" });
    checked(`${lifecycle} 场景：MCP 重开不能借自身负责权或省略理由绕过管理权限`, () => {
      assert.equal(forbidden.error.code, "FORBIDDEN"); assert.equal(noReason.error.details.reason, "task_reason_required");
    });
    assert.deepEqual(await http("GET", `${prefix}/tasks/${recovery.id}`), beforeDenied);
    if (lifecycle === "disabled") await http("POST", `${prefix}/members/${departing.joined.memberId}/disable`, {});
    else await http("DELETE", `${prefix}/members/${departing.joined.memberId}`, undefined, 204);
    const before = await http("GET", `${prefix}/tasks/${recovery.id}`);
    recovery = before.task;
    assert.equal(recovery.state, "done");
    const expectedReason = lifecycle === "disabled" ? "assignee_invalid" : "assignee_required";
    assert.deepEqual(recovery.materialStatus.startExecution.reasonCodes, [expectedReason]);
    const beforeEvents = await taskEvents(recovery.id);
    const rejectedHttp = await http("POST", `${prefix}/tasks/${recovery.id}/transitions`,
      { expectedRevision: recovery.revision, state: "in-progress", reason: "直接恢复执行仍须满足资料" }, 400);
    const rejectedMcp = await manager.call("transition_task", { taskId: recovery.id, expectedRevision: recovery.revision, state: "in-progress", reason: "直接恢复执行仍须满足资料" });
    const rejectedEdit = await http("PATCH", `${prefix}/tasks/${recovery.id}`, { expectedRevision: recovery.revision, assigneeMemberId: manager.joined.memberId }, 409);
    checked(`${lifecycle} 场景：HTTP/MCP 保留直接执行资料门禁与 done 编辑限制`, () => {
      assert.deepEqual(rejectedHttp.error.details.reasonCodes, [expectedReason]);
      assert.equal(rejectedMcp.error.details.reason, "task_materials_incomplete");
      assert.deepEqual(rejectedMcp.error.details.reasonCodes, [expectedReason]);
      assert.equal(rejectedEdit.error.reason, "task_reopen_required");
    });
    const reopen = { expectedRevision: recovery.revision, state: "todo", reason: "原负责人离岗，重新安排后续工作" };
    const opened = lifecycle === "disabled"
      ? await http("POST", `${prefix}/tasks/${recovery.id}/transitions`, reopen)
      : await manager.call("transition_task", { taskId: recovery.id, ...reopen });
    assert.ok(opened.task, JSON.stringify(opened)); recovery = opened.task;
    const after = await http("GET", `${prefix}/tasks/${recovery.id}`);
    checked(`${lifecycle} 场景：${lifecycle === "disabled" ? "HTTP" : "MCP"} 重开仅进入 todo，旧候选报告裁决逐字保留`, () => {
      assert.equal(recovery.state, "todo"); assert.equal(recovery.revision, before.task.revision + 1);
      assert.equal(recovery.currentReviewRoundId, null); assert.equal(recovery.assigneeMemberId, before.task.assigneeMemberId);
      assert.equal(recovery.materialStatus.executionAdmission, "not-issued");
      assert.deepEqual(after.rounds, before.rounds); assert.deepEqual(after.reports, before.reports); assert.deepEqual(after.comments, before.comments);
      assert.deepEqual(after.history.slice(0, -1), before.history);
      assert.deepEqual(after.history.at(-1).detail, { from: "done", to: "todo", reason: reopen.reason });
    });
    assert.deepEqual(await taskEvents(recovery.id), beforeEvents, "重开不产生分派或受阻升级通知");
    const stale = await http("POST", `${prefix}/tasks/${recovery.id}/transitions`, reopen, 409);
    assert.equal(stale.error.reason, "task_revision_conflict");
    assert.deepEqual(await http("GET", `${prefix}/tasks/${recovery.id}`), after);
    recovery = (await manager.call("update_task", { taskId: recovery.id, expectedRevision: recovery.revision, assigneeMemberId: manager.joined.memberId })).task;
    const events = await taskEvents(recovery.id);
    const newEvents = events.filter(event => !beforeEvents.some(old => old.id === event.id));
    const received = await manager.call("wait_for_messages", { timeoutMs: 100 });
    checked(`${lifecycle} 场景：todo 真正改派仅通知新负责人，MCP ACK 不开始执行`, () => {
      assert.equal(newEvents.length, 1); assert.equal(newEvents[0].kind, "task.assigned");
      assert.equal(newEvents[0].recipient_member_id, manager.joined.memberId);
      assert.equal(received.workEvents?.length, 1); assert.equal(received.workEvents[0].taskId, recovery.id);
      assert.equal(received.workEvents[0].id, newEvents[0].id);
    });
    assert.equal((await manager.call("acknowledge_work_event", { eventId: received.workEvents[0].id })).ok, true);
    assert.equal((await http("GET", `${prefix}/tasks/${recovery.id}`)).task.state, "todo");
    const resumed = await manager.call("transition_task", { taskId: recovery.id, expectedRevision: recovery.revision, state: "in-progress" });
    assert.equal(resumed.ok, true, JSON.stringify(resumed)); assert.equal(resumed.task.state, "in-progress");
    assert.deepEqual((await http("GET", `${prefix}/tasks/${recovery.id}`)).rounds, before.rounds);
  }
  const compatible = await completedTask("旧客户端资料完整的直接重开", worker.joined.memberId);
  const direct = await manager.call("transition_task", { taskId: compatible.id, expectedRevision: compatible.revision,
    state: "in-progress", reason: "旧客户端有管理权限、完整资料及理由" });
  checked("MCP 旧 done→in-progress 完整资料正控制仍可用", () => {
    assert.equal(direct.ok, true, JSON.stringify(direct)); assert.equal(direct.task.state, "in-progress");
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

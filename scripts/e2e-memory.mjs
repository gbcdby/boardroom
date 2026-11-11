/** 真实 HTTP + MCP SDK + 数据库记忆链；固定摘要仅是协议夹具，不是模型验收。 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer } from "../src/server/server.ts";
import { createLogger } from "../src/server/logger.ts";
import { DEFAULT_MEMORY_CONFIG } from "../src/server/config.ts";

const exec = promisify(execFile), hash = value => createHash("sha256").update(value).digest("hex");
const dir = await mkdtemp(path.join(tmpdir(), "boardroom-memory-e2e-"));
const config = { port: 0, dataDir: dir, configFile: null, heartbeat: { intervalMs: 1000, timeoutMs: 60000 },
  memory: { ...DEFAULT_MEMORY_CONFIG, messageThreshold: 2 },
  dbDriver: process.env.AGENT_STUDIO_DB_DRIVER === "postgres" ? "postgres" : "sqlite",
  ...(process.env.AGENT_STUDIO_PG_CONNECTION_STRING ? { pgConnectionString: process.env.AGENT_STUDIO_PG_CONNECTION_STRING } : {}),
};
const clients = [], checks = [];
let server, projectId;
async function http(method, url, body, expected = 200) {
  const response = await fetch(server.url + url, { method, headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  assert.equal(response.status, expected, JSON.stringify(result)); return result;
}
async function connect(name, groupId) {
  const client = new Client({ name, version: "memory-protocol-fixture" });
  const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl));
  await client.connect(transport); clients.push({ client, transport });
  async function call(name, args) {
    const response = await client.callTool({ name, arguments: args });
    return JSON.parse(response.content.find(item => item.type === "text").text);
  }
  const joined = await call("join", { displayName: name, hostType: "other", projectId, groupId });
  assert.equal(joined.ok, true, JSON.stringify(joined));
  return { call, joined };
}
function evidence(markdown, label) {
  const at = new Date().toISOString();
  return { provenance: "agent-declared", host: "sdk-protocol-fixture", hostVersion: process.version,
    invocationId: `fixture-${label}`, contextId: "synthetic-target-context", startedAt: at, completedAt: at,
    promptSha256: hash("explicitly synthetic protocol input"), outputSha256: hash(markdown),
    evidenceRef: "scripts/e2e-memory.mjs (synthetic output; no model execution)" };
}
try {
  server = await startServer({ config, logger: createLogger({ write() {} }) });
  projectId = (await http("POST", "/api/projects", { name: `记忆协议 ${Date.now()}` }, 201)).project.id;
  const groupId = (await http("POST", `/api/projects/${projectId}/groups`, { name: "实际协作" }, 201)).group.id;
  const worker = await connect(`记忆本人-${projectId}`, groupId), other = await connect(`其他成员-${projectId}`, groupId);
  const prefix = `/api/projects/${projectId}/memories`, own = `${prefix}/agents/${worker.joined.agentId}`;
  assert.equal((await http("GET", "/api/memory-settings")).settings.messageThreshold, 2);
  assert.equal((await http("GET", `${prefix}/shared`)).version, 0);
  await http("PUT", `${prefix}/shared`, { expectedVersion: 0, clientMutationId: "shared", markdown: "共享协作规范" });
  assert.equal((await worker.call("read_memory", { scope: "project" })).document.markdown, "共享协作规范");
  assert.equal((await worker.call("write_memory", { scope: "project", expectedVersion: 1, clientMutationId: "forged", markdown: "越权" })).error.code, "FORBIDDEN");
  checks.push("项目共享记忆按真实 HTTP/MCP 权限读写");
  for (const [scope, markdown] of [["global", "跨项目本人私有"], ["project-agent", "项目本人原文"]]) {
    assert.equal((await worker.call("write_memory", { scope, expectedVersion: 0, clientMutationId: scope, markdown })).ok, true);
  }
  assert.equal((await other.call("read_memory", { scope: "global", targetAgentId: worker.joined.agentId })).error.code, "FORBIDDEN");
  const injection = await worker.call("wait_for_messages", { timeoutMs: 25 });
  assert.deepEqual(injection.memory.entries.map(item => item.scope), ["global", "project-agent"]);
  await http("GET", `${prefix}/global`, undefined, 404);
  checks.push("本人两层注入与跨 Agent/global HTTP 隔离");
  const scheduled = await worker.call("report_memory_session_end", { clientMutationId: "end-session" });
  assert.equal(scheduled.summaryScheduled, true, JSON.stringify(scheduled));
  assert.equal((await worker.call("report_memory_session_end", { clientMutationId: "end-session" })).requestId, scheduled.requestId);
  const notification = await worker.call("wait_for_messages", { timeoutMs: 100 });
  const event = notification.workEvents.find(item => item.payload.requestId === scheduled.requestId);
  assert.ok(event);
  assert.equal((await worker.call("acknowledge_work_event", { eventId: event.id })).ok, true);
  assert.equal((await http("GET", `${own}/summary-requests`)).requests[0].state, "pending");
  checks.push("明确 session-end 去重、持久工作事件及 ACK 不执行总结");
  let begun = (await worker.call("begin_memory_summary", { requestId: scheduled.requestId, expectedRevision: 1, clientMutationId: "begin-old" })).request;
  await http("PUT", own, { expectedVersion: 1, clientMutationId: "human-priority", markdown: "用户已经更正的事实" });
  const oldOutput = "旧模型上下文的协议夹具";
  const conflict = await worker.call("submit_memory_summary", { requestId: begun.id, expectedRequestRevision: begun.revision,
    attemptId: begun.attemptId, markdown: oldOutput, evidence: evidence(oldOutput, "old") });
  assert.equal(conflict.error.code, "CONFLICT");
  assert.equal((await http("GET", own)).document.markdown, "用户已经更正的事实");
  assert.equal((await http("GET", `${own}/summary-requests`)).requests.find(r => r.id === begun.id).state, "conflicted");
  checks.push("人工编辑优先，迟到总结持久冲突且不能覆盖");
  const retry = (await http("POST", `${prefix}/summary-requests/${begun.id}/retry`, { clientMutationId: "retry-fresh" })).request;
  assert.equal(retry.baseVersion, 2); assert.notEqual(retry.id, begun.id);
  const packet = await worker.call("read_memory_summary", { requestId: retry.id });
  assert.equal(packet.currentMemory.markdown, "用户已经更正的事实");
  assert.equal((await other.call("read_memory_summary", { requestId: retry.id })).error.code, "FORBIDDEN");
  begun = (await worker.call("begin_memory_summary", { requestId: retry.id, expectedRevision: 1, clientMutationId: "begin-fresh" })).request;
  const markdown = "用户已经更正的事实\n协议夹具补充，不代表真实模型结果。";
  const submit = { requestId: begun.id, expectedRequestRevision: begun.revision, attemptId: begun.attemptId, markdown, evidence: evidence(markdown, "fresh") };
  const completed = await worker.call("submit_memory_summary", submit);
  assert.equal(completed.ok, true, JSON.stringify(completed)); assert.equal(completed.document.version, 3);
  assert.equal((await worker.call("submit_memory_summary", submit)).duplicate, true);
  const finished = (await http("GET", `${own}/summary-requests`)).requests.find(r => r.id === retry.id);
  assert.equal(finished.state, "completed"); assert.equal(finished.evidence.provenance, "agent-declared");
  assert.equal((await http("GET", `${own}/versions/1`)).version.markdown, "项目本人原文");
  assert.equal((await http("GET", `${own}/versions`)).versions.length, 3);
  checks.push("新请求新基准、本人执行、原子版本/证据与幂等完成");
  for (let i = 0; i < 2; i++) {
    const sent = await other.call("send_message", { text: `触发来源 ${i}`, mentions: [worker.joined.memberId] });
    assert.equal(sent.ok, true, JSON.stringify(sent));
  }
  const messages = await worker.call("wait_for_messages", { timeoutMs: 100 });
  assert.equal(messages.messages.length, 2);
  for (const message of messages.messages) await worker.call("acknowledge_message", { messageId: message.id });
  const deadline = Date.now() + 3000;
  let threshold;
  while (!threshold && Date.now() < deadline) {
    threshold = (await http("GET", `${own}/summary-requests`)).requests.find(r => r.trigger === "message_threshold");
    if (!threshold) await delay(20);
  }
  assert.ok(threshold, "真实 MCP 投递后补扫应创建阈值总结请求");
  assert.deepEqual(threshold.messageIds.sort(), messages.messages.map(item => item.id).sort());
  checks.push("真实 MCP 投递触发 N 条消息总结，ACK 不丢来源");
  const applicationCommit = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim();
  const applicationTree = (await exec("git", ["rev-parse", "HEAD^{tree}"])).stdout.trim();
  const result = { status: "PASS", applicationCommit, applicationTree, driver: config.dbDriver, checks, realModelSummary: "NOT_RUN" };
  await mkdir(".agent-output/memory-e2e", { recursive: true });
  await writeFile(`.agent-output/memory-e2e/${config.dbDriver}.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  for (const { client, transport } of clients.reverse()) { await transport.terminateSession().catch(() => {}); await client.close(); }
  if (server) await server.close();
  await rm(dir, { recursive: true, force: true });
}

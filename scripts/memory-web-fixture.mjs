#!/usr/bin/env node
/** 临时 SQLite 浏览器夹具。所有总结内容为 synthetic UI 通道样本，不执行模型。 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createLogger } from "../src/server/logger.ts";
import { startServer } from "../src/server/server.ts";
import { createRepositories } from "../src/server/db/repositories.ts";
import { createOrgMutationService } from "../src/server/org/mutations.ts";
import { actorForMember, ownerActor } from "../src/server/authz/actors.ts";
import { createMemoryService } from "../src/server/memory/service.ts";
import { getMemoryRuntime } from "../src/server/memory/runtime.ts";

const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const projectKey = (projectId, agentId = null) => ({ scope: agentId ? "project-agent" : "project", projectId, agentId });

/** 独立导出数据准备，允许无浏览器、无监听端口地核对夹具自身的真实领域调用。 */
export async function seedMemoryBrowser(repos, service) {
  const records = [];
  const privateSentinel = "PRIVATE-GLOBAL-SENTINEL-NOT-FOR-OWNER";
  const oldMarkdown = "# 历史共识\n中文与 emoji 🙂\n<script>globalThis.memoryXss = 1</script>";
  for (const name of ["记忆与协作", "独立项目乙"]) {
    const project = await repos.projects.create({ name });
    const members = {};
    for (const [key, displayName] of [["primary", "林间"], ["second", "暮川"], ["disabled", "知遥"], ["removed", "此前的协作者"]]) {
      const agent = await repos.agents.create({ displayName: `${name} · ${displayName}`, hostType: "codex-cli" });
      members[key] = await repos.members.create({ projectId: project.id, agentId: agent.id, kind: "agent", displayName });
    }
    const group = await repos.groups.create({ projectId: project.id, name: "项目协作", participantMemberIds: Object.values(members).map((member) => member.id) });
    const owner = { actor: ownerActor(project.id) };
    const count = records.length === 0 ? 25 : 1;
    for (let version = 1; version <= count; version++) {
      const markdown = records.length > 0 ? "乙项目的独立记忆" : version === 2 ? oldMarkdown : `# 项目协作共识\n\n版本 ${version}：保持明确的目标、轻量的沟通和可以核对的结果。\n\n- 中文与 emoji 🙂\n- 长文本应自然换行：${"example".repeat(70)}`;
      await service.write(owner, projectKey(project.id), { expectedVersion: version - 1, clientMutationId: randomUUID(), markdown });
    }
    for (const member of Object.values(members)) {
      await service.write(owner, projectKey(project.id, member.agentId), { expectedVersion: 0, clientMutationId: randomUUID(), markdown: `${member.displayName}在本项目中保留的事实与协作约定。` });
    }
    records.push({ project, members, group });
  }
  const first = records[0];
  const own = (member) => ({ actor: actorForMember(member), connection: { projectId: member.projectId, memberId: member.id, groupId: first.group.id, membershipRevision: member.membershipRevision }, injectionBindingGeneration: `synthetic-ui-session-${member.id}` });
  const actor = own(first.members.primary);
  await service.write(actor, { scope: "global", projectId: null, agentId: first.members.primary.agentId }, { expectedVersion: 0, clientMutationId: randomUUID(), markdown: privateSentinel });
  async function schedule(access = actor) {
    const scheduled = await service.reportSessionEnd(access, randomUUID());
    assert.equal(scheduled.summaryScheduled, true, scheduled.errorCode);
    const request = await repos.memory.getRequest(scheduled.requestId);
    assert.ok(request); return request;
  }
  async function begin(request, access = actor) {
    return service.beginSummary(access, request.id, { expectedRevision: request.revision, clientMutationId: randomUUID() });
  }
  const completed = await begin(await schedule());
  const packet = await service.readSummaryPacket(actor, completed.id);
  const syntheticMarkdown = "林间保留的项目共识。此正文是浏览器通道的合成样本，不作为真实模型自总结证据。";
  const endedAt = new Date().toISOString();
  await service.submitSummary(actor, completed.id, { expectedRequestRevision: completed.revision, attemptId: completed.attemptId, markdown: syntheticMarkdown,
    evidence: { provenance: "agent-declared", host: "synthetic-ui", hostVersion: "1", invocationId: `fixture-${completed.id}`, contextId: `fixture-context-${completed.id}`,
      startedAt: completed.startedAt, completedAt: endedAt, promptSha256: hash(JSON.stringify(packet)), outputSha256: hash(syntheticMarkdown), evidenceRef: `fixture://memory-ui/${completed.id}` } });
  const failed = await begin(await schedule());
  await service.failSummary(actor, failed.id, { expectedRevision: failed.revision, attemptId: failed.attemptId, code: "synthetic_model_failed" });
  const conflicted = await schedule();
  const beforeManual = await service.read({ actor: ownerActor(first.project.id) }, projectKey(first.project.id, first.members.primary.agentId));
  await service.write({ actor: ownerActor(first.project.id) }, projectKey(first.project.id, first.members.primary.agentId), { expectedVersion: beforeManual.version, clientMutationId: randomUUID(), markdown: "人工确认的项目事实应优先保留。\n待处理与已接手的请求都不等于模型结果已保存。" });
  await assert.rejects(begin(conflicted));
  assert.equal((await repos.memory.getRequest(conflicted.id)).state, "conflicted");
  const running = await begin(await schedule());
  const cancelled = await schedule();
  // 取消展示样本直接 CAS；没有伪装成真实来源撤销，也没有声称通知已 ACK。
  await repos.memory.updateRequestCas(cancelled.id, cancelled.revision, { state: "cancelled", error: { code: "synthetic_cancelled", message: "浏览器取消状态样本；仅验证界面呈现。" }, finishedAt: new Date().toISOString() });
  const pending = await schedule();
  const disabledAccess = own(first.members.disabled);
  const disabledRequest = await begin(await schedule(disabledAccess), disabledAccess);
  await service.failSummary(disabledAccess, disabledRequest.id, { expectedRevision: disabledRequest.revision, attemptId: disabledRequest.attemptId, code: "synthetic_model_failed" });
  for (const record of records) {
    await repos.members.setStatus(record.members.disabled.id, "disabled");
    await createOrgMutationService({ repos }).removeMember({ actor: ownerActor(record.project.id) }, record.project.id, record.members.removed.id);
  }
  return {
    records, privateSentinel, oldMarkdown,
    requestIds: { pending: pending.id, running: running.id, completed: completed.id, failed: failed.id, conflicted: conflicted.id, cancelled: cancelled.id, disabled: disabledRequest.id },
    evidenceScope: "synthetic UI content / actual domain state transitions / no model invocation; cancelled sample is direct repository CAS with notification left unacked",
    async beginPendingAfterManualEdit() {
      await assert.rejects(begin(pending));
      const request = await repos.memory.getRequest(pending.id);
      assert.equal(request.state, "conflicted");
      return { requestId: request.id, state: request.state, revision: request.revision };
    },
  };
}

async function main() {
  const directory = await mkdtemp(path.join(tmpdir(), "boardroom-memory-web-"));
  let server;
  let closing;
  const close = (code = 0) => closing ??= (async () => {
    try { await server?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  })().then(() => process.exit(code), () => process.exit(1));
  process.on("SIGTERM", () => { void close(); });
  process.on("SIGINT", () => { void close(); });
  try {
    server = await startServer({ config: { port: 0, dbDriver: "sqlite", dataDir: directory, heartbeat: { intervalMs: 1000, timeoutMs: 10000 }, configFile: null },
      logger: createLogger({ write: () => {} }), webRoot: path.resolve(import.meta.dirname, "../dist/web") });
    const repos = createRepositories(server.database), runtime = getMemoryRuntime(server.database);
    const service = createMemoryService({ repos, config: runtime.config, injectionReader: runtime.reader, readVisibleMessages: async () => [] });
    const fixture = await seedMemoryBrowser(repos, service);
    process.stdout.write(`${JSON.stringify({ url: server.url, ...fixture })}\n`);
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of input) {
      const command = JSON.parse(line);
      if (command.action !== "begin-pending-after-manual-edit") throw new Error("unsupported_fixture_command");
      process.stdout.write(`${JSON.stringify({ commandId: command.id, result: await fixture.beginPendingAfterManualEdit() })}\n`);
    }
    await close();
  } catch (error) {
    process.stderr.write(`memory_web_fixture_failed: ${error instanceof Error ? error.stack : "unknown"}\n`);
    await close(1);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

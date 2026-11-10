import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import { startServer, type ServerAuthorization } from "../src/server/server.ts";
import { createLogger } from "../src/server/logger.ts";
import { createRepositories } from "../src/server/db/repositories.ts";
import { createRuntimeRepository } from "../src/server/runtime/repository.ts";
import type { RuntimeBindingView, RuntimeView } from "../src/server/runtime/types.ts";
import type { HostLaunchSnapshot } from "../src/server/runtime/hosts/types.ts";
import { ownerActor } from "../src/server/authz/actors.ts";
import { notifyMessageCommit } from "../src/server/runtime/dispatch-events.ts";

async function fixture(authorization?: ServerAuthorization) {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-runtime-api-"));
  const preflights: HostLaunchSnapshot[] = [];
  let launches = 0;
  const server = await startServer({
    config: { port: 0, dataDir: dir, heartbeat: { intervalMs: 10_000, timeoutMs: 30_000 }, configFile: null },
    logger: createLogger({ write() {} }),
    ...(authorization ? { authorization } : {}),
    runtimeLauncher: {
      async preflight(snapshot) {
        preflights.push(snapshot);
        return { supported: false, reason: "profile_unsupported", expectedPermissionMode: "auto", isolation: "unverified" };
      },
      async launch() { launches++; throw new Error("unverified_launcher_must_not_run"); },
    },
  });
  const repos = createRepositories(server.database);
  const project = await repos.projects.create({ name: "托管 API 验收" });
  const group = await repos.groups.create({ projectId: project.id, name: "研发" });
  const payload = { name: "受控助手", backend: "claude-code", defaults: { workdir: dir, model: "initial-model" },
    bindings: [{ projectId: project.id, groupId: group.id }] };
  async function request(url: string, method = "GET", value?: unknown, headers: Record<string, string> = {}) {
    return fetch(`${server.url}${url}`, { method, headers: { ...(value === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  }
  return { server, dir, project, group, repos, payload, request, preflights,
    launches: () => launches,
    async create() {
      const response = await request("/api/runtimes", "POST", payload);
      assert.equal(response.status, 201);
      return (await response.json() as { runtime: RuntimeView }).runtime;
    },
    async close() { await server.close(); await rm(dir, { force: true, recursive: true }); },
  };
}

test("R1/R5 HTTP创建不启动，字段严格校验，配置CAS与启动意图分离", async () => {
  const f = await fixture();
  try {
    const view = await f.create();
    const binding = view.bindings[0]!;
    assert.equal(binding.binding.desiredState, "stopped");
    assert.equal(binding.runner.applied, null);
    assert.equal(f.preflights.length, 0);
    assert.equal((await f.repos.mcpSessions.listByProject(f.project.id)).length, 0);
    const invalid = await f.request("/api/runtimes", "POST", { ...f.payload, name: "非法参数", argv: ["--unsafe"] });
    assert.equal(invalid.status, 400);
    assert.doesNotMatch(await invalid.text(), /--unsafe/);
    const url = `/api/runtimes/${view.runtime.id}`;
    assert.equal((await f.request(url, "PUT", { expectedRevision: 1, defaults: { workdir: f.dir, model: "second-model" } })).status, 200);
    assert.equal((await f.request(url, "PUT", { expectedRevision: 1, defaults: { workdir: f.dir, model: "lost-update" } })).status, 409);
    const actions = `/api/runtime-bindings/${binding.binding.id}/actions`;
    assert.equal((await f.request(actions, "POST", { action: "start", expectedIntentRevision: 0 })).status, 400);
    assert.equal((await f.request(actions, "POST", { action: "start", expectedIntentRevision: 0, runtimeRevision: 1, bindingRevision: 1 })).status, 409);
    const start = await f.request(actions, "POST", { action: "start", expectedIntentRevision: 0, runtimeRevision: 2, bindingRevision: 1 });
    assert.equal(start.status, 200);
    await f.server.runtimeSupervisor.tick();
    assert.ok(f.preflights.length > 0);
    assert.equal(f.preflights[0]!.generation, 1);
    assert.equal(f.preflights[0]!.config.model, "second-model");
    assert.equal(f.launches(), 0);
    const runningIntent = await f.request(`/api/runtime-bindings/${binding.binding.id}`);
    const body = await runningIntent.json() as { binding: RuntimeBindingView & { status: { summary: string; reason: string } } };
    assert.equal(body.binding.binding.desiredState, "running");
    assert.equal(body.binding.runner.state, "stopped");
    assert.equal(body.binding.status.reason, "profile_unsupported");
    assert.notEqual(body.binding.status.summary, "running");
    assert.equal((await f.request(actions, "POST", { action: "stop", expectedIntentRevision: body.binding.binding.intentRevision })).status, 200);
    assert.equal((await f.request(url, "DELETE")).status, 204);
    assert.equal((await f.request(url)).status, 404);
  } finally { await f.close(); }
});

test("R1/R4 公共状态隐藏harness session，保存不改applied；观测端点无原始输出", async () => {
  const f = await fixture();
  try {
    const view = await f.create(); const id = view.bindings[0]!.binding.id;
    const repo = createRuntimeRepository(f.server.database);
    await repo.intent(id, "start", 0, { runtimeRevision: 1, bindingRevision: 1 });
    const fence = await repo.claim(id, "api-fixture-owner");
    await repo.setSession(fence, "private-session-should-not-appear");
    await repo.markExit(fence, { exitCode: 0 });
    const response = await f.request(`/api/runtimes/${view.runtime.id}`, "PUT", { expectedRevision: 1, defaults: { workdir: f.dir, model: "pending-model" } });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.doesNotMatch(text, /private-session-should-not-appear|harnessSessionId/);
    const result = JSON.parse(text) as { runtime: RuntimeView };
    assert.equal(result.runtime.bindings[0]!.pendingChanges, true);
    assert.equal(result.runtime.bindings[0]!.runner.applied?.config.model, "initial-model");
    const observations = await f.request(`/api/runtime-bindings/${id}/observations`);
    assert.equal(observations.status, 200);
    const data = await observations.json() as { events: { events: unknown[] }; usage: unknown[]; health: { incomplete: boolean } };
    assert.ok(Array.isArray(data.events.events)); assert.deepEqual(data.usage, []);
    assert.equal(typeof data.health.incomplete, "boolean");
    assert.doesNotMatch(JSON.stringify(data), /private-session-should-not-appear|initial-model|pending-model/);
    await repo.intent(id, "stop");
  } finally { await f.close(); }
});

test("R1/R3 管理API拒绝跨站、非JSON和任意agent主体（即使声明owner）", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request("/api/runtimes", "POST", f.payload, { origin: "https://untrusted.example" })).status, 403);
    assert.equal((await f.request("/api/runtimes", "POST", f.payload, { "content-type": "text/plain" })).status, 400);
    const untrustedHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(`${f.server.url}/api/runtimes`, { headers: { host: "untrusted.example" } }, response => {
        response.resume(); response.on("end", () => resolve(response.statusCode));
      });
      req.on("error", reject); req.end();
    });
    assert.equal(untrustedHost, 403);
    assert.deepEqual(await (await f.request("/api/runtimes")).json(), { runtimes: [] });
  } finally { await f.close(); }
  const agent = await fixture({ resolveHttpActor: async () => ({ ...ownerActor(), actorId: "fake-agent-owner", kind: "agent" }) });
  try {
    assert.equal((await agent.request("/api/runtimes")).status, 403);
    assert.equal((await agent.request("/api/runtimes", "POST", agent.payload)).status, 403);
    assert.equal((await createRuntimeRepository(agent.server.database).list()).length, 0);
  } finally { await agent.close(); }
});

test("R4 提交后观测使用持久wake判定，包含抑制原因且不保存消息正文", async () => {
  const f = await fixture();
  try {
    const view = await f.create(); const binding = view.bindings[0]!.binding;
    const human = await f.repos.members.create({ projectId: f.project.id, kind: "human", displayName: "消息观察者" });
    await f.repos.groups.addParticipant(f.group.id, human.id);
    for (const decision of ["allowed", "suppressed", null] as const) {
      const message = await f.repos.messages.create({ groupId: f.group.id, senderMemberId: human.id,
        body: "MESSAGE_BODY_MUST_NOT_APPEAR", mentions: [binding.memberId] });
      await f.repos.deliveries.ensure(message.id, binding.memberId, decision === null ? undefined
        : decision === "allowed" ? { decision } : { decision, reason: "rate_limited" });
      await notifyMessageCommit(f.server.database, message.id);
      if (decision === "allowed") await f.repos.deliveries.recordAttempt(message.id, binding.memberId, "delivered");
      if (decision === null) await f.repos.deliveries.recordAttempt(message.id, binding.memberId, "acked");
    }
    const response = await f.request(`/api/runtime-bindings/${binding.id}/observations`);
    const text = await response.text(); assert.doesNotMatch(text, /MESSAGE_BODY_MUST_NOT_APPEAR/);
    const { events } = JSON.parse(text) as { events: { events: { event: string; reasonCode?: string }[] } };
    assert.equal(events.events.filter(event => event.event === "wake.allowed").length, 1);
    assert.equal(events.events.filter(event => event.event === "wake.suppressed" && event.reasonCode === "rate_limited").length, 1);
    const status = (await (await f.request(`/api/runtime-bindings/${binding.id}`)).json() as {
      binding: { status: { deliveryCounts: { pending: number; delivered: number; acked: number }; queuedCount: number } };
    }).binding.status;
    assert.deepEqual(status.deliveryCounts, { pending: 1, delivered: 1, acked: 1 });
    assert.equal(status.queuedCount, 1); // 已投递但未ACK仍在允许队列，不伪称尚未投递。
  } finally { await f.close(); }
});

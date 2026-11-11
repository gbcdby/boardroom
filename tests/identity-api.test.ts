import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createT1ApiRouter } from "../src/server/api.ts";
import { createLogger } from "../src/server/logger.ts";
import { ownerActor } from "../src/server/authz/actors.ts";
import { createRuntimeRepository } from "../src/server/runtime/repository.ts";
import { identityFixture } from "./helpers/identity-fixture.ts";

async function fixture() {
  const f = await identityFixture();
  const router = createT1ApiRouter({ db: f.db, repos: f.repos, logger: createLogger({ write() {} }), resolveActor: async ({ request }) =>
    request.headers["x-test-actor"] === "agent" ? { ...ownerActor(), kind: "agent" }
      : request.headers["x-test-actor"] === "project-human" ? ownerActor("some-project") : ownerActor() });
  const server = createServer(async (req, res) => {
    try { if (!await router.handle(req, res, new URL(req.url!, "http://localhost").pathname)) { res.writeHead(404); res.end(); } }
    catch { res.writeHead(500); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  return { ...f, async request(url: string, method = "GET", value?: unknown, headers: Record<string, string> = {}) {
    return fetch(`${origin}${url}`, { method, headers: { ...headers, ...(value === undefined ? {} : { "content-type": "application/json" }) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  }, async close() { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await f.close(); } };
}

test("HTTP 全局角色 catalog、稳定身份与 user 审计只对可信本地用户开放", async () => {
  const f = await fixture();
  try {
    const fields = { name: "负责人", purpose: "职责名称不授予权限", instructions: "核对证据", recommendedSkillRefs: [] };
    const response = await f.request("/api/roles", "POST", fields);
    assert.equal(response.status, 201);
    const { role } = await response.json() as { role: { roleTemplateId: string; revision: number } };
    assert.equal(role.revision, 1);
    assert.equal((await f.request(`/api/roles/${role.roleTemplateId}`, "PUT", { ...fields, name: "实施者", expectedRevision: 1 })).status, 200);
    assert.equal((await f.request(`/api/roles/${role.roleTemplateId}`, "PUT", { ...fields, name: "过期编辑", expectedRevision: 1 })).status, 409);
    const copy = await f.request(`/api/roles/${role.roleTemplateId}/copy`, "POST", { name: "副本", expectedRevision: 2 });
    assert.equal(copy.status, 201);
    const impact = await (await f.request(`/api/roles/${role.roleTemplateId}/delete-impact`)).json() as { impact: { deletable: boolean } };
    assert.equal(impact.impact.deletable, false);
    assert.equal((await f.request(`/api/roles/${role.roleTemplateId}`, "DELETE", { expectedRevision: 2 })).status, 409);
    assert.equal((await f.request(`/api/roles/${role.roleTemplateId}/archive`, "POST", { expectedRevision: 2 })).status, 200);
    const audit = await (await f.request("/api/user/audit")).json() as { entries: Array<{ scope: string; projectId: null; targetKind: string }> };
    assert.equal(audit.entries.length, 4); assert.ok(audit.entries.every(entry => entry.scope === "user" && entry.projectId === null));
    assert.equal((await f.repos.projects.list()).length, 0);
    for (const headers of [{ "x-test-actor": "agent" }, { "x-test-actor": "project-human" }, { origin: "http://untrusted.invalid" }]) {
      assert.equal((await f.request("/api/roles", "POST", fields, headers)).status, 403);
      assert.equal((await f.request("/api/user/audit", "GET", undefined, headers)).status, 403);
    }
    assert.equal((await f.request("/api/roles", "POST", { ...fields, capabilities: ["runtime:manage"] })).status, 400);
    assert.equal((await f.request("/api/agents", "POST", { displayName: "不能新建可启动配置" })).status, 405);
    const unused = await (await f.request("/api/roles", "POST", { ...fields, name: "未使用角色" })).json() as { role: { roleTemplateId: string } };
    const deleteUrl = `/api/roles/${unused.role.roleTemplateId}`;
    const firstDelete = await f.request(deleteUrl, "DELETE", { expectedRevision: 1 });
    assert.equal(firstDelete.status, 409);
    const confirmation = await firstDelete.json() as { error: { code: string }; confirmation: { token: string } };
    assert.equal(confirmation.error.code, "confirmation_required");
    assert.equal((await f.request(deleteUrl)).status, 200);
    assert.equal((await f.request(deleteUrl, "DELETE", { expectedRevision: 1, confirm: confirmation.confirmation.token })).status, 204);
    assert.equal((await f.request(deleteUrl)).status, 404);
  } finally { await f.close(); }
});

test("HTTP legacy Profile/Binding/快照来源只读，所有写请求明确指回旧配置入口", async () => {
  const f = await fixture();
  try {
    const p = await f.repos.projects.create({ name: "原项目" }), g = await f.repos.groups.create({ projectId: p.id, name: "原群" });
    const runtimes = createRuntimeRepository(f.db, { repos: f.repos });
    const runtime = await runtimes.create({ name: "旧 runtime 名", backend: "claude-code", defaults: { workdir: f.dir, model: "current" }, bindings: [{ projectId: p.id, groupId: g.id }] });
    const agentId = runtime.runtime.agentId, bindingId = runtime.bindings[0]!.binding.id;
    await runtimes.intent(bindingId, "start");
    const tables = ["agent_runtimes", "agent_runtime_bindings", "agent_runner_states"];
    const before = await Promise.all(tables.map(table => f.db.query(`SELECT * FROM ${table} ORDER BY 1`)));
    const renamed = await f.request(`/api/agents/${agentId}`, "PATCH", { expectedDisplayName: "旧 runtime 名", displayName: "目录新名" });
    assert.equal(renamed.status, 200);
    const agent = await renamed.json() as { agent: { id: string; displayName: string }; aliases: unknown[] };
    assert.equal(agent.agent.id, agentId); assert.equal(agent.agent.displayName, "目录新名"); assert.equal(agent.aliases.length, 2);
    assert.equal((await f.request(`/api/agents/${agentId}/aliases`, "POST", { displayName: "旧兼容别名", hostType: "claude-code" })).status, 201);
    const profileUrl = `/api/agents/${agentId}/profile`;
    const profile = await (await f.request(profileUrl)).json() as { profile: { authority: string; writable: boolean; source: { runtimeId: string } } };
    assert.equal(profile.profile.authority, "legacy"); assert.equal(profile.profile.writable, false); assert.equal(profile.profile.source.runtimeId, runtime.runtime.id);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const denied = await f.request(profileUrl, method, { model: "cannot-write" });
      assert.equal(denied.status, 409);
      const payload = await denied.json() as { error: { code: string }; writeEndpoint: string };
      assert.equal(payload.error.code, "legacy_config_read_only"); assert.equal(payload.writeEndpoint, `/api/runtimes/${runtime.runtime.id}`);
    }
    const inspected = await f.request("/api/legacy-config/preflight"); assert.equal(inspected.status, 200);
    const selected = await (await f.request(`/api/legacy-config/bindings/${bindingId}/config-snapshot`)).json() as { selection: { activationAllowed: boolean; configSnapshotRef: { kind: string } } };
    assert.equal(selected.selection.configSnapshotRef.kind, "requestedSnapshot"); assert.equal(selected.selection.activationAllowed, false);
    assert.equal((await f.request(`/api/legacy-config/bindings/${bindingId}`, "PUT", { overrides: { model: "cannot-write" } })).status, 409);
    assert.deepEqual(await Promise.all(tables.map(table => f.db.query(`SELECT * FROM ${table} ORDER BY 1`))), before);
  } finally { await f.close(); }
});

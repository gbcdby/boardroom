import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createT1ApiRouter } from "../src/server/api.ts";
import { createLogger } from "../src/server/logger.ts";
import { ownerActor } from "../src/server/authz/actors.ts";
import { initializePolicyConfiguration } from "../src/server/policy/configuration.ts";
import { BUSINESS_TABLES } from "../src/server/db/migrate-data.ts";
import { identityEngines, identityFixture, identitySkip } from "./helpers/identity-fixture.ts";
import type { EffectivePolicyConfiguration, PersistedPolicyDocument, PolicyConfigurationPreview,
  PolicyCombinationConflict, PolicyDocumentRef, PolicyVersionMetadata } from "../src/shared/policy.ts";

/** 测试按端点断言对应字段，生产 DTO 不把不同端点的响应合成一种对象。 */
async function read(response: Response | Promise<Response>) {
  return await (await response).json() as { policy: PersistedPolicyDocument; effective: EffectivePolicyConfiguration;
    preview: PolicyConfigurationPreview; current: PolicyDocumentRef; versions: PolicyVersionMetadata[];
    error: { reason: string; current: PolicyDocumentRef; conflicts: PolicyCombinationConflict[] } };
}

async function fixture(engine: typeof identityEngines[number]) {
  const f = await identityFixture(engine);
  const router = createT1ApiRouter({ db: f.db, repos: f.repos, logger: createLogger({ write() {} }), resolveActor: async ({ request }) =>
    request.headers["x-test-actor"] === "agent" ? { ...ownerActor(), kind: "agent" }
      : request.headers["x-test-project"] ? ownerActor(String(request.headers["x-test-project"])) : ownerActor() });
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
  }, async snapshot() {
    const tables = [...new Set([...BUSINESS_TABLES.map(table => table.name), "policy_documents", "policy_document_versions"])];
    return Promise.all(tables.map(table => f.db.query(`SELECT * FROM ${table} ORDER BY 1`)));
  }, async close() { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await f.close(); } };
}

for (const engine of identityEngines) {
  test(`${engine} S1 HTTP：GET不初始化、可信用户保存、CAS/来源/历史与结构化组合冲突`, { skip: identitySkip(engine) }, async () => {
    const f = await fixture(engine);
    try {
      const missing = await f.request("/api/policies/global");
      assert.equal(missing.status, 409);
      assert.equal((await read(missing)).error.reason, "policy_not_initialized");
      assert.equal((await f.db.query("SELECT * FROM policy_documents")).length, 0);
      assert.equal((await f.db.query("SELECT * FROM audit_log")).length, 0);
      const project = await f.repos.projects.create({ name: "HTTP项目" });
      const url = `/api/projects/${project.id}/policy`;
      for (const path of [url, `${url}/versions`, `${url}/effective`]) assert.equal((await f.request(path)).status, 409);
      const original = await initializePolicyConfiguration(f.repos);
      assert.deepEqual((await read(f.request("/api/policies/global"))).policy, original);
      assert.equal((await read(f.request(url))).policy, null);
      const inherited = await read(f.request(`${url}/effective`));
      assert.equal(inherited.effective.globalRevision, 1); assert.equal(inherited.effective.projectRevision, null);
      const rule = original.document.rules.find(item => item.ruleId === "default.task.assign")!;
      const override = { ruleId: rule.ruleId, when: rule.when, outcome: "human", reason: "用户保留分派", requiresFreshHuman: true };
      const save = { expectedRevision: null, expectedGlobalRevision: 1, rules: [], overrides: [override] };
      assert.equal((await f.request(url, "PUT", save)).status, 200);
      const effective = (await read(f.request(`${url}/effective`))).effective;
      assert.equal(effective.rules.find(item => item.rule.ruleId === rule.ruleId)!.source.scope, "project-override");
      const conflict = await f.request(url, "PUT", save);
      assert.equal(conflict.status, 409); assert.equal((await read(conflict)).error.current.revision, 1);
      const history = await read(f.request(`${url}/versions?limit=1`));
      assert.equal(history.current.revision, 1); assert.equal(history.versions.length, 1);
      assert.equal((await read(f.request(`${url}/versions/1`))).policy.document.revision, 1);
      assert.equal((await f.request(`${url}/versions/99`)).status, 404);
      assert.equal((await f.request(`${url}/versions?limit=0`)).status, 400);
      await f.repos.projects.archive(project.id);
      const before = await f.snapshot();
      const globalConflict = await f.request("/api/policies/global", "PUT", { expectedRevision: 1,
        rules: original.document.rules.map(item => item.ruleId === rule.ruleId ? { ...item, locked: true, overridable: false } : item) });
      assert.equal(globalConflict.status, 409);
      const rejected = (await read(globalConflict)).error;
      assert.equal(rejected.reason, "policy_project_conflict"); assert.equal(rejected.conflicts[0]!.projectId, project.id);
      assert.equal(rejected.conflicts[0]!.repairEndpoint, url);
      assert.equal((await f.request(url, "PUT", { ...save, expectedRevision: 1 })).status, 409);
      assert.deepEqual(await f.snapshot(), before);
      await f.repos.projects.restore(project.id);
      assert.equal((await f.request(url, "PUT", { ...save, expectedRevision: 1, overrides: [] })).status, 200);
      assert.equal((await f.request("/api/policies/global", "PUT", { expectedRevision: 1, rules: [] })).status, 200);
      const stale = await f.request(url, "PUT", { ...save, expectedRevision: 2, overrides: [] });
      assert.equal(stale.status, 409); assert.equal((await read(stale)).error.reason, "policy_global_revision_conflict");
      assert.equal((await read(f.request("/api/policies/global/versions/1"))).policy.ref.contentDigest, original.ref.contentDigest);
    } finally { await f.close(); }
  });

  test(`${engine} S1 HTTP：草稿/动作预览零写入，不接受客户端事实或把无handler显示为可执行`, { skip: identitySkip(engine) }, async () => {
    const f = await fixture(engine);
    try {
      const original = await initializePolicyConfiguration(f.repos);
      const project = await f.repos.projects.create({ name: "预览" });
      const url = `/api/projects/${project.id}/policy/preview`, before = await f.snapshot();
      const action = { schemaVersion: 1, kind: "task.execute", projectId: project.id,
        subjectRef: { kind: "task", id: "task-not-resolved" }, expectedSubjectRevisions: [{ subjectRef: { kind: "task", id: "task-not-resolved" }, revision: 1 }],
        candidateDigest: null, payload: { operation: "implement" } };
      const preview = await f.request(url, "POST", { action, stage: "execution" });
      assert.equal(preview.status, 200);
      const value = (await read(preview)).preview;
      assert.equal(value.mode, "observation"); assert.equal(value.executionAdmission, "not-issued"); assert.equal(value.sideEffects, "none");
      assert.equal(value.source, "current"); assert.equal(value.action!.availability, "unavailable");
      assert.equal(value.action!.preview.evaluation.outcome, "deny");
      assert.equal(value.action!.preview.evaluation.reasons[0]!.code, "handler_unavailable");
      const draft = await f.request("/api/policies/global/preview", "POST", { draft: { rules: [] } });
      assert.equal(draft.status, 200);
      const candidate = (await read(draft)).preview;
      assert.equal(candidate.source, "draft"); assert.equal(candidate.base.global.contentDigest, original.ref.contentDigest);
      assert.deepEqual(candidate.candidate.rules, []); assert.equal(candidate.action, null);
      assert.equal((await f.request(url, "POST", { draft: { rules: [], overrides: [] } })).status, 200);
      for (const forged of [{ facts: { authorization: { existingAuthorization: true } } }, { context: {} },
        { registry: { handlers: [{ available: true }] } }, { policyRevision: "client-authority" }, { actor: { kind: "human" } }]) {
        assert.equal((await f.request(url, "POST", { action, stage: "execution", ...forged })).status, 400);
      }
      assert.equal((await f.request(url, "POST", { action })).status, 400);
      assert.equal((await f.request(url, "POST", { stage: "execution" })).status, 400);
      assert.equal((await f.request(url, "POST", { action: { ...action, projectId: "another" }, stage: "proposal" })).status, 400);
      assert.equal((await f.request(url, "POST", { draft: { rules: [], overrides: [], revision: 99 } })).status, 400);
      assert.deepEqual(await f.snapshot(), before);
    } finally { await f.close(); }
  });

  test(`${engine} S1 HTTP：真实身份与同源守卫覆盖读取/历史/预览/保存，拒绝伪造范围和字段`, { skip: identitySkip(engine) }, async () => {
    const f = await fixture(engine);
    try {
      await initializePolicyConfiguration(f.repos);
      const project = await f.repos.projects.create({ name: "授权边界" }), url = `/api/projects/${project.id}/policy`;
      const before = await f.snapshot();
      for (const headers of [{ "x-test-actor": "agent" }, { "x-test-project": "another-project" }, { origin: "http://untrusted.invalid" }]) {
        for (const path of ["/api/policies/global", "/api/policies/global/versions/1", "/api/policies/global/effective", url, `${url}/versions/1`]) {
          assert.equal((await f.request(path, "GET", undefined, headers)).status, 403);
        }
        assert.equal((await f.request(url, "PUT", { expectedRevision: null, expectedGlobalRevision: 1, rules: [], overrides: [] }, headers)).status, 403);
        assert.equal((await f.request(`${url}/preview`, "POST", {}, headers)).status, 403);
      }
      for (const extra of [{ projectId: "fake" }, { scope: "user" }, { script: "return true" }, { expectedGlobalRevision: 1 }]) {
        assert.equal((await f.request("/api/policies/global", "PUT", { expectedRevision: 1, rules: [], ...extra })).status, 400);
      }
      assert.equal((await f.request("/api/projects/missing/policy")).status, 404);
      assert.equal((await f.request("/api/policies/global", "DELETE")).status, 405);
      assert.equal((await f.request("/api/policies/global/versions?unknown=1")).status, 400);
      assert.deepEqual(await f.snapshot(), before);
    } finally { await f.close(); }
  });

  test(`${engine} S1 HTTP purge：策略计数进入二次确认，保存后旧凭据失效，重新确认只清项目策略`, { skip: identitySkip(engine) }, async () => {
    const f = await fixture(engine);
    try {
      const initial = await initializePolicyConfiguration(f.repos);
      const project = await f.repos.projects.create({ name: "HTTP删除" }), target = `/api/projects/${project.id}`, url = `${target}/policy`;
      const save = { expectedRevision: null, expectedGlobalRevision: 1, rules: [], overrides: [] };
      assert.equal((await f.request(url, "PUT", save)).status, 200);
      const beforeResponse = await f.request(target, "DELETE"); assert.equal(beforeResponse.status, 409);
      const before = await beforeResponse.json() as { confirmation: { token: string; cascade: { policyDocuments: number; policyVersions: number } } };
      assert.equal(before.confirmation.cascade.policyDocuments, 1); assert.equal(before.confirmation.cascade.policyVersions, 1);
      assert.equal((await f.request(url, "PUT", { ...save, expectedRevision: 1 })).status, 200);
      const stale = await f.request(target, "DELETE", { confirm: before.confirmation.token });
      assert.equal(stale.status, 409); assert.equal((await stale.json() as { error: { code: string } }).error.code, "confirmation_changed");
      assert.equal((await read(f.request(url))).policy.document.revision, 2);
      const again = await (await f.request(target, "DELETE")).json() as { confirmation: { token: string; cascade: { policyVersions: number } } };
      assert.equal(again.confirmation.cascade.policyVersions, 2);
      assert.equal((await f.request(target, "DELETE", { confirm: again.confirmation.token })).status, 204);
      assert.equal((await f.request(url)).status, 404);
      assert.deepEqual((await read(f.request("/api/policies/global"))).policy, initial);
      assert.equal((await f.db.query("SELECT * FROM policy_document_versions")).length, 1);
    } finally { await f.close(); }
  });
}

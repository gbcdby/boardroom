import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rename, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createT1ApiRouter } from "../src/server/api.ts";
import { createLogger } from "../src/server/logger.ts";
import { ownerActor } from "../src/server/authz/actors.ts";
import { resolveBoardroomEnvironment } from "../src/server/environment.ts";
import { createRuntimeRepository } from "../src/server/runtime/repository.ts";
import { identityFixture, identityEngines, identitySkip } from "./helpers/identity-fixture.ts";

async function fixture(engine: typeof identityEngines[number]) {
  const f = await identityFixture(engine, 15);
  const sourceBase = await mkdtemp(path.join(tmpdir(), "boardroom-workspace-http-"));
  const root = path.join(await realpath(sourceBase), "source"); await mkdir(root);
  const environment = await resolveBoardroomEnvironment({ cwd: f.dir, env: { BOARDROOM_HOME: path.join(f.dir, "home"), AGENT_STUDIO_DATA_DIR: f.dir } });
  const router = createT1ApiRouter({ db: f.db, repos: f.repos, environment, logger: createLogger({ write() {} }),
    resolveActor: async ({ request, projectId }) => request.headers["x-test-actor"] === "agent"
      ? { ...ownerActor(projectId), kind: "agent", role: "top_manager", actorId: "untrusted-agent" }
      : request.headers["x-test-actor"] === "foreign" ? ownerActor("foreign-project") : ownerActor() });
  const server = createServer(async (req, res) => {
    try { if (!await router.handle(req, res, new URL(req.url!, "http://localhost").pathname)) { res.writeHead(404); res.end(); } }
    catch (error) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return { ...f, root, environment, async request(url: string, method = "GET", value?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`http://127.0.0.1:${address.port}${url}`, { method,
      headers: { ...headers, ...(value === undefined ? {} : { "content-type": "application/json" }) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  }, async close() { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await f.close(); await rm(sourceBase, { recursive: true, force: true }); } };
}

for (const engine of identityEngines) {
  test(`${engine} S3 HTTP 原子目录创建、字段错误、真实版本/CAS/旧引用与解绑；非同源和越权拒绝`, { skip: identitySkip(engine) }, async () => {
    const f = await fixture(engine);
    try {
      const invalid = await f.request("/api/projects", "POST", { name: "不可半创建", workspace: { rootPath: "relative", mutationId: "invalid" } });
      assert.equal(invalid.status, 400); assert.equal(invalid.body.error.fieldErrors.rootPath.code, "path_not_absolute");
      assert.equal((await f.request("/api/projects")).body.projects.length, 0);
      for (const workspace of [null, { rootPath: f.root, mutationId: "bad-field", unsupported: true }]) {
        assert.equal((await f.request("/api/projects", "POST", { name: "字段错误", workspace })).status, 400);
      }
      const created = await f.request("/api/projects", "POST", { name: "配置项目", workspace: { rootPath: f.root, mutationId: "create" } });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const id = created.body.project.id, endpoint = `/api/projects/${id}/workspace`;
      assert.equal(created.body.project.projectRevision, 2); assert.equal(created.body.project.workspaceRevision, 1);
      assert.equal(created.body.workspace.rootPath, f.root); assert.equal(created.body.workspace.mode, "isolated");
      const current = await f.request(endpoint); assert.equal(current.status, 200); assert.equal(current.body.workspaceRevision, 1);
      const request = { rootPath: null, mode: "serialized", expectedProjectRevision: 2, mutationId: "save" };
      assert.equal((await f.request(endpoint, "PUT", request, { "x-test-actor": "agent" })).status, 403);
      assert.equal((await f.request(endpoint, "PUT", request, { "x-test-actor": "foreign" })).status, 403);
      assert.equal((await f.request(endpoint, "PUT", request, { origin: "https://unrelated.invalid" })).status, 403);
      const saved = await f.request(endpoint, "PUT", request); assert.equal(saved.status, 200); assert.equal(saved.body.workspace.rootPath, null);
      assert.equal(saved.body.workspaceRevision, 2); assert.equal(saved.body.projectRevision, 3);
      const stale = await f.request(endpoint, "PUT", { ...request, mutationId: "stale" });
      assert.equal(stale.status, 409); assert.equal(stale.body.error.reason, "workspace_revision_conflict");
      assert.equal((await f.request(`${endpoint}/versions/1`)).body.workspace.rootPath, f.root);
      assert.equal((await f.request(`${endpoint}/versions/999`)).status, 404);
      assert.equal((await f.request(endpoint)).body.workspaceRevision, 2);
      await f.repos.projects.archive(id);
      assert.equal((await f.request(endpoint, "DELETE", { expectedProjectRevision: 4, mutationId: "archived" })).status, 409);
      await f.repos.projects.restore(id);
      const cleared = await f.request(endpoint, "DELETE", { expectedProjectRevision: 5, mutationId: "clear" });
      assert.equal(cleared.status, 200); assert.equal(cleared.body.workspace.rootPath, null);
    } finally { await f.close(); }
  });

  test(`${engine} S3 HTTP 预检/根替换/旧目录映射均为可消费只读结果，purge 清单纳入工作区版本`, { skip: identitySkip(engine) }, async () => {
    const f = await fixture(engine);
    try {
      const preflight = await f.request("/api/workspaces/preflight", "POST", { rootPath: f.root });
      assert.equal(preflight.status, 200); assert.equal(preflight.body.preflight.runReady, false);
      assert.equal((await f.request("/api/workspaces/preflight", "POST", { rootPath: f.environment.stateRoot })).status, 400);
      const created = await f.request("/api/projects", "POST", { name: "来源", workspace: { rootPath: f.root, mutationId: "initial" } });
      const id = created.body.project.id, endpoint = `/api/projects/${id}/workspace`;
      const group = await f.repos.groups.create({ projectId: id, name: "绑定" });
      const runtimes = createRuntimeRepository(f.db, { repos: f.repos });
      const runtime = await runtimes.create({ name: "原配置", backend: "claude-code", defaults: { workdir: f.root }, bindings: [{ projectId: id, groupId: group.id }] });
      const mapping = await f.request(`${endpoint}/legacy-mapping?bindingId=${runtime.bindings[0]!.binding.id}`);
      assert.equal(mapping.status, 200); assert.equal(mapping.body.status, "suggestion"); assert.equal(mapping.body.activationAllowed, false);
      assert.equal((await f.request(`${endpoint}/legacy-mapping?bindingId=not-in-project`)).status, 400);
      assert.equal((await f.request(`${endpoint}/legacy-mapping`, "GET", undefined, { "x-test-actor": "agent" })).status, 403);
      const unchanged = await f.request(`${endpoint}/revalidate`, "POST", { workspaceRevision: 1 });
      assert.equal(unchanged.status, 200); assert.equal(unchanged.body.runReady, false);
      await rename(f.root, `${f.root}-original`); await mkdir(f.root);
      const replaced = await f.request(`${endpoint}/revalidate`, "POST", { workspaceRevision: 1 });
      assert.equal(replaced.status, 409); assert.equal(replaced.body.error.code, "workspace_changed");
      const purge = await f.request(`/api/projects/${id}`, "DELETE");
      assert.equal(purge.status, 409); assert.equal(purge.body.confirmation.cascade.workspaceVersions, 1);
    } finally { await f.close(); }
  });
}

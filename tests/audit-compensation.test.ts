import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories, type RepositorySet } from "../src/server/db/repositories.ts";
import { createT1ApiRouter } from "../src/server/api.ts";
import { createLogger } from "../src/server/logger.ts";
import { appendAuditEntry, createAuditRecorder } from "../src/server/audit.ts";

// 不开监听端口：真实路由、请求体解析、守卫、SQLite 仓储和补偿事务，仅替换 HTTP 传输。
type Call = (method: string, url: string, body?: unknown) => Promise<{ status: number; body: any }>;
async function withRouter(run: (repos: RepositorySet, call: Call, driver: SqliteDriver) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "boardroom-audit-compensation-"));
  const driver = new SqliteDriver({ dataDir: directory });
  try {
    await driver.connect();
    await driver.migrate(migrations);
    const repos = createRepositories(driver);
    const router = createT1ApiRouter({ db: driver, logger: createLogger({ level: "error", write: () => {} }), orgChangeRecorder: createAuditRecorder(repos.audit) });
    const call: Call = async (method, url, body) => {
      const request = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, url, headers: {} }) as IncomingMessage;
      let status = 200;
      let payload = "";
      const response = { setHeader() {}, writeHead(code: number) { status = code; }, end(value?: string) { payload = value ?? ""; } } as unknown as ServerResponse;
      assert.equal(await router.handle(request, response, url), true);
      return { status, body: payload ? JSON.parse(payload) : null };
    };
    await run(repos, call, driver);
  } finally { await driver.close(); await rm(directory, { recursive: true, force: true }); }
}

test("岗位改名可撤销与重做，补偿快照只序列化一次并读回真实岗位", async () => {
  await withRouter(async (repos, call) => {
    const project = await repos.projects.create({ name: "审计修复" });
    const node = await repos.org.createNode({ projectId: project.id, name: "项目统筹", role: "top_manager" });
    assert.equal((await call("PUT", `/api/org/nodes/${node.id}`, { name: "新的统筹" })).status, 200);
    const original = (await repos.audit.list(project.id, { action: "org.node_update" }))[0]!;
    assert.ok(original);
    const undo = await call("POST", `/api/projects/${project.id}/audit/${original.id}/revoke`);
    assert.equal(undo.status, 200, JSON.stringify(undo.body));
    assert.equal((await repos.org.getNode(node.id))?.name, "项目统筹");
    const stored = (await repos.audit.get(project.id, undo.body.entry.id))!;
    assert.equal(JSON.parse(stored.before!).name, "新的统筹");
    assert.equal(JSON.parse(stored.after!).name, "项目统筹");
    const redo = await call("POST", `/api/projects/${project.id}/audit/${stored.id}/revoke`);
    assert.equal(redo.status, 200, JSON.stringify(redo.body));
    assert.equal((await repos.org.getNode(node.id))?.name, "新的统筹");
    assert.equal(redo.body.entry.after.name, "新的统筹");
  });
});

test("撤销成员调岗恢复原岗位，重做重新指派目标岗位", async () => {
  await withRouter(async (repos, call) => {
    const project = await repos.projects.create({ name: "调岗" });
    const root = await repos.org.createNode({ projectId: project.id, name: "统筹", role: "top_manager" });
    const from = await repos.org.createNode({ projectId: project.id, parentId: root.id, name: "设计", role: "member" });
    const to = await repos.org.createNode({ projectId: project.id, parentId: root.id, name: "研发", role: "member" });
    const member = await repos.members.create({ projectId: project.id, kind: "human", displayName: "小林" });
    await repos.org.assignNode(member.id, from.id);
    assert.equal((await call("PUT", `/api/org/nodes/${to.id}/assignee`, { memberId: member.id })).status, 200);
    const original = (await repos.audit.list(project.id, { action: "org.assign" }))[0]!;
    const undo = await call("POST", `/api/projects/${project.id}/audit/${original.id}/revoke`);
    assert.equal(undo.status, 200, JSON.stringify(undo.body));
    assert.equal((await repos.members.get(member.id))?.nodeId, from.id);
    const redo = await call("POST", `/api/projects/${project.id}/audit/${undo.body.entry.id}/revoke`);
    assert.equal(redo.status, 200, JSON.stringify(redo.body));
    assert.equal((await repos.members.get(member.id))?.nodeId, to.id);
  });
});

test("自动分配按成员快照腾岗与恢复占岗，保留既有生成岗位", async () => {
  await withRouter(async (repos, call) => {
    const project = await repos.projects.create({ name: "自动分配" });
    await repos.org.createNode({ projectId: project.id, name: "统筹", role: "top_manager" });
    const member = await repos.members.create({ projectId: project.id, kind: "human", displayName: "小陈" });
    const placed = await call("POST", `/api/projects/${project.id}/org/auto-place`, { memberId: member.id });
    assert.equal(placed.status, 200);
    const original = (await repos.audit.list(project.id, { action: "org.auto_place" }))[0]!;
    assert.equal(original.targetId, placed.body.node.id, "auto_place 目标为岗位，并非成员 ID");
    const undo = await call("POST", `/api/projects/${project.id}/audit/${original.id}/revoke`);
    assert.equal(undo.status, 200, JSON.stringify(undo.body));
    assert.equal((await repos.members.get(member.id))?.nodeId, null);
    assert.ok(await repos.org.getNode(placed.body.node.id), "既有补偿语义保留生成岗位");
    const redo = await call("POST", `/api/projects/${project.id}/audit/${undo.body.entry.id}/revoke`);
    assert.equal(redo.status, 200, JSON.stringify(redo.body));
    assert.equal((await repos.members.get(member.id))?.nodeId, placed.body.node.id);
  });
});

test("损坏、错误目标与跨项目快照拒绝补偿，业务和审计均无部分写入", async () => {
  await withRouter(async (repos, call, driver) => {
    const project = await repos.projects.create({ name: "当前项目" });
    const foreignProject = await repos.projects.create({ name: "其他项目" });
    const root = await repos.org.createNode({ projectId: project.id, name: "统筹", role: "top_manager" });
    const foreign = await repos.org.createNode({ projectId: foreignProject.id, name: "其他统筹", role: "top_manager" });
    const before = await repos.org.createNode({ projectId: project.id, parentId: root.id, name: "原岗位", role: "member" });
    const after = await repos.org.updateNode(before.id, { name: "当前岗位" });
    for (const invalid of [[], "{broken", JSON.stringify(before), { ...before, id: foreign.id }, { ...before, projectId: foreignProject.id }, { ...before, parentId: foreign.id }, { ...before, name: undefined }, null]) {
      const row = await appendAuditEntry(repos.audit, { projectId: project.id, actor: { kind: "human", name: "人" }, action: "org.node_update", targetKind: "node", targetId: before.id, targetName: before.name, before: invalid, after });
      if (invalid === "{broken") await driver.exec("UPDATE audit_log SET before = ? WHERE id = ?", [invalid, row.id]);
      const count = (await repos.audit.list(project.id)).length;
      const denied = await call("POST", `/api/projects/${project.id}/audit/${row.id}/revoke`);
      assert.equal(denied.status, 400, JSON.stringify(denied.body));
      assert.equal((await repos.org.getNode(before.id))?.name, "当前岗位");
      assert.equal((await repos.org.getNode(foreign.id))?.name, "其他统筹");
      assert.equal((await repos.audit.get(project.id, row.id))?.reversedAt, null);
      assert.equal((await repos.audit.list(project.id)).length, count);
    }
  });
});

test("补偿审计写入失败会回滚业务恢复和原事件标记", async () => {
  await withRouter(async (repos, call, driver) => {
    const project = await repos.projects.create({ name: "事务回滚" });
    const node = await repos.org.createNode({ projectId: project.id, name: "之前", role: "top_manager" });
    await call("PUT", `/api/org/nodes/${node.id}`, { name: "之后" });
    const original = (await repos.audit.list(project.id, { action: "org.node_update" }))[0]!;
    await driver.exec("CREATE TRIGGER reject_compensation BEFORE INSERT ON audit_log WHEN NEW.action = 'org.revoke' BEGIN SELECT RAISE(ABORT, 'audit failed'); END");
    const result = await call("POST", `/api/projects/${project.id}/audit/${original.id}/revoke`);
    assert.notEqual(result.status, 200);
    assert.equal((await repos.org.getNode(node.id))?.name, "之后");
    assert.equal((await repos.audit.get(project.id, original.id))?.reversedAt, null);
    assert.equal((await repos.audit.list(project.id)).length, 1);
  });
});

test("重做拒绝损坏的补偿快照，不传播错误项目数据", async () => {
  await withRouter(async (repos, call, driver) => {
    const project = await repos.projects.create({ name: "补偿校验" });
    const node = await repos.org.createNode({ projectId: project.id, name: "之前", role: "top_manager" });
    await call("PUT", `/api/org/nodes/${node.id}`, { name: "之后" });
    const original = (await repos.audit.list(project.id, { action: "org.node_update" }))[0]!;
    const undo = await call("POST", `/api/projects/${project.id}/audit/${original.id}/revoke`);
    assert.equal(undo.status, 200);
    const corrupt = { ...JSON.parse(original.after!), projectId: "other-project" };
    await driver.exec("UPDATE audit_log SET before = ? WHERE id = ?", [JSON.stringify(corrupt), undo.body.entry.id]);
    const redo = await call("POST", `/api/projects/${project.id}/audit/${undo.body.entry.id}/revoke`);
    assert.equal(redo.status, 400);
    assert.equal((await repos.org.getNode(node.id))?.name, "之前");
    assert.equal((await repos.audit.get(project.id, undo.body.entry.id))?.reversedAt, null);
    assert.equal((await repos.audit.list(project.id)).length, 2);
  });
});

test("并发重复撤销只产生一条补偿且仅恢复一次", async () => {
  await withRouter(async (repos, call) => {
    const project = await repos.projects.create({ name: "重复撤销" });
    const node = await repos.org.createNode({ projectId: project.id, name: "之前", role: "top_manager" });
    await call("PUT", `/api/org/nodes/${node.id}`, { name: "之后" });
    const original = (await repos.audit.list(project.id, { action: "org.node_update" }))[0]!;
    const url = `/api/projects/${project.id}/audit/${original.id}/revoke`;
    const results = await Promise.all([call("POST", url), call("POST", url)]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    assert.equal((await repos.org.getNode(node.id))?.name, "之前");
    assert.equal((await repos.audit.list(project.id)).length, 2);
  });
});

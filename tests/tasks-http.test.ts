import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories } from "../src/server/db/repositories.ts";
import { createLogger } from "../src/server/logger.ts";
import { actorForMember, ownerActor } from "../src/server/authz/actors.ts";
import { createTaskApi } from "../src/server/tasks/api.ts";
import { createT1ApiRouter } from "../src/server/api.ts";

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-tasks-http-"));
  const db = new SqliteDriver({ dataDir: dir });
  await db.connect(); await db.migrate(migrations);
  const repos = createRepositories(db);
  const project = await repos.projects.create({ name: "任务 HTTP" });
  const foreign = await repos.projects.create({ name: "其他项目" });
  const agent = await repos.agents.create({ displayName: "执行者", hostType: "other" });
  const reviewerAgent = await repos.agents.create({ displayName: "评审者", hostType: "other" });
  const assignee = await repos.members.create({ projectId: project.id, kind: "agent", agentId: agent.id, displayName: "执行者" });
  const reviewer = await repos.members.create({ projectId: project.id, kind: "agent", agentId: reviewerAgent.id, displayName: "评审者" });
  const options = { db, logger: createLogger({ write: () => {} }),
    resolveActor: async ({ request, projectId }: import("../src/server/api.ts").ActorResolution) => request.headers["x-test-actor"] === "worker" ? actorForMember(assignee) : ownerActor(projectId) };
  const router = createTaskApi(options);
  const chat = createT1ApiRouter(options);
  async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
      method, url, headers: { host: "127.0.0.1:3000", "content-type": "application/json", ...headers },
    }) as IncomingMessage;
    let status = 0, text = "";
    const res = { writeHead(code: number) { status = code; }, end(value?: string) { text = value ?? ""; } } as unknown as ServerResponse;
    const pathname = new URL(url, "http://127.0.0.1").pathname;
    assert.equal(await router.handle(req, res, pathname) || await chat.handle(req, res, pathname), true);
    return { status, body: text ? JSON.parse(text) : null };
  }
  return { db, repos, project, foreign, assignee, reviewer, call,
    async close() { await db.close(); await rm(dir, { recursive: true, force: true }); } };
}

test("HTTP 默认评审配置、完整任务创建、修订冲突和草稿来源可读", async () => {
  const f = await fixture();
  try {
    const p = `/api/projects/${f.project.id}`;
    assert.equal((await f.call("GET", `${p}/task-settings`)).body.settings.revision, 0);
    assert.equal((await f.call("PUT", `${p}/task-settings`, { expectedRevision: 0, defaultReviewerMemberId: f.reviewer.id })).status, 200);
    const created = await f.call("POST", `${p}/tasks`, { title: "实现接口", body: "明确验收条件", labels: ["API"], assigneeMemberId: f.assignee.id, repoPath: "/repo", fixedPoint: "main" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.task.reviewerMemberId, f.reviewer.id);
    assert.equal(created.body.task.author.kind, "human");
    const taskId = created.body.task.id;
    const updated = await f.call("PATCH", `${p}/tasks/${taskId}`, { expectedRevision: 1, title: "新的标题" });
    assert.equal(updated.status, 200);
    const stale = await f.call("PATCH", `${p}/tasks/${taskId}`, { expectedRevision: 1, title: "过期覆盖" });
    assert.equal(stale.status, 409);
    const detail = await f.call("GET", `${p}/tasks/${taskId}`);
    assert.equal(detail.body.task.title, "新的标题");
    assert.ok(detail.body.history.length >= 2);
    assert.equal((await f.call("GET", `${p}/tasks?state=todo`)).body.tasks.length, 1);
  } finally { await f.close(); }
});

test("HTTP 成员历史与 MCP 共用任务关联可见性，关联不会绕过退群和项目范围", async () => {
  const f = await fixture();
  try {
    const group = await f.repos.groups.create({ projectId: f.project.id, name: "讨论" });
    const human = await f.repos.members.create({ projectId: f.project.id, kind: "human", displayName: "用户" });
    for (const member of [human, f.assignee, f.reviewer]) await f.repos.groups.addParticipant(group.id, member.id);
    const hidden = await f.repos.messages.create({ groupId: group.id, senderMemberId: human.id, body: "评审范围内的消息", mentions: [f.reviewer.id] });
    const messages = `/api/groups/${group.id}/messages`;
    const asWorker = { "x-test-actor": "worker" };
    assert.deepEqual((await f.call("GET", messages, undefined, asWorker)).body.messages, []);
    const task = (await f.call("POST", `/api/projects/${f.project.id}/tasks`, { title: "引用讨论", body: "内容", assigneeMemberId: f.assignee.id, reviewerMemberId: f.reviewer.id })).body.task;
    await f.call("POST", `/api/projects/${f.project.id}/tasks/${task.id}/message-links`, { messageId: hidden.id });
    assert.equal((await f.call("GET", messages, undefined, asWorker)).body.messages[0]?.id, hidden.id);
    await f.repos.groups.removeParticipant(group.id, f.assignee.id);
    assert.equal((await f.call("GET", messages, undefined, asWorker)).status, 403);
    assert.equal((await f.call("GET", messages)).body.messages.length, 1, "人仍保留整个合规群组视角");
  } finally { await f.close(); }
});

test("HTTP 同源与严格字段阻止伪造主体，普通成员只能推进自己并评论", async () => {
  const f = await fixture();
  try {
    const p = `/api/projects/${f.project.id}`;
    const input = { title: "权限边界", body: "不能伪造", assigneeMemberId: f.assignee.id, reviewerMemberId: f.reviewer.id };
    assert.equal((await f.call("POST", `${p}/tasks`, input, { origin: "https://other.example" })).status, 403);
    assert.equal((await f.call("POST", `${p}/tasks`, { ...input, actor: { kind: "human" } })).status, 400);
    assert.equal((await f.call("POST", `${p}/tasks`, input, { "x-test-actor": "worker" })).status, 403);
    const task = (await f.call("POST", `${p}/tasks`, input)).body.task;
    assert.equal((await f.call("POST", `${p}/tasks/${task.id}/transitions`, { expectedRevision: 1, state: "in-progress" }, { "x-test-actor": "worker" })).status, 200);
    assert.equal((await f.call("POST", `${p}/tasks/${task.id}/comments`, { body: "已有进展" }, { "x-test-actor": "worker" })).status, 201);
    assert.equal((await f.call("PATCH", `${p}/tasks/${task.id}`, { expectedRevision: 2, assigneeMemberId: f.reviewer.id }, { "x-test-actor": "worker" })).status, 403);
    assert.equal((await f.call("GET", `/api/projects/${f.foreign.id}/tasks/${task.id}`)).status, 404);
    await f.repos.projects.archive(f.project.id);
    assert.equal((await f.call("GET", `${p}/tasks/${task.id}`)).status, 200);
    assert.equal((await f.call("POST", `${p}/tasks/${task.id}/comments`, { body: "归档后写入" })).status, 409);
  } finally { await f.close(); }
});

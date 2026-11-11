import test from "node:test";
import assert from "node:assert/strict";
import { byTestId, deferred, find, json, settle, textOf, withPage } from "./helpers/web-ui.ts";

const project = { id: "project-1", name: "审计项目", archivedAt: null };
const entry = { id: "audit-1", projectId: project.id, actorKind: "human", actorMemberId: null, actorName: "人（owner）",
  action: "member.remove", targetKind: "member", targetId: "member-1", targetName: "测试成员", changed: null,
  before: { schema: "member-relations/v2" }, after: { schema: "member-relations/v2" }, detail: null,
  reversedAt: null, reversedByAuditId: null, createdAt: "2026-11-11T00:00:00Z", reversible: true };

test("S5-AUDIT-06：历史快照不足不提供撤销按钮，并与已撤销和永久删除区分", async () => {
  await withPage("AuditView", url => url.startsWith("/api/projects?") ? json({ projects: [project] }) : json({ entries: [
    { ...entry, before: { id: "member-1" }, after: null },
    { ...entry, id: "audit-2", reversedAt: "2026-11-11T00:01:00Z" },
    { ...entry, id: "audit-3", action: "project.delete", reversible: false },
  ] }), async container => {
    assert.match(textOf(container), /历史快照不足/);
    assert.match(textOf(container), /已撤销/);
    assert.match(textOf(container), /永久删除，不可撤销/);
    assert.equal(find(container, node => node.props["data-testid"] === "audit-revoke"), undefined);
  }, { path: "/projects/project-1/audit" });
});

test("S5-AUDIT-09/10：恢复成员后明确重新连接与启动要求，新的补偿事件仍可撤销", async () => {
  let reversed = false;
  const compensation = { ...entry, id: "audit-2", action: "member.revoke", detail: {
    reversal: { version: 2, rootAction: "member.remove", rootAuditId: entry.id, undoesAuditId: entry.id, direction: "undo" },
    restartRequired: ["mcp-session", "review", "runtime-binding", "memory-summary"],
  } };
  await withPage("AuditView", (url, init) => {
    if (url.startsWith("/api/projects?")) return json({ projects: [project] });
    if (init?.method === "POST") { reversed = true; return json({ entry: compensation }); }
    return json({ entries: reversed ? [compensation, { ...entry, reversedAt: "2026-11-11T00:01:00Z", reversedByAuditId: compensation.id }] : [entry] });
  }, async container => {
    await byTestId(container, "audit-revoke").props.onClick(); await settle();
    const notice = textOf(byTestId(container, "audit-notice"));
    assert.match(notice, /重新连接/);
    assert.match(notice, /重新发起评审/);
    assert.match(notice, /重新配置.*启动/);
    assert.match(notice, /重新发起记忆总结/);
    assert.ok(byTestId(container, "audit-revoke"), "补偿链下一次翻转仍有操作入口");
  }, { path: "/projects/project-1/audit" });
});

test("S5-AUDIT-06：状态冲突给出核对指引且不报告撤销成功", async () => {
  await withPage("AuditView", (url, init) => {
    if (url.startsWith("/api/projects?")) return json({ projects: [project] });
    if (init?.method === "POST") return json({ error: { code: "compensation_conflict", message: "相关事实已变化。" } }, 409);
    return json({ entries: [entry] });
  }, async container => {
    await byTestId(container, "audit-revoke").props.onClick(); await settle();
    assert.match(textOf(byTestId(container, "audit-error")), /当前状态.*变化.*刷新.*核对/);
    assert.equal(find(container, node => node.props["data-testid"] === "audit-notice"), undefined);
    assert.ok(byTestId(container, "audit-revoke"));
  }, { path: "/projects/project-1/audit" });
});

test("切换项目后旧撤销的失败与结束不能覆盖新项目的反馈或忙碌状态", async () => {
  const other = { ...project, id: "project-2", name: "另一个项目" };
  const otherEntry = { ...entry, id: "audit-2", projectId: other.id, targetName: "另一个成员" };
  const oldPost = deferred<Response>(), newPost = deferred<Response>();
  await withPage("AuditView", (url, init) => {
    if (url.startsWith("/api/projects?")) return json({ projects: [project, other] });
    if (init?.method === "POST") return url.includes(project.id) ? oldPost.promise : newPost.promise;
    return json({ entries: [url.includes(project.id) ? entry : otherEntry] });
  }, async (container, { store }) => {
    const oldOperation = byTestId(container, "audit-revoke").props.onClick(); await settle();
    assert.equal(await store.selectProject(other.id), true); await settle();
    assert.equal(byTestId(container, "audit-revoke").props.disabled, false, "切换项目释放旧操作的界面状态");
    const newOperation = byTestId(container, "audit-revoke").props.onClick(); await settle();
    oldPost.resolve(json({ error: { code: "compensation_conflict", message: "旧项目冲突" } }, 409));
    await oldOperation; await settle();
    assert.equal(find(container, node => node.props["data-testid"] === "audit-error"), undefined);
    assert.equal(byTestId(container, "audit-revoke").props.disabled, true, "旧操作finally不能结束新操作");
    newPost.resolve(json({ entry: { ...otherEntry, action: "member.revoke" } }));
    await newOperation; await settle();
    assert.match(textOf(byTestId(container, "audit-notice")), /已撤销/);
    assert.equal(byTestId(container, "audit-revoke").props.disabled, false);
  }, { path: "/projects/project-1/audit" });
});

test("旧项目列表延迟失败不能污染新项目，也不能提前清除新请求的加载状态", async () => {
  const other = { ...project, id: "project-2", name: "另一个项目" };
  const oldLoad = deferred<Response>(), newLoad = deferred<Response>();
  await withPage("AuditView", url => {
    if (url.startsWith("/api/projects?")) return json({ projects: [project, other] });
    return url.includes(project.id) ? oldLoad.promise : newLoad.promise;
  }, async (container, { store }) => {
    assert.match(textOf(container), /正在加载变更记录/);
    await store.selectProject(other.id); await settle();
    oldLoad.resolve(json({ error: { code: "read_failed", message: "旧项目读取失败" } }, 500)); await settle();
    assert.equal(find(container, node => node.props["data-testid"] === "audit-error"), undefined);
    assert.match(textOf(container), /正在加载变更记录/);
    assert.equal(byTestId(container, "audit-refresh").props.disabled, true);
    newLoad.resolve(json({ entries: [{ ...entry, id: "audit-2", projectId: other.id, targetName: "新项目成员" }] })); await settle();
    assert.match(textOf(byTestId(container, "audit-list")), /新项目成员/);
    assert.equal(byTestId(container, "audit-refresh").props.disabled, false);
  }, { path: "/projects/project-1/audit" });
});

test("离开再返回同一项目，旧成功响应不能结束新撤销或显示成功提示", async () => {
  const other = { ...project, id: "project-2", name: "另一个项目" };
  const first = deferred<Response>(), second = deferred<Response>();
  let posts = 0;
  await withPage("AuditView", (url, init) => {
    if (url.startsWith("/api/projects?")) return json({ projects: [project, other] });
    if (init?.method === "POST") return ++posts === 1 ? first.promise : second.promise;
    return json({ entries: url.includes(project.id) ? [entry] : [] });
  }, async (container, { store }) => {
    const oldOperation = byTestId(container, "audit-revoke").props.onClick(); await settle();
    await store.selectProject(other.id); await settle();
    await store.selectProject(project.id); await settle();
    const newOperation = byTestId(container, "audit-revoke").props.onClick(); await settle();
    assert.equal(posts, 2);
    first.resolve(json({ entry: { ...entry, action: "member.revoke" } }));
    await oldOperation; await settle();
    assert.equal(find(container, node => node.props["data-testid"] === "audit-notice"), undefined);
    assert.equal(byTestId(container, "audit-revoke").props.disabled, true);
    second.resolve(json({ error: { code: "compensation_conflict", message: "新请求发现冲突" } }, 409));
    await newOperation; await settle();
    assert.match(textOf(byTestId(container, "audit-error")), /当前状态已经变化/);
    assert.equal(find(container, node => node.props["data-testid"] === "audit-notice"), undefined);
    assert.equal(byTestId(container, "audit-revoke").props.disabled, false);
  }, { path: "/projects/project-1/audit" });
});

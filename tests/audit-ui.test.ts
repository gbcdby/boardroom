import test from "node:test";
import assert from "node:assert/strict";
import { byTestId, find, json, settle, textOf, withPage } from "./helpers/web-ui.ts";

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

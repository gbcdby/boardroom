import test from "node:test";
import assert from "node:assert/strict";
import { nextTick } from "vue";
import { byTestId, deferred, find, json, settle, textOf, withPage as renderPage, type UiElement } from "./helpers/web-ui.ts";

function withPage(name: string, respond: (url: string, init: RequestInit | undefined) => Promise<Response> | Response, check: (container: UiElement) => Promise<void>): Promise<void> {
  return renderPage(name, respond, check, { path: name === "ProjectsView" ? "/projects" : `/projects/project-1/${name === "OrgView" ? "org" : "audit"}` });
}

const project = { id: "project-1", name: "界面验收", manager: null, archivedAt: null };
const auditEntry = {
  id: "audit-1", projectId: project.id, action: "member.add", targetKind: "member", targetName: "小林", targetId: "member-1",
  actorKind: "human", actorName: "用户", createdAt: "2026-11-11T01:00:00.000Z", reversedAt: null,
};

test("审计撤销仅提交一次，刷新列表后仍显示成功反馈", async () => {
  const request = deferred<Response>();
  let mutations = 0;
  let reversed = false;
  await withPage("AuditView", (url, init) => {
    if (init?.method === "POST") { mutations++; return request.promise; }
    if (url.includes("/audit")) return json({ entries: [{ ...auditEntry, reversedAt: reversed ? "2026-11-11T02:00:00.000Z" : null }] });
    return json({ projects: [project] });
  }, async (container) => {
    const button = byTestId(container, "audit-revoke");
    const first = button.props.onClick();
    const duplicate = button.props.onClick();
    await nextTick();
    assert.equal(mutations, 1, "请求进行中不能重复撤销同一事件");
    assert.equal(byTestId(container, "audit-revoke").props.disabled, true);
    reversed = true;
    request.resolve(json({ ok: true }));
    await Promise.all([first, duplicate]);
    await settle();
    assert.match(textOf(byTestId(container, "audit-notice")), /已撤销/);
    assert.equal(byTestId(container, "audit-notice").props.role, "status");
    assert.match(textOf(container), /已撤销/);
  });
});

test("审计初始读取失败不冒充空项目，刷新可恢复", async () => {
  let available = false;
  await withPage("AuditView", (url) => {
    if (url.includes("/audit")) return json({ entries: [auditEntry] });
    return available ? json({ projects: [project] }) : json({ error: { code: "write_failed", message: "读取暂不可用" } }, 503);
  }, async (container) => {
    assert.match(textOf(byTestId(container, "audit-error")), /读取暂不可用/);
    assert.doesNotMatch(textOf(container), /还没有项目/);
    assert.equal(byTestId(container, "audit-refresh").props.disabled, false);
    available = true;
    await byTestId(container, "audit-refresh").props.onClick();
    await settle();
    assert.match(textOf(byTestId(container, "audit-list")), /小林/);
    assert.equal(find(container, (entry) => entry.props["data-testid"] === "audit-error"), undefined);
  });
});

test("项目详情并行加载时，先完成的一项不会提前开放写入控件", async () => {
  const members = deferred<Response>();
  await withPage("ProjectsView", (url) => {
    if (url.endsWith("/members")) return members.promise;
    if (url.includes("/groups")) return json({ groups: [] });
    if (url.includes("/member-statuses")) return json({ memberStatuses: [] });
    return json({ projects: [project] });
  }, async (container) => {
    try {
      assert.equal(byTestId(container, "create-project").props.disabled, true);
    } finally {
      members.resolve(json({ members: [] }));
      await settle();
    }
    assert.equal(byTestId(container, "create-project").props.disabled, false);
  });
});

test("新岗位创建失败后保留填写内容，便于修正后重试", async () => {
  const snapshot = {
    nodes: [{ id: "node-1", name: "项目统筹", role: "top_manager", parentId: null, memberId: null, memberDisplayName: null }],
    members: [],
    roles: [{ role: "top_manager", nodeRole: true, capabilities: [] }, { role: "member", nodeRole: true, capabilities: [] }],
  };
  await withPage("OrgView", (url, init) => {
    if (init?.method === "POST") return json({ error: { code: "CONFLICT", message: "岗位名称已存在" } }, 409);
    if (url.includes("/org")) return json(snapshot);
    return json({ projects: [project] });
  }, async (container) => {
    const name = find(container, (node) => node.props["aria-label"] === "新岗位名称");
    assert.ok(name);
    name.value = "设计师";
    for (const listener of name.listeners["input"] ?? []) listener({ target: name });
    await nextTick();
    let form = name.parent;
    while (form && form.type !== "form") form = form.parent;
    assert.ok(form);
    await form.props.onSubmit({ preventDefault() {} });
    await settle();
    assert.equal(name.value, "设计师");
    assert.match(textOf(byTestId(container, "error")), /岗位名称已存在/);
  });
});

test("岗位逐项保存不会丢掉同一编辑区其他尚未保存的修改", async () => {
  const snapshot = {
    nodes: [
      { id: "node-1", name: "项目统筹", role: "top_manager", parentId: null, memberId: null, memberDisplayName: null },
      { id: "node-2", name: "产品设计", role: "member", parentId: "node-1", memberId: null, memberDisplayName: null },
    ], members: [],
    roles: ["top_manager", "sub_manager", "member"].map((role) => ({ role, nodeRole: true, capabilities: [] })),
  };
  await withPage("OrgView", (url, init) => {
    if (init?.method === "PUT") { Object.assign(snapshot.nodes[1]!, JSON.parse(String(init.body))); return json({ node: snapshot.nodes[1] }); }
    if (url.includes("/org")) return json(snapshot);
    return json({ projects: [project] });
  }, async (container) => {
    const edit = find(container, (node) => node.props["aria-controls"] === "node-editor-node-2");
    assert.ok(edit);
    edit.props.onClick();
    await nextTick();
    const name = find(container, (node) => node.props.id === "node-name-node-2");
    const role = find(container, (node) => node.props.id === "node-role-node-2");
    assert.ok(name); assert.ok(role);
    name.value = "设计负责人";
    for (const listener of name.listeners["input"] ?? []) listener({ target: name });
    role.selectedIndex = role.options.findIndex((option) => option.value === "sub_manager");
    for (const listener of role.listeners["change"] ?? []) listener({ target: role });
    await nextTick();
    let form = name.parent;
    while (form && form.type !== "form") form = form.parent;
    assert.ok(form);
    await form.props.onSubmit({ preventDefault() {} });
    await settle();
    assert.equal(snapshot.nodes[1]?.name, "设计负责人");
    assert.equal(snapshot.nodes[1]?.role, "member", "改名不能顺带保存角色变更");
    assert.equal(role.options[role.selectedIndex]?.value, "sub_manager", "未提交的角色修改应留在编辑区");
  });
});

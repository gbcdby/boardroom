import test from "node:test";
import assert from "node:assert/strict";
import { useToast } from "../src/web/src/composables/useToast.ts";
import { byTestId, deferred, find, json, settle, textOf, withPage } from "./helpers/web-ui.ts";

const project = { id: "project-1", name: "确认操作的项目", manager: null, archivedAt: null };
const member = { id: "member-1", projectId: project.id, kind: "human", displayName: "待移除成员", role: "normal", status: "active", nodeId: null };

test("S6-AC01：移除成员先显示对象与影响，取消不提交变更", async () => {
  let removals = 0;
  await withPage("ProjectsView", (url, init) => {
    if (init?.method === "DELETE") { removals++; return new Response(null, { status: 204 }); }
    if (url.endsWith("/members")) return json({ members: [member] });
    if (url.includes("/groups")) return json({ groups: [] });
    if (url.includes("/member-statuses")) return json({ memberStatuses: [] });
    return json({ projects: [project] });
  }, async (container) => {
    const remove = find(container, node => node.type === "button" && textOf(node) === "移除");
    assert.ok(remove);
    await remove.props.onClick(); await settle();
    assert.equal(removals, 0, "第一次点击不得直接移除成员");
    assert.match(textOf(byTestId(container, "confirmation-dialog")), /待移除成员/);
    assert.match(textOf(byTestId(container, "confirmation-dialog")), /历史.*保留/);
    await byTestId(container, "confirm-cancel").props.onClick(); await settle();
    assert.equal(removals, 0, "取消不能提交移除");
    assert.equal(find(container, node => node.props["data-testid"] === "confirmation-dialog"), undefined);
  }, { path: "/projects" });
});

test("S6-AC01/02：删除岗位展示影响，服务端拒绝保留确认现场", async () => {
  const snapshot = { nodes: [
    { id: "node-1", name: "项目统筹", projectId: project.id, role: "top_manager", parentId: null, memberId: null },
    { id: "node-2", name: "产品设计", projectId: project.id, role: "member", parentId: "node-1", memberId: null },
  ], members: [], roles: ["top_manager", "member"].map(role => ({ role, nodeRole: true, capabilities: [] })) };
  let deletions = 0;
  await withPage("OrgView", (url, init) => {
    if (init?.method === "DELETE") { deletions++; return json({ error: { code: "conflict", message: "岗位状态已变化，请核对" } }, 409); }
    if (url.includes("/org")) return json(snapshot);
    return json({ projects: [project] });
  }, async (container) => {
    find(container, node => node.props["aria-controls"] === "node-editor-node-2")!.props.onClick(); await settle();
    find(container, node => node.type === "button" && textOf(node) === "删除岗位")!.props.onClick(); await settle();
    assert.equal(deletions, 0);
    assert.match(textOf(byTestId(container, "confirmation-dialog")), /产品设计/);
    assert.match(textOf(byTestId(container, "confirmation-dialog")), /下级.*上级|下级.*父/);
    await byTestId(container, "confirm-submit").props.onClick(); await settle();
    assert.equal(deletions, 1);
    assert.match(textOf(byTestId(container, "confirmation-error")), /岗位状态已变化/);
    assert.ok(byTestId(container, "confirmation-dialog"));
  }, { path: "/projects/project-1/org" });
});

test("S6-AC03：永久删除过期后重新预览，必须再次确认且只使用最新 token", async () => {
  let previews = 0, removed = false;
  const tokens: string[] = [];
  const cascade = { groups: 1, members: 1, orgNodes: 2, messages: 3, deliveries: 0, memberStatuses: 1, memberFactRevisions: 1, mcpSessions: 0, taskSettings: 1, tasks: 2, taskComments: 0, taskHistory: 0, taskMessageLinks: 0, reviewRounds: 0, reviewReports: 0, workEvents: 0, memoryDocuments: 1, memoryVersions: 2, memorySummaryRequests: 0, memoryMessageReceipts: 0, memoryTriggerCounters: 0, memoryScanCheckpoints: 0 };
  await withPage("ProjectsView", (url, init) => {
    if (init?.method === "DELETE") {
      if (!init.body) {
        previews++;
        return json({ error: { code: "confirmation_required" }, confirmation: { kind: "project", projectId: project.id, projectName: project.name, cascade, token: `token-${previews}`, expiresAt: "2026-11-12T01:00:00Z" } }, 409);
      }
      tokens.push(JSON.parse(String(init.body)).confirm);
      if (tokens.length === 1) return json({ error: { code: "invalid_confirmation", message: "确认凭据已过期，请重新获取清单。" } }, 400);
      removed = true;
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/members")) return json({ members: [member] });
    if (url.includes("/groups")) return json({ groups: [] });
    if (url.includes("/member-statuses")) return json({ memberStatuses: [] });
    return json({ projects: removed ? [] : [project] });
  }, async (container) => {
    await byTestId(container, "purge-project").props.onClick(); await settle();
    assert.equal(previews, 1); assert.deepEqual(tokens, []);
    await byTestId(container, "confirm-purge-project").props.onClick(); await settle();
    assert.match(textOf(byTestId(container, "confirmation-error")), /过期/);
    assert.equal(byTestId(container, "confirm-purge-project").props.disabled, true);
    await byTestId(container, "confirmation-preview").props.onClick(); await settle();
    assert.equal(previews, 2); assert.deepEqual(tokens, ["token-1"], "重新预览不能顺带删除");
    assert.match(textOf(byTestId(container, "project-purge-confirm")), /组织岗位：2/);
    await byTestId(container, "confirm-purge-project").props.onClick(); await settle();
    assert.deepEqual(tokens, ["token-1", "token-2"]);
    assert.equal(find(container, node => node.props["data-testid"] === "confirmation-dialog"), undefined);
  }, { path: "/projects" });
});

test("S6-AC02：确认进行中只提交一次；未知结果必须核对，读取失败不能冒充已删除", async () => {
  const response = deferred<Response>();
  let removals = 0, checking = false, readable = false;
  await withPage("ProjectsView", (url, init) => {
    if (init?.method === "DELETE") { removals++; return response.promise; }
    if (url.endsWith("/members")) {
      if (checking && !readable) return json({ error: { code: "forbidden", message: "当前无权读取成员" } }, 403);
      return json({ members: readable ? [] : [member] });
    }
    if (url.includes("/groups")) return json({ groups: [] });
    if (url.includes("/member-statuses")) return json({ memberStatuses: [] });
    return json({ projects: [project] });
  }, async (container) => {
    find(container, node => node.type === "button" && textOf(node) === "移除")!.props.onClick(); await settle();
    const submit = byTestId(container, "confirm-submit");
    submit.props.onClick(); submit.props.onClick(); await settle();
    assert.equal(removals, 1);
    assert.equal(byTestId(container, "confirm-submit").props.disabled, true);
    response.resolve(json({ error: { code: "server_error", message: "响应丢失，无法确认结果" } }, 503));
    await settle();
    assert.match(textOf(byTestId(container, "confirmation-error")), /未知|核对/);
    assert.equal(byTestId(container, "confirm-submit").props.disabled, true, "未知结果不能直接重复提交");
    checking = true;
    await byTestId(container, "confirmation-reconcile").props.onClick(); await settle();
    assert.match(textOf(byTestId(container, "confirmation-error")), /无权读取成员/);
    assert.ok(byTestId(container, "confirmation-dialog"), "403 仍为未知，不能声称删除成功");
    assert.equal(removals, 1);
    readable = true;
    await byTestId(container, "confirmation-reconcile").props.onClick(); await settle();
    assert.equal(find(container, node => node.props["data-testid"] === "confirmation-dialog"), undefined);
    assert.equal(removals, 1, "核对已完成的移除不能再发送变更");
  }, { path: "/projects" });
});

test("S6-AC02：超时进入未知结果，关闭后重开不能绕过核对", async () => {
  let removals = 0;
  await withPage("ProjectsView", (url, init) => {
    if (init?.method === "DELETE") { removals++; return json({ error: { code: "request_timeout", message: "请求超时" } }, 408); }
    if (url.endsWith("/members")) return json({ members: [member] });
    if (url.includes("/groups")) return json({ groups: [] });
    if (url.includes("/member-statuses")) return json({ memberStatuses: [] });
    return json({ projects: [project] });
  }, async (container) => {
    const remove = () => find(container, node => node.type === "button" && textOf(node) === "移除")!.props.onClick();
    remove(); await settle();
    await byTestId(container, "confirm-submit").props.onClick(); await settle();
    assert.equal(byTestId(container, "confirm-submit").props.disabled, true, "超时未证明未提交，不能直接重试");
    assert.equal(textOf(byTestId(container, "confirm-cancel")), "关闭");
    await byTestId(container, "confirm-cancel").props.onClick(); await settle();
    remove(); await settle();
    assert.ok(byTestId(container, "confirmation-reconcile"));
    assert.equal(byTestId(container, "confirm-submit").props.disabled, true);
    assert.equal(removals, 1);
    await byTestId(container, "confirmation-reconcile").props.onClick(); await settle();
    assert.equal(byTestId(container, "confirm-submit").props.disabled, false, "权威读取仍存在后才重新等待确认");
    assert.equal(removals, 1, "核对不能顺带重新提交");
  }, { path: "/projects" });
});

test("S6-AC05：切换项目使确认失效，旧请求迟到不影响新项目或产生成功提示", async () => {
  const response = deferred<Response>();
  const other = { ...project, id: "project-2", name: "另一个项目" };
  const otherMember = { ...member, id: "member-2", projectId: other.id, displayName: "新项目成员" };
  const targets: string[] = [];
  const toast = useToast(); toast.clear();
  await withPage("ProjectsView", (url, init) => {
    if (init?.method === "DELETE") { targets.push(url); return response.promise; }
    if (url.endsWith("/members")) return json({ members: [url.includes(other.id) ? otherMember : member] });
    if (url.includes("/groups")) return json({ groups: [] });
    if (url.includes("/member-statuses")) return json({ memberStatuses: [] });
    return json({ projects: [project, other] });
  }, async (container, { store }) => {
    find(container, node => node.type === "button" && textOf(node) === "移除")!.props.onClick(); await settle();
    byTestId(container, "confirm-submit").props.onClick(); await settle();
    await store.selectProject(other.id); await settle();
    assert.equal(find(container, node => node.props["data-testid"] === "confirmation-dialog"), undefined);
    response.resolve(new Response(null, { status: 204 })); await settle();
    assert.deepEqual(targets, ["/api/projects/project-1/members/member-1"]);
    assert.match(textOf(byTestId(container, "member-list")), /新项目成员/);
    assert.equal(toast.items.value.length, 0);
  }, { path: "/projects" });
  toast.clear();
});

for (const kind of ["project", "group"] as const) {
  test(`S6-AC01：${kind === "project" ? "项目" : "群组"}归档取消不提交，确认只提交捕获目标并刷新`, async () => {
    const group = { id: "group-1", projectId: project.id, name: "待归档群组", archivedAt: null };
    let archived = false;
    const targets: string[] = [];
    const toast = useToast(); toast.clear();
    await withPage("ProjectsView", (url, init) => {
      if (init?.method === "POST") {
        targets.push(url); archived = true;
        return json(kind === "project" ? { project: { ...project, archivedAt: "2026-11-11T00:00:00Z" } } : { group: { ...group, archivedAt: "2026-11-11T00:00:00Z" } });
      }
      if (url.includes("/participants")) return json({ participants: [member] });
      if (url.endsWith("/members")) return json({ members: [member] });
      if (url.includes("/groups")) return json({ groups: [{ ...group, archivedAt: kind === "group" && archived ? "2026-11-11T00:00:00Z" : null }] });
      if (url.includes("/member-statuses")) return json({ memberStatuses: [] });
      return json({ projects: [{ ...project, archivedAt: kind === "project" && archived ? "2026-11-11T00:00:00Z" : null }] });
    }, async (container) => {
      await byTestId(container, `archive-${kind}`).props.onClick(); await settle();
      assert.match(textOf(byTestId(container, "confirmation-dialog")), /可.*恢复/);
      await byTestId(container, "confirm-cancel").props.onClick(); await settle();
      assert.deepEqual(targets, []);
      await byTestId(container, `archive-${kind}`).props.onClick(); await settle();
      await byTestId(container, "confirm-submit").props.onClick(); await settle();
      assert.deepEqual(targets, [kind === "project" ? "/api/projects/project-1/archive" : "/api/groups/group-1/archive"]);
      assert.ok(byTestId(container, `${kind}-archived-badge`));
      assert.equal(toast.items.value.length, 1);
      assert.match(toast.items.value[0]!.message, /已归档/);
      if (kind === "project") assert.equal(byTestId(container, "new-member-name").props.disabled, true);
    }, { path: "/projects?archived=1" });
    toast.clear();
  });
}

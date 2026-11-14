import test from "node:test";
import assert from "node:assert/strict";
import { byTestId, find, json, settle, textOf, withPage } from "./helpers/web-ui.ts";

const project = { id: "project-1", name: "目录同步项目", manager: null, archivedAt: null, groupCount: 1 };
const initialGroup = { id: "group-1", projectId: project.id, name: "可达讨论群", archivedAt: null as string | null };

test("共享目录重新读取后，侧栏更新已展开群组，即使项目计数没有改变", async () => {
  let group = { ...initialGroup };
  let present = true;
  await withPage("../components/SidebarNavigation", (url) => {
    if (url.includes("/groups")) return json({ groups: present && !group.archivedAt ? [group] : [] });
    // 归档不会改变所有群组总数；不能把计数当作目录版本。
    return json({ projects: [project] });
  }, async (container, { store }) => {
    const tree = () => textOf(byTestId(container, "sidebar-project-tree"));
    assert.match(tree(), /可达讨论群/);
    group = { ...group, archivedAt: "2026-11-12T01:00:00Z" };
    await store.refreshProjects(); await settle();
    assert.doesNotMatch(tree(), /可达讨论群/, "归档后的群不能留在活动侧栏");
    group = { ...group, archivedAt: null };
    await store.refreshProjects(); await settle();
    assert.match(tree(), /可达讨论群/, "恢复的群应重新可达");
    present = false;
    await store.refreshProjects(); await settle();
    assert.doesNotMatch(tree(), /可达讨论群/, "已删除群不能留下失效入口");
  }, { path: "/projects/project-1/overview" });
});

for (const kind of ["archive", "restore", "purge", "archive-unknown", "purge-unknown"] as const) {
  test(`群组 ${kind} 成功后更新共享目录；未知结果核对不重发变更`, async () => {
    let group = { ...initialGroup, archivedAt: kind === "restore" ? "2026-11-12T01:00:00Z" : null };
    let present = true;
    let writes = 0;
    const unknown = kind.endsWith("unknown");
    await withPage("ProjectsView", (url, init) => {
      if (init?.method === "POST" && url.includes("/groups/")) {
        writes++;
        group = { ...group, archivedAt: kind === "restore" ? null : "2026-11-12T02:00:00Z" };
        return unknown ? json({ error: { code: "server_error", message: "响应丢失" } }, 503) : json({ group });
      }
      if (init?.method === "DELETE") {
        if (!init.body) return json({ error: { code: "confirmation_required" }, confirmation: {
          kind: "group", projectId: project.id, projectName: project.name, groupId: group.id, groupName: group.name,
          cascade: {}, token: "directory-token", expiresAt: "2026-11-12T03:00:00Z",
        } }, 409);
        assert.equal(JSON.parse(String(init.body)).confirm, "directory-token");
        writes++; present = false;
        return unknown ? json({ error: { code: "server_error", message: "响应丢失" } }, 503) : new Response(null, { status: 204 });
      }
      if (url.endsWith("/participants")) return json({ participants: [] });
      if (url.endsWith("/members")) return json({ members: [] });
      if (url.includes("/member-statuses")) return json({ memberStatuses: [] });
      if (url.includes("/groups")) return json({ groups: present ? [group] : [] });
      return json({ projects: [{ ...project, groupCount: present ? 1 : 0 }] });
    }, async (container, { store }) => {
      const snapshot = store.projects.value;
      if (kind === "restore") {
        const button = find(container, node => node.type === "button" && textOf(node) === "恢复群组");
        assert.ok(button); await button.props.onClick();
      } else {
        const purge = kind.startsWith("purge");
        await byTestId(container, purge ? "purge-group" : "archive-group").props.onClick(); await settle();
        assert.equal(writes, 0, "打开确认或取得预览不能提交变更");
        assert.equal(store.projects.value, snapshot, "预览不能发布未经确认的目录变化");
        await byTestId(container, purge ? "confirm-purge-group" : "confirm-submit").props.onClick(); await settle();
        if (unknown) {
          assert.equal(store.projects.value, snapshot, "响应丢失时不能把结果当成成功发布");
          await byTestId(container, "confirmation-reconcile").props.onClick();
        }
      }
      await settle();
      assert.equal(writes, 1, "核对成功不能重复发送变更");
      assert.notEqual(store.projects.value, snapshot, "已确认变更须发布新的共享目录快照供侧栏消费");
      assert.equal(find(container, node => node.props["data-testid"] === "confirmation-dialog"), undefined);
      if (kind.startsWith("purge")) assert.equal(store.projects.value[0].groupCount, 0);
    }, { path: "/projects/project-1/overview?archived=1" });
  });
}

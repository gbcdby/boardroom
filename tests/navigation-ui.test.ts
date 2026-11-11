import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryHistory, createRouter } from "vue-router";
const contextModule = new URL("../src/web/src/composables/useCurrentProject.ts", import.meta.url).href;

async function fixture() {
  const { createCurrentProjectContext } = await import(contextModule);
  const store = createCurrentProjectContext({ storage: null, loadProjects: async () => [
    { id: "alpha", name: "甲", archivedAt: null }, { id: "beta", name: "乙", archivedAt: null },
  ] as never });
  const component = { render: () => null };
  const sections = ["overview", "tasks", "members", "org", "status", "audit", "activity", "memory", "knowledge", "settings", "groups"];
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: "/", component }, { path: "/projects", component },
    ...sections.flatMap(section => [
      { path: `/${section}`, component, meta: { projectSection: section } },
      { path: `/projects/:projectId/${section}`, component, meta: { projectSection: section } },
    ]),
    { path: "/chat", component, meta: { projectSection: "chat" } },
    { path: "/projects/:projectId/chat/:groupId?", component, meta: { projectSection: "chat" } },
  ] });
  store.installRouter(router);
  return { store, router };
}

test("S6 旧入口落到真实新页面，保留显式项目、筛选、对象与 hash", async () => {
  const { store, router } = await fixture();
  for (const [entry, path, extra] of [
    ["org", "members", "organization"], ["status", "members", "status"],
    ["audit", "activity", null], ["memory", "knowledge", null], ["groups", "chat", null],
  ] as const) {
    for (const old of [`/${entry}?projectId=beta`, `/projects/beta/${entry}?projectId=alpha`]) {
      await router.push(`${old}&agentId=agent-a&filter=active#message-8`);
      assert.equal(router.currentRoute.value.path, `/projects/beta/${path}`);
      assert.equal(router.currentRoute.value.query.agentId, "agent-a");
      assert.equal(router.currentRoute.value.query.filter, "active");
      assert.equal(router.currentRoute.value.hash, "#message-8");
      assert.equal(store.currentProjectId.value, "beta");
      if (extra) assert.equal(router.currentRoute.value.query.tab, extra);
    }
  }
  store.dispose();
});

test("S6 群旧链接与项目切换保留当前成员 tab，丢弃其他项目的对象 ID", async () => {
  const { store, router } = await fixture();
  await router.push("/groups?projectId=beta&groupId=group-b&focus=message#anchor");
  assert.equal(router.currentRoute.value.path, "/projects/beta/chat/group-b");
  assert.equal(router.currentRoute.value.query.focus, "message");
  await router.push("/projects/beta/members?tab=organization");
  await store.selectProject("alpha");
  assert.equal(router.currentRoute.value.path, "/projects/alpha/members");
  assert.equal(router.currentRoute.value.query.tab, "organization");
  store.dispose();
});

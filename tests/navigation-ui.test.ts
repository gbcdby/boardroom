import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryHistory, createRouter } from "vue-router";
const contextModule = new URL("../src/web/src/composables/useCurrentProject.ts", import.meta.url).href;

async function fixture(options: { confirmDiscard?: () => boolean } = {}) {
  const { createCurrentProjectContext } = await import(contextModule);
  const store = createCurrentProjectContext({ storage: null, loadProjects: async () => [
    { id: "alpha", name: "甲", archivedAt: null }, { id: "beta", name: "乙", archivedAt: null },
  ] as never, ...options });
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

for (const scenario of [
  { label: "旧 /chat 从 query 读取项目与群组", input: "/chat?projectId=beta&groupId=query-group", project: "beta", group: "query-group" },
  { label: "显式项目缺省路径群组时回退 query 群组", input: "/projects/alpha/chat?projectId=beta&groupId=query-group", project: "alpha", group: "query-group" },
  { label: "非空路径群组优先于冲突 query 群组", input: "/projects/alpha/chat/path-group?projectId=beta&groupId=query-group", project: "alpha", group: "path-group" },
]) {
  test(`S6 群深链：${scenario.label}`, { timeout: 10000 }, async () => {
    const { store, router } = await fixture();
    try {
      const input = `${scenario.input}&filter=active#saved-anchor`;
      const rawGroup = router.resolve(input).params.groupId;
      await router.push(input);
      assert.equal(router.currentRoute.value.path, `/projects/${scenario.project}/chat/${scenario.group}`, `初次解析的可选路径 groupId 为 ${JSON.stringify(rawGroup)}`);
      assert.equal(store.currentProjectId.value, scenario.project);
      assert.equal(router.currentRoute.value.query.projectId, undefined);
      assert.equal(router.currentRoute.value.query.groupId, undefined);
      assert.equal(router.currentRoute.value.query.filter, "active");
      assert.equal(router.currentRoute.value.hash, "#saved-anchor");
    } finally { store.dispose(); }
  });
}

test("S6 群深链：query 兼容跳转仍可取消，确认后才改变群并清理草稿", { timeout: 10000 }, async () => {
  let allowLeave = false, draft = "未发送的群消息", resets = 0, prompts = 0;
  const { store, router } = await fixture({ confirmDiscard: () => { prompts++; return allowLeave; } });
  try {
    const original = "/projects/alpha/chat/original-group?filter=all#draft-anchor";
    await router.push(original);
    store.registerDraft({ isDirty: () => !!draft, reset: () => { draft = ""; resets++; } });
    const generation = store.generation.value;
    const target = "/projects/alpha/chat?projectId=beta&groupId=next-group&filter=active#next-anchor";
    await router.push(target);
    assert.equal(router.currentRoute.value.fullPath, original);
    assert.equal(store.currentProjectId.value, "alpha");
    assert.equal(store.generation.value, generation);
    assert.equal(draft, "未发送的群消息");
    assert.equal(resets, 0);
    assert.equal(prompts, 1);
    allowLeave = true;
    await router.push(target);
    assert.equal(router.currentRoute.value.fullPath, "/projects/alpha/chat/next-group?filter=active#next-anchor");
    assert.equal(store.currentProjectId.value, "alpha");
    assert.equal(store.generation.value, generation);
    assert.equal(draft, "");
    assert.equal(resets, 1);
    assert.equal(prompts, 2);
  } finally { store.dispose(); }
});

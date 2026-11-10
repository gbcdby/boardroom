import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryHistory, createRouter } from "vue-router";

const moduleUrl = new URL("../src/web/src/composables/useCurrentProject.ts", import.meta.url).href;
const projects = [
  { id: "alpha", name: "项目甲", archivedAt: null },
  { id: "beta", name: "项目乙", archivedAt: null },
  { id: "archive", name: "已归档项目", archivedAt: "2026-11-10T10:00:00Z" },
];

async function context(options: Record<string, unknown> = {}) {
  const { createCurrentProjectContext } = await import(moduleUrl);
  return createCurrentProjectContext({ loadProjects: async () => projects, ...options });
}

function navigation(store: any) {
  const component = { render: () => null };
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: "/", component },
    { path: "/projects", component },
    { path: "/runtimes", component },
    ...["overview", "org", "status", "audit", "members", "tasks"].map((section) => ({
      path: `/projects/:projectId/${section}`, component, meta: { projectSection: section },
    })),
    { path: "/projects/:projectId/chat/:groupId?", component, meta: { projectSection: "chat" } },
    { path: "/projects/:projectId/tasks/:taskId", component, meta: { projectSection: "tasks" } },
    ...["chat", "status", "org", "audit", "members", "tasks"].map((section) => ({
      path: `/${section}`, component, meta: { projectSection: section },
    })),
  ] });
  store.installRouter(router);
  return router;
}

test("共享项目：显式 URL 优先于记忆，并将旧群聊深链 replace 为规范路由", async () => {
  const storage = new Map([["agent-studio:lastProjectId", "alpha"]]);
  const store = await context({ storage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } });
  const router = navigation(store);
  await router.push("/chat?projectId=beta&groupId=group-b&focus=latest");
  assert.equal(router.currentRoute.value.path, "/projects/beta/chat/group-b");
  assert.equal(router.currentRoute.value.query.focus, "latest");
  assert.equal(router.currentRoute.value.query.projectId, undefined);
  assert.equal(store.currentProjectId.value, "beta");
  assert.equal(storage.get("agent-studio:lastProjectId"), "beta");
  await router.push("/org");
  assert.equal(router.currentRoute.value.path, "/projects/beta/org");
  store.dispose();
});

test("共享项目：取消切换不修改 URL、项目代次或草稿，确认后恰好重置一次", async () => {
  let confirmed = false;
  let draft = "尚未保存的内容";
  let resets = 0;
  const store = await context({ confirmDiscard: () => confirmed });
  const router = navigation(store);
  await router.push("/projects/alpha/tasks");
  store.registerDraft({ isDirty: () => draft !== "", reset: () => { draft = ""; resets++; } });
  const generation = store.generation.value;
  assert.equal(await store.selectProject("beta"), false);
  assert.equal(store.currentProjectId.value, "alpha");
  assert.equal(router.currentRoute.value.path, "/projects/alpha/tasks");
  assert.equal(store.generation.value, generation);
  assert.equal(draft, "尚未保存的内容");
  assert.equal(resets, 0);
  confirmed = true;
  assert.equal(await store.selectProject("beta"), true);
  assert.equal(router.currentRoute.value.path, "/projects/beta/tasks");
  assert.equal(store.currentProjectId.value, "beta");
  assert.equal(store.generation.value, generation + 1);
  assert.equal(resets, 1);
  store.dispose();
});

test("共享项目：无效 URL 有回退提示，归档显式链接只读，全归档不自动选中", async () => {
  const store = await context();
  const router = navigation(store);
  await router.push("/projects/missing/status");
  assert.equal(router.currentRoute.value.path, "/projects/alpha/status");
  assert.match(store.notice.value, /项目不存在或无权访问，已切换到项目甲/);
  await router.push("/projects/archive/tasks");
  assert.equal(store.readonly.value, true);
  assert.equal(store.currentProjectId.value, "archive");
  store.dispose();
  const archived = await context({ loadProjects: async () => [projects[2]], storage: { getItem: () => "archive", setItem() {} } });
  const emptyRouter = navigation(archived);
  await emptyRouter.push("/tasks");
  assert.equal(archived.currentProjectId.value, null);
  assert.equal(emptyRouter.currentRoute.value.path, "/projects");
  archived.dispose();
});

test("共享项目：路由前进后退也受草稿保护，任务详情切项目返回目标任务板", async () => {
  let confirmed = true;
  let dirty = false;
  const store = await context({ confirmDiscard: () => confirmed });
  const router = navigation(store);
  await router.push("/projects/alpha/tasks/task-a");
  store.registerDraft({ isDirty: () => dirty, reset: () => { dirty = false; } });
  dirty = true;
  confirmed = false;
  await router.push("/projects/beta/tasks");
  assert.equal(router.currentRoute.value.path, "/projects/alpha/tasks/task-a");
  assert.equal(store.currentProjectId.value, "alpha");
  confirmed = true;
  await store.selectProject("beta");
  assert.equal(router.currentRoute.value.path, "/projects/beta/tasks");
  store.dispose();
});

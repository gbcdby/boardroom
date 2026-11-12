import test from "node:test";
import assert from "node:assert/strict";
import { byTestId, deferred, find, json, settle, textOf, withPage, type UiElement } from "./helpers/web-ui.ts";

const moduleUrl = new URL("../src/web/src/composables/useTaskListViewState.ts", import.meta.url).href;
const projects = ["a", "b"].map(id => ({ id, name: `滚动项目${id}`, manager: null, archivedAt: null }));
const tasks = Array.from({ length: 20 }, (_, index) => ({ id: `task-${index}`, projectId: "a", title: `长列表任务 ${index}`, body: "验收条件", labels: [], state: "todo", assigneeMemberId: null, reviewerMemberId: null, blockedReason: null }));
const saved = { left: 0, top: 1200 };
function rowCount(node: UiElement): number {
  return (typeof node.props.class === "string" && node.props.class.split(" ").includes("task-list-item") ? 1 : 0) + node.children.reduce((total, child) => total + rowCount(child), 0);
}

async function returningList(check: (container: UiElement, context: Parameters<Parameters<typeof withPage>[2]>[1], held: ReturnType<typeof deferred<Response>>, scroll: any) => Promise<void>) {
  const held = deferred<Response>(); let reads = 0;
  await withPage("TasksView", url => {
    if (url.endsWith("/a/tasks")) { reads++; return reads === 1 ? json({ tasks }) : held.promise; }
    if (url.endsWith("/b/tasks")) return json({ tasks: [] });
    if (url.endsWith("/task-settings")) return json({ settings: { projectId: url.includes("/b/") ? "b" : "a", defaultReviewerMemberId: null, reviewerValid: false, revision: 1 } });
    if (url.endsWith("/org")) return json({ nodes: [], members: [], roles: [] });
    return json({ projects });
  }, async (container, context) => {
    const { router, store } = context;
    try {
      byTestId(container, "task-list-mode").props.onClick(); await settle();
      assert.equal(rowCount(container), 20);
      await router.push("/projects/a/tasks/task-0"); await settle();
      const back = new Promise<void>(resolve => {
        const stop = router.afterEach(to => { if (to.path === "/projects/a/tasks") { stop(); resolve(); } });
      });
      router.back(); await back; await settle();
      assert.equal(rowCount(container), 0);
      assert.match(textOf(container), /正在加载任务/);
      const { createTaskListScrollBehavior } = await import(moduleUrl);
      const scroll = createTaskListScrollBehavior(store, () => router.currentRoute.value);
      await check(container, context, held, scroll);
    } finally { held.resolve(json({ tasks })); await settle(); }
  }, { path: "/projects/a/tasks", renderRoute: "/projects/:projectId/tasks" });
}

test("长任务列表返回：saved position 等到二十行 DOM 就绪再交给 Router", { timeout: 20000 }, async () => {
  await returningList(async (container, { router }, held, scroll) => {
    const observed: Array<{ position: unknown; rows: number; loading: boolean }> = [];
    const target = router.currentRoute.value;
    const pending = Promise.resolve(scroll(target, target, saved)).then(position => {
      observed.push({ position, rows: rowCount(container), loading: /正在加载任务/.test(textOf(container)) });
      return position;
    });
    await settle();
    assert.equal(observed.length, 0, `不得在空列表阶段返回坐标：${JSON.stringify(observed)}`);
    held.resolve(json({ tasks }));
    assert.deepEqual(await pending, saved);
    assert.deepEqual(observed, [{ position: saved, rows: 20, loading: false }]);
  });
});

for (const direction of ["detail", "project", "query"] as const) {
  test(`长任务列表返回：等待期间 ${direction} 导航取消旧恢复`, { timeout: 20000 }, async () => {
    await returningList(async (_container, { router, store }, held, scroll) => {
      const target = router.currentRoute.value;
      const pending = Promise.resolve(scroll(target, target, saved));
      if (direction === "detail") await router.push("/projects/a/tasks/task-1");
      else if (direction === "project") await store.selectProject("b");
      else await router.replace("/projects/a/tasks?view-marker=new-route");
      await settle();
      assert.equal(await pending, false, "取消不依赖旧接口完成，也不能将旧位置交给新页面");
      held.resolve(json({ tasks })); await settle();
      assert.notEqual(router.currentRoute.value, target);
    });
  });
}

for (const outcome of ["empty", "error"] as const) {
  test(`长任务列表返回：${outcome} 终态也结束就绪等待`, { timeout: 20000 }, async () => {
    await returningList(async (container, { router }, held, scroll) => {
      const target = router.currentRoute.value;
      const pending = Promise.resolve(scroll(target, target, saved));
      held.resolve(outcome === "empty" ? json({ tasks: [] }) : json({ error: { code: "unavailable", message: "列表暂不可用" } }, 503));
      assert.deepEqual(await pending, saved);
      assert.doesNotMatch(textOf(container), /正在加载任务/);
      assert.equal(rowCount(container), 0);
      if (outcome === "error") assert.match(textOf(byTestId(container, "task-error")), /列表暂不可用/);
      else assert.match(textOf(container), /从一项明确的任务开始/);
    });
  });
}

test("长任务列表返回：普通新导航与 hash 路由保留原滚动规则", { timeout: 20000 }, async () => {
  await returningList(async (_container, { router }, _held, scroll) => {
    const target = router.currentRoute.value;
    assert.deepEqual(await scroll(target, target, null), { top: 0 });
    const hash = { ...target, hash: "#task-list" };
    assert.deepEqual(await scroll(hash, target, null), { el: "#task-list", top: 24 });
    assert.equal(!!find(_container, node => node.props["data-testid"] === "task-board"), true);
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import { byTestId, deferred, find, input, json, select, settle, submit, textOf, withPage, type UiElement } from "./helpers/web-ui.ts";
import { useToast } from "../src/web/src/composables/useToast.ts";

const projects = ["a", "b"].map(id => ({ id, name: `项目${id}`, archivedAt: null, manager: null }));
const author = { kind: "human", actorId: "human:local", displayName: "本地用户" };
const materialStatus = { scope: "task-materials", executionAdmission: "not-issued", startExecution: { reasonCodes: [], issues: [] }, submitReview: { reasonCodes: [], issues: [] }, complete: { reasonCodes: [], issues: [] } };
const task = (projectId: string, id = `task-${projectId}`) => ({ id, projectId, title: `任务${id}`, body: "验收条件", deliveryKind: "code", acceptanceText: "验收条件", acceptanceSource: "legacy_task_body", materialStatus, labels: [], state: "todo", assigneeMemberId: `${projectId}-worker`, reviewerMemberId: `${projectId}-reviewer`, repoPath: null, fixedPoint: null, revision: 1, currentReviewRoundId: null, blockedReason: null, author, createdAt: "2026-11-12T00:00:00Z", updatedAt: "2026-11-12T00:00:00Z" });
const taskSettings = (projectId: string) => ({ projectId, defaultReviewerMemberId: `${projectId}-reviewer`, reviewerValid: true, invalidReason: null, revision: 1 });
const org = (projectId: string) => ({
  nodes: [{ id: `root-${projectId}`, name: `项目${projectId}统筹`, role: "top_manager", parentId: null, memberId: null, memberDisplayName: null }],
  members: ["worker", "reviewer"].map(kind => ({ id: `${projectId}-${kind}`, projectId, displayName: `${projectId}-${kind}`, kind: "agent", status: "active", role: "normal", nodeId: null })),
  roles: [{ role: "top_manager", nodeRole: true, capabilities: [] }, { role: "member", nodeRole: true, capabilities: [] }],
});
function read(url: string) {
  const projectId = url.includes("/projects/b/") ? "b" : "a";
  if (url.endsWith("/org")) return json(org(projectId));
  if (url.endsWith("/task-settings")) return json({ settings: taskSettings(projectId) });
  if (url.endsWith("/tasks")) return json({ tasks: [] });
  return json({ projects });
}
function orgName(container: UiElement): UiElement {
  const result = find(container, node => node.props["aria-label"] === "新岗位名称");
  assert.ok(result); return result;
}
function selectedValue(control: UiElement): unknown { return control.options[control.selectedIndex]?.value; }

for (const kind of ["create", "reviewer"] as const) {
  test(`任务板作用域：挂起${kind}切换后新项目可写，旧回包不能释放新请求`, { timeout: 20000 }, async () => {
    useToast().clear();
    const old = deferred<Response>(), next = deferred<Response>();
    const writes = { a: 0, b: 0 };
    let allowLeave = false, prompts = 0;
    let first: Promise<void> | undefined, second: Promise<void> | undefined;
    const result = (id: "a" | "b") => kind === "create" ? json({ task: { ...task(id), title: `新任务${id}` } }, 201) : json({ settings: { ...taskSettings(id), defaultReviewerMemberId: `${id}-worker`, revision: 2 } });
    await withPage("TasksView", (url, init) => {
      if (init?.method === (kind === "create" ? "POST" : "PUT")) {
        const id = url.includes("/projects/b/") ? "b" : "a";
        writes[id]++; return id === "a" ? old.promise : next.promise;
      }
      return read(url);
    }, async (container, { store, router }) => {
      const prepare = async (id: "a" | "b") => {
        if (kind === "reviewer") { await select(byTestId(container, "task-default-reviewer"), `${id}-worker`); return byTestId(container, "task-save-settings"); }
        byTestId(container, "task-create-open").props.onClick(); await settle();
        await input(byTestId(container, "task-title"), `新任务${id}`);
        await select(byTestId(container, "task-assignee"), `${id}-worker`);
        return byTestId(container, "task-create");
      };
      try {
        first = submit(await prepare("a")); await settle();
        assert.equal(writes.a, 1);
        assert.equal(await store.selectProject("b"), false);
        assert.equal(router.currentRoute.value.path, "/projects/a/tasks");
        assert.equal(prompts, 1, "取消切换必须经过草稿确认");
        assert.equal(byTestId(container, "task-create-open").props.disabled, true);
        if (kind === "create") assert.equal(byTestId(container, "task-title").value, "新任务a");
        allowLeave = true;
        assert.equal(await store.selectProject("b"), true); await settle();
        assert.equal(byTestId(container, "task-create-open").props.disabled, false, "旧项目请求不能锁住新项目");
        assert.equal(byTestId(container, "task-default-reviewer").props.disabled, false);
        const submitNext = await prepare("b");
        second = submit(submitNext); await settle();
        assert.equal(writes.b, 1);
        old.resolve(result("a")); await first; await settle();
        assert.equal(byTestId(container, "task-create-open").props.disabled, true, "旧 finally 不能释放新项目写入锁");
        assert.equal(byTestId(container, "task-default-reviewer").props.disabled, true);
        assert.equal(!!find(container, node => node.props["data-testid"] === "task-notice"), false);
        assert.equal(useToast().items.value.length, 0, "旧作用域回执不能发出成功 Toast");
        assert.doesNotMatch(textOf(byTestId(container, "task-board")), /新任务a/);
        await submit(submitNext); assert.equal(writes.b, 1, "新请求进行中仍需阻止重复提交");
        next.resolve(result("b")); await second; await settle();
        assert.equal(byTestId(container, "task-create-open").props.disabled, false);
        assert.equal(byTestId(container, "task-default-reviewer").props.disabled, false);
        if (kind === "create") assert.match(useToast().items.value.at(-1)?.message ?? "", /新任务b/);
        else assert.match(textOf(byTestId(container, "task-notice")), /默认 reviewer 已保存/);
      } finally { old.resolve(result("a")); next.resolve(result("b")); await Promise.allSettled([first, second]); }
    }, { path: "/projects/a/tasks", confirmDiscard: () => { prompts++; return allowLeave; } });
  });
}

for (const kind of ["comment", "action"] as const) {
  test(`任务详情作用域：挂起${kind}切任务后可写，迟到回包不能改变当前请求`, { timeout: 20000 }, async () => {
    useToast().clear();
    const old = deferred<Response>(), next = deferred<Response>();
    let allowLeave = false, writes = 0;
    let first: Promise<void> | undefined, second: Promise<void> | undefined;
    await withPage("TaskDetailView", (url, init) => {
      if (init?.method === "POST") { writes++; return writes === 1 ? old.promise : next.promise; }
      const match = url.match(/\/tasks\/(task-[12])$/);
      if (match) return json({ task: task("a", match[1]), comments: [], history: [], rounds: [], reports: [], messageLinks: [] });
      return read(url);
    }, async (container, { router }) => {
      const field = kind === "comment" ? "task-comment-body" : "task-transition-reason";
      const start = () => kind === "comment" ? submit(byTestId(container, "task-comment-send")) : Promise.resolve(byTestId(container, "task-start").props.onClick());
      try {
        await input(byTestId(container, field), "第一份正在提交的草稿");
        first = start(); await settle(); assert.equal(writes, 1);
        await router.push("/projects/a/tasks/task-2"); await settle();
        assert.equal(router.currentRoute.value.params.taskId, "task-1");
        assert.equal(byTestId(container, field).value, "第一份正在提交的草稿");
        assert.equal(byTestId(container, "task-edit-open").props.disabled, true);
        allowLeave = true;
        await router.push("/projects/a/tasks/task-2"); await settle();
        assert.equal(byTestId(container, "task-edit-open").props.disabled, false, "切换任务后不能继承旧任务 busy");
        assert.equal(byTestId(container, "task-start").props.disabled, false);
        if (kind === "comment") {
          await router.push("/projects/a/tasks/task-1"); await settle();
          assert.equal(byTestId(container, "task-edit-open").props.disabled, false, "同项目 A→B→A 也是新的页面作用域");
        }
        await input(byTestId(container, field), "新作用域的提交内容");
        second = start(); await settle(); assert.equal(writes, 2);
        old.resolve(json({ task: task("a", "task-1") })); await first; await settle();
        assert.equal(byTestId(container, "task-edit-open").props.disabled, true, "旧 scope finally 不能清新请求 busy");
        assert.equal(byTestId(container, field).value, "新作用域的提交内容", "旧 saved 回调不能清新草稿");
        assert.equal(!!find(container, node => node.props["data-testid"] === "task-notice"), false);
        assert.equal(useToast().items.value.length, 0, "旧任务回执不能发出成功 Toast");
        await start(); assert.equal(writes, 2);
        next.resolve(json({ task: task("a", "task-2") })); await second; await settle();
        assert.equal(byTestId(container, "task-edit-open").props.disabled, false);
        assert.equal(byTestId(container, field).value, "");
        assert.match(useToast().items.value.at(-1)?.message ?? "", kind === "comment" ? /评论已保存/ : /任务已进入进行中/);
      } finally { old.resolve(json({})); next.resolve(json({})); await Promise.allSettled([first, second]); }
    }, { path: "/projects/a/tasks/task-1", confirmDiscard: () => allowLeave });
  });
}

test("任务详情作用域：旧任务的载入最新结果不能给新任务写入提示", { timeout: 20000 }, async () => {
  useToast().clear();
  const reload = deferred<Response>(); let reads = 0;
  let pending: Promise<void> | undefined;
  const detail = (id: string) => json({ task: task("a", id), comments: [], history: [], rounds: [], reports: [], messageLinks: [] });
  await withPage("TaskDetailView", (url, init) => {
    if (init?.method === "PATCH") return json({ error: { code: "conflict", message: "任务已变更" } }, 409);
    if (url.endsWith("/tasks/task-1")) { reads++; return reads === 1 ? detail("task-1") : reload.promise; }
    if (url.endsWith("/tasks/task-2")) return detail("task-2");
    return read(url);
  }, async (container, { router }) => {
    try {
      byTestId(container, "task-edit-open").props.onClick(); await settle();
      await input(byTestId(container, "task-title"), "A仍未保存的修改");
      await submit(byTestId(container, "task-save")); await settle();
      pending = byTestId(container, "task-reload").props.onClick(); await settle();
      await router.push("/projects/a/tasks/task-2"); await settle();
      reload.resolve(detail("task-1")); await pending; await settle();
      assert.equal(router.currentRoute.value.params.taskId, "task-2");
      assert.equal(!!find(container, node => node.props["data-testid"] === "task-notice"), false);
      assert.equal(!!find(container, node => node.props["data-testid"] === "task-conflict"), false);
      assert.equal(byTestId(container, "task-edit-open").props.disabled, false);
    } finally { reload.resolve(detail("task-1")); await Promise.allSettled([pending]); }
  }, { path: "/projects/a/tasks/task-1" });
});

test("组织作用域：旧项目读取失败不能覆盖新项目错误或提前结束新项目加载", { timeout: 20000 }, async () => {
  const old = deferred<Response>(), next = deferred<Response>();
  await withPage("OrgView", url => url.endsWith("/a/org") ? old.promise : url.endsWith("/b/org") ? next.promise : read(url), async (container, { store }) => {
    try {
      await store.selectProject("b"); await settle();
      old.resolve(json({ error: { code: "read_failed", message: "项目A读取失败" } }, 503)); await settle();
      assert.equal(!!find(container, node => node.props["data-testid"] === "error"), false, "旧读取失败不能写入新项目");
      assert.match(textOf(container), /正在加载组织信息/, "旧 finally 不能提前关闭 B 的加载状态");
      next.resolve(json(org("b"))); await settle();
      assert.match(textOf(container), /项目b统筹/);
      assert.equal(orgName(container).props.disabled, false);
      assert.doesNotMatch(textOf(container), /项目A读取失败|正在加载组织信息/);
    } finally { old.resolve(json(org("a"))); next.resolve(json(org("b"))); await settle(); }
  }, { path: "/projects/a/members?tab=organization" });
});

test("组织作用域：旧项目写入失败不污染新项目或释放新写入锁", { timeout: 20000 }, async () => {
  const old = deferred<Response>(), next = deferred<Response>();
  let first: Promise<void> | undefined, second: Promise<void> | undefined;
  let writes = 0;
  await withPage("OrgView", (url, init) => {
    if (init?.method === "POST") { writes++; return url.includes("/a/") ? old.promise : next.promise; }
    return read(url);
  }, async (container, { store }) => {
    try {
      await input(orgName(container), "A待创建岗位"); first = submit(orgName(container)); await settle();
      await store.selectProject("b"); await settle();
      assert.equal(orgName(container).props.disabled, false, "新项目不能继承旧项目写入锁");
      await input(orgName(container), "B待创建岗位"); second = submit(orgName(container)); await settle();
      assert.equal(writes, 2);
      old.resolve(json({ error: { code: "conflict", message: "项目A岗位写入失败" } }, 409)); await first; await settle();
      assert.equal(!!find(container, node => node.props["data-testid"] === "error"), false);
      assert.equal(orgName(container).props.disabled, true, "旧 mutation finally 不能释放 B 的写入锁");
      assert.equal(orgName(container).value, "B待创建岗位");
      next.resolve(json({ error: { code: "conflict", message: "项目B岗位写入失败" } }, 409)); await second; await settle();
      assert.equal(orgName(container).props.disabled, false);
      assert.equal(orgName(container).value, "B待创建岗位");
      assert.match(textOf(byTestId(container, "error")), /项目B岗位写入失败/);
    } finally { old.resolve(json({})); next.resolve(json({})); await Promise.allSettled([first, second]); }
  }, { path: "/projects/a/members?tab=organization" });
});

test("组织作用域：旧项目写后刷新失败不能清新项目草稿或显示旧错误", { timeout: 20000 }, async () => {
  const lateRefresh = deferred<Response>(); let refreshing = false;
  let first: Promise<void> | undefined;
  await withPage("OrgView", (url, init) => {
    if (init?.method === "POST") { refreshing = true; return json({ node: org("a").nodes[0] }, 201); }
    if (url.endsWith("/a/org") && refreshing) return lateRefresh.promise;
    return read(url);
  }, async (container, { store }) => {
    try {
      await input(orgName(container), "A已写入的岗位"); first = submit(orgName(container)); await settle();
      assert.equal(refreshing, true);
      await store.selectProject("b"); await settle();
      assert.equal(orgName(container).props.disabled, false);
      await input(orgName(container), "B仍未提交的岗位");
      lateRefresh.resolve(json({ error: { code: "read_failed", message: "A写后读取失败" } }, 503)); await first; await settle();
      assert.equal(orgName(container).value, "B仍未提交的岗位");
      assert.equal(!!find(container, node => node.props["data-testid"] === "error"), false);
      assert.equal(orgName(container).props.disabled, false);
    } finally { lateRefresh.resolve(json(org("a"))); await Promise.allSettled([first]); }
  }, { path: "/projects/a/members?tab=organization" });
});

test("任务列表返回：真实 RouterView 卸载重建恢复筛选布局，项目间隔离且草稿取消有效", { timeout: 20000 }, async () => {
  let allowLeave = false, prompts = 0;
  await withPage("TasksView", read, async (container, { store, router }) => {
    await select(byTestId(container, "task-state-filter"), "blocked");
    byTestId(container, "task-list-mode").props.onClick(); await settle();
    byTestId(container, "task-create-open").props.onClick(); await settle();
    await input(byTestId(container, "task-title"), "尚未创建的内容");
    await select(byTestId(container, "task-state-filter"), "done");
    assert.equal(prompts, 0, "只改变列表展示状态不能要求丢弃创建草稿");
    assert.equal(byTestId(container, "task-title").value, "尚未创建的内容");
    await select(byTestId(container, "task-state-filter"), "blocked");
    await router.push("/projects/a/tasks/task-a"); await settle();
    assert.equal(router.currentRoute.value.path, "/projects/a/tasks");
    assert.equal(byTestId(container, "task-title").value, "尚未创建的内容");
    assert.equal(prompts, 1);
    allowLeave = true;
    await router.push("/projects/a/tasks/task-a"); await settle();
    assert.equal(!!find(container, node => node.props["data-testid"] === "task-board"), false, "必须真的卸载列表组件");
    router.back(); await settle();
    assert.equal(router.currentRoute.value.path, "/projects/a/tasks");
    assert.equal(selectedValue(byTestId(container, "task-state-filter")), "blocked");
    assert.equal(byTestId(container, "task-list-mode").props["aria-pressed"], true);
    assert.equal(!!find(container, node => node.props["data-testid"] === "task-title"), false, "已确认离开的创建草稿不会被列表缓存恢复");
    await store.selectProject("b"); await settle();
    assert.equal(selectedValue(byTestId(container, "task-state-filter")), "");
    assert.equal(byTestId(container, "task-list-mode").props["aria-pressed"], false);
    await select(byTestId(container, "task-state-filter"), "done");
    await store.selectProject("a"); await settle();
    assert.equal(selectedValue(byTestId(container, "task-state-filter")), "blocked");
    assert.equal(byTestId(container, "task-list-mode").props["aria-pressed"], true);
  }, { path: "/projects/a/tasks", renderRoute: "/projects/:projectId/tasks", confirmDiscard: () => { prompts++; return allowLeave; } });
});

import test from "node:test";
import assert from "node:assert/strict";
import { byTestId, deferred, find, input, json, select, settle, submit, textOf, withPage, type UiElement } from "./helpers/web-ui.ts";

test("当前项目可添加另一个项目已有的全局 Runtime，提交同一身份与CAS而不切项目", async () => {
  const projects = [{ id: "project-a", name: "项目 A", archivedAt: null }, { id: "project-b", name: "项目 B", archivedAt: null }];
  const runtime = { id: "runtime-1", name: "共享助手", backend: "claude-code", revision: 7,
    defaults: { model: null, workdir: "/work", tools: null, systemPrompt: "", permissionMode: "auto" } };
  const binding = (projectId: string, groupId: string) => ({ runtime,
    binding: { id: `binding-${projectId}`, projectId, groupId, desiredState: "stopped", revision: 1, advanced: null },
    runner: { state: "stopped", phase: "unknown", permissionObserved: "unknown", exitConfirmed: true, applied: null },
    effective: { config: runtime.defaults }, pendingChanges: false,
    status: { summary: "stopped", reason: null, member: null, capability: null },
  });
  const bindings = [binding("project-a", "group-a")];
  const writes: { url: string; body: Record<string, unknown> }[] = [];
  const globals = globalThis as any;
  const previousDocument = globals.document;
  globals.document = { getElementById: () => null, hidden: false };
  try {
    await withPage("RuntimesView", (url, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)); writes.push({ url, body });
        const created = binding(body.projectId, body.groupId); bindings.push(created);
        return json({ binding: created }, 201);
      }
      if (url === "/api/runtimes") return json({ runtimes: [{ runtime, bindings }] });
      if (url.includes("/groups")) return json({ groups: [{ id: url.includes("project-a") ? "group-a" : "group-b", name: "协作群", archivedAt: null }] });
      return json({ projects });
    }, async (container, { store }) => {
      assert.equal(store.currentProjectId.value, "project-b");
      await byTestId(container, "runtime-reuse-open").props.onClick();
      await settle();
      assert.match(textOf(byTestId(container, "runtime-existing-select")), /共享助手/);
      await submit(byTestId(container, "runtime-add-binding"));
      await settle();
      assert.deepEqual(writes, [{ url: "/api/runtimes/runtime-1/bindings", body: {
        projectId: "project-b", groupId: "group-b", expectedRuntimeRevision: 7,
      } }]);
      assert.equal(store.currentProjectId.value, "project-b");
      assert.match(textOf(container), /共享助手/);
      assert.match(textOf(byTestId(container, "runtime-notice")), /保持停止/);
    }, { path: "/runtimes?projectId=project-b" });
  } finally { if (previousDocument === undefined) delete globals.document; else globals.document = previousDocument; }
});

const scopeProjects = [{ id: "project-a", name: "项目 A", archivedAt: null as string | null }, { id: "project-b", name: "项目 B", archivedAt: null as string | null }];
function scopeRuntime(id: string, projectId: string) {
  const runtime = { id, name: `助手 ${projectId}`, backend: "claude-code", revision: 7,
    defaults: { model: null, workdir: "/work", tools: null, systemPrompt: "", permissionMode: "auto" } };
  return { runtime, bindings: [{ runtime,
    binding: { id: `binding-${id}`, projectId, groupId: `group-${projectId}`, desiredState: "stopped", revision: 1, intentRevision: 3, overrides: {}, advanced: null },
    runner: { state: "stopped", phase: "unknown", permissionObserved: "unknown", exitConfirmed: true, applied: null },
    effective: { config: runtime.defaults }, pendingChanges: false,
    status: { summary: "stopped", reason: null, member: null, capability: null },
  }] };
}
type ScopeContext = Parameters<Parameters<typeof withPage>[2]>[1];
async function withScopePage(check: (container: UiElement, context: ScopeContext, writes: Array<{ url: string; body: any }>) => Promise<void>, options: {
  path?: string; archivedA?: boolean; confirmDiscard?: () => boolean;
  respond?: (url: string, init: RequestInit | undefined) => Response | Promise<Response> | undefined;
} = {}) {
  const entries = [scopeRuntime("runtime-a", "project-a"), scopeRuntime("runtime-b", "project-b")];
  const writes: Array<{ url: string; body: any }> = [];
  const globals = globalThis as any, previousDocument = globals.document;
  globals.document = { getElementById: () => null, hidden: true };
  try {
    await withPage("RuntimesView", (url, init) => {
      if (init?.method && init.method !== "GET") writes.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
      const response = options.respond?.(url, init); if (response) return response;
      if (url.startsWith("/api/projects?")) return json({ projects: scopeProjects.map(p => ({ ...p, archivedAt: options.archivedA && p.id === "project-a" ? "2026-11-12" : null })) });
      if (url.includes("/groups")) {
        const projectId = url.includes("project-a") ? "project-a" : "project-b";
        return json({ groups: ["", "-extra"].map(suffix => ({ id: `group-${projectId}${suffix}`, projectId, name: `群 ${projectId}${suffix}`, archivedAt: null })) });
      }
      if (url === "/api/runtimes" && init?.method === "GET") return json({ runtimes: entries });
      return json({ runtime: entries[0], binding: entries[0]!.bindings[0] }, 201);
    }, async (container, context) => {
      context.router.addRoute({ path: "/collaboration/connections", component: { render: () => null } });
      await check(container, context, writes);
    }, { path: options.path ?? "/runtimes", ...(options.confirmDiscard ? { confirmDiscard: options.confirmDiscard } : {}) });
  } finally { if (previousDocument === undefined) delete globals.document; else globals.document = previousDocument; }
}

test("S6-002：连接页无显式筛选时显示全部项目实例，不按记忆项目隐式过滤", async () => {
  await withScopePage(async (container, { store, router }) => {
    assert.equal(store.currentProjectId.value, "project-a");
    await router.replace("/collaboration/connections"); await settle();
    assert.ok(find(container, node => node.props["data-binding-id"] === "binding-runtime-a"));
    assert.ok(find(container, node => node.props["data-binding-id"] === "binding-runtime-b"), "乙项目实例必须在全局入口可见");
    assert.equal(byTestId(container, "runtime-project-filter").props.value, "");
    assert.equal(byTestId(container, "runtime-group-filter").props.value, "");
  });
});

test("S6-002：项目/群范围显式可选并清空，保留其他query/hash；群单独深链可见可清除", async () => {
  await withScopePage(async (container, { router }) => {
    assert.equal(byTestId(container, "runtime-group-filter").props.value, "group-project-b");
    assert.match(textOf(byTestId(container, "runtime-group-filter")), /项目 B/);
    await select(byTestId(container, "runtime-project-filter"), "project-a"); await settle();
    assert.equal(router.currentRoute.value.query.projectId, "project-a");
    assert.equal(router.currentRoute.value.query.groupId, undefined);
    assert.equal(router.currentRoute.value.query.focus, "latest"); assert.equal(router.currentRoute.value.hash, "#details");
    assert.equal(find(container, node => node.props["data-binding-id"] === "binding-runtime-b"), undefined);
    await byTestId(container, "runtime-scope-clear").props.onClick(); await settle();
    assert.equal(router.currentRoute.value.query.projectId, undefined);
    assert.equal(router.currentRoute.value.query.groupId, undefined);
    assert.ok(find(container, node => node.props["data-binding-id"] === "binding-runtime-b"));
  }, { path: "/runtimes?groupId=group-project-b&focus=latest#details" });
});

function selectedValue(control: UiElement): unknown { return control.options.find(option => option.selected)?.value; }
async function fillCreate(container: UiElement, name: string): Promise<void> {
  await input(byTestId(container, "runtime-name"), name);
  const workdir = find(container, node => node.props.id === "runtime-create-workdir");
  assert.ok(workdir);
  workdir.props.onInput({ target: { value: "/work" } });
  await settle();
}

test("S6-002：全局创建必须显式选绑定项目，不改变记忆项目；显式深链可预填项目和群", async () => {
  await withScopePage(async (container, { store, router }, writes) => {
    await byTestId(container, "open-runtime-create").props.onClick(); await settle();
    assert.equal(selectedValue(byTestId(container, "runtime-create-project")), "");
    assert.equal(byTestId(container, "runtime-create").props.disabled, true);
    assert.doesNotMatch(textOf(container), /顶栏选择项目/);
    await select(byTestId(container, "runtime-create-project"), "project-b");
    await fillCreate(container, "乙项目助手");
    assert.equal(selectedValue(byTestId(container, "runtime-create-group")), "group-project-b");
    assert.equal(byTestId(container, "runtime-create").props.disabled, false);
    await submit(byTestId(container, "runtime-create")); await settle();
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.url, "/api/runtimes");
    assert.equal(writes[0]!.body.name, "乙项目助手");
    assert.deepEqual(writes[0]!.body.bindings, [{ projectId: "project-b", groupId: "group-project-b" }]);
    assert.equal(store.currentProjectId.value, "project-a");
    assert.equal(router.currentRoute.value.query.projectId, undefined);

    await router.push("/collaboration/connections?projectId=project-b&groupId=group-project-b-extra"); await settle();
    await byTestId(container, "open-runtime-create").props.onClick(); await settle();
    assert.equal(selectedValue(byTestId(container, "runtime-create-project")), "project-b");
    assert.equal(selectedValue(byTestId(container, "runtime-create-group")), "group-project-b-extra");
  });
});

test("S6-002：全局添加已有 Agent 显式选目标项目，复用同一 Runtime 与 CAS", async () => {
  await withScopePage(async (container, { store }, writes) => {
    await byTestId(container, "runtime-reuse-open").props.onClick(); await settle();
    assert.equal(selectedValue(byTestId(container, "runtime-binding-project")), "");
    assert.equal(byTestId(container, "runtime-add-binding").props.disabled, true);
    await select(byTestId(container, "runtime-binding-project"), "project-b"); await settle();
    assert.equal(selectedValue(byTestId(container, "runtime-existing-select")), "runtime-a");
    assert.equal(selectedValue(byTestId(container, "runtime-binding-group")), "group-project-b");
    await submit(byTestId(container, "runtime-add-binding")); await settle();
    assert.deepEqual(writes, [{ url: "/api/runtimes/runtime-a/bindings", body: {
      projectId: "project-b", groupId: "group-project-b", expectedRuntimeRevision: 7,
    } }]);
    assert.equal(store.currentProjectId.value, "project-a");
  });
});

test("S6-002：记忆中的归档项目不锁住全局操作；绑定按自身真实项目只读", async () => {
  await withScopePage(async (container, { store, router }, writes) => {
    assert.equal(store.currentProjectId.value, "project-a");
    assert.equal(byTestId(container, "open-runtime-create").props.disabled, true);
    await router.push("/collaboration/connections"); await settle();
    assert.equal(store.currentProjectId.value, "project-a");
    assert.equal(byTestId(container, "open-runtime-create").props.disabled, false);
    const archived = find(container, node => node.props["data-binding-id"] === "binding-runtime-a");
    const active = find(container, node => node.props["data-binding-id"] === "binding-runtime-b");
    assert.ok(archived); assert.ok(active);
    assert.equal(byTestId(archived, "runtime-start").props.disabled, true);
    assert.equal(byTestId(active, "runtime-start").props.disabled, false);
    await byTestId(active, "runtime-start").props.onClick(); await settle();
    assert.deepEqual(writes, [{ url: "/api/runtime-bindings/binding-runtime-b/actions", body: {
      action: "start", expectedIntentRevision: 3, runtimeRevision: 7, bindingRevision: 1,
    } }]);
    await byTestId(container, "open-runtime-create").props.onClick(); await settle();
    const projectControl = byTestId(container, "runtime-create-project");
    assert.equal(projectControl.options.find(option => option.value === "project-a")?.props.disabled, true);
    await select(projectControl, "project-b");
    assert.equal(byTestId(container, "runtime-create").props.disabled, false);
  }, { path: "/runtimes?projectId=project-a", archivedA: true });
});

test("S6-002：取消范围切换保留 URL、控件值和创建草稿；确认后清空旧草稿", async () => {
  let allow = false, prompts = 0;
  await withScopePage(async (container, { router }, writes) => {
    await byTestId(container, "open-runtime-create").props.onClick(); await settle();
    await fillCreate(container, "保留的草稿");
    const projectFilter = byTestId(container, "runtime-project-filter");
    await select(projectFilter, "project-b"); await settle();
    assert.equal(prompts, 1);
    assert.equal(router.currentRoute.value.query.projectId, "project-a");
    assert.equal(projectFilter.value, "project-a");
    assert.equal(byTestId(container, "runtime-name").value, "保留的草稿");
    const groupFilter = byTestId(container, "runtime-group-filter");
    await select(groupFilter, "group-project-a-extra"); await settle();
    assert.equal(prompts, 2);
    assert.equal(router.currentRoute.value.query.groupId, undefined);
    assert.equal(groupFilter.value, "");
    await byTestId(container, "runtime-scope-clear").props.onClick(); await settle();
    assert.equal(prompts, 3); assert.equal(router.currentRoute.value.query.projectId, "project-a");
    assert.equal(byTestId(container, "runtime-name").value, "保留的草稿");
    assert.deepEqual(writes, []);
    allow = true;
    await select(projectFilter, "project-b"); await settle();
    assert.equal(router.currentRoute.value.query.projectId, "project-b");
    assert.equal(find(container, node => node.props["data-testid"] === "runtime-create-form"), undefined);
    await byTestId(container, "open-runtime-create").props.onClick(); await settle();
    assert.equal(byTestId(container, "runtime-name").value, "");
    assert.equal(selectedValue(byTestId(container, "runtime-create-project")), "project-b");
  }, { path: "/runtimes?projectId=project-a", confirmDiscard: () => { prompts++; return allow; } });
});

for (const oldResult of ["success", "error"] as const) {
  test(`S6-002：旧范围创建${oldResult === "success" ? "成功" : "失败"}不会关闭新表单、污染错误或释放新请求 busy`, async () => {
    const first = deferred<Response>(), second = deferred<Response>();
    let posts = 0;
    await withScopePage(async (container, { router }) => {
      await byTestId(container, "open-runtime-create").props.onClick(); await settle();
      await fillCreate(container, "甲项目旧请求");
      const oldSave = submit(byTestId(container, "runtime-create")); await settle();
      assert.equal(posts, 1);
      await router.push("/collaboration/connections?projectId=project-b"); await settle();
      await byTestId(container, "open-runtime-create").props.onClick(); await settle();
      await fillCreate(container, "乙项目新请求");
      const newSave = submit(byTestId(container, "runtime-create")); await settle();
      assert.equal(posts, 2);
      first.resolve(oldResult === "success" ? json({ runtime: {} }, 201) : json({ error: "旧甲项目请求失败" }, 500));
      await oldSave; await settle();
      assert.equal(byTestId(container, "runtime-name").value, "乙项目新请求");
      assert.equal(byTestId(container, "runtime-create").props.disabled, true, "旧请求 finally 不能释放新请求 busy");
      assert.equal(find(container, node => node.props["data-testid"] === "runtime-error"), undefined);
      assert.equal(find(container, node => node.props["data-testid"] === "runtime-notice"), undefined);
      second.resolve(json({ runtime: {} }, 201)); await newSave; await settle();
      assert.equal(find(container, node => node.props["data-testid"] === "runtime-create-form"), undefined);
      assert.match(textOf(byTestId(container, "runtime-notice")), /已创建/);
    }, { path: "/runtimes?projectId=project-a", respond: (url, init) => {
      if (url === "/api/runtimes" && init?.method === "POST") return ++posts === 1 ? first.promise : second.promise;
    } });
  });
}

test("S6-002：旧目标群组响应失败不会覆盖新目标表单、错误或加载状态", async () => {
  let holdGroups = false;
  const oldGroups = deferred<Response>(), newGroups = deferred<Response>();
  await withScopePage(async (container) => {
    await byTestId(container, "open-runtime-create").props.onClick(); await settle();
    holdGroups = true;
    const oldSelection = select(byTestId(container, "runtime-create-project"), "project-a"); await settle();
    const newSelection = select(byTestId(container, "runtime-create-project"), "project-b"); await settle();
    oldGroups.resolve(json({ error: "旧项目群组请求失败" }, 500)); await oldSelection; await settle();
    assert.equal(selectedValue(byTestId(container, "runtime-create-project")), "project-b");
    assert.equal(byTestId(container, "runtime-create-group").props.disabled, true);
    assert.equal(find(container, node => node.props["data-testid"] === "runtime-error"), undefined);
    newGroups.resolve(json({ groups: [{ id: "group-project-b", projectId: "project-b", name: "乙的新群组响应", archivedAt: null }] }));
    await newSelection; await settle();
    assert.equal(selectedValue(byTestId(container, "runtime-create-group")), "group-project-b");
    assert.match(textOf(byTestId(container, "runtime-create-group")), /乙的新群组响应/);
    assert.equal(byTestId(container, "runtime-create").props.disabled, false);
  }, { respond: (url) => {
    if (holdGroups && url.includes("/groups")) return url.includes("project-a") ? oldGroups.promise : newGroups.promise;
  } });
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileScript, parse } from "@vue/compiler-sfc";
import ts from "typescript";
import { createRenderer, nextTick } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";

// 真实编译 Vue 页面并通过渲染后的控件事件验证请求与反馈，不替代浏览器布局验收。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
interface Element {
  type: string;
  text: string;
  props: Record<string, any>;
  children: Element[];
  parent: Element | null;
  value: unknown;
  selected: boolean;
  selectedIndex: number;
  options: Element[];
  listeners: Record<string, ((event: unknown) => void)[]>;
  getRootNode: () => Element;
  addEventListener: (name: string, listener: (event: unknown) => void) => void;
}
const element = (type: string, text = ""): Element => ({
  type, text, props: {}, children: [], parent: null, value: "", selected: false, listeners: {},
  get options() { return this.children.filter((child) => child.type === "option"); },
  get selectedIndex() { return this.options.findIndex((option) => option.selected); },
  set selectedIndex(index) { this.options.forEach((option, position) => { option.selected = position === index; }); },
  getRootNode() { return this.parent?.getRootNode() ?? this; },
  addEventListener(name, listener) { (this.listeners[name] ??= []).push(listener); },
});
const renderer = createRenderer<Element, Element>({
  createElement: (type) => element(type),
  createText: (text) => element("#text", text),
  createComment: (text) => element("#comment", text),
  setText: (node, text) => { node.text = text; },
  setElementText: (node, text) => { node.text = text; node.children = []; },
  patchProp: (node, key, _previous, value) => { node.props[key] = value; if (key === "value") node.value = value; },
  parentNode: (node) => node.parent,
  nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  insert(node, parent, anchor = null) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = parent;
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(index < 0 ? parent.children.length : index, 0, node);
  },
  remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); },
});

function textOf(node: Element): string { return node.text + node.children.map(textOf).join(""); }
function find(node: Element, predicate: (node: Element) => boolean): Element | undefined {
  if (predicate(node)) return node;
  return node.children.map((child) => find(child, predicate)).find(Boolean);
}
function byTestId(node: Element, id: string): Element {
  const result = find(node, (entry) => entry.props["data-testid"] === id);
  assert.ok(result, `找不到控件 ${id}`);
  return result;
}
async function settle(): Promise<void> {
  for (let index = 0; index < 4; index++) { await new Promise((resolve) => setImmediate(resolve)); await nextTick(); }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function withPage(
  name: string,
  respond: (url: string, init: RequestInit | undefined) => Promise<Response> | Response,
  check: (container: Element) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "boardroom-management-ui-"));
  const previousFetch = globalThis.fetch;
  const globals = globalThis as any;
  const previousDocument = globals.Document;
  const previousShadowRoot = globals.ShadowRoot;
  globals.Document = class {};
  globals.ShadowRoot = class {};
  globalThis.fetch = (input, init) => Promise.resolve(respond(String(input), init));
  let app: ReturnType<typeof renderer.createApp> | undefined;
  try {
    const filename = path.join(root, "src/web/src/views", `${name}.vue`);
    const { descriptor } = parse(await readFile(filename, "utf8"), { filename });
    const script = compileScript(descriptor, {
      id: name,
      inlineTemplate: true,
      templateOptions: { compilerOptions: { hoistStatic: false } },
    });
    let source = ts.transpileModule(script.content, {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
    }).outputText;
    for (const dependency of ["vue", "vue-router"]) {
      source = source.replaceAll(new RegExp(`from ["']${dependency}["']`, "g"), `from "${import.meta.resolve(dependency)}"`);
    }
    source = source.replaceAll(/from ["']\.\.\/api\/client\.ts["']/g, `from "${pathToFileURL(path.join(root, "src/web/src/api/client.ts")).href}"`);
    const compiled = path.join(directory, "view.mjs");
    await writeFile(compiled, source);
    const component = (await import(pathToFileURL(compiled).href)).default;
    const container = element("root");
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/:pathMatch(.*)*", component: { render: () => null } }] });
    await router.push("/");
    app = renderer.createApp(component);
    app.use(router);
    app.mount(container);
    await settle();
    await check(container);
  } finally {
    app?.unmount();
    globalThis.fetch = previousFetch;
    if (previousDocument === undefined) delete globals.Document; else globals.Document = previousDocument;
    if (previousShadowRoot === undefined) delete globals.ShadowRoot; else globals.ShadowRoot = previousShadowRoot;
    await rm(directory, { recursive: true, force: true });
  }
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
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

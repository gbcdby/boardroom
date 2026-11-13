import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileScript, parse } from "@vue/compiler-sfc";
import ts from "typescript";
import { createRenderer, nextTick } from "vue";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import { resourceBrowserKey, type ResourceBrowser } from "../../src/web/src/composables/useResourceReconciliation.ts";

// 编译真正的 SFC，再由 Vue renderer 触发控件事件。此证据不替代 Chromium 布局/焦点验收。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export interface UiElement {
  type: string; tagName: string; text: string; props: Record<string, any>; children: UiElement[];
  parent: UiElement | null; value: unknown; checked: boolean; selected: boolean; selectedIndex: number; options: UiElement[];
  listeners: Record<string, ((event: any) => void)[]>;
  getRootNode(): UiElement; addEventListener(name: string, listener: (event: any) => void): void;
}
const element = (type: string, text = ""): UiElement => ({
  type, tagName: type.toUpperCase(), text, props: {}, children: [], parent: null, value: "", checked: false, selected: false, listeners: {},
  get options() { return this.children.filter((child) => child.type === "option"); },
  get selectedIndex() { return this.options.findIndex((option) => option.selected); },
  set selectedIndex(index) { this.options.forEach((option, position) => { option.selected = position === index; }); },
  getRootNode() { return this.parent?.getRootNode() ?? this; },
  addEventListener(name, listener) { (this.listeners[name] ??= []).push(listener); },
});
const renderer = createRenderer<UiElement, UiElement>({
  createElement: (type) => element(type), createText: (text) => element("#text", text), createComment: (text) => element("#comment", text),
  setText: (node, text) => { node.text = text; }, setElementText: (node, text) => { node.text = text; node.children = []; },
  patchProp: (node, key, _previous, value) => { node.props[key] = value; if (key === "value") node.value = value; if (key === "checked") node.checked = value; },
  parentNode: (node) => node.parent, nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  insert(node, parent, anchor = null) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = parent;
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(index < 0 ? parent.children.length : index, 0, node);
  },
  remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); },
});
export function textOf(node: UiElement): string { return node.text + node.children.map(textOf).join(""); }
export function find(node: UiElement, predicate: (node: UiElement) => boolean): UiElement | undefined {
  if (predicate(node)) return node;
  return node.children.map((child) => find(child, predicate)).find(Boolean);
}
export function byTestId(node: UiElement, id: string): UiElement {
  const result = find(node, (entry) => entry.props["data-testid"] === id);
  assert.ok(result, `找不到控件 ${id}`); return result;
}
export async function settle(): Promise<void> {
  for (let index = 0; index < 4; index++) { await new Promise((resolve) => setImmediate(resolve)); await nextTick(); }
}
export async function input(node: UiElement, value: string): Promise<void> {
  node.value = value;
  for (const listener of node.listeners["input"] ?? []) listener({ target: node });
  if (node.props["onUpdate:modelValue"]) node.props["onUpdate:modelValue"](value);
  await nextTick();
}
export async function select(node: UiElement, value: string): Promise<void> {
  node.value = value; node.selectedIndex = node.options.findIndex((option) => option.value === value);
  for (const listener of node.listeners["change"] ?? []) listener({ target: node });
  if (node.props.onChange) await node.props.onChange({ target: node });
  await nextTick();
}
export function submit(node: UiElement): Promise<void> {
  let form: UiElement | null = node;
  while (form && form.type !== "form") form = form.parent;
  assert.ok(form, "控件必须属于表单");
  return Promise.resolve(form.props.onSubmit({ preventDefault() {} }));
}
export function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
export const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

export async function withPage(
  name: string,
  respond: (url: string, init: RequestInit | undefined) => Promise<Response> | Response,
  check: (container: UiElement, context: { store: any; router: ReturnType<typeof createRouter> }) => Promise<void>,
  options: { path?: string; confirmDiscard?: () => boolean; renderRoute?: string; resourceBrowser?: ResourceBrowser } = {},
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "boardroom-ui-"));
  const previousFetch = globalThis.fetch;
  const globals = globalThis as any;
  const previousDocument = globals.Document, previousShadowRoot = globals.ShadowRoot;
  globals.Document = class {}; globals.ShadowRoot = class {};
  globalThis.fetch = (url, init) => Promise.resolve(respond(String(url), init));
  let app: ReturnType<typeof renderer.createApp> | undefined;
  let store: any;
  try {
    const compiled = new Map<string, string>();
    async function compile(filename: string): Promise<string> {
      const existing = compiled.get(filename); if (existing) return existing;
      const destination = path.join(directory, `${compiled.size}.mjs`); compiled.set(filename, destination);
      const { descriptor } = parse(await readFile(filename, "utf8"), { filename });
      const script = compileScript(descriptor, { id: filename, inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } });
      let source = ts.transpileModule(script.content, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText;
      for (const match of [...source.matchAll(/from\s+["']([^"']+)["']/g)]) {
        const specifier = match[1]!;
        const resolved = specifier.startsWith(".") ? path.resolve(path.dirname(filename), specifier) : null;
        const target = resolved ? pathToFileURL(resolved.endsWith(".vue") ? await compile(resolved) : resolved).href : import.meta.resolve(specifier);
        source = source.replaceAll(match[0], `from "${target}"`);
      }
      await writeFile(destination, source); return destination;
    }
    const component = (await import(pathToFileURL(await compile(path.join(root, "src/web/src/views", `${name}.vue`))).href)).default;
    const context = await import(pathToFileURL(path.join(root, "src/web/src/composables/useCurrentProject.ts")).href);
    store = context.createCurrentProjectContext({ storage: null, confirmDiscard: options.confirmDiscard ?? (() => true) });
    const placeholder = { render: () => null };
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: "/", component: placeholder }, { path: "/projects", component: placeholder }, { path: "/runtimes", component: placeholder }, { path: "/settings", component: placeholder },
      { path: "/projects/:projectId/tasks/:taskId", component: placeholder, meta: { projectSection: "tasks" } },
      { path: "/projects/:projectId/chat/:groupId?", component: placeholder, meta: { projectSection: "chat" } },
      { path: "/memory", component: placeholder, meta: { projectSection: "memory" } },
      ...["overview", "tasks", "org", "audit", "status", "members", "memory", "knowledge", "activity", "settings"].map((section) => ({ path: `/projects/:projectId/${section}`, component: placeholder, meta: { projectSection: section } })),
    ].map(record => ({ ...record, component: record.path === options.renderRoute ? component : record.component })) });
    store.installRouter(router);
    await router.push(options.path ?? "/projects/project-1/tasks");
    const container = element("root");
    app = renderer.createApp(options.renderRoute ? RouterView : component); app.use(router); app.provide(context.currentProjectKey, store);
    if (options.resourceBrowser) app.provide(resourceBrowserKey, options.resourceBrowser);
    app.mount(container);
    await settle(); await check(container, { store, router });
  } finally {
    app?.unmount(); store?.dispose(); globalThis.fetch = previousFetch;
    if (previousDocument === undefined) delete globals.Document; else globals.Document = previousDocument;
    if (previousShadowRoot === undefined) delete globals.ShadowRoot; else globals.ShadowRoot = previousShadowRoot;
    await rm(directory, { recursive: true, force: true });
  }
}

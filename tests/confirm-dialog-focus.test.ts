import test from "node:test";
import assert from "node:assert/strict";
import { markRaw } from "vue";
import { byTestId, deferred, find, json, settle, textOf, withPage } from "./helpers/web-ui.ts";
import type { UiElement } from "./helpers/web-ui.ts";

const project = { id: "project-1", name: "焦点验证项目", manager: null, archivedAt: null };
const member = { id: "member-1", projectId: project.id, kind: "human", displayName: "焦点验证成员", role: "normal", status: "active", nodeId: null };

// 在真正编译的 SFC 上检查键盘事件与更新后的焦点目标；不模拟浏览器的 Tab 默认行为。
// native dialog、实际 DOM 选择器、布局与键盘循环仍由 e2e-webui.py 的 Chromium 检查验收。
function focusHost(dialog: UiElement) {
  const outside = {};
  const document = markRaw({ activeElement: outside as object, defaultView: { getComputedStyle: (node: UiElement) => ({ visibility: node.props.visibility ?? "visible" }) } });
  const installed = new Set<UiElement>();
  const descendants = (node: UiElement): UiElement[] => node.children.flatMap(child => [child, ...descendants(child)]);
  const parents = (node: UiElement): UiElement[] => node.parent ? [node.parent, ...parents(node.parent)] : [];
  const disabled = (node: UiElement) => Boolean(node.props.disabled) || parents(node).some(parent => parent.type === "fieldset" && parent.props.disabled);
  function install(node: UiElement): void {
    if (installed.has(node)) return;
    installed.add(node);
    Object.assign(node, {
      ownerDocument: document,
      focus() { if (!disabled(node)) document.activeElement = node; },
      contains(target: object) { return node === target || descendants(node).includes(target as UiElement); },
      matches() { return disabled(node); },
      closest() { return [node, ...parents(node)].find(parent => parent.props.inert) ?? null; },
      getClientRects() { return [node, ...parents(node)].some(parent => parent.props.hidden) ? [] : [{}]; },
    });
    Object.defineProperty(node, "tabIndex", { get: () => Number(node.props.tabindex ?? (["button", "input", "select", "textarea", "summary", "a"].includes(node.type) ? 0 : -1)) });
  }
  Object.assign(dialog, {
    open: true,
    querySelectorAll() {
      const nodes = descendants(dialog);
      nodes.forEach(install);
      return nodes.filter(node => ["button", "input", "select", "textarea", "summary", "a"].includes(node.type) || node.props.tabindex !== undefined);
    },
  });
  [dialog, ...descendants(dialog)].forEach(install);
  return {
    document,
    focus(node: UiElement) { install(node); document.activeElement = node; },
    key(options: Record<string, unknown> = {}) {
      const event = { key: "Tab", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; }, ...options };
      dialog.props.onKeydown?.(event);
      return event;
    },
  };
}

async function withConfirmation(check: (container: UiElement, host: ReturnType<typeof focusHost>) => Promise<void>, remove?: () => Promise<Response> | Response): Promise<void> {
  await withPage("ProjectsView", (url, init) => {
    if (init?.method === "DELETE") return remove?.() ?? new Response(null, { status: 204 });
    if (url.endsWith("/members")) return json({ members: [member] });
    if (url.includes("/groups")) return json({ groups: [] });
    if (url.includes("/member-statuses")) return json({ memberStatuses: [] });
    return json({ projects: [project] });
  }, async container => {
    find(container, node => node.type === "button" && textOf(node) === "移除")!.props.onClick();
    await settle();
    await check(container, focusHost(byTestId(container, "confirmation-dialog")));
  }, { path: "/projects/project-1/overview" });
}

test("S6-AC05：确认框末端 Tab 和首端 Shift+Tab 循环，内部与系统快捷键保留默认行为", async () => {
  await withConfirmation(async (container, host) => {
    const cancel = byTestId(container, "confirm-cancel"), confirm = byTestId(container, "confirm-submit");
    host.focus(confirm);
    assert.equal(host.key().defaultPrevented, true);
    assert.equal(host.document.activeElement, cancel, "末端 Tab 应回到取消按钮");
    assert.equal(host.key({ shiftKey: true }).defaultPrevented, true);
    assert.equal(host.document.activeElement, confirm, "首端 Shift+Tab 应回到确认按钮");
    host.focus(cancel);
    assert.equal(host.key().defaultPrevented, false, "内部顺序由浏览器处理");
    for (const options of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { key: "Escape" }, { key: "Enter" }, { isComposing: true }, { defaultPrevented: true }]) {
      host.focus(confirm);
      assert.equal(host.key(options).defaultPrevented, options.defaultPrevented ?? false);
      assert.equal(host.document.activeElement, confirm, "不能接管系统快捷键、输入法或 slot 已消费的事件");
    }
  });
});

test("S6-AC02/05：提交中按钮全禁用时焦点移到标题，正反 Tab 与 Escape 不离开弹窗", async () => {
  const response = deferred<Response>();
  let requests = 0;
  await withConfirmation(async (container, host) => {
    const dialog = byTestId(container, "confirmation-dialog"), confirm = byTestId(container, "confirm-submit");
    const heading = find(dialog, node => node.type === "h2")!;
    host.focus(confirm);
    const submitting = confirm.props.onClick();
    await settle();
    assert.equal(confirm.props.disabled, true);
    assert.equal(byTestId(container, "confirm-cancel").props.disabled, true);
    assert.ok(host.document.activeElement === heading, "禁用当前按钮后应立即保留弹窗内的有效焦点");
    for (const shiftKey of [false, true]) {
      assert.equal(host.key({ shiftKey }).defaultPrevented, true);
      assert.ok(host.document.activeElement === heading, "没有可遍历控件时焦点保留在标题");
    }
    let preventedCancel = false;
    dialog.props.onCancel({ preventDefault() { preventedCancel = true; } });
    confirm.props.onClick();
    await settle();
    assert.equal(preventedCancel, true);
    assert.equal(byTestId(container, "confirmation-dialog"), dialog);
    assert.equal(requests, 1);
    response.resolve(json({ error: { code: "conflict", message: "请核对后重试" } }, 409));
    await submitting; await settle();
    assert.equal(confirm.props.disabled, false);
    assert.equal(host.key().defaultPrevented, true);
    assert.equal(host.document.activeElement, byTestId(container, "confirm-cancel"));
  }, () => { requests++; return response.promise; });
});

test("S6-AC02/05：恢复按钮动态加入循环、禁用或隐藏节点被跳过，移除恢复按钮后焦点仍可用", async () => {
  await withConfirmation(async (container, host) => {
    const cancel = byTestId(container, "confirm-cancel"), confirm = byTestId(container, "confirm-submit");
    host.focus(confirm);
    await confirm.props.onClick(); await settle();
    const recovery = byTestId(container, "confirmation-reconcile");
    assert.equal(confirm.props.disabled, true);
    host.focus(cancel);
    assert.equal(host.key().defaultPrevented, true);
    assert.equal(host.document.activeElement, recovery, "新出现的恢复 slot 按钮应进入循环");
    assert.equal(host.key({ shiftKey: true }).defaultPrevented, true);
    assert.equal(host.document.activeElement, cancel, "应跳过禁用的确认按钮");
    recovery.props.hidden = true;
    assert.equal(host.key().defaultPrevented, true);
    assert.equal(host.document.activeElement, cancel, "隐藏恢复按钮后只循环可见取消按钮");
    delete recovery.props.hidden;
    host.focus(recovery);
    await recovery.props.onClick(); await settle();
    assert.equal(find(container, node => node.props["data-testid"] === "confirmation-reconcile"), undefined);
    assert.ok(find(byTestId(container, "confirmation-dialog"), node => node === host.document.activeElement), "当前 slot 控件被移除后焦点仍须在弹窗中");
    host.key();
    assert.equal(host.document.activeElement, cancel, "恢复后应能继续从可用取消按钮导航");
    assert.equal(confirm.props.disabled, false);
  }, () => json({ error: { code: "server_error", message: "无法确认结果" } }, 503));
});

test("S6-AC03/05：重新预览移除当前恢复按钮后还焦取消，确认动作仍需再次点击", async () => {
  let previews = 0, submissions = 0;
  await withPage("ProjectsView", (url, init) => {
    if (init?.method === "DELETE") {
      if (init.body) { submissions++; return json({ error: { code: "confirmation_changed", message: "影响范围变化" } }, 409); }
      previews++;
      return json({ error: { code: "confirmation_required" }, confirmation: { kind: "project", projectId: project.id, projectName: project.name, cascade: {}, token: `token-${previews}`, expiresAt: "2026-11-12T01:00:00Z" } }, 409);
    }
    if (url.endsWith("/members")) return json({ members: [member] });
    if (url.includes("/groups")) return json({ groups: [] });
    if (url.includes("/member-statuses")) return json({ memberStatuses: [] });
    return json({ projects: [project] });
  }, async container => {
    await byTestId(container, "purge-project").props.onClick(); await settle();
    const host = focusHost(byTestId(container, "confirmation-dialog"));
    const confirm = byTestId(container, "confirm-purge-project");
    host.focus(confirm);
    await confirm.props.onClick(); await settle();
    const preview = byTestId(container, "confirmation-preview");
    host.focus(preview);
    await preview.props.onClick(); await settle();
    assert.equal(find(container, node => node.props["data-testid"] === "confirmation-preview"), undefined);
    assert.ok(host.document.activeElement === byTestId(container, "cancel-purge-project"));
    assert.equal(confirm.props.disabled, false);
    assert.equal(previews, 2);
    assert.equal(submissions, 1, "重新预览不得自动提交删除");
  }, { path: "/projects/project-1/overview" });
});

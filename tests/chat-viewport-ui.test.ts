import test from "node:test";
import assert from "node:assert/strict";
import { byTestId, find, input, json, settle, withPage, type UiElement } from "./helpers/web-ui.ts";

type FrameCallback = (timestamp: number) => void;
// 真 SFC + 受控几何：验证预算、阅读位置和资源清理；真实像素仍由既有 Chromium 负载门控验收。
async function withViewport(run: (viewport: any) => Promise<void>, observers = true) {
  const globals = globalThis as any;
  const saved = new Map(["window", "location", "WebSocket", "ResizeObserver"].map(key => [key, Object.getOwnPropertyDescriptor(globals, key)]));
  const frames = new Map<number, FrameCallback>(), listeners = new Map<string, Set<() => void>>();
  const observed: Array<{ callback: () => void; disconnected: boolean }> = [];
  let nextFrame = 0;
  const viewport: any = {
    innerHeight: 1000, innerWidth: 1440, scrollY: 0, observed, frames, listeners,
    addEventListener(name: string, listener: () => void) { const set = listeners.get(name) ?? new Set(); set.add(listener); listeners.set(name, set); },
    removeEventListener(name: string, listener: () => void) { listeners.get(name)?.delete(listener); },
    requestAnimationFrame(callback: FrameCallback) { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
    scrollTo() { assert.fail("聊天尺寸适配不得滚动整个页面"); },
    async resize() {
      for (const listener of listeners.get("resize") ?? []) listener();
      for (const observer of observed) if (!observer.disconnected) observer.callback();
      await viewport.flush();
    },
    async flush() {
      for (let turn = 0; turn < 4 && frames.size; turn++) {
        const pending = [...frames.values()]; frames.clear();
        for (const callback of pending) callback(0);
        await settle();
      }
      assert.equal(frames.size, 0, "尺寸观察必须收敛，不能不断自触发渲染帧");
    },
  };
  globals.window = viewport;
  globals.location = { protocol: "http:", host: "localhost" };
  globals.WebSocket = class { addEventListener() {} close() {} };
  if (observers) globals.ResizeObserver = class {
    entry: { callback: () => void; disconnected: boolean };
    constructor(callback: () => void) { this.entry = { callback, disconnected: false }; observed.push(this.entry); }
    observe() {} disconnect() { this.entry.disconnected = true; }
  };
  else delete globals.ResizeObserver;
  try { await run(viewport); }
  finally { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globals, key, descriptor); else delete globals[key]; } }
}

const project = { id: "project-1", name: "聊天项目", archivedAt: null, manager: null };
const groups = ["one", "two"].map(id => ({ id, projectId: project.id, name: `讨论${id}`, archivedAt: null }));
const human = { id: "human", projectId: project.id, displayName: "我", kind: "human", status: "active" };
const messages = Array.from({ length: 200 }, (_, index) => ({ id: `message-${index}`, groupId: "one", senderMemberId: human.id, senderDisplayName: human.displayName, seq: index + 1, text: `历史 ${index}`, mentions: [], createdAt: "2026-11-12T01:00:00Z" }));
function respond(url: string) {
  if (url.endsWith("/participants")) return json({ participants: [human] });
  if (url.endsWith("/messages")) {
    const groupId = url.split("/").at(-2);
    return json({ messages: messages.map(message => ({ ...message, id: `${groupId}-${message.id}`, groupId })) });
  }
  if (url.includes("/groups")) return json({ groups });
  if (url.endsWith("/members")) return json({ members: [human] });
  return json({ projects: [project] });
}

function geometry(container: UiElement, viewport: any, initial = { top: 549, after: 324 }) {
  const list: any = byTestId(container, "chat-messages");
  const conversation: any = find(container, node => node.props.class === "panel conversation");
  assert.ok(conversation);
  const size = { ...initial };
  const height = () => Number.parseFloat(list.props.style?.["--chat-message-height"] ?? "") || Math.min(640, viewport.innerHeight * .56);
  const rect = (top: number, bottom: number) => ({ top, bottom, height: bottom - top, left: 0, right: 1000, width: 1000 });
  list.getBoundingClientRect = () => rect(size.top - viewport.scrollY, size.top - viewport.scrollY + height());
  conversation.getBoundingClientRect = () => rect(size.top - viewport.scrollY - 86, size.top - viewport.scrollY + height() + size.after);
  let scroll = 0;
  Object.defineProperties(list, {
    scrollHeight: { configurable: true, get: () => 22000 }, clientHeight: { configurable: true, get: height },
    scrollTop: { configurable: true, get: () => scroll, set: value => { scroll = Math.max(0, Math.min(Number(value), list.scrollHeight - list.clientHeight)); } },
  });
  return { list, conversation, size, height };
}

test("聊天剩余视口：原1440×1000失败几何收窄消息区，composer增高后仍跟随最新", async () => {
  await withViewport(async viewport => {
    await withPage("ChatView", respond, async container => {
      const measured = geometry(container, viewport);
      await viewport.resize();
      assert.ok(measured.list.props.style?.["--chat-message-height"], "消息区须绑定实际剩余视口高度");
      assert.ok(measured.list.getBoundingClientRect().bottom <= viewport.innerHeight, "最新消息所在列表底部不得落在视口之外");
      assert.equal(measured.list.scrollTop, measured.list.scrollHeight - measured.list.clientHeight);
      measured.size.top = 320; measured.size.after = 160;
      await viewport.resize();
      const before = measured.height();
      measured.size.after = 320; // 文本域或说明变高，按真实尾部尺寸重新分配。
      await viewport.resize();
      assert.ok(measured.height() < before);
      assert.ok(measured.size.top + measured.height() + measured.size.after <= viewport.innerHeight);
      assert.equal(measured.list.scrollTop, measured.list.scrollHeight - measured.list.clientHeight);
    }, { path: "/projects/project-1/chat/one" });
    assert.equal(viewport.frames.size, 0);
    assert.ok(viewport.observed.every((entry: any) => entry.disconnected));
    assert.equal(viewport.listeners.get("resize")?.size ?? 0, 0);
  });
});

test("聊天尺寸变化保留历史阅读、草稿与 DOM；390矮屏和离开时取消旧恢复", async () => {
  await withViewport(async viewport => {
    let discard = false;
    await withPage("ChatView", respond, async (container, { router }) => {
      const measured = geometry(container, viewport, { top: 320, after: 180 });
      await viewport.resize();
      const draft = byTestId(container, "chat-input"); await input(draft, "保留聊天草稿");
      measured.list.scrollTop = 42; measured.list.props.onScroll();
      measured.size.top = 410; measured.size.after = 300;
      viewport.innerWidth = 390; viewport.innerHeight = 700;
      await viewport.resize();
      assert.ok(measured.list.getBoundingClientRect().bottom <= viewport.innerHeight);
      assert.equal(measured.list.scrollTop, 42, "阅读历史时改变尺寸不得抢回列表底部");
      assert.equal(byTestId(container, "chat-input"), draft); assert.equal(draft.value, "保留聊天草稿");
      const fixedHeight = measured.height(); viewport.scrollY = 200;
      await viewport.resize();
      assert.equal(measured.height(), fixedHeight, "页面自然滚动不改变消息区预算");
      assert.equal(measured.list.scrollTop, 42);
      await viewport.resize();
      assert.equal(measured.list.scrollTop, 42, "主题等不改变几何的更新不得重设阅读位置");
      await router.push("/settings"); await settle();
      assert.equal(router.currentRoute.value.path, "/projects/project-1/chat/one");
      assert.equal(byTestId(container, "chat-messages"), measured.list);
      discard = true;
      for (const observer of viewport.observed) if (!observer.disconnected) observer.callback();
      await router.push("/settings"); await settle(); await viewport.flush();
      assert.equal(find(container, node => node.props["data-testid"] === "chat-messages"), undefined);
      assert.ok(viewport.observed.every((entry: any) => entry.disconnected));
      assert.equal(measured.list.scrollTop, 42, "卸载后旧回调不能更改原列表");
    }, { path: "/projects/project-1/chat/one", renderRoute: "/projects/:projectId/chat/:groupId?", confirmDiscard: () => discard });
  });
});

test("切换群组会撤销旧尺寸帧，旧回调不能覆盖新群的预算", async () => {
  await withViewport(async viewport => {
    await withPage("ChatView", respond, async (container, { router }) => {
      const measured = geometry(container, viewport, { top: 320, after: 180 });
      await viewport.resize();
      const before = measured.height();
      for (const observer of viewport.observed) if (!observer.disconnected) observer.callback();
      const stale = [...viewport.frames.values()] as FrameCallback[];
      assert.ok(stale.length > 0);
      await router.push("/projects/project-1/chat/two"); await settle();
      measured.size.top = 450;
      for (const callback of stale) callback(0);
      await settle();
      assert.equal(measured.height(), before, "已撤销的旧帧不再写入高度");
      await viewport.flush();
      assert.ok(measured.height() < before);
      assert.equal(byTestId(container, "chat-messages"), measured.list, "切群继续使用原消息容器");
    }, { path: "/projects/project-1/chat/one" });
  });
});

test("ResizeObserver缺省时聊天仍按初始与窗口resize调整，不阻断页面", async () => {
  await withViewport(async viewport => {
    await withPage("ChatView", respond, async container => {
      const measured = geometry(container, viewport, { top: 300, after: 200 });
      await viewport.resize(); const previous = measured.height();
      assert.ok(measured.list.props.style?.["--chat-message-height"]);
      viewport.innerHeight = 700; await viewport.resize();
      assert.ok(measured.height() < previous);
      assert.ok(measured.list.getBoundingClientRect().bottom <= viewport.innerHeight);
    }, { path: "/projects/project-1/chat/one" });
    assert.equal(viewport.listeners.get("resize")?.size ?? 0, 0);
    assert.equal(viewport.listeners.get("pointerup")?.size ?? 0, 0);
  }, false);
});

test("键盘压缩视觉视口至180px时保留128px可读区域，由页面自然滚动", async () => {
  await withViewport(async viewport => {
    viewport.visualViewport = { height: 180, addEventListener() {}, removeEventListener() {} };
    await withPage("ChatView", respond, async container => {
      const measured = geometry(container, viewport, { top: 300, after: 200 });
      await viewport.resize();
      assert.ok(measured.height() >= 128, `极矮视觉视口不能把消息区缩到${measured.height()}px`);
      assert.equal(byTestId(container, "chat-messages"), measured.list);
    }, { path: "/projects/project-1/chat/one" });
  });
});

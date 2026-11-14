import test from "node:test";
import assert from "node:assert/strict";
import { byTestId, deferred, find, input, json, settle, withPage, type UiElement } from "./helpers/web-ui.ts";

type FrameCallback = (timestamp: number) => void;
// 真 SFC + 受控几何：验证预算、阅读位置和资源清理；真实像素仍由既有 Chromium 负载门控验收。
async function withViewport(run: (viewport: any) => Promise<void>, observers = true) {
  const globals = globalThis as any;
  const saved = new Map(["window", "location", "WebSocket", "ResizeObserver"].map(key => [key, Object.getOwnPropertyDescriptor(globals, key)]));
  const frames = new Map<number, FrameCallback>(), listeners = new Map<string, Set<() => void>>();
  const observed: Array<{ callback: () => void; disconnected: boolean }> = [];
  let nextFrame = 0;
  const viewport: any = {
    innerHeight: 1000, innerWidth: 1440, scrollY: 0, observed, frames, listeners, sockets: [],
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
  globals.WebSocket = class {
    events = new Map<string, Array<(event: any) => void>>();
    constructor() { viewport.sockets.push(this); }
    addEventListener(name: string, listener: (event: any) => void) { const callbacks = this.events.get(name) ?? []; callbacks.push(listener); this.events.set(name, callbacks); }
    message(payload: unknown) { for (const callback of this.events.get("message") ?? []) callback({ data: JSON.stringify(payload) }); }
    close() {}
  };
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

function geometry(container: UiElement, viewport: any, initial = { top: 549, after: 324 }, contentHeight = () => 22000, renderedHeight?: () => number) {
  const list: any = byTestId(container, "chat-messages");
  const conversation: any = find(container, node => node.props.class === "panel conversation");
  assert.ok(conversation);
  const size = { ...initial };
  const height = renderedHeight ?? (() => Number.parseFloat(list.props.style?.["--chat-message-height"] ?? "") || Math.min(640, viewport.innerHeight * .56));
  const rect = (top: number, bottom: number) => ({ top, bottom, height: bottom - top, left: 0, right: 1000, width: 1000 });
  list.getBoundingClientRect = () => rect(size.top - viewport.scrollY, size.top - viewport.scrollY + height());
  conversation.getBoundingClientRect = () => rect(size.top - viewport.scrollY - 86, size.top - viewport.scrollY + height() + size.after);
  let scroll = 0;
  Object.defineProperties(list, {
    scrollHeight: { configurable: true, get: contentHeight }, clientHeight: { configurable: true, get: height },
    scrollTop: { configurable: true, get: () => scroll, set: value => { scroll = Math.max(0, Math.min(Number(value), list.scrollHeight - list.clientHeight)); } },
  });
  return { list, conversation, size, height };
}

for (const order of ["history-first", "layout-first"] as const) {
  test(`首次聊天 ${order}：尺寸缩短产生scroll事件仍贴底，随后消息跟随而主动读历史保持`, async () => {
    await withViewport(async viewport => {
      const history = deferred<Response>();
      const initial = messages.slice(0, 25);
      let contentHeight = 248;
      await withPage("ChatView", url => url.endsWith("/messages") ? history.promise : respond(url), async container => {
        const measured = geometry(container, viewport, { top: 549, after: 262 }, () => contentHeight);
        // 模拟浏览器在高度样式提交后、nextTick贴底之前通知scroll；scrollTop本身没有用户位移。
        let applied = measured.list.props.style;
        let duringUpdate: (() => void) | undefined;
        Object.defineProperty(measured.list.props, "style", { configurable: true,
          get: () => applied,
          set: value => {
            const before = measured.height(); applied = value;
            if (measured.height() !== before) measured.list.props.onScroll();
            const action = duringUpdate; duringUpdate = undefined; action?.();
          },
        });
        if (order === "layout-first") await viewport.resize();
        contentHeight = 2458;
        history.resolve(json({ messages: initial })); await settle();
        await viewport.resize();
        assert.ok(Math.abs(measured.list.scrollHeight - measured.list.clientHeight - measured.list.scrollTop) <= 1,
          `首次到达后应贴底：top=${measured.list.scrollTop}, height=${measured.list.clientHeight}, content=${measured.list.scrollHeight}`);
        contentHeight += 100;
        viewport.sockets[0].message({ type: "message", message: { ...initial.at(-1), id: "live-one", seq: 26, text: "首次布局后到达" } });
        await settle(); await viewport.flush();
        assert.equal(measured.list.scrollTop, measured.list.scrollHeight - measured.list.clientHeight, "跟随状态保留至后续实时消息");
        // 消息watch已经捕获跟随状态，但用户在DOM提交期间主动向上；旧nextTick不能抢回。
        duringUpdate = () => { measured.list.scrollTop = 100; measured.list.props.onScroll(); };
        contentHeight += 100;
        viewport.sockets[0].message({ type: "message", message: { ...initial.at(-1), id: "live-two", seq: 27, text: "阅读历史期间到达" } });
        await settle(); await viewport.flush();
        assert.equal(measured.list.scrollTop, 100, "真实向上位移后不能被新消息抢回底部");
      }, { path: "/projects/project-1/chat/one" });
    });
  });
}

for (const userScrollsUp of [false, true]) {
  test(`首次聊天收缩期间自动向下调整${userScrollsUp ? "并主动上翻：保留阅读位置" : "：不得取消最新跟随"}`, async () => {
    await withViewport(async viewport => {
      const history = deferred<Response>();
      let contentHeight = 248;
      await withPage("ChatView", url => url.endsWith("/messages") ? history.promise : respond(url), async container => {
        const measured = geometry(container, viewport, { top: 549, after: 262 }, () => contentHeight);
        contentHeight = 2358;
        history.resolve(json({ messages: messages.slice(0, 25) })); await settle();
        assert.equal(measured.list.scrollTop, 1798, "历史先按原560px区域贴底");
        let applied = measured.list.props.style, adjusted = false;
        Object.defineProperty(measured.list.props, "style", { configurable: true,
          get: () => applied,
          set: value => {
            const before = measured.height(); applied = value;
            if (adjusted || measured.height() === before) return;
            adjusted = true;
            // 内容重排保持锚点时向下调整100px；此后得到原生失败的2458/1898/189几何。
            contentHeight += 100;
            measured.list.scrollTop += 100;
            measured.list.props.onScroll();
            if (userScrollsUp) {
              measured.list.scrollTop = 100; measured.list.props.onScroll();
            }
          },
        });
        await viewport.resize();
        assert.ok(adjusted);
        assert.equal(measured.height(), 189);
        assert.equal(measured.list.scrollTop, userScrollsUp ? 100 : 2269,
          `自动位移和主动上翻须区分：top=${measured.list.scrollTop}, height=${measured.height()}, content=${contentHeight}`);
        contentHeight += 100;
        viewport.sockets[0].message({ type: "message", message: { ...messages[0], id: "after-layout", seq: 26, text: "调整后到达" } });
        await settle(); await viewport.flush();
        assert.equal(measured.list.scrollTop, userScrollsUp ? 100 : 2369, "后续实时消息继续服从阅读意图");
      }, { path: "/projects/project-1/chat/one" });
    });
  });
}

for (const intent of ["follow", "read-history", "leave"] as const) {
  test(`首次聊天真实尺寸晚于预算提交：${intent}`, async () => {
    await withViewport(async viewport => {
      const history = deferred<Response>();
      let contentHeight = 260, renderedHeight = 260;
      await withPage("ChatView", url => url.endsWith("/messages") ? history.promise : respond(url), async (container, { router }) => {
        const measured = geometry(container, viewport, { top: 549, after: 324 }, () => contentHeight, () => renderedHeight);
        await viewport.resize();
        assert.equal(measured.list.props.style["--chat-message-height"], "128px");
        assert.equal(measured.height(), 260, "预算已提交，但真实盒子尚未变化");
        contentHeight = 2458; renderedHeight = 560; measured.size.after = 262;
        history.resolve(json({ messages: messages.slice(0, 25) })); await settle();
        assert.equal(measured.list.scrollTop, 1898, "消息先按真实560px区域贴底");
        await viewport.resize();
        assert.equal(measured.list.props.style["--chat-message-height"], "189px");
        assert.equal(measured.list.scrollTop, 1898, "nextTick后真实盒子仍560px，写入仍夹在旧底部");
        await viewport.resize();
        assert.equal(measured.list.scrollTop, 1898);

        // 原生诊断 seq38：RO后来报告189px真实尺寸，但预算仍是同一个189。
        renderedHeight = 189;
        for (const observer of viewport.observed) if (!observer.disconnected) observer.callback();
        const pending = [...viewport.frames.values()] as FrameCallback[];
        assert.ok(pending.length > 0);
        if (intent === "leave") {
          await router.push("/settings"); await settle();
          for (const callback of pending) callback(0);
          await settle(); await viewport.flush();
          assert.equal(find(container, node => node.props["data-testid"] === "chat-messages"), undefined);
          assert.equal(measured.list.scrollTop, 1898, "卸载后的迟到尺寸帧不得再写旧列表");
          return;
        }
        viewport.frames.clear();
        for (const callback of pending) callback(0);
        if (intent === "read-history") {
          measured.list.scrollTop = 100; measured.list.props.onScroll();
        }
        await settle(); await viewport.flush();
        assert.equal(measured.list.scrollTop, intent === "follow" ? 2269 : 100,
          `迟到几何后的阅读意图：top=${measured.list.scrollTop}, height=${measured.height()}, content=${contentHeight}`);
        const settledTop = measured.list.scrollTop;
        await viewport.resize();
        assert.equal(measured.list.scrollTop, settledTop, "几何和预算都不变时保持位置");
        contentHeight += 100;
        viewport.sockets[0].message({ type: "message", message: { ...messages[0], id: "after-delayed-size", seq: 26, text: "真实尺寸稳定后到达" } });
        await settle(); await viewport.flush();
        assert.equal(measured.list.scrollTop, intent === "follow" ? 2369 : 100);
      }, { path: "/projects/project-1/chat/one", renderRoute: "/projects/:projectId/chat/:groupId?" });
    });
  });
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

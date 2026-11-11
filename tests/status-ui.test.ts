import test from "node:test";
import assert from "node:assert/strict";
import { byTestId, deferred, json, settle, textOf, withPage } from "./helpers/web-ui.ts";

test("状态页：HTTP 补充 human presence 身份时，较新的 WS 工作状态仍保留", async () => {
  const members = deferred<Response>();
  const statuses = deferred<Response>();
  const project = { id: "project-1", name: "状态回归", archivedAt: null, manager: null };
  const newer = {
    projectId: project.id, memberId: "agent-1", kind: "agent", displayName: "协作助手",
    state: "working", connection: "connected", heartbeatTimedOut: false, heartbeatStale: false,
    stale: false, disconnected: false, lastHeartbeatAt: "2026-11-10T10:00:10Z",
    connectedAt: "2026-11-10T10:00:00Z", disconnectedAt: null, hostType: "codex-cli",
    updatedAt: "2026-11-10T10:00:10Z",
  };
  let socket: TestSocket | undefined;
  class TestSocket extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    sent: unknown[] = [];
    constructor(_url: string) { super(); socket = this; }
    open() { this.readyState = TestSocket.OPEN; this.dispatchEvent(new Event("open")); }
    receive(payload: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) })); }
    send(payload: string) { this.sent.push(JSON.parse(payload)); }
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  // 只替换传输边界，实际编译/渲染 StatusBoardView、StatusBoard 与生产 composable。
  // 不创建本地 socket；通过公开 HTTP/WS 事件序列观察最终显示和 presence 消息。
  const globals = globalThis as any;
  const previousSocket = globals.WebSocket, previousLocation = globals.location;
  globals.WebSocket = TestSocket;
  globals.location = { protocol: "http:", host: "status-ui.test" };
  try {
    await withPage("StatusBoardView", (url) => {
      if (url.endsWith("/members")) return members.promise;
      if (url.endsWith("/member-statuses")) return statuses.promise;
      if (url.startsWith("/api/projects?")) return json({ projects: [project] });
      throw new Error(`非预期请求 ${url}`);
    }, async (container) => {
      assert.ok(socket);
      socket.open();
      socket.receive({ type: "status_update", scope: "project", projectId: project.id,
        serverTime: "2026-11-10T10:00:10Z", statuses: [newer] });
      await settle();
      assert.equal(textOf(byTestId(container, "board-state")), "工作中");

      members.resolve(json({ members: [{ id: "human-1", projectId: project.id, kind: "human", status: "active", displayName: "项目成员" }] }));
      statuses.resolve(json({ memberStatuses: [{ ...newer, state: "offline", connection: "disconnected",
        disconnected: true, updatedAt: "2026-11-10T10:00:00Z" }] }));
      await settle();

      assert.deepEqual(socket.sent.at(-1), { type: "presence", projectId: project.id, memberId: "human-1" }, "HTTP 返回的 human 身份仍应声明 presence");
      assert.equal(textOf(byTestId(container, "board-state")), "工作中", "较旧 HTTP 响应不能覆盖已显示的较新 WS 快照");
      assert.match(textOf(byTestId(container, "board-connection")), /已连接/);
      assert.doesNotMatch(textOf(byTestId(container, "board-connection")), /已断开|断线/);
    }, { path: "/projects/project-1/status" });
  } finally {
    globals.WebSocket = previousSocket;
    if (previousLocation === undefined) delete globals.location; else globals.location = previousLocation;
  }
});

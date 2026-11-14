import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";

test("浏览器故障夹具：真实 HTTP/MCP/独立stdio、字节保留延迟、WS丢包和临时资源回收", { timeout: 45000 }, async () => {
  const child = spawn(process.execPath, ["scripts/resource-web-fixture.mjs"], {
    cwd: path.resolve(import.meta.dirname, ".."), stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "", serial = 0, closed: any;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  let readyResolve!: (value: any) => void, readyReject!: (error: Error) => void;
  const ready = new Promise<any>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-16000); });
  const exited = new Promise<number | null>(resolve => child.once("exit", code => {
    const error = new Error("fixture exited " + code + ": " + stderr);
    readyReject(error); for (const listener of pending.values()) listener.reject(error); resolve(code);
  }));
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    const message = JSON.parse(line);
    if (message.event === "ready") readyResolve(message);
    else if (message.event === "closed") closed = message;
    else {
      const listener = pending.get(message.id);
      pending.delete(message.id);
      if (message.ok) listener?.resolve(message.result);
      else listener?.reject(new Error(JSON.stringify(message)));
    }
  });
  const command = (op: string, values: Record<string, unknown> = {}) => {
    const id = ++serial;
    const result = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("fixture command " + op + " timed out")); }, 8000);
      pending.set(id, { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } });
    });
    child.stdin.write(JSON.stringify({ id, op, ...values }) + "\n"); return result;
  };
  const until = async (predicate: () => Promise<boolean> | boolean) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) { if (await predicate()) return; await delay(20); }
    throw new Error("等待真实夹具事件超时");
  };
  const json = async (origin: string, route: string, method = "GET", body?: unknown, status = 200) => {
    const response = await fetch(origin + route, { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
    assert.equal(response.status, status); return response.json() as Promise<any>;
  };
  let data: any, socket: WebSocket | undefined;
  try {
    data = await Promise.race([ready, delay(15000, undefined, { ref: false }).then(() => { throw new Error("fixture startup timeout: " + stderr); })]);
    assert.notEqual(data.stdioPid, data.fixturePid);
    const first = data.records[0], second = data.records[1];
    const route = "/api/projects/" + first.project.id + "/tasks";
    let task = (await json(data.writeUrl, route, "POST", { title: "fixture 原稿", assigneeMemberId: first.memberId }, 201)).task;
    const detail = route + "/" + task.id;
    const frames: any[] = [];
    socket = new WebSocket(data.url.replace("http:", "ws:") + "/ws");
    socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
    await new Promise<void>((resolve, reject) => { socket!.addEventListener("open", () => resolve(), { once: true }); socket!.addEventListener("error", reject, { once: true }); });
    socket.send(JSON.stringify({ type: "resource.subscribe", projectId: first.project.id }));
    await until(() => frames.some(frame => frame.type === "resource.subscribed"));
    const read = await fetch(data.url + detail), etag = read.headers.get("etag");
    assert.ok(etag); assert.equal((await read.json() as any).task.title, task.title);

    // 延迟仅暂存上游真实响应，释放后状态、ETag 和 JSON 都保持。
    await command("network", { holdPath: detail });
    const heldResponse = fetch(data.url + detail);
    await until(async () => (await command("snapshot")).heldPaths.includes(detail));
    assert.deepEqual(await command("release"), [detail]);
    const released = await heldResponse;
    assert.equal(released.status, 200); assert.equal(released.headers.get("etag"), etag);
    assert.equal((await released.json() as any).task.title, task.title);

    await command("network", { dropResources: true });
    task = (await json(data.writeUrl, detail, "PATCH", { expectedRevision: task.revision, title: "真实HTTP提交" })).task;
    await until(async () => (await command("snapshot")).events.some((event: any) => event.kind === "ws.dropped" && event.frame.id === task.id));
    assert.equal(frames.filter(frame => frame.type === "resource.changed").length, 0);
    await command("network", { dropResources: false });
    const hintCount = (await command("snapshot")).events.filter((event: any) => ["ws.forwarded", "ws.dropped"].includes(event.kind) && event.frame.type === "resource.changed").length;
    task = (await command("mcp", { transport: "stdio", name: "update_task",
      args: { taskId: task.id, expectedRevision: task.revision, title: "独立stdio提交" } })).task;
    assert.equal((await json(data.url, detail)).task.title, "独立stdio提交");
    const afterStdio = await command("snapshot");
    assert.equal(afterStdio.events.filter((event: any) => ["ws.forwarded", "ws.dropped"].includes(event.kind) && event.frame.type === "resource.changed").length, hintCount);

    const otherRoute = "/api/projects/" + second.project.id + "/tasks";
    const other = (await json(data.writeUrl, otherRoute, "POST", { title: "HTTP MCP 原稿" }, 201)).task;
    await command("mcp", { transport: "http", name: "update_task",
      args: { taskId: other.id, expectedRevision: other.revision, title: "HTTP MCP 提交" } });
    assert.equal((await json(data.url, otherRoute + "/" + other.id)).task.title, "HTTP MCP 提交");
    const closeEvent = new Promise<void>(resolve => socket!.addEventListener("close", () => resolve(), { once: true }));
    await command("network", { blocked: true }); await closeEvent;
    assert.equal((await fetch(data.url + detail)).status, 503);
    await command("network", { blocked: false });
    assert.equal((await json(data.url, detail)).task.title, task.title);
    const receipts = (await command("snapshot")).workEvents.filter((entry: any) => entry.task_id === task.id);
    assert.equal(receipts.length, 1); assert.equal(receipts[0].acked_at, null);
  } finally {
    socket?.close(); child.stdin.end();
    const code = await Promise.race([exited, delay(10000, undefined, { ref: false }).then(() => { child.kill("SIGTERM"); return -1; })]);
    assert.equal(code, 0, stderr);
    assert.ok(closed); assert.deepEqual(closed.failures, []);
    if (data) assert.equal(existsSync(data.root), false);
    lines.close();
  }
});

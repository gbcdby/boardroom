import test from "node:test";
import assert from "node:assert/strict";
import { createResourceReconciliation, type ResourceBrowser, type ResourceSocketHandlers } from "../src/web/src/composables/useResourceReconciliation.ts";
import { deferred, json, settle } from "./helpers/web-ui.ts";

function browserFixture() {
  let visible = true, visibility = () => {};
  const sockets: Array<{ handlers: ResourceSocketHandlers; sent: string[] }> = [];
  const intervals = new Map<() => void, number>(), timeouts = new Map<() => void, number>();
  const browser: ResourceBrowser = {
    isVisible: () => visible, onVisibility(listener) { visibility = listener; return () => { visibility = () => {}; }; },
    interval(callback, ms) { intervals.set(callback, ms); return () => { intervals.delete(callback); }; },
    timeout(callback, ms) { timeouts.set(callback, ms); return () => { timeouts.delete(callback); }; },
    connect(handlers) { const socket = { handlers, sent: [] as string[] }; sockets.push(socket); return { send: value => { socket.sent.push(value); }, close() {} }; },
  };
  return { browser, sockets, intervals, timeouts, hide() { visible = false; visibility(); }, show() { visible = true; visibility(); }, tick() { for (const callback of intervals.keys()) callback(); }, reconnect() { const callbacks = [...timeouts.keys()]; timeouts.clear(); callbacks.forEach(callback => callback()); } };
}

test("共用对账：同一刷新合并，条件 GET/304 保留快照；错误保留上次值与时间", async () => {
  const first = deferred<Response>(); let requests = 0; const headers: Headers[] = [], cacheModes: Array<RequestInit["cache"]> = [];
  const state = createResourceReconciliation<{ revision: number }>({ browser: null,
    fetch: async (_url, init) => { headers.push(new Headers(init?.headers)); cacheModes.push(init?.cache); requests++; if (requests === 1) return first.promise; if (requests === 2) return new Response(null, { status: 304 }); throw new Error("断线"); },
    read: (scope, reader) => reader.get(`/api/${scope.projectId}`),
  });
  try {
    const opening = state.setScope({ projectId: "p", key: "p:1" });
    const simultaneous = [state.refresh(), state.refresh(), state.refresh()];
    assert.equal(requests, 1);
    first.resolve(new Response('{"revision":1}', { headers: { etag: '"one"', "content-type": "application/json" } }));
    await Promise.all([opening, ...simultaneous]);
    const snapshot = state.value.value;
    await state.refresh(); assert.equal(state.value.value, snapshot); assert.equal(headers[1]!.get("if-none-match"), '"one"');
    const readAt = state.lastSuccessAt.value; await state.refresh();
    assert.equal(state.value.value, snapshot); assert.equal(state.lastSuccessAt.value, readAt); assert.match(state.error.value!, /断线/);
    assert.deepEqual(cacheModes, ["no-store", "no-store", "no-store"], "首次和条件读取均由应用缓存负责，不持有浏览器 HTTP 缓存项");
  } finally { state.dispose(); }
});

test("共用对账：旧项目/旧代际和提交前读迟到均不覆盖当前目标，实体版本不回退", async () => {
  const old = deferred<Response>(), beforeSave = deferred<Response>(); let pReads = 0;
  const state = createResourceReconciliation<{ revision: number; title: string }>({ browser: null,
    fetch: async url => String(url).endsWith("old") ? old.promise : ++pReads === 1 ? json({ revision: 2, title: "当前" }) : pReads === 2 ? beforeSave.promise : json({ revision: 1, title: "旧快照" }),
    read: (scope, reader) => reader.get(`/api/${scope.projectId}`),
    accepts: (incoming, current) => !current || incoming.revision >= current.revision,
  });
  try {
    const leaving = state.setScope({ projectId: "old", key: "old:1" });
    await state.setScope({ projectId: "new", key: "new:2" });
    old.resolve(json({ revision: 999, title: "旧项目" })); await leaving;
    assert.equal(state.value.value!.title, "当前");
    const pending = state.refresh();
    await state.committed(() => ({ revision: 3, title: "已提交" }));
    beforeSave.resolve(json({ revision: 2, title: "提交前读" })); await pending;
    assert.equal(state.value.value!.revision, 3); assert.equal(state.value.value!.title, "已提交");
    assert.match(state.error.value!, /旧版本/);
  } finally { state.dispose(); }
});

test("共用对账：迟到 mutation 回执沿用版本检查；同版和新版回执在补读断线时仍可发布", async () => {
  let reads = 0;
  const published: Array<{ revision: number; source: string }> = [];
  const state = createResourceReconciliation<{ revision: number; title: string }>({ browser: null,
    fetch: async () => { if (++reads === 1) return json({ revision: 3, title: "较新事实" }); throw new Error("回执后 GET 断线"); },
    read: (scope, reader) => reader.get(`/api/${scope.projectId}`),
    accepts: (incoming, current) => !current || incoming.revision >= current.revision,
    onValue: (value, source) => { published.push({ revision: value.revision, source }); },
  });
  try {
    await state.setScope({ projectId: "p", key: "p:1" });
    const observed = state.value.value, readAt = state.lastSuccessAt.value;
    await state.committed(() => ({ revision: 2, title: "迟到的旧回执" }));
    assert.equal(state.value.value, observed, "已提交不等于回执仍是当前版本");
    assert.deepEqual(published, [{ revision: 3, source: "read" }], "旧回执也不能通知消费者覆盖当前事实");
    assert.equal(state.lastSuccessAt.value, readAt);
    assert.match(state.error.value!, /GET 断线/);

    await state.committed(() => ({ revision: 3, title: "较新事实" }));
    await state.committed(() => ({ revision: 4, title: "后续已确认提交" }));
    assert.equal(state.value.value!.revision, 4);
    assert.equal(state.value.value!.title, "后续已确认提交");
    assert.deepEqual(published, [{ revision: 3, source: "read" }, { revision: 3, source: "mutation" }, { revision: 4, source: "mutation" }]);
    assert.equal(reads, 4, "每次成功写入仍补读，即使回执因旧版本未发布");
    assert.equal(state.lastSuccessAt.value, readAt, "mutation 成功不能伪装成 GET 成功");
  } finally { state.dispose(); }
});

test("共用对账：15秒可见兜底、隐藏暂停/恢复、重连、同版本提示和未知事件重新读取；心跳不等于对账", async () => {
  const f = browserFixture(); let requests = 0;
  const state = createResourceReconciliation<{ revision: number; comments: number }>({ browser: f.browser,
    fetch: async () => json({ revision: 1, comments: ++requests }), read: (scope, reader) => reader.get(`/api/${scope.projectId}`),
  });
  try {
    await state.setScope({ projectId: "p", key: "p:1" });
    const socket = f.sockets[0]!; socket.handlers.open(); socket.handlers.message(JSON.stringify({ type: "resource.subscribed", projectId: "p" })); await settle();
    assert.equal([...f.intervals.values()][0], 15000); const afterOpen = requests;
    socket.handlers.message(JSON.stringify({ type: "pong" })); await settle(); assert.equal(requests, afterOpen);
    socket.handlers.message(JSON.stringify({ type: "resource.changed", projectId: "p", entity: "task", id: "t", revision: 1 })); await settle(); assert.equal(requests, afterOpen + 1);
    f.tick(); await settle(); assert.equal(requests, afterOpen + 2, "掉包由15秒条件读取兜底");
    f.hide(); assert.equal(f.intervals.size, 0); f.tick(); await settle(); assert.equal(requests, afterOpen + 2);
    f.show(); await settle(); assert.equal(requests, afterOpen + 3);
    const last = state.value.value, time = state.lastSuccessAt.value;
    socket.handlers.close(); assert.equal(state.connection.value, "disconnected"); assert.equal(state.value.value, last); assert.equal(state.lastSuccessAt.value, time);
    f.reconnect(); const recovered = f.sockets[1]!; recovered.handlers.open(); recovered.handlers.message(JSON.stringify({ type: "resource.subscribed", projectId: "p" })); await settle(); assert.equal(requests, afterOpen + 4);
    recovered.handlers.message(JSON.stringify({ type: "future-resource-event" })); await settle(); assert.equal(requests, afterOpen + 5);
  } finally { state.dispose(); assert.equal(f.intervals.size, 0); assert.equal(f.timeouts.size, 0); }
});

test("共用对账：在途收到多个变化提示只补一次，不能将提示里的内容当实体事实", async () => {
  const f = browserFixture(), delayed = deferred<Response>(); let requests = 0;
  const state = createResourceReconciliation<{ revision: number; title: string }>({ browser: f.browser,
    fetch: async () => ++requests === 2 ? delayed.promise : json({ revision: requests, title: "GET 权威值" }), read: (scope, reader) => reader.get(`/api/${scope.projectId}`),
  });
  try {
    await state.setScope({ projectId: "p", key: "p:1" });
    const socket = f.sockets[0]!; socket.handlers.open();
    const reading = state.refresh();
    for (let i = 0; i < 4; i++) socket.handlers.message(JSON.stringify({ type: "resource.changed", projectId: "p", entity: "task", id: "t", revision: 999, title: "不能采用" }));
    assert.equal(requests, 2); assert.equal(state.value.value!.title, "GET 权威值");
    delayed.resolve(json({ revision: 2, title: "提示前旧读" })); await reading;
    assert.equal(requests, 3); assert.equal(state.value.value!.title, "GET 权威值"); assert.equal(state.value.value!.revision, 3);
  } finally { state.dispose(); }
});

test("共用对账：掉包导致 GET 挂起不能永久占用兜底；超时后的迟到结果不能覆盖新读取", async () => {
  const f = browserFixture(), lost = deferred<Response>(); let requests = 0;
  const state = createResourceReconciliation<{ revision: number }>({ browser: f.browser,
    fetch: async () => ++requests === 2 ? lost.promise : json({ revision: requests }), read: (scope, reader) => reader.get(`/api/${scope.projectId}`),
  });
  try {
    await state.setScope({ projectId: "p", key: "p:1" });
    const blocked = state.refresh();
    const timeout = [...f.timeouts].find(([, ms]) => ms === 10000); assert.ok(timeout, "当前读取须有有界超时");
    timeout[0](); await blocked;
    assert.equal(state.value.value!.revision, 1); assert.match(state.error.value!, /超时/);
    f.tick(); await settle(); assert.equal(state.value.value!.revision, 3);
    lost.resolve(json({ revision: 2 })); await settle(); assert.equal(state.value.value!.revision, 3);
  } finally { state.dispose(); }
});

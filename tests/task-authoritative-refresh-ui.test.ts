import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { identityFixture } from "./helpers/identity-fixture.ts";
import { decisionDomainFixture } from "./helpers/decision-domain-fixture.ts";
import { initializePolicyConfiguration } from "../src/server/policy/configuration.ts";
import { createTaskApi } from "../src/server/tasks/api.ts";
import { createLogger } from "../src/server/logger.ts";
import type { ResourceBrowser, ResourceSocketHandlers } from "../src/web/src/composables/useResourceReconciliation.ts";
import { byTestId, deferred, find, input, json, settle, submit, textOf, withPage } from "./helpers/web-ui.ts";

// The SFC and Task/Decision HTTP routes are real. Only delivery of an already
// completed GET and the ResourceBrowser clock are controlled, not DB facts.
function controlledBrowser(projectId: string, taskId: string) {
  let now = 0, sequence = 0;
  const timers = new Map<number, { at: number; every: number; run: () => void }>();
  const sockets = new Set<ResourceSocketHandlers>();
  function schedule(run: () => void, delay: number, every: number) {
    const id = ++sequence; timers.set(id, { at: now + delay, every, run });
    return () => { timers.delete(id); };
  }
  const browser: ResourceBrowser = {
    isVisible: () => true, onVisibility: () => () => {},
    interval: (run, ms) => schedule(run, ms, ms), timeout: (run, ms) => schedule(run, ms, 0),
    connect(handlers) { sockets.add(handlers); return { send() {}, close() { sockets.delete(handlers); } }; },
  };
  return { browser,
    hint(entity: "task" | "decision") { for (const socket of sockets) socket.message(JSON.stringify({
      type: "resource.changed", projectId, entity, id: entity === "task" ? taskId : projectId, revision: 1,
    })); },
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next; now = timer.at;
        if (timer.every) timer.at += timer.every; else timers.delete(id);
        timer.run(); await settle();
      }
      now = end;
    },
  };
}

type Call = { url: string; method: string; body: string | undefined; status: number; result: any };
async function withHttpPage(mode: "review" | "task", check: (context: {
  container: Parameters<Parameters<typeof withPage>[2]>[0];
  f: Awaited<ReturnType<typeof identityFixture>>; p: Awaited<ReturnType<typeof decisionDomainFixture>>;
  task: Awaited<ReturnType<typeof decisionDomainFixture>>["task"];
  clock: ReturnType<typeof controlledBrowser>; calls: Call[]; flush(): Promise<void>;
  request(url: string, method: string, body?: unknown): Promise<Call>;
  navigate(taskId: string): Promise<void>;
  holdGet(match: (url: string) => boolean): { ready: Promise<Call>; release(): void; aborted(): boolean };
  holdPost(match: (url: string) => boolean): { ready: Promise<Call>; release(): void; aborted(): boolean };
}) => Promise<void>) {
  const f = await identityFixture(), nativeFetch = globalThis.fetch.bind(globalThis);
  let server: ReturnType<typeof createServer> | undefined;
  const releases: Array<() => void> = [];
  try {
    await initializePolicyConfiguration(f.repos);
    const p = await decisionDomainFixture(f.repos);
    const task = mode === "review" ? p.task : await p.service.create(p.owner, p.project.id, { title: "原始任务", body: "原始目标" });
    const clock = controlledBrowser(p.project.id, task.id);
    const api = createTaskApi({ db: f.db, logger: createLogger({ write() {} }) });
    server = createServer((req, res) => {
      void api.handle(req, res, new URL(req.url ?? "/", "http://127.0.0.1").pathname)
        .then(done => { if (!done) { res.statusCode = 404; res.end(); } });
    });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`, pending = new Set<Promise<unknown>>(), calls: Call[] = [];
    type Gate = { method: string; match(url: string): boolean; ready: ReturnType<typeof deferred<Call>>; release: ReturnType<typeof deferred<void>>; signal: AbortSignal | null };
    let nextGate: Gate | undefined;
    function holdResponse(method: string, match: (url: string) => boolean) {
      assert.equal(nextGate, undefined);
      const gate: Gate = { method, match, ready: deferred<Call>(), release: deferred<void>(), signal: null };
      nextGate = gate; releases.push(() => gate.release.resolve());
      return { ready: gate.ready.promise, release: () => gate.release.resolve(), aborted: () => gate.signal?.aborted ?? false };
    }
    async function request(url: string, method: string, body?: unknown): Promise<Call> {
      const response = await nativeFetch(origin + url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
      return { url, method, body: body === undefined ? undefined : JSON.stringify(body), status: response.status, result: await response.json() };
    }
    async function flush() {
      for (let step = 0; step < 20; step++) {
        await Promise.allSettled([...pending]); await settle(); if (!pending.size) return;
      }
      throw new Error("actual HTTP reads did not settle");
    }
    await withPage("TaskDetailView", (url, init) => {
      if (url.endsWith("/org")) return json({ members: [p.worker, p.reviewer, p.manager], nodes: [], roles: [] });
      if (!url.includes("/tasks/") && !url.includes("/decisions")) return json({ projects: [{ ...p.project, manager: null }] });
      const method = init?.method ?? "GET", gate = method === nextGate?.method && nextGate.match(url) ? nextGate : undefined;
      if (gate) { nextGate = undefined; gate.signal = init?.signal ?? null; }
      const wire = nativeFetch(origin + url, init).then(async response => {
        const bytes = await response.arrayBuffer();
        const call: Call = { url, method, body: typeof init?.body === "string" ? init.body : undefined,
          status: response.status, result: bytes.byteLength ? JSON.parse(new TextDecoder().decode(bytes)) : null };
        calls.push(call); gate?.ready.resolve(call);
        return { call, bytes, headers: response.headers };
      });
      pending.add(wire); void wire.finally(() => pending.delete(wire)).catch(() => {});
      return wire.then(async ({ call, bytes, headers }) => {
        if (gate) await gate.release.promise;
        // A late completed response can still arrive after cancellation. The
        // production resource generation, not the transport fixture, rejects it.
        return new Response(call.status === 304 ? null : bytes, { status: call.status, headers });
      });
    }, async (container, { router }) => {
      await flush();
      try { await check({ container, f, p, task, clock, calls, flush, request,
        navigate: async id => { await router.push(`/projects/${p.project.id}/tasks/${id}`); await flush(); },
        holdGet: match => holdResponse("GET", match), holdPost: match => holdResponse("POST", match) }); }
      finally { for (const release of releases) release(); await flush(); }
    }, { path: `/projects/${p.project.id}/tasks/${task.id}`, resourceBrowser: clock.browser });
  } finally {
    for (const release of releases) release();
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    await f.close();
  }
}

test("SFC actual HTTP：提案提交直接重读决定，五秒内不等待提示前的旧 GET", async () => {
  await withHttpPage("review", async ({ container, f, p, task, clock, calls, flush, holdGet }) => {
    assert.match(textOf(byTestId(container, "decision-proposed-action")), /通过评审并标记任务完成/);
    const old = holdGet(url => url.includes("/decisions?"));
    clock.hint("decision"); await old.ready; await flush();
    await input(byTestId(container, "task-decision-reason"), "明确建立需要修改的提案");
    const saving = submit(byTestId(container, "task-decide"));
    await flush();
    const receipt = calls.find(call => call.method === "POST" && call.url.endsWith("/decision-requests"));
    assert.equal(receipt?.status, 202); assert.equal(receipt.result.state, "pending");
    assert.equal(receipt.result.receipt.execution, null);
    clock.hint("decision"); await clock.advance(5_000); await flush();
    assert.match(textOf(byTestId(container, "decision-proposed-action")), /要求修改并返回进行中/);
    assert.equal(old.aborted(), true, "已确认本地写入应废弃更早的在途读取");
    old.release(); await saving; await flush();
    assert.match(textOf(byTestId(container, "decision-proposed-action")), /要求修改并返回进行中/);
    assert.equal((await p.service.get(p.owner, p.project.id, task.id)).task.revision, task.revision);
    for (const table of ["decision_executions", "decision_resolutions", "decision_local_initiations"])
      assert.equal((await f.db.query(`SELECT * FROM ${table}`)).length, 0, `${table}: 重读不等于明确选择`);
    assert.equal(calls.filter(call => call.method === "POST").length, 1);
  });
});

test("SFC actual HTTP：提案回执晚于后继提交，只采用权威重读的当前决定", async () => {
  await withHttpPage("review", async ({ container, f, p, task, calls, flush, request, holdPost }) => {
    const delayed = holdPost(url => url.endsWith("/decision-requests"));
    await input(byTestId(container, "task-decision-reason"), "先明确提出需要修改");
    const saving = submit(byTestId(container, "task-decide"));
    const old = await delayed.ready;
    assert.equal(old.status, 202); assert.equal(old.result.state, "pending");
    const successor = await request(old.url, "POST", {
      expectedTaskRevision: task.revision, expectedRoundRevision: p.round.revision,
      proposedVerdict: "pass", reason: "另一明确请求建立较新的通过提案", requestedPath: "management",
      expectedHead: old.result.head, idempotencyKey: "later-authoritative-proposal",
    });
    assert.equal(successor.status, 202);
    assert.equal(successor.result.head.headRevision, old.result.head.headRevision + 1);
    delayed.release(); await saving; await flush();
    assert.match(textOf(byTestId(container, "decision-proposed-action")), /通过评审并标记任务完成/);
    assert.match(textOf(byTestId(container, "decision-panel")), /另一明确请求建立较新的通过提案/);
    const read = calls.filter(call => call.method === "GET" && call.url.includes("/decisions?")).at(-1)!;
    assert.equal(read.status, 200);
    assert.equal(read.result.decisions.find((decision: any) => decision.isCurrent)?.ref.decisionId, successor.result.decisionRef.decisionId);
    assert.equal((await f.db.query("SELECT * FROM decision_executions")).length, 0);
    assert.equal(calls.some(call => call.url.endsWith("/choices")), false);
  });
});

test("SFC actual HTTP：409后手动重载废弃旧 GET，保留草稿和原 CAS 直到明确采用", async () => {
  await withHttpPage("task", async ({ container, p, task, clock, calls, flush, request, holdGet }) => {
    await byTestId(container, "task-edit-open").props.onClick();
    await input(byTestId(container, "task-title"), "保留我的任务标题");
    const url = `/api/projects/${p.project.id}/tasks/${task.id}`;
    const old = holdGet(candidate => candidate === url);
    clock.hint("task"); await old.ready; await flush();
    const updated = await request(url, "PATCH", { expectedRevision: task.revision, title: "他人标题", body: "远端更新的目标" });
    assert.equal(updated.status, 200);
    await submit(byTestId(container, "task-save")); await flush();
    assert.equal(calls.filter(call => call.method === "PATCH").at(-1)?.status, 409);
    assert.match(textOf(byTestId(container, "task-conflict")), /保留/);
    const reloading = byTestId(container, "task-reload").props.onClick();
    await clock.advance(5_000); await flush();
    assert.match(textOf(byTestId(container, "task-notice")), /已载入最新版本/);
    assert.equal(old.aborted(), true);
    assert.equal(byTestId(container, "task-title").value, "保留我的任务标题");
    assert.match(textOf(byTestId(container, "task-draft-base")), new RegExp(`版本 ${task.revision}`));
    assert.match(textOf(byTestId(container, "task-remote-changes")), /远端更新的目标/);
    assert.equal(byTestId(container, "task-save").props.disabled, true);
    old.release(); await reloading; await flush();
    assert.match(textOf(byTestId(container, "task-remote-changes")), /远端更新的目标/);
    await byTestId(container, "task-rebase").props.onClick(); await flush();
    assert.equal(byTestId(container, "task-body").value, "远端更新的目标");
    await submit(byTestId(container, "task-save")); await flush();
    const patch = calls.filter(call => call.method === "PATCH");
    assert.deepEqual(patch.map(call => JSON.parse(call.body!)), [
      { title: "保留我的任务标题", expectedRevision: task.revision },
      { title: "保留我的任务标题", expectedRevision: task.revision + 1 },
    ]);
    const current = await request(url, "GET");
    assert.equal(current.result.task.body, "远端更新的目标");
    assert.equal(current.result.task.title, "保留我的任务标题");
    assert.equal(find(container, node => node.props["data-testid"] === "task-conflict"), undefined);
  });
});

test("SFC actual HTTP：重载期间切换任务，迟到旧读不覆盖新任务或显示旧成功提示", async () => {
  await withHttpPage("task", async ({ container, p, task, calls, flush, request, holdGet, navigate }) => {
    const other = await p.service.create(p.owner, p.project.id, { title: "切换后的任务", body: "新任务内容" });
    await byTestId(container, "task-edit-open").props.onClick();
    await input(byTestId(container, "task-title"), "离开前的草稿");
    const url = `/api/projects/${p.project.id}/tasks/${task.id}`;
    assert.equal((await request(url, "PATCH", { expectedRevision: task.revision, title: "旧任务的远端修改" })).status, 200);
    await submit(byTestId(container, "task-save")); await flush();
    assert.equal(calls.filter(call => call.method === "PATCH").at(-1)?.status, 409);
    const old = holdGet(candidate => candidate === url);
    const reloading = byTestId(container, "task-reload").props.onClick(); await old.ready;
    await navigate(other.id);
    assert.equal(old.aborted(), true);
    old.release(); await reloading; await flush();
    assert.equal(textOf(find(container, node => node.type === "h1")!), "切换后的任务");
    assert.equal(find(container, node => node.props["data-testid"] === "task-notice"), undefined);
    assert.equal(find(container, node => node.props["data-testid"] === "task-title"), undefined);
    assert.equal(calls.filter(call => call.method === "PATCH").length, 1, "切换和重读不能重放旧保存");
  });
});

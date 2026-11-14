import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { identityFixture } from "./helpers/identity-fixture.ts";
import { decisionDomainFixture } from "./helpers/decision-domain-fixture.ts";
import { initializePolicyConfiguration, createPolicyConfiguration } from "../src/server/policy/configuration.ts";
import { createTaskApi } from "../src/server/tasks/api.ts";
import { createLogger } from "../src/server/logger.ts";
import { createDecisionService } from "../src/server/decisions/service.ts";
import type { ResourceBrowser, ResourceSocketHandlers } from "../src/web/src/composables/useResourceReconciliation.ts";
import { byTestId, deferred, find, input, json, select, settle, submit, textOf, withPage } from "./helpers/web-ui.ts";

function browserFixture(projectId = "p", taskId = "t") {
  const sockets = new Set<ResourceSocketHandlers>();
  const browser: ResourceBrowser = { isVisible: () => true, onVisibility: () => () => {}, interval: () => () => {}, timeout: () => () => {},
    connect(handlers) { sockets.add(handlers); return { send() {}, close() { sockets.delete(handlers); } }; } };
  return { browser, hint(entity = "task", revision = 1) { for (const socket of sockets) socket.message(JSON.stringify({ type: "resource.changed", projectId, entity, id: entity === "task" ? taskId : projectId, revision })); }, close() { for (const socket of sockets) socket.close(); } };
}
const project = { id: "p", name: "刷新项目", archivedAt: null, manager: null };
const materialStatus = { scope: "task-materials", executionAdmission: "not-issued", startExecution: { reasonCodes: [], issues: [] }, submitReview: { reasonCodes: [], issues: [] }, complete: { reasonCodes: [], issues: [] } };
const task = { id: "t", projectId: "p", title: "原始标题", body: "原始目标", deliveryKind: null, acceptanceText: "", acceptanceSource: "explicit", materialStatus, labels: [], state: "todo", assigneeMemberId: null, reviewerMemberId: null, repoPath: null, fixedPoint: null, revision: 1, currentReviewRoundId: null, blockedReason: null, author: { kind: "human", actorId: "local", displayName: "人" }, createdAt: "2026-11-12T00:00:00Z", updatedAt: "2026-11-12T00:00:00Z" };
const org = { members: ["a", "b"].map(id => ({ id, kind: "agent", projectId: "p", status: "active", displayName: id, nodeId: null })), nodes: [], roles: [] };

// Protocol fixtures for the SFC harness; production HTTP/DB behavior is covered
// separately by decisions-ui.test.ts. A bare {task} is no longer a receipt.
function decisionReceipt(current: unknown, state: "applied" | "pending" | "refreshed" = "applied") {
  const ref = { decisionId: "decision", projectId: "p", revision: state === "pending" ? 1 : 2, actionDigest: `sha256:${"a".repeat(64)}` };
  return { schemaVersion: "decision-response/v1", state, reason: state === "refreshed" ? "policy_changed" : null,
    task: current, decisionRef: ref, requiredAuthority: "human", blockedReason: null,
    receipt: { receiptId: "receipt", result: state, httpStatus: state === "refreshed" ? 409 : state === "pending" ? 202 : 200,
      execution: state === "applied" ? { status: "succeeded" } : null },
    current: { recordKind: "live-review-decision", ref } };
}

async function nativeProposalPage(loseReply: boolean | "choice", check: (context: {
  f: Awaited<ReturnType<typeof identityFixture>>; p: Awaited<ReturnType<typeof decisionDomainFixture>>;
  container: Parameters<Parameters<typeof withPage>[2]>[0];
  flush: () => Promise<void>; hint: () => void;
  setWriteDenial: (status: 403 | 409 | null) => void;
  calls: Array<{ url: string; method: string; body: string | undefined; status: number | undefined }>;
}) => Promise<void>) {
  const f = await identityFixture(), nativeFetch = globalThis.fetch.bind(globalThis);
  let server: ReturnType<typeof createServer> | undefined;
  try {
    await initializePolicyConfiguration(f.repos);
    const p = await decisionDomainFixture(f.repos), browser = browserFixture(p.project.id, p.task.id);
    const api = createTaskApi({ db: f.db, logger: createLogger({ write() {} }) });
    let writeDenial: 403 | 409 | null = null;
    // A controlled HTTP admission fault after an earlier real commit is not a
    // receipt. Neither status proves what happened to the original command.
    server = createServer((req, res) => {
      if (writeDenial && req.method === "POST") {
        res.writeHead(writeDenial, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: writeDenial === 403 ? "forbidden" : "head_revision_conflict", message: "test admission rejects retry without reading its original receipt" } })); return;
      }
      void api.handle(req, res, new URL(req.url ?? "/", "http://127.0.0.1").pathname).then(done => { if (!done) { res.statusCode = 404; res.end(); } });
    });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const pending = new Set<Promise<Response>>(), calls: Array<{ url: string; method: string; body: string | undefined; status: number | undefined }> = [];
    async function flush() {
      for (let step = 0; step < 12; step++) { await Promise.allSettled([...pending]); await settle(); if (!pending.size) return; }
      throw new Error("real HTTP UI did not settle");
    }
    await withPage("TaskDetailView", (url, init) => {
      if (url.endsWith("/org")) return json({ members: [p.worker, p.reviewer, p.manager], nodes: [], roles: [] });
      if (!url.includes("/tasks/") && !url.includes("/decisions")) return json({ projects: [{ ...p.project, manager: null }] });
      const call = { url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined, status: undefined as number | undefined };
      calls.push(call);
      const request = nativeFetch(origin + url, init).then(async response => {
        call.status = response.status;
        if (loseReply && call.method === "POST" && url.endsWith(loseReply === "choice" ? "/choices" : "/decision-requests")) {
          assert.equal(response.status, loseReply === "choice" ? 200 : 202); loseReply = false;
          await response.arrayBuffer(); throw new Error("lost original reply after actual commit");
        }
        return response;
      });
      pending.add(request); void request.finally(() => pending.delete(request)).catch(() => {}); return request;
    }, async container => { await flush(); await check({ f, p, container, flush, hint: () => browser.hint("decision"),
      setWriteDenial: status => { writeDenial = status; }, calls }); },
    { path: `/projects/${p.project.id}/tasks/${p.task.id}`, resourceBrowser: browser.browser });
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    await f.close();
  }
}

test("SFC #157 actual HTTP：替代提案固定head/CAS/key，丢回复后原样重试；明确choices前Task与来源零效果", async () => {
  await nativeProposalPage(true, async ({ f, p, container, flush, hint, setWriteDenial, calls }) => {
    const service = createDecisionService(f.db);
    const before = (await service.list(p.owner, p.project.id)).decisions.find(d => d.recordKind === "live-review-decision")!;
    assert.equal(before.recordKind, "live-review-decision"); if (before.recordKind !== "live-review-decision") throw new Error("missing live proposal");
    await input(byTestId(container, "task-decision-reason"), "明确提出需要修改的替代提案");
    assert.match(textOf(byTestId(container, "task-decide")), /建立替代提案/);
    await submit(byTestId(container, "task-decide")); await flush();
    const first = calls.find(c => c.method === "POST")!;
    assert.ok(first.url.endsWith("/decision-requests")); assert.equal(first.status, 202);
    const sent = JSON.parse(first.body!);
    assert.deepEqual(sent.expectedHead, before.head);
    assert.equal(sent.expectedTaskRevision, p.task.revision); assert.equal(sent.expectedRoundRevision, p.round.revision);
    assert.equal(sent.proposedVerdict, "changes_requested"); assert.equal(sent.requestedPath, "management"); assert.ok(sent.idempotencyKey);
    for (const id of ["task-decision-verdict", "task-decision-reason", "task-decision-discard", "decision-choice"])
      assert.equal(byTestId(container, id).props.disabled, true);
    for (const status of [403, 409] as const) {
      setWriteDenial(status); await byTestId(container, "task-decision-retry").props.onClick(); await flush();
      assert.equal(calls.filter(c => c.method === "POST").at(-1)!.status, status);
      assert.equal(byTestId(container, "task-decision-reason").props.disabled, true);
      assert.equal(byTestId(container, "task-decision-retry").props.disabled, false, "非回执拒绝不能解除原未知命令");
      assert.equal(byTestId(container, "task-decision-reason").value, "明确提出需要修改的替代提案");
    }
    setWriteDenial(null);
    hint(); await flush();
    assert.equal(byTestId(container, "task-decision-reason").value, "明确提出需要修改的替代提案");
    assert.match(textOf(byTestId(container, "task-decision-base")), new RegExp(before.head.currentDecisionId));
    assert.equal(byTestId(container, "task-decision-rebase").props.disabled, true);
    await byTestId(container, "task-decision-retry").props.onClick(); await flush();
    const proposals = calls.filter(c => c.method === "POST" && c.url.endsWith("/decision-requests"));
    assert.equal(proposals.length, 4); for (const attempt of proposals) { assert.equal(attempt.url, first.url); assert.equal(attempt.body, first.body); }
    assert.equal(proposals.at(-1)!.status, 202);
    assert.match(textOf(byTestId(container, "task-notice")), /只建立替代提案.*未应用任务结论/);
    assert.equal((await p.service.get(p.owner, p.project.id, p.task.id)).task.state, "review");
    assert.equal((await f.db.query("SELECT * FROM decision_records")).length, 2);
    assert.equal((await f.db.query("SELECT * FROM decision_command_receipts WHERE operation='request-review'")).length, 1);
    for (const table of ["decision_resolutions", "decision_executions", "decision_user_events", "decision_local_initiations"])
      assert.equal((await f.db.query(`SELECT * FROM ${table}`)).length, 0, table + " must remain empty before choice");
    assert.equal(calls.some(c => c.method === "POST" && (c.url.endsWith("/decision") || c.url.endsWith("/choices"))), false);
    await input(byTestId(container, "decision-choice-reason"), "另行核对替代提案后同意应用");
    await submit(byTestId(container, "decision-submit")); await flush();
    assert.equal((await p.service.get(p.owner, p.project.id, p.task.id)).task.state, "in-progress");
    assert.equal((await f.db.query("SELECT * FROM decision_executions WHERE status='succeeded'")).length, 1);
    assert.equal((await f.db.query("SELECT * FROM decision_user_events")).length, 1);
    assert.equal(calls.filter(c => c.method === "POST" && c.url.endsWith("/choices")).length, 1);
  });
});

test("SFC #157 actual HTTP：head冲突与policy刷新不换草稿基准，读取后明确采用才可新key提交", async () => {
  await nativeProposalPage(false, async ({ f, p, container, flush, hint, calls }) => {
    const service = createDecisionService(f.db);
    const first = (await service.list(p.owner, p.project.id)).decisions.find(d => d.recordKind === "live-review-decision")!;
    if (first.recordKind !== "live-review-decision") throw new Error("missing live proposal");
    await input(byTestId(container, "task-decision-reason"), "头变化不能自动同意替代");
    const changed = await service.request(p.owner, p.slot, { expectedTaskRevision: p.task.revision, expectedRoundRevision: p.round.revision,
      proposedVerdict: "changes_requested", reason: "其他主体先明确改为需要修改", requestedPath: "management", expectedHead: first.head, idempotencyKey: "external-changes" });
    assert.equal(changed.head.headRevision, first.head.headRevision + 1);
    assert.notEqual(changed.decisionRef.decisionId, first.ref.decisionId);
    assert.notEqual(changed.decisionRef.actionDigest, first.ref.actionDigest);
    // A matching head on the same pending action is deduplicated (REQ001).
    // Two real opposite-action replacements return to pass with a newer head,
    // preserving the original UI draft/409/rebase scenario below.
    const external = await service.request(p.owner, p.slot, { expectedTaskRevision: p.task.revision, expectedRoundRevision: p.round.revision,
      proposedVerdict: "pass", reason: "其他主体再明确提出通过", requestedPath: "management", expectedHead: changed.head, idempotencyKey: "external-proposal" });
    assert.equal(external.head.headRevision, changed.head.headRevision + 1);
    assert.notEqual(external.decisionRef.decisionId, changed.decisionRef.decisionId);
    assert.equal(external.decisionRef.actionDigest, first.ref.actionDigest);
    await submit(byTestId(container, "task-decide")); await flush();
    const rejected = calls.find(c => c.method === "POST")!;
    assert.equal(rejected.status, 409);
    assert.match(textOf(byTestId(container, "task-error")), /当前提案版本已变化/);
    assert.equal(byTestId(container, "task-decision-rebase").props.disabled, true);
    await submit(byTestId(container, "task-decide")); await flush();
    assert.equal(calls.filter(c => c.method === "POST").length, 1, "冲突后不能在未读当前提案时换key盲重发");
    hint(); await flush();
    assert.equal(byTestId(container, "task-decision-reason").value, "头变化不能自动同意替代");
    assert.match(textOf(byTestId(container, "task-decision-base")), new RegExp(first.head.currentDecisionId));
    await byTestId(container, "task-decision-rebase").props.onClick(); await flush();
    assert.equal(calls.filter(c => c.method === "POST").length, 1, "采用基准不发送请求");

    // A policy refresh changes the Decision revision without changing head or
    // Task/Round. The still-unsent proposal draft must remain pinned as well.
    const current = (await service.list(p.owner, p.project.id)).decisions.find(d => d.recordKind === "live-review-decision" && d.isCurrent)!;
    if (current.recordKind !== "live-review-decision") throw new Error("missing current proposal");
    const policy = createPolicyConfiguration({ repos: f.repos }), global = await policy.getGlobal(p.owner);
    await policy.updateGlobal(p.owner, { expectedRevision: global.ref.revision,
      rules: global.document.rules.map(rule => rule.ruleId === "default.review.decide" ? { ...rule, reason: "真实规则更新" } : rule) });
    const refreshed = await service.refresh(p.owner, p.project.id, current.ref.decisionId, { decisionRef: current.ref, idempotencyKey: "external-refresh" });
    assert.equal(refreshed.state, "refreshed"); hint(); await flush();
    assert.equal(byTestId(container, "task-decide").props.disabled, true);
    assert.match(textOf(byTestId(container, "task-decision-base")), new RegExp(`决定版本 ${current.ref.revision}`));
    assert.equal(byTestId(container, "task-decision-reason").value, "头变化不能自动同意替代");
    await byTestId(container, "task-decision-rebase").props.onClick(); await flush();
    await submit(byTestId(container, "task-decide")); await flush();
    const accepted = calls.filter(c => c.method === "POST").at(-1)!;
    assert.equal(accepted.status, 202);
    const a = JSON.parse(accepted.body!), b = JSON.parse(rejected.body!);
    assert.notEqual(a.idempotencyKey, b.idempotencyKey); assert.deepEqual(a.expectedHead, current.head);
    assert.equal(a.reason, b.reason); assert.equal(a.proposedVerdict, "changes_requested");
    assert.equal((await p.service.get(p.owner, p.project.id, p.task.id)).task.state, "review");
    assert.equal((await f.db.query("SELECT * FROM decision_executions")).length, 0);
    assert.equal((await f.db.query("SELECT * FROM decision_local_initiations")).length, 0);
  });
});

test("SFC #157 actual HTTP：choices已提交但回复丢失，403/409拒绝重试不解除原未知锁", async () => {
  await nativeProposalPage("choice", async ({ f, container, flush, hint, setWriteDenial, calls }) => {
    await input(byTestId(container, "decision-choice-reason"), "只能以原选择确认已提交结果");
    await submit(byTestId(container, "decision-submit")); await flush();
    const original = calls.find(c => c.method === "POST")!;
    assert.ok(original.url.endsWith("/choices")); assert.equal(original.status, 200);
    assert.equal((await f.db.query("SELECT * FROM decision_executions WHERE status='succeeded'")).length, 1);
    for (const status of [403, 409] as const) {
      setWriteDenial(status); await byTestId(container, "decision-retry").props.onClick(); await flush();
      assert.equal(calls.filter(c => c.method === "POST").at(-1)!.status, status);
      assert.equal(byTestId(container, "decision-choice-reason").value, "只能以原选择确认已提交结果");
      for (const id of ["decision-choice", "decision-choice-reason", "task-decision-reason"])
        assert.equal(byTestId(container, id).props.disabled, true, id + " cannot unlock without a receipt");
      assert.equal(byTestId(container, "decision-retry").props.disabled, false);
    }
    setWriteDenial(null); hint(); await flush();
    assert.match(textOf(byTestId(container, "decision-state")), /选择已记录/);
    await byTestId(container, "decision-retry").props.onClick(); await flush();
    const choices = calls.filter(c => c.method === "POST");
    assert.equal(choices.length, 4); for (const attempt of choices) { assert.equal(attempt.url, original.url); assert.equal(attempt.body, original.body); }
    assert.equal(find(container, node => node.props["data-testid"] === "decision-retry"), undefined);
    for (const table of ["decision_resolutions", "decision_executions", "decision_user_events", "decision_local_initiations"])
      assert.equal((await f.db.query(`SELECT * FROM ${table}`)).length, 1, table + " remains a single committed fact");
  });
});

test("SFC #157：管理命令 pending/refreshed 不冒称已应用；刷新保留理由和原基准", async t => {
  for (const state of ["pending", "refreshed"] as const) await t.test(state, async () => {
    const f = browserFixture(), current = { ...task, state: "review", currentReviewRoundId: "round" };
    const reports = ["spec", "standards"].map(axis => ({ id: axis, roundId: "round", axis, body: "报告", verdict: "pass", sources: [], evidence: {} }));
    const writes: string[] = [];
    await withPage("TaskDetailView", (url, init) => {
      if (init?.method === "POST") {
        writes.push(String(init.body)); return json(decisionReceipt(current, state), state === "pending" ? 202 : 409);
      }
      if (url.endsWith("/tasks/t")) return json({ task: current, comments: [], history: [], rounds: [{ id: "round", revision: 1, state: "reported", createdAt: task.createdAt, candidate: null }], reports, messageLinks: [] });
      if (url.endsWith("/org")) return json(org);
      if (url.includes("/decisions?")) return json({ decisions: [], cursor: 0 });
      return json({ projects: [project] });
    }, async container => {
      await input(byTestId(container, "task-decision-reason"), "核对当前候选的管理理由");
      await submit(byTestId(container, "task-decide")); await settle();
      assert.equal(writes.length, 1);
      assert.match(textOf(byTestId(container, "task-state")), /评审中/);
      assert.doesNotMatch(textOf(byTestId(container, "task-notice")), /裁决已保存并应用/);
      if (state === "pending") {
        assert.match(textOf(byTestId(container, "task-notice")), /提案已保存，等待人的明确选择/);
        assert.equal(byTestId(container, "task-decision-reason").value, "");
      } else {
        assert.match(textOf(byTestId(container, "task-notice")), /本次只更新了评估/);
        assert.equal(byTestId(container, "task-decision-reason").value, "核对当前候选的管理理由");
        assert.match(textOf(byTestId(container, "task-decision-base")), /任务版本 1.*round \/ 版本 1/);
        assert.equal(byTestId(container, "task-decide").props.disabled, true);
        await submit(byTestId(container, "task-decide"));
        assert.equal(writes.length, 1, "旧兼容命令不能通过再次点击悄悄采用新策略");
      }
    }, { path: "/projects/p/tasks/t", resourceBrowser: f.browser });
  });
});

test("SFC #157：管理命令结果未知锁住原请求；远端对账后只允许同完整输入重试", async () => {
  const f = browserFixture(); let current = { ...task, state: "review", currentReviewRoundId: "round" }, lose = true;
  const reports = ["spec", "standards"].map(axis => ({ id: axis, roundId: "round", axis, body: "报告", verdict: "pass", sources: [], evidence: {} }));
  const ref = { decisionId: "choice", projectId: "p", revision: 1, actionDigest: `sha256:${"b".repeat(64)}` };
  const live = { recordKind: "live-review-decision", ref, isCurrent: true, head: { headRevision: 1 }, status: "pending", freshness: "current",
    actionRequest: { roundId: "round", action: { payload: { choice: "pass" } }, proposalReason: "当前提案" },
    allowedOperations: ["approve", "reject", "request_changes"], requiredAuthority: "human", blockedReason: null, resolution: null };
  const writes: Array<{ url: string; body: string }> = [];
  await withPage("TaskDetailView", (url, init) => {
    if (init?.method === "POST") {
      writes.push({ url, body: String(init.body) });
      if (lose) { lose = false; return Promise.reject(new Error("response lost")); }
      return json(decisionReceipt(current));
    }
    if (url.endsWith("/tasks/t")) return json({ task: current, comments: [], history: [], rounds: [{ id: "round", revision: current.revision, state: "reported", createdAt: task.createdAt, candidate: null }], reports, messageLinks: [] });
    if (url.endsWith("/org")) return json(org);
    if (url.includes("/decisions?")) return json({ decisions: [live], cursor: 1 });
    return json({ projects: [project] });
  }, async container => {
    await select(byTestId(container, "task-decision-verdict"), "pass");
    await input(byTestId(container, "task-decision-reason"), "不能换成其他命令的理由");
    await submit(byTestId(container, "task-decide")); await settle();
    assert.match(textOf(byTestId(container, "task-error")), /原样重试/);
    for (const id of ["task-decision-reason", "task-decision-verdict", "task-decision-discard", "decision-choice-reason", "decision-choice"])
      assert.equal(byTestId(container, id).props.disabled, true, `${id} 在结果未知时锁定`);
    current = { ...current, revision: 2 }; f.hint("task", 2); await settle();
    assert.equal(byTestId(container, "task-decision-reason").value, "不能换成其他命令的理由");
    assert.match(textOf(byTestId(container, "task-decision-base")), /任务版本 1.*round \/ 版本 1/);
    assert.equal(byTestId(container, "task-decision-rebase").props.disabled, true);
    await byTestId(container, "task-decision-retry").props.onClick(); await settle();
    assert.equal(writes.length, 2); assert.deepEqual(writes[1], writes[0]);
    assert.equal(find(container, node => node.props["data-testid"] === "task-decision-retry"), undefined);
    assert.match(textOf(byTestId(container, "task-notice")), /裁决已保存并应用/);
    assert.equal(byTestId(container, "task-decision-reason").value, "");
  }, { path: "/projects/p/tasks/t", resourceBrowser: f.browser });
});

test("SFC：远端提示更新详情元数据与同版本评论，编辑/评论/理由草稿和保存基准保持", async () => {
  const f = browserFixture(); let current = { ...task }, comments: unknown[] = [];
  await withPage("TaskDetailView", url => {
    if (url.endsWith("/tasks/t")) return json({ task: current, comments, history: [], rounds: [], reports: [], messageLinks: [] });
    if (url.endsWith("/org")) return json(org);
    if (url.includes("/decisions?")) return json({ decisions: [], cursor: 0 });
    return json({ projects: [project] });
  }, async container => {
    byTestId(container, "task-edit-open").props.onClick(); await settle();
    await input(byTestId(container, "task-title"), "本地标题草稿");
    await input(byTestId(container, "task-comment-body"), "本地评论草稿");
    await input(byTestId(container, "task-transition-reason"), "本地理由草稿");
    const titleControl = byTestId(container, "task-title");
    current = { ...current, title: "远端标题", body: "远端目标", revision: 2 }; f.hint("task", 2); await settle();
    assert.match(textOf(byTestId(container, "task-remote-changes")), /远端标题/);
    assert.match(textOf(byTestId(container, "task-draft-base")), /版本 1/);
    assert.equal(byTestId(container, "task-title"), titleControl, "控件保留挂载身份；真实焦点由浏览器另验");
    assert.equal(titleControl.value, "本地标题草稿");
    assert.equal(byTestId(container, "task-comment-body").value, "本地评论草稿");
    assert.equal(byTestId(container, "task-transition-reason").value, "本地理由草稿");
    comments = [{ id: "c", body: "同版本新评论", kind: "comment", author: task.author, createdAt: task.createdAt }]; f.hint("task", 2); await settle();
    assert.match(textOf(byTestId(container, "task-comments")), /同版本新评论/);
    assert.equal(byTestId(container, "task-comment-body").value, "本地评论草稿");
    byTestId(container, "task-rebase").props.onClick(); await settle();
    assert.equal(byTestId(container, "task-body").value, "远端目标"); assert.match(textOf(byTestId(container, "task-draft-base")), /版本 2/);
    f.close(); await settle(); assert.match(textOf(byTestId(container, "resource-sync-status")), /离线.*可能不是最新/);
    assert.match(textOf(byTestId(container, "resource-sync-status")), /上次读取/);
  }, { path: "/projects/p/tasks/t", resourceBrowser: f.browser });
});

test("SFC：列表对账保留筛选与创建输入；默认 reviewer 草稿不自动采用远端保存基准", async () => {
  const f = browserFixture(); let current = { ...task }, settings = { projectId: "p", revision: 1, defaultReviewerMemberId: null as string | null, reviewerValid: true, invalidReason: null };
  const writes: unknown[] = [];
  await withPage("TasksView", (url, init) => {
    if (init?.method === "PUT") { writes.push(JSON.parse(String(init.body))); return json({ settings }); }
    if (url.endsWith("/task-settings")) return json({ settings });
    if (url.endsWith("/tasks")) return json({ tasks: [current] });
    if (url.endsWith("/org")) return json(org);
    if (url.includes("/decisions?")) return json({ decisions: [], cursor: 0 });
    return json({ projects: [project] });
  }, async container => {
    await select(byTestId(container, "task-state-filter"), "todo");
    await select(byTestId(container, "task-default-reviewer"), "a");
    byTestId(container, "task-create-open").props.onClick(); await settle();
    await input(byTestId(container, "task-title"), "创建输入保留");
    current = { ...current, title: "远端更新列表", revision: 2 };
    settings = { ...settings, revision: 2, defaultReviewerMemberId: "b" }; f.hint("task-settings", 2); await settle();
    assert.match(textOf(byTestId(container, "task-board")), /远端更新列表/);
    assert.equal(byTestId(container, "task-state-filter").value, "todo");
    assert.equal(byTestId(container, "task-title").value, "创建输入保留");
    assert.equal(byTestId(container, "task-default-reviewer").value, "a");
    assert.match(textOf(byTestId(container, "task-settings-conflict")), /版本 1/);
    await submit(byTestId(container, "task-save-settings")); assert.equal(writes.length, 0, "未对比确认不采用远端基准保存");
    byTestId(container, "task-settings-rebase").props.onClick(); await settle();
    await submit(byTestId(container, "task-save-settings")); assert.deepEqual(writes[0], { expectedRevision: 2, defaultReviewerMemberId: "a" });
  }, { path: "/projects/p/tasks", resourceBrowser: f.browser });
});

test("SFC：正在填写的阻塞/裁决理由不能随远端更新悄悄改用新的 Task 或 Round 基准", async () => {
  const f = browserFixture();
  let current = { ...task, state: "review", currentReviewRoundId: "round" }, revision = 1;
  const reports = ["spec", "standards"].map(axis => ({ id: axis, roundId: "round", axis, body: "报告", verdict: "pass", sources: [], evidence: {} }));
  const writes: Record<string, unknown>[] = [];
  await withPage("TaskDetailView", (url, init) => {
    if (init?.method === "POST") { writes.push(JSON.parse(String(init.body))); return json(url.endsWith("/decision") ? decisionReceipt(current) : { task: current }); }
    if (url.endsWith("/tasks/t")) return json({ task: current, comments: [], history: [], rounds: [{ id: "round", revision, state: "reported", createdAt: task.createdAt, candidate: null }], reports, messageLinks: [] });
    if (url.endsWith("/org")) return json(org);
    if (url.includes("/decisions?")) return json({ decisions: [], cursor: 0 });
    return json({ projects: [project] });
  }, async container => {
    await input(byTestId(container, "task-transition-reason"), "基于旧任务填写的理由");
    await input(byTestId(container, "task-decision-reason"), "基于旧候选填写的裁决理由");
    current = { ...current, revision: 2 }; revision = 2; f.hint("task", 2); await settle();
    await submit(byTestId(container, "task-block"));
    await submit(byTestId(container, "task-decide"));
    assert.equal(writes.length, 0, "未比较远端版本，不能用新基准提交已输入的理由");
    assert.equal(byTestId(container, "task-transition-reason").value, "基于旧任务填写的理由");
    assert.equal(byTestId(container, "task-decision-reason").value, "基于旧候选填写的裁决理由");
    byTestId(container, "task-reason-rebase").props.onClick(); await settle();
    await submit(byTestId(container, "task-block"));
    assert.equal(writes[0]!.expectedRevision, 2);
    byTestId(container, "task-decision-rebase").props.onClick(); await settle();
    await submit(byTestId(container, "task-decide"));
    assert.equal(writes[1]!.expectedTaskRevision, 2); assert.equal(writes[1]!.expectedRoundRevision, 2);
  }, { path: "/projects/p/tasks/t", resourceBrowser: f.browser });
});

test("SFC：远端受阻后可在页内处理旧理由而保留其他草稿；无理由可直接恢复", async t => {
  for (const resolution of ["compare", "discard", "no-reason"] as const) await t.test(resolution, async () => {
    const f = browserFixture(); let current = { ...task, state: "in-progress", blockedReason: null as string | null };
    const writes: Record<string, unknown>[] = [];
    await withPage("TaskDetailView", (url, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)); writes.push(body);
        current = { ...current, state: body.state, revision: current.revision + 1, blockedReason: null };
        return json({ task: current });
      }
      if (url.endsWith("/tasks/t")) return json({ task: current, comments: [], history: [], rounds: [], reports: [], messageLinks: [] });
      if (url.endsWith("/org")) return json(org);
      if (url.includes("/decisions?")) return json({ decisions: [], cursor: 0 });
    return json({ projects: [project] });
    }, async container => {
      byTestId(container, "task-edit-open").props.onClick(); await settle();
      await input(byTestId(container, "task-title"), "另一份任务编辑草稿");
      await input(byTestId(container, "task-comment-body"), "另一份评论草稿");
      const reasonControl = byTestId(container, "task-transition-reason");
      if (resolution !== "no-reason") await input(reasonControl, "尚未提交的受阻理由");

      current = { ...current, state: "blocked", revision: 2, blockedReason: "另一客户端提交的受阻原因" };
      f.hint("task", 2); await settle();
      assert.match(textOf(byTestId(container, "task-blocked-reason")), /另一客户端提交的受阻原因/);
      const resume = byTestId(container, "task-start");
      assert.equal(resume.props.disabled, resolution !== "no-reason");
      if (resolution === "no-reason") {
        assert.equal(find(container, node => node.props["data-testid"] === "task-transition-reason"), undefined);
        assert.equal(find(container, node => node.props["data-testid"] === "task-reason-rebase"), undefined);
      } else {
        await resume.props.onClick(); await settle();
        assert.equal(writes.length, 0, "旧理由不能绕过版本 guard 恢复任务");
        assert.equal(byTestId(container, "task-transition-reason"), reasonControl, "远端受阻后仍保留理由控件及输入");
        assert.equal(reasonControl.value, "尚未提交的受阻理由");
        assert.match(textOf(byTestId(container, "task-reason-rebase").parent!), /理由仍基于版本 1，当前任务为版本 2/);
        assert.equal(find(container, node => node.props["data-testid"] === "task-block"), undefined, "受阻状态不再次提供标记受阻操作");
        if (resolution === "compare") {
          await input(reasonControl, "核对当前受阻原因后修改的理由");
          await resume.props.onClick(); await settle();
          assert.equal(writes.length, 0, "修改文字不会自动采用新基准");
          assert.match(textOf(byTestId(container, "task-reason-rebase").parent!), /理由仍基于版本 1/);
          byTestId(container, "task-reason-rebase").props.onClick(); await settle();
          assert.equal(reasonControl.value, "核对当前受阻原因后修改的理由");
        } else {
          byTestId(container, "task-reason-discard").props.onClick(); await settle();
          assert.equal(find(container, node => node.props["data-testid"] === "task-transition-reason"), undefined);
        }
        assert.equal(writes.length, 0, "采用基准或丢弃理由都不自动提交");
        assert.equal(resume.props.disabled, false);
      }
      assert.equal(byTestId(container, "task-title").value, "另一份任务编辑草稿");
      assert.match(textOf(byTestId(container, "task-draft-base")), /版本 1/);
      assert.equal(byTestId(container, "task-comment-body").value, "另一份评论草稿");
      await resume.props.onClick(); await settle();
      assert.deepEqual(writes, [{ expectedRevision: 2, state: "in-progress", ...(resolution === "compare" ? { reason: "核对当前受阻原因后修改的理由" } : {}) }]);
      assert.equal(byTestId(container, "task-title").value, "另一份任务编辑草稿");
      assert.match(textOf(byTestId(container, "task-draft-base")), /版本 1/);
      assert.equal(byTestId(container, "task-comment-body").value, "另一份评论草稿");
    }, { path: "/projects/p/tasks/t", resourceBrowser: f.browser });
  });
});

test("SFC：相邻任务状态的理由保留原基准，明确比较后按当前状态提交", async t => {
  for (const state of ["todo", "in-progress", "review", "done"]) await t.test(state, async () => {
    const f = browserFixture(); let current = { ...task, state: "in-progress" };
    const writes: Record<string, unknown>[] = [];
    await withPage("TaskDetailView", (url, init) => {
      if (init?.method === "POST") { writes.push(JSON.parse(String(init.body))); return json({ task: current }); }
      if (url.endsWith("/tasks/t")) return json({ task: current, comments: [], history: [], rounds: [], reports: [], messageLinks: [] });
      if (url.endsWith("/org")) return json(org);
      if (url.includes("/decisions?")) return json({ decisions: [], cursor: 0 });
    return json({ projects: [project] });
    }, async container => {
      await input(byTestId(container, "task-transition-reason"), "跨状态保留的理由");
      current = { ...current, state, revision: 2 }; f.hint("task", 2); await settle();
      assert.equal(byTestId(container, "task-transition-reason").value, "跨状态保留的理由");
      assert.match(textOf(byTestId(container, "task-reason-rebase").parent!), /理由仍基于版本 1，当前任务为版本 2/);
      await submit(byTestId(container, "task-block"));
      assert.equal(writes.length, 0, "旧理由仍受版本 guard 保护");
      byTestId(container, "task-reason-rebase").props.onClick(); await settle();
      await submit(byTestId(container, "task-block"));
      assert.deepEqual(writes, [{ expectedRevision: 2, state: state === "done" ? "todo" : "blocked", reason: "跨状态保留的理由" }]);
    }, { path: "/projects/p/tasks/t", resourceBrowser: f.browser });
  });
});

test("SFC：创建回执不降低同 ID 版本，也不因其他实体版本较高丢掉新任务", async t => {
  for (const observed of ["newer", "same", "absent"] as const) await t.test(observed, async () => {
    const f = browserFixture(), receipt = deferred<Response>();
    const other = { ...task, id: "other", title: "另一任务的较新事实", revision: 9 };
    const settings = { projectId: "p", revision: 9, defaultReviewerMemberId: null, reviewerValid: true, invalidReason: null };
    let tasks = [other], offline = false, posts = 0;
    await withPage("TasksView", (url, init) => {
      if (init?.method === "POST") { posts++; return receipt.promise; }
      if (url.endsWith("/tasks")) { if (offline) throw new Error("回执后 GET 断线"); return json({ tasks }); }
      if (url.endsWith("/task-settings")) return json({ settings });
      if (url.endsWith("/org")) return json(org);
      if (url.includes("/decisions?")) return json({ decisions: [], cursor: 0 });
    return json({ projects: [project] });
    }, async container => {
      await select(byTestId(container, "task-default-reviewer"), "a");
      byTestId(container, "task-create-open").props.onClick(); await settle();
      await input(byTestId(container, "task-title"), task.title);
      await submit(byTestId(container, "task-create")); await settle(); assert.equal(posts, 1);
      const known = observed === "newer" ? { ...task, title: "已观察到的后续标题", revision: 2 } : task;
      tasks = observed === "absent" ? [other] : [other, known]; f.hint(); await settle();
      offline = true; receipt.resolve(json({ task }, 201)); await settle();
      const board = textOf(byTestId(container, "task-board"));
      assert.ok(board.includes(observed === "newer" ? known.title : task.title));
      assert.ok(board.includes(other.title));
      if (observed === "newer") assert.ok(!board.includes(task.title));
      assert.equal(byTestId(container, "task-default-reviewer").value, "a", "创建回执不清理独立设置草稿");
      assert.match(textOf(byTestId(container, "task-error")), /GET 断线/);
      byTestId(container, "task-create-open").props.onClick(); await settle();
      assert.equal(byTestId(container, "task-title").value, "", "成功创建已确认，即使回执旧或补读失败也完成本次录入");
    }, { path: "/projects/p/tasks", resourceBrowser: f.browser });
  });
});

test("SFC：设置回执与已观察版本分别处理，迟到回执保留冲突，同版和新版确认保存", async t => {
  for (const receiptOrder of ["older", "same", "newer"] as const) await t.test(receiptOrder, async () => {
    const f = browserFixture(), receipt = deferred<Response>();
    const initial = { projectId: "p", revision: 1, defaultReviewerMemberId: null as string | null, reviewerValid: true, invalidReason: null };
    let settings = { ...initial }, offline = false;
    const writes: Array<{ expectedRevision: number; defaultReviewerMemberId: string }> = [];
    await withPage("TasksView", (url, init) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)); writes.push(body);
        return writes.length === 1 ? receipt.promise : json({ settings: { ...initial, revision: body.expectedRevision + 1, defaultReviewerMemberId: body.defaultReviewerMemberId } });
      }
      if (url.endsWith("/task-settings")) { if (offline) throw new Error("回执后 GET 断线"); return json({ settings }); }
      if (url.endsWith("/tasks")) return json({ tasks: [{ ...task, revision: 9 }] });
      if (url.endsWith("/org")) return json(org);
      if (url.includes("/decisions?")) return json({ decisions: [], cursor: 0 });
    return json({ projects: [project] });
    }, async container => {
      await select(byTestId(container, "task-default-reviewer"), "a");
      const saving = submit(byTestId(container, "task-save-settings")); await settle();
      assert.deepEqual(writes, [{ expectedRevision: 1, defaultReviewerMemberId: "a" }]);
      settings = receiptOrder === "older" ? { ...initial, revision: 3, defaultReviewerMemberId: "b" }
        : receiptOrder === "same" ? { ...initial, revision: 2, defaultReviewerMemberId: "a" } : initial;
      f.hint("task-settings", settings.revision); await settle();
      if (receiptOrder === "older") assert.match(textOf(byTestId(container, "task-settings-conflict")), /远端默认 reviewer 已更新为 b.*版本 1/);
      offline = true; receipt.resolve(json({ settings: { ...initial, revision: 2, defaultReviewerMemberId: "a" } }));
      await saving; await settle();
      assert.equal(byTestId(container, "task-default-reviewer").value, "a");
      assert.match(textOf(byTestId(container, "task-notice")), /已保存/);
      assert.match(textOf(byTestId(container, "task-error")), /GET 断线/);
      assert.equal(byTestId(container, "task-save-settings").props.disabled, true);
      if (receiptOrder === "older") {
        assert.match(textOf(byTestId(container, "task-settings-conflict")), /远端默认 reviewer 已更新为 b.*版本 1/, "写入确认不抹掉较新远端事实或改动原草稿基准");
        await submit(byTestId(container, "task-save-settings")); assert.equal(writes.length, 1, "旧回执不能解锁未经核对的重试");
        byTestId(container, "task-settings-rebase").props.onClick(); await settle();
      } else {
        assert.equal(find(container, node => node.props["data-testid"] === "task-settings-conflict"), undefined);
        await select(byTestId(container, "task-default-reviewer"), "b");
      }
      await submit(byTestId(container, "task-save-settings"));
      assert.deepEqual(writes[1], { expectedRevision: receiptOrder === "older" ? 3 : 2, defaultReviewerMemberId: receiptOrder === "older" ? "a" : "b" });
    }, { path: "/projects/p/tasks", resourceBrowser: f.browser });
  });
});

test("SFC：迟到 PATCH 回执保留已知冲突与原编辑基准，正常回执完成编辑且不清其他草稿", async t => {
  for (const receiptOrder of ["older", "same", "newer"] as const) await t.test(receiptOrder, async () => {
    const f = browserFixture(), receipt = deferred<Response>();
    let current = { ...task }, offline = false, patches = 0;
    const submitted = { ...task, title: "本次已提交标题", revision: 2 };
    const comments = [{ id: "c", body: "已观察到的评论", kind: "comment", author: task.author, createdAt: task.createdAt }];
    await withPage("TaskDetailView", (url, init) => {
      if (init?.method === "PATCH") { patches++; return receipt.promise; }
      if (url.endsWith("/tasks/t")) { if (offline) throw new Error("回执后 GET 断线"); return json({ task: current, comments, history: [], rounds: [], reports: [], messageLinks: [] }); }
      if (url.endsWith("/org")) return json(org);
      if (url.includes("/decisions?")) return json({ decisions: [], cursor: 0 });
    return json({ projects: [project] });
    }, async container => {
      byTestId(container, "task-edit-open").props.onClick(); await settle();
      await input(byTestId(container, "task-title"), submitted.title);
      await input(byTestId(container, "task-comment-body"), "未提交评论草稿");
      await input(byTestId(container, "task-transition-reason"), "未提交理由草稿");
      const saving = submit(byTestId(container, "task-save")); await settle(); assert.equal(patches, 1);
      current = receiptOrder === "older" ? { ...task, title: "已观察到的后续标题", body: "后续目标", revision: 3 } : receiptOrder === "same" ? submitted : task;
      f.hint("task", current.revision); await settle();
      offline = true; receipt.resolve(json({ task: submitted })); await saving; await settle();
      assert.match(textOf(byTestId(container, "task-error")), /GET 断线/);
      assert.match(textOf(byTestId(container, "task-comments")), /已观察到的评论/);
      assert.equal(byTestId(container, "task-comment-body").value, "未提交评论草稿");
      assert.equal(byTestId(container, "task-transition-reason").value, "未提交理由草稿");
      assert.match(textOf(byTestId(container, "task-reason-rebase").parent!), /理由仍基于版本 1/);
      if (receiptOrder === "older") {
        assert.equal(byTestId(container, "task-title").value, submitted.title, "旧成功回执不能关闭已有远端差异的编辑草稿");
        assert.match(textOf(byTestId(container, "task-draft-base")), /版本 1/);
        assert.match(textOf(byTestId(container, "task-remote-changes")), /已观察到的后续标题/);
        assert.match(textOf(byTestId(container, "task-notice")), /已保存.*后续更新/);
        await submit(byTestId(container, "task-save")); assert.equal(patches, 1);
      } else {
        assert.equal(find(container, node => node.props["data-testid"] === "task-save"), undefined, "同版或较新成功回执正常结束本次编辑");
        assert.match(textOf(container), /本次已提交标题/);
      }
    }, { path: "/projects/p/tasks/t", resourceBrowser: f.browser });
  });
});

test("SFC：迟到评论和状态回执仍清理本次已提交输入，保留其他草稿与较新 Task", async t => {
  for (const kind of ["comment", "transition"] as const) await t.test(kind, async () => {
    const f = browserFixture(), receipt = deferred<Response>();
    let current = { ...task }, offline = false;
    await withPage("TaskDetailView", (url, init) => {
      if (init?.method === "POST") return receipt.promise;
      if (url.endsWith("/tasks/t")) { if (offline) throw new Error("回执后 GET 断线"); return json({ task: current, comments: [], history: [], rounds: [], reports: [], messageLinks: [] }); }
      if (url.endsWith("/org")) return json(org);
      if (url.includes("/decisions?")) return json({ decisions: [], cursor: 0 });
    return json({ projects: [project] });
    }, async container => {
      byTestId(container, "task-edit-open").props.onClick(); await settle();
      await input(byTestId(container, "task-title"), "未提交编辑草稿");
      await input(byTestId(container, "task-comment-body"), "评论输入");
      await input(byTestId(container, "task-transition-reason"), "理由输入");
      const saving = submit(byTestId(container, kind === "comment" ? "task-comment-send" : "task-block")); await settle();
      current = { ...task, title: "已观察到的后续标题", state: "in-progress", revision: 3 }; f.hint("task", 3); await settle();
      offline = true;
      receipt.resolve(json(kind === "comment" ? { comment: { id: "c", body: "评论输入" } } : { task: { ...task, state: "blocked", blockedReason: "理由输入", revision: 2 } }));
      await saving; await settle();
      assert.match(textOf(byTestId(container, "task-remote-changes")), /已观察到的后续标题/);
      assert.match(textOf(byTestId(container, "task-draft-base")), /版本 1/);
      assert.equal(byTestId(container, "task-title").value, "未提交编辑草稿");
      assert.equal(byTestId(container, "task-comment-body").value, kind === "comment" ? "" : "评论输入");
      assert.equal(byTestId(container, "task-transition-reason").value, kind === "transition" ? "" : "理由输入");
      assert.match(textOf(byTestId(container, "task-error")), /GET 断线/);
    }, { path: "/projects/p/tasks/t", resourceBrowser: f.browser });
  });
});

test("SFC R-173-REQ-002：旧评审失效后裁决草稿可见可处理，新轮次就绪与权限仍约束采用和提交", async t => {
  for (const resolution of ["discard", "adopt", "readonly", "no-draft"] as const) await t.test(resolution, async () => {
    const f = browserFixture();
    let current = { ...task, state: "review", currentReviewRoundId: "round" as string | null };
    let rounds = [{ id: "round", revision: 1, state: "reported", createdAt: task.createdAt, candidate: null }];
    const oldReports = ["spec", "standards"].map(axis => ({ id: axis, roundId: "round", axis, body: "旧候选报告", verdict: "pass", sources: [], evidence: {} }));
    let reports = [...oldReports], archivedAt: string | null = null, confirms = 0;
    const writes: Array<{ url: string; body: Record<string, unknown> }> = [];
    await withPage("TaskDetailView", (url, init) => {
      if (init?.method && init.method !== "GET") { writes.push({ url, body: JSON.parse(String(init.body)) }); return json(url.endsWith("/decision") ? decisionReceipt(current) : { task: current }); }
      if (url.endsWith("/tasks/t")) return json({ task: current, comments: [], history: [], rounds, reports, messageLinks: [] });
      if (url.endsWith("/org")) return json(org);
      if (url.includes("/decisions?")) return json({ decisions: [], cursor: 0 });
    return json({ projects: [{ ...project, archivedAt }] });
    }, async (container, { router, store }) => {
      const reasonControl = byTestId(container, "task-decision-reason");
      if (resolution !== "no-draft") {
        byTestId(container, "task-edit-open").props.onClick(); await settle();
        await input(byTestId(container, "task-title"), "独立的任务编辑草稿");
        await input(byTestId(container, "task-comment-body"), "独立的评论草稿");
        await input(reasonControl, "基于旧候选的未提交裁决理由");
      }
      current = { ...current, state: "in-progress", revision: 2, currentReviewRoundId: null };
      rounds = [{ ...rounds[0]!, revision: 2, state: "superseded" }];
      f.hint("task", 2); await settle();
      if (resolution === "no-draft") {
        assert.equal(find(container, node => node.props["data-testid"] === "task-decision-reason"), undefined);
        await router.push("/projects/p/tasks"); await settle();
        assert.equal(confirms, 0, "没有理由草稿时不制造新的离开确认");
        assert.equal(writes.length, 0); return;
      }
      assert.equal(byTestId(container, "task-decision-reason"), reasonControl, "保留真实 SFC 控件挂载身份；原生 focus 另由 hosted 验证");
      assert.equal(reasonControl.value, "基于旧候选的未提交裁决理由");
      assert.match(textOf(byTestId(container, "task-decision-base")), /任务版本 1.*round.*版本 1/);
      assert.match(textOf(byTestId(container, "task-decision-unavailable")), /当前没有可提交裁决的评审轮次/);
      assert.equal(byTestId(container, "task-decide").props.disabled, true);
      assert.equal(byTestId(container, "task-decision-rebase").props.disabled, true);
      byTestId(container, "task-decision-rebase").props.onClick(); await settle();
      await submit(byTestId(container, "task-decide"));
      assert.equal(writes.length, 0, "无当前轮次时，手工触发处理函数也不能采用或提交");
      await input(reasonControl, "核对后修改文字，仍保留原基准");
      assert.match(textOf(byTestId(container, "task-decision-base")), /任务版本 1.*round.*版本 1/);

      if (resolution !== "discard") {
        current = { ...current, state: "review", revision: 3, currentReviewRoundId: "next-round" };
        for (const [index, state] of ["ready", "running", "reported"].entries()) {
          rounds = [rounds[0]!, { id: "next-round", revision: index + 1, state, createdAt: task.createdAt, candidate: null }];
          reports = state === "reported" ? [...oldReports, { ...oldReports[0]!, id: "next-spec", roundId: "next-round" }] : oldReports;
          f.hint("task", 3); await settle();
          assert.equal(byTestId(container, "task-decision-reason"), reasonControl);
          assert.equal(byTestId(container, "task-decision-rebase").props.disabled, true, state + " 或报告不齐均不能采用");
          byTestId(container, "task-decision-rebase").props.onClick(); await settle();
          await submit(byTestId(container, "task-decide"));
          assert.equal(writes.length, 0);
          assert.match(textOf(byTestId(container, "task-decision-base")), /任务版本 1.*round.*版本 1/);
        }
        reports = [...oldReports, ...oldReports.map(report => ({ ...report, id: "next-" + report.id, roundId: "next-round" }))];
        f.hint("task", 3); await settle();
        assert.equal(byTestId(container, "task-decide").props.disabled, true, "新轮次齐备也不能隐式换基准");
        if (resolution === "readonly") {
          archivedAt = task.createdAt; await store.refreshProjects(); await settle();
          assert.equal(byTestId(container, "task-decision-rebase").props.disabled, true);
          assert.equal(byTestId(container, "task-decide").props.disabled, true);
          byTestId(container, "task-decision-rebase").props.onClick(); await settle();
          await submit(byTestId(container, "task-decide"));
          assert.equal(writes.length, 0, "只读权限阻止处理函数写入");
          assert.match(textOf(byTestId(container, "task-decision-base")), /任务版本 1.*round.*版本 1/);
        } else {
          assert.equal(byTestId(container, "task-decision-rebase").props.disabled, false);
          byTestId(container, "task-decision-rebase").props.onClick(); await settle();
          assert.equal(writes.length, 0, "显式采用不是提交");
          assert.match(textOf(byTestId(container, "task-decision-base")), /任务版本 3.*next-round.*版本 3/);
          assert.equal(reasonControl.value, "核对后修改文字，仍保留原基准");
          await submit(byTestId(container, "task-decide")); await settle();
          assert.deepEqual(writes, [{ url: "/api/projects/p/tasks/t/reviews/next-round/decision", body: {
            expectedTaskRevision: 3, expectedRoundRevision: 3, verdict: "changes_requested",
            reason: "核对后修改文字，仍保留原基准", override: true,
          } }]);
          assert.equal(byTestId(container, "task-decision-reason").value, "");
        }
      }
      if (resolution !== "adopt") {
        assert.equal(byTestId(container, "task-decision-discard").props.disabled, false, "只丢弃本地理由不需要写入权限");
        byTestId(container, "task-decision-discard").props.onClick(); await settle();
        if (resolution === "discard") assert.equal(find(container, node => node.props["data-testid"] === "task-decision-reason"), undefined);
        else assert.equal(byTestId(container, "task-decision-reason").value, "");
        assert.equal(writes.length, 0);
      }
      assert.equal(byTestId(container, "task-title").value, "独立的任务编辑草稿");
      assert.match(textOf(byTestId(container, "task-draft-base")), /版本 1/);
      assert.equal(byTestId(container, "task-comment-body").value, "独立的评论草稿");
      await router.push("/projects/p/tasks"); await settle();
      assert.equal(confirms, 1, "单独处理裁决理由不会清空其他草稿或移除离开保护");
      assert.equal(router.currentRoute.value.fullPath, "/projects/p/tasks/t");
    }, { path: "/projects/p/tasks/t", resourceBrowser: f.browser, confirmDiscard: () => { confirms++; return false; } });
  });
});

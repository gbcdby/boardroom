import test from "node:test";
import assert from "node:assert/strict";
import type { ResourceBrowser, ResourceSocketHandlers } from "../src/web/src/composables/useResourceReconciliation.ts";
import { byTestId, deferred, find, input, json, select, settle, submit, textOf, withPage } from "./helpers/web-ui.ts";

function browserFixture() {
  let socket: ResourceSocketHandlers;
  const browser: ResourceBrowser = { isVisible: () => true, onVisibility: () => () => {}, interval: () => () => {}, timeout: () => () => {},
    connect(handlers) { socket = handlers; return { send() {}, close() {} }; } };
  return { browser, hint(entity = "task", revision = 1) { socket?.message(JSON.stringify({ type: "resource.changed", projectId: "p", entity, id: entity === "task" ? "t" : "p", revision })); }, close() { socket?.close(); } };
}
const project = { id: "p", name: "刷新项目", archivedAt: null, manager: null };
const materialStatus = { scope: "task-materials", executionAdmission: "not-issued", startExecution: { reasonCodes: [], issues: [] }, submitReview: { reasonCodes: [], issues: [] }, complete: { reasonCodes: [], issues: [] } };
const task = { id: "t", projectId: "p", title: "原始标题", body: "原始目标", deliveryKind: null, acceptanceText: "", acceptanceSource: "explicit", materialStatus, labels: [], state: "todo", assigneeMemberId: null, reviewerMemberId: null, repoPath: null, fixedPoint: null, revision: 1, currentReviewRoundId: null, blockedReason: null, author: { kind: "human", actorId: "local", displayName: "人" }, createdAt: "2026-11-12T00:00:00Z", updatedAt: "2026-11-12T00:00:00Z" };
const org = { members: ["a", "b"].map(id => ({ id, kind: "agent", projectId: "p", status: "active", displayName: id, nodeId: null })), nodes: [], roles: [] };

test("SFC：远端提示更新详情元数据与同版本评论，编辑/评论/理由草稿和保存基准保持", async () => {
  const f = browserFixture(); let current = { ...task }, comments: unknown[] = [];
  await withPage("TaskDetailView", url => {
    if (url.endsWith("/tasks/t")) return json({ task: current, comments, history: [], rounds: [], reports: [], messageLinks: [] });
    if (url.endsWith("/org")) return json(org);
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
    if (init?.method === "POST") { writes.push(JSON.parse(String(init.body))); return json({ task: current }); }
    if (url.endsWith("/tasks/t")) return json({ task: current, comments: [], history: [], rounds: [{ id: "round", revision, state: "reported", createdAt: task.createdAt, candidate: null }], reports, messageLinks: [] });
    if (url.endsWith("/org")) return json(org);
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
      if (init?.method && init.method !== "GET") { writes.push({ url, body: JSON.parse(String(init.body)) }); return json({ task: current }); }
      if (url.endsWith("/tasks/t")) return json({ task: current, comments: [], history: [], rounds, reports, messageLinks: [] });
      if (url.endsWith("/org")) return json(org);
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

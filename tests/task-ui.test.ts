import test from "node:test";
import assert from "node:assert/strict";
import { byTestId, deferred, find, input, json, select, settle, submit, textOf, withPage } from "./helpers/web-ui.ts";
import { useToast } from "../src/web/src/composables/useToast.ts";
import { NO_REVIEWER } from "../src/web/src/api/tasks.ts";

const project = { id: "project-1", name: "任务体验", archivedAt: null, manager: null };
const members = [
  { id: "worker", projectId: project.id, displayName: "实现者", kind: "agent", status: "active", role: "normal", nodeId: null },
  { id: "reviewer", projectId: project.id, displayName: "评审者", kind: "agent", status: "active", role: "normal", nodeId: null },
  { id: "human", projectId: project.id, displayName: "项目负责人", kind: "human", status: "active", role: "normal", nodeId: null },
  { id: "disabled", projectId: project.id, displayName: "已停用", kind: "agent", status: "disabled", role: "normal", nodeId: null },
];
const settings = { projectId: project.id, defaultReviewerMemberId: "reviewer", reviewerValid: true, invalidReason: null, revision: 1 };
const author = { kind: "human", actorId: "human:local", displayName: "本地用户" };
const materialStatus = { scope: "task-materials", executionAdmission: "not-issued", startExecution: { reasonCodes: [], issues: [] }, submitReview: { reasonCodes: [], issues: [] }, complete: { reasonCodes: [], issues: [] } };
const task = { id: "task-1", projectId: project.id, title: "最初标题", body: "完整验收条件", deliveryKind: "code", acceptanceText: "完整验收条件", acceptanceSource: "legacy_task_body", materialStatus, labels: ["体验"], state: "todo", assigneeMemberId: "worker", reviewerMemberId: "reviewer", repoPath: null, fixedPoint: null, revision: 1, currentReviewRoundId: null, blockedReason: null, author, createdAt: "2026-11-10T00:00:00Z", updatedAt: "2026-11-10T00:00:00Z" };
function read(url: string, tasks = [task]) {
  if (url.includes("/task-settings")) return json({ settings });
  if (url.endsWith("/org")) return json({ members, nodes: [], roles: [] });
  if (url.endsWith("/tasks/task-1")) return json({ task, comments: [], history: [], rounds: [], reports: [], messageLinks: [] });
  if (url.endsWith("/tasks")) return json({ tasks });
  return json({ projects: [project] });
}

for (const assignee of [null, "disabled"]) {
  test(`任务详情：完成任务负责人${assignee === null ? "移除" : "停用"}后可写理由重开待办，未满足开始条件仍不能执行`, async () => {
    useToast().clear();
    const response = deferred<Response>(); const writes: Record<string, unknown>[] = [];
    const issue = { code: assignee === null ? "assignee_required" : "assignee_invalid", field: "assigneeMemberId", message: "开始前请选择有效负责人。" };
    let current = { ...task, state: "done", assigneeMemberId: assignee, revision: 8,
      materialStatus: { ...materialStatus, startExecution: { reasonCodes: [issue.code], issues: [issue] } } };
    await withPage("TaskDetailView", (url, init) => {
      if (init?.method === "POST") { writes.push(JSON.parse(String(init.body))); return response.promise; }
      if (url.endsWith(`/tasks/${task.id}`)) return json({ task: current, comments: [], history: [], rounds: [], reports: [], messageLinks: [] });
      return read(url);
    }, async container => {
      assert.equal(byTestId(container, "task-edit-open").props.disabled, true, "done 编辑限制保留");
      assert.equal(byTestId(container, "task-block").props.disabled, true);
      await submit(byTestId(container, "task-block")); assert.equal(writes.length, 0, "空理由连 handler 也不能提交");
      await input(byTestId(container, "task-transition-reason"), "  原负责人不可用，先恢复待办重新安排  ");
      assert.equal(byTestId(container, "task-block").props.disabled, false, "重开待办不受开始执行资料门禁阻挡");
      assert.match(textOf(byTestId(container, "task-block")), /重新打开待办/);
      assert.match(textOf(container), /补齐资料.*开始/);
      const pending = submit(byTestId(container, "task-block")); await settle();
      assert.equal(byTestId(container, "task-block").props.disabled, true);
      await submit(byTestId(container, "task-block")); assert.equal(writes.length, 1);
      assert.deepEqual(writes[0], { expectedRevision: 8, state: "todo", reason: "原负责人不可用，先恢复待办重新安排" });
      current = { ...current, state: "todo", revision: 9 };
      response.resolve(json({ task: current })); await pending; await settle();
      assert.match(useToast().items.value.at(-1)?.message ?? "", /重新打开为待办/);
      assert.equal(byTestId(container, "task-edit-open").props.disabled, false);
      assert.equal(byTestId(container, "task-start").props.disabled, true, "需要先改派补齐资料再开始");
      assert.equal(byTestId(container, "task-transition-reason").value, "");
    }, { path: "/projects/project-1/tasks/task-1" });
  });
}

test("任务板：提交完整创建字段，默认 reviewer 由服务解析，进行中防止重复", async () => {
  useToast().clear();
  const response = deferred<Response>(); let payload: any; let requests = 0;
  await withPage("TasksView", (url, init) => {
    if (init?.method === "POST") { payload = JSON.parse(String(init.body)); requests++; return response.promise; }
    return read(url, []);
  }, async (container) => {
    byTestId(container, "task-create-open").props.onClick(); await settle();
    await input(byTestId(container, "task-title"), "清晰的任务标题");
    await input(byTestId(container, "task-body"), "第一条验收\n第二条验收");
    await input(byTestId(container, "task-acceptance"), "独立验收条目");
    await select(byTestId(container, "task-delivery-kind"), "code");
    await select(byTestId(container, "task-assignee"), "worker");
    await input(byTestId(container, "task-labels"), "体验，前端,体验");
    await input(byTestId(container, "task-repo-path"), "/work/repository");
    await input(byTestId(container, "task-fixed-point"), "main");
    assert.doesNotMatch(textOf(byTestId(container, "task-reviewer")), /已停用|项目负责人|实现者/);
    const first = submit(byTestId(container, "task-create"));
    const duplicate = submit(byTestId(container, "task-create"));
    assert.equal(requests, 1);
    assert.deepEqual(payload, { title: "清晰的任务标题", body: "第一条验收\n第二条验收", acceptanceText: "独立验收条目", deliveryKind: "code", assigneeMemberId: "worker", labels: ["体验", "前端"], repoPath: "/work/repository", fixedPoint: "main" });
    response.resolve(json({ task: { ...task, ...payload } }, 201));
    await Promise.all([first, duplicate]); await settle();
    assert.match(useToast().items.value.at(-1)?.message ?? "", /已保存「清晰的任务标题」/);
    assert.match(textOf(byTestId(container, "task-board")), /清晰的任务标题/);
  });
});

test("任务板：只填标题可保存，明确空评审人不被默认覆盖且筛选保留", async () => {
  let payload: Record<string, unknown> | undefined;
  await withPage("TasksView", (url, init) => {
    if (init?.method === "POST") { payload = JSON.parse(String(init.body)); return json({ task: { ...task, ...payload, reviewerMemberId: null } }, 201); }
    return read(url, []);
  }, async container => {
    await select(byTestId(container, "task-state-filter"), "todo");
    byTestId(container, "task-create-open").props.onClick(); await settle();
    assert.equal(byTestId(container, "task-create").props.disabled, true);
    await input(byTestId(container, "task-title"), "快速记下");
    assert.equal(byTestId(container, "task-create").props.disabled, false);
    await select(byTestId(container, "task-reviewer"), NO_REVIEWER);
    await submit(byTestId(container, "task-create")); await settle();
    assert.deepEqual(payload, { title: "快速记下", body: "", acceptanceText: "", deliveryKind: null, assigneeMemberId: null, reviewerMemberId: null, labels: [], repoPath: null, fixedPoint: null });
    assert.match(textOf(byTestId(container, "task-board")), /快速记下|待分派/);
    assert.equal(byTestId(container, "task-state-filter").value, "todo");
    assert.equal(find(container, node => node.props["data-testid"] === "creation-dialog"), undefined);
  });
});

test("任务板：字段拒绝保留输入，错误绑定对应字段并可修正后重试", async () => {
  let requests = 0;
  await withPage("TasksView", (url, init) => {
    if (init?.method === "POST") { requests++; return json({ error: { code: "invalid_argument", reason: "task_input_invalid", message: "请检查标签", details: { fields: [{ code: "task_input_invalid", field: "labels", message: "标签超过允许的长度或数量。" }] } } }, 400); }
    return read(url, []);
  }, async container => {
    byTestId(container, "task-create-open").props.onClick(); await settle();
    await input(byTestId(container, "task-title"), "保留标题");
    await input(byTestId(container, "task-labels"), "过长标签".repeat(20));
    await submit(byTestId(container, "task-create")); await settle();
    assert.equal(byTestId(container, "task-title").value, "保留标题");
    assert.equal(byTestId(container, "task-labels").props["aria-invalid"], true);
    assert.match(textOf(container), /标签超过允许的长度或数量/);
    await input(byTestId(container, "task-labels"), "修正");
    await submit(byTestId(container, "task-create")); await settle();
    assert.equal(requests, 2, "已知拒绝允许用户修正后再次提交");
  });
});

test("任务板：结果未知时不重复创建，读失败或重开仍保留输入和禁重试", async () => {
  let writes = 0, failRead = false;
  await withPage("TasksView", (url, init) => {
    if (init?.method === "POST") { writes++; return Promise.reject(new TypeError("响应断开")); }
    if (failRead && url.endsWith("/tasks")) return json({ error: { code: "forbidden", message: "暂时无权读取" } }, 403);
    return read(url, []);
  }, async container => {
    byTestId(container, "task-create-open").props.onClick(); await settle();
    await input(byTestId(container, "task-title"), "结果可能已提交");
    await submit(byTestId(container, "task-create")); await settle();
    assert.match(textOf(byTestId(container, "task-create-unknown")), /不再次保存/);
    assert.equal(byTestId(container, "task-create").props.disabled, true);
    assert.equal(byTestId(container, "cancel-create").props.disabled, false);
    await submit(byTestId(container, "task-create")); await settle(); assert.equal(writes, 1);
    failRead = true;
    const readButton = find(byTestId(container, "task-create-unknown"), node => node.type === "button");
    assert.ok(readButton); await readButton.props.onClick(); await settle();
    assert.match(textOf(byTestId(container, "task-create-unknown")), /暂时无权读取/);
    byTestId(container, "cancel-create").props.onClick(); await settle();
    byTestId(container, "task-create-open").props.onClick(); await settle();
    assert.equal(byTestId(container, "task-title").value, "结果可能已提交");
    await submit(byTestId(container, "task-create")); await settle(); assert.equal(writes, 1);
  });
});

test("任务详情：409 保留编辑草稿，载入最新版本需要明确操作", async () => {
  await withPage("TaskDetailView", (url, init) => init?.method === "PATCH" ? json({ error: { code: "conflict", message: "任务已变更" } }, 409) : read(url), async (container) => {
    byTestId(container, "task-edit-open").props.onClick(); await settle();
    await input(byTestId(container, "task-title"), "我的未保存标题");
    await submit(byTestId(container, "task-save")); await settle();
    assert.equal(byTestId(container, "task-title").value, "我的未保存标题");
    assert.match(textOf(byTestId(container, "task-error")), /已变更/);
    assert.match(textOf(byTestId(container, "task-conflict")), /保留/);
    assert.ok(byTestId(container, "task-reload"));
  }, { path: "/projects/project-1/tasks/task-1" });
});

test("任务详情：读取新版本不替换草稿基准，明确合并后只提交本地修改", async () => {
  let current = { ...task }; const writes: Record<string, unknown>[] = [];
  await withPage("TaskDetailView", (url, init) => {
    if (init?.method === "PATCH") { writes.push(JSON.parse(String(init.body))); return json({ error: { code: "conflict", message: "任务已变更" } }, 409); }
    if (url.endsWith(`/tasks/${task.id}`)) return json({ task: current, comments: [], history: [], rounds: [], reports: [], messageLinks: [] });
    return read(url);
  }, async (container) => {
    byTestId(container, "task-edit-open").props.onClick(); await settle();
    await input(byTestId(container, "task-title"), "我修改的标题");
    current = { ...current, revision: 2, title: "远端标题", body: "远端补充的目标" };
    await submit(byTestId(container, "task-save")); await settle();
    assert.equal(writes[0]?.expectedRevision, 1);
    await byTestId(container, "task-reload").props.onClick(); await settle();
    assert.equal(byTestId(container, "task-title").value, "我修改的标题");
    assert.equal(byTestId(container, "task-body").value, task.body);
    assert.match(textOf(byTestId(container, "task-remote-changes")), /远端补充的目标/);
    await submit(byTestId(container, "task-save")); await settle();
    assert.ok(writes.length === 1 || writes[1]?.expectedRevision === 1, "未明确合并前不能悄悄改用新版本提交");
    byTestId(container, "task-rebase").props.onClick(); await settle();
    assert.equal(byTestId(container, "task-title").value, "我修改的标题");
    assert.equal(byTestId(container, "task-body").value, "远端补充的目标");
    await submit(byTestId(container, "task-save")); await settle();
    assert.deepEqual(writes.at(-1), { expectedRevision: 2, title: "我修改的标题" });
  }, { path: "/projects/project-1/tasks/task-1" });
});

test("任务详情：未分派可编辑标题，不重发未改验收或失效的旧分派", async () => {
  let current = { ...task, assigneeMemberId: null as string | null, reviewerMemberId: "disabled" }; let payload: unknown;
  await withPage("TaskDetailView", (url, init) => {
    if (init?.method === "PATCH") { payload = JSON.parse(String(init.body)); return json({ task: current }); }
    if (url.endsWith(`/tasks/${task.id}`)) return json({ task: current, comments: [], history: [], rounds: [], reports: [], messageLinks: [] });
    return read(url);
  }, async container => {
    byTestId(container, "task-edit-open").props.onClick(); await settle();
    await input(byTestId(container, "task-title"), "只完善标题");
    assert.equal(byTestId(container, "task-save").props.disabled, false);
    await submit(byTestId(container, "task-save")); await settle();
    assert.deepEqual(payload, { expectedRevision: 1, title: "只完善标题" });
  }, { path: "/projects/project-1/tasks/task-1" });
});

test("任务详情：保存结果未知须成功读取并明确采用，读403不解除保护", async () => {
  let current = { ...task }, failRead = false, writes = 0;
  await withPage("TaskDetailView", (url, init) => {
    if (init?.method === "PATCH") { writes++; current = { ...current, ...JSON.parse(String(init.body)), revision: 2 }; return Promise.reject(new TypeError("保存响应断开")); }
    if (url.endsWith(`/tasks/${task.id}`)) return failRead ? json({ error: { code: "forbidden", message: "暂时无权读取" } }, 403) : json({ task: current, comments: [], history: [], rounds: [], reports: [], messageLinks: [] });
    return read(url);
  }, async container => {
    byTestId(container, "task-edit-open").props.onClick(); await settle();
    await input(byTestId(container, "task-title"), "已经保存但丢响应");
    await submit(byTestId(container, "task-save")); await settle();
    assert.equal(byTestId(container, "task-save").props.disabled, true);
    assert.equal(byTestId(container, "task-rebase").props.disabled, true);
    failRead = true;
    let reload = find(byTestId(container, "task-error"), node => node.type === "button"); assert.ok(reload);
    await reload.props.onClick(); await settle();
    assert.match(textOf(byTestId(container, "task-error")), /暂时无权读取/);
    assert.equal(byTestId(container, "task-rebase").props.disabled, true);
    await submit(byTestId(container, "task-save")); assert.equal(writes, 1);
    failRead = false;
    reload = find(byTestId(container, "task-error"), node => node.type === "button"); assert.ok(reload);
    await reload.props.onClick(); await settle();
    assert.equal(byTestId(container, "task-save").props.disabled, true);
    byTestId(container, "task-rebase").props.onClick(); await settle();
    assert.equal(byTestId(container, "task-title").value, "已经保存但丢响应");
    assert.equal(byTestId(container, "task-save").props.disabled, true, "当前任务已经包含该修改，无需重发");
    await submit(byTestId(container, "task-save")); assert.equal(writes, 1);
  }, { path: "/projects/project-1/tasks/task-1" });
});

test("任务详情：旧任务保存回执迟到不锁住新任务，也不清空新任务草稿", async () => {
  const old = deferred<Response>();
  await withPage("TaskDetailView", (url, init) => {
    if (init?.method === "PATCH") return old.promise;
    if (url.endsWith("/tasks/task-2")) return json({ task: { ...task, id: "task-2", title: "第二项任务" }, comments: [], history: [], rounds: [], reports: [], messageLinks: [] });
    return read(url);
  }, async (container, { router }) => {
    byTestId(container, "task-edit-open").props.onClick(); await settle();
    await input(byTestId(container, "task-title"), "第一项在途修改");
    const pending = submit(byTestId(container, "task-save")); await settle();
    await router.push("/projects/project-1/tasks/task-2"); await settle();
    assert.equal(byTestId(container, "task-edit-open").props.disabled, false);
    byTestId(container, "task-edit-open").props.onClick(); await settle();
    await input(byTestId(container, "task-title"), "第二项新草稿");
    old.resolve(json({ task: { ...task, title: "第一项在途修改", revision: 2 } }));
    await pending; await settle();
    assert.equal(byTestId(container, "task-title").value, "第二项新草稿");
    assert.match(textOf(byTestId(container, "task-draft-base")), /版本 1/);
  }, { path: "/projects/project-1/tasks/task-1" });
});

test("任务详情：离开后重返同一任务，旧请求也不能清空新一轮编辑草稿", async () => {
  const old = deferred<Response>();
  await withPage("TaskDetailView", (url, init) => {
    if (init?.method === "PATCH") return old.promise;
    if (url.endsWith("/tasks/task-2")) return json({ task: { ...task, id: "task-2", title: "第二项任务" }, comments: [], history: [], rounds: [], reports: [], messageLinks: [] });
    return read(url);
  }, async (container, { router }) => {
    byTestId(container, "task-edit-open").props.onClick(); await settle();
    await input(byTestId(container, "task-title"), "离开前的在途修改");
    const pending = submit(byTestId(container, "task-save")); await settle();
    await router.push("/projects/project-1/tasks/task-2"); await settle();
    await router.push("/projects/project-1/tasks/task-1"); await settle();
    byTestId(container, "task-edit-open").props.onClick(); await settle();
    await input(byTestId(container, "task-title"), "返回后新写的草稿");
    old.resolve(json({ task: { ...task, title: "离开前的在途修改", revision: 2 } }));
    await pending; await settle();
    assert.equal(byTestId(container, "task-title").value, "返回后新写的草稿");
  }, { path: "/projects/project-1/tasks/task-1" });
});

test("任务详情：服务端资料原因直接展示，缺资料控件与处理函数均不能推进", async () => {
  let writes = 0;
  const issues = [{ code: "assignee_required", field: "assigneeMemberId", message: "待分派负责人。" }, { code: "task_acceptance_required", field: "acceptanceText", message: "请补充明确的验收条件。" }];
  await withPage("TaskDetailView", (url, init) => {
    if (init?.method === "POST") { writes++; return json({ task }); }
    if (url.endsWith(`/tasks/${task.id}`)) return json({ task: { ...task, assigneeMemberId: null, acceptanceText: "", materialStatus: { ...materialStatus, startExecution: { issues, reasonCodes: issues.map(issue => issue.code) } } }, comments: [], history: [], rounds: [], reports: [], messageLinks: [] });
    return read(url);
  }, async container => {
    for (const issue of issues) assert.ok(textOf(byTestId(container, "task-materials")).includes(issue.message));
    assert.match(textOf(byTestId(container, "task-materials")), /不表示已创建执行实例或获得政策批准/);
    assert.equal(byTestId(container, "task-start").props.disabled, true);
    await byTestId(container, "task-start").props.onClick(); assert.equal(writes, 0);
  }, { path: "/projects/project-1/tasks/task-1" });
});

test("任务详情：展示两份独立报告，管理者覆盖必须有原因并携带双版本", async () => {
  let payload: any; let writes = 0;
  const round = { id: "round-1", taskId: task.id, projectId: project.id, revision: 4, taskRevision: 3, state: "reported", reviewerMemberId: "reviewer", specSnapshot: { title: task.title, body: task.body, labels: task.labels }, candidate: null, failure: null, decision: null, createdAt: task.createdAt, updatedAt: task.updatedAt };
  const reports = ["spec", "standards"].map((axis) => ({ id: `report-${axis}`, roundId: round.id, axis, verdict: axis === "spec" ? "pass" : "changes_requested", body: `${axis} 的独立结论 <script>不得执行</script>`, sources: [`${axis}.md`], evidence: { provenance: "reviewer-declared", contextId: axis }, createdAt: task.createdAt, author }));
  await withPage("TaskDetailView", (url, init) => {
    if (init?.method === "POST") { writes++; payload = JSON.parse(String(init.body)); return json({ task }); }
    if (url.endsWith(`/tasks/${task.id}`)) return json({ task: { ...task, revision: 3, state: "review", currentReviewRoundId: round.id }, comments: [], history: [], rounds: [round], reports, messageLinks: [] });
    return read(url);
  }, async (container) => {
    assert.match(textOf(byTestId(container, "task-report-spec")), /spec 的独立结论/);
    assert.match(textOf(byTestId(container, "task-report-standards")), /standards 的独立结论/);
    assert.equal(find(container, (node) => node.type === "script"), undefined, "报告正文只能作为文本呈现");
    assert.equal(byTestId(container, "task-decide").props.disabled, true);
    await submit(byTestId(container, "task-decide")); assert.equal(writes, 0);
    await input(byTestId(container, "task-decision-reason"), "已评估报告中的缺口，需要继续完善");
    await select(byTestId(container, "task-decision-verdict"), "changes_requested");
    await submit(byTestId(container, "task-decide"));
    assert.equal(writes, 1);
    assert.deepEqual(payload, { expectedTaskRevision: 3, expectedRoundRevision: 4, verdict: "changes_requested", reason: "已评估报告中的缺口，需要继续完善", override: true });
  }, { path: "/projects/project-1/tasks/task-1" });
});

test("任务详情：归档只读保留报告与评论，控件和处理函数都不能写入", async () => {
  let writes = 0;
  await withPage("TaskDetailView", (url, init) => {
    if (init?.method !== "GET") { writes++; return json({ task }); }
    if (url.startsWith("/api/projects?") || url === "/api/projects") return json({ projects: [{ ...project, archivedAt: task.createdAt }] });
    return read(url);
  }, async (container) => {
    assert.match(textOf(container), /项目已归档/);
    assert.equal(byTestId(container, "task-edit-open").props.disabled, true);
    assert.equal(byTestId(container, "task-start").props.disabled, true);
    assert.equal(byTestId(container, "task-comment-send").props.disabled, true);
    await input(byTestId(container, "task-comment-body"), "无法提交的评论");
    await submit(byTestId(container, "task-comment-send"));
    assert.equal(writes, 0);
  }, { path: "/projects/project-1/tasks/task-1" });
});

test("任务板：旧项目请求迟到不会覆盖新项目任务或默认 reviewer", async () => {
  const old = deferred<Response>();
  await withPage("TasksView", (url) => {
    if (url.endsWith("/project-1/tasks")) return old.promise;
    if (url.startsWith("/api/projects/project-2/")) {
      if (url.endsWith("/tasks")) return json({ tasks: [{ ...task, id: "task-2", projectId: "project-2", title: "乙项目任务" }] });
      if (url.endsWith("/task-settings")) return json({ settings: { ...settings, projectId: "project-2" } });
      return json({ members: members.map((member) => ({ ...member, projectId: "project-2" })), nodes: [], roles: [] });
    }
    if (url.startsWith("/api/projects?")) return json({ projects: [project, { ...project, id: "project-2", name: "乙项目" }] });
    return read(url);
  }, async (container, { store }) => {
    await store.selectProject("project-2"); await settle();
    assert.match(textOf(byTestId(container, "task-board")), /乙项目任务/);
    old.resolve(json({ tasks: [task] })); await settle();
    assert.match(textOf(byTestId(container, "task-board")), /乙项目任务/);
    assert.doesNotMatch(textOf(byTestId(container, "task-board")), /最初标题/);
  });
});

test("任务板：创建在途时切项目，新项目不锁死，旧回执不覆盖新草稿或误报成功", async () => {
  useToast().clear();
  const old = deferred<Response>(); const writes: string[] = [];
  await withPage("TasksView", (url, init) => {
    if (init?.method === "POST") { writes.push(url); return old.promise; }
    if (url.startsWith("/api/projects/project-2/")) {
      if (url.endsWith("/tasks")) return json({ tasks: [] });
      if (url.endsWith("/task-settings")) return json({ settings: { ...settings, projectId: "project-2" } });
      return json({ members: members.map(member => ({ ...member, projectId: "project-2" })), nodes: [], roles: [] });
    }
    if (url.startsWith("/api/projects?")) return json({ projects: [project, { ...project, id: "project-2", name: "乙项目" }] });
    return read(url, []);
  }, async (container, { store }) => {
    byTestId(container, "task-create-open").props.onClick(); await settle();
    await input(byTestId(container, "task-title"), "甲项目在途录入");
    const pending = submit(byTestId(container, "task-create")); await settle();
    await store.selectProject("project-2"); await settle();
    assert.equal(byTestId(container, "task-create-open").props.disabled, false);
    byTestId(container, "task-create-open").props.onClick(); await settle();
    await input(byTestId(container, "task-title"), "乙项目新草稿");
    old.resolve(json({ task: { ...task, title: "甲项目在途录入" } }, 201));
    await pending; await settle();
    assert.equal(byTestId(container, "task-title").value, "乙项目新草稿");
    assert.doesNotMatch(textOf(byTestId(container, "task-board")), /甲项目在途录入/);
    assert.deepEqual(writes, ["/api/projects/project-1/tasks"]);
    assert.equal(useToast().items.value.length, 0);
  });
});

test("任务详情：候选失败从持久化详情展示且任务保持进行中", async () => {
  let reviewed = false;
  await withPage("TaskDetailView", (url, init) => {
    if (init?.method === "POST" && url.endsWith("/reviews")) { reviewed = true; return json({ ready: false, error: { code: "dirty_candidate", message: "工作树含未提交改动" } }, 400); }
    if (url.endsWith(`/tasks/${task.id}`)) return json({ task: { ...task, state: "in-progress", repoPath: "/repo", fixedPoint: "main" }, comments: [], history: [], rounds: reviewed ? [{ id: "failed-1", state: "failed", createdAt: task.createdAt, failure: { code: "dirty_candidate", message: "工作树含未提交改动" }, candidate: null, decision: null }] : [], reports: [], messageLinks: [] });
    return read(url);
  }, async (container) => {
    await byTestId(container, "task-start-review").props.onClick(); await settle();
    assert.match(textOf(byTestId(container, "task-reviews")), /候选准备失败/);
    assert.match(textOf(byTestId(container, "task-reviews")), /工作树含未提交改动/);
    assert.equal(textOf(byTestId(container, "task-state")), "进行中");
  }, { path: "/projects/project-1/tasks/task-1" });
});

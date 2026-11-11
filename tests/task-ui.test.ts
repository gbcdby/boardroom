import test from "node:test";
import assert from "node:assert/strict";
import { byTestId, deferred, find, input, json, select, settle, submit, textOf, withPage } from "./helpers/web-ui.ts";

const project = { id: "project-1", name: "任务体验", archivedAt: null, manager: null };
const members = [
  { id: "worker", projectId: project.id, displayName: "实现者", kind: "agent", status: "active", role: "normal", nodeId: null },
  { id: "reviewer", projectId: project.id, displayName: "评审者", kind: "agent", status: "active", role: "normal", nodeId: null },
  { id: "human", projectId: project.id, displayName: "项目负责人", kind: "human", status: "active", role: "normal", nodeId: null },
  { id: "disabled", projectId: project.id, displayName: "已停用", kind: "agent", status: "disabled", role: "normal", nodeId: null },
];
const settings = { projectId: project.id, defaultReviewerMemberId: "reviewer", reviewerValid: true, invalidReason: null, revision: 1 };
const author = { kind: "human", actorId: "human:local", displayName: "本地用户" };
const task = { id: "task-1", projectId: project.id, title: "最初标题", body: "完整验收条件", labels: ["体验"], state: "todo", assigneeMemberId: "worker", reviewerMemberId: "reviewer", repoPath: null, fixedPoint: null, revision: 1, currentReviewRoundId: null, blockedReason: null, author, createdAt: "2026-11-10T00:00:00Z", updatedAt: "2026-11-10T00:00:00Z" };
function read(url: string, tasks = [task]) {
  if (url.includes("/task-settings")) return json({ settings });
  if (url.endsWith("/org")) return json({ members, nodes: [], roles: [] });
  if (url.endsWith("/tasks/task-1")) return json({ task, comments: [], history: [], rounds: [], reports: [], messageLinks: [] });
  if (url.endsWith("/tasks")) return json({ tasks });
  return json({ projects: [project] });
}

test("任务板：提交完整创建字段，默认 reviewer 由服务解析，进行中防止重复", async () => {
  const response = deferred<Response>(); let payload: any; let requests = 0;
  await withPage("TasksView", (url, init) => {
    if (init?.method === "POST") { payload = JSON.parse(String(init.body)); requests++; return response.promise; }
    return read(url, []);
  }, async (container) => {
    byTestId(container, "task-create-open").props.onClick(); await settle();
    await input(byTestId(container, "task-title"), "清晰的任务标题");
    await input(byTestId(container, "task-body"), "第一条验收\n第二条验收");
    await select(byTestId(container, "task-assignee"), "worker");
    await input(byTestId(container, "task-labels"), "体验，前端,体验");
    await input(byTestId(container, "task-repo-path"), "/work/repository");
    await input(byTestId(container, "task-fixed-point"), "main");
    assert.doesNotMatch(textOf(byTestId(container, "task-reviewer")), /已停用|项目负责人|实现者/);
    const first = submit(byTestId(container, "task-create"));
    const duplicate = submit(byTestId(container, "task-create"));
    assert.equal(requests, 1);
    assert.deepEqual(payload, { title: "清晰的任务标题", body: "第一条验收\n第二条验收", assigneeMemberId: "worker", labels: ["体验", "前端"], repoPath: "/work/repository", fixedPoint: "main" });
    response.resolve(json({ task: { ...task, ...payload } }, 201));
    await Promise.all([first, duplicate]); await settle();
    assert.match(textOf(byTestId(container, "task-notice")), /已创建/);
    assert.match(textOf(byTestId(container, "task-board")), /清晰的任务标题/);
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

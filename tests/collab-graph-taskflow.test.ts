import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { TaskView } from "../src/shared/tasks.ts";
import {
  buildCollabGraphSnapshot, buildTaskFlowBoard, nextStepForIssue,
} from "../src/web/src/composables/collabGraphProjection.ts";

const now = "2026-11-22T09:00:00.000Z";

function task(overrides: Partial<TaskView> = {}): TaskView {
  return {
    id: "task-1", projectId: "p1", title: "真实任务标题", body: "真实目标正文",
    labels: [], state: "todo", assigneeMemberId: "m1", reviewerMemberId: "m2",
    deliveryKind: "code", acceptanceText: "真实验收说明", acceptanceSource: "explicit",
    repoPath: "boardroom", fixedPoint: "0fd63b34", revision: 4, currentReviewRoundId: null,
    blockedReason: null, author: { kind: "human", actorId: "u1", displayName: "记录人" },
    createdAt: now, updatedAt: now,
    materialStatus: {
      scope: "task-materials", executionAdmission: "not-issued",
      startExecution: { reasonCodes: [], issues: [] },
      submitReview: { reasonCodes: [], issues: [] },
      complete: { reasonCodes: [], issues: [] },
    },
    ...overrides,
  };
}

function snapshot(tasks: TaskView[]) {
  return buildCollabGraphSnapshot({
    project: { id: "p1", name: "项目一", createdAt: now, updatedAt: now, archivedAt: null, manager: null },
    org: { nodes: [], roles: [] },
    groups: [], members: [
      { id: "m1", projectId: "p1", agentId: "a1", kind: "agent", displayName: "真实负责人", role: "normal", nodeId: null, status: "active", createdAt: now, updatedAt: now },
      { id: "m2", projectId: "p1", agentId: "a2", kind: "agent", displayName: "真实评审人", role: "normal", nodeId: null, status: "active", createdAt: now, updatedAt: now },
    ],
    participantsByGroup: new Map(), memberStatuses: [], messagesByGroup: new Map(),
    tasks, runtimeViews: [],
  });
}

test("任务按服务端真实 state 分入五列，未知 state 按原值显示而不丢弃", () => {
  const tasks = [
    task({ id: "t-todo", state: "todo" }),
    task({ id: "t-done", state: "done" }),
    task({ id: "t-review", state: "review" }),
    task({ id: "t-todo-2", state: "todo" }),
  ];
  const board = buildTaskFlowBoard(snapshot(tasks).tasks);
  assert.deepEqual(board.map((column) => [column.state, column.label]), [
    ["todo", "待办"], ["in-progress", "进行中"], ["review", "评审中"], ["blocked", "受阻"], ["done", "已完成"],
  ]);
  assert.deepEqual(board[0]!.tasks.map((item) => item.id), ["t-todo", "t-todo-2"]);
  assert.deepEqual(board[2]!.tasks.map((item) => item.id), ["t-review"]);
  assert.deepEqual(board[4]!.tasks.map((item) => item.id), ["t-done"]);
  const withUnknown = buildTaskFlowBoard(snapshot([task({ id: "t-unknown", state: "future-state" as TaskView["state"] })]).tasks);
  assert.deepEqual(withUnknown.at(-1), {
    state: "future-state", label: "future-state",
    tasks: withUnknown.at(-1)!.tasks,
  });
  assert.equal(withUnknown.at(-1)!.tasks[0]!.state, "future-state");
});

test("真实字段映射保留 ID/版本/负责人/受阻原因，executionAdmission 恒 not-issued", () => {
  const source = task({
    id: "task-real-7", state: "blocked", revision: 9, blockedReason: "等待外部权威确认",
    assigneeMemberId: "m1", reviewerMemberId: "m2", updatedAt: "2026-11-22T10:00:00.000Z",
  });
  const [item] = snapshot([source]).tasks;
  assert.deepEqual(
    { id: item!.id, title: item!.title, state: item!.state, stateLabel: item!.stateLabel, revision: item!.revision,
      assignee: item!.assignee, assigneeMemberId: item!.assigneeMemberId, reviewer: item!.reviewer,
      blockedReason: item!.blockedReason, updatedAt: item!.updatedAt, executionAdmission: item!.executionAdmission },
    { id: "task-real-7", title: "真实任务标题", state: "blocked", stateLabel: "受阻", revision: 9,
      assignee: "真实负责人", assigneeMemberId: "m1", reviewer: "真实评审人",
      blockedReason: "等待外部权威确认", updatedAt: "2026-11-22T10:00:00.000Z", executionAdmission: "not-issued" },
  );
  const removed = snapshot([task({ assigneeMemberId: "gone", reviewerMemberId: "gone" })]).tasks[0]!;
  assert.equal(removed.assignee, "已移除成员");
  assert.equal(removed.reviewer, "已移除成员");
  const unassigned = snapshot([task({ assigneeMemberId: null, reviewerMemberId: null })]).tasks[0]!;
  assert.equal(unassigned.assignee, null);
  assert.equal(unassigned.reviewer, null);
});

test("readiness 保留服务端字段级 issues，同一原因码的两个字段不合并", () => {
  const source = task({
    materialStatus: {
      scope: "task-materials", executionAdmission: "not-issued",
      startExecution: { reasonCodes: ["task_goal_required"], issues: [
        { code: "task_goal_required", field: "body", message: "任务目标不能为空" },
      ] },
      submitReview: { reasonCodes: ["review_source_required", "reviewer_required"], issues: [
        { code: "review_source_required", field: "repoPath", message: "代码任务缺少仓库路径" },
        { code: "review_source_required", field: "fixedPoint", message: "代码任务缺少固定点" },
        { code: "reviewer_required", field: "reviewerMemberId", message: "评审人不能为空" },
      ] },
      complete: { reasonCodes: ["reviewer_required"], issues: [
        { code: "reviewer_required", field: "reviewerMemberId", message: "评审人不能为空" },
      ] },
    },
  });
  const [item] = snapshot([source]).tasks;
  assert.deepEqual(item!.readinessCodes, ["task_goal_required", "review_source_required", "reviewer_required"]);
  assert.deepEqual(item!.readinessIssues.map(({ stage, code, field, message }) => ({ stage, code, field, message })), [
    { stage: "startExecution", code: "task_goal_required", field: "body", message: "任务目标不能为空" },
    { stage: "submitReview", code: "review_source_required", field: "repoPath", message: "代码任务缺少仓库路径" },
    { stage: "submitReview", code: "review_source_required", field: "fixedPoint", message: "代码任务缺少固定点" },
    { stage: "submitReview", code: "reviewer_required", field: "reviewerMemberId", message: "评审人不能为空" },
    { stage: "complete", code: "reviewer_required", field: "reviewerMemberId", message: "评审人不能为空" },
  ]);
  assert.match(item!.readinessIssues[1]!.hint, /repoPath/);
  assert.match(item!.readinessIssues[2]!.hint, /fixedPoint/);
  assert.notEqual(item!.readinessIssues[1]!.hint, item!.readinessIssues[2]!.hint);
});

test("下一步只做保守文字提示，未知原因码回落为需查领域权威", () => {
  assert.match(nextStepForIssue({ code: "review_source_required", field: "repoPath", message: "缺仓库" }), /repoPath/);
  assert.match(nextStepForIssue({ code: "review_source_required", field: "fixedPoint", message: "缺固定点" }), /fixedPoint/);
  assert.match(nextStepForIssue({ code: "task_goal_required", field: "body", message: "缺目标" }), /body/);
  assert.equal(nextStepForIssue({ code: "unknown_code", field: "mystery", message: "未知" }), "需查领域权威");
  assert.equal(nextStepForIssue({ code: "candidate_type_requires_v2", field: "deliveryKind", message: "待接入" }), "需查领域权威");
});

test("空任务列表得到五列空看板，不注入示例任务或假负责人", () => {
  const board = buildTaskFlowBoard(snapshot([]).tasks);
  assert.equal(board.length, 5);
  assert.ok(board.every((column) => column.tasks.length === 0));
  assert.doesNotMatch(JSON.stringify(board), /示例|前端工程师|已接手|执行中/);
});

test("P03 只读看板不含任何写端点、拖动或示例任务常量", async () => {
  const home = await readFile(new URL("../src/web/src/views/HomeView.vue", import.meta.url), "utf8");
  const board = await readFile(new URL("../src/web/src/components/TaskFlowBoard.vue", import.meta.url), "utf8");
  for (const source of [home, board]) {
    assert.doesNotMatch(source, /tasksApi\.(transition|startReview|decide|create|update|comment)/);
    assert.doesNotMatch(source, /draggable|@drag|onDrag/);
    assert.doesNotMatch(source, /demoTasks|demoTaskDetail/);
  }
  for (const id of ["taskflow-title", "task-detail-title"]) {
    const heading = home.match(new RegExp(`<h2 id="${id}"[^>]*>([\\s\\S]*?)<\\/h2>`));
    assert.ok(heading, `缺少 ${id}`);
    assert.match(heading![1]!, /真实数据/);
    assert.doesNotMatch(heading![1]!, /示例数据/);
  }
  assert.match(board, /not-issued/);
  assert.match(board, /issue\.field/);
  assert.match(board, /issue\.message/);
  assert.match(board, /issue\.hint/);
});

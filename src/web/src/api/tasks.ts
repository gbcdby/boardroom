import { ApiError, request } from "./client.ts";
import type { CreateTaskInput, DecideReviewInput, StartReviewResult, TaskView as Task, TaskDeliveryKind, TaskComment, TaskDetail, TaskSettings, TaskState, TransitionTaskInput, UpdateTaskInput } from "../../../shared/tasks.ts";
export type { TaskView as Task, TaskDetail, TaskSettings, TaskState, ReviewRound, ReviewReport, ReviewVerdict } from "../../../shared/tasks.ts";

export const taskStates: ReadonlyArray<{ value: TaskState; label: string }> = [
  { value: "todo", label: "待办" }, { value: "in-progress", label: "进行中" },
  { value: "review", label: "评审中" }, { value: "blocked", label: "受阻" }, { value: "done", label: "已完成" },
];
export function taskStateLabel(value: TaskState): string { return taskStates.find((state) => state.value === value)?.label ?? value; }
const projectUrl = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;
const taskUrl = (projectId: string, taskId: string) => `${projectUrl(projectId)}/tasks/${encodeURIComponent(taskId)}`;

export const tasksApi = {
  list(projectId: string): Promise<{ tasks: Task[] }> { return request("GET", `${projectUrl(projectId)}/tasks`); },
  get(projectId: string, taskId: string): Promise<TaskDetail> { return request("GET", taskUrl(projectId, taskId)); },
  settings(projectId: string): Promise<{ settings: TaskSettings }> { return request("GET", `${projectUrl(projectId)}/task-settings`); },
  setSettings(projectId: string, expectedRevision: number, defaultReviewerMemberId: string | null): Promise<{ settings: TaskSettings }> {
    return request("PUT", `${projectUrl(projectId)}/task-settings`, { expectedRevision, defaultReviewerMemberId });
  },
  create(projectId: string, input: CreateTaskInput): Promise<{ task: Task }> { return request("POST", `${projectUrl(projectId)}/tasks`, input); },
  update(projectId: string, taskId: string, input: UpdateTaskInput): Promise<{ task: Task }> { return request("PATCH", taskUrl(projectId, taskId), input); },
  transition(projectId: string, taskId: string, input: TransitionTaskInput): Promise<{ task: Task }> { return request("POST", `${taskUrl(projectId, taskId)}/transitions`, input); },
  comment(projectId: string, taskId: string, body: string): Promise<{ comment: TaskComment }> { return request("POST", `${taskUrl(projectId, taskId)}/comments`, { body }); },
  startReview(projectId: string, taskId: string, expectedRevision: number): Promise<StartReviewResult> { return request("POST", `${taskUrl(projectId, taskId)}/reviews`, { expectedRevision }); },
  decide(projectId: string, taskId: string, roundId: string, input: DecideReviewInput): Promise<{ task: Task }> {
    return request("POST", `${taskUrl(projectId, taskId)}/reviews/${encodeURIComponent(roundId)}/decision`, input);
  },
};

export interface TaskDraft {
  title: string; body: string; labelsText: string; assigneeMemberId: string; reviewerMemberId: string; repoPath: string; fixedPoint: string;
  deliveryKind: TaskDeliveryKind | ""; acceptanceText: string;
}
/** 创建时空值表示使用有效默认；此仅为选择器状态，永不发给服务端当作 Member ID。 */
export const NO_REVIEWER = "__none__";
export function emptyTaskDraft(): TaskDraft { return { title: "", body: "", labelsText: "", assigneeMemberId: "", reviewerMemberId: "", repoPath: "", fixedPoint: "", deliveryKind: "", acceptanceText: "" }; }
export function taskDraft(task: Task): TaskDraft {
  return { title: task.title, body: task.body, labelsText: task.labels.join("，"), assigneeMemberId: task.assigneeMemberId ?? "", reviewerMemberId: task.reviewerMemberId ?? NO_REVIEWER, repoPath: task.repoPath ?? "", fixedPoint: task.fixedPoint ?? "", deliveryKind: task.deliveryKind ?? "", acceptanceText: task.acceptanceText ?? "" };
}
export function draftInput(draft: TaskDraft): CreateTaskInput {
  return {
    title: draft.title.trim(), body: draft.body, assigneeMemberId: draft.assigneeMemberId || null,
    deliveryKind: draft.deliveryKind || null, acceptanceText: draft.acceptanceText,
    labels: [...new Set(draft.labelsText.split(/[,，\n]/).map((label) => label.trim()).filter(Boolean))],
    ...(draft.reviewerMemberId ? { reviewerMemberId: draft.reviewerMemberId === NO_REVIEWER ? null : draft.reviewerMemberId } : {}),
    repoPath: draft.repoPath.trim() || null, fixedPoint: draft.fixedPoint.trim() || null,
  };
}

export function changedTaskInput(draft: TaskDraft, base: TaskDraft): Omit<UpdateTaskInput, "expectedRevision"> {
  const desired = draftInput(draft), original = draftInput(base);
  return Object.fromEntries(Object.entries(desired).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(original[key as keyof CreateTaskInput])));
}
export function deliveryKindLabel(kind: TaskDeliveryKind | null): string {
  return kind === "code" ? "代码" : kind === "artifact" ? "文件产物" : kind === "finding" ? "调查结论" : "待确定";
}
export type TaskFieldErrors = Partial<Record<keyof CreateTaskInput, string>>;
export function taskFieldErrors(error: unknown): TaskFieldErrors {
  if (!(error instanceof ApiError)) return {};
  const result: TaskFieldErrors = {};
  const fields = error.details && typeof error.details === "object" && "fields" in error.details ? error.details.fields : null;
  if (Array.isArray(fields)) for (const issue of fields) {
    if (issue && typeof issue === "object" && typeof issue.field === "string" && typeof issue.message === "string"
      && ["title", "body", "acceptanceText", "deliveryKind", "assigneeMemberId", "reviewerMemberId", "labels", "repoPath", "fixedPoint"].includes(issue.field)) {
      result[issue.field as keyof CreateTaskInput] = issue.message;
    }
  }
  if (error.reason === "assignee_invalid" || error.reason === "task_assignee_clear_requires_pause") result.assigneeMemberId = error.message;
  if (error.reason === "reviewer_invalid" || error.reason === "reviewer_is_assignee") result.reviewerMemberId = error.message;
  return result;
}

import { request } from "./client.ts";
import type { CreateTaskInput, DecideReviewInput, StartReviewResult, Task, TaskComment, TaskDetail, TaskSettings, TaskState, TransitionTaskInput, UpdateTaskInput } from "../../../shared/tasks.ts";
export type { Task, TaskDetail, TaskSettings, TaskState, ReviewRound, ReviewReport, ReviewVerdict } from "../../../shared/tasks.ts";

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
}
export function emptyTaskDraft(): TaskDraft { return { title: "", body: "", labelsText: "", assigneeMemberId: "", reviewerMemberId: "", repoPath: "", fixedPoint: "" }; }
export function taskDraft(task: Task): TaskDraft {
  return { title: task.title, body: task.body, labelsText: task.labels.join("，"), assigneeMemberId: task.assigneeMemberId ?? "", reviewerMemberId: task.reviewerMemberId ?? "", repoPath: task.repoPath ?? "", fixedPoint: task.fixedPoint ?? "" };
}
export function draftInput(draft: TaskDraft): CreateTaskInput {
  return {
    title: draft.title.trim(), body: draft.body, assigneeMemberId: draft.assigneeMemberId,
    labels: [...new Set(draft.labelsText.split(/[,，\n]/).map((label) => label.trim()).filter(Boolean))],
    ...(draft.reviewerMemberId ? { reviewerMemberId: draft.reviewerMemberId } : {}),
    repoPath: draft.repoPath.trim() || null, fixedPoint: draft.fixedPoint.trim() || null,
  };
}

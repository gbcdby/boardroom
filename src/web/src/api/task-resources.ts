import type { OrgSnapshot } from "./client.ts";
import type { Task, TaskDetail, TaskSettings } from "./tasks.ts";
import type { ResourceReader } from "../composables/useResourceReconciliation.ts";

export interface TaskListResource { tasks: Task[]; settings: TaskSettings; org: OrgSnapshot }
export interface TaskDetailResource { detail: TaskDetail; org: OrgSnapshot }
const projectPath = (id: string) => `/api/projects/${encodeURIComponent(id)}`;

export async function readTaskList(reader: ResourceReader, projectId: string): Promise<TaskListResource> {
  const prefix = projectPath(projectId);
  const [list, settings, org] = await Promise.all([
    reader.get<{ tasks: Task[] }>(`${prefix}/tasks`), reader.get<{ settings: TaskSettings }>(`${prefix}/task-settings`), reader.get<OrgSnapshot>(`${prefix}/org`),
  ]);
  return { tasks: list.tasks, settings: settings.settings, org };
}
export async function readTaskDetail(reader: ResourceReader, projectId: string, taskId: string): Promise<TaskDetailResource> {
  const prefix = projectPath(projectId);
  const [detail, org] = await Promise.all([reader.get<TaskDetail>(`${prefix}/tasks/${encodeURIComponent(taskId)}`), reader.get<OrgSnapshot>(`${prefix}/org`)]);
  return { detail, org };
}

/** Task 没有单项删除入口；同一项目的完整列表不能丢掉已确认提交的任务。项目删除由作用域处理。 */
export function acceptsTaskList(incoming: TaskListResource, current: TaskListResource | null): boolean {
  if (!current) return true;
  const revisions = new Map(incoming.tasks.map(task => [task.id, task.revision]));
  return incoming.settings.revision >= current.settings.revision && current.tasks.every(task => (revisions.get(task.id) ?? -1) >= task.revision);
}
export function acceptsTaskDetail(incoming: TaskDetailResource, current: TaskDetailResource | null): boolean {
  if (!current) return true;
  const previous = current.detail, next = incoming.detail;
  if (next.task.id !== previous.task.id || next.task.revision < previous.task.revision) return false;
  const rounds = new Map(next.rounds.map(round => [round.id, round.revision]));
  return previous.rounds.every(round => (rounds.get(round.id) ?? -1) >= round.revision)
    && previous.comments.every(comment => next.comments.some(item => item.id === comment.id))
    && previous.history.every(history => next.history.some(item => item.id === history.id));
}

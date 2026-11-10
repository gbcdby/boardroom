import { z } from "zod";
import type { TaskAccess, TaskService } from "./service.ts";
import { ForbiddenError } from "../authz/authorize.ts";
import { RepositoryError } from "../db/errors.ts";
import { McpToolError } from "../mcp/errors.ts";
import {
  taskIdSchema, parseTaskInput, createTaskSchema, updateTaskSchema, transitionTaskSchema,
  commentTaskSchema, linkTaskMessageSchema, startTaskReviewSchema, beginTaskReviewSchema,
  submitReviewReportSchema, decideTaskReviewSchema, taskSettingsSchema, listTasksSchema,
} from "./schemas.ts";

const project = { projectId: taskIdSchema.optional() };
const task = { ...project, taskId: taskIdSchema };
const round = { ...task, roundId: taskIdSchema };
export const TASK_COMMANDS = {
  get_settings: { name: "get_task_settings", title: "查看默认评审成员", schema: z.object(project).strict() },
  set_settings: { name: "set_task_settings", title: "设置默认评审成员", schema: taskSettingsSchema.extend(project).strict() },
  list: { name: "list_tasks", title: "列出当前项目任务", schema: listTasksSchema.extend(project).strict() },
  read: { name: "read_task", title: "读取任务、固定候选与独立评审指引", schema: z.object(task).strict() },
  create: { name: "create_task", title: "创建并指派任务", schema: createTaskSchema.extend(project).strict() },
  update: { name: "update_task", title: "按修订更新任务", schema: updateTaskSchema.extend(task).strict() },
  transition: { name: "transition_task", title: "推进任务或上报阻塞", schema: transitionTaskSchema.extend(task).strict() },
  comment: { name: "comment_task", title: "评论任务", schema: commentTaskSchema.extend(task).strict() },
  link_message: { name: "link_task_message", title: "关联有权读取的当前群消息", schema: linkTaskMessageSchema.extend(task).strict() },
  start_review: { name: "start_task_review", title: "固定提交候选并提交评审", schema: startTaskReviewSchema.extend(task).strict() },
  begin_review: { name: "begin_task_review", title: "评审成员接手本轮评审", schema: beginTaskReviewSchema.extend(round).strict() },
  submit_report: { name: "submit_task_review_report", title: "保存一份独立轴报告与声明证据", schema: submitReviewReportSchema.extend(round).strict() },
  decide_review: { name: "decide_task_review", title: "裁决或有理由覆盖本轮评审", schema: decideTaskReviewSchema.extend(round).strict() },
  list_work_events: { name: "list_work_events", title: "读取自己的未确认工作通知", schema: z.object(project).strict() },
  ack_work_event: { name: "acknowledge_work_event", title: "确认工作通知（不改变任务状态）", schema: z.object({ ...project, eventId: taskIdSchema }).strict() },
} as const;
export type TaskOperation = keyof typeof TASK_COMMANDS;
export const TASK_OBSERVATIONS: ReadonlySet<TaskOperation> = new Set(["get_settings", "list", "read", "list_work_events"]);

export function mapTaskToolError(error: unknown): McpToolError {
  if (error instanceof McpToolError) return error;
  if (error instanceof ForbiddenError) return new McpToolError("FORBIDDEN", error.message, { reason: error.code });
  if (error instanceof RepositoryError) {
    const reason = "reason" in error && typeof error.reason === "string" ? error.reason : error.code;
    const details = "details" in error && typeof error.details === "object" && error.details !== null ? error.details : {};
    const code = error.code === "conflict" || error.code === "archived" ? "CONFLICT" : error.code === "write_failed" ? "INTERNAL" : "INVALID_ARGUMENT";
    return new McpToolError(code, error.message, { ...details, reason });
  }
  return new McpToolError("INTERNAL", "任务操作失败，请重试。");
}

/** 仅协议装配：project/actor 取自绑定，所有业务规则仍由同一个 TaskService 执行。 */
export async function invokeTaskOperation(service: TaskService, access: TaskAccess, projectId: string,
  operation: TaskOperation, input: unknown): Promise<Record<string, unknown>> {
  const definition = TASK_COMMANDS[operation];
  if (!definition) throw new McpToolError("INVALID_ARGUMENT", "未知任务操作。");
  const schema: z.AnyZodObject = definition.schema;
  const parsed = parseTaskInput(schema, input);
  if (parsed["projectId"] !== undefined && parsed["projectId"] !== projectId) {
    throw new McpToolError("FORBIDDEN", "任务项目必须与当前 MCP 绑定一致。", { reason: "out_of_connection" });
  }
  const { projectId: _projectId, taskId: rawTaskId, roundId: rawRoundId, ...body } = parsed;
  const taskId = rawTaskId as string;
  const roundId = rawRoundId as string;
  switch (operation) {
    case "get_settings": return { ok: true, settings: await service.getSettings(access, projectId) };
    case "set_settings": return { ok: true, settings: await service.setSettings(access, projectId, parseTaskInput(taskSettingsSchema, body)) };
    case "list": return { ok: true, tasks: await service.list(access, projectId, parseTaskInput(listTasksSchema, body)) };
    case "read": {
      const detail = await service.get(access, projectId, taskId);
      return { ok: true, ...detail, reviewInstructions: {
        common: "两轴使用同一 current round 的任务快照、固定 Git 提交和 diff。启动两个并行、互不读取对方输出的独立子 Agent，各自保存命令、宿主版本、执行上下文与时间、提示及输出摘要。",
        spec: "只检查固定任务要求的完整性、错误实现与范围蔓延；报告以 spec 轴单独提交。",
        standards: "先读取候选仓库已文档化的规范，并记录来源；以仓库规范为优先，再参考 Fowler 代码坏味道，写明判断依据。报告以 standards 轴单独提交。",
        evidence: "提交的外部执行元数据为 reviewer-declared；平台的结构校验不证明真实模型已经运行。报告齐备后再裁决。",
      } };
    }
    case "create": return { ok: true, task: await service.create(access, projectId, parseTaskInput(createTaskSchema, body)) };
    case "update": return { ok: true, task: await service.update(access, projectId, taskId, parseTaskInput(updateTaskSchema, body)) };
    case "transition": return { ok: true, task: await service.transition(access, projectId, taskId, parseTaskInput(transitionTaskSchema, body)) };
    case "comment": return { ok: true, comment: await service.comment(access, projectId, taskId, parseTaskInput(commentTaskSchema, body).body) };
    case "link_message": return { ok: true, link: await service.linkMessage(access, projectId, taskId, parseTaskInput(linkTaskMessageSchema, body).messageId) };
    case "start_review": {
      const result = await service.startReview(access, projectId, taskId, parseTaskInput(startTaskReviewSchema, body));
      return { ok: result.ready, ...result };
    }
    case "begin_review": return { ok: true, round: await service.beginReview(access, projectId, taskId, roundId, parseTaskInput(beginTaskReviewSchema, body)) };
    case "submit_report": return { ok: true, report: await service.submitReport(access, projectId, taskId, roundId, parseTaskInput(submitReviewReportSchema, body)) };
    case "decide_review": return { ok: true, task: await service.decideReview(access, projectId, taskId, roundId, parseTaskInput(decideTaskReviewSchema, body)) };
    case "list_work_events": return { ok: true, workEvents: await service.listWorkEvents(access, projectId) };
    case "ack_work_event": return { ok: true, ...await service.acknowledgeWorkEvent(access, projectId, body["eventId"] as string) };
  }
}

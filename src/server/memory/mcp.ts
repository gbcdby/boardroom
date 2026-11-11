import { z } from "zod";
import type { MemoryKey } from "../../shared/memory.ts";
import type { MemoryAccess, MemoryService } from "./service.ts";
import { ForbiddenError } from "../authz/authorize.ts";
import { RepositoryError } from "../db/errors.ts";
import { McpToolError } from "../mcp/errors.ts";
import { memoryId, memoryRevision, parseMemoryInput, writeMemorySchema, memoryMutationSchema,
  beginMemorySummarySchema, submitMemorySummarySchema, failMemorySummarySchema } from "./schemas.ts";

const project = { projectId: memoryId.optional() };
const key = { ...project, scope: z.enum(["global", "project", "project-agent"]), targetAgentId: memoryId.optional() };
const request = { ...project, requestId: memoryId };
export const MEMORY_COMMANDS = {
  read: { name: "read_memory", title: "读取有权访问的记忆", schema: z.object(key).strict() },
  write: { name: "write_memory", title: "按版本保存记忆", schema: writeMemorySchema.extend(key).strict() },
  history: { name: "list_memory_versions", title: "查看记忆版本", schema: z.object({ ...key, beforeVersion: memoryRevision.min(1).optional() }).strict() },
  list_summary_requests: { name: "list_memory_summary_requests", title: "查看自总结请求状态", schema: z.object({ ...project, targetAgentId: memoryId.optional() }).strict() },
  read_summary: { name: "read_memory_summary", title: "目标 Agent 读取自总结材料", schema: z.object(request).strict() },
  begin_summary: { name: "begin_memory_summary", title: "目标 Agent 接手自总结请求", schema: beginMemorySummarySchema.extend(request).strict() },
  submit_summary: { name: "submit_memory_summary", title: "目标 Agent 提交自总结结果", schema: submitMemorySummarySchema.extend(request).strict() },
  fail_summary: { name: "fail_memory_summary", title: "目标 Agent 记录自总结失败", schema: failMemorySummarySchema.extend(request).strict() },
  retry_summary: { name: "retry_memory_summary", title: "安排一次新的自总结请求", schema: memoryMutationSchema.extend(request).strict() },
  session_end: { name: "report_memory_session_end", title: "明确报告本次逻辑会话结束", schema: memoryMutationSchema.extend(project).strict() },
} as const;
export type MemoryOperation = keyof typeof MEMORY_COMMANDS;
export const MEMORY_OBSERVATIONS: ReadonlySet<MemoryOperation> = new Set(["read", "history", "list_summary_requests", "read_summary"]);

export function mapMemoryToolError(error: unknown): McpToolError {
  if (error instanceof McpToolError) return error;
  if (error instanceof ForbiddenError) return new McpToolError("FORBIDDEN", error.message, { reason: error.code });
  if (error instanceof RepositoryError) {
    const reason = "reason" in error && typeof error.reason === "string" ? error.reason : error.code;
    const details = "details" in error && typeof error.details === "object" && error.details !== null ? error.details : {};
    const code = error.code === "conflict" || error.code === "archived" ? "CONFLICT" : error.code === "write_failed" ? "INTERNAL" : "INVALID_ARGUMENT";
    return new McpToolError(code, error.message, { ...details, reason });
  }
  return new McpToolError("INTERNAL", "记忆操作失败，请重试。");
}

/** 绑定由 core 提供；任何用户字段都不能替代真实 Agent、项目或代际。 */
export async function invokeMemoryOperation(service: MemoryService, access: MemoryAccess,
  binding: { projectId: string; agentId: string }, operation: MemoryOperation, input: unknown): Promise<Record<string, unknown>> {
  const definition = MEMORY_COMMANDS[operation];
  if (!definition) throw new McpToolError("INVALID_ARGUMENT", "未知记忆操作。");
  const schema: z.AnyZodObject = definition.schema;
  const parsed = parseMemoryInput(schema, input);
  if (parsed["projectId"] !== undefined && parsed["projectId"] !== binding.projectId) {
    throw new McpToolError("FORBIDDEN", "记忆项目必须与当前 MCP 绑定一致。", { reason: "out_of_connection" });
  }
  const { projectId: _project, scope, targetAgentId, requestId: rawRequestId, beforeVersion, ...body } = parsed;
  const requestId = rawRequestId as string;
  function memoryKey(): MemoryKey {
    if (scope === "global") {
      if (targetAgentId !== undefined && targetAgentId !== binding.agentId) throw new McpToolError("FORBIDDEN", "只能访问自己的全局记忆。");
      return { scope, agentId: binding.agentId, projectId: null };
    }
    if (scope === "project") {
      if (targetAgentId !== undefined) throw new McpToolError("INVALID_ARGUMENT", "项目共享记忆不接受目标 Agent。");
      return { scope, projectId: binding.projectId, agentId: null };
    }
    return { scope: "project-agent", projectId: binding.projectId, agentId: (targetAgentId as string | undefined) ?? binding.agentId };
  }
  switch (operation) {
    case "read": return { ok: true, ...await service.read(access, memoryKey()) };
    case "write": return { ok: true, ...await service.write(access, memoryKey(), parseMemoryInput(writeMemorySchema, body)) };
    case "history": return { ok: true, versions: await service.history(access, memoryKey(), beforeVersion as number | undefined) };
    case "list_summary_requests": return { ok: true, requests: await service.listSummaryRequests(access, binding.projectId, targetAgentId as string | undefined) };
    case "read_summary": return { ok: true, ...await service.readSummaryPacket(access, requestId) };
    case "begin_summary": return { ok: true, request: await service.beginSummary(access, requestId, parseMemoryInput(beginMemorySummarySchema, body)) };
    case "submit_summary": return { ok: true, ...await service.submitSummary(access, requestId, parseMemoryInput(submitMemorySummarySchema, body)) };
    case "fail_summary": return { ok: true, request: await service.failSummary(access, requestId, parseMemoryInput(failMemorySummarySchema, body)) };
    case "retry_summary": return { ok: true, request: await service.retrySummary(access, requestId, parseMemoryInput(memoryMutationSchema, body).clientMutationId) };
    case "session_end": return { ok: true, ...await service.reportSessionEnd(access, parseMemoryInput(memoryMutationSchema, body).clientMutationId) };
  }
}

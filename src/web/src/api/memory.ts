import { request } from "./client.ts";
import type { MemoryConfig, MemoryDocument, MemorySummaryRequest, MemoryVersion, WriteMemoryInput, WriteMemoryResult } from "../../../shared/memory.ts";
export type { MemoryConfig, MemoryDocument, MemorySummaryRequest, MemoryVersion, MemoryWriteSource } from "../../../shared/memory.ts";

const projectUrl = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/memories`;
const documentUrl = (projectId: string, agentId: string | null) => `${projectUrl(projectId)}/${agentId === null ? "shared" : `agents/${encodeURIComponent(agentId)}`}`;

/** HTTP 人类入口仅有项目文档；不接受 global scope，也不提供代 Agent 执行总结的入口。 */
export const memoryApi = {
  settings(): Promise<{ settings: MemoryConfig }> { return request("GET", "/api/memory-settings"); },
  list(projectId: string): Promise<{ documents: MemoryDocument[] }> { return request("GET", projectUrl(projectId)); },
  read(projectId: string, agentId: string | null = null): Promise<{ document: MemoryDocument | null; version: number }> { return request("GET", documentUrl(projectId, agentId)); },
  write(projectId: string, agentId: string | null, input: WriteMemoryInput): Promise<WriteMemoryResult> { return request("PUT", documentUrl(projectId, agentId), input); },
  history(projectId: string, agentId: string | null, beforeVersion?: number): Promise<{ versions: MemoryVersion[] }> {
    return request("GET", `${documentUrl(projectId, agentId)}/versions${beforeVersion === undefined ? "" : `?beforeVersion=${beforeVersion}`}`);
  },
  version(projectId: string, agentId: string | null, version: number): Promise<{ version: MemoryVersion | null }> { return request("GET", `${documentUrl(projectId, agentId)}/versions/${version}`); },
  requests(projectId: string, agentId: string): Promise<{ requests: MemorySummaryRequest[] }> { return request("GET", `${documentUrl(projectId, agentId)}/summary-requests`); },
  retry(projectId: string, requestId: string, clientMutationId: string): Promise<{ request: MemorySummaryRequest }> {
    return request("POST", `${projectUrl(projectId)}/summary-requests/${encodeURIComponent(requestId)}/retry`, { clientMutationId });
  },
};

export function memorySourceLabel(source: string): string {
  return ({ human: "人工编辑", manager: "管理者编辑", agent: "Agent 编辑", "self-summary": "Agent 自总结" } as Record<string, string>)[source] ?? source;
}
export function memoryTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}

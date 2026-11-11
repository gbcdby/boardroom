// 三层记忆共享 DTO；自动总结证据保留来源声明，不代表平台验证。
export type MemoryKey =
  | { scope: 'global'; agentId: string; projectId: null }
  | { scope: 'project'; projectId: string; agentId: null }
  | { scope: 'project-agent'; projectId: string; agentId: string };
export type MemoryWriteSource = 'agent' | 'human' | 'manager' | 'self-summary';
export interface MemoryAuthor { kind: 'human' | 'agent'; actorId: string; agentId: string | null; displayName: string }
export interface MemoryDocument {
  id: string; key: MemoryKey; version: number; markdown: string; byteLength: number;
  updatedAt: string; updatedBy: MemoryAuthor; source: MemoryWriteSource;
}
export interface MemoryVersion {
  id: string; documentId: string; version: number; parentVersion: number;
  markdown: string; byteLength: number; contentSha256: string;
  author: MemoryAuthor; source: MemoryWriteSource; clientMutationId: string;
  summaryRequestId: string | null; createdAt: string;
}
export interface WriteMemoryInput { expectedVersion: number; clientMutationId: string; markdown: string }
export interface WriteMemoryResult { document: MemoryDocument; writtenVersion: MemoryVersion; duplicate: boolean }
export interface MemoryInjectionEntry {
  scope: 'global' | 'project-agent'; documentId: string; version: number; markdown: string;
  sourceBytes: number; injectedBytes: number; truncated: boolean;
}
export interface MemoryInjection {
  state: 'available' | 'partial' | 'unavailable'; entries: MemoryInjectionEntry[];
  maxBytes: number; errors: Array<{ scope: 'global' | 'project-agent'; code: string }>;
}
export type SummaryTrigger = 'task_completed' | 'message_threshold' | 'session_end' | 'retry';
export type SummaryState = 'pending' | 'running' | 'completed' | 'failed' | 'conflicted' | 'cancelled';
export interface MemorySummaryRequest {
  id: string; projectId: string; agentId: string; recipientMemberId: string;
  contextGroupId: string | null; documentId: string | null; baseVersion: number;
  revision: number; state: SummaryState; trigger: SummaryTrigger; triggerKey: string;
  taskId: string | null; completedTaskRevision: number | null;
  messageIds: string[]; sourceWorkEventId: string | null; retryOfRequestId: string | null;
  attemptId: string | null; beginMutationId: string | null;
  resultVersion: number | null; resultSha256: string | null;
  error: { code: string; message: string } | null;
  evidence: SelfSummaryEvidence | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
}
export interface SelfSummaryEvidence {
  provenance: 'agent-declared'; host: string; hostVersion: string;
  invocationId: string; contextId: string; startedAt: string; completedAt: string;
  promptSha256: string; outputSha256: string; evidenceRef: string;
}
export interface SubmitMemorySummaryInput {
  expectedRequestRevision: number; attemptId: string;
  markdown: string; evidence: SelfSummaryEvidence;
}
export interface MemorySummaryPacket {
  request: MemorySummaryRequest; currentMemory: MemoryDocument | null;
  task: { id: string; title: string; body: string; revision: number } | null;
  messages: Array<{ id: string; groupId: string; text: string; createdAt: string }>;
  partialInput: boolean; instructions: string;
}
export interface MemoryConfig {
  messageThreshold: number; maxDocumentBytes: number; maxInjectedBytes: number;
  summaryInputBytes: number; summaryAttemptTimeoutMs: number;
}

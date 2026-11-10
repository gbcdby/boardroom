import { request } from "./client.ts";
import type { StatusBoardEntry } from "./status.ts";

export type RuntimeBackend = "claude-code" | "codex-cli" | "dsh";
export type RuntimePermissionMode = "auto" | "manual" | "workspace-write";
export type RuntimeAction = "start" | "stop" | "apply" | "retry" | "new-session";
export interface RuntimeConfigDto {
  model: string | null;
  workdir: string;
  tools: readonly string[] | null;
  systemPrompt: string;
  permissionMode: RuntimePermissionMode;
}
export interface RuntimeRevisionDto { runtimeRevision: number; bindingRevision: number }
export interface RuntimeSnapshotDto {
  config: RuntimeConfigDto;
  versions: RuntimeRevisionDto;
  backend: RuntimeBackend;
  advancedStrategy: "bypassPermissions" | null;
  digest: string;
}
export interface AgentRuntimeDto {
  id: string; agentId: string; name: string; backend: RuntimeBackend;
  configVersion: number; revision: number; defaults: RuntimeConfigDto;
  createdAt: string; updatedAt: string;
}
export interface RuntimeBindingDto {
  id: string; runtimeId: string; projectId: string; groupId: string; memberId: string;
  revision: number; overrides: Partial<RuntimeConfigDto>;
  advanced: (RuntimeRevisionDto & { strategy: "bypassPermissions" }) | null;
  desiredState: "running" | "stopped"; intentRevision: number;
  requestedSnapshot: RuntimeSnapshotDto | null; resetSessionRequested: boolean;
  createdAt: string; updatedAt: string;
}
export interface RuntimeRunnerDto {
  bindingId: string;
  state: "stopped" | "starting" | "running" | "stopping" | "failed";
  phase: "idle" | "working" | "unknown";
  generation: number; applied: RuntimeSnapshotDto | null;
  hasSession: boolean; sessionState: "new" | "resumable" | "invalid" | "reset" | "unknown";
  pid: number | null; exitConfirmed: boolean; observedAt: string | null; startedAt: string | null;
  attemptCount: number; nextRetryAt: string | null; lastErrorCode: string | null;
  lastExitCode: number | null; lastExitSignal: string | null;
  permissionObserved: string; updatedAt: string;
}
export interface RuntimeCapabilityDto {
  supported: boolean; reason: string; hostVersion?: string;
  expectedPermissionMode: string; isolation: "verified" | "unavailable" | "unverified";
}
export interface RuntimeBindingViewDto {
  runtime: AgentRuntimeDto; binding: RuntimeBindingDto; runner: RuntimeRunnerDto;
  effective: RuntimeSnapshotDto & { sources: Record<keyof RuntimeConfigDto, "default" | "override"> };
  pendingChanges: boolean;
  status: {
    summary: "running" | "queued" | "error" | "stopped" | "stopping";
    reason: string | null; queuedCount: number; suppressedCount: number;
    deliveryCounts: { pending: number; delivered: number; acked: number };
    member: StatusBoardEntry | null; capability: RuntimeCapabilityDto | null;
  };
}
export interface RuntimeViewDto { runtime: AgentRuntimeDto; bindings: RuntimeBindingViewDto[] }
export interface RuntimeEventDto {
  eventId: string; event: string; observedAt: string; truncated: boolean;
  reasonCode?: string; runnerGeneration?: number; attempt?: number;
  exitCode?: number; durationMs?: number; retryAt?: number;
}
export interface RuntimeUsageDto {
  id: string; source: RuntimeBackend; harnessVersion: string;
  metric: "inputTokens" | "cachedInputTokens" | "outputTokens" | "costUsd";
  scope: "turn" | "invocation" | "session"; scopeId: string; epochId: string;
  sequence: number; coverage: "complete" | "partial" | "unavailable";
  value: number | null; cumulative: boolean; delta: number | null;
  reasonCode: string | null; estimated: boolean; observedAt: string; reportedAt: string;
}
export interface RuntimeObservationDto {
  events: { events: RuntimeEventDto[]; oldestObservedAt: string | null; historyTruncated: boolean; incomplete: boolean };
  usage: RuntimeUsageDto[];
  health: {
    incomplete: boolean; storageFailures: number; loggerWriteFailures: number;
    rejectedRecords: number; droppedEvents: number; oldestObservedAt: string | null; historyTruncated: boolean;
  };
}

export const runtimeApi = {
  list(): Promise<{ runtimes: RuntimeViewDto[] }> { return request("GET", "/api/runtimes"); },
  create(body: { name: string; backend: RuntimeBackend; defaults: RuntimeConfigDto; bindings: { projectId: string; groupId: string }[] }): Promise<{ runtime: RuntimeViewDto }> {
    return request("POST", "/api/runtimes", body);
  },
  saveDefaults(id: string, expectedRevision: number, defaults: RuntimeConfigDto): Promise<{ runtime: RuntimeViewDto }> {
    return request("PUT", `/api/runtimes/${encodeURIComponent(id)}`, { expectedRevision, defaults });
  },
  addBinding(id: string, body: { projectId: string; groupId: string; expectedRuntimeRevision: number }): Promise<{ binding: RuntimeBindingViewDto }> {
    return request("POST", `/api/runtimes/${encodeURIComponent(id)}/bindings`, body);
  },
  saveBinding(id: string, body: RuntimeRevisionDto & { overrides: Partial<RuntimeConfigDto>; advancedStrategy: "bypassPermissions" | null }): Promise<{ binding: RuntimeBindingViewDto }> {
    return request("PUT", `/api/runtime-bindings/${encodeURIComponent(id)}`, body);
  },
  action(view: RuntimeBindingViewDto, action: RuntimeAction): Promise<{ binding: RuntimeBindingViewDto }> {
    return request("POST", `/api/runtime-bindings/${encodeURIComponent(view.binding.id)}/actions`, {
      action, expectedIntentRevision: view.binding.intentRevision,
      runtimeRevision: view.runtime.revision, bindingRevision: view.binding.revision,
    });
  },
  removeRuntime(id: string): Promise<void> { return request("DELETE", `/api/runtimes/${encodeURIComponent(id)}`); },
  removeBinding(id: string): Promise<void> { return request("DELETE", `/api/runtime-bindings/${encodeURIComponent(id)}`); },
  observations(id: string): Promise<RuntimeObservationDto> {
    return request("GET", `/api/runtime-bindings/${encodeURIComponent(id)}/observations`);
  },
};

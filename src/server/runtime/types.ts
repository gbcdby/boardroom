/** #83/#84：托管配置、执行意图与观察状态彼此独立。这里只保存非秘密数据。 */
import type { OwnedProcessIdentity } from "./hosts/types.ts";
export type RuntimeBackend = "claude-code" | "codex-cli" | "dsh";
export type RuntimePermissionMode = "auto" | "manual" | "workspace-write";
/** 暂只定义已知宿主策略；是否可运行仍由真实版本/OS 能力检查决定。 */
export type RuntimeAdvancedStrategy = "bypassPermissions";

export interface RuntimeConfig {
  readonly model: string | null;
  readonly workdir: string;
  readonly tools: readonly string[] | null;
  readonly systemPrompt: string;
  readonly permissionMode: RuntimePermissionMode;
}

export type RuntimeOverrides = Partial<RuntimeConfig>;
export interface RuntimeRevision {
  readonly runtimeRevision: number;
  readonly bindingRevision: number;
}
export interface RuntimeAdvancedSelection extends RuntimeRevision {
  readonly strategy: RuntimeAdvancedStrategy;
}
export interface AgentRuntime {
  readonly id: string;
  readonly agentId: string;
  readonly name: string;
  readonly backend: RuntimeBackend;
  readonly configVersion: number;
  readonly revision: number;
  readonly defaults: RuntimeConfig;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type RuntimeDesiredState = "running" | "stopped";
export interface RuntimeAppliedConfig {
  readonly config: RuntimeConfig;
  readonly versions: RuntimeRevision;
  readonly backend: RuntimeBackend;
  readonly advancedStrategy: RuntimeAdvancedStrategy | null;
  /** 仅对非秘密的最终配置计算；不读取 CLI 登录或凭据。 */
  readonly digest: string;
}
export interface AgentRuntimeBinding {
  readonly id: string;
  readonly runtimeId: string;
  readonly projectId: string;
  readonly groupId: string;
  readonly memberId: string;
  readonly revision: number;
  readonly overrides: RuntimeOverrides;
  readonly advanced: RuntimeAdvancedSelection | null;
  readonly desiredState: RuntimeDesiredState;
  readonly intentRevision: number;
  /** 显式 start/apply 捕获的配置，避免启动前又被全局默认编辑偷换。 */
  readonly requestedSnapshot: RuntimeAppliedConfig | null;
  readonly resetSessionRequested: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type RuntimeRunnerState = "stopped" | "starting" | "running" | "stopping" | "failed";
export type RuntimeRunnerPhase = "idle" | "working" | "unknown";
export type RuntimeSessionState = "new" | "resumable" | "invalid" | "reset" | "unknown";
export type RuntimePermissionObservation = "unknown" | "auto" | "manual" | "workspace-write" | "bypassPermissions";
export interface AgentRunnerState {
  readonly bindingId: string;
  readonly state: RuntimeRunnerState;
  readonly phase: RuntimeRunnerPhase;
  readonly generation: number;
  readonly owner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly applied: RuntimeAppliedConfig | null;
  readonly harnessSessionId: string | null;
  readonly sessionState: RuntimeSessionState;
  /** 仅用于显示，绝不据此 kill/接管进程。 */
  readonly pid: number | null;
  readonly processIdentity: OwnedProcessIdentity | null;
  readonly exitConfirmed: boolean;
  readonly observedAt: string | null;
  readonly startedAt: string | null;
  readonly attemptCount: number;
  readonly nextRetryAt: string | null;
  readonly lastErrorCode: string | null;
  readonly lastExitCode: number | null;
  readonly lastExitSignal: string | null;
  readonly permissionObserved: RuntimePermissionObservation;
  readonly updatedAt: string;
}

export interface RuntimeEffectiveConfig extends RuntimeAppliedConfig {
  readonly sources: Readonly<Record<keyof RuntimeConfig, "default" | "override">>;
}
export interface RuntimeBindingView {
  readonly runtime: AgentRuntime;
  readonly binding: AgentRuntimeBinding;
  readonly runner: AgentRunnerState;
  readonly effective: RuntimeEffectiveConfig;
  readonly pendingChanges: boolean;
}
export interface RuntimeView {
  readonly runtime: AgentRuntime;
  readonly bindings: readonly RuntimeBindingView[];
}

export interface NewRuntimeBinding {
  readonly projectId: string;
  readonly groupId: string;
  readonly overrides?: RuntimeOverrides;
}
export interface NewRuntime {
  readonly name: string;
  readonly backend: RuntimeBackend;
  readonly defaults: Partial<RuntimeConfig> & Pick<RuntimeConfig, "workdir">;
  readonly bindings: readonly NewRuntimeBinding[];
}
export interface UpdateRuntimeBinding extends RuntimeRevision {
  readonly overrides: RuntimeOverrides;
  /** 每次编辑默认关闭；显式传入策略才将选择绑定新 binding revision。 */
  readonly advancedStrategy?: RuntimeAdvancedStrategy | null;
}

export interface RunnerFence {
  readonly bindingId: string;
  readonly memberId: string;
  readonly owner: string;
  readonly generation: number;
}
export interface FenceOptions {
  /** 用于投递新业务；在途消息回复/ACK 可保持 false。 */
  readonly requireRunningIntent?: boolean;
  /** 默认检查租约；已持有 ChildProcess 的退出回写可显式设 false。 */
  readonly requireLease?: boolean;
  /** 默认检查可用项目/群组/成员；退出清理与进程观察可关闭。 */
  readonly requireActiveScope?: boolean;
}
export interface RunnerPatch {
  readonly state?: RuntimeRunnerState;
  readonly phase?: RuntimeRunnerPhase;
  readonly pid?: number | null;
  readonly lastErrorCode?: string | null;
  readonly nextRetryAt?: string | null;
  readonly permissionObserved?: RuntimePermissionObservation;
  readonly sessionState?: RuntimeSessionState;
}
export interface RunnerExit {
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly errorCode?: string | null;
  readonly retryAt?: string | null;
}
export type RuntimeIntent = "start" | "retry" | "stop" | "apply" | "new-session";

export interface WakeableRuntimeBinding {
  readonly bindingId: string;
  readonly memberId: string;
  readonly projectId: string;
  readonly groupId: string;
  readonly firstMessageAt: string;
  readonly messageIds: readonly string[];
}

export interface RuntimeRepository {
  create(input: NewRuntime): Promise<RuntimeView>;
  get(id: string): Promise<RuntimeView | null>;
  list(): Promise<RuntimeView[]>;
  getBinding(id: string): Promise<RuntimeBindingView | null>;
  listBindings(filter?: { projectId?: string; groupId?: string; memberId?: string }): Promise<RuntimeBindingView[]>;
  updateDefaults(id: string, expectedRevision: number, defaults: Partial<RuntimeConfig> & Pick<RuntimeConfig, "workdir">): Promise<RuntimeView>;
  addBinding(runtimeId: string, input: NewRuntimeBinding, expectedRuntimeRevision?: number): Promise<RuntimeBindingView>;
  updateBinding(id: string, input: UpdateRuntimeBinding): Promise<RuntimeBindingView>;
  intent(id: string, action: RuntimeIntent, expectedIntentRevision?: number, expectedConfig?: RuntimeRevision): Promise<RuntimeBindingView>;
  claim(id: string, owner: string, options?: { leaseMs?: number; expectedIntentRevision?: number; expectedConfigDigest?: string }): Promise<RunnerFence>;
  checkFence(fence: RunnerFence, options?: FenceOptions): Promise<RuntimeBindingView>;
  /** fn 只执行同一数据库上的短事务操作；不可在里面等待 CLI/网络/模型。 */
  withFence<T>(fence: RunnerFence, fn: () => Promise<T>, options?: FenceOptions): Promise<T>;
  renew(fence: RunnerFence, leaseMs?: number): Promise<void>;
  /** supervisor 在已观察连续健康窗口后调用，不能由消息或 CLI 输出自行重置。 */
  resetFailures(fence: RunnerFence): Promise<void>;
  patchRunner(fence: RunnerFence, patch: RunnerPatch): Promise<RuntimeBindingView>;
  markReady(fence: RunnerFence, pid?: number): Promise<RuntimeBindingView>;
  markStopping(fence: RunnerFence): Promise<RuntimeBindingView>;
  setSession(fence: RunnerFence, sessionId: string): Promise<RuntimeBindingView>;
  setProcessIdentity(fence: RunnerFence, identity: OwnedProcessIdentity): Promise<RuntimeBindingView>;
  /** 仅 supervisor 持有受信 launcher 的退出证明后调用；再次校验旧 fence、内核身份与过期租约。 */
  recoverExited(fence: RunnerFence, expectedIdentity: OwnedProcessIdentity, exit: RunnerExit): Promise<RuntimeBindingView>;
  markExit(fence: RunnerFence, exit: RunnerExit): Promise<RuntimeBindingView>;
  /** 无进程所有权时记录排队原因；不可覆盖活跃 generation。 */
  queued(id: string, reason: string, retryAt?: string | null): Promise<RuntimeBindingView>;
  listWakeable(): Promise<WakeableRuntimeBinding[]>;
  /** 与 MCP join 共用成员行锁；允许嵌入现有 DbDriver 事务。 */
  withMemberLock<T>(memberId: string, fn: () => Promise<T>): Promise<T>;
  /** 外部 join 须在 withMemberLock 内调用并在同一事务中建立连接。 */
  assertExternalJoinAllowed(memberId: string): Promise<void>;
  removeBinding(id: string): Promise<void>;
  delete(id: string): Promise<void>;
}

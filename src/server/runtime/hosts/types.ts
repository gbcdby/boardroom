import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/** 托管执行能力与现有 MCP HostAdapter 分开：平台编排不意味着 wakeIdle。 */
export type ManagedBackend = "claude-code" | "codex-cli" | "dsh";

export interface ManagedHostConfig {
  readonly workdir: string;
  readonly model?: string;
  readonly tools?: readonly string[];
  readonly systemPrompt?: string;
  readonly permissionMode: string;
  readonly bypass: boolean;
}

export interface HostLaunchSnapshot {
  readonly bindingId: string;
  readonly ownerId: string;
  readonly generation: number;
  readonly revision: number;
  readonly backend: ManagedBackend;
  readonly config: ManagedHostConfig;
  readonly sessionId?: string;
  /** 父进程服务的 JSONL MCP Unix socket；只暴露当前 binding/generation 的能力。 */
  readonly mcpSocketPath?: string;
  readonly identity?: { readonly displayName: string; readonly projectId: string; readonly groupId: string };
}

export type HostReason =
  | "supported" | "host_not_installed" | "host_version_unknown" | "host_version_unsupported"
  | "profile_unsupported" | "isolation_unavailable" | "workdir_invalid" | "workdir_unsafe" | "protected_path_overlap"
  | "config_invalid" | "login_required" | "launch_failed" | "permission_mode_unknown"
  | "permission_mode_fallback" | "resume_failed" | "protocol_invalid" | "usage_unavailable";

export interface HostPreflight {
  readonly supported: boolean;
  readonly reason: HostReason;
  readonly hostVersion?: string;
  readonly expectedPermissionMode: string;
  readonly isolation: "verified" | "unavailable" | "unverified";
}

export type ObservedPermissionMode = "auto" | "bypassPermissions" | "manual" | "dontAsk" | "plan" | "acceptEdits" | "unknown";

interface HostUsageMetric {
  readonly type: "usage";
  readonly source: ManagedBackend;
  readonly harnessVersion: string;
  /** 可信 schema 指定的原生结果顺序，不是 num_turns 或接收时间。 */
  readonly sequence: number;
  readonly metric: "inputTokens" | "cachedInputTokens" | "outputTokens" | "costUsd";
  readonly value: number;
  readonly cumulative: boolean;
  readonly zeroMeaningful: boolean;
  readonly successful: boolean;
  readonly coverage: "partial";
  readonly schemaVerified: true;
}

export type HostUsageEvent = HostUsageMetric & (
  | { readonly scope: "invocation" }
  /** 仅供 supervisor 校验实际归属；原生 SID 不能进入公开观测。 */
  | { readonly scope: "session"; readonly sessionId: string }
);

export type HostEvent =
  | { readonly type: "ready"; readonly permissionMode: ObservedPermissionMode }
  | { readonly type: "permission"; readonly mode: ObservedPermissionMode; readonly status: "observed" | "unknown" | "fallback" }
  | { readonly type: "permission_denied"; readonly reason: "permission_required" }
  | { readonly type: "session"; readonly sessionId: string }
  | { readonly type: "protocol_invalid"; readonly reason: "line_too_large" | "invalid_json" | "invalid_schema" }
  | { readonly type: "usage_unavailable" }
  | { readonly type: "failure"; readonly reason: HostReason }
  | HostUsageEvent
  | { readonly type: "exit"; readonly code: number | null; readonly signal: string | null };

export interface OwnedHostProcess {
  /** 仅供展示；绝不能用于恢复进程归属或下一进程的回收依据。 */
  readonly pid?: number;
  readonly processIdentity?: OwnedProcessIdentity;
  readonly exited: Promise<{ readonly code: number | null; readonly signal: string | null }>;
  /** 调用者须已确认 MCP 安全点；本方法不承诺取消在途工具。 */
  stopAtSafePoint(): void;
  /** 仅生命周期强制结束自有树；不回滚外部效果。 */
  forceStopOwned(): void;
}

export interface HostLauncher {
  preflight(snapshot: HostLaunchSnapshot): Promise<HostPreflight>;
  /** 仅只读核验已落库的受信启动身份；调用方仍须 CAS owner/generation 后处理租约。 */
  inspectPrevious?(identity: OwnedProcessIdentity): Promise<OwnedProcessInspection>;
  launch(snapshot: HostLaunchSnapshot, observer: {
    readonly onEvent: (event: HostEvent) => void;
    /** 必须先完成父端绑定/fence的MCP装配，才向隔离进程放行启动。 */
    readonly onMcpTransport?: (transport: Transport) => Promise<void>;
  }): Promise<OwnedHostProcess>;
}

export interface OwnedProcessIdentity {
  readonly version: 1;
  readonly launcherProtocol: "linux-private-net-v1";
  readonly pid: number;
  readonly kernelBootId: string;
  readonly pidNamespace: string;
  readonly startTicks: string;
}

export interface OwnedProcessInspection {
  readonly status: "wrapper_exited" | "observed_alive" | "unknown";
  readonly reason: "boot_changed" | "process_absent" | "start_ticks_changed" | "identity_matches" | "namespace_unknown" | "read_unavailable" | "identity_invalid";
  readonly inspectedAt: string;
}

/** 仅受信服务器装配可提供，绝不能由 Web/聊天传入。 */
export interface HostInstallation {
  readonly backend: ManagedBackend;
  readonly executable: string;
}

/** 受信版本profile选择代码内固定策略，不能由Web传入路径、env或任意出口。 */
export type NativeCredentialLayout = "claude-linux-user-login-v1";
export type NativeEgressPolicy = "anthropic-api-oauth-v1";

/** 仅由native resolver解析，不能用installation覆盖profile的认证与出口策略。 */
export interface ResolvedHostInstallation extends HostInstallation {
  /** CLI 自有认证文件：只读挂载，不读取/复制/散列文件正文。 */
  readonly credentialMounts: readonly { readonly source: string; readonly destination: string }[];
  /** 固定 provider TLS 目的地；不接受 IP、通配符、非 443 端口。 */
  readonly egressHosts: readonly string[];
}

export interface VerifiedHostProfile {
  readonly backend: ManagedBackend;
  readonly version: string;
  readonly platform: "linux";
  readonly architecture: string;
  readonly executableSha256: string;
  readonly mode: "auto" | "bypassPermissions";
  readonly evidence: string;
  readonly isolationProfile: "linux-private-net-v1";
  readonly nativeCredentialLayout: NativeCredentialLayout;
  readonly egressPolicy: NativeEgressPolicy;
  readonly resumeVerified: boolean;
  readonly usageSchema?: VerifiedUsageSchema;
}

export interface VerifiedUsageSchema {
  readonly format: "claude-result-v1";
  readonly sequenceField: "result_index";
  /** 每项分别固定真实取样确认的作用域。未确认字段保持未知，尤其是 total_cost_usd。 */
  readonly metrics: Readonly<Partial<Record<"inputTokens" | "cachedInputTokens" | "outputTokens" | "costUsd", {
    readonly scope: "invocation" | "session";
    readonly cumulative: boolean;
    readonly zeroMeaningful: boolean;
  }>>>;
  readonly evidence: string;
}

/**
 * 仅真实 host/version/OS 的独立验收可往此表增加项。
 * 历史普通 MCP、CLI help、假进程和 namespace canary 均不足以填 supported。
 */
export const VERIFIED_HOST_PROFILES: readonly VerifiedHostProfile[] = Object.freeze([]);

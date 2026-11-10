import { ApiError } from "./client.ts";
import type { RuntimeBackend, RuntimeBindingViewDto, RuntimeConfigDto, RuntimePermissionMode } from "./runtimes.ts";

export const backendLabels: Record<RuntimeBackend, string> = { "claude-code": "Claude Code", "codex-cli": "Codex CLI", dsh: "DSH" };
export const configLabels: Record<keyof RuntimeConfigDto, string> = {
  workdir: "工作目录", model: "模型", tools: "工具范围", systemPrompt: "附加指令", permissionMode: "普通权限策略",
};
export const configFields = ["workdir", "model", "tools", "systemPrompt", "permissionMode"] as const;
export const summaryLabels = { running: "运行中", queued: "排队中", error: "需要处理", stopped: "已停止", stopping: "停止待确认" };
export const runnerLabels = { stopped: "已停止", starting: "启动中", running: "进程运行", stopping: "等待安全点退出", failed: "运行失败" };
export const memberLabels = { online: "在线", offline: "离线", waiting: "等待消息", working: "工作中" };
export const permissionLabels: Record<string, string> = {
  auto: "Auto", manual: "常规权限确认", "workspace-write": "Workspace write", bypassPermissions: "跳过 CLI 常规确认",
  unknown: "尚未观测", dontAsk: "不询问（dontAsk）", plan: "计划模式", acceptEdits: "允许编辑",
};
const reasonLabels: Record<string, string> = {
  unsupported_harness: "此宿主尚未通过托管验收", host_not_installed: "未找到 CLI，请先安装并登录",
  executable_missing: "未找到 CLI，请先安装并登录", host_version_unknown: "无法确认 CLI 版本",
  host_version_unsupported: "此 CLI 版本尚未通过托管验收", profile_unsupported: "此版本与权限档尚未通过托管验收",
  isolation_unavailable: "当前环境无法建立所需隔离", protected_path_overlap: "工作目录与受保护目录重叠",
  workdir_invalid: "工作目录不可用", workdir_unavailable: "工作目录不可用",
  auth_required: "请先在 CLI 完成登录，再重试", login_required: "请先在 CLI 完成登录，再重试",
  permission_required: "操作被权限策略拒绝，请检查所需权限", permission_mode_unknown: "尚未确认实际权限模式",
  permission_mode_fallback: "CLI 的实际权限模式与请求不一致", identity_conflict: "同一成员已有其他连接或运行所有者",
  startup_timeout: "启动握手超时，消息继续保留", process_exit: "进程已退出", transport_lost: "MCP 连接中断",
  resource_unavailable: "本机资源暂不可用", provider_rate_limited: "供应商暂时限流", protocol_invalid: "宿主输出不符合已验证格式",
  config_invalid: "运行配置不可用", configuration_invalid: "运行配置不可用", launch_failed: "启动失败",
  busy: "同一成员正在处理其他轮次", backoff: "正在等待重试时间", stopping: "正在等待安全点和进程退出",
  scope_inactive: "项目或群组已归档，或成员已停用；等待恢复后再运行",
  awaiting_exit: "尚未确认上一进程退出", previous_exit_unknown: "尚未确认上一进程退出", lease_conflict: "等待运行所有权",
  runtime_previous_exit_unknown: "尚未确认上一进程退出", runtime_member_owned: "同一成员已有运行所有者",
  runtime_retry_backoff: "正在等待重试时间", consecutive_limit: "连续自动回复达到上限", rate_limited: "自动唤醒频率达到上限",
  usage_unavailable: "暂无可信用量数据", usage_missing: "未返回有效用量", schema_unverified: "当前版本的用量格式尚未验证",
  partial_usage: "仅获得部分用量信息", baseline_unknown: "首次或不连续累计快照，增量未知",
  cumulative_reset: "累计值出现重置，需等待新的计数范围", observations_incomplete: "运行记录不完整",
  resume_failed: "会话续接失败，积压消息继续保留", unknown: "原因尚未确认",
};
export function reasonLabel(reason: string | null | undefined): string {
  return reason ? reasonLabels[reason] ?? "原因尚未确认" : "";
}
export function timeLabel(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "尚无记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", { hour12: false });
}
export function isStopped(view: RuntimeBindingViewDto): boolean {
  return view.binding.desiredState === "stopped" && view.runner.state === "stopped" && view.runner.exitConfirmed;
}
export function configValue(config: RuntimeConfigDto | null, field: keyof RuntimeConfigDto): string {
  if (!config) return "尚未应用";
  const value = config[field];
  if (field === "model") return value === null ? "CLI 默认模型" : String(value);
  if (field === "tools") return value === null ? "CLI 默认工具" : (value as readonly string[]).join("、") || "不开放通用工具";
  if (field === "systemPrompt") return value ? `已设置 ${String(value).length} 字` : "无附加指令";
  if (field === "permissionMode") return permissionLabels[String(value)] ?? "未知";
  return String(value);
}
export function runtimeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409 && /revision|intent|conflict/.test(error.message + error.code)) {
      return "配置或运行意图已被更新。本次操作没有覆盖新版本，请刷新后重新打开编辑或再次确认。";
    }
    const known: Record<string, string> = {
      runtime_workdir_unavailable: "工作目录不可访问，请填写本机已存在的目录。",
      runtime_workdir_invalid: "请填写工作目录的绝对路径。", runtime_identity_exists: "相同名称与宿主的 Agent 已存在，请使用不同名称。",
      runtime_tools_invalid: "工具名称格式不正确，请使用逗号或换行分隔的有效名称。",
      runtime_initial_binding_required: "请选择一个已有项目和群组。",
      runtime_not_stopped: "请先停止运行，并等待对应进程退出后再删除配置。",
    };
    return known[error.message] ?? known[error.code] ?? error.message;
  }
  return "无法连接本地服务，请稍后刷新。";
}

export interface RuntimeConfigDraft {
  workdir: string; model: string; toolsMode: "default" | "allowlist" | "none";
  toolsText: string; systemPrompt: string; permissionMode: RuntimePermissionMode;
}
export function initialConfig(backend: RuntimeBackend): RuntimeConfigDraft {
  return { workdir: "", model: "", toolsMode: "default", toolsText: "", systemPrompt: "",
    permissionMode: backend === "claude-code" ? "auto" : backend === "codex-cli" ? "workspace-write" : "manual" };
}
export function configDraft(config: RuntimeConfigDto): RuntimeConfigDraft {
  return { workdir: config.workdir, model: config.model ?? "", toolsMode: config.tools === null ? "default" : config.tools.length ? "allowlist" : "none",
    toolsText: config.tools?.join(", ") ?? "", systemPrompt: config.systemPrompt, permissionMode: config.permissionMode };
}
export function configFromDraft(draft: RuntimeConfigDraft): RuntimeConfigDto {
  return { workdir: draft.workdir.trim(), model: draft.model.trim() || null, systemPrompt: draft.systemPrompt,
    permissionMode: draft.permissionMode,
    tools: draft.toolsMode === "default" ? null : draft.toolsMode === "none" ? [] : [...new Set(draft.toolsText.split(/[,，\n]/).map((v) => v.trim()).filter(Boolean))] };
}

/**
 * T2（#49）预留、T5（#52）落地的**审计钩子**。
 *
 * T2/T3 在组织/汇报线/占岗/成员状态变更的入口处调用 `OrgChangeRecorder.record`。
 * T5 实现本接口（`createAuditRecorder`）并经 `StartServerOptions.orgChangeRecorder`
 * **默认注入**，即把变更写入统一 `audit_log` 并支撑人的撤销权；无需改动 T2/T3 的守卫与 repository。
 * 注入自定义 recorder（如测试替身）时优先于默认实现，既有调用点与断言不变。
 */
export type OrgChangeAction =
  | "node.create"
  | "node.update"
  | "node.delete"
  | "node.assign"
  | "member.auto_place"
  // T3（#50）成员生命周期状态变更：经同一钩子写入审计（member.pause / resume / status_change）。
  | "member.disable"
  | "member.enable"
  | "member.status_change";

/** 审计主体快照（结构内联，避免与 audit 模块形成运行时循环依赖）。 */
export interface OrgChangeActor {
  readonly kind: "human" | "agent" | "system";
  readonly name: string;
  readonly memberId?: string | null;
}

export interface OrgChange {
  readonly projectId: string;
  readonly action: OrgChangeAction;
  readonly nodeId: string | null;
  readonly memberId: string | null;
  /** 变更摘要（仅本票已有的字段，供 T5 决定审计粒度）。 */
  readonly detail: Readonly<Record<string, unknown>>;
  // ---- T5（#52）可选审计字段：T2/T3 旧调用点不填也不影响接口契约 ----
  /** 由 guard() 解析出的真实主体；省略时 recorder 退化为 system。 */
  readonly actor?: OrgChangeActor;
  /** 目标名称快照（成员展示名 / 岗位名）；省略时退化用 targetId。 */
  readonly targetName?: string;
  /** 可撤销事件必填的最小全量快照；传 null 表示「事前不存在」（创建类事件）。 */
  readonly before?: unknown;
  readonly after?: unknown;
  /** 字段级 diff；省略时由 recorder 从 before/after 自动推导。 */
  readonly changed?: unknown;
}

export interface OrgChangeRecorder {
  record(change: OrgChange): void;
}

/** 缺省空实现；T5 在 StartServerOptions 默认注入真实 recorder 前不产生任何写入。 */
export const noopOrgChangeRecorder: OrgChangeRecorder = { record: () => {} };

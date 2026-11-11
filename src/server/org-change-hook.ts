/**
 * 组织与成员变更的提交后观察接口。权威审计由 mutation service 与业务同事务写入；
 * 此 hook 不承担原子性、撤销快照或失败判定。调用方捕获同步及异步观察失败，
 * 不改变已提交结果。旧 recorder 可用于显式的离线适配，不再由服务器默认装配。
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
  /** 提交后观察钩子；权威审计由 mutation service 在事务内持久化。 */
  record(change: OrgChange): void | Promise<void>;
}

/** 缺省空观察者；不会额外写入审计。 */
export const noopOrgChangeRecorder: OrgChangeRecorder = { record: () => {} };

/**
 * T2（#49）为 T5（#52 最小审计 / 撤销）预留的**接口钩子**。
 *
 * 本票只定义契约与空实现：组织/汇报线/占岗变更在入口处调用 `OrgChangeRecorder.record`，
 * 但**不写 `audit_log`、不提供撤销界面/动作**（T5 落）。T3（#50）的成员状态变更同样只调用
 * 本钩子（`member.disable` / `member.enable` / `member.status_change`），不写审计表。
 * T5 只需实现本接口并经 `StartServerOptions.orgChangeRecorder` 注入，即可把变更写入统一审计表并支撑人的撤销权，
 * 无需改动本票的守卫与 repository。
 */
export type OrgChangeAction =
  | "node.create"
  | "node.update"
  | "node.delete"
  | "node.assign"
  | "member.auto_place"
  // T3（#50）成员生命周期状态变更：只留钩子，不写 audit_log（审计/撤销由 T5 #52 落）。
  | "member.disable"
  | "member.enable"
  | "member.status_change";

export interface OrgChange {
  readonly projectId: string;
  readonly action: OrgChangeAction;
  readonly nodeId: string | null;
  readonly memberId: string | null;
  /** 变更摘要（仅本票已有的字段，供 T5 决定审计粒度）。 */
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface OrgChangeRecorder {
  record(change: OrgChange): void;
}

/** 缺省空实现：阶段 1/2 当前没有审计表，T5 注入真实 recorder 前不产生任何写入。 */
export const noopOrgChangeRecorder: OrgChangeRecorder = { record: () => {} };

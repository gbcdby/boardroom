/**
 * 宿主适配层「纯类型 + 工厂」模块（#56 骨架 / #57 四宿主模块共用）。
 *
 * 这一文件刻意保持**零依赖**（不 import 任何 adapter 模块，也不 import `index.ts` 的注册表），
 * 目的是打破「index.ts（定义工厂 + 注册表）⇄ 各宿主模块（需要工厂）」之间的循环导入：
 * 各宿主模块从此文件取 `defineHostAdapter` 与类型，`index.ts` 也从这里取，二者互不依赖。
 * 注册表、`defaultRegistry` 与内建 `UNKNOWN_ADAPTER` 仍留在 `index.ts`。
 *
 * #57 授权的最小接口扩展：在 `HostAdapter` / `HostAdapterSpec` 上新增可选
 * `interruptReasonNote?: string`，用于按宿主记录「为何 interrupt 是 unsupported」的实测解释，
 * 供 T2（#58）消费以移除 core.ts 中 `buildInterruptReason` 的 hostType 分支。
 */

import type { HostType } from "../../db/types.ts";

/** 再导出开放 `HostType`，使 adapters 模块成为宿主类型的统一引用点。 */
export type { HostType };

/** 宿主打断能力：与 `InterruptResult` 同源，缺省 `unsupported`。 */
export type HostInterruptCapabilityValue = "accepted" | "rejected" | "unsupported";

/** 宿主重连能力，缺省 `unsupported`。 */
export type HostReconnectCapability = "supported" | "unsupported";

/**
 * 宿主能力声明。
 *
 * NFR-HOST-02（不臆造能力）：任何未显式声明的能力一律视为「不承诺」。
 * 因此每个字段都有安全的默认值（见 {@link DEFAULT_HOST_CAPABILITIES}）。
 */
export interface HostCapabilities {
  /** 能否打断在途工具；缺省 `unsupported`。 */
  readonly interrupt: HostInterruptCapabilityValue;
  /** 能否主动唤醒空闲宿主；缺省 `false`（未承诺）。 */
  readonly wakeIdle: boolean;
  /** 断线后能否自动重连；缺省 `unsupported`。 */
  readonly reconnect: HostReconnectCapability;
}

/** 能力默认值：全部「不承诺」（NFR-HOST-02）。 */
export const DEFAULT_HOST_CAPABILITIES: HostCapabilities = Object.freeze({
  interrupt: "unsupported",
  wakeIdle: false,
  reconnect: "unsupported",
});

/** 入群相关配置（未来宿主可在此声明入群约束）。 */
export interface HostJoinConfig {
  readonly notes?: string;
}

/** 能力证据：声明的能力必须可追溯、可复现（NFR-HOST-02）。 */
export interface HostEvidence {
  /** 证据来源描述（如「D6/#10 Claude Code 实测」）。 */
  readonly source?: string;
  /** 是否已验证（实测/文档）；未验证的能力不应被声明为 supported。 */
  readonly verified?: boolean;
}

/**
 * 宿主适配器：描述一个宿主的差异点（传输方式、能力、入群配置、证据、打断原因说明）。
 *
 * #57 扩展：`interruptReasonNote` 为可选字段，记录该宿主「为何 interrupt 是 unsupported」
 * 的实测解释；T2（#58）将用它在 core.ts 中取代 `buildInterruptReason` 的 hostType 分支。
 */
export interface HostAdapter {
  /** 唯一 id；同时是 `HostType` 的一个取值。 */
  readonly id: HostType;
  /** 人类可读名称。 */
  readonly label: string;
  /** 支持的传输方式（如 `"stdio"` / `"streamable-http"`）。 */
  readonly transports: readonly string[];
  /** 能力声明；未声明字段按 {@link DEFAULT_HOST_CAPABILITIES} 计。 */
  readonly capabilities: HostCapabilities;
  /** 入群配置。 */
  readonly joinConfig: HostJoinConfig;
  /** 能力证据。 */
  readonly evidence: HostEvidence;
  /**
   * 打断原因说明：解释该宿主为何 interrupt 是 `unsupported`（实测依据）。
   * 可选，默认空；T2（#58）将消费它以移除 core 的 hostType 分支。
   */
  readonly interruptReasonNote?: string;
}

/** 注册一个 adapter 时允许的部分字段；缺省由 {@link DEFAULT_HOST_CAPABILITIES} 等补齐。 */
export interface HostAdapterSpec {
  readonly id: HostType;
  readonly label: string;
  readonly transports?: readonly string[];
  readonly capabilities?: Partial<HostCapabilities>;
  readonly joinConfig?: HostJoinConfig;
  readonly evidence?: HostEvidence;
  /** 打断原因说明（见 {@link HostAdapter.interruptReasonNote}）。 */
  readonly interruptReasonNote?: string;
}

/**
 * 用声明式 spec 构造一个 {@link HostAdapter}，并把缺失的能力/字段补齐为安全默认值。
 *
 * NFR-HOST-02：未声明的能力字段一律落到 {@link DEFAULT_HOST_CAPABILITIES}，
 * 因此调用方「少写」一个能力绝不会让它变成 `supported` / `true`。
 */
export function defineHostAdapter(spec: HostAdapterSpec): HostAdapter {
  return {
    id: spec.id,
    label: spec.label,
    transports: spec.transports ?? [],
    capabilities: { ...DEFAULT_HOST_CAPABILITIES, ...spec.capabilities },
    joinConfig: spec.joinConfig ?? {},
    evidence: spec.evidence ?? {},
    // 仅在显式提供时才带 interruptReasonNote，避免 exactOptionalPropertyTypes 下写入 undefined。
    ...(spec.interruptReasonNote !== undefined
      ? { interruptReasonNote: spec.interruptReasonNote }
      : {}),
  };
}

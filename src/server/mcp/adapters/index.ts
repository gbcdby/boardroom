/**
 * 宿主适配层注册表骨架（#56 / F1）。
 *
 * 把「宿主差异」收敛到一层可注册的代码：未来增加宿主 = 新增一个 adapter 模块 + 在此注册，
 * 不需要改动 core 的运行期硬编码（NFR-HOST-01 / 「核心硬编码不随宿主变化」）。
 *
 * 设计要点：
 * - `HostType` 现在是**开放类型**（任何已注册 adapter 的 id + 内建 `"other"`），不再是写死的联合类型。
 *   这样既兼容现有 `claude-code` / `codex-cli` / `other`，又为未来宿主（如 `dsh`）留出扩展空间，
 *   无需改核心类型。
 * - 能力默认「不承诺」：任何未显式声明并给出证据的能力一律 `unsupported` / `false`（NFR-HOST-02）。
 *   `defineHostAdapter` 在注册时把缺省能力补齐为默认值，绝不臆造能力。
 * - 内建 `UNKNOWN_ADAPTER`（id `"other"`）是所有未注册宿主的回退；它始终被视为已注册，
 *   且不可被卸载，保证 `getAdapter` 对任何传入值都返回一个合法适配器。
 *
 * 非本票范围（由其他票负责）：四个具体宿主模块（T1 #57）、core 运行期硬编码收敛（T2 #58）、
 * dsh 身份迁移（T3 #59）、证据文档（T4 #60）。本模块只提供骨架与注册机制。
 */

import type { HostType } from "../../db/types.ts";

/** 再导出开放 `HostType`，使 adapters 模块成为宿主类型的统一引用点（#56）。 */
export type { HostType };

/** 已知宿主 id 集合：当前已认知的宿主。未来宿主只需注册，不必改这里（NFR-HOST-01）。 */
export const KNOWN_HOST_TYPES: readonly HostType[] = ["claude-code", "codex-cli", "other"];

/** 未知宿主的内建 id；所有未注册、非其它宿主都回退到它。 */
export const UNKNOWN_HOST_ID = "other" as const;

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

/** 入群相关配置（未来宿主可在此声明入群约束；当前为空，由各宿主模块在 T1 填充）。 */
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

/** 宿主适配器：描述一个宿主的差异点（传输方式、能力、入群配置、证据）。 */
export interface HostAdapter {
  /** 唯一 id；同时是 `HostType` 的一个取值。 */
  readonly id: HostType;
  /** 人类可读名称。 */
  readonly label: string;
  /** 支持的传输方式（如 `"mcp"` / `"websocket"` / `"stdio"`）。 */
  readonly transports: readonly string[];
  /** 能力声明；未声明字段按 {@link DEFAULT_HOST_CAPABILITIES} 计。 */
  readonly capabilities: HostCapabilities;
  /** 入群配置。 */
  readonly joinConfig: HostJoinConfig;
  /** 能力证据。 */
  readonly evidence: HostEvidence;
}

/** 注册一个 adapter 时允许的部分字段；缺省由 {@link DEFAULT_HOST_CAPABILITIES} 等补齐。 */
export interface HostAdapterSpec {
  readonly id: HostType;
  readonly label: string;
  readonly transports?: readonly string[];
  readonly capabilities?: Partial<HostCapabilities>;
  readonly joinConfig?: HostJoinConfig;
  readonly evidence?: HostEvidence;
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
  };
}

/** 内建「未知宿主」适配器：所有未注册宿主的回退。 */
export const UNKNOWN_ADAPTER: HostAdapter = Object.freeze(
  defineHostAdapter({
    id: UNKNOWN_HOST_ID,
    label: "未知宿主",
    evidence: {
      source: "内置回退；宿主能力未知，按 unsupported / false 处理",
      verified: false,
    },
  }),
);

/** 宿主适配层注册表接口。 */
export interface HostAdapterRegistry {
  /** 注册（或覆盖）一个适配器。 */
  registerAdapter(adapter: HostAdapter): void;
  /** 卸载一个非内建的适配器；内建回退不可卸载，返回 false。 */
  unregisterAdapter(id: HostType): boolean;
  /** 该 id 是否已注册（内建 `"other"` 始终为 true）。 */
  isRegistered(id: HostType): boolean;
  /**
   * 取适配器；未注册且非 `"other"` 的宿主回退到 {@link UNKNOWN_ADAPTER}。
   * 因此该方法对任意输入都保证返回一个合法适配器。
   */
  getAdapter(id: HostType): HostAdapter;
  /** 列出所有已注册适配器的 id（含内建）。 */
  listAdapterIds(): HostType[];
}

/**
 * 创建一个独立注册表实例（便于测试隔离，也允许宿主模块持有自己的子注册表）。
 * 默认内建包含 {@link UNKNOWN_ADAPTER}，保证回退始终可用。
 */
export function createHostAdapterRegistry(
  builtins: readonly HostAdapter[] = [UNKNOWN_ADAPTER],
): HostAdapterRegistry {
  const adapters = new Map<HostType, HostAdapter>();
  for (const adapter of builtins) adapters.set(adapter.id, adapter);

  return {
    registerAdapter(adapter: HostAdapter): void {
      adapters.set(adapter.id, adapter);
    },
    unregisterAdapter(id: HostType): boolean {
      if (id === UNKNOWN_HOST_ID) return false; // 内建回退不可卸载。
      return adapters.delete(id);
    },
    isRegistered(id: HostType): boolean {
      return adapters.has(id);
    },
    getAdapter(id: HostType): HostAdapter {
      return adapters.get(id) ?? adapters.get(UNKNOWN_HOST_ID)!;
    },
    listAdapterIds(): HostType[] {
      return [...adapters.keys()];
    },
  };
}

/** 全局默认注册表（内建包含 {@link UNKNOWN_ADAPTER}）。 */
export const defaultRegistry: HostAdapterRegistry = createHostAdapterRegistry();

// 便捷函数：直接操作全局默认注册表，避免到处引用 defaultRegistry。
export function registerAdapter(adapter: HostAdapter): void {
  defaultRegistry.registerAdapter(adapter);
}

export function unregisterAdapter(id: HostType): boolean {
  return defaultRegistry.unregisterAdapter(id);
}

export function isRegistered(id: HostType): boolean {
  return defaultRegistry.isRegistered(id);
}

export function getAdapter(id: HostType): HostAdapter {
  return defaultRegistry.getAdapter(id);
}

export function listAdapterIds(): HostType[] {
  return defaultRegistry.listAdapterIds();
}

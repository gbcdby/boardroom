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

// #57：纯类型 + 工厂（HostType / HostCapabilities / defineHostAdapter / DEFAULT_HOST_CAPABILITIES 等）
// 已抽到 dependency-free 的 ./types.ts，以打破 index.ts ⇄ 各宿主模块之间的循环导入。
// 这里统一再导出，保持 index.ts 作为宿主适配层对外入口不变（#56 的公开 API 不回归）。
import type {
  HostAdapter,
  HostAdapterSpec,
  HostCapabilities,
  HostEvidence,
  HostInterruptCapabilityValue,
  HostReconnectCapability,
  HostType,
} from "./types.ts";
import { DEFAULT_HOST_CAPABILITIES, defineHostAdapter } from "./types.ts";

export type {
  HostAdapter,
  HostAdapterSpec,
  HostCapabilities,
  HostEvidence,
  HostInterruptCapabilityValue,
  HostReconnectCapability,
  HostType,
} from "./types.ts";
export { DEFAULT_HOST_CAPABILITIES, defineHostAdapter } from "./types.ts";

// #57（T1）：把四个具体宿主模块注册进全局默认注册表。
// 「unknown」即内建 UNKNOWN_ADAPTER（id "other"），已在下方定义，不重复注册。
import { CLAUDE_CODE_ADAPTER } from "./claude-code.ts";
import { CODEX_CLI_ADAPTER } from "./codex-cli.ts";
import { DSH_ADAPTER } from "./dsh.ts";

/**
 * 已知宿主 id 快照：仅为方便阅读的「当前已注册宿主」清单。
 * 单一事实来源是下方注册表（{@link listAdapterIds} / `defaultRegistry`）；
 * 新增宿主只需 `registerAdapter`，无需（也不应）改这里（NFR-HOST-01：核心不随宿主变化）。
 */
export const KNOWN_HOST_TYPES: readonly HostType[] = [
  "claude-code",
  "codex-cli",
  "dsh",
  "other",
];

/** 未知宿主的内建 id；所有未注册、非其它宿主都回退到它。 */
export const UNKNOWN_HOST_ID = "other" as const;

/** 内建「未知宿主」适配器：所有未注册宿主的回退。 */
export const UNKNOWN_ADAPTER: HostAdapter = Object.freeze(
  defineHostAdapter({
    id: UNKNOWN_HOST_ID,
    label: "未知宿主",
    evidence: {
      source: "内置回退；宿主能力未知，按 unsupported / false 处理",
      verified: false,
    },
    // #57：unknown 的打断原因说明（T2 #58 将消费此字段）。
    interruptReasonNote: "宿主能力未知",
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

// #57（T1）：把四个具体宿主模块中的 claude-code / codex-cli / dsh 注册进全局默认注册表，
// 实现「一个宿主 = 一个代码模块」。「unknown」（id "other"）即上方内建 UNKNOWN_ADAPTER，
// 已作为默认回退始终可用，无需重复注册。
defaultRegistry.registerAdapter(CLAUDE_CODE_ADAPTER);
defaultRegistry.registerAdapter(CODEX_CLI_ADAPTER);
defaultRegistry.registerAdapter(DSH_ADAPTER);

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

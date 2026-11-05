import { defineHostAdapter } from "./types.ts";

/**
 * codex-cli 宿主适配器（#57 / T1）：一个宿主 = 一个代码模块。
 *
 * 实测证据（见 `docs/t8-acceptance-report.md`；原始 `.out` 见本地留档 `.agent-output/real-host-retest/`，不入库）：
 * - interrupt: `"unsupported"` — D6/#10 配额阻塞未实测，按 unsupported 处理。
 * - reconnect: `"supported"` — `reconnect-codex2.out` 重连补投 `drainedBacklog:true`。
 * - transports: `["stdio","streamable-http"]`（与现有 join 行为一致）。
 * - 无空闲唤醒证据 → `wakeIdle` 保持默认 `false`（NFR-HOST-02：绝不臆造能力）。
 */
export const CODEX_CLI_ADAPTER = defineHostAdapter({
  id: "codex-cli",
  label: "Codex CLI",
  transports: ["stdio", "streamable-http"],
  capabilities: {
    interrupt: "unsupported",
    wakeIdle: false,
    reconnect: "supported",
  },
  evidence: {
    source:
      "D6/#10 配额阻塞未实测，按 unsupported；reconnect-codex2.out 重连补投 drainedBacklog:true",
    verified: true,
  },
  // #57：T2（#58）将用此字段取代 core.ts buildInterruptReason 的 hostType 分支。
  interruptReasonNote:
    "Codex CLI 等待/打断行为因配额阻塞未实测（D6/#10），按 unsupported 处理",
});

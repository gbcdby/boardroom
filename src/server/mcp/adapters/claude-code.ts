import { defineHostAdapter } from "./types.ts";

/**
 * claude-code 宿主适配器（#57 / T1）：一个宿主 = 一个代码模块。
 *
 * 实测证据（见 `docs/t8-acceptance-report.md`；原始 `.out` 见本地留档 `.agent-output/real-host-retest/`，不入库）：
 * - interrupt: `"unsupported"` — D6/#10 实测 Claude Code 不能打断在途工具调用。
 * - reconnect: `"supported"` — `reconnect-claude.out` 重连后 `drainedBacklog:true` 补投成功。
 * - transports: `["stdio","streamable-http"]`（与现有 join 行为一致）。
 * - 无空闲唤醒证据 → `wakeIdle` 保持默认 `false`（NFR-HOST-02：绝不臆造能力）。
 */
export const CLAUDE_CODE_ADAPTER = defineHostAdapter({
  id: "claude-code",
  label: "Claude Code",
  transports: ["stdio", "streamable-http"],
  capabilities: {
    interrupt: "unsupported",
    wakeIdle: false,
    reconnect: "supported",
  },
  evidence: {
    source:
      "D6/#10 实测不能打断在途工具；reconnect-claude.out 重连后 drainedBacklog:true 补投成功",
    verified: true,
  },
  // #57：T2（#58）将用此字段取代 core.ts buildInterruptReason 的 hostType 分支。
  interruptReasonNote:
    "Claude Code 实测不能打断在途工具调用（D6/#10），安全点投递是唯一可靠语义",
});

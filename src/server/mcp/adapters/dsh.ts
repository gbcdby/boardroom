import { defineHostAdapter } from "./types.ts";

/**
 * dsh（DeepSeek Harness）宿主适配器（#57 / T1）：一个宿主 = 一个代码模块。
 *
 * 实测证据（仅限 `.agent-output/real-host-retest/` 中的 DSH 0.2.1-rc.5，绝不臆造）：
 * - `dsh-join.out`：join 成功（DSH 仅为「附加」宿主，hostType=other）。
 * - `dsh-wait.out`：活跃等待中活唤醒 `drainedBacklog:false`。
 *
 * 仅有的证据是 join + 活跃等待中的活唤醒，**无**重连证据、**无**空闲唤醒证据，
 * 因此 reconnect / wakeIdle 一律保持默认（NFR-HOST-02：不臆造能力，不承诺唤醒空闲宿主）。
 *
 * transports 基于 DSH 实测接入方式（`@deepseek-ai/dsh-mcp-client` 支持 streamable-http；
 * CLI 亦支持 stdio）；与 claude-code / codex-cli 取一致的声明口径。
 */
export const DSH_ADAPTER = defineHostAdapter({
  id: "dsh",
  label: "DeepSeek Harness (dsh)",
  transports: ["stdio", "streamable-http"],
  capabilities: {
    interrupt: "unsupported",
    wakeIdle: false,
    reconnect: "unsupported",
  },
  evidence: {
    source:
      ".agent-output/real-host-retest/README.md（DSH 0.2.1-rc.5：dsh-join.out join 成功、dsh-wait.out 活跃等待中活唤醒 drainedBacklog:false）",
    verified: true,
  },
  // #57：T2（#58）将用此字段取代 core.ts buildInterruptReason 的 hostType 分支。
  interruptReasonNote:
    "DSH 等待/打断行为无实测证据，按 unsupported 处理（参照 D6/#10；DSH 仅实测 join + 活跃等待活唤醒）",
});

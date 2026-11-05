import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultRegistry,
  getAdapter,
  isRegistered,
  type HostAdapter,
} from "../src/server/mcp/adapters/index.ts";

/**
 * #57（T1）四宿主适配模块测试。
 *
 * seam：四个具体宿主模块（claude-code / codex-cli / dsh / other）作为代码插件注册进
 * `defaultRegistry`，各自声明 transports / capabilities / evidence / interruptReasonNote。
 *
 * 非目标（属于其他票）：core 运行期硬编码收敛（T2 #58）、dsh 身份迁移（T3 #59）、
 * 证据文档（T4 #60）。本测试只验证「一个宿主 = 一个代码模块」这一交付行为与证据准确性，
 * 不触碰 buildInterruptReason 的 hostType 分支、join 白名单或 server.ts 的 z.enum。
 *
 * 映射到 AC-HOST-02。
 */

const HOSTS: readonly string[] = ["claude-code", "codex-cli", "dsh", "other"];

test("四个宿主模块都在 defaultRegistry 中已注册且 getAdapter 返回非 null", () => {
  for (const id of HOSTS) {
    assert.equal(isRegistered(id as never), true, `${id} 应已注册`);
    const adapter = getAdapter(id as never);
    assert.ok(adapter, `${id} 的 getAdapter 应返回非 null`);
    assert.equal(adapter.id, id);
    assert.equal(adapter, defaultRegistry.getAdapter(id as never));
  }
});

test("claude-code / codex-cli / dsh 的 transports 与 capabilities 符合实测证据表", () => {
  // claude-code：reconnect=supported，interrupt=unsupported，wakeIdle=false。
  const cc = getAdapter("claude-code" as never);
  assert.deepEqual([...(cc.transports ?? [])].sort(), ["stdio", "streamable-http"]);
  assert.equal(cc.capabilities.interrupt, "unsupported");
  assert.equal(cc.capabilities.wakeIdle, false);
  assert.equal(cc.capabilities.reconnect, "supported");

  // codex-cli：reconnect=supported，其余默认。
  const cx = getAdapter("codex-cli" as never);
  assert.deepEqual([...(cx.transports ?? [])].sort(), ["stdio", "streamable-http"]);
  assert.equal(cx.capabilities.interrupt, "unsupported");
  assert.equal(cx.capabilities.wakeIdle, false);
  assert.equal(cx.capabilities.reconnect, "supported");

  // dsh：所有能力保持默认（unsupported / false）；transports 未对 agent harness 独立实测，
  // 不臆造（NFR-HOST-02），故缺省为空数组（与 claude-code / codex-cli 的已知事实不同）。
  const dsh = getAdapter("dsh" as never);
  assert.deepEqual([...(dsh.transports ?? [])].sort(), []);
  assert.equal(dsh.capabilities.interrupt, "unsupported");
  assert.equal(dsh.capabilities.wakeIdle, false);
  assert.equal(dsh.capabilities.reconnect, "unsupported");
});

test("dsh 模块 evidence 指向真实实测证据且能力未臆造", () => {
  const dsh = getAdapter("dsh" as never);
  // 证据必须指向已提交的实证目录 evidence/real-host-retest/（DSH 0.2.1-rc.5 真实实测）。
  assert.ok(
    (dsh.evidence.source ?? "").includes("evidence/real-host-retest/"),
    `dsh evidence 应指向真实实测目录，实际为：${dsh.evidence.source}`,
  );
  assert.equal(dsh.evidence.verified, true);
  // 无重连证据、无空闲唤醒证据 → 保持默认，绝不臆造。
  assert.equal(dsh.capabilities.reconnect, "unsupported");
  assert.equal(dsh.capabilities.wakeIdle, false);
});

test("unknown (other) 模块能力全默认且 transports 为空", () => {
  const other = getAdapter("other" as never);
  assert.deepEqual([...(other.transports ?? [])].sort(), []);
  assert.equal(other.capabilities.interrupt, "unsupported");
  assert.equal(other.capabilities.wakeIdle, false);
  assert.equal(other.capabilities.reconnect, "unsupported");
});

test("四个宿主的 interruptReasonNote 均存在、非空且匹配实测解释", () => {
  const expected: Record<string, string> = {
    "claude-code":
      "Claude Code 实测不能打断在途工具调用（D6/#10），安全点投递是唯一可靠语义",
    "codex-cli":
      "Codex CLI 等待/打断行为因配额阻塞未实测（D6/#10），按 unsupported 处理",
    dsh: "DSH 等待/打断行为无实测证据，按 unsupported 处理（参照 D6/#10；DSH 仅实测 join + 活跃等待活唤醒）",
    other: "宿主能力未知",
  };

  for (const id of HOSTS) {
    const adapter = getAdapter(id as never) as HostAdapter;
    assert.ok(
      typeof adapter.interruptReasonNote === "string" &&
        adapter.interruptReasonNote.length > 0,
      `${id} 的 interruptReasonNote 应存在且非空`,
    );
    assert.equal(
      adapter.interruptReasonNote,
      expected[id],
      `${id} 的 interruptReasonNote 应匹配实测解释文本`,
    );
  }
});

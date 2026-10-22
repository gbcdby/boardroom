import test from "node:test";
import assert from "node:assert/strict";
import {
  createAntiLoop,
  DEFAULT_ANTI_LOOP_CONFIG,
  type AntiLoop,
} from "../src/server/chat/antiloop.ts";

/**
 * T7（#20）防自触发 / 防环域服务的单元测试（seam：`createAntiLoop` 公共接口）。
 *
 * 覆盖 ticket 的验收点：
 * - 每群组连续自动回复上限 6：第 7 条 agent 消息起停止自动唤醒；
 * - 人类消息 / 显式恢复后重置；
 * - 每成员滚动 1 分钟最多 20 次唤醒（跨群组累计，manager 计入同一成员）；
 * - 窗口滚动后重新放行（超限消息不丢弃由 MCP 层负责，这里验证「窗口重置后允许」）；
 * - 阈值可配置（含窗口长度）。
 * 用模拟时钟驱动，不依赖真实时间。
 */

/** 可手动推进的模拟时钟。 */
function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

function make(overrides?: Parameters<typeof createAntiLoop>[0]): { loop: AntiLoop; clock: ReturnType<typeof fakeClock> } {
  const clock = fakeClock();
  const loop = createAntiLoop({ ...overrides, now: clock.now });
  return { loop, clock };
}

test("默认阈值符合 D5：连续 6 次、每成员每分钟 20 次", () => {
  assert.equal(DEFAULT_ANTI_LOOP_CONFIG.maxConsecutiveAutoReplies, 6);
  assert.equal(DEFAULT_ANTI_LOOP_CONFIG.maxWakesPerMinutePerMember, 20);
  assert.equal(DEFAULT_ANTI_LOOP_CONFIG.wakeRateWindowMs, 60_000);
});

test("同一群组连续 6 条 agent 消息仍允许唤醒；第 7 条起停止自动唤醒", () => {
  const { loop } = make();
  const g = "g1";
  // 第 1–6 条 agent 消息：候选唤醒都放行。
  for (let i = 1; i <= 6; i += 1) {
    const d = loop.registerMessage({ groupId: g, senderKind: "agent", candidateWake: ["b"] });
    assert.deepEqual(d.allowed, ["b"], `第 ${i} 条应允许唤醒`);
    assert.equal(d.consecutiveCapReached, false);
    assert.equal(d.consecutiveAutoReplies, i);
  }
  // 第 7 条：达到上限外，停止自动唤醒。
  const d7 = loop.registerMessage({ groupId: g, senderKind: "agent", candidateWake: ["b", "c"] });
  assert.deepEqual(d7.allowed, []);
  assert.equal(d7.consecutiveCapReached, true);
  assert.equal(d7.suppressed.get("b"), "consecutive_limit");
  assert.equal(d7.suppressed.get("c"), "consecutive_limit");
});

test("人类消息重置本群组连续计数，重新允许自动唤醒", () => {
  const { loop } = make();
  const g = "g1";
  for (let i = 1; i <= 7; i += 1) {
    loop.registerMessage({ groupId: g, senderKind: "agent", candidateWake: ["b"] });
  }
  assert.equal(loop.consecutiveCount(g), 7);
  // 人发消息：重置为 0。
  const human = loop.registerMessage({ groupId: g, senderKind: "human", candidateWake: ["b"] });
  assert.equal(human.consecutiveAutoReplies, 0);
  assert.deepEqual(human.allowed, ["b"], "人类消息后 agent 可被再次唤醒");
  assert.equal(loop.consecutiveCount(g), 0);
  // 再发一条 agent 消息，计数从 1 起。
  const again = loop.registerMessage({ groupId: g, senderKind: "agent", candidateWake: ["b"] });
  assert.equal(again.consecutiveAutoReplies, 1);
  assert.deepEqual(again.allowed, ["b"]);
});

test("显式恢复 resetGroup 重置连续计数", () => {
  const { loop } = make();
  const g = "g1";
  for (let i = 1; i <= 7; i += 1) {
    loop.registerMessage({ groupId: g, senderKind: "agent", candidateWake: ["b"] });
  }
  loop.resetGroup(g);
  assert.equal(loop.consecutiveCount(g), 0);
  const d = loop.registerMessage({ groupId: g, senderKind: "agent", candidateWake: ["b"] });
  assert.deepEqual(d.allowed, ["b"]);
});

test("连续上限按群组独立计数", () => {
  const { loop } = make();
  for (let i = 1; i <= 7; i += 1) {
    loop.registerMessage({ groupId: "g1", senderKind: "agent", candidateWake: ["b"] });
  }
  const other = loop.registerMessage({ groupId: "g2", senderKind: "agent", candidateWake: ["b"] });
  assert.equal(other.consecutiveAutoReplies, 1);
  assert.deepEqual(other.allowed, ["b"]);
});

test("每成员滚动 1 分钟最多 20 次唤醒；第 21 次被限流", () => {
  const { loop } = make();
  // 用一个不限连续上限的群组 + 大量不同 groupId 避免命中连续上限（rate 跨群累计）。
  for (let i = 1; i <= 20; i += 1) {
    const d = loop.registerMessage({ groupId: `g${i}`, senderKind: "agent", candidateWake: ["b"] });
    assert.deepEqual(d.allowed, ["b"], `第 ${i} 次唤醒应允许`);
  }
  const over = loop.registerMessage({ groupId: "g21", senderKind: "agent", candidateWake: ["b"] });
  assert.deepEqual(over.allowed, []);
  assert.equal(over.suppressed.get("b"), "rate_limited");
  assert.equal(loop.wakeCountInWindow("b"), 20);
});

test("每成员速率限流跨群组累计（manager 跨群唤醒计入同一成员）", () => {
  const { loop } = make();
  // 同一成员 b 在多个群组被唤醒，累计到 20 次上限（用独立群组避免命中连续上限）。
  for (let i = 1; i <= 20; i += 1) {
    loop.registerMessage({ groupId: `w${i}`, senderKind: "agent", candidateWake: ["b"] });
  }
  assert.equal(loop.wakeCountInWindow("b"), 20);
  const over = loop.registerMessage({ groupId: "wX", senderKind: "agent", candidateWake: ["b"] });
  assert.equal(over.suppressed.get("b"), "rate_limited");
  // 另一个成员不受影响（按成员隔离）。
  const other = loop.registerMessage({ groupId: "wX", senderKind: "agent", candidateWake: ["c"] });
  assert.deepEqual(other.allowed, ["c"]);
});

test("窗口滚动后过期唤醒被移出，重新放行", () => {
  const { loop, clock } = make();
  for (let i = 1; i <= 20; i += 1) {
    loop.registerMessage({ groupId: `g${i}`, senderKind: "agent", candidateWake: ["b"] });
  }
  const blocked = loop.registerMessage({ groupId: "gX", senderKind: "agent", candidateWake: ["b"] });
  assert.equal(blocked.suppressed.get("b"), "rate_limited");

  // 推进 60s + 1ms：窗口内全部过期，重新放行。
  clock.advance(60_001);
  assert.equal(loop.wakeCountInWindow("b"), 0);
  const ok = loop.registerMessage({ groupId: "gX", senderKind: "agent", candidateWake: ["b"] });
  assert.deepEqual(ok.allowed, ["b"]);
});

test("部分成员被限流、其余放行（逐成员判定）", () => {
  const { loop } = make();
  for (let i = 1; i <= 20; i += 1) {
    loop.registerMessage({ groupId: `g${i}`, senderKind: "agent", candidateWake: ["b"] });
  }
  const d = loop.registerMessage({ groupId: "gZ", senderKind: "agent", candidateWake: ["b", "c"] });
  assert.deepEqual(d.allowed, ["c"]);
  assert.equal(d.suppressed.get("b"), "rate_limited");
});

test("配置覆盖生效：自定义上限与窗口", () => {
  const { loop, clock } = make({ config: { maxConsecutiveAutoReplies: 2, maxWakesPerMinutePerMember: 2, wakeRateWindowMs: 1_000 } });
  assert.equal(loop.config.maxConsecutiveAutoReplies, 2);
  assert.equal(loop.config.maxWakesPerMinutePerMember, 2);
  assert.equal(loop.config.wakeRateWindowMs, 1_000);

  // 连续 2 条放行，第 3 条停止（按自定义上限 2）。
  assert.deepEqual(loop.registerMessage({ groupId: "g", senderKind: "agent", candidateWake: ["b"] }).allowed, ["b"]);
  assert.deepEqual(loop.registerMessage({ groupId: "g", senderKind: "agent", candidateWake: ["b"] }).allowed, ["b"]);
  assert.deepEqual(loop.registerMessage({ groupId: "g", senderKind: "agent", candidateWake: ["b"] }).allowed, []);

  // 速率：自定义每窗口 2 次、窗口 1s。用不同群组避免命中连续上限（rate 跨群累计）。
  for (let i = 0; i < 2; i += 1) {
    loop.registerMessage({ groupId: `r${i}`, senderKind: "agent", candidateWake: ["c"] });
  }
  assert.equal(loop.registerMessage({ groupId: "rX", senderKind: "agent", candidateWake: ["c"] }).suppressed.get("c"), "rate_limited");
  clock.advance(1_001);
  assert.deepEqual(loop.registerMessage({ groupId: "rX", senderKind: "agent", candidateWake: ["c"] }).allowed, ["c"]);
});

test("连续上限与速率限流同时存在时，连续上限优先抑制", () => {
  const { loop } = make({ config: { maxConsecutiveAutoReplies: 1, maxWakesPerMinutePerMember: 1 } });
  loop.registerMessage({ groupId: "g", senderKind: "agent", candidateWake: ["b"] }); // 计数 1，放行 b
  // 第 2 条：计数 2 > 1 → 连续上限；即使 b 的速率也可能超限，原因应是 consecutive_limit。
  const d = loop.registerMessage({ groupId: "g", senderKind: "agent", candidateWake: ["b"] });
  assert.equal(d.suppressed.get("b"), "consecutive_limit");
});

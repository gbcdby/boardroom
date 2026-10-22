import test from "node:test";
import assert from "node:assert/strict";
import {
  ALL_MENTION_ALIASES,
  parseMentions,
  resolveWakeAndVisibility,
  type RoutingMember,
  type RoutingMessage,
} from "../src/server/chat/routing.ts";

/**
 * T3（#16）消息路由域服务单元测试。
 *
 * seam：纯函数式的路由域服务（`src/server/chat/routing.ts`），不依赖数据库/网络。
 * 覆盖 mention 解析、@all 快照、manager/普通/发送者排除、可见性与未参与群组隔离。
 */

function member(
  id: string,
  role: RoutingMember["role"],
  kind: RoutingMember["kind"] = "agent",
  online = true,
  displayName?: string,
): RoutingMember {
  return displayName === undefined ? { id, role, kind, online } : { id, role, kind, online, displayName };
}

// ---------------------------------------------------------------------------
// mention 解析
// ---------------------------------------------------------------------------

test("parseMentions：空文本无 mention；@单人解析为成员 ID", () => {
  const roster = [member("m_alice", "normal", "agent", true, "Alice"), member("m_bob", "normal", "agent", true, "Bob")];
  const result = parseMentions("你好 @alice 看一下", roster);
  assert.deepEqual(result.mentionIds, ["m_alice"]);
  assert.equal(result.all, false);
  assert.deepEqual(result.unknownNames, []);
});

test("parseMentions：@多人按出现顺序解析，去重", () => {
  const roster = [member("m_alice", "normal", "agent", true, "Alice"), member("m_bob", "normal", "agent", true, "Bob")];
  const result = parseMentions("@bob @alice @bob 请确认", roster);
  assert.deepEqual(result.mentionIds, ["m_bob", "m_alice"]);
  assert.equal(result.all, false);
});

test("parseMentions：显示名大小写不敏感；未知 @name 记入 unknownNames 而非静默丢弃", () => {
  const roster = [member("m_alice", "normal", "agent", true, "Alice")];
  const result = parseMentions("@Alice @ghost", roster);
  assert.deepEqual(result.mentionIds, ["m_alice"]);
  assert.deepEqual(result.unknownNames, ["ghost"]);
});

test("parseMentions：@all / @全体 标记 all；不再逐人解析", () => {
  const roster = [member("m_alice", "normal", "agent", true, "Alice"), member("m_bob", "normal", "agent", true, "Bob")];
  for (const alias of ALL_MENTION_ALIASES) {
    const result = parseMentions(`通知 @${alias} 开会`, roster);
    assert.equal(result.all, true, `别名 ${alias} 应识别为 @all`);
    assert.deepEqual(result.mentionIds, []);
  }
});

test("parseMentions：显示名歧义时用稳定 ID 指定（@<memberId> 优先于显示名）", () => {
  // 两个成员同名 "Sam"，用稳定 ID 精确点名。
  const roster = [member("m_sam_1", "normal", "agent", true, "Sam"), member("m_sam_2", "normal", "agent", true, "Sam")];
  const byId = parseMentions("@m_sam_2 你的部分", roster);
  assert.deepEqual(byId.mentionIds, ["m_sam_2"]);
  assert.deepEqual(byId.unknownNames, []);
  // 直接用 @显示名 + 歧义 → 两人都命中（不静默选一个）。
  const byName = parseMentions("@Sam 你看", roster);
  assert.deepEqual(byName.mentionIds.toSorted(), ["m_sam_1", "m_sam_2"]);
});

// ---------------------------------------------------------------------------
// @all 在线参与者快照
// ---------------------------------------------------------------------------

test("resolveWakeAndVisibility：@all 指向发送时在线参与者快照，不含发送者", () => {
  const roster = [
    member("m_human", "normal", "human", true),
    member("m_a", "normal", "agent", true),
    member("m_b", "normal", "agent", false), // 离线
    member("m_mgr", "manager", "agent", true),
  ];
  const message: RoutingMessage = { senderMemberId: "m_human", mentionIds: [], mentionsAll: true };
  const plan = resolveWakeAndVisibility(message, roster);

  // @all 的接收者 = 在线成员 - 发送者（离线成员不在快照内）。
  assert.equal(plan.allRecipients.length, 2);
  assert.deepEqual(plan.allRecipients.toSorted(), ["m_a", "m_mgr"]);
  assert.ok(!plan.allRecipients.includes("m_human"), "@all 不应包含发送者");
  assert.ok(!plan.allRecipients.includes("m_b"), "@all 不应包含离线成员");
});

// ---------------------------------------------------------------------------
// 唤醒规则：普通 agent / manager / 发送者排除
// ---------------------------------------------------------------------------

test("普通 agent：只被 @ 唤醒（@单人/@多人只唤醒被点名者）", () => {
  const roster = [member("m_a", "normal"), member("m_b", "normal"), member("m_c", "normal")];
  const message: RoutingMessage = { senderMemberId: "m_c", mentionIds: ["m_a"], mentionsAll: false };
  const plan = resolveWakeAndVisibility(message, roster);
  assert.deepEqual(plan.wake.toSorted(), ["m_a"]);
  // @m_b / 未点名者不被唤醒。
  assert.ok(!plan.wake.includes("m_b"));
});

test("多 @：只唤醒被点名的成员，其余普通成员不唤醒", () => {
  const roster = [member("m_a", "normal"), member("m_b", "normal"), member("m_c", "normal")];
  const message: RoutingMessage = { senderMemberId: "m_c", mentionIds: ["m_a", "m_b"], mentionsAll: false };
  const plan = resolveWakeAndVisibility(message, roster);
  assert.deepEqual(plan.wake.toSorted(), ["m_a", "m_b"]);
});

test("manager：被项目内其他成员（未点名）的消息唤醒", () => {
  const roster = [member("m_a", "normal"), member("m_mgr", "manager")];
  const message: RoutingMessage = { senderMemberId: "m_a", mentionIds: [], mentionsAll: false };
  const plan = resolveWakeAndVisibility(message, roster);
  assert.deepEqual(plan.wake, ["m_mgr"], "manager 应被普通成员的未点名消息唤醒");
});

test("发送者排除：普通 agent 自己发消息不唤醒自己", () => {
  const roster = [member("m_a", "normal"), member("m_b", "normal")];
  // m_a 发消息并 @ 自己（异常输入）也不应唤醒自己。
  const message: RoutingMessage = { senderMemberId: "m_a", mentionIds: ["m_a"], mentionsAll: false };
  const plan = resolveWakeAndVisibility(message, roster);
  assert.ok(!plan.wake.includes("m_a"));
});

test("发送者排除：manager 自己发消息不唤醒自己，但仍唤醒被 @ 的成员", () => {
  const roster = [member("m_mgr", "manager"), member("m_a", "normal")];
  const message: RoutingMessage = { senderMemberId: "m_mgr", mentionIds: ["m_a"], mentionsAll: false };
  const plan = resolveWakeAndVisibility(message, roster);
  assert.ok(!plan.wake.includes("m_mgr"), "manager 不唤醒自己");
  assert.deepEqual(plan.wake, ["m_a"]);
});

test("发送者排除：人发 @all 时不唤醒自己（人是成员）", () => {
  const roster = [
    member("m_human", "normal", "human"),
    member("m_a", "normal"),
    member("m_mgr", "manager"),
  ];
  const message: RoutingMessage = { senderMemberId: "m_human", mentionIds: [], mentionsAll: true };
  const plan = resolveWakeAndVisibility(message, roster);
  assert.ok(!plan.wake.includes("m_human"));
  assert.deepEqual(plan.wake.toSorted(), ["m_a", "m_mgr"]);
});

// ---------------------------------------------------------------------------
// 可见性
// ---------------------------------------------------------------------------

test("可见性：普通 agent 只可见自己发送 + 被 @（D3）", () => {
  const roster = [member("m_a", "normal"), member("m_b", "normal"), member("m_c", "normal")];
  // m_c 发消息 @ m_a。
  const message: RoutingMessage = { senderMemberId: "m_c", mentionIds: ["m_a"], mentionsAll: false };
  const plan = resolveWakeAndVisibility(message, roster);
  // 发送者 m_c 可见自己的消息；被 @ 的 m_a 可见；m_b 不可见。
  assert.ok(plan.visible.includes("m_c"));
  assert.ok(plan.visible.includes("m_a"));
  assert.ok(!plan.visible.includes("m_b"));
});

test("可见性：manager 可见项目内所有群组消息（即便未被 @）", () => {
  const roster = [member("m_mgr", "manager"), member("m_a", "normal"), member("m_b", "normal")];
  const message: RoutingMessage = { senderMemberId: "m_b", mentionIds: [], mentionsAll: false };
  const plan = resolveWakeAndVisibility(message, roster);
  assert.ok(plan.visible.includes("m_mgr"), "manager 可见未点名的消息");
  assert.ok(plan.visible.includes("m_b"), "发送者可见自己的消息");
  assert.ok(!plan.visible.includes("m_a"), "普通未点名者不可见");
});

test("可见性：人可见全部群组消息", () => {
  const roster = [member("m_human", "normal", "human"), member("m_a", "normal")];
  const message: RoutingMessage = { senderMemberId: "m_a", mentionIds: [], mentionsAll: false };
  const plan = resolveWakeAndVisibility(message, roster);
  assert.ok(plan.visible.includes("m_human"), "人可见未点名的消息");
});

// ---------------------------------------------------------------------------
// 未参与群组不可见（隔离）
// ---------------------------------------------------------------------------

test("未参与群组：roster 外的成员不出现在任何可见/唤醒结果（无泄漏）", () => {
  // roster 只含本群参与者；外部成员 m_outsider 不在其中。
  const roster = [member("m_a", "normal"), member("m_mgr", "manager")];
  const message: RoutingMessage = { senderMemberId: "m_a", mentionIds: [], mentionsAll: true };
  const plan = resolveWakeAndVisibility(message, roster);
  for (const id of [...plan.visible, ...plan.wake, ...plan.allRecipients]) {
    assert.ok(roster.some((m) => m.id === id), `结果不应包含非参与者 ${id}`);
  }
  assert.ok(!plan.visible.includes("m_outsider"));
  assert.ok(!plan.wake.includes("m_outsider"));
});

test("空 roster：无任何可见/唤醒接收者", () => {
  const plan = resolveWakeAndVisibility(
    { senderMemberId: "m_a", mentionIds: ["m_a"], mentionsAll: true },
    [],
  );
  assert.deepEqual(plan.wake, []);
  assert.deepEqual(plan.visible, []);
  assert.deepEqual(plan.allRecipients, []);
});

import assert from "node:assert/strict";
import test from "node:test";
import type { GroupDto, MemberDto, MessageDto, ProjectDto } from "../src/web/src/api/client.ts";
import type { RuntimeViewDto } from "../src/web/src/api/runtimes.ts";
import { buildCollabGraphSnapshot, toGraphCanvasData, type MessageEdge } from "../src/web/src/composables/collabGraphProjection.ts";
import {
  MAX_VISIBLE_MESSAGE_MARKERS, MESSAGE_ANIMATION_MS,
  buildMessageDirectionLayer, mergeMessageEdges, resolveMessagePresentation,
} from "../src/web/src/composables/messageDirectionLayer.ts";

const BASE = Date.UTC(2026, 10, 22, 4, 0, 0);

function member(id: string, displayName: string): MemberDto {
  return {
    id, projectId: "p1", agentId: `agent-${id}`, kind: "agent", displayName,
    role: "normal", nodeId: null, status: "active", createdAt: new Date(BASE).toISOString(), updatedAt: new Date(BASE).toISOString(),
  };
}
function group(id: string, name: string): GroupDto {
  return { id, projectId: "p1", name, createdAt: new Date(BASE).toISOString(), updatedAt: new Date(BASE).toISOString(), archivedAt: null };
}
function message(id: string, groupId: string, senderMemberId: string, text: string, offsetMs = 0): MessageDto {
  return {
    id, groupId, seq: 1, senderMemberId, senderDisplayName: null, text, mentions: [],
    wakeMemberIds: [], visibleMemberIds: [], createdAt: new Date(BASE + offsetMs).toISOString(),
  };
}
function edge(id: string, groupId: string, senderMemberId: string, offsetMs: number, text = "正文摘要"): MessageEdge {
  return {
    id, groupId, groupName: groupId === "g1" ? "甲群" : "乙群", senderMemberId,
    sender: senderMemberId, text, createdAt: new Date(BASE + offsetMs).toISOString(), avatarSeed: 1,
  };
}
function snapshotWith(messages: MessageDto[]) {
  const m1 = member("m1", "同名代理");
  const m2 = member("m2", "同名代理");
  const m3 = member("m3", "另一位");
  const project: ProjectDto = {
    id: "p1", name: "项目一", createdAt: new Date(BASE).toISOString(), updatedAt: new Date(BASE).toISOString(),
    archivedAt: null, manager: null,
  };
  const byGroup = new Map<string, MessageDto[]>();
  for (const item of messages) byGroup.set(item.groupId, [...(byGroup.get(item.groupId) ?? []), item]);
  const groups = [group("g1", "甲群"), group("g2", "乙群")];
  const participants = new Map<string, MemberDto[]>([
    ["g1", [m1, m2]], ["g2", [m3]],
  ]);
  const graph = buildCollabGraphSnapshot({
    project, org: { nodes: [], roles: [] }, groups,
    members: [m1, m2, m3], participantsByGroup: participants, memberStatuses: [],
    messagesByGroup: byGroup, tasks: [], runtimeViews: [] as RuntimeViewDto[],
  });
  return { graph, canvas: toGraphCanvasData(graph) };
}

test("真实消息逐条映射为 sender→所属群方向边，携带逻辑 ID/时间/摘要且不造私信", () => {
  const { graph, canvas } = snapshotWith([
    message("msg-a", "g1", "m1", "甲群里的真实正文", 1000),
    message("msg-b", "g2", "m3", "乙群里的另一条正文", 2000),
  ]);
  assert.equal(graph.messageCount, 2);
  assert.deepEqual(graph.messageDirection.markers.map((item) => ({
    id: item.id, groupId: item.groupId, senderMemberId: item.senderMemberId,
    createdAt: item.createdAt, text: item.text,
  })), [
    { id: "msg-b", groupId: "g2", senderMemberId: "m3", createdAt: new Date(BASE + 2000).toISOString(), text: "乙群里的另一条正文" },
    { id: "msg-a", groupId: "g1", senderMemberId: "m1", createdAt: new Date(BASE + 1000).toISOString(), text: "甲群里的真实正文" },
  ]);
  assert.ok(graph.messageDirection.markers.every((item) => item.directionKey === `${item.senderMemberId}->${item.groupId}`));
  assert.deepEqual(canvas.collaborations ?? [], []);
  assert.ok(graph.messageDirection.markers.every((item) => item.groupId !== item.senderMemberId));
  assert.deepEqual(graph.messageDirection.aggregates, []);
});

test("稳定 messageId 去重，乱序与补发不重放为新消息", () => {
  const original = [edge("m3", "g1", "m1", 3000), edge("m1", "g1", "m1", 1000), edge("m2", "g2", "m3", 2000)];
  const replayed = [edge("m2", "g2", "m3", 2000), edge("m1", "g1", "m1", 9999, "补发不得覆盖原文"), edge("m4", "g1", "m1", 4000)];
  const merged = mergeMessageEdges(original, replayed);
  assert.deepEqual(merged.map((item) => item.id), ["m4", "m3", "m2", "m1"]);
  assert.equal(merged.find((item) => item.id === "m1")?.text, "正文摘要");
  const layer = buildMessageDirectionLayer([...original, ...replayed]);
  assert.equal(layer.totalCount, 4);
  assert.deepEqual(layer.markers.map((item) => item.id), ["m4", "m3", "m2", "m1"]);
  assert.deepEqual(layer.traceable.map((item) => item.id), ["m4", "m3", "m2", "m1"]);
});

test("历史加载/重复 DTO 不增加消息事实，只保留唯一逻辑 ID", () => {
  const { graph } = snapshotWith([
    message("msg-a", "g1", "m1", "原文", 1000),
    message("msg-a", "g1", "m1", "重复补发", 1000),
    message("msg-b", "g1", "m2", "另一条", 2000),
  ]);
  assert.equal(graph.messageCount, 2);
  assert.deepEqual(graph.messageEdges.map((item) => item.id), ["msg-b", "msg-a"]);
  assert.deepEqual(graph.messageDirection.traceable.map((item) => item.id), ["msg-b", "msg-a"]);
  assert.deepEqual(graph.recent.map((item) => item.id), ["msg-b", "msg-a"]);
});

test("时间倒序最多 6 条可见标记，其余按同方向/时间窗聚合并可逐条追溯", () => {
  const messages = [
    message("older-window", "g1", "m1", "上一分钟", -120_000),
    message("older-1", "g1", "m1", "首批一", 0),
    message("older-2", "g1", "m1", "首批二", 1000),
    ...Array.from({ length: 6 }, (_, index) => message(`visible-${index + 1}`, "g1", "m1", `近条 ${index + 1}`, 10_000 + index * 1000)),
  ];
  const { graph } = snapshotWith(messages);
  const layer = graph.messageDirection;
  assert.equal(MAX_VISIBLE_MESSAGE_MARKERS, 6);
  assert.equal(layer.totalCount, 9);
  assert.equal(layer.overflowCount, 3);
  assert.deepEqual(layer.markers.map((item) => item.id), [
    "visible-6", "visible-5", "visible-4", "visible-3", "visible-2", "visible-1",
  ]);
  assert.equal(layer.aggregates.length, 2);
  const aggregated = layer.aggregates.find((item) => item.count === 2);
  assert.ok(aggregated);
  assert.equal(aggregated.groupId, "g1");
  assert.equal(aggregated.senderMemberId, "m1");
  assert.deepEqual(aggregated.messageIds, ["older-2", "older-1"]);
  assert.equal(layer.traceable.length, 9);
  assert.deepEqual(layer.traceable.map((item) => item.id), [
    "visible-6", "visible-5", "visible-4", "visible-3", "visible-2", "visible-1",
    "older-2", "older-1", "older-window",
  ]);
});

test("减少动态与暂停只改变表现：静态箭头/计数替代流动，动画时长在 0.6–1.2 秒", () => {
  assert.ok(MESSAGE_ANIMATION_MS >= 600 && MESSAGE_ANIMATION_MS <= 1200);
  const normal = resolveMessagePresentation(false, false);
  const paused = resolveMessagePresentation(false, true);
  const reduced = resolveMessagePresentation(true, false);
  assert.equal(normal.animate, true);
  assert.equal(normal.showStaticArrows, true);
  assert.equal(normal.showCounts, true);
  assert.equal(paused.animate, false);
  assert.equal(paused.showStaticArrows, true);
  assert.equal(paused.showCounts, true);
  assert.equal(reduced.animate, false);
  assert.equal(reduced.showStaticArrows, true);
  assert.equal(reduced.showCounts, true);
  const layer = buildMessageDirectionLayer([edge("m1", "g1", "m1", 1000), edge("m2", "g1", "m1", 2000)]);
  assert.equal(layer.totalCount, 2);
  assert.equal(resolveMessagePresentation(true, true).animate, false);
  assert.equal(layer.totalCount, 2);
});

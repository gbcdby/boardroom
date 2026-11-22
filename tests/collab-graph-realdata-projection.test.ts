import assert from "node:assert/strict";
import test from "node:test";
import type { GroupDto, MemberDto, MemberStatusDto, MessageDto, OrgNodeDto, ProjectDto } from "../src/web/src/api/client.ts";
import type { RuntimeViewDto } from "../src/web/src/api/runtimes.ts";
import { buildCollabGraphSnapshot, toGraphCanvasData } from "../src/web/src/composables/collabGraphProjection.ts";

function member(id: string, name: string, projectId = "p1"): MemberDto {
  return {
    id, projectId, agentId: `agent-${id}`, kind: "agent", displayName: name,
    role: "normal", nodeId: null, status: "active", createdAt: "2026-11-22T01:00:00.000Z", updatedAt: "2026-11-22T01:00:00.000Z",
  };
}
function group(id: string, name: string, projectId = "p1"): GroupDto {
  return { id, projectId, name, createdAt: "2026-11-22T01:00:00.000Z", updatedAt: "2026-11-22T01:00:00.000Z", archivedAt: null };
}
function orgNode(id: string, memberId: string): OrgNodeDto {
  return {
    id, projectId: "p1", parentId: null, name: "顶级主管", role: "top_manager",
    sortOrder: 0, createdAt: "2026-11-22T01:00:00.000Z", updatedAt: "2026-11-22T01:00:00.000Z",
    memberId, memberDisplayName: null,
  };
}
function message(id: string, groupId: string, senderMemberId: string, text: string, createdAt: string): MessageDto {
  return {
    id, groupId, seq: 1, senderMemberId, senderDisplayName: null, text, mentions: [],
    wakeMemberIds: [], visibleMemberIds: [], createdAt,
  };
}
function status(memberId: string): MemberStatusDto {
  return {
    memberId, projectId: "p1", displayName: null, kind: null, agentId: null, hostType: null,
    connection: "connected", state: "working", stale: false, disconnected: false,
    heartbeatTimedOut: false, heartbeatStale: false, lastHeartbeatAt: null,
    connectedAt: null, disconnectedAt: null, updatedAt: null,
  };
}

test("空项目/空群/无消息得到空图，不注入示例节点", () => {
  const graph = buildCollabGraphSnapshot({
    project: null,
    org: { nodes: [], roles: [] },
    groups: [],
    members: [],
    participantsByGroup: new Map(),
    memberStatuses: [],
    messagesByGroup: new Map(),
    tasks: [],
    runtimeViews: [] as RuntimeViewDto[],
  });
  assert.equal(graph.root, null);
  assert.equal(graph.lead, null);
  assert.deepEqual(graph.groups, []);
  assert.equal(graph.memberCount, 0);
  assert.equal(graph.messageCount, 0);
  assert.deepEqual(graph.recent, []);
  assert.deepEqual(graph.messageEdges, []);
  const canvas = toGraphCanvasData(graph);
  assert.equal(canvas.root, null);
  assert.equal(canvas.lead, null);
  assert.deepEqual(canvas.groups, []);
  assert.deepEqual(canvas.collaborations ?? [], []);
});

test("同名 Agent 在不同群保留两个真实节点，不按姓名合并", () => {
  const manager = member("manager-1", "项目负责人");
  const agentA = member("agent-same", "同名代理");
  const agentB = member("agent-other", "同名代理");
  const project: ProjectDto = {
    id: "p1", name: "项目一", createdAt: "2026-11-22T01:00:00.000Z", updatedAt: "2026-11-22T01:00:00.000Z",
    archivedAt: null, manager,
  };
  const graph = buildCollabGraphSnapshot({
    project,
    org: { nodes: [orgNode("node-1", manager.id)], roles: [] },
    groups: [group("g1", "甲群"), group("g2", "乙群")],
    members: [manager, agentA, agentB],
    participantsByGroup: new Map([["g1", [agentA]], ["g2", [agentB]]]),
    memberStatuses: [],
    messagesByGroup: new Map([["g1", []], ["g2", []]]),
    tasks: [],
    runtimeViews: [] as RuntimeViewDto[],
  });
  assert.equal(graph.root?.id, manager.id);
  assert.equal(graph.lead?.id, manager.id);
  assert.equal(graph.memberCount, 2);
  const canvas = toGraphCanvasData(graph);
  assert.equal(canvas.root?.name, "项目负责人");
  assert.match(canvas.root?.role ?? "", /项目负责人.*顶级主管岗位/);
  assert.equal(canvas.lead, null);
  const ids = canvas.groups.flatMap(g => g.members.map(m => m.id));
  assert.equal(new Set(ids).size, 2);
  assert.ok(ids.includes("g1:agent-same"));
  assert.ok(ids.includes("g2:agent-other"));
  assert.notEqual(canvas.groups[0]!.members[0]!.name, undefined);
});

test("消息边保留真实逻辑 ID、时间与 sender→群方向，不生成私聊边", () => {
  const sender = member("m1", "真实发送者");
  const other = member("m2", "另一位成员");
  const project: ProjectDto = {
    id: "p1", name: "项目一", createdAt: "2026-11-22T01:00:00.000Z", updatedAt: "2026-11-22T01:00:00.000Z",
    archivedAt: null, manager: null,
  };
  const first = message("msg-real-1", "g1", sender.id, "真实的群消息内容", "2026-11-22T02:00:00.000Z");
  const second = message("msg-real-2", "g2", other.id, "另一群的群消息", "2026-11-22T03:00:00.000Z");
  const graph = buildCollabGraphSnapshot({
    project,
    org: { nodes: [], roles: [] },
    groups: [group("g1", "甲群"), group("g2", "乙群")],
    members: [sender, other],
    participantsByGroup: new Map([["g1", [sender]], ["g2", [other]]]),
    memberStatuses: [status(sender.id), status(other.id)],
    messagesByGroup: new Map([["g1", [first]], ["g2", [second]]]),
    tasks: [],
    runtimeViews: [] as RuntimeViewDto[],
  });
  assert.equal(graph.root, null);
  assert.equal(graph.lead, null);
  assert.equal(graph.messageCount, 2);
  assert.deepEqual(graph.messageEdges.map(e => ({ id: e.id, groupId: e.groupId, senderMemberId: e.senderMemberId, createdAt: e.createdAt })), [
    { id: "msg-real-2", groupId: "g2", senderMemberId: "m2", createdAt: "2026-11-22T03:00:00.000Z" },
    { id: "msg-real-1", groupId: "g1", senderMemberId: "m1", createdAt: "2026-11-22T02:00:00.000Z" },
  ]);
  assert.deepEqual(graph.recent.map(e => e.id), ["msg-real-2", "msg-real-1"]);
  assert.deepEqual(graph.conversations.map(c => c.messages[0]?.id), ["msg-real-1", "msg-real-2"]);
  assert.ok(graph.messageEdges.every(e => e.groupId !== e.senderMemberId));
  const canvas = toGraphCanvasData(graph);
  assert.deepEqual(canvas.collaborations ?? [], []);
  assert.match(canvas.groups[0]!.flowMessage ?? "", /真实的群消息内容/);
  assert.match(canvas.groups[0]!.flowLabel, /1/);
  assert.equal(canvas.groups[0]!.flowEmphasis, false);
  assert.equal(canvas.groups[1]!.flowEmphasis, true);
});

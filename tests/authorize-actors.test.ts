import test from "node:test";
import assert from "node:assert/strict";
import { authorize, type Capability } from "../src/server/authz/authorize.ts";
import {
  actorForMember,
  actorForSession,
  ownerActor,
  PROJECT_CAPABILITIES,
} from "../src/server/authz/actors.ts";
import type { Member } from "../src/server/db/types.ts";

/**
 * F2（#47）主体解析与阶段 1 兼容映射。
 *
 * 接缝：入口层（HTTP / MCP）拿到的既有数据（`members` 行、MCP 会话绑定）→ 守卫 Actor。
 * 硬约束：阶段 1 单用户无认证下**既有行为不变**——默认人 = owner，全部已有点位放行。
 */

function member(overrides: Partial<Member> & Pick<Member, "id" | "kind" | "role">): Member {
  return {
    projectId: "p1",
    agentId: null,
    displayName: "M",
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

test("阶段 1 role=manager 的 agent 映射到静态角色 top_manager（决策票 #25 兼容）", () => {
  const actor = actorForMember(member({ id: "m1", kind: "agent", role: "manager" }));
  assert.equal(actor.role, "top_manager");
  assert.equal(actor.projectId, "p1");
  assert.equal(actor.kind, "agent");
});

test("阶段 1 role=normal 的 agent 映射到静态角色 member", () => {
  assert.equal(actorForMember(member({ id: "m2", kind: "agent", role: "normal" })).role, "member");
});

test("阶段 1 kind=human 的成员映射到 owner（人高于 manager）", () => {
  assert.equal(actorForMember(member({ id: "m3", kind: "human", role: "normal" })).role, "owner");
});

test("未落 T2 组织树时 nodeId/subtreeNodeIds 为 null，不影响 project 级放行", () => {
  const actor = actorForMember(member({ id: "m4", kind: "agent", role: "manager" }));
  assert.equal(actor.nodeId, null);
  assert.equal(actor.subtreeNodeIds, null);
  assert.equal(authorize(actor, "group:post", { projectId: "p1", groupMemberIds: ["m4"] }).allowed, true);
});

test("MCP 会话绑定映射为 actor：角色取成员行，缺省 normal", () => {
  const binding = { memberId: "m5", projectId: "p1", kind: "agent" as const };
  assert.equal(actorForSession(binding).role, "member");
  assert.equal(actorForSession({ ...binding, role: "manager" }).role, "top_manager");
});

test("阶段 1 默认主体是人（owner）：未认证时全部已有点位放行", () => {
  const actor = ownerActor("p1");
  assert.equal(actor.kind, "human");
  assert.equal(actor.role, "owner");
  for (const capability of PROJECT_CAPABILITIES) {
    assert.equal(
      authorize(actor, capability as Capability, { projectId: "p1", groupMemberIds: [actor.actorId] }).allowed,
      true,
      `阶段 1 默认人应被放行：${String(capability)}`,
    );
  }
});

test("人（owner）的主体不绑定单个项目（可跨项目建项目）", () => {
  const global = ownerActor(null);
  assert.equal(global.projectId, null);
  assert.equal(authorize(global, "project:create", { projectId: "p2" }).allowed, true);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  authorize,
  AUTHZ_ROLES,
  type Actor,
} from "../src/server/authz/authorize.ts";

/**
 * F2（#47）统一权限守卫 `authorize` 单测。
 *
 * 测试 seam：`authorize(actor, action, scope)` 守卫纯函数（票面确认的 seam）。
 * 覆盖需求 GUARD-01；验收 AC-PERM-01 / AC-PROJ-GUARD-01。
 *
 * 三类路径（AC-PROJ-GUARD-01）：
 * - 正常：角色矩阵内被授权的操作放行；
 * - 越权：缺能力点的操作被拒绝；
 * - 子树边界：权限随子树收放，只读可见性不得写成消息。
 *
 * actor/scope 全部是**可注入的纯数据**：本票不建 org_nodes/members 业务表（属 T2 #49），
 * 只约定对接形状（`nodeId` / `subtreeNodeIds` / 参与者节点）。
 */

/** 阶段 1 单用户下的「默认人」：owner、无岗位节点、全项目范围。 */
function humanOwner(projectId = "p1"): Actor {
  return { actorId: "human-1", kind: "human", role: "owner", projectId, nodeId: null, subtreeNodeIds: null };
}

test("角色集合是 spec #45 §3 / 决策票 #25 的静态枚举", () => {
  assert.deepEqual([...AUTHZ_ROLES], ["owner", "top_manager", "sub_manager", "member"]);
});

test("正常路径：人（owner）有创建项目的能力点（PROJECT-01）", () => {
  const decision = authorize(humanOwner(), "project:create", { projectId: "p1" });
  assert.equal(decision.allowed, true);
});

test("越权路径：普通成员没有创建项目的能力点（AC-PERM-01）", () => {
  const decision = authorize({ ...humanOwner(), role: "member" }, "project:create", { projectId: "p1" });
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.equal(decision.code, "forbidden");
});

test("越权路径：普通成员不能建群组（GROUP-03 只给人与 manager）", () => {
  const decision = authorize({ ...humanOwner(), role: "member" }, "group:create", { projectId: "p1" });
  assert.equal(decision.allowed, false);
});

test("越权路径：不在静态枚举内的角色一律拒绝（fail-closed）", () => {
  const decision = authorize({ ...humanOwner(), role: "auditor" as never }, "project:create", { projectId: "p1" });
  assert.equal(decision.allowed, false);
});

test("隔离路径：跨项目请求直接拒绝（NFR-PROJ-01）", () => {
  const decision = authorize(humanOwner("p1"), "project:create", { projectId: "p2" });
  assert.equal(decision.allowed, false);
});

test("判定不改变入参：守卫是纯函数", () => {
  const actor: Actor = humanOwner();
  const scope = { projectId: "p1" };
  authorize(actor, "project:create", scope);
  assert.deepEqual(actor, humanOwner());
  assert.deepEqual(scope, { projectId: "p1" });
});

// ---------------------------------------------------------------------------
// 子树边界（AC-PROJ-GUARD-01 第三类路径；ORG-03 / ORG-05 / GROUP-03）
// ---------------------------------------------------------------------------

/** 下级 manager：岗位在 n2，子树 = {n2, n3, n4}。 */
function subManager(projectId = "p1"): Actor {
  return {
    actorId: "m-sub-1",
    kind: "agent",
    role: "sub_manager",
    projectId,
    nodeId: "n2",
    subtreeNodeIds: ["n2", "n3", "n4"],
  };
}

test("子树边界：下级 manager 在子树内建群组放行（GROUP-03）", () => {
  const decision = authorize(subManager(), "group:create", {
    projectId: "p1",
    groupId: "g-new",
    groupMemberIds: ["m-sub-1", "m-a", "m-b"],
    groupMemberNodeIds: ["n2", "n3", "n4"],
  });
  assert.equal(decision.allowed, true);
});

test("子树边界：下级 manager 不能把子树外的成员拉进群组（ORG-05 不越级）", () => {
  const decision = authorize(subManager(), "group:create", {
    projectId: "p1",
    groupId: "g-new",
    groupMemberIds: ["m-sub-1", "m-outside"],
    groupMemberNodeIds: ["n2", "n9"],
  });
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.equal(decision.code, "out_of_subtree");
});

test("子树边界：子树内全员属该子树的群组，下级 manager 有只读可见性", () => {
  const decision = authorize(subManager(), "group:view_subtree", {
    projectId: "p1",
    groupId: "g-2",
    groupMemberIds: ["m-a", "m-b"],
    groupMemberNodeIds: ["n3", "n4"],
  });
  assert.equal(decision.allowed, true);
});

test("子树边界：参与者含子树外成员的群组不在只读可见范围内", () => {
  const decision = authorize(subManager(), "group:view_subtree", {
    projectId: "p1",
    groupId: "g-3",
    groupMemberIds: ["m-a", "m-outside"],
    groupMemberNodeIds: ["n3", "n9"],
  });
  assert.equal(decision.allowed, false);
  // 可见性边界的拒绝码统一用 not_visible（管辖边界的越级用 out_of_subtree）。
  if (!decision.allowed) assert.equal(decision.code, "not_visible");
});

test("只读可见性不扩成写权限：下级 manager 不能往未参与的子树群组发消息", () => {
  const scope = {
    projectId: "p1",
    groupId: "g-2",
    groupMemberIds: ["m-a", "m-b"],
    groupMemberNodeIds: ["n3", "n4"],
  } as const;
  assert.equal(authorize(subManager(), "group:view_subtree", scope).allowed, true);
  const post = authorize(subManager(), "group:post", scope);
  assert.equal(post.allowed, false);
  if (!post.allowed) assert.equal(post.code, "not_a_member");
});

test("子树可见性只给下级 manager：顶层 manager 走全项目范围，人也是全项目", () => {
  const topManager: Actor = { ...subManager(), actorId: "m-top", role: "top_manager", nodeId: "n1", subtreeNodeIds: null };
  const owner = humanOwner();
  for (const actor of [owner, topManager]) {
    const decision = authorize(actor, "group:view_subtree", {
      projectId: "p1",
      groupId: "g-any",
      groupMemberIds: ["m-x"],
      groupMemberNodeIds: ["n9"],
    });
    assert.equal(decision.allowed, true, `${actor.role} 应可见全部群组`);
  }
});

test("子树边界：缺少参与者节点数据时拒绝（不默认放行）", () => {
  const decision = authorize(subManager(), "group:view_subtree", { projectId: "p1", groupId: "g-2" });
  assert.equal(decision.allowed, false);
});

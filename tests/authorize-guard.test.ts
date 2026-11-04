import test from "node:test";
import assert from "node:assert/strict";
import {
  authorize,
  authorizeOrThrow,
  AUTHZ_ROLES,
  ForbiddenError,
  visibleGroups,
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

// ---------------------------------------------------------------------------
// conn-scoped 查询守卫（NFR-PROJ-01 / #37：授权之后仍只允许查本范围）
// ---------------------------------------------------------------------------

/** 一个项目的群组快照：id + 参与者 + 参与者节点（T2 从 DB 组装，本票用纯数据）。 */
const GROUPS = [
  { projectId: "p1", id: "g-own", memberIds: ["m-sub-1", "m-a"], memberNodeIds: ["n2", "n3"] },
  { projectId: "p1", id: "g-subtree", memberIds: ["m-a", "m-b"], memberNodeIds: ["n3", "n4"] },
  { projectId: "p1", id: "g-outside", memberIds: ["m-a", "m-z"], memberNodeIds: ["n3", "n9"] },
  { projectId: "p1", id: "g-foreign", memberIds: ["m-x", "m-y"], memberNodeIds: ["n8", "n9"] },
  { projectId: "p2", id: "g-other-project", memberIds: ["m-sub-1"], memberNodeIds: ["n2"] },
] as const;

test("允许之后返回 conn 范围：全项目岗位不限子树", () => {
  const decision = authorize(humanOwner(), "group:view", { projectId: "p1", groupId: "g-own" });
  assert.equal(decision.allowed, true);
  if (decision.allowed) {
    assert.deepEqual(decision.conn, { projectId: "p1", nodeIds: null, groupIds: ["g-own"] });
  }
});

test("允许之后返回 conn 范围：下级 manager 仅本子树（后续查询据此收窄）", () => {
  const decision = authorize(subManager(), "group:view", {
    projectId: "p1",
    groupMemberIds: ["m-sub-1", "m-a"],
    groupMemberNodeIds: ["n2", "n3"],
  });
  assert.equal(decision.allowed, true);
  if (decision.allowed) {
    assert.deepEqual(decision.conn.nodeIds, ["n2", "n3", "n4"]);
  }
});

test("群组查询守卫：子树岗位拿到「参与的（可写）+ 子树内全员的（只读）」", () => {
  const visible = visibleGroups(subManager(), GROUPS);
  assert.deepEqual(
    visible.map((g) => `${g.id}:${g.writable ? "rw" : "ro"}`),
    ["g-own:rw", "g-subtree:ro"],
    // g-outside 含子树外参与者、g-foreign 与本岗位无关、g-other-project 跨项目，都不出现。
    "只读可见性不得标成可写；子树外群组不得出现（AC-ORG-07）",
  );
});

test("群组查询守卫：普通成员只看得到自己参与的群组（AC-IDENT-01 不泄漏）", () => {
  const member: Actor = { actorId: "m-a", kind: "agent", role: "member", projectId: "p1", nodeId: "n3", subtreeNodeIds: null };
  const visible = visibleGroups(member, GROUPS);
  assert.deepEqual(visible.map((g) => g.id), ["g-own", "g-subtree", "g-outside"]);
  assert.ok(!visible.some((g) => g.id === "g-foreign"), "未参与的群组不得出现在结果里");
});

test("群组查询守卫：跨项目群组一律不出现", () => {
  const visible = visibleGroups(humanOwner("p9"), GROUPS);
  assert.deepEqual(visible, []);
});

test("群组查询守卫：人（owner）看得到本项目全部群组", () => {
  assert.deepEqual(visibleGroups(humanOwner(), GROUPS).map((g) => g.id), [
    "g-own",
    "g-subtree",
    "g-outside",
    "g-foreign",
  ]);
});

test("拒绝语义：守卫辅助函数抛出带 403 语义的 ForbiddenError", () => {
  assert.throws(
    () => authorizeOrThrow({ ...humanOwner(), role: "member" }, "group:create", { projectId: "p1" }),
    (error: unknown) => {
      assert.ok(error instanceof ForbiddenError);
      assert.equal(error.status, 403);
      assert.equal(error.code, "forbidden");
      assert.equal(error.capability, "group:create");
      return true;
    },
  );
});

test("拒绝语义：被允许时返回判定，不抛错", () => {
  const decision = authorizeOrThrow(humanOwner(), "group:create", { projectId: "p1" });
  assert.equal(decision.allowed, true);
});

// ---------------------------------------------------------------------------
// 连接作用域（#37：强制点收敛到 conn-scoped 查询 + 服务端守卫）
// ---------------------------------------------------------------------------

test("连接作用域：会话只绑定一个群组，越出即拒绝（阶段 1 契约不变）", () => {
  const conn = { projectId: "p1", groupIds: ["g-own"] };
  const agent: Actor = { actorId: "m1", kind: "agent", role: "member", projectId: "p1", nodeId: null, subtreeNodeIds: null };
  const own = authorize(agent, "group:post", { projectId: "p1", groupId: "g-own", groupMemberIds: ["m1"], conn });
  assert.equal(own.allowed, true);
  const other = authorize(agent, "group:post", { projectId: "p1", groupId: "g-other", groupMemberIds: ["m1"], conn });
  assert.equal(other.allowed, false);
  if (!other.allowed) assert.equal(other.code, "out_of_connection");
});

test("连接作用域：拒绝码 out_of_connection 映射 HTTP 403", () => {
  const conn = { projectId: "p1", groupIds: ["g-own"] };
  const agent: Actor = { actorId: "m1", kind: "agent", role: "member", projectId: "p1", nodeId: null, subtreeNodeIds: null };
  assert.throws(
    () => authorizeOrThrow(agent, "group:view", { projectId: "p1", groupId: "g-other", conn }),
    (error: unknown) => error instanceof ForbiddenError && error.status === 403,
  );
});

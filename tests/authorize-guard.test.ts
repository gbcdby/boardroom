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

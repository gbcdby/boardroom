import test from "node:test";
import assert from "node:assert/strict";
import { authorize, type Actor } from "../src/server/authz/authorize.ts";
import { ownerActor } from "../src/server/authz/actors.ts";

const actor: Actor = { actorId: "manager", kind: "agent", projectId: "project", role: "sub_manager", nodeId: "team", subtreeNodeIds: ["team", "worker"] };
test("AC-TASK-02：下级 manager 只能创建/管理其子树任务，不能改项目默认 reviewer", () => {
  assert.equal(authorize(actor, "task:create", { projectId: "project", nodeId: "worker" }).allowed, true);
  assert.equal(authorize(actor, "task:manage", { projectId: "project", nodeId: "other" }).allowed, false);
  assert.equal(authorize(actor, "task:settings", { projectId: "project" }).allowed, false);
  assert.equal(authorize(ownerActor(), "task:settings", { projectId: "project" }).allowed, true);
});
test("AC-TASK-02：普通成员能查看/评论而不能创建，review 仍须匹配指定成员", () => {
  const member: Actor = { ...actor, actorId: "worker", role: "member", nodeId: "worker", subtreeNodeIds: ["worker"] };
  assert.equal(authorize(member, "task:view", { projectId: "project" }).allowed, true);
  assert.equal(authorize(member, "task:comment", { projectId: "project" }).allowed, true);
  assert.equal(authorize(member, "task:create", { projectId: "project", nodeId: "worker" }).allowed, false);
  assert.equal(authorize(member, "task:review", { projectId: "project", memberId: "other" }).allowed, false);
  assert.equal(authorize(member, "work_event:own", { projectId: "project", memberId: "worker" }).allowed, true);
});

import { MEMBER_FACT_KINDS } from "../../db/types.ts";
import { checkOrgGraphValues } from "../../org/graph-values.ts";
import type { PlannedOrgNode } from "../../org/graph-values.ts";
import type { P0BContext } from "./m2-p0-b-context.ts";
import type { P0Row } from "./m2-p0.ts";

export function checkP0Organization(ctx: P0BContext): void {
  const rule = "PC1B-ORG01", projects = ctx.byId("projects", rule), agents = ctx.byId("agents", rule);
  const nodes = ctx.byId("org_nodes", rule), members = ctx.byId("members", rule);
  ctx.cost(1, 0, 1);
  const graphs = new Map<P0Row, { first: P0Row; nodes: Map<string, PlannedOrgNode>; bytes: number; maxId: number }>();
  for (const row of ctx.rows("org_nodes")) {
    const id = ctx.id(row, "id", rule), projectId = ctx.id(row, "project_id", rule);
    const project = ctx.require(projects, [projectId], row, rule, "project_id");
    const parentId = ctx.text(row, "parent_id", rule, true, true), role = ctx.text(row, "role", rule)!;
    ctx.id(row, "name", rule); ctx.real(row, "sort_order", rule);
    ctx.text(row, "created_at", rule); ctx.text(row, "updated_at", rule);
    if (parentId !== null) {
      const parent = ctx.require(nodes, [parentId], row, rule, "parent_id");
      if (!ctx.equal(ctx.id(parent, "project_id", rule), projectId)) ctx.fail(row, rule, "scope-mismatch", "parent_id", parent);
    }
    ctx.cost(2, id.length * 3, 2); let graph = graphs.get(project);
    if (!graph) { ctx.cost(1, 0, 2); graph = { first: row, nodes: new Map(), bytes: 0, maxId: 0 }; graphs.set(project, graph); }
    graph.nodes.set(id, { id, parentId, role });
    // Full preflight for the unchanged linear pure core: up to eight ID hash/
    // equality passes, two parent passes, four fixed-role comparisons per node.
    graph.bytes += id.length * 24 + (parentId?.length ?? 0) * 6 + role.length * 12 + 64;
    graph.maxId = Math.max(graph.maxId, id.length);
  }
  for (const graph of graphs.values()) {
    ctx.cost(graph.nodes.size * 16 + 16, graph.bytes + graph.maxId * 12, graph.nodes.size * 3 + 2);
    const failure = checkOrgGraphValues(graph.nodes);
    if (failure) {
      const row = failure.nodeId === null ? graph.first : nodes.get([failure.nodeId])!;
      ctx.fail(row, rule, failure.kind === "missing-parent" ? "missing-target" : failure.kind === "role-position" ? "state-mismatch" : "negative-invariant", "parent_id");
    }
  }
  const occupancy = ctx.index<P0Row>(), managers = ctx.index<P0Row>(), projectAgents = ctx.index<P0Row>();
  const memberRows = ctx.rows("members");
  for (const row of memberRows) {
    const projectId = ctx.id(row, "project_id", rule); ctx.require(projects, [projectId], row, rule, "project_id");
    const kind = ctx.oneOf(row, "kind", rule, ["human", "agent"]), role = ctx.oneOf(row, "role", rule, ["manager", "normal"]);
    const status = ctx.oneOf(row, "status", rule, ["active", "disabled", "pending"]);
    const agentId = ctx.text(row, "agent_id", rule, true, true), nodeId = ctx.text(row, "node_id", rule, true, true);
    const removedAt = ctx.text(row, "removed_at", rule, true);
    ctx.id(row, "display_name", rule); ctx.text(row, "created_at", rule); ctx.text(row, "updated_at", rule);
    // Observation accepts MAX_SAFE; mutation/capture may need spare increment capacity.
    ctx.safe(row, "membership_revision", rule);
    if ((kind === "agent") !== (agentId !== null)) ctx.fail(row, rule, "identity-mismatch", "agent_id");
    if (agentId !== null) {
      ctx.require(agents, [agentId], row, rule, "agent_id"); ctx.insert(projectAgents, [projectId, agentId], row, row, rule, "agent_id");
    }
    if (removedAt !== null && (status !== "disabled" || nodeId !== null || role !== "normal")) ctx.fail(row, rule, "negative-invariant", "removed_at");
    if (role === "manager") ctx.insert(managers, [projectId], row, row, rule, "role");
    if (nodeId !== null) {
      const node = ctx.require(nodes, [nodeId], row, rule, "node_id");
      if (!ctx.equal(ctx.id(node, "project_id", rule), projectId)) ctx.fail(row, rule, "scope-mismatch", "node_id", node);
      if ((ctx.text(node, "parent_id", rule, true) === null) !== (role === "manager")) ctx.fail(row, rule, "state-mismatch", "role", node);
      ctx.insert(occupancy, [nodeId], row, row, rule, "node_id");
    }
    // A legacy manager without a node remains a valid persisted observation.
  }
  const facts = ctx.index<P0Row>(); ctx.cost(1, 0, 1); const counts = new Map<P0Row, number>();
  for (const row of ctx.rows("member_fact_revisions")) {
    const memberId = ctx.id(row, "member_id", rule), member = ctx.require(members, [memberId], row, rule, "member_id");
    const kind = ctx.oneOf(row, "kind", rule, MEMBER_FACT_KINDS); ctx.safe(row, "revision", rule);
    ctx.insert(facts, [memberId, kind], row, row, rule, "kind");
    ctx.cost(2, 0, counts.has(member) ? 0 : 1); counts.set(member, (counts.get(member) ?? 0) + 1);
  }
  for (const row of memberRows) {
    ctx.cost(1); if (counts.get(row) !== MEMBER_FACT_KINDS.length) ctx.fail(row, rule, "count-mismatch", "id");
  }
}

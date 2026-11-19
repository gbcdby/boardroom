import type { P0BContext } from "./m2-p0-b-context.ts";
import type { P0Row } from "./m2-p0.ts";

export function checkP0Chat(ctx: P0BContext): void {
  const rule = "PC1B-CHAT01", projects = ctx.byId("projects", rule), members = ctx.byId("members", rule), agents = ctx.byId("agents", rule);
  const groups = ctx.byId("groups", rule), messages = ctx.byId("messages", rule);
  const sameProject = (row: P0Row, projectId: string, target: P0Row, column: string) => {
    if (!ctx.equal(projectId, ctx.id(target, "project_id", rule))) ctx.fail(row, rule, "scope-mismatch", column, target);
  };
  for (const row of ctx.rows("groups")) {
    ctx.require(projects, [ctx.id(row, "project_id", rule)], row, rule, "project_id");
    ctx.id(row, "name", rule); ctx.text(row, "created_at", rule); ctx.text(row, "updated_at", rule); ctx.text(row, "archived_at", rule, true);
  }
  const participants = ctx.index<P0Row>();
  for (const row of ctx.rows("group_participants")) {
    const groupId = ctx.id(row, "group_id", rule), memberId = ctx.id(row, "member_id", rule);
    const group = ctx.require(groups, [groupId], row, rule, "group_id"), member = ctx.require(members, [memberId], row, rule, "member_id");
    sameProject(row, ctx.id(group, "project_id", rule), member, "member_id"); ctx.text(row, "joined_at", rule);
    ctx.insert(participants, [groupId, memberId], row, row, rule);
  }
  const sequence = ctx.index<P0Row>(), clients = ctx.index<P0Row>();
  for (const row of ctx.rows("messages")) {
    const groupId = ctx.id(row, "group_id", rule), senderId = ctx.id(row, "sender_member_id", rule);
    const group = ctx.require(groups, [groupId], row, rule, "group_id"), sender = ctx.require(members, [senderId], row, rule, "sender_member_id");
    sameProject(row, ctx.id(group, "project_id", rule), sender, "sender_member_id");
    const seq = ctx.safe(row, "seq", rule)!, client = ctx.text(row, "client_message_id", rule, true);
    ctx.id(row, "body", rule); ctx.text(row, "created_at", rule);
    ctx.insert(sequence, [groupId, seq], row, row, rule, "seq");
    // Exact frozen predicate: every non-NULL key participates; no latest/head filter.
    if (client !== null) {
      if (client === "") ctx.fail(row, rule, "unsupported-value", "client_message_id");
      ctx.insert(clients, [senderId, client], row, row, rule, "client_message_id");
    }
    checkMentions(ctx, row);
    // Sender need not still participate/be active; mentions need not resolve today.
  }
  ctx.byId("message_deliveries", rule); const deliveries = ctx.index<P0Row>();
  for (const row of ctx.rows("message_deliveries")) {
    const messageId = ctx.id(row, "message_id", rule), memberId = ctx.id(row, "member_id", rule), projectId = ctx.id(row, "project_id", rule);
    const message = ctx.require(messages, [messageId], row, rule, "message_id"), member = ctx.require(members, [memberId], row, rule, "member_id");
    const group = ctx.require(groups, [ctx.id(message, "group_id", rule)], row, rule, "message_id");
    ctx.require(projects, [projectId], row, rule, "project_id"); sameProject(row, projectId, member, "member_id"); sameProject(row, projectId, group, "message_id");
    ctx.oneOf(row, "status", rule, ["pending", "delivered", "acked"]); ctx.safe(row, "attempt_count", rule, 0n);
    const wake = ctx.text(row, "wake_decision", rule, true), reason = ctx.text(row, "wake_suppressed_reason", rule, true);
    if (wake !== null) ctx.oneOf(row, "wake_decision", rule, ["allowed", "suppressed"]);
    if (wake === "suppressed") ctx.oneOf(row, "wake_suppressed_reason", rule, ["consecutive_limit", "rate_limited"]);
    else if (reason !== null) ctx.fail(row, rule, "state-mismatch", "wake_suppressed_reason");
    for (const column of ["first_delivered_at", "last_delivered_at", "acked_at", "first_mcp_delivered_at"] as const) ctx.text(row, column, rule, true);
    ctx.text(row, "created_at", rule); ctx.text(row, "updated_at", rule);
    ctx.insert(deliveries, [messageId, memberId], row, row, rule);
    // The current status does not imply first-MCP/ACK timestamps in legacy rows.
  }
  const statuses = ctx.index<P0Row>();
  for (const row of ctx.rows("member_statuses")) {
    const projectId = ctx.id(row, "project_id", rule), memberId = ctx.id(row, "member_id", rule);
    ctx.require(projects, [projectId], row, rule, "project_id");
    const member = ctx.require(members, [memberId], row, rule, "member_id"); sameProject(row, projectId, member, "member_id");
    ctx.oneOf(row, "state", rule, ["online", "offline", "waiting", "working"]); ctx.text(row, "updated_at", rule);
    ctx.insert(statuses, [projectId, memberId], row, row, rule);
  }
  ctx.byId("mcp_sessions", rule); const active = ctx.index<P0Row>();
  for (const row of ctx.rows("mcp_sessions")) {
    const agentId = ctx.id(row, "agent_id", rule), memberId = ctx.id(row, "member_id", rule);
    const projectId = ctx.id(row, "project_id", rule), groupId = ctx.id(row, "group_id", rule);
    ctx.require(agents, [agentId], row, rule, "agent_id"); ctx.require(projects, [projectId], row, rule, "project_id");
    const member = ctx.require(members, [memberId], row, rule, "member_id"), group = ctx.require(groups, [groupId], row, rule, "group_id");
    sameProject(row, projectId, member, "member_id"); sameProject(row, projectId, group, "group_id");
    const memberAgent = ctx.text(member, "agent_id", rule, true);
    if (memberAgent === null || !ctx.equal(memberAgent, agentId)) ctx.fail(row, rule, "identity-mismatch", "agent_id", member);
    const state = ctx.oneOf(row, "state", rule, ["connected", "disconnected"]);
    if (state === "connected") ctx.insert(active, [agentId, projectId, groupId], row, row, rule);
    ctx.text(row, "display_name", rule); ctx.text(row, "host_type", rule); ctx.text(row, "connected_at", rule); ctx.text(row, "updated_at", rule);
    ctx.text(row, "last_heartbeat_at", rule, true); ctx.text(row, "disconnected_at", rule, true);
    // Cached identity labels and lifecycle status may have changed since connection.
  }
}
function checkMentions(ctx: P0BContext, row: P0Row): void {
  const rule = "PC1B-CHAT01", mentions = ctx.json(row, "mentions", rule);
  if (!Array.isArray(mentions)) ctx.fail(row, rule, "format-mismatch", "mentions");
  ctx.cost(mentions.length);
  for (const mention of mentions) {
    if (typeof mention !== "string") ctx.fail(row, rule, "format-mismatch", "mentions");
    if (ctx.request.input.graph.observation.backend === "postgres") {
      // The real visibility selector casts to jsonb (PG16 JSON Types): unlike
      // JSON.parse, it cannot consume U+0000 or unpaired Unicode surrogates.
      ctx.cost(mention.length, mention.length * 3);
      for (let i = 0; i < mention.length; i++) {
        const code = mention.charCodeAt(i);
        if (code === 0 || code >= 0xdc00 && code <= 0xdfff) ctx.fail(row, rule, "format-mismatch", "mentions");
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = mention.charCodeAt(++i);
          if (!(next >= 0xdc00 && next <= 0xdfff)) ctx.fail(row, rule, "format-mismatch", "mentions");
        }
      }
    }
  }
}

import { roleTemplateInputSchema } from "../catalog.ts";
import type { P0BContext } from "./m2-p0-b-context.ts";
import type { P0Row } from "./m2-p0.ts";

export function checkP0Aliases(ctx: P0BContext): void {
  const rule = "PC1B-ID01", agents = ctx.byId("agents", rule);
  const current = ctx.index<P0Row>(), aliases = ctx.index<P0Row>();
  const liveRows = ctx.rows("agents"), aliasRows = ctx.rows("agent_legacy_aliases");
  for (const row of liveRows) {
    ctx.insert(current, [ctx.id(row, "display_name", rule), ctx.id(row, "host_type", rule)], row, row, rule);
    ctx.text(row, "created_at", rule); ctx.text(row, "updated_at", rule); ctx.text(row, "last_seen_at", rule, true);
  }
  for (const row of aliasRows) ctx.insert(aliases, [ctx.id(row, "display_name", rule), ctx.id(row, "host_type", rule)], row, row, rule);
  // Check every historical alias, including retired keys outside current identities.
  for (const row of aliasRows) {
    const id = ctx.id(row, "agent_id", rule), target = agents.get([id]);
    const claimant = current.get([ctx.id(row, "display_name", rule), ctx.id(row, "host_type", rule)]);
    const retired = ctx.text(row, "retired_at", rule, true); ctx.text(row, "created_at", rule);
    if (retired !== null) {
      if (target || claimant) ctx.fail(row, rule, "negative-invariant", "retired_at", target ?? claimant);
    } else {
      if (!target) ctx.fail(row, rule, "missing-target", "agent_id");
      if (claimant && !ctx.equal(ctx.id(claimant, "id", rule), id)) ctx.fail(row, rule, "identity-mismatch", "agent_id", claimant);
    }
  }
  for (const row of liveRows) {
    const alias = ctx.require(aliases, [ctx.id(row, "display_name", rule), ctx.id(row, "host_type", rule)], row, rule, "display_name");
    if (!ctx.equal(ctx.id(alias, "agent_id", rule), ctx.id(row, "id", rule)) || ctx.text(alias, "retired_at", rule, true) !== null) {
      ctx.fail(row, rule, "identity-mismatch", "display_name", alias);
    }
  }
}


export function checkP0Roles(ctx: P0BContext): void {
  const rule = "PC1B-ROLE01", heads = ctx.byId("role_templates", rule), versions = ctx.index<P0Row>();
  const headRows = ctx.rows("role_templates"), rows = ctx.rows("role_template_versions");
  for (const row of rows) {
    const id = ctx.id(row, "role_template_id", rule), revision = ctx.safe(row, "revision", rule)!;
    ctx.require(heads, [id], row, rule, "role_template_id");
    ctx.insert(versions, [id, revision], row, row, rule, "revision");
  }
  for (const row of headRows) {
    ctx.require(versions, [ctx.id(row, "id", rule), ctx.safe(row, "revision", rule)!], row, rule, "revision");
    ctx.text(row, "created_at", rule); ctx.text(row, "updated_at", rule);
  }
  ctx.cost(1, 0, 2); const edges = new Map<P0Row, P0Row | null>(), complete = new Set<P0Row>();
  for (const row of rows) {
    ctx.text(row, "archived_at", rule, true); ctx.text(row, "created_at", rule);
    const id = ctx.text(row, "copied_from_role_template_id", rule, true, true);
    const revision = ctx.safe(row, "copied_from_revision", rule, 1n, true);
    if ((id === null) !== (revision === null)) ctx.fail(row, rule, "conditional-target-required", "copied_from_role_template_id");
    const target = id === null ? null : ctx.require(versions, [id, revision], row, rule, "copied_from_revision");
    ctx.cost(1, 0, 1); edges.set(row, target);
    checkRoleInput(ctx, row);
  }
  // Every version, including an unheaded historical component, must reach a NULL root.
  for (const row of rows) {
    ctx.cost(1); if (complete.has(row)) continue;
    ctx.cost(1, 0, 1); const path = new Set<P0Row>(); let node: P0Row | null = row;
    while (node !== null && !complete.has(node)) {
      ctx.cost(3, 0, 1);
      if (path.has(node)) ctx.fail(node, rule, "negative-invariant", "copied_from_revision");
      path.add(node); node = edges.get(node)!;
    }
    ctx.cost(path.size, 0, path.size); for (const visited of path) complete.add(visited);
  }
}
function checkRoleInput(ctx: P0BContext, row: P0Row): void {
  const rule = "PC1B-ROLE02", column = "recommended_skill_refs_json";
  const refs = ctx.json(row, column, rule);
  if (!Array.isArray(refs) || refs.length > 64) ctx.fail(row, rule, "format-mismatch", column);
  // Bound the real schema's issue/clone work before calling it. The input was parsed
  // by A; these objects cannot be proxies or caller-owned accessors.
  ctx.cost(refs.length + 1, 0, refs.length * 8 + 1);
  for (const ref of refs) {
    if (ref === null || typeof ref !== "object" || Array.isArray(ref)) ctx.fail(row, rule, "format-mismatch", column);
    let count = 0;
    for (const key in ref) {
      ctx.cost(1, key.length * 3);
      if (++count > 3 || key !== "skillId" && key !== "version" && key !== "contentDigest") ctx.fail(row, rule, "format-mismatch", column);
    }
    if (count !== 3 || typeof ref.skillId !== "string" || typeof ref.version !== "string" || typeof ref.contentDigest !== "string") {
      ctx.fail(row, rule, "format-mismatch", column);
    }
    // The fixed length bounds avoid scanning an arbitrarily long invalid field in Zod.
    if (ref.skillId.length > 128 || ref.version.length > 128 || ref.contentDigest.length !== 64) ctx.fail(row, rule, "format-mismatch", column);
    ctx.cost(16, (ref.skillId.length + ref.version.length + ref.contentDigest.length) * 12);
  }
  const name = ctx.text(row, "name", rule)!, purpose = ctx.text(row, "purpose", rule)!, instructions = ctx.text(row, "instructions", rule)!;
  // New input wrapper: object + four keys + three scalar fields = 8 nodes;
  // the already-owned refs subtree is borrowed there. The actual Zod output
  // allocates another object/four keys/three fields/refs array = 9 nodes, plus
  // seven nodes per strict ref (object, three keys and three scalar values).
  // Charge before both allocations; cached A JSON does not cover this new tree.
  ctx.cost(16, (name.length + purpose.length + instructions.length) * 12, 1, 17 + refs.length * 7);
  const parsed = roleTemplateInputSchema.safeParse({ name, purpose, instructions, recommendedSkillRefs: refs });
  if (!parsed.success) ctx.fail(row, rule, "format-mismatch", column);
  const unique = ctx.index<true>();
  for (const ref of parsed.data.recommendedSkillRefs) ctx.insert(unique, [ref.skillId, ref.version], true, row, rule, column);
  // Parsing is only a validation shadow: trim transforms and JSON key order never
  // replace the persisted strings, and external skills do not become local FKs.
}

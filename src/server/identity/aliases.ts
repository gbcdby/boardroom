import type { RepoCtx } from "../db/repositories.ts";
import { ConflictError, RepositoryError } from "../db/errors.ts";

export interface LegacyAgentAlias {
  readonly displayName: string;
  readonly hostType: string;
  readonly agentId: string;
  readonly createdAt: string;
  readonly retiredAt: string | null;
}
type AliasRow = { display_name: string; host_type: string; agent_id: string; created_at: string; retired_at: string | null };
type ReadContext = Pick<RepoCtx, "one">;

export async function hasIdentityCatalogSchema(ctx: ReadContext): Promise<boolean> {
  return Boolean(await ctx.one("SELECT version FROM schema_migrations WHERE version = 14"));
}
export function aliasFromRow(row: AliasRow): LegacyAgentAlias {
  return { displayName: row.display_name, hostType: row.host_type, agentId: row.agent_id,
    createdAt: row.created_at, retiredAt: row.retired_at };
}

/** 唯一 legacy 身份解析；墓碑或损坏引用必须明确拒绝，绝不降级成「创建新身份」。 */
export async function findLegacyAgentId(ctx: ReadContext, displayName: string, hostType: string): Promise<string | null> {
  if (!await hasIdentityCatalogSchema(ctx)) {
    return (await ctx.one<{ id: string }>("SELECT id FROM agents WHERE display_name = ? AND host_type = ?", [displayName, hostType]))?.id ?? null;
  }
  const alias = await ctx.one<AliasRow>("SELECT * FROM agent_legacy_aliases WHERE display_name = ? AND host_type = ?", [displayName, hostType]);
  if (alias?.retired_at !== null && alias?.retired_at !== undefined) throw new ConflictError("agent_identity_retired");
  if (alias) {
    if (!await ctx.one("SELECT id FROM agents WHERE id = ?", [alias.agent_id])) {
      throw new RepositoryError("migration_identity_ambiguous", "agent_alias_target_missing");
    }
    return alias.agent_id;
  }
  if (await ctx.one("SELECT id FROM agents WHERE display_name = ? AND host_type = ?", [displayName, hostType])) {
    throw new RepositoryError("migration_identity_ambiguous", "agent_legacy_alias_missing");
  }
  return null;
}

/** 必须在调用方事务内：只追加，已有映射不能重分配、退休不能复活。 */
export async function reserveLegacyAlias(ctx: Pick<RepoCtx, "one" | "exec">, alias: Omit<LegacyAgentAlias, "retiredAt">): Promise<void> {
  const existing = await ctx.one<AliasRow>("SELECT * FROM agent_legacy_aliases WHERE display_name = ? AND host_type = ?", [alias.displayName, alias.hostType]);
  if (existing) {
    if (existing.agent_id !== alias.agentId || existing.retired_at !== null) throw new ConflictError("agent_alias_conflict");
    return;
  }
  const current = await ctx.one<{ id: string }>("SELECT id FROM agents WHERE display_name = ? AND host_type = ?", [alias.displayName, alias.hostType]);
  if (current && current.id !== alias.agentId) throw new ConflictError("agent_alias_conflict");
  // DO NOTHING 让双方言并发冲突可在当前事务中重读，PG 不进入 aborted transaction。
  await ctx.exec(`INSERT INTO agent_legacy_aliases (display_name, host_type, agent_id, created_at)
    VALUES (?, ?, ?, ?) ON CONFLICT (display_name, host_type) DO NOTHING`, [alias.displayName, alias.hostType, alias.agentId, alias.createdAt]);
  const stored = await ctx.one<AliasRow>("SELECT * FROM agent_legacy_aliases WHERE display_name = ? AND host_type = ?", [alias.displayName, alias.hostType]);
  if (stored?.agent_id !== alias.agentId || stored.retired_at !== null) throw new ConflictError("agent_alias_conflict");
}

export async function listLegacyAliases(ctx: Pick<RepoCtx, "query">, agentId: string): Promise<LegacyAgentAlias[]> {
  return (await ctx.query<AliasRow>("SELECT * FROM agent_legacy_aliases WHERE agent_id = ? ORDER BY display_name, host_type", [agentId])).map(aliasFromRow);
}

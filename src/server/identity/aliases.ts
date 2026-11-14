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
type ReadContext = Pick<RepoCtx, "one" | "query">;
type IdentityRow = { id: string; display_name: string; host_type: string };

export async function hasIdentityCatalogSchema(ctx: Pick<RepoCtx, "one">): Promise<boolean> {
  return Boolean(await ctx.one("SELECT version FROM schema_migrations WHERE version = 14"));
}
export function aliasFromRow(row: AliasRow): LegacyAgentAlias {
  return { displayName: row.display_name, hostType: row.host_type, agentId: row.agent_id,
    createdAt: row.created_at, retiredAt: row.retired_at };
}

async function uniqueAlias(ctx: Pick<RepoCtx, "query">, displayName: string, hostType: string): Promise<AliasRow | null> {
  // 坏导入可能没有唯一约束；不能以 one()/LIMIT 1 任取一个身份。
  const rows = await ctx.query<AliasRow>("SELECT * FROM agent_legacy_aliases WHERE display_name = ? AND host_type = ?", [displayName, hostType]);
  if (rows.length > 1) throw new RepositoryError("migration_identity_ambiguous", "legacy_alias_duplicate");
  return rows[0] ?? null;
}

async function assertAliasTarget(ctx: ReadContext, target: IdentityRow): Promise<void> {
  const current = await uniqueAlias(ctx, target.display_name, target.host_type);
  if (!current) throw new RepositoryError("migration_identity_ambiguous", "agent_legacy_alias_missing");
  if (current.agent_id !== target.id || current.retired_at !== null) throw new RepositoryError("migration_identity_ambiguous", "legacy_alias_conflict");
  const duplicates = await ctx.query(`SELECT own.display_name, own.host_type FROM agent_legacy_aliases own
    JOIN agent_legacy_aliases other ON other.display_name = own.display_name AND other.host_type = own.host_type
    WHERE own.agent_id = ? GROUP BY own.display_name, own.host_type HAVING COUNT(*) > 1`, [target.id]);
  if (duplicates.length > 0) throw new RepositoryError("migration_identity_ambiguous", "legacy_alias_duplicate");
  if (await ctx.one("SELECT agent_id FROM agent_legacy_aliases WHERE agent_id = ? AND retired_at IS NOT NULL", [target.id])) {
    throw new RepositoryError("migration_identity_ambiguous", "retired_alias_has_live_agent");
  }
  // 目标的任何 alias 若占用了另一个活 Agent 的当前键，也不能从历史键绕过损坏引用。
  const conflicts = await ctx.query(`SELECT a.id FROM agents a JOIN agent_legacy_aliases l
    ON l.display_name = a.display_name AND l.host_type = a.host_type WHERE l.agent_id = ? AND a.id <> ?`, [target.id, target.id]);
  if (conflicts.length > 0) throw new RepositoryError("migration_identity_ambiguous", "legacy_alias_conflict");
}

/** 唯一 legacy 身份解析；不依赖调用方预先运行 preflight。 */
export async function findLegacyAgentId(ctx: ReadContext, displayName: string, hostType: string): Promise<string | null> {
  const current = await ctx.query<IdentityRow>("SELECT id, display_name, host_type FROM agents WHERE display_name = ? AND host_type = ?", [displayName, hostType]);
  if (current.length > 1) throw new RepositoryError("migration_identity_ambiguous", "legacy_alias_conflict");
  if (!await hasIdentityCatalogSchema(ctx)) return current[0]?.id ?? null;
  const alias = await uniqueAlias(ctx, displayName, hostType);
  if (!alias) {
    if (current.length > 0) throw new RepositoryError("migration_identity_ambiguous", "agent_legacy_alias_missing");
    return null;
  }
  const targets = await ctx.query<IdentityRow>("SELECT id, display_name, host_type FROM agents WHERE id = ?", [alias.agent_id]);
  if (alias.retired_at !== null) {
    if (targets.length > 0 || current.length > 0) throw new RepositoryError("migration_identity_ambiguous", "retired_alias_has_live_agent");
    throw new ConflictError("agent_identity_retired");
  }
  if (targets.length !== 1) throw new RepositoryError("migration_identity_ambiguous", "agent_alias_target_missing");
  if (current.length === 1 && current[0]!.id !== alias.agent_id) throw new RepositoryError("migration_identity_ambiguous", "legacy_alias_conflict");
  await assertAliasTarget(ctx, targets[0]!);
  return alias.agent_id;
}

/** 必须在调用方事务内：只追加，已有映射不能重分配、退休不能复活。 */
export async function reserveLegacyAlias(ctx: Pick<RepoCtx, "one" | "query" | "exec">, alias: Omit<LegacyAgentAlias, "retiredAt">): Promise<void> {
  const existing = await uniqueAlias(ctx, alias.displayName, alias.hostType);
  if (existing) {
    if (existing.agent_id !== alias.agentId || existing.retired_at !== null) throw new ConflictError("agent_alias_conflict");
    return;
  }
  const current = await ctx.query<{ id: string }>("SELECT id FROM agents WHERE display_name = ? AND host_type = ?", [alias.displayName, alias.hostType]);
  if (current.length > 1) throw new RepositoryError("migration_identity_ambiguous", "legacy_alias_conflict");
  if (current[0] && current[0].id !== alias.agentId) throw new ConflictError("agent_alias_conflict");
  // DO NOTHING 让双方言并发冲突可在当前事务中重读，PG 不进入 aborted transaction。
  await ctx.exec(`INSERT INTO agent_legacy_aliases (display_name, host_type, agent_id, created_at)
    VALUES (?, ?, ?, ?) ON CONFLICT (display_name, host_type) DO NOTHING`, [alias.displayName, alias.hostType, alias.agentId, alias.createdAt]);
  const stored = await uniqueAlias(ctx, alias.displayName, alias.hostType);
  if (stored?.agent_id !== alias.agentId || stored.retired_at !== null) throw new ConflictError("agent_alias_conflict");
}

export async function listLegacyAliases(ctx: Pick<RepoCtx, "query">, agentId: string): Promise<LegacyAgentAlias[]> {
  return (await ctx.query<AliasRow>("SELECT * FROM agent_legacy_aliases WHERE agent_id = ? ORDER BY display_name, host_type", [agentId])).map(aliasFromRow);
}

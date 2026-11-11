import { z } from "zod";
import type { RepositorySet } from "../db/repositories.ts";
import { newId } from "../db/ids.ts";
import { ConflictError, InvalidArgumentError, NotFoundError } from "../db/errors.ts";
import { authorizeOrThrow, ForbiddenError, type Actor } from "../authz/authorize.ts";
import { appendAuditEntry, assertCompleteAuditFields, auditActorFrom, type AuditAction } from "../audit.ts";
import type { RoleDeleteImpact, RoleTemplate, RoleTemplateInput } from "../../shared/identity.ts";
import type { LegacyAgentAlias } from "./aliases.ts";

export interface CatalogAccess { readonly actor: Actor }
const textId = z.string().min(1).max(128).refine(value => value.trim() === value && !/[\r\n\0]/.test(value));
export const roleTemplateInputSchema = z.object({
  name: z.string().trim().min(1).max(64).refine(value => !/[\r\n\0]/.test(value)),
  purpose: z.string().max(2000).refine(value => !value.includes("\0")),
  instructions: z.string().max(16000).refine(value => !value.includes("\0")),
  recommendedSkillRefs: z.array(z.object({ skillId: textId, version: textId, contentDigest: z.string().regex(/^[0-9a-f]{64}$/) }).strict()).max(64),
}).strict();
export function requireCatalogUser(access: CatalogAccess): void {
  if (access.actor.kind !== "human" || access.actor.projectId !== null) throw new ForbiddenError({ allowed: false,
    capability: "runtime:manage", code: "forbidden", reason: "仅本地用户可以管理全局职责和身份目录。" });
  authorizeOrThrow(access.actor, "runtime:manage", {});
}
function input(value: RoleTemplateInput): RoleTemplateInput {
  const result = roleTemplateInputSchema.safeParse(value);
  if (!result.success) throw new InvalidArgumentError("role_template_input_invalid");
  const refs = result.data.recommendedSkillRefs;
  if (new Set(refs.map(ref => JSON.stringify([ref.skillId, ref.version]))).size !== refs.length) throw new InvalidArgumentError("role_skill_reference_duplicate");
  return result.data;
}
function revision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new InvalidArgumentError("role_revision_invalid");
}
type RoleRow = { role_template_id: string; revision: number; name: string; purpose: string; instructions: string;
  recommended_skill_refs_json: string; archived_at: string | null; copied_from_role_template_id: string | null;
  copied_from_revision: number | null; role_created_at: string; created_at: string };
function roleFromRow(row: RoleRow): RoleTemplate {
  return { roleTemplateId: row.role_template_id, revision: Number(row.revision), name: row.name, purpose: row.purpose,
    instructions: row.instructions, recommendedSkillRefs: JSON.parse(row.recommended_skill_refs_json), archivedAt: row.archived_at,
    copiedFrom: row.copied_from_role_template_id === null ? null : { roleTemplateId: row.copied_from_role_template_id, revision: Number(row.copied_from_revision) },
    createdAt: row.role_created_at, updatedAt: row.created_at };
}

/** 目录修改和 user scope 审计同一事务；任何职责文本都不进入权限矩阵或运行配置。 */
export function createIdentityCatalog({ repos, now = () => new Date() }: { repos: RepositorySet; now?: () => Date }) {
  const ctx = repos.context;
  async function getVersion(id: string, version: number): Promise<RoleTemplate | null> {
    const row = await ctx.one<RoleRow>(`SELECT v.*, r.created_at AS role_created_at FROM role_template_versions v
      JOIN role_templates r ON r.id = v.role_template_id WHERE v.role_template_id = ? AND v.revision = ?`, [id, version]);
    return row ? roleFromRow(row) : null;
  }
  async function get(id: string): Promise<RoleTemplate | null> {
    const row = await ctx.one<RoleRow>(`SELECT v.*, r.created_at AS role_created_at FROM role_template_versions v
      JOIN role_templates r ON r.id = v.role_template_id AND r.revision = v.revision WHERE r.id = ?`, [id]);
    return row ? roleFromRow(row) : null;
  }
  async function required(id: string): Promise<RoleTemplate> { const role = await get(id); if (!role) throw new NotFoundError("role_template_not_found"); return role; }
  async function appendVersion(role: RoleTemplate): Promise<void> {
    await ctx.exec(`INSERT INTO role_template_versions (role_template_id, revision, name, purpose, instructions,
      recommended_skill_refs_json, archived_at, copied_from_role_template_id, copied_from_revision, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [role.roleTemplateId, role.revision, role.name, role.purpose, role.instructions,
      JSON.stringify(role.recommendedSkillRefs), role.archivedAt, role.copiedFrom?.roleTemplateId ?? null, role.copiedFrom?.revision ?? null, role.updatedAt]);
  }
  async function audit(access: CatalogAccess, action: AuditAction, before: RoleTemplate | null, after: RoleTemplate | null): Promise<void> {
    const role = after ?? before!;
    await appendAuditEntry(repos.audit, { scope: "user", projectId: null, actor: auditActorFrom(access.actor), action,
      targetKind: "role_template", targetId: role.roleTemplateId, targetName: role.name, before, after });
  }
  async function create(access: CatalogAccess, value: RoleTemplateInput): Promise<RoleTemplate> {
    requireCatalogUser(access); const fields = input(value); const at = now().toISOString();
    const role: RoleTemplate = { ...fields, roleTemplateId: newId(), revision: 1, archivedAt: null, copiedFrom: null, createdAt: at, updatedAt: at };
    assertCompleteAuditFields(role);
    return repos.transaction(async () => {
      await ctx.exec("INSERT INTO role_templates (id, revision, created_at, updated_at) VALUES (?, 1, ?, ?)", [role.roleTemplateId, at, at]);
      await appendVersion(role); await audit(access, "role_template.create", null, role); return role;
    });
  }
  async function update(access: CatalogAccess, id: string, expectedRevision: number, value: RoleTemplateInput): Promise<RoleTemplate> {
    requireCatalogUser(access); revision(expectedRevision); const fields = input(value);
    return repos.transaction(async () => {
      const before = await required(id);
      if (before.archivedAt !== null) throw new ConflictError("role_template_archived");
      const after: RoleTemplate = { ...before, ...fields, revision: expectedRevision + 1, updatedAt: now().toISOString() };
      assertCompleteAuditFields(before, after);
      if (await ctx.exec("UPDATE role_templates SET revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?",
        [after.updatedAt, id, expectedRevision]) !== 1) throw new ConflictError("role_revision_conflict");
      await appendVersion(after); await audit(access, "role_template.update", before, after); return after;
    });
  }
  async function lockRole(id: string, expectedRevision: number): Promise<RoleTemplate> {
    revision(expectedRevision);
    if (await ctx.exec("UPDATE role_templates SET updated_at = updated_at WHERE id = ?", [id]) !== 1) throw new NotFoundError("role_template_not_found");
    const role = await required(id);
    if (role.revision !== expectedRevision) throw new ConflictError("role_revision_conflict");
    return role;
  }
  async function copy(access: CatalogAccess, id: string, expectedRevision: number, name: string): Promise<RoleTemplate> {
    requireCatalogUser(access); revision(expectedRevision);
    return repos.transaction(async () => {
      const source = await lockRole(id, expectedRevision);
      const fields = input({ name, purpose: source.purpose, instructions: source.instructions, recommendedSkillRefs: source.recommendedSkillRefs });
      const at = now().toISOString();
      const copied: RoleTemplate = { ...fields, roleTemplateId: newId(), revision: 1, archivedAt: null,
        copiedFrom: { roleTemplateId: source.roleTemplateId, revision: source.revision }, createdAt: at, updatedAt: at };
      assertCompleteAuditFields(copied);
      await ctx.exec("INSERT INTO role_templates (id, revision, created_at, updated_at) VALUES (?, 1, ?, ?)", [copied.roleTemplateId, at, at]);
      await appendVersion(copied); await audit(access, "role_template.copy", null, copied); return copied;
    });
  }
  async function setArchived(access: CatalogAccess, id: string, expectedRevision: number, archived: boolean): Promise<RoleTemplate> {
    requireCatalogUser(access); revision(expectedRevision);
    return repos.transaction(async () => {
      const before = await lockRole(id, expectedRevision);
      if ((before.archivedAt !== null) === archived) return before;
      const at = now().toISOString(), after = { ...before, revision: before.revision + 1, archivedAt: archived ? at : null, updatedAt: at };
      assertCompleteAuditFields(before, after);
      await ctx.exec("UPDATE role_templates SET revision = ?, updated_at = ? WHERE id = ?", [after.revision, at, id]);
      await appendVersion(after); await audit(access, archived ? "role_template.archive" : "role_template.restore", before, after); return after;
    });
  }
  async function deleteImpact(id: string): Promise<RoleDeleteImpact> {
    const role = await required(id);
    const copies = await ctx.query<{ role_template_id: string; revision: number; copied_from_revision: number }>(
      `SELECT role_template_id, revision, copied_from_revision FROM role_template_versions
        WHERE copied_from_role_template_id = ? ORDER BY role_template_id, revision`, [id]);
    return { roleTemplateId: id, revision: role.revision, deletable: copies.length === 0,
      versions: (await ctx.query<{ revision: number }>("SELECT revision FROM role_template_versions WHERE role_template_id = ? ORDER BY revision", [id])).map(row => Number(row.revision)),
      references: copies.map(row => ({ kind: "role-copy", roleTemplateId: row.role_template_id, revision: Number(row.revision), sourceRevision: Number(row.copied_from_revision) })),
      allowedActions: copies.length === 0 ? ["delete", "archive"] : ["archive"] };
  }
  async function remove(access: CatalogAccess, id: string, expectedRevision: number): Promise<void> {
    requireCatalogUser(access); revision(expectedRevision);
    await repos.transaction(async () => {
      const before = await lockRole(id, expectedRevision), impact = await deleteImpact(id);
      if (!impact.deletable) throw new ConflictError("role_template_in_use");
      await ctx.exec("DELETE FROM role_template_versions WHERE role_template_id = ?", [id]);
      await ctx.exec("DELETE FROM role_templates WHERE id = ?", [id]);
      await audit(access, "role_template.delete", before, null);
    });
  }
  async function getAgent(id: string) {
    const agent = await repos.agents.get(id);
    if (!agent) throw new NotFoundError("agent_not_found");
    return { agent, aliases: await repos.agents.aliases(id) };
  }
  return { roles: { create, update, get, getVersion, copy, deleteImpact, remove,
    archive: (access: CatalogAccess, id: string, expectedRevision: number) => setArchived(access, id, expectedRevision, true),
    restore: (access: CatalogAccess, id: string, expectedRevision: number) => setArchived(access, id, expectedRevision, false),
    async list(includeArchived = false): Promise<RoleTemplate[]> {
    return (await ctx.query<RoleRow>(`SELECT v.*, r.created_at AS role_created_at FROM role_templates r
      JOIN role_template_versions v ON v.role_template_id = r.id AND v.revision = r.revision
      ${includeArchived ? "" : "WHERE v.archived_at IS NULL"} ORDER BY r.created_at, r.id`)).map(roleFromRow);
  } }, agents: {
    get: getAgent,
    async list() { return Promise.all((await repos.agents.list()).map(agent => getAgent(agent.id))); },
    async rename(access: CatalogAccess, id: string, expectedDisplayName: string, name: string) {
      requireCatalogUser(access);
      const displayName = roleTemplateInputSchema.shape.name.safeParse(name);
      if (!displayName.success || typeof expectedDisplayName !== "string" || !expectedDisplayName) throw new InvalidArgumentError("agent_name_invalid");
      return repos.transaction(async () => {
        const before = (await getAgent(id)).agent;
        const after = await repos.agents.rename(id, expectedDisplayName, displayName.data);
        if (before.displayName !== after.displayName) await appendAuditEntry(repos.audit, { scope: "user", projectId: null,
          actor: auditActorFrom(access.actor), action: "agent.rename", targetKind: "agent", targetId: id, targetName: after.displayName, before, after });
        return getAgent(id);
      });
    },
    async addAlias(access: CatalogAccess, id: string, value: Pick<LegacyAgentAlias, "displayName" | "hostType">) {
      requireCatalogUser(access);
      const parsed = z.object({ displayName: roleTemplateInputSchema.shape.name, hostType: textId }).strict().safeParse(value);
      if (!parsed.success) throw new InvalidArgumentError("agent_alias_invalid");
      return repos.transaction(async () => {
        const before = await getAgent(id);
        const aliases = await repos.agents.addAlias(id, parsed.data);
        if (aliases.length !== before.aliases.length) await appendAuditEntry(repos.audit, { scope: "user", projectId: null,
          actor: auditActorFrom(access.actor), action: "agent.alias_add", targetKind: "agent", targetId: id,
          targetName: before.agent.displayName, before: null, after: { agentId: id, ...parsed.data } });
        return { agent: before.agent, aliases };
      });
    },
  } };
}

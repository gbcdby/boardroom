/**
 * #153 B1a 内部服务：只在 v22 新表上写入。
 *
 * 无 HTTP/MCP/Web 装配、无 config_authority 切换、无旧 runtime 表写入、无 supervisor 动作。
 * 历史版本表不提供任何 UPDATE/DELETE 接口；调用方只能追加版本。
 */
import { z } from "zod";
import { authorizeOrThrow, ForbiddenError, type Actor } from "../authz/authorize.ts";
import { ConflictError, InvalidArgumentError, InvalidReferenceError, NotFoundError } from "../db/errors.ts";
import type { DbDriver, DbTransaction } from "../db/driver.ts";
import { newId } from "../db/ids.ts";
import { canonicalJson, digestJson } from "../storage/maintenance/canonical.ts";
import {
  parseBindingOrdinaryContent,
  parseProfileContent,
  type BindingOrdinaryContent,
  type ProfileContent,
} from "./m2-config-values.ts";

export interface ProfileConfigAccess {
  readonly actor: Actor;
}

const operationSchema = z.enum(["profile.create", "profile.save", "binding.create", "binding.save"]);
export type ConfigOperation = z.infer<typeof operationSchema>;
const mutationIdSchema = z.string().min(1).max(128).refine(value => !/[\r\n\0]/.test(value));
const idSchema = z.string().min(1).max(512).refine(value => !/[\r\n\0]/.test(value));
const revisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export interface ProfileVersionView {
  readonly agentId: string;
  readonly revision: number;
  readonly contentDigest: string;
  readonly content: ProfileContent;
  readonly createdAt: string;
}

export interface BindingVersionView {
  readonly bindingId: string;
  readonly revision: number;
  readonly contentDigest: string;
  readonly content: BindingOrdinaryContent;
  readonly createdAt: string;
}

export interface CompatMappingView {
  readonly scope: "profile" | "binding";
  readonly subjectId: string;
  readonly revision: number;
  readonly compatRevision: number;
}

export interface MutationReceiptView {
  readonly mutationId: string;
  readonly operation: ConfigOperation;
  readonly actorScope: unknown;
  readonly targetScope: unknown;
  readonly commandDigest: string;
  readonly result: unknown;
  readonly auditId: string;
  readonly createdAt: string;
}

export interface MutationAuditView {
  readonly id: string;
  readonly mutationId: string;
  readonly actorKind: string;
  readonly actorId: string;
  readonly operation: ConfigOperation;
  readonly targetKind: string;
  readonly targetId: string;
  readonly commandDigest: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly createdAt: string;
}

type RowReader = { readonly query: DbTransaction["query"] };

type ProfileRow = {
  agent_id: string;
  revision: number;
  content_json: string;
  content_digest: string;
  created_at: string;
};
type BindingRow = {
  binding_id: string;
  revision: number;
  content_json: string;
  content_digest: string;
  created_at: string;
};
type CompatRow = { scope: "profile" | "binding"; subject_id: string; revision: number; compat_revision: number };
type ReceiptRow = {
  mutation_id: string;
  operation: ConfigOperation;
  actor_scope: string;
  target_scope: string;
  command_digest: string;
  result_json: string;
  audit_id: string;
  created_at: string;
};
type AuditRow = {
  id: string;
  mutation_id: string;
  actor_kind: string;
  actor_id: string;
  operation: ConfigOperation;
  target_kind: string;
  target_id: string;
  command_digest: string;
  before_json: string | null;
  after_json: string;
  created_at: string;
};

function requireWriter(access: ProfileConfigAccess): void {
  if (access.actor.kind !== "human" || access.actor.projectId !== null) {
    throw new ForbiddenError({ allowed: false, capability: "runtime:manage", code: "forbidden",
      reason: "仅本地 owner 可以写入 Agent 配置。" });
  }
  authorizeOrThrow(access.actor, "runtime:manage", {});
}

function parse<T>(schema: z.ZodType<T>, value: unknown, code: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new InvalidArgumentError(code);
  return result.data;
}

function profileView(row: ProfileRow): ProfileVersionView {
  return { agentId: row.agent_id, revision: Number(row.revision), contentDigest: row.content_digest,
    content: parseProfileContent(JSON.parse(row.content_json)), createdAt: row.created_at };
}

function bindingView(row: BindingRow): BindingVersionView {
  return { bindingId: row.binding_id, revision: Number(row.revision), contentDigest: row.content_digest,
    content: parseBindingOrdinaryContent(JSON.parse(row.content_json)), createdAt: row.created_at };
}

function receiptView(row: ReceiptRow): MutationReceiptView {
  return { mutationId: row.mutation_id, operation: operationSchema.parse(row.operation),
    actorScope: JSON.parse(row.actor_scope), targetScope: JSON.parse(row.target_scope),
    commandDigest: row.command_digest, result: JSON.parse(row.result_json), auditId: row.audit_id, createdAt: row.created_at };
}

function auditView(row: AuditRow): MutationAuditView {
  return { id: row.id, mutationId: row.mutation_id, actorKind: row.actor_kind, actorId: row.actor_id,
    operation: operationSchema.parse(row.operation), targetKind: row.target_kind, targetId: row.target_id,
    commandDigest: row.command_digest, before: row.before_json === null ? null : JSON.parse(row.before_json),
    after: JSON.parse(row.after_json), createdAt: row.created_at };
}

export function createProfileConfigService({ db, now = () => new Date() }: {
  readonly db: DbDriver;
  readonly now?: () => Date;
}) {
  async function nextCompat(tx: DbTransaction, scope: "profile" | "binding", subjectId: string, revision: number): Promise<number> {
    const rows = await tx.query<{ max_compat: number | null }>(
      "SELECT MAX(compat_revision) AS max_compat FROM config_compat_revisions WHERE scope = ? AND subject_id = ?",
      [scope, subjectId],
    );
    const compat = Number(rows[0]?.max_compat ?? 0) + 1;
    if (!Number.isSafeInteger(compat)) throw new ConflictError("config_compat_revision_exhausted");
    await tx.exec(`INSERT INTO config_compat_revisions (scope, subject_id, revision, compat_revision, created_at)
      VALUES (?, ?, ?, ?, ?)`, [scope, subjectId, revision, compat, now().toISOString()]);
    return compat;
  }

  async function writeReceipt(tx: DbTransaction, input: {
    readonly mutationId: string;
    readonly operation: ConfigOperation;
    readonly access: ProfileConfigAccess;
    readonly targetScope: unknown;
    readonly commandDigest: string;
    readonly before: unknown;
    readonly after: unknown;
    readonly result: unknown;
  }): Promise<void> {
    const auditId = newId();
    const at = now().toISOString();
    const ref = (input.result as { readonly saved: { readonly ref: Record<string, unknown> } }).saved.ref;
    const isProfile = input.operation.startsWith("profile");
    const fields = isProfile
      ? [ref["agentId"] ?? null, ref["profileRevision"] ?? null, ref["contentDigest"] ?? null, null, null, null]
      : [null, null, null, ref["groupBindingId"] ?? null, ref["bindingConfigRevision"] ?? null, ref["contentDigest"] ?? null];
    await tx.exec(`INSERT INTO config_mutation_receipts (mutation_id, actor_scope, operation, target_scope,
      command_digest, result_json, result_profile_agent_id, result_profile_revision, result_profile_digest,
      result_binding_id, result_binding_revision, result_binding_digest, audit_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      input.mutationId, canonicalJson({ actorId: input.access.actor.actorId, kind: input.access.actor.kind,
        projectId: input.access.actor.projectId }), input.operation, canonicalJson(input.targetScope), input.commandDigest,
      canonicalJson(input.result), ...fields, auditId, at,
    ]);
    await tx.exec(`INSERT INTO config_mutation_audit (id, mutation_id, actor_kind, actor_id, operation,
      target_kind, target_id, command_digest, before_json, after_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      auditId, input.mutationId, input.access.actor.kind, input.access.actor.actorId, input.operation,
      isProfile ? "profile" : "binding", isProfile ? String(ref["agentId"]) : String(ref["groupBindingId"]),
      input.commandDigest, input.before === null ? null : canonicalJson(input.before), canonicalJson(input.after), at,
    ]);
  }

  async function assertBindingScope(tx: DbTransaction, input: {
    readonly agentId: string;
    readonly projectId: string;
    readonly groupId: string;
    readonly memberId: string;
  }): Promise<void> {
    const profile = await tx.query("SELECT agent_id FROM agent_profiles WHERE agent_id = ?", [input.agentId]);
    const group = await tx.query("SELECT id FROM groups WHERE id = ? AND project_id = ?", [input.groupId, input.projectId]);
    const member = await tx.query("SELECT id FROM members WHERE id = ? AND project_id = ?", [input.memberId, input.projectId]);
    const participant = await tx.query("SELECT group_id FROM group_participants WHERE group_id = ? AND member_id = ?",
      [input.groupId, input.memberId]);
    if (profile.length === 0 || group.length === 0 || member.length === 0 || participant.length === 0)
      throw new InvalidReferenceError("binding_scope_invalid");
  }

  async function createProfile(access: ProfileConfigAccess, input: {
    readonly agentId: string;
    readonly content: unknown;
    readonly mutationId: string;
  }): Promise<ProfileVersionView> {
    requireWriter(access);
    const agentId = parse(idSchema, input.agentId, "profile_agent_id_invalid");
    const mutationId = parse(mutationIdSchema, input.mutationId, "mutation_id_invalid");
    let content: ProfileContent;
    try { content = parseProfileContent(input.content); } catch { throw new InvalidArgumentError("profile_content_invalid"); }
    const commandDigest = digestJson({ operation: "profile.create", agentId, content });
    return db.transaction(async tx => {
      const agent = await tx.query("SELECT id FROM agents WHERE id = ?", [agentId]);
      if (agent.length === 0) throw new NotFoundError("profile_agent_not_found");
      const head = await tx.query("SELECT agent_id FROM agent_profiles WHERE agent_id = ?", [agentId]);
      if (head.length > 0) throw new ConflictError("profile_already_exists");
      const digest = digestJson(content);
      const at = now().toISOString();
      await tx.exec(`INSERT INTO agent_profiles (agent_id, current_revision, legacy_runtime_id,
        compat_runtime_revision, created_at, updated_at) VALUES (?, 1, NULL, NULL, ?, ?)`, [agentId, at, at]);
      await tx.exec(`INSERT INTO agent_profile_versions (agent_id, revision, content_json, content_digest,
        default_role_id, default_role_revision, compat_runtime_revision, created_at)
        VALUES (?, 1, ?, ?, NULL, NULL, NULL, ?)`, [agentId, canonicalJson(content), digest, at]);
      await nextCompat(tx, "profile", agentId, 1);
      const ref = { agentId, profileRevision: 1, contentDigest: digest };
      await writeReceipt(tx, { mutationId, operation: "profile.create", access,
        targetScope: { kind: "agent", agentId }, commandDigest, before: null, after: { ref, digest },
        result: { kind: "profile", saved: { ref, mutationId, pendingApply: true, missing: [] } } });
      return (await requiredProfileVersion(tx, agentId, 1));
    });
  }

  async function saveProfile(access: ProfileConfigAccess, input: {
    readonly agentId: string;
    readonly expectedRevision: number;
    readonly content: unknown;
    readonly mutationId: string;
  }): Promise<ProfileVersionView> {
    requireWriter(access);
    const agentId = parse(idSchema, input.agentId, "profile_agent_id_invalid");
    const expected = parse(revisionSchema, input.expectedRevision, "profile_revision_invalid");
    const mutationId = parse(mutationIdSchema, input.mutationId, "mutation_id_invalid");
    let content: ProfileContent;
    try { content = parseProfileContent(input.content); } catch { throw new InvalidArgumentError("profile_content_invalid"); }
    const commandDigest = digestJson({ operation: "profile.save", agentId, expectedRevision: expected, content });
    return db.transaction(async tx => {
      const at = now().toISOString();
      const changed = await tx.exec(`UPDATE agent_profiles SET current_revision = current_revision + 1,
        updated_at = ? WHERE agent_id = ? AND current_revision = ?`, [at, agentId, expected]);
      if (changed === 0) {
        const head = await tx.query("SELECT current_revision FROM agent_profiles WHERE agent_id = ?", [agentId]);
        throw head.length === 0 ? new NotFoundError("profile_not_found") : new ConflictError("profile_revision_conflict");
      }
      const revision = expected + 1;
      const digest = digestJson(content);
      await tx.exec(`INSERT INTO agent_profile_versions (agent_id, revision, content_json, content_digest,
        default_role_id, default_role_revision, compat_runtime_revision, created_at)
        VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)`, [agentId, revision, canonicalJson(content), digest, at]);
      await nextCompat(tx, "profile", agentId, revision);
      const ref = { agentId, profileRevision: revision, contentDigest: digest };
      await writeReceipt(tx, { mutationId, operation: "profile.save", access,
        targetScope: { kind: "agent", agentId }, commandDigest, before: { agentId, revision: expected },
        after: { ref, digest }, result: { kind: "profile", saved: { ref, mutationId, pendingApply: true, missing: [] } } });
      return (await requiredProfileVersion(tx, agentId, revision));
    });
  }

  async function createBinding(access: ProfileConfigAccess, input: {
    readonly bindingId: string;
    readonly agentId: string;
    readonly projectId: string;
    readonly groupId: string;
    readonly memberId: string;
    readonly content: unknown;
    readonly mutationId: string;
  }): Promise<BindingVersionView> {
    requireWriter(access);
    const bindingId = parse(idSchema, input.bindingId, "binding_id_invalid");
    const agentId = parse(idSchema, input.agentId, "profile_agent_id_invalid");
    const projectId = parse(idSchema, input.projectId, "project_id_invalid");
    const groupId = parse(idSchema, input.groupId, "group_id_invalid");
    const memberId = parse(idSchema, input.memberId, "member_id_invalid");
    const mutationId = parse(mutationIdSchema, input.mutationId, "mutation_id_invalid");
    let content: BindingOrdinaryContent;
    try { content = parseBindingOrdinaryContent(input.content); } catch { throw new InvalidArgumentError("binding_content_invalid"); }
    const targetScope = { kind: "binding", groupBindingId: bindingId };
    const commandDigest = digestJson({ operation: "binding.create", bindingId, agentId, projectId, groupId, memberId, content });
    return db.transaction(async tx => {
      await assertBindingScope(tx, { agentId, projectId, groupId, memberId });
      const head = await tx.query("SELECT id FROM group_bindings WHERE id = ?", [bindingId]);
      if (head.length > 0) throw new ConflictError("binding_already_exists");
      const at = now().toISOString(), digest = digestJson(content);
      await tx.exec(`INSERT INTO group_bindings (id, project_id, group_id, member_id, agent_id,
        current_revision, original_legacy_binding_id, current_attachment_id, current_attachment_state,
        current_compat_binding_revision, retired_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      [bindingId, projectId, groupId, memberId, agentId, at, at]);
      await tx.exec(`INSERT INTO group_binding_config_versions (binding_id, revision, content_json,
        content_digest, role_id, role_revision, compat_execution_binding_id, compat_binding_revision, created_at)
        VALUES (?, 1, ?, ?, NULL, NULL, NULL, NULL, ?)`, [bindingId, canonicalJson(content), digest, at]);
      await nextCompat(tx, "binding", bindingId, 1);
      const ref = { groupBindingId: bindingId, bindingConfigRevision: 1, contentDigest: digest };
      await writeReceipt(tx, { mutationId, operation: "binding.create", access, targetScope, commandDigest, before: null,
        after: { ref, digest }, result: { kind: "binding", saved: { ref, mutationId, pendingApply: true, missing: [] } } });
      return (await requiredBindingVersion(tx, bindingId, 1));
    });
  }

  async function saveBinding(access: ProfileConfigAccess, input: {
    readonly bindingId: string;
    readonly expectedRevision: number;
    readonly content: unknown;
    readonly mutationId: string;
  }): Promise<BindingVersionView> {
    requireWriter(access);
    const bindingId = parse(idSchema, input.bindingId, "binding_id_invalid");
    const expected = parse(revisionSchema, input.expectedRevision, "binding_revision_invalid");
    const mutationId = parse(mutationIdSchema, input.mutationId, "mutation_id_invalid");
    let content: BindingOrdinaryContent;
    try { content = parseBindingOrdinaryContent(input.content); } catch { throw new InvalidArgumentError("binding_content_invalid"); }
    const targetScope = { kind: "binding", groupBindingId: bindingId };
    const commandDigest = digestJson({ operation: "binding.save", bindingId, expectedRevision: expected, content });
    return db.transaction(async tx => {
      const at = now().toISOString();
      const changed = await tx.exec(`UPDATE group_bindings SET current_revision = current_revision + 1,
        updated_at = ? WHERE id = ? AND current_revision = ?`, [at, bindingId, expected]);
      if (changed === 0) {
        const head = await tx.query("SELECT current_revision FROM group_bindings WHERE id = ?", [bindingId]);
        throw head.length === 0 ? new NotFoundError("binding_not_found") : new ConflictError("binding_revision_conflict");
      }
      const revision = expected + 1, digest = digestJson(content);
      await tx.exec(`INSERT INTO group_binding_config_versions (binding_id, revision, content_json,
        content_digest, role_id, role_revision, compat_execution_binding_id, compat_binding_revision, created_at)
        VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)`, [bindingId, revision, canonicalJson(content), digest, at]);
      await nextCompat(tx, "binding", bindingId, revision);
      const ref = { groupBindingId: bindingId, bindingConfigRevision: revision, contentDigest: digest };
      await writeReceipt(tx, { mutationId, operation: "binding.save", access, targetScope, commandDigest,
        before: { bindingId, revision: expected }, after: { ref, digest },
        result: { kind: "binding", saved: { ref, mutationId, pendingApply: true, missing: [] } } });
      return (await requiredBindingVersion(tx, bindingId, revision));
    });
  }

  async function profileVersion(reader: RowReader, agentId: string, revision: number): Promise<ProfileRow | null> {
    const rows = await reader.query<ProfileRow>(`SELECT agent_id, revision, content_json, content_digest, created_at
      FROM agent_profile_versions WHERE agent_id = ? AND revision = ?`, [agentId, revision]);
    return rows[0] ?? null;
  }

  async function bindingVersion(reader: RowReader, bindingId: string, revision: number): Promise<BindingRow | null> {
    const rows = await reader.query<BindingRow>(`SELECT binding_id, revision, content_json, content_digest, created_at
      FROM group_binding_config_versions WHERE binding_id = ? AND revision = ?`, [bindingId, revision]);
    return rows[0] ?? null;
  }

  async function getProfileVersion(agentId: string, revision: number): Promise<ProfileVersionView | null> {
    const row = await profileVersion(db, agentId, revision);
    return row === null ? null : profileView(row);
  }

  async function getBindingVersion(bindingId: string, revision: number): Promise<BindingVersionView | null> {
    const row = await bindingVersion(db, bindingId, revision);
    return row === null ? null : bindingView(row);
  }

  async function requiredProfileVersion(reader: RowReader, agentId: string, revision: number): Promise<ProfileVersionView> {
    const row = await profileVersion(reader, agentId, revision);
    const view = row === null ? null : profileView(row);
    if (view === null) throw new NotFoundError("profile_version_not_found");
    return view;
  }

  async function requiredBindingVersion(reader: RowReader, bindingId: string, revision: number): Promise<BindingVersionView> {
    const row = await bindingVersion(reader, bindingId, revision);
    const view = row === null ? null : bindingView(row);
    if (view === null) throw new NotFoundError("binding_version_not_found");
    return view;
  }

  async function getProfile(agentId: string): Promise<ProfileVersionView | null> {
    const rows = await db.query<ProfileRow>(`SELECT v.agent_id, v.revision, v.content_json, v.content_digest, v.created_at
      FROM agent_profiles h JOIN agent_profile_versions v
        ON v.agent_id = h.agent_id AND v.revision = h.current_revision WHERE h.agent_id = ?`, [agentId]);
    return rows[0] === undefined ? null : profileView(rows[0]!);
  }

  async function getBinding(bindingId: string): Promise<BindingVersionView | null> {
    const rows = await db.query<BindingRow>(`SELECT v.binding_id, v.revision, v.content_json, v.content_digest, v.created_at
      FROM group_bindings h JOIN group_binding_config_versions v
        ON v.binding_id = h.id AND v.revision = h.current_revision WHERE h.id = ?`, [bindingId]);
    return rows[0] === undefined ? null : bindingView(rows[0]!);
  }

  async function listProfileVersions(agentId: string): Promise<readonly ProfileVersionView[]> {
    const rows = await db.query<ProfileRow>(`SELECT agent_id, revision, content_json, content_digest, created_at
      FROM agent_profile_versions WHERE agent_id = ? ORDER BY revision`, [agentId]);
    return rows.map(profileView);
  }

  async function listBindingVersions(bindingId: string): Promise<readonly BindingVersionView[]> {
    const rows = await db.query<BindingRow>(`SELECT binding_id, revision, content_json, content_digest, created_at
      FROM group_binding_config_versions WHERE binding_id = ? ORDER BY revision`, [bindingId]);
    return rows.map(bindingView);
  }

  async function listCompatMappings(scope: "profile" | "binding", subjectId: string): Promise<readonly CompatMappingView[]> {
    const rows = await db.query<CompatRow>(`SELECT scope, subject_id, revision, compat_revision
      FROM config_compat_revisions WHERE scope = ? AND subject_id = ? ORDER BY revision`, [scope, subjectId]);
    return rows.map(row => ({ scope: row.scope, subjectId: row.subject_id, revision: Number(row.revision),
      compatRevision: Number(row.compat_revision) }));
  }

  async function getReceipt(mutationId: string): Promise<MutationReceiptView | null> {
    const rows = await db.query<ReceiptRow>("SELECT * FROM config_mutation_receipts WHERE mutation_id = ?", [mutationId]);
    return rows[0] === undefined ? null : receiptView(rows[0]!);
  }

  async function getAudit(auditId: string): Promise<MutationAuditView | null> {
    const rows = await db.query<AuditRow>("SELECT * FROM config_mutation_audit WHERE id = ?", [auditId]);
    return rows[0] === undefined ? null : auditView(rows[0]!);
  }

  return {
    createProfile,
    saveProfile,
    createBinding,
    saveBinding,
    getProfile,
    getProfileVersion,
    getBinding,
    getBindingVersion,
    listProfileVersions,
    listBindingVersions,
    listCompatMappings,
    getReceipt,
    getAudit,
  };
}

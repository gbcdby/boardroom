import { assertReviewTransaction } from "../decisions/locked-transaction.ts";
import type { ReviewLockedTransaction } from "../decisions/types.ts";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { RepositorySet } from "../db/repositories.ts";
import { authorizeOrThrow, ForbiddenError, type Actor } from "../authz/authorize.ts";
import { appendAuditEntry, auditActorFrom } from "../audit.ts";
import { projectActive } from "../org/boundary.ts";
import type { EffectivePolicyConfiguration, GlobalPolicyDocument, PersistedPolicyDocument, PolicyCombinationConflict,
  PolicyConfigurationPreview, PolicyDocument, PolicyVersionMetadata, ProjectPolicyDocument } from "../../shared/policy.ts";
import { canonicalJson } from "./canonical.ts";
import { createDefaultPolicy, DEFAULT_POLICY_REVISION } from "./defaults.ts";
import { PolicyInputError, policyDocumentsSchema, policyActionSchema } from "./schemas.ts";
import { composePolicyRules } from "./rules.ts";
import { previewPolicy } from "./evaluator.ts";
import { PolicyConfigurationError } from "./configuration-errors.ts";

export interface PolicyConfigurationAccess { readonly actor: Actor }
type PolicyVersionRow = {
  scope: "user" | "project"; project_id: string | null; revision: number; schema_version: number;
  document_json: string; content_digest: string; based_on_global_revision: number | null; default_revision: number;
  created_by_kind: "human" | "system"; created_by_id: string; created_at: string;
};
const hashDocument = (json: string) => createHash("sha256").update(`boardroom.policy-document.v1\n${json}`).digest("hex");
const keyOf = (projectId: string | null) => projectId === null ? "user" : `project:${projectId}`;
const revisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1);
export const globalPolicyFieldsSchema = policyDocumentsSchema.shape.global.pick({ rules: true });
export const projectPolicyFieldsSchema = policyDocumentsSchema.shape.project.unwrap().pick({ rules: true, overrides: true });
export const globalPolicyUpdateSchema = globalPolicyFieldsSchema.extend({ expectedRevision: revisionSchema }).strict();
export const projectPolicyUpdateSchema = projectPolicyFieldsSchema.extend({ expectedRevision: revisionSchema.nullable(), expectedGlobalRevision: revisionSchema }).strict();
const versionListSchema = z.object({ limit: z.number().int().min(1).max(100).default(50), beforeRevision: revisionSchema.optional() }).strict();
const previewSchema = z.object({ draft: z.unknown().optional(), action: policyActionSchema.optional(), stage: z.enum(["proposal", "execution"]).optional() }).strict()
  .superRefine((value, ctx) => {
    if ((value.action === undefined) !== (value.stage === undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["stage"], message: "动作和阶段必须同时提供" });
  });

export function parsePolicyConfigurationInput<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.output<S> {
  const result = schema.safeParse(raw);
  if (!result.success) throw new PolicyConfigurationError("policy_input_invalid", 400, { fields: result.error.issues.flatMap(issue =>
    issue.code === "unrecognized_keys" ? issue.keys.map(key => [...issue.path, key].join(".")) : [issue.path.join(".") || "input"]) });
  return result.data;
}
function compose(global: GlobalPolicyDocument, project?: ProjectPolicyDocument) {
  try { return composePolicyRules({ global, ...(project === undefined ? {} : { project }) }); }
  catch (error) {
    if (error instanceof PolicyInputError) throw new PolicyConfigurationError("policy_input_invalid", 400, { fields: error.fields });
    throw error;
  }
}

export function requirePolicyUser(access: PolicyConfigurationAccess, projectId: string | null): void {
  if (access.actor.kind !== "human" || projectId === null && access.actor.projectId !== null) {
    throw new ForbiddenError({ allowed: false, capability: "runtime:manage", code: "forbidden", reason: "策略配置只接受可信本地用户管理。" });
  }
  authorizeOrThrow(access.actor, "runtime:manage", projectId === null ? {} : { projectId });
}

function fromRow(row: PolicyVersionRow): PersistedPolicyDocument {
  let parsed: unknown;
  try { parsed = JSON.parse(row.document_json); } catch { throw new PolicyConfigurationError("policy_storage_invalid", 500); }
  const result = row.scope === "user" ? policyDocumentsSchema.shape.global.safeParse(parsed)
    : policyDocumentsSchema.shape.project.unwrap().safeParse(parsed);
  if (!result.success || result.data.revision !== Number(row.revision) || result.data.scope !== row.scope
    || result.data.schemaVersion !== Number(row.schema_version)
    || (result.data.scope === "project" ? result.data.projectId : null) !== row.project_id
    || canonicalJson(result.data) !== row.document_json || hashDocument(row.document_json) !== row.content_digest) {
    throw new PolicyConfigurationError("policy_storage_invalid", 500);
  }
  return { document: result.data, ref: { scope: row.scope, projectId: row.project_id, revision: Number(row.revision), contentDigest: row.content_digest },
    defaultRevision: Number(row.default_revision), basedOnGlobalRevision: row.based_on_global_revision === null ? null : Number(row.based_on_global_revision),
    createdBy: { kind: row.created_by_kind, id: row.created_by_id }, createdAt: row.created_at };
}
async function current(repos: RepositorySet, projectId: string | null): Promise<PersistedPolicyDocument | null> {
  const row = await repos.context.one<PolicyVersionRow>(`SELECT d.scope, d.project_id, v.* FROM policy_documents d
    LEFT JOIN policy_document_versions v ON v.document_id = d.scope_key AND v.revision = d.revision WHERE d.scope_key = ?`, [keyOf(projectId)]);
  return row ? fromRow(row) : null;
}
async function requiredGlobal(repos: RepositorySet): Promise<PersistedPolicyDocument<GlobalPolicyDocument>> {
  const saved = await current(repos, null);
  if (!saved) throw new PolicyConfigurationError("policy_not_initialized", 409);
  return saved as PersistedPolicyDocument<GlobalPolicyDocument>;
}
async function appendVersion(repos: RepositorySet, document: PolicyDocument, basedOnGlobalRevision: number | null,
  createdBy: { kind: "human" | "system"; id: string }, at: string): Promise<PersistedPolicyDocument> {
  const json = canonicalJson(document), contentDigest = hashDocument(json);
  await repos.context.exec(`INSERT INTO policy_document_versions (document_id, revision, schema_version, document_json,
    content_digest, based_on_global_revision, default_revision, created_by_kind, created_by_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [keyOf(document.scope === "project" ? document.projectId : null), document.revision,
    document.schemaVersion, json, contentDigest, basedOnGlobalRevision, DEFAULT_POLICY_REVISION, createdBy.kind, createdBy.id, at]);
  return { document, ref: { scope: document.scope, projectId: document.scope === "project" ? document.projectId : null,
    revision: document.revision, contentDigest }, defaultRevision: DEFAULT_POLICY_REVISION, basedOnGlobalRevision, createdBy, createdAt: at };
}

function metadata(version: PersistedPolicyDocument): PolicyVersionMetadata {
  const { document: _document, ...result } = version; return result;
}

/** 仅由完成环境校验和迁移的可信启动调用；GET 不会调用此初始化，也不会重建缺失历史。 */
export async function initializePolicyConfiguration(repos: RepositorySet, now: () => Date = () => new Date()): Promise<PersistedPolicyDocument<GlobalPolicyDocument>> {
  return repos.transaction(async () => {
    const at = now().toISOString();
    const inserted = await repos.context.exec(`INSERT INTO policy_documents (scope_key, scope, project_id, revision, created_at, updated_at)
      VALUES ('user', 'user', NULL, 1, ?, ?) ON CONFLICT (scope_key) DO NOTHING`, [at, at]);
    if (inserted === 0) return requiredGlobal(repos);
    const saved = await appendVersion(repos, createDefaultPolicy(1), null, { kind: "system", id: "policy-bootstrap" }, at);
    await appendAuditEntry(repos.audit, { scope: "user", projectId: null, actor: { kind: "system", name: "policy-bootstrap", memberId: null },
      action: "policy.initialize", targetKind: "policy_document", targetId: "user", targetName: "全局策略",
      before: null, after: saved.ref, detail: { defaultRevision: DEFAULT_POLICY_REVISION, operation: "policy_configuration_only" } });
    return saved as PersistedPolicyDocument<GlobalPolicyDocument>;
  });
}

export async function assertPolicyConfigurationInitialized(repos:RepositorySet):Promise<void> { await requiredGlobal(repos); }
async function readEffectivePolicy(repos:RepositorySet,projectId:string|null):Promise<EffectivePolicyConfiguration> {
    // 一个查询的快照包含两份 head，避免全局/项目同时更新时拼成不可存在的组合。
    const rows = await repos.context.query<PolicyVersionRow>(`SELECT d.scope, d.project_id, v.* FROM policy_documents d
      LEFT JOIN policy_document_versions v ON v.document_id = d.scope_key AND v.revision = d.revision
      WHERE d.scope_key IN ('user', ?)`, [keyOf(projectId)]);
    const saved = rows.map(fromRow), global = saved.find(version => version.document.scope === "user") as PersistedPolicyDocument<GlobalPolicyDocument> | undefined;
    if (!global) throw new PolicyConfigurationError("policy_not_initialized", 409);
    const project = (saved.find(version => version.document.scope === "project") ?? null) as PersistedPolicyDocument<ProjectPolicyDocument> | null;
    return { ...compose(global.document, project?.document), global, project, defaultRevision: global.defaultRevision,
      policyRevision: createHash("sha256").update(JSON.stringify([global.ref.contentDigest, project?.ref.contentDigest ?? null, global.defaultRevision])).digest("hex"),
      mode: "observation", executionAdmission: "not-issued" };
}
export async function readLockedReviewPolicy(guard:ReviewLockedTransaction):Promise<EffectivePolicyConfiguration> {
  const state=assertReviewTransaction(guard);
  const value=await readEffectivePolicy(state.repos,state.slot.projectId);
  assertReviewTransaction(guard); return value;
}

export function createPolicyConfiguration({ repos, now = () => new Date() }: { repos: RepositorySet; now?: () => Date }) {
  async function requireProject(projectId: string) {
    if (typeof projectId !== "string" || !projectId || projectId.trim() !== projectId || projectId.length > 200 || /[\r\n\0]/.test(projectId)) {
      throw new PolicyConfigurationError("policy_input_invalid", 400, { fields: ["projectId"] });
    }
    const project = await repos.projects.get(projectId);
    if (!project) throw new PolicyConfigurationError("policy_project_not_found", 404);
    return project;
  }
  async function lockGlobal() {
    if (await repos.context.exec("UPDATE policy_documents SET updated_at = updated_at WHERE scope_key = 'user'") !== 1) {
      throw new PolicyConfigurationError("policy_not_initialized", 409);
    }
    return requiredGlobal(repos);
  }
  async function getVersion(access: PolicyConfigurationAccess, projectId: string | null, revision: number) {
    requirePolicyUser(access, projectId); parsePolicyConfigurationInput(revisionSchema, revision);
    if (projectId !== null) await requireProject(projectId);
    const row = await repos.context.one<PolicyVersionRow>(`SELECT d.scope, d.project_id, v.* FROM policy_documents d
      JOIN policy_document_versions v ON v.document_id = d.scope_key WHERE d.scope_key = ? AND v.revision = ?`, [keyOf(projectId), revision]);
    if (!row) throw new PolicyConfigurationError("policy_version_not_found", 404);
    return fromRow(row);
  }
  async function listVersions(access: PolicyConfigurationAccess, projectId: string | null, raw: unknown = {}) {
    requirePolicyUser(access, projectId); if (projectId !== null) await requireProject(projectId);
    if (projectId !== null) await requiredGlobal(repos);
    const value = parsePolicyConfigurationInput(versionListSchema, raw);
    // 同一 SELECT 取得当前头与历史，不能给出跨两次读取拼接的当前引用。
    const rows = await repos.context.query<PolicyVersionRow & { head_revision: number; head_digest: string }>(`SELECT d.scope, d.project_id,
      v.*, d.revision AS head_revision, h.content_digest AS head_digest FROM policy_documents d
      JOIN policy_document_versions h ON h.document_id = d.scope_key AND h.revision = d.revision
      JOIN policy_document_versions v ON v.document_id = d.scope_key WHERE d.scope_key = ?
      ${value.beforeRevision === undefined ? "" : "AND v.revision < ?"} ORDER BY v.revision DESC LIMIT ?`,
    [keyOf(projectId), ...(value.beforeRevision === undefined ? [] : [value.beforeRevision]), value.limit]);
    // beforeRevision 可使结果为空；current 独立读取只作最新提示，不赋予历史对象授权。
    const head = rows[0] ? { scope: rows[0].scope, projectId: rows[0].project_id, revision: Number(rows[0].head_revision), contentDigest: rows[0].head_digest }
      : (await current(repos, projectId))?.ref ?? null;
    if (projectId === null && head === null) throw new PolicyConfigurationError("policy_not_initialized", 409);
    return { current: head, versions: rows.map(row => metadata(fromRow(row))) };
  }
  async function getEffective(access: PolicyConfigurationAccess, projectId: string | null = null): Promise<EffectivePolicyConfiguration> {
    requirePolicyUser(access, projectId); if (projectId !== null) await requireProject(projectId);
    return readEffectivePolicy(repos,projectId);
  }
  async function audit(access: PolicyConfigurationAccess, projectId: string | null, before: PersistedPolicyDocument | null, after: PersistedPolicyDocument) {
    // 审计只保存不可变版本引用，完整规则在版本表，不受既有审计正文截断影响。
    const entry = { actor: auditActorFrom(access.actor), action: "policy.update",
      targetKind: "policy_document" as const, targetId: keyOf(projectId), targetName: projectId === null ? "全局策略" : "项目策略",
      before: before?.ref ?? null, after: after.ref, detail: { basedOnGlobalRevision: after.basedOnGlobalRevision,
        defaultRevision: after.defaultRevision, operation: "policy_configuration_only" } };
    if (projectId === null) await appendAuditEntry(repos.audit, { ...entry, scope: "user", projectId: null });
    else await appendAuditEntry(repos.audit, { ...entry, scope: "project", projectId });
  }
  async function updateGlobal(access: PolicyConfigurationAccess, raw: unknown): Promise<PersistedPolicyDocument<GlobalPolicyDocument>> {
    requirePolicyUser(access, null); const value = parsePolicyConfigurationInput(globalPolicyUpdateSchema, raw);
    const document: GlobalPolicyDocument = { schemaVersion: 1, scope: "user", revision: value.expectedRevision + 1, rules: value.rules };
    compose(document);
    return repos.transaction(async () => {
      // 全局更新不再向下取得 project 锁；项目写入按 project → global 排序。
      const before = await lockGlobal();
      if (before.document.revision !== value.expectedRevision) throw new PolicyConfigurationError("policy_revision_conflict", 409, { current: before.ref });
      const projects = await repos.context.query<PolicyVersionRow>(`SELECT d.scope, d.project_id, v.* FROM policy_documents d
        LEFT JOIN policy_document_versions v ON v.document_id = d.scope_key AND v.revision = d.revision
        WHERE d.scope = 'project' ORDER BY d.project_id`);
      const conflicts: PolicyCombinationConflict[] = [];
      for (const row of projects) {
        const project = fromRow(row) as PersistedPolicyDocument<ProjectPolicyDocument>;
        try { compose(document, project.document); }
        catch (error) {
          if (!(error instanceof PolicyConfigurationError) || error.reason !== "policy_input_invalid") throw error;
          conflicts.push({ projectId: project.document.projectId, projectRevision: project.document.revision,
            fields: error.fields, repairEndpoint: `/api/projects/${encodeURIComponent(project.document.projectId)}/policy` });
        }
      }
      if (conflicts.length) throw new PolicyConfigurationError("policy_project_conflict", 409, { current: before.ref, conflicts });
      const at = now().toISOString();
      if (await repos.context.exec("UPDATE policy_documents SET revision = ?, updated_at = ? WHERE scope_key = 'user' AND revision = ?",
        [document.revision, at, value.expectedRevision]) !== 1) throw new PolicyConfigurationError("policy_revision_conflict", 409, { current: before.ref });
      const after = await appendVersion(repos, document, null, { kind: "human", id: access.actor.actorId }, at);
      await audit(access, null, before, after); return after as PersistedPolicyDocument<GlobalPolicyDocument>;
    });
  }
  async function updateProject(access: PolicyConfigurationAccess, projectId: string, raw: unknown): Promise<PersistedPolicyDocument<ProjectPolicyDocument>> {
    requirePolicyUser(access, projectId); await requireProject(projectId);
    const value = parsePolicyConfigurationInput(projectPolicyUpdateSchema, raw);
    const document: ProjectPolicyDocument = { schemaVersion: 1, scope: "project", projectId,
      revision: (value.expectedRevision ?? 0) + 1, rules: value.rules, overrides: value.overrides };
    return repos.transaction(() => repos.mutations.run({ projectIds: [projectId], discover: async () => ({ memberIds: [], groupIds: [], runtimeIds: [] }) }, async () => {
      requirePolicyUser(access, projectId); await projectActive(repos, projectId);
      const global = await lockGlobal();
      if (global.document.revision !== value.expectedGlobalRevision) throw new PolicyConfigurationError("policy_global_revision_conflict", 409, { current: global.ref });
      const before = await current(repos, projectId);
      if ((before?.document.revision ?? null) !== value.expectedRevision) throw new PolicyConfigurationError("policy_revision_conflict", 409, { current: before?.ref ?? null });
      compose(global.document, document);
      const at = now().toISOString();
      if (!before) {
        await repos.context.exec(`INSERT INTO policy_documents (scope_key, scope, project_id, revision, created_at, updated_at)
          VALUES (?, 'project', ?, 1, ?, ?)`, [keyOf(projectId), projectId, at, at]);
      } else if (await repos.context.exec("UPDATE policy_documents SET revision = ?, updated_at = ? WHERE scope_key = ? AND revision = ?",
        [document.revision, at, keyOf(projectId), value.expectedRevision]) !== 1) throw new PolicyConfigurationError("policy_revision_conflict", 409, { current: before.ref });
      const after = await appendVersion(repos, document, global.document.revision, { kind: "human", id: access.actor.actorId }, at);
      await audit(access, projectId, before, after); return after as PersistedPolicyDocument<ProjectPolicyDocument>;
    }));
  }
  async function preview(access: PolicyConfigurationAccess, projectId: string | null, raw: unknown): Promise<PolicyConfigurationPreview> {
    requirePolicyUser(access, projectId);
    const value = parsePolicyConfigurationInput(previewSchema, raw);
    const effective = await getEffective(access, projectId);
    if (value.action !== undefined && value.action.projectId !== projectId) {
      throw new PolicyConfigurationError("policy_action_scope_mismatch", 400, { fields: ["action.projectId"] });
    }
    let global = effective.global.document, project = effective.project?.document ?? null;
    if (value.draft !== undefined) {
      if (projectId === null) global = { schemaVersion: 1, scope: "user", revision: global.revision + 1,
        ...parsePolicyConfigurationInput(globalPolicyFieldsSchema, value.draft) };
      else project = { schemaVersion: 1, scope: "project", projectId, revision: (project?.revision ?? 0) + 1,
        ...parsePolicyConfigurationInput(projectPolicyFieldsSchema, value.draft) };
    }
    const candidate = { ...compose(global, project ?? undefined), global, project };
    // 本票没有可信 handler/fact 适配器；空注册表和空事实由服务器构造，不把 HTTP 字段转为可信事实。
    const observation = value.action === undefined ? null : previewPolicy({ action: value.action, stage: value.stage!,
      policies: { global, ...(project === null ? {} : { project }) }, context: { evaluatedAt: now().toISOString(),
        policyRevision: value.draft === undefined ? effective.policyRevision : `draft:${hashDocument(canonicalJson({ global, project }))}`,
        registry: { revision: 1, handlers: [] }, facts: {} } });
    return { kind: "policy-configuration-preview", source: value.draft === undefined ? "current" : "draft", mode: "observation",
      executionAdmission: "not-issued", sideEffects: "none", base: { global: effective.global.ref, project: effective.project?.ref ?? null,
        policyRevision: effective.policyRevision }, candidate,
      action: observation === null ? null : { availability: "unavailable", reason: "trusted_adapter_unavailable", preview: observation } };
  }
  return {
    async getGlobal(access: PolicyConfigurationAccess) { requirePolicyUser(access, null); return requiredGlobal(repos); },
    async getProject(access: PolicyConfigurationAccess, projectId: string) {
      return (await getEffective(access, projectId)).project;
    },
    getGlobalVersion: (access: PolicyConfigurationAccess, revision: number) => getVersion(access, null, revision) as Promise<PersistedPolicyDocument<GlobalPolicyDocument>>,
    getProjectVersion: (access: PolicyConfigurationAccess, projectId: string, revision: number) => getVersion(access, projectId, revision) as Promise<PersistedPolicyDocument<ProjectPolicyDocument>>,
    listGlobalVersions: (access: PolicyConfigurationAccess, input?: unknown) => listVersions(access, null, input),
    listProjectVersions: (access: PolicyConfigurationAccess, projectId: string, input?: unknown) => listVersions(access, projectId, input),
    updateGlobal, updateProject, getEffective, preview,
  };
}

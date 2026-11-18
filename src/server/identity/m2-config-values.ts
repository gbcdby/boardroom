/**
 * #153-E1：M2 R3 的内部值合同。只解析值，不查询引用对象、发放持久 ID 或验证当前许可。
 * 未装配配置 writer/迁移入口；普通内容校验不代表可保存或运行，raw 来源不代表 S4 proof。
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { RUNTIME_CONFIG_VERSION, snapshotRuntimeConfig } from "../runtime/config.ts";
import type { LegacyConfigSnapshotRef } from "../../shared/legacy-config.ts";

type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
type DefinedProperties<T> = { [K in keyof T]: Exclude<T[K], undefined> };
const revision = z.number().int().positive().safe();
const id = z.string().min(1);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const backend = z.enum(["claude-code", "codex-cli", "dsh"]);
const permissionMode = z.enum(["auto", "manual", "workspace-write"]);
const tools = z.array(z.string()).nullable();
const roleRef = z.object({ roleTemplateId: id, revision }).strict();
const emptySelection = z.tuple([]);
const revisions = z.object({ runtimeRevision: revision, bindingRevision: revision }).strict();
const profileSchema = z.object({
  preferredHost: backend.nullable(), model: z.string().nullable(), instructions: z.string(), defaultRoleRef: roleRef.nullable(),
  skillSelection: emptySelection, toolSelection: emptySelection, memorySelection: emptySelection,
  maxConcurrentInstances: revision,
  legacyCompatibility: z.object({ tools, permissionMode }).strict().nullable(),
}).strict();
const overridesSchema = z.object({
  model: z.string().nullable().optional(), instructions: z.string().optional(), skillSelection: emptySelection.optional(),
  toolSelection: emptySelection.optional(), memorySelection: emptySelection.optional(), legacyTools: tools.optional(),
  legacyPermissionMode: permissionMode.optional(),
}).strict().superRefine((value, ctx) => {
  for (const [key, field] of Object.entries(value)) if (field === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "m2_value_undefined" });
  }
});
const bindingSchema = z.object({ roleRef: roleRef.nullable(), profileOverrides: overridesSchema }).strict();

export type ProfileContent = Immutable<z.infer<typeof profileSchema>>;
export type BindingOrdinaryContent = Immutable<{
  roleRef: z.infer<typeof roleRef> | null;
  profileOverrides: DefinedProperties<z.infer<typeof overridesSchema>>;
}>;

// Zod 已创建独立的纯数据对象；冻结该副本，不冻结调用者的输入。
function immutable<T>(value: T): Immutable<T> {
  if (value !== null && typeof value === "object") {
    for (const field of Object.values(value)) immutable(field);
    Object.freeze(value);
  }
  return value as Immutable<T>;
}

export function parseProfileContent(value: unknown): ProfileContent {
  // 既定值结构校验不替代管理入口的 normalization、角色存在性、权限或宿主能力检查。
  return immutable(profileSchema.parse(value));
}

export function parseBindingOrdinaryContent(value: unknown): BindingOrdinaryContent {
  // 上面的显式 undefined 拒绝保持“未设置”与 null 的区别，不补默认覆盖。
  return immutable(bindingSchema.parse(value)) as BindingOrdinaryContent;
}

const legacyRefSchema = z.object({
  authority: z.literal("legacy"), kind: z.enum(["requestedSnapshot", "applied", "effective"]),
  sourceId: id, runtimeId: id, bindingId: id, agentId: id, digest, versions: revisions,
  configVersion: z.literal(RUNTIME_CONFIG_VERSION),
}).strict().superRefine((value, ctx) => {
  if (value.sourceId !== value.bindingId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceId"], message: "legacy_source_binding_mismatch" });
});

export function parseLegacyConfigSnapshotRef(value: unknown): LegacyConfigSnapshotRef {
  return immutable(legacyRefSchema.parse(value));
}

const runtimeConfigSchema = z.object({ model: z.string().nullable(), workdir: z.string().min(1), tools,
  systemPrompt: z.string(), permissionMode }).strict();
const snapshotSchema = z.object({ backend, config: runtimeConfigSchema, versions: revisions,
  advancedStrategy: z.literal("bypassPermissions").nullable(), digest }).strict();
// inspector 的 effective 值带原 resolver 的字段来源；保留这份已存在的只读观察。
const fieldSource = z.enum(["default", "override"]);
const effectiveSnapshotSchema = snapshotSchema.extend({ sources: z.object({ model: fieldSource, workdir: fieldSource,
  tools: fieldSource, systemPrompt: fieldSource, permissionMode: fieldSource }).strict() });
const advancedSchema = z.object({ strategy: z.literal("bypassPermissions"), runtimeRevision: revision, bindingRevision: revision }).strict();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const sourceSchema = z.object({
  ref: legacyRefSchema, snapshot: z.union([snapshotSchema, effectiveSnapshotSchema]),
  rawJson: z.string().nullable(), rawDigest: digest.nullable(),
  rawAdvancedJson: z.string().nullable(), rawAdvancedDigest: digest.nullable(),
}).strict().superRefine((value, ctx) => {
  const fail = (field: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
  const { ref, snapshot } = value;
  if (ref.kind !== "effective" && "sources" in snapshot) fail("snapshot", "legacy_stored_snapshot_has_resolver_sources");
  const normalized = snapshotRuntimeConfig(snapshot.backend, snapshot.config, snapshot.versions, snapshot.advancedStrategy);
  if (normalized.digest !== snapshot.digest) fail("snapshot", "legacy_semantic_digest_mismatch");
  if (snapshot.advancedStrategy !== null && snapshot.backend !== "claude-code") fail("snapshot", "legacy_advanced_backend_mismatch");
  if (ref.digest !== snapshot.digest) fail("ref", "legacy_snapshot_ref_digest_mismatch");
  if (ref.versions.runtimeRevision !== snapshot.versions.runtimeRevision || ref.versions.bindingRevision !== snapshot.versions.bindingRevision) {
    fail("ref", "legacy_snapshot_ref_revision_mismatch");
  }
  if ((ref.kind === "effective") !== (value.rawJson === null)) fail("rawJson", "legacy_raw_snapshot_kind_mismatch");
  if (value.rawJson === null) {
    if (value.rawDigest !== null) fail("rawDigest", "legacy_raw_digest_without_bytes");
  } else {
    if (hash(value.rawJson) !== value.rawDigest) fail("rawDigest", "legacy_raw_digest_mismatch");
    try {
      const raw = snapshotSchema.safeParse(JSON.parse(value.rawJson));
      if (!raw.success || raw.data.digest !== snapshot.digest || JSON.stringify(snapshotRuntimeConfig(raw.data.backend,
        raw.data.config, raw.data.versions, raw.data.advancedStrategy)) !== JSON.stringify(normalized)) {
        fail("rawJson", "legacy_raw_snapshot_mismatch");
      }
    } catch { fail("rawJson", "legacy_raw_snapshot_invalid"); }
  }
  if (value.rawAdvancedJson === null) {
    if (value.rawAdvancedDigest !== null) fail("rawAdvancedDigest", "legacy_raw_advanced_digest_without_bytes");
  } else {
    if (hash(value.rawAdvancedJson) !== value.rawAdvancedDigest) fail("rawAdvancedDigest", "legacy_raw_advanced_digest_mismatch");
    try {
      if (!advancedSchema.safeParse(JSON.parse(value.rawAdvancedJson)).success) fail("rawAdvancedJson", "legacy_raw_advanced_invalid");
    } catch { fail("rawAdvancedJson", "legacy_raw_advanced_invalid"); }
  }
  // 原 current advanced 与冻结的 requested/applied 是独立事实；这里不判等价或使其重新有效。
});

/** 内存中的旧来源值；不含尚未持久化的 CaptureRef、ProfileRef 或新的 ConfigSnapshotRef。 */
export type LegacySourceValue = Immutable<z.infer<typeof sourceSchema>>;

export function parseLegacySourceValue(value: unknown): LegacySourceValue {
  return immutable(sourceSchema.parse(value));
}

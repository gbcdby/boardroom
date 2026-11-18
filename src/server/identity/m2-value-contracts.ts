import type { ProfileContent, BindingOrdinaryContent } from "./m2-config-values.ts";
import type { LegacyConfigSnapshotRef } from "../../shared/legacy-config.ts";
import type { ProfileOriginHistoryValue, ProfileAuthorityImportValue } from "./profile-authority-values.ts";

/** #153 P-A: immutable values only; stage1 registration does not release native execution. */
export type ReadonlyDeep<T> = T extends readonly (infer E)[] ? readonly ReadonlyDeep<E>[]
  : T extends object ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> } : T;
export type M2ValueErrorCode = "invalid_value" | "unsupported_shape" | "value_conflict" | "budget_exceeded" | "format_unregistered";
export type M2ValueResult<T> =
  | { readonly ok: true; readonly classification: "value-consistent"; readonly value: ReadonlyDeep<T> }
  | { readonly ok: false; readonly error: { readonly code: M2ValueErrorCode } };
export type Id = string;
export type Digest = string;
export type Revision = number;
export type Backend = "claude-code" | "codex-cli" | "dsh";
export type Strategy = "bypassPermissions";
export type PermissionMode = "auto" | "manual" | "workspace-write";
export type RuntimeRevision = Readonly<{ runtimeRevision: Revision; bindingRevision: Revision }>;
export type ProfileRef = Readonly<{ agentId: Id; profileRevision: Revision; contentDigest: Digest }>;
export type BindingConfigRef = Readonly<{ groupBindingId: Id; bindingConfigRevision: Revision; contentDigest: Digest }>;
export type CaptureRef = Readonly<{ captureId: Id; sourceDigest: Digest; artifactDigest: Digest }>;
export type ConfigSnapshotRef = Readonly<{ snapshotId: Id; contentDigest: Digest }>;
export type WorkspaceMappingRef = Readonly<{ mappingId: Id; contentDigest: Digest }>;
export type DetachConfigSnapshotRef = Readonly<{ detachSnapshotId: Id; contentDigest: Digest }>;
export type WorkspaceRef = Readonly<{ projectId: Id; workspaceRevision: Revision }>;
export type WorkspaceRootIdentity = Readonly<{ device: string; inode: string; birthtimeNs: string }>;
export type EvidenceRef = Readonly<{ artifactId: Id; digest: Digest }>;
export type ArtifactRef = Readonly<{ ref: string; sha256: Digest; bytes: string }>;
export type SourceRef = Readonly<{ kind: "sqlite" | "postgres"; databaseInstanceId: string; identityDigest: Digest }>;
export type ActivationRef = Readonly<{ activationId: Id; digest: Digest }>;
export type TakeoverPlanRef = Readonly<{ planId: Id; digest: Digest }>;
export type ExecutionAttachmentRef = Readonly<{ executionBindingId: Id; groupBindingId: Id; runtimeId: Id }>;
export type RuntimeConfig = Readonly<{ model: string | null; workdir: string; tools: readonly string[] | null;
  systemPrompt: string; permissionMode: PermissionMode }>;
export type ExistingAdvancedScope = Readonly<{ sourceIdentityDigest: Digest; agentId: Id; executionBindingId: Id;
  projectId: Id; groupId: Id; memberId: Id; membershipRevision: Revision; permissionMode: PermissionMode; tools: readonly string[] | null }>;
export type CurrentAdvancedBasis = Readonly<{ profileRef: ProfileRef; bindingConfigRevision: Revision; backend: "claude-code";
  ordinaryConfigDigest: Digest; root: Readonly<{ workspaceRef: WorkspaceRef; canonicalRoot: string; physicalResourceKey: string;
    rootIdentity: WorkspaceRootIdentity }>; existingScope: ExistingAdvancedScope; existingPermissionScopeDigest: Digest;
  compatibilityBasis: RuntimeRevision | null }>;
export type CurrentAdvancedSelection =
  | Readonly<{ state: "none" }>
  | Readonly<{ state: "selected"; strategy: Strategy; basis: CurrentAdvancedBasis; origin:
      | Readonly<{ kind: "legacy_equivalence"; captureRef: CaptureRef; legacyRef: LegacyConfigSnapshotRef }>
      | Readonly<{ kind: "explicit_compat_request"; requestId: Id }> }>
  | Readonly<{ state: "retained_inactive"; original: RuntimeRevision & Readonly<{ strategy: Strategy }>;
      captureRef: CaptureRef; reason: "invalidated_by_revision" | "migration_reconfirmation_required" }>;
export type AdvancedValidity = "not_selected" | "effective" | "invalidated_by_revision" | "migration_reconfirmation_required";
export type CurrentAdvancedView = Readonly<{ stored: CurrentAdvancedSelection; effectiveStrategy: Strategy | null;
  validity: AdvancedValidity; blockedReasons: readonly string[] }>;
export type BindingContent = BindingOrdinaryContent & Readonly<{ currentAdvanced: CurrentAdvancedSelection }>;
export type ProfileVersion = Readonly<{ ref: ProfileRef; content: ProfileContent }>;
export type BindingVersion = Readonly<{ ref: BindingConfigRef; agentId: Id; projectId: Id; groupId: Id; memberId: Id; content: BindingContent }>;
export type ConfigSnapshot = Readonly<{
  ref: ConfigSnapshotRef; agentId: Id; groupBindingId: Id; executionBindingId: Id | null; memberId: Id; projectId: Id; groupId: Id;
  backend: Backend; config: RuntimeConfig; advancedStrategy: Strategy | null; semanticDigest: Digest;
  origin: Readonly<{ kind: "legacy"; legacyRef: LegacyConfigSnapshotRef; raw: Readonly<{ captureRef: CaptureRef;
    rawJson: string | null; rawDigest: Digest | null; rawAdvancedJson: string | null; rawAdvancedDigest: Digest | null }> }>
    | Readonly<{ kind: "profile"; profileRef: ProfileRef; bindingRef: BindingConfigRef }>;
  advancedBasis: Readonly<{ kind: "legacy"; legacy: Readonly<{ originalSelection: (RuntimeRevision & Readonly<{ strategy: Strategy }>) | null;
    originalValidity: "not_selected" | "effective" | "invalidated_by_revision";
    mappedValidity: "not_selected" | "equivalent" | "invalidated_by_revision" | "migration_reconfirmation_required";
    equivalenceEvidenceDigest: Digest | null }> }>
    | Readonly<{ kind: "profile"; bindingRef: BindingConfigRef; currentSelection: CurrentAdvancedSelection; resolved: AdvancedValidity }>;
  legacyAlias: Readonly<{ displayName: string; hostType: string }> | null;
}>;
export type WorkspaceMapping = Readonly<{ ref: WorkspaceMappingRef; configSnapshotRef: ConfigSnapshotRef; workspaceRef: WorkspaceRef;
  originalWorkdir: string; canonicalRoot: string; rootIdentity: WorkspaceRootIdentity; physicalResourceKey: string; observedAt: string;
  observationOnly: true; requiresRevalidation: true; runReady: false }>;
export type SelectedConfigSource = Readonly<{ state: "mapped"; snapshotRef: ConfigSnapshotRef; mappingRef: WorkspaceMappingRef }>
  | Readonly<{ state: "blocked"; snapshotRef: ConfigSnapshotRef; reasons: readonly string[] }>;
export type DetachRoot = Readonly<{ state: "fixed_reference"; workspaceRef: WorkspaceRef; mappingRef: WorkspaceMappingRef | null;
  canonicalRoot: string; physicalResourceKey: string; rootIdentity: WorkspaceRootIdentity; observedAt: string;
  requiresRevalidation: true; runReady: false }>
  | Readonly<{ state: "missing"; workspaceRef: WorkspaceRef | null; reasons: readonly string[]; runReady: false }>;
export type DetachResolution = Readonly<{ state: "complete"; backend: Backend; config: RuntimeConfig;
  advancedStrategy: Strategy | null; semanticDigest: Digest }>
  | Readonly<{ state: "incomplete"; backend: Backend | null; partialConfig: Partial<RuntimeConfig>; reasons: readonly string[] }>;
export type DetachConfigSnapshot = Readonly<{ ref: DetachConfigSnapshotRef; attachment: ExecutionAttachmentRef; profileRef: ProfileRef;
  bindingRef: BindingConfigRef; root: DetachRoot; currentAdvanced: CurrentAdvancedView; resolution: DetachResolution;
  requested: SelectedConfigSource | null; applied: SelectedConfigSource | null; observedAt: string; readOnly: true; runReady: false }>;
export type SourceBinding = Readonly<{ contract: "m2-source-binding/r1"; kind: "legacy"; physicalSourceRef: EvidenceRef }>
  | Readonly<{ contract: "m2-source-binding/r1"; kind: "local"; physicalSourceRef: EvidenceRef; activation: ActivationRef }>
  | Readonly<{ contract: "m2-source-binding/r1"; kind: "imported"; importArtifact: ArtifactRef; importValueDigest: Digest }>;
export type GuardTransition = Readonly<{ protocolBefore: 1; protocolAfter: 2; guardBeforeDigest: Digest; guardAfterDigest: Digest;
  schemaBeforeDigest: Digest; schemaAfterDigest: Digest; writerFormat: "s2-profile-config/v1"; writerFormatDigest: Digest;
  registeredUpgrade: EvidenceRef }>;
export type ActivationReceipt = Readonly<{ ref: ActivationRef; requestId: Id; planRef: TakeoverPlanRef;
  physicalSourceRef: EvidenceRef; snapshotReceiptRef: EvidenceRef; captureRef: CaptureRef; schemaBeforeDigest: Digest;
  schemaAfterDigest: Digest; guardTransition: GuardTransition; allowedDeltaManifest: EvidenceRef; targetRowsDigest: Digest;
  sourceToTargetManifest: EvidenceRef; committedAuthority: "profile" }>;
export type NativeStoredCell = readonly ["null"] | readonly ["integer", string] | readonly ["text", string]
  | readonly ["blob", string] | readonly ["real64be", string];
export type LegacyCapturedTable = Readonly<{ name: string; columnContract: ArtifactRef; columns: readonly string[]; count: string;
  rows: readonly Readonly<{ rowid: string | null; cells: readonly NativeStoredCell[] }>[] }>;
export type LegacyCaptureBody = Readonly<{ contract: "m2-legacy-capture-body/r1"; captureId: Id; physicalSourceRef: EvidenceRef;
  snapshotReceiptRef: EvidenceRef; source: SourceRef; textEncoding: Readonly<{ backend: "sqlite" | "postgres"; name: string }>;
  persistedAliases: true; legacySourceDigest: Digest; tables: readonly LegacyCapturedTable[] }>;
export type MutationReceiptValue = Readonly<{ actorScope: Id; operation: "profile.create" | "profile.save" | "binding.save";
  targetScope: Readonly<{ kind: "agent"; agentId: Id }> | Readonly<{ kind: "binding"; groupBindingId: Id }>;
  mutationId: Id; commandDigest: Digest; result:
    | Readonly<{ kind: "profile"; saved: Readonly<{ ref: ProfileRef; mutationId: Id; pendingApply: true; missing: readonly string[] }> }>
    | Readonly<{ kind: "binding"; saved: Readonly<{ ref: BindingConfigRef; mutationId: Id; pendingApply: true; missing: readonly string[] }> }>;
  auditId: Id }>;
export type AuthorityRowValue = Readonly<{ singleton: 1; formatVersion: number; owner: "legacy" | "profile";
  activationId: Id | null; sourceBinding: SourceBinding }>;
export type SourcePair = Readonly<{ snapshot: ConfigSnapshot; mapping: WorkspaceMapping | null }>;
export type ImportSelection = Readonly<{ artifact: ArtifactRef; value: ProfileAuthorityImportValue; valueDigest: Digest }>;
export type AuthorityJoinInput = Readonly<{ authority: AuthorityRowValue; receipt: ActivationReceipt | null;
  receiptArtifact: ArtifactRef | null; sourceHistory: ProfileOriginHistoryValue | null; importSelection: ImportSelection | null }>;
export interface M2ValueTypes {
  "profile-content": ProfileContent; "binding-content": BindingContent;
  "profile-version": ProfileVersion; "binding-version": BindingVersion;
  "current-advanced": CurrentAdvancedSelection; "current-advanced-view": CurrentAdvancedView;
  "config-snapshot": ConfigSnapshot; "workspace-mapping": WorkspaceMapping; "detach-snapshot": DetachConfigSnapshot;
  "source-binding": SourceBinding; "activation-receipt": ActivationReceipt;
  "legacy-capture": LegacyCaptureBody; "mutation-receipt": MutationReceiptValue;
}
export type ParsedM2Value = { [K in keyof M2ValueTypes]: { kind: K; value: M2ValueTypes[K] } }[keyof M2ValueTypes];
export interface M2DigestBodies {
  "profile-content": ProfileContent; "binding-content": BindingContent; "existing-scope": ExistingAdvancedScope;
  "ordinary-config": Readonly<{ backend: Backend; config: RuntimeConfig }>;
  "config-snapshot": Omit<ConfigSnapshot, "ref">; "workspace-mapping": Omit<WorkspaceMapping, "ref">;
  "detach-snapshot": Omit<DetachConfigSnapshot, "ref">; "activation-receipt": Omit<ActivationReceipt, "ref">;
  "legacy-capture": LegacyCaptureBody; "source-binding": SourceBinding;
}
export type M2DigestValue = Readonly<{ kind: keyof M2DigestBodies; algorithm: "sha256";
  canonicalDomain: "m2-r3-codepoint/v1" | "storage-maintenance-utf16/v1"; digest: Digest }>;
export type M2Cell = Readonly<{ kind: "text"; value: string }> | Readonly<{ kind: "integer"; decimal: string }> | Readonly<{ kind: "null" }>;
export interface M2RowTypes {
  agent_profiles: Readonly<{ agentId: Id; currentRevision: Revision; legacyRuntimeId: Id | null; compatRuntimeRevision: Revision | null }>;
  agent_profile_versions: Readonly<{ version: ProfileVersion; compatRuntimeRevision: Revision | null }>;
  group_bindings: Readonly<{ id: Id; projectId: Id; groupId: Id; memberId: Id; agentId: Id; currentRevision: Revision;
    originalLegacyBindingId: Id | null; currentAttachmentId: Id | null; currentCompatBindingRevision: Revision | null; retiredAt: string | null }>;
  group_binding_config_versions: Readonly<{ ref: BindingConfigRef; content: BindingContent;
    compatibility: Readonly<{ executionBindingId: Id; bindingRevision: Revision }> | null }>;
  legacy_config_captures: Readonly<{ ref: CaptureRef; physicalSourceRef: EvidenceRef; snapshotReceiptRef: EvidenceRef; capture: LegacyCaptureBody }>;
  config_snapshots: ConfigSnapshot; config_detach_snapshots: DetachConfigSnapshot; config_workspace_mappings: WorkspaceMapping;
  config_authority: AuthorityRowValue; config_activation_receipts: ActivationReceipt; config_mutation_receipts: MutationReceiptValue;
  "execution-binding-references": Readonly<{ executionBindingId: Id; groupBindingId: Id; attachmentState: "attached" | "detached";
    detachSnapshotId: Id | null; detachedAt: string | null; requestedSnapshotId: Id | null; requestedMappingId: Id | null }>;
  "runner-applied-references": Readonly<{ bindingId: Id; appliedSnapshotId: Id | null; appliedMappingId: Id | null }>;
}
export type M2RowProjection = Readonly<{ contract: "m2-row-projection/r1"; table: Exclude<keyof M2RowTypes,
  "execution-binding-references" | "runner-applied-references">; cells: Readonly<Record<string, M2Cell>> }>;
export type M2ExecutionReferenceProjection = Readonly<{ contract: "m2-execution-reference-projection/r1";
  table: "agent_runtime_bindings" | "agent_runner_states"; identity: Readonly<{ id: Id }> | Readonly<{ binding_id: Id }>;
  cells: Readonly<Record<string, M2Cell>> }>;
export type M2ForeignKey = Readonly<{ constraintId: string; targetTable: string; targetColumns: readonly string[];
  key: readonly M2Cell[]; onDelete: "RESTRICT" | "NO ACTION"; deferrable: boolean }>;
export type M2ArtifactReference = Readonly<{ path: readonly string[]; kind: "evidence"; reference: EvidenceRef }>
  | Readonly<{ path: readonly string[]; kind: "artifact"; reference: ArtifactRef }>;
export type M2RemainingSourceCheck = "physical_source" | "artifact_bytes" | "full_catalog" | "fk_existence"
  | "scope_alignment" | "attachment_bijection" | "current_authorization" | "native_commit";
export type M2DecodedRow = { [K in keyof M2RowTypes]: Readonly<{ table: K; value: M2RowTypes[K];
  projection: M2RowProjection | M2ExecutionReferenceProjection; projectionDigest: Digest; foreignKeys: readonly M2ForeignKey[];
  artifactRefs: readonly M2ArtifactReference[]; remainingSourceChecks: readonly M2RemainingSourceCheck[] }> }[keyof M2RowTypes];
export type M2FormatRegistration = Readonly<{ contract: "m2-value-format-registration/r1"; state: "unregistered";
  schemaMigration: null; configFormat: null }> | Readonly<{ contract: "m2-value-format-registration/r1"; state: "registered-stage1";
  schemaMigration: 22; configFormat: 1; valueContractId: "BR-COLLAB-S2-T2-M2-PA-REG-20261118-R1";
  valueContractRef: ArtifactRef; columnContractRef: ArtifactRef; columnContractValueDigest: Digest;
  legacyMigrationSetRef: ArtifactRef; canonicalDomains: Readonly<{ contractRef: ArtifactRef; value: "C-R3"; control: "C-S4";
    semantic: "C-SEM"; legacyCapture: "C-LEGACY"; artifact: "H-BYTES" }>;
  pureValueDecoderContractRef: ArtifactRef; independentAcceptanceRef: ArtifactRef;
  productionTuple: Readonly<{ state: "pending"; sqliteTargetSchemaRef: Readonly<{ state: "pending" }>;
    postgresTargetSchemaRef: Readonly<{ state: "pending" }>; guardTransitionRef: Readonly<{ state: "pending" }>;
    strictDecoderContractRef: Readonly<{ state: "pending"; scope: "s4-native-p1-decoder" }>;
    sourceClientFormatContractRef: Readonly<{ state: "pending" }>; registeredUpgradeRef: Readonly<{ state: "pending" }> }> }>;

function freeze<T>(value: T): ReadonlyDeep<T> {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value as ReadonlyDeep<T>;
}
// Exact accepted C/D/K/L/A data; deliberately no runtime file/registry resolver.
export const M2_FORMAT_REGISTRATION: M2FormatRegistration = freeze({
  "canonicalDomains": {
    "artifact": "H-BYTES",
    "contractRef": {
      "bytes": "5509",
      "ref": "m2-contract/sha256/247c60ae3acdb4663276d2ba86d20935695f19f90d5e34c57a3f92295ab2fde1/CANONICAL-DOMAINS.json",
      "sha256": "247c60ae3acdb4663276d2ba86d20935695f19f90d5e34c57a3f92295ab2fde1"
    },
    "control": "C-S4",
    "legacyCapture": "C-LEGACY",
    "semantic": "C-SEM",
    "value": "C-R3"
  },
  "columnContractRef": {
    "bytes": "12045",
    "ref": "m2-contract/sha256/19c898011adfba7da677f45792aabce19fb426b5db6a52a08e46c3e22b3f39fe/ROW-CATALOG-STAGE1.json",
    "sha256": "19c898011adfba7da677f45792aabce19fb426b5db6a52a08e46c3e22b3f39fe"
  },
  "columnContractValueDigest": "147bab30a12e95276f48b0f592d74b433012d051462cbeef9bbdcc8a8653cd9e",
  "configFormat": 1,
  "contract": "m2-value-format-registration/r1",
  "independentAcceptanceRef": {
    "bytes": "2261",
    "ref": "m2-contract/sha256/7b6f63393a998c98bafecf7b6652f24fba865b0ac3eacc759ef86a27dccf8030/M2-PA-STAGE1-ACCEPTANCE.json",
    "sha256": "7b6f63393a998c98bafecf7b6652f24fba865b0ac3eacc759ef86a27dccf8030"
  },
  "legacyMigrationSetRef": {
    "bytes": "15513",
    "ref": "m2-contract/sha256/0dd3de018e95d77618722b7db0b9cb8178c0c1ab12de42e2808c1f509844bb99/legacy-migration-set.json",
    "sha256": "0dd3de018e95d77618722b7db0b9cb8178c0c1ab12de42e2808c1f509844bb99"
  },
  "productionTuple": {
    "guardTransitionRef": {
      "state": "pending"
    },
    "postgresTargetSchemaRef": {
      "state": "pending"
    },
    "registeredUpgradeRef": {
      "state": "pending"
    },
    "sourceClientFormatContractRef": {
      "state": "pending"
    },
    "sqliteTargetSchemaRef": {
      "state": "pending"
    },
    "state": "pending",
    "strictDecoderContractRef": {
      "scope": "s4-native-p1-decoder",
      "state": "pending"
    }
  },
  "pureValueDecoderContractRef": {
    "bytes": "3969",
    "ref": "m2-contract/sha256/cc73873d2445be159347f14668d64c9b1407a9ed22859fb31df092277fea10f7/CANDIDATE.json",
    "sha256": "cc73873d2445be159347f14668d64c9b1407a9ed22859fb31df092277fea10f7"
  },
  "schemaMigration": 22,
  "state": "registered-stage1",
  "valueContractId": "BR-COLLAB-S2-T2-M2-PA-REG-20261118-R1",
  "valueContractRef": {
    "bytes": "3969",
    "ref": "m2-contract/sha256/cc73873d2445be159347f14668d64c9b1407a9ed22859fb31df092277fea10f7/CANDIDATE.json",
    "sha256": "cc73873d2445be159347f14668d64c9b1407a9ed22859fb31df092277fea10f7"
  }
} as const);
export const M2_COLUMN_CONTRACT = freeze({
  "constraints": "Exactly the accepted physical candidate R01-R11/E01-E03 D/R/unique/check semantics; this catalog contains no SQL or callable permission.",
  "contract": "m2-logical-columns/r1",
  "domains": {
    "F": "exact independently registered config format integer; unregistered rejects",
    "H": "lowercase sha256 hex",
    "I": "positive existing int4 FK revision (1..2147483647) at physical projection; value Ref still uses Revision",
    "INTEGER": "integer singleton must equal 1",
    "J": "strict canonical JSON TEXT in the explicit per-column domain",
    "N": "positive safe integer (1..9007199254740991), canonical decimal SQL cell",
    "T": "logical text, no coercion; standalone SQL cell requires lossless UTF-8 and no NUL",
    "TS": "nonempty observation/timestamp text, never CAS"
  },
  "executionFragments": [
    {
      "columns": [
        {
          "domain": "T",
          "name": "group_binding_id",
          "nullable": false,
          "ordinal": 1
        },
        {
          "domain": "T",
          "name": "attachment_state",
          "nullable": false,
          "ordinal": 2
        },
        {
          "domain": "T",
          "name": "detach_config_snapshot_id",
          "nullable": true,
          "ordinal": 3
        },
        {
          "domain": "TS",
          "name": "detached_at",
          "nullable": true,
          "ordinal": 4
        },
        {
          "domain": "T",
          "name": "requested_config_snapshot_id",
          "nullable": true,
          "ordinal": 5
        },
        {
          "domain": "T",
          "name": "requested_workspace_mapping_id",
          "nullable": true,
          "ordinal": 6
        }
      ],
      "id": "E01",
      "table": "agent_runtime_bindings"
    },
    {
      "columns": [
        {
          "domain": "T",
          "name": "applied_config_snapshot_id",
          "nullable": true,
          "ordinal": 1
        },
        {
          "domain": "T",
          "name": "applied_workspace_mapping_id",
          "nullable": true,
          "ordinal": 2
        }
      ],
      "id": "E02",
      "table": "agent_runner_states"
    }
  ],
  "physicalCandidateDigest": "21345c2591391978793f5951fe9aba148b3d359e26acce16101370d78739f457",
  "physicalRelationsFileSha256": "89401f5bddb9a26295fb4a38982fccc47164a8b5c4df82f04f8bb2bb68a671b2",
  "registration": {
    "configFormat": 1,
    "schemaMigration": 22
  },
  "relations": [
    {
      "columns": [
        {
          "domain": "T",
          "name": "agent_id",
          "nullable": false,
          "ordinal": 1
        },
        {
          "domain": "N",
          "name": "current_revision",
          "nullable": false,
          "ordinal": 2
        },
        {
          "domain": "T",
          "name": "legacy_runtime_id",
          "nullable": true,
          "ordinal": 3
        },
        {
          "domain": "N",
          "name": "compat_runtime_revision",
          "nullable": true,
          "ordinal": 4
        }
      ],
      "id": "R01",
      "table": "agent_profiles"
    },
    {
      "columns": [
        {
          "domain": "T",
          "name": "agent_id",
          "nullable": false,
          "ordinal": 1
        },
        {
          "domain": "N",
          "name": "revision",
          "nullable": false,
          "ordinal": 2
        },
        {
          "domain": "J",
          "name": "content_json",
          "nullable": false,
          "ordinal": 3
        },
        {
          "domain": "H",
          "name": "content_digest",
          "nullable": false,
          "ordinal": 4
        },
        {
          "domain": "T",
          "name": "default_role_id",
          "nullable": true,
          "ordinal": 5
        },
        {
          "domain": "I",
          "name": "default_role_revision",
          "nullable": true,
          "ordinal": 6
        },
        {
          "domain": "N",
          "name": "compat_runtime_revision",
          "nullable": true,
          "ordinal": 7
        }
      ],
      "id": "R02",
      "table": "agent_profile_versions"
    },
    {
      "columns": [
        {
          "domain": "T",
          "name": "id",
          "nullable": false,
          "ordinal": 1
        },
        {
          "domain": "T",
          "name": "project_id",
          "nullable": false,
          "ordinal": 2
        },
        {
          "domain": "T",
          "name": "group_id",
          "nullable": false,
          "ordinal": 3
        },
        {
          "domain": "T",
          "name": "member_id",
          "nullable": false,
          "ordinal": 4
        },
        {
          "domain": "T",
          "name": "agent_id",
          "nullable": false,
          "ordinal": 5
        },
        {
          "domain": "N",
          "name": "current_revision",
          "nullable": false,
          "ordinal": 6
        },
        {
          "domain": "T",
          "name": "original_legacy_binding_id",
          "nullable": true,
          "ordinal": 7
        },
        {
          "domain": "T",
          "name": "current_attachment_id",
          "nullable": true,
          "ordinal": 8
        },
        {
          "domain": "T",
          "name": "current_attachment_state",
          "nullable": true,
          "ordinal": 9
        },
        {
          "domain": "N",
          "name": "current_compat_binding_revision",
          "nullable": true,
          "ordinal": 10
        },
        {
          "domain": "TS",
          "name": "retired_at",
          "nullable": true,
          "ordinal": 11
        }
      ],
      "id": "R03",
      "table": "group_bindings"
    },
    {
      "columns": [
        {
          "domain": "T",
          "name": "binding_id",
          "nullable": false,
          "ordinal": 1
        },
        {
          "domain": "N",
          "name": "revision",
          "nullable": false,
          "ordinal": 2
        },
        {
          "domain": "J",
          "name": "content_json",
          "nullable": false,
          "ordinal": 3
        },
        {
          "domain": "H",
          "name": "content_digest",
          "nullable": false,
          "ordinal": 4
        },
        {
          "domain": "T",
          "name": "role_id",
          "nullable": true,
          "ordinal": 5
        },
        {
          "domain": "I",
          "name": "role_revision",
          "nullable": true,
          "ordinal": 6
        },
        {
          "domain": "T",
          "name": "compat_execution_binding_id",
          "nullable": true,
          "ordinal": 7
        },
        {
          "domain": "N",
          "name": "compat_binding_revision",
          "nullable": true,
          "ordinal": 8
        },
        {
          "domain": "T",
          "name": "advanced_state",
          "nullable": false,
          "ordinal": 9
        },
        {
          "domain": "T",
          "name": "advanced_profile_agent_id",
          "nullable": true,
          "ordinal": 10
        },
        {
          "domain": "N",
          "name": "advanced_profile_revision",
          "nullable": true,
          "ordinal": 11
        },
        {
          "domain": "H",
          "name": "advanced_profile_digest",
          "nullable": true,
          "ordinal": 12
        },
        {
          "domain": "T",
          "name": "advanced_capture_id",
          "nullable": true,
          "ordinal": 13
        },
        {
          "domain": "H",
          "name": "advanced_capture_source_digest",
          "nullable": true,
          "ordinal": 14
        },
        {
          "domain": "H",
          "name": "advanced_capture_artifact_digest",
          "nullable": true,
          "ordinal": 15
        },
        {
          "domain": "T",
          "name": "advanced_workspace_project_id",
          "nullable": true,
          "ordinal": 16
        },
        {
          "domain": "I",
          "name": "advanced_workspace_revision",
          "nullable": true,
          "ordinal": 17
        },
        {
          "domain": "T",
          "name": "advanced_execution_binding_id",
          "nullable": true,
          "ordinal": 18
        }
      ],
      "id": "R04",
      "table": "group_binding_config_versions"
    },
    {
      "columns": [
        {
          "domain": "T",
          "name": "id",
          "nullable": false,
          "ordinal": 1
        },
        {
          "domain": "J",
          "name": "physical_source_ref",
          "nullable": false,
          "ordinal": 2
        },
        {
          "domain": "H",
          "name": "source_digest",
          "nullable": false,
          "ordinal": 3
        },
        {
          "domain": "H",
          "name": "artifact_digest",
          "nullable": false,
          "ordinal": 4
        },
        {
          "domain": "J",
          "name": "capture_json",
          "nullable": false,
          "ordinal": 5
        },
        {
          "domain": "J",
          "name": "snapshot_receipt_ref",
          "nullable": false,
          "ordinal": 6
        }
      ],
      "id": "R05",
      "table": "legacy_config_captures"
    },
    {
      "columns": [
        {
          "domain": "T",
          "name": "id",
          "nullable": false,
          "ordinal": 1
        },
        {
          "domain": "T",
          "name": "agent_id",
          "nullable": false,
          "ordinal": 2
        },
        {
          "domain": "T",
          "name": "group_binding_id",
          "nullable": false,
          "ordinal": 3
        },
        {
          "domain": "T",
          "name": "execution_binding_id",
          "nullable": true,
          "ordinal": 4
        },
        {
          "domain": "T",
          "name": "project_id",
          "nullable": false,
          "ordinal": 5
        },
        {
          "domain": "T",
          "name": "member_id",
          "nullable": false,
          "ordinal": 6
        },
        {
          "domain": "T",
          "name": "group_id",
          "nullable": false,
          "ordinal": 7
        },
        {
          "domain": "T",
          "name": "origin_kind",
          "nullable": false,
          "ordinal": 8
        },
        {
          "domain": "J",
          "name": "content_json",
          "nullable": false,
          "ordinal": 9
        },
        {
          "domain": "H",
          "name": "content_digest",
          "nullable": false,
          "ordinal": 10
        },
        {
          "domain": "H",
          "name": "semantic_digest",
          "nullable": false,
          "ordinal": 11
        },
        {
          "domain": "T",
          "name": "capture_id",
          "nullable": true,
          "ordinal": 12
        },
        {
          "domain": "H",
          "name": "capture_source_digest",
          "nullable": true,
          "ordinal": 13
        },
        {
          "domain": "H",
          "name": "capture_artifact_digest",
          "nullable": true,
          "ordinal": 14
        },
        {
          "domain": "N",
          "name": "profile_revision",
          "nullable": true,
          "ordinal": 15
        },
        {
          "domain": "H",
          "name": "profile_digest",
          "nullable": true,
          "ordinal": 16
        },
        {
          "domain": "N",
          "name": "binding_revision",
          "nullable": true,
          "ordinal": 17
        },
        {
          "domain": "H",
          "name": "binding_digest",
          "nullable": true,
          "ordinal": 18
        }
      ],
      "id": "R06",
      "table": "config_snapshots"
    },
    {
      "columns": [
        {
          "domain": "T",
          "name": "id",
          "nullable": false,
          "ordinal": 1
        },
        {
          "domain": "T",
          "name": "execution_binding_id",
          "nullable": false,
          "ordinal": 2
        },
        {
          "domain": "T",
          "name": "group_binding_id",
          "nullable": false,
          "ordinal": 3
        },
        {
          "domain": "T",
          "name": "runtime_id",
          "nullable": false,
          "ordinal": 4
        },
        {
          "domain": "T",
          "name": "profile_agent_id",
          "nullable": false,
          "ordinal": 5
        },
        {
          "domain": "N",
          "name": "profile_revision",
          "nullable": false,
          "ordinal": 6
        },
        {
          "domain": "H",
          "name": "profile_digest",
          "nullable": false,
          "ordinal": 7
        },
        {
          "domain": "N",
          "name": "binding_revision",
          "nullable": false,
          "ordinal": 8
        },
        {
          "domain": "H",
          "name": "binding_digest",
          "nullable": false,
          "ordinal": 9
        },
        {
          "domain": "J",
          "name": "resolution_json",
          "nullable": false,
          "ordinal": 10
        },
        {
          "domain": "J",
          "name": "root_source_json",
          "nullable": false,
          "ordinal": 11
        },
        {
          "domain": "J",
          "name": "current_advanced_view_json",
          "nullable": false,
          "ordinal": 12
        },
        {
          "domain": "J",
          "name": "requested_source_json",
          "nullable": true,
          "ordinal": 13
        },
        {
          "domain": "J",
          "name": "applied_source_json",
          "nullable": true,
          "ordinal": 14
        },
        {
          "domain": "TS",
          "name": "observed_at",
          "nullable": false,
          "ordinal": 15
        },
        {
          "domain": "H",
          "name": "content_digest",
          "nullable": false,
          "ordinal": 16
        },
        {
          "domain": "T",
          "name": "requested_snapshot_id",
          "nullable": true,
          "ordinal": 17
        },
        {
          "domain": "H",
          "name": "requested_snapshot_digest",
          "nullable": true,
          "ordinal": 18
        },
        {
          "domain": "T",
          "name": "requested_mapping_id",
          "nullable": true,
          "ordinal": 19
        },
        {
          "domain": "H",
          "name": "requested_mapping_digest",
          "nullable": true,
          "ordinal": 20
        },
        {
          "domain": "T",
          "name": "applied_snapshot_id",
          "nullable": true,
          "ordinal": 21
        },
        {
          "domain": "H",
          "name": "applied_snapshot_digest",
          "nullable": true,
          "ordinal": 22
        },
        {
          "domain": "T",
          "name": "applied_mapping_id",
          "nullable": true,
          "ordinal": 23
        },
        {
          "domain": "H",
          "name": "applied_mapping_digest",
          "nullable": true,
          "ordinal": 24
        },
        {
          "domain": "T",
          "name": "root_workspace_project_id",
          "nullable": true,
          "ordinal": 25
        },
        {
          "domain": "I",
          "name": "root_workspace_revision",
          "nullable": true,
          "ordinal": 26
        },
        {
          "domain": "T",
          "name": "root_mapping_id",
          "nullable": true,
          "ordinal": 27
        },
        {
          "domain": "H",
          "name": "root_mapping_digest",
          "nullable": true,
          "ordinal": 28
        }
      ],
      "id": "R07",
      "table": "config_detach_snapshots"
    },
    {
      "columns": [
        {
          "domain": "T",
          "name": "id",
          "nullable": false,
          "ordinal": 1
        },
        {
          "domain": "T",
          "name": "snapshot_id",
          "nullable": false,
          "ordinal": 2
        },
        {
          "domain": "H",
          "name": "snapshot_digest",
          "nullable": false,
          "ordinal": 3
        },
        {
          "domain": "T",
          "name": "project_id",
          "nullable": false,
          "ordinal": 4
        },
        {
          "domain": "I",
          "name": "workspace_revision",
          "nullable": false,
          "ordinal": 5
        },
        {
          "domain": "T",
          "name": "original_workdir",
          "nullable": false,
          "ordinal": 6
        },
        {
          "domain": "T",
          "name": "canonical_root",
          "nullable": false,
          "ordinal": 7
        },
        {
          "domain": "J",
          "name": "root_identity_json",
          "nullable": false,
          "ordinal": 8
        },
        {
          "domain": "T",
          "name": "physical_resource_key",
          "nullable": false,
          "ordinal": 9
        },
        {
          "domain": "TS",
          "name": "observed_at",
          "nullable": false,
          "ordinal": 10
        },
        {
          "domain": "H",
          "name": "content_digest",
          "nullable": false,
          "ordinal": 11
        }
      ],
      "id": "R08",
      "table": "config_workspace_mappings"
    },
    {
      "columns": [
        {
          "domain": "INTEGER",
          "name": "singleton",
          "nullable": false,
          "ordinal": 1
        },
        {
          "domain": "F",
          "name": "format_version",
          "nullable": false,
          "ordinal": 2
        },
        {
          "domain": "T",
          "name": "owner",
          "nullable": false,
          "ordinal": 3
        },
        {
          "domain": "T",
          "name": "activation_id",
          "nullable": true,
          "ordinal": 4
        },
        {
          "domain": "J",
          "name": "source_binding_ref",
          "nullable": false,
          "ordinal": 5
        }
      ],
      "id": "R09",
      "table": "config_authority"
    },
    {
      "columns": [
        {
          "domain": "T",
          "name": "id",
          "nullable": false,
          "ordinal": 1
        },
        {
          "domain": "T",
          "name": "request_id",
          "nullable": false,
          "ordinal": 2
        },
        {
          "domain": "T",
          "name": "plan_id",
          "nullable": false,
          "ordinal": 3
        },
        {
          "domain": "H",
          "name": "plan_digest",
          "nullable": false,
          "ordinal": 4
        },
        {
          "domain": "J",
          "name": "physical_source_ref",
          "nullable": false,
          "ordinal": 5
        },
        {
          "domain": "J",
          "name": "snapshot_receipt_ref",
          "nullable": false,
          "ordinal": 6
        },
        {
          "domain": "T",
          "name": "capture_id",
          "nullable": false,
          "ordinal": 7
        },
        {
          "domain": "H",
          "name": "capture_source_digest",
          "nullable": false,
          "ordinal": 8
        },
        {
          "domain": "H",
          "name": "capture_artifact_digest",
          "nullable": false,
          "ordinal": 9
        },
        {
          "domain": "H",
          "name": "schema_before_digest",
          "nullable": false,
          "ordinal": 10
        },
        {
          "domain": "H",
          "name": "schema_after_digest",
          "nullable": false,
          "ordinal": 11
        },
        {
          "domain": "J",
          "name": "guard_transition_json",
          "nullable": false,
          "ordinal": 12
        },
        {
          "domain": "J",
          "name": "allowed_delta_ref",
          "nullable": false,
          "ordinal": 13
        },
        {
          "domain": "H",
          "name": "target_rows_digest",
          "nullable": false,
          "ordinal": 14
        },
        {
          "domain": "J",
          "name": "source_to_target_manifest_ref",
          "nullable": false,
          "ordinal": 15
        },
        {
          "domain": "J",
          "name": "payload_json",
          "nullable": false,
          "ordinal": 16
        },
        {
          "domain": "H",
          "name": "payload_digest",
          "nullable": false,
          "ordinal": 17
        }
      ],
      "id": "R10",
      "table": "config_activation_receipts"
    },
    {
      "columns": [
        {
          "domain": "T",
          "name": "actor_scope",
          "nullable": false,
          "ordinal": 1
        },
        {
          "domain": "T",
          "name": "operation",
          "nullable": false,
          "ordinal": 2
        },
        {
          "domain": "T",
          "name": "target_scope",
          "nullable": false,
          "ordinal": 3
        },
        {
          "domain": "T",
          "name": "mutation_id",
          "nullable": false,
          "ordinal": 4
        },
        {
          "domain": "H",
          "name": "command_digest",
          "nullable": false,
          "ordinal": 5
        },
        {
          "domain": "J",
          "name": "result_json",
          "nullable": false,
          "ordinal": 6
        },
        {
          "domain": "T",
          "name": "result_profile_agent_id",
          "nullable": true,
          "ordinal": 7
        },
        {
          "domain": "N",
          "name": "result_profile_revision",
          "nullable": true,
          "ordinal": 8
        },
        {
          "domain": "H",
          "name": "result_profile_digest",
          "nullable": true,
          "ordinal": 9
        },
        {
          "domain": "T",
          "name": "result_binding_id",
          "nullable": true,
          "ordinal": 10
        },
        {
          "domain": "N",
          "name": "result_binding_revision",
          "nullable": true,
          "ordinal": 11
        },
        {
          "domain": "H",
          "name": "result_binding_digest",
          "nullable": true,
          "ordinal": 12
        },
        {
          "domain": "T",
          "name": "audit_id",
          "nullable": false,
          "ordinal": 13
        }
      ],
      "id": "R11",
      "table": "config_mutation_receipts"
    }
  ]
} as const);

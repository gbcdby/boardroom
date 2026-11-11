import type { RuntimeAdvancedSelection, RuntimeAppliedConfig, RuntimeBackend, RuntimeBindingView,
  RuntimeConfig, RuntimeRevision } from "../server/runtime/types.ts";

export type LegacySnapshotKind = "requestedSnapshot" | "applied" | "effective";
export interface LegacyConfigSnapshotRef {
  readonly authority: "legacy";
  readonly kind: LegacySnapshotKind;
  /** requested/effective 的原 binding ID；applied 的原 runner 主键也是 binding ID。 */
  readonly sourceId: string;
  readonly runtimeId: string;
  readonly bindingId: string;
  readonly agentId: string;
  readonly digest: string;
  readonly versions: RuntimeRevision;
  readonly configVersion: number;
}
export interface LegacyConfigSnapshotSource {
  readonly ref: LegacyConfigSnapshotRef;
  readonly snapshot: RuntimeAppliedConfig;
  readonly workdir: string;
  /** 存储快照保留原 JSON 字节；effective 是完整 resolver 的派生结果，原输入在 raw。 */
  readonly rawJson: string | null;
  readonly rawDigest: string | null;
  readonly digestValid: boolean;
}
export interface LegacyInspectionIssue {
  readonly code: "migration_identity_ambiguous" | "legacy_config_invalid" | "migration_mapping_required" | "legacy_configuration_differs";
  readonly reason: string;
  readonly refs: Readonly<Record<string, string | readonly string[]>>;
}
export interface LegacyBindingInspection {
  readonly bindingId: string;
  readonly runtimeId: string;
  readonly agentId: string | null;
  readonly memberId: string;
  readonly projectId: string;
  readonly groupId: string;
  readonly identityValid: boolean;
  readonly configurationValid: boolean;
  /** 当前配置/意图/实际 runner 是三份事实；此原有视图不经过应用或迁移写回。 */
  readonly view: RuntimeBindingView | null;
  readonly raw: {
    /** 原始来源行包括意图、SID、会话键和运行观察；配置损坏时也不丢这些独立事实。 */
    readonly runtimeRow: Readonly<Record<string, unknown>> | null;
    readonly bindingRow: Readonly<Record<string, unknown>>;
    readonly runnerRow: Readonly<Record<string, unknown>> | null;
    readonly defaultsJson: string | null;
    readonly overridesJson: string;
    readonly advancedJson: string | null;
    readonly requestedSnapshotJson: string | null;
    readonly appliedJson: string | null;
    readonly processIdentityJson: string | null;
  };
  readonly advanced: {
    readonly raw: RuntimeAdvancedSelection | null;
    readonly effectiveStrategy: RuntimeAppliedConfig["advancedStrategy"];
    readonly validity: "not_selected" | "effective" | "invalidated_by_revision";
  } | null;
  readonly snapshots: {
    readonly requested: LegacyConfigSnapshotSource | null;
    readonly applied: LegacyConfigSnapshotSource | null;
    readonly effective: LegacyConfigSnapshotSource | null;
  };
  readonly issues: readonly LegacyInspectionIssue[];
}
export interface LegacyProfileSource {
  readonly agentId: string;
  readonly displayName: string;
  readonly authority: "legacy";
  readonly writable: false;
  readonly migrated: false;
  readonly mode: "legacy-runtime" | "external" | "ambiguous";
  readonly runtimeIds: readonly string[];
  readonly bindingIds: readonly string[];
  readonly source: {
    readonly runtimeId: string;
    readonly backend: RuntimeBackend;
    readonly configVersion: number;
    readonly runtimeRevision: number;
    readonly nonDirectoryDefaults: Omit<RuntimeConfig, "workdir">;
    /** 只是旧来源；不提升为 Agent 跨项目写根。每个快照的目录另见绑定 sources。 */
    readonly legacyWorkdir: string;
  } | null;
}
export interface LegacyConfigInspection {
  readonly schemaVersion: "legacy-config-inspection/v1";
  readonly authority: "legacy";
  readonly readOnly: true;
  readonly migrated: false;
  readonly observedAt: string;
  /** 只对本报告捕获的原始来源行计算，不冒充完整业务库备份摘要。 */
  readonly sourceDigest: string;
  readonly aliasCatalogState: "persisted" | "pre-migration";
  readonly code: "migration_identity_ambiguous" | "legacy_config_invalid" | null;
  readonly profiles: readonly LegacyProfileSource[];
  readonly bindings: readonly LegacyBindingInspection[];
  readonly issues: readonly LegacyInspectionIssue[];
}
export interface LegacySnapshotSelection {
  readonly authority: "legacy";
  readonly readOnly: true;
  readonly activationAllowed: false;
  readonly code: "migration_identity_ambiguous" | "legacy_config_invalid" | null;
  readonly configSnapshotRef: LegacyConfigSnapshotRef | null;
  readonly snapshot: RuntimeAppliedConfig | null;
  readonly rawJson: string | null;
  readonly reasons: readonly string[];
}

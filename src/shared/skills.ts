import type { LegacyConfigSnapshotRef, LegacySnapshotSelection } from "./legacy-config.ts";

/** 只读检查产物，不是持久 SkillVersion 或宿主可用性回执。 */
export type SkillInvocationMode = "user-only" | "implicit-or-explicit" | "unknown";
export type SkillExactPin = { readonly contentDigest: string } | { readonly versionId: string };
export interface SkillDependency { readonly skillName: string; readonly pin: SkillExactPin }
export interface SkillResource { readonly path: string; readonly required: boolean }
export interface SkillFileEntry {
  readonly path: string;
  readonly kind: "file" | "directory" | "symlink";
  readonly sha256: string | null;
  readonly byteLength: number;
  readonly target: string | null;
}
export interface SkillPackagePreview {
  readonly kind: "local-preview";
  /** 摘要引用不冒充已登记的 versionId。 */
  readonly previewRef: string;
  readonly versionId: null;
  readonly skillName: string;
  readonly description: string;
  readonly declaredVersion: string | null;
  readonly contentDigest: string;
  readonly invocationMode: SkillInvocationMode;
  readonly invocationEvidence: readonly string[];
  readonly resources: readonly SkillResource[];
  readonly dependencies: readonly SkillDependency[];
  readonly files: readonly SkillFileEntry[];
  readonly canonicalRoot: string;
  readonly sourceAliases: readonly string[];
  readonly manifests: readonly { readonly path: string; readonly suiteVersion: string; readonly manifestDigest: string; readonly verified: true }[];
}
export interface SkillInspectionIssue {
  readonly code: "invalid_path" | "path_escape" | "symlink_cycle" | "special_file" | "hardlink_unsupported" | "budget_exceeded"
    | "source_changed" | "source_unreadable" | "metadata_invalid" | "manifest_invalid" | "manifest_mismatch";
  readonly source: string;
  readonly detail: string;
}
export interface SkillInventoryPreview {
  readonly schemaVersion: "skill-inventory-preview/v1";
  readonly readOnly: true;
  readonly activationAllowed: false;
  readonly packages: readonly SkillPackagePreview[];
  readonly issues: readonly SkillInspectionIssue[];
  readonly digest: string;
}
export interface SkillSelection {
  readonly skillName: string;
  readonly enabled: boolean;
  /** 无 pin 时，仅允许该名称只有一种内容；从不按扫描顺序选择。 */
  readonly pin?: SkillExactPin;
  readonly required?: boolean;
  readonly locked?: boolean;
}
export interface SkillSelectionLayer {
  readonly ownerId: string;
  readonly revision: number;
  readonly selections: readonly SkillSelection[];
}
export interface SkillSelectionSources {
  readonly project: SkillSelectionLayer | null;
  readonly profile: SkillSelectionLayer | null;
  readonly group: SkillSelectionLayer | null;
}
export interface SkillSourceRevisions {
  readonly project: { readonly ownerId: string; readonly revision: number } | null;
  readonly profile: { readonly ownerId: string; readonly revision: number } | null;
  readonly group: { readonly ownerId: string; readonly revision: number } | null;
  readonly workspaceRevision: number | null;
}
/** 来自已存在目录的精确映射；本票不会写入或构造目录记录。 */
export interface SkillKnownVersion { readonly versionId: string; readonly skillName: string; readonly contentDigest: string }
export interface SkillProvenance {
  readonly kind: "project" | "profile" | "group" | "dependency";
  readonly ownerId: string;
  readonly revision: number | null;
  readonly via: readonly string[];
}
export interface SkillConflict {
  readonly code: "skills_conflict" | "invalid_selection" | "required_conflict" | "locked_conflict" | "missing_skill"
    | "pin_unresolved" | "dependency_missing" | "dependency_cycle" | "dependency_incompatible" | "source_changed" | "config_snapshot_invalid" | "inventory_invalid";
  readonly skillName: string | null;
  readonly message: string;
  readonly sources: readonly SkillProvenance[];
  readonly candidates: readonly string[];
}
export interface SkillLockEntry {
  readonly skillName: string;
  readonly previewRef: string;
  readonly contentDigest: string;
  readonly exactVersionIds: readonly string[];
  readonly required: boolean;
  readonly invocationMode: SkillInvocationMode;
  readonly invocationEligible: false;
  readonly packageSources: readonly string[];
  readonly provenance: readonly SkillProvenance[];
  readonly dependencies: readonly SkillDependency[];
}
export interface SkillLock {
  readonly schemaVersion: "skill-lock-preview/v1";
  readonly authority: "preview-only";
  readonly configSnapshotRef: LegacyConfigSnapshotRef;
  readonly sourceRevisions: SkillSourceRevisions;
  readonly fixed: boolean;
  readonly inventoryDigest: string;
  readonly versionReferences: readonly SkillKnownVersion[];
  readonly entries: readonly SkillLockEntry[];
  readonly selectionSources: SkillSelectionSources;
  readonly digest: string;
}
export interface SkillResolutionPreview {
  readonly readOnly: true;
  readonly activationAllowed: false;
  readonly state: "resolved-preview" | "conflict";
  readonly lock: SkillLock | null;
  readonly conflicts: readonly SkillConflict[];
}

export interface SkillCatalogServicePreview {
  readonly schemaVersion: "skill-catalog-service-preview/v1";
  readonly readOnly: true;
  readonly activationAllowed: false;
  readonly environment: {
    readonly layoutVersion: 1 | 2;
    readonly startupState: string;
    readonly skills: { readonly path: string; readonly status: "legacy" | "planned"; readonly protected: boolean };
    readonly materialized: false;
  };
  readonly inventory: SkillInventoryPreview;
}
export interface LegacySkillServicePreview extends SkillCatalogServicePreview {
  readonly configSelection: LegacySnapshotSelection;
  readonly resolution: SkillResolutionPreview;
}

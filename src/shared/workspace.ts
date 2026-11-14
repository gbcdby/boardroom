import type { LegacyConfigSnapshotRef, LegacyInspectionIssue, LegacySnapshotKind } from "./legacy-config.ts";

export type WorkspaceMode = "isolated" | "serialized";
export interface WorkspaceRootIdentity { readonly device: string; readonly inode: string; readonly birthtimeNs: string }
/** 只读观察，不调用工作树配置中的 filter、hook 或 fsmonitor。原始字节比较可能保守报告脏。 */
export interface WorkspaceRepositoryInfo {
  readonly kind: "git" | "not_git" | "unavailable";
  readonly topLevel: string | null;
  readonly head: string | null;
  readonly dirty: boolean | null;
  readonly trackedChangedCount: number | null;
  readonly untrackedCount: number | null;
  readonly indexChanged: boolean | null;
  readonly complete: boolean;
  readonly comparison: "raw_bytes_no_filters";
  readonly reason: string | null;
}
export interface WorkspacePreflight {
  readonly rootPath: string | null;
  readonly canonicalRoot: string | null;
  readonly rootIdentity: WorkspaceRootIdentity | null;
  readonly physicalResourceKey: string | null;
  readonly repositoryInfo: WorkspaceRepositoryInfo | null;
  readonly observedAt: string;
  readonly observationOnly: true;
  readonly requiresRevalidation: true;
  readonly runReady: false;
}
export interface WorkspaceRef { readonly projectId: string; readonly workspaceRevision: number }
export interface ProjectWorkspace extends WorkspacePreflight, WorkspaceRef {
  readonly mode: WorkspaceMode;
  readonly savedProjectRevision: number;
  readonly mutationId: string;
  readonly updatedAt: string;
}
/** 项目元数据版本与不可变工作区版本分别命名，updatedAt 从不用于 CAS。 */
export interface ProjectWorkspaceState {
  readonly projectId: string;
  readonly projectRevision: number;
  readonly workspaceRevision: number;
  readonly workspace: ProjectWorkspace | null;
  readonly workspaceRef: WorkspaceRef | null;
}
export interface WorkspaceInput { readonly rootPath: string | null; readonly mode: WorkspaceMode }
export interface WorkspaceSaveInput extends WorkspaceInput { readonly expectedProjectRevision: number; readonly mutationId: string }
export interface WorkspacePathIssue { readonly code: string; readonly field: "rootPath"; readonly message: string }
export interface LegacyWorkspaceSnapshot {
  readonly kind: LegacySnapshotKind;
  readonly source: LegacyConfigSnapshotRef;
  readonly rootPath: string;
  readonly preflight: WorkspacePreflight | null;
  readonly issue: WorkspacePathIssue | null;
}
export interface LegacyWorkspaceBinding {
  readonly bindingId: string;
  readonly inspectionRef: { readonly bindingId: string; readonly sourceDigest: string };
  readonly sourceIssues: readonly LegacyInspectionIssue[];
  readonly selectedSource: LegacyConfigSnapshotRef | null;
  readonly snapshots: readonly LegacyWorkspaceSnapshot[];
  readonly unresolvedReasons: readonly string[];
  readonly selectorReasons: readonly string[];
}
export interface LegacyWorkspaceMapping {
  readonly projectId: string;
  readonly sourceDigest: string;
  readonly observedAt: string;
  readonly readOnly: true;
  readonly activationAllowed: false;
  readonly bindings: readonly LegacyWorkspaceBinding[];
  readonly status: "suggestion" | "unresolved";
  readonly suggestion: { readonly rootPath: string; readonly canonicalRoot: string; readonly physicalResourceKey: string;
    readonly sources: readonly LegacyConfigSnapshotRef[] } | null;
  readonly unresolvedReasons: readonly string[];
}

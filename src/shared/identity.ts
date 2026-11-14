/** S2 稳定职责元数据；version 是 S3 不可变 versionId 的公开别名，不是显示 semver。 */
export interface RecommendedSkillRef {
  readonly skillId: string;
  readonly version: string;
  readonly contentDigest: string;
}
export interface RoleTemplateRef { readonly roleTemplateId: string; readonly revision: number }
export interface RoleTemplateInput {
  readonly name: string;
  readonly purpose: string;
  readonly instructions: string;
  readonly recommendedSkillRefs: readonly RecommendedSkillRef[];
}
export interface RoleTemplate extends RoleTemplateInput, RoleTemplateRef {
  readonly archivedAt: string | null;
  readonly copiedFrom: RoleTemplateRef | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface RoleDeleteImpact {
  readonly roleTemplateId: string;
  readonly revision: number;
  readonly deletable: boolean;
  readonly versions: readonly number[];
  readonly references: readonly { kind: "role-copy"; roleTemplateId: string; revision: number; sourceRevision: number }[];
  readonly allowedActions: readonly ("delete" | "archive")[];
}

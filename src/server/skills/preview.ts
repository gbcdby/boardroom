import type { ResolvedBoardroomEnvironment } from "../environment.ts";
import { selectLegacyConfigSnapshot } from "../identity/legacy-config-inspection.ts";
import type { LegacyBindingInspection, LegacyConfigSnapshotRef } from "../../shared/legacy-config.ts";
import type { LegacySkillServicePreview, SkillCatalogServicePreview, SkillKnownVersion, SkillSelectionSources, SkillSourceRevisions } from "../../shared/skills.ts";
import { canonical } from "./common.ts";
import { inspectLocalSkillPackages, type InspectLocalSkillOptions } from "./inventory.ts";
import { resolveSkills, skillPreviewConflict } from "./resolver.ts";

export interface SkillCatalogPreviewInput { readonly environment: ResolvedBoardroomEnvironment; readonly inventory: InspectLocalSkillOptions }
/** 不推定 skillsRoot 已存在，也不把工作区目录自动加入扫描或配置选择。 */
export async function inspectSkillCatalog(input: SkillCatalogPreviewInput): Promise<SkillCatalogServicePreview> {
  return { schemaVersion: "skill-catalog-service-preview/v1", readOnly: true, activationAllowed: false,
    environment: { layoutVersion: input.environment.layoutVersion, startupState: input.environment.startupState,
      skills: { ...input.environment.paths.skills }, materialized: false }, inventory: await inspectLocalSkillPackages(input.inventory) };
}
export interface LegacySkillPreviewInput extends SkillCatalogPreviewInput {
  readonly binding: LegacyBindingInspection;
  /** 调用方显式提供原快照关联的选择事实，不能把最新 Profile 配置塞入旧 requested/applied。 */
  readonly selectionSnapshot: {
    readonly configSnapshotRef: LegacyConfigSnapshotRef;
    readonly sources: SkillSelectionSources;
    readonly workspaceRevision: number | null;
  };
  readonly knownVersions?: readonly SkillKnownVersion[];
  readonly currentRevisions?: SkillSourceRevisions;
}
/** 服务级组合入口；无 HTTP/MCP 绑定、DB 写入、nonce 或宿主启动。 */
export async function previewLegacySkills(input: LegacySkillPreviewInput): Promise<LegacySkillServicePreview> {
  const configSelection = selectLegacyConfigSnapshot(input.binding), catalog = await inspectSkillCatalog(input);
  let resolution;
  if (configSelection.code || !configSelection.configSnapshotRef) resolution = skillPreviewConflict("config_snapshot_invalid", "S2 旧配置来源未能选择唯一有效快照");
  else if (canonical(configSelection.configSnapshotRef) !== canonical(input.selectionSnapshot.configSnapshotRef))
    resolution = skillPreviewConflict("source_changed", "选择事实不属于 S2 当前选定目标快照；需针对新的明确意图重建预览");
  else if (catalog.inventory.issues.length) resolution = skillPreviewConflict("inventory_invalid", "本地包检查存在问题，不能用部分目录结果形成成功预览");
  else resolution = resolveSkills({ packages: catalog.inventory.packages, sources: input.selectionSnapshot.sources,
    configSnapshotRef: configSelection.configSnapshotRef, workspaceRevision: input.selectionSnapshot.workspaceRevision,
    currentConfigSnapshotRef: configSelection.configSnapshotRef, ...(input.currentRevisions ? { currentRevisions: input.currentRevisions } : {}),
    ...(input.knownVersions ? { knownVersions: input.knownVersions } : {}) });
  return { ...catalog, configSelection, resolution };
}

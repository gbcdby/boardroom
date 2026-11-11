import type { LegacyConfigInspection } from "../../shared/legacy-config.ts";
import type { LegacyWorkspaceBinding, LegacyWorkspaceMapping, LegacyWorkspaceSnapshot } from "../../shared/workspace.ts";
import type { ResolvedBoardroomEnvironment } from "../environment.ts";
import { selectLegacyConfigSnapshot } from "../identity/legacy-config-inspection.ts";
import { WorkspaceError } from "./errors.ts";
import { inspectWorkspaceRoot } from "./preflight.ts";

/** 只消费已捕获的 S2 来源和唯一选择器；不重算旧意图、不迁移、不写 runtime/workdir。 */
export async function mapLegacyWorkspaces(inspection: LegacyConfigInspection, projectId: string,
  environment: ResolvedBoardroomEnvironment, selectedBindingIds?: readonly string[]): Promise<LegacyWorkspaceMapping> {
  const projectBindings = inspection.bindings.filter(binding => binding.projectId === projectId);
  const selected = selectedBindingIds === undefined ? projectBindings.map(binding => binding.bindingId) : [...new Set(selectedBindingIds)];
  if (selected.length > 256) throw new WorkspaceError("workspace_mapping_too_large", "请每次选择最多 256 个旧绑定进行目录映射。", "bindingIds");
  if (selected.some(id => !projectBindings.some(binding => binding.bindingId === id))) {
    throw new WorkspaceError("workspace_binding_out_of_project", "映射绑定不存在或不属于当前项目。", "bindingIds");
  }
  const bindings: LegacyWorkspaceBinding[] = [];
  for (const binding of projectBindings.filter(binding => selected.includes(binding.bindingId))) {
    const selection = selectLegacyConfigSnapshot(binding);
    const snapshots: LegacyWorkspaceSnapshot[] = [];
    const unresolved = new Set<string>();
    if (selection.code !== null) unresolved.add(selection.code);
    for (const source of [binding.snapshots.requested, binding.snapshots.applied, binding.snapshots.effective]) {
      if (!source) continue;
      try {
        const preflight = await inspectWorkspaceRoot(source.workdir, environment);
        snapshots.push({ kind: source.ref.kind, source: source.ref, rootPath: source.workdir, preflight, issue: null });
      } catch (error) {
        if (!(error instanceof WorkspaceError)) throw error;
        unresolved.add("snapshot_path_invalid");
        snapshots.push({ kind: source.ref.kind, source: source.ref, rootPath: source.workdir, preflight: null,
          issue: { code: error.reason, field: "rootPath", message: error.message } });
      }
    }
    const roots = new Set(snapshots.filter(source => source.preflight !== null).map(source => source.preflight!.physicalResourceKey));
    // 不把旧 applied 或最新 effective 的不同目录悄悄合并到选中的意图目录。
    if (roots.size > 1) unresolved.add("snapshot_directories_differ");
    if (snapshots.length === 0) unresolved.add("config_snapshot_missing");
    bindings.push({ bindingId: binding.bindingId, inspectionRef: { bindingId: binding.bindingId, sourceDigest: inspection.sourceDigest },
      sourceIssues: binding.issues, selectedSource: selection.configSnapshotRef, snapshots,
      unresolvedReasons: [...unresolved], selectorReasons: selection.reasons });
  }
  const unresolved = new Set(bindings.flatMap(binding => binding.unresolvedReasons));
  if (bindings.length === 0) unresolved.add("no_legacy_bindings_selected");
  const chosen = bindings.map(binding => binding.snapshots.find(source => source.source.kind === binding.selectedSource?.kind
    && source.source.digest === binding.selectedSource.digest));
  const roots = new Set(chosen.filter(source => source?.preflight).map(source => source!.preflight!.physicalResourceKey));
  if (roots.size > 1) unresolved.add("binding_directories_differ");
  if (chosen.some(source => !source?.preflight)) unresolved.add("selected_workspace_unresolved");
  const first = chosen[0];
  const suggestion = unresolved.size === 0 && first?.preflight?.canonicalRoot && first.preflight.physicalResourceKey
    ? { rootPath: first.rootPath, canonicalRoot: first.preflight.canonicalRoot, physicalResourceKey: first.preflight.physicalResourceKey,
      sources: chosen.map(source => source!.source) } : null;
  return { projectId, sourceDigest: inspection.sourceDigest, observedAt: inspection.observedAt, readOnly: true, activationAllowed: false,
    bindings, status: suggestion === null ? "unresolved" : "suggestion", suggestion, unresolvedReasons: [...unresolved] };
}

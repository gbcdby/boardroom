import type { RepositorySet } from "../db/repositories.ts";
import { NotFoundError, RepositoryError } from "../db/errors.ts";
import type { ProjectWorkspace, ProjectWorkspaceState, WorkspaceInput, WorkspacePreflight, WorkspaceRef } from "../../shared/workspace.ts";
import { WorkspaceError } from "./errors.ts";

type WorkspaceRow = { project_id: string; workspace_revision: number; project_revision: number; root_path: string | null;
  canonical_root: string | null; mode: WorkspaceInput["mode"]; root_identity_json: string | null; physical_resource_key: string | null;
  repository_info_json: string | null; observed_at: string; mutation_id: string; input_digest: string; updated_at: string };
function workspace(row: WorkspaceRow): ProjectWorkspace {
  return { projectId: row.project_id, workspaceRevision: Number(row.workspace_revision), savedProjectRevision: Number(row.project_revision),
    rootPath: row.root_path, canonicalRoot: row.canonical_root, mode: row.mode,
    rootIdentity: row.root_identity_json === null ? null : JSON.parse(row.root_identity_json), physicalResourceKey: row.physical_resource_key,
    repositoryInfo: row.repository_info_json === null ? null : JSON.parse(row.repository_info_json), observedAt: row.observed_at,
    observationOnly: true, requiresRevalidation: true, runReady: false, mutationId: row.mutation_id, updatedAt: row.updated_at };
}
export function stateOf(saved: ProjectWorkspace): ProjectWorkspaceState {
  return { projectId: saved.projectId, projectRevision: saved.savedProjectRevision, workspaceRevision: saved.workspaceRevision,
    workspace: saved, workspaceRef: { projectId: saved.projectId, workspaceRevision: saved.workspaceRevision } };
}

/** 配置唯一写源；追加版本和 head CAS 必须在共同项目 mutation scope 内。 */
export function createWorkspaceRepository(repos: RepositorySet) {
  const ctx = repos.context;
  async function get(projectId: string): Promise<ProjectWorkspaceState> {
    const row = await ctx.one<WorkspaceRow & { current_project_revision: number; current_workspace_revision: number }>(
      `SELECT p.project_revision AS current_project_revision, p.workspace_revision AS current_workspace_revision, v.*
        FROM projects p LEFT JOIN project_workspace_versions v ON v.project_id = p.id AND v.workspace_revision = p.workspace_revision WHERE p.id = ?`, [projectId]);
    if (!row) throw new NotFoundError("项目不存在。");
    const saved = row.current_workspace_revision === 0 ? null : workspace(row);
    if (row.current_workspace_revision > 0 && row.project_id === null) throw new RepositoryError("write_failed", "工作区 head 缺少对应版本，请检查配置数据。");
    return { projectId, projectRevision: Number(row.current_project_revision), workspaceRevision: Number(row.current_workspace_revision),
      workspace: saved, workspaceRef: saved === null ? null : { projectId, workspaceRevision: saved.workspaceRevision } };
  }
  async function getVersion(ref: WorkspaceRef): Promise<ProjectWorkspace | null> {
    const row = await ctx.one<WorkspaceRow>("SELECT * FROM project_workspace_versions WHERE project_id = ? AND workspace_revision = ?", [ref.projectId, ref.workspaceRevision]);
    return row ? workspace(row) : null;
  }
  async function findMutation(projectId: string, mutationId: string) {
    const row = await ctx.one<WorkspaceRow>("SELECT * FROM project_workspace_versions WHERE project_id = ? AND mutation_id = ?", [projectId, mutationId]);
    return row ? { workspace: workspace(row), inputDigest: row.input_digest } : null;
  }
  async function append(projectId: string, expectedProjectRevision: number, fields: WorkspaceInput, observed: WorkspacePreflight,
    mutationId: string, inputDigest: string, at: string): Promise<ProjectWorkspaceState> {
    const scope = repos.mutations.current();
    if (!scope) throw new RepositoryError("mutation_scope_changed", "工作区保存必须持有共同项目变更范围。");
    scope.assertCovers([projectId], []);
    const before = await get(projectId), revision = before.workspaceRevision + 1;
    const changed = await ctx.exec(`UPDATE projects SET project_revision = project_revision + 1, workspace_revision = workspace_revision + 1,
      updated_at = ? WHERE id = ? AND project_revision = ? AND archived_at IS NULL`, [at, projectId, expectedProjectRevision]);
    if (changed !== 1) throw new WorkspaceError("workspace_revision_conflict", "项目配置已变化，请刷新版本后重新保存；原草稿可保留。", "expectedProjectRevision", true);
    const projectRevision = expectedProjectRevision + 1;
    await ctx.exec(`INSERT INTO project_workspace_versions (project_id, workspace_revision, project_revision, root_path, canonical_root,
      mode, root_identity_json, physical_resource_key, repository_info_json, observed_at, mutation_id, input_digest, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [projectId, revision, projectRevision, observed.rootPath, observed.canonicalRoot, fields.mode,
      observed.rootIdentity === null ? null : JSON.stringify(observed.rootIdentity), observed.physicalResourceKey,
      observed.repositoryInfo === null ? null : JSON.stringify(observed.repositoryInfo), observed.observedAt, mutationId, inputDigest, at]);
    return stateOf({ ...observed, projectId, workspaceRevision: revision, savedProjectRevision: projectRevision, mode: fields.mode, mutationId, updatedAt: at });
  }
  return { get, getVersion, findMutation, append };
}

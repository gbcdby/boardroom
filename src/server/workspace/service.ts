import { createHash } from "node:crypto";
import { z } from "zod";
import type { RepositorySet } from "../db/repositories.ts";
import type { NewProject } from "../db/types.ts";
import type { ResolvedBoardroomEnvironment } from "../environment.ts";
import { authorizeOrThrow, type Actor } from "../authz/authorize.ts";
import { authorizeMutation, projectActive } from "../org/boundary.ts";
import { appendAuditEntry, assertCompleteAuditFields, auditActorFrom } from "../audit.ts";
import type { ProjectWorkspaceState, WorkspacePreflight, WorkspaceRef, WorkspaceSaveInput } from "../../shared/workspace.ts";
import { inspectWorkspaceRoot, revalidateWorkspaceRoot } from "./preflight.ts";
import { WorkspaceError } from "./errors.ts";
import { createWorkspaceRepository, stateOf } from "./repository.ts";

export interface WorkspaceAccess { readonly actor: Actor }
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1);
const mutationId = z.string().min(1).max(128).refine(value => value.trim() === value && !/[\r\n\0]/.test(value));
export const workspaceFieldsSchema = z.object({ rootPath: z.string().min(1).max(4096).nullable(), mode: z.enum(["isolated", "serialized"]).default("isolated") }).strict();
export const workspaceCreateSchema = workspaceFieldsSchema.extend({ mutationId }).strict();
export const workspaceSaveSchema = workspaceCreateSchema.extend({ expectedProjectRevision: revision }).strict();
export const workspaceClearSchema = z.object({ mutationId, expectedProjectRevision: revision }).strict();
export function parseWorkspaceInput<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) { const issue = parsed.error.issues[0]!;
    throw new WorkspaceError("workspace_input_invalid", `工作区字段不符合要求：${issue.message}`, issue.path.join(".") || "workspace"); }
  return parsed.data;
}
const digest = (value: WorkspaceSaveInput) => createHash("sha256").update(JSON.stringify([value.expectedProjectRevision, value.rootPath, value.mode])).digest("hex");

export function createWorkspaceService({ repos, environment, now = () => new Date() }: {
  repos: RepositorySet; environment: ResolvedBoardroomEnvironment; now?: () => Date;
}) {
  const repository = createWorkspaceRepository(repos);
  function authorize(access: WorkspaceAccess, projectId: string, capability: "project:view" | "runtime:manage") {
    authorizeOrThrow(access.actor, capability, { projectId });
  }
  async function persist(access: WorkspaceAccess, projectId: string, value: WorkspaceSaveInput, observed: WorkspacePreflight | null): Promise<ProjectWorkspaceState> {
    return repos.transaction(() => repos.mutations.run({ projectIds: [projectId], discover: async () => ({ memberIds: [], groupIds: [], runtimeIds: [] }) }, async () => {
      const actor = await authorizeMutation(repos, access, "runtime:manage", { projectId });
      await projectActive(repos, projectId);
      const previous = await repository.findMutation(projectId, value.mutationId), inputDigest = digest(value);
      if (previous) {
        if (previous.inputDigest !== inputDigest) throw new WorkspaceError("workspace_mutation_conflict", "相同 mutationId 已用于不同工作区内容。", "mutationId", true);
        return stateOf(previous.workspace);
      }
      if (!observed) throw new WorkspaceError("workspace_changed", "预检来源已失效，请重新保存。", "rootPath", true);
      await revalidateWorkspaceRoot(observed, environment);
      const before = await repository.get(projectId);
      const after = await repository.append(projectId, value.expectedProjectRevision, value, observed, value.mutationId, inputDigest, now().toISOString());
      assertCompleteAuditFields(before, after);
      const project = (await repos.projects.get(projectId))!;
      await appendAuditEntry(repos.audit, { projectId, actor: auditActorFrom(actor), action: "project.workspace_update",
        targetKind: "project", targetId: projectId, targetName: project.name, before, after, detail: { mutationId: value.mutationId, operation: "workspace_configuration_only" } });
      return after;
    }));
  }
  async function save(access: WorkspaceAccess, projectId: string, raw: WorkspaceSaveInput): Promise<ProjectWorkspaceState> {
    authorize(access, projectId, "runtime:manage");
    const value = parseWorkspaceInput(workspaceSaveSchema, raw);
    await repository.get(projectId);
    const previous = await repository.findMutation(projectId, value.mutationId);
    const observed = previous ? null : await inspectWorkspaceRoot(value.rootPath, environment, now);
    return persist(access, projectId, value, observed);
  }
  return {
    async get(access: WorkspaceAccess, projectId: string) { authorize(access, projectId, "project:view"); return repository.get(projectId); },
    async getVersion(access: WorkspaceAccess, ref: WorkspaceRef) {
      authorize(access, ref.projectId, "project:view");
      if (!Number.isSafeInteger(ref.workspaceRevision) || ref.workspaceRevision < 1) throw new WorkspaceError("workspace_input_invalid", "工作区版本必须为正整数。", "workspaceRevision");
      return repository.getVersion(ref);
    },
    async preflight(access: WorkspaceAccess, rootPath: string | null) {
      authorizeOrThrow(access.actor, "runtime:manage", {}); return inspectWorkspaceRoot(rootPath, environment, now);
    },
    async revalidate(access: WorkspaceAccess, ref: WorkspaceRef) {
      authorize(access, ref.projectId, "project:view");
      const saved = await repository.getVersion(ref);
      if (!saved) throw new WorkspaceError("workspace_changed", "保存的工作区版本不存在，请刷新项目配置。", "workspaceRevision", true);
      await revalidateWorkspaceRoot(saved, environment); return { workspaceRef: ref, requiresRevalidation: true as const, runReady: false as const };
    },
    save,
    async clear(access: WorkspaceAccess, projectId: string, raw: { expectedProjectRevision: number; mutationId: string }) {
      authorize(access, projectId, "runtime:manage");
      const value = parseWorkspaceInput(workspaceClearSchema, raw);
      // 清除绑定同样追加 root=null 版本；历史引用与模式偏好保留，绝不删除原目录。
      const previous = await repository.findMutation(projectId, value.mutationId);
      const current = previous ? stateOf(previous.workspace) : await repository.get(projectId);
      return save(access, projectId, { ...value, rootPath: null, mode: current.workspace?.mode ?? "isolated" });
    },
    async createProject(access: WorkspaceAccess, input: NewProject, raw: { rootPath: string | null; mode: "isolated" | "serialized"; mutationId: string }) {
      authorizeOrThrow(access.actor, "project:create", {}); authorizeOrThrow(access.actor, "runtime:manage", {});
      const fields = parseWorkspaceInput(workspaceCreateSchema, raw);
      const observed = await inspectWorkspaceRoot(fields.rootPath, environment, now);
      return repos.transaction(async () => {
        const project = await repos.projects.create(input);
        const workspace = await persist(access, project.id, { ...fields, expectedProjectRevision: project.projectRevision }, observed);
        return { project: (await repos.projects.get(project.id))!, workspace };
      });
    },
  };
}

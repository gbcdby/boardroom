import { computed, getCurrentInstance, getCurrentScope, inject, onScopeDispose, readonly, ref, type InjectionKey } from "vue";
import type { RouteLocationNormalized, RouteLocationRaw, Router } from "vue-router";
import { api, type ProjectDto } from "../api/client.ts";

const STORAGE_KEY = "agent-studio:lastProjectId";
interface ProjectStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export interface ProjectDraft { isDirty(): boolean; reset(): void }
interface ContextOptions {
  loadProjects?: () => Promise<ProjectDto[]>;
  storage?: ProjectStorage | null;
  confirmDiscard?: (message: string) => boolean;
}

export function projectPath(projectId: string, section = "overview", itemId?: string): string {
  return `/projects/${encodeURIComponent(projectId)}/${section}${itemId ? `/${encodeURIComponent(itemId)}` : ""}`;
}

/** 唯一项目状态源。路由确认后才提交选择，取消不会提前释放旧页面的草稿与订阅。 */
export function createCurrentProjectContext(options: ContextOptions = {}) {
  const projects = ref<ProjectDto[]>([]);
  const currentProjectId = ref<string | null>(null);
  const currentProject = computed(() => projects.value.find((project) => project.id === currentProjectId.value) ?? null);
  const readOnly = computed(() => currentProject.value?.archivedAt != null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const notice = ref<string | null>(null);
  const generation = ref(0);
  const drafts = new Set<ProjectDraft>();
  const cleanups: Array<() => void> = [];
  const redirectNotices = new Map<string, string>();
  let ready = false;
  let request = 0;
  let pending: Promise<void> | null = null;
  let router: Router | null = null;
  let storage: ProjectStorage | null = options.storage ?? null;
  if (options.storage === undefined && typeof localStorage !== "undefined") {
    try { storage = localStorage; } catch { /* 禁用存储仍可使用 URL 导航。 */ }
  }
  let remembered: string | null = null;
  try { remembered = storage?.getItem(STORAGE_KEY) ?? null; } catch { /* 存储不是可用性的前提。 */ }
  const confirmDiscard = options.confirmDiscard ?? ((message: string) => typeof window === "undefined" || window.confirm(message));
  const loadProjects = options.loadProjects ?? (async () => (await api.listProjects({ includeArchived: true })).projects);

  function fallback(): string | null {
    return projects.value.find((project) => project.id === remembered && project.archivedAt === null)?.id
      ?? projects.value.find((project) => project.archivedAt === null)?.id ?? null;
  }

  function resolveSelection(explicit?: string): { id: string | null; warning: string | null } {
    if (explicit && projects.value.some((project) => project.id === explicit)) return { id: explicit, warning: null };
    if (!explicit && projects.value.some((project) => project.id === currentProjectId.value)) return { id: currentProjectId.value, warning: null };
    const id = fallback();
    return {
      id,
      warning: explicit ? (id ? `项目不存在或无权访问，已切换到${projects.value.find((project) => project.id === id)!.name}。` : "项目不存在或无权访问，请选择或创建项目。") : null,
    };
  }

  function resetDrafts(): void { for (const draft of drafts) draft.reset(); }
  function mayLeave(): boolean {
    return ![...drafts].some((draft) => draft.isDirty()) || confirmDiscard("当前页面有未保存的内容。离开后将丢弃这些内容，是否继续？");
  }
  function commit(id: string | null): void {
    if (id === currentProjectId.value) return;
    generation.value += 1;
    currentProjectId.value = id;
    if (id) {
      remembered = id;
      try { storage?.setItem(STORAGE_KEY, id); } catch { /* 当前页状态与 URL 仍然有效。 */ }
    }
  }

  async function refreshProjects(): Promise<void> {
    const version = ++request;
    loading.value = true;
    error.value = null;
    try {
      const result = await loadProjects();
      if (version !== request) return;
      projects.value = result;
      ready = true;
      if (currentProjectId.value && !result.some((project) => project.id === currentProjectId.value)) {
        const next = fallback();
        if (router) {
          await router.replace(next ? projectPath(next) : "/projects");
        } else if (mayLeave()) { resetDrafts(); commit(next); }
      } else if (currentProjectId.value === null && router && router.currentRoute.value.matched.length > 0) {
        const route = router.currentRoute.value;
        await router.replace({ path: route.path, query: route.query, hash: route.hash, force: true });
      }
    } catch (err) {
      if (version === request) error.value = err instanceof Error ? err.message : "项目读取失败，请重试。";
    } finally {
      if (version === request) loading.value = false;
    }
  }

  async function ensureProjects(): Promise<void> {
    if (ready) return;
    if (!pending) pending = refreshProjects().finally(() => { pending = null; });
    await pending;
  }

  function requestedProject(route: RouteLocationNormalized): string | undefined {
    const value = route.params["projectId"] ?? route.query["projectId"];
    return typeof value === "string" && value ? value : undefined;
  }

  function installRouter(nextRouter: Router): void {
    router = nextRouter;
    cleanups.push(router.beforeEach(async (to, from) => {
      await ensureProjects();
      if (error.value) return from.matched.length === 0 || to.fullPath === from.fullPath || mayLeave();
      const explicit = requestedProject(to);
      const choice = resolveSelection(explicit);
      const section = typeof to.meta["projectSection"] === "string" ? to.meta["projectSection"] : (["/projects", "/"].includes(to.path) && explicit ? "overview" : null);
      if (section) {
        const query = { ...to.query };
        delete query["projectId"];
        const group = to.params["groupId"] ?? query["groupId"];
        const item = section === "chat" ? group : to.params["taskId"];
        if (section === "chat") delete query["groupId"];
        const target = { path: choice.id ? projectPath(choice.id, section, typeof item === "string" ? item : undefined) : "/projects", query, hash: to.hash, replace: true };
        const fullPath = nextRouter.resolve(target).fullPath;
        if (choice.warning) redirectNotices.set(fullPath, choice.warning);
        if (fullPath !== to.fullPath) return target;
      } else if (choice.warning) {
        const target = { path: to.path, query: { ...to.query, projectId: choice.id ?? undefined }, hash: to.hash, replace: true };
        const fullPath = nextRouter.resolve(target).fullPath;
        redirectNotices.set(fullPath, choice.warning);
        if (fullPath !== to.fullPath) return target;
      }
      if (from.matched.length > 0 && to.fullPath !== from.fullPath && !mayLeave()) {
        redirectNotices.clear();
        return false;
      }
      return true;
    }));
    cleanups.push(router.afterEach((to, from, failure) => {
      if (failure || !ready) return;
      if (to.fullPath !== from.fullPath) resetDrafts();
      commit(resolveSelection(requestedProject(to)).id);
      const warning = redirectNotices.get(to.fullPath);
      if (warning) notice.value = warning;
      redirectNotices.clear();
    }));
  }

  async function selectProject(id: string): Promise<boolean> {
    await ensureProjects();
    if (!projects.value.some((project) => project.id === id)) return false;
    if (id === currentProjectId.value) return true;
    if (!router) {
      if (!mayLeave()) return false;
      resetDrafts(); commit(id); return true;
    }
    const current = router.currentRoute.value;
    const section = typeof current.meta["projectSection"] === "string" ? current.meta["projectSection"] : "overview";
    const target: RouteLocationRaw = current.path === "/runtimes" ? { path: "/runtimes", query: { projectId: id } } : projectPath(id, section);
    await router.push(target);
    return currentProjectId.value === id;
  }

  function registerDraft(draft: ProjectDraft): () => void { drafts.add(draft); return () => drafts.delete(draft); }
  if (typeof window !== "undefined") {
    const onStorage = (event: StorageEvent) => { if (event.key === STORAGE_KEY) remembered = event.newValue; };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if ([...drafts].some((draft) => draft.isDirty())) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("beforeunload", beforeUnload);
    cleanups.push(() => { window.removeEventListener("storage", onStorage); window.removeEventListener("beforeunload", beforeUnload); });
  }

  return {
    projects: readonly(projects), currentProjectId: readonly(currentProjectId), currentProject,
    readonly: readOnly, loading: readonly(loading), error: readonly(error), notice: readonly(notice), generation: readonly(generation),
    ensureProjects, refreshProjects, selectProject, registerDraft, installRouter,
    dismissNotice: () => { notice.value = null; },
    announce: (message: string) => { notice.value = message; },
    dispose: () => { request++; for (const cleanup of cleanups) cleanup(); drafts.clear(); },
  };
}

const currentProject = createCurrentProjectContext();
export type CurrentProjectContext = ReturnType<typeof createCurrentProjectContext>;
export const currentProjectKey: InjectionKey<CurrentProjectContext> = Symbol("current-project");
export function useCurrentProject() { return getCurrentInstance() ? inject(currentProjectKey, currentProject) : currentProject; }
export function useProjectDraft(isDirty: ProjectDraft["isDirty"], reset: ProjectDraft["reset"]): void {
  const unregister = useCurrentProject().registerDraft({ isDirty, reset });
  if (getCurrentScope()) onScopeDispose(unregister);
}

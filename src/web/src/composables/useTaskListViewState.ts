import { computed, reactive, watch } from "vue";
import type { RouteLocationNormalized, RouterScrollBehavior } from "vue-router";
import type { CurrentProjectContext } from "./useCurrentProject.ts";

interface TaskListViewState { layout: "board" | "list"; filter: string }
// 仅缓存列表展示；以应用上下文和项目隔离，不缓存业务数据或创建草稿。
const states = new WeakMap<CurrentProjectContext, Map<string, TaskListViewState>>();
interface TaskListRender { ready: Promise<boolean>; complete(): void; cancel(): void }
const renders = new WeakMap<CurrentProjectContext, Map<string, TaskListRender>>();

function initialState(): TaskListViewState {
  return reactive({ layout: typeof matchMedia !== "undefined" && matchMedia("(max-width: 760px)").matches ? "list" : "board", filter: "" });
}

export function useTaskListViewState(context: CurrentProjectContext) {
  const projects = states.get(context) ?? new Map<string, TaskListViewState>();
  states.set(context, projects);
  const withoutProject = initialState();
  function current(): TaskListViewState {
    const id = context.currentProjectId.value;
    if (!id) return withoutProject;
    let state = projects.get(id);
    if (!state) { state = initialState(); projects.set(id, state); }
    return state;
  }
  return {
    layout: computed({ get: () => current().layout, set: (value: TaskListViewState["layout"]) => { current().layout = value; } }),
    filter: computed({ get: () => current().filter, set: (value: string) => { current().filter = value; } }),
  };
}

/** 每次列表读取拥有独立就绪信号；完成须在 Vue 提交列表 DOM 之后。 */
export function beginTaskListRender(context: CurrentProjectContext, projectId: string): TaskListRender {
  const projects = renders.get(context) ?? new Map<string, TaskListRender>();
  renders.set(context, projects);
  projects.get(projectId)?.cancel();
  let resolve!: (ready: boolean) => void;
  const render: TaskListRender = {
    ready: new Promise<boolean>(done => { resolve = done; }),
    complete: () => { if (projects.get(projectId) === render) resolve(true); },
    cancel: () => { if (projects.get(projectId) === render) projects.delete(projectId); resolve(false); },
  };
  projects.set(projectId, render);
  return render;
}

export function createTaskListScrollBehavior(context: CurrentProjectContext, currentRoute: () => RouteLocationNormalized): RouterScrollBehavior {
  return async (to, _from, saved) => {
    const projectId = to.params["projectId"];
    if (saved && to.meta["projectSection"] === "tasks" && !to.params["taskId"] && typeof projectId === "string") {
      const render = renders.get(context)?.get(projectId);
      if (!render || currentRoute() !== to) return false;
      const ready = await new Promise<boolean>(resolve => {
        let finished = false;
        const finish = (value: boolean) => { if (!finished) { finished = true; stop(); resolve(value); } };
        const stop = watch(currentRoute, route => { if (route !== to) finish(false); }, { flush: "sync" });
        void render.ready.then(finish);
      });
      if (!ready || currentRoute() !== to) return false;
    }
    return saved ?? (to.hash ? { el: to.hash, top: 24 } : { top: 0 });
  };
}

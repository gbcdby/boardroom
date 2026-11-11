import { computed, reactive } from "vue";
import type { CurrentProjectContext } from "./useCurrentProject.ts";

interface TaskListViewState { layout: "board" | "list"; filter: string }
// 仅缓存列表展示；以应用上下文和项目隔离，不缓存业务数据或创建草稿。
const states = new WeakMap<CurrentProjectContext, Map<string, TaskListViewState>>();

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

import { createRouter, createWebHistory } from "vue-router";
import HomeView from "./views/HomeView.vue";
import ProjectsView from "./views/ProjectsView.vue";
import ChatView from "./views/ChatView.vue";
import StatusBoardView from "./views/StatusBoardView.vue";
import OrgView from "./views/OrgView.vue";
import AuditView from "./views/AuditView.vue";
import RuntimesView from "./views/RuntimesView.vue";
import PlaceholderView from "./views/PlaceholderView.vue";
import TasksView from "./views/TasksView.vue";
import TaskDetailView from "./views/TaskDetailView.vue";
import { useCurrentProject } from "./composables/useCurrentProject.ts";

/**
 * 阶段 1 的 WebUI 路由。
 *
 * T1（#14）起 `/projects` 为真实页面（创建项目/群组、管理成员、指定 manager）；
 * T4（#17）新增 `/status` 状态看板（在线/离线/等待/工作、断线/陈旧、实时更新）。
 * T2（#49）新增 `/org` 组织树管理页与角色配置入口（#32/#33 收口的信息架构）。
 * T5（#52）新增 `/audit` 审计查看与人的撤销权（最小可用）。
 * 群组页 `/groups` 暂由项目工作台承载；其余路由先占位。
 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "home", component: HomeView },
    { path: "/projects", name: "projects", component: ProjectsView },
    { path: "/projects/:projectId/overview", name: "project-overview", component: ProjectsView, meta: { projectSection: "overview", title: "项目概览" } },
    { path: "/projects/:projectId/members", name: "project-members", component: ProjectsView, meta: { projectSection: "members", title: "成员" } },
    { path: "/projects/:projectId/org", name: "project-org", component: OrgView, meta: { projectSection: "org", title: "组织与角色" } },
    { path: "/projects/:projectId/audit", name: "project-audit", component: AuditView, meta: { projectSection: "audit", title: "审计与撤销" } },
    { path: "/projects/:projectId/chat/:groupId?", name: "project-chat", component: ChatView, meta: { projectSection: "chat", title: "群聊" } },
    { path: "/projects/:projectId/status", name: "project-status", component: StatusBoardView, meta: { projectSection: "status", title: "状态看板" } },
    { path: "/projects/:projectId/tasks", name: "project-tasks", component: TasksView, meta: { projectSection: "tasks", title: "任务" } },
    { path: "/projects/:projectId/tasks/:taskId", name: "task-detail", component: TaskDetailView, meta: { projectSection: "tasks", title: "任务详情" } },
    { path: "/org", name: "org", component: OrgView, meta: { projectSection: "org" } },
    { path: "/audit", name: "audit", component: AuditView, meta: { projectSection: "audit" } },
    { path: "/runtimes", name: "runtimes", component: RuntimesView },
    { path: "/chat", name: "chat", component: ChatView, meta: { projectSection: "chat" } },
    { path: "/status", name: "status", component: StatusBoardView, meta: { projectSection: "status" } },
    { path: "/tasks", name: "tasks", component: TasksView, meta: { projectSection: "tasks" } },
    { path: "/groups", name: "groups", redirect: "/chat" },
    { path: "/members", name: "members", component: ProjectsView, meta: { projectSection: "members" } },
    { path: "/settings", name: "settings", component: PlaceholderView, props: { title: "设置" } },
    { path: "/:pathMatch(.*)*", name: "not-found", component: PlaceholderView, props: { title: "页面不存在" } },
  ],
});
useCurrentProject().installRouter(router);

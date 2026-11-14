import { createRouter, createWebHistory } from "vue-router";
import HomeView from "./views/HomeView.vue";
import ProjectsView from "./views/ProjectsView.vue";
import ChatView from "./views/ChatView.vue";
import ProjectChatView from "./views/ProjectChatView.vue";
import ProjectMembersView from "./views/ProjectMembersView.vue";
import StatusBoardView from "./views/StatusBoardView.vue";
import OrgView from "./views/OrgView.vue";
import AuditView from "./views/AuditView.vue";
import RuntimesView from "./views/RuntimesView.vue";
import PlaceholderView from "./views/PlaceholderView.vue";
import TasksView from "./views/TasksView.vue";
import TaskDetailView from "./views/TaskDetailView.vue";
import MemoryView from "./views/MemoryView.vue";
import SettingsView from "./views/SettingsView.vue";
import { useCurrentProject } from "./composables/useCurrentProject.ts";
import { createTaskListScrollBehavior } from "./composables/useTaskListViewState.ts";

/**
 * S6：全局页与项目容器分别组织。旧入口由共享项目守卫规范化，
 * 保留 query/hash 与显式项目身份；未实现的协作图和实例会话不注册占位入口。
 */
const context = useCurrentProject();
export const router = createRouter({
  history: createWebHistory(),
  scrollBehavior: createTaskListScrollBehavior(context, () => router.currentRoute.value),
  routes: [
    { path: "/", name: "home", component: HomeView, meta: { title: "协作总览" } },
    { path: "/projects", name: "projects", component: ProjectsView, meta: { title: "所有项目" } },
    { path: "/projects/:projectId/overview", name: "project-overview", component: ProjectsView, meta: { projectSection: "overview", title: "项目概览" } },
    { path: "/projects/:projectId/members", name: "project-members", component: ProjectMembersView, meta: { projectSection: "members", title: "成员" } },
    { path: "/projects/:projectId/org", name: "project-org", component: OrgView, meta: { projectSection: "org", title: "组织与角色" } },
    { path: "/projects/:projectId/audit", name: "project-audit", component: AuditView, meta: { projectSection: "audit", title: "审计与撤销" } },
    { path: "/projects/:projectId/chat/:groupId?", name: "project-chat", component: ProjectChatView, meta: { projectSection: "chat", title: "群聊" } },
    { path: "/projects/:projectId/status", name: "project-status", component: StatusBoardView, meta: { projectSection: "status", title: "状态看板" } },
    { path: "/projects/:projectId/tasks", name: "project-tasks", component: TasksView, meta: { projectSection: "tasks", title: "任务" } },
    { path: "/projects/:projectId/tasks/:taskId", name: "task-detail", component: TaskDetailView, meta: { projectSection: "tasks", title: "任务详情" } },
    { path: "/projects/:projectId/memory", name: "project-memory", component: MemoryView, meta: { projectSection: "memory", title: "记忆" } },
    { path: "/projects/:projectId/knowledge", name: "project-knowledge", component: MemoryView, meta: { projectSection: "knowledge", title: "知识" } },
    { path: "/projects/:projectId/activity", name: "project-activity", component: AuditView, meta: { projectSection: "activity", title: "活动与审计" } },
    { path: "/projects/:projectId/settings", name: "project-settings", component: ProjectsView, meta: { projectSection: "settings", title: "项目设置" } },
    { path: "/projects/:projectId/groups", name: "project-groups", component: ProjectChatView, meta: { projectSection: "groups", title: "讨论" } },
    { path: "/org", name: "org", component: OrgView, meta: { projectSection: "org" } },
    { path: "/audit", name: "audit", component: AuditView, meta: { projectSection: "audit" } },
    { path: "/runtimes", name: "runtimes", redirect: to => ({ path: "/collaboration/connections", query: to.query, hash: to.hash }) },
    { path: "/collaboration/connections", name: "connections", component: RuntimesView, meta: { title: "连接与实例" } },
    { path: "/chat", name: "chat", component: ChatView, meta: { projectSection: "chat" } },
    { path: "/status", name: "status", component: StatusBoardView, meta: { projectSection: "status" } },
    { path: "/tasks", name: "tasks", component: TasksView, meta: { projectSection: "tasks" } },
    { path: "/memory", name: "memory", component: MemoryView, meta: { projectSection: "memory", title: "记忆" } },
    { path: "/groups", name: "groups", component: ProjectChatView, meta: { projectSection: "groups" } },
    { path: "/members", name: "members", component: ProjectsView, meta: { projectSection: "members" } },
    { path: "/settings", name: "settings", component: SettingsView, meta: { title: "设置" } },
    { path: "/:pathMatch(.*)*", name: "not-found", component: PlaceholderView, props: { title: "页面不存在" } },
  ],
});
context.installRouter(router);

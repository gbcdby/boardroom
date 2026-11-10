import { createRouter, createWebHistory } from "vue-router";
import HomeView from "./views/HomeView.vue";
import ProjectsView from "./views/ProjectsView.vue";
import ChatView from "./views/ChatView.vue";
import StatusBoardView from "./views/StatusBoardView.vue";
import OrgView from "./views/OrgView.vue";
import AuditView from "./views/AuditView.vue";
import RuntimesView from "./views/RuntimesView.vue";
import PlaceholderView from "./views/PlaceholderView.vue";

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
    { path: "/org", name: "org", component: OrgView },
    { path: "/audit", name: "audit", component: AuditView },
    { path: "/runtimes", name: "runtimes", component: RuntimesView },
    { path: "/chat", name: "chat", component: ChatView },
    { path: "/status", name: "status", component: StatusBoardView },
    { path: "/groups", name: "groups", redirect: "/chat" },
    { path: "/members", name: "members", redirect: "/status" },
    { path: "/settings", name: "settings", component: PlaceholderView, props: { title: "设置" } },
    { path: "/:pathMatch(.*)*", name: "not-found", component: PlaceholderView, props: { title: "页面不存在" } },
  ],
});

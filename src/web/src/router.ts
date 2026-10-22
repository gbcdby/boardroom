import { createRouter, createWebHistory } from "vue-router";
import HomeView from "./views/HomeView.vue";
import ProjectsView from "./views/ProjectsView.vue";
import PlaceholderView from "./views/PlaceholderView.vue";

/**
 * 阶段 1 的 WebUI 路由。
 *
 * T1（#14）起 `/projects` 为真实页面（创建项目/群组、管理成员、指定 manager）；
 * 群组页 `/groups` 暂由项目工作台承载（阶段 1 只验收单个项目/群组，群组在项目页内创建），
 * 其余路由先占位，后续 ticket（T4 状态看板）再填充。静态服务对未知前端路由
 * 回落到 index.html，因此刷新不会 404。
 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "home", component: HomeView },
    { path: "/projects", name: "projects", component: ProjectsView },
    { path: "/groups", name: "groups", redirect: "/projects" },
    { path: "/members", name: "members", redirect: "/projects" },
    { path: "/settings", name: "settings", component: PlaceholderView, props: { title: "设置" } },
    { path: "/:pathMatch(.*)*", name: "not-found", component: PlaceholderView, props: { title: "页面不存在" } },
  ],
});

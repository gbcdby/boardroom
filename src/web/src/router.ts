import { createRouter, createWebHistory } from "vue-router";
import HomeView from "./views/HomeView.vue";
import PlaceholderView from "./views/PlaceholderView.vue";

/**
 * 阶段 1 的 WebUI 骨架路由。
 *
 * 只有首页是真实页面；其余路由先占位，后续 ticket（T1 项目/群组、T4 状态看板）
 * 再填充。静态服务对未知前端路由回落到 index.html，因此刷新不会 404。
 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "home", component: HomeView },
    { path: "/projects", name: "projects", component: PlaceholderView, props: { title: "项目" } },
    { path: "/groups", name: "groups", component: PlaceholderView, props: { title: "群组" } },
    { path: "/members", name: "members", component: PlaceholderView, props: { title: "成员与状态" } },
    { path: "/settings", name: "settings", component: PlaceholderView, props: { title: "设置" } },
    { path: "/:pathMatch(.*)*", name: "not-found", component: PlaceholderView, props: { title: "页面不存在" } },
  ],
});

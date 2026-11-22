<script setup lang="ts">
import { ref } from "vue";
import { useRoute, RouterLink } from "vue-router";
import AppIcon from "../components/AppIcon.vue";

// 静态视觉演示：角色与 MCP 能力页（原型 P05）。全部为示例数据，非真实运行数据。
const route = useRoute();
const activeTab = ref("MCP");
const tabs = ["角色", "Agent", "Skills", "MCP"];
const capabilities = [
  { name: "读取代码仓库", icon: "grid", scope: "当前项目 · 只读", load: "常驻", state: "已加载", tone: "ok", selected: false },
  { name: "网页预览", icon: "app", scope: "当前项目", load: "按需", state: "已加载", tone: "ok", selected: true },
  { name: "文档检索", icon: "folder", scope: "项目允许的资料", load: "按需", state: "未加载", tone: "idle", selected: false },
  { name: "生产部署", icon: "arrow", scope: "未授权", load: "不可加载", state: "未授权", tone: "idle", selected: false },
];
const detail = {
  name: "网页预览", group: "界面升级小组 / 前端工程师",
  state: "已加载", reason: "页面验证任务", configSource: "Agent 预设", authSource: "项目策略",
  checks: ["已登记", "已授权", "本轮已加载"],
  effect: "下一轮按需装载", note: "普通配置变更在安全边界应用",
};
const selectedCap = ref(capabilities[1]!.name);
function selectCap(name: string): void { selectedCap.value = name; }
</script>

<template>
  <section class="page cap-demo-page">
    <header class="page-header cap-demo-header">
      <div class="header-title"><span class="page-icon"><AppIcon name="layers" :size="24" /></span><div><h1>角色与能力</h1><p class="page-description">查看角色的能力、授权范围与实际加载状态。</p></div></div>
    </header>

    <section class="panel cap-demo-panel">
      <div class="cap-tabs" role="tablist" aria-label="能力分类"><button v-for="tab in tabs" :key="tab" type="button" role="tab" :aria-selected="activeTab === tab" @click="activeTab = tab">{{ tab }}</button></div>
      <div class="cap-toolbar">
        <button type="button" class="toolbar-control cap-select" aria-disabled="true" title="静态演示控件"><span class="avatar avatar-sm avatar-2">前</span>前端工程师<AppIcon name="chevron" :size="14" /></button>
        <button type="button" class="toolbar-control cap-select" aria-disabled="true" title="静态演示控件"><AppIcon name="people" :size="16" />界面升级小组 · 当前实例<AppIcon name="chevron" :size="14" /></button>
        <button type="button" class="toolbar-control manage-mcp" aria-disabled="true" title="静态演示控件"><AppIcon name="settings" :size="16" />管理全局 MCP</button>
      </div>
      <p class="cap-summary muted small">4 项能力 · 3 项已授权 · 2 项本轮已加载</p>
      <div class="cap-layout">
        <div class="cap-table-wrap">
          <table class="cap-table">
            <thead><tr><th>能力</th><th>授权范围</th><th>加载方式</th><th>当前状态</th></tr></thead>
            <tbody>
              <tr v-for="cap in capabilities" :key="cap.name" :class="{ selected: selectedCap === cap.name }" @click="selectCap(cap.name)">
                <td><span class="cap-name"><span class="cap-icon"><AppIcon :name="cap.icon" :size="17" /></span>{{ cap.name }}</span></td>
                <td>{{ cap.scope }}</td>
                <td>{{ cap.load }}</td>
                <td><span class="status-badge" :class="cap.tone"><span class="state-dot" aria-hidden="true"></span>{{ cap.state }}</span></td>
              </tr>
            </tbody>
          </table>
        </div>
        <aside class="cap-detail" aria-label="能力详情">
          <div class="cap-detail-head"><span class="cap-detail-icon"><AppIcon name="app" :size="22" /></span><div><h2>{{ detail.name }}</h2><p class="muted small">{{ detail.group }}</p></div><button type="button" class="inspector-close" aria-label="关闭能力详情" aria-disabled="true" title="静态演示控件"><AppIcon name="close" :size="16" /></button></div>
          <dl class="cap-facts"><div><dt>当前状态</dt><dd><span class="status-badge ok"><span class="state-dot" aria-hidden="true"></span>{{ detail.state }}</span></dd></div><div><dt>加载原因</dt><dd>{{ detail.reason }}</dd></div><div><dt>配置来源</dt><dd>{{ detail.configSource }}</dd></div><div><dt>授权来源</dt><dd>{{ detail.authSource }}</dd></div></dl>
          <ul class="cap-checks"><li v-for="check in detail.checks" :key="check"><span class="check-ok"><AppIcon name="check" :size="13" /></span>{{ check }}</li></ul>
          <p class="cap-check-note muted small">授权与实际加载分别记录</p>
          <div class="cap-effect"><span>生效方式</span><button type="button" class="toolbar-control" aria-disabled="true" title="静态演示控件">{{ detail.effect }}<AppIcon name="chevron" :size="14" /></button></div>
          <p class="cap-effect-note muted small">{{ detail.note }}</p>
          <div class="cap-actions"><button type="button" class="primary" aria-disabled="true" title="静态演示控件">保存预设</button><button type="button" class="toolbar-control" aria-disabled="true" title="静态演示控件">查看实例能力</button></div>
        </aside>
      </div>
    </section>
  </section>
</template>

<style scoped>
.header-title { display: flex; align-items: center; gap: 14px; min-width: 0; }
.page-icon { width: 50px; height: 50px; flex: none; display: grid; place-items: center; border-radius: 12px; background: var(--surface-subtle); color: var(--fg); }
.header-title h1 { margin: 0; font-size: 2rem; line-height: 1.25; }
.cap-demo-header { align-items: center; margin-bottom: 18px; }
.cap-demo-panel { padding: 0; overflow: hidden; }
.cap-tabs { display: flex; gap: 24px; padding: 14px 18px 0; border-bottom: 1px solid var(--border); }.cap-tabs button { border: 0; border-radius: 0; background: transparent; color: var(--muted); font-size: .9rem; min-height: 0; padding: 8px 0; }.cap-tabs button[aria-selected="true"] { color: var(--fg); font-weight: 600; box-shadow: inset 0 -2px var(--accent); }
.cap-toolbar { display: flex; flex-wrap: wrap; gap: 10px; padding: 16px 18px 0; }.cap-select { display: inline-flex; align-items: center; gap: 7px; }.manage-mcp { margin-left: auto; }
.cap-summary { padding: 12px 18px 0; margin: 0; }
.cap-layout { display: grid; grid-template-columns: minmax(0,1fr) 310px; gap: 0; margin-top: 14px; }
.cap-table-wrap { overflow-x: auto; padding: 0 18px 18px; }
.cap-table { width: 100%; border-collapse: collapse; font-size: .85rem; }.cap-table th { text-align: left; font-weight: 600; color: var(--muted); font-size: .8rem; padding: 12px 14px; border-bottom: 1px solid var(--border); background: var(--surface-subtle); }.cap-table th:first-child { border-radius: 8px 0 0 0; }.cap-table th:last-child { border-radius: 0 8px 0 0; }.cap-table td { padding: 14px; border-bottom: 1px solid var(--border); }.cap-table tbody tr { cursor: pointer; }.cap-table tbody tr:hover { background: var(--surface-subtle); }.cap-table tbody tr.selected { background: var(--accent-soft); }.cap-table tbody tr.selected td:first-child { box-shadow: inset 3px 0 var(--accent); }
.cap-name { display: inline-flex; align-items: center; gap: 10px; font-weight: 500; }.cap-icon { color: var(--accent); display: inline-flex; width: 26px; height: 26px; align-items: center; justify-content: center; border: 1px solid var(--border); border-radius: 7px; }
.state-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; margin-right: 4px; display: inline-block; }
.cap-detail { border-left: 1px solid var(--border); padding: 18px; }.cap-detail-head { display: flex; align-items: flex-start; gap: 11px; }.cap-detail-icon { width: 40px; height: 40px; display: grid; place-items: center; border: 1px solid var(--border); border-radius: 10px; flex: none; }.cap-detail-head > div { flex: 1; }.cap-detail-head h2 { margin: 0; font-size: 1rem; }.cap-detail-head p { margin: 4px 0 0; }
.cap-facts { margin: 18px 0 0; }.cap-facts > div { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border); font-size: .82rem; }.cap-facts dt { color: var(--muted); }.cap-facts dd { margin: 0; text-align: right; }
.cap-checks { list-style: none; margin: 18px 0 0; padding: 0; background: var(--accent-soft); border-radius: 10px; padding: 10px 13px; }.cap-checks li { display: flex; align-items: center; gap: 9px; padding: 6px 0; font-size: .84rem; }.check-ok { width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; background: var(--ok); color: var(--card-bg); flex: none; }.cap-check-note { margin: 8px 0 0; }
.cap-effect { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border); font-size: .84rem; }.cap-effect button { min-height: 32px; }.cap-effect-note { margin: 8px 0 0; }
.cap-actions { display: flex; gap: 10px; margin-top: 20px; }.cap-actions button { flex: 1; }
@media (max-width: 900px) { .cap-layout { grid-template-columns: 1fr; }.cap-detail { border-left: 0; border-top: 1px solid var(--border); }.manage-mcp { margin-left: 0; } }
</style>

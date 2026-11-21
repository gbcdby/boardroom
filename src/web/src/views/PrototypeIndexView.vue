<script setup lang="ts">
import { ref } from "vue";
import AppIcon from "../components/AppIcon.vue";

// 原型 v2 五页的统一 split view：左侧页面列表，右侧实时预览对应页面。
// 每页都是静态视觉演示，与真实功能隔离。
const pages = [
  { id: "p01", no: "P01", title: "协作总览", desc: "群架构、成员关系、消息方向", src: "/", icon: "layers" },
  { id: "p02", no: "P02", title: "图内成员会话", desc: "点成员节点展开会话面板", src: "/?view=conversation", icon: "message" },
  { id: "p03", no: "P03", title: "任务流转", desc: "阶段看板与任务详情", src: "/?view=tasks", icon: "grid" },
  { id: "p04", no: "P04", title: "群组聊天", desc: "消息、任务卡与群实例", src: "/demo/p04", icon: "message" },
  { id: "p05", no: "P05", title: "角色与 MCP", desc: "能力、授权与加载状态", src: "/demo/p05", icon: "settings" },
];
const activeId = ref("p01");
const active = () => pages.find((p) => p.id === activeId.value) ?? pages[0]!;
function select(id: string): void { activeId.value = id; }
function openInNewTab(): void { window.open(active().src, "_blank", "noopener"); }
</script>

<template>
  <section class="page prototype-index">
    <header class="page-header proto-header">
      <div><h1>原型浏览 <span class="proto-badge">split view</span></h1><p class="page-description">BR-COLLAB-PROTOTYPE-20261112-v2 · 左侧选页，右侧实时预览。全部为静态演示数据。</p></div>
      <button type="button" class="toolbar-control" title="在新标签页打开当前页" @click="openInNewTab"><AppIcon name="arrow" :size="15" />新标签打开</button>
    </header>

    <div class="proto-split">
      <aside class="proto-nav" aria-label="原型页面列表">
        <button v-for="page in pages" :key="page.id" type="button" class="proto-nav-item" :class="{ active: activeId === page.id }" :aria-pressed="activeId === page.id" @click="select(page.id)">
          <span class="proto-nav-no">{{ page.no }}</span>
          <span class="proto-nav-icon"><AppIcon :name="page.icon" :size="19" /></span>
          <span class="proto-nav-copy"><strong>{{ page.title }}</strong><small>{{ page.desc }}</small></span>
        </button>
        <p class="proto-nav-note muted small">P01–P03 在首页通过 tab / 节点切换；P04/P05 为独立演示路由。</p>
      </aside>
      <div class="proto-preview">
        <div class="proto-preview-bar"><span class="proto-preview-title"><AppIcon name="layers" :size="15" />{{ active().no }} · {{ active().title }}</span><code class="proto-preview-url">{{ active().src }}</code></div>
        <iframe :key="activeId" :src="active().src" class="proto-frame" :title="`${active().no} ${active().title} 预览`" loading="lazy"></iframe>
      </div>
    </div>
  </section>
</template>

<style scoped>
.proto-header { align-items: center; }.proto-badge { font-size: .7rem; font-weight: 600; color: var(--accent); background: var(--accent-soft); border-radius: 5px; padding: 2px 8px; vertical-align: middle; margin-left: 6px; }
.proto-split { display: grid; grid-template-columns: 262px minmax(0, 1fr); gap: 16px; height: calc(100vh - 210px); min-height: 520px; }
.proto-nav { display: flex; flex-direction: column; gap: 6px; padding: 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--card-bg); overflow-y: auto; }
.proto-nav-item { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 11px; border: 1px solid transparent; border-radius: 9px; background: transparent; color: var(--fg); min-height: 0; }
.proto-nav-item:hover { background: var(--surface-subtle); }.proto-nav-item.active { background: var(--accent-soft); border-color: var(--accent); }
.proto-nav-no { font-size: .68rem; font-weight: 700; color: var(--muted); width: 30px; flex: none; }.proto-nav-item.active .proto-nav-no { color: var(--accent); }
.proto-nav-icon { color: var(--muted); flex: none; }.proto-nav-item.active .proto-nav-icon { color: var(--accent); }
.proto-nav-copy { min-width: 0; flex: 1; }.proto-nav-copy strong { display: block; font-size: .86rem; }.proto-nav-copy small { display: block; font-size: .72rem; color: var(--muted); margin-top: 3px; line-height: 1.4; }
.proto-nav-note { margin: auto 4px 0; line-height: 1.5; }
.proto-preview { display: flex; flex-direction: column; min-width: 0; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-subtle); overflow: hidden; }
.proto-preview-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--border); background: var(--card-bg); }.proto-preview-title { display: inline-flex; align-items: center; gap: 7px; font-size: .82rem; font-weight: 600; }.proto-preview-title .app-icon { color: var(--accent); }.proto-preview-url { font-size: .72rem; color: var(--muted); }
.proto-frame { flex: 1; width: 100%; border: 0; background: var(--card-bg); }
@media (max-width: 760px) { .proto-split { grid-template-columns: 1fr; height: auto; }.proto-nav { flex-direction: row; flex-wrap: wrap; max-height: none; }.proto-nav-item { flex: 1 1 140px; }.proto-nav-note { flex-basis: 100%; margin: 4px; }.proto-frame { min-height: 520px; } }
</style>

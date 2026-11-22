<script setup lang="ts">
import { ref } from "vue";
import { useRoute, RouterLink } from "vue-router";
import AppIcon from "../components/AppIcon.vue";

// 静态视觉演示：群组聊天页（原型 P04）。全部为示例数据，非真实运行数据。
const route = useRoute();
const activeTab = ref("聊天");
const tabs = ["聊天", "任务", "资料", "成员"];
const messages = [
  { who: "你", initials: "我", avatar: 6, time: "14:32", text: "默认先看协作总览，点击成员查看会话。", mine: true },
  { who: "项目负责人", initials: "负", avatar: 6, time: "14:35", text: "已按确认的方向安排，先推进会话与图的联动。", mine: false },
  { who: "产品设计师", initials: "产", avatar: 1, time: "14:38", text: "最终原型已更新，相关页面使用同一套视觉规范。", mine: false },
  { who: "前端工程师", initials: "前", avatar: 2, time: "14:41", text: "正在实现成员选中与会话侧栏。", mine: false },
];
const instances = [
  { name: "产品设计师", initials: "产", avatar: 1, status: "方案已提交", tone: "active" },
  { name: "前端工程师", initials: "前", avatar: 2, status: "执行中", tone: "active" },
];
const relatedTasks = [
  { title: "协作总览升级", state: "执行中", tone: "active", owner: "前端工程师", checked: true },
  { title: "会话与图联动", state: "进行中", tone: "active", owner: "产品设计师", checked: false },
  { title: "成员状态样式更新", state: "待办", tone: "wait", owner: "产品设计师", checked: false },
];
const chatTasks = [
  { kind: "task", icon: "check", title: "协作总览升级", state: "执行中", owner: "前端工程师", action: "查看任务" },
  { kind: "decision", icon: "layers", title: "扩大工具使用范围", state: "待你确认", owner: "原因：项目策略要求确认", action: "查看事项" },
];
const draft = ref("");
</script>

<template>
  <section class="page chat-demo-page">
    <header class="page-header chat-demo-header">
      <div class="header-title"><span class="page-icon"><AppIcon name="monitor" :size="24" /></span><div><h1>界面升级小组<span class="header-avatars"><span class="avatar avatar-sm avatar-1">产</span><span class="avatar avatar-sm avatar-2">前</span></span></h1><p class="page-description">协作总览升级 · 2 个群内实例</p></div></div>
      <RouterLink to="/" class="toolbar-control back-to-graph"><span class="back-arrow" aria-hidden="true">←</span>返回关系图</RouterLink>
    </header>

    <div class="chat-demo-shell">
      <div class="chat-demo-main">
        <div class="chat-demo-topbar">
          <div class="chat-tabs" role="tablist" aria-label="群聊内容"><button v-for="tab in tabs" :key="tab" type="button" role="tab" :aria-selected="activeTab === tab" @click="activeTab = tab">{{ tab }}</button></div>
          <div class="chat-stats"><span><span class="stat-dot todo">●</span>待办 2</span><span><span class="stat-dot doing">●</span>进行中 3</span><span><span class="stat-dot done">●</span>已完成 5</span></div>
        </div>
        <div class="chat-stream">
          <p class="chat-day"><span>今天 14:32</span></p>
          <div v-for="(msg, index) in messages" :key="index" class="chat-msg" :class="{ mine: msg.mine }">
            <span class="avatar" :class="`avatar-${msg.avatar}`">{{ msg.initials }}</span>
            <div class="chat-msg-body"><div class="chat-msg-meta"><strong>{{ msg.who }}</strong><time>{{ msg.time }}</time></div><p class="chat-bubble">{{ msg.text }}</p></div>
          </div>
          <div class="chat-task-list">
            <div v-for="task in chatTasks" :key="task.title" class="chat-task-card">
              <span class="chat-task-icon" :class="task.kind"><AppIcon :name="task.icon" :size="18" /></span>
              <span class="chat-task-copy"><strong>{{ task.title }}<span class="status-badge" :class="task.state === '执行中' ? 'active' : 'wait'">{{ task.state }}</span></strong><small>{{ task.owner }}</small></span>
              <button type="button" class="chat-task-action" aria-disabled="true" title="静态演示控件">{{ task.action }} ›</button>
            </div>
          </div>
        </div>
        <div class="chat-composer">
          <button type="button" class="composer-icon" aria-label="附件（静态演示）" aria-disabled="true"><AppIcon name="plus" :size="18" /></button>
          <span class="composer-at">@</span>
          <input v-model="draft" type="text" placeholder="发消息，或 @ 一位成员…" aria-label="消息输入框" />
          <button type="button" class="composer-send" aria-label="发送（静态演示）" aria-disabled="true" title="静态演示控件，消息不会真实发送"><AppIcon name="arrow" :size="18" /></button>
        </div>
      </div>
      <aside class="chat-demo-side" aria-label="群实例与相关任务">
        <section class="side-block"><h2>本群实例<span class="side-count">2</span></h2>
          <div v-for="inst in instances" :key="inst.name" class="instance-row"><span class="avatar" :class="`avatar-${inst.avatar}`">{{ inst.initials }}</span><strong>{{ inst.name }}</strong><span class="status-badge" :class="inst.tone">{{ inst.status }}</span></div>
        </section>
        <section class="side-block"><h2>相关任务<span class="side-count">3</span></h2>
          <div v-for="task in relatedTasks" :key="task.title" class="related-task"><span class="checkbox" :class="{ checked: task.checked }" aria-hidden="true"><AppIcon v-if="task.checked" name="check" :size="12" /></span><span class="related-copy"><strong>{{ task.title }}<span class="status-badge" :class="task.tone">{{ task.state }}</span></strong><small>负责人：{{ task.owner }}</small></span><span class="related-arrow">›</span></div>
        </section>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.header-title { display: flex; align-items: center; gap: 14px; min-width: 0; }
.page-icon { width: 50px; height: 50px; flex: none; display: grid; place-items: center; border-radius: 12px; background: var(--surface-subtle); color: var(--fg); }
.header-title h1 { margin: 0; display: flex; align-items: center; gap: 10px; font-size: 2rem; line-height: 1.25; }
.header-avatars { display: inline-flex; }.header-avatars .avatar { margin-left: -6px; border: 2px solid var(--card-bg); }
.back-arrow { font-size: 1rem; line-height: 1; color: var(--muted); }
.back-to-graph { display: inline-flex; align-items: center; gap: 6px; min-height: 38px; padding: 7px 14px; border: 1px solid var(--border); border-radius: 9px; background: var(--card-bg); color: var(--fg); font-size: .9rem; font-weight: 500; box-shadow: var(--shadow); }.back-to-graph:hover { color: var(--fg); text-decoration: none; }
.chat-demo-header { align-items: center; margin-bottom: 18px; }
.chat-demo-shell { display: grid; grid-template-columns: minmax(0,1fr) clamp(240px, 24vw, 290px); min-height: clamp(420px, 64vh, 680px); border: 0; border-radius: 0; background: var(--card-bg); box-shadow: none; overflow: hidden; padding: 0; }
.chat-demo-main { display: flex; flex-direction: column; min-width: 0; border-right: 1px solid var(--border); }
.chat-demo-topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 18px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.chat-tabs { display: flex; gap: 22px; }.chat-tabs button { border: 0; border-radius: 0; background: transparent; color: var(--muted); font-size: .88rem; min-height: 0; padding: 8px 0; }.chat-tabs button[aria-selected="true"] { color: var(--fg); font-weight: 600; box-shadow: inset 0 -2px var(--accent); }
.chat-stats { display: flex; gap: 14px; font-size: .78rem; color: var(--muted); }.chat-stats span { display: inline-flex; align-items: center; gap: 5px; }.stat-dot.todo { color: var(--muted); }.stat-dot.doing { color: var(--accent); }.stat-dot.done { color: var(--ok); }
.chat-stream { flex: 1; padding: 20px 22px; overflow-y: auto; }.chat-day { text-align: center; font-size: .74rem; color: var(--muted); position: relative; margin: 0 0 20px; }.chat-day::before, .chat-day::after { content: ""; position: absolute; top: 50%; width: 30%; height: 1px; background: var(--border); }.chat-day::before { left: 0; }.chat-day::after { right: 0; }
.chat-msg { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 18px; }.chat-msg.mine { flex-direction: row-reverse; }.chat-msg-body { flex: 1; min-width: 0; max-width: 78%; }.chat-msg.mine .chat-msg-body { display: flex; flex-direction: column; align-items: flex-end; }.chat-msg-meta { display: flex; align-items: baseline; gap: 8px; margin-bottom: 5px; font-size: .82rem; }.chat-msg-meta time { font-size: .72rem; color: var(--muted); }.chat-bubble { display: inline-block; margin: 0; padding: 9px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--card-bg); font-size: .85rem; line-height: 1.5; overflow-wrap: anywhere; }.chat-msg.mine .chat-bubble { background: var(--accent-soft); border-color: transparent; }
.chat-task-list { margin: 8px 0 20px; display: flex; flex-direction: column; gap: 12px; }.chat-task-card { display: flex; align-items: center; gap: 12px; padding: 13px 15px; border: 1px solid var(--border); border-radius: 11px; }.chat-task-icon { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 8px; background: var(--accent-soft); color: var(--accent); flex: none; }.chat-task-icon.decision { background: color-mix(in srgb, var(--warn) 12%, transparent); color: var(--warn); }.chat-task-copy { flex: 1; min-width: 0; }.chat-task-copy strong { display: flex; align-items: center; gap: 8px; font-size: .88rem; flex-wrap: wrap; }.chat-task-copy small { display: block; color: var(--muted); font-size: .76rem; margin-top: 4px; }.chat-task-action { font-size: .78rem; color: var(--muted); background: var(--surface-subtle); }
.chat-composer { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border); }.composer-icon, .composer-at { color: var(--muted); font-size: 1rem; }.chat-composer input { flex: 1; min-width: 0; border: 1px solid var(--border); border-radius: 9px; padding: 9px 11px; font-size: .85rem; background: var(--card-bg); color: var(--fg); }.composer-send { width: 36px; height: 36px; display: grid; place-items: center; border-radius: 9px; background: var(--accent-fill); color: var(--on-accent); border-color: transparent; }
.chat-demo-side { padding: 18px; }.side-block + .side-block { margin-top: 24px; padding-top: 18px; border-top: 1px solid var(--border); }.side-block h2 { font-size: .92rem; margin: 0 0 14px; }.side-count { font-size: .72rem; color: var(--muted); background: var(--surface-subtle); border-radius: 20px; padding: 1px 7px; margin-left: 6px; }
.instance-row { display: flex; align-items: center; gap: 9px; padding: 7px 0; }.instance-row strong { flex: 1; font-size: .84rem; }
.related-task { display: flex; align-items: center; gap: 9px; padding: 11px; border: 1px solid var(--border); border-radius: 9px; margin-bottom: 9px; }.related-task:first-of-type { border-color: var(--accent); background: var(--accent-soft); }.checkbox { width: 16px; height: 16px; border: 1px solid var(--control-border); border-radius: 4px; flex: none; display: grid; place-items: center; }.checkbox.checked { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }.related-copy { flex: 1; min-width: 0; }.related-copy strong { display: flex; align-items: center; gap: 6px; font-size: .82rem; flex-wrap: wrap; }.related-copy small { display: block; color: var(--muted); font-size: .72rem; margin-top: 3px; }.related-arrow { color: var(--muted); }
@media (max-width: 900px) { .chat-demo-shell { grid-template-columns: 1fr; min-height: 0; }.chat-demo-main { min-height: clamp(320px, 55vh, 520px); border-right: 0; }.chat-demo-side { border-top: 1px solid var(--border); } }
</style>

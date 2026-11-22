<script setup lang="ts">
import type { TaskFlowColumn, TaskFlowItem } from "../composables/collabGraphProjection.ts";

const props = defineProps<{
  columns: TaskFlowColumn[];
  tasks: TaskFlowItem[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
}>();
const emit = defineEmits<{ select: [id: string]; refresh: [] }>();
</script>

<template>
  <div class="taskflow-board-wrap">
    <p v-if="error" class="board-status error" role="alert" data-testid="p03-board-error">
      任务来源读取失败：{{ error }}（当前项目真实数据未就绪，未显示示例任务）
      <button type="button" class="text-button" data-testid="p03-task-refresh" @click="emit('refresh')">重试读取</button>
    </p>
    <p v-else-if="loading" class="board-status muted" role="status" data-testid="p03-board-loading">正在读取当前项目的真实任务…</p>
    <p v-else-if="tasks.length === 0" class="board-status muted" data-testid="p03-board-empty">当前项目没有真实任务，看板为空；未注入示例任务、负责人或假状态。</p>
    <div class="taskflow-board">
      <section v-for="column in columns" :key="column.state" class="taskflow-stage" :data-state="column.state" data-testid="p03-task-column" :aria-label="`${column.label}任务`">
        <div class="stage-head"><strong>{{ column.label }}</strong><span class="stage-count">{{ column.tasks.length }}</span></div>
        <div class="stage-body">
          <p v-if="column.tasks.length === 0" class="column-empty muted small" data-testid="p03-task-column-empty">无{{ column.label }}任务</p>
          <button
            v-for="item in column.tasks" :key="item.id" type="button" class="task-card"
            data-testid="p03-task-card" :data-task-id="item.id" :data-state="item.state"
            :data-revision="item.revision" :data-assignee-id="item.assigneeMemberId ?? ''"
            :data-blocked-reason="item.blockedReason ?? ''"
            :data-readiness-codes="item.readinessCodes.join(' ')"
            :data-execution-admission="item.executionAdmission"
            :aria-pressed="props.selectedId === item.id"
            @click="emit('select', item.id)"
          >
            <strong class="card-title">{{ item.title }}</strong>
            <span class="card-meta">ID {{ item.id }} · 版本 v{{ item.revision }}</span>
            <span class="card-meta">负责人：{{ item.assignee ?? '未指派' }}<template v-if="item.assigneeMemberId">（{{ item.assigneeMemberId }}）</template></span>
            <span v-if="item.blockedReason" class="card-blocked">受阻原因：{{ item.blockedReason }}</span>
            <span class="card-readiness">原因码：{{ item.readinessCodes.length ? item.readinessCodes.join('、') : '无' }}</span>
            <ul v-if="item.readinessIssues.length" class="card-issues">
              <li v-for="(issue, index) in item.readinessIssues" :key="`${issue.stage}:${issue.field}:${issue.code}:${index}`" data-testid="p03-task-issue" :data-field="issue.field" :data-code="issue.code" :data-stage="issue.stage">
                {{ issue.stage }} · {{ issue.field }} · {{ issue.code }}：{{ issue.message }}
                <small class="issue-hint">下一步：{{ issue.hint }}</small>
              </li>
            </ul>
            <span v-else class="card-meta">服务端未报告资料缺口</span>
            <span class="card-admission" data-testid="p03-execution-admission">执行接入：{{ item.executionAdmission }}（非执行放行）</span>
          </button>
        </div>
      </section>
    </div>
    <p class="board-note small muted">执行接入 not-issued 仅表示任务资料观察；不是 Run 放行、领取或任务完成。卡片只可查看，不支持拖动或批准。</p>
  </div>
</template>

<style scoped>
.taskflow-board-wrap { min-width: 0; }
.board-status { margin: 4px 0 14px; padding: 10px 12px; border: 1px dashed var(--border); border-radius: 9px; font-size: .8rem; line-height: 1.6; overflow-wrap: anywhere; }
.board-status.error { border-color: var(--bad); color: var(--bad); }
.text-button { margin-left: 8px; }
.taskflow-board { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
.taskflow-stage { min-width: 0; border: 1px solid var(--border); border-radius: 10px; background: var(--card-bg); }
.stage-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: .9rem; }
.stage-count { font-size: .72rem; color: var(--muted); font-variant-numeric: tabular-nums; }
.stage-body { display: flex; flex-direction: column; gap: 10px; padding: 10px; min-width: 0; }
.column-empty { margin: 0; padding: 12px 4px; text-align: center; }
.task-card { display: flex; flex-direction: column; align-items: stretch; gap: 5px; width: 100%; min-width: 0; padding: 10px; border: 1px solid var(--border); border-radius: 9px; background: var(--card-bg); color: var(--fg); font-size: .78rem; line-height: 1.55; text-align: left; overflow-wrap: anywhere; }
.task-card[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-soft); }
.card-title { font-size: .86rem; }
.card-meta, .card-readiness, .card-admission { color: var(--muted); }
.card-blocked { color: var(--bad); }
.card-issues { margin: 2px 0; padding-left: 16px; color: var(--muted); }
.card-issues li { margin-bottom: 3px; }.issue-hint { display: block; color: var(--fg); }
.board-note { margin: 12px 0 0; overflow-wrap: anywhere; }
.card-admission { margin-top: 4px; padding-top: 5px; border-top: 1px solid var(--border); }
@media (max-width: 1200px) { .taskflow-board { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 900px) { .taskflow-board { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 760px) { .board-scope { white-space: normal; } .taskflow-board { grid-template-columns: 1fr; } }
</style>

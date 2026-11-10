<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { runtimeApi, type RuntimeAction, type RuntimeBindingViewDto, type RuntimeObservationDto, type RuntimeUsageDto } from "../api/runtimes.ts";
import { backendLabels, configFields, configLabels, configValue, isStopped, memberLabels, permissionLabels, reasonLabel, runnerLabels, runtimeError, summaryLabels, timeLabel } from "../api/runtime-display.ts";

const props = defineProps<{ view: RuntimeBindingViewDto; projectName: string; groupName: string; busy: boolean }>();
const emit = defineEmits<{ edit: []; action: [action: RuntimeAction]; remove: [] }>();
const expanded = ref(false);
const observations = ref<RuntimeObservationDto | null>(null);
const loading = ref(false);
const loadError = ref<string | null>(null);
const summary = computed(() => summaryLabels[props.view.status.summary]);
const requestMode = computed(() => props.view.effective.advancedStrategy ?? props.view.effective.config.permissionMode);
const actualMode = computed(() => permissionLabels[props.view.runner.permissionObserved] ?? "尚未识别");
const eventLabels: Record<string, string> = {
  "runtime.created": "创建托管配置", "runtime.updated": "保存全局默认", "binding.created": "加入群组", "binding.updated": "保存群组配置",
  start_requested: "请求启动", stop_requested: "请求停止", retry_requested: "请求重试", spawned: "进程已拉起", ready: "运行握手完成",
  exited: "进程退出", retry_scheduled: "安排重试", stopped: "确认停止", "wake.allowed": "允许自动唤醒", "wake.suppressed": "自动唤醒被抑制",
  "dispatch.scheduled": "已安排调度", "dispatch.queued": "消息进入排队", usage_observed: "采得用量", usage_unavailable: "用量暂不可得", observation_warning: "观测警告",
};
const usageLabels = { inputTokens: "输入 token", cachedInputTokens: "缓存输入 token", outputTokens: "输出 token", costUsd: "金额（CLI 估算）" };
const coverageLabels = { complete: "完整", partial: "部分", unavailable: "不可得" };
const scopeLabels = { turn: "轮次", invocation: "本次调用", session: "会话" };

async function loadObservations(): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  try { observations.value = await runtimeApi.observations(props.view.binding.id); loadError.value = null; }
  catch (error) { loadError.value = runtimeError(error); }
  finally { loading.value = false; }
}
function toggleDetails(): void { expanded.value = !expanded.value; if (expanded.value) void loadObservations(); }
watch(() => props.view, () => { if (expanded.value) void loadObservations(); });
function usageValue(row: RuntimeUsageDto): string {
  if (row.value === null) return "未知";
  return row.metric === "costUsd" ? `$${row.value.toLocaleString("en-US", { maximumSignificantDigits: 8 })}` : row.value.toLocaleString("zh-CN");
}
</script>

<template>
  <section class="binding-card" :data-binding-id="view.binding.id">
    <div class="binding-heading">
      <div><h3>{{ groupName }}</h3><p class="muted small">{{ projectName }}</p></div>
      <span class="summary" :class="view.status.summary" data-testid="runtime-summary">{{ summary }}</span>
    </div>
    <p v-if="view.status.reason && view.status.reason !== view.status.capability?.reason" class="reason" data-testid="runtime-reason">{{ reasonLabel(view.status.reason) }} <code>{{ view.status.reason }}</code></p>
    <div v-if="view.status.capability && !view.status.capability.supported" class="capability-notice">
      {{ reasonLabel(view.status.capability.reason) }}。消息会保留，当前不会自动提升权限启动。
    </div>
    <dl class="runtime-state-grid">
      <div><dt>期望状态</dt><dd>{{ view.binding.desiredState === 'running' ? '保持运行' : '停止' }}</dd></div>
      <div><dt>托管进程</dt><dd>{{ runnerLabels[view.runner.state] }}</dd><span class="muted small">{{ view.runner.phase === 'working' ? '轮次处理中' : view.runner.phase === 'idle' ? '位于等待安全点' : '当前轮次未知' }}</span></div>
      <div><dt>MCP 连接</dt><dd>{{ view.status.member?.connection === 'connected' ? '已连接' : view.status.member?.connection === 'disconnected' ? '已断开' : '尚无连接' }}</dd><span v-if="view.status.member?.stale" class="warning-text small">连接状态陈旧</span></div>
      <div><dt>成员状态</dt><dd>{{ view.status.member ? memberLabels[view.status.member.state] : '尚无运行信号' }}</dd><span v-if="view.status.member?.heartbeatTimedOut" class="warning-text small">心跳超时</span></div>
      <div><dt>唤醒记录</dt><dd>允许且未 ACK {{ view.status.queuedCount }} · 抑制且未 ACK {{ view.status.suppressedCount }}</dd></div>
      <div><dt>累计投递记录</dt><dd>待投递 {{ view.status.deliveryCounts.pending }} · 已投递待 ACK {{ view.status.deliveryCounts.delivered }} · 已 ACK {{ view.status.deliveryCounts.acked }}</dd><span class="muted small">投递与 ACK 是消息事实，不代表任务完成。</span></div>
      <div><dt>实际权限模式</dt><dd data-testid="runtime-permission-observed">{{ actualMode }}</dd><span class="muted small">配置请求：{{ permissionLabels[requestMode] ?? '未知' }}</span></div>
    </dl>
    <p v-if="view.runner.nextRetryAt" class="small muted">下次重试资格检查：{{ timeLabel(view.runner.nextRetryAt) }}</p>
    <p v-if="view.status.summary === 'stopping'" class="small warning-text">已保存停止意图，等待安全点与对应进程退出确认。</p>
    <p v-if="view.pendingChanges" class="pending-notice" data-testid="runtime-pending">有已保存的待应用配置。正在运行的进程继续使用原配置，显式应用后于安全点重启。</p>

    <div class="binding-actions">
      <button type="button" :disabled="busy || view.binding.desiredState === 'running'" data-testid="runtime-start" @click="emit('action', 'start')">启动</button>
      <button type="button" :disabled="busy || isStopped(view)" data-testid="runtime-stop" @click="emit('action', 'stop')">停止</button>
      <button type="button" :disabled="busy || !view.pendingChanges" data-testid="runtime-apply" @click="emit('action', 'apply')">应用并重启</button>
      <button type="button" :disabled="busy || view.binding.desiredState !== 'running' || view.status.summary === 'running' || view.status.summary === 'stopping'" data-testid="runtime-retry" @click="emit('action', 'retry')">重试</button>
      <button type="button" :disabled="busy" data-testid="runtime-edit-binding" @click="emit('edit')">群组配置</button>
      <button type="button" :disabled="busy" @click="emit('action', 'new-session')">新建会话{{ view.binding.desiredState === 'running' ? '并重启' : '并启动' }}</button>
    </div>
    <div class="binding-secondary">
      <button type="button" class="text-button" :aria-expanded="expanded" @click="toggleDetails">{{ expanded ? '收起配置与观测' : '配置与运行观测' }}</button>
      <RouterLink :to="{ path: '/chat', query: { projectId: view.binding.projectId, groupId: view.binding.groupId } }">进入群聊</RouterLink>
      <button type="button" class="text-button danger" :disabled="busy || !isStopped(view)" :title="isStopped(view) ? '解绑后保留成员身份和历史消息' : '请停止并等待进程退出确认'" @click="emit('remove')">解绑群组</button>
    </div>

    <div v-if="expanded" class="binding-details">
      <h4>配置与继承来源</h4>
      <div class="table-scroll"><table>
        <thead><tr><th>配置项</th><th>已应用值</th><th>已保存的有效值</th><th>来源</th></tr></thead>
        <tbody><tr v-for="field in configFields" :key="field"><th>{{ configLabels[field] }}</th><td>{{ configValue(view.runner.applied?.config ?? null, field) }}</td><td>{{ configValue(view.effective.config, field) }}</td><td><span class="source-tag">{{ view.effective.sources[field] === 'default' ? '全局默认' : '本群覆盖' }}</span></td></tr></tbody>
      </table></div>
      <p class="small muted">已保存：全局 v{{ view.runtime.revision }} / 群组 v{{ view.binding.revision }}；已应用：{{ view.runner.applied ? `全局 v${view.runner.applied.versions.runtimeRevision} / 群组 v${view.runner.applied.versions.bindingRevision}` : '尚未应用' }}。</p>
      <p class="small muted">独立会话：{{ view.runner.hasSession ? '存在可关联的宿主会话' : '尚无会话句柄' }} · {{ view.runner.sessionState === 'invalid' ? '续接不可用' : view.runner.sessionState === 'resumable' ? '可尝试续接' : view.runner.sessionState === 'reset' ? '等待新会话' : '未确认可续接' }}。续接不恢复在途工具，未确认消息可能再次投递。</p>
      <p v-if="view.status.capability" class="small muted">CLI 版本：{{ view.status.capability.hostVersion ?? '未知' }} · 隔离状态：{{ view.status.capability.isolation === 'verified' ? '已验证' : view.status.capability.isolation === 'unavailable' ? '不可用' : '尚未验证' }}</p>

      <div class="section-heading"><h4>最近运行记录</h4><button type="button" class="text-button" :disabled="loading" @click="loadObservations">{{ loading ? '读取中…' : '刷新记录' }}</button></div>
      <p v-if="loadError" class="error" role="alert">{{ loadError }}</p>
      <template v-if="observations">
        <p v-if="observations.health.incomplete || observations.events.incomplete" class="capability-notice" role="status">运行记录不完整。记录存储失败 {{ observations.health.storageFailures }} 次，日志写入失败 {{ observations.health.loggerWriteFailures }} 次；消息与任务状态以各自实际记录为准。</p>
        <p class="small muted">保留窗口内的记录；最早可查询：{{ timeLabel(observations.events.oldestObservedAt) }}<span v-if="observations.events.historyTruncated">。历史已按保留上限截断。</span></p>
        <p v-if="observations.events.events.length === 0" class="muted small">暂时没有可展示的运行事件。</p>
        <ol v-else class="event-list"><li v-for="event in observations.events.events" :key="event.eventId">
          <time>{{ timeLabel(event.observedAt) }}</time><div><strong>{{ eventLabels[event.event] ?? '运行事件' }}</strong><span v-if="event.reasonCode"> · {{ reasonLabel(event.reasonCode) }}</span><span v-if="event.runnerGeneration !== undefined" class="muted small"> · 代次 {{ event.runnerGeneration }}</span><span v-if="event.truncated" class="muted small"> · 元数据已截断</span></div>
        </li></ol>
        <h4>最近已知用量</h4>
        <p class="muted small">仅显示 CLI 实际采得且格式已验证的数据。金额为 CLI 估算（非账单）；不同来源与作用域不合并总费用。</p>
        <p v-if="observations.usage.length === 0" class="muted small" data-testid="runtime-usage-unknown">暂无可信用量数据，token 与金额未知。</p>
        <div v-else class="table-scroll"><table>
          <thead><tr><th>来源 / 作用域</th><th>指标</th><th>数值</th><th>覆盖</th></tr></thead>
          <tbody><tr v-for="usage in observations.usage" :key="usage.id">
            <td>{{ backendLabels[usage.source] }} {{ usage.harnessVersion }}<br><span class="muted small">{{ scopeLabels[usage.scope] }}{{ usage.cumulative ? '累计' : '' }} · {{ usage.scopeId.slice(-8) }}</span></td>
            <td>{{ usageLabels[usage.metric] }}</td><td>{{ usageValue(usage) }}<span v-if="usage.cumulative && usage.delta !== null" class="usage-note">已知增量：{{ usage.metric === 'costUsd' ? '$' : '' }}{{ usage.delta.toLocaleString('zh-CN', { maximumSignificantDigits: 8 }) }}</span><span v-if="usage.reasonCode" class="usage-note">{{ reasonLabel(usage.reasonCode) }}</span></td><td>{{ coverageLabels[usage.coverage] }}</td>
          </tr></tbody>
        </table></div>
      </template>
      <p class="small muted">最近状态变化：{{ timeLabel(view.runner.updatedAt) }}</p>
    </div>
  </section>
</template>

<style scoped>
.binding-card { border: 1px solid var(--border); border-radius: 8px; padding: 1rem; background: var(--card-bg); }
.binding-heading, .section-heading { display: flex; justify-content: space-between; align-items: center; gap: .8rem; }
h3 { margin: 0; font-size: 1rem; } h4 { margin: 1.2rem 0 .65rem; font-size: .95rem; }
.binding-heading p { margin: .2rem 0 0; }
.summary { display: inline-flex; padding: .25rem .6rem; border-radius: 999px; background: var(--bg); font-size: .8rem; white-space: nowrap; border: 1px solid var(--border); }
.running { color: var(--ok); } .error { color: var(--bad); } .queued, .stopping { color: #a16412; }
.reason { font-size: .85rem; overflow-wrap: anywhere; margin-bottom: .65rem; }
.reason code { font-size: .7rem; }
.capability-notice, .pending-notice { padding: .65rem .8rem; background: rgba(175, 122, 25, .09); border-left: 3px solid #b78730; border-radius: 4px; font-size: .82rem; }
.pending-notice { background: rgba(37, 99, 235, .07); border-color: var(--accent); }
.runtime-state-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem; margin: 1rem 0; }
dt { color: var(--muted); font-size: .78rem; } dd { margin: .15rem 0 0; font-size: .87rem; overflow-wrap: anywhere; }
.warning-text { color: #a16412; }
.binding-actions, .binding-secondary { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
.binding-secondary { justify-content: flex-start; margin-top: .9rem; font-size: .8rem; gap: 1rem; }
button { padding: .45rem .65rem; border: 1px solid var(--border); border-radius: 6px; background: var(--card-bg); color: var(--fg); cursor: pointer; font: inherit; font-size: .8rem; }
button:disabled { opacity: .45; cursor: not-allowed; }
.text-button { border: 0; padding: 0; color: var(--accent); background: transparent; }
.danger { color: var(--bad); margin-left: auto; }
.binding-details { border-top: 1px solid var(--border); margin-top: 1rem; padding-top: .2rem; }
.table-scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: .8rem; }
th, td { padding: .6rem .45rem; text-align: left; vertical-align: top; border-bottom: 1px solid var(--border); overflow-wrap: anywhere; }
th { font-weight: 500; color: var(--muted); } td { max-width: 230px; }
.source-tag { white-space: nowrap; font-size: .75rem; }
.event-list { padding: 0; list-style: none; max-height: 350px; overflow-y: auto; font-size: .8rem; }
.event-list li { display: grid; grid-template-columns: 150px 1fr; gap: .6rem; padding: .5rem 0; border-bottom: 1px solid var(--border); }
.event-list time { color: var(--muted); } .event-list strong { font-weight: 500; }
.usage-note { display: block; color: var(--muted); font-size: .73rem; margin-top: .15rem; }
@media (max-width: 620px) { .runtime-state-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .event-list li { grid-template-columns: 1fr; gap: .2rem; } table { min-width: 480px; } }
</style>

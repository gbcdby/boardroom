<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { memoryApi, memoryTime, type MemorySummaryRequest } from "../api/memory.ts";
const props = defineProps<{ projectId: string; agentId: string; currentVersion: number; active: boolean; readonly: boolean }>();
const requests = ref<MemorySummaryRequest[]>([]);
const loading = ref(false);
const loaded = ref(false);
const busy = ref<string | null>(null);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const visibleCount = ref(10);
const visibleRequests = computed(() => requests.value.slice(0, visibleCount.value));
const mutations = new Map<string, string>();
let readRequest = 0;
let disposed = false;
let refreshQueued = false;
let timer: ReturnType<typeof setTimeout> | undefined;
function stopTimer(): void { if (timer !== undefined) clearTimeout(timer); timer = undefined; }
function schedule(): void {
  stopTimer();
  if (!disposed && typeof window !== "undefined" && requests.value.some((entry) => entry.state === "pending" || entry.state === "running")) timer = setTimeout(() => { void refresh(); }, 10000);
}
function stateLabel(entry: MemorySummaryRequest): string {
  if (entry.state === "completed") return entry.resultVersion === null ? "已保存" : `已保存为版本 ${entry.resultVersion}`;
  return ({ pending: "待处理", running: "Agent 已接手", failed: "失败", conflicted: "版本冲突", cancelled: "已取消" })[entry.state];
}
function triggerLabel(trigger: string): string { return ({ task_completed: "任务完成", message_threshold: "消息达到阈值", session_end: "Agent 结束会话", retry: "重新安排" } as Record<string, string>)[trigger] ?? trigger; }
function terminal(entry: MemorySummaryRequest): boolean { return ["failed", "conflicted", "cancelled"].includes(entry.state); }
function followedUp(entry: MemorySummaryRequest): boolean { return requests.value.some((candidate) => candidate.retryOfRequestId === entry.id); }
async function refresh(): Promise<void> {
  if (busy.value) { refreshQueued = true; return; }
  stopTimer();
  const ticket = ++readRequest;
  loading.value = true; error.value = null;
  try {
    const result = await memoryApi.requests(props.projectId, props.agentId);
    if (disposed || ticket !== readRequest) return;
    requests.value = result.requests; loaded.value = true; schedule();
  } catch (err) { if (!disposed && ticket === readRequest) error.value = err instanceof Error ? err.message : "总结状态读取失败，请重试。"; }
  finally { if (!disposed && ticket === readRequest) loading.value = false; }
}
async function retry(entry: MemorySummaryRequest): Promise<void> {
  if (disposed || busy.value || loading.value || props.readonly || !props.active || !terminal(entry) || followedUp(entry)) return;
  stopTimer();
  const mutation = mutations.get(entry.id) ?? crypto.randomUUID(); mutations.set(entry.id, mutation);
  busy.value = entry.id; error.value = null; notice.value = null;
  try {
    const result = await memoryApi.retry(props.projectId, entry.id, mutation);
    if (disposed) return;
    requests.value = [result.request, ...requests.value.filter((candidate) => candidate.id !== result.request.id)];
    notice.value = `已安排新请求，当前${stateLabel(result.request)}。完成后会显示保存的版本。`;
    schedule();
  } catch (err) { if (!disposed) error.value = err instanceof Error ? err.message : "未能重新安排总结，请重试。"; }
  finally {
    if (!disposed) { busy.value = null; if (refreshQueued) { refreshQueued = false; void refresh(); } }
  }
}
watch(() => props.currentVersion, () => { void refresh(); }, { immediate: true });
onBeforeUnmount(() => { disposed = true; readRequest++; stopTimer(); });
</script>

<template>
  <section class="panel memory-summary" aria-labelledby="memory-summary-title" data-testid="memory-summary">
    <div class="summary-heading"><div><h2 id="memory-summary-title">Agent 自总结</h2><p class="muted small">由这位 Agent 根据项目上下文整理，成功后生成新版本。</p></div><button type="button" :disabled="loading || busy !== null" data-testid="memory-summary-refresh" @click="refresh">{{ loading ? '正在读取…' : '刷新状态' }}</button></div>
    <p v-if="!active" class="notice small">此 Agent 当前无法执行总结；已有记忆仍可维护。</p>
    <div v-if="error" class="error" role="alert" data-testid="memory-summary-error">{{ error }} <button type="button" class="text-button" :disabled="loading || busy !== null" @click="refresh">重新读取状态</button></div>
    <p v-if="notice" class="notice" role="status" data-testid="memory-summary-notice">{{ notice }}</p>
    <p v-if="loading && !loaded" class="muted small" role="status">正在读取总结请求…</p>
    <p v-else-if="loaded && requests.length === 0" class="muted small">尚无自总结请求。Agent 的任务完成、消息达到阈值或明确结束会话后，会按规则安排。</p>
    <ul class="summary-list"><li v-for="entry in visibleRequests" :key="entry.id" :data-testid="`memory-summary-request-${entry.id}`"><div class="summary-row"><div><span class="badge" :class="`summary-state-${entry.state}`">{{ stateLabel(entry) }}</span><span class="small summary-trigger">{{ triggerLabel(entry.trigger) }}</span></div><time class="muted small" :datetime="entry.createdAt">{{ memoryTime(entry.createdAt) }}</time></div><p class="muted small">基于版本 {{ entry.baseVersion }}<span v-if="entry.state === 'pending'"> · 等待目标 Agent 处理</span><span v-if="entry.state === 'running'"> · 结果尚未保存</span></p><p v-if="entry.error" class="summary-reason small">{{ entry.error.message }} <span class="muted">（{{ entry.error.code }}）</span></p><p v-if="entry.state === 'conflicted'" class="small">记忆已有新版本，旧结果未覆盖当前正文。重新安排会使用新的版本基准。</p><p v-if="entry.state === 'completed'" class="muted small">此状态表示记忆版本已提交；来源为 Agent 报告。</p><button v-if="terminal(entry)" type="button" :disabled="readonly || !active || busy !== null || loading || followedUp(entry)" :data-testid="`memory-summary-retry-${entry.id}`" @click="retry(entry)">{{ busy === entry.id ? '正在安排…' : followedUp(entry) ? '已重新安排' : '重新安排总结' }}</button></li></ul>
    <button v-if="visibleCount < requests.length" type="button" @click="visibleCount += 10">显示更多请求（{{ requests.length - visibleCount }}）</button>
    <details class="summary-help"><summary>如何判断完成</summary><p class="muted small">请求创建、通知投递和 ACK 只表示流程进展。“Agent 已接手”表示 Agent 已开始处理请求；完成以成功保存的记忆版本为准。模型来源由 Agent 声明，页面不代替宿主验收。</p></details>
  </section>
</template>

<style scoped>
.memory-summary { margin-top: 1.25rem; }.summary-heading, .summary-row { display: flex; justify-content: space-between; flex-wrap: wrap; align-items: start; gap: .75rem; }
.summary-heading h2 { margin: 0; }.summary-heading p { margin-bottom: 0; }.summary-heading > div { min-width: 0; flex: 1 1 240px; }
.summary-list { list-style: none; padding: 0; margin: 1rem 0 0; }.summary-list li { padding: 1rem 0; border-top: 1px solid var(--border); }.summary-list p { margin: .55rem 0; overflow-wrap: anywhere; }
.summary-trigger { margin-left: .65rem; }.summary-state-failed, .summary-state-conflicted, .summary-reason { color: var(--warn); }.summary-state-completed { color: var(--ok); }
.summary-help { margin-top: 1rem; }.summary-help p { line-height: 1.65; }
</style>

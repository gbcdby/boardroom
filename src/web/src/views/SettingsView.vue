<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { settingsApi, type EffectiveSettings } from "../api/settings.ts";

const settings = ref<EffectiveSettings | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const lastReadAt = ref<string | null>(null);
const copying = ref(false);
const copyNotice = ref<string | null>(null);
const copyError = ref<string | null>(null);
let disposed = false;
let readRequest = 0;
let copyRequest = 0;
const number = (value: number) => value.toLocaleString("zh-CN", { maximumFractionDigits: 3 });
const duration = (value: number) => value % 60000 === 0 ? `${number(value / 60000)} 分钟` : `${number(value / 1000)} 秒`;
function time(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "medium" });
}
async function refresh(): Promise<void> {
  if (disposed || loading.value) return;
  const ticket = ++readRequest;
  loading.value = true; error.value = null;
  copyRequest++; copying.value = false; copyNotice.value = null; copyError.value = null;
  try {
    const result = await settingsApi.read();
    if (disposed || ticket !== readRequest) return;
    settings.value = result.settings;
    lastReadAt.value = new Date().toISOString();
  } catch (err) {
    if (!disposed && ticket === readRequest) error.value = err instanceof Error ? err.message : "设置读取失败，请重试。";
  } finally { if (!disposed && ticket === readRequest) loading.value = false; }
}
async function copyMcpAddress(): Promise<void> {
  if (disposed || loading.value || copying.value || !settings.value) return;
  const ticket = ++copyRequest, address = settings.value.service.mcpHttpUrl;
  copying.value = true; copyNotice.value = null; copyError.value = null;
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) throw new Error("clipboard_unavailable");
    await navigator.clipboard.writeText(address);
    if (!disposed && ticket === copyRequest) copyNotice.value = "已复制 MCP HTTP 地址。";
  } catch {
    if (!disposed && ticket === copyRequest) copyError.value = "无法访问剪贴板。请选择上方 MCP HTTP 地址手动复制。";
  } finally { if (!disposed && ticket === copyRequest) copying.value = false; }
}
onMounted(() => { void refresh(); });
onBeforeUnmount(() => { disposed = true; readRequest++; copyRequest++; });
</script>

<template>
  <section class="page settings-page" :aria-busy="loading">
    <header class="page-header">
      <div><h1>设置</h1><p class="page-description">查看本地服务当前生效的配置。</p></div>
      <button type="button" :disabled="loading" data-testid="settings-refresh" @click="refresh">{{ loading ? '正在读取…' : '刷新配置' }}</button>
    </header>
    <div class="settings-status" role="status"><span class="badge">全局 · 只读</span><span v-if="lastReadAt" class="muted small">上次成功读取：<time :datetime="lastReadAt" data-testid="settings-last-read">{{ time(lastReadAt) }}</time></span></div>
    <div v-if="error" class="error" role="alert" data-testid="settings-error"><p>{{ error }}</p><p v-if="settings">刷新失败，以下仍为上次成功读取的值。</p><button type="button" class="text-button" :disabled="loading" data-testid="settings-retry" @click="refresh">重新读取</button></div>
    <p v-if="loading && !settings" class="muted" role="status" data-testid="settings-loading">正在读取生效配置…</p>
    <div v-if="settings" class="settings-grid">
      <section class="panel" aria-labelledby="settings-service-title">
        <h2 id="settings-service-title">服务与接入</h2><p class="muted small">服务仅在这台设备上监听，地址来自实际运行的进程。</p>
        <dl class="settings-values">
          <div><dt>监听地址</dt><dd>{{ settings.service.host }}:{{ settings.service.port }}</dd></div>
          <div><dt>HTTP 地址</dt><dd><code data-testid="settings-http">{{ settings.service.httpBaseUrl }}</code></dd></div>
          <div><dt>WebSocket 地址</dt><dd><code data-testid="settings-websocket">{{ settings.service.websocketUrl }}</code></dd></div>
          <div><dt>MCP HTTP 地址</dt><dd><code class="settings-copyable" data-testid="settings-mcp">{{ settings.service.mcpHttpUrl }}</code><button type="button" class="text-button settings-copy-button" :disabled="copying || loading" aria-label="复制 MCP HTTP 地址" data-testid="settings-copy-mcp" @click="copyMcpAddress">{{ copying ? '正在复制…' : '复制地址' }}</button></dd></div>
        </dl>
        <p v-if="copyNotice" class="notice small" role="status" data-testid="settings-copy-notice">{{ copyNotice }}</p>
        <p v-if="copyError" class="error small" role="alert" data-testid="settings-copy-error">{{ copyError }}</p>
        <div class="actions settings-links"><a href="/api/health" target="_blank" rel="noreferrer">查看健康状态<span class="visually-hidden">（在新标签页打开）</span></a><RouterLink to="/runtimes">管理托管 Agent</RouterLink></div>
      </section>
      <section class="panel" aria-labelledby="settings-storage-title">
        <h2 id="settings-storage-title">数据存储</h2><p class="muted small">连接信息仅显示是否已配置。</p>
        <dl class="settings-values">
          <div><dt>当前数据库</dt><dd data-testid="settings-driver">{{ settings.storage.driver === 'postgres' ? 'PostgreSQL' : 'SQLite' }}</dd></div>
          <div><dt>数据目录</dt><dd><code data-testid="settings-data-directory">{{ settings.storage.dataDirectory }}</code></dd></div>
          <div><dt>PostgreSQL 连接信息</dt><dd>{{ settings.storage.postgresConfigured ? '已配置' : '未配置' }}</dd></div>
        </dl>
        <p class="muted small">切换数据库前须先完成数据迁移与校验；重启不会自动搬迁数据。</p>
      </section>
      <section class="panel" aria-labelledby="settings-heartbeat-title">
        <h2 id="settings-heartbeat-title">连接心跳</h2><p class="muted small">用于判断成员连接是否仍然有效。</p>
        <dl class="settings-values">
          <div><dt>心跳间隔</dt><dd>{{ duration(settings.heartbeat.intervalMs) }}<small>{{ number(settings.heartbeat.intervalMs) }} ms</small></dd></div>
          <div><dt>心跳超时</dt><dd>{{ duration(settings.heartbeat.timeoutMs) }}<small>{{ number(settings.heartbeat.timeoutMs) }} ms</small></dd></div>
        </dl>
      </section>
      <section class="panel" aria-labelledby="settings-loop-title">
        <h2 id="settings-loop-title">防环与唤醒</h2><p class="muted small">控制连续自动回复与成员唤醒频率。</p>
        <dl class="settings-values">
          <div><dt>每群连续自动回复上限</dt><dd>{{ number(settings.antiLoop.maxConsecutiveAutoReplies) }} 次</dd></div>
          <div><dt>每位成员每分钟唤醒上限</dt><dd>{{ number(settings.antiLoop.maxWakesPerMinutePerMember) }} 次</dd></div>
        </dl>
      </section>
      <section class="panel" aria-labelledby="settings-memory-title">
        <h2 id="settings-memory-title">记忆</h2><p class="muted small">阈值用于安排总结请求，不表示总结已经完成。</p>
        <dl class="settings-values">
          <div><dt>消息总结阈值</dt><dd>{{ number(settings.memory.messageThreshold) }} 条</dd></div>
          <div><dt>单份文档上限</dt><dd>{{ number(settings.memory.maxDocumentBytes) }} 字节</dd></div>
          <div><dt>单次注入上限</dt><dd>{{ number(settings.memory.maxInjectedBytes) }} 字节</dd></div>
          <div><dt>总结输入上限</dt><dd>{{ number(settings.memory.summaryInputBytes) }} 字节</dd></div>
          <div><dt>总结执行超时</dt><dd>{{ duration(settings.memory.summaryAttemptTimeoutMs) }}<small>{{ number(settings.memory.summaryAttemptTimeoutMs) }} ms</small></dd></div>
        </dl>
      </section>
      <section class="panel" aria-labelledby="settings-source-title">
        <h2 id="settings-source-title">来源与生效</h2><p class="muted small">页面只展示当前进程已加载的配置。</p>
        <dl class="settings-values">
          <div><dt>配置文件</dt><dd><code v-if="settings.configuration.filePath" data-testid="settings-file">{{ settings.configuration.filePath }}</code><span v-else data-testid="settings-file">未加载配置文件</span></dd></div>
          <div><dt>服务启动时间</dt><dd><time :datetime="settings.configuration.startedAt">{{ time(settings.configuration.startedAt) }}</time></dd></div>
        </dl>
        <p class="small">环境变量优先于配置文件，配置文件优先于默认值。</p>
        <div class="settings-activation"><h3>修改后如何生效</h3><p class="small">修改配置文件或环境变量后，请正常停止服务，并使用同一数据配置重新启动；随后刷新本页确认。</p><p class="muted small">页面不读取尚未加载的文件改动，也不执行保存或重启。</p></div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.settings-status { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; margin: -6px 0 24px; }
.settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; gap: 20px; }
.settings-grid > .panel { margin: 0; }
.settings-grid h2 { margin-bottom: .45rem; }
.settings-values { margin: 1.25rem 0 0; }
.settings-values > div { display: grid; grid-template-columns: minmax(0, .9fr) minmax(0, 1.1fr); gap: 1rem; padding: .85rem 0; border-top: 1px solid var(--border); }
.settings-values dt { color: var(--muted); font-size: .87rem; }
.settings-values dd { margin: 0; min-width: 0; font-size: .9rem; overflow-wrap: anywhere; }
.settings-values small { display: block; color: var(--muted); font-size: .78rem; margin-top: .15rem; }
.settings-values code { padding: 0; background: transparent; font-size: .87rem; white-space: pre-wrap; overflow-wrap: anywhere; }
.settings-copyable { user-select: all; }
.settings-copy-button { display: flex; margin: .35rem 0 0 -.45rem; padding-inline: .45rem; }
.settings-links { gap: 1.25rem; margin-top: 1rem; font-size: .87rem; }
.settings-activation { margin-top: 1.25rem; padding-top: 1.25rem; border-top: 1px solid var(--border); }
.settings-activation h3 { margin-bottom: .5rem; }
@media (max-width: 1050px) { .settings-grid { grid-template-columns: 1fr; } }
@media (max-width: 480px) { .settings-values > div { grid-template-columns: 1fr; gap: .35rem; }.settings-status { margin-bottom: 20px; } }
</style>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { memoryApi, memorySourceLabel, memoryTime, type MemoryVersion } from "../api/memory.ts";
const props = defineProps<{ projectId: string; agentId: string | null; currentVersion: number; readonly: boolean }>();
const emit = defineEmits<{ use: [version: MemoryVersion] }>();
const open = ref(false);
const loaded = ref(false);
const versions = ref<MemoryVersion[]>([]);
const selected = ref<MemoryVersion | null>(null);
const loading = ref(false);
const reading = ref(false);
const more = ref(false);
const jumpVersion = ref<string | number>("");
const error = ref<string | null>(null);
let listRequest = 0, versionRequest = 0;
let disposed = false;
const retryAction = ref<(() => Promise<void>) | null>(null);
async function load(beforeVersion?: number): Promise<void> {
  if (loading.value) return;
  const ticket = ++listRequest;
  loading.value = true; error.value = null; retryAction.value = null;
  try {
    const result = await memoryApi.history(props.projectId, props.agentId, beforeVersion);
    if (disposed || ticket !== listRequest) return;
    versions.value = beforeVersion === undefined ? result.versions : [...versions.value, ...result.versions.filter((entry) => !versions.value.some((existing) => existing.version === entry.version))];
    more.value = result.versions.length === 20; loaded.value = true;
  } catch (err) {
    if (disposed || ticket !== listRequest) return;
    error.value = err instanceof Error ? err.message : "历史读取失败。";
    retryAction.value = () => load(beforeVersion);
  } finally { if (!disposed && ticket === listRequest) loading.value = false; }
}
async function toggle(): Promise<void> { open.value = !open.value; if (open.value && !loaded.value) await load(); }
async function readVersion(version: number): Promise<void> {
  if (!Number.isSafeInteger(version) || version < 1) { error.value = "请输入大于 0 的整数版本号。"; retryAction.value = null; return; }
  const ticket = ++versionRequest;
  reading.value = true; error.value = null; selected.value = null; retryAction.value = null;
  try {
    const result = await memoryApi.version(props.projectId, props.agentId, version);
    if (disposed || ticket !== versionRequest) return;
    selected.value = result.version;
    if (!result.version) error.value = `未找到版本 ${version}。请核对版本号。`;
  } catch (err) {
    if (disposed || ticket !== versionRequest) return;
    error.value = err instanceof Error ? err.message : "版本正文读取失败。";
    retryAction.value = () => readVersion(version);
  } finally { if (!disposed && ticket === versionRequest) reading.value = false; }
}
function useVersion(): void { if (!props.readonly && selected.value && !reading.value) emit("use", selected.value); }
watch(() => props.currentVersion, () => { listRequest++; loading.value = false; loaded.value = false; if (open.value) void load(); });
onBeforeUnmount(() => { disposed = true; listRequest++; versionRequest++; });
</script>

<template>
  <section class="panel memory-history" aria-labelledby="memory-history-title">
    <div class="history-heading"><h2 id="memory-history-title">版本历史</h2><button type="button" :aria-expanded="open" aria-controls="memory-history-content" data-testid="memory-history-open" @click="toggle">{{ open ? '收起历史' : '查看历史' }}</button></div>
    <div v-if="open" id="memory-history-content">
      <p class="muted small">每次保存产生一个新版本。使用旧正文只会填入草稿，保存时仍需校验当前版本。</p>
      <div v-if="error" class="error" role="alert" data-testid="memory-history-error">{{ error }} <button v-if="retryAction" type="button" class="text-button" :disabled="loading || reading" @click="retryAction?.()">重试读取</button></div>
      <div class="history-layout">
        <div><ul class="version-list" aria-label="已保存的版本"><li v-for="entry in versions" :key="entry.id"><button type="button" class="version-button" :aria-pressed="selected?.version === entry.version" :data-testid="`memory-history-version-${entry.version}`" @click="readVersion(entry.version)"><span class="version-label">版本 {{ entry.version }}<small>{{ entry.author.displayName }} · {{ memorySourceLabel(entry.source) }}</small></span><time :datetime="entry.createdAt">{{ memoryTime(entry.createdAt) }}</time></button></li></ul><p v-if="loading" class="muted small" role="status">正在读取历史…</p><p v-else-if="loaded && versions.length === 0" class="muted small">还没有已保存的版本。</p><button v-if="more" type="button" :disabled="loading" data-testid="memory-history-more" @click="load(versions.at(-1)?.version)">更早的版本</button></div>
        <div class="version-reader"><form class="version-jump" @submit.prevent="readVersion(Number(jumpVersion))"><label class="field">指定版本<input v-model="jumpVersion" type="number" min="1" step="1" required inputmode="numeric" placeholder="版本号" data-testid="memory-history-number" /></label><button type="submit" :disabled="reading" data-testid="memory-history-jump">查看版本</button></form><p v-if="reading" class="muted small" role="status">正在读取版本正文…</p><article v-if="selected" aria-labelledby="memory-version-title"><h3 id="memory-version-title">版本 {{ selected.version }}</h3><p class="muted small">{{ selected.author.displayName }} · {{ memorySourceLabel(selected.source) }} · {{ selected.byteLength.toLocaleString('en-US') }} 字节</p><pre data-testid="memory-history-text">{{ selected.markdown || '此版本正文为空。' }}</pre><button type="button" :disabled="readonly || reading" data-testid="memory-history-use" @click="useVersion">将此版本放入编辑草稿</button></article><p v-else-if="!reading" class="muted small">选择左侧版本，或输入任意已保存的版本号。</p></div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.memory-history { margin-top: 1.25rem; }.history-heading { display: flex; flex-wrap: wrap; justify-content: space-between; gap: .75rem; align-items: center; }.history-heading h2 { margin: 0; }
.history-layout { display: grid; grid-template-columns: minmax(220px, .85fr) minmax(0, 1.15fr); gap: 1.5rem; }.history-layout > div { min-width: 0; }
.version-list { list-style: none; padding: 0; margin: 0 0 .75rem; max-height: 420px; overflow: auto; }.version-list li + li { border-top: 1px solid var(--border); }
.version-button { width: 100%; border: 0; border-radius: 7px; background: transparent; text-align: left; display: flex; gap: .5rem; justify-content: space-between; align-items: start; padding: .75rem; white-space: normal; }
.version-button[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent); }.version-label { min-width: 0; overflow-wrap: anywhere; font-weight: 600; }.version-label small { display: block; margin-top: .25rem; color: var(--muted); font-weight: 400; }.version-button time { flex-shrink: 0; color: var(--muted); font-size: .75rem; }
.version-jump { display: flex; flex-wrap: wrap; gap: .75rem; align-items: end; margin-bottom: 1rem; }.version-jump .field { width: 120px; }.version-jump input { width: 100%; }
.version-reader pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 420px; overflow: auto; background: var(--surface-subtle); padding: 1rem; border-radius: 8px; font: inherit; line-height: 1.65; }.version-reader p { overflow-wrap: anywhere; }
@media (max-width: 900px) { .history-layout { grid-template-columns: 1fr; gap: 1rem; }.version-list { max-height: 280px; } }
@media (max-width: 480px) { .version-button { flex-direction: column; }.version-reader pre { padding: .75rem; } }
</style>

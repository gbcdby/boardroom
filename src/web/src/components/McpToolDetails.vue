<script setup lang="ts">
import type { McpCatalogSnapshot, McpCatalogTool } from "../api/mcp-connections.ts";
defineProps<{ tool: McpCatalogTool; snapshot: McpCatalogSnapshot; connectionName: string }>();
const format = (value: unknown) => JSON.stringify(value, null, 2);
</script>
<template>
  <section class="mcp-tool-details" data-testid="mcp-tool-details">
    <p class="eyebrow">工具来源</p><h3>{{ tool.title || tool.ref.name }}</h3><p class="muted small">{{ connectionName }} · 配置 v{{ tool.ref.connectionRevision }}</p>
    <div class="evidence"><span class="badge">目录已发现</span><p class="small">这是保存的完整目录，连接当前是否在线尚未核实。</p><p class="muted small">尚未向模型提供；选择、授权、加载与调用尚未接通。</p></div>
    <dl><div><dt>工具名</dt><dd><code>{{ tool.ref.name }}</code></dd></div><div><dt>连接标识</dt><dd><code>{{ tool.ref.connectionId }}</code></dd></div><div><dt>目录观察时间</dt><dd><time :datetime="snapshot.observedAt">{{ new Date(snapshot.observedAt).toLocaleString('zh-CN') }}</time></dd></div><div><dt>Schema 摘要</dt><dd><code>{{ tool.ref.schemaDigest }}</code></dd></div></dl>
    <p v-if="tool.description" class="tool-description">{{ tool.description }}</p>
    <details><summary>输入结构</summary><pre>{{ format(tool.inputSchema) }}</pre></details>
    <details v-if="tool.outputSchema"><summary>输出结构</summary><pre>{{ format(tool.outputSchema) }}</pre></details>
    <details v-if="tool.annotations"><summary>服务声明的提示</summary><p class="muted small">提示来自工具服务，不构成授权或行为保证。</p><pre>{{ format(tool.annotations) }}</pre></details>
  </section>
</template>
<style scoped>
.mcp-tool-details { min-width: 0; overflow-wrap: anywhere; }.eyebrow { font-size: .75rem; color: var(--muted); margin-top: 0; }h3 { font-size: 1.15rem; }.evidence { margin: 20px 0; padding: 16px; background: var(--surface-subtle); border-radius: 10px; }.evidence p:last-child { margin-bottom: 0; }dl { margin: 0 0 20px; }dl > div { padding: 12px 0; border-bottom: 1px solid var(--border); }dt { color: var(--muted); font-size: .8rem; margin-bottom: 4px; }dd { margin: 0; }code { padding: 0; background: transparent; }.tool-description { white-space: pre-wrap; font-size: .9rem; }pre { max-height: 300px; overflow: auto; padding: 12px; background: var(--surface-subtle); border-radius: 8px; }summary { font-size: .9rem; }
</style>

<script setup lang="ts">
import type { RuntimeBackend, RuntimeConfigDto, RuntimePermissionMode } from "../api/runtimes.ts";
import { configValue, type RuntimeConfigDraft } from "../api/runtime-display.ts";

const props = defineProps<{
  modelValue: RuntimeConfigDraft;
  backend: RuntimeBackend;
  idPrefix: string;
  disabled?: boolean;
  inherited?: RuntimeConfigDto;
  enabledFields?: Record<keyof RuntimeConfigDto, boolean>;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: RuntimeConfigDraft];
  "toggle-field": [field: keyof RuntimeConfigDto, enabled: boolean];
}>();
function enabled(field: keyof RuntimeConfigDto): boolean { return props.enabledFields?.[field] ?? true; }
function update<K extends keyof RuntimeConfigDraft>(field: K, value: RuntimeConfigDraft[K]): void {
  emit("update:modelValue", { ...props.modelValue, [field]: value });
}
function toggle(field: keyof RuntimeConfigDto, event: Event): void {
  emit("toggle-field", field, (event.target as HTMLInputElement).checked);
}
</script>

<template>
  <div class="runtime-config-grid">
    <div class="runtime-config-field full">
      <div class="field-heading">
        <label :for="`${idPrefix}-workdir`">工作目录</label>
        <label v-if="inherited" class="inherit-toggle"><input type="checkbox" :checked="enabled('workdir')" :disabled="disabled" aria-label="工作目录：单独设置" @change="toggle('workdir', $event)">单独设置</label>
      </div>
      <input :id="`${idPrefix}-workdir`" :value="modelValue.workdir" :disabled="disabled || !enabled('workdir')" required autocomplete="off" placeholder="本机已存在目录的绝对路径" @input="update('workdir', ($event.target as HTMLInputElement).value)">
      <span v-if="inherited && !enabled('workdir')" class="muted small">继承全局默认：{{ configValue(inherited, 'workdir') }}</span>
    </div>
    <div class="runtime-config-field">
      <div class="field-heading">
        <label :for="`${idPrefix}-model`">模型</label>
        <label v-if="inherited" class="inherit-toggle"><input type="checkbox" :checked="enabled('model')" :disabled="disabled" aria-label="模型：单独设置" @change="toggle('model', $event)">单独设置</label>
      </div>
      <input :id="`${idPrefix}-model`" :value="modelValue.model" :disabled="disabled || !enabled('model')" maxlength="256" placeholder="留空使用 CLI 默认模型" @input="update('model', ($event.target as HTMLInputElement).value)">
      <span v-if="inherited && !enabled('model')" class="muted small">继承全局默认：{{ configValue(inherited, 'model') }}</span>
    </div>
    <div class="runtime-config-field">
      <div class="field-heading">
        <label :for="`${idPrefix}-permission`">普通权限策略</label>
        <label v-if="inherited" class="inherit-toggle"><input type="checkbox" :checked="enabled('permissionMode')" :disabled="disabled" aria-label="普通权限策略：单独设置" @change="toggle('permissionMode', $event)">单独设置</label>
      </div>
      <select :id="`${idPrefix}-permission`" :value="modelValue.permissionMode" :disabled="disabled || !enabled('permissionMode')" @change="update('permissionMode', ($event.target as HTMLSelectElement).value as RuntimePermissionMode)">
        <template v-if="backend === 'claude-code'"><option value="auto">Auto（请求自动判断）</option><option value="manual">常规权限确认</option></template>
        <option v-else-if="backend === 'codex-cli'" value="workspace-write">Workspace write</option>
        <option v-else value="manual">常规权限确认</option>
      </select>
      <span class="muted small">实际生效模式以运行后的观测结果为准。需要人工确认的操作不会自动放行。</span>
    </div>
    <div class="runtime-config-field full">
      <div class="field-heading">
        <label :for="`${idPrefix}-tools-mode`">工具范围</label>
        <label v-if="inherited" class="inherit-toggle"><input type="checkbox" :checked="enabled('tools')" :disabled="disabled" aria-label="工具范围：单独设置" @change="toggle('tools', $event)">单独设置</label>
      </div>
      <select :id="`${idPrefix}-tools-mode`" :value="modelValue.toolsMode" :disabled="disabled || !enabled('tools')" @change="update('toolsMode', ($event.target as HTMLSelectElement).value as RuntimeConfigDraft['toolsMode'])">
        <option value="default">使用 CLI 默认工具</option><option value="allowlist">指定工具清单</option><option value="none">不开放通用工具</option>
      </select>
      <input v-if="modelValue.toolsMode === 'allowlist'" :id="`${idPrefix}-tools`" aria-label="工具清单" :value="modelValue.toolsText" :disabled="disabled || !enabled('tools')" required placeholder="例如 Read, Write, Edit, Glob, Grep, Bash" @input="update('toolsText', ($event.target as HTMLInputElement).value)">
      <span v-if="inherited && !enabled('tools')" class="muted small">继承全局默认：{{ configValue(inherited, 'tools') }}</span>
    </div>
    <div class="runtime-config-field full">
      <div class="field-heading">
        <label :for="`${idPrefix}-instructions`">附加指令</label>
        <label v-if="inherited" class="inherit-toggle"><input type="checkbox" :checked="enabled('systemPrompt')" :disabled="disabled" aria-label="附加指令：单独设置" @change="toggle('systemPrompt', $event)">单独设置</label>
      </div>
      <textarea :id="`${idPrefix}-instructions`" :value="modelValue.systemPrompt" :disabled="disabled || !enabled('systemPrompt')" rows="4" maxlength="16000" placeholder="追加到宿主默认提示中的协作要求" @input="update('systemPrompt', ($event.target as HTMLTextAreaElement).value)" />
      <span class="muted small">保存后等待显式应用；应用配置将于安全点重启，并建立新会话。</span>
    </div>
  </div>
</template>

<style scoped>
.runtime-config-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
.runtime-config-field { display: flex; min-width: 0; flex-direction: column; gap: .4rem; }
.full { grid-column: 1 / -1; }
.field-heading { display: flex; flex-wrap: wrap; justify-content: space-between; gap: .45rem; align-items: center; font-size: .9rem; }
.inherit-toggle { display: inline-flex; align-items: center; gap: .3rem; color: var(--muted); font-size: .8rem; }
input:not([type=checkbox]), select, textarea { width: 100%; padding: .6rem .7rem; border: 1px solid var(--border); border-radius: 6px; color: var(--fg); background: var(--card-bg); font: inherit; font-size: .9rem; }
input:disabled, select:disabled, textarea:disabled { opacity: .65; background: var(--bg); }
textarea { resize: vertical; }
@media (max-width: 620px) { .runtime-config-grid { grid-template-columns: 1fr; } }
</style>

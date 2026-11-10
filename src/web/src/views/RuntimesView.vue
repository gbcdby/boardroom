<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { api, type GroupDto, type ProjectDto } from "../api/client.ts";
import { runtimeApi, type RuntimeAction, type RuntimeBackend, type RuntimeBindingViewDto, type RuntimeConfigDto, type RuntimeViewDto } from "../api/runtimes.ts";
import { backendLabels, configDraft, configFields, configFromDraft, configValue, initialConfig, isStopped, runtimeError, type RuntimeConfigDraft } from "../api/runtime-display.ts";
import RuntimeConfigEditor from "../components/RuntimeConfigEditor.vue";
import RuntimeBindingCard from "../components/RuntimeBindingCard.vue";

const route = useRoute();
const router = useRouter();
const runtimes = ref<RuntimeViewDto[]>([]);
const projects = ref<ProjectDto[]>([]);
const projectGroups = ref<Record<string, GroupDto[]>>({});
const loading = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const refreshWarning = ref<string | null>(null);
const lastRefreshedAt = ref<string | null>(null);
const queryValue = (value: unknown): string => typeof value === "string" ? value : "";
const projectFilter = ref(queryValue(route.query["projectId"]));
const groupFilter = ref(queryValue(route.query["groupId"]));
let refreshSequence = 0;
let polling: ReturnType<typeof setInterval> | undefined;
let disposed = false;

const createOpen = ref(false);
const newName = ref("");
const newBackend = ref<RuntimeBackend>("claude-code");
const newProjectId = ref("");
const newGroupId = ref("");
const newConfig = ref<RuntimeConfigDraft>(initialConfig("claude-code"));
interface ConfigEditorState {
  kind: "default" | "binding";
  runtimeId: string; runtimeName: string; backend: RuntimeBackend; runtimeRevision: number;
  bindingId: string | null; bindingRevision: number; groupName: string;
  inherited: RuntimeConfigDto; draft: RuntimeConfigDraft;
  enabledFields: Record<keyof RuntimeConfigDto, boolean>;
  advanced: boolean;
}
const editor = ref<ConfigEditorState | null>(null);
const addingBinding = ref<{ runtime: RuntimeViewDto; projectId: string; groupId: string } | null>(null);
type Confirmation = { kind: "runtime"; view: RuntimeViewDto } | { kind: "binding" | "new-session"; view: RuntimeBindingViewDto };
const confirmation = ref<Confirmation | null>(null);
const dialog = ref<HTMLDialogElement | null>(null);
const formOpen = computed(() => createOpen.value || editor.value !== null || addingBinding.value !== null);

const visibleRuntimes = computed(() => runtimes.value.map((entry) => ({
  ...entry, bindings: entry.bindings.filter((view) => (!projectFilter.value || view.binding.projectId === projectFilter.value)
    && (!groupFilter.value || view.binding.groupId === groupFilter.value)),
})).filter((entry) => entry.bindings.length || (!projectFilter.value && !groupFilter.value)));
const visibleBindings = computed(() => visibleRuntimes.value.flatMap((entry) => entry.bindings));
const queuedCount = computed(() => visibleBindings.value.filter((view) => view.status.summary === "queued").length);
function groupsFor(projectId: string): GroupDto[] { return projectGroups.value[projectId] ?? []; }
function projectName(projectId: string): string { return projects.value.find((p) => p.id === projectId)?.name ?? "未加载的项目"; }
function groupName(projectId: string, groupId: string): string { return groupsFor(projectId).find((g) => g.id === groupId)?.name ?? "未加载的群组"; }
function fullRuntime(entry: RuntimeViewDto): RuntimeViewDto { return runtimes.value.find((item) => item.runtime.id === entry.runtime.id) ?? entry; }

async function loadGroups(projectId: string): Promise<void> {
  if (!projectId) return;
  const result = await api.listGroups(projectId);
  if (!disposed) projectGroups.value = { ...projectGroups.value, [projectId]: result.groups };
}
async function refresh(loadNames = false, background = false): Promise<void> {
  const sequence = ++refreshSequence;
  loading.value = true;
  if (!background) error.value = null;
  try {
    const [runtimeResult, projectResult] = await Promise.allSettled([runtimeApi.list(), api.listProjects()]);
    if (disposed || sequence !== refreshSequence) return;
    if (projectResult.status === "fulfilled") projects.value = projectResult.value.projects;
    if (runtimeResult.status === "rejected") throw runtimeResult.reason;
    if (projectResult.status === "rejected") throw projectResult.reason;
    runtimes.value = runtimeResult.value.runtimes;
    const missing = projects.value.filter((project) => loadNames || projectGroups.value[project.id] === undefined
      || runtimes.value.some((runtime) => runtime.bindings.some((view) => view.binding.projectId === project.id
        && !groupsFor(project.id).some((group) => group.id === view.binding.groupId))));
    const names = await Promise.allSettled(missing.map((project) => loadGroups(project.id)));
    if (disposed || sequence !== refreshSequence) return;
    refreshWarning.value = names.some((result) => result.status === "rejected") ? "部分群组名称暂不可用，可手动刷新重试。" : null;
    lastRefreshedAt.value = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  } catch (cause) {
    if (sequence === refreshSequence && !disposed) {
      if (background) refreshWarning.value = "自动刷新失败，当前显示最近一次快照。";
      else error.value = runtimeError(cause);
    }
  } finally { if (sequence === refreshSequence && !disposed) loading.value = false; }
}
async function mutate(action: () => Promise<void>, success: string): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = null;
  notice.value = null;
  ++refreshSequence;
  loading.value = false;
  try {
    await action();
    notice.value = success;
    await refresh(true);
  } catch (cause) { error.value = runtimeError(cause); }
  finally { busy.value = false; }
}
async function setFilter(): Promise<void> {
  groupFilter.value = "";
  await router.replace({ path: "/runtimes", query: projectFilter.value ? { projectId: projectFilter.value } : {} });
}
function setGroupFilter(): void {
  void router.replace({ path: "/runtimes", query: {
    ...(projectFilter.value ? { projectId: projectFilter.value } : {}), ...(groupFilter.value ? { groupId: groupFilter.value } : {}),
  } });
}
watch(() => route.query, (query) => { projectFilter.value = queryValue(query["projectId"]); groupFilter.value = queryValue(query["groupId"]); });
async function focusForm(): Promise<void> {
  await nextTick();
  const element = document.getElementById("runtime-editor");
  element?.scrollIntoView({ behavior: "smooth", block: "start" });
  element?.querySelector<HTMLInputElement>("input:not(:disabled)")?.focus({ preventScroll: true });
}
async function openCreate(): Promise<void> {
  if (formOpen.value) return;
  newName.value = ""; newBackend.value = "claude-code"; newConfig.value = initialConfig("claude-code");
  newProjectId.value = projectFilter.value || projects.value[0]?.id || "";
  newGroupId.value = groupFilter.value || groupsFor(newProjectId.value)[0]?.id || "";
  createOpen.value = true;
  await focusForm();
}
function changeBackend(): void { newConfig.value = { ...newConfig.value, permissionMode: initialConfig(newBackend.value).permissionMode }; }
async function changeCreateProject(): Promise<void> {
  newGroupId.value = "";
  try { await loadGroups(newProjectId.value); newGroupId.value = groupsFor(newProjectId.value)[0]?.id ?? ""; }
  catch (cause) { error.value = runtimeError(cause); }
}
async function create(): Promise<void> {
  if (!newProjectId.value || !newGroupId.value) { error.value = "请选择一个已有项目和群组。"; return; }
  await mutate(async () => {
    await runtimeApi.create({ name: newName.value.trim(), backend: newBackend.value,
      defaults: configFromDraft(newConfig.value), bindings: [{ projectId: newProjectId.value, groupId: newGroupId.value }] });
    createOpen.value = false;
  }, "托管 Agent 已创建并加入群组，当前保持停止。可以检查配置后显式启动。");
}
function enableAll(enabled: boolean): Record<keyof RuntimeConfigDto, boolean> {
  return { model: enabled, workdir: enabled, tools: enabled, systemPrompt: enabled, permissionMode: enabled };
}
async function editDefaults(entry: RuntimeViewDto): Promise<void> {
  if (formOpen.value) return;
  editor.value = { kind: "default", runtimeId: entry.runtime.id, runtimeName: entry.runtime.name,
    backend: entry.runtime.backend, runtimeRevision: entry.runtime.revision, bindingId: null, bindingRevision: 0,
    groupName: "", inherited: { ...entry.runtime.defaults }, draft: configDraft(entry.runtime.defaults),
    enabledFields: enableAll(true), advanced: false };
  await focusForm();
}
async function editBinding(view: RuntimeBindingViewDto): Promise<void> {
  if (formOpen.value) { error.value = "请先保存或取消当前正在编辑的配置。"; return; }
  const enabledFields = enableAll(false);
  for (const field of configFields) enabledFields[field] = Object.prototype.hasOwnProperty.call(view.binding.overrides, field);
  editor.value = { kind: "binding", runtimeId: view.runtime.id, runtimeName: view.runtime.name,
    backend: view.runtime.backend, runtimeRevision: view.runtime.revision,
    bindingId: view.binding.id, bindingRevision: view.binding.revision, groupName: groupName(view.binding.projectId, view.binding.groupId),
    inherited: { ...view.runtime.defaults }, draft: configDraft(view.effective.config), enabledFields, advanced: false };
  await focusForm();
}
function toggleField(field: keyof RuntimeConfigDto, enabled: boolean): void {
  if (!editor.value) return;
  editor.value.enabledFields[field] = enabled;
  if (!enabled) {
    const inherited = configDraft(editor.value.inherited);
    if (field === "tools") { editor.value.draft.toolsMode = inherited.toolsMode; editor.value.draft.toolsText = inherited.toolsText; }
    else if (field === "model") editor.value.draft.model = inherited.model;
    else if (field === "workdir") editor.value.draft.workdir = inherited.workdir;
    else if (field === "systemPrompt") editor.value.draft.systemPrompt = inherited.systemPrompt;
    else editor.value.draft.permissionMode = inherited.permissionMode;
  }
}
async function saveEditor(): Promise<void> {
  const edit = editor.value;
  if (!edit) return;
  const config = configFromDraft(edit.draft);
  await mutate(async () => {
    if (edit.kind === "default") await runtimeApi.saveDefaults(edit.runtimeId, edit.runtimeRevision, config);
    else if (edit.bindingId) {
      const overrides: Partial<RuntimeConfigDto> = {};
      for (const field of configFields) if (edit.enabledFields[field]) Object.assign(overrides, { [field]: config[field] });
      await runtimeApi.saveBinding(edit.bindingId, { runtimeRevision: edit.runtimeRevision, bindingRevision: edit.bindingRevision,
        overrides, advancedStrategy: edit.advanced ? "bypassPermissions" : null });
    }
    editor.value = null;
  }, "配置已保存。已有进程继续使用已应用配置；选择对应群组的“应用并重启”后才生效。");
}
async function openAddBinding(entry: RuntimeViewDto): Promise<void> {
  if (formOpen.value) return;
  const projectId = projectFilter.value || projects.value[0]?.id || "";
  addingBinding.value = { runtime: entry, projectId, groupId: "" };
  await changeBindingProject();
  await focusForm();
}
const availableBindingGroups = computed(() => {
  const adding = addingBinding.value;
  return adding ? groupsFor(adding.projectId).filter((group) => !adding.runtime.bindings.some((view) => view.binding.groupId === group.id)) : [];
});
async function changeBindingProject(): Promise<void> {
  const adding = addingBinding.value;
  if (!adding) return;
  adding.groupId = "";
  try { await loadGroups(adding.projectId); if (addingBinding.value === adding) adding.groupId = availableBindingGroups.value[0]?.id ?? ""; }
  catch (cause) { error.value = runtimeError(cause); }
}
async function addBinding(): Promise<void> {
  const adding = addingBinding.value;
  if (!adding?.projectId || !adding.groupId) return;
  await mutate(async () => {
    await runtimeApi.addBinding(adding.runtime.runtime.id, { projectId: adding.projectId, groupId: adding.groupId,
      expectedRuntimeRevision: adding.runtime.runtime.revision });
    addingBinding.value = null;
  }, "群组绑定已创建，继承全局默认并保持停止。");
}
async function action(view: RuntimeBindingViewDto, requested: RuntimeAction): Promise<void> {
  if (requested === "new-session") { confirmation.value = { kind: "new-session", view }; return; }
  const notices: Record<Exclude<RuntimeAction, "new-session">, string> = {
    start: "运行意图已保存；进程和连接状态以随后观测为准。", stop: "停止意图已保存；在途工作会等待安全点，确认退出后显示已停止。",
    apply: "应用请求已保存；在安全点退出后使用选定配置建立新会话。", retry: "重试意图已保存；服务端会重新检查运行资格。",
  };
  await mutate(async () => { await runtimeApi.action(view, requested); }, notices[requested]);
}
watch(confirmation, async (value) => {
  await nextTick();
  if (value && !dialog.value?.open) dialog.value?.showModal();
  if (!value && dialog.value?.open) dialog.value.close();
});
function cancelConfirmation(event?: Event): void { if (busy.value) event?.preventDefault(); else confirmation.value = null; }
async function confirm(): Promise<void> {
  const pending = confirmation.value;
  if (!pending) return;
  await mutate(async () => {
    if (pending.kind === "runtime") await runtimeApi.removeRuntime(pending.view.runtime.id);
    else if (pending.kind === "binding") await runtimeApi.removeBinding(pending.view.binding.id);
    else await runtimeApi.action(pending.view, "new-session");
    confirmation.value = null;
  }, pending.kind === "new-session" ? "新会话请求已保存；历史消息和待处理投递保留。" : "托管配置已移除，成员身份和历史消息保留。");
}

onMounted(async () => {
  await refresh(true);
  polling = setInterval(() => { if (!busy.value && !loading.value && !document.hidden) void refresh(false, true); }, 3_000);
});
onBeforeUnmount(() => { disposed = true; ++refreshSequence; if (polling) clearInterval(polling); });
</script>

<template>
  <section class="runtime-page">
    <header class="runtime-page-heading"><div><h1>托管 Agent</h1><p class="muted">管理真实 CLI 的群组绑定、配置和运行状态。</p></div><div class="actions"><button type="button" :disabled="busy || loading" @click="refresh(true)">{{ loading ? '刷新中…' : '刷新' }}</button><button type="button" class="primary" :disabled="busy || formOpen" data-testid="open-runtime-create" @click="openCreate">创建托管 Agent</button></div></header>
    <p v-if="error" class="error" role="alert" data-testid="runtime-error">{{ error }}</p>
    <p v-if="notice" class="success-notice" role="status" data-testid="runtime-notice">{{ notice }}</p>
    <p v-if="refreshWarning" class="muted small" role="status">{{ refreshWarning }}</p>

    <form v-if="createOpen" id="runtime-editor" class="card runtime-form" data-testid="runtime-create-form" @submit.prevent="create">
      <h2>创建托管 Agent</h2><p class="muted small">选择已有项目与群组。创建后保持停止，CLI 登录由宿主自行管理。</p>
      <div class="form-grid"><label class="field">名称<input v-model="newName" required maxlength="64" :disabled="busy" autocomplete="off" data-testid="runtime-name"></label><label class="field">CLI 宿主<select v-model="newBackend" :disabled="busy" data-testid="runtime-backend" @change="changeBackend"><option value="claude-code">Claude Code</option><option value="codex-cli">Codex CLI</option><option value="dsh">DSH</option></select></label>
        <label class="field">项目<select v-model="newProjectId" required :disabled="busy" @change="changeCreateProject"><option value="" disabled>选择项目</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option></select></label><label class="field">群组<select v-model="newGroupId" required :disabled="busy"><option value="" disabled>选择群组</option><option v-for="group in groupsFor(newProjectId)" :key="group.id" :value="group.id">{{ group.name }}</option></select></label></div>
      <p v-if="projects.length === 0 || groupsFor(newProjectId).length === 0" class="muted small">还没有可绑定的群组。<RouterLink to="/projects">前往项目与群组创建</RouterLink>。</p>
      <RuntimeConfigEditor v-model="newConfig" :backend="newBackend" id-prefix="runtime-create" :disabled="busy" />
      <div class="actions form-actions"><button type="submit" class="primary" :disabled="busy || !newProjectId || !newGroupId" data-testid="runtime-create">创建并保持停止</button><button type="button" :disabled="busy" @click="createOpen = false">取消</button></div>
    </form>

    <form v-if="editor" id="runtime-editor" class="card runtime-form" data-testid="runtime-config-form" @submit.prevent="saveEditor">
      <h2>{{ editor.kind === 'default' ? '编辑全局默认' : `群组配置 · ${editor.groupName}` }}</h2><p class="muted small">{{ editor.runtimeName }} · {{ backendLabels[editor.backend] }} · 编辑基于全局 v{{ editor.runtimeRevision }}<span v-if="editor.kind === 'binding'"> / 群组 v{{ editor.bindingRevision }}</span></p>
      <p class="muted small">{{ editor.kind === 'default' ? '保存默认值不会覆盖群组已单独设置的字段，也不会立即修改运行中的进程。' : '未单独设置的字段继承全局默认。取消“单独设置”会在本次保存时恢复继承。' }}</p>
      <RuntimeConfigEditor v-if="editor.kind === 'default'" v-model="editor.draft" :backend="editor.backend" id-prefix="runtime-default" :disabled="busy" />
      <RuntimeConfigEditor v-else v-model="editor.draft" :backend="editor.backend" :inherited="editor.inherited" :enabled-fields="editor.enabledFields" id-prefix="runtime-binding" :disabled="busy" @toggle-field="toggleField" />
      <fieldset v-if="editor.kind === 'binding' && editor.backend === 'claude-code'" class="advanced-settings"><legend>高级权限请求</legend><label class="checkbox-label"><input v-model="editor.advanced" type="checkbox" :disabled="busy" data-testid="runtime-advanced">跳过 CLI 常规权限确认</label><p class="small muted">每次编辑默认关闭，只作用于此群组的本次配置修订。保存后仍需显式应用；此权限档尚未验证或隔离不可用时，服务端会保持排队，开关不会绕过能力检查。</p></fieldset>
      <div class="actions form-actions"><button type="submit" class="primary" :disabled="busy" data-testid="runtime-save-config">保存配置</button><button type="button" :disabled="busy" @click="editor = null">取消</button></div>
    </form>

    <form v-if="addingBinding" id="runtime-editor" class="card runtime-form" @submit.prevent="addBinding"><h2>为 {{ addingBinding.runtime.runtime.name }} 添加群组绑定</h2><p class="muted small">继承此 Agent 的全局默认，创建独立会话。新绑定保持停止。</p><div class="form-grid"><label class="field">项目<select v-model="addingBinding.projectId" required :disabled="busy" @change="changeBindingProject"><option value="" disabled>选择项目</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option></select></label><label class="field">群组<select v-model="addingBinding.groupId" required :disabled="busy"><option value="" disabled>选择未绑定的群组</option><option v-for="group in availableBindingGroups" :key="group.id" :value="group.id">{{ group.name }}</option></select></label></div><p v-if="availableBindingGroups.length === 0" class="muted small">此项目暂无可添加的群组。</p><div class="actions"><button type="submit" class="primary" :disabled="busy || !addingBinding.groupId">添加绑定</button><button type="button" :disabled="busy" @click="addingBinding = null">取消</button></div></form>

    <div class="runtime-filters"><label class="field">项目范围<select v-model="projectFilter" @change="setFilter"><option value="">全部项目</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option></select></label><label v-if="projectFilter" class="field">群组范围<select v-model="groupFilter" @change="setGroupFilter"><option value="">全部群组</option><option v-for="group in groupsFor(projectFilter)" :key="group.id" :value="group.id">{{ group.name }}</option></select></label><p class="muted small">{{ visibleRuntimes.length }} 个托管配置 · {{ visibleBindings.length }} 个群组绑定 · {{ queuedCount }} 个排队中<br><span v-if="lastRefreshedAt">快照更新于 {{ lastRefreshedAt }}</span></p></div>
    <div v-if="!loading && visibleRuntimes.length === 0" class="card empty-state"><h2>{{ projectFilter || groupFilter ? '此范围内还没有托管 Agent' : '开始第一个托管 Agent' }}</h2><p class="muted">创建配置并绑定群组后，可以在这里显式启动、停止或应用更新。</p></div>
    <article v-for="entry in visibleRuntimes" :key="entry.runtime.id" class="card runtime-entry">
      <div class="runtime-entry-heading"><div><h2>{{ entry.runtime.name }} <span class="backend-tag">{{ backendLabels[entry.runtime.backend] }}</span></h2><p class="muted small">全局默认 v{{ entry.runtime.revision }} · {{ configValue(entry.runtime.defaults, 'model') }}</p><p class="muted small workdir">{{ entry.runtime.defaults.workdir }}</p></div><div class="actions"><button type="button" :disabled="busy || formOpen" @click="editDefaults(entry)">全局默认</button><button type="button" :disabled="busy || formOpen" @click="openAddBinding(fullRuntime(entry))">添加群组</button><button type="button" class="danger" :disabled="busy || !fullRuntime(entry).bindings.every(isStopped)" title="所有绑定停止并确认进程退出后可删除" @click="confirmation = { kind: 'runtime', view: fullRuntime(entry) }">删除配置</button></div></div>
      <div class="binding-list"><RuntimeBindingCard v-for="view in entry.bindings" :key="view.binding.id" :view="view" :busy="busy" :project-name="projectName(view.binding.projectId)" :group-name="groupName(view.binding.projectId, view.binding.groupId)" @edit="editBinding(view)" @action="action(view, $event)" @remove="confirmation = { kind: 'binding', view }" /></div>
      <p v-if="entry.bindings.length === 0" class="muted small">暂无群组绑定，可以添加已有群组。</p>
    </article>

    <dialog ref="dialog" class="runtime-dialog" aria-labelledby="runtime-confirm-title" @cancel="cancelConfirmation">
      <template v-if="confirmation"><h2 id="runtime-confirm-title">{{ confirmation.kind === 'new-session' ? '建立新的独立会话' : confirmation.kind === 'runtime' ? '删除托管配置' : '解除群组绑定' }}</h2><p><strong>{{ confirmation.view.runtime.name }}</strong><span v-if="confirmation.kind !== 'runtime'"> · {{ groupName(confirmation.view.binding.projectId, confirmation.view.binding.groupId) }}</span></p><p v-if="confirmation.kind === 'runtime'">将解除全部 {{ confirmation.view.bindings.length }} 个群组绑定，包括当前筛选范围外的绑定。</p><p v-if="confirmation.kind === 'new-session'">服务端会在安全点结束自有进程，并使用已应用配置建立新会话。未确认消息可能再次投递；历史消息会保留。待应用配置请另用“应用并重启”。</p><p v-else>仅移除此托管配置或群组绑定；成员身份、历史消息与 CLI 登录资料保留。仍有运行进程时，服务端会拒绝删除。</p><p v-if="error" class="error" role="alert">{{ error }}</p><div class="actions"><button type="button" :disabled="busy" autofocus @click="cancelConfirmation()">取消</button><button type="button" :disabled="busy" :class="confirmation.kind === 'new-session' ? 'primary' : 'danger'" data-testid="runtime-confirm" @click="confirm">{{ confirmation.kind === 'new-session' ? '确认建立新会话' : '确认移除配置' }}</button></div></template>
    </dialog>
  </section>
</template>

<style scoped>
.runtime-page-heading, .runtime-entry-heading { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 1rem; }
h1 { margin: 0; font-size: 1.5rem; } h2 { margin: 0 0 .5rem; font-size: 1.05rem; }
.runtime-page-heading p, .runtime-entry-heading p { margin: .35rem 0; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
button { padding: .5rem .75rem; border: 1px solid var(--border); border-radius: 6px; background: var(--card-bg); color: var(--fg); cursor: pointer; font: inherit; font-size: .82rem; }
button:disabled { opacity: .45; cursor: not-allowed; } button.primary { background: var(--accent); color: white; border-color: var(--accent); } button.danger { color: var(--bad); }
.runtime-form, .runtime-entry, .empty-state { margin-top: 1.25rem; }
.runtime-form { scroll-margin-top: 1rem; }
.runtime-form h2 { font-size: 1.1rem; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; margin: 1rem 0; }
.field { display: flex; flex-direction: column; gap: .35rem; font-size: .85rem; min-width: 0; }
.field input, .field select { padding: .6rem .7rem; border: 1px solid var(--border); border-radius: 6px; color: var(--fg); background: var(--card-bg); font: inherit; width: 100%; }
.form-actions { margin-top: 1.2rem; }
.advanced-settings { margin-top: 1rem; border: 1px solid var(--border); border-radius: 6px; padding: .8rem; }
.advanced-settings legend { font-size: .8rem; color: var(--muted); }.checkbox-label { display: flex; align-items: center; gap: .45rem; font-size: .9rem; }
.runtime-filters { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 1rem; margin: 1.5rem 0 1rem; }
.runtime-filters .field { min-width: 170px; }.runtime-filters p { margin: 0 0 .3rem auto; text-align: right; }
.backend-tag { display: inline-block; font-size: .72rem; font-weight: 400; color: var(--muted); border: 1px solid var(--border); border-radius: 4px; padding: .15rem .4rem; vertical-align: middle; margin-left: .4rem; }
.binding-list { display: grid; gap: 1rem; margin-top: 1rem; }.workdir { overflow-wrap: anywhere; }
.success-notice { border-left: 3px solid var(--ok); background: rgba(21, 127, 59, .07); padding: .75rem; font-size: .87rem; }
.runtime-dialog { width: min(520px, calc(100% - 2rem)); border: 1px solid var(--border); border-radius: 10px; padding: 1.4rem; color: var(--fg); background: var(--card-bg); }
.runtime-dialog::backdrop { background: rgba(0, 0, 0, .4); }.runtime-dialog p { font-size: .9rem; }.runtime-dialog .actions { justify-content: flex-end; margin-top: 1.2rem; }
@media (max-width: 620px) { .form-grid { grid-template-columns: 1fr; }.runtime-filters p { text-align: left; margin-left: 0; }.runtime-entry { padding: 1rem; } }
</style>

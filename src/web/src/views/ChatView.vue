<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { ApiError, api, type GroupDto, type MemberDto, type MessageDto, type ProjectDto } from "../api/client.ts";

const route = useRoute();
const queryValue = (value: unknown): string => typeof value === "string" ? value : "";
const projects = ref<ProjectDto[]>([]);
const activeProjectId = ref<string | null>(null);
const groups = ref<GroupDto[]>([]);
const members = ref<MemberDto[]>([]);
const activeGroupId = ref<string | null>(null);
const senderId = ref<string | null>(null);
const messages = ref<MessageDto[]>([]);
const draft = ref("");
const error = ref<string | null>(null);
const loadError = ref<"projects" | "project" | "history" | null>(null);
const projectsLoading = ref(true);
const projectLoading = ref(false);
const historyLoading = ref(false);
const sending = ref(false);
const composing = ref(false);
const wsState = ref<"connecting" | "open" | "closed">("closed");
const messageList = ref<HTMLUListElement | null>(null);
const composer = ref<HTMLTextAreaElement | null>(null);
const atBottom = ref(true);
const newMessages = ref(false);

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let disposed = false;
let projectRequest = 0;
let historyRequest = 0;
let contextRevision = 0;
let draftRevision = 0;

const activeGroup = computed(() => groups.value.find((g) => g.id === activeGroupId.value) ?? null);
const humanMembers = computed(() => members.value.filter((m) => m.kind === "human" && m.status === "active"));
const canCompose = computed(() => !!activeGroup.value && activeGroup.value.writable !== false && senderId.value !== null);
const canSend = computed(() => canCompose.value && !sending.value && !historyLoading.value && draft.value.trim() !== "");
const wsLabel = computed(() => wsState.value === "open" ? "实时已连接" : wsState.value === "connecting" ? "正在连接" : "连接中断，正在重连");

function errorMessage(err: unknown): string {
  return err instanceof ApiError || err instanceof Error ? err.message : "请求失败，请重试。";
}

async function loadProjects(): Promise<void> {
  projectsLoading.value = true;
  error.value = null;
  loadError.value = null;
  try {
    const result = await api.listProjects();
    if (disposed) return;
    projects.value = result.projects;
    if (activeProjectId.value === null || !projects.value.some((p) => p.id === activeProjectId.value)) {
      const requested = queryValue(route.query["projectId"]);
      activeProjectId.value = projects.value.find((p) => p.id === requested)?.id ?? projects.value[0]?.id ?? null;
    }
  } catch (err) {
    if (!disposed) {
      error.value = errorMessage(err);
      loadError.value = "projects";
    }
  } finally {
    if (!disposed) projectsLoading.value = false;
  }
}

async function loadProject(projectId: string): Promise<void> {
  const request = ++projectRequest;
  projectLoading.value = true;
  error.value = null;
  loadError.value = null;
  try {
    const [groupResult, memberResult] = await Promise.all([api.listGroups(projectId), api.listMembers(projectId)]);
    if (disposed || request !== projectRequest || activeProjectId.value !== projectId) return;
    groups.value = groupResult.groups;
    members.value = memberResult.members;
    senderId.value = humanMembers.value[0]?.id ?? null;
    const requested = queryValue(route.query["groupId"]);
    activeGroupId.value = groups.value.find((g) => g.id === requested)?.id ?? groups.value[0]?.id ?? null;
  } catch (err) {
    if (!disposed && request === projectRequest && activeProjectId.value === projectId) {
      error.value = errorMessage(err);
      loadError.value = "project";
    }
  } finally {
    if (!disposed && request === projectRequest) projectLoading.value = false;
  }
}

function mergeMessages(incoming: MessageDto[]): void {
  const byId = new Map(messages.value.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  messages.value = [...byId.values()].sort((a, b) => a.seq - b.seq);
}

async function loadHistory(groupId: string): Promise<void> {
  const request = ++historyRequest;
  historyLoading.value = true;
  loadError.value = null;
  error.value = null;
  try {
    const result = await api.listMessages(groupId);
    if (disposed || request !== historyRequest || activeGroupId.value !== groupId) return;
    // 保留读取历史期间已经到达的实时消息，避免较早的快照覆盖新消息。
    mergeMessages(result.messages);
  } catch (err) {
    if (!disposed && request === historyRequest && activeGroupId.value === groupId) {
      error.value = errorMessage(err);
      loadError.value = "history";
    }
  } finally {
    if (!disposed && request === historyRequest) historyLoading.value = false;
  }
}

function retryLoad(): void {
  if (loadError.value === "projects") void loadProjects();
  else if (loadError.value === "project" && activeProjectId.value) void loadProject(activeProjectId.value);
  else if (loadError.value === "history" && activeGroupId.value) void loadHistory(activeGroupId.value);
}

function connectWs(): void {
  if (disposed || socket) return;
  wsState.value = "connecting";
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const current = new WebSocket(`${protocol}//${location.host}/ws`);
  socket = current;
  current.addEventListener("open", () => {
    if (disposed || socket !== current) return;
    wsState.value = "open";
    if (activeGroupId.value) void loadHistory(activeGroupId.value);
  });
  current.addEventListener("close", () => {
    if (disposed || socket !== current) return;
    wsState.value = "closed";
    socket = null;
    reconnectTimer = setTimeout(connectWs, 2000);
  });
  current.addEventListener("error", () => {
    if (!disposed && socket === current) wsState.value = "closed";
  });
  current.addEventListener("message", (event) => {
    if (disposed || socket !== current) return;
    let payload: { type?: string; message?: MessageDto };
    try { payload = JSON.parse(String(event.data)); }
    catch { return; }
    if (payload && payload.type === "message" && payload.message?.groupId === activeGroupId.value) {
      mergeMessages([payload.message]);
    }
  });
}

function selectProject(projectId: string): void {
  activeProjectId.value = projectId || null;
}

function selectGroup(groupId: string): void {
  activeGroupId.value = groupId || null;
}

function insertMention(member: MemberDto): void {
  if (!canCompose.value) return;
  const token = `@${member.displayName} `;
  draft.value = draft.value.length > 0 ? `${draft.value} ${token}` : token;
  composer.value?.focus();
}

function insertAll(): void {
  if (!canCompose.value) return;
  draft.value = `${draft.value} @all `.trimStart();
  composer.value?.focus();
}

function onComposerKeydown(event: KeyboardEvent): void {
  if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
  // 部分输入法在 compositionend 附近的 Enter 仍用 keyCode 229 标记。
  if (event.isComposing || composing.value || event.keyCode === 229) return;
  event.preventDefault();
  void send();
}

async function send(): Promise<void> {
  if (sending.value || !canSend.value || composing.value) return;
  const groupId = activeGroupId.value;
  const sender = senderId.value;
  if (groupId === null || sender === null) return;
  const text = draft.value.trim();
  const revision = draftRevision;
  const context = contextRevision;
  sending.value = true;
  error.value = null;
  try {
    const result = await api.sendMessage(groupId, sender, text);
    if (disposed || context !== contextRevision || activeGroupId.value !== groupId) return;
    if (draftRevision === revision) draft.value = "";
    mergeMessages([result.message]);
  } catch (err) {
    if (!disposed && context === contextRevision && activeGroupId.value === groupId) error.value = errorMessage(err);
  } finally {
    if (!disposed) sending.value = false;
  }
}

function nameOf(memberId: string): string {
  return members.value.find((m) => m.id === memberId)?.displayName ?? memberId;
}

function timeLabel(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function fullTimeLabel(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("zh-CN");
}

function updateScrollPosition(): void {
  const list = messageList.value;
  if (!list) return;
  atBottom.value = list.scrollHeight - list.scrollTop - list.clientHeight < 64;
  if (atBottom.value) newMessages.value = false;
}

function scrollToLatest(): void {
  const list = messageList.value;
  if (!list) return;
  list.scrollTop = list.scrollHeight;
  atBottom.value = true;
  newMessages.value = false;
}

watch(draft, () => { draftRevision += 1; }, { flush: "sync" });
watch(activeProjectId, (id) => {
  projectRequest += 1;
  contextRevision += 1;
  groups.value = [];
  members.value = [];
  senderId.value = null;
  activeGroupId.value = null;
  if (id !== null) void loadProject(id);
  else projectLoading.value = false;
}, { flush: "sync" });
watch(activeGroupId, (id) => {
  historyRequest += 1;
  contextRevision += 1;
  messages.value = [];
  draft.value = "";
  composing.value = false;
  error.value = null;
  loadError.value = null;
  atBottom.value = true;
  newMessages.value = false;
  if (id !== null) void loadHistory(id);
  else historyLoading.value = false;
}, { flush: "sync" });
watch(() => messages.value.length, async (length, previous) => {
  const follow = atBottom.value;
  await nextTick();
  if (follow) scrollToLatest();
  else if (length > previous) newMessages.value = true;
});
watch(() => route.query, (query) => {
  const projectId = queryValue(query["projectId"]);
  const groupId = queryValue(query["groupId"]);
  if (projectId && projects.value.some((p) => p.id === projectId)) {
    if (activeProjectId.value !== projectId) activeProjectId.value = projectId;
    else if (groups.value.some((g) => g.id === groupId)) activeGroupId.value = groupId;
  }
});

onMounted(() => {
  connectWs();
  void loadProjects();
});

onBeforeUnmount(() => {
  disposed = true;
  projectRequest += 1;
  historyRequest += 1;
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  socket?.close();
  socket = null;
});
</script>

<template>
  <section class="page chat-page">
    <header class="page-header">
      <div>
        <h1>群聊</h1>
        <p class="page-description">与项目成员交流，用 @ 提及需要参与的人或 Agent。</p>
      </div>
      <span class="badge connection-badge" :class="wsState" data-testid="chat-ws" role="status">{{ wsLabel }}</span>
    </header>

    <div v-if="error" class="error" role="alert" data-testid="chat-error">
      <span>{{ error }}</span>
      <button v-if="loadError" type="button" class="text-button" :disabled="projectsLoading || projectLoading || historyLoading" @click="retryLoad">重新加载</button>
    </div>

    <div class="panel chat-controls">
      <label class="field">
        项目
        <select :value="activeProjectId ?? ''" :disabled="projectsLoading || projects.length === 0" data-testid="chat-project" @change="selectProject(($event.target as HTMLSelectElement).value)">
          <option v-if="projects.length === 0" value="">{{ projectsLoading ? '正在加载项目…' : '暂无项目' }}</option>
          <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option>
        </select>
      </label>
      <label class="field">
        群组
        <select :value="activeGroupId ?? ''" :disabled="projectLoading || groups.length === 0" data-testid="chat-group" @change="selectGroup(($event.target as HTMLSelectElement).value)">
          <option v-if="groups.length === 0" value="">{{ projectLoading ? '正在加载群组…' : '暂无群组' }}</option>
          <option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}</option>
        </select>
      </label>
      <label class="field">
        发送身份
        <select v-model="senderId" :disabled="projectLoading || humanMembers.length === 0 || sending" data-testid="chat-sender">
          <option v-if="humanMembers.length === 0" :value="null">暂无可用身份</option>
          <option v-for="member in humanMembers" :key="member.id" :value="member.id">{{ member.displayName }}</option>
        </select>
      </label>
    </div>

    <div v-if="projectsLoading || projectLoading" class="panel empty-state" role="status">正在加载群聊…</div>
    <div v-else-if="activeGroupId === null && !loadError" class="panel empty-state">
      <h2>{{ projects.length === 0 ? '从一个项目开始' : '还没有群组' }}</h2>
      <p class="muted">创建项目、添加成员并组建群组后，就可以在这里开始交流。</p>
      <RouterLink class="primary" to="/projects">前往项目与群组</RouterLink>
    </div>
    <section v-else-if="activeGroupId !== null" class="panel conversation" :aria-label="activeGroup?.name ?? '当前群聊'">
      <div class="conversation-heading">
        <div><h2>{{ activeGroup?.name }}</h2><span class="muted small">{{ messages.length }} 条消息</span></div>
        <RouterLink v-if="activeProjectId" :to="{ path: '/runtimes', query: { projectId: activeProjectId, groupId: activeGroupId } }" class="text-button">管理托管 Agent</RouterLink>
      </div>

      <div role="log" aria-label="群聊消息" :aria-live="historyLoading ? 'off' : 'polite'" aria-relevant="additions" :aria-busy="historyLoading">
      <ul ref="messageList" class="messages" data-testid="chat-messages" aria-label="群聊记录" tabindex="0" @scroll="updateScrollPosition">
        <li v-if="historyLoading && messages.length === 0" class="conversation-empty" role="status">正在读取消息…</li>
        <li v-else-if="messages.length === 0 && !loadError" class="conversation-empty"><strong>开始这段对话</strong><span class="muted">发送一条消息，让协作开始。</span></li>
        <li v-for="message in messages" :key="message.id" class="message" :class="{ own: message.senderMemberId === senderId }">
          <div class="message-heading">
            <span class="sender">{{ message.senderDisplayName ?? nameOf(message.senderMemberId) }}</span>
            <time :datetime="message.createdAt" :title="fullTimeLabel(message.createdAt)">{{ timeLabel(message.createdAt) }}</time>
            <span class="sequence" :title="`消息序号 ${message.seq}`">#{{ message.seq }}</span>
          </div>
          <p class="message-text">{{ message.text }}</p>
          <p v-if="message.mentions.length > 0" class="mentions">提及：{{ message.mentions.map(nameOf).join('、') }}</p>
        </li>
      </ul>
      </div>
      <button v-if="newMessages" type="button" class="latest-button" @click="scrollToLatest">查看新消息 ↓</button>

      <p v-if="activeGroup?.writable === false" class="notice" role="status">当前群组为只读，可查看历史消息。</p>
      <p v-else-if="humanMembers.length === 0" class="notice" role="status">请先在「项目与群组」添加或恢复一个人的成员身份，再发送消息。</p>

      <form class="composer" @submit.prevent="send">
        <label class="field" for="chat-message">消息</label>
        <textarea id="chat-message" ref="composer" v-model="draft" rows="3" :disabled="!canCompose" aria-describedby="chat-composer-help" placeholder="输入消息，支持 @显示名 / @all" data-testid="chat-input" @keydown="onComposerKeydown" @compositionstart="composing = true" @compositionend="composing = false" />
        <div class="composer-footer">
          <p id="chat-composer-help" class="muted small">Enter 发送 · Shift + Enter 换行</p>
          <button type="submit" class="primary" :disabled="!canSend" data-testid="chat-send">{{ sending ? '发送中…' : '发送' }}</button>
        </div>
        <div class="mention-picker" data-testid="chat-member-picker">
          <span class="muted small">提及</span>
          <button type="button" class="text-button" :disabled="!canCompose" data-testid="chat-mention-all" @click="insertAll">@all</button>
          <button v-for="member in members" :key="member.id" type="button" class="text-button" :disabled="!canCompose" @click="insertMention(member)">@{{ member.displayName }}</button>
        </div>
      </form>
    </section>

    <details class="chat-help small muted">
      <summary>消息与提及说明</summary>
      <p>@all 提及群内在线成员。普通 Agent 在被 @ 时获得消息唤醒；manager 接收其他成员的消息。消息送达与 Agent 开始执行是不同状态，实际处理取决于宿主能力。</p>
      <p v-if="activeGroup">当前群组 ID：<code>{{ activeGroup.id }}</code></p>
    </details>
  </section>
</template>

<style scoped>
.connection-badge { flex: 0 1 auto; }
.connection-badge.open { color: var(--ok); }
.connection-badge.closed { color: var(--warn); }
.chat-controls { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem; }
.chat-controls .field, .chat-controls select { width: 100%; min-width: 0; }
.conversation { position: relative; padding: 0; overflow: hidden; }
.conversation-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; padding: 1.25rem 1.5rem; border-bottom: 1px solid var(--border); }
.conversation-heading > div { min-width: 0; }
.conversation-heading h2 { margin: 0 0 0.2rem; font-size: 1.05rem; overflow-wrap: anywhere; }
.messages { margin: 0; padding: 1.5rem; list-style: none; display: flex; flex-direction: column; gap: 1.5rem; min-height: 260px; max-height: min(56dvh, 640px); overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; }
.messages:focus-visible { outline-offset: -3px; }
.conversation-empty { flex: 1; min-height: 200px; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 0.5rem; text-align: center; color: var(--muted); }
.conversation-empty strong { color: var(--fg); font-weight: 500; }
.message { min-width: 0; }
.message-heading { display: flex; gap: 0.65rem; align-items: baseline; flex-wrap: wrap; color: var(--muted); font-size: 0.8rem; }
.sender { font-weight: 600; color: var(--fg); overflow-wrap: anywhere; }
.sequence { margin-left: auto; font-variant-numeric: tabular-nums; }
.message-text { margin: 0.4rem 0 0; padding: 0.8rem 1rem; background: var(--surface-subtle); border-radius: 0 12px 12px 12px; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.65; }
.message.own .message-text { background: var(--accent-soft); }
.mentions { margin: 0.4rem 0 0; color: var(--muted); font-size: 0.8rem; overflow-wrap: anywhere; }
.latest-button { display: block; margin: 0 auto 0.75rem; color: var(--accent); }
.conversation > .notice { margin: 0 1.5rem 1rem; }
.composer { padding: 1.25rem 1.5rem; border-top: 1px solid var(--border); }
.composer > .field { display: block; margin-bottom: 0.45rem; }
.composer textarea { display: block; width: 100%; min-width: 0; min-height: 96px; resize: vertical; }
.composer-footer { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-top: 0.75rem; }
.composer-footer p { margin: 0; }
.mention-picker { display: flex; flex-wrap: wrap; gap: 0.25rem; align-items: center; margin-top: 0.75rem; }
.mention-picker > span { margin-right: 0.35rem; }
.mention-picker button { min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
.chat-help { margin-top: 0.25rem; }
.chat-help summary { cursor: pointer; padding: 0.4rem 0; }
.chat-help p { max-width: 80ch; overflow-wrap: anywhere; }
@media (max-width: 720px) {
  .chat-controls { grid-template-columns: 1fr; }
  .conversation-heading, .composer, .messages { padding: 1rem; }
  .messages { max-height: 52dvh; }
  .conversation > .notice { margin: 0 1rem 1rem; }
  .composer-footer { align-items: flex-end; }
  .composer-footer p { flex: 1 1 160px; }
}
</style>

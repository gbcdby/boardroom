<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  ApiError,
  api,
  type GroupDto,
  type MemberDto,
  type MessageDto,
  type ProjectDto,
} from "../api/client.ts";

/**
 * T3（#16）群聊面板（人的视角）。
 *
 * - 选择项目 → 选择群组 → 以某个「人」成员身份发送消息（阶段 1 无认证，前端选择身份）。
 * - 发送通过 HTTP `POST /api/groups/:id/messages`；历史通过 GET。
 * - 实时：连接 WebSocket `/ws`，收到 `message` 事件即追加（顺序与持久化 seq 一致）。
 * - @：输入 `@显示名` / `@all`（服务端解析，非法 @ 报错）。也可从成员列表点选插入 @。
 */

const projects = ref<ProjectDto[]>([]);
const activeProjectId = ref<string | null>(null);
const groups = ref<GroupDto[]>([]);
const members = ref<MemberDto[]>([]);
const activeGroupId = ref<string | null>(null);
const senderId = ref<string | null>(null);
const messages = ref<MessageDto[]>([]);
const draft = ref("");
const error = ref<string | null>(null);
const busy = ref(false);
const wsState = ref<"connecting" | "open" | "closed">("closed");

let socket: WebSocket | null = null;

const activeProject = computed(() => projects.value.find((p) => p.id === activeProjectId.value) ?? null);
const activeGroup = computed(() => groups.value.find((g) => g.id === activeGroupId.value) ?? null);
const humanMembers = computed(() => members.value.filter((m) => m.kind === "human"));

function clearError(): void {
  error.value = null;
}

async function run<T>(fn: () => Promise<T>): Promise<T | null> {
  clearError();
  busy.value = true;
  try {
    return await fn();
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : (err as Error).message;
    return null;
  } finally {
    busy.value = false;
  }
}

async function loadProjects(): Promise<void> {
  const result = await run(() => api.listProjects());
  if (!result) return;
  projects.value = result.projects;
  if (activeProjectId.value === null && projects.value.length > 0) {
    activeProjectId.value = projects.value[0]!.id;
  }
}

async function loadProject(projectId: string): Promise<void> {
  const [g, m] = await Promise.all([run(() => api.listGroups(projectId)), run(() => api.listMembers(projectId))]);
  if (g) groups.value = g.groups;
  if (m) members.value = m.members;
  activeGroupId.value = groups.value[0]?.id ?? null;
  senderId.value = humanMembers.value[0]?.id ?? null;
}

async function loadHistory(groupId: string): Promise<void> {
  const result = await run(() => api.listMessages(groupId));
  if (result) messages.value = result.messages;
}

function connectWs(): void {
  if (socket) return;
  wsState.value = "connecting";
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${proto}//${location.host}/ws`);
  socket.addEventListener("open", () => (wsState.value = "open"));
  socket.addEventListener("close", () => (wsState.value = "closed"));
  socket.addEventListener("message", (ev) => {
    let event: { type?: string; message?: MessageDto };
    try {
      event = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (event.type === "message" && event.message) {
      const incoming = event.message;
      if (activeGroupId.value !== null && incoming.groupId === activeGroupId.value) {
        // 去重：HTTP 响应已追加过的（同 id）不重复追加；按 seq 保持顺序。
        if (!messages.value.some((m) => m.id === incoming.id)) {
          messages.value = [...messages.value, incoming].sort((a, b) => a.seq - b.seq);
        }
      }
    }
  });
}

async function selectProject(projectId: string): Promise<void> {
  activeProjectId.value = projectId;
}

async function selectGroup(groupId: string): Promise<void> {
  activeGroupId.value = groupId;
  await loadHistory(groupId);
}

function insertMention(member: MemberDto): void {
  const token = `@${member.displayName} `;
  draft.value = draft.value.length > 0 ? `${draft.value} ${token}` : token;
}

function insertAll(): void {
  draft.value = `${draft.value} @all`.trim();
}

async function send(): Promise<void> {
  const groupId = activeGroupId.value;
  const sender = senderId.value;
  const text = draft.value.trim();
  if (groupId === null || sender === null) {
    error.value = "请先选择群组与发送身份。";
    return;
  }
  if (text === "") {
    error.value = "消息不能为空。";
    return;
  }
  const result = await run(() => api.sendMessage(groupId, sender, text));
  if (!result) return;
  draft.value = "";
  if (!messages.value.some((m) => m.id === result.message.id)) {
    messages.value = [...messages.value, result.message].sort((a, b) => a.seq - b.seq);
  }
}

function nameOf(memberId: string): string {
  return members.value.find((m) => m.id === memberId)?.displayName ?? memberId;
}

watch(activeProjectId, (id) => {
  messages.value = [];
  if (id !== null) void loadProject(id);
});
watch(activeGroupId, (id) => {
  if (id !== null) void loadHistory(id);
});

onMounted(async () => {
  await loadProjects();
  connectWs();
});

onBeforeUnmount(() => {
  socket?.close();
  socket = null;
});
</script>

<template>
  <section class="card">
    <h1>群聊</h1>
    <p class="muted">
      选择项目与群组，以成员身份发送消息。支持 @ 单人（@显示名）、@ 多人、@ 全体（@all）。
      普通 agent 只被 @ 唤醒；manager 被其他成员的消息唤醒；发送者不会被自己的消息唤醒。
    </p>

    <p v-if="error" class="error" data-testid="chat-error">{{ error }}</p>

    <div class="row">
      <label class="field">
        项目
        <select :value="activeProjectId ?? ''" data-testid="chat-project" @change="selectProject(($event.target as HTMLSelectElement).value)">
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
      </label>
      <label class="field">
        群组
        <select :value="activeGroupId ?? ''" data-testid="chat-group" @change="selectGroup(($event.target as HTMLSelectElement).value)">
          <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
        </select>
      </label>
      <label class="field">
        发送身份
        <select v-model="senderId" data-testid="chat-sender">
          <option v-for="m in humanMembers" :key="m.id" :value="m.id">{{ m.displayName }}</option>
        </select>
      </label>
      <span class="muted small" data-testid="chat-ws">WS：{{ wsState }}</span>
    </div>

    <div v-if="activeGroupId === null" class="muted">暂无群组，请先在「项目与群组」中创建。</div>
    <template v-else>
      <ul class="messages" data-testid="chat-messages">
        <li v-for="msg in messages" :key="msg.id" class="msg">
          <span class="sender">{{ msg.senderDisplayName ?? nameOf(msg.senderMemberId) }}</span>
          <span class="seq">#{{ msg.seq }}</span>
          <span class="text">{{ msg.text }}</span>
          <span v-if="msg.mentions.length > 0" class="mentions">
            @{{ msg.mentions.map(nameOf).join("、") }}
          </span>
        </li>
        <li v-if="messages.length === 0" class="muted">暂无消息。</li>
      </ul>

      <div class="row">
        <input v-model="draft" placeholder="输入消息，支持 @显示名 / @all" data-testid="chat-input" @keyup.enter="send" />
        <button type="button" :disabled="busy" data-testid="chat-send" @click="send">发送</button>
        <button type="button" :disabled="busy" data-testid="chat-mention-all" @click="insertAll">@all</button>
      </div>
      <div class="row small" data-testid="chat-member-picker">
        <span class="muted">提及：</span>
        <button
          v-for="m in members"
          :key="m.id"
          type="button"
          class="chip"
          @click="insertMention(m)"
        >
          @{{ m.displayName }}
        </button>
      </div>
      <p v-if="activeGroup" class="muted small">当前群组：{{ activeGroup.name }}（ID: {{ activeGroup.id }}）</p>
    </template>
  </section>
</template>

<style scoped>
.row {
  display: flex;
  gap: 0.5rem;
  margin: 0.75rem 0;
  flex-wrap: wrap;
  align-items: flex-end;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.85rem;
  color: var(--muted);
}
select,
input {
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--card-bg);
  color: var(--fg);
}
input {
  flex: 1;
  min-width: 240px;
}
button {
  padding: 0.4rem 0.8rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--card-bg);
  color: var(--fg);
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.chip {
  border-radius: 999px;
  font-size: 0.78rem;
  padding: 0.2rem 0.6rem;
}
.messages {
  list-style: none;
  padding: 0;
  margin: 0.75rem 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  max-height: 420px;
  overflow-y: auto;
}
.msg {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.sender {
  font-weight: 600;
}
.seq {
  color: var(--muted);
  font-size: 0.72rem;
}
.mentions {
  color: var(--accent);
  font-size: 0.78rem;
}
.error {
  color: var(--bad);
}
</style>

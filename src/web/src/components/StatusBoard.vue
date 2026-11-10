<script setup lang="ts">
import { computed } from "vue";
import type { StatusBoardEntry } from "../api/status.ts";

/**
 * T4（#17）状态看板（纯展示组件）。
 *
 * 显示每位成员的有效状态：
 * - 人：只显示 在线 / 离线；**绝不**显示 waiting/working（人不执行 agent 轮次）。
 * - agent：在线 / 离线 / 等待中 / 工作中；断线、心跳超时会显示为「离线（陈旧/断线）」。
 * 组件只渲染传入的 `entries`，不做推导；推导在服务端（`src/server/status.ts`）。
 */
const props = defineProps<{ entries: StatusBoardEntry[] }>();

interface Row {
  entry: StatusBoardEntry;
  stateLabel: string;
  connectionLabel: string;
  dotClass: "online" | "offline" | "waiting" | "working";
  staleLabel: string | null;
}

const rows = computed<Row[]>(() =>
  props.entries.map((entry) => ({ entry, ...render(entry) })),
);

function render(entry: StatusBoardEntry): Omit<Row, "entry"> {
  const isHuman = entry.kind === "human";
  let stateLabel: string;
  let dotClass: Row["dotClass"];

  if (isHuman) {
    // 人：只在线/离线。
    const online = entry.state === "online";
    stateLabel = online ? "在线" : "离线";
    dotClass = online ? "online" : "offline";
  } else {
    switch (entry.state) {
      case "waiting":
        stateLabel = "等待中";
        dotClass = "waiting";
        break;
      case "working":
        stateLabel = "工作中";
        dotClass = "working";
        break;
      case "online":
        stateLabel = "在线";
        dotClass = "online";
        break;
      default:
        stateLabel = "离线";
        dotClass = "offline";
    }
  }

  const connectionLabel = isHuman
    ? "—"
    : entry.connection === "connected"
      ? entry.heartbeatTimedOut
        ? "连接超时"
        : "已连接"
      : entry.connection === "disconnected"
        ? "已断开"
        : "未连接";

  let staleLabel: string | null = null;
  if (entry.disconnected) staleLabel = "断线";
  else if (entry.heartbeatTimedOut) staleLabel = "心跳超时";
  else if (entry.stale) staleLabel = "陈旧";
  else if (entry.heartbeatStale) staleLabel = "心跳变慢";

  return { stateLabel, connectionLabel, dotClass, staleLabel };
}
</script>

<template>
  <div class="status-board" data-testid="status-board">
    <p v-if="entries.length === 0" class="empty-state muted">暂无成员状态。添加成员或等待连接后，状态会显示在这里。</p>
    <ul v-else class="board-list" data-testid="status-board-list">
      <li v-for="row in rows" :key="row.entry.memberId" class="board-item" data-testid="status-board-item">
        <span class="who">
          <span class="dot" :class="row.dotClass" data-testid="board-dot" aria-hidden="true"></span>
          <span class="name">{{ row.entry.displayName }}</span>
          <span class="badge" :class="row.entry.kind === 'human' ? 'human' : 'agent'">
            {{ row.entry.kind === "human" ? "人" : "Agent" }}
          </span>
        </span>
        <span class="state" :class="row.dotClass" data-testid="board-state">{{ row.stateLabel }}</span>
        <span class="meta small muted" data-testid="board-connection">
          {{ row.connectionLabel }}
          <template v-if="row.staleLabel">
            · <span class="stale" data-testid="board-stale">{{ row.staleLabel }}</span>
          </template>
        </span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.board-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.board-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(72px, auto) minmax(110px, auto);
  align-items: center;
  gap: 0.75rem;
  padding: 1rem 0;
  border-bottom: 1px solid var(--border);
}

.board-item:last-child { border-bottom: 0; }

.who {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  flex-wrap: wrap;
}

.name { font-weight: 500; overflow-wrap: anywhere; min-width: 0; }
.state { font-size: 0.85rem; font-weight: 500; }

.dot {
  display: inline-block;
  width: 0.55rem;
  height: 0.55rem;
  border-radius: 50%;
  flex: 0 0 auto;
}

.dot.online {
  background: var(--ok);
}

.dot.offline {
  background: var(--muted);
}

.dot.waiting {
  background: var(--accent);
}

.dot.working {
  background: var(--warn);
}

.state.online {
  color: var(--ok);
}

.state.offline {
  color: var(--muted);
}

.state.waiting {
  color: var(--accent);
}

.state.working {
  color: var(--warn);
}

.badge.human {
  background: var(--accent-soft);
  color: var(--accent);
}

.badge.agent {
  background: var(--surface-subtle);
}

.stale {
  color: var(--bad);
}

.meta {
  overflow-wrap: anywhere;
  text-align: right;
}

@media (max-width: 720px) {
  .board-item { grid-template-columns: minmax(0, 1fr) auto; gap: 0.5rem; }
  .meta { grid-column: 1 / -1; text-align: left; margin-left: 1rem; }
}
</style>

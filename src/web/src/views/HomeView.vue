<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";

interface HealthReport {
  status: "ok" | "degraded";
  uptimeSeconds: number;
  serverTime: string;
  database: { status: string; writable: boolean; error?: string };
  migrations: { version: number; applied: number; pending: number };
  heartbeat: { intervalMs: number; timeoutMs: number };
  webui: { built: boolean };
}

type ConnectionState = "connecting" | "connected" | "disconnected";

const health = ref<HealthReport | null>(null);
const healthError = ref<string | null>(null);
const connection = ref<ConnectionState>("connecting");
const lastEvent = ref<string | null>(null);

let socket: WebSocket | null = null;
let healthTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let disposed = false;

async function refreshHealth(): Promise<void> {
  try {
    const response = await fetch("/api/health");
    health.value = (await response.json()) as HealthReport;
    healthError.value = null;
  } catch (error) {
    healthError.value = (error as Error).message;
  }
}

function connect(): void {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/ws`);
  connection.value = "connecting";

  socket.addEventListener("open", () => {
    connection.value = "connected";
  });
  socket.addEventListener("message", (event) => {
    lastEvent.value = String(event.data);
  });
  socket.addEventListener("close", () => {
    connection.value = "disconnected";
    if (!disposed) {
      reconnectTimer = setTimeout(connect, 2000);
    }
  });
  socket.addEventListener("error", () => {
    connection.value = "disconnected";
  });
}

onMounted(() => {
  void refreshHealth();
  connect();
  healthTimer = setInterval(() => void refreshHealth(), 5000);
});

onUnmounted(() => {
  disposed = true;
  socket?.close();
  if (healthTimer !== null) clearInterval(healthTimer);
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
});
</script>

<template>
  <section class="card">
    <h1>Agent Studio</h1>
    <p class="muted">
      本地运行的跨 Agent 协作平台。当前为工程骨架（F1）：仅提供启动、配置、数据库迁移、
      健康检查与 WebSocket 连接，业务功能在后续阶段实现。
    </p>

    <dl class="status-grid">
      <div>
        <dt>服务状态</dt>
        <dd :class="health?.status === 'ok' ? 'ok' : 'bad'">
          {{ health?.status ?? (healthError ? "不可达" : "加载中") }}
        </dd>
      </div>
      <div>
        <dt>数据库</dt>
        <dd :class="health?.database.writable ? 'ok' : 'bad'">
          {{ health?.database.writable ? "可读写" : "异常" }}
        </dd>
      </div>
      <div>
        <dt>迁移版本</dt>
        <dd>{{ health?.migrations.version ?? "—" }}</dd>
      </div>
      <div>
        <dt>WebSocket</dt>
        <dd :class="connection === 'connected' ? 'ok' : 'bad'">
          {{ connection === "connected" ? "已连接" : connection === "connecting" ? "连接中" : "已断开" }}
        </dd>
      </div>
      <div>
        <dt>心跳</dt>
        <dd>
          {{ health ? `${health.heartbeat.intervalMs / 1000}s / ${health.heartbeat.timeoutMs / 1000}s` : "—" }}
        </dd>
      </div>
      <div>
        <dt>运行时长</dt>
        <dd>{{ health ? `${health.uptimeSeconds}s` : "—" }}</dd>
      </div>
    </dl>

    <p v-if="healthError" class="error">健康检查失败：{{ healthError }}</p>
    <p v-if="lastEvent" class="muted small">最近事件：<code>{{ lastEvent }}</code></p>
  </section>
</template>

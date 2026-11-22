<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useTheme } from "../composables/useTheme.ts";
import {
  hitTestMember, layoutGraph,
  type GraphCanvasData, type GraphLayout, type GraphMemberVM, type GraphTone, type Rect,
} from "./collabGraphLayout.ts";

const props = defineProps<{ data: GraphCanvasData; selectedId?: string | null }>();
const emit = defineEmits<{ select: [id: string] }>();
const theme = useTheme();
const shell = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const focusedId = ref<string | null>(null);
const width = ref(760);
const layout = computed(() => layoutGraph(props.data, width.value));
const members = computed(() => props.data.groups.flatMap(group => group.members));
const avatarCache = new Map<number, HTMLImageElement>();
let observer: ResizeObserver | null = null;
let frame = 0;
let disposed = false;

interface Palette {
  fg: string; muted: string; border: string; cardBg: string; surfaceSubtle: string;
  accent: string; accentFill: string; onAccent: string; accentSoft: string;
  ok: string; warn: string; relation: string; shadow: string;
}
function readPalette(): Palette {
  const style = getComputedStyle(document.documentElement);
  const value = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    fg: value("--fg", "#1d1d1f"), muted: value("--muted", "#626268"), border: value("--border", "#d1d1d6"),
    cardBg: value("--card-bg", "#fff"), surfaceSubtle: value("--surface-subtle", "#eeeef0"),
    accent: value("--accent", "#0066cc"), accentFill: value("--accent-fill", "#0071e3"),
    onAccent: value("--on-accent", "#fff"), accentSoft: value("--accent-soft", "#eaf3ff"),
    ok: value("--ok", "#247a39"), warn: value("--warn", "#8c5b00"), relation: value("--relation", "#7b7b80"),
    shadow: "rgba(0, 0, 0, 0.08)",
  };
}
function avatarImage(seed: number): HTMLImageElement | null {
  if (seed <= 0) return null;
  let image = avatarCache.get(seed);
  if (!image) {
    image = new Image();
    image.onload = () => { if (!disposed) scheduleDraw(); };
    image.src = `/avatars/avatar-${seed}.png`;
    avatarCache.set(seed, image);
  }
  return image.complete && image.naturalWidth > 0 ? image : null;
}
function roundedPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}
function fillCard(ctx: CanvasRenderingContext2D, rect: Rect, p: Palette, radius = 10, selected = false, focused = false): void {
  ctx.save();
  ctx.shadowColor = p.shadow;
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 2;
  roundedPath(ctx, rect.x, rect.y, rect.w, rect.h, radius);
  ctx.fillStyle = selected || focused ? p.accentSoft : p.cardBg;
  ctx.fill();
  ctx.restore();
  roundedPath(ctx, rect.x, rect.y, rect.w, rect.h, radius);
  ctx.strokeStyle = selected ? p.accent : p.border;
  ctx.lineWidth = selected ? 1.5 : 1;
  if (focused) ctx.setLineDash([4, 3]);
  ctx.stroke();
  ctx.setLineDash([]);
}
function drawText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, font: string, color: string, align: CanvasTextAlign = "left"): void {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y);
}
function drawPill(ctx: CanvasRenderingContext2D, text: string, centerX: number, centerY: number, p: Palette, emphasis = false): void {
  ctx.font = "600 11px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif";
  const w = ctx.measureText(text).width + 16;
  const h = 22;
  const x = centerX - w / 2;
  const y = centerY - h / 2;
  roundedPath(ctx, x, y, w, h, 6);
  ctx.fillStyle = emphasis ? p.accentFill : p.cardBg;
  ctx.fill();
  if (!emphasis) { ctx.strokeStyle = p.border; ctx.lineWidth = 1; ctx.stroke(); }
  drawText(ctx, text, centerX, centerY + 0.5, "600 11px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif", emphasis ? p.onAccent : p.muted, "center");
}
function drawAvatar(ctx: CanvasRenderingContext2D, seed: number, initials: string, cx: number, cy: number, p: Palette, radius = 16): void {
  const image = avatarImage(seed);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.clip();
  if (image) ctx.drawImage(image, cx - radius, cy - radius, radius * 2, radius * 2);
  else {
    ctx.fillStyle = p.surfaceSubtle;
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
    drawText(ctx, initials, cx, cy, `600 ${Math.round(radius)}px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif`, p.fg, "center");
  }
  ctx.restore();
  ctx.beginPath();
  ctx.arc(cx + radius - 2, cy + radius - 2, 4, 0, Math.PI * 2);
  ctx.fillStyle = p.ok;
  ctx.fill();
}
function toneColor(tone: GraphTone, p: Palette): string {
  return tone === "active" ? p.accent : tone === "wait" ? p.warn : tone === "ok" ? p.ok : p.muted;
}
function drawStatus(ctx: CanvasRenderingContext2D, member: GraphMemberVM, x: number, y: number, p: Palette): void {
  ctx.font = "600 11px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif";
  const w = ctx.measureText(member.status).width + 14;
  const color = toneColor(member.tone, p);
  ctx.save();
  ctx.globalAlpha = 0.12;
  roundedPath(ctx, x, y - 10, w, 20, 10);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
  drawText(ctx, member.status, x + 7, y, "600 11px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif", color);
}
function drawArrowHead(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, color: string): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-8, -4);
  ctx.lineTo(-8, 4);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}
function drawGroupIcon(ctx: CanvasRenderingContext2D, icon: string, x: number, y: number, p: Palette): void {
  ctx.save();
  ctx.strokeStyle = p.accent;
  ctx.fillStyle = p.accent;
  ctx.lineWidth = 1.6;
  if (icon === "grid") {
    const cells: Array<[number, number]> = [[0, 0], [8, 0], [0, 8], [8, 8]];
    for (const [dx, dy] of cells) ctx.strokeRect(x + dx, y + dy, 6, 6);
  } else if (icon === "layers") {
    for (let i = 0; i < 3; i += 1) {
      ctx.beginPath();
      ctx.moveTo(x + 1, y + 4 + i * 5);
      ctx.lineTo(x + 8, y + 1 + i * 5);
      ctx.lineTo(x + 15, y + 4 + i * 5);
      ctx.lineTo(x + 8, y + 7 + i * 5);
      ctx.closePath();
      ctx.stroke();
    }
  } else if (icon === "check") {
    ctx.beginPath();
    ctx.moveTo(x + 1, y + 7);
    ctx.lineTo(x + 6, y + 13);
    ctx.lineTo(x + 15, y + 2);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.ellipse(x + 8, y + 8, 8, 6, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}
function drawEdges(ctx: CanvasRenderingContext2D, p: Palette, graph: GraphLayout): void {
  const leadCenter = graph.lead.x + graph.lead.w / 2;
  const lastTrunk = graph.rowTrunkYs[graph.rowTrunkYs.length - 1] ?? graph.trunkY;
  ctx.strokeStyle = p.relation;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(graph.root.x + graph.root.w / 2, graph.root.y + graph.root.h);
  ctx.lineTo(graph.root.x + graph.root.w / 2, graph.lead.y);
  ctx.moveTo(leadCenter, graph.lead.y + graph.lead.h);
  ctx.lineTo(leadCenter, lastTrunk);
  for (let row = 0; row < graph.rowTrunkYs.length; row += 1) {
    const trunkY = graph.rowTrunkYs[row];
    if (trunkY === undefined) continue;
    const rowGroups = graph.groups.filter(group => group.row === row);
    if (!rowGroups.length) continue;
    const centers = rowGroups.map(group => group.x + group.w / 2);
    const left = centers[0]!;
    const right = centers[centers.length - 1]!;
    ctx.moveTo(left, trunkY);
    ctx.lineTo(right, trunkY);
  }
  ctx.stroke();
  for (const group of graph.groups) {
    const center = group.x + group.w / 2;
    const trunkY = graph.rowTrunkYs[group.row] ?? graph.trunkY;
    ctx.beginPath();
    ctx.moveTo(center, trunkY);
    ctx.lineTo(center, group.y);
    ctx.stroke();
    drawArrowHead(ctx, center, group.y - 1, Math.PI / 2, p.relation);
  }

  for (const group of graph.groups) {
    if (group.members.length > 1) {
      const first = group.members[0]!;
      const second = group.members[1]!;
      const x = first.x + first.w / 2;
      const connectorColor = group.group.flowEmphasis ? p.accentFill : p.relation;
      ctx.strokeStyle = connectorColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, first.y + first.h);
      ctx.lineTo(x, second.y);
      ctx.stroke();
      drawArrowHead(ctx, x, second.y - 1, Math.PI / 2, connectorColor);
    } else if (group.members.length === 1) {
      const member = group.members[0]!;
      const x = group.x + group.w / 2;
      ctx.strokeStyle = p.relation;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(x, group.y + 45);
      ctx.lineTo(x, member.y);
      ctx.stroke();
      drawArrowHead(ctx, x, member.y - 1, Math.PI / 2, p.relation);
    }
  }

  const first = graph.groups[0];
  const second = graph.groups[1];
  const third = graph.groups[2];
  if (first && second && first.members[1] && second.members[0]) {
    const from = first.members[1]!;
    const to = second.members[0]!;
    const startX = first.x + first.w;
    const startY = from.y + from.h / 2;
    const endX = second.x;
    const endY = to.y + to.h / 2;
    ctx.strokeStyle = p.relation;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.bezierCurveTo(startX + 30, startY - 20, endX - 30, endY + 40, endX, endY);
    ctx.stroke();
    drawArrowHead(ctx, endX + 1, endY, 0, p.relation);
  }
  if (first && third && first.members[1] && third.members[0]) {
    const from = first.members[1]!;
    const to = third.members[0]!;
    const startX = first.x + first.w / 2;
    const startY = from.y + from.h;
    const endX = third.x;
    const endY = to.y + to.h;
    ctx.strokeStyle = p.relation;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.bezierCurveTo(startX + 120, graph.height - 20, endX - 120, graph.height - 20, endX, endY);
    ctx.stroke();
    drawArrowHead(ctx, endX + 1, endY, 0, p.relation);
  }
}
function drawNodes(ctx: CanvasRenderingContext2D, p: Palette, graph: GraphLayout): void {
  fillCard(ctx, graph.root, p, 10);
  const rootIconX = graph.root.x + 26;
  const rootIconY = graph.root.y + graph.root.h / 2;
  ctx.strokeStyle = p.fg;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.ellipse(rootIconX, rootIconY - 2, 12, 9, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(rootIconX - 6, rootIconY + 6);
  ctx.lineTo(rootIconX - 10, rootIconY + 12);
  ctx.lineTo(rootIconX - 1, rootIconY + 7);
  ctx.stroke();
  drawText(ctx, props.data.root.name, graph.root.x + 52, rootIconY, "600 16px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif", p.fg);

  fillCard(ctx, graph.lead, p, 10);
  drawAvatar(ctx, props.data.lead.avatar, props.data.lead.initials, graph.lead.x + 28, graph.lead.y + graph.lead.h / 2, p, 18);
  drawText(ctx, props.data.lead.name, graph.lead.x + 58, graph.lead.y + 24, "600 15px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif", p.fg);
  drawText(ctx, props.data.lead.role ?? "协调中", graph.lead.x + 58, graph.lead.y + 43, "12px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif", p.muted);

  for (const group of graph.groups) {
    fillCard(ctx, group, p, 12);
    drawGroupIcon(ctx, group.group.icon, group.x + 14, group.y + 14, p);
    drawText(ctx, group.group.name, group.x + 40, group.y + 25, "600 15px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif", p.fg);
    ctx.strokeStyle = p.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(group.x + 12, group.y + 45);
    ctx.lineTo(group.x + group.w - 12, group.y + 45);
    ctx.stroke();
    for (const row of group.members) {
      const selected = props.selectedId === row.member.id;
      const focused = focusedId.value === row.member.id;
      fillCard(ctx, row, p, 10, selected, focused);
      drawAvatar(ctx, row.member.avatar, row.member.initials, row.x + 24, row.y + 29, p, 16);
      drawText(ctx, row.member.name, row.x + 50, row.y + 21, "600 14px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif", p.fg);
      drawStatus(ctx, row.member, row.x + 50, row.y + 42, p);
    }
    if (group.members.length > 1) {
      const first = group.members[0]!;
      const second = group.members[1]!;
      const centerY = (first.y + first.h + second.y) / 2;
      drawPill(ctx, group.group.flowLabel, group.x + 52, centerY, p);
      if (group.group.flowMessage) {
        drawPill(ctx, group.group.flowMessage, group.x + group.w / 2 + 20, centerY, p, group.group.flowEmphasis === true);
      }
    } else {
      drawPill(ctx, group.group.flowLabel, group.x + group.w / 2, group.y + group.h - 24, p);
    }
  }

  const first = graph.groups[0];
  const second = graph.groups[1];
  const third = graph.groups[2];
  if (first && second) {
    const centerX = (first.x + first.w + second.x) / 2;
    const centerY = (first.y + first.h / 2 + second.y + second.h / 2) / 2;
    drawPill(ctx, "接口协作", centerX, centerY, p);
  }
  if (first && third) {
    const centerX = (first.x + first.w / 2 + third.x + third.w / 2) / 2;
    drawPill(ctx, "验证协作", centerX, graph.height - 28, p);
  }
}
function draw(): void {
  frame = 0;
  const shellElement = shell.value;
  const element = canvas.value;
  if (!shellElement || !element || disposed) return;
  const cssWidth = Math.max(280, Math.round(shellElement.clientWidth));
  if (width.value !== cssWidth) width.value = cssWidth;
  const graph = layout.value;
  const cssHeight = graph.height;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const pixelWidth = Math.round(cssWidth * dpr);
  const pixelHeight = Math.round(cssHeight * dpr);
  element.style.height = `${cssHeight}px`;
  if (element.width !== pixelWidth || element.height !== pixelHeight) {
    element.width = pixelWidth;
    element.height = pixelHeight;
  }
  const ctx = element.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, pixelWidth, pixelHeight);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const palette = readPalette();
  drawEdges(ctx, palette, graph);
  drawNodes(ctx, palette, graph);
}
function scheduleDraw(): void {
  if (frame || disposed) return;
  frame = requestAnimationFrame(() => draw());
}
function pointerId(event: MouseEvent): string | null {
  const element = canvas.value;
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return hitTestMember(layout.value, event.clientX - rect.left, event.clientY - rect.top);
}
function onClick(event: MouseEvent): void {
  const id = pointerId(event);
  if (id) emit("select", id);
}
function onMove(event: MouseEvent): void {
  if (canvas.value) canvas.value.style.cursor = pointerId(event) ? "pointer" : "default";
}
function measure(): void {
  const element = shell.value;
  if (!element) return;
  const next = Math.max(280, Math.round(element.clientWidth));
  if (width.value !== next) width.value = next;
  scheduleDraw();
}
onMounted(() => {
  for (let seed = 1; seed <= 6; seed += 1) avatarImage(seed);
  const element = shell.value;
  if (element && typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(measure);
    observer.observe(element);
  }
  measure();
});
onBeforeUnmount(() => {
  disposed = true;
  observer?.disconnect();
  if (frame) cancelAnimationFrame(frame);
});
watch(() => [props.data, props.selectedId, focusedId.value, theme.snapshot.value.appearance, width.value] as const, scheduleDraw, { deep: true });
</script>

<template>
  <div ref="shell" class="graph-canvas-shell">
    <canvas
      ref="canvas"
      class="graph-canvas-element"
      :style="{ height: `${layout.height}px` }"
      data-testid="p01-graph-canvas-element"
      role="img"
      aria-label="示例协作关系图：总管连接项目负责人，项目负责人连接界面升级小组、MCP 能力接入、质量保障三个群；点击成员查看会话。全部为示例数据。"
      @click="onClick"
      @mousemove="onMove"
    />
    <div class="visually-hidden graph-accessible-controls">
      <button
        v-for="member in members"
        :key="member.id"
        type="button"
        :aria-pressed="selectedId === member.id"
        :aria-label="`查看${member.name}的成员会话`"
        @click="emit('select', member.id)"
        @focus="focusedId = member.id"
        @blur="focusedId = null"
      >查看{{ member.name }}的成员会话</button>
    </div>
  </div>
</template>

<style scoped>
.graph-canvas-shell { position: relative; width: 100%; height: auto; min-height: 0; }
.graph-canvas-element { display: block; width: 100%; }
</style>

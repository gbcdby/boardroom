<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useTheme } from "../composables/useTheme.ts";
import {
  canvasViewport, hitTestMember, layoutGraph,
  type GraphCanvasData, type GraphLayout, type GraphMemberVM, type GraphTone, type GraphViewport, type Rect,
} from "./collabGraphLayout.ts";

const props = defineProps<{ data: GraphCanvasData; selectedId?: string | null }>();
const emit = defineEmits<{ select: [id: string] }>();
const theme = useTheme();
const canvas = ref<HTMLCanvasElement | null>(null);
const focusedId = ref<string | null>(null);
const layout = computed(() => layoutGraph(props.data));
const viewport = ref<GraphViewport>({ scale: 1, offsetX: 0, offsetY: 0 });
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
  const rootCenter = graph.root.x + graph.root.w / 2;
  const leadCenter = graph.lead.x + graph.lead.w / 2;
  ctx.strokeStyle = p.relation;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(rootCenter, graph.root.y + graph.root.h);
  ctx.lineTo(rootCenter, graph.lead.y);
  ctx.moveTo(leadCenter, graph.lead.y + graph.lead.h);
  ctx.lineTo(leadCenter, 178);
  const centers = graph.groups.map(group => group.x + group.w / 2);
  ctx.moveTo(centers[0]!, 178);
  ctx.lineTo(centers[centers.length - 1]!, 178);
  for (const center of centers) {
    ctx.moveTo(center, 178);
    ctx.lineTo(center, graph.groups[0]!.y);
  }
  ctx.stroke();
  for (const center of centers) drawArrowHead(ctx, center, graph.groups[0]!.y - 1, Math.PI / 2, p.relation);

  for (const group of graph.groups) {
    if (group.members.length > 1) {
      const first = group.members[0]!;
      const second = group.members[1]!;
      const x = first.x + first.w / 2;
      const connectorColor = group.group.flowMessage ? p.accentFill : p.relation;
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
    ctx.strokeStyle = p.relation;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(first.x + first.w, from.y + from.h / 2);
    ctx.bezierCurveTo(first.x + first.w + 25, from.y + 10, second.x - 25, to.y + 40, second.x, to.y + to.h / 2);
    ctx.stroke();
    drawArrowHead(ctx, second.x + 1, to.y + to.h / 2, 0, p.relation);
  }
  if (first && third && first.members[1] && third.members[0]) {
    const from = first.members[1]!;
    const to = third.members[0]!;
    ctx.strokeStyle = p.relation;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(first.x + first.w / 2, from.y + from.h);
    ctx.bezierCurveTo(first.x + 180, graph.height - 10, third.x - 80, graph.height - 10, third.x, to.y + to.h);
    ctx.stroke();
    drawArrowHead(ctx, third.x + 1, to.y + to.h, 0, p.relation);
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
      if (group.group.flowMessage) drawPill(ctx, group.group.flowMessage, group.x + group.w / 2 + 20, centerY, p, group.group.flowEmphasis === true);
    } else if (group.members.length === 1) {
      drawPill(ctx, group.group.flowLabel, group.x + group.w / 2, graph.height - 28, p);
    }
  }
  drawPill(ctx, "接口协作", 255, 338, p);
  drawPill(ctx, "验证协作", 380, 438, p);
}
function draw(): void {
  frame = 0;
  const element = canvas.value;
  if (!element || disposed) return;
  const rect = element.getBoundingClientRect();
  const cssWidth = rect.width;
  const cssHeight = rect.height;
  if (cssWidth <= 0 || cssHeight <= 0) return;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const pixelWidth = Math.round(cssWidth * dpr);
  const pixelHeight = Math.round(cssHeight * dpr);
  if (element.width !== pixelWidth || element.height !== pixelHeight) {
    element.width = pixelWidth;
    element.height = pixelHeight;
  }
  const graph = layout.value;
  const vp = canvasViewport(cssWidth, cssHeight, graph);
  viewport.value = vp;
  const ctx = element.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, pixelWidth, pixelHeight);
  ctx.setTransform(dpr * vp.scale, 0, 0, dpr * vp.scale, dpr * vp.offsetX, dpr * vp.offsetY);
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
  return hitTestMember(layout.value, viewport.value, event.clientX - rect.left, event.clientY - rect.top);
}
function onClick(event: MouseEvent): void {
  const id = pointerId(event);
  if (id) emit("select", id);
}
function onMove(event: MouseEvent): void {
  if (canvas.value) canvas.value.style.cursor = pointerId(event) ? "pointer" : "default";
}
onMounted(() => {
  for (let seed = 1; seed <= 6; seed += 1) avatarImage(seed);
  const element = canvas.value;
  if (element && typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(scheduleDraw);
    observer.observe(element);
  }
  scheduleDraw();
});
onBeforeUnmount(() => {
  disposed = true;
  observer?.disconnect();
  if (frame) cancelAnimationFrame(frame);
});
watch(() => [props.data, props.selectedId, focusedId.value, theme.snapshot.value.appearance] as const, scheduleDraw, { deep: true });
</script>

<template>
  <div class="graph-canvas-shell">
    <canvas
      ref="canvas"
      class="graph-canvas-element"
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
.graph-canvas-shell { position: relative; width: 100%; height: 100%; min-height: 0; }
.graph-canvas-element { display: block; width: 100%; height: 100%; }
</style>

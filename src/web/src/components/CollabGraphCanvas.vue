<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useTheme } from "../composables/useTheme.ts";
import {
  hitTestMember, hitTestGroup, layoutGraph,
  type GraphCanvasData, type GraphLayout, type GraphMemberVM, type GraphTone, type Rect,
} from "./collabGraphLayout.ts";
import {
  MESSAGE_ANIMATION_MS, buildMessageDirectionLayer, messageAggregateLabel, messageMarkerLabel,
  resolveMessagePresentation, type MessageDirectionLayer,
} from "../composables/messageDirectionLayer.ts";

const props = defineProps<{
  data: GraphCanvasData;
  selectedId?: string | null;
  messageDirection?: MessageDirectionLayer;
  relationLayer?: boolean;
  messageLayer?: boolean;
  paused?: boolean;
  scopeKey?: string | null;
}>();
const emit = defineEmits<{ select: [id: string]; selectGroup: [groupId: string] }>();
const theme = useTheme();
const shell = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const focusedId = ref<string | null>(null);
const focusedMessageId = ref<string | null>(null);
const focusedAggregateKey = ref<string | null>(null);
const width = ref(760);
const layout = computed(() => layoutGraph(props.data, width.value));
const direction = computed(() => props.messageDirection ?? buildMessageDirectionLayer([]));
const relationLayer = computed(() => props.relationLayer ?? true);
const messageLayer = computed(() => props.messageLayer ?? true);
const markers = computed(() => messageLayer.value ? direction.value.markers : []);
const aggregates = computed(() => messageLayer.value ? direction.value.aggregates : []);
const accessibleMembers = computed(() => props.data.groups.flatMap(group => group.members.map(member => ({ member, groupName: group.name }))));
const reducedMotion = ref(typeof window !== "undefined" && typeof window.matchMedia === "function"
  && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
const presentation = computed(() => resolveMessagePresentation(reducedMotion.value, props.paused === true));
const animationStart = ref<Record<string, number>>({});
const seenMessageIds = new Set<string>();
const initializedScopes = new Set<string>();
let lastScopeKey: string | null | undefined;
let motionQuery: MediaQueryList | null = null;
const ariaLabel = computed(() => {
  const groups = props.data.groups.map(group => group.name).join("、");
  const lead = props.data.root?.name ? `项目负责人${props.data.root.name}` : "未配置项目负责人";
  const layer = messageLayer.value
    ? `真实消息 ${direction.value.totalCount} 条，可见标记 ${markers.value.length} 条${direction.value.overflowCount ? `，聚合 ${direction.value.overflowCount} 条` : ""}`
    : `消息层已关闭，真实消息 ${direction.value.totalCount} 条仍照常更新`;
  return `协作关系图：${lead}；${groups ? `群组：${groups}` : "当前没有可读取的群组"}。${layer}${presentation.value.animate ? "" : "；动态已暂停，静态箭头与计数仍可读"}。节点来自真实只读数据；点击成员或群入口查看该群已保存的 Boardroom 消息。`;
});
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
  if (!relationLayer.value) return;
  const lastTrunk = graph.rowTrunkYs[graph.rowTrunkYs.length - 1] ?? graph.trunkY;
  ctx.strokeStyle = p.relation;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  if (graph.root && graph.lead) {
    ctx.moveTo(graph.root.x + graph.root.w / 2, graph.root.y + graph.root.h);
    ctx.lineTo(graph.root.x + graph.root.w / 2, graph.lead.y);
  }
  if (graph.lead) {
    ctx.moveTo(graph.lead.x + graph.lead.w / 2, graph.lead.y + graph.lead.h);
    ctx.lineTo(graph.lead.x + graph.lead.w / 2, lastTrunk);
  } else if (graph.root) {
    ctx.moveTo(graph.root.x + graph.root.w / 2, graph.root.y + graph.root.h);
    ctx.lineTo(graph.root.x + graph.root.w / 2, lastTrunk);
  }
  for (let row = 0; row < graph.rowTrunkYs.length; row += 1) {
    const trunkY = graph.rowTrunkYs[row];
    if (trunkY === undefined || trunkY < 0) continue;
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

  const members = graph.groups.flatMap(group => group.members);
  for (const link of props.data.collaborations ?? []) {
    const from = members.find(item => item.member.id === link.fromId);
    const to = members.find(item => item.member.id === link.toId);
    if (!from || !to) continue;
    const startX = from.x + from.w / 2;
    const startY = from.y + from.h / 2;
    const endX = to.x + to.w / 2;
    const endY = to.y + to.h / 2;
    ctx.strokeStyle = p.relation;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.bezierCurveTo(startX + 30, startY - 20, endX - 30, endY + 40, endX, endY);
    ctx.stroke();
    drawArrowHead(ctx, endX + 1, endY, 0, p.relation);
  }
}
function drawNodes(ctx: CanvasRenderingContext2D, p: Palette, graph: GraphLayout): void {
  if (graph.root) {
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
    drawText(ctx, props.data.root!.name, graph.root.x + 52, rootIconY - 7, "600 16px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif", p.fg);
    if (props.data.root!.role) {
      drawText(ctx, props.data.root!.role, graph.root.x + 52, rootIconY + 12, "11px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif", p.muted);
    }
  }

  if (graph.lead && props.data.lead) {
    fillCard(ctx, graph.lead, p, 10);
    drawAvatar(ctx, props.data.lead.avatar, props.data.lead.initials, graph.lead.x + 28, graph.lead.y + graph.lead.h / 2, p, 18);
    drawText(ctx, props.data.lead.name, graph.lead.x + 58, graph.lead.y + 24, "600 15px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif", p.fg);
    drawText(ctx, props.data.lead.role ?? "协调中", graph.lead.x + 58, graph.lead.y + 43, "12px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif", p.muted);
  }

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
        drawPill(ctx, group.group.flowMessage, group.x + group.w / 2, centerY, p, group.group.flowEmphasis === true);
      }
    } else {
      drawPill(ctx, group.group.flowLabel, group.x + group.w / 2, group.y + group.h - 24, p);
    }
  }

  const members = graph.groups.flatMap(group => group.members);
  for (const link of props.data.collaborations ?? []) {
    const from = members.find(item => item.member.id === link.fromId);
    const to = members.find(item => item.member.id === link.toId);
    if (!from || !to) continue;
    const centerX = (from.x + from.w + to.x) / 2;
    const centerY = (from.y + from.h / 2 + to.y + to.h / 2) / 2;
    drawPill(ctx, link.label, centerX, centerY, p);
  }
}
interface MessageGeometry { fromX: number; fromY: number; controlX: number; controlY: number; toX: number; toY: number }

/** 消息箭头只落在真实发送者成员与所属群之间；发送者已移除时从群左侧入边，不补造节点。 */
function messageGeometry(graph: GraphLayout, groupId: string, senderMemberId: string, lane: number): MessageGeometry | null {
  const groupLayout = graph.groups.find(group => group.group.id === groupId);
  if (!groupLayout) return null;
  const offset = (lane % 3) - 1;
  const toX = groupLayout.x + 28;
  const toY = groupLayout.y + 27 + offset * 4;
  const sender = groupLayout.members.find(member => member.member.memberId === senderMemberId);
  const fromX = sender ? sender.x - 2 : groupLayout.x - 10;
  const fromY = sender ? sender.y + sender.h / 2 + offset * 6 : groupLayout.y + 62 + offset * 6;
  return { fromX, fromY, controlX: (fromX + toX) / 2, controlY: Math.min(fromY, toY) - 18, toX, toY };
}
function curvePoint(geometry: MessageGeometry, t: number): { x: number; y: number } {
  const remaining = 1 - t;
  return {
    x: remaining * remaining * geometry.fromX + 2 * remaining * t * geometry.controlX + t * t * geometry.toX,
    y: remaining * remaining * geometry.fromY + 2 * remaining * t * geometry.controlY + t * t * geometry.toY,
  };
}
function drawDirectionArrow(ctx: CanvasRenderingContext2D, geometry: MessageGeometry, p: Palette, focus: boolean): void {
  ctx.save();
  ctx.strokeStyle = p.accent;
  ctx.lineWidth = focus ? 2.6 : 1.8;
  ctx.globalAlpha = focus ? 1 : 0.82;
  ctx.beginPath();
  ctx.moveTo(geometry.fromX, geometry.fromY);
  ctx.quadraticCurveTo(geometry.controlX, geometry.controlY, geometry.toX, geometry.toY);
  ctx.stroke();
  const angle = Math.atan2(geometry.toY - geometry.controlY, geometry.toX - geometry.controlX);
  drawArrowHead(ctx, geometry.toX, geometry.toY, angle, p.accent);
  if (focus) {
    ctx.beginPath();
    ctx.arc(geometry.toX, geometry.toY, 8, 0, Math.PI * 2);
    ctx.setLineDash([3, 2]);
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.restore();
}
function drawFlowDot(ctx: CanvasRenderingContext2D, geometry: MessageGeometry, t: number, p: Palette): void {
  const point = curvePoint(geometry, t);
  ctx.save();
  ctx.globalAlpha = t > 0.75 ? Math.max(0, (1 - t) / 0.25) : 1;
  ctx.beginPath();
  ctx.arc(point.x, point.y, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = p.accentFill;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = p.onAccent;
  ctx.stroke();
  ctx.restore();
}
function drawMessageDirection(ctx: CanvasRenderingContext2D, p: Palette, graph: GraphLayout, now: number): void {
  if (!messageLayer.value) return;
  for (const [index, marker] of markers.value.entries()) {
    const geometry = messageGeometry(graph, marker.groupId, marker.senderMemberId, index);
    if (!geometry) continue;
    drawDirectionArrow(ctx, geometry, p, focusedMessageId.value === marker.id);
    const started = presentation.value.animate ? animationStart.value[marker.id] : undefined;
    if (started === undefined) continue;
    const progress = (now - started) / MESSAGE_ANIMATION_MS;
    if (progress >= 0 && progress < 1) drawFlowDot(ctx, geometry, progress, p);
  }
  for (const [index, aggregate] of aggregates.value.entries()) {
    const geometry = messageGeometry(graph, aggregate.groupId, aggregate.senderMemberId, index);
    if (!geometry) continue;
    drawDirectionArrow(ctx, geometry, p, focusedAggregateKey.value === aggregate.key);
    drawPill(ctx, `+${aggregate.count}`, geometry.toX + 34, geometry.toY + 12, p, true);
  }
}
function hasActiveAnimation(now: number): boolean {
  return presentation.value.animate && messageLayer.value
    && Object.values(animationStart.value).some(start => now - start >= 0 && now - start < MESSAGE_ANIMATION_MS);
}
/** 首帧与历史重载只登记已见 ID，不把旧消息当作新事件重放；仅新逻辑 ID 触发一次流动标记。 */
function syncMessageSeen(): void {
  const scopeId = props.scopeKey ?? "__default__";
  const scopeChanged = scopeId !== lastScopeKey;
  if (scopeChanged) {
    seenMessageIds.clear();
    animationStart.value = {};
    lastScopeKey = scopeId;
  }
  // 首次加载与项目切回都属于历史快照，不把既有消息当作新事件重放。
  const initial = scopeChanged || !initializedScopes.has(scopeId);
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  const next: Record<string, number> = {};
  const canAnimate = presentation.value.animate && messageLayer.value;
  for (const marker of direction.value.traceable) {
    if (!seenMessageIds.has(marker.id)) {
      seenMessageIds.add(marker.id);
      if (!initial && canAnimate) next[marker.id] = now;
    } else if (canAnimate && animationStart.value[marker.id] !== undefined) {
      next[marker.id] = animationStart.value[marker.id]!;
    }
  }
  initializedScopes.add(scopeId);
  animationStart.value = next;
}
function onMotionChange(event: Event): void {
  reducedMotion.value = (event as MediaQueryListEvent).matches;
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
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  drawMessageDirection(ctx, palette, graph, now);
  if (hasActiveAnimation(now)) scheduleDraw();
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
  const element = canvas.value;
  if (!element) return;
  const rect = element.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const memberId = hitTestMember(layout.value, x, y);
  if (memberId) { emit("select", memberId); return; }
  const groupId = hitTestGroup(layout.value, x, y);
  if (groupId) emit("selectGroup", groupId);
}
function onMove(event: MouseEvent): void {
  const element = canvas.value;
  if (!element) return;
  const rect = element.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const hit = hitTestMember(layout.value, x, y) ?? hitTestGroup(layout.value, x, y);
  element.style.cursor = hit ? "pointer" : "default";
}
function measure(): void {
  const element = shell.value;
  if (!element) return;
  const next = Math.max(280, Math.round(element.clientWidth));
  if (width.value !== next) width.value = next;
  scheduleDraw();
}
onMounted(() => {
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotion.value = motionQuery.matches;
    motionQuery.addEventListener?.("change", onMotionChange);
  }
  for (let seed = 1; seed <= 6; seed += 1) avatarImage(seed);
  const element = shell.value;
  if (element && typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(measure);
    observer.observe(element);
  }
  syncMessageSeen();
  measure();
});
onBeforeUnmount(() => {
  disposed = true;
  observer?.disconnect();
  motionQuery?.removeEventListener?.("change", onMotionChange);
  if (frame) cancelAnimationFrame(frame);
});
watch(() => [
  props.data, props.selectedId, props.messageDirection, props.messageLayer, props.relationLayer,
  props.paused, focusedId.value, focusedMessageId.value, focusedAggregateKey.value,
  theme.snapshot.value.appearance, width.value, reducedMotion.value,
] as const, () => {
  syncMessageSeen();
  scheduleDraw();
}, { deep: true });
</script>

<template>
  <div ref="shell" class="graph-canvas-shell">
    <canvas
      ref="canvas"
      class="graph-canvas-element"
      :style="{ height: `${layout.height}px` }"
      data-testid="p01-graph-canvas-element"
      role="img"
      :aria-label="ariaLabel"
      @click="onClick"
      @mousemove="onMove"
    />
    <div class="visually-hidden graph-accessible-controls">
      <div role="group" aria-label="群入口">
        <button
          v-for="group in data.groups"
          :key="`group-${group.id ?? group.name}`"
          type="button"
          :data-group-id="group.id ?? ''"
          data-testid="p01-group-accessible"
          :aria-label="`查看${group.name}的真实 Boardroom 消息`"
          @click="group.id && emit('selectGroup', group.id)"
        >查看{{ group.name }}的真实 Boardroom 消息</button>
      </div>
      <button
        v-for="item in accessibleMembers"
        :key="item.member.id"
        type="button"
        :aria-pressed="selectedId === item.member.id"
        :aria-label="`查看${item.member.name}（${item.groupName}）的成员会话`"
        @click="emit('select', item.member.id)"
        @focus="focusedId = item.member.id"
        @blur="focusedId = null"
      >查看{{ item.member.name }}（{{ item.groupName }}）的成员会话</button>
      <div role="group" aria-label="真实消息方向标记">
        <button
          v-for="item in direction.traceable"
          :key="`message-${item.id}`"
          type="button"
          :data-message-id="item.id"
          data-testid="p01-message-accessible"
          :aria-label="messageMarkerLabel(item)"
          @focus="focusedMessageId = item.id"
          @blur="focusedMessageId = null"
        >{{ messageMarkerLabel(item) }}</button>
      </div>
      <div role="group" aria-label="同方向聚合消息计数">
        <button
          v-for="item in direction.aggregates"
          :key="`aggregate-${item.key}`"
          type="button"
          :data-aggregate-key="item.key"
          data-testid="p01-message-aggregate-accessible"
          :aria-label="messageAggregateLabel(item)"
          @focus="focusedAggregateKey = item.key"
          @blur="focusedAggregateKey = null"
        >{{ messageAggregateLabel(item) }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.graph-canvas-shell { position: relative; width: 100%; height: auto; min-height: 0; }
.graph-canvas-element { display: block; width: 100%; }
</style>

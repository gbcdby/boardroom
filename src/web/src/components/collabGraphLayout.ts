export type GraphTone = "ok" | "active" | "wait" | "idle";

export interface GraphMemberVM {
  id: string;
  name: string;
  initials: string;
  status: string;
  tone: GraphTone;
  avatar: number;
  role?: string | undefined;
}

export interface GraphGroupVM {
  name: string;
  icon: string;
  flowLabel: string;
  flowMessage?: string | undefined;
  flowEmphasis?: boolean | undefined;
  members: GraphMemberVM[];
}

export interface GraphCanvasData {
  root: { name: string; role: string; avatar: number; initials: string };
  lead: GraphMemberVM;
  groups: GraphGroupVM[];
}

export interface Rect { x: number; y: number; w: number; h: number }
export interface LayoutMember extends Rect { member: GraphMemberVM }
export interface LayoutGroup extends Rect { group: GraphGroupVM; members: LayoutMember[] }
export interface GraphLayout {
  width: number;
  height: number;
  root: Rect;
  lead: Rect;
  groups: LayoutGroup[];
}
export interface GraphViewport { scale: number; offsetX: number; offsetY: number }

export const GRAPH_WIDTH = 760;
export const GRAPH_HEIGHT = 470;

export function layoutGraph(data: GraphCanvasData): GraphLayout {
  const root: Rect = { x: 280, y: 8, w: 200, h: 48 };
  const lead: Rect = { x: 260, y: 82, w: 240, h: 62 };
  const groupY = 205;
  const groupH = 245;
  const groupW = 230;
  const groupXs = [15, 265, 515];
  const groups: LayoutGroup[] = data.groups.map((group, index) => {
    const x = groupXs[index] ?? 15 + index * 250;
    const memberRows: LayoutMember[] = group.members.map((member, memberIndex) => ({
      member,
      x: x + 12,
      y: group.members.length > 1 ? groupY + 60 + memberIndex * 90 : groupY + 110,
      w: groupW - 24,
      h: 58,
    }));
    return { group, x, y: groupY, w: groupW, h: groupH, members: memberRows };
  });
  return { width: GRAPH_WIDTH, height: GRAPH_HEIGHT, root, lead, groups };
}

export function canvasViewport(cssWidth: number, cssHeight: number, layout: GraphLayout): GraphViewport {
  const scale = Math.min(1, cssWidth / layout.width, cssHeight / layout.height);
  return {
    scale,
    offsetX: (cssWidth - layout.width * scale) / 2,
    offsetY: (cssHeight - layout.height * scale) / 2,
  };
}

export function hitTestMember(layout: GraphLayout, viewport: GraphViewport, x: number, y: number): string | null {
  if (viewport.scale <= 0) return null;
  const virtualX = (x - viewport.offsetX) / viewport.scale;
  const virtualY = (y - viewport.offsetY) / viewport.scale;
  for (const group of layout.groups) {
    for (const member of group.members) {
      if (virtualX >= member.x && virtualX <= member.x + member.w
        && virtualY >= member.y && virtualY <= member.y + member.h) return member.member.id;
    }
  }
  return null;
}

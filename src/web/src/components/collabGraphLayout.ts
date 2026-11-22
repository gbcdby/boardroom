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
export interface LayoutGroup extends Rect {
  group: GraphGroupVM;
  row: number;
  column: number;
  members: LayoutMember[];
}
export interface GraphLayout {
  width: number;
  height: number;
  columns: number;
  root: Rect;
  lead: Rect;
  trunkY: number;
  rowTrunkYs: number[];
  groups: LayoutGroup[];
}

const PADDING = 16;
const GAP = 16;
const MIN_GROUP_WIDTH = 180;
const GROUP_HEIGHT = 230;
const ROW_GAP = 24;
const GROUP_TOP = 205;

export function layoutGraph(data: GraphCanvasData, requestedWidth: number): GraphLayout {
  const width = Math.max(280, Math.round(requestedWidth));
  const available = width - PADDING * 2;
  let columns = 1;
  if (available >= MIN_GROUP_WIDTH * 3 + GAP * 2) columns = 3;
  else if (available >= MIN_GROUP_WIDTH * 2 + GAP) columns = 2;
  const groupWidth = (available - GAP * (columns - 1)) / columns;
  const rootWidth = Math.min(200, available);
  const leadWidth = Math.min(240, available);
  const root: Rect = { x: (width - rootWidth) / 2, y: 8, w: rootWidth, h: 48 };
  const lead: Rect = { x: (width - leadWidth) / 2, y: 82, w: leadWidth, h: 62 };
  const rows = Math.ceil(data.groups.length / columns);
  const rowTrunkYs = Array.from({ length: rows }, (_, row) => GROUP_TOP + row * (GROUP_HEIGHT + ROW_GAP) - 20);
  const height = GROUP_TOP + rows * GROUP_HEIGHT + Math.max(0, rows - 1) * ROW_GAP + 56;

  const groups: LayoutGroup[] = data.groups.map((group, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const x = PADDING + column * (groupWidth + GAP);
    const y = GROUP_TOP + row * (GROUP_HEIGHT + ROW_GAP);
    const members: LayoutMember[] = group.members.map((member, memberIndex) => ({
      member,
      x: x + 12,
      y: group.members.length > 1
        ? y + 57 + memberIndex * 90
        : y + 45 + (GROUP_HEIGHT - 45 - 58) / 2,
      w: groupWidth - 24,
      h: 58,
    }));
    return { group, row, column, x, y, w: groupWidth, h: GROUP_HEIGHT, members };
  });

  return { width, height, columns, root, lead, trunkY: 178, rowTrunkYs, groups };
}

export function hitTestMember(layout: GraphLayout, x: number, y: number): string | null {
  for (const group of layout.groups) {
    for (const member of group.members) {
      if (x >= member.x && x <= member.x + member.w && y >= member.y && y <= member.y + member.h) {
        return member.member.id;
      }
    }
  }
  return null;
}

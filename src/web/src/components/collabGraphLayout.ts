export type GraphTone = "ok" | "active" | "wait" | "idle";

export interface GraphMemberVM {
  id: string;
  name: string;
  initials: string;
  status: string;
  tone: GraphTone;
  avatar: number;
  role?: string | undefined;
  /** 真实成员 ID；画布 id 为「群 ID:成员 ID」，跨群同名不合并。 */
  memberId?: string | undefined;
  groupId?: string | undefined;
}

export interface GraphGroupVM {
  id?: string | undefined;
  name: string;
  icon: string;
  flowLabel: string;
  flowMessage?: string | undefined;
  flowEmphasis?: boolean | undefined;
  members: GraphMemberVM[];
}

/** 只有具备真实来源的关系才能进入画布；阶段 1 的真实快照不提供跨群协作边。 */
export interface GraphCollaboration {
  id: string;
  fromId: string;
  toId: string;
  label: string;
}

export interface GraphCanvasData {
  root: { name: string; role: string; avatar: number; initials: string } | null;
  lead: GraphMemberVM | null;
  groups: GraphGroupVM[];
  collaborations?: GraphCollaboration[];
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
  root: Rect | null;
  lead: Rect | null;
  groupsTop: number;
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
  const hasRoot = data.root !== null;
  const hasLead = data.lead !== null;
  // 无负责人岗位时不画占位卡片，群直接上移，避免任何合成节点。
  const groupsTop = hasLead ? (hasRoot ? GROUP_TOP : 110) : hasRoot ? 100 : 16;
  const trunkY = hasRoot && hasLead ? 178 : hasLead ? 84 : hasRoot ? 74 : 0;
  const root: Rect | null = hasRoot
    ? { x: (width - rootWidth) / 2, y: 8, w: rootWidth, h: 48 }
    : null;
  const lead: Rect | null = hasLead
    ? { x: (width - leadWidth) / 2, y: hasRoot ? 82 : 8, w: leadWidth, h: 62 }
    : null;
  const rows = Math.ceil(data.groups.length / columns);
  // 实际参与者可能多于原型 v2 的两人，群卡片按成员数长高，不把成员画到容器外。
  const groupHeightOf = (group: GraphGroupVM): number => {
    const count = group.members.length;
    return Math.max(GROUP_HEIGHT, 57 + count * 58 + Math.max(0, count - 1) * 32 + 16);
  };
  const positioned = data.groups.map((group, index) => ({
    group,
    row: Math.floor(index / columns),
    column: index % columns,
    h: groupHeightOf(group),
  }));
  const rowHeights = Array.from({ length: rows }, (_, row) =>
    positioned.filter(item => item.row === row).reduce((max, item) => Math.max(max, item.h), 0));
  const rowTops: number[] = [];
  let cursor = groupsTop;
  for (let row = 0; row < rows; row += 1) {
    rowTops[row] = cursor;
    cursor += rowHeights[row]! + ROW_GAP;
  }
  const height = Math.max(groupsTop, cursor - ROW_GAP) + 56;
  const rowTrunkYs = rowTops.map(top => top - 20);

  const groups: LayoutGroup[] = positioned.map(({ group, row, column, h }) => {
    const x = PADDING + column * (groupWidth + GAP);
    const y = rowTops[row]!;
    const members: LayoutMember[] = group.members.map((member, memberIndex) => ({
      member,
      x: x + 12,
      y: group.members.length > 1
        ? y + 57 + memberIndex * 90
        : y + 45 + (h - 45 - 58) / 2,
      w: groupWidth - 24,
      h: 58,
    }));
    return { group, row, column, x, y, w: groupWidth, h, members };
  });

  return { width, height, columns, root, lead, groupsTop, trunkY, rowTrunkYs, groups };
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

/** 群入口命中：群标题区可选中群，成员区域仍由 hitTestMember 优先处理。 */
export function hitTestGroup(layout: GraphLayout, x: number, y: number): string | null {
  for (const group of layout.groups) {
    if (!group.group.id) continue;
    if (x < group.x || x > group.x + group.w || y < group.y || y > group.y + 45) continue;
    return group.group.id;
  }
  return null;
}

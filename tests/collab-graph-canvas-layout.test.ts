import assert from "node:assert/strict";
import test from "node:test";
import { hitTestMember, hitTestGroup, layoutGraph, type GraphCanvasData } from "../src/web/src/components/collabGraphLayout.ts";

const data: GraphCanvasData = {
  root: { name: "总管", role: "协调中枢", avatar: 0, initials: "总" },
  lead: { id: "lead", name: "项目负责人", initials: "负", role: "协调中", status: "协调中", tone: "active", avatar: 6 },
  groups: [
    {
      name: "界面升级小组", icon: "grid", flowLabel: "设计协作", flowMessage: "方案 · 已送达", flowEmphasis: true,
      members: [
        { id: "product", name: "产品设计师", initials: "产", status: "方案已提交", tone: "active", avatar: 1 },
        { id: "frontend", name: "前端工程师", initials: "前", status: "执行中", tone: "active", avatar: 2 },
      ],
    },
    {
      name: "MCP 能力接入", icon: "layers", flowLabel: "接口协作", flowMessage: "权限复核",
      members: [
        { id: "backend", name: "后端工程师", initials: "后", status: "执行中", tone: "active", avatar: 3 },
        { id: "security", name: "安全审查员", initials: "安", status: "等待材料", tone: "wait", avatar: 4 },
      ],
    },
    {
      name: "质量保障", icon: "check", flowLabel: "验证协作",
      members: [
        { id: "verify", name: "验证工程师", initials: "验", status: "等待版本", tone: "wait", avatar: 5 },
      ],
    },
  ],
};

function assertInside(layout: ReturnType<typeof layoutGraph>): void {
  for (const header of [layout.root, layout.lead]) {
    if (!header) continue;
    assert.ok(header.x >= 0 && header.x + header.w <= layout.width);
    assert.ok(header.y >= 0 && header.y + header.h <= layout.height);
  }
  for (const group of layout.groups) {
    assert.ok(group.x >= 0 && group.x + group.w <= layout.width);
    assert.ok(group.y >= 0 && group.y + group.h <= layout.height);
    for (const member of group.members) {
      assert.ok(member.x >= group.x && member.x + member.w <= group.x + group.w);
      assert.ok(member.y >= group.y && member.y + member.h <= group.y + group.h);
    }
  }
}

test("宽屏三列，布局宽度等于容器宽度且所有节点在画布内", () => {
  const layout = layoutGraph(data, 760);
  assert.equal(layout.width, 760);
  assert.equal(layout.columns, 3);
  assert.equal(layout.groups.length, 3);
  assert.ok(layout.groups.every(group => group.row === 0));
  assertInside(layout);
});

test("中屏两列，第三群换行且画布高度随内容增长", () => {
  const wide = layoutGraph(data, 760);
  const medium = layoutGraph(data, 600);
  assert.equal(medium.width, 600);
  assert.equal(medium.columns, 2);
  assert.equal(medium.groups[2]!.row, 1);
  assert.ok(medium.height > wide.height);
  assertInside(medium);
});

test("窄屏单列，三群纵向排列且无横向溢出", () => {
  const narrow = layoutGraph(data, 390);
  assert.equal(narrow.width, 390);
  assert.equal(narrow.columns, 1);
  assert.deepEqual(narrow.groups.map(group => group.row), [0, 1, 2]);
  assert.ok(narrow.groups.every(group => group.x >= 0 && group.x + group.w <= 390));
  assert.ok(narrow.height > 900);
  assertInside(narrow);
});

test("命中使用 CSS 像素坐标，成员行与空白均正确", () => {
  for (const width of [760, 600, 390]) {
    const layout = layoutGraph(data, width);
    const first = layout.groups[0]!.members[0]!;
    assert.equal(hitTestMember(layout, first.x + first.w / 2, first.y + first.h / 2), first.member.id);
    assert.equal(hitTestMember(layout, 2, 2), null);
  }
});

test("无负责人岗位时不画占位节点，群组仍从顶部排列且不溢出", () => {
  const headerless: GraphCanvasData = { root: null, lead: null, groups: data.groups };
  const layout = layoutGraph(headerless, 390);
  assert.equal(layout.root, null);
  assert.equal(layout.lead, null);
  assert.equal(layout.groupsTop, 16);
  assert.equal(layout.groups[0]!.y, 16);
  assert.equal(layout.columns, 1);
  assertInside(layout);
});

test("空图高度有限且没有成员命中区域", () => {
  const empty = layoutGraph({ root: null, lead: null, groups: [] }, 390);
  assert.deepEqual(empty.groups, []);
  assert.ok(empty.height < 100);
  assert.equal(hitTestMember(empty, 10, 10), null);
});

test("多成员群组卡片随成员数长高，最后一名成员仍在容器内", () => {
  const three: GraphCanvasData = {
    root: null, lead: null,
    groups: [{
      name: "三人真实群", icon: "grid", flowLabel: "群消息 1",
      members: ["a", "b", "c"].map(id => ({ id, name: id, initials: id, status: "在线", tone: "ok" as const, avatar: 0 })),
    }],
  };
  const layout = layoutGraph(three, 760);
  const group = layout.groups[0]!;
  assert.equal(group.members.length, 3);
  assert.ok(group.h > 230);
  const last = group.members[2]!;
  assert.ok(last.y + last.h <= group.y + group.h);
  assertInside(layout);
});

test("群入口命中真实群 ID，成员区域仍由成员命中优先，不返回合成 ID", () => {
  const withIds: GraphCanvasData = {
    root: null, lead: null,
    groups: [{
      id: "g-real", name: "真实群", icon: "grid", flowLabel: "群消息 1",
      members: [{ id: "g-real:m-1", memberId: "m-1", groupId: "g-real", name: "成员", initials: "成", status: "在线", tone: "ok", avatar: 1 }],
    }],
  };
  const layout = layoutGraph(withIds, 760);
  const group = layout.groups[0]!;
  assert.equal(hitTestGroup(layout, group.x + 20, group.y + 20), "g-real");
  assert.equal(hitTestGroup(layout, group.x + 20, group.y + group.h + 20), null);
  assert.equal(hitTestMember(layout, group.x + 20, group.y + 20), null);
  assert.equal(hitTestGroup(layout, 5, 5), null);
});

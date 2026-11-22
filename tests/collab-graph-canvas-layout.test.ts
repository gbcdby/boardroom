import assert from "node:assert/strict";
import test from "node:test";
import { hitTestMember, layoutGraph, type GraphCanvasData } from "../src/web/src/components/collabGraphLayout.ts";

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
  assert.ok(layout.root.x >= 0 && layout.root.x + layout.root.w <= layout.width);
  assert.ok(layout.lead.x >= 0 && layout.lead.x + layout.lead.w <= layout.width);
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

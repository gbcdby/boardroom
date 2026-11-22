import assert from "node:assert/strict";
import test from "node:test";
import {
  canvasViewport,
  hitTestMember,
  layoutGraph,
  type GraphCanvasData,
  type GraphViewport,
} from "../src/web/src/components/collabGraphLayout.ts";

const data: GraphCanvasData = {
  root: { name: "总管", role: "协调中枢", avatar: 0, initials: "总" },
  lead: { id: "lead", name: "项目负责人", initials: "负", role: "协调中", status: "协调中", tone: "active", avatar: 6 },
  groups: [
    {
      name: "界面升级小组", icon: "grid", flowLabel: "设计协作", flowMessage: "方案 · 已送达",
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

function cssPoint(layout: ReturnType<typeof layoutGraph>, viewport: GraphViewport, x: number, y: number): [number, number] {
  return [viewport.offsetX + x * viewport.scale, viewport.offsetY + y * viewport.scale];
}

test("布局固定虚拟画布，三群与成员行都在画布内且互不重叠", () => {
  const layout = layoutGraph(data);
  assert.equal(layout.groups.length, 3);
  assert.equal(layout.groups.reduce((total, group) => total + group.members.length, 0), 5);
  for (const group of layout.groups) {
    assert.ok(group.x >= 0 && group.x + group.w <= layout.width);
    assert.ok(group.y >= 0 && group.y + group.h <= layout.height);
    for (const member of group.members) {
      assert.ok(member.x >= group.x && member.x + member.w <= group.x + group.w);
      assert.ok(member.y >= group.y && member.y + member.h <= group.y + group.h);
    }
  }
  for (let i = 1; i < layout.groups.length; i += 1) {
    const previous = layout.groups[i - 1]!;
    const current = layout.groups[i]!;
    assert.ok(previous.x + previous.w <= current.x);
  }
});

test("命中测试按等比缩放返回成员 ID，画布空白处返回 null", () => {
  const layout = layoutGraph(data);
  const viewport = canvasViewport(760, 470, layout);
  const first = layout.groups[0]!.members[0]!;
  const [x, y] = cssPoint(layout, viewport, first.x + first.w / 2, first.y + first.h / 2);
  assert.equal(hitTestMember(layout, viewport, x, y), first.member.id);
  assert.equal(hitTestMember(layout, viewport, 2, 2), null);
});

test("视口按较小比例等比缩放并居中留白，不拉伸图形", () => {
  const layout = layoutGraph(data);
  const viewport = canvasViewport(380, 235, layout);
  assert.equal(viewport.scale, 0.5);
  assert.equal(viewport.offsetX, 0);
  assert.equal(viewport.offsetY, 0);
  const tall = canvasViewport(760, 940, layout);
  assert.equal(tall.scale, 1);
  assert.equal(tall.offsetX, 0);
  assert.equal(tall.offsetY, 235);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * #60（T4 / HOST-05 / AC-HOST-08）文档证据索引测试。
 *
 * 轻量 seam：保证文档里索引的「真实实测证据」不悬空（文件确实在磁盘上），
 * 并保证 `docs/getting-started-mcp.md` §4.5 区域包含 DoD 关键术语与证据路径。
 * 断言故意保持宽松（关键词存在、路径存在），避免把文档测试写得脆弱。
 *
 * 非目标：不触碰任何实现/行为、不改适配器或迁移逻辑。
 */

const repoRoot = path.resolve(import.meta.dirname, "..");

const EVIDENCE_FILES = [
  "evidence/real-host-retest/README.md",
  "evidence/real-host-retest/dsh-join.out",
  "evidence/real-host-retest/dsh-wait.out",
];

test("证据索引引用的真实实测文件都存在（不悬空）", () => {
  for (const rel of EVIDENCE_FILES) {
    const abs = path.resolve(repoRoot, rel);
    assert.ok(
      fs.existsSync(abs),
      `文档索引的证据文件应存在于磁盘：${rel}`,
    );
    const stat = fs.statSync(abs);
    assert.ok(stat.size > 0, `证据文件不应为空：${rel}`);
  }
});

test("证据 README 中引用的每个证据文件都存在（真正不悬空）", () => {
  const readmePath = path.resolve(repoRoot, "evidence/real-host-retest/README.md");
  const text = fs.readFileSync(readmePath, "utf8");
  // 抽取 README 中反引号内的证据文件名（仅同级文件名，含 .out/.log/.json/.mjs 扩展名）。
  const refs = new Set<string>();
  for (const m of text.matchAll(/`([A-Za-z0-9_.-]+\.(?:out|log|json|mjs))`/g)) {
    const ref = m[1];
    if (ref) refs.add(ref);
  }
  assert.ok(refs.size > 0, "证据 README 应至少索引一个证据文件");
  for (const ref of refs) {
    // 跨目录引用（含 "/"）不在同级目录校验；本 README 约定只索引同目录已提交文件。
    const abs = path.resolve(repoRoot, "evidence/real-host-retest", ref);
    assert.ok(
      fs.existsSync(abs),
      `证据 README 引用的文件应存在（不得悬空）：${ref}`,
    );
    assert.ok(fs.statSync(abs).size > 0, `证据文件不应为空：${ref}`);
  }
});

test("getting-started-mcp.md §4.5 含 DoD 关键术语与证据路径", () => {
  const docPath = path.resolve(repoRoot, "docs/getting-started-mcp.md");
  assert.ok(fs.existsSync(docPath), "docs/getting-started-mcp.md 应存在");
  const text = fs.readFileSync(docPath, "utf8");

  // §4.5 锚点存在。
  assert.ok(
    /4\.5\s+新宿主接入完成定义/.test(text),
    "应存在 §4.5 新宿主接入完成定义 小节",
  );

  // DoD 关键术语（宽松：命中任一即视为覆盖）。
  const dodTerms = /完成定义|DoD|证据|unsupported/;
  assert.ok(
    dodTerms.test(text),
    "文档应包含 DoD 关键术语（完成定义 / DoD / 证据 / unsupported 之一）",
  );

  // 证据路径确实被索引（相对仓库根）。
  assert.ok(
    text.includes("real-host-retest"),
    "文档应索引 evidence/real-host-retest 证据目录",
  );
  assert.ok(
    text.includes("dsh-join.out") && text.includes("dsh-wait.out"),
    "文档应索引 dsh-join.out 与 dsh-wait.out 真实证据文件",
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { assertMemoryMarkdown, buildMemoryInjection, truncateGraphemes } from "../src/server/memory/injection.ts";
import { DEFAULT_MEMORY_CONFIG } from "../src/server/config.ts";
import type { MemoryDocument } from "../src/shared/memory.ts";

function document(scope: "global" | "project-agent", markdown: string): MemoryDocument {
  return { id: scope, key: scope === "global" ? { scope, agentId: "a", projectId: null } : { scope, agentId: "a", projectId: "p" },
    version: 3, markdown, byteLength: Buffer.byteLength(markdown), updatedAt: "2026-11-10T00:00:00Z",
    updatedBy: { kind: "agent", actorId: "member", agentId: "a", displayName: "A" }, source: "agent" };
}

test("AC-MEM-07：UTF8 文档限额拒绝坏 surrogate，截断保留完整中文/组合字符/ZWJ", () => {
  assert.equal(assertMemoryMarkdown("中文", 6), 6);
  assert.throws(() => assertMemoryMarkdown("中文", 5), { reason: "memory_too_large" });
  assert.throws(() => assertMemoryMarkdown("bad\ud800", 100), { reason: "memory_invalid_unicode" });
  assert.equal(truncateGraphemes("中e\u0301👩‍👩‍👧‍👦末", 6), "中e\u0301");
  assert.equal(truncateGraphemes("👩‍👩‍👧‍👦末", 24), "");
  assert.equal(truncateGraphemes("a" + "\u0301".repeat(100), 64), "");
});

test("AC-MEM-01/03/07：两层公平预算、可回收余额、原文版本不变", () => {
  const global = document("global", "中".repeat(400)); const project = document("project-agent", "e\u0301".repeat(400));
  const before = structuredClone([global, project]);
  const injection = buildMemoryInjection([global, project], { ...DEFAULT_MEMORY_CONFIG, maxInjectedBytes: 512 });
  assert.equal(injection.state, "partial"); assert.equal(injection.entries.length, 2);
  assert.ok(injection.entries.every(entry => entry.injectedBytes >= 252 && entry.truncated && entry.version === 3));
  assert.ok(injection.entries.reduce((sum, entry) => sum + entry.injectedBytes, 0) <= 512);
  assert.deepEqual([global, project], before);
  const reclaimed = buildMemoryInjection([document("global", "短"), project], { ...DEFAULT_MEMORY_CONFIG, maxInjectedBytes: 512 });
  assert.equal(reclaimed.entries[0]?.markdown, "短"); assert.ok(reclaimed.entries[1]!.injectedBytes > 500);
  assert.deepEqual(buildMemoryInjection([], DEFAULT_MEMORY_CONFIG).entries, []);
});

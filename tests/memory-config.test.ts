import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/server/config.ts";

test("MEMORY-10：有效默认值、文件/env 优先级和配置范围", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-memory-config-"));
  try {
    const initial = await loadConfig({ cwd: dir, env: {} });
    assert.deepEqual(initial.memory, { messageThreshold: 50, maxDocumentBytes: 32768, maxInjectedBytes: 8192,
      summaryInputBytes: 65536, summaryAttemptTimeoutMs: 900000 });
    await writeFile(path.join(dir, "config.json"), JSON.stringify({ memory: { messageThreshold: 4, maxDocumentBytes: 4096 } }));
    const configured = await loadConfig({ cwd: dir, env: { AGENT_STUDIO_MEMORY_MESSAGE_THRESHOLD: "7" } });
    assert.equal(configured.memory?.messageThreshold, 7); assert.equal(configured.memory?.maxDocumentBytes, 4096);
    assert.equal(configured.memory?.maxInjectedBytes, 8192);
    for (const value of ["0", "10001", "1.5", "NaN"]) {
      await assert.rejects(loadConfig({ cwd: dir, env: { AGENT_STUDIO_MEMORY_MESSAGE_THRESHOLD: value } }), { name: "ConfigError" });
    }
    await writeFile(path.join(dir, "config.json"), JSON.stringify({ memory: { maxInjectedBytes: 511 } }));
    await assert.rejects(loadConfig({ cwd: dir, env: {} }), { name: "ConfigError" });
    await writeFile(path.join(dir, "config.json"), JSON.stringify({ memory: "invalid" }));
    await assert.rejects(loadConfig({ cwd: dir, env: {} }), { name: "ConfigError" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

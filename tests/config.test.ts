import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/server/config.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-config-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("没有配置文件时使用默认值", async () => {
  await withTempDir(async (dir) => {
    const config = await loadConfig({ cwd: dir, env: {} });

    assert.equal(config.port, 4317);
    assert.equal(config.dataDir, path.join(dir, "data"));
    assert.equal(config.heartbeat.intervalMs, 10_000);
    assert.equal(config.heartbeat.timeoutMs, 30_000);
    assert.equal(config.antiLoop?.maxConsecutiveAutoReplies, 6);
    assert.equal(config.antiLoop?.maxWakesPerMinutePerMember, 20);
  });
});

test("配置文件覆盖默认值", async () => {
  await withTempDir(async (dir) => {
    const configPath = path.join(dir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        port: 5555,
        dataDir: "./var/data",
        heartbeat: { intervalMs: 5000, timeoutMs: 20000 },
      }),
    );

    const config = await loadConfig({ cwd: dir, env: {} });

    assert.equal(config.port, 5555);
    assert.equal(config.dataDir, path.join(dir, "var/data"));
    assert.equal(config.heartbeat.intervalMs, 5000);
    assert.equal(config.heartbeat.timeoutMs, 20_000);
  });
});

test("环境变量覆盖配置文件", async () => {
  await withTempDir(async (dir) => {
    const configPath = path.join(dir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        port: 5555,
        dataDir: "./from-file",
        heartbeat: { intervalMs: 5000, timeoutMs: 20000 },
      }),
    );

    const config = await loadConfig({
      cwd: dir,
      env: {
        AGENT_STUDIO_PORT: "6001",
        AGENT_STUDIO_DATA_DIR: "./from-env",
        AGENT_STUDIO_HEARTBEAT_INTERVAL_MS: "7000",
        AGENT_STUDIO_HEARTBEAT_TIMEOUT_MS: "21000",
      },
    });

    assert.equal(config.port, 6001);
    assert.equal(config.dataDir, path.join(dir, "from-env"));
    assert.equal(config.heartbeat.intervalMs, 7000);
    assert.equal(config.heartbeat.timeoutMs, 21_000);
  });
});

test("无效端口给出明确错误", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(loadConfig({ cwd: dir, env: { AGENT_STUDIO_PORT: "70000" } }), {
      name: "ConfigError",
      message: /port.*70000/,
    });
  });
});

test("心跳超时不大于间隔时给出明确错误", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      loadConfig({
        cwd: dir,
        env: {
          AGENT_STUDIO_HEARTBEAT_INTERVAL_MS: "30000",
          AGENT_STUDIO_HEARTBEAT_TIMEOUT_MS: "10000",
        },
      }),
      { name: "ConfigError", message: /heartbeat/ },
    );
  });
});

test("显式指定的配置文件不存在时报错", async () => {
  await withTempDir(async (dir) => {
    const missing = path.join(dir, "nope.json");
    await assert.rejects(loadConfig({ cwd: dir, env: { AGENT_STUDIO_CONFIG: missing } }), {
      name: "ConfigError",
      message: /nope\.json/,
    });
  });
});

test("配置文件不是合法 JSON 时报错", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "config.json"), "{ not json");
    await assert.rejects(loadConfig({ cwd: dir, env: {} }), {
      name: "ConfigError",
      message: /JSON/,
    });
  });
});

test("antiLoop 阈值可通过配置文件与环境变量覆盖", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "config.json"),
      JSON.stringify({ antiLoop: { maxConsecutiveAutoReplies: 3, maxWakesPerMinutePerMember: 5 } }),
    );
    const fromFile = await loadConfig({ cwd: dir, env: {} });
    assert.equal(fromFile.antiLoop?.maxConsecutiveAutoReplies, 3);
    assert.equal(fromFile.antiLoop?.maxWakesPerMinutePerMember, 5);

    const fromEnv = await loadConfig({
      cwd: dir,
      env: {
        AGENT_STUDIO_MAX_CONSECUTIVE_AUTO_REPLIES: "9",
        AGENT_STUDIO_MAX_WAKES_PER_MINUTE_PER_MEMBER: "42",
      },
    });
    assert.equal(fromEnv.antiLoop?.maxConsecutiveAutoReplies, 9);
    assert.equal(fromEnv.antiLoop?.maxWakesPerMinutePerMember, 42);
  });
});

test("antiLoop 阈值非正整数时报错", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(loadConfig({ cwd: dir, env: { AGENT_STUDIO_MAX_CONSECUTIVE_AUTO_REPLIES: "0" } }), {
      name: "ConfigError",
      message: /maxConsecutiveAutoReplies/,
    });
  });
});

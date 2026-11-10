import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createLogger } from "../src/server/logger.ts";

interface CapturedLine {
  readonly raw: string;
  readonly parsed: Record<string, unknown>;
}

test("真实默认stdout异步EPIPE不中止进程，父子logger共享失败计数", { timeout: 5000 }, async () => {
  const moduleUrl = new URL("../src/server/logger.ts", import.meta.url).href;
  const script = `import {createLogger} from ${JSON.stringify(moduleUrl)};
    const logger = createLogger(); const child = logger.child({component:'probe'});
    process.stdin.resume(); process.stdin.on('end', () => {
      child.info('fixed_event');
      setTimeout(() => process.stderr.write(JSON.stringify({parent:logger.health(), child:child.health()})), 25);
    });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", chunk => { stderr += chunk; });
  const ended = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  child.stdout.destroy(); child.stdin.end();
  assert.equal(await ended, 0, stderr);
  const result = JSON.parse(stderr) as { parent: { writeFailures: number }; child: { writeFailures: number } };
  assert.ok(result.parent.writeFailures >= 1); assert.deepEqual(result.parent, result.child);
});

function capture(): { lines: CapturedLine[]; write: (chunk: string) => void } {
  const lines: CapturedLine[] = [];
  return {
    lines,
    write: (chunk: string) => {
      for (const raw of chunk.split("\n")) {
        if (raw.trim() === "") continue;
        lines.push({ raw, parsed: JSON.parse(raw) as Record<string, unknown> });
      }
    },
  };
}

test("每条日志是一行 JSON，带 level、msg、time", () => {
  const sink = capture();
  const logger = createLogger({ write: sink.write });

  logger.info("服务启动", { port: 4317 });

  assert.equal(sink.lines.length, 1);
  const line = sink.lines[0]!;
  assert.equal(line.raw.includes("\n"), false);
  assert.equal(line.parsed["level"], "info");
  assert.equal(line.parsed["msg"], "服务启动");
  assert.equal(line.parsed["port"], 4317);
  assert.equal(typeof line.parsed["time"], "string");
  assert.equal(Number.isNaN(Date.parse(String(line.parsed["time"]))), false);
});

test("日志级别可过滤", () => {
  const sink = capture();
  const logger = createLogger({ write: sink.write, level: "warn" });

  logger.debug("看不见");
  logger.info("也看不见");
  logger.warn("警告");
  logger.error("错误");

  assert.deepEqual(
    sink.lines.map((line) => line.parsed["level"]),
    ["warn", "error"],
  );
});

test("敏感字段被脱敏，不写入明文密钥或消息正文", () => {
  const sink = capture();
  const logger = createLogger({ write: sink.write });

  logger.info("接入 MCP", {
    token: "sk-super-secret-value",
    apiKey: "another-secret",
    authorization: "Bearer abcdef",
    content: "这是不该落盘的完整消息正文",
    body: "也不该落盘",
    port: 4317,
  });

  const raw = sink.lines[0]!.raw;
  assert.equal(raw.includes("sk-super-secret-value"), false);
  assert.equal(raw.includes("another-secret"), false);
  assert.equal(raw.includes("abcdef"), false);
  assert.equal(raw.includes("这是不该落盘的完整消息正文"), false);
  assert.equal(raw.includes("也不该落盘"), false);
  assert.equal(sink.lines[0]!.parsed["port"], 4317);
});

test("嵌套对象的敏感字段同样被脱敏", () => {
  const sink = capture();
  const logger = createLogger({ write: sink.write });

  logger.info("嵌套", { request: { headers: { authorization: "Bearer leaked" } } });

  assert.equal(sink.lines[0]!.raw.includes("leaked"), false);
});

test("无法序列化的循环引用不会让日志抛错", () => {
  const sink = capture();
  const logger = createLogger({ write: sink.write });
  const cyclic: Record<string, unknown> = { name: "a" };
  cyclic["self"] = cyclic;

  assert.doesNotThrow(() => logger.info("循环", { cyclic }));

  assert.equal(sink.lines.length, 1);
  assert.equal(sink.lines[0]!.parsed["level"], "info");
});

test("子 logger 的固定字段会被带上", () => {
  const sink = capture();
  const logger = createLogger({ write: sink.write }).child({ component: "http" });

  logger.info("请求", { path: "/api/health" });

  assert.equal(sink.lines[0]!.parsed["component"], "http");
  assert.equal(sink.lines[0]!.parsed["path"], "/api/health");
});

test("写入端抛错（如管道断开）不会让日志调用抛错", () => {
  const logger = createLogger({
    write: () => {
      throw new Error("EPIPE");
    },
  });

  assert.doesNotThrow(() => logger.info("断管"));
  assert.equal(logger.health().writeFailures, 1);
});

test("logger 健康计数在父子实例共享，快照不可反向修改计数", () => {
  const logger = createLogger({ write: () => { throw new Error("private-sink-detail"); } });
  const child = logger.child({ component: "runtime" });
  child.info("runtime-event");
  logger.warn("runtime-warning");
  assert.deepEqual(logger.health(), { writeFailures: 2, serializationFailures: 0 });
  assert.deepEqual(child.health(), logger.health());
  const snapshot = logger.health() as { writeFailures: number };
  snapshot.writeFailures = 99;
  assert.equal(child.health().writeFailures, 2);
  child.info("unsupported-value", { n: 1n });
  assert.deepEqual(logger.health(), { writeFailures: 3, serializationFailures: 1 });
});

test("运行配置、凭据环境变量和原始进程输出不进入日志，诊断元数据保留", () => {
  const sink = capture();
  const canary = "synthetic-runtime-secret-canary";
  const logger = createLogger({ write: sink.write }).child({
    component: "runner",
    runtimeId: "runtime-1",
    systemPrompt: canary,
  });

  logger.warn("runner_start_failed", {
    env: { PATH: "/bin", ANTHROPIC_API_KEY: canary },
    argv: ["--system-prompt", canary],
    stdout: canary,
    stderr: canary,
    pgConnectionString: `postgres://user:${canary}@localhost/db`,
    details: [{ OPENAI_API_KEY: canary, "github-token": canary, clientSecret: canary }],
    exitCode: 1,
    attemptCount: 2,
    inputTokens: 12,
  });

  const { raw, parsed } = sink.lines[0]!;
  assert.equal(raw.includes(canary), false);
  assert.equal(parsed["component"], "runner");
  assert.equal(parsed["runtimeId"], "runtime-1");
  assert.equal(parsed["msg"], "runner_start_failed");
  assert.equal(parsed["exitCode"], 1);
  assert.equal(parsed["attemptCount"], 2);
  assert.equal(parsed["inputTokens"], 12);
});

test("诊断文本中的连接串、认证头与带名称的凭据脱敏，错误类型与错误码保留", () => {
  const sink = capture();
  const logger = createLogger({ write: sink.write });
  const secret = "synthetic-diagnostic-secret";
  const error = Object.assign(new Error(
    `连接失败 postgres://user:${secret}@localhost/db?password=${secret}; ` +
    `重试 postgresql://user@localhost/db?sslpassword=${secret}; ` +
    `host=localhost password='${secret} with spaces' dbname=boardroom; ` +
    `Authorization: Bearer ${secret}; api_key="${secret}"; --token ${secret}`,
  ), { code: "ECONNREFUSED" });

  logger.error("数据库连接失败", { error, bindingId: "binding-1" });
  const { raw, parsed } = sink.lines[0]!;
  assert.equal(raw.includes(secret), false);
  assert.equal(parsed["bindingId"], "binding-1");
  assert.deepEqual(
    { name: (parsed["error"] as Record<string, unknown>)["name"], code: (parsed["error"] as Record<string, unknown>)["code"] },
    { name: "Error", code: "ECONNREFUSED" },
  );
  assert.match(String((parsed["error"] as Record<string, unknown>)["message"]), /连接失败/);
});

test("事件文本和序列化降级路径也不回显明确凭据", () => {
  const sink = capture();
  const logger = createLogger({ write: sink.write });
  const secret = "synthetic-fallback-secret";

  logger.error(`请求失败 https://user:${secret}@example.test/api`, { count: 1n });

  const { raw, parsed } = sink.lines[0]!;
  assert.equal(raw.includes(secret), false);
  assert.equal(parsed["logError"], "fields-not-serializable");
  assert.match(String(parsed["msg"]), /请求失败/);
});

test("嵌套诊断 JSON 的非敏感外层不会吞掉内部凭据（R-RUNTIME-LOG-001）", () => {
  const sink = capture();
  const logger = createLogger({ write: sink.write });
  const secret = "synthetic-nested-secret";
  const diagnostics = [
    `invalid {"runtime":{"password":"${secret}"}} code=CONFIG_INVALID`,
    `invalid {"error":{"api_key":"${secret}"}} code=CONFIG_INVALID`,
    `invalid {"items":[{"safe":true,"client_secret":"${secret}"}]} code=CONFIG_INVALID`,
    `invalid {"credentials":{"primary":"${secret}","nested":["${secret}"]}} code=CONFIG_INVALID`,
    `invalid --verbose --token "${secret}" code=CONFIG_INVALID`,
  ];

  for (const diagnostic of diagnostics) {
    logger.error("runtime_config_invalid", {
      error: Object.assign(new Error(diagnostic), { code: "CONFIG_INVALID" }),
      runtimeId: "runtime-1",
    });
    const { raw, parsed } = sink.lines.at(-1)!;
    assert.equal(raw.includes(secret), false);
    assert.equal(parsed["runtimeId"], "runtime-1");
    const loggedError = parsed["error"] as Record<string, unknown>;
    assert.equal(loggedError["code"], "CONFIG_INVALID");
    assert.match(String(loggedError["message"]), /^invalid /);
    assert.match(String(loggedError["message"]), /code=CONFIG_INVALID$/);
  }
});

test("长普通诊断不会卡住日志调用，末尾凭据仍然遮蔽（R-PR80-STD-001）", () => {
  // 使用独立进程的宽松超时保护事件循环；不依赖机器速度断言毫秒耗时。
  const source = `
    import assert from "node:assert/strict";
    import { createLogger } from ${JSON.stringify(new URL("../src/server/logger.ts", import.meta.url).href)};
    let record;
    const logger = createLogger({ write: (line) => { record = JSON.parse(line); } });
    const secret = "synthetic-long-diagnostic-secret";
    for (const unit of ["x", "--a", "a-", "a."]) {
      const prefix = unit.repeat(Math.ceil(256 * 1024 / unit.length));
      const diagnostic = prefix + ' --token "' + secret + '" code=SAFE';
      logger.error(diagnostic, { error: new Error(diagnostic) });
      assert.equal(record.msg, prefix + ' --token [REDACTED] code=SAFE');
      assert.equal(record.error.message, record.msg);
      assert.equal(JSON.stringify(record).includes(secret), false);
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stderr);
});

test("扫描起点优化保留带标点前缀的凭据与 URL 脱敏", () => {
  const sink = capture();
  const logger = createLogger({ write: sink.write });
  const secret = "synthetic-token-boundary-secret";
  const diagnostics = [
    `prefix"token"="${secret}" code=SAFE`,
    `.123provider_api_key=${secret} code=SAFE`,
    `---token ${secret} code=SAFE`,
    `prefix--token ${secret} code=SAFE`,
    `.https://user:${secret}@example.test/api code=SAFE`,
  ];
  for (const diagnostic of diagnostics) {
    logger.error(diagnostic);
    const { raw, parsed } = sink.lines.at(-1)!;
    assert.equal(raw.includes(secret), false);
    assert.match(String(parsed["msg"]), /code=SAFE$/);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../src/server/logger.ts";

interface CapturedLine {
  readonly raw: string;
  readonly parsed: Record<string, unknown>;
}

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
});

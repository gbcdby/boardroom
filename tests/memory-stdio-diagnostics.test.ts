import test from "node:test";
import assert from "node:assert/strict";
import { safeMemoryObservation, safeMemoryStderr, safeReaderSnapshot } from "./helpers/memory-reader-observer.ts";

test("stdio 诊断保留完整安全原因，不输出 Memory 正文或未知自由文本", () => {
  const secret = "fixture-private-content-and-credential";
  const memory = safeMemoryObservation({ state: "unavailable", maxBytes: 16384,
    entries: [{ markdown: secret }], errors: [
      { scope: "global", code: "memory_reader_timeout", message: secret },
      { scope: "project-agent", code: "memory_binding_unavailable" },
      { scope: secret, code: secret },
    ], extra: secret });
  assert.equal(memory.state, "unavailable"); assert.equal(memory.entryCount, 1); assert.equal(memory.maxBytes, 16384);
  assert.deepEqual(memory.errors?.slice(0, 2), [
    { scope: "global", code: "memory_reader_timeout" }, { scope: "project-agent", code: "memory_binding_unavailable" },
  ]);
  assert.equal(memory.errors?.length, 3); assert.equal(memory.errors?.[2]?.code, "UNRECOGNIZED");
  assert.equal(JSON.stringify(memory).includes(secret), false);
  assert.equal(safeMemoryObservation(undefined).state, "NOT_OBSERVED");
});

test("reader 快照只关联指定 owned stdio，外部 ready/exit 和 MCP init 不能填补缺失阶段", () => {
  const secret = "not-a-public-path-or-binding";
  const lines = [
    { phase: "observer", owner: 51, parentPid: 41, seq: 1, atMs: 4, atUtc: "2026-11-13T00:00:00.000Z" },
    { phase: "fork", owner: 51, reader: "51/1", seq: 2, atMs: 5 },
    { phase: "init", owner: 51, reader: "51/1", childPid: 61, seq: 3, atMs: 6,
      database: { kind: "sqlite", sqlitePath: secret, sourcePath: secret, identity: { device: "1", inode: "2" } } },
    { phase: "read", owner: 51, reader: "51/1", childPid: 61, seq: 4, atMs: 7,
      nonce: secret, memberId: secret, projectId: secret, bindingGeneration: secret, membershipRevision: 1 },
    { phase: "ready", owner: 99, reader: "99/1", childPid: 100, atMs: 8 },
    { phase: "exit", owner: 99, reader: "99/1", childPid: 100, code: "0", signal: null, atMs: 9 },
    { phase: "mcp-initialize", owner: 51, atMs: 10, content: secret },
  ].map(value => JSON.stringify(value)).join("\n") + "\n{not-json\n";
  const snapshot = safeReaderSnapshot(lines, 51);
  assert.equal(snapshot.ownerPid, 51); assert.equal(snapshot.foreignOwnerEvents, 2);
  assert.equal(snapshot.parseFailed, 1); assert.equal(snapshot.unknownPhaseEvents, 1);
  assert.equal(snapshot.readers.length, 1); assert.equal(snapshot.readers[0]?.childPid, 61);
  assert.equal(snapshot.readers[0]?.ready, "NOT_OBSERVED"); assert.equal(snapshot.readers[0]?.exit, "NOT_OBSERVED");
  assert.equal(snapshot.events.length, 4); assert.equal(JSON.stringify(snapshot).includes(secret), false);
  assert.equal(snapshot.capped, false); assert.equal(snapshot.dropped, 0);
});

test("reader 实际 ready/result/exit 与 nonce 指纹保持关联，快照截断不冒充完整", () => {
  const binding = { nonce: "request-a", memberId: "member-a", projectId: "project-a", bindingGeneration: "generation-a", membershipRevision: 2 };
  const events = [
    { phase: "fork" }, { phase: "ready" }, { phase: "read", ...binding },
    { phase: "result", ...binding, state: "available", errors: [], entryCount: 0 },
    { phase: "exit", code: "null", signal: "SIGTERM" },
  ].map((event, i) => ({ ...event, owner: 71, reader: "71/1", childPid: 81, atMs: i, seq: i + 1 }));
  const result = safeReaderSnapshot(events.map(e => JSON.stringify(e)).join("\n") + "\n", 71);
  assert.equal(result.readers[0]?.ready, "OBSERVED"); assert.deepEqual(result.readers[0]?.exit, { code: null, signal: "SIGTERM" });
  assert.equal(result.events[2]?.["bindingSha256"], result.events[3]?.["bindingSha256"]);
  assert.equal(typeof result.events[2]?.["bindingSha256"], "string");
  const capped = safeReaderSnapshot(Array.from({ length: 270 }, () => JSON.stringify(events[0])).join("\n") + "\n", 71);
  assert.equal(capped.capped, true); assert.equal(capped.events.length, 256); assert.equal(capped.dropped, 14);
});

test("stderr 只解码已知结构化 reader 警告，保留解析缺口而不回显原文", () => {
  const secret = "private-stderr-content";
  const text = [
    JSON.stringify({ level: "warn", msg: "memory_reader_unavailable", code: "memory_reader_ipc_failed", message: secret }),
    JSON.stringify({ level: "warn", msg: "memory_reader_unavailable", code: secret }),
    JSON.stringify({ level: "warn", msg: secret, code: secret }),
    "not-json-" + secret,
  ].join("\n") + "\npartial-" + secret;
  const result = safeMemoryStderr(text);
  assert.deepEqual(result.readerWarnings.map(e => e.code), ["memory_reader_ipc_failed", "UNRECOGNIZED"]);
  assert.equal(result.parseFailed, 1); assert.equal(result.ignored, 1); assert.equal(result.partialLine, true);
  assert.equal(result.truncated, false); assert.equal(JSON.stringify(result).includes(secret), false);
});

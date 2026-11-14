import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MemoryInjection, MemoryInjectionEntry } from "../../src/shared/memory.ts";
import type { MemoryDatabaseDescriptor } from "../../src/server/memory/injection-reader.ts";

type SafeDatabase = { kind: "sqlite"; sqlitePath: string; sourcePath?: string; identity?: { device: string; inode: string } | null }
  | { kind: "postgres"; configurationSha256: string };
type Binding = { nonce?: unknown; memberId?: unknown; projectId?: unknown; bindingGeneration?: unknown; membershipRevision?: unknown };
export interface ReaderPhase extends Binding {
  phase: string; owner: number; atMs: number; reader?: string; childPid?: number;
  seq?: number; atUtc?: string; parentPid?: number; clockOriginMs?: number;
  budgetMs?: number; timerId?: number; database?: SafeDatabase; code?: string; signal?: string | null;
  state?: string; errors?: { scope: string; code: string }[]; entryCount?: number; maxBytes?: number;
}
export type ExpectedMemoryEntry = Pick<MemoryInjectionEntry, "scope" | "documentId" | "version" | "markdown">;

export function safeReaderDatabase(database: MemoryDatabaseDescriptor): SafeDatabase {
  if (database.kind === "sqlite") return { kind: database.kind, sqlitePath: database.sqlitePath,
    ...(database.sourcePath === undefined ? {} : { sourcePath: database.sourcePath }),
    ...(database.identity === undefined ? {} : { identity: database.identity }) };
  return { kind: database.kind, configurationSha256: createHash("sha256")
    .update(JSON.stringify([database.connectionString, database.schema ?? null])).digest("hex") };
}

function binding(message: Record<string, unknown>): Binding {
  return { nonce: message["nonce"], memberId: message["memberId"], projectId: message["projectId"],
    bindingGeneration: message["bindingGeneration"], membershipRevision: message["membershipRevision"] };
}

/** 只由测试创建的 --import 脚本安装；不改变业务参数、计时预算或 IPC 回复。日志不含正文/连接串。 */
export function installMemoryReaderObserver(log: string): void {
  let childNumber = 0, timerNumber = 0, sequence = 0; let reader: string | undefined;
  const note = (phase: string, fields: Partial<ReaderPhase> = {}) => appendFileSync(log,
    JSON.stringify({ phase, owner: process.pid, parentPid: process.ppid, seq: ++sequence,
      atUtc: new Date().toISOString(), atMs: performance.now(), clockOriginMs: performance.timeOrigin,
      ...(reader ? { reader } : {}), ...fields }) + "\n");
  note("observer");
  process.once("exit", code => note("owner-exit", { code: String(code) }));
  const originalFork = childProcess.fork;
  childProcess.fork = ((...args: unknown[]) => {
    const observed = String(args[0]).endsWith("/injection-reader-child.ts");
    if (observed) { reader = `${process.pid}/${++childNumber}`; note("fork"); }
    const child = Reflect.apply(originalFork, childProcess, args) as ChildProcess;
    if (!observed) return child;
    const ownReader = reader!;
    const record = (phase: string, fields: Partial<ReaderPhase> = {}) => note(phase,
      { reader: ownReader, ...(child.pid === undefined ? {} : { childPid: child.pid }), ...fields });
    const send = child.send;
    child.send = ((message: Record<string, unknown>, ...rest: unknown[]) => {
      if (message["type"] === "init") record("init", { database: safeReaderDatabase(message["database"] as MemoryDatabaseDescriptor) });
      if (message["type"] === "read") record("read", binding(message));
      const callback = rest.at(-1);
      if (typeof callback === "function") rest[rest.length - 1] = (error: Error | null) => {
        if (error) record("ipc-error", { code: safeObservationError(error).code }); callback(error);
      };
      try { return Reflect.apply(send, child, [message, ...rest]) as boolean; }
      catch (error) { record("ipc-error", { code: safeObservationError(error).code }); throw error; }
    }) as typeof child.send;
    const kill = child.kill;
    child.kill = ((signal?: NodeJS.Signals | number) => {
      record("kill", { signal: String(signal ?? "SIGTERM") }); return kill.call(child, signal);
    }) as typeof child.kill;
    child.on("message", (raw: unknown) => {
      if (!raw || typeof raw !== "object") return;
      const message = raw as Record<string, unknown>;
      if (message["type"] === "ready") record("ready");
      if (message["type"] === "error") record("query-error", safeReason(message["code"]));
      if (message["type"] === "result") {
        const result = message["result"] as MemoryInjection | undefined;
        if (!result || !Array.isArray(result.errors) || !Array.isArray(result.entries)
          || result.errors.some(error => !error || typeof error.scope !== "string" || typeof error.code !== "string")) {
          record("protocol-error"); return;
        }
        record("result", { ...binding(message), state: result.state,
          errors: result.errors.map(({ scope, code }) => ({ scope, code })), entryCount: result.entries.length, maxBytes: result.maxBytes });
      }
    });
    child.on("error", error => record("process-error", { code: safeObservationError(error).code }));
    child.on("exit", (code, signal) => record("exit", { code: String(code), signal }));
    return child;
  }) as typeof childProcess.fork;
  syncBuiltinESMExports();

  // 仅观察生产 reader 自己的两种 timer。回调、返回的 Timeout、delay、参数保持原样；不使用测试时钟。
  const readerSource = fileURLToPath(new URL("../../src/server/memory/injection-reader.ts", import.meta.url));
  const schedule = globalThis.setTimeout;
  globalThis.setTimeout = Object.assign((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if ((delay !== 500 && delay !== 1000) || !new Error().stack?.includes(readerSource)) return schedule(callback, delay, ...args);
    const timerId = ++timerNumber;
    const timer = schedule(() => { note("timer-fired", { budgetMs: delay, timerId }); callback(...args); }, delay);
    note("timer-started", { budgetMs: delay, timerId });
    return timer;
  }, schedule) as typeof setTimeout;
}

const REASON_CODES = new Set(["memory_reader_timeout", "memory_reader_hard_timeout", "memory_reader_circuit_open",
  "memory_reader_query_failed", "memory_reader_ipc_failed", "memory_reader_protocol_failed", "memory_reader_process_failed",
  "memory_reader_exited", "memory_reader_closed", "memory_reader_busy", "memory_reader_unavailable", "memory_reader_unconfigured",
  "memory_binding_unavailable", "memory_binding_changed", "storage_maintenance"]);
const PHASES = new Set(["observer", "owner-exit", "fork", "init", "read", "ready", "result", "timer-started", "timer-fired",
  "ipc-error", "query-error", "protocol-error", "process-error", "kill", "exit"]);
const SIGNALS = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGBUS", "SIGSEGV", "SIGPIPE", "SIGHUP", "SIGQUIT", "SIGILL", "SIGFPE", "SIGTRAP", "SIGSYS"]);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const integer = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
function safeReason(value: unknown): { code: string; codeSha256?: string } {
  return typeof value === "string" && REASON_CODES.has(value) ? { code: value }
    : { code: "UNRECOGNIZED", ...(typeof value === "string" ? { codeSha256: hash(value) } : {}) };
}

/** 白名单只用于日志投影，不接受未知结果、不改变测试断言。 */
export function safeObservationError(value: unknown): { name: string; code: string } {
  const error = object(value), names = new Set(["Error", "AssertionError", "TypeError", "SyntaxError", "RangeError", "AggregateError"]);
  const codes = new Set(["ENOENT", "EACCES", "EPERM", "EBADF", "EPIPE", "ERR_ASSERTION", "ERR_STREAM_DESTROYED", "ERR_IPC_CHANNEL_CLOSED"]);
  return { name: names.has(String(error["name"])) ? String(error["name"]) : "UNRECOGNIZED",
    code: codes.has(String(error["code"])) ? String(error["code"]) : "UNRECOGNIZED" };
}

export function safeMemoryObservation(value: unknown) {
  const memory = object(value);
  return { state: ["available", "partial", "unavailable"].includes(String(memory["state"])) ? String(memory["state"]) : "NOT_OBSERVED",
    entryCount: Array.isArray(memory["entries"]) ? memory["entries"].length : null, maxBytes: integer(memory["maxBytes"]),
    errors: Array.isArray(memory["errors"]) ? memory["errors"].map(value => {
      const error = object(value), scope = error["scope"];
      return { scope: scope === "global" || scope === "project-agent" ? scope : "UNRECOGNIZED", ...safeReason(error["code"]) };
    }) : null };
}

/** 只解析既有结构化 warn；原 stderr、自由文本、payload 和凭据不进入快照。 */
export function safeMemoryStderr(text: string) {
  const lines = text.split("\n"), partialLine = lines.pop() !== "";
  const readerWarnings: { code: string; codeSha256?: string }[] = []; let parseFailed = 0, ignored = 0;
  for (const line of lines) {
    if (!line) continue;
    try {
      const event = object(JSON.parse(line));
      if (event["msg"] === "memory_reader_unavailable" && event["level"] === "warn") readerWarnings.push(safeReason(event["code"]));
      else ignored++;
    } catch { parseFailed++; }
  }
  return { bytes: Buffer.byteLength(text), readerWarnings, parseFailed, ignored, partialLine, truncated: false };
}

/** 独占日志的只读投影；owner 必须来自本 fixture 实际 spawn 的 PID，不能拼接别的测试事件。 */
export function safeReaderSnapshot(text: string, ownerPid: number | undefined) {
  const events: Record<string, unknown>[] = []; let parseFailed = 0, foreignOwnerEvents = 0, unknownPhaseEvents = 0, dropped = 0;
  const lines = text.split("\n"), partialLine = lines.pop() !== "";
  for (const line of lines) {
    if (!line) continue;
    let event: Record<string, unknown>;
    try { event = object(JSON.parse(line)); } catch { parseFailed++; continue; }
    if (ownerPid === undefined || event["owner"] !== ownerPid) { foreignOwnerEvents++; continue; }
    if (!PHASES.has(String(event["phase"]))) { unknownPhaseEvents++; continue; }
    if (events.length >= 256) { dropped++; continue; }
    const phase = String(event["phase"]), reader = typeof event["reader"] === "string" && new RegExp(`^${ownerPid}/[1-9][0-9]*$`).test(event["reader"]) ? event["reader"] : null;
    const safe: Record<string, unknown> = { phase, owner: ownerPid, parentPid: integer(event["parentPid"]),
      seq: integer(event["seq"]), atMs: number(event["atMs"]), clockOriginMs: number(event["clockOriginMs"]),
      atUtc: typeof event["atUtc"] === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(event["atUtc"]) ? event["atUtc"] : null,
      reader, childPid: integer(event["childPid"]) };
    if (phase === "init") {
      const database = object(event["database"]);
      safe["database"] = database["kind"] === "sqlite" ? { kind: "sqlite", identitySha256: hash([database["sqlitePath"], database["sourcePath"], database["identity"]]) }
        : database["kind"] === "postgres" ? { kind: "postgres", configurationSha256: typeof database["configurationSha256"] === "string" && /^[a-f0-9]{64}$/.test(database["configurationSha256"]) ? database["configurationSha256"] : null }
          : { kind: "NOT_OBSERVED" };
    }
    if (phase === "read" || phase === "result") {
      const parts = [event["nonce"], event["memberId"], event["projectId"], event["bindingGeneration"], event["membershipRevision"]];
      safe["bindingSha256"] = parts.slice(0, 4).every(value => typeof value === "string") && integer(parts[4]) !== null ? hash(parts) : null;
      safe["membershipRevision"] = integer(event["membershipRevision"]);
    }
    if (phase === "result") {
      const memory = safeMemoryObservation(event);
      safe["memory"] = { ...memory, entryCount: integer(event["entryCount"]) };
    }
    if (phase === "timer-started" || phase === "timer-fired") { safe["timerId"] = integer(event["timerId"]); safe["budgetMs"] = number(event["budgetMs"]); }
    if (phase === "exit" || phase === "owner-exit") {
      safe["code"] = event["code"] === null || event["code"] === "null" ? null
        : /^\d+$/.test(String(event["code"])) ? integer(Number(event["code"])) : "NOT_OBSERVED";
    }
    if (phase === "exit" || phase === "kill") safe["signal"] = event["signal"] === null ? null : SIGNALS.has(String(event["signal"])) ? event["signal"] : "UNRECOGNIZED";
    if (["ipc-error", "query-error", "process-error"].includes(phase)) safe["error"] = phase === "query-error" ? safeReason(event["code"]) : safeObservationError({ code: event["code"] });
    events.push(safe);
  }
  const readers = [...new Set(events.map(event => event["reader"]).filter((value): value is string => typeof value === "string"))].map(reader => {
    const own = events.filter(event => event["reader"] === reader), exited = own.find(event => event["phase"] === "exit");
    const childPids = [...new Set(own.map(event => event["childPid"]).filter((value): value is number => typeof value === "number"))];
    return { reader, childPid: childPids.length === 1 ? childPids[0]! : null, childPidConflict: childPids.length > 1,
      ready: own.some(event => event["phase"] === "ready") ? "OBSERVED" : "NOT_OBSERVED",
      exit: exited ? { code: exited["code"], signal: exited["signal"] } : "NOT_OBSERVED" };
  });
  return { ownerPid: ownerPid ?? null, clockRule: "atMs/seq compare only within the same owner; no reader-process clock is installed",
    events, readers, ownerExit: events.find(event => event["phase"] === "owner-exit") ?? "NOT_OBSERVED",
    parseFailed, foreignOwnerEvents, unknownPhaseEvents, partialLine, capped: dropped > 0, dropped };
}

function safeInjection(memory: MemoryInjection | undefined): object {
  return { state: memory?.state, errors: memory?.errors, entryCount: memory?.entries.length };
}

function assertReaderPhases(events: ReaderPhase[], expectedDatabase: SafeDatabase, diagnostic: string, closed = false): string | undefined {
  // fixture-close 由持有该独占日志的测试控制器写入；它只授权正常关闭，不授权任何错误结果。
  const phases = events.filter(event => event.phase !== "fixture-close");
  const closes = events.filter(event => event.phase === "fixture-close");
  assert.equal(closes.length, closed ? 1 : 0, diagnostic);
  if (closed) assert.equal(closes[0]!.owner, process.pid, diagnostic);
  if (!phases.length) { assert.ok(closed, diagnostic); return; } // 从未启动的 stdio fixture 没有 owner。
  const owner = phases[0]!.owner;
  assert.ok(phases.every(event => event.owner === owner), diagnostic);
  if (closed) {
    assert.equal(phases.filter(event => event.phase === "observer").length, 1, diagnostic);
    const exit = phases.filter(event => event.phase === "owner-exit");
    assert.equal(exit.length, 1, diagnostic); assert.equal(exit[0]!.code, "0", diagnostic);
    assert.equal(phases.at(-1), exit[0], diagnostic);
    assert.ok(events.indexOf(exit[0]!) > events.indexOf(closes[0]!), diagnostic);
  }
  const forks = events.filter(event => event.phase === "fork");
  if (closed && !forks.length) {
    assert.ok(phases.every(event => ["observer", "owner-exit"].includes(event.phase)), diagnostic); return;
  }
  assert.equal(forks.length, 1, diagnostic);
  const reader = forks[0]!.reader!;
  assert.ok(reader, diagnostic);
  assert.ok(phases.every(event => !event.reader || event.reader === reader), diagnostic);
  const childPids = new Set(phases.flatMap(event => event.childPid === undefined ? [] : [event.childPid]));
  assert.ok(childPids.size <= 1 && (!closed || childPids.size === 1), diagnostic);
  const init = events.filter(event => event.phase === "init");
  assert.equal(init.length, 1, diagnostic); assert.deepEqual(init[0]!.database, expectedDatabase, diagnostic);
  let pending: Binding | null = null; let deadline = false, watchdog = false, closing = false, exited = false;
  const terminationSignals = new Set<string>();
  for (const event of events) {
    assert.ok(!["query-error", "ipc-error", "process-error", "protocol-error"].includes(event.phase), diagnostic);
    if (event.phase === "fixture-close") { closing = true; continue; }
    if (exited) assert.ok(event.phase === "owner-exit", diagnostic);
    if (event.phase === "read") pending = binding(event as unknown as Record<string, unknown>);
    if (event.phase === "result") {
      assert.ok(pending, diagnostic); assert.deepEqual(binding(event as unknown as Record<string, unknown>), pending, diagnostic);
      assert.equal(event.state, "available", diagnostic); assert.deepEqual(event.errors, [], diagnostic); pending = null;
    }
    if (event.phase === "timer-fired" && event.budgetMs === 500) deadline = true;
    if (event.phase === "timer-fired" && event.budgetMs === 1000) watchdog = deadline;
    if (event.phase === "kill") {
      assert.ok((event.signal === "SIGTERM" && (watchdog || closing))
        || (event.signal === "SIGKILL" && closing && terminationSignals.has("SIGTERM")), diagnostic);
      terminationSignals.add(event.signal!);
    }
    if (event.phase === "exit") {
      assert.ok(event.code === "null" && event.signal && terminationSignals.has(event.signal), diagnostic); exited = true;
    }
  }
  if (closed) assert.ok(exited, diagnostic);
  return reader;
}

export function assertInjectionContract(memory: MemoryInjection | undefined, expected: ExpectedMemoryEntry[],
  events: ReaderPhase[], expectedDatabase: SafeDatabase, confirmedTimeouts: Set<string>, afterEvent = 0): "available" | "budget-degraded" {
  const diagnostic = JSON.stringify({ memory: safeInjection(memory), phases: events });
  assert.ok(memory, diagnostic);
  const reader = assertReaderPhases(events, expectedDatabase, diagnostic)!;
  if (memory.state === "available") {
    assert.deepEqual(memory.errors, [], diagnostic);
    assert.deepEqual(memory.entries.map(({ scope, documentId, version, markdown }) => ({ scope, documentId, version, markdown })), expected, diagnostic);
    assert.ok(memory.entries.every(entry => !entry.truncated && entry.sourceBytes === Buffer.byteLength(entry.markdown)
      && entry.injectedBytes === entry.sourceBytes), diagnostic);
    return "available";
  }
  assert.equal(memory.state, "unavailable", diagnostic); // 小文档没有 partial 的前提。
  assert.deepEqual(memory.entries, [], diagnostic);
  const errors = memory.errors.map(({ scope, code }) => ({ scope, code })).sort((a, b) => a.scope.localeCompare(b.scope));
  const code = errors[0]?.code;
  assert.ok(code === "memory_reader_timeout" || code === "memory_reader_circuit_open", diagnostic);
  assert.deepEqual(errors, [{ scope: "global", code }, { scope: "project-agent", code }], diagnostic);
  if (code === "memory_reader_timeout") {
    assert.ok(events.slice(afterEvent).some(event => event.phase === "timer-fired" && event.budgetMs === 500 && event.reader === reader), diagnostic);
    confirmedTimeouts.add(reader);
  } else assert.ok(confirmedTimeouts.has(reader), diagnostic);
  return "budget-degraded";
}

/** 全部收尾步骤都要执行；保留最初断言和每个 close/audit/删除失败，不让 finally 覆盖原异常。 */
export async function withCleanup<T>(body: () => Promise<T>, ...cleanup: (() => unknown | Promise<unknown>)[]): Promise<T> {
  const errors: unknown[] = []; let result!: T;
  try { result = await body(); } catch (error) { errors.push(error); }
  for (const step of cleanup) { try { await step(); } catch (error) { errors.push(error); } }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "测试断言、关闭或最终 memory reader 审计失败");
  return result;
}

export async function createMemoryReaderObservation(dir: string, name: string) {
  const log = path.join(dir, `${name}-reader.jsonl`), preload = path.join(dir, `${name}-reader.mjs`);
  await writeFile(log, "");
  await writeFile(preload, `import { installMemoryReaderObserver } from ${JSON.stringify(import.meta.url)};\ninstallMemoryReaderObserver(${JSON.stringify(log)});\n`);
  const confirmedTimeouts = new Set<string>(); let afterEvent = 0;
  const readEvents = async () => (await readFile(log, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line) as ReaderPhase);
  return { preload,
    async snapshot(ownerPid: number | undefined) { return safeReaderSnapshot(await readFile(log, "utf8"), ownerPid); },
    async assertInjection(memory: MemoryInjection | undefined, expected: ExpectedMemoryEntry[], database: MemoryDatabaseDescriptor) {
      const events = await readEvents();
      const state = assertInjectionContract(memory, expected, events, safeReaderDatabase(database), confirmedTimeouts, afterEvent);
      afterEvent = events.length; return state;
    },
    async closeAndAudit(database: MemoryDatabaseDescriptor, ...close: (() => unknown | Promise<unknown>)[]) {
      await withCleanup(async () => {
        appendFileSync(log, JSON.stringify({ phase: "fixture-close", owner: process.pid, atMs: performance.now() }) + "\n");
      }, ...close, async () => {
        const events = await readEvents();
        assertReaderPhases(events, safeReaderDatabase(database), JSON.stringify({ phases: events, confirmedTimeouts: [...confirmedTimeouts] }), true);
      });
    },
  };
}

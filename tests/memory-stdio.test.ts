import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDbDriver } from "../src/server/db/driver.ts";
import { createRepositories } from "../src/server/db/repositories.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createMemoryReaderObservation, safeMemoryObservation, safeMemoryStderr, safeObservationError, withCleanup } from "./helpers/memory-reader-observer.ts";

test("真实 stdio 启动共用记忆 reader；stdin EOF 等待资源退出且不创建 session-end 请求", { timeout: 15000 }, async t => {
  const fixtureId = randomUUID(), phases: Record<string, unknown>[] = [], diagnosticErrors: unknown[] = [];
  const note = (phase: string, fields: Record<string, unknown> = {}) => phases.push({ phase, fixtureId,
    owner: process.pid, parentPid: process.ppid, seq: phases.length + 1,
    atUtc: new Date().toISOString(), atMs: performance.now(), clockOriginMs: performance.timeOrigin, ...fields });
  note("test-body");
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-memory-stdio-"));
  const db = createDbDriver({ dataDir: dir });
  let child: ChildProcessWithoutNullStreams | undefined, exit: ReturnType<typeof once> | undefined;
  let observation: Awaited<ReturnType<typeof createMemoryReaderObservation>> | undefined;
  let stderr = "", atJoin: object | undefined;
  async function snapshot() {
    if (!observation) return { status: "NOT_OBSERVED" };
    try { return await observation.snapshot(child?.pid); }
    catch (error) {
      diagnosticErrors.push(error);
      return { status: "READ_FAILED", error: safeObservationError(error) };
    }
  }
  await withCleanup(async () => {
    await db.connect(); await db.migrate(migrations);
    const repos = createRepositories(db);
    const project = await repos.projects.create({ name: "stdio 生命周期" });
    const group = await repos.groups.create({ projectId: project.id, name: "协议群" });
    observation = await createMemoryReaderObservation(dir, "owned-stdio");
    note("stdio-spawn-requested");
    const owned = spawn(process.execPath, ["--import", observation.preload, path.resolve("src/server/mcp/stdio.ts")], {
      cwd: dir, env: { PATH: process.env["PATH"], AGENT_STUDIO_DATA_DIR: dir, AGENT_STUDIO_DB_DRIVER: "sqlite", AGENT_STUDIO_LOG_LEVEL: "warn" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = owned; const exited = once(owned, "exit"); exit = exited;
    note("stdio-created", { childPid: owned.pid ?? null });
    owned.on("spawn", () => note("stdio-spawned", { childPid: owned.pid ?? null }));
    owned.on("error", error => note("stdio-error", { childPid: owned.pid ?? null, error: safeObservationError(error) }));
    owned.on("exit", (code, signal) => note("stdio-exit", { childPid: owned.pid ?? null, code, signal }));
    owned.on("close", (code, signal) => note("stdio-close", { childPid: owned.pid ?? null, code, signal }));
    let text = "", nextId = 0;
    const responses = new Map<number, (value: any) => void>();
    owned.stderr.on("data", chunk => { stderr += chunk.toString(); });
    owned.stdout.on("data", chunk => {
      text += chunk.toString();
      let at: number;
      while ((at = text.indexOf("\n")) >= 0) {
        const line = text.slice(0, at); text = text.slice(at + 1);
        let message;
        try { message = JSON.parse(line); }
        catch { note("rpc-parse-error"); throw new SyntaxError("stdio RPC response JSON parse failed; raw body omitted"); }
        if (message.id !== undefined) { responses.get(message.id)?.(message); responses.delete(message.id); }
      }
    });
    async function call(method: "initialize" | "tools/call", params: unknown): Promise<any> {
      const id = ++nextId, started = performance.now();
      note("rpc-send", { method, requestId: id });
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          responses.delete(id); note("rpc-timeout", { method, requestId: id, elapsedMs: performance.now() - started });
          reject(new Error(`stdio ${method} response timed out; see safe memory-stdio-observation`));
        }, 5000);
        responses.set(id, value => {
          clearTimeout(timer);
          note("rpc-response", { method, requestId: id, elapsedMs: performance.now() - started,
            hasResult: value.result !== undefined, hasError: value.error !== undefined,
            errorCode: Number.isSafeInteger(value.error?.code) ? value.error.code : null });
          resolve(value);
        });
        owned.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    }
    const init = await call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "stdio-lifecycle-fixture", version: "1" } });
    assert.ok(init.result, JSON.stringify({ fixtureId, phases, stderr: safeMemoryStderr(stderr) }));
    note("rpc-notification", { method: "notifications/initialized" });
    owned.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const result = await call("tools/call", { name: "join", arguments: { displayName: "stdio本人", hostType: "other", projectId: project.id, groupId: group.id } });
    const joined = result.result.structuredContent;
    atJoin = { fixtureId, requestId: 2, ok: typeof joined.ok === "boolean" ? joined.ok : null,
      memory: safeMemoryObservation(joined.context?.memory), reader: await snapshot(), stderr: safeMemoryStderr(stderr) };
    assert.equal(joined.ok, true, JSON.stringify(atJoin));
    assert.equal(joined.context.memory.state, "available", JSON.stringify(atJoin));
    note("stdin-end", { childPid: owned.pid ?? null });
    owned.stdin.end();
    const watchdog = setTimeout(() => {
      note("stdio-kill-requested", { childPid: owned.pid ?? null, signal: "SIGKILL", reason: "eof-watchdog" });
      owned.kill("SIGKILL");
    }, 4000);
    const [code, signal] = await exited;
    clearTimeout(watchdog);
    assert.equal(code, 0, JSON.stringify({ fixtureId, signal, stderr: safeMemoryStderr(stderr) }));
    assert.equal(signal, null);
    assert.equal((await repos.mcpSessions.listByProject(project.id))[0]?.state, "disconnected");
    assert.deepEqual(await repos.memory.listRequests(project.id, joined.agentId), []);
  }, async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      note("stdio-kill-requested", { childPid: child.pid ?? null, signal: "SIGKILL", reason: "failed-test-cleanup" });
      child.kill("SIGKILL"); await exit;
    }
  }, () => db.close(), async () => {
    note("final-snapshot");
    t.diagnostic(JSON.stringify({ event: "memory-stdio-observation", fixtureId, testPid: process.pid, stdioPid: child?.pid ?? null,
      atJoin: atJoin ?? "NOT_OBSERVED", phases, phasesDropped: 0, phasesCapped: false,
      reader: await snapshot(), stderr: safeMemoryStderr(stderr), diagnosticErrors: diagnosticErrors.map(safeObservationError),
      clockRule: "compare monotonic times only within the same owner; initialize is not reader-ready" }));
  }, () => rm(dir, { recursive: true, force: true }), () => {
    if (diagnosticErrors.length) throw new AggregateError(diagnosticErrors, "stdio reader 诊断读取失败；原断言单独保留");
  });
});

import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { MemoryConfig, MemoryInjection } from "../../shared/memory.ts";
import { resolveMemoryConfig } from "../config.ts";
import { unavailableMemory } from "./injection.ts";
import { MemoryError } from "./errors.ts";

export type MemoryDatabaseDescriptor =
  | { kind: "sqlite"; sqlitePath: string }
  | { kind: "postgres"; connectionString: string; schema?: string };
export interface MemoryReadBinding { memberId: string; projectId: string; bindingGeneration: string }
export interface MemoryInjectionReader { readOwn(input: MemoryReadBinding): Promise<MemoryInjection>; close(): Promise<void> }
export interface MemoryInjectionReaderOptions {
  database: MemoryDatabaseDescriptor;
  config: MemoryConfig;
  onDiagnostic?: (code: string) => void;
  /** 仅受信装配/测试 seam；不接受 HTTP/MCP、配置文件或聊天提供的进程/脚本。 */
  spawnChild?: () => ChildProcess;
}
interface Job { input: MemoryReadBinding; key: string; nonce: string; done: boolean; promise: Promise<MemoryInjection>;
  resolve: (value: MemoryInjection) => void; deadline: ReturnType<typeof setTimeout> | null }

/** 每个 DbDriver 由装配层共享一个实例；这里不借主库连接，也不按 session 创建实例。 */
export function createMemoryInjectionReader(options: MemoryInjectionReaderOptions): MemoryInjectionReader {
  const config = resolveMemoryConfig(options.config);
  const jobs = new Map<string, Job>(); const queue: Job[] = [];
  let child: ChildProcess | null = null; let ready = false; let retiring = false; let active: Job | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null; let circuitUntil = 0; let closed = false; let closing: Promise<void> | null = null;
  function diagnostic(code: string): void { try { options.onDiagnostic?.(code); } catch { /* 诊断钩子不得改变消息结果。 */ } }
  function finish(job: Job, result: MemoryInjection): void {
    if (job.done) return;
    job.done = true; if (job.deadline) clearTimeout(job.deadline);
    if (jobs.get(job.key) === job) jobs.delete(job.key);
    const at = queue.indexOf(job); if (at >= 0) queue.splice(at, 1);
    job.resolve(result);
  }
  function failAll(code: string): void {
    if (active) finish(active, unavailableMemory(config, code));
    for (const job of [...queue]) finish(job, unavailableMemory(config, code));
  }
  function openCircuit(code: string, terminate: boolean): void {
    circuitUntil = Date.now() + 30000; diagnostic(code); failAll(code);
    if (terminate && child) { retiring = true; child.kill("SIGTERM"); }
  }
  function clearWatchdog(): void { if (watchdog) clearTimeout(watchdog); watchdog = null; }
  function sendRead(): void {
    if (!child || !ready || !active) return;
    const job = active;
    child.send({ type: "read", nonce: job.nonce, ...job.input }, error => {
      if (error && active === job) openCircuit("memory_reader_ipc_failed", true);
    });
  }
  function startChild(): void {
    if (child || retiring || closed) return;
    try {
      child = options.spawnChild?.() ?? fork(fileURLToPath(new URL("./injection-reader-child.ts", import.meta.url)), [], {
        execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"],
        // 凭据只在 init IPC 中传递；不放 argv 或子进程日志，不继承 NODE_OPTIONS。
        env: { ...(process.env["PATH"] ? { PATH: process.env["PATH"] } : {}), ...(process.env["SystemRoot"] ? { SystemRoot: process.env["SystemRoot"] } : {}) },
      });
      const instance = child;
      instance.on("message", (raw: unknown) => {
        if (child !== instance || retiring || closed || !raw || typeof raw !== "object") return;
        const message = raw as Record<string, unknown>;
        if (message["type"] === "ready") { ready = true; sendRead(); return; }
        if (message["type"] === "error") { openCircuit("memory_reader_query_failed", true); return; }
        if (message["type"] !== "result" || !active) return;
        const job = active;
        if (message["nonce"] !== job.nonce || message["bindingGeneration"] !== job.input.bindingGeneration ||
          message["memberId"] !== job.input.memberId || message["projectId"] !== job.input.projectId) {
          openCircuit("memory_reader_protocol_failed", true); return;
        }
        clearWatchdog(); active = null;
        if (!job.done && jobs.get(job.key) === job) finish(job, message["result"] as MemoryInjection);
        pump();
      });
      instance.once("error", () => { if (child === instance && !closed) openCircuit("memory_reader_process_failed", true); });
      instance.once("exit", () => {
        if (child !== instance) return;
        if (!closed) { circuitUntil = Date.now() + 30000; failAll("memory_reader_exited"); }
        clearWatchdog(); child = null; ready = false; retiring = false; active = null;
      });
      instance.send({ type: "init", database: options.database, config }, error => { if (error && child === instance) openCircuit("memory_reader_ipc_failed", true); });
    } catch { openCircuit("memory_reader_process_failed", true); }
  }
  function pump(): void {
    if (closed || retiring || active || Date.now() < circuitUntil) return;
    const job = queue.shift(); if (!job) return;
    active = job;
    watchdog = setTimeout(() => { if (active === job) openCircuit("memory_reader_hard_timeout", true); }, 1000);
    if (!child) startChild(); else if (ready) sendRead();
  }
  return {
    readOwn(input) {
      if (closed) return Promise.resolve(unavailableMemory(config, "memory_reader_closed"));
      if (retiring || Date.now() < circuitUntil) return Promise.resolve(unavailableMemory(config, "memory_reader_circuit_open"));
      if (![input.memberId, input.projectId, input.bindingGeneration].every(value => typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\0"))) {
        return Promise.resolve(unavailableMemory(config, "memory_binding_unavailable"));
      }
      const key = `${input.projectId}\0${input.memberId}`;
      const previous = jobs.get(key);
      if (previous?.input.bindingGeneration === input.bindingGeneration) return previous.promise;
      if (previous) finish(previous, unavailableMemory(config, "memory_binding_changed"));
      if (queue.length >= 8) return Promise.resolve(unavailableMemory(config, "memory_reader_busy"));
      let resolve!: (value: MemoryInjection) => void;
      const promise = new Promise<MemoryInjection>(done => { resolve = done; });
      const job: Job = { input: { ...input }, key, nonce: randomUUID(), done: false, promise, resolve, deadline: null };
      job.deadline = setTimeout(() => {
        if (active === job) openCircuit("memory_reader_timeout", false);
        else finish(job, unavailableMemory(config, "memory_reader_timeout"));
      }, 500);
      jobs.set(key, job); queue.push(job); pump(); return promise;
    },
    close() {
      if (closing) return closing;
      closed = true; clearWatchdog(); failAll("memory_reader_closed");
      const instance = child;
      if (!instance || instance.exitCode !== null || instance.signalCode !== null) return Promise.resolve();
      retiring = true;
      closing = new Promise<void>((resolve, reject) => {
        const force = setTimeout(() => { instance.kill("SIGKILL"); }, 700);
        const limit = setTimeout(() => { clearTimeout(force); reject(new MemoryError("memory_reader_shutdown_failed", "记忆读取进程未确认退出。", "write_failed")); }, 1500);
        instance.once("exit", () => { clearTimeout(force); clearTimeout(limit); resolve(); });
        instance.kill("SIGTERM");
      });
      return closing;
    },
  };
}

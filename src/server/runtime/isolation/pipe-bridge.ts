import { Duplex } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createEgressBroker } from "./egress.ts";

const CHUNK_BYTES = 16 * 1024;
const MAX_FRAME_BYTES = 96 * 1024;
const MAX_MCP_BYTES = 1024 * 1024;

export interface PipeBridge {
  readonly transport: Transport;
  /** 必须先 await gateway.attach(transport)，再显式启动子CLI。 */
  start(): Promise<void>;
  stopAtSafePoint(): Promise<void>;
  close(): void;
}

/** 有界匿名管道多路复用；egress 与 MCP 是固定通道，不能转为任意 owner HTTP。 */
export function createPipeBridge(child: ChildProcess, options: {
  readonly egressHosts: readonly string[];
  readonly onStdout: (data: Buffer) => void;
  readonly onInvalid: () => void;
}): PipeBridge {
  if (!child.stdin || !child.stdout) throw new Error("launch_failed");
  const input = child.stdin;
  const output = child.stdout;
  const broker = createEgressBroker(options.egressHosts);
  const channels = new Map<number, Duplex>();
  let closed = false;
  let transportStarted = false;
  let launched = false;
  let frameBuffer = Buffer.alloc(0);
  let mcpBuffer = Buffer.alloc(0);
  let writes: Promise<void> = Promise.resolve();

  function writeFrame(value: Record<string, unknown>): Promise<void> {
    if (closed || input.destroyed) return Promise.reject(new Error("transport_closed"));
    const encoded = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(encoded) > MAX_FRAME_BYTES) return Promise.reject(new Error("protocol_invalid"));
    // 保留每个JSONL消息的顺序，重复调用也不交错行。
    const write = writes.then(() => new Promise<void>((resolve, reject) => {
      if (closed || input.destroyed) { reject(new Error("transport_closed")); return; }
      input.write(encoded, error => error ? reject(new Error("transport_closed")) : resolve());
    }));
    writes = write.catch(() => {});
    return write;
  }
  async function dataFrames(kind: string, bytes: Buffer, id?: number): Promise<void> {
    for (let i = 0; i < bytes.length; i += CHUNK_BYTES) await writeFrame({ kind, ...(id === undefined ? {} : { id }), data: bytes.subarray(i, i + CHUNK_BYTES).toString("base64") });
  }
  function invalid(): void {
    if (closed) return;
    options.onInvalid();
    transport.onerror?.(new Error("protocol_invalid"));
    close();
  }
  function close(): void {
    if (closed) return;
    closed = true;
    broker.close();
    for (const channel of channels.values()) channel.destroy();
    channels.clear(); frameBuffer = Buffer.alloc(0); mcpBuffer = Buffer.alloc(0);
    input.end();
    transport.onclose?.();
  }
  function mcpData(bytes: Buffer): void {
    if (!transportStarted) { invalid(); return; }
    let start = 0;
    for (let i = 0; i <= bytes.length; i++) {
      if (i < bytes.length && bytes[i] !== 10) continue;
      const part = bytes.subarray(start, i); start = i + 1;
      if (mcpBuffer.length + part.length > MAX_MCP_BYTES) { invalid(); return; }
      mcpBuffer = Buffer.concat([mcpBuffer, part]);
      if (i === bytes.length) break;
      try {
        const parsed = JSONRPCMessageSchema.safeParse(JSON.parse(mcpBuffer.toString("utf8")));
        mcpBuffer = Buffer.alloc(0);
        if (!parsed.success) { invalid(); return; }
        transport.onmessage?.(parsed.data);
      } catch { invalid(); return; }
    }
  }

  const transport: Transport = {
    async start() { if (transportStarted) throw new Error("transport_already_started"); transportStarted = true; },
    async send(message: JSONRPCMessage) {
      const bytes = Buffer.from(JSON.stringify(message) + "\n");
      if (bytes.length > MAX_MCP_BYTES) throw new Error("mcp_message_too_large");
      await dataFrames("mcp", bytes);
    },
    async close() { close(); },
  };

  function handle(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) { invalid(); return; }
    const frame = value as Record<string, unknown>;
    if (frame.kind === "bridge_ready") return;
    if (frame.kind === "mcp_end") { transport.onclose?.(); mcpBuffer = Buffer.alloc(0); return; }
    if (frame.kind === "egress_open") {
      const id = frame.id;
      if (!Number.isSafeInteger(id) || (id as number) < 1 || channels.has(id as number) || channels.size >= 64) { invalid(); return; }
      const stream = new Duplex({
        read() { output.resume(); },
        write(chunk: Buffer, _encoding, callback) { void dataFrames("egress", chunk, id as number).then(() => callback(), () => callback(new Error("transport_closed"))); },
        final(callback) { void writeFrame({ kind: "egress_end", id }).then(() => callback(), () => callback()); },
        destroy(_error, callback) { channels.delete(id as number); if (!closed) void writeFrame({ kind: "egress_end", id }).catch(() => {}); callback(); },
      });
      channels.set(id as number, stream); broker.attach(stream); return;
    }
    if (frame.kind === "egress_end") { channels.get(frame.id as number)?.push(null); return; }
    if (typeof frame.data !== "string" || frame.data.length > CHUNK_BYTES * 2 || !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data)) { invalid(); return; }
    const bytes = Buffer.from(frame.data, "base64");
    if (bytes.length > CHUNK_BYTES) { invalid(); return; }
    if (frame.kind === "stdout") options.onStdout(bytes);
    else if (frame.kind === "mcp") mcpData(bytes);
    else if (frame.kind === "egress") {
      const stream = channels.get(frame.id as number);
      if (!stream) { invalid(); return; }
      if (!stream.push(bytes)) output.pause();
    } else invalid();
  }

  output.on("data", (bytes: Buffer) => {
    if (closed) return;
    let start = 0;
    for (let i = 0; i <= bytes.length; i++) {
      if (i < bytes.length && bytes[i] !== 10) continue;
      const part = bytes.subarray(start, i); start = i + 1;
      if (frameBuffer.length + part.length > MAX_FRAME_BYTES) { invalid(); return; }
      frameBuffer = Buffer.concat([frameBuffer, part]);
      if (i === bytes.length) break;
      try { const value: unknown = JSON.parse(frameBuffer.toString("utf8")); frameBuffer = Buffer.alloc(0); handle(value); }
      catch { invalid(); return; }
      if (closed) return;
    }
  });
  output.once("end", close);
  input.on("error", close);
  return { transport, async start() {
    if (!transportStarted) throw new Error("mcp_not_attached");
    if (launched) return;
    launched = true; await writeFrame({ kind: "start" });
  }, stopAtSafePoint: () => writeFrame({ kind: "stop" }), close };
}

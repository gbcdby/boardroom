import { createConnection, isIP } from "node:net";
import { lookup } from "node:dns/promises";
import type { Duplex } from "node:stream";

const MAX_HEADER_BYTES = 8192;
const MAX_CONNECTIONS = 64;

export function validEgressHost(host: string): boolean {
  return host.length <= 253 && host === host.toLowerCase() && isIP(host) === 0
    && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)
    && !host.endsWith(".localhost") && !host.endsWith(".local") && !host.endsWith(".internal");
}

/** 代理只建立到公开 IPv4 的 TLS tunnel；不转发 HTTP、DNS、Unix socket 或私网。 */
export function publicIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168
    || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19)
    || a === 192 && b === 0 || a === 192 && b === 0 && c === 2
    || a === 198 && b === 51 && c === 100 || a === 203 && b === 0 && c === 113) return false;
  return true;
}

export interface EgressBroker {
  attach(stream: Duplex): void;
  close(): void;
}

export function createEgressBroker(hosts: readonly string[]): EgressBroker {
  if (hosts.some(h => !validEgressHost(h))) throw new Error("config_invalid");
  const allowed = new Set(hosts);
  const sockets = new Set<Duplex>();
  let closed = false;
  const attach = (socket: Duplex) => {
    if (closed || sockets.size >= MAX_CONNECTIONS) { socket.destroy(); return; }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    const idle = setTimeout(() => socket.destroy(), 300_000);
    idle.unref();
    socket.on("data", () => idle.refresh());
    socket.once("close", () => clearTimeout(idle));
    let header = Buffer.alloc(0);
    let parsing = true;
    const reject = () => { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); };
    const onData = (data: Buffer) => {
      if (!parsing) return;
      // 确定请求头之前限制缓冲区，不保留 payload 全文。
      const combined = Buffer.concat([header, data.subarray(0, MAX_HEADER_BYTES + 1 - header.length)]);
      const end = combined.indexOf("\r\n\r\n");
      if (end < 0) {
        if (combined.length > MAX_HEADER_BYTES) { parsing = false; reject(); }
        else header = combined;
        return;
      }
      parsing = false;
      socket.pause();
      socket.off("data", onData);
      const first = combined.subarray(0, end).toString("ascii").split("\r\n")[0] ?? "";
      const match = /^CONNECT ([a-z0-9.-]+):443 HTTP\/1\.[01]$/.exec(first);
      const host = match?.[1];
      if (!host || !validEgressHost(host) || !allowed.has(host)) { reject(); return; }
      // 请求头之后的 TLS bytes 只在流中转发；不解释、不持久化。
      const consumedFromData = end + 4 - header.length;
      const remainder = data.subarray(Math.max(0, consumedFromData));
      header = Buffer.alloc(0);
      void (async () => {
        try {
          const addresses = await lookup(host, { all: true, family: 4 });
          if (closed || socket.destroyed || !addresses.length || addresses.some(a => !publicIpv4(a.address))) { reject(); return; }
          // 使用已检查的数值地址连接，避免检查后重新解析造成 DNS rebinding。
          const upstream = createConnection({ host: addresses[0]!.address, family: 4, port: 443 });
          sockets.add(upstream);
          upstream.once("close", () => sockets.delete(upstream));
          upstream.on("error", () => { socket.destroy(); upstream.destroy(); });
          upstream.setTimeout(300_000, () => upstream.destroy());
          socket.once("close", () => upstream.destroy());
          upstream.once("close", () => socket.destroy());
          upstream.once("connect", () => {
            socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (remainder.length) upstream.write(remainder);
            socket.pipe(upstream).pipe(socket);
            socket.resume();
          });
        } catch { reject(); }
      })();
    };
    socket.on("data", onData);
  };
  return { attach, close() {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.destroy();
  } };
}

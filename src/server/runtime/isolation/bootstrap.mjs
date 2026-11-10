// 私网内固定 TCP 端口仅转发到父进程的匿名管道；不存在主机网络 fallback。
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const CHUNK = 16 * 1024;
const MAX_FRAME = 96 * 1024;
let mcp;
let child;
let closing = false;
let started = false;
let nextId = 1;
const egress = new Map();
const relays = [];
function frame(value) { return process.stdout.write(JSON.stringify(value) + "\n"); }
function dataFrames(kind, data, id) {
  let flowing = true;
  for (let i = 0; i < data.length; i += CHUNK) flowing = frame({ kind, ...(id === undefined ? {} : { id }), data: data.subarray(i, i + CHUNK).toString("base64") }) && flowing;
  return flowing;
}
function finish(code) {
  if (closing) return;
  closing = true;
  for (const socket of egress.values()) socket.destroy();
  mcp?.destroy();
  for (const relay of relays) relay.close();
  process.stdin.destroy();
  process.exitCode = code;
}

try {
  const plan = JSON.parse(await readFile("/run/boardroom/launch.json", "utf8"));
  const mcpRelay = createServer(socket => {
    if (mcp && !mcp.destroyed) { socket.destroy(); return; }
    mcp = socket;
    socket.on("data", b => { if (!dataFrames("mcp", b)) socket.pause(); });
    socket.on("error", () => socket.destroy());
    socket.once("close", () => { if (mcp === socket) mcp = undefined; frame({ kind: "mcp_end" }); });
  });
  const proxyRelay = createServer(socket => {
    if (egress.size >= 64 || nextId > Number.MAX_SAFE_INTEGER - 1) { socket.destroy(); return; }
    const id = nextId++; egress.set(id, socket); frame({ kind: "egress_open", id });
    socket.on("data", b => { if (!dataFrames("egress", b, id)) socket.pause(); });
    socket.on("error", () => socket.destroy());
    socket.once("close", () => { egress.delete(id); frame({ kind: "egress_end", id }); });
  });
  relays.push(mcpRelay, proxyRelay);
  await Promise.all([[mcpRelay, 47631], [proxyRelay, 47632]].map(([server, port]) => new Promise((resolve, reject) => {
    server.once("error", reject); server.listen(port, "127.0.0.1", resolve);
  })));
  process.stdout.on("drain", () => { mcp?.resume(); child?.stdout?.resume(); for (const socket of egress.values()) socket.resume(); });
  function launch() {
    if (started || closing) return;
    started = true;
    const proxy = "http://127.0.0.1:47632";
    child = spawn("/opt/boardroom/host", plan.argv, {
      cwd: plan.workdir, shell: false,
      env: { PATH: "/usr/bin:/bin", HOME: "/home/runner", LANG: "C.UTF-8", TERM: "dumb",
        HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, NO_PROXY: "", no_proxy: "",
        CLAUDE_CONFIG_DIR: "/home/runner/.claude", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    child.stdin.on("error", () => {}); child.stdin.end(plan.prompt);
    child.stdout.on("data", b => { if (!dataFrames("stdout", b)) child.stdout.pause(); });
    child.once("error", () => finish(78)); child.once("close", code => finish(code ?? 1));
  }
  let pending = Buffer.alloc(0);
  process.stdin.on("data", data => {
    let start = 0;
    for (let i = 0; i <= data.length; i++) {
      if (i < data.length && data[i] !== 10) continue;
      const part = data.subarray(start, i);
      if (pending.length + part.length > MAX_FRAME) { finish(78); return; }
      pending = Buffer.concat([pending, part]); start = i + 1;
      if (i === data.length) break;
      try {
        const value = JSON.parse(pending.toString("utf8")); pending = Buffer.alloc(0);
        if (value.kind === "start") { launch(); continue; }
        if (value.kind === "stop") {
          if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
          else finish(0);
          continue;
        }
        if (value.kind === "mcp_end") { mcp?.end(); continue; }
        if (value.kind === "egress_end") { egress.get(value.id)?.end(); continue; }
        if (typeof value.data !== "string" || value.data.length > CHUNK * 2 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) { finish(78); return; }
        const bytes = Buffer.from(value.data, "base64");
        const target = value.kind === "mcp" ? mcp : value.kind === "egress" ? egress.get(value.id) : undefined;
        if (target) { if (!target.write(bytes)) { process.stdin.pause(); target.once("drain", () => process.stdin.resume()); } }
        else if (value.kind === "mcp" || value.kind === "egress") { /* 已关闭通道的迟到响应丢弃 */ }
        else { finish(78); return; }
      } catch { finish(78); return; }
    }
  });
  process.stdin.once("end", () => { child?.kill("SIGTERM"); finish(1); });
  process.stdin.on("error", () => finish(1));
  process.stdout.on("error", () => { child?.kill("SIGTERM"); finish(1); });
  process.once("SIGTERM", () => { if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); else finish(0); });
  frame({ kind: "bridge_ready" });
} catch { process.stderr.write("launch_failed\n"); finish(78); }

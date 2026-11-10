// 只连接私有 network namespace 中的固定 MCP 端口，不接触父端管理网络或数据库。
import { createConnection } from "node:net";
const socket = createConnection({ host: "127.0.0.1", port: 47631 });
socket.on("error", () => { process.exitCode = 1; process.stdin.destroy(); socket.destroy(); });
process.stdin.on("error", () => socket.destroy());
process.stdout.on("error", () => socket.destroy());
socket.once("connect", () => process.stdin.pipe(socket).pipe(process.stdout));
socket.once("close", () => { process.stdin.destroy(); process.exitCode ??= 0; });

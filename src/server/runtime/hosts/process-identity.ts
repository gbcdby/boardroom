import type { ChildProcess } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { OwnedProcessIdentity, OwnedProcessInspection } from "./types.ts";

const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PID_NS = /^pid:\[[0-9]{1,24}\]$/;
const TICKS = /^[0-9]{1,24}$/;

async function bootId(): Promise<string> {
  const id = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim().toLowerCase();
  if (!BOOT_ID.test(id)) throw new Error("read_unavailable");
  return id;
}

async function pidNamespace(): Promise<string> {
  const value = await readlink("/proc/self/ns/pid");
  if (!PID_NS.test(value)) throw new Error("read_unavailable");
  return value;
}

async function processStartTicks(pid: number): Promise<string> {
  // comm 字段可以包含空格和右括号；从最后一个 ') ' 后才开始拆实际字段。
  const raw = await readFile(`/proc/${pid}/stat`, "utf8");
  if (raw.length > 8192) throw new Error("read_unavailable");
  const end = raw.lastIndexOf(") ");
  if (end < 0) throw new Error("read_unavailable");
  const field = raw.slice(end + 2).trim().split(/\s+/)[19]; // 后半部分从 field 3 开始，starttime 是 field 22。
  if (field === undefined || !TICKS.test(field)) throw new Error("read_unavailable");
  return field;
}

/**
 * 只能对本次spawn取得的真实ChildProcess调用；不接受数据库PID冒充当前所有权。
 * 身份用于跨重启的只读判断，不授予任何kill权限。
 */
export async function captureOwnedProcessIdentity(child: ChildProcess): Promise<OwnedProcessIdentity | undefined> {
  if (process.platform !== "linux" || !child.pid || child.exitCode !== null || child.signalCode !== null) return undefined;
  const prefix = ["/usr/bin/unshare", "--user", "--map-root-user", "--net", "--fork", "--kill-child=SIGKILL", "/usr/bin/python3",
    fileURLToPath(new URL("../isolation/network-init.py", import.meta.url)), "/usr/bin/bwrap", "--unshare-user", "--uid", "1000", "--gid", "1000", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv"];
  if (child.spawnfile !== prefix[0] || prefix.some((part, i) => child.spawnargs[i] !== part)) return undefined;
  try {
    const [kernelBootId, namespace, startTicks, childNamespace] = await Promise.all([
      bootId(), pidNamespace(), processStartTicks(child.pid), readlink(`/proc/${child.pid}/ns/pid`),
    ]);
    if (namespace !== childNamespace || child.exitCode !== null || child.signalCode !== null) return undefined;
    return { version: 1, launcherProtocol: "linux-private-net-v1", pid: child.pid, kernelBootId, pidNamespace: namespace, startTicks };
  } catch { return undefined; }
}

/**
 * 只读核验旧wrapper。wrapper退出→其隔离树退出的依据限定为本版本launcher的
 * unshare --kill-child + bwrap私有PID namespace/PDEATHSIG协议和真实树回收用例。
 * 不适用于外部CLI，也不等于任务成功、消息ACK或外部效果回滚。
 */
export async function inspectOwnedProcess(identity: OwnedProcessIdentity): Promise<OwnedProcessInspection> {
  const result = (status: OwnedProcessInspection["status"], reason: OwnedProcessInspection["reason"]): OwnedProcessInspection => ({ status, reason, inspectedAt: new Date().toISOString() });
  if (!identity || identity.version !== 1 || identity.launcherProtocol !== "linux-private-net-v1"
    || !Number.isSafeInteger(identity.pid) || identity.pid < 1 || !BOOT_ID.test(identity.kernelBootId)
    || !PID_NS.test(identity.pidNamespace) || !TICKS.test(identity.startTicks)) return result("unknown", "identity_invalid");
  if (process.platform !== "linux") return result("unknown", "read_unavailable");
  let currentBoot: string;
  let currentNamespace: string;
  try { currentBoot = await bootId(); }
  catch { return result("unknown", "read_unavailable"); }
  if (currentBoot !== identity.kernelBootId) return result("wrapper_exited", "boot_changed");
  try { currentNamespace = await pidNamespace(); }
  catch { return result("unknown", "namespace_unknown"); }
  if (currentNamespace !== identity.pidNamespace) return result("unknown", "namespace_unknown");
  try {
    const currentTicks = await processStartTicks(identity.pid);
    if (currentTicks !== identity.startTicks) return result("wrapper_exited", "start_ticks_changed");
    return result("observed_alive", "identity_matches");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT" || (error as NodeJS.ErrnoException)?.code === "ESRCH") return result("wrapper_exited", "process_absent");
    return result("unknown", "read_unavailable");
  }
}

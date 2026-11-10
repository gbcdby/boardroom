import path from "node:path";
import { fileURLToPath } from "node:url";
import { access, chmod, lstat, mkdir, mkdtemp, open, realpath, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_ROOTS = ["/usr", "/bin", "/lib", "/lib64"];

export interface LinuxIsolationInput {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly prompt: string;
  readonly workdir: string;
  readonly stateRoot: string;
  readonly bindingId: string;
  readonly mcpSocketPath?: string;
  readonly protectedPaths: readonly string[];
  readonly egressHosts: readonly string[];
  readonly credentialMounts?: readonly { readonly source: string; readonly destination: string }[];
}

export interface PreparedLinuxIsolation {
  readonly command: string;
  readonly args: readonly string[];
  /** 传递固定目录 inode，避免 realpath 检查和 bwrap 挂载之间被换成其他目录。 */
  readonly inheritedFds: readonly number[];
  cleanup(): Promise<void>;
}

export function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`) || a === path.sep || b === path.sep;
}

export async function validateWorkdir(workdir: string, protectedPaths: readonly string[]): Promise<string> {
  if (!path.isAbsolute(workdir) || workdir.includes("\0") || workdir.length > 4096) throw new Error("workdir_invalid");
  let canonical: string;
  try { canonical = await realpath(workdir); if (!(await stat(canonical)).isDirectory()) throw new Error(); }
  catch { throw new Error("workdir_invalid"); }
  for (const protectedPath of protectedPaths) {
    const protectedReal = await realpath(protectedPath).catch(() => path.resolve(protectedPath));
    if (pathsOverlap(canonical, protectedReal)) throw new Error("protected_path_overlap");
  }
  // 不允许把宿主 /、/etc、/home 等宽目录作为工作根。
  if (["/", "/etc", "/proc", "/sys", "/dev", "/run", "/home", "/root", "/tmp", ...SYSTEM_ROOTS].some(p => canonical === p || SYSTEM_ROOTS.includes(p) && canonical.startsWith(`${p}/`))) {
    throw new Error("workdir_invalid");
  }
  return canonical;
}

export async function linuxIsolationAvailable(): Promise<boolean> {
  if (process.platform !== "linux") return false;
  try {
    await Promise.all(["/usr/bin/unshare", "/usr/bin/bwrap", "/usr/bin/python3"].map(p => access(p, constants.X_OK)));
    // 只验证原语可建立；这不是 CLI host/version 的支持声明。
    return await new Promise<boolean>(resolve => {
      const child = spawn("/usr/bin/unshare", ["--user", "--map-root-user", "--net", "--fork", "/usr/bin/python3", path.join(HERE, "network-init.py"),
        "/usr/bin/bwrap", "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
        "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin", "--ro-bind", "/lib", "/lib", "--ro-bind-try", "/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev", "/bin/true"],
      { shell: false, stdio: "ignore", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } });
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(false); }, 5000);
      child.once("error", () => { clearTimeout(timer); resolve(false); });
      child.once("exit", code => { clearTimeout(timer); resolve(code === 0); });
    });
  } catch { return false; }
}

/**
 * Linux 执行边界：私有 network namespace、最小 mount view、仅固定 socket 通路。
 * 调用方仍必须先经过真实 CLI profile 门控；此函数本身不能将任何 CLI 标为 supported。
 */
export async function prepareLinuxIsolation(input: LinuxIsolationInput): Promise<PreparedLinuxIsolation> {
  if (process.platform !== "linux") throw new Error("isolation_unavailable");
  const handles: FileHandle[] = [];
  let runDir: string | undefined;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await Promise.all(handles.map(h => h.close().catch(() => {})));
    if (runDir) await rm(runDir, { recursive: true, force: true });
  };
  try {
    if (!path.isAbsolute(input.stateRoot) || !path.isAbsolute(input.executable)) throw new Error("config_invalid");
    const workdir = await validateWorkdir(input.workdir, [...input.protectedPaths, input.stateRoot, input.executable, HERE, ...(input.credentialMounts ?? []).map(m => m.source)]);
    for (const protectedPath of input.protectedPaths) {
      const protectedReal = await realpath(protectedPath).catch(() => path.resolve(protectedPath));
      if (SYSTEM_ROOTS.some(root => protectedReal === root || protectedReal.startsWith(`${root}/`))) throw new Error("protected_path_overlap");
    }
    await mkdir(input.stateRoot, { recursive: true, mode: 0o700 });
    const stateRoot = await realpath(input.stateRoot);
    if (pathsOverlap(workdir, stateRoot)) throw new Error("protected_path_overlap");
    await chmod(stateRoot, 0o700);
    runDir = await mkdtemp(path.join(stateRoot, "launch-"));
    const sessionKey = createHash("sha256").update(input.bindingId).digest("hex").slice(0, 32);
    const sessionsRoot = path.join(stateRoot, "sessions");
    await mkdir(sessionsRoot, { mode: 0o700, recursive: true });
    if ((await lstat(sessionsRoot)).isSymbolicLink()) throw new Error("config_invalid");
    const sessionDir = path.join(sessionsRoot, sessionKey);
    await mkdir(sessionDir, { mode: 0o700 }).catch(e => { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; });
    if ((await lstat(sessionDir)).isSymbolicLink()) throw new Error("config_invalid");

    const bwrap = ["--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv"];
    for (const root of SYSTEM_ROOTS) {
      try { await access(root); bwrap.push("--ro-bind", root, root); } catch { /* libc 目录按主机存在性 */ }
    }
    bwrap.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/run", "--dir", "/run/boardroom", "--dir", "/home", "--dir", "/home/runner", "--dir", "/opt", "--dir", "/opt/boardroom");
    try { await access("/etc/ssl/certs"); bwrap.push("--ro-bind", "/etc/ssl/certs", "/etc/ssl/certs"); } catch { /* TLS 在无信任根主机失败关闭 */ }
    const pin = async (source: string, destination: string, writable: boolean, directory = false) => {
      const sourceReal = source === workdir ? workdir : await realpath(source);
      const handle = await open(sourceReal, constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0));
      handles.push(handle);
      const actual = await realpath(`/proc/self/fd/${handle.fd}`);
      if (actual !== sourceReal) throw new Error("config_invalid");
      bwrap.push(writable ? "--bind-fd" : "--ro-bind-fd", String(handles.length + 2), destination);
    };
    await pin(workdir, workdir, true, true);
    await pin(sessionDir, "/home/runner/.claude", true, true);
    await pin(input.executable, "/opt/boardroom/host", false);
    await pin(process.execPath, "/opt/boardroom/node", false);
    await pin(path.join(HERE, "bootstrap.mjs"), "/opt/boardroom/bootstrap.mjs", false);
    await pin(path.join(HERE, "stdio-bridge.mjs"), "/opt/boardroom/stdio-bridge.mjs", false);

    for (const mount of input.credentialMounts ?? []) {
      if (mount.destination !== "/home/runner/.claude/.credentials.json") throw new Error("config_invalid");
      if (!(await stat(mount.source)).isFile()) throw new Error("login_required");
      await pin(mount.source, mount.destination, false);
    }
    // 管理策略若存在必须保留，不用隔离目录规避企业策略。
    try { await access("/etc/claude-code"); bwrap.push("--ro-bind", "/etc/claude-code", "/etc/claude-code"); } catch { /* 主机没有管理策略 */ }
    await writeFile(path.join(runDir, "launch.json"), JSON.stringify({ argv: input.argv, prompt: input.prompt, workdir }), { mode: 0o600 });
    await writeFile(path.join(runDir, "mcp.json"), JSON.stringify({ mcpServers: { boardroom: { command: "/opt/boardroom/node", args: ["/opt/boardroom/stdio-bridge.mjs"] } } }), { mode: 0o600 });
    await writeFile(path.join(runDir, "settings.json"), JSON.stringify({ disableAllHooks: true, enableAllProjectMcpServers: false }), { mode: 0o600 });
    for (const filename of ["launch.json", "mcp.json", "settings.json"]) await pin(path.join(runDir, filename), `/run/boardroom/${filename}`, false);
    bwrap.push("--chdir", workdir, "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/home/runner", "--setenv", "LANG", "C.UTF-8",
      "/opt/boardroom/node", "/opt/boardroom/bootstrap.mjs");
    return { command: "/usr/bin/unshare", args: ["--user", "--map-root-user", "--net", "--fork", "--kill-child=SIGKILL", "/usr/bin/python3", path.join(HERE, "network-init.py"), "/usr/bin/bwrap", ...bwrap], inheritedFds: handles.map(h => h.fd), cleanup };
  } catch (error) {
    await cleanup();
    const reason = error instanceof Error && ["config_invalid", "workdir_invalid", "protected_path_overlap", "login_required"].includes(error.message) ? error.message : "isolation_unavailable";
    throw new Error(reason);
  }
}

/** 专用于受管 launcher 和无模型 canary；只使用持有的 ChildProcess，不查 PID 表。 */
export function spawnIsolatedProcess(prepared: PreparedLinuxIsolation): ChildProcess {
  return spawn(prepared.command, [...prepared.args], { shell: false, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    stdio: ["pipe", "pipe", "pipe", ...prepared.inheritedFds] });
}

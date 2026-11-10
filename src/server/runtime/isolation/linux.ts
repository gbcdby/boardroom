import path from "node:path";
import { fileURLToPath } from "node:url";
import { access, chmod, lstat, mkdir, mkdtemp, open, realpath, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createWritableFilesystemBoundary, verifyExpectedDirectoryLocation, type WritableFilesystemBoundary } from "./filesystem-boundary.ts";

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
  /** gateway 接好后、发送 CLI start 之前必须 await；失败时不能放行 CLI。 */
  verifyWritableBoundary(): Promise<void>;
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

/** preflight 的提前诊断；实际启动仍须扫描传给 bwrap 的同批 FD。 */
export async function validateWorkdirFilesystemBoundary(canonicalWorkdir: string, protectedPaths: readonly string[]): Promise<void> {
  let handle: FileHandle | undefined;
  let boundary: WritableFilesystemBoundary | undefined;
  try {
    handle = await open(canonicalWorkdir, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    boundary = await createWritableFilesystemBoundary([{ handle, protectedPaths }]);
  } catch { throw new Error("workdir_unsafe"); }
  finally { await boundary?.close(); await handle?.close().catch(() => {}); }
}

/** 仅对应已核对 --bind-fd 挂载后 inode 复核的受信系统安装，不自动放行未知版本。 */
export function verifiedBubblewrapVersion(output: string): boolean {
  return output === "bubblewrap 0.12.0" || output === "bubblewrap 0.12.0\n";
}

async function verifiedBubblewrapInstalled(): Promise<boolean> {
  try {
    const version = await new Promise<string>((resolve, reject) => {
      execFile("/usr/bin/bwrap", ["--version"], { encoding: "utf8", timeout: 5000, maxBuffer: 1024,
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } }, (error, stdout) => error ? reject(error) : resolve(stdout));
    });
    return verifiedBubblewrapVersion(version);
  } catch { return false; }
}

export async function linuxIsolationAvailable(): Promise<boolean> {
  if (process.platform !== "linux") return false;
  try {
    await Promise.all(["/usr/bin/unshare", "/usr/bin/bwrap", "/usr/bin/python3"].map(p => access(p, constants.X_OK)));
    if (!await verifiedBubblewrapInstalled()) return false;
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
  if (process.platform !== "linux" || !await verifiedBubblewrapInstalled()) throw new Error("isolation_unavailable");
  const handles: FileHandle[] = [];
  // stateRoot/保护路径的元数据 FD 不得继承给 child。
  const inheritedHandles: FileHandle[] = [];
  let boundary: WritableFilesystemBoundary | undefined;
  let runDir: string | undefined;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await boundary?.close();
    await Promise.all(handles.map(h => h.close().catch(() => {})));
    if (runDir) await rm(runDir, { recursive: true, force: true });
  };
  try {
    if (!path.isAbsolute(input.stateRoot) || !path.isAbsolute(input.executable)) throw new Error("config_invalid");
    const protectedPaths = [...input.protectedPaths, input.stateRoot, input.executable, HERE, ...(input.credentialMounts ?? []).map(m => m.source)];
    const workdir = await validateWorkdir(input.workdir, protectedPaths);
    for (const protectedPath of input.protectedPaths) {
      const protectedReal = await realpath(protectedPath).catch(() => path.resolve(protectedPath));
      if (SYSTEM_ROOTS.some(root => protectedReal === root || protectedReal.startsWith(`${root}/`))) throw new Error("protected_path_overlap");
    }
    await mkdir(input.stateRoot, { recursive: true, mode: 0o700 });
    const stateRoot = await realpath(input.stateRoot);
    if (pathsOverlap(workdir, stateRoot)) throw new Error("protected_path_overlap");
    await chmod(stateRoot, 0o700);
    const stateHandle = await open(stateRoot, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY); handles.push(stateHandle);
    runDir = await mkdtemp(path.join(stateRoot, "launch-"));
    const sessionKey = createHash("sha256").update(input.bindingId).digest("hex").slice(0, 32);
    const sessionsPath = `/proc/self/fd/${stateHandle.fd}/sessions`;
    await mkdir(sessionsPath, { mode: 0o700 }).catch(e => { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; });
    if ((await lstat(sessionsPath)).isSymbolicLink()) throw new Error("config_invalid");
    const sessionsHandle = await open(sessionsPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY); handles.push(sessionsHandle);
    await verifyExpectedDirectoryLocation(sessionsHandle, stateHandle, "sessions");
    const sessionPath = `/proc/self/fd/${sessionsHandle.fd}/${sessionKey}`;
    await mkdir(sessionPath, { mode: 0o700 }).catch(e => { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; });
    if ((await lstat(sessionPath)).isSymbolicLink()) throw new Error("config_invalid");
    const sessionHandle = await open(sessionPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY); handles.push(sessionHandle);
    await verifyExpectedDirectoryLocation(sessionHandle, stateHandle, `sessions/${sessionKey}`);

    const bwrap = ["--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv"];
    for (const root of SYSTEM_ROOTS) {
      try { await access(root); bwrap.push("--ro-bind", root, root); } catch { /* libc 目录按主机存在性 */ }
    }
    bwrap.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/run", "--dir", "/run/boardroom", "--dir", "/home", "--dir", "/home/runner", "--dir", "/opt", "--dir", "/opt/boardroom");
    try { await access("/etc/ssl/certs"); bwrap.push("--ro-bind", "/etc/ssl/certs", "/etc/ssl/certs"); } catch { /* TLS 在无信任根主机失败关闭 */ }
    const bindPinned = (handle: FileHandle, destination: string, writable: boolean) => {
      inheritedHandles.push(handle);
      bwrap.push(writable ? "--bind-fd" : "--ro-bind-fd", String(inheritedHandles.length + 2), destination);
    };
    const pin = async (source: string, destination: string, writable: boolean, directory = false) => {
      const sourceReal = source === workdir ? workdir : await realpath(source);
      const handle = await open(sourceReal, constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0));
      handles.push(handle);
      const actual = await realpath(`/proc/self/fd/${handle.fd}`);
      if (actual !== sourceReal) throw new Error("config_invalid");
      bindPinned(handle, destination, writable);
      return handle;
    };
    const workHandle = await pin(workdir, workdir, true, true);
    bindPinned(sessionHandle, "/home/runner/.claude", true);
    await pin(input.executable, "/opt/boardroom/host", false);
    await pin(process.execPath, "/opt/boardroom/node", false);
    await pin(path.join(HERE, "bootstrap.mjs"), "/opt/boardroom/bootstrap.mjs", false);
    await pin(path.join(HERE, "stdio-bridge.mjs"), "/opt/boardroom/stdio-bridge.mjs", false);

    for (const mount of input.credentialMounts ?? []) {
      if (mount.destination !== "/home/runner/.claude/.credentials.json") throw new Error("config_invalid");
      if (!(await stat(mount.source)).isFile()) throw new Error("login_required");
      await pin(mount.source, mount.destination, false);
      // bwrap 本来也会创建缺失的挂载点；提前经同一根 FD 完成，避免和最终扫描竞态。
      // EEXIST 时不打开或改动现有对象，硬链接等仍由下方完整扫描拒绝。
      try {
        const mountpoint = await open(`/proc/self/fd/${sessionHandle.fd}/.credentials.json`, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600);
        await mountpoint.close();
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("workdir_unsafe"); }
    }
    // 管理策略若存在必须保留，不用隔离目录规避企业策略。
    try { await access("/etc/claude-code"); bwrap.push("--ro-bind", "/etc/claude-code", "/etc/claude-code"); } catch { /* 主机没有管理策略 */ }
    await writeFile(path.join(runDir, "launch.json"), JSON.stringify({ argv: input.argv, prompt: input.prompt, workdir }), { mode: 0o600 });
    await writeFile(path.join(runDir, "mcp.json"), JSON.stringify({ mcpServers: { boardroom: { command: "/opt/boardroom/node", args: ["/opt/boardroom/stdio-bridge.mjs"] } } }), { mode: 0o600 });
    await writeFile(path.join(runDir, "settings.json"), JSON.stringify({ disableAllHooks: true, enableAllProjectMcpServers: false }), { mode: 0o600 });
    for (const filename of ["launch.json", "mcp.json", "settings.json"]) await pin(path.join(runDir, filename), `/run/boardroom/${filename}`, false);
    bwrap.push("--chdir", workdir, "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/home/runner", "--setenv", "LANG", "C.UTF-8",
      "/opt/boardroom/node", "/opt/boardroom/bootstrap.mjs");
    boundary = await createWritableFilesystemBoundary([{ handle: workHandle, protectedPaths },
      { handle: sessionHandle, parent: stateHandle, relativePath: `sessions/${sessionKey}` }]);
    return { command: "/usr/bin/unshare", args: ["--user", "--map-root-user", "--net", "--fork", "--kill-child=SIGKILL", "/usr/bin/python3", path.join(HERE, "network-init.py"), "/usr/bin/bwrap", ...bwrap],
      inheritedFds: inheritedHandles.map(h => h.fd), verifyWritableBoundary: () => boundary!.verify(), cleanup };
  } catch (error) {
    await cleanup();
    const reason = error instanceof Error && ["config_invalid", "workdir_invalid", "workdir_unsafe", "protected_path_overlap", "login_required"].includes(error.message) ? error.message : "isolation_unavailable";
    throw new Error(reason);
  }
}

/** 专用于受管 launcher 和无模型 canary；只使用持有的 ChildProcess，不查 PID 表。 */
export function spawnIsolatedProcess(prepared: PreparedLinuxIsolation): ChildProcess {
  return spawn(prepared.command, [...prepared.args], { shell: false, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    stdio: ["pipe", "pipe", "pipe", ...prepared.inheritedFds] });
}

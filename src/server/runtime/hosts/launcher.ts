import path from "node:path";
import { access, realpath } from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { bootstrapPrompt, buildHostArguments, expectedPermissionMode, parseHostVersion } from "./adapters.ts";
import { createHostOutputParser } from "./parser.ts";
import { VERIFIED_HOST_PROFILES, type HostInstallation, type HostLaunchSnapshot, type HostLauncher, type HostPreflight, type HostReason, type ManagedBackend, type ResolvedHostInstallation, type VerifiedHostProfile } from "./types.ts";
import { linuxIsolationAvailable, prepareLinuxIsolation, spawnIsolatedProcess, validateWorkdir, validateWorkdirFilesystemBoundary } from "../isolation/linux.ts";
import { createPipeBridge } from "../isolation/pipe-bridge.ts";
import { captureOwnedProcessIdentity, inspectOwnedProcess } from "./process-identity.ts";
import { findNativeInstallation, resolveNativeInstallation } from "./native-installation.ts";

export interface HostLauncherOptions {
  readonly stateRoot: string;
  /** 至少包含服务源码、DB/dataDir、配置文件与其他管理数据路径。 */
  readonly protectedPaths: readonly string[];
  /** 只允许服务端配置受信二进制位置。认证/出口由已验收profile解析，不能从这里覆盖。 */
  readonly installations?: readonly HostInstallation[];
}

const BACKENDS = new Set<ManagedBackend>(["claude-code", "codex-cli", "dsh"]);

export function createHostLauncher(options: HostLauncherOptions): HostLauncher {
  const installations = new Map((options.installations ?? []).map(item => [item.backend, item]));
  if (!path.isAbsolute(options.stateRoot) || options.protectedPaths.length === 0 || options.protectedPaths.some(p => !path.isAbsolute(p))) throw new Error("config_invalid");

  async function installationFor(backend: ManagedBackend): Promise<HostInstallation | undefined> {
    const configured = installations.get(backend);
    if (configured) return configured;
    return await findNativeInstallation(backend);
  }

  function valid(snapshot: HostLaunchSnapshot): boolean {
    return BACKENDS.has(snapshot.backend) && [snapshot.bindingId, snapshot.ownerId].every(v => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(v))
      && Number.isSafeInteger(snapshot.generation) && snapshot.generation >= 1 && Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 1
      && typeof snapshot.config.workdir === "string" && typeof snapshot.config.bypass === "boolean"
      && typeof snapshot.config.permissionMode === "string" && snapshot.config.permissionMode.length <= 64
      && (snapshot.config.model === undefined || typeof snapshot.config.model === "string" && snapshot.config.model.length <= 200 && !snapshot.config.model.includes("\0"))
      && (snapshot.config.systemPrompt === undefined || typeof snapshot.config.systemPrompt === "string" && Buffer.byteLength(snapshot.config.systemPrompt) <= 32_768 && !snapshot.config.systemPrompt.includes("\0"))
      && (snapshot.sessionId === undefined || /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/.test(snapshot.sessionId));
  }

  async function inspect(snapshot: HostLaunchSnapshot): Promise<{ result: HostPreflight; installation?: ResolvedHostInstallation; profile?: VerifiedHostProfile }> {
    const expected = expectedPermissionMode(snapshot);
    const denied = (reason: HostReason, hostVersion?: string, isolation: HostPreflight["isolation"] = "unverified") => ({
      result: { supported: false, reason, expectedPermissionMode: expected, isolation, ...(hostVersion ? { hostVersion } : {}) },
    });
    if (!valid(snapshot)) return denied("config_invalid");
    try {
      const canonical = await validateWorkdir(snapshot.config.workdir, [...options.protectedPaths, options.stateRoot]);
      if (process.platform === "linux") await validateWorkdirFilesystemBoundary(canonical, [...options.protectedPaths, options.stateRoot]);
    } catch (error) {
      const reason = error instanceof Error && ["protected_path_overlap", "workdir_unsafe"].includes(error.message)
        ? error.message as HostReason : "workdir_invalid";
      return denied(reason);
    }
    const installation = await installationFor(snapshot.backend);
    if (!installation || !path.isAbsolute(installation.executable)) return denied("host_not_installed");
    let version: string | undefined;
    let executable: string;
    try {
      executable = await realpath(installation.executable);
      await access(executable, constants.X_OK);
      const output = await new Promise<string>((resolve, reject) => execFile(executable, ["--version"],
        { timeout: 5000, maxBuffer: 4096, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, encoding: "utf8" }, (error, stdout) => error ? reject(new Error("host_version_unknown")) : resolve(stdout)));
      version = parseHostVersion(snapshot.backend, output);
    } catch { return denied("host_version_unknown"); }
    if (!version) return denied("host_version_unknown");
    const profile = VERIFIED_HOST_PROFILES.find(p => p.backend === snapshot.backend && p.version === version
      && p.platform === process.platform && p.architecture === process.arch && p.mode === expected);
    // 没有真实证据时不启动 CLI、检查登录或尝试更宽松模式。
    if (!profile) return denied("host_version_unsupported", version);
    if (snapshot.sessionId && !profile.resumeVerified) return denied("profile_unsupported", version);
    try { buildHostArguments(snapshot); } catch { return denied("profile_unsupported", version); }
    try { if (await sha256(executable) !== profile.executableSha256) return denied("host_version_unsupported", version); }
    catch { return denied("host_version_unknown", version); }
    if (!await linuxIsolationAvailable()) return denied("isolation_unavailable", version, "unavailable");
    let resolved: ResolvedHostInstallation;
    try { resolved = await resolveNativeInstallation({ backend: installation.backend, executable }, profile); }
    catch (error) {
      const reason = error instanceof Error && ["profile_unsupported", "config_invalid", "login_required"].includes(error.message)
        ? error.message as HostReason : "login_required";
      return denied(reason, version);
    }
    return { result: { supported: true, reason: "supported", hostVersion: version, expectedPermissionMode: expected, isolation: "verified" },
      installation: resolved, profile };
  }

  return {
    async preflight(snapshot) { return (await inspect(snapshot)).result; },
    inspectPrevious: inspectOwnedProcess,
    async launch(snapshot, observer) {
      const checked = await inspect(snapshot);
      if (!checked.result.supported || !checked.installation || !checked.profile || !checked.result.hostVersion) throw new Error(checked.result.reason);
      if (!observer.onMcpTransport) throw new Error("profile_unsupported");
      const prepared = await prepareLinuxIsolation({
        executable: checked.installation.executable, argv: buildHostArguments(snapshot), prompt: bootstrapPrompt(snapshot),
        workdir: snapshot.config.workdir, stateRoot: options.stateRoot, bindingId: snapshot.bindingId,
        protectedPaths: options.protectedPaths, egressHosts: checked.installation.egressHosts,
        credentialMounts: checked.installation.credentialMounts,
      });
      let child;
      try { child = spawnIsolatedProcess(prepared); }
      catch { await prepared.cleanup(); throw new Error("launch_failed"); }
      let alive = true;
      let ready = false;
      let failureObserved = false;
      const emit: typeof observer.onEvent = event => { try { observer.onEvent(event); } catch { /* 观察者故障不泄漏原始输出 */ } };
      const parser = createHostOutputParser({ backend: snapshot.backend, version: checked.result.hostVersion,
        expectedPermissionMode: checked.result.expectedPermissionMode,
        ...(checked.profile.usageSchema ? { usageSchema: checked.profile.usageSchema } : {}),
        onEvent(event) {
          if (event.type === "ready") ready = true;
          if (event.type === "failure") failureObserved = true;
          emit(event);
        },
      });
      const bridge = createPipeBridge(child, { egressHosts: checked.installation.egressHosts,
        onStdout: chunk => parser.push(chunk), onInvalid: () => emit({ type: "protocol_invalid", reason: "invalid_schema" }) });
      // stderr 含 CLI 原始文本；只排空，不记录、不嵌入 Error.message。
      child.stderr?.on("data", () => {});
      child.once("error", () => emit({ type: "failure", reason: "launch_failed" }));
      const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => {
        child.once("close", (code, signal) => {
          alive = false;
          bridge.close();
          parser.end();
          if (code !== 0 && !ready && !failureObserved) emit({ type: "failure", reason: snapshot.sessionId ? "resume_failed" : "launch_failed" });
          void prepared.cleanup().finally(() => { emit({ type: "exit", code, signal }); resolve({ code, signal }); });
        });
      });
      const stop = (signal: "SIGTERM" | "SIGKILL") => { if (alive && child.exitCode === null && child.signalCode === null) child.kill(signal); };
      const processIdentity = await captureOwnedProcessIdentity(child);
      try {
        await observer.onMcpTransport(bridge.transport);
        await prepared.verifyWritableBoundary();
        await bridge.start();
      } catch (error) {
        stop("SIGKILL"); await exited;
        throw new Error(error instanceof Error && error.message === "workdir_unsafe" ? "workdir_unsafe" : "launch_failed");
      }
      return { ...(child.pid ? { pid: child.pid } : {}), ...(processIdentity ? { processIdentity } : {}), exited,
        stopAtSafePoint: () => { if (alive) void bridge.stopAtSafePoint().catch(() => emit({ type: "failure", reason: "launch_failed" })); },
        forceStopOwned: () => stop("SIGKILL") };
    },
  };
}

async function sha256(filename: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

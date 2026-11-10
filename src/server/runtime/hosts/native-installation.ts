import path from "node:path";
import { homedir } from "node:os";
import { access, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import type { HostInstallation, ManagedBackend, ResolvedHostInstallation, VerifiedHostProfile } from "./types.ts";

const CREDENTIAL_DESTINATION = "/home/runner/.claude/.credentials.json";
// 官方文档的模型请求、账户认证与OAuth refresh域名。策略仍须逐版本真实验收；
// 不放行浏览器登录、插件、任意WebFetch或由环境变量指定的网关。
// https://code.claude.com/docs/en/network-config#network-access-requirements
const ANTHROPIC_API_OAUTH_HOSTS = Object.freeze(["api.anthropic.com", "claude.ai", "platform.claude.com"]);

/** 固定安装位置；不搜索服务端PATH，也不执行shell wrapper。home仅供受信装配/合成测试。 */
export function nativeExecutableCandidates(backend: ManagedBackend, home = homedir()): readonly string[] {
  const executableName = backend === "claude-code" ? "claude" : backend === "codex-cli" ? "codex" : "dsh";
  return [`/usr/local/bin/${executableName}`, `/usr/bin/${executableName}`, path.join(home, ".local", "bin", executableName),
    ...(backend === "codex-cli" ? ["/opt/codex/bin/codex"] : [])];
}

/** 未匹配已验收profile前只查二进制，不检查用户登录状态或接触原生认证目录。 */
export async function findNativeInstallation(backend: ManagedBackend, home = homedir()): Promise<HostInstallation | undefined> {
  for (const executable of nativeExecutableCandidates(backend, home)) {
    try { await access(executable, constants.X_OK); return { backend, executable }; }
    catch { /* 只检查固定安装位置 */ }
  }
  return undefined;
}

/**
 * 只在launcher已匹配版本/OS/hash/profile后调用。原生Linux登录位置依据：
 * https://code.claude.com/docs/en/authentication#credential-management
 * 只读取文件系统元信息，绝不解析、复制或散列凭据内容；文件存在不等于登录仍有效。
 * 不读取CLAUDE_CONFIG_DIR、provider token或endpoint环境变量，不能借此扩大挂载范围。
 */
export async function resolveNativeInstallation(installation: HostInstallation, profile: VerifiedHostProfile,
  home = homedir()): Promise<ResolvedHostInstallation> {
  if (process.platform !== "linux" || profile.platform !== "linux" || installation.backend !== "claude-code"
    || profile.backend !== installation.backend || profile.isolationProfile !== "linux-private-net-v1"
    || profile.nativeCredentialLayout !== "claude-linux-user-login-v1" || profile.egressPolicy !== "anthropic-api-oauth-v1") {
    throw new Error("profile_unsupported");
  }
  if (!path.isAbsolute(home) || !path.isAbsolute(installation.executable)) throw new Error("config_invalid");
  let source: string;
  try {
    const canonicalHome = await realpath(home);
    const directory = path.join(canonicalHome, ".claude");
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error("login_required");
    source = path.join(directory, ".credentials.json");
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(source) !== source) throw new Error("login_required");
  } catch { throw new Error("login_required"); }
  // 逐字段构造，不传播调用者偷偷附加的mount/env/endpoint等字段。
  return { backend: installation.backend, executable: installation.executable,
    credentialMounts: [{ source, destination: CREDENTIAL_DESTINATION }], egressHosts: ANTHROPIC_API_OAUTH_HOSTS };
}

/** 只读检查已知配置/文件头/迁移元数据；不打开 SQLite 或连接 PostgreSQL。 */
import { inspectLegacyStorage } from "../src/server/environment.ts";
import { ConfigError } from "../src/server/config-error.ts";

async function main(): Promise<void> {
  const env = { ...process.env };
  const knownLegacyCwds: string[] = [];
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]; const value = args[i + 1];
    if ((arg === "--legacy-cwd" || arg === "--data-dir") && value && !value.startsWith("--")) {
      if (arg === "--legacy-cwd") knownLegacyCwds.push(value);
      else env["AGENT_STUDIO_DATA_DIR"] = value;
      i++;
    } else throw new ConfigError("用法：inspect-storage.ts [--legacy-cwd <dir>]... [--data-dir <dir>]。");
  }
  // inventory 自身只包含显式白名单，不能序列化完整 environment/config/PG descriptor。
  const inventory = await inspectLegacyStorage({ env, knownLegacyCwds });
  process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
}

await main().catch((error: unknown) => {
  if (error instanceof ConfigError) process.stderr.write(`[${error.code}] ${error.message}\n恢复方式：${error.recoveryAction}\n`);
  else process.stderr.write("[config_invalid] 只读存储检查失败，请检查已知路径与权限。\n");
  process.exitCode = 1;
});

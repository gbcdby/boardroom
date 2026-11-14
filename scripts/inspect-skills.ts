/** 可信本机只读诊断：不会连接业务 DB、导入版本、创建包库或执行任何包代码。 */
import path from "node:path";
import { resolveBoardroomEnvironment } from "../src/server/environment.ts";
import { inspectSkillCatalog } from "../src/server/skills/preview.ts";

const help = `用法：node scripts/inspect-skills.ts [--package 绝对包目录] [--collection 绝对集合目录] [--work-suite 绝对仓库根]
参数可重复；只读取明确选择的本地来源。不传来源时返回空清单。
--work-suite 会校验仓库 .agents/skills/work-suite.json 中全部声明。
结果是只读 preview，不能视作版本已导入、技能可调用或宿主已加载。`;
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { process.stdout.write(`${help}\n`); return; }
  const packageRoots: string[] = [], collectionRoots: string[] = [], workSuites: { rootPath: string; manifestPath: string }[] = [];
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index], value = args[index + 1];
    if (!["--package", "--collection", "--work-suite"].includes(option!) || !value || !path.isAbsolute(value)) throw new Error(help);
    if (option === "--package") packageRoots.push(value);
    else if (option === "--collection") collectionRoots.push(value);
    else workSuites.push({ rootPath: value, manifestPath: path.join(value, ".agents/skills/work-suite.json") });
  }
  const environment = await resolveBoardroomEnvironment();
  const report = await inspectSkillCatalog({ environment, inventory: { packageRoots, collectionRoots, workSuites } });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.inventory.issues.length) process.exitCode = 1;
}
main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "本地技能检查失败"}\n`); process.exitCode = 1;
});

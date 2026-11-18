import { createHash } from "node:crypto";
import type { DbReadSnapshot, DbRow } from "../db/driver.ts";

const SOURCES = [["agents", "id"], ["agent_runtimes", "id"], ["agent_runtime_bindings", "id"],
  ["agent_runner_states", "binding_id"], ["agent_runtime_members", "member_id"], ["members", "id"], ["projects", "id"],
  ["groups", "id"], ["group_participants", "group_id, member_id"]] as const;
type LegacyConfigTable = typeof SOURCES[number][0] | "agent_legacy_aliases";

/** 内部有限来源值；不是整库快照、持久 capture ref 或后续写入许可。 */
export interface LegacyConfigCapture {
  readonly rows: Record<LegacyConfigTable, DbRow[]>;
  readonly persistedAliases: boolean;
  readonly sourceDigest: string;
}

// 保留 #134 的原编码；raw JSON 是行内字符串，不重新解析或规范化。
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

/**
 * 仅在调用方已有的内部查询上下文读取固定十组行；不打开连接/事务或签发资格。
 * public inspector 仍自行拥有 readSnapshot，未来转换事务的创建/重验不由本模块负责。
 */
export async function readLegacyConfigCapture(snapshot: DbReadSnapshot): Promise<LegacyConfigCapture> {
  const rows = {} as Record<LegacyConfigTable, DbRow[]>;
  for (const [table, order] of SOURCES) rows[table] = await snapshot.query(`SELECT * FROM ${table} ORDER BY ${order}`);
  const persistedAliases = Boolean((await snapshot.query("SELECT version FROM schema_migrations WHERE version = 14"))[0]);
  rows.agent_legacy_aliases = persistedAliases
    ? await snapshot.query("SELECT * FROM agent_legacy_aliases ORDER BY display_name, host_type, agent_id, created_at, retired_at") : [];
  return { rows, persistedAliases, sourceDigest: createHash("sha256").update(canonical(rows)).digest("hex") };
}

/** 只比较有限捕获值；不凭调用者携带的 digest 推断实际源仍未变化。 */
export function sameLegacyConfigCapture(left: LegacyConfigCapture, right: LegacyConfigCapture): boolean {
  return left.persistedAliases === right.persistedAliases && left.sourceDigest === right.sourceDigest
    && canonical(left.rows) === canonical(right.rows);
}

import { createHash } from "node:crypto";
import {
  SQLITE_PROFILE_COLUMN_POLICIES as POLICY,
  SQLITE_PROFILE_EXISTING_TRIGGERS,
  SQLITE_PROFILE_RULE_SOURCE,
  SQLITE_PROFILE_TABLE_RULES,
} from "./sqlite-profile-rules.ts";
import type {
  SqliteProfileEvent,
  SqliteProfileGuardOwner,
  SqliteProfileTableRule,
} from "./sqlite-profile-rules.ts";

/**
 * 惰性固定来源：没有 handle、L/T/O、安装器、UDF 注册器或 caller 参数。
 * 所有构造只在 module 初始化发生，输入仅为本仓库固定 72 表/763 列。
 * 后继真正 owner 仍须在同请求预算内预付 SQL、native cells、readback 和副作用。
 * 下列组件摘要不是 final G1 manifest，也不能填入任何完整升级 ref。
 */
export const SQLITE_PROFILE_UDF_ABI = Object.freeze({
  format: Object.freeze({
    name: "br_m2_private_format_v1",
    parameters: Object.freeze([
      "table", "event", "databaseInstanceId", "fenceEpoch", "guardManifestDigest", "writerFormatDigest",
    ] as const),
    options: Object.freeze({ safeIntegers: true, varargs: false, deterministic: false, directOnly: false }),
    requiredDeclaredParameters: 6,
    owner: "same private native handle and current transaction; separate business and S4 control owner branches",
  }),
  row: Object.freeze({
    name: "br_m2_private_row_v1",
    parameters: Object.freeze([
      "table", "event", "oldRowid", "newRowid",
      "OLD cells in declared column order", "NEW cells in declared column order",
    ] as const),
    options: Object.freeze({ safeIntegers: true, varargs: true, deterministic: false, directOnly: false }),
    argumentCount: "4 + 2 * declared column count",
    maximumArguments: 60,
    absentSide: "NULL rowid and NULL cells",
    insertRowid: "actual BEFORE INSERT NEW.rowid; unallocated value is not final identity; owner must read back",
    owner: "pure comparison with current private synchronous typed step; no SQL, I/O, mutation or permit",
  }),
});

export interface SqliteProfileGuardDefinition {
  readonly name: string;
  readonly table: string;
  readonly event: SqliteProfileEvent;
  readonly guardOwner: SqliteProfileGuardOwner;
  readonly rowArgumentCount: number;
  readonly callsPrivateValidators: boolean;
  readonly sql: string;
  readonly bytes: number;
  readonly sha256: string;
}

const EVENTS = Object.freeze(["insert", "update", "delete"] as const);
const FROZEN_ON_UPDATE: readonly string[] = Object.freeze([
  POLICY.identity, POLICY.frozenRunner, POLICY.frozenBinding, POLICY.reservationIdentity, POLICY.clientBirth,
]);
const CONTROL_IDENTITY = Object.freeze(["singleton", "database_instance_id", "control_root_json", "mutex_identity_json"]);
const ATTACHMENT_COLUMNS = Object.freeze(["attachment_state", "detach_config_snapshot_id", "detached_at"]);
const WRITER_DIGEST = SQLITE_PROFILE_RULE_SOURCE.basis.writerDescriptor.sha256;
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const control = (column: string) => `(SELECT ${identifier(column)} FROM "main"."storage_maintenance" WHERE "singleton" = 1)`;

// 类型与 BINARY 同时核验，不能让 NOCASE/数值转换掩盖旧 raw 的变化。
function unchanged(column: string): string {
  const name = identifier(column);
  return `(typeof(NEW.${name}) IS typeof(OLD.${name}) AND (NEW.${name} COLLATE BINARY) IS (OLD.${name} COLLATE BINARY))`;
}

function requireCondition(condition: string, error: string): string {
  return `  SELECT CASE WHEN ${condition} THEN NULL ELSE RAISE(ABORT, '${error}') END;`;
}

function rowArguments(row: SqliteProfileTableRule, event: SqliteProfileEvent): string[] {
  const oldExists = event !== "insert";
  const newExists = event !== "delete";
  return [literal(row.table), literal(event), oldExists ? "OLD.rowid" : "NULL", newExists ? "NEW.rowid" : "NULL",
    ...row.columns.map(column => oldExists ? `OLD.${identifier(column.name)}` : "NULL"),
    ...row.columns.map(column => newExists ? `NEW.${identifier(column.name)}` : "NULL")];
}

function definition(row: SqliteProfileTableRule, event: SqliteProfileEvent): SqliteProfileGuardDefinition {
  const name = `br_m2_g1_${row.table}_${event}`;
  const lines = [`CREATE TRIGGER ${identifier(name)} BEFORE ${event.toUpperCase()} ON "main".${identifier(row.table)}`, "BEGIN"];
  const callsPrivateValidators = row.operationEligibility[event].length !== 0;
  if (!callsPrivateValidators) {
    // 没有合法操作的事件直接拒绝；即使错误 UDF 返回 1 也没有 noop 例外。
    lines.push("  SELECT RAISE(ABORT, 'BR_M2_PROFILE_OPERATION_BLOCKED');");
  } else {
    const conditions = [
      '(SELECT count(*) FROM "main"."storage_maintenance") = 1',
      `${control("protocol_version")} IS 2`,
    ];
    if (row.guardOwner === "business") {
      // draining 只让私有 DRN 精确步骤继续判断；不把它变成 ordinary admission。
      // A 的业务 DML 先于 G1 安装，sealed 下没有业务 bypass。
      conditions.push(`(${control("admission")} IS 'open' OR ${control("admission")} IS 'draining')`,
        `${control("profile_takeover_terminal_json")} IS NOT NULL`);
    }
    // 控制分支读 singleton 当前 preimage。terminal 首次写入时可为 NULL，
    // 但同一 format UDF 必须辨认真正的 S4/control owner，不能沿用业务成功。
    conditions.push(`${SQLITE_PROFILE_UDF_ABI.format.name}(${[
      literal(row.table), literal(event), control("database_instance_id"), control("fence_epoch"),
      control("guard_manifest_digest"), literal(WRITER_DIGEST),
    ].join(", ")}) IS 1`);
    lines.push(requireCondition(conditions.join("\n    AND "), "BR_M2_PROFILE_FORMAT_BLOCKED"));

    if (event === "update") {
      const fixed = row.columns.filter(column => FROZEN_ON_UPDATE.includes(column.rule)).map(column => unchanged(column.name));
      if (row.table === "storage_maintenance") {
        fixed.push(...CONTROL_IDENTITY.map(unchanged));
        fixed.push(`(OLD."profile_takeover_terminal_json" IS NULL OR ${unchanged("profile_takeover_terminal_json")})`);
      }
      if (row.table === "agent_runtime_bindings") {
        // 历史壳不复活；只有 attached->detached 可改变这三列，其余变更仍须 exact O。
        fixed.push(`OLD."attachment_state" IS 'attached'`);
        fixed.push(`((${ATTACHMENT_COLUMNS.map(unchanged).join(" AND ")}) OR (OLD."attachment_state" IS 'attached' AND NEW."attachment_state" IS 'detached'))`);
      }
      if (fixed.length !== 0) lines.push(requireCondition(fixed.join("\n    AND "), "BR_M2_PROFILE_FROZEN_CELL"));
    }
    lines.push(requireCondition(`${SQLITE_PROFILE_UDF_ABI.row.name}(${rowArguments(row, event).join(", ")}) IS 1`, "BR_M2_PROFILE_ROW_BLOCKED"));
  }
  lines.push("END");
  const sql = lines.join("\n");
  return Object.freeze({ name, table: row.table, event, guardOwner: row.guardOwner,
    rowArgumentCount: 4 + 2 * row.columns.length, callsPrivateValidators, sql,
    bytes: Buffer.byteLength(sql, "utf8"), sha256: sha256(sql) });
}

/** 固定的 216 个可安装 SQL 组件；import 本身不执行 SQL。 */
export const SQLITE_PROFILE_GUARD_DEFINITIONS: readonly SqliteProfileGuardDefinition[] = Object.freeze(
  SQLITE_PROFILE_TABLE_RULES.flatMap(row => EVENTS.map(event => definition(row, event))),
);

// 摘要绑定实际编译值及逐字非 G0 来源，不只绑定它们声称的旧 SHA。
const dependenciesJson = JSON.stringify({
  source: SQLITE_PROFILE_RULE_SOURCE, tables: SQLITE_PROFILE_TABLE_RULES,
  nonG0Triggers: SQLITE_PROFILE_EXISTING_TRIGGERS, udf: SQLITE_PROFILE_UDF_ABI,
});
const MANIFEST = Object.freeze({
  contract: "m2-g1-sqlite-guard-source-component/v1",
  qualification: "component-only; not-final-G1",
  source: SQLITE_PROFILE_RULE_SOURCE,
  dependenciesBytes: Buffer.byteLength(dependenciesJson, "utf8"),
  dependenciesSha256: sha256(dependenciesJson),
  requiredPragmas: Object.freeze({ foreign_keys: "ON", recursive_triggers: "ON" }),
  requiredPrivateFunctions: SQLITE_PROFILE_UDF_ABI,
  tables: 72,
  columns: 763,
  genericGuardTables: 70,
  controlOwnerTables: 2,
  guardCount: SQLITE_PROFILE_GUARD_DEFINITIONS.length,
  sqlBytes: SQLITE_PROFILE_GUARD_DEFINITIONS.reduce((sum, item) => sum + item.bytes, 0),
  definitions: Object.freeze(SQLITE_PROFILE_GUARD_DEFINITIONS.map(({ sql: _sql, ...identity }) => Object.freeze(identity))),
  guardTransitionRef: null,
  targetSchemaRef: null,
});
const manifestJson = JSON.stringify(MANIFEST);
export const SQLITE_PROFILE_GUARD_COMPONENT = Object.freeze({
  ...MANIFEST,
  // 固定声明顺序的 JSON；此 SHA 仅标识本片来源，不是权限或全升级合同。
  bytes: Buffer.byteLength(manifestJson, "utf8"),
  sha256: sha256(manifestJson),
});

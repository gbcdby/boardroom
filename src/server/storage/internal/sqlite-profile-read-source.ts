/** SQ-D02 I02 固定惰性来源；没有数据库句柄、执行入口、安装器或权限。 */
import { createHash } from "node:crypto";

export type SqliteProfileObservationTable = "storage_maintenance" | "storage_source_clients" | "config_authority"
  | "config_activation_receipts" | "schema_migrations";
export type SqliteProfileObservationPart = "control" | "clients" | "authority" | "activationReceipts" | "migrations";
export interface SqliteProfileReadColumn {
  readonly cid: number; readonly name: string; readonly type: string; readonly notnull: number;
  readonly default: string | null; readonly pk: number; readonly hidden: number; readonly rule: string;
}
export interface SqliteProfileReadTable {
  readonly table: SqliteProfileObservationTable; readonly inputKey: SqliteProfileObservationPart;
  readonly columns: readonly SqliteProfileReadColumn[];
}
export interface SqliteProfileFixedQuery {
  readonly id: string; readonly purpose: string; readonly sql: string; readonly parameters: readonly string[];
  readonly bytes: number; readonly sha256: string;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

// Exact accepted fields and SQL; these are not schemas/guards claimed to exist in any live database.
export const SQLITE_PROFILE_READ_TABLES: readonly SqliteProfileReadTable[] = freeze([
  {
    "table": "storage_maintenance",
    "inputKey": "control",
    "columns": [
      {
        "cid": 0,
        "name": "singleton",
        "type": "INTEGER",
        "notnull": 0,
        "default": null,
        "pk": 1,
        "hidden": 0,
        "rule": "CTL-01 precise original S4 transition/CAS only; source/root/mutex immutable; terminal once B then retained"
      },
      {
        "cid": 1,
        "name": "database_instance_id",
        "type": "TEXT",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "CTL-01 precise original S4 transition/CAS only; source/root/mutex immutable; terminal once B then retained"
      },
      {
        "cid": 2,
        "name": "control_root_json",
        "type": "TEXT",
        "notnull": 0,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "CTL-01 precise original S4 transition/CAS only; source/root/mutex immutable; terminal once B then retained"
      },
      {
        "cid": 3,
        "name": "mutex_identity_json",
        "type": "TEXT",
        "notnull": 0,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "CTL-01 precise original S4 transition/CAS only; source/root/mutex immutable; terminal once B then retained"
      },
      {
        "cid": 4,
        "name": "fence_epoch",
        "type": "BIGINT",
        "notnull": 1,
        "default": "0",
        "pk": 0,
        "hidden": 0,
        "rule": "CTL-01 precise original S4 transition/CAS only; source/root/mutex immutable; terminal once B then retained"
      },
      {
        "cid": 5,
        "name": "admission",
        "type": "TEXT",
        "notnull": 1,
        "default": "'open'",
        "pk": 0,
        "hidden": 0,
        "rule": "CTL-01 precise original S4 transition/CAS only; source/root/mutex immutable; terminal once B then retained"
      },
      {
        "cid": 6,
        "name": "active_migration_id",
        "type": "TEXT",
        "notnull": 0,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "CTL-01 precise original S4 transition/CAS only; source/root/mutex immutable; terminal once B then retained"
      },
      {
        "cid": 7,
        "name": "plan_digest",
        "type": "TEXT",
        "notnull": 0,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "CTL-01 precise original S4 transition/CAS only; source/root/mutex immutable; terminal once B then retained"
      },
      {
        "cid": 8,
        "name": "owner_generation",
        "type": "BIGINT",
        "notnull": 1,
        "default": "0",
        "pk": 0,
        "hidden": 0,
        "rule": "CTL-01 precise original S4 transition/CAS only; source/root/mutex immutable; terminal once B then retained"
      },
      {
        "cid": 9,
        "name": "journal_record_ref",
        "type": "TEXT",
        "notnull": 0,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "CTL-01 precise original S4 transition/CAS only; source/root/mutex immutable; terminal once B then retained"
      },
      {
        "cid": 10,
        "name": "journal_digest",
        "type": "TEXT",
        "notnull": 0,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "CTL-01 precise original S4 transition/CAS only; source/root/mutex immutable; terminal once B then retained"
      },
      {
        "cid": 11,
        "name": "journal_sequence",
        "type": "BIGINT",
        "notnull": 1,
        "default": "0",
        "pk": 0,
        "hidden": 0,
        "rule": "CTL-01 precise original S4 transition/CAS only; source/root/mutex immutable; terminal once B then retained"
      },
      {
        "cid": 12,
        "name": "protocol_version",
        "type": "INTEGER",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "CTL-01 precise original S4 transition/CAS only; source/root/mutex immutable; terminal once B then retained"
      },
      {
        "cid": 13,
        "name": "guard_manifest_digest",
        "type": "TEXT",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "CTL-01 precise original S4 transition/CAS only; source/root/mutex immutable; terminal once B then retained"
      },
      {
        "cid": 14,
        "name": "profile_takeover_terminal_json",
        "type": "TEXT",
        "notnull": 0,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "CTL-01 precise original S4 transition/CAS only; source/root/mutex immutable; terminal once B then retained"
      }
    ]
  },
  {
    "table": "storage_source_clients",
    "inputKey": "clients",
    "columns": [
      {
        "cid": 0,
        "name": "client_id",
        "type": "TEXT",
        "notnull": 0,
        "default": null,
        "pk": 1,
        "hidden": 0,
        "rule": "CTL-01 genuine factory birth immutable; never caller self-registration"
      },
      {
        "cid": 1,
        "name": "database_instance_id",
        "type": "TEXT",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "CTL-01 genuine factory birth immutable; never caller self-registration"
      },
      {
        "cid": 2,
        "name": "entrypoint",
        "type": "TEXT",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "CTL-01 genuine factory birth immutable; never caller self-registration"
      },
      {
        "cid": 3,
        "name": "build_id",
        "type": "TEXT",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "CTL-01 genuine factory birth immutable; never caller self-registration"
      },
      {
        "cid": 4,
        "name": "protocol_version",
        "type": "INTEGER",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "CTL-01 factory P1 birth; only exact existing coordinator two-cell A conversion thereafter"
      },
      {
        "cid": 5,
        "name": "host_identity_json",
        "type": "TEXT",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "CTL-01 genuine factory birth immutable; never caller self-registration"
      },
      {
        "cid": 6,
        "name": "process_identity_json",
        "type": "TEXT",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "CTL-01 genuine factory birth immutable; never caller self-registration"
      },
      {
        "cid": 7,
        "name": "db_sessions_json",
        "type": "TEXT",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "CTL-01 original birth/observation/retirement grammar and CF03/CF05; never capability or rewritten birth"
      },
      {
        "cid": 8,
        "name": "registered_epoch",
        "type": "BIGINT",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "CTL-01 genuine factory birth immutable; never caller self-registration"
      },
      {
        "cid": 9,
        "name": "observed_epoch",
        "type": "BIGINT",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "CTL-01 own actual client observation/drain/retirement exact CAS; no fabricated ended/zero-quiescence"
      },
      {
        "cid": 10,
        "name": "drain_epoch",
        "type": "BIGINT",
        "notnull": 0,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "CTL-01 own actual client observation/drain/retirement exact CAS; no fabricated ended/zero-quiescence"
      },
      {
        "cid": 11,
        "name": "drain_state",
        "type": "TEXT",
        "notnull": 1,
        "default": "'none'",
        "pk": 0,
        "hidden": 0,
        "rule": "CTL-01 own actual client observation/drain/retirement exact CAS; no fabricated ended/zero-quiescence"
      },
      {
        "cid": 12,
        "name": "drain_receipt_digest",
        "type": "TEXT",
        "notnull": 0,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "CTL-01 own actual client observation/drain/retirement exact CAS; no fabricated ended/zero-quiescence"
      },
      {
        "cid": 13,
        "name": "registered_at",
        "type": "TEXT",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "CTL-01 genuine factory birth immutable; never caller self-registration"
      },
      {
        "cid": 14,
        "name": "last_observed_at",
        "type": "TEXT",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "CTL-01 own actual client observation/drain/retirement exact CAS; no fabricated ended/zero-quiescence"
      },
      {
        "cid": 15,
        "name": "ended_at",
        "type": "TEXT",
        "notnull": 0,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "CTL-01 own actual client observation/drain/retirement exact CAS; no fabricated ended/zero-quiescence"
      },
      {
        "cid": 16,
        "name": "writer_format_digest",
        "type": "TEXT",
        "notnull": 0,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "CTL-01 factory P1 birth; only exact existing coordinator two-cell A conversion thereafter"
      }
    ]
  },
  {
    "table": "config_authority",
    "inputKey": "authority",
    "columns": [
      {
        "cid": 0,
        "name": "singleton",
        "type": "INTEGER",
        "notnull": 1,
        "default": null,
        "pk": 1,
        "hidden": 0,
        "rule": "no ordinary INSERT/UPDATE/DELETE; exact A/source-operation owner only; never generic PURGE-01/DRN"
      },
      {
        "cid": 1,
        "name": "format_version",
        "type": "INTEGER",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "no ordinary INSERT/UPDATE/DELETE; exact A/source-operation owner only; never generic PURGE-01/DRN"
      },
      {
        "cid": 2,
        "name": "owner",
        "type": "TEXT",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "no ordinary INSERT/UPDATE/DELETE; exact A/source-operation owner only; never generic PURGE-01/DRN"
      },
      {
        "cid": 3,
        "name": "activation_id",
        "type": "TEXT",
        "notnull": 0,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "no ordinary INSERT/UPDATE/DELETE; exact A/source-operation owner only; never generic PURGE-01/DRN"
      },
      {
        "cid": 4,
        "name": "source_binding_ref",
        "type": "TEXT",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "no ordinary INSERT/UPDATE/DELETE; exact A/source-operation owner only; never generic PURGE-01/DRN"
      }
    ]
  },
  {
    "table": "config_activation_receipts",
    "inputKey": "activationReceipts",
    "columns": [
      {
        "cid": 0,
        "name": "id",
        "type": "TEXT",
        "notnull": 1,
        "default": null,
        "pk": 1,
        "hidden": 0,
        "rule": "no ordinary INSERT/UPDATE/DELETE; exact A/source-operation owner only; never generic PURGE-01/DRN"
      },
      {
        "cid": 1,
        "name": "request_id",
        "type": "TEXT",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "no ordinary INSERT/UPDATE/DELETE; exact A/source-operation owner only; never generic PURGE-01/DRN"
      },
      {
        "cid": 2,
        "name": "plan_id",
        "type": "TEXT",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "no ordinary INSERT/UPDATE/DELETE; exact A/source-operation owner only; never generic PURGE-01/DRN"
      },
      {
        "cid": 3,
        "name": "plan_digest",
        "type": "TEXT",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "no ordinary INSERT/UPDATE/DELETE; exact A/source-operation owner only; never generic PURGE-01/DRN"
      },
      {
        "cid": 4,
        "name": "physical_source_ref",
        "type": "TEXT",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "no ordinary INSERT/UPDATE/DELETE; exact A/source-operation owner only; never generic PURGE-01/DRN"
      },
      {
        "cid": 5,
        "name": "snapshot_receipt_ref",
        "type": "TEXT",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "no ordinary INSERT/UPDATE/DELETE; exact A/source-operation owner only; never generic PURGE-01/DRN"
      },
      {
        "cid": 6,
        "name": "capture_id",
        "type": "TEXT",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "no ordinary INSERT/UPDATE/DELETE; exact A/source-operation owner only; never generic PURGE-01/DRN"
      },
      {
        "cid": 7,
        "name": "capture_source_digest",
        "type": "TEXT",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "no ordinary INSERT/UPDATE/DELETE; exact A/source-operation owner only; never generic PURGE-01/DRN"
      },
      {
        "cid": 8,
        "name": "capture_artifact_digest",
        "type": "TEXT",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "no ordinary INSERT/UPDATE/DELETE; exact A/source-operation owner only; never generic PURGE-01/DRN"
      },
      {
        "cid": 9,
        "name": "schema_before_digest",
        "type": "TEXT",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "no ordinary INSERT/UPDATE/DELETE; exact A/source-operation owner only; never generic PURGE-01/DRN"
      },
      {
        "cid": 10,
        "name": "schema_after_digest",
        "type": "TEXT",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "no ordinary INSERT/UPDATE/DELETE; exact A/source-operation owner only; never generic PURGE-01/DRN"
      },
      {
        "cid": 11,
        "name": "guard_transition_json",
        "type": "TEXT",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "no ordinary INSERT/UPDATE/DELETE; exact A/source-operation owner only; never generic PURGE-01/DRN"
      },
      {
        "cid": 12,
        "name": "allowed_delta_ref",
        "type": "TEXT",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "no ordinary INSERT/UPDATE/DELETE; exact A/source-operation owner only; never generic PURGE-01/DRN"
      },
      {
        "cid": 13,
        "name": "target_rows_digest",
        "type": "TEXT",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "no ordinary INSERT/UPDATE/DELETE; exact A/source-operation owner only; never generic PURGE-01/DRN"
      },
      {
        "cid": 14,
        "name": "source_to_target_manifest_ref",
        "type": "TEXT",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "no ordinary INSERT/UPDATE/DELETE; exact A/source-operation owner only; never generic PURGE-01/DRN"
      },
      {
        "cid": 15,
        "name": "payload_json",
        "type": "TEXT",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "no ordinary INSERT/UPDATE/DELETE; exact A/source-operation owner only; never generic PURGE-01/DRN"
      },
      {
        "cid": 16,
        "name": "payload_digest",
        "type": "TEXT",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "no ordinary INSERT/UPDATE/DELETE; exact A/source-operation owner only; never generic PURGE-01/DRN"
      }
    ]
  },
  {
    "table": "schema_migrations",
    "inputKey": "migrations",
    "columns": [
      {
        "cid": 0,
        "name": "version",
        "type": "INTEGER",
        "notnull": 0,
        "default": null,
        "pk": 1,
        "hidden": 0,
        "rule": "no ordinary INSERT/UPDATE/DELETE; exact A/source-operation owner only; never generic PURGE-01/DRN"
      },
      {
        "cid": 1,
        "name": "name",
        "type": "TEXT",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "no ordinary INSERT/UPDATE/DELETE; exact A/source-operation owner only; never generic PURGE-01/DRN"
      },
      {
        "cid": 2,
        "name": "checksum",
        "type": "TEXT",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "no ordinary INSERT/UPDATE/DELETE; exact A/source-operation owner only; never generic PURGE-01/DRN"
      },
      {
        "cid": 3,
        "name": "applied_at",
        "type": "TEXT",
        "notnull": 1,
        "default": null,
        "pk": 0,
        "hidden": 0,
        "rule": "no ordinary INSERT/UPDATE/DELETE; exact A/source-operation owner only; never generic PURGE-01/DRN"
      }
    ]
  }
]);

export const SQLITE_PROFILE_FIXED_QUERIES: readonly SqliteProfileFixedQuery[] = freeze([
  {
    "id": "Q-SOURCE",
    "purpose": "Fixed same-handle VFS check; necessary observation, not full native qualification",
    "sql": "SELECT boardroom_maintenance_source_unchanged() AS unchanged;",
    "parameters": [],
    "bytes": 61,
    "sha256": "f96974122e1970b254632e22aaac391ed19cdbec74a1eb94654bfd16443776aa"
  },
  {
    "id": "Q-ENCODING",
    "purpose": "Actual main database encoding",
    "sql": "PRAGMA main.encoding;",
    "parameters": [],
    "bytes": 21,
    "sha256": "246885a78b780b81623aaa496cb00524829bf88ad1ed1730c8595925414ca576"
  },
  {
    "id": "Q-SCHEMA-VERSION",
    "purpose": "Current native schema cookie, never a schema identity by itself",
    "sql": "PRAGMA main.schema_version;",
    "parameters": [],
    "bytes": 27,
    "sha256": "02ed68f5a147a4d5817b9507e6b5db4c077fffb552614263253186b251b0290f"
  },
  {
    "id": "Q-FK-MODE",
    "purpose": "Read mode, do not change a selected database",
    "sql": "PRAGMA foreign_keys;",
    "parameters": [],
    "bytes": 20,
    "sha256": "675de3ed5c2c6c5846ad0a0dc0cefc2a6ee01c7dfcbccd8f46bd0876e3de973e"
  },
  {
    "id": "Q-META-FIRST-storage_maintenance",
    "purpose": "First raw row metadata; all properties have fixed small upper bounds",
    "sql": "SELECT rowid AS _rowid, typeof(\"singleton\") AS t0, octet_length(\"singleton\") AS n0, typeof(\"database_instance_id\") AS t1, octet_length(\"database_instance_id\") AS n1, typeof(\"control_root_json\") AS t2, octet_length(\"control_root_json\") AS n2, typeof(\"mutex_identity_json\") AS t3, octet_length(\"mutex_identity_json\") AS n3, typeof(\"fence_epoch\") AS t4, octet_length(\"fence_epoch\") AS n4, typeof(\"admission\") AS t5, octet_length(\"admission\") AS n5, typeof(\"active_migration_id\") AS t6, octet_length(\"active_migration_id\") AS n6, typeof(\"plan_digest\") AS t7, octet_length(\"plan_digest\") AS n7, typeof(\"owner_generation\") AS t8, octet_length(\"owner_generation\") AS n8, typeof(\"journal_record_ref\") AS t9, octet_length(\"journal_record_ref\") AS n9, typeof(\"journal_digest\") AS t10, octet_length(\"journal_digest\") AS n10, typeof(\"journal_sequence\") AS t11, octet_length(\"journal_sequence\") AS n11, typeof(\"protocol_version\") AS t12, octet_length(\"protocol_version\") AS n12, typeof(\"guard_manifest_digest\") AS t13, octet_length(\"guard_manifest_digest\") AS n13, typeof(\"profile_takeover_terminal_json\") AS t14, octet_length(\"profile_takeover_terminal_json\") AS n14 FROM \"main\".\"storage_maintenance\" ORDER BY rowid LIMIT 1;",
    "parameters": [],
    "bytes": 1212,
    "sha256": "4b83c39e008476f49077a57afbbc6e2286ca3328d5f60909828b67c18f9922f6"
  },
  {
    "id": "Q-META-NEXT-storage_maintenance",
    "purpose": "Next raw row metadata under the same actual read/write transaction",
    "sql": "SELECT rowid AS _rowid, typeof(\"singleton\") AS t0, octet_length(\"singleton\") AS n0, typeof(\"database_instance_id\") AS t1, octet_length(\"database_instance_id\") AS n1, typeof(\"control_root_json\") AS t2, octet_length(\"control_root_json\") AS n2, typeof(\"mutex_identity_json\") AS t3, octet_length(\"mutex_identity_json\") AS n3, typeof(\"fence_epoch\") AS t4, octet_length(\"fence_epoch\") AS n4, typeof(\"admission\") AS t5, octet_length(\"admission\") AS n5, typeof(\"active_migration_id\") AS t6, octet_length(\"active_migration_id\") AS n6, typeof(\"plan_digest\") AS t7, octet_length(\"plan_digest\") AS n7, typeof(\"owner_generation\") AS t8, octet_length(\"owner_generation\") AS n8, typeof(\"journal_record_ref\") AS t9, octet_length(\"journal_record_ref\") AS n9, typeof(\"journal_digest\") AS t10, octet_length(\"journal_digest\") AS n10, typeof(\"journal_sequence\") AS t11, octet_length(\"journal_sequence\") AS n11, typeof(\"protocol_version\") AS t12, octet_length(\"protocol_version\") AS n12, typeof(\"guard_manifest_digest\") AS t13, octet_length(\"guard_manifest_digest\") AS n13, typeof(\"profile_takeover_terminal_json\") AS t14, octet_length(\"profile_takeover_terminal_json\") AS n14 FROM \"main\".\"storage_maintenance\" WHERE rowid > ? ORDER BY rowid LIMIT 1;",
    "parameters": [
      "last native signed int64 rowid"
    ],
    "bytes": 1228,
    "sha256": "703482e8b4eb713ab5117ae7caae546e6403b16791520448d77defae18231f4f"
  },
  {
    "id": "Q-VALUE-storage_maintenance",
    "purpose": "After size/type validation and precharge, exact same-T values; text/blob represented by bytes",
    "sql": "SELECT rowid AS _rowid, CASE typeof(\"singleton\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"singleton\" WHEN 'real' THEN \"singleton\" ELSE lower(hex(CAST(\"singleton\" AS BLOB))) END AS v0, CASE typeof(\"database_instance_id\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"database_instance_id\" WHEN 'real' THEN \"database_instance_id\" ELSE lower(hex(CAST(\"database_instance_id\" AS BLOB))) END AS v1, CASE typeof(\"control_root_json\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"control_root_json\" WHEN 'real' THEN \"control_root_json\" ELSE lower(hex(CAST(\"control_root_json\" AS BLOB))) END AS v2, CASE typeof(\"mutex_identity_json\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"mutex_identity_json\" WHEN 'real' THEN \"mutex_identity_json\" ELSE lower(hex(CAST(\"mutex_identity_json\" AS BLOB))) END AS v3, CASE typeof(\"fence_epoch\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"fence_epoch\" WHEN 'real' THEN \"fence_epoch\" ELSE lower(hex(CAST(\"fence_epoch\" AS BLOB))) END AS v4, CASE typeof(\"admission\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"admission\" WHEN 'real' THEN \"admission\" ELSE lower(hex(CAST(\"admission\" AS BLOB))) END AS v5, CASE typeof(\"active_migration_id\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"active_migration_id\" WHEN 'real' THEN \"active_migration_id\" ELSE lower(hex(CAST(\"active_migration_id\" AS BLOB))) END AS v6, CASE typeof(\"plan_digest\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"plan_digest\" WHEN 'real' THEN \"plan_digest\" ELSE lower(hex(CAST(\"plan_digest\" AS BLOB))) END AS v7, CASE typeof(\"owner_generation\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"owner_generation\" WHEN 'real' THEN \"owner_generation\" ELSE lower(hex(CAST(\"owner_generation\" AS BLOB))) END AS v8, CASE typeof(\"journal_record_ref\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"journal_record_ref\" WHEN 'real' THEN \"journal_record_ref\" ELSE lower(hex(CAST(\"journal_record_ref\" AS BLOB))) END AS v9, CASE typeof(\"journal_digest\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"journal_digest\" WHEN 'real' THEN \"journal_digest\" ELSE lower(hex(CAST(\"journal_digest\" AS BLOB))) END AS v10, CASE typeof(\"journal_sequence\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"journal_sequence\" WHEN 'real' THEN \"journal_sequence\" ELSE lower(hex(CAST(\"journal_sequence\" AS BLOB))) END AS v11, CASE typeof(\"protocol_version\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"protocol_version\" WHEN 'real' THEN \"protocol_version\" ELSE lower(hex(CAST(\"protocol_version\" AS BLOB))) END AS v12, CASE typeof(\"guard_manifest_digest\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"guard_manifest_digest\" WHEN 'real' THEN \"guard_manifest_digest\" ELSE lower(hex(CAST(\"guard_manifest_digest\" AS BLOB))) END AS v13, CASE typeof(\"profile_takeover_terminal_json\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"profile_takeover_terminal_json\" WHEN 'real' THEN \"profile_takeover_terminal_json\" ELSE lower(hex(CAST(\"profile_takeover_terminal_json\" AS BLOB))) END AS v14 FROM \"main\".\"storage_maintenance\" WHERE rowid = ?;",
    "parameters": [
      "native signed int64 rowid from metadata"
    ],
    "bytes": 2952,
    "sha256": "3af59a871e309f6ba677b85153c50ccdac28ebba2025a92bd68e2b0b7ff74cd6"
  },
  {
    "id": "Q-META-FIRST-storage_source_clients",
    "purpose": "First raw row metadata; all properties have fixed small upper bounds",
    "sql": "SELECT rowid AS _rowid, typeof(\"client_id\") AS t0, octet_length(\"client_id\") AS n0, typeof(\"database_instance_id\") AS t1, octet_length(\"database_instance_id\") AS n1, typeof(\"entrypoint\") AS t2, octet_length(\"entrypoint\") AS n2, typeof(\"build_id\") AS t3, octet_length(\"build_id\") AS n3, typeof(\"protocol_version\") AS t4, octet_length(\"protocol_version\") AS n4, typeof(\"host_identity_json\") AS t5, octet_length(\"host_identity_json\") AS n5, typeof(\"process_identity_json\") AS t6, octet_length(\"process_identity_json\") AS n6, typeof(\"db_sessions_json\") AS t7, octet_length(\"db_sessions_json\") AS n7, typeof(\"registered_epoch\") AS t8, octet_length(\"registered_epoch\") AS n8, typeof(\"observed_epoch\") AS t9, octet_length(\"observed_epoch\") AS n9, typeof(\"drain_epoch\") AS t10, octet_length(\"drain_epoch\") AS n10, typeof(\"drain_state\") AS t11, octet_length(\"drain_state\") AS n11, typeof(\"drain_receipt_digest\") AS t12, octet_length(\"drain_receipt_digest\") AS n12, typeof(\"registered_at\") AS t13, octet_length(\"registered_at\") AS n13, typeof(\"last_observed_at\") AS t14, octet_length(\"last_observed_at\") AS n14, typeof(\"ended_at\") AS t15, octet_length(\"ended_at\") AS n15, typeof(\"writer_format_digest\") AS t16, octet_length(\"writer_format_digest\") AS n16 FROM \"main\".\"storage_source_clients\" ORDER BY rowid LIMIT 1;",
    "parameters": [],
    "bytes": 1305,
    "sha256": "a58f6e92b78119582f3a4c3d820e43e0a7742a7c5534e6565207c9c47d1b505f"
  },
  {
    "id": "Q-META-NEXT-storage_source_clients",
    "purpose": "Next raw row metadata under the same actual read/write transaction",
    "sql": "SELECT rowid AS _rowid, typeof(\"client_id\") AS t0, octet_length(\"client_id\") AS n0, typeof(\"database_instance_id\") AS t1, octet_length(\"database_instance_id\") AS n1, typeof(\"entrypoint\") AS t2, octet_length(\"entrypoint\") AS n2, typeof(\"build_id\") AS t3, octet_length(\"build_id\") AS n3, typeof(\"protocol_version\") AS t4, octet_length(\"protocol_version\") AS n4, typeof(\"host_identity_json\") AS t5, octet_length(\"host_identity_json\") AS n5, typeof(\"process_identity_json\") AS t6, octet_length(\"process_identity_json\") AS n6, typeof(\"db_sessions_json\") AS t7, octet_length(\"db_sessions_json\") AS n7, typeof(\"registered_epoch\") AS t8, octet_length(\"registered_epoch\") AS n8, typeof(\"observed_epoch\") AS t9, octet_length(\"observed_epoch\") AS n9, typeof(\"drain_epoch\") AS t10, octet_length(\"drain_epoch\") AS n10, typeof(\"drain_state\") AS t11, octet_length(\"drain_state\") AS n11, typeof(\"drain_receipt_digest\") AS t12, octet_length(\"drain_receipt_digest\") AS n12, typeof(\"registered_at\") AS t13, octet_length(\"registered_at\") AS n13, typeof(\"last_observed_at\") AS t14, octet_length(\"last_observed_at\") AS n14, typeof(\"ended_at\") AS t15, octet_length(\"ended_at\") AS n15, typeof(\"writer_format_digest\") AS t16, octet_length(\"writer_format_digest\") AS n16 FROM \"main\".\"storage_source_clients\" WHERE rowid > ? ORDER BY rowid LIMIT 1;",
    "parameters": [
      "last native signed int64 rowid"
    ],
    "bytes": 1321,
    "sha256": "39b294282a13038ac00bee83583727bbe492c50b00d9950854426013705bf6c0"
  },
  {
    "id": "Q-VALUE-storage_source_clients",
    "purpose": "After size/type validation and precharge, exact same-T values; text/blob represented by bytes",
    "sql": "SELECT rowid AS _rowid, CASE typeof(\"client_id\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"client_id\" WHEN 'real' THEN \"client_id\" ELSE lower(hex(CAST(\"client_id\" AS BLOB))) END AS v0, CASE typeof(\"database_instance_id\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"database_instance_id\" WHEN 'real' THEN \"database_instance_id\" ELSE lower(hex(CAST(\"database_instance_id\" AS BLOB))) END AS v1, CASE typeof(\"entrypoint\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"entrypoint\" WHEN 'real' THEN \"entrypoint\" ELSE lower(hex(CAST(\"entrypoint\" AS BLOB))) END AS v2, CASE typeof(\"build_id\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"build_id\" WHEN 'real' THEN \"build_id\" ELSE lower(hex(CAST(\"build_id\" AS BLOB))) END AS v3, CASE typeof(\"protocol_version\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"protocol_version\" WHEN 'real' THEN \"protocol_version\" ELSE lower(hex(CAST(\"protocol_version\" AS BLOB))) END AS v4, CASE typeof(\"host_identity_json\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"host_identity_json\" WHEN 'real' THEN \"host_identity_json\" ELSE lower(hex(CAST(\"host_identity_json\" AS BLOB))) END AS v5, CASE typeof(\"process_identity_json\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"process_identity_json\" WHEN 'real' THEN \"process_identity_json\" ELSE lower(hex(CAST(\"process_identity_json\" AS BLOB))) END AS v6, CASE typeof(\"db_sessions_json\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"db_sessions_json\" WHEN 'real' THEN \"db_sessions_json\" ELSE lower(hex(CAST(\"db_sessions_json\" AS BLOB))) END AS v7, CASE typeof(\"registered_epoch\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"registered_epoch\" WHEN 'real' THEN \"registered_epoch\" ELSE lower(hex(CAST(\"registered_epoch\" AS BLOB))) END AS v8, CASE typeof(\"observed_epoch\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"observed_epoch\" WHEN 'real' THEN \"observed_epoch\" ELSE lower(hex(CAST(\"observed_epoch\" AS BLOB))) END AS v9, CASE typeof(\"drain_epoch\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"drain_epoch\" WHEN 'real' THEN \"drain_epoch\" ELSE lower(hex(CAST(\"drain_epoch\" AS BLOB))) END AS v10, CASE typeof(\"drain_state\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"drain_state\" WHEN 'real' THEN \"drain_state\" ELSE lower(hex(CAST(\"drain_state\" AS BLOB))) END AS v11, CASE typeof(\"drain_receipt_digest\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"drain_receipt_digest\" WHEN 'real' THEN \"drain_receipt_digest\" ELSE lower(hex(CAST(\"drain_receipt_digest\" AS BLOB))) END AS v12, CASE typeof(\"registered_at\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"registered_at\" WHEN 'real' THEN \"registered_at\" ELSE lower(hex(CAST(\"registered_at\" AS BLOB))) END AS v13, CASE typeof(\"last_observed_at\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"last_observed_at\" WHEN 'real' THEN \"last_observed_at\" ELSE lower(hex(CAST(\"last_observed_at\" AS BLOB))) END AS v14, CASE typeof(\"ended_at\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"ended_at\" WHEN 'real' THEN \"ended_at\" ELSE lower(hex(CAST(\"ended_at\" AS BLOB))) END AS v15, CASE typeof(\"writer_format_digest\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"writer_format_digest\" WHEN 'real' THEN \"writer_format_digest\" ELSE lower(hex(CAST(\"writer_format_digest\" AS BLOB))) END AS v16 FROM \"main\".\"storage_source_clients\" WHERE rowid = ?;",
    "parameters": [
      "native signed int64 rowid from metadata"
    ],
    "bytes": 3213,
    "sha256": "31b94676210c3cf882b33642b768ce9a0501a58e0592108b1da7456cf40980ea"
  },
  {
    "id": "Q-META-FIRST-config_authority",
    "purpose": "First raw row metadata; all properties have fixed small upper bounds",
    "sql": "SELECT rowid AS _rowid, typeof(\"singleton\") AS t0, octet_length(\"singleton\") AS n0, typeof(\"format_version\") AS t1, octet_length(\"format_version\") AS n1, typeof(\"owner\") AS t2, octet_length(\"owner\") AS n2, typeof(\"activation_id\") AS t3, octet_length(\"activation_id\") AS n3, typeof(\"source_binding_ref\") AS t4, octet_length(\"source_binding_ref\") AS n4 FROM \"main\".\"config_authority\" ORDER BY rowid LIMIT 1;",
    "parameters": [],
    "bytes": 405,
    "sha256": "ac98610993ce0b53ed3829455e05be7cbefdaa6015decbfd140de9fe8b539007"
  },
  {
    "id": "Q-META-NEXT-config_authority",
    "purpose": "Next raw row metadata under the same actual read/write transaction",
    "sql": "SELECT rowid AS _rowid, typeof(\"singleton\") AS t0, octet_length(\"singleton\") AS n0, typeof(\"format_version\") AS t1, octet_length(\"format_version\") AS n1, typeof(\"owner\") AS t2, octet_length(\"owner\") AS n2, typeof(\"activation_id\") AS t3, octet_length(\"activation_id\") AS n3, typeof(\"source_binding_ref\") AS t4, octet_length(\"source_binding_ref\") AS n4 FROM \"main\".\"config_authority\" WHERE rowid > ? ORDER BY rowid LIMIT 1;",
    "parameters": [
      "last native signed int64 rowid"
    ],
    "bytes": 421,
    "sha256": "446828549aae7e7e0b05afeb0fc42f9ca7a269960b0243de61127f772e86a1ca"
  },
  {
    "id": "Q-VALUE-config_authority",
    "purpose": "After size/type validation and precharge, exact same-T values; text/blob represented by bytes",
    "sql": "SELECT rowid AS _rowid, CASE typeof(\"singleton\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"singleton\" WHEN 'real' THEN \"singleton\" ELSE lower(hex(CAST(\"singleton\" AS BLOB))) END AS v0, CASE typeof(\"format_version\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"format_version\" WHEN 'real' THEN \"format_version\" ELSE lower(hex(CAST(\"format_version\" AS BLOB))) END AS v1, CASE typeof(\"owner\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"owner\" WHEN 'real' THEN \"owner\" ELSE lower(hex(CAST(\"owner\" AS BLOB))) END AS v2, CASE typeof(\"activation_id\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"activation_id\" WHEN 'real' THEN \"activation_id\" ELSE lower(hex(CAST(\"activation_id\" AS BLOB))) END AS v3, CASE typeof(\"source_binding_ref\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"source_binding_ref\" WHEN 'real' THEN \"source_binding_ref\" ELSE lower(hex(CAST(\"source_binding_ref\" AS BLOB))) END AS v4 FROM \"main\".\"config_authority\" WHERE rowid = ?;",
    "parameters": [
      "native signed int64 rowid from metadata"
    ],
    "bytes": 936,
    "sha256": "441d7d78a37c3558c14d57ff9a6b8eff544ea7379f4471d3d8775324f3c92339"
  },
  {
    "id": "Q-META-FIRST-config_activation_receipts",
    "purpose": "First raw row metadata; all properties have fixed small upper bounds",
    "sql": "SELECT rowid AS _rowid, typeof(\"id\") AS t0, octet_length(\"id\") AS n0, typeof(\"request_id\") AS t1, octet_length(\"request_id\") AS n1, typeof(\"plan_id\") AS t2, octet_length(\"plan_id\") AS n2, typeof(\"plan_digest\") AS t3, octet_length(\"plan_digest\") AS n3, typeof(\"physical_source_ref\") AS t4, octet_length(\"physical_source_ref\") AS n4, typeof(\"snapshot_receipt_ref\") AS t5, octet_length(\"snapshot_receipt_ref\") AS n5, typeof(\"capture_id\") AS t6, octet_length(\"capture_id\") AS n6, typeof(\"capture_source_digest\") AS t7, octet_length(\"capture_source_digest\") AS n7, typeof(\"capture_artifact_digest\") AS t8, octet_length(\"capture_artifact_digest\") AS n8, typeof(\"schema_before_digest\") AS t9, octet_length(\"schema_before_digest\") AS n9, typeof(\"schema_after_digest\") AS t10, octet_length(\"schema_after_digest\") AS n10, typeof(\"guard_transition_json\") AS t11, octet_length(\"guard_transition_json\") AS n11, typeof(\"allowed_delta_ref\") AS t12, octet_length(\"allowed_delta_ref\") AS n12, typeof(\"target_rows_digest\") AS t13, octet_length(\"target_rows_digest\") AS n13, typeof(\"source_to_target_manifest_ref\") AS t14, octet_length(\"source_to_target_manifest_ref\") AS n14, typeof(\"payload_json\") AS t15, octet_length(\"payload_json\") AS n15, typeof(\"payload_digest\") AS t16, octet_length(\"payload_digest\") AS n16 FROM \"main\".\"config_activation_receipts\" ORDER BY rowid LIMIT 1;",
    "parameters": [],
    "bytes": 1361,
    "sha256": "76d364c2b37cbaf3238d9f1491b3ca77b2047bf0489592d733e3c256469fe3d4"
  },
  {
    "id": "Q-META-NEXT-config_activation_receipts",
    "purpose": "Next raw row metadata under the same actual read/write transaction",
    "sql": "SELECT rowid AS _rowid, typeof(\"id\") AS t0, octet_length(\"id\") AS n0, typeof(\"request_id\") AS t1, octet_length(\"request_id\") AS n1, typeof(\"plan_id\") AS t2, octet_length(\"plan_id\") AS n2, typeof(\"plan_digest\") AS t3, octet_length(\"plan_digest\") AS n3, typeof(\"physical_source_ref\") AS t4, octet_length(\"physical_source_ref\") AS n4, typeof(\"snapshot_receipt_ref\") AS t5, octet_length(\"snapshot_receipt_ref\") AS n5, typeof(\"capture_id\") AS t6, octet_length(\"capture_id\") AS n6, typeof(\"capture_source_digest\") AS t7, octet_length(\"capture_source_digest\") AS n7, typeof(\"capture_artifact_digest\") AS t8, octet_length(\"capture_artifact_digest\") AS n8, typeof(\"schema_before_digest\") AS t9, octet_length(\"schema_before_digest\") AS n9, typeof(\"schema_after_digest\") AS t10, octet_length(\"schema_after_digest\") AS n10, typeof(\"guard_transition_json\") AS t11, octet_length(\"guard_transition_json\") AS n11, typeof(\"allowed_delta_ref\") AS t12, octet_length(\"allowed_delta_ref\") AS n12, typeof(\"target_rows_digest\") AS t13, octet_length(\"target_rows_digest\") AS n13, typeof(\"source_to_target_manifest_ref\") AS t14, octet_length(\"source_to_target_manifest_ref\") AS n14, typeof(\"payload_json\") AS t15, octet_length(\"payload_json\") AS n15, typeof(\"payload_digest\") AS t16, octet_length(\"payload_digest\") AS n16 FROM \"main\".\"config_activation_receipts\" WHERE rowid > ? ORDER BY rowid LIMIT 1;",
    "parameters": [
      "last native signed int64 rowid"
    ],
    "bytes": 1377,
    "sha256": "eea19d3794fab2c570bd2f9b43b83b5d1e14e03c96908829115cae985c39dd73"
  },
  {
    "id": "Q-VALUE-config_activation_receipts",
    "purpose": "After size/type validation and precharge, exact same-T values; text/blob represented by bytes",
    "sql": "SELECT rowid AS _rowid, CASE typeof(\"id\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"id\" WHEN 'real' THEN \"id\" ELSE lower(hex(CAST(\"id\" AS BLOB))) END AS v0, CASE typeof(\"request_id\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"request_id\" WHEN 'real' THEN \"request_id\" ELSE lower(hex(CAST(\"request_id\" AS BLOB))) END AS v1, CASE typeof(\"plan_id\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"plan_id\" WHEN 'real' THEN \"plan_id\" ELSE lower(hex(CAST(\"plan_id\" AS BLOB))) END AS v2, CASE typeof(\"plan_digest\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"plan_digest\" WHEN 'real' THEN \"plan_digest\" ELSE lower(hex(CAST(\"plan_digest\" AS BLOB))) END AS v3, CASE typeof(\"physical_source_ref\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"physical_source_ref\" WHEN 'real' THEN \"physical_source_ref\" ELSE lower(hex(CAST(\"physical_source_ref\" AS BLOB))) END AS v4, CASE typeof(\"snapshot_receipt_ref\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"snapshot_receipt_ref\" WHEN 'real' THEN \"snapshot_receipt_ref\" ELSE lower(hex(CAST(\"snapshot_receipt_ref\" AS BLOB))) END AS v5, CASE typeof(\"capture_id\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"capture_id\" WHEN 'real' THEN \"capture_id\" ELSE lower(hex(CAST(\"capture_id\" AS BLOB))) END AS v6, CASE typeof(\"capture_source_digest\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"capture_source_digest\" WHEN 'real' THEN \"capture_source_digest\" ELSE lower(hex(CAST(\"capture_source_digest\" AS BLOB))) END AS v7, CASE typeof(\"capture_artifact_digest\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"capture_artifact_digest\" WHEN 'real' THEN \"capture_artifact_digest\" ELSE lower(hex(CAST(\"capture_artifact_digest\" AS BLOB))) END AS v8, CASE typeof(\"schema_before_digest\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"schema_before_digest\" WHEN 'real' THEN \"schema_before_digest\" ELSE lower(hex(CAST(\"schema_before_digest\" AS BLOB))) END AS v9, CASE typeof(\"schema_after_digest\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"schema_after_digest\" WHEN 'real' THEN \"schema_after_digest\" ELSE lower(hex(CAST(\"schema_after_digest\" AS BLOB))) END AS v10, CASE typeof(\"guard_transition_json\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"guard_transition_json\" WHEN 'real' THEN \"guard_transition_json\" ELSE lower(hex(CAST(\"guard_transition_json\" AS BLOB))) END AS v11, CASE typeof(\"allowed_delta_ref\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"allowed_delta_ref\" WHEN 'real' THEN \"allowed_delta_ref\" ELSE lower(hex(CAST(\"allowed_delta_ref\" AS BLOB))) END AS v12, CASE typeof(\"target_rows_digest\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"target_rows_digest\" WHEN 'real' THEN \"target_rows_digest\" ELSE lower(hex(CAST(\"target_rows_digest\" AS BLOB))) END AS v13, CASE typeof(\"source_to_target_manifest_ref\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"source_to_target_manifest_ref\" WHEN 'real' THEN \"source_to_target_manifest_ref\" ELSE lower(hex(CAST(\"source_to_target_manifest_ref\" AS BLOB))) END AS v14, CASE typeof(\"payload_json\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"payload_json\" WHEN 'real' THEN \"payload_json\" ELSE lower(hex(CAST(\"payload_json\" AS BLOB))) END AS v15, CASE typeof(\"payload_digest\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"payload_digest\" WHEN 'real' THEN \"payload_digest\" ELSE lower(hex(CAST(\"payload_digest\" AS BLOB))) END AS v16 FROM \"main\".\"config_activation_receipts\" WHERE rowid = ?;",
    "parameters": [
      "native signed int64 rowid from metadata"
    ],
    "bytes": 3321,
    "sha256": "5d6c50f1e4e11c022934ac31fe5a32cf4d8811d254bb1ea8b9a9852517fa9c54"
  },
  {
    "id": "Q-META-FIRST-schema_migrations",
    "purpose": "First raw row metadata; all properties have fixed small upper bounds",
    "sql": "SELECT rowid AS _rowid, typeof(\"version\") AS t0, octet_length(\"version\") AS n0, typeof(\"name\") AS t1, octet_length(\"name\") AS n1, typeof(\"checksum\") AS t2, octet_length(\"checksum\") AS n2, typeof(\"applied_at\") AS t3, octet_length(\"applied_at\") AS n3 FROM \"main\".\"schema_migrations\" ORDER BY rowid LIMIT 1;",
    "parameters": [],
    "bytes": 304,
    "sha256": "e7f42de6c5dfcdeaf52d8664bb3b61fea47baa70204b354e2999bafdf331db2c"
  },
  {
    "id": "Q-META-NEXT-schema_migrations",
    "purpose": "Next raw row metadata under the same actual read/write transaction",
    "sql": "SELECT rowid AS _rowid, typeof(\"version\") AS t0, octet_length(\"version\") AS n0, typeof(\"name\") AS t1, octet_length(\"name\") AS n1, typeof(\"checksum\") AS t2, octet_length(\"checksum\") AS n2, typeof(\"applied_at\") AS t3, octet_length(\"applied_at\") AS n3 FROM \"main\".\"schema_migrations\" WHERE rowid > ? ORDER BY rowid LIMIT 1;",
    "parameters": [
      "last native signed int64 rowid"
    ],
    "bytes": 320,
    "sha256": "afabd228b97c0e85ae92c8cf0464ccc726e6d514465310023501a90ac3864a73"
  },
  {
    "id": "Q-VALUE-schema_migrations",
    "purpose": "After size/type validation and precharge, exact same-T values; text/blob represented by bytes",
    "sql": "SELECT rowid AS _rowid, CASE typeof(\"version\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"version\" WHEN 'real' THEN \"version\" ELSE lower(hex(CAST(\"version\" AS BLOB))) END AS v0, CASE typeof(\"name\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"name\" WHEN 'real' THEN \"name\" ELSE lower(hex(CAST(\"name\" AS BLOB))) END AS v1, CASE typeof(\"checksum\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"checksum\" WHEN 'real' THEN \"checksum\" ELSE lower(hex(CAST(\"checksum\" AS BLOB))) END AS v2, CASE typeof(\"applied_at\") WHEN 'null' THEN NULL WHEN 'integer' THEN \"applied_at\" WHEN 'real' THEN \"applied_at\" ELSE lower(hex(CAST(\"applied_at\" AS BLOB))) END AS v3 FROM \"main\".\"schema_migrations\" WHERE rowid = ?;",
    "parameters": [
      "native signed int64 rowid from metadata"
    ],
    "bytes": 691,
    "sha256": "af23c218fe60c71571aa22cc1798008ce8760941c56c1c9102df889327912266"
  },
  {
    "id": "C-NEXT-ROWID",
    "purpose": "Under BEGIN IMMEDIATE; use 1 for empty/negative-only; max+1 otherwise, reject int64 exhaustion",
    "sql": "SELECT max(rowid) AS maximum FROM \"main\".\"storage_source_clients\";",
    "parameters": [],
    "bytes": 66,
    "sha256": "c1c1bc797c3b818530eda58f1e361de8d65e6037e6bc80923f2f089c812fc484"
  },
  {
    "id": "C-BIRTH",
    "purpose": "Private fixed factory derives every cell; explicit rowid prevents BEFORE INSERT unknown NEW.rowid",
    "sql": "INSERT INTO \"main\".\"storage_source_clients\" (rowid, \"client_id\", \"database_instance_id\", \"entrypoint\", \"build_id\", \"protocol_version\", \"host_identity_json\", \"process_identity_json\", \"db_sessions_json\", \"registered_epoch\", \"observed_epoch\", \"drain_epoch\", \"drain_state\", \"drain_receipt_digest\", \"registered_at\", \"last_observed_at\", \"ended_at\", \"writer_format_digest\") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
    "parameters": [
      "private native allocated rowid",
      "private birth.client_id",
      "private birth.database_instance_id",
      "private birth.entrypoint",
      "private birth.build_id",
      "private birth.protocol_version",
      "private birth.host_identity_json",
      "private birth.process_identity_json",
      "private birth.db_sessions_json",
      "private birth.registered_epoch",
      "private birth.observed_epoch",
      "private birth.drain_epoch",
      "private birth.drain_state",
      "private birth.drain_receipt_digest",
      "private birth.registered_at",
      "private birth.last_observed_at",
      "private birth.ended_at",
      "private birth.writer_format_digest"
    ],
    "bytes": 429,
    "sha256": "762434e863e2a418c18c78dd007ec25e771551cc8c8ff1bd9b3732d5d54ddc87"
  },
  {
    "id": "C-ORD-OBSERVE",
    "purpose": "Only selected fixed owner program; full typed 17-cell/rowid CAS plus actual same-T singleton check outside SQL",
    "sql": "UPDATE \"main\".\"storage_source_clients\" SET \"observed_epoch\" = @new_observed_epoch, \"last_observed_at\" = @new_last_observed_at WHERE rowid IS @oldRowid AND (typeof(\"client_id\") IS @t0 AND (\"client_id\" COLLATE BINARY) IS @v0) AND (typeof(\"database_instance_id\") IS @t1 AND (\"database_instance_id\" COLLATE BINARY) IS @v1) AND (typeof(\"entrypoint\") IS @t2 AND (\"entrypoint\" COLLATE BINARY) IS @v2) AND (typeof(\"build_id\") IS @t3 AND (\"build_id\" COLLATE BINARY) IS @v3) AND (typeof(\"protocol_version\") IS @t4 AND (\"protocol_version\" COLLATE BINARY) IS @v4) AND (typeof(\"host_identity_json\") IS @t5 AND (\"host_identity_json\" COLLATE BINARY) IS @v5) AND (typeof(\"process_identity_json\") IS @t6 AND (\"process_identity_json\" COLLATE BINARY) IS @v6) AND (typeof(\"db_sessions_json\") IS @t7 AND (\"db_sessions_json\" COLLATE BINARY) IS @v7) AND (typeof(\"registered_epoch\") IS @t8 AND (\"registered_epoch\" COLLATE BINARY) IS @v8) AND (typeof(\"observed_epoch\") IS @t9 AND (\"observed_epoch\" COLLATE BINARY) IS @v9) AND (typeof(\"drain_epoch\") IS @t10 AND (\"drain_epoch\" COLLATE BINARY) IS @v10) AND (typeof(\"drain_state\") IS @t11 AND (\"drain_state\" COLLATE BINARY) IS @v11) AND (typeof(\"drain_receipt_digest\") IS @t12 AND (\"drain_receipt_digest\" COLLATE BINARY) IS @v12) AND (typeof(\"registered_at\") IS @t13 AND (\"registered_at\" COLLATE BINARY) IS @v13) AND (typeof(\"last_observed_at\") IS @t14 AND (\"last_observed_at\" COLLATE BINARY) IS @v14) AND (typeof(\"ended_at\") IS @t15 AND (\"ended_at\" COLLATE BINARY) IS @v15) AND (typeof(\"writer_format_digest\") IS @t16 AND (\"writer_format_digest\" COLLATE BINARY) IS @v16);",
    "parameters": [
      "oldRowid",
      "t0..t16 fixed sqlite storage classes",
      "v0..v16 exact decoded native preimage",
      "new_observed_epoch",
      "new_last_observed_at"
    ],
    "bytes": 1594,
    "sha256": "580ef8ce7efffc40abb6dc7371a93319bd6a248f413a0a7167100161135a76fc"
  },
  {
    "id": "C-ORD-DRAIN-BEGIN",
    "purpose": "Only selected fixed owner program; full typed 17-cell/rowid CAS plus actual same-T singleton check outside SQL",
    "sql": "UPDATE \"main\".\"storage_source_clients\" SET \"observed_epoch\" = @new_observed_epoch, \"drain_epoch\" = @new_drain_epoch, \"drain_state\" = @new_drain_state, \"last_observed_at\" = @new_last_observed_at WHERE rowid IS @oldRowid AND (typeof(\"client_id\") IS @t0 AND (\"client_id\" COLLATE BINARY) IS @v0) AND (typeof(\"database_instance_id\") IS @t1 AND (\"database_instance_id\" COLLATE BINARY) IS @v1) AND (typeof(\"entrypoint\") IS @t2 AND (\"entrypoint\" COLLATE BINARY) IS @v2) AND (typeof(\"build_id\") IS @t3 AND (\"build_id\" COLLATE BINARY) IS @v3) AND (typeof(\"protocol_version\") IS @t4 AND (\"protocol_version\" COLLATE BINARY) IS @v4) AND (typeof(\"host_identity_json\") IS @t5 AND (\"host_identity_json\" COLLATE BINARY) IS @v5) AND (typeof(\"process_identity_json\") IS @t6 AND (\"process_identity_json\" COLLATE BINARY) IS @v6) AND (typeof(\"db_sessions_json\") IS @t7 AND (\"db_sessions_json\" COLLATE BINARY) IS @v7) AND (typeof(\"registered_epoch\") IS @t8 AND (\"registered_epoch\" COLLATE BINARY) IS @v8) AND (typeof(\"observed_epoch\") IS @t9 AND (\"observed_epoch\" COLLATE BINARY) IS @v9) AND (typeof(\"drain_epoch\") IS @t10 AND (\"drain_epoch\" COLLATE BINARY) IS @v10) AND (typeof(\"drain_state\") IS @t11 AND (\"drain_state\" COLLATE BINARY) IS @v11) AND (typeof(\"drain_receipt_digest\") IS @t12 AND (\"drain_receipt_digest\" COLLATE BINARY) IS @v12) AND (typeof(\"registered_at\") IS @t13 AND (\"registered_at\" COLLATE BINARY) IS @v13) AND (typeof(\"last_observed_at\") IS @t14 AND (\"last_observed_at\" COLLATE BINARY) IS @v14) AND (typeof(\"ended_at\") IS @t15 AND (\"ended_at\" COLLATE BINARY) IS @v15) AND (typeof(\"writer_format_digest\") IS @t16 AND (\"writer_format_digest\" COLLATE BINARY) IS @v16);",
    "parameters": [
      "oldRowid",
      "t0..t16 fixed sqlite storage classes",
      "v0..v16 exact decoded native preimage",
      "new_observed_epoch",
      "new_drain_epoch",
      "new_drain_state",
      "new_last_observed_at"
    ],
    "bytes": 1662,
    "sha256": "d6b98e3d957ad582f11fccbe913bffc2b2115db6fb61e97cfc6914a6ce86db2e"
  },
  {
    "id": "C-ORD-DRAIN-END",
    "purpose": "Only selected fixed owner program; full typed 17-cell/rowid CAS plus actual same-T singleton check outside SQL",
    "sql": "UPDATE \"main\".\"storage_source_clients\" SET \"observed_epoch\" = @new_observed_epoch, \"drain_epoch\" = @new_drain_epoch, \"drain_state\" = @new_drain_state, \"drain_receipt_digest\" = @new_drain_receipt_digest, \"db_sessions_json\" = @new_db_sessions_json, \"last_observed_at\" = @new_last_observed_at WHERE rowid IS @oldRowid AND (typeof(\"client_id\") IS @t0 AND (\"client_id\" COLLATE BINARY) IS @v0) AND (typeof(\"database_instance_id\") IS @t1 AND (\"database_instance_id\" COLLATE BINARY) IS @v1) AND (typeof(\"entrypoint\") IS @t2 AND (\"entrypoint\" COLLATE BINARY) IS @v2) AND (typeof(\"build_id\") IS @t3 AND (\"build_id\" COLLATE BINARY) IS @v3) AND (typeof(\"protocol_version\") IS @t4 AND (\"protocol_version\" COLLATE BINARY) IS @v4) AND (typeof(\"host_identity_json\") IS @t5 AND (\"host_identity_json\" COLLATE BINARY) IS @v5) AND (typeof(\"process_identity_json\") IS @t6 AND (\"process_identity_json\" COLLATE BINARY) IS @v6) AND (typeof(\"db_sessions_json\") IS @t7 AND (\"db_sessions_json\" COLLATE BINARY) IS @v7) AND (typeof(\"registered_epoch\") IS @t8 AND (\"registered_epoch\" COLLATE BINARY) IS @v8) AND (typeof(\"observed_epoch\") IS @t9 AND (\"observed_epoch\" COLLATE BINARY) IS @v9) AND (typeof(\"drain_epoch\") IS @t10 AND (\"drain_epoch\" COLLATE BINARY) IS @v10) AND (typeof(\"drain_state\") IS @t11 AND (\"drain_state\" COLLATE BINARY) IS @v11) AND (typeof(\"drain_receipt_digest\") IS @t12 AND (\"drain_receipt_digest\" COLLATE BINARY) IS @v12) AND (typeof(\"registered_at\") IS @t13 AND (\"registered_at\" COLLATE BINARY) IS @v13) AND (typeof(\"last_observed_at\") IS @t14 AND (\"last_observed_at\" COLLATE BINARY) IS @v14) AND (typeof(\"ended_at\") IS @t15 AND (\"ended_at\" COLLATE BINARY) IS @v15) AND (typeof(\"writer_format_digest\") IS @t16 AND (\"writer_format_digest\" COLLATE BINARY) IS @v16);",
    "parameters": [
      "oldRowid",
      "t0..t16 fixed sqlite storage classes",
      "v0..v16 exact decoded native preimage",
      "new_observed_epoch",
      "new_drain_epoch",
      "new_drain_state",
      "new_drain_receipt_digest",
      "new_db_sessions_json",
      "new_last_observed_at"
    ],
    "bytes": 1758,
    "sha256": "769dbc91f2a399285c0d39de4c2c62938085a3bbcd2a13f3dcafb30b804b9a1c"
  },
  {
    "id": "C-ORD-END",
    "purpose": "Only selected fixed owner program; full typed 17-cell/rowid CAS plus actual same-T singleton check outside SQL",
    "sql": "UPDATE \"main\".\"storage_source_clients\" SET \"last_observed_at\" = @new_last_observed_at, \"ended_at\" = @new_ended_at WHERE rowid IS @oldRowid AND (typeof(\"client_id\") IS @t0 AND (\"client_id\" COLLATE BINARY) IS @v0) AND (typeof(\"database_instance_id\") IS @t1 AND (\"database_instance_id\" COLLATE BINARY) IS @v1) AND (typeof(\"entrypoint\") IS @t2 AND (\"entrypoint\" COLLATE BINARY) IS @v2) AND (typeof(\"build_id\") IS @t3 AND (\"build_id\" COLLATE BINARY) IS @v3) AND (typeof(\"protocol_version\") IS @t4 AND (\"protocol_version\" COLLATE BINARY) IS @v4) AND (typeof(\"host_identity_json\") IS @t5 AND (\"host_identity_json\" COLLATE BINARY) IS @v5) AND (typeof(\"process_identity_json\") IS @t6 AND (\"process_identity_json\" COLLATE BINARY) IS @v6) AND (typeof(\"db_sessions_json\") IS @t7 AND (\"db_sessions_json\" COLLATE BINARY) IS @v7) AND (typeof(\"registered_epoch\") IS @t8 AND (\"registered_epoch\" COLLATE BINARY) IS @v8) AND (typeof(\"observed_epoch\") IS @t9 AND (\"observed_epoch\" COLLATE BINARY) IS @v9) AND (typeof(\"drain_epoch\") IS @t10 AND (\"drain_epoch\" COLLATE BINARY) IS @v10) AND (typeof(\"drain_state\") IS @t11 AND (\"drain_state\" COLLATE BINARY) IS @v11) AND (typeof(\"drain_receipt_digest\") IS @t12 AND (\"drain_receipt_digest\" COLLATE BINARY) IS @v12) AND (typeof(\"registered_at\") IS @t13 AND (\"registered_at\" COLLATE BINARY) IS @v13) AND (typeof(\"last_observed_at\") IS @t14 AND (\"last_observed_at\" COLLATE BINARY) IS @v14) AND (typeof(\"ended_at\") IS @t15 AND (\"ended_at\" COLLATE BINARY) IS @v15) AND (typeof(\"writer_format_digest\") IS @t16 AND (\"writer_format_digest\" COLLATE BINARY) IS @v16);",
    "parameters": [
      "oldRowid",
      "t0..t16 fixed sqlite storage classes",
      "v0..v16 exact decoded native preimage",
      "new_last_observed_at",
      "new_ended_at"
    ],
    "bytes": 1582,
    "sha256": "142273289539b4d035ab455a51830f276cc1d3fc20a06e4ca63a25148f63fdd9"
  },
  {
    "id": "C-MAINT-OBSERVE",
    "purpose": "Only selected fixed owner program; full typed 17-cell/rowid CAS plus actual same-T singleton check outside SQL",
    "sql": "UPDATE \"main\".\"storage_source_clients\" SET \"last_observed_at\" = @new_last_observed_at WHERE rowid IS @oldRowid AND (typeof(\"client_id\") IS @t0 AND (\"client_id\" COLLATE BINARY) IS @v0) AND (typeof(\"database_instance_id\") IS @t1 AND (\"database_instance_id\" COLLATE BINARY) IS @v1) AND (typeof(\"entrypoint\") IS @t2 AND (\"entrypoint\" COLLATE BINARY) IS @v2) AND (typeof(\"build_id\") IS @t3 AND (\"build_id\" COLLATE BINARY) IS @v3) AND (typeof(\"protocol_version\") IS @t4 AND (\"protocol_version\" COLLATE BINARY) IS @v4) AND (typeof(\"host_identity_json\") IS @t5 AND (\"host_identity_json\" COLLATE BINARY) IS @v5) AND (typeof(\"process_identity_json\") IS @t6 AND (\"process_identity_json\" COLLATE BINARY) IS @v6) AND (typeof(\"db_sessions_json\") IS @t7 AND (\"db_sessions_json\" COLLATE BINARY) IS @v7) AND (typeof(\"registered_epoch\") IS @t8 AND (\"registered_epoch\" COLLATE BINARY) IS @v8) AND (typeof(\"observed_epoch\") IS @t9 AND (\"observed_epoch\" COLLATE BINARY) IS @v9) AND (typeof(\"drain_epoch\") IS @t10 AND (\"drain_epoch\" COLLATE BINARY) IS @v10) AND (typeof(\"drain_state\") IS @t11 AND (\"drain_state\" COLLATE BINARY) IS @v11) AND (typeof(\"drain_receipt_digest\") IS @t12 AND (\"drain_receipt_digest\" COLLATE BINARY) IS @v12) AND (typeof(\"registered_at\") IS @t13 AND (\"registered_at\" COLLATE BINARY) IS @v13) AND (typeof(\"last_observed_at\") IS @t14 AND (\"last_observed_at\" COLLATE BINARY) IS @v14) AND (typeof(\"ended_at\") IS @t15 AND (\"ended_at\" COLLATE BINARY) IS @v15) AND (typeof(\"writer_format_digest\") IS @t16 AND (\"writer_format_digest\" COLLATE BINARY) IS @v16);",
    "parameters": [
      "oldRowid",
      "t0..t16 fixed sqlite storage classes",
      "v0..v16 exact decoded native preimage",
      "new_last_observed_at"
    ],
    "bytes": 1554,
    "sha256": "3d7f9315a38239014562ee14a818898431e50a628264d9b717f2c21ad319f0ef"
  },
  {
    "id": "C-MAINT-ENDED-OBSERVATION",
    "purpose": "Only selected fixed owner program; full typed 17-cell/rowid CAS plus actual same-T singleton check outside SQL",
    "sql": "UPDATE \"main\".\"storage_source_clients\" SET \"last_observed_at\" = @new_last_observed_at, \"ended_at\" = @new_ended_at WHERE rowid IS @oldRowid AND (typeof(\"client_id\") IS @t0 AND (\"client_id\" COLLATE BINARY) IS @v0) AND (typeof(\"database_instance_id\") IS @t1 AND (\"database_instance_id\" COLLATE BINARY) IS @v1) AND (typeof(\"entrypoint\") IS @t2 AND (\"entrypoint\" COLLATE BINARY) IS @v2) AND (typeof(\"build_id\") IS @t3 AND (\"build_id\" COLLATE BINARY) IS @v3) AND (typeof(\"protocol_version\") IS @t4 AND (\"protocol_version\" COLLATE BINARY) IS @v4) AND (typeof(\"host_identity_json\") IS @t5 AND (\"host_identity_json\" COLLATE BINARY) IS @v5) AND (typeof(\"process_identity_json\") IS @t6 AND (\"process_identity_json\" COLLATE BINARY) IS @v6) AND (typeof(\"db_sessions_json\") IS @t7 AND (\"db_sessions_json\" COLLATE BINARY) IS @v7) AND (typeof(\"registered_epoch\") IS @t8 AND (\"registered_epoch\" COLLATE BINARY) IS @v8) AND (typeof(\"observed_epoch\") IS @t9 AND (\"observed_epoch\" COLLATE BINARY) IS @v9) AND (typeof(\"drain_epoch\") IS @t10 AND (\"drain_epoch\" COLLATE BINARY) IS @v10) AND (typeof(\"drain_state\") IS @t11 AND (\"drain_state\" COLLATE BINARY) IS @v11) AND (typeof(\"drain_receipt_digest\") IS @t12 AND (\"drain_receipt_digest\" COLLATE BINARY) IS @v12) AND (typeof(\"registered_at\") IS @t13 AND (\"registered_at\" COLLATE BINARY) IS @v13) AND (typeof(\"last_observed_at\") IS @t14 AND (\"last_observed_at\" COLLATE BINARY) IS @v14) AND (typeof(\"ended_at\") IS @t15 AND (\"ended_at\" COLLATE BINARY) IS @v15) AND (typeof(\"writer_format_digest\") IS @t16 AND (\"writer_format_digest\" COLLATE BINARY) IS @v16);",
    "parameters": [
      "oldRowid",
      "t0..t16 fixed sqlite storage classes",
      "v0..v16 exact decoded native preimage",
      "new_last_observed_at",
      "new_ended_at"
    ],
    "bytes": 1582,
    "sha256": "142273289539b4d035ab455a51830f276cc1d3fc20a06e4ca63a25148f63fdd9"
  },
  {
    "id": "C-NATIVE-END-OPEN",
    "purpose": "Only selected fixed owner program; full typed 17-cell/rowid CAS plus actual same-T singleton check outside SQL",
    "sql": "UPDATE \"main\".\"storage_source_clients\" SET \"db_sessions_json\" = @new_db_sessions_json, \"observed_epoch\" = @new_observed_epoch, \"drain_epoch\" = @new_drain_epoch, \"drain_state\" = @new_drain_state, \"drain_receipt_digest\" = @new_drain_receipt_digest, \"last_observed_at\" = @new_last_observed_at, \"ended_at\" = @new_ended_at WHERE rowid IS @oldRowid AND (typeof(\"client_id\") IS @t0 AND (\"client_id\" COLLATE BINARY) IS @v0) AND (typeof(\"database_instance_id\") IS @t1 AND (\"database_instance_id\" COLLATE BINARY) IS @v1) AND (typeof(\"entrypoint\") IS @t2 AND (\"entrypoint\" COLLATE BINARY) IS @v2) AND (typeof(\"build_id\") IS @t3 AND (\"build_id\" COLLATE BINARY) IS @v3) AND (typeof(\"protocol_version\") IS @t4 AND (\"protocol_version\" COLLATE BINARY) IS @v4) AND (typeof(\"host_identity_json\") IS @t5 AND (\"host_identity_json\" COLLATE BINARY) IS @v5) AND (typeof(\"process_identity_json\") IS @t6 AND (\"process_identity_json\" COLLATE BINARY) IS @v6) AND (typeof(\"db_sessions_json\") IS @t7 AND (\"db_sessions_json\" COLLATE BINARY) IS @v7) AND (typeof(\"registered_epoch\") IS @t8 AND (\"registered_epoch\" COLLATE BINARY) IS @v8) AND (typeof(\"observed_epoch\") IS @t9 AND (\"observed_epoch\" COLLATE BINARY) IS @v9) AND (typeof(\"drain_epoch\") IS @t10 AND (\"drain_epoch\" COLLATE BINARY) IS @v10) AND (typeof(\"drain_state\") IS @t11 AND (\"drain_state\" COLLATE BINARY) IS @v11) AND (typeof(\"drain_receipt_digest\") IS @t12 AND (\"drain_receipt_digest\" COLLATE BINARY) IS @v12) AND (typeof(\"registered_at\") IS @t13 AND (\"registered_at\" COLLATE BINARY) IS @v13) AND (typeof(\"last_observed_at\") IS @t14 AND (\"last_observed_at\" COLLATE BINARY) IS @v14) AND (typeof(\"ended_at\") IS @t15 AND (\"ended_at\" COLLATE BINARY) IS @v15) AND (typeof(\"writer_format_digest\") IS @t16 AND (\"writer_format_digest\" COLLATE BINARY) IS @v16);",
    "parameters": [
      "oldRowid",
      "t0..t16 fixed sqlite storage classes",
      "v0..v16 exact decoded native preimage",
      "new_db_sessions_json",
      "new_observed_epoch",
      "new_drain_epoch",
      "new_drain_state",
      "new_drain_receipt_digest",
      "new_last_observed_at",
      "new_ended_at"
    ],
    "bytes": 1786,
    "sha256": "ebfe85b8f4cc4fc65b73859274d022a9f8650a9bf3455a187f2c7e3d341c73ef"
  },
  {
    "id": "C-NATIVE-END-DRAIN",
    "purpose": "Only selected fixed owner program; full typed 17-cell/rowid CAS plus actual same-T singleton check outside SQL",
    "sql": "UPDATE \"main\".\"storage_source_clients\" SET \"db_sessions_json\" = @new_db_sessions_json, \"observed_epoch\" = @new_observed_epoch, \"drain_epoch\" = @new_drain_epoch, \"drain_state\" = @new_drain_state, \"drain_receipt_digest\" = @new_drain_receipt_digest, \"last_observed_at\" = @new_last_observed_at, \"ended_at\" = @new_ended_at WHERE rowid IS @oldRowid AND (typeof(\"client_id\") IS @t0 AND (\"client_id\" COLLATE BINARY) IS @v0) AND (typeof(\"database_instance_id\") IS @t1 AND (\"database_instance_id\" COLLATE BINARY) IS @v1) AND (typeof(\"entrypoint\") IS @t2 AND (\"entrypoint\" COLLATE BINARY) IS @v2) AND (typeof(\"build_id\") IS @t3 AND (\"build_id\" COLLATE BINARY) IS @v3) AND (typeof(\"protocol_version\") IS @t4 AND (\"protocol_version\" COLLATE BINARY) IS @v4) AND (typeof(\"host_identity_json\") IS @t5 AND (\"host_identity_json\" COLLATE BINARY) IS @v5) AND (typeof(\"process_identity_json\") IS @t6 AND (\"process_identity_json\" COLLATE BINARY) IS @v6) AND (typeof(\"db_sessions_json\") IS @t7 AND (\"db_sessions_json\" COLLATE BINARY) IS @v7) AND (typeof(\"registered_epoch\") IS @t8 AND (\"registered_epoch\" COLLATE BINARY) IS @v8) AND (typeof(\"observed_epoch\") IS @t9 AND (\"observed_epoch\" COLLATE BINARY) IS @v9) AND (typeof(\"drain_epoch\") IS @t10 AND (\"drain_epoch\" COLLATE BINARY) IS @v10) AND (typeof(\"drain_state\") IS @t11 AND (\"drain_state\" COLLATE BINARY) IS @v11) AND (typeof(\"drain_receipt_digest\") IS @t12 AND (\"drain_receipt_digest\" COLLATE BINARY) IS @v12) AND (typeof(\"registered_at\") IS @t13 AND (\"registered_at\" COLLATE BINARY) IS @v13) AND (typeof(\"last_observed_at\") IS @t14 AND (\"last_observed_at\" COLLATE BINARY) IS @v14) AND (typeof(\"ended_at\") IS @t15 AND (\"ended_at\" COLLATE BINARY) IS @v15) AND (typeof(\"writer_format_digest\") IS @t16 AND (\"writer_format_digest\" COLLATE BINARY) IS @v16);",
    "parameters": [
      "oldRowid",
      "t0..t16 fixed sqlite storage classes",
      "v0..v16 exact decoded native preimage",
      "new_db_sessions_json",
      "new_observed_epoch",
      "new_drain_epoch",
      "new_drain_state",
      "new_drain_receipt_digest",
      "new_last_observed_at",
      "new_ended_at"
    ],
    "bytes": 1786,
    "sha256": "ebfe85b8f4cc4fc65b73859274d022a9f8650a9bf3455a187f2c7e3d341c73ef"
  },
  {
    "id": "C-BEGIN",
    "purpose": "Actual write transaction for B or C, never a caller callback",
    "sql": "BEGIN IMMEDIATE;",
    "parameters": [],
    "bytes": 16,
    "sha256": "daf327e077218da27ea7bc358ecc72da8103c4b3a380e60b62c33d0524afb15a"
  },
  {
    "id": "C-COMMIT",
    "purpose": "Only after full postconditions and source/owner recheck",
    "sql": "COMMIT;",
    "parameters": [],
    "bytes": 7,
    "sha256": "2db35aa37c4005aa96055e900adc9bfbbd70d106820fefcb83216b7cc3f95422"
  },
  {
    "id": "C-ROLLBACK",
    "purpose": "Retirement/control failure path; a thrown result remains unknown until actual observation",
    "sql": "ROLLBACK;",
    "parameters": [],
    "bytes": 9,
    "sha256": "9be868b5fc7744c6a5fa794bedc41fd4f93c13f4ccbc84805546b17682d2505c"
  }
]);
const componentBytes = JSON.stringify({ tables: SQLITE_PROFILE_READ_TABLES, statements: SQLITE_PROFILE_FIXED_QUERIES });
export const SQLITE_PROFILE_READ_COMPONENT = freeze({
  contract: "sqlite-profile-read-source-component/v1", scope: "fixed-query-source-only",
  acceptedSource: { bytes: 66179, sha256: "802d88a34b9ac31f22072fb8a95e05e3e009e5558b4a61d12392e6e895d62713" },
  acceptedDesign: { issue: 153, comment: 7026485094,
    freezeSha256: "a7fef17604584cdac138aedb1488e1c802378f66a76a7d4eedeb9c81dcb02141" },
  bytes: Buffer.byteLength(componentBytes), sha256: createHash("sha256").update(componentBytes).digest("hex"),
  queries: 32, readonlyQueries: 19, tables: 5, columns: 58,
  finalTargetSchema: null, finalGuardManifest: null, productionAdmission: "not-issued",
});

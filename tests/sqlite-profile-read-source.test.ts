import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { SQLITE_PROFILE_FIXED_QUERIES as queries, SQLITE_PROFILE_READ_TABLES as tables,
  SQLITE_PROFILE_READ_COMPONENT as component, SQLITE_PROFILE_COLUMN_QUERIES as columnQueries } from "../src/server/storage/internal/sqlite-profile-read-source.ts";

// Original accepted SQ-D02 FIXED-QUERY-SOURCE.json identities, not regenerated from this implementation.
const expected = [
  [
    "Q-SOURCE",
    61,
    "f96974122e1970b254632e22aaac391ed19cdbec74a1eb94654bfd16443776aa"
  ],
  [
    "Q-ENCODING",
    21,
    "246885a78b780b81623aaa496cb00524829bf88ad1ed1730c8595925414ca576"
  ],
  [
    "Q-SCHEMA-VERSION",
    27,
    "02ed68f5a147a4d5817b9507e6b5db4c077fffb552614263253186b251b0290f"
  ],
  [
    "Q-FK-MODE",
    20,
    "675de3ed5c2c6c5846ad0a0dc0cefc2a6ee01c7dfcbccd8f46bd0876e3de973e"
  ],
  [
    "Q-META-FIRST-storage_maintenance",
    1212,
    "4b83c39e008476f49077a57afbbc6e2286ca3328d5f60909828b67c18f9922f6"
  ],
  [
    "Q-META-NEXT-storage_maintenance",
    1228,
    "703482e8b4eb713ab5117ae7caae546e6403b16791520448d77defae18231f4f"
  ],
  [
    "Q-VALUE-storage_maintenance",
    2952,
    "3af59a871e309f6ba677b85153c50ccdac28ebba2025a92bd68e2b0b7ff74cd6"
  ],
  [
    "Q-META-FIRST-storage_source_clients",
    1305,
    "a58f6e92b78119582f3a4c3d820e43e0a7742a7c5534e6565207c9c47d1b505f"
  ],
  [
    "Q-META-NEXT-storage_source_clients",
    1321,
    "39b294282a13038ac00bee83583727bbe492c50b00d9950854426013705bf6c0"
  ],
  [
    "Q-VALUE-storage_source_clients",
    3213,
    "31b94676210c3cf882b33642b768ce9a0501a58e0592108b1da7456cf40980ea"
  ],
  [
    "Q-META-FIRST-config_authority",
    405,
    "ac98610993ce0b53ed3829455e05be7cbefdaa6015decbfd140de9fe8b539007"
  ],
  [
    "Q-META-NEXT-config_authority",
    421,
    "446828549aae7e7e0b05afeb0fc42f9ca7a269960b0243de61127f772e86a1ca"
  ],
  [
    "Q-VALUE-config_authority",
    936,
    "441d7d78a37c3558c14d57ff9a6b8eff544ea7379f4471d3d8775324f3c92339"
  ],
  [
    "Q-META-FIRST-config_activation_receipts",
    1361,
    "76d364c2b37cbaf3238d9f1491b3ca77b2047bf0489592d733e3c256469fe3d4"
  ],
  [
    "Q-META-NEXT-config_activation_receipts",
    1377,
    "eea19d3794fab2c570bd2f9b43b83b5d1e14e03c96908829115cae985c39dd73"
  ],
  [
    "Q-VALUE-config_activation_receipts",
    3321,
    "5d6c50f1e4e11c022934ac31fe5a32cf4d8811d254bb1ea8b9a9852517fa9c54"
  ],
  [
    "Q-META-FIRST-schema_migrations",
    304,
    "e7f42de6c5dfcdeaf52d8664bb3b61fea47baa70204b354e2999bafdf331db2c"
  ],
  [
    "Q-META-NEXT-schema_migrations",
    320,
    "afabd228b97c0e85ae92c8cf0464ccc726e6d514465310023501a90ac3864a73"
  ],
  [
    "Q-VALUE-schema_migrations",
    691,
    "af23c218fe60c71571aa22cc1798008ce8760941c56c1c9102df889327912266"
  ],
  [
    "C-NEXT-ROWID",
    66,
    "c1c1bc797c3b818530eda58f1e361de8d65e6037e6bc80923f2f089c812fc484"
  ],
  [
    "C-BIRTH",
    429,
    "762434e863e2a418c18c78dd007ec25e771551cc8c8ff1bd9b3732d5d54ddc87"
  ],
  [
    "C-ORD-OBSERVE",
    1594,
    "580ef8ce7efffc40abb6dc7371a93319bd6a248f413a0a7167100161135a76fc"
  ],
  [
    "C-ORD-DRAIN-BEGIN",
    1662,
    "d6b98e3d957ad582f11fccbe913bffc2b2115db6fb61e97cfc6914a6ce86db2e"
  ],
  [
    "C-ORD-DRAIN-END",
    1758,
    "769dbc91f2a399285c0d39de4c2c62938085a3bbcd2a13f3dcafb30b804b9a1c"
  ],
  [
    "C-ORD-END",
    1582,
    "142273289539b4d035ab455a51830f276cc1d3fc20a06e4ca63a25148f63fdd9"
  ],
  [
    "C-MAINT-OBSERVE",
    1554,
    "3d7f9315a38239014562ee14a818898431e50a628264d9b717f2c21ad319f0ef"
  ],
  [
    "C-MAINT-ENDED-OBSERVATION",
    1582,
    "142273289539b4d035ab455a51830f276cc1d3fc20a06e4ca63a25148f63fdd9"
  ],
  [
    "C-NATIVE-END-OPEN",
    1786,
    "ebfe85b8f4cc4fc65b73859274d022a9f8650a9bf3455a187f2c7e3d341c73ef"
  ],
  [
    "C-NATIVE-END-DRAIN",
    1786,
    "ebfe85b8f4cc4fc65b73859274d022a9f8650a9bf3455a187f2c7e3d341c73ef"
  ],
  [
    "C-BEGIN",
    16,
    "daf327e077218da27ea7bc358ecc72da8103c4b3a380e60b62c33d0524afb15a"
  ],
  [
    "C-COMMIT",
    7,
    "2db35aa37c4005aa96055e900adc9bfbbd70d106820fefcb83216b7cc3f95422"
  ],
  [
    "C-ROLLBACK",
    9,
    "9be868b5fc7744c6a5fa794bedc41fd4f93c13f4ccbc84805546b17682d2505c"
  ]
] as const;
function frozen(value: unknown): void {
  if (value !== null && typeof value === "object") {
    assert.ok(Object.isFrozen(value)); for (const child of Object.values(value)) frozen(child);
  }
}

test("SQ-D02 I02：完整32固定SQL逐字保持已接受来源，导入只产生惰性数据", () => {
  assert.equal(component.scope, "fixed-query-source-only");
  assert.equal(component.acceptedSource.sha256, "802d88a34b9ac31f22072fb8a95e05e3e009e5558b4a61d12392e6e895d62713");
  assert.deepEqual(queries.map(q => [q.id, Buffer.byteLength(q.sql), createHash("sha256").update(q.sql).digest("hex")]), expected);
  assert.deepEqual(tables.map(t => [t.table, t.columns.length]), [["storage_maintenance",15],["storage_source_clients",17],
    ["config_authority",5],["config_activation_receipts",17],["schema_migrations",4]]);
  frozen(queries); frozen(tables); frozen(component);
});

for (const encoding of ["UTF-8", "UTF-16le", "UTF-16be"] as const) {
  test(`SQ-D02 I02：固定 main 查询忽略 TEMP shadow，保留 ${encoding} 原字节、NULL、BLOB、REAL 和 int64`, () => {
    const db = new Database(":memory:");
    try {
      db.pragma(`encoding='${encoding}'`);
      const table = tables[0]!, declaration = table.columns.map(column => `"${column.name}"`).join(",");
      db.exec(`CREATE TABLE main.storage_maintenance(${declaration}); CREATE TEMP TABLE storage_maintenance(${declaration});`);
      const rawText = Buffer.from("汉🦊", encoding === "UTF-8" ? "utf8" : "utf16le");
      if (encoding === "UTF-16be") rawText.swap16();
      const values = [1n, "汉🦊", null, Buffer.from([0, 255]), -9223372036854775808n, "", null, null,
        9223372036854775807n, null, 1.25, 0n, 1n, "date keeps its original bytes", null];
      const insert = `INSERT INTO main.storage_maintenance(rowid,${declaration}) VALUES (${Array(16).fill("?").join(",")})`;
      db.prepare(insert).run(-9223372036854775808n, ...values);
      db.prepare(insert).run(9223372036854775807n, ...values);
      db.prepare(insert.replace("main.", "temp.")).run(1n, ...values.map(() => "TEMP"));
      const statement = (id: string) => db.prepare(queries.find(query => query.id === id)!.sql).safeIntegers(true);
      const first = statement("Q-META-FIRST-storage_maintenance").get() as Record<string, unknown>;
      assert.equal(first._rowid, -9223372036854775808n);
      assert.equal(first.t1, "text"); assert.equal(first.n1, BigInt(rawText.length));
      assert.equal(first.t2, "null"); assert.equal(first.n2, null);
      assert.equal(first.t3, "blob"); assert.equal(first.n3, 2n);
      assert.equal(first.t5, "text"); assert.equal(first.n5, 0n);
      assert.equal(first.t10, "real");
      const raw = statement("Q-VALUE-storage_maintenance").get(first._rowid) as Record<string, unknown>;
      assert.equal(raw.v1, rawText.toString("hex")); assert.equal(raw.v2, null); assert.equal(raw.v3, "00ff");
      assert.equal(raw.v4, -9223372036854775808n); assert.equal(raw.v5, "");
      assert.equal(raw.v8, 9223372036854775807n); assert.equal(raw.v10, 1.25);
      const next = statement("Q-META-NEXT-storage_maintenance").get(first._rowid) as Record<string, unknown>;
      assert.equal(next._rowid, 9223372036854775807n);
      assert.equal(statement("Q-META-NEXT-storage_maintenance").get(next._rowid), undefined);
    } finally { db.close(); }
  });
}
test("SQ-D02 I02：实际 SQLite bytecode 的 metadata 读取走 typeof/octet_length 优化，不先 hex/CAST payload", () => {
  const db = new Database(":memory:");
  try {
    for (const table of tables) {
      db.exec(`CREATE TABLE main."${table.table}"(${table.columns.map(column => `"${column.name}"`).join(",")});`);
      for (const kind of ["FIRST", "NEXT"]) {
        const source = queries.find(query => query.id === `Q-META-${kind}-${table.table}`)!;
        const bytecode = db.prepare(`EXPLAIN ${source.sql}`).all(...(kind === "NEXT" ? [0n] : [])) as { opcode: string; p4: string | null; p5: number }[];
        const reads = bytecode.filter(operation => operation.opcode === "Column");
        assert.equal(reads.length, table.columns.length * 2);
        assert.ok(reads.every((operation, index) => operation.p5 === (index % 2 === 0 ? 128 : 192)));
        const functions = bytecode.filter(operation => operation.opcode === "Function").map(operation => operation.p4);
        assert.deepEqual(functions, table.columns.flatMap(() => ["typeof(1)", "octet_length(1)"]));
        assert.equal(bytecode.some(operation => operation.opcode === "Cast"), false);
      }
    }
  } finally { db.close(); }
});
test("SQ-D02 I02：派生 main 列目录读有界返回，extra/missing/type/default/pk/hidden 不可伪装精确目录", () => {
  assert.equal(columnQueries.length, 10);
  assert.equal(component.queries, 42); assert.equal(component.acceptedQueries, 32); assert.equal(component.derivedColumnQueries, 10);
  for (const table of tables) {
    const db = new Database(":memory:");
    try {
      const declaration = table.columns.map(c => `"${c.name}" ${c.type}${c.notnull ? " NOT NULL" : ""}${c.pk ? " PRIMARY KEY" : ""}${c.default === null ? "" : ` DEFAULT ${c.default}`}`).join(",");
      db.exec(`CREATE TABLE main."${table.table}"(${declaration}); CREATE TEMP TABLE "${table.table}"(fake TEXT);`);
      const query = columnQueries.find(q => q.id === `Q-COLUMNS-${table.table}`)!.sql;
      const check = () => (db.prepare(query).get() as { matches: number }).matches;
      assert.equal(check(), 1);
      db.exec(`ALTER TABLE main."${table.table}" ADD COLUMN extra TEXT;`); assert.equal(check(), 0);
      db.exec(`DROP TABLE main."${table.table}";`);
      for (const changed of [declaration.split(",").slice(0, -1).join(","), declaration.replace("TEXT", "BLOB"),
        declaration.replace(" NOT NULL", ""), declaration.replace(" PRIMARY KEY", ""), declaration.replace("TEXT", "TEXT DEFAULT 'unexpected'"),
        `${declaration},computed TEXT AS ('hidden') VIRTUAL`,
        declaration.replace(`"${table.columns.at(-1)!.name}" TEXT`, `"${table.columns.at(-1)!.name}" TEXT GENERATED ALWAYS AS ('hidden') VIRTUAL`)]) {
        db.exec(`CREATE TABLE main."${table.table}"(${changed});`); assert.equal(check(), 0); db.exec(`DROP TABLE main."${table.table}";`);
      }
    } finally { db.close(); }
  }
});

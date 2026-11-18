import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Client } from "pg";
import { identityFixture, identityPgUrl, identitySkip } from "./helpers/identity-fixture.ts";
import { createDbDriver, type DbDriver, type DbReadSnapshot, type DbRow } from "../src/server/db/driver.ts";
import { DATABASE_FILE_NAME } from "../src/server/db/database.ts";
import { postgresDialect } from "../src/server/db/dialect.ts";
import { readSqliteManifests } from "../src/server/storage/maintenance/sqlite-manifests.ts";
import { readPostgresManifests } from "../src/server/storage/maintenance/postgres-manifests.ts";
import { canonicalJson, sha256 } from "../src/server/storage/maintenance/canonical.ts";
import { buildDatabaseManifests } from "../src/server/storage/maintenance/manifests.ts";
import { buildLayoutMemoryInventory } from "../src/server/storage/maintenance/layout-memory-inventory.ts";
import type { DatabaseManifests, Json } from "../src/server/storage/maintenance/types.ts";
import { collectLayoutMemoryInventory, MemoryCollectionError } from "../src/server/storage/maintenance/layout-memory-collector.ts";

// Exact accepted SQL bytes; schema substitution alone is normalized.
const acceptedPgSql = new Set([
  "ef0c9f2a868fd5e7f8e626481767db905f47f59263004aa4a704d6537aa2f62a",
  "9736ca05d8d221b11177bae6c0c774776c620b0292b4c78613c9f9923843c603",
  "c6d144dceb77bde507fe2c7f64d10c29525c6acc66dbed17b07db317588c4b84",
  "2d5af5a611310cf7a216a0f5b0ef373524907cfb3e7de1125ad798d00a75b2bd",
  "c8c661665ef71cc62a2de4ee316b08fa421018a671da7a18dfa07208ccaaf307",
  "0e0298b34eb61734a6498b58e419be39efab1140df3a7aa4e10ad1484ff40899",
  "699241cdaa44c9a8422c353ca572d1d96d75772ac281aa45573923fbf0f61712",
  "4ebc493579a5cd12f30f2c17d20d794bb16dfc072da892b472f1db8061deceaf",
  "ce4ff6109cd0b9775f77a46a1b98842be95794620fdca2360423a4e4e241fd78",
  "810c465e11c60920a1a8ec8b6fc983a87ab2c30bd9d5438e1c1e5e5602f8653b",
  "147e675603d71fd4e4c3e016eec769a0a178ce40c9e8663007d5d94541f3ee48",
  "6a3d80dc1bc6909580b5315046719018e541a0528a2a7b5242f7ae2f275b8a4e",
  "81dea6b4265b8c01e7e557eb3c6115e87720402a12f1aeaa503703c0fb78fd76",
  "5a6f67e51dac0912da9a16f13c4b06a7a95c5e52eeee425de6511f4d8840bd2b",
  "8ee190a4cff32b4aaa91133ac9c5f6b8fc8cb97c513e4b58abf16abff423cc82",
  "4cb4608db93a1ee153811a4f218d889cf26a9f666c17c806fff41a633a66de0e",
  "899c48bf164529ae59cb93e60e21f879b7014de0ff2617ff10e5a551e6783d5d",
  "7dcca200557b0d90ecc0a37601e1ea5ff5cc3dc4336ed4dab8cb205b75338f35",
  "11cfc1f3e438c34a223dabeb64f4001ebe3c4f3037504baa63cc77bef96145d2",
  "357eba6e5c354613faf0f24d8b4f4783d329814f310415dd32802cc165e17fb5",
  "05877e10c9e069f1e5da64b0bb6f5f6fc981be2f25907942e0f25651c4237c88",
  "8c004fee9d00529a3c5dda47399769896709c722a6d6c6c9610777e88ba82963",
  "9e366c74478e2a04c5264237d1f88744dc75983aaf3db9e5de3476cb75ff43b0",
  "c7c14bf32db6de23972eb754717a11cab34bc82c99ff68472bc13aaadff099a9",
  "b11a106aa3910374f9f3fa4f5a0180b00ed50d961383e29f633f2a631b0d3ded",
  "c85f1867d31445e2da12cc4bc82372fc7b86d022fdee921dc03bb39f8c348d47",
  "6d82cb58f9dcecc5ba3fca23952491c28e4873044990f8621620c35e5ccd788a",
  "9a747426061fa0996c06e3a1c43c0c18a152712f631693292d1313a3ac8f9b93",
  "ee284a056c009d5ba70436c5d609288e31f88b6838f04e48ded8f722eba42e64",
  "0cd255461c149ae0f89a5ca455a135a4ddf7d6a2ff529fd1a9dd7209b851a8bd",
  "4265d1513a06a74d73a39f6be8c5350c9629aaee883a984994bd78a1b1ab72df",
  "90b06357f931ae495f1b7249ca8f74488e8b710ca1196bef10fcd878489197c1",
  "ed80046bdcff3b86fb8b22c4f8fa82274dfbbea9296e0b1281c04c2d0517f011",
  "7d595b019728ac95cf3b2c585c0f8626aab1103f1537f2568ad102188492638b",
  "c17a664854380110bc33a6a45b6254bbf3d90d7fb99ec62c08be5b9b01c01533",
  "c6339f7dfb6366f81a360716d795a09fe78b0d9a8ea72442fa12bcb199892d3d",
  "415b2f2026273f78f00b925c83ebc9ff2edf12a1cf1b7429ab3be8947044a925",
  "d19b445b94798804c96ac8f3bf947544769e74989044c42535bca8b96c7efc9e",
  "be4f87afce189ef7becec98217e2e5e6c503b569eeeb6797450ca3b07a50f5e3",
  "da042bc8f36ff28b7ebea42124112223a1e9d55cb8dc1b5354d9b48a7d958d47",
  "935fffc7c7c85853b990155fa1ca38a1f508e511c5e080c7e05e2cc83804613f",
  "1e10bf55f6742b1558cc87fbd4a8f445485f6ad8b684bad40b7f2967b823efd2",
  "766f387b3f9f19e3822c9bf63fe26155d32f2e690d9fc8ecd5cb8775711cbdb0",
  "1f60d1cccfd00ebcebb0aa3491a4bb47d9780ee835c50f9405f1e25b42108828",
  "6129307997b499e3fc2d8e09fad1430566969982aaf5278c936ddf278ec87c53",
  "5409f111f8a2f0d1fe547e35f65f97d806e4d4f3ca8d7737294a46c8364f8407",
  "052f0dc33b8e7084688eee55e80ab5ec15a627c859b426e682c38f4f712c2a3f",
  "7d36ad6862985284ed613921a1e0369d24f907202c58d9cae0559ead39b680d8",
  "c74a60a863a0131cfb5cf783963b40dcdeed1aeeeff5f32cba2afcaea96f6438",
  "aa7aaf22a120a18202e851096529e8035b6854e9c03d499103cc7eac7fd37714",
  "33c71273e5dfef40998e0e471d1df3710f0934f022d6f15fb6e0827b7dffcdf0",
  "c6780731a91b87dcb5ea66c8bc74fd44af2ee9c2d9ae913f8c8ef17970a85432",
  "68a0ee4751776e2ea59e4535859d4f038458660d5cd82b557b0f4d141f618040",
  "6fdebe2aca4dc618d3ac21508654447c1f007734a1f8dcf209a12b349c06fcd2",
  "7a2bedb64e9e6a01f78c4e8a1c200409c502956b897869881b1664872eb2c139",
  "15c4d517a4478e0da7420186e469c26ba5b230801f9a22d81ce50fde35499a99",
  "bafbd0fe34097bdafa98897a7cc8c1f1f6b5def63322050b7118141586a87892",
  "e9770ad92dd9369e0fcfc53ef25078dc9d79a5fc130372f10bb64c9ec0a61635",
  "ef0a50157aacb91a7e0ca6cb197bba3e4b65d58160fca07bcb96e44f2863e88d",
  "5e38bc46eeb2845d77bcb78feb3043b187cb68cad83d6c6d05eadf3593276470",
  "c3c1c24f6c3f3f77804378b433ff8a4944c49eb6986d8b7933dc3e572a17011b",
  "95c2d1f1a88fb80b4619629ff51aa841edcedf825cc76fd4a59a42550c2d2ea4",
  "257e2c9536da99033f10291d9600102fa67d9109fdd4468454bc6da0dd8a5f83",
  "d08ab653469c345d772aa025eece8023c794e5278b6a10acd90659c834b6ff2d",
  "55d2ef5888616950f24dee7d4ede3d491506c9d280b800c30c4dd580914c6b64",
  "8d502ff19e0f5b6b3cbf9348ae21953e1f5a2c00a7385f82698284c961ee4383",
  "a2bac4daceeccb79ca5f398ff7658ff2b95fb0dced4f6a9159c022ef9e3aacb7",
  "bac241935e2873eacfce11955e250088fd3ef00c8fa79add71b4b8ae46e38821",
  "ce01bfc98b86c11322a09ee3b1c526cee1ab6c88663eb05e5210022f0cbee864",
  "d13d09dc769699dcd6436081c164e3e193b8c08af6b08cba4b2d21f5d780f3ba",
  "d1f6a16c6680ee9033f4ceb8913ea5d793e296d7417b1408835491c2c2eedea8",
  "f527a8453bd45ab9fe66d4ce85fc6c6e0f4ef32eff739b2ce07562dda09515e5",
  "7896a5ce83b80a60a244eb6d514d47175a702fa224dc721a44b460ed4f67e37b",
  "47d31609730835cb5e5e5a70931d5f106a19706d8efbd09d50b9e00df2c5cbe8",
]);
const at = "2026-11-10T12:00:00.000Z";
const author = '{ "displayName": "人", "agentId": null, "actorId": "owner", "kind": "human" }';
const names = ["memory_documents", "memory_versions", "memory_summary_requests"] as const;
const qi = (name: string) => `"${name.replaceAll('"', '""')}"`;
type Fixture = Awaited<ReturnType<typeof identityFixture>>;
const errorCode = (code: string) => (error: unknown) => error instanceof MemoryCollectionError && error.code === code
  && error.message === `layout_memory_collection:${code}` && error.name === "MemoryCollectionError";
function snapshot(query: (sql: string, params: readonly unknown[]) => Promise<DbRow[]>): DbReadSnapshot {
  return { query: (sql: string, params: readonly unknown[] = []) => query(sql, params) } as DbReadSnapshot;
}
function envelope(m: DatabaseManifests, bytes = Buffer.from(canonicalJson(m))) {
  const hash = sha256(bytes);
  return { bytes, request: { contract: "layout-memory-collection-request/r1", source: { kind: m.dialect,
    databaseInstanceId: m.controlRows.storage_maintenance[0]!.database_instance_id, identityDigest: "a".repeat(64) },
    frozenManifest: { ref: `snapshots/${hash}/database-manifests.json`, sha256: hash, bytes: String(bytes.length) },
    storageId: "collector-fixture", invocationStartedAtNs: process.hrtime.bigint().toString() } };
}
function assertPgTemplates(trace: readonly string[], schema: string) {
  const seen = new Set<string>();
  for (const sql of trace) { const hash = sha256(sql.replaceAll(qi(schema), "{{schema}}")); assert.ok(acceptedPgSql.has(hash), `unaccepted SQL ${hash}`); seen.add(hash); }
  assert.equal(seen.size, 74);
}
async function seed(f: Fixture) {
  const project = await f.repos.projects.create({ name: "collector fixture" });
  const agent = await f.repos.agents.create({ displayName: "collector agent", hostType: "codex-cli" });
  const member = await f.repos.members.create({ projectId: project.id, agentId: agent.id, kind: "agent", displayName: "collector" });
  const bodies = ["", "same", `\uFEFFline\r\n🙂e\u0301${f.db.kind === "sqlite" ? "\0end" : ""}`];
  await f.db.transaction(async tx => {
    for (const [i, scope] of ["global", "project", "project-agent"].entries()) {
      const id = `document-${i}`;
      await tx.exec("INSERT INTO memory_documents VALUES(?,?,?,?,?,?,?,?,?,?)", [id, scope, scope === "global" ? null : project.id,
        scope === "project" ? null : agent.id, 3, bodies[2], Buffer.byteLength(bodies[2]!), at, author, "human"]);
      for (let version = 1; version <= 3; version++) { const body = bodies[version - 1]!;
        await tx.exec("INSERT INTO memory_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", [`version-${i}-${version}`, id, version, version - 1,
          body, Buffer.byteLength(body), sha256(body), author, "owner", "human", `mutation-${i}-${version}`, "deleted-summary", at]); }
    }
    for (const [i, state] of ["pending", "running", "completed", "failed", "conflicted", "cancelled"].entries())
      await tx.exec("INSERT INTO memory_summary_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [`summary-${i}`, project.id, agent.id,
        member.id, null, "document-2", 3, 1, state, "session_end", `trigger-${i}`, null, null, '[ "raw-message" ]', null, null, null, null, null, null,
        '{ "raw": "error" }', '{ "raw": "evidence" }', at, null, null]);
  });
  return { project, agent, member, bodies };
}
async function nativeSqlite<T>(f: Fixture, action: (view: DbReadSnapshot, m: DatabaseManifests, db: Database.Database) => Promise<T>) {
  const db = new Database(path.join(f.dir, DATABASE_FILE_NAME), { readonly: true, fileMustExist: true });
  try { db.pragma("query_only=ON"); db.exec("BEGIN"); const m = readSqliteManifests(db);
    const result = await action(snapshot(async (sql, params) => db.prepare(sql).all(...params) as DbRow[]), m, db); db.exec("COMMIT"); return result;
  } finally { if (db.inTransaction) db.exec("ROLLBACK"); db.close(); }
}
async function nativePostgres<T>(f: Fixture, action: (view: DbReadSnapshot, m: DatabaseManifests, client: Client, schema: string) => Promise<T>) {
  const schema = (await f.db.query("SELECT pg_catalog.current_schema() AS name"))[0]!.name as string;
  const client = new Client({ connectionString: identityPgUrl }); await client.connect();
  try { await client.query(`SET search_path TO ${qi(schema)}, pg_catalog`); await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const m = await readPostgresManifests(client, schema); // Preserve native QueryConfig(rowMode=array), never blind-adapt it.
    assert.equal(m.controlRows.storage_maintenance.length, 1);
    const result = await action(snapshot(async (sql, params) => (await client.query(postgresDialect.renderParameters(sql), [...params])).rows as DbRow[]), m, client, schema);
    await client.query("COMMIT"); return result;
  } finally { await client.query("ROLLBACK").catch(() => undefined); await client.end(); }
}
async function native<T>(f: Fixture, action: (view: DbReadSnapshot, m: DatabaseManifests) => Promise<T>) {
  return f.db.kind === "sqlite" ? nativeSqlite(f, action) : nativePostgres(f, action);
}

for (const engine of ["sqlite", "postgres"] as const) {
  test(`CS01/05/06/19/24/30/34/36 ${engine} original native readonly view preserves complete raw history`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try { const seeded = await seed(f); await native(f, async (view, m) => {
      const data = envelope(m), trace: string[] = []; let active = 0, maximum = 0;
      const result = await collectLayoutMemoryInventory(snapshot(async (sql, params) => { trace.push(sql); maximum = Math.max(maximum, ++active);
        try { return await view.query(sql, params); } finally { active--; } }), data.request, data.bytes);
      assert.deepEqual(result.inventory, buildLayoutMemoryInventory(result.input)); assert.equal(Object.getPrototypeOf(result), null);
      assert.ok(Object.isFrozen(result.input.tables[0]!.rows[0]![0])); assert.deepEqual(result.input.tables.map(t => t.rows.length), [3, 9, 6]);
      assert.equal(result.inventory.versions.length, 9); assert.equal(result.inventory.objects.length, 3);
      assert.equal(result.inventory.documents[0]!.legacyKey.agentId, seeded.agent.id);
      assert.ok(result.inventory.documents.every(d => d.documentKind === "note" && d.updatedByRaw === author));
      assert.ok(result.inventory.versions.every(v => v.authorRaw === author && v.summaryRequestId === "deleted-summary"));
      assert.equal(result.input.tables[0]!.rows[0]![5]![1], engine === "sqlite" ? Buffer.from(seeded.bodies[2]!).toString("hex") : seeded.bodies[2]);
      assert.equal(maximum, 1); assert.ok(trace.every(sql => !/^(BEGIN|COMMIT|ROLLBACK|SET|INSERT|UPDATE|DELETE)\b/i.test(sql)));
      if (engine === "postgres") { const schema = (m.schema as { scope: { name: string } }).scope.name; assertPgTemplates(trace, schema); assert.equal(trace.length, 78);
        assert.equal(trace.filter(s => s.startsWith("LOCK TABLE ONLY pg_catalog.")).length, 20);
        assert.equal(trace.filter(s => s.startsWith(`LOCK TABLE ONLY ${qi(schema)}.`)).length, 4);
        await assert.rejects(collectLayoutMemoryInventory(view, envelope(m).request, data.bytes), errorCode("read_unavailable")); }
    }); } finally { await f.close(); }
  });
  test(`CS03/04/36 ${engine} real driver snapshot and independent writer do not mix versions`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine); let writer: DbDriver | undefined;
    try { await seed(f); const schema = engine === "postgres" ? (await f.db.query("SELECT pg_catalog.current_schema() AS name"))[0]!.name as string : "";
      writer = createDbDriver(engine === "sqlite" ? { dbDriver: "sqlite", dataDir: f.dir } : { dbDriver: "postgres", pgConnectionString: identityPgUrl!, pgSchema: schema }); await writer.connect();
      const m = await native(f, async (_v, m) => m); // This native original view ends before the distinct driver snapshot.
      const data = envelope(m); let wrote = false;
      const output = await f.db.readSnapshot(view => collectLayoutMemoryInventory(snapshot(async (sql, params) => {
        const rows = await view.query(sql, params);
        if (!wrote && sql.includes('"memory_documents"') && sql.includes("row_count") && /FROM (main\.|ONLY)/.test(sql)) {
          wrote = true; await writer!.transaction(async tx => { const body = "after binding";
            await tx.exec("INSERT INTO memory_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", ["new-version", "document-0", 4, 3, body, Buffer.byteLength(body), sha256(body), author, "owner", "human", "new-mutation", null, at]);
            await tx.exec("UPDATE memory_documents SET version=4,markdown=?,byte_length=? WHERE id='document-0'", [body, Buffer.byteLength(body)]); }); }
        return rows;
      }), data.request, data.bytes));
      assert.ok(wrote); assert.equal(output.inventory.versions.length, 9); assert.equal(output.inventory.documents[0]!.currentVersion, 3);
      assert.equal(Number((await f.db.query("SELECT COUNT(*) AS n FROM memory_versions"))[0]!.n), 10);
      await assert.rejects(f.db.readSnapshot(view => view.query("UPDATE memory_documents SET version=version")));
      await assert.rejects(f.db.transaction(() => f.db.readSnapshot(async () => undefined)));
    } finally { await writer?.close(); await f.close(); }
  });
  test(`CS07 ${engine} frozen damaged complete-row evidence rejects without partial output`, { skip: identitySkip(engine) }, async t => {
    const f = await identityFixture(engine);
    try { await seed(f); const collect = () => native(f, async (view, m) => { const d = envelope(m); return collectLayoutMemoryInventory(view, d.request, d.bytes); });
      await t.test("bad content hash", async () => { await f.db.exec("UPDATE memory_versions SET content_sha256=? WHERE id='version-0-1'", ["0".repeat(64)]); await assert.rejects(collect(), errorCode("inventory_invalid")); await f.db.exec("UPDATE memory_versions SET content_sha256=? WHERE id='version-0-1'", [sha256("")]); });
      await t.test("head differs", async () => { await f.db.exec("UPDATE memory_documents SET markdown='different',byte_length=9 WHERE id='document-0'"); await assert.rejects(collect(), errorCode("inventory_invalid")); });
      await t.test("missing history", async () => { await f.db.exec("DELETE FROM memory_versions WHERE id='version-1-2'"); await assert.rejects(collect(), errorCode("inventory_invalid")); });
    } finally { await f.close(); }
  });
  test(`CS13 ${engine} body 1MiB passes, next byte refuses before body pages`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try { await seed(f); for (const length of [1_048_576, 1_048_577]) { const body = "x".repeat(length);
      await f.db.transaction(async tx => { await tx.exec("UPDATE memory_documents SET markdown=?,byte_length=? WHERE id='document-0'", [body, length]);
        await tx.exec("UPDATE memory_versions SET markdown=?,byte_length=?,content_sha256=? WHERE id='version-0-3'", [body, length, sha256(body)]); });
      await native(f, async (view, m) => { const data = envelope(m); let pages = 0;
        const promise = collectLayoutMemoryInventory(snapshot(async (sql, params) => { if (sql.includes("OFFSET")) pages++; return view.query(sql, params); }), data.request, data.bytes);
        if (length === 1_048_576) { assert.equal((await promise).inventory.versions.length, 9); assert.equal(pages, 6); }
        else { await assert.rejects(promise, errorCode("budget_exceeded")); assert.equal(pages, 0); } }); }
    } finally { await f.close(); }
  });
  test(`CS14/29 ${engine} 128-row paging uses binary order and exact terminal offsets`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try { const s = await seed(f), ids = [...Array.from({ length: 130 }, (_, i) => `page-${String(i).padStart(3, "0")}`), "A", "a", "é", "€", "\uE000", "🙂"];
      await f.db.transaction(async tx => { for (const id of ids) await tx.exec("INSERT INTO memory_summary_requests(id,project_id,agent_id,recipient_member_id,base_version,revision,state,trigger,trigger_key,message_ids,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)", [id, s.project.id, s.agent.id, s.member.id, 0, 1, "pending", "session_end", id, "[]", at]); });
      await native(f, async (view, m) => { const d = envelope(m), offsets: number[] = [];
        const result = await collectLayoutMemoryInventory(snapshot(async (sql, params) => { if (sql.includes("OFFSET") && sql.includes('"memory_summary_requests"')) offsets.push(params[1] as number); return view.query(sql, params); }), d.request, d.bytes);
        const actual = result.input.tables[2]!.rows.map(row => engine === "sqlite" ? Buffer.from(row[0]![1]!, "hex").toString() : row[0]![1]!);
        assert.deepEqual(actual, [...ids, ...Array.from({ length: 6 }, (_, i) => `summary-${i}`)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))); assert.deepEqual(offsets, [0, 128, 142]); });
    } finally { await f.close(); }
  });
}

test("CS02/12/13/17 strict request and manifest guards run before SQL", async t => {
  const f = await identityFixture();
  try { await native(f, async (_v, m) => { let calls = 0; const noRead = snapshot(async () => { calls++; throw new Error("must not read"); });
    const rebuilt = (tables = m.tables) => buildDatabaseManifests("sqlite", m.schema, tables, m.controlRows);
    const changed = (name: string, count: string) => rebuilt(m.tables.map(t => t.name === name ? { ...t, count } : t));
    const cases: [string, DatabaseManifests, string][] = [["formula", { ...m, fullDataManifestDigest: "0".repeat(64) }, "manifest_invalid"],
      ["duplicate", rebuilt([...m.tables, m.tables[0]!]), "manifest_invalid"], ["missing", rebuilt(m.tables.filter(t => t.name !== "memory_versions")), "manifest_invalid"],
      ["count syntax", changed("memory_documents", "00"), "manifest_invalid"], ["long count", changed("memory_documents", "1" + "0".repeat(120)), "budget_exceeded"],
      ...names.map((n, i): [string, DatabaseManifests, string] => [n, changed(n, String([4097, 16385, 16385][i])), "budget_exceeded"])];
    for (const [title, value, expected] of cases) await t.test(title, async () => { const d = envelope(value); await assert.rejects(collectLayoutMemoryInventory(noRead, d.request, d.bytes), errorCode(expected)); });
    for (const [raw, expected] of [["\uFEFF" + canonicalJson(m), "manifest_invalid"], [canonicalJson(m) + " ", "manifest_invalid"],
      [canonicalJson(m).replace('"dialect":"sqlite"', '"dialect":"sqlite","dialect":"sqlite"'), "manifest_invalid"], ["[".repeat(129) + "0" + "]".repeat(129), "budget_exceeded"],
      ["[" + "0,".repeat(249999) + "0]", "budget_exceeded"]]) { const d = envelope(m, Buffer.from(raw!)); await assert.rejects(collectLayoutMemoryInventory(noRead, d.request, d.bytes), errorCode(expected!)); }
    const d = envelope(m);
    for (const request of [{ ...d.request, extra: true }, { ...d.request, invocationStartedAtNs: (process.hrtime.bigint() + 120_000_000_000n).toString() }]) await assert.rejects(collectLayoutMemoryInventory(noRead, request, d.bytes), errorCode("invalid_input"));
    await assert.rejects(collectLayoutMemoryInventory(noRead, { ...d.request, invocationStartedAtNs: "0" }, d.bytes), errorCode("budget_exceeded"));
    const getter = { ...d.request }; Object.defineProperty(getter, "source", { enumerable: true, get() { throw new Error("getter"); } });
    await assert.rejects(collectLayoutMemoryInventory(noRead, getter, d.bytes), errorCode("invalid_input"));
    await assert.rejects(collectLayoutMemoryInventory(noRead, d.request, new Uint8Array(new SharedArrayBuffer(d.bytes.length))), errorCode("invalid_input"));
    await assert.rejects(collectLayoutMemoryInventory(noRead, d.request, new Uint8Array(16 * 1_048_576 + 1)), errorCode("budget_exceeded"));
    d.request.source.databaseInstanceId = "b".repeat(32); await assert.rejects(collectLayoutMemoryInventory(noRead, d.request, d.bytes), errorCode("source_mismatch")); assert.equal(calls, 0);
  }); } finally { await f.close(); }
});

test("CS17/18 array keys and driver rows are fixed before another await", async () => {
  const f = await identityFixture();
  try { await seed(f); await native(f, async (view, m) => {
    const data = envelope(m); let first = true;
    await assert.rejects(collectLayoutMemoryInventory(snapshot(async (sql, params) => { const rows = await view.query(sql, params); if (!first) return rows;
      first = false; return new Proxy(rows, { ownKeys: () => ["unknown", "length"] }); }), data.request, data.bytes), errorCode("unsupported_catalog"));
    let changed = false;
    const result = await collectLayoutMemoryInventory(snapshot(async (sql, params) => { const rows = await view.query(sql, params);
      if (!changed && sql.includes("OFFSET") && rows.length) return new Proxy(rows, { ownKeys(target) { queueMicrotask(() => { changed = true; target[0]!.v0 = Buffer.from("changed-after-snapshot").toString("hex"); }); return Reflect.ownKeys(target); } }); return rows;
    }), envelope(m).request, data.bytes);
    assert.equal(changed, true); assert.equal(result.inventory.documents[0]!.documentId, "document-0");
  }); } finally { await f.close(); }
});

test("CS17/18 request, offset bytes, receiver, raw aliases and unknown errors stay isolated", async () => {
  const f = await identityFixture();
  try { await seed(f); await native(f, async (view, m) => { const data = envelope(m), backing = Buffer.concat([Buffer.from("prefix"), data.bytes, Buffer.from("suffix")]);
    const bytes = new Uint8Array(backing.buffer, backing.byteOffset + 6, data.bytes.length); let raw: DbRow[] | undefined, calls = 0;
    const observed: DbReadSnapshot = { async query<T extends DbRow>(sql: string, params: readonly unknown[] = []): Promise<T[]> { assert.equal(this, observed); calls++;
      const rows = await view.query<T>(sql, params); if (sql.includes("OFFSET") && rows.length) raw ??= rows; return rows; } };
    const promise = collectLayoutMemoryInventory(observed, data.request, bytes); data.request.storageId = "mutated"; data.request.source.identityDigest = "0".repeat(64); backing.fill(0);
    observed.query = () => { throw new Error("query replaced"); }; const result = await promise;
    assert.ok(calls > 1); assert.equal(result.input.storageId, "collector-fixture"); assert.equal(result.input.source.identityDigest, "a".repeat(64));
    const before = canonicalJson(result); raw![0]!.v0 = "bad"; assert.equal(canonicalJson(result), before); assert.throws(() => (result.input.tables[0]!.rows as unknown[]).push([]), TypeError);
    let reads = 0; const hostile = Object.create(null) as Record<string, unknown>;
    for (const key of ["name", "message", "code", "cause"]) Object.defineProperty(hostile, key, { get() { reads++; throw new Error("secret"); } });
    const fresh = envelope(m); await assert.rejects(collectLayoutMemoryInventory(snapshot(async () => { throw hostile; }), fresh.request, fresh.bytes), errorCode("read_unavailable")); assert.equal(reads, 0);
    const bad = Object.create(null) as DbReadSnapshot; Object.defineProperty(bad, "query", { get() { reads++; return view.query; } });
    await assert.rejects(collectLayoutMemoryInventory(bad, fresh.request, fresh.bytes), errorCode("invalid_input")); assert.equal(reads, 0);
    const Resizable = ArrayBuffer as unknown as { new(length: number, options: { maxByteLength: number }): ArrayBuffer };
    await assert.rejects(collectLayoutMemoryInventory(view, fresh.request, new Uint8Array(new Resizable(8, { maxByteLength: 9 }))), errorCode("invalid_input"));
    const detached = new Uint8Array(8); structuredClone(detached, { transfer: [detached.buffer] }); await assert.rejects(collectLayoutMemoryInventory(view, fresh.request, detached), errorCode("invalid_input"));
  }); } finally { await f.close(); }
});

test("CS15 one pending real query settles after deadline; native rejection retains precedence", async () => {
  const f = await identityFixture();
  try { await native(f, async (view, m) => { for (const reject of [false, true]) { const d = envelope(m); d.request.invocationStartedAtNs = (process.hrtime.bigint() - 118_000_000_000n).toString();
    let calls = 0, active = false, settled = false;
    const promise = collectLayoutMemoryInventory(snapshot(async (sql, params) => { calls++; active = true; const rows = await view.query(sql, params); await new Promise(r => setTimeout(r, 2100)); active = false; if (reject) throw new Error("native"); return rows; }), d.request, d.bytes).finally(() => { settled = true; });
    await new Promise(r => setTimeout(r, 50)); assert.equal(active, true); assert.equal(settled, false);
    await assert.rejects(promise, errorCode(reject ? "read_unavailable" : "budget_exceeded")); assert.equal(calls, 1); assert.equal(active, false);
  } }); } finally { await f.close(); }
});

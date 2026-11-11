import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createDbDriver, type DbDriver } from "../src/server/db/driver.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories } from "../src/server/db/repositories.ts";
import { getMutationScopeCoordinator } from "../src/server/db/mutation-scope.ts";

const pgUrl = process.env["AGENT_STUDIO_PG_TEST_URL"] ?? process.env["AGENT_STUDIO_PG_CONNECTION_STRING"];
async function withDb(engine: "sqlite" | "postgres", body: (db: DbDriver) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-mutation-scope-"));
  const schema = `scope_${randomUUID().replaceAll("-", "")}`;
  const db = createDbDriver(engine === "sqlite" ? { dbDriver: "sqlite", dataDir: dir } : { dbDriver: "postgres", pgConnectionString: pgUrl!, pgSchema: schema });
  try { await db.connect(); await db.migrate(migrations); await body(db); }
  finally {
    await db.close();
    if (engine === "postgres") {
      const admin = new Client({ connectionString: pgUrl }); await admin.connect();
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.end(); }
    }
    await rm(dir, { recursive: true, force: true });
  }
}
const scopeChanged = (error: unknown) => error instanceof Error && "code" in error && error.code === "mutation_scope_changed";
for (const engine of ["sqlite", "postgres"] as const) {
  const skip = engine === "postgres" && !pgUrl ? "未配置真实 PostgreSQL；交 CI 执行" : false;
  test(`${engine} 同 driver 的仓储共享 coordinator 和物理事务身份，范围有序且仅子集重入`, { skip }, async () => {
    await withDb(engine, async db => {
      const a = createRepositories(db); const b = createRepositories(db);
      assert.equal(a.mutations, b.mutations); assert.equal(a.mutations, getMutationScopeCoordinator(db));
      const p = await a.projects.create({ name: "项目" });
      const m = await a.members.create({ projectId: p.id, kind: "human", displayName: "成员" });
      const another = await a.members.create({ projectId: p.id, kind: "human", displayName: "另一个成员" });
      const plan = { projectIds: [p.id, p.id], discover: async () => ({ memberIds: [another.id, m.id, m.id], groupIds: [], runtimeIds: [] }) };
      await a.mutations.run(plan, async scope => {
        assert.deepEqual(scope.projectIds, [p.id]); assert.deepEqual(scope.memberIds, [another.id, m.id].sort());
        const identity = db.currentTransactionContext(); assert.ok(identity);
        await b.transaction(async () => {
          assert.equal(db.currentTransactionContext(), identity);
          await b.mutations.run({ ...plan, discover: async () => ({ memberIds: [m.id], groupIds: [], runtimeIds: [] }) }, async nested => {
            nested.assertCovers([p.id], [m.id]);
            await b.context.exec("UPDATE members SET display_name = ? WHERE id = ?", ["事务内修改", m.id]);
          });
        });
      });
      assert.equal((await a.members.get(m.id))!.displayName, "事务内修改");
      assert.equal(db.currentTransactionContext(), undefined);
      await assert.rejects(() => a.mutations.run({ ...plan, discover: async () => ({ memberIds: [m.id], groupIds: [], runtimeIds: [] }) }, async () => {
        await a.context.exec("UPDATE members SET display_name = ? WHERE id = ?", ["必须回滚", m.id]);
        await b.mutations.run(plan, async () => { throw new Error("不应进入扩大范围的业务"); });
      }), scopeChanged);
      assert.equal((await a.members.get(m.id))!.displayName, "事务内修改");
    });
  });
  test(`${engine} discover 不能写入；新成员必须预分配、确认不存在并在同项目创建`, { skip }, async () => {
    await withDb(engine, async db => {
      const repos = createRepositories(db); const p = await repos.projects.create({ name: "项目" });
      await assert.rejects(() => repos.mutations.run({ projectIds: [p.id], discover: async tx => {
        await tx.exec("UPDATE projects SET name = ? WHERE id = ?", ["禁止预写", p.id]);
        return { memberIds: [], groupIds: [], runtimeIds: [] };
      } }, async () => {}), scopeChanged);
      assert.equal((await repos.projects.get(p.id))!.name, "项目");
      const id = randomUUID();
      await repos.mutations.run({ projectIds: [p.id], discover: async () => ({ memberIds: [], newMemberIds: [id], groupIds: [], runtimeIds: [] }) }, async scope => {
        scope.assertCovers([p.id], [id]);
        await repos.context.exec("INSERT INTO members (id,project_id,agent_id,kind,display_name,role,node_id,status,created_at,updated_at) VALUES (?,?,NULL,'human',?,'normal',NULL,'active',?,?)",
          [id, p.id, "预分配成员", "2026-11-11T00:00:00.000Z", "2026-11-11T00:00:00.000Z"]);
      });
      assert.equal((await repos.members.get(id))!.displayName, "预分配成员");
      await assert.rejects(() => repos.mutations.run({ projectIds: [p.id], discover: async () => ({ memberIds: [], newMemberIds: [id], groupIds: [], runtimeIds: [] }) }, async () => {}), scopeChanged);
      await assert.rejects(() => repos.mutations.run({ projectIds: [p.id], discover: async () => ({ memberIds: [], newMemberIds: [randomUUID()], groupIds: [], runtimeIds: [] }) }, async () => {}), scopeChanged);
    });
  });
}

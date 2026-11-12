import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createDbDriver } from "../../src/server/db/driver.ts";
import { migrations } from "../../src/server/db/migrations/index.ts";
import { createRepositories } from "../../src/server/db/repositories.ts";

export const identityPgUrl = process.env["AGENT_STUDIO_PG_TEST_URL"] ?? process.env["AGENT_STUDIO_PG_CONNECTION_STRING"];
export const identityEngines = ["sqlite", "postgres"] as const;
export function identitySkip(engine: typeof identityEngines[number]) {
  return engine === "postgres" && !identityPgUrl ? "未配置真实 PostgreSQL；由数据库 CI 门控执行" : false;
}
export async function identityFixture(engine: typeof identityEngines[number] = "sqlite", version = migrations.at(-1)!.version) {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-identity-"));
  const schema = `identity_${randomUUID().replaceAll("-", "")}`;
  const db = createDbDriver(engine === "sqlite" ? { dbDriver: "sqlite", dataDir: dir }
    : { dbDriver: "postgres", pgConnectionString: identityPgUrl!, pgSchema: schema });
  await db.connect(); await db.migrate(migrations.filter(m => m.version <= version));
  const repos = createRepositories(db);
  return { db, repos, dir, async close() {
    await db.close();
    if (engine === "postgres") {
      const admin = new Client({ connectionString: identityPgUrl }); await admin.connect();
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.end(); }
    }
    await rm(dir, { recursive: true, force: true });
  } };
}

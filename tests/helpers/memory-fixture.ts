import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { createDbDriver, type DbDriver } from "../../src/server/db/driver.ts";
import { migrations } from "../../src/server/db/migrations/index.ts";
import { createRepositories, type RepositorySet } from "../../src/server/db/repositories.ts";
import { actorForMember, ownerActor } from "../../src/server/authz/actors.ts";
import type { MemoryAccess } from "../../src/server/memory/service.ts";

export const memoryPgUrl = process.env["AGENT_STUDIO_PG_TEST_URL"] ?? process.env["AGENT_STUDIO_PG_CONNECTION_STRING"];
export const pgUnavailable = !memoryPgUrl ? "未配置真实 PostgreSQL；真实 PG 留既有 CI 门控，不用 SQLite 替代 PASS" : false;
export async function memoryFixture(run: (repos: RepositorySet, db: DbDriver) => Promise<void>, engine: "sqlite" | "postgres" = "sqlite"): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-memory-domain-"));
  const schema = `memory_domain_${randomUUID().replaceAll("-", "")}`;
  const db = createDbDriver(engine === "sqlite" ? { dbDriver: "sqlite", dataDir: dir } : { dbDriver: "postgres", pgConnectionString: memoryPgUrl!, pgSchema: schema });
  try { await db.connect(); await db.migrate(migrations); await run(createRepositories(db), db); }
  finally {
    await db.close();
    if (engine === "postgres") {
      const admin = new Client({ connectionString: memoryPgUrl }); await admin.connect();
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.end(); }
    }
    await rm(dir, { recursive: true, force: true });
  }
}

export async function memoryPeople(repos: RepositorySet) {
  const project = await repos.projects.create({ name: "记忆领域项目" });
  const agent = await repos.agents.create({ displayName: "目标 Agent", hostType: "codex-cli" });
  const other = await repos.agents.create({ displayName: "其他 Agent", hostType: "codex-cli" });
  const member = await repos.members.create({ projectId: project.id, agentId: agent.id, kind: "agent", displayName: agent.displayName });
  const outsider = await repos.members.create({ projectId: project.id, agentId: other.id, kind: "agent", displayName: other.displayName });
  const group = await repos.groups.create({ projectId: project.id, name: "记忆取材群", participantMemberIds: [member.id, outsider.id] });
  const owner: MemoryAccess = { actor: ownerActor() };
  const own: MemoryAccess = { actor: actorForMember(member), connection: { projectId: project.id, memberId: member.id, groupId: group.id, membershipRevision: member.membershipRevision } };
  const foreign: MemoryAccess = { actor: actorForMember(outsider), connection: { projectId: project.id, memberId: outsider.id, groupId: group.id, membershipRevision: outsider.membershipRevision } };
  return { project, agent, other, member, outsider, group, owner, own, foreign };
}

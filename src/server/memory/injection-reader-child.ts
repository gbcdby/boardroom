import Database from "better-sqlite3";
import { Client } from "pg";
import type { MemoryConfig, MemoryDocument, MemoryInjection } from "../../shared/memory.ts";
import type { MemoryDatabaseDescriptor, MemoryReadBinding } from "./injection-reader.ts";
import { buildMemoryInjection, unavailableMemory } from "./injection.ts";

type Row = { member_id: string; binding_agent_id: string; id: string | null; scope: "global" | "project-agent";
  project_id: string | null; version: number; markdown: string | null; byte_length: number | null };
let sqlite: Database.Database | null = null; let pg: Client | null = null; let config: MemoryConfig | null = null; let busy = false;

async function init(database: MemoryDatabaseDescriptor, values: MemoryConfig): Promise<void> {
  if (config) throw new Error("already initialized");
  config = values;
  if (database.kind === "sqlite") {
    sqlite = new Database(database.sqlitePath, { readonly: true, fileMustExist: true, timeout: 100 });
    sqlite.pragma("query_only=ON");
  } else {
    if (database.schema !== undefined && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(database.schema)) throw new Error("invalid schema");
    pg = new Client({ connectionString: database.connectionString, connectionTimeoutMillis: 250, statement_timeout: 250,
      options: `-c default_transaction_read_only=on -c lock_timeout=100${database.schema ? ` -c search_path=${database.schema}` : ""}` });
    await pg.connect();
  }
}

async function read(binding: MemoryReadBinding): Promise<MemoryInjection> {
  if (!config) throw new Error("not initialized");
  const size = sqlite ? "length(CAST(d.markdown AS BLOB))" : "octet_length(d.markdown)";
  const p = sqlite ? ["?", "?", "?"] : ["$1", "$2", "$3"];
  const sql = `SELECT m.id AS member_id, m.agent_id AS binding_agent_id, d.id, d.scope, d.project_id, d.version,
      CASE WHEN ${size} <= ${p[0]} THEN d.markdown ELSE NULL END AS markdown, ${size} AS byte_length
    FROM members m LEFT JOIN memory_documents d ON d.agent_id=m.agent_id
      AND ((d.scope='global' AND d.project_id IS NULL) OR (d.scope='project-agent' AND d.project_id=m.project_id))
    WHERE m.id=${p[1]} AND m.project_id=${p[2]} AND m.kind='agent' AND m.status='active' LIMIT 2`;
  const params = [config.maxDocumentBytes, binding.memberId, binding.projectId];
  const rows = sqlite ? sqlite.prepare(sql).all(...params) as Row[] : (await pg!.query<Row>(sql, params)).rows;
  if (!rows.length) return unavailableMemory(config, "memory_binding_unavailable");
  if (rows.some(row => row.id !== null && row.markdown === null)) return unavailableMemory(config, "memory_too_large");
  const documents: Pick<MemoryDocument, "id" | "key" | "version" | "markdown">[] = rows.flatMap(row => row.id === null ? [] : [{
    id: row.id, version: Number(row.version), markdown: row.markdown!, key: row.scope === "global"
      ? { scope: "global" as const, projectId: null, agentId: row.binding_agent_id }
      : { scope: "project-agent" as const, projectId: binding.projectId, agentId: row.binding_agent_id },
  }]);
  return buildMemoryInjection(documents, config);
}

process.on("message", async (raw: unknown) => {
  if (!raw || typeof raw !== "object") return;
  const message = raw as Record<string, unknown>;
  try {
    if (message["type"] === "init") { await init(message["database"] as MemoryDatabaseDescriptor, message["config"] as MemoryConfig); process.send?.({ type: "ready" }); return; }
    if (message["type"] !== "read" || busy) return;
    busy = true;
    const binding = { memberId: String(message["memberId"]), projectId: String(message["projectId"]), bindingGeneration: String(message["bindingGeneration"]) };
    const result = await read(binding);
    process.send?.({ type: "result", nonce: message["nonce"], ...binding, result });
  } catch { process.send?.({ type: "error", code: "memory_reader_query_failed" }); }
  finally { busy = false; }
});
process.once("disconnect", () => { sqlite?.close(); if (pg) void pg.end().finally(() => process.exit(0)); else process.exit(0); });

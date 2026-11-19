import { M2_HISTORY_TABLES } from "../../src/server/identity/m2-history-contracts.ts";
import type { HistoryObservationInput, RawCell } from "../../src/server/identity/m2-history-contracts.ts";

const hash = "a".repeat(64);
const artifact = (ref: string) => ({ ref, sha256: hash, bytes: "1" });
// Complete raw shape only. Business/selection semantics belong to other P0 families.
export function p0Fixture(backend: "sqlite" | "postgres" = "sqlite") {
  const observation: HistoryObservationInput = {
    contract: "m2-history-observation/r1", backend, phase: "p0", configFormat: 1,
    source: { kind: backend, databaseInstanceId: "1".repeat(32), identityDigest: hash },
    physicalSourceRef: { artifactId: "physical", digest: hash }, snapshotReceiptRef: { artifactId: "snapshot", digest: hash },
    catalog: artifact("catalog"), textEncoding: { backend, name: backend === "sqlite" ? "UTF-8" : "UTF8" },
    tables: M2_HISTORY_TABLES.filter(t => t.columnsP0.length).map(t => ({ name: t.name,
      columnContract: artifact(`column:${t.name}`), columnContractValueDigest: hash,
      columns: t.columnsP0.map(c => c.name), count: "0", rows: [] })),
    sequences: backend === "sqlite" ? [] : [{ contract: "m2-pc-pg-sequence-observation/r1", name: "schema_migrations_version_seq",
      relationIdentity: artifact("sequence"), lastValue: "21", isCalled: true }],
  };
  return { contract: "m2-history-closure-input/r2", graph: { kind: "m2-observation", observation, origin: null },
    artifacts: [] as { kind: string; artifact: ReturnType<typeof artifact>; bytesHex: string }[],
    evidence: [], proposedDeletion: null };
}
export function p0Text(backend: "sqlite" | "postgres", text: string): RawCell {
  const hex = Buffer.from(text, "utf8").toString("hex");
  return backend === "sqlite" ? ["text", hex] : ["pg-binary", "25", hex];
}
export function p0Integer(backend: "sqlite" | "postgres", table: string, column: string, value: bigint): RawCell {
  if (backend === "sqlite") return ["integer", value.toString()];
  const oid = M2_HISTORY_TABLES.find(t => t.name === table)!.columnsP0.find(c => c.name === column)!.postgresTypeOid;
  const bytes = Buffer.alloc(oid === "23" ? 4 : 8);
  if (oid === "23") bytes.writeInt32BE(Number(value)); else bytes.writeBigInt64BE(value);
  return ["pg-binary", oid, bytes.toString("hex")];
}
export function addP0Row(input: ReturnType<typeof p0Fixture>, tableName: string, values: Record<string, RawCell>, rowid?: string): void {
  const table = input.graph.observation.tables.find(t => t.name === tableName)!;
  table.rows.push({ rowid: input.graph.observation.backend === "sqlite" ? rowid ?? String(table.rows.length + 1) : null,
    cells: table.columns.map(column => values[column] ?? ["null"]) });
  table.count = String(table.rows.length);
}

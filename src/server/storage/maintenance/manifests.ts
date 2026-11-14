import { createHash } from "node:crypto";
import { canonicalJson, digestJson } from "./canonical.ts";
import type { DatabaseManifests, Json } from "./types.ts";

/** Preserve duplicate rows; each canonical typed row is length-framed before hashing. */
export function digestRowMultiset(rows: readonly Json[]): { count: string; digest: string } {
  const encoded = rows.map(canonicalJson).sort();
  const hash = createHash("sha256");
  for (const row of encoded) hash.update(`${Buffer.byteLength(row)}:`).update(row);
  return { count: String(rows.length), digest: hash.digest("hex") };
}
/** Shared formula, deliberately excludes only the two named controls from the frozen domain. */
export function buildDatabaseManifests(dialect: "sqlite" | "postgres", schema: Json,
  tables: DatabaseManifests["tables"], controlRows: DatabaseManifests["controlRows"]): DatabaseManifests {
  const ordered = [...tables].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const controls = new Set(["storage_maintenance", "storage_source_clients"]);
  const schemaManifestDigest = digestJson(schema);
  return { formatVersion: 1, kind: "database-manifests", dialect, schema, schemaManifestDigest, tables: ordered, controlRows,
    fullDataManifestDigest: digestJson({ dialect, schemaManifestDigest, tables: ordered }),
    frozenBusinessManifestDigest: digestJson({ dialect, schemaManifestDigest, tables: ordered.filter(table => !controls.has(table.name)) }),
    capturedControlManifestDigest: digestJson({ dialect, tables: ordered.filter(table => controls.has(table.name)), controlRows }) };
}

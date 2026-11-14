import { MaintenanceFailure } from "./error.ts";
import { sourceClientRawRowSchema, sourceClientsEncodingSchema } from "./source-clients.ts";
import type { SourceClientRawRow, SourceClientsRosterV1, SourceRef } from "./types.ts";

/** Native v18 positions, before any cast. Both real backend readers consume this profile. */
export const sourceClientColumns = [
  { name: "client_id", sqlite: "TEXT", postgres: "25", nullable: false },
  { name: "database_instance_id", sqlite: "TEXT", postgres: "25", nullable: false },
  { name: "entrypoint", sqlite: "TEXT", postgres: "25", nullable: false },
  { name: "build_id", sqlite: "TEXT", postgres: "25", nullable: false },
  { name: "protocol_version", sqlite: "INTEGER", postgres: "23", nullable: false },
  { name: "host_identity_json", sqlite: "TEXT", postgres: "25", nullable: false },
  { name: "process_identity_json", sqlite: "TEXT", postgres: "25", nullable: false },
  { name: "db_sessions_json", sqlite: "TEXT", postgres: "25", nullable: false },
  { name: "registered_epoch", sqlite: "BIGINT", postgres: "20", nullable: false },
  { name: "observed_epoch", sqlite: "BIGINT", postgres: "20", nullable: false },
  { name: "drain_epoch", sqlite: "BIGINT", postgres: "20", nullable: true },
  { name: "drain_state", sqlite: "TEXT", postgres: "25", nullable: false },
  { name: "drain_receipt_digest", sqlite: "TEXT", postgres: "25", nullable: true },
  { name: "registered_at", sqlite: "TEXT", postgres: "25", nullable: false },
  { name: "last_observed_at", sqlite: "TEXT", postgres: "25", nullable: false },
  { name: "ended_at", sqlite: "TEXT", postgres: "25", nullable: true },
] as const satisfies readonly { readonly name: keyof SourceClientRawRow; readonly sqlite: string;
  readonly postgres: string; readonly nullable: boolean }[];

export function invalidSourceClients(): never { throw new MaintenanceFailure("snapshot_invalid", "source-clients"); }
export function sourceClientsEncoding(backend: SourceRef["kind"], name: unknown): SourceClientsRosterV1["textEncoding"] {
  const result = sourceClientsEncodingSchema.safeParse({ backend, name });
  if (!result.success) throw new MaintenanceFailure("schema_guard_incomplete", "source-clients");
  return result.data;
}
export function sourceClientsHex(value: unknown, byteCount: unknown): string {
  if (typeof value !== "string" || !/^(?:[a-fA-F0-9]{2})*$/.test(value)
    || typeof byteCount !== "bigint" || byteCount < 0n || BigInt(value.length) !== byteCount * 2n) invalidSourceClients();
  return value.toLowerCase();
}
export function sourceClientsRows(values: readonly unknown[], count: bigint): readonly SourceClientRawRow[] {
  if (count < 0n) invalidSourceClients();
  if (BigInt(values.length) !== count) throw new MaintenanceFailure("source_changed", "source-clients");
  const ids = new Set<string>();
  return values.map(value => {
    const result = sourceClientRawRowSchema.safeParse(value);
    if (!result.success || ids.has(result.data.client_id[1])) invalidSourceClients();
    ids.add(result.data.client_id[1]);
    return result.data;
  });
}

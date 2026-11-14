import { z } from "zod";
import { canonicalJson, digestJson } from "./canonical.ts";
import { MaintenanceFailure } from "./error.ts";
import { id, ref, source } from "./parse-primitives.ts";
import type { SourceClientsRosterV1 } from "./types.ts";

const decimal = (maximum: string, positive = false) => z.string()
  .regex(positive ? /^[1-9][0-9]*$/ : /^(0|[1-9][0-9]*)$/)
  .refine(value => value.length < maximum.length || value.length === maximum.length && value <= maximum);
const integer = z.tuple([z.literal("integer"), decimal("9223372036854775807")]);
const text = z.tuple([z.literal("text"), z.string().regex(/^(?:[a-f0-9]{2})*$/)]);
const nil = z.tuple([z.literal("null")]);
export const sourceClientRawRowSchema = z.object({
  client_id: text, database_instance_id: text, entrypoint: text, build_id: text,
  host_identity_json: text, process_identity_json: text, db_sessions_json: text,
  registered_at: text, last_observed_at: text, drain_state: text,
  drain_receipt_digest: z.union([text, nil]), ended_at: z.union([text, nil]),
  protocol_version: z.tuple([z.literal("integer"), z.literal("1")]),
  registered_epoch: integer, observed_epoch: integer, drain_epoch: z.union([integer, nil]),
}).strict();
export const sourceClientsEncodingSchema = z.discriminatedUnion("backend", [
  z.object({ backend: z.literal("sqlite"), name: z.enum(["UTF-8", "UTF-16le", "UTF-16be"]) }).strict(),
  z.object({ backend: z.literal("postgres"), name: z.enum([
    "EUC_CN", "EUC_JP", "EUC_JIS_2004", "EUC_KR", "EUC_TW", "ISO_8859_5", "ISO_8859_6", "ISO_8859_7", "ISO_8859_8",
    "KOI8R", "KOI8U", "LATIN1", "LATIN2", "LATIN3", "LATIN4", "LATIN5", "LATIN6", "LATIN7", "LATIN8", "LATIN9", "LATIN10",
    "MULE_INTERNAL", "SQL_ASCII", "UTF8", "WIN866", "WIN874", "WIN1250", "WIN1251", "WIN1252", "WIN1253", "WIN1254",
    "WIN1255", "WIN1256", "WIN1257", "WIN1258",
  ]) }).strict(),
]);
const rosterShape = z.object({
  formatVersion: z.literal(1), kind: z.literal("source-clients-roster"), source, migrationId: id, plan: ref,
  fenceEpoch: decimal("9007199254740991", true), receiptGeneration: decimal("9007199254740991", true),
  textEncoding: sourceClientsEncodingSchema, rows: z.array(sourceClientRawRowSchema),
}).strict().refine(value => value.textEncoding.backend === value.source.kind);

// With strictly lowercase, even hex, string order is unsigned byte order, including short prefixes.
export const sourceClientsRosterSchema = rosterShape.refine(value =>
  value.rows.every((item, index) => index === 0 || value.rows[index - 1]!.client_id[1] < item.client_id[1]));

/** Pure typed-byte construction. Sorting never discards rows or supplies missing source facts. */
export function buildSourceClientsRoster(value: unknown): SourceClientsRosterV1 {
  canonicalJson(value);
  const parsed = rosterShape.safeParse(value);
  if (!parsed.success) throw new MaintenanceFailure("journal_invalid");
  const rows = parsed.data.rows.sort((a, b) => a.client_id[1] < b.client_id[1] ? -1 : a.client_id[1] > b.client_id[1] ? 1 : 0);
  if (rows.some((item, index) => index > 0 && rows[index - 1]!.client_id[1] === item.client_id[1])) throw new MaintenanceFailure("journal_invalid");
  return { ...parsed.data, rows };
}

/** Persisted input must already be sorted; successful decoding is not a source or writer proof. */
export function parseSourceClientsRoster(value: unknown): SourceClientsRosterV1 {
  canonicalJson(value);
  const parsed = sourceClientsRosterSchema.safeParse(value);
  if (!parsed.success) throw new MaintenanceFailure("journal_invalid");
  return parsed.data;
}
export function sourceClientsDigest(value: unknown): string { return digestJson(parseSourceClientsRoster(value)); }

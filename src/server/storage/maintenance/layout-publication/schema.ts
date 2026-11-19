import { posix } from "node:path";
import { z } from "zod";
import { hash, id, ref as originalRef, source } from "../parse-primitives.ts";

// Private encodings of the accepted R3 E1 payloads. These are not format registrations.
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/).max(20);
export const ref = originalRef.extend({ bytes: decimal }).refine(value => !value.ref.includes("\0"));
const scalarString = (min: number, max: number) => z.string().refine(value => {
  const length = [...value].length;
  return length >= min && length <= max;
});
export const path = z.string().min(1).max(4096).refine(value => value.startsWith("/")
  && !value.startsWith("//") && !value.includes("\0") && posix.normalize(value) === value);
const uint64 = decimal.max(20).refine(value => value.length <= 20 && /^(0|[1-9][0-9]*)$/.test(value)
  && BigInt(value) <= 18_446_744_073_709_551_615n);
const inode = uint64.refine(value => value !== "0");
const int64 = z.string().regex(/^(0|-?[1-9][0-9]*)$/).max(20).refine(value => {
  if (value.length > 20 || !/^(0|-?[1-9][0-9]*)$/.test(value)) return false;
  const number = BigInt(value);
  return number >= -9_223_372_036_854_775_808n && number <= 9_223_372_036_854_775_807n;
});
const positive = z.number().int().positive().safe();
const storageId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const historicalId = z.string().min(1).max(512).refine(value => !value.includes("\0") && !/[\uD800-\uDFFF]/u.test(value));
const mode = z.enum(["retain-database", "relocate-sqlite"]);
const pathIdentity = z.object({ path, device: uint64, inode }).strict();
export const rootIdentity = pathIdentity.extend({ hostIdentityDigest: hash }).strict();
export const plannedPath = z.object({ path, existingAncestor: pathIdentity,
  absentSegments: z.array(scalarString(1, 255).refine(value => value !== "." && value !== ".."
    && !value.includes("/") && !value.includes("\0"))).max(128) }).strict()
  .refine(value => posix.join(value.existingAncestor.path, ...value.absentSegments) === value.path);
export const sourceIdentity = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sqlite"), sourcePath: path, sqlitePath: path, device: uint64, inode }).strict(),
  z.object({ formatVersion: z.literal(1), kind: z.literal("postgres"), systemIdentifier: decimal, databaseOid: decimal,
    databaseName: scalarString(0, 1_048_576), schemaOid: decimal, schemaName: scalarString(0, 1_048_576),
    serverAddress: scalarString(0, 1_048_576).nullable(), serverPort: positive.max(65_535).nullable(),
    descriptorDigest: hash, databaseInstanceId: z.string().regex(/^[a-f0-9]{32}$/) }).strict(),
]);
export const rootRoles = ["home", "state", "memory", "skills", "runtime", "workspaces", "artifacts"] as const;
export const fileRoles = ["config", "storage-marker", "migration-locator"] as const;
const selected = z.object({ artifact: ref, bytesHex: z.string() }).strict();
export const inputSchema = z.object({ contract: z.literal("layout-publication-file-input/r1"),
  plan: selected, intent: selected, recipe: selected, seed: selected, original: selected, database: selected,
  rendererInputs: selected, rootBindings: selected, privateConfig: selected.nullable(), originHistory: z.unknown(),
  targetSource: source, provisioning: ref.nullable(),
  fixedSources: z.object({ memory: selected, renderer: selected, transition: selected, allowedDelta: selected }).strict(),
}).strict();
export const seedSchema = z.object({ contract: z.literal("s4p-fixed-seed/r2"), source, mode, plan: ref, sourceReady: ref,
  originalProfileActivationId: historicalId, migrationId: id, layoutActivationId: id, storageId, auditId: id,
  auditRowid: int64.nullable(), layoutStateRowid: int64.nullable(),
  plannedAt: z.string().max(64).regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/),
  actor: z.object({ kind: z.literal("human"), memberId: z.null(), name: scalarString(1, 256) }).strict(),
  generation: z.literal(1), layoutVersion: z.literal(2), objectFormat: z.literal("utf8-sha256-v1"),
  memoryContractDigest: z.literal("cd93b64cd66516a22ef4173a343f03b6af6c2c459e1dd3fa2e7354bcf1fbe58a"),
}).strict();
export const settingsSchema = z.object({ port: positive.max(65_535),
  heartbeat: z.object({ intervalMs: positive, timeoutMs: positive }).strict(),
  antiLoop: z.object({ maxConsecutiveAutoReplies: positive, maxWakesPerMinutePerMember: positive }).strict(),
  memory: z.object({ messageThreshold: positive.max(10_000), maxDocumentBytes: positive.min(1024).max(1_048_576),
    maxInjectedBytes: positive.min(512).max(65_536), summaryInputBytes: positive.min(1024).max(262_144),
    summaryAttemptTimeoutMs: positive.min(30_000).max(3_600_000) }).strict(),
}).strict();
const envValue = scalarString(0, 1_048_576).nullable();
const environment = z.object({ AGENT_STUDIO_PORT: envValue, AGENT_STUDIO_DATA_DIR: envValue,
  AGENT_STUDIO_HEARTBEAT_INTERVAL_MS: envValue, AGENT_STUDIO_HEARTBEAT_TIMEOUT_MS: envValue,
  AGENT_STUDIO_MAX_CONSECUTIVE_AUTO_REPLIES: envValue, AGENT_STUDIO_MAX_WAKES_PER_MINUTE_PER_MEMBER: envValue,
  AGENT_STUDIO_DB_DRIVER: envValue, AGENT_STUDIO_PG_CONNECTION_STRING: envValue,
  AGENT_STUDIO_MEMORY_MESSAGE_THRESHOLD: envValue, AGENT_STUDIO_MEMORY_MAX_DOCUMENT_BYTES: envValue,
  AGENT_STUDIO_MEMORY_MAX_INJECTED_BYTES: envValue, AGENT_STUDIO_MEMORY_SUMMARY_INPUT_BYTES: envValue,
  AGENT_STUDIO_MEMORY_SUMMARY_ATTEMPT_TIMEOUT_MS: envValue,
}).strict();
export const originalSchema = z.object({ contract: z.literal("s4p-original-private-config/r1"), source, plan: ref,
  presence: z.enum(["present", "absent"]), path: path.nullable(), originalCwd: path, filePathBase: path,
  defaultDataDir: path, raw: ref.nullable(), environment,
  effective: z.object({ settings: settingsSchema, dataDir: path, dbDriver: z.enum(["sqlite", "postgres"]),
    pgConnectionString: envValue, postgresSchema: scalarString(1, 63).nullable() }).strict(), effectiveConfigDigest: hash,
}).strict();
export const databaseSchema = z.discriminatedUnion("kind", [
  z.object({ contract: z.literal("s4p-private-database/r1"), kind: z.literal("sqlite"), mode, source,
    targetPath: path, original: ref }).strict(),
  z.object({ contract: z.literal("s4p-private-database/r1"), kind: z.literal("postgres"), mode: z.literal("retain-database"),
    source, connectionString: scalarString(1, 1_048_576), namespace: scalarString(1, 63), locationId: hash, original: ref }).strict(),
]);
export const rendererSchema = z.object({ contract: z.literal("s4p-renderer-inputs/r1"), source,
  seed: ref, original: ref, database: ref, settings: settingsSchema }).strict();
const binding = z.object({ source, targetSource: source, migrationId: id, layoutActivationId: id, storageId, mode,
  phase: z.enum(["snapshot_ready", "objects_ready", "verified", "source_released", "db_activated", "config_activated"]),
  plan: ref, intent: ref, window: z.object({ epoch: positive, ownerGeneration: positive, predecessor: ref, resumeAt: ref }).strict(),
}).strict();
export const rootsSchema = z.object({ contract: z.literal("s4p-root-bindings/r1"), binding,
  control: z.object({ identity: rootIdentity, profile: ref }).strict(),
  roots: z.array(z.object({ role: z.enum(rootRoles), identity: rootIdentity, sourceProfile: ref }).strict()).length(7),
  parents: z.array(z.object({ role: z.enum(fileRoles), identity: rootIdentity, sourceProfile: ref }).strict()).length(3),
}).strict();
const configFields = { layoutVersion: z.literal(2), storageId, dataDir: path, stateRoot: path, skillsRoot: path,
  memoryRoot: path, runtimeRoot: path, workspacesRoot: path, artifactsRoot: path, ...settingsSchema.shape };
export const publicConfigSchema = z.discriminatedUnion("dbDriver", [
  z.object({ ...configFields, dbDriver: z.literal("sqlite"), pgConnectionString: scalarString(1, 1_048_576).optional() }).strict(),
  z.object({ ...configFields, dbDriver: z.literal("postgres"), pgConnectionString: scalarString(1, 1_048_576),
    postgresSchema: scalarString(1, 63) }).strict(),
]);
export const markerSchema = z.object({ contract: z.literal("s4p-storage-marker/r1"), layoutVersion: z.literal(2),
  storageId, generation: z.literal(1), objectFormat: z.literal("utf8-sha256-v1"), memoryFormatContract: ref,
  migrationId: id, layoutActivationId: id, targetSource: source, recipe: ref, rootBindings: ref }).strict();
export const locatorSchema = z.object({ contract: z.literal("s4p-migration-locator/r1"), migrationId: id,
  layoutActivationId: id, storageId, originSource: source, targetSource: source, controlRoot: rootIdentity,
  plan: ref, intent: ref, recipe: ref, journalDirectory: path,
  selectionRule: z.literal("read-authority-db-anchor-never-latest-file") }).strict();

export type Input = z.infer<typeof inputSchema>;
export type Original = z.infer<typeof originalSchema>;
export type Settings = z.infer<typeof settingsSchema>;

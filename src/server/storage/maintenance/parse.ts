import { z } from "zod";
import { MaintenanceFailure } from "./error.ts";
import type { ActualRestoreVerification, DatabaseManifests, DurabilityCapability, JournalRecord, MigrationPlan, PublicationEvidence, RestoreBundleManifest, SnapshotReceipt, SourceFilesManifest } from "./types.ts";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1).max(4096);
const counter = z.number().int().nonnegative().safe();
const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const blockerCode = z.enum(["source_changed", "source_missing", "plan_stale", "target_conflict", "control_root_mismatch",
  "source_writer_unknown", "source_writer_active", "drain_incomplete", "maintenance_busy", "maintenance_lost", "schema_guard_incomplete",
  "journal_invalid", "snapshot_invalid", "restore_verification_unavailable", "unsupported_durability", "backup_capability_unavailable", "request_conflict", "phase_conflict"]);
const json: z.ZodType<unknown> = z.lazy(() => z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(json), z.record(json)]));
const ref = z.object({ ref: text, sha256: hash, bytes: z.string().regex(/^(0|[1-9][0-9]*)$/) }).strict();
const source = z.object({ kind: z.enum(["sqlite", "postgres"]), databaseInstanceId: z.string().regex(/^[a-f0-9]{32}$/), identityDigest: hash }).strict();
const identity = z.object({ path: text, device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/) }).strict();
const capability = z.object({ formatVersion: z.literal(1), kind: z.literal("capability"), platform: z.literal("linux"),
  filesystemType: z.enum(["2035054128", "61267", "1481003842"]), node: text,
  rootIdentity: identity.extend({ hostIdentityDigest: hash }).strict(), guarantee: z.literal("observed-file-fsync-rename-directory-fsync"),
  powerLossTested: z.literal(false), probeDigest: hash }).strict();
const planned = z.object({ path: text, existingAncestor: identity, absentSegments: z.array(text) }).strict();
const root = z.object({ label: z.enum(["config", "managed-sessions"]), path: text, expected: planned }).strict();
const capture = z.object({ migrationId: id, source, planDigest: hash, fenceEpoch: counter, journal: ref,
  journalSequence: counter.positive(), ownerGeneration: counter.positive() }).strict();
const plan = z.object({ formatVersion: z.literal(1), kind: z.literal("plan"), migrationId: id, source, sourceIdentity: json,
  originalCwd: text, originalConfigPath: text.nullable(), configDigest: hash, effectiveConfigDigest: hash,
  schemaManifestDigest: hash, guardManifestDigest: hash, controlRoot: planned, targetRoot: planned, fileRoots: z.array(root),
  preview: z.object({ observedAt: text, dataDigest: hash, tableCounts: z.record(z.string().regex(/^\d+$/)), clientInventory: z.array(json) }).strict(),
  requiredCapabilities: z.array(text), blockers: z.array(z.object({ code: blockerCode, subjectRef: text }).strict()) }).strict();
const journal = z.object({ formatVersion: z.literal(1), kind: z.literal("journal"), migrationId: id, sequence: counter.positive(),
  previous: ref.nullable(), phase: z.enum(["planned", "quiesced", "snapshot_ready"]),
  event: z.enum(["enter", "capture", "ready", "takeover", "observation", "cancel_intent", "cancelled"]),
  requestId: id, requestDigest: hash, source, plan: ref, fenceEpoch: counter.positive(), ownerGeneration: counter.positive(), evidence: z.array(ref),
  frozen: z.object({ sourceFilesManifest: ref, schemaManifestDigest: hash, frozenBusinessManifestDigest: hash, guardManifestDigest: hash }).strict().nullable(),
  snapshot: ref.nullable() }).strict();
const files = z.object({ formatVersion: z.literal(1), kind: z.literal("source-files"), source, roots: z.array(root),
  entries: z.array(z.object({ sourceRoot: text, sourceRelativePath: z.string(), kind: z.enum(["file", "directory", "absent"]),
    identity: identity.nullable(), mode: z.string().regex(/^[0-7]{3,4}$/).nullable(), size: z.string().regex(/^\d+$/).nullable(), payload: ref.nullable() }).strict()),
  sourceMembershipExclusions: z.tuple([z.literal("database-files"), z.literal("entire-maintenance-control-root"), z.literal("all-maintenance-artifacts")]) }).strict();
const bundle = z.object({ formatVersion: z.literal(1), kind: z.literal("restore-bundle"), capture, sourceFilesManifest: ref, restorePointDigest: hash,
  entries: z.array(z.object({ role: z.enum(["plan", "journal-prefix", "capture-journal", "source-files-manifest", "source-file-payload", "database-snapshot", "database-expected-manifests", "capability-evidence"]), object: ref }).strict()) }).strict();
const publication = z.object({ formatVersion: z.literal(1), kind: z.literal("publication"), bundle: ref, capability: ref,
  observedOperations: z.array(z.object({ artifact: ref, completed: z.tuple([z.literal("file_sync"), z.enum(["rename", "immutable_name_verified"]), z.literal("directory_sync")]) }).strict()) }).strict();
const verification = z.object({ formatVersion: z.literal(1), kind: z.literal("verification"), bundle: ref, publication: ref,
  verificationTargetIdentity: json, exactFullDataAndControlMatched: z.literal(true), sourceFilePayloadsMatched: z.literal(true), schemaAndScopeMatched: z.literal(true) }).strict();
const receipt = z.object({ formatVersion: z.literal(1), kind: z.literal("receipt"), snapshotId: id, capture, restorePointDigest: hash,
  sourceFilesManifest: ref, bundle: ref, publication: ref, verification: ref, database: ref, manifests: ref, capability: ref,
  schemaManifestDigest: hash, fullDataManifestDigest: hash, frozenBusinessManifestDigest: hash, capturedControlManifestDigest: hash }).strict();
const manifests = z.object({ formatVersion: z.literal(1), kind: z.literal("database-manifests"), dialect: z.enum(["sqlite", "postgres"]), schema: json,
  schemaManifestDigest: hash, tables: z.array(z.object({ name: text, columns: json, count: z.string().regex(/^\d+$/), digest: hash }).strict()),
  controlRows: z.object({ storage_maintenance: z.array(z.record(json)), storage_source_clients: z.array(z.record(json)) }).strict(),
  fullDataManifestDigest: hash, frozenBusinessManifestDigest: hash, capturedControlManifestDigest: hash }).strict();

function parse<T>(schema: z.ZodTypeAny, value: unknown): T {
  const parsed = schema.safeParse(value); if (!parsed.success) throw new MaintenanceFailure("journal_invalid"); return parsed.data as T;
}
export const parsePlan = (value: unknown): MigrationPlan => parse(plan, value);
export const parseCapability = (value: unknown): DurabilityCapability => parse(capability, value);
export const parseJournal = (value: unknown): JournalRecord => parse(journal, value);
export const parseSourceFiles = (value: unknown): SourceFilesManifest => parse(files, value);
export const parseBundle = (value: unknown): RestoreBundleManifest => parse(bundle, value);
export const parsePublication = (value: unknown): PublicationEvidence => parse(publication, value);
export const parseVerification = (value: unknown): ActualRestoreVerification => parse(verification, value);
export const parseReceipt = (value: unknown): SnapshotReceipt => parse(receipt, value);
export const parseManifests = (value: unknown): DatabaseManifests => parse(manifests, value);

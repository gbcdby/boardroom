import path from "node:path";
import { z } from "zod";
import { canonicalJson, digestJson, parseCanonical } from "./canonical.ts";
import { MaintenanceFailure } from "./error.ts";
import { counter, hash, id, ref, source, text } from "./parse-primitives.ts";
import { sourceClientsRosterSchema } from "./source-clients.ts";
import { checkFactsShape, controlProofSchema } from "./control-candidate/schema.ts";
import type { ArtifactStore } from "./objects.ts";
import type { ActualRestoreVerification, ArtifactRef, DatabaseManifests, DurabilityCapability, JournalRecord, JournalRecordV1, JournalRecordV2, MaintenanceCommand, MigrationPlan, PublicationEvidence, RestoreBundleManifest, SnapshotReceipt, SourceFilesManifest, VerificationJournalRecord } from "./types.ts";

const blockerCode = z.enum(["source_changed", "source_missing", "plan_stale", "target_conflict", "control_root_mismatch",
  "source_writer_unknown", "source_writer_active", "drain_incomplete", "maintenance_busy", "maintenance_lost", "schema_guard_incomplete",
  "journal_invalid", "snapshot_invalid", "restore_verification_unavailable", "unsupported_durability", "backup_capability_unavailable", "request_conflict", "phase_conflict"]);
const json: z.ZodType<unknown> = z.lazy(() => z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(json), z.record(json)]));
const identity = z.object({ path: text, device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/) }).strict();
const capabilityBase = { formatVersion: z.literal(1), kind: z.literal("capability"), node: text,
  rootIdentity: identity.extend({ hostIdentityDigest: hash }).strict(), powerLossTested: z.literal(false), probeDigest: hash };
const capability = z.discriminatedUnion("platform", [
  z.object({ ...capabilityBase, platform: z.literal("linux"), filesystemType: z.enum(["2035054128", "61267", "1481003842"]),
    guarantee: z.literal("observed-file-fsync-rename-directory-fsync") }).strict(),
  z.object({ ...capabilityBase, platform: z.literal("darwin"), filesystemType: z.literal("apfs"),
    guarantee: z.literal("observed-file-and-directory-fullfsync-rename") }).strict(),
]);
const planned = z.object({ path: text, existingAncestor: identity, absentSegments: z.array(text) }).strict();
const root = z.object({ label: z.enum(["config", "managed-sessions"]), path: text, expected: planned }).strict();
const capture = z.object({ migrationId: id, source, planDigest: hash, fenceEpoch: counter, journal: ref,
  journalSequence: counter.positive(), ownerGeneration: counter.positive() }).strict();
const plan = z.object({ formatVersion: z.literal(1), kind: z.literal("plan"), migrationId: id, source, sourceIdentity: json,
  originalCwd: text, originalConfigPath: text.nullable(), configDigest: hash, effectiveConfigDigest: hash,
  schemaManifestDigest: hash, guardManifestDigest: hash, controlRoot: planned, targetRoot: planned, fileRoots: z.array(root),
  preview: z.object({ observedAt: text, dataDigest: hash, tableCounts: z.record(z.string().regex(/^\d+$/)), clientInventory: z.array(json) }).strict(),
  requiredCapabilities: z.array(text), blockers: z.array(z.object({ code: blockerCode, subjectRef: text }).strict()) }).strict();
const journalBase = { kind: z.literal("journal"), migrationId: id, sequence: counter.positive(),
  previous: ref.nullable(), phase: z.enum(["planned", "quiesced", "snapshot_ready"]),
  event: z.enum(["enter", "capture", "ready", "takeover", "observation", "cancel_intent", "cancelled"]),
  requestId: id, requestDigest: hash, source, plan: ref, fenceEpoch: counter.positive(), ownerGeneration: counter.positive(), evidence: z.array(ref),
  snapshot: ref.nullable() };
const legacyFrozen = z.object({ sourceFilesManifest: ref, schemaManifestDigest: hash, frozenBusinessManifestDigest: hash, guardManifestDigest: hash }).strict();
const journal = z.discriminatedUnion("formatVersion", [
  z.object({ ...journalBase, formatVersion: z.literal(1), frozen: legacyFrozen.nullable() }).strict(),
  z.object({ ...journalBase, formatVersion: z.literal(2), sourceClients: sourceClientsRosterSchema.nullable(),
    frozen: legacyFrozen.extend({ sourceClientsDigest: hash }).strict().nullable() }).strict(),
]).refine(value => value.formatVersion === 1 || (value.event === "capture") === (value.sourceClients !== null));
const overlayHandle = z.object({ type: z.literal(248), byteCount: z.literal(32), hex: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const ext4Handle = z.object({ type: z.literal(1), byteCount: z.literal(8), hex: z.string().regex(/^[a-f0-9]{16}$/) }).strict();
const incarnation = z.discriminatedUnion("type", [overlayHandle, ext4Handle]);
const bindingBase = { sourceRoot: root.shape.label, hostIdentityDigest: hash,
  filesystemUuidHex: z.string().regex(/^[a-f0-9]{32}$/).refine(value => value !== "0".repeat(32)),
  anchorPath: text, anchorKind: z.enum(["file", "directory"]) };
const rootBinding = z.discriminatedUnion("profile", [
  z.object({ ...bindingBase, profile: z.literal("linux-overlay-fid-fsuuid-v1"), filesystemType: z.literal("overlay"), anchorHandle: overlayHandle }).strict(),
  z.object({ ...bindingBase, profile: z.literal("linux-native-ext4-fid-fsuuid-v1"), filesystemType: z.literal("ext4"), anchorHandle: ext4Handle }).strict(),
  z.object({ ...bindingBase, profile: z.literal("linux-native-ext4-fid-fsuuid-source-state-v1"), filesystemType: z.literal("ext4"), anchorHandle: ext4Handle,
    readEvidence: z.object({ policy: z.literal("application-source-preservation-v1"), kernelDiagnosticPolicy: z.literal("ext4-last-mounted-v1"),
      profileEntryDigest: hash, qualificationDigest: hash, runtimeEnvironmentDigest: hash, sourceStateDigest: hash,
      blockEffectsObservation: z.literal("not-observed-at-runtime") }).strict() }).strict(),
]);
const nanoseconds = z.string().regex(/^(0|-?[1-9][0-9]*)$/);
const fileWitness = z.object({ kind: z.literal("file"), incarnation,
  change: z.object({ mtimeNs: nanoseconds, ctimeNs: nanoseconds, observedBirthtimeNs: nanoseconds.nullable() }).strict() }).strict();
const directoryWitness = z.object({ kind: z.literal("directory"), incarnation }).strict();
const fileEntryBase = { sourceRoot: text, sourceRelativePath: z.string() };
const mode = z.string().regex(/^[0-7]{3,4}$/), size = z.string().regex(/^\d+$/);
const sourcePayload = ref.refine(value => value.ref === `snapshots/${value.sha256}/source-file-payload.bin`);
const fileEntry = z.discriminatedUnion("kind", [
  z.object({ ...fileEntryBase, kind: z.literal("file"), identity, mode, size, payload: sourcePayload, sourceWitness: fileWitness }).strict(),
  z.object({ ...fileEntryBase, kind: z.literal("directory"), identity, mode, size: size.nullable(), payload: z.null(), sourceWitness: directoryWitness }).strict(),
  z.object({ ...fileEntryBase, kind: z.literal("absent"), identity: z.null(), mode: z.null(), size: z.null(), payload: z.null(), sourceWitness: z.null() }).strict(),
]);
const files = z.object({ formatVersion: z.literal(2), kind: z.literal("source-files"), source, roots: z.array(root).nonempty(),
  rootBindings: z.array(rootBinding), entries: z.array(fileEntry),
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
/** Strict shared structural decoding. Version edges and all runtime obligations are separate. */
export function parseJournal(value: unknown): JournalRecord {
  canonicalJson(value);
  if (value === null || typeof value !== "object" || Array.isArray(value) || !("formatVersion" in value)
    || value.formatVersion !== 3) return parse<JournalRecordV1 | JournalRecordV2>(journal, value);
  const requireValue = (condition: unknown): void => {
    if (!condition) throw new MaintenanceFailure("journal_invalid", "verification-journal");
  };
  const { controlProof, ...body } = value as Record<string, unknown>;
  requireValue(Object.hasOwn(value, "controlProof"));
  const record = parse<JournalRecordV2>(journal, { ...body, formatVersion: 2 });
  if (record.formatVersion !== 2) throw new MaintenanceFailure("journal_invalid");
  requireValue((record.event === "ready") === (record.snapshot !== null) && (record.event === "capture") === (record.frozen !== null));
  if (record.phase === "planned" && (record.event === "enter" || record.event === "observation")) {
    requireValue(controlProof === null);
    return { ...record, formatVersion: 3, controlProof: null };
  }
  requireValue(record.event === "capture" && record.phase === "quiesced"
    || record.event === "ready" && record.phase === "snapshot_ready"
    || ["observation", "takeover", "cancel_intent", "cancelled"].includes(record.event) && record.phase !== "planned");
  const proof = controlProofSchema.safeParse(controlProof);
  if (!proof.success) throw new MaintenanceFailure("journal_invalid", "verification-journal");
  if (proof.data.kind === "capture-controls") requireValue(record.event === "capture");
  requireValue((record.event === "cancelled") === (proof.data.kind === "cancel-terminal-controls"));
  if (record.event === "cancel_intent") requireValue(proof.data.kind === "control-successor");
  if (proof.data.kind === "control-successor" && ["capture", "ready", "cancel_intent"].includes(record.event))
    requireValue(proof.data.changes.length === 0 && proof.data.beforeRowsDigest === proof.data.afterRowsDigest);
  if (proof.data.kind === "legacy-first-capture-bridge") requireValue(record.phase === "snapshot_ready" && record.event === "observation"
    && proof.data.changes.length === 0 && proof.data.beforeRowsDigest === proof.data.afterRowsDigest);
  if (proof.data.kind === "cancel-terminal-controls") requireValue(proof.data.epochAfter === String(record.fenceEpoch)
    && BigInt(proof.data.epochAfter) === BigInt(proof.data.epochBefore) + 1n
    && proof.data.ownerGeneration === String(record.ownerGeneration) && proof.data.targetSequence === String(record.sequence)
    && proof.data.beforeRowsDigest === proof.data.afterRowsDigest);
  checkFactsShape(proof.data.facts, record.source);
  return { ...record, formatVersion: 3, controlProof: proof.data };
}
/** V deliberately shares the strict codec, not the default reader's broader purposes. */
export const parseVerificationJournal = (value: unknown): VerificationJournalRecord => parseJournal(value);

const persistedPlan = z.object({ migrationId: id, planDigest: hash, immutablePlan: ref, controlRoot: text }).strict()
  .refine(value => value.planDigest === value.immutablePlan.sha256 && value.immutablePlan.ref === `plans/${value.planDigest}.json`);
const continueRequest = z.object({ plan: persistedPlan, expectedSource: source,
  expectedPhase: z.enum(["planned", "quiesced", "snapshot_ready"]).nullable(), expectedJournalDigest: hash.nullable(), requestId: id }).strict()
  .refine(value => (value.expectedPhase === null) === (value.expectedJournalDigest === null));
const maintenanceCommand = z.object({ operation: z.enum(["execute-migration", "resume-migration", "cancel-migration"]), request: continueRequest }).strict();
export function parseMaintenanceCommand(value: unknown): MaintenanceCommand {
  const parsed = maintenanceCommand.safeParse(value);
  if (!parsed.success) throw new MaintenanceFailure("request_conflict", "maintenance-command");
  return parsed.data;
}
export function maintenanceRequestDigest(value: MaintenanceCommand): string {
  return digestJson(parseMaintenanceCommand(value));
}
function requireSourceFiles(condition: unknown): asserts condition {
  if (!condition) throw new MaintenanceFailure("snapshot_invalid");
}
const canonicalSourcePath = (value: string) => path.posix.isAbsolute(value) && path.posix.resolve(value) === value && !value.includes("\0");
const pathSegment = (value: string) => value !== "" && value !== "." && value !== ".." && !value.includes("/") && !value.includes("\0");

/** Structural decoding only; it does not observe a source or qualify a runtime provider. */
export function parseSourceFiles(value: unknown): SourceFilesManifest {
  const parsed = files.safeParse(value);
  if (!parsed.success) throw new MaintenanceFailure("snapshot_invalid");
  const manifest = parsed.data;
  requireSourceFiles(manifest.rootBindings.length === manifest.roots.length
    && new Set(manifest.roots.map(item => item.label)).size === manifest.roots.length);
  const roots = new Map(manifest.roots.map((item, index) => {
    const binding = manifest.rootBindings[index]!;
    requireSourceFiles(binding.sourceRoot === item.label && canonicalSourcePath(item.path) && item.expected.path === item.path
      && canonicalSourcePath(binding.anchorPath) && binding.anchorPath === item.expected.existingAncestor.path
      && item.expected.absentSegments.every(pathSegment)
      && path.posix.join(binding.anchorPath, ...item.expected.absentSegments) === item.path);
    return [item.label as string, { root: item, binding }] as const;
  }));
  const entries = new Map<string, (typeof manifest.entries)[number]>();
  for (const entry of manifest.entries) {
    const owned = roots.get(entry.sourceRoot), key = `${entry.sourceRoot}/${entry.sourceRelativePath}`;
    requireSourceFiles(owned && !entries.has(key) && (entry.sourceRelativePath === "" || entry.sourceRelativePath.split("/").every(pathSegment)));
    entries.set(key, entry);
    if (entry.kind === "absent") requireSourceFiles(entry.sourceRelativePath === "");
    else requireSourceFiles(entry.identity.path === path.posix.join(owned.root.path, entry.sourceRelativePath)
      && entry.sourceWitness.incarnation.type === owned.binding.anchorHandle.type);
    if (entry.kind === "file") requireSourceFiles(entry.size === entry.payload.bytes);
  }
  for (const { root, binding } of roots.values()) {
    const entry = entries.get(`${root.label}/`);
    requireSourceFiles(entry);
    if (entry.kind === "absent") requireSourceFiles(root.expected.absentSegments.length > 0 && binding.anchorKind === "directory");
    else requireSourceFiles(root.expected.absentSegments.length === 0 && binding.anchorKind === entry.kind
      && entry.identity.device === root.expected.existingAncestor.device && entry.identity.inode === root.expected.existingAncestor.inode
      && entry.sourceWitness.incarnation.hex === binding.anchorHandle.hex);
    if (entry.kind !== "directory") requireSourceFiles(!manifest.entries.some(child => child.sourceRoot === root.label && child.sourceRelativePath !== ""));
  }
  return manifest;
}
/** Fs byte/shape errors have their own boundary; a successful decode is not source provenance. */
export async function readSourceFiles(store: Pick<ArtifactStore, "kindFor" | "readBytes">, reference: ArtifactRef): Promise<SourceFilesManifest> {
  requireSourceFiles(store.kindFor(reference) === "source-files");
  // Keep hash, control-root, lock and I/O failures outside the decoding catch.
  const bytes = await store.readBytes(reference);
  let value: unknown;
  try { value = parseCanonical(bytes); }
  catch (error) {
    if (error instanceof MaintenanceFailure && error.code === "journal_invalid") throw new MaintenanceFailure("snapshot_invalid");
    throw error;
  }
  // TextDecoder may remove a UTF-8 BOM. The stored bytes themselves must be canonical.
  requireSourceFiles(Buffer.from(canonicalJson(value), "utf8").equals(bytes));
  return parseSourceFiles(value);
}
export const parseBundle = (value: unknown): RestoreBundleManifest => parse(bundle, value);
export const parsePublication = (value: unknown): PublicationEvidence => parse(publication, value);
export const parseVerification = (value: unknown): ActualRestoreVerification => parse(verification, value);
export const parseReceipt = (value: unknown): SnapshotReceipt => parse(receipt, value);
export const parseManifests = (value: unknown): DatabaseManifests => parse(manifests, value);

import type { StorageMaintenanceState } from "../admission.ts";
import type { DatabaseDescriptor, ResolvedBoardroomEnvironment } from "../../environment.ts";

/** #152 r3：这份合同只描述维护前缀，不包含 active v2 或业务写能力。 */
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type Phase = "planned" | "quiesced" | "snapshot_ready";
export type ObjectKind = "plan" | "journal" | "source-files" | "source-file-payload"
  | "database-snapshot" | "database-manifests" | "capability" | "restore-bundle"
  | "publication" | "verification" | "receipt";
export interface ArtifactRef { readonly ref: string; readonly sha256: string; readonly bytes: string }
export interface SourceRef {
  readonly kind: "sqlite" | "postgres";
  readonly databaseInstanceId: string;
  readonly identityDigest: string;
}
export type SourceClientTextCell = readonly ["text", string];
export type SourceClientIntegerCell = readonly ["integer", string];
export type SourceClientNullCell = readonly ["null"];
export interface SourceClientRawRow {
  readonly client_id: SourceClientTextCell;
  readonly database_instance_id: SourceClientTextCell;
  readonly entrypoint: SourceClientTextCell;
  readonly build_id: SourceClientTextCell;
  readonly host_identity_json: SourceClientTextCell;
  readonly process_identity_json: SourceClientTextCell;
  readonly db_sessions_json: SourceClientTextCell;
  readonly registered_at: SourceClientTextCell;
  readonly last_observed_at: SourceClientTextCell;
  readonly drain_state: SourceClientTextCell;
  readonly drain_receipt_digest: SourceClientTextCell | SourceClientNullCell;
  readonly ended_at: SourceClientTextCell | SourceClientNullCell;
  readonly protocol_version: readonly ["integer", "1"];
  readonly registered_epoch: SourceClientIntegerCell;
  readonly observed_epoch: SourceClientIntegerCell;
  readonly drain_epoch: SourceClientIntegerCell | SourceClientNullCell;
}
/** Complete typed original bytes. This value does not grant source provenance or quiescence. */
export interface SourceClientsRosterV1 {
  readonly formatVersion: 1;
  readonly kind: "source-clients-roster";
  readonly source: SourceRef;
  readonly migrationId: string;
  readonly plan: ArtifactRef;
  readonly fenceEpoch: string;
  readonly receiptGeneration: string;
  readonly textEncoding: { readonly backend: SourceRef["kind"]; readonly name: string };
  readonly rows: readonly SourceClientRawRow[];
}
export interface PathIdentity {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
}
export interface ControlRootIdentity extends PathIdentity { readonly hostIdentityDigest: string }
interface DurabilityCapabilityBase {
  readonly formatVersion: 1;
  readonly kind: "capability";
  readonly node: string;
  readonly rootIdentity: ControlRootIdentity;
  readonly powerLossTested: false;
  readonly probeDigest: string;
}
export type DurabilityCapability = DurabilityCapabilityBase & (
  | { readonly platform: "linux"; readonly filesystemType: string; readonly guarantee: "observed-file-fsync-rename-directory-fsync" }
  | { readonly platform: "darwin"; readonly filesystemType: "apfs"; readonly guarantee: "observed-file-and-directory-fullfsync-rename" }
);
export interface PlannedPath {
  readonly path: string;
  readonly existingAncestor: PathIdentity;
  readonly absentSegments: readonly string[];
}
export interface FileRoot {
  readonly label: "config" | "managed-sessions";
  readonly path: string;
  readonly expected: PlannedPath;
}
export type BlockerCode = "source_changed" | "source_missing" | "plan_stale" | "target_conflict"
  | "control_root_mismatch" | "source_writer_unknown" | "source_writer_active" | "drain_incomplete"
  | "maintenance_busy" | "maintenance_lost" | "schema_guard_incomplete" | "journal_invalid"
  | "snapshot_invalid" | "restore_verification_unavailable" | "unsupported_durability"
  | "backup_capability_unavailable" | "request_conflict" | "phase_conflict";
export interface Blocker { readonly code: BlockerCode; readonly subjectRef: string }
export interface MigrationPlan {
  readonly formatVersion: 1;
  readonly kind: "plan";
  readonly migrationId: string;
  readonly source: SourceRef;
  readonly sourceIdentity: Json;
  readonly originalCwd: string;
  readonly originalConfigPath: string | null;
  readonly configDigest: string;
  readonly effectiveConfigDigest: string;
  readonly schemaManifestDigest: string;
  readonly guardManifestDigest: string;
  readonly controlRoot: PlannedPath;
  readonly targetRoot: PlannedPath;
  readonly fileRoots: readonly FileRoot[];
  /** Planning observations only. These client rows and counts never authorize a later write or seal. */
  readonly preview: { readonly observedAt: string; readonly dataDigest: string; readonly tableCounts: Readonly<Record<string, string>>; readonly clientInventory: readonly Json[] };
  readonly requiredCapabilities: readonly string[];
  readonly blockers: readonly Blocker[];
}
export interface PersistedPlanRef {
  readonly migrationId: string;
  readonly planDigest: string;
  readonly immutablePlan: ArtifactRef;
  /** Private local locator, never an active storage root. */
  readonly controlRoot: string;
}
export interface MaintenanceCaptureRef {
  readonly migrationId: string;
  readonly source: SourceRef;
  readonly planDigest: string;
  readonly fenceEpoch: number;
  readonly journal: ArtifactRef;
  readonly journalSequence: number;
  readonly ownerGeneration: number;
}
export interface MaintenanceRef extends MaintenanceCaptureRef {}
interface JournalRecordBase {
  readonly kind: "journal";
  readonly migrationId: string;
  readonly sequence: number;
  readonly previous: ArtifactRef | null;
  readonly phase: Phase;
  readonly event: "enter" | "capture" | "ready" | "takeover" | "observation" | "cancel_intent" | "cancelled";
  readonly requestId: string;
  readonly requestDigest: string;
  readonly source: SourceRef;
  readonly plan: ArtifactRef;
  readonly fenceEpoch: number;
  readonly ownerGeneration: number;
  readonly evidence: readonly ArtifactRef[];
  /** Only ready records point to a prior receipt. The receipt never points back to ready. */
  readonly snapshot: ArtifactRef | null;
}
export interface JournalFrozenV1 {
  readonly sourceFilesManifest: ArtifactRef;
  readonly schemaManifestDigest: string;
  readonly frozenBusinessManifestDigest: string;
  readonly guardManifestDigest: string;
}
/** Legacy bytes remain explicit; current chains accept only the valid planned/no-Jq prefix. */
export interface JournalRecordV1 extends JournalRecordBase {
  readonly formatVersion: 1;
  readonly frozen: JournalFrozenV1 | null;
}
export interface JournalFrozenV2 extends JournalFrozenV1 { readonly sourceClientsDigest: string }
export interface JournalRecordV2 extends JournalRecordBase {
  readonly formatVersion: 2;
  /** Only capture embeds the complete original roster and its five frozen facts. */
  readonly sourceClients: SourceClientsRosterV1 | null;
  readonly frozen: JournalFrozenV2 | null;
}
export type JournalRecord = JournalRecordV1 | JournalRecordV2;
/** Explicit read-only V carrier; the default production writer/reader union stays v1/v2. */
export interface JournalRecordV3 extends Omit<JournalRecordV2, "formatVersion"> {
  readonly formatVersion: 3;
  readonly controlProof: import("./control-candidate/schema.ts").ControlProof | null;
}
export type VerificationJournalRecord = JournalRecord | JournalRecordV3;
export type SourceFileIncarnation =
  | { readonly type: 248; readonly byteCount: 32; readonly hex: string }
  | { readonly type: 1; readonly byteCount: 8; readonly hex: string };
interface SourceRootBindingBase {
  readonly sourceRoot: FileRoot["label"];
  readonly hostIdentityDigest: string;
  readonly filesystemUuidHex: string;
  readonly anchorPath: string;
  readonly anchorKind: "file" | "directory";
}
/** A recognized persisted codec is not an admitted runtime provider. */
export type SourceRootBinding = SourceRootBindingBase & (
  | { readonly profile: "linux-overlay-fid-fsuuid-v1"; readonly filesystemType: "overlay";
      readonly anchorHandle: Extract<SourceFileIncarnation, { type: 248 }> }
  | { readonly profile: "linux-native-ext4-fid-fsuuid-v1"; readonly filesystemType: "ext4";
      readonly anchorHandle: Extract<SourceFileIncarnation, { type: 1 }> }
  | { readonly profile: "linux-native-ext4-fid-fsuuid-source-state-v1"; readonly filesystemType: "ext4";
      readonly anchorHandle: Extract<SourceFileIncarnation, { type: 1 }>;
      readonly readEvidence: {
        readonly policy: "application-source-preservation-v1";
        readonly kernelDiagnosticPolicy: "ext4-last-mounted-v1";
        readonly profileEntryDigest: string;
        readonly qualificationDigest: string;
        readonly runtimeEnvironmentDigest: string;
        readonly sourceStateDigest: string;
        readonly blockEffectsObservation: "not-observed-at-runtime";
      } }
);
interface SourceFileEntryBase { readonly sourceRoot: string; readonly sourceRelativePath: string }
export type SourceFileEntry = SourceFileEntryBase & (
  | { readonly kind: "file"; readonly identity: PathIdentity; readonly mode: string; readonly size: string; readonly payload: ArtifactRef;
      readonly sourceWitness: { readonly kind: "file"; readonly incarnation: SourceFileIncarnation;
        readonly change: { readonly mtimeNs: string; readonly ctimeNs: string; readonly observedBirthtimeNs: string | null } } }
  | { readonly kind: "directory"; readonly identity: PathIdentity; readonly mode: string; readonly size: string | null; readonly payload: null;
      readonly sourceWitness: { readonly kind: "directory"; readonly incarnation: SourceFileIncarnation } }
  | { readonly kind: "absent"; readonly identity: null; readonly mode: null; readonly size: null; readonly payload: null; readonly sourceWitness: null }
);
export interface SourceFilesManifest {
  readonly formatVersion: 2;
  readonly kind: "source-files";
  readonly source: SourceRef;
  readonly roots: readonly FileRoot[];
  readonly rootBindings: readonly SourceRootBinding[];
  readonly entries: readonly SourceFileEntry[];
  readonly sourceMembershipExclusions: readonly ["database-files", "entire-maintenance-control-root", "all-maintenance-artifacts"];
}
export type RestorePayloadRole = "plan" | "journal-prefix" | "capture-journal" | "source-files-manifest"
  | "source-file-payload" | "database-snapshot" | "database-expected-manifests" | "capability-evidence";
export interface RestoreBundleManifest {
  readonly formatVersion: 1;
  readonly kind: "restore-bundle";
  readonly capture: MaintenanceCaptureRef;
  readonly sourceFilesManifest: ArtifactRef;
  readonly restorePointDigest: string;
  readonly entries: readonly { readonly role: RestorePayloadRole; readonly object: ArtifactRef }[];
}
export interface PublicationEvidence {
  readonly formatVersion: 1;
  readonly kind: "publication";
  readonly bundle: ArtifactRef;
  readonly capability: ArtifactRef;
  readonly observedOperations: readonly { readonly artifact: ArtifactRef; readonly completed: readonly ["file_sync", "rename" | "immutable_name_verified", "directory_sync"] }[];
}
export interface ActualRestoreVerification {
  readonly formatVersion: 1;
  readonly kind: "verification";
  readonly bundle: ArtifactRef;
  readonly publication: ArtifactRef;
  readonly verificationTargetIdentity: Json;
  readonly exactFullDataAndControlMatched: true;
  readonly sourceFilePayloadsMatched: true;
  readonly schemaAndScopeMatched: true;
}
export interface SnapshotReceipt {
  readonly formatVersion: 1;
  readonly kind: "receipt";
  readonly snapshotId: string;
  readonly capture: MaintenanceCaptureRef;
  readonly restorePointDigest: string;
  readonly sourceFilesManifest: ArtifactRef;
  readonly bundle: ArtifactRef;
  readonly publication: ArtifactRef;
  readonly verification: ArtifactRef;
  readonly database: ArtifactRef;
  readonly manifests: ArtifactRef;
  readonly capability: ArtifactRef;
  readonly schemaManifestDigest: string;
  readonly fullDataManifestDigest: string;
  readonly frozenBusinessManifestDigest: string;
  readonly capturedControlManifestDigest: string;
}
export interface ContinueRequest {
  readonly plan: PersistedPlanRef;
  readonly expectedSource: SourceRef;
  readonly expectedPhase: Phase | null;
  readonly expectedJournalDigest: string | null;
  readonly requestId: string;
}
export type MaintenanceResult =
  | { readonly status: "blocked" | "recovery_required"; readonly lastVerifiedPhase: Phase | null; readonly blockers: readonly Blocker[] }
  | { readonly status: "paused"; readonly phase: "planned" | "quiesced"; readonly ref: MaintenanceRef }
  | { readonly status: "snapshot_ready"; readonly phase: "snapshot_ready"; readonly ref: MaintenanceRef; readonly snapshot: ArtifactRef }
  | { readonly status: "cancel_pending"; readonly phase: Phase; readonly ref: MaintenanceRef; readonly blockers: readonly Blocker[] }
  | { readonly status: "cancelled"; readonly lastPhase: Phase; readonly terminalJournal: ArtifactRef; readonly openedFenceEpoch: number; readonly restartRequired: true };

/** Exact typed database manifest. Control rows are retained for per-field live comparison. */
export interface DatabaseManifests {
  readonly formatVersion: 1;
  readonly kind: "database-manifests";
  readonly dialect: "sqlite" | "postgres";
  readonly schema: Json;
  readonly schemaManifestDigest: string;
  readonly tables: readonly { readonly name: string; readonly columns: Json; readonly count: string; readonly digest: string }[];
  readonly controlRows: Readonly<Record<"storage_maintenance" | "storage_source_clients", readonly Readonly<Record<string, Json>>[]>>;
  readonly fullDataManifestDigest: string;
  readonly frozenBusinessManifestDigest: string;
  readonly capturedControlManifestDigest: string;
}
export interface SourceObservation {
  readonly source: SourceRef;
  readonly sourceIdentity: Json;
  readonly state: StorageMaintenanceState;
  readonly manifests: DatabaseManifests;
  readonly clients: readonly Readonly<Record<string, Json>>[];
}
/** One complete read view; neither this value nor its standalone reader authorizes capture. */
export interface SourceClientsObservation {
  readonly source: SourceRef;
  readonly sourceIdentity: Json;
  readonly state: StorageMaintenanceState;
  readonly schemaManifestDigest: string;
  readonly textEncoding: SourceClientsRosterV1["textEncoding"];
  readonly rows: readonly SourceClientRawRow[];
}
export interface SourceClientProcessFact {
  readonly status: "present" | "exited";
  readonly reason: "identity_matches" | "process_absent" | "identity_replaced" | "boot_changed";
}
export interface SourceClientFact {
  readonly clientId: string;
  readonly classification: "current-client" | "historical-client" | "historical-controller";
  readonly receipt: import("../source-client.ts").StorageDrainReceipt | null;
  readonly process: SourceClientProcessFact;
}
export interface SourceRuntimeFact {
  readonly bindingId: string;
  readonly memberId: string;
  readonly generation: number;
  readonly status: "not-owned" | "exited";
}
/** A scoped observation, never a quiescence/Fs/publication permit. */
export interface SourceClientFactsWindow {
  readonly observation: SourceClientsObservation;
  readonly origin: {
    readonly kind: "current-generation" | "captured-generation";
    readonly head: ArtifactRef;
    readonly capture: ArtifactRef | null;
    readonly receiptGeneration: number;
    readonly chain: import("./journal.ts").VerifiedJournalChain;
  };
  readonly clients: readonly SourceClientFact[];
  readonly runtime: readonly SourceRuntimeFact[];
  readonly scope: readonly string[];
  /** Repeats native observations; invalid after callback/lock end or a control write. */
  assertCurrent(): Promise<void>;
}
export interface AnchorChange {
  readonly expected: StorageMaintenanceState;
  readonly admission: "open" | "draining" | "sealed";
  readonly fenceEpoch: number;
  readonly ownerGeneration: number;
  readonly activeMigrationId: string | null;
  readonly planDigest: string | null;
  readonly controlRootIdentity: Json;
  readonly mutexIdentity: Json;
  readonly journal: ArtifactRef;
  readonly journalSequence: number;
}
/** A real native lock. No raw handle, generic SQL, unseal or business callback is exposed. */
export interface SourceLock {
  observe(): Promise<SourceObservation>;
  observeSourceClients(): Promise<SourceClientsObservation>;
  withSourceClientFacts<T>(plan: PersistedPlanRef, consume: (window: SourceClientFactsWindow) => Promise<T>): Promise<T>;
  /** Complete private native audit data; never a capture/control/Fs permit. */
  readSourceClientAudit(plan: PersistedPlanRef): Promise<import("./native-audit.ts").SourceClientAudit>;
  anchor(change: AnchorChange): Promise<void>;
  /** Uses an independent snapshot reader; the lock remains held throughout the callback. */
  backup(destination: string): Promise<{ readonly manifests: DatabaseManifests; readonly toolchain: Json }>;
  assertHeld(): Promise<void>;
}
export interface OperationMutex {
  readonly identity: Json;
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}
/** Internal adapter boundary for SQLite and PG. Never returned by the trusted service/CLI. */
export interface MaintenanceAdapter {
  readonly dialect: "sqlite" | "postgres";
  observe(): Promise<SourceObservation>;
  observeSourceClients(): Promise<SourceClientsObservation>;
  acquireMutex(controlRootIdentity: ControlRootIdentity, expected: StorageMaintenanceState): Promise<OperationMutex>;
  withSourceLock<T>(kind: "control" | "snapshot", callback: (lock: SourceLock) => Promise<T>): Promise<T>;
  inspectWriters(observation: SourceObservation): Promise<readonly Blocker[]>;
  /** Actually restores into a new isolated target and compares every manifest, including controls/ACL. */
  verifyDatabase(databaseFile: string, expected: DatabaseManifests, restoreDirectory: string): Promise<Json>;
  close(): Promise<void>;
}
export interface MaintenanceServiceOptions {
  readonly environment: ResolvedBoardroomEnvironment;
  readonly originalCwd: string;
  readonly expectedSourceId: string;
  readonly controlRoot: string;
  readonly targetRoot: string;
  /** Connection only to an explicitly supplied isolated verification DB; never the future active target. */
  readonly postgresVerification?: Extract<DatabaseDescriptor, {kind: "postgres"}>;
}

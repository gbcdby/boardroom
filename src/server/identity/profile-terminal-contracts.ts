/** Exact original terminal value shapes. None of these values conveys live admission. */
export type ProfileActivationRef = Readonly<{ activationId: string; digest: string }>;
export type ProfileTakeoverPlanRef = Readonly<{ planId: string; digest: string }>;
export type ProfileEvidenceRef = Readonly<{ artifactId: string; digest: string }>;
export type ProfileJournalAnchor = Readonly<{ record: ProfileEvidenceRef; sequence: number }>;
export type ProfileArtifactRef = Readonly<{ ref: string; sha256: string; bytes: string }>;
export type ProfileSourceRef = Readonly<{ kind: "sqlite" | "postgres"; databaseInstanceId: string; identityDigest: string }>;
export type ProfileCompletionBinding = Readonly<{
  activation: ProfileActivationRef;
  takeoverPlan: ProfileTakeoverPlanRef;
  migrationId: string;
  s4PlanDigest: string;
  sourceIdentityDigest: string;
  epochBefore: number;
  epochAfter: number;
  terminal: ProfileJournalAnchor;
}>;

export type ProfileGuardTransition = Readonly<{
  protocolBefore: 1; protocolAfter: 2;
  guardBeforeDigest: string; guardAfterDigest: string; schemaBeforeDigest: string; schemaAfterDigest: string;
  writerFormat: "s2-profile-config/v1"; writerFormatDigest: string; registeredUpgrade: ProfileEvidenceRef;
}>;
type ProfileRecordCommon = Readonly<{
  activation: ProfileActivationRef; takeoverPlan: ProfileTakeoverPlanRef; physicalSource: ProfileEvidenceRef;
}>;
type ProfileCommitCompletionCommon = ProfileRecordCommon & Readonly<{
  formatVersion: 1; migrationId: string; s4PlanDigest: string; requestDigest: string;
  predecessor: ProfileJournalAnchor; ownerGeneration: number;
}>;
export type ProfileCommitRecord = ProfileCommitCompletionCommon & Readonly<{
  eventKind: "s2_profile_committed"; phase: "s2_profile_committed"; fenceEpoch: number;
  guardTransition: ProfileGuardTransition; exactAllowedDelta: ProfileEvidenceRef; plannedTargetManifest: ProfileEvidenceRef;
  after: Readonly<{ admission: "sealed"; journal: "SELF"; terminal: null }>;
}>;
export type ProfileOwnerAcquired = ProfileRecordCommon & Readonly<{
  contract: "m2-profile-owner-acquired/r2"; fromGeneration: number; toGeneration: number;
  controlBefore: ProfileEvidenceRef; clientDelta: ProfileEvidenceRef;
  after: Readonly<{ admission: "sealed"; protocolVersion: 2; journal: "SELF"; terminal: null }>;
}>;
export type ProfileCompletionRecord = ProfileCommitCompletionCommon & Readonly<{
  eventKind: "s2_profile_completed"; phase: "s2_profile_completed"; fenceEpochBefore: number; sealedProof: ProfileEvidenceRef;
  after: Readonly<{ admission: "open"; fenceEpoch: number; activeMigrationId: null; planDigest: null;
    ownerGeneration: number; protocolVersion: 2; guardDigest: string; journal: "SELF"; completionBinding: "SELF_BINDING" }>;
}>;
type ProfileJournalCommon = Readonly<{
  formatVersion: 4; kind: "journal"; migrationId: string; sequence: number; previous: ProfileArtifactRef;
  source: ProfileSourceRef; plan: ProfileArtifactRef; requestId: string; requestDigest: string;
  fenceEpoch: number; ownerGeneration: number;
  bindings: Readonly<{ activationReceipt: ProfileArtifactRef; takeoverPlan: ProfileArtifactRef }>;
}>;
export type M2ProfileJournalRecord = ProfileJournalCommon & (
  Readonly<{ event: "s2_profile_committed"; phase: "s2_profile_committed"; body: ProfileCommitRecord }>
  | Readonly<{ event: "s2_profile_owner_acquired"; phase: "s2_profile_committed"; body: ProfileOwnerAcquired }>
  | Readonly<{ event: "s2_profile_completed"; phase: "s2_profile_completed"; body: ProfileCompletionRecord }>
);
export type M2ProfileJournalValue = Readonly<{ scope: "terminal-value-only"; record: M2ProfileJournalRecord;
  journalAnchor: ProfileJournalAnchor; completion: ProfileCompletionBinding | null }>;

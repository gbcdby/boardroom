import type { ReadonlyDeep, SourceRef } from "./m2-value-contracts.ts";
import type { P0Error, P0Location, P0Rule, P0Table } from "./internal/m2-p0-types.ts";

export type ClosureError = P0Error;
export type ClosureAvailability = {
  kind: "legacy-nonreversible-audit" | "missing-soft-source" | "unusable-unselected-runtime" | "legacy-display-unavailable";
  location: P0Location;
};
export type ClosureNativeCheck = "physical_source_authenticity" | "native_snapshot_window" | "actual_catalog_identity"
  | "strict_p1_native_outer_join" | "g1_exclusion" | "sequence_exclusion" | "current_authorization"
  | "native_commit" | "lossless_native_writer" | "full_ab_budget" | "fs_profile" | "production_tuple";
// This implementation issues only the complete legacy P0 branch. Known later
// branches keep their fixed unsupported result until their own checks exist.
export type ClosureValue = ReadonlyDeep<{
  classification: "observation";
  coverage: "complete-history-value-closure";
  graphKind: "m2-observation";
  phase: "p0";
  source: SourceRef;
  catalog: "legacy-p0";
  inputDigest: string;
  completeHistoryDigest: string;
  tables: { table: P0Table; rows: string; rowMultisetDigest: string }[];
  selectedArtifacts: { kind: string; artifactOrdinal: number; byteDigest: string; bytes: string }[];
  checks: { legacySemanticGraph: "verified"; m2SemanticGraph: "not-applicable";
    layoutSemanticGraph: "not-applicable"; artifactBytes: "verified"; artifactSemantics: "verified";
    sourceProvenance: "verified-values"; retainedReferenceClosure: "verified" | "not-requested" };
  deletion: null | { requestedCount: string; retainedHistoryDigest: string;
    retainedCounts: { table: P0Table; rows: string }[]; valueConsistent: true };
  ruleCoverage: { rule: P0Rule; status: "verified" | "not-applicable" }[];
  historicalAvailability: ClosureAvailability[];
  remaining: { check: ClosureNativeCheck; status: "not-applicable" | "unproven" }[];
}>;
export type ClosureResult = { readonly ok: true; readonly value: ClosureValue }
  | { readonly ok: false; readonly error: ClosureError };

import { MaintenanceFailure } from "./error.ts";
import type { SourceFileHandle, SourceFileMetadata } from "./source-file-native.ts";

/** P0 intentionally carries no qualified Linux source-preservation profiles.
 * Actual mount/FS UUID, kernel FID, health and source-state qualification
 * must be established from fresh, same-owner native measurements by a later
 * independently verified P profile implementation. An observation alone is
 * never authority to produce Fs or Jq. */
export interface QualifiedSourceFileProfile {
  readonly profile: string;
  readonly source: SourceFileMetadata;
  readonly qualificationDigest: string;
}
/** There is no test override, caller supplied proof, or accept-all fallback. */
export function matchSourceFileProfile(_root: SourceFileHandle): QualifiedSourceFileProfile {
  throw new MaintenanceFailure("backup_capability_unavailable", "source-file-profile-unqualified");
}

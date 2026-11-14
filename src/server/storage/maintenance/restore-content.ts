import type { SourceFilesManifest } from "./types.ts";

interface RestoreContentEntry {
  readonly sourceRoot: string;
  readonly relativePath: string;
  readonly kind: "file" | "directory" | "absent";
  readonly mode: string | null;
  readonly size: string | null;
  readonly contentDigest: string | null;
}

/** Internal, non-persistent content view of an already strictly parsed Fs v2.
 * Equality is not source identity, runtime qualification or actual restore verification. */
export function projectRestoreContent(files: SourceFilesManifest): readonly RestoreContentEntry[] {
  return files.entries.map(entry => ({
    sourceRoot: entry.sourceRoot,
    relativePath: entry.sourceRelativePath,
    kind: entry.kind,
    mode: entry.mode,
    size: entry.size,
    contentDigest: entry.kind === "file" ? entry.payload.sha256 : null,
  }));
}

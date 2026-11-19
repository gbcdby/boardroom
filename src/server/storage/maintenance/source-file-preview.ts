import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, digestJson } from "./canonical.ts";
import { MaintenanceFailure } from "./error.ts";
import { withNativeSourceRoot, withNativeSourcePreviewFile } from "./source-file-native.ts";
import type { SourceFileExtendedMetadata, SourceFileHandle } from "./source-file-native.ts";
import { matchSourceFileProfile, SOURCE_PREPARE_PROFILE } from "./source-file-profile.ts";
import type { SourceFileRootObservation } from "./source-file-profile.ts";
import { SourceFilesFailure } from "./source-files.ts";

const MAX_CONFIG_BYTES = 1024n * 1024n, MAX_WORK_MS = 120_000, CHUNK_BYTES = 65_536;
const fields = ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "atimeNs", "mtimeNs", "ctimeNs"] as const;
function requireValue(value: unknown, subject = "source-config-preview"): asserts value {
  if (!value) throw new MaintenanceFailure("source_changed", subject);
}
function encoded(value: unknown): unknown {
  if (typeof value === "bigint") return ["integer", String(value)];
  if (Buffer.isBuffer(value)) return ["bytes", value.toString("hex")];
  if (Array.isArray(value)) return value.map(encoded);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encoded(item)]));
  return value;
}
const same = (left: unknown, right: unknown) => canonicalJson(encoded(left)) === canonicalJson(encoded(right));
function health(value: SourceFileRootObservation["health"]): unknown {
  return Object.fromEntries(Object.entries(value).map(([name, { calls: _, ...observed }]) => [name, observed]));
}
function material(value: SourceFileRootObservation): unknown {
  return { root: value.root, uniqueStatx: value.uniqueStatx, mount: value.mount, health: health(value.health) };
}
async function currentPath(file: string, before: SourceFileExtendedMetadata): Promise<void> {
  const actual = await lstat(file, { bigint: true });
  requireValue(actual.isFile() && fields.every(field => actual[field] === before[field]) && await realpath(file) === file);
}

/** Fixed planning diagnostic. It creates no V, source sync, attempt, artifact,
 * client registration or restore authority. The ordinary R is opened only
 * after the private fixed matcher accepts the complete CFP2 preview policy. */
export async function readSourceConfigPreview(file: string | null): Promise<string> {
  const start = performance.now();
  if (file === null) return digestJson({ configFile: null });
  const check = () => {
    if (performance.now() - start > MAX_WORK_MS)
      throw new MaintenanceFailure("backup_capability_unavailable", "source-config-preview-budget");
  };
  const closeErrors: unknown[] = [];
  let phase: "input" | "profile" | "scan" | "health" | "close" = "input";
  try {
    requireValue(path.isAbsolute(file) && path.resolve(file) === file && !file.includes("\0") && Buffer.byteLength(file) <= 4096);
    return await withNativeSourceRoot(path.dirname(file), async parent => {
      check(); const parentBefore = parent.observeExtended();
      requireValue(parent.kind === "directory" && same(parentBefore.before, parentBefore.after));
      phase = "profile";
      const result = await withNativeSourcePreviewFile(file, async owner => {
        check(); const profile = matchSourceFileProfile(owner);
        requireValue(owner.kind === "file" && profile.profile === SOURCE_PREPARE_PROFILE);
        const before = profile.beforeContent(), metadata = before.root.before;
        requireValue(metadata.kind === "file" && metadata.nlink === 1n && metadata.size >= 0n
          && metadata.size <= MAX_CONFIG_BYTES, "source-config-preview-size");
        requireValue(metadata.dev === parentBefore.before.dev && metadata.fsType === parentBefore.before.fsType);
        await currentPath(file, metadata);
        const tail = profile.retainMetadata();
        const close = async (handle: SourceFileHandle) => {
          phase = "close";
          try { await handle.closeAsync(); }
          catch (error) { closeErrors.push(error); throw error; }
          check();
        };
        phase = "scan"; const hash = createHash("sha256"); let offset = 0n;
        while (offset < metadata.size) {
          check(); const remaining = metadata.size - offset;
          const count = Number(remaining > BigInt(CHUNK_BYTES) ? BigInt(CHUNK_BYTES) : remaining);
          const bytes = owner.readAt(offset, count);
          requireValue(bytes.length > 0 && bytes.length <= count); hash.update(bytes); offset += BigInt(bytes.length); check();
        }
        requireValue(owner.readAt(metadata.size, 1).length === 0);
        const fresh = owner.reopenFile(); let failed = false, first: unknown;
        try {
          const selected = matchSourceFileProfile(fresh);
          requireValue(selected.profile === profile.profile && selected.profileEntryDigest === profile.profileEntryDigest
            && selected.qualificationDigest === profile.qualificationDigest && same(material(before), material(selected.afterContent())));
          await currentPath(file, metadata);
        } catch (error) { failed = true; first = error; }
        try { await close(fresh); } catch (error) { if (!failed) { failed = true; first = error; } }
        if (failed) throw first;
        phase = "health"; requireValue(same(material(before), material(profile.afterContent())));
        await currentPath(file, metadata);
        const parentAfter = parent.observeExtended();
        requireValue(same(parentBefore.before, parentAfter.before) && same(parentBefore.before, parentAfter.after));
        await close(owner);
        tail.transferCarrier(parent); // Unique Dp -> A; no additional open/dup.
        phase = "health"; const after = profile.afterSourceClosed(tail);
        requireValue(same(metadata, after.metadata) && same(before.mount, after.mount) && same(health(before.health), health(after.health)));
        await currentPath(file, metadata); check(); phase = "close";
        try { await tail.closeAsync(); } catch (error) { closeErrors.push(error); throw error; }
        check(); return hash.digest("hex");
      });
      check(); return result;
    });
  } catch (error) {
    // Native scopes finish every original owner before this rejection, keeping
    // both the first failure and independent auxiliary/A/M close failures.
    if (error instanceof AggregateError && error.errors.length) {
      closeErrors.push(...error.errors.slice(1)); error = error.errors[0];
    }
    throw new SourceFilesFailure(error, phase, closeErrors, false);
  }
}

import path from "node:path";
import { canonicalJson } from "./canonical.ts";
import { MaintenanceFailure } from "./error.ts";
import { verifyRestoreBundleClosure } from "./journal.ts";
import { ArtifactStore } from "./objects.ts";
import { parseVerification } from "./parse.ts";
import { restoreSourceFiles } from "./restore-files.ts";
import type { ActualRestoreVerification, ArtifactRef, Json, MaintenanceAdapter, SourceLock } from "./types.ts";

const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
function requireValue(value: unknown, code: "snapshot_invalid" | "source_changed" | "maintenance_lost" | "control_root_mismatch"): asserts value {
  if (!value) throw new MaintenanceFailure(code, "verify-bundle");
}

/**
 * Internal B/U -> V under the caller's actual native adapter and snapshot lock.
 * The caller retains both and owns their eventual cleanup. In particular, public
 * PostgreSQL verification consumes the same adapter/window's native backup authority;
 * a persisted bundle is not a replacement for that authority or an offline permit.
 * This restores artifacts, not the live source; it never writes a source anchor,
 * receipt, ready record, or source-files qualification. Failed private attempts remain
 * unselected, and a publication failure can leave an unreturned immutable V orphan.
 */
export async function verifyRestoreBundle(store: ArtifactStore, adapter: MaintenanceAdapter, lock: SourceLock,
  bundleRef: ArtifactRef, publicationRef: ArtifactRef): Promise<ArtifactRef> {
  requireValue(store.kindFor(bundleRef) === "restore-bundle" && store.kindFor(publicationRef) === "publication", "snapshot_invalid");
  const fixedBundle = Object.freeze({ ...bundleRef }), fixedPublication = Object.freeze({ ...publicationRef });
  await lock.assertHeld(); await store.assertRoot();
  const closure = await verifyRestoreBundleClosure(store, fixedBundle, fixedPublication);
  const initial = await lock.observe();
  requireValue(initial.state.admission === "sealed", "maintenance_lost");
  requireValue(same(initial.source, closure.bundle.capture.source) && same(initial.sourceIdentity, closure.chain.plan.sourceIdentity)
    && adapter.dialect === initial.source.kind, "source_changed");
  requireValue(initial.state.controlRootJson === canonicalJson(store.identity) && initial.state.mutexIdentityJson !== null, "control_root_mismatch");
  // V consumes D's actual snapshot lock/window, not an arbitrary sealed snapshot
  // from an older control generation. The complete B/U closure proves its own
  // historical capture but does not by itself authorize this live source.
  const capture = closure.bundle.capture, captured = closure.chain.nodes.at(-1)!;
  requireValue(captured.record.event === "capture" && captured.record.frozen !== null, "journal_invalid");
  requireValue(initial.state.databaseInstanceId === capture.source.databaseInstanceId
    && initial.state.activeMigrationId === capture.migrationId && initial.state.planDigest === capture.planDigest
    && initial.state.fenceEpoch === capture.fenceEpoch && initial.state.ownerGeneration === capture.ownerGeneration
    && initial.state.journalRecordRef === capture.journal.ref
    && initial.state.journalDigest === capture.journal.sha256
    && initial.state.journalSequence === capture.journalSequence, "maintenance_lost");
  // Includes the sealed control row, all clients, full typed data and schema.
  // Comparing only frozen digests would miss a later legitimate journal head
  // or drift in a field not included in those digests.
  requireValue(initial.state.guardManifestDigest === captured.record.frozen.guardManifestDigest
    && same(initial.manifests, closure.manifests), "source_changed");
  const assertCurrent = async () => {
    await lock.assertHeld();
    const current = await lock.observe();
    requireValue(same(current.source, initial.source) && same(current.sourceIdentity, initial.sourceIdentity)
      && same(current.state, initial.state) && same(current.manifests, initial.manifests), "source_changed");
    await lock.assertHeld();
  };
  const guarded = await ArtifactStore.open(store.root, initial.source, { assertCurrent: () => lock.assertHeld() });
  requireValue(same(guarded.identity, store.identity), "control_root_mismatch");
  await assertCurrent();
  const databaseAttempt = await guarded.createAttempt(initial.state.ownerGeneration);
  // SQLite creates its restore leaf exclusively; PostgreSQL requires an existing
  // private directory for its native tool files. Neither is a future active target.
  const databaseDirectory = adapter.dialect === "sqlite" ? path.join(databaseAttempt, "database") : databaseAttempt;
  const database = await adapter.verifyDatabase(guarded.pathFor(closure.databaseRef), closure.manifests, databaseDirectory);
  await assertCurrent();
  const fileAttempt = await guarded.createAttempt(initial.state.ownerGeneration);
  const files = await restoreSourceFiles(guarded, closure.bundle.sourceFilesManifest, path.join(fileAttempt, "files"));
  requireValue(same(files.sourceFilesManifest, closure.bundle.sourceFilesManifest), "snapshot_invalid");
  // Recheck the exact closed byte/reference graph after the two real restorations.
  // These immutable references must not silently select another bundle or payload.
  await verifyRestoreBundleClosure(guarded, fixedBundle, fixedPublication);
  await assertCurrent();
  const target: Json = { kind: "isolated-restore-targets", database,
    sourceFiles: { kind: files.kind, sourceFilesManifest: { ...files.sourceFilesManifest }, target: { ...files.target },
      entries: files.entries.map(entry => ({ ...entry, identity: entry.identity ? { ...entry.identity } : null })) } };
  const verification: ActualRestoreVerification = parseVerification({ formatVersion: 1, kind: "verification",
    bundle: fixedBundle, publication: fixedPublication, verificationTargetIdentity: target,
    exactFullDataAndControlMatched: true, sourceFilePayloadsMatched: true, schemaAndScopeMatched: true });
  const reference = await guarded.putJson("verification", verification);
  await assertCurrent();
  return reference;
}

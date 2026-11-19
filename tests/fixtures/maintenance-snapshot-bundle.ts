import assert from "node:assert/strict";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { protocolEnterFixture as enterFixture } from "./maintenance-enter.ts";
import { enterMaintenance } from "./maintenance-preview-graph.ts";
import { ArtifactStore } from "../../src/server/storage/maintenance/objects.ts";
import { digestJson, sha256 } from "../../src/server/storage/maintenance/canonical.ts";
import { buildSourceClientsRoster, sourceClientsDigest } from "../../src/server/storage/maintenance/source-clients.ts";
import type { JournalRecordV2, MaintenanceAdapter, OperationMutex, SourceFileEntry, SourceFilesManifest, SourceLock } from "../../src/server/storage/maintenance/types.ts";

/** Real source, mutex, SQL capture point and backup. Fs incarnation fields are deliberately
 * fixed test data: this fixture does not scan/qualify a provider or authorize a production Jq. */
export async function snapshotBundleFixture(kind: "sqlite" | "postgres" = "sqlite",
  options: { changeCapture?: (record: JournalRecordV2) => JournalRecordV2 } = {}) {
  const f = await enterFixture(kind);
  let writer: Database.Database | undefined, adapter: MaintenanceAdapter | undefined, mutex: OperationMutex | undefined;
  const close = async () => {
    try { await mutex?.release(); }
    finally { try { await adapter?.close(); } finally { try { if (writer?.open) writer.close(); } finally { await f.close(); } } }
  };
  try {
    if (kind === "sqlite") {
      writer = new Database(f.file); writer.pragma("wal_autocheckpoint=0"); writer.pragma("wal_checkpoint(TRUNCATE)");
      writer.exec("INSERT INTO enter_observation VALUES('duplicate'),('duplicate'),(x'00ff'),(CAST(x'80' AS TEXT)),(NULL)");
    } else await f.exec("INSERT INTO enter_observation VALUES('duplicate'),('duplicate'),('原始字节'),(NULL)");
    const entered = await enterMaintenance(f.options, f.request); assert.equal(entered.status, "paused");
    adapter = await f.createAdapter();
    const store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source);
    mutex = await adapter.acquireMutex(store.identity, (await adapter.observe()).state);
    const handle = (file: string) => ({ type: 1 as const, byteCount: 8 as const, hex: sha256(file).slice(0, 16) });
    const entries: SourceFileEntry[] = [];
    const rootBindings: SourceFilesManifest["rootBindings"][number][] = [];
    for (const root of f.plan.fileRoots) {
      const ancestor = await lstat(root.expected.existingAncestor.path, { bigint: true });
      rootBindings.push({ sourceRoot: root.label, profile: "linux-native-ext4-fid-fsuuid-v1", filesystemType: "ext4",
        filesystemUuidHex: "4".repeat(32), hostIdentityDigest: store.identity.hostIdentityDigest,
        anchorPath: root.expected.existingAncestor.path, anchorKind: ancestor.isDirectory() ? "directory" : "file",
        anchorHandle: handle(root.expected.existingAncestor.path) });
      if (root.expected.absentSegments.length) {
        entries.push({ sourceRoot: root.label, sourceRelativePath: "", kind: "absent", identity: null,
          mode: null, size: null, payload: null, sourceWitness: null });
        continue;
      }
      const visit = async (relative: string): Promise<void> => {
        const file = path.join(root.path, relative), info = await lstat(file, { bigint: true });
        assert.ok(info.isFile() || info.isDirectory()); assert.equal(info.isSymbolicLink(), false);
        const identity = { path: file, device: String(info.dev), inode: String(info.ino) }, mode = Number(info.mode & 0o777n).toString(8);
        if (info.isDirectory()) {
          entries.push({ sourceRoot: root.label, sourceRelativePath: relative, kind: "directory", identity, mode, size: String(info.size), payload: null,
            sourceWitness: { kind: "directory", incarnation: handle(file) } });
          for (const child of (await readdir(file)).sort()) await visit(relative ? `${relative}/${child}` : child);
        } else {
          const payload = await store.putBytes("source-file-payload", await readFile(file));
          entries.push({ sourceRoot: root.label, sourceRelativePath: relative, kind: "file", identity, mode, size: String(info.size), payload,
            sourceWitness: { kind: "file", incarnation: handle(file), change: { mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs), observedBirthtimeNs: null } } });
        }
      };
      await visit("");
    }
    const files: SourceFilesManifest = { formatVersion: 2, kind: "source-files", source: f.plan.source, roots: f.plan.fileRoots,
      rootBindings, entries, sourceMembershipExclusions: ["database-files", "entire-maintenance-control-root", "all-maintenance-artifacts"] };
    const filesRef = await store.putJson("source-files", files);
    const capture = await adapter.withSourceLock("control", async lock => {
      const observed = await lock.observe(), raw = await lock.observeSourceClients();
      assert.equal(observed.state.admission, "draining");
      const previous = await store.readAnchoredJournal({ ref: observed.state.journalRecordRef!, sha256: observed.state.journalDigest! });
      const sourceClients = buildSourceClientsRoster({ formatVersion: 1, kind: "source-clients-roster", source: raw.source,
        migrationId: f.plan.migrationId, plan: f.reference.immutablePlan, fenceEpoch: String(raw.state.fenceEpoch),
        receiptGeneration: String(raw.state.ownerGeneration), textEncoding: raw.textEncoding, rows: raw.rows });
      let record: JournalRecordV2 = { formatVersion: 2, kind: "journal", migrationId: f.plan.migrationId, sequence: observed.state.journalSequence + 1,
        previous, phase: "quiesced", event: "capture", requestId: "fixed-capture-fixture", requestDigest: digestJson({ operation: "fixed-capture-fixture" }),
        source: observed.source, plan: f.reference.immutablePlan, fenceEpoch: observed.state.fenceEpoch, ownerGeneration: observed.state.ownerGeneration,
        evidence: [], snapshot: null, sourceClients, frozen: { sourceFilesManifest: filesRef,
          schemaManifestDigest: observed.manifests.schemaManifestDigest, frozenBusinessManifestDigest: observed.manifests.frozenBusinessManifestDigest,
          guardManifestDigest: observed.state.guardManifestDigest, sourceClientsDigest: sourceClientsDigest(sourceClients) } };
      record = options.changeCapture?.(record) ?? record;
      const reference = await store.putJson("journal", record);
      await lock.anchor({ expected: observed.state, admission: "sealed", fenceEpoch: record.fenceEpoch, ownerGeneration: record.ownerGeneration,
        activeMigrationId: record.migrationId, planDigest: record.plan.sha256, controlRootIdentity: store.identity as never,
        mutexIdentity: mutex!.identity, journal: reference, journalSequence: record.sequence });
      return { reference, record };
    });
    const sealed = await adapter.observe(), held = adapter;
    const run = <T>(consume: (lock: SourceLock) => Promise<T>): Promise<T> => held.withSourceLock("snapshot", consume);
    return { ...f, adapter, mutex, store, files, filesRef, capture, sealed, writer, run, close };
  } catch (error) { await close(); throw error; }
}

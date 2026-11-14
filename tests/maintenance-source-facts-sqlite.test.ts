import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, open, readFile, readlink, writeFile, rm, realpath, stat, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runMigrations } from "../src/server/db/migrate.ts";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { createRepositories } from "../src/server/db/repositories.ts";
import { createRuntimeRepository } from "../src/server/runtime/repository.ts";
import { captureOwnedProcessIdentity, inspectOwnedProcess } from "../src/server/runtime/hosts/process-identity.ts";
import { linuxIsolationAvailable, prepareLinuxIsolation, spawnIsolatedProcess } from "../src/server/runtime/isolation/linux.ts";
import { createPipeBridge } from "../src/server/runtime/isolation/pipe-bridge.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { resolveBoardroomEnvironment } from "../src/server/environment.ts";
import { createSqliteMaintenanceAdapter } from "../src/server/storage/maintenance/sqlite.ts";
import { planMigration, persistMigrationPlan } from "../src/server/storage/maintenance/plan.ts";
import { ArtifactStore } from "../src/server/storage/maintenance/objects.ts";
import { verifyJournalChain } from "../src/server/storage/maintenance/journal.ts";
import { buildSourceClientsRoster, sourceClientsDigest } from "../src/server/storage/maintenance/source-clients.ts";
import { registerStorageSourceClient, storageReceiptDigest, type StorageClientLifecycle } from "../src/server/storage/source-client.ts";
import type { JournalRecordV2, OperationMutex, SourceClientFactsWindow, SourceFilesManifest } from "../src/server/storage/maintenance/types.ts";

async function fixture(withClient = false, encoding: "UTF-8" | "UTF-16le" | "UTF-16be" = "UTF-8", nativeChild = false,
  setup?: (driver: SqliteDriver, directory: string) => Promise<Partial<StorageClientLifecycle>>, initialGeneration = 1) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "br-source-facts-")));
  const dataDir = path.join(directory, "data"); await mkdir(dataDir);
  const file = path.join(dataDir, "agent-studio.db"), configFile = path.join(directory, "config.json");
  const db = new Database(file);
  try {
    db.pragma(`encoding='${encoding}'`); runMigrations(db, migrations); db.pragma("journal_mode=WAL");
    // Controlled carried open state for a later maintenance window, not proof of prior maintenance runs.
    if (initialGeneration > 1) db.prepare("UPDATE storage_maintenance SET owner_generation=?,fence_epoch=?")
      .run(initialGeneration - 1, 2 * (initialGeneration - 1));
  } finally { db.close(); }
  await writeFile(configFile, JSON.stringify({ dataDir }));
  const environment = await resolveBoardroomEnvironment({ cwd: directory, homeDir: directory,
    env: { AGENT_STUDIO_CONFIG: configFile, BOARDROOM_HOME: path.join(directory, "home") } });
  assert.equal(environment.databaseDescriptor.kind, "sqlite");
  const adapter = await createSqliteMaintenanceAdapter(environment.databaseDescriptor as never);
  let mutex: OperationMutex | undefined;
  let sourceClient: Awaited<ReturnType<typeof registerStorageSourceClient>> | undefined;
  let native: ChildProcess | undefined, nativeDone: Promise<void> | undefined;
  try {
    if (nativeChild) {
      native = spawn(process.execPath, ["--input-type=module", "-e", `
        import { openNativeManagementSource } from ${JSON.stringify(new URL("../src/server/storage/native-management-admission.ts", import.meta.url).href)};
        const lease = await openNativeManagementSource({ source: ${JSON.stringify(environment.databaseDescriptor)}, mode: "write" });
        process.send({ kind: "registered" });
        await new Promise(resolve => process.once("message", resolve));
        await lease.close(); process.disconnect();
      `], { cwd: directory, stdio: ["ignore", "ignore", "pipe", "ipc"], timeout: 15_000 });
      let stderr = ""; native.stderr!.on("data", data => { stderr += String(data); });
      nativeDone = new Promise<void>((resolve, reject) => {
        native!.once("error", reject);
        native!.once("close", (code, signal) => code === 0 && signal === null ? resolve() : reject(new Error(`native fixture ${code}/${signal}: ${stderr}`)));
      });
      await Promise.race([new Promise<void>(resolve => native!.once("message", () => resolve())),
        nativeDone.then(() => assert.fail("native fixture exited before registration"))]);
    }
    if (withClient) {
      const driver = new SqliteDriver({ dataDir }); await driver.connect();
      const lifecycle = await setup?.(driver, directory);
      sourceClient = await registerStorageSourceClient({ db: driver, database: environment.databaseDescriptor, entrypoint: "http" });
      await sourceClient.bind({ stopNewWork() {}, async disconnectSessions() {}, async closeMemory() {},
        async stopOwnedRuntime() { return { ownedExits: [], unknownOwners: [] }; }, async observeOwnedExit() { throw new Error("no-owned-child"); }, ...lifecycle });
    }
    const options = { environment, originalCwd: directory, expectedSourceId: environment.inventory.selectedSourceId!,
      controlRoot: path.join(dataDir, "control"), targetRoot: path.join(directory, "target") };
    const plan = await planMigration(options, adapter), reference = await persistMigrationPlan(plan, options, adapter);
    const store = await ArtifactStore.open(reference.controlRoot, plan.source);
    mutex = await adapter.acquireMutex(store.identity, (await adapter.observe()).state);
    const head = await adapter.withSourceLock("control", async lock => {
      const observed = await lock.observeSourceClients();
      const journal = await store.putJson("journal", { formatVersion: 2, kind: "journal", migrationId: plan.migrationId,
        sequence: 1, previous: null, phase: "planned", event: "enter", requestId: "fixture-enter", requestDigest: "a".repeat(64),
        source: plan.source, plan: reference.immutablePlan, fenceEpoch: observed.state.fenceEpoch + 1, ownerGeneration: initialGeneration, evidence: [], snapshot: null,
        sourceClients: null, frozen: null });
      await lock.anchor({ expected: observed.state, admission: "draining", fenceEpoch: observed.state.fenceEpoch + 1, ownerGeneration: initialGeneration,
        activeMigrationId: plan.migrationId, planDigest: reference.planDigest, controlRootIdentity: store.identity as never,
        mutexIdentity: mutex!.identity, journal, journalSequence: 1 });
      return journal;
    });
    assert.equal((await verifyJournalChain(store, head)).nodes.length, 1, "fixture is a real complete anchored enter prefix");
    if (native) { native.send({ kind: "draining-committed" }); await nativeDone; }
    await sourceClient?.refresh();
    const receipt = await sourceClient?.waitForDrain();
    return { directory, dataDir, environment, options, file, adapter, store, reference, plan, head, mutex, sourceClient, receipt,
      async close() { await sourceClient?.close(); await mutex!.release(); await adapter.close(); await rm(directory, { recursive: true }); } };
  } catch (error) {
    if (native && native.exitCode === null && native.signalCode === null) { native.kill("SIGKILL"); await nativeDone?.catch(() => {}); }
    await sourceClient?.close(); await mutex?.release(); await adapter.close(); await rm(directory, { recursive: true }); throw error;
  }
}

function mutateClient(file: string, edit: (row: Record<string, unknown>, envelope: Record<string, unknown>, receipt: Record<string, unknown>) => void,
  corruptForeignKey = false) {
  const db = new Database(file, { fileMustExist: true, timeout: 0 });
  try {
    if (corruptForeignKey) db.pragma("foreign_keys=OFF"); // Explicit damaged-source fixture, not a legal registration path.
    const row = db.prepare("SELECT * FROM storage_source_clients").get() as Record<string, unknown>;
    const envelope = JSON.parse(String(row.db_sessions_json)) as Record<string, unknown>;
    const receipt = envelope.drainReceipt as Record<string, unknown>;
    edit(row, envelope, receipt);
    row.db_sessions_json = JSON.stringify(envelope);
    row.drain_receipt_digest = storageReceiptDigest(receipt);
    const names = Object.keys(row).filter(key => key !== "client_id");
    db.prepare(`UPDATE storage_source_clients SET ${names.map(key => `${key}=?`).join(",")} WHERE client_id=?`)
      .run(...names.map(key => row[key]), row.client_id);
  } finally { db.close(); }
}

/** Structural capture fixture only. These FID bytes do not assert any real Fs/provider qualification. */
async function anchorStructuralCapture(f: Awaited<ReturnType<typeof fixture>>) {
  const handle = { type: 1 as const, byteCount: 8 as const, hex: "0123456789abcdef" };
  const entries: SourceFilesManifest["entries"][number][] = [];
  for (const root of f.plan.fileRoots) {
    if (root.expected.absentSegments.length) {
      entries.push({ sourceRoot: root.label, sourceRelativePath: "", kind: "absent", identity: null, mode: null, size: null, payload: null, sourceWitness: null });
    } else {
      const info = await stat(root.path, { bigint: true });
      assert(info.isFile(), "this fixture has one real config and an absent session root");
      const payload = await f.store.putBytes("source-file-payload", await readFile(root.path));
      entries.push({ sourceRoot: root.label, sourceRelativePath: "", kind: "file", identity: root.expected.existingAncestor,
        mode: (info.mode & 0o777n).toString(8).padStart(3, "0"), size: payload.bytes, payload,
        sourceWitness: { kind: "file", incarnation: handle, change: { mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs), observedBirthtimeNs: null } } });
    }
  }
  const files: SourceFilesManifest = { formatVersion: 2, kind: "source-files", source: f.plan.source, roots: f.plan.fileRoots,
    rootBindings: f.plan.fileRoots.map(root => ({ sourceRoot: root.label, profile: "linux-native-ext4-fid-fsuuid-v1", filesystemType: "ext4",
      filesystemUuidHex: "4".repeat(32), hostIdentityDigest: f.store.identity.hostIdentityDigest,
      anchorPath: root.expected.existingAncestor.path, anchorKind: root.expected.absentSegments.length ? "directory" : "file", anchorHandle: handle })),
    entries, sourceMembershipExclusions: ["database-files", "entire-maintenance-control-root", "all-maintenance-artifacts"] };
  const filesRef = await f.store.putJson("source-files", files);
  return f.adapter.withSourceLock("control", async lock => {
    const raw = await lock.observeSourceClients(), full = await lock.observe();
    const previous = await f.store.readAnchoredJournal({ ref: raw.state.journalRecordRef!, sha256: raw.state.journalDigest! });
    const entered = await f.store.readJson(previous, "journal") as JournalRecordV2;
    const roster = buildSourceClientsRoster({ formatVersion: 1, kind: "source-clients-roster", source: raw.source,
      migrationId: f.plan.migrationId, plan: f.reference.immutablePlan, fenceEpoch: String(raw.state.fenceEpoch),
      receiptGeneration: String(raw.state.ownerGeneration), textEncoding: raw.textEncoding, rows: raw.rows });
    const record: JournalRecordV2 = { ...entered, sequence: entered.sequence + 1, previous, phase: "quiesced", event: "capture", requestId: "structural-capture-only",
      sourceClients: roster, frozen: { sourceFilesManifest: filesRef, schemaManifestDigest: full.manifests.schemaManifestDigest,
        frozenBusinessManifestDigest: full.manifests.frozenBusinessManifestDigest, guardManifestDigest: raw.state.guardManifestDigest,
        sourceClientsDigest: sourceClientsDigest(roster) } };
    const head = await f.store.putJson("journal", record);
    await lock.anchor({ expected: raw.state, admission: "sealed", fenceEpoch: raw.state.fenceEpoch, ownerGeneration: raw.state.ownerGeneration,
      activeMigrationId: f.plan.migrationId, planDigest: f.reference.planDigest, controlRootIdentity: f.store.identity as never,
      mutexIdentity: f.mutex.identity, journal: head, journalSequence: record.sequence });
    return { head, record };
  });
}

test("A11A SQLite facts use the actual planned anchor and expire when their callback exits", async () => {
  const f = await fixture(); let escaped: SourceClientFactsWindow | undefined;
  try {
    await f.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(f.reference, async window => {
      escaped = window;
      assert.equal(window.observation.rows.length, 0);
      assert.equal(window.origin.kind, "current-generation");
      assert.equal(window.origin.receiptGeneration, 1);
      assert.deepEqual(window.origin.head, f.head);
      assert.deepEqual(window.origin.chain, await verifyJournalChain(f.store, f.head));
      assert(Object.isFrozen(window.origin.chain.nodes));
      assert.deepEqual(window.clients, []);
      assert.deepEqual(window.runtime, []);
      assert(Object.isFrozen(window.observation));
      assert.equal(Object.hasOwn(window, "authorized"), false);
      await window.assertCurrent();
    }));
    await assert.rejects(escaped!.assertCurrent(), /maintenance_lost/);
  } finally { await f.close(); }
});

test("A11A SQLite uses the real database codec without narrowing the A10 raw byte domain", async t => {
  for (const encoding of ["UTF-8", "UTF-16le", "UTF-16be"] as const) await t.test(encoding, async () => {
    const f = await fixture(true, encoding);
    try {
      await f.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(f.reference, async window => {
        assert.equal(window.observation.textEncoding.name, encoding);
        assert.deepEqual(window.clients[0]!.receipt, f.receipt);
      }));
      const invalid = encoding === "UTF-8" ? "80ff00" : encoding === "UTF-16le" ? "00d8" : "d800";
      const db = new Database(f.file, { fileMustExist: true, timeout: 0 });
      try { db.exec(`UPDATE storage_source_clients SET last_observed_at=CAST(x'${invalid}' AS TEXT)`); } finally { db.close(); }
      await f.adapter.withSourceLock("control", async lock => {
        const raw = await lock.observeSourceClients();
        assert.deepEqual(raw.rows[0]!.last_observed_at, ["text", invalid]);
        await assert.rejects(lock.withSourceClientFacts(f.reference, async () => assert.fail("invalid semantic bytes admitted")), { code: "source_writer_unknown" });
        assert.deepEqual((await lock.observeSourceClients()).rows, raw.rows, "semantic refusal does not repair original bytes");
      });
    } finally { await f.close(); }
  });
});

test("A11A SQLite verifies an actual drained client while its read-only diagnostic process remains alive", async () => {
  const f = await fixture(true);
  try {
    assert(f.receipt);
    await f.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(f.reference, async window => {
      assert.equal(window.clients.length, 1);
      assert.equal(window.clients[0]!.classification, "current-client");
      assert.equal(window.clients[0]!.clientId, f.sourceClient!.clientId);
      assert.equal(window.clients[0]!.process.status, "present");
      assert.deepEqual(window.clients[0]!.receipt, f.receipt);
      assert.equal(window.observation.rows.length, 1);
      await window.assertCurrent();
    }));
  } finally { await f.close(); }
});

test("A11A rejects self-consistent current receipts from a different actual context", async t => {
  const cases: readonly [string, string, Parameters<typeof mutateClient>[1]][] = [
    ["wrong generation without capture", "drain_incomplete", (_row, _envelope, receipt) => { receipt.ownerGeneration = 2; }],
    ["other migration", "drain_incomplete", (_row, _envelope, receipt) => { receipt.migrationId = "other-migration"; }],
    ["other plan", "drain_incomplete", (_row, _envelope, receipt) => { receipt.planDigest = "b".repeat(64); }],
    ["other source marker", "source_changed", row => { row.database_instance_id = "b".repeat(32); }],
    ["other source identity", "source_changed", (_row, envelope, receipt) => {
      envelope.sourceIdentity = { ...(envelope.sourceIdentity as Record<string, unknown>), inode: "999999999" };
      receipt.sourceIdentityDigest = storageReceiptDigest(envelope.sourceIdentity);
    }],
    ["foreign host", "source_writer_unknown", row => {
      row.host_identity_json = JSON.stringify({ ...JSON.parse(String(row.host_identity_json)), hostname: "private-canary-host" });
    }],
    ["process-local-only identity", "source_writer_unknown", (row, _envelope, receipt) => {
      const identity = { ...JSON.parse(String(row.process_identity_json)), verification: "process_local_only" };
      row.process_identity_json = JSON.stringify(identity); receipt.processIdentityDigest = storageReceiptDigest(identity);
    }],
    ["malformed native start identity", "source_writer_unknown", (row, _envelope, receipt) => {
      const identity = JSON.parse(String(row.process_identity_json));
      identity[process.platform === "darwin" ? "startSeconds" : "startTicks"] = "not-a-native-start";
      row.process_identity_json = JSON.stringify(identity); receipt.processIdentityDigest = storageReceiptDigest(identity);
    }],
    ["foreign process namespace or uid", "source_writer_unknown", (row, _envelope, receipt) => {
      const identity = JSON.parse(String(row.process_identity_json));
      if (process.platform === "linux") identity.pidNamespace = "pid:[0]";
      else identity.uid = Number(identity.uid) + 1;
      row.process_identity_json = JSON.stringify(identity); receipt.processIdentityDigest = storageReceiptDigest(identity);
    }],
    ["unbound prior boot", "source_writer_unknown", (row, _envelope, receipt) => {
      const identity = JSON.parse(String(row.process_identity_json));
      identity[process.platform === "darwin" ? "bootSessionUuid" : "kernelBootId"] = "00000000-0000-4000-8000-000000000001";
      row.process_identity_json = JSON.stringify(identity); receipt.processIdentityDigest = storageReceiptDigest(identity);
    }],
    ["unknown maintenance registration", "source_writer_unknown", (row, _envelope, receipt) => {
      row.entrypoint = receipt.entrypoint = "maintenance-controller";
    }],
  ];
  for (const [name, code, edit] of cases) await t.test(name, async () => {
    const f = await fixture(true);
    try {
      mutateClient(f.file, edit, name === "other source marker");
      await assert.rejects(f.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(f.reference,
        async () => assert.fail("wrong context reached facts callback"))), error => {
        assert.equal((error as { code?: string }).code, code);
        assert(!String(error).includes("private-canary")); return true;
      });
    } finally { await f.close(); }
  });
});

test("A11A binds the exact plan and DB-selected journal, never a newer orphan", async t => {
  await t.test("unavailable plan has a safe category", async () => {
    const f = await fixture();
    try {
      const digest = "b".repeat(64);
      const missing = { ...f.reference, planDigest: digest, immutablePlan: { ref: `plans/${digest}.json`, sha256: digest, bytes: "1" } };
      await assert.rejects(f.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(missing, async () => assert.fail("missing plan admitted"))), { code: "plan_stale" });
    } finally { await f.close(); }
  });
  await t.test("orphan is never selected", async () => {
    const f = await fixture(true);
    try {
      const entered = await f.store.readJson(f.head, "journal") as JournalRecordV2;
      const orphan = await f.store.putJson("journal", { ...entered, sequence: 2, previous: f.head, event: "takeover", ownerGeneration: 2, requestId: "orphan" });
      assert.notEqual(orphan.ref, f.head.ref);
      await f.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(f.reference, async window => {
        assert.deepEqual(window.origin.head, f.head); assert.equal(window.origin.receiptGeneration, 1);
      }));
      await writeFile(f.store.pathFor(f.head), "damaged exact anchored original");
      await assert.rejects(f.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(f.reference, async () => assert.fail("orphan fallback"))), { code: "journal_invalid" });
    } finally { await f.close(); }
  });
  await t.test("no-Jq takeover cannot reuse an old receipt generation", async () => {
    const f = await fixture(true);
    try {
      const entered = await f.store.readJson(f.head, "journal") as JournalRecordV2;
      const next = await f.store.putJson("journal", { ...entered, sequence: 2, previous: f.head, event: "takeover", ownerGeneration: 2, requestId: "fixture-premature-takeover" });
      await f.adapter.withSourceLock("control", async lock => {
        const { state } = await lock.observeSourceClients();
        await lock.anchor({ expected: state, admission: "draining", fenceEpoch: 1, ownerGeneration: 2,
          activeMigrationId: f.plan.migrationId, planDigest: f.reference.planDigest, controlRootIdentity: f.store.identity as never,
          mutexIdentity: f.mutex.identity, journal: next, journalSequence: 2 });
      });
      assert.equal((await verifyJournalChain(f.store, next)).nodes.length, 2);
      await assert.rejects(f.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(f.reference, async () => assert.fail("old g without capture"))), { code: "journal_invalid" });
    } finally { await f.close(); }
  });
});

test("A11A REQ-001 rejects a takeover before first capture independently of the roster", async t => {
  for (const withClient of [false, true]) for (const withCapture of [false, true]) {
    await t.test(`${withClient ? "re-signed current receipt" : "empty roster"}, ${withCapture ? "later capture" : "no capture"}`, async () => {
      const f = await fixture(withClient); let consumed = false;
      try {
        const entered = await f.store.readJson(f.head, "journal") as JournalRecordV2;
        const takeover = await f.store.putJson("journal", { ...entered, sequence: 2, previous: f.head, event: "takeover",
          ownerGeneration: 2, requestId: "controlled-pre-capture-takeover" });
        await f.adapter.withSourceLock("control", async lock => {
          const { state } = await lock.observeSourceClients();
          await lock.anchor({ expected: state, admission: "draining", fenceEpoch: 1, ownerGeneration: 2,
            activeMigrationId: f.plan.migrationId, planDigest: f.reference.planDigest, controlRootIdentity: f.store.identity as never,
            mutexIdentity: f.mutex.identity, journal: takeover, journalSequence: 2 });
        });
        // Deliberately self-consistent damaged provenance, not a legal production receipt transition.
        if (withClient) mutateClient(f.file, (_row, _envelope, receipt) => { receipt.ownerGeneration = 2; });
        const head = withCapture ? (await anchorStructuralCapture(f)).head : takeover;
        assert.equal((await verifyJournalChain(f.store, head)).nodes.length, withCapture ? 3 : 2,
          "the general legacy journal reader keeps its existing compatibility semantics");
        await assert.rejects(f.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(f.reference, async () => {
          consumed = true;
        })), { code: "journal_invalid" });
        assert.equal(consumed, false, "bad source provenance is rejected before exposing a facts window");
      } finally { await f.close(); }
    });
  }
});

test("A11A REQ-001 accepts a legitimate initial generation above one", async t => {
  for (const withClient of [false, true]) await t.test(withClient ? "real drained receipt" : "empty roster", async () => {
    const f = await fixture(withClient, "UTF-8", false, undefined, 7);
    try {
      await f.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(f.reference, async window => {
        assert.equal(window.origin.receiptGeneration, 7);
        assert.equal(window.origin.chain.nodes.length, 1);
        assert.equal(window.clients.length, withClient ? 1 : 0);
        if (withClient) assert.deepEqual(window.clients[0]!.receipt, f.receipt);
        await window.assertCurrent();
      }));
      const capture = await anchorStructuralCapture(f);
      await f.adapter.withSourceLock("snapshot", lock => lock.withSourceClientFacts(f.reference, async window => {
        assert.equal(window.origin.kind, "captured-generation");
        assert.equal(window.origin.receiptGeneration, 7);
        assert.deepEqual(window.origin.capture, capture.head);
        await window.assertCurrent();
      }));
    } finally { await f.close(); }
  });
});

test("A11A REQ-002 binds each ordinary SQLite session to the actual backend", async t => {
  for (const swapped of [["local-driver"], ["client-control"], ["local-driver", "client-control"]]) {
    await t.test(swapped.join(" + "), async () => {
      const f = await fixture(true); let consumed = false;
      try {
        mutateClient(f.file, (_row, envelope) => {
          // These backend identities are controlled malformed registration material, not live PostgreSQL observations.
          envelope.sessions = ["local-driver", "client-control"].map(owner => {
            if (!swapped.includes(owner)) return { kind: "sqlite", owner };
            const applicationName = `${owner === "local-driver" ? "boardroom-source" : "boardroom-control"}:${f.sourceClient!.clientId}`;
            return { kind: "postgres", owner, ...(owner === "local-driver" ? { applicationName } : {}),
              observedBackends: [{ pid: 999, backend_start: "2026-11-14T00:00:00.000Z", application_name: applicationName }] };
          });
        });
        await assert.rejects(f.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(f.reference, async () => {
          consumed = true;
        })), { code: "source_writer_unknown" });
        assert.equal(consumed, false);
      } finally { await f.close(); }
    });
  }
});

test("A11A distinguishes a controlled old registration identity from the actual present process", async () => {
  const f = await fixture(true);
  try {
    // The OS process is real and remains alive; only its stored old start identity is controlled.
    // This covers identity replacement handling, not a claim of forced kernel PID reuse.
    mutateClient(f.file, (row, _envelope, receipt) => {
      const identity = JSON.parse(String(row.process_identity_json));
      const key = process.platform === "darwin" ? "startSeconds" : "startTicks";
      identity[key] = String(BigInt(identity[key]) + 1n);
      row.process_identity_json = JSON.stringify(identity); receipt.processIdentityDigest = storageReceiptDigest(identity);
    });
    await f.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(f.reference, async window => {
      assert.deepEqual(window.clients[0]!.process, { status: "exited", reason: "identity_replaced" });
      await window.assertCurrent();
    }));
  } finally { await f.close(); }
});

test("A11A invalidates facts after an attempted anchor and requires a fresh native lock", async () => {
  const f = await fixture();
  try {
    const entered = await f.store.readJson(f.head, "journal") as JournalRecordV2;
    const next = await f.store.putJson("journal", { ...entered, sequence: 2, previous: f.head, event: "observation", requestId: "next-committed-observation" });
    await f.adapter.withSourceLock("control", async lock => {
      const { state } = await lock.observeSourceClients();
      await lock.anchor({ expected: state, admission: "draining", fenceEpoch: 1, ownerGeneration: 1,
        activeMigrationId: f.plan.migrationId, planDigest: f.reference.planDigest, controlRootIdentity: f.store.identity as never,
        mutexIdentity: f.mutex.identity, journal: next, journalSequence: 2 });
      await assert.rejects(lock.withSourceClientFacts(f.reference, async () => assert.fail("uncommitted facts admitted")), { code: "maintenance_lost" });
    });
    await f.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(f.reference, async window => {
      await window.assertCurrent(); assert.deepEqual(window.origin.head, next);
    }));
  } finally { await f.close(); }
});

test("A11A proves an actually reaped native-management process from its real close receipt", async () => {
  const f = await fixture(false, "UTF-8", true);
  try {
    await f.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(f.reference, async window => {
      assert.equal(window.clients.length, 1);
      const client = window.clients[0]!;
      assert.equal(client.receipt?.buildId, "boardroom-native-management-v1");
      assert.deepEqual(client.receipt?.nativeTransactions, { committed: 0, rolledBack: 0, notAdmitted: 0 });
      assert.deepEqual(client.process, { status: "exited", reason: "process_absent" });
      assert.equal(client.classification, "current-client");
      await window.assertCurrent();
    }));
  } finally { await f.close(); }
});

test("A11A uses only the actually anchored first capture for old receipt generation", async () => {
  const f = await fixture(true);
  try {
    const capture = await anchorStructuralCapture(f);
    const record: JournalRecordV2 = { ...capture.record, sequence: 3, previous: capture.head, event: "takeover",
      requestId: "after-capture-takeover", ownerGeneration: 2, sourceClients: null, frozen: null };
    const takeover = await f.store.putJson("journal", record);
    await f.adapter.withSourceLock("control", async lock => {
      const { state } = await lock.observeSourceClients();
      await lock.anchor({ expected: state, admission: "sealed", fenceEpoch: 1, ownerGeneration: 2,
        activeMigrationId: f.plan.migrationId, planDigest: f.reference.planDigest, controlRootIdentity: f.store.identity as never,
        mutexIdentity: f.mutex.identity, journal: takeover, journalSequence: 3 });
    });
    await f.adapter.withSourceLock("snapshot", lock => lock.withSourceClientFacts(f.reference, async window => {
      assert.equal(window.observation.state.ownerGeneration, 2);
      assert.equal(window.origin.kind, "captured-generation");
      assert.equal(window.origin.receiptGeneration, 1);
      assert.deepEqual(window.origin.capture, capture.head);
      assert.deepEqual(window.origin.head, takeover);
      assert.deepEqual(window.origin.chain.nodes.map(node => node.reference), [f.head, capture.head, takeover]);
      assert.equal(window.clients[0]!.receipt!.ownerGeneration, 1);
      await window.assertCurrent();
    }));
    const db = new Database(f.file, { fileMustExist: true, timeout: 0 });
    try { db.prepare("UPDATE storage_source_clients SET last_observed_at=?").run("2026-11-15T12:00:00.000Z"); } finally { db.close(); }
    await assert.rejects(f.adapter.withSourceLock("snapshot", lock => lock.withSourceClientFacts(f.reference,
      async () => assert.fail("changed roster needs future A12 control successor proof"))), { code: "source_changed" });
  } finally { await f.close(); }
});

test("A11A inspects current member ownership as well as runner rows", async t => {
  for (const inconsistentMember of [false, true]) await t.test(inconsistentMember ? "unresolved member owner" : "never-owned runtime", async () => {
    let bindingId = "", memberId = "";
    const f = await fixture(true, "UTF-8", false, async (driver, directory) => {
      const repositories = createRepositories(driver), runtime = createRuntimeRepository(driver);
      const project = await repositories.projects.create({ name: "facts project" });
      const group = await repositories.groups.create({ projectId: project.id, name: "facts group" });
      const created = await runtime.create({ name: "facts runtime", backend: "claude-code", defaults: { workdir: directory },
        bindings: [{ projectId: project.id, groupId: group.id }] });
      bindingId = created.bindings[0]!.binding.id; memberId = created.bindings[0]!.binding.memberId;
      if (inconsistentMember) {
        // Controlled partially persisted ownership fault. No process or receipt claims it exited.
        await driver.exec("UPDATE agent_runtime_members SET binding_id=?,generation=1,lease_owner='unknown-owner',lease_expires_at=? WHERE member_id=?",
          [bindingId, new Date(Date.now() + 30_000).toISOString(), memberId]);
      }
      return {};
    });
    try {
      const read = () => f.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(f.reference, async window => {
        assert.deepEqual(window.runtime, [{ bindingId, memberId, generation: 0, status: "not-owned" }]);
      }));
      if (inconsistentMember) await assert.rejects(read(), { code: "source_writer_unknown" });
      else await read();
    } finally { await f.close(); }
  });
});

async function ownedWrapper(directory: string, label = "owned") {
  const workdir = path.join(directory, `${label}-work`); await mkdir(workdir);
  const prepared = await prepareLinuxIsolation({ executable: process.execPath,
    argv: ["-e", "process.on('SIGTERM',()=>process.exit(0));console.log('FACTS_READY');setInterval(()=>{},1000)"], prompt: "",
    workdir, stateRoot: path.join(directory, `${label}-state`), bindingId: `facts-${label}`, protectedPaths: [path.join(directory, "data")], egressHosts: [] });
  const child = spawnIsolatedProcess(prepared);
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; });
  const bridge = createPipeBridge(child, { egressHosts: [], onStdout: bytes => { if (bytes.toString().includes("FACTS_READY")) ready(); },
    onInvalid: () => child.kill("SIGKILL") });
  try {
    await bridge.transport.start(); await bridge.start();
    await Promise.race([started, exited.then(() => assert.fail("owned fixture exited before ready"))]);
    const identity = await captureOwnedProcessIdentity(child); assert(identity);
    return { child, identity,
      async stop() { if (child.exitCode === null && child.signalCode === null) await bridge.stopAtSafePoint(); await exited; },
      async close() { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; bridge.close(); await prepared.cleanup(); } };
  } catch (error) { child.kill("SIGKILL"); await exited; bridge.close(); await prepared.cleanup(); throw error; }
}

test("A11A independently checks real owned wrapper exit after markExit clears stored identity", { timeout: 30_000 }, async t => {
  if (process.platform !== "linux" || !await linuxIsolationAvailable()) { t.skip("Linux owned-wrapper profile unavailable on this platform"); return; }
  for (const actuallyExit of [true, false]) await t.test(actuallyExit ? "real exit" : "false exit receipt with live wrapper", async () => {
    let wrapper: Awaited<ReturnType<typeof ownedWrapper>> | undefined;
    let bindingId = "", memberId = "";
    let f: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      f = await fixture(true, "UTF-8", false, async (driver, directory) => {
        const repositories = createRepositories(driver), runtime = createRuntimeRepository(driver);
        const project = await repositories.projects.create({ name: "owned facts project" });
        const group = await repositories.groups.create({ projectId: project.id, name: "owned facts group" });
        const created = await runtime.create({ name: "owned facts", backend: "claude-code", defaults: { workdir: directory },
          bindings: [{ projectId: project.id, groupId: group.id }] });
        bindingId = created.bindings[0]!.binding.id; memberId = created.bindings[0]!.binding.memberId;
        await runtime.intent(bindingId, "start"); const fence = await runtime.claim(bindingId, "facts-fixture-owner");
        wrapper = await ownedWrapper(directory); await runtime.setProcessIdentity(fence, wrapper.identity);
        return { async stopOwnedRuntime() {
          if (actuallyExit) await wrapper!.stop();
          // The false branch deliberately records a lying lifecycle result to test independent OS proof.
          await runtime.markExit(fence, { exitCode: actuallyExit ? 0 : null });
          return { unknownOwners: [], ownedExits: [{ fence, processIdentity: wrapper!.identity,
            observation: "owned_handle_exited", exitCode: actuallyExit ? 0 : null, signal: null, observedAt: new Date().toISOString() }] };
        } };
      });
      const db = new Database(f.file, { readonly: true, fileMustExist: true });
      try { assert.deepEqual(db.prepare("SELECT lease_owner,process_identity_json,exit_confirmed,generation FROM agent_runner_states").get(),
        { lease_owner: null, process_identity_json: null, exit_confirmed: 1, generation: 1 }); } finally { db.close(); }
      const read = () => f!.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(f!.reference, async window => {
        assert.deepEqual(window.runtime, [{ bindingId, memberId, generation: 1, status: "exited" }]);
        assert.deepEqual(window.clients[0]!.receipt!.ownedExits[0]!.processIdentity, wrapper!.identity);
      }));
      if (actuallyExit) {
        assert.equal((await inspectOwnedProcess(wrapper!.identity)).status, "wrapper_exited"); await read();
      } else {
        await assert.rejects(read(), { code: "drain_incomplete" });
        assert.equal((await inspectOwnedProcess(wrapper!.identity)).status, "observed_alive", "facts do not kill a process to obtain success");
      }
    } finally { await wrapper?.close(); await f?.close(); }
  });
});

test("A11A keeps an older receipt generation historical across a real runtime restart", { timeout: 45_000 }, async t => {
  if (process.platform !== "linux" || !await linuxIsolationAvailable()) { t.skip("Linux owned-wrapper profile unavailable on this platform"); return; }
  for (const secondExits of [true, false]) await t.test(secondExits ? "later generation really exits" : "later generation still alive", async () => {
    const wrappers: Awaited<ReturnType<typeof ownedWrapper>>[] = [];
    let f: Awaited<ReturnType<typeof fixture>> | undefined, secondClient: Awaited<ReturnType<typeof registerStorageSourceClient>> | undefined;
    let secondDriver: SqliteDriver | undefined, bindingId = "", memberId = "";
    try {
      f = await fixture(true, "UTF-8", false, async (driver, directory) => {
        const repositories = createRepositories(driver), runtime = createRuntimeRepository(driver);
        const project = await repositories.projects.create({ name: "historical facts project" });
        const group = await repositories.groups.create({ projectId: project.id, name: "historical facts group" });
        const created = await runtime.create({ name: "historical facts", backend: "claude-code", defaults: { workdir: directory },
          bindings: [{ projectId: project.id, groupId: group.id }] });
        bindingId = created.bindings[0]!.binding.id; memberId = created.bindings[0]!.binding.memberId;
        await runtime.intent(bindingId, "start"); const fence = await runtime.claim(bindingId, "first-generation-owner");
        const wrapper = await ownedWrapper(directory, "first"); wrappers.push(wrapper); await runtime.setProcessIdentity(fence, wrapper.identity);
        return { async stopOwnedRuntime() {
          await wrapper.stop(); await runtime.markExit(fence, { exitCode: 0 });
          return { unknownOwners: [], ownedExits: [{ fence, processIdentity: wrapper.identity, observation: "owned_handle_exited",
            exitCode: 0, signal: null, observedAt: new Date().toISOString() }] };
        } };
      });
      const oldReceipt = f.receipt!; assert.equal(oldReceipt.ownedExits[0]!.fence.generation, 1);
      const capture = await anchorStructuralCapture(f);
      // This is a strict structural journal/controller fixture, not a claim that product Fs/cancel is released.
      let previous = capture.head;
      for (const [event, sequence, epoch] of [["cancel_intent", 3, 1], ["cancelled", 4, 2]] as const) {
        const head = await f.store.putJson("journal", { ...capture.record, event, sequence, fenceEpoch: epoch,
          previous, requestId: `structural-${event}`, sourceClients: null, frozen: null });
        await verifyJournalChain(f.store, head);
        await f.adapter.withSourceLock("control", async lock => {
          const { state } = await lock.observeSourceClients();
          await lock.anchor({ expected: state, admission: event === "cancelled" ? "open" : "sealed", fenceEpoch: epoch, ownerGeneration: 1,
            activeMigrationId: event === "cancelled" ? null : f!.plan.migrationId,
            planDigest: event === "cancelled" ? null : f!.reference.planDigest, controlRootIdentity: f!.store.identity as never,
            mutexIdentity: f!.mutex.identity, journal: head, journalSequence: sequence });
        });
        previous = head;
      }
      await f.sourceClient!.close();
      secondDriver = new SqliteDriver({ dataDir: f.dataDir }); await secondDriver.connect();
      const runtime = createRuntimeRepository(secondDriver); await runtime.intent(bindingId, "start");
      const fence = await runtime.claim(bindingId, "second-generation-owner"); assert.equal(fence.generation, 2);
      const second = await ownedWrapper(f.directory, "second"); wrappers.push(second); await runtime.setProcessIdentity(fence, second.identity);
      secondClient = await registerStorageSourceClient({ db: secondDriver, database: f.environment.databaseDescriptor, entrypoint: "http" });
      await secondClient.bind({ stopNewWork() {}, async disconnectSessions() {}, async closeMemory() {},
        async observeOwnedExit() { throw new Error("no additional wrapper"); }, async stopOwnedRuntime() {
          if (secondExits) await second.stop();
          // The negative branch intentionally records a false lifecycle result; OS proof must reject it.
          await runtime.markExit(fence, { exitCode: secondExits ? 0 : null });
          return { unknownOwners: [], ownedExits: [{ fence, processIdentity: second.identity, observation: "owned_handle_exited",
            exitCode: secondExits ? 0 : null, signal: null, observedAt: new Date().toISOString() }] };
        } });
      const plan = await planMigration(f.options, f.adapter), reference = await persistMigrationPlan(plan, f.options, f.adapter);
      await f.adapter.withSourceLock("control", async lock => {
        const { state } = await lock.observeSourceClients(); assert.equal(state.fenceEpoch, 2);
        const head = await f!.store.putJson("journal", { formatVersion: 2, kind: "journal", migrationId: plan.migrationId, sequence: 1,
          previous: null, phase: "planned", event: "enter", requestId: "second-real-maintenance", requestDigest: "b".repeat(64),
          source: plan.source, plan: reference.immutablePlan, fenceEpoch: 3, ownerGeneration: 2, evidence: [], snapshot: null, sourceClients: null, frozen: null });
        await lock.anchor({ expected: state, admission: "draining", fenceEpoch: 3, ownerGeneration: 2, activeMigrationId: plan.migrationId,
          planDigest: reference.planDigest, controlRootIdentity: f!.store.identity as never, mutexIdentity: f!.mutex.identity, journal: head, journalSequence: 1 });
      });
      await secondClient.refresh(); const currentReceipt = await secondClient.waitForDrain();
      const read = () => f!.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(reference, async window => {
        const historical = window.clients.find(client => client.clientId === oldReceipt.clientId)!;
        const current = window.clients.find(client => client.clientId === currentReceipt.clientId)!;
        assert.equal(historical.classification, "historical-client"); assert.deepEqual(historical.receipt, oldReceipt);
        assert.equal(historical.receipt!.ownedExits[0]!.fence.generation, 1);
        assert.equal(current.classification, "current-client"); assert.equal(current.receipt!.ownedExits[0]!.fence.generation, 2);
        assert.deepEqual(window.runtime, [{ bindingId, memberId, generation: 2, status: "exited" }]);
      }));
      if (secondExits) await read();
      else { await assert.rejects(read(), { code: "drain_incomplete" }); assert.equal((await inspectOwnedProcess(second.identity)).status, "observed_alive"); }
    } finally {
      for (const wrapper of wrappers) await wrapper.close();
      await secondClient?.close(); if (!secondClient) await secondDriver?.close(); await f?.close();
    }
  });
});

test("A11A empty SQLite roster still rejects a real unregistered source handle", { timeout: 20_000 }, async () => {
  const f = await fixture(); let child: ChildProcess | undefined, exited: Promise<void> | undefined;
  try {
    child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { openSync, closeSync } from 'node:fs';
      const fd=openSync(${JSON.stringify(f.file)},'r');process.send({ready:true});
      await new Promise(resolve=>process.once('message',resolve));closeSync(fd);process.disconnect();
    `], { stdio: ["ignore", "ignore", "ignore", "ipc"], timeout: 10_000 });
    exited = new Promise<void>((resolve, reject) => { child!.once("error", reject); child!.once("close", code => code === 0 ? resolve() : reject(new Error("owned source-handle fixture failed"))); });
    await Promise.race([new Promise<void>(resolve => child!.once("message", () => resolve())), exited.then(() => assert.fail("child closed before ready"))]);
    assert.deepEqual((await f.adapter.observeSourceClients()).rows, []);
    await assert.rejects(f.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(f.reference,
      async () => assert.fail("empty roster is not an empty OS inventory"))), { code: "source_writer_unknown" });
    child.send({ close: true }); await exited;
    await f.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(f.reference, async window => assert.deepEqual(window.clients, [])));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited?.catch(() => {}); }
    await f.close();
  }
});

test("A11A SQLite uses both real lock modes without DML or new source artifacts", async () => {
  const f = await fixture(true);
  try {
    for (const mode of ["control", "snapshot"] as const) {
      if (mode === "snapshot") await anchorStructuralCapture(f);
      const before = await f.adapter.observe(), config = await readFile(f.environment.configFile!);
      await f.adapter.withSourceLock(mode, async lock => {
        const assertCompetitorBlocked = () => new Promise<void>((resolve, reject) => {
          const competitor = spawn(process.execPath, ["--input-type=module", "-e", `
            import Database from 'better-sqlite3';
            const db=new Database(${JSON.stringify(f.file)},{fileMustExist:true,timeout:0});
            try { db.exec('BEGIN IMMEDIATE'); process.exitCode=2; }
            catch(error) { if(error.code!=='SQLITE_BUSY') process.exitCode=3; }
            finally { db.close(); }
          `], { stdio: "ignore", timeout: 5000 });
          competitor.once("error", reject); competitor.once("close", code => code === 0 ? resolve() : reject(new Error(`SQLite competitor exit ${code}`)));
        });
        await assertCompetitorBlocked();
        await lock.withSourceClientFacts(f.reference, async window => {
          await window.assertCurrent();
          await assertCompetitorBlocked();
        });
        await assertCompetitorBlocked();
      });
      const after = await f.adapter.observe();
      assert.deepEqual(after.manifests, before.manifests); assert.deepEqual(after.state, before.state); assert.deepEqual(after.clients, before.clients);
      assert.deepEqual(await readFile(f.environment.configFile!), config);
    }
  } finally { await f.close(); }
});

test("A11A SQLite rejects and sanitizes a real-handle close completion fault", async t => {
  const f = await fixture(true); const original = Database.prototype.close; let attempted = false, consumed = false;
  try {
    t.mock.method(Database.prototype, "close", function(this: Database.Database) {
      const result = Reflect.apply(original, this, []);
      if (this.name === f.file && !attempted) { attempted = true; throw new Error("private-sqlite-facts-close-canary"); }
      return result;
    });
    await assert.rejects(f.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(f.reference,
      async () => { consumed = true; })), error => /maintenance_lost/.test(String(error)) && !String(error).includes("canary"));
    assert.equal(attempted, true); assert.equal(consumed, false);
  } finally { t.mock.restoreAll(); await f.close(); }
});

test("A11A refuses an uncertain registered-process handle close without exposing its error", async t => {
  if (process.platform !== "linux") { t.skip("Linux proc handle boundary; Darwin uses its own native process observer"); return; }
  const probe = await open("/proc/self", "r"), prototype = Object.getPrototypeOf(probe), originalStat = prototype.stat;
  await probe.close();
  const f = await fixture(true); let attempted = false, consumed = false;
  try {
    t.mock.method(prototype, "stat", async function(this: FileHandle, ...args: unknown[]) {
      const result = await Reflect.apply(originalStat, this, args) as import("node:fs").Stats;
      if (!attempted && result.isDirectory() && await readlink(`/proc/self/fd/${this.fd}`) === `/proc/${process.pid}`) {
        const originalClose = this.close;
        this.close = async () => { await Reflect.apply(originalClose, this, []); attempted = true; throw new Error("private-proc-close-canary"); };
      }
      return result;
    });
    await assert.rejects(f.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(f.reference,
      async () => { consumed = true; })), error => {
      assert.equal((error as { code?: string }).code, "source_writer_unknown");
      assert(!String(error).includes("private-proc-close-canary")); return true;
    });
    assert.equal(attempted, true); assert.equal(consumed, false);
  } finally { t.mock.restoreAll(); await f.close(); }
});

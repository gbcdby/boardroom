import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { protocolEnterFixture as enterFixture } from "./maintenance-enter.ts";
import { enterMaintenance } from "./maintenance-preview-graph.ts";
import { ArtifactStore } from "../../src/server/storage/maintenance/objects.ts";
import { canonicalJson, digestJson, sha256 } from "../../src/server/storage/maintenance/canonical.ts";
import { captureReference, restorePointDigest, verifyVerificationJournalChain, verifyVerificationRestoreBundleClosure } from "../../src/server/storage/maintenance/journal.ts";
import { parseVerificationJournal } from "../../src/server/storage/maintenance/parse.ts";
import { encodeText } from "../../src/server/storage/maintenance/control-candidate/rows.ts";
import { rowsDigest } from "../../src/server/storage/maintenance/control-candidate/replay-core.ts";
import { controlProofSchema, registeredProcess, type EventFacts, type RegisteredProcess } from "../../src/server/storage/maintenance/control-candidate/schema.ts";
import { applyUntrustedControlSql, controlSqlOutcome } from "../../src/server/storage/maintenance/control-sql.ts";
import { buildSourceClientsRoster, sourceClientsDigest } from "../../src/server/storage/maintenance/source-clients.ts";
import { inspectRegisteredSourceProcess } from "../../src/server/storage/maintenance/source-facts.ts";
import { createPostgresMaintenanceAdapter } from "../../src/server/storage/maintenance/postgres.ts";
import type { ArtifactRef, JournalRecordV3, MaintenanceAdapter, OperationMutex, PublicationEvidence, RestorePayloadRole,
  SourceClientRawRow, SourceFileEntry, SourceFilesManifest, SourceLock } from "../../src/server/storage/maintenance/types.ts";

export async function nativeControllerWitness() {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./maintenance-verification-controller.ts", import.meta.url))],
    { stdio: ["pipe", "pipe", "inherit"] });
  const exited = once(child, "exit");
  try {
    let text = "";
    for await (const chunk of child.stdout) {
      text += String(chunk); if (text.includes("\n")) break;
      assert(text.length < 8192);
    }
    const decoded = JSON.parse(text) as { host: EventFacts["actor"]["host"]; process: unknown };
    const identity = registeredProcess.parse(decoded.process);
    assert.equal(identity.pid, child.pid);
    let ended = false;
    const close = async () => { if (!ended) { ended = true; child.stdin.end(); await exited; } };
    return { host: decoded.host, process: identity, close };
  } catch (error) { child.stdin.end(); await exited; throw error; }
}

/** Isolated protocol assembly, never a production v3 writer or controller factory.
 * Source locks, DB CAS, backup, restore and final process inspections are real.
 * The first audit is native; later EventFacts are historical protocol fixture data
 * with actual host/process checks. Their synthetic session projection grants no
 * native runtime authority. Fs incarnation fields retain #152's explicit fixture
 * status and do not qualify a provider. Every DB/path/process is owned and cleaned. */
export async function verificationV3Fixture(kind: "sqlite" | "postgres" = "sqlite",
  options: { sqliteEncoding?: "UTF-8" | "UTF-16le" | "UTF-16be" } = {}) {
  const f = await enterFixture(kind, options);
  let adapter: MaintenanceAdapter | undefined, mutex: OperationMutex | undefined, admin: Client | undefined;
  let targetName: string | undefined, targetUrl: string | undefined;
  const witnesses: Awaited<ReturnType<typeof nativeControllerWitness>>[] = [];
  const close = async () => {
    try { for (const witness of witnesses) await witness.close(); }
    finally {
      try { try { await mutex?.release(); } finally { await adapter?.close(); } }
      finally {
        try { if (admin && targetName) await admin.query(`DROP DATABASE "${targetName}"`); }
        finally { try { await admin?.end(); } finally { await f.close(); } }
      }
    }
  };
  try {
    // Empty historical roster is a normal fixture starting state. No sealed source
    // or archive is rewritten; later controller rows are introduced by exact CAS.
    await f.exec("DELETE FROM storage_source_clients; DELETE FROM agent_runtime_bindings");
    const entered = await enterMaintenance(f.options, f.request); assert.equal(entered.status, "paused");
    if (kind === "postgres") {
      assert(process.env.AGENT_STUDIO_PG_TEST_URL && f.descriptor.kind === "postgres");
      admin = new Client({ connectionString: process.env.AGENT_STUDIO_PG_TEST_URL }); admin.on("error", () => {}); await admin.connect();
      targetName = `br_verify_v3_${randomUUID().replaceAll("-", "")}`;
      await admin.query(`CREATE DATABASE "${targetName}" TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
      const url = new URL(process.env.AGENT_STUDIO_PG_TEST_URL); url.pathname = `/${targetName}`; targetUrl = url.toString();
      adapter = await createPostgresMaintenanceAdapter(f.descriptor, { kind: "postgres", connectionString: targetUrl });
    } else adapter = await f.createAdapter();
    const held = adapter, store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source);
    mutex = await held.acquireMutex(store.identity, (await held.observe()).state);
    const owner = mutex;
    const rootAudit = await held.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference));
    assert.equal(rootAudit.observation.rows.length, 0);
    const handle = (file: string) => ({ type: 1 as const, byteCount: 8 as const, hex: sha256(file).slice(0, 16) });
    const entries: SourceFileEntry[] = [], rootBindings: SourceFilesManifest["rootBindings"][number][] = [];
    for (const root of f.plan.fileRoots) {
      const ancestor = await lstat(root.expected.existingAncestor.path, { bigint: true });
      rootBindings.push({ sourceRoot: root.label, profile: "linux-native-ext4-fid-fsuuid-v1", filesystemType: "ext4",
        filesystemUuidHex: "4".repeat(32), hostIdentityDigest: store.identity.hostIdentityDigest,
        anchorPath: root.expected.existingAncestor.path, anchorKind: ancestor.isDirectory() ? "directory" : "file", anchorHandle: handle(root.expected.existingAncestor.path) });
      if (root.expected.absentSegments.length) {
        entries.push({ sourceRoot: root.label, sourceRelativePath: "", kind: "absent", identity: null, mode: null, size: null, payload: null, sourceWitness: null });
        continue;
      }
      const visit = async (relative: string): Promise<void> => {
        const file = path.join(root.path, relative), info = await lstat(file, { bigint: true });
        assert(info.isFile() || info.isDirectory()); assert.equal(info.isSymbolicLink(), false);
        const identity = { path: file, device: String(info.dev), inode: String(info.ino) }, mode = Number(info.mode & 0o777n).toString(8);
        if (info.isDirectory()) {
          entries.push({ sourceRoot: root.label, sourceRelativePath: relative, kind: "directory", identity, mode, size: String(info.size), payload: null,
            sourceWitness: { kind: "directory", incarnation: handle(file) } });
          for (const child of (await readdir(file)).sort()) await visit(relative ? `${relative}/${child}` : child);
        } else entries.push({ sourceRoot: root.label, sourceRelativePath: relative, kind: "file", identity, mode, size: String(info.size),
          payload: await store.putBytes("source-file-payload", await readFile(file)), sourceWitness: { kind: "file", incarnation: handle(file),
            change: { mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs), observedBirthtimeNs: null } } });
      };
      await visit("");
    }
    const files: SourceFilesManifest = { formatVersion: 2, kind: "source-files", source: f.plan.source, roots: f.plan.fileRoots, rootBindings, entries,
      sourceMembershipExclusions: ["database-files", "entire-maintenance-control-root", "all-maintenance-artifacts"] };
    const filesRef = await store.putJson("source-files", files);
    const root = await held.withSourceLock("control", async lock => {
      const observed = await lock.observe(), raw = await lock.observeSourceClients(), state = observed.state;
      assert.equal(state.admission, "draining"); assert(state.journalRecordRef && state.journalDigest);
      const previous = await store.readAnchoredJournal({ ref: state.journalRecordRef, sha256: state.journalDigest });
      const roster = buildSourceClientsRoster({ formatVersion: 1, kind: "source-clients-roster", source: raw.source, migrationId: f.plan.migrationId,
        plan: f.reference.immutablePlan, fenceEpoch: String(state.fenceEpoch), receiptGeneration: String(state.ownerGeneration), textEncoding: raw.textEncoding, rows: raw.rows });
      const record: JournalRecordV3 = { formatVersion: 3, kind: "journal", migrationId: f.plan.migrationId, sequence: state.journalSequence + 1,
        previous, phase: "quiesced", event: "capture", requestId: "fixture-v3-capture", requestDigest: digestJson({ operation: "fixture-v3-capture" }),
        source: raw.source, plan: f.reference.immutablePlan, fenceEpoch: state.fenceEpoch, ownerGeneration: state.ownerGeneration,
        evidence: [], snapshot: null, sourceClients: roster, frozen: { sourceFilesManifest: filesRef, schemaManifestDigest: raw.schemaManifestDigest,
          frozenBusinessManifestDigest: observed.manifests.frozenBusinessManifestDigest, guardManifestDigest: state.guardManifestDigest,
          sourceClientsDigest: sourceClientsDigest(roster) }, controlProof: controlProofSchema.parse({ formatVersion: 1, kind: "capture-controls",
          maintenanceInvariant: { singleton: "1", databaseInstanceId: state.databaseInstanceId, controlRootJson: state.controlRootJson,
            mutexIdentityJson: state.mutexIdentityJson, fenceEpoch: String(state.fenceEpoch), admission: "sealed", activeMigrationId: state.activeMigrationId,
            planDigest: state.planDigest, protocolVersion: "1", guardManifestDigest: state.guardManifestDigest }, facts: rootAudit.facts }) };
      parseVerificationJournal(record);
      const reference = await store.putJson("journal", record);
      await verifyVerificationJournalChain(store, reference);
      await lock.anchor({ expected: state, admission: "sealed", fenceEpoch: state.fenceEpoch, ownerGeneration: state.ownerGeneration,
        activeMigrationId: record.migrationId, planDigest: record.plan.sha256, controlRootIdentity: { ...store.identity }, mutexIdentity: owner.identity,
        journal: reference, journalSequence: record.sequence });
      return { reference, record, roster };
    });
    const run = <T>(consume: (lock: SourceLock) => Promise<T>) => held.withSourceLock("snapshot", consume);
    const publish = async (lock: SourceLock) => {
      await lock.assertHeld(); const before = await lock.observe(), state = before.state;
      assert(state.journalRecordRef && state.journalDigest);
      const head = await store.readAnchoredJournal({ ref: state.journalRecordRef, sha256: state.journalDigest });
      const chain = await verifyVerificationJournalChain(store, head), selected = chain.nodes.at(-1)!;
      assert.equal(selected.record.event, "capture");
      const attempt = await store.createAttempt(state.ownerGeneration), destination = path.join(attempt, kind === "sqlite" ? "database.sqlite" : "database.dump");
      const backup = await lock.backup(destination); assert.deepEqual(backup.manifests, before.manifests);
      const database = await store.importDatabase(destination), manifests = await store.putJson("database-manifests", backup.manifests);
      const capability = await store.putJson("capability", await store.capability());
      const members = new Map<string, { role: RestorePayloadRole; object: ArtifactRef }>();
      const add = (role: RestorePayloadRole, object: ArtifactRef) => { members.set(object.ref, { role, object }); };
      add("plan", selected.record.plan);
      for (const node of chain.nodes) {
        add(node === selected ? "capture-journal" : "journal-prefix", node.reference);
        for (const evidence of node.record.evidence) add("capability-evidence", evidence);
      }
      add("source-files-manifest", filesRef);
      for (const file of files.entries) if (file.payload) add("source-file-payload", file.payload);
      add("database-snapshot", database); add("database-expected-manifests", manifests); add("capability-evidence", capability);
      const capture = captureReference(selected);
      const bundle = await store.putJson("restore-bundle", { formatVersion: 1, kind: "restore-bundle", capture, sourceFilesManifest: filesRef,
        restorePointDigest: restorePointDigest({ capture, sourceFilesManifest: filesRef, database, manifests,
          schemaManifestDigest: backup.manifests.schemaManifestDigest, frozenBusinessManifestDigest: backup.manifests.frozenBusinessManifestDigest }), entries: [...members.values()] });
      const observedOperations: PublicationEvidence["observedOperations"][number][] = [];
      for (const reference of [...members.values()].map(item => item.object).concat(bundle)) observedOperations.push(await store.confirmDurable(reference));
      const publication = await store.putJson("publication", { formatVersion: 1, kind: "publication", bundle, capability, observedOperations } satisfies PublicationEvidence);
      await verifyVerificationRestoreBundleClosure(store, bundle, publication);
      assert.deepEqual(await lock.observe(), before); await lock.assertHeld();
      return { bundle, publication };
    };
    const text = (value: string) => { const cell = encodeText(value, root.roster.textEncoding); assert(cell); return cell; };
    let priorRow: SourceClientRawRow | undefined;
    let actorIdentity: { host: EventFacts["actor"]["host"]; process: RegisteredProcess } | undefined;
    let lastAt = Date.parse(rootAudit.facts.observedAt);
    const advance = async (operation: "register" | "observe" | "ended" | "recapture" | "takeover",
      options: { witness?: Awaited<ReturnType<typeof nativeControllerWitness>>; change?: (record: JournalRecordV3) => JournalRecordV3 } = {}) => {
      const before = await held.observe(), state = before.state;
      assert(state.journalRecordRef && state.journalDigest);
      const previous = await store.readAnchoredJournal({ ref: state.journalRecordRef, sha256: state.journalDigest });
      const observedAt = new Date(lastAt = Math.max(Date.now(), lastAt + 1)).toISOString();
      const beforeRows = priorRow ? [priorRow] : [], sequence = state.journalSequence + 1;
      let nextRow = priorRow;
      if (operation === "register") {
        assert(!priorRow);
        const witness = options.witness ?? await nativeControllerWitness(); witnesses.push(witness);
        actorIdentity = { host: witness.host, process: witness.process };
        const registration = { formatVersion: 1, kind: "maintenance-controller-registration", source: before.source, sourceIdentityDigest: before.source.identityDigest,
          creation: { migrationId: f.plan.migrationId, plan: f.reference.immutablePlan, fenceEpoch: String(state.fenceEpoch), ownerGeneration: String(state.ownerGeneration),
            previousAnchor: previous, targetSequence: String(sequence) }, sessionBinding: "per-source-lock-native-inventory-v1", drainReceipt: null };
        nextRow = { client_id: text(`controller-雪-${witness.process.instanceId}`), database_instance_id: text(state.databaseInstanceId), entrypoint: text("maintenance-controller"),
          build_id: text("boardroom-maintenance-control-v1"), protocol_version: ["integer", "1"], host_identity_json: text(canonicalJson(witness.host)),
          process_identity_json: text(canonicalJson(witness.process)), db_sessions_json: text(canonicalJson(registration)), registered_epoch: ["integer", String(state.fenceEpoch)],
          observed_epoch: ["integer", String(state.fenceEpoch)], drain_epoch: ["null"], drain_state: text("none"), drain_receipt_digest: ["null"],
          registered_at: text(observedAt), last_observed_at: text(observedAt), ended_at: ["null"] };
      } else if (operation === "observe" || operation === "ended") {
        assert(priorRow && actorIdentity);
        nextRow = { ...priorRow, last_observed_at: text(observedAt), ...(operation === "ended" ? { ended_at: text(observedAt) } : {}) };
      }
      const currentActor = operation === "ended" || !actorIdentity || priorRow?.ended_at[0] === "text" ? rootAudit.facts.actor : {
        actorId: actorIdentity.process.instanceId, clientId: operation === "register" ? null : priorRow!.client_id, ...actorIdentity,
        processCheck: (await inspectRegisteredSourceProcess(actorIdentity.host, actorIdentity.process)).check };
      const clients: EventFacts["clients"] = priorRow && actorIdentity ? [{ kind: "maintenance-controller", subject: ["text", priorRow.client_id[1]],
        rowDigest: digestJson({ formatVersion: 1, kind: "source-client-row", source: before.source, textEncoding: root.roster.textEncoding, row: priorRow }),
        host: actorIdentity.host, process: actorIdentity.process, processCheck: (await inspectRegisteredSourceProcess(actorIdentity.host, actorIdentity.process)).check,
        classification: operation === "ended" || priorRow.ended_at[0] !== "null" ? "exited-actor" : "active-actor", registration: "current-chain" }] : [];
      const baseSessions = rootAudit.facts.sessions;
      const sessions: EventFacts["sessions"] = baseSessions.kind === "postgres-session-audit-v1" ? baseSessions : baseSessions.kind === "sqlite-linux-session-audit-v1"
        ? { ...baseSessions, observer: { host: currentActor.host, process: currentActor.process }, ownedResources: [], matches: [] }
        : { ...baseSessions, observer: { host: currentActor.host, process: currentActor.process }, ownedResources: [], inventory: { ...baseSessions.inventory, items: [] } };
      const afterRows = nextRow ? [nextRow] : [];
      const changes = operation === "register" ? [{ kind: "maintenance-registration", before: null, after: nextRow, actorId: currentActor.actorId }]
        : operation === "observe" || operation === "ended" ? [{ kind: "client-observation", subject: priorRow!.client_id, before: priorRow, after: nextRow,
          effect: operation === "ended" ? "ended-observed" : "observed" }] : [];
      let record: JournalRecordV3 = { ...root.record, sequence, previous, event: operation === "recapture" ? "capture" : operation === "takeover" ? "takeover" : "observation",
        requestId: `fixture-v3-${sequence}`, requestDigest: digestJson({ operation, sequence }), ownerGeneration: state.ownerGeneration + (operation === "takeover" ? 1 : 0),
        frozen: operation === "recapture" ? root.record.frozen : null, sourceClients: operation === "recapture" ? root.roster : null,
        controlProof: controlProofSchema.parse({ formatVersion: 1, kind: "control-successor", originCapture: root.reference,
          originSourceClientsDigest: sourceClientsDigest(root.roster), source: before.source, plan: f.reference.immutablePlan, migrationId: f.plan.migrationId,
          fenceEpoch: String(state.fenceEpoch), receiptGeneration: root.roster.receiptGeneration, textEncoding: root.roster.textEncoding, previousAnchor: previous,
          fromGeneration: String(state.ownerGeneration), toGeneration: String(state.ownerGeneration + (operation === "takeover" ? 1 : 0)), targetSequence: String(sequence),
          beforeRowsDigest: rowsDigest(before.source, root.roster.textEncoding, beforeRows), afterRowsDigest: rowsDigest(before.source, root.roster.textEncoding, afterRows), changes,
          facts: { ...rootAudit.facts, observedAt, actor: currentActor, beforeCount: String(beforeRows.length),
            beforeRowsDigest: rowsDigest(before.source, root.roster.textEncoding, beforeRows), clients, sessions } }) };
      record = options.change?.(record) ?? record;
      const reference = await store.putJson("journal", record);
      const prefix = await verifyVerificationJournalChain(store, previous);
      const references = new Map<string, ArtifactRef>();
      for (const item of [f.reference.immutablePlan, filesRef, reference, ...prefix.nodes.map(node => node.reference),
        ...prefix.nodes.flatMap(node => node.record.evidence), ...files.entries.flatMap(file => file.payload ? [file.payload] : [])]) references.set(item.ref, item);
      const objects = await Promise.all([...references.values()].map(async item => ({ reference: item, bytes: await store.readBytes(item) })));
      let usedLock: SourceLock | undefined;
      // Existing isolated SQL mechanism applies rows plus exact anchor atomically
      // on the actual adapter-owned transaction. Its return remains untrusted data;
      // this fixture does not turn the mechanism into a production caller/permit.
      await held.withSourceLock("control", async lock => {
        usedLock = lock;
        await applyUntrustedControlSql(lock, { head: reference, objects, controlRoot: store.identity, mutexIdentity: owner.identity });
      });
      assert(usedLock); assert.equal(controlSqlOutcome(usedLock).status, "source-transaction-completed");
      priorRow = nextRow;
      return { reference, record, row: nextRow, witness: witnesses.at(-1) };
    };
    const readTarget = async (sql: string) => {
      assert(targetUrl); const client = new Client({ connectionString: targetUrl }); await client.connect();
      try { return (await client.query(sql)).rows; } finally { await client.end(); }
    };
    return { ...f, adapter: held, mutex: owner, store, files, filesRef, root, run, publish, advance, readTarget, targetName, close };
  } catch (error) { await close(); throw error; }
}

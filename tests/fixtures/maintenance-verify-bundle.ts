import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createPostgresMaintenanceAdapter } from "../../src/server/storage/maintenance/postgres.ts";
import { digestJson } from "../../src/server/storage/maintenance/canonical.ts";
import { verifyJournalChain } from "../../src/server/storage/maintenance/journal.ts";
import { buildSourceClientsRoster, sourceClientsDigest } from "../../src/server/storage/maintenance/source-clients.ts";
import { publishSnapshotBundle } from "../../src/server/storage/maintenance/snapshot-bundle.ts";
import type { JournalRecordV2, SourceLock } from "../../src/server/storage/maintenance/types.ts";
import { snapshotBundleFixture } from "./maintenance-snapshot-bundle.ts";

/** Reuses D's exact real source/capture fixture. Its Fs incarnation bytes remain
 * explicit protocol fixtures, not provider or source-preservation qualification. */
export async function verificationBundleFixture(kind: "sqlite" | "postgres" = "sqlite") {
  const f = await snapshotBundleFixture(kind);
  let adapter = f.adapter, mutex = f.mutex, admin: Client | undefined, targetName: string | undefined, targetUrl: string | undefined;
  const close = async () => {
    try { await mutex.release(); await adapter.close(); }
    finally {
      try { if (admin && targetName) await admin.query(`DROP DATABASE "${targetName}"`); }
      finally { try { await admin?.end(); } finally { await f.close(); } }
    }
  };
  try {
    if (kind === "postgres") {
      assert(process.env.AGENT_STUDIO_PG_TEST_URL);
      admin = new Client({ connectionString: process.env.AGENT_STUDIO_PG_TEST_URL }); admin.on("error", () => {}); await admin.connect();
      const name = `br_verify_bundle_${randomUUID().replaceAll("-", "")}`;
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`); targetName = name;
      const url = new URL(process.env.AGENT_STUDIO_PG_TEST_URL); url.pathname = `/${name}`; targetUrl = url.toString();
      await mutex.release(); await adapter.close();
      assert(f.descriptor.kind === "postgres");
      adapter = await createPostgresMaintenanceAdapter(f.descriptor, { kind: "postgres", connectionString: targetUrl });
      mutex = await adapter.acquireMutex(f.store.identity, (await adapter.observe()).state);
    }
    const run = <T>(consume: (lock: SourceLock) => Promise<T>): Promise<T> => adapter.withSourceLock("snapshot", consume);
    const publish = (lock: SourceLock) => publishSnapshotBundle(f.store, lock);
    // Exact protocol successors through real source-control transactions and DB CAS,
    // not mocked lock observations or a newly opened database with a different source.
    const advance = async (event: "observation" | "takeover" | "cancel_intent" | "cancelled") => {
      await mutex.assertHeld();
      return adapter.withSourceLock("control", async lock => {
        const observed = await lock.observe(), state = observed.state;
        assert(state.journalRecordRef && state.journalDigest);
        const predecessor = await f.store.readAnchoredJournal({ ref: state.journalRecordRef, sha256: state.journalDigest });
        const chain = await verifyJournalChain(f.store, predecessor), previous = chain.nodes.at(-1)!.record;
        const record: JournalRecordV2 = { ...f.capture.record, source: observed.source, plan: previous.plan,
          migrationId: previous.migrationId, previous: predecessor, sequence: state.journalSequence + 1,
          event, phase: previous.phase, requestId: `v-${event}-${state.journalSequence + 1}`,
          requestDigest: digestJson({ event, sequence: state.journalSequence + 1 }),
          fenceEpoch: state.fenceEpoch + (event === "cancelled" ? 1 : 0),
          ownerGeneration: state.ownerGeneration + (event === "takeover" ? 1 : 0),
          frozen: null, sourceClients: null, snapshot: null, evidence: [] };
        const journal = await f.store.putJson("journal", record);
        await verifyJournalChain(f.store, journal);
        await lock.anchor({ expected: state, admission: event === "cancelled" ? "open" : "sealed",
          fenceEpoch: record.fenceEpoch, ownerGeneration: record.ownerGeneration,
          activeMigrationId: event === "cancelled" ? null : record.migrationId,
          planDigest: event === "cancelled" ? null : record.plan.sha256, controlRootIdentity: f.store.identity,
          mutexIdentity: mutex.identity, journal, journalSequence: record.sequence });
        return journal;
      });
    };
    const newSealedEpoch = async () => {
      await advance("cancel_intent"); await advance("cancelled");
      const nextPlan = { ...f.plan, migrationId: `${f.plan.migrationId}-v2` };
      const plan = await f.store.putJson("plan", nextPlan);
      await adapter.withSourceLock("control", async lock => {
        const current = await lock.observe(), state = current.state;
        assert.equal(state.admission, "open");
        const enter: JournalRecordV2 = { ...f.capture.record, migrationId: nextPlan.migrationId,
          source: current.source, plan, previous: null, sequence: 1, phase: "planned", event: "enter",
          requestId: "v2-enter", requestDigest: digestJson({ operation: "v2-enter" }),
          fenceEpoch: state.fenceEpoch + 1, ownerGeneration: state.ownerGeneration + 1,
          evidence: [], frozen: null, sourceClients: null, snapshot: null };
        const journal = await f.store.putJson("journal", enter);
        await verifyJournalChain(f.store, journal);
        await lock.anchor({ expected: state, admission: "draining", fenceEpoch: enter.fenceEpoch,
          ownerGeneration: enter.ownerGeneration, activeMigrationId: enter.migrationId,
          planDigest: plan.sha256, controlRootIdentity: f.store.identity, mutexIdentity: mutex.identity,
          journal, journalSequence: 1 });
      });
      const journal = await adapter.withSourceLock("control", async lock => {
        const current = await lock.observe(), raw = await lock.observeSourceClients(), state = current.state;
        assert.equal(state.admission, "draining"); assert(state.journalRecordRef && state.journalDigest);
        const previous = await f.store.readAnchoredJournal({ ref: state.journalRecordRef, sha256: state.journalDigest });
        const sourceClients = buildSourceClientsRoster({ formatVersion: 1, kind: "source-clients-roster",
          source: raw.source, migrationId: nextPlan.migrationId, plan, fenceEpoch: String(state.fenceEpoch),
          receiptGeneration: String(state.ownerGeneration), textEncoding: raw.textEncoding, rows: raw.rows });
        const capture: JournalRecordV2 = { ...f.capture.record, migrationId: nextPlan.migrationId,
          source: current.source, plan, previous, sequence: 2, phase: "quiesced", event: "capture",
          requestId: "v2-capture", requestDigest: digestJson({ operation: "v2-capture" }),
          fenceEpoch: state.fenceEpoch, ownerGeneration: state.ownerGeneration, evidence: [], snapshot: null,
          sourceClients, frozen: { sourceFilesManifest: f.filesRef,
            schemaManifestDigest: current.manifests.schemaManifestDigest,
            frozenBusinessManifestDigest: current.manifests.frozenBusinessManifestDigest,
            guardManifestDigest: state.guardManifestDigest, sourceClientsDigest: sourceClientsDigest(sourceClients) } };
        const reference = await f.store.putJson("journal", capture);
        await verifyJournalChain(f.store, reference);
        await lock.anchor({ expected: state, admission: "sealed", fenceEpoch: state.fenceEpoch,
          ownerGeneration: state.ownerGeneration, activeMigrationId: capture.migrationId, planDigest: plan.sha256,
          controlRootIdentity: f.store.identity, mutexIdentity: mutex.identity, journal: reference, journalSequence: 2 });
        return reference;
      });
      return journal;
    };
    const readTarget = async (sql: string) => {
      assert(targetUrl); const client = new Client({ connectionString: targetUrl }); await client.connect();
      try { return (await client.query(sql)).rows; } finally { await client.end(); }
    };
    return { ...f, adapter, mutex, targetName, admin, run, publish, advance, newSealedEpoch, readTarget, close };
  } catch (error) { await close(); throw error; }
}

import assert from "node:assert/strict";
import test from "node:test";
import { verificationV3Fixture } from "./fixtures/maintenance-verification-v3.ts";
import { controlVector, historicalClient, successorVector } from "./fixtures/maintenance-control-candidate.ts";
import { digestJson } from "../src/server/storage/maintenance/canonical.ts";
import { parsePlan, parseVerificationJournal } from "../src/server/storage/maintenance/parse.ts";
import { verifyVerificationJournalChain } from "../src/server/storage/maintenance/journal.ts";
import { replayVerificationControls } from "../src/server/storage/maintenance/control-candidate/replay-core.ts";
import { assertVerificationSourceClientBinding } from "../src/server/storage/maintenance/verification-source-client-binding.ts";
import { buildDatabaseManifests } from "../src/server/storage/maintenance/manifests.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";
import type { DatabaseManifests, Json, SourceClientsObservation, SourceLock, SourceObservation } from "../src/server/storage/maintenance/types.ts";

const nativeTest = ["linux", "darwin"].includes(process.platform) ? test : test.skip;
const pgTest = process.env.AGENT_STUDIO_PG_TEST_URL ? test : test.skip;
const changed = (error: unknown) => error instanceof MaintenanceFailure && error.code === "source_changed";

for (const kind of ["sqlite", "postgres"] as const) (kind === "sqlite" ? nativeTest : pgTest)(
  `#248 binding ${kind}: archive selected capture and live head are separate complete native row states`, async t => {
    const f = await verificationV3Fixture(kind);
    try {
      await f.advance("register"); await f.advance("recapture");
      const captureView = await f.adapter.observe(), archived = captureView.manifests;
      assert(captureView.state.journalRecordRef && captureView.state.journalDigest);
      const selectedChain = await verifyVerificationJournalChain(f.store, await f.store.readAnchoredJournal({
        ref: captureView.state.journalRecordRef, sha256: captureView.state.journalDigest }));
      const selected = selectedChain.nodes.at(-1)!;
      await f.advance("observe"); await f.advance("takeover");
      await f.run(async lock => {
        const observed = await lock.observe(), raw = await lock.observeSourceClients();
        assert(observed.state.journalRecordRef && observed.state.journalDigest);
        const chain = await verifyVerificationJournalChain(f.store, await f.store.readAnchoredJournal({
          ref: observed.state.journalRecordRef, sha256: observed.state.journalDigest }));
        const replay = replayVerificationControls(chain.plan, chain.nodes, { controlRoot: f.store.identity, mutexIdentity: f.mutex.identity });
        const bind = (manifest = archived, native = lock, view = observed) => assertVerificationSourceClientBinding(native, view, selected, manifest, replay);
        assert.deepEqual(await bind(), []);
        assert.equal(archived.controlRows.storage_source_clients.length, 1);
        assert.notDeepEqual(archived.controlRows.storage_source_clients, observed.manifests.controlRows.storage_source_clients);
        const rows = archived.controlRows.storage_source_clients;
        const rebuild = (values: typeof rows = rows, tables: DatabaseManifests["tables"] = archived.tables) =>
          buildDatabaseManifests(kind, archived.schema, tables, { ...archived.controlRows, storage_source_clients: values });
        for (const [name, value] of [
          ["extra row", [...rows, { ...rows[0]!, client_id: "extra" }]], ["missing row", []], ["duplicate row", [...rows, rows[0]!]],
          ["extra field", [{ ...rows[0]!, extra: null }]],
          ["missing field", [Object.fromEntries(Object.entries(rows[0]!).filter(([column]) => column !== "ended_at"))]],
        ] as const) await t.test(name, () => assert.rejects(bind(rebuild(value)), changed));
        for (const [column, value] of Object.entries(rows[0]!)) await t.test(`changed ${column}`, () => {
          const replacement: Json = value === null ? "unexpected" : typeof value === "number" ? value + 1 : `${value} changed`;
          return assert.rejects(bind(rebuild([{ ...rows[0]!, [column]: replacement }])), changed);
        });
        for (const [name, patch] of [
          ["integer boolean", { protocol_version: true }], ["integer null", { observed_epoch: null }],
          ["integer out of range", { observed_epoch: "9223372036854775808" }],
          ["noncanonical decimal", { registered_epoch: "01" }], ["text type", { build_id: 1 }], ["nonnull text", { client_id: null }],
        ] as const) await t.test(name, () => assert.rejects(bind(rebuild([{ ...rows[0]!, ...patch }])), changed));
        await t.test("unsafe numeric manifest is rejected by canonical encoding before binding", () => assert.throws(() =>
          rebuild([{ ...rows[0]!, registered_epoch: 9007199254740992 }]), /journal_invalid/));
        await t.test("canonical integer representation is equivalent only in integer columns", async () => {
          const equivalent = { ...rows[0]!, protocol_version: typeof rows[0]!.protocol_version === "number" ? "1" : 1,
            registered_epoch: Number(rows[0]!.registered_epoch), observed_epoch: Number(rows[0]!.observed_epoch) };
          await bind(rebuild([equivalent]));
        });
        const table = archived.tables.find(item => item.name === "storage_source_clients")!;
        assert(Array.isArray(table.columns));
        for (const [name, replacement] of [
          ["columns", { ...table, columns: [...table.columns].reverse() }], ["count", { ...table, count: "0" }],
          ["typed digest", { ...table, digest: "f".repeat(64) }],
        ] as const) await t.test(`table ${name}`, () => assert.rejects(bind(rebuild(rows,
          archived.tables.map(item => item === table ? replacement : item))), changed));
        await t.test("missing table", () => assert.rejects(bind(rebuild(rows, archived.tables.filter(item => item !== table))), changed));
        await t.test("duplicate table", () => assert.rejects(bind(rebuild(rows, [...archived.tables, table])), changed));
        await t.test("root invariant remains bound in the archived control row", () => assert.rejects(bind(buildDatabaseManifests(kind, archived.schema,
          archived.tables, { ...archived.controlRows, storage_maintenance: [{ ...archived.controlRows.storage_maintenance[0]!, mutex_identity_json: "{}" }] })), changed));
        const maintenance = archived.tables.find(item => item.name === "storage_maintenance")!;
        assert(Array.isArray(maintenance.columns));
        for (const [name, replacement] of [
          ["columns", { ...maintenance, columns: [...maintenance.columns].reverse() }],
          ["count", { ...maintenance, count: "0" }], ["typed digest", { ...maintenance, digest: "f".repeat(64) }],
        ] as const) await t.test(`maintenance table ${name}`, () => assert.rejects(bind(rebuild(rows,
          archived.tables.map(item => item === maintenance ? replacement : item))), changed));
        await t.test("live maintenance typed table cannot disagree with its native row", () => assert.rejects(bind(archived, lock,
          { ...observed, manifests: buildDatabaseManifests(kind, observed.manifests.schema, observed.manifests.tables.map(item =>
            item.name === "storage_maintenance" ? { ...item, digest: "f".repeat(64) } : item), observed.manifests.controlRows) }), changed));
        const variants: readonly [string, SourceClientsObservation][] = [
          ["source", { ...raw, source: { ...raw.source, databaseInstanceId: "f".repeat(32) } }],
          ["identity", { ...raw, sourceIdentity: { different: true } }],
          ["state", { ...raw, state: { ...raw.state, journalSequence: raw.state.journalSequence + 1 } }],
          ["schema", { ...raw, schemaManifestDigest: "f".repeat(64) }],
          ["encoding", { ...raw, textEncoding: kind === "sqlite" ? { backend: "sqlite", name: "UTF-16le" } : { backend: "postgres", name: "LATIN1" } }],
          ["missing raw row", { ...raw, rows: [] }],
          ["raw bytes", { ...raw, rows: [{ ...raw.rows[0]!, build_id: ["text", "00"] }] }],
        ];
        // These ordinary consistency variants replace returned data only; they do
        // not rewrite source rows, immutable bundles or a native restore target.
        for (const [name, value] of variants) await t.test(`same-lock ${name}`, () => assert.rejects(bind(archived,
          { ...lock, observeSourceClients: async () => value }), changed));
        await t.test("native table and controlRows must also agree with the raw head", () => assert.rejects(bind(archived, lock,
          { ...observed, manifests: buildDatabaseManifests(kind, observed.manifests.schema, observed.manifests.tables.map(item =>
            item.name === "storage_source_clients" ? { ...item, digest: "f".repeat(64) } : item), observed.manifests.controlRows) }), changed));
        await t.test("lost lock before read", async () => {
          let read = false;
          await assert.rejects(bind(archived, { ...lock, assertHeld: async () => { throw new MaintenanceFailure("maintenance_lost"); },
            observeSourceClients: async () => { read = true; return raw; } }), error => error instanceof MaintenanceFailure && error.code === "maintenance_lost");
          assert.equal(read, false);
        });
        await t.test("unresolved encoding has no caller success override", async () => {
          const unresolved = { ...replay, unresolvedEncoding: [raw.textEncoding.name], nativeEncodingVerified: true };
          await assert.rejects(assertVerificationSourceClientBinding(lock, observed, selected, archived, unresolved),
            /source_changed \(v3-source-clients-encoding-unverified\)/);
        });
        assert.deepEqual(await lock.observe(), observed);
      });
    } finally { await f.close(); }
  });

// Pure fail-closed dispatch controls, explicitly not native PostgreSQL evidence.
// The unsupported profile is rejected before a lock/decoder success can be used,
// Empty captures and equal successors both retain the explicit encoding obligation.
for (const encoding of ["LATIN1", "SQL_ASCII"]) for (const nonempty of [false, true]) for (const advance of [false, true]) test(
  `#248 v3 ${encoding}: ${nonempty ? "nonempty" : "empty"} ${advance ? "no-op successor" : "capture"} cannot clear the encoding obligation`, async () => {
    const f = controlVector({ backend: "postgres", encoding });
    const old = historicalClient(f), rows = nonempty ? [old.row] : [], clients = nonempty ? [old.fact] : [];
    const roster = { ...f.roster, rows }, sourceClientsDigest = digestJson(roster);
    const record = { ...f.captured, sourceClients: roster, frozen: { ...f.captured.frozen, sourceClientsDigest },
      controlProof: { ...f.captured.controlProof, facts: { ...f.facts, beforeCount: String(rows.length), beforeRowsDigest: f.rowsDigest(rows), clients } } };
    const captured = { reference: f.pack("journal", record), record: parseVerificationJournal(record) };
    const nodes = [{ reference: f.enterRef, record: parseVerificationJournal(f.enter) }, captured];
    if (advance) {
      const successor = successorVector(f, { origin: captured.reference, previous: captured.reference, sequence: 3, before: rows, after: rows, clients, changes: [] });
      const next = { ...successor, controlProof: { ...successor.controlProof, originSourceClientsDigest: sourceClientsDigest } };
      nodes.push({ reference: f.pack("journal", next), record: parseVerificationJournal(next) });
    }
    const replay = replayVerificationControls(parsePlan(f.plan), nodes, { controlRoot: f.root, mutexIdentity: f.mutex });
    assert.deepEqual(replay.unresolvedEncoding, [encoding]);
    await assert.rejects(assertVerificationSourceClientBinding({} as SourceLock, {} as SourceObservation, captured, {} as DatabaseManifests,
      { ...replay, unresolvedEncoding: [] }), /source_changed \(v3-source-clients-encoding-unverified\)/);
  });

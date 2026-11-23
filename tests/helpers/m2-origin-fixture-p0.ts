import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { runMigrations } from "../../src/server/db/migrate.ts";
import { migrations } from "../../src/server/db/migrations/index.ts";
import { readLegacySqliteManifests } from "./m2-p0-f-fixture.ts";
import { canonicalJson, digestJson } from "../../src/server/storage/maintenance/canonical.ts";
import { readLegacyConfigCapture } from "../../src/server/identity/legacy-config-capture.ts";
import { snapshotRuntimeConfig } from "../../src/server/runtime/config.ts";
import { controlVector, historicalClient, successorVector } from "../fixtures/maintenance-control-candidate.ts";
import { p0ArtifactFixture } from "./m2-p0-f-fixture.ts";
import { eCore, eRuntime } from "./m2-p0-e-fixture.ts";
import type { DbReadSnapshot } from "../../src/server/db/driver.ts";
import type { HistoryObservationInput, RawCell, RawTable } from "../../src/server/identity/m2-history-contracts.ts";
import type { SourceClientRawRow } from "../../src/server/storage/maintenance/types.ts";
import { OriginStore, ORIGIN_TIME, originCell, originRawValue, originSet } from "./m2-origin-fixture-store.ts";
import type { OriginChange } from "./m2-origin-fixture-store.ts";
import { seedOriginAdvancedWorkspace } from "./m2-origin-fixture-advanced.ts";

/** P0 旧源夹具必须停在 v21：v22 属于迁移后的配置权威，不进入旧库观察。 */
const legacyMigrations = migrations.filter(m => m.version <= 21);

const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const exitedProcess = { version: 1, launcherProtocol: "linux-private-net-v1", pid: 456, kernelBootId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", pidNamespace: "pid:[4026531836]", startTicks: "200" };
function seed(db: Database.Database): void {
  const raw = eCore(); eRuntime(raw);
  const config = { model: null, workdir: "/not-contacted", tools: null, systemPrompt: "old prompt\r\n", permissionMode: "auto" as const };
  const requested = snapshotRuntimeConfig("claude-code", { ...config, model: "requested" }, { runtimeRevision: 2, bindingRevision: 2 }, null);
  const applied = snapshotRuntimeConfig("claude-code", { ...config, model: "applied" }, { runtimeRevision: 1, bindingRevision: 1 }, null);
  const order = ["projects", "agents", "groups", "members", "group_participants", "agent_runtimes", "agent_runtime_bindings", "agent_runner_states", "agent_runtime_members"];
  for (const name of order) {
    const table = raw.graph.observation.tables.find(t => t.name === name)!;
    const metadata = db.pragma(`table_xinfo('${name}')`) as { name: string; notnull: number; dflt_value: string | null }[];
    for (const [ordinal, row] of table.rows.entries()) {
      const values = Object.fromEntries(table.columns.map((column, i) => [column, row.cells[i]![0] === "null" ? null
        : row.cells[i]![0] === "integer" ? BigInt(row.cells[i]![1]!) : Buffer.from(row.cells[i]![1]!, "hex").toString("utf8")]));
      if (name === "agent_runtimes") values.defaults_json = JSON.stringify(config);
      if (name === "agent_runtime_bindings") { values.advanced_json = null; values.requested_snapshot_json = JSON.stringify(requested, null, 2) + "\n"; }
      if (name === "agent_runner_states") { values.applied_json = JSON.stringify(applied); values.process_identity_json = JSON.stringify(exitedProcess); }
      const columns = table.columns.filter(column => values[column] !== null || !metadata.find(c => c.name === column)!.notnull);
      db.prepare(`INSERT INTO ${quote(name)} (rowid,${columns.map(quote).join(",")}) VALUES (?,${columns.map(() => "?").join(",")})`)
        .run(17 + ordinal * 12, ...columns.map(column => values[column]));
    }
  }
  db.prepare("INSERT INTO agent_legacy_aliases(display_name,host_type,agent_id,created_at,retired_at) VALUES ('A','claude-code','a',?,NULL)").run(ORIGIN_TIME);
  // Existing member triggers produce all six counters; preserve those native rows.
  assert.equal((db.prepare("SELECT count(*) AS n FROM member_fact_revisions WHERE member_id='m'").get() as { n: number }).n, 6);
  db.prepare("UPDATE schema_migrations SET applied_at=?").run(ORIGIN_TIME);
}
function captureTables(db: Database.Database, template: HistoryObservationInput): RawTable[] {
  return template.tables.map(table => {
    const records = db.prepare(`SELECT rowid,${table.columns.flatMap(name => [`typeof(${quote(name)})`, `CASE WHEN typeof(${quote(name)}) IN ('text','blob') THEN hex(${quote(name)}) ELSE ${quote(name)} END`]).join(",")} FROM ${quote(table.name)} ORDER BY rowid`)
      .raw(true).safeIntegers(true).all() as unknown[][];
    const rows = records.map(record => ({ rowid: String(record[0]), cells: table.columns.map((_, i): RawCell => {
      const kind = record[1 + i * 2], value = record[2 + i * 2];
      if (kind === "null") return ["null"];
      if (kind === "integer") return ["integer", String(value)];
      if (kind === "text" || kind === "blob") return [kind, String(value).toLowerCase()];
      assert.equal(kind, "real"); const bits = Buffer.alloc(8); bits.writeDoubleBE(value as number); return ["real64be", bits.toString("hex")];
    }) }));
    return { ...structuredClone(table), rows, count: String(rows.length) };
  });
}

/** Real native SQLite old rows and original strict value artifacts. Native source/process,
 * Fs/capability and backup verification fields are explicit value fixtures, never qualification. */
export async function m2OriginP0Fixture(change?: OriginChange, options: { pageSize?: 512 | 1024 | 4096; includeHistoricalClient?: boolean; advancedWorkspace?: boolean } = {}) {
  const db = new Database(":memory:"), store = new OriginStore(change);
  try {
    const pageSize = options.pageSize ?? 4096; assert([512, 1024, 4096].includes(pageSize));
    // Select actual SQLite storage geometry before any schema or data is created.
    db.pragma(`page_size=${pageSize}`);
    // Native updates erase freed cell payloads, including migration creation times
    // and the initial random marker. No byte editing or rowid-changing VACUUM.
    db.pragma("secure_delete=ON");
    runMigrations(db, legacyMigrations); seed(db);
    if (options.advancedWorkspace) seedOriginAdvancedWorkspace(db);
    const template = p0ArtifactFixture({ journalVersion: 2 }), initial = readLegacySqliteManifests(db);
    const f = controlVector({ initialVersion: 2, mechanism: {
      sourceIdentity: { kind: "sqlite", sourcePath: "/a12/source-alias.sqlite", sqlitePath: "/a12/source.sqlite", device: "1", inode: "2" },
      databaseInstanceId: "1".repeat(32), root: { path: "/a12/control", device: "1", inode: "3", hostIdentityDigest: "b".repeat(64) },
      mutex: { kind: "fixture-only-mutex" }, schemaManifestDigest: initial.schemaManifestDigest,
      guardManifestDigest: String(initial.controlRows.storage_maintenance[0]!.guard_manifest_digest),
    } });
    const historical = options.includeHistoricalClient ? historicalClient(f, "historical-旧") : null;
    const oldRows: SourceClientRawRow[] = historical ? [historical.row] : [], oldFacts = historical ? [historical.fact] : [];
    if (historical) {
      // Create the original v1 row in the real SQLite database before capture;
      // the native FK binds it to the same maintenance marker as the snapshot.
      db.prepare("UPDATE storage_maintenance SET database_instance_id=?").run(f.source.databaseInstanceId);
      const columns = Object.keys(historical.row) as (keyof SourceClientRawRow)[];
      db.prepare(`INSERT INTO storage_source_clients (rowid,${columns.map(quote).join(",")}) VALUES (?,${columns.map(() => "?").join(",")})`)
        .run(91, ...columns.map(column => originRawValue(historical.row[column] as RawCell)));
    }
    for (const item of template.artifacts.filter(x => x.kind === "pc-column-contract"))
      store.raw("column:" + JSON.parse(Buffer.from(item.bytesHex, "hex").toString("utf8")).table, item.kind, Buffer.from(item.bytesHex, "hex"), item.artifact, [], JSON.parse(Buffer.from(item.bytesHex, "hex").toString("utf8")));
    const plan = store.add("plan", "plan", f.plan, [], "legacy"), files = store.add("files", "source-files", f.files, [], "legacy");
    const enter = store.add("enter", "journal", f.enter, [plan], "legacy");
    const { controlProof: _proof, ...captureBase } = f.captured;
    const roster = { ...captureBase.sourceClients, rows: oldRows };
    const captured = { ...captureBase, formatVersion: 2, sourceClients: roster, frozen: { ...captureBase.frozen,
      frozenBusinessManifestDigest: initial.frozenBusinessManifestDigest, sourceClientsDigest: digestJson(roster) } };
    const captureRef = store.add("capture", "journal", captured, [plan, enter, files], "legacy");
    db.prepare("UPDATE storage_maintenance SET database_instance_id=?,control_root_json=?,mutex_identity_json=?,fence_epoch=2,owner_generation=7,admission='sealed',active_migration_id='a12',plan_digest=?,journal_record_ref=?,journal_digest=?,journal_sequence=2")
      .run(f.source.databaseInstanceId, canonicalJson(f.root), canonicalJson(f.mutex), plan.sha256, captureRef.ref, captureRef.sha256);
    const manifests = readLegacySqliteManifests(db), md = store.add("manifests", "database-manifests", manifests, [], "legacy");
    const database = store.add("database", "database-snapshot", db.serialize(), [], "binary");
    const capability = store.add("capability", "capability", { formatVersion: 1, kind: "capability", node: "fixture", rootIdentity: f.root,
      powerLossTested: false, probeDigest: "a".repeat(64), platform: "linux", filesystemType: "61267", guarantee: "observed-file-fsync-rename-directory-fsync" }, [], "legacy");
    const capture = { migrationId: "a12", source: f.source, planDigest: plan.sha256, fenceEpoch: 2, journal: captureRef, journalSequence: 2, ownerGeneration: 7 };
    const partial = { capture, sourceFilesManifest: files, database, manifests: md, schemaManifestDigest: manifests.schemaManifestDigest, frozenBusinessManifestDigest: manifests.frozenBusinessManifestDigest };
    const restorePointDigest = digestJson(partial);
    const entries = [{ role: "plan", object: plan }, { role: "journal-prefix", object: enter }, { role: "capture-journal", object: captureRef },
      { role: "source-files-manifest", object: files }, { role: "database-snapshot", object: database }, { role: "database-expected-manifests", object: md }, { role: "capability-evidence", object: capability }];
    const bundle = store.add("bundle", "restore-bundle", { formatVersion: 1, kind: "restore-bundle", capture, sourceFilesManifest: files, restorePointDigest, entries }, entries.map(e => e.object), "legacy");
    const publication = store.add("publication", "publication", { formatVersion: 1, kind: "publication", bundle, capability,
      observedOperations: [...entries.map(e => e.object), bundle].map(artifact => ({ artifact, completed: ["file_sync", "rename", "directory_sync"] })) }, [bundle, capability, ...entries.map(e => e.object)], "legacy");
    const verification = store.add("verification", "verification", { formatVersion: 1, kind: "verification", bundle, publication,
      verificationTargetIdentity: { kind: "value-fixture-no-restore-performed" }, exactFullDataAndControlMatched: true, sourceFilePayloadsMatched: true, schemaAndScopeMatched: true }, [bundle, publication], "legacy");
    const receipt = store.add("receipt", "receipt", { formatVersion: 1, kind: "receipt", snapshotId: "origin-fixture", ...partial, restorePointDigest,
      bundle, publication, verification, capability, fullDataManifestDigest: manifests.fullDataManifestDigest, capturedControlManifestDigest: manifests.capturedControlManifestDigest },
      [captureRef, plan, files, database, md, bundle, publication, verification, capability], "legacy");
    const physicalPayload = { contract: "m2-physical-source-observation/r1", source: f.source, sourceIdentity: f.sourceIdentity, observedAt: ORIGIN_TIME, controlRoot: f.root, sourcePlan: plan };
    const physical = store.add("physical", "m2-physical-source", physicalPayload, [plan]);
    const tables = captureTables(db, template.graph.observation);
    const catalogPayload = JSON.parse(Buffer.from(template.artifacts.find(x => x.kind === "pc-catalog")!.bytesHex, "hex").toString("utf8"));
    const catalog = store.add("catalog:p0", "pc-catalog", catalogPayload, tables.map(t => t.columnContract), "raw");
    const before: HistoryObservationInput = { ...structuredClone(template.graph.observation), source: f.source, tables, catalog,
      physicalSourceRef: { artifactId: physical.ref, digest: digestJson(physicalPayload) }, snapshotReceiptRef: { artifactId: receipt.ref, digest: receipt.sha256 } };
    const oldInput = { contract: "m2-history-closure-input/r2", graph: { kind: "m2-observation", observation: before, origin: null },
      artifacts: store.reachable([catalog, physical, receipt]), evidence: [{ kind: "m2-physical-source", artifact: physical, evidence: before.physicalSourceRef },
        { kind: "receipt", artifact: receipt, evidence: before.snapshotReceiptRef }], proposedDeletion: null };
    const legacyCapture = await readLegacyConfigCapture({ query: async (sql: string) => db.prepare(sql).all() } as DbReadSnapshot);
    const readyBody = { ...captured, event: "ready", phase: "snapshot_ready", sequence: 3, previous: captureRef, requestId: "ready",
      frozen: null, sourceClients: null, snapshot: receipt };
    const ready = store.add("ready", "journal", readyBody, [captureRef, plan, receipt], "legacy");
    const bridgeBase = successorVector(f, { origin: captureRef, previous: ready, sequence: 4, before: oldRows, after: oldRows, clients: oldFacts,
      observedAt: ORIGIN_TIME, changes: [] });
    const runtimeFacts = { runners: [{ bindingId: "b", memberId: "m", generation: 4, leaseOwner: null, exitConfirmed: 1, processIdentity: exitedProcess,
      inspection: { status: "wrapper_exited", reason: "process_absent", inspectedAt: ORIGIN_TIME } }],
      owners: [{ memberId: "m", bindingId: null, generation: 4, leaseOwner: null, leaseExpiresAt: null }], results: [{ bindingId: "b", memberId: "m", generation: 4, status: "exited" }] };
    const bridgeBody = { ...bridgeBase, phase: "snapshot_ready", controlProof: { ...bridgeBase.controlProof, kind: "legacy-first-capture-bridge",
      originSourceClientsDigest: captured.frozen.sourceClientsDigest,
      facts: { ...bridgeBase.controlProof.facts, runtime: runtimeFacts }, legacy: { ready, receipt, manifests: md } } };
    const bridge = store.add("bridge", "journal", bridgeBody, [ready, plan, captureRef, receipt, md], "legacy");
    const registration = { formatVersion: 1, kind: "maintenance-controller-registration", source: f.source, sourceIdentityDigest: f.source.identityDigest,
      creation: { migrationId: "a12", plan, fenceEpoch: "2", ownerGeneration: "7", previousAnchor: bridge, targetSequence: "5" },
      sessionBinding: "per-source-lock-native-inventory-v1", drainReceipt: null };
    const coordinator: SourceClientRawRow = { client_id: f.text("origin-coordinator"), database_instance_id: f.text(f.source.databaseInstanceId),
      entrypoint: f.text("maintenance-controller"), build_id: f.text("boardroom-maintenance-control-v1"), protocol_version: ["integer", "1"],
      host_identity_json: f.text(canonicalJson(f.facts.actor.host)), process_identity_json: f.text(canonicalJson(f.facts.actor.process)), db_sessions_json: f.text(canonicalJson(registration)),
      registered_epoch: ["integer", "2"], observed_epoch: ["integer", "2"], drain_epoch: ["null"], drain_state: f.text("none"), drain_receipt_digest: ["null"],
      registered_at: f.text(ORIGIN_TIME), last_observed_at: f.text(ORIGIN_TIME), ended_at: ["null"] };
    const registeredBase = successorVector(f, { origin: captureRef, previous: bridge, sequence: 5, before: oldRows, after: [...oldRows, coordinator], clients: oldFacts,
      observedAt: ORIGIN_TIME, changes: [{ kind: "maintenance-registration", before: null, after: coordinator, actorId: f.facts.actor.actorId }] });
    const registered = { ...registeredBase, phase: "snapshot_ready", controlProof: { ...registeredBase.controlProof,
      originSourceClientsDigest: captured.frozen.sourceClientsDigest,
      facts: { ...registeredBase.controlProof.facts, runtime: runtimeFacts } } };
    const preARef = store.add("preA", "journal", registered, [bridge, plan, captureRef], "legacy");
    const preA = structuredClone(before), control = preA.tables.find(t => t.name === "storage_maintenance")!, clients = preA.tables.find(t => t.name === "storage_source_clients")!;
    originSet(control, "journal_record_ref", preARef.ref); originSet(control, "journal_digest", preARef.sha256); originSet(control, "journal_sequence", 5);
    clients.rows.push({ rowid: "23", cells: clients.columns.map(column => structuredClone(coordinator[column as keyof SourceClientRawRow])) as RawCell[] });
    clients.count = String(clients.rows.length);
    return { store, oldInput, before, captureObservation: before, preA, legacyCapture, selected: store.all(), refs: { ...store.refs, plan, files, enter, capture: captureRef, receipt, physical, ready, preA: preARef },
      controlRoot: f.root, mutex: f.mutex, controlVector: f, coordinator, historical, runtimeFacts, manifests };
  } finally { db.close(); }
}

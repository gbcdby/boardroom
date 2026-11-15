import { canonicalJson, digestJson, sha256 } from "../../src/server/storage/maintenance/canonical.ts";
import type { ArtifactRef, ControlRootIdentity, Json, ObjectKind, SourceClientRawRow, SourceClientsRosterV1 } from "../../src/server/storage/maintenance/types.ts";
import { buildDatabaseManifests, digestRowMultiset } from "../../src/server/storage/maintenance/manifests.ts";

/** Pure synthetic content vectors only. These bytes are never native/restore/qualification evidence. */
export function controlVector(options: { backend?: "sqlite" | "postgres"; platform?: "linux" | "darwin"; encoding?: string; initialVersion?: 1 | 2 | 3;
  mechanism?: { sourceIdentity: Json; databaseInstanceId: string; root: ControlRootIdentity; mutex: Json; schemaManifestDigest: string; guardManifestDigest: string } } = {}) {
  const backend = options.backend ?? "sqlite", platform = options.platform ?? "linux";
  const hash = (character: string) => character.repeat(64);
  const sourceIdentity = options.mechanism?.sourceIdentity ?? (backend === "sqlite"
    ? { kind: "sqlite", sourcePath: "/a12/source.sqlite", sqlitePath: "/a12/source.sqlite", device: "1", inode: "2" }
    : { formatVersion: 1, kind: "postgres", systemIdentifier: "1000", databaseOid: "100", databaseName: "fixture", schemaOid: "101", schemaName: "public", serverAddress: null, serverPort: null, descriptorDigest: hash("a"), databaseInstanceId: "1".repeat(32) });
  const source = { kind: backend, databaseInstanceId: options.mechanism?.databaseInstanceId ?? "1".repeat(32), identityDigest: digestJson(sourceIdentity) };
  const root = options.mechanism?.root ?? { path: "/a12/control", device: "1", inode: "3", hostIdentityDigest: hash("b") };
  const mutex = options.mechanism?.mutex ?? { kind: "fixture-only-mutex", sourceIdentityDigest: source.identityDigest };
  const planned = (path: string) => ({ path, existingAncestor: { path: "/a12", device: "1", inode: "1" }, absentSegments: [path.split("/").at(-1)!] });
  const roots = [{ label: "config", path: "/a12/config", expected: planned("/a12/config") }, { label: "managed-sessions", path: "/a12/managed/sessions", expected: { ...planned("/a12/managed/sessions"), absentSegments: ["managed", "sessions"] } }];
  const objects: { reference: ArtifactRef; bytes: Buffer }[] = [];
  const pack = (kind: ObjectKind, value: unknown): ArtifactRef => {
    const bytes = kind === "database-snapshot" || kind === "source-file-payload" ? Buffer.from(value as Uint8Array) : Buffer.from(canonicalJson(value));
    const digest = sha256(bytes), record = value as { migrationId: string; sequence: number };
    const name = kind === "plan" ? `plans/${digest}.json` : kind === "journal" ? `journals/${record.migrationId}/${record.sequence}-${digest}.json`
      : `snapshots/${digest}/${kind}.${kind === "database-snapshot" || kind === "source-file-payload" ? "bin" : "json"}`;
    const reference = { ref: name, sha256: digest, bytes: String(bytes.length) };
    if (!objects.some(item => item.reference.ref === reference.ref)) objects.push({ reference, bytes });
    return reference;
  };
  const plan = { formatVersion: 1, kind: "plan", migrationId: "a12", source, sourceIdentity, originalCwd: "/a12", originalConfigPath: "/a12/config",
    configDigest: hash("c"), effectiveConfigDigest: hash("d"), schemaManifestDigest: options.mechanism?.schemaManifestDigest ?? digestJson({ fixture: "schema" }), guardManifestDigest: options.mechanism?.guardManifestDigest ?? hash("e"),
    controlRoot: options.mechanism ? { path: root.path, existingAncestor: { path: root.path, device: root.device, inode: root.inode }, absentSegments: [] } : planned(root.path), targetRoot: planned("/a12/target"), fileRoots: roots,
    preview: { observedAt: "2026-11-15T00:00:00.000Z", dataDigest: hash("f"), tableCounts: {}, clientInventory: [] }, requiredCapabilities: [], blockers: [] };
  const planRef = pack("plan", plan);
  const files = { formatVersion: 2, kind: "source-files", source, roots,
    rootBindings: roots.map(item => ({ sourceRoot: item.label, profile: "linux-native-ext4-fid-fsuuid-v1", filesystemType: "ext4", filesystemUuidHex: "1".repeat(32), hostIdentityDigest: root.hostIdentityDigest, anchorPath: "/a12", anchorKind: "directory", anchorHandle: { type: 1, byteCount: 8, hex: "0123456789abcdef" } })),
    entries: roots.map(item => ({ sourceRoot: item.label, sourceRelativePath: "", kind: "absent", identity: null, mode: null, size: null, payload: null, sourceWitness: null })),
    sourceMembershipExclusions: ["database-files", "entire-maintenance-control-root", "all-maintenance-artifacts"] };
  const filesRef = pack("source-files", files);
  const encoding = { backend, name: options.encoding ?? (backend === "sqlite" ? "UTF-8" : "UTF8") } as SourceClientsRosterV1["textEncoding"];
  const text = (value: string) => {
    const bytes = Buffer.from(value, encoding.name === "UTF-16le" || encoding.name === "UTF-16be" ? "utf16le" : "utf8");
    if (encoding.name === "UTF-16be") bytes.swap16();
    return ["text", bytes.toString("hex")] as const;
  };
  const rowsDigest = (rows: readonly SourceClientRawRow[]) => digestJson({ formatVersion: 1, kind: "source-clients-live-rows", source, textEncoding: encoding, rows: [...rows].sort((a, b) => a.client_id[1].localeCompare(b.client_id[1], "en")) });
  const rowDigest = (row: SourceClientRawRow) => digestJson({ formatVersion: 1, kind: "source-client-row", source, textEncoding: encoding, row });
  const host = { version: 1, hostname: "fixture", platform };
  const actorId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const process = platform === "linux"
    ? { version: 1, platform, pid: 123, instanceId: actorId, verification: "linux_proc_identity_v1", kernelBootId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", pidNamespace: "pid:[4026531836]", startTicks: "100" }
    : { version: 1, platform, pid: 123, instanceId: actorId, verification: "darwin_proc_identity_v1", uid: 1000, bootSessionUuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", startSeconds: "10", startMicroseconds: "20" };
  const processCheck = platform === "linux"
    ? { kind: "linux-matched", observerUid: 1000, kernelBootId: process.kernelBootId, pidNamespace: process.pidNamespace, pid: process.pid, uidBefore: 1000, uidAfter: 1000, startTicksBefore: "100", startTicksAfter: "100" }
    : { kind: "darwin-present", result: { version: 1, pid: 123, bootSessionUuid: process.bootSessionUuid, status: "present", uid: 1000, startSeconds: "10", startMicroseconds: "20" } };
  const nativeSource = sourceIdentity as Record<string, Json>;
  const sqlPath = backend === "sqlite" ? String(nativeSource.sqlitePath) : "/a12/source.sqlite";
  const device = backend === "sqlite" ? String(nativeSource.device) : "1", inode = backend === "sqlite" ? String(nativeSource.inode) : "2", dev = BigInt(device);
  const sourceFiles = [{ role: "main", path: sqlPath, presence: "present", device, inode, ...(platform === "linux" ? {
    mappedMajor: String((dev >> 8n & 0xfffn) | (dev >> 32n & 0xfffff000n)), mappedMinor: String((dev & 0xffn) | (dev >> 12n & 0xffffff00n)), mappedInode: inode } : {}) },
    { role: "wal", path: `${sqlPath}-wal`, presence: "absent" }, { role: "shm", path: `${sqlPath}-shm`, presence: "absent" }];
  const sessions = backend === "postgres"
    ? { kind: "postgres-session-audit-v1", databaseOid: String(nativeSource.databaseOid), schemaOid: String(nativeSource.schemaOid), descriptorDigest: String(nativeSource.descriptorDigest), ownedSessions: [], activity: [], registeredSessions: [], preparedQueryRows: 0 }
    : { kind: platform === "linux" ? "sqlite-linux-session-audit-v1" : "sqlite-darwin-session-audit-v1", observer: { host, process }, uid: 1000, sourceFiles, sessionsTree: "/a12/managed/sessions", ownedResources: [], ...(platform === "linux" ? { matches: [] } : { inventory: { version: 1, scope: "current-uid", items: [] } }) };
  const facts = { formatVersion: 1, kind: "source-control-event-facts", collector: "boardroom-source-control-facts-v1", observedAt: "2026-11-15T00:00:00.000Z",
    actor: { actorId, clientId: null, host, process, processCheck }, beforeCount: "0", beforeRowsDigest: rowsDigest([]), clients: [],
    runtime: { runners: [], owners: [], results: [] }, sessions };
  const invariant = { singleton: "1", databaseInstanceId: source.databaseInstanceId, controlRootJson: canonicalJson(root), mutexIdentityJson: canonicalJson(mutex), fenceEpoch: "2", admission: "sealed", activeMigrationId: "a12", planDigest: planRef.sha256, protocolVersion: "1", guardManifestDigest: plan.guardManifestDigest };
  const enter = { formatVersion: options.initialVersion ?? 3, kind: "journal", migrationId: "a12", sequence: 1, previous: null, phase: "planned", event: "enter", requestId: "enter", requestDigest: hash("1"), source, plan: planRef, fenceEpoch: 2, ownerGeneration: 7, evidence: [], frozen: null, snapshot: null,
    ...(options.initialVersion === 1 ? {} : { sourceClients: null }), ...(options.initialVersion === 1 || options.initialVersion === 2 ? {} : { controlProof: null }) };
  const enterRef = pack("journal", enter);
  const roster = { formatVersion: 1, kind: "source-clients-roster", source, migrationId: "a12", plan: planRef, fenceEpoch: "2", receiptGeneration: "7", textEncoding: encoding, rows: [] };
  const captured = { ...enter, formatVersion: 3, sequence: 2, previous: enterRef, phase: "quiesced", event: "capture", requestId: "capture", sourceClients: roster,
    frozen: { sourceFilesManifest: filesRef, schemaManifestDigest: plan.schemaManifestDigest, frozenBusinessManifestDigest: hash("6"), guardManifestDigest: plan.guardManifestDigest, sourceClientsDigest: digestJson(roster) },
    controlProof: { formatVersion: 1, kind: "capture-controls", maintenanceInvariant: invariant, facts } };
  return { source, sourceIdentity, root, mutex, plan, planRef, files, filesRef, objects, pack, text, rowsDigest, rowDigest, encoding, facts, invariant, enter, enterRef, roster, captured };
}

export function historicalClient(f: ReturnType<typeof controlVector>, name = "old-client") {
  const process = { ...f.facts.actor.process, pid: 124, instanceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
  const sessions = f.source.kind === "sqlite" ? [{ kind: "sqlite", owner: "local-driver" }, { kind: "sqlite", owner: "client-control" }]
    : [{ kind: "postgres", owner: "local-driver", applicationName: `boardroom-source:${name}`, observedBackends: [{ pid: 200, backend_start: "2026-11-01 00:00:00.123456+00", application_name: `boardroom-source:${name}` }] },
      { kind: "postgres", owner: "client-control", observedBackends: [{ pid: 201, backend_start: "2026-11-01 00:00:00.123457+00", application_name: `boardroom-control:${name}` }] }];
  const sourceIdentity = f.source.kind === "sqlite" ? f.sourceIdentity : { kind: "postgres", database_oid: "100", schema_oid: "101", database_name: "fixture", schema_name: "public", configurationDigest: "7".repeat(64) };
  const row: SourceClientRawRow = { client_id: f.text(name), database_instance_id: f.text(f.source.databaseInstanceId), entrypoint: f.text("stdio"), build_id: f.text("boardroom-storage-drain-v1"),
    host_identity_json: f.text(` ${JSON.stringify(f.facts.actor.host)}\n`), process_identity_json: f.text(` ${JSON.stringify(process)} `),
    db_sessions_json: f.text(` {"formatVersion":1,"sourceIdentity":${JSON.stringify(sourceIdentity)},"sessions":${JSON.stringify(sessions)},"drainReceipt":null} `),
    registered_at: f.text("2026-11-01T00:00:00.000Z"), last_observed_at: f.text("2026-11-01T01:00:00.000Z"), drain_state: f.text("none"),
    drain_receipt_digest: ["null"], ended_at: f.text("2026-11-01T01:00:00.000Z"), protocol_version: ["integer", "1"], registered_epoch: ["integer", "0"], observed_epoch: ["integer", "0"], drain_epoch: ["null"] };
  const processCheck = process.platform === "linux" ? { kind: "linux-absent", observerUid: 1000, kernelBootId: process.kernelBootId, pidNamespace: process.pidNamespace, pid: 124, stage: "proc-open", errno: "ENOENT" }
    : { kind: "darwin-absent", result: { version: 1, pid: 124, bootSessionUuid: process.bootSessionUuid, status: "absent" } };
  const fact = { kind: "ordinary-client", subject: row.client_id, rowDigest: f.rowDigest(row), host: f.facts.actor.host, process, processCheck, classification: "historical-client", receipt: null };
  return { row, fact };
}

export function currentClient(f: ReturnType<typeof controlVector>, native = false) {
  const old = historicalClient(f, "current-client"), originalEnvelope = JSON.parse(Buffer.from(old.row.db_sessions_json[1], "hex").toString("utf8"));
  const nativeTransactions = { committed: 1, rolledBack: 2, notAdmitted: 3 };
  if (native) originalEnvelope.sessions = [{ kind: "sqlite", owner: "native-management", connectionId: "native-connection", state: "closed", nativeTransactions }];
  const processIdentity = { version: 1, launcherProtocol: "linux-private-net-v1", pid: 456, kernelBootId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", pidNamespace: "pid:[4026531836]", startTicks: "200" };
  const fence = { bindingId: "binding", memberId: "member", generation: 3, owner: "lease" };
  const inspection = { status: "wrapper_exited", reason: "process_absent", inspectedAt: "2026-11-15T00:00:00.000Z" };
  const receipt = { formatVersion: 1, kind: "source-client-drain", clientId: "current-client", entrypoint: native ? "local-management" : "stdio", buildId: native ? "boardroom-native-management-v1" : "boardroom-storage-drain-v1",
    databaseInstanceId: f.source.databaseInstanceId, sourceIdentityDigest: digestJson(originalEnvelope.sourceIdentity), processIdentityDigest: digestJson(old.fact.process), registeredEpoch: 1, drainEpoch: 2, ownerGeneration: 7,
    migrationId: "a12", planDigest: f.planRef.sha256, quiescence: { activeTransactions: 0, activeJobs: 0, openFileWriters: 0, businessConnectionsClosed: true },
    ownedExits: native ? [] : [{ fence, processIdentity, observation: "owned_handle_exited", exitCode: 0, signal: null, observedAt: "2026-11-15T00:00:00.000Z" }], completedAt: "2026-11-15T00:00:00.000Z", ...(native ? { nativeTransactions } : {}) };
  const row: SourceClientRawRow = { ...old.row, entrypoint: f.text(receipt.entrypoint), build_id: f.text(receipt.buildId), db_sessions_json: f.text(canonicalJson({ ...originalEnvelope, drainReceipt: receipt })),
    registered_epoch: ["integer", "1"], observed_epoch: ["integer", "2"], drain_epoch: ["integer", "2"], drain_state: f.text("drained"), drain_receipt_digest: f.text(digestJson(receipt)), ended_at: ["null"] };
  const processCheck = { ...f.facts.actor.processCheck, pid: 124 };
  const fact = { ...old.fact, kind: native ? "native-management-client" : "ordinary-client", rowDigest: f.rowDigest(row), classification: "current-client", processCheck,
    receipt: { digest: digestJson(receipt), kind: "current", ownedExits: native ? [] : [{ fence, processIdentity, inspection }] } };
  const runtime = native ? { runners: [], owners: [], results: [] } : { runners: [{ bindingId: "binding", memberId: "member", generation: 3, leaseOwner: "lease", exitConfirmed: 0, processIdentity, inspection }],
    owners: [{ memberId: "member", bindingId: "binding", generation: 3, leaseOwner: "lease", leaseExpiresAt: "2026-11-15T00:01:00.000Z" }], results: [{ bindingId: "binding", memberId: "member", generation: 3, status: "exited" }] };
  return { row, fact, runtime, receipt };
}

export function successorVector(f: ReturnType<typeof controlVector>, input: { origin: ArtifactRef; previous: ArtifactRef; sequence: number;
  before: readonly SourceClientRawRow[]; after: readonly SourceClientRawRow[]; clients: readonly unknown[]; changes: readonly unknown[];
  observedAt?: string; actor?: unknown; event?: "observation" | "takeover"; fromGeneration?: number; toGeneration?: number }) {
  return { ...f.enter, formatVersion: 3, event: input.event ?? "observation", phase: "quiesced", sequence: input.sequence, previous: input.previous,
    requestId: `step-${input.sequence}`, ownerGeneration: input.toGeneration ?? 7, sourceClients: null,
    controlProof: { formatVersion: 1, kind: "control-successor", originCapture: input.origin, originSourceClientsDigest: f.captured.frozen.sourceClientsDigest,
      source: f.source, plan: f.planRef, migrationId: "a12", fenceEpoch: "2", receiptGeneration: "7", textEncoding: f.encoding,
      previousAnchor: input.previous, fromGeneration: String(input.fromGeneration ?? 7), toGeneration: String(input.toGeneration ?? 7), targetSequence: String(input.sequence),
      beforeRowsDigest: f.rowsDigest(input.before), afterRowsDigest: f.rowsDigest(input.after), changes: input.changes,
      facts: { ...f.facts, actor: input.actor ?? f.facts.actor, observedAt: input.observedAt ?? "2026-11-15T00:01:00.000Z", beforeCount: String(input.before.length), beforeRowsDigest: f.rowsDigest(input.before), clients: input.clients } } };
}

export function legacyVector(options: { recapture?: boolean; manifest?: (value: any) => void; omitRole?: string; omitPublishedBundle?: boolean } = {}) {
  const f = controlVector({ initialVersion: 2 }), schema = { fixture: "schema" };
  const { controlProof: _proof, ...body } = f.captured;
  const captured = { ...body, formatVersion: 2, frozen: { ...body.frozen, frozenBusinessManifestDigest: digestJson({ dialect: "sqlite", schemaManifestDigest: f.plan.schemaManifestDigest, tables: [] }) } };
  const first = f.pack("journal", captured);
  const selectedRecord = options.recapture ? { ...captured, sequence: 3, previous: first, requestId: "recapture" } : captured;
  const selected = options.recapture ? f.pack("journal", selectedRecord) : first;
  const capture = { migrationId: "a12", source: f.source, planDigest: f.planRef.sha256, fenceEpoch: 2, journal: selected, journalSequence: selectedRecord.sequence, ownerGeneration: 7 };
  const control = { singleton: 1, database_instance_id: f.source.databaseInstanceId, control_root_json: canonicalJson(f.root), mutex_identity_json: canonicalJson(f.mutex), fence_epoch: 2, admission: "sealed",
    active_migration_id: "a12", plan_digest: f.planRef.sha256, protocol_version: 1, guard_manifest_digest: f.plan.guardManifestDigest,
    owner_generation: 7, journal_record_ref: selected.ref, journal_digest: selected.sha256, journal_sequence: selectedRecord.sequence };
  const table = (name: string, rows: readonly unknown[]) => ({ name, columns: ["fixture"], ...digestRowMultiset(rows as never) });
  const manifests = buildDatabaseManifests("sqlite", schema, [table("storage_maintenance", [control]), table("storage_source_clients", [])], { storage_maintenance: [control], storage_source_clients: [] });
  options.manifest?.(manifests);
  // Recompute only manifest self-digests for the negative vector; origin/capture/domain expectations stay fixed.
  const writtenManifests = buildDatabaseManifests(manifests.dialect, manifests.schema, manifests.tables, manifests.controlRows);
  const manifestsRef = f.pack("database-manifests", writtenManifests), database = f.pack("database-snapshot", Buffer.from("synthetic bytes, no database restore has occurred"));
  const capability = f.pack("capability", { formatVersion: 1, kind: "capability", node: "fixture", rootIdentity: f.root, powerLossTested: false, probeDigest: "1".repeat(64), platform: "linux", filesystemType: "61267", guarantee: "observed-file-fsync-rename-directory-fsync" });
  const partial = { capture, sourceFilesManifest: f.filesRef, database, manifests: manifestsRef, schemaManifestDigest: f.plan.schemaManifestDigest, frozenBusinessManifestDigest: captured.frozen.frozenBusinessManifestDigest };
  const restorePointDigest = digestJson(partial);
  const entries = [{ role: "plan", object: f.planRef }, { role: "journal-prefix", object: f.enterRef },
    ...(options.recapture ? [{ role: "journal-prefix", object: first }] : []), { role: "capture-journal", object: selected },
    { role: "source-files-manifest", object: f.filesRef }, { role: "database-snapshot", object: database },
    { role: "database-expected-manifests", object: manifestsRef }, { role: "capability-evidence", object: capability }];
  const bundle = f.pack("restore-bundle", { formatVersion: 1, kind: "restore-bundle", capture, sourceFilesManifest: f.filesRef, restorePointDigest, entries: entries.filter(entry => entry.role !== options.omitRole) });
  const publication = f.pack("publication", { formatVersion: 1, kind: "publication", bundle, capability,
    observedOperations: [...entries.map(entry => entry.object), ...(options.omitPublishedBundle ? [] : [bundle])].map(artifact => ({ artifact, completed: ["file_sync", "rename", "directory_sync"] })) });
  const verification = f.pack("verification", { formatVersion: 1, kind: "verification", bundle, publication, verificationTargetIdentity: { kind: "synthetic-only" }, exactFullDataAndControlMatched: true, sourceFilePayloadsMatched: true, schemaAndScopeMatched: true });
  const receiptRef = f.pack("receipt", { formatVersion: 1, kind: "receipt", snapshotId: "legacy", ...partial, restorePointDigest, bundle, publication, verification, capability,
    fullDataManifestDigest: writtenManifests.fullDataManifestDigest, capturedControlManifestDigest: writtenManifests.capturedControlManifestDigest });
  const ready = { ...f.enter, formatVersion: 2, sequence: selectedRecord.sequence + 1, previous: selected, phase: "snapshot_ready", event: "ready", requestId: "ready", snapshot: receiptRef };
  const readyRef = f.pack("journal", ready);
  const normal = successorVector(f, { origin: first, previous: readyRef, sequence: ready.sequence + 1, before: [], after: [], clients: [], changes: [] });
  const bridge = { ...normal, phase: "snapshot_ready", controlProof: { ...normal.controlProof, kind: "legacy-first-capture-bridge", legacy: { ready: readyRef, receipt: receiptRef, manifests: manifestsRef } } };
  const bridgeRef = f.pack("journal", bridge);
  return { f, first, selected, captured, selectedRecord, ready, readyRef, receiptRef, manifestsRef, writtenManifests, bridge, bridgeRef };
}

export function readyFromCapture(f: ReturnType<typeof controlVector>, prefix: readonly { reference: ArtifactRef; record: any }[], rows: readonly SourceClientRawRow[], facts: any,
  options: { omitClient?: boolean } = {}) {
  const selected = prefix.at(-1)!, first = prefix.find(node => node.record.event === "capture")!;
  const capture = { migrationId: "a12", source: f.source, planDigest: f.planRef.sha256, fenceEpoch: 2, journal: selected.reference, journalSequence: selected.record.sequence, ownerGeneration: selected.record.ownerGeneration };
  const control = { singleton: 1, database_instance_id: f.source.databaseInstanceId, control_root_json: canonicalJson(f.root), mutex_identity_json: canonicalJson(f.mutex), fence_epoch: 2,
    admission: "sealed", active_migration_id: "a12", plan_digest: f.planRef.sha256, protocol_version: 1, guard_manifest_digest: f.plan.guardManifestDigest,
    owner_generation: capture.ownerGeneration, journal_record_ref: selected.reference.ref, journal_digest: selected.reference.sha256, journal_sequence: capture.journalSequence };
  const plainRows = options.omitClient ? [] : rows.map(row => Object.fromEntries(Object.entries(row).map(([name, cell]) => [name, cell[0] === "null" ? null : cell[0] === "integer" ? Number(cell[1]) : Buffer.from(cell[1], "hex").toString("utf8")])));
  const table = (name: string, values: readonly unknown[]) => ({ name, columns: ["fixture"], ...digestRowMultiset(values as never) });
  const manifests = buildDatabaseManifests("sqlite", { fixture: "schema" }, [table("storage_maintenance", [control]), table("storage_source_clients", plainRows)],
    { storage_maintenance: [control], storage_source_clients: plainRows });
  const manifestsRef = f.pack("database-manifests", manifests), database = f.pack("database-snapshot", Buffer.from("private v3 structure only; not an actual restore"));
  const capability = f.pack("capability", { formatVersion: 1, kind: "capability", node: "fixture", rootIdentity: f.root, powerLossTested: false, probeDigest: "2".repeat(64), platform: "linux", filesystemType: "61267", guarantee: "observed-file-fsync-rename-directory-fsync" });
  const partial = { capture, sourceFilesManifest: f.filesRef, database, manifests: manifestsRef, schemaManifestDigest: f.plan.schemaManifestDigest, frozenBusinessManifestDigest: selected.record.frozen.frozenBusinessManifestDigest };
  const point = digestJson(partial), entries = [{ role: "plan", object: f.planRef }, ...prefix.map(node => ({ role: node === selected ? "capture-journal" : "journal-prefix", object: node.reference })),
    { role: "source-files-manifest", object: f.filesRef }, { role: "database-snapshot", object: database }, { role: "database-expected-manifests", object: manifestsRef }, { role: "capability-evidence", object: capability }];
  const bundle = f.pack("restore-bundle", { formatVersion: 1, kind: "restore-bundle", capture, sourceFilesManifest: f.filesRef, restorePointDigest: point, entries });
  const publication = f.pack("publication", { formatVersion: 1, kind: "publication", bundle, capability, observedOperations: [...entries.map(entry => entry.object), bundle].map(artifact => ({ artifact, completed: ["file_sync", "rename", "directory_sync"] })) });
  const verification = f.pack("verification", { formatVersion: 1, kind: "verification", bundle, publication, verificationTargetIdentity: { kind: "synthetic-v3-only" }, exactFullDataAndControlMatched: true, sourceFilePayloadsMatched: true, schemaAndScopeMatched: true });
  const receipt = f.pack("receipt", { formatVersion: 1, kind: "receipt", snapshotId: "private-v3", ...partial, restorePointDigest: point, bundle, publication, verification, capability,
    fullDataManifestDigest: manifests.fullDataManifestDigest, capturedControlManifestDigest: manifests.capturedControlManifestDigest });
  const normal = successorVector(f, { origin: first.reference, previous: selected.reference, sequence: selected.record.sequence + 1, before: rows, after: rows, clients: facts.clients, actor: facts.actor, changes: [], fromGeneration: capture.ownerGeneration, toGeneration: capture.ownerGeneration });
  const ready = { ...normal, event: "ready", phase: "snapshot_ready", snapshot: receipt, controlProof: { ...normal.controlProof, facts: { ...facts, beforeRowsDigest: f.rowsDigest(rows), beforeCount: String(rows.length) } } };
  return { ready, head: f.pack("journal", ready) };
}

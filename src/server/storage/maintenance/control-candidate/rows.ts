import { z } from "zod";
import { canonicalJson, digestJson } from "../canonical.ts";
import { MaintenanceFailure } from "../error.ts";
import { digestRowMultiset } from "../manifests.ts";
import { encodePostgresCell } from "../postgres-manifests.ts";
import { sameSourceClientRow } from "../source-client-equality.ts";
import { sourceClientColumns } from "../source-clients-read.ts";
import { sourceClientRawRowSchema } from "../source-clients.ts";
import { counter, hash, id, ref, source } from "../parse-primitives.ts";
import type { DatabaseManifests, JournalRecord, Json, MigrationPlan, SourceClientRawRow, SourceClientTextCell, SourceClientsRosterV1, SourceRef } from "../types.ts";
import type { UntrustedJournalCandidate } from "./codec.ts";
import { compareText, equal, ordered, requireCandidate } from "./common.ts";
import { fence, ownedIdentity, safePos, processDisposition, type ClientFact, type EventFacts, type SuccessorProof } from "./schema.ts";
import { assertP0FSyntaxScope, assertP0FRow, assertP0FRowJson,bindP0FRowJsonEncoding, preflightP0FRowText, reserveP0FNativeClone, reserveP0FNativeNodes, reserveP0FNativeShallow,encodeP0FNativeShell,reserveP0FNativeMetadata,reserveP0FNativeWork,reserveP0FNativeKeyList,reserveP0FNativeSetBinding,reserveP0FNativeMapBinding, type P0FArtifactSyntaxFrame } from '../../../identity/internal/m2-p0-artifacts-frame.ts';

const sqliteEncodings=Object.freeze(["UTF-8", "UTF-16le", "UTF-16be"]);
const ordinaryEntrypoints=Object.freeze(["http", "stdio", "owned-background"]);
const changedObservationColumns=Object.freeze(["last_observed_at", "ended_at"]);

type Encoding = SourceClientsRosterV1["textEncoding"];
type Decoded = { -readonly [K in keyof SourceClientRawRow]: string | null };
type Registration = { readonly creation: z.infer<typeof creation>; readonly actorId: string };
export interface RowContext {
  readonly plan: MigrationPlan;
  readonly record: JournalRecord | UntrustedJournalCandidate;
  /** Row/receipt history stays at the origin epoch, including the terminal E+1 record. */
  readonly fenceEpoch: number;
  readonly encoding: Encoding;
  readonly receiptGeneration: string;
  readonly registrations: Map<string, Registration>;
  readonly unresolvedEncoding: Set<string>;
  readonly syntaxFrame?: P0FArtifactSyntaxFrame;
}
const text = z.string().min(1).max(4096).refine(value => !value.includes("\0"));
const oldTime = text.refine(value => Number.isFinite(Date.parse(value)));
const transactions = z.object({ committed: counter, rolledBack: counter, notAdmitted: counter }).strict();
const originalExit = z.object({ fence, processIdentity: ownedIdentity, observation: z.literal("owned_handle_exited"),
  exitCode: z.number().int().safe().nullable(), signal: z.string().nullable(), observedAt: oldTime }).strict();
const receiptFields = { formatVersion: z.literal(1), kind: z.literal("source-client-drain"), clientId: text,
  databaseInstanceId: source.shape.databaseInstanceId, sourceIdentityDigest: hash, processIdentityDigest: hash,
  registeredEpoch: counter, drainEpoch: counter.positive(), ownerGeneration: counter.positive(), migrationId: text, planDigest: hash,
  quiescence: z.object({ activeTransactions: z.literal(0), activeJobs: z.literal(0), openFileWriters: z.literal(0), businessConnectionsClosed: z.literal(true) }).strict(),
  ownedExits: z.array(originalExit), completedAt: oldTime };
const receiptSchema = z.discriminatedUnion("buildId", [
  z.object({ ...receiptFields, buildId: z.literal("boardroom-storage-drain-v1"), entrypoint: z.enum(["http", "stdio", "owned-background"]) }).strict(),
  z.object({ ...receiptFields, buildId: z.literal("boardroom-native-management-v1"), entrypoint: z.literal("local-management"), nativeTransactions: transactions }).strict(),
]);
const creation = z.object({ migrationId: id, plan: ref, fenceEpoch: safePos, ownerGeneration: safePos, previousAnchor: ref, targetSequence: safePos }).strict();
const registrationSchema = z.object({ formatVersion: z.literal(1), kind: z.literal("maintenance-controller-registration"), source,
  sourceIdentityDigest: hash, creation, sessionBinding: z.literal("per-source-lock-native-inventory-v1"), drainReceipt: z.null() }).strict();
const sqliteIdentity = z.object({ kind: z.literal("sqlite"), sourcePath: text, sqlitePath: text, device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/) }).strict();
const pgEnvelopeIdentity = z.object({ kind: z.literal("postgres"), database_oid: text, schema_oid: text, database_name: text, schema_name: text, configurationDigest: hash }).strict();
const backend = z.object({ pid: counter.positive(), backend_start: text, application_name: text }).strict();
const sqliteSession = z.object({ kind: z.literal("sqlite"), owner: z.enum(["local-driver", "client-control"]) }).strict();
const pgSession = z.discriminatedUnion("owner", [
  z.object({ kind: z.literal("postgres"), owner: z.literal("local-driver"), applicationName: text, observedBackends: z.array(backend).nonempty() }).strict(),
  z.object({ kind: z.literal("postgres"), owner: z.literal("client-control"), observedBackends: z.array(backend).nonempty() }).strict(),
]);
const nativeSession = z.object({ kind: z.literal("sqlite"), owner: z.literal("native-management"), connectionId: text, state: z.literal("closed"), nativeTransactions: transactions }).strict();
const envelope = z.object({ formatVersion: z.literal(1), sourceIdentity: z.unknown(), sessions: z.array(z.unknown()), drainReceipt: receiptSchema.nullable() }).strict();
function parse<T>(schema: z.ZodType<T>, value: unknown): T { reserveP0FNativeClone(value); const result = schema.safeParse(value); requireCandidate(result.success); return result.data; }
function json(value: string | null, frame?: P0FArtifactSyntaxFrame, row?: SourceClientRawRow,
  column?: 'host_identity_json' | 'process_identity_json' | 'db_sessions_json'): unknown {
  requireCandidate(value !== null);
  const decode = () => { const decoded: unknown = JSON.parse(value);if(frame!==undefined)bindP0FRowJsonEncoding(frame,row!,column!,decoded); canonicalJson(decoded); return decoded; };
  if (frame !== undefined) { assertP0FRowJson(frame, row!, column!, value); return decode(); }
  try { return decode(); }
  catch { requireCandidate(false); }
}
function object(value: unknown): Record<string, unknown> {
  requireCandidate(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>;
}
export function supportedEncoding(encoding: Encoding): boolean {
  return encoding.backend === "sqlite" ? sqliteEncodings.includes(encoding.name)
    : encoding.backend === "postgres" && encoding.name === "UTF8";
}
export function encodeText(value: string, encoding: Encoding): SourceClientTextCell | null {
  if (!supportedEncoding(encoding)) return null;
  requireCandidate(!/[\uD800-\uDFFF]/u.test(value));
  const bytes = Buffer.from(value, encoding.name === "UTF-16le" || encoding.name === "UTF-16be" ? "utf16le" : "utf8");
  if (encoding.name === "UTF-16be") bytes.swap16();
  reserveP0FNativeNodes(3);
  return encodeP0FNativeShell(["text", bytes.toString("hex")] as SourceClientTextCell);
}
export function decodeRow(row: SourceClientRawRow, encoding: Encoding, frame?: P0FArtifactSyntaxFrame): Decoded | null {
  if (frame !== undefined) assertP0FRow(frame, row, encoding);
  reserveP0FNativeClone(row);
  requireCandidate(sourceClientRawRowSchema.safeParse(row).success);
  if (!supportedEncoding(encoding)) return null;
  reserveP0FNativeNodes(1 + 2 * sourceClientColumns.length);
  const result: Partial<Decoded> = {};
  const decode = () => {
    reserveP0FNativeKeyList(row);
    for (const key of Object.keys(row) as (keyof SourceClientRawRow)[]) {
      const cell = row[key];
      if (cell[0] === "null") result[key] = null;
      else if (cell[0] === "integer") result[key] = cell[1];
      else {
        const bytes = Buffer.from(cell[1], "hex"), name = encoding.backend === "postgres" ? "utf-8" : encoding.name;
        if (frame !== undefined) preflightP0FRowText(frame, row, encoding, bytes);
        const value = new TextDecoder(name, { fatal: true, ignoreBOM: true }).decode(bytes);
        requireCandidate(equal(encodeText(value, encoding), cell)); result[key] = value;
      }
    }
  };
  if (frame !== undefined) decode();
  else try { decode(); } catch { requireCandidate(false); }
  return result as Decoded;
}

/** Supplied manifest/raw data only. Native callers must additionally bind the exact
 * columns and raw rows to their actual current source window. */
export function bindSourceClientManifestRows(manifests: DatabaseManifests, rows: readonly SourceClientRawRow[], encoding: Encoding,
  nativeColumns?: Json, syntaxFrame?: P0FArtifactSyntaxFrame): { readonly kind: "untrusted-source-client-manifest-binding"; readonly rows: readonly Decoded[] } {
  if (syntaxFrame !== undefined) assertP0FSyntaxScope(syntaxFrame, 'rows', manifests);
  if (!supportedEncoding(encoding)) throw new MaintenanceFailure("source_changed", "v3-source-clients-encoding-unverified");
  requireCandidate(manifests.dialect === encoding.backend);
  // filter/decoded arrays, indexed edges, and the client-id projection below.
  reserveP0FNativeNodes(3 + rows.length, rows.length + manifests.controlRows.storage_source_clients.length);
  reserveP0FNativeMetadata(manifests.tables.length+1);
  const tables = manifests.tables.filter(table => table.name === "storage_source_clients");
  requireCandidate(tables.length === 1);
  const table = tables[0]!;
  requireCandidate(Array.isArray(table.columns) && table.columns.length === sourceClientColumns.length
    && (nativeColumns === undefined || equal(table.columns, nativeColumns)));
  for (const [index, expected] of sourceClientColumns.entries()) {
    const column = table.columns[index];
    requireCandidate(column !== null && typeof column === "object" && !Array.isArray(column) && column.name === expected.name);
    requireCandidate(encoding.backend === "sqlite"
      ? column.cid === String(index) && column.type === expected.sqlite && column.notnull === (expected.nullable || index === 0 ? "0" : "1")
      : column.position === String(index + 1) && column.type_oid === expected.postgres && column.not_null === !expected.nullable);
  }
  const decoded = rows.map(raw => { const value = decodeRow(raw, encoding, syntaxFrame); requireCandidate(value !== null && sameSourceClientRow(value, value)); return value; });
  reserveP0FNativeMetadata(1);
  const indexed = new Map<string, Readonly<Record<string, Json>>>();
  for (const row of manifests.controlRows.storage_source_clients) {
    requireCandidate(sameSourceClientRow(row, row) && typeof row.client_id === "string" && !indexed.has(row.client_id)); indexed.set(row.client_id, row);
  }
  requireCandidate(indexed.size === decoded.length && (reserveP0FNativeMetadata(decoded.length+2),new Set(decoded.map(row => row.client_id))).size === decoded.length);
  for (const row of decoded) { const actual = indexed.get(row.client_id!); requireCandidate(actual && sameSourceClientRow(row, actual)); }
  let typedNodes = 1;
  for (const row of rows) {
    typedNodes++;
    for (const column of sourceClientColumns) typedNodes += encoding.backend === 'sqlite' ? 1 + row[column.name].length : 3;
  }
  reserveP0FNativeNodes(typedNodes);
  const typed: Json[] = rows.map((row, index) => encodeP0FNativeShell(sourceClientColumns.map(column => encodeP0FNativeShell(encoding.backend === "sqlite"
    ? [...row[column.name]] : encodePostgresCell(column.postgres, decoded[index]![column.name])))));
  const expected = digestRowMultiset(typed);
  requireCandidate(table.count === expected.count && table.digest === expected.digest);
  reserveP0FNativeNodes(4);reserveP0FNativeMetadata(1);
  return { kind: "untrusted-source-client-manifest-binding", rows: decoded };
}
function rowDigest(context: RowContext, row: SourceClientRawRow): string {
  reserveP0FNativeNodes(8);
  return digestJson(encodeP0FNativeShell({ formatVersion: 1, kind: "source-client-row", source: context.record.source, textEncoding: context.encoding, row }));
}
function currentClient(row: Pick<SourceClientRawRow,'drain_epoch'|'registered_epoch'|'ended_at'>, epoch: number): boolean {
  return row.drain_epoch[0] === "integer" && row.drain_epoch[1] === String(epoch)
    || BigInt(row.registered_epoch[1]) === BigInt(epoch) - 1n && row.ended_at[0] === "null";
}
/** The existing epoch rule, exposed only as pure data for the private P0 cut.
 * This does not validate an ordinary profile or make a native liveness claim. */
export function sourceClientEpochClassification(row: Pick<SourceClientRawRow,'drain_epoch'|'registered_epoch'|'ended_at'>,
  epoch: number): 'current-client'|'historical-client' {
  return currentClient(row,epoch)?'current-client':'historical-client';
}
type PgRegistered = Omit<Extract<EventFacts["sessions"], { kind: "postgres-session-audit-v1" }>["registeredSessions"][number], "normalizedBackendStart" | "subject"> & { readonly subject: SourceClientTextCell };
function ordinaryProfile(row: SourceClientRawRow, decoded: Decoded, fact: Exclude<ClientFact, { kind: "maintenance-controller" }>, context: RowContext): PgRegistered[] {
  reserveP0FNativeNodes(1);
  const native = fact.kind === "native-management-client", registered: PgRegistered[] = [];
  requireCandidate(decoded.client_id !== null && decoded.client_id !== "" && decoded.database_instance_id === context.record.source.databaseInstanceId
    && decoded.build_id === (native ? "boardroom-native-management-v1" : "boardroom-storage-drain-v1")
    && (native ? decoded.entrypoint === "local-management" : ordinaryEntrypoints.includes(decoded.entrypoint!)));
  const body = parse(envelope, json(decoded.db_sessions_json, context.syntaxFrame, row, 'db_sessions_json'));
  if (context.record.source.kind === "sqlite") requireCandidate(equal(parse(sqliteIdentity, body.sourceIdentity), context.plan.sourceIdentity));
  else {
    const identity = parse(pgEnvelopeIdentity, body.sourceIdentity), expected = object(context.plan.sourceIdentity);
    requireCandidate(identity.database_oid === expected.databaseOid && identity.schema_oid === expected.schemaOid
      && identity.database_name === expected.databaseName && identity.schema_name === expected.schemaName);
    // configurationDigest depends on the real connection descriptor; the native-source obligation remains.
  }
  if (native) {
    requireCandidate(context.record.source.kind === "sqlite" && body.sessions.length === 1);
    const session = parse(nativeSession, body.sessions[0]);
    if (body.drainReceipt !== null) requireCandidate(body.drainReceipt.buildId === "boardroom-native-management-v1" && equal(body.drainReceipt.nativeTransactions, session.nativeTransactions));
  } else {
    requireCandidate(body.sessions.length === 2);
    reserveP0FNativeMetadata(3); // shell + the two session owner bindings
    const owners = new Set<string>();
    for (const [sessionIndex, value] of body.sessions.entries()) {
      if (context.record.source.kind === "sqlite") {
        const session = parse(sqliteSession, value); requireCandidate(!owners.has(session.owner)); owners.add(session.owner);
      } else {
        const session = parse(pgSession, value); requireCandidate(!owners.has(session.owner)); owners.add(session.owner);
        const name = `${session.owner === "local-driver" ? "boardroom-source" : "boardroom-control"}:${decoded.client_id}`;
        if (session.owner === "local-driver") requireCandidate(session.applicationName === name);
        for (const [backendIndex, item] of session.observedBackends.entries()) {
          requireCandidate(item.application_name === name);
          reserveP0FNativeNodes(12);
          registered.push({ subject: row.client_id, sessionIndex, backendIndex, owner: session.owner, pid: item.pid, originalBackendStart: item.backend_start });
        }
      }
    }
  }
  const current = currentClient(row, context.fenceEpoch), receipt = body.drainReceipt;
  requireCandidate(fact.classification === (current ? "current-client" : "historical-client"));
  if (receipt === null) {
    requireCandidate(!current && fact.receipt === null && decoded.ended_at !== null && decoded.drain_state === "none"
      && processDisposition(fact.process, fact.processCheck) === "exited");
    return registered;
  }
  requireCandidate(fact.receipt !== null && fact.receipt.digest === digestJson(receipt) && decoded.drain_receipt_digest === fact.receipt.digest
    && fact.receipt.kind === (current ? "current" : "historical") && decoded.drain_state === "drained"
    && receipt.clientId === decoded.client_id && receipt.entrypoint === decoded.entrypoint && receipt.buildId === decoded.build_id
    && receipt.databaseInstanceId === decoded.database_instance_id && String(receipt.registeredEpoch) === decoded.registered_epoch
    && String(receipt.drainEpoch) === decoded.drain_epoch && String(receipt.drainEpoch) === decoded.observed_epoch
    && receipt.drainEpoch === receipt.registeredEpoch + 1 && receipt.sourceIdentityDigest === digestJson(body.sourceIdentity)
    && receipt.processIdentityDigest === digestJson(json(decoded.process_identity_json, context.syntaxFrame, row, 'process_identity_json')));
  if (current) requireCandidate(receipt.drainEpoch === context.fenceEpoch && String(receipt.ownerGeneration) === context.receiptGeneration
    && receipt.migrationId === context.record.migrationId && receipt.planDigest === context.record.plan.sha256);
  else requireCandidate(receipt.drainEpoch < context.fenceEpoch);
  requireCandidate(fact.receipt.ownedExits.length === receipt.ownedExits.length);
  for (const [index, item] of receipt.ownedExits.entries()) requireCandidate(equal(item.fence, fact.receipt.ownedExits[index]!.fence)
    && equal(item.processIdentity, fact.receipt.ownedExits[index]!.processIdentity));
  return registered;
}
type ControllerDecoded = Pick<Decoded, "client_id" | "database_instance_id" | "entrypoint" | "build_id" | "drain_state"
  | "db_sessions_json" | "host_identity_json" | "process_identity_json">;
function controllerRegistration(row: SourceClientRawRow, decoded: ControllerDecoded,
  identity: { readonly host: unknown; readonly process: unknown }, source: SourceRef, syntaxFrame?: P0FArtifactSyntaxFrame) {
  const body = parse(registrationSchema, json(decoded.db_sessions_json, syntaxFrame, row, 'db_sessions_json'));
  requireCandidate(decoded.client_id !== null && decoded.client_id !== "" && decoded.database_instance_id === source.databaseInstanceId
    && decoded.entrypoint === "maintenance-controller" && decoded.build_id === "boardroom-maintenance-control-v1"
    && decoded.drain_state === "none" && row.drain_epoch[0] === "null" && row.drain_receipt_digest[0] === "null"
    && row.registered_epoch[1] === row.observed_epoch[1] && body.creation.fenceEpoch === row.registered_epoch[1]
    && equal(body.source, source) && body.sourceIdentityDigest === source.identityDigest
    && canonicalJson(body) === decoded.db_sessions_json && canonicalJson(identity.host) === decoded.host_identity_json
    && canonicalJson(identity.process) === decoded.process_identity_json);
  requireCandidate(body.creation.plan.ref === `plans/${body.creation.plan.sha256}.json` && BigInt(body.creation.targetSequence) > 1n
    && body.creation.previousAnchor.ref === `journals/${body.creation.migrationId}/${BigInt(body.creation.targetSequence) - 1n}-${body.creation.previousAnchor.sha256}.json`);
  return body;
}
const historicalControllerKeys=["client_id","database_instance_id","entrypoint","build_id","drain_state","db_sessions_json","host_identity_json","process_identity_json"] as const;
/** Strict existing S6/S7 data rules only. This does not inspect a process or grant registration/ownership. */
export function validateHistoricalControllerProfile(row: SourceClientRawRow, values: Readonly<Record<string, unknown>>,
  source: SourceRef, fenceEpoch: number, identity: { readonly host: unknown; readonly process: unknown }, syntaxFrame?: P0FArtifactSyntaxFrame): void {
  if(syntaxFrame!==undefined){assertP0FSyntaxScope(syntaxFrame,'rows',row);reserveP0FNativeNodes(51);}
  let decoded:ControllerDecoded;
  if(syntaxFrame!==undefined){
    decoded={} as ControllerDecoded;
    for(const key of historicalControllerKeys){const value=values[key];requireCandidate(typeof value==='string');decoded[key]=value;}
  }else{
    const keys = ["client_id", "database_instance_id", "entrypoint", "build_id", "drain_state", "db_sessions_json",
      "host_identity_json", "process_identity_json"] as const;
    decoded = Object.fromEntries(keys.map(key => {
      const value = values[key]; requireCandidate(typeof value === "string"); return [key, value];
    })) as ControllerDecoded;
  }
  const body = controllerRegistration(row, decoded, identity, source, syntaxFrame);
  requireCandidate(row.protocol_version[1] === "1" && BigInt(body.creation.fenceEpoch) < BigInt(fenceEpoch));
}
function controllerProfile(row: SourceClientRawRow, decoded: Decoded, fact: Extract<ClientFact, { kind: "maintenance-controller" }>, context: RowContext): void {
  const body = controllerRegistration(row, decoded, fact, context.record.source, context.syntaxFrame), prior = context.registrations.get(row.client_id[1]);
  if (prior) requireCandidate(fact.registration === "current-chain" && equal(prior.creation, body.creation) && prior.actorId === fact.process.instanceId
    && body.creation.fenceEpoch === String(context.fenceEpoch));
  else requireCandidate(fact.registration === "R0-historical" && BigInt(body.creation.fenceEpoch) < BigInt(context.fenceEpoch)
    && fact.classification === "exited-actor");
  if (fact.classification === "active-actor") requireCandidate(row.ended_at[0] === "null");
}
function runtimeRelations(facts: EventFacts): void {
  // owner [key, reused object] tuples, results array and four-scalar projections.
  reserveP0FNativeNodes(2 + facts.runtime.owners.length * 2 + facts.runtime.runners.length * 9, facts.runtime.owners.length);
  reserveP0FNativeMetadata(2+facts.runtime.owners.length*4); // map/list shells + list/pair metadata; bindings prepaid above
  const owners = new Map(facts.runtime.owners.map(owner => [owner.memberId, owner]));
  for (const owner of owners.values()) {
    if (owner.bindingId === null) requireCandidate(owner.leaseOwner === null && owner.leaseExpiresAt === null);
    else requireCandidate(owner.leaseOwner !== null && owner.leaseExpiresAt !== null && Number.isFinite(Date.parse(owner.leaseExpiresAt))
      && facts.runtime.runners.some(row => row.bindingId === owner.bindingId && row.memberId === owner.memberId && row.generation === owner.generation && row.leaseOwner === owner.leaseOwner));
  }
  const results = facts.runtime.runners.map(row => {
    const owner = owners.get(row.memberId);
    requireCandidate(owner && owner.generation >= row.generation && (row.leaseOwner === null
      || owner.bindingId === row.bindingId && owner.generation === row.generation && owner.leaseOwner === row.leaseOwner));
    if (row.generation === 0) requireCandidate(row.leaseOwner === null && row.processIdentity === null && row.exitConfirmed === 1);
    reserveP0FNativeNodes(2 + facts.clients.length);
    reserveP0FNativeWork(facts.clients.length);
    let exitCount=0,emptyLists=0;
    for(const client of facts.clients){if(client.kind==='maintenance-controller'||client.receipt===null)emptyLists++;else exitCount+=client.receipt.ownedExits.length;}
    reserveP0FNativeMetadata(2+emptyLists+exitCount*2);
    const exits = facts.clients.flatMap(client => client.kind === "maintenance-controller" ? [] : client.receipt?.ownedExits ?? [])
      .filter(exit => exit.fence.bindingId === row.bindingId && exit.fence.memberId === row.memberId && exit.fence.generation === row.generation);
    if (row.processIdentity === null) requireCandidate(row.inspection === null && row.leaseOwner === null && row.exitConfirmed === 1 && (row.generation === 0 || exits.length > 0));
    else requireCandidate(row.inspection !== null && exits.every(exit => equal(exit.processIdentity, row.processIdentity) && (row.leaseOwner === null || exit.fence.owner === row.leaseOwner)));
    return { bindingId: row.bindingId, memberId: row.memberId, generation: row.generation, status: row.generation === 0 ? "not-owned" : "exited" };
  });
  requireCandidate(equal(results, facts.runtime.results));
  for (const client of facts.clients) if (client.kind !== "maintenance-controller" && client.classification === "current-client") for (const exit of client.receipt?.ownedExits ?? [])
    requireCandidate(results.some(row => row.bindingId === exit.fence.bindingId && row.memberId === exit.fence.memberId && row.generation === exit.fence.generation));
}
function sessionSources(facts: EventFacts, context: RowContext, expected: readonly PgRegistered[], allDecoded: boolean): void {
  const sessions = facts.sessions, identity = object(context.plan.sourceIdentity);
  if (sessions.kind === "postgres-session-audit-v1") {
    requireCandidate(identity.kind === "postgres" && sessions.databaseOid === identity.databaseOid && sessions.schemaOid === identity.schemaOid && sessions.descriptorDigest === identity.descriptorDigest);
    if (allDecoded) requireCandidate(sessions.registeredSessions.length === expected.length && sessions.registeredSessions.every((item, index) => {
      reserveP0FNativeShallow(item);
      const { normalizedBackendStart: _normalized, ...original } = item; return equal(original, expected[index]);
    }));
    for (const item of sessions.registeredSessions) requireCandidate(facts.clients.some(client => client.kind !== "maintenance-controller" && equal(client.subject, item.subject)));
    return;
  }
  const source = parse(sqliteIdentity, identity);
  reserveP0FNativeNodes(4);reserveP0FNativeMetadata(4);
  const paths = [source.sqlitePath, `${source.sqlitePath}-wal`, `${source.sqlitePath}-shm`];
  const main = sessions.sourceFiles[0]!;
  requireCandidate(main.presence === "present" && main.device === source.device && main.inode === source.inode
    && sessions.sourceFiles.every((file, index) => file.path === paths[index])
    && sessions.sessionsTree === context.plan.fileRoots.find(root => root.label === "managed-sessions")?.path);
  if (sessions.kind === "sqlite-linux-session-audit-v1") {
    for (const file of sessions.sourceFiles) if (file.presence === "present") {
      const dev = BigInt(file.device);
      requireCandidate(file.mappedInode === file.inode && file.mappedMajor === String((dev >> 8n & 0xfffn) | (dev >> 32n & 0xfffff000n))
        && file.mappedMinor === String((dev & 0xffn) | (dev >> 12n & 0xffffff00n)));
    }
    for (const item of sessions.matches) if (item.sourceRole !== "managed-sessions") requireCandidate(sessions.sourceFiles.some(file => file.role === item.sourceRole
      && file.presence === "present" && file.device === item.device && file.inode === item.inode));
  }
}

export function validateRowsFacts(rows: readonly SourceClientRawRow[], facts: EventFacts, context: RowContext): void {
  requireCandidate(facts.clients.length === rows.length && facts.beforeCount === String(rows.length));
  // Even an empty/equal table retains the unverified encoding obligation.
  if (!supportedEncoding(context.encoding)) {reserveP0FNativeSetBinding(context.unresolvedEncoding,context.encoding.name);context.unresolvedEncoding.add(context.encoding.name);}
  reserveP0FNativeNodes(1);
  const expected: PgRegistered[] = []; let allDecoded = true;
  for (const [index, row] of rows.entries()) {
    const fact = facts.clients[index]!;
    requireCandidate(equal(fact.subject, row.client_id) && fact.rowDigest === rowDigest(context, row));
    if (fact.kind !== "maintenance-controller") {
      const current = currentClient(row, context.fenceEpoch);
      requireCandidate(BigInt(row.registered_epoch[1]) < BigInt(context.fenceEpoch)
        && fact.classification === (current ? "current-client" : "historical-client") && (!current || fact.receipt !== null));
      if (fact.receipt === null) requireCandidate(row.ended_at[0] === "text" && processDisposition(fact.process, fact.processCheck) === "exited");
    } else {
      const registration = context.registrations.get(row.client_id[1]);
      requireCandidate(row.drain_epoch[0] === "null" && row.drain_receipt_digest[0] === "null" && equal(row.registered_epoch, row.observed_epoch));
      if (registration) requireCandidate(fact.registration === "current-chain" && registration.actorId === fact.process.instanceId
        && row.registered_epoch[1] === String(context.fenceEpoch));
      else requireCandidate(fact.registration === "R0-historical" && BigInt(row.registered_epoch[1]) < BigInt(context.fenceEpoch) && fact.classification === "exited-actor");
      if (fact.classification === "active-actor") requireCandidate(row.ended_at[0] === "null");
    }
    const decoded = decodeRow(row, context.encoding, context.syntaxFrame);
    if (decoded === null) { allDecoded = false;reserveP0FNativeSetBinding(context.unresolvedEncoding,context.encoding.name); context.unresolvedEncoding.add(context.encoding.name); continue; }
    requireCandidate(equal(json(decoded.host_identity_json, context.syntaxFrame, row, 'host_identity_json'), fact.host)
      && equal(json(decoded.process_identity_json, context.syntaxFrame, row, 'process_identity_json'), fact.process));
    if (fact.kind === "maintenance-controller") controllerProfile(row, decoded, fact, context);
    else expected.push(...ordinaryProfile(row, decoded, fact, context));
  }
  if (facts.actor.clientId !== null) requireCandidate(facts.clients.some(client => client.kind === "maintenance-controller"
    && client.classification === "active-actor" && equal(client.subject, facts.actor.clientId)));
  runtimeRelations(facts); sessionSources(facts, context, expected, allDecoded);
}

export function applyChanges(rows: readonly SourceClientRawRow[], proof: SuccessorProof, context: RowContext): readonly SourceClientRawRow[] {
  reserveP0FNativeNodes(1 + rows.length * 2, rows.length);
  reserveP0FNativeMetadata(2+rows.length*4); // Map/list shells, list slots, pair shells/slots; bindings prepaid above
  const next = new Map(rows.map(row => [row.client_id[1], row]));
  ordered(proof.changes, (a, b) => compareText(a.after.client_id[1], b.after.client_id[1]));
  const time = encodeText(proof.facts.observedAt, context.encoding);
  if (time === null) {reserveP0FNativeSetBinding(context.unresolvedEncoding,context.encoding.name);context.unresolvedEncoding.add(context.encoding.name);}
  for (const change of proof.changes) {
    const key = change.after.client_id[1];
    if (change.kind === "maintenance-registration") {
      requireCandidate(!next.has(key) && proof.facts.actor.clientId === null && change.actorId === proof.facts.actor.actorId
        && proof.facts.clients.every(client => client.process.instanceId !== change.actorId)
        && !(reserveP0FNativeMetadata(context.registrations.size+1),[...context.registrations.values()]).some(item => item.actorId === change.actorId));
      reserveP0FNativeNodes(11);
      const creationValue = { migrationId: context.record.migrationId, plan: context.record.plan, fenceEpoch: String(context.fenceEpoch),
        ownerGeneration: String(context.record.ownerGeneration), previousAnchor: proof.previousAnchor, targetSequence: String(context.record.sequence) };
      const row = change.after, decoded = decodeRow(row, context.encoding, context.syntaxFrame);
      requireCandidate(row.protocol_version[1] === "1" && row.registered_epoch[1] === String(context.fenceEpoch)
        && equal(row.observed_epoch, row.registered_epoch) && row.drain_epoch[0] === "null" && row.drain_receipt_digest[0] === "null" && row.ended_at[0] === "null");
      if (time !== null) requireCandidate(equal(row.registered_at, time) && equal(row.last_observed_at, time));
      if (decoded !== null) {
        reserveP0FNativeNodes(13);
        const expected = { formatVersion: 1, kind: "maintenance-controller-registration", source: context.record.source,
          sourceIdentityDigest: context.record.source.identityDigest, creation: creationValue, sessionBinding: "per-source-lock-native-inventory-v1", drainReceipt: null };
        requireCandidate(decoded.client_id !== null && decoded.client_id !== "" && decoded.database_instance_id === context.record.source.databaseInstanceId
          && decoded.entrypoint === "maintenance-controller" && decoded.build_id === "boardroom-maintenance-control-v1" && decoded.drain_state === "none"
          && decoded.host_identity_json === canonicalJson(proof.facts.actor.host) && decoded.process_identity_json === canonicalJson(proof.facts.actor.process)
          && decoded.db_sessions_json === canonicalJson(expected));
      } else {reserveP0FNativeSetBinding(context.unresolvedEncoding,context.encoding.name);context.unresolvedEncoding.add(context.encoding.name);}
      reserveP0FNativeNodes(4, 1);reserveP0FNativeMetadata(1); // registration record, independent of its binding
      context.registrations.set(key, { creation: creationValue, actorId: change.actorId });
    } else {
      requireCandidate(equal(change.subject, change.before.client_id) && equal(change.subject, change.after.client_id)
        && equal(next.get(key), change.before) && !equal(change.before, change.after));
      reserveP0FNativeKeyList(change.before);
      for (const column of Object.keys(change.before) as (keyof SourceClientRawRow)[]) if (!changedObservationColumns.includes(column))
        requireCandidate(equal(change.before[column], change.after[column]));
      if (time !== null) requireCandidate(equal(change.after.last_observed_at, time));
      const fact = proof.facts.clients.find(client => equal(client.subject, change.subject)); requireCandidate(fact);
      if (change.effect === "observed") requireCandidate(equal(change.after.ended_at, change.before.ended_at));
      else {
        requireCandidate(!(fact.kind === "maintenance-controller" && fact.classification === "active-actor") && change.after.ended_at[0] === "text");
        if (time !== null) requireCandidate(equal(change.after.ended_at, time));
      }
    }
    reserveP0FNativeMapBinding(next,key);next.set(key, change.after);
  }
  reserveP0FNativeNodes(1, next.size);reserveP0FNativeMetadata(1);
  return [...next.values()].sort((a, b) => compareText(a.client_id[1], b.client_id[1]));
}

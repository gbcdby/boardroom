import { z } from "zod";
import { canonicalJson, digestJson } from "../canonical.ts";
import { counter, hash, id, ref, source } from "../parse-primitives.ts";
import type { JournalRecord, MigrationPlan, SourceClientRawRow, SourceClientTextCell, SourceClientsRosterV1 } from "../types.ts";
import type { UntrustedJournalCandidate } from "./codec.ts";
import { compareText, equal, ordered, requireCandidate } from "./common.ts";
import { fence, ownedIdentity, safePos, processDisposition, type ClientFact, type EventFacts, type SuccessorProof } from "./schema.ts";

type Encoding = SourceClientsRosterV1["textEncoding"];
type Decoded = { -readonly [K in keyof SourceClientRawRow]: string | null };
type Registration = { readonly creation: z.infer<typeof creation>; readonly actorId: string };
export interface RowContext {
  readonly plan: MigrationPlan;
  readonly record: JournalRecord | UntrustedJournalCandidate;
  readonly encoding: Encoding;
  readonly receiptGeneration: string;
  readonly registrations: Map<string, Registration>;
  readonly unresolvedEncoding: Set<string>;
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
function parse<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); requireCandidate(result.success); return result.data; }
function json(value: string | null): unknown {
  requireCandidate(value !== null);
  try { const decoded: unknown = JSON.parse(value); canonicalJson(decoded); return decoded; }
  catch { requireCandidate(false); }
}
function object(value: unknown): Record<string, unknown> {
  requireCandidate(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>;
}
export function supportedEncoding(encoding: Encoding): boolean { return encoding.backend === "sqlite" || encoding.name === "UTF8"; }
export function encodeText(value: string, encoding: Encoding): SourceClientTextCell | null {
  if (!supportedEncoding(encoding)) return null;
  const bytes = Buffer.from(value, encoding.name === "UTF-16le" || encoding.name === "UTF-16be" ? "utf16le" : "utf8");
  if (encoding.name === "UTF-16be") bytes.swap16();
  return ["text", bytes.toString("hex")];
}
export function decodeRow(row: SourceClientRawRow, encoding: Encoding): Decoded | null {
  if (!supportedEncoding(encoding)) return null;
  const result: Partial<Decoded> = {};
  try {
    for (const key of Object.keys(row) as (keyof SourceClientRawRow)[]) {
      const cell = row[key];
      if (cell[0] === "null") result[key] = null;
      else if (cell[0] === "integer") result[key] = cell[1];
      else {
        const bytes = Buffer.from(cell[1], "hex"), name = encoding.backend === "postgres" ? "utf-8" : encoding.name;
        const value = new TextDecoder(name, { fatal: true, ignoreBOM: true }).decode(bytes);
        requireCandidate(equal(encodeText(value, encoding), cell)); result[key] = value;
      }
    }
  } catch { requireCandidate(false); }
  return result as Decoded;
}
function rowDigest(context: RowContext, row: SourceClientRawRow): string {
  return digestJson({ formatVersion: 1, kind: "source-client-row", source: context.record.source, textEncoding: context.encoding, row });
}
function currentClient(row: SourceClientRawRow, epoch: number): boolean {
  return row.drain_epoch[0] === "integer" && row.drain_epoch[1] === String(epoch)
    || BigInt(row.registered_epoch[1]) === BigInt(epoch) - 1n && row.ended_at[0] === "null";
}
type PgRegistered = Omit<Extract<EventFacts["sessions"], { kind: "postgres-session-audit-v1" }>["registeredSessions"][number], "normalizedBackendStart" | "subject"> & { readonly subject: SourceClientTextCell };
function ordinaryProfile(row: SourceClientRawRow, decoded: Decoded, fact: Exclude<ClientFact, { kind: "maintenance-controller" }>, context: RowContext): PgRegistered[] {
  const native = fact.kind === "native-management-client", registered: PgRegistered[] = [];
  requireCandidate(decoded.client_id !== null && decoded.client_id !== "" && decoded.database_instance_id === context.record.source.databaseInstanceId
    && decoded.build_id === (native ? "boardroom-native-management-v1" : "boardroom-storage-drain-v1")
    && (native ? decoded.entrypoint === "local-management" : ["http", "stdio", "owned-background"].includes(decoded.entrypoint!)));
  const body = parse(envelope, json(decoded.db_sessions_json));
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
          registered.push({ subject: row.client_id, sessionIndex, backendIndex, owner: session.owner, pid: item.pid, originalBackendStart: item.backend_start });
        }
      }
    }
  }
  const current = currentClient(row, context.record.fenceEpoch), receipt = body.drainReceipt;
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
    && receipt.processIdentityDigest === digestJson(json(decoded.process_identity_json)));
  if (current) requireCandidate(receipt.drainEpoch === context.record.fenceEpoch && String(receipt.ownerGeneration) === context.receiptGeneration
    && receipt.migrationId === context.record.migrationId && receipt.planDigest === context.record.plan.sha256);
  else requireCandidate(receipt.drainEpoch < context.record.fenceEpoch);
  requireCandidate(fact.receipt.ownedExits.length === receipt.ownedExits.length);
  for (const [index, item] of receipt.ownedExits.entries()) requireCandidate(equal(item.fence, fact.receipt.ownedExits[index]!.fence)
    && equal(item.processIdentity, fact.receipt.ownedExits[index]!.processIdentity));
  return registered;
}
function controllerProfile(row: SourceClientRawRow, decoded: Decoded, fact: Extract<ClientFact, { kind: "maintenance-controller" }>, context: RowContext): void {
  const body = parse(registrationSchema, json(decoded.db_sessions_json)), prior = context.registrations.get(row.client_id[1]);
  requireCandidate(decoded.client_id !== null && decoded.client_id !== "" && decoded.database_instance_id === context.record.source.databaseInstanceId
    && decoded.entrypoint === "maintenance-controller" && decoded.build_id === "boardroom-maintenance-control-v1"
    && decoded.drain_state === "none" && row.drain_epoch[0] === "null" && row.drain_receipt_digest[0] === "null"
    && row.registered_epoch[1] === row.observed_epoch[1] && body.creation.fenceEpoch === row.registered_epoch[1]
    && equal(body.source, context.record.source) && body.sourceIdentityDigest === context.record.source.identityDigest
    && canonicalJson(body) === decoded.db_sessions_json && canonicalJson(fact.host) === decoded.host_identity_json
    && canonicalJson(fact.process) === decoded.process_identity_json);
  requireCandidate(body.creation.plan.ref === `plans/${body.creation.plan.sha256}.json` && BigInt(body.creation.targetSequence) > 1n
    && body.creation.previousAnchor.ref === `journals/${body.creation.migrationId}/${BigInt(body.creation.targetSequence) - 1n}-${body.creation.previousAnchor.sha256}.json`);
  if (prior) requireCandidate(fact.registration === "current-chain" && equal(prior.creation, body.creation) && prior.actorId === fact.process.instanceId
    && body.creation.fenceEpoch === String(context.record.fenceEpoch));
  else requireCandidate(fact.registration === "R0-historical" && BigInt(body.creation.fenceEpoch) < BigInt(context.record.fenceEpoch)
    && fact.classification === "exited-actor");
  if (fact.classification === "active-actor") requireCandidate(row.ended_at[0] === "null");
}
function runtimeRelations(facts: EventFacts): void {
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
      const { normalizedBackendStart: _normalized, ...original } = item; return equal(original, expected[index]);
    }));
    for (const item of sessions.registeredSessions) requireCandidate(facts.clients.some(client => client.kind !== "maintenance-controller" && equal(client.subject, item.subject)));
    return;
  }
  const source = parse(sqliteIdentity, identity);
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
  const expected: PgRegistered[] = []; let allDecoded = true;
  for (const [index, row] of rows.entries()) {
    const fact = facts.clients[index]!;
    requireCandidate(equal(fact.subject, row.client_id) && fact.rowDigest === rowDigest(context, row));
    if (fact.kind !== "maintenance-controller") {
      const current = currentClient(row, context.record.fenceEpoch);
      requireCandidate(BigInt(row.registered_epoch[1]) < BigInt(context.record.fenceEpoch)
        && fact.classification === (current ? "current-client" : "historical-client") && (!current || fact.receipt !== null));
      if (fact.receipt === null) requireCandidate(row.ended_at[0] === "text" && processDisposition(fact.process, fact.processCheck) === "exited");
    } else {
      const registration = context.registrations.get(row.client_id[1]);
      requireCandidate(row.drain_epoch[0] === "null" && row.drain_receipt_digest[0] === "null" && equal(row.registered_epoch, row.observed_epoch));
      if (registration) requireCandidate(fact.registration === "current-chain" && registration.actorId === fact.process.instanceId
        && row.registered_epoch[1] === String(context.record.fenceEpoch));
      else requireCandidate(fact.registration === "R0-historical" && BigInt(row.registered_epoch[1]) < BigInt(context.record.fenceEpoch) && fact.classification === "exited-actor");
      if (fact.classification === "active-actor") requireCandidate(row.ended_at[0] === "null");
    }
    const decoded = decodeRow(row, context.encoding);
    if (decoded === null) { allDecoded = false; context.unresolvedEncoding.add(context.encoding.name); continue; }
    requireCandidate(equal(json(decoded.host_identity_json), fact.host) && equal(json(decoded.process_identity_json), fact.process));
    if (fact.kind === "maintenance-controller") controllerProfile(row, decoded, fact, context);
    else expected.push(...ordinaryProfile(row, decoded, fact, context));
  }
  if (facts.actor.clientId !== null) requireCandidate(facts.clients.some(client => client.kind === "maintenance-controller"
    && client.classification === "active-actor" && equal(client.subject, facts.actor.clientId)));
  runtimeRelations(facts); sessionSources(facts, context, expected, allDecoded);
}

export function applyChanges(rows: readonly SourceClientRawRow[], proof: SuccessorProof, context: RowContext): readonly SourceClientRawRow[] {
  const next = new Map(rows.map(row => [row.client_id[1], row]));
  ordered(proof.changes, (a, b) => compareText(a.after.client_id[1], b.after.client_id[1]));
  const time = encodeText(proof.facts.observedAt, context.encoding);
  if (time === null) context.unresolvedEncoding.add(context.encoding.name);
  for (const change of proof.changes) {
    const key = change.after.client_id[1];
    if (change.kind === "maintenance-registration") {
      requireCandidate(!next.has(key) && proof.facts.actor.clientId === null && change.actorId === proof.facts.actor.actorId
        && proof.facts.clients.every(client => client.process.instanceId !== change.actorId)
        && ![...context.registrations.values()].some(item => item.actorId === change.actorId));
      const creationValue = { migrationId: context.record.migrationId, plan: context.record.plan, fenceEpoch: String(context.record.fenceEpoch),
        ownerGeneration: String(context.record.ownerGeneration), previousAnchor: proof.previousAnchor, targetSequence: String(context.record.sequence) };
      const row = change.after, decoded = decodeRow(row, context.encoding);
      requireCandidate(row.protocol_version[1] === "1" && row.registered_epoch[1] === String(context.record.fenceEpoch)
        && equal(row.observed_epoch, row.registered_epoch) && row.drain_epoch[0] === "null" && row.drain_receipt_digest[0] === "null" && row.ended_at[0] === "null");
      if (time !== null) requireCandidate(equal(row.registered_at, time) && equal(row.last_observed_at, time));
      if (decoded !== null) {
        const expected = { formatVersion: 1, kind: "maintenance-controller-registration", source: context.record.source,
          sourceIdentityDigest: context.record.source.identityDigest, creation: creationValue, sessionBinding: "per-source-lock-native-inventory-v1", drainReceipt: null };
        requireCandidate(decoded.client_id !== null && decoded.client_id !== "" && decoded.database_instance_id === context.record.source.databaseInstanceId
          && decoded.entrypoint === "maintenance-controller" && decoded.build_id === "boardroom-maintenance-control-v1" && decoded.drain_state === "none"
          && decoded.host_identity_json === canonicalJson(proof.facts.actor.host) && decoded.process_identity_json === canonicalJson(proof.facts.actor.process)
          && decoded.db_sessions_json === canonicalJson(expected));
      } else context.unresolvedEncoding.add(context.encoding.name);
      context.registrations.set(key, { creation: creationValue, actorId: change.actorId });
    } else {
      requireCandidate(equal(change.subject, change.before.client_id) && equal(change.subject, change.after.client_id)
        && equal(next.get(key), change.before) && !equal(change.before, change.after));
      for (const column of Object.keys(change.before) as (keyof SourceClientRawRow)[]) if (!["last_observed_at", "ended_at"].includes(column))
        requireCandidate(equal(change.before[column], change.after[column]));
      if (time !== null) requireCandidate(equal(change.after.last_observed_at, time));
      const fact = proof.facts.clients.find(client => equal(client.subject, change.subject)); requireCandidate(fact);
      if (change.effect === "observed") requireCandidate(equal(change.after.ended_at, change.before.ended_at));
      else {
        requireCandidate(!(fact.kind === "maintenance-controller" && fact.classification === "active-actor") && change.after.ended_at[0] === "text");
        if (time !== null) requireCandidate(equal(change.after.ended_at, time));
      }
    }
    next.set(key, change.after);
  }
  return [...next.values()].sort((a, b) => compareText(a.client_id[1], b.client_id[1]));
}

import { z } from "zod";
import { canonicalJson } from "../canonical.ts";
import { counter, hash, id, ref, source } from "../parse-primitives.ts";
import { sourceClientRawRowSchema, sourceClientsEncodingSchema } from "../source-clients.ts";
import type { SourceRef } from "../types.ts";
import { compareNumber, compareText, equal, ordered, requireCandidate } from "./common.ts";
import { preparseP0FInvariantJson, reserveP0FNativeNodes,reserveP0FNativeSplit, type P0FArtifactSyntaxFrame } from '../../../identity/internal/m2-p0-artifacts-frame.ts';

const text = z.string().min(1).max(4096).refine(value => !value.includes("\0"));
export const uint = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const pos = z.string().regex(/^[1-9][0-9]*$/);
// Zod refinements also run after a failed regex; never convert unvalidated caller text to BigInt.
export const safePos = pos.refine(value => value.length < 16 || value.length === 16 && value <= "9007199254740991");
const nativeTicks = z.string().regex(/^[0-9]{1,24}$/);
const micros = z.string().regex(/^[0-9]{1,6}$/);
const boot = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const namespace = z.string().regex(/^pid:\[[0-9]+\]$/);
export const time = z.string().refine(value => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
});
const rowKey = sourceClientRawRowSchema.shape.client_id;
const host = z.object({ version: z.literal(1), hostname: text, platform: z.enum(["linux", "darwin"]) }).strict();
const processBase = { version: z.literal(1), pid: counter.positive(), instanceId: text };
const linuxProcess = z.object({ ...processBase, platform: z.literal("linux"), verification: z.literal("linux_proc_identity_v1"),
  kernelBootId: boot, pidNamespace: namespace, startTicks: nativeTicks }).strict();
const darwinProcess = z.object({ ...processBase, platform: z.literal("darwin"), verification: z.literal("darwin_proc_identity_v1"),
  uid: counter, bootSessionUuid: z.string().uuid(), startSeconds: nativeTicks, startMicroseconds: micros }).strict();
export const registeredProcess = z.discriminatedUnion("platform", [linuxProcess, darwinProcess]);
const linuxCheck = { observerUid: counter, kernelBootId: boot, pidNamespace: namespace, pid: counter.positive() };
const darwinResult = { version: z.literal(1), pid: counter.positive(), bootSessionUuid: z.string().uuid() };
const processCheck = z.discriminatedUnion("kind", [
  z.object({ ...linuxCheck, kind: z.literal("linux-matched"), uidBefore: counter, uidAfter: counter,
    startTicksBefore: nativeTicks, startTicksAfter: nativeTicks }).strict(),
  z.object({ ...linuxCheck, kind: z.literal("linux-absent"), stage: z.enum(["proc-open", "proc-stat"]), errno: z.enum(["ENOENT", "ESRCH"]) }).strict(),
  z.object({ ...linuxCheck, kind: z.literal("linux-replaced"), observedUid: counter, observedStartTicks: nativeTicks }).strict(),
  z.object({ kind: z.literal("darwin-present"), result: z.object({ ...darwinResult, status: z.literal("present"), uid: counter, startSeconds: nativeTicks, startMicroseconds: micros }).strict() }).strict(),
  z.object({ kind: z.literal("darwin-absent"), result: z.object({ ...darwinResult, status: z.literal("absent") }).strict() }).strict(),
]);
export const ownedIdentity = z.object({ version: z.literal(1), launcherProtocol: z.literal("linux-private-net-v1"), pid: counter.positive(),
  kernelBootId: boot, pidNamespace: namespace, startTicks: uint }).strict();
const ownedInspection = z.object({ status: z.literal("wrapper_exited"), reason: z.enum(["boot_changed", "process_absent", "start_ticks_changed"]), inspectedAt: time }).strict();
export const fence = z.object({ bindingId: text, memberId: text, generation: counter.positive(), owner: text }).strict();
const ownedExit = z.object({ fence, processIdentity: ownedIdentity, inspection: ownedInspection }).strict();
const factReceipt = z.object({ digest: hash, kind: z.enum(["current", "historical"]), ownedExits: z.array(ownedExit) }).strict();
const clientBase = { subject: rowKey, rowDigest: hash, host, process: registeredProcess, processCheck };
const client = z.discriminatedUnion("kind", [
  z.object({ ...clientBase, kind: z.literal("ordinary-client"), classification: z.enum(["current-client", "historical-client"]), receipt: factReceipt.nullable() }).strict(),
  z.object({ ...clientBase, kind: z.literal("native-management-client"), classification: z.enum(["current-client", "historical-client"]), receipt: factReceipt.nullable() }).strict(),
  z.object({ ...clientBase, kind: z.literal("maintenance-controller"), classification: z.enum(["active-actor", "exited-actor"]), registration: z.enum(["current-chain", "R0-historical"]) }).strict(),
]);
const actor = z.object({ actorId: z.string().uuid(), clientId: rowKey.nullable(), host, process: registeredProcess, processCheck }).strict();
const runtime = z.object({
  runners: z.array(z.object({ bindingId: text, memberId: text, generation: counter, leaseOwner: text.nullable(), exitConfirmed: z.union([z.literal(0), z.literal(1)]), processIdentity: ownedIdentity.nullable(), inspection: ownedInspection.nullable() }).strict()),
  owners: z.array(z.object({ memberId: text, bindingId: text.nullable(), generation: counter, leaseOwner: text.nullable(), leaseExpiresAt: text.nullable() }).strict()),
  results: z.array(z.object({ bindingId: text, memberId: text, generation: counter, status: z.enum(["not-owned", "exited"]) }).strict()),
}).strict();

const postgres = z.object({ kind: z.literal("postgres-session-audit-v1"), databaseOid: uint, schemaOid: uint, descriptorDigest: hash,
  ownedSessions: z.array(z.object({ pid: counter.positive(), backendStart: text, role: z.enum(["operation-mutex", "source-control", "inspection"]) }).strict()),
  activity: z.array(z.object({ pid: counter.positive(), backendStart: text, backendType: text, state: text.nullable(), writeLock: z.boolean() }).strict()),
  registeredSessions: z.array(z.object({ subject: rowKey, sessionIndex: counter, backendIndex: counter, owner: z.enum(["local-driver", "client-control"]), pid: counter.positive(), originalBackendStart: text, normalizedBackendStart: text }).strict()),
  preparedQueryRows: z.literal(0),
}).strict();
const linuxKey = z.string().regex(/^(fd:(0|[1-9][0-9]*)|map:(0|[1-9][0-9]*):(0|[1-9][0-9]*):(0|[1-9][0-9]*):[r-][w-][x-][sp])$/);
const darwinKey = z.string().regex(/^(fd:(0|[1-9][0-9]*)|map:(0|[1-9][0-9]*):(0|[1-9][0-9]*))$/);
function sourceFile(role: "main" | "wal" | "shm", linux: boolean) {
  const present = z.object({ role: z.literal(role), path: text, presence: z.literal("present"), device: uint, inode: uint,
    ...(linux ? { mappedMajor: uint, mappedMinor: uint, mappedInode: uint } : {}) }).strict();
  return role === "main" ? present : z.union([present, z.object({ role: z.literal(role), path: text, presence: z.literal("absent") }).strict()]);
}
const observer = z.object({ host, process: registeredProcess }).strict();
const linux = z.object({ kind: z.literal("sqlite-linux-session-audit-v1"), observer, uid: counter,
  sourceFiles: z.tuple([sourceFile("main", true), sourceFile("wal", true), sourceFile("shm", true)]), sessionsTree: text,
  ownedResources: z.array(z.object({ key: linuxKey, device: uint, inode: uint }).strict()),
  matches: z.array(z.object({ pid: counter.positive(), startTicks: nativeTicks, key: linuxKey, device: uint, inode: uint, sourceRole: z.enum(["main", "wal", "shm", "managed-sessions"]) }).strict()),
}).strict();
const darwin = z.object({ kind: z.literal("sqlite-darwin-session-audit-v1"), observer, uid: counter,
  sourceFiles: z.tuple([sourceFile("main", false), sourceFile("wal", false), sourceFile("shm", false)]), sessionsTree: text,
  ownedResources: z.array(z.object({ key: darwinKey, device: uint, inode: uint }).strict()),
  inventory: z.object({ version: z.literal(1), scope: z.literal("current-uid"), items: z.array(z.object({ kind: z.literal("handle"), pid: counter.positive(),
    startSeconds: nativeTicks, startMicroseconds: micros, key: darwinKey, fd: z.number().int().safe().min(-1), path: z.string().max(4096).refine(value => !value.includes("\0")), device: uint, inode: uint, links: uint }).strict()) }).strict(),
}).strict();
export const eventFactsSchema = z.object({ formatVersion: z.literal(1), kind: z.literal("source-control-event-facts"), collector: z.literal("boardroom-source-control-facts-v1"),
  observedAt: time, actor, beforeCount: uint, beforeRowsDigest: hash, clients: z.array(client), runtime,
  sessions: z.discriminatedUnion("kind", [postgres, linux, darwin]),
}).strict();
const canonicalObjectTextFor = (frame?: P0FArtifactSyntaxFrame) => z.string().min(1).refine(value => !value.includes("\0")).refine(value => {
  const decode = () => { const item: unknown = JSON.parse(value); return item !== null && typeof item === "object" && !Array.isArray(item) && canonicalJson(item) === value; };
  if (frame !== undefined) { preparseP0FInvariantJson(frame, value); return decode(); }
  try { return decode(); }
  catch { return false; }
});
export const invariantSchemaFor = (frame?: P0FArtifactSyntaxFrame) => z.object({ singleton: z.literal("1"), databaseInstanceId: source.shape.databaseInstanceId,
  controlRootJson: canonicalObjectTextFor(frame), mutexIdentityJson: canonicalObjectTextFor(frame), fenceEpoch: safePos, admission: z.literal("sealed"),
  activeMigrationId: id, planDigest: hash, protocolVersion: z.literal("1"), guardManifestDigest: hash }).strict();
export const invariantSchema = invariantSchemaFor();
const rowChange = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("maintenance-registration"), before: z.null(), after: sourceClientRawRowSchema, actorId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("client-observation"), before: sourceClientRawRowSchema, after: sourceClientRawRowSchema, subject: rowKey, effect: z.enum(["observed", "ended-observed"]) }).strict(),
]);
const successor = { formatVersion: z.literal(1), originCapture: ref, originSourceClientsDigest: hash, source, plan: ref, migrationId: id,
  fenceEpoch: safePos, receiptGeneration: safePos, textEncoding: sourceClientsEncodingSchema, previousAnchor: ref,
  fromGeneration: safePos, toGeneration: safePos, targetSequence: safePos, beforeRowsDigest: hash, afterRowsDigest: hash,
  changes: z.array(rowChange), facts: eventFactsSchema };
export const controlProofSchemaFor = (frame?: P0FArtifactSyntaxFrame) => z.discriminatedUnion("kind", [
  z.object({ formatVersion: z.literal(1), kind: z.literal("capture-controls"), maintenanceInvariant: frame === undefined ? invariantSchema : invariantSchemaFor(frame), facts: eventFactsSchema }).strict(),
  z.object({ ...successor, kind: z.literal("control-successor") }).strict(),
  z.object({ ...successor, kind: z.literal("legacy-first-capture-bridge"), legacy: z.object({ ready: ref, receipt: ref, manifests: ref }).strict() }).strict(),
  z.object({ formatVersion: z.literal(1), kind: z.literal("cancel-terminal-controls"),
    originCapture: ref, originSourceClientsDigest: hash, source, plan: ref, migrationId: id,
    epochBefore: safePos, epochAfter: safePos, receiptGeneration: safePos, textEncoding: sourceClientsEncodingSchema,
    previousAnchor: ref, ownerGeneration: safePos, targetSequence: safePos,
    beforeRowsDigest: hash, afterRowsDigest: hash, changes: z.tuple([]), facts: eventFactsSchema,
    successorRule: z.literal("open-next-epoch-clear-active-v1") }).strict(),
]);
export const controlProofSchema = controlProofSchemaFor();
export type EventFacts = z.infer<typeof eventFactsSchema>;
export type ClientFact = EventFacts["clients"][number];
export type RegisteredProcess = z.infer<typeof registeredProcess>;
export type ProcessCheck = z.infer<typeof processCheck>;
export type ControlProof = z.infer<typeof controlProofSchema>;
export type SuccessorProof = Extract<ControlProof, { kind: "control-successor" | "legacy-first-capture-bridge" }>;
export type CancelTerminalProof = Extract<ControlProof, { kind: "cancel-terminal-controls" }>;
export type MaintenanceInvariant = z.infer<typeof invariantSchema>;

function resourceKeyRange(key: string, platform: "linux" | "darwin"): void {
  if (key.startsWith("map:")) {
    reserveP0FNativeNodes(1 + (platform === 'linux' ? 5 : 3));
    reserveP0FNativeSplit(key,':');
    const parts = key.split(":"), first = BigInt(parts[1]!), second = BigInt(parts[2]!);
    // Preserve each native key: Darwin emits begin/size; Linux emits start/end.
    if (platform === "darwin") requireCandidate(second > 0n && first + second <= (1n << 64n) - 1n);
    else requireCandidate(first < second);
  }
}

/** Structural consistency only: a caller can construct all these bytes. No native calls occur here. */
export function processDisposition(process: RegisteredProcess, check: ProcessCheck): "matched" | "exited" {
  if (process.platform === "linux") {
    requireCandidate(check.kind === "linux-matched" || check.kind === "linux-absent" || check.kind === "linux-replaced");
    requireCandidate(check.pid === process.pid && check.kernelBootId === process.kernelBootId && check.pidNamespace === process.pidNamespace);
    if (check.kind === "linux-matched") {
      requireCandidate(check.uidBefore === check.observerUid && check.uidAfter === check.observerUid
        && BigInt(check.startTicksBefore) === BigInt(process.startTicks) && BigInt(check.startTicksAfter) === BigInt(process.startTicks));
      return "matched";
    }
    if (check.kind === "linux-replaced") requireCandidate(check.observedUid === check.observerUid && BigInt(check.observedStartTicks) !== BigInt(process.startTicks));
    return "exited";
  }
  requireCandidate(check.kind === "darwin-present" || check.kind === "darwin-absent");
  requireCandidate(check.result.pid === process.pid && check.result.bootSessionUuid === process.bootSessionUuid);
  if (check.kind === "darwin-absent") return "exited";
  requireCandidate(check.result.uid === process.uid);
  return BigInt(check.result.startSeconds) === BigInt(process.startSeconds) && BigInt(check.result.startMicroseconds) === BigInt(process.startMicroseconds) ? "matched" : "exited";
}

function sameNativeIncarnation(left: RegisteredProcess, right: RegisteredProcess): boolean {
  if (left.pid !== right.pid) return false;
  // A logical factory UUID cannot distinguish two observations of one native process.
  // These decimal fields have already passed the strict process schema.
  if (left.platform === "linux" && right.platform === "linux") {
    return left.kernelBootId === right.kernelBootId && left.pidNamespace === right.pidNamespace
      && BigInt(left.startTicks) === BigInt(right.startTicks);
  }
  if (left.platform === "darwin" && right.platform === "darwin") {
    return left.uid === right.uid && left.bootSessionUuid === right.bootSessionUuid
      && BigInt(left.startSeconds) === BigInt(right.startSeconds) && BigInt(left.startMicroseconds) === BigInt(right.startMicroseconds);
  }
  return false;
}

export function checkFactsShape(facts: EventFacts, sourceRef: SourceRef): void {
  const actor = facts.actor;
  requireCandidate(actor.actorId === actor.process.instanceId && actor.host.platform === actor.process.platform
    && processDisposition(actor.process, actor.processCheck) === "matched" && facts.beforeCount === String(facts.clients.length));
  ordered(facts.clients, (a, b) => compareText(a.subject[1], b.subject[1]));
  for (const client of facts.clients) {
    requireCandidate(equal(client.host, actor.host) && client.process.platform === actor.process.platform);
    const disposition = processDisposition(client.process, client.processCheck);
    if (actor.process.platform === "linux") {
      requireCandidate(client.process.platform === "linux" && "observerUid" in client.processCheck && "observerUid" in actor.processCheck
        && client.processCheck.observerUid === actor.processCheck.observerUid && client.process.kernelBootId === actor.process.kernelBootId
        && client.process.pidNamespace === actor.process.pidNamespace);
    } else requireCandidate(client.process.platform === "darwin" && client.process.uid === actor.process.uid && client.process.bootSessionUuid === actor.process.bootSessionUuid);
    requireCandidate(disposition !== "exited" || !sameNativeIncarnation(client.process, actor.process));
    if (client.kind === "native-management-client") requireCandidate(sourceRef.kind === "sqlite");
    if (client.kind === "maintenance-controller") {
      if (client.classification === "active-actor") requireCandidate(actor.clientId !== null && equal(client.subject, actor.clientId)
        && equal(client.process, actor.process) && disposition === "matched");
      else requireCandidate(disposition === "exited");
    } else if (client.receipt !== null) requireCandidate(client.receipt.kind === (client.classification === "current-client" ? "current" : "historical"));
  }
  ordered(facts.runtime.runners, (a, b) => compareText(a.bindingId, b.bindingId));
  ordered(facts.runtime.owners, (a, b) => compareText(a.memberId, b.memberId));
  ordered(facts.runtime.results, (a, b) => compareText(a.bindingId, b.bindingId));
  const sessions = facts.sessions;
  if (sessions.kind === "postgres-session-audit-v1") {
    requireCandidate(sourceRef.kind === "postgres");
    ordered(sessions.ownedSessions, (a, b) => compareNumber(a.pid, b.pid) || compareText(a.backendStart, b.backendStart));
    ordered(sessions.activity, (a, b) => compareNumber(a.pid, b.pid));
    ordered(sessions.registeredSessions, (a, b) => compareText(a.subject[1], b.subject[1]) || compareNumber(a.sessionIndex, b.sessionIndex) || compareNumber(a.backendIndex, b.backendIndex));
    for (const item of sessions.activity) requireCandidate(sessions.ownedSessions.some(owned => owned.pid === item.pid && owned.backendStart === item.backendStart));
    for (const item of sessions.registeredSessions) requireCandidate(!sessions.activity.some(active => active.pid === item.pid && active.backendStart === item.normalizedBackendStart));
    return;
  }
  reserveP0FNativeNodes(3);
  requireCandidate(sourceRef.kind === "sqlite" && equal(sessions.observer, { host: actor.host, process: actor.process }));
  ordered(sessions.ownedResources, (a, b) => compareText(a.key, b.key));
  for (const item of sessions.ownedResources) resourceKeyRange(item.key, sessions.kind === "sqlite-linux-session-audit-v1" ? "linux" : "darwin");
  if (sessions.kind === "sqlite-linux-session-audit-v1") {
    requireCandidate(actor.process.platform === "linux" && actor.processCheck.kind === "linux-matched" && sessions.uid === actor.processCheck.observerUid);
    ordered(sessions.matches, (a, b) => compareNumber(a.pid, b.pid) || compareNumber(BigInt(a.startTicks), BigInt(b.startTicks)) || compareText(a.key, b.key));
    for (const item of sessions.matches) {
      resourceKeyRange(item.key, "linux");
      requireCandidate(item.pid === actor.process.pid && item.startTicks === actor.process.startTicks
        && sessions.ownedResources.some(owned => owned.key === item.key && owned.device === item.device && owned.inode === item.inode));
    }
  } else {
    requireCandidate(actor.process.platform === "darwin" && sessions.uid === actor.process.uid);
    ordered(sessions.inventory.items, (a, b) => compareNumber(a.pid, b.pid) || compareNumber(BigInt(a.startSeconds), BigInt(b.startSeconds))
      || compareNumber(BigInt(a.startMicroseconds), BigInt(b.startMicroseconds)) || compareText(a.key, b.key));
    for (const item of sessions.inventory.items) {
      resourceKeyRange(item.key, "darwin");
      requireCandidate(item.pid === actor.process.pid && item.startSeconds === actor.process.startSeconds
        && item.startMicroseconds === actor.process.startMicroseconds && item.links === "1"
        && (item.key.startsWith("fd:") ? item.key === `fd:${item.fd}` : item.fd === -1)
        && sessions.ownedResources.some(owned => owned.key === item.key && owned.device === item.device && owned.inode === item.inode));
    }
  }
}

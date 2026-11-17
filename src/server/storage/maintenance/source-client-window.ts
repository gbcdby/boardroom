import { canonicalJson } from "./canonical.ts";
import { registeredProcess } from "./control-candidate/schema.ts";
import { supportedEncoding } from "./control-candidate/rows.ts";
import { sameSourceClientCell, sameSourceClientRow } from "./source-client-equality.ts";
import { sourceClientColumns } from "./source-clients-read.ts";
import { inspectRegisteredSourceProcess } from "./source-facts.ts";
import type { ArtifactRef, Json, SourceClientsRosterV1, SourceRef } from "./types.ts";

type Row = Readonly<Record<string, Json>>;
type ProofRow = Readonly<Record<string, Json>>;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const columns = sourceClientColumns.map(column => column.name);
function timestampValue(value: Json | undefined): bigint | null {
  if (typeof value !== "string") return null;
  const parts = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?Z$/.exec(value);
  if (!parts) return null;
  const base = `${parts[1]}.000Z`, millis = Date.parse(base);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== base) return null;
  return BigInt(millis) * 1000n + BigInt((parts[2] ?? "").padEnd(6, "0"));
}
const timestamp = (value: Json | undefined): value is string => timestampValue(value) !== null;

const positive = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]*$/.test(value);
const ref = (value: unknown): value is ArtifactRef => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.ref === "string" && typeof item.sha256 === "string"
    && /^[a-f0-9]{64}$/.test(item.sha256) && positive(item.bytes);
};
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

type ControllerProcessEvidence = { readonly status: string; readonly reason: string };
type NativeControllerProcessEvidence = { readonly fact: ControllerProcessEvidence };
export interface SourceClientJournalAnchor {
  readonly reference: ArtifactRef;
  readonly previous: ArtifactRef | null;
  readonly migrationId: string;
  readonly planDigest: string;
  readonly fenceEpoch: number;
  readonly ownerGeneration: number;
  readonly sequence: number;
}
export interface SourceClientRegistrationProof {
  readonly journal: ArtifactRef;
  readonly sequence: number;
  readonly clientId: string;
  readonly after: ProofRow;
  readonly actorId: string;
}
export interface SourceClientObservationProof {
  readonly journal: ArtifactRef;
  readonly sequence: number;
  readonly clientId: string;
  readonly before: ProofRow;
  readonly after: ProofRow;
  readonly effect: "observed" | "ended-observed";
}
export interface SourceClientJournalProof {
  readonly registrations: readonly SourceClientRegistrationProof[];
  readonly observations: readonly SourceClientObservationProof[];
}
interface CommonOptions {
  readonly journalAdvanced: boolean;
  readonly fenceEpoch: number;
  readonly databaseInstanceId: string;
  readonly source: SourceRef;
  readonly migrationId: string;
  readonly planDigest: string;
  readonly currentSequence: number;
  readonly anchors?: readonly SourceClientJournalAnchor[];
  readonly inspectProcess?: (host: Record<string, unknown>, identity: Record<string, unknown>) =>
    Promise<ControllerProcessEvidence | NativeControllerProcessEvidence>;
}
export type CompatibleSourceClientWindowOptions = CommonOptions & (
  | { readonly mode: "strict"; readonly proof: SourceClientJournalProof }
  | { readonly mode: "weak"; readonly proof?: undefined }
);

export type OriginSourceClientWindowOptions = Omit<Extract<CompatibleSourceClientWindowOptions, { mode: "strict" }>,
  "mode" | "inspectProcess" | "journalAdvanced"> & {
    readonly originCapture: SourceClientJournalAnchor;
    readonly textEncoding: SourceClientsRosterV1["textEncoding"];
  };

/** v3 final live comparison always starts at O, even when archive S is newer.
 * This is a native observation over already-bound data, never a lock/guard permit.
 * Unlike the legacy structural helper it has no native-inspection override. */
export async function compatibleOriginSourceClientWindow(origin: readonly Row[], current: readonly Row[],
  options: OriginSourceClientWindowOptions): Promise<boolean> {
  if ("inspectProcess" in options || !supportedEncoding(options.textEncoding)
    || options.textEncoding.backend !== options.source.kind || !Number.isSafeInteger(options.fenceEpoch) || options.fenceEpoch < 1)
    return false;
  const anchors = options.anchors, first = options.originCapture;
  if (!anchors?.length || !same(anchors[0], first) || first.sequence < 2
    || !Number.isSafeInteger(options.currentSequence) || anchors.at(-1)!.sequence !== options.currentSequence) return false;
  // Validate this relationship even when both tables and all changes are empty.
  for (const [index, anchor] of anchors.entries()) {
    if (!Number.isSafeInteger(anchor.sequence) || !ref(anchor.reference) || !ref(anchor.previous)
      || anchor.reference.ref !== `journals/${options.migrationId}/${anchor.sequence}-${anchor.reference.sha256}.json`
      || anchor.previous.ref !== `journals/${options.migrationId}/${anchor.sequence - 1}-${anchor.previous.sha256}.json`
      || anchor.migrationId !== options.migrationId || anchor.planDigest !== options.planDigest || anchor.fenceEpoch !== options.fenceEpoch
      || !Number.isSafeInteger(anchor.ownerGeneration) || anchor.ownerGeneration < 1
      || index > 0 && (anchor.sequence !== anchors[index - 1]!.sequence + 1 || !same(anchor.previous, anchors[index - 1]!.reference))) return false;
  }
  for (const row of origin) if (row.entrypoint === "maintenance-controller" || row.build_id === "boardroom-maintenance-control-v1") {
    const epoch = row.registered_epoch;
    if (typeof epoch !== "number" && typeof epoch !== "string" || !/^(0|[1-9][0-9]*)$/.test(String(epoch))
      || typeof epoch === "number" && !Number.isSafeInteger(epoch) || BigInt(epoch) >= BigInt(options.fenceEpoch)) return false;
  }
  return compatibleSourceClientWindow(origin, current, { mode: "strict", journalAdvanced: options.currentSequence > first.sequence,
    fenceEpoch: options.fenceEpoch, databaseInstanceId: options.databaseInstanceId, source: options.source,
    migrationId: options.migrationId, planDigest: options.planDigest, currentSequence: options.currentSequence,
    anchors, proof: options.proof });
}

/** The envelope is only self-describing; strict mode additionally binds it to a
 * journal-anchored registration change and its actor. Weak mode is an explicitly
 * non-final prefilter and must never be used to authorize a live restore. */
function hasRegisteredControllerProof(row: Row, options: CompatibleSourceClientWindowOptions,
  registration?: SourceClientRegistrationProof): boolean {
  if (typeof row.db_sessions_json !== "string") return false;
  let parsed: unknown;
  try { parsed = JSON.parse(row.db_sessions_json); } catch { return false; }
  if (canonicalJson(parsed) !== row.db_sessions_json) return false;
  const body = object(parsed);
  if (!body || body.formatVersion !== 1 || body.kind !== "maintenance-controller-registration"
    || !same(body.source, options.source) || body.sourceIdentityDigest !== options.source.identityDigest
    || body.sessionBinding !== "per-source-lock-native-inventory-v1" || body.drainReceipt !== null) return false;
  const creation = object(body.creation);
  if (!creation || creation.migrationId !== options.migrationId || !ref(creation.plan) || !ref(creation.previousAnchor)
    || creation.plan.ref !== `plans/${options.planDigest}.json` || creation.plan.sha256 !== options.planDigest
    || creation.fenceEpoch !== String(options.fenceEpoch) || !positive(creation.ownerGeneration)
    || !positive(creation.targetSequence)) return false;
  const target = Number(creation.targetSequence);
  if (!Number.isSafeInteger(target) || target <= 1 || target > options.currentSequence) return false;
  if (creation.previousAnchor.ref !== `journals/${options.migrationId}/${target - 1}-${creation.previousAnchor.sha256}.json`) return false;
  if (registration) {
    if (target !== registration.sequence || registration.clientId !== row.client_id) return false;
    const anchor = options.anchors?.find(item => item.sequence === target);
    return !!anchor && same(anchor.reference, registration.journal)
      && anchor.migrationId === options.migrationId && anchor.planDigest === options.planDigest
      && anchor.fenceEpoch === options.fenceEpoch && anchor.ownerGeneration === Number(creation.ownerGeneration)
      && same(anchor.previous, creation.previousAnchor);
  }
  if (options.mode === "strict") return false;
  if (!options.anchors) return true;
  const node = options.anchors.find(item => item.sequence === target);
  return !!node && same(node.previous, creation.previousAnchor) && node.migrationId === options.migrationId
    && node.planDigest === creation.plan.sha256 && node.fenceEpoch === options.fenceEpoch
    && node.ownerGeneration === Number(creation.ownerGeneration);
}

function actorBound(row: Row, registration: SourceClientRegistrationProof): boolean {
  const original = registration.after;
  if (!sameSourceClientRow(original, original) || original.client_id !== registration.clientId
    || original.ended_at !== null || !timestamp(original.registered_at)
    || original.registered_at !== original.last_observed_at
    || columns.some(key => key !== "last_observed_at" && key !== "ended_at"
      && !sameSourceClientCell(key, original[key], row[key]))) return false;
  if (typeof original.process_identity_json !== "string") return false;
  try {
    const process: unknown = JSON.parse(original.process_identity_json);
    return object(process)?.instanceId === registration.actorId;
  } catch { return false; }
}

function anchored(options: CompatibleSourceClientWindowOptions, journal: ArtifactRef, sequence: number): boolean {
  return Number.isSafeInteger(sequence) && sequence > 0 && sequence <= options.currentSequence
    && !!options.anchors?.some(item => item.sequence === sequence && same(item.reference, journal));
}

function validProof(options: CompatibleSourceClientWindowOptions, old: ReadonlyMap<string, Row>, now: ReadonlyMap<string, Row>): boolean {
  if (options.mode !== "strict") return true;
  const { registrations, observations } = options.proof;
  if (!registrations.length && !observations.length) return true;
  const anchors = options.anchors;
  if (!anchors?.length || !Number.isSafeInteger(options.currentSequence) || options.currentSequence < 1
    || anchors.at(-1)!.sequence !== options.currentSequence) return false;
  for (const [index, anchor] of anchors.entries()) {
    if (!Number.isSafeInteger(anchor.sequence) || anchor.sequence < 2 || !ref(anchor.reference) || !ref(anchor.previous)
      || anchor.reference.ref !== `journals/${options.migrationId}/${anchor.sequence}-${anchor.reference.sha256}.json`
      || anchor.previous.ref !== `journals/${options.migrationId}/${anchor.sequence - 1}-${anchor.previous.sha256}.json`
      || anchor.migrationId !== options.migrationId || anchor.planDigest !== options.planDigest || anchor.fenceEpoch !== options.fenceEpoch
      || !Number.isSafeInteger(anchor.ownerGeneration) || anchor.ownerGeneration < 1
      || index > 0 && (anchor.sequence !== anchors[index-1]!.sequence + 1 || !same(anchor.previous, anchors[index-1]!.reference))) return false;
  }
  const clients = new Set<string>(), actors = new Set<string>();
  let last = 0;
  for (const registration of registrations) {
    if (registration.sequence < last || !anchored(options, registration.journal, registration.sequence)
      || old.has(registration.clientId) || !now.has(registration.clientId) || clients.has(registration.clientId)
      || !registration.actorId || actors.has(registration.actorId)
      || !sameSourceClientRow(registration.after, registration.after) || registration.after.client_id !== registration.clientId) return false;
    clients.add(registration.clientId); actors.add(registration.actorId); last = registration.sequence;
  }
  const changes = new Set<string>(); last = 0;
  for (const observation of observations) {
    const key = `${observation.sequence}:${observation.clientId}`;
    if (observation.sequence < last || !anchored(options, observation.journal, observation.sequence) || changes.has(key)
      || !now.has(observation.clientId) || !(old.has(observation.clientId) || clients.has(observation.clientId))
      || !sameSourceClientRow(observation.before, observation.before) || !sameSourceClientRow(observation.after, observation.after)
      || observation.before.client_id !== observation.clientId || observation.after.client_id !== observation.clientId) return false;
    changes.add(key); last = observation.sequence;
  }
  return true;
}

/** An observation changes only monotonic timestamps; its effect must describe
 * that exact transition, including an ended state that can never be reopened. */
function observedStep(before: Row, after: Row, effect: SourceClientObservationProof["effect"]): boolean {
  if (sameSourceClientRow(before, after) || columns.some(key => key !== "last_observed_at" && key !== "ended_at"
    && !sameSourceClientCell(key, before[key], after[key])) || !timestamp(before.last_observed_at)
    || !timestamp(after.last_observed_at) || timestampValue(after.last_observed_at)! < timestampValue(before.last_observed_at)!) return false;
  if (effect === "observed") return sameSourceClientCell("ended_at", before.ended_at, after.ended_at);
  return effect === "ended-observed" && before.ended_at === null && timestamp(after.ended_at)
    && timestamp(before.registered_at) && timestampValue(after.ended_at)! >= timestampValue(before.registered_at)!
    && timestampValue(after.ended_at)! >= timestampValue(before.last_observed_at)!
    && timestampValue(after.ended_at)! <= timestampValue(after.last_observed_at)!;
}

/** Follow client-observation changes from a proven row to the live row. The
 * sequence must advance and every step must be anchored to a live journal node. */
function observationEffect(options: CompatibleSourceClientWindowOptions, clientId: string,
  from: ProofRow, to: ProofRow, minimumSequence = 0): "observed" | "ended-observed" | null {
  if (options.mode !== "strict") return null;
  let current = from, last = minimumSequence, ended = false;
  for (const next of options.proof.observations.filter(item => item.clientId === clientId)) {
    if (next.sequence <= last || !anchored(options, next.journal, next.sequence)
      || !sameSourceClientRow(next.before, current) || !observedStep(next.before, next.after, next.effect)) return null;
    last = next.sequence;
    ended = ended || next.effect === "ended-observed";
    current = next.after;
  }
  return sameSourceClientRow(current, to) ? ended ? "ended-observed" : "observed" : null;
}

function registrationFor(options: CompatibleSourceClientWindowOptions, row: Row): SourceClientRegistrationProof | undefined {
  return options.mode === "strict"
    ? options.proof.registrations.find(item => item.clientId === row.client_id)
    : undefined;
}

async function controllerIdentity(row: Row, options: CompatibleSourceClientWindowOptions, allowExited: boolean): Promise<boolean> {
  if (typeof row.host_identity_json !== "string" || typeof row.process_identity_json !== "string") return false;
  try {
    const host: unknown = JSON.parse(row.host_identity_json);
    const identity: unknown = JSON.parse(row.process_identity_json);
    if (!host || typeof host !== "object" || Array.isArray(host)
      || !registeredProcess.safeParse(identity).success) return false;
    const inspect = options.inspectProcess ?? inspectRegisteredSourceProcess;
    const inspected = await inspect(host as Record<string, unknown>, identity as Record<string, unknown>);
    const evidence = "fact" in inspected ? inspected.fact : inspected;
    return allowExited
      ? evidence.status === "exited" && evidence.reason === "process_absent"
      : evidence.status === "present" && evidence.reason === "identity_matches";
  } catch { return false; }
}

/** Only the live source-client controls may drift from the exact archived image.
 * Strict callers must supply journal registration/observation proof for every row
 * that changes; weak callers are an explicitly non-final native-backup prefilter. */
export async function compatibleSourceClientWindow(before: readonly Row[], current: readonly Row[],
  options: CompatibleSourceClientWindowOptions): Promise<boolean> {
  const old = new Map<string, Row>(), now = new Map<string, Row>();
  for (const [rows, dest] of [[before, old], [current, now]] as const) for (const row of rows) {
    if (!sameSourceClientRow(row, row) || typeof row.client_id !== "string" || !row.client_id
      || dest.has(row.client_id)) return false;
    dest.set(row.client_id, row);
  }
  if (!validProof(options, old, now)) return false;
  const unchanged = old.size === now.size && [...old].every(([id, row]) => now.has(id) && sameSourceClientRow(row, now.get(id)!));
  if (unchanged && (options.mode !== "strict" || !options.proof.observations.length)) return true;
  if (!options.journalAdvanced) return false;
  for (const [id, prior] of old) {
    const live = now.get(id);
    if (!live) return false; // Never delete a captured client identity.
    for (const key of columns) if (key !== "last_observed_at" && key !== "ended_at"
      && !sameSourceClientCell(key, prior[key], live[key])) return false;
    if (!sameSourceClientCell("last_observed_at", prior.last_observed_at, live.last_observed_at)
      && (!timestamp(prior.last_observed_at) || !timestamp(live.last_observed_at)
        || timestampValue(live.last_observed_at)! < timestampValue(prior.last_observed_at)!)) return false;
    // An end event cannot be retroactively placed before the last captured
    // observation or the original registration. A later journal observation
    // cannot make an earlier, unobserved termination legitimate.
    const ending = !sameSourceClientCell("ended_at", prior.ended_at, live.ended_at);
    if (ending
      && (prior.ended_at !== null || !timestamp(live.ended_at)
        || !timestamp(prior.registered_at) || !timestamp(prior.last_observed_at)
        || !timestamp(live.last_observed_at)
        || timestampValue(live.ended_at)! < timestampValue(prior.registered_at)!
        || timestampValue(live.ended_at)! < timestampValue(prior.last_observed_at)!
        || timestampValue(live.ended_at)! > timestampValue(live.last_observed_at)!)) return false;
    if (sameSourceClientRow(prior, live) && (options.mode !== "strict" || !options.proof.observations.some(item => item.clientId === id))) continue;
    if (options.mode === "strict") {
      const effect = observationEffect(options, id, prior, live);
      if (!effect) return false;
      if (ending && live.ended_at !== null) {
        if (effect !== "ended-observed" || !await controllerIdentity(live, options, true)) return false;
      } else if (effect !== "observed") return false;
    } else if (ending && live.ended_at !== null
      && (!hasRegisteredControllerProof(live, options) || !await controllerIdentity(live, options, true))) return false;
  }
  for (const [id, row] of now) {
    if (old.has(id)) continue;
    const ended = row.ended_at !== null;
    if (row.entrypoint !== "maintenance-controller" || row.database_instance_id !== options.databaseInstanceId
      || row.build_id !== "boardroom-maintenance-control-v1"
      || !sameSourceClientCell("protocol_version", row.protocol_version, 1)
      || !sameSourceClientCell("registered_epoch", row.registered_epoch, options.fenceEpoch)
      || !sameSourceClientCell("observed_epoch", row.observed_epoch, options.fenceEpoch)
      || row.drain_epoch !== null || row.drain_state !== "none"
      || row.drain_receipt_digest !== null
      || !timestamp(row.registered_at) || !timestamp(row.last_observed_at)
      || timestampValue(row.last_observed_at)! < timestampValue(row.registered_at)!
      || typeof row.host_identity_json !== "string" || typeof row.process_identity_json !== "string") return false;
    if (ended && (!timestamp(row.ended_at)
      || timestampValue(row.ended_at)! < timestampValue(row.registered_at)!
      || timestampValue(row.ended_at)! > timestampValue(row.last_observed_at)!)) return false;
    const registration = registrationFor(options, row);
    if (options.mode === "strict") {
      if (!registration || !actorBound(row, registration)
        || !hasRegisteredControllerProof(registration.after, options, registration)) return false;
      const effect = observationEffect(options, id, registration.after, row, registration.sequence);
      if (effect !== (ended ? "ended-observed" : "observed")) return false;
    } else if (!hasRegisteredControllerProof(row, options)) return false;
    if (!await controllerIdentity(row, options, ended)) return false;
  }
  return true;
}

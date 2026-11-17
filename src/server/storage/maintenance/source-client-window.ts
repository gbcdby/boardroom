import { canonicalJson } from "./canonical.ts";
import { registeredProcess } from "./control-candidate/schema.ts";
import { inspectRegisteredSourceProcess } from "./source-facts.ts";
import type { ArtifactRef, Json, SourceRef } from "./types.ts";

type Row = Readonly<Record<string, Json>>;
type ProofRow = Readonly<Record<string, Json>>;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const columns = [
  "client_id", "database_instance_id", "entrypoint", "build_id", "protocol_version",
  "host_identity_json", "process_identity_json", "db_sessions_json",
  "registered_epoch", "observed_epoch", "drain_epoch", "drain_state",
  "drain_receipt_digest", "registered_at", "last_observed_at", "ended_at",
].sort();
const timestamp = (value: Json | undefined): value is string => typeof value === "string"
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value)
  && Number.isFinite(Date.parse(value));

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
  if (!same(registration.after, row)
    || !same(registration.after.host_identity_json, row.host_identity_json)
    || !same(registration.after.process_identity_json, row.process_identity_json)) return false;
  if (typeof row.process_identity_json !== "string") return false;
  try {
    const process: unknown = JSON.parse(row.process_identity_json);
    return object(process)?.instanceId === registration.actorId;
  } catch { return false; }
}

function anchored(options: CompatibleSourceClientWindowOptions, journal: ArtifactRef, sequence: number): boolean {
  return !!options.anchors?.some(item => item.sequence === sequence && same(item.reference, journal));
}

/** Follow client-observation changes from a proven row to the live row. The
 * sequence must advance and every step must be anchored to a live journal node. */
function observationEffect(options: CompatibleSourceClientWindowOptions, clientId: string,
  from: ProofRow, to: ProofRow): "observed" | "ended-observed" | null {
  if (options.mode !== "strict") return null;
  let current = from, last = 0, ended = false;
  const used = new Set<number>();
  for (;;) {
    if (same(current, to)) return ended ? "ended-observed" : "observed";
    const next = options.proof.observations
      .filter(item => item.clientId === clientId && item.sequence > last
        && !used.has(item.sequence) && same(item.before, current))
      .sort((a, b) => a.sequence - b.sequence)[0];
    if (!next || !anchored(options, next.journal, next.sequence)) return null;
    used.add(next.sequence);
    last = next.sequence;
    ended = ended || next.effect === "ended-observed";
    current = next.after;
  }
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
  if (same(before, current)) return true;
  if (!options.journalAdvanced) return false;
  const old = new Map<string, Row>(), now = new Map<string, Row>();
  for (const [rows, dest] of [[before, old], [current, now]] as const) for (const row of rows) {
    if (!same(Object.keys(row).sort(), columns) || typeof row.client_id !== "string" || !row.client_id
      || dest.has(row.client_id)) return false;
    dest.set(row.client_id, row);
  }
  for (const [id, prior] of old) {
    const live = now.get(id);
    if (!live) return false; // Never delete a captured client identity.
    for (const key of columns) if (key !== "last_observed_at" && key !== "ended_at"
      && !same(prior[key], live[key])) return false;
    if (!same(prior.last_observed_at, live.last_observed_at)
      && (!timestamp(prior.last_observed_at) || !timestamp(live.last_observed_at)
        || Date.parse(live.last_observed_at) < Date.parse(prior.last_observed_at))) return false;
    // An end event cannot be retroactively placed before the last captured
    // observation or the original registration. A later journal observation
    // cannot make an earlier, unobserved termination legitimate.
    const ending = !same(prior.ended_at, live.ended_at);
    if (ending
      && (prior.ended_at !== null || !timestamp(live.ended_at)
        || !timestamp(prior.registered_at) || !timestamp(prior.last_observed_at)
        || !timestamp(live.last_observed_at)
        || Date.parse(live.ended_at) < Date.parse(prior.registered_at)
        || Date.parse(live.ended_at) < Date.parse(prior.last_observed_at)
        || Date.parse(live.ended_at) > Date.parse(live.last_observed_at))) return false;
    if (same(prior, live)) continue;
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
      || String(row.protocol_version) !== "1"
      || String(row.registered_epoch) !== String(options.fenceEpoch)
      || String(row.observed_epoch) !== String(options.fenceEpoch)
      || row.drain_epoch !== null || row.drain_state !== "none"
      || row.drain_receipt_digest !== null
      || !timestamp(row.registered_at) || !timestamp(row.last_observed_at)
      || Date.parse(row.last_observed_at) < Date.parse(row.registered_at)
      || typeof row.host_identity_json !== "string" || typeof row.process_identity_json !== "string") return false;
    if (ended && (!timestamp(row.ended_at)
      || Date.parse(row.ended_at) < Date.parse(row.registered_at)
      || Date.parse(row.ended_at) > Date.parse(row.last_observed_at))) return false;
    const registration = registrationFor(options, row);
    if (options.mode === "strict") {
      if (!registration || !actorBound(row, registration)
        || !hasRegisteredControllerProof(row, options, registration)) return false;
      if (!same(row.ended_at, registration.after.ended_at)
        && observationEffect(options, id, registration.after, row) !== "ended-observed") return false;
    } else if (!hasRegisteredControllerProof(row, options)) return false;
    if (!await controllerIdentity(row, options, ended)) return false;
  }
  return true;
}

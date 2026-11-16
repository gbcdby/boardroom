import { canonicalJson } from "./canonical.ts";
import { registeredProcess } from "./control-candidate/schema.ts";
import { inspectRegisteredSourceProcess } from "./source-facts.ts";
import type { Json } from "./types.ts";

type Row = Readonly<Record<string, Json>>;
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
function emptySessions(value: Json | undefined): boolean {
  if (typeof value !== "string") return false;
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.length === 0;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      && Object.keys(parsed).length === 1 && Array.isArray((parsed as { sessions?: unknown }).sessions)
      && (parsed as { sessions: unknown[] }).sessions.length === 0;
  } catch { return false; }
}

/** A new controller is not proven by its entrypoint label or JSON syntax.
 * Match the registered native process incarnation under the current host; unknown
 * or retired owners cannot acquire a new client row by journal text alone. */
async function authenticControllerIdentity(row: Row): Promise<boolean> {
  if (typeof row.host_identity_json !== "string" || typeof row.process_identity_json !== "string") return false;
  try {
    const host: unknown = JSON.parse(row.host_identity_json);
    const identity: unknown = JSON.parse(row.process_identity_json);
    if (!host || typeof host !== "object" || Array.isArray(host)
      || !registeredProcess.safeParse(identity).success) return false;
    const evidence = await inspectRegisteredSourceProcess(host as Record<string, unknown>, identity as Record<string, unknown>);
    return evidence.fact.status === "present" && evidence.fact.reason === "identity_matches";
  } catch { return false; }
}

/** Only the live source-client controls may drift from the exact archived image.
 * Caller separately proves the native mutex, anchored journal capture prefix,
 * valid observation/takeover successors and frozen source schema/business. */
export async function compatibleSourceClientWindow(before: readonly Row[], current: readonly Row[],
  options: { journalAdvanced: boolean; fenceEpoch: number; databaseInstanceId: string }): Promise<boolean> {
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
    if (!same(prior.ended_at, live.ended_at)
      && (prior.ended_at !== null || !timestamp(live.ended_at)
        || !timestamp(live.last_observed_at) || Date.parse(live.ended_at) > Date.parse(live.last_observed_at))) return false;
  }
  for (const [id, row] of now) {
    if (old.has(id)) continue;
    if (row.entrypoint !== "maintenance-controller" || row.database_instance_id !== options.databaseInstanceId
      || String(row.protocol_version) !== "1"
      || String(row.registered_epoch) !== String(options.fenceEpoch)
      || String(row.observed_epoch) !== String(options.fenceEpoch)
      || row.drain_epoch !== null || row.drain_state !== "none"
      || row.drain_receipt_digest !== null || row.ended_at !== null
      || !emptySessions(row.db_sessions_json) || typeof row.build_id !== "string" || !row.build_id
      || !timestamp(row.registered_at) || !timestamp(row.last_observed_at)
      || Date.parse(row.last_observed_at) < Date.parse(row.registered_at)
      || typeof row.host_identity_json !== "string" || typeof row.process_identity_json !== "string") return false;
    if (!await authenticControllerIdentity(row)) return false;
  }
  return true;
}

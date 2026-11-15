import { constants } from "node:fs";
import { open, readFile, readlink } from "node:fs/promises";
import { hostname } from "node:os";
import { inspectOwnedProcess } from "../../runtime/hosts/process-identity.ts";
import type { OwnedProcessIdentity } from "../../runtime/hosts/types.ts";
import { verifyStorageDrainReceipt, type StorageDrainReceipt } from "../source-client.ts";
import { canonicalJson, digestJson } from "./canonical.ts";
import type { EventFacts, ProcessCheck } from "./control-candidate/schema.ts";
import { validateHistoricalControllerProfile } from "./control-candidate/rows.ts";
import { darwinProcessObservation } from "./darwin.ts";
import { MaintenanceFailure } from "./error.ts";
import type { JournalRecord, SourceClientFact, SourceClientProcessFact, SourceClientsObservation, SourceRuntimeFact } from "./types.ts";

export function unknownWriter(): never { throw new MaintenanceFailure("source_writer_unknown"); }
export function factsObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return unknownWriter();
  return value as Record<string, unknown>;
}
function json(value: unknown): Record<string, unknown> {
  try { if (typeof value !== "string") return unknownWriter(); return factsObject(JSON.parse(value)); }
  catch { return unknownWriter(); }
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
function counter(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  return unknownWriter();
}
export function sourceTextHexes(observation: SourceClientsObservation): string[] {
  return [...new Set(observation.rows.flatMap(row => Object.values(row).flatMap(cell => cell[0] === "text" ? [cell[1]] : [])))];
}
export function decodedSourceRows(observation: SourceClientsObservation, text: ReadonlyMap<string, string>): Record<string, unknown>[] {
  return observation.rows.map(row => Object.fromEntries(Object.entries(row).map(([name, cell]) => {
    if (cell[0] === "null") return [name, null];
    if (cell[0] === "integer") return [name, counter(cell[1])];
    const value = text.get(cell[1]); if (value === undefined) return unknownWriter();
    return [name, value];
  })));
}
export function decodeSqliteSourceRows(observation: SourceClientsObservation): Record<string, unknown>[] {
  const text = new Map<string, string>(), name = observation.textEncoding.name;
  if (observation.textEncoding.backend !== "sqlite") return unknownWriter();
  try {
    for (const hex of sourceTextHexes(observation)) {
      const bytes = Buffer.from(hex, "hex"), value = new TextDecoder(name, { fatal: true, ignoreBOM: true }).decode(bytes);
      const encoded = Buffer.from(value, name === "UTF-8" ? "utf8" : "utf16le");
      if (name === "UTF-16be") encoded.swap16();
      if (!encoded.equals(bytes)) return unknownWriter();
      text.set(hex, value);
    }
  } catch { return unknownWriter(); }
  return decodedSourceRows(observation, text);
}

function procIdentity(text: string, expectedPid: number) {
  const end = text.lastIndexOf(") "), prefix = /^([1-9][0-9]*) \(/.exec(text);
  const fields = text.slice(end + 2).trim().split(/\s+/);
  if (text.length > 8192 || end < 0 || Number(prefix?.[1]) !== expectedPid || !/^[0-9]{1,24}$/.test(fields[19] ?? "")) return unknownWriter();
  return fields[19]!;
}
export async function inspectRegisteredSourceProcess(host: Record<string, unknown>, identity: Record<string, unknown>):
  Promise<{ readonly fact: SourceClientProcessFact; readonly check: ProcessCheck }> {
  if (!exactKeys(host, ["version", "hostname", "platform"]) || host.version !== 1 || host.hostname !== hostname()
    || host.platform !== process.platform || identity.version !== 1 || identity.platform !== process.platform
    || !Number.isSafeInteger(identity.pid) || Number(identity.pid) < 1 || typeof identity.instanceId !== "string" || !identity.instanceId) return unknownWriter();
  const pid = Number(identity.pid);
  if (process.platform === "darwin") {
    if (!exactKeys(identity, ["version", "platform", "pid", "instanceId", "verification", "uid", "bootSessionUuid", "startSeconds", "startMicroseconds"])
      || identity.verification !== "darwin_proc_identity_v1" || identity.uid !== process.getuid?.()
      || typeof identity.startSeconds !== "string" || !/^[0-9]{1,24}$/.test(identity.startSeconds)
      || typeof identity.startMicroseconds !== "string" || !/^[0-9]{1,6}$/.test(identity.startMicroseconds)) return unknownWriter();
    const actual = darwinProcessObservation(pid);
    // A registration containing only hostname cannot prove an older boot belonged to this host.
    if (actual.bootSessionUuid !== identity.bootSessionUuid) return unknownWriter();
    if (actual.status === "absent") return { fact: { status: "exited", reason: "process_absent" }, check: { kind: "darwin-absent", result: actual } };
    return { fact: actual.startSeconds === identity.startSeconds && actual.startMicroseconds === identity.startMicroseconds
      ? { status: "present", reason: "identity_matches" } : { status: "exited", reason: "identity_replaced" },
      check: { kind: "darwin-present", result: actual } };
  }
  if (process.platform !== "linux" || !exactKeys(identity, ["version", "platform", "pid", "instanceId", "verification", "kernelBootId", "pidNamespace", "startTicks"])
    || identity.verification !== "linux_proc_identity_v1" || typeof identity.kernelBootId !== "string"
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(identity.kernelBootId)
    || typeof identity.pidNamespace !== "string" || !/^pid:\[[0-9]+\]$/.test(identity.pidNamespace)
    || typeof identity.startTicks !== "string" || !/^[0-9]{1,24}$/.test(identity.startTicks)) return unknownWriter();
  let handle;
  try {
    const kernelBootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    if (kernelBootId !== identity.kernelBootId) return unknownWriter();
    const pidNamespace = await readlink("/proc/self/ns/pid");
    if (pidNamespace !== identity.pidNamespace) return unknownWriter();
    const observerUid = process.getuid?.();
    if (observerUid === undefined) return unknownWriter();
    const absent = (stage: "proc-open" | "proc-stat", errno: "ENOENT" | "ESRCH") => ({
      fact: { status: "exited" as const, reason: "process_absent" as const },
      check: { kind: "linux-absent" as const, observerUid, kernelBootId, pidNamespace, pid, stage, errno } });
    try { handle = await open(`/proc/${pid}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
    catch (error) {
      if (["ENOENT", "ESRCH"].includes(String((error as NodeJS.ErrnoException).code))) return absent("proc-open", (error as NodeJS.ErrnoException).code as "ENOENT" | "ESRCH");
      throw error;
    }
    const uidBefore = (await handle.stat()).uid;
    if (uidBefore !== observerUid) return unknownWriter();
    const directory = `/proc/self/fd/${handle.fd}`;
    let before: string;
    try { before = procIdentity(await readFile(`${directory}/stat`, "utf8"), pid); }
    catch (error) {
      if (["ENOENT", "ESRCH"].includes(String((error as NodeJS.ErrnoException).code))) return absent("proc-stat", (error as NodeJS.ErrnoException).code as "ENOENT" | "ESRCH");
      throw error;
    }
    if (before !== identity.startTicks) return { fact: { status: "exited", reason: "identity_replaced" },
      check: { kind: "linux-replaced", observerUid, kernelBootId, pidNamespace, pid, observedUid: uidBefore, observedStartTicks: before } };
    if (await readlink(`${directory}/ns/pid`) !== identity.pidNamespace) return unknownWriter();
    const after = procIdentity(await readFile(`${directory}/stat`, "utf8"), pid);
    if (before !== after) return unknownWriter();
    const uidAfter = (await handle.stat()).uid;
    if (uidAfter !== observerUid) return unknownWriter();
    return { fact: { status: "present", reason: "identity_matches" },
      check: { kind: "linux-matched", observerUid, kernelBootId, pidNamespace, pid, uidBefore, uidAfter, startTicksBefore: before, startTicksAfter: after } };
  } catch { return unknownWriter(); }
  finally { try { await handle?.close(); } catch { unknownWriter(); } }
}

function envelopeFor(row: Record<string, unknown>, sourceKind: SourceClientsObservation["source"]["kind"]) {
  const envelope = json(row.db_sessions_json);
  if (!exactKeys(envelope, ["formatVersion", "sourceIdentity", "sessions", "drainReceipt"]) || envelope.formatVersion !== 1
    || !Array.isArray(envelope.sessions) || typeof row.client_id !== "string" || !row.client_id) return unknownWriter();
  if (row.entrypoint === "local-management" && row.build_id === "boardroom-native-management-v1") {
    if (sourceKind !== "sqlite" || envelope.sessions.length !== 1) return unknownWriter();
    const session = factsObject(envelope.sessions[0]);
    if (!exactKeys(session, ["kind", "owner", "connectionId", "state", "nativeTransactions"]) || session.kind !== "sqlite"
      || session.owner !== "native-management" || typeof session.connectionId !== "string" || !session.connectionId
      || session.state !== "closed") return unknownWriter();
  } else {
    if (row.build_id !== "boardroom-storage-drain-v1" || !["http", "stdio", "owned-background"].includes(String(row.entrypoint))) return unknownWriter();
    if (envelope.sessions.length !== 2) return unknownWriter();
    const owners = new Set<string>();
    for (const value of envelope.sessions) {
      const session = factsObject(value), owner = session.owner;
      if (session.kind !== sourceKind || typeof owner !== "string" || !["local-driver", "client-control"].includes(owner) || owners.has(owner)) return unknownWriter();
      owners.add(owner);
      if (session.kind === "sqlite") { if (!exactKeys(session, ["kind", "owner"])) return unknownWriter(); }
      else if (session.kind === "postgres") {
        const fields = owner === "local-driver" ? ["kind", "owner", "applicationName", "observedBackends"] : ["kind", "owner", "observedBackends"];
        if (!exactKeys(session, fields) || !Array.isArray(session.observedBackends) || session.observedBackends.length === 0) return unknownWriter();
        const expectedName = `${owner === "local-driver" ? "boardroom-source" : "boardroom-control"}:${row.client_id}`;
        if (owner === "local-driver" && session.applicationName !== expectedName) return unknownWriter();
        for (const item of session.observedBackends) {
          const backend = factsObject(item);
          if (!exactKeys(backend, ["pid", "backend_start", "application_name"]) || !Number.isSafeInteger(backend.pid)
            || Number(backend.pid) < 1 || typeof backend.backend_start !== "string" || !backend.backend_start || backend.application_name !== expectedName) return unknownWriter();
        }
      } else return unknownWriter();
    }
  }
  return envelope;
}

export async function sourceClientFacts(observation: SourceClientsObservation, rows: readonly Record<string, unknown>[],
  receiptGeneration: number, validateSource: (value: unknown, observation: SourceClientsObservation) => void,
  audit?: EventFacts["clients"], historicalControllerHead?: JournalRecord): Promise<SourceClientFact[]> {
  const result: SourceClientFact[] = [];
  if (rows.length !== observation.rows.length) throw new MaintenanceFailure("source_changed");
  for (const [index, row] of rows.entries()) {
    if (row.entrypoint === "maintenance-controller" || row.build_id === "boardroom-maintenance-control-v1") {
      // Only the actual private audit path supplies its already verified no-capture planned head.
      if (!audit || !historicalControllerHead || historicalControllerHead.phase !== "planned" || observation.state.admission !== "draining"
        || historicalControllerHead.fenceEpoch !== observation.state.fenceEpoch
        || canonicalJson(historicalControllerHead.source) !== canonicalJson(observation.source)) return unknownWriter();
      const raw = observation.rows[index]!, host = json(row.host_identity_json), identity = json(row.process_identity_json);
      try { validateHistoricalControllerProfile(raw, row, observation.source, observation.state.fenceEpoch, { host, process: identity }); }
      catch { return unknownWriter(); }
      const inspected = await inspectRegisteredSourceProcess(host, identity);
      if (inspected.fact.status !== "exited") return unknownWriter();
      result.push({ clientId: String(row.client_id), classification: "historical-controller", receipt: null, process: inspected.fact });
      audit.push({ kind: "maintenance-controller", classification: "exited-actor", registration: "R0-historical",
        subject: [...raw.client_id], rowDigest: digestJson({ formatVersion: 1, kind: "source-client-row", source: observation.source,
          textEncoding: observation.textEncoding, row: raw }),
        host: host as EventFacts["actor"]["host"], process: identity as EventFacts["actor"]["process"], processCheck: inspected.check });
      continue;
    }
    const envelope = envelopeFor(row, observation.source.kind);
    if (row.database_instance_id !== observation.source.databaseInstanceId) throw new MaintenanceFailure("source_changed");
    if (counter(row.registered_epoch) >= observation.state.fenceEpoch) return unknownWriter();
    validateSource(envelope.sourceIdentity, observation);
    const host = json(row.host_identity_json), processIdentity = json(row.process_identity_json);
    const inspectedProcess = await inspectRegisteredSourceProcess(host, processIdentity), process = inspectedProcess.fact;
    const ownedExits: NonNullable<Extract<EventFacts["clients"][number], { kind: "ordinary-client" }>["receipt"]>["ownedExits"] = [];
    const current = row.drain_epoch === observation.state.fenceEpoch
      || row.registered_epoch === observation.state.fenceEpoch - 1 && row.ended_at === null;
    let receipt: StorageDrainReceipt | null = null;
    if (current || envelope.drainReceipt !== null) {
      try {
        const original = factsObject(envelope.drainReceipt);
        receipt = verifyStorageDrainReceipt(row, { databaseInstanceId: observation.source.databaseInstanceId,
          fenceEpoch: current ? observation.state.fenceEpoch : counter(original.drainEpoch),
          ownerGeneration: current ? receiptGeneration : counter(original.ownerGeneration),
          migrationId: current ? observation.state.activeMigrationId! : String(original.migrationId),
          planDigest: current ? observation.state.planDigest! : String(original.planDigest) });
      } catch { throw new MaintenanceFailure("drain_incomplete"); }
      if (!current && receipt.drainEpoch >= observation.state.fenceEpoch) return unknownWriter();
      for (const exit of receipt.ownedExits) {
        if (!exit.fence.bindingId || !exit.fence.memberId) return unknownWriter();
        const inspected = await inspectOwnedProcess(exit.processIdentity);
        if (inspected.status === "unknown") return unknownWriter();
        if (inspected.status !== "wrapper_exited") throw new MaintenanceFailure("drain_incomplete");
        if (audit) ownedExits.push({ fence: exit.fence, processIdentity: exit.processIdentity,
          inspection: inspected as (typeof ownedExits)[number]["inspection"] });
      }
    }
    if (!receipt && (process.status !== "exited" || row.ended_at === null || row.drain_state !== "none")) return unknownWriter();
    result.push({ clientId: String(row.client_id), classification: current ? "current-client" : "historical-client", receipt, process });
    if (audit) {
      const raw = observation.rows[index]!;
      audit.push({ kind: row.build_id === "boardroom-native-management-v1" ? "native-management-client" : "ordinary-client",
        subject: [...raw.client_id], rowDigest: digestJson({ formatVersion: 1, kind: "source-client-row", source: observation.source,
          textEncoding: observation.textEncoding, row: raw }),
        host: host as EventFacts["actor"]["host"], process: processIdentity as EventFacts["actor"]["process"], processCheck: inspectedProcess.check,
        classification: current ? "current-client" : "historical-client",
        receipt: receipt ? { digest: String(row.drain_receipt_digest), kind: current ? "current" : "historical", ownedExits } : null });
    }
  }
  return result;
}

export interface SourceRuntimeRows {
  readonly runners: readonly Record<string, unknown>[];
  readonly owners: readonly Record<string, unknown>[];
}
export async function sourceRuntimeFacts(snapshot: SourceRuntimeRows, clients: readonly SourceClientFact[],
  audit?: EventFacts["runtime"]): Promise<SourceRuntimeFact[]> {
  const rows = snapshot.runners, owners = new Map<string, Record<string, unknown>>();
  for (const row of snapshot.owners) {
    if (typeof row.member_id !== "string" || !row.member_id || owners.has(row.member_id)) return unknownWriter();
    counter(row.generation);
    if (row.binding_id === null) {
      if (row.lease_owner !== null || row.lease_expires_at !== null) return unknownWriter();
    } else {
      if (typeof row.binding_id !== "string" || !row.binding_id || typeof row.lease_owner !== "string" || !row.lease_owner
        || typeof row.lease_expires_at !== "string" || !Number.isFinite(Date.parse(row.lease_expires_at))) return unknownWriter();
      const runner = rows.find(value => value.binding_id === row.binding_id && value.member_id === row.member_id);
      if (!runner || counter(runner.generation) !== counter(row.generation) || runner.lease_owner !== row.lease_owner) return unknownWriter();
    }
    owners.set(row.member_id, row);
    if (audit) audit.owners.push({ memberId: row.member_id, bindingId: row.binding_id as string | null,
      generation: counter(row.generation), leaseOwner: row.lease_owner as string | null, leaseExpiresAt: row.lease_expires_at as string | null });
  }
  const result: SourceRuntimeFact[] = [], seen = new Set<string>();
  for (const row of rows) {
    if (typeof row.binding_id !== "string" || !row.binding_id || seen.has(row.binding_id) || typeof row.member_id !== "string" || !row.member_id
      || ![0, 1, "0", "1"].includes(row.exit_confirmed as never)) return unknownWriter();
    seen.add(row.binding_id); const generation = counter(row.generation), owner = owners.get(row.member_id);
    if (!owner || counter(owner.generation) < generation || row.lease_owner !== null &&
      (owner.binding_id !== row.binding_id || owner.lease_owner !== row.lease_owner || counter(owner.generation) !== generation)) return unknownWriter();
    if (generation === 0 && (row.lease_owner !== null || row.process_identity_json !== null || counter(row.exit_confirmed) !== 1)) return unknownWriter();
    const exits = clients.flatMap(client => client.receipt?.ownedExits ?? []).filter(exit => exit.fence.bindingId === row.binding_id
      && exit.fence.memberId === row.member_id && exit.fence.generation === generation);
    let processIdentity: EventFacts["runtime"]["runners"][number]["processIdentity"] = null;
    let inspection: EventFacts["runtime"]["runners"][number]["inspection"] = null;
    if (row.process_identity_json !== null) {
      const identity = json(row.process_identity_json) as unknown as OwnedProcessIdentity;
      if (!exactKeys(factsObject(identity), ["version", "launcherProtocol", "pid", "kernelBootId", "pidNamespace", "startTicks"])) return unknownWriter();
      if (exits.some(exit => canonicalJson(exit.processIdentity) !== canonicalJson(identity)
        || row.lease_owner !== null && exit.fence.owner !== row.lease_owner)) return unknownWriter();
      const inspected = await inspectOwnedProcess(identity);
      if (inspected.status === "unknown") return unknownWriter();
      if (inspected.status !== "wrapper_exited") throw new MaintenanceFailure("source_writer_active");
      processIdentity = identity; inspection = inspected as NonNullable<EventFacts["runtime"]["runners"][number]["inspection"]>;
    } else {
      if (row.lease_owner !== null || counter(row.exit_confirmed) !== 1) return unknownWriter();
      if (generation !== 0 && exits.length === 0) return unknownWriter();
    }
    result.push({ bindingId: row.binding_id, memberId: row.member_id, generation, status: generation === 0 ? "not-owned" : "exited" });
    if (audit) audit.runners.push({ bindingId: row.binding_id, memberId: row.member_id, generation,
      leaseOwner: row.lease_owner as string | null, exitConfirmed: Number(row.exit_confirmed) as 0 | 1, processIdentity, inspection });
  }
  // Current receipts must bind their current actual runner; historical receipts retain their old fences.
  for (const client of clients) if (client.classification === "current-client") for (const exit of client.receipt?.ownedExits ?? []) {
    if (!result.some(row => row.bindingId === exit.fence.bindingId && row.memberId === exit.fence.memberId && row.generation === exit.fence.generation))
      return unknownWriter();
  }
  result.sort((a, b) => a.bindingId < b.bindingId ? -1 : a.bindingId > b.bindingId ? 1 : 0);
  if (audit) {
    audit.runners.sort((a, b) => a.bindingId < b.bindingId ? -1 : a.bindingId > b.bindingId ? 1 : 0);
    audit.owners.sort((a, b) => a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0);
    audit.results.push(...result);
  }
  return result;
}

import { randomUUID } from "node:crypto";
import { readFile, readlink } from "node:fs/promises";
import { hostname } from "node:os";
import { canonicalJson, digestJson } from "./canonical.ts";
import { darwinCurrentProcessIdentity } from "./darwin.ts";
import { inspectRegisteredSourceProcess } from "./source-facts.ts";
import { registeredProcess, type EventFacts } from "./control-candidate/schema.ts";
import { applyChanges, encodeText, supportedEncoding, validateRowsFacts, type RowContext } from "./control-candidate/rows.ts";
import { rowsDigest } from "./control-candidate/replay-core.ts";
import { MaintenanceFailure } from "./error.ts";
import { parseJournal } from "./parse.ts";
import type { ArtifactRef, JournalRecord, SourceClientFactsWindow, SourceClientRawRow, SourceClientsObservation } from "./types.ts";

/** Historical data only. It cannot be supplied to an adapter to claim ownership. */
export interface SourceClientAudit {
  readonly kind: "untrusted-source-client-audit";
  readonly observation: SourceClientsObservation;
  readonly origin: SourceClientFactsWindow["origin"];
  readonly facts: EventFacts;
}
/** Adapter-only destination for values from the original native inspection calls. */
export interface SessionAuditCollection {
  readonly actor: EventFacts["actor"];
  readonly observation: SourceClientsObservation;
  value?: EventFacts["sessions"];
}

/** Only the original source-facts reader supplies this to its private native lease. */
export interface ControllerReadback {
  readonly observation: SourceClientsObservation;
  readonly origin: SourceClientFactsWindow["origin"];
}
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
function frozen<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) frozen(item);
    Object.freeze(value);
  }
  return value;
}
interface StagedRegistration {
  readonly lock: object;
  readonly audit: SourceClientAudit;
  readonly row: SourceClientRawRow;
  readonly assertHeld: () => Promise<void>;
  candidate?: { readonly reference: ArtifactRef; readonly record: JournalRecord };
  commitReturned: boolean;
  sourceClosed: boolean;
}
interface AuditedScope {
  readonly audit: SourceClientAudit;
  readonly active: () => boolean;
  readonly assertHeld: () => Promise<void>;
}
const originalLeases = new WeakMap<BootstrapAuditLease, object>();
/** Identity check only. Actual adapter ownership still comes from its own private factory table. */
export function assertOriginalControllerLease(lease: BootstrapAuditLease, lock: object): void {
  if (originalLeases.get(lease) !== lock) throw new MaintenanceFailure("maintenance_lost");
}

async function currentIdentity(instanceId: string) {
  if (process.platform === "darwin") return registeredProcess.parse({ ...darwinCurrentProcessIdentity(), instanceId });
  if (process.platform !== "linux") throw new MaintenanceFailure("source_writer_unknown", "audit-actor");
  const kernelBootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  const pidNamespace = await readlink("/proc/self/ns/pid");
  const text = await readFile("/proc/self/stat", "utf8"), end = text.lastIndexOf(") ");
  if (Number(/^([1-9][0-9]*) \(/.exec(text)?.[1]) !== process.pid || end < 0 || text.length > 8192)
    throw new MaintenanceFailure("source_writer_unknown", "audit-actor");
  return registeredProcess.parse({ version: 1, platform: "linux", pid: process.pid, instanceId,
    verification: "linux_proc_identity_v1", kernelBootId, pidNamespace, startTicks: text.slice(end + 2).trim().split(/\s+/)[19] });
}

/** An exported constructor is not a capability. Adapters retain their one original
 * factory in a private WeakMap and never accept a caller's factory or lease. */
export class BootstrapAuditFactory {
  readonly #adapter: object;
  readonly #mutex: object;
  readonly #actorId = randomUUID();
  #identity?: ReturnType<typeof currentIdentity>;
  #host?: EventFacts["actor"]["host"];
  #closed = false;
  readonly #audits = new WeakMap<object, AuditedScope>();
  readonly #bound = new WeakMap<object, BootstrapAuditLease>();
  #staged: StagedRegistration | undefined;
  #registered: StagedRegistration | undefined;
  constructor(adapter: object, mutex: object) { this.#adapter = adapter; this.#mutex = mutex; }
  close(): void { this.#closed = true; }
  #lost(): never { this.close(); throw new MaintenanceFailure("maintenance_lost"); }
  #owner(adapter: object, mutex: object): void {
    if (adapter !== this.#adapter || mutex !== this.#mutex || this.#closed) this.#lost();
  }
  #readback(current: ControllerReadback, registered: StagedRegistration, promotion: boolean): void {
    const { observation, origin } = current, candidate = registered.candidate, state = observation.state;
    if (!candidate || !same(observation.source, registered.audit.observation.source)
      || !same(observation.sourceIdentity, registered.audit.observation.sourceIdentity)
      || !same(observation.textEncoding, registered.audit.observation.textEncoding)
      || !same(origin.capture, registered.audit.origin.capture) || origin.receiptGeneration !== registered.audit.origin.receiptGeneration
      || state.admission !== "sealed" || state.fenceEpoch !== registered.audit.observation.state.fenceEpoch
      || state.activeMigrationId !== registered.audit.observation.state.activeMigrationId
      || state.planDigest !== registered.audit.observation.state.planDigest
      || state.controlRootJson !== registered.audit.observation.state.controlRootJson
      || state.mutexIdentityJson !== registered.audit.observation.state.mutexIdentityJson
      || state.journalRecordRef !== origin.head.ref || state.journalDigest !== origin.head.sha256
      || !origin.chain.nodes.some(node => same(node.reference, candidate.reference) && same(node.record, candidate.record))) this.#lost();
    const head = origin.chain.nodes.at(-1);
    if (!head || !same(head.reference, origin.head) || state.journalSequence !== head.record.sequence
      || state.ownerGeneration !== head.record.ownerGeneration || head.record.event === "cancelled"
      || promotion && !same(origin.head, candidate.reference)) this.#lost();
    const row = observation.rows.find(item => same(item.client_id, registered.row.client_id));
    if (!row || row.ended_at[0] !== "null") this.#lost();
    for (const name of Object.keys(registered.row) as (keyof SourceClientRawRow)[]) {
      if (name !== "last_observed_at" && !same(row[name], registered.row[name])) this.#lost();
    }
    if (promotion && !same(row, registered.row)) this.#lost();
  }

  /** Called inside the original producer callback; there is no caller row/actor input. */
  async stageRegistration(adapter: object, mutex: object, lock: object): Promise<SourceClientRawRow> {
    this.#owner(adapter, mutex);
    const scope = this.#audits.get(lock);
    if (this.#staged || this.#registered || !scope?.active()) this.#lost();
    try {
      await scope.assertHeld();
      const audit = scope.audit, { observation, origin, facts } = audit, state = observation.state;
      const head = origin.chain.nodes.at(-1);
      if (facts.actor.actorId !== this.#actorId || facts.actor.clientId !== null || !origin.capture || !head || head.record.formatVersion !== 3
        || !same(head.reference, origin.head) || state.admission !== "sealed"
        || state.ownerGeneration >= Number.MAX_SAFE_INTEGER || state.journalSequence >= Number.MAX_SAFE_INTEGER
        || state.journalRecordRef !== origin.head.ref || state.journalDigest !== origin.head.sha256
        || head.record.sequence !== state.journalSequence || head.record.fenceEpoch !== state.fenceEpoch
        || head.record.ownerGeneration !== state.ownerGeneration || head.record.event === "cancelled") this.#lost();
      if (!supportedEncoding(observation.textEncoding)) throw new MaintenanceFailure("source_changed", "v3-source-clients-encoding-unverified");
      const text = (value: string) => {
        const cell = encodeText(value, observation.textEncoding);
        if (!cell) throw new MaintenanceFailure("source_changed", "v3-source-clients-encoding-unverified");
        return cell;
      };
      const body = { formatVersion: 1, kind: "maintenance-controller-registration", source: observation.source,
        sourceIdentityDigest: observation.source.identityDigest,
        creation: { migrationId: head.record.migrationId, plan: head.record.plan, fenceEpoch: String(state.fenceEpoch),
          ownerGeneration: String(state.ownerGeneration + 1), previousAnchor: origin.head, targetSequence: String(state.journalSequence + 1) },
        sessionBinding: "per-source-lock-native-inventory-v1", drainReceipt: null };
      const row: SourceClientRawRow = frozen({ client_id: text(randomUUID()), database_instance_id: text(observation.source.databaseInstanceId),
        entrypoint: text("maintenance-controller"), build_id: text("boardroom-maintenance-control-v1"), protocol_version: ["integer", "1"],
        host_identity_json: text(canonicalJson(facts.actor.host)), process_identity_json: text(canonicalJson(facts.actor.process)),
        db_sessions_json: text(canonicalJson(body)), registered_epoch: ["integer", String(state.fenceEpoch)],
        observed_epoch: ["integer", String(state.fenceEpoch)], drain_epoch: ["null"], drain_state: text("none"),
        drain_receipt_digest: ["null"], registered_at: text(facts.observedAt), last_observed_at: text(facts.observedAt), ended_at: ["null"] });
      if (observation.rows.some(item => same(item.client_id, row.client_id))) this.#lost();
      this.#staged = { lock, audit, row, assertHeld: scope.assertHeld, commitReturned: false, sourceClosed: false };
      return row;
    } catch (error) { this.close(); throw error; }
  }

  /** Bind the exact durable journal before its actual SQL attempt. Data alone cannot
   * perform SQL or promote identity; I03 calls this only on the adapter's owner. */
  async stageControlCandidate(adapter: object, mutex: object, lock: object, reference: ArtifactRef, input: JournalRecord): Promise<void> {
    this.#owner(adapter, mutex);
    const staged = this.#staged;
    if (!staged || staged.lock !== lock || staged.candidate || staged.commitReturned || staged.sourceClosed) this.#lost();
    try {
      await staged.assertHeld();
      const record = parseJournal(input), proof = record.formatVersion === 3 ? record.controlProof : null;
      const { observation, origin, facts } = staged.audit, state = observation.state;
      if (record.formatVersion !== 3 || record.event !== "takeover" || record.phase !== origin.chain.nodes.at(-1)!.record.phase
        || !proof || proof.kind !== "control-successor") this.#lost();
      const registrationChanges = proof.changes.filter(change => change.kind === "maintenance-registration");
      const captured = origin.chain.nodes.find(node => same(node.reference, origin.capture));
      const roster = captured && captured.record.formatVersion !== 1 ? captured.record.sourceClients : null;
      if (!roster || registrationChanges.length !== 1 || !same(registrationChanges[0]!.after, staged.row) || registrationChanges[0]!.actorId !== this.#actorId
        || !same(proof.facts, facts) || !same(record.source, observation.source) || !same(record.plan, origin.chain.nodes[0]!.record.plan)
        || record.migrationId !== state.activeMigrationId || record.fenceEpoch !== state.fenceEpoch
        || record.ownerGeneration !== state.ownerGeneration + 1 || record.sequence !== state.journalSequence + 1
        || !same(record.previous, origin.head) || !same(proof.previousAnchor, origin.head) || !same(proof.originCapture, origin.capture)
        || !same(proof.source, record.source) || !same(proof.plan, record.plan) || proof.migrationId !== record.migrationId
        || proof.fenceEpoch !== String(state.fenceEpoch) || proof.fromGeneration !== String(state.ownerGeneration)
        || proof.toGeneration !== String(record.ownerGeneration) || proof.targetSequence !== String(record.sequence)
        || proof.originSourceClientsDigest !== digestJson(roster) || proof.beforeRowsDigest !== rowsDigest(observation.source, observation.textEncoding, observation.rows)
        || proof.receiptGeneration !== String(origin.receiptGeneration) || !same(proof.textEncoding, observation.textEncoding)
        || digestJson(record) !== reference.sha256 || String(Buffer.byteLength(canonicalJson(record))) !== reference.bytes
        || reference.ref !== `journals/${record.migrationId}/${record.sequence}-${reference.sha256}.json`) this.#lost();
      const registrations: RowContext["registrations"] = new Map();
      for (const node of origin.chain.nodes) {
        const prior = node.record.formatVersion === 3 ? node.record.controlProof : null;
        if (!prior || prior.kind === "capture-controls" || prior.kind === "cancel-terminal-controls") continue;
        for (const change of prior.changes) if (change.kind === "maintenance-registration") registrations.set(change.after.client_id[1], {
          actorId: change.actorId, creation: { migrationId: node.record.migrationId, plan: { ...node.record.plan },
            fenceEpoch: String(node.record.fenceEpoch), ownerGeneration: String(node.record.ownerGeneration),
            previousAnchor: { ...prior.previousAnchor }, targetSequence: String(node.record.sequence) } });
      }
      const context: RowContext = { plan: origin.chain.plan, record, fenceEpoch: state.fenceEpoch, encoding: observation.textEncoding,
        receiptGeneration: String(origin.receiptGeneration), registrations, unresolvedEncoding: new Set() };
      validateRowsFacts(observation.rows, facts, context);
      const after = applyChanges(observation.rows, proof, context);
      if (context.unresolvedEncoding.size || proof.afterRowsDigest !== rowsDigest(observation.source, observation.textEncoding, after)) this.#lost();
      staged.candidate = frozen({ reference: { ...reference }, record });
    } catch (error) { this.close(); throw error; }
  }

  /** Event from the actual COMMIT-return path, never a caller-supplied success flag. */
  noteCommitReturned(adapter: object, mutex: object, lock: object): void {
    this.#owner(adapter, mutex);
    const staged = this.#staged;
    if (!staged?.candidate || staged.lock !== lock || staged.commitReturned || staged.sourceClosed) this.#lost();
    staged.commitReturned = true;
  }
  /** Event after original source handle cleanup; a facts lease close cannot call it. */
  noteSourceClosed(adapter: object, mutex: object, lock: object): void {
    this.#owner(adapter, mutex);
    const staged = this.#staged;
    if (!staged?.candidate || staged.lock !== lock || !staged.commitReturned || staged.sourceClosed) this.#lost();
    staged.sourceClosed = true;
  }

  bind(adapter: object, mutex: object, lock: object, assertHeld: () => Promise<void>): BootstrapAuditLease {
    if (adapter !== this.#adapter || mutex !== this.#mutex || this.#closed) throw new MaintenanceFailure("maintenance_lost");
    if (this.#bound.has(lock)) this.#lost();
    let active = true;
    const owner = this;
    const lease: BootstrapAuditLease = {
      async observe(actualLock: object, current?: ControllerReadback) {
        if (this !== lease || !active || owner.#closed || actualLock !== lock) throw new MaintenanceFailure("maintenance_lost");
        try { await assertHeld(); } catch (error) { owner.close(); throw error; }
        try {
          const identity = await (owner.#identity ??= currentIdentity(owner.#actorId));
          const host = owner.#host ??= { version: 1 as const, hostname: hostname(), platform: identity.platform };
          const inspection = await inspectRegisteredSourceProcess(host, identity);
          if (inspection.fact.status !== "present") throw new MaintenanceFailure("source_writer_unknown", "audit-actor");
          if (owner.#staged?.lock === lock && (owner.#staged.commitReturned || owner.#staged.sourceClosed)) owner.#lost();
          if (owner.#staged && owner.#staged.lock !== lock) {
            const staged = owner.#staged;
            if (!staged.commitReturned || !staged.sourceClosed || !current) return owner.#lost();
            owner.#readback(current, staged, true);
            owner.#registered = staged; owner.#staged = undefined;
          }
          if (owner.#registered) {
            if (!current) return owner.#lost();
            owner.#readback(current, owner.#registered, false);
          }
          try { await assertHeld(); } catch (error) { owner.close(); throw error; }
          const actor: EventFacts["actor"] = { actorId: owner.#actorId,
            clientId: owner.#registered ? [...owner.#registered.row.client_id] : null, host, process: identity, processCheck: inspection.check };
          return frozen(actor);
        } catch (error) {
          if (owner.#staged || owner.#registered) owner.close();
          if (error instanceof MaintenanceFailure) throw error;
          throw new MaintenanceFailure("source_writer_unknown", "audit-actor");
        }
      },
      recordAudit(actualLock: object, audit: SourceClientAudit) {
        if (this !== lease || !active || owner.#closed || actualLock !== lock || audit.facts.actor.actorId !== owner.#actorId) owner.#lost();
        owner.#audits.set(lock, { audit, active: () => active, assertHeld });
      },
      close() {
        if (this !== lease) owner.#lost();
        active = false; owner.#audits.delete(lock); owner.#bound.delete(lock); originalLeases.delete(lease);
      },
      noteWindowFailure() {
        if (this !== lease) owner.#lost();
        if (owner.#staged || owner.#registered) owner.close();
      },
      invalidate() { if (this !== lease) owner.#lost(); owner.close(); },
    };
    originalLeases.set(lease, lock); this.#bound.set(lock, lease);
    return Object.freeze(lease);
  }
}
export interface BootstrapAuditLease {
  observe(actualLock: object, current?: ControllerReadback): Promise<EventFacts["actor"]>;
  recordAudit(actualLock: object, audit: SourceClientAudit): void;
  noteWindowFailure(): void;
  close(): void;
  invalidate(): void;
}

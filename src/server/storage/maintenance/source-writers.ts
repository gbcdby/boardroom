import { canonicalJson, digestJson } from "./canonical.ts";
import { checkFactsShape, eventFactsSchema, type EventFacts } from "./control-candidate/schema.ts";
import { applyControlNode, type ControlReplayState } from "./control-candidate/replay-core.ts";
import { invariantFromManifests } from "./control-candidate/closure.ts";
import { bindSourceClientManifestRows, supportedEncoding, validateRowsFacts } from "./control-candidate/rows.ts";
import { assertOriginalControllerLease, type BootstrapAuditLease, type SessionAuditCollection, type SourceClientAudit } from "./native-audit.ts";
import { MaintenanceFailure } from "./error.ts";
import { ArtifactStore } from "./objects.ts";
import { loadPersistedPlan } from "./plan.ts";
import { parseManifests } from "./parse.ts";
import { verifyJournalChain } from "./journal.ts";
import { sourceClientFacts, sourceRuntimeFacts, type SourceRuntimeRows } from "./source-facts.ts";
import { withSourceFileObservationWindow } from "./source-file-writers.ts";
import type { Blocker, ControlRootIdentity, FileRoot, Json, PersistedPlanRef, SourceClientFactsWindow, SourceClientsObservation } from "./types.ts";

const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
/** Adapter-only assembly. No request or service accepts these native capabilities from a caller. */
export interface SourceFactsAccess {
  readonly root: ControlRootIdentity;
  readonly mutexIdentity: Json;
  assertUnchangedLock(): Promise<void>;
  observe(): Promise<SourceClientsObservation>;
  decodedRows(observation: SourceClientsObservation): Promise<readonly Record<string, unknown>[]>;
  validateSource(value: unknown, observation: SourceClientsObservation): void;
  inspectWriters(observation: SourceClientsObservation, rows: readonly Record<string, unknown>[], roots: readonly FileRoot[],
    audit?: SessionAuditCollection): Promise<readonly Blocker[]>;
  runtimeRows(): Promise<SourceRuntimeRows>;
}

interface NativeFactsScope { readonly lease: BootstrapAuditLease; readonly lock: object }
async function withFacts<T>(access: SourceFactsAccess, input: PersistedPlanRef,
  consume: (window: SourceClientFactsWindow, audit: SourceClientAudit | undefined) => Promise<T>,
  native: NativeFactsScope | undefined, purpose: "consumer" | "producer" | "cancellation"): Promise<T> {
  if (native) assertOriginalControllerLease(native.lease, native.lock);
  return withSourceFileObservationWindow(() => access.assertUnchangedLock(),
    () => collectFacts(access, input, consume, native, purpose), { lock: native?.lock ?? access, root: access.root });
}
async function collectFacts<T>(access: SourceFactsAccess, input: PersistedPlanRef,
  consume: (window: SourceClientFactsWindow, audit: SourceClientAudit | undefined) => Promise<T>,
  native: NativeFactsScope | undefined, purpose: "consumer" | "producer" | "cancellation"): Promise<T> {
  if (native) assertOriginalControllerLease(native.lease, native.lock);
  const reference = freeze({ ...input, immutablePlan: { ...input.immutablePlan } });
  let active = true;
  let strictControl = false;
  const assertActive = async () => {
    if (!active) throw new MaintenanceFailure("maintenance_lost");
    await access.assertUnchangedLock();
  };
  const collect = async () => {
    await assertActive();
    const observation = await access.observe(), state = observation.state;
    if (state.admission === "open") throw new MaintenanceFailure("phase_conflict");
    if (state.controlRootJson !== canonicalJson(access.root) || state.mutexIdentityJson !== canonicalJson(access.mutexIdentity)
      || reference.controlRoot !== access.root.path) throw new MaintenanceFailure("control_root_mismatch");
    let plan;
    try { plan = await loadPersistedPlan(reference, observation.source); }
    catch (error) {
      if (error instanceof MaintenanceFailure && error.code === "control_root_mismatch") throw error;
      throw new MaintenanceFailure("plan_stale");
    }
    if (!same(plan.sourceIdentity, observation.sourceIdentity) || plan.schemaManifestDigest !== observation.schemaManifestDigest
      || plan.guardManifestDigest !== state.guardManifestDigest || state.activeMigrationId !== plan.migrationId
      || state.planDigest !== reference.planDigest) throw new MaintenanceFailure("plan_stale");
    const configs = plan.fileRoots.filter(root => root.label === "config");
    if (configs.length !== (plan.originalConfigPath === null ? 0 : 1)
      || configs.some(root => root.path !== plan.originalConfigPath)) throw new MaintenanceFailure("plan_stale");
    if (!state.journalRecordRef || !state.journalDigest || state.journalSequence < 1) throw new MaintenanceFailure("journal_invalid");
    const store = await ArtifactStore.open(reference.controlRoot, observation.source);
    let head, chain;
    try {
      head = await store.readAnchoredJournal({ ref: state.journalRecordRef, sha256: state.journalDigest });
      chain = await verifyJournalChain(store, head);
    } catch (error) {
      if (error instanceof MaintenanceFailure && error.code === "control_root_mismatch") throw error;
      throw new MaintenanceFailure("journal_invalid");
    }
    const last = chain.nodes.at(-1)!.record;
    strictControl ||= last.formatVersion === 3;
    if (!same(chain.plan, plan) || !same(last.source, observation.source) || !same(last.plan, reference.immutablePlan)
      || last.migrationId !== state.activeMigrationId || last.sequence !== state.journalSequence
      || last.fenceEpoch !== state.fenceEpoch || last.ownerGeneration !== state.ownerGeneration
      || last.event === "cancelled"
      || purpose !== "cancellation" && chain.nodes.some(node => node.record.event === "cancel_intent"))
      throw new MaintenanceFailure("journal_invalid");
    const firstIndex = chain.nodes.findIndex(node => node.record.event === "capture");
    const first = chain.nodes[firstIndex];
    // The general reader accepts legacy planned takeovers; they cannot establish receipt provenance here.
    const beforeCapture = firstIndex < 0 ? chain.nodes : chain.nodes.slice(0, firstIndex);
    if (beforeCapture.some(node => node.record.event === "takeover")) throw new MaintenanceFailure("journal_invalid");
    let receiptGeneration = state.ownerGeneration;
    let replay: ControlReplayState | undefined;
    if (!first) {
      if (state.admission !== "draining" || last.phase !== "planned") throw new MaintenanceFailure("journal_invalid");
      if (purpose === "cancellation") throw new MaintenanceFailure("phase_conflict");
    } else {
      if (state.admission !== "sealed" || first.record.formatVersion === 1 || first.record.sourceClients === null)
        throw new MaintenanceFailure("journal_invalid");
      const roster = first.record.sourceClients;
      receiptGeneration = Number(roster.receiptGeneration);
      if (!same(roster.textEncoding, observation.textEncoding)) throw new MaintenanceFailure("source_changed");
      if (last.formatVersion === 3) {
        // Reconstruct all O→H changes, including those before a later selected capture.
        // A successful pure replay remains data; native checks below bind the actual lock.
        if (!supportedEncoding(observation.textEncoding)) throw new MaintenanceFailure("source_changed", "v3-source-clients-encoding-unverified");
        replay = { rows: roster.rows, invariant: null, registrations: new Map(), unresolvedEncoding: new Set() };
        try {
          for (let index = firstIndex; index < chain.nodes.length; index++) {
            const node = chain.nodes[index]!, record = node.record;
            if (record.formatVersion !== 3) continue;
            if (record.controlProof?.kind === "legacy-first-capture-bridge") {
              const manifests = parseManifests(await store.readJson(record.controlProof.legacy.manifests, "database-manifests"));
              replay.invariant = invariantFromManifests(manifests, first, access.root, access.mutexIdentity);
              bindSourceClientManifestRows(manifests, roster.rows, roster.textEncoding);
            }
            applyControlNode(plan, node, chain.nodes[index - 1], first, roster,
              { controlRoot: access.root, mutexIdentity: access.mutexIdentity }, replay);
          }
        } catch { throw new MaintenanceFailure("journal_invalid"); }
        if (!replay.invariant || replay.unresolvedEncoding.size) throw new MaintenanceFailure("source_changed", "v3-source-clients-encoding-unverified");
        const invariant = replay.invariant;
        if (state.databaseInstanceId !== invariant.databaseInstanceId || state.fenceEpoch !== Number(invariant.fenceEpoch)
          || state.activeMigrationId !== invariant.activeMigrationId || state.planDigest !== invariant.planDigest
          || state.guardManifestDigest !== invariant.guardManifestDigest || state.controlRootJson !== invariant.controlRootJson
          || state.mutexIdentityJson !== invariant.mutexIdentityJson)
          throw new MaintenanceFailure("source_changed");
      }
      if (!same(replay?.rows ?? roster.rows, observation.rows)) throw new MaintenanceFailure("source_changed");
    }
    const origin: SourceClientFactsWindow["origin"] = { kind: first ? "captured-generation" : "current-generation",
      head, capture: first?.reference ?? null, receiptGeneration, chain };
    const actor = native ? await native.lease.observe(native.lock, { observation, origin }) : undefined;
    const observedAt = actor ? new Date().toISOString() : undefined;
    const clientAudit: EventFacts["clients"] | undefined = actor ? [] : undefined;
    const runtimeAudit: EventFacts["runtime"] | undefined = actor ? { runners: [], owners: [], results: [] } : undefined;
    const sessionAudit: SessionAuditCollection | undefined = actor ? { actor, observation } : undefined;
    const rows = await access.decodedRows(observation);
    const clients = await sourceClientFacts(observation, rows, receiptGeneration, access.validateSource, clientAudit,
      actor && (!first || replay) ? { actor, head: last, originRows: first && first.record.formatVersion !== 1 ? first.record.sourceClients!.rows : null,
        registrations: replay?.registrations ?? new Map(), purpose: purpose === "consumer" ? "consumer" : "producer" } : undefined);
    const runtimeRows = await access.runtimeRows();
    const runtime = await sourceRuntimeFacts(runtimeRows, clients, runtimeAudit);
    const blockers = await access.inspectWriters(observation, rows, plan.fileRoots, sessionAudit);
    if (blockers.length) throw new MaintenanceFailure(blockers[0]!.code, blockers[0]!.subjectRef);
    await assertActive();
    const after = await access.observe();
    if (!same(observation, after)) throw new MaintenanceFailure("source_changed");
    let nativeAudit: EventFacts | undefined;
    if (actor) {
      clientAudit!.sort((a, b) => a.subject[1] < b.subject[1] ? -1 : a.subject[1] > b.subject[1] ? 1 : 0);
      const parsed = eventFactsSchema.safeParse({ formatVersion: 1, kind: "source-control-event-facts",
        collector: "boardroom-source-control-facts-v1", observedAt, actor, beforeCount: String(observation.rows.length),
        beforeRowsDigest: digestJson({ formatVersion: 1, kind: "source-clients-live-rows", source: observation.source,
          textEncoding: observation.textEncoding, rows: observation.rows }),
        clients: clientAudit, runtime: runtimeAudit, sessions: sessionAudit?.value });
      if (!parsed.success) throw new MaintenanceFailure("source_writer_unknown", "source-client-audit");
      try { checkFactsShape(parsed.data, observation.source); }
      catch { throw new MaintenanceFailure("source_writer_unknown", "source-client-audit"); }
      if (replay) {
        try { validateRowsFacts(observation.rows, parsed.data, { plan, record: last, fenceEpoch: state.fenceEpoch,
          encoding: observation.textEncoding, receiptGeneration: String(receiptGeneration),
          registrations: replay.registrations, unresolvedEncoding: replay.unresolvedEncoding }); }
        catch { throw new MaintenanceFailure("source_writer_unknown", "source-client-audit"); }
      }
      nativeAudit = parsed.data;
    }
    const audit = nativeAudit ? freeze({ kind: "untrusted-source-client-audit" as const, observation, origin, facts: nativeAudit }) : undefined;
    return freeze({ observation, origin, audit, clients, runtime,
      scope: ["source-client-roster", "exact-db-anchor", "registered-processes", "database-sessions", "runtime-owners", "adapter-writer-inventory"] });
  };
  try {
    const facts = await collect();
    // Refreshes prove this same scope is still current; they do not silently
    // replace the event facts from which the callback constructs its candidate.
    if (facts.audit && native && purpose !== "consumer") native.lease.recordAudit(native.lock, facts.audit);
    const window: SourceClientFactsWindow = freeze({ ...facts, async assertCurrent() {
      const current = await collect();
      if (!same(current.observation, facts.observation) || !same(current.origin, facts.origin)) throw new MaintenanceFailure("source_changed");
    } });
    const result = await consume(window, facts.audit);
    await window.assertCurrent();
    return result;
  } catch (error) {
    native?.lease.noteWindowFailure();
    if (native && (strictControl || error instanceof MaintenanceFailure && error.code === "maintenance_lost")) native.lease.invalidate();
    throw error;
  } finally { active = false; }
}

/** Fixed final-consumer window. An exited current controller must already have an
 * anchored end and be absent now; producer-only pending observations are rejected. */
export async function withSourceClientFacts<T>(access: SourceFactsAccess, plan: PersistedPlanRef,
  consume: (window: SourceClientFactsWindow) => Promise<T>, native?: NativeFactsScope): Promise<T> {
  try { return await withFacts(access, plan, window => consume(window), native, "consumer"); }
  finally { native?.lease.close(); }
}

/** Adapter-only producer scope. It cannot be selected through a request mode or bool. */
export async function withControllerSourceClientFacts<T>(access: SourceFactsAccess, plan: PersistedPlanRef,
  lease: BootstrapAuditLease, lock: object, consume: (audit: SourceClientAudit, window: SourceClientFactsWindow) => Promise<T>): Promise<T> {
  try { return await withFacts(access, plan, (window, audit) => {
    if (!audit) throw new MaintenanceFailure("source_writer_unknown", "source-client-audit");
    return consume(audit, window);
  }, { lease, lock }, "producer"); }
  finally { lease.close(); }
}

/** Cancellation is a separate fixed path; normal advance/V windows never accept a
 * pending cancel_intent prefix. It has the same actual producer/native obligations. */
export async function withCancellationSourceClientFacts<T>(access: SourceFactsAccess, plan: PersistedPlanRef,
  lease: BootstrapAuditLease, lock: object, consume: (audit: SourceClientAudit, window: SourceClientFactsWindow) => Promise<T>): Promise<T> {
  try { return await withFacts(access, plan, (window, audit) => {
    if (!audit) throw new MaintenanceFailure("source_writer_unknown", "source-client-audit");
    return consume(audit, window);
  }, { lease, lock }, "cancellation"); }
  finally { lease.close(); }
}

/** No data escapes this entry until the original final fresh/close checks finish. */
export async function readSourceClientAudit(access: SourceFactsAccess, plan: PersistedPlanRef,
  lease: BootstrapAuditLease, lock: object): Promise<SourceClientAudit> {
  try {
    return await withControllerSourceClientFacts(access, plan, lease, lock, async audit => audit);
  } catch (error) {
    if (error instanceof MaintenanceFailure && error.code === "maintenance_lost") lease.invalidate();
    throw error;
  } finally { lease.close(); }
}

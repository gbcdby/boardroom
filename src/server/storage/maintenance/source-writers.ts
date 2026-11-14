import { canonicalJson } from "./canonical.ts";
import { MaintenanceFailure } from "./error.ts";
import { ArtifactStore } from "./objects.ts";
import { loadPersistedPlan } from "./plan.ts";
import { verifyJournalChain } from "./journal.ts";
import { sourceClientFacts, sourceRuntimeFacts, type SourceRuntimeRows } from "./source-facts.ts";
import type { Blocker, ControlRootIdentity, Json, PersistedPlanRef, SourceClientFactsWindow, SourceClientsObservation } from "./types.ts";

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
  inspectWriters(observation: SourceClientsObservation, rows: readonly Record<string, unknown>[]): Promise<readonly Blocker[]>;
  runtimeRows(): Promise<SourceRuntimeRows>;
}

export async function withSourceClientFacts<T>(access: SourceFactsAccess, input: PersistedPlanRef,
  consume: (window: SourceClientFactsWindow) => Promise<T>): Promise<T> {
  const reference = freeze({ ...input, immutablePlan: { ...input.immutablePlan } });
  let active = true;
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
    if (!same(chain.plan, plan) || !same(last.source, observation.source) || !same(last.plan, reference.immutablePlan)
      || last.migrationId !== state.activeMigrationId || last.sequence !== state.journalSequence
      || last.fenceEpoch !== state.fenceEpoch || last.ownerGeneration !== state.ownerGeneration
      || chain.nodes.some(node => node.record.event === "cancel_intent" || node.record.event === "cancelled"))
      throw new MaintenanceFailure("journal_invalid");
    const firstIndex = chain.nodes.findIndex(node => node.record.event === "capture");
    const first = chain.nodes[firstIndex];
    // The general reader accepts legacy planned takeovers; they cannot establish receipt provenance here.
    const beforeCapture = firstIndex < 0 ? chain.nodes : chain.nodes.slice(0, firstIndex);
    if (beforeCapture.some(node => node.record.event === "takeover")) throw new MaintenanceFailure("journal_invalid");
    let receiptGeneration = state.ownerGeneration;
    if (!first) {
      if (state.admission !== "draining" || last.phase !== "planned") throw new MaintenanceFailure("journal_invalid");
    } else {
      if (state.admission !== "sealed" || first.record.formatVersion !== 2 || first.record.sourceClients === null)
        throw new MaintenanceFailure("journal_invalid");
      const roster = first.record.sourceClients;
      receiptGeneration = Number(roster.receiptGeneration);
      if (!same(roster.rows, observation.rows) || !same(roster.textEncoding, observation.textEncoding))
        throw new MaintenanceFailure("source_changed");
    }
    const rows = await access.decodedRows(observation);
    const clients = await sourceClientFacts(observation, rows, receiptGeneration, access.validateSource);
    const runtimeRows = await access.runtimeRows();
    const runtime = await sourceRuntimeFacts(runtimeRows, clients);
    const blockers = await access.inspectWriters(observation, rows);
    if (blockers.length) throw new MaintenanceFailure(blockers[0]!.code, blockers[0]!.subjectRef);
    await assertActive();
    const after = await access.observe();
    if (!same(observation, after)) throw new MaintenanceFailure("source_changed");
    return freeze({ observation, origin: { kind: first ? "captured-generation" as const : "current-generation" as const,
      head, capture: first?.reference ?? null, receiptGeneration, chain }, clients, runtime,
      scope: ["source-client-roster", "exact-db-anchor", "registered-processes", "database-sessions", "runtime-owners", "adapter-writer-inventory"] });
  };
  try {
    const facts = await collect();
    const window: SourceClientFactsWindow = freeze({ ...facts, async assertCurrent() {
      const current = await collect();
      if (!same(current.observation, facts.observation) || !same(current.origin, facts.origin)) throw new MaintenanceFailure("source_changed");
    } });
    const result = await consume(window);
    await window.assertCurrent();
    return result;
  } finally { active = false; }
}

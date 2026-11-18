import { canonicalJson, sha256 } from "./canonical.ts";
import { parseControllerCommand } from "./controller-command.ts";
import type { InspectMaintenanceCommand } from "./controller-command.ts";
import { awaitControllerAdmission, createControllerOwner, finishControllerOwner, recordControllerFailure } from "./controller-owner.ts";
import { MaintenanceFailure } from "./error.ts";
import { captureReference, verifyJournalChain } from "./journal.ts";
import type { VerifiedJournalChain } from "./journal.ts";
import { rowsDigest } from "./control-candidate/replay-core.ts";
import { bindSourceClientManifestRows, supportedEncoding, validateHistoricalControllerProfile } from "./control-candidate/rows.ts";
import { ArtifactStore } from "./objects.ts";
import { loadPersistedPlan, observeCapturePlanBindings } from "./plan.ts";
import { factsObject, inspectRegisteredSourceProcess } from "./source-facts.ts";
import type { Blocker, BlockerCode, MaintenanceAdapter, MaintenanceResult, MaintenanceServiceOptions, MigrationPlan, ObservedMaintenanceAnchor, SourceObservation } from "./types.ts";

const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
function requireValue(value: unknown, code: BlockerCode): asserts value {
  if (!value) throw new MaintenanceFailure(code, "maintenance-inspection");
}
const recovery = (code: BlockerCode = "journal_invalid"): MaintenanceResult => ({ status: "recovery_required",
  lastVerifiedPhase: null, blockers: [{ code, subjectRef: "db-exact-journal" }] });
function unavailable(error: unknown): boolean {
  return error instanceof MaintenanceFailure && ["journal_invalid", "snapshot_invalid", "control_root_mismatch"].includes(error.code)
    || (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** Diagnostic values only: there is no factory lease, registered actor, write
 * lock, restoration or authorization. The complete native rows must match the
 * already-verified exact journal before any recorded identity is inspected. */
async function inspectReadyControllers(adapter: MaintenanceAdapter, observed: SourceObservation,
  chain: VerifiedJournalChain): Promise<readonly Blocker[]> {
  const head = chain.nodes.at(-1)!.record, first = chain.nodes.find(node => node.record.event === "capture");
  requireValue(first && first.record.formatVersion !== 1 && first.record.sourceClients !== null, "journal_invalid");
  const roster = first.record.sourceClients, raw = await adapter.observeSourceClients();
  requireValue(same(raw.source, observed.source) && same(raw.sourceIdentity, observed.sourceIdentity)
    && same(raw.state, observed.state) && raw.schemaManifestDigest === observed.manifests.schemaManifestDigest, "maintenance_lost");
  requireValue(same(raw.textEncoding, roster.textEncoding), "source_changed");
  if (head.formatVersion === 3) {
    // verifyJournalChain has already replayed the complete O→H proof. Comparing
    // its exact final digest uses that shared protocol, not a weaker row replay.
    const proof = head.controlProof;
    requireValue(proof && (proof.kind === "control-successor" || proof.kind === "legacy-first-capture-bridge"), "journal_invalid");
    requireValue(supportedEncoding(raw.textEncoding) && same(proof.textEncoding, raw.textEncoding)
      && rowsDigest(raw.source, raw.textEncoding, raw.rows) === proof.afterRowsDigest, "source_changed");
  } else requireValue(same(raw.rows, roster.rows), "source_changed");
  const blockers: Blocker[] = [...await adapter.inspectWriters(observed)];
  if (supportedEncoding(raw.textEncoding)) {
    const bound = bindSourceClientManifestRows(observed.manifests, raw.rows, raw.textEncoding);
    for (const [index, row] of bound.rows.entries()) {
      if (row.entrypoint !== "maintenance-controller" && row.build_id !== "boardroom-maintenance-control-v1") continue;
      const original = raw.rows[index]!, subject = sha256(original.client_id[1]).slice(0, 24);
      requireValue(typeof row.host_identity_json === "string" && typeof row.process_identity_json === "string", "source_changed");
      const host = factsObject(JSON.parse(row.host_identity_json)), identity = factsObject(JSON.parse(row.process_identity_json));
      if (head.formatVersion !== 3)
        validateHistoricalControllerProfile(original, row, raw.source, raw.state.fenceEpoch, { host, process: identity });
      try {
        const current = await inspectRegisteredSourceProcess(host, identity);
        if (current.fact.status === "present") blockers.push({ code: "source_writer_active", subjectRef: "controller-process-present:" + subject });
        else if (row.ended_at === null) blockers.push({ code: "source_writer_unknown", subjectRef: "controller-ended-observation-required:" + subject });
        else if (current.fact.reason !== "process_absent") blockers.push({ code: "source_writer_unknown", subjectRef: "controller-native-identity-replaced:" + subject });
      } catch (error) {
        if (!(error instanceof MaintenanceFailure) || error.code !== "source_writer_unknown") throw error;
        blockers.push({ code: "source_writer_unknown", subjectRef: "controller-native-unreadable:" + subject });
      }
    }
  } else if (observed.clients.some(row => row.entrypoint === "maintenance-controller" || row.build_id === "boardroom-maintenance-control-v1")) {
    // Existing non-UTF8 v2 consumption remains in its native path. Inspection
    // cannot claim a decoded controller identity from an unsupported encoding.
    blockers.push({ code: "source_writer_unknown", subjectRef: "controller-native-encoding-unverified" });
  }
  requireValue(same(await adapter.observeSourceClients(), raw) && same(await adapter.observe(), observed), "maintenance_lost");
  return blockers;
}

/** An immutable closure plus one actual source observation produces diagnostics
 * only. In particular, a historical ready is never a fresh restore/guard permit. */
async function inspectAnchor(store: ArtifactStore, observed: SourceObservation, plan: MigrationPlan,
  adapter: MaintenanceAdapter): Promise<MaintenanceResult> {
  const state = observed.state;
  if (state.journalSequence === 0) {
    if (state.admission !== "open" || state.journalRecordRef !== null || state.journalDigest !== null
      || state.activeMigrationId !== null || state.planDigest !== null) return recovery();
    return { status: "blocked", lastVerifiedPhase: null, blockers: [{ code: "phase_conflict", subjectRef: "no-maintenance-prefix" }] };
  }
  if (!state.journalRecordRef || !state.journalDigest) return recovery();
  let chain;
  try {
    const exact = await store.readAnchoredJournal({ ref: state.journalRecordRef, sha256: state.journalDigest });
    chain = await verifyJournalChain(store, exact);
  } catch (error) { if (unavailable(error)) return recovery(); throw error; }
  const head = chain.nodes.at(-1)!, record = head.record;
  if (head.reference.ref !== state.journalRecordRef || head.reference.sha256 !== state.journalDigest
    || record.sequence !== state.journalSequence || record.fenceEpoch !== state.fenceEpoch
    || record.ownerGeneration !== state.ownerGeneration || !same(record.source, observed.source)) return recovery();
  if (!same(chain.plan, plan)) return { status: "blocked", lastVerifiedPhase: null,
    blockers: [{ code: "plan_stale", subjectRef: "different-current-migration" }] };
  const terminal = record.event === "cancelled";
  if (terminal ? state.admission !== "open" || state.activeMigrationId !== null || state.planDigest !== null
    : state.activeMigrationId !== plan.migrationId || state.planDigest !== record.plan.sha256
      || state.admission !== (record.phase === "planned" ? "draining" : "sealed")) return recovery();
  if (state.controlRootJson !== canonicalJson(store.identity) || state.mutexIdentityJson === null) return recovery("control_root_mismatch");
  const observedAnchor: ObservedMaintenanceAnchor = { ...captureReference(head), phase: record.phase,
    admission: state.admission, authority: "observation-only" };
  if (terminal) return { status: "cancelled", lastPhase: record.phase, terminalJournal: head.reference,
    openedFenceEpoch: state.fenceEpoch, restartRequired: true, observedAnchor };
  if (chain.nodes.some(node => node.record.event === "cancel_intent")) return { status: "cancel_pending", phase: record.phase,
    ref: captureReference(head), blockers: [{ code: "drain_incomplete", subjectRef: "fresh-cancellation-window-required" }], observedAnchor };
  if (record.phase === "snapshot_ready") return { status: "blocked", lastVerifiedPhase: "snapshot_ready",
    blockers: [...await inspectReadyControllers(adapter, observed, chain),
      { code: "restore_verification_unavailable", subjectRef: "fresh-ready-window-required" }], observedAnchor };
  return { status: "paused", phase: record.phase, ref: captureReference(head), observedAnchor };
}

/** Actual read-only entry. No mutex acquisition (which can first bind the DB),
 * source write lock, journal/client publication, repair, or restore target is
 * created. Each adapter observation is its own real read transaction. Matching
 * final full state/manifest observations protect the diagnostic from a race;
 * immutable artifacts are selected exclusively by that exact DB anchor. */
export async function inspectMaintenance(options: MaintenanceServiceOptions, value: InspectMaintenanceCommand): Promise<MaintenanceResult> {
  const command = parseControllerCommand(value);
  requireValue(command.operation === "inspect-migration", "request_conflict");
  const request = command.request;
  const plan = await loadPersistedPlan(request.plan, request.expectedSource);
  requireValue(options.controlRoot === request.plan.controlRoot
    && options.expectedSourceId === options.environment.inventory.selectedSourceId, "source_changed");
  let owner;
  try { owner = await createControllerOwner(options, plan); }
  catch (error) {
    // Adapter initialization owns its real cleanup. Only a plain selection
    // failure is diagnostic; an AggregateError with cleanup loss still escapes.
    if (error instanceof MaintenanceFailure && ["source_missing", "source_changed"].includes(error.code)) return recovery(error.code);
    throw error;
  }
  const failures: unknown[] = [];
  let result: MaintenanceResult | undefined;
  try {
    await awaitControllerAdmission(owner);
    const initial = await owner.adapter.observe();
    requireValue(same(initial.source, plan.source) && same(initial.sourceIdentity, plan.sourceIdentity), "source_changed");
    const store = await ArtifactStore.open(request.plan.controlRoot, request.expectedSource);
    result = await inspectAnchor(store, initial, plan, owner.adapter);
    // Open terminal is historical. Legitimate later business/config changes
    // cannot resurrect its old frozen state or require a second cancellation.
    if (result.status !== "cancelled") await observeCapturePlanBindings(plan, options, owner.adapter);
    await store.assertRoot(); await awaitControllerAdmission(owner);
    requireValue(same(await owner.adapter.observe(), initial), "maintenance_lost");
  } catch (error) { recordControllerFailure(owner, failures, error); }
  await finishControllerOwner(owner, undefined, undefined, failures, "maintenance-inspection");
  return result!;
}

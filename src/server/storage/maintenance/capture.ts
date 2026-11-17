import { z } from "zod";
import path from "node:path";
import { canonicalJson, digestJson } from "./canonical.ts";
import { awaitControllerAdmission, createControllerOwner, finishControllerOwner, recordControllerFailure, rememberControllerStore } from "./controller-owner.ts";
import { MaintenanceFailure } from "./error.ts";
import { captureReference, verifyJournalChain, verifyRestoreBundleClosure, verifySourceFilesClosure } from "./journal.ts";
import type { JournalNode, VerifiedJournalChain } from "./journal.ts";
import { ArtifactStore } from "./objects.ts";
import { hash, id, ref, source, text } from "./parse-primitives.ts";
import { parseJournal, readSourceFiles } from "./parse.ts";
import { loadPersistedPlan, observeCapturePlanBindings } from "./plan.ts";
import { maintenanceFilesystem } from "./platform.ts";
import { buildSourceClientsRoster } from "./source-clients.ts";
import { assertCapturedSourceClientBinding } from "./source-client-binding.ts";
import { captureSourceFiles, verifyLiveSourceFiles } from "./source-files.ts";
import { publishSnapshotBundle } from "./snapshot-bundle.ts";
import type { StorageMaintenanceState } from "../admission.ts";
import type { ArtifactRef, BlockerCode, ContinueRequest, JournalFrozenV2, MaintenanceRef, MaintenanceResult, MaintenanceServiceOptions,
  MigrationPlan, OperationMutex, SourceClientFactsWindow, SourceClientsObservation, SourceClientsRosterV1,
  SourceFilesManifest, SourceLock, SourceObservation } from "./types.ts";

const requestSchema = z.object({
  plan: z.object({ migrationId: id, planDigest: hash, immutablePlan: ref, controlRoot: text }).strict(),
  expectedSource: source, expectedPhase: z.enum(["planned", "quiesced", "snapshot_ready"]).nullable(),
  expectedJournalDigest: hash.nullable(), requestId: id,
}).strict();
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
function requireValue(value: unknown, code: BlockerCode = "source_changed"): asserts value {
  if (!value) throw new MaintenanceFailure(code, "internal-capture");
}
type RecoveryResult = Extract<MaintenanceResult, { status: "blocked" | "recovery_required" }>;
const recovery = (): RecoveryResult => ({ status: "recovery_required", lastVerifiedPhase: null,
  blockers: [{ code: "journal_invalid", subjectRef: "db-exact-journal" }] });
type Reached = "first-capture" | "takeover" | "recapture";
type Prefix = { kind: "first" | "replay" | "takeover" | "recapture" | "snapshot";
  chain: VerifiedJournalChain; head: JournalNode; generation: number; original?: JournalNode | undefined; reached?: Reached };
type Classification = Prefix | { kind: "result"; result: RecoveryResult };
type CaptureSnapshotAttempt = RecoveryResult
  | { readonly kind: "anchored-progress"; readonly ref: MaintenanceRef; readonly reached: Reached }
  | { readonly kind: "unverified-bundle"; readonly ref: MaintenanceRef; readonly bundle: ArtifactRef; readonly publication: ArtifactRef };

async function exactChain(store: ArtifactStore, state: StorageMaintenanceState, plan: MigrationPlan,
  request: ContinueRequest): Promise<VerifiedJournalChain | null> {
  requireValue(state.admission !== "open", "phase_conflict");
  if (!state.journalRecordRef || !state.journalDigest || state.journalSequence < 1) return null;
  let chain: VerifiedJournalChain;
  try {
    const exact = await store.readAnchoredJournal({ ref: state.journalRecordRef, sha256: state.journalDigest });
    chain = await verifyJournalChain(store, exact);
  } catch (error) {
    if (error instanceof MaintenanceFailure && ["journal_invalid", "snapshot_invalid", "control_root_mismatch"].includes(error.code)
      || (error as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
    throw error;
  }
  const head = chain.nodes.at(-1)!;
  if (head.reference.ref !== state.journalRecordRef || head.reference.sha256 !== state.journalDigest
    || head.record.sequence !== state.journalSequence || head.record.fenceEpoch !== state.fenceEpoch
    || head.record.ownerGeneration !== state.ownerGeneration || head.record.migrationId !== state.activeMigrationId
    || head.record.plan.sha256 !== state.planDigest || head.record.source.databaseInstanceId !== state.databaseInstanceId) return null;
  requireValue(same(chain.plan, plan) && same(head.record.plan, request.plan.immutablePlan), "plan_stale");
  return chain;
}

async function classify(store: ArtifactStore, state: StorageMaintenanceState, plan: MigrationPlan,
  request: ContinueRequest, requestDigest: string): Promise<Classification> {
  const chain = await exactChain(store, state, plan, request);
  if (!chain) return { kind: "result", result: recovery() };
  const first = chain.nodes[0]!, head = chain.nodes.at(-1)!;
  const matches = chain.nodes.filter(node => node.record.requestId === request.requestId);
  if (matches.length) requireValue(matches.length === 1 && matches[0]!.record.requestDigest === requestDigest, "request_conflict");
  const captures = chain.nodes.filter(node => node.record.event === "capture");
  const before = captures.length ? chain.nodes.slice(0, chain.nodes.indexOf(captures[0]!)) : chain.nodes;
  requireValue(before.every(node => node.record.phase === "planned" && ["enter", "observation"].includes(node.record.event)
    && node.record.ownerGeneration === first.record.ownerGeneration && node.record.fenceEpoch === first.record.fenceEpoch), "phase_conflict");
  requireValue(state.ownerGeneration === first.record.ownerGeneration && state.fenceEpoch === first.record.fenceEpoch, "phase_conflict");
  if (captures.length === 0) {
    requireValue(state.admission === "draining" && matches.length === 0, "phase_conflict");
    requireValue(request.expectedPhase === "planned" && request.expectedJournalDigest === head.reference.sha256, "phase_conflict");
    requireValue(chain.nodes.length < 4096 && Number.isSafeInteger(head.record.sequence + 1), "phase_conflict");
    return { kind: "first", chain, head, generation: first.record.ownerGeneration };
  }
  requireValue(state.admission === "sealed" && captures.length === 1 && captures[0] === head
    && head.record.formatVersion === 2 && head.record.frozen !== null && head.record.sourceClients !== null
    && matches.length === 1 && matches[0] === head, "phase_conflict");
  requireValue(request.expectedPhase === "planned" && request.expectedJournalDigest === head.record.previous?.sha256, "request_conflict");
  return { kind: "replay", chain, head, generation: first.record.ownerGeneration };
}

/** Additional C2 policy over the canonical reader, never a wider C1 replay. */
function captureHistory(chain: VerifiedJournalChain, state: StorageMaintenanceState) {
  const first = chain.nodes[0]!, head = chain.nodes.at(-1)!;
  const index = chain.nodes.findIndex(node => node.record.event === "capture");
  const before = index < 0 ? chain.nodes : chain.nodes.slice(0, index);
  requireValue(before.every(node => node.record.phase === "planned" && ["enter", "observation"].includes(node.record.event)
    && node.record.ownerGeneration === first.record.ownerGeneration && node.record.fenceEpoch === first.record.fenceEpoch), "phase_conflict");
  requireValue(state.fenceEpoch === first.record.fenceEpoch, "phase_conflict");
  if (index < 0) {
    requireValue(state.admission === "draining" && head.record.phase === "planned"
      && state.ownerGeneration === first.record.ownerGeneration, "phase_conflict");
    return { generation: first.record.ownerGeneration, original: undefined };
  }
  const original = chain.nodes[index]!, record = original.record;
  requireValue(state.admission === "sealed" && chain.nodes.slice(index).every(node => node.record.formatVersion === 2
    && node.record.phase === "quiesced" && ["capture", "takeover", "observation"].includes(node.record.event)), "phase_conflict");
  requireValue(record.formatVersion === 2 && record.frozen !== null && record.sourceClients !== null, "journal_invalid");
  const generation = Number(record.sourceClients.receiptGeneration);
  requireValue(Number.isSafeInteger(generation) && generation > 0 && generation === record.ownerGeneration
    && generation === first.record.ownerGeneration, "journal_invalid");
  return { generation, original };
}

async function classifySnapshot(store: ArtifactStore, state: StorageMaintenanceState, plan: MigrationPlan,
  request: ContinueRequest, requestDigest: string): Promise<Classification> {
  const chain = await exactChain(store, state, plan, request);
  if (!chain) return { kind: "result", result: recovery() };
  const head = chain.nodes.at(-1)!, matches = chain.nodes.filter(node => node.record.requestId === request.requestId);
  // An anchored key is checked before the request's old expected predecessor.
  if (matches.length) {
    requireValue(matches.every(node => node.record.requestDigest === requestDigest), "request_conflict");
    requireValue(matches.at(-1) === head, "phase_conflict");
  }
  const history = captureHistory(chain, state);
  if (matches.length) {
    const index = chain.nodes.indexOf(matches[0]!), predecessor = chain.nodes[index - 1];
    if (!predecessor || matches.length !== chain.nodes.length - index
      || request.expectedJournalDigest !== predecessor.reference.sha256 || request.expectedPhase !== predecessor.record.phase)
      return { kind: "result", result: recovery() };
    const planned = predecessor.record.phase === "planned";
    const events = planned ? ["capture", "takeover", "capture"] : ["takeover", "capture"];
    if ((!planned && predecessor.record.phase !== "quiesced") || matches.length > events.length
      || !history.original || (planned && matches[0] !== history.original)
      || matches.some((node, position) => node.record.event !== events[position]
        || node.record.ownerGeneration !== predecessor.record.ownerGeneration + (planned && position === 0 ? 0 : 1)))
      return { kind: "result", result: recovery() };
    const reached: Reached = planned && matches.length === 1 ? "first-capture"
      : matches.length === events.length ? "recapture" : "takeover";
    return { kind: "replay", chain, head, ...history, reached };
  }
  requireValue(request.expectedPhase === head.record.phase && request.expectedJournalDigest === head.reference.sha256, "phase_conflict");
  const required = history.original ? 2 : 3;
  requireValue(chain.nodes.length + required <= 4096 && Number.isSafeInteger(head.record.sequence + required)
    && Number.isSafeInteger(state.ownerGeneration + 1), "phase_conflict");
  return { kind: history.original ? "takeover" : "first", chain, head, ...history };
}
function bindObservation(observed: SourceObservation, raw: SourceClientsObservation, plan: MigrationPlan): void {
  requireValue(same(observed.source, plan.source) && same(observed.sourceIdentity, plan.sourceIdentity)
    && same(raw.source, observed.source) && same(raw.sourceIdentity, observed.sourceIdentity) && same(raw.state, observed.state)
    && raw.schemaManifestDigest === observed.manifests.schemaManifestDigest && raw.textEncoding.backend === observed.source.kind);
  requireValue(observed.manifests.schemaManifestDigest === plan.schemaManifestDigest
    && observed.state.guardManifestDigest === plan.guardManifestDigest, "plan_stale");
  const tables = observed.manifests.tables.filter(table => table.name === "storage_source_clients");
  requireValue(tables.length === 1 && tables[0]!.count === String(raw.rows.length)
    && observed.manifests.controlRows.storage_source_clients.length === raw.rows.length
    && observed.clients.length === raw.rows.length);
}
function rosterFor(raw: SourceClientsObservation, request: ContinueRequest, generation: number): SourceClientsRosterV1 {
  return buildSourceClientsRoster({ formatVersion: 1, kind: "source-clients-roster", source: raw.source,
    migrationId: request.plan.migrationId, plan: request.plan.immutablePlan, fenceEpoch: String(raw.state.fenceEpoch),
    receiptGeneration: String(generation), textEncoding: raw.textEncoding, rows: raw.rows });
}
function assertOrigin(facts: SourceClientFactsWindow, raw: SourceClientsObservation, prefix: Prefix): void {
  requireValue(same(facts.observation, raw) && same(facts.origin.chain, prefix.chain)
    && same(facts.origin.head, prefix.head.reference) && facts.origin.receiptGeneration === prefix.generation);
  requireValue(facts.origin.kind === (prefix.kind === "first" ? "current-generation" : "captured-generation")
    && same(facts.origin.capture, prefix.kind === "first" ? null : (prefix.original ?? prefix.head).reference), "phase_conflict");
}
function assertFiles(files: SourceFilesManifest, plan: MigrationPlan, store: ArtifactStore): void {
  requireValue(same(files.source, plan.source) && same(files.roots, plan.fileRoots)
    && files.rootBindings.every(binding => binding.hostIdentityDigest === store.identity.hostIdentityDigest));
  const configRoots = files.roots.filter(root => root.label === "config");
  const configEntries = files.entries.filter(entry => entry.sourceRoot === "config");
  if (plan.originalConfigPath === null) {
    requireValue(configRoots.length === 0 && configEntries.length === 0
      && plan.configDigest === digestJson({ configFile: null }), "plan_stale");
  } else {
    requireValue(configRoots.length === 1 && configRoots[0]!.path === plan.originalConfigPath && configEntries.length === 1
      && configEntries[0]!.sourceRelativePath === "" && configEntries[0]!.kind === "file"
      && configEntries[0]!.payload?.sha256 === plan.configDigest, "plan_stale");
  }
}
function frozenFor(observed: SourceObservation, files: ArtifactRef, roster: SourceClientsRosterV1): JournalFrozenV2 {
  return { sourceFilesManifest: files, schemaManifestDigest: observed.manifests.schemaManifestDigest,
    frozenBusinessManifestDigest: observed.manifests.frozenBusinessManifestDigest,
    guardManifestDigest: observed.state.guardManifestDigest, sourceClientsDigest: digestJson(roster) };
}

type LockedWindow = {
  readonly lock: SourceLock; readonly store: ArtifactStore; readonly initial: SourceObservation;
  readonly raw: SourceClientsObservation; readonly expected: StorageMaintenanceState;
  assertFull(): Promise<void>;
};

/** C1 remains a single control stage, including its exact-first read-only replay. */
export async function captureMaintenance(options: MaintenanceServiceOptions, value: ContinueRequest): Promise<MaintenanceResult> {
  return runCapture(options, value, "internal-capture");
}

/** Internal C2 only: no owner/lock/stage/proof is accepted or returned. The
 * resulting B/U is unverified input, with no surviving private V authority. */
export async function captureSnapshotMaintenance(options: MaintenanceServiceOptions, value: ContinueRequest): Promise<CaptureSnapshotAttempt> {
  return runCapture(options, value, "internal-capture-snapshot");
}

function runCapture(options: MaintenanceServiceOptions, value: ContinueRequest, operation: "internal-capture"): Promise<MaintenanceResult>;
function runCapture(options: MaintenanceServiceOptions, value: ContinueRequest, operation: "internal-capture-snapshot"): Promise<CaptureSnapshotAttempt>;
async function runCapture(options: MaintenanceServiceOptions, value: ContinueRequest,
  operation: "internal-capture" | "internal-capture-snapshot"): Promise<MaintenanceResult | CaptureSnapshotAttempt> {
  const parsed = requestSchema.safeParse(value); requireValue(parsed.success, "request_conflict");
  const request = parsed.data, requestDigest = digestJson({ operation, request });
  const plan = await loadPersistedPlan(request.plan, request.expectedSource);
  const owner = await createControllerOwner(options, plan), { adapter, descriptor } = owner;
  const failures: unknown[] = [];
  let mutex: OperationMutex | undefined, sourceLock: SourceLock | undefined;
  let result: MaintenanceResult | CaptureSnapshotAttempt | undefined;
  try {
    await awaitControllerAdmission(owner);
    const observed = await observeCapturePlanBindings(plan, options, adapter);
    const initialStore = await ArtifactStore.open(request.plan.controlRoot, request.expectedSource);
    rememberControllerStore(owner, initialStore); await maintenanceFilesystem(initialStore.root);
    if (descriptor.kind === "sqlite") await maintenanceFilesystem(path.dirname(descriptor.sqlitePath));
    await awaitControllerAdmission(owner);
    mutex = await adapter.acquireMutex(initialStore.identity, observed.state);
    await awaitControllerAdmission(owner);
    const held = mutex;

    // These closures can only be made by this actual runner. Every invocation
    // owns a new native transaction and guard; a completed old scope is inactive.
    const withWindow = async <T>(kind: "control" | "snapshot", consume: (window: LockedWindow) => Promise<T>): Promise<T> => {
      await awaitControllerAdmission(owner);
      return adapter.withSourceLock(kind, async lock => {
        sourceLock = lock;
        let active = true;
        try {
          await awaitControllerAdmission(owner);
          await observeCapturePlanBindings(plan, options, adapter);
          const initial = await lock.observe(), raw = await lock.observeSourceClients(), expected = initial.state;
          bindObservation(initial, raw, plan);
          requireValue(expected.activeMigrationId === plan.migrationId && expected.planDigest === request.plan.planDigest, "plan_stale");
          requireValue(expected.controlRootJson === canonicalJson(initialStore.identity)
            && expected.mutexIdentityJson === canonicalJson(held.identity), "control_root_mismatch");
          const assertState = async () => {
            requireValue(active, "maintenance_lost");
            await held.assertHeld(); await lock.assertHeld(); await initialStore.assertRoot();
            requireValue(same(await lock.observeSourceClients(), raw), "maintenance_lost");
          };
          const store = await ArtifactStore.open(request.plan.controlRoot, request.expectedSource, { assertCurrent: assertState });
          rememberControllerStore(owner, store);
          const assertFull = async () => {
            await assertState(); const live = await lock.observe();
            bindObservation(live, await lock.observeSourceClients(), plan);
            requireValue(same(live, initial));
          };
          return await consume({ lock, store, initial, raw, expected, assertFull });
        } catch (error) {
          // Capture the original failure, including undefined, before PG's
          // adapter-safeError boundary can replace its public representation.
          recordControllerFailure(owner, failures, error); throw error;
        } finally { active = false; }
      });
    };
    const withFacts = <T>(window: LockedWindow, prefix: Prefix,
      consume: (facts: SourceClientFactsWindow) => Promise<T>): Promise<T> =>
      window.lock.withSourceClientFacts(request.plan, async facts => {
        try { assertOrigin(facts, window.raw, prefix); return await consume(facts); }
        catch (error) { recordControllerFailure(owner, failures, error); throw error; }
      });

    const proveOriginal = async (window: LockedWindow, prefix: Prefix, facts: SourceClientFactsWindow) => {
      const record = (prefix.original ?? prefix.head).record;
      requireValue(record.formatVersion === 2 && record.frozen !== null && record.sourceClients !== null, "journal_invalid");
      const frozen = record.frozen, originalRoster = record.sourceClients;
      const roster = rosterFor(facts.observation, request, prefix.generation);
      requireValue(same(roster, originalRoster) && same(frozenFor(window.initial, frozen.sourceFilesManifest, roster), frozen));
      const files = await readSourceFiles(window.store, frozen.sourceFilesManifest);
      await verifySourceFilesClosure(window.store, files); assertFiles(files, plan, window.store); await window.assertFull();
      await verifyLiveSourceFiles(window.store, window.lock, held, request.plan, frozen.sourceFilesManifest);
      await observeCapturePlanBindings(plan, options, adapter); await window.assertFull(); await facts.assertCurrent();
      return { frozen, roster: originalRoster };
    };
    const publishNode = async (window: LockedWindow, prefix: Prefix, record: ReturnType<typeof parseJournal>) => {
      const journal = await window.store.putJson("journal", record); await window.store.confirmDurable(journal);
      const after = await verifyJournalChain(window.store, journal);
      requireValue(after.nodes.length === prefix.chain.nodes.length + 1
        && same(after.nodes.slice(0, -1), prefix.chain.nodes) && same(after.nodes.at(-1)!.record, record), "journal_invalid");
      return after.nodes.at(-1)!;
    };
    const anchor = async (window: LockedWindow, node: JournalNode) => {
      const { lock, store, expected, initial, raw } = window;
      // The facts callback and its automatic final check have completed. This
      // is the same native lock, but no closed facts scope is used as authority.
      await window.assertFull();
      await lock.anchor({ expected, admission: "sealed", fenceEpoch: expected.fenceEpoch,
        ownerGeneration: node.record.ownerGeneration, activeMigrationId: expected.activeMigrationId, planDigest: expected.planDigest,
        controlRootIdentity: { ...store.identity }, mutexIdentity: held.identity, journal: node.reference,
        journalSequence: node.record.sequence });
      const sealed = await lock.observe(), sealedRaw = await lock.observeSourceClients();
      requireValue(same(sealed.state, { ...expected, admission: "sealed", ownerGeneration: node.record.ownerGeneration,
        journalRecordRef: node.reference.ref, journalDigest: node.reference.sha256, journalSequence: node.record.sequence }));
      bindObservation(sealed, sealedRaw, plan);
      requireValue(sealed.manifests.frozenBusinessManifestDigest === initial.manifests.frozenBusinessManifestDigest
        && same(sealed.clients, initial.clients) && same(sealedRaw.rows, raw.rows) && same(sealedRaw.textEncoding, raw.textEncoding)
        && same(sealed.manifests.controlRows.storage_source_clients, initial.manifests.controlRows.storage_source_clients)
        && same(sealed.manifests.tables.filter(table => table.name !== "storage_maintenance"),
          initial.manifests.tables.filter(table => table.name !== "storage_maintenance")));
      await held.assertHeld(); await lock.assertHeld();
      return node;
    };
    const firstStage = async (window: LockedWindow, prefix: Prefix) => {
      const node = await withFacts(window, prefix, async facts => {
        const roster = rosterFor(facts.observation, request, prefix.generation);
        await window.assertFull();
        const captured = await captureSourceFiles(window.store, window.lock, held, request.plan);
        const files = await readSourceFiles(window.store, captured.ref);
        requireValue(same(files, captured.manifest), "snapshot_invalid");
        await verifySourceFilesClosure(window.store, files); assertFiles(files, plan, window.store);
        const frozen = frozenFor(window.initial, captured.ref, roster);
        await verifyLiveSourceFiles(window.store, window.lock, held, request.plan, captured.ref);
        await observeCapturePlanBindings(plan, options, adapter); await window.assertFull(); await facts.assertCurrent();
        const record = parseJournal({ formatVersion: 2, kind: "journal", migrationId: plan.migrationId,
          sequence: prefix.head.record.sequence + 1, previous: prefix.head.reference, phase: "quiesced", event: "capture",
          requestId: request.requestId, requestDigest, source: plan.source, plan: request.plan.immutablePlan,
          fenceEpoch: window.expected.fenceEpoch, ownerGeneration: window.expected.ownerGeneration,
          evidence: [], snapshot: null, sourceClients: roster, frozen });
        const node = await publishNode(window, prefix, record);
        await observeCapturePlanBindings(plan, options, adapter); await window.assertFull(); await facts.assertCurrent();
        return node;
      });
      return anchor(window, node);
    };
    const successorStage = async (window: LockedWindow, prefix: Prefix, event: "takeover" | "capture") => {
      const node = await withFacts(window, prefix, async facts => {
        const original = await proveOriginal(window, prefix, facts);
        const record = parseJournal({ formatVersion: 2, kind: "journal", migrationId: plan.migrationId,
          sequence: prefix.head.record.sequence + 1, previous: prefix.head.reference, phase: "quiesced", event,
          requestId: request.requestId, requestDigest, source: plan.source, plan: request.plan.immutablePlan,
          fenceEpoch: window.expected.fenceEpoch, ownerGeneration: window.expected.ownerGeneration + (event === "takeover" ? 1 : 0),
          evidence: [], snapshot: null, sourceClients: event === "capture" ? original.roster : null,
          frozen: event === "capture" ? original.frozen : null });
        const node = await publishNode(window, prefix, record);
        await observeCapturePlanBindings(plan, options, adapter); await window.assertFull(); await facts.assertCurrent();
        return node;
      });
      return anchor(window, node);
    };
    const continuePrefix = async (window: LockedWindow, previous: JournalNode, kind: "takeover" | "recapture" | "snapshot"): Promise<Prefix> => {
      const chain = await exactChain(window.store, window.expected, plan, request);
      requireValue(chain !== null, "journal_invalid");
      const head = chain.nodes.at(-1)!;
      requireValue(same(head, previous), "phase_conflict");
      const history = captureHistory(chain, window.expected);
      requireValue(history.original !== undefined, "journal_invalid");
      return { kind, chain, head, ...history };
    };

    const start = await withWindow("control", async window => {
      const prefix = operation === "internal-capture"
        ? await classify(window.store, window.expected, plan, request, requestDigest)
        : await classifySnapshot(window.store, window.expected, plan, request, requestDigest);
      if (prefix.kind === "result") { await window.assertFull(); return { kind: "result" as const, value: prefix.result }; }
      if (prefix.kind === "replay") {
        await withFacts(window, prefix, facts => proveOriginal(window, prefix, facts));
        await window.assertFull();
        const reference = captureReference(prefix.head);
        return { kind: "result" as const, value: operation === "internal-capture"
          ? { status: "paused" as const, phase: "quiesced" as const, ref: reference }
          : { kind: "anchored-progress" as const, ref: reference, reached: prefix.reached! } };
      }
      const first = prefix.kind === "first";
      return { kind: "stage" as const, first, node: first
        ? await firstStage(window, prefix) : await successorStage(window, prefix, "takeover") };
    });
    // A callback result alone is never a commit/close receipt. All following
    // work begins only after withWindow's original adapter promise resolved.
    if (start.kind === "result") result = start.value;
    else if (operation === "internal-capture") result = { status: "paused", phase: "quiesced", ref: captureReference(start.node) };
    else {
      let node = start.node;
      if (start.first) node = await withWindow("control", async window =>
        successorStage(window, await continuePrefix(window, node, "takeover"), "takeover"));
      node = await withWindow("control", async window =>
        successorStage(window, await continuePrefix(window, node, "recapture"), "capture"));
      result = await withWindow("snapshot", async window => {
        const prefix = await continuePrefix(window, node, "snapshot"), selected = prefix.head.record;
        requireValue(selected.formatVersion === 2 && selected.event === "capture"
          && selected.sourceClients !== null && selected.frozen !== null, "journal_invalid");
        const selectedRoster = selected.sourceClients, selectedFrozen = selected.frozen;
        const published = await withFacts(window, prefix, async facts => {
          await proveOriginal(window, prefix, facts);
          const published = await publishSnapshotBundle(window.store, window.lock);
          const closure = await verifyRestoreBundleClosure(window.store, published.bundle, published.publication);
          requireValue(same(closure.chain, prefix.chain) && same(closure.bundle.capture, captureReference(prefix.head))
            && same(closure.bundle.sourceFilesManifest, selectedFrozen.sourceFilesManifest), "snapshot_invalid");
          const current = await window.lock.observe();
          await assertCapturedSourceClientBinding(window.lock, current, selectedRoster, closure.manifests);
          await proveOriginal(window, prefix, facts);
          return published;
        });
        await window.assertFull();
        return { kind: "unverified-bundle" as const, ref: captureReference(prefix.head), ...published };
      });
    }
  } catch (error) { recordControllerFailure(owner, failures, error); }
  await finishControllerOwner(owner, mutex, sourceLock, failures, operation);
  return result!;
}

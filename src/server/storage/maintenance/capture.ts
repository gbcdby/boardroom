import { z } from "zod";
import path from "node:path";
import { canonicalJson, digestJson } from "./canonical.ts";
import { createControllerOwner, finishControllerOwner, recordControllerFailure, rememberControllerStore } from "./controller-owner.ts";
import { MaintenanceFailure } from "./error.ts";
import { captureReference, verifyJournalChain, verifySourceFilesClosure } from "./journal.ts";
import type { JournalNode, VerifiedJournalChain } from "./journal.ts";
import { ArtifactStore } from "./objects.ts";
import { hash, id, ref, source, text } from "./parse-primitives.ts";
import { parseJournal, readSourceFiles } from "./parse.ts";
import { loadPersistedPlan, observeCapturePlanBindings } from "./plan.ts";
import { maintenanceFilesystem } from "./platform.ts";
import { buildSourceClientsRoster } from "./source-clients.ts";
import { captureSourceFiles, verifyLiveSourceFiles } from "./source-files.ts";
import type { StorageMaintenanceState } from "../admission.ts";
import type { ArtifactRef, BlockerCode, ContinueRequest, JournalFrozenV2, MaintenanceResult, MaintenanceServiceOptions,
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
const recovery = (): MaintenanceResult => ({ status: "recovery_required", lastVerifiedPhase: null,
  blockers: [{ code: "journal_invalid", subjectRef: "db-exact-journal" }] });
type Prefix = { kind: "first" | "replay"; chain: VerifiedJournalChain; head: JournalNode; generation: number };
type Classification = Prefix | { kind: "result"; result: MaintenanceResult };

async function classify(store: ArtifactStore, state: StorageMaintenanceState, plan: MigrationPlan,
  request: ContinueRequest, requestDigest: string): Promise<Classification> {
  requireValue(state.admission !== "open", "phase_conflict");
  if (!state.journalRecordRef || !state.journalDigest || state.journalSequence < 1) return { kind: "result", result: recovery() };
  let chain: VerifiedJournalChain;
  try {
    const exact = await store.readAnchoredJournal({ ref: state.journalRecordRef, sha256: state.journalDigest });
    chain = await verifyJournalChain(store, exact);
  } catch (error) {
    if (error instanceof MaintenanceFailure && ["journal_invalid", "snapshot_invalid", "control_root_mismatch"].includes(error.code)
      || (error as NodeJS.ErrnoException | null)?.code === "ENOENT") return { kind: "result", result: recovery() };
    throw error;
  }
  const first = chain.nodes[0]!, head = chain.nodes.at(-1)!;
  if (head.reference.ref !== state.journalRecordRef || head.reference.sha256 !== state.journalDigest
    || head.record.sequence !== state.journalSequence || head.record.fenceEpoch !== state.fenceEpoch
    || head.record.ownerGeneration !== state.ownerGeneration || head.record.migrationId !== state.activeMigrationId
    || head.record.plan.sha256 !== state.planDigest || head.record.source.databaseInstanceId !== state.databaseInstanceId)
    return { kind: "result", result: recovery() };
  requireValue(same(chain.plan, plan) && same(head.record.plan, request.plan.immutablePlan), "plan_stale");
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
    && same(facts.origin.capture, prefix.kind === "first" ? null : prefix.head.reference), "phase_conflict");
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

/** Trusted internal C1 only. No supplied adapter, facts, Fs, registry or success
 * flags. First capture and exact-first replay each own a fresh real lock window. */
export async function captureMaintenance(options: MaintenanceServiceOptions, value: ContinueRequest): Promise<MaintenanceResult> {
  const parsed = requestSchema.safeParse(value); requireValue(parsed.success, "request_conflict");
  const request = parsed.data, requestDigest = digestJson({ operation: "internal-capture", request });
  const plan = await loadPersistedPlan(request.plan, request.expectedSource);
  const owner = await createControllerOwner(options, plan), { adapter, descriptor } = owner;
  const failures: unknown[] = [];
  let mutex: OperationMutex | undefined, sourceLock: SourceLock | undefined, result: MaintenanceResult | undefined;
  try {
    const observed = await observeCapturePlanBindings(plan, options, adapter);
    const initialStore = await ArtifactStore.open(request.plan.controlRoot, request.expectedSource);
    rememberControllerStore(owner, initialStore); await maintenanceFilesystem(initialStore.root);
    if (descriptor.kind === "sqlite") await maintenanceFilesystem(path.dirname(descriptor.sqlitePath));
    mutex = await adapter.acquireMutex(initialStore.identity, observed.state);
    const held = mutex;
    result = await adapter.withSourceLock("control", async lock => {
      sourceLock = lock;
      try {
        await observeCapturePlanBindings(plan, options, adapter);
        const initial = await lock.observe(), raw = await lock.observeSourceClients(), expected = initial.state;
        bindObservation(initial, raw, plan);
        requireValue(expected.activeMigrationId === plan.migrationId && expected.planDigest === request.plan.planDigest, "plan_stale");
        requireValue(expected.controlRootJson === canonicalJson(initialStore.identity)
          && expected.mutexIdentityJson === canonicalJson(held.identity), "control_root_mismatch");
        const assertState = async () => {
          await held.assertHeld(); await lock.assertHeld(); await initialStore.assertRoot();
          requireValue(same(await lock.observeSourceClients(), raw), "maintenance_lost");
        };
        const store = await ArtifactStore.open(request.plan.controlRoot, request.expectedSource, { assertCurrent: assertState });
        rememberControllerStore(owner, store);
        const prefix = await classify(store, expected, plan, request, requestDigest);
        if (prefix.kind === "result") { await assertState(); return prefix.result; }
        const assertFull = async () => {
          await assertState(); const live = await lock.observe();
          bindObservation(live, await lock.observeSourceClients(), plan);
          requireValue(same(live, initial));
        };
        if (prefix.kind === "replay") {
          const head = prefix.head, record = head.record;
          requireValue(record.formatVersion === 2 && record.frozen !== null && record.sourceClients !== null, "journal_invalid");
          const frozen = record.frozen, originalRoster = record.sourceClients;
          const reference = await lock.withSourceClientFacts(request.plan, async facts => {
            try {
              assertOrigin(facts, raw, prefix);
              const roster = rosterFor(facts.observation, request, prefix.generation);
              requireValue(same(roster, originalRoster) && same(frozenFor(initial, frozen.sourceFilesManifest, roster), frozen));
              const files = await readSourceFiles(store, frozen.sourceFilesManifest);
              await verifySourceFilesClosure(store, files); assertFiles(files, plan, store); await assertFull();
              await verifyLiveSourceFiles(store, lock, held, request.plan, frozen.sourceFilesManifest);
              await observeCapturePlanBindings(plan, options, adapter); await assertFull(); await facts.assertCurrent();
              return captureReference(head);
            } catch (error) { recordControllerFailure(owner, failures, error); throw error; }
          });
          // Automatic final fresh has completed. Replaying the original key does
          // not capture, publish, anchor, or change the original generation.
          await assertFull();
          return { status: "paused", phase: "quiesced", ref: reference };
        }
        const node = await lock.withSourceClientFacts(request.plan, async facts => {
          try {
            assertOrigin(facts, raw, prefix);
            const roster = rosterFor(facts.observation, request, prefix.generation);
            await assertFull();
            const captured = await captureSourceFiles(store, lock, held, request.plan);
            const files = await readSourceFiles(store, captured.ref);
            requireValue(same(files, captured.manifest), "snapshot_invalid");
            await verifySourceFilesClosure(store, files); assertFiles(files, plan, store);
            const frozen = frozenFor(initial, captured.ref, roster);
            await verifyLiveSourceFiles(store, lock, held, request.plan, captured.ref);
            await observeCapturePlanBindings(plan, options, adapter); await assertFull(); await facts.assertCurrent();
            const record = parseJournal({ formatVersion: 2, kind: "journal", migrationId: plan.migrationId,
              sequence: prefix.head.record.sequence + 1, previous: prefix.head.reference, phase: "quiesced", event: "capture",
              requestId: request.requestId, requestDigest, source: plan.source, plan: request.plan.immutablePlan,
              fenceEpoch: expected.fenceEpoch, ownerGeneration: expected.ownerGeneration,
              evidence: [], snapshot: null, sourceClients: roster, frozen });
            const journal = await store.putJson("journal", record); await store.confirmDurable(journal);
            const after = await verifyJournalChain(store, journal);
            requireValue(after.nodes.length === prefix.chain.nodes.length + 1
              && same(after.nodes.slice(0, -1), prefix.chain.nodes) && same(after.nodes.at(-1)!.record, record), "journal_invalid");
            await observeCapturePlanBindings(plan, options, adapter); await assertFull(); await facts.assertCurrent();
            return after.nodes.at(-1)!;
          } catch (error) { recordControllerFailure(owner, failures, error); throw error; }
        });
        // The real collector's automatic final fresh check has now succeeded and
        // made its scope inactive. Anchor here, under the same actual lock/mutex.
        await assertFull();
        await lock.anchor({ expected, admission: "sealed", fenceEpoch: expected.fenceEpoch, ownerGeneration: expected.ownerGeneration,
          activeMigrationId: expected.activeMigrationId, planDigest: expected.planDigest,
          controlRootIdentity: { ...store.identity }, mutexIdentity: held.identity, journal: node.reference,
          journalSequence: node.record.sequence });
        const sealed = await lock.observe(), sealedRaw = await lock.observeSourceClients();
        requireValue(same(sealed.state, { ...expected, admission: "sealed", journalRecordRef: node.reference.ref,
          journalDigest: node.reference.sha256, journalSequence: node.record.sequence }));
        bindObservation(sealed, sealedRaw, plan);
        requireValue(sealed.manifests.frozenBusinessManifestDigest === initial.manifests.frozenBusinessManifestDigest
          && same(sealed.clients, initial.clients) && same(sealedRaw.rows, raw.rows) && same(sealedRaw.textEncoding, raw.textEncoding));
        await held.assertHeld(); await lock.assertHeld();
        return { status: "paused", phase: "quiesced", ref: captureReference(node) };
      } catch (error) { recordControllerFailure(owner, failures, error); throw error; }
    });
  } catch (error) { recordControllerFailure(owner, failures, error); }
  await finishControllerOwner(owner, mutex, sourceLock, failures, "internal-capture");
  return result!;
}

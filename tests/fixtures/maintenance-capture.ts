import assert from "node:assert/strict";
import { lstatSync, readdirSync, utimesSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { enterFixture } from "./maintenance-enter.ts";
import { sourceFilesFixture } from "./maintenance-source-files.ts";
import { enterMaintenance } from "../../src/server/storage/maintenance/enter.ts";
import * as ownerModule from "../../src/server/storage/maintenance/controller-owner.ts";
import { ArtifactStore } from "../../src/server/storage/maintenance/objects.ts";
import { verifyJournalChain } from "../../src/server/storage/maintenance/journal.ts";
import { digestJson } from "../../src/server/storage/maintenance/canonical.ts";
import { parseJournal } from "../../src/server/storage/maintenance/parse.ts";
import type { ContinueRequest, OperationMutex, PersistedPlanRef, SourceLock } from "../../src/server/storage/maintenance/types.ts";
export { finishControllerOwner, recordControllerFailure, rememberControllerStore } from "../../src/server/storage/maintenance/controller-owner.ts";

type SourceModule = typeof import("../../src/server/storage/maintenance/source-files.ts");
interface State {
  readonly source: SourceModule;
  readonly events: string[];
  hook: (stage: string) => Promise<void> | void;
  onLock?: (lock: SourceLock) => void;
  onOwner?: (owner: Awaited<ReturnType<typeof ownerModule.createControllerOwner>>) => void;
}
const states = new Map<string, State>();
/** Negative tests may observe/fault the real private owner and lock. Production
 * capture imports the concrete factory directly and has no such hook. */
export async function createControllerOwner(...args: Parameters<typeof ownerModule.createControllerOwner>) {
  const owner = await ownerModule.createControllerOwner(...args), state = states.get(args[1].controlRoot.path);
  assert(state);
  const withLock = owner.adapter.withSourceLock;
  owner.adapter.withSourceLock = function<T>(kind: "control" | "snapshot", consume: (lock: SourceLock) => Promise<T>): Promise<T> {
    return withLock.call(owner.adapter, kind, async lock => {
      state.onLock?.(lock); return consume(lock);
    }) as Promise<T>;
  };
  state.onOwner?.(owner); return owner;
}
const required = (store: ArtifactStore) => {
  const state = states.get(store.root); assert(state, "capture fixture is private to the exact root"); return state;
};
/** Test-only delegates. Actual S logic/files/native owners/store bytes execute;
 * only its native profile evidence is the existing explicitly synthetic fixture.
 * The C adapter, mutex, source lock, raw rows, facts and COMMIT remain real. */
export async function captureSourceFiles(store: ArtifactStore, lock: SourceLock, mutex: OperationMutex, plan: PersistedPlanRef) {
  const state = required(store); state.events.push("capture-begin"); await state.hook("capture-begin");
  const result = await state.source.captureSourceFiles(store, lock, mutex, plan);
  state.events.push("capture-end"); await state.hook("capture-end"); return result;
}
export async function verifyLiveSourceFiles(store: ArtifactStore, lock: SourceLock, mutex: OperationMutex,
  plan: PersistedPlanRef, reference: Parameters<SourceModule["verifyLiveSourceFiles"]>[4]) {
  const state = required(store); state.events.push("live-begin"); await state.hook("live-begin");
  await state.source.verifyLiveSourceFiles(store, lock, mutex, plan, reference);
  state.events.push("live-end"); await state.hook("live-end");
}
function absoluteImports(code: string, source: string): string {
  return code.replace(/from "(\.\/[^"\n]+)"/g,
    (_, name: string) => "from " + JSON.stringify(pathToFileURL(path.resolve(path.dirname(source), name)).href));
}
export async function captureFixture(kind: "sqlite" | "postgres" = "sqlite",
  options: { sqliteEncoding?: "UTF-8" | "UTF-16le" | "UTF-16be"; sessions?: boolean;
    legacyPlanned?: boolean; initialGeneration?: number; changeBusinessBeforeEnter?: boolean } = {}) {
  // The real plan forbids destinations within the checkout. The existing S
  // test fixture is rooted in cwd, so create only that private fixture outside it.
  const previous = process.cwd(); let profile;
  try { process.chdir(path.dirname(previous)); profile = await sourceFilesFixture(); }
  finally { process.chdir(previous); }
  let fixture: Awaited<ReturnType<typeof enterFixture>> | undefined, isolated: string | undefined;
  try {
    fixture = await enterFixture(kind, { ...options, directory: profile.directory, drainClient: true });
    if (options.changeBusinessBeforeEnter)
      await fixture.exec("UPDATE enter_observation SET value='changed after preview while admission is still open'");
    if (options.initialGeneration !== undefined) {
      assert(Number.isSafeInteger(options.initialGeneration) && options.initialGeneration >= 0);
      await fixture.exec("UPDATE storage_maintenance SET owner_generation=" + options.initialGeneration);
    }
    const entered = await enterMaintenance(fixture.options, fixture.request);
    assert.equal(entered.status, "paused"); if (entered.status !== "paused") throw new Error("real enter required");
    await fixture.sourceClient!.refresh(); await fixture.sourceClient!.waitForDrain();
    isolated = await mkdtemp(path.join(previous, ".agent-output-c1-copy-"));
    const source = fileURLToPath(new URL("../../src/server/storage/maintenance/source-files.ts", import.meta.url));
    const profileFixture = new URL("./maintenance-source-files.ts", import.meta.url).href;
    let sourceCode = await readFile(source, "utf8");
    sourceCode = absoluteImports(sourceCode.replaceAll('from "./source-file-native.ts"', "from " + JSON.stringify(profileFixture))
      .replaceAll('from "./source-file-profile.ts"', "from " + JSON.stringify(profileFixture)), source);
    const isolatedSource = path.join(isolated, "source-files.ts"); await writeFile(isolatedSource, sourceCode, { mode: 0o600 });
    const state: State = { source: await import(pathToFileURL(isolatedSource).href) as SourceModule, events: [], hook: () => {} };
    states.set(fixture.reference.controlRoot, state);
    const sourceCapture = fileURLToPath(new URL("../../src/server/storage/maintenance/capture.ts", import.meta.url));
    const captureCode = absoluteImports((await readFile(sourceCapture, "utf8"))
      .replaceAll('from "./source-files.ts"', "from " + JSON.stringify(import.meta.url))
      .replaceAll('from "./controller-owner.ts"', "from " + JSON.stringify(import.meta.url)), sourceCapture);
    const isolatedCapture = path.join(isolated, "capture.ts"); await writeFile(isolatedCapture, captureCode, { mode: 0o600 });
    const capture = await import(pathToFileURL(isolatedCapture).href) as typeof import("../../src/server/storage/maintenance/capture.ts");
    const resetReadTimes = () => {
      const set = (file: string) => {
        const stat = lstatSync(file); if (stat.isDirectory()) for (const name of readdirSync(file)) set(path.join(file, name));
        if (!stat.isSymbolicLink()) utimesSync(file, new Date("2035-01-01"), new Date("2025-01-01"));
      };
      for (const root of fixture!.plan.fileRoots) if (!root.expected.absentSegments.length) set(root.path);
    };
    resetReadTimes();
    let request: ContinueRequest = { ...fixture.request, expectedPhase: "planned",
      expectedJournalDigest: entered.ref.journal.sha256, requestId: "first-capture" };
    const f = fixture, dir = isolated, p = profile;
    if (options.legacyPlanned) {
      // This seeds a private legacy input, not a v1 production writer or a
      // re-signed capture/archive. Keep the actual v2 entry as an unselected file.
      const store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source);
      const old = await store.readJson(entered.ref.journal, "journal") as Record<string, unknown>;
      const { sourceClients: _unused, ...body } = old;
      const legacy = await store.putJson("journal", parseJournal({ ...body, formatVersion: 1 }));
      const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
      await f.exec("UPDATE storage_maintenance SET journal_record_ref=" + quote(legacy.ref)
        + ",journal_digest=" + quote(legacy.sha256));
      request = { ...request, expectedJournalDigest: legacy.sha256 };
    }
    const advance = async (event: "observation" | "takeover" | "cancel_intent") => {
      const store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source), adapter = await f.createAdapter();
      let mutex: OperationMutex | undefined;
      try {
        mutex = await adapter.acquireMutex(store.identity, (await adapter.observe()).state);
        const held = mutex;
        return await adapter.withSourceLock("control", async lock => {
          const observed = await lock.observe(), current = observed.state;
          assert(current.journalRecordRef && current.journalDigest);
          const previous = await store.readAnchoredJournal({ ref: current.journalRecordRef, sha256: current.journalDigest });
          const chain = await verifyJournalChain(store, previous), last = chain.nodes.at(-1)!.record;
          const record = parseJournal({ ...last, previous, event, sequence: last.sequence + 1,
            requestId: "fixture-" + event + "-" + (last.sequence + 1), requestDigest: digestJson({ event, previous }),
            ownerGeneration: last.ownerGeneration + (event === "takeover" ? 1 : 0),
            frozen: null, snapshot: null, ...(last.formatVersion === 2 ? { sourceClients: null } : {}) });
          const journal = await store.putJson("journal", record); await verifyJournalChain(store, journal);
          await lock.anchor({ expected: current, admission: current.admission, fenceEpoch: current.fenceEpoch,
            ownerGeneration: record.ownerGeneration, activeMigrationId: current.activeMigrationId, planDigest: current.planDigest,
            controlRootIdentity: { ...store.identity }, mutexIdentity: held.identity, journal, journalSequence: record.sequence });
          return journal;
        });
      } finally { try { await mutex?.release(); } finally { await adapter.close(); } }
    };
    return { ...f, entered, request, profile: p, state, resetReadTimes, capture: capture.captureMaintenance,
      advance,
      async close() {
        states.delete(f.reference.controlRoot);
        try { await f.close(); } finally { await p.close(); await rm(dir, { recursive: true, force: true }); }
      } };
  } catch (error) {
    try { await fixture?.close(); } finally {
      await profile.close(); if (isolated) await rm(isolated, { recursive: true, force: true });
    }
    throw error;
  }
}

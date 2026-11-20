import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withNativeSourceRoot as nativeRoot } from "../../src/server/storage/maintenance/source-file-native.ts";
import type { SourceFileHandle, SourceFileExtendedObservation, SourceFileStatxObservation, SourceFileMetadataTail, SourceFileExpectedProfile } from "../../src/server/storage/maintenance/source-file-native.ts";
import { ArtifactStore } from "../../src/server/storage/maintenance/objects.ts";
import { canonicalJson, digestJson } from "../../src/server/storage/maintenance/canonical.ts";
import { MaintenanceFailure } from "../../src/server/storage/maintenance/error.ts";
import { observePlannedPath } from "../../src/server/storage/maintenance/plan.ts";
import { buildDatabaseManifests } from "../../src/server/storage/maintenance/manifests.ts";
import type { MigrationPlan, OperationMutex, PersistedPlanRef, SourceLock, SourceObservation, SourceClientsObservation } from "../../src/server/storage/maintenance/types.ts";

/** TEST ONLY. Real private files, native owners and ArtifactStore bytes are used,
 * but ext4 identity, profile, health and lock facts below are explicitly synthetic.
 * An isolated copy of S imports this fixture; production has no override or test
 * registry. Success here is never source-preservation/native qualification. */
type Hook = (operation: string, file: string, value?: unknown) => void;
type UniqueStatx = Omit<SourceFileStatxObservation, "mountId"> & { readonly uniqueMountId: bigint | null };
interface FixtureHandle extends SourceFileHandle { observeStatxUnique(): UniqueStatx }
interface State {
  readonly directory: string;
  readonly handles: Set<FixtureHandle>;
  readonly roots: WeakSet<FixtureHandle>;
  readonly events: string[];
  readonly identities: Map<string, string>;
  readonly attributes: Map<string, readonly { name: Buffer; value: Buffer }[]>;
  readonly flags: Map<string, bigint>;
  hook: Hook;
  windows: number;
  maxHandles: number;
  health: string;
  mountDelta: bigint;
  prepare: boolean;
}
export const SOURCE_PREPARE_PROFILE = "linux-native-ext4-fid-fsuuid-source-prepare-v1" as const;
const states = new Map<string, State>();
const owners = new WeakMap<FixtureHandle, { state: State; file: string; active: () => boolean; transfer: () => () => Promise<void> }>();
const fixtureTails = new WeakMap<FixtureHandle, Set<SourceFileMetadataTail>>();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
let nativePreparation: Promise<void> | undefined;
function prepareNativeFixture(): Promise<void> {
  if (process.platform !== "linux") return Promise.resolve();
  // A fixture cannot depend on another test file having built this candidate.
  // Keep both fulfillment and rejection for this module; never retry a failed
  // build or infer validity from an addon left by a previous checkout.
  return nativePreparation ??= Promise.resolve().then(() => {
    const built = spawnSync(process.execPath,
      [fileURLToPath(new URL("../../scripts/build-maintenance-platform.mjs", import.meta.url)), "--source-files"],
      { cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8", timeout: 65_000 });
    if (built.error !== undefined) throw built.error;
    if (built.status !== 0 || built.signal !== null)
      throw new Error(`source-files fixture native build failed (${built.status}/${built.signal}): ${built.stderr.slice(0, 4096)}`);
  });
}
function stateFor(file: string): State {
  const state = [...states.values()].find(item => file === item.directory || file.startsWith(item.directory + path.sep)
    || file === path.dirname(item.directory));
  if (!state) throw new Error("fixture source outside private root");
  return state;
}
function wrap(raw: SourceFileHandle, file: string, state: State, active: () => boolean, root: boolean): FixtureHandle {
  let closed = false;
  let closing: Promise<void> | undefined;
  const call = (operation: string, value?: unknown) => {
    if (closed || !active()) throw new MaintenanceFailure("maintenance_lost", "fixture-owner");
    state.events.push(operation + ":" + path.relative(state.directory, file)); state.hook(operation, file, value);
  };
  const metadata = (value: SourceFileExtendedObservation["before"]) => ({ ...value, fsType: 0xef53n });
  const statx = (): SourceFileStatxObservation => {
    const observed = raw.observeStatx();
    // Explicitly inert ext4 shape, like the UUID/FID/profile below. The host's
    // real statx mask does not qualify its filesystem for this S control test.
    return { ...observed, attributes: observed.attributes & ~0x200800n,
      attributesMask: observed.attributesMask | 0x200800n, mountId: 71n + state.mountDelta };
  };
  const handle: FixtureHandle = {
    kind: raw.kind,
    observe() { call("observe"); return { ...raw.observe(), fsType: 0xef53n }; },
    observeStatx() { call("statx-legacy"); const result = statx(); state.hook("statx-legacy-result", file, result); return result; },
    observeStatxUnique() {
      call("statx-unique"); const { mountId: _, ...value } = statx();
      const result = { ...value, mask: (value.mask & ~0x1000n) | 0x4000n, uniqueMountId: 9001n + state.mountDelta };
      state.hook("statx-unique-result", file, result); return result;
    },
    observeExtended() {
      call("extended"); const value = raw.observeExtended();
      const nativeKey = String(value.before.dev) + ":" + String(value.before.ino);
      const incarnation = state.identities.get(file) ?? digest(nativeKey).slice(0, 16);
      const fact = <T>(value: T, operation: string) => ({ status: "observed" as const, reason: null,
        value, calls: [{ operation, rc: 0n, errno: 0n }] });
      const result: SourceFileExtendedObservation = { ...value, before: metadata(value.before), after: metadata(value.after),
        uuid: fact({ length: 16n, bytes: Buffer.from("41".repeat(16), "hex") }, "ioctl-getfsuuid"),
        fid: fact({ handleType: 1n, handleBytes: 8n, mountId: 9001n + state.mountDelta, bytes: Buffer.from(incarnation, "hex") }, "name-to-handle-at"),
        inodeFlags: fact(state.flags.get(file) ?? 0x80000n, "ioctl-getflags"),
        xattrs: fact(state.attributes.get(file) ?? [], "flistxattr-fixture") };
      state.hook("extended-result", file, result); return result;
    },
    openChild(leaf, kind) {
      call("open-child", leaf);
      return wrap(raw.openChild(leaf, kind), path.join(file, leaf), state, active, false);
    },
    readAt(offset, length) { call("read", { offset, length }); return raw.readAt(offset, length); },
    readDirectory() { call("enumerate"); return raw.readDirectory(); },
    reopenFile() { call("reopen-file"); return wrap(raw.reopenFile(), file, state, active, root); },
    async synchronize() { call("synchronize"); await raw.synchronize(); call("synchronized"); },
    closeAsync() {
      if (closing) return closing;
      call("closing");
      return closing = raw.closeAsync().finally(() => { closed = true; state.handles.delete(handle); }).then(() => {
        state.events.push("closed:" + path.relative(state.directory, file)); state.hook("closed", file);
      });
    },
    close() {
      call("closing");
      // Close the real owner even when a test requests a synthetic unknown-close
      // result. No test relies on leaking/reclaiming an actual numeric FD.
      try { raw.close(); } finally { closed = true; state.handles.delete(handle); }
      state.events.push("closed:" + path.relative(state.directory, file)); state.hook("closed", file);
    },
  };
  owners.set(handle, { state, file, active: () => active() && !closed, transfer: () => {
    call("transfer-carrier"); closed = true; state.handles.delete(handle);
    return () => closing ??= raw.closeAsync().then(() => { state.events.push("closed-carrier:" + path.relative(state.directory, file)); state.hook("closed-carrier", file); });
  } });
  state.handles.add(handle); state.maxHandles = Math.max(state.maxHandles, state.handles.size);
  if (root) state.roots.add(handle);
  return handle;
}
export async function withNativeSourceRoot<T>(file: string, consume: (handle: FixtureHandle) => Promise<T> | T,
  expected?: SourceFileExpectedProfile): Promise<T> {
  const state = stateFor(file), kind = lstatSync(file).isDirectory() ? "directory" : "file";
  if (expected && (expected.profile !== (state.prepare ? SOURCE_PREPARE_PROFILE : "linux-native-ext4-fid-fsuuid-source-state-v1")
    || expected.profileEntryDigest !== digest("fixture-profile-only") || expected.qualificationDigest !== digest("no-qualification")))
    throw new MaintenanceFailure("source_changed", "fixture-frozen-profile-before-open");
  let active = true;
  return nativeRoot(kind === "directory" ? file : path.dirname(file), async native => {
    const raw = kind === "directory" ? native : native.openChild(path.basename(file), "file");
    const root = wrap(raw, file, state, () => active, true);
    let failed = false, first: unknown, result: T | undefined;
    try { result = await consume(root); } catch (error) { failed = true; first = error; }
    const closeErrors: unknown[] = [];
    try { if (state.handles.has(root)) root.close(); } catch (error) { closeErrors.push(error); }
    const tails = [...fixtureTails.get(root) ?? []];
    if (!failed && tails.length) { failed = true; first = new MaintenanceFailure("maintenance_lost", "fixture-unclosed-tail"); }
    for (const tail of tails) try { await tail.closeAsync(); } catch (error) { closeErrors.push(error); }
    active = false;
    if (closeErrors.length) throw new AggregateError(failed ? [first, ...closeErrors] : closeErrors,
      "fixture-source-close", { cause: failed ? first : closeErrors[0] });
    if (failed) throw first;
    return result!;
  });
}
export function withNativeSourcePreviewFile<T>(file: string, consume: (handle: FixtureHandle) => Promise<T> | T): Promise<T> {
  if (!stateFor(file).prepare) return Promise.reject(new MaintenanceFailure("backup_capability_unavailable", "fixture-preview-profile"));
  return withNativeSourceRoot(file, consume);
}
const healthNames = ["errors_count", "first_error_errcode", "last_error_errcode", "first_error_ino", "last_error_ino",
  "first_error_block", "last_error_block", "first_error_line", "last_error_line", "first_error_time", "last_error_time",
  "first_error_func", "last_error_func"] as const;
export function matchSourceFileProfile(root: FixtureHandle) {
  const owned = owners.get(root);
  if (!owned || !owned.active() || !owned.state.roots.has(root)) throw new MaintenanceFailure("maintenance_lost", "fixture-profile");
  const { state, file } = owned;
  const observe = (stage: string) => {
    if (!owned.active()) throw new MaintenanceFailure("maintenance_lost", "fixture-profile");
    state.events.push("profile:" + stage); state.hook("profile:" + stage, file);
    if (state.health !== "0\n") throw new MaintenanceFailure("backup_capability_unavailable", "fixture-health");
    const uniqueStatx = root.observeStatxUnique();
    const result = { root: root.observeExtended(), uniqueStatx,
      mount: { legacyMountId: 71n + state.mountDelta, uniqueMountId: 9001n + state.mountDelta,
        devMajor: uniqueStatx.devMajor, devMinor: uniqueStatx.devMinor, filesystemType: "ext4" as const,
        root: "/", point: state.directory, attributes: 0n, superblockFlags: 0n, propagation: 0n },
      health: Object.fromEntries(healthNames.map((name, i) => [name, { bytes: Buffer.from(state.health),
        device: 1n, inode: BigInt(i + 1), mode: 0o100444n, filesystemType: 0x62656572n,
        calls: [{ operation: "fixture-read-eof-close", rc: 0n, errno: 0n }] }])),
      runtimeEnvironmentDigest: digest("fixture-window-" + (++state.windows)) };
    state.hook("profile:" + stage + "-result", file, result); return result;
  };
  const tails = new WeakMap<object, { context: ReturnType<typeof observe>; closeCarrier?: () => Promise<void> }>();
  return { profile: state.prepare ? SOURCE_PREPARE_PROFILE : "linux-native-ext4-fid-fsuuid-source-state-v1" as const, source: root.observe(),
    profileEntryDigest: digest("fixture-profile-only"), qualificationDigest: digest("no-qualification"),
    observe: () => observe("observe"), beforeContent: () => observe("before"), afterContent: () => observe("after"),
    // TEST ONLY: health/profile/tail observations are synthetic. R/V/F still
    // use real native owners; the native M/A transfer is separately exercised
    // in maintenance-source-file-prepare-native.test.ts, never qualified here.
    retainMetadata(): SourceFileMetadataTail {
      const value: { context: ReturnType<typeof observe>; closeCarrier?: () => Promise<void> } = { context: observe("metadata-tail") };
      let closing: Promise<void> | undefined;
      const tail: SourceFileMetadataTail = {
        transferCarrier(carrier) {
          const actual = owners.get(carrier as FixtureHandle);
          if (!actual || actual.state !== state || value.closeCarrier) throw new Error("fixture-tail-carrier");
          value.closeCarrier = actual.transfer();
        },
        observe() { throw new Error("synthetic tail is observed only by its fixture profile"); },
        closeAsync() {
          return closing ??= Promise.resolve().then(async () => {
            try { await value.closeCarrier?.(); }
            finally {
              fixtureTails.get(root)?.delete(tail);
              state.events.push("closed-metadata:" + path.relative(state.directory, file)); state.hook("closed-metadata", file);
            }
          });
        },
      };
      let ownedTails = fixtureTails.get(root);
      if (!ownedTails) { ownedTails = new Set(); fixtureTails.set(root, ownedTails); }
      ownedTails.add(tail);
      tails.set(tail, value); return tail;
    },
    afterSourceClosed(tail: SourceFileMetadataTail) {
      const value = tails.get(tail); if (!value?.closeCarrier) throw new Error("fixture-tail-unattached");
      state.events.push("profile:tail"); state.hook("profile:tail", file);
      if (state.health !== "0\n") throw new MaintenanceFailure("backup_capability_unavailable", "fixture-health");
      const current = lstatSync(file, { bigint: true }), metadata = { ...value.context.root.before };
      for (const name of ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "atimeNs", "mtimeNs", "ctimeNs"] as const) metadata[name] = current[name];
      return { metadata, mount: value.context.mount, health: value.context.health,
        runtimeEnvironmentDigest: digest("fixture-tail-" + (++state.windows)) };
    } };
}

/** Isolate only the native/profile imports. Production source is otherwise exact;
 * optional budget literals are changed solely in this test copy. */
export async function isolatedSourceFiles(limits: Readonly<Record<string, string>> = {}) {
  const source = fileURLToPath(new URL("../../src/server/storage/maintenance/source-files.ts", import.meta.url));
  let code = await readFile(source, "utf8");
  const fixture = import.meta.url;
  code = code.replaceAll('from "./source-file-native.ts"', `from ${JSON.stringify(fixture)}`)
    .replaceAll('from "./source-file-profile.ts"', `from ${JSON.stringify(fixture)}`)
    .replace(/from "(\.\/[^"\n]+)"/g, (_, name: string) => `from ${JSON.stringify(pathToFileURL(path.resolve(path.dirname(source), name)).href)}`);
  for (const [original, replacement] of Object.entries(limits)) {
    if (!code.includes(original)) throw new Error("missing isolated budget literal");
    code = code.replace(original, replacement);
  }
  const directory = await mkdtemp(path.join(process.cwd(), ".agent-output-s-copy-"));
  const target = path.join(directory, "source-files.ts"); await writeFile(target, code, { mode: 0o600 });
  try { return { module: await import(pathToFileURL(target).href) as typeof import("../../src/server/storage/maintenance/source-files.ts"),
    close: () => rm(directory, { recursive: true, force: true }) }; }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

export async function isolatedSourcePreview() {
  const source = fileURLToPath(new URL("../../src/server/storage/maintenance/source-file-preview.ts", import.meta.url));
  const fixture = import.meta.url;
  const code = (await readFile(source, "utf8"))
    .replaceAll('from "./source-file-native.ts"', `from ${JSON.stringify(fixture)}`)
    .replaceAll('from "./source-file-profile.ts"', `from ${JSON.stringify(fixture)}`)
    .replace(/from "(\.\/[^"\n]+)"/g, (_, name: string) => `from ${JSON.stringify(pathToFileURL(path.resolve(path.dirname(source), name)).href)}`);
  const directory = await mkdtemp(path.join(process.cwd(), ".agent-output-preview-copy-"));
  const target = path.join(directory, "preview.ts"); await writeFile(target, code, { mode: 0o600 });
  try { return { module: await import(pathToFileURL(target).href) as typeof import("../../src/server/storage/maintenance/source-file-preview.ts"),
    close: () => rm(directory, { recursive: true, force: true }) }; }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

export async function sourceFilesFixture(options: { sessions?: "present" | "absent"; config?: boolean; prepare?: boolean } = {}) {
  await prepareNativeFixture();
  const directory = await mkdtemp(path.join(process.cwd(), "maintenance-s-test-"));
  chmodSync(directory, 0o700);
  const config = path.join(directory, "config.json"), sessions = path.join(directory, "sessions"), database = path.join(directory, "source.db");
  const expected = Buffer.concat([Buffer.alloc(65_536, 0x7a), Buffer.from([0, 0xff, 0x80, 1, 10])]);
  if (options.config !== false) writeFileSync(config, Buffer.from([0x7b, 0x7d, 10]), { mode: 0o600 });
  if (options.sessions !== "absent") {
    mkdirSync(sessions, { mode: 0o700 }); mkdirSync(path.join(sessions, "nested"), { mode: 0o700 });
    writeFileSync(path.join(sessions, "nested", "binary"), expected, { mode: 0o600 });
    writeFileSync(path.join(sessions, "empty"), Buffer.alloc(0), { mode: 0o600 });
  }
  writeFileSync(database, "synthetic-lock-database-boundary", { mode: 0o600 });
  const db = lstatSync(database, { bigint: true });
  const sourceIdentity = { kind: "sqlite", sourcePath: directory, sqlitePath: database, device: String(db.dev), inode: String(db.ino) };
  const source = { kind: "sqlite" as const, databaseInstanceId: "1".repeat(32), identityDigest: digestJson(sourceIdentity) };
  const store = await ArtifactStore.create(path.join(directory, "control"), source);
  const manifests = buildDatabaseManifests("sqlite", { fixture: true }, [], { storage_maintenance: [], storage_source_clients: [] });
  const roots: MigrationPlan["fileRoots"][number][] = [];
  if (options.config !== false) roots.push({ label: "config", path: config, expected: await observePlannedPath(config) });
  roots.push({ label: "managed-sessions", path: sessions, expected: await observePlannedPath(sessions) });
  const plan: MigrationPlan = { formatVersion: 1, kind: "plan", migrationId: "source-files-fixture", source, sourceIdentity,
    originalCwd: directory, originalConfigPath: options.config === false ? null : config,
    configDigest: options.config === false ? digestJson({ configFile: null }) : digest("{}\n"), effectiveConfigDigest: digest("fixture-effective"),
    schemaManifestDigest: manifests.schemaManifestDigest, guardManifestDigest: digest("fixture-guard"),
    controlRoot: await observePlannedPath(store.root), targetRoot: await observePlannedPath(path.join(directory, "target")), fileRoots: roots,
    preview: { observedAt: "2026-11-17T00:00:00.000Z", dataDigest: manifests.fullDataManifestDigest, tableCounts: {}, clientInventory: [] },
    requiredCapabilities: [], blockers: [] };
  const immutablePlan = await store.putJson("plan", plan);
  const reference: PersistedPlanRef = { migrationId: plan.migrationId, planDigest: immutablePlan.sha256, immutablePlan, controlRoot: store.root };
  const mutexIdentity = { fixture: "explicitly-synthetic-lock" };
  let observation: SourceObservation = { source, sourceIdentity, manifests, clients: [], state: {
    databaseInstanceId: source.databaseInstanceId, admission: "draining", fenceEpoch: 1, ownerGeneration: 1,
    activeMigrationId: plan.migrationId, planDigest: immutablePlan.sha256,
    controlRootJson: canonicalJson(store.identity), mutexIdentityJson: canonicalJson(mutexIdentity),
    journalRecordRef: "journals/source-files-fixture/1-" + "1".repeat(64) + ".json", journalDigest: "1".repeat(64), journalSequence: 1,
    protocolVersion: 1, guardManifestDigest: plan.guardManifestDigest } };
  let held = true;
  const assertHeld = async () => { if (!held) throw new MaintenanceFailure("maintenance_lost", "fixture-lock"); };
  const raw = (): SourceClientsObservation => ({ source: observation.source, sourceIdentity: observation.sourceIdentity,
    state: observation.state, schemaManifestDigest: observation.manifests.schemaManifestDigest, textEncoding: { backend: "sqlite", name: "UTF-8" }, rows: [] });
  const lock: SourceLock = { assertHeld, observe: async () => structuredClone(observation), observeSourceClients: async () => structuredClone(raw()),
    withSourceClientFacts: async () => { throw new Error("S must not manufacture outer C facts"); },
    readSourceClientAudit: async () => { throw new Error("not an audit fixture"); },
    anchor: async () => { throw new Error("S must not anchor"); }, backup: async () => { throw new Error("S must not back up a DB"); } };
  const mutex: OperationMutex = { identity: mutexIdentity, assertHeld, release: async () => { held = false; } };
  const state: State = { directory, handles: new Set(), roots: new WeakSet(), events: [], identities: new Map(), attributes: new Map(), flags: new Map(),
    hook: () => {}, windows: 0, maxHandles: 0, health: "0\n", mountDelta: 0n, prepare: false };
  states.set(directory, state);
  const resetReadTimes = () => {
    // P2 has no O_NOATIME promise. This fixture prepares ordinary relatime data
    // with future atime; it does not claim P3/source-preservation qualification.
    const set = (file: string) => {
      const info = lstatSync(file); if (info.isDirectory()) for (const name of readdirSync(file)) set(path.join(file, name));
      if (!info.isSymbolicLink()) utimesSync(file, new Date("2035-01-01"), new Date("2025-01-01"));
    };
    if (options.config !== false) set(config);
    if (options.sessions !== "absent") set(sessions);
    utimesSync(directory, new Date("2035-01-01"), new Date("2025-01-01"));
  };
  resetReadTimes();
  state.prepare = options.prepare === true;
  return { directory, config, sessions, database, expected, store, plan, reference, lock, mutex, state, resetReadTimes,
    loseLock: () => { held = false; }, changeObservation: (change: (value: SourceObservation) => SourceObservation) => { observation = change(observation); },
    close: async () => { states.delete(directory); await rm(directory, { recursive: true, force: true }); } };
}

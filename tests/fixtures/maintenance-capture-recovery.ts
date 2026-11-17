import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { captureFixture } from "./maintenance-capture.ts";
import type { PostgresDriver } from "../../src/server/db/drivers/postgres.ts";
import { checksumOf, migrationSql } from "../../src/server/db/migrate.ts";
import { migrations } from "../../src/server/db/migrations/index.ts";
import { ArtifactStore } from "../../src/server/storage/maintenance/objects.ts";
import { verifyJournalChain } from "../../src/server/storage/maintenance/journal.ts";
import { parseJournal } from "../../src/server/storage/maintenance/parse.ts";
import type { ControllerOwner } from "../../src/server/storage/maintenance/controller-owner.ts";
import type { OperationMutex, SourceLock } from "../../src/server/storage/maintenance/types.ts";

export interface RecoveryEvent {
  readonly event: string;
  readonly owner: ControllerOwner;
  readonly stage?: number;
  readonly kind?: "control" | "snapshot";
}
type RecoveryOptions = NonNullable<Parameters<typeof captureFixture>[1]>
  & { readonly postgresEncoding?: "UTF8" | "LATIN1" | "SQL_ASCII";
    /** Observe only successful real acquisitions by this fixture invocation. */
    readonly onTemporaryDirectory?: (directory: string) => void };

/** Private fixture initialization only. The original SQL contains UTF8 comments;
 * transmit its exact bytes as in the existing non-UTF8 source-audit fixtures.
 * This bootstrap driver is closed by enterFixture's original finally. Every
 * later source/client/maintenance connection keeps the production UTF8 setting. */
export async function migrateRecoveryPostgres(driver: PostgresDriver, encoding: "LATIN1" | "SQL_ASCII"): Promise<void> {
  if (encoding === "LATIN1") await driver.query("SET client_encoding='SQL_ASCII'");
  assert.equal((await driver.query("SHOW server_encoding"))[0]!.server_encoding, encoding);
  assert.equal((await driver.query("SHOW client_encoding"))[0]!.client_encoding, encoding === "LATIN1" ? "SQL_ASCII" : "UTF8");
  await driver.migrate(migrations);
  const ledger = await driver.query("SELECT version::text AS version,name,checksum FROM schema_migrations ORDER BY schema_migrations.version");
  assert.deepEqual(ledger, migrations.map(migration => ({ version: String(migration.version), name: migration.name,
    checksum: checksumOf(migrationSql(migration, "postgres")) })));
}

function relocateFixture(code: string, original: URL): string {
  return code.replace(/^((?:import|export) [^\n]*? from )"(\.[^"\n]+)"/gm,
    (_, prefix: string, relative: string) => prefix + JSON.stringify(new URL(relative, original).href))
    .replace(/new URL\("(\.[^"\n]+)", import\.meta\.url\)/g,
      (_, relative: string) => "new URL(" + JSON.stringify(new URL(relative, original).href) + ")");
}

/** Actual DB/adapter/mutex/transactions/backup. The inherited S/P profile alone
 * is synthetic engineering evidence; this fixture never qualifies production. */
export async function recoveryFixture(kind: "sqlite" | "postgres" = "sqlite",
  options: RecoveryOptions = {}) {
  let directory: string | undefined, inputDirectory: string | undefined;
  let created: Awaited<ReturnType<typeof captureFixture>> | undefined;
  try {
    let fixtureFactory = captureFixture, delegates = new URL("./maintenance-capture.ts", import.meta.url).href;
    const { postgresEncoding, onTemporaryDirectory, ...baseOptions } = options;
    if (kind === "postgres" && postgresEncoding && postgresEncoding !== "UTF8") {
      assert(["LATIN1", "SQL_ASCII"].includes(postgresEncoding));
      // Fixed database encoding and the private bootstrap session only. The
      // complete original migration bytes/checksums, later UTF8 connections,
      // registration/drain/native raw readers and C/D implementations stay intact.
      inputDirectory = await mkdtemp(path.join(process.cwd(), ".agent-output-c2-input-"));
      onTemporaryDirectory?.(inputDirectory);
      const entry = new URL("./maintenance-enter.ts", import.meta.url), capture = new URL("./maintenance-capture.ts", import.meta.url);
      let entryCode = await readFile(entry, "utf8");
      assert.equal(entryCode.split("ENCODING 'UTF8'").length, 2);
      assert.equal(entryCode.split("await driver.migrate(migrations);").length, 2);
      entryCode = 'import { migrateRecoveryPostgres } from ' + JSON.stringify(import.meta.url) + ';\n' + entryCode
        .replace("await driver.migrate(migrations);", "await migrateRecoveryPostgres(driver, " + JSON.stringify(postgresEncoding) + ");");
      entryCode = relocateFixture(entryCode.replace("ENCODING 'UTF8'", "ENCODING '" + postgresEncoding + "'"), entry);
      const entryPath = path.join(inputDirectory, "maintenance-enter.ts"); await writeFile(entryPath, entryCode, { mode: 0o600 });
      const captureCode = relocateFixture((await readFile(capture, "utf8"))
        .replace('from "./maintenance-enter.ts"', "from " + JSON.stringify(pathToFileURL(entryPath).href)), capture);
      const capturePath = path.join(inputDirectory, "maintenance-capture.ts"); await writeFile(capturePath, captureCode, { mode: 0o600 });
      delegates = pathToFileURL(capturePath).href;
      fixtureFactory = (await import(delegates) as typeof import("./maintenance-capture.ts")).captureFixture;
    }
    const f = await fixtureFactory(kind, baseOptions); created = f;
    directory = await mkdtemp(path.join(process.cwd(), ".agent-output-c2-copy-"));
    onTemporaryDirectory?.(directory);
    const source = fileURLToPath(new URL("../../src/server/storage/maintenance/capture.ts", import.meta.url));
    const code = (await readFile(source, "utf8"))
      .replaceAll('from "./source-files.ts"', "from " + JSON.stringify(delegates))
      .replaceAll('from "./controller-owner.ts"', "from " + JSON.stringify(delegates))
      .replace(/from "(\.\/[^"\n]+)"/g,
        (_, name: string) => "from " + JSON.stringify(pathToFileURL(path.resolve(path.dirname(source), name)).href));
    const isolated = path.join(directory, "capture.ts"); await writeFile(isolated, code, { mode: 0o600 });
    const module = await import(pathToFileURL(isolated).href) as typeof import("../../src/server/storage/maintenance/capture.ts");
    assert.equal(typeof module.captureSnapshotMaintenance, "function", "the fixed C2 entry must exist");
    const events: RecoveryEvent[] = [];
    const recovery: {
      onOwner?: (owner: ControllerOwner) => void;
      onLock?: (lock: SourceLock, stage: number, kind: "control" | "snapshot") => Promise<void> | void;
      afterSourceClose?: (stage: number, kind: "control" | "snapshot") => Promise<void> | void;
    } = {};
    f.state.onOwner = owner => {
      events.push({ event: "owner", owner });
      let stage = 0;
      const acquire = owner.adapter.acquireMutex;
      owner.adapter.acquireMutex = async function(...args) {
        const mutex = await acquire.apply(owner.adapter, args), release = mutex.release;
        events.push({ event: "mutex-acquired", owner });
        mutex.release = async () => {
          events.push({ event: "mutex-release-begin", owner }); await release.call(mutex);
          events.push({ event: "mutex-release-end", owner });
        };
        return mutex;
      };
      const withLock = owner.adapter.withSourceLock;
      owner.adapter.withSourceLock = async function<T>(lockKind: "control" | "snapshot", consume: (lock: SourceLock) => Promise<T>): Promise<T> {
        const current = ++stage;
        events.push({ event: "source-begin", owner, stage: current, kind: lockKind });
        const result = await withLock.call(owner.adapter, lockKind, async lock => {
          await recovery.onLock?.(lock, current, lockKind);
          const result = await consume(lock);
          events.push({ event: "callback-end", owner, stage: current, kind: lockKind });
          return result;
        }) as T;
        events.push({ event: "source-end", owner, stage: current, kind: lockKind });
        await recovery.afterSourceClose?.(current, lockKind);
        return result;
      };
      const close = owner.adapter.close;
      owner.adapter.close = async () => {
        events.push({ event: "adapter-close-begin", owner }); await close.call(owner.adapter);
        events.push({ event: "adapter-close-end", owner });
      };
      recovery.onOwner?.(owner);
    };
    // Appends only a new, generically valid private fixture node. Existing
    // captures, receipts, Fs and source rows are never rewritten or re-signed.
    // Keep the inherited advance() unchanged for ordinary other-key steps.
    const advanceRequest = async (event: "observation" | "takeover",
      request: { readonly requestId: string; readonly requestDigest: string }) => {
      const store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source), adapter = await f.createAdapter();
      let mutex: OperationMutex | undefined;
      try {
        mutex = await adapter.acquireMutex(store.identity, (await adapter.observe()).state);
        const held = mutex;
        return await adapter.withSourceLock("control", async lock => {
          const current = (await lock.observe()).state;
          assert(current.journalRecordRef && current.journalDigest);
          const previous = await store.readAnchoredJournal({ ref: current.journalRecordRef, sha256: current.journalDigest });
          const chain = await verifyJournalChain(store, previous), last = chain.nodes.at(-1)!.record;
          const record = parseJournal({ ...last, previous, event, sequence: last.sequence + 1,
            requestId: request.requestId, requestDigest: request.requestDigest,
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
    const dir = directory, inputs = inputDirectory;
    return { ...f, recovery, events, advanceRequest, captureSnapshot: module.captureSnapshotMaintenance,
      async close() { try { await f.close(); } finally {
        await rm(dir, { recursive: true, force: true }); if (inputs) await rm(inputs, { recursive: true, force: true });
      } } };
  } catch (error) {
    try { await created?.close(); } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
      if (inputDirectory) await rm(inputDirectory, { recursive: true, force: true });
    }
    throw error;
  }
}

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { captureFixture } from "./maintenance-capture.ts";
import type { ControllerOwner } from "../../src/server/storage/maintenance/controller-owner.ts";
import type { SourceLock } from "../../src/server/storage/maintenance/types.ts";

export interface RecoveryEvent {
  readonly event: string;
  readonly owner: ControllerOwner;
  readonly stage?: number;
  readonly kind?: "control" | "snapshot";
}
type RecoveryOptions = NonNullable<Parameters<typeof captureFixture>[1]>
  & { readonly postgresEncoding?: "UTF8" | "LATIN1" | "SQL_ASCII" };

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
    const { postgresEncoding, ...baseOptions } = options;
    if (kind === "postgres" && postgresEncoding && postgresEncoding !== "UTF8") {
      assert(["LATIN1", "SQL_ASCII"].includes(postgresEncoding));
      // Only this fixed test input's CREATE DATABASE encoding changes. Real
      // registration/drain/native raw readers and every C/D implementation stay
      // intact; no server catalog mutation or byte decoder substitutes for PG.
      inputDirectory = await mkdtemp(path.join(process.cwd(), ".agent-output-c2-input-"));
      const entry = new URL("./maintenance-enter.ts", import.meta.url), capture = new URL("./maintenance-capture.ts", import.meta.url);
      let entryCode = await readFile(entry, "utf8");
      assert.equal(entryCode.split("ENCODING 'UTF8'").length, 2);
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
    const dir = directory, inputs = inputDirectory;
    return { ...f, recovery, events, captureSnapshot: module.captureSnapshotMaintenance,
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

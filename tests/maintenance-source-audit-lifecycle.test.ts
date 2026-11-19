import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { protocolSqliteAuditFixture as sqliteAuditFixture } from "./fixtures/maintenance-source-audit.ts";
import type { OperationMutex } from "../src/server/storage/maintenance/types.ts";
import { withSqliteSourceInventoryDiagnostics } from "./fixtures/maintenance-source-inventory-diagnostic.ts";

test("A12-B SQLite observed mutex loss cannot revive an invocation's bootstrap actor", async t => {
  for (const entry of ["source-lock", "direct-mutex", "before-first-audit"] as const) await t.test(entry, async () => {
    const f = await sqliteAuditFixture(false);
    const mutexPath = path.join(f.store.identity.path, "mutex.sqlite"), saved = mutexPath + ".original";
    let displaced = false, nextMutex: OperationMutex | undefined;
    let reads = 0;
    const read = () => withSqliteSourceInventoryDiagnostics(f.adapter, async phase => {
      phase(`audit-lifecycle-${entry}-${++reads}`);
      return f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference));
    });
    try {
      const first = entry === "before-first-audit" ? undefined : await read();
      const original = await stat(mutexPath, { bigint: true });
      await rename(mutexPath, saved); displaced = true;
      await copyFile(saved, mutexPath);
      assert.notEqual((await stat(mutexPath, { bigint: true })).ino, original.ino);
      // Both public entries must observe the real, different bound inode.
      await assert.rejects(entry === "source-lock" ? read() : f.mutex.assertHeld(), { code: "maintenance_lost" });
      await rm(mutexPath); await rename(saved, mutexPath); displaced = false;
      assert.equal((await stat(mutexPath, { bigint: true })).ino, original.ino);
      // The ordinary mutex check can pass again; its private audit owner must stay lost.
      await f.mutex.assertHeld();
      await assert.rejects(read(), { code: "maintenance_lost" });
      await f.mutex.release();
      nextMutex = await f.adapter.acquireMutex(f.store.identity, (await f.adapter.observe()).state);
      const next = await read();
      if (first) assert.notEqual(next.facts.actor.actorId, first.facts.actor.actorId);
      const sameInvocation = await read();
      assert.equal(sameInvocation.facts.actor.actorId, next.facts.actor.actorId,
        "normal SourceLock completion preserves this new invocation's actor");
    } finally {
      if (displaced) { await rm(mutexPath, { force: true }); await rename(saved, mutexPath); }
      await nextMutex?.release(); await f.close();
    }
  });
});

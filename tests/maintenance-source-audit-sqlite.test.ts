import test from "node:test";
import assert from "node:assert/strict";
import { hostname } from "node:os";
import { readFile, readlink, stat } from "node:fs/promises";
import Database from "better-sqlite3";
import { protocolSqliteAuditFixture as sqliteAuditFixture } from "./fixtures/maintenance-source-audit.ts";
import { registerExitedAuditClient } from "./fixtures/maintenance-audit-history-child.ts";
import { eventFactsSchema, checkFactsShape } from "../src/server/storage/maintenance/control-candidate/schema.ts";
import { storageReceiptDigest } from "../src/server/storage/source-client.ts";
import type { SourceLock } from "../src/server/storage/maintenance/types.ts";
import { BootstrapAuditFactory } from "../src/server/storage/maintenance/native-audit.ts";
import { withSqliteSourceInventoryDiagnostics } from "./fixtures/maintenance-source-inventory-diagnostic.ts";

test("A12-B retains actual ordinary-client audit and private bootstrap identity without control writes", async t => {
  const f = await sqliteAuditFixture();
  try {
    await f.adapter.withSourceLock("control", async lock => {
      const before = await lock.observeSourceClients();
      assert.equal(typeof lock.readSourceClientAudit, "function", "the accepted native audit entry must exist");
      const packet = await lock.readSourceClientAudit(f.reference);
      assert.equal(packet.kind, "untrusted-source-client-audit");
      assert.deepEqual(packet.observation, before);
      assert.deepEqual(packet.origin.head, f.head);
      const facts = eventFactsSchema.parse(packet.facts); checkFactsShape(facts, before.source);
      assert.equal(facts.actor.clientId, null);
      assert.equal(facts.actor.actorId, facts.actor.process.instanceId);
      assert.equal(facts.actor.process.pid, process.pid);
      assert.equal(facts.actor.host.hostname, hostname());
      assert.equal(facts.clients.length, 1);
      assert.equal(facts.clients[0]!.kind, "ordinary-client");
      assert.equal(facts.clients[0]!.classification, "current-client");
      assert.deepEqual(facts.clients[0]!.subject, before.rows[0]!.client_id);
      assert.equal(facts.clients[0]!.receipt?.digest, storageReceiptDigest(f.receipt!));
      assert.equal(facts.clients[0]!.process.pid, process.pid);
      assert.notEqual(facts.actor.actorId, facts.clients[0]!.process.instanceId, "one OS process does not make two logical owners identical");
      assert.equal(facts.sessions.kind, process.platform === "darwin" ? "sqlite-darwin-session-audit-v1" : "sqlite-linux-session-audit-v1");
      assert.equal(facts.sessions.sourceFiles[0].path, f.file);
      assert.equal(facts.sessions.sourceFiles[0].presence, "present");
      const actualFile = await stat(f.file, { bigint: true });
      assert.equal(facts.sessions.sourceFiles[0].device, String(actualFile.dev));
      assert.equal(facts.sessions.sourceFiles[0].inode, String(actualFile.ino));
      assert(facts.sessions.ownedResources.some(item => item.device === String(actualFile.dev) && item.inode === String(actualFile.ino)));
      if (facts.sessions.kind === "sqlite-linux-session-audit-v1") {
        assert(facts.sessions.matches.some(item => item.pid === process.pid && item.sourceRole === "main"));
        assert.equal(facts.actor.process.platform, "linux");
        if (facts.actor.process.platform !== "linux") assert.fail("native process platform");
        assert.equal(facts.actor.process.kernelBootId, (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim());
        assert.equal(facts.actor.process.pidNamespace, await readlink("/proc/self/ns/pid"));
      } else {
        assert(facts.sessions.inventory.items.some(item => item.pid === process.pid && item.device === String(actualFile.dev) && item.inode === String(actualFile.ino)));
        const mappings = facts.sessions.inventory.items.filter(item => item.key.startsWith("map:"));
        assert(mappings.length > 0, "the real Darwin WAL source must provide a nonempty mapping audit");
        for (const item of mappings) {
          const [, begin, size] = item.key.split(":");
          assert(BigInt(size!) > 0n && BigInt(begin!) + BigInt(size!) <= (1n << 64n) - 1n);
          assert.equal(item.fd, -1);
          assert(facts.sessions.ownedResources.some(owned => owned.key === item.key && owned.device === item.device && owned.inode === item.inode));
        }
        t.diagnostic(JSON.stringify({ darwinAuditMappings: mappings.map(({ key, fd, device, inode }) => ({ key, fd, device, inode })) }));
      }
      assert.equal("authorized" in packet, false);
      assert.equal("register" in packet, false);
      assert(Object.isFrozen(packet.facts.clients));
      assert.deepEqual(await lock.observeSourceClients(), before, "audit performs no control DML/anchor write");
    });
  } finally { await f.close(); }
});

test("A12-B bootstrap identity belongs to the actual invocation and expires with its locks", async () => {
  const f = await sqliteAuditFixture(false); let escaped: SourceLock | undefined;
  try {
    const first = await withSqliteSourceInventoryDiagnostics(f.adapter, phase => {
      phase("audit-first-lock");
      return f.adapter.withSourceLock("control", async lock => { escaped = lock; return lock.readSourceClientAudit(f.reference); });
    });
    const second = await withSqliteSourceInventoryDiagnostics(f.adapter, phase => {
      phase("audit-second-lock"); return f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference));
    });
    assert.equal(first.facts.actor.actorId, second.facts.actor.actorId);
    await assert.rejects(async () => escaped!.readSourceClientAudit(f.reference), { code: "maintenance_lost" });
    await f.mutex.release();
    const nextMutex = await f.adapter.acquireMutex(f.store.identity, (await f.adapter.observe()).state);
    const third = await withSqliteSourceInventoryDiagnostics(f.adapter, phase => {
      phase("audit-new-invocation"); return f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference));
    });
    assert.equal(third.facts.actor.process.pid, first.facts.actor.process.pid);
    assert.notEqual(third.facts.actor.actorId, first.facts.actor.actorId);
    await nextMutex.release();
    await assert.rejects(f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference)), { code: "maintenance_lost" });
    // The internal factory itself cannot be rebound to a second logical owner or a lookalike lock.
    const actualAdapter = {}, actualMutex = {}, actualLock = {};
    const factory = new BootstrapAuditFactory(actualAdapter, actualMutex);
    assert.throws(() => factory.bind({}, actualMutex, actualLock, async () => {}), { code: "maintenance_lost" });
    assert.throws(() => factory.bind(actualAdapter, {}, actualLock, async () => {}), { code: "maintenance_lost" });
    const lease = factory.bind(actualAdapter, actualMutex, actualLock, async () => {});
    await assert.rejects(lease.observe({}), { code: "maintenance_lost" });
    lease.close(); await assert.rejects(lease.observe(actualLock), { code: "maintenance_lost" });
    factory.close(); assert.throws(() => factory.bind(actualAdapter, actualMutex, actualLock, async () => {}), { code: "maintenance_lost" });
  } finally { await f.close(); }
});

test("A12-B preserves original SQLite encodings and refuses unknown controller registrations", async t => {
  for (const encoding of ["UTF-16le", "UTF-16be"] as const) await t.test(encoding, async () => {
    const f = await sqliteAuditFixture(true, encoding);
    try {
      const packet = await withSqliteSourceInventoryDiagnostics(f.adapter, phase => {
        phase(encoding === "UTF-16le" ? "audit-utf16le-first" : "audit-utf16be-first");
        return f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference));
      });
      assert.equal(packet.observation.textEncoding.name, encoding);
      assert.deepEqual(packet.facts.clients[0]!.subject, packet.observation.rows[0]!.client_id);
      const db = new Database(f.file);
      try { db.prepare("UPDATE storage_source_clients SET build_id='boardroom-source-maintenance-controller-v1',entrypoint='local-management'").run(); }
      finally { db.close(); }
      await assert.rejects(f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference)), { code: "source_writer_unknown" });
    } finally { await f.close(); }
  });
});

test("A12-B actually observes an exited historical process and keeps an incomplete old row blocking", async () => {
  let historicalId = "";
  const f = await sqliteAuditFixture(true, "UTF-8", async ({ database, dataDir }) => {
    historicalId = await registerExitedAuditClient(database, dataDir);
  });
  try {
    const packet = await f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference));
    const old = packet.facts.clients.find(client => Buffer.from(client.subject[1], "hex").toString("utf8") === historicalId)!;
    assert.equal(old.kind, "ordinary-client"); assert.equal(old.classification, "historical-client");
    assert.equal(old.receipt, null);
    assert.equal(old.processCheck.kind, process.platform === "linux" ? "linux-absent" : "darwin-absent");
    assert.notEqual(old.process.pid, process.pid);
    const db = new Database(f.file);
    // Controlled incomplete historical row: elapsed time/closed FDs cannot repair missing lifecycle data.
    try { db.prepare("UPDATE storage_source_clients SET ended_at=NULL WHERE client_id=?").run(historicalId); }
    finally { db.close(); }
    await assert.rejects(f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference)), { code: "drain_incomplete" });
  } finally { await f.close(); }
});

test("A12-B never fulfills an audit when the real final recheck or outer source close fails", async t => {
  for (const phase of ["final-fresh-close", "outer-close"] as const) await t.test(phase, async () => {
    const f = await sqliteAuditFixture(true), original = Database.prototype.close;
    let readonlyCloses = 0, injected = false, auditReturnedInside = false, operationFulfilled = false;
    Database.prototype.close = function () {
      const source = this.name === f.file;
      if (source && this.readonly) readonlyCloses++;
      const fail = source && !injected && (phase === "final-fresh-close" ? this.readonly && readonlyCloses === 2 : !this.readonly && auditReturnedInside);
      const result = original.call(this);
      if (fail) { injected = true; throw Object.assign(new Error("controlled native close error"), { code: "EIO" }); }
      return result;
    };
    try {
      await assert.rejects(withSqliteSourceInventoryDiagnostics(f.adapter, phase => {
        phase("audit-close-canary");
        return f.adapter.withSourceLock("control", async lock => {
          const value = await lock.readSourceClientAudit(f.reference); auditReturnedInside = true; return value;
        });
      }).then(value => { operationFulfilled = true; return value; }), { code: "maintenance_lost" });
      assert(injected); assert.equal(operationFulfilled, false);
      assert.equal(auditReturnedInside, phase === "outer-close", "post-consume failure cannot imply consume never ran");
    } finally { Database.prototype.close = original; await f.close(); }
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import Database from "better-sqlite3";
import { sqliteAuditFixture } from "./fixtures/maintenance-source-audit.ts";
import { historicalControllerProcess, historicalControllerRow } from "./fixtures/maintenance-controller-history.ts";
import { canonicalJson } from "../src/server/storage/maintenance/canonical.ts";
import { inspectRegisteredSourceProcess } from "../src/server/storage/maintenance/source-facts.ts";

async function fixture(encoding: "UTF-8" | "UTF-16le" | "UTF-16be" = "UTF-8") {
  const actor = await historicalControllerProcess();
  let source: Awaited<ReturnType<typeof sqliteAuditFixture>> | undefined;
  try {
    source = await sqliteAuditFixture(true, encoding, async ({ dataDir }) => {
      const db = new Database(path.join(dataDir, "agent-studio.db"));
      // Carried open state for a later maintenance, not evidence of a previous controller registration.
      try { db.prepare("UPDATE storage_maintenance SET fence_epoch=2").run(); }
      finally { db.close(); }
    });
    const row = historicalControllerRow(source.plan.source, actor);
    const db = new Database(source.file);
    try {
      const names = Object.keys(row);
      db.prepare(`INSERT INTO storage_source_clients (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...Object.values(row));
    } finally { db.close(); }
    const ready = source;
    return { ...ready, actor, row, async close() { await actor.close(); await ready.close(); } };
  } catch (error) { await actor.close(); await source?.close(); throw error; }
}

function replaceRow(f: Awaited<ReturnType<typeof fixture>>, row: Record<string, unknown>) {
  const db = new Database(f.file);
  try {
    const names = Object.keys(row).filter(key => key !== "client_id");
    db.prepare(`UPDATE storage_source_clients SET ${names.map(key => `${key}=?`).join(",")} WHERE client_id=?`)
      .run(...names.map(key => row[key]), f.row.client_id);
  } finally { db.close(); }
}

test("A12-B historical SQLite controller uses actual child exit and preserves every raw row without writes", async () => {
  const f = await fixture();
  try {
    await f.actor.exit();
    await f.adapter.withSourceLock("control", async lock => {
      const before = await lock.observeSourceClients();
      assert.equal(before.state.fenceEpoch, 3);
      const packet = await lock.readSourceClientAudit(f.reference);
      assert.equal(packet.kind, "untrusted-source-client-audit");
      assert.deepEqual(packet.observation, before);
      assert.equal(packet.origin.capture, null);
      assert.equal(packet.facts.actor.clientId, null);
      assert.equal(packet.facts.clients.length, 2);
      const old = packet.facts.clients.find(value => Buffer.from(value.subject[1], "hex").toString("utf8") === f.row.client_id)!;
      assert.equal(old.kind, "maintenance-controller");
      if (old.kind !== "maintenance-controller") assert.fail("historical controller fact required");
      assert.equal(old.classification, "exited-actor");
      assert.equal(old.registration, "R0-historical");
      assert.deepEqual(old.process, f.actor.identity);
      assert.equal(old.processCheck.kind, process.platform === "linux" ? "linux-absent" : "darwin-absent");
      assert(packet.facts.clients.some(value => value.kind === "ordinary-client" && value.classification === "current-client"));
      assert.deepEqual(await lock.observeSourceClients(), before, "no control row or anchor mutation");
    });
  } finally { await f.close(); }
});

test("A12-B historical SQLite controller keeps actual ordinary encodings and the default A11 gate", async t => {
  for (const encoding of ["UTF-16le", "UTF-16be"] as const) await t.test(encoding, async () => {
    const f = await fixture(encoding);
    try {
      await f.actor.exit();
      await assert.rejects(f.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(f.reference, async () => assert.fail("default A11 must not admit controllers"))),
        { code: "source_writer_unknown" });
      await f.adapter.withSourceLock("control", async lock => {
        const before = await lock.observeSourceClients(), packet = await lock.readSourceClientAudit(f.reference);
        assert.equal(packet.observation.textEncoding.name, encoding);
        assert.deepEqual(packet.observation, before);
        assert.equal(packet.facts.clients.filter(value => value.kind === "maintenance-controller").length, 1);
        assert.equal(packet.facts.clients.filter(value => value.kind === "ordinary-client").length, 1);
        assert.deepEqual(await lock.observeSourceClients(), before);
      });
    } finally { await f.close(); }
  });
});

test("A12-B historical SQLite controller never substitutes ended time or empty owned resources for actual exit", async () => {
  const f = await fixture();
  try {
    replaceRow(f, { ...f.row, ended_at: "2026-11-02T00:00:00.000Z" });
    const read = () => f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference));
    await assert.rejects(read(), { code: "source_writer_unknown" });
    await f.actor.exit();
    const packet = await read();
    assert.equal(packet.facts.clients.find(value => value.kind === "maintenance-controller")!.classification, "exited-actor");
  } finally { await f.close(); }
});

test("A12-B historical SQLite controller keeps same-value native decimals live and preserves their raw text", async () => {
  const f = await fixture();
  try {
    const identity = f.actor.identity;
    const alias = identity.platform === "linux" ? { ...identity, startTicks: `0${identity.startTicks}` }
      : { ...identity, startSeconds: `0${identity.startSeconds}` };
    replaceRow(f, { ...f.row, process_identity_json: canonicalJson(alias) });
    const before = await f.adapter.withSourceLock("control", lock => lock.observeSourceClients());
    assert.equal((await inspectRegisteredSourceProcess(f.actor.host, alias)).fact.status, "present");
    await assert.rejects(f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference)), { code: "source_writer_unknown" });
    assert.deepEqual(await f.adapter.withSourceLock("control", lock => lock.observeSourceClients()), before);
    assert.equal((await inspectRegisteredSourceProcess(f.actor.host, identity)).fact.status, "present");
    await f.actor.exit();
    const packet = await f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference));
    const old = packet.facts.clients.find(value => value.kind === "maintenance-controller")!;
    assert.equal(old.classification, "exited-actor");
    assert.equal(old.processCheck.kind, process.platform === "linux" ? "linux-absent" : "darwin-absent");
    assert.deepEqual(old.process, alias, "the observed input text is retained rather than normalized");
    assert.deepEqual(packet.observation, before, "the full raw roster is unchanged after actual exit");
  } finally { await f.close(); }
});

test("A12-B historical SQLite controller refuses unknown profile, creation and native provenance", async t => {
  const f = await fixture();
  try {
    await f.actor.exit();
    const cases: [string, (row: Record<string, unknown>, registration: Record<string, unknown>) => void][] = [
      ["unknown build", row => { row.build_id = "unknown-controller"; }],
      ["extra registration field", (_row, registration) => { registration.owned = true; }],
      ["source identity mismatch", (_row, registration) => { registration.sourceIdentityDigest = "0".repeat(64); }],
      ["same epoch", (row, registration) => {
        row.registered_epoch = row.observed_epoch = 3;
        (registration.creation as Record<string, unknown>).fenceEpoch = "3";
      }],
      ["creation epoch mismatch", (_row, registration) => { (registration.creation as Record<string, unknown>).fenceEpoch = "2"; }],
      ["creation previous mismatch", (_row, registration) => {
        ((registration.creation as Record<string, unknown>).previousAnchor as Record<string, unknown>).ref = `journals/wrong/1-${"8".repeat(64)}.json`;
      }],
      ["foreign boot", row => {
        const identity = JSON.parse(String(row.process_identity_json));
        identity[process.platform === "linux" ? "kernelBootId" : "bootSessionUuid"] = "00000000-0000-4000-8000-000000000000";
        row.process_identity_json = canonicalJson(identity);
      }],
      ["foreign native boundary", row => {
        const identity = JSON.parse(String(row.process_identity_json));
        if (process.platform === "linux") identity.pidNamespace = "pid:[0]";
        else identity.uid = Number(identity.uid) + 1;
        row.process_identity_json = canonicalJson(identity);
      }],
    ];
    for (const [name, edit] of cases) await t.test(name, async () => {
      const row: Record<string, unknown> = { ...f.row }, registration = JSON.parse(f.row.db_sessions_json) as Record<string, unknown>;
      edit(row, registration); row.db_sessions_json = canonicalJson(registration); replaceRow(f, row);
      try { await assert.rejects(f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference)), { code: "source_writer_unknown" }); }
      finally { replaceRow(f, f.row); }
    });
    const packet = await f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference));
    assert.equal(packet.facts.clients.filter(value => value.kind === "maintenance-controller").length, 1);
  } finally { await f.close(); }
});

test("A12-B historical SQLite controller does not exempt a different process holding the source", async () => {
  const f = await fixture(); let reader: Awaited<ReturnType<typeof historicalControllerProcess>> | undefined;
  try {
    await f.actor.exit(); reader = await historicalControllerProcess(f.file);
    await assert.rejects(f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference)), { code: "source_writer_unknown" });
    await reader.exit();
    assert.equal((await f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference))).facts.clients.length, 2);
  } finally { await reader?.close(); await f.close(); }
});

test("A12-B historical SQLite controller cannot return through a failed final source close", async () => {
  const f = await fixture(), original = Database.prototype.close;
  let closes = 0, injected = false, fulfilled = false;
  try {
    await f.actor.exit();
    Database.prototype.close = function () {
      const target = this.name === f.file && this.readonly;
      const result = original.call(this);
      if (target && ++closes === 2) { injected = true; throw Object.assign(new Error("controlled final native close"), { code: "EIO" }); }
      return result;
    };
    await assert.rejects(f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference)).then(value => { fulfilled = true; return value; }),
      { code: "maintenance_lost" });
    assert(injected, "the actual final inspection close was reached"); assert.equal(fulfilled, false);
  } finally { Database.prototype.close = original; await f.close(); }
});

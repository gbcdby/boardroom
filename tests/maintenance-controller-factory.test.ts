import assert from "node:assert/strict";
import test from "node:test";
import { BootstrapAuditFactory } from "../src/server/storage/maintenance/native-audit.ts";

// These isolated factory checks use the actual current OS identity. The objects below
// are deliberately not adapter capabilities and cannot authorize any source write.
test("C3 factory: bootstrap identity is one actual native process across scopes", async () => {
  const adapter = {}, mutex = {}, first = {}, second = {};
  const factory = new BootstrapAuditFactory(adapter, mutex);
  const one = factory.bind(adapter, mutex, first, async () => {});
  const firstActor = await one.observe(first);
  assert.equal(firstActor.clientId, null);
  assert.equal(firstActor.process.pid, process.pid);
  assert.equal(firstActor.actorId, firstActor.process.instanceId);
  one.close();
  await assert.rejects(one.observe(first), { code: "maintenance_lost" });
  const two = factory.bind(adapter, mutex, second, async () => {});
  assert.deepEqual(await two.observe(second), firstActor);
  factory.close();
  await assert.rejects(two.observe(second), { code: "maintenance_lost" });
  assert.throws(() => factory.bind(adapter, mutex, {}, async () => {}), { code: "maintenance_lost" });
});

test("C3 factory: no audited producer window means no staging or transaction promotion", async () => {
  for (const operation of ["stage", "commit", "close"] as const) {
    const adapter = {}, mutex = {}, lock = {};
    const factory = new BootstrapAuditFactory(adapter, mutex);
    const lease = factory.bind(adapter, mutex, lock, async () => {});
    await lease.observe(lock);
    if (operation === "stage") await assert.rejects(factory.stageRegistration(adapter, mutex, lock), { code: "maintenance_lost" });
    else if (operation === "commit") assert.throws(() => factory.noteCommitReturned(adapter, mutex, lock), { code: "maintenance_lost" });
    else assert.throws(() => factory.noteSourceClosed(adapter, mutex, lock), { code: "maintenance_lost" });
    await assert.rejects(lease.observe(lock), { code: "maintenance_lost" });
  }
});

test("C3 factory: adapter, mutex, source lock and receiver copies cannot acquire ownership", async () => {
  const adapter = {}, mutex = {}, lock = {};
  const factory = new BootstrapAuditFactory(adapter, mutex);
  assert.throws(() => factory.bind({ ...adapter }, mutex, lock, async () => {}), { code: "maintenance_lost" });
  assert.throws(() => factory.bind(adapter, { ...mutex }, lock, async () => {}), { code: "maintenance_lost" });
  const lease = factory.bind(adapter, mutex, lock, async () => {});
  await assert.rejects(({ ...lease }).observe(lock), { code: "maintenance_lost" });
  await assert.rejects(lease.observe({ ...lock }), { code: "maintenance_lost" });
  await assert.rejects(factory.stageRegistration(adapter, mutex, { ...lock }), { code: "maintenance_lost" });
  assert.throws(() => BootstrapAuditFactory.prototype.noteCommitReturned.call({ ...factory }, adapter, mutex, lock));
});

test("C3 factory: native ownership failure invalidates every issued scope", async () => {
  const adapter = {}, mutex = {}, lock = {};
  const factory = new BootstrapAuditFactory(adapter, mutex);
  const failure = new Error("actual held check failed");
  const lease = factory.bind(adapter, mutex, lock, async () => { throw failure; });
  await assert.rejects(lease.observe(lock), error => error === failure);
  assert.throws(() => factory.bind(adapter, mutex, {}, async () => {}), { code: "maintenance_lost" });
});

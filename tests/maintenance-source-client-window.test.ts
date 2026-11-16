import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readlink } from "node:fs/promises";
import { hostname } from "node:os";
import { darwinCurrentProcessIdentity } from "../src/server/storage/maintenance/darwin.ts";
import test from "node:test";
import { compatibleSourceClientWindow } from "../src/server/storage/maintenance/source-client-window.ts";
import { verifyRestoreBundle } from "../src/server/storage/maintenance/verify-bundle.ts";
import { verificationBundleFixture } from "./fixtures/maintenance-verify-bundle.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";
import type { Json } from "../src/server/storage/maintenance/types.ts";

const at = "2026-11-16T01:00:00.000Z", later = "2026-11-16T01:00:01.000Z";
async function nativeIdentity(): Promise<Readonly<Record<string, unknown>>> {
  const base = { version: 1, platform: process.platform, pid: process.pid, instanceId: randomUUID() };
  if (process.platform === "darwin") return { ...base, ...darwinCurrentProcessIdentity() };
  if (process.platform !== "linux") throw new Error("unsupported test platform");
  const [boot, namespace, stat] = await Promise.all([
    readFile("/proc/sys/kernel/random/boot_id", "utf8"), readlink("/proc/self/ns/pid"), readFile("/proc/self/stat", "utf8"),
  ]);
  const ticks = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19];
  assert(ticks && /^\d+$/.test(ticks));
  return { ...base, verification: "linux_proc_identity_v1", kernelBootId: boot.trim(), pidNamespace: namespace, startTicks: ticks };
}
const row = async (entrypoint = "maintenance-controller"): Promise<Readonly<Record<string, Json>>> => ({
  client_id: "ctl", database_instance_id: "marker", entrypoint, build_id: "test",
  protocol_version: 1, host_identity_json: JSON.stringify({ version: 1, hostname: hostname(), platform: process.platform }),
  process_identity_json: JSON.stringify(await nativeIdentity()), db_sessions_json: "[]",
  registered_epoch: "7", observed_epoch: "7", drain_epoch: null, drain_state: "none",
  drain_receipt_digest: null, registered_at: at, last_observed_at: at, ended_at: null,
});
const options = { journalAdvanced: true, fenceEpoch: 7, databaseInstanceId: "marker" };
const check = (previous: readonly Readonly<Record<string, Json>>[], live: readonly Readonly<Record<string, Json>>[],
  journalAdvanced = true) => compatibleSourceClientWindow(previous, live, { ...options, journalAdvanced });

test("#152 V: journal-backed maintenance registration and monotonic observations are narrowly admitted", async () => {
  const old = await row();
  assert.equal(await check([], []), true);
  assert.equal(await check([], [old], false), false);
  assert.equal(await check([], [old]), true);
  assert.equal(await check([old], [{ ...old, last_observed_at: later, ended_at: later }]), true);
  assert.equal(await check([old], [{ ...old, last_observed_at: later }], false), false);
  assert.equal(await check([old], []), false);
  assert.equal(await check([], [old, old]), false);
  assert.equal(await check([old], [{ ...old, last_observed_at: at, ended_at: later }]), false);
  assert.equal(await check([old], [{ ...old, last_observed_at: "2026-11-15T00:00:00.000Z" }]), false);
  assert.equal(await check([old], [{ ...old, unknown: "x" }]), false);
});
test("#152 V: business admission, session, epoch, identity, drain and receipt drift remain rejected", async () => {
  const original = await row();
  for (const delta of [{ entrypoint: "stdio" }, { entrypoint: "http" }, { registered_epoch: "8" },
    { observed_epoch: "8" }, { drain_epoch: "7" }, { drain_state: "draining" },
    { drain_receipt_digest: "a".repeat(64) }, { database_instance_id: "different" },
    { db_sessions_json: "{\"sessions\":[{\"owner\":\"local-driver\"}]}" }, { process_identity_json: "{\"pid\":1}" }]) {
    assert.equal(await check([], [{ ...original, ...delta }]), false, JSON.stringify(delta));
    assert.equal(await check([original], [{ ...original, last_observed_at: later, ...delta }]), false, JSON.stringify(delta));
  }
  assert.equal(await check([original], [original, { ...original, client_id: "business", entrypoint: "stdio" }]), false);
  const forged = JSON.parse(String(original.process_identity_json)) as Record<string, Json>;
  assert.equal(await check([], [{ ...original, process_identity_json: JSON.stringify({ ...forged, pid: 999999999 }) }]), false,
    "well-formed but non-existent native process cannot register as a controller");
  assert.equal(await check([], [{ ...original, host_identity_json: JSON.stringify({ version: 1, hostname: "forged", platform: process.platform }) }]), false);
});

for (const kind of ["sqlite", "postgres"] as const) {
  const enabled = kind === "sqlite" ? ["linux", "darwin"].includes(process.platform) : Boolean(process.env.AGENT_STUDIO_PG_TEST_URL);
  for (const business of [false, true]) (enabled ? test : test.skip)(
    "#152 V " + kind + ": real DB and journal " + (business ? "reject new ordinary writer" : "accept maintenance-only coordinator"),
    async () => {
      const f = await verificationBundleFixture(kind);
      try {
        const refs = await f.run(lock => f.publish(lock));
        const controller = await row();
        const sql = "INSERT INTO storage_source_clients " +
          "(client_id,database_instance_id,entrypoint,build_id,protocol_version," +
          "host_identity_json,process_identity_json,db_sessions_json,registered_epoch,observed_epoch," +
          "drain_epoch,drain_state,drain_receipt_digest,registered_at,last_observed_at,ended_at) " +
          "VALUES ('control-successor',(SELECT database_instance_id FROM storage_maintenance),'" +
          (business ? "stdio" : "maintenance-controller") +
          "','test-build',1,'" + String(controller.host_identity_json).replaceAll("'", "''") +
          "','" + String(controller.process_identity_json).replaceAll("'", "''") + "','[]',(SELECT fence_epoch FROM storage_maintenance)," +
          "(SELECT fence_epoch FROM storage_maintenance),NULL,'none',NULL,'" + at + "','" + later + "',NULL)";
        await f.exec(sql); // Enter fixture owns the real source DB, never its isolated PG restore target.
        await f.advance("observation");
        if (business) await f.run(async lock => assert.rejects(
          verifyRestoreBundle(f.store, f.adapter, lock, refs.bundle, refs.publication),
          error => error instanceof MaintenanceFailure && error.code === "source_changed"));
        else {
          const actual = await f.run(lock => verifyRestoreBundle(f.store, f.adapter, lock, refs.bundle, refs.publication));
          assert.equal(f.store.kindFor(actual), "verification");
        }
      } finally { await f.close(); }
    });
}

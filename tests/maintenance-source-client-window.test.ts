import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readlink } from "node:fs/promises";
import { hostname } from "node:os";
import test from "node:test";
import { canonicalJson } from "../src/server/storage/maintenance/canonical.ts";
import { compatibleSourceClientWindow, type SourceClientJournalAnchor, type SourceClientJournalProof,
  type SourceClientObservationProof, type SourceClientRegistrationProof } from "../src/server/storage/maintenance/source-client-window.ts";
import { verifyRestoreBundle } from "../src/server/storage/maintenance/verify-bundle.ts";
import { verificationBundleFixture } from "./fixtures/maintenance-verify-bundle.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";
import type { ArtifactRef, Json, SourceRef } from "../src/server/storage/maintenance/types.ts";

type Row = Readonly<Record<string, Json>>;
const at = "2026-11-16T01:00:00.000Z", later = "2026-11-16T01:00:01.000Z";
const source: SourceRef = { kind: "sqlite", databaseInstanceId: "marker", identityDigest: "a".repeat(64) };
const migrationId = "migration-window-test";
const planDigest = "b".repeat(64);
const previousAnchor: ArtifactRef = {
  ref: `journals/${migrationId}/6-${"c".repeat(64)}.json`, sha256: "c".repeat(64), bytes: "123",
};
const targetAnchor: ArtifactRef = {
  ref: `journals/${migrationId}/7-${"d".repeat(64)}.json`, sha256: "d".repeat(64), bytes: "123",
};
const endedAnchorRef: ArtifactRef = {
  ref: `journals/${migrationId}/8-${"e".repeat(64)}.json`, sha256: "e".repeat(64), bytes: "123",
};
const journalAnchor: SourceClientJournalAnchor = { reference: targetAnchor, previous: previousAnchor, migrationId, planDigest,
  fenceEpoch: 7, ownerGeneration: 3, sequence: 7 };
const endedAnchor: SourceClientJournalAnchor = { reference: endedAnchorRef, previous: targetAnchor, migrationId, planDigest,
  fenceEpoch: 7, ownerGeneration: 3, sequence: 8 };
const registration = {
  formatVersion: 1, kind: "maintenance-controller-registration", source,
  sourceIdentityDigest: source.identityDigest,
  creation: {
    migrationId, plan: { ref: `plans/${planDigest}.json`, sha256: planDigest, bytes: "123" },
    fenceEpoch: "7", ownerGeneration: "3", previousAnchor, targetSequence: "7",
  },
  sessionBinding: "per-source-lock-native-inventory-v1", drainReceipt: null,
};
function nativeIdentity(): Readonly<Record<string, unknown>> {
  const base = { version: 1, platform: process.platform, pid: process.pid, instanceId: "test-instance" };
  if (process.platform === "darwin") return { ...base, verification: "darwin_proc_identity_v1", uid: 501,
    bootSessionUuid: "00000000-0000-0000-0000-000000000001", startSeconds: "1", startMicroseconds: "1" };
  return { ...base, verification: "linux_proc_identity_v1", kernelBootId: "00000000-0000-0000-0000-000000000001",
    pidNamespace: "pid:[1]", startTicks: "1" };
}
async function realNativeIdentity(): Promise<Readonly<Record<string, unknown>>> {
  const base = { version: 1, platform: process.platform, pid: process.pid, instanceId: randomUUID() };
  if (process.platform === "darwin") {
    const { darwinCurrentProcessIdentity } = await import("../src/server/storage/maintenance/darwin.ts");
    return { ...base, ...darwinCurrentProcessIdentity() };
  }
  if (process.platform !== "linux") throw new Error("unsupported test platform");
  const [boot, namespace, stat] = await Promise.all([
    readFile("/proc/sys/kernel/random/boot_id", "utf8"), readlink("/proc/self/ns/pid"), readFile("/proc/self/stat", "utf8"),
  ]);
  const ticks = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19];
  assert(ticks && /^\d+$/.test(ticks));
  return { ...base, verification: "linux_proc_identity_v1", kernelBootId: boot.trim(), pidNamespace: namespace, startTicks: ticks };
}
const liveHost = { version: 1, hostname: hostname(), platform: process.platform };
const presentProcess = async (host: Record<string, unknown>, identity: Record<string, unknown>) =>
  host.hostname === hostname() && identity.pid === process.pid
    ? { status: "present", reason: "identity_matches" } as const
    : { status: "exited", reason: "process_absent" } as const;
const exitedProcess = async (host: Record<string, unknown>, identity: Record<string, unknown>) =>
  host.hostname === hostname() && identity.pid === process.pid
    ? { status: "exited", reason: "process_absent" } as const
    : { status: "exited", reason: "identity_replaced" } as const;
const row = async (entrypoint = "maintenance-controller"): Promise<Row> => ({
  client_id: "ctl", database_instance_id: "marker", entrypoint, build_id: "boardroom-maintenance-control-v1",
  protocol_version: 1, host_identity_json: canonicalJson(liveHost),
  process_identity_json: canonicalJson(nativeIdentity()), db_sessions_json: canonicalJson(registration),
  registered_epoch: "7", observed_epoch: "7", drain_epoch: null, drain_state: "none",
  drain_receipt_digest: null, registered_at: at, last_observed_at: at, ended_at: null,
});
const registrationProof = (after: Row, clientId = "ctl"): SourceClientRegistrationProof =>
  ({ journal: targetAnchor, sequence: 7, clientId, after, actorId: "test-instance" });
const observationProof = (before: Row, after: Row, effect: SourceClientObservationProof["effect"]): SourceClientObservationProof =>
  ({ journal: endedAnchorRef, sequence: 8, clientId: String(after.client_id), before, after, effect });
type CheckOverrides = {
  readonly proof?: SourceClientJournalProof;
  readonly inspectProcess?: (host: Record<string, unknown>, identity: Record<string, unknown>) =>
    Promise<{ readonly status: string; readonly reason: string }>;
};
const check = (previous: readonly Row[], live: readonly Row[],
  journalAdvanced = true, overrides: CheckOverrides = {}) => {
  const proof = overrides.proof ?? {
    registrations: live.filter(item => item.client_id === "ctl").map(item => registrationProof(item)),
    observations: [],
  };
  return compatibleSourceClientWindow(previous, live, {
    mode: "strict", journalAdvanced, fenceEpoch: 7, databaseInstanceId: "marker", source, migrationId, planDigest,
    currentSequence: 8, anchors: [journalAnchor, endedAnchor], proof,
    inspectProcess: overrides.inspectProcess ?? presentProcess,
  });
};

async function fixtureRegistrationEnvelope(f: Awaited<ReturnType<typeof verificationBundleFixture>>): Promise<string> {
  const observed = await f.run(lock => lock.observe());
  const state = observed.state;
  assert(state.journalRecordRef && state.journalDigest && state.activeMigrationId && state.planDigest);
  return canonicalJson({
    ...registration, source: observed.source, sourceIdentityDigest: observed.source.identityDigest,
    creation: {
      ...registration.creation, migrationId: state.activeMigrationId,
      plan: { ref: `plans/${state.planDigest}.json`, sha256: state.planDigest, bytes: "123" },
      fenceEpoch: String(state.fenceEpoch), ownerGeneration: String(state.ownerGeneration),
      previousAnchor: { ref: state.journalRecordRef, sha256: state.journalDigest, bytes: "123" },
      targetSequence: String(state.journalSequence + 1),
    },
  });
}

test("#152 V: journal-backed maintenance registration and monotonic observations are narrowly admitted", async () => {
  const old = await row();
  const ended = { ...old, last_observed_at: later, ended_at: later };
  const endedProof: SourceClientJournalProof = {
    registrations: [], observations: [observationProof(old, ended, "ended-observed")],
  };
  assert.equal(await check([], []), true);
  assert.equal(await check([], [old], false), false);
  assert.equal(await check([], [old]), true);
  assert.equal(await check([old], [ended], true, { proof: endedProof, inspectProcess: exitedProcess }), true);
  const observed = { ...old, last_observed_at: later };
  const backdated = { ...observed, last_observed_at: "2026-11-16T01:00:02.000Z", ended_at: at };
  assert.equal(await check([observed], [backdated], true,
    { proof: { registrations: [], observations: [observationProof(observed, backdated, "ended-observed")] }, inspectProcess: exitedProcess }), false,
    "a late observation must not authorize a retroactively backdated termination");
  const predated = { ...old, last_observed_at: later, ended_at: "2026-11-15T23:59:59.000Z" };
  assert.equal(await check([old], [predated], true,
    { proof: { registrations: [], observations: [observationProof(old, predated, "ended-observed")] }, inspectProcess: exitedProcess }), false,
    "termination cannot predate the initial registration");
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


test("#152 V: a copied envelope with a borrowed live PID has no journal registration proof", async () => {
  const identity = await row();
  const borrowed = { ...identity, client_id: "borrowed-real-pid" };
  assert.equal(await check([], [borrowed]), false,
    "a live PID and copied envelope cannot authorize a client_id absent from registration changes");
});

test("#152 V: a registered controller that exited can be a legal successor", async () => {
  const old = await row();
  const ended = { ...old, last_observed_at: later, ended_at: later };
  const proof: SourceClientJournalProof = {
    registrations: [], observations: [observationProof(old, ended, "ended-observed")],
  };
  assert.equal(await check([old], [ended], true, { proof, inspectProcess: exitedProcess }), true,
    "a registered controller whose native process exited may be observed as ended");
  assert.equal(await check([old], [ended], true, { proof }), false,
    "a still-present controller cannot be reported as ended");
});


for (const kind of ["sqlite", "postgres"] as const) {
  const enabled = kind === "sqlite" ? ["linux", "darwin"].includes(process.platform) : Boolean(process.env.AGENT_STUDIO_PG_TEST_URL);
  for (const business of [false, true]) (enabled ? test : test.skip)(
    "#152 V " + kind + ": real DB rejects copied registration envelope " +
      (business ? "for an ordinary writer" : "with a borrowed live PID"),
    async () => {
      const f = await verificationBundleFixture(kind);
      try {
        const refs = await f.run(lock => f.publish(lock));
        const dbSessions = await fixtureRegistrationEnvelope(f);
        const native = await realNativeIdentity();
        const sqlText = (value: Json | undefined) => {
          if (typeof value !== "string") throw new Error("expected SQL text");
          return value.replaceAll("'", "''");
        };
        const sql = "INSERT INTO storage_source_clients " +
          "(client_id,database_instance_id,entrypoint,build_id,protocol_version," +
          "host_identity_json,process_identity_json,db_sessions_json,registered_epoch,observed_epoch," +
          "drain_epoch,drain_state,drain_receipt_digest,registered_at,last_observed_at,ended_at) " +
          "VALUES ('" + (business ? "ordinary-copied-envelope" : "borrowed-native-controller") +
          "',(SELECT database_instance_id FROM storage_maintenance),'" +
          (business ? "stdio" : "maintenance-controller") +
          "','boardroom-maintenance-control-v1',1,'" + sqlText(canonicalJson(liveHost)) +
          "','" + sqlText(canonicalJson(native)) + "','" + sqlText(dbSessions) + "',(SELECT fence_epoch FROM storage_maintenance)," +
          "(SELECT fence_epoch FROM storage_maintenance),NULL,'none',NULL,'" + at + "','" + later + "',NULL)";
        await f.exec(sql);
        await f.advance("observation");
        await f.run(lock => assert.rejects(
          verifyRestoreBundle(f.store, f.adapter, lock, refs.bundle, refs.publication),
          error => error instanceof MaintenanceFailure && error.code === "source_changed",
          "self-consistent envelope plus unrelated observation is not registration authority"));
      } finally { await f.close(); }
    });
}


for (const kind of ["sqlite", "postgres"] as const) {
  const enabled = kind === "sqlite" ? ["linux", "darwin"].includes(process.platform) : Boolean(process.env.AGENT_STUDIO_PG_TEST_URL);
  (enabled ? test : test.skip)(
    "#152 V " + kind + ": V rejects copied envelope and borrowed live native identity after unrelated journal observation",
    async () => {
      const f = await verificationBundleFixture(kind);
      try {
        const refs = await f.run(lock => f.publish(lock));
        const dbSessions = await fixtureRegistrationEnvelope(f);
        const identity = await row();
        const native = await realNativeIdentity();
        const sqlText = (value: Json | undefined) => {
          if (typeof value !== "string") throw new Error("expected native identity JSON text");
          return value.replaceAll("'", "''");
        };
        await f.exec(
          "INSERT INTO storage_source_clients " +
          "(client_id,database_instance_id,entrypoint,build_id,protocol_version," +
          "host_identity_json,process_identity_json,db_sessions_json,registered_epoch,observed_epoch," +
          "drain_epoch,drain_state,drain_receipt_digest,registered_at,last_observed_at,ended_at) " +
          "VALUES ('borrowed-copied-controller',(SELECT database_instance_id FROM storage_maintenance)," +
          "'maintenance-controller','boardroom-maintenance-control-v1',1,'" + sqlText(identity.host_identity_json) +
          "','" + sqlText(canonicalJson(native)) + "','" + sqlText(dbSessions) + "'," +
          "(SELECT fence_epoch FROM storage_maintenance),(SELECT fence_epoch FROM storage_maintenance)," +
          "NULL,'none',NULL,'" + at + "','" + later + "',NULL)"
        );
        await f.advance("observation");
        await f.run(lock => assert.rejects(
          verifyRestoreBundle(f.store, f.adapter, lock, refs.bundle, refs.publication),
          error => error instanceof MaintenanceFailure && error.code === "source_changed",
          "a real native PID plus copied envelope cannot authorize an unregistered source-client row"
        ));
      } finally { await f.close(); }
    }
  );
}


const postgresWindowTest = process.env.AGENT_STUDIO_PG_TEST_URL ? test : test.skip;
postgresWindowTest("#152 V PostgreSQL: an invalidated native backup cannot be revived by reverting source rows", async () => {
  const f = await verificationBundleFixture("postgres");
  try {
    const refs = await f.run(lock => f.publish(lock));
    const identity = await row();
    const native = await realNativeIdentity();
    const quote = (value: Json | undefined) => {
      if (typeof value !== "string") throw new Error("missing native identity");
      return value.replaceAll("'", "''");
    };
    await f.exec(
      "INSERT INTO storage_source_clients " +
      "(client_id,database_instance_id,entrypoint,build_id,protocol_version," +
      "host_identity_json,process_identity_json,db_sessions_json,registered_epoch,observed_epoch," +
      "drain_epoch,drain_state,drain_receipt_digest,registered_at,last_observed_at,ended_at) " +
      "VALUES ('transient-untrusted',(SELECT database_instance_id FROM storage_maintenance)," +
      "'stdio','test-build',1,'" + quote(identity.host_identity_json) + "','" +
      quote(canonicalJson(native)) + "','[]',(SELECT fence_epoch FROM storage_maintenance)," +
      "(SELECT fence_epoch FROM storage_maintenance),NULL,'none',NULL,'" + at + "','" + later + "',NULL)"
    );
    await f.advance("observation");
    await f.exec("DELETE FROM storage_source_clients WHERE client_id='transient-untrusted'");
    await f.advance("observation");
    await f.run(lock => assert.rejects(
      verifyRestoreBundle(f.store, f.adapter, lock, refs.bundle, refs.publication),
      error => error instanceof MaintenanceFailure && error.code === "source_changed",
      "native PostgreSQL restore must retain the prior source-drift evidence"
    ));
  } finally { await f.close(); }
});

import test from "node:test";
import assert from "node:assert/strict";
import { eventFactsSchema, processDisposition, registeredProcess } from "../src/server/storage/maintenance/control-candidate/schema.ts";

// These are pure consistency vectors, not claims that a native process was observed or a PID reused.
const checks = eventFactsSchema.shape.actor.shape.processCheck;
const boot = "11111111-1111-4111-8111-111111111111";
const linux = { version: 1, platform: "linux", pid: 1234, instanceId: "history",
  verification: "linux_proc_identity_v1", kernelBootId: boot, pidNamespace: "pid:[1]", startTicks: "0010" };
const observed = { pid: 1234, observerUid: 1000, kernelBootId: boot, pidNamespace: "pid:[1]" };

test("A12 native consistency: Linux decimal aliases match and cannot supply a replaced check", () => {
  const identity = registeredProcess.parse(linux);
  assert.equal(processDisposition(identity, checks.parse({ ...observed, kind: "linux-matched", uidBefore: 1000, uidAfter: 1000,
    startTicksBefore: "10", startTicksAfter: "010" })), "matched");
  assert.throws(() => processDisposition(identity, checks.parse({ ...observed, kind: "linux-replaced", observedUid: 1000,
    observedStartTicks: "10" })), { code: "journal_invalid" });
  assert.equal(processDisposition(identity, checks.parse({ ...observed, kind: "linux-replaced", observedUid: 1000,
    observedStartTicks: "11" })), "exited");
  assert.equal(processDisposition(identity, checks.parse({ ...observed, kind: "linux-absent", stage: "proc-open", errno: "ENOENT" })), "exited");
  assert.equal(identity.platform === "linux" && identity.startTicks, "0010", "do not normalize retained input");
});

test("A12 native consistency: exact integer comparison preserves different values above safe Number precision", () => {
  const identity = registeredProcess.parse({ ...linux, startTicks: "09007199254740992" });
  assert.equal(processDisposition(identity, checks.parse({ ...observed, kind: "linux-replaced", observedUid: 1000,
    observedStartTicks: "9007199254740993" })), "exited");
});

test("A12 native consistency: Darwin seconds and microseconds use value identity without losing actual differences or absence", () => {
  const identity = registeredProcess.parse({ version: 1, platform: "darwin", pid: 1234, instanceId: "history",
    verification: "darwin_proc_identity_v1", uid: 1000, bootSessionUuid: boot, startSeconds: "01700000000", startMicroseconds: "000042" });
  const actual = { version: 1, pid: 1234, bootSessionUuid: boot, status: "present", uid: 1000, startSeconds: "1700000000", startMicroseconds: "42" };
  assert.equal(processDisposition(identity, checks.parse({ kind: "darwin-present", result: actual })), "matched");
  for (const different of [{ ...actual, startSeconds: "1700000001" }, { ...actual, startMicroseconds: "43" }])
    assert.equal(processDisposition(identity, checks.parse({ kind: "darwin-present", result: different })), "exited");
  assert.equal(processDisposition(identity, checks.parse({ kind: "darwin-absent", result: { version: 1, pid: 1234, bootSessionUuid: boot, status: "absent" } })), "exited");
  assert.equal(identity.platform === "darwin" && identity.startMicroseconds, "000042");
});

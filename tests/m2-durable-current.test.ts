import assert from "node:assert/strict";
import test from "node:test";
import { m2DurableCurrentFixture, inspectM2DurableCurrent, currentTable, removeCurrentRows } from "./helpers/m2-durable-current-fixture.ts";
import { originRow, originSet } from "./helpers/m2-origin-fixture-store.ts";
import { createP0Request } from "../src/server/identity/internal/m2-p0-request.ts";
import { checkP0ConfigurationFamily } from "../src/server/identity/internal/m2-p0-config-family.ts";
import type { HistoryObservationInput } from "../src/server/identity/m2-history-contracts.ts";

type Inspected = ReturnType<typeof inspectM2DurableCurrent>;
function rejected(inspected: Inspected, stage: Inspected["stage"], rule?: string) {
  assert.equal(inspected.stage, stage, JSON.stringify(inspected));
  assert(!inspected.result.ok, JSON.stringify(inspected));
  assert.notEqual(inspected.result.error.code, "resource_limit", "reach the original semantic rule");
  if (rule) assert.equal(inspected.result.error.rule, rule);
  return inspected.result.error;
}

test("M2 current: an authenticated later detached shell retains runner and raw configuration without current membership", async () => {
  const fixture = await m2DurableCurrentFixture();
  const shell = originRow(currentTable(fixture.observation, "agent_runtime_bindings"));
  assert.equal(shell.attachment_state, "detached");
  assert.equal(currentTable(fixture.observation, "group_participants").count, "0");
  assert.equal(currentTable(fixture.observation, "agent_runtime_members").count, "0");
  assert.equal(currentTable(fixture.observation, "agent_runner_states").count, "1");
  const inspected = inspectM2DurableCurrent(fixture);
  assert.equal(inspected.stage, "current", JSON.stringify(inspected));
  assert(inspected.result.ok, JSON.stringify(inspected));
  assert.deepEqual(inspected.result.value.rowStages, ["p1"]);
  assert(inspected.usage.bytes > inspected.usageAfterOrigin.bytes);
});

test("M2 current: the unchanged attached shell still has its exact current joins and usable original config", async () => {
  const fixture = await m2DurableCurrentFixture("attached"), inspected = inspectM2DurableCurrent(fixture);
  assert.equal(inspected.stage, "current"); assert(inspected.result.ok, JSON.stringify(inspected));
  assert(inspected.result.value.configuration.runtimeUsability.every(item => item.usable));
});

for (const mode of ["detached", "mixed"] as const) test(`M2 current: ${mode} retains two detached history rows outside the attached uniqueness domain`, async () => {
  const fixture = await m2DurableCurrentFixture(mode, 2), inspected = inspectM2DurableCurrent(fixture);
  assert.equal(inspected.stage, "current"); assert(inspected.result.ok, JSON.stringify(inspected));
  assert.equal(currentTable(fixture.observation, "config_detach_snapshots").count, "2");
  assert.equal(currentTable(fixture.observation, "agent_runtime_bindings").count, mode === "mixed" ? "3" : "2");
  assert(inspected.result.value.configuration.runtimeUsability.every(item => item.usable));
  assert(inspected.result.value.rowStages.every(stage => stage === "p1"));
});

for (const name of ["group_participants", "agent_runtime_members"] as const) test(`M2 current: attached still requires ${name}`, async () => {
  const fixture = await m2DurableCurrentFixture("attached"); removeCurrentRows(fixture.observation, name);
  rejected(inspectM2DurableCurrent(fixture), "configuration", "PC1B-RT01");
});

test("M2 current: detached still requires its selected detach snapshot row", async () => {
  const fixture = await m2DurableCurrentFixture(); removeCurrentRows(fixture.observation, "config_detach_snapshots");
  rejected(inspectM2DurableCurrent(fixture), "current");
});

test("M2 current: the current head cannot point backward to a detached execution", async () => {
  const fixture = await m2DurableCurrentFixture(), head = currentTable(fixture.observation, "group_bindings");
  originSet(head, "current_attachment_id", "b"); originSet(head, "current_attachment_state", "attached");
  originSet(head, "current_compat_binding_revision", originRow(currentTable(fixture.base.afterB, "group_bindings")).current_compat_binding_revision!);
  rejected(inspectM2DurableCurrent(fixture), "current");
});

test("M2 current: an attached shell cannot lose the reverse head pointer", async () => {
  const fixture = await m2DurableCurrentFixture("attached"), head = currentTable(fixture.observation, "group_bindings");
  originSet(head, "current_attachment_id", null); originSet(head, "current_attachment_state", null);
  originSet(head, "current_compat_binding_revision", null);
  rejected(inspectM2DurableCurrent(fixture), "current");
});

test("M2 current: one detached execution cannot borrow another execution's snapshot", async () => {
  const fixture = await m2DurableCurrentFixture("mixed", 2), shell = currentTable(fixture.observation, "agent_runtime_bindings");
  const second = shell.rows.findIndex((_, index) => originRow(shell, index).id === "b-history-2"); assert(second >= 0);
  originSet(shell, "detach_config_snapshot_id", fixture.detaches[0]!.ref.detachSnapshotId, second);
  rejected(inspectM2DurableCurrent(fixture), "current");
});

test("M2 current: unknown attachment state cannot select the detached exception", async () => {
  const fixture = await m2DurableCurrentFixture(); originSet(currentTable(fixture.observation, "agent_runtime_bindings"), "attachment_state", "retained");
  rejected(inspectM2DurableCurrent(fixture), "configuration", "PC1B-RT01");
});

test("M2 current: a caller row-stage flag is not an authenticated raw view", async () => {
  const fixture = await m2DurableCurrentFixture(), row = currentTable(fixture.observation, "agent_runtime_bindings").rows[0]!;
  Object.assign(row, { stage: "p1" });
  rejected(inspectM2DurableCurrent(fixture), "observation", "PC1B-RAW01");
});

test("M2 current: changing a 72-table observation to P0 does not forge a detached branch", async () => {
  const fixture = await m2DurableCurrentFixture(); fixture.observation.phase = "p0";
  rejected(inspectM2DurableCurrent(fixture), "observation", "PC1B-RAW01");
});

test("M2 current: detached still joins the original member, project, group and runtime scope", async () => {
  const fixture = await m2DurableCurrentFixture(); originSet(currentTable(fixture.observation, "agent_runtime_bindings"), "member_id", "missing-member");
  rejected(inspectM2DurableCurrent(fixture), "configuration", "PC1B-RT01");
});

test("M2 current: a detached runner with a live lease still requires its actual reservation", async () => {
  const fixture = await m2DurableCurrentFixture(), runner = currentTable(fixture.observation, "agent_runner_states");
  originSet(runner, "lease_owner", "live-owner"); originSet(runner, "lease_expires_at", "2026-11-19T01:00:00.000Z");
  rejected(inspectM2DurableCurrent(fixture), "configuration", "PC1B-RT01");
});

test("M2 current: detached does not bypass original runner session grammar", async () => {
  const fixture = await m2DurableCurrentFixture(); originSet(currentTable(fixture.observation, "agent_runner_states"), "session_state", "invented-session");
  rejected(inspectM2DurableCurrent(fixture), "configuration", "PC1B-RT01");
});

test("M2 current: invalid requested JSON keeps the original unusable/no-fallback observation", async () => {
  const fixture = await m2DurableCurrentFixture(); originSet(currentTable(fixture.observation, "agent_runtime_bindings"), "requested_snapshot_json", "{");
  const inspected = inspectM2DurableCurrent(fixture); assert.equal(inspected.stage, "current"); assert(inspected.result.ok, JSON.stringify(inspected));
  const execution = inspected.result.value.configuration.runtimeUsability.find(item => item.table === "agent_runtime_bindings");
  assert(execution); assert.equal(execution.usable, false); assert.equal(execution.selected, null);
});

for (const name of ["group_participants", "agent_runtime_members"] as const) test(`the original P0 configuration branch still requires ${name}`, async () => {
  const fixture = await m2DurableCurrentFixture(), input = structuredClone(fixture.base.oldInput);
  removeCurrentRows(input.graph.observation as HistoryObservationInput, name);
  const admitted = createP0Request(JSON.stringify(input)); assert(admitted.ok, JSON.stringify(admitted));
  const result = checkP0ConfigurationFamily(admitted.value); assert(!result.ok, JSON.stringify(result));
  assert.equal(result.error.rule, "PC1B-RT01"); assert.notEqual(result.error.code, "resource_limit");
});

test("M2 current: two attached executions still conflict in the fixed partial uniqueness domain", async () => {
  const fixture = await m2DurableCurrentFixture("mixed"), shells = currentTable(fixture.observation, "agent_runtime_bindings");
  const extra = shells.rows.findIndex((_, index) => originRow(shells, index).id === "b-history-1"); assert(extra >= 0);
  originSet(shells, "attachment_state", "attached", extra); originSet(shells, "detach_config_snapshot_id", null, extra);
  originSet(shells, "detached_at", null, extra); removeCurrentRows(fixture.observation, "config_detach_snapshots");
  const error = rejected(inspectM2DurableCurrent(fixture), "current");
  assert.equal(error.code, "semantic_invariant_failed"); assert.equal(error.conflicts[0]!.condition, "duplicate-key");
});

for (const name of ["agent_runtime_bindings", "agent_runner_states"] as const) test(`M2 current: the original primary key still rejects duplicate ${name} rows`, async () => {
  const fixture = await m2DurableCurrentFixture(), table = currentTable(fixture.observation, name);
  const duplicate = structuredClone(table.rows[0]!); duplicate.rowid = "999"; table.rows.push(duplicate); table.count = "2";
  const error = rejected(inspectM2DurableCurrent(fixture), "configuration", "PC1B-RT01");
  assert.equal(error.conflicts[0]!.condition, "duplicate-key");
});

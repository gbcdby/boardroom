import assert from "node:assert/strict";
import type { HistoryObservationInput, RawTable } from "../../src/server/identity/m2-history-contracts.ts";
import type { ConfigSnapshot, DetachConfigSnapshot } from "../../src/server/identity/m2-value-contracts.ts";
import { createM2DurableRequest } from "../../src/server/identity/internal/m2-p0-request.ts";
import { p0State, p0Usage, withP0Guard } from "../../src/server/identity/internal/m2-p0-budget.ts";
import { scanM2OwnedCanonical } from "../../src/server/identity/internal/m2-owned-json.ts";
import { checkM2Origin } from "../../src/server/identity/internal/m2-durable-origin.ts";
import { checkP0ConfigurationFamily } from "../../src/server/identity/internal/m2-p0-config-family.ts";
import { checkM2CurrentValues } from "../../src/server/identity/internal/m2-durable-current.ts";
import { beginP0FArtifactPass, endP0FArtifactPass } from "../../src/server/identity/internal/m2-p0-artifacts-frame.ts";
import { m2OriginFixture } from "./m2-origin-fixture.ts";
import { originEncode, originProjectionRow, originSortRows } from "./m2-origin-fixture-business.ts";
import { originCanonical, originDigest, originSet } from "./m2-origin-fixture-store.ts";

let origin: ReturnType<typeof m2OriginFixture> | undefined;
export function currentTable(observation: HistoryObservationInput, name: string): RawTable {
  const table = observation.tables.find(value => value.name === name); assert(table, name); return table;
}
export function removeCurrentRows(observation: HistoryObservationInput, name: string): void {
  const table = currentTable(observation, name); table.rows = []; table.count = "0";
}

/** Pure later-current observation over a complete real P0 capture/ready/A/B
 * origin. No fake stage, injected replay result, native detach or P-C facade. */
export async function m2DurableCurrentFixture(mode: "attached" | "detached" | "mixed" = "detached", historyCount: 1 | 2 = 1) {
  const base = await (origin ??= m2OriginFixture());
  const observation = structuredClone(base.afterB), shells = currentTable(observation, "agent_runtime_bindings");
  const originalShell = structuredClone(shells.rows[0]!);
  const snapshots = base.snapshots as readonly ConfigSnapshot[];
  const snapshot = (kind: string) => {
    const value = snapshots.find(item => item.origin.kind === "legacy" && item.origin.legacyRef.kind === kind);
    assert(value, kind); return value;
  };
  const requested = snapshot("requestedSnapshot"), applied = snapshot("applied"), effective = snapshot("effective");
  const detaches: DetachConfigSnapshot[] = [];
  if (mode === "detached") {
    const head = currentTable(observation, "group_bindings");
    originSet(head, "current_attachment_id", null); originSet(head, "current_attachment_state", null);
    originSet(head, "current_compat_binding_revision", null);
    removeCurrentRows(observation, "group_participants"); removeCurrentRows(observation, "agent_runtime_members");
  }
  if (mode !== "attached") for (let i = 0; i < historyCount; i++) {
    const original = mode === "detached" && i === 0, executionId = original ? "b" : `b-history-${i + 1}`;
    const body: Omit<DetachConfigSnapshot, "ref"> = {
      attachment: { executionBindingId: executionId, groupBindingId: "b", runtimeId: "r" },
      profileRef: base.business.profile.ref, bindingRef: base.business.binding.ref,
      root: { state: "missing", workspaceRef: null, reasons: ["workspace_reference_missing"], runReady: false },
      currentAdvanced: { stored: { state: "none" }, effectiveStrategy: null, validity: "not_selected", blockedReasons: [] },
      resolution: { state: "complete", backend: effective.backend, config: effective.config,
        advancedStrategy: effective.advancedStrategy, semanticDigest: effective.semanticDigest },
      requested: original ? { state: "blocked", snapshotRef: requested.ref, reasons: ["workspace_reference_missing"] } : null,
      applied: original ? { state: "blocked", snapshotRef: applied.ref, reasons: ["workspace_reference_missing"] } : null,
      observedAt: `2026-11-19T00:01:0${i}.000Z`, readOnly: true, runReady: false,
    };
    const value: DetachConfigSnapshot = { ref: { detachSnapshotId: `detach-${executionId}`, contentDigest: originDigest(body) }, ...body };
    detaches.push(value);
    const detached = currentTable(observation, "config_detach_snapshots");
    detached.rows.push(originProjectionRow(originEncode("config_detach_snapshots", value), detached.columns, String(i + 1)));
    detached.count = String(detached.rows.length);
    let rowIndex = 0;
    if (!original) {
      const row = structuredClone(originalShell); row.rowid = String(117 + i);
      shells.rows.push(row); rowIndex = shells.rows.length - 1;
      originSet(shells, "id", executionId, rowIndex);
      originSet(shells, "requested_snapshot_json", null, rowIndex);
      originSet(shells, "requested_config_snapshot_id", null, rowIndex);
      originSet(shells, "requested_workspace_mapping_id", null, rowIndex);
      const runners = currentTable(observation, "agent_runner_states"), runner = structuredClone(runners.rows[0]!);
      runner.rowid = String(117 + i); runners.rows.push(runner); const runnerIndex = runners.rows.length - 1;
      originSet(runners, "binding_id", executionId, runnerIndex);
      originSet(runners, "applied_json", null, runnerIndex);
      originSet(runners, "applied_config_snapshot_id", null, runnerIndex);
      originSet(runners, "applied_workspace_mapping_id", null, runnerIndex);
      runners.count = String(runners.rows.length);
    }
    originSet(shells, "attachment_state", "detached", rowIndex);
    originSet(shells, "detach_config_snapshot_id", value.ref.detachSnapshotId, rowIndex);
    originSet(shells, "detached_at", value.observedAt, rowIndex);
    shells.count = String(shells.rows.length);
  }
  for (const table of observation.tables) originSortRows(table.rows);
  return { base, observation, detaches };
}
export type M2DurableCurrentFixture = Awaited<ReturnType<typeof m2DurableCurrentFixture>>;

/** Always replay the real origin first. The later observation is scanned and
 * authenticated on that very request; no ledger reset or semantic mock. */
export function inspectM2DurableCurrent(fixture: M2DurableCurrentFixture, observation = fixture.observation) {
  const admitted = createM2DurableRequest(fixture.base.durableWire); assert(admitted.ok, JSON.stringify(admitted));
  const request = admitted.value;
  const checkedOrigin = withP0Guard(request, () => checkM2Origin(request, fixture.base.durableInput.roots.closure));
  assert(checkedOrigin.ok, "real origin prerequisite: " + JSON.stringify(checkedOrigin));
  const usageAfterOrigin = p0Usage(request), graph = checkedOrigin.value.graph;
  const history = withP0Guard(request, () => {
    const state = p0State(request), owned = scanM2OwnedCanonical(state, originCanonical(observation), state.rootSite);
    return graph.observation(owned);
  });
  if (!history.ok) return { stage: "observation" as const, result: history, usageAfterOrigin, usage: p0Usage(request) };
  beginP0FArtifactPass(graph.f, history.value.view);
  try {
    const configuration = checkP0ConfigurationFamily(request, history.value.view);
    if (!configuration.ok) return { stage: "configuration" as const, result: configuration, usageAfterOrigin, usage: p0Usage(request) };
    const current = withP0Guard(request, () => {
      checkM2CurrentValues(graph, history.value, checkedOrigin.value);
      return { phase: history.value.view.phase, configuration: configuration.value,
        rowStages: [...history.value.view.rows("agent_runtime_bindings")].map(row => row.stage) };
    });
    return { stage: "current" as const, result: current, usageAfterOrigin, usage: p0Usage(request) };
  } finally { endP0FArtifactPass(graph.f); }
}

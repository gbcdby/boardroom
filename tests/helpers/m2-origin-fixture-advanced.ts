import assert from "node:assert/strict";
import type Database from "better-sqlite3";
import { snapshotRuntimeConfig } from "../../src/server/runtime/config.ts";
import type { ArtifactRef, CaptureRef, ProfileVersion, WorkspaceMapping, CurrentAdvancedSelection } from "../../src/server/identity/m2-value-contracts.ts";
import type { m2OriginP0Fixture } from "./m2-origin-fixture-p0.ts";
import { ORIGIN_TIME, originCanonical, originDigest, originRow, originSha } from "./m2-origin-fixture-store.ts";

/** These are persisted observation values in the private SQLite fixture. They
 * do not attest a real filesystem root, permission scope or writer admission. */
const root = Object.freeze({ workspaceRef: { projectId: "p", workspaceRevision: 1 }, canonicalRoot: "/not-contacted",
  rootIdentity: { device: "101", inode: "202", birthtimeNs: "0" }, physicalResourceKey: "fixture-only-workspace:101:202:0" });

/** Configure the old source before its real native capture/manifest/serialize.
 * The requested source equals the captured effective ordinary configuration;
 * applied remains its independent older revision and original raw text. */
export function seedOriginAdvancedWorkspace(db: Database.Database): void {
  const runtime = db.prepare("SELECT defaults_json,revision FROM agent_runtimes WHERE id='r'").get() as { defaults_json: string; revision: number };
  const execution = db.prepare("SELECT overrides_json,revision FROM agent_runtime_bindings WHERE id='b'").get() as { overrides_json: string; revision: number };
  const versions = { runtimeRevision: runtime.revision, bindingRevision: execution.revision };
  const advanced = { strategy: "bypassPermissions", ...versions };
  const requested = snapshotRuntimeConfig("claude-code", { ...JSON.parse(runtime.defaults_json), ...JSON.parse(execution.overrides_json) }, versions, "bypassPermissions");
  db.prepare("UPDATE agent_runtime_bindings SET advanced_json=?,requested_snapshot_json=? WHERE id='b'")
    .run(JSON.stringify(advanced, null, 2) + "\n", JSON.stringify(requested, null, 2) + "\n");
  db.prepare("UPDATE projects SET workspace_revision=1 WHERE id='p'").run();
  const repository = { kind: "not_git", topLevel: null, head: null, dirty: null, trackedChangedCount: null,
    untrackedCount: null, indexChanged: null, complete: true, comparison: "raw_bytes_no_filters", reason: null };
  db.prepare(`INSERT INTO project_workspace_versions(project_id,workspace_revision,project_revision,root_path,canonical_root,mode,
    root_identity_json,physical_resource_key,repository_info_json,observed_at,mutation_id,input_digest,updated_at)
    VALUES ('p',1,5,?,?,'isolated',?,?,?,?,?,?,?)`).run(root.canonicalRoot, root.canonicalRoot,
      originCanonical(root.rootIdentity), root.physicalResourceKey, originCanonical(repository), ORIGIN_TIME,
      "origin-workspace", originDigest(root), ORIGIN_TIME);
}

/** Construct the original R15 DAG: root observation has no snapshot/mapping
 * refs; the selected binding precedes equivalence; snapshots then cite its
 * digest, and mappings finally cite snapshots. No core validator is bypassed. */
export function originAdvancedWorkspace(p0: Awaited<ReturnType<typeof m2OriginP0Fixture>>, seed: any,
  profile: Pick<ProfileVersion, "ref">, binding: any, snapshots: any[], capture: CaptureRef, captureArtifact: ArtifactRef) {
  const { store, before } = p0;
  const table = (name: string) => { const found = before.tables.find(t => t.name === name); assert(found, name); return found; };
  const execution = originRow(table("agent_runtime_bindings")), member = originRow(table("members")), persisted = originRow(table("project_workspace_versions"));
  const original = JSON.parse(String(execution.advanced_json)), requested = snapshots.find(s => s.origin.legacyRef.kind === "requestedSnapshot");
  assert(requested); assert.equal(persisted.canonical_root, root.canonicalRoot);
  assert.deepEqual(JSON.parse(String(persisted.root_identity_json)), root.rootIdentity);
  const roots = new Map<string, ArtifactRef>();
  for (const snapshot of snapshots) {
    const kind = snapshot.origin.legacyRef.kind;
    const observation = { contract: "m2-workspace-root-observation/r1", source: before.source, capture,
      legacyRef: snapshot.origin.legacyRef, workspaceRef: root.workspaceRef, originalWorkdir: snapshot.config.workdir,
      canonicalRoot: persisted.canonical_root, rootIdentity: JSON.parse(String(persisted.root_identity_json)),
      physicalResourceKey: persisted.physical_resource_key, observedAt: ORIGIN_TIME };
    roots.set(kind, store.add("advanced:root:" + kind, "m2-workspace-observation", observation, [captureArtifact]));
  }
  const scope = { sourceIdentityDigest: before.source.identityDigest, agentId: profile.ref.agentId,
    executionBindingId: String(execution.id), projectId: String(execution.project_id), groupId: String(execution.group_id),
    memberId: String(execution.member_id), membershipRevision: Number(member.membership_revision),
    permissionMode: requested.config.permissionMode, tools: requested.config.tools };
  const advanced: CurrentAdvancedSelection = { state: "selected", strategy: "bypassPermissions", basis: {
    profileRef: profile.ref, bindingConfigRevision: binding.ref.bindingConfigRevision, backend: "claude-code",
    ordinaryConfigDigest: originDigest({ backend: requested.backend, config: requested.config }), root: structuredClone(root),
    existingScope: scope, existingPermissionScopeDigest: originDigest(scope),
    compatibilityBasis: { runtimeRevision: original.runtimeRevision, bindingRevision: original.bindingRevision } },
    origin: { kind: "legacy_equivalence", captureRef: capture, legacyRef: requested.origin.legacyRef } };
  binding.content.currentAdvanced = advanced;
  store.change?.("advanced:binding", binding);
  binding.ref.contentDigest = originDigest(binding.content);
  const selected = binding.content.currentAdvanced;
  const evidence = { contract: "m2-advanced-equivalence-observation/r1", source: before.source, capture,
    legacyRef: requested.origin.legacyRef, profileRef: profile.ref, bindingRef: binding.ref,
    ordinaryConfigDigest: selected.basis.ordinaryConfigDigest, rootObservation: roots.get("requestedSnapshot")!,
    existingScope: selected.basis.existingScope, existingPermissionScopeDigest: selected.basis.existingPermissionScopeDigest,
    compatibilityBasis: selected.basis.compatibilityBasis, legacyAdvancedRawDigest: originSha(String(execution.advanced_json)),
    rule: "same-captured-source-ordinary-root-scope-revisions/r1" };
  const equivalence = store.add("advanced:equivalence", "m2-advanced-equivalence", evidence,
    [captureArtifact, roots.get("requestedSnapshot")!]);
  const equivalenceDigest = originDigest(store.value("advanced:equivalence"));
  const mappings: WorkspaceMapping[] = [], workspaces = new Map<string, { state: "mapped"; mappingRef: WorkspaceMapping["ref"]; workspaceObservation: ArtifactRef }>();
  for (let i = 0; i < snapshots.length; i++) {
    const snapshot = snapshots[i], kind = snapshot.origin.legacyRef.kind, { ref, ...body } = snapshot;
    body.origin.raw.rawAdvancedJson = String(execution.advanced_json); body.origin.raw.rawAdvancedDigest = originSha(String(execution.advanced_json));
    body.advancedBasis.legacy = { originalSelection: original, originalValidity: "effective",
      mappedValidity: kind === "requestedSnapshot" ? "equivalent" : "migration_reconfirmation_required",
      equivalenceEvidenceDigest: kind === "requestedSnapshot" ? equivalenceDigest : null };
    store.change?.("advanced:snapshot:" + kind, body);
    snapshots[i] = { ref: { snapshotId: ref.snapshotId, contentDigest: originDigest(body) }, ...body };
    const mappingBody = { configSnapshotRef: snapshots[i].ref, workspaceRef: structuredClone(root.workspaceRef), originalWorkdir: snapshot.config.workdir,
      canonicalRoot: root.canonicalRoot, rootIdentity: structuredClone(root.rootIdentity), physicalResourceKey: root.physicalResourceKey, observedAt: ORIGIN_TIME,
      observationOnly: true as const, requiresRevalidation: true as const, runReady: false as const };
    store.change?.("advanced:mapping:" + kind, mappingBody);
    const slot = kind === "requestedSnapshot" ? "requested" : kind;
    const mapping: WorkspaceMapping = { ref: { mappingId: seed.bindings[0][slot].mappingId, contentDigest: originDigest(mappingBody) }, ...mappingBody };
    mappings.push(mapping); workspaces.set(kind, { state: "mapped", mappingRef: mapping.ref, workspaceObservation: roots.get(kind)! });
  }
  return { mappings, workspaces, equivalence, dependencies: [...roots.values(), equivalence] };
}

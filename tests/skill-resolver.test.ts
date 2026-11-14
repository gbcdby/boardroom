import test from "node:test";
import assert from "node:assert/strict";
import type { LegacyConfigSnapshotRef } from "../src/shared/legacy-config.ts";
import type { SkillPackagePreview, SkillSelectionSources, SkillSourceRevisions } from "../src/shared/skills.ts";
import { resolveSkills } from "../src/server/skills/resolver.ts";
const a = "a".repeat(64), b = "b".repeat(64), c = "c".repeat(64);
const snapshot: LegacyConfigSnapshotRef = { authority: "legacy", kind: "requestedSnapshot", sourceId: "binding", runtimeId: "runtime", bindingId: "binding", agentId: "agent", digest: "d".repeat(64), versions: { runtimeRevision: 2, bindingRevision: 3 }, configVersion: 1 };
function pkg(skillName: string, contentDigest: string, root = `/${skillName}/${contentDigest}`, dependencies: SkillPackagePreview["dependencies"] = []): SkillPackagePreview {
  return { kind: "local-preview", previewRef: `skill-preview:sha256:${contentDigest}`, versionId: null, skillName,
    description: skillName, declaredVersion: "1.0.0", contentDigest, invocationMode: "unknown", invocationEvidence: [],
    resources: [], dependencies, files: [], canonicalRoot: root, sourceAliases: [root], manifests: [] };
}
const sources: SkillSelectionSources = { project: null, profile: { ownerId: "profile", revision: 4, selections: [{ skillName: "review", enabled: true }] }, group: null };
const revisions: SkillSourceRevisions = { project: null, profile: { ownerId: "profile", revision: 4 }, group: null, workspaceRevision: null };
const input = { packages: [pkg("review", a), pkg("review", a, "/duplicate")], sources, workspaceRevision: null, configSnapshotRef: snapshot };

test("同名同内容合并来源；同名异内容必须精确选择；预览不发明 SkillVersion", () => {
  const same = resolveSkills(input); assert.equal(same.state, "resolved-preview");
  assert.equal(same.lock!.entries.length, 1); assert.equal(same.lock!.entries[0]!.packageSources.length, 2);
  assert.equal(same.lock!.entries[0]!.required, true); assert.equal(same.lock!.entries[0]!.invocationEligible, false);
  const ambiguous = resolveSkills({ ...input, packages: [...input.packages, pkg("review", b)] });
  assert.equal(ambiguous.lock, null); assert.equal(ambiguous.conflicts[0]!.code, "skills_conflict");
  const pinnedSources = { ...sources, group: { ownerId: "group", revision: 6, selections: [{ skillName: "review", enabled: true, pin: { versionId: "existing-version" } }] } };
  const pinned = resolveSkills({ ...input, packages: [...input.packages, pkg("review", b)], sources: pinnedSources,
    knownVersions: [{ versionId: "existing-version", skillName: "review", contentDigest: b }] });
  assert.equal(pinned.lock!.entries[0]!.contentDigest, b); assert.deepEqual(pinned.lock!.entries[0]!.exactVersionIds, ["existing-version"]);
  const missing = resolveSkills({ ...input, sources: pinnedSources });
  assert.equal(missing.conflicts[0]!.code, "pin_unresolved", "显示版本号/未登记 ID 不能猜成内容版本");
});

test("Project required/locked 不可被 Profile/群停用或换版本；optional 可显式停用", () => {
  for (const flag of ["required", "locked"] as const) {
    const project = { ownerId: "project", revision: 1, selections: [{ skillName: "review", enabled: true, pin: { contentDigest: a }, [flag]: true }] };
    for (const override of [{ skillName: "review", enabled: false }, { skillName: "review", enabled: true, pin: { contentDigest: b } }]) {
      const result = resolveSkills({ ...input, packages: [pkg("review", a), pkg("review", b)], sources: { ...sources, project, group: { ownerId: "group", revision: 1, selections: [override] } } });
      assert.equal(result.lock, null); assert.ok(result.conflicts.some(c => c.code === `${flag}_conflict`));
      assert.ok(result.conflicts.some(c => c.sources.some(s => s.kind === "project") && c.sources.some(s => s.kind === "group")));
    }
  }
  const optional = resolveSkills({ ...input, sources: { project: { ownerId: "p", revision: 1, selections: [{ skillName: "review", enabled: true, required: false }] }, profile: null,
    group: { ownerId: "g", revision: 1, selections: [{ skillName: "review", enabled: false }] } } });
  assert.deepEqual(optional.lock!.entries, []);
});

test("依赖精确展开；缺失、禁用、不兼容及环均保留来源冲突", () => {
  const parent = pkg("review", a, "/review", [{ skillName: "helper", pin: { contentDigest: b } }]);
  const good = resolveSkills({ ...input, packages: [parent, pkg("helper", b)] });
  assert.deepEqual(good.lock!.entries.map(e => e.skillName), ["helper", "review"]);
  assert.ok(good.lock!.entries[0]!.provenance.some(p => p.kind === "dependency"));
  assert.equal(resolveSkills({ ...input, packages: [parent] }).conflicts[0]!.code, "dependency_missing");
  const cycle = resolveSkills({ ...input, packages: [parent, pkg("helper", b, "/helper", [{ skillName: "review", pin: { contentDigest: a } }])] });
  assert.ok(cycle.conflicts.some(c => c.code === "dependency_cycle"));
  for (const selection of [{ skillName: "helper", enabled: false }, { skillName: "helper", enabled: true, pin: { contentDigest: c } }]) {
    const bad = resolveSkills({ ...input, packages: [parent, pkg("helper", b), pkg("helper", c)], sources: { ...sources, group: { ownerId: "g", revision: 1, selections: [selection] } } });
    assert.ok(bad.conflicts.some(c => c.code === "dependency_incompatible"));
  }
});

test("乱序输入可重建相同锁；固定 requested 原修订不受 pending 影响，未固定预览失效", () => {
  const candidate = { ...input, packages: [...input.packages, pkg("unused", b)], currentRevisions: { ...revisions, profile: { ownerId: "profile", revision: 5 } } };
  const result = resolveSkills(candidate);
  assert.deepEqual(result, resolveSkills({ ...candidate, packages: [...candidate.packages].reverse() }));
  assert.deepEqual(result.lock!.configSnapshotRef, snapshot); assert.equal(result.lock!.sourceRevisions.profile?.revision, 4);
  const effective = { ...snapshot, kind: "effective" as const };
  const changed = resolveSkills({ ...candidate, configSnapshotRef: effective, currentConfigSnapshotRef: effective });
  assert.equal(changed.conflicts[0]!.code, "source_changed");
  const current = resolveSkills({ ...candidate, configSnapshotRef: effective, currentConfigSnapshotRef: effective, currentRevisions: revisions });
  assert.equal(current.state, "resolved-preview");
  const noSkills = resolveSkills({ ...input, packages: [], sources: { project: null, profile: null, group: null } });
  assert.deepEqual(noSkills.lock!.entries, []);
});

test("锁不保留调用方可变输入；来源/依赖数组乱序不改变内容身份", () => {
  const ownedSnapshot = structuredClone(snapshot), sourcesOwned = structuredClone(sources);
  const parent = pkg("review", a, "/review", [{ skillName: "helper", pin: { contentDigest: b } }, { skillName: "third", pin: { contentDigest: c } }]);
  const packages = [parent, pkg("helper", b), pkg("third", c)];
  const result = resolveSkills({ ...input, packages, sources: sourcesOwned, configSnapshotRef: ownedSnapshot });
  const reordered = packages.map(p => ({ ...p, dependencies: [...p.dependencies].reverse(), sourceAliases: [...p.sourceAliases].reverse() })).reverse();
  assert.deepEqual(resolveSkills({ ...input, packages: reordered, sources: sourcesOwned, configSnapshotRef: ownedSnapshot }), result);
  (ownedSnapshot.versions as { runtimeRevision: number }).runtimeRevision = 999;
  assert.equal(result.lock!.configSnapshotRef.versions.runtimeRevision, 2);
});

test("精确依赖可解除未 pin 根技能的歧义，required 向依赖传递，扫描发现不自动启用", () => {
  const parent = pkg("review", a, "/review", [{ skillName: "helper", pin: { contentDigest: b } }]);
  const result = resolveSkills({ ...input, packages: [parent, pkg("helper", b), pkg("helper", c), pkg("unused", c)], sources: { ...sources,
    profile: { ownerId: "profile", revision: 4, selections: [{ skillName: "helper", enabled: true, required: false }, ...sources.profile!.selections] } } });
  assert.equal(result.state, "resolved-preview");
  assert.deepEqual(result.lock!.entries.map(item => [item.skillName, item.required]), [["helper", true], ["review", true]]);
});

test("同内容来源携带不同已知调用限制时取严格者并保留两处来源", () => {
  const known = { ...pkg("review", a, "/known"), invocationMode: "user-only" as const };
  const result = resolveSkills({ ...input, packages: [pkg("review", a, "/unknown"), known] });
  assert.equal(result.state, "resolved-preview");
  assert.equal(result.lock!.entries[0]?.invocationMode, "user-only");
  assert.deepEqual(result.lock!.entries[0]?.packageSources, ["/known", "/unknown"]);
});

test("跨层选择合并也受依赖图节点预算约束", () => {
  const names = Array.from({ length: 257 }, (_, n) => `node-${n}`);
  const candidates = names.map(name => pkg(name, a));
  const result = resolveSkills({ ...input, packages: candidates, sources: { project: null,
    profile: { ownerId: "profile", revision: 1, selections: names.slice(0, 256).map(skillName => ({ skillName, enabled: true })) },
    group: { ownerId: "group", revision: 1, selections: [{ skillName: names[256]!, enabled: true }] } } });
  assert.equal(result.lock, null); assert.equal(result.conflicts[0]?.code, "invalid_selection");
});

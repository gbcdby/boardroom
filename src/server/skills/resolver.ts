import { z } from "zod";
import type { LegacyConfigSnapshotRef } from "../../shared/legacy-config.ts";
import type { SkillConflict, SkillExactPin, SkillKnownVersion, SkillLockEntry, SkillPackagePreview, SkillProvenance,
  SkillResolutionPreview, SkillSelection, SkillSelectionSources, SkillSourceRevisions } from "../../shared/skills.ts";
import { canonical, compare, digest, uniqueSorted } from "./common.ts";
import { exactPinSchema } from "./metadata.ts";

export interface ResolveSkillsInput {
  readonly packages: readonly SkillPackagePreview[];
  readonly sources: SkillSelectionSources;
  readonly configSnapshotRef: LegacyConfigSnapshotRef;
  readonly workspaceRevision: number | null;
  readonly knownVersions?: readonly SkillKnownVersion[];
  /** 仅来自实际持有当前来源的一方；未固定预览缺少此对照时不能声称仍有效。 */
  readonly currentRevisions?: SkillSourceRevisions;
  readonly currentConfigSnapshotRef?: LegacyConfigSnapshotRef;
}
const selectionSchema = z.object({ skillName: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), enabled: z.boolean(),
  pin: exactPinSchema.optional(), required: z.boolean().optional(), locked: z.boolean().optional() }).strict();
const layerSchema = z.object({ ownerId: z.string().min(1), revision: z.number().int().positive(), selections: z.array(selectionSchema).max(256) }).strict().nullable();
const sourcesSchema = z.object({ project: layerSchema, profile: layerSchema, group: layerSchema }).strict();
const versionsSchema = z.array(z.object({ versionId: z.string().min(1).max(256), skillName: z.string().min(1), contentDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(4096);
const snapshotSchema = z.object({ authority: z.literal("legacy"), kind: z.enum(["effective", "requestedSnapshot", "applied"]),
  sourceId: z.string().min(1), runtimeId: z.string().min(1), bindingId: z.string().min(1), agentId: z.string().min(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/), versions: z.object({ runtimeRevision: z.number().int().positive(), bindingRevision: z.number().int().positive() }).strict(),
  configVersion: z.number().int().positive() }).strict();
export function skillSourceRevisions(sources: SkillSelectionSources, workspaceRevision: number | null): SkillSourceRevisions {
  const ref = (layer: SkillSelectionSources["project"]) => layer ? { ownerId: layer.ownerId, revision: layer.revision } : null;
  return { project: ref(sources.project), profile: ref(sources.profile), group: ref(sources.group), workspaceRevision };
}
const conflictResult = (conflicts: readonly SkillConflict[]): SkillResolutionPreview => ({ readOnly: true, activationAllowed: false, state: "conflict", lock: null, conflicts: uniqueSorted(conflicts) });
export function skillPreviewConflict(code: SkillConflict["code"], message: string): SkillResolutionPreview {
  return conflictResult([{ code, skillName: null, message, sources: [], candidates: [] }]);
}
interface Rule { selection: SkillSelection; provenance: SkillProvenance }
interface Effective { selection: SkillSelection; rules: Rule[] }
interface Constraint { pin: SkillExactPin | null; required: boolean; provenance: SkillProvenance }

/** 纯数据解析：不查最新 Profile、不写 DB、不登记版本或调用记录。 */
export function resolveSkills(input: ResolveSkillsInput): SkillResolutionPreview {
  const parsed = sourcesSchema.safeParse(input.sources), versions = versionsSchema.safeParse(input.knownVersions ?? []);
  if (!parsed.success || !versions.success || (input.workspaceRevision !== null && (!Number.isSafeInteger(input.workspaceRevision) || input.workspaceRevision < 1)))
    return skillPreviewConflict("invalid_selection", "选择来源、精确版本或工作区修订无效");
  if (!snapshotSchema.safeParse(input.configSnapshotRef).success) return skillPreviewConflict("config_snapshot_invalid", "必须传入 S2 原配置快照引用");
  const sources = Object.fromEntries(Object.entries(parsed.data).map(([kind, layer]) => [kind, layer ? { ...layer, selections: uniqueSorted(layer.selections) } : null])) as unknown as SkillSelectionSources;
  const sourceRevisions = skillSourceRevisions(sources, input.workspaceRevision), fixed = input.configSnapshotRef.kind !== "effective";
  if (!fixed && (canonical(input.currentRevisions ?? null) !== canonical(sourceRevisions)
    || canonical(input.currentConfigSnapshotRef ?? null) !== canonical(input.configSnapshotRef))) return skillPreviewConflict("source_changed", "未固定预览的来源修订/配置快照已变或尚未重新核对");
  const conflicts: SkillConflict[] = [];
  const addConflict = (code: SkillConflict["code"], skillName: string, message: string, evidence: readonly SkillProvenance[], candidates: readonly string[] = []) => {
    conflicts.push({ code, skillName, message, sources: uniqueSorted(evidence), candidates: [...new Set(candidates)].sort(compare) });
  };
  const knownVersions = uniqueSorted(versions.data), versionMap = new Map<string, SkillKnownVersion>();
  for (const version of knownVersions) {
    const previous = versionMap.get(version.versionId);
    if (previous && canonical(previous) !== canonical(version)) addConflict("invalid_selection", version.skillName, "同一 versionId 对应多种内容", []);
    versionMap.set(version.versionId, version);
  }
  const normalizedPackages = uniqueSorted(input.packages.map(pkg => ({ ...pkg,
    dependencies: uniqueSorted(pkg.dependencies), resources: uniqueSorted(pkg.resources), files: uniqueSorted(pkg.files),
    invocationEvidence: uniqueSorted(pkg.invocationEvidence), sourceAliases: uniqueSorted(pkg.sourceAliases), manifests: uniqueSorted(pkg.manifests) })));
  const catalog = new Map<string, Map<string, SkillPackagePreview[]>>();
  for (const pkg of normalizedPackages) {
    const entries = catalog.get(pkg.skillName) ?? new Map<string, SkillPackagePreview[]>();
    entries.set(pkg.contentDigest, [...(entries.get(pkg.contentDigest) ?? []), pkg]); catalog.set(pkg.skillName, entries);
  }
  const candidateRefs = (name: string) => [...(catalog.get(name)?.keys() ?? [])].map(hash => `skill-preview:sha256:${hash}`).sort(compare);
  const pinDigest = (name: string, pin: SkillExactPin, evidence: readonly SkillProvenance[]): string | null => {
    if ("contentDigest" in pin) return pin.contentDigest;
    const known = versionMap.get(pin.versionId);
    if (!known || known.skillName !== name) { addConflict("pin_unresolved", name, "精确 versionId 没有对应的已知内容映射", evidence, candidateRefs(name)); return null; }
    return known.contentDigest;
  };
  const allRules = new Map<string, Rule[]>();
  for (const kind of ["project", "profile", "group"] as const) {
    const layer = sources[kind]; if (!layer) continue;
    const seen = new Set<string>();
    for (const selection of layer.selections) {
      const provenance: SkillProvenance = { kind, ownerId: layer.ownerId, revision: layer.revision, via: [] };
      if (seen.has(selection.skillName)) addConflict("invalid_selection", selection.skillName, "同一配置来源含矛盾的重复技能选择", [provenance]);
      seen.add(selection.skillName);
      if (kind !== "project" && selection.locked !== undefined) addConflict("invalid_selection", selection.skillName, "locked 约束只归 Project 所有", [provenance]);
      if (!selection.enabled && selection.required === true) addConflict("invalid_selection", selection.skillName, "停用项不能同时 required", [provenance]);
      allRules.set(selection.skillName, [...(allRules.get(selection.skillName) ?? []), { selection, provenance }]);
    }
  }
  const effective = new Map<string, Effective>(), constraints = new Map<string, Constraint[]>();
  for (const [name, rules] of [...allRules.entries()].sort(([a], [b]) => compare(a, b))) {
    const project = rules.find(rule => rule.provenance.kind === "project");
    let selection: SkillSelection = { ...rules[0]!.selection };
    for (const rule of rules) {
      const next = rule.selection;
      if (project && rule !== project) {
        const protectedRequired = project.selection.enabled && project.selection.required !== false;
        const protectedLocked = project.selection.locked === true;
        const sources = [project.provenance, rule.provenance];
        const mismatch = project.selection.pin && next.enabled && next.pin
          && pinDigest(name, project.selection.pin, sources) !== pinDigest(name, next.pin, sources);
        if (protectedLocked && (next.enabled !== project.selection.enabled || mismatch)) addConflict("locked_conflict", name, "不能停用或替换 Project locked 版本", sources, candidateRefs(name));
        if (protectedRequired && (!next.enabled || mismatch)) addConflict("required_conflict", name, "不能停用或不兼容地替换 Project required 版本", sources, candidateRefs(name));
      }
      selection = { ...selection, ...next, required: next.enabled ? (next.required ?? true) : false };
    }
    if (project?.selection.enabled && project.selection.required !== false) selection = { ...selection, required: true };
    effective.set(name, { selection, rules });
    if (selection.enabled) {
      constraints.set(name, rules.map(rule => ({ pin: null, required: selection!.required !== false, provenance: rule.provenance })));
      constraints.get(name)!.push({ pin: selection.pin ?? null, required: selection.required !== false, provenance: rules.at(-1)!.provenance });
      if (project?.selection.enabled && (project.selection.required !== false || project.selection.locked) && project.selection.pin) {
        constraints.get(name)!.push({ pin: project.selection.pin, required: selection.required !== false, provenance: project.provenance });
      }
    }
  }
  if (constraints.size > 256) return skillPreviewConflict("invalid_selection", "依赖图超过 256 个节点预算");
  if (conflicts.length) return conflictResult(conflicts);
  const resolved = new Map<string, { packages: SkillPackagePreview[]; required: boolean }>(), expanded = new Set<string>();
  let progress = true, edgeCount = 0;
  // 有精确依赖可解除未固定版本的歧义。先解析可确定节点，再收集其依赖，不猜候选。
  while (progress && !conflicts.length) {
    progress = false;
    for (const [name, rules] of [...constraints.entries()].sort(([a], [b]) => compare(a, b))) {
      const evidence = rules.map(rule => rule.provenance), fromDependency = rules.some(rule => rule.provenance.kind === "dependency");
      if (effective.get(name)?.selection.enabled === false) {
        addConflict("dependency_incompatible", name, "依赖被显式停用", [...evidence, ...effective.get(name)!.rules.map(rule => rule.provenance)]); continue;
      }
      const pins = rules.filter(rule => rule.pin).map(rule => pinDigest(name, rule.pin!, evidence));
      if (pins.includes(null)) continue;
      const hashes = [...new Set(pins as string[])];
      if (hashes.length > 1) { addConflict(fromDependency ? "dependency_incompatible" : "skills_conflict", name, "精确版本约束互不兼容", evidence, candidateRefs(name)); continue; }
      const versions = catalog.get(name);
      if (!versions?.size) { addConflict(fromDependency ? "dependency_missing" : "missing_skill", name, "选中技能或其依赖没有本地候选", evidence); continue; }
      const selectedHash = hashes[0] ?? (versions.size === 1 ? [...versions.keys()][0] : undefined);
      if (!selectedHash) continue;
      const packages = versions.get(selectedHash);
      if (!packages) { addConflict(fromDependency ? "dependency_missing" : "missing_skill", name, "没有精确匹配的本地内容版本", evidence, candidateRefs(name)); continue; }
      const required = rules.some(rule => rule.required), previous = resolved.get(name);
      if (!previous || previous.required !== required) { resolved.set(name, { packages, required }); progress = true; }
      // 内容摘要相同的来源应有相同元数据；包检查是正式来源，此处仍拒绝伪造的矛盾输入。
      const declarations = uniqueSorted(packages.map(pkg => ({ dependencies: pkg.dependencies })));
      if (declarations.length !== 1) { addConflict("invalid_selection", name, "同摘要候选元数据不一致", evidence); continue; }
      const key = `${name}:${required}`;
      if (expanded.has(key)) continue;
      expanded.add(key);
      for (const dependency of declarations[0]!.dependencies) {
        edgeCount++;
        if (edgeCount > 4096 || (constraints.size >= 256 && !constraints.has(dependency.skillName))) { addConflict("invalid_selection", name, "依赖图超过预览预算", evidence); break; }
        const provenance: SkillProvenance = { kind: "dependency", ownerId: packages[0]!.previewRef, revision: null, via: [name, dependency.skillName] };
        constraints.set(dependency.skillName, uniqueSorted([...(constraints.get(dependency.skillName) ?? []), { pin: dependency.pin, required, provenance }]));
        progress = true;
      }
    }
  }
  if (!conflicts.length) for (const [name, rules] of constraints) if (!resolved.has(name)) addConflict("skills_conflict", name, "同名异内容需要显式 pin", rules.map(rule => rule.provenance), candidateRefs(name));
  const visited = new Set<string>();
  function visit(name: string, stack: readonly string[]) {
    if (stack.includes(name)) { addConflict("dependency_cycle", name, `依赖环：${[...stack.slice(stack.indexOf(name)), name].join(" → ")}`,
      (constraints.get(name) ?? []).map(rule => rule.provenance)); return; }
    if (visited.has(name)) return;
    for (const dependency of [...(resolved.get(name)?.packages[0]?.dependencies ?? [])].sort((a, b) => compare(a.skillName, b.skillName))) visit(dependency.skillName, [...stack, name]);
    visited.add(name);
  }
  if (!conflicts.length) for (const name of [...resolved.keys()].sort(compare)) visit(name, []);
  if (conflicts.length) return conflictResult(conflicts);
  const entries: SkillLockEntry[] = [...resolved.entries()].sort(([a], [b]) => compare(a, b)).map(([skillName, resolved]) => {
    const pkg = resolved.packages[0]!;
    return { skillName, previewRef: pkg.previewRef, contentDigest: pkg.contentDigest, required: resolved.required,
      exactVersionIds: knownVersions.filter(v => v.skillName === skillName && v.contentDigest === pkg.contentDigest).map(v => v.versionId).sort(compare),
      invocationMode: resolved.packages.some(p => p.invocationMode === "user-only") ? "user-only"
        : resolved.packages.some(p => p.invocationMode === "unknown") ? "unknown" : "implicit-or-explicit",
      invocationEligible: false, dependencies: uniqueSorted(pkg.dependencies),
      packageSources: [...new Set(resolved.packages.flatMap(pkg => [pkg.canonicalRoot, ...pkg.sourceAliases]))].sort(compare),
      provenance: uniqueSorted((constraints.get(skillName) ?? []).map(rule => rule.provenance)) };
  });
  const lock = { schemaVersion: "skill-lock-preview/v1" as const, authority: "preview-only" as const, configSnapshotRef: input.configSnapshotRef,
    sourceRevisions, fixed, inventoryDigest: digest(normalizedPackages), versionReferences: knownVersions, entries, selectionSources: sources };
  const snapshot = structuredClone(lock);
  return { readOnly: true, activationAllowed: false, state: "resolved-preview", conflicts: [], lock: { ...snapshot, digest: digest(snapshot) } };
}

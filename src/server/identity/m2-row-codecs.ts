import { createHash } from "node:crypto";
import { M2_COLUMN_CONTRACT, M2_FORMAT_REGISTRATION } from "./m2-value-contracts.ts";
import { parseM2Value, m2ValueDigest } from "./m2-value-codecs.ts";
import type { M2ArtifactReference, M2Cell, M2DecodedRow, M2ExecutionReferenceProjection, M2ForeignKey,
  M2RemainingSourceCheck, M2RowProjection, M2RowTypes, M2ValueErrorCode, M2ValueResult, M2ValueTypes } from "./m2-value-contracts.ts";
import { canonicalJson } from "../storage/maintenance/canonical.ts";

type Data = null | string | number | boolean | Data[] | { [key: string]: Data };
type Obj = Record<string, unknown>;
type Table = keyof M2RowTypes;
type Projection = M2RowProjection | M2ExecutionReferenceProjection;
type Column = { readonly name: string; readonly domain: string; readonly nullable: boolean; readonly ordinal: number };
const failures = new WeakMap<object, M2ValueErrorCode>();
function fail(code: M2ValueErrorCode = "invalid_value"): never { const error = Object.create(null) as object; failures.set(error, code); throw error; }
function requireValue(condition: unknown, code: M2ValueErrorCode = "invalid_value"): asserts condition { if (!condition) fail(code); }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}

// INPUT-ISOLATION-DELTA: fixed standard shapes, never a module-load trust snapshot.
// E1/P1 allocate ordinary objects internally; admit ambient prototypes before they run.
const OBJECT_METHODS = Object.freeze("constructor __defineGetter__ __defineSetter__ hasOwnProperty __lookupGetter__ __lookupSetter__ isPrototypeOf propertyIsEnumerable toString valueOf toLocaleString".split(" "));
const ARRAY_METHODS = Object.freeze("constructor at concat copyWithin fill find findIndex findLast findLastIndex lastIndexOf pop push reverse shift unshift slice sort splice includes indexOf join keys entries values forEach filter flat flatMap map every some reduce reduceRight toReversed toSorted toSpliced with toLocaleString toString".split(" "));
const UNSCOPABLES = Object.freeze("at copyWithin entries fill find findIndex findLast findLastIndex flat flatMap includes keys toReversed toSorted toSpliced values".split(" "));
type PrototypeState = Map<object, Map<PropertyKey, PropertyDescriptor>>;
function ownData(descriptor: PropertyDescriptor | undefined): descriptor is PropertyDescriptor & { value: unknown } {
  return descriptor !== undefined && Object.hasOwn(descriptor, "value") && Object.hasOwn(descriptor, "writable")
    && !Object.hasOwn(descriptor, "get") && !Object.hasOwn(descriptor, "set");
}
function prototypeState(previous?: PrototypeState): PrototypeState {
  const state: PrototypeState = new Map();
  const require = (condition: unknown): void => { if (!condition) fail("invalid_value"); };
  require(Object.getPrototypeOf(Object.prototype) === null && Object.getPrototypeOf(Array.prototype) === Object.prototype);
  const inspect = (prototype: object, methods: readonly string[], kind: "object" | "array" | "unscopables", expected: PrototypeState | undefined = previous) => {
    const keys = Reflect.ownKeys(prototype), descriptors = new Map<PropertyKey, PropertyDescriptor>();
    require(keys.length === methods.length + (kind === "object" ? 1 : kind === "array" ? 3 : 0));
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]!, d = Object.getOwnPropertyDescriptor(prototype, key);
      if (!d || !Object.hasOwn(d, "enumerable") || !Object.hasOwn(d, "configurable")) fail("invalid_value");
      const method = typeof key === "string" && methods.includes(key);
      if (kind === "object" && key === "__proto__") {
        require(!Object.hasOwn(d, "value") && !Object.hasOwn(d, "writable") && Object.hasOwn(d, "get") && Object.hasOwn(d, "set")
          && typeof d.get === "function" && typeof d.set === "function" && d.enumerable === false && d.configurable === true);
      } else if (kind === "array" && key === "length") {
        require(ownData(d) && d.value === 0 && d.writable === true && d.enumerable === false && d.configurable === false);
      } else if (kind === "array" && key === Symbol.unscopables) {
        require(ownData(d) && d.value !== null && typeof d.value === "object" && d.writable === false && d.enumerable === false && d.configurable === true);
      } else if (kind === "unscopables" && method) {
        require(ownData(d) && d.value === true && d.writable === true && d.enumerable === true && d.configurable === true);
      } else {
        require((method || kind === "array" && key === Symbol.iterator) && ownData(d)
          && typeof d.value === "function" && d.writable === true && d.enumerable === false && d.configurable === true);
      }
      if (expected) {
        const old = expected.get(prototype)?.get(key);
        if (!old) fail("invalid_value");
        for (const field of ["value", "writable", "get", "set", "enumerable", "configurable"] as const) {
          const present = Object.hasOwn(d, field);
          require(present === Object.hasOwn(old, field) && (!present || Object.is(d[field], old[field])));
        }
      }
      descriptors.set(key, d);
    }
    state.set(prototype, descriptors);
    return descriptors;
  };
  inspect(Object.prototype, OBJECT_METHODS, "object");
  const array = inspect(Array.prototype, ARRAY_METHODS, "array");
  const iterator = array.get(Symbol.iterator), values = array.get("values"), unscopables = array.get(Symbol.unscopables);
  if (!ownData(iterator) || !ownData(values) || !ownData(unscopables)) fail("invalid_value");
  require(iterator.value === values.value);
  const exclusions = unscopables.value;
  if (exclusions === null || typeof exclusions !== "object") fail("invalid_value");
  require(Object.getPrototypeOf(exclusions) === null);
  inspect(exclusions, UNSCOPABLES, "unscopables");
  // The data object above may be a Proxy. Close its last reflection window using
  // only the intrinsic roots, comparing against this call's captured descriptors.
  require(Object.getPrototypeOf(Object.prototype) === null && Object.getPrototypeOf(Array.prototype) === Object.prototype);
  inspect(Object.prototype, OBJECT_METHODS, "object", state);
  inspect(Array.prototype, ARRAY_METHODS, "array", state);
  return state;
}

/** 每次公开调用只创建一个预算；JSON 列和其固定 raw 子路径沿用它。 */
class Budget {
  private bytes = 0;
  private nodes = 0;
  private readonly path = new Set<object>();
  node(depth: number): void { if (depth > 64 || ++this.nodes > 250000) fail("budget_exceeded"); }
  charge(bytes: number): void { if (bytes > 16777216 - this.bytes) fail("budget_exceeded"); this.bytes += bytes; }
  private string(value: string): void {
    if (value.length > 16777216 - this.bytes) fail("budget_exceeded");
    this.charge(2);
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code)) this.charge(2);
      else if (code < 32) this.charge(6);
      else if (code < 128) this.charge(1);
      else if (code < 2048) this.charge(2);
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { this.charge(4); i++; }
      else this.charge(code >= 0xd800 && code <= 0xdfff ? 6 : 3);
    }
  }
  copy(value: unknown, depth = 0): Data {
    this.node(depth);
    if (value === null) { this.charge(4); return null; }
    if (typeof value === "string") { this.string(value); return value; }
    if (typeof value === "boolean") { this.charge(value ? 4 : 5); return value; }
    if (typeof value === "number") { requireValue(Number.isSafeInteger(value) && !Object.is(value, -0)); this.charge(String(value).length); return value; }
    requireValue(typeof value === "object" && !this.path.has(value));
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    requireValue(array ? prototype === Array.prototype : prototype === Object.prototype || prototype === null);
    this.path.add(value);
    try {
      const keys = Reflect.ownKeys(value);
      requireValue(keys.every(key => typeof key === "string"));
      if (keys.length > 250001) fail("budget_exceeded");
      const descriptors = new Map<PropertyKey, PropertyDescriptor>();
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key); requireValue(descriptor);
        descriptors.set(key, descriptor);
      }
      if (array) {
        const length = descriptors.get("length");
        requireValue(ownData(length) && typeof length.value === "number" && Number.isSafeInteger(length.value) && length.value >= 0 && !Object.is(length.value, -0) && length.enumerable === false);
        if (length.value > 250000) fail("budget_exceeded");
        requireValue(keys.length === length.value + 1); this.charge(2 + Math.max(0, length.value - 1));
        const out: Data[] = [];
        for (let i = 0; i < length.value; i++) {
          const descriptor = descriptors.get(String(i)); requireValue(ownData(descriptor) && descriptor.enumerable === true);
          Object.defineProperty(out, String(i), { __proto__: null, value: this.copy(descriptor.value, depth + 1), enumerable: true, configurable: true, writable: true } as PropertyDescriptor);
        }
        return out;
      }
      this.charge(2 + Math.max(0, keys.length - 1));
      const out = Object.create(null) as { [key: string]: Data };
      for (const key of keys as string[]) {
        const descriptor = descriptors.get(key); requireValue(ownData(descriptor) && descriptor.enumerable === true);
        this.string(key); this.charge(1);
        Object.defineProperty(out, key, { __proto__: null, value: this.copy(descriptor.value, depth + 1), enumerable: true, configurable: true, writable: true } as PropertyDescriptor);
      }
      return out;
    } finally { this.path.delete(value); }
  }
  json(value: string, depth = 4): unknown {
    let offset = 0;
    const space = () => { while (/[\x20\t\r\n]/.test(value[offset] ?? "x")) offset++; };
    const string = () => {
      requireValue(value[offset++] === '"');
      while (offset < value.length) {
        const ch = value[offset++]!;
        if (ch === '"') return;
        requireValue(ch.charCodeAt(0) >= 32);
        if (ch === "\\") {
          const escape = value[offset++]; requireValue(escape !== undefined && '"\\/bfnrtu'.includes(escape));
          if (escape === "u") { requireValue(/^[0-9a-fA-F]{4}$/.test(value.slice(offset, offset + 4))); offset += 4; }
        }
      }
      fail();
    };
    const parse = (level: number): void => {
      this.node(level); space(); const ch = value[offset];
      if (ch === '"') { string(); return; }
      if (ch === "{" || ch === "[") {
        offset++; space(); const end = ch === "{" ? "}" : "]";
        if (value[offset] === end) { offset++; return; }
        while (true) {
          if (ch === "{") { space(); string(); space(); requireValue(value[offset++] === ":"); }
          parse(level + 1); space();
          if (value[offset] === end) { offset++; return; }
          requireValue(value[offset++] === ",");
        }
      }
      const token = /^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(value.slice(offset));
      requireValue(token); offset += token[0].length;
    };
    parse(depth); space(); requireValue(offset === value.length);
    return JSON.parse(value) as unknown;
  }
}
function result<T>(input: unknown, body: (value: Data, budget: Budget) => T): M2ValueResult<T> {
  try {
    const environment = prototypeState(), budget = new Budget(), copy = budget.copy(input);
    prototypeState(environment); // No caller object reaches JSON, value codecs or row projection.
    const value = body(copy, budget); prototypeState(environment);
    return freeze({ ok: true, classification: "value-consistent", value }) as M2ValueResult<T>;
  }
  catch (error) {
    const code = error !== null && (typeof error === "object" || typeof error === "function") ? failures.get(error) : undefined;
    return freeze({ ok: false, error: { code: code ?? "invalid_value" } });
  }
}
function object(value: unknown, fields: string): Obj {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value));
  const keys = Object.keys(value), expected = fields.split(" ");
  requireValue(keys.length === expected.length && keys.every(key => expected.includes(key)));
  return value as Obj;
}
function id(value: unknown): string { requireValue(typeof value === "string" && value.length > 0); return value; }
function revision(value: unknown): number { requireValue(typeof value === "number" && Number.isSafeInteger(value) && value > 0); return value; }
function digest(value: unknown): string { requireValue(typeof value === "string" && /^[0-9a-f]{64}$/.test(value)); return value; }
function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null { return value === null ? null : parse(value); }
function equal(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }
function pair(...values: unknown[]): void { requireValue(values.every(v => v === null) || values.every(v => v !== null), "value_conflict"); }
function portable(value: string): void { requireValue(!value.includes("\0") && Buffer.from(value, "utf8").toString("utf8") === value, "unsupported_shape"); }
function r3(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(r3).join(",")}]`;
  const compare = (left: string, right: string) => {
    const a = Array.from(left), b = Array.from(right);
    for (let i = 0; i < Math.min(a.length, b.length); i++) { const difference = a[i]!.codePointAt(0)! - b[i]!.codePointAt(0)!; if (difference) return difference; }
    return a.length - b.length;
  };
  return `{${Object.keys(value).sort(compare).map(key => `${JSON.stringify(key)}:${r3((value as Obj)[key])}`).join(",")}}`;
}
function parsed<K extends keyof M2ValueTypes>(kind: K, value: unknown): M2ValueTypes[K] {
  const result = parseM2Value({ kind, value }); if (!result.ok) fail(result.error.code);
  requireValue(result.value.kind === kind); return result.value.value as M2ValueTypes[K];
}
function bindingRef(value: unknown): { groupBindingId: string; bindingConfigRevision: number; contentDigest: string } {
  const v = object(value, "groupBindingId bindingConfigRevision contentDigest");
  return { groupBindingId: id(v.groupBindingId), bindingConfigRevision: revision(v.bindingConfigRevision), contentDigest: digest(v.contentDigest) };
}
function evidenceRef(value: unknown): { artifactId: string; digest: string } {
  const v = object(value, "artifactId digest"); return { artifactId: id(v.artifactId), digest: digest(v.digest) };
}
function tableInfo(table: Table): { readonly table: string; readonly columns: readonly Column[] } {
  if (table === "execution-binding-references") return M2_COLUMN_CONTRACT.executionFragments[0]!;
  if (table === "runner-applied-references") return M2_COLUMN_CONTRACT.executionFragments[1]!;
  const info = M2_COLUMN_CONTRACT.relations.find(row => row.table === table); requireValue(info, "unsupported_shape"); return info;
}
function knownTable(value: unknown): Table {
  requireValue(typeof value === "string");
  requireValue(value === "execution-binding-references" || value === "runner-applied-references" || M2_COLUMN_CONTRACT.relations.some(r => r.table === value), "unsupported_shape");
  return value as Table;
}
function cell(value: unknown, column: Column): M2Cell {
  if (value === null) { requireValue(column.nullable); return { kind: "null" }; }
  if (["N", "I", "F", "INTEGER"].includes(column.domain)) {
    const n = revision(value); requireValue(column.domain !== "INTEGER" || n === 1);
    requireValue(!["I", "F"].includes(column.domain) || n <= 2147483647);
    return { kind: "integer", decimal: String(n) };
  }
  requireValue(typeof value === "string");
  if (column.domain === "H") requireValue(/^[0-9a-f]{64}$/.test(value));
  else if (column.domain !== "J") id(value);
  portable(value); return { kind: "text", value };
}
function project(table: Table, values: Record<string, unknown>, identity?: Record<string, string>): Projection {
  const info = tableInfo(table), cells: Record<string, M2Cell> = {};
  for (const column of info.columns) cells[column.name] = cell(values[column.name], column);
  if (identity) { for (const value of Object.values(identity)) portable(value); return { contract: "m2-execution-reference-projection/r1", table: info.table, identity, cells } as M2ExecutionReferenceProjection; }
  return { contract: "m2-row-projection/r1", table, cells } as M2RowProjection;
}
function build(table: Table, input: unknown, budget: Budget, parsedDepth = 1): { value: unknown; projection: Projection } {
  if (table === "agent_profiles") {
    const v = object(input, "agentId currentRevision legacyRuntimeId compatRuntimeRevision");
    const value = { agentId: id(v.agentId), currentRevision: revision(v.currentRevision), legacyRuntimeId: nullable(v.legacyRuntimeId, id), compatRuntimeRevision: nullable(v.compatRuntimeRevision, revision) };
    pair(value.legacyRuntimeId, value.compatRuntimeRevision);
    return { value, projection: project(table, { agent_id: value.agentId, current_revision: value.currentRevision, legacy_runtime_id: value.legacyRuntimeId, compat_runtime_revision: value.compatRuntimeRevision }) };
  }
  if (table === "agent_profile_versions") {
    const v = object(input, "version compatRuntimeRevision"), version = parsed("profile-version", v.version);
    const value = { version, compatRuntimeRevision: nullable(v.compatRuntimeRevision, revision) }, role = version.content.defaultRoleRef;
    return { value, projection: project(table, { agent_id: version.ref.agentId, revision: version.ref.profileRevision,
      content_json: r3(version.content), content_digest: version.ref.contentDigest, default_role_id: role?.roleTemplateId ?? null,
      default_role_revision: role?.revision ?? null, compat_runtime_revision: value.compatRuntimeRevision }) };
  }
  if (table === "group_binding_config_versions") {
    const v = object(input, "ref content compatibility"), ref = bindingRef(v.ref), content = parsed("binding-content", v.content);
    const checkedDigest = m2ValueDigest({ kind: "binding-content", body: content }); if (!checkedDigest.ok) fail(checkedDigest.error.code);
    const compatibility = v.compatibility === null ? null : object(v.compatibility, "executionBindingId bindingRevision");
    const compat = compatibility === null ? null : { executionBindingId: id(compatibility.executionBindingId), bindingRevision: revision(compatibility.bindingRevision) };
    requireValue(ref.contentDigest === checkedDigest.value.digest, "value_conflict");
    const advanced = content.currentAdvanced, chosen = advanced.state === "selected" ? advanced : null;
    if (chosen) {
      requireValue(chosen.basis.bindingConfigRevision === ref.bindingConfigRevision, "value_conflict");
      if (compat) requireValue(chosen.basis.existingScope.executionBindingId === compat.executionBindingId
        && (chosen.basis.compatibilityBasis === null || chosen.basis.compatibilityBasis.bindingRevision === compat.bindingRevision), "value_conflict");
    }
    const capture = advanced.state === "retained_inactive" ? advanced.captureRef : chosen?.origin.kind === "legacy_equivalence" ? chosen.origin.captureRef : null;
    const role = content.roleRef;
    return { value: { ref, content, compatibility: compat }, projection: project(table, { binding_id: ref.groupBindingId, revision: ref.bindingConfigRevision,
      content_json: r3(content), content_digest: ref.contentDigest, role_id: role?.roleTemplateId ?? null, role_revision: role?.revision ?? null,
      compat_execution_binding_id: compat?.executionBindingId ?? null, compat_binding_revision: compat?.bindingRevision ?? null,
      advanced_state: advanced.state, advanced_profile_agent_id: chosen?.basis.profileRef.agentId ?? null,
      advanced_profile_revision: chosen?.basis.profileRef.profileRevision ?? null, advanced_profile_digest: chosen?.basis.profileRef.contentDigest ?? null,
      advanced_capture_id: capture?.captureId ?? null, advanced_capture_source_digest: capture?.sourceDigest ?? null,
      advanced_capture_artifact_digest: capture?.artifactDigest ?? null, advanced_workspace_project_id: chosen?.basis.root.workspaceRef.projectId ?? null,
      advanced_workspace_revision: chosen?.basis.root.workspaceRef.workspaceRevision ?? null, advanced_execution_binding_id: chosen?.basis.existingScope.executionBindingId ?? null }) };
  }
  if (table === "legacy_config_captures") {
    const v = object(input, "ref physicalSourceRef snapshotReceiptRef capture"), r = object(v.ref, "captureId sourceDigest artifactDigest");
    const ref = { captureId: id(r.captureId), sourceDigest: digest(r.sourceDigest), artifactDigest: digest(r.artifactDigest) };
    const physicalSourceRef = evidenceRef(v.physicalSourceRef), snapshotReceiptRef = evidenceRef(v.snapshotReceiptRef), capture = parsed("legacy-capture", v.capture);
    const checkedDigest = m2ValueDigest({ kind: "legacy-capture", body: capture }); if (!checkedDigest.ok) fail(checkedDigest.error.code);
    requireValue(ref.captureId === capture.captureId && ref.sourceDigest === capture.legacySourceDigest && ref.artifactDigest === checkedDigest.value.digest
      && equal(physicalSourceRef, capture.physicalSourceRef) && equal(snapshotReceiptRef, capture.snapshotReceiptRef), "value_conflict");
    return { value: { ref, physicalSourceRef, snapshotReceiptRef, capture }, projection: project(table, { id: ref.captureId,
      physical_source_ref: r3(physicalSourceRef), source_digest: ref.sourceDigest, artifact_digest: ref.artifactDigest,
      capture_json: r3(capture), snapshot_receipt_ref: r3(snapshotReceiptRef) }) };
  }
  if (table === "config_snapshots") {
    // 这两个既有 raw 字符串是已知 JSON 路径；计入同一 row 调用的解析节点，原历史字节保持原样。
    if (input !== null && typeof input === "object" && !Array.isArray(input)) {
      const origin = (input as Obj).origin;
      if (origin !== null && typeof origin === "object" && !Array.isArray(origin) && (origin as Obj).kind === "legacy") {
        const raw = (origin as Obj).raw;
        if (raw !== null && typeof raw === "object" && !Array.isArray(raw))
          for (const name of ["rawJson", "rawAdvancedJson"]) if (typeof (raw as Obj)[name] === "string") budget.json((raw as Obj)[name] as string, parsedDepth + 4);
      }
    }
    const value = parsed("config-snapshot", input), { ref, ...body } = value;
    const origin = value.origin, legacy = origin.kind === "legacy" ? origin.raw.captureRef : null;
    const profile = origin.kind === "profile" ? origin.profileRef : null, binding = origin.kind === "profile" ? origin.bindingRef : null;
    return { value, projection: project(table, { id: ref.snapshotId, agent_id: value.agentId, group_binding_id: value.groupBindingId,
      execution_binding_id: value.executionBindingId, project_id: value.projectId, member_id: value.memberId, group_id: value.groupId,
      origin_kind: origin.kind, content_json: r3(body), content_digest: ref.contentDigest, semantic_digest: value.semanticDigest,
      capture_id: legacy?.captureId ?? null, capture_source_digest: legacy?.sourceDigest ?? null, capture_artifact_digest: legacy?.artifactDigest ?? null,
      profile_revision: profile?.profileRevision ?? null, profile_digest: profile?.contentDigest ?? null,
      binding_revision: binding?.bindingConfigRevision ?? null, binding_digest: binding?.contentDigest ?? null }) };
  }
  if (table === "config_detach_snapshots") {
    const value = parsed("detach-snapshot", input), requested = value.requested, applied = value.applied, root = value.root;
    return { value, projection: project(table, { id: value.ref.detachSnapshotId, execution_binding_id: value.attachment.executionBindingId,
      group_binding_id: value.attachment.groupBindingId, runtime_id: value.attachment.runtimeId, profile_agent_id: value.profileRef.agentId,
      profile_revision: value.profileRef.profileRevision, profile_digest: value.profileRef.contentDigest,
      binding_revision: value.bindingRef.bindingConfigRevision, binding_digest: value.bindingRef.contentDigest,
      resolution_json: r3(value.resolution), root_source_json: r3(root), current_advanced_view_json: r3(value.currentAdvanced),
      requested_source_json: requested === null ? null : r3(requested), applied_source_json: applied === null ? null : r3(applied),
      observed_at: value.observedAt, content_digest: value.ref.contentDigest,
      requested_snapshot_id: requested?.snapshotRef.snapshotId ?? null, requested_snapshot_digest: requested?.snapshotRef.contentDigest ?? null,
      requested_mapping_id: requested?.state === "mapped" ? requested.mappingRef.mappingId : null,
      requested_mapping_digest: requested?.state === "mapped" ? requested.mappingRef.contentDigest : null,
      applied_snapshot_id: applied?.snapshotRef.snapshotId ?? null, applied_snapshot_digest: applied?.snapshotRef.contentDigest ?? null,
      applied_mapping_id: applied?.state === "mapped" ? applied.mappingRef.mappingId : null,
      applied_mapping_digest: applied?.state === "mapped" ? applied.mappingRef.contentDigest : null,
      root_workspace_project_id: root.workspaceRef?.projectId ?? null, root_workspace_revision: root.workspaceRef?.workspaceRevision ?? null,
      root_mapping_id: root.state === "fixed_reference" ? root.mappingRef?.mappingId ?? null : null,
      root_mapping_digest: root.state === "fixed_reference" ? root.mappingRef?.contentDigest ?? null : null }) };
  }
  if (table === "config_workspace_mappings") {
    const value = parsed("workspace-mapping", input);
    return { value, projection: project(table, { id: value.ref.mappingId, snapshot_id: value.configSnapshotRef.snapshotId,
      snapshot_digest: value.configSnapshotRef.contentDigest, project_id: value.workspaceRef.projectId, workspace_revision: value.workspaceRef.workspaceRevision,
      original_workdir: value.originalWorkdir, canonical_root: value.canonicalRoot, root_identity_json: r3(value.rootIdentity),
      physical_resource_key: value.physicalResourceKey, observed_at: value.observedAt, content_digest: value.ref.contentDigest }) };
  }
  if (table === "config_authority") {
    const v = object(input, "singleton formatVersion owner activationId sourceBinding"); requireValue(v.singleton === 1);
    const formatVersion = revision(v.formatVersion); requireValue(formatVersion <= 2147483647);
    requireValue(typeof v.owner === "string"); requireValue(v.owner === "legacy" || v.owner === "profile", "unsupported_shape");
    const activationId = nullable(v.activationId, id), sourceBinding = parsed("source-binding", v.sourceBinding);
    if (M2_FORMAT_REGISTRATION.state === "unregistered") fail("format_unregistered");
    requireValue(formatVersion === M2_FORMAT_REGISTRATION.configFormat, "unsupported_shape");
    requireValue(v.owner === "legacy" ? activationId === null && sourceBinding.kind === "legacy"
      : activationId !== null && sourceBinding.kind !== "legacy" && (sourceBinding.kind !== "local" || activationId === sourceBinding.activation.activationId), "value_conflict");
    const value = { singleton: 1, formatVersion, owner: v.owner, activationId, sourceBinding };
    return { value, projection: project(table, { singleton: 1, format_version: formatVersion, owner: value.owner,
      activation_id: activationId, source_binding_ref: canonicalJson(sourceBinding) }) };
  }
  if (table === "config_activation_receipts") {
    const value = parsed("activation-receipt", input), { ref, ...body } = value;
    return { value, projection: project(table, { id: ref.activationId, request_id: value.requestId, plan_id: value.planRef.planId,
      plan_digest: value.planRef.digest, physical_source_ref: r3(value.physicalSourceRef), snapshot_receipt_ref: r3(value.snapshotReceiptRef),
      capture_id: value.captureRef.captureId, capture_source_digest: value.captureRef.sourceDigest, capture_artifact_digest: value.captureRef.artifactDigest,
      schema_before_digest: value.schemaBeforeDigest, schema_after_digest: value.schemaAfterDigest, guard_transition_json: r3(value.guardTransition),
      allowed_delta_ref: r3(value.allowedDeltaManifest), target_rows_digest: value.targetRowsDigest, source_to_target_manifest_ref: r3(value.sourceToTargetManifest),
      payload_json: r3(body), payload_digest: ref.digest }) };
  }
  if (table === "config_mutation_receipts") {
    const value = parsed("mutation-receipt", input), profile = value.result.kind === "profile" ? value.result.saved.ref : null,
      binding = value.result.kind === "binding" ? value.result.saved.ref : null;
    return { value, projection: project(table, { actor_scope: value.actorScope, operation: value.operation, target_scope: r3(value.targetScope),
      mutation_id: value.mutationId, command_digest: value.commandDigest, result_json: r3(value.result),
      result_profile_agent_id: profile?.agentId ?? null, result_profile_revision: profile?.profileRevision ?? null, result_profile_digest: profile?.contentDigest ?? null,
      result_binding_id: binding?.groupBindingId ?? null, result_binding_revision: binding?.bindingConfigRevision ?? null, result_binding_digest: binding?.contentDigest ?? null,
      audit_id: value.auditId }) };
  }
  if (table === "group_bindings") {
    const v = object(input, "id projectId groupId memberId agentId currentRevision originalLegacyBindingId currentAttachmentId currentCompatBindingRevision retiredAt");
    const value = { id: id(v.id), projectId: id(v.projectId), groupId: id(v.groupId), memberId: id(v.memberId), agentId: id(v.agentId),
      currentRevision: revision(v.currentRevision), originalLegacyBindingId: nullable(v.originalLegacyBindingId, id),
      currentAttachmentId: nullable(v.currentAttachmentId, id), currentCompatBindingRevision: nullable(v.currentCompatBindingRevision, revision), retiredAt: nullable(v.retiredAt, id) };
    pair(value.currentAttachmentId, value.currentCompatBindingRevision);
    requireValue(value.retiredAt === null || value.currentAttachmentId === null, "value_conflict");
    return { value, projection: project(table, { id: value.id, project_id: value.projectId, group_id: value.groupId, member_id: value.memberId,
      agent_id: value.agentId, current_revision: value.currentRevision, original_legacy_binding_id: value.originalLegacyBindingId,
      current_attachment_id: value.currentAttachmentId, current_attachment_state: value.currentAttachmentId === null ? null : "attached",
      current_compat_binding_revision: value.currentCompatBindingRevision, retired_at: value.retiredAt }) };
  }
  if (table === "execution-binding-references") {
    const v = object(input, "executionBindingId groupBindingId attachmentState detachSnapshotId detachedAt requestedSnapshotId requestedMappingId");
    requireValue(typeof v.attachmentState === "string"); requireValue(v.attachmentState === "attached" || v.attachmentState === "detached", "unsupported_shape");
    const value = { executionBindingId: id(v.executionBindingId), groupBindingId: id(v.groupBindingId), attachmentState: v.attachmentState,
      detachSnapshotId: nullable(v.detachSnapshotId, id), detachedAt: nullable(v.detachedAt, id), requestedSnapshotId: nullable(v.requestedSnapshotId, id), requestedMappingId: nullable(v.requestedMappingId, id) };
    pair(value.detachSnapshotId, value.detachedAt);
    requireValue((value.attachmentState === "attached") === (value.detachSnapshotId === null) && (value.requestedMappingId === null || value.requestedSnapshotId !== null), "value_conflict");
    return { value, projection: project(table, { group_binding_id: value.groupBindingId, attachment_state: value.attachmentState,
      detach_config_snapshot_id: value.detachSnapshotId, detached_at: value.detachedAt, requested_config_snapshot_id: value.requestedSnapshotId,
      requested_workspace_mapping_id: value.requestedMappingId }, { id: value.executionBindingId }) };
  }
  if (table === "runner-applied-references") {
    const v = object(input, "bindingId appliedSnapshotId appliedMappingId");
    const value = { bindingId: id(v.bindingId), appliedSnapshotId: nullable(v.appliedSnapshotId, id), appliedMappingId: nullable(v.appliedMappingId, id) };
    requireValue(value.appliedMappingId === null || value.appliedSnapshotId !== null, "value_conflict");
    return { value, projection: project(table, { applied_config_snapshot_id: value.appliedSnapshotId, applied_workspace_mapping_id: value.appliedMappingId }, { binding_id: value.bindingId }) };
  }
  fail("unsupported_shape");
}
function readCells(table: Table, input: unknown, budget: Budget): { projection: Projection; values: Obj } {
  const fragment = table === "execution-binding-references" || table === "runner-applied-references";
  const p = object(input, fragment ? "contract table identity cells" : "contract table cells");
  const info = tableInfo(table), cells = object(p.cells, info.columns.map(c => c.name).join(" "));
  const values: Obj = {};
  for (const column of info.columns) {
    const raw = cells[column.name]; requireValue(raw !== null && typeof raw === "object" && !Array.isArray(raw));
    const kind = (raw as Obj).kind; requireValue(typeof kind === "string"); requireValue(["null", "integer", "text"].includes(kind), "unsupported_shape");
    const c = object(raw, kind === "null" ? "kind" : kind === "integer" ? "kind decimal" : "kind value");
    if (kind === "null") { requireValue(column.nullable); values[column.name] = null; }
    else if (kind === "integer") {
      requireValue(["N", "I", "F", "INTEGER"].includes(column.domain) && typeof c.decimal === "string" && /^(0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(c.decimal));
      requireValue(c.decimal.length <= 16 && BigInt(c.decimal) >= 1n && BigInt(c.decimal) <= BigInt(["I", "F"].includes(column.domain) ? 2147483647 : Number.MAX_SAFE_INTEGER));
      const n = Number(c.decimal); requireValue(column.domain !== "INTEGER" || n === 1); values[column.name] = n;
    } else {
      requireValue(!["N", "I", "F", "INTEGER"].includes(column.domain) && typeof c.value === "string");
      cell(c.value, column); values[column.name] = column.domain === "J" || table === "config_mutation_receipts" && column.name === "target_scope" ? budget.json(c.value) : c.value;
    }
  }
  return { projection: p as unknown as Projection, values };
}
function withRef(body: unknown, ref: unknown): Obj {
  requireValue(body !== null && typeof body === "object" && !Array.isArray(body) && !Object.hasOwn(body, "ref")); return { ...body, ref };
}
function decodeValue(table: Table, values: Obj, _projection: Projection): unknown {
  if (table === "agent_profiles") return { agentId: values.agent_id, currentRevision: values.current_revision, legacyRuntimeId: values.legacy_runtime_id, compatRuntimeRevision: values.compat_runtime_revision };
  if (table === "agent_profile_versions") return { version: { ref: { agentId: values.agent_id, profileRevision: values.revision, contentDigest: values.content_digest }, content: values.content_json }, compatRuntimeRevision: values.compat_runtime_revision };
  if (table === "group_binding_config_versions") {
    pair(values.compat_execution_binding_id, values.compat_binding_revision);
    return { ref: { groupBindingId: values.binding_id, bindingConfigRevision: values.revision, contentDigest: values.content_digest },
      content: values.content_json, compatibility: values.compat_execution_binding_id === null ? null
        : { executionBindingId: values.compat_execution_binding_id, bindingRevision: values.compat_binding_revision } };
  }
  if (table === "legacy_config_captures") return { ref: { captureId: values.id, sourceDigest: values.source_digest, artifactDigest: values.artifact_digest },
    physicalSourceRef: values.physical_source_ref, snapshotReceiptRef: values.snapshot_receipt_ref, capture: values.capture_json };
  if (table === "config_snapshots") return withRef(values.content_json, { snapshotId: values.id, contentDigest: values.content_digest });
  if (table === "config_detach_snapshots") return { ref: { detachSnapshotId: values.id, contentDigest: values.content_digest },
    attachment: { executionBindingId: values.execution_binding_id, groupBindingId: values.group_binding_id, runtimeId: values.runtime_id },
    profileRef: { agentId: values.profile_agent_id, profileRevision: values.profile_revision, contentDigest: values.profile_digest },
    bindingRef: { groupBindingId: values.group_binding_id, bindingConfigRevision: values.binding_revision, contentDigest: values.binding_digest },
    resolution: values.resolution_json, root: values.root_source_json, currentAdvanced: values.current_advanced_view_json,
    requested: values.requested_source_json, applied: values.applied_source_json, observedAt: values.observed_at, readOnly: true, runReady: false };
  if (table === "config_workspace_mappings") return { ref: { mappingId: values.id, contentDigest: values.content_digest },
    configSnapshotRef: { snapshotId: values.snapshot_id, contentDigest: values.snapshot_digest }, workspaceRef: { projectId: values.project_id, workspaceRevision: values.workspace_revision },
    originalWorkdir: values.original_workdir, canonicalRoot: values.canonical_root, rootIdentity: values.root_identity_json,
    physicalResourceKey: values.physical_resource_key, observedAt: values.observed_at, observationOnly: true, requiresRevalidation: true, runReady: false };
  if (table === "config_authority") return { singleton: values.singleton, formatVersion: values.format_version, owner: values.owner,
    activationId: values.activation_id, sourceBinding: values.source_binding_ref };
  if (table === "config_activation_receipts") return withRef(values.payload_json, { activationId: values.id, digest: values.payload_digest });
  if (table === "config_mutation_receipts") return { actorScope: values.actor_scope, operation: values.operation, targetScope: values.target_scope,
    mutationId: values.mutation_id, commandDigest: values.command_digest, result: values.result_json, auditId: values.audit_id };
  if (table === "group_bindings") return { id: values.id, projectId: values.project_id, groupId: values.group_id, memberId: values.member_id,
    agentId: values.agent_id, currentRevision: values.current_revision, originalLegacyBindingId: values.original_legacy_binding_id,
    currentAttachmentId: values.current_attachment_id, currentCompatBindingRevision: values.current_compat_binding_revision, retiredAt: values.retired_at };
  if (table === "execution-binding-references") {
    const identity = object((_projection as M2ExecutionReferenceProjection).identity, "id");
    return { executionBindingId: id(identity.id), groupBindingId: values.group_binding_id, attachmentState: values.attachment_state,
      detachSnapshotId: values.detach_config_snapshot_id, detachedAt: values.detached_at, requestedSnapshotId: values.requested_config_snapshot_id, requestedMappingId: values.requested_workspace_mapping_id };
  }
  if (table === "runner-applied-references") {
    const identity = object((_projection as M2ExecutionReferenceProjection).identity, "binding_id");
    return { bindingId: id(identity.binding_id), appliedSnapshotId: values.applied_config_snapshot_id, appliedMappingId: values.applied_workspace_mapping_id };
  }
  fail("unsupported_shape");
}
function references(table: Table, projection: Projection): M2ForeignKey[] {
  const out: M2ForeignKey[] = [], cells: Record<string, M2Cell> = { ...projection.cells };
  if (projection.contract === "m2-execution-reference-projection/r1")
    for (const [name, value] of Object.entries(projection.identity)) cells[name] = { kind: "text", value };
  function add(local: string[], targetTable: string, targetColumns: string[], deferred = false) {
    const key = local.map(name => cells[name]!);
    const optional = local.filter(name => tableInfo(table).columns.some(c => c.name === name && c.nullable));
    // 每条边由首个 nullable 引用标识启用；例如尚未 mapping 的 snapshot 仍是合法来源。
    if (optional.length && cells[optional[0]!]!.kind === "null") return;
    requireValue(key.every(c => c.kind !== "null"), "value_conflict");
    out.push({ constraintId: `fk:${tableInfo(table).table}:${local.join(",")}->${targetTable}:${targetColumns.join(",")}`, targetTable, targetColumns, key, onDelete: deferred ? "NO ACTION" : "RESTRICT", deferrable: deferred });
  }
  if (table === "agent_profiles") {
    add(["agent_id"], "agents", ["id"]); add(["agent_id", "current_revision"], "agent_profile_versions", ["agent_id", "revision"], true);
    add(["legacy_runtime_id"], "agent_runtimes", ["id"]);
  }
  if (table === "agent_profile_versions") {
    add(["agent_id"], "agent_profiles", ["agent_id"]); add(["default_role_id", "default_role_revision"], "role_template_versions", ["role_template_id", "revision"]);
  }
  if (table === "group_binding_config_versions") {
    add(["binding_id"], "group_bindings", ["id"]); add(["role_id", "role_revision"], "role_template_versions", ["role_template_id", "revision"]);
    add(["compat_execution_binding_id", "binding_id"], "agent_runtime_bindings", ["id", "group_binding_id"]);
    add(["advanced_profile_agent_id", "advanced_profile_revision", "advanced_profile_digest"], "agent_profile_versions", ["agent_id", "revision", "content_digest"]);
    add(["advanced_capture_id", "advanced_capture_source_digest", "advanced_capture_artifact_digest"], "legacy_config_captures", ["id", "source_digest", "artifact_digest"]);
    add(["advanced_workspace_project_id", "advanced_workspace_revision"], "project_workspace_versions", ["project_id", "workspace_revision"]);
    add(["advanced_execution_binding_id", "binding_id"], "agent_runtime_bindings", ["id", "group_binding_id"]);
  }
  if (table === "config_snapshots") {
    add(["group_binding_id", "agent_id", "project_id", "group_id", "member_id"], "group_bindings", ["id", "agent_id", "project_id", "group_id", "member_id"]);
    add(["execution_binding_id", "group_binding_id"], "agent_runtime_bindings", ["id", "group_binding_id"]);
    add(["capture_id", "capture_source_digest", "capture_artifact_digest"], "legacy_config_captures", ["id", "source_digest", "artifact_digest"]);
    add(["agent_id", "profile_revision", "profile_digest"], "agent_profile_versions", ["agent_id", "revision", "content_digest"]);
    add(["group_binding_id", "binding_revision", "binding_digest"], "group_binding_config_versions", ["binding_id", "revision", "content_digest"]);
  }
  if (table === "config_detach_snapshots") {
    add(["execution_binding_id", "group_binding_id", "runtime_id"], "agent_runtime_bindings", ["id", "group_binding_id", "runtime_id"], true);
    add(["profile_agent_id", "profile_revision", "profile_digest"], "agent_profile_versions", ["agent_id", "revision", "content_digest"]);
    add(["group_binding_id", "binding_revision", "binding_digest"], "group_binding_config_versions", ["binding_id", "revision", "content_digest"]);
    for (const prefix of ["requested", "applied"]) {
      add([`${prefix}_snapshot_id`, `${prefix}_snapshot_digest`], "config_snapshots", ["id", "content_digest"]);
      add([`${prefix}_snapshot_id`, "execution_binding_id"], "config_snapshots", ["id", "execution_binding_id"]);
      add([`${prefix}_mapping_id`, `${prefix}_mapping_digest`], "config_workspace_mappings", ["id", "content_digest"]);
      add([`${prefix}_mapping_id`, `${prefix}_snapshot_id`], "config_workspace_mappings", ["id", "snapshot_id"]);
    }
    add(["root_workspace_project_id", "root_workspace_revision"], "project_workspace_versions", ["project_id", "workspace_revision"]);
    add(["root_mapping_id", "root_mapping_digest"], "config_workspace_mappings", ["id", "content_digest"]);
  }
  if (table === "config_workspace_mappings") {
    add(["snapshot_id", "snapshot_digest"], "config_snapshots", ["id", "content_digest"]);
    add(["snapshot_id", "project_id"], "config_snapshots", ["id", "project_id"]);
    add(["project_id", "workspace_revision"], "project_workspace_versions", ["project_id", "workspace_revision"]);
  }
  if (table === "config_authority") add(["activation_id"], "config_activation_receipts", ["id"]);
  if (table === "config_activation_receipts") add(["capture_id", "capture_source_digest", "capture_artifact_digest"], "legacy_config_captures", ["id", "source_digest", "artifact_digest"]);
  if (table === "config_mutation_receipts") {
    add(["result_profile_agent_id", "result_profile_revision", "result_profile_digest"], "agent_profile_versions", ["agent_id", "revision", "content_digest"]);
    add(["result_binding_id", "result_binding_revision", "result_binding_digest"], "group_binding_config_versions", ["binding_id", "revision", "content_digest"]);
    add(["audit_id"], "audit_log", ["id"]);
  }
  if (table === "group_bindings") {
    add(["agent_id"], "agent_profiles", ["agent_id"]); add(["project_id"], "projects", ["id"]);
    add(["group_id"], "groups", ["id"]); add(["member_id"], "members", ["id"]);
    add(["id", "current_revision"], "group_binding_config_versions", ["binding_id", "revision"], true);
    add(["original_legacy_binding_id"], "agent_runtime_bindings", ["id"], true);
    add(["current_attachment_id", "id", "current_attachment_state"], "agent_runtime_bindings", ["id", "group_binding_id", "attachment_state"], true);
  }
  if (table === "execution-binding-references") {
    add(["detach_config_snapshot_id", "id", "group_binding_id"], "config_detach_snapshots", ["id", "execution_binding_id", "group_binding_id"], true);
    add(["requested_config_snapshot_id", "id", "group_binding_id"], "config_snapshots", ["id", "execution_binding_id", "group_binding_id"], true);
    add(["requested_workspace_mapping_id", "requested_config_snapshot_id"], "config_workspace_mappings", ["id", "snapshot_id"], true);
  }
  if (table === "runner-applied-references") {
    add(["applied_config_snapshot_id", "binding_id"], "config_snapshots", ["id", "execution_binding_id"]);
    add(["applied_workspace_mapping_id", "applied_config_snapshot_id"], "config_workspace_mappings", ["id", "snapshot_id"]);
  }
  return out;
}
function artifacts(table: Table, value: unknown): M2ArtifactReference[] {
  const out: M2ArtifactReference[] = [], v = value as Obj;
  const add = (path: string[], kind: "evidence" | "artifact") => {
    let reference: unknown = value; for (const key of path) reference = (reference as Obj)[key];
    out.push({ path, kind, reference } as M2ArtifactReference);
  };
  if (table === "config_activation_receipts") {
    for (const name of ["physicalSourceRef", "snapshotReceiptRef", "allowedDeltaManifest", "sourceToTargetManifest"]) add([name], "evidence");
    add(["guardTransition", "registeredUpgrade"], "evidence");
  }
  if (table === "config_authority") {
    const source = v.sourceBinding as Obj;
    add(["sourceBinding", source.kind === "imported" ? "importArtifact" : "physicalSourceRef"], source.kind === "imported" ? "artifact" : "evidence");
  }
  if (table === "legacy_config_captures") {
    for (const name of ["physicalSourceRef", "snapshotReceiptRef"]) { add([name], "evidence"); add(["capture", name], "evidence"); }
    const capture = v.capture as M2ValueTypes["legacy-capture"];
    for (let i = 0; i < capture.tables.length; i++) add(["capture", "tables", String(i), "columnContract"], "artifact");
  }
  return out;
}
/** 编码纯逻辑 SQL 值；返回值没有源、连接、许可或可执行语句。 */
export function encodeM2RowValue(input: unknown): M2ValueResult<Projection> {
  return result(input, (data, budget) => { const envelope = object(data, "table value"); return build(knownTable(envelope.table), envelope.value, budget).projection; });
}
/** 解码只确认给定单行内部一致性；完整历史、FK 存在性与原生提交由真实 source 核验。 */
export function decodeM2RowValue(input: unknown): M2ValueResult<M2DecodedRow> {
  return result(input, (data, budget) => {
    requireValue(data !== null && typeof data === "object" && !Array.isArray(data));
    const top = data as Obj; requireValue(typeof top.contract === "string");
    requireValue(top.contract === "m2-row-projection/r1" || top.contract === "m2-execution-reference-projection/r1", "unsupported_shape");
    requireValue(typeof top.table === "string");
    const table = top.contract === "m2-execution-reference-projection/r1"
      ? top.table === "agent_runtime_bindings" ? "execution-binding-references" : top.table === "agent_runner_states" ? "runner-applied-references" : fail("unsupported_shape")
      : knownTable(top.table);
    requireValue(top.contract !== "m2-row-projection/r1" || !["execution-binding-references", "runner-applied-references"].includes(table), "unsupported_shape");
    const parsed = readCells(table, data, budget), built = build(table, decodeValue(table, parsed.values, parsed.projection), budget, 4);
    requireValue(equal(built.projection, parsed.projection), "value_conflict");
    const remainingSourceChecks: M2RemainingSourceCheck[] = ["physical_source", "full_catalog", "fk_existence", "scope_alignment", "current_authorization", "native_commit"];
    if (["group_bindings", "config_detach_snapshots", "execution-binding-references"].includes(table)) remainingSourceChecks.push("attachment_bijection");
    const artifactRefs = artifacts(table, built.value);
    if (artifactRefs.length || ["group_binding_config_versions", "config_snapshots"].includes(table)) remainingSourceChecks.push("artifact_bytes");
    return { table, value: built.value, projection: built.projection,
      projectionDigest: createHash("sha256").update(canonicalJson(built.projection)).digest("hex"),
      foreignKeys: references(table, built.projection), artifactRefs, remainingSourceChecks } as M2DecodedRow;
  });
}

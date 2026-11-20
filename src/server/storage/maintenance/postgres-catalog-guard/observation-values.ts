import { PG_CATALOG_GUARD_MODULE, PG_CATALOG_GUARD_SQL } from "./fixed-module.ts";
import { readModuleJson, type JsonValue } from "./strict-json.ts";

type Role = Readonly<{ name: string; oid: string }>;
type Purpose = "source-control" | "verification-only";
type Acl = Readonly<{ grantor: string; grantee: string; privilege: string; grantable: boolean }>;
type Binding = Readonly<{
  purpose: Purpose; systemIdentifier: string; database: Role; administrator: Role; caller: Role;
  namespaceOid: string; plpgsqlOid: string;
  helperOids: Readonly<{ acquire_share: string; acquire_sre: string }>;
}>;
type Helper = Readonly<{
  key: string; oid: string; namespaceOid: string; ownerOid: string; languageOid: string; body: string;
  attributes: (typeof PG_CATALOG_GUARD_MODULE.helpers)[number]["pgProc"]; acl: readonly Acl[];
  comment: null; securityLabels: readonly []; extensionMembership: readonly [];
}>;
type Observation = Readonly<{
  contract: "boardroom-pg16-catalog-guard-module-observation-value/v1"; serverVersionNum: "160015"; binding: Binding;
  namespace: Readonly<{
    name: "boardroom_catalog_guard_v1"; oid: string; ownerOid: string; acl: readonly Acl[];
    comment: null; securityLabels: readonly []; extensionMembership: readonly []; defaultPrivileges: readonly [];
    objects: readonly Readonly<{ class: "pg_proc"; oid: string }>[];
  }>;
  helpers: readonly Helper[];
}>;
type DetachedValue = Readonly<{
  classification: "catalog-guard-module-observation-value"; executionAdmission: "not-issued";
  nativeOwnership: "unproven"; directDependencyCatalog: "unproven"; observation: Observation;
}>;
type Result<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; code: "catalog_guard_module_value_invalid" }>;
const invalid = (): never => { throw new Error("catalog_guard_module_value_invalid"); };
const require = (condition: unknown): void => { if (!condition) invalid(); };
function object(value: JsonValue | undefined, keys: readonly string[]): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  require(actual.length === expected.length && actual.every((key, index) => key === expected[index]));
  return value;
}
function equal(actual: JsonValue | undefined, expected: unknown): boolean {
  if (actual === null || typeof actual !== "object" || expected === null || typeof expected !== "object")
    return Object.is(actual, expected);
  if (Array.isArray(actual) || Array.isArray(expected))
    return Array.isArray(actual) && Array.isArray(expected) && actual.length === expected.length
      && actual.every((item, index) => equal(item, expected[index]));
  const keys = Object.keys(actual), other = expected as Record<string, unknown>;
  return keys.length === Object.keys(other).length && keys.every(key => Object.hasOwn(other, key) && equal(actual[key], other[key]));
}
function decimal(value: JsonValue | undefined, maximum: bigint): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value) || BigInt(value) > maximum) return invalid();
  return value;
}
const oid = (value: JsonValue | undefined) => decimal(value, 4_294_967_295n);
function role(value: JsonValue | undefined): Role {
  const row = object(value, ["name", "oid"]), name = row.name;
  if (typeof name !== "string" || !name.length || name.includes("\0") || Buffer.byteLength(name, "utf8") > 63) return invalid();
  return { name, oid: oid(row.oid) };
}
function binding(value: JsonValue | undefined): Binding {
  const row = object(value, ["purpose", "systemIdentifier", "database", "administrator", "caller", "namespaceOid", "plpgsqlOid", "helperOids"]);
  if (row.purpose !== "source-control" && row.purpose !== "verification-only") return invalid();
  const administrator = role(row.administrator), caller = role(row.caller);
  require(administrator.name !== caller.name && administrator.oid !== caller.oid);
  const helpers = object(row.helperOids, ["acquire_share", "acquire_sre"]);
  const helperOids = { acquire_share: oid(helpers.acquire_share), acquire_sre: oid(helpers.acquire_sre) };
  require(helperOids.acquire_share !== helperOids.acquire_sre);
  return { purpose: row.purpose, systemIdentifier: decimal(row.systemIdentifier, 18_446_744_073_709_551_615n),
    database: role(row.database), administrator, caller, namespaceOid: oid(row.namespaceOid), plpgsqlOid: oid(row.plpgsqlOid), helperOids };
}
const aclKey = (row: Acl) => JSON.stringify([row.grantor, row.grantee, row.privilege, row.grantable]);
const orderAcl = (rows: readonly Acl[]): Acl[] => [...rows].sort((a, b) => aclKey(a) < aclKey(b) ? -1 : aclKey(a) > aclKey(b) ? 1 : 0);
function acl(value: JsonValue | undefined, expected: readonly Acl[]): Acl[] {
  if (!Array.isArray(value) || value.length !== expected.length) return invalid();
  const rows = value.map(item => {
    const row = object(item, ["grantor", "grantee", "privilege", "grantable"]);
    if (typeof row.privilege !== "string" || typeof row.grantable !== "boolean") return invalid();
    return { grantor: oid(row.grantor), grantee: row.grantee === "0" ? "0" : oid(row.grantee),
      privilege: row.privilege, grantable: row.grantable };
  });
  require(new Set(rows.map(aclKey)).size === rows.length);
  const normalized = orderAcl(rows);
  require(equal(normalized, orderAcl(expected)));
  return normalized;
}
function observe(value: JsonValue): Observation {
  const row = object(value, ["contract", "serverVersionNum", "binding", "namespace", "helpers"]);
  require(row.contract === "boardroom-pg16-catalog-guard-module-observation-value/v1" && row.serverVersionNum === "160015");
  const local = binding(row.binding), namespace = object(row.namespace,
    ["name", "oid", "ownerOid", "acl", "comment", "securityLabels", "extensionMembership", "defaultPrivileges", "objects"]);
  const grant = (grantee: string, privilege: string): Acl => ({ grantor: local.administrator.oid, grantee, privilege, grantable: false });
  require(namespace.name === PG_CATALOG_GUARD_MODULE.namespace && namespace.oid === local.namespaceOid
    && namespace.ownerOid === local.administrator.oid && namespace.comment === null
    && equal(namespace.securityLabels, []) && equal(namespace.extensionMembership, []) && equal(namespace.defaultPrivileges, []));
  const namespaceAcl = acl(namespace.acl, [grant(local.administrator.oid, "CREATE"), grant(local.administrator.oid, "USAGE"), grant(local.caller.oid, "USAGE")]);
  const objects = [{ class: "pg_proc" as const, oid: local.helperOids.acquire_share }, { class: "pg_proc" as const, oid: local.helperOids.acquire_sre }];
  if (!Array.isArray(namespace.objects) || namespace.objects.length !== 2) return invalid();
  const seen = new Set<string>();
  for (const item of namespace.objects) {
    const member = object(item, ["class", "oid"]), id = oid(member.oid);
    require(member.class === "pg_proc" && !seen.has(id) && objects.some(expected => expected.oid === id)); seen.add(id);
  }
  if (!Array.isArray(row.helpers) || row.helpers.length !== 2) return invalid();
  const helpers = row.helpers.map((item, index): Helper => {
    const helper = object(item, ["key", "oid", "namespaceOid", "ownerOid", "languageOid", "body", "attributes", "acl", "comment", "securityLabels", "extensionMembership"]);
    const name = index === 0 ? "acquire_share" : "acquire_sre", fixed = PG_CATALOG_GUARD_MODULE.helpers[index]!;
    require(helper.key === fixed.key && helper.oid === local.helperOids[name] && helper.namespaceOid === local.namespaceOid
      && helper.ownerOid === local.administrator.oid && helper.languageOid === local.plpgsqlOid
      && helper.body === PG_CATALOG_GUARD_SQL[name].body && equal(helper.attributes, fixed.pgProc)
      && helper.comment === null && equal(helper.securityLabels, []) && equal(helper.extensionMembership, []));
    const expectedAcl = [grant(local.administrator.oid, "EXECUTE")];
    if (local.purpose === "source-control" || index === 0) expectedAcl.push(grant(local.caller.oid, "EXECUTE"));
    return { key: fixed.key, oid: local.helperOids[name], namespaceOid: local.namespaceOid, ownerOid: local.administrator.oid,
      languageOid: local.plpgsqlOid, body: PG_CATALOG_GUARD_SQL[name].body, attributes: fixed.pgProc,
      acl: acl(helper.acl, expectedAcl), comment: null, securityLabels: [], extensionMembership: [] };
  });
  return { contract: "boardroom-pg16-catalog-guard-module-observation-value/v1", serverVersionNum: "160015", binding: local,
    namespace: { name: "boardroom_catalog_guard_v1", oid: local.namespaceOid, ownerOid: local.administrator.oid, acl: namespaceAcl,
      comment: null, securityLabels: [], extensionMembership: [], defaultPrivileges: [], objects }, helpers };
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function result<T>(read: () => T): Result<T> {
  try { return freeze({ ok: true as const, value: read() }); }
  catch { return Object.freeze({ ok: false, code: "catalog_guard_module_value_invalid" }); }
}

/** Untrusted primitive JSON text only. No getters, native connections, epoch owners or permits are consumed or issued. */
export function parsePgCatalogGuardModuleObservation(input: unknown): Result<DetachedValue> {
  return result(() => ({ classification: "catalog-guard-module-observation-value", executionAdmission: "not-issued",
    nativeOwnership: "unproven", directDependencyCatalog: "unproven", observation: observe(readModuleJson(input)) } as const));
}

/** The sole cross-cluster purpose mapping is module C → V. There is no application/archive input to rewrite. */
export function comparePgCatalogGuardModuleObservations(input: unknown) {
  return result(() => {
    const pair = object(readModuleJson(input), ["source", "target"]);
    const source = observe(pair.source!), target = observe(pair.target!);
    require(source.binding.purpose === "source-control" && target.binding.purpose === "verification-only"
      && source.binding.systemIdentifier !== target.binding.systemIdentifier
      && source.binding.administrator.name === target.binding.administrator.name);
    return { classification: "catalog-guard-module-comparison-value" as const, executionAdmission: "not-issued" as const,
      nativeOwnership: "unproven" as const, directDependencyCatalog: "unproven" as const,
      source, target, helperOids: source.helpers.map((helper, index) => ({ key: helper.key,
        sourceOid: helper.oid, targetOid: target.helpers[index]!.oid })) };
  });
}

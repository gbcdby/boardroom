import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PG_CATALOG_GUARD_MODULE, PG_CATALOG_GUARD_SQL, PG_CATALOG_GUARD_SOURCE_DIGESTS } from "../src/server/storage/maintenance/postgres-catalog-guard/fixed-module.ts";
import { comparePgCatalogGuardModuleObservations, parsePgCatalogGuardModuleObservation } from "../src/server/storage/maintenance/postgres-catalog-guard/observation-values.ts";
import { MODULE_VALUE_MAX_BYTES } from "../src/server/storage/maintenance/postgres-catalog-guard/strict-json.ts";
import { catalogGuardValueFixture } from "./fixtures/postgres-catalog-guard-values.ts";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

test("H04 fixed zero-argument helpers preserve the accepted SQL bytes, full catalog order and costs", () => {
  for (const [file, expected] of [["module-manifest.json", PG_CATALOG_GUARD_SOURCE_DIGESTS.module],
    ["direct-dependencies.json", PG_CATALOG_GUARD_SOURCE_DIGESTS.dependencies]] as const)
    assert.equal(sha256(readFileSync(new URL("../src/server/storage/maintenance/postgres-catalog-guard/" + file, import.meta.url), "utf8")), expected);
  assert.equal(PG_CATALOG_GUARD_MODULE.serverVersionNum, "160015");
  assert.equal(PG_CATALOG_GUARD_MODULE.catalogRelations.length, 64);
  assert.equal(PG_CATALOG_GUARD_MODULE.catalogRelations.filter(row => row.relisshared).length, 11);
  const expected = [
    ["acquire_share", "f5f0c3d4f0bb52ed9cde77ffed6df13746cac13e72cad43fd5072f9944de4bd1", "38bbc707d07eab9ae0bc96cfb51e08ae47e91cfd63f88dd5723dee955d5a1910"],
    ["acquire_sre", "076d8dfc5e267dc743261fd13e4db9f5941fe86472aab684403ee504c66d7b70", "0e04cc94d8ff5beb23cc6bb5184ae66b88a0a6e96232341593346439ebd104ae"],
  ] as const;
  for (const [name, createDigest, bodyDigest] of expected) {
    const source = PG_CATALOG_GUARD_SQL[name];
    assert.equal(sha256(source.create), createDigest);
    assert.equal(sha256(source.body), bodyDigest);
    assert.deepEqual([...source.body.matchAll(/ONLY "pg_catalog"\."(pg_[a-z_]+)"/g)].map(match => match[1]),
      PG_CATALOG_GUARD_MODULE.catalogRelations.map(row => row.relname));
    assert.equal(source.body.match(/LOCK TABLE/g)?.length, 1);
    assert.equal(source.body.includes("EXECUTE"), false);
    assert.equal(source.body.includes("EXCEPTION WHEN"), false);
  }
  assert.equal(PG_CATALOG_GUARD_MODULE.helpers[0]!.costUpperBound.sqlPrechargeIncludingWireAndPredicates, 5);
  assert.equal(PG_CATALOG_GUARD_MODULE.helpers[1]!.costUpperBound.sqlPrechargeIncludingWireAndPredicates, 5);
  assert.deepEqual(PG_CATALOG_GUARD_MODULE.productionRegistryEntries, []);
  assert.ok(Object.isFrozen(PG_CATALOG_GUARD_MODULE.helpers[0]!.pgProc));
});

function changed(input: unknown, path: readonly (string | number)[], value: unknown): unknown {
  const copy: unknown = JSON.parse(JSON.stringify(input));
  let parent = copy as Record<string | number, unknown>;
  for (const part of path.slice(0, -1)) parent = parent[part] as Record<string | number, unknown>;
  parent[path.at(-1)!] = value;
  return copy;
}

test("H04 module observation rejects changed identities, exact bodies, attributes, ACLs and namespace closure", async t => {
  const input = catalogGuardValueFixture();
  const cases: readonly (readonly [string, readonly (string | number)[], unknown])[] = [
    ["unknown contract", ["contract"], "boardroom-pg16-catalog-guard-module-observation-value/v2"],
    ["wrong server", ["serverVersionNum"], "160016"],
    ["missing member", ["binding", "caller"], undefined],
    ["unknown member", ["approved"], true],
    ["wrong purpose", ["binding", "purpose"], "business"],
    ["source privileges cannot claim verification purpose", ["binding", "purpose"], "verification-only"],
    ["noncanonical OID", ["binding", "namespaceOid"], "016402"],
    ["OID overflow", ["binding", "namespaceOid"], "4294967296"],
    ["OID zero", ["binding", "namespaceOid"], "0"],
    ["OID number", ["binding", "namespaceOid"], 16402],
    ["system identity overflow", ["binding", "systemIdentifier"], "18446744073709551616"],
    ["administrator/caller role alias", ["binding", "caller", "oid"], input.binding.administrator.oid],
    ["administrator/caller name alias", ["binding", "caller", "name"], input.binding.administrator.name],
    ["function OID alias", ["binding", "helperOids", "acquire_sre"], input.binding.helperOids.acquire_share],
    ["namespace name", ["namespace", "name"], "Boardroom_catalog_guard_v1"],
    ["namespace link", ["namespace", "oid"], "99999"],
    ["namespace owner", ["namespace", "ownerOid"], input.binding.caller.oid],
    ["namespace comment", ["namespace", "comment"], "unreviewed"],
    ["namespace label", ["namespace", "securityLabels"], [{ provider: "unknown", label: "x" }]],
    ["namespace extension", ["namespace", "extensionMembership"], ["99999"]],
    ["default privilege", ["namespace", "defaultPrivileges"], [{ grant: "PUBLIC" }]],
    ["third object", ["namespace", "objects"], [...input.namespace.objects, { class: "pg_class", oid: "17000" }]],
    ["duplicate object", ["namespace", "objects", 1], input.namespace.objects[0]],
    ["object class", ["namespace", "objects", 0, "class"], "pg_type"],
    ["function name", ["helpers", 0, "key"], "other.acquire_share()"],
    ["different local function", ["helpers", 0, "oid"], "17000"],
    ["function namespace", ["helpers", 0, "namespaceOid"], "11"],
    ["function owner", ["helpers", 0, "ownerOid"], input.binding.caller.oid],
    ["function language", ["helpers", 0, "languageOid"], "13"],
    ["raw body whitespace", ["helpers", 0, "body"], input.helpers[0]!.body + " "],
    ["invoker change", ["helpers", 0, "attributes", "prosecdef"], false],
    ["integer instead of boolean", ["helpers", 0, "attributes", "prosecdef"], 1],
    ["readonly volatility", ["helpers", 0, "attributes", "provolatile"], "s"],
    ["parallel safe", ["helpers", 0, "attributes", "proparallel"], "s"],
    ["additional argument", ["helpers", 0, "attributes", "pronargs"], 1],
    ["other return type", ["helpers", 0, "attributes", "prorettype"], "16"],
    ["additional configuration", ["helpers", 0, "attributes", "proconfig"], ["search_path=pg_catalog, pg_temp", "role=postgres"]],
    ["extra attribute", ["helpers", 0, "attributes", "verified"], true],
    ["function comment", ["helpers", 0, "comment"], "changed"],
    ["missing function", ["helpers"], [input.helpers[0]]],
    ["extra function", ["helpers"], [...input.helpers, input.helpers[0]]],
    ["PUBLIC execution", ["helpers", 0, "acl", 1, "grantee"], "0"],
    ["grant option", ["helpers", 0, "acl", 1, "grantable"], true],
    ["wrong grantor", ["helpers", 0, "acl", 1, "grantor"], input.binding.caller.oid],
    ["duplicate ACL", ["helpers", 0, "acl", 1], input.helpers[0]!.acl[0]],
    ["missing ACL", ["helpers", 0, "acl"], [input.helpers[0]!.acl[0]]],
    ["extra ACL", ["namespace", "acl"], [...input.namespace.acl, { grantor: "10", grantee: "0", privilege: "USAGE", grantable: false }]],
  ];
  for (const [name, path, value] of cases) await t.test(name, () => {
    assert.deepEqual(parsePgCatalogGuardModuleObservation(JSON.stringify(changed(input, path, value))),
      { ok: false, code: "catalog_guard_module_value_invalid" });
  });
});

test("H04 canonical tuple sorting permits ACL/object order only, retaining exact UTF-8 names", () => {
  const input = catalogGuardValueFixture();
  input.binding.administrator.name = '管理员"' + "a".repeat(53); // 63 UTF-8 bytes exactly.
  const text = JSON.stringify(input), expected = parsePgCatalogGuardModuleObservation(text);
  assert.equal(Buffer.byteLength(input.binding.administrator.name), 63);
  assert.equal(expected.ok, true);
  input.namespace.acl.reverse(); input.namespace.objects.reverse();
  for (const helper of input.helpers) helper.acl.reverse();
  assert.deepEqual(parsePgCatalogGuardModuleObservation(JSON.stringify(input)), expected);
  for (const badName of ["", "a\0b", "汉".repeat(22), "a".repeat(64), "\ud800"]) {
    input.binding.administrator.name = badName;
    assert.equal(parsePgCatalogGuardModuleObservation(JSON.stringify(input)).ok, false);
  }
});

test("H04 strict text boundary rejects duplicate/escaped keys, malformed JSON and active objects", () => {
  const text = JSON.stringify(catalogGuardValueFixture());
  let invoked = 0;
  const active = { get contract() { invoked++; throw new Error("must not read"); }, toJSON() { invoked++; return text; }, toString() { invoked++; return text; } };
  const bad: unknown[] = [active, new String(text), Buffer.from(text), () => text, null,
    text.replace('"contract":', '"contract":0,"contr\\u0061ct":'),
    text.replace('"oid":"10"', '"oid":"10","oid":"10"'),
    text.replace('"pronargs":0', '"pronargs":-0'), text.replace('"pronargs":0', '"pronargs":0e0'),
    text.replace('"pronargs":0', '"pronargs":0.0'), text + "{}", text.slice(0, -1) + ",}",
    "[".repeat(65) + "0" + "]".repeat(65), '"\\uD800"', '"\\uDC00"',
    '{"__proto__":{"approved":true}}', " ".repeat(MODULE_VALUE_MAX_BYTES + 1) + text];
  for (const input of bad) assert.deepEqual(parsePgCatalogGuardModuleObservation(input), { ok: false, code: "catalog_guard_module_value_invalid" });
  assert.equal(invoked, 0);
  assert.equal(Object.hasOwn(Object.prototype, "approved"), false);
});

test("H04 cross-cluster comparison maps only module caller purpose and local object identities", () => {
  const source = catalogGuardValueFixture(), target = catalogGuardValueFixture(true);
  const historical = { sourceIdentity: { databaseOid: source.binding.database.oid }, row: 'historical C oid=16401', owner: source.binding.caller.name };
  const before = JSON.stringify(historical);
  const compare = () => comparePgCatalogGuardModuleObservations(JSON.stringify({ source, target }));
  let result = compare();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.executionAdmission, "not-issued");
  assert.deepEqual(result.value.helperOids, source.helpers.map((helper, index) => ({ key: helper.key,
    sourceOid: helper.oid, targetOid: target.helpers[index]!.oid })));
  assert.ok(Object.isFrozen(result.value.target.binding));
  target.binding.namespaceOid = source.binding.namespaceOid;
  target.namespace.oid = source.binding.namespaceOid;
  target.binding.helperOids = { ...source.binding.helperOids };
  target.namespace.objects = structuredClone(source.namespace.objects);
  target.binding.plpgsqlOid = source.binding.plpgsqlOid;
  target.helpers.forEach((helper, index) => {
    helper.oid = source.helpers[index]!.oid;
    helper.namespaceOid = source.binding.namespaceOid;
    helper.languageOid = source.binding.plpgsqlOid;
  });
  result = compare(); assert.equal(result.ok, true, "equal numeric OIDs in different clusters are valid local links");
  assert.equal(JSON.stringify(historical), before);
  target.binding.systemIdentifier = source.binding.systemIdentifier;
  assert.equal(compare().ok, false, "another database of the same cluster is insufficient");
});

test("H04 comparison rejects owner renaming, source/target reversal and target V SRE privilege", () => {
  const source = catalogGuardValueFixture(), target = catalogGuardValueFixture(true);
  assert.equal(parsePgCatalogGuardModuleObservation(JSON.stringify(target)).ok, true);
  for (const pair of [
    { source: target, target: source },
    { source, target: changed(target, ["binding", "administrator", "name"], "other_administrator") },
    { source, target: changed(target, ["helpers", 1, "acl"], [target.helpers[1]!.acl[0],
      { grantor: target.binding.administrator.oid, grantee: target.binding.caller.oid, privilege: "EXECUTE", grantable: false }]) },
    { source, target, application: { owner: "never remap" } },
  ]) assert.equal(comparePgCatalogGuardModuleObservations(JSON.stringify(pair)).ok, false);
});

test("H04 exact module observations validate as detached values without producing native admission", () => {
  const input = catalogGuardValueFixture();
  const parsed = parsePgCatalogGuardModuleObservation(JSON.stringify(input));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.classification, "catalog-guard-module-observation-value");
  assert.equal(parsed.value.executionAdmission, "not-issued");
  assert.equal(parsed.value.nativeOwnership, "unproven");
  assert.equal(parsed.value.directDependencyCatalog, "unproven");
  assert.deepEqual(parsed.value.observation, input);
  assert.ok(Object.isFrozen(parsed.value.observation.helpers[0]!.attributes));
  input.helpers[0]!.body += " ";
  assert.notEqual(parsed.value.observation.helpers[0]!.body, input.helpers[0]!.body);
  assert.equal(parsePgCatalogGuardModuleObservation(JSON.stringify(input)).ok, false);
});

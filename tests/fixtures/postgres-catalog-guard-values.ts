import { PG_CATALOG_GUARD_MODULE, PG_CATALOG_GUARD_SQL } from "../../src/server/storage/maintenance/postgres-catalog-guard/fixed-module.ts";

/** Deliberately synthetic values. A fixture is never a native connection or deployment proof. */
export function catalogGuardValueFixture(target = false) {
  const administrator = { name: "br_fixture_admin", oid: "10" };
  const caller = { name: target ? "br_fixture_verify" : "br_fixture_control", oid: target ? "26401" : "16401" };
  const binding = {
    purpose: target ? "verification-only" : "source-control",
    systemIdentifier: target ? "772200000000000002" : "771100000000000001",
    database: { name: "fixture", oid: target ? "26384" : "16384" },
    administrator, caller,
    namespaceOid: target ? "26402" : "16402", plpgsqlOid: target ? "23563" : "13563",
    helperOids: { acquire_share: target ? "26403" : "16403", acquire_sre: target ? "26404" : "16404" },
  };
  const a = (grantee: string, privilege: string) => ({ grantor: administrator.oid, grantee, privilege, grantable: false });
  return {
    contract: "boardroom-pg16-catalog-guard-module-observation-value/v1",
    serverVersionNum: "160015", binding,
    namespace: { name: "boardroom_catalog_guard_v1", oid: binding.namespaceOid, ownerOid: administrator.oid,
      acl: [a(administrator.oid, "CREATE"), a(administrator.oid, "USAGE"), a(caller.oid, "USAGE")],
      comment: null, securityLabels: [], extensionMembership: [], defaultPrivileges: [],
      objects: [{ class: "pg_proc", oid: binding.helperOids.acquire_share }, { class: "pg_proc", oid: binding.helperOids.acquire_sre }] },
    helpers: PG_CATALOG_GUARD_MODULE.helpers.map((helper, index) => {
      const name = index === 0 ? "acquire_share" : "acquire_sre";
      return { key: helper.key, oid: binding.helperOids[name], namespaceOid: binding.namespaceOid,
        ownerOid: administrator.oid, languageOid: binding.plpgsqlOid, body: PG_CATALOG_GUARD_SQL[name].body,
        attributes: structuredClone(helper.pgProc), acl: [a(administrator.oid, "EXECUTE"),
          ...(!target || index === 0 ? [a(caller.oid, "EXECUTE")] : [])],
        comment: null, securityLabels: [], extensionMembership: [] };
    }),
  };
}

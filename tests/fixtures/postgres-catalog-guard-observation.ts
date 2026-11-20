import type { Client } from "pg";
import { h04Roles } from "./postgres-catalog-guard-cluster.ts";

/** Test-only catalog collector. The fixture's known native client supplies facts; this is not a production owner/provider.
 * In particular, it does not qualify the transitive dependency graph, role membership or a server epoch. */
export async function readFixtureCatalogGuardModule(client: Client, purpose: "source-control" | "verification-only") {
  const caller = purpose === "source-control" ? h04Roles.control : h04Roles.verification;
  const local = (await client.query(`SELECT
    current_setting('server_version_num') AS version,
    (pg_control_system()).system_identifier::text AS system_identifier,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,
    current_database() AS database_name,
    (SELECT oid::text FROM pg_roles WHERE rolname=$1) AS administrator_oid,
    (SELECT oid::text FROM pg_roles WHERE rolname=$2) AS caller_oid,
    n.oid::text AS namespace_oid,(SELECT oid::text FROM pg_language WHERE lanname='plpgsql') AS language_oid,
    (SELECT p.oid::text FROM pg_proc p WHERE p.pronamespace=n.oid AND p.proname='acquire_share' AND p.pronargs=0) AS share_oid,
    (SELECT p.oid::text FROM pg_proc p WHERE p.pronamespace=n.oid AND p.proname='acquire_sre' AND p.pronargs=0) AS sre_oid
    FROM pg_namespace n WHERE n.nspname='boardroom_catalog_guard_v1'`, [h04Roles.administrator, caller])).rows[0];
  const namespace = (await client.query(`SELECT json_build_object(
    'name',n.nspname,'oid',n.oid::text,'ownerOid',n.nspowner::text,
    'acl',(SELECT json_agg(json_build_object('grantor',a.grantor::text,'grantee',a.grantee::text,
      'privilege',a.privilege_type,'grantable',a.is_grantable)) FROM aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a),
    'comment',obj_description(n.oid,'pg_namespace'),
    'securityLabels',coalesce((SELECT json_agg(s.provider||':'||s.label) FROM pg_seclabel s
      WHERE s.classoid='pg_namespace'::regclass AND s.objoid=n.oid),'[]'::json),
    'extensionMembership',coalesce((SELECT json_agg(d.refobjid::text) FROM pg_depend d
      WHERE d.classid='pg_namespace'::regclass AND d.objid=n.oid AND d.refclassid='pg_extension'::regclass AND d.deptype='e'),'[]'::json),
    'defaultPrivileges',coalesce((SELECT json_agg(a.oid::text) FROM pg_default_acl a WHERE a.defaclnamespace=n.oid),'[]'::json),
    'objects',coalesce((SELECT json_agg(json_build_object('class',d.classid::regclass::text,'oid',d.objid::text))
      FROM pg_depend d WHERE d.refclassid='pg_namespace'::regclass AND d.refobjid=n.oid),'[]'::json)
    ) AS value FROM pg_namespace n WHERE n.oid=$1::oid`, [local.namespace_oid])).rows[0].value;
  const helpers = (await client.query(`SELECT json_build_object(
    'key',n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',
    'oid',p.oid::text,'namespaceOid',p.pronamespace::text,'ownerOid',p.proowner::text,'languageOid',p.prolang::text,
    'body',p.prosrc,'attributes',json_build_object(
      'prokind',p.prokind,'prosecdef',p.prosecdef,'proleakproof',p.proleakproof,'proisstrict',p.proisstrict,
      'proretset',p.proretset,'provolatile',p.provolatile,'proparallel',p.proparallel,
      'pronargs',p.pronargs,'pronargdefaults',p.pronargdefaults,'provariadic',p.provariadic::text,
      'prosupport',p.prosupport::oid::text,'prorettype',p.prorettype::text,
      'proargtypes',ARRAY(SELECT x::text FROM unnest(p.proargtypes) x),
      'proallargtypes',CASE WHEN p.proallargtypes IS NULL THEN NULL ELSE ARRAY(SELECT x::text FROM unnest(p.proallargtypes) x) END,
      'proargmodes',p.proargmodes,'proargnames',p.proargnames,'proargdefaults',p.proargdefaults::text,
      'protrftypes',CASE WHEN p.protrftypes IS NULL THEN NULL ELSE ARRAY(SELECT x::text FROM unnest(p.protrftypes) x) END,
      'probin',p.probin,'prosqlbody',p.prosqlbody::text,'procost',p.procost::text,'prorows',p.prorows::text,'proconfig',p.proconfig),
    'acl',(SELECT json_agg(json_build_object('grantor',a.grantor::text,'grantee',a.grantee::text,
      'privilege',a.privilege_type,'grantable',a.is_grantable)) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a),
    'comment',obj_description(p.oid,'pg_proc'),
    'securityLabels',coalesce((SELECT json_agg(s.provider||':'||s.label) FROM pg_seclabel s
      WHERE s.classoid='pg_proc'::regclass AND s.objoid=p.oid),'[]'::json),
    'extensionMembership',coalesce((SELECT json_agg(d.refobjid::text) FROM pg_depend d
      WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.refclassid='pg_extension'::regclass AND d.deptype='e'),'[]'::json)
    ) AS value FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='boardroom_catalog_guard_v1' ORDER BY p.proname COLLATE "C"`)).rows.map(row => row.value);
  return { contract: "boardroom-pg16-catalog-guard-module-observation-value/v1", serverVersionNum: local.version,
    binding: { purpose, systemIdentifier: local.system_identifier, database: { name: local.database_name, oid: local.database_oid },
      administrator: { name: h04Roles.administrator, oid: local.administrator_oid }, caller: { name: caller, oid: local.caller_oid },
      namespaceOid: local.namespace_oid, plpgsqlOid: local.language_oid,
      helperOids: { acquire_share: local.share_oid, acquire_sre: local.sre_oid } }, namespace, helpers };
}

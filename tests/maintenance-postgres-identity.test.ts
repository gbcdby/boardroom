import test from "node:test";
import assert from "node:assert/strict";
import { digestJson } from "../src/server/storage/maintenance/canonical.ts";
import { assertPostgresServerCapability, stablePostgresSourceIdentity,
  type PostgresDatabaseIdentity } from "../src/server/storage/maintenance/postgres-identity.ts";

const observed: PostgresDatabaseIdentity = {
  systemIdentifier: "7428489723928500001", databaseOid: "16384", databaseName: "boardroom",
  schemaOid: "16385", schemaName: "app", serverAddress: "127.0.0.1", serverPort: 5432,
  postmasterStartedAt: "2026-11-12 01:00:00+00", serverVersion: "160004", fsync: "on", inRecovery: false,
};
const descriptorDigest = "d".repeat(64), marker = "a".repeat(32);

test("#152 PG durable source identity survives server restart and fresh capability observations", () => {
  const before = stablePostgresSourceIdentity(observed, descriptorDigest, marker);
  const after = stablePostgresSourceIdentity({ ...observed, postmasterStartedAt: "2026-11-12 02:00:00+00",
    serverVersion: "160005", fsync: "off", inRecovery: true }, descriptorDigest, marker);
  assert.equal(digestJson(after), digestJson(before));
  for (const name of ["postmasterStartedAt", "serverVersion", "fsync", "inRecovery"])
    assert.equal(Object.hasOwn(before, name), false);
  assert.deepEqual(before, { formatVersion: 1, kind: "postgres", systemIdentifier: observed.systemIdentifier,
    databaseOid: "16384", databaseName: "boardroom", schemaOid: "16385", schemaName: "app",
    serverAddress: "127.0.0.1", serverPort: 5432, descriptorDigest, databaseInstanceId: marker });
});

test("#152 PG stable identity keeps cluster, database, schema, endpoint, descriptor and marker bindings", () => {
  const expected = digestJson(stablePostgresSourceIdentity(observed, descriptorDigest, marker));
  for (const changed of [
    { systemIdentifier: "7428489723928500002" }, { databaseOid: "16386" }, { databaseName: "other" },
    { schemaOid: "16387" }, { schemaName: "other" }, { serverAddress: "127.0.0.2" }, { serverPort: 5433 },
  ]) assert.notEqual(digestJson(stablePostgresSourceIdentity({ ...observed, ...changed }, descriptorDigest, marker)), expected);
  assert.notEqual(digestJson(stablePostgresSourceIdentity(observed, "e".repeat(64), marker)), expected);
  assert.notEqual(digestJson(stablePostgresSourceIdentity(observed, descriptorDigest, "b".repeat(32))), expected);
});

test("#152 PG stable identity never substitutes for fresh execution capabilities", () => {
  assert.doesNotThrow(() => assertPostgresServerCapability(observed, "execute"));
  for (const changed of [{ fsync: "off" }, { inRecovery: true }]) {
    assert.doesNotThrow(() => assertPostgresServerCapability({ ...observed, ...changed }, "observe"));
    assert.throws(() => assertPostgresServerCapability({ ...observed, ...changed }, "execute"), /unsupported_durability/);
  }
  for (const serverVersion of ["150010", "170001", "not-a-version"])
    assert.throws(() => assertPostgresServerCapability({ ...observed, serverVersion }, "observe"), /backup_capability_unavailable/);
});

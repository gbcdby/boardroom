import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, writeSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const fixtureImageDigest = "sha256:f377d590e5474681d4d7838635031a2b50647923b7abfa803ce9b5ff35d5c663";
export const fixtureImageReference = `postgres@${fixtureImageDigest}`;
const dockerTimeoutMs = 10_000;
const maximumReceiptBytes = 16_384;

// This SELECT runs inside the one job.services.postgres.id container. It never
// takes a caller-supplied database URL or changes a PostgreSQL setting.
export const fixtureReadbackSql = `SELECT json_build_object(
  'serverVersionNum', current_setting('server_version_num')::int,
  'serverVersion', current_setting('server_version'),
  'serverBuild', version(),
  'database', current_database(),
  'user', current_user,
  'systemIdentifier', (pg_control_system()).system_identifier::text,
  'postmasterStartedAt', pg_postmaster_start_time()::text,
  'dataDirectory', current_setting('data_directory'),
  'configFile', current_setting('config_file'),
  'autovacuum', current_setting('autovacuum'),
  'autovacuumSource', (SELECT source FROM pg_settings WHERE name='autovacuum'),
  'autovacuumSourceFile', (SELECT sourcefile FROM pg_settings WHERE name='autovacuum'),
  'autovacuumSourceLine', (SELECT sourceline FROM pg_settings WHERE name='autovacuum'),
  'autovacuumPendingRestart', (SELECT pending_restart FROM pg_settings WHERE name='autovacuum'),
  'autovacuumWorkers', (SELECT count(*)::int FROM pg_stat_activity WHERE backend_type='autovacuum worker'),
  'fsync', current_setting('fsync'),
  'inRecovery', pg_is_in_recovery(),
  'readOnly', current_setting('transaction_read_only')
) AS fixture_readback`;

function requireEvidence(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}
function object(value) {
  requireEvidence(value && typeof value === "object" && !Array.isArray(value), "fixture_metadata_invalid");
  return value;
}
function text(value, maximum = 512) {
  requireEvidence(typeof value === "string" && value.length > 0 && value.length <= maximum && !value.includes("\n"), "fixture_metadata_invalid");
  return value;
}
function integer(value) {
  requireEvidence(Number.isSafeInteger(value) && value >= 0, "fixture_metadata_invalid");
  return value;
}
function boolean(value) {
  requireEvidence(typeof value === "boolean", "fixture_metadata_invalid");
  return value;
}

/** Whitelist before persistence; no environment, credentials or SQL contents. */
export function projectReadback(input) {
  const value = object(input), result = {};
  for (const key of ["serverVersion", "serverBuild", "database", "user", "systemIdentifier", "postmasterStartedAt",
    "dataDirectory", "configFile", "autovacuum", "autovacuumSource", "fsync", "readOnly"])
    result[key] = text(value[key]);
  for (const key of ["serverVersionNum", "autovacuumWorkers"]) result[key] = integer(value[key]);
  // A default or inaccessible setting can legitimately have no source file.
  // Preserve that failure evidence instead of mistaking NULL for a parser error.
  result.autovacuumSourceFile = value.autovacuumSourceFile === null ? null : text(value.autovacuumSourceFile);
  result.autovacuumSourceLine = value.autovacuumSourceLine === null ? null : integer(value.autovacuumSourceLine);
  for (const key of ["autovacuumPendingRestart", "inRecovery"]) result[key] = boolean(value[key]);
  return result;
}
export function assertQuietFixtureConfiguration(value) {
  requireEvidence(value.database === "boardroom_ci" && value.user === "boardroom", "fixture_database_identity_mismatch");
  requireEvidence(/^\d+$/.test(value.systemIdentifier), "fixture_cluster_identity_invalid");
  requireEvidence(value.autovacuum === "off", "fixture_autovacuum_not_disabled");
  requireEvidence(value.dataDirectory.startsWith("/") && value.configFile === posix.join(value.dataDirectory, "postgresql.conf")
    && value.autovacuumSourceFile === value.configFile && value.autovacuumSource === "configuration file"
    && value.autovacuumSourceLine > 0 && value.autovacuumPendingRestart === false, "fixture_configuration_source_mismatch");
  requireEvidence(value.readOnly === "on" && value.fsync === "on" && value.inRecovery === false, "fixture_readback_state_mismatch");
  // Off does not suppress anti-wraparound workers. A current worker is still a
  // failure, and the original production inventory remains authoritative later.
  requireEvidence(value.autovacuumWorkers === 0, "fixture_background_worker_present");
}
export function assertFixtureVersion(value) {
  requireEvidence(value.serverVersionNum === 160016 && /^16\.16(?:\s|$)/.test(value.serverVersion), "fixture_server_version_mismatch");
}

function docker(args) {
  return execFileSync("docker", args, { encoding: "utf8", timeout: dockerTimeoutMs,
    maxBuffer: 65_536, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
const containerFormat = '{"id":{{json .Id}},"imageId":{{json .Image}},"requestedImage":{{json .Config.Image}},"running":{{json .State.Running}}}';
const imageFormat = '{"id":{{json .Id}},"repoDigests":{{json .RepoDigests}}}';
const officialReferences = new Set([fixtureImageReference, `library/${fixtureImageReference}`, `docker.io/library/${fixtureImageReference}`]);

export function runFixtureReadback() {
  const receipt = { version: 1, role: "read-only-owned-ci-service-preflight", status: "FAIL", stage: "service-input",
    expectedImage: fixtureImageReference, expectedServerVersionNum: 160016,
    readbackQuerySha256: createHash("sha256").update(fixtureReadbackSql).digest("hex"),
    limits: { dockerCalls: 4, dockerTimeoutMs, statementTimeoutMs: 5000, receiptBytes: maximumReceiptBytes },
    boundary: "regular autovacuum disabled for this new CI cluster; anti-wraparound workers still fail closed",
    productionClients: "separate host/private tool versions remain in the existing preparation logs" };
  try {
    const id = process.env.BOARDROOM_CI_POSTGRES_CONTAINER_ID;
    requireEvidence(process.env.GITHUB_ACTIONS === "true" && typeof id === "string" && /^[a-f0-9]{64}$/.test(id), "fixture_service_identity_missing");
    receipt.stage = "container-identity";
    const rawContainer = object(JSON.parse(docker(["inspect", "--type", "container", "--format", containerFormat, id])));
    receipt.container = { id: text(rawContainer.id, 64), imageId: text(rawContainer.imageId, 80),
      requestedImage: text(rawContainer.requestedImage, 160), running: boolean(rawContainer.running) };
    requireEvidence(receipt.container.id === id && /^sha256:[a-f0-9]{64}$/.test(receipt.container.imageId)
      && officialReferences.has(receipt.container.requestedImage) && receipt.container.running, "fixture_container_identity_mismatch");
    receipt.stage = "image-identity";
    const rawImage = object(JSON.parse(docker(["image", "inspect", "--format", imageFormat, receipt.container.imageId])));
    requireEvidence(Array.isArray(rawImage.repoDigests) && rawImage.repoDigests.length <= 16, "fixture_image_metadata_invalid");
    receipt.image = { id: text(rawImage.id, 80), repoDigests: rawImage.repoDigests.map(value => text(value, 160)) };
    requireEvidence(receipt.image.id === receipt.container.imageId && receipt.image.repoDigests.some(value => officialReferences.has(value)), "fixture_image_digest_mismatch");
    receipt.stage = "inspector-client-version";
    receipt.inspectorPsqlVersion = text(docker(["exec", "--user", "postgres", id, "psql", "--version"]), 256);
    receipt.stage = "configuration-readback";
    const rawReadback = docker(["exec", "--user", "postgres", "--env", "PGCONNECT_TIMEOUT=5", "--env", "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=5000", id,
      "psql", "--no-psqlrc", "--no-password", "--username", "boardroom", "--dbname", "boardroom_ci",
      "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1", "--command", fixtureReadbackSql]);
    receipt.readback = projectReadback(JSON.parse(rawReadback));
    assertQuietFixtureConfiguration(receipt.readback);
    assertFixtureVersion(receipt.readback);
    receipt.status = "PASS"; receipt.stage = "complete";
  } catch (error) {
    receipt.error = { name: typeof error?.name === "string" ? error.name.slice(0, 64) : "Error",
      code: typeof error?.code === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(error.code) ? error.code : "fixture_readback_failed" };
  }
  const directory = resolve(".agent-output/maintenance-native-diagnostics/pg-fixture");
  const path = join(directory, "receipt.json");
  try {
    const json = JSON.stringify(receipt, null, 2) + "\n";
    requireEvidence(Buffer.byteLength(json) <= maximumReceiptBytes, "fixture_receipt_too_large");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(path, json, { mode: 0o600, flag: "wx" });
    writeSync(receipt.status === "PASS" ? process.stdout.fd : process.stderr.fd,
      JSON.stringify({ pgFixturePreflight: receipt.status, stage: receipt.stage, receipt: path }) + "\n");
  } catch {
    try { writeSync(process.stderr.fd, '{"pgFixturePreflight":"FAIL","reason":"receipt_unavailable"}\n'); } catch { /* Gate still fails. */ }
    return 1;
  }
  return receipt.status === "PASS" ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = runFixtureReadback();

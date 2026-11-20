import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { h04Roles, openCatalogGuardTestCluster } from "./fixtures/postgres-catalog-guard-cluster.ts";

const execute = promisify(execFile);
const toolsDirectory = process.env["AGENT_STUDIO_PG_RESTART_BIN"];
const workspace = fileURLToPath(new URL("../", import.meta.url));
// Keep the actual existing fixtures, backup/verifyDatabase calls and assertions.
// The shared service tests are separately recorded as server 16.16; this entry
// supplies only its freshly owned server 16.15 and cannot adopt the service URL.
const selected = [
  "#152 PG16 real nonempty native dump/restore preserves catalog, owner/ACL, controls, typed values and migration identity sequence",
  "#152 public native restore preserves six owner/ACL profiles with present or absent target public",
  "#152 public native restore supports an authorized non-superuser database owner",
  "#152 public target unknown namespace dependencies block before DROP and preserve their identity",
  "#152 public native error, abort and source/target lock loss roll back and await actual child/backend exit",
  "#152 PG physical locks reject an in-flight writer; unknown idle backend is still a blocker",
  "#152 PG restore refuses source/occupied target, missing declared owner role and corrupt dump; never clears a target",
  "#152 PG exporter loss cancels its dump and sequence drift invalidates an attempted snapshot",
] as const;
const expectedTests = 24; // Eight original parents + twelve ACL and four native-failure subtests.
const pattern = selected.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const withoutInheritedReporters = (options: string) => {
  const args = options.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const retained: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--test-reporter" || arg === "--test-reporter-destination") index++;
    else if (!/^--test-reporter(?:-destination)?=/.test(arg)) retained.push(arg);
  }
  return retained.join(" ");
};
const nativeTestEnvironment = () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PG")));
  // The independent runner needs its own context and the single CLI reporter.
  // Inherited reporter/destination pairs otherwise conflict with that reporter.
  delete env["NODE_TEST_CONTEXT"];
  if (env["NODE_OPTIONS"] !== undefined) env["NODE_OPTIONS"] = withoutInheritedReporters(env["NODE_OPTIONS"]);
  return env;
};

// Retain the original maintenance-postgres CI batch limit of 300 s. The
// enclosing 600 s includes the owned cluster startup, identity checks and actual
// shutdown; the unchanged pg-native launcher still bounds the whole entry at 900 s.
test("R05 owned PG16.15 reuses nonempty native restore, catalog/ACL and actual failure-retirement cases",
  { skip: toolsDirectory === undefined, timeout: 600_000 }, async t => {
    assert.equal(process.env["AGENT_STUDIO_PG_TEST_URL"], undefined,
      "the owned entry must not accept a supplied shared database URL");
    assert.equal(await realpath(process.cwd()), await realpath(workspace));
    const evidence = join(workspace, ".agent-output/maintenance-pg-restart");
    await mkdir(evidence, { recursive: true, mode: 0o700 });
    const sourceFile = join(workspace, "tests/maintenance-postgres.test.ts");
    const sourceDigest = digest(await readFile(sourceFile));
    const errors: unknown[] = [];
    let cluster: Awaited<ReturnType<typeof openCatalogGuardTestCluster>> | undefined;
    let stdout = "", stderr = "", clusterClosed = false;
    let pid: number | undefined, close: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined;
    let completed: string[] = [], remaining: Record<string, unknown> | undefined;
    const started = performance.now();
    const readServer = async () => {
      const client = await cluster!.connect();
      try {
        const row = (await client.query(`SELECT current_setting('server_version_num') AS version,
          current_setting('fsync') AS fsync,current_setting('synchronous_commit') AS synchronous_commit,
          (pg_control_system()).system_identifier::text AS system_identifier,
          pg_postmaster_start_time()::text AS started,current_setting('data_directory') AS directory`)).rows[0];
        assert.equal(row.version, "160015"); assert.equal(row.fsync, "on"); assert.equal(row.synchronous_commit, "on");
        assert.equal(row.system_identifier, cluster!.systemIdentifier);
        return row as Record<string, unknown>;
      } finally { await client.end(); }
    };
    try {
      cluster = await openCatalogGuardTestCluster(toolsDirectory!, "r05");
      before = await readServer();
      const env = nativeTestEnvironment();
      env["AGENT_STUDIO_PG_TEST_URL"] = cluster.connectionString();
      // The original pg-native launcher supplies the six exact private 16.15
      // programs in PATH. No driver, Fs or source-preservation profile is replaced.
      const operation = execute(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=1",
        "--test-name-pattern=" + pattern, sourceFile], {
        cwd: workspace, env, timeout: 300_000, killSignal: "SIGTERM", maxBuffer: 512_000, signal: t.signal,
      });
      pid = operation.child.pid;
      const closed = new Promise<void>(resolve => operation.child.once("close", (code, signal) => {
        close = { code, signal }; resolve();
      }));
      try { ({ stdout, stderr } = await operation); }
      catch (error) {
        if (typeof error === "object" && error !== null) {
          const value = error as { stdout?: unknown; stderr?: unknown };
          if (typeof value.stdout === "string") stdout = value.stdout;
          if (typeof value.stderr === "string") stderr = value.stderr;
        }
        throw error;
      } finally { await closed; }
      assert.ok(Number.isSafeInteger(pid) && pid! > 1);
      assert.deepEqual(close, { code: 0, signal: null }, "the exact native test child must actually exit and close");
      completed = [...stdout.matchAll(/^ok [0-9]+ - (.+)$/gm)].map(match => match[1]!.replace(/\\#/g, "#"));
      assert.deepEqual([...completed].sort(), [...selected].sort(), "every selected original parent must pass, with no extra cases");
      for (const [field, value] of Object.entries({ tests: expectedTests, pass: expectedTests, fail: 0, cancelled: 0, skipped: 0, todo: 0 })) {
        const rows = [...stdout.matchAll(new RegExp("^# " + field + " ([0-9]+)$", "gm"))];
        assert.equal(rows.length, 1, "one actual final TAP " + field); assert.equal(Number(rows[0]![1]), value);
      }
      assert.equal(digest(await readFile(sourceFile)), sourceDigest, "the reused original test source remains exact");
      after = await readServer(); assert.deepEqual(after, before, "the entire batch remains on its one actual owned server");
      const client = await cluster.connect();
      try {
        const backends = (await client.query(`SELECT pid,backend_start::text,application_name FROM pg_stat_activity
          WHERE backend_type='client backend' AND pid<>pg_backend_pid() ORDER BY pid`)).rows;
        const databases = (await client.query("SELECT datname FROM pg_database WHERE datname NOT IN ('postgres','template0','template1') ORDER BY datname")).rows;
        const roles = (await client.query("SELECT rolname FROM pg_roles WHERE rolname<>$1 AND rolname !~ '^pg_' ORDER BY rolname", [h04Roles.administrator])).rows;
        remaining = { backends, databases, roles };
        assert.deepEqual(remaining, { backends: [], databases: [], roles: [] },
          "original cases must retire their real backends, databases and roles before cluster shutdown");
      } finally { await client.end(); }
    } catch (error) { errors.push(error); }
    // Preserve the original failure and separately account for the real cluster
    // shutdown. The existing owner checks pg_ctl, actual child close and pidfile absence.
    if (cluster) try { await cluster.close(); clusterClosed = true; } catch (error) { errors.push(error); }
    const receipt = {
      scope: "R05 owned PG16.15 native restore component only", status: errors.length ? "FAIL" : "PASS",
      reusedSource: "tests/maintenance-postgres.test.ts", reusedSourceSha256: sourceDigest,
      selected, expectedTests, completed, nativeTestChild: { pid, close }, before, after, remaining, clusterClosed,
      stdout: { bytes: Buffer.byteLength(stdout), sha256: digest(stdout) }, stderr: { bytes: Buffer.byteLength(stderr), sha256: digest(stderr) },
      elapsedMilliseconds: performance.now() - started,
      errors: errors.map(error => error instanceof Error ? { name: error.name, message: error.message } : { thrownType: typeof error }),
      qualification: "UNSUPPORTED", production_bound: false, commit_barrier: false,
      fullR05: "NOT_RUN", jointFs_BUV_plan_WR1: "NOT_RUN", productionRegistry: "UNCHANGED_EMPTY",
    };
    try {
      await writeFile(join(evidence, "r05-native.tap"), stdout, { flag: "wx", mode: 0o600 });
      await writeFile(join(evidence, "r05-native.stderr"), stderr, { flag: "wx", mode: 0o600 });
      await writeFile(join(evidence, "r05-owned-receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    } catch (error) { errors.push(error); }
    t.diagnostic(JSON.stringify({ scope: receipt.scope, status: errors.length ? "FAIL" : "PASS",
      nativeServerVersion: before?.["version"], systemIdentifier: cluster?.systemIdentifier,
      selectedParents: completed.length, expectedNativeTests: expectedTests, actualChildClose: close, clusterClosed,
      fullR05: "NOT_RUN", jointFs_BUV_plan_WR1: "NOT_RUN", productionRegistry: "UNCHANGED_EMPTY" }));
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "R05 owned native cases or resource retirement failed", { cause: errors[0] });
  });

test("R05 child runner executes actual nested tests without inheriting the parent runner context", { timeout: 10_000 }, async t => {
  assert.equal(process.env["NODE_TEST_CONTEXT"], "child-v8", "the control must run under an actual parent node --test");
  const original = { ...process.env };
  const env = nativeTestEnvironment();
  for (const [key, value] of Object.entries(original)) {
    if (key === "NODE_TEST_CONTEXT" || key === "NODE_OPTIONS") continue;
    assert.ok(env[key] === (key.startsWith("PG") ? undefined : value), "preserve the original environment rule for " + key);
  }
  const expectedNodeOptions = original["NODE_OPTIONS"]?.split(/\s+/)
    .filter(arg => !arg.startsWith("--test-reporter=") && !arg.startsWith("--test-reporter-destination="))
    .join(" ");
  assert.equal(env["NODE_OPTIONS"], expectedNodeOptions, "retain every non-reporter Node option");
  const directory = await mkdtemp(join(tmpdir(), "boardroom-r05-child-"));
  try {
    const fixture = join(directory, "child.mjs");
    await writeFile(fixture, `import test from 'node:test';
import assert from 'node:assert/strict';
test('R05 selected parent one', async t => {
  await t.test('R05 actual nested assertion', () => assert.equal(1 + 1, 2));
});
test('R05 selected parent two', () => assert.equal(process.env.NODE_TEST_CONTEXT, 'child-v8'));
`);
    const operation = execute(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=1", fixture], {
      env, timeout: 5_000, killSignal: "SIGTERM", maxBuffer: 32_000, signal: t.signal,
    });
    let close: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    const closed = new Promise<void>(resolve => operation.child.once("close", (code, signal) => {
      close = { code, signal }; resolve();
    }));
    let stdout: string, stderr: string;
    try { ({ stdout, stderr } = await operation); } finally { await closed; }
    assert.ok(Number.isSafeInteger(operation.child.pid) && operation.child.pid! > 1);
    assert.deepEqual(close, { code: 0, signal: null });
    t.diagnostic(JSON.stringify({ node: process.version, childClose: close, stdout, stderr }));
    assert.deepEqual([...stdout.matchAll(/^ok [0-9]+ - (.+)$/gm)].map(match => match[1]),
      ["R05 selected parent one", "R05 selected parent two"]);
    for (const [field, value] of Object.entries({ tests: 3, pass: 3, fail: 0, cancelled: 0, skipped: 0, todo: 0 })) {
      const rows = [...stdout.matchAll(new RegExp("^# " + field + " ([0-9]+)$", "gm"))];
      assert.equal(rows.length, 1); assert.equal(Number(rows[0]![1]), value);
    }
    assert.equal(stderr, "");
    assert.deepEqual(Object.keys(process.env).sort(), Object.keys(original).sort());
    for (const [key, value] of Object.entries(original)) {
      assert.ok(process.env[key] === value, "preparing the child environment must not change parent field " + key);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

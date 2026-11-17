import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { stat, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import type { Duplex } from "node:stream";
import { ControllerFrameReader, controllerLimits, encodeControllerFrame, parseControllerCommand, parseControllerRequest,
  controllerDescriptorAliases, projectControllerFailure } from "../src/server/storage/maintenance/controller-command.ts";
import { maintenanceRequestDigest } from "../src/server/storage/maintenance/parse.ts";
import { digestJson } from "../src/server/storage/maintenance/canonical.ts";
import { SourceFilesFailure } from "../src/server/storage/maintenance/source-files.ts";
import { parsePostgresConnection } from "../src/server/storage/maintenance/postgres-tools.ts";
import type { MaintenanceCommand } from "../src/server/storage/maintenance/types.ts";
import { executorFixture, executorSecret } from "./fixtures/maintenance-controller-executor.ts";

const saved = new Map<string, string | undefined>();
before(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith("AGENT_STUDIO_") || ["BOARDROOM_HOME", "NODE_OPTIONS", "NODE_PATH"].includes(key)) {
    saved.set(key, process.env[key]); delete process.env[key];
  }
  process.env["BOARDROOM_HOME"] = path.join(tmpdir(), `boardroom-c3-executor-no-home-${process.pid}`);
});
after(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith("AGENT_STUDIO_") || ["BOARDROOM_HOME", "NODE_OPTIONS", "NODE_PATH"].includes(key)) delete process.env[key];
  for (const [key, value] of saved) if (value !== undefined) process.env[key] = value;
});

test("C3-AC44 值 gateway：三写命令原摘要不变，inspect 独立严格且无能力/任意入口输入", async () => {
  const f = await executorFixture("paused");
  try {
    if (f.request.command.operation === "inspect-migration") throw new Error("mutating transport fixture required");
    for (const operation of ["execute-migration", "resume-migration", "cancel-migration"] as const) {
      const command: MaintenanceCommand = { ...f.request.command, operation };
      assert.equal(maintenanceRequestDigest(command), digestJson(parseControllerCommand(command)));
      assert.deepEqual(parseControllerRequest({ ...f.request, command }).command, command);
    }
    const inspect = { operation: "inspect-migration", request: { plan: f.request.command.request.plan,
      expectedSource: f.request.command.request.expectedSource } };
    assert.deepEqual(parseControllerCommand(inspect), inspect);
    for (const extra of [{ requestId: "not-inspect" }, { expectedPhase: null }, { expectedJournalDigest: null }, { guard: true }])
      assert.throws(() => parseControllerCommand({ ...inspect, request: { ...inspect.request, ...extra } }));
    for (const key of ["executable", "module", "loader", "argv", "env", "callback", "nativeProof", "backupPath"])
      assert.throws(() => parseControllerRequest({ ...f.request, [key]: executorSecret }));
    assert.throws(() => parseControllerRequest({ ...f.request, selection: { ...f.request.selection, originalCwd: "relative" } }));
    assert.throws(() => parseControllerRequest({ ...f.request, selection: { ...f.request.selection,
      knownLegacyCwds: Array.from({ length: 20 }, () => "/" + "a".repeat(4095)) } }));
    assert.deepEqual(await f.events(), []);
  } finally { await f.close(); }
});

test("C3-AC44 字节预算在 JSON 解析前生效，UTF-8 分片/非法字节/未完成超限帧拒绝", () => {
  const values: unknown[] = [], reader = new ControllerFrameReader(controllerLimits.commandBytes, value => { values.push(value); });
  const bytes = encodeControllerFrame({ text: "来源" }, controllerLimits.commandBytes);
  for (const byte of bytes) reader.push(Buffer.from([byte]));
  reader.end(); assert.deepEqual(values, [{ text: "来源" }]);
  const boundary = new ControllerFrameReader(controllerLimits.commandBytes, value => { assert.equal((value as string).length, controllerLimits.commandBytes - 2); });
  boundary.push(Buffer.from('"' + "x".repeat(controllerLimits.commandBytes - 2) + '"\n')); boundary.end();
  const large = new ControllerFrameReader(controllerLimits.commandBytes, () => assert.fail("oversized frame decoded"));
  assert.throws(() => large.push(Buffer.alloc(controllerLimits.commandBytes + 1, 97)));
  assert.throws(() => new ControllerFrameReader(100, () => assert.fail()).push(Buffer.from([0xff, 10])));
  assert.throws(() => new ControllerFrameReader(100, () => assert.fail()).push(Buffer.from('{"sequence":1,"sequence":0}\n')));
  const partial = new ControllerFrameReader(100, () => assert.fail()); partial.push(Buffer.from("{")); assert.throws(() => partial.end());
});

test("C3-AC41/49 安全错误投影保留 undefined 首次发生和重复独立 cleanup 事件", () => {
  const error = new Error(executorSecret);
  const failure = projectControllerFailure(new AggregateError([undefined, error, error, undefined], executorSecret));
  assert.equal(failure.occurred, true); assert.equal(failure.truncated, false);
  assert.deepEqual(failure.events.map(event => event.kind), ["aggregate", "undefined", "unknown", "unknown", "undefined"]);
  assert.deepEqual(failure.events.map(event => event.parent), [null, 0, 0, 0, 0]);
  assert.equal(projectControllerFailure(undefined).occurred, true);
  assert.ok(!JSON.stringify(failure).includes(executorSecret));
  const sourceFailure = projectControllerFailure(new SourceFilesFailure(undefined, "close", [error, error, undefined], false));
  assert.deepEqual(sourceFailure.events.map(event => event.kind), ["maintenance", "undefined", "unknown", "unknown", "undefined"]);
  assert.ok(!JSON.stringify(sourceFailure).includes(executorSecret));
  assert.equal(projectControllerFailure(new AggregateError([undefined, new SourceFilesFailure(undefined, "close", [], false)])).code,
    "controller_service_failed", "later cleanup does not replace the first unknown failure");
  const bounded = projectControllerFailure(new AggregateError(Array.from({ length: 70 }, () => undefined)));
  assert.equal(bounded.truncated, true); assert.equal(bounded.omittedBranches, 7);
  assert.deepEqual(controllerDescriptorAliases({ kind: "postgres", connectionString: "postgres://user:first@localhost/database" }),
    controllerDescriptorAliases({ kind: "postgres", connectionString: "postgres://user:second@localhost:5432/database" }),
    "PG credential/URL aliases retain the existing canonical descriptor cleanup key");
});

test("C3-AC05/06/42 transport：result 与 IPC 已关闭时仍等真实退出，同源返回原 Promise、异源可并行", { timeout: 20_000 }, async () => {
  const f = await executorFixture("hold-result"), other = await executorFixture("paused");
  try {
    const first = f.run();
    assert.equal(f.run(structuredClone(f.request)), first, "同步重入必须取得首 await 前登记的原 Promise");
    const emitted = await f.waitFor("result-sent");
    let settled = false; void first.then(() => { settled = true; });
    await delay(40); assert.equal(settled, false);
    assert.notEqual(emitted.pid, process.pid); process.kill(emitted.pid as number, 0);
    const changed = { ...f.request, command: { ...f.request.command, request: { ...f.request.command.request, requestId: "other-request" } } };
    assert.equal((await f.run(changed)).result.status, "blocked");
    assert.equal((await f.events()).filter(event => event.event === "peer").length, 1);
    const alias = path.join(f.dir, "source-alias"); await symlink(f.sourceDir, alias, "dir");
    assert.equal((await f.run({ ...f.request, selection: { ...f.request.selection, originalCwd: alias } })).result.status, "blocked");
    const independent = f.run(other.request);
    for (let i = 0; i < 500 && (await f.events()).filter(event => event.event === "result-sent").length < 2; i++) await delay(10);
    const peers = (await f.events()).filter(event => event.event === "peer");
    assert.equal(peers.length, 2); assert.notEqual(peers[0]!.pid, peers[1]!.pid);
    assert.equal(settled, false);
    await f.release("exit");
    for (const result of await Promise.all([first, independent])) { assert.equal(result.failure, null); assert.equal(result.result.status, "paused"); }
    const next = await f.run(changed); assert.equal(next.failure, null);
    const later = (await f.events()).filter(event => event.event === "peer").at(-1)!;
    assert.notEqual(later.pid, peers[0]!.pid, "下一完整命令使用真实新子进程");
  } finally { await f.close(); await other.close(); }
});

test("C3-AC06/43 transport：已收到真实 exit，但后代仍持有 stdio 时不成功、不释放同源 pending", { timeout: 15_000 }, async () => {
  const f = await executorFixture("hold-stdio");
  try {
    const promise = f.run();
    await f.waitFor("stdio-holder"); await f.waitFor("exit");
    let settled = false; void promise.then(() => { settled = true; });
    await delay(40); assert.equal(settled, false); assert.equal(f.run(), promise);
    await f.release("stdio");
    const result = await promise; assert.equal(result.failure, null); assert.equal(result.result.status, "paused");
  } finally { await f.close(); }
});

for (const mode of ["abnormal-exit", "duplicate-result", "out-of-order", "invalid-version", "oversized-frame"] as const)
test(`C3-AC43/44 transport：${mode} 不把先到值帧当成功`, { timeout: 15_000 }, async () => {
  const f = await executorFixture(mode);
  try {
    const result = await f.run();
    assert.equal(result.failure?.occurred, true);
    assert.ok(["blocked", "recovery_required"].includes(result.result.status));
    assert.ok(!JSON.stringify(result).includes(executorSecret));
  } finally { await f.close(); }
});

for (const mode of ["throw-undefined", "throw-aggregate", "large-result", "secret-blocker"] as const)
test(`C3-AC41/44/49 actual worker + fixed test service：${mode} 保持发生位/预算/安全输出`, { timeout: 15_000 }, async () => {
  const f = await executorFixture(mode);
  try {
    const outcome = await f.run();
    assert.ok(!JSON.stringify(outcome).includes(executorSecret));
    if (mode === "secret-blocker") {
      assert.equal(outcome.failure, null); assert.equal(outcome.result.status, "blocked");
      if (outcome.result.status === "blocked") assert.match(outcome.result.blockers[0]!.subjectRef, /^source:[a-f0-9]{24}$/);
    } else {
      assert.equal(outcome.failure?.occurred, true); assert.equal(outcome.result.status, "recovery_required");
      if (mode === "throw-aggregate") {
        const first = outcome.failure!.events.filter(event => event.parent === 0);
        assert.deepEqual(first.map(event => event.kind), ["undefined", "unknown", "unknown", "undefined"]);
      }
      if (mode === "throw-undefined") assert.equal(outcome.failure!.events[0]!.kind, "undefined");
    }
    assert.equal((await f.events()).filter(event => event.event === "service").length, 1);
  } finally { await f.close(); }
});

test("C3-AC44 固定 process.execPath/入口/argv；NODE_OPTIONS 与 NODE_PATH 不能给 worker 注入 loader", { timeout: 15_000 }, async () => {
  const f = await executorFixture("paused"), marker = path.join(f.dir, "loader-was-run");
  try {
    process.env["NODE_OPTIONS"] = `--import=data:text/javascript,${encodeURIComponent(`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)}, 'bad')`)}`;
    process.env["NODE_PATH"] = path.join(f.dir, executorSecret);
    const result = await f.run(); assert.equal(result.failure, null);
    const event = await f.waitFor("service");
    assert.equal(event.execPath, process.execPath); assert.deepEqual(event.execArgv, []);
    assert.deepEqual(event.argv, [process.execPath, path.join(f.checkout, "src/server/storage/maintenance/controller-worker-entry.ts")]);
    assert.equal(event.nodeOptions, null); assert.equal(event.nodePath, null);
    await assert.rejects(stat(marker), { code: "ENOENT" });
  } finally { delete process.env["NODE_OPTIONS"]; delete process.env["NODE_PATH"]; await f.close(); }
});

test("C3-AC44 actual worker：非法/重复/越序输入只运行零次或一次固定服务", { timeout: 20_000 }, async () => {
  const f = await executorFixture("paused");
  try {
    const command = { version: 1, sequence: 0, type: "command", request: f.request };
    const cases: { name: string; bytes: Buffer; continueTwice?: true }[] = [
      { name: "version", bytes: encodeControllerFrame({ ...command, version: 2 }, controllerLimits.commandBytes) },
      { name: "order", bytes: encodeControllerFrame({ version: 1, sequence: 1, type: "continue" }, controllerLimits.commandBytes) },
      { name: "duplicate-command", bytes: Buffer.concat([encodeControllerFrame(command, controllerLimits.commandBytes), encodeControllerFrame(command, controllerLimits.commandBytes)]) },
      { name: "oversize", bytes: Buffer.alloc(controllerLimits.commandBytes + 1, 97) },
      { name: "duplicate-continue", bytes: encodeControllerFrame(command, controllerLimits.commandBytes), continueTwice: true },
    ];
    for (const item of cases) {
      const child = spawn(process.execPath, [path.join(f.checkout, "src/server/storage/maintenance/controller-worker-entry.ts")],
        { cwd: f.sourceDir, env: process.env, stdio: ["ignore", "pipe", "pipe", "pipe"] });
      const ipc = child.stdio[3] as Duplex, frames: unknown[] = [], errors: Buffer[] = [];
      const reader = new ControllerFrameReader(controllerLimits.resultBytes, value => {
        frames.push(value);
        if (item.continueTwice && (value as { type: string }).type === "resolved") {
          const next = encodeControllerFrame({ version: 1, sequence: 1, type: "continue" }, controllerLimits.commandBytes);
          ipc.end(Buffer.concat([next, next]));
        }
      });
      ipc.on("data", (chunk: Buffer) => reader.push(chunk)); ipc.on("end", () => { reader.end(); ipc.end(); }); ipc.on("error", () => {});
      child.stdout!.resume(); child.stderr!.on("data", (chunk: Buffer) => errors.push(chunk));
      const ended = new Promise<number | null>(resolve => child.on("close", code => { resolve(code); }));
      if (item.continueTwice) ipc.write(item.bytes); else ipc.end(item.bytes);
      assert.notEqual(await ended, 0, item.name);
      assert.ok(!JSON.stringify(frames).includes(executorSecret));
      // This direct harness sees the private raw pipe. The production parent discards it;
      // the one service entry deliberately emits the canary to prove that boundary is exercised.
      assert.equal(Buffer.concat(errors).toString().includes(executorSecret), !!item.continueTwice);
      assert.ok(!frames.some(value => (value as { type: string }).type === "result"), item.name);
    }
    assert.equal((await f.events()).filter(event => event.event === "service").length, 1, "只有首个合法 continue 可进入固定服务一次");
  } finally { await f.close(); }
});

test("C3-AC49 CLI + actual executor + fixed throwing service：私有 raw stdout/stderr 与原错误均不泄漏", { timeout: 15_000 }, async () => {
  const f = await executorFixture("throw-aggregate");
  try {
    const selected = f.request.selection, command = f.request.command.request;
    const result = spawnSync(process.execPath, [path.join(f.checkout, "scripts/storage-maintenance.ts"), "execute",
      "--expected-source-id", selected.expectedSourceId, "--control-root", selected.controlRoot, "--target-root", selected.targetRoot,
      "--migration-id", command.plan.migrationId, "--plan-digest", command.plan.planDigest, "--plan-bytes", command.plan.immutablePlan.bytes,
      "--expected-source-kind", command.expectedSource.kind, "--expected-database-instance-id", command.expectedSource.databaseInstanceId,
      "--expected-source-identity-digest", command.expectedSource.identityDigest, "--request-id", "cli-request",
      "--expected-phase", "none", "--expected-journal-digest", "none"], { cwd: f.sourceDir, env: process.env, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 1);
    for (const raw of [result.stdout, result.stderr]) for (const forbidden of [executorSecret, f.dir, "Error:", " at "])
      assert.ok(!raw.includes(forbidden));
    const value = JSON.parse(result.stdout); assert.equal(value.failure.occurred, true); assert.equal(value.result.status, "recovery_required");
    assert.match(result.stderr, /^\[controller_service_failed\]/);
    assert.equal((await f.events()).filter(event => event.event === "service").length, 1);
  } finally { await f.close(); }
});

test("C3-I06 PG 私有配置装配：固定 worker 严格读取、默认 public、无目标保持缺失（非真实 PG 资格）", { timeout: 20_000 }, async () => {
  const connectionKey = "AGENT_STUDIO_MAINTENANCE_PG_VERIFICATION_CONNECTION_STRING", schemaKey = "AGENT_STUDIO_MAINTENANCE_PG_VERIFICATION_SCHEMA";
  const connectionString = `postgres://fixture:${executorSecret}@localhost/explicit_verification`;
  const cases = [
    { connection: undefined, schema: undefined, configured: false, effectiveSchema: null, valid: true },
    { connection: connectionString, schema: undefined, configured: true, effectiveSchema: "public", valid: true },
    { connection: connectionString, schema: "app", configured: true, effectiveSchema: "app", valid: true },
    { connection: undefined, schema: "public", configured: false, effectiveSchema: null, valid: false },
    { connection: "", schema: undefined, configured: false, effectiveSchema: null, valid: false },
    { connection: connectionString, schema: "", configured: false, effectiveSchema: null, valid: false },
    { connection: connectionString, schema: "bad-schema", configured: false, effectiveSchema: null, valid: false },
    { connection: `https://fixture:${executorSecret}@localhost/invalid`, schema: undefined, configured: false, effectiveSchema: null, valid: false },
  ];
  try {
    for (const item of cases) {
      if (item.connection === undefined) delete process.env[connectionKey]; else process.env[connectionKey] = item.connection;
      if (item.schema === undefined) delete process.env[schemaKey]; else process.env[schemaKey] = item.schema;
      const f = await executorFixture("paused", "postgres");
      try {
        const before = digestJson(f.request), outcome = await f.run();
        assert.equal(digestJson(f.request), before); assert.ok(!JSON.stringify(outcome).includes(executorSecret));
        const services = (await f.events()).filter(event => event.event === "service");
        if (item.valid) {
          assert.equal(outcome.failure, null); assert.equal(services.length, 1);
          assert.equal(services[0]!.verificationConfigured, item.configured); assert.equal(services[0]!.verificationSchema, item.effectiveSchema);
          if (item.configured) assert.equal(services[0]!.verificationDescriptorDigest, parsePostgresConnection({ kind: "postgres",
            connectionString, ...(item.schema === undefined ? {} : { schema: item.schema }) }).descriptorDigest);
        } else {
          assert.equal(outcome.result.status, "blocked"); assert.equal(outcome.failure?.code, "restore_verification_unavailable");
          assert.equal(services.length, 0);
        }
      } finally { await f.close(); }
    }
    process.env[connectionKey] = executorSecret; process.env[schemaKey] = "bad-schema";
    const sqlite = await executorFixture("paused");
    try {
      const outcome = await sqlite.run(); assert.equal(outcome.failure, null);
      assert.equal((await sqlite.waitFor("service")).verificationConfigured, false);
      assert.ok(!JSON.stringify(outcome).includes(executorSecret));
    } finally { await sqlite.close(); }
  } finally { delete process.env[connectionKey]; delete process.env[schemaKey]; }
});

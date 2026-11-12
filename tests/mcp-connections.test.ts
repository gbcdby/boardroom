import test from "node:test";
import assert from "node:assert/strict";
import { createMcpConnections, onMcpConnectionChange, type McpDiscoveryAttempt } from "../src/server/mcp/connections/service.ts";
import { ownerActor } from "../src/server/authz/actors.ts";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { identityEngines, identityFixture, identitySkip } from "./helpers/identity-fixture.ts";
import { discoveryTestServer, discoveryTool } from "./helpers/mcp-discovery-server.ts";

const access = { actor: ownerActor() };
const fields = (endpoint: string) => ({ name: "测试连接", enabled: true, transport: { type: "streamable-http", endpoint } });

for (const engine of identityEngines) {
  const skip = identitySkip(engine);
  test(`${engine} S7 持久登记不连接，幂等/CAS版本不可变，普通视图不包含连接秘密配置`, { skip }, async () => {
    const f = await identityFixture(engine), upstream = await discoveryTestServer();
    const service = createMcpConnections({ db: f.db });
    try {
      const input = { ...fields(upstream.endpoint), requestId: "register", transport: {
        type: "streamable-http", endpoint: upstream.endpoint, credentialRef: "private/credential-reference" } };
      const first = await service.create(access, input);
      assert.deepEqual(await service.create(access, input), first);
      assert.equal(upstream.methods.length, 0);
      assert.equal(first.revision, 1);
      assert.doesNotMatch(JSON.stringify(await service.list(access)), /127\.0\.0\.1|private\/credential/);
      assert.equal((await service.configuration(access, first.connectionId, 1)).transport.credentialRef, "private/credential-reference");
      await assert.rejects(service.create(access, { ...input, name: "changed" }), /request_conflict/);
      const updated = await service.update(access, first.connectionId, { ...fields(upstream.endpoint), requestId: "update", expectedRevision: 1 });
      assert.equal(updated.revision, 2);
      await assert.rejects(service.update(access, first.connectionId, { ...fields(upstream.endpoint), requestId: "stale", expectedRevision: 1 }), /revision_conflict/);
      const raced = await Promise.allSettled(["a", "b"].map(requestId => service.update(access, first.connectionId,
        { ...fields(upstream.endpoint), requestId, expectedRevision: 2 })));
      assert.equal(raced.filter(value => value.status === "fulfilled").length, 1);
      assert.equal((await service.get(access, first.connectionId)).connection.revision, 3);
      assert.equal((await f.db.query("SELECT * FROM mcp_connection_versions")).length, 3);
    } finally { await service.close(); await upstream.close(); await f.close(); }
  });

  test(`${engine} S7-AC02 真实发现同名跨连接与schema版本隔离，失败保留完整快照且停用不改历史`, { skip }, async () => {
    const f = await identityFixture(engine);
    let mode = "string";
    const upstream = await discoveryTestServer({ page: cursor => mode === "bad" && cursor === "next" ? { tools: "private-bad-body" }
      : { tools: [discoveryTool("same", mode === "number" ? "number" : "string")], ...(mode === "bad" ? { nextCursor: "next" } : {}) } });
    const service = createMcpConnections({ db: f.db });
    try {
      const a = await service.create(access, { ...fields(upstream.endpoint), requestId: "a" });
      const b = await service.create(access, { ...fields(upstream.endpoint), requestId: "b" });
      const initial = await service.discover(access, a.connectionId, { requestId: "discover-a", expectedRevision: 1 });
      assert.equal(initial.status, "succeeded");
      const original = (await service.get(access, a.connectionId)).currentSnapshot!;
      assert.equal(original.tools.length, 1);
      await service.discover(access, b.connectionId, { requestId: "discover-b", expectedRevision: 1 });
      assert.notEqual((await service.get(access, b.connectionId)).currentSnapshot!.tools[0]!.toolKey, original.tools[0]!.toolKey);
      mode = "number";
      await service.discover(access, a.connectionId, { requestId: "schema-change", expectedRevision: 1 });
      const latest = (await service.get(access, a.connectionId)).currentSnapshot!;
      assert.notEqual(latest.tools[0]!.ref.schemaDigest, original.tools[0]!.ref.schemaDigest);
      assert.deepEqual(await service.snapshot(access, a.connectionId, original.snapshotDigest), original);
      mode = "bad";
      const failed = await service.discover(access, a.connectionId, { requestId: "partial", expectedRevision: 1 });
      assert.equal(failed.status, "discovery_failed");
      assert.equal((await service.get(access, a.connectionId)).currentSnapshot!.snapshotDigest, latest.snapshotDigest);
      assert.doesNotMatch(JSON.stringify(failed), /private-bad|127\.0\.0\.1/);
      const calls = upstream.methods.length;
      assert.deepEqual(await service.discover(access, a.connectionId, { requestId: "partial", expectedRevision: 1 }), failed);
      assert.equal(upstream.methods.length, calls, "同request幂等重放不能重连");
      await service.update(access, a.connectionId, { ...fields(upstream.endpoint), enabled: false, requestId: "disable", expectedRevision: 1 });
      const blocked = await service.discover(access, a.connectionId, { requestId: "disabled-discovery", expectedRevision: 2 });
      assert.equal(blocked.status, "blocked"); assert.equal(blocked.errorCode, "connection_disabled");
      assert.equal(upstream.methods.length, calls);
      const view = await service.get(access, a.connectionId);
      assert.equal(view.state, "disabled"); assert.equal(view.currentSnapshot, null);
      assert.deepEqual(await service.snapshot(access, a.connectionId, original.snapshotDigest), original);
    } finally { await service.close(); await upstream.close(); await f.close(); }
  });

  test(`${engine} S7 取消请求、停用与迟到发现不能发布当前目录；关闭只收本服务资源`, { skip }, async () => {
    const f = await identityFixture(engine);
    let arrived!: () => void, release!: () => void;
    let hit = new Promise<void>(resolve => { arrived = resolve; });
    let hold = new Promise<void>(resolve => { release = resolve; });
    const upstream = await discoveryTestServer({ page: async () => { arrived(); await hold; return { tools: [discoveryTool("late")] }; } });
    const service = createMcpConnections({ db: f.db });
    try {
      const a = await service.create(access, { ...fields(upstream.endpoint), requestId: "a" });
      const pending = service.discover(access, a.connectionId, { requestId: "late", expectedRevision: 1 });
      await hit;
      await service.update(access, a.connectionId, { ...fields(upstream.endpoint), enabled: false, requestId: "disable", expectedRevision: 1 });
      release();
      assert.equal((await pending).status, "superseded");
      assert.equal((await service.get(access, a.connectionId)).currentSnapshot, null);
      await service.update(access, a.connectionId, { ...fields(upstream.endpoint), requestId: "enable", expectedRevision: 2 });
      hit = new Promise<void>(resolve => { arrived = resolve; }); hold = new Promise<void>(resolve => { release = resolve; });
      const cancelling = service.discover(access, a.connectionId, { requestId: "cancel", expectedRevision: 3 });
      await hit;
      const attempt = (await service.get(access, a.connectionId)).lastDiscovery!;
      await service.cancel(access, a.connectionId, attempt.attemptId);
      assert.equal((await cancelling).status, "cancelled"); release();
      assert.equal((await service.get(access, a.connectionId)).currentSnapshot, null);
      assert.equal(upstream.deletes, 2);
    } finally { release(); await service.close(); await upstream.close(); await f.close(); }
  });

  test(`${engine} S7 领域事件仅提交后非秘密标识；外事务回滚不登记不通知，重启幂等记录保留`, { skip }, async () => {
    const f = await identityFixture(engine), service = createMcpConnections({ db: f.db });
    const events: unknown[] = [];
    const stop = onMcpConnectionChange(f.db, event => { events.push(event); });
    try {
      await assert.rejects(f.db.transaction(async () => {
        await service.create(access, { ...fields("https://secret-endpoint.invalid/mcp"), requestId: "rollback" });
        assert.deepEqual(events, []); throw new Error("rollback");
      }), /rollback/);
      assert.equal((await service.list(access)).length, 0); assert.deepEqual(events, []);
      const saved = await service.create(access, { ...fields("https://secret-endpoint.invalid/mcp"), requestId: "persisted" });
      assert.equal(events.length, 1); assert.doesNotMatch(JSON.stringify(events), /secret-endpoint|transport|credential/);
      const second = createMcpConnections({ db: f.db });
      assert.deepEqual(await second.create(access, { ...fields("https://secret-endpoint.invalid/mcp"), requestId: "persisted" }), saved);
      assert.equal(events.length, 1); await second.close();
    } finally { stop(); await service.close(); await f.close(); }
  });

  test(`${engine} S7 同版本新请求胜出，跨服务取消只请求已知尝试，不冒认资源归属`, { skip }, async () => {
    const f = await identityFixture(engine), service = createMcpConnections({ db: f.db }), other = createMcpConnections({ db: f.db });
    let hit!: () => void, release!: () => void;
    let arrived = new Promise<void>(resolve => { hit = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
    const upstream = await discoveryTestServer({ page: async (_cursor, index) => {
      if (index === 1 || index === 3) { hit(); await hold; }
      return { tools: [discoveryTool(index === 2 ? "latest" : "old")] };
    } });
    try {
      const a = await service.create(access, { ...fields(upstream.endpoint), requestId: "a" });
      const old = service.discover(access, a.connectionId, { requestId: "old", expectedRevision: 1 });
      await arrived;
      const newest = await other.discover(access, a.connectionId, { requestId: "new", expectedRevision: 1 });
      assert.equal(newest.status, "succeeded"); release();
      assert.equal((await old).status, "superseded");
      assert.equal((await service.get(access, a.connectionId)).currentSnapshot!.tools[0]!.ref.name, "latest");
      arrived = new Promise<void>(resolve => { hit = resolve; }); hold = new Promise<void>(resolve => { release = resolve; });
      const pending = service.discover(access, a.connectionId, { requestId: "other-cancel", expectedRevision: 1 });
      await arrived;
      const attempt = (await other.get(access, a.connectionId)).lastDiscovery!;
      assert.equal((await other.cancel(access, a.connectionId, attempt.attemptId)).status, "cancel_requested");
      assert.equal(upstream.deletes, 2, "另一服务没有冒认并关闭非自有在途会话");
      release(); assert.equal((await pending).status, "cancelled");
      assert.equal(upstream.deletes, 3);
      assert.equal((await service.get(access, a.connectionId)).currentSnapshot!.snapshotDigest, newest.snapshotId);
    } finally { release(); await service.close(); await other.close(); await upstream.close(); await f.close(); }
  });

  test(`${engine} S7 关闭覆盖尚在数据库排队的发现，不能在关闭后漏开外部连接`, { skip, timeout: 10_000 }, async () => {
    const f = await identityFixture(engine), service = createMcpConnections({ db: f.db }), upstream = await discoveryTestServer();
    let release!: () => void, locked!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; }), acquired = new Promise<void>(resolve => { locked = resolve; });
    try {
      const a = await service.create(access, { ...fields(upstream.endpoint), requestId: "a" });
      const blocker = f.db.transaction(async () => { await f.db.exec("UPDATE mcp_connections SET updated_at=updated_at WHERE id=?", [a.connectionId]); locked(); await hold; });
      await acquired;
      const pending = service.discover(access, a.connectionId, { requestId: "queued", expectedRevision: 1 });
      const closing = service.close(); release(); await blocker;
      await closing; assert.equal((await pending).status, "cancelled");
      assert.equal(upstream.methods.length, 0);
      assert.equal((await service.get(access, a.connectionId)).currentSnapshot, null);
      await assert.rejects(service.discover(access, a.connectionId, { requestId: "after-close", expectedRevision: 1 }), /closed/);
    } finally { release(); await service.close(); await upstream.close(); await f.close(); }
  });

  test(`${engine} S7 分页已完成但清理中取消仍不得发布目录`, { skip, timeout: 10_000 }, async () => {
    const f = await identityFixture(engine), service = createMcpConnections({ db: f.db });
    let hit!: () => void, release!: () => void;
    const deleting = new Promise<void>(resolve => { hit = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
    const upstream = await discoveryTestServer({ page: () => ({ tools: [discoveryTool("already-listed")] }), onDelete: async () => { hit(); await hold; } });
    try {
      const a = await service.create(access, { ...fields(upstream.endpoint), requestId: "a" }), controller = new AbortController();
      const pending = service.discover(access, a.connectionId, { requestId: "cancel-cleanup", expectedRevision: 1 }, controller.signal);
      await deleting; controller.abort(); release();
      assert.equal((await pending).status, "cancelled");
      assert.equal((await service.get(access, a.connectionId)).currentSnapshot, null);
    } finally { release(); await service.close(); await upstream.close(); await f.close(); }
  });

  test(`${engine} S7 提交通知等待窗口内停用、取消或关闭，释放通知后仍为零出站`, { skip, timeout: 15_000 }, async () => {
    for (const mode of ["disable", "cancel", "close"] as const) {
      const f = await identityFixture(engine), service = createMcpConnections({ db: f.db }), upstream = await discoveryTestServer();
      let release!: () => void, entered!: () => void, attemptId: string | undefined, replayStatus: string | undefined;
      const held = new Promise<void>(resolve => { release = resolve; }), notified = new Promise<void>(resolve => { entered = resolve; });
      const events: string[] = [];
      const stop = onMcpConnectionChange(f.db, async event => {
        events.push(event.kind);
        if (event.attemptId && attemptId === undefined) {
          attemptId = event.attemptId;
          replayStatus = (await service.discover(access, event.connectionId, { requestId: "paused", expectedRevision: 1 })).status;
          entered(); await held;
        }
      });
      try {
        const a = await service.create(access, { ...fields(upstream.endpoint), requestId: "a" });
        const pending = service.discover(access, a.connectionId, { requestId: "paused", expectedRevision: 1 });
        await notified; assert.equal(replayStatus, "running", "通知中幂等查询不得循环等待正在发布该通知的执行 promise"); assert.deepEqual(upstream.methods, []);
        let closing: Promise<void> | undefined;
        if (mode === "disable") await service.update(access, a.connectionId, { ...fields(upstream.endpoint), enabled: false, requestId: "disable", expectedRevision: 1 });
        else if (mode === "cancel") assert.equal((await service.cancel(access, a.connectionId, attemptId!)).status, "cancel_requested");
        else closing = service.close();
        release();
        const result = await pending; await closing;
        assert.equal(result.status, mode === "disable" ? "superseded" : "cancelled");
        assert.equal(result.cleanup, "not_opened");
        assert.deepEqual(upstream.methods, [], `${mode} 已停止的请求不得首次连接`); assert.equal(upstream.deletes, 0);
        assert.equal((await service.get(access, a.connectionId)).currentSnapshot, null);
        assert.equal(events.filter(kind => kind === "discovery.changed").length, mode === "cancel" ? 3 : 2, "保留全部提交后的发现通知");
      } finally { release(); stop(); await service.close(); await upstream.close(); await f.close(); }
    }
  });

  test(`${engine} S7 取消已提交但取消观察者仍等待时，原发现也不能首次连接`, { skip, timeout: 10_000 }, async () => {
    const f = await identityFixture(engine), service = createMcpConnections({ db: f.db }), upstream = await discoveryTestServer();
    let releaseStart!: () => void, releaseCancel!: () => void, enteredStart!: () => void, enteredCancel!: () => void;
    const startHeld = new Promise<void>(resolve => { releaseStart = resolve; }), cancelHeld = new Promise<void>(resolve => { releaseCancel = resolve; });
    const startNotified = new Promise<void>(resolve => { enteredStart = resolve; }), cancelNotified = new Promise<void>(resolve => { enteredCancel = resolve; });
    let changes = 0, attemptId: string | undefined;
    const stop = onMcpConnectionChange(f.db, async event => {
      if (!event.attemptId) return;
      if (++changes === 1) { attemptId = event.attemptId; enteredStart(); await startHeld; }
      else if (changes === 2) { enteredCancel(); await cancelHeld; }
    });
    try {
      const a = await service.create(access, { ...fields(upstream.endpoint), requestId: "a" });
      const pending = service.discover(access, a.connectionId, { requestId: "held", expectedRevision: 1 });
      await startNotified;
      const cancelling = service.cancel(access, a.connectionId, attemptId!);
      await cancelNotified;
      assert.equal((await service.attempt(access, a.connectionId, attemptId!)).status, "cancel_requested");
      releaseStart();
      assert.equal((await pending).status, "cancelled");
      assert.deepEqual(upstream.methods, []);
      releaseCancel(); await cancelling;
      assert.equal(changes, 3);
    } finally { releaseStart(); releaseCancel(); stop(); await service.close(); await upstream.close(); await f.close(); }
  });

  test(`${engine} S7 所有权预登记后的真实事务失败会释放请求，重试和关闭不遗留执行`, { skip, timeout: 10_000 }, async () => {
    const f = await identityFixture(engine), upstream = await discoveryTestServer();
    let failClock = false;
    const service = createMcpConnections({ db: f.db, now: () => { if (failClock) throw new Error("fixture_clock_failure"); return new Date(); } });
    const events: string[] = [], stop = onMcpConnectionChange(f.db, event => { events.push(event.kind); });
    try {
      const a = await service.create(access, { ...fields(upstream.endpoint), requestId: "a" });
      failClock = true;
      await assert.rejects(service.discover(access, a.connectionId, { requestId: "retry", expectedRevision: 1 }), /fixture_clock_failure/);
      assert.equal((await f.db.query("SELECT * FROM mcp_discovery_attempts")).length, 0);
      assert.deepEqual(upstream.methods, []); assert.equal(events.filter(kind => kind === "discovery.changed").length, 0);
      failClock = false;
      const completed = await service.discover(access, a.connectionId, { requestId: "retry", expectedRevision: 1 });
      assert.equal(completed.status, "succeeded");
      const calls = upstream.methods.length;
      assert.deepEqual(await service.discover(access, a.connectionId, { requestId: "retry", expectedRevision: 1 }), completed);
      assert.equal(upstream.methods.length, calls); assert.equal(upstream.deletes, 1);
      await service.close();
      assert.equal(events.filter(kind => kind === "discovery.changed").length, 2);
    } finally { failClock = false; stop(); await service.close(); await upstream.close(); await f.close(); }
  });

  test(`${engine} S7 成功、失败和取消终态通知可 await 幂等重放、取消与关闭而不自等待`, { skip, timeout: 15_000 }, async () => {
    for (const mode of ["succeeded", "discovery_failed", "cancelled"] as const) {
      const f = await identityFixture(engine), service = createMcpConnections({ db: f.db }), controller = new AbortController();
      const upstream = await discoveryTestServer({ page: () => {
        if (mode === "cancelled") controller.abort();
        return { tools: mode === "discovery_failed" ? "invalid" : [] };
      } });
      let replay: McpDiscoveryAttempt | undefined, cancelled: McpDiscoveryAttempt | undefined, observerError: unknown, closedInObserver = false, terminalEvents = 0;
      const stop = onMcpConnectionChange(f.db, async event => {
        if (!event.attemptId) return;
        try {
          const saved = await service.attempt(access, event.connectionId, event.attemptId);
          if (["running", "cancel_requested"].includes(saved.status)) return;
          terminalEvents++;
          replay = await service.discover(access, event.connectionId, { requestId: "same", expectedRevision: 1 });
          cancelled = await service.cancel(access, event.connectionId, event.attemptId);
          await service.close(); closedInObserver = true;
        } catch (error) { observerError = error; throw error; }
      });
      try {
        const a = await service.create(access, { ...fields(upstream.endpoint), requestId: "a" });
        const result = await service.discover(access, a.connectionId, { requestId: "same", expectedRevision: 1 }, controller.signal);
        assert.equal(observerError, undefined); assert.equal(result.status, mode); assert.deepEqual(replay, result); assert.deepEqual(cancelled, result);
        assert.equal(closedInObserver, true); assert.equal(terminalEvents, 1); assert.equal(upstream.deletes, 1);
        assert.deepEqual(upstream.methods.filter(method => !method.startsWith("notifications/")), ["initialize", "tools/list"]);
        assert.deepEqual((await service.get(access, a.connectionId)).lastDiscovery, result);
      } finally { stop(); await service.close(); await upstream.close(); await f.close(); }
    }
  });

  test(`${engine} S7 在途幂等重放继续等待原发现完成，不产生第二次连接`, { skip, timeout: 10_000 }, async () => {
    const f = await identityFixture(engine), service = createMcpConnections({ db: f.db });
    let entered!: () => void, release!: () => void;
    const arrived = new Promise<void>(resolve => { entered = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
    const upstream = await discoveryTestServer({ page: async () => { entered(); await hold; return { tools: [discoveryTool("one")] }; } });
    try {
      const a = await service.create(access, { ...fields(upstream.endpoint), requestId: "a" });
      const original = service.discover(access, a.connectionId, { requestId: "same", expectedRevision: 1 });
      await arrived;
      const replay = service.discover(access, a.connectionId, { requestId: "same", expectedRevision: 1 });
      release();
      const [first, second] = await Promise.all([original, replay]);
      assert.equal(first.status, "succeeded"); assert.deepEqual(second, first);
      assert.equal(upstream.listRequests, 1); assert.equal(upstream.deletes, 1);
    } finally { release(); await service.close(); await upstream.close(); await f.close(); }
  });

  test(`${engine} S7 终态观察者关闭仍等待其他自有连接的真实清理和终态提交`, { skip, timeout: 10_000 }, async () => {
    const f = await identityFixture(engine), service = createMcpConnections({ db: f.db });
    let listed!: () => void, deleting!: () => void, releaseDelete!: () => void, releasePage!: () => void;
    const pageArrived = new Promise<void>(resolve => { listed = resolve; }), deleteArrived = new Promise<void>(resolve => { deleting = resolve; });
    const pageHeld = new Promise<void>(resolve => { releasePage = resolve; }), deleteHeld = new Promise<void>(resolve => { releaseDelete = resolve; });
    const slow = await discoveryTestServer({ page: async () => { listed(); await pageHeld; return { tools: [] }; }, onDelete: async () => { deleting(); await deleteHeld; } });
    const fast = await discoveryTestServer();
    let fastId: string | undefined, closedInObserver = false, observerError: unknown;
    const stop = onMcpConnectionChange(f.db, async event => {
      if (event.connectionId !== fastId || !event.attemptId) return;
      try {
        if ((await service.attempt(access, fastId, event.attemptId)).status !== "succeeded") return;
        await service.close(); closedInObserver = true;
      } catch (error) { observerError = error; throw error; }
    });
    try {
      const a = await service.create(access, { ...fields(slow.endpoint), requestId: "slow" });
      const b = await service.create(access, { ...fields(fast.endpoint), requestId: "fast" }); fastId = b.connectionId;
      const pendingSlow = service.discover(access, a.connectionId, { requestId: "slow-discover", expectedRevision: 1 });
      await pageArrived;
      const pendingFast = service.discover(access, b.connectionId, { requestId: "fast-discover", expectedRevision: 1 });
      await deleteArrived;
      assert.equal(closedInObserver, false, "对端尚未确认DELETE时不能声称所有自有资源收尾");
      releaseDelete(); releasePage();
      const [first, second] = await Promise.all([pendingSlow, pendingFast]);
      assert.equal(observerError, undefined); assert.equal(closedInObserver, true);
      assert.equal(first.status, "cancelled"); assert.equal(first.cleanup, "closed"); assert.equal(second.status, "succeeded");
      assert.deepEqual((await service.get(access, a.connectionId)).lastDiscovery, first);
      assert.equal(slow.deletes, 1); assert.equal(fast.deletes, 1);
    } finally { releaseDelete(); releasePage(); stop(); await service.close(); await slow.close(); await fast.close(); await f.close(); }
  });

  test(`${engine} S7 起始通知内 await close 能持久化未出站取消，不等待未来执行形成环`, { skip, timeout: 10_000 }, async () => {
    const f = await identityFixture(engine), service = createMcpConnections({ db: f.db }), upstream = await discoveryTestServer();
    let first = true, closedInObserver = false, changes = 0, observerError: unknown;
    const stop = onMcpConnectionChange(f.db, async event => {
      if (!event.attemptId) return;
      changes++;
      if (!first) return;
      first = false;
      try { await service.close(); closedInObserver = true; }
      catch (error) { observerError = error; throw error; }
    });
    try {
      const a = await service.create(access, { ...fields(upstream.endpoint), requestId: "a" });
      const result = await service.discover(access, a.connectionId, { requestId: "close-in-start", expectedRevision: 1 });
      assert.equal(observerError, undefined); assert.equal(closedInObserver, true);
      assert.equal(result.status, "cancelled"); assert.equal(result.cleanup, "not_opened");
      assert.deepEqual(upstream.methods, []); assert.equal(upstream.deletes, 0); assert.equal(changes, 2);
      assert.deepEqual((await service.get(access, a.connectionId)).lastDiscovery, result);
    } finally { stop(); await service.close(); await upstream.close(); await f.close(); }
  });
}

test("sqlite S7 起始通知关闭时真实 COMMIT 失败不发布终态，不把资源drain当作已取消成功", { timeout: 10_000 }, async () => {
  const f = await identityFixture(), service = createMcpConnections({ db: f.db }), upstream = await discoveryTestServer();
  const handle = (f.db as SqliteDriver).handle;
  let bodyReached = false, closedInObserver = false, changes = 0;
  handle.function("s7_terminal_body_reached", () => { bodyReached = true; return 1; });
  handle.exec(`CREATE TEMP TRIGGER s7_fail_terminal_commit AFTER UPDATE OF status ON main.mcp_discovery_attempts
    WHEN NEW.status='cancelled' BEGIN
      INSERT INTO mcp_catalog_heads(connection_id,connection_revision,snapshot_id) VALUES('missing-fixture-connection',1,'missing-fixture-snapshot');
      SELECT s7_terminal_body_reached();
    END`);
  const stop = onMcpConnectionChange(f.db, async event => {
    if (!event.attemptId) return;
    changes++;
    // 仅测试连接的真实故障装配：延迟全部FK检查，使事务体走完而COMMIT失败。
    handle.pragma("defer_foreign_keys = ON");
    await service.close(); closedInObserver = true;
  });
  try {
    const a = await service.create(access, { ...fields(upstream.endpoint), requestId: "a" });
    await assert.rejects(service.discover(access, a.connectionId, { requestId: "failed-commit", expectedRevision: 1 }), /mcp_discovery_result_not_persisted/);
    assert.equal(bodyReached, true, "不是事务体内立即拒绝；必须走到真实COMMIT约束失败");
    assert.equal(closedInObserver, true); assert.equal(changes, 1, "失败COMMIT不发终态成功通知");
    const current = await service.get(access, a.connectionId);
    assert.equal(current.lastDiscovery!.status, "running"); assert.equal(current.lastDiscovery!.cleanup, "pending");
    assert.equal(current.lastDiscovery!.finishedAt, null); assert.equal(current.currentSnapshot, null);
    assert.deepEqual(upstream.methods, []); assert.equal((await f.db.query("SELECT * FROM mcp_catalog_heads")).length, 0);
  } finally { stop(); handle.exec("DROP TRIGGER s7_fail_terminal_commit"); await service.close(); await upstream.close(); await f.close(); }
});

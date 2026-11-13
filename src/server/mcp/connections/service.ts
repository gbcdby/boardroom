import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbDriver, DbReadSnapshot, DbRow } from "../../db/driver.ts";
import { afterCommit } from "../../db/after-commit.ts";
import { requireCatalogUser, type CatalogAccess } from "../../identity/catalog.ts";
import { inspectMcpConnection, readMcpConnectionDeclaration, readToolCatalogSnapshot, opaqueIdSchema,
  type ConnectionProjection, type McpConnectionDeclaration, type ToolCatalogSnapshot } from "../capabilities/catalog.ts";
import { canonicalJson, cloneJson, digestJson, freezeData } from "../capabilities/json.ts";
import { discoverMcpCatalog, type McpDiscoveryResult } from "./discovery.ts";
import { McpConnectionError, McpDiscoveryFailure, type DiscoveryCleanup, type DiscoveryFailureState } from "./errors.ts";

const requestId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const fields = { name: z.string().trim().min(1).max(128).refine(value => !/[\u0000-\u001f\u007f]/.test(value)),
  enabled: z.boolean(), transport: z.unknown() };
const createInput = z.object({ requestId, ...fields }).strict();
const updateInput = createInput.extend({ expectedRevision: revision.max(Number.MAX_SAFE_INTEGER - 1) });
const discoverInput = z.object({ requestId, expectedRevision: revision }).strict();

type ConnectionRow = DbRow & { id: string; revision: number; discovery_sequence: number; created_at: string; updated_at: string };
type VersionRow = DbRow & { name: string; configuration_json: string; configuration_digest: string; created_at: string };
type AttemptStatus = "running" | "cancel_requested" | "succeeded" | DiscoveryFailureState | "superseded";
type AttemptRow = DbRow & { id: string; request_id: string; input_digest: string; connection_id: string;
  connection_revision: number; sequence: number; owner_id: string; status: AttemptStatus; error_code: string | null;
  snapshot_id: string | null; cleanup: DiscoveryCleanup | "pending"; protocol_version: string | null;
  page_count: number | null; created_at: string; finished_at: string | null };

export interface McpConnectionReceipt extends ConnectionProjection {
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface McpDiscoveryAttempt {
  readonly attemptId: string;
  readonly connectionId: string;
  readonly connectionRevision: number;
  readonly sequence: number;
  readonly status: AttemptStatus;
  readonly errorCode: string | null;
  readonly snapshotId: string | null;
  readonly cleanup: DiscoveryCleanup | "pending";
  readonly protocolVersion: string | null;
  readonly pages: number | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}
export interface McpConnectionView {
  readonly connection: McpConnectionReceipt;
  readonly state: "registered" | "discovered" | "disabled";
  readonly modelState: "not_provided";
  readonly currentSnapshot: ToolCatalogSnapshot | null;
  readonly lastDiscovery: McpDiscoveryAttempt | null;
}
export interface McpConnectionChange {
  readonly kind: "connection.saved" | "discovery.changed";
  readonly connectionId: string;
  readonly revision: number;
  readonly attemptId?: string;
  readonly snapshotId?: string;
}
const subscriptions = new WeakMap<DbDriver, Set<(event: McpConnectionChange) => void | Promise<void>>>();
/** 仅可信本地管理消费者订阅全局领域提示；不扩展项目ResourceChange或WebSocket权限。 */
export function onMcpConnectionChange(db: DbDriver, listener: (event: McpConnectionChange) => void | Promise<void>): () => void {
  const listeners = subscriptions.get(db) ?? new Set(); subscriptions.set(db, listeners); listeners.add(listener);
  return () => { listeners.delete(listener); };
}
async function notify(db: DbDriver, event: McpConnectionChange): Promise<void> {
  const frozen = freezeData(event);
  for (const listener of subscriptions.get(db) ?? []) await afterCommit(db, () => listener(frozen));
}
function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(cloneJson(input));
  if (!result.success) throw new McpConnectionError("mcp_connection_input_invalid");
  return result.data;
}
function attemptView(row: AttemptRow): McpDiscoveryAttempt {
  return freezeData({ attemptId: row.id, connectionId: row.connection_id, connectionRevision: Number(row.connection_revision),
    sequence: Number(row.sequence), status: row.status, errorCode: row.error_code, snapshotId: row.snapshot_id,
    cleanup: row.cleanup, protocolVersion: row.protocol_version, pages: row.page_count === null ? null : Number(row.page_count),
    createdAt: row.created_at, finishedAt: row.finished_at });
}

export function createMcpConnections(options: { db: DbDriver; now?: () => Date; discoveryTimeoutMs?: number }) {
  const { db } = options, now = options.now ?? (() => new Date()), ownerId = randomUUID();
  type OwnedDiscovery = { connectionId: string; revision: number; controller: AbortController; signal: AbortSignal;
    stage: "registering" | "admitted" | "executing" | "settling"; row?: AttemptRow;
    promise?: Promise<McpDiscoveryAttempt>; stoppedBeforeStart?: Promise<McpDiscoveryAttempt>;
    drained: Promise<void>; releaseDrain: () => void };
  const owned = new Map<string, OwnedDiscovery>();
  let closed = false;
  function open() { if (closed) throw new McpConnectionError("mcp_connections_closed", 409); }
  function checkedId(value: string) { return parse(opaqueIdSchema, value); }
  async function head(query: DbReadSnapshot, id: string): Promise<ConnectionRow> {
    const row = (await query.query<ConnectionRow>("SELECT * FROM mcp_connections WHERE id = ?", [id]))[0];
    if (!row) throw new McpConnectionError("mcp_connection_not_found", 404); return row;
  }
  async function configurationRow(query: DbReadSnapshot, id: string, rev: number): Promise<{ row: VersionRow; declaration: McpConnectionDeclaration }> {
    const row = (await query.query<VersionRow>("SELECT * FROM mcp_connection_versions WHERE connection_id = ? AND revision = ?", [id, rev]))[0];
    if (!row) throw new McpConnectionError("mcp_connection_version_not_found", 404);
    const declaration = readMcpConnectionDeclaration(JSON.parse(row.configuration_json));
    if (declaration.connectionId !== id || declaration.revision !== rev || inspectMcpConnection(declaration).configurationDigest !== row.configuration_digest)
      throw new McpConnectionError("mcp_connection_integrity_failed", 409);
    return { row, declaration };
  }
  async function lock(id: string): Promise<ConnectionRow> {
    if (!await db.exec("UPDATE mcp_connections SET updated_at = updated_at WHERE id = ?", [id])) throw new McpConnectionError("mcp_connection_not_found", 404);
    return head(db, id);
  }
  async function receipt(query: DbReadSnapshot, row: ConnectionRow): Promise<McpConnectionReceipt> {
    const version = await configurationRow(query, row.id, Number(row.revision));
    return freezeData({ ...inspectMcpConnection(version.declaration), name: version.row.name, createdAt: row.created_at, updatedAt: row.updated_at });
  }
  async function view(query: DbReadSnapshot, id: string): Promise<McpConnectionView> {
    const row = await head(query, id), connection = await receipt(query, row);
    const found = (await query.query<{ snapshot_json: string }>(`SELECT s.snapshot_json FROM mcp_catalog_heads h JOIN mcp_catalog_snapshots s ON s.id = h.snapshot_id
      WHERE h.connection_id = ? AND h.connection_revision = ?`, [id, connection.revision]))[0];
    const snapshot = found ? readToolCatalogSnapshot(JSON.parse(found.snapshot_json)) : null;
    if (snapshot && (snapshot.connection.configurationDigest !== connection.configurationDigest || snapshot.connection.revision !== connection.revision))
      throw new McpConnectionError("mcp_catalog_integrity_failed", 409);
    const attempt = (await query.query<AttemptRow>("SELECT * FROM mcp_discovery_attempts WHERE connection_id = ? ORDER BY sequence DESC LIMIT 1", [id]))[0];
    return freezeData({ connection, state: !connection.enabled ? "disabled" : snapshot ? "discovered" : "registered",
      modelState: "not_provided", currentSnapshot: snapshot, lastDiscovery: attempt ? attemptView(attempt) : null });
  }
  async function consistent<T>(body: (query: DbReadSnapshot) => Promise<T>): Promise<T> {
    return db.currentTransactionContext() ? body(db) : db.readSnapshot(body);
  }
  async function versionWrite(declaration: McpConnectionDeclaration, name: string, at: string): Promise<void> {
    await db.exec(`INSERT INTO mcp_connection_versions(connection_id,revision,name,configuration_json,configuration_digest,created_at)
      VALUES(?,?,?,?,?,?)`, [declaration.connectionId, declaration.revision, name, canonicalJson(declaration), inspectMcpConnection(declaration).configurationDigest, at]);
  }
  async function mutation(request: string, digest: string, body: () => Promise<McpConnectionReceipt>): Promise<McpConnectionReceipt> {
    return db.transaction(async () => {
      const inserted = await db.exec(`INSERT INTO mcp_connection_mutations(request_id,input_digest,created_at) VALUES(?,?,?)
        ON CONFLICT(request_id) DO NOTHING`, [request, digest, now().toISOString()]);
      if (!inserted) {
        const saved = (await db.query<{ input_digest: string; result_json: string | null }>("SELECT input_digest,result_json FROM mcp_connection_mutations WHERE request_id = ?", [request]))[0]!;
        if (saved.input_digest !== digest) throw new McpConnectionError("mcp_request_conflict", 409);
        if (!saved.result_json) throw new McpConnectionError("mcp_request_incomplete", 409);
        return freezeData(JSON.parse(saved.result_json) as McpConnectionReceipt);
      }
      const result = await body();
      await db.exec("UPDATE mcp_connection_mutations SET connection_id = ?, result_json = ? WHERE request_id = ?", [result.connectionId, canonicalJson(result), request]);
      await notify(db, { kind: "connection.saved", connectionId: result.connectionId, revision: result.revision });
      return result;
    });
  }
  async function readAttempt(id: string): Promise<AttemptRow> {
    const row = (await db.query<AttemptRow>("SELECT * FROM mcp_discovery_attempts WHERE id = ?", [id]))[0];
    if (!row) throw new McpConnectionError("mcp_discovery_not_found", 404); return row;
  }
  async function finish(attempt: AttemptRow, result: McpDiscoveryResult | undefined, failure: McpDiscoveryFailure | undefined,
    signal: AbortSignal, onPersisted: () => void): Promise<McpDiscoveryAttempt> {
    return db.transaction(async () => {
      // 这里只在终态 COMMIT 成功后释放：观察者可以关闭资源，不必等待正在发布它的响应 promise。
      await afterCommit(db, onPersisted);
      const current = await lock(attempt.connection_id), pending = await readAttempt(attempt.id);
      if (!["running", "cancel_requested"].includes(pending.status)) return attemptView(pending);
      let status: AttemptStatus = failure?.state ?? "succeeded", errorCode: string | null = failure?.code ?? null;
      if (Number(current.revision) !== Number(attempt.connection_revision) || Number(current.discovery_sequence) !== Number(attempt.sequence)) {
        status = "superseded"; errorCode = "mcp_connection_changed";
      } else if (pending.status === "cancel_requested" || closed || signal.aborted) { status = "cancelled"; errorCode = "discovery_cancelled"; }
      let snapshotId: string | null = null;
      if (status === "succeeded" && result) {
        snapshotId = result.snapshot.snapshotDigest;
        await db.exec(`INSERT INTO mcp_catalog_snapshots(id,connection_id,connection_revision,snapshot_json,observed_at) VALUES(?,?,?,?,?)
          ON CONFLICT(id) DO NOTHING`, [snapshotId, attempt.connection_id, attempt.connection_revision, canonicalJson(result.snapshot), result.snapshot.observedAt]);
        await db.exec(`INSERT INTO mcp_catalog_heads(connection_id,connection_revision,snapshot_id) VALUES(?,?,?)
          ON CONFLICT(connection_id,connection_revision) DO UPDATE SET snapshot_id = excluded.snapshot_id`,
          [attempt.connection_id, attempt.connection_revision, snapshotId]);
      }
      await db.exec(`UPDATE mcp_discovery_attempts SET status=?,error_code=?,snapshot_id=?,cleanup=?,protocol_version=?,page_count=?,finished_at=? WHERE id=?`,
        [status, errorCode, snapshotId, result?.cleanup ?? failure?.cleanup ?? "remote_unknown", result?.protocolVersion ?? null, result?.pages ?? null, now().toISOString(), attempt.id]);
      await notify(db, { kind: "discovery.changed", connectionId: attempt.connection_id, revision: Number(attempt.connection_revision),
        attemptId: attempt.id, ...(snapshotId ? { snapshotId } : {}) });
      return attemptView(await readAttempt(attempt.id));
    });
  }
  function stopBeforeStart(reservation: OwnedDiscovery): void {
    if (reservation.stage !== "admitted" || !reservation.row) return;
    reservation.stage = "settling";
    // start 通知可 await close；尚未出站时由关闭路径持久化停止，不能等通知之后才会发生的执行。
    const stopped = finish(reservation.row, undefined, new McpDiscoveryFailure("discovery_cancelled", "cancelled", "not_opened"),
      reservation.signal, reservation.releaseDrain).catch(() => { throw new McpConnectionError("mcp_discovery_result_not_persisted", 409); });
    reservation.stoppedBeforeStart = stopped;
    // 失败也已无外部资源；错误保留给原请求，不伪造已提交终态。为被通知阻塞的原请求暂时接住 rejection。
    void stopped.then(reservation.releaseDrain, reservation.releaseDrain);
  }

  const service = {
    async create(access: CatalogAccess, input: unknown): Promise<McpConnectionReceipt> {
      requireCatalogUser(access); open(); const value = parse(createInput, input);
      const digest = digestJson({ kind: "create", value });
      // Validate before any durable request is claimed; configuration save never connects or executes argv.
      const declaration = readMcpConnectionDeclaration({ connectionId: randomUUID(), revision: 1, enabled: value.enabled, transport: value.transport });
      return mutation(value.requestId, digest, async () => {
        const at = now().toISOString();
        await db.exec("INSERT INTO mcp_connections(id,revision,discovery_sequence,created_at,updated_at) VALUES(?,1,0,?,?)", [declaration.connectionId, at, at]);
        await versionWrite(declaration, value.name, at); return receipt(db, await head(db, declaration.connectionId));
      });
    },
    async update(access: CatalogAccess, id: string, input: unknown): Promise<McpConnectionReceipt> {
      requireCatalogUser(access); open(); checkedId(id); const value = parse(updateInput, input);
      const declaration = readMcpConnectionDeclaration({ connectionId: id, revision: value.expectedRevision + 1, enabled: value.enabled, transport: value.transport });
      return mutation(value.requestId, digestJson({ kind: "update", id, value }), async () => {
        const before = await lock(id);
        if (Number(before.revision) !== value.expectedRevision) throw new McpConnectionError("mcp_connection_revision_conflict", 409);
        const at = now().toISOString();
        await db.exec("UPDATE mcp_connections SET revision = ?, updated_at = ? WHERE id = ?", [declaration.revision, at, id]);
        await versionWrite(declaration, value.name, at);
        await afterCommit(db, () => { for (const running of owned.values()) if (running.connectionId === id && running.revision !== declaration.revision) running.controller.abort(); });
        return receipt(db, await head(db, id));
      });
    },
    async get(access: CatalogAccess, id: string): Promise<McpConnectionView> {
      requireCatalogUser(access); checkedId(id); return consistent(query => view(query, id));
    },
    async list(access: CatalogAccess): Promise<readonly McpConnectionView[]> {
      requireCatalogUser(access); return consistent(async query => {
        const rows = await query.query<{ id: string }>("SELECT id FROM mcp_connections ORDER BY id LIMIT 4097");
        if (rows.length > 4096) throw new McpConnectionError("mcp_connection_list_limit", 409);
        const values: McpConnectionView[] = []; for (const row of rows) values.push(await view(query, row.id)); return freezeData(values);
      });
    },
    async configuration(access: CatalogAccess, id: string, rev: number): Promise<McpConnectionDeclaration> {
      requireCatalogUser(access); checkedId(id); parse(revision, rev); return (await configurationRow(db, id, rev)).declaration;
    },
    async snapshot(access: CatalogAccess, id: string, digest: string): Promise<ToolCatalogSnapshot> {
      requireCatalogUser(access); checkedId(id); parse(z.string().regex(/^[0-9a-f]{64}$/), digest);
      const row = (await db.query<{ snapshot_json: string }>("SELECT snapshot_json FROM mcp_catalog_snapshots WHERE id = ? AND connection_id = ?", [digest, id]))[0];
      if (!row) throw new McpConnectionError("mcp_catalog_not_found", 404); return readToolCatalogSnapshot(JSON.parse(row.snapshot_json));
    },
    async attempt(access: CatalogAccess, id: string, attemptId: string): Promise<McpDiscoveryAttempt> {
      requireCatalogUser(access); checkedId(id); checkedId(attemptId); const row = await readAttempt(attemptId);
      if (row.connection_id !== id) throw new McpConnectionError("mcp_discovery_not_found", 404); return attemptView(row);
    },
    discover(access: CatalogAccess, id: string, input: unknown, signal?: AbortSignal): Promise<McpDiscoveryAttempt> {
      return executeDiscovery(access, id, input, signal);
    },
    async cancel(access: CatalogAccess, id: string, attemptId: string): Promise<McpDiscoveryAttempt> {
      requireCatalogUser(access); checkedId(id); checkedId(attemptId);
      return db.transaction(async () => {
        await lock(id); const row = await readAttempt(attemptId);
        if (row.connection_id !== id) throw new McpConnectionError("mcp_discovery_not_found", 404);
        if (row.status === "running") {
          await db.exec("UPDATE mcp_discovery_attempts SET status = 'cancel_requested' WHERE id = ?", [attemptId]);
          await afterCommit(db, () => { owned.get(attemptId)?.controller.abort(); });
          await notify(db, { kind: "discovery.changed", connectionId: id, revision: Number(row.connection_revision), attemptId });
        }
        return attemptView(await readAttempt(attemptId));
      });
    },
    async close(): Promise<void> {
      closed = true;
      const pending = [...owned.values()];
      for (const running of pending) { running.controller.abort(); stopBeforeStart(running); }
      await Promise.allSettled(pending.map(running => running.drained));
    },
  };
  async function executeDiscovery(access: CatalogAccess, id: string, input: unknown, signal?: AbortSignal): Promise<McpDiscoveryAttempt> {
      requireCatalogUser(access); open(); checkedId(id); const value = parse(discoverInput, input);
      if (db.currentTransactionContext()) throw new McpConnectionError("mcp_discovery_requires_own_transaction", 409);
      const digest = digestJson({ kind: "discover", id, value });
      const attemptId = randomUUID(), controller = new AbortController();
      const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
      let releaseDrain!: () => void;
      const drained = new Promise<void>(resolve => { releaseDrain = resolve; });
      const reservation: OwnedDiscovery = { connectionId: id, revision: value.expectedRevision, controller, signal: combined,
        stage: "registering", drained, releaseDrain };
      // 先归属取消控制，再进入登记事务；COMMIT 后的异步观察者等待不能留下尚未出站的停止空档。
      // 此时没有外部连接，也没有执行 promise，通知中幂等查询仍可立即取得持久 running 记录。
      owned.set(attemptId, reservation);
      try {
      const start = await db.transaction(async () => {
        const current = await lock(id);
        const previous = (await db.query<AttemptRow>("SELECT * FROM mcp_discovery_attempts WHERE request_id = ?", [value.requestId]))[0];
        if (previous) {
          if (previous.input_digest !== digest) throw new McpConnectionError("mcp_request_conflict", 409);
          return { row: previous, declaration: null };
        }
        if (Number(current.revision) !== value.expectedRevision) throw new McpConnectionError("mcp_connection_revision_conflict", 409);
        const sequence = Number(current.discovery_sequence) + 1;
        if (!Number.isSafeInteger(sequence)) throw new McpConnectionError("mcp_discovery_sequence_exhausted", 409);
        const { declaration } = await configurationRow(db, id, value.expectedRevision);
        const inserted = await db.exec(`INSERT INTO mcp_discovery_attempts(id,request_id,input_digest,connection_id,connection_revision,sequence,owner_id,status,cleanup,created_at)
          VALUES(?,?,?,?,?,?,?,'running','pending',?) ON CONFLICT(request_id) DO NOTHING`,
          [attemptId, value.requestId, digest, id, value.expectedRevision, sequence, ownerId, now().toISOString()]);
        if (!inserted) {
          const previous = (await db.query<AttemptRow>("SELECT * FROM mcp_discovery_attempts WHERE request_id = ?", [value.requestId]))[0]!;
          if (previous.input_digest !== digest) throw new McpConnectionError("mcp_request_conflict", 409);
          return { row: previous, declaration: null };
        }
        await db.exec("UPDATE mcp_connections SET discovery_sequence = ? WHERE id = ?", [sequence, id]);
        const row = await readAttempt(attemptId);
        await afterCommit(db, () => {
          reservation.row = row; reservation.stage = "admitted";
          if (closed) stopBeforeStart(reservation);
        });
        await notify(db, { kind: "discovery.changed", connectionId: id, revision: value.expectedRevision, attemptId });
        return { row, declaration };
      });
      if (!start.declaration) {
        if (!["running", "cancel_requested"].includes(start.row.status)) return attemptView(start.row);
        return owned.get(start.row.id)?.promise ?? attemptView(start.row);
      }
      if (reservation.stoppedBeforeStart) return await reservation.stoppedBeforeStart;
      if (closed) controller.abort();
      reservation.stage = "executing";
      const promise = (async () => {
        let result: McpDiscoveryResult | undefined, failure: McpDiscoveryFailure | undefined;
        try { result = await discoverMcpCatalog(start.declaration, { signal: combined, now,
          ...(options.discoveryTimeoutMs === undefined ? {} : { timeoutMs: options.discoveryTimeoutMs }) }); }
        catch (error) { failure = error instanceof McpDiscoveryFailure ? error : new McpDiscoveryFailure("discovery_failed", "discovery_failed", "remote_unknown"); }
        reservation.stage = "settling";
        try { return await finish(start.row, result, failure, combined, releaseDrain); }
        catch { throw new McpConnectionError("mcp_discovery_result_not_persisted", 409); }
      })();
      reservation.promise = promise;
      return await promise;
      } finally { owned.delete(attemptId); releaseDrain(); }
  }
  return service;
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { DbDriver } from "../src/server/db/driver.ts";
import type { RepositorySet } from "../src/server/db/repositories.ts";
import { WriteFailedError } from "../src/server/db/errors.ts";
import { DEFAULT_MEMORY_CONFIG } from "../src/server/config.ts";
import { digestJson } from "../src/server/storage/maintenance/canonical.ts";
import type { MemoryKey } from "../src/shared/memory.ts";
import {
  createDurableHeadCommitter, durableGateErrorReason, durableHeadValue, durableWritePlan, virtualZeroDurableHead,
} from "../src/server/memory/durable-head-commit.ts";
import type { DurableHeadCommitInput, DurableHeadCommitter } from "../src/server/memory/durable-head-commit.ts";
import { createMemoryObjectStore, getMemoryObjectStoreErrorCode } from "../src/server/memory/object-store.ts";
import type { MemoryObjectStore } from "../src/server/memory/object-store.ts";
import { memoryObjectRelativeKey } from "../src/server/memory/object-ref.ts";
import { createMemoryService } from "../src/server/memory/service.ts";
import type { MemoryAccess } from "../src/server/memory/service.ts";
import { memoryFixture, memoryPeople, pgUnavailable } from "./helpers/memory-fixture.ts";

const platformTest = ["linux", "darwin"].includes(process.platform) ? test : test.skip;
const storageId = "memory-durable-commit-test";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

type People = Awaited<ReturnType<typeof memoryPeople>>;
type Service = ReturnType<typeof createMemoryService>;
interface Harness {
  repos: RepositorySet;
  db: DbDriver;
  service: Service;
  store: MemoryObjectStore;
  committer: DurableHeadCommitter;
  root: string;
  people: People;
  key: MemoryKey;
}

async function harness(engine: "sqlite" | "postgres", run: (h: Harness) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(process.cwd(), "memory-durable-commit-"));
  try {
    const store = await createMemoryObjectStore({ root, storageId });
    await memoryFixture(async (repos, db) => {
      const people = await memoryPeople(repos);
      const key: MemoryKey = { scope: "project", projectId: people.project.id, agentId: null };
      const service = createMemoryService({ repos, config: DEFAULT_MEMORY_CONFIG, injectionReader: {
        readOwn: async () => ({ state: "available" as const, entries: [], errors: [], maxBytes: DEFAULT_MEMORY_CONFIG.maxInjectedBytes }),
        close: async () => {},
      }, readVisibleMessages: async () => [], objectStore: store });
      const committer = createDurableHeadCommitter({ repos, store, config: DEFAULT_MEMORY_CONFIG });
      await run({ repos, db, service, store, committer, root, people, key });
    }, engine);
  } finally { await rm(root, { recursive: true, force: true }); }
}

function commitInput(h: Harness, markdown: string, clientMutationId: string, expectedVersion: number, at: string): DurableHeadCommitInput {
  const actor = h.people.owner.actor;
  return { key: h.key, markdown, expectedVersion, clientMutationId, actor,
    author: { kind: "human", actorId: actor.actorId, agentId: null, displayName: "人（owner）" },
    at, source: "human" };
}
function receiptOf(documentId: string, dbVersion: number, actorId: string, clientMutationId: string, contentSha256: string): string {
  return digestJson({ documentId, dbVersion, actorId, clientMutationId, contentSha256 });
}
async function count(db: DbDriver, table: string): Promise<number> {
  return Number((await db.query(`SELECT COUNT(*) AS n FROM ${table}`))[0]!["n"]);
}
async function refRows(db: DbDriver) {
  return db.query<Record<string, unknown>>("SELECT * FROM memory_object_refs ORDER BY version");
}
async function exists(file: string): Promise<boolean> {
  try { await stat(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function memoryAudit(h: Harness) {
  return h.repos.audit.list(h.people.project.id).then(rows => rows.filter(row => row.action === "memory.updated"));
}

for (const engine of ["sqlite", "postgres"] as const) {
  platformTest(`${engine} DURABLE-COMMIT: 首次/第二次 durable 写、head 推导、对象/ref/audit 与旧版本拒绝`,
    { skip: engine === "postgres" ? pgUnavailable : false }, async () => harness(engine, async h => {
      const actorId = h.people.owner.actor.actorId;
      const body1 = "# 第一版\n中文与 emoji 😀\n";
      const body2 = "# 第二版\n第二次提交\n";
      const first = await h.service.writeDurable(h.people.owner, h.key,
        { expectedVersion: 0, clientMutationId: "durable-1", markdown: body1 });
      assert.equal(first.duplicate, false);
      assert.equal(first.document.version, 1);
      assert.equal(first.decision.outcome, "commit-allowed");
      assert.equal(first.decision.head.version, 2, "DB version 1 projects to head version 2");
      assert.equal(first.decision.head.receipt,
        receiptOf(first.document.id, 1, actorId, "durable-1", sha(body1)));
      assert.deepEqual(await readFile(path.join(h.root, memoryObjectRelativeKey(first.ref))), Buffer.from(body1, "utf8"));
      assert.equal(await h.store.read(first.ref), body1);
      const firstRefs = await refRows(h.db);
      assert.equal(firstRefs.length, 1);
      assert.equal(firstRefs[0]!["document_id"], first.document.id);
      assert.equal(firstRefs[0]!["version"], 1);
      assert.equal(firstRefs[0]!["scope"], "project");
      assert.equal(firstRefs[0]!["project_id"], h.people.project.id);
      assert.equal(firstRefs[0]!["agent_id"], null);
      assert.equal(firstRefs[0]!["document_kind"], "note");
      assert.equal(firstRefs[0]!["body_storage_id"], storageId);
      assert.equal(firstRefs[0]!["body_object_format"], "utf8-sha256-v1");
      assert.equal(firstRefs[0]!["body_content_sha256"], sha(body1));
      assert.equal(firstRefs[0]!["byte_length"], Buffer.byteLength(body1, "utf8"));
      const firstAudits = await memoryAudit(h);
      assert.equal(firstAudits.length, 1);
      const firstDetail = JSON.parse(String(firstAudits[0]!.detail)) as Record<string, unknown>;
      assert.equal(firstDetail["receipt"], first.decision.head.receipt);
      assert.deepEqual(firstDetail["head"], first.decision.head);

      const second = await h.service.writeDurable(h.people.owner, h.key,
        { expectedVersion: 1, clientMutationId: "durable-2", markdown: body2 });
      assert.equal(second.document.version, 2, "DB version advances 1→2");
      assert.equal(second.decision.outcome, "commit-allowed");
      assert.equal(second.decision.head.version, 3);
      assert.notEqual(second.decision.head.receipt, first.decision.head.receipt);
      assert.equal(second.decision.head.receipt,
        receiptOf(second.document.id, 2, actorId, "durable-2", sha(body2)));
      assert.deepEqual((await refRows(h.db)).map(row => row["version"]), [1, 2]);
      assert.equal((await memoryAudit(h)).length, 2);
      assert.equal((await h.service.read(h.people.owner, h.key)).document?.markdown, body2);

      const before = await refRows(h.db);
      await assert.rejects(h.service.writeDurable(h.people.owner, h.key,
        { expectedVersion: 0, clientMutationId: "stale", markdown: "旧基准" }), { reason: "memory_version_conflict" });
      assert.deepEqual(await refRows(h.db), before);
      assert.equal((await h.service.read(h.people.owner, h.key)).version, 2);
      assert.equal((await memoryAudit(h)).length, 2);
    }));

  platformTest(`${engine} DURABLE-COMMIT: 同 mutation 同内容重放返回原版本，异内容受控拒绝且无新增行`,
    { skip: engine === "postgres" ? pgUnavailable : false }, async () => harness(engine, async h => {
      const body = "# 幂等正文\n";
      const first = await h.service.writeDurable(h.people.owner, h.key,
        { expectedVersion: 0, clientMutationId: "same-mutation", markdown: body });
      const replay = await h.service.writeDurable(h.people.owner, h.key,
        { expectedVersion: 0, clientMutationId: "same-mutation", markdown: body });
      assert.equal(replay.duplicate, true);
      assert.equal(replay.decision.outcome, "already-committed");
      assert.equal(replay.writtenVersion.version, 1);
      assert.equal(replay.writtenVersion.version, first.writtenVersion.version);
      assert.deepEqual(replay.ref, first.ref);
      assert.equal((await h.service.read(h.people.owner, h.key)).version, 1);
      assert.equal((await refRows(h.db)).length, 1);

      await assert.rejects(h.service.writeDurable(h.people.owner, h.key,
        { expectedVersion: 1, clientMutationId: "same-mutation", markdown: "同标识不同正文" }),
      { reason: "memory_mutation_conflict" });
      assert.equal((await h.service.read(h.people.owner, h.key)).version, 1);
      assert.equal((await refRows(h.db)).length, 1);
      assert.equal(await count(h.db, "memory_versions"), 1);
      assert.equal((await memoryAudit(h)).length, 1);
    }));

  platformTest(`${engine} DURABLE-COMMIT: gate 直测四类拒绝，commit 映射稳定原因且拒绝时无 DB 写`,
    { skip: engine === "postgres" ? pgUnavailable : false }, async () => harness(engine, async h => {
      const body = "# gate 输入\n";
      const prepared = await h.committer.prepare(body);
      const documentId = "gate-direct-doc";
      const actorId = h.people.owner.actor.actorId;
      const mutationKey = digestJson({ actorId, clientMutationId: "gate-direct" });
      const contentDigest = sha(body);
      const plan = durableWritePlan({ ref: prepared.ref, mutationKey, nextVersion: 2 });
      const zero = virtualZeroDurableHead(documentId);
      const target = durableHeadValue({ documentId, dbVersion: 1, actorId, clientMutationId: "gate-direct", contentSha256: contentDigest });
      const input = (expectedHead: typeof zero, targetHead: typeof zero, digests: readonly string[],
        currentHead: typeof zero = zero, digest = contentDigest) => Object.freeze({
        contract: "memory-head-commit-input/r1" as const, plan,
        durableObjectDigests: Object.freeze([...digests]), currentHead, expectedHead, targetHead,
        mutation: Object.freeze({ key: mutationKey, contentDigest: digest }),
      });
      const staleHead = durableHeadValue({ documentId, dbVersion: 3, actorId, clientMutationId: "gate-direct", contentSha256: contentDigest });
      const wrongReceipt = Object.freeze({ ...zero, receipt: sha("wrong-receipt") });
      const outsideDigest = sha("计划外正文");
      const outsideTarget = durableHeadValue({ documentId, dbVersion: 1, actorId,
        clientMutationId: "gate-direct", contentSha256: outsideDigest });
      const outside = input(zero, outsideTarget, [contentDigest], zero, outsideDigest);
      const cases: Array<[string, "head_conflict" | "receipt_mismatch" | "incomplete_durability" | "incomplete_durability",
        ReturnType<typeof input>]> = [
        ["stale expectedHead", "head_conflict", input(staleHead, target, [contentDigest], zero)],
        ["wrong receipt", "receipt_mismatch", input(wrongReceipt, target, [contentDigest], zero)],
        ["missing durableObjectDigests", "incomplete_durability", input(zero, target, [])],
        ["plan outside body", "incomplete_durability", outside],
      ];
      for (const [label, code, gateInput] of cases) {
        const decision = h.store.decideHeadCommit(gateInput);
        assert.equal(decision.outcome, "rejected", label);
        if (decision.outcome !== "rejected") continue;
        assert.equal(decision.code, code, label);
        const original = h.store.decideHeadCommit;
        h.store.decideHeadCommit = () => decision;
        try {
          await assert.rejects(h.committer.commit(prepared, commitInput(h, body, "gate-direct", 0, "2026-11-27T00:00:00.000Z")),
            { reason: durableGateErrorReason(decision.code) }, label);
        } finally { h.store.decideHeadCommit = original; }
        assert.equal((await h.service.read(h.people.owner, h.key)).document, null, label);
        assert.equal(await count(h.db, "memory_object_refs"), 0, label);
        assert.equal(await count(h.db, "memory_versions"), 0, label);
        assert.equal((await memoryAudit(h)).length, 0, label);
      }
    }));

  platformTest(`${engine} DURABLE-COMMIT: 对象耐久准备失败无 DB 写，insertObjectRef 失败同事务回滚`,
    { skip: engine === "postgres" ? pgUnavailable : false }, async () => harness(engine, async h => {
      for (const [index, point] of (["file_synced", "renamed", "directory_synced"] as const).entries()) {
        const failing = await createMemoryObjectStore({ root: h.root, storageId: `${storageId}-fail-${index}` },
          { after: at => { if (at === point) throw new Error(`injected ${point}`); } });
        const service = createMemoryService({ repos: h.repos, config: DEFAULT_MEMORY_CONFIG, injectionReader: {
          readOwn: async () => ({ state: "available" as const, entries: [], errors: [], maxBytes: DEFAULT_MEMORY_CONFIG.maxInjectedBytes }),
          close: async () => {},
        }, readVisibleMessages: async () => [], objectStore: failing });
        await assert.rejects(service.writeDurable(h.people.owner, h.key,
          { expectedVersion: 0, clientMutationId: `fail-${point}`, markdown: `# 失败 ${point}\n` }), error => {
          assert.equal(getMemoryObjectStoreErrorCode(error), "publication_failed");
          return true;
        });
      }
      assert.equal((await h.service.read(h.people.owner, h.key)).document, null);
      assert.equal(await count(h.db, "memory_object_refs"), 0);
      assert.equal(await count(h.db, "memory_versions"), 0);
      assert.equal((await memoryAudit(h)).length, 0);

      const original = h.repos.memory.insertObjectRef;
      h.repos.memory.insertObjectRef = async () => { throw new WriteFailedError("注入 objectRef 失败"); };
      try {
        await assert.rejects(h.service.writeDurable(h.people.owner, h.key,
          { expectedVersion: 0, clientMutationId: "ref-fails", markdown: "不应留存" }), { code: "write_failed" });
      } finally { h.repos.memory.insertObjectRef = original; }
      assert.equal((await h.service.read(h.people.owner, h.key)).document, null);
      assert.equal(await count(h.db, "memory_object_refs"), 0);
      assert.equal(await count(h.db, "memory_versions"), 0);
      assert.equal((await memoryAudit(h)).length, 0);
      assert.equal((await h.service.writeDurable(h.people.owner, h.key,
        { expectedVersion: 0, clientMutationId: "after-rollback", markdown: "回滚后可重试" })).document.version, 1);
    }));

  platformTest(`${engine} DURABLE-COMMIT: 外层事务保存点内第一笔成功、第二笔失败被捕获时第一笔保留`,
    { skip: engine === "postgres" ? pgUnavailable : false }, async () => harness(engine, async h => {
      const firstPrepared = await h.committer.prepare("# 保存点第一笔\n");
      const secondPrepared = await h.committer.prepare("# 保存点第二笔\n");
      const original = h.repos.memory.insertObjectRef;
      let failSecond = false;
      h.repos.memory.insertObjectRef = async input => {
        if (failSecond) throw new WriteFailedError("注入第二笔 objectRef 失败");
        return original(input);
      };
      try {
        await h.repos.transaction(async () => {
          const first = await h.committer.commit(firstPrepared,
            commitInput(h, "# 保存点第一笔\n", "savepoint-1", 0, "2026-11-27T01:00:00.000Z"));
          assert.equal(first.document.version, 1);
          failSecond = true;
          await assert.rejects(h.committer.commit(secondPrepared,
            commitInput(h, "# 保存点第二笔\n", "savepoint-2", 1, "2026-11-27T01:00:01.000Z")), { code: "write_failed" });
          failSecond = false;
        });
      } finally { h.repos.memory.insertObjectRef = original; }
      const document = await h.repos.memory.get(h.key);
      assert.equal(document?.version, 1);
      assert.equal(document?.markdown, "# 保存点第一笔\n");
      assert.equal(await count(h.db, "memory_versions"), 1);
      assert.equal(await count(h.db, "memory_object_refs"), 1);
      assert.equal((await memoryAudit(h)).length, 1);
    }));

  platformTest(`${engine} DURABLE-COMMIT: 普通 service.write 不产生 object ref 与对象文件`,
    { skip: engine === "postgres" ? pgUnavailable : false }, async () => harness(engine, async h => {
      const result = await h.service.write(h.people.owner, h.key,
        { expectedVersion: 0, clientMutationId: "v1-write", markdown: "# 仍然 v1\n" });
      assert.equal(result.document.version, 1);
      assert.equal(await count(h.db, "memory_object_refs"), 0);
      assert.equal(await exists(path.join(h.root, "objects")), false);
      assert.equal((await memoryAudit(h)).length, 1);
    }));
}

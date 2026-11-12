import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { runMigrations } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { evaluateAction, previewPolicy } from "../src/server/policy/index.ts";
import { policyFixture, policyGrantFixture } from "./helpers/policy-fixture.ts";

function freezeDeep(value: unknown): void {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
}

test("S1-AC04：dry-run 只返回观察 DTO；数据库、现有执行队列、grant 次数与预算不变", t => {
  const db = new Database(":memory:");
  try {
    runMigrations(db, migrations);
    const request = policyFixture();
    const grant = policyGrantFixture(request);
    const input = { ...request, context: { ...request.context, facts: {
      ...request.context.facts,
      authorization: { authorizationEpoch: 4, existingAuthorization: false, grants: [grant] },
    } } };
    const original = structuredClone(input);
    freezeDeep(input);
    const databaseBefore = db.serialize();
    const writesBefore = db.prepare("SELECT total_changes() AS count").get();
    const queueBefore = db.prepare("SELECT * FROM work_events ORDER BY id").all();
    const runnersBefore = db.prepare("SELECT * FROM agent_runner_states ORDER BY binding_id").all();
    t.mock.method(Date, "now", () => { throw new Error("纯预览不得读取系统当前时间"); });
    for (let i = 0; i < 3; i++) {
      const preview = previewPolicy(input);
      assert.equal(preview.kind, "policy-preview");
      assert.equal(preview.sideEffects, "none");
      assert.equal(preview.evaluation.executionAdmission, "not-issued");
      assert.deepEqual(preview.evaluation, evaluateAction(input));
    }
    assert.deepEqual(input, original);
    assert.equal(input.context.facts.authorization.grants[0]?.remainingUses, 2);
    assert.deepEqual(db.prepare("SELECT total_changes() AS count").get(), writesBefore);
    assert.deepEqual(db.prepare("SELECT * FROM work_events ORDER BY id").all(), queueBefore);
    assert.deepEqual(db.prepare("SELECT * FROM agent_runner_states ORDER BY binding_id").all(), runnersBefore);
    assert.deepEqual(db.serialize(), databaseBefore);
  } finally { db.close(); }
});

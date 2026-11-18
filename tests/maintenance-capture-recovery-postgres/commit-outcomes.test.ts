import test, { before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { recoveryFixture } from "../fixtures/maintenance-capture-recovery.ts";
import { errorLeaves, rejected } from "../fixtures/maintenance-backup-lifecycle.ts";
import { MaintenanceFailure } from "../../src/server/storage/maintenance/error.ts";

const supported = process.platform === "linux" && !!process.env.AGENT_STUDIO_PG_TEST_URL;
const nativeTest = supported ? test : test.skip;
before(() => {
  if (!supported) return;
  const build = spawnSync(process.execPath,
    [fileURLToPath(new URL("../../scripts/build-maintenance-platform.mjs", import.meta.url)), "--source-files"],
    { encoding: "utf8", timeout: 60_000 });
  assert.equal(build.status, 0, build.stderr);
});

nativeTest("#152 C2 postgres: T COMMIT before/after and Q source close failures classify the actual durable head", async t => {
  for (const point of ["commit-before", "commit-after", "source-close"] as const) await t.test(point, async child => {
    const f = await recoveryFixture("postgres"), query = Client.prototype.query, end = Client.prototype.end;
    const targetStage = point === "source-close" ? 3 : 2;
    const failure = new MaintenanceFailure("maintenance_lost", "C2 PG " + point);
    let currentStage = 0, target: Client | undefined, injected = 0, completedFinal = false;
    try {
      f.recovery.onLock = (lock, stage) => {
        currentStage = stage; completedFinal = false;
        const facts = lock.withSourceClientFacts;
        lock.withSourceClientFacts = async (plan, consume) => { const result = await facts(plan, consume); completedFinal = true; return result; };
      };
      child.mock.method(Client.prototype, "query", async function(this: Client, ...args: unknown[]) {
        const sql = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string } | null)?.text ?? "";
        const database = (this as unknown as { connectionParameters: { database: string } }).connectionParameters.database;
        if (database === f.database && currentStage === targetStage && sql.startsWith("UPDATE storage_maintenance SET admission=")) {
          assert(completedFinal); target = this;
        }
        if (this === target && sql === "COMMIT" && point === "commit-before") { injected++; throw failure; }
        const result = await Reflect.apply(query, this, args);
        if (this === target && sql === "COMMIT" && point === "commit-after") { injected++; throw failure; }
        return result;
      } as typeof query);
      child.mock.method(Client.prototype, "end", async function(this: Client) {
        await Reflect.apply(end, this, []);
        if (this === target && point === "source-close") { injected++; throw failure; }
      } as typeof end);
      const outcome = await rejected(f.captureSnapshot(f.options, f.request));
      assert.equal(outcome.failed, true); assert(injected >= 1);
      // Keep the existing endFactsSession safe-error contract distinct from
      // the exact original COMMIT failures and D body/cleanup errors.
      if (point === "source-close") assert(errorLeaves(outcome.error).some(error => error instanceof MaintenanceFailure
        && error.code === "maintenance_lost" && error.message === "storage_maintenance: maintenance_lost (source-client-facts)"));
      else assert(errorLeaves(outcome.error).includes(failure));
      child.mock.restoreAll(); delete f.recovery.onLock;
      const observed = await f.observe(), expectedSequence = point === "commit-before" ? 2 : point === "commit-after" ? 3 : 4;
      assert.equal(observed.state.admission, "sealed"); assert.equal(observed.state.journalSequence, expectedSequence);
      assert.equal(observed.state.ownerGeneration, point === "commit-before" ? 1 : 2);
      assert.equal(f.events.filter(e => e.event === "source-begin").length, targetStage, "no later control or D after the failed actual outer completion");
      const replay = await f.captureSnapshot(f.options, f.request);
      assert("kind" in replay && replay.kind === "anchored-progress");
      assert.equal(replay.ref.journal.sha256, observed.state.journalDigest);
      assert.deepEqual((await f.observe()).state, observed.state);
    } finally { child.mock.restoreAll(); await f.close(); }
  });
});

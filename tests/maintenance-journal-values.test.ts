import test from "node:test";
import assert from "node:assert/strict";
import { parseCanonical } from "../src/server/storage/maintenance/canonical.ts";
import { MaintenanceFailure, maintenanceFailureCode } from "../src/server/storage/maintenance/error.ts";
import { decodeJournalValue, JOURNAL_VALUE_MATH, readReceiptValues, readJournalValues, readSnapshotValues } from "../src/server/storage/maintenance/journal-values.ts";
import type { JournalValueProgram } from "../src/server/storage/maintenance/journal-values.ts";
import { legacyVector } from "./fixtures/maintenance-control-candidate.ts";

function fixture(options: Parameters<typeof legacyVector>[0] = {}) {
  const { f } = legacyVector(options), map = new Map(f.objects.map(item => [item.reference.ref, item]));
  const context = { root: f.root.path, identity: f.root, math: JOURNAL_VALUE_MATH };
  const run = <T>(program: JournalValueProgram<T>): T => {
    let step = program.next();
    while (!step.done) {
      const op = step.value, item = map.get(op.reference.ref);
      assert(item, `missing fixture object ${op.reference.ref}`);
      const kind = op.reference.ref.startsWith("plans/") ? "plan" : op.reference.ref.startsWith("journals/") ? "journal" : op.reference.ref.split("/").at(-1)!.split(".")[0]!;
      step = program.next(op.operation === "kind" ? kind : op.operation === "verify" ? undefined : decodeJournalValue(op.as, item.bytes));
    }
    return step.value;
  };
  const receipt = f.objects.find(item => item.reference.ref.endsWith("/receipt.json"))!.reference;
  const parsed = parseCanonical(map.get(receipt.ref)!.bytes) as {capture:{journal:typeof receipt}};
  return { f, context, run, receipt, captured: parsed.capture.journal };
}

test("F S4: receipt value closure uses its complete capture prefix without manufacturing ready", () => {
  const x = fixture();
  const result = x.run(readReceiptValues(x.context, x.receipt));
  assert.deepEqual(result.receiptRef, x.receipt);
  assert.equal(result.chain.nodes.at(-1)!.record.event, "capture");
  assert.throws(() => x.run(readSnapshotValues(x.context, x.run(readJournalValues(x.context, x.captured)))), { code: "journal_invalid" });
});

test("F S4: exact membership and publication omissions fail the same pure equations", () => {
  for (const options of [{omitRole:"plan"}, {omitPublishedBundle:true}]) {
    const x = fixture(options);
    assert.throws(() => x.run(readReceiptValues(x.context, x.receipt)), {code:"journal_invalid"});
  }
});

test("F error identity lookup never reflects on a hostile unknown", () => {
  let traps = 0;
  const hostile = new Proxy({}, {get(){traps++;throw null;},getPrototypeOf(){traps++;throw null;},ownKeys(){traps++;throw null;}});
  assert.equal(maintenanceFailureCode(hostile), undefined);
  assert.equal(maintenanceFailureCode(new MaintenanceFailure("snapshot_invalid")), "snapshot_invalid");
  assert.equal(traps,0);
});

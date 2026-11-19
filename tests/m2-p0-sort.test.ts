import assert from "node:assert/strict";
import test from "node:test";
import { sortHistoryFrames, historyFrameSortCost } from "../src/server/identity/internal/m2-history-sort.ts";

test("bounded history frame sorter preserves default lexical order and multiplicity", () => {
  let seed = 1447;
  const word = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return String(seed % 719); };
  for (const size of [0, 1, 2, 3, 17, 128, 513]) {
    const input = Array.from({ length: size }, (_, i) => `["${word()}",[["text","${i % 7 ? "ff" : ""}"]]]`);
    const saved = [...input], result = sortHistoryFrames(input);
    assert.deepEqual(result, [...input].sort());
    assert.deepEqual(input, saved);
    const cost = historyFrameSortCost(size);
    assert.ok(cost.comparisons <= size * Math.ceil(Math.log2(Math.max(1, size))));
    assert.ok(cost.slots <= size * 2);
  }
  assert.deepEqual(sortHistoryFrames(["a", "a", "", "aa", "a0", "0", "-1"]), ["", "-1", "0", "a", "a", "a0", "aa"]);
});

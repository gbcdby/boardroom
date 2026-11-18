// Record the original complete Node glob and exact cost-balanced assignment.
// This is evidence of selection input, not evidence that any test passed.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { linuxTestSelection, TEST_GLOB } from "./linux-test-partitions.mjs";

const partition = process.env.BOARDROOM_CI_TEST_PARTITION ?? "1/1";
assert.ok(["1/1", ...Array.from({ length: 16 }, (_, index) => `${index + 1}/16`)].includes(partition), "unknown fixed partition");
const selection = linuxTestSelection(partition);
const manifest = { schema: "boardroom-linux-test-discovery/v2", candidate: process.env.GITHUB_SHA,
  node: process.version, availableParallelism: availableParallelism(), configuredConcurrency: partition === "1/1" ? 4 : 1,
  partition, glob: TEST_GLOB, ...selection,
  selection: partition === "1/1" ? "complete glob; original unpartitioned runner" : "deterministic longest-first estimates; complete glob assigned once to 16 serial partitions",
  result: "NOT_RUN" };
const directory = ".agent-output/linux-ci-isolation/full-suite";
mkdirSync(directory, { recursive: true, mode: 0o700 });
writeFileSync(`${directory}/test-scheduler.json`, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ node: manifest.node, availableParallelism: manifest.availableParallelism,
  configuredConcurrency: manifest.configuredConcurrency, partition, discovered: manifest.entries.length,
  entriesSha256: manifest.entriesSha256, result: manifest.result }));

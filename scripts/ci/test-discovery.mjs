// Record the original complete Node glob before the fixed native shard runs.
// This is evidence of selection input, not evidence that any test passed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { globSync, mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";

const partition = process.env.BOARDROOM_CI_TEST_PARTITION ?? "1/1";
assert.ok(["1/1", ...Array.from({ length: 16 }, (_, index) => `${index + 1}/16`)].includes(partition), "unknown fixed partition");
const glob = "tests/**/*.test.ts";
const entries = globSync(glob).sort();
assert.ok(entries.length > 0 && entries.length <= 1024, "test discovery must be nonempty and bounded");
assert.equal(new Set(entries).size, entries.length);
const manifest = { schema: "boardroom-linux-test-discovery/v1", candidate: process.env.GITHUB_SHA,
  node: process.version, availableParallelism: availableParallelism(), configuredConcurrency: partition === "1/1" ? 4 : 1,
  partition, glob, entries, entriesSha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
  selection: "native Node --test-shard; complete glob preserved", result: "NOT_RUN" };
const directory = ".agent-output/linux-ci-isolation/full-suite";
mkdirSync(directory, { recursive: true, mode: 0o700 });
writeFileSync(`${directory}/test-scheduler.json`, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ node: manifest.node, availableParallelism: manifest.availableParallelism,
  configuredConcurrency: manifest.configuredConcurrency, partition, discovered: entries.length,
  entriesSha256: manifest.entriesSha256, result: manifest.result }));

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import test from "node:test";
import { parseDocument } from "yaml";

type Step = {
  id?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = {
  name: string;
  needs?: string | string[];
  if?: string;
  outputs?: Record<string, string>;
  steps: Step[];
};

const document = parseDocument(readFileSync(new URL("../.github/workflows/database-ci.yml", import.meta.url), "utf8"));
assert.deepEqual(document.errors, [], "CI workflow must remain valid YAML");
const jobs = (document.toJS() as { jobs: Record<string, Job> }).jobs;
const artifactOutput = "${{ needs.browser-dependencies.outputs.browser_dependencies_id }}";

function ancestors(jobId: string, found = new Set<string>()): Set<string> {
  const job = jobs[jobId];
  assert.ok(job, `missing workflow job: ${jobId}`);
  for (const dependency of [job.needs ?? []].flat()) {
    assert.notEqual(dependency, jobId, "a job cannot depend on itself");
    if (!found.has(dependency)) {
      found.add(dependency);
      ancestors(dependency, found);
    }
  }
  return found;
}

test("Linux and Chromium retain separate required checks without waiting for each other's test suite", () => {
  assert.equal(jobs["database-tests"]?.name, "Node 24 · SQLite / PostgreSQL");
  assert.equal(jobs["macos-tests"]?.name, "Node 24 · macOS arm64 / SQLite");
  assert.equal(jobs["managed-web-browser"]?.name, "Chromium · 工作台与托管 Agent 页面");
  assert.ok(jobs["browser-dependencies"], "browser dependency preparation must be independently schedulable");
  assert.equal(ancestors("managed-web-browser").has("database-tests"), false);
  assert.equal(ancestors("database-tests").has("managed-web-browser"), false);
  assert.ok(ancestors("managed-web-browser").has("browser-dependencies"));
});

test("every browser dependency consumer uses the producer's artifact ID, including failed-job retries", () => {
  const producer = jobs["browser-dependencies"];
  assert.ok(producer, "dependency producer must exist");
  assert.equal(producer.outputs?.browser_dependencies_id, "${{ steps.browser_dependencies.outputs.artifact-id }}");
  assert.ok(producer.steps.some(step => step.id === "browser_dependencies" && step.uses?.startsWith("actions/upload-artifact@")));
  const browser = jobs["managed-web-browser"]!;
  const download = browser.steps.find(step => step.uses?.startsWith("actions/download-artifact@"));
  assert.ok(download, "browser must download the exact successful producer artifact");
  assert.equal(download.with?.["artifact-ids"], artifactOutput);
  assert.equal(download.with?.["digest-mismatch"], "error");
  const consumers = browser.steps.filter(step => step.env?.RESOURCE_BROWSER_ARTIFACT_ID !== undefined);
  assert.ok(consumers.length > 0, "runtime binding must receive the producer artifact ID");
  for (const consumer of consumers) assert.equal(consumer.env?.RESOURCE_BROWSER_ARTIFACT_ID, artifactOutput);
});

test("the existing Chromium check fails when preparation fails or produces no usable artifact ID", () => {
  const browser = jobs["managed-web-browser"]!;
  assert.equal(browser.if, "${{ !cancelled() }}", "failed preparation must not skip the required Chromium check");
  const gate = browser.steps[0];
  assert.ok(gate?.run, "check the dependency outcome before browser setup");
  assert.equal(gate.env?.DEPENDENCIES_RESULT, "${{ needs.browser-dependencies.result }}");
  assert.equal(gate.env?.BROWSER_DEPENDENCIES_ID, artifactOutput);
  for (const [result, artifactId, succeeds] of [
    ["success", "800001", true],
    ["failure", "800001", false],
    ["skipped", "", false],
    ["success", "", false],
    ["success", "0", false],
    ["success", "not-an-id", false],
  ] as const) {
    const actual: SpawnSyncReturns<string> = spawnSync("bash", ["-e", "-c", gate.run], {
      encoding: "utf8", timeout: 5_000,
      env: { PATH: process.env.PATH, DEPENDENCIES_RESULT: result, BROWSER_DEPENDENCIES_ID: artifactId },
    });
    assert.ifError(actual.error);
    assert.equal(actual.status === 0, succeeds, `${result}/${artifactId}: ${actual.stdout}${actual.stderr}`);
  }
});

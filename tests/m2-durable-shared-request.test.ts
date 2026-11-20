import assert from "node:assert/strict";
import test from "node:test";
import { createP0Request, createP0ArtifactRequest } from "../src/server/identity/internal/m2-p0-request.ts";
import { p0State, P0_LIMITS, withP0Guard } from "../src/server/identity/internal/m2-p0-budget.ts";
import { checkP0Artifacts } from "../src/server/identity/internal/m2-p0-artifacts.ts";
import type { P0Request } from "../src/server/identity/internal/m2-p0-types.ts";
import { p0ArtifactFixture } from "./helpers/m2-p0-f-fixture.ts";

function owned() {
  const input = p0ArtifactFixture(), result = createP0Request(JSON.stringify(input));
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

test("a historical P0 artifact context executes its original consumers on the enclosing request", () => {
  const parent = owned(), state = p0State(parent), selectedBefore = state.usage.selectedBytes;
  const child = createP0ArtifactRequest(parent, parent.input.graph.observation,
    parent.input.artifacts.map((_, i) => i), parent.input.evidence.map((_, i) => i));
  const result = checkP0Artifacts(child, child.original);
  assert(result.ok, JSON.stringify(result));
  assert.equal(result.value.artifacts, parent.input.artifacts.length);
  assert.equal(state.usage.selectedBytes, selectedBefore, "existing original selections are not readmitted as fresh byte allowance");
});

test("historical contexts cannot reset an exhausted enclosing budget or erase its original failure", () => {
  const parent = owned();
  const child = createP0ArtifactRequest(parent, parent.input.graph.observation,
    parent.input.artifacts.map((_, i) => i), parent.input.evidence.map((_, i) => i));
  const state = p0State(parent); state.usage.work = P0_LIMITS.work - 1;
  const failed = checkP0Artifacts(child, child.original); assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.error.code, "resource_limit");
  const later = withP0Guard(parent, () => createP0ArtifactRequest(parent, parent.input.graph.observation, [], []));
  assert.equal(later.ok, false);
  if (!failed.ok && !later.ok) assert.strictEqual(later.error, failed.error);
});

test("a foreign request or foreign observation cannot enter the authenticated historical view", () => {
  let traps = 0;
  const hostile = new Proxy({}, { get() { traps++; throw Error("not observed"); }, ownKeys() { traps++; throw Error("not observed"); } });
  assert.throws(() => createP0ArtifactRequest(hostile as P0Request, hostile, [], []));
  const parent = owned();
  const result = withP0Guard(parent, () => createP0ArtifactRequest(parent, hostile, [], []));
  assert.equal(result.ok, false); assert.equal(traps, 0);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createP0Request } from "../src/server/identity/internal/m2-p0-request.ts";
import { p0State, P0_LIMITS, withP0Guard } from "../src/server/identity/internal/m2-p0-budget.ts";
import { fState } from "../src/server/identity/internal/m2-p0-artifacts-common.ts";
import { beginP0FArtifactPass, endP0FArtifactPass, p0FCodecSyntaxFrame, withP0FNativeConsumer } from "../src/server/identity/internal/m2-p0-artifacts-frame.ts";
import { parseM2Value } from "../src/server/identity/m2-value-codecs.ts";
import { p0ArtifactFixture } from "./helpers/m2-p0-f-fixture.ts";

const value = { kind: "source-binding", value: { contract: "m2-source-binding/r1", kind: "legacy",
  physicalSourceRef: { artifactId: "physical", digest: "a".repeat(64) } } };
test("P-A original parser charges the enclosing authenticated P0 request without a new allowance", () => {
  assert.equal(parseM2Value(value).ok, true);
  const admitted = createP0Request(JSON.stringify(p0ArtifactFixture())); assert(admitted.ok);
  const request = admitted.value, state = p0State(request), f = fState(request);
  beginP0FArtifactPass(f, request.original);
  try {
    const input = structuredClone(value); f.freeze(input);
    const frame = p0FCodecSyntaxFrame(f, input), before = state.usage.work;
    assert.equal(withP0FNativeConsumer(frame, () => parseM2Value(input)).ok, true);
    assert(state.usage.work > before + 100, "real copy/schema/hash traversal must debit the enclosing request");
    state.usage.work = P0_LIMITS.work - 3;
    const exhausted = withP0Guard(request, () => withP0FNativeConsumer(frame, () => parseM2Value(input)));
    assert.equal(exhausted.ok, false);
    if (!exhausted.ok) assert.equal(exhausted.error.code, "resource_limit");
  } finally { endP0FArtifactPass(f); }
  assert.equal(parseM2Value(value).ok, true, "the original public boundary retains its separate call semantics");
});

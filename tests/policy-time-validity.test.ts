import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAction, PolicyInputError } from "../src/server/policy/index.ts";
import { policyFixture, policyGrantFixture } from "./helpers/policy-fixture.ts";

const invalidTimes = [
  "2026-11-10T12:00:00+99:99",
  "2026-11-12T12:00:00+24:00",
  "2026-11-10T12:00:00+00:60",
] as const;

for (const field of ["validFrom", "expiresAt"] as const) {
  for (const value of invalidTimes) {
    test("S1-AC04: reject unparseable grant " + field + " " + value, () => {
      const base = policyFixture("delivery.merge");
      const request = {
        ...base,
        stage: "execution" as const,
        context: {
          ...base.context,
          facts: {
            ...base.context.facts,
            authorization: {
              authorizationEpoch: 4,
              existingAuthorization: false,
              grants: [{ ...policyGrantFixture(base), [field]: value }],
            },
          },
        },
      };
      assert.throws(
        () => evaluateAction(request),
        (error: unknown) => error instanceof PolicyInputError && error.code === "context_input_invalid",
        "Invalid time must be rejected before grant comparisons; NaN cannot make a grant valid",
      );
    });
  }
}

for (const value of invalidTimes) {
  test("S1-AC04: reject unparseable evaluation time " + value, () => {
    const base = policyFixture("delivery.merge");
    assert.throws(
      () => evaluateAction({ ...base, context: { ...base.context, evaluatedAt: value } }),
      (error: unknown) => error instanceof PolicyInputError && error.code === "context_input_invalid",
      "Invalid evaluation time must produce a stable input error, not a raw RangeError",
    );
  });
}

test("S1-AC04: valid explicit UTC offsets retain authorization reuse", () => {
  const base = policyFixture("delivery.merge");
  const grant = policyGrantFixture(base);
  const evaluation = evaluateAction({
    ...base,
    stage: "execution",
    context: {
      ...base.context,
      evaluatedAt: base.context.evaluatedAt.replace(/Z$/, "+00:00"),
      facts: {
        ...base.context.facts,
        authorization: {
          authorizationEpoch: 4,
          existingAuthorization: false,
          grants: [{
            ...grant,
            validFrom: grant.validFrom?.replace(/Z$/, "+00:00") ?? null,
            expiresAt: grant.expiresAt.replace(/Z$/, "+00:00"),
          }],
        },
      },
    },
  });
  assert.equal(evaluation.outcome, "auto");
  assert.equal(evaluation.executionAdmission, "not-issued");
  assert.deepEqual(evaluation.grantRefs.map(ref => ref.grantId), ["grant-1"]);
});

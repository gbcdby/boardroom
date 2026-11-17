import test from "node:test";
import { assertControllerPendingFailures } from "../fixtures/maintenance-controller-history.ts";

const pgTest = process.env.AGENT_STUDIO_PG_TEST_URL ? test : test.skip;

// This capture/restore fixture uses the Linux source-FD bridge.
const pgCaptureTest = process.platform === "linux" ? pgTest : test.skip;

pgCaptureTest("C3 PostgreSQL keeps each independent pending callback failure after the original source callback failure", async t => {
  for (const variant of ["distinct", "same", "undefined", "parent-and-child", "control-writer"] as const)
    await t.test(variant, () => assertControllerPendingFailures("postgres", variant));
});

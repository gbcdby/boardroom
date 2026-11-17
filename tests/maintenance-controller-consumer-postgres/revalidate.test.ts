import test from "node:test";
import { assertVerifiedConsumerFailure } from "../fixtures/maintenance-controller-history.ts";

const pgTest = process.env.AGENT_STUDIO_PG_TEST_URL ? test : test.skip;
// This capture/restore fixture uses the Linux source-FD bridge.
const pgCaptureTest = process.platform === "linux" ? pgTest : test.skip;

pgCaptureTest("C3 postgres fixed verified consumer preserves original failure forwarding and independent occurrences: revalidate",
  () => assertVerifiedConsumerFailure("postgres", "revalidate"));

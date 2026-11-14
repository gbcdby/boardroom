import test from "node:test";
import assert from "node:assert/strict";
import { parseCapability } from "../src/server/storage/maintenance/parse.ts";

test("#152 Darwin capability requires explicit APFS file and directory F_FULLFSYNC evidence", () => {
  const proof = { formatVersion: 1, kind: "capability", platform: "darwin", filesystemType: "apfs", node: "v24.22.1",
    rootIdentity: { path: "/fixture/control", device: "1", inode: "2", hostIdentityDigest: "a".repeat(64) },
    guarantee: "observed-file-and-directory-fullfsync-rename", powerLossTested: false, probeDigest: "b".repeat(64) };
  assert.deepEqual(parseCapability(proof), proof);
  for (const changed of [{ filesystemType: "nfs" }, { guarantee: "observed-file-fsync-rename-directory-fsync" },
    { powerLossTested: true }, { fallbackAccepted: true }, { platform: "windows" }])
    assert.throws(() => parseCapability({ ...proof, ...changed }), /journal_invalid/);
});

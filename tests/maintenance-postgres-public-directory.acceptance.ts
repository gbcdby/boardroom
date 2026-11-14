import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { privateLeaf, publicDirectoryControls } from "./fixtures/postgres-public-directory-controls.ts";

// Explicit Darwin qualification: unsupported/blocked fixtures fail and never skip to green.
test("#152 actual Darwin production directory socket-leaf rejection", { timeout: 15_000 }, async t => {
  const h = await publicDirectoryControls("socket"); h.receipt.fixtureCreated = false; h.receipt.fixtureStatus = "NOT_RUN";
  try {
    await h.control(t, "DIRFD-11", "actual Unix socket entry is refused by the production native bridge and wrapper", async () => {
      if (process.platform !== "darwin") { h.receipt.status = "BLOCKED"; throw new Error("Actual Darwin is required"); }
      const c = await h.context("socket"), name = privateLeaf("namespace.sql");
      try {
        // Relative name keeps sockaddr_un below its length bound; cwd is private to this child.
        const fixture = spawnSync("python3", ["-c", "import os,socket,sys,json\ntry:\n s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); os.chmod(sys.argv[1],0o600); s.close(); print(json.dumps({'status':'CREATED'}))\nexcept OSError as e:\n print(json.dumps({'status':'BLOCKED','errno':e.errno,'message':str(e)})); sys.exit(1)", name],
        { cwd: c.path, encoding: "utf8", timeout: 2000, maxBuffer: 4096 });
        h.receipt.observations.push({ controlId: "DIRFD-11", phase: "fixture", status: fixture.status, signal: fixture.signal,
          error: fixture.error?.message ?? null, stdout: fixture.stdout, stderr: fixture.stderr });
        if (fixture.status !== 0 || fixture.error || fixture.signal) {
          h.receipt.status = "BLOCKED"; h.receipt.fixtureStatus = "BLOCKED"; throw new Error("Unix socket fixture unavailable");
        }
        const socket = h.observe(await lstat(join(c.path, name), { bigint: true }));
        assert.ok(socket.isSocket()); assert.equal(socket.mode & 0o777n, 0o600n); assert.equal(socket.uid, BigInt(process.getuid!()));
        h.receipt.fixtureCreated = true; h.receipt.fixtureStatus = "CREATED";
        await assert.rejects(h.binding.readAt(...c.args(name)), error => {
          const value = error as NodeJS.ErrnoException;
          h.receipt.observations.push({ controlId: "DIRFD-11", phase: "native-read", code: value.code, errno: value.errno, syscall: value.syscall });
          return value.code === "ERR_FILE_IDENTITY" || value.syscall === "openat" && Number(value.errno) > 0;
        });
        await assert.rejects(c.files().read(name), { code: "snapshot_invalid" });
      } finally { await c.directory.close(); }
    });
  } finally { await h.finish(); }
});

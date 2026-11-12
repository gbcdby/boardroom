import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, { constants, closeSync, readSync } from "node:fs";
import promises, { chmod, link, lstat, mkdir, open, readFile, rename, symlink, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";
import { NativePublicDirectory, publicDirectoryFiles, type PublicDirectoryNativeBinding } from "../src/server/storage/maintenance/postgres-public-directory.ts";
import { descriptorStat, privateLeaf, publicDirectoryControls, readPosition, statProjection } from "./fixtures/postgres-public-directory-controls.ts";

test("#152 production public directory FD controls", { timeout: 30_000 }, async t => {
  const h = await publicDirectoryControls("core");
  try {
    await h.control(t, "DIRFD-01", "parent-owned raw FD adopts exact file and path stat remains bound", async () => {
      const c = await h.context("ownership"), name = privateLeaf(); let file: FileHandle | undefined, raw = -1;
      const tracking: PublicDirectoryNativeBinding = { ...h.binding,
        createAt: async (...args) => { raw = await h.binding.createAt(...args); h.observe(descriptorStat(raw)); return raw; } };
      try {
        await c.checkPath(); file = await c.files(tracking).create(name);
        assert.throws(() => descriptorStat(raw), { code: "EBADF" });
        await file.write(Buffer.from("0123456789"), 0, 10, 0); await file.sync();
        const stat = h.observe(await file.stat({ bigint: true }));
        assert.deepEqual(statProjection(await c.files().stat(name)), statProjection(stat));
        assert.equal(await readPosition(file, 10, 0), "0123456789"); await c.checkPath();
        // This selects the actual production Darwin loader when on Darwin, and
        // preserves the existing Linux branch when testing that platform.
        const selected = publicDirectoryFiles(c.directory, c.identity, () => {});
        if (process.platform === "darwin") assert.ok(selected instanceof NativePublicDirectory);
        const selectedRead = await selected.read(name);
        try { assert.equal(await readPosition(selectedRead, 10), "0123456789"); } finally { await selectedRead.close(); }
        h.receipt.observations.push({ controlId: "DIRFD-01", raw, adopted: file.fd, rawClosed: true, stat: statProjection(stat) });
      } finally { await file?.close(); await c.directory.close(); }
    });

    await h.control(t, "DIRFD-02", "fresh opens start at zero and terminal descriptor semantics are observed", async () => {
      const c = await h.context("offsets"), name = privateLeaf(); let a: number | undefined, b: number | undefined, adopted: FileHandle | undefined;
      try {
        const writer = await c.files().create(name);
        try { h.observe(await writer.stat({ bigint: true })); await writer.writeFile("abcdefghij"); } finally { await writer.close(); }
        a = await h.binding.readAt(...c.args(name)); b = await h.binding.readAt(...c.args(name));
        const byte = Buffer.alloc(1);
        readSync(a, byte, 0, 1, null); assert.equal(byte.toString(), "a");
        readSync(a, byte, 0, 1, null); assert.equal(byte.toString(), "b");
        readSync(b, byte, 0, 1, null); assert.equal(byte.toString(), "a");
        adopted = await open(`/dev/fd/${b}`, constants.O_RDONLY | (process.platform === "darwin" ? constants.O_NOFOLLOW : 0));
        assert.deepEqual(statProjection(await adopted.stat({ bigint: true })), statProjection(descriptorStat(b)));
        const next = await readPosition(adopted, 1); assert.equal(next, process.platform === "darwin" ? "b" : "a");
        h.receipt.observations.push({ controlId: "DIRFD-02", originalOffset: 1, adoptedFirstByte: next,
          mechanism: process.platform === "darwin" ? "fdesc-shared-OFD" : "procfs-fresh-open" });
        await adopted.close(); adopted = undefined;
        const fresh = await c.files().read(name);
        try { assert.equal(await readPosition(fresh, 10), "abcdefghij"); assert.equal(await readPosition(fresh, 10, 0), "abcdefghij"); }
        finally { await fresh.close(); }
      } finally { if (a !== undefined) closeSync(a); if (b !== undefined) closeSync(b); await adopted?.close(); await c.directory.close(); }
    });

    await h.control(t, "DIRFD-03", "metadata and actual adoption-open failures close the returned raw FD", async child => {
      const c = await h.context("acquisition-errors"); let raw = -1;
      const tracking: PublicDirectoryNativeBinding = { ...h.binding,
        createAt: async (...args) => { raw = await h.binding.createAt(...args); h.observe(descriptorStat(raw)); return raw; } };
      try {
        const originalStat = fs.fstat;
        const injected = Object.assign(new Error("owned metadata read fault"), { code: "EIO" });
        child.mock.method(fs, "fstat", ((...args: unknown[]) => {
          if (args[0] === raw) { queueMicrotask(() => (args.at(-1) as (error: Error) => void)(injected)); return; }
          return Reflect.apply(originalStat, fs, args);
        }) as typeof fs.fstat); syncBuiltinESMExports();
        await assert.rejects(c.files(tracking).create(privateLeaf()), error => error === injected);
        assert.throws(() => descriptorStat(raw), { code: "EBADF" });
        child.mock.restoreAll(); syncBuiltinESMExports();
        const originalOpen = promises.open;
        child.mock.method(promises, "open", (async (...args: Parameters<typeof promises.open>) => {
          if (String(args[0]) === `/dev/fd/${raw}`) return originalOpen(args[0], Number(args[1]) | constants.O_DIRECTORY, args[2]);
          return Reflect.apply(originalOpen, promises, args);
        }) as typeof promises.open); syncBuiltinESMExports();
        await assert.rejects(c.files(tracking).create(privateLeaf()), { code: "ENOTDIR" });
        assert.throws(() => descriptorStat(raw), { code: "EBADF" });
        h.receipt.observations.push({ controlId: "DIRFD-03", metadataFault: "EIO", adoptionFault: "ENOTDIR", allRawClosed: true });
      } finally { child.mock.restoreAll(); syncBuiltinESMExports(); await c.directory.close(); }
    });

    await h.control(t, "DIRFD-04", "exclusive create and link/mode/leaf boundaries preserve owned canary", async () => {
      const c = await h.context("boundaries"), name = privateLeaf(), path = join(c.path, name);
      const canary = join(h.fixture, "canary"); await writeFile(canary, "UNCHANGED", { mode: 0o600 }); h.observe(await lstat(canary, { bigint: true }));
      try {
        const file = await c.files().create(name); h.observe(await file.stat({ bigint: true })); await file.close();
        await assert.rejects(c.files().create(name), { code: "EEXIST" });
        const alias = join(c.path, privateLeaf("body.sql")); await link(path, alias);
        await assert.rejects(c.files().read(name), { code: "snapshot_invalid" }); await unlink(alias);
        await chmod(path, 0o640); await assert.rejects(c.files().read(name), { code: "snapshot_invalid" }); await chmod(path, 0o600);
        const linked = privateLeaf("namespace.sql"); await symlink(canary, join(c.path, linked));
        await assert.rejects(c.files().read(linked), { code: "snapshot_invalid" });
        await assert.rejects(h.binding.readAt(...c.args(linked)), { code: "ELOOP" });
        for (const invalid of ["../escape", "/tmp/escape", ".", "..", name + "/child", name + "\0hidden", ".public-invalid-archive.dump"])
          await assert.rejects(c.files().create(invalid), { code: "restore_verification_unavailable" });
        await assert.rejects(async () => h.binding.createAt(c.directory.fd + 0.5, name, c.identity.dev, c.identity.ino), { code: "ERR_PUBLIC_DIRECTORY_ARGUMENT" });
        assert.equal(await readFile(canary, "utf8"), "UNCHANGED");
      } finally { await c.directory.close(); }
    });

    await h.control(t, "DIRFD-05", "regular leaf replaced after real precheck by no-writer FIFO cannot block read acquisition", async () => {
      const c = await h.context("fifo-race"), name = privateLeaf(), path = join(c.path, name); let swapped = false, rejection: Record<string, unknown> | undefined;
      try {
        const file = await c.files().create(name); h.observe(await file.stat({ bigint: true })); await file.close();
        const raced: PublicDirectoryNativeBinding = { ...h.binding,
          statAt: async (...args) => {
            const stat = await h.binding.statAt(...args);
            if (!swapped && args[1] === name) {
              swapped = true; await rename(path, `${path}.sealed`);
              execFileSync("mkfifo", ["-m", "600", path], { timeout: 2000, stdio: "pipe" });
              h.observe(await lstat(path, { bigint: true }));
            }
            return stat;
          },
          readAt: async (...args) => {
            try { return await h.binding.readAt(...args); }
            catch (error) { const value = error as NodeJS.ErrnoException; rejection = { code: value.code, errno: value.errno, syscall: value.syscall }; throw error; }
          } };
        const started = performance.now();
        await assert.rejects(c.files(raced).read(name), { code: "snapshot_invalid" });
        const elapsed = performance.now() - started;
        assert.equal(swapped, true); assert.equal(rejection?.code, "ERR_FILE_IDENTITY"); assert.equal(rejection?.syscall, "file-identity");
        assert.ok(elapsed < 1000, `FIFO read-acquisition rejection exceeded ${elapsed}ms`);
        const directoryName = privateLeaf("body.sql"); await mkdir(join(c.path, directoryName), { mode: 0o700 });
        h.observe(await lstat(join(c.path, directoryName), { bigint: true }));
        await assert.rejects(c.files().read(directoryName), { code: "snapshot_invalid" });
        h.receipt.observations.push({ controlId: "DIRFD-05", regularPrecheckSucceeded: true, swappedToNoWriterFifo: true,
          nativeOpenReturnedThenRejected: true, elapsedMilliseconds: elapsed, rejection });
      } finally { await c.directory.close(); }
    });

    await h.control(t, "DIRFD-06", "wrong pinned parent identity or permissions cannot create a leaf", async () => {
      const c = await h.context("parent-identity"), name = privateLeaf();
      try {
        const wrong = new NativePublicDirectory(c.directory, { dev: c.identity.dev, ino: c.identity.ino + 1n }, h.binding, () => {});
        await assert.rejects(wrong.create(name), { code: "target_conflict" });
        await chmod(c.path, 0o710); await assert.rejects(c.files().create(name), { code: "target_conflict" }); await chmod(c.path, 0o700);
        await assert.rejects(lstat(join(c.path, name)), { code: "ENOENT" });
      } finally { await c.directory.close(); }
    });

    await h.control(t, "DIRFD-07", "renamed/replaced parent remains pinned while canonical recheck rejects success", async () => {
      const c = await h.context("parent-replace"), moved = `${c.path}-moved`, name = privateLeaf();
      try {
        await c.checkPath(); await rename(c.path, moved); await mkdir(c.path, { mode: 0o700 });
        await writeFile(join(c.path, "canary"), "UNCHANGED", { mode: 0o600 });
        const file = await c.files().create(name); h.observe(await file.stat({ bigint: true })); await file.close();
        assert.ok((await lstat(join(moved, name))).isFile()); await assert.rejects(lstat(join(c.path, name)), { code: "ENOENT" });
        await assert.rejects(c.checkPath()); assert.equal(await readFile(join(c.path, "canary"), "utf8"), "UNCHANGED");
        h.receipt.observations.push({ controlId: "DIRFD-07", pinnedDirectoryUsed: true, canonicalCheckRejected: true, replacementCanaryUnchanged: true });
      } finally { await c.directory.close(); }
    });

    await h.control(t, "DIRFD-08", "queued work keeps its own directory lease through actual completion", async () => {
      const c = await h.context("queue-lease"), name = privateLeaf();
      const pending = h.binding.createAt(...c.args(name)); await c.directory.close();
      const raw = await pending;
      try { const stat = h.observe(descriptorStat(raw)); assert.equal(stat.ino, (await lstat(join(c.path, name), { bigint: true })).ino); }
      finally { closeSync(raw); }
      h.receipt.observations.push({ controlId: "DIRFD-08", originalClosedAfterQueue: true, realCompletionAwaited: true, rawClosed: true });
    });

    for (const kind of ["abort", "deadline"] as const) {
      const id = kind === "abort" ? "DIRFD-09" : "DIRFD-10";
      await h.control(t, id, `${kind} while native promise is pending awaits delivery then closes the returned FD`, async () => {
        const c = await h.context(kind), controller = new AbortController(); let deadline = Infinity, completed = false, raw = -1;
        const tracking: PublicDirectoryNativeBinding = { ...h.binding,
          createAt: async (...args) => { raw = await h.binding.createAt(...args); completed = true; h.observe(descriptorStat(raw)); return raw; } };
        const check = () => {
          if (controller.signal.aborted) throw new MaintenanceFailure("maintenance_lost");
          if (performance.now() >= deadline) throw new MaintenanceFailure("restore_verification_unavailable");
        };
        try {
          const pending = c.files(tracking, check).create(privateLeaf());
          assert.equal(completed, false);
          if (kind === "abort") controller.abort(); else deadline = performance.now() - 1;
          await assert.rejects(pending, { code: kind === "abort" ? "maintenance_lost" : "restore_verification_unavailable" });
          assert.equal(completed, true); assert.throws(() => descriptorStat(raw), { code: "EBADF" });
          h.receipt.observations.push({ controlId: id, nativePendingAtTransition: true, actualCompletionBeforeRejection: true,
            rawClosed: true, transition: kind === "deadline" ? "controlled absolute deadline expiry" : "actual AbortController.abort" });
        } finally { await c.directory.close(); }
      });
    }
  } finally { await h.finish(); }
});

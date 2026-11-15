import test from "node:test";
import assert from "node:assert/strict";
import fs, { constants, fstatSync, closeSync } from "node:fs";
import { mkdtemp, mkdir, open, readFile, readdir, rename, rm, symlink, link, writeFile, chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeRestoreDirectory, restoreDirectory, restoreDirectoryNativePath, RestoreDirectoryFailure,
  type RestoreDirectoryNativeBinding } from "../src/server/storage/maintenance/restore-directory.ts";

const platformTest = ["linux", "darwin"].includes(process.platform) ? test : test.skip;
platformTest("#152 restore directory FD controls use actual pinned directories and native ABI", { timeout: 30_000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "br-restore-dirfd-"));
  try {
    let binary = restoreDirectoryNativePath;
    if (process.platform === "linux") {
      binary = path.join(root, "restore-directory.node");
      await promisify(execFile)("/usr/bin/cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-DNAPI_VERSION=8",
        "-DNODE_GYP_MODULE_NAME=boardroom_restore_directory", "-shared", "-fPIC", "-I", "native/node-api/v24.22.1",
        "native/maintenance-restore-directory.c", "-o", binary], { timeout: 20_000 });
      await chmod(binary, 0o700);
    }
    const binding = createRequire(import.meta.url)(binary) as RestoreDirectoryNativeBinding;
    console.log(JSON.stringify({ component: "restore-directory", platform: process.platform, arch: process.arch,
      node: process.version, napi: process.versions.napi, nativeSha256: createHash("sha256").update(await readFile(binary)).digest("hex"),
      nativeRole: process.platform === "darwin" ? "production" : "portable-ABI-control" }));
    const context = async (label: string) => {
      const directory = path.join(root, label); await mkdir(directory, { mode: 0o700 });
      const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      return { directory, handle, identity: await handle.stat({ bigint: true }) };
    };
    for (const variant of process.platform === "linux" ? ["production", "native"] as const : ["production"] as const) {
      await t.test(`${variant}: parent rename and external symlink cannot redirect mkdir or file writes`, async () => {
        const c = await context(`${variant}-pinned`), outside = path.join(root, `${variant}-outside`), owned = `${c.directory}-owned`;
        try {
          const parent = variant === "production" ? restoreDirectory(c.handle, c.identity) : new NativeRestoreDirectory(c.handle, c.identity, binding);
          if (process.platform === "darwin") assert.ok(parent instanceof NativeRestoreDirectory);
          await mkdir(outside, { mode: 0o700 }); await rename(c.directory, owned); await symlink(outside, c.directory, "dir");
          let created = 0; await parent.mkdir("nested", () => created++); assert.equal(created, 1);
          const nested = await parent.directory("nested");
          try {
            const files = variant === "production" ? restoreDirectory(nested, await nested.stat({ bigint: true }))
              : new NativeRestoreDirectory(nested, await nested.stat({ bigint: true }), binding);
            const output = await files.create("原始 data.bin"), bytes = Buffer.from([0, 255, 128, 10, 0]);
            try { await output.write(bytes, 0, bytes.length, 0); await output.sync(); } finally { await output.close(); }
            const input = await files.read("原始 data.bin");
            try { assert.deepEqual(await input.readFile(), bytes); } finally { await input.close(); }
            assert.deepEqual(await readdir(outside), []);
            assert.deepEqual(await readFile(path.join(owned, "nested", "原始 data.bin")), bytes);
          } finally { await nested.close(); }
        } finally { await c.handle.close(); }
      });
      await t.test(`${variant}: escape, existing entries, links and wrong kinds are rejected`, async () => {
        const c = await context(`${variant}-invalid`);
        try {
          const files = variant === "production" ? restoreDirectory(c.handle, c.identity) : new NativeRestoreDirectory(c.handle, c.identity, binding);
          for (const name of ["", ".", "..", "/escape", "a/b", "a\0b", "x".repeat(4097)])
            await assert.rejects(files.create(name));
          await writeFile(path.join(c.directory, "existing"), "unchanged", { mode: 0o600 });
          await symlink("existing", path.join(c.directory, "symbolic"));
          await link(path.join(c.directory, "existing"), path.join(c.directory, "hard"));
          await mkdir(path.join(c.directory, "directory"), { mode: 0o700 });
          await assert.rejects(files.create("existing"));
          await assert.rejects(files.read("symbolic")); await assert.rejects(files.read("hard"));
          await assert.rejects(files.read("directory")); await assert.rejects(files.directory("existing"));
          let created = false; await assert.rejects(files.mkdir("directory", () => { created = true; })); assert.equal(created, false);
          assert.equal(await readFile(path.join(c.directory, "existing"), "utf8"), "unchanged");
        } finally { await c.handle.close(); }
      });
    }
    await t.test("native boundary independently validates every leaf and parent identity", async () => {
      const c = await context("native-arguments");
      try {
        for (const name of ["", ".", "..", "/escape", "a/b", "a\0b", "x".repeat(4097)])
          assert.throws(() => binding.createAt(c.handle.fd, name, c.identity.dev, c.identity.ino));
        await assert.rejects(binding.mkdirAt(c.handle.fd, "wrong", c.identity.dev, c.identity.ino + 1n), { code: "ERR_DIRECTORY_IDENTITY" });
        await assert.rejects(binding.createAt(c.handle.fd, "wrong", c.identity.dev, c.identity.ino + 1n), { code: "ERR_DIRECTORY_IDENTITY" });
        await chmod(c.directory, 0o750);
        await assert.rejects(binding.mkdirAt(c.handle.fd, "wrong", c.identity.dev, c.identity.ino), { code: "ERR_DIRECTORY_IDENTITY" });
        assert.deepEqual(await readdir(c.directory), []);
      } finally { await c.handle.close(); }
    });
    await t.test("native work duplicates its directory lease before the caller closes the original", async () => {
      const c = await context("native-lease");
      const result = binding.createAt(c.handle.fd, "owned", c.identity.dev, c.identity.ino);
      await c.handle.close(); const raw = await result;
      try { assert.ok(fstatSync(raw).isFile()); } finally { closeSync(raw); }
      assert.deepEqual(await readdir(c.directory), ["owned"]);
    });
    await t.test("native mkdir reports its created residue even when subsequent descriptor close fails", async () => {
      const c = await context("native-mkdir-close");
      const failure = Object.assign(new Error("owned-directory-close-failure"), { created: true, syscall: "close-borrowed-directory" });
      try {
        const tracked = { ...binding, mkdirAt: async (...args: Parameters<RestoreDirectoryNativeBinding["mkdirAt"]>) => {
          await binding.mkdirAt(...args); throw failure;
        } } as RestoreDirectoryNativeBinding;
        let created = false;
        await assert.rejects(new NativeRestoreDirectory(c.handle, c.identity, tracked).mkdir("owned", () => { created = true; }), (error: unknown) => {
          assert.ok(error instanceof RestoreDirectoryFailure); assert.equal(error.cause, failure); assert.equal(error.closing, true); return true;
        });
        assert.equal(created, true); assert.deepEqual(await readdir(c.directory), ["owned"]);
      } finally { await c.handle.close(); }
    });
    await t.test("native metadata failure closes the raw descriptor and preserves the first cause", async child => {
      const c = await context("native-metadata"), failure = new Error("owned-metadata-failure"); let raw = -1;
      try {
        const tracked = { ...binding, createAt: async (...args: Parameters<RestoreDirectoryNativeBinding["createAt"]>) => {
          raw = await binding.createAt(...args); return raw;
        } } as RestoreDirectoryNativeBinding;
        const actual = fs.fstat;
        child.mock.method(fs, "fstat", ((...args: unknown[]) => {
          if (args[0] === raw) { queueMicrotask(() => (args.at(-1) as (error: Error) => void)(failure)); return; }
          return Reflect.apply(actual, fs, args);
        }) as typeof fs.fstat); syncBuiltinESMExports();
        await assert.rejects(new NativeRestoreDirectory(c.handle, c.identity, tracked).create("owned"), (error: unknown) => {
          assert.ok(error instanceof RestoreDirectoryFailure); assert.equal(error.cause, failure); assert.deepEqual(error.closeErrors, []); return true;
        });
        assert.throws(() => fstatSync(raw), { code: "EBADF" });
      } finally { child.mock.restoreAll(); syncBuiltinESMExports(); await c.handle.close(); }
    });
    await t.test("native raw close failure prevents adoption success", async child => {
      const c = await context("native-close"), failure = new Error("owned-raw-close-failure"); let raw = -1;
      try {
        const tracked = { ...binding, createAt: async (...args: Parameters<RestoreDirectoryNativeBinding["createAt"]>) => {
          raw = await binding.createAt(...args); return raw;
        } } as RestoreDirectoryNativeBinding;
        const actual = fs.close;
        child.mock.method(fs, "close", ((fd: number, callback: (error?: NodeJS.ErrnoException | null) => void) => {
          actual(fd, error => callback(error ?? (fd === raw ? failure : null)));
        }) as typeof fs.close); syncBuiltinESMExports();
        await assert.rejects(new NativeRestoreDirectory(c.handle, c.identity, tracked).create("owned"), (error: unknown) => {
          assert.ok(error instanceof RestoreDirectoryFailure); assert.equal(error.cause, failure); assert.equal(error.closing, true); return true;
        });
        assert.throws(() => fstatSync(raw), { code: "EBADF" });
      } finally { child.mock.restoreAll(); syncBuiltinESMExports(); await c.handle.close(); }
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, fstatSync, readdirSync, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile, type FileHandle } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { NativePublicDirectory, loadPublicDirectoryNative, publicDirectoryNativePath,
  type PublicDirectoryNativeBinding } from "../../src/server/storage/maintenance/postgres-public-directory.ts";

type Status = "NOT_RUN" | "PASS" | "FAIL" | "BLOCKED";
type Receipt = {
  suite: "core" | "socket"; status: Status;
  runtime: { platform: string; arch: string; node: string; uid: number | null; napi: string | null };
  headers: { upstreamVersion: string; napiVersion: number };
  binary?: Record<string, unknown>; build?: Record<string, unknown>; sourceSha256: Record<string, string>;
  controls: { id: string; status: Status; error?: string }[]; observations: Record<string, unknown>[];
  nativeAttempted: boolean; fixtureCreated?: boolean; fixtureStatus?: string;
  remainingOwnedDescriptors: { fd: number; identity: string }[]; ownedFixtureRemoved: boolean;
};
const root = fileURLToPath(new URL("../../", import.meta.url));
const fields = ["dev", "ino", "mode", "uid", "nlink", "size", "mtimeNs", "ctimeNs"] as const;
export const statProjection = (stat: Pick<BigIntStats, typeof fields[number]>) => Object.fromEntries(fields.map(field => [field, String(stat[field])]));
export const privateLeaf = (suffix = "archive.dump") => `.public-${randomUUID()}-${suffix}`;
const key = (stat: Pick<BigIntStats, "dev" | "ino">) => `${stat.dev}:${stat.ino}`;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export async function publicDirectoryControls(suite: "core" | "socket") {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "br-pgfd-")));
  await chmod(fixture, 0o700);
  const receipt: Receipt = { suite, status: "NOT_RUN", runtime: { platform: process.platform, arch: process.arch,
    node: process.version, uid: process.getuid?.() ?? null, napi: process.versions.napi ?? null },
    headers: { upstreamVersion: "v24.22.1", napiVersion: 8 }, sourceSha256: {},
    controls: (suite === "core" ? Array.from({ length: 10 }, (_, i) => `DIRFD-${String(i + 1).padStart(2, "0")}`) : ["DIRFD-11"])
      .map(id => ({ id, status: "NOT_RUN" })), observations: [], nativeAttempted: false,
    remainingOwnedDescriptors: [], ownedFixtureRemoved: false };
  const owned = new Set<string>();
  const observe = (stat: BigIntStats) => { owned.add(key(stat)); return stat; };
  observe(await lstat(fixture, { bigint: true }));
  let output: string | undefined;
  const save = async () => {
    if (output) await writeFile(join(output, `public-directory-${suite}.json`), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  };
  const finish = async () => {
    receipt.remainingOwnedDescriptors = readdirSync(process.platform === "darwin" ? "/dev/fd" : "/proc/self/fd")
      .filter(name => /^\d+$/.test(name)).flatMap(name => {
        try { const info = fstatSync(Number(name), { bigint: true }); return owned.has(key(info)) ? [{ fd: Number(name), identity: key(info) }] : []; }
        catch (error) { if (["EBADF", "ENOENT"].includes(String((error as NodeJS.ErrnoException).code))) return []; throw error; }
      });
    await rm(fixture, { recursive: true, force: true });
    try { await lstat(fixture); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") receipt.ownedFixtureRemoved = true; else throw error; }
    if (receipt.status !== "BLOCKED") receipt.status = receipt.controls.every(control => control.status === "PASS")
      && receipt.remainingOwnedDescriptors.length === 0 && receipt.ownedFixtureRemoved ? "PASS" : "FAIL";
    await save();
    assert.deepEqual(receipt.remainingOwnedDescriptors, []); assert.equal(receipt.ownedFixtureRemoved, true);
  };
  let actual: PublicDirectoryNativeBinding;
  try {
    if (process.env.BOARDROOM_PUBLIC_DIRECTORY_EVIDENCE) {
      output = process.env.BOARDROOM_PUBLIC_DIRECTORY_EVIDENCE;
      assert.equal(resolve(output), output); assert.equal(await realpath(output), output);
      assert.ok((await lstat(output)).isDirectory());
    }
    assert.notEqual(process.getuid?.(), 0, "native directory controls require a non-root account");
    assert.ok(["linux", "darwin"].includes(process.platform));
    const sources = ["native/postgres-public-directory.c", "native/README.md", "scripts/build-maintenance-platform.mjs",
      "src/server/storage/maintenance/postgres-public-directory.ts", "src/server/storage/maintenance/postgres-public-restore.ts",
      "tests/maintenance-postgres-public-directory.test.ts", "tests/maintenance-postgres-public-directory.acceptance.ts",
      "tests/fixtures/postgres-public-directory-controls.ts"];
    const headers = join(root, "native/node-api/v24.22.1");
    const index = JSON.parse(await readFile(join(headers, "SOURCES.json"), "utf8")) as {
      upstreamVersion: string; napiVersion: number; files: { name: string; sha256: string }[] };
    assert.equal(index.upstreamVersion, receipt.headers.upstreamVersion); assert.equal(index.napiVersion, receipt.headers.napiVersion);
    assert.deepEqual(index.files.map(file => file.name).sort(), ["LICENSE", "js_native_api.h", "js_native_api_types.h", "node_api.h", "node_api_types.h"]);
    for (const file of index.files) {
      assert.equal(sha(await readFile(join(headers, file.name))), file.sha256);
      sources.push(`native/node-api/v24.22.1/${file.name}`);
    }
    sources.push("native/node-api/v24.22.1/SOURCES.json");
    for (const source of sources) receipt.sourceSha256[source] = sha(await readFile(join(root, source)));
    let binary: string;
    if (process.platform === "darwin") { binary = publicDirectoryNativePath; actual = loadPublicDirectoryNative(); }
    else {
      binary = join(fixture, "postgres-public-directory-linux-control.node");
      const args = ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-DNAPI_VERSION=8", "-DNODE_GYP_MODULE_NAME=boardroom_public_directory",
        "-shared", "-fPIC", "-I", headers, join(root, "native/postgres-public-directory.c"), "-o", binary];
      const built = spawnSync("cc", args, { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 });
      receipt.build = { program: "cc", args, status: built.status, signal: built.signal, error: built.error?.message ?? null,
        stdout: built.stdout, stderr: built.stderr, purpose: "actual Linux portable mechanism; not Darwin qualification" };
      if (built.error) throw built.error;
      assert.equal(built.status, 0, built.stderr); assert.equal(built.error, undefined); assert.equal(built.signal, null);
      await chmod(binary, 0o700); actual = createRequire(import.meta.url)(binary) as PublicDirectoryNativeBinding;
    }
    const info = await lstat(binary, { bigint: true });
    assert.ok(info.isFile()); assert.equal(info.mode & 0o777n, 0o700n); assert.equal(info.nlink, 1n);
    assert.equal(info.uid, BigInt(process.getuid!())); assert.equal(await realpath(binary), binary);
    receipt.binary = { path: binary, sha256: sha(await readFile(binary)), mode: Number(info.mode & 0o777n), uid: Number(info.uid),
      nlink: Number(info.nlink), device: String(info.dev), inode: String(info.ino), productionDarwinArtifact: process.platform === "darwin" };
  } catch (error) {
    receipt.status = (error as NodeJS.ErrnoException).code === "ENOENT" ? "BLOCKED" : "FAIL";
    receipt.observations.push({ phase: "setup", error: String(error) });
    await finish(); throw error;
  }
  const binding: PublicDirectoryNativeBinding = {
    createAt: (...args) => { receipt.nativeAttempted = true; return actual.createAt(...args); },
    readAt: (...args) => { receipt.nativeAttempted = true; return actual.readAt(...args); },
    statAt: (...args) => { receipt.nativeAttempted = true; return actual.statAt(...args); },
  };
  const context = async (name: string) => {
    const path = join(fixture, name); await mkdir(path, { mode: 0o700 });
    const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const identity = observe(await directory.stat({ bigint: true }));
    const args = (name: string): [number, string, bigint, bigint] => [directory.fd, name, identity.dev, identity.ino];
    const checkPath = async () => {
      const current = await lstat(path, { bigint: true });
      assert.ok(current.isDirectory() && !current.isSymbolicLink());
      assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino);
      assert.equal(current.mode & 0o777n, 0o700n); assert.equal(await realpath(path), path);
    };
    const files = (override = binding, check = () => {}) => new NativePublicDirectory(directory, identity, override, check);
    return { path, directory, identity, args, checkPath, files };
  };
  const control = async (t: TestContext, id: string, description: string, run: (context: TestContext) => Promise<void>) => {
    const entry = receipt.controls.find(control => control.id === id); assert.ok(entry);
    await t.test(`${id} ${description}`, { timeout: 5000 }, async child => {
      try { await run(child); entry.status = "PASS"; }
      catch (error) { entry.status = receipt.status === "BLOCKED" ? "BLOCKED" : "FAIL"; entry.error = String(error); throw error; }
    });
  };
  return { fixture, receipt, binding, context, observe, control, finish };
}

export const descriptorStat = (fd: number) => fstatSync(fd, { bigint: true });
export async function readPosition(handle: FileHandle, length: number, position: number | null = null): Promise<string> {
  const bytes = Buffer.alloc(length), result = await handle.read(bytes, 0, length, position);
  return bytes.subarray(0, result.bytesRead).toString("utf8");
}

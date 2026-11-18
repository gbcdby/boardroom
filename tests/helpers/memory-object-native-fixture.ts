import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, realpath, statfs } from "node:fs/promises";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";

const execute = promisify(execFile);
export const memoryNativeProject = fileURLToPath(new URL("../../", import.meta.url));
export const supportedMemoryNativePlatform = process.platform === "linux" || process.platform === "darwin";

export interface ResourceObservation {
  pending: number; fdReserved: number; fdOwned: number; fdUnknown: number;
  nativeTasks: number; preparedFiles: number; bodyBytes: number;
}
export interface NativeFailure {
  kind: "failed";
  primary: { code: string; stage: string; call: { kind: string; rc: number | null; errno: number | null } };
  cleanup: readonly NativeFailure["primary"][];
  retained: object | null;
  resources: ResourceObservation | null;
}
export interface NativeRef {
  objectFormat: "utf8-sha256-v1"; storageId: string; contentSha256: string; byteLength: number;
}
export type NativeResult = NativeFailure | {
  kind: "prepared-file"; file: object; ref: NativeRef; publication: "created" | "reused";
  resources: ResourceObservation;
} | { kind: "read"; markdown: string; ref: NativeRef; resources: ResourceObservation }
  | { kind: "file-current" | "closed"; resources: ResourceObservation };
export interface MemoryNativeMechanical {
  abiInfo(): Readonly<{ contract: "memory-native-mechanical/r1"; napi: 8; rootFactory: "not-installed";
    pendingLimit: 8; fdLimit: 64; bodyLimit: 1048576 }>;
  prepare(root: object, markdown: unknown): Promise<NativeResult>;
  readVerify(root: object, contentSha256: unknown, byteLength: unknown): Promise<NativeResult>;
  revalidatePrepared(file: object): Promise<NativeResult>;
  closePrepared(file: object): Promise<NativeResult>;
  closeRoot(root: object): Promise<NativeResult>;
  observeRoot(root: object): { state: "open" | "closing" | "retained" | "closed"; resources: ResourceObservation };
}

let normal: Promise<MemoryNativeMechanical> | undefined;
export function buildNormalMemoryNative(): Promise<MemoryNativeMechanical> {
  return normal ??= (async () => {
    await execute(process.execPath, ["scripts/build-memory-objects.mjs"], {
      cwd: memoryNativeProject, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    });
    const file = path.join(memoryNativeProject, "build", "memory-objects",
      `memory-objects-${process.platform}-${process.arch}.node`);
    const info = await lstat(file);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o700)
      throw new Error("memory native build identity mismatch");
    return createRequire(import.meta.url)(file) as MemoryNativeMechanical;
  })();
}

export interface MemoryNativeFixture extends MemoryNativeMechanical {
  fixtureOpenRoot(absolutePath: unknown, storageId: unknown, maxDocumentBytes: unknown): object;
  fixtureSetFaults(root: object, plans: readonly { point: string; occurrence: number; action: string; errno?: string }[]): void;
  fixtureRelease(root: object, point: string): void;
  fixtureFdSnapshot(root: object): readonly { fd: number; state: string; role: string }[];
  fixtureFillFdBoundary(root: object): object;
  fixtureCloseFdHold(hold: object): NativeResult;
  fixtureTrace(root: object): readonly { point: string; syscall: string; rc: number; errno: number; flags: number; injected: boolean; operation: number; calls: number }[];
}
let fixture: Promise<{ native: MemoryNativeFixture; file: string; directory: string }> | undefined;
export function buildMemoryNativeFixture() {
  return fixture ??= (async () => {
    await buildNormalMemoryNative();
    const directory = await mkdtemp(path.join(os.tmpdir(), "boardroom-memory-native-addon-"));
    const file = path.join(directory, "memory-fixture.node");
    const args = ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-DNAPI_VERSION=8",
      "-DNODE_GYP_MODULE_NAME=boardroom_memory_fixture", "-pthread",
      ...(process.platform === "linux" ? ["-shared", "-fPIC"] : ["-bundle", "-undefined", "dynamic_lookup"]),
      "-I", path.join(memoryNativeProject, "native", "node-api", "v24.22.1"),
      path.join(memoryNativeProject, "tests", "helpers", "memory-object-native-fixture.c"), "-o", file,
      ...(process.platform === "linux" ? ["-ldl"] : [])];
    await execute("/usr/bin/cc", args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    const normalFile = path.join(memoryNativeProject, "build", "memory-objects", `memory-objects-${process.platform}-${process.arch}.node`);
    const [core, fixtureSource, normalBytes, fixtureBytes, compiler, fs] = await Promise.all([
      readFile(path.join(memoryNativeProject, "native", "memory-objects.c")),
      readFile(path.join(memoryNativeProject, "tests", "helpers", "memory-object-native-fixture.c")),
      readFile(normalFile), readFile(file), execute("/usr/bin/cc", ["--version"]), statfs(directory),
    ]);
    const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    console.log("memory-native-build", JSON.stringify({ coreSha256: sha256(core), fixtureSourceSha256: sha256(fixtureSource),
      normalSha256: sha256(normalBytes), fixtureSha256: sha256(fixtureBytes), normalFile, fixtureFile: file,
      node: process.version, runtimeNapi: process.versions.napi, targetNapi: 8, platform: process.platform,
      arch: process.arch, osRelease: os.release(), filesystemType: fs.type, uid: process.getuid?.(),
      compiler: compiler.stdout.split("\n")[0] }));
    return { native: createRequire(import.meta.url)(file) as MemoryNativeFixture, file, directory };
  })();
}
export async function createMemoryRoot() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "boardroom-memory-root-")));
  await mkdir(path.join(directory, "objects"), { mode: 0o700 });
  await mkdir(path.join(directory, "objects", "sha256"), { mode: 0o700 });
  await mkdir(path.join(directory, "objects", ".staging"), { mode: 0o700 });
  return directory;
}

export async function runMemoryChild(file: string, directory: string, body: string) {
  const result = await execute(process.execPath, ["--expose-gc", "--input-type=module", "-e",
    `import assert from 'node:assert/strict'; import { createRequire } from 'node:module';
     import fs from 'node:fs'; import path from 'node:path'; import { Worker } from 'node:worker_threads';
     const [file, directory] = process.argv.slice(1); ${body}`, file, directory],
  { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  return result.stdout;
}

export function memoryWorker(file: string, directory: string, storage = "workers") {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const n = require(workerData.file), root = n.fixtureOpenRoot(workerData.directory, workerData.storage, 1048576);
    let pending = [], files = [];
    parentPort.on('message', async ({id, action, value}) => {
      try {
        let result;
        if (action === 'begin') { pending = value.map(body => n.prepare(root, body)); result = n.observeRoot(root); }
        else if (action === 'finish') { result = await Promise.all(pending); files = result.filter(r => r.kind === 'prepared-file').map(r => r.file); }
        else if (action === 'prepare') { result = await n.prepare(root, value); if(result.kind === 'prepared-file') files.push(result.file); }
        else if (action === 'closeFiles') { result = await Promise.all(files.map(f => n.closePrepared(f))); files = []; }
        else if (action === 'close') result = await n.closeRoot(root);
        else if (action === 'closeAgain') { const first=n.closeRoot(root), second=n.closeRoot(root); result={same:first===second,result:await first}; }
        else if (action === 'observe') result = n.observeRoot(root);
        else if (action === 'faults') result = n.fixtureSetFaults(root, value);
        else if (action === 'release') result = n.fixtureRelease(root, value);
        else if (action === 'acquire') result = n.fixtureOpenRoot(workerData.directory, value.storage, value.maximum);
        else throw new Error('unknown test action');
        parentPort.postMessage({id, result});
      } catch(error) { parentPort.postMessage({id, error: error.message}); }
    });`, { eval: true, workerData: { file, directory, storage } });
  let next = 0;
  const replies = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  worker.on("message", (message: { id: number; result?: unknown; error?: string }) => {
    const reply = replies.get(message.id); replies.delete(message.id);
    if (message.error) reply?.reject(new Error(message.error)); else reply?.resolve(message.result);
  });
  worker.on("error", error => { for (const reply of replies.values()) reply.reject(error); replies.clear(); });
  return { worker, request<T = unknown>(action: string, value?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = ++next; replies.set(id, { resolve: result => resolve(result as T), reject });
      worker.postMessage({ id, action, value });
    });
  } };
}

export async function waitForNative(predicate: () => boolean) {
  const until = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= until) throw new Error("native condition was not observed");
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

export async function buildMemoryPinFailure(variant: "missing" | "wrong-image") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boardroom-memory-pin-"));
  const file = path.join(directory, "memory-pin-failure.node");
  await execute("/usr/bin/cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-DNAPI_VERSION=8",
    "-DNODE_GYP_MODULE_NAME=boardroom_memory_pin_failure", "-pthread",
    variant === "missing" ? "-DMO_FIXTURE_PIN_FAILURE=1" : "-DMO_FIXTURE_PIN_WRONG_IMAGE=1",
    ...(process.platform === "linux" ? ["-shared", "-fPIC"] : ["-bundle", "-undefined", "dynamic_lookup"]),
    "-I", path.join(memoryNativeProject, "native", "node-api", "v24.22.1"),
    path.join(memoryNativeProject, "tests", "helpers", "memory-object-native-fixture.c"), "-o", file,
    ...(process.platform === "linux" ? ["-ldl"] : [])], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  return { file, directory };
}

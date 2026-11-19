import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { linuxMappedSourceHandles, parseLinuxMappings } from "../src/server/storage/maintenance/linux-mappings.ts";
import { withSelfMapsDiagnostics } from "./fixtures/maintenance-self-maps-diagnostic.ts";

const valid = "1000-2000 r--p 00000000 00:00 0 /a-path\n";

test("#222 same-read maps witness observes the actual native proc reader", async t => {
  if (process.platform !== "linux") { t.skip("Linux proc reader"); return; }
  const directory = await mkdtemp(path.join(tmpdir(), "br-self-maps-native-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = new Error("capture after original successful read");
  await assert.rejects(withSelfMapsDiagnostics(async () => {
    const value = linuxMappedSourceHandles("/proc/self", []);
    assert.equal(value.empty, false); assert.equal(value.handles.size, 0);
    throw marker;
  }, directory), error => error === marker);
  const names = await readdir(directory), destination = path.join(directory, names[0]!);
  const report = JSON.parse(await readFile(path.join(destination, "report.json"), "utf8"));
  assert.equal(report.openCount, 1); assert.equal(report.captures.length, 1);
  const capture = report.captures[0]; assert.equal(capture.complete, true);
  const bytes = await readFile(path.join(destination, capture.bytesFile));
  assert.ok(parseLinuxMappings(bytes.toString("latin1")).length > 0);
  assert.equal(capture.headerAnalysis.firstRejection, null);
});

test("#222 setup and overlapping-scope gaps remain diagnostic gaps without changing operation outcomes", async t => {
  if (process.platform !== "linux") { t.skip("Linux maps witness"); return; }
  const directory = await mkdtemp(path.join(tmpdir(), "br-self-maps-setup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const descriptor = Object.getOwnPropertyDescriptor(fs, "openSync")!, original = fs.openSync, result = {};
  let calls = 0;
  try {
    Object.defineProperty(fs, "openSync", { ...descriptor, writable: false });
    assert.strictEqual(await withSelfMapsDiagnostics(async () => { calls++; return result; }, path.join(directory, "setup")), result);
    assert.strictEqual(fs.openSync, original);
  } finally { Object.defineProperty(fs, "openSync", descriptor); syncBuiltinESMExports(); }
  const setupNames = await readdir(path.join(directory, "setup"));
  const setup = JSON.parse(await readFile(path.join(directory, "setup", setupNames[0]!, "report.json"), "utf8"));
  assert.equal(setup.setupComplete, false); assert.equal(calls, 1);
  assert.strictEqual(await withSelfMapsDiagnostics(async () => {
    assert.strictEqual(await withSelfMapsDiagnostics(async () => { calls++; return result; }, path.join(directory, "inner")), result);
    return result;
  }, path.join(directory, "outer")), result);
  assert.equal(calls, 2); assert.strictEqual(fs.openSync, original);
  const outerNames = await readdir(path.join(directory, "outer"));
  const outer = JSON.parse(await readFile(path.join(directory, "outer", outerNames[0]!, "report.json"), "utf8"));
  assert.equal(outer.skippedScopes, 1); assert.equal(outer.restorationErrors, 0);
  assert.deepEqual((await readdir(directory)).sort(), ["outer", "setup"]);
});

for (const [label, raw, expected] of [
  ["end", "2000-2000 r--p 00000000 00:00 0\n", "end-not-after-start"],
  ["overlap", "1000-3000 r--p 00000000 00:00 0\n2000-4000 r--p 00000000 00:00 0\n", "start-before-previous-end"],
  ["inode", "1000-2000 r--p 00000000 00:00 18446744073709551616\n", "inode-over-uint64"],
] as const) {
  test(`#222 same-read maps witness identifies ${label} while preserving the actual parser failure`, async t => {
    if (process.platform !== "linux") { t.skip("Linux maps witness"); return; }
    const directory = await mkdtemp(path.join(tmpdir(), "br-self-maps-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const bytes = Buffer.from(raw), original = { open: fs.openSync, read: fs.readSync, close: fs.closeSync };
    let cursor = 0, opens = 0, reads = 0, closes = 0, parserError: unknown;
    const fd = 984;
    t.mock.method(fs, "openSync", function(this: unknown, ...args: unknown[]) {
      if (args[0] !== "/proc/self/maps") return Reflect.apply(original.open, this, args);
      opens++; return fd;
    } as typeof fs.openSync);
    t.mock.method(fs, "readSync", function(this: unknown, ...args: unknown[]) {
      if (args[0] !== fd) return Reflect.apply(original.read, this, args);
      reads++; const n = Math.min(7, bytes.length - cursor);
      bytes.copy(args[1] as Buffer, args[2] as number, cursor, cursor + n); cursor += n; return n;
    } as typeof fs.readSync);
    t.mock.method(fs, "closeSync", function(this: unknown, ...args: unknown[]) {
      if (args[0] !== fd) return Reflect.apply(original.close, this, args);
      closes++;
    } as typeof fs.closeSync);
    syncBuiltinESMExports();
    const before = { open: fs.openSync, read: fs.readSync, close: fs.closeSync };
    try {
      await assert.rejects(withSelfMapsDiagnostics(async () => {
        try { linuxMappedSourceHandles("/proc/self", []); }
        catch (error) { parserError = error; throw error; }
      }, directory), error => error === parserError && (error as Error).message === "linux_mapping_inventory_unavailable");
      assert.equal(opens, 1); assert.equal(reads, Math.ceil(bytes.length / 7) + 1); assert.equal(closes, 1);
      assert.strictEqual(fs.openSync, before.open); assert.strictEqual(fs.readSync, before.read); assert.strictEqual(fs.closeSync, before.close);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    const names = await readdir(directory); assert.equal(names.length, 1);
    const report = JSON.parse(await readFile(path.join(directory, names[0]!, "report.json"), "utf8"));
    assert.equal(report.setupComplete, true); assert.equal(report.restorationErrors, 0); assert.equal(report.operationThrew, true);
    assert.equal(report.captures.length, 1);
    const capture = report.captures[0];
    assert.equal(capture.complete, true); assert.equal(capture.eof, true); assert.equal(capture.closed, true);
    assert.equal(capture.reads.length, reads); assert.equal(capture.observedBytes, bytes.length);
    assert.equal(capture.headerAnalysis.firstRejection.reason, expected);
    assert.deepEqual(await readFile(path.join(directory, names[0]!, capture.bytesFile)), bytes);
    let at = 0;
    for (const read of capture.reads) { assert.equal(read.capturedOffset, at); at += read.capturedBytes; }
    assert.equal(at, bytes.length);
    assert.equal(capture.headerAnalysis.firstRejection.line, label === "overlap" ? 2 : 1);
  });
}

for (const scenario of ["success", "open-throw", "read-throw", "close-throw", "operation-undefined", "output-failure",
  "byte-limit", "read-limit", "capture-limit", "no-hot-buffer-allocation"] as const) {
  test(`#222 same-read maps witness preserves ${scenario} outcome and bounded resources`, async t => {
    if (process.platform !== "linux") { t.skip("Linux maps witness"); return; }
    const directory = await mkdtemp(path.join(tmpdir(), "br-self-maps-controls-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const output = path.join(directory, "output"), marker = new Error("original operation"), result = { same: true };
    if (scenario === "output-failure") await writeFile(output, "not a directory");
    const bytes = scenario === "byte-limit" ? Buffer.alloc(1024 * 1024 + 37, 49) : Buffer.from(valid);
    const buffer = Buffer.alloc(64 * 1024), original = { open: fs.openSync, read: fs.readSync, close: fs.closeSync };
    let cursor = 0, opens = 0, reads = 0, closes = 0;
    const fd = 985;
    t.mock.method(fs, "openSync", function(this: unknown, ...args: unknown[]) {
      if (args[0] !== "/proc/self/maps") return Reflect.apply(original.open, this, args);
      opens++; if (scenario === "open-throw") throw marker; cursor = 0; return fd;
    } as typeof fs.openSync);
    t.mock.method(fs, "readSync", function(this: unknown, ...args: unknown[]) {
      if (args[0] !== fd) return Reflect.apply(original.read, this, args);
      reads++; if (scenario === "read-throw") throw marker;
      const n = scenario === "read-limit" ? 1 : Math.min(args[3] as number, bytes.length - cursor);
      if (scenario === "read-limit") (args[1] as Buffer)[args[2] as number] = 49;
      else bytes.copy(args[1] as Buffer, args[2] as number, cursor, cursor + n);
      cursor += n; return n;
    } as typeof fs.readSync);
    t.mock.method(fs, "closeSync", function(this: unknown, ...args: unknown[]) {
      if (args[0] !== fd) return Reflect.apply(original.close, this, args);
      closes++; if (scenario === "close-throw") throw marker;
    } as typeof fs.closeSync);
    syncBuiltinESMExports();
    const before = { open: fs.openSync, read: fs.readSync, close: fs.closeSync };
    try {
      const operation = withSelfMapsDiagnostics(async () => {
        const saved = { from: Buffer.from, alloc: Buffer.alloc, unsafe: Buffer.allocUnsafe, subarray: Buffer.prototype.subarray };
        if (scenario === "no-hot-buffer-allocation") {
          const forbidden = () => { throw new Error("hot allocation forbidden"); };
          Buffer.from = forbidden; Buffer.alloc = forbidden; Buffer.allocUnsafe = forbidden; Buffer.prototype.subarray = forbidden;
        }
        try {
          for (let pass = 0; pass < (scenario === "capture-limit" ? 6 : 1); pass++) {
            const opened = fs.openSync("/proc/self/maps", fs.constants.O_RDONLY);
            try {
              if (scenario === "read-limit") for (let i = 0; i < 4098; i++) assert.equal(fs.readSync(opened, buffer, 0, 1, null), 1);
              else while (fs.readSync(opened, buffer, 0, buffer.length, null) !== 0) { /* Original caller, no extra diagnostic read. */ }
            } finally { fs.closeSync(opened); }
          }
        } finally {
          Buffer.from = saved.from; Buffer.alloc = saved.alloc; Buffer.allocUnsafe = saved.unsafe; Buffer.prototype.subarray = saved.subarray;
        }
        if (scenario === "success") return result;
        throw scenario === "operation-undefined" ? undefined : marker;
      }, output);
      if (scenario === "success") assert.strictEqual(await operation, result);
      else await assert.rejects(operation, error => error === (scenario === "operation-undefined" ? undefined : marker));
      assert.strictEqual(fs.openSync, before.open); assert.strictEqual(fs.readSync, before.read); assert.strictEqual(fs.closeSync, before.close);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    assert.equal(opens, scenario === "capture-limit" ? 6 : 1);
    assert.equal(closes, scenario === "open-throw" ? 0 : opens);
    assert.equal(reads, scenario === "open-throw" ? 0 : scenario === "read-throw" ? 1 : scenario === "read-limit" ? 4098
      : opens * (Math.ceil(bytes.length / buffer.length) + 1));
    if (scenario === "success") { assert.deepEqual(await readdir(directory), []); return; }
    if (scenario === "output-failure") { assert.equal(await readFile(output, "utf8"), "not a directory"); return; }
    const names = await readdir(output), destination = path.join(output, names[0]!);
    assert.equal(names.length, 1);
    const report = JSON.parse(await readFile(path.join(destination, "report.json"), "utf8"));
    assert.ok(report.captures.length <= 4);
    assert.equal(report.evictedCaptures, scenario === "capture-limit" ? 2 : 0);
    if (scenario === "capture-limit") assert.deepEqual(report.captures.map((c: { ordinal: number }) => c.ordinal), [3, 4, 5, 6]);
    if (scenario === "open-throw") assert.equal(report.openErrors, 1);
    let capturedBytes = 0;
    for (const capture of report.captures) {
      assert.ok(capture.capturedBytes <= 1024 * 1024); assert.ok(capture.reads.length <= 4096); capturedBytes += capture.capturedBytes;
      assert.equal(capture.complete, !["read-throw", "close-throw", "byte-limit", "read-limit"].includes(scenario));
      assert.equal((await readFile(path.join(destination, capture.bytesFile))).length, capture.capturedBytes);
      if (scenario === "byte-limit") { assert.equal(capture.truncated, true); assert.equal(capture.capturedBytes, 1024 * 1024); }
      if (scenario === "read-limit") { assert.equal(capture.droppedReads, 2); assert.equal(capture.truncated, true); }
      if (scenario === "no-hot-buffer-allocation") assert.equal(capture.complete, true);
    }
    assert.ok(capturedBytes <= 4 * 1024 * 1024);
  });
}

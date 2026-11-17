import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withSqliteSourceCloseDiagnostics } from "./fixtures/maintenance-source-close-diagnostic.ts";
import { withSqliteSourceInventoryDiagnostics } from "./fixtures/maintenance-source-inventory-diagnostic.ts";

for (const kind of ["inventory", "source-close"] as const) {
  test(`#152 ${kind} diagnostic output cannot change the original operation`, async t => {
    if (kind === "inventory" && process.platform !== "linux") { t.skip("Linux inventory diagnostics"); return; }
    for (const scenario of ["setup-failure", "report-failure", "report-success"] as const) await t.test(scenario, async st => {
      const directory = await mkdtemp(path.join(tmpdir(), "br-diagnostic-output-"));
      st.after(() => rm(directory, { recursive: true, force: true }));
      const output = path.join(directory, "diagnostics"), sourceFile = path.join(directory, "source.sqlite");
      const operationError = Object.assign(new Error("original operation sentinel"), { code: "EIO" });
      const boundaryError = Object.assign(new Error("original close sentinel"), { code: "EIO" });
      const outputError = Object.assign(new Error("diagnostic output sentinel"), { code: "EPIPE" });
      const blockers = [{ code: "source_writer_unknown", subjectRef: `unreadable-process:${process.pid}` }];
      const returned = { originalResult: true };
      let operationCalls = 0, boundaryCalls = 0, nativeCloseCalls = 0;
      const db = { name: sourceFile, close() { nativeCloseCalls++; throw boundaryError; } };
      const adapter = {
        inspectCurrentWriters() { boundaryCalls++; return Promise.resolve(blockers); },
        closeSource(source: { close(): void }) { boundaryCalls++; source.close(); },
      };
      const originalInspect = adapter.inspectCurrentWriters, originalClose = adapter.closeSource, nativeClose = db.close;
      const stderrWrite = process.stderr.write;
      let observedResult: unknown, observedError: unknown;
      try {
        if (scenario === "report-failure") await writeFile(output, "not a directory");
        if (scenario === "setup-failure") Object.freeze(adapter);
        process.stderr.write = () => { throw outputError; };
        const operation = async () => {
          operationCalls++;
          if (kind === "inventory") assert.strictEqual(await adapter.inspectCurrentWriters(), blockers);
          else assert.throws(() => adapter.closeSource(db), error => error === boundaryError);
          if (scenario === "report-failure") throw operationError;
          return returned;
        };
        try {
          observedResult = kind === "inventory"
            ? await withSqliteSourceInventoryDiagnostics(adapter, operation, output)
            : await withSqliteSourceCloseDiagnostics("control", sourceFile, adapter, operation, output);
        } catch (error) { observedError = error; }
      } finally { process.stderr.write = stderrWrite; }
      assert.equal(operationCalls, 1);
      assert.equal(boundaryCalls, 1);
      assert.equal(nativeCloseCalls, kind === "source-close" ? 1 : 0);
      assert.strictEqual(adapter.inspectCurrentWriters, originalInspect);
      assert.strictEqual(adapter.closeSource, originalClose);
      assert.strictEqual(db.close, nativeClose);
      if (scenario === "report-failure") assert.strictEqual(observedError, operationError);
      else {
        assert.strictEqual(observedError, undefined);
        assert.strictEqual(observedResult, returned);
      }
      if (scenario === "report-success") {
        const entries = await readdir(output); assert.equal(entries.length, 1);
        const report = JSON.parse(await readFile(path.join(output, entries[0]!, "report.json"), "utf8"));
        assert.equal(report.failures.length, 1);
      }
    });
  });
}

for (const state of ["closed-before-throw", "open-after-throw", "getter-failure"] as const) {
  test(`#152 close diagnostics distinguish connection state without replacing the original ${state}`, { timeout: 15_000 }, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), "br-close-state-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const output = path.join(directory, "diagnostics"), sourceFile = path.join(directory, "source.sqlite");
    const originalError = Object.assign(new Error("original native close sentinel"), { code: "EBUSY" });
    const observationError = new Error("private state getter sentinel");
    let open = true, nativeCalls = 0, boundaryCalls = 0, getterCalls = 0;
    const db = {
      name: sourceFile,
      get open() { getterCalls++; if (state === "getter-failure") throw observationError; return open; },
      get inTransaction() { return false; },
      close() { nativeCalls++; if (state === "closed-before-throw") open = false; throw originalError; },
    };
    const originalClose = db.close;
    const adapter = { closeSource(source: typeof db) { boundaryCalls++; source.close(); } };
    const boundary = adapter.closeSource;
    await assert.rejects(withSqliteSourceCloseDiagnostics("control", sourceFile, adapter,
      async () => { adapter.closeSource(db); }, output), error => error === originalError);
    assert.equal(nativeCalls, 1); assert.equal(boundaryCalls, 1); assert.equal(getterCalls, 2);
    assert.strictEqual(db.close, originalClose); assert.strictEqual(adapter.closeSource, boundary);
    const entries = await readdir(output); assert.equal(entries.length, 1);
    const bytes = await readFile(path.join(output, entries[0]!, "report.json"), "utf8");
    assert.ok(Buffer.byteLength(bytes) <= 256 * 1024);
    const report = JSON.parse(bytes), failure = report.failures[0];
    assert.equal(report.failures.length, 1); assert.equal(report.originalOperationThrew, true);
    assert.equal(failure.nativeCloseCalls, 1); assert.equal(failure.nativeCloseReturned, false);
    assert.deepEqual(failure.beforeNativeState, { open: state === "getter-failure" ? null : true, inTransaction: false });
    assert.deepEqual(failure.afterNativeState, { open: state === "getter-failure" ? null : state !== "closed-before-throw", inTransaction: false });
    assert.equal(failure.observationErrors, state === "getter-failure" ? 2 : 0);
    assert.equal(report.restorationErrors, 0);
    assert.ok(!bytes.includes("private state getter sentinel"));
  });
}

for (const scenario of ["clear", "blocker", "capture-failure", "truncated", "unobserved", "bounded", "output-failure", "original-throw", "undefined-throw", "comm-delimiters", "comm-long", "owner-change", "fd-denied"] as const) {
  test(`#152 owned PID inventory observations preserve the original ${scenario} outcome`, { timeout: 15_000 }, async t => {
    if (process.platform !== "linux") { t.skip("Linux inventory observer"); return; }
    const directory = await mkdtemp(path.join(tmpdir(), "br-owned-observation-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const output = path.join(directory, "diagnostics"), pid = 42001, calls: string[] = [];
    const originalError = Object.assign(new Error("original inventory failure"), { code: "EIO" });
    const blockers = ["blocker", "fd-denied"].includes(scenario) ? [{ code: "source_writer_unknown", subjectRef: `unreadable-process:${pid}` }] : [];
    const fields = Array<string>(20).fill("0"); fields[0] = "S"; fields[1] = "429"; fields[17] = "2"; fields[19] = "9001";
    const comm = scenario === "comm-delimiters" ? "a)b(c\nx" : scenario === "comm-long" ? "0123456789abcdef" : "owned-fixture";
    const statBytes = Buffer.from(`${pid} (${comm}) ${fields.join(" ")}${scenario === "truncated" ? " ".repeat(8193) : ""}\n`);
    const mapsBytes = Buffer.from("1000-2000 r--p 00000000 00:00 0\n");
    const descriptors = new Map<number, { bytes: Buffer; read: boolean }>(); let nextFd = 40;
    let inspections = 0, originalPending: Promise<typeof blockers> | undefined;
    const adapter = { inspectCurrentWriters() {
      inspections++;
      if (scenario !== "unobserved") {
        const pin = fs.openSync(`/proc/${pid}`, fs.constants.O_RDONLY);
        fs.fstatSync(pin); void promises.readdir(`/proc/self/fd/${pin}/fd`).catch(() => {});
        for (const subject of ["stat", "maps", "stat"]) {
          const fd = fs.openSync(`/proc/self/fd/${pin}/${subject}`, fs.constants.O_RDONLY), bytes = Buffer.alloc(16 * 1024);
          assert.ok(fs.readSync(fd, bytes, 0, bytes.length, null) > 0);
          assert.equal(fs.readSync(fd, bytes, 0, bytes.length, null), 0); fs.closeSync(fd);
        }
        fs.fstatSync(pin); fs.closeSync(pin);
      }
      originalPending = scenario === "original-throw" ? Promise.reject(originalError)
        : scenario === "undefined-throw" ? Promise.reject(undefined) : Promise.resolve(blockers);
      return originalPending;
    } };
    const boundary = adapter.inspectCurrentWriters;
    try {
      if (scenario === "output-failure") await writeFile(output, "not a directory");
      t.mock.method(fs, "openSync", ((file: fs.PathLike) => { calls.push("open"); const fd = nextFd++;
        descriptors.set(fd, { bytes: String(file).endsWith("/stat") ? statBytes : mapsBytes, read: false }); return fd;
      }) as typeof fs.openSync);
      t.mock.method(fs, "readSync", ((fd: number, buffer: Buffer, offset: number) => { calls.push("read");
        const entry = descriptors.get(fd)!; if (entry.read) return 0; entry.read = true; return entry.bytes.copy(buffer, offset);
      }) as typeof fs.readSync);
      t.mock.method(fs, "closeSync", ((fd: number) => { calls.push("close"); descriptors.delete(fd); }) as typeof fs.closeSync);
      t.mock.method(fs, "fstatSync", (() => { calls.push("fstat"); return { dev: 7n, ino: 1001n, gid: 1002, mode: 0o40500, get uid() {
        if (scenario === "capture-failure") throw new Error("private observer getter fault");
        return scenario === "owner-change" && calls.filter(call => call === "fstat").length % 2 === 0 ? 1003 : 1000;
      } }; }) as unknown as typeof fs.fstatSync);
      t.mock.method(promises, "readdir", (() => { calls.push("readdir"); return scenario === "fd-denied"
        ? Promise.reject(Object.assign(new Error("private argv/env/DSN sentinel"), { code: "EACCES", syscall: "scandir" })) : Promise.resolve([]); }) as unknown as typeof promises.readdir);
      syncBuiltinESMExports();
      const operation = withSqliteSourceInventoryDiagnostics(adapter, async phase => {
        for (const label of scenario === "bounded" ? ["baseline", "leader-joined", "excess"] : ["baseline", "leader-joined"]) {
          phase(label); const pending = adapter.inspectCurrentWriters();
          assert.strictEqual(pending, originalPending);
          assert.strictEqual(await pending, blockers);
        }
        if (scenario === "output-failure") throw originalError;
        return blockers;
      }, output, pid);
      if (scenario === "original-throw" || scenario === "output-failure" || scenario === "undefined-throw")
        await assert.rejects(operation, error => error === (scenario === "undefined-throw" ? undefined : originalError));
      else assert.strictEqual(await operation, blockers);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    try {
      assert.strictEqual(adapter.inspectCurrentWriters, boundary);
      assert.equal(inspections, ["original-throw", "undefined-throw"].includes(scenario) ? 1 : scenario === "bounded" ? 3 : 2);
      if (scenario === "unobserved") assert.deepEqual(calls, []);
      else for (const [name, count] of [["open", 4], ["read", 6], ["close", 4], ["fstat", 2], ["readdir", 1]] as const)
        assert.equal(calls.filter(item => item === name).length, count * inspections);
      if (scenario === "output-failure") return;
      const names = await readdir(output); assert.equal(names.length, 1);
      const report = JSON.parse(await readFile(path.join(output, names[0]!, "report.json"), "utf8"));
      assert.equal(report.observations.length, Math.min(inspections, 2)); assert.equal(report.droppedObservations, scenario === "bounded" ? 1 : 0);
      assert.equal(report.requestEvidenceState, ["capture-failure", "truncated", "unobserved", "bounded", "comm-long"].includes(scenario) ? "UNOBSERVED" : "OBSERVED");
      assert.deepEqual(report.observations.map((item: { inspection: number }) => item.inspection), inspections === 1 ? [1] : [1, 2]);
      assert.deepEqual(report.observations.map((item: { phase: string }) => item.phase), inspections === 1 ? ["baseline"] : ["baseline", "leader-joined"]);
      for (const item of report.observations) {
        assert.equal(item.pid, pid);
        assert.equal(item.result, ["original-throw", "undefined-throw"].includes(scenario) ? "THREW" : blockers.length ? "BLOCKERS" : "CLEAR");
        assert.equal(item.evidenceState, ["capture-failure", "truncated", "unobserved", "comm-long"].includes(scenario) ? "UNOBSERVED" : "OBSERVED");
        if (scenario !== "unobserved") {
          assert.equal(item.frame.stats.length, 2); assert.equal(item.frame.maps.length, 1);
          assert.equal(item.frame.maps[0].bytes, mapsBytes.length); assert.equal(item.frame.maps[0].eof, true);
          assert.equal(item.frame.stats[0].identity.ppid, "429");
          assert.equal(item.frame.stats[0].identity.comm, scenario === "comm-long" ? null : comm);
          if (scenario !== "capture-failure") {
            const before = item.frame.directoryIdentities[0], after = item.frame.directoryIdentities[1];
            assert.deepEqual(before, { event: 2, dev: "7", ino: "1001", uid: "1000", gid: "1002", mode: String(0o40500) });
            assert.deepEqual(after, { ...before, event: 16, uid: scenario === "owner-change" ? "1003" : "1000" });
            assert.ok(before.event < item.frame.stats[0].event && item.frame.stats[0].event < after.event);
          }
          if (scenario === "owner-change") assert.equal(item.frame.stageHint, "identity-check");
          if (scenario === "fd-denied") assert.deepEqual(item.frame.errors, [{ event: 3, operation: "readdir", subject: "fd-directory",
            error: { name: "Error", code: "EACCES", syscall: "scandir" }, originalHandling: "requires-original-path-context" }]);
        }
      }
      assert.equal(report.failures.length, blockers.length ? 2 : 0);
      if (blockers.length) assert.ok(report.failures.every((failure: { identityEvidenceState: string }) => failure.identityEvidenceState === "OBSERVED"));
      assert.ok(!JSON.stringify(report).includes("private argv/env/DSN sentinel"));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

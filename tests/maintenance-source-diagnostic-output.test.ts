import test from "node:test";
import assert from "node:assert/strict";
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

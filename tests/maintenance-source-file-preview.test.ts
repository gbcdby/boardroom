import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { digestJson } from "../src/server/storage/maintenance/canonical.ts";
import { readSourceConfigPreview } from "../src/server/storage/maintenance/source-file-preview.ts";
import { isolatedSourcePreview, sourceFilesFixture } from "./fixtures/maintenance-source-files.ts";

test("CFP2 config-null preview retains the exact original null binding without native lookup", async () => {
  assert.equal(await readSourceConfigPreview(null), digestJson({ configFile: null }));
});

const linuxTest = process.platform === "linux" ? test : test.skip;
linuxTest("CFP2 actual config read uses R/F and closes its tail with no sync or output under synthetic qualification", async () => {
  const copy = await isolatedSourcePreview(), f = await sourceFilesFixture({ prepare: true });
  try {
    const before = (await readdir(f.store.root, { recursive: true })).sort();
    const result = await copy.module.readSourceConfigPreview(f.config);
    assert.equal(result, createHash("sha256").update(Buffer.from([0x7b, 0x7d, 10])).digest("hex"));
    assert(f.state.events.some(event => event.startsWith("read:")));
    assert(f.state.events.some(event => event.startsWith("reopen-file:")));
    assert(f.state.events.includes("profile:tail"));
    assert(!f.state.events.some(event => event.startsWith("synchronize:")));
    assert.equal(f.state.handles.size, 0);
    assert.deepEqual((await readdir(f.store.root, { recursive: true })).sort(), before);
  } finally { await f.close(); await copy.close(); }
});

linuxTest("CFP2 preview rejects changed config, size overflow, and a real empty fixed registry", async t => {
  for (const scenario of ["changed", "oversized", "unqualified"]) await t.test(scenario, async () => {
    const copy = await isolatedSourcePreview(), f = await sourceFilesFixture({ prepare: true });
    try {
      if (scenario === "changed") f.state.hook = operation => { if (operation === "profile:after") f.state.mountDelta = 1n; };
      if (scenario === "oversized") await writeFile(f.config, Buffer.alloc(1024 * 1024 + 1), { mode: 0o600 });
      const action = scenario === "unqualified" ? readSourceConfigPreview : copy.module.readSourceConfigPreview;
      await assert.rejects(action(f.config));
      assert(!f.state.events.some(event => event.startsWith("synchronize:")));
      assert.equal(f.state.handles.size, 0);
    } finally { await f.close(); await copy.close(); }
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { digestJson } from "../src/server/storage/maintenance/canonical.ts";
import { readSourceConfigPreview } from "../src/server/storage/maintenance/source-file-preview.ts";
import { isolatedSourcePreview, sourceFilesFixture } from "./fixtures/maintenance-source-files.ts";

test("CFP2 config-null preview retains the exact original null binding without native lookup", async () => {
  assert.equal(await readSourceConfigPreview(null), digestJson({ configFile: null }));
});

const linuxTest = process.platform === "linux" ? test : test.skip;
linuxTest("#152 IG1 preview rejects its non-narrow parent before reading config", async () => {
  const copy = await isolatedSourcePreview(), f = await sourceFilesFixture({ prepare: true });
  try {
    f.state.flags.set(f.directory, 0x40n);
    await assert.rejects(copy.module.readSourceConfigPreview(f.config), { code: "backup_capability_unavailable" });
    assert(!f.state.events.some(event => /^(read|synchronize):/.test(event)));
    assert.equal(f.state.handles.size, 0);
  } finally { await f.close(); await copy.close(); }
});
linuxTest("#152 IG1 preview binds actual parent facts before payload and compares their full values afterward", async t => {
  for (const scenario of ["encrypted", "DAX", "encrypted-mask", "DAX-mask", "mount", "uuid", "unavailable", "flags-after", "xattrs-after", "identity-after"])
    await t.test(scenario, async () => {
      const copy = await isolatedSourcePreview(), f = await sourceFilesFixture({ prepare: true });
      let after = false;
      try {
        f.state.hook = (operation, file, value: any) => {
          if (operation === "profile:after") after = true;
          if (file !== f.directory) return;
          if (["statx-legacy-result", "statx-unique-result"].includes(operation)) {
            if (scenario === "encrypted" || scenario === "DAX") value.attributes |= scenario === "encrypted" ? 0x800n : 0x200000n;
            if (scenario.endsWith("-mask")) value.attributesMask &= ~(scenario === "encrypted-mask" ? 0x800n : 0x200000n);
            if (scenario === "mount") { if (operation === "statx-legacy-result") value.mountId += 1n; else value.uniqueMountId += 1n; }
          }
          if (operation === "extended-result") {
            if (scenario === "mount") value.fid.value.mountId += 1n;
            if (scenario === "uuid") value.uuid.value.bytes = Buffer.alloc(16, 2);
            if (scenario === "unavailable") value.inodeFlags = { status: "unavailable", reason: "syscall", value: null, calls: [] };
            if (after && scenario === "flags-after") value.inodeFlags.value = 0x40n;
            if (after && scenario === "xattrs-after") value.xattrs.value = [{ name: Buffer.from("user.changed"), value: Buffer.from("changed") }];
            if (after && scenario === "identity-after") value.fid.value.bytes = Buffer.alloc(8, 3);
          }
        };
        const changed = ["mount", "uuid"].includes(scenario) || scenario.endsWith("-after");
        await assert.rejects(copy.module.readSourceConfigPreview(f.config), { code: changed ? "source_changed" : "backup_capability_unavailable" });
        if (!scenario.endsWith("-after")) assert(!f.state.events.some(event => event.startsWith("read:")));
        assert(!f.state.events.some(event => event.startsWith("synchronize:"))); assert.equal(f.state.handles.size, 0);
      } finally { await f.close(); await copy.close(); }
    });
});

linuxTest("#152 IG1 preview retains an undefined payload failure and independent original-owner close failure", async () => {
  const copy = await isolatedSourcePreview(), f = await sourceFilesFixture({ prepare: true }), closeError = new Error("preview-close-observation");
  try {
    f.state.hook = (operation, file) => {
      if (file !== f.config) return;
      if (operation === "read") throw undefined;
      if (operation === "closed") throw closeError;
    };
    await assert.rejects(copy.module.readSourceConfigPreview(f.config), (error: any) => {
      assert.equal(error.cause, undefined); assert(error.closeErrors.includes(closeError)); assert.equal(error.tcutReached, false); return true;
    });
    assert(!f.state.events.some(event => event.startsWith("synchronize:"))); assert.equal(f.state.handles.size, 0);
  } finally { await f.close(); await copy.close(); }
});
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

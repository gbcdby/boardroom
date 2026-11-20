import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readdir } from "node:fs/promises";
import { isolatedSourceFiles, sourceFilesFixture, SOURCE_PREPARE_PROFILE } from "./fixtures/maintenance-source-files.ts";
import { inspectSourceFileWriters, withSourceFileObservationWindow } from "../src/server/storage/maintenance/source-file-writers.ts";

const linuxTest = process.platform === "linux" ? test : test.skip;

linuxTest("#152 IG1 same-source parent keeps its first flags through prepare, legacy and readonly", async t => {
  for (const mode of ["prepare", "legacy", "readonly"]) await t.test(mode, async () => {
    const copy = await isolatedSourceFiles(), f = await sourceFilesFixture({ config: false, prepare: mode !== "legacy" });
    try {
      const captured = mode === "readonly" ? await copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference) : undefined;
      const start = f.state.events.length;
      f.state.hook = (operation, file) => {
        if (operation === "read" && file === path.join(f.sessions, "nested", "binary")) f.state.flags.set(f.directory, 0x40n);
      };
      const action = captured ? copy.module.verifyLiveSourceFilesReadOnly(f.store, f.lock, f.mutex, f.reference, captured.ref)
        : copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference);
      await assert.rejects(action, { code: "source_changed" });
      const events = f.state.events.slice(start);
      assert(!events.includes("synchronize:")); assert(!events.includes("transfer-carrier:"));
      if (mode !== "prepare") assert(!events.some(event => event.startsWith("synchronize:")));
      assert.equal(f.state.handles.size, 0);
    } finally { await f.close(); await copy.close(); }
  });
});

linuxTest("#152 IG1 D0 can expire before the newly earlier same-source parent observation", async t => {
  const copy = await isolatedSourceFiles(), f = await sourceFilesFixture({ config: false, prepare: true });
  let now = 0, snapshots = 0;
  try {
    t.mock.method(performance, "now", () => now);
    f.state.hook = (operation, file) => {
      if (file === f.sessions && operation === "statx-unique-result" && ++snapshots === 2) now = 120_001;
    };
    await assert.rejects(copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference), { code: "backup_capability_unavailable" });
    assert.equal(snapshots, 2); assert(!f.state.events.includes("extended:"));
    assert(!f.state.events.some(event => /^(read|enumerate|synchronize):/.test(event))); assert.equal(f.state.handles.size, 0);
  } finally { t.mock.restoreAll(); await f.close(); await copy.close(); }
});

linuxTest("WR1 actual local inventory composes with existing CFP2 readers, prepare and readonly close order", async () => {
  const copy = await isolatedSourceFiles(), f = await sourceFilesFixture({ prepare: true });
  try {
    await withSourceFileObservationWindow(() => f.lock.assertHeld(), async () => {
      await inspectSourceFileWriters(f.plan.fileRoots);
      const captured = await copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference);
      assert.equal(f.state.handles.size, 0, "actual CFP2 owners close before the facts inventory refresh");
      await inspectSourceFileWriters(f.plan.fileRoots);
      const at = f.state.events.length;
      await copy.module.verifyLiveSourceFilesReadOnly(f.store, f.lock, f.mutex, f.reference, captured.ref);
      assert.equal(f.state.handles.size, 0);
      assert(!f.state.events.slice(at).some(event => event.startsWith("synchronize:")));
      await inspectSourceFileWriters(f.plan.fileRoots);
    });
  } finally { await f.close(); await copy.close(); }
});

linuxTest("WR1 source S cannot restart D0 after the real local inventory has consumed the window", async t => {
  const copy = await isolatedSourceFiles(), f = await sourceFilesFixture({ prepare: true });
  let now = 0, produced = false, advanced = false;
  try {
    t.mock.method(performance, "now", () => now);
    await assert.rejects(withSourceFileObservationWindow(() => f.lock.assertHeld(), async () => {
      await inspectSourceFileWriters(f.plan.fileRoots);
      now = 119_999;
      f.state.hook = operation => { if (!advanced && operation.startsWith("profile:")) { now = 120_001; advanced = true; } };
      await copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference); produced = true;
    }), { code: "backup_capability_unavailable" });
    assert.equal(advanced, true); assert.equal(produced, false);
    assert(!f.state.events.some(event => event.startsWith("read:")), "ordinary source content must not start after D0 expires");
    assert.equal(f.state.handles.size, 0);
  } finally { t.mock.restoreAll(); await f.close(); await copy.close(); }
});

linuxTest("CFP2 capture and every live compare prepare while readonly reopens without any sync or output", async () => {
  const copy = await isolatedSourceFiles(), f = await sourceFilesFixture({ prepare: true });
  try {
    const captured = await copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference);
    assert(captured.manifest.rootBindings.every(binding => binding.profile === SOURCE_PREPARE_PROFILE));
    const initialSyncs = f.state.events.filter(value => value.startsWith("synchronize:")).length;
    assert(initialSyncs >= 6, "each of the three actual source files is prepared through independent R/V");
    const firstCount = f.state.events.length;
    await copy.module.verifyLiveSourceFiles(f.store, f.lock, f.mutex, f.reference, captured.ref);
    assert.equal(f.state.events.slice(firstCount).filter(value => value.startsWith("synchronize:")).length, initialSyncs);
    const before = (await readdir(f.store.root, { recursive: true })).sort();
    for (let repeat = 0; repeat < 2; repeat++) {
      const start = f.state.events.length;
      await copy.module.verifyLiveSourceFilesReadOnly(f.store, f.lock, f.mutex, f.reference, captured.ref);
      const events = f.state.events.slice(start);
      assert(events.some(value => value.startsWith("read:")), "each readonly invocation performs current bytes again");
      assert(events.some(value => value === "profile:tail"));
      assert(!events.some(value => value.startsWith("synchronize:")), "readonly never calls source fsync");
      assert.deepEqual((await readdir(f.store.root, { recursive: true })).sort(), before);
      assert.equal(f.state.handles.size, 0);
    }
    for (const relative of ["config.json", "sessions/empty", "sessions/nested/binary"]) {
      const end = f.state.events.indexOf("synchronized:" + relative);
      assert(end >= 0);
      const following = f.state.events.slice(end + 1);
      assert(following.indexOf("closed:" + relative) < following.indexOf("synchronize:" + relative),
        "the fresh/R close happens before final V sync");
    }
  } finally { await f.close(); await copy.close(); }
});

linuxTest("CFP2 tail close failure blocks Tcut and preserves its actual failure", async () => {
  const copy = await isolatedSourceFiles(), f = await sourceFilesFixture({ prepare: true });
  const failure = new Error("real-owner-close-with-synthetic-tail-diagnostic");
  try {
    f.state.hook = operation => { if (operation === "closed-carrier") throw failure; };
    await assert.rejects(copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference), (error: any) => {
      assert.equal(error.tcutReached, false);
      assert(error.closeErrors.includes(failure)); return true;
    });
    assert.equal(f.state.handles.size, 0);
  } finally { await f.close(); await copy.close(); }
});

linuxTest("CFP2 a caught read failure remains sticky in the original actual source-lock window", async () => {
  const copy = await isolatedSourceFiles(), f = await sourceFilesFixture({ prepare: true });
  try {
    const captured = await copy.module.captureSourceFiles(f.store, f.lock, f.mutex, f.reference);
    const original = new Error("injected-current-read-io");
    f.state.hook = operation => { if (operation === "read") throw original; };
    let failure: unknown;
    await assert.rejects(copy.module.verifyLiveSourceFilesReadOnly(f.store, f.lock, f.mutex, f.reference, captured.ref), error => {
      failure = error; return true;
    });
    f.state.hook = () => undefined;
    const at = f.state.events.length;
    await assert.rejects(copy.module.verifyLiveSourceFilesReadOnly(f.store, f.lock, f.mutex, f.reference, captured.ref), error => error === failure);
    assert.equal(f.state.events.length, at, "a later new FD/profile cannot clear the same source-lock failure");
    assert.equal(f.state.handles.size, 0);
  } finally { await f.close(); await copy.close(); }
});

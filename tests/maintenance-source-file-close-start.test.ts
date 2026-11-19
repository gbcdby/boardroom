import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { closeSync, fstatSync, readSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { awaitControllerAdmission, finishControllerCommandOwner, recordControllerFailure } from "../src/server/storage/maintenance/controller-owner.ts";
import type { ControllerOwner } from "../src/server/storage/maintenance/controller-owner.ts";

const project = fileURLToPath(new URL("../", import.meta.url));
const linuxTest = process.platform === "linux" ? test : test.skip;

/** Link-time startup faults only, with byte-identical production C/TS and
 * ordinary private source files. The appended raw accessor is test-only; no
 * production API, environment switch or fixed qualification is substituted. */
async function closeStartFixture(fault: "allocation" | "create-work" | "queue" | "none", closeFault?: "source" | "carrier" | "both") {
  const directory = await mkdtemp(path.join(tmpdir(), "br-close-start-"));
  const source = path.join(directory, "src/server/storage/maintenance"), output = path.join(directory, "build/maintenance-platform");
  await mkdir(source, { recursive: true }); await mkdir(output, { recursive: true });
  await writeFile(path.join(directory, "package.json"), '{"type":"module"}\n');
  const original = await readFile(path.join(project, "src/server/storage/maintenance/source-file-native.ts"), "utf8");
  await writeFile(path.join(source, "source-file-native.ts"), original
    + "\nexport function testRaw(handle) { return sourceOwners.get(handle)?.owner ?? metadataTails.get(handle)?.owner; }\n"
    + "export function testUnresolved() { return [...unresolvedNativeCloses]; }\n");
  await writeFile(path.join(source, "error.ts"), await readFile(path.join(project, "src/server/storage/maintenance/error.ts")));
  const wrapper = path.join(directory, "startup.c");
  const owned = path.join(directory, "owned"), file = path.join(owned, "source"), sentinel = path.join(directory, "sentinel");
  const shims = {
    allocation: '#include <stddef.h>\n#include <errno.h>\nvoid *__real_calloc(size_t,size_t);\nvoid *__wrap_calloc(size_t n,size_t s) { if(n==1 && s<256) {errno=ENOMEM;return NULL;} return __real_calloc(n,s); }\n',
    "create-work": '#include "node_api.h"\nnapi_status __wrap_napi_create_async_work(napi_env e,napi_value r,napi_value n,napi_async_execute_callback x,napi_async_complete_callback c,void *d,napi_async_work *w) { (void)e;(void)r;(void)n;(void)x;(void)c;(void)d;(void)w;return napi_generic_failure; }\n',
    queue: '#include "node_api.h"\nnapi_status __wrap_napi_queue_async_work(node_api_basic_env e,napi_async_work w) { (void)e;(void)w;return napi_generic_failure; }\n',
    none: "",
  };
  // The unknown-close control performs the real close and immediately owns a
  // different file at that descriptor. Retrying the integer would close the
  // sentinel, so successful assertions observe it still readable, not just a
  // synthetic error code. Activation is only after work startup is attempted.
  let shim = shims[fault];
  const symbols = { allocation: ["calloc"], "create-work": ["napi_create_async_work"], queue: ["napi_queue_async_work"], none: [] }[fault];
  if (closeFault) {
    const selected = closeFault === "source" ? `strcmp(target, ${JSON.stringify(file)}) == 0`
      : `strcmp(target, ${JSON.stringify(owned)}) == 0${closeFault === "carrier" ? " && !(fcntl(fd, F_GETFL) & O_PATH)" : ""}`;
    const activation = fault === "allocation" ? `
void *__real_calloc(size_t,size_t);
void *__wrap_calloc(size_t n,size_t s) {
  if(n == 1 && s < 256) { atomic_store(&active, true); errno = ENOMEM; return NULL; }
  return __real_calloc(n,s);
}` : `
napi_status __real_napi_queue_async_work(node_api_basic_env,napi_async_work);
napi_status __wrap_napi_queue_async_work(node_api_basic_env e,napi_async_work w) {
  atomic_store(&active, true); return __real_napi_queue_async_work(e,w);
}`;
    symbols.splice(0, symbols.length, fault === "allocation" ? "calloc" : "napi_queue_async_work", "close");
    shim = `#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include "node_api.h"
static _Atomic bool active;
int __real_close(int fd);
${activation}
int __wrap_close(int fd) {
  if (!atomic_load(&active)) return __real_close(fd);
  char link[64], target[PATH_MAX + 1];
  (void)snprintf(link, sizeof(link), "/proc/self/fd/%d", fd);
  const ssize_t length = readlink(link, target, sizeof(target) - 1);
  if (length < 0) return __real_close(fd);
  target[length] = 0;
  if (!(${selected})) return __real_close(fd);
  const int rc = __real_close(fd);
  if (rc) return rc;
  const int replacement = open(${JSON.stringify(sentinel)}, O_RDONLY | O_CLOEXEC);
  if (replacement >= 0 && replacement != fd) {
    (void)fcntl(replacement, F_DUPFD_CLOEXEC, fd);
    (void)__real_close(replacement);
  }
  errno = EIO; return -1;
}
`;
  }
  await writeFile(wrapper, shim);
  const addon = path.join(output, "maintenance-source-files-linux-" + process.arch + ".node");
  const built = spawnSync("/usr/bin/cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-DNAPI_VERSION=8",
    "-DNODE_GYP_MODULE_NAME=source_close_start_test", "-shared", "-fPIC", "-I", path.join(project, "native/node-api/v24.22.1"),
    path.join(project, "native/maintenance-source-files.c"), wrapper, ...symbols.map(symbol => "-Wl,--wrap=" + symbol), "-o", addon], { encoding: "utf8", timeout: 30_000 });
  assert.equal(built.status, 0, built.stderr); await chmod(addon, 0o700);
  const api = await import(pathToFileURL(path.join(source, "source-file-native.ts")).href);
  const native = createRequire(import.meta.url)(addon);
  await mkdir(owned, { mode: 0o700 }); await writeFile(file, "ordinary-owned-close-start\n", { mode: 0o600 });
  await writeFile(sentinel, "sentinel-still-owned\n", { mode: 0o600 });
  const live = async (targets = [owned, file]) => {
    const found: { fd: string; target: string }[] = [];
    for (const fd of await readdir("/proc/self/fd")) {
      try { const target = await readlink("/proc/self/fd/" + fd); if (targets.includes(target)) found.push({ fd, target }); }
      catch { /* The inventory's own transient directory owner is not a source owner. */ }
    }
    return found;
  };
  return { api, native, owned, sentinel, live, close: () => rm(directory, { recursive: true, force: true }) };
}

for (const fault of ["allocation", "create-work", "queue"] as const) linuxTest(`CFP2 ${fault} close startup failure closes original R/V/F and M/A without losing its error`, async t => {
  const fixture = await closeStartFixture(fault);
  try {
    for (const role of ["ordinary", "tail"] as const) await t.test(role, async () => {
      const raw = new Set<object>(), errors: unknown[] = [];
      const expectedCode = fault === "queue" ? "ERR_SOURCE_NATIVE_IO" : "ERR_SOURCE_ALLOC";
      try {
        await assert.rejects(fixture.api.withNativeSourceRoot(fixture.owned, async (root: any) => {
          raw.add(fixture.api.testRaw(root));
          const owners = role === "ordinary" ? (() => {
            const r = root.openChild("source", "file"), v = r.reopenFile(), f = r.reopenFile(); return [f, r, v];
          })() : (() => {
            const tail = fixture.api.retainSourceFileMetadata(root); tail.transferCarrier(root); return [tail];
          })();
          for (const owner of owners) {
            raw.add(fixture.api.testRaw(owner));
            const closing = owner.closeAsync();
            assert.equal(owner.closeAsync(), closing, "one actual close attempt owns its original Promise");
            await assert.rejects(closing, (error: any) => { errors.push(error); return error?.code === expectedCode; });
          }
        }), (error: any) => error instanceof AggregateError && errors.every(original => error.errors.includes(original)));
        assert.equal((await fixture.live()).length, 0,
          "the failed scope must finish real source/parent/M/A ownership before returning, without GC");
        assert(errors.length > 0, "successful failure cleanup cannot suppress the original startup error");
        for (const owner of raw) assert.throws(() => fixture.native.rootInfo(owner), { code: "ERR_SOURCE_HANDLE" });
      } finally {
        // Baseline RED cleanup uses only original opaque owners. No reused
        // descriptor is guessed, and this manual test cleanup is not a pass.
        for (const owner of [...raw].reverse()) try { fixture.native.close(owner); } catch { /* Already actually closed or transferred. */ }
      }
    });
  } finally { await fixture.close(); }
});

for (const fault of ["allocation", "none"] as const) linuxTest(`CFP2 ${fault === "none" ? "started async" : "failed-start fallback"} close keeps unknown owners pending and never closes reused FDs`, async t => {
  for (const role of ["source", "carrier", "both"] as const) await t.test(role, async () => {
    const fixture = await closeStartFixture(fault, role);
    const raw = new Set<object>(); let actual: any, scopeError: any, first: any, closing: Promise<void> | undefined;
    let before: Awaited<ReturnType<typeof fixture.live>> = [];
    try {
      await assert.rejects(fixture.api.withNativeSourceRoot(fixture.owned, async (root: any) => {
        raw.add(fixture.api.testRaw(root));
        actual = role === "source" ? root.openChild("source", "file") : fixture.api.retainSourceFileMetadata(root);
        if (role !== "source") actual.transferCarrier(root);
        raw.add(fixture.api.testRaw(actual)); before = await fixture.live();
        closing = actual.closeAsync();
        await assert.rejects(closing!, (error: any) => { first = error; return error.code === (fault === "allocation" ? "ERR_SOURCE_ALLOC" : "ERR_SOURCE_NATIVE_IO"); });
      }), (error: any) => { scopeError = error; return error instanceof AggregateError && error.errors.includes(first); });

      const owner = fixture.api.testRaw(actual), held = fixture.api.testUnresolved();
      assert.equal(held.length, 1); assert.equal(held[0].owner, owner); assert.equal(held[0].closed, false);
      assert.equal(held[0].scope.active, false); assert.equal(held[0].scope.pending.size, 0, "all actual native work has settled");
      assert((role === "source" ? held[0].scope.opened : held[0].scope.tails).has(actual), "unknown is still owned after scope exit");
      const unknown = scopeError.errors.find((error: any) => error.nativeCleanupOwner === owner && !Object.hasOwn(error, "cleanupCalls"));
      assert(unknown, "a concrete unresolved owner, not just a failure string, reaches the outer error graph");
      assert.equal(unknown.cause, first);
      const io = scopeError.errors.find((error: any) => error.syscall === (fault === "allocation" ? "close-unstarted" : "close-source"));
      assert(io); assert.equal(io.nativeCleanupOwner, owner);
      const expected = role === "source" ? [["close-source", -1n], ["close-bootstrap-parent", 0n]]
        : [["close-tail-carrier", -1n], ["close-tail-metadata", role === "both" ? -1n : 0n]];
      assert.deepEqual(io.cleanupCalls.map((call: any) => [call.operation, call.rc]), expected,
        "A failure cannot prevent M's actual unique close; both actual errors remain separate");
      assert.equal((await fixture.live()).length, 0, "the injected unknown follows real release of the private original FDs");

      const replacements = await fixture.live([fixture.sentinel]);
      assert.equal(replacements.length, role === "both" ? 2 : 1);
      assert(replacements.every(item => before.some(previous => previous.fd === item.fd)), "each original failed-close integer was really reused");
      assert.equal(fixture.native.closeUnstarted(owner), false);
      assert.equal(fixture.native.closeUnstarted(owner), false, "neither an attempted async close nor failed fallback is retried");
      assert.equal(actual.closeAsync(), closing, "reentry observes the same original rejected Promise");
      for (const selected of [fixture.owned, path.join(fixture.owned, "source")]) {
        let entered = false;
        await assert.rejects(fixture.api.withNativeSourceRoot(selected, () => { entered = true; }),
          (error: any) => error.nativeCleanupOwner === owner && error.cause === first);
        assert.equal(entered, false, "overlapping source admission fails before its callback/native open");
      }
      for (const item of replacements) {
        const buffer = Buffer.alloc(1);
        assert.equal(readSync(Number(item.fd), buffer, 0, 1, 0), 1); assert.equal(buffer.toString(), "s");
      }

      // Genuine controller pending/error functions consume the real native
      // error. The tiny adapter below only observes controller cleanup flow;
      // this is not a database integration or device qualification control.
      let adapterCloses = 0;
      const makeOwner = (): ControllerOwner => ({
        descriptor: { kind: "sqlite", sqlitePath: path.join(fixture.owned, "not-opened.sqlite") } as ControllerOwner["descriptor"],
        adapter: { close: async () => { adapterCloses++; } } as ControllerOwner["adapter"],
        keys: ["close-start-test:" + fixture.owned], stores: new Map(), unresolvedSourceErrors: new Set(), sourceFailures: new Set(), adapterClosed: false,
      });
      const controller = makeOwner(), failures: unknown[] = [];
      recordControllerFailure(controller, failures, scopeError);
      assert(controller.sourceFailures.size > 0);
      assert([...controller.unresolvedSourceErrors].some((error: any) => error.nativeCleanupOwner === owner));
      await assert.rejects(finishControllerCommandOwner(controller, undefined, undefined, failures, "native-close-test"));
      assert.equal(controller.adapterClosed, true); assert.equal(adapterCloses, 1);
      await assert.rejects(awaitControllerAdmission(makeOwner()));
      assert.equal(adapterCloses, 1, "known adapter completion does not erase or retry the retained native owner");
    } finally {
      for (const owner of [...raw].reverse()) try { fixture.native.close(owner); } catch { /* Never retries unknown numeric slots. */ }
      // These are newly opened, test-owned sentinel descriptors. Bind them to
      // that file before harness cleanup; product code never reclaims them.
      const identity = statSync(fixture.sentinel);
      for (const item of await fixture.live([fixture.sentinel])) {
        const fd = Number(item.fd), current = fstatSync(fd);
        assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino); closeSync(fd);
      }
      await fixture.close();
    }
  });
});

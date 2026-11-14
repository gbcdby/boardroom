import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs, { type ReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { createStaticHandler } from "../src/server/static.ts";
import { startServer, type RunningServer } from "../src/server/server.ts";
import { createLogger } from "../src/server/logger.ts";

const html = '<!doctype html><html><body><div id="app"></div></body></html>';
const silentLogger = createLogger({ write: () => {} });
function signal<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`static lifecycle timeout: ${stage}`)), 3000); })]); }
  finally { clearTimeout(timer!); }
}

/** Only delay a real fixture file's read callback; no synthetic end/close/error events or fake response body. */
async function readFixture(t: TestContext, mode: "normal" | "hold-eof" | "hold-data" | "read-error") {
  const dir = await mkdtemp(path.join(process.cwd(), "br-static-lifecycle-")), webRoot = path.join(dir, "web"), file = path.join(webRoot, "index.html");
  await mkdir(webRoot); await writeFile(file, html);
  const created = signal<ReadStream>(), held = signal<void>(), paused = signal<void>(), closed = signal<void>();
  const native = { create: fs.createReadStream, read: fs.read, close: fs.close }, ownedFds = new Set<number>();
  const readError = Object.assign(new Error("controlled_static_read_error"), { code: "EIO" });
  let stream: ReadStream | undefined, originalFd: number | undefined, releaseRead: (() => void) | undefined;
  let released = false, reads = 0, closes = 0, ends = 0; const errors: Error[] = [];
  t.mock.method(fs, "createReadStream", ((target: fs.PathLike, options?: Parameters<typeof fs.createReadStream>[1]) => {
    if (String(target) !== file) return native.create(target, options);
    stream = native.create(target, { ...(typeof options === "object" ? options : {}), ...(mode === "hold-data" ? { highWaterMark: 8 } : {}) });
    stream.once("open", fd => { originalFd = fd; ownedFds.add(fd); });
    stream.on("error", error => { errors.push(error); });
    stream.on("end", () => { ends++; });
    stream.once("pause", () => paused.resolve());
    stream.once("close", () => closed.resolve());
    created.resolve(stream); return stream;
  }) as typeof fs.createReadStream);
  t.mock.method(fs, "read", ((...args: unknown[]) => {
    const fd = args[0] as number;
    if (!ownedFds.has(fd)) return Reflect.apply(native.read, fs, args);
    const callback = args.pop() as (...values: unknown[]) => void;
    return Reflect.apply(native.read, fs, [...args, (...values: unknown[]) => {
      reads++;
      if (mode === "read-error" && reads === 1) { callback(readError, 0, values[2]); return; }
      if (!released && !values[0] && ((mode === "hold-eof" && values[1] === 0) || (mode === "hold-data" && reads === 2))) {
        releaseRead = () => callback(...values); held.resolve(); return;
      }
      callback(...values);
    }]);
  }) as typeof fs.read);
  t.mock.method(fs, "close", ((fd: number, callback: (error: NodeJS.ErrnoException | null) => void) => {
    if (ownedFds.has(fd)) closes++;
    return native.close(fd, error => { ownedFds.delete(fd); callback(error); });
  }) as typeof fs.close);
  syncBuiltinESMExports();
  const release = () => { released = true; const callback = releaseRead; releaseRead = undefined; callback?.(); };
  return { dir, webRoot, file, created: created.promise, held: held.promise, paused: paused.promise, closed: closed.promise, readError, release,
    stats: () => ({ reads, closes, ends, errors, originalFd, stream }),
    async cleanup(closeServer: () => Promise<unknown>) {
      try {
        release();
        // Failure-only fixture cleanup consumes the owned paused stream; it cannot satisfy the earlier assertion.
        if (stream && !stream.destroyed && !stream.readableEnded) stream.resume();
        if (stream) await bounded(closed.promise, "owned file cleanup");
      } finally {
        t.mock.restoreAll(); syncBuiltinESMExports();
        try { await closeServer(); } finally { await rm(dir, { recursive: true, force: true }); }
      }
    },
  };
}
function assertFileClosed(f: Awaited<ReturnType<typeof readFixture>>) {
  const state = f.stats(); assert.equal(state.stream!.closed, true); assert.equal(state.closes, 1);
  assert.ok(state.originalFd !== undefined);
  assert.throws(() => fs.fstatSync(state.originalFd!), { code: "EBADF" });
}

test("static response closes before file EOF: ordinary server shutdown waits for real IO then settles", async t => {
  const f = await readFixture(t, "hold-eof"); let server: RunningServer | undefined, closing: Promise<void> | undefined;
  try {
    server = await startServer({ config: { port: 0, dataDir: path.join(f.dir, "data"), heartbeat: { intervalMs: 10000, timeoutMs: 30000 }, configFile: null }, logger: silentLogger, webRoot: f.webRoot });
    const response = await fetch(`${server.url}/projects/123`);
    assert.equal(response.status, 200); assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(await response.text(), html); await bounded(f.held, "real EOF callback held");
    assert.equal(f.stats().stream!.readableEnded, false);
    let settled = false; closing = server.close(); void closing.then(() => { settled = true; }, () => { settled = true; });
    await bounded(f.paused, "response unpipes the source");
    assert.equal(settled, false, "in-flight source IO must still be accounted for");
    f.release();
    await bounded(closing, "server close after EOF callback release");
    assert.equal(server.storageClient.diagnostic.status, "closed");
    assertFileClosed(f);
    assert.equal(f.stats().errors.length, 1); assert.equal((f.stats().errors[0] as NodeJS.ErrnoException).code, "ERR_STREAM_PREMATURE_CLOSE");
  } finally {
    await f.cleanup(async () => { if (server) await bounded(closing ?? server.close(), "server cleanup"); });
  }
});

for (const mode of ["normal", "hold-data", "read-error"] as const) test(`static ${mode}: transfer result and actual file close are complete exactly once`, async t => {
  const f = await readFixture(t, mode), handler = createStaticHandler({ root: f.webRoot });
  const outcome = signal<{ value?: boolean; error?: unknown }>(), responseClosed = signal<void>(); let settlements = 0;
  const http = createServer((request, response) => {
    response.once("close", () => responseClosed.resolve());
    void handler(request, response).then(value => { settlements++; outcome.resolve({ value }); }, error => {
      settlements++; outcome.resolve({ error }); if (!response.destroyed) response.destroy();
    });
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http.address(); assert.ok(address && typeof address !== "string");
  const abort = new AbortController();
  try {
    const result = fetch(`http://127.0.0.1:${address.port}/`, { signal: abort.signal });
    if (mode === "read-error") await assert.rejects(result, /fetch failed/);
    else {
      const response = await result; assert.equal(response.status, 200);
      if (mode === "normal") assert.equal(await response.text(), html);
      else {
        const reader = response.body!.getReader(); const first = await reader.read(); assert.equal(first.done, false);
        await bounded(f.held, "real second data callback held"); abort.abort();
        await assert.rejects(reader.read(), { name: "AbortError" });
        await bounded(responseClosed.promise, "actual aborted response close"); f.release();
      }
    }
    const completed = await bounded(outcome.promise, "handler completion");
    assertFileClosed(f); assert.equal(settlements, 1);
    if (mode === "normal") { assert.equal(completed.value, true); assert.equal(f.stats().ends, 1); assert.deepEqual(f.stats().errors, []); }
    else if (mode === "read-error") { assert.equal(completed.error, f.readError); assert.equal(f.stats().errors[0], f.readError); assert.equal(f.stats().errors.length, 1); }
    else { assert.equal((completed.error as NodeJS.ErrnoException).code, "ERR_STREAM_PREMATURE_CLOSE"); assert.equal(f.stats().errors.length, 1); }
  } finally {
    abort.abort(); await f.cleanup(() => new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())));
  }
});

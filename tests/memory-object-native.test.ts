import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { fstatSync } from "node:fs";
import path from "node:path";
import { buildNormalMemoryNative, buildMemoryNativeFixture, buildMemoryPinFailure, createMemoryRoot, runMemoryChild, memoryWorker, waitForNative, memoryNativeProject, supportedMemoryNativePlatform } from "./helpers/memory-object-native-fixture.ts";
import type { NativeResult } from "./helpers/memory-object-native-fixture.ts";
import { encodeMemoryObjectBody, parseMemoryObjectRef } from "../src/server/memory/object-ref.ts";
import { buildLayoutMemoryInventory } from "../src/server/storage/maintenance/layout-memory-inventory.ts";
import { digestRowMultiset } from "../src/server/storage/maintenance/manifests.ts";

function failure(result: NativeResult, code?: string) {
  assert.equal(result.kind, "failed", JSON.stringify(result));
  if (result.kind !== "failed") throw new Error("expected native failure");
  if (code) assert.equal(result.primary.code, code, JSON.stringify(result));
  return result;
}

test("#161 E3 ordinary native build has the exact closed ABI and rejects forged owners", {
  skip: !supportedMemoryNativePlatform,
}, async () => {
  const native = await buildNormalMemoryNative();
  assert.deepEqual(Object.keys(native).sort(), ["abiInfo", "prepare", "readVerify", "revalidatePrepared",
    "closePrepared", "closeRoot", "observeRoot"].sort());
  const abi = native.abiInfo();
  assert.deepEqual(abi, { contract: "memory-native-mechanical/r1", napi: 8, rootFactory: "not-installed",
    pendingLimit: 8, fdLimit: 64, bodyLimit: 1048576 });
  assert.ok(Object.isFrozen(abi));
  let inspected = false;
  const forged = Object.defineProperty({}, "fd", { get() { inspected = true; throw new Error("caller secret"); } });
  for (const operation of [() => native.prepare(forged, "a"), () => native.readVerify(forged, "a".repeat(64), 1),
    () => native.revalidatePrepared(forged), () => native.closePrepared(forged), () => native.closeRoot(forged)]) {
    const promise = operation();
    assert.ok(promise instanceof Promise);
    const result = await promise;
    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") throw new Error("expected native failure");
    assert.equal(result.primary.code, "invalid_owner");
    assert.equal(result.resources, null);
    assert.equal(result.retained, null);
    assert.deepEqual(result.cleanup, []);
    assert.equal(JSON.stringify(result).includes("caller secret"), false);
  }
  assert.throws(() => native.observeRoot(forged), (error: unknown) => error instanceof Error
    && (error as Error & { code?: string }).code === "invalid_owner"
    && error.message === "memory_native:invalid_owner" && !Object.hasOwn(error, "cause"));
  assert.equal(inspected, false);
  const { native: fixture } = await buildMemoryNativeFixture(); const directory = await createMemoryRoot();
  const actualOtherAddonOwner = fixture.fixtureOpenRoot(directory, "foreign-owner", 1048576);
  try {
    failure(await native.prepare(actualOtherAddonOwner, "foreign"), "invalid_owner");
    assert.equal(fixture.observeRoot(actualOtherAddonOwner).resources.pending, 0);
  } finally { await fixture.closeRoot(actualOtherAddonOwner); await rm(directory, { recursive: true, force: true }); }
});

test("#161 E3 outputs define own immutable data without invoking inherited setters", { skip: !supportedMemoryNativePlatform }, async () => {
  await buildNormalMemoryNative();
  const normalFile = path.join(memoryNativeProject, "build", "memory-objects", `memory-objects-${process.platform}-${process.arch}.node`);
  const { file } = await buildMemoryNativeFixture(); const directory = await createMemoryRoot();
  try {
    await runMemoryChild(normalFile, directory, `
      const n=createRequire(import.meta.url)(file);let touched=0,promise;
      Object.defineProperty(Object.prototype,'kind',{configurable:true,set(){touched++;throw new Error('private prototype marker');}});
      try {promise=n.prepare({},'x');} finally {delete Object.prototype.kind;}
      assert.ok(promise instanceof Promise);assert.equal(touched,0);
      const result=await promise;assert.equal(result.kind,'failed');assert.equal(result.primary.code,'invalid_owner');
      assert.ok(Object.isFrozen(result));assert.equal(Object.hasOwn(result,'kind'),true);
      for(const prototype of [Object.prototype,Error.prototype]){
        let calls=0,caught;
        Object.defineProperty(prototype,'code',{configurable:true,set(){calls++;throw new Error('private inherited error code');}});
        try{n.observeRoot({});}catch(error){caught=error;}finally{delete prototype.code;}
        assert.equal(calls,0);assert.equal(caught.code,'invalid_owner');assert.equal(caught.message,'memory_native:invalid_owner');
        assert.equal(Object.hasOwn(caught,'code'),true);
      }
    `);
    await runMemoryChild(file, directory, `
      const n=createRequire(import.meta.url)(file),root=n.fixtureOpenRoot(directory,'properties',1048576);
      const hold=n.fixtureFillFdBoundary(root);
      n.fixtureSetFaults(root,[{point:'file-close',occurrence:1,action:'error-without-close'},{point:'file-close',occurrence:1,action:'error-without-close'}]);
      let touched=0,result;
      const descriptor={configurable:true,set(){touched++;throw new Error('private inherited setter');}};
      Object.defineProperty(Object.prototype,'kind',descriptor);Object.defineProperty(Object.prototype,'0',descriptor);
      try {result=n.fixtureCloseFdHold(hold);} finally {delete Object.prototype.kind;delete Object.prototype[0];}
      assert.equal(touched,0);assert.equal(result.kind,'failed');assert.ok(result.cleanup.length>=1);
      assert.ok(Object.hasOwn(result.cleanup,0));assert.ok(Object.isFrozen(result.cleanup));
      assert.equal((await n.closeRoot(root)).kind,'failed');
    `);
    for (const malicious of ["throw", "replace"]) {
      await runMemoryChild(normalFile, directory, `
        const n=createRequire(import.meta.url)(file);let touched=0,result;
        Object.defineProperty(Object.prototype,'then',{configurable:true,get(){touched++;
          ${malicious === "throw" ? "throw new Error('private inherited then');" : "return resolve => resolve('CALLER_SELECTED_VALUE');"}
        }});
        try {result=await n.prepare({},'x');} finally {delete Object.prototype.then;}
        assert.equal(touched,0);assert.equal(result.kind,'failed');assert.equal(result.primary.code,'invalid_owner');
        assert.deepEqual(Object.getOwnPropertyDescriptor(result,'then'),{value:undefined,enumerable:false,writable:false,configurable:false});
        assert.deepEqual(Object.keys(result).sort(),['kind','primary','cleanup','retained','resources'].sort());
      `);
      await runMemoryChild(file, directory, `
        const n=createRequire(import.meta.url)(file),root=n.fixtureOpenRoot(directory,'then-results',1048576);
        let touched=0;Object.defineProperty(Object.prototype,'then',{configurable:true,get(){touched++;
          ${malicious === "throw" ? "throw new Error('private inherited then');" : "return resolve => resolve('CALLER_SELECTED_VALUE');"}
        }});
        const results=[];
        try {
          const p=await n.prepare(root,'then body');results.push(p);assert.equal(p.kind,'prepared-file');
          results.push(await n.readVerify(root,p.ref.contentSha256,p.ref.byteLength));
          results.push(await n.revalidatePrepared(p.file));results.push(await n.closePrepared(p.file));results.push(await n.closeRoot(root));
        } finally {delete Object.prototype.then;}
        assert.equal(touched,0);
        for(const r of results)assert.deepEqual(Object.getOwnPropertyDescriptor(r,'then'),{value:undefined,enumerable:false,writable:false,configurable:false});
        assert.deepEqual(Reflect.ownKeys(results[0].ref).sort(),['objectFormat','storageId','contentSha256','byteLength'].sort());
      `);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("#161 E3 dispatch allocator refusal rolls back unissued body and pending reservations", { skip: !supportedMemoryNativePlatform }, async () => {
  const { native } = await buildMemoryNativeFixture(); const directory = await createMemoryRoot();
  const root = native.fixtureOpenRoot(directory, "allocation", 1048576);
  try {
    for (let i = 0; i < 16; i++) {
      native.fixtureSetFaults(root, [{ point: "native-dispatch", occurrence: 1, action: "fail-before" }]);
      failure(await native.prepare(root, "a".repeat(65536)), "resource_unavailable");
      assert.equal(native.observeRoot(root).resources.pending, 0);
      assert.equal(native.observeRoot(root).resources.bodyBytes, 0);
    }
    native.fixtureSetFaults(root, []);
    const result = await native.prepare(root, "after allocator refusal"); assert.equal(result.kind, "prepared-file");
  } finally { await native.closeRoot(root); await rm(directory, { recursive: true, force: true }); }
});

test("#161 E3 injected result allocation refusal retains the real prepared owner until actual close", { skip: !supportedMemoryNativePlatform }, async () => {
  const { file } = await buildMemoryNativeFixture(); const directory = await createMemoryRoot();
  try { await runMemoryChild(file, directory, `
    const n=createRequire(import.meta.url)(file),root=n.fixtureOpenRoot(directory,'result-allocation',1048576);
    const baseline=n.observeRoot(root).resources.fdOwned;
    n.fixtureSetFaults(root,[{point:'native-complete',occurrence:1,action:'fail-before'}]);
    let touched=0;
    Object.defineProperty(Object.prototype,'code',{configurable:true,set(){touched++;throw new Error('private result code');}});
    let capture;
    const errorPromise=new Promise(resolve=>{capture=resolve;process.once('uncaughtException',capture);});
    const promised=n.prepare(root,'real canonical prepared before the injected result refusal');
    const observed=await Promise.race([errorPromise,promised]);
    process.removeListener('uncaughtException',capture);
    delete Object.prototype.code;assert.equal(touched,0);
    assert.ok(observed instanceof Error,'the result-construction failure must use the native NAPI error path');
    assert.equal(observed.code,'native_abi_unavailable');assert.equal(observed.message,'memory_native:native_abi_unavailable');
    let settled=false;void promised.then(()=>{settled=true;},()=>{settled=true;});
    const retained=n.observeRoot(root);assert.equal(retained.state,'retained');
    assert.equal(retained.resources.pending,1);assert.equal(retained.resources.preparedFiles,1);
    assert.equal(retained.resources.nativeTasks,0);assert.ok(retained.resources.fdOwned>baseline);
    const fds=n.fixtureFdSnapshot(root);for(const fd of fds)assert.ok(fs.fstatSync(fd.fd));
    global.gc();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(settled,false);assert.equal(n.observeRoot(root).resources.pending,1);
    assert.equal((await n.prepare(root,'late')).primary.code,'owner_closing');
    assert.equal((await n.closeRoot(root)).kind,'closed');assert.equal((await n.closeRoot(root)).kind,'closed');
    const closed=n.observeRoot(root);assert.equal(closed.resources.pending,0);assert.equal(closed.resources.fdOwned,0);
    for(const fd of fds)assert.throws(()=>fs.fstatSync(fd.fd),error=>error.code==='EBADF');
  `); } finally { await rm(directory, { recursive: true, force: true }); }
  for (const unknownClose of [false, true]) {
    const workerDirectory = await createMemoryRoot();
    try { await runMemoryChild(file, workerDirectory, `
      const n=createRequire(import.meta.url)(file),root=n.fixtureOpenRoot(directory,'result-worker',1048576);
      const baseline=n.observeRoot(root).resources.fdOwned;
      n.fixtureSetFaults(root,[{point:'native-complete',occurrence:1,action:'fail-before'}]);
      const worker=new Worker(\`
        const {parentPort,workerData}=require('node:worker_threads');
        const n=require(workerData.file),root=n.fixtureOpenRoot(workerData.directory,'result-worker',1048576);
        process.once('uncaughtException',error=>parentPort.postMessage({code:error.code,message:error.message}));
        n.prepare(root,'result belongs to the actual Worker operation');
        parentPort.on('message',()=>{});
      \`,{eval:true,execArgv:[],workerData:{file,directory}});
      const caught=await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);});
      assert.equal(caught.code,'native_abi_unavailable');assert.equal(caught.message,'memory_native:native_abi_unavailable');
      assert.equal(n.observeRoot(root).state,'retained');assert.equal(n.observeRoot(root).resources.pending,1);
      if(${unknownClose})n.fixtureSetFaults(root,[{point:'file-close',occurrence:1,action:'error-without-close'}]);
      await worker.terminate();global.gc();await new Promise(resolve=>setImmediate(resolve));
      if(${unknownClose}){
        assert.equal(n.observeRoot(root).resources.fdUnknown,1);assert.equal(n.observeRoot(root).resources.pending,1);
        assert.equal((await n.closeRoot(root)).kind,'failed');assert.equal((await n.closeRoot(root)).kind,'failed');
      }else{
        assert.equal(n.observeRoot(root).resources.pending,0);assert.equal(n.observeRoot(root).resources.fdOwned,baseline);
        assert.equal((await n.closeRoot(root)).kind,'closed');assert.equal(n.observeRoot(root).resources.fdOwned,0);
      }
    `); } finally { await rm(workerDirectory, { recursive: true, force: true }); }
  }
});

test("#161 E3 injected Promise creation refusal preserves existing owners and releases unissued bodies", { skip: !supportedMemoryNativePlatform }, async () => {
  const { file } = await buildMemoryNativeFixture();
  for (const operation of ["prepare", "revalidatePrepared", "closeRoot"]) {
    const directory = await createMemoryRoot();
    try { await runMemoryChild(file, directory, `
      const n=createRequire(import.meta.url)(file),root=n.fixtureOpenRoot(directory,'promise-allocation',1048576);
      const prepared=${operation === "revalidatePrepared" ? "await n.prepare(root,'existing prepared owner')" : "null"};
      n.fixtureSetFaults(root,[{point:'native-dispatch',occurrence:2,action:'fail-before'}]);
      let caught,touched=0;
      Object.defineProperty(Error.prototype,'code',{configurable:true,set(){touched++;throw new Error('private Promise code');}});
      try{${operation === "prepare" ? "n.prepare(root,'unissued body'.repeat(1000))" : operation === "revalidatePrepared" ? "n.revalidatePrepared(prepared.file)" : "n.closeRoot(root)"};}
      catch(error){caught=error;}finally{delete Error.prototype.code;}
      assert.equal(touched,0);assert.equal(caught?.code,'native_abi_unavailable');assert.equal(caught.message,'memory_native:native_abi_unavailable');
      const retained=n.observeRoot(root);assert.equal(retained.state,'retained');
      assert.equal(retained.resources.pending,prepared?1:0);assert.equal(retained.resources.nativeTasks,0);
      assert.equal(retained.resources.preparedFiles,prepared?1:0);if(!prepared)assert.equal(retained.resources.bodyBytes,0);
      assert.ok(n.fixtureTrace(root).some(t=>t.syscall==='fixture-promise-allocation'&&t.injected&&t.rc===-1));
      for(const fd of n.fixtureFdSnapshot(root))assert.ok(fs.fstatSync(fd.fd));
      global.gc();await new Promise(resolve=>setImmediate(resolve));
      assert.equal(n.observeRoot(root).resources.pending,prepared?1:0);
      if(prepared)assert.equal((await n.closePrepared(prepared.file)).kind,'closed');
      assert.equal((await n.closeRoot(root)).kind,'closed');assert.equal(n.observeRoot(root).resources.fdOwned,0);
    `); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("#161 E3 two Workers share all eight real operations and termination preserves the surviving owner", { skip: !supportedMemoryNativePlatform, timeout: 30_000 }, async () => {
  const { native, file } = await buildMemoryNativeFixture();
  const directory = await createMemoryRoot(); const root = native.fixtureOpenRoot(directory, "workers", 1048576);
  const first = memoryWorker(file, directory), second = memoryWorker(file, directory);
  try {
    for (const point of ["native-dispatch", "write", null]) {
      native.fixtureSetFaults(root, point ? [{ point, occurrence: 1, action: "hold" }] : []);
      await first.request("begin", Array.from({ length: 8 }, (_, i) => `${point}:${i}`));
      assert.equal(native.observeRoot(root).resources.pending, 8);
      failure(await second.request<NativeResult>("prepare", "ninth"), "resource_unavailable");
      await assert.rejects(second.request("acquire", { storage: "changed", maximum: 1048576 }), /invalid_input/);
      if (point) native.fixtureRelease(root, point);
      const results = await first.request<NativeResult[]>("finish");
      assert.ok(results.every(r => r.kind === "prepared-file"), JSON.stringify(results));
      await first.request("closeFiles"); assert.equal(native.observeRoot(root).resources.pending, 0);
    }
    native.fixtureSetFaults(root, [{ point: "write", occurrence: 1, action: "hold" }]);
    const previousHolds = native.fixtureTrace(root).filter(t => t.point === "write" && t.syscall === "fixture-hold").length;
    await first.request("begin", ["terminate held native task"]);
    await waitForNative(() => native.fixtureTrace(root).filter(t => t.point === "write" && t.syscall === "fixture-hold").length > previousHolds);
    const terminated = first.worker.terminate(); let settled = false; void terminated.then(() => { settled = true; });
    await second.request("observe");
    assert.equal(settled, false); assert.ok(native.observeRoot(root).resources.pending > 0);
    native.fixtureRelease(root, "write"); await terminated;
    const survivor = await second.request<NativeResult>("prepare", "survived"); assert.equal(survivor.kind, "prepared-file", JSON.stringify({survivor,observation:native.observeRoot(root),status:native.fixtureTrace(root).filter(t=>t.syscall==="fixture-napi-status")}));
    await second.request("closeFiles"); assert.equal(native.observeRoot(root).resources.pending, 0, JSON.stringify({observation:native.observeRoot(root),fds:native.fixtureFdSnapshot(root),trace:native.fixtureTrace(root).slice(-12)}));
  } finally {
    for (const point of ["native-dispatch", "write"]) native.fixtureRelease(root, point);
    await Promise.all([first.worker.terminate(), second.worker.terminate()]);
    await native.closeRoot(root); await rm(directory, { recursive: true, force: true });
  }
});

test("#161 E3 full root close joins native completion and old generations stay invalid", { skip: !supportedMemoryNativePlatform, timeout: 20_000 }, async () => {
  const { native } = await buildMemoryNativeFixture(); const directory = await createMemoryRoot();
  const root = native.fixtureOpenRoot(directory, "close", 1048576);
  try {
    native.fixtureSetFaults(root, [{ point: "native-complete", occurrence: 1, action: "hold" }]);
    const pending = native.prepare(root, "close during native completion");
    await waitForNative(() => native.fixtureTrace(root).some(t => t.point === "native-complete" && t.syscall === "fixture-hold"));
    const closing = native.closeRoot(root), repeated = native.closeRoot(root);
    let settled = false; void closing.then(() => { settled = true; });
    failure(await native.prepare(root, "late"), "owner_closing");
    assert.equal(settled, false); assert.ok(native.observeRoot(root).resources.pending > 0);
    native.fixtureRelease(root, "native-complete");
    await pending; assert.equal((await closing).kind, "closed"); assert.equal((await repeated).kind, "closed");
    assert.equal(native.observeRoot(root).resources.fdOwned, 0);
    const replacement = native.fixtureOpenRoot(directory, "new-generation", 1048576);
    failure(await native.prepare(root, "old"), "invalid_owner");
    assert.equal((await native.closeRoot(root)).kind, "closed");
    const newFile = await native.prepare(replacement, "new"); assert.equal(newFile.kind, "prepared-file");
    assert.equal((await native.closeRoot(replacement)).kind, "closed");
  } finally { native.fixtureRelease(root, "native-complete"); await native.closeRoot(root); await rm(directory, { recursive: true, force: true }); }
});

test("#161 E3 synchronous async_hooks reentry can read or close without deadlock or abandoned staging", { skip: !supportedMemoryNativePlatform }, async () => {
  const { file } = await buildMemoryNativeFixture();
  for (const operation of ["read", "close"]) {
    const directory = await createMemoryRoot();
    try { await runMemoryChild(file, directory, `
      const {createHook}=await import('node:async_hooks');
      const n=createRequire(import.meta.url)(file),root=n.fixtureOpenRoot(directory,'reentry',1048576);
      let entered=false, nested;
      const hook=createHook({init(id,type){if(type==='memory-native-mechanical'&&!entered){entered=true;
        nested=${operation === "read" ? "n.readVerify(root,'a'.repeat(64),1)" : "n.closeRoot(root)"};
        assert.ok(nested instanceof Promise);
      }}}).enable();
      const outer=await n.prepare(root,'outer native task'); const inner=await nested;hook.disable();
      assert.equal(entered,true);
      if(${JSON.stringify(operation)}==='close'){assert.equal(inner.kind,'closed');assert.equal(outer.kind,'failed');assert.equal(n.observeRoot(root).resources.pending,0);}
      else {assert.equal(outer.kind,'prepared-file');assert.equal(inner.kind,'failed');}
      assert.equal((await n.closeRoot(root)).kind,'closed');
    `); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("#161 E3 read and prepared revalidation reject changes within the same timestamp second", { skip: !supportedMemoryNativePlatform }, async () => {
  const { file } = await buildMemoryNativeFixture();
  for (const mode of ["control-read", "mutate-read", "mutate-revalidate"]) {
    const directory = await createMemoryRoot();
    try { await runMemoryChild(file, directory, `
      const n=createRequire(import.meta.url)(file),root=n.fixtureOpenRoot(directory,'subsecond',1048576);
      let pending;
      try {
        // Observe a fresh wall-second window; never forge the file timestamps.
        while(Date.now()%1000>100) await new Promise(resolve=>setTimeout(resolve,10));
        const prepared=await n.prepare(root,'a'.repeat(131072));assert.equal(prepared.kind,'prepared-file');
        const canonical=path.join(directory,'objects/sha256',prepared.ref.contentSha256.slice(0,2),prepared.ref.contentSha256+'.md');
        const before=fs.statSync(canonical,{bigint:true});
        n.fixtureSetFaults(root,[{point:'read',occurrence:2,action:'hold'}]);
        pending=${mode === "mutate-revalidate" ? "n.revalidatePrepared(prepared.file)" : "n.readVerify(root,prepared.ref.contentSha256,prepared.ref.byteLength)"};
        const until=Date.now()+3000;
        while(!n.fixtureTrace(root).some(t=>t.point==='read'&&t.syscall==='fixture-hold')){
          assert.ok(Date.now()<until,'actual second read hold');await new Promise(resolve=>setImmediate(resolve));
        }
        if(${JSON.stringify(mode)}!=='control-read'){
          const fd=fs.openSync(canonical,'r+');try{assert.equal(fs.writeSync(fd,Buffer.from('b'),0,1,0),1);}finally{fs.closeSync(fd);}
        }
        const after=fs.statSync(canonical,{bigint:true});n.fixtureRelease(root,'read');
        const result=await pending;
        if(${JSON.stringify(mode)}==='control-read'){assert.equal(result.kind,'read');assert.equal(result.markdown,'a'.repeat(131072));}
        else {
          assert.equal(before.mtimeNs/1000000000n,after.mtimeNs/1000000000n,'mtime same actual second');
          assert.equal(before.ctimeNs/1000000000n,after.ctimeNs/1000000000n,'ctime same actual second');
          assert.ok(before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs,'actual nanoseconds changed');
          assert.equal(result.kind,'failed');assert.equal(result.primary.code,'object_integrity');
        }
        assert.equal((await n.closeRoot(root)).kind,'closed');
      } finally {n.fixtureRelease(root,'read');if(pending)await pending;await n.closeRoot(root);}
    `); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("#161 E3 cross-environment close requests keep bounded controls and coalesce duplicate callers", { skip: !supportedMemoryNativePlatform, timeout: 30_000 }, async () => {
  const { native, file } = await buildMemoryNativeFixture(); const directory = await createMemoryRoot();
  const root = native.fixtureOpenRoot(directory, "controls", 1048576);
  const workers = Array.from({ length: 9 }, () => memoryWorker(file, directory, "controls"));
  try {
    await Promise.all(workers.map(worker => worker.request("observe")));
    native.fixtureSetFaults(root, [{ point: "write", occurrence: 1, action: "hold" }]);
    const writing = native.prepare(root, "actual writer held while every environment closes");
    await waitForNative(() => native.fixtureTrace(root).some(t => t.point === "write" && t.syscall === "fixture-hold"));
    const closing = workers.map((worker, index) => worker.request<NativeResult>("close").then(result => ({ index, result })));
    const first = await Promise.race(closing); failure(first.result, "resource_unavailable");
    await waitForNative(() => native.observeRoot(root).resources.nativeTasks === 9);
    const same = workers[(first.index + 1) % workers.length]!.request<{ same: boolean; result: NativeResult }>("closeAgain");
    await workers[(first.index + 1) % workers.length]!.request("observe");
    assert.equal(native.observeRoot(root).resources.nativeTasks, 9);
    native.fixtureRelease(root, "write"); await writing;
    const results = await Promise.all(closing);
    assert.equal(results.filter(value => value.result.kind === "closed").length, 8);
    assert.equal((await same).same, true); assert.equal((await same).result.kind, "closed");
    assert.equal(native.observeRoot(root).resources.nativeTasks, 0);
    assert.equal(native.observeRoot(root).resources.fdOwned, 0);
  } finally {
    native.fixtureRelease(root, "write"); await Promise.all(workers.map(worker => worker.worker.terminate()));
    await native.closeRoot(root); await rm(directory, { recursive: true, force: true });
  }
});

test("#161 E3 injected deadline keeps actual pending responsibility through native completion hold", { skip: !supportedMemoryNativePlatform }, async () => {
  const { native } = await buildMemoryNativeFixture(); const directory = await createMemoryRoot();
  const root = native.fixtureOpenRoot(directory, "deadline", 1048576);
  try {
    native.fixtureSetFaults(root, [{ point: "deadline", occurrence: 1, action: "fail-before" }, { point: "native-complete", occurrence: 1, action: "hold" }]);
    let settled = false; const pending = native.prepare(root, "deadline body"); void pending.then(() => { settled = true; });
    await waitForNative(() => native.fixtureTrace(root).some(t => t.point === "native-complete" && t.syscall === "fixture-hold"));
    assert.equal(settled, false); assert.equal(native.observeRoot(root).resources.pending, 1);
    assert.equal(native.observeRoot(root).resources.nativeTasks, 1);
    native.fixtureRelease(root, "native-complete"); failure(await pending, "deadline_exceeded");
    assert.equal(native.observeRoot(root).resources.pending, 0);
  } finally { native.fixtureRelease(root, "native-complete"); await native.closeRoot(root); await rm(directory, { recursive: true, force: true }); }
});

test("#161 E3 short-repeat consumes actual 256 calls; only bounded close cleanup follows and responsibility persists", { skip: !supportedMemoryNativePlatform }, async () => {
  const { file } = await buildMemoryNativeFixture(); const directory = await createMemoryRoot();
  try { await runMemoryChild(file, directory, `
    const n = createRequire(import.meta.url)(file), root = n.fixtureOpenRoot(directory,'exhaustion',1048576);
    n.fixtureSetFaults(root,[{point:'write',occurrence:1,action:'short-repeat'}]);
    const result = await n.prepare(root,'a'.repeat(2048));
    assert.equal(result.kind,'failed'); assert.equal(result.primary.code,'native_call_limit');
    assert.ok(result.cleanup.some(f => f.code==='cleanup_unknown'));
    assert.ok(result.retained); assert.equal(result.resources.fdUnknown,0); assert.equal(result.resources.pending,1);
    const trace = n.fixtureTrace(root).filter(t => t.operation > 0);
    assert.equal(Math.max(...trace.map(t => t.calls)),256);
    const last = trace.findIndex(t => t.calls === 256);
    assert.ok(trace.slice(last+1).every(t => t.syscall === 'close'));
    assert.ok(trace.filter(t => t.syscall==='pwrite').length > 128);
    assert.equal(n.observeRoot(root).state,'retained');
    const before = fs.readdirSync(path.join(directory,'objects','.staging')); assert.equal(before.length,1);
    const closing = await n.closeRoot(root); assert.equal(closing.kind,'failed'); assert.equal(closing.primary.code,'cleanup_unknown');
    assert.deepEqual(fs.readdirSync(path.join(directory,'objects','.staging')),before);
    global.gc(); assert.throws(() => n.fixtureOpenRoot(directory,'exhaustion',1048576),/owner_closing/);
  `); } finally { await rm(directory, { recursive: true, force: true }); }
});

test("#161 E3 strict values and real protection failures have no coercion or implicit initialization", { skip: !supportedMemoryNativePlatform }, async () => {
  const { native } = await buildMemoryNativeFixture();
  const directory = await createMemoryRoot();
  const root = native.fixtureOpenRoot(directory, "small", 2);
  let touched = false;
  const fake = { toString() { touched = true; throw new Error("private text"); }, get digest() { touched = true; throw new Error("private text"); } };
  try {
    for (const body of ["aaa", "😀", "\ud800", "\udc00", 1, fake, Buffer.from("a"), null]) failure(await native.prepare(root, body), "invalid_input");
    for (const [digest, length] of [[fake, 1], ["A".repeat(64), 1], ["a".repeat(64), -1], ["a".repeat(64), -0], ["a".repeat(64), 0.1], ["a".repeat(64), 3], ["a".repeat(64), NaN]])
      failure(await native.readVerify(root, digest, length), "invalid_input");
    assert.equal(touched, false);
    assert.deepEqual(await readdir(path.join(directory, "objects", ".staging")), []);
    assert.equal(native.observeRoot(root).resources.pending, 0);
    await chmod(directory, 0o755);
    failure(await native.prepare(root, "ok"), "root_changed");
    await chmod(directory, 0o700);
  } finally { await native.closeRoot(root); await rm(directory, { recursive: true, force: true }); }
  const missing = await createMemoryRoot();
  try {
    await rm(path.join(missing, "objects", ".staging"), { recursive: true });
    assert.throws(() => native.fixtureOpenRoot(missing, "id", 1024), /memory_native:/);
    assert.equal((await readdir(path.join(missing, "objects"))).includes(".staging"), false);
    await symlink(path.join(missing, "objects", "sha256"), path.join(missing, "objects", ".staging"));
    assert.throws(() => native.fixtureOpenRoot(missing, "id", 1024), /memory_native:/);
  } finally { await rm(missing, { recursive: true, force: true }); }
});

test("#161 E3 EEXIST verifies and synchronizes its own canonical; corrupt and wrong-type leaves are preserved", { skip: !supportedMemoryNativePlatform }, async () => {
  const { native, file } = await buildMemoryNativeFixture();
  const directory = await createMemoryRoot();
  const root = native.fixtureOpenRoot(directory, "same", 1048576);
  const body = "same body";
  const digest = createHash("sha256").update(body).digest("hex");
  const canonical = path.join(directory, "objects", "sha256", digest.slice(0, 2), `${digest}.md`);
  try {
    const first = await native.prepare(root, body); assert.equal(first.kind, "prepared-file");
    if (first.kind !== "prepared-file") throw new Error("prepare rejected");
    await native.closePrepared(first.file);
    const identity = await stat(canonical);
    const second = await native.prepare(root, body);
    assert.equal(second.kind, "prepared-file");
    if (second.kind !== "prepared-file") throw new Error("prepare rejected");
    assert.equal(second.publication, "reused"); assert.equal((await stat(canonical)).ino, identity.ino);
    assert.equal(native.fixtureTrace(root).filter(t => t.point === "file-sync" && !t.injected && t.rc === 0).length, 4);
    await rename(canonical, `${canonical}.original`);
    await writeFile(canonical, body, { mode: 0o600 });
    failure(await native.revalidatePrepared(second.file), "object_integrity");
    assert.equal((await stat(`${canonical}.original`)).ino, identity.ino);
    await rm(`${canonical}.original`); await native.closePrepared(second.file);
    await writeFile(canonical, "bad bytes", { mode: 0o600 });
    failure(await native.prepare(root, body), "object_integrity");
    assert.equal(await readFile(canonical, "utf8"), "bad bytes");
    await rm(canonical); await mkdir(canonical, { mode: 0o700 });
    failure(await native.readVerify(root, digest, Buffer.byteLength(body)), "object_integrity");
    await rm(canonical, { recursive: true });
    await writeFile(canonical, body, { mode: 0o600 });
    await link(canonical, `${canonical}.linked`);
    failure(await native.prepare(root, body), "object_integrity");
    await rm(`${canonical}.linked`); await rm(canonical);
    await symlink(path.join(directory, "objects"), canonical);
    failure(await native.readVerify(root, digest, Buffer.byteLength(body)), "object_integrity");
    await rm(canonical);
    const invalidUtf8 = Buffer.from([0xc0, 0xaf]);
    const invalidDigest = createHash("sha256").update(invalidUtf8).digest("hex");
    const invalidLeaf = path.join(directory, "objects", "sha256", invalidDigest.slice(0, 2), `${invalidDigest}.md`);
    await mkdir(path.dirname(invalidLeaf), { recursive: true, mode: 0o700 }); await writeFile(invalidLeaf, invalidUtf8, { mode: 0o600 });
    failure(await native.readVerify(root, invalidDigest, invalidUtf8.length), "object_integrity");
    assert.deepEqual(await readFile(invalidLeaf), invalidUtf8);
    await runMemoryChild(file, directory, `
      const { execFileSync } = await import('node:child_process');
      const n = createRequire(import.meta.url)(file), root = n.fixtureOpenRoot(directory, 'fifo', 1048576);
      const digest = ${JSON.stringify(digest)}, canonical = ${JSON.stringify(canonical)};
      execFileSync('/usr/bin/mkfifo', [canonical]);
      for (const result of [await n.prepare(root, 'same body'), await n.readVerify(root, digest, 9)]) {
        assert.equal(result.kind, 'failed'); assert.equal(result.primary.code, 'object_integrity');
      }
      assert.equal(fs.lstatSync(canonical).isFIFO(), true);
      assert.equal((await n.closeRoot(root)).kind, 'closed');
    `);
  } finally { await native.closeRoot(root); await rm(directory, { recursive: true, force: true }); }
});

test("#161 E3 actual 8 pending and 64 descriptor boundaries include aliases and prepared owners", { skip: !supportedMemoryNativePlatform }, async () => {
  const { native } = await buildMemoryNativeFixture(); const directory = await createMemoryRoot();
  const root = native.fixtureOpenRoot(directory, "budget", 1048576);
  const alias = native.fixtureOpenRoot(directory, "budget", 1048576);
  try {
    const prepared = await Promise.all(Array.from({ length: 8 }, (_, i) => native.prepare(root, `document ${i}`)));
    assert.ok(prepared.every(r => r.kind === "prepared-file"), JSON.stringify(prepared));
    assert.equal(native.observeRoot(alias).resources.pending, 8);
    const before = native.observeRoot(root).resources;
    failure(await native.prepare(alias, "ninth"), "resource_unavailable");
    assert.deepEqual(native.observeRoot(root).resources, before);
    for (const item of prepared.slice(1)) if (item.kind === "prepared-file") await native.closePrepared(item.file);
    native.fixtureSetFaults(root, [{ point: "write", occurrence: 1, action: "hold" }]);
    const writing = native.prepare(root, "writer shares the actual 64 descriptor realm");
    await waitForNative(() => native.fixtureTrace(root).some(t => t.point === "write" && t.syscall === "fixture-hold"));
    const hold = native.fixtureFillFdBoundary(root);
    const fds = native.fixtureFdSnapshot(alias);
    assert.equal(fds.length, 64); assert.equal(new Set(fds.map(f => f.fd)).size, 64);
    const identities = fds.map(fd => fstatSync(fd.fd));
    assert.ok(identities.every(info => info.isDirectory() || info.isFile()));
    assert.ok(identities.filter(info => info.isFile()).length >= 2, "prepared canonical and actual temporary writer");
    assert.ok(identities.some(info => info.isDirectory()));
    const openCalls = native.fixtureTrace(root).filter(t => t.syscall === "open").length;
    assert.ok(openCalls > 0, "the trace must contain actual opens before the descriptor boundary");
    failure(await native.prepare(root, "sixty five"), "resource_unavailable");
    assert.equal(native.fixtureTrace(root).filter(t => t.syscall === "open").length, openCalls);
    assert.equal(native.observeRoot(root).resources.fdOwned, 64);
    assert.equal(native.fixtureCloseFdHold(hold).kind, "closed");
    native.fixtureRelease(root, "write");
    const written = await writing; assert.equal(written.kind, "prepared-file");
    for (const item of [prepared[0], written]) if (item?.kind === "prepared-file") await native.closePrepared(item.file);
    assert.equal(native.observeRoot(root).resources.pending, 0);
  } finally { native.fixtureRelease(root, "write"); await native.closeRoot(root); await rm(directory, { recursive: true, force: true }); }
});

test("#161 E3 fixture close is an actual task joined by another Worker's root close", { skip: !supportedMemoryNativePlatform }, async () => {
  const { file } = await buildMemoryNativeFixture(); const directory = await createMemoryRoot();
  try { console.log(await runMemoryChild(file, directory, `
    const n=createRequire(import.meta.url)(file),root=n.fixtureOpenRoot(directory,'fixture-close-join',1048576);
    let worker,rootClose,workerClose,closeSettled=false;
    const nextMessage=()=>new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);});
    try {
      worker=new Worker(\`
        const {parentPort,workerData}=require('node:worker_threads');
        const n=require(workerData.file),root=n.fixtureOpenRoot(workerData.directory,'fixture-close-join',1048576);
        let hold=n.fixtureFillFdBoundary(root);
        parentPort.postMessage({kind:'ready',observation:n.observeRoot(root)});
        parentPort.once('message',()=>{
          const result=n.fixtureCloseFdHold(hold);hold=null;
          parentPort.postMessage({kind:'closed-hold',result});parentPort.close();
        });
      \`,{eval:true,execArgv:[],workerData:{file,directory}});
      const ready=await nextMessage();assert.equal(ready.observation.resources.fdOwned,64);
      n.fixtureSetFaults(root,[{point:'file-close',occurrence:1,action:'hold'}]);
      workerClose=nextMessage();worker.postMessage('close');
      const until=Date.now()+10000;
      while(!n.fixtureTrace(root).some(t=>t.point==='file-close'&&t.syscall==='fixture-hold')){
        if(Date.now()>until)throw new Error('actual fixture close was not held');
        await new Promise(resolve=>setImmediate(resolve));
      }
      const held=n.observeRoot(root),heldSlots=n.fixtureFdSnapshot(root).filter(fd=>fd.state==='closing');
      assert.equal(heldSlots.length,1);assert.ok(fs.fstatSync(heldSlots[0].fd).isDirectory());
      rootClose=n.closeRoot(root).then(result=>{closeSettled=true;return result;});
      await Promise.race([rootClose,new Promise(resolve=>setTimeout(resolve,250))]);
      const beforeRelease={closeSettled,observation:n.observeRoot(root),closing:n.fixtureFdSnapshot(root).filter(fd=>fd.state==='closing')};
      n.fixtureRelease(root,'file-close');
      const closedHold=await workerClose,closedRoot=await rootClose;
      await worker.terminate();worker=null;global.gc();
      const afterRelease=n.observeRoot(root);
      console.log(JSON.stringify({fixtureCloseJoin:{held,beforeRelease,closedHold,closedRoot,afterRelease}}));
      assert.equal(beforeRelease.closeSettled,false,'root close must join the actual held close');
      assert.equal(held.resources.nativeTasks,1,'the synchronous fixture close owns a real native task');
      assert.equal(beforeRelease.observation.state,'closing');assert.equal(beforeRelease.closing.length,1);
      assert.equal(beforeRelease.observation.resources.pending,1);
      assert.equal(closedHold.result.kind,'closed');assert.equal(closedRoot.kind,'closed');
      assert.equal(afterRelease.state,'closed');
      assert.deepEqual(afterRelease.resources,{pending:0,fdReserved:0,fdOwned:0,fdUnknown:0,nativeTasks:0,preparedFiles:0,bodyBytes:0});
    } finally {
      n.fixtureRelease(root,'file-close');
      if(worker)await worker.terminate();
      if(rootClose)await rootClose;
      await n.closeRoot(root);
    }
  `)); } finally { await rm(directory, { recursive: true, force: true }); }
});

test("#161 E3 fixture hold rejects cleanup already owned by an actual root close", { skip: !supportedMemoryNativePlatform }, async () => {
  const { file } = await buildMemoryNativeFixture(); const directory = await createMemoryRoot();
  try { console.log(await runMemoryChild(file, directory, `
    const n=createRequire(import.meta.url)(file),root=n.fixtureOpenRoot(directory,'fixture-close-exclusive',1048576);
    let hold=n.fixtureFillFdBoundary(root),closing;
    try {
      n.fixtureSetFaults(root,[{point:'file-close',occurrence:1,action:'hold'}]);
      closing=n.closeRoot(root);
      const until=Date.now()+10000;
      while(!n.fixtureTrace(root).some(t=>t.point==='file-close'&&t.syscall==='fixture-hold')){
        if(Date.now()>until)throw new Error('actual root close was not held');
        await new Promise(resolve=>setImmediate(resolve));
      }
      const before=n.fixtureFdSnapshot(root),held=before.filter(fd=>fd.state==='closing');
      assert.equal(held.length,1);assert.ok(fs.fstatSync(held[0].fd).isDirectory());
      const refused=n.fixtureCloseFdHold(hold);
      const afterRefusal=n.fixtureFdSnapshot(root);
      n.fixtureRelease(root,'file-close');const closed=await closing;
      const repeated=n.fixtureCloseFdHold(hold);hold=null;global.gc();
      const afterRelease=n.observeRoot(root);
      console.log(JSON.stringify({fixtureCloseExclusive:{refused,before,afterRefusal,closed,repeated,afterRelease}}));
      assert.equal(refused.kind,'failed');assert.equal(refused.primary.code,'owner_closing');
      assert.deepEqual(afterRefusal,before,'the competing fixture close cannot touch an owned close');
      assert.equal(closed.kind,'closed');assert.equal(repeated.kind,'closed');assert.equal(afterRelease.state,'closed');
      assert.deepEqual(afterRelease.resources,{pending:0,fdReserved:0,fdOwned:0,fdUnknown:0,nativeTasks:0,preparedFiles:0,bodyBytes:0});
    } finally {
      n.fixtureRelease(root,'file-close');
      if(closing)await closing;
      await n.closeRoot(root);
    }
  `)); } finally { await rm(directory, { recursive: true, force: true }); }
});

test("#161 E3 unknown close remains owned and never closes a reused descriptor", { skip: !supportedMemoryNativePlatform }, async () => {
  const { file } = await buildMemoryNativeFixture();
  for (const action of ["close-then-error", "error-without-close"]) {
    const directory = await createMemoryRoot();
    try { await runMemoryChild(file, directory, `
      const n = createRequire(import.meta.url)(file), root = n.fixtureOpenRoot(directory, 'unknown', 1048576);
      const prepared = await n.prepare(root, 'retain'); assert.equal(prepared.kind, 'prepared-file');
      n.fixtureSetFaults(root, [{point:'file-close', occurrence:1, action:${JSON.stringify(action)}, errno:'EIO'}]);
      const result = await n.closePrepared(prepared.file); assert.equal(result.kind,'failed');
      assert.equal(result.primary.code,'cleanup_unknown'); assert.ok(result.retained);
      assert.equal(n.observeRoot(root).state,'retained'); assert.equal(result.resources.fdUnknown,1);
      const unknown = n.fixtureFdSnapshot(root).find(f => f.state === 'unknown').fd;
      const unrelated = [];
      for(let i=0;i<64;i++) {
        const fd=fs.openSync(path.join(directory,'unrelated-'+i),'w',0o600);unrelated.push(fd);
        if(${JSON.stringify(action)}==='error-without-close'||fd===unknown)break;
      }
      if(${JSON.stringify(action)}==='close-then-error')assert.ok(unrelated.includes(unknown),'must actually reuse the unknown numeric FD');
      assert.equal((await n.closePrepared(prepared.file)).kind,'failed');
      assert.equal((await n.closeRoot(root)).kind,'failed');
      assert.throws(() => n.fixtureOpenRoot(directory,'unknown',1048576),/memory_native:owner_closing/);
      global.gc(); await new Promise(r => setImmediate(r));
      for(const fd of unrelated){assert.ok(fs.fstatSync(fd).isFile());fs.closeSync(fd);}
      const closes = n.fixtureTrace(root).filter(t => t.syscall==='close' && t.injected);
      assert.equal(closes.length,1); console.log(JSON.stringify({action:${JSON.stringify(action)},unknown,unrelated,retained:n.observeRoot(root)}));
    `); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("#161 E3 real root selection, immutable aliases and exact byte publication", {
  skip: !supportedMemoryNativePlatform,
}, async () => {
  const { native } = await buildMemoryNativeFixture();
  const directory = await createMemoryRoot();
  const root = native.fixtureOpenRoot(directory, "storage:E3", 1048576);
  const alias = native.fixtureOpenRoot(directory, "storage:E3", 1048576);
  try {
    for (const [id, maximum] of [["other", 1048576], ["storage:E3", 1048575], ["storage:E3", 0]] as const)
      assert.throws(() => native.fixtureOpenRoot(directory, id, maximum), /memory_native:invalid_input/);
    for (const body of ["", "\ufeffA\r\n\0e\u0301😀", ...[1, 55, 56, 63, 64, 65, 1048576].map(n => "a".repeat(n))]) {
      const prepared = await native.prepare(root, body);
      assert.equal(prepared.kind, "prepared-file", JSON.stringify(prepared));
      if (prepared.kind !== "prepared-file") throw new Error("prepare rejected");
      const digest = createHash("sha256").update(body).digest("hex");
      const encoded = encodeMemoryObjectBody(body, 1048576);
      assert.equal(encoded.contentSha256, digest); assert.equal(encoded.byteLength, Buffer.byteLength(body));
      assert.deepEqual(parseMemoryObjectRef(prepared.ref), prepared.ref);
      assert.deepEqual(prepared.ref, { objectFormat: "utf8-sha256-v1", storageId: "storage:E3", contentSha256: digest, byteLength: Buffer.byteLength(body) });
      const file = path.join(directory, "objects", "sha256", digest.slice(0, 2), `${digest}.md`);
      assert.deepEqual(await readFile(file), Buffer.from(body));
      const info = await stat(file);
      assert.equal(info.nlink, 1); assert.equal(info.mode & 0o7777, 0o600);
      assert.equal(prepared.resources.pending, 1);
      const read = await native.readVerify(alias, digest, Buffer.byteLength(body));
      assert.equal(read.kind, "read", JSON.stringify(read));
      if (read.kind === "read") assert.equal(read.markdown, body);
      assert.equal((await native.revalidatePrepared(prepared.file)).kind, "file-current");
      assert.equal((await native.closePrepared(prepared.file)).kind, "closed");
      assert.equal(native.observeRoot(root).resources.pending, 0);
    }
  } finally {
    assert.equal((await native.closeRoot(root)).kind, "closed");
    await rm(directory, { recursive: true, force: true });
  }
});

test("#161 E3 the last loading Worker may exit without erasing retained root responsibility", { skip: !supportedMemoryNativePlatform }, async () => {
  const { file } = await buildMemoryNativeFixture(); const directory = await createMemoryRoot();
  try { await runMemoryChild(file, directory, `
    // Deliberately never require the addon in this process's main environment.
    async function workerOnce(mode) {
      const worker = new Worker(\`
        const {parentPort,workerData} = require('node:worker_threads');
        const n = require(workerData.file);
        (async () => {
          if(workerData.mode==='leave') {
            const root = n.fixtureOpenRoot(workerData.directory,'last-env',1048576);
            const prepared = await n.prepare(root,'unknown after last env');
            n.fixtureSetFaults(root,[{point:'file-close',occurrence:1,action:'error-without-close',errno:'EIO'}]);
            const result = await n.closePrepared(prepared.file);
            parentPort.postMessage({result,fds:n.fixtureFdSnapshot(root)});
          } else {
            try { n.fixtureOpenRoot(workerData.directory,'last-env',1048576); parentPort.postMessage({accepted:true}); }
            catch(error) {parentPort.postMessage({code:error.code});}
          }
          parentPort.close();
        })().catch(error => { throw error; });
      \`,{eval:true,execArgv:[],workerData:{file,directory,mode}});
      const message = new Promise((resolve,reject) => {worker.once('message',resolve);worker.once('error',reject);});
      const exit = new Promise((resolve,reject) => {worker.once('exit',resolve);worker.once('error',reject);});
      const value = await message; assert.equal(await exit,0); return value;
    }
    const first = await workerOnce('leave');
    assert.equal(first.result.kind,'failed'); assert.equal(first.result.resources.fdUnknown,1);
    const unknown = first.fds.find(f => f.state==='unknown'); assert.ok(fs.fstatSync(unknown.fd).isFile());
    for(let i=0;i<2;i++) assert.equal((await workerOnce('reopen')).code,'owner_closing');
    assert.ok(fs.fstatSync(unknown.fd).isFile()); console.log('last-env native retention observed');
  `); } finally { await rm(directory, { recursive: true, force: true }); }
  for (const variant of ["missing", "wrong-image"] as const) {
    const built = await buildMemoryPinFailure(variant); const root = await createMemoryRoot();
    try { await runMemoryChild(built.file, root, `
      assert.throws(() => createRequire(import.meta.url)(file), error => error.code === 'native_abi_unavailable');
      assert.deepEqual(fs.readdirSync(path.join(directory,'objects','.staging')),[]);
    `); } finally { await rm(root, { recursive: true, force: true }); await rm(built.directory, { recursive: true, force: true }); }
  }
});

test("#161 E3 real GC releases only its wrapper and finished operations do not accumulate", { skip: !supportedMemoryNativePlatform }, async () => {
  const { file } = await buildMemoryNativeFixture(); const directory = await createMemoryRoot();
  try { await runMemoryChild(file, directory, `
    const n = createRequire(import.meta.url)(file);
    let discarded = n.fixtureOpenRoot(directory,'gc',1048576);
    const live = n.fixtureOpenRoot(directory,'gc',1048576);
    let finalized=false; const registry=new FinalizationRegistry(() => {finalized=true;});
    registry.register(discarded,'root'); discarded=null;
    const prepared = await n.prepare(live,'kept alive'); assert.equal(prepared.kind,'prepared-file');
    const until=Date.now()+10000;
    while(!finalized&&Date.now()<until){global.gc();await new Promise(r => setImmediate(r));}
    assert.equal(finalized,true); assert.equal((await n.revalidatePrepared(prepared.file)).kind,'file-current');
    await n.closePrepared(prepared.file);
    const count=n.fixtureTrace(live).filter(t => t.syscall==='fixture-retire-operation').length;
    for(let i=0;i<1000;i++) assert.equal((await n.prepare(live,42)).primary.code,'invalid_input');
    assert.equal(n.fixtureTrace(live).filter(t => t.syscall==='fixture-retire-operation').length-count,1000);
    assert.equal(n.observeRoot(live).resources.pending,0);
    assert.equal((await n.closeRoot(live)).kind,'closed');
  `); } finally { await rm(directory, { recursive: true, force: true }); }
});

test("#161 E3 1 MiB works at the supported 32-level root and replacement roots are rejected", { skip: !supportedMemoryNativePlatform }, async () => {
  const { native } = await buildMemoryNativeFixture(); const parent = await createMemoryRoot();
  let directory = parent;
  for (let depth = directory.split(path.sep).filter(Boolean).length + 1; depth < 32; depth++) {
    directory = path.join(directory, "d"); await mkdir(directory, { mode: 0o700 });
  }
  await mkdir(path.join(directory, "objects"), { mode: 0o700 });
  await mkdir(path.join(directory, "objects", "sha256"), { mode: 0o700 });
  await mkdir(path.join(directory, "objects", ".staging"), { mode: 0o700 });
  const root = native.fixtureOpenRoot(directory, "deep", 1048576);
  try {
    const result = await native.prepare(root, "a".repeat(1048576)); assert.equal(result.kind, "prepared-file", JSON.stringify(result));
    if (result.kind !== "prepared-file") throw new Error("maximum rejected");
    assert.ok(native.fixtureTrace(root).filter(t => t.operation > 0).every(t => t.calls <= 256));
    await native.closePrepared(result.file);
    await mkdir(path.join(directory, "too-deep"), { mode: 0o700 });
    assert.throws(() => native.fixtureOpenRoot(path.join(directory, "too-deep"), "deep", 1048576), /invalid_input/);
    const moved = `${directory}-moved`; await rename(directory, moved); await mkdir(directory, { mode: 0o700 });
    failure(await native.prepare(root, "new location"), "root_changed");
    assert.deepEqual(await readdir(directory), []);
  } finally { await native.closeRoot(root); await rm(parent, { recursive: true, force: true }); }
});

test("#161 E3 independent processes use native noreplace and the EEXIST process performs its own sync", { skip: !supportedMemoryNativePlatform }, async () => {
  const { file } = await buildMemoryNativeFixture(); const directory = await createMemoryRoot();
  const simple = (body: string) => `
    const n=createRequire(import.meta.url)(file),root=n.fixtureOpenRoot(directory,'processes',1048576);
    const result=await n.prepare(root,${JSON.stringify(body)});assert.equal(result.kind,'prepared-file');
    console.log(JSON.stringify({publication:result.publication,ref:result.ref}));
    assert.equal((await n.closeRoot(root)).kind,'closed');
  `;
  try {
    const same = await Promise.all([runMemoryChild(file, directory, simple("same")), runMemoryChild(file, directory, simple("same"))]);
    assert.deepEqual(same.map(line => (JSON.parse(line) as { publication: string }).publication).sort(), ["created", "reused"]);
    await Promise.all([runMemoryChild(file, directory, simple("one")), runMemoryChild(file, directory, simple("two"))]);
    const shared = `
      const n=createRequire(import.meta.url)(file),root=n.fixtureOpenRoot(directory,'processes',1048576);
      const ready=path.join(directory,'ready'),release=path.join(directory,'release');
      async function wait(predicate){const until=Date.now()+15000;while(!predicate()){assert.ok(Date.now()<until);await new Promise(r=>setTimeout(r,2));}}
    `;
    await Promise.all([
      runMemoryChild(file, directory, shared + `
        n.fixtureSetFaults(root,[{point:'directory-sync',occurrence:2,action:'hold'}]);
        const pending=n.prepare(root,'interleaved publication');
        await wait(()=>n.fixtureTrace(root).some(t=>t.syscall==='fixture-hold'));
        fs.writeFileSync(ready,'ready');await wait(()=>fs.existsSync(release));n.fixtureRelease(root,'directory-sync');
        assert.equal((await pending).kind,'prepared-file');assert.equal((await n.closeRoot(root)).kind,'closed');
      `),
      runMemoryChild(file, directory, shared + `
        await wait(()=>fs.existsSync(ready));const result=await n.prepare(root,'interleaved publication');
        assert.equal(result.kind,'prepared-file');assert.equal(result.publication,'reused');
        assert.equal(n.fixtureTrace(root).filter(t=>t.point==='file-sync'&&t.rc===0).length,2);
        fs.writeFileSync(release,'release');assert.equal((await n.closeRoot(root)).kind,'closed');
      `),
    ]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("#161 E3 actual failure facts retain their order and injected short IO and deadlines stay bounded", { skip: !supportedMemoryNativePlatform }, async () => {
  const { file } = await buildMemoryNativeFixture();
  const plans = [
    [{ point: "write", occurrence: 1, action: "zero" }],
    [{ point: "read", occurrence: 1, action: "short-one" }],
    [{ point: "write", occurrence: 1, action: "short-one" }],
    [{ point: "file-sync", occurrence: 1, action: "fail-before", errno: "ENOTSUP" }],
    [{ point: "publish-noreplace", occurrence: 1, action: "fail-before", errno: "ENOSYS" }],
    [{ point: "publish-noreplace", occurrence: 1, action: "fail-before", errno: "EXDEV" }],
    [{ point: "directory-sync", occurrence: 2, action: "fail-before", errno: "EIO" }],
    [{ point: "native-dispatch", occurrence: 1, action: "fail-before", errno: "EIO" }],
    [{ point: "deadline", occurrence: 1, action: "fail-before", errno: "EIO" }],
    [{ point: "write", occurrence: 1, action: "zero" }, { point: "temporary-unlink", occurrence: 1, action: "fail-before", errno: "EIO" },
      { point: "file-close", occurrence: 1, action: "error-without-close", errno: "EIO" }, { point: "directory-close", occurrence: 1, action: "close-then-error", errno: "EIO" }],
  ];
  for (const plan of plans) {
    const directory = await createMemoryRoot();
    try { await runMemoryChild(file, directory, `
      const n=createRequire(import.meta.url)(file),root=n.fixtureOpenRoot(directory,'fault',1048576),plans=${JSON.stringify(plan)};
      n.fixtureSetFaults(root,plans);const result=await n.prepare(root,'bounded fault body');
      if(plans[0].action==='short-one') assert.equal(result.kind,'prepared-file');
      else {
        assert.equal(result.kind,'failed');assert.ok(Object.isFrozen(result.primary));
        if(plans.length>1){assert.equal(result.primary.stage,'temporary-write');assert.ok(result.cleanup.filter(f=>f.call.rc===-1).length>=2);assert.ok(result.retained);}
        if(plans[0].point==='deadline')assert.equal(result.primary.code,'deadline_exceeded');
      }
      const closing=await n.closeRoot(root);
      if(n.observeRoot(root).state==='closed')assert.equal(closing.kind,'closed');else assert.equal(closing.kind,'failed');
    `); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("#161 E3 complete A inventory drives 17 real objects in 8/8/1 and preserves every version reference", { skip: !supportedMemoryNativePlatform }, async () => {
  const { native } = await buildMemoryNativeFixture(); const directory = await createMemoryRoot();
  const root = native.fixtureOpenRoot(directory, "inventory", 1048576);
  const bodies = [...Array.from({ length: 17 }, (_, i) => `historical body ${i}`), "historical body 0"];
  const actor = JSON.stringify({ kind: "agent", actorId: "agent:1", agentId: "agent-1", displayName: "Agent" });
  const at = "2026-11-18T00:00:00.000Z", digest = (body: string) => createHash("sha256").update(body).digest("hex");
  const columns = [
    ["id", "scope", "project_id", "agent_id", "version", "markdown", "byte_length", "updated_at", "updated_by", "source"],
    ["id", "document_id", "version", "parent_version", "markdown", "byte_length", "content_sha256", "author", "actor_id", "source", "client_mutation_id", "summary_request_id", "created_at"],
    ["id", "project_id", "agent_id", "recipient_member_id", "context_group_id", "document_id", "base_version", "revision", "state", "trigger", "trigger_key", "task_id", "completed_task_revision", "message_ids", "source_work_event_id", "retry_of_request_id", "attempt_id", "begin_mutation_id", "result_version", "result_sha256", "error", "evidence", "created_at", "started_at", "finished_at"],
  ];
  const raw: (string | null)[][][] = [
    [["document", "global", null, "agent-1", "18", bodies[17]!, String(Buffer.byteLength(bodies[17]!)), at, actor, "agent"]],
    bodies.map((body, i) => [`version-${i}`, "document", String(i + 1), String(i), body, String(Buffer.byteLength(body)), digest(body), actor, "agent:1", "agent", `mutation-${i}`, null, at]), [],
  ];
  const integers = [[4, 6], [2, 3, 5], [6, 7, 12, 18]];
  const names = ["memory_documents", "memory_versions", "memory_summary_requests"];
  const tables = raw.map((rows, i) => {
    const encoded = rows.map(row => row.map((value, j) => value === null ? ["null"] : integers[i]!.includes(j) ? ["integer", value] : ["text", Buffer.from(value).toString("hex")]));
    const summary = digestRowMultiset(encoded);
    return { name: names[i], columns: columns[i], rows: encoded, expectedCount: summary.count, expectedDigest: summary.digest };
  });
  const inventory = buildLayoutMemoryInventory({ contract: "layout-memory-input/r1", source: { kind: "sqlite", databaseInstanceId: "1".repeat(32), identityDigest: "2".repeat(64) },
    frozenManifest: { ref: "test-frozen-input", sha256: "3".repeat(64), bytes: "100" }, storageId: "inventory", dialect: "sqlite", tables });
  assert.equal(inventory.objects.length, 17); assert.equal(inventory.versions.length, 18);
  const text = new Map(bodies.map(body => [digest(body), body]));
  try {
    const sizes: number[] = [];
    for (let start = 0; start < inventory.objects.length; start += 8) {
      const batch = inventory.objects.slice(start, start + 8); sizes.push(batch.length);
      const results = await Promise.all(batch.map(ref => native.prepare(root, text.get(ref.contentSha256)!)));
      assert.equal(native.observeRoot(root).resources.pending, batch.length);
      for (const result of results) {
        assert.equal(result.kind, "prepared-file", JSON.stringify(result));
        if (result.kind === "prepared-file") {
          assert.equal((await native.revalidatePrepared(result.file)).kind, "file-current");
          await native.closePrepared(result.file);
        }
      }
      assert.equal(native.observeRoot(root).resources.pending, 0);
    }
    assert.deepEqual(sizes, [8, 8, 1]);
    for (const version of inventory.versions) assert.equal((await native.readVerify(root, version.object.contentSha256, version.object.byteLength)).kind, "read");
    const first = inventory.objects[0]!;
    await writeFile(path.join(directory, "objects", "sha256", first.contentSha256.slice(0, 2), `${first.contentSha256}.md`), "tampered", { mode: 0o600 });
    failure(await native.readVerify(root, first.contentSha256, first.byteLength), "object_integrity");
  } finally { await native.closeRoot(root); await rm(directory, { recursive: true, force: true }); }
});

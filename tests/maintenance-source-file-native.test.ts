import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { closeSync, constants, fstatSync, openSync, readSync, readdirSync } from "node:fs";
import { chmod, cp, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir, constants as osConstants } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withNativeSourceRoot, observeSourceFile, observeSourceFileRootContext, sourceFileNativePath } from "../src/server/storage/maintenance/source-file-native.ts";
import type { SourceFileExtendedObservation, SourceFileNativeCall, SourceFileContextFact, SourceFileKernelReadValue, SourceFileRootEnvironment } from "../src/server/storage/maintenance/source-file-native.ts";
import { matchSourceFileProfile } from "../src/server/storage/maintenance/source-file-profile.ts";
import type { SourceFileMountBinding } from "../src/server/storage/maintenance/source-file-profile.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";

const linuxTest = process.platform === "linux" ? test : test.skip;
const root = fileURLToPath(new URL("../", import.meta.url));
/** This isolated source exports only a pure ABI decoder. It neither replaces
 * the production binding/registry nor registers any synthetic root/profile. */
interface PureNativeDecoders {
  checkedBlockAttributes(value: unknown, source: any, device: any, calls: readonly SourceFileNativeCall[]): any;
  checkedEnvironment(value: unknown, info: any, tail?: boolean): SourceFileRootEnvironment;
  checkedKernelReadFact(value: unknown, limit: number, samples?: 1 | 2): SourceFileContextFact<SourceFileKernelReadValue>;
  checkedAuxiliaryCalls(value: unknown, complete?: boolean, unavailableGraph?: boolean): readonly SourceFileNativeCall[];
  checkedEnumeration(value: unknown, index: number): readonly SourceFileNativeCall[];
}
async function withNativeDecoders(consume: (decode: PureNativeDecoders) => void) {
  const directory = await mkdtemp(path.join(tmpdir(), "br-p3-decoder-"));
  try {
    const original = path.join(root, "src/server/storage/maintenance/source-file-native.ts");
    const source = (await readFile(original, "utf8")).replace('from "./error.ts"',
      `from ${JSON.stringify(pathToFileURL(path.join(root, "src/server/storage/maintenance/error.ts")).href)}`);
    const file = path.join(directory, "native-decoder.mts");
    await writeFile(file, source + "\nexport { checkedKernelReadFact, checkedAuxiliaryCalls, checkedEnumeration, checkedBlockAttributes, checkedEnvironment };\n");
    const module = await import(pathToFileURL(file).href) as PureNativeDecoders;
    consume(module);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
interface PureProfileParsers {
  parseStatx(raw: Buffer, unique: boolean, metadata: unknown): Record<string, bigint>;
  parseMount(raw: { request: Buffer; result: Buffer }, legacy: unknown, unique: unknown): SourceFileMountBinding;
  selectedMountinfo(raw: Buffer, mount: SourceFileMountBinding): unknown;
  ordinaryProcess(environment: unknown): unknown;
  parseOptions(raw: Buffer): Readonly<Record<string, string | true>>;
  boundHealth(environment: unknown, mount: SourceFileMountBinding): unknown;
  analyzeEnvironment(context: unknown): { configuration: unknown; unresolved: readonly string[]; contextBinding: string; windowBinding: string };
  typed(value: unknown): unknown;
}
/** Exposes only pure mechanical parsers. FIXED_PROFILES, owner registration,
 * selection and SourceProfile construction remain unchanged and unexported. */
async function withProfileParsers(consume: (parsers: PureProfileParsers) => void) {
  const directory = await mkdtemp(path.join(tmpdir(), "br-p3-profile-parsers-"));
  try {
    const base = path.join(root, "src/server/storage/maintenance");
    let source = await readFile(path.join(base, "source-file-profile.ts"), "utf8");
    for (const name of ["canonical.ts", "error.ts", "source-file-native.ts"])
      source = source.replaceAll(`from "./${name}"`, `from ${JSON.stringify(pathToFileURL(path.join(base, name)).href)}`);
    const file = path.join(directory, "profile-parsers.mts");
    await writeFile(file, source + "\nexport { parseStatx, parseMount, selectedMountinfo, ordinaryProcess, parseOptions, boundHealth, analyzeEnvironment, typed };\n");
    consume(await import(pathToFileURL(file).href) as PureProfileParsers);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Inert ABI/parser values from the accepted x86_64 statx/statmount layouts.
 * They are never submitted to native acquisition, the registry, or S. */
function mbSummaryFixture(bit: 0 | 1 = 0, maximum = false): string {
  const groups = Array.from({ length: 14 }, (_, order) => `\tlist_order_${order}_groups: ${maximum ? 4294967295 : order}\n`).join("");
  return `optimize_scan: ${bit}\nmax_free_order_lists:\n${groups}avg_fragment_size_lists:\n${groups}`;
}
function profileParserFixture(): any {
  const metadata = { kind: "file", dev: 2049n, ino: 9007199254741001n, mode: 0o100600n, uid: 1001n, gid: 1001n,
    nlink: 1n, size: 7n, fsType: 0xef53n, atimeNs: 1000000002n, mtimeNs: 2000000003n, ctimeNs: 3000000004n };
  function statx(unique: boolean): Buffer {
    const raw = Buffer.alloc(256);
    raw.writeUInt32LE(0xfff | (unique ? 0x4000 : 0x1000), 0);
    raw.writeBigUInt64LE(0x200800n, 56); raw.writeUInt32LE(1, 16);
    raw.writeUInt32LE(1001, 20); raw.writeUInt32LE(1001, 24); raw.writeUInt16LE(Number(metadata.mode), 28);
    raw.writeBigUInt64LE(metadata.ino, 32); raw.writeBigUInt64LE(metadata.size, 40);
    for (const [offset, value] of [[64, metadata.atimeNs], [80, 1n], [96, metadata.ctimeNs], [112, metadata.mtimeNs]] as const) {
      raw.writeBigInt64LE(value / 1000000000n, offset); raw.writeUInt32LE(Number(value % 1000000000n), offset + 8);
    }
    raw.writeUInt32LE(8, 136); raw.writeUInt32LE(1, 140); raw.writeBigUInt64LE(unique ? 9007199254740995n : 17n, 144);
    return raw;
  }
  const legacyBytes = statx(false), uniqueBytes = statx(true), strings = Buffer.from("ext4\0/\0/source path\0");
  const request = Buffer.alloc(32), result = Buffer.alloc(512 + strings.length);
  request.writeUInt32LE(32, 0); request.writeBigUInt64LE(9007199254740995n, 8); request.writeBigUInt64LE(59n, 16);
  result.writeUInt32LE(result.length, 0); result.writeBigUInt64LE(59n, 8); result.writeUInt32LE(8, 16); result.writeUInt32LE(1, 20);
  result.writeBigUInt64LE(0xef53n, 24); result.writeBigUInt64LE(9007199254740995n, 40); result.writeUInt32LE(17, 56);
  result.writeBigUInt64LE(0x40000n, 72); result.writeUInt32LE(5, 104); result.writeUInt32LE(7, 108); strings.copy(result, 512);
  const mountinfo = Buffer.from("17 1 8:1 / /source\\040path rw,relatime - ext4 /dev/vdb1 rw,data=ordered\n");
  const observed = (value: unknown) => ({ status: "observed", reason: null, value, calls: [] });
  const read = (bytes: string, inode = 40n, samples: 1 | 2 = 1) => {
    const fact = kernelReadFixture(samples) as any;
    Object.assign(fact.value, { bytes: Buffer.from(bytes), device: 7n, inode });
    fact.calls[3].rc = BigInt(Buffer.byteLength(bytes));
    if (samples === 2) fact.calls[11].rc = BigInt(Buffer.byteLength(bytes));
    return fact;
  };
  const uid = [1001n, 1001n, 1001n, 1001n], gid = [...uid];
  const status = "Name:\tfixture\nTgid:\t222\nPid:\t222\nUid:\t1001\t1001\t1001\t1001\nGid:\t1001\t1001\t1001\t1001\nGroups:\t\nNoNewPrivs:\t1\n"
    + ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].map(name => `${name}:\t0000000000000000\n`).join("");
  const uname = Buffer.alloc(390);
  ["Linux", "fixture", "7.0", "fixture-build", "x86_64", "(none)"].forEach((value, index) => uname.write(value, index * 65));
  const deviceIdentity = { device: 7n, inode: 31n, mode: 0o040555n, filesystemType: 0x62656572n };
  const binding = { sourceDevMajor: 8n, sourceDevMinor: 1n, sysfs: deviceIdentity,
    kernelName: Buffer.from("vdb1"), resolved: Buffer.from("/sys/devices/fixture/vdb1"), sbId: Buffer.from("vdb1") };
  const dev = read("8:1\n", 40n, 2), uevent = read("DEVNAME=vdb1\n", 41n, 2);
  const healthNames = ["errors_count", "first_error_errcode", "last_error_errcode", "first_error_ino", "last_error_ino", "first_error_block",
    "last_error_block", "first_error_line", "last_error_line", "first_error_time", "last_error_time", "first_error_func", "last_error_func"];
  const environment = {
    process: { identity: observed({ pid: 222n, tid: 222n, uid, gid, groups: [], noNewPrivileges: 1n }),
      threadStatus: read(status), processStat: read(`222 (fixture) S ${Array<string>(18).fill("0").join(" ")} 987654321\n`),
      namespaces: observed({ pid: { inode: 1n }, mount: { inode: 2n }, user: { inode: 3n } }) },
    kernel: { uname: observed(uname), notes: read("fixture-not-a-qualified-build"), config: { status: "unavailable", reason: "unsupported", value: null, calls: [] } },
    mount: { legacyStatx: observed(legacyBytes), uniqueStatx: observed(uniqueBytes), statmount: observed({ request, result }), mountinfo: read(mountinfo.toString()) },
    configuration: { tune: observed(Buffer.alloc(232)), options: read("rw\ndata=ordered\nerrors=remount-ro\n", 42n, 2), mbGroups: read("raw-mb-groups\n", 43n, 2),
      mbStructsSummary: read(mbSummaryFixture(), 44n, 2),
      journalTaskBefore: read("333\n"), journalTaskAfter: read("333\n"), journalIoprio: observed({ which: 1n, who: 333n, rawValue: 16388n }) },
    device: { binding: observed(binding), dev, uevent, topology: observed({ nodes: [{ index: 0, major: 8n, minor: 1n, identity: deviceIdentity,
      kernelName: binding.kernelName, resolved: binding.resolved, dev, uevent, holders: [], slaves: [] }], edges: [] }),
      blockAttributes: { readerRevision: 1, sourceNodeIndex: 0, ...Object.fromEntries(["size", "readOnly", "diskSequence"].map(name => [name,
        { status: "unavailable", reason: "binding", value: null, calls: [] }])) } },
    health: { binding: observed({ sourceDevMajor: 8n, sourceDevMinor: 1n, device: deviceIdentity,
      health: { ...deviceIdentity, inode: 32n }, sbId: binding.sbId }),
      fields: healthNames.map((name, index) => ({ name, fact: read(index >= 11 ? "\n" : "0\n", BigInt(100 + index)) })) },
    auxiliaryCalls: [],
  };
  const context = { info: { abiVersion: 1, kind: "file", stage: "readable", metadata }, environment,
    root: { before: metadata, after: metadata, metadataCalls: [], uuid: observed({ length: 16n, bytes: Buffer.alloc(16, 1) }),
      fid: observed({ handleType: 1n, handleBytes: 8n, mountId: 9007199254740995n, bytes: Buffer.alloc(8, 2) }),
      inodeFlags: observed(0x80000n), xattrs: observed([]) },
    uniqueStatx: { uniqueMountId: 9007199254740995n, ino: metadata.ino }, legacyStatx: { mountId: 17n, ino: metadata.ino } };
  return { metadata, legacyBytes, uniqueBytes, request, result, mountinfo, environment, context };
}

test("#152 IG1 metadata-only bootstrap rejects DAX before readable promotion", async () => {
  await withProfileParsers(parse => {
    const fixture = profileParserFixture();
    for (const raw of [fixture.legacyBytes, fixture.uniqueBytes]) raw.writeBigUInt64LE(0x200000n, 8);
    const context = { info: { ...fixture.context.info, stage: "metadata-only" }, environment: fixture.environment };
    assert.throws(() => parse.analyzeEnvironment(context), { code: "backup_capability_unavailable" });
  });
});

test("#152 IG1 actual analysis requires known clear encrypted and DAX facts in every context", async () => {
  await withProfileParsers(parse => {
    for (const stage of ["readable", "bootstrap", "tail"]) {
      const make = () => {
        const value = profileParserFixture();
        const context = stage === "readable" ? value.context
          : { info: { ...value.context.info, stage: "metadata-only" }, environment: { ...value.environment, abiVersion: stage === "tail" ? 3 : 2 } };
        return { ...value, context };
      };
      assert.equal(parse.analyzeEnvironment(make().context).unresolved.length, 4);
      for (const bit of [0x800n, 0x200000n]) for (const change of ["set", "missing-mask", "mismatch"]) {
        const value = make();
        const raws = change === "mismatch" ? [value.uniqueBytes] : [value.legacyBytes, value.uniqueBytes];
        for (const raw of raws) {
          if (change === "missing-mask") raw.writeBigUInt64LE(raw.readBigUInt64LE(56) & ~bit, 56);
          else raw.writeBigUInt64LE(bit, 8);
        }
        assert.throws(() => parse.analyzeEnvironment(value.context),
          { code: change === "mismatch" ? "source_changed" : "backup_capability_unavailable" }, `${stage}/${bit}/${change}`);
      }
    }
    for (const kind of ["file", "directory"]) for (const flags of [0x80000n, 0x81000n, 0n, 0x40n, 0x80800n, 0x180000n, 0x2080000n, 0x40080000n, 1n << 42n]) {
      const value = profileParserFixture(); value.context.root.inodeFlags.value = flags;
      if (kind === "directory") {
        value.metadata.kind = "directory"; value.metadata.mode = 0o40700n; value.metadata.nlink = 2n; value.context.info.kind = "directory";
        for (const raw of [value.legacyBytes, value.uniqueBytes]) { raw.writeUInt32LE(2, 16); raw.writeUInt16LE(0o40700, 28); }
      }
      if (flags === 0x80000n || kind === "directory" && flags === 0x81000n)
        assert.equal(parse.analyzeEnvironment(value.context).unresolved.length, 4);
      else assert.throws(() => parse.analyzeEnvironment(value.context), { code: "backup_capability_unavailable" }, `${kind}/${flags}`);
    }
  });
});

test("#152 P3 pure statx and mount parsers bind separate IDs, exact ABI and complete mountinfo", async () => {
  await withProfileParsers(parse => {
    const fixture = profileParserFixture(), legacy = parse.parseStatx(fixture.legacyBytes, false, fixture.metadata);
    const unique = parse.parseStatx(fixture.uniqueBytes, true, fixture.metadata);
    const mount = parse.parseMount(fixture, legacy, unique);
    assert.equal(mount.legacyMountId, 17n); assert.equal(mount.uniqueMountId, 9007199254740995n);
    assert.equal(mount.point, "/source path"); assert.doesNotThrow(() => parse.selectedMountinfo(fixture.mountinfo, mount));
    const coincident = profileParserFixture(); coincident.uniqueBytes.writeBigUInt64LE(17n, 144);
    coincident.request.writeBigUInt64LE(17n, 8); coincident.result.writeBigUInt64LE(17n, 40);
    assert.equal(parse.parseMount(coincident, legacy, parse.parseStatx(coincident.uniqueBytes, true, coincident.metadata)).uniqueMountId, 17n,
      "numerical coincidence does not merge or invalidate two independently bound ID namespaces");
    for (const change of ["wrong-mask", "bad-nanos", "wrong-inode", "request-id", "unterminated-path", "wrong-encoding", "missing-eof", "duplicate-id", "bad-escape"]) {
      const value = profileParserFixture();
      if (change === "wrong-mask") value.uniqueBytes.writeUInt32LE(0x1fff, 0);
      if (change === "bad-nanos") value.uniqueBytes.writeUInt32LE(1000000000, 72);
      if (change === "wrong-inode") value.uniqueBytes.writeBigUInt64LE(1n, 32);
      if (change === "request-id") value.request.writeBigUInt64LE(17n, 8);
      if (change === "unterminated-path") value.result[value.result.length - 1] = 65;
      if (change === "wrong-encoding") value.result[520] = 255;
      if (change === "missing-eof") value.mountinfo = value.mountinfo.subarray(0, -1);
      if (change === "duplicate-id") value.mountinfo = Buffer.concat([value.mountinfo, value.mountinfo]);
      if (change === "bad-escape") value.mountinfo = Buffer.from(value.mountinfo.toString().replace("\\040", "\\041"));
      assert.throws(() => {
        const candidate = parse.parseMount(value, parse.parseStatx(value.legacyBytes, false, value.metadata), parse.parseStatx(value.uniqueBytes, true, value.metadata));
        parse.selectedMountinfo(value.mountinfo, candidate);
      }, { code: change === "wrong-inode" ? "source_changed" : "backup_capability_unavailable" }, change);
    }
  });
});

test("#152 P3 pure process and options parsing retains missing ordinary-authority obligations", async () => {
  await withProfileParsers(parse => {
    const value = profileParserFixture();
    assert.doesNotThrow(() => parse.ordinaryProcess(value.environment));
    assert.equal(parse.parseOptions(Buffer.from("rw,data=ordered,errors=remount-ro\n")).data, "ordered");
    for (const options of ["rw,data=ordered,data=writeback\n", "rw,\n", "rw\0", "rw,unknown=é\n"])
      assert.throws(() => parse.parseOptions(Buffer.from(options)), { code: "backup_capability_unavailable" });
    for (const change of ["capability", "uid-mismatch", "extra-group", "privileges", "missing-field", "wrong-pid", "missing-lifetime"]) {
      const environment = profileParserFixture().environment;
      let status = environment.process.threadStatus.value.bytes.toString();
      if (change === "capability") status = status.replace("CapEff:\t0000000000000000", "CapEff:\t0000000000000001");
      if (change === "uid-mismatch") status = status.replace("Uid:\t1001", "Uid:\t1002");
      if (change === "extra-group") { status = status.replace("Groups:\t", "Groups:\t1001"); environment.process.identity.value.groups = [1001n]; }
      if (change === "privileges") { status = status.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0"); environment.process.identity.value.noNewPrivileges = 0n; }
      if (change === "missing-field") status = status.replace("CapBnd:\t0000000000000000\n", "");
      if (change === "wrong-pid") environment.process.processStat.value.bytes[0] = 51;
      if (change === "missing-lifetime") environment.process.processStat.value.bytes = Buffer.from(environment.process.processStat.value.bytes.toString().replace("987654321", "0"));
      environment.process.threadStatus.value.bytes = Buffer.from(status);
      assert.throws(() => parse.ordinaryProcess(environment), { code: ["uid-mismatch", "wrong-pid"].includes(change)
        ? "source_changed" : "backup_capability_unavailable" }, change);
    }
    const analysis = parse.analyzeEnvironment(value.context);
    assert.equal(analysis.unresolved.length, 4);
    assert.ok(analysis.unresolved.every(item => item.endsWith("UNPROVEN")));
    assert.equal(Object.hasOwn(analysis, "qualified"), false, "pure mechanical completeness still cannot issue a profile");
  });
});

test("#152 P3 pure health parser binds all thirteen raw fields and the identical device roster", async () => {
  await withProfileParsers(parse => {
    const fixture = profileParserFixture(), mount = parse.parseMount(fixture,
      parse.parseStatx(fixture.legacyBytes, false, fixture.metadata), parse.parseStatx(fixture.uniqueBytes, true, fixture.metadata));
    assert.doesNotThrow(() => parse.boundHealth(fixture.environment, mount));
    for (let index = 0; index < 13; index++) {
      const environment = profileParserFixture().environment;
      environment.health.fields[index].fact.value.bytes = Buffer.from(index >= 11 ? "known_error\n" : "1\n");
      assert.throws(() => parse.boundHealth(environment, mount), { code: "backup_capability_unavailable" }, `health field ${index}`);
    }
    const missing = profileParserFixture().environment;
    missing.health.fields[0].fact = { status: "unavailable", reason: "syscall", value: null, calls: [] };
    assert.throws(() => parse.boundHealth(missing, mount), { code: "backup_capability_unavailable" });
    const wrongDevice = profileParserFixture().environment;
    wrongDevice.device.topology.value.nodes[0].dev = kernelReadFixture(2);
    assert.throws(() => parse.boundHealth(wrongDevice, mount), { code: "source_changed" });
    const wrongBinding = profileParserFixture().environment;
    wrongBinding.health.binding.value.sourceDevMinor = 2n;
    assert.throws(() => parse.boundHealth(wrongBinding, mount), { code: "source_changed" });
  });
});

test("#152 MB1 actual analysis consumes the complete fixed summary and keeps unresolved qualification", async () => {
  await withProfileParsers(parse => {
    const seen = new Set<string>();
    for (const bit of [0, 1] as const) for (const explicit of [false, true]) for (const maximum of [false, true]) {
      const fixture = profileParserFixture(), raw = Buffer.from(mbSummaryFixture(bit, maximum));
      fixture.environment.configuration.mbStructsSummary.value.bytes = raw;
      if (explicit) fixture.environment.configuration.options.value.bytes = Buffer.from(`rw\nmb_optimize_scan=${bit}\n`);
      const analysis = parse.analyzeEnvironment(fixture.context);
      const fields = Object.fromEntries((analysis.configuration as any)[1]);
      assert.deepEqual(fields.mbStructsSummary, parse.typed(raw));
      assert.deepEqual(fields.mbAllocation, parse.typed({ mbOptimizeScan: BigInt(bit),
        maxFreeOrderGroups: Array.from({ length: 14 }, (_, order) => BigInt(maximum ? 4294967295 : order)),
        avgFragmentSizeGroups: Array.from({ length: 14 }, (_, order) => BigInt(maximum ? 4294967295 : order)) }));
      assert.deepEqual(fields.mbGroups, parse.typed(Buffer.from("raw-mb-groups\n")));
      assert.equal(analysis.unresolved.length, 4); assert.ok(analysis.unresolved.every(value => value.endsWith("UNPROVEN")));
      seen.add(analysis.contextBinding); assert.equal(Object.hasOwn(analysis, "qualified"), false);
    }
    const changed = profileParserFixture(); changed.environment.configuration.mbStructsSummary.value.bytes =
      Buffer.from(mbSummaryFixture().replace("list_order_13_groups: 13", "list_order_13_groups: 14"));
    assert.notEqual(parse.analyzeEnvironment(changed.context).contextBinding,
      parse.analyzeEnvironment(profileParserFixture().context).contextBinding, "all counters remain in the material");
    assert.equal(seen.size, 8, "raw bits, counters and explicit options all remain distinct");
  });
});

test("#152 MB1 actual analysis rejects every malformed summary and contradictory proc option", async () => {
  await withProfileParsers(parse => {
    const raw = mbSummaryFixture();
    const invalid = [raw.replace("optimize_scan: 0", "optimize_scan: 2"), raw.replace("0\n", "00\n"),
      raw.replace("max_free_order_lists:", "max_free_order_list:"), raw.replace("avg_fragment_size_lists:", "avg_fragment_size_lists: "),
      raw.replace("\tlist_order_0_groups: 0\n", ""), raw.replace("list_order_0_groups", "list_order_1_groups"),
      raw.replace("\tlist_order_0_groups: 0\n\tlist_order_1_groups: 1\n", "\tlist_order_1_groups: 1\n\tlist_order_0_groups: 0\n"),
      raw.replace("groups: 0", "groups: -1"), raw.replace("groups: 0", "groups: +1"), raw.replace("groups: 0", "groups: 01"),
      raw.replace("groups: 0", "groups: 4294967296"), raw.replace("groups: 0", "groups: 1.0"), raw.replace("groups: 0", "groups: 0,1"),
      raw.slice(0, -1), raw + "\n", raw + "extra\n", raw.replace("\n", "\r\n"), raw.replace("\n", "\0\n"),
      raw.replace("groups: 0", "groups: é"), "x".repeat(16385)];
    for (const value of invalid) {
      const fixture = profileParserFixture(); fixture.environment.configuration.mbStructsSummary.value.bytes = Buffer.from(value);
      assert.throws(() => parse.analyzeEnvironment(fixture.context), { code: "backup_capability_unavailable" });
    }
    for (const value of ["rw,data=ordered\n", "rw\r\n", "rw\0\n", "rw", "rw\n\n", "rw\nrw\n",
      "rw\nmb_optimize_scan=1\n", "rw\nmb_optimize_scan=2\n", "rw\nmb_optimize_scan=00\n", "rw\nmb_optimize_scan\n"]) {
      const fixture = profileParserFixture(); fixture.environment.configuration.options.value.bytes = Buffer.from(value);
      assert.throws(() => parse.analyzeEnvironment(fixture.context), { code: "backup_capability_unavailable" });
    }
    const fixture = profileParserFixture();
    fixture.environment.configuration.mbStructsSummary = { status: "unavailable", reason: "syscall", value: null, calls: [] };
    assert.throws(() => parse.analyzeEnvironment(fixture.context), { code: "backup_capability_unavailable" });
  });
});

test("#152 P3 typed runtime material keeps bytes and integers distinct without executing accessors", async () => {
  await withProfileParsers(({ typed }) => {
    const values = ["9007199254740993", 9007199254740993n, Buffer.from("9007199254740993"), 1, true, null];
    assert.equal(new Set(values.map(value => JSON.stringify(typed(value)))).size, values.length);
    assert.deepEqual(typed({ b: 2n, a: Buffer.from([0, 255]) }), typed({ a: Buffer.from([0, 255]), b: 2n }));
    for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -0, 9007199254740992])
      assert.throws(() => typed(value), { code: "backup_capability_unavailable" });
    let invoked = false;
    const accessor = Object.defineProperty({}, "proof", { enumerable: true, get() { invoked = true; return 1n; } });
    assert.throws(() => typed(accessor), { code: "backup_capability_unavailable" });
    assert.equal(invoked, false);
    const sparse: unknown[] = []; sparse.length = 1;
    assert.throws(() => typed(sparse), { code: "backup_capability_unavailable" });
  });
});
function kernelReadFixture(samples: 1 | 2 = 1): SourceFileContextFact<SourceFileKernelReadValue> {
  const call = (operation: string, rc: bigint | null): SourceFileNativeCall => ({ operation, rc, errno: rc === null ? null : 0n });
  const before = [
    call("open-kernel-read", 7n), call("fstat-kernel-before", 0n), call("fstatfs-kernel-before", 0n),
    call("read-kernel", 2n), call("read-kernel", 0n), call("fstatfs-kernel-after", 0n),
    call("fstat-kernel-after", 0n), call("close-kernel-read", 0n),
  ];
  return { status: "observed", reason: null, value: { bytes: Buffer.from("0\n"), device: 17n,
    inode: 29n, mode: 0o100444n, filesystemType: 0x62656572n }, calls: samples === 1 ? before :
      [...before, ...before.map(entry => ({ ...entry, operation: `${entry.operation}-after` }))] };
}
test("#152 P3 pure pseudo-read ABI requires exact actual bytes, EOF and close without qualification", async () => {
  await withNativeDecoders(({ checkedKernelReadFact: decode }) => {
    const original = kernelReadFixture(), result = decode(original, 4096);
    assert.equal(result.status, "observed");
    if (result.status !== "observed" || original.status !== "observed") assert.fail();
    assert.deepEqual(result.value.bytes, Buffer.from("0\n"));
    original.value.bytes.fill(255);
    assert.deepEqual(result.value.bytes, Buffer.from("0\n"), "private matching bytes are detached from returned native objects");
    for (const change of ["length", "no-eof", "early-eof", "close-error", "extra-field", "unknown-call", "non-bigint", "budget"]) {
      const value = kernelReadFixture() as any;
      if (change === "length") value.calls[3].rc = 1n;
      if (change === "no-eof") value.calls[4].rc = 1n;
      if (change === "early-eof") value.calls[3].rc = 0n;
      if (change === "close-error") Object.assign(value.calls.at(-1), { rc: -1n, errno: 5n });
      if (change === "extra-field") value.value.verified = true;
      if (change === "unknown-call") value.calls[0].operation = "caller-open";
      if (change === "non-bigint") value.calls[3].rc = 2;
      if (change === "budget") value.value.bytes = Buffer.alloc(4097);
      assert.throws(() => decode(value, 4096), { code: "backup_capability_unavailable" }, change);
    }
    const failed = kernelReadFixture() as any;
    failed.status = "unavailable"; failed.reason = "syscall"; failed.value = null;
    failed.calls[3] = { operation: "read-kernel", rc: -1n, errno: 5n };
    failed.calls.splice(4, 1);
    const failure = decode(failed, 4096);
    assert.equal(failure.status, "unavailable"); assert.equal(failure.value, null);
    assert.deepEqual(failure.calls[3], { operation: "read-kernel", rc: -1n, errno: 5n });
  });
});
test("#152 P3 double samples independently require EOF, close and full bytes within one read budget", async () => {
  await withNativeDecoders(({ checkedKernelReadFact: decode }) => {
    const positive = decode(kernelReadFixture(2), 4096, 2);
    assert.equal(positive.status, "observed"); assert.equal(positive.calls.length, 16);
    assert.equal(positive.calls.at(-2)!.operation, "fstat-kernel-after-after");
    for (const change of ["after-length", "after-no-eof", "after-close", "before-length", "missing-after", "unexecuted-after", "shared-read-budget"]) {
      const value = kernelReadFixture(2) as any;
      if (change === "after-length") value.calls[11].rc = 1n;
      if (change === "after-no-eof") value.calls[12].rc = 1n;
      if (change === "after-close") Object.assign(value.calls[15], { rc: -1n, errno: 5n });
      if (change === "before-length") value.calls[3].rc = 1n;
      if (change === "missing-after") value.calls.splice(8);
      if (change === "unexecuted-after") value.calls.slice(8).forEach((call: any) => Object.assign(call, { rc: null, errno: null }));
      if (change === "shared-read-budget") {
        value.value.bytes = Buffer.alloc(128);
        const stage = (suffix: string) => [
          { operation: `open-kernel-read${suffix}`, rc: 7n, errno: 0n },
          { operation: `fstat-kernel-before${suffix}`, rc: 0n, errno: 0n },
          { operation: `fstatfs-kernel-before${suffix}`, rc: 0n, errno: 0n },
          ...Array.from({ length: 128 }, () => ({ operation: `read-kernel${suffix}`, rc: 1n, errno: 0n })),
          { operation: `read-kernel${suffix}`, rc: 0n, errno: 0n },
          { operation: `fstatfs-kernel-after${suffix}`, rc: 0n, errno: 0n },
          { operation: `fstat-kernel-after${suffix}`, rc: 0n, errno: 0n },
          { operation: `close-kernel-read${suffix}`, rc: 0n, errno: 0n },
        ];
        value.calls = [...stage(""), ...stage("-after")];
      }
      assert.throws(() => decode(value, 4096, 2), { code: "backup_capability_unavailable" }, change);
    }
    const absent = kernelReadFixture(2) as any;
    absent.status = "unavailable"; absent.reason = "syscall"; absent.value = null;
    absent.calls = ["", "-after"].flatMap(suffix => ["open-kernel-read", "fstat-kernel-before", "fstatfs-kernel-before", "read-kernel",
      "fstatfs-kernel-after", "fstat-kernel-after", "close-kernel-read"].map((operation, index) => ({
      operation: operation + suffix, rc: index === 0 ? -1n : null, errno: index === 0 ? 2n : null,
    })));
    const unavailable = decode(absent, 4096, 2);
    assert.equal(unavailable.status, "unavailable"); assert.equal(unavailable.value, null);
    assert.equal(unavailable.calls[7]!.errno, 2n, "both real absence observations remain explicit, never a success value");
  });
});

/** Inert contract samples only: no native owner or production profile is registered. */
function blockReaderFixture() {
  const original = profileParserFixture(), device = original.environment.device;
  const call = (operation: string, rc: bigint | null): SourceFileNativeCall => ({ operation, rc, errno: rc === null ? null : 0n });
  const attributes: any = { readerRevision: 1, sourceNodeIndex: 0 };
  for (const [field, label, bytes] of [["size", "block-size", "18446744073709551615\n"],
    ["readOnly", "block-ro", "1\n"], ["diskSequence", "block-diskseq", "0\n"]]) {
    const calls = ["", "-after"].flatMap(suffix => [call(`open-${label}${suffix}`, 8n),
      call(`fstat-${label}-before${suffix}`, 0n), call(`fstatfs-${label}-before${suffix}`, 0n),
      call(`read-${label}${suffix}`, BigInt(Buffer.byteLength(bytes!))), call(`read-${label}${suffix}`, 0n),
      call(`fstatfs-${label}-after${suffix}`, 0n), call(`fstat-${label}-after${suffix}`, 0n), call(`close-${label}${suffix}`, 0n)]);
    attributes[field!] = { status: "observed", reason: null, value: { bytes: Buffer.from(bytes!),
      device: 7n, inode: 80n + BigInt(Object.keys(attributes).length), mode: 0o100444n, filesystemType: 0x62656572n }, calls };
  }
  device.binding.calls = [call("open-device-node-0", 4n), call("fstat-device-node-0-before", 0n), call("fstatfs-device-node-0-before", 0n),
    call("readlink-device-node-0", BigInt(device.binding.value.resolved.length)), call("fstat-device-node-0-after", 0n),
    call("fstatfs-device-node-0-after", 0n), call("readlink-device-node-0-after", BigInt(device.binding.value.resolved.length)), call("close-device-node-0", 0n)];
  const prefix = [call("open-sysfs-root", 3n), call("fstat-sysfs-root", 0n), call("fstatfs-sysfs-root", 0n), ...device.binding.calls.slice(0, 4)];
  const suffix = [...device.binding.calls.slice(4), call("close-sysfs-root", 0n)];
  const phases = () => [0, 1].flatMap(phase => ["size", "readOnly", "diskSequence"].flatMap(field => {
    const rows: SourceFileNativeCall[] = attributes[field].calls;
    const split = rows.findIndex(row => row.operation === `open-${({ size: "block-size", readOnly: "block-ro", diskSequence: "block-diskseq" } as const)[field as "size"]}-after`);
    return phase ? rows.slice(split) : rows.slice(0, split);
  }));
  return { attributes, source: original.metadata, device, ledger: () => [...prefix, ...phases(), ...suffix] };
}

test("#152 M04 three fixed raw readers decode exact two-phase samples without granting qualification", async () => {
  await withNativeDecoders(decode => {
    const value = blockReaderFixture(), ledger = decode.checkedAuxiliaryCalls(value.ledger(), true);
    const result = decode.checkedBlockAttributes(value.attributes, value.source, value.device, ledger);
    assert.equal(result.readerRevision, 1); assert.equal(result.sourceNodeIndex, 0);
    assert.deepEqual(Object.keys(result), ["readerRevision", "sourceNodeIndex", "size", "readOnly", "diskSequence"]);
    assert.equal(result.size.value.bytes.toString(), "18446744073709551615\n");
    assert.equal(result.readOnly.value.bytes.toString(), "1\n"); assert.equal(result.diskSequence.value.bytes.toString(), "0\n");
    assert.equal(new Set(["size", "readOnly", "diskSequence"].flatMap(field => result[field].calls.map((call: SourceFileNativeCall) => call.operation))).size, 42);
    value.attributes.size.value.bytes.fill(0);
    assert.equal(result.size.value.bytes.toString(), "18446744073709551615\n", "decoder buffers must detach from raw input");
    assert.equal(Object.isFrozen(result), true); assert.equal(Object.hasOwn(result, "qualified"), false);
  });
});


test("#152 M04 raw grammar, exact shapes and fixed field-phase projections reject ambiguous input", async () => {
  await withNativeDecoders(decode => {
    function run(value: ReturnType<typeof blockReaderFixture>, calls = value.ledger()) {
      return decode.checkedBlockAttributes(value.attributes, value.source, value.device, decode.checkedAuxiliaryCalls(calls, true));
    }
    for (const field of ["size", "diskSequence", "readOnly"] as const) {
      for (const bytes of field === "readOnly" ? ["0\n", "1\n"] : ["0\n", "1\n", "18446744073709551615\n"]) {
        const value = blockReaderFixture(), fact = value.attributes[field];
        fact.value.bytes = Buffer.from(bytes); fact.calls[3].rc = fact.calls[11].rc = BigInt(Buffer.byteLength(bytes));
        assert.equal(run(value)[field].value.bytes.toString(), bytes);
      }
      for (const bytes of ["18446744073709551616\n", "00\n", "-1\n", "\n", "0\n\n", "1 \n", "\0\n", "\ufeff1\n", ...(field === "readOnly" ? ["2\n", "true\n"] : [])]) {
        const value = blockReaderFixture(), fact = value.attributes[field];
        fact.value.bytes = Buffer.from(bytes); fact.calls[3].rc = fact.calls[11].rc = BigInt(Buffer.byteLength(bytes));
        assert.throws(() => run(value), { code: "backup_capability_unavailable" }, `${field}: ${JSON.stringify(bytes)}`);
      }
    }
    let accessors = 0;
    for (const mutation of ["revision", "node", "missing", "extra", "getter", "prototype", "sparse", "array-getter", "array-prototype",
      "swap-facts", "missing-close", "missing-eof", "wrong-phase", "duplicate-read-placeholder", "wrong-reason", "ledger-different", "ledger-duplicate", "ledger-missing"]) {
      const value = blockReaderFixture(); let calls: SourceFileNativeCall[] | undefined;
      if (mutation === "revision") value.attributes.readerRevision = 2;
      if (mutation === "node") value.attributes.sourceNodeIndex = 1;
      if (mutation === "missing") delete value.attributes.size;
      if (mutation === "extra") value.attributes.qualified = true;
      if (mutation === "getter") Object.defineProperty(value.attributes, "size", { enumerable: true, get() { accessors++; throw Error("accessor executed"); } });
      if (mutation === "prototype") Object.setPrototypeOf(value.attributes, { inherited: true });
      if (mutation === "sparse") delete value.attributes.size.calls[3];
      if (mutation === "array-getter") Object.defineProperty(value.attributes.size.calls, "3", { enumerable: true, get() { accessors++; throw Error("array accessor executed"); } });
      if (mutation === "array-prototype") Object.setPrototypeOf(value.attributes.size.calls, Object.create(Array.prototype));
      if (mutation === "swap-facts") [value.attributes.readOnly, value.attributes.diskSequence] = [value.attributes.diskSequence, value.attributes.readOnly];
      if (mutation === "missing-close") value.attributes.size.calls.pop();
      if (mutation === "missing-eof") value.attributes.size.calls.splice(12, 1);
      if (mutation === "wrong-phase") value.attributes.size.calls[10].operation = "fstatfs-block-size-before";
      if (mutation === "duplicate-read-placeholder") {
        const fact = value.attributes.size; fact.status = "unavailable"; fact.reason = "binding"; fact.value = null;
        fact.calls.forEach((call: any) => { call.rc = null; call.errno = null; });
      }
      if (mutation === "wrong-reason") { value.attributes.size.status = "unavailable"; value.attributes.size.reason = "unsupported"; value.attributes.size.value = null; }
      if (mutation.startsWith("ledger-")) {
        calls = value.ledger().map(call => ({ ...call })); const index = calls.findIndex(call => call.operation === "read-block-ro");
        if (mutation === "ledger-different") calls[index] = { ...calls[index]!, rc: 1n };
        if (mutation === "ledger-duplicate") calls.splice(index, 0, { ...calls[index]! });
        if (mutation === "ledger-missing") calls.splice(index, 1);
      }
      // Shape/accessor rejection is checked before constructing any auxiliary
      // projection from that untrusted shape, so this test cannot invoke it.
      if (["missing", "getter", "sparse", "array-getter", "swap-facts"].includes(mutation)) calls = blockReaderFixture().ledger();
      assert.throws(() => run(value, calls), { code: "backup_capability_unavailable" }, mutation);
    }
    assert.equal(accessors, 0);
  });
});

test("#152 M04 source binding and original parent lifetime cannot be replaced by valid-looking raw facts", async () => {
  await withNativeDecoders(decode => {
    for (const mutation of ["source-dev", "major", "dev-text", "sysfs-device", "node-inode", "node-name", "node-resolved"]) {
      const value = blockReaderFixture();
      if (mutation === "source-dev") value.source.dev = 2050n;
      if (mutation === "major") value.device.binding.value.sourceDevMajor = 9n;
      if (mutation === "dev-text") value.device.dev.value.bytes = Buffer.from("8:2\n");
      if (mutation === "sysfs-device") value.attributes.size.value.device = 8n;
      if (mutation === "node-inode") value.device.topology.value.nodes[0].identity = { ...value.device.topology.value.nodes[0].identity, inode: 999n };
      if (mutation === "node-name") value.device.topology.value.nodes[0].kernelName = Buffer.from("other");
      if (mutation === "node-resolved") value.device.topology.value.nodes[0].resolved = Buffer.from("/sys/devices/other");
      assert.throws(() => decode.checkedBlockAttributes(value.attributes, value.source, value.device,
        decode.checkedAuxiliaryCalls(value.ledger(), true)), { code: "source_changed" }, mutation);
    }
    const local = blockReaderFixture(); local.device.topology = { status: "unavailable", reason: "enumeration", value: null, calls: [] };
    assert.equal(decode.checkedBlockAttributes(local.attributes, local.source, local.device,
      decode.checkedAuxiliaryCalls(local.ledger(), true)).size.status, "observed", "local raw observations do not claim complete topology");
    for (const mutation of ["parent-closed", "anchor-closed", "same-fd-reopened-parent", "leaf-reuses-parent", "missing-close", "extra-byte-budget", "too-many-calls"]) {
      const value = blockReaderFixture(), calls = value.ledger().map(call => ({ ...call }));
      const begin = calls.findIndex(call => call.operation === "open-block-size");
      if (mutation === "parent-closed" || mutation === "anchor-closed") {
        const name = mutation === "parent-closed" ? "close-device-node-0" : "close-sysfs-root";
        const [end] = calls.splice(calls.findIndex(call => call.operation === name), 1); calls.splice(begin, 0, end!);
      }
      if (mutation === "same-fd-reopened-parent") calls.splice(begin + 8, 0,
        { operation: "close-device-node-0", rc: 0n, errno: 0n }, { operation: "open-device-node-0", rc: 4n, errno: 0n });
      if (mutation === "leaf-reuses-parent") calls[begin]!.rc = 4n;
      if (mutation === "missing-close") calls.splice(calls.findIndex(call => call.operation === "close-block-ro-after"), 1);
      if (mutation === "extra-byte-budget") calls.find(call => call.operation === "read-block-diskseq-after")!.rc = 2097153n;
      if (mutation === "too-many-calls") calls.push(...Array.from({ length: 32768 }, () => ({ operation: "open-block-size", rc: null, errno: null })));
      assert.throws(() => decode.checkedAuxiliaryCalls(calls, true), { code: "backup_capability_unavailable" }, mutation);
    }
  });
});

test("#152 M04 stable unavailable diagnostics retain both actual errors and one shared read allowance", async () => {
  await withNativeDecoders(decode => {
    for (const errors of [[2n, 2n], [2n, 13n], [13n, 2n], [null, null]] as const) {
      const value = blockReaderFixture(), fact = value.attributes.size;
      fact.status = "unavailable"; fact.reason = errors[0] === null ? "binding" : "syscall"; fact.value = null;
      fact.calls = ["", "-after"].flatMap((suffix, index) => ["open-block-size", "fstat-block-size-before", "fstatfs-block-size-before", "read-block-size", "fstatfs-block-size-after", "fstat-block-size-after", "close-block-size"]
        .map((operation, i) => ({ operation: operation + suffix, rc: i === 0 && errors[index] !== null ? -1n : null, errno: i === 0 ? errors[index] : null })));
      const result = decode.checkedBlockAttributes(value.attributes, value.source, value.device, decode.checkedAuxiliaryCalls(value.ledger(), true));
      assert.equal(result.size.status, "unavailable"); assert.equal(result.size.value, null);
      assert.deepEqual(result.size.calls.filter((call: SourceFileNativeCall) => call.operation.startsWith("open-")).map((call: SourceFileNativeCall) => call.errno), [...errors]);
    }
    const value = blockReaderFixture(), fact = value.attributes.size;
    fact.status = "unavailable"; fact.reason = "budget"; fact.value = null;
    for (const phase of [1, 0]) fact.calls.splice(phase * 8 + 3, 2,
      ...Array.from({ length: 129 }, () => ({ operation: phase ? "read-block-size-after" : "read-block-size", rc: 1n, errno: 0n })));
    assert.throws(() => decode.checkedBlockAttributes(value.attributes, value.source, value.device,
      decode.checkedAuxiliaryCalls(value.ledger(), true)), { code: "backup_capability_unavailable" }, "the two phases cannot each claim a separate 256-read budget");
  });
});

test("#152 M04 raw values and unknown reasons enter context binding without removing unproven obligations", async () => {
  await withProfileParsers(parse => {
    const fixture = profileParserFixture(); fixture.environment.device.blockAttributes = blockReaderFixture().attributes;
    const initial = parse.analyzeEnvironment(fixture.context);
    for (const mutation of ["raw", "status", "reason"]) {
      const value = profileParserFixture(); value.environment.device.blockAttributes = blockReaderFixture().attributes;
      if (mutation === "raw") value.environment.device.blockAttributes.readOnly.value.bytes = Buffer.from("0\n");
      if (mutation !== "raw") value.environment.device.blockAttributes.size = { status: "unavailable", reason: mutation === "status" ? "binding" : "budget", value: null, calls: [] };
      const changed = parse.analyzeEnvironment(value.context);
      assert.notEqual(changed.contextBinding, initial.contextBinding); assert.notEqual(changed.windowBinding, initial.windowBinding);
      assert.equal(changed.unresolved.length, 4); assert.ok(changed.unresolved.every(item => item.endsWith("UNPROVEN")));
    }
    fixture.environment.device.blockAttributes.size.calls[0].rc = 200n;
    assert.equal(parse.analyzeEnvironment(fixture.context).contextBinding, initial.contextBinding, "call observations are not stable material");
    assert.equal(Object.hasOwn(initial, "qualified"), false);
  });
});

function enumerationFixture(): SourceFileNativeCall[] {
  const stage = (suffix: string) => ["holders", "slaves", "partitions"].flatMap(kind => [
    { operation: `open-${kind}-0${suffix}`, rc: 7n, errno: 0n },
    { operation: `fstat-${kind}-0-before${suffix}`, rc: 0n, errno: 0n },
    { operation: `fstatfs-${kind}-0-before${suffix}`, rc: 0n, errno: 0n },
    { operation: `getdents-${kind}-0${suffix}`, rc: 24n, errno: 0n },
    { operation: `getdents-${kind}-0${suffix}`, rc: 0n, errno: 0n },
    { operation: `fstat-${kind}-0-after${suffix}`, rc: 0n, errno: 0n },
    { operation: `fstatfs-${kind}-0-after${suffix}`, rc: 0n, errno: 0n },
    { operation: `close-${kind}-0${suffix}`, rc: 0n, errno: 0n },
  ]);
  return [...stage(""), { operation: "stat-partition-entry-0", rc: -1n, errno: 2n },
    { operation: "stat-device-link-0", rc: 0n, errno: 0n }, ...stage("-after"),
    { operation: "stat-partition-entry-0-after", rc: -1n, errno: 2n },
    { operation: "stat-device-link-0-after", rc: 0n, errno: 0n }];
}
test("#152 P3 device enumeration requires two complete bounded scopes and held auxiliary owners", async () => {
  await withNativeDecoders(({ checkedAuxiliaryCalls: auxiliary, checkedEnumeration: enumeration }) => {
    assert.equal(enumeration(enumerationFixture(), 0).length, 52);
    for (const change of ["after-eof", "missing-after", "wrong-owner", "partition-error", "link-error", "per-scope-budget",
      "missing-partition-after", "partition-after-different", "link-after-error"]) {
      const rows = enumerationFixture();
      if (change === "after-eof") (rows.find(call => call.operation === "getdents-holders-0-after" && call.rc === 0n)! as any).rc = 24n;
      if (change === "missing-after") rows.splice(26);
      if (change === "wrong-owner") (rows[25] as any).operation = "stat-device-link-1";
      if (change === "partition-error") (rows[24] as any).errno = 13n;
      if (change === "link-error") Object.assign(rows[25]!, { rc: -1n, errno: 2n });
      if (change === "missing-partition-after") rows.splice(50, 1);
      if (change === "partition-after-different") Object.assign(rows[50]!, { rc: 0n, errno: 0n });
      if (change === "link-after-error") Object.assign(rows[51]!, { rc: -1n, errno: 2n });
      if (change === "per-scope-budget") {
        for (const suffix of ["-after", ""]) {
          const index = rows.findIndex(call => call.operation === `getdents-holders-0${suffix}`);
          rows.splice(index, 1, ...Array.from({ length: 128 }, () => ({ operation: `getdents-holders-0${suffix}`, rc: 24n, errno: 0n })));
        }
      }
      assert.throws(() => enumeration(rows, 0), { code: "backup_capability_unavailable" }, change);
    }
    const call = (operation: string, rc: bigint): SourceFileNativeCall => ({ operation, rc, errno: 0n });
    const scope = [call("open-sysfs-root", 3n), call("fstat-sysfs-root", 0n), call("fstatfs-sysfs-root", 0n),
      call("open-device-node-0", 4n), call("fstat-device-node-0-before", 0n), call("fstatfs-device-node-0-before", 0n),
      call("readlink-device-node-0", 12n), ...enumerationFixture(), call("fstat-device-node-0-after", 0n),
      call("fstatfs-device-node-0-after", 0n), call("readlink-device-node-0-after", 12n),
      call("close-device-node-0", 0n), call("close-sysfs-root", 0n)];
    assert.equal(auxiliary(scope, true).length, scope.length);
    assert.throws(() => auxiliary(scope.slice(3), true), { code: "backup_capability_unavailable" }, "a relation needs the actual sysfs anchor");
    const repeatedClose = [...scope, call("close-device-node-0", 0n)];
    assert.throws(() => auxiliary(repeatedClose, true), { code: "backup_capability_unavailable" });
    const unavailable = { operation: "enumerate-device-graph", rc: null, errno: null };
    assert.equal(auxiliary([unavailable], true, true).length, 1);
    assert.throws(() => auxiliary([unavailable], true), { code: "backup_capability_unavailable" }, "observed graphs cannot carry an unexecuted diagnostic");
    assert.throws(() => auxiliary([{ ...unavailable, rc: 0n, errno: 0n }], true, true), { code: "backup_capability_unavailable" });
    assert.throws(() => auxiliary([unavailable, unavailable], true, true), { code: "backup_capability_unavailable" });
    const reads = kernelReadFixture(2).calls.map(call => ({ ...call }));
    reads[3]!.rc = 1048576n; reads[11]!.rc = 1048576n;
    assert.equal(auxiliary(reads, true).length, 16, "both observations consume the same global byte budget");
    reads[11]!.rc++;
    assert.throws(() => auxiliary(reads, true), { code: "backup_capability_unavailable" }, "after sampling cannot reset the global budget");
  });
});
type NativeBinding = {
  openRoot(path: string): object;
  rootInfo(owner: object): { abiVersion: 1; kind: "file" | "directory"; stage: "metadata-only" | "readable"; metadata: { dev: bigint; ino: bigint } };
  openRootContent(bootstrap: object): object;
  observeEnvironment(owner: object): unknown;
  openChild(parent: object, leaf: string, kind: "file" | "directory"): object;
  observe(owner: object): { kind: string; dev: bigint; ino: bigint; size: bigint };
  observeStatx(owner: object): unknown;
  observeStatxUnique(owner: object): unknown;
  observeExtended(owner: object): unknown;
  readAt(owner: object, offset: bigint, length: number): Buffer;
  readDirectory(owner: object): string[];
  retainMetadata(owner: object): object;
  transferCarrier(metadata: object, carrier: object): void;
  closeAsync(owner: object): Promise<void>;
  close(owner: object): void;
};

/** Test-only linkage uses an isolated package with byte-identical TS modules
 * and the normal fixed addon pathname. There is no production loader override,
 * registry replacement, caller proof or synthetic native owner. */
const blockWrappers = ["fstatfs", "readlinkat", "read", "__read_chk", "close"];
const mbWrappers = [...blockWrappers, "fstatat"];
const fixedP3Variants = {
  P3_TEST_MB_READERS: { extra: ["P3_TEST_BLOCK_READERS"], wrappers: mbWrappers },
  P3_TEST_MB_ABSENT: { extra: ["P3_TEST_BLOCK_READERS", "P3_TEST_MB_READERS"], wrappers: mbWrappers },
  P3_TEST_MB_BUDGET: { extra: ["P3_TEST_BLOCK_READERS", "P3_TEST_MB_READERS"], wrappers: mbWrappers },
  P3_TEST_MB_LIMIT: { extra: ["P3_TEST_BLOCK_READERS", "P3_TEST_MB_READERS"], wrappers: mbWrappers },
  P3_TEST_MB_OVERSIZED: { extra: ["P3_TEST_BLOCK_READERS", "P3_TEST_MB_READERS"], wrappers: mbWrappers },
  P3_TEST_MB_RAW_CHANGE: { extra: ["P3_TEST_BLOCK_READERS", "P3_TEST_MB_READERS"], wrappers: mbWrappers },
  P3_TEST_MB_BAD_CHANGE: { extra: ["P3_TEST_BLOCK_READERS", "P3_TEST_MB_READERS"], wrappers: mbWrappers },
  P3_TEST_MB_IDENTITY_CHANGE: { extra: ["P3_TEST_BLOCK_READERS", "P3_TEST_MB_READERS"], wrappers: mbWrappers },
  P3_TEST_MB_APPEAR: { extra: ["P3_TEST_BLOCK_READERS", "P3_TEST_MB_READERS"], wrappers: mbWrappers },
  P3_TEST_MB_DISAPPEAR: { extra: ["P3_TEST_BLOCK_READERS", "P3_TEST_MB_READERS"], wrappers: mbWrappers },
  P3_TEST_MB_PROC_CHANGE: { extra: ["P3_TEST_BLOCK_READERS", "P3_TEST_MB_READERS"], wrappers: mbWrappers },
  P3_TEST_MB_PROC_UNAVAILABLE: { extra: ["P3_TEST_BLOCK_READERS", "P3_TEST_MB_READERS"], wrappers: mbWrappers },
  P3_TEST_MB_CLOSE_FAILURE: { extra: ["P3_TEST_BLOCK_READERS", "P3_TEST_MB_READERS"], wrappers: mbWrappers },
  P3_TEST_BLOCK_READERS: { extra: [], wrappers: blockWrappers },
  P3_TEST_BLOCK_INVALID_FORMAT: { extra: ["P3_TEST_BLOCK_READERS"], wrappers: blockWrappers },
  P3_TEST_BLOCK_BAD_CHANGE: { extra: ["P3_TEST_BLOCK_READERS"], wrappers: blockWrappers },
  P3_TEST_BLOCK_RAW_CHANGE: { extra: ["P3_TEST_BLOCK_READERS"], wrappers: blockWrappers },
  P3_TEST_BLOCK_IDENTITY_CHANGE: { extra: ["P3_TEST_BLOCK_READERS"], wrappers: blockWrappers },
  P3_TEST_BLOCK_ABSENT: { extra: ["P3_TEST_BLOCK_READERS"], wrappers: blockWrappers },
  P3_TEST_BLOCK_APPEAR: { extra: ["P3_TEST_BLOCK_READERS"], wrappers: blockWrappers },
  P3_TEST_BLOCK_DISAPPEAR: { extra: ["P3_TEST_BLOCK_READERS"], wrappers: blockWrappers },
  P3_TEST_BLOCK_BUDGET: { extra: ["P3_TEST_BLOCK_READERS"], wrappers: blockWrappers },
  P3_TEST_BLOCK_OVERSIZED: { extra: ["P3_TEST_BLOCK_READERS"], wrappers: blockWrappers },
  P3_TEST_BLOCK_CLOSE_FAILURE: { extra: ["P3_TEST_BLOCK_READERS"], wrappers: blockWrappers },

  P3_TEST_CONTENT_OPEN_FAILURE: { extra: [], wrappers: [] },
  P3_TEST_CONTENT_CLOSE_FAILURE: { extra: [], wrappers: ["close"] },
  P3_TEST_SHORT_READS: { extra: [], wrappers: ["read", "__read_chk"] },
  P3_TEST_NO_EOF: { extra: [], wrappers: ["read", "__read_chk"] },
  P3_TEST_BYTE_BUDGET: { extra: [], wrappers: ["read", "__read_chk", "fstatfs", "close"] },
  P3_TEST_PSEUDO_CLOSE_FAILURE: { extra: [], wrappers: ["close"] },
  P3_TEST_SOURCE_CHANGE: { extra: [], wrappers: ["read", "__read_chk", "fstat"] },
  P3_TEST_DIRECTORY_CLOSE_FAILURE: { extra: [], wrappers: ["closedir"] },
  P3_TEST_CHILD_IDENTITY_FAILURE: { extra: ["P3_TEST_CONTENT_CLOSE_FAILURE"], wrappers: ["fstat", "close"] },
} as const;
async function withFixedP3Package(
  macro: keyof typeof fixedP3Variants,
  consume: (value: { directory: string; api: typeof import("../src/server/storage/maintenance/source-file-native.ts");
    native: NativeBinding }) => Promise<void>,
  compiler: "default" | "fortified" = "default",
) {
  const directory = await mkdtemp(path.join(tmpdir(), "br-p3-fixed-link-"));
  try {
    const source = path.join(directory, "src/server/storage/maintenance"), output = path.join(directory, "build/maintenance-platform");
    await mkdir(source, { recursive: true }); await mkdir(output, { recursive: true });
    await writeFile(path.join(directory, "package.json"), '{"type":"module"}\n');
    // Keep the actual canonical/frame dependency graph in this one private package.
    for (const relative of ["src/server/storage/maintenance", "src/server/identity"])
      await cp(path.join(root, relative), path.join(directory, relative), { recursive: true });
    await symlink(path.join(root, "node_modules"), path.join(directory, "node_modules"), "dir");
    const addon = path.join(output, `maintenance-source-files-linux-${process.arch}.node`);
    const variant = fixedP3Variants[macro];
    const blockRoot = path.join(directory, "m04-sysfs"), blockNode = path.join(blockRoot, "devices/m04-test-node");
    const mbFixture = macro.startsWith("P3_TEST_MB_"), mbRoot = path.join(directory, "mb1-proc");
    const blockFixture = macro.startsWith("P3_TEST_BLOCK_") || mbFixture;
    if (blockFixture) {
      await mkdir(path.join(blockNode, "holders"), { recursive: true }); await mkdir(path.join(blockNode, "slaves"));
      await mkdir(path.join(blockRoot, "dev/block"), { recursive: true });
      const { dev } = await stat(directory, { bigint: true });
      const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n), minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
      await symlink("../../devices/m04-test-node", path.join(blockRoot, `dev/block/${major}:${minor}`));
      await writeFile(path.join(blockNode, "dev"), `${major}:${minor}\n`);
      await writeFile(path.join(blockNode, "uevent"), "DEVNAME=m04-test-node\n");
      const size = macro === "P3_TEST_BLOCK_BUDGET" ? "1".repeat(128) :
        ["P3_TEST_BLOCK_INVALID_FORMAT", "P3_TEST_BLOCK_BAD_CHANGE"].includes(macro) ? "00\n" : "18446744073709551615\n";
      await writeFile(path.join(blockNode, "size"), size); await writeFile(path.join(blockNode, "ro"), "1\n");
      if (!["P3_TEST_BLOCK_ABSENT", "P3_TEST_BLOCK_APPEAR"].includes(macro))
        await writeFile(path.join(blockNode, "diskseq"), macro === "P3_TEST_BLOCK_OVERSIZED" ? "1".repeat(4097) : "0\n");
    }
    if (mbFixture) {
      await mkdir(mbRoot, { mode: 0o700 });
      await writeFile(path.join(mbRoot, "options"), "rw\ndata=ordered\n");
      await writeFile(path.join(mbRoot, "mb_groups"), "original-mb-groups\n");
      if (macro !== "P3_TEST_MB_ABSENT") await writeFile(path.join(mbRoot,
        macro === "P3_TEST_MB_APPEAR" ? "available-summary" : "mb_structs_summary"),
        macro === "P3_TEST_MB_LIMIT" ? "x".repeat(16384) : macro === "P3_TEST_MB_OVERSIZED" ? "x".repeat(16385) : mbSummaryFixture());
    }
    const build = spawnSync("/usr/bin/cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-DNAPI_VERSION=8",
      ...(compiler === "fortified" ? ["-U_FORTIFY_SOURCE", "-D_FORTIFY_SOURCE=3"] : []),
      "-DNODE_GYP_MODULE_NAME=boardroom_source_file_fixed_p3", `-D${macro}`,
      ...(blockFixture ? [`-DP3_TEST_BLOCK_ROOT=${JSON.stringify(blockRoot)}`] : []), ...variant.extra.map(name => `-D${name}`), "-shared", "-fPIC",
      ...(mbFixture ? [`-DP3_TEST_MB_PROC_ROOT=${JSON.stringify(mbRoot)}`, `-DP3_TEST_MB_SOURCE_ROOT=${JSON.stringify(path.join(directory, "source"))}`] : []),
      "-I", path.join(root, "native/node-api/v24.22.1"), path.join(root, "native/maintenance-source-files.c"),
      path.join(root, "tests/fixtures/maintenance-source-file-getter-errors.c"), "-Wl,--wrap=ioctl", "-Wl,--wrap=syscall",
      ...variant.wrappers.map(name => `-Wl,--wrap=${name}`), "-o", addon], { encoding: "utf8", timeout: 30_000 });
    assert.equal(build.error, undefined); assert.equal(build.status, 0, build.stderr);
    await chmod(addon, 0o700);
    const api = await import(pathToFileURL(path.join(source, "source-file-native.ts")).href) as typeof import("../src/server/storage/maintenance/source-file-native.ts");
    const native = createRequire(import.meta.url)(addon) as NativeBinding;
    await consume({ directory, api, native });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

// These fixed-link controls model only the source filesystem/proc/sysfs
// binding. Leaf opens, short reads, EOF, inode replacement and closes are real
// operations on this package's owned ordinary files, never ext4 qualification.
for (const compiler of ["default", "fortified"] as const) {
  linuxTest(`#152 MB1 fixed summary reads both actual bits with one original owner (${compiler})`, async () => {
    await withFixedP3Package("P3_TEST_MB_READERS", async ({ directory, api, native }) => {
      const source = path.join(directory, "source"); await mkdir(source, { mode: 0o700 });
      await writeFile(path.join(source, "file"), "owned payload", { mode: 0o600 });
      const profile = await import(pathToFileURL(path.join(directory, "src/server/storage/maintenance/source-file-profile.ts")).href);
      for (const bit of [0, 1] as const) {
        const expected = Buffer.from(mbSummaryFixture(bit));
        await writeFile(path.join(directory, "mb1-proc/mb_structs_summary"), expected);
        await api.withNativeSourceRoot(source, handle => {
          const raw = api.observeSourceFileRootContext(handle).environment, fact = raw.configuration.mbStructsSummary;
          assert.equal(fact.status, "observed"); if (fact.status !== "observed") return;
          assert.deepEqual(fact.value.bytes, expected); assert.equal(fact.value.filesystemType, 0x9fa0n);
          const reads = fact.calls.filter(call => /^read-kernel(?:-after)?$/.test(call.operation));
          assert.equal(reads.filter(call => call.rc === 0n).length, 2);
          assert.ok(reads.every(call => call.rc !== null && call.rc >= 0n && call.rc <= 17n));
          assert.equal(reads.reduce((sum, call) => sum + call.rc!, 0n), BigInt(expected.length * 2));
          assert.equal(fact.calls.filter(call => !/^read-kernel(?:-after)?$/.test(call.operation)).length, 12);
          assert.equal(fact.calls.filter(call => call.operation.startsWith("close-") && call.rc === 0n).length, 2);
          assert.deepEqual(raw.configuration.mbGroups.value?.bytes, Buffer.from("original-mb-groups\n"));
          assert.ok(raw.auxiliaryCalls.length <= 32768);
          assert.throws(() => profile.matchSourceFileProfile(handle), (error: any) => error.code === "backup_capability_unavailable"
            && error.message.includes("source-file-profile-unqualified"));
        });
      }
      const bootstrap = native.openRoot(path.join(source, "file"));
      try {
        const raw = native.observeEnvironment(bootstrap) as SourceFileRootEnvironment;
        assert.equal(raw.rootStage, "metadata-only"); assert.equal(raw.source.filesystemCarrier.role, "bootstrap-parent");
        assert.equal(raw.configuration.mbStructsSummary.status, "observed");
        await withNativeDecoders(decode => assert.equal(decode.checkedEnvironment(raw, native.rootInfo(bootstrap))
          .configuration.mbStructsSummary.status, "observed"));
      } finally { native.close(bootstrap); }
      const owned = new Set<object>();
      try {
        const parent = native.openRoot(source); owned.add(parent);
        const file = native.openChild(parent, "file", "file"); owned.add(file);
        const tail = native.retainMetadata(file); owned.add(tail);
        await native.closeAsync(file); owned.delete(file);
        native.transferCarrier(tail, parent); owned.delete(parent);
        const raw = native.observeEnvironment(tail) as SourceFileRootEnvironment;
        assert.equal(raw.abiVersion, 3); assert.equal(raw.source.filesystemCarrier.role, "tail-carrier");
        assert.equal(raw.configuration.mbStructsSummary.status, "observed");
        await withNativeDecoders(decode => assert.equal(decode.checkedEnvironment(raw, native.rootInfo(tail), true)
          .configuration.mbStructsSummary.status, "observed"));
        await native.closeAsync(tail); owned.delete(tail);
      } finally { for (const owner of [...owned].reverse()) await native.closeAsync(owner); }
    }, compiler);
  });
}
for (const variant of ["P3_TEST_MB_ABSENT", "P3_TEST_MB_BUDGET", "P3_TEST_MB_LIMIT", "P3_TEST_MB_OVERSIZED",
  "P3_TEST_MB_PROC_UNAVAILABLE"] as const) {
  linuxTest(`#152 MB1 fixed ${variant} preserves limits, actual attempts and post-binding refusal`, async () => {
    await withFixedP3Package(variant, async ({ directory, api }) => {
      const source = path.join(directory, "source"); await mkdir(source, { mode: 0o700 });
      await api.withNativeSourceRoot(source, handle => {
        const raw = api.observeSourceFileRootContext(handle).environment, fact = raw.configuration.mbStructsSummary;
        const reads = fact.calls.filter(call => /^read-kernel(?:-after)?$/.test(call.operation) && call.rc !== null);
        if (variant === "P3_TEST_MB_LIMIT") {
          assert.equal(fact.status, "observed"); assert.equal(fact.value?.bytes.length, 16384);
          assert.deepEqual(reads.map(call => call.rc), [16384n, 0n, 16384n, 0n]);
        } else {
          assert.equal(fact.status, "unavailable"); assert.equal(fact.value, null);
          assert.equal(fact.reason, variant === "P3_TEST_MB_ABSENT" ? "syscall" : variant === "P3_TEST_MB_PROC_UNAVAILABLE" ? "binding" : "budget");
          if (variant === "P3_TEST_MB_ABSENT") {
            assert.equal(reads.length, 0);
            assert.deepEqual(fact.calls.filter(call => call.operation.startsWith("open-")).map(call => [call.rc, call.errno]),
              [[-1n, BigInt(osConstants.errno.ENOENT)], [-1n, BigInt(osConstants.errno.ENOENT)]]);
          } else if (variant === "P3_TEST_MB_BUDGET") {
            assert.equal(reads.length, 256, "the two phases share one read-call allowance");
            assert.ok(reads.every(call => call.rc === 1n));
            assert.ok(fact.calls.some(call => call.operation === "read-kernel-after" && call.rc === null));
          } else if (variant === "P3_TEST_MB_OVERSIZED") {
            assert.deepEqual(reads.map(call => call.rc), [16384n, 1n, 16384n, 1n]);
          } else {
            assert.equal(reads.filter(call => call.rc === 0n).length, 2);
            assert.ok(raw.auxiliaryCalls.some(call => call.operation === "stat-ext4-proc-directory-link-after"
              && call.rc === -1n && call.errno === BigInt(osConstants.errno.EACCES)));
          }
        }
        if (variant !== "P3_TEST_MB_ABSENT")
          assert.equal(fact.calls.filter(call => call.operation.startsWith("close-") && call.rc === 0n).length, 2);
        assert.ok(raw.auxiliaryCalls.length <= 32768);
        const bytes = raw.auxiliaryCalls.filter(call => call.operation.startsWith("read-") && call.rc !== null && call.rc > 0n)
          .reduce((sum, call) => sum + call.rc!, 0n);
        assert.ok(bytes <= 2097152n);
      });
    });
  });
}
for (const variant of ["P3_TEST_MB_RAW_CHANGE", "P3_TEST_MB_BAD_CHANGE", "P3_TEST_MB_IDENTITY_CHANGE",
  "P3_TEST_MB_APPEAR", "P3_TEST_MB_DISAPPEAR", "P3_TEST_MB_PROC_CHANGE"] as const) {
  linuxTest(`#152 MB1 fixed ${variant} keeps the first real change and invalidates its source scope`, async () => {
    await withFixedP3Package(variant, async ({ directory, api, native }) => {
      const source = path.join(directory, "source"); await mkdir(source, { mode: 0o700 }); let first: any;
      await assert.rejects(api.withNativeSourceRoot(source, handle => {
        try { api.observeSourceFileRootContext(handle); assert.fail("the actual fixed leaf or directory changed"); }
        catch (error: any) {
          first = error; assert.equal(error.code, "ERR_SOURCE_IDENTITY"); assert.equal(error.syscall, "environment-changed");
          assert.equal(error.errno, osConstants.errno.ESTALE);
          assert.ok(error.cleanupCalls.some((call: SourceFileNativeCall) => call.operation === "close-ext4-proc-directory" && call.rc === 0n));
        }
        assert.throws(() => handle.observe(), { code: "maintenance_lost" });
        assert.throws(() => native.rootInfo(first.nativeCleanupOwner), { code: "ERR_SOURCE_HANDLE" });
      }), error => error instanceof AggregateError && error.errors[0] === first && error.cause === first);
    });
  });
}
for (const primary of ["undefined", "cancelled"] as const) {
  linuxTest(`#152 MB1 fixed leaf close unknown preserves ${primary} and cannot reclose a replacement FD`, async () => {
    await withFixedP3Package("P3_TEST_MB_CLOSE_FAILURE", async ({ directory, api, native }) => {
      const source = path.join(directory, "source"), sentinel = path.join(source, "sentinel");
      await mkdir(source, { mode: 0o700 }); await writeFile(sentinel, "still owned", { mode: 0o600 });
      const controller = new AbortController(); if (primary === "cancelled") controller.abort();
      const first = primary === "cancelled" ? controller.signal.reason : undefined;
      let failure: any; const descriptors: number[] = [];
      try {
        await assert.rejects(api.withNativeSourceRoot(source, handle => {
          try { api.observeSourceFileRootContext(handle); assert.fail("the actual fixed summary close failed"); }
          catch (error: any) {
            failure = error; assert.equal(error.code, "ERR_SOURCE_NATIVE_IO"); assert.equal(error.syscall, "environment-close");
            assert.equal(error.errno, osConstants.errno.EIO);
          }
          const calls: SourceFileNativeCall[] = failure.cleanupCalls;
          const index = calls.findIndex(call => call.operation === "close-kernel-read" && call.rc === -1n
            && call.errno === BigInt(osConstants.errno.EIO));
          assert.ok(index > 0); let opening = index - 1;
          while (opening >= 0 && calls[opening]!.operation !== "open-kernel-read") opening--;
          assert.ok(opening >= 0); const unknown = calls[opening]!.rc;
          assert.ok(calls.some(call => call.operation === "close-ext4-proc-directory" && call.rc === 0n));
          for (let i = 0; i < 32; i++) { const fd = openSync(sentinel, constants.O_RDONLY); descriptors.push(fd); if (BigInt(fd) === unknown) break; }
          assert.ok(descriptors.some(fd => BigInt(fd) === unknown));
          assert.throws(() => native.rootInfo(failure.nativeCleanupOwner), { code: "ERR_SOURCE_HANDLE" });
          assert.throws(() => handle.observe(), { code: "maintenance_lost" });
          if (primary === "cancelled") controller.signal.throwIfAborted();
          throw undefined;
        }), error => error instanceof AggregateError && error.cause === first && error.errors[0] === first && error.errors.includes(failure));
        for (const fd of descriptors) assert.equal(fstatSync(fd).size, 11);
      } finally { for (const fd of descriptors) closeSync(fd); }
    });
  });
}

// All of these are explicitly synthetic sysfs observations over real owned
// temporary files. They test the native reader lifecycle, never a source profile.
for (const variant of ["P3_TEST_BLOCK_READERS", "P3_TEST_BLOCK_INVALID_FORMAT", "P3_TEST_BLOCK_ABSENT",
  "P3_TEST_BLOCK_BUDGET", "P3_TEST_BLOCK_OVERSIZED"] as const) {
  for (const compiler of variant === "P3_TEST_BLOCK_READERS" ? ["default", "fortified"] as const : ["default"] as const)
  linuxTest(`#152 M04 fixed ${variant} keeps actual reads and closes in one bounded original node scope (${compiler})`, async () => {
    await withFixedP3Package(variant, async ({ directory, api, native }) => {
      const profile = await import(pathToFileURL(path.join(directory, "src/server/storage/maintenance/source-file-profile.ts")).href);
      const source = path.join(directory, "source"); await mkdir(source, { mode: 0o700 });
      await api.withNativeSourceRoot(source, handle => {
        const raw = api.observeSourceFileRootContext(handle).environment, attrs = raw.device.blockAttributes;
        assert.equal(raw.device.binding.status, "observed"); assert.equal(raw.device.topology.status, "observed");
        assert.equal(attrs.readOnly.status, "observed");
        if (variant === "P3_TEST_BLOCK_READERS") {
          assert.equal(attrs.size.status, "observed"); assert.equal(attrs.diskSequence.status, "observed");
          const reads = attrs.size.calls.filter(call => /^read-block-size(?:-after)?$/.test(call.operation));
          assert.equal(reads.length, 44); assert.equal(reads.filter(call => call.rc === 0n).length, 2);
          assert.ok(reads.every(call => call.rc === 0n || call.rc === 1n), "the wrapped real reads are short and both reach EOF");
        } else if (variant === "P3_TEST_BLOCK_INVALID_FORMAT") {
          assert.equal(attrs.size.status, "unavailable"); assert.equal(attrs.size.reason, "format"); assert.equal(attrs.size.value, null);
          assert.ok(attrs.size.calls.every(call => call.rc !== null && call.rc >= 0n));
        } else if (variant === "P3_TEST_BLOCK_ABSENT") {
          assert.equal(attrs.diskSequence.status, "unavailable"); assert.equal(attrs.diskSequence.reason, "syscall");
          assert.deepEqual(attrs.diskSequence.calls.filter(call => call.operation.startsWith("open-")).map(call => [call.rc, call.errno]),
            [[-1n, BigInt(osConstants.errno.ENOENT)], [-1n, BigInt(osConstants.errno.ENOENT)]]);
          assert.equal(attrs.diskSequence.calls.length, 14);
        } else if (variant === "P3_TEST_BLOCK_BUDGET") {
          assert.equal(attrs.size.status, "unavailable"); assert.equal(attrs.size.reason, "budget");
          assert.equal(attrs.size.calls.filter(call => /^read-block-size(?:-after)?$/.test(call.operation) && call.rc !== null).length, 256);
          assert.equal(attrs.size.calls.at(-1)!.rc, 0n);
        } else {
          assert.equal(attrs.diskSequence.status, "unavailable"); assert.equal(attrs.diskSequence.reason, "budget");
          assert.equal(attrs.diskSequence.calls.filter(call => call.operation.startsWith("read-") && call.rc === 4097n).length, 2);
          assert.equal(attrs.diskSequence.calls.at(-1)!.rc, 0n);
        }
        assert.equal(Object.hasOwn(raw, "qualified"), false);
        assert.throws(() => profile.matchSourceFileProfile(handle), (error: any) => error.code === "backup_capability_unavailable" && error.message.includes("source-file-profile-unqualified"),
        "observed ro=1 and stable diskseq cannot open the unchanged empty registry");
        const before = raw.auxiliaryCalls.findIndex(call => call.operation === "open-device-node-0");
        const after = raw.auxiliaryCalls.findIndex(call => call.operation === "close-device-node-0");
        assert.ok(before >= 0 && after > before);
        for (const [index, call] of raw.auxiliaryCalls.entries()) if (call.operation.includes("block-") && call.rc !== null)
          assert.ok(index > before && index < after, call.operation);
      });
      const owner = native.openRoot(source);
      try {
        const first = native.observeEnvironment(owner) as SourceFileRootEnvironment;
        assert.equal(first.abiVersion, 2);
        if (variant === "P3_TEST_BLOCK_READERS") {
          await writeFile(path.join(directory, "m04-sysfs/devices/m04-test-node/diskseq"), "1\n");
          const second = native.observeEnvironment(owner) as SourceFileRootEnvironment;
          assert.equal(first.device.blockAttributes.diskSequence.value?.bytes.toString(), "0\n");
          assert.equal(second.device.blockAttributes.diskSequence.value?.bytes.toString(), "1\n",
            "each actual call reopens and reads its original-node leaf; it cannot reuse an earlier window");
        }
      } finally { native.close(owner); }
    }, compiler);
  });
}
for (const variant of ["P3_TEST_BLOCK_RAW_CHANGE", "P3_TEST_BLOCK_BAD_CHANGE", "P3_TEST_BLOCK_IDENTITY_CHANGE", "P3_TEST_BLOCK_APPEAR", "P3_TEST_BLOCK_DISAPPEAR"] as const) {
  linuxTest(`#152 M04 fixed ${variant} preserves observed change before stable-format or missing classification`, async () => {
    await withFixedP3Package(variant, async ({ directory, api, native }) => {
      const source = path.join(directory, "source"); await mkdir(source, { mode: 0o700 }); let first: any;
      await assert.rejects(api.withNativeSourceRoot(source, handle => {
        try { api.observeSourceFileRootContext(handle); assert.fail("fixed actual boundary change must reject"); }
        catch (error) {
          first = error; assert.equal(first.code, "ERR_SOURCE_IDENTITY"); assert.equal(first.syscall, "environment-changed");
          assert.equal(first.errno, osConstants.errno.ESTALE);
          assert.ok(first.cleanupCalls.some((call: SourceFileNativeCall) => call.operation === "close-block-diskseq-after"));
        }
        assert.throws(() => handle.observe(), { code: "maintenance_lost" });
        assert.throws(() => native.rootInfo(first.nativeCleanupOwner));
      }), error => error instanceof AggregateError && error.errors[0] === first && error.cause === first);
    });
  });
}
linuxTest("#152 M04 fixed leaf close failure preserves undefined primary and never recloses the reused integer", async () => {
  await withFixedP3Package("P3_TEST_BLOCK_CLOSE_FAILURE", async ({ directory, api, native }) => {
    const source = path.join(directory, "source"), sentinel = path.join(source, "sentinel");
    await mkdir(source, { mode: 0o700 }); await writeFile(sentinel, "still owned", { mode: 0o600 });
    let failure: any; const descriptors: number[] = [];
    try {
      await assert.rejects(api.withNativeSourceRoot(source, handle => {
        try { api.observeSourceFileRootContext(handle); assert.fail("fixed actual close error must reject"); }
        catch (error) {
          failure = error; assert.equal(failure.code, "ERR_SOURCE_NATIVE_IO"); assert.equal(failure.errno, osConstants.errno.EIO);
          assert.equal(failure.syscall, "environment-close");
        }
        const calls: SourceFileNativeCall[] = failure.cleanupCalls, unknown = calls.find(call => call.operation === "open-block-size")!.rc;
        assert.ok(calls.some(call => call.operation === "close-block-size" && call.rc === -1n && call.errno === BigInt(osConstants.errno.EIO)));
        assert.ok(calls.some(call => call.operation === "close-device-node-0" && call.rc === 0n));
        for (let index = 0; index < 32; index++) {
          const fd = openSync(sentinel, constants.O_RDONLY); descriptors.push(fd);
          if (BigInt(fd) === unknown) break;
        }
        assert.ok(descriptors.some(fd => BigInt(fd) === unknown)); assert.throws(() => native.rootInfo(failure.nativeCleanupOwner));
        assert.throws(() => handle.observe(), { code: "maintenance_lost" });
        throw undefined;
      }), error => error instanceof AggregateError && error.cause === undefined && error.errors[0] === undefined && error.errors.includes(failure));
      for (const fd of descriptors) assert.equal(fstatSync(fd).size, 11);
    } finally { for (const fd of descriptors) closeSync(fd); }
  });
});

function rawContextFacts(raw: SourceFileRootEnvironment): SourceFileContextFact<unknown>[] {
  return [...Object.values(raw.process), ...Object.values(raw.kernel), ...Object.values(raw.mount), ...Object.values(raw.configuration),
    raw.device.binding, raw.device.dev, raw.device.uevent, raw.device.topology,
    raw.device.blockAttributes.size, raw.device.blockAttributes.readOnly, raw.device.blockAttributes.diskSequence, raw.health.binding, ...raw.health.fields.map(field => field.fact)];
}
function rawKernelFacts(raw: SourceFileRootEnvironment): SourceFileContextFact<unknown>[] {
  const values = rawContextFacts(raw);
  if (raw.device.topology.status === "observed") for (const node of raw.device.topology.value.nodes)
    values.push(node.dev, node.uevent, node.partition, ...Object.values(node.backing));
  // topology.calls aggregates many distinct facts; it is not one 256-read item.
  return values.filter(fact => fact.calls[0]?.operation === "open-kernel-read");
}

// Hardened compilers may emit __read_chk instead of read. Both builds must
// exercise the same fixed failure and retain all production bounds.
for (const compiler of ["default", "fortified"] as const)
for (const variant of ["P3_TEST_SHORT_READS", "P3_TEST_NO_EOF", "P3_TEST_BYTE_BUDGET"] as const) {
  linuxTest(`#152 P3 fixed ${variant} retains bounded unavailable facts through the strict TS decoder (${compiler})`, async () => {
    await withFixedP3Package(variant, async ({ directory, api }) => {
      const source = path.join(directory, "source"); await mkdir(source, { mode: 0o700 });
      await api.withNativeSourceRoot(source, handle => {
        const raw = api.observeSourceFileRootContext(handle).environment;
        for (const fact of rawKernelFacts(raw))
          assert.ok(fact.calls.filter(call => /^read-kernel(?:-after)?$/.test(call.operation) && call.rc !== null).length <= 256);
        for (const fact of rawContextFacts(raw)) if (fact.status === "unavailable") assert.equal(fact.value, null);
        assert.equal(raw.health.fields.length, 13);
        const bytes = raw.auxiliaryCalls.filter(call => /^(?:read-kernel|readlink-|getdents-)/.test(call.operation)
          && call.rc !== null && call.rc > 0n).reduce((sum, call) => sum + call.rc!, 0n);
        assert.ok(bytes <= 2097152n);
        if (variant === "P3_TEST_SHORT_READS") {
          const status = raw.process.threadStatus, reads = status.calls.filter(call => call.operation === "read-kernel" && call.rc !== null);
          assert.equal(status.status, "unavailable"); assert.equal(status.reason, "budget");
          assert.equal(reads.length, 256); assert.ok(reads.every(call => call.rc === 1n));
          assert.equal(status.calls.at(-1)!.rc, 0n);
        } else {
          assert.ok(bytes > 1000000n); assert.equal(raw.configuration.options.status, "unavailable");
          assert.equal(raw.device.binding.status, "unavailable");
          if (variant === "P3_TEST_BYTE_BUDGET") {
            assert.ok(bytes > 2090000n);
            assert.equal(raw.mount.mountinfo.status, "unavailable"); assert.equal(raw.mount.mountinfo.reason, "budget");
            assert.equal(raw.kernel.uname.status, "observed");
            if (raw.kernel.uname.status !== "observed") assert.fail();
            const fixed = BigInt(raw.kernel.uname.value.length) + 256n * BigInt(
              [...raw.mount.legacyStatx.calls, ...raw.mount.uniqueStatx.calls].filter(call => call.rc === 0n).length);
            assert.ok(bytes + fixed <= 2097152n, "raw UAPI bytes share the same global cap");
          }
        }
      });
    }, compiler);
  });
}

linuxTest("#152 P3 fixed pseudo close preserves the first failure and real reused auxiliary FD", async () => {
  await withFixedP3Package("P3_TEST_PSEUDO_CLOSE_FAILURE", async ({ directory, api, native }) => {
    const source = path.join(directory, "source"), sentinel = path.join(source, "sentinel");
    await mkdir(source, { mode: 0o700 }); await writeFile(sentinel, "still owned", { mode: 0o600 });
    const descriptors: number[] = []; let first: any;
    try {
      await assert.rejects(api.withNativeSourceRoot(source, handle => {
        try { api.observeSourceFileRootContext(handle); assert.fail("fixed pseudo close must fail"); }
        catch (error) {
          first = error; assert.equal(first.code, "ERR_SOURCE_NATIVE_IO"); assert.equal(first.errno, osConstants.errno.EIO);
          assert.equal(first.syscall, "environment-close");
        }
        const calls = first.cleanupCalls as SourceFileNativeCall[];
        const unknown = calls.find(call => call.operation === "open-kernel-read" && call.rc !== null && call.rc >= 0n)!.rc;
        assert.ok(calls.some(call => call.operation === "close-kernel-read" && call.rc === -1n && call.errno === BigInt(osConstants.errno.EIO)));
        assert.ok(calls.some(call => call.operation === "close-proc-root" && call.rc === 0n));
        const sysfs = calls.find(call => call.operation === "open-sysfs-root")!.rc;
        assert.ok(calls.some(call => call.operation === "close-sysfs-root" && call.rc === (sysfs !== null && sysfs >= 0n ? 0n : null)));
        assert.throws(() => native.rootInfo(first.nativeCleanupOwner));
        for (let index = 0; index < 16; index++) {
          const fd = openSync(sentinel, constants.O_RDONLY); descriptors.push(fd);
          if (BigInt(fd) === unknown) break;
        }
        assert.ok(descriptors.some(fd => BigInt(fd) === unknown), "the unknown auxiliary descriptor was actually reused");
        assert.throws(() => handle.observe(), { code: "maintenance_lost" });
      }), (error: unknown) => error instanceof AggregateError && error.errors[0] === first && error.cause === first);
      for (const fd of descriptors) assert.equal(fstatSync(fd).size, 11);
    } finally { for (const fd of descriptors) closeSync(fd); }
  });
});

for (const compiler of ["default", "fortified"] as const)
linuxTest(`#152 P3 fixed source change remains sticky even when the caller catches it and close succeeds (${compiler})`, async () => {
  await withFixedP3Package("P3_TEST_SOURCE_CHANGE", async ({ directory, api, native }) => {
    const source = path.join(directory, "source"); await mkdir(source, { mode: 0o700 }); let first: any;
    await assert.rejects(api.withNativeSourceRoot(source, handle => {
      const initial = readdirSync("/proc/self/fd").length;
      try { api.observeSourceFileRootContext(handle); assert.fail("fixed source observation must change"); }
      catch (error) { first = error; assert.equal(first.code, "ERR_SOURCE_IDENTITY"); assert.equal(first.syscall, "environment-changed"); }
      assert.equal(readdirSync("/proc/self/fd").length, initial, "every new known auxiliary owner is closed before failure escapes");
      assert.throws(() => native.rootInfo(first.nativeCleanupOwner));
      assert.throws(() => handle.observe(), { code: "maintenance_lost" });
      return "the caught source failure must not become a successful scope";
    }), (error: unknown) => error instanceof AggregateError && error.errors.length === 1 && error.errors[0] === first && error.cause === first);
  }, compiler);
});

linuxTest("#152 P3 fixed directory close keeps its original error and cannot close a reused duplicate", async () => {
  await withFixedP3Package("P3_TEST_DIRECTORY_CLOSE_FAILURE", async ({ directory, api }) => {
    const source = path.join(directory, "source"), sentinel = path.join(source, "sentinel");
    await mkdir(source, { mode: 0o700 }); await writeFile(sentinel, "still owned", { mode: 0o600 });
    let first: any, current: number | undefined;
    try {
      await assert.rejects(api.withNativeSourceRoot(source, handle => {
        try { handle.readDirectory(); assert.fail("fixed directory close must fail"); }
        catch (error) { first = error; assert.equal(first.code, "ERR_SOURCE_DIRECTORY"); assert.equal(first.errno, osConstants.errno.EIO); }
        const calls = first.cleanupCalls as SourceFileNativeCall[];
        assert.ok(calls.some(call => call.operation === "closedir-source" && call.rc === -1n));
        const unknown = calls.find(call => call.operation === "duplicate-source-dir")!.rc;
        current = openSync(sentinel, constants.O_RDONLY); assert.equal(BigInt(current), unknown);
      }), (error: unknown) => error instanceof AggregateError && error.errors[0] === first && error.cause === first);
      assert.equal(fstatSync(current!).size, 11);
    } finally { if (current !== undefined) closeSync(current); }
  });
});

linuxTest("#152 P3 fixed failed child acquisition retains identity error and unknown cleanup owner", async () => {
  await withFixedP3Package("P3_TEST_CHILD_IDENTITY_FAILURE", async ({ directory, api, native }) => {
    const source = path.join(directory, "source"), sentinel = path.join(source, "sentinel");
    await mkdir(source, { mode: 0o700 }); await writeFile(sentinel, "still owned", { mode: 0o600 });
    let first: any, current: number | undefined;
    try {
      await assert.rejects(api.withNativeSourceRoot(source, handle => {
        try { handle.openChild("sentinel", "file"); assert.fail("fixed child validation must fail"); }
        catch (error) {
          first = error; assert.equal(first.code, "ERR_SOURCE_IDENTITY"); assert.equal(first.errno, osConstants.errno.ESTALE);
          assert.ok(first.cleanupCalls.some((call: SourceFileNativeCall) => call.operation === "close-source" && call.rc === -1n && call.errno === BigInt(osConstants.errno.EIO)));
        }
        assert.ok(first.nativeCleanupOwner); assert.throws(() => native.observe(first.nativeCleanupOwner));
        current = openSync(sentinel, constants.O_RDONLY);
        assert.throws(() => native.close(first.nativeCleanupOwner), { errno: osConstants.errno.EIO });
      }), (error: unknown) => error instanceof AggregateError && error.errors[0] === first && error.cause === first);
      assert.equal(fstatSync(current!).size, 11);
    } finally { if (current !== undefined) closeSync(current); }
  });
});

linuxTest("#152 P0 Linux source FD builds against fixed checked Node-API 8 headers", { timeout: 90_000 }, () => {
  const build = spawnSync(process.execPath, ["scripts/build-maintenance-platform.mjs", "--source-files"],
    { cwd: root, encoding: "utf8", timeout: 65_000 });
  assert.equal(build.error, undefined, "native bridge compilation must actually run");
  assert.equal(build.status, 0, build.stderr.slice(0, 1000));
  const native = createRequire(import.meta.url)(sourceFileNativePath) as NativeBinding;
  for (const name of ["openRoot", "rootInfo", "openRootContent", "observeEnvironment", "openChild", "observe", "observeStatx", "observeStatxUnique", "observeExtended", "readAt", "readDirectory", "close"] as const)
    assert.equal(typeof native[name], "function");
});


linuxTest("#152 M04 real source collector reports ABI 2 and two fresh fixed reader passes", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "br-m04-real-source-"));
  const native = createRequire(import.meta.url)(sourceFileNativePath) as NativeBinding;
  const owner = native.openRoot(directory);
  try {
    const info = native.rootInfo(owner), first = native.observeEnvironment(owner) as SourceFileRootEnvironment;
    assert.equal(info.abiVersion, 1); assert.equal(first.abiVersion, 2);
    const second = native.observeEnvironment(owner) as SourceFileRootEnvironment;
    for (const value of [first, second]) {
      assert.equal(value.device.blockAttributes.readerRevision, 1); assert.equal(value.device.blockAttributes.sourceNodeIndex, 0);
      for (const [field, label] of [["size", "block-size"], ["readOnly", "block-ro"], ["diskSequence", "block-diskseq"]] as const) {
        const fact = value.device.blockAttributes[field];
        assert.equal(fact.calls[0]!.operation, `open-${label}`);
        assert.ok(fact.calls.some(call => call.operation === `open-${label}-after`));
        assert.equal(fact.calls.at(-1)!.operation, `close-${label}-after`);
        assert.ok(fact.reason !== "unsupported");
        if (fact.calls.every(call => call.rc === null)) {
          assert.equal(fact.status, "unavailable"); assert.equal(fact.calls.length, 14);
          assert.ok(fact.calls.every(call => call.errno === null));
          assert.ok(fact.reason === "binding" || fact.reason === "budget");
        }
        if (value.device.binding.status === "observed" && fact.reason !== "budget")
          assert.notEqual(fact.calls[0]!.rc, null, "a real source node must trigger its fixed reader despite the empty registry");
      }
    }
    assert.notEqual(first.device.blockAttributes, second.device.blockAttributes);
    assert.notEqual(first.device.blockAttributes.size.calls, second.device.blockAttributes.size.calls);
    await withNativeDecoders(decode => {
      assert.equal(decode.checkedEnvironment(first, info).abiVersion, 2);
      for (const mutate of [(value: any) => { value.abiVersion = 1; },
        (value: any) => { delete value.device.blockAttributes; },
        (value: any) => { value.device.blockAttributes.readerRevision = 2; },
        (value: any) => { value.device.blockAttributes.sourceNodeIndex = 1; }]) {
        const value = native.observeEnvironment(owner); mutate(value);
        assert.throws(() => decode.checkedEnvironment(value, info), { code: "backup_capability_unavailable" });
      }
    });
    t.diagnostic(first.device.blockAttributes.size.calls[0]!.rc !== null
      ? "real source node0 reader acquisition OBSERVED; no qualification assertion"
      : "real source node0 unavailable: fixed not-run records OBSERVED; actual leaf acquisition NOT_RUN");
  } finally { native.close(owner); await rm(directory, { recursive: true, force: true }); }
  assert.throws(() => native.observeEnvironment(owner), { code: "ERR_SOURCE_HANDLE" });
});

linuxTest("#152 P3 strict context consumes the real collector with complete typed unavailable facts", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "br-p3-real-context-"));
  try {
    await withNativeSourceRoot(tmp, handle => {
      const current = handle.observe(), context = observeSourceFileRootContext(handle), environment = context.environment;
      assert.equal(context.info.abiVersion, 1); assert.equal(environment.abiVersion, 2);
      assert.equal(context.info.metadata.ino, current.ino); assert.equal(context.info.metadata.dev, current.dev);
      assert.deepEqual(environment.source.before, context.info.metadata);
      assert.deepEqual(environment.source.after, environment.source.before);
      assert.equal(environment.health.fields.length, 13);
      assert.equal(environment.configuration.options.calls[0]!.operation, "open-kernel-read");
      assert.ok(environment.configuration.options.calls.some(call => call.operation === "open-kernel-read-after"));
      assert.equal(environment.mount.uniqueStatx.calls[1]!.operation, "statx-unique-after");
      assert.equal(environment.kernel.config.status, "unavailable");
      assert.equal(environment.kernel.config.reason, "unsupported");
      assert.equal(environment.kernel.config.value, null);
      assert.equal(Object.hasOwn(context, "qualified"), false);
      for (const { fact } of environment.health.fields) {
        if (fact.status === "observed") assert.equal(Buffer.isBuffer(fact.value.bytes), true);
        else assert.equal(fact.value, null);
      }
    });
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

linuxTest("#152 MB1 real collector supplies a mandatory two-pass fact and rejects stale native output", async t => {
  const build = spawnSync(process.execPath, ["scripts/build-maintenance-platform.mjs", "--source-files"],
    { cwd: root, encoding: "utf8", timeout: 65_000 });
  assert.equal(build.error, undefined); assert.equal(build.status, 0, build.stderr);
  const directory = await mkdtemp(path.join(tmpdir(), "br-mb1-real-source-"));
  const native = createRequire(import.meta.url)(sourceFileNativePath) as NativeBinding, owner = native.openRoot(directory);
  try {
    const info = native.rootInfo(owner), raw = native.observeEnvironment(owner) as SourceFileRootEnvironment;
    assert.equal(Object.hasOwn(raw.configuration, "mbStructsSummary"), true, "the production collector must emit the new fixed leaf fact");
    const fact = (raw.configuration as any).mbStructsSummary as SourceFileContextFact<SourceFileKernelReadValue>;
    assert.equal(fact.calls[0]!.operation, "open-kernel-read");
    assert.ok(fact.calls.some(call => call.operation === "open-kernel-read-after"));
    assert.equal(fact.calls.at(-1)!.operation, "close-kernel-read-after");
    await withNativeDecoders(decode => {
      assert.ok(Object.hasOwn(decode.checkedEnvironment(raw, info).configuration, "mbStructsSummary"));
      const stale = native.observeEnvironment(owner) as any; delete stale.configuration.mbStructsSummary;
      assert.throws(() => decode.checkedEnvironment(stale, info), { code: "backup_capability_unavailable" });
      for (const mutate of [(value: any) => { value.configuration.mbFallback = 0; },
        (value: any) => { value.configuration.mbStructsSummary = kernelReadFixture(1); },
        (value: any) => { value.configuration.mbStructsSummary = kernelReadFixture(2);
          value.configuration.mbStructsSummary.value.filesystemType = 0x62656572n; }]) {
        const value = native.observeEnvironment(owner); mutate(value);
        assert.throws(() => decode.checkedEnvironment(value, info), { code: "backup_capability_unavailable" });
      }
      let accessed = false;
      const value = native.observeEnvironment(owner) as any;
      Object.defineProperty(value.configuration, "mbStructsSummary", { enumerable: true,
        get() { accessed = true; throw new Error("the source getter must never execute"); } });
      assert.throws(() => decode.checkedEnvironment(value, info), { code: "backup_capability_unavailable" });
      assert.equal(accessed, false);
    });
    let touched = false;
    const forged = new Proxy({}, { get() { touched = true; throw new Error("caller source material must not execute"); } });
    assert.throws(() => observeSourceFileRootContext(forged as any), { code: "maintenance_lost" });
    assert.throws(() => matchSourceFileProfile(raw as any), { code: "maintenance_lost" });
    assert.equal(touched, false);
    t.diagnostic(fact.status === "observed" ? "actual fixed leaf OBSERVED; fixed ext4 qualification still NOT_RUN"
      : `actual collector ${fact.reason} fact OBSERVED; successful fixed ext4 leaf acquisition NOT_RUN`);
  } finally { native.close(owner); await rm(directory, { recursive: true, force: true }); }
});

linuxTest("#152 P3 complete real root and file preflight reach the fixed empty registry", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "br-p3-empty-registry-")), file = path.join(tmp, "file");
  try {
    await writeFile(file, "unqualified", { mode: 0o600 });
    const registryFailure = (error: unknown) => error instanceof MaintenanceFailure
      && error.code === "backup_capability_unavailable" && error.message.includes("source-file-profile-unqualified");
    await withNativeSourceRoot(tmp, handle => assert.throws(() => matchSourceFileProfile(handle), registryFailure));
    let called = false;
    await assert.rejects(withNativeSourceRoot(file, () => { called = true; }), registryFailure);
    assert.equal(called, false, "a complete native preflight reaches registry rejection before content admission");
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

linuxTest("#152 P3 fixed content-open failure proves real file preflight rejects before ordinary open", async () => {
  await withFixedP3Package("P3_TEST_CONTENT_OPEN_FAILURE", async ({ directory, api, native }) => {
    const source = path.join(directory, "source"), file = path.join(source, "file");
    await mkdir(source, { mode: 0o700 }); await writeFile(file, "never-admitted", { mode: 0o600 });
    const bootstrap = native.openRoot(file);
    try {
      assert.equal(native.rootInfo(bootstrap).stage, "metadata-only");
      assert.equal((native.observeEnvironment(bootstrap) as { abiVersion: number }).abiVersion, 2,
        "fixed content fault does not intercept actual pseudo-file collection");
      assert.throws(() => native.openRootContent(bootstrap), (error: unknown) => {
        const failure = error as { code?: unknown; errno?: unknown; syscall?: unknown };
        return failure.code === "ERR_SOURCE_NATIVE_IO" && failure.errno === 130 && failure.syscall === "openat2-root-content";
      }, "the actual content-open branch must demonstrably fail when reached");
    } finally { native.close(bootstrap); }
    let called = false;
    await assert.rejects(api.withNativeSourceRoot(file, () => { called = true; }), (error: unknown) => {
      const failure = error as { code?: unknown; message?: unknown; cause?: unknown };
      return failure.code === "backup_capability_unavailable" && typeof failure.message === "string"
        && failure.message.includes("source-file-profile-unqualified") && failure.cause === undefined;
    });
    assert.equal(called, false);
  });
});

linuxTest("#152 P3 fixed close failure invalidates the scope, preserves first error and never recloses a reused FD", async () => {
  await withFixedP3Package("P3_TEST_CONTENT_CLOSE_FAILURE", async ({ directory, api }) => {
    const source = path.join(directory, "source"), spare = path.join(source, "spare");
    await mkdir(source, { mode: 0o700 });
    await writeFile(path.join(source, "one"), "one", { mode: 0o600 });
    await writeFile(path.join(source, "two"), "two", { mode: 0o600 });
    await writeFile(spare, "retained", { mode: 0o600 });
    let first: unknown, unrelated: number | undefined;
    try {
      await assert.rejects(api.withNativeSourceRoot(source, rootHandle => {
        const one = rootHandle.openChild("one", "file"), two = rootHandle.openChild("two", "file");
        try { one.close(); assert.fail("fixed close fault must occur"); }
        catch (error) {
          assert.equal((error as { code: string }).code, "ERR_SOURCE_NATIVE_IO");
          assert.equal((error as { errno: number }).errno, osConstants.errno.EIO); first = error;
        }
        // The fixture really closed the regular file but returned EIO. The next
        // ordinary Node open can reuse that slot; it is not owned by this scope.
        unrelated = openSync(spare, constants.O_RDONLY);
        assert.throws(() => one.close(), { code: "maintenance_lost" });
        assert.throws(() => two.observe(), { code: "maintenance_lost" });
        // 'two' and root remain known owners for deterministic cleanup.
      }), (error: unknown) => error instanceof AggregateError && error.errors.length === 1 && error.errors[0] === first && error.cause === first);
      const bytes = Buffer.alloc(8);
      assert.equal(readSync(unrelated!, bytes, 0, bytes.length, 0), 8);
      assert.equal(bytes.toString(), "retained");
    } finally { if (unrelated !== undefined) closeSync(unrelated); }
  });
});

linuxTest("#152 P3 a caught fatal native context error cannot become a successful scope result", async () => {
  await withFixedP3Package("P3_TEST_CONTENT_CLOSE_FAILURE", async ({ directory, api }) => {
    const source = path.join(directory, "source"); await mkdir(source, { mode: 0o700 });
    let first: unknown;
    await assert.rejects(api.withNativeSourceRoot(source, handle => {
      try { api.observeSourceFileRootContext(handle); assert.fail("fixed pseudo close must fail during actual collection"); }
      catch (error) {
        assert.equal((error as { code: string }).code, "ERR_SOURCE_NATIVE_IO");
        assert.equal((error as { syscall: string }).syscall, "environment-close"); first = error;
      }
      return "caught failures cannot become source success";
    }), (error: unknown) => error instanceof AggregateError && error.errors[0] === first && error.cause === first);
  });
});

linuxTest("#152 P3 profile matching rejects fake, child, copied and expired owners and retains failure", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "br-p3-root-profile-"));
  try {
    await writeFile(path.join(tmp, "file"), "ordinary", { mode: 0o600 });
    let escaped: Parameters<typeof matchSourceFileProfile>[0] | undefined;
    await withNativeSourceRoot(tmp, handle => {
      escaped = handle;
      let invoked = false;
      const fake = { kind: "directory", observe() { invoked = true; return handle.observe(); } };
      assert.throws(() => matchSourceFileProfile(fake as Parameters<typeof matchSourceFileProfile>[0]), { code: "maintenance_lost" });
      assert.equal(invoked, false);
      const copy = Object.assign(Object.create(Object.getPrototypeOf(handle)), handle);
      assert.throws(() => matchSourceFileProfile(copy), { code: "maintenance_lost" });
      const child = handle.openChild("file", "file");
      try { assert.throws(() => matchSourceFileProfile(child), { code: "backup_capability_unavailable" }); }
      finally { child.close(); }
      let first: unknown;
      try { matchSourceFileProfile(handle); assert.fail("an empty fixed registry cannot qualify a real root"); }
      catch (error) { assert.equal((error as MaintenanceFailure).code, "backup_capability_unavailable"); first = error; }
      assert.throws(() => matchSourceFileProfile(handle), error => error === first,
        "a failed context is sticky; later calls cannot replace its failure with a new baseline");
    });
    assert.throws(() => matchSourceFileProfile(escaped!), { code: "maintenance_lost" });
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

linuxTest("#152 P3 file bootstrap has no readable FD and content promotion creates an independent owner", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "br-p3-file-bootstrap-")), file = path.join(tmp, "file");
  try {
    await writeFile(file, "content", { mode: 0o600 });
    const native = createRequire(import.meta.url)(sourceFileNativePath) as NativeBinding;
    const before = await stat(file, { bigint: true }), bootstrap = native.openRoot(file);
    let bootstrapClosed = false, content: object | undefined;
    try {
      const info = native.rootInfo(bootstrap);
      assert.equal(info.abiVersion, 1); assert.equal(info.kind, "file"); assert.equal(info.stage, "metadata-only");
      assert.equal(info.metadata.dev, before.dev); assert.equal(info.metadata.ino, before.ino);
      assert.throws(() => native.observe(bootstrap), { code: "ERR_SOURCE_HANDLE" });
      assert.throws(() => native.observeExtended(bootstrap), { code: "ERR_SOURCE_HANDLE" });
      assert.throws(() => native.readAt(bootstrap, 0n, 1));
      assert.throws(() => native.rootInfo({ ...bootstrap }), { code: "ERR_SOURCE_HANDLE" });
      content = native.openRootContent(bootstrap);
      assert.notEqual(content, bootstrap); assert.equal(native.rootInfo(content).stage, "readable");
      assert.deepEqual(native.rootInfo(content).metadata, info.metadata);
      assert.equal(native.rootInfo(bootstrap).stage, "metadata-only");
      assert.throws(() => native.openRootContent(bootstrap), { code: "ERR_SOURCE_HANDLE" });
      native.close(bootstrap); bootstrapClosed = true;
      assert.equal(native.readAt(content, 0n, 7).toString(), "content");
    } finally {
      if (content) native.close(content);
      if (!bootstrapClosed) native.close(bootstrap);
    }
    assert.equal((await stat(file, { bigint: true })).atimeNs, before.atimeNs, "the ordinary content owner really uses NOATIME");
    let consumed = false;
    await assert.rejects(withNativeSourceRoot(file, () => { consumed = true; }), { code: "backup_capability_unavailable" });
    assert.equal(consumed, false, "the fixed file factory does not expose a content owner before profile admission");
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

linuxTest("#152 P3 native directory enumeration rejects invalid UTF-8 instead of replacing bytes", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "br-p3-native-utf8-"));
  try {
    await writeFile(path.join(tmp, "中文"), "ok", { mode: 0o600 });
    await withNativeSourceRoot(tmp, handle => assert.deepEqual(handle.readDirectory(), ["中文"]));
    await writeFile(Buffer.concat([Buffer.from(tmp + "/"), Buffer.from([0xff])]), "raw", { mode: 0o600 });
    await assert.rejects(withNativeSourceRoot(tmp, handle => {
      assert.throws(() => handle.readDirectory(), { code: "ERR_SOURCE_DIRECTORY" });
    }), error => error instanceof AggregateError && error.errors.length === 1 && error.errors[0].code === "ERR_SOURCE_DIRECTORY",
    "catching the actual directory read error cannot turn the native window into success");
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

linuxTest("#152 P3 handles keep native ownership private and copies cannot borrow a live owner", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "br-p3-private-owner-"));
  try {
    let escaped: Parameters<typeof observeSourceFile>[0] | undefined;
    await withNativeSourceRoot(tmp, handle => {
      escaped = handle;
      assert.deepEqual(Reflect.ownKeys(handle), ["kind"]);
      const copied = Object.assign(Object.create(Object.getPrototypeOf(handle)), handle);
      assert.throws(() => observeSourceFile(copied), { code: "maintenance_lost" });
      assert.throws(() => handle.observe.call(copied), { code: "maintenance_lost" });
      let called = false;
      const fake = { kind: "directory", observe() { called = true; return handle.observe(); } };
      assert.throws(() => observeSourceFile(fake as Parameters<typeof observeSourceFile>[0]), { code: "maintenance_lost" });
      assert.equal(called, false, "source provenance never invokes caller supplied methods");
      assert.equal(Object.isFrozen(handle), true);
    });
    assert.throws(() => observeSourceFile(escaped!), { code: "maintenance_lost" });
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

linuxTest("#152 P3 UNIQUE statx is a separate same-owner observation, never a legacy-ID alias", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "br-p3-unique-statx-"));
  try {
    await writeFile(path.join(tmp, "file"), "unique-statx", { mode: 0o600 });
    await withNativeSourceRoot(tmp, handle => {
      const child = handle.openChild("file", "file");
      try {
        for (const owner of [handle, child]) {
          const observed = owner.observe(), legacy = owner.observeStatx();
          assert.equal(typeof owner.observeStatxUnique, "function");
          const unique = owner.observeStatxUnique();
          assert.equal(unique.kind, observed.kind); assert.equal(unique.ino, observed.ino);
          assert.equal(unique.devMajor, legacy.devMajor); assert.equal(unique.devMinor, legacy.devMinor);
          assert.equal(Object.hasOwn(unique, "mountId"), false);
          assert.equal((unique.mask & 0x4000n) !== 0n, unique.uniqueMountId !== null);
          const extended = owner.observeExtended();
          if (extended.fid.status === "observed") assert.equal(unique.uniqueMountId, extended.fid.value.mountId);
        }
      } finally { child.close(); }
      assert.throws(() => child.observeStatxUnique(), { code: "maintenance_lost" });
    });
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

linuxTest("#152 P2 extended facts use the live owner and retain explicit syscall outcomes", async t => {
  const tmp = await mkdtemp(path.join(tmpdir(), "br-p2-facts-"));
  try {
    await writeFile(path.join(tmp, "file"), "ordinary-read-only-fixture", { mode: 0o600 });
    await withNativeSourceRoot(tmp, rootHandle => {
      const file = rootHandle.openChild("file", "file");
      try {
        for (const handle of [rootHandle, file]) {
          const initial = handle.observe(), result = handle.observeExtended();
          assert.equal(result.before.kind, handle.kind);
          assert.equal(result.before.dev, initial.dev); assert.equal(result.before.ino, initial.ino);
          assert.deepEqual(result.after, result.before);
          assert.equal(typeof result.before.gid, "bigint"); assert.equal(typeof result.before.atimeNs, "bigint");
          assert.equal(Object.hasOwn(result, "qualified"), false);
          for (const key of ["uuid", "fid", "inodeFlags", "xattrs"] as const) {
            const fact = result[key];
            assert.ok(["observed", "unavailable"].includes(fact.status));
            assert.ok(fact.calls.length > 0);
            for (const call of fact.calls) {
              if (call.rc === null) { assert.equal(call.errno, null); continue; }
              assert.equal(typeof call.rc, "bigint"); assert.equal(typeof call.errno, "bigint");
              if (call.rc < 0n) assert.ok(call.errno! > 0n);
              else assert.equal(call.errno, 0n);
            }
            if (fact.status === "observed") {
              assert.equal(fact.reason, null); assert.notEqual(fact.value, null);
              assert.ok(fact.calls.every(call => call.rc !== null && call.rc >= 0n && call.errno === 0n));
            } else {
              assert.equal(fact.value, null); assert.equal(typeof fact.reason, "string");
            }
          }
          assert.throws(() => matchSourceFileProfile(handle), { code: "backup_capability_unavailable" });
          t.diagnostic(JSON.stringify({ kind: handle.kind,
            uuid: result.uuid.status, fid: result.fid.status, inodeFlags: result.inodeFlags.status, xattrs: result.xattrs.status }));
        }
      } finally { file.close(); }
      assert.throws(() => file.observeExtended(), { code: "maintenance_lost" });
    });
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

linuxTest("#152 P2 accessible xattr names and values stay raw, bounded and on the same file", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "br-p2-xattr-"));
  try {
    const file = path.join(tmp, "file");
    await writeFile(file, "xattr-fixture", { mode: 0o600 });
    const seed = spawnSync("python3", ["-c", "import os,sys; p=sys.argv[1]; os.setxattr(p,b'user.boardroom-raw-\\xff',bytes([0,255,128,1])); os.setxattr(p,b'user.boardroom-empty',b'')", file],
      { encoding: "utf8", timeout: 5000 });
    assert.equal(seed.error, undefined); assert.equal(seed.status, 0, seed.stderr);
    await withNativeSourceRoot(tmp, handle => {
      const child = handle.openChild("file", "file");
      try {
        const result = child.observeExtended();
        assert.equal(result.xattrs.status, "observed");
        if (result.xattrs.status !== "observed") assert.fail("xattr fixture must be read");
        const attrs = result.xattrs.value;
        const raw = Buffer.concat([Buffer.from("user.boardroom-raw-"), Buffer.from([255])]);
        assert.deepEqual(attrs.find(entry => entry.name.equals(raw))?.value, Buffer.from([0,255,128,1]));
        assert.deepEqual(attrs.find(entry => entry.name.equals(Buffer.from("user.boardroom-empty")))?.value, Buffer.alloc(0));
        assert.deepEqual(child.observeExtended(), result, "ordinary metadata getters do not alter their source");
        const rootFacts = handle.observeExtended();
        assert.equal(rootFacts.xattrs.status, "observed");
        if (rootFacts.xattrs.status === "observed") assert.equal(rootFacts.xattrs.value.some(entry => entry.name.equals(raw)), false);
        assert.equal(result.xattrs.calls[0]!.operation, "flistxattr-before");
        assert.equal(result.xattrs.calls.at(-1)!.operation, "flistxattr-after");
      } finally { child.close(); }
    });
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

linuxTest("#152 P2 xattr count overflow is explicitly unavailable and never a partial list", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "br-p2-xattr-budget-"));
  try {
    const file = path.join(tmp, "file");
    await writeFile(file, "bounded-fixture", { mode: 0o600 });
    const seed = spawnSync("python3", ["-c", "import os,sys; [os.setxattr(sys.argv[1],('user.b%02d'%i).encode(),b'') for i in range(65)]", file],
      { encoding: "utf8", timeout: 5000 });
    assert.equal(seed.error, undefined); assert.equal(seed.status, 0, seed.stderr);
    await withNativeSourceRoot(tmp, handle => {
      const child = handle.openChild("file", "file");
      try {
        const facts = child.observeExtended();
        assert.equal(facts.xattrs.status, "unavailable"); assert.equal(facts.xattrs.reason, "budget");
        assert.equal(facts.xattrs.value, null);
        assert.ok(facts.xattrs.calls[0]!.rc! > 0n);
        assert.deepEqual(facts.xattrs.calls.at(-1), { operation: "flistxattr-after", rc: null, errno: null });
        assert.throws(() => matchSourceFileProfile(child), { code: "backup_capability_unavailable" });
      } finally { child.close(); }
    });
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

linuxTest("#152 P2 native stale owner and changed ordinary permissions cannot yield facts", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "br-p2-owner-"));
  try {
    const native = createRequire(import.meta.url)(sourceFileNativePath) as NativeBinding;
    const previous = native.openRoot(tmp);
    native.close(previous);
    const current = native.openRoot(tmp);
    try {
      assert.throws(() => native.observeExtended(previous), { code: "ERR_SOURCE_HANDLE" });
      assert.throws(() => native.observeExtended({}), { code: "ERR_SOURCE_HANDLE" });
      assert.ok(native.observeExtended(current));
    } finally { native.close(current); }
    await assert.rejects(withNativeSourceRoot(tmp, handle => {
      const changed = chmod(tmp, 0o777);
      return changed.then(() => {
        assert.throws(() => handle.observeExtended(), { code: "ERR_SOURCE_IDENTITY" });
      });
    }), error => error instanceof AggregateError && error.errors.length === 1 && error.errors[0].code === "ERR_SOURCE_IDENTITY");
  } finally { await chmod(tmp, 0o700); await rm(tmp, { recursive: true, force: true }); }
});

linuxTest("#152 P2 fixed syscall fault fixture keeps EACCES/EOVERFLOW unavailable without fabricated values", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "br-p2-call-errors-"));
  try {
    const addon = path.join(tmp, "getter-errors.node");
    const build = spawnSync("/usr/bin/cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-DNAPI_VERSION=8",
      "-DNODE_GYP_MODULE_NAME=boardroom_source_file_test_errors", "-shared", "-fPIC", "-I", path.join(root, "native/node-api/v24.22.1"),
      path.join(root, "native/maintenance-source-files.c"), path.join(root, "tests/fixtures/maintenance-source-file-getter-errors.c"),
      "-Wl,--wrap=ioctl", "-Wl,--wrap=syscall", "-o", addon], { encoding: "utf8", timeout: 30_000 });
    assert.equal(build.error, undefined); assert.equal(build.status, 0, build.stderr);
    const native = createRequire(import.meta.url)(addon) as NativeBinding;
    const owner = native.openRoot(tmp);
    try {
      const result = native.observeExtended(owner) as SourceFileExtendedObservation;
      for (const key of ["uuid", "inodeFlags"] as const) {
        assert.equal(result[key].status, "unavailable"); assert.equal(result[key].reason, "syscall");
        assert.equal(result[key].value, null);
        assert.equal(result[key].calls[0]!.rc, -1n); assert.equal(result[key].calls[0]!.errno, BigInt(osConstants.errno.EACCES));
      }
      assert.equal(result.fid.status, "unavailable"); assert.equal(result.fid.value, null);
      assert.equal(result.fid.calls[0]!.rc, -1n); assert.equal(result.fid.calls[0]!.errno, BigInt(osConstants.errno.EOVERFLOW));
      assert.equal(result.xattrs.status, "observed");
      assert.deepEqual(result.before, result.after);
    } finally { native.close(owner); }
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

linuxTest("#152 P0 pinned native file owner never changes FD across two real reads or reuses closed handles", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "br-p0-source-")), source = path.join(tmp, "source");
  try {
    await mkdir(source, { mode: 0o700 });
    const bytes = Buffer.from([0, 255, 128, 42, 10, 0]);
    await writeFile(path.join(source, "file.bin"), bytes, { mode: 0o600 });
    await mkdir(path.join(source, "nested"), { mode: 0o700 });
    await withNativeSourceRoot(source, async handle => {
      const base = observeSourceFile(handle);
      assert.equal(base.kind, "directory");
      assert.ok(base.dev > 0n && base.ino > 0n);
      const rootStatx = handle.observeStatx();
      assert.equal(rootStatx.kind, "directory");
      assert.equal(rootStatx.ino, base.ino);
      assert.equal(rootStatx.mask & 0x7ffn, 0x7ffn);
      assert.equal(rootStatx.mountId === null || rootStatx.mountId > 0n, true);
      assert.equal(rootStatx.birthtimeNs === null || typeof rootStatx.birthtimeNs === "bigint", true);
      assert.deepEqual(handle.readDirectory(), ["file.bin", "nested"]);
      assert.deepEqual(handle.readDirectory(), ["file.bin", "nested"], "enumeration is repeatable");
      const file = handle.openChild("file.bin", "file");
      const initial = file.observe();
      assert.equal(initial.kind, "file");
      assert.equal(initial.size, BigInt(bytes.length));
      const pinnedFacts = file.observeStatx();
      assert.equal(pinnedFacts.kind, "file");
      assert.equal(pinnedFacts.ino, initial.ino);
      assert.equal(pinnedFacts.mask & 0x7ffn, 0x7ffn);
      assert.equal(pinnedFacts.attributes & ~pinnedFacts.attributesMask, 0n,
        "unadvertised statx attribute bits must not be interpreted as facts");
      assert.deepEqual(file.readAt(0n, 6), bytes);
      assert.deepEqual(file.readAt(2n, 3), bytes.subarray(2, 5));
      assert.deepEqual(file.readAt(6n, 1), Buffer.alloc(0));
      assert.deepEqual(file.observe(), initial, "same live object and unchanged typed metadata");
      assert.deepEqual(file.observeStatx(), pinnedFacts, "statx uses the same stable owned FD");
      assert.throws(() => file.readAt(-1n, 1), { code: "source_changed" });
      assert.throws(() => file.readAt(0n, 65537), { code: "source_changed" });
      file.close();
      assert.throws(() => file.readAt(0n, 1), { code: "maintenance_lost" });
      assert.throws(() => file.observeStatx(), { code: "maintenance_lost" });
      assert.throws(() => file.close(), { code: "maintenance_lost" });
      const nested = handle.openChild("nested", "directory");
      assert.deepEqual(nested.readDirectory(), []);
      nested.close();
      assert.throws(() => matchSourceFileProfile(handle),
        error => error instanceof MaintenanceFailure && error.code === "backup_capability_unavailable");
    });
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

linuxTest("#152 P0 real native openat2 rejects symlink, hardlink, leaf escape and stale owned directory", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "br-p0-reject-")), source = path.join(tmp, "source");
  try {
    await mkdir(source, { mode: 0o700 });
    await writeFile(path.join(source, "multi"), "original", { mode: 0o600 });
    await link(path.join(source, "multi"), path.join(source, "alias"));
    await writeFile(path.join(source, "ordinary"), "ok", { mode: 0o600 });
    await symlink("ordinary", path.join(source, "sym"));
    await withNativeSourceRoot(source, async rootHandle => {
      for (const name of ["", ".", "..", "../escape", "a/b", "a\0b", "x".repeat(4097)])
        assert.throws(() => rootHandle.openChild(name, "file"));
      assert.throws(() => rootHandle.readAt(0n, 1));
    });
    for (const [leaf, kind] of [["alias", "file"], ["multi", "file"], ["sym", "file"], ["ordinary", "directory"]] as const) {
      let original: unknown;
      await assert.rejects(withNativeSourceRoot(source, rootHandle => {
        assert.throws(() => rootHandle.openChild(leaf, kind), error => { original = error; return true; });
      }), error => error instanceof AggregateError && error.errors.length === 1 && error.errors[0] === original,
      "each real failed lookup runs in its own scope; an earlier sticky failure cannot mask the case");
    }
    await symlink(source, path.join(tmp, "source-link"));
    await assert.rejects(withNativeSourceRoot(path.join(tmp, "source-link"), async () => {}),
      error => error instanceof Error);
    const native = createRequire(import.meta.url)(sourceFileNativePath) as NativeBinding;
    const raw = native.openRoot(source);
    native.close(raw);
    assert.throws(() => native.openChild(raw, "ordinary", "file"));
    assert.throws(() => native.observe(raw));
    assert.throws(() => native.observeStatx(raw));
    assert.throws(() => native.close(raw));
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

linuxTest("#152 P0 invalid source bytes/permissions and leaked children fail closed without issuing Fs", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "br-p0-cleanup-")), source = path.join(tmp, "source");
  try {
    await mkdir(source, { mode: 0o700 });
    await writeFile(path.join(source, "file"), "safe", { mode: 0o600 });
    await assert.rejects(withNativeSourceRoot(source, async rootHandle => {
      rootHandle.openChild("file", "file"); // The child's owner is intentionally not closed.
    }), error => error instanceof MaintenanceFailure && error.code === "maintenance_lost");
    let observed = false;
    try { await withNativeSourceRoot(source, async () => { throw undefined; }); }
    catch (error) { observed = true; assert.equal(error, undefined, "undefined is the original error"); }
    assert.equal(observed, true);
    await chmod(path.join(source, "file"), 0o666);
    await assert.rejects(withNativeSourceRoot(source, async rootHandle => {
      rootHandle.openChild("file", "file");
    }), error => error instanceof Error);
    await chmod(path.join(source, "file"), 0o600);
    await withNativeSourceRoot(source, async rootHandle => {
      const child = rootHandle.openChild("file", "file");
      assert.equal(child.observe().size, 4n);
      child.close();
    });
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

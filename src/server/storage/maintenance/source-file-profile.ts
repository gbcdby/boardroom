import { MaintenanceFailure } from "./error.ts";
import { canonicalJson, digestJson } from "./canonical.ts";
import { SOURCE_FILE_HEALTH_NAMES, assertSourceFileRootActive, observeSourceFileRootContext,
  observeSourceFileBootstrap, promoteSourceFileBootstrap } from "./source-file-native.ts";
import type { SourceFileHandle, SourceFileMetadata, SourceFileExtendedObservation, SourceFileUniqueStatxObservation,
  SourceFileKernelReadValue, SourceFileNativeCall, SourceFileHealthName, SourceFileContextFact,
  SourceFileRootEnvironment, SourceFileExtendedMetadata, SourceFileRootContext, SourceFileBootstrapContext } from "./source-file-native.ts";

export interface SourceFileKernelRead extends SourceFileKernelReadValue {
  readonly calls: readonly SourceFileNativeCall[];
}
export interface SourceFileMountBinding {
  readonly legacyMountId: bigint;
  readonly uniqueMountId: bigint;
  readonly devMajor: bigint;
  readonly devMinor: bigint;
  readonly filesystemType: "ext4";
  readonly root: string;
  readonly point: string;
  readonly attributes: bigint;
  readonly superblockFlags: bigint;
  readonly propagation: bigint;
}
export interface SourceFileRootObservation {
  readonly root: SourceFileExtendedObservation;
  readonly uniqueStatx: SourceFileUniqueStatxObservation;
  readonly mount: SourceFileMountBinding;
  readonly health: Readonly<Record<SourceFileHealthName, SourceFileKernelRead>>;
  readonly runtimeEnvironmentDigest: string;
}

/** Successful contexts can only originate from the private owner and the fixed
 * registry below. The current build deliberately has no qualified entries. */
export interface QualifiedSourceFileProfile {
  readonly profile: "linux-native-ext4-fid-fsuuid-source-state-v1";
  readonly source: SourceFileMetadata;
  readonly profileEntryDigest: string;
  readonly qualificationDigest: string;
  observe(): SourceFileRootObservation;
  beforeContent(): SourceFileRootObservation;
  afterContent(): SourceFileRootObservation;
}
const PROFILE = "linux-native-ext4-fid-fsuuid-source-state-v1" as const;
interface FixedProfileEntry {
  readonly profile: typeof PROFILE;
  readonly requiredConfiguration: unknown;
  readonly profileEvidence: unknown;
  readonly qualificationEvidence: unknown;
}
// Adding an entry requires a new, independently reviewed source candidate and
// real qualification material. This is not a registration API or test hook.
const FIXED_PROFILES: readonly FixedProfileEntry[] = Object.freeze([]);
const UNPROVEN = Object.freeze(["M01_KERNEL_BUILD_SOURCE_CONFIG_UNPROVEN", "M02_COMPLETE_EFFECTIVE_OPTIONS_UNPROVEN",
  "M02_JOURNAL_TASK_IDENTITY_UNPROVEN", "M04_ORDINARY_BACKING_WRITER_COVERAGE_UNPROVEN"] as const);
const unavailable = (subject = "source-file-profile-unqualified") => new MaintenanceFailure("backup_capability_unavailable", subject);
const changed = () => new MaintenanceFailure("source_changed", "source-file-profile");
function requireValue(value: unknown, subject = "source-file-profile-material"): asserts value {
  if (!value) throw unavailable(subject);
}
function requireSame(value: unknown): asserts value { if (!value) throw changed(); }
function observed<T>(fact: SourceFileContextFact<T>): T {
  if (fact.status !== "observed") {
    if (fact.reason === "identity") throw changed();
    throw unavailable("source-file-native-fact-unavailable");
  }
  return fact.value;
}
function text(raw: Buffer): string {
  try {
    const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
    requireValue(!value.includes("\0") && Buffer.from(value).equals(raw), "source-file-text");
    return value;
  } catch (error) { if (error instanceof MaintenanceFailure) throw error; throw unavailable("source-file-text"); }
}
function decimal(value: string, maximum = 0xffffffffffffffffn): bigint {
  requireValue(/^(0|[1-9][0-9]*)$/.test(value) && value.length <= 20, "source-file-integer");
  const number = BigInt(value); requireValue(number <= maximum, "source-file-integer"); return number;
}
function encodedDevice(major: bigint, minor: bigint): bigint {
  return ((major & 0xfffn) << 8n) | (minor & 0xffn) | ((minor & ~0xffn) << 12n) | ((major & ~0xfffn) << 32n);
}
function typed(value: unknown, depth = 0): unknown {
  requireValue(depth <= 64, "source-file-runtime-depth");
  if (value === null) return ["null"];
  if (typeof value === "bigint") return ["bigint", String(value)];
  if (Buffer.isBuffer(value)) return ["bytes", value.toString("hex")];
  if (typeof value === "string" || typeof value === "boolean") return [typeof value, value];
  if (typeof value === "number") { requireValue(Number.isSafeInteger(value) && !Object.is(value, -0)); return ["number", value]; }
  if (Array.isArray(value)) {
    requireValue(Object.keys(value).length === value.length && Reflect.ownKeys(value).length === value.length + 1);
    return ["array", Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      requireValue(descriptor && "value" in descriptor);
      return typed(descriptor.value, depth + 1);
    })];
  }
  requireValue(value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const keys = Object.keys(value).sort();
  requireValue(Reflect.ownKeys(value).length === keys.length);
  return ["record", keys.map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireValue(descriptor && "value" in descriptor);
    return [key, typed(descriptor.value, depth + 1)];
  })];
}
function detached<T>(value: T): T {
  if (Buffer.isBuffer(value)) return Buffer.from(value) as T;
  if (Array.isArray(value)) return Object.freeze(value.map(entry => detached(entry))) as T;
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, detached(entry)]))) as T;
  return value;
}
function stableMaterial(value: unknown): unknown {
  if (Buffer.isBuffer(value) || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(entry => stableMaterial(entry));
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "calls" && !key.endsWith("Calls"))
    .map(([key, entry]) => [key, stableMaterial(entry)]));
}
interface ParsedStatx {
  readonly mask: bigint; readonly id: bigint; readonly devMajor: bigint; readonly devMinor: bigint;
  readonly ino: bigint; readonly mode: bigint; readonly uid: bigint; readonly gid: bigint; readonly nlink: bigint; readonly size: bigint;
  readonly atimeNs: bigint; readonly mtimeNs: bigint; readonly ctimeNs: bigint; readonly birthtimeNs: bigint;
  readonly attributes: bigint; readonly attributesMask: bigint;
}
function parseStatx(raw: Buffer, unique: boolean, metadata: SourceFileExtendedMetadata): ParsedStatx {
  requireValue(raw.length === 256, "source-file-statx-abi");
  const mask = BigInt(raw.readUInt32LE(0)), flag = unique ? 0x4000n : 0x1000n;
  requireValue((mask & (0x7ffn | 0x800n | flag)) === (0x7ffn | 0x800n | flag), "source-file-statx-mask");
  function time(offset: number): bigint {
    const seconds = raw.readBigInt64LE(offset), nanos = BigInt(raw.readUInt32LE(offset + 8));
    requireValue(nanos <= 999999999n && raw.readUInt32LE(offset + 12) === 0, "source-file-statx-time");
    return seconds * 1000000000n + nanos;
  }
  const row = { mask, id: raw.readBigUInt64LE(144), devMajor: BigInt(raw.readUInt32LE(136)), devMinor: BigInt(raw.readUInt32LE(140)),
    ino: raw.readBigUInt64LE(32), mode: BigInt(raw.readUInt16LE(28)), uid: BigInt(raw.readUInt32LE(20)), gid: BigInt(raw.readUInt32LE(24)),
    nlink: BigInt(raw.readUInt32LE(16)), size: raw.readBigUInt64LE(40), atimeNs: time(64), birthtimeNs: time(80), ctimeNs: time(96), mtimeNs: time(112),
    attributes: raw.readBigUInt64LE(8), attributesMask: raw.readBigUInt64LE(56) };
  requireValue(row.id > 0n && (row.attributes & ~row.attributesMask) === 0n, "source-file-statx-identity");
  requireSame(encodedDevice(row.devMajor, row.devMinor) === metadata.dev
    && (["ino", "mode", "uid", "gid", "nlink", "size", "atimeNs", "mtimeNs", "ctimeNs"] as const).every(key => row[key] === metadata[key]));
  return Object.freeze(row);
}
function parseMount(raw: { readonly request: Buffer; readonly result: Buffer }, legacy: ParsedStatx, unique: ParsedStatx): SourceFileMountBinding {
  const request = raw.request, data = raw.result;
  requireValue(request.length === 32 && request.readUInt32LE(0) === 32 && request.readUInt32LE(4) === 0
    && request.readBigUInt64LE(8) === unique.id && request.readBigUInt64LE(16) === 59n && request.readBigUInt64LE(24) === 0n,
  "source-file-statmount-request");
  requireValue(data.length >= 512 && data.length <= 16384 && data.readUInt32LE(0) === data.length
    && data.readUInt32LE(4) === 0 && data.readBigUInt64LE(8) === 59n, "source-file-statmount-abi");
  function string(offset: number): string {
    const start = 512 + data.readUInt32LE(offset);
    requireValue(start >= 512 && start < data.length, "source-file-statmount-string");
    const end = data.indexOf(0, start); requireValue(end >= start, "source-file-statmount-string");
    return text(data.subarray(start, end));
  }
  const type = string(36), root = string(104), point = string(108);
  const binding = { legacyMountId: BigInt(data.readUInt32LE(56)), uniqueMountId: data.readBigUInt64LE(40),
    devMajor: BigInt(data.readUInt32LE(16)), devMinor: BigInt(data.readUInt32LE(20)), filesystemType: "ext4" as const, root, point,
    attributes: data.readBigUInt64LE(64), superblockFlags: BigInt(data.readUInt32LE(32)), propagation: data.readBigUInt64LE(72) };
  requireValue(type === "ext4" && data.readBigUInt64LE(24) === 0xef53n && root === "/" && point.startsWith("/")
    && binding.attributes === 0n && (binding.superblockFlags & 1n) === 0n && binding.propagation === 0x40000n,
  "source-file-native-ext4-view");
  requireSame(binding.legacyMountId === legacy.id && binding.uniqueMountId === unique.id
    && binding.devMajor === unique.devMajor && binding.devMinor === unique.devMinor
    && legacy.devMajor === unique.devMajor && legacy.devMinor === unique.devMinor);
  return Object.freeze(binding);
}
function selectedMountinfo(raw: Buffer, mount: SourceFileMountBinding): unknown {
  requireValue(raw.length <= 1048576 && raw.at(-1) === 10, "source-file-mountinfo-bound");
  const lines = text(raw).slice(0, -1).split("\n");
  requireValue(lines.length <= 4096 && lines.every(line => line.length > 0 && Buffer.byteLength(line) <= 16384));
  const seen = new Set<string>();
  const rows = lines.map(line => {
    const parts = line.split(" - "); requireValue(parts.length === 2, "source-file-mountinfo-row");
    const left = parts[0]!.split(" "), right = parts[1]!.split(" ");
    requireValue(left.length >= 6 && right.length === 3 && [...left, ...right].every(part => part.length > 0));
    const id = decimal(left[0]!, 0xffffffffn), parent = decimal(left[1]!, 0xffffffffn);
    requireValue(id > 0n && !seen.has(String(id))); seen.add(String(id));
    const device = /^([0-9]+):([0-9]+)$/.exec(left[2]!); requireValue(device);
    const major = decimal(device[1]!, 0xffffffffn), minor = decimal(device[2]!, 0xffffffffn);
    function unescape(value: string): string {
      requireValue(!/\\(?!040|011|012|134)/.test(value), "source-file-mountinfo-escape");
      const decoded = value.replace(/\\(040|011|012|134)/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
      requireValue(decoded.startsWith("/") && !decoded.includes("\0")); return decoded;
    }
    return { id, parent, major, minor, root: unescape(left[3]!), point: unescape(left[4]!),
      options: left[5]!.split(","), optional: left.slice(6), filesystemType: right[0]!, source: right[1]!, superOptions: right[2]!.split(",") };
  });
  const selected = rows.filter(row => row.id === mount.legacyMountId); requireValue(selected.length === 1, "source-file-current-mount");
  const row = selected[0]!;
  requireSame(row.major === mount.devMajor && row.minor === mount.devMinor && row.root === mount.root
    && row.point === mount.point && row.filesystemType === mount.filesystemType);
  requireValue(row.optional.length === 0 && row.options.includes("rw") && !row.options.includes("ro")
    && row.superOptions.includes("rw") && !row.superOptions.includes("ro"), "source-file-current-mount-options");
  return row;
}
function ordinaryProcess(environment: SourceFileRootEnvironment): unknown {
  const identity = observed(environment.process.identity), status = text(observed(environment.process.threadStatus).bytes);
  const fields = new Map<string, string>();
  requireValue(status.endsWith("\n"));
  for (const line of status.slice(0, -1).split("\n")) {
    const split = line.indexOf(":"); requireValue(split > 0 && !fields.has(line.slice(0, split)));
    fields.set(line.slice(0, split), line.slice(split + 1).trim());
  }
  function tuple(name: string): readonly bigint[] {
    const value = fields.get(name); requireValue(value !== undefined);
    const result = value.split(/\s+/).map(part => decimal(part, 0xffffffffn)); requireValue(result.length === 4); return result;
  }
  const uid = tuple("Uid"), gid = tuple("Gid"), groupsText = fields.get("Groups"); requireValue(groupsText !== undefined);
  const groups = groupsText ? groupsText.split(/\s+/).map(value => decimal(value, 0xffffffffn)) : [];
  requireSame(uid.every((id, index) => id === identity.uid[index]) && gid.every((id, index) => id === identity.gid[index])
    && canonicalJson(typed(groups)) === canonicalJson(typed(identity.groups))
    && decimal(fields.get("Tgid") ?? "") === identity.pid && decimal(fields.get("Pid") ?? "") === identity.tid
    && decimal(fields.get("NoNewPrivs") ?? "") === identity.noNewPrivileges);
  requireValue(uid[0]! > 0n && gid[0]! > 0n && uid.every(id => id === uid[0]) && gid.every(id => id === gid[0])
    && groups.length === 0 && identity.noNewPrivileges === 1n, "source-file-ordinary-process");
  const capabilities: Record<string, string> = {};
  for (const name of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) {
    const value = fields.get(name); requireValue(value !== undefined && /^[0-9a-fA-F]{1,16}$/.test(value));
    requireValue(BigInt("0x" + value) === 0n, "source-file-ordinary-capabilities"); capabilities[name] = value;
  }
  const stat = text(observed(environment.process.processStat).bytes);
  const opening = stat.indexOf(" ("), closing = stat.lastIndexOf(") ");
  requireValue(opening > 0 && closing > opening && stat.endsWith("\n"));
  requireSame(decimal(stat.slice(0, opening)) === identity.pid);
  const rest = stat.slice(closing + 2).trimEnd().split(" "); requireValue(rest.length >= 20 && /^[A-Za-z]$/.test(rest[0]!));
  const startTicks = decimal(rest[19]!); requireValue(startTicks > 0n, "source-file-process-lifetime");
  return { identity, capabilities, startTicks, namespaces: observed(environment.process.namespaces) };
}
function parseOptions(raw: Buffer): Readonly<Record<string, string | true>> {
  requireValue(raw.length <= 16384 && raw.every(byte => byte < 128), "source-file-effective-options");
  const value = text(raw), lines = value.split("\n");
  requireValue(lines.length <= 257 && lines.every(line => line.length <= 1024));
  const result: Record<string, string | true> = Object.create(null) as Record<string, string | true>;
  for (const token of value.replace(/\n$/, "").split(/[,\n]/)) {
    requireValue(/^[A-Za-z0-9_.-]+(?:=[A-Za-z0-9_.:-]+)?$/.test(token), "source-file-effective-options");
    const split = token.indexOf("="), name = split < 0 ? token : token.slice(0, split);
    requireValue(!Object.hasOwn(result, name), "source-file-effective-options-duplicate");
    result[name] = split < 0 ? true : token.slice(split + 1);
  }
  return Object.freeze(result);
}
function kernelMaterial(environment: SourceFileRootEnvironment): unknown {
  const raw = observed(environment.kernel.uname); requireValue(raw.length === 390);
  const names = ["sysname", "nodename", "release", "version", "machine", "domainname"] as const;
  const fields: Record<string, string> = {};
  names.forEach((name, index) => {
    const field = raw.subarray(index * 65, (index + 1) * 65), end = field.indexOf(0);
    requireValue(end > 0 && field.subarray(end).every(byte => byte === 0), "source-file-uname-abi");
    fields[name] = text(field.subarray(0, end));
  });
  requireValue(fields.sysname === "Linux" && fields.machine === "x86_64", "source-file-kernel-abi");
  // An actual note blob and uname are still not a vendor build/source/config mapping.
  return { sysname: fields.sysname, release: fields.release, version: fields.version, machine: fields.machine,
    notes: observed(environment.kernel.notes).bytes, config: environment.kernel.config };
}
function boundHealth(environment: SourceFileRootEnvironment, mount: SourceFileMountBinding): Readonly<Record<SourceFileHealthName, SourceFileKernelRead>> {
  const device = observed(environment.device.binding), health = observed(environment.health.binding);
  requireSame(device.sourceDevMajor === mount.devMajor && device.sourceDevMinor === mount.devMinor
    && health.sourceDevMajor === mount.devMajor && health.sourceDevMinor === mount.devMinor
    && canonicalJson(typed(device.sysfs)) === canonicalJson(typed(health.device)) && device.sbId.equals(health.sbId));
  requireValue(device.kernelName.equals(device.sbId), "source-file-health-name");
  const dev = observed(environment.device.dev), uevent = text(observed(environment.device.uevent).bytes).split("\n");
  requireSame(dev.bytes.equals(Buffer.from(`${mount.devMajor}:${mount.devMinor}\n`))
    && uevent.filter(line => line.startsWith("DEVNAME=")).length === 1 && uevent.includes(`DEVNAME=${device.kernelName.toString("ascii")}`));
  const graph = observed(environment.device.topology), first = graph.nodes[0]!;
  requireSame(first.major === mount.devMajor && first.minor === mount.devMinor && first.kernelName.equals(device.kernelName)
    && first.resolved.equals(device.resolved) && canonicalJson(typed(first.identity)) === canonicalJson(typed(device.sysfs))
    && canonicalJson(typed(first.dev)) === canonicalJson(typed(environment.device.dev))
    && canonicalJson(typed(first.uevent)) === canonicalJson(typed(environment.device.uevent)));
  requireValue(environment.health.fields.length === SOURCE_FILE_HEALTH_NAMES.length);
  return Object.freeze(Object.fromEntries(environment.health.fields.map((field, index) => {
    requireValue(field.name === SOURCE_FILE_HEALTH_NAMES[index]);
    const value = observed(field.fact), expected = index >= 11 ? "\n" : "0\n";
    requireValue(value.filesystemType === 0x62656572n && value.device === health.health.device && value.bytes.equals(Buffer.from(expected)),
      "source-file-visible-health-error");
    return [field.name, Object.freeze({ ...value, bytes: Buffer.from(value.bytes), calls: field.fact.calls })];
  }))) as Readonly<Record<SourceFileHealthName, SourceFileKernelRead>>;
}
interface EnvironmentAnalysis {
  readonly mount: SourceFileMountBinding;
  readonly health: Readonly<Record<SourceFileHealthName, SourceFileKernelRead>>;
  readonly configuration: unknown;
  readonly contextBinding: string;
  readonly windowBinding: string;
  readonly unresolved: readonly string[];
}
function analyzeEnvironment(context: SourceFileRootContext | SourceFileBootstrapContext): EnvironmentAnalysis {
  const environment = context.environment, metadata = context.info.metadata;
  requireValue(metadata.fsType === 0xef53n, "source-file-native-ext4");
  const ordinary = ordinaryProcess(environment), kernel = kernelMaterial(environment);
  const legacy = parseStatx(observed(environment.mount.legacyStatx), false, metadata);
  const unique = parseStatx(observed(environment.mount.uniqueStatx), true, metadata);
  requireSame(legacy.birthtimeNs === unique.birthtimeNs && legacy.attributes === unique.attributes && legacy.attributesMask === unique.attributesMask);
  const mount = parseMount(observed(environment.mount.statmount), legacy, unique);
  const mountinfo = selectedMountinfo(observed(environment.mount.mountinfo).bytes, mount);
  const tune = observed(environment.configuration.tune); requireValue(tune.length === 232);
  // SET capabilities/default_mnt_opts remain raw. They are not GET-valid bits
  // or a substitute for the complete current effective configuration.
  const options = parseOptions(observed(environment.configuration.options).bytes);
  const before = text(observed(environment.configuration.journalTaskBefore).bytes);
  const after = text(observed(environment.configuration.journalTaskAfter).bytes);
  requireValue(/^[1-9][0-9]*\n$/.test(before) && /^[1-9][0-9]*\n$/.test(after), "source-file-journal-task");
  const journal = observed(environment.configuration.journalIoprio);
  requireSame(before === after && journal.which === 1n && journal.who === decimal(before.slice(0, -1), 0x7fffffffn));
  const mbGroups = observed(environment.configuration.mbGroups).bytes;
  requireValue(mbGroups.length <= 16384 && !mbGroups.includes(0), "source-file-mb-groups");
  const health = boundHealth(environment, mount);
  requireValue(environment.auxiliaryCalls.every(call => !call.operation.startsWith("close-") || call.rc === null || call.rc === 0n),
    "source-file-auxiliary-close");
  const identity = observed(environment.process.identity);
  requireValue(metadata.uid === identity.uid[0] && metadata.gid === identity.gid[0] && (metadata.mode & 0o22n) === 0n
    && (metadata.kind === "directory" || metadata.nlink === 1n), "source-file-private-owner");
  let anchor: unknown = metadata;
  if ("root" in context) {
    const root = context.root;
    requireValue(root.uuid.status === "observed" && root.fid.status === "observed" && root.inodeFlags.status === "observed" && root.xattrs.status === "observed",
      "source-file-extended-facts");
    requireValue(root.uuid.value.length === 16n && root.uuid.value.bytes.length === 16 && root.uuid.value.bytes.some(byte => byte !== 0)
      && root.fid.value.handleType === 1n && root.fid.value.handleBytes === 8n && root.fid.value.bytes.length === 8,
    "source-file-extended-shape");
    requireSame(root.fid.value.mountId === unique.id && context.uniqueStatx.uniqueMountId === unique.id
      && context.legacyStatx.mountId === legacy.id && context.uniqueStatx.ino === metadata.ino
      && context.legacyStatx.ino === metadata.ino);
    requireValue((unique.attributesMask & 0x200000n) !== 0n && (unique.attributes & 0x200000n) === 0n
      && (metadata.kind === "directory" ? root.inodeFlags.value === 0x80000n || root.inodeFlags.value === 0x81000n : root.inodeFlags.value === 0x80000n),
    "source-file-inode-attributes");
    anchor = { metadata, uuid: root.uuid.value, fid: root.fid.value, flags: root.inodeFlags.value, xattrs: root.xattrs.value,
      birthtimeNs: unique.birthtimeNs, attributes: unique.attributes, attributesMask: unique.attributesMask };
  }
  const configuration = { kernel, tune, options, mbGroups, journalIoprio: journal.rawValue,
    mount: { filesystemType: mount.filesystemType, root: mount.root, attributes: mount.attributes,
      superblockFlags: mount.superblockFlags, propagation: mount.propagation },
    unresolved: UNPROVEN };
  const contextMaterial = stableMaterial({ metadata, ordinary, mount, mountinfo, configuration,
    device: observed(environment.device.binding), topology: observed(environment.device.topology),
    health: observed(environment.health.binding), healthValues: health });
  const contextBinding = canonicalJson(typed(contextMaterial)), windowBinding = canonicalJson(typed({ contextMaterial, anchor }));
  return Object.freeze({ mount, health, configuration: typed(configuration), contextBinding, windowBinding, unresolved: UNPROVEN });
}
function selectEntry(context: SourceFileRootContext | SourceFileBootstrapContext): { readonly entry: FixedProfileEntry; readonly analysis: EnvironmentAnalysis } {
  requireValue(FIXED_PROFILES.length > 0, "source-file-profile-unqualified");
  const analysis = analyzeEnvironment(context);
  requireValue(analysis.unresolved.length === 0, "source-file-full-configuration-unproven");
  const matches = FIXED_PROFILES.filter(entry => entry.profile === PROFILE
    && canonicalJson(entry.requiredConfiguration) === canonicalJson(analysis.configuration));
  requireValue(matches.length === 1, "source-file-profile-match-count");
  const entry = matches[0]!;
  // Canonical whole materials, never a caller's or entry author's asserted hash.
  canonicalJson(entry.profileEvidence); canonicalJson(entry.qualificationEvidence);
  return { entry, analysis };
}
interface ProfileState {
  readonly root: SourceFileHandle;
  readonly entry: FixedProfileEntry;
  readonly baseline: string;
  readonly profileEntryDigest: string;
  readonly qualificationDigest: string;
  failed: boolean;
  failure: unknown;
}
const contexts = new WeakMap<object, ProfileState>();
const profilesByRoot = new WeakMap<object, QualifiedSourceFileProfile>();
const failedRoots = new WeakMap<object, unknown>();
function failure(error: unknown): unknown {
  if (error instanceof MaintenanceFailure) return error;
  const native = error && typeof error === "object" ? error as { code?: unknown } : undefined;
  const result = native?.code === "ERR_SOURCE_HANDLE" ? new MaintenanceFailure("maintenance_lost", "source-file-owner")
    : native?.code === "ERR_SOURCE_IDENTITY" ? changed() : unavailable("source-file-native-context");
  Object.defineProperty(result, "cause", { value: error }); return result;
}
function observeWindow(profile: object, phase: "observe" | "before-content" | "after-content"): SourceFileRootObservation {
  const state = contexts.get(profile);
  if (!state) throw new MaintenanceFailure("maintenance_lost", "source-file-profile-owner");
  assertSourceFileRootActive(state.root);
  if (state.failed) throw state.failure;
  try {
    const current = observeSourceFileRootContext(state.root), selected = selectEntry(current);
    requireSame(selected.entry === state.entry && selected.analysis.windowBinding === state.baseline);
    return detached({ root: current.root, uniqueStatx: current.uniqueStatx, mount: selected.analysis.mount,
      health: selected.analysis.health, runtimeEnvironmentDigest: digestJson({ domain: "boardroom-source-file-runtime-context-v1", phase, material: typed(current) }) });
  } catch (error) {
    state.failed = true; state.failure = failure(error); failedRoots.set(state.root, state.failure); throw state.failure;
  }
}
class SourceProfile implements QualifiedSourceFileProfile {
  readonly profile = PROFILE;
  readonly source: SourceFileMetadata;
  readonly profileEntryDigest: string;
  readonly qualificationDigest: string;
  constructor(root: SourceFileHandle, context: SourceFileRootContext, entry: FixedProfileEntry, analysis: EnvironmentAnalysis) {
    const metadata = context.info.metadata;
    this.source = Object.freeze({ kind: metadata.kind, dev: metadata.dev, ino: metadata.ino, mode: metadata.mode, uid: metadata.uid,
      nlink: metadata.nlink, size: metadata.size, fsType: metadata.fsType, mtimeNs: metadata.mtimeNs, ctimeNs: metadata.ctimeNs });
    this.profileEntryDigest = digestJson({ profile: PROFILE, requiredConfiguration: entry.requiredConfiguration, evidence: entry.profileEvidence });
    this.qualificationDigest = digestJson({ profileEntryDigest: this.profileEntryDigest, evidence: entry.qualificationEvidence });
    contexts.set(this, { root, entry, baseline: analysis.windowBinding, profileEntryDigest: this.profileEntryDigest,
      qualificationDigest: this.qualificationDigest, failed: false, failure: undefined });
    Object.freeze(this);
  }
  observe(): SourceFileRootObservation { return observeWindow(this, "observe"); }
  beforeContent(): SourceFileRootObservation { return observeWindow(this, "before-content"); }
  afterContent(): SourceFileRootObservation { return observeWindow(this, "after-content"); }
}
Object.freeze(SourceProfile.prototype);
/** Package-internal fixed factory initialization. The token is minted only by
 * withNativeSourceRoot; no external proof can obtain or promote this owner. */
export function initializeSourceFileBootstrap(token: object): SourceFileHandle {
  try {
    const bootstrap = observeSourceFileBootstrap(token), initial = selectEntry(bootstrap);
    const root = promoteSourceFileBootstrap(token), current = observeSourceFileRootContext(root), selected = selectEntry(current);
    requireSame(initial.entry === selected.entry
      && initial.analysis.contextBinding === selected.analysis.contextBinding
      && canonicalJson(initial.analysis.configuration) === canonicalJson(selected.analysis.configuration));
    const profile = new SourceProfile(root, current, selected.entry, selected.analysis); profilesByRoot.set(root, profile);
    return root;
  } catch (error) { throw failure(error); }
}
/** The only public matcher input is a genuine live root. No observation,
 * callback, proof, registry, digest or success flag is accepted. */
export function matchSourceFileProfile(root: SourceFileHandle): QualifiedSourceFileProfile {
  assertSourceFileRootActive(root);
  if (failedRoots.has(root)) throw failedRoots.get(root);
  const existing = profilesByRoot.get(root);
  if (existing) { existing.observe(); return existing; }
  try {
    const context = observeSourceFileRootContext(root), selected = selectEntry(context);
    const profile = new SourceProfile(root, context, selected.entry, selected.analysis);
    profilesByRoot.set(root, profile); return profile;
  } catch (error) { const result = failure(error); failedRoots.set(root, result); throw result; }
}

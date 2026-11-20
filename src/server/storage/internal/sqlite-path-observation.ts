/** SQ-D02 I01：零参数、只读 pathname 观察。结果不是 P1/native/source-FD ownership 许可。 */
import Database from "better-sqlite3";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { assertEnvironmentSelected, assertSqliteSourceUnchanged, resolveBoardroomEnvironment,
  type SqliteDatabaseDescriptor } from "../../environment.ts";

type Code = "unsupported_platform" | "source_unavailable" | "source_selection_rejected" | "source_changed"
  | "component_invalid" | "component_changed" | "native_observation_failed" | "native_retirement_unknown";
class ObservationError extends Error {
  readonly code: Code;
  constructor(code: Code) { super("sqlite_path_observation: " + code); this.code = code; }
}
type OwnedFile = { readonly fd: number; readonly path: string; readonly stat: BigIntStats; readonly mutableSource: boolean;
  phase: "open" | "closed" | "unknown" };
type Owner = { readonly files: OwnedFile[]; readonly failures: { phase: string; error: unknown }[];
  db: Database.Database | null; dbPhase: "absent" | "open" | "closed" | "unknown" };
type Identity = { bytes: number; sha256: string };
type Observation = Readonly<{
  scope: "sqlite-main-path-observation/v1"; sourcePath: string; sqlitePath: string;
  pinIdentity: Readonly<{ device: string; inode: string }>;
  component: Readonly<{ binarySha256: string; manifestSha256: string }>;
  observations: Readonly<{ namedPinBefore: true; vfsMainPathUnmoved: true; namedPinAfter: true; schemaVersion: string }>;
  retirement: "closed";
}>;
const root = realpathSync(fileURLToPath(new URL("../../../../", import.meta.url)));
const component = path.join(root, "build", "maintenance-platform", "sqlite-path-check-linux-" + process.arch);
const flags = ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-shared", "-fPIC"] as const;
// Linux O_PATH is not exposed by Node fs.constants. External ancestors are
// metadata pins only; traversable directories need not permit directory reads.
const O_PATH = 0x200000;
// Unknown native close keeps its actual database/fd owner, even if a JS flag subsequently says closed.
// There is no caller acknowledgement, setter, retry-by-fd-number or exported assembly.
const pendingOwners = new Set<Owner>();
function fail(code: Code): never { throw new ObservationError(code); }
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join() !== [...keys].sort().join()) fail("component_invalid");
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0")) fail("component_invalid");
  return value;
}
function identity(value: unknown, maximum: number): Identity {
  const r = record(value, ["bytes", "sha256"]);
  if (typeof r.bytes !== "number" || !Number.isSafeInteger(r.bytes) || r.bytes < 1 || r.bytes > maximum
    || typeof r.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(r.sha256)) fail("component_invalid");
  return { bytes: r.bytes, sha256: r.sha256 };
}
function ownedFile(s: Owner, file: string, directory: boolean, mode?: number, mutableSource = false, searchOnly = false): OwnedFile {
  if (file.length > 4096 || s.files.length >= 64) fail("component_invalid");
  const before = lstatSync(file, { bigint: true });
  if ((directory ? !before.isDirectory() || before.nlink < 2n : !before.isFile() || before.nlink !== 1n)
    || mode !== undefined && (before.uid !== BigInt(process.getuid!()) || (before.mode & 0o7777n) !== BigInt(mode)))
    fail("component_invalid");
  const fd = openSync(file, (directory && searchOnly ? O_PATH : constants.O_RDONLY)
    | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0));
  const owner: OwnedFile = { fd, path: file, stat: before, mutableSource, phase: "open" };
  s.files.push(owner);
  const opened = fstatSync(fd, { bigint: true });
  if (!same(before, opened) || before.mode !== opened.mode || before.uid !== opened.uid || before.nlink !== opened.nlink
    || !directory && before.size !== opened.size) fail("component_changed");
  return owner;
}
function read(s: Owner, file: string, maximum: number, mode?: number): { bytes: Buffer; owner: OwnedFile } {
  const owner = ownedFile(s, file, false, mode);
  if (owner.stat.size < 1n || owner.stat.size > BigInt(maximum)) fail("component_invalid");
  // Size/type bound precedes the first payload allocation or native read.
  const bytes = Buffer.alloc(Number(owner.stat.size));
  let offset = 0;
  while (offset < bytes.length) {
    const n = readSync(owner.fd, bytes, offset, bytes.length - offset, offset);
    if (n === 0) fail("component_changed");
    offset += n;
  }
  const after = fstatSync(owner.fd, { bigint: true });
  if (after.size !== owner.stat.size || after.mtimeNs !== owner.stat.mtimeNs || after.ctimeNs !== owner.stat.ctimeNs)
    fail("component_changed");
  return { bytes, owner };
}
function json(bytes: Buffer): unknown {
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  if (!Buffer.from(JSON.stringify(parsed, null, 2) + "\n").equals(bytes)) fail("component_invalid");
  return parsed;
}
function expected(bytes: Buffer, id: Identity): void {
  if (bytes.length !== id.bytes || hash(bytes) !== id.sha256) fail("component_changed");
}
function pinDirectory(s: Owner, directory: string, mode?: number, searchOnly = false): OwnedFile {
  if (realpathSync(directory) !== directory) fail("component_changed");
  return ownedFile(s, directory, true, mode, false, searchOnly);
}
function componentInput(s: Owner): { binary: OwnedFile; binaryId: Identity; manifestId: Identity } {
  for (const directory of [path.join(root, "build"), path.join(root, "build", "maintenance-platform")]) {
    const pin = pinDirectory(s, directory);
    if (pin.stat.uid !== BigInt(process.getuid!()) || (pin.stat.mode & 0o022n) !== 0n) fail("component_invalid");
  }
  pinDirectory(s, component, 0o700); pinDirectory(s, path.join(component, "manifests"), 0o700);
  const current = record(json(read(s, path.join(component, "current.json"), 1024, 0o600).bytes), ["contract", "manifest"]);
  if (current.contract !== "sqlite-path-check-current/v1") fail("component_invalid");
  const manifestId = identity(current.manifest, 64 * 1024);
  const raw = read(s, path.join(component, "manifests", manifestId.sha256 + ".json"), 64 * 1024, 0o600).bytes;
  expected(raw, manifestId);
  const m = record(json(raw), ["contract", "platform", "architecture", "builder", "dependency", "sources",
    "compiler", "arguments", "environment", "buildDirectory", "binary"]);
  if (m.contract !== "sqlite-path-check-build/v1" || m.platform !== "linux" || m.architecture !== process.arch) fail("component_invalid");
  const stage = text(m.buildDirectory);
  if (path.dirname(stage) !== component || !/^\.build-[A-Za-z0-9]{6}$/.test(path.basename(stage))) fail("component_invalid");
  const args = [...flags, "-I", stage, path.join(stage, "extension.c"), "-o", path.join(stage, "result", "extension.so")];
  if (!Array.isArray(m.arguments) || JSON.stringify(m.arguments) !== JSON.stringify(args)) fail("component_invalid");
  const environment = record(m.environment, ["PATH", "LANG", "LC_ALL", "TMPDIR"]);
  if (environment.PATH !== "/usr/bin:/bin" || environment.LANG !== "C" || environment.LC_ALL !== "C" || environment.TMPDIR !== stage)
    fail("component_invalid");
  const compiler = record(m.compiler, ["path", "realPath", "bytes", "sha256", "version"]);
  if (compiler.path !== "/usr/bin/cc" || !path.isAbsolute(text(compiler.realPath))) fail("component_invalid");
  text(compiler.version, 16 * 1024); identity({ bytes: compiler.bytes, sha256: compiler.sha256 }, 32 * 1024 * 1024);
  expected(read(s, path.join(root, "scripts", "build-sqlite-path-check.mjs"), 128 * 1024).bytes, identity(m.builder, 128 * 1024));
  const dependency = path.dirname(createRequire(import.meta.url).resolve("better-sqlite3/package.json"));
  const dep = record(m.dependency, ["version", "package", "lock"]);
  const packageBytes = read(s, path.join(dependency, "package.json"), 64 * 1024).bytes;
  const lockBytes = read(s, path.join(root, "package-lock.json"), 2 * 1024 * 1024).bytes;
  expected(packageBytes, identity(dep.package, 64 * 1024)); expected(lockBytes, identity(dep.lock, 2 * 1024 * 1024));
  const pkg = JSON.parse(packageBytes.toString("utf8")) as { name?: unknown; version?: unknown };
  const lock = JSON.parse(lockBytes.toString("utf8")) as { packages?: Record<string, { version?: unknown }> };
  if (pkg.name !== "better-sqlite3" || pkg.version !== dep.version || pkg.version !== lock.packages?.["node_modules/better-sqlite3"]?.version)
    fail("component_invalid");
  const roles = ["extension", "sqlite3ext.h", "sqlite3.h"];
  const files = [path.join(root, "native", "maintenance-sqlite.c"), path.join(dependency, "deps", "sqlite3", "sqlite3ext.h"), path.join(dependency, "deps", "sqlite3", "sqlite3.h")];
  if (!Array.isArray(m.sources) || m.sources.length !== 3) fail("component_invalid");
  for (let i = 0; i < files.length; i++) {
    const source = record(m.sources[i], ["role", "bytes", "sha256"]), maximum = i === 0 ? 64 * 1024 : 2 * 1024 * 1024;
    if (source.role !== roles[i]) fail("component_invalid");
    expected(read(s, files[i]!, maximum).bytes, identity({ bytes: source.bytes, sha256: source.sha256 }, maximum));
  }
  const binaryId = identity(m.binary, 8 * 1024 * 1024), directory = path.join(component, binaryId.sha256);
  if (pinDirectory(s, directory, 0o700).stat.nlink !== 2n) fail("component_invalid");
  const binary = read(s, path.join(directory, "extension.so"), 8 * 1024 * 1024, 0o700);
  expected(binary.bytes, binaryId);
  if (binary.bytes.length < 64 || binary.bytes.readUInt32BE(0) !== 0x7f454c46 || binary.bytes[4] !== 2 || binary.bytes[5] !== 1
    || binary.bytes.readUInt16LE(16) !== 3 || binary.bytes.readUInt16LE(18) !== (process.arch === "x64" ? 62 : 183))
    fail("component_invalid");
  return { binary: binary.owner, binaryId, manifestId };
}
function pinnedUnchanged(s: Owner): void {
  for (const file of s.files) {
    if (file.phase !== "open") fail("native_retirement_unknown");
    const current = lstatSync(file.path, { bigint: true }), fd = fstatSync(file.fd, { bigint: true });
    if (!same(file.stat, current) || !same(file.stat, fd) || current.mode !== file.stat.mode || current.uid !== file.stat.uid
      || fd.mode !== file.stat.mode || fd.uid !== file.stat.uid || current.isSymbolicLink()
      || (file.stat.isFile() && (current.nlink !== 1n || fd.nlink !== 1n))
      || (!file.mutableSource && file.stat.isFile() && (fd.size !== file.stat.size
        || fd.mtimeNs !== file.stat.mtimeNs || fd.ctimeNs !== file.stat.ctimeNs))) fail("component_changed");
  }
}
function sourceUnchanged(source: SqliteDatabaseDescriptor, pin: OwnedFile): void {
  try {
    assertSqliteSourceUnchanged(source);
    const actual = fstatSync(pin.fd, { bigint: true });
    if (!actual.isFile() || actual.nlink !== 1n || String(actual.dev) !== source.identity?.device || String(actual.ino) !== source.identity.inode)
      fail("source_changed");
  } catch { fail("source_changed"); }
}
function retire(s: Owner): void {
  let unknown = false;
  if (s.db) {
    try { if (s.db.inTransaction) { s.db.exec("ROLLBACK"); if (s.db.inTransaction) throw new Error("rollback_not_terminal"); } }
    catch (error) { unknown = true; s.failures.push({ phase: "rollback", error }); }
    try { s.db.close(); if (s.db.open) throw new Error("close_not_terminal"); s.dbPhase = "closed"; }
    catch (error) { unknown = true; s.dbPhase = "unknown"; s.failures.push({ phase: "database-close", error }); }
  }
  // Until the database close is known terminal, its checked binary and source/directory
  // pins remain actual open descriptors owned by this retained state. Neither db.open
  // nor a thrown close result proves they may be retired or their fd numbers reused.
  if (s.dbPhase !== "unknown") for (const file of [...s.files].reverse()) {
    if (file.phase !== "open") { unknown = true; continue; }
    try { closeSync(file.fd); file.phase = "closed"; }
    catch (error) { unknown = true; file.phase = "unknown"; s.failures.push({ phase: "file-close", error }); }
  }
  if (unknown) fail("native_retirement_unknown");
  pendingOwners.delete(s);
}

export async function inspectSelectedSqlitePathBinding(): Promise<Observation> {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) fail("unsupported_platform");
  if (pendingOwners.size) fail("native_retirement_unknown");
  let source: SqliteDatabaseDescriptor;
  try {
    const environment = await resolveBoardroomEnvironment();
    assertEnvironmentSelected(environment);
    if (environment.databaseDescriptor.kind !== "sqlite" || !environment.databaseDescriptor.identity) fail("source_unavailable");
    source = environment.databaseDescriptor;
    if (source.sourcePath.length > 4096 || source.sqlitePath.length > 4096) fail("source_unavailable");
  } catch (error) {
    if (error instanceof ObservationError) throw error;
    fail("source_selection_rejected");
  }
  if (pendingOwners.size) fail("native_retirement_unknown");
  const s: Owner = { files: [], failures: [], db: null, dbPhase: "absent" };
  pendingOwners.add(s);
  let output: Observation | undefined, failure: unknown, failed = false;
  try {
    const built = componentInput(s);
    const sourceDirectory = path.dirname(source.sqlitePath);
    let directory = sourceDirectory;
    for (;;) {
      pinDirectory(s, directory, undefined, directory !== sourceDirectory);
      const parent = path.dirname(directory); if (parent === directory) break;
      directory = parent;
    }
    const pin = ownedFile(s, source.sqlitePath, false, undefined, true);
    sourceUnchanged(source, pin); pinnedUnchanged(s);
    s.db = new Database(source.sqlitePath, { readonly: true, fileMustExist: true, timeout: 0 }); s.dbPhase = "open";
    // Keep this exact checked binary fd until the SQLite handle is known closed; no fd-number reuse while loaded.
    s.db.loadExtension("/proc/self/fd/" + built.binary.fd);
    s.db.pragma("query_only = ON"); s.db.exec("BEGIN");
    sourceUnchanged(source, pin); pinnedUnchanged(s);
    const statement = s.db.prepare("SELECT boardroom_maintenance_source_unchanged() AS unchanged").safeIntegers();
    const checkNativePath = (): void => {
      let observed: unknown;
      try { observed = (statement.get() as { unchanged: unknown }).unchanged; }
      catch (error) { s.failures.push({ phase: "path-check", error }); fail("source_changed"); }
      if (observed !== 1n) fail("source_changed");
    };
    checkNativePath();
    const schema = s.db.prepare("PRAGMA main.schema_version").safeIntegers().get() as { schema_version: unknown };
    if (typeof schema.schema_version !== "bigint") fail("native_observation_failed");
    checkNativePath();
    sourceUnchanged(source, pin); pinnedUnchanged(s);
    s.db.exec("ROLLBACK"); if (s.db.inTransaction) fail("native_retirement_unknown");
    output = Object.freeze({ scope: "sqlite-main-path-observation/v1", sourcePath: source.sourcePath, sqlitePath: source.sqlitePath,
      pinIdentity: Object.freeze({ device: String(pin.stat.dev), inode: String(pin.stat.ino) }),
      component: Object.freeze({ binarySha256: built.binaryId.sha256, manifestSha256: built.manifestId.sha256 }),
      observations: Object.freeze({ namedPinBefore: true, vfsMainPathUnmoved: true, namedPinAfter: true, schemaVersion: String(schema.schema_version) }),
      retirement: "closed" });
  } catch (error) { failed = true; failure = error; s.failures.push({ phase: "observation", error }); }
  retire(s);
  if (failed) {
    if (failure instanceof ObservationError) throw failure;
    fail("native_observation_failed");
  }
  if (!output) fail("native_observation_failed");
  return output;
}

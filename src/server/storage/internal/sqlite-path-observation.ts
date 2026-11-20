/** SQ-D02 I01：零参数、只读 pathname 观察。结果不是 P1/native/source-FD ownership 许可。 */
import Database from "better-sqlite3";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { assertEnvironmentSelected, assertSqliteSourceUnchanged, resolveBoardroomEnvironment,
  type SqliteDatabaseDescriptor } from "../../environment.ts";
import { AUDIT_LIMITS, AuditRequest, parseAuditJsonText, type AuditCode } from "../../identity/internal/m2-audit-boundary.ts";
import { observeSqliteProfileAdmissionRaw, type SqliteProfileAdmissionObservation, type SqliteProfileRawCell,
  type SqliteProfileRawRow } from "../../identity/internal/sqlite-profile-admission-values.ts";
import { SQLITE_PROFILE_READ_TABLES, SQLITE_PROFILE_FIXED_QUERIES, SQLITE_PROFILE_COLUMN_QUERIES,
  type SqliteProfileFixedQuery, type SqliteProfileReadTable } from "./sqlite-profile-read-source.ts";

type Code = "unsupported_platform" | "source_unavailable" | "source_selection_rejected" | "source_changed"
  | "component_invalid" | "component_changed" | "native_observation_failed" | "native_retirement_unknown" | AuditCode;
const observationFailures = new WeakMap<object, Code>();
class ObservationError extends Error {
  readonly code: Code;
  constructor(code: Code) { super("sqlite_path_observation: " + code); this.code = code; observationFailures.set(this, code); }
}
type OwnedFile = { readonly fd: number; readonly path: string; readonly stat: BigIntStats; readonly mutableSource: boolean;
  phase: "open" | "closed" | "unknown" };
type Owner = { readonly files: OwnedFile[]; readonly failures: { phase: string; error: unknown }[];
  readonly request: AuditRequest | null; readBytes: number;
  db: Database.Database | null; dbPhase: "absent" | "open" | "closed" | "unknown" };
type Identity = { bytes: number; sha256: string };
type Observation = Readonly<{
  scope: "sqlite-main-path-observation/v1"; sourcePath: string; sqlitePath: string;
  pinIdentity: Readonly<{ device: string; inode: string }>;
  component: Readonly<{ binarySha256: string; manifestSha256: string }>;
  observations: Readonly<{ namedPinBefore: true; vfsMainPathUnmoved: true; namedPinAfter: true; schemaVersion: string }>;
  retirement: "closed";
}>;
type ProfileObservation = Readonly<{ scope: "sqlite-selected-profile-observation/v1";
  pathObservation: Observation; observation: ReturnType<typeof observeSqliteProfileAdmissionRaw>;
  sourceFileDescriptorQualification: "not_qualified"; retirement: "closed" }>;
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
function knownFailure(error: unknown): Code | undefined {
  return error !== null && (typeof error === "object" || typeof error === "function") ? observationFailures.get(error) : undefined;
}
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
  if (s.request) {
    const bytes = Number(owner.stat.size);
    if (bytes > AUDIT_LIMITS.raw || (s.readBytes += bytes) > AUDIT_LIMITS.rawTotal) s.request.fail("resource_limit");
    s.request.text(bytes, 2); // Buffer allocation and native read copy, before either producer.
    s.request.allocateNodes(2);
  }
  // Size/type bound precedes the first payload allocation or native read.
  const bytes = Buffer.alloc(Number(owner.stat.size));
  let offset = 0;
  while (offset < bytes.length) {
    s.request?.units(1);
    const n = readSync(owner.fd, bytes, offset, bytes.length - offset, offset);
    if (n === 0) fail("component_changed");
    offset += n;
  }
  const after = fstatSync(owner.fd, { bigint: true });
  if (after.size !== owner.stat.size || after.mtimeNs !== owner.stat.mtimeNs || after.ctimeNs !== owner.stat.ctimeNs)
    fail("component_changed");
  return { bytes, owner };
}
function parsedJson(bytes: Buffer, request: AuditRequest | null): unknown {
  request?.text(bytes.length, 3); // UTF-8 input read and at most 2n UTF-16 result allocation, before decoding.
  const text = bytes.toString("utf8");
  return request ? parseAuditJsonText(text, request) : JSON.parse(text) as unknown;
}
function json(bytes: Buffer, request: AuditRequest | null): unknown {
  const parsed: unknown = parsedJson(bytes, request);
  // The scanner above bounds depth before pretty serialization. Spaces per value are at most 2*depth.
  request?.text(bytes.length * (AUDIT_LIMITS.depth * 2 + 3), 3); // Pretty string, UTF-8 buffer, byte comparison.
  if (!Buffer.from(JSON.stringify(parsed, null, 2) + "\n").equals(bytes)) fail("component_invalid");
  return parsed;
}
function expected(bytes: Buffer, id: Identity, request: AuditRequest | null): void {
  request?.text(bytes.length); request?.text(96); request?.allocateNodes(1); // Hash input, digest bytes/hex, hash owner.
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
  const current = record(json(read(s, path.join(component, "current.json"), 1024, 0o600).bytes, s.request), ["contract", "manifest"]);
  if (current.contract !== "sqlite-path-check-current/v1") fail("component_invalid");
  const manifestId = identity(current.manifest, 64 * 1024);
  const raw = read(s, path.join(component, "manifests", manifestId.sha256 + ".json"), 64 * 1024, 0o600).bytes;
  expected(raw, manifestId, s.request);
  const m = record(json(raw, s.request), ["contract", "platform", "architecture", "builder", "dependency", "sources",
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
  expected(read(s, path.join(root, "scripts", "build-sqlite-path-check.mjs"), 128 * 1024).bytes, identity(m.builder, 128 * 1024), s.request);
  const dependency = path.dirname(createRequire(import.meta.url).resolve("better-sqlite3/package.json"));
  const dep = record(m.dependency, ["version", "package", "lock"]);
  const packageBytes = read(s, path.join(dependency, "package.json"), 64 * 1024).bytes;
  const lockBytes = read(s, path.join(root, "package-lock.json"), 2 * 1024 * 1024).bytes;
  expected(packageBytes, identity(dep.package, 64 * 1024), s.request); expected(lockBytes, identity(dep.lock, 2 * 1024 * 1024), s.request);
  const pkg = parsedJson(packageBytes, s.request) as { name?: unknown; version?: unknown };
  const lock = parsedJson(lockBytes, s.request) as { packages?: Record<string, { version?: unknown }> };
  if (pkg.name !== "better-sqlite3" || pkg.version !== dep.version || pkg.version !== lock.packages?.["node_modules/better-sqlite3"]?.version)
    fail("component_invalid");
  const roles = ["extension", "sqlite3ext.h", "sqlite3.h"];
  const files = [path.join(root, "native", "maintenance-sqlite.c"), path.join(dependency, "deps", "sqlite3", "sqlite3ext.h"), path.join(dependency, "deps", "sqlite3", "sqlite3.h")];
  if (!Array.isArray(m.sources) || m.sources.length !== 3) fail("component_invalid");
  for (let i = 0; i < files.length; i++) {
    const source = record(m.sources[i], ["role", "bytes", "sha256"]), maximum = i === 0 ? 64 * 1024 : 2 * 1024 * 1024;
    if (source.role !== roles[i]) fail("component_invalid");
    expected(read(s, files[i]!, maximum).bytes, identity({ bytes: source.bytes, sha256: source.sha256 }, maximum), s.request);
  }
  const binaryId = identity(m.binary, 8 * 1024 * 1024), directory = path.join(component, binaryId.sha256);
  if (pinDirectory(s, directory, 0o700).stat.nlink !== 2n) fail("component_invalid");
  const binary = read(s, path.join(directory, "extension.so"), 8 * 1024 * 1024, 0o700);
  expected(binary.bytes, binaryId, s.request);
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

const fixedQueries = new Map([...SQLITE_PROFILE_FIXED_QUERIES, ...SQLITE_PROFILE_COLUMN_QUERIES].map(query => [query.id, query]));
function fixed(id: string): SqliteProfileFixedQuery {
  const query = fixedQueries.get(id); if (!query) fail("component_invalid"); return query;
}
function prepareRead(s: Owner, query: SqliteProfileFixedQuery): Database.Statement {
  const r = s.request!;
  r.text(query.bytes, 2); r.allocateNodes(1); r.units(1); // Fixed SQL scan/native prepare and statement owner.
  return s.db!.prepare(query.sql).safeIntegers(true);
}
function metadataCost(table: SqliteProfileReadTable, r: AuditRequest): void {
  const count = table.columns.length;
  r.allocateNodes(2 + (1 + 2 * count) * 2); // Native result wrapper, row and fixed key/scalar slots; also the final empty get.
  r.text(20 + count * (7 + 20 + 6), 2); // int64 rowid, typeof<=7, int64 length<=20 and fixed tN/nN keys, native/JS copies.
  r.units(1);
}
function readProfile(s: Owner): ReturnType<typeof observeSqliteProfileAdmissionRaw> {
  const r: AuditRequest = s.request!;
  r.allocateNodes(2); r.text(32, 2); r.units(1);
  const encoded = prepareRead(s, fixed("Q-ENCODING")).get() as { encoding?: unknown } | undefined;
  r.require(encoded?.encoding === "UTF-8" || encoded?.encoding === "UTF-16le" || encoded?.encoding === "UTF-16be", "source_contract_mismatch");
  r.allocateNodes(1 + SQLITE_PROFILE_READ_TABLES.length * 4 + 58);
  const columns = Object.create(null) as Record<string, string[]>;
  const parts = Object.create(null) as Record<string, { rows: SqliteProfileRawRow[] }>;
  for (const table of SQLITE_PROFILE_READ_TABLES) {
    // Direct octet_length first: arbitrary schema SQL/column names never cross into a JS payload result.
    r.allocateNodes(5); r.text(7 + 20, 2); r.units(1);
    const schema = prepareRead(s, fixed(`Q-COLUMN-METADATA-${table.table}`)).get() as { storage?: unknown; bytes?: unknown } | undefined;
    r.require(schema?.storage === "text" && typeof schema.bytes === "bigint" && schema.bytes > 0n, "source_contract_mismatch");
    r.require(schema.bytes <= BigInt(AUDIT_LIMITS.raw), "resource_limit");
    const schemaBytes = Number(schema.bytes), count = table.columns.length;
    r.require((s.readBytes += schemaBytes) <= AUDIT_LIMITS.rawTotal, "resource_limit");
    // Each pragma field is derived from bounded schema SQL. Reserve copies plus worst-case fixed-directory comparisons.
    r.text(schemaBytes, 2); r.text(schemaBytes * (count + 1));
    // The pragma can internally build the complete declared directory before SQL LIMIT.
    // Reserve from schema bytes (an upper bound on declared column count), not just returned rows.
    r.allocateNodes(schemaBytes * 7 + 3); r.units((count + 1) * count + 1);
    const directory = prepareRead(s, fixed(`Q-COLUMNS-${table.table}`)).get() as { matches?: unknown } | undefined;
    r.require(directory?.matches === 1n, "source_contract_mismatch");
    columns[table.table] = table.columns.map(column => column.name);
    const rows: SqliteProfileRawRow[] = []; parts[table.inputKey] = { rows };
    const first = prepareRead(s, fixed(`Q-META-FIRST-${table.table}`));
    const next = prepareRead(s, fixed(`Q-META-NEXT-${table.table}`));
    const values = prepareRead(s, fixed(`Q-VALUE-${table.table}`));
    let previous: bigint | null = null;
    for (;;) {
      metadataCost(table, r);
      const metadata = (previous === null ? first.get() : next.get(previous)) as Record<string, unknown> | undefined;
      if (metadata === undefined) break;
      r.require(typeof metadata._rowid === "bigint" && metadata._rowid >= -9223372036854775808n
        && metadata._rowid <= 9223372036854775807n && (previous === null || metadata._rowid > previous), "source_contract_mismatch");
      r.rowCount(1); r.allocateNodes(3 + count * 5); // Row/cells, typed tuples, scalars and bounded native result slots.
      for (let index = 0; index < count; index++) {
        const column = table.columns[index]!, storage = metadata[`t${index}`], bytes = metadata[`n${index}`];
        const expected = column.type === "INTEGER" || column.type === "BIGINT" ? "integer" : "text";
        r.require(storage === expected || storage === "null" && column.notnull === 0, "source_contract_mismatch");
        if (storage === "null") { r.require(bytes === null, "source_contract_mismatch"); continue; }
        r.require(typeof bytes === "bigint" && bytes >= 0n, "source_contract_mismatch");
        if (storage === "text") {
          r.require(bytes <= BigInt(AUDIT_LIMITS.field), "resource_limit");
          const n = Number(bytes);
          r.require((s.readBytes += n) <= AUDIT_LIMITS.rawTotal, "resource_limit");
          r.text(n, 2); // SQLite CAST: source read + BLOB copy.
          r.text(n); r.text(n * 2); // hex: source read + 2n output.
          r.text(n * 2, 2); // lower: 2n read + 2n output.
          r.text(n * 2, 2); // Native-to-JS hex: 2n read + 2n JS result.
        } else r.text(20, 3); // Native int64 carrier, decimal conversion and detached decimal string.
      }
      r.units(1); r.text(20, 2);
      // Only this same-T metadata rowid can select values, after every cell producer was prepaid.
      const raw = values.get(metadata._rowid) as Record<string, unknown> | undefined;
      r.require(raw?._rowid === metadata._rowid, "source_contract_mismatch");
      const cells: SqliteProfileRawCell[] = [];
      for (let index = 0; index < count; index++) {
        const storage = metadata[`t${index}`], value = raw[`v${index}`];
        if (storage === "null") { r.require(value === null, "source_contract_mismatch"); cells.push(["null"]); }
        else if (storage === "integer") {
          r.require(typeof value === "bigint", "source_contract_mismatch"); cells.push(["integer", String(value)]);
        } else {
          r.require(typeof value === "string" && value.length === Number(metadata[`n${index}`]) * 2, "source_contract_mismatch");
          cells.push(["text", value]);
        }
      }
      rows.push({ rowid: String(metadata._rowid), cells }); previous = metadata._rowid;
    }
  }
  r.allocateNodes(10);
  const input = { contract: "sqlite-profile-admission-observation/r1", sourceKind: "sqlite",
    textEncoding: { backend: "sqlite", name: encoded.encoding }, columns,
    control: parts.control, authority: parts.authority, activationReceipts: parts.activationReceipts,
    migrations: parts.migrations, clients: parts.clients } as unknown as SqliteProfileAdmissionObservation;
  return observeSqliteProfileAdmissionRaw(input, r);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

async function inspectSelected(kind: "path" | "profile"): Promise<Observation | ProfileObservation> {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) fail("unsupported_platform");
  if (pendingOwners.size) fail("native_retirement_unknown");
  const request = kind === "profile" ? new AuditRequest() : null;
  // Reserve finite resource/cleanup owners before resolver/open, independently of the original failure-output reserve.
  request?.allocateNodes(1 + 64 * 8 + 16); request?.units(64 * 8 + 16);
  request?.text(4096 * 3 * 64, 3); // At most 64 owner paths, UTF-8 bound and path/copy/recheck passes.
  let source: SqliteDatabaseDescriptor;
  try {
    const environment = await resolveBoardroomEnvironment();
    assertEnvironmentSelected(environment);
    if (environment.databaseDescriptor.kind !== "sqlite" || !environment.databaseDescriptor.identity) fail("source_unavailable");
    source = environment.databaseDescriptor;
    if (source.sourcePath.length > 4096 || source.sqlitePath.length > 4096) fail("source_unavailable");
  } catch (error) {
    if (knownFailure(error)) throw error;
    fail("source_selection_rejected");
  }
  if (pendingOwners.size) fail("native_retirement_unknown");
  const s: Owner = { files: [], failures: [], request, readBytes: 0, db: null, dbPhase: "absent" };
  pendingOwners.add(s);
  let output: Observation | ProfileObservation | undefined, failure: unknown, failed = false;
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
    request?.allocateNodes(8); request?.units(8); request?.text(512, 2); // Open/load/BEGIN, path/schema statements and terminal/close reserve.
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
    const profile = kind === "profile" ? readProfile(s) : null;
    checkNativePath();
    sourceUnchanged(source, pin); pinnedUnchanged(s);
    s.db.exec("ROLLBACK"); if (s.db.inTransaction) fail("native_retirement_unknown");
    const pathObservation: Observation = Object.freeze({ scope: "sqlite-main-path-observation/v1", sourcePath: source.sourcePath, sqlitePath: source.sqlitePath,
      pinIdentity: Object.freeze({ device: String(pin.stat.dev), inode: String(pin.stat.ino) }),
      component: Object.freeze({ binarySha256: built.binaryId.sha256, manifestSha256: built.manifestId.sha256 }),
      observations: Object.freeze({ namedPinBefore: true, vfsMainPathUnmoved: true, namedPinAfter: true, schemaVersion: String(schema.schema_version) }),
      retirement: "closed" });
    output = profile === null ? pathObservation : { scope: "sqlite-selected-profile-observation/v1", pathObservation, observation: profile,
      sourceFileDescriptorQualification: "not_qualified", retirement: "closed" };
    if (request) {
      const cost = request.measure(output, AUDIT_LIMITS.output);
      request.reserveOutput(cost.bytes); request.text(cost.bytes, 2); request.allocateNodes(cost.nodes);
      freeze(output);
    }
  } catch (error) { failed = true; failure = error; s.failures.push({ phase: "observation", error }); }
  retire(s);
  if (failed) {
    if (knownFailure(failure)) throw failure;
    const audit = failure !== null && (typeof failure === "object" || typeof failure === "function") ? request?.failures.get(failure) : undefined;
    if (audit && !audit.ok) fail(audit.error.code);
    fail("native_observation_failed");
  }
  if (!output) fail("native_observation_failed");
  return output;
}

export async function inspectSelectedSqlitePathBinding(): Promise<Observation> {
  return await inspectSelected("path") as Observation;
}
/** Zero arguments, real selected source, one private read transaction/request. No handle/callback/limit authority. */
export async function inspectSelectedSqliteProfileObservation(): Promise<ProfileObservation> {
  return await inspectSelected("profile") as ProfileObservation;
}

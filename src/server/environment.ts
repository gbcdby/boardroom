import { constants, accessSync, lstatSync, realpathSync, statSync } from "node:fs";
import { open, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DEFAULT_DATA_DIR, parseConfigValues, type AppConfig, type LoadConfigOptions } from "./config.ts";
import { ConfigError, type ConfigErrorCode } from "./config-error.ts";
import type { DbDriverOptions } from "./db/driver.ts";

export type StartupState = "fresh" | "active" | "legacy_found" | "ambiguous" | "recovery_required";
export interface FileIdentity { readonly device: string; readonly inode: string }
export interface SqliteDatabaseDescriptor {
  readonly kind: "sqlite";
  /** 旧运行时管理目录与 SQLite 真实文件可位于不同目录。 */
  readonly dataDir: string;
  readonly sqlitePath: string;
  /** 保留原入口，包括符号链接；连接前重新验证不能换源。 */
  readonly sourcePath: string;
  readonly identity: FileIdentity | null;
}
/** 仅可信装配及 IPC 可持有完整 PG descriptor；日志用 describeDatabase 的白名单。 */
export type DatabaseDescriptor = SqliteDatabaseDescriptor
  | { readonly kind: "postgres"; readonly connectionString: string; readonly schema?: string };
export type PublicDatabaseDescriptor =
  | { readonly kind: "sqlite"; readonly sqlitePath: string; readonly sourcePath: string; readonly identity: FileIdentity | null }
  | { readonly kind: "postgres"; readonly locationId: string; readonly verification: "configuration_only" };
export interface ResolvedPath { readonly path: string; readonly status: "legacy" | "planned"; readonly protected: boolean }
export interface EnvironmentDiagnostic { readonly code: ConfigErrorCode; readonly message: string; readonly recoveryAction: string }
export interface LegacyStorageSource {
  readonly id: string;
  readonly layoutVersion: 1 | 2;
  readonly database: PublicDatabaseDescriptor;
  readonly locations: readonly { readonly rule: string; readonly configFile: string | null; readonly sourcePath: string | null }[];
  readonly sqliteHeader?: "sqlite3" | "invalid";
  readonly byteLength?: string;
  readonly linkCount?: string;
  readonly walPresent?: boolean;
}
export interface LegacyStorageInventory {
  readonly startupState: StartupState;
  readonly selectedSourceId: string | null;
  readonly sources: readonly LegacyStorageSource[];
  readonly diagnostics: readonly EnvironmentDiagnostic[];
  readonly scanScope: "known_locations_only";
}
export interface ResolvedBoardroomEnvironment {
  readonly layoutVersion: 1 | 2;
  readonly homeRoot: string;
  readonly configFile: string | null;
  readonly stateRoot: string;
  readonly skillsRoot: string;
  readonly memoryRoot: string;
  readonly runtimeRoot: string;
  readonly workspacesRoot: string;
  readonly artifactsRoot: string;
  readonly storageId: string | null;
  readonly databaseDescriptor: DatabaseDescriptor;
  readonly startupState: StartupState;
  /** 只表示本版本允许沿用 v1 存储，不代表路径预检是宿主隔离证据。 */
  readonly writable: boolean;
  readonly paths: Readonly<Record<"state" | "skills" | "memory" | "runtime" | "workspaces" | "artifacts", ResolvedPath>>;
  readonly protectedPaths: readonly string[];
  readonly diagnostics: readonly EnvironmentDiagnostic[];
  readonly inventory: LegacyStorageInventory;
  readonly config: AppConfig;
}
export interface ResolveEnvironmentOptions extends LoadConfigOptions {
  /** 内部旧调用方的完整配置；不会重新加载任何配置文件或环境变量。 */
  readonly config?: AppConfig;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function codeOf(error: unknown): string { return (error as NodeJS.ErrnoException).code ?? "unknown"; }
function pathError(label: string, error: unknown): ConfigError {
  return new ConfigError(`${label} 不可访问（${codeOf(error)}）。请检查路径、文件类型及当前用户权限。`);
}

/** 规范化已有前缀，不创建缺失目录；损坏链接和非目录中间节点严格失败。 */
export function canonicalizePath(value: string): string {
  let current = path.resolve(value);
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      if (suffix.length && !statSync(real).isDirectory()) throw new ConfigError("路径中间节点必须是目录。");
      return path.join(real, ...suffix.reverse());
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      if (codeOf(error) !== "ENOENT") throw pathError("存储路径", error);
      // realpath 的 ENOENT 也可能是悬挂链接，不能当作可创建的新路径。
      try { lstatSync(current); throw new ConfigError("存储路径含无法解析的符号链接。"); }
      catch (entryError) { if (entryError instanceof ConfigError || codeOf(entryError) !== "ENOENT") throw entryError; }
      const parent = path.dirname(current);
      if (parent === current) throw pathError("存储路径", error);
      suffix.push(path.basename(current)); current = parent;
    }
  }
}

function pathValue(base: string, value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new ConfigError(`${field} 必须是非空路径字符串。`);
  return canonicalizePath(path.resolve(base, value));
}

async function readObject(file: string, required: boolean): Promise<Record<string, unknown> | null> {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new ConfigError("配置/存储元数据必须是小于 1 MiB 的普通文件。");
    const raw = await readFile(file, "utf8");
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch { throw new ConfigError(`配置文件 ${file} 不是合法 JSON。请修正语法，或参考 config.example.json。`); }
    if (!isObject(value)) throw new ConfigError("配置/存储元数据的顶层必须是 JSON 对象。");
    return value;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    if (!required && codeOf(error) === "ENOENT") {
      try { lstatSync(file); } catch (entryError) { if (codeOf(entryError) === "ENOENT") return null; }
    }
    throw new ConfigError(`无法读取配置文件 ${file}（${codeOf(error)}）。请检查 AGENT_STUDIO_CONFIG 与路径权限。`);
  }
}

function identityOf(file: string): FileIdentity | null {
  try {
    const stats = statSync(file, { bigint: true });
    if (!stats.isFile()) throw new ConfigError("SQLite 数据源必须是普通文件。");
    return { device: String(stats.dev), inode: String(stats.ino) };
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    if (codeOf(error) === "ENOENT") return null;
    throw pathError("SQLite 数据源", error);
  }
}

function hardlinkedSqlite(): EnvironmentDiagnostic {
  return { code: "storage_source_ambiguous", message: "SQLite 主数据库存在多个硬链接，不同文件名可能使用不同 WAL，不能安全选择。",
    recoveryAction: "停止相关数据库连接，核对原数据库及其 WAL 的完整一致快照，恢复到唯一文件入口后重新解析；不会删除硬链接或辅助文件。" };
}

/** 同 inode 的硬链接仍可能有不同 WAL；必须在实际打开连接前重新检查。 */
export function assertSqliteSingleLink(file: string): void {
  let multiple: boolean;
  try { multiple = statSync(file, { bigint: true }).nlink > 1n; }
  catch (error) { if (codeOf(error) === "ENOENT") return; throw pathError("SQLite 数据源", error); }
  if (multiple) {
    const diagnostic = hardlinkedSqlite();
    throw new ConfigError(diagnostic.message, diagnostic.code, diagnostic.recoveryAction);
  }
}

export function describeDatabase(database: DatabaseDescriptor): PublicDatabaseDescriptor {
  if (database.kind === "sqlite") return {
    kind: "sqlite", sqlitePath: database.sqlitePath, sourcePath: database.sourcePath, identity: database.identity,
  };
  // 只表示同一配置，不声明已连接、同一物理数据库或数据库格式已验证。
  return { kind: "postgres", locationId: `pg-config:${createHash("sha256").update(database.connectionString).digest("hex").slice(0, 24)}`,
    verification: "configuration_only" };
}

export function databaseDriverOptions(environment: ResolvedBoardroomEnvironment): DbDriverOptions {
  const database = environment.databaseDescriptor;
  return database.kind === "sqlite" ? { dbDriver: "sqlite", dataDir: database.dataDir, sqlitePath: database.sqlitePath, sqliteSource: database }
    : { dbDriver: "postgres", dataDir: environment.config.dataDir, pgConnectionString: database.connectionString,
      ...(database.schema === undefined ? {} : { pgSchema: database.schema }) };
}

/** 连接边界再次核实原入口、规范路径与 inode；不能因源被移走而新建替代空库。 */
export function assertSqliteSourceUnchanged(database: Pick<SqliteDatabaseDescriptor, "sqlitePath" | "sourcePath" | "identity">,
  writable = false): void {
  try {
    if (canonicalizePath(database.sourcePath) !== database.sqlitePath) throw new Error("changed");
    const actual = identityOf(database.sourcePath);
    if (actual?.device !== database.identity?.device || actual?.inode !== database.identity?.inode) throw new Error("changed");
  } catch {
    throw new ConfigError("已解析的 SQLite 源被移动、替换、不可访问或符号链接发生变化。", "storage_source_changed",
      "停止启动，检查原数据与链接后重新解析配置；不会新建替代空库。");
  }
  assertSqliteSingleLink(database.sqlitePath);
  if (writable) {
    assertWritableDirectory(path.dirname(database.sqlitePath));
    if (database.identity) {
      try { accessSync(database.sqlitePath, constants.R_OK | constants.W_OK); }
      catch (error) { throw pathError("SQLite 数据源", error); }
    }
  }
}

/** 仅在主库 connect 成功后，为 fresh v1 捕获新建文件身份；传给只读子进程的仍是同一物理源。 */
export function databaseForConnectedReader(database: DatabaseDescriptor): DatabaseDescriptor {
  if (database.kind === "postgres") return database;
  if (database.identity) { assertSqliteSourceUnchanged(database); return database; }
  if (canonicalizePath(database.sourcePath) !== database.sqlitePath) throw new ConfigError("连接后的 SQLite 源发生变化。", "storage_source_changed");
  const identity = identityOf(database.sqlitePath);
  if (!identity) throw new ConfigError("连接后的 SQLite 源不存在。", "storage_source_changed");
  assertSqliteSingleLink(database.sqlitePath);
  return { ...database, identity };
}

export async function resolveBoardroomEnvironment(options: ResolveEnvironmentOptions = {}): Promise<ResolvedBoardroomEnvironment> {
  if (options.config?.environment) return options.config.environment;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = options.config ? {} : options.env ?? process.env;
  const rawHome = env["BOARDROOM_HOME"] ?? path.join(options.homeDir ?? homedir(), ".boardroom");
  if (!path.isAbsolute(rawHome)) throw new ConfigError("BOARDROOM_HOME 必须是绝对路径；不会重写 HOME。");
  const homeRoot = pathValue(cwd, rawHome, "BOARDROOM_HOME");
  let configFile: string | null = options.config?.configFile ?? null;
  let values: Record<string, unknown> = {};
  if (!options.config) {
    const explicit = env["AGENT_STUDIO_CONFIG"];
    if (explicit !== undefined && !explicit.trim()) throw new ConfigError("AGENT_STUDIO_CONFIG 必须是非空路径。");
    const candidates = explicit !== undefined ? [path.resolve(cwd, explicit)]
      : [path.join(homeRoot, "config.json"), path.join(cwd, "config.json")];
    for (const file of candidates) {
      const parsed = await readObject(file, explicit !== undefined);
      if (parsed !== null) { configFile = canonicalizePath(file); values = parsed; break; }
    }
  }
  const layout = values["layoutVersion"] === undefined ? 1 : values["layoutVersion"];
  if (layout !== 1 && layout !== 2) throw new ConfigError("layoutVersion 必须为 1 或 2。");
  const fileBase = layout === 2 && configFile ? path.dirname(configFile) : cwd;
  const stateRoot = pathValue(fileBase, layout === 2 ? values["stateRoot"] ?? path.join(homeRoot, "state") : path.join(homeRoot, "state"), "stateRoot");
  let config = options.config ?? parseConfigValues({ cwd, env, fileValues: values, configFile, filePathBase: fileBase,
    defaultDataDir: layout === 2 ? stateRoot : DEFAULT_DATA_DIR });
  const sourcePath = path.resolve(cwd, config.dataDir, "agent-studio.db");
  config = { ...config, dataDir: pathValue(cwd, config.dataDir, "dataDir"), configFile };
  const databaseDescriptor: DatabaseDescriptor = (config.dbDriver ?? "sqlite") === "sqlite"
    ? { kind: "sqlite", dataDir: config.dataDir, sourcePath, sqlitePath: canonicalizePath(sourcePath), identity: identityOf(sourcePath) }
    : { kind: "postgres", connectionString: config.pgConnectionString ?? "" };
  if (databaseDescriptor.kind === "postgres" && !databaseDescriptor.connectionString.trim()) throw new ConfigError("PostgreSQL 缺少 AGENT_STUDIO_PG_CONNECTION_STRING。");
  const resource = (field: string, fallback: string): string => pathValue(fileBase, layout === 2 ? values[field] ?? fallback : fallback, field);
  const skillsRoot = resource("skillsRoot", path.join(homeRoot, "skills"));
  const memoryRoot = resource("memoryRoot", path.join(homeRoot, "memory"));
  const runtimeRoot = layout === 1 ? path.join(config.dataDir, "managed") : resource("runtimeRoot", path.join(homeRoot, "runtime"));
  const workspacesRoot = resource("workspacesRoot", path.join(homeRoot, "workspaces"));
  const artifactsRoot = resource("artifactsRoot", path.join(stateRoot, "artifacts"));
  const declaredId = values["storageId"];
  if (declaredId !== undefined && (typeof declaredId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(declaredId))) {
    throw new ConfigError("storageId 必须是非空的存储实例标识。");
  }
  const protectedPaths = [stateRoot, skillsRoot, memoryRoot, runtimeRoot, artifactsRoot, config.dataDir,
    ...(databaseDescriptor.kind === "sqlite" ? [databaseDescriptor.sqlitePath] : []), ...(configFile ? [configFile] : []),
    canonicalizePath(path.resolve(import.meta.dirname, "../.."))];
  const paths = {
    state: { path: stateRoot, status: "planned", protected: true }, skills: { path: skillsRoot, status: "planned", protected: true },
    memory: { path: memoryRoot, status: "planned", protected: true }, runtime: { path: runtimeRoot, status: layout === 1 ? "legacy" : "planned", protected: true },
    workspaces: { path: workspacesRoot, status: "planned", protected: false }, artifacts: { path: artifactsRoot, status: "planned", protected: true },
  } as const;
  const diagnostics: EnvironmentDiagnostic[] = layout === 2 ? [{ code: "legacy_migration_required",
    message: "发现 layoutVersion:2，但本版本没有可验证的数据库激活证据。", recoveryAction: "使用完整一致快照恢复，或等待显式迁移/激活；不要手工标记 active。" }]
    : declaredId !== undefined ? [{ code: "migration_incomplete", message: "配置带 storageId，但缺少匹配的新格式声明。", recoveryAction: "检查完整配置及迁移提交记录，恢复一致的格式组合。" }] : [];
  const initial = { layoutVersion: layout, homeRoot, configFile, stateRoot, skillsRoot, memoryRoot, runtimeRoot, workspacesRoot, artifactsRoot,
    storageId: typeof declaredId === "string" ? declaredId : null, databaseDescriptor, startupState: layout === 2 ? "recovery_required"
      : databaseDescriptor.kind === "postgres" || databaseDescriptor.identity ? "legacy_found" : "fresh",
    writable: layout === 1, paths, protectedPaths: [...new Set(protectedPaths)], diagnostics, config } as const;
  const inventory = await collectInventory(initial, options);
  const writable = layout === 1 && (inventory.startupState === "fresh" ||
    (inventory.startupState === "legacy_found" && inventory.selectedSourceId !== null));
  return { ...initial, startupState: inventory.startupState, diagnostics: inventory.diagnostics, writable, inventory };
}

/** 只读取已知位置配置、SQLite 文件头和元数据；从不连接数据库或创建目录。 */
export async function inspectLegacyStorage(options: ResolveEnvironmentOptions = {}): Promise<LegacyStorageInventory> {
  return (await resolveBoardroomEnvironment(options)).inventory;
}

async function collectInventory(environment: Omit<ResolvedBoardroomEnvironment, "inventory">,
  options: ResolveEnvironmentOptions): Promise<LegacyStorageInventory> {
  const sources = new Map<string, LegacyStorageSource>();
  const diagnostics = [...environment.diagnostics];
  let hardRecovery = environment.layoutVersion === 1 && environment.storageId !== null;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = options.config ? {} : options.env ?? process.env;
  const explicit = options.config !== undefined || env["AGENT_STUDIO_CONFIG"] !== undefined || env["AGENT_STUDIO_DATA_DIR"] !== undefined || env["AGENT_STUDIO_DB_DRIVER"] !== undefined;
  async function add(database: DatabaseDescriptor, layoutVersion: 1 | 2, rule: string, configFile: string | null): Promise<string | null> {
    let id: string;
    let facts: Pick<LegacyStorageSource, "sqliteHeader" | "byteLength" | "linkCount" | "walPresent"> = {};
    if (database.kind === "sqlite") {
      if (!database.identity) return null;
      // 仅规范路径相同的符号链接别名可共用 WAL；硬链接的不同路径不能只按 inode 合并。
      id = `sqlite:${database.identity.device}:${database.identity.inode}:${createHash("sha256").update(database.sqlitePath).digest("hex").slice(0, 24)}`;
      const file = await open(database.sqlitePath, "r").catch(error => { throw pathError("SQLite 数据源", error); });
      try {
        const stats = await file.stat({ bigint: true });
        const header = Buffer.alloc(16);
        const { bytesRead } = await file.read(header, 0, 16, 0);
        const valid = bytesRead === 16 && header.equals(Buffer.from("SQLite format 3\0"));
        facts = { sqliteHeader: valid ? "sqlite3" : "invalid", byteLength: String(stats.size), linkCount: String(stats.nlink),
          walPresent: exists(`${database.sqlitePath}-wal`) };
        if (stats.nlink > 1n) {
          hardRecovery = true;
          if (!sources.has(id)) diagnostics.push(hardlinkedSqlite());
        }
        if (!valid) {
          hardRecovery = true;
          diagnostics.push({ code: "migration_incomplete", message: "已知 SQLite 文件的格式头无效，不能将其当成 fresh 数据库。",
            recoveryAction: "检查该源的一致备份与完整性后恢复；不要创建替代空库。" });
        }
      } finally { await file.close(); }
    } else id = (describeDatabase(database) as Extract<PublicDatabaseDescriptor, { kind: "postgres" }>).locationId;
    const location = { rule, configFile, sourcePath: database.kind === "sqlite" ? database.sourcePath : null };
    const previous = sources.get(id);
    sources.set(id, { id, layoutVersion: previous && rule === "planned-state" ? previous.layoutVersion : previous?.layoutVersion === 2 ? 2 : layoutVersion,
      database: previous?.database ?? describeDatabase(database), locations: [...previous?.locations ?? [], location], ...facts });
    return id;
  }
  function sqliteAt(dataDir: string): SqliteDatabaseDescriptor {
    const sourcePath = path.resolve(dataDir, "agent-studio.db");
    return { kind: "sqlite", dataDir: canonicalizePath(dataDir), sourcePath, sqlitePath: canonicalizePath(sourcePath), identity: identityOf(sourcePath) };
  }
  const selectedSourceId = await add(environment.databaseDescriptor, environment.layoutVersion, "selected", environment.configFile);
  const dirs = options.config ? [] : [...new Set([cwd, ...options.knownLegacyCwds ?? []].map(value => path.resolve(cwd, value)))];
  for (const directory of dirs) {
    await add(sqliteAt(path.join(directory, "data")), 1, directory === cwd ? "cwd-data" : "known-legacy-data", null);
    const file = path.join(directory, "config.json");
    if (canonicalizePath(file) === environment.configFile) continue;
    // 显式选择不会再加载当前 cwd 的另一份默认配置；仍检查旧 data 与新目标恢复标记。
    if (explicit && directory === cwd) continue;
    const values = await readObject(file, false);
    if (values === null) continue;
    const version = values["layoutVersion"] === undefined ? 1 : values["layoutVersion"];
    if (version !== 1) {
      diagnostics.push({ code: "migration_incomplete", message: "已知旧启动目录存在未验证的新格式配置。", recoveryAction: "检查迁移记录与格式代际；显式完成恢复后再启动。" });
      continue;
    }
    const config = parseConfigValues({ cwd: directory, env: {}, fileValues: values, configFile: file, filePathBase: directory, defaultDataDir: DEFAULT_DATA_DIR });
    const database: DatabaseDescriptor = config.dbDriver === "postgres" ? { kind: "postgres", connectionString: config.pgConnectionString! } : sqliteAt(config.dataDir);
    await add(database, 1, "known-legacy-config", canonicalizePath(file));
  }
  await add(sqliteAt(environment.stateRoot), 2, "planned-state", null);
  const metadataFile = path.join(environment.stateRoot, "storage.json");
  async function readMetadata(file: string, required: boolean): Promise<Record<string, unknown> | null> {
    try { return await readObject(file, required); }
    catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      hardRecovery = true;
      diagnostics.unshift({ code: "migration_incomplete", message: "存储元数据或迁移 journal 无法读取/解析。",
        recoveryAction: "核对可读的一致备份和迁移记录后恢复；不猜测丢失字段或创建空库。" });
      return null;
    }
  }
  const metadata = await readMetadata(metadataFile, false);
  if (metadata !== null) {
    if (environment.storageId !== null && metadata["storageId"] !== environment.storageId) {
      hardRecovery = true;
      diagnostics.unshift({ code: "storage_root_mismatch", message: "配置与文件存储的 storageId 不一致。",
        recoveryAction: "恢复同一个一致快照的数据库、配置和文件根；不要创建另一份同名空存储。" });
    } else if (metadata["maintenance"] === true) {
      hardRecovery = true;
      diagnostics.unshift({ code: "storage_maintenance", message: "存储元数据声明正在维护。", recoveryAction: "完成已登记的维护/恢复并核实实际产物后再启动。" });
    } else {
      diagnostics.push({ code: "migration_incomplete", message: "已存在新存储元数据，但数据库格式及 storageId 尚无可核验的激活证据。",
        recoveryAction: "检查一致快照及迁移记录；storage.json 或配置中的 active 标记不能替代数据库证据。" });
    }
  }
  const journalRoot = path.join(environment.stateRoot, "migrations");
  let journals: string[] = [];
  try { journals = await readdir(journalRoot); }
  catch (error) {
    if (codeOf(error) !== "ENOENT") throw pathError("迁移记录目录", error);
    // ENOENT 也可能来自现存悬挂链接，只有目录项本身真正缺失才允许 fresh。
    try {
      lstatSync(journalRoot);
      hardRecovery = true;
      diagnostics.push({ code: "migration_incomplete", message: "迁移记录目录存在但无法解析，不能视为没有迁移记录。",
        recoveryAction: "核对迁移目录链接、原始 journal 与一致快照后恢复；不会创建目录或忽略丢失的迁移状态。" });
    } catch (entryError) { if (codeOf(entryError) !== "ENOENT") throw pathError("迁移记录目录", entryError); }
  }
  if (journals.length > 4096) throw new ConfigError("迁移记录数量超出只读预检上限，请检查存储恢复记录。");
  if (journals.some(name => !name.endsWith(".json"))) {
    hardRecovery = true;
    diagnostics.push({ code: "migration_incomplete", message: "迁移记录目录存在未知格式条目。",
      recoveryAction: "核对该版本的迁移格式和恢复记录；预检不会递归猜测或忽略未知提交状态。" });
  }
  for (const name of journals.filter(name => name.endsWith(".json"))) {
    const journal = await readMetadata(path.join(journalRoot, name), true);
    if (journal?.["phase"] !== "completed") {
      hardRecovery = true;
      diagnostics.push({ code: "migration_incomplete", message: "发现未完成或格式未知的迁移 journal。",
        recoveryAction: "核对 journal 与实际提交产物，显式恢复或续做迁移；普通启动不会修改它。" });
    } else if (metadata === null) {
      hardRecovery = true;
      diagnostics.push({ code: "migration_incomplete", message: "journal 声称完成但缺少相应存储元数据与激活证据。",
        recoveryAction: "核对完整迁移产物与一致快照；完成状态文字不能替代实际格式证据。" });
    }
  }
  const list = [...sources.values()];
  let startupState: StartupState;
  if (!hardRecovery && list.length > 1 && list.some(source => source.layoutVersion === 2)) {
    startupState = "ambiguous"; diagnostics.unshift(ambiguity());
  } else if (diagnostics.length) startupState = "recovery_required";
  else if (list.some(source => source.layoutVersion === 2)) {
    startupState = list.length > 1 ? "ambiguous" : "recovery_required";
    diagnostics.push(startupState === "ambiguous" ? ambiguity() : {
      code: "migration_incomplete", message: "新目标已有数据库但没有可核实的激活证据。", recoveryAction: "检查一致快照及迁移记录，不将文件存在视为 active。" });
  } else if (list.length > 1 && !(explicit && selectedSourceId)) { startupState = "ambiguous"; diagnostics.push(ambiguity()); }
  else if (list.length) {
    startupState = "legacy_found";
    if (selectedSourceId === null) diagnostics.push({ code: "legacy_migration_required", message: "已知目录发现旧数据，当前选定数据源为空。",
      recoveryAction: "用 AGENT_STUDIO_CONFIG 或绝对 AGENT_STUDIO_DATA_DIR 明确选择已发现旧源，或执行后续显式迁移。" });
  } else startupState = "fresh";
  return { startupState, selectedSourceId, sources: list, diagnostics, scanScope: "known_locations_only" };
}

function ambiguity(): EnvironmentDiagnostic {
  return { code: "storage_source_ambiguous", message: "发现多个不同数据源，不能按修改时间选择或新建空库。",
    recoveryAction: "检查 inspect-storage 清单，明确选择旧源；新旧混存需完成迁移/恢复。" };
}

export async function assertEnvironmentWritable(environment: ResolvedBoardroomEnvironment): Promise<void> {
  assertEnvironmentSelected(environment);
  if (environment.databaseDescriptor.kind === "sqlite") assertSqliteSourceUnchanged(environment.databaseDescriptor, true);
  assertWritableDirectory(environment.config.dataDir);
}

/** 读旧库的管理命令也必须拒绝歧义、恢复或未激活格式，但不用取得写权限。 */
export function assertEnvironmentSelected(environment: ResolvedBoardroomEnvironment): void {
  if (!environment.writable) {
    const diagnostic = environment.diagnostics[0]!;
    throw new ConfigError(diagnostic.message, diagnostic.code, diagnostic.recoveryAction);
  }
}

function assertWritableDirectory(directory: string): void {
  // 真实权限预检，不 mkdir、不打开 SQLite、不执行迁移；由真实父目录承担 WAL 文件。
  let parent = directory;
  while (!exists(parent)) parent = path.dirname(parent);
  try {
    if (!statSync(parent).isDirectory()) throw new ConfigError("数据库/运行时父路径必须是目录。");
    accessSync(parent, constants.R_OK | constants.W_OK | constants.X_OK);
  }
  catch (error) { throw pathError("数据库/运行时父目录", error); }
}

function exists(file: string): boolean {
  try { statSync(file); return true; }
  catch (error) { if (codeOf(error) === "ENOENT") return false; throw pathError("存储路径", error); }
}

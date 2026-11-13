import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJson } from "./canonical.ts";
import { MaintenanceFailure } from "./error.ts";
import { auditPublicArchiveToc, type PublicRestoreCatalogBinding } from "./postgres-public-toc.ts";
import { postgresPublicToolVersions, runPostgresTool } from "./postgres-tools.ts";
import { publicDirectoryFiles, type PublicDirectoryFiles, type PublicFileStat } from "./postgres-public-directory.ts";
import type { Json } from "./types.ts";

interface FileIdentity {
  readonly device: string; readonly inode: string; readonly bytes: string; readonly mode: string;
  readonly uid: string; readonly links: string; readonly mtime: string; readonly ctime: string;
}
interface BoundFile { readonly name: string; readonly identity: FileIdentity; readonly sha256: string }
function identity(info: PublicFileStat): FileIdentity {
  if (!info.isFile() || info.nlink !== 1n || (info.mode & 0o777n) !== 0o600n || info.size > BigInt(Number.MAX_SAFE_INTEGER)
    || process.getuid && info.uid !== BigInt(process.getuid())) throw new MaintenanceFailure("snapshot_invalid");
  return { device: String(info.dev), inode: String(info.ino), bytes: String(info.size), mode: String(info.mode),
    uid: String(info.uid), links: String(info.nlink), mtime: String(info.mtimeNs), ctime: String(info.ctimeNs) };
}
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const failure = () => new MaintenanceFailure("restore_verification_unavailable");

/** Explicit positional reads do not consume the open-file description inherited by native tools. */
export async function postgresFileDigest(handle: FileHandle, check: () => void = () => {}): Promise<string> {
  const before = identity(await handle.stat({ bigint: true })), hash = createHash("sha256"), buffer = Buffer.alloc(128 * 1024);
  let position = 0;
  while (true) {
    check(); const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
  }
  if (String(position) !== before.bytes || !same(before, identity(await handle.stat({ bigint: true })))) throw new MaintenanceFailure("snapshot_invalid");
  return hash.digest("hex");
}

/** Native SQL is rendered unchanged. Only fixed PG16 baseline commands surround the two files. */
export async function restorePostgresPublic(input: {
  readonly archivePath: string; readonly archiveDigest: string; readonly binding: PublicRestoreCatalogBinding;
  readonly restoreDirectory: string; readonly environment: NodeJS.ProcessEnv; readonly signal: AbortSignal;
  /** The adapter retains this same absolute deadline through its final success receipt. */
  readonly deadline: number;
  readonly assertCurrent: () => Promise<void>;
  /** Recheck the isolated target and lock immediately before its first write. */
  readonly beforeExecute: () => Promise<void>;
}): Promise<Json> {
  const deadline = input.deadline;
  const check = () => { if (input.signal.aborted) throw new MaintenanceFailure("maintenance_lost"); if (performance.now() >= deadline) throw failure(); };
  const checkCurrent = async () => { check(); await input.assertCurrent(); check(); };
  if (!Number.isFinite(deadline) || !["linux", "darwin"].includes(process.platform) || !/^[a-f0-9]{64}$/.test(input.archiveDigest)
    || resolve(input.restoreDirectory) !== input.restoreDirectory || await realpath(input.restoreDirectory) !== input.restoreDirectory) throw failure();
  const directory = await open(input.restoreDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const directoryIdentity = await directory.stat({ bigint: true });
  let directoryFiles: PublicDirectoryFiles;
  const directoryCheck = async () => {
    check(); const current = await lstat(input.restoreDirectory, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== directoryIdentity.dev || current.ino !== directoryIdentity.ino
      || (current.mode & 0o777n) !== 0o700n || process.getuid && current.uid !== BigInt(process.getuid())
      || await realpath(input.restoreDirectory) !== input.restoreDirectory) throw new MaintenanceFailure("target_conflict");
  };
  const handles = new Set<FileHandle>();
  const track = (handle: FileHandle) => { handles.add(handle); return handle; };
  const close = async (handle: FileHandle) => { await handle.close(); handles.delete(handle); };
  const create = async (suffix: string) => {
    await directoryCheck();
    const name = `.public-${randomUUID()}-${suffix}`;
    const handle = track(await directoryFiles.create(name));
    identity(await handle.stat({ bigint: true })); await directoryCheck(); return { name, handle };
  };
  const seal = async (file: { name: string; handle: FileHandle }): Promise<BoundFile> => {
    await file.handle.sync();
    const info = identity(await file.handle.stat({ bigint: true }));
    const sha256 = await postgresFileDigest(file.handle, check);
    if (!same(info, identity(await directoryFiles.stat(file.name)))) throw new MaintenanceFailure("snapshot_invalid");
    await close(file.handle); await directoryCheck();
    return { name: file.name, identity: info, sha256 };
  };
  const read = async (file: BoundFile): Promise<FileHandle> => {
    await directoryCheck();
    const handle = track(await directoryFiles.read(file.name));
    if (!same(file.identity, identity(await handle.stat({ bigint: true })))
      || !same(file.identity, identity(await directoryFiles.stat(file.name)))
      || await postgresFileDigest(handle, check) !== file.sha256) throw new MaintenanceFailure("snapshot_invalid");
    // postgresFileDigest uses explicit positions; this newly opened description still starts at 0.
    return handle;
  };
  const recheck = async (file: BoundFile, handle: FileHandle) => {
    await directoryCheck();
    if (!same(file.identity, identity(await handle.stat({ bigint: true })))
      || !same(file.identity, identity(await directoryFiles.stat(file.name)))
      || await postgresFileDigest(handle, check) !== file.sha256) throw new MaintenanceFailure("snapshot_invalid");
  };
  const write = async (suffix: string, bytes: string) => { const file = await create(suffix); await file.handle.writeFile(bytes); return seal(file); };
  try {
    await directoryCheck(); await checkCurrent();
    directoryFiles = publicDirectoryFiles(directory, directoryIdentity, check);
    const versions = await postgresPublicToolVersions(input.environment, input.signal, deadline, input.binding.pgDump);
    const source = track(await open(input.archivePath, constants.O_RDONLY | constants.O_NOFOLLOW));
    const sourceIdentity = identity(await source.stat({ bigint: true }));
    if (!same(sourceIdentity, identity(await lstat(input.archivePath, { bigint: true })))) throw new MaintenanceFailure("snapshot_invalid");
    const copy = await create("archive.dump"), buffer = Buffer.alloc(128 * 1024), hash = createHash("sha256");
    let position = 0;
    while (true) {
      check(); const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      if (position === 0 && buffer.subarray(0, 5).toString("ascii") !== "PGDMP") throw new MaintenanceFailure("snapshot_invalid");
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) { check(); const result = await copy.handle.write(buffer, written, bytesRead - written, position + written);
        if (result.bytesWritten <= 0) throw failure(); written += result.bytesWritten; }
      position += bytesRead;
    }
    if (position <= 5 || String(position) !== sourceIdentity.bytes || hash.digest("hex") !== input.archiveDigest
      || !same(sourceIdentity, identity(await source.stat({ bigint: true })))
      || !same(sourceIdentity, identity(await lstat(input.archivePath, { bigint: true })))) throw new MaintenanceFailure("snapshot_invalid");
    await close(source);
    const archive = await seal(copy); if (archive.sha256 !== input.archiveDigest) throw new MaintenanceFailure("snapshot_invalid");
    const nativeOutput = async (suffix: string, args: readonly string[], selection?: BoundFile) => {
      await checkCurrent(); const archiveInput = await read(archive), selectionInput = selection ? await read(selection) : undefined;
      const output = await create(suffix);
      try {
        const result = await runPostgresTool("pg_restore", [...args, "/dev/fd/3"], input.environment,
          { failure: "restore_verification_unavailable", signal: input.signal, deadline, outputFd: output.handle.fd,
            readFds: [archiveInput.fd, ...selectionInput ? [selectionInput.fd] : []] });
        if (result.stderrPresent) throw failure();
        await recheck(archive, archiveInput); if (selection && selectionInput) await recheck(selection, selectionInput);
        return await seal(output);
      } finally { await close(archiveInput); if (selectionInput) await close(selectionInput); }
    };
    const toc = await nativeOutput("complete.toc", ["--format=custom", "--list", "--verbose"]);
    const tocInput = await read(toc);
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(await tocInput.readFile()); await recheck(toc, tocInput); }
    finally { await close(tocInput); }
    const audit = auditPublicArchiveToc(text, input.binding);
    const namespaceSelection = await write("namespace.list", audit.namespaceIds.map(id => `${id};\n`).join(""));
    const bodySelection = await write("body.list", audit.bodyIds.map(id => `${id};\n`).join(""));
    const renderArgs = ["--format=custom", "--use-list=/dev/fd/4", "--file=-"];
    const namespaceSql = await nativeOutput("namespace.sql", renderArgs, namespaceSelection);
    const bodySql = await nativeOutput("body.sql", renderArgs, bodySelection);
    const namespaceInput = await read(namespaceSql), bodyInput = await read(bodySql);
    try {
      await checkCurrent(); await input.beforeExecute(); check();
      const result = await runPostgresTool("psql", ["--no-psqlrc", "--no-password", "--quiet", "--no-align", "--tuples-only",
        "--set=ON_ERROR_STOP=on", "--single-transaction", "-c", "DROP SCHEMA IF EXISTS public RESTRICT;", "-f", "/dev/fd/3",
        "-c", "GRANT USAGE ON SCHEMA public TO PUBLIC;", "-f", "/dev/fd/4"],
      { ...input.environment, PGOPTIONS: `${input.environment.PGOPTIONS ?? ""} -c client_min_messages=warning` },
      { failure: "restore_verification_unavailable", signal: input.signal, deadline, readFds: [namespaceInput.fd, bodyInput.fd] });
      if (result.stderrPresent) throw failure();
      await recheck(namespaceSql, namespaceInput); await recheck(bodySql, bodyInput); await checkCurrent();
    } finally { await close(namespaceInput); await close(bodyInput); }
    const proof = (file: BoundFile) => ({ name: file.name, sha256: file.sha256, bytes: file.identity.bytes });
    return { pgRestore: versions.pgRestore, psql: versions.psql, profile: "pg16-public-native-segments-v1",
      singleTransaction: true, ownershipPreserved: true, aclPreserved: true,
      archiveSha256: archive.sha256, audit: { ...audit, databaseEnvelopeExecuted: false,
        toc: proof(toc), namespaceSelection: proof(namespaceSelection), bodySelection: proof(bodySelection),
        namespaceSql: proof(namespaceSql), bodySql: proof(bodySql) } };
  } finally {
    // Native runner resolves/rejects only after close. No read/write descriptor is closed while
    // its child still owns it; private incomplete artifacts remain available for diagnosis.
    await Promise.allSettled([...handles].map(handle => handle.close())); await directory.close();
  }
}

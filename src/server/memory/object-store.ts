import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { MaintenanceFailure, maintenanceFailureCode } from "../storage/maintenance/error.ts";
import { getLayoutValueErrorCode } from "../storage/maintenance/layout-values.ts";
import { maintenanceFilesystem, syncMaintenanceHandle } from "../storage/maintenance/platform.ts";
import { decideHeadCommit } from "./head-commit-value.ts";
import type {
  MemoryHeadCommitDecisionValue, MemoryHeadCommitHeadValue, MemoryHeadCommitMutationValue,
} from "./head-commit-value.ts";
import {
  decodeMemoryObjectBody, encodeMemoryObjectBody, memoryObjectRelativeKey, parseMemoryObjectRef,
} from "./object-ref.ts";
import type { MemoryObjectRef } from "./object-ref.ts";
import { MemoryObjectValueError } from "./object-ref.ts";
import type { MemoryPublicationPlanValue } from "./publication-plan.ts";

type ErrorCode = "invalid_root" | "invalid_ref" | "invalid_body" | "body_limit_exceeded" | "missing_object"
  | "object_integrity" | "control_root_mismatch" | "unsupported_durability" | "publication_failed"
  | "invalid_gate_input";
export type { ErrorCode as MemoryObjectStoreErrorCode };
export type PublishPoint = "temp_written" | "file_synced" | "renamed" | "directory_synced";

const CODES: readonly ErrorCode[] = ["invalid_root", "invalid_ref", "invalid_body", "body_limit_exceeded",
  "missing_object", "object_integrity", "control_root_mismatch", "unsupported_durability", "publication_failed",
  "invalid_gate_input"];
const MAX_BODY_BYTES = 1_048_576;
const RELATIVE_KEY = /^objects\/sha256\/[0-9a-f]{2}\/[0-9a-f]{64}\.md$/;
const PART = /^[A-Za-z0-9_-]+$/;
const DIGEST = /^[0-9a-f]{64}$/;
const STORAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const failures = new WeakMap<object, ErrorCode>();

/** Fixed storage-layer codes; messages carry neither paths, causes nor caller data. */
export class MemoryObjectStoreError extends Error {
  override readonly name = "MemoryObjectStoreError";
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    const fixed = (CODES as readonly unknown[]).includes(code) ? code : "invalid_root";
    super(`memory_object_store:${fixed}`);
    this.code = fixed;
    failures.set(this, fixed);
  }
}
export function getMemoryObjectStoreErrorCode(value: unknown): ErrorCode | undefined {
  return value !== null && (typeof value === "object" || typeof value === "function") ? failures.get(value) : undefined;
}
function fail(code: ErrorCode): never { throw new MemoryObjectStoreError(code); }

type Phase = "root" | "put" | "read" | "confirm" | "gate";
function toStoreError(error: unknown, phase: Phase): MemoryObjectStoreError {
  if (error instanceof MemoryObjectStoreError) return error;
  if (error instanceof MaintenanceFailure || maintenanceFailureCode(error) !== undefined)
    return new MemoryObjectStoreError("unsupported_durability");
  const layoutCode = getLayoutValueErrorCode(error);
  if (layoutCode !== undefined) return new MemoryObjectStoreError(phase === "gate" ? "invalid_gate_input" : "object_integrity");
  if (error instanceof MemoryObjectValueError) {
    if (error.code === "invalid_ref") return new MemoryObjectStoreError("invalid_ref");
    if (error.code === "body_limit_exceeded") return new MemoryObjectStoreError("body_limit_exceeded");
    return new MemoryObjectStoreError(phase === "put" ? "invalid_body" : "object_integrity");
  }
  if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return new MemoryObjectStoreError("missing_object");
  if (phase === "root") return new MemoryObjectStoreError("invalid_root");
  if (phase === "put") return new MemoryObjectStoreError("publication_failed");
  if (phase === "gate") return new MemoryObjectStoreError("invalid_gate_input");
  return new MemoryObjectStoreError("object_integrity");
}

interface DirectoryIdentity { readonly device: string; readonly inode: string }
async function directoryIdentity(file: string): Promise<DirectoryIdentity> {
  const info = await lstat(file, { bigint: true });
  if (!info.isDirectory() || (info.mode & 0o777n) !== 0o700n) fail("control_root_mismatch");
  return Object.freeze({ device: String(info.dev), inode: String(info.ino) });
}

async function syncDirectory(file: string): Promise<void> {
  const handle = await open(file, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await syncMaintenanceHandle(handle); } finally { await handle.close(); }
}

export interface MemoryObjectStoreConfig {
  readonly root: string;
  readonly storageId: string;
}
export interface MemoryObjectStoreOptions {
  /** Diagnostic/injection hook; order is temp_written → file_synced → renamed → directory_synced.
   * A callback must not re-enter `put` on this same instance: re-entry is refused with controlled
   * `publication_failed` rather than waiting forever on the serialized publish. */
  readonly after?: (point: PublishPoint) => void | Promise<void>;
}
export interface MemoryObjectDurabilityConfirmation {
  readonly ref: Readonly<MemoryObjectRef>;
  readonly objectDigest: string;
  readonly completed: readonly ["file_sync", "immutable_name_verified", "directory_sync"];
}
export interface MemoryObjectHeadGateInput {
  readonly durableObjectDigests: readonly string[];
  readonly plan: Readonly<MemoryPublicationPlanValue>;
  readonly currentHead: Readonly<MemoryHeadCommitHeadValue>;
  readonly expectedHead: Readonly<MemoryHeadCommitHeadValue>;
  readonly targetHead: Readonly<MemoryHeadCommitHeadValue>;
  readonly mutation: Readonly<MemoryHeadCommitMutationValue>;
}

/**
 * Private content-addressed markdown object store. It performs no database access, publishes no head,
 * and grants no ArtifactStore, schema, API or production qualification authority.
 *
 * One private root should correspond to one store instance. If two instances share the same root and
 * concurrently put the same digest, `link` still guarantees no overwrite: the loser may conservatively
 * fail with `unsupported_durability` (concurrent directory fullfsync) or `object_integrity` (transient
 * nlink=2 from the winner's link→unlink window). Such a failure is a refusal, never an overwrite or
 * corruption. Cross-instance locking is outside this minimal slice.
 *
 * If the process dies inside the `link`→`unlink(temp)` window, a staging hard link remains and the
 * published name has nlink=2. Subsequent read/confirmDurable/put for that object then reject with
 * `object_integrity` rather than degrading silently or overwriting. Recovery/self-healing after an
 * interrupted publication is outside this slice and belongs to a later full store slice.
 */
export class MemoryObjectStore {
  readonly root: string;
  readonly storageId: string;
  readonly #identity: DirectoryIdentity;
  readonly #after: ((point: PublishPoint) => void | Promise<void>) | undefined;
  readonly #serializers = new Map<string, Promise<unknown>>();
  #inAfterHook = false;

  private constructor(config: Required<Pick<MemoryObjectStoreConfig, "root" | "storageId">>,
    identity: DirectoryIdentity, options: MemoryObjectStoreOptions) {
    this.root = config.root;
    this.storageId = config.storageId;
    this.#identity = identity;
    this.#after = options.after;
  }

  /** The root must already exist as a caller-owned, non-symlink, 0700 absolute directory. */
  static async create(config: MemoryObjectStoreConfig, options: MemoryObjectStoreOptions = {}): Promise<MemoryObjectStore> {
    try {
      if (config === null || typeof config !== "object") fail("invalid_root");
      const { root, storageId } = config;
      if (typeof root !== "string" || !path.isAbsolute(root) || path.resolve(root) !== root || root.includes("\0"))
        fail("invalid_root");
      if (typeof storageId !== "string" || !STORAGE_ID.test(storageId)) fail("invalid_root");
      if (options === null || typeof options !== "object"
        || options.after !== undefined && typeof options.after !== "function") fail("invalid_root");
      const identity = await directoryIdentity(root);
      await maintenanceFilesystem(root);
      return new MemoryObjectStore({ root, storageId }, identity, options);
    } catch (error) { throw toStoreError(error, "root"); }
  }

  private async assertRoot(): Promise<void> {
    const current = await directoryIdentity(this.root);
    if (current.device !== this.#identity.device || current.inode !== this.#identity.inode) fail("control_root_mismatch");
  }

  private parseOwnedRef(value: unknown): Readonly<MemoryObjectRef> {
    let parsed: Readonly<MemoryObjectRef>;
    try { parsed = parseMemoryObjectRef(value); }
    catch { return fail("invalid_ref"); }
    if (parsed.storageId !== this.storageId || !RELATIVE_KEY.test(memoryObjectRelativeKey(parsed))) fail("invalid_ref");
    return parsed;
  }

  private async ensureDirectory(relative: string): Promise<string> {
    let current = this.root;
    for (const part of relative.split("/")) {
      if (!PART.test(part)) fail("invalid_ref");
      const parent = current;
      current = path.join(current, part);
      try {
        await mkdir(current, { mode: 0o700 });
        await syncDirectory(current);
        await syncDirectory(parent);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST") throw error;
      }
      await directoryIdentity(current);
    }
    return current;
  }

  private async signal(point: PublishPoint): Promise<void> {
    this.#inAfterHook = true;
    try {
      try { await this.#after?.(point); }
      catch { fail("publication_failed"); }
    } finally { this.#inAfterHook = false; }
  }

  /** Serializes publication: avoids transient nlink>1 and Darwin parent-directory link-count races; `link` is the atomic gate. */
  private async serialize<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#serializers.get(key) ?? Promise.resolve();
    const run: Promise<T> = previous.then(action, action);
    const tail: Promise<void> = run.then(() => undefined, () => undefined);
    this.#serializers.set(key, tail);
    try { return await run; }
    finally { if (this.#serializers.get(key) === tail) this.#serializers.delete(key); }
  }

  private async openVerified(value: unknown): Promise<{ handle: FileHandle; ref: Readonly<MemoryObjectRef> }> {
    await this.assertRoot();
    const ref = this.parseOwnedRef(value);
    const file = path.join(this.root, memoryObjectRelativeKey(ref));
    await directoryIdentity(path.dirname(file));
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat({ bigint: true });
      if (!info.isFile() || info.nlink !== 1n || info.size !== BigInt(ref.byteLength)
        || (info.mode & 0o777n) !== 0o600n) fail("object_integrity");
    } catch (error) { await handle.close(); throw error; }
    return { handle, ref };
  }

  private async verifiedBytes(value: unknown): Promise<{ bytes: Uint8Array; ref: Readonly<MemoryObjectRef> }> {
    const { handle, ref } = await this.openVerified(value);
    try {
      const bytes = new Uint8Array(await handle.readFile());
      if (bytes.byteLength !== ref.byteLength || createHash("sha256").update(bytes).digest("hex") !== ref.contentSha256)
        fail("object_integrity");
      decodeMemoryObjectBody(bytes, MAX_BODY_BYTES);
      return { bytes, ref };
    } finally { await handle.close(); }
  }

  /** Encode, fsync a private staging file, then publish under a content-addressed immutable name. */
  async put(markdown: unknown): Promise<Readonly<MemoryObjectRef>> {
    let staging: string | undefined;
    let temp: string | undefined;
    try {
      if (this.#inAfterHook) fail("publication_failed");
      await this.assertRoot();
      const body = encodeMemoryObjectBody(markdown, MAX_BODY_BYTES);
      const ref = parseMemoryObjectRef({
        objectFormat: "utf8-sha256-v1", storageId: this.storageId,
        contentSha256: body.contentSha256, byteLength: body.byteLength,
      });
      const relative = memoryObjectRelativeKey(ref);
      return await this.serialize("publish", async () => {
        staging = await this.ensureDirectory("staging");
        const shard = await this.ensureDirectory(path.posix.dirname(relative));
        const target = path.join(this.root, relative);
        await this.assertRoot();
        temp = path.join(staging, `${ref.contentSha256}-${randomUUID()}.tmp`);
        const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          const info = await handle.stat({ bigint: true });
          if (!info.isFile() || info.nlink !== 1n || (info.mode & 0o777n) !== 0o600n) fail("publication_failed");
          await handle.writeFile(body.bytes);
          await this.signal("temp_written");
          await syncMaintenanceHandle(handle);
          await this.signal("file_synced");
        } finally { await handle.close(); }
        await this.assertRoot();
        try {
          await link(temp, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST") throw error;
          await this.confirmDurable(ref);
          await unlink(temp);
          await syncDirectory(staging);
          await this.assertRoot();
          return ref;
        }
        await unlink(temp);
        await this.signal("renamed");
        await syncDirectory(shard);
        await syncDirectory(staging);
        await this.signal("directory_synced");
        await this.verifiedBytes(ref);
        await this.assertRoot();
        return ref;
      });
    } catch (error) {
      if (temp !== undefined && staging !== undefined) {
        try { await unlink(temp); }
        catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException | null)?.code !== "ENOENT") { /* original failure wins */ }
        }
        try { await syncDirectory(staging); }
        catch { /* original failure wins */ }
      }
      throw toStoreError(error, "put");
    }
  }

  /** Read the exact published markdown, rejecting any path, shape, permission or content mismatch. */
  async read(value: unknown): Promise<string> {
    try {
      const { bytes } = await this.verifiedBytes(value);
      const markdown = decodeMemoryObjectBody(bytes, MAX_BODY_BYTES).markdown;
      await this.assertRoot();
      return markdown;
    } catch (error) { throw toStoreError(error, "read"); }
  }

  /** Recheck bytes and resync the published file and its directory chain; no database is consulted. */
  async confirmDurable(value: unknown): Promise<Readonly<MemoryObjectDurabilityConfirmation>> {
    try {
      const { handle, ref } = await this.openVerified(value);
      const file = path.join(this.root, memoryObjectRelativeKey(ref));
      try {
        const bytes = new Uint8Array(await handle.readFile());
        if (bytes.byteLength !== ref.byteLength || createHash("sha256").update(bytes).digest("hex") !== ref.contentSha256)
          fail("object_integrity");
        decodeMemoryObjectBody(bytes, MAX_BODY_BYTES);
        await syncMaintenanceHandle(handle);
      } finally { await handle.close(); }
      for (let parent = path.dirname(file); ; parent = path.dirname(parent)) {
        await syncDirectory(parent);
        if (parent === this.root) break;
      }
      await this.assertRoot();
      return Object.freeze({ ref, objectDigest: ref.contentSha256,
        completed: Object.freeze(["file_sync", "immutable_name_verified", "directory_sync"]) as
          readonly ["file_sync", "immutable_name_verified", "directory_sync"] });
    } catch (error) { throw toStoreError(error, "confirm"); }
  }

  /** Thin value-layer gate: caller-supplied, already-confirmed digests and head values only. */
  decideHeadCommit(value: MemoryObjectHeadGateInput): Readonly<MemoryHeadCommitDecisionValue> {
    try {
      if (value === null || typeof value !== "object") fail("invalid_gate_input");
      const { durableObjectDigests, plan, currentHead, expectedHead, targetHead, mutation } = value;
      if (!Array.isArray(durableObjectDigests) || !durableObjectDigests.every(item => typeof item === "string" && DIGEST.test(item)))
        fail("invalid_gate_input");
      const head = (item: Readonly<MemoryHeadCommitHeadValue>) => Object.freeze({
        version: item.version, receipt: item.receipt, digest: item.digest,
        mutationKey: item.mutationKey, contentDigest: item.contentDigest,
      });
      return decideHeadCommit(Object.freeze({
        contract: "memory-head-commit-input/r1" as const,
        plan, durableObjectDigests: Object.freeze([...durableObjectDigests]),
        currentHead: head(currentHead), expectedHead: head(expectedHead), targetHead: head(targetHead),
        mutation: Object.freeze({ key: mutation.key, contentDigest: mutation.contentDigest }),
      }));
    } catch (error) { throw toStoreError(error, "gate"); }
  }
}

/** Factory for the minimal store; the single-instance-per-root and interrupted-publication contracts are on MemoryObjectStore. */
export async function createMemoryObjectStore(config: MemoryObjectStoreConfig,
  options: MemoryObjectStoreOptions = {}): Promise<MemoryObjectStore> {
  return MemoryObjectStore.create(config, options);
}

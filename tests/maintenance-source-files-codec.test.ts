import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, parseCanonical } from "../src/server/storage/maintenance/canonical.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";
import { parseSourceFiles, readSourceFiles } from "../src/server/storage/maintenance/parse.ts";

// Synthetic protocol vectors only: these are not observations, provider qualification or restore evidence.
function vector(profile: "ext4" | "overlay" = "ext4") {
  const identity = { path: "/structural-source/config.json", device: "3", inode: "11" };
  const handle = profile === "ext4" ? { type: 1, byteCount: 8, hex: "0123456789abcdef" }
    : { type: 248, byteCount: 32, hex: "0123456789abcdef".repeat(4) };
  const payload = { ref: `snapshots/${"a".repeat(64)}/source-file-payload.bin`, sha256: "a".repeat(64), bytes: "5" };
  return {
    formatVersion: 2, kind: "source-files",
    source: { kind: "sqlite", databaseInstanceId: "1".repeat(32), identityDigest: "2".repeat(64) },
    roots: [{ label: "config", path: identity.path, expected: { path: identity.path, existingAncestor: identity, absentSegments: [] as string[] } }],
    rootBindings: [{ sourceRoot: "config", profile: profile === "ext4" ? "linux-native-ext4-fid-fsuuid-v1" : "linux-overlay-fid-fsuuid-v1",
      hostIdentityDigest: "3".repeat(64), filesystemType: profile, filesystemUuidHex: "4".repeat(32),
      anchorPath: identity.path, anchorKind: "file", anchorHandle: handle }],
    entries: [{ sourceRoot: "config", sourceRelativePath: "", kind: "file", identity, mode: "600", size: "5", payload,
      sourceWitness: { kind: "file", incarnation: handle,
        change: { mtimeNs: "900719925474099312345", ctimeNs: "-900719925474099312345", observedBirthtimeNs: "0" as string | null } } }],
    sourceMembershipExclusions: ["database-files", "entire-maintenance-control-root", "all-maintenance-artifacts"],
  };
}
const invalid = (error: unknown) => error instanceof MaintenanceFailure && error.code === "snapshot_invalid";

function directoryVector(absent = false) {
  const value = vector(), identity = { path: "/structural-source/sessions", device: "3", inode: "12" };
  const ancestor = absent ? { ...identity, path: "/structural-source", inode: "10" } : identity;
  return { ...value,
    roots: [{ label: "managed-sessions", path: identity.path,
      expected: { path: identity.path, existingAncestor: ancestor, absentSegments: absent ? ["sessions"] : [] } }],
    rootBindings: [{ ...value.rootBindings[0]!, sourceRoot: "managed-sessions", anchorPath: ancestor.path, anchorKind: "directory" }],
    entries: [{ sourceRoot: "managed-sessions", sourceRelativePath: "", kind: absent ? "absent" : "directory",
      identity: absent ? null : identity, mode: absent ? null : "700", size: null, payload: null,
      sourceWitness: absent ? null : { kind: "directory", incarnation: value.rootBindings[0]!.anchorHandle } }],
  };
}

test("#152 FSI-08/16: both fixed Fs v2 codecs preserve exact canonical bytes and signed nanoseconds", () => {
  for (const profile of ["ext4", "overlay"] as const) {
    const expected = vector(profile), bytes = Buffer.from(canonicalJson(expected));
    const parsed = parseSourceFiles(parseCanonical(bytes));
    assert.deepEqual(parsed, expected);
    assert.equal(canonicalJson(parsed), bytes.toString("utf8"));
    assert.equal(parsed.entries[0]!.sourceWitness?.kind, "file");
    expected.entries[0]!.sourceWitness.change.observedBirthtimeNs = null;
    assert.deepEqual(parseSourceFiles(expected), expected);
  }
});

test("#152 FSI-08: an anchored v1 body is invalid without live filling or an in-place upgrade", () => {
  const { rootBindings: _bindings, ...body } = vector();
  const legacy = { ...body, formatVersion: 1, entries: body.entries.map(({ sourceWitness: _witness, ...entry }) => entry) };
  const before = canonicalJson(legacy);
  assert.throws(() => parseSourceFiles(legacy), invalid);
  assert.equal(canonicalJson(legacy), before);
});

test("#152 FSI-08: unknown, mixed and non-exact profile codecs are snapshot_invalid", () => {
  const value = vector(), binding = value.rootBindings[0]!;
  for (const change of [
    { profile: "unknown" }, { filesystemType: "overlay" }, { filesystemUuidHex: "0".repeat(32) },
    { filesystemUuidHex: "A".repeat(32) }, { filesystemUuidHex: "4".repeat(32) + "\n" },
    { hostIdentityDigest: "3".repeat(63) }, { hostIdentityDigest: "3".repeat(64) + "\n" },
    { anchorHandle: { type: 248, byteCount: 32, hex: "0".repeat(64) } },
    { anchorHandle: { type: 1, byteCount: 8, hex: "ABCDEF0123456789" } },
    { anchorHandle: { type: 1, byteCount: 8, hex: "0123456789abcdef\n" } },
    { anchorHandle: { type: 1, byteCount: 7, hex: "0123456789abcdef" } },
    { anchorHandle: { ...binding.anchorHandle, generation: "1" } }, { future: "not part of this codec" },
  ]) assert.throws(() => parseSourceFiles({ ...value, rootBindings: [{ ...binding, ...change }] }), invalid);
  assert.throws(() => parseSourceFiles({ ...value, rootBindings: [] }), invalid);
  assert.throws(() => parseSourceFiles({ ...value, roots: [], rootBindings: [], entries: [] }), invalid);
  const { anchorHandle: _handle, ...missing } = binding;
  assert.throws(() => parseSourceFiles({ ...value, rootBindings: [missing] }), invalid);
  assert.throws(() => parseSourceFiles({ ...value, extra: true }), invalid);
});

test("#152 FSI-08: witness kinds and all three exact nanosecond fields reject lossy or extra representations", () => {
  const value = vector(), entry = value.entries[0]!, witness = entry.sourceWitness;
  for (const field of ["mtimeNs", "ctimeNs", "observedBirthtimeNs"])
    for (const bad of ["-0", "00", "-01", "+1", " 1", "1 ", "1\n", "1\r", "1\r\n", "1e3", "1.5", 0, false, undefined])
      assert.throws(() => parseSourceFiles({ ...value, entries: [{ ...entry,
        sourceWitness: { ...witness, change: { ...witness.change, [field]: bad } } }] }), invalid, `${field}: ${String(bad)}`);
  for (const bad of [null, { ...witness, kind: "directory" }, { ...witness, future: true },
    { ...witness, change: { ...witness.change, birthtimeReliable: true } }])
    assert.throws(() => parseSourceFiles({ ...value, entries: [{ ...entry, sourceWitness: bad }] }), invalid);
  const directory = directoryVector(), item = directory.entries[0]!;
  assert.deepEqual(parseSourceFiles(directory), directory);
  assert.throws(() => parseSourceFiles({ ...directory, entries: [{ ...item,
    sourceWitness: { ...item.sourceWitness, change: witness.change } }] }), invalid);
});

test("#152 FSI-16: roots, bindings and present entries form one exact ordered identity closure", () => {
  const value = vector(), root = value.roots[0]!, binding = value.rootBindings[0]!, entry = value.entries[0]!;
  const directory = directoryVector();
  const twoRoots = { ...value, roots: [...value.roots, ...directory.roots],
    rootBindings: [...value.rootBindings, ...directory.rootBindings], entries: [...value.entries, ...directory.entries] };
  assert.deepEqual(parseSourceFiles(twoRoots), twoRoots);
  const badBodies = [
    { ...twoRoots, rootBindings: [...twoRoots.rootBindings].reverse() },
    { ...value, roots: [root, root], rootBindings: [binding, binding] },
    { ...value, rootBindings: [binding, binding] },
    { ...value, rootBindings: [{ ...binding, sourceRoot: "managed-sessions" }] },
    { ...value, rootBindings: [{ ...binding, anchorPath: "/different/config.json" }] },
    { ...value, rootBindings: [{ ...binding, anchorKind: "directory" }] },
    { ...value, roots: [{ ...root, path: "relative/config.json" }] },
    { ...value, roots: [{ ...root, expected: { ...root.expected, path: "/different/config.json" } }] },
    { ...value, roots: [{ ...root, expected: { ...root.expected, absentSegments: ["missing"] } }] },
    { ...value, entries: [] }, { ...value, entries: [entry, entry] },
    { ...value, entries: [{ ...entry, sourceRoot: "missing-root" }] },
    { ...value, entries: [{ ...entry, sourceRelativePath: "../config.json" }] },
    { ...value, entries: [{ ...entry, identity: { ...entry.identity, inode: "99" } }] },
    { ...value, entries: [{ ...entry, sourceWitness: { ...entry.sourceWitness,
      incarnation: { type: 1, byteCount: 8, hex: "fedcba9876543210" } } }] },
    { ...value, entries: [{ ...entry, sourceWitness: { ...entry.sourceWitness,
      incarnation: { type: 248, byteCount: 32, hex: "0123456789abcdef".repeat(4) } } }] },
  ];
  for (const [index, bad] of badBodies.entries()) assert.throws(() => parseSourceFiles(bad), invalid, `closure case ${index}`);
});

test("#152 FSI-16: absent roots retain an ancestor binding and no invented incarnation or descendants", () => {
  const value = directoryVector(true), entry = value.entries[0]!, root = value.roots[0]!, binding = value.rootBindings[0]!;
  assert.deepEqual(parseSourceFiles(value), value);
  for (const bad of [
    { ...value, rootBindings: [] }, { ...value, rootBindings: [{ ...binding, anchorKind: "file" }] },
    { ...value, rootBindings: [{ ...binding, anchorPath: root.path }] },
    { ...value, roots: [{ ...root, expected: { ...root.expected, absentSegments: [] } }] },
    { ...value, roots: [{ ...root, expected: { ...root.expected, absentSegments: ["..", "sessions"] } }] },
    { ...value, entries: [{ ...entry, sourceWitness: { kind: "directory", incarnation: binding.anchorHandle } }] },
    { ...value, entries: [entry, { ...vector().entries[0]!, sourceRoot: entry.sourceRoot, sourceRelativePath: "child" }] },
  ]) assert.throws(() => parseSourceFiles(bad), invalid);
});

test("#152 FSI-16: child witnesses follow their root profile without borrowing the root incarnation", () => {
  const value = directoryVector(), directory = value.entries[0]!, binding = value.rootBindings[0]!;
  const file = vector().entries[0]!;
  const child = { ...file, sourceRoot: directory.sourceRoot, sourceRelativePath: "child.json",
    identity: { ...file.identity, path: "/structural-source/sessions/child.json", inode: "13" },
    sourceWitness: { ...file.sourceWitness, incarnation: { type: 1, byteCount: 8, hex: "fedcba9876543210" } } };
  const withChild = { ...value, entries: [directory, child] };
  assert.deepEqual(parseSourceFiles(withChild), withChild);
  assert.throws(() => parseSourceFiles({ ...withChild, entries: [directory, { ...child,
    sourceWitness: { ...child.sourceWitness, incarnation: vector("overlay").entries[0]!.sourceWitness.incarnation } }] }), invalid);
  for (const anchorPath of ["/structural-source/./sessions", "/structural-source/sessions/", "relative/sessions", "/structural-source/\0sessions"]) {
    const root = value.roots[0]!, identity = { ...directory.identity!, path: anchorPath };
    assert.throws(() => parseSourceFiles({ ...value,
      roots: [{ ...root, path: anchorPath, expected: { ...root.expected, path: anchorPath, existingAncestor: identity } }],
      rootBindings: [{ ...binding, anchorPath }], entries: [{ ...directory, identity }] }), invalid);
  }
});

test("#152 Fs v2 payload references are exact leaf roles with byte counts, never hidden control objects", () => {
  const value = vector(), entry = value.entries[0]!;
  for (const payload of [
    { ...entry.payload, ref: `snapshots/${entry.payload.sha256}/source-files.json` },
    { ...entry.payload, ref: `plans/${entry.payload.sha256}.json` },
    { ...entry.payload, ref: `snapshots/${"b".repeat(64)}/source-file-payload.bin` },
    { ...entry.payload, sha256: entry.payload.sha256 + "\n" }, { ...entry.payload, bytes: "6" },
  ]) assert.throws(() => parseSourceFiles({ ...value, entries: [{ ...entry, payload }] }), invalid);
  assert.throws(() => parseSourceFiles({ ...value, entries: [{ ...entry, size: "5\n", payload: { ...entry.payload, bytes: "5\n" } }] }), invalid);
  assert.throws(() => parseSourceFiles({ ...value, entries: [{ ...entry, mode: "600\n" }] }), invalid);
  assert.throws(() => parseSourceFiles({ ...value, source: { ...value.source, identityDigest: value.source.identityDigest + "\n" } }), invalid);
  assert.throws(() => parseSourceFiles({ ...value, source: { ...value.source, databaseInstanceId: value.source.databaseInstanceId + "\n" } }), invalid);
  const identity = { ...entry.identity, inode: "11\n" }, root = value.roots[0]!;
  assert.throws(() => parseSourceFiles({ ...value, roots: [{ ...root, expected: { ...root.expected, existingAncestor: identity } }], entries: [{ ...entry, identity }] }), invalid);
});

test("#152 FSI-08: Fs decoding preserves failures from the store instead of reclassifying them", async () => {
  const reference = { ref: `snapshots/${"a".repeat(64)}/source-files.json`, sha256: "a".repeat(64), bytes: "1" };
  // Inject only upstream errors; this makes no claim of a real mutex, source or runtime capability.
  for (const error of [new MaintenanceFailure("maintenance_lost"), new MaintenanceFailure("control_root_mismatch"),
    new MaintenanceFailure("unsupported_durability"), new MaintenanceFailure("journal_invalid"),
    Object.assign(new Error("synthetic I/O failure"), { code: "EIO" })]) {
    await assert.rejects(readSourceFiles({ kindFor: () => "source-files", readBytes: async () => { throw error; } }, reference),
      observed => observed === error);
    await assert.rejects(readSourceFiles({ kindFor: () => { throw error; }, readBytes: async () => Buffer.from("{") }, reference),
      observed => observed === error);
  }
  assert.throws(() => parseCanonical(Buffer.from("{")), error => error instanceof MaintenanceFailure && error.code === "journal_invalid");
});

import test from "node:test";
import assert from "node:assert/strict";
import { parseSourceFiles } from "../src/server/storage/maintenance/parse.ts";
import { projectRestoreContent } from "../src/server/storage/maintenance/restore-content.ts";

// Synthetic protocol fixtures, not native observations, target scans or restore evidence.
function sourceFiles(profile: "ext4" | "overlay") {
  const native = profile === "ext4", base = `/synthetic-${profile}`, sessions = `${base}/sessions`;
  const identity = (path: string, inode: string) => ({ path, inode, device: native ? "1" : "2" });
  const incarnation = (byte: string) => native ? { type: 1, byteCount: 8, hex: byte.repeat(8) }
    : { type: 248, byteCount: 32, hex: byte.repeat(32) };
  const binding = (sourceRoot: string, anchorPath: string, byte: string) => ({ sourceRoot, anchorPath, anchorKind: "directory",
    profile: native ? "linux-native-ext4-fid-fsuuid-v1" : "linux-overlay-fid-fsuuid-v1", filesystemType: profile,
    hostIdentityDigest: (native ? "3" : "4").repeat(64), filesystemUuidHex: (native ? "5" : "6").repeat(32), anchorHandle: incarnation(byte) });
  const payload = (digest: string, bytes: string) => ({ ref: `snapshots/${digest}/source-file-payload.bin`, sha256: digest, bytes });
  const fileWitness = (byte: string) => ({ kind: "file", incarnation: incarnation(byte),
    change: { mtimeNs: native ? "900719925474099312345" : "1", ctimeNs: native ? "2" : "-3", observedBirthtimeNs: native ? "0" : null } });
  return parseSourceFiles({ formatVersion: 2, kind: "source-files",
    source: { kind: "sqlite", databaseInstanceId: (native ? "7" : "8").repeat(32), identityDigest: (native ? "9" : "b").repeat(64) },
    roots: [
      { label: "config", path: `${base}/config.json`, expected: { path: `${base}/config.json`, existingAncestor: identity(base, "100"), absentSegments: ["config.json"] } },
      { label: "managed-sessions", path: sessions, expected: { path: sessions, existingAncestor: identity(sessions, "101"), absentSegments: [] } },
    ],
    rootBindings: [binding("config", base, "11"), binding("managed-sessions", sessions, "22")],
    entries: [
      { sourceRoot: "managed-sessions", sourceRelativePath: "", kind: "directory", identity: identity(sessions, "101"), mode: "0750", size: "4096", payload: null,
        sourceWitness: { kind: "directory", incarnation: incarnation("22") } },
      { sourceRoot: "managed-sessions", sourceRelativePath: "z.txt", kind: "file", identity: identity(`${sessions}/z.txt`, "102"), mode: "0640", size: "900719925474099312345",
        payload: payload("a".repeat(64), "900719925474099312345"), sourceWitness: fileWitness("33") },
      { sourceRoot: "config", sourceRelativePath: "", kind: "absent", identity: null, mode: null, size: null, payload: null, sourceWitness: null },
      { sourceRoot: "managed-sessions", sourceRelativePath: "empty", kind: "directory", identity: identity(`${sessions}/empty`, "103"), mode: "700", size: null, payload: null,
        sourceWitness: { kind: "directory", incarnation: incarnation("44") } },
      { sourceRoot: "managed-sessions", sourceRelativePath: "a.txt", kind: "file", identity: identity(`${sessions}/a.txt`, "104"), mode: "600", size: "5",
        payload: payload("b".repeat(64), "5"), sourceWitness: fileWitness("55") },
    ], sourceMembershipExclusions: ["database-files", "entire-maintenance-control-root", "all-maintenance-artifacts"],
  });
}

const expected = [
  { sourceRoot: "managed-sessions", relativePath: "", kind: "directory", mode: "0750", size: "4096", contentDigest: null },
  { sourceRoot: "managed-sessions", relativePath: "z.txt", kind: "file", mode: "0640", size: "900719925474099312345", contentDigest: "a".repeat(64) },
  { sourceRoot: "config", relativePath: "", kind: "absent", mode: null, size: null, contentDigest: null },
  { sourceRoot: "managed-sessions", relativePath: "empty", kind: "directory", mode: "700", size: null, contentDigest: null },
  { sourceRoot: "managed-sessions", relativePath: "a.txt", kind: "file", mode: "600", size: "5", contentDigest: "b".repeat(64) },
];

test("#152 FSI-11 pure projection: identical content in both Fs v2 codecs excludes different source identities", () => {
  const ext4 = sourceFiles("ext4"), overlay = sourceFiles("overlay");
  assert.notDeepEqual(ext4, overlay); // Equal content never proves an unchanged source.
  assert.deepEqual(projectRestoreContent(ext4), expected);
  assert.deepEqual(projectRestoreContent(overlay), expected);
});

test("#152 FSI-11 pure projection: content and membership differences remain observable", () => {
  const source = sourceFiles("ext4"), file = source.entries[1]!, directory = source.entries[3]!;
  assert.ok(file.kind === "file" && directory.kind === "directory");
  const replace = (index: number, entry: unknown) => ({ ...source, entries: source.entries.map((original, offset) => offset === index ? entry : original) });
  const changedDigest = "c".repeat(64), changedSize = "900719925474099312346";
  const variants = [
    ["relative path", replace(1, { ...file, sourceRelativePath: "renamed.txt", identity: { ...file.identity, path: `${source.roots[1]!.path}/renamed.txt` } })],
    ["mode", replace(1, { ...file, mode: "0600" })],
    ["exact size", replace(1, { ...file, size: changedSize, payload: { ...file.payload, bytes: changedSize } })],
    ["payload digest", replace(1, { ...file, payload: { ...file.payload, sha256: changedDigest, ref: `snapshots/${changedDigest}/source-file-payload.bin` } })],
    ["kind", replace(3, { ...file, sourceRelativePath: directory.sourceRelativePath, identity: directory.identity, mode: directory.mode })],
    ["membership", { ...source, entries: source.entries.filter((_, index) => index !== 3) }],
  ] as const;
  for (const [label, candidate] of variants)
    assert.notDeepEqual(projectRestoreContent(parseSourceFiles(candidate)), expected, label);
});

test("#152 FSI-11 pure projection: all entries keep their order and nullable values without mutating the source", () => {
  const source = sourceFiles("ext4"), before = structuredClone(source);
  function freeze(value: unknown): void {
    if (value === null || typeof value !== "object") return;
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  freeze(source);
  assert.deepEqual(projectRestoreContent(source), expected);
  assert.deepEqual(source, before);
  const reordered = parseSourceFiles({ ...source, entries: [...source.entries].reverse() });
  assert.deepEqual(projectRestoreContent(reordered), [...expected].reverse());
});

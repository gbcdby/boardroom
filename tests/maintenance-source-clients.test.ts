import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canonicalJson } from "../src/server/storage/maintenance/canonical.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";
import { parseJournal } from "../src/server/storage/maintenance/parse.ts";
import { buildSourceClientsRoster, parseSourceClientsRoster, sourceClientsDigest } from "../src/server/storage/maintenance/source-clients.ts";
import type { SourceClientsRosterV1 } from "../src/server/storage/maintenance/types.ts";

interface Vector { name: string; input: unknown; canonicalEnvelope: string; sha256: string }
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/maintenance-source-clients-v1.json", import.meta.url), "utf8")) as {
  originalHostJsonUtf8: string;
  vectors: Vector[];
  rawByteVectors: Vector[];
};
const original = () => JSON.parse(fixtures.rawByteVectors[0]!.canonicalEnvelope) as SourceClientsRosterV1;
const invalid = (error: unknown) => error instanceof MaintenanceFailure && error.code === "journal_invalid"
  && error.message === "storage_maintenance: journal_invalid (source)";
function rejects(value: unknown) {
  assert.throws(() => buildSourceClientsRoster(value), invalid);
  assert.throws(() => parseSourceClientsRoster(value), invalid);
  assert.throws(() => sourceClientsDigest(value), invalid);
}
const withCell = (column: string, value: unknown) => ({ ...original(), rows: [{ ...original().rows[0], [column]: value }] });

test("SC-A01/A03/A05: fixed raw rows and independent canonical/digest vectors", () => {
  for (const vector of fixtures.vectors) {
    const inputBefore = canonicalJson(vector.input);
    const built = buildSourceClientsRoster(vector.input);
    assert.equal(canonicalJson(buildSourceClientsRoster(vector.input)), canonicalJson(built));
    assert.equal(canonicalJson(vector.input), inputBefore);
    assert.equal(canonicalJson(built), vector.canonicalEnvelope, vector.name);
    assert.equal(sourceClientsDigest(built), vector.sha256, vector.name);
    assert.deepEqual(parseSourceClientsRoster(JSON.parse(vector.canonicalEnvelope)), built, vector.name);
  }
});

test("SC-A01: complete sixteen columns, exact native tags and integer bounds reject lossy or missing input", async t => {
  for (const column of Object.keys(original().rows[0]!)) await t.test(column, () => {
    const row: Record<string, unknown> = { ...original().rows[0] };
    delete row[column]; rejects({ ...original(), rows: [row] });
    for (const wrong of [null, true, 1, "1", [], ["null", "extra"], ["blob", "00"], ["real", "1.0"]]) rejects(withCell(column, wrong));
    const integerColumn = ["protocol_version", "registered_epoch", "observed_epoch", "drain_epoch"].includes(column);
    rejects(withCell(column, integerColumn ? ["text", "31"] : ["integer", "1"]));
  });
  for (const wrong of ["", "01", "+1", "-1", "1.0", "1e0", "0x10", " 1", "1 ", "1\n", "9223372036854775808", "9".repeat(100), 1, 9007199254740992]) {
    for (const column of ["registered_epoch", "observed_epoch", "drain_epoch"]) rejects(withCell(column, ["integer", wrong]));
  }
  for (const wrong of ["0", "2", "01", 1, "1\n"]) rejects(withCell("protocol_version", ["integer", wrong]));
  for (const wrong of ["0", "-1", "00", "01", "1.0", "1e0", "1\n", "9007199254740992", 1, Number.MAX_SAFE_INTEGER + 1]) {
    rejects({ ...original(), fenceEpoch: wrong }); rejects({ ...original(), receiptGeneration: wrong });
  }
  for (const value of ["0", "9007199254740993", "9223372036854775807"]) {
    const parsed = parseSourceClientsRoster(withCell("observed_epoch", ["integer", value]));
    assert.deepEqual(parsed.rows[0]!.observed_epoch, ["integer", value]);
  }
  assert.equal(parseSourceClientsRoster({ ...original(), fenceEpoch: "9007199254740991", receiptGeneration: "9007199254740991" }).fenceEpoch, "9007199254740991");
});

test("SC-A01/A02: NULL, empty text and original JSON, Unicode, NUL and invalid text bytes stay distinct", () => {
  const digests = new Set<string>();
  for (const vector of fixtures.rawByteVectors) {
    const parsed = parseSourceClientsRoster(vector.input);
    assert.equal(canonicalJson(parsed), vector.canonicalEnvelope, vector.name);
    assert.equal(sourceClientsDigest(parsed), vector.sha256, vector.name);
    assert.ok(!digests.has(vector.sha256)); digests.add(vector.sha256);
  }
  assert.equal(Buffer.from(original().rows[0]!.host_identity_json[1], "hex").toString("utf8"), fixtures.originalHostJsonUtf8);
  for (const wrong of ["0", "ABCDEF", "0g", "aa\n", "aa\r\n", "aa ", " 00", 0]) rejects(withCell("host_identity_json", ["text", wrong]));
  rejects(withCell("client_id", ["null"]));
  rejects(withCell("client_id", ["text", "61", "extra"]));
  rejects(withCell("client_id", ["text"]));
});

test("SC-A02/A06: both entry points bind SourceRef.kind to the exact database encoding domain", () => {
  for (const name of ["UTF-8", "UTF-16le", "UTF-16be"]) {
    const value = { ...original(), textEncoding: { backend: "sqlite", name } };
    assert.equal(buildSourceClientsRoster(value).textEncoding.name, name);
    assert.equal(parseSourceClientsRoster(value).textEncoding.name, name);
  }
  const postgres = { ...original(), source: { ...original().source, kind: "postgres" }, textEncoding: { backend: "postgres", name: "UTF8" } };
  assert.deepEqual(parseSourceClientsRoster(postgres).rows, original().rows);
  assert.notEqual(sourceClientsDigest(postgres), fixtures.rawByteVectors[0]!.sha256);
  const serverNames = ["EUC_CN", "EUC_JP", "EUC_JIS_2004", "EUC_KR", "EUC_TW", "ISO_8859_5", "ISO_8859_6", "ISO_8859_7", "ISO_8859_8", "KOI8R", "KOI8U",
    "LATIN1", "LATIN2", "LATIN3", "LATIN4", "LATIN5", "LATIN6", "LATIN7", "LATIN8", "LATIN9", "LATIN10", "MULE_INTERNAL", "SQL_ASCII", "UTF8",
    "WIN866", "WIN874", "WIN1250", "WIN1251", "WIN1252", "WIN1253", "WIN1254", "WIN1255", "WIN1256", "WIN1257", "WIN1258"];
  for (const name of serverNames) {
    const value = { ...postgres, textEncoding: { backend: "postgres", name } };
    assert.equal(buildSourceClientsRoster(value).textEncoding.name, name);
    assert.equal(parseSourceClientsRoster(value).textEncoding.name, name);
  }
  for (const name of ["UTF8", "utf8", "utf-8", "UTF-8 ", "UTF-8\n", "UTF-16LE", "ASCII"]) rejects({ ...original(), textEncoding: { backend: "sqlite", name } });
  for (const name of ["UTF-8", "utf8", "UTF8 ", "UTF8\n", "UNICODE", "BIG5", "SJIS", "windows-1252", "LATIN11"]) rejects({ ...postgres, textEncoding: { backend: "postgres", name } });
  rejects({ ...original(), textEncoding: postgres.textEncoding });
  rejects({ ...postgres, textEncoding: original().textEncoding });
  rejects({ ...original(), textEncoding: { ...original().textEncoding, client_encoding: "UTF8" } });
  rejects({ ...original(), textEncoding: { backend: "sqlite" } });
});

test("SC-A03: sorting uses unsigned original ID bytes, never locale; persisted order and duplicates fail", () => {
  const ids = ["", "00", "0000", "007f", "0080", "01", "7f", "80", "ff"];
  const rows = ids.map(value => ({ ...original().rows[0]!, client_id: ["text", value] as const }));
  const input = { ...original(), rows: [...rows].reverse() };
  const before = canonicalJson(input);
  const built = buildSourceClientsRoster(input);
  assert.equal(canonicalJson(input), before);
  assert.deepEqual(built.rows.map(row => row.client_id[1]), ids);
  assert.deepEqual(parseSourceClientsRoster({ ...original(), rows }).rows, built.rows);
  assert.throws(() => parseSourceClientsRoster(input), invalid);
  assert.throws(() => sourceClientsDigest(input), invalid);
  rejects({ ...original(), rows: [rows[1], { ...rows[1], build_id: ["text", "00"] }] });
});

test("SC-A04/A05: exact empty roster remains context-bound; absent/failed/partial inputs never become empty", () => {
  const empty = JSON.parse(fixtures.vectors[0]!.canonicalEnvelope) as SourceClientsRosterV1;
  assert.equal(sourceClientsDigest(empty), fixtures.vectors[0]!.sha256);
  assert.notEqual(fixtures.vectors[0]!.sha256, fixtures.vectors[2]!.sha256);
  for (const rows of [undefined, null, {}, "", { error: "read failed" }, [null]]) rejects({ ...empty, rows });
  for (const field of Object.keys(empty)) {
    const value: Record<string, unknown> = { ...empty }; delete value[field]; rejects(value);
  }
  rejects({ ...original(), rows: [{ ...original().rows[0], extra: ["text", ""] }] });
  rejects({ ...empty, sourceSafe: true });
  rejects({ ...empty, formatVersion: 2 });
  rejects({ ...empty, source: { ...empty.source, extra: 1 } });
  rejects({ ...empty, plan: { ...empty.plan, extra: 1 } });
  for (const field of ["databaseInstanceId", "identityDigest"] as const) rejects({ ...empty, source: { ...empty.source, [field]: empty.source[field] + "\n" } });
  rejects({ ...empty, migrationId: empty.migrationId + "\n" });
  rejects({ ...empty, plan: { ...empty.plan, bytes: empty.plan.bytes + "\n" } });
  const bad = { ...original(), rows: [{ ...original().rows[0], secret: "postgresql://user:password@fixture.invalid/db" }] };
  rejects(bad); // Safe generic errors never contain the raw roster or supplied secret.
});

test("SC-A06/A08: journal v2 requires the complete roster and fifth frozen field; v1 shape stays strict", () => {
  const sourceClients = original(), hash = "a".repeat(64);
  const captured = { formatVersion: 2, kind: "journal", migrationId: sourceClients.migrationId, sequence: 2,
    previous: { ref: `journals/codec-fixture/1-${hash}.json`, sha256: hash, bytes: "123" }, phase: "quiesced", event: "capture",
    requestId: "capture", requestDigest: hash, source: sourceClients.source, plan: sourceClients.plan,
    fenceEpoch: 7, ownerGeneration: 3, evidence: [], sourceClients,
    frozen: { sourceFilesManifest: { ref: `snapshots/${hash}/source-files.json`, sha256: hash, bytes: "123" },
      schemaManifestDigest: hash, frozenBusinessManifestDigest: hash, guardManifestDigest: hash, sourceClientsDigest: fixtures.rawByteVectors[0]!.sha256 }, snapshot: null };
  assert.deepEqual(parseJournal(captured), captured);
  const planned = { ...captured, sequence: 1, previous: null, phase: "planned", event: "enter", frozen: null, sourceClients: null };
  assert.deepEqual(parseJournal(planned), planned);
  const { sourceClients: _roster, ...withoutRoster } = captured;
  const { sourceClientsDigest: _digest, ...legacyFrozen } = captured.frozen;
  for (const value of [withoutRoster, { ...captured, frozen: legacyFrozen },
    { ...captured, sourceClients: { ...sourceClients, textEncoding: { backend: "postgres", name: "UTF8" } } },
    { ...captured, frozen: { ...captured.frozen, sixth: hash } }]) assert.throws(() => parseJournal(value), invalid);
  // v3 is now recognized, but relabeling v2 cannot supply its required proof.
  assert.throws(() => parseJournal({ ...captured, formatVersion: 3 }), error => error instanceof MaintenanceFailure
    && error.code === "journal_invalid" && error.message === "storage_maintenance: journal_invalid (verification-journal)");
  const legacy = { ...withoutRoster, formatVersion: 1, frozen: legacyFrozen };
  assert.deepEqual(parseJournal(legacy), legacy); // Structural legacy decoding is not current-chain acceptance.
  assert.throws(() => parseJournal({ ...legacy, sourceClients: null }), invalid);
  assert.throws(() => parseJournal({ ...legacy, frozen: captured.frozen }), invalid);
});

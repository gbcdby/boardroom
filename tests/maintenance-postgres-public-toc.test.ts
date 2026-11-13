import test from "node:test";
import assert from "node:assert/strict";
import { auditPublicArchiveToc, type PublicRestoreCatalogBinding } from "../src/server/storage/maintenance/postgres-public-toc.ts";

// A deliberately small native projection. Real archives and the complete source catalog are
// exercised through adapter.verifyDatabase in the PG tests; this is parser contract coverage.
const binding: PublicRestoreCatalogBinding = {
  database: { catalog: "1262", oid: "501", name: "source db", owner: "owner with space", quoted: '"source db"' },
  namespace: { catalog: "2615", oid: "2200", name: "public", owner: "pg_database_owner", quoted: "public" },
  pgDump: "16.15", serverVersion: "16.15",
  objects: [
    { catalog: "1259", oid: "601", description: "TABLE", tag: "probe", owner: "owner with space", required: true, parents: ["2615/2200"] },
    { catalog: "2606", oid: "701", description: "CONSTRAINT", tag: "probe probe_pkey", owner: "owner with space", required: true, parents: ["1259/601"] },
  ],
  metadata: [
    { description: "COMMENT", namespace: "-", tag: "SCHEMA public", owner: "pg_database_owner", parent: "2615/2200" },
    { description: "ACL", namespace: "public", tag: "TABLE probe", owner: "owner with space", parent: "1259/601" },
    { description: "ACL", namespace: "public", tag: "COLUMN probe.value", owner: "owner with space", parent: "1259/601", tableAcl: "TABLE probe" },
  ],
  dependencies: [["1259/601", "2615/2200"], ["2606/701", "1259/601"]],
};
function toc(entries: string[], count = entries.filter(line => /^\d+;/.test(line)).length) {
  return `;\n; Archive created at 2026-11-12 00:00:00 UTC\n;     dbname: source db\n;     TOC Entries: ${count}\n;     Compression: gzip\n;     Dump Version: 1.15-0\n;     Format: CUSTOM\n;     Integer: 4 bytes\n;     Offset: 8 bytes\n;     Dumped from database version: 16.15\n;     Dumped by pg_dump version: 16.15\n;\n; Selected TOC Entries:\n;\n${entries.join("\n")}\n`;
}
const normal = [
  "101; 0 0 ENCODING - ENCODING ", "102; 0 0 STDSTRINGS - STDSTRINGS ", "103; 0 0 SEARCHPATH - SEARCHPATH ",
  "104; 1262 501 DATABASE - source db owner with space",
  '105; 0 0 COMMENT - DATABASE "source db" owner with space', ";\tdepends on: 104",
  "106; 0 0 DATABASE PROPERTIES - source db owner with space",
  "4; 2615 2200 SCHEMA - public pg_database_owner",
  "107; 0 0 COMMENT - SCHEMA public pg_database_owner", ";\tdepends on: 4",
  "5; 1259 601 TABLE public probe owner with space", ";\tdepends on: 4",
  "108; 0 601 TABLE DATA public probe owner with space", ";\tdepends on: 5",
  "6; 2606 701 CONSTRAINT public probe probe_pkey owner with space", ";\tdepends on: 5 5",
];

test("#152 public TOC audits all S/D/N/E items and excludes the valid database envelope from execution", () => {
  const result = auditPublicArchiveToc(toc(normal), binding);
  assert.deepEqual(result.sessionIds, [101, 102, 103]);
  assert.deepEqual(result.databaseIds, [104, 105, 106]);
  assert.deepEqual(result.namespaceIds, [4]);
  assert.deepEqual(result.bodyIds, [107, 5, 108, 6]);
  assert.equal(result.entryCount, 11);
});

for (const [name, change] of [
  ["ordinary selected list count", (s: string) => s.replace("TOC Entries: 11", "TOC Entries: 12")],
  ["missing header", (s: string) => s.replace(/;     TOC Entries: .*\n/, "")],
  ["duplicate header", (s: string) => s.replace(";     Format: CUSTOM", ";     Format: CUSTOM\n;     Format: CUSTOM")],
  ["duplicate dump id", (s: string) => s.replace("106;", "104;")],
  ["overflow dump id", (s: string) => s.replace("106;", "2147483648;")],
  ["overflow oid", (s: string) => s.replace("1262 501", "1262 4294967296")],
  ["wrong source database", (s: string) => s.replace("1262 501", "1262 502")],
  ["wrong source namespace", (s: string) => s.replace("2615 2200", "2615 2201")],
  ["wrong properties owner", (s: string) => s.replace("PROPERTIES - source db owner with space", "PROPERTIES - source db other")],
  ["wrong database metadata parent", (s: string) => s.replace("depends on: 104", "depends on: 4")],
  ["duplicate dependency segment", (s: string) => s.replace("depends on: 104", "depends on: 104\n;\tdepends on: 104")],
  ["source object omitted", (s: string) => s.replace("6; 2606 701 CONSTRAINT public probe probe_pkey owner with space", "6; 2606 702 CONSTRAINT public probe probe_pkey owner with space")],
  ["unknown entry", (s: string) => s.replace("CONSTRAINT public", "STATISTICS public")],
  ["large object", (s: string) => s.replace("CONSTRAINT public probe probe_pkey", "BLOB - 701")],
  ["cross schema", (s: string) => s.replace("TABLE public probe", "TABLE other probe")],
  ["unrelated main-object edge", (s: string) => s.replace("depends on: 5 5", "depends on: 104")],
] as const) test(`#152 public TOC rejects ${name} before target execution`, () => {
  assert.throws(() => auditPublicArchiveToc(change(toc(normal)), binding), /snapshot_invalid/);
});

test("#152 column ACL keeps its native TABLE and optional TABLE ACL parents", () => {
  const extra = ["109; 0 0 ACL public TABLE probe owner with space", ";\tdepends on: 5",
    "110; 0 0 ACL public COLUMN probe.value owner with space", ";\tdepends on: 5 109"];
  assert.equal(auditPublicArchiveToc(toc([...normal, ...extra]), binding).bodyIds.at(-1), 110);
  assert.throws(() => auditPublicArchiveToc(toc([...normal, ...extra]).replace("depends on: 5 109", "depends on: 5 107"), binding), /snapshot_invalid/);
});

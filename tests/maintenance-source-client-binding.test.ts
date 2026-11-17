import test from "node:test";
import assert from "node:assert/strict";
import { snapshotBundleFixture } from "./fixtures/maintenance-snapshot-bundle.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";
import { buildDatabaseManifests } from "../src/server/storage/maintenance/manifests.ts";
import { assertCapturedSourceClientBinding } from "../src/server/storage/maintenance/source-client-binding.ts";
import type { DatabaseManifests, Json, SourceClientsObservation } from "../src/server/storage/maintenance/types.ts";

const nativeTest = ["linux", "darwin"].includes(process.platform) ? test : test.skip;
const pgTest = process.env.AGENT_STUDIO_PG_TEST_URL ? test : test.skip;
const changed = (error: unknown) => error instanceof MaintenanceFailure && error.code === "source_changed";

for (const kind of ["sqlite", "postgres"] as const) (kind === "sqlite" ? nativeTest : pgTest)(
  `#228 ${kind}: native capture binding rejects every archive row, type and table difference`, async t => {
    // Reuse #152's unique real source/mutex fixture. These are ordinary in-memory
    // manifest variants: no source edits, B/U rewrites, process proof or restore.
    const f = await snapshotBundleFixture(kind);
    try {
      await f.run(async lock => {
        const observed = await lock.observe(), captured = f.capture.record.sourceClients;
        assert(captured); const archived = observed.manifests, rows = archived.controlRows.storage_source_clients;
        assert(rows.length > 0);
        const rebuild = (values: typeof rows = rows, tables: DatabaseManifests["tables"] = archived.tables) =>
          buildDatabaseManifests(kind, archived.schema, tables, { ...archived.controlRows, storage_source_clients: values });
        const check = (value: DatabaseManifests) => assertCapturedSourceClientBinding(lock, observed, captured, value);
        await check(archived);
        for (const [name, values] of [
          ["added row", [...rows, { ...rows[0]!, client_id: "additional-manifest-client" }]],
          ["missing row", rows.slice(1)], ["duplicate identity", [...rows, rows[0]!]],
        ] as const) await t.test(name, () => assert.rejects(check(rebuild(values)), changed));
        for (const [key, value] of Object.entries(rows[0]!)) await t.test(`changed ${key}`, async () => {
          const replacement: Json = value === null ? "unexpected" : typeof value === "number" ? value + 1 : `${value} changed`;
          await assert.rejects(check(rebuild([{ ...rows[0]!, [key]: replacement }, ...rows.slice(1)])), changed);
        });
        for (const [name, value] of [
          ["missing field", Object.fromEntries(Object.entries(rows[0]!).filter(([key]) => key !== "ended_at"))],
          ["extra field", { ...rows[0]!, unknown_column: null }], ["text as number", { ...rows[0]!, build_id: 1 }],
          ["integer representation", { ...rows[0]!, protocol_version: kind === "sqlite" ? 1 : "1" }],
          ["integer as boolean", { ...rows[0]!, protocol_version: true }],
          ["noncanonical integer", { ...rows[0]!, registered_epoch: "00" }],
          ["integer as null", { ...rows[0]!, observed_epoch: null }],
        ] as const) await t.test(name, () => assert.rejects(check(rebuild([value, ...rows.slice(1)])), changed));
        const table = archived.tables.find(item => item.name === "storage_source_clients")!;
        const columns = table.columns; assert(Array.isArray(columns));
        for (const [name, replacement] of [
          ["columns", { ...table, columns: [...columns, { name: "extra-column" }] }],
          ["count", { ...table, count: String(Number(table.count) + 1) }],
          ["typed digest", { ...table, digest: "f".repeat(64) }],
        ] as const) await t.test(`changed table ${name}`, () => assert.rejects(check(rebuild(rows,
          archived.tables.map(item => item === table ? replacement : item))), changed));
        await t.test("missing table", () => assert.rejects(check(rebuild(rows, archived.tables.filter(item => item !== table))), changed));
        await t.test("duplicate table", () => assert.rejects(check(rebuild(rows, [...archived.tables, table])), changed));
        assert.deepEqual(await lock.observe(), observed);
      });
    } finally { await f.close(); }
  });

for (const kind of ["sqlite", "postgres"] as const) (kind === "sqlite" ? nativeTest : pgTest)(
  `#228 ${kind}: native raw roster and its complete observation belong to the same lock view`, async t => {
    const f = await snapshotBundleFixture(kind);
    try {
      await f.run(async lock => {
        const observed = await lock.observe(), raw = await lock.observeSourceClients(), captured = f.capture.record.sourceClients;
        assert(captured); assert(raw.rows.length > 0);
        const variants: readonly [string, SourceClientsObservation][] = [
          ["source", { ...raw, source: { ...raw.source, databaseInstanceId: "f".repeat(32) } }],
          ["source identity", { ...raw, sourceIdentity: { fixture: "different-source" } }],
          ["state", { ...raw, state: { ...raw.state, journalSequence: raw.state.journalSequence + 1 } }],
          ["schema", { ...raw, schemaManifestDigest: "f".repeat(64) }],
          ["encoding", { ...raw, textEncoding: kind === "sqlite" ? { backend: "sqlite", name: "UTF-16le" } : { backend: "postgres", name: "LATIN1" } }],
          ["missing raw row", { ...raw, rows: raw.rows.slice(1) }],
          ["raw text bytes", { ...raw, rows: [{ ...raw.rows[0]!, build_id: ["text", "00"] }, ...raw.rows.slice(1)] }],
          ["raw integer", { ...raw, rows: [{ ...raw.rows[0]!, observed_epoch: ["integer", "9223372036854775807"] }, ...raw.rows.slice(1)] }],
          ["raw null", { ...raw, rows: [{ ...raw.rows[0]!, ended_at: ["null"] }, ...raw.rows.slice(1)] }],
        ];
        for (const [name, value] of variants) await t.test(name, () => assert.rejects(assertCapturedSourceClientBinding(
          { ...lock, observeSourceClients: async () => value }, observed, captured, observed.manifests), changed));
        await t.test("lost lock before read", async () => {
          let read = false;
          await assert.rejects(assertCapturedSourceClientBinding({ ...lock,
            assertHeld: async () => { throw new MaintenanceFailure("maintenance_lost"); },
            observeSourceClients: async () => { read = true; return raw; } }, observed, captured, observed.manifests),
          error => error instanceof MaintenanceFailure && error.code === "maintenance_lost");
          assert.equal(read, false);
        });
        assert.deepEqual(await lock.observe(), observed);
      });
    } finally { await f.close(); }
  });

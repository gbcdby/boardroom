import { canonicalJson, digestJson } from "./canonical.ts";
import { MaintenanceFailure } from "./error.ts";
import { readPostgresCatalog, type PostgresReader } from "./postgres-manifests.ts";
import type { PostgresDatabaseIdentity } from "./postgres-identity.ts";
import type { DatabaseManifests } from "./types.ts";

interface NamedObject { readonly catalog: string; readonly oid: string; readonly name: string; readonly owner: string; readonly quoted: string }
interface CatalogObject {
  readonly catalog: string; readonly oid: string; readonly description: string; readonly tag: string; readonly owner: string;
  readonly required: boolean; readonly parents: readonly string[];
  /** Native pg_dump embeds ordinary defaults/CHECKs into TABLE unless it splits a dependency cycle. */
  readonly inlineInto?: string;
}
interface Metadata {
  readonly description: "ACL" | "COMMENT"; readonly namespace: "public" | "-"; readonly tag: string; readonly owner: string;
  readonly parent: string; readonly fallbackParent?: string; readonly tableAcl?: string;
}
/** Operation-local physical bindings. These never enter the OID-independent business manifest. */
export interface PublicRestoreCatalogBinding {
  readonly database: NamedObject; readonly namespace: NamedObject;
  readonly pgDump: string; readonly serverVersion: string;
  readonly objects: readonly CatalogObject[]; readonly metadata: readonly Metadata[];
  readonly dependencies: readonly (readonly [string, string])[];
}
interface Entry {
  readonly id: number; readonly catalog: string; readonly oid: string; readonly description: string;
  readonly namespace: string; readonly remainder: string; readonly dependencies: number[];
  dependenciesSeen: boolean;
}
export interface PublicArchiveAudit {
  readonly entryCount: number; readonly sessionIds: readonly number[]; readonly databaseIds: readonly number[];
  readonly namespaceIds: readonly number[]; readonly bodyIds: readonly number[]; readonly catalogBindingDigest: string;
}
const key = (object: { catalog: string; oid: string }) => `${object.catalog}/${object.oid}`;
// PrintTOCSummary sanitizes CR and LF only. Owners and tags are not whitespace-delimited identifiers.
const projection = (text: string) => text.replace(/[\r\n]/g, " ");
const remainder = (tag: string, owner: string) => projection(`${tag} ${owner}`);
const descriptions = ["DATABASE PROPERTIES", "SEQUENCE OWNED BY", "CHECK CONSTRAINT", "FK CONSTRAINT", "SECURITY LABEL",
  "TABLE DATA", "SEQUENCE SET", "DEFAULT ACL", "ENCODING", "STDSTRINGS", "SEARCHPATH", "DATABASE", "SCHEMA", "TABLE",
  "SEQUENCE", "DEFAULT", "CONSTRAINT", "INDEX", "FUNCTION", "TRIGGER", "ACL", "COMMENT"] as const;
function invalid(): never { throw new MaintenanceFailure("snapshot_invalid"); }
function number(text: string, maximum: number, zero = false): number {
  if (!(zero ? /^(0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/).test(text)) invalid();
  const value = Number(text); if (!Number.isSafeInteger(value) || value > maximum) invalid(); return value;
}
function sameIds(actual: readonly number[], expected: readonly number[]): boolean {
  return actual.length === expected.length && [...actual].sort((a, b) => a - b).every((id, i) => id === [...expected].sort((a, b) => a - b)[i]);
}

/** Complete, unfiltered PG16 verbose TOC. Successful parsing is not restore verification. */
export function auditPublicArchiveToc(text: string, binding: PublicRestoreCatalogBinding): PublicArchiveAudit {
  if (binding.namespace.name !== "public" || text.includes("\0") || text.includes("\r")) invalid();
  const entries: Entry[] = [], headers = new Map<string, string>();
  let preceding: Entry | undefined, selectedHeader = false;
  for (const line of text.split("\n")) {
    if (!line || line === ";") { preceding = undefined; continue; }
    const header = /^;     (dbname|TOC Entries|Compression|Dump Version|Format|Integer|Offset|Dumped from database version|Dumped by pg_dump version): (.*)$/.exec(line);
    if (header) { if (selectedHeader || headers.has(header[1]!)) invalid(); headers.set(header[1]!, header[2]!); preceding = undefined; continue; }
    if (/^; Archive created at .+$/.test(line)) { if (selectedHeader) invalid(); preceding = undefined; continue; }
    if (line === "; Selected TOC Entries:") { if (selectedHeader) invalid(); selectedHeader = true; continue; }
    const dependencies = /^;\tdepends on: ([0-9]+(?: [0-9]+)*)$/.exec(line);
    if (dependencies) {
      if (!preceding || preceding.dependenciesSeen) invalid(); preceding.dependenciesSeen = true;
      preceding.dependencies.push(...dependencies[1]!.split(" ").map(id => number(id, 2_147_483_647))); continue;
    }
    const raw = /^([0-9]+); ([0-9]+) ([0-9]+) (.+)$/.exec(line);
    if (!raw || !selectedHeader) invalid();
    const description = descriptions.find(value => raw[4]!.startsWith(`${value} `));
    if (!description) invalid();
    const rest = /^(public|-) (.*)$/.exec(raw[4]!.slice(description.length + 1));
    if (!rest) invalid();
    const entry: Entry = { id: number(raw[1]!, 2_147_483_647), catalog: String(number(raw[2]!, 4_294_967_295, true)),
      oid: String(number(raw[3]!, 4_294_967_295, true)), description, namespace: rest[1]!, remainder: rest[2]!, dependencies: [], dependenciesSeen: false };
    entries.push(entry); preceding = entry;
  }
  if (!selectedHeader || headers.size !== 9 || headers.get("dbname") !== projection(binding.database.name)
    || headers.get("Format") !== "CUSTOM" || headers.get("Dump Version") !== "1.15-0"
    || headers.get("Integer") !== "4 bytes" || headers.get("Offset") !== "8 bytes"
    || !/^(gzip|lz4|zstd|none|[0-9]+)$/.test(headers.get("Compression") ?? "")
    || !new RegExp(`^${binding.pgDump.replaceAll(".", "\\.")}(?:$| )`).test(headers.get("Dumped by pg_dump version") ?? "")
    || !new RegExp(`^${binding.serverVersion.replaceAll(".", "\\.")}(?:$| )`).test(headers.get("Dumped from database version") ?? "")
    || number(headers.get("TOC Entries") ?? "", 2_147_483_647) !== entries.length) invalid();
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  if (byId.size !== entries.length || entries.some(entry => entry.dependencies.some(id => id === entry.id || !byId.has(id)))) invalid();
  const sessions = entries.filter(entry => ["ENCODING", "STDSTRINGS", "SEARCHPATH"].includes(entry.description));
  if (sessions.length !== 3 || new Set(sessions.map(entry => entry.description)).size !== 3
    || sessions.some(entry => entry.catalog !== "0" || entry.oid !== "0" || entry.namespace !== "-"
      || entry.remainder !== `${entry.description} ` || entry.dependencies.length)) invalid();
  const databases = entries.filter(entry => entry.description === "DATABASE");
  if (databases.length !== 1) invalid(); const database = databases[0]!;
  if (key(database) !== key(binding.database) || database.namespace !== "-" || database.dependencies.length
    || ![binding.database.name, binding.database.quoted].some(name => database.remainder === remainder(name, binding.database.owner))) invalid();
  const namespaces = entries.filter(entry => entry.description === "SCHEMA");
  if (namespaces.length !== 1) invalid(); const namespace = namespaces[0]!;
  if (key(namespace) !== key(binding.namespace) || namespace.namespace !== "-" || namespace.dependencies.length
    || namespace.remainder !== remainder("public", binding.namespace.owner)) invalid();
  const databaseIds = [database.id], classified = new Set([...sessions.map(entry => entry.id), database.id, namespace.id]);
  const envelopeTypes = new Set<string>();
  for (const entry of entries) {
    const properties = entry.description === "DATABASE PROPERTIES";
    const metadata = ["COMMENT", "ACL", "SECURITY LABEL"].includes(entry.description) && entry.namespace === "-"
      && [binding.database.name, binding.database.quoted].some(name => entry.remainder === remainder(`DATABASE ${name}`, binding.database.owner));
    if (!properties && !metadata) continue;
    if (entry.catalog !== "0" || entry.oid !== "0" || entry.namespace !== "-" || envelopeTypes.has(entry.description)) invalid();
    if (properties ? entry.remainder !== database.remainder || !(entry.dependencies.length === 0 || sameIds(entry.dependencies, [database.id]))
      : !sameIds(entry.dependencies, [database.id])) invalid();
    envelopeTypes.add(entry.description); databaseIds.push(entry.id); classified.add(entry.id);
  }
  const objects = new Map(binding.objects.map(object => [key(object), object]));
  if (objects.size !== binding.objects.length) invalid();
  const main = new Map<string, Entry>([[key(binding.namespace), namespace]]);
  for (const entry of entries) {
    if (classified.has(entry.id) || ["ACL", "COMMENT", "TABLE DATA", "SEQUENCE SET"].includes(entry.description)) continue;
    const object = objects.get(key(entry));
    if (!object || main.has(key(entry)) || entry.namespace !== "public" || entry.description !== object.description
      || entry.remainder !== remainder(object.tag, object.owner)) invalid();
    main.set(key(entry), entry); classified.add(entry.id);
  }
  if (binding.objects.some(object => object.required && !main.has(key(object)))) invalid();
  const edges = new Map<string, Set<string>>();
  const edge = (from: string, to: string) => { const set = edges.get(from) ?? new Set<string>(); set.add(to); edges.set(from, set); };
  for (const [from, to] of binding.dependencies) edge(from, to);
  for (const object of binding.objects) if (object.inlineInto && !main.has(key(object))) edge(object.inlineInto, key(object));
  function projectedDependencies(start: string): Set<number> {
    const result = new Set<number>(), visited = new Set([start]);
    const visit = (next: string) => {
      if (visited.has(next)) return; visited.add(next);
      const entry = main.get(next); if (entry) { result.add(entry.id); return; }
      for (const child of edges.get(next) ?? []) visit(child);
    };
    for (const next of edges.get(start) ?? []) visit(next); return result;
  }
  for (const [objectKey, entry] of main) {
    if (entry === namespace) continue;
    const allowed = projectedDependencies(objectKey), object = objects.get(objectKey)!;
    if (entry.dependencies.some(id => !allowed.has(id)) || object.parents.some(parent => {
      const wanted = main.get(parent); return wanted && !entry.dependencies.includes(wanted.id);
    })) invalid();
  }
  const dataSeen = new Set<string>(), metadataSeen = new Set<string>();
  for (const entry of entries) {
    if (classified.has(entry.id)) continue;
    if (entry.description === "TABLE DATA" || entry.description === "SEQUENCE SET") {
      const expectedDescription = entry.description === "TABLE DATA" ? "TABLE" : "SEQUENCE";
      const matches = binding.objects.filter(object => object.description === expectedDescription
        && entry.namespace === "public" && entry.remainder === remainder(object.tag, object.owner)
        && entry.catalog === "0" && entry.oid === (expectedDescription === "TABLE" ? object.oid : "0")
        && sameIds(entry.dependencies, [main.get(key(object))?.id ?? -1]));
      if (matches.length !== 1 || dataSeen.has(key(matches[0]!))) invalid(); dataSeen.add(key(matches[0]!)); classified.add(entry.id); continue;
    }
    if (!["ACL", "COMMENT"].includes(entry.description) || entry.catalog !== "0" || entry.oid !== "0") invalid();
    const matches = binding.metadata.filter(item => {
      if (item.description !== entry.description || item.namespace !== entry.namespace || entry.remainder !== remainder(item.tag, item.owner)) return false;
      const parent = main.get(item.parent) ?? (item.fallbackParent ? main.get(item.fallbackParent) : undefined);
      if (!parent) return false;
      const expected = [parent.id];
      if (item.tableAcl) {
        const tableAcls = entries.filter(other => other.description === "ACL" && other.namespace === "public"
          && other.remainder === remainder(item.tableAcl!, item.owner) && sameIds(other.dependencies, [parent.id]));
        if (tableAcls.length > 1) return false; if (tableAcls[0]) expected.push(tableAcls[0].id);
      }
      return sameIds(entry.dependencies, expected);
    });
    if (matches.length !== 1) invalid();
    const metadataKey = canonicalJson(matches[0]);
    if (metadataSeen.has(metadataKey)) invalid(); metadataSeen.add(metadataKey); classified.add(entry.id);
  }
  if (binding.objects.some(object => ["TABLE", "SEQUENCE"].includes(object.description) && !dataSeen.has(key(object)))
    || classified.size !== entries.length) invalid();
  const sessionIds = sessions.map(entry => entry.id), namespaceIds = [namespace.id];
  const excluded = new Set([...sessionIds, ...databaseIds, ...namespaceIds]);
  return { entryCount: entries.length, sessionIds, databaseIds: entries.filter(entry => databaseIds.includes(entry.id)).map(entry => entry.id),
    namespaceIds, bodyIds: entries.filter(entry => !excluded.has(entry.id)).map(entry => entry.id), catalogBindingDigest: digestJson(binding) };
}

/** Called only from the live exported-snapshot operation, after the original closed profile check. */
export async function readPublicRestoreCatalogBinding(client: PostgresReader, identity: PostgresDatabaseIdentity,
  expected: DatabaseManifests, pgDump: string): Promise<PublicRestoreCatalogBinding> {
  if (identity.schemaName !== "public" || canonicalJson((await readPostgresCatalog(client, "public")).schema) !== canonicalJson(expected.schema)) invalid();
  const query = async (sql: string) => (await client.query(sql)).rows as Record<string, string>[];
  const named = await query(`SELECT 'database' AS kind,tableoid::text AS catalog,oid::text AS oid,datname AS name,
    pg_catalog.quote_ident(datname) AS quoted,pg_catalog.pg_get_userbyid(datdba) AS owner FROM pg_catalog.pg_database WHERE datname=current_database()
    UNION ALL SELECT 'namespace',tableoid::text,oid::text,nspname,pg_catalog.quote_ident(nspname),pg_catalog.pg_get_userbyid(nspowner)
    FROM pg_catalog.pg_namespace WHERE nspname='public'`);
  const database = named.find(row => row.kind === "database"), namespace = named.find(row => row.kind === "namespace");
  if (!database || !namespace || database.oid !== identity.databaseOid || database.name !== identity.databaseName || namespace.oid !== identity.schemaOid) invalid();
  const asNamed = (row: Record<string, string>): NamedObject => ({ catalog: row.catalog!, oid: row.oid!, name: row.name!, quoted: row.quoted!, owner: row.owner! });
  const objects: CatalogObject[] = [], metadata: Metadata[] = [], dependencies: [string, string][] = [];
  const namespaceKey = key(asNamed(namespace));
  function meta(tag: string, owner: string, parent: string, acl = true, extra: Partial<Metadata> = {}) {
    for (const description of acl ? ["ACL", "COMMENT"] as const : ["COMMENT"] as const)
      metadata.push({ description, namespace: "public", tag, owner, parent, ...extra });
  }
  meta("SCHEMA public", namespace.owner!, namespaceKey, true, { namespace: "-" });
  const classes = await query(`SELECT c.tableoid::text AS catalog,c.oid::text,c.relname AS name,c.relkind AS kind,
    pg_catalog.quote_ident(c.relname) AS quoted,pg_catalog.pg_get_userbyid(c.relowner) AS owner,
    COALESCE(i.indrelid::text,'') AS table_oid,COALESCE(co.oid::text,'') AS constraint_oid,
    COALESCE(d.refobjid::text,'') AS sequence_table_oid
    FROM pg_catalog.pg_class c LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid
    LEFT JOIN pg_catalog.pg_constraint co ON co.conindid=c.oid AND co.contype IN ('p','u','x')
    LEFT JOIN pg_catalog.pg_depend d ON c.relkind='S' AND d.classid='pg_class'::regclass AND d.objid=c.oid
      AND d.refclassid='pg_class'::regclass AND d.refobjsubid>0 AND d.deptype='i'
    WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','S','i')`);
  const classCatalog = classes[0]?.catalog; if (!classCatalog) invalid();
  const tableKey = (oid: string) => `${classCatalog}/${oid}`;
  const constraints = await query(`SELECT co.tableoid::text AS catalog,co.oid::text,co.conname AS name,co.contype AS kind,
    pg_catalog.quote_ident(co.conname) AS quoted,t.relname AS table_name,pg_catalog.quote_ident(t.relname) AS table_quoted,
    co.conrelid::text AS table_oid,co.confrelid::text AS foreign_table_oid,pg_catalog.pg_get_userbyid(t.relowner) AS owner
    FROM pg_catalog.pg_constraint co JOIN pg_catalog.pg_class t ON t.oid=co.conrelid WHERE co.connamespace='public'::regnamespace`);
  const constraintCatalog = constraints[0]?.catalog ?? String((await client.query("SELECT 'pg_catalog.pg_constraint'::regclass::text AS unused,'pg_catalog.pg_constraint'::regclass::oid::text AS oid")).rows[0]?.oid);
  for (const row of classes) {
    const description = row.kind === "r" ? "TABLE" : row.kind === "S" ? "SEQUENCE" : "INDEX";
    const object: CatalogObject = { catalog: row.catalog!, oid: row.oid!, description, tag: row.name!, owner: row.owner!,
      required: description !== "INDEX" || !row.constraint_oid,
      parents: description === "TABLE" ? [namespaceKey] : [tableKey(description === "SEQUENCE" ? row.sequence_table_oid! : row.table_oid!)] };
    // Native pg_dump creates constraint-backed indexes through CONSTRAINT, never twice.
    if (description !== "INDEX" || !row.constraint_oid) objects.push(object);
    meta(`${description} ${row.quoted}`, row.owner!, description === "INDEX" && row.constraint_oid ? `${constraintCatalog}/${row.constraint_oid}` : key(object), description !== "INDEX");
  }
  const columns = await query(`SELECT a.attrelid::text AS table_oid,a.attname AS name,pg_catalog.quote_ident(a.attname) AS quoted,
    t.relname AS table_name,pg_catalog.quote_ident(t.relname) AS table_quoted,pg_catalog.pg_get_userbyid(t.relowner) AS owner
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class t ON t.oid=a.attrelid
    WHERE t.relnamespace='public'::regnamespace AND t.relkind='r' AND a.attnum>0 AND NOT a.attisdropped`);
  for (const row of columns) {
    const tag = `COLUMN ${row.table_quoted}.${row.quoted}`, parent = tableKey(row.table_oid!);
    meta(tag, row.owner!, parent, false);
    metadata.push({ description: "ACL", namespace: "public", tag, owner: row.owner!, parent, tableAcl: `TABLE ${row.table_quoted}` });
  }
  const defaults = await query(`SELECT d.tableoid::text AS catalog,d.oid::text,d.adrelid::text AS table_oid,
    t.relname AS table_name,a.attname AS column_name,pg_catalog.pg_get_userbyid(t.relowner) AS owner
    FROM pg_catalog.pg_attrdef d JOIN pg_catalog.pg_class t ON t.oid=d.adrelid
    JOIN pg_catalog.pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum WHERE t.relnamespace='public'::regnamespace`);
  for (const row of defaults) objects.push({ catalog: row.catalog!, oid: row.oid!, description: "DEFAULT", tag: `${row.table_name} ${row.column_name}`,
    owner: row.owner!, required: false, parents: [tableKey(row.table_oid!)], inlineInto: tableKey(row.table_oid!) });
  for (const row of constraints) {
    const description = row.kind === "f" ? "FK CONSTRAINT" : row.kind === "c" ? "CHECK CONSTRAINT" : "CONSTRAINT";
    if (!["f", "c", "p", "u", "x"].includes(row.kind!)) invalid();
    const object: CatalogObject = { catalog: row.catalog!, oid: row.oid!, description, tag: `${row.table_name} ${row.name}`, owner: row.owner!,
      required: row.kind !== "c", parents: [tableKey(row.table_oid!)], ...(row.kind === "c" ? { inlineInto: tableKey(row.table_oid!) } : {}) };
    objects.push(object);
    meta(`CONSTRAINT ${row.quoted} ON ${row.table_quoted}`, row.owner!, key(object), false,
      row.kind === "c" ? { fallbackParent: tableKey(row.table_oid!) } : {});
  }
  const functions = await query(`SELECT p.tableoid::text AS catalog,p.oid::text,p.proname AS name,
    pg_catalog.quote_ident(p.proname) AS quoted,pg_catalog.pg_get_userbyid(p.proowner) AS owner
    FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace`);
  for (const row of functions) {
    const object: CatalogObject = { catalog: row.catalog!, oid: row.oid!, description: "FUNCTION", tag: `${row.name}()`, owner: row.owner!, required: true, parents: [namespaceKey] };
    objects.push(object); meta(`FUNCTION ${row.quoted}()`, row.owner!, key(object));
  }
  const triggers = await query(`SELECT g.tableoid::text AS catalog,g.oid::text,g.tgname AS name,pg_catalog.quote_ident(g.tgname) AS quoted,
    t.relname AS table_name,pg_catalog.quote_ident(t.relname) AS table_quoted,g.tgrelid::text AS table_oid,
    pg_catalog.pg_get_userbyid(t.relowner) AS owner FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_class t ON t.oid=g.tgrelid
    WHERE t.relnamespace='public'::regnamespace AND NOT g.tgisinternal`);
  for (const row of triggers) {
    const object: CatalogObject = { catalog: row.catalog!, oid: row.oid!, description: "TRIGGER", tag: `${row.table_name} ${row.name}`, owner: row.owner!, required: true, parents: [tableKey(row.table_oid!)] };
    objects.push(object); meta(`TRIGGER ${row.quoted} ON ${row.table_quoted}`, row.owner!, key(object), false);
  }
  const defaultAcls = await query(`SELECT d.tableoid::text AS catalog,d.oid::text,d.defaclobjtype AS kind,pg_catalog.pg_get_userbyid(d.defaclrole) AS owner
    FROM pg_catalog.pg_default_acl d WHERE d.defaclnamespace='public'::regnamespace`);
  const aclTypes: Readonly<Record<string, string>> = { r: "TABLES", S: "SEQUENCES", f: "FUNCTIONS", T: "TYPES", n: "SCHEMAS" };
  for (const row of defaultAcls) {
    if (!aclTypes[row.kind!]) invalid();
    objects.push({ catalog: row.catalog!, oid: row.oid!, description: "DEFAULT ACL", tag: `DEFAULT PRIVILEGES FOR ${aclTypes[row.kind!]}`,
      owner: row.owner!, required: true, parents: [namespaceKey] });
  }
  for (const row of await query(`SELECT classid::text,objid::text,refclassid::text,refobjid::text FROM pg_catalog.pg_depend`))
    dependencies.push([`${row.classid}/${row.objid}`, `${row.refclassid}/${row.refobjid}`]);
  return { database: asNamed(database), namespace: asNamed(namespace), pgDump,
    serverVersion: `${Math.floor(Number(identity.serverVersion) / 10_000)}.${Number(identity.serverVersion) % 10_000}`,
    objects, metadata, dependencies };
}

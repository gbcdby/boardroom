import { assertView, chargeState, p0State, throwP0, withP0Guard } from "./m2-p0-budget.ts";
import type { P0KeyPart, P0KeyObservation, P0Request, P0Result, P0Row, P0Site, P0Table, P0TupleIndex, P0View } from "./m2-p0-types.ts";

import { P0_POSTGRES_SQL, P0_SQLITE_SQL, P0_SQL_PREDICATES } from "./m2-p0-catalog.ts";
import type { P0SqlOps, P0SqlTable, P0SqlTruth, P0SqlValue } from "./m2-p0-catalog.ts";
import { p0RowSite, readP0Int64, readP0Json, readP0Text } from "./m2-p0-raw.ts";
import { parseP0Json } from "./m2-p0-lexical.ts";
import { m2RequestData } from "./m2-p0-request.ts";

type Atom = string | bigint | number | null;
type Node<T> = { children: Map<string, Map<Atom, Node<T>>>; present: boolean; value: T | undefined };
export function createP0TupleIndex<T>(request: P0Request, site?: P0Site): P0TupleIndex<T> {
  const state = p0State(request);
  chargeState(state, { work: 1, tuples: 1 }, site);
  const root: Node<T> = { children: new Map(), present: false, value: undefined };
  let size = 0;
  const tokens = (key: readonly P0KeyPart[]): readonly (readonly [string, Atom])[] => {
    chargeState(state, { work: key.length + 1, tuples: 1 }, site);
    return key.map(part => {
      if (part === null) return ["null", null] as const;
      if (typeof part === "string") { chargeState(state, { bytes: part.length * 3 }, site); return ["text", part] as const; }
      if (typeof part === "bigint") { chargeState(state, { bytes: 40 }, site); return ["numeric", part] as const; }
      if (typeof part === "number" && Number.isFinite(part)) {
        chargeState(state, { bytes: 16 }, site);
        // SQL INTEGER/REAL compare by exact numeric value. Raw storage tags remain untouched.
        return Number.isInteger(part) ? ["numeric", BigInt(part)] as const : ["numeric", part] as const;
      }
      if (Array.isArray(part) && part.length === 2 && part[0] === "blob" && typeof part[1] === "string") {
        chargeState(state, { bytes: part[1].length * 2 }, site);
        if (/^(?:[0-9a-f]{2})*$/.test(part[1])) return ["blob", part[1]] as const;
      }
      throwP0(state, { code: "unsupported_shape", rule: "PC1B-KEY01", ...(site ? { site } : {}) });
    });
  };
  const locate = (key: readonly P0KeyPart[], insert: boolean): Node<T> | undefined => {
    const path = tokens(key); let node = root;
    for (const [tag, value] of path) {
      chargeState(state, { work: 1 }, site);
      let values = node.children.get(tag), child = values?.get(value);
      if (!child) {
        if (!insert) return undefined;
        chargeState(state, { tuples: 1, work: 1 }, site);
        if (!values) { values = new Map(); node.children.set(tag, values); }
        child = { children: new Map(), present: false, value: undefined }; values.set(value, child);
      }
      node = child;
    }
    return node;
  };
  return Object.freeze({ get size() { return size; }, get(key: readonly P0KeyPart[]) { return locate(key, false)?.value; },
    has(key: readonly P0KeyPart[]) { return locate(key, false)?.present ?? false; },
    insert(key: readonly P0KeyPart[], value: T): T | undefined {
      if (value === undefined) throwP0(state, { code: "invalid_value", rule: "PC1B-KEY01", ...(site ? { site } : {}) });
      const node = locate(key, true)!;
      if (node.present) return node.value;
      node.present = true; node.value = value; size++; return undefined;
    } });
}

// The fixed SQL plans below operate only after the documented scalar storage-class adapter.
// INTEGER stays BigInt, TEXT stays decoded text, and a BLOB/REAL cannot impersonate either.
// No SQL engine, input expression, caller registry or repository is consulted.
function sqlRow(request: P0Request, view: P0View, row: P0Row, table: P0SqlTable): P0SqlOps {
  const state = p0State(request), rowSite = p0RowSite(request, view, row, undefined, "PC1B-KEY01.P01");
  chargeState(state, { work: table.columns.length + 1, tuples: 1 }, rowSite);
  const values = new Map<number, P0SqlValue>();
  const step = (work = 1) => chargeState(state, { work }, rowSite);
  const bytes = (...inputs: readonly P0SqlValue[]) => {
    // Three UTF-8 bytes per UTF-16 code unit bounds all well-formed raw TEXT without
    // scanning it to discover a charge. The operation follows this reservation.
    chargeState(state, { work: 1, bytes: inputs.reduce((n, v) => n + (typeof v === "string" ? v.length * 3 : 40), 0) }, rowSite);
  };
  const unsupported = (): never => { throwP0(state, { code: "semantic_unsupported", rule: "PC1B-KEY01", site: rowSite }); };
  const compare: P0SqlOps["compare"] = (op, left, right) => {
    step(); if (left === null || right === null) return null;
    if (typeof left !== typeof right) return unsupported();
    bytes(left, right);
    switch (op) {
      case "=": return left === right;
      case "<>": case "!=": return left !== right;
      case ">=": return left >= right;
      case "<=": return left <= right;
      case ">": return left > right;
      case "<": return left < right;
    }
  };
  const numeric = (left: P0SqlValue, right: P0SqlValue, subtract: boolean): P0SqlValue => {
    step(); if (left === null || right === null) return null;
    if (typeof left !== "bigint" || typeof right !== "bigint") return unsupported();
    bytes(left, right); return subtract ? left - right : left + right;
  };
  let sqlJsonValues: Map<number, unknown> | undefined;
  const json = (ordinal: number): unknown => {
    const column = table.columns[ordinal]!; step();
    // This cache belongs only to this SQL row/view and its one fixed column site.
    // It never supplies a parsed value to a business JSON grammar or another site.
    if (sqlJsonValues?.has(ordinal)) return sqlJsonValues.get(ordinal);
    const site = p0RowSite(request, view, row, column.name, "PC1B-KEY01.P01");
    const text = readP0Text(request, row, column.name, site);
    let end = -1;
    if (text !== null && request.input.graph.observation.backend === "sqlite") {
      bytes(text); end = text.indexOf("\0");
    }
    let value: unknown;
    if (end < 0) value = readP0Json(request, row, column.name, "legacy-display", site);
    else {
      // SQLite JSON1 stops at the first literal NUL in its SQL TEXT operand.
      // Keep the original cell intact; only this fixed SQL operation sees a prefix.
      chargeState(state, { bytes: end * 3, work: 1, tuples: 1 }, site);
      value = parseP0Json(request, text!.slice(0, end), site, "legacy-display");
    }
    chargeState(state, { work: 1, tuples: sqlJsonValues ? 1 : 2 }, site);
    if (!sqlJsonValues) sqlJsonValues = new Map();
    sqlJsonValues.set(ordinal, value); return value;
  };
  const ops: P0SqlOps = {
    c(ordinal) {
      step(); if (values.has(ordinal)) return values.get(ordinal)!;
      const column = table.columns[ordinal]!;
      const site = p0RowSite(request, view, row, column.name, "PC1B-KEY01.P01");
      const value = column.type === "text" ? readP0Text(request, row, column.name, site)
        : column.type === "integer" ? readP0Int64(request, row, column.name, site) : unsupported();
      values.set(ordinal, value); return value;
    }, compare,
    and(left, right) { step(); return left === false || right === false ? false : left === null || right === null ? null : true; },
    or(left, right) { step(); return left === true || right === true ? true : left === null || right === null ? null : false; },
    not(value) { step(); return value === null ? null : !value; },
    isNull(value) { step(); return value === null; },
    oneOf(value, choices) {
      step(choices.length + 1); let unknown = false;
      for (const candidate of choices) { const equal = compare("=", value, candidate); if (equal) return true; if (equal === null) unknown = true; }
      return unknown ? null : false;
    },
    taskPrefix(value) {
      step(); if (value === null) return null; if (typeof value !== "string") return unsupported();
      chargeState(state, { bytes: Math.min(5, value.length) * 3 }, rowSite);
      const prefix = value.slice(0, 5);
      return request.input.graph.observation.backend === "postgres" ? prefix === "task."
        : prefix.replace(/[A-Z]/g, c => String.fromCharCode(c.charCodeAt(0) + 32)) === "task.";
    },
    length(value) {
      step(); if (value === null) return null; if (typeof value !== "string") return unsupported();
      bytes(value); let length = 0;
      for (const character of value) { if (character === "\0" && request.input.graph.observation.backend === "sqlite") break; length++; }
      return BigInt(length);
    },
    trim(value) {
      step(); if (value === null) return null; if (typeof value !== "string") return unsupported();
      // SQL trim removes only U+0020. Two disjoint end scans inspect at most
      // length + 2 code units; a trailing regex can retry at every internal space.
      bytes(value); step(2);
      let start = 0, end = value.length;
      while (start < end && value.charCodeAt(start) === 0x20) start++;
      while (end > start && value.charCodeAt(end - 1) === 0x20) end--;
      if (start === 0 && end === value.length) return value;
      chargeState(state, { bytes: (end - start) * 3, work: 1 }, rowSite);
      return value.slice(start, end);
    },
    jsonValid(ordinal) { step(); if (row.raw.cells[ordinal]![0] === "null") return null; return json(ordinal) !== undefined; },
    jsonArray(ordinal) { step(); if (row.raw.cells[ordinal]![0] === "null") return null; return Array.isArray(json(ordinal)); },
    add(left, right) { return numeric(left, right, false); }, subtract(left, right) { return numeric(left, right, true); },
    concat(left, right) {
      step(); if (left === null || right === null) return null;
      if (typeof left !== "string" || typeof right !== "string") return unsupported();
      bytes(left, right); return left + right;
    },
    choose(condition, yes, no) { step(); return condition === true ? yes() : no(); },
    truth(value) { step(); if (value === null) return null; if (typeof value !== "bigint") return unsupported(); return value !== 0n; },
  };
  return ops;
}

type TableContext = { table: P0SqlTable; rows: readonly P0Row[]; ops: Map<P0Row, P0SqlOps>; indexes: Map<string, P0TupleIndex<P0Row>> };
function keys(request: P0Request, inputView: P0View | undefined, m2: boolean): P0Result<P0KeyObservation> {
  return withP0Guard(request, () => {
    const view = inputView === undefined ? request.original : inputView;
    const state = p0State(request); assertView(state, view);
    if(m2){
      if(m2RequestData(request)===undefined||view.rows('storage_maintenance').length!==1||view.rows('storage_maintenance')[0]!.stage!=='p1')
        throwP0(state,{code:'unsupported_shape',rule:'PC1B-KEY01'});
      for(const table of request.input.graph.observation.tables)for(const row of view.rows(table.name as P0Table)){
        chargeState(state,{work:1});if(row.stage!=='p1')throwP0(state,{code:'unsupported_shape',rule:'PC1B-KEY01'});
      }
    }
    const catalog = request.input.graph.observation.backend === "sqlite" ? P0_SQLITE_SQL : P0_POSTGRES_SQL;
    chargeState(state, { work: catalog.length * 3, tuples: catalog.length });
    const tables = new Map<P0Table, TableContext>();
    const fail = (row: P0Row, column: number | undefined, condition: "duplicate-key" | "state-mismatch" | "missing-target", target?: P0Row): never => {
      const table = tables.get(row.table)!.table;
      throwP0(state, { code: "semantic_invariant_failed", rule: "PC1B-KEY01", condition,
        site: p0RowSite(request, view, row, column === undefined ? undefined : table.columns[column]!.name, "PC1B-KEY01.P01"),
        target: target ? p0RowSite(request, view, target, undefined, "PC1B-KEY01.P01") : null });
    };
    const hasNull = (row: P0Row, columns: readonly number[]): boolean => {
      chargeState(state, { work: columns.length + 1 });
      return columns.some(index => row.raw.cells[index]![0] === "null");
    };
    const tuple = (context: TableContext, row: P0Row, columns: readonly number[]): readonly P0KeyPart[] => {
      chargeState(state, { work: columns.length + 1, tuples: 1 });
      return columns.map(index => context.ops.get(row)!.c(index));
    };
    for (const table of catalog) {
      const rows = view.rows(table.name);
      chargeState(state, { work: rows.length + 1, tuples: rows.length });
      const context: TableContext = { table, rows, ops: new Map(), indexes: new Map() }; tables.set(table.name, context);
      const rowids = request.input.graph.observation.backend === "sqlite" ? createP0TupleIndex<P0Row>(request) : null;
      for (const row of rows) {
        chargeState(state, { work: table.columns.length + 1 });
        const ops = sqlRow(request, view, row, table); context.ops.set(row, ops);
        if (rowids) {
          chargeState(state, { work: 1, bytes: 40 });
          const previous = rowids.insert([BigInt(row.raw.rowid!)], row);
          if (previous) fail(row, undefined, "duplicate-key", previous);
        }
        for (const [index, column] of table.columns.entries()) if (column.notNull && row.raw.cells[index]![0] === "null") fail(row, index, "state-mismatch");
        for (const check of table.checks) {
          chargeState(state, { work: 1 });
          // The exact schema22 predicates replace only these two original
          // protocol literals. No original P0 predicate is relaxed.
          if(m2&&table.name==='storage_maintenance'&&check===143){if(ops.c(12)!==2n)fail(row,12,'state-mismatch');continue;}
          if(m2&&table.name==='storage_source_clients'&&check===149){if(ops.c(4)!==1n&&ops.c(4)!==2n)fail(row,4,'state-mismatch');continue;}
          // SQL CHECK rejects FALSE; UNKNOWN is admitted. NOT NULL is independent.
          if (P0_SQL_PREDICATES[check]!(ops) === false) fail(row, undefined, "state-mismatch");
        }
      }
    }
    // Build real full-tuple indexes and check every applicable UNIQUE before resolving FKs.
    // Fixed column ordinal strings identify a plan, never a caller key or row identity.
    for (const context of tables.values()) for (const constraint of context.table.unique) {
      chargeState(state, { work: 1 }); const index = createP0TupleIndex<P0Row>(request);
      if (constraint.predicate === null) context.indexes.set(constraint.columns.join(","), index);
      for (const row of context.rows) {
        chargeState(state, { work: 1 });
        if(m2&&context.table.name==='agent_runtime_bindings'&&constraint.columns.length>1
          &&readP0Text(request,row,'attachment_state',p0RowSite(request,view,row,'attachment_state','PC1B-KEY01.P01'))!=='attached')continue;
        if (constraint.predicate !== null && P0_SQL_PREDICATES[constraint.predicate]!(context.ops.get(row)!) !== true) continue;
        if (hasNull(row, constraint.columns)) continue;
        const previous = index.insert(tuple(context, row, constraint.columns), row);
        if (previous) fail(row, constraint.columns[0], "duplicate-key", previous);
      }
    }
    for (const context of tables.values()) for (const foreign of context.table.foreignKeys) {
      chargeState(state, { work: foreign.columns.length + foreign.targets.length + 1 });
      const target = tables.get(foreign.table)!;
      const index = target.indexes.get(foreign.targets.join(","));
      // Every target comes from a frozen full UNIQUE/PK plan. A missing plan is an internal
      // unsupported contract, never a license to approximate a subset/single-column match.
      if (!index) throwP0(state, { code: "source_contract_mismatch", rule: "PC1B-KEY01" });
      for (const row of context.rows) {
        chargeState(state, { work: 1 });
        if (hasNull(row, foreign.columns)) continue;
        if (!index.has(tuple(context, row, foreign.columns))) fail(row, foreign.columns[0], "missing-target");
      }
    }
    chargeState(state, { work: 8, bytes: 512 });
    return Object.freeze({ classification: "sql-constraint-observation", phase: view.phase,
      tables: catalog.length, rows: view.rowCount, fullSemanticClosure: "not-performed" });
  });
}
export function checkP0Keys(request:P0Request,inputView?:P0View):P0Result<P0KeyObservation>{return keys(request,inputView,false);}
/** Fixed schema22 continuation on an authentic M2 request; new keys and row
 * grammar are also checked by the complete M201/M202 consumer. */
export function checkM2LegacyKeys(request:P0Request,inputView?:P0View):P0Result<P0KeyObservation>{return keys(request,inputView,true);}

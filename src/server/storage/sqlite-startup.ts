import Database from "better-sqlite3";
import { lstatSync } from "node:fs";
import { assertStorageAdmission, readSqliteMaintenanceState, StorageMaintenanceError } from "./admission.ts";

/** Existing-source check before writable connect/WAL pragma/probe/migrations. Never creates a DB. */
export function assertSqliteStartupAdmission(file: string): void {
  let before;
  try { before=lstatSync(file,{bigint:true}); }
  catch (error) { if ((error as NodeJS.ErrnoException).code==="ENOENT") return; throw error; }
  if (!before.isFile() || before.nlink!==1n) throw new StorageMaintenanceError("metadata_invalid");
  const db=new Database(file,{readonly:true,fileMustExist:true});
  try {
    db.pragma("query_only=ON");
    assertStorageAdmission(readSqliteMaintenanceState(db));
    const after=lstatSync(file,{bigint:true});
    if (before.dev!==after.dev || before.ino!==after.ino || !after.isFile() || after.nlink!==1n)
      throw new StorageMaintenanceError("metadata_invalid");
  } finally {db.close();}
}

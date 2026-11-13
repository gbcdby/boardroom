/* A read-only SQLite connection check through its public VFS file-control API. */
#include <sqlite3ext.h>
#include <stddef.h>
SQLITE_EXTENSION_INIT1

static void source_unchanged(sqlite3_context *context, int count, sqlite3_value **values) {
  (void)count; (void)values;
  sqlite3 *database = sqlite3_context_db_handle(context);
  int moved = 1;
  int result = sqlite3_file_control(database, "main", SQLITE_FCNTL_HAS_MOVED, &moved);
  if (result != SQLITE_OK || moved != 0) {
    sqlite3_result_error(context, "BOARDROOM_SQLITE_SOURCE_CHANGED", -1);
    return;
  }
  sqlite3_result_int(context, 1);
}

int sqlite3_extension_init(sqlite3 *database, char **error, const sqlite3_api_routines *api) {
  (void)error;
  SQLITE_EXTENSION_INIT2(api);
  return sqlite3_create_function_v2(database, "boardroom_maintenance_source_unchanged", 0,
    SQLITE_UTF8 | SQLITE_DIRECTONLY, NULL, source_unchanged, NULL, NULL, NULL);
}

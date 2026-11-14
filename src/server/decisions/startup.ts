import { validateWorkEventInvalidations, WorkEventStorageInvalid } from '../tasks/work-event-storage.ts';
import type { DbRow } from '../db/driver.ts';
import type { DbDriver } from '../db/driver.ts';
import { initializeDecisionStorage } from './initializer.ts';
import { materializeLockedReview } from './materializer.ts';

/** Policy 初始化之后、HTTP/MCP 写入口开放之前显式运行；所有 GET 均不调用。 */
export async function initializeDecisions(db:DbDriver) {
  if (!(await db.query('SELECT version FROM schema_migrations WHERE version = 21')).length) throw new WorkEventStorageInvalid('schema_21_required');
  await db.readSnapshot(async snapshot => {
    const graph: Record<string, DbRow[]> = {};
    for (const table of ['work_event_delivery_invalidations','work_events','members','projects','audit_log']) graph[table] = await snapshot.query(`SELECT * FROM ${table}`);
    validateWorkEventInvalidations(graph);
  });
  return initializeDecisionStorage(db,{batchSize:100,materialize:(guard,at)=>
    materializeLockedReview(guard,{origin:'legacy-bootstrap',at})});
}

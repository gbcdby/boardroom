import { validateWorkEventInvalidations } from '../src/server/tasks/work-event-storage.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { identityFixture } from './helpers/identity-fixture.ts';
import { DECISION_MIGRATION_TABLES, seedDecisionMigrationSource } from './helpers/decisions-migration-fixture.ts';
import { validateDecisionStorageGraph } from '../src/server/decisions/storage-validation.ts';

test('M1 source fixture contains all 58 historical/current tables without opening an external runtime',async()=>{
  const f=await identityFixture('sqlite');
  try {
    const result=await seedDecisionMigrationSource(f.db);
    assert.equal(DECISION_MIGRATION_TABLES.length,58);
    assert.equal(new Set(DECISION_MIGRATION_TABLES).size,58);
    assert.ok(Object.values(result.counts).every(n=>n>0));
    assert.equal((await f.db.query('SELECT revision FROM mcp_connections WHERE id=?',['connection-copy']))[0]!.revision,Number.MAX_SAFE_INTEGER);
    const data:Record<string,Record<string,unknown>[]>={};
    for(const table of DECISION_MIGRATION_TABLES)data[table]=await f.db.query(`SELECT * FROM ${table}`);
    validateDecisionStorageGraph(data); validateWorkEventInvalidations(data);
    assert.equal(data['agent_runner_states']![0]!['state'],'stopped');
    assert.equal(data['agent_runner_states']![0]!['pid'],null);
    assert.ok(data['audit_log']!.some(row=>row['reversed_by_audit_id']!==null));
  }finally{await f.close();}
  await assert.rejects(access(f.dir),{code:'ENOENT'});
});

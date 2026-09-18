import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadExpectedSchema, inspectTaskSchema, extractSchema, TASK_SCHEMA_QUERY, TASK_MIGRATIONS } from '../scripts/check-ai-workbench-schema.mjs';
const directory = new URL('../migrations/oa/', import.meta.url);
const expected = loadExpectedSchema(directory);
const sql = TASK_MIGRATIONS.map(name => readFileSync(new URL(name, directory), 'utf8')).join('\n');
const clone = () => structuredClone(expected.objects);

test('empty task schema is pending and never accepted as initialized', () => {
  assert.equal(inspectTaskSchema([], expected).state, 'pending');
  assert.throws(() => inspectTaskSchema([], expected, true), /incomplete/);
});
test('actual additive migrations are complete and repeat-safe without deleting task data', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE members(id TEXT PRIMARY KEY); INSERT INTO members VALUES('member');");
    db.exec(sql);
    db.prepare('INSERT INTO ai_workbench_tasks(id,member_id,account_user_id,member_revision,kind,title,instruction,material,origin_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run('synthetic-id','member','account','rev','document','title','instruction','private source','key',1,1);
    db.exec(sql);
    assert.equal(inspectTaskSchema(db.prepare(TASK_SCHEMA_QUERY).all(), expected, true).state, 'applied');
    assert.equal(db.prepare('SELECT material FROM ai_workbench_tasks').get().material, 'private source');
  } finally { db.close(); }
});
test('partially initialized schemas require completion, not a destructive reset', () => {
  const rows = clone().filter(row => row.name !== 'ai_workbench_artifacts');
  assert.deepEqual(inspectTaskSchema(rows, expected).missing, ['ai_workbench_artifacts']);
  assert.throws(() => inspectTaskSchema(rows, expected, true), /incomplete/);
});
test('changed schema, duplicate rows, unexpected objects and wrong owners stop activation', () => {
  for (const rows of [
    [...clone(), clone()[0]],
    [...clone(), {name:'ai_workbench_unknown',type:'table',tbl_name:'ai_workbench_unknown',sql:'CREATE TABLE ai_workbench_unknown(id)'}],
    clone().map(row => row.name === 'ai_workbench_tasks' ? {...row,sql:row.sql.replace("DEFAULT 'queued'", "DEFAULT 'succeeded'")} : row),
    clone().map(row => ({...row,tbl_name:'other_table'})),
  ]) assert.throws(() => inspectTaskSchema(rows, expected), /differs/);
});
test('schema response must be an explicit successful single query result', () => {
  assert.deepEqual(extractSchema([{success:true,results:[]}]), []);
  for (const value of [null, {}, [], [{results:[]}], [{success:false,results:[]}], [{success:true,results:[]},{success:true,results:[]}]]) assert.throws(() => extractSchema(value), /Invalid/);
});
test('schema checker refuses destructive or symlinked migration input', () => {
  const dir = mkdtempSync(join(tmpdir(),'oa-task-schema-'));
  try {
    for (const name of TASK_MIGRATIONS) cpSync(new URL(name,directory),join(dir,name));
    writeFileSync(join(dir,TASK_MIGRATIONS[1]), 'DROP TABLE members;');
    assert.throws(() => loadExpectedSchema(dir), /additive/);
    rmSync(join(dir,TASK_MIGRATIONS[1])); symlinkSync(new URL(TASK_MIGRATIONS[1],directory),join(dir,TASK_MIGRATIONS[1]));
    assert.throws(() => loadExpectedSchema(dir), /Unsafe/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('activation cannot run from pull requests, without opt-in, or with missing provenance', () => {
  const script = new URL('../scripts/activate-ai-workbench-production.sh',import.meta.url);
  for (const values of [{}, {OA_ENABLE_AI_WORKBENCH:'true',GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'pull_request',GITHUB_REF:'refs/heads/main'}, {OA_ENABLE_AI_WORKBENCH:'true',GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main'}]) {
    const result=spawnSync('bash',[script.pathname],{encoding:'utf8',env:{PATH:process.env.PATH,...values}});
    assert.equal(result.status,64); assert.doesNotMatch(result.stdout,/deployed|initialized|enabled true/);
  }
});
test('workflow opt-in preserves manual production gating and all existing checks', () => {
  const workflow=readFileSync(new URL('../.github/workflows/deploy-oa.yml',import.meta.url),'utf8');
  assert.match(workflow,/enable_ai_workbench:[\s\S]*?type: boolean\s+default: false/);
  assert.match(workflow,/needs: test/); assert.match(workflow,/name: production-oa/);
  assert.match(workflow,/inputs\.enable_ai_workbench == true/);
  for(const check of ['npm run typecheck','npm run lint','npm test','npm run release:standalone:production']) assert.ok(workflow.includes(check));
  assert.ok(workflow.indexOf('run: npm run release:standalone:production') < workflow.indexOf('run: bash scripts/activate-ai-workbench-production.sh'));
});
test('schema checks, recovery bookmark and checksum validation precede activation deploy', () => {
  const script=readFileSync(new URL('../scripts/activate-ai-workbench-production.sh',import.meta.url),'utf8');
  const initialization=script.indexOf('--file "${activation}/migrations/${name}"');
  const enabling=script.indexOf('run_wrangler deploy --strict --keep-vars --var OA_AI_TASKS_ENABLED:true');
  assert.ok(script.indexOf('check_target "${activation}/target-before.json"') < initialization);
  assert.ok(script.indexOf('d1-bookmark-before.json') < initialization);
  assert.ok(script.indexOf('schema-verified.json') < enabling);
  assert.ok(initialization < enabling);
  assert.doesNotMatch(script,/d1\s+execute\s+WEBSITE_DB|--command[^\n]*(?:DROP|DELETE|TRUNCATE)/i);
  assert.match(script,/active_freezes!==0/); assert.match(script,/\/settings/);
});

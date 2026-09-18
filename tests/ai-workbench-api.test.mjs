import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

// Only session, runtime bindings and the upstream model are substitutes.
// SQL, task transitions, document compilation, hashing and downloads are real.
register(new URL('./helpers/ai-workbench-loader.mjs', import.meta.url));
globalThis.__aiWorkbenchTest = {};
const store = await import('../lib/ai-workbench-store.ts');
const api = await import('../app/api/lab-ai/tasks/route.ts');
const runner = await import('../lib/ai-workbench-runner.ts');
let sqlite, db, env, actor, modelCalls, failBatchAfter, beforeBatch;
const originalFetch = globalThis.fetch;
const input = { kind: 'document', title: '测试报告', instruction: '整理原文，缺失项目待补充', material: '本周已完成接口联调，实机验收尚未进行。' };
const output = '# 测试报告\n\n## 本周进展\n已完成接口联调，实机验收待进行。';
function adapter(sql, params = []) {
  return {
    bind(...values) { return adapter(sql, values); },
    async first() { return sqlite.prepare(sql).get(...params) || null; },
    async all() { return { results: sqlite.prepare(sql).all(...params) }; },
    async run() { return { meta: sqlite.prepare(sql).run(...params), success: true }; },
  };
}
const state = id => sqlite.prepare('SELECT * FROM ai_workbench_tasks WHERE id=?').get(id);
const fileCount = id => sqlite.prepare('SELECT count(*) n FROM ai_workbench_artifacts WHERE task_id=?').get(id).n;
const req = (body, origin = 'https://oa.omindos.ai') => new Request('https://oa.omindos.ai/api/lab-ai/tasks', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
const get = (id, format) => api.GET(new Request(`https://oa.omindos.ai/api/lab-ai/tasks${id ? `?id=${id}${format ? `&format=${format}` : ''}` : ''}`));
const create = () => store.createTask(db, actor, input, `oa:${crypto.randomUUID()}`);
beforeEach(() => {
  sqlite?.close(); sqlite = new DatabaseSync(':memory:');
  // Minimal existing-member/NDA fixture. Apply the actual, additive task migrations.
  sqlite.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE members(id TEXT PRIMARY KEY,chatgpt_account TEXT,account_user_id TEXT,status TEXT,mutation_revision TEXT,nda_accepted_at TEXT,nda_agreement_version TEXT,nda_approval_id TEXT);
    CREATE TABLE approvals(id TEXT PRIMARY KEY,type TEXT,status TEXT,requester_email TEXT,payload_json TEXT);`);
  for (const name of ['0002_ai_workbench.sql', '0003_ai_workbench_artifacts.sql']) {
    sqlite.exec(readFileSync(new URL(`../migrations/oa/${name}`, import.meta.url), 'utf8'));
  }
  for (const id of ['alice', 'bob']) {
    sqlite.prepare('INSERT INTO members VALUES (?,?,?,?,?,?,?,?)').run(id, `${id}@example.com`, `email:${id}@example.com`, 'active', 'revision-1', 'accepted', 'nda-1', `nda-${id}`);
    sqlite.prepare('INSERT INTO approvals VALUES (?,?,?,?,?)').run(`nda-${id}`, '保密协议', '已归档', `${id}@example.com`, JSON.stringify({ signerAccountUserId: `email:${id}@example.com`, agreementVersion: 'nda-1' }));
  }
  failBatchAfter = -1; beforeBatch = null;
  db = { prepare: adapter, async batch(statements) {
    beforeBatch?.(); sqlite.exec('BEGIN');
    try {
      const results = [];
      for (const [index, statement] of statements.entries()) {
        results.push(await statement.run());
        if (failBatchAfter === index) throw new Error('synthetic storage failure');
      }
      sqlite.exec('COMMIT'); return results;
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  env = { DB: db, OA_AI_TASKS_ENABLED: 'true' };
  actor = { memberId: 'alice', accountUserId: 'email:alice@example.com', memberMutationRevision: 'revision-1', ndaCompleted: true };
  modelCalls = 0;
  globalThis.__aiWorkbenchTest = { env, actor, generate: async value => { modelCalls++; assert.deepEqual(Object.keys(value).sort(), ['instruction', 'kind', 'material', 'title']); return output; } };
  globalThis.fetch = async () => { throw new Error('Unexpected external call: OA task tests must never send messages.'); };
});
after(() => { globalThis.fetch = originalFetch; delete globalThis.__aiWorkbenchTest; sqlite?.close(); });

test('OA session, admission and the feature flag are required', async () => {
  for (const [user, status] of [[null, 401], [{ ...actor, ndaCompleted: false }, 403], [{ ...actor, memberId: null, isAdmin: true }, 403]]) {
    globalThis.__aiWorkbenchTest.actor = user; assert.equal((await get()).status, status);
  }
  globalThis.__aiWorkbenchTest.actor = actor; delete env.OA_AI_TASKS_ENABLED; assert.equal((await get()).status, 503);
});
test('cross-site, oversized and injected tool/channel fields are rejected', async () => {
  const body = { action: 'create', requestId: crypto.randomUUID(), ...input };
  assert.equal((await api.POST(req(body, 'https://attacker.invalid'))).status, 403);
  for (const extra of [{ tools: ['send'] }, { origin: 'feishu' }, { action: 'shell' }]) assert.equal((await api.POST(req({ ...body, ...extra }))).status, 400);
  assert.equal((await api.POST(req({ ...body, material: 'x'.repeat(100000) }))).status, 413);
  assert.equal(modelCalls, 0);
});
test('create → execute → two archived files → exact-byte download and refresh', async () => {
  const created = await api.POST(req({ action: 'create', requestId: crypto.randomUUID(), ...input }));
  assert.equal(created.status, 201); const { task } = await created.json();
  assert.equal(task.status, 'queued'); assert.equal(fileCount(task.id), 0);
  assert.equal((await get(task.id, 'docx')).status, 409);
  const finished = await api.POST(req({ action: 'run', id: task.id }));
  assert.equal((await finished.json()).task.status, 'succeeded'); assert.equal(fileCount(task.id), 2); assert.equal(modelCalls, 1);
  for (const format of ['docx', 'md']) {
    const response = await get(task.id, format); assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    const saved = await store.readTaskArtifact(db, actor, task.id, format);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), Uint8Array.from(atob(saved.content_base64), ch => ch.charCodeAt(0)));
  }
  const md = await (await get(task.id, 'md')).text(); assert.equal((md.match(/# 测试报告/g) || []).length, 1);
  assert.equal((await (await get(task.id)).json()).task.result, md);
  assert.match((await get(task.id, 'docx')).headers.get('content-type'), /wordprocessingml/);
});
test('another member cannot list, read, execute or download an owner task', async () => {
  const row = await create(); await store.runTask(db, row.id, globalThis.__aiWorkbenchTest.generate);
  globalThis.__aiWorkbenchTest.actor = { ...actor, memberId: 'bob', accountUserId: 'email:bob@example.com' };
  assert.deepEqual((await (await get()).json()).tasks, []);
  for (const format of [null, 'md', 'docx']) assert.equal((await get(row.id, format)).status, 404);
  assert.equal((await api.POST(req({ action: 'run', id: row.id }))).status, 404); assert.equal(modelCalls, 1);
});
test('duplicate submissions and concurrent execution generate and archive only once', async () => {
  const key = `oa:${crypto.randomUUID()}`;
  const [a, b] = await Promise.all([store.createTask(db, actor, input, key), store.createTask(db, actor, input, key)]);
  assert.equal(a.id, b.id);
  await Promise.all([store.runTask(db, a.id, globalThis.__aiWorkbenchTest.generate), store.runTask(db, a.id, globalThis.__aiWorkbenchTest.generate)]);
  assert.equal(modelCalls, 1); assert.equal(fileCount(a.id), 2); assert.equal(state(a.id).attempts, 1);
  await assert.rejects(store.createTask(db, actor, { ...input, material: '不同的材料正文' }, key), /IDEMPOTENCY/);
});
test('incomplete model output never produces a successful task or download', async () => {
  const row = await create(); await store.runTask(db, row.id, async () => '本次回答尚未完整生成，请稍后继续。');
  assert.equal(state(row.id).status, 'failed'); assert.equal(fileCount(row.id), 0); assert.equal((await get(row.id, 'docx')).status, 409);
});
test('a file-generation failure is distinct from a model failure', async () => {
  const row = await create(); await store.runTask(db, row.id, async () => '# 测试报告\n\n很短。');
  assert.equal(state(row.id).status, 'failed'); assert.equal(state(row.id).failure_code, 'TASK_ARTIFACT_FAILED'); assert.equal(fileCount(row.id), 0);
});
test('a failed second file write rolls back the first file and never marks success', async () => {
  const row = await create(); failBatchAfter = 1; await store.runTask(db, row.id, globalThis.__aiWorkbenchTest.generate);
  assert.equal(state(row.id).status, 'failed'); assert.equal(state(row.id).failure_code, 'TASK_SAVE_FAILED'); assert.equal(state(row.id).result, ''); assert.equal(fileCount(row.id), 0);
  failBatchAfter = -1; assert.ok(await store.retryTask(db, actor, row.id)); await store.runTask(db, row.id, globalThis.__aiWorkbenchTest.generate);
  assert.equal(state(row.id).status, 'succeeded'); assert.equal(fileCount(row.id), 2);
});
test('cancelling during generation discards late text and files', async () => {
  const row = await create(); let resolve;
  const pending = store.runTask(db, row.id, () => new Promise(r => { resolve = r; })); await new Promise(setImmediate);
  await store.cancelTask(db, actor, row.id); resolve(output); await pending;
  assert.equal(state(row.id).status, 'cancelled'); assert.equal(fileCount(row.id), 0); assert.equal(state(row.id).result, '');
});
test('NDA revocation immediately before storage blocks every artifact', async () => {
  const row = await create(); beforeBatch = () => sqlite.exec("UPDATE approvals SET status='已作废' WHERE id='nda-alice'");
  await store.runTask(db, row.id, globalThis.__aiWorkbenchTest.generate);
  assert.equal(state(row.id).status, 'failed'); assert.equal(fileCount(row.id), 0); assert.equal(state(row.id).result, '');
});
test('revoked NDA also blocks an already-generated file download', async () => {
  const row = await create(); await store.runTask(db, row.id, globalThis.__aiWorkbenchTest.generate);
  sqlite.exec("UPDATE approvals SET status='已作废' WHERE id='nda-alice'");
  assert.equal((await get(row.id, 'docx')).status, 404);
});
test('expired running leases fail without automatically consuming another model call', async () => {
  const row = await create(); sqlite.prepare("UPDATE ai_workbench_tasks SET status='running',attempts=1,lease_until=0 WHERE id=?").run(row.id);
  await store.runTask(db, row.id, globalThis.__aiWorkbenchTest.generate);
  assert.equal(modelCalls, 0); assert.equal(state(row.id).failure_code, 'TASK_INTERRUPTED'); assert.equal(fileCount(row.id), 0);
});
test('generation that finishes after its lease expires cannot archive results', async () => {
  const row = await create(); await store.runTask(db, row.id, async () => { sqlite.prepare('UPDATE ai_workbench_tasks SET lease_until=0 WHERE id=?').run(row.id); return output; });
  assert.equal(state(row.id).status, 'failed'); assert.equal(fileCount(row.id), 0);
});
test('a task cannot be retried more than three times', async () => {
  const row = await create(); const fail = async () => { throw new Error('private upstream details'); };
  for (let i = 0; i < 3; i++) { if (i) assert.ok(await store.retryTask(db, actor, row.id)); await store.runTask(db, row.id, fail); }
  assert.equal(await store.retryTask(db, actor, row.id), null); assert.equal(state(row.id).attempts, 3);
  assert.ok(!JSON.stringify(state(row.id)).includes('private upstream'));
});
test('retry cannot bypass the five-active-task limit', async () => {
  const row = await create(); await store.runTask(db, row.id, async () => { throw new Error('synthetic failure'); });
  for (let i = 0; i < 5; i++) await create();
  assert.equal(await store.retryTask(db, actor, row.id), null);
});
test('OA processing needs no Feishu credentials and ignores legacy Feishu tasks', async () => {
  const legacy = await create(); sqlite.prepare("UPDATE ai_workbench_tasks SET origin='feishu' WHERE id=?").run(legacy.id);
  const oa = await create(); await runner.processAiWorkbench(env);
  assert.equal(state(oa.id).status, 'succeeded'); assert.equal(state(legacy.id).status, 'queued'); assert.equal(modelCalls, 1);
  assert.equal(await store.readTask(db, actor, legacy.id), null);
  await assert.rejects(store.createTask(db, actor, input, 'feishu:message123'), /INVALID_INPUT/);
});
test('disabled processing does not touch queued tasks or call a model', async () => {
  const row = await create(); env.OA_AI_TASKS_ENABLED = 'false'; await runner.processAiWorkbench(env);
  assert.equal(state(row.id).status, 'queued'); assert.equal(modelCalls, 0);
});
test('corrupted saved bytes are refused rather than returned as a Word file', async () => {
  const row = await create(); await store.runTask(db, row.id, globalThis.__aiWorkbenchTest.generate);
  sqlite.prepare("UPDATE ai_workbench_artifacts SET sha256=? WHERE task_id=? AND format='docx'").run('0'.repeat(64), row.id);
  assert.equal((await get(row.id, 'docx')).status, 503); assert.equal((await get(row.id, 'md')).status, 200);
});
test('artifact schema migration is repeat-safe and retains saved files', async () => {
  const row = await create(); await store.runTask(db, row.id, globalThis.__aiWorkbenchTest.generate);
  sqlite.exec(readFileSync(new URL('../migrations/oa/0003_ai_workbench_artifacts.sql', import.meta.url), 'utf8'));
  assert.equal(fileCount(row.id), 2); assert.equal((await get(row.id, 'docx')).status, 200);
});
test('a missing artifact migration blocks execution before a model call', async () => {
  const row = await create(); sqlite.exec('DROP TABLE ai_workbench_artifacts');
  await assert.rejects(store.runTask(db, row.id, globalThis.__aiWorkbenchTest.generate));
  assert.equal(modelCalls, 0); assert.equal(state(row.id).status, 'queued'); assert.equal(state(row.id).attempts, 0);
});

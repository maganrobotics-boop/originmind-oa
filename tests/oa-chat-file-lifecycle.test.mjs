import assert from 'node:assert/strict';
import test, { beforeEach, after } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
register(new URL('./helpers/oa-chat-file-loader.mjs', import.meta.url));
globalThis.__oaChatFileTests = {};
const lifecycle = await import('../lib/oa-chat-file-lifecycle.ts');
const archive = await import('../app/api/lab-ai/archive/route.ts');
const extraction = await import('../app/api/lab-ai/extract/route.ts');
const knowledge = await import('../lib/knowledge-store.ts');
let sqlite, db, actor, env, failAfter = -1, beforeBatch;
const migrations = ['0002_ai_workbench.sql', '0003_ai_workbench_artifacts.sql', '0004_ai_workbench_retention.sql'];
const loadSql = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
function statement(sql, bindings = []) {
  return { bind: (...args) => statement(sql, args), async first() { return sqlite.prepare(sql).all(...bindings)[0] || null; },
    async all() { return { results: sqlite.prepare(sql).all(...bindings), success: true }; },
    async run() { const query = sqlite.prepare(sql); const results = query.all(...bindings); return { results, success: true, meta: { changes: sqlite.prepare('SELECT changes() n').get().n } }; } };
}
function insertTask({ id = crypto.randomUUID(), age = 0, status = 'succeeded', owner = 'alice', origin = 'oa' } = {}) {
  const now = Date.now() - age;
  sqlite.prepare(`INSERT INTO ai_workbench_tasks(id,member_id,account_user_id,member_revision,kind,title,instruction,material,status,result,origin,origin_key,created_at,updated_at)
    VALUES(?,?,?,'revision-1','document','测试成果','整理材料','仅在临时任务中保存的原始材料',?,'# 真实成果正文\n\n接口测试已经完成，实机验收尚未开展；负责人和日期待补充。',?,?,?,?)`)
    .run(id, owner, `email:${owner}@example.com`, status, origin, `${origin}:${id}`, now, now);
  if (status === 'succeeded') sqlite.prepare("INSERT INTO ai_workbench_artifacts VALUES(?,'md','dGVzdA==',4,?,'lease',?)").run(id, 'a'.repeat(64), now);
  return id;
}
const readTask = id => sqlite.prepare('SELECT * FROM ai_workbench_tasks WHERE id=?').get(id);
const readRetention = id => sqlite.prepare('SELECT * FROM ai_workbench_retention WHERE task_id=?').get(id);
const req = (id, more = {}, origin = 'https://oa.omindos.ai') => new Request('https://oa.omindos.ai/api/lab-ai/archive', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ id, confirmed: true, ...more }) });
beforeEach(() => {
  sqlite?.close(); sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE migration_control(freeze_id TEXT PRIMARY KEY,activated_at TEXT,deactivated_at TEXT);
    CREATE TABLE members(id TEXT PRIMARY KEY,status TEXT,account_user_id TEXT,mutation_revision TEXT,nda_accepted_at TEXT,nda_agreement_version TEXT,nda_approval_id TEXT,chatgpt_account TEXT,role TEXT,permissions_json TEXT DEFAULT '[]');
    CREATE TABLE approvals(id TEXT PRIMARY KEY,type TEXT,status TEXT,requester_email TEXT,payload_json TEXT);`);
  for (const member of ['alice', 'bob']) {
    sqlite.prepare("INSERT INTO members VALUES(?,'active',?,'revision-1','accepted','nda-1',?,?,?, '[]')").run(member, `email:${member}@example.com`, `nda-${member}`, `${member}@example.com`, member === 'bob' ? 'project_owner' : 'member');
    sqlite.prepare('INSERT INTO approvals VALUES(?,?,?,?,?)').run(`nda-${member}`, '保密协议', '已归档', `${member}@example.com`, JSON.stringify({ signerAccountUserId: `email:${member}@example.com`, agreementVersion: 'nda-1' }));
  }
  for (const name of migrations) sqlite.exec(loadSql(`migrations/oa/${name}`));
  for (const name of ['0026_rich_jocasta.sql','0027_careless_winter_soldier.sql','0028_needy_microchip.sql','0029_knowledge_visibility_reclassification.sql','0030_large_knowledge_revision_parts.sql','0031_knowledge_assets.sql']) sqlite.exec(loadSql(`drizzle/${name}`));
  failAfter = -1; beforeBatch = null;
  db = { prepare: statement, async batch(statements) {
    beforeBatch?.(); beforeBatch = null; sqlite.exec('BEGIN IMMEDIATE');
    try { const results = []; for (const [index, item] of statements.entries()) { results.push(await item.run()); if (index === failAfter) throw new Error('synthetic storage failure'); } sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  actor = { memberId: 'alice', accountUserId: 'email:alice@example.com', memberMutationRevision: 'revision-1', ndaCompleted: true, isAdmin: false, user: { displayName: '测试用户', email: 'alice@example.com' } };
  env = { DB: db, OA_AI_TASKS_ENABLED: 'true', AI: { toMarkdown: async () => ({ format: 'markdown', data: '文件解析测试正文，只有确认归档后才提交审批。' }) } };
  globalThis.__oaChatFileTests = { db, actor, env, allowed: true };
});
after(() => { sqlite?.close(); delete globalThis.__oaChatFileTests; });

test('forward-only migration never enrolls or deletes legacy tasks', async () => {
  sqlite.exec('DROP TRIGGER ai_workbench_retention_enroll'); const id = insertTask({ age: 30 * 86400000 });
  sqlite.exec(loadSql('migrations/oa/0004_ai_workbench_retention.sql'));
  assert.equal(readRetention(id), undefined); await lifecycle.cleanupTemporaryFiles(db); assert.ok(readTask(id));
  const newer = insertTask(); assert.equal(readRetention(newer).state, 'temporary');
});
test('only expired terminal OA rows and their actual artifacts are erased', async () => {
  const old = insertTask({ age: 8 * 86400000 }), recent = insertTask(), queued = insertTask({ age: 8 * 86400000, status: 'queued' }), running = insertTask({ age: 8 * 86400000, status: 'running' }), foreign = insertTask({ age: 8 * 86400000, origin: 'feishu' });
  await lifecycle.cleanupTemporaryFiles(db);
  assert.equal(readTask(old), undefined); assert.equal(readRetention(old), undefined);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM ai_workbench_artifacts WHERE task_id=?').get(old).n, 0);
  for (const id of [recent, queued, running, foreign]) assert.ok(readTask(id));
});
test('seven-day clock starts no earlier than final processing update', async () => {
  const id = insertTask({ age: 10 * 86400000 }); sqlite.prepare('UPDATE ai_workbench_tasks SET updated_at=? WHERE id=?').run(Date.now(), id);
  await lifecycle.cleanupTemporaryFiles(db); assert.ok(readTask(id));
});
test('archive pin excludes both uncertain and confirmed submissions from cleanup', async () => {
  const id = insertTask({ age: 8 * 86400000 }); await lifecycle.pinFileArchive(db, actor, id);
  assert.equal(readRetention(id).state, 'archiving'); await lifecycle.cleanupTemporaryFiles(db, Date.now() + 365 * 86400000); assert.ok(readTask(id));
  await lifecycle.acknowledgeFileArchive(db, actor, id, 'knowledge-id'); await lifecycle.cleanupTemporaryFiles(db, Date.now() + 365 * 86400000); assert.ok(readTask(id));
});
test('transaction failure rolls back the cleanup claim and artifact deletion', async () => {
  const id = insertTask({ age: 8 * 86400000 }); failAfter = 1;
  await assert.rejects(lifecycle.cleanupTemporaryFiles(db), /synthetic/);
  assert.ok(readTask(id)); assert.equal(readRetention(id).state, 'temporary');
  assert.equal(sqlite.prepare('SELECT count(*) n FROM ai_workbench_artifacts WHERE task_id=?').get(id).n, 1);
});
test('cleanup first cannot be reversed by a late archival request', async () => {
  const id = insertTask({ age: 8 * 86400000 }); await lifecycle.cleanupTemporaryFiles(db);
  await assert.rejects(lifecycle.pinFileArchive(db, actor, id), /NOT_AVAILABLE/);
  assert.equal((await archive.POST(req(id))).status, 404);
});
test('current owner and live NDA/member revision are required for archival', async () => {
  const id = insertTask();
  assert.equal((await archive.POST(req(id, {}, 'https://evil.invalid'))).status, 403);
  assert.equal((await archive.POST(req(id, { confirmed: false }))).status, 400);
  assert.equal((await archive.POST(req(id, { content: 'injected replacement', status: 'active' }))).status, 400);
  globalThis.__oaChatFileTests.actor = { ...actor, memberId: 'bob', accountUserId: 'email:bob@example.com' };
  assert.equal((await archive.POST(req(id))).status, 404);
  globalThis.__oaChatFileTests.actor = actor; sqlite.exec("UPDATE members SET mutation_revision='new' WHERE id='alice'");
  assert.equal((await archive.POST(req(id))).status, 403); assert.equal(readRetention(id).state, 'temporary');
});
test('real archival creates pending internal knowledge exactly once, never searchable on submission', async () => {
  const id = insertTask();
  const first = await archive.POST(req(id)); assert.equal(first.status, 201, await first.clone().text());
  const body = await first.json(); assert.equal(body.item.status, 'pending'); assert.equal(body.item.visibility, 'internal');
  const item = sqlite.prepare('SELECT * FROM knowledge_items WHERE id=?').get(body.item.id);
  assert.equal(item.active_revision_id, null); assert.equal(sqlite.prepare('SELECT count(*) n FROM knowledge_chunks').get().n, 0);
  assert.equal(readRetention(id).state, 'submitted');
  const again = await archive.POST(req(id)); assert.equal(again.status, 200); assert.equal((await again.json()).item.id, item.id);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM knowledge_items').get().n, 1);
  const owner = { ...actor, name: actor.user.displayName, email: actor.user.email };
  const stored = await knowledge.findKnowledgeItem(item.id, owner); assert.equal(stored.content, readTask(id).result.normalize('NFKC'));
  assert.deepEqual(await knowledge.getActiveKnowledgeChunks(owner), []);
  const reviewer = { memberId:'bob', accountUserId:'email:bob@example.com', memberMutationRevision:'revision-1', name:'审核者', email:'bob@example.com', isAdmin:false };
  const approved = await knowledge.reviewKnowledgeItem(stored, reviewer, 'approve', '已核对材料', 'internal');
  assert.equal(approved.status, 'active');
  assert.ok((await knowledge.getActiveKnowledgeChunks(owner)).some(chunk => chunk.itemId === item.id));
  assert.deepEqual(await knowledge.getPublicActiveKnowledgeChunks(), []);
  const approvedResponse = await archive.GET(new Request(`https://oa.omindos.ai/api/lab-ai/archive?id=${id}`));
  assert.equal((await approvedResponse.json()).lifecycle.knowledgeStatus, 'active');
});
test('rate-limit or lost approval write leaves archival protection in place for retry', async () => {
  const id = insertTask({ age: 8 * 86400000 }); globalThis.__oaChatFileTests.allowed = false;
  assert.equal((await archive.POST(req(id))).status, 429); assert.equal(readRetention(id).state, 'archiving');
  await lifecycle.cleanupTemporaryFiles(db, Date.now() + 30 * 86400000); assert.ok(readTask(id));
  globalThis.__oaChatFileTests.allowed = true; assert.equal((await archive.POST(req(id))).status, 201);
});
test('file conversion is private and validates auth, origin, type and actual content', async () => {
  const file = Buffer.from('%PDF-1.4\nsynthetic content\n%%EOF');
  const request = (name = 'test.pdf', bytes = file, origin = 'https://oa.omindos.ai') => new Request('https://oa.omindos.ai/api/lab-ai/extract', { method: 'POST', headers: { origin, 'content-type': 'application/pdf', 'x-oa-file-name': encodeURIComponent(name) }, body: bytes });
  let calls = 0; env.AI.toMarkdown = async () => { calls++; return { format: 'markdown', data: '这里是完整的文件解析正文，仅用于对话。' }; };
  assert.equal((await extraction.POST(request('test.pdf', file, 'https://evil.invalid'))).status, 403);
  assert.equal((await extraction.POST(request('../test.pdf'))).status, 400);
  assert.equal((await extraction.POST(request('test.exe'))).status, 415);
  assert.equal((await extraction.POST(request('test.pdf', Buffer.from('not a PDF')))).status, 422);
  assert.equal(calls, 0);
  const result = await extraction.POST(request()); assert.equal(result.status, 200, await result.clone().text()); assert.equal((await result.json()).temporary, true);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM knowledge_items').get().n, 0); assert.equal(sqlite.prepare('SELECT count(*) n FROM ai_workbench_tasks').get().n, 0);
  assert.equal(calls, 1);
});

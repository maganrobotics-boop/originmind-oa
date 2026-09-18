import assert from 'node:assert/strict';
import test, { beforeEach, after } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
register(new URL('./helpers/oa-document-draft-loader.mjs', import.meta.url));
globalThis.__oaChatFileTests = {};
const { saveDocumentDraft, validDocumentDraft } = await import('../lib/oa-document-draft.ts');
const lifecycle = await import('../lib/oa-chat-file-lifecycle.ts');
const tasks = await import('../app/api/lab-ai/tasks/route.ts');
const { verifiedArtifactBytes } = await import('../lib/ai-workbench-artifacts.mjs');
let sqlite, db, actor, failAfter = -1, beforeBatch;
const result = '原型已经完成装配，实机测试尚未开展；负责人和截止日期均待补充。';
function statement(sql, bindings = []) {
  return { bind: (...args) => statement(sql, args), async first() { return sqlite.prepare(sql).all(...bindings)[0] || null; },
    async all() { return { results: sqlite.prepare(sql).all(...bindings), success: true }; },
    async run() { const results = sqlite.prepare(sql).all(...bindings); return { results, success: true, meta: { changes: sqlite.prepare('SELECT changes() n').get().n } }; } };
}
const row = id => sqlite.prepare('SELECT * FROM ai_workbench_tasks WHERE id=?').get(id);
const retention = id => sqlite.prepare('SELECT * FROM ai_workbench_retention WHERE task_id=?').get(id);
function insert({ age = 0, status = 'succeeded', owner = 'alice' } = {}) {
  const id = crypto.randomUUID(), now = Date.now() - age;
  sqlite.prepare(`INSERT INTO ai_workbench_tasks(id,member_id,account_user_id,member_revision,kind,title,instruction,material,status,result,origin,origin_key,created_at,updated_at)
    VALUES(?,?,?,'revision-1','meeting_minutes','原始标题','整理纪要','原始材料保持不变',?,?,'oa',?,?,?)`)
    .run(id, owner, `email:${owner}@example.com`, status, `# 原始标题\n\n${result}\n`, `oa:${id}`, now, now);
  return id;
}
const draft = id => ({ title: '人工核对稿', result: `${result}\n补充：下一步先核对接口。`, expectedUpdatedAt: row(id).updated_at });
const request = (id, more = {}, origin = 'https://oa.omindos.ai') => new Request('https://oa.omindos.ai/api/lab-ai/tasks', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'saveDraft', id, ...draft(id), ...more }) });
beforeEach(() => {
  sqlite?.close(); sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE members(id TEXT PRIMARY KEY,status TEXT,account_user_id TEXT,mutation_revision TEXT,nda_accepted_at TEXT,nda_agreement_version TEXT,nda_approval_id TEXT,chatgpt_account TEXT);
    CREATE TABLE approvals(id TEXT PRIMARY KEY,type TEXT,status TEXT,requester_email TEXT,payload_json TEXT);
    CREATE TABLE knowledge_items(id TEXT PRIMARY KEY);`);
  for (const member of ['alice', 'bob']) {
    sqlite.prepare("INSERT INTO members VALUES(?,'active',?,'revision-1','accepted','nda-1',?,?)").run(member, `email:${member}@example.com`, `nda-${member}`, `${member}@example.com`);
    sqlite.prepare('INSERT INTO approvals VALUES(?,?,?,?,?)').run(`nda-${member}`, '保密协议', '已归档', `${member}@example.com`, JSON.stringify({ signerAccountUserId: `email:${member}@example.com`, agreementVersion: 'nda-1' }));
  }
  for (const name of ['0002_ai_workbench.sql', '0003_ai_workbench_artifacts.sql', '0004_ai_workbench_retention.sql']) sqlite.exec(readFileSync(new URL(`../migrations/oa/${name}`, import.meta.url), 'utf8'));
  failAfter = -1; beforeBatch = null;
  db = { prepare: statement, async batch(statements) {
    const hook = beforeBatch; beforeBatch = null; await hook?.(); sqlite.exec('BEGIN IMMEDIATE');
    try { const results = []; for (const [index, item] of statements.entries()) { results.push(await item.run()); if (index === failAfter) throw new Error('synthetic storage failure'); } sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  actor = { memberId: 'alice', accountUserId: 'email:alice@example.com', memberMutationRevision: 'revision-1' };
  globalThis.__oaChatFileTests = { db, actor: { ...actor, ndaCompleted: true }, env: { DB: db, OA_AI_TASKS_ENABLED: 'true' }, allowed: true };
});
after(() => { sqlite?.close(); delete globalThis.__oaChatFileTests; });

test('draft validation refuses missing versions, unsafe text, oversized content and invalid titles', () => {
  const value = { title: '会议纪要', result, expectedUpdatedAt: 1 };
  assert.equal(validDocumentDraft(value), true);
  for (const change of [{ title: '' }, { title: 'a\n标题' }, { title: '\ud800' }, { result: '<script>alert(1)</script>' }, { result: '短' }, { result: '字'.repeat(18001) }, { expectedUpdatedAt: 0 }, { expectedUpdatedAt: 1.1 }, { expectedUpdatedAt: '1' }]) assert.equal(validDocumentDraft({ ...value, ...change }), false);
});
test('save updates title, body, actual Word/Markdown and expiry together without knowledge writes', async () => {
  const id = insert(), input = draft(id), saved = await saveDocumentDraft(db, actor, id, input);
  assert.equal(saved.title, input.title); assert.equal(saved.result, `# ${input.title}\n\n${input.result}\n`);
  assert.equal(saved.material, '原始材料保持不变'); assert.ok(saved.updated_at > input.expectedUpdatedAt);
  assert.equal(retention(id).state, 'temporary'); assert.equal(retention(id).expires_at, null); assert.equal(retention(id).knowledge_item_id, null);
  const artifacts = sqlite.prepare('SELECT * FROM ai_workbench_artifacts WHERE task_id=?').all(id); assert.equal(artifacts.length, 2);
  for (const file of artifacts) { const bytes = await verifiedArtifactBytes(file); assert.equal(file.created_at, saved.updated_at); if (file.format === 'md') assert.equal(new TextDecoder().decode(bytes), saved.result); else { assert.equal(Buffer.from(bytes).subarray(0, 2).toString(), 'PK'); assert.ok(Buffer.from(bytes).includes(Buffer.from('人工核对稿'))); } }
  assert.equal(sqlite.prepare('SELECT count(*) n FROM knowledge_items').get().n, 0);
});
test('rename does not duplicate the original generated heading', async () => {
  const id = insert(); const saved = await saveDocumentDraft(db, actor, id, { ...draft(id), result: row(id).result });
  assert.equal(saved.result.includes('# 原始标题'), false); assert.equal(saved.result.match(/^# /gmu).length, 1);
});
test('a saved draft survives cleanup while an expired unsaved result is removed', async () => {
  const kept = insert({ age: 9 * 86400000 }), removed = insert({ age: 9 * 86400000 });
  await saveDocumentDraft(db, actor, kept, draft(kept)); await lifecycle.cleanupTemporaryFiles(db, Date.now() + 365 * 86400000);
  assert.ok(row(kept)); assert.equal(row(removed), undefined);
});
test('lost acknowledgement retry is idempotent and does not advance the version again', async () => {
  const id = insert(), input = draft(id); const first = await saveDocumentDraft(db, actor, id, input);
  const second = await saveDocumentDraft(db, actor, id, input); assert.equal(second.updated_at, first.updated_at);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM ai_workbench_artifacts WHERE task_id=?').get(id).n, 2);
});
test('a stale different edit cannot overwrite the newest draft', async () => {
  const id = insert(), input = draft(id); const first = await saveDocumentDraft(db, actor, id, input);
  await assert.rejects(saveDocumentDraft(db, actor, id, { ...input, result: '这是另一窗口仍基于旧版本的不同修改，不得覆盖新稿。' }), /DRAFT_CONFLICT/);
  assert.equal(row(id).result, first.result);
});
test('transaction failure rolls back both artifact files, body and draft protection', async () => {
  const id = insert(), original = row(id); failAfter = 2;
  await assert.rejects(saveDocumentDraft(db, actor, id, draft(id)), /synthetic/);
  assert.deepEqual(row(id), original); assert.notEqual(retention(id).expires_at, null);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM ai_workbench_artifacts').get().n, 0);
});
test('a concurrent archive pin wins without partial file replacement', async () => {
  const id = insert(), original = row(id); beforeBatch = () => lifecycle.pinFileArchive(db, actor, id);
  await assert.rejects(saveDocumentDraft(db, actor, id, draft(id)), /DRAFT_CONFLICT/);
  assert.equal(row(id).result, original.result); assert.equal(retention(id).state, 'archiving');
  assert.equal(sqlite.prepare('SELECT count(*) n FROM ai_workbench_artifacts').get().n, 0);
});
test('an old approval version cannot pin a newly saved draft', async () => {
  const id = insert(), old = row(id).updated_at; const saved = await saveDocumentDraft(db, actor, id, draft(id));
  await assert.rejects(lifecycle.pinFileArchive(db, actor, id, Date.now(), old), /VERSION_CONFLICT/);
  assert.equal(retention(id).state, 'temporary');
  await lifecycle.pinFileArchive(db, actor, id, Date.now(), saved.updated_at); assert.equal(retention(id).state, 'archiving');
});
test('pending and submitted approval versions reject editing', async () => {
  const id = insert(); await lifecycle.pinFileArchive(db, actor, id);
  await assert.rejects(saveDocumentDraft(db, actor, id, draft(id)), /DRAFT_LOCKED/);
  await lifecycle.acknowledgeFileArchive(db, actor, id, 'approval-record');
  await assert.rejects(saveDocumentDraft(db, actor, id, draft(id)), /DRAFT_LOCKED/);
});
test('another member cannot save the owner document', async () => {
  const id = insert(); await assert.rejects(saveDocumentDraft(db, { ...actor, memberId: 'bob', accountUserId: 'email:bob@example.com' }, id, draft(id)), /DRAFT_NOT_FOUND/);
});
test('revoked member admission during a save prevents the entire write', async () => {
  const id = insert(), original = row(id); beforeBatch = () => sqlite.exec("UPDATE members SET mutation_revision='revoked' WHERE id='alice'");
  await assert.rejects(saveDocumentDraft(db, actor, id, draft(id)), /DRAFT_CONFLICT/); assert.deepEqual(row(id), original);
});
test('legacy completed tasks can be explicitly saved without enrolling unrelated history', async () => {
  const id = insert(), untouched = insert(); sqlite.prepare('DELETE FROM ai_workbench_retention WHERE task_id IN (?,?)').run(id, untouched);
  await saveDocumentDraft(db, actor, id, draft(id)); assert.equal(retention(id).expires_at, null); assert.equal(retention(untouched), undefined);
});
test('task API saves and downloads the edited files without calling the model', async () => {
  const id = insert(); const response = await tasks.POST(request(id)); assert.equal(response.status, 200, await response.clone().text());
  const data = await response.json(); assert.equal(data.saved, true); assert.equal(data.task.title, '人工核对稿'); assert.equal(data.task.member_id, undefined);
  for (const format of ['md', 'docx']) { const file = await tasks.GET(new Request(`https://oa.omindos.ai/api/lab-ai/tasks?id=${id}&format=${format}`)); assert.equal(file.status, 200); assert.ok((await file.arrayBuffer()).byteLength > 10); }
});
test('task API rejects cross-origin writes, extra approval fields and missing versions', async () => {
  const id = insert(); assert.equal((await tasks.POST(request(id, {}, 'https://evil.invalid'))).status, 403);
  assert.equal((await tasks.POST(request(id, { status: 'active' }))).status, 400);
  assert.equal((await tasks.POST(request(id, { expectedUpdatedAt: null }))).status, 400);
  assert.notEqual(retention(id).expires_at, null);
});
test('task API returns conflict for stale content and forbids unauthenticated saves', async () => {
  const id = insert(), old = row(id).updated_at; await tasks.POST(request(id));
  const conflict = await tasks.POST(request(id, { expectedUpdatedAt: old, result: '不同旧版本的修改，不得覆盖当前人工核对稿。' })); assert.equal(conflict.status, 409);
  globalThis.__oaChatFileTests.actor = null; assert.equal((await tasks.POST(request(id))).status, 401);
});

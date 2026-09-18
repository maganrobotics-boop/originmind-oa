import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import ts from 'typescript';

// Execute the actual route/store SQL with SQLite. Only session and D1 transport
// are substituted. Read-only artifact validation is the production implementation.
const root = new URL('../', import.meta.url);
const source = path => readFileSync(new URL(path, root), 'utf8');
const uri = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
const guardSource = source('lib/ai-workbench-store.ts');
const nda = /export const taskNdaGuard = `([\s\S]*?)`;/u.exec(guardSource)?.[1];
const actorGuard = /export const taskActorGuard = `([\s\S]*?)`;/u.exec(guardSource)?.[1];
assert.ok(nda && actorGuard, 'test uses the real membership and archived-NDA guards');
const guards = uri(`export const taskActorGuard=${JSON.stringify(actorGuard.replace('${taskNdaGuard}', nda))};`);
function compile(path, imports) {
  let text = ts.transpileModule(source(path), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const [specifier, replacement] of Object.entries(imports)) text = text.replaceAll(`from '${specifier}'`, `from '${replacement}'`).replaceAll(`from "${specifier}"`, `from '${replacement}'`);
  return uri(text);
}
const key = '__admin_meeting_minutes_test';
const store = compile('lib/admin-meeting-minutes.ts', { './ai-workbench-store': guards });
const artifactCode = source('lib/ai-workbench-artifacts.mjs')
  .replace("import { validTaskResult } from './ai-workbench-core.mjs';", 'const validTaskResult=()=>{throw new Error("generation not allowed");};')
  .replace("import { taskDocx } from './ai-workbench-docx.mjs';", 'const taskDocx=()=>{throw new Error("generation not allowed");};');
const route = await import(compile('app/api/admin/meeting-minutes/route.ts', {
  '../../../../db': uri(`export async function getD1Database(){return globalThis.${key}.d1;}`),
  '../../_lib/auth': uri(`export async function getAuthorizedUser(options){globalThis.${key}.authOptions=options;return globalThis.${key}.user;}`),
  '../../../../lib/admin-meeting-minutes': store,
  '../../../../lib/ai-workbench-artifacts.mjs': uri(artifactCode),
}));
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE members(id TEXT PRIMARY KEY,full_name TEXT,account_user_id TEXT,mutation_revision TEXT,status TEXT,chatgpt_account TEXT,nda_accepted_at TEXT,nda_agreement_version TEXT,nda_approval_id TEXT);
    CREATE TABLE approvals(id TEXT,type TEXT,status TEXT,requester_email TEXT,payload_json TEXT);
    CREATE TABLE ai_workbench_tasks(id TEXT PRIMARY KEY,member_id TEXT,account_user_id TEXT,kind TEXT,title TEXT,status TEXT,material TEXT,result TEXT,instruction TEXT,origin TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE ai_workbench_artifacts(task_id TEXT,format TEXT,content_base64 TEXT,byte_size INTEGER,sha256 TEXT);`);
  db.prepare('INSERT INTO members VALUES(?,?,?,?,?,?,?,?,?)').run('admin', '管理员', 'account-admin', 'revision-1', 'active', 'admin@example.test', '2026-01-01', 'v1', 'nda-admin');
  db.prepare('INSERT INTO approvals VALUES(?,?,?,?,?)').run('nda-admin', '保密协议', '已归档', 'admin@example.test', JSON.stringify({ signerAccountUserId: 'account-admin', agreementVersion: 'v1' }));
  db.prepare('INSERT INTO members VALUES(?,?,?,?,?,?,?,?,?)').run('member', '上传成员', 'account-member', 'revision-2', 'active', 'member@example.test', null, null, null);
  const user = { isAdmin: true, ndaCompleted: true, memberId: 'admin', accountUserId: 'account-admin', memberMutationRevision: 'revision-1' };
  const state = { db, user, queries: [], fail: false, membershipChecks: 0, revokeOnFinalCheck: false };
  state.d1 = { prepare(sql) {
    state.queries.push(sql); assert.match(sql.trim(), /^SELECT /u, 'the new administrator feature must remain read-only');
    if (state.fail) throw new Error('D1 unavailable');
    return { bind(...values) {
      return { async first() {
        if (sql.startsWith('SELECT 1 AS allowed')) { state.membershipChecks++; if (state.revokeOnFinalCheck && state.membershipChecks > 1) db.exec("UPDATE members SET status='departed' WHERE id='admin'"); }
        return db.prepare(sql).get(...values) || null;
      }, async all() { return { results: db.prepare(sql).all(...values) }; } };
    } };
  } };
  globalThis[key] = state;
  state.insert = (n, kind = 'meeting_minutes', status = 'queued', origin = 'oa', createdAt = 1000 + n) => {
    db.prepare('INSERT INTO ai_workbench_tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id(n), 'member', 'account-member', kind, `会议纪要 ${n}`, status, `原始材料 ${n}<script>alert(1)</script>`, status === 'succeeded' ? `# 成果 ${n}\n\n已核对的内容。` : '', '请整理成会议纪要', origin, createdAt, createdAt);
  };
  state.insert(1); state.insert(2, 'meeting_minutes', 'succeeded'); state.insert(3, 'document'); state.insert(4, 'meeting_minutes', 'queued', 'feishu');
  state.artifact = (format = 'md', corrupt = false) => {
    const bytes = Buffer.from(format === 'md' ? '# 会议成果\n\n明确的讨论与待办。' : 'PK-saved-test-bytes');
    db.prepare('INSERT INTO ai_workbench_artifacts VALUES(?,?,?,?,?)').run(id(2), format, bytes.toString('base64'), bytes.length, corrupt ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex'));
    return bytes;
  };
  return state;
}
const get = query => route.GET(new Request(`https://oa.example.test/api/admin/meeting-minutes${query || ''}`));

test('anonymous cannot read the list', async t => { const s = fixture(t); s.user = null; assert.equal((await get()).status, 401); assert.equal(s.queries.length, 0); });
for (const query of ['', `?id=${id(1)}`, `?id=${id(1)}&format=source`, `?id=${id(2)}&format=md`, `?id=${id(2)}&format=docx`]) {
  test(`ordinary member is forbidden: ${query || 'list'}`, async t => { const s = fixture(t); s.user.isAdmin = false; assert.equal((await get(query)).status, 403); assert.equal(s.queries.length, 0); });
}
for (const [field, value] of [['ndaCompleted', false], ['memberId', ''], ['accountUserId', ''], ['memberMutationRevision', '']]) {
  test(`missing admission ${field} fails closed`, async t => { const s = fixture(t); s.user[field] = value; assert.equal((await get()).status, 403); });
}
test('live list includes queued and completed meetings but no other documents/origins/bodies', async t => {
  const s = fixture(t), response = await get(), data = await response.json(); assert.equal(response.status, 200);
  assert.deepEqual(data.items.map(row => row.id), [id(2), id(1)]); assert.equal(data.nextCursor, null);
  assert.deepEqual(Object.keys(data.items[0]).sort(), ['created_at', 'id', 'status', 'title', 'updated_at', 'uploader_name']);
  assert.equal(data.items[0].uploader_name, '上传成员'); assert.equal(data.items[1].status, 'queued');
  assert.deepEqual(s.authOptions, { readOnly: true }); assert.match(response.headers.get('cache-control'), /private, no-store/u);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});
test('raw submitted material is visible before model completion or archival', async t => {
  fixture(t); const data = await (await get(`?id=${id(1)}`)).json(); assert.equal(data.item.material, '原始材料 1<script>alert(1)</script>'); assert.equal(data.item.result, '');
});
for (const n of [3, 4, 999]) test(`nonmeeting, other origin or absent ID ${n} is opaque`, async t => { fixture(t); assert.equal((await get(`?id=${id(n)}`)).status, 404); });
for (const suffix of ['', '&format=source', '&format=md', '&format=docx']) test(`NDA revoked after login denies ${suffix || 'detail'}`, async t => {
  const s = fixture(t); s.db.exec("UPDATE approvals SET status='已撤销'"); assert.equal((await get(`?id=${id(2)}${suffix}`)).status, 403);
});
test('stale membership revision is not trusted', async t => { const s = fixture(t); s.db.exec("UPDATE members SET mutation_revision='revision-new' WHERE id='admin'"); assert.equal((await get()).status, 403); });
test('departed administrator cannot read existing records', async t => { const s = fixture(t); s.db.exec("UPDATE members SET status='departed' WHERE id='admin'"); assert.equal((await get()).status, 403); });
test('an archived NDA for a different subject is rejected', async t => { const s = fixture(t); s.db.prepare('UPDATE approvals SET payload_json=?').run(JSON.stringify({ signerAccountUserId: 'different-account', agreementVersion: 'v1' })); assert.equal((await get()).status, 403); });
test('owner account rebind does not reveal the new identity as uploader', async t => { const s = fixture(t); s.db.exec("UPDATE members SET account_user_id='new-account',full_name='不应泄露的新成员' WHERE id='member'"); const data = await (await get()).json(); assert.equal(data.items[0].uploader_name, '原上传成员'); });
for (const query of ['?all=true', '?id=', '?id=../../secrets', `?id=${id(1)}&id=${id(2)}`, '?format=md', `?id=${id(1)}&format=pdf`, '?cursor=', '?cursor=NaN:bad', '?cursor=9007199254740992:' + id(1), `?id=${id(1)}&cursor=1:${id(1)}`]) {
  test(`strict query parser rejects ${query}`, async t => { fixture(t); assert.equal((await get(query)).status, 400); });
}
test('cursor pagination handles equal timestamps without gaps or duplicates', async t => {
  const s = fixture(t); for (let n = 10; n < 130; n++) s.insert(n, 'meeting_minutes', 'queued', 'oa', 3000);
  const seen = []; let cursor = null;
  do { const data = await (await get(cursor ? `?cursor=${encodeURIComponent(cursor)}` : '')).json(); assert.ok(data.items.length <= 50); seen.push(...data.items.map(item => item.id)); cursor = data.nextCursor; } while (cursor);
  assert.equal(seen.length, 122); assert.equal(new Set(seen).size, 122);
});
test('D1 failure is 503, never a successful empty list', async t => { const s = fixture(t); s.fail = true; const response = await get(); assert.equal(response.status, 503); assert.equal(Object.hasOwn(await response.json(), 'items'), false); });
test('submitted text download is explicit and attachment-only', async t => { fixture(t); const response = await get(`?id=${id(1)}&format=source`); assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /^text\/plain/u); assert.match(response.headers.get('content-disposition'), /^attachment;/u); assert.equal(await response.text(), '原始材料 1<script>alert(1)</script>'); });
test('unfinished meeting cannot download a generated artifact', async t => { fixture(t); assert.equal((await get(`?id=${id(1)}&format=md`)).status, 409); });
test('missing generated artifact is not fabricated', async t => { fixture(t); assert.equal((await get(`?id=${id(2)}&format=md`)).status, 409); });
for (const format of ['md', 'docx']) test(`saved ${format} bytes and digest are verified before download`, async t => { const s = fixture(t), bytes = s.artifact(format), response = await get(`?id=${id(2)}&format=${format}`); assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes); });
test('corrupt saved artifact fails closed', async t => { const s = fixture(t); s.artifact('md', true); assert.equal((await get(`?id=${id(2)}&format=md`)).status, 503); });
test('admission revoked during file download is checked again', async t => { const s = fixture(t); s.artifact(); s.revokeOnFinalCheck = true; assert.equal((await get(`?id=${id(2)}&format=md`)).status, 403); });
test('route exposes no create, update, delete, approval or model operation', () => { assert.deepEqual(Object.keys(route), ['GET']); });
test('UI documents local-import boundary, shows admin shortcut, uses text-safe preview and pauses background polling', () => {
  const ui = source('components/knowledge/admin-meeting-minutes.tsx'), chat = source('components/knowledge/oa-chat-documents.tsx');
  assert.match(ui, /setInterval\([\s\S]*?5000\)/u); assert.match(ui, /visibilityState === 'hidden'/u); assert.match(ui, /window\.clearInterval/u); assert.match(ui, /controller\.abort\(\)/u);
  assert.match(ui, /<pre>\{detail\.material\}<\/pre>/u); assert.doesNotMatch(ui, /dangerouslySetInnerHTML/u);
  assert.match(ui, /未发送的本地附件不在此列表/u); assert.match(chat, /<AdminMeetingMinutesLink \/>/u); assert.match(chat, /本人和 OA 管理员可查看/u);
});

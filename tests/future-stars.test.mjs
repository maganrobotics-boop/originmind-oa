import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { D1DatabaseAdapter } from '../chat-cloudflare/test/d1-adapter.mjs';
import { handleRequest } from '../chat-cloudflare/src/app.mjs';
import { FUTURE_STARS_PATH, handleFutureStarsBridge, signFutureStarsRequest, validStarsPayload } from '../chat-cloudflare/src/future-stars-bridge.mjs';
import { createLearningPeople } from '../aliyun/learning/future-stars.mjs';
import { PublicError } from '../chat-cloudflare/src/errors.mjs';
import { readFutureStudents } from '../chat-cloudflare/src/future-stars-service.mjs';
import { migrateFutureHonors } from '../aliyun/future-stars-migrate.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const origin = 'https://chat.example.test', secret = 'fixture-secret'.padEnd(48, 's');
const actor = { email: 'teacher@sztu.edu.cn', subject: 'fixture-oa-admin' };
const peoplePayload = { operation: 'people', actor, params: {} };
async function signedRequest(payload = peoplePayload, options = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return new Request(origin + FUTURE_STARS_PATH, { method: 'POST', headers: {
    ...await signFutureStarsRequest(body, secret, options), ...options.headers }, body });
}
function env(t) {
  const DB = new D1DatabaseAdapter(); t.after(() => DB.close());
  const learning = new DatabaseSync(':memory:'); t.after(() => learning.close());
  learning.exec("CREATE TABLE learning_submissions(id TEXT PRIMARY KEY,email TEXT,payload TEXT,review_state TEXT,review TEXT,error TEXT,created_at INTEGER); CREATE TABLE learning_course_drafts(email TEXT,course_id TEXT,revision INTEGER,updated_at INTEGER);");
  for (const table of ['learning_messages','learning_git_runs','learning_graduation_attempts','learning_patrol_attempts']) learning.exec(`CREATE TABLE ${table}(email TEXT,created_at INTEGER)`);
  DB.sqlite.exec("CREATE TABLE visitor_accounts(email TEXT PRIMARY KEY,role TEXT,registered_at INTEGER,last_login_at INTEGER,registration_source TEXT);");
  const subjects = ['one', 'two', 'three'];
  for (const name of subjects) {
    const email = name + '@stumail.sztu.edu.cn';
    DB.sqlite.prepare('INSERT INTO visitor_accounts VALUES(?,?,?,?,?)').run(email, 'student', 100, Date.now() - 1000, 'fixture');
    DB.sqlite.prepare('INSERT INTO newbie_profiles(email,display_name,grade,major,direction,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(email, name === 'one' ? '<script>学生</script>' : name, '2026', '机器人', 'navigation', 100, 100);
  }
  DB.sqlite.prepare('INSERT INTO visitor_accounts VALUES(?,?,?,?,?)').run(actor.email, 'staff', 100, 100, 'fixture');
  const one = 'one@stumail.sztu.edu.cn', two = 'two@stumail.sztu.edu.cn';
  learning.prepare('INSERT INTO learning_submissions VALUES(?,?,?,?,?,?,?)').run('s1', one, JSON.stringify({ courseId: 'python-basics', reflection: '我的解释' }), 'done', JSON.stringify({ feedback: 'fixture点评' }), null, 1000);
  learning.prepare('INSERT INTO learning_submissions VALUES(?,?,?,?,?,?,?)').run('s2', one, JSON.stringify({ courseId: 'python-basics' }), 'pending', null, null, 1001);
  learning.prepare('INSERT INTO learning_course_drafts VALUES(?,?,?,?)').run(two, 'activity-1', 3, 2000);
  const FUTURE_STARS_LEARNING = createLearningPeople({ db: learning, courses: [
    { id: 'python-basics', title: 'Python' }, { id: 'navigation', title: '导航' }, { id: 'activity-1', title: '导航练习', parentId: 'navigation' }],
    progressFor: email => ({ foundationCourseIds: ['python-basics'], foundationCompletedCourseIds: email === one ? ['python-basics'] : [],
      submittedCourseIds: email === one ? ['python-basics'] : [], exemptedCourseIds: [], currentCourseId: 'python-basics' }),
    graduationSummary: () => ({ status: 'not_attempted', passedAt: null }),
  });
  return { DB, APP_ORIGIN: origin, PUBLIC_LAB_AI_SERVICE_TOKEN: secret, ADMIN_EMAIL: actor.email,
    APP_ENCRYPTION_KEY: 'e'.repeat(48), RATE_LIMIT_HMAC_KEY: 'r'.repeat(48), FUTURE_STARS_LEARNING, learningDb: learning };
}
async function call(env, payload, options = {}) {
  const result = await handleRequest(await signedRequest(payload, options), env, {});
  return { status: result.status, data: await result.json() };
}
test('service authentication rejects unsigned, cookie, browser origin, altered and stale requests', async () => {
  let executed = 0;
  const engine = { claimRequest: async () => {}, handle: async () => { executed++; return Response.json({ records: [] }); } };
  for (const request of [
    new Request(origin + FUTURE_STARS_PATH, { method: 'POST', body: '{}' }),
    await signedRequest(peoplePayload, { headers: { cookie: 'stolen=test' } }),
    await signedRequest(peoplePayload, { headers: { origin } }),
    await signedRequest(peoplePayload, { now: Date.now() - 120000 }),
    await signedRequest(peoplePayload, { headers: { authorization: 'OA-STARS-HMAC ' + 'a'.repeat(64) } }),
  ]) assert.equal((await handleFutureStarsBridge({ request, env: { PUBLIC_LAB_AI_SERVICE_TOKEN: secret } }, engine)).status, 401);
  assert.equal(executed, 0);
});
test('bridge is bounded and validates operations, actor and route-specific params', async () => {
  assert.equal(validStarsPayload({ ...peoplePayload, actor: { ...actor, isAdmin: true } }), false);
  assert.equal(validStarsPayload({ ...peoplePayload, params: { email: 'other@sztu.edu.cn' } }), false);
  assert.equal(validStarsPayload({ ...peoplePayload, operation: 'delete_student' }), false);
  const engine = { claimRequest: async () => {}, handle: async () => Response.json({}) };
  for (const [value, status] of [['{invalid', 400], [{ ...peoplePayload, params: { token: 'x' } }, 400], [' '.repeat(17000), 413]]) {
    assert.equal((await handleFutureStarsBridge({ request: await signedRequest(value), env: { PUBLIC_LAB_AI_SERVICE_TOKEN: secret } }, engine)).status, status);
  }
});
test('replaying the same signed nonce cannot repeat even a read operation', async t => {
  const environment = env(t), nonce = crypto.randomUUID(), payload = peoplePayload;
  assert.equal((await call(environment, payload, { nonce })).status, 200);
  assert.equal((await call(environment, payload, { nonce })).status, 429);
});
test('students rank before pagination, exclude staff and filter actual course participation', async t => {
  const environment = env(t);
  const all = await call(environment, peoplePayload);
  assert.equal(all.status, 200); assert.equal(all.data.received, true);
  assert.equal(all.data.records.length, 3); assert.equal(all.data.pagination.total, 3);
  const python = await call(environment, { ...peoplePayload, params: { courseId: 'python-basics' } });
  assert.equal(python.data.records.length, 1);
  assert.equal(python.data.records[0].learning[0].submissions, 2);
  assert.equal(python.data.records[0].learning[0].reviewed, 1);
  assert.equal(python.data.records[0].graduation.status, 'not_attempted');
  const parent = await call(environment, { ...peoplePayload, params: { courseId: 'navigation' } });
  assert.equal(parent.data.records.length, 1); assert.equal(parent.data.records[0].email, 'two@stumail.sztu.edu.cn');
  assert.equal(parent.data.records[0].learning[0].submissions, 0);
  assert.deepEqual(parent.data.records[0].progress.submittedCourseIds, []);
  assert.equal((await call(environment, { ...peoplePayload, params: { courseId: 'absent' } })).status, 400);
  assert.equal((await call(environment, { ...peoplePayload, params: { page: '0' } })).status, 400);
  assert.equal((await call(environment, { ...peoplePayload, params: { page: '2' } })).data.records.length, 0);
  const exact = await call(environment, { ...peoplePayload, params: { q: '<script>' } });
  assert.equal(exact.data.records.length, 1); // UI renders text, never HTML.
});
test('missing current learning service fails clearly instead of displaying empty or invented progress', async t => {
  const environment = env(t); delete environment.FUTURE_STARS_LEARNING;
  assert.equal((await call(environment, peoplePayload)).status, 503);
});
test('records return only submitted evidence and AI feedback, without code payload or impersonation', async t => {
  const environment = env(t);
  const result = await call(environment, { actor, operation: 'records', params: { email: 'one@stumail.sztu.edu.cn', courseId: 'python-basics' } });
  assert.equal(result.status, 200); assert.equal(result.data.records.length, 2);
  assert.equal(result.data.records.find(row => row.id === 's1').review.feedback, 'fixture点评');
  assert.ok(result.data.records.every(row => !Object.hasOwn(row, 'payload')));
});
test('legacy plain-text and malformed JSON reviews preserve readable personal records', async t => {
  const environment = env(t);
  const values = ['历史纯文本点评', '{incomplete JSON', '<script>literal text</script>'];
  for (const [index, review] of values.entries()) environment.learningDb.prepare('INSERT INTO learning_submissions VALUES(?,?,?,?,?,?,?)')
    .run('legacy-' + index, 'one@stumail.sztu.edu.cn', JSON.stringify({ courseId: 'navigation' }), 'done', review, null, 2000 + index);
  const result = await call(environment, { actor, operation: 'records', params: { email: 'one@stumail.sztu.edu.cn' } });
  assert.equal(result.status, 200); assert.equal(result.data.pagination.total, 5);
  for (const [index, review] of values.entries()) assert.equal(result.data.records.find(row => row.id === 'legacy-' + index).review, review);
  assert.equal(result.data.records.find(row => row.id === 's1').review.feedback, 'fixture点评');
  assert.equal(result.data.records.find(row => row.id === 's2').review, null);
});
test('competition grants share the honor store and authenticated OA actor, and synchronize hiding', async t => {
  const environment = env(t);
  const body = { requestId: 'fixture-competition-award-001', name: '测试同学', category: 'competition', title: '测试竞技赛一等奖',
    message: '合成测试事迹', sourceKind: 'reference', sourceReference: 'TEST-公告-001', confirmed: true };
  const granted = await call(environment, { actor, operation: 'grant', body });
  assert.equal(granted.status, 201); assert.equal(granted.data.award.grantedBy, actor.email);
  assert.equal((await call(environment, { actor, operation: 'honors', params: { category: 'competition' } })).data.awards.length, 1);
  assert.equal((await call(environment, { actor, operation: 'grant', body })).status, 200);
  const changed = await call(environment, { actor, operation: 'honor_action', params: { id: body.requestId }, body: { action: 'hide', version: 1, note: '测试隐藏' } });
  assert.equal(changed.status, 200);
  const publicResult = await handleRequest(new Request(origin + '/api/learning/honors?category=competition'), environment, {});
  assert.deepEqual((await publicResult.json()).awards, []);
  assert.equal((await call(environment, { actor, operation: 'honor_action', params: { id: body.requestId }, body: { action: 'revoke', version: 1, note: '旧版本' } })).status, 409);
  const events = (await call(environment, { actor, operation: 'events', params: { id: body.requestId } })).data.events;
  assert.deepEqual(events.map(e => e.action), ['hide', 'grant']);
  assert.equal(environment.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM newbie_task_progress').get().n, 0);
});
test('migrating current private honors preserves exact identity and is idempotent without reset', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'future-stars-migrate-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'aliyun/learning'), { recursive: true }); mkdirSync(path.join(root, 'chat-cloudflare/migrations'), { recursive: true });
  writeFileSync(path.join(root, 'chat-cloudflare/migrations/0008_learning_honors.sql'), readFileSync(new URL('../chat-cloudflare/migrations/0008_learning_honors.sql', import.meta.url)));
  const award = { id: 'newbie-20261004-1', name: '合成测试同学', email: 'fixture-one@stumail.sztu.edu.cn', title: '原奖杯', message: '原文', issuedAt: 1791099900000 };
  writeFileSync(path.join(root, 'aliyun/learning/newbie-honors.json'), JSON.stringify({ awards: [award] }));
  const dbPath = path.join(root, 'chat.sqlite');
  assert.deepEqual(migrateFutureHonors(dbPath, root), { imported: 1, total: 1, preservedBindings: 1 });
  const db = new DatabaseSync(dbPath); db.prepare("UPDATE learning_honors SET visibility='hidden',version=2 WHERE id=?").run(award.id); db.close();
  assert.equal(migrateFutureHonors(dbPath, root).imported, 0);
  const verify = new DatabaseSync(dbPath);
  const saved = verify.prepare('SELECT * FROM learning_honors').get(); verify.close();
  assert.equal(saved.recipient_email, award.email); assert.equal(saved.granted_at, award.issuedAt); assert.equal(saved.visibility, 'hidden');
});

test('Arena bridge distinguishes disconnected, connected empty, and unavailable sources', async t => {
  const environment=env(t), payload={actor,operation:'arena',params:{window:'3d'}};
  let result=await call(environment,payload);
  assert.equal(result.status,200);assert.equal(result.data.source.status,'not_connected');assert.equal(result.data.source.message,'数据源未接入');
  assert.equal(result.data.summary.tests,null);assert.deepEqual(result.data.summary.onlineCounts,{'24h':null,'3d':null,'7d':null});
  environment.FUTURE_STARS_ARENA={overview:async()=>{throw new Error('private database path must not leak');}};
  result=await call(environment,payload);assert.equal(result.data.source.status,'unavailable');assert.ok(!JSON.stringify(result.data).includes('private database'));
  environment.FUTURE_STARS_ARENA={overview:async()=>({source:{status:'connected'},summary:{tests:0},records:[]})};
  result=await call(environment,payload);assert.equal(result.data.source.status,'connected');assert.equal(result.data.summary.tests,0);
  assert.equal((await call(environment,{...payload,params:{window:'all'}})).status,400);
});
test('actual SQL deduplicates case variants and ignores profile-only edits and future activity',async t=>{
 const environment=env(t), now=Date.now();
 environment.DB.sqlite.prepare('INSERT INTO visitor_accounts VALUES(?,?,?,?,?)').run('ONE@stumail.sztu.edu.cn','student',100,now-1,'fixture');
 environment.DB.sqlite.prepare('UPDATE visitor_accounts SET last_login_at=0 WHERE email=?').run('three@stumail.sztu.edu.cn');
 environment.DB.sqlite.prepare('UPDATE newbie_profiles SET updated_at=? WHERE email=?').run(now,'three@stumail.sztu.edu.cn');
 let result=await readFutureStudents(environment.DB,environment.FUTURE_STARS_LEARNING,{},now);
 assert.equal(result.summary.active,2);assert.equal(result.records.filter(row=>row.email.toLowerCase().startsWith('one@')).length,1);
 // Question tracking is present only on some production versions.
 environment.DB.sqlite.exec('CREATE TABLE newbie_questions(email TEXT,created_at INTEGER)');
 environment.DB.sqlite.prepare('INSERT INTO newbie_questions VALUES(?,?)').run('three@stumail.sztu.edu.cn',now-10);
 environment.DB.sqlite.prepare('INSERT INTO newbie_questions VALUES(?,?)').run('three@stumail.sztu.edu.cn',now+100);
 result=await readFutureStudents(environment.DB,environment.FUTURE_STARS_LEARNING,{},now);
 assert.equal(result.summary.active,3);assert.equal(result.records.find(row=>row.email.startsWith('three@')).lastActivityAt,now-10);
});

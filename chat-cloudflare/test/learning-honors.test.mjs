import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/app.mjs';
import { sha256Hex } from '../src/crypto.mjs';
import { D1DatabaseAdapter } from './d1-adapter.mjs';
import { routeStaticRequest } from '../src/static-router.mjs';

const ORIGIN = 'https://chat.example.test';
const FIRST = 'newbie-20261004-1';
function environment(t) {
  const env = { DB: new D1DatabaseAdapter(), APP_ORIGIN: ORIGIN, ADMIN_EMAIL: 'admin@example.test',
    APP_ENCRYPTION_KEY: 'test-encryption-key'.padEnd(48, 'e'), RATE_LIMIT_HMAC_KEY: 'test-hmac-key'.padEnd(48, 'r') };
  t.after(() => env.DB.close());
  return env;
}
async function call(env, path, { method = 'GET', body, cookie = '', origin = ORIGIN, headers = {} } = {}) {
  const response = await handleRequest(new Request(ORIGIN + path, {
    method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json', Origin: origin } : {}),
      Cookie: cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  }), env, {}, { fetch: () => { throw Error('Honors must not call a model or OA.'); } });
  return { status: response.status, data: await response.json(), headers: response.headers };
}
async function owner(env, expired = false) {
  const token = 'a'.repeat(64);
  env.DB.sqlite.prepare('INSERT INTO sessions(hash,expires) VALUES(?,?)').run(await sha256Hex(token), Date.now() + (expired ? -1 : 60000));
  return `__Host-ma-session=${token}`;
}
async function visitor(env, email = 'synthetic-cui@stumail.sztu.edu.cn', name = '测试账户') {
  const token = email.startsWith('synthetic-cui') ? 'b'.repeat(64) : 'c'.repeat(64);
  env.DB.sqlite.prepare('INSERT OR REPLACE INTO visitor_sessions(hash,email,role,created_at,expires_at) VALUES(?,?,?,?,?)')
    .run(await sha256Hex(token), email, email.includes('@stumail.') ? 'student' : 'staff', Date.now(), Date.now() + 60000);
  env.DB.sqlite.prepare('INSERT OR REPLACE INTO newbie_profiles(email,display_name,created_at,updated_at) VALUES(?,?,?,?)')
    .run(email, name, Date.now(), Date.now());
  return `__Host-om-chat-session=${token}`;
}
function grant(overrides = {}) {
  return { requestId: 'synthetic-honor-00001', name: '往届测试同学', category: 'alumni', title: '毕业纪念', message: '完成经确认的毕业项目。',
    achievementDate: '2020-06-30', sourceKind: 'reference', sourceReference: '合成测试：毕业项目归档 TEST-2020-001。', confirmed: true, ...overrides };
}
async function action(env, cookie, id, version, type, extra = {}) {
  return call(env, `/api/admin/honors/${id}/action`, { method: 'POST', cookie,
    body: { action: type, version, note: '合成测试：管理员已核验此操作。', ...extra } });
}
function honorCount(env) { return env.DB.sqlite.prepare('SELECT count(*) AS n FROM learning_honors').get().n; }

test('migration preserves the three confirmed awards and never guesses accounts or historical dates', t => {
  const env = environment(t);
  const rows = env.DB.sqlite.prepare('SELECT * FROM learning_honors ORDER BY id').all();
  assert.deepEqual(rows.map(row => row.recipient_name), ['崔航阁', '刘奕鹏', '邱衡']);
  assert.ok(rows.every(row => row.recipient_email === null && row.achievement_date === null));
  assert.ok(rows.every(row => row.granted_at === 1791099900000 && row.source_reference.includes('马淦于2026-10-04明确确认')));
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS n FROM newbie_task_progress').get().n, 0);
  const events = env.DB.sqlite.prepare('SELECT * FROM learning_honor_events').all();
  assert.equal(events.length, 3);
  assert.ok(events.every(event => event.action === 'import' && event.actor === 'migration:0008'));
});
test('anonymous public wall exposes only the explicit public allowlist', async t => {
  const env = environment(t);
  const result = await call(env, '/api/learning/honors');
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.data.awards.length, 3);
  const keys = ['id', 'name', 'category', 'categoryLabel', 'title', 'message', 'achievementDate', 'issuedAt', 'issuedBy', 'confirmation', 'image'].sort();
  assert.deepEqual(Object.keys(result.data.awards[0]).sort(), keys);
  assert.doesNotMatch(JSON.stringify(result.data), /recipientEmail|sourceReference|grantedBy|version|migration:|owner-confirmed|@/);
  for (const path of ['/api/learning/honors?email=other@stumail.sztu.edu.cn', '/api/learning/honors?category=admin',
    '/api/learning/honors?page=0', '/api/learning/honors?page=1&page=2']) assert.equal((await call(env, path)).status, 400);
});
test('private trophies require a live visitor session and reject identity selectors', async t => {
  const env = environment(t);
  assert.equal((await call(env, '/api/learning/my-honors')).status, 401);
  const adminCookie = await owner(env);
  assert.equal((await call(env, '/api/learning/my-honors', { cookie: adminCookie })).status, 401);
  const memberCookie = await visitor(env, undefined, '崔航阁');
  assert.deepEqual((await call(env, '/api/learning/my-honors', { cookie: memberCookie })).data.awards, []);
  // A mutable profile name matching a seeded name cannot claim the honor.
  assert.equal((await call(env, '/api/learning/my-honors?email=synthetic-cui@stumail.sztu.edu.cn', { cookie: memberCookie })).status, 400);
  assert.equal((await call(env, '/api/learning/my-honors', { method: 'POST', cookie: memberCookie, body: {} })).status, 405);
  env.DB.sqlite.prepare('UPDATE visitor_sessions SET expires_at=0').run();
  assert.equal((await call(env, '/api/learning/my-honors', { cookie: memberCookie })).status, 401);
});
test('members, staff and anonymous callers cannot read admin evidence, find accounts or mutate honors', async t => {
  const env = environment(t);
  const cookies = ['', await visitor(env), await visitor(env, 'synthetic-teacher@sztu.edu.cn')];
  for (const cookie of cookies) {
    for (const path of ['/api/admin/honors', '/api/admin/honors/recipients?q=崔航阁', `/api/admin/honors/${FIRST}/events`]) {
      assert.equal((await call(env, path, { cookie })).status, 403);
    }
    assert.equal((await call(env, '/api/admin/honors', { method: 'POST', cookie, body: grant() })).status, 403);
    for (const type of ['bind', 'hide', 'show', 'revoke']) assert.equal((await action(env, cookie, FIRST, 1, type)).status, 403);
  }
  assert.equal(honorCount(env), 3);
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS n FROM learning_honor_events').get().n, 3);
});
test('expired admin and cross-origin mutations cannot change records', async t => {
  const env = environment(t);
  const cookie = await owner(env, true);
  assert.equal((await call(env, '/api/admin/honors', { cookie })).status, 403);
  env.DB.sqlite.prepare('UPDATE sessions SET expires=?').run(Date.now() + 60000);
  for (const origin of ['', 'https://untrusted.example.test']) {
    assert.equal((await call(env, '/api/admin/honors', { method: 'POST', cookie, origin, body: grant() })).status, 403);
    assert.equal((await call(env, `/api/admin/honors/${FIRST}/action`, { method: 'POST', cookie, origin,
      body: { action: 'hide', version: 1, note: 'test' } })).status, 403);
  }
  assert.equal(honorCount(env), 3);
});
test('all three private trophies bind only through an explicit admin-confirmed account', async t => {
  const env = environment(t);
  const cookie = await owner(env);
  for (const [index, prefix] of ['synthetic-cui', 'synthetic-liu', 'synthetic-qiu'].entries()) {
    const email = `${prefix}@stumail.sztu.edu.cn`;
    const memberCookie = await visitor(env, email);
    const bound = await action(env, cookie, `newbie-20261004-${index + 1}`, 1, 'bind', { recipientEmail: email, confirmed: true });
    assert.equal(bound.status, 200);
    const mine = await call(env, '/api/learning/my-honors', { cookie: memberCookie });
    assert.deepEqual(mine.data.awards.map(award => award.id), [`newbie-20261004-${index + 1}`]);
    assert.doesNotMatch(JSON.stringify(mine.data), /sourceReference|recipientEmail|grantedBy/);
  }
  assert.equal((await call(env, '/api/learning/my-honors', { cookie: await visitor(env, 'nonwinner@stumail.sztu.edu.cn') })).data.awards.length, 0);
});
test('account suggestions stay private and remain suggestions even for duplicate names', async t => {
  const env = environment(t);
  const cookie = await owner(env);
  await visitor(env, 'synthetic-cui@stumail.sztu.edu.cn', '同名测试');
  await visitor(env, 'synthetic-other@stumail.sztu.edu.cn', '同名测试');
  const rows = await call(env, '/api/admin/honors/recipients?q=同名测试', { cookie });
  assert.equal(rows.data.recipients.length, 2);
  assert.ok(rows.data.recipients.every(row => row.email && !Object.hasOwn(row, 'hash')));
  assert.equal((await action(env, cookie, FIRST, 1, 'bind', { recipientEmail: 'synthetic-cui@stumail.sztu.edu.cn' })).status, 400);
  assert.equal((await action(env, cookie, FIRST, 1, 'bind', { recipientEmail: 'missing@stumail.sztu.edu.cn', confirmed: true })).status, 400);
  assert.equal(env.DB.sqlite.prepare('SELECT recipient_email AS email FROM learning_honors WHERE id=?').get(FIRST).email, null);
});
test('historical honors need confirmation and provenance and can exist without an account', async t => {
  const env = environment(t);
  const cookie = await owner(env);
  for (const changes of [{ confirmed: false }, { sourceReference: '' }, { sourceKind: 'inferred' },
    { achievementDate: '2021-02-29' }, { achievementDate: '2099-01-01' }, { requestId: 1234567890 },
    { recipientEmail: 'missing@stumail.sztu.edu.cn', bindingNote: 'test' }, { extraField: 'not allowed' }]) {
    assert.equal((await call(env, '/api/admin/honors', { method: 'POST', cookie, body: grant(changes) })).status, 400);
  }
  for (const [index, type] of ['alumni', 'competition', 'contribution', 'other'].entries()) {
    const saved = await call(env, '/api/admin/honors', { method: 'POST', cookie, body: grant({ requestId: `historical-test-${index}`, category: type }) });
    assert.equal(saved.status, 201); assert.equal(saved.data.award.recipientEmail, null);
    assert.equal(saved.data.award.achievementDate, '2020-06-30');
    assert.ok(saved.data.award.issuedAt > Date.parse('2020-06-30'));
    const wall = await call(env, `/api/learning/honors?category=${type}`);
    assert.equal(wall.data.awards.length, 1); assert.equal(wall.data.awards[0].category, type);
  }
});
test('grant retries are idempotent and a request ID cannot overwrite a different honor', async t => {
  const env = environment(t), cookie = await owner(env);
  const first = await call(env, '/api/admin/honors', { method: 'POST', cookie, body: grant() });
  const retry = await call(env, '/api/admin/honors', { method: 'POST', cookie, body: grant() });
  assert.equal(first.status, 201); assert.equal(retry.status, 200); assert.equal(retry.data.replayed, true);
  assert.equal(first.data.award.issuedAt, retry.data.award.issuedAt);
  assert.equal((await call(env, '/api/admin/honors', { method: 'POST', cookie, body: grant({ title: '不同荣誉' }) })).status, 409);
  assert.equal(honorCount(env), 4);
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS n FROM learning_honor_events WHERE honor_id=?').get(grant().requestId).n, 1);
});
test('hide, show, revoke and stale-version protection preserve an exact private audit trail and course data', async t => {
  const env = environment(t), cookie = await owner(env);
  const email = 'synthetic-cui@stumail.sztu.edu.cn'; const memberCookie = await visitor(env, email);
  env.DB.sqlite.prepare("INSERT INTO newbie_task_progress(email,task_id,status,evidence,updated_at) VALUES(?,'toolkit','completed','original evidence',123)").run(email);
  const originalProgress = env.DB.sqlite.prepare('SELECT * FROM newbie_task_progress').all();
  assert.equal((await action(env, cookie, FIRST, 1, 'bind', { recipientEmail: email, confirmed: true })).status, 200);
  assert.equal((await action(env, cookie, FIRST, 2, 'hide')).status, 200);
  assert.equal((await call(env, '/api/learning/honors')).data.awards.length, 2);
  assert.equal((await call(env, `/api/learning/honors/${FIRST}`)).status, 404);
  assert.equal((await call(env, '/api/learning/my-honors', { cookie: memberCookie })).data.awards[0].visibility, 'hidden');
  assert.equal((await action(env, cookie, FIRST, 2, 'show')).status, 409);
  assert.equal((await action(env, cookie, FIRST, 3, 'show')).status, 200);
  assert.equal((await call(env, '/api/learning/honors')).data.awards.length, 3);
  assert.equal((await call(env, `/api/learning/honors/${FIRST}`)).data.awards[0].id, FIRST);
  assert.equal((await action(env, cookie, FIRST, 4, 'revoke')).status, 200);
  assert.equal((await call(env, '/api/learning/my-honors', { cookie: memberCookie })).data.awards.length, 0);
  assert.equal((await call(env, `/api/learning/honors/${FIRST}`)).status, 404);
  assert.equal((await action(env, cookie, FIRST, 5, 'show')).status, 409);
  const events = (await call(env, `/api/admin/honors/${FIRST}/events`, { cookie })).data.events;
  assert.deepEqual(events.map(event => [event.version, event.action]), [[5, 'revoke'], [4, 'show'], [3, 'hide'], [2, 'bind'], [1, 'import']]);
  assert.ok(events.slice(0, 4).every(event => event.actor === env.ADMIN_EMAIL));
  assert.match(events.find(event => event.action === 'bind').note, /synthetic-cui@stumail.sztu.edu.cn/);
  assert.deepEqual(env.DB.sqlite.prepare('SELECT * FROM newbie_task_progress').all(), originalProgress);
  const record = env.DB.sqlite.prepare('SELECT * FROM learning_honors WHERE id=?').get(FIRST);
  assert.equal(record.granted_at, 1791099900000); assert.match(record.source_reference, /马淦/);
});
test('audit failures roll back a grant or mutation instead of leaving an unaudited honor', async t => {
  const env = environment(t), cookie = await owner(env);
  env.DB.sqlite.exec("CREATE TRIGGER reject_honor_audit BEFORE INSERT ON learning_honor_events BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;");
  assert.equal((await action(env, cookie, FIRST, 1, 'hide')).status, 503);
  assert.equal((await call(env, '/api/admin/honors', { method: 'POST', cookie, body: grant() })).status, 503);
  assert.equal(honorCount(env), 3);
  const row = env.DB.sqlite.prepare('SELECT visibility,version FROM learning_honors WHERE id=?').get(FIRST);
  assert.equal(row.visibility, 'public'); assert.equal(row.version, 1);
});
test('public and admin pagination and state filters do not leak hidden or revoked records', async t => {
  const env = environment(t), cookie = await owner(env);
  const insert = env.DB.sqlite.prepare("INSERT INTO learning_honors(id,recipient_name,category,title,source_kind,source_reference,granted_by,granted_at,updated_at) VALUES(?,'测试','competition','合成测试荣誉','reference','TEST','test',?,1)");
  for (let i = 0; i < 28; i++) insert.run(`pagination-test-${String(i).padStart(2, '0')}`, i + 1);
  env.DB.sqlite.prepare("UPDATE learning_honors SET visibility='hidden' WHERE id='pagination-test-00'").run();
  env.DB.sqlite.prepare("UPDATE learning_honors SET status='revoked' WHERE id='pagination-test-01'").run();
  const first = (await call(env, '/api/learning/honors?category=competition&page=1')).data;
  const second = (await call(env, '/api/learning/honors?category=competition&page=2')).data;
  assert.equal(first.awards.length, 24); assert.equal(first.hasMore, true);
  assert.equal(second.awards.length, 2); assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.awards, ...second.awards].map(row => row.id)).size, 26);
  const hidden = await call(env, '/api/admin/honors?status=hidden', { cookie });
  assert.equal(hidden.data.awards.length, 1); assert.equal(hidden.data.awards[0].id, 'pagination-test-00');
  assert.equal((await call(env, '/api/admin/honors?status=unbound', { cookie })).data.hasMore, true);
});
test('new honor pages and modules are routed explicitly with secure noncached responses', async () => {
  for (const path of ['/learning/honors', '/learning/honors/', '/learning/honors.css',
    '/learning/honors.mjs', '/learning/honors-trophy.svg']) {
    const env = { ASSETS: { fetch: request => new Response(new URL(request.url).pathname) } };
    const response = await routeStaticRequest(new Request(ORIGIN + path), env);
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal((await routeStaticRequest(new Request(ORIGIN + path, { method: 'POST' }), env)).status, 405);
  }
  const moved = await routeStaticRequest(new Request(ORIGIN + '/learning/honors/admin'), {});
  assert.equal(moved.status, 302);
  assert.equal(moved.headers.get('location'), 'https://oa.omindos.cn/#future-stars');
  assert.equal(moved.headers.get('cache-control'), 'no-store');
  assert.equal((await routeStaticRequest(new Request(ORIGIN + '/learning/honors/admin', { method: 'POST' }), {})).status, 405);
});

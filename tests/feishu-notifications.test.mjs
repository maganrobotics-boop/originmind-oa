import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
globalThis.__notificationApiTest = {};
const vite = await createServer({ appType: 'custom', configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), server: { middlewareMode: true, hmr: false }, plugins: [{ name: 'notification-test-dependencies', enforce: 'pre', resolveId(source) { if (source === 'cloudflare:workers') return '\0notice-env'; if (source.endsWith('/_lib/auth')) return '\0notice-auth'; }, load(id) { if (id === '\0notice-env') return 'export const env = new Proxy({}, { get: (_, key) => globalThis.__notificationApiTest.env[key] });'; if (id === '\0notice-auth') return 'export const getAuthorizedUser = async () => globalThis.__notificationApiTest.actor;'; } }] });
const notifications = await vite.ssrLoadModule('/lib/feishu-notifications.ts');
const adminApi = await vite.ssrLoadModule('/app/api/admin/notifications/route.ts');
let sqlite, db, env, sent, failure;
const originalFetch = globalThis.fetch;
function adapter(query, params = []) { return { bind(...values) { return adapter(query, values); }, async first() { return sqlite.prepare(query).get(...params) || null; }, async all() { return { results: sqlite.prepare(query).all(...params) }; }, async run() { return sqlite.prepare(query).run(...params); } }; }
const person = (id) => ({ memberId: id, accountUserId: `email:${id}@example.com`, email: `${id}@example.com`, name: id });
const payload = (recipients = ['r1','r2'], approvers = ['a1']) => ({ circulationRecipients: recipients.map(person), circulationApprovers: approvers.map(person), circulationConfirmations: [], circulationApprovals: [] });
function event(action) { sqlite.prepare("INSERT INTO approval_events(approval_id, actor_name, actor_email, action) VALUES ('approval-1','Test','author@example.com',?)").run(action); }
function create(body = payload(), step = '流转确认') {
  sqlite.prepare("INSERT INTO approvals(id,type,title,project,requester_name,requester_email,created_at,updated_at,status,current_step,owner,payload_json) VALUES ('approval-1','流转审批','Private title','Project','Author','author@example.com','2026-09-07','2026-09-07','待审核',?,'Author',?)").run(step, JSON.stringify(body));
  event('submitted');
}
function state(body, step = '流转确认', status = '审批中', action = 'confirm_circulation') { sqlite.prepare("UPDATE approvals SET payload_json=?, current_step=?, status=? WHERE id='approval-1'").run(JSON.stringify(body),step,status); event(action); }
beforeEach(() => {
  sqlite?.close(); sqlite = new DatabaseSync(':memory:');
  const dir = new URL('../drizzle/', import.meta.url);
  for (const file of readdirSync(dir).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/oa/0001_feishu_notifications.sql', import.meta.url), 'utf8'));
  for (const id of ['author','r1','r2','a1']) {
    sqlite.prepare("INSERT INTO members(id,full_name,chatgpt_account,account_user_id,status) VALUES (?,?,?,?,'active')").run(id,id,`${id}@example.com`,`email:${id}@example.com`);
    sqlite.prepare("INSERT INTO auth_identities(id,member_id,provider,provider_subject) VALUES (?,?,'feishu',?)").run(id,id,`cli_test:tenant_test:ou_${id}abcd`);
  }
  db = { prepare: adapter, async batch(statements) { const results = []; for (const statement of statements) results.push(await statement.run()); return results; } }; env = { DB: db, FEISHU_NOTIFICATIONS_ENABLED: 'true', FEISHU_LOGIN_APP_ID: 'cli_test', FEISHU_LOGIN_APP_SECRET: 'dummy-test-value', FEISHU_LOGIN_TENANT_KEY: 'tenant_test' }; sent = []; failure = null;
  globalThis.__notificationApiTest = { env, actor: null };
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'dummy-test-token' });
    const body = JSON.parse(init.body); sent.push(body);
    if (failure === 'network') throw new Error('simulated lost response');
    return Response.json(failure ? { code: failure } : { code: 0, data: { message_id: `message-${body.uuid}` } });
  };
});
after(async () => { globalThis.fetch = originalFetch; delete globalThis.__notificationApiTest; sqlite?.close(); await vite.close(); });
test('flow participants are notified once; approvals begin only after flow finishes', async () => {
  const body = payload(); create(body);
  await Promise.all([notifications.enqueueApprovalNotifications(db), notifications.enqueueApprovalNotifications(db)]);
  await Promise.all([notifications.deliverApprovalNotifications(env), notifications.deliverApprovalNotifications(env)]);
  assert.deepEqual(sent.map((row) => row.receive_id).sort(), ['ou_r1abcd','ou_r2abcd']);
  assert.ok(sent.every((row) => !row.content.includes('Private title') && !row.content.includes('author@example.com')));
  body.circulationConfirmations.push(person('r1')); state(body); await notifications.processApprovalNotifications(env);
  assert.equal(sent.length, 2);
  body.circulationConfirmations.push(person('r2')); state(body,'指定审批'); await notifications.processApprovalNotifications(env);
  assert.equal(sent.at(-1).receive_id,'ou_a1abcd'); assert.equal(sent.length,3);
  await notifications.processApprovalNotifications(env); assert.equal(sent.length,3);
});
test('approval-only and return/resubmit notify the appropriate person in each cycle', async () => {
  const body = payload([],['a1']); create(body,'指定审批'); await notifications.processApprovalNotifications(env); assert.equal(sent[0].receive_id,'ou_a1abcd');
  state(body,'补充材料','已退回','return'); await notifications.processApprovalNotifications(env); assert.equal(sent[1].receive_id,'ou_authorabcd');
  state(body,'指定审批','待审核','resubmit'); await notifications.processApprovalNotifications(env); assert.equal(sent[2].receive_id,'ou_a1abcd');
  assert.equal(new Set(sent.map((row) => row.uuid)).size,3);
});
test('queued notices are skipped when completed or the member leaves before delivery', async () => {
  const body = payload(['r1'],[]); create(body); await notifications.enqueueApprovalNotifications(db);
  state(body,'已归档','已归档','approve'); await notifications.deliverApprovalNotifications(env);
  assert.equal(sent.length,0); assert.equal(sqlite.prepare('SELECT status FROM notification_outbox').get().status,'skipped');
});
test('Feishu namespace and stable member identity are checked before sending', async () => {
  create(payload(['r1'],[])); await notifications.enqueueApprovalNotifications(db);
  env.FEISHU_LOGIN_TENANT_KEY='another_tenant'; await notifications.deliverApprovalNotifications(env);
  assert.equal(sent.length,0); assert.equal(sqlite.prepare('SELECT failure_code FROM notification_outbox').get().failure_code,'FEISHU_MEMBER_NOT_LINKED');
});
test('network retry reuses the same Feishu uuid and records acknowledgement', async () => {
  create(payload(['r1'],[])); failure='network'; await notifications.processApprovalNotifications(env);
  const first=sqlite.prepare('SELECT * FROM notification_outbox').get(); assert.equal(first.status,'pending'); assert.equal(first.attempts,1);
  failure=null; sqlite.exec("UPDATE notification_outbox SET next_attempt_at=0"); await notifications.deliverApprovalNotifications(env);
  assert.equal(sent[0].uuid,sent[1].uuid); assert.equal(sqlite.prepare('SELECT status FROM notification_outbox').get().status,'sent');
  await notifications.deliverApprovalNotifications(env); assert.equal(sent.length,2);
});
test('uncertain deliveries are never blindly retried outside Feishu deduplication window', async () => {
  create(payload(['r1'],[])); await notifications.enqueueApprovalNotifications(db);
  sqlite.prepare("UPDATE notification_outbox SET first_attempt_at=?, next_attempt_at=0").run(Date.now()-51*60000);
  await notifications.deliverApprovalNotifications(env); assert.equal(sent.length,0); assert.equal(sqlite.prepare('SELECT status FROM notification_outbox').get().status,'needs_review');
});
test('feature disabled does not advance the event cursor or send messages', async () => {
  create(); env.FEISHU_NOTIFICATIONS_ENABLED='false'; await notifications.processApprovalNotifications(env);
  assert.equal(sent.length,0); assert.equal(sqlite.prepare('SELECT last_event_id FROM notification_control').get().last_event_id,0);
});
test('departed members and changed stable accounts cannot receive queued notices', async () => {
  create(payload(['r1','r2'],[])); await notifications.enqueueApprovalNotifications(db);
  sqlite.exec("UPDATE members SET status='departed' WHERE id='r1'");
  sqlite.exec("UPDATE members SET account_user_id='email:replacement@example.com' WHERE id='r2'");
  await notifications.deliverApprovalNotifications(env);
  assert.equal(sent.length,0); assert.ok(sqlite.prepare('SELECT status FROM notification_outbox').all().every((row) => row.status === 'skipped'));
});
test('notification installation starts after existing history', async () => {
  create(); sqlite.exec('DROP TABLE notification_control');
  sqlite.exec(readFileSync(new URL('../migrations/oa/0001_feishu_notifications.sql', import.meta.url), 'utf8'));
  await notifications.processApprovalNotifications(env);
  assert.equal(sent.length,0); assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM notification_outbox').get().n,0);
});
test('notification administration requires admitted admin and test delivery is restricted to self', async () => {
  const request = (origin = 'https://oa.omindos.ai') => new Request('https://oa.omindos.ai/api/admin/notifications', { method: 'POST', headers: { Origin: origin }, body: JSON.stringify({ memberId: 'r2' }) });
  for (const actor of [null, { isAdmin: false, ndaCompleted: true }, { isAdmin: true, ndaCompleted: false }]) {
    globalThis.__notificationApiTest.actor = actor;
    assert.equal((await adminApi.GET()).status, 403); assert.equal((await adminApi.POST(request())).status, 403);
  }
  globalThis.__notificationApiTest.actor = { isAdmin: true, ndaCompleted: true, memberId: 'author', accountUserId: 'email:author@example.com' };
  assert.equal((await adminApi.POST(request('https://other.example'))).status, 403);
  assert.equal((await adminApi.POST(request())).status, 202); assert.equal((await adminApi.POST(request())).status, 202);
  const rows = sqlite.prepare('SELECT * FROM notification_outbox').all(); assert.equal(rows.length, 1); assert.equal(rows[0].target_member_id, 'author');
  await notifications.deliverApprovalNotifications(env); assert.equal(sent.length, 1); assert.equal(sent[0].receive_id, 'ou_authorabcd');
  const result = await (await adminApi.GET()).json(); assert.equal(result.latestTest.status, 'sent');
});

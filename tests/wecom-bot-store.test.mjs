import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { stripTypeScriptTypes } from 'node:module';
import * as contract from '../lib/wecom-bot-contract.mjs';
const { BOT_SQL } = contract;

const migration = readFileSync(new URL('../drizzle/0035_wecom_bot.sql', import.meta.url), 'utf8');
const now = '2026-10-01T00:00:00.000Z';
const expiresAt = '2026-10-01T00:05:00.000Z';
const base = {
  botId: 'bot-1', userId: 'user-1', memberId: 'member-1', accountUserId: 'account-1', memberRevision: 'member-revision-1',
  isAdmin: 0, name: '本人', email: 'one@example.test', ndaApprovalId: 'nda-1', ndaAcceptedAt: '2026-09-01T00:00:00.000Z',
  ndaAgreementVersion: 'nda-version-1', pairingId: 'a960b817-7abc-4c9e-a682-0c08e6f7c591', codeHash: 'a'.repeat(64),
  now, expiresAt, rateCutoff: '2026-09-30T23:59:00.000Z', newRevision: 'link-revision-1', staleRevision: 'stale-revision-1',
};

function fixture(path = ':memory:') {
  const database = new DatabaseSync(path);
  database.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE migration_control (freeze_id TEXT PRIMARY KEY,activated_at TEXT,deactivated_at TEXT);
    CREATE TABLE members (id TEXT PRIMARY KEY,status TEXT,account_user_id TEXT,mutation_revision TEXT,account_binding_previous_status TEXT,chatgpt_account TEXT,nda_accepted_at TEXT,nda_agreement_version TEXT);
    CREATE TABLE approvals (id TEXT PRIMARY KEY,type TEXT,status TEXT,requester_email TEXT,updated_at TEXT,payload_json TEXT);
    CREATE TABLE member_events (id INTEGER PRIMARY KEY AUTOINCREMENT,member_id TEXT,actor_name TEXT,actor_email TEXT,action TEXT,note TEXT,created_at TEXT);
    CREATE TABLE project_work_items (id TEXT PRIMARY KEY,project TEXT,title TEXT,status TEXT,priority TEXT,due_at TEXT,assignee_email TEXT,created_by_email TEXT,updated_at TEXT);
    CREATE TABLE knowledge_items (id TEXT PRIMARY KEY,status TEXT,visibility TEXT,active_revision_id TEXT,updated_at TEXT);
    CREATE TABLE knowledge_revisions (id TEXT PRIMARY KEY,item_id TEXT,title TEXT,category TEXT,source_label TEXT,source_url TEXT,status TEXT);
    CREATE TABLE knowledge_chunks (id TEXT PRIMARY KEY,item_id TEXT,revision_id TEXT,chunk_no INTEGER,section_title TEXT,paragraph_ref TEXT,content TEXT,search_text TEXT,is_active INTEGER);
  `);
  database.exec(migration);
  database.prepare('INSERT INTO members VALUES (?,?,?,?,?,?,?,?)').run('member-1', 'active', 'account-1', 'member-revision-1', null, 'one@example.test', null, null);
  database.prepare('INSERT INTO members VALUES (?,?,?,?,?,?,?,?)').run('member-2', 'active', 'account-2', 'member-revision-2', null, 'two@example.test', null, null);
  database.prepare('INSERT INTO approvals VALUES (?,?,?,?,?,?)').run('nda-1', '保密协议', '已归档', 'one@example.test', base.ndaAcceptedAt, JSON.stringify({ signerAccountUserId: 'account-1', agreementVersion: base.ndaAgreementVersion }));
  return database;
}
const run = (database, key, context = base) => database.prepare(BOT_SQL[key]).all(JSON.stringify(context));
function batch(database, keys, context = base) {
  database.exec('BEGIN IMMEDIATE');
  try { const result = keys.map((key) => run(database, key, context)); database.exec('COMMIT'); return result; }
  catch (error) { database.exec('ROLLBACK'); throw error; }
}
const create = (database, context = base) => batch(database, ['revokeStaleLink', 'staleLinkEvent', 'cancelPrevious', 'createPairing'], context).at(-1);
const confirm = (database, context = base) => batch(database, ['confirmLink', 'finishPairing', 'linkEvent'], context);
function link(database, context = base) {
  assert.equal(create(database, context).length, 1);
  assert.equal(run(database, 'claimPairing', context).length, 1);
  assert.equal(confirm(database, context)[0].length, 1);
}

test('pairing needs a one-time provider candidate followed by same OA owner confirmation', () => {
  const database = fixture();
  assert.equal(create(database).length, 1);
  assert.equal(confirm(database)[0].length, 0);
  assert.equal(run(database, 'claimPairing').length, 1);
  assert.equal(run(database, 'claimPairing', { ...base, userId: 'attacker' }).length, 0);
  const wrong = { ...base, memberId: 'member-2', accountUserId: 'account-2', memberRevision: 'member-revision-2', isAdmin: 1, email: 'two@example.test' };
  assert.equal(confirm(database, wrong)[0].length, 0);
  assert.equal(confirm(database)[0].length, 1);
  assert.equal(confirm(database, { ...base, newRevision: 'replay-revision' })[0].length, 0);
  assert.equal(database.prepare('SELECT count(*) AS n FROM member_events').get().n, 1);
  assert.equal(run(database, 'senderLink', { botId: 'another-bot', userId: base.userId }).length, 0);
  database.close();
});

test('archived NDA permits binding with empty cache but revocation or mismatched signer fails closed', () => {
  const database = fixture();
  assert.equal(create(database).length, 1);
  database.prepare("UPDATE approvals SET status='已退回' WHERE id='nda-1'").run();
  assert.equal(run(database, 'claimPairing').length, 0);
  database.prepare("UPDATE approvals SET status='已归档',payload_json=? WHERE id='nda-1'").run(JSON.stringify({ signerAccountUserId: 'other-account', agreementVersion: base.ndaAgreementVersion }));
  assert.equal(run(database, 'claimPairing').length, 0);
  database.prepare("UPDATE approvals SET payload_json=? WHERE id='nda-1'").run(JSON.stringify({ signerAccountUserId: 'account-1', agreementVersion: base.ndaAgreementVersion }));
  assert.equal(run(database, 'claimPairing').length, 1);
  database.prepare("UPDATE approvals SET updated_at='2026-10-01T00:00:00.000Z' WHERE id='nda-1'").run();
  assert.equal(confirm(database)[0].length, 0);
  database.close();
});

test('expired, changed revision, departed and pending account binding states cannot establish links', () => {
  for (const update of ["status='departed'", "mutation_revision='changed'", "account_binding_previous_status='active'", "account_user_id='replacement'"]) {
    const database = fixture();
    assert.equal(create(database).length, 1);
    database.exec(`UPDATE members SET ${update} WHERE id='member-1'`);
    assert.equal(run(database, 'claimPairing').length, 0);
    assert.equal(confirm(database)[0].length, 0);
    database.close();
  }
  const database = fixture();
  create(database);
  assert.equal(run(database, 'claimPairing', { ...base, now: expiresAt }).length, 0);
  run(database, 'claimPairing');
  assert.equal(confirm(database, { ...base, now: expiresAt })[0].length, 0);
  database.close();
});

test('NDA-exempt administrator still needs active exact member and account snapshots', () => {
  const database = fixture();
  database.exec('DELETE FROM approvals');
  const admin = { ...base, isAdmin: 1, ndaApprovalId: null, ndaAcceptedAt: null, ndaAgreementVersion: null };
  link(database, admin);
  const context = { ...admin, linkRevision: admin.newRevision };
  assert.equal(run(database, 'currentLink', context).length, 1);
  database.exec("UPDATE members SET status='departed' WHERE id='member-1'");
  assert.equal(run(database, 'currentLink', context).length, 0);
  assert.equal(run(database, 'unlink', { ...context, newRevision: 'admin-unlink' }).length, 0);
  database.close();
});

test('sender and member uniqueness prevents concurrent candidates from taking another mapping', () => {
  const database = fixture();
  const second = { ...base, memberId: 'member-2', accountUserId: 'account-2', memberRevision: 'member-revision-2', isAdmin: 1,
    ndaApprovalId: null, ndaAcceptedAt: null, ndaAgreementVersion: null, pairingId: '27aec3e3-d8f9-43af-8501-bb9d5c79ec04', codeHash: 'b'.repeat(64), newRevision: 'second-link' };
  create(database); create(database, second);
  assert.equal(run(database, 'claimPairing').length, 1);
  assert.equal(run(database, 'claimPairing', second).length, 1);
  assert.equal(confirm(database)[0].length, 1);
  assert.equal(confirm(database, second)[0].length, 0);
  assert.equal(run(database, 'senderLink').at(0).member_id, 'member-1');
  assert.equal(database.prepare('SELECT count(*) AS n FROM wecom_bot_links WHERE revoked_at IS NULL').get().n, 1);
  database.close();
});

test('binding can safely recover after OA account rebind without inheriting an old sender', () => {
  const database = fixture(); link(database);
  database.exec("UPDATE members SET account_user_id='new-account',mutation_revision='new-member-revision' WHERE id='member-1'");
  const oldContext = { ...base, linkRevision: base.newRevision };
  assert.equal(run(database, 'currentLink', oldContext).length, 0);
  const next = { ...base, accountUserId: 'new-account', memberRevision: 'new-member-revision', isAdmin: 1,
    ndaApprovalId: null, ndaAcceptedAt: null, ndaAgreementVersion: null, pairingId: 'd61d12cb-021e-4bb0-a0bc-9fd071c48bd3', codeHash: 'c'.repeat(64),
    staleRevision: 'stale-old-account', newRevision: 'new-link-revision', userId: 'new-provider-user' };
  assert.equal(run(database, 'revokeStaleLink', oldContext).length, 0);
  assert.equal(create(database, next).length, 1);
  assert.equal(run(database, 'senderLink', base).length, 0);
  assert.equal(run(database, 'senderLink', next).length, 0);
  assert.equal(run(database, 'claimPairing', next).length, 1);
  assert.equal(confirm(database, next)[0].length, 1);
  assert.equal(run(database, 'senderLink', next).at(0).account_user_id, 'new-account');
  assert.equal(database.prepare("SELECT count(*) AS n FROM member_events WHERE action='wecom_bot_unlinked'").get().n, 1);
  database.close();
});

test('only own assigned or created open work items are disclosed and unlink cuts access immediately', () => {
  const database = fixture(); link(database);
  for (const row of [
    ['own-assigned', 'open', 'one@example.test', 'other@example.test'],
    ['own-created', 'in_progress', 'other@example.test', 'one@example.test'],
    ['other', 'open', 'other@example.test', 'other@example.test'],
    ['done', 'done', 'one@example.test', 'one@example.test'],
  ]) database.prepare('INSERT INTO project_work_items VALUES (?,?,?,?,?,?,?,?,?)').run(row[0], 'project', row[0], row[1], 'normal', null, row[2], row[3], now);
  const context = { ...base, project: 'project', linkRevision: base.newRevision };
  assert.deepEqual(run(database, 'ownWorkItems', context).map((row) => row.id).sort(), ['own-assigned', 'own-created']);
  batch(database, ['unlink', 'unlinkEvent'], { ...context, newRevision: 'unlink-revision' });
  assert.equal(run(database, 'currentLink', context).length, 0);
  assert.equal(run(database, 'ownWorkItems', context).length, 0);
  database.close();
});

test('bot knowledge reads only active approved revisions with current link and live NDA or admin admission', () => {
  const database = fixture(); link(database);
  const add = (id, itemStatus = 'active', revisionStatus = 'active', isActive = 1, visibility = 'internal', activeRevision = id) => {
    database.prepare('INSERT INTO knowledge_items VALUES (?,?,?,?,?)').run(id, itemStatus, visibility, activeRevision, now);
    database.prepare('INSERT INTO knowledge_revisions VALUES (?,?,?,?,?,?,?)').run(id, id, '项目进展', '', '', '', revisionStatus);
    database.prepare('INSERT INTO knowledge_chunks VALUES (?,?,?,?,?,?,?,?,?)').run(id, id, id, 1, '', '', `材料-${id}`, '项目进展', isActive);
  };
  add('approved'); add('public-approved', 'active', 'active', 1, 'public'); add('pending', 'pending');
  add('revoked', 'revoked'); add('old-revision', 'active', 'superseded'); add('inactive-chunk', 'active', 'active', 0);
  add('wrong-active-pointer', 'active', 'active', 1, 'internal', 'another-revision'); add('restricted', 'active', 'active', 1, 'other');
  const context = { ...base, linkRevision: base.newRevision, terms: ['项目', '进展'] };
  assert.deepEqual(run(database, 'activeKnowledge', context).map((row) => row.id).sort(), ['approved', 'public-approved']);
  database.exec('DELETE FROM approvals');
  assert.equal(run(database, 'activeKnowledge', context).length, 0);
  const admin = { ...context, isAdmin: 1, ndaApprovalId: null, ndaAcceptedAt: null, ndaAgreementVersion: null };
  assert.equal(run(database, 'activeKnowledge', admin).length, 2);
  database.exec("UPDATE members SET status='departed' WHERE id='member-1'");
  assert.equal(run(database, 'activeKnowledge', admin).length, 0);
  database.exec("UPDATE members SET status='active' WHERE id='member-1'; UPDATE wecom_bot_links SET revoked_at='revoked' WHERE bot_id='bot-1'");
  assert.equal(run(database, 'activeKnowledge', admin).length, 0);
  database.close();
});

test('migration freeze blocks all writes including cleanup while GET stays read only', () => {
  const database = fixture(); link(database);
  database.exec("INSERT INTO migration_control VALUES ('frozen','now',NULL)");
  const context = { ...base, linkRevision: base.newRevision, newRevision: 'frozen-attempt', messageId: 'm-1', expiresAt: '2026-10-03T00:00:00.000Z', cutoff: '2026-10-04T00:00:00.000Z' };
  assert.equal(run(database, 'claimMessage', context).length, 0);
  assert.equal(run(database, 'unlink', context).length, 0);
  assert.equal(run(database, 'currentLink', context).length, 1);
  run(database, 'cleanupPairings', { ...context, now: '2026-10-04T00:00:00.000Z' });
  assert.equal(database.prepare('SELECT count(*) AS n FROM wecom_bot_pairings').get().n, 1);
  database.close();
});

test('atomic message claims suppress replay, bound rate and retain no message text', () => {
  const database = fixture();
  const context = { ...base, messageId: 'm-1', expiresAt: '2026-10-03T00:00:00.000Z' };
  assert.equal(run(database, 'claimMessage', context).length, 1);
  assert.equal(run(database, 'claimMessage', context).length, 0);
  for (let index = 2; index <= 20; index++) assert.equal(run(database, 'claimMessage', { ...context, messageId: `m-${index}` }).length, 1);
  assert.equal(run(database, 'claimMessage', { ...context, messageId: 'm-21' }).length, 0);
  assert.equal(run(database, 'claimMessage', { ...context, messageId: 'm-21', now: '2026-10-01T00:02:00.000Z', rateCutoff: '2026-10-01T00:01:00.000Z' }).length, 1);
  assert.deepEqual(database.prepare('PRAGMA table_info(wecom_bot_messages)').all().map((row) => row.name), ['bot_id', 'message_id', 'user_id', 'created_at', 'expires_at']);
  run(database, 'cleanupMessages', { now: '2026-10-04T00:00:00.000Z' });
  assert.equal(database.prepare('SELECT count(*) AS n FROM wecom_bot_messages').get().n, 0);
  database.close();
});

test('independent SQLite connections racing the same message have exactly one claim', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'oa-wecom-race-'));
  const path = join(directory, 'race.sqlite');
  const database = fixture(path); database.close();
  const context = { ...base, messageId: 'racing-message', expiresAt: '2026-10-03T00:00:00.000Z' };
  const workerSource = `const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData.path); db.exec('PRAGMA busy_timeout=5000');
    parentPort.postMessage('ready'); parentPort.once('message', () => {
      try { parentPort.postMessage({ claimed: db.prepare(workerData.sql).all(workerData.context).length }); }
      catch (error) { parentPort.postMessage({ error: error.message }); }
      finally { db.close(); }
    });`;
  const workers = [0, 1].map(() => new Worker(workerSource, { eval: true, workerData: { path, sql: BOT_SQL.claimMessage, context: JSON.stringify(context) } }));
  try {
    await Promise.all(workers.map((worker) => new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); })));
    const results = workers.map((worker) => new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }));
    workers.forEach((worker) => worker.postMessage('claim'));
    const resolved = await Promise.all(results);
    assert.equal(resolved.some((result) => result.error), false);
    assert.equal(resolved.reduce((total, result) => total + result.claimed, 0), 1);
  } finally { await Promise.all(workers.map((worker) => worker.terminate())); rmSync(directory, { recursive: true, force: true }); }
});

// Load the actual TypeScript route/store with only platform dependencies
// replaced by a SQLite adapter and controllable retrieval/model boundaries.
// Assertions exercise the production asynchronous authorization sequence.
async function messageHarness(database, hook) {
  const key = `__wecom_bot_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const prepared = (sql, parameters = []) => ({
    bind(...values) { return prepared(sql, values); },
    async first() { return database.prepare(sql).get(...parameters) || null; },
    async all() { return { results: database.prepare(sql).all(...parameters), success: true, meta: {} }; },
    async run() { return { results: [], success: true, meta: database.prepare(sql).run(...parameters) }; },
  });
  const adapter = {
    prepare(sql) { return prepared(sql); },
    async batch(statements) {
      database.exec('BEGIN IMMEDIATE');
      try { const results = []; for (const statement of statements) results.push(await statement.all()); database.exec('COMMIT'); return results; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    },
  };
  const actor = {
    user: { email: base.email, displayName: base.name }, memberId: base.memberId, accountUserId: base.accountUserId,
    memberMutationRevision: base.memberRevision, isAdmin: false, ndaCompleted: true,
    ndaApprovalId: base.ndaApprovalId, ndaAcceptedAt: base.ndaAcceptedAt, ndaAgreementVersion: base.ndaAgreementVersion,
  };
  let modelCalls = 0;
  const environment = { WECOM_BOT_ENABLED: 'true', WECOM_BOT_ID: base.botId, WECOM_BOT_BRIDGE_SECRET: 'A'.repeat(43) };
  const dependencies = {
    ...contract, getD1Database: async () => adapter,
    isMigrationWriteFrozen: (value) => value.OA_MIGRATION_WRITE_FROZEN === 'true',
    getAuthorizedIntegrationMember: async () => {
      const member = database.prepare('SELECT * FROM members WHERE id=?').get(base.memberId);
      return member?.status === 'active' && member.account_user_id === base.accountUserId
        ? { ...actor, memberMutationRevision: member.mutation_revision } : null;
    },
    knowledgeSearchTerms: () => ['项目', '进展'],
    rankKnowledgeChunks: (_question, chunks) => chunks,
    answerOaChatQuestion: async () => { modelCalls += 1; await hook?.('model', database); return { answer: '私有 OA 资料答案' }; },
    OA_PROJECT: 'project', platformEnvironment: async () => ({ env: environment }),
  };
  globalThis[key] = dependencies;
  const importPatched = async (path, names) => {
    const source = stripTypeScriptTypes(readFileSync(new URL(path, import.meta.url), 'utf8'))
      .replace(/^import[\s\S]*?;\n/gmu, '')
      .replaceAll("await import('cloudflare:workers')", `await globalThis[${JSON.stringify(key)}].platformEnvironment()`);
    const code = `const {${names.join(',')}} = globalThis[${JSON.stringify(key)}];\n${source}\n// ${crypto.randomUUID()}`;
    return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  };
  const storeNames = ['getD1Database', 'isMigrationWriteFrozen', 'knowledgeSearchTerms', 'BOT_SQL', 'BOT_PAIRING_LIFETIME_MS', 'BOT_LEDGER_LIFETIME_MS', 'createBotPairingCode', 'hashBotPairingCode', 'maskBotUserId'];
  Object.assign(dependencies, await importPatched('../lib/wecom-bot-store.ts', storeNames));
  const realRetrieval = dependencies.getBotActiveKnowledgeChunks;
  dependencies.getBotActiveKnowledgeChunks = async (...args) => { const result = await realRetrieval(...args); await hook?.('retrieval', database); return result; };
  const routeNames = ['getAuthorizedIntegrationMember', 'botConfiguration', 'parseBotCommand', 'readSignedBotMessage',
    'claimBotMessage', 'claimBotPairing', 'getBotSenderLink', 'isBotLinkCurrent', 'listBotOwnWorkItems', 'unlinkBotActor',
    'getBotActiveKnowledgeChunks', 'isBotKnowledgeCurrent', 'rankKnowledgeChunks', 'answerOaChatQuestion', 'OA_PROJECT'];
  const route = await importPatched('../app/api/integrations/wecom-bot/messages/route.ts', routeNames);
  return {
    async request(messageId = crypto.randomUUID()) {
      const body = JSON.stringify({ botId: base.botId, userId: base.userId, messageId, text: '内部项目进展' });
      const timestamp = String(Date.now());
      const request = new Request('https://oa.example.test/api/integrations/wecom-bot/messages', {
        method: 'POST', body, headers: { 'content-type': 'application/json', 'x-oa-bot-timestamp': timestamp,
          'x-oa-bot-signature': await contract.signBotBody(environment.WECOM_BOT_BRIDGE_SECRET, timestamp, body) },
      });
      return route.POST(request);
    },
    calls: () => modelCalls,
    close: () => { delete globalThis[key]; },
  };
}

test('actual message route suppresses model output when member or link is revoked asynchronously', async () => {
  for (const [stage, mutation] of [
    ['retrieval', "UPDATE members SET status='departed' WHERE id='member-1'"],
    ['model', "UPDATE members SET mutation_revision='revoked-revision' WHERE id='member-1'"],
    ['model', "UPDATE wecom_bot_links SET revoked_at='revoked',revision='revoked-link' WHERE bot_id='bot-1' AND user_id='user-1'"],
  ]) {
    const database = fixture(); link(database);
    const harness = await messageHarness(database, (currentStage) => { if (currentStage === stage) database.exec(mutation); });
    try {
      const response = await harness.request();
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, reply: '' });
      assert.equal(harness.calls(), stage === 'retrieval' ? 0 : 1);
    } finally { harness.close(); database.close(); }
  }
});

test('actual message route returns admitted answer once and replay cannot invoke model again', async () => {
  const database = fixture(); link(database);
  const harness = await messageHarness(database);
  try {
    const messageId = crypto.randomUUID();
    assert.deepEqual(await (await harness.request(messageId)).json(), { ok: true, reply: '私有 OA 资料答案' });
    assert.deepEqual(await (await harness.request(messageId)).json(), { ok: true, reply: '' });
    assert.equal(harness.calls(), 1);
  } finally { harness.close(); database.close(); }
});

function addMessageKnowledge(database, id = 'evidence-1', updatedAt = now) {
  database.prepare('INSERT INTO knowledge_items VALUES (?,?,?,?,?)').run(id, 'active', 'internal', id, updatedAt);
  database.prepare('INSERT INTO knowledge_revisions VALUES (?,?,?,?,?,?,?)').run(id, id, '项目进展', '', '', '', 'active');
  database.prepare('INSERT INTO knowledge_chunks VALUES (?,?,?,?,?,?,?,?,?)').run(id, id, id, 1, '', '', `私有材料-${id}`, '项目进展', 1);
}

test('actual message route suppresses selected evidence withdrawn before or during model execution', async () => {
  for (const [stage, mutation] of [
    ['retrieval', "UPDATE knowledge_items SET status='revoked',active_revision_id=NULL WHERE id='evidence-1'"],
    ['model', "UPDATE knowledge_items SET status='revoked',active_revision_id=NULL WHERE id='evidence-1'"],
    ['model', "UPDATE knowledge_revisions SET status='superseded' WHERE id='evidence-1'"],
    ['model', "UPDATE knowledge_chunks SET is_active=0 WHERE id='evidence-1'"],
    ['model', "UPDATE knowledge_items SET active_revision_id='new-revision' WHERE id='evidence-1'"],
    ['model', "UPDATE knowledge_items SET visibility='restricted' WHERE id='evidence-1'"],
    ['model', "DELETE FROM knowledge_chunks WHERE id='evidence-1'"],
    ['model', "UPDATE knowledge_chunks SET content='changed-without-new-revision' WHERE id='evidence-1'"],
    ['model', "UPDATE knowledge_revisions SET title='changed-title' WHERE id='evidence-1'"],
  ]) {
    const database = fixture(); link(database); addMessageKnowledge(database);
    const harness = await messageHarness(database, (currentStage) => { if (currentStage === stage) database.exec(mutation); });
    try {
      const response = await harness.request();
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, reply: '' });
      assert.equal(harness.calls(), stage === 'retrieval' ? 0 : 1);
    } finally { harness.close(); database.close(); }
  }
});

test('selected evidence remains valid when new keyword matches change the bounded candidate pool', async () => {
  const database = fixture(); link(database); addMessageKnowledge(database);
  const harness = await messageHarness(database, (stage) => {
    if (stage === 'model') for (let index = 0; index < 300; index++) addMessageKnowledge(database, `new-evidence-${index}`, '2026-10-01T00:01:00.000Z');
  });
  try {
    const response = await harness.request();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, reply: '私有 OA 资料答案' });
    assert.equal(harness.calls(), 1);
  } finally { harness.close(); database.close(); }
});

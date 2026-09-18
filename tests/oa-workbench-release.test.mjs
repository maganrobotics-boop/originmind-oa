import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { reviewedTaskSql, expectedTaskSchema, checkTaskSchema, TASK_SCHEMA_QUERY, probeTaskTools } from '../scripts/oa-workbench-release.mjs';
const directory = new URL('../migrations/oa/', import.meta.url);
// The source folder also holds older unrelated SQL, so build an allowlisted copy.
async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'oa-workbench-release-'));
  try {
    for (const name of ['0002_ai_workbench.sql', '0003_ai_workbench_artifacts.sql', '0004_ai_workbench_retention.sql']) await cp(new URL(name, directory), join(dir, name));
    return await run(dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const payload = results => [{ success: true, results }];
const secret = 'A'.repeat(43);
const artifacts = [{ format: 'md', byte_size: 100, sha256: 'a'.repeat(64) }, { format: 'docx', byte_size: 1000, sha256: 'b'.repeat(64) }];
const generated = () => ({ received: true, mode: 'task', provider: 'bailian', answer: '这是合成测试报告，接口联调完成，实机验收待开展，负责人和日期待补充。', execution: { version: 1, state: 'prepared', modelCalls: 2, steps: [{ tool: 'read_material', status: 'ok' }, { tool: 'prepare_document', status: 'ok' }] } });

test('only the exact reviewed task migration bytes are accepted', async () => fixture(async dir => {
  const sql = await reviewedTaskSql(dir); assert.equal(Object.keys(expectedTaskSchema(sql)).length, 8);
  await writeFile(join(dir, '0003_ai_workbench_artifacts.sql'), `${sql['0003_ai_workbench_artifacts.sql']}\n-- drift`);
  await assert.rejects(reviewedTaskSql(dir), /HASH/);
}));
test('unreviewed additional SQL cannot enter the release manifest', async () => fixture(async dir => {
  await writeFile(join(dir, '0004_unreviewed.sql'), 'DROP TABLE members;');
  await assert.rejects(reviewedTaskSql(dir), /MANIFEST/);
}));
test('empty or compatible partial task schemas may be initialized, but cannot pass the after gate', async () => fixture(async dir => {
  const definitions = expectedTaskSchema(await reviewedTaskSql(dir));
  assert.equal(checkTaskSchema('before', payload([]), definitions).missing.length, 8);
  assert.throws(() => checkTaskSchema('after', payload([]), definitions), /INCOMPLETE/);
  const [key, sql] = Object.entries(definitions)[0], [type, name] = key.split(':');
  assert.equal(checkTaskSchema('before', payload([{ type, name, sql }]), definitions).objects.length, 1);
}));
test('repeat-safe SQL preserves data and matches the exact post-migration schema', async () => fixture(async dir => {
  const sql = await reviewedTaskSql(dir), definitions = expectedTaskSchema(sql), db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE members(id TEXT PRIMARY KEY); INSERT INTO members VALUES('member');");
    for (const text of Object.values(sql)) db.exec(text);
    db.exec("INSERT INTO ai_workbench_tasks(id,member_id,account_user_id,member_revision,kind,title,instruction,material,origin_key,created_at,updated_at) VALUES('test','member','user','rev','document','合成测试','整理','不是真实成员资料','oa:test',1,1)");
    for (const text of Object.values(sql)) db.exec(text);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_workbench_tasks').get().n, 1);
    assert.equal(checkTaskSchema('after', payload(db.prepare(TASK_SCHEMA_QUERY).all()), definitions).missing.length, 0);
  } finally { db.close(); }
}));
test('provider errors, duplicate objects, unexpected triggers and schema drift stop activation', async () => fixture(async dir => {
  const definitions = expectedTaskSchema(await reviewedTaskSql(dir));
  for (const value of [[], [{ success: false, results: [] }], [{ success: true }]]) assert.throws(() => checkTaskSchema('before', value, definitions));
  const [key, sql] = Object.entries(definitions)[0], [type, name] = key.split(':'), row = { type, name, sql };
  for (const rows of [[row, row], [{ ...row, sql: 'CREATE TABLE wrong(id TEXT)' }], [{ type: 'trigger', name: 'outside_namespace', sql: 'CREATE TRIGGER outside_namespace BEFORE INSERT ON ai_workbench_tasks BEGIN DELETE FROM members; END' }]]) assert.throws(() => checkTaskSchema('before', payload(rows), definitions), /DRIFT/);
}));
test('live-probe request is signed, fixed-destination and synthetic; receipts contain no source text', async () => {
  let calls = 0;
  const receipt = await probeTaskTools(secret, async (url, options) => {
    calls++; assert.equal(url, 'https://chat.omindos.ai/api/internal/oa-answer'); assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.origin, undefined); assert.equal(options.headers.cookie, undefined);
    const body = JSON.parse(options.body); assert.equal(body.operation, 'task'); assert.match(body.task.material, /合成测试/);
    const signed = `oa-chat-bridge/v1\nPOST\n/api/internal/oa-answer\n${options.headers['x-oa-chat-time']}\n${options.headers['x-oa-chat-nonce']}\n${options.body}`;
    assert.equal(options.headers.authorization, `OA-HMAC ${createHmac('sha256', secret).update(signed).digest('hex')}`);
    return Response.json(generated());
  }, async () => artifacts);
  assert.equal(calls, 1); assert.equal(receipt.verified, true); assert.equal(receipt.oaTaskPersistenceTested, false);
  assert.ok(!JSON.stringify(receipt).includes('接口联调')); assert.ok(!JSON.stringify(receipt).includes(secret));
});
test('retrieval fallback or incomplete tool execution cannot pass the real model gate', async () => {
  for (const change of [{ provider: 'workers-ai' }, { mode: 'retrieval' }, { answer: '' }, { execution: { ...generated().execution, steps: [] } }, { execution: { ...generated().execution, modelCalls: 0 } }]) {
    await assert.rejects(probeTaskTools(secret, async () => Response.json({ ...generated(), ...change }), async () => artifacts), /INCOMPLETE/);
  }
});
test('bad authentication configuration, HTTP failures and oversized responses fail closed', async () => {
  await assert.rejects(probeTaskTools('wrong', async () => { throw new Error('must not be called'); }), /SECRET/);
  await assert.rejects(probeTaskTools(secret, async () => Response.json({ error: 'synthetic' }, { status: 503 })), /HTTP/);
  await assert.rejects(probeTaskTools(secret, async () => new Response('x'.repeat(300000), { headers: { 'content-type': 'application/json' } })), /TOO_LARGE/);
});
test('both locally compiled artifact formats must have valid sizes and hashes', async () => {
  await assert.rejects(probeTaskTools(secret, async () => Response.json(generated()), async () => artifacts.slice(0, 1)), /ARTIFACT/);
  await assert.rejects(probeTaskTools(secret, async () => Response.json(generated()), async () => [{ ...artifacts[0], byte_size: 0 }, artifacts[1]]), /ARTIFACT/);
});

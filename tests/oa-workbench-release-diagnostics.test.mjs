import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { probeTaskTools, releaseFailureDiagnostic, checkTaskSchema } from '../scripts/oa-workbench-release.mjs';

// These are injected synthetic replies, never real credentials or model calls.
const secret = 'A'.repeat(43);
const privateMarker = 'SYNTHETIC_PRIVATE_VALUE_DO_NOT_LOG';
const artifacts = () => [{ format: 'md', byte_size: 100, sha256: 'a'.repeat(64) }, { format: 'docx', byte_size: 1000, sha256: 'b'.repeat(64) }];
const generated = () => ({ received: true, mode: 'task', provider: 'bailian', answer: '合成材料报告：接口联调已完成，实机验收未开展，负责人及日期待补充。', execution: { version: 1, state: 'prepared', modelCalls: 2, steps: [{ tool: 'read_material', status: 'ok' }, { tool: 'prepare_document', status: 'ok' }] } });
async function rejected(fetcher, compile = async () => artifacts()) {
  try { await probeTaskTools(secret, fetcher, compile); }
  catch (error) { return releaseFailureDiagnostic(error, 'probe'); }
  assert.fail('The failing probe must not be accepted');
}
function noPrivate(value) {
  const text = JSON.stringify(value);
  assert.ok(!text.includes(privateMarker));
  assert.ok(!text.includes(secret));
}

test('successful synthetic probe preserves the fixed HMAC request and honest receipt', async () => {
  let calls = 0;
  const receipt = await probeTaskTools(secret, async (url, init) => {
    calls++;
    assert.equal(url, 'https://chat.omindos.ai/api/internal/oa-answer');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.origin, undefined);
    assert.equal(init.headers.cookie, undefined);
    const bytes = `oa-chat-bridge/v1\nPOST\n/api/internal/oa-answer\n${init.headers['x-oa-chat-time']}\n${init.headers['x-oa-chat-nonce']}\n${init.body}`;
    assert.equal(init.headers.authorization, `OA-HMAC ${createHmac('sha256', secret).update(bytes).digest('hex')}`);
    assert.match(JSON.parse(init.body).task.material, /合成测试/);
    return Response.json(generated());
  }, async () => artifacts());
  assert.equal(calls, 1);
  assert.equal(receipt.verified, true);
  assert.equal(receipt.memberSessionTested, false);
  assert.equal(receipt.oaTaskPersistenceTested, false);
  assert.deepEqual(receipt.tools, ['read_material', 'prepare_document']);
  noPrivate(receipt);
});

for (const status of [301, 302, 303, 307, 308, 400, 401, 403, 404, 429, 500, 502, 503]) {
  test(`HTTP ${status} is diagnosed without retries, redirects or response-body disclosure`, async () => {
    let calls = 0;
    const diagnostic = await rejected(async (_url, init) => {
      calls++; assert.equal(init.redirect, 'manual');
      return Response.json({ error: privateMarker }, { status, headers: { location: `https://example.invalid/${privateMarker}` } });
    });
    assert.equal(calls, 1);
    assert.deepEqual(diagnostic, { verified: false, phase: 'probe', code: 'TASK_PROBE_HTTP', httpStatus: status, responseKind: 'json' });
    noPrivate(diagnostic);
  });
}
for (const [message, code, status] of [
  ['仅限已授权的 OA 服务', 'authentication_rejected', 401],
  ['服务认证失败或请求过大', 'authentication_or_size_rejected', 401],
  ['任务需要已配置的百炼模型', 'bailian_not_configured', 503],
  ['问答服务暂不可用，请稍后重试', 'service_unavailable', 503],
  ['任务未生成完整可用成果', 'result_incomplete', 502],
]) {
  test(`known service error maps to the fixed label ${code}`, async () => {
    const diagnostic = await rejected(async () => Response.json({ error: message, debug: privateMarker }, { status }));
    assert.equal(diagnostic.serviceCode, code);
    assert.equal(diagnostic.httpStatus, status);
    noPrivate(diagnostic);
  });
}
test('an error-message suffix cannot enter logs through a known service label', async () => {
  const diagnostic = await rejected(async () => Response.json({ error: `仅限已授权的 OA 服务 ${privateMarker}` }, { status: 401 }));
  assert.equal(diagnostic.serviceCode, undefined); noPrivate(diagnostic);
});
test('HTML response is cancelled without reading its private body', async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const diagnostic = await rejected(async () => new Response(body, { status: 403, headers: { 'content-type': 'text/html' } }));
  assert.equal(cancelled, true);
  assert.equal(diagnostic.responseKind, 'non_json');
  assert.equal(diagnostic.httpStatus, 403);
});
test('an empty response remains a failed probe with numeric status', async () => {
  assert.deepEqual(await rejected(async () => new Response(null, { status: 204 })), { verified: false, phase: 'probe', code: 'TASK_PROBE_HTTP', httpStatus: 204, responseKind: 'empty' });
});
for (const status of [200, 503]) {
  test(`invalid JSON at HTTP ${status} is bounded and does not expose parser text`, async () => {
    const diagnostic = await rejected(async () => new Response(`{${privateMarker}`, { status, headers: { 'content-type': 'application/json' } }));
    assert.equal(diagnostic.code, status === 200 ? 'TASK_PROBE_JSON' : 'TASK_PROBE_HTTP');
    assert.equal(diagnostic.responseKind, 'invalid_json'); noPrivate(diagnostic);
  });
}
for (const body of [null, [], true, 1, 'text']) {
  test(`non-object JSON ${JSON.stringify(body)} cannot pass the probe`, async () => {
    assert.equal((await rejected(async () => Response.json(body))).code, 'TASK_PROBE_JSON');
  });
}
test('invalid UTF-8 fails closed rather than silently replacing bytes', async () => {
  const diagnostic = await rejected(async () => new Response(new Uint8Array([0xc3, 0x28]), { headers: { 'content-type': 'application/json' } }));
  assert.equal(diagnostic.code, 'TASK_PROBE_JSON');
});
test('oversized JSON stream is cancelled before parsing or compiling', async () => {
  let cancelled = false, compiled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(262145)); }, cancel() { cancelled = true; } });
  const diagnostic = await rejected(async () => new Response(body, { headers: { 'content-type': 'application/json' } }), async () => { compiled = true; return artifacts(); });
  assert.equal(diagnostic.code, 'TASK_PROBE_TOO_LARGE');
  assert.equal(cancelled, true); assert.equal(compiled, false);
});
for (const name of ['TimeoutError', 'AbortError', 'TypeError']) {
  test(`fetch ${name} reports a fixed category and never logs the raw exception`, async () => {
    const diagnostic = await rejected(async () => { throw Object.assign(new Error(privateMarker), { name, cause: new Error(secret) }); });
    assert.equal(diagnostic.code, name === 'TypeError' ? 'TASK_PROBE_TRANSPORT' : 'TASK_PROBE_TIMEOUT'); noPrivate(diagnostic);
  });
}
test('body-read failure preserves status but not private transport messages', async () => {
  const body = new ReadableStream({ start(controller) { controller.error(new Error(privateMarker)); } });
  const diagnostic = await rejected(async () => new Response(body, { headers: { 'content-type': 'application/json' } }));
  assert.equal(diagnostic.code, 'TASK_PROBE_TRANSPORT'); assert.equal(diagnostic.httpStatus, 200); noPrivate(diagnostic);
});
for (const mutation of [
  value => { value.mode = 'retrieval'; },
  value => { value.provider = 'workers-ai'; },
  value => { value.execution.state = 'failed'; },
  value => { value.execution.steps = [{ tool: 'read_material', status: 'ok' }]; },
  value => { value.execution.steps = [{ tool: 'prepare_document', status: 'ok' }]; },
  value => { value.execution.steps.push(null); },
  value => { value.execution.steps.push({ tool: privateMarker, status: 'ok' }); },
  value => { value.execution.modelCalls = 7; },
  value => { value.answer = ''; },
]) {
  test('fallback, incomplete or malformed execution still blocks activation', async () => {
    const response = generated(); mutation(response);
    const diagnostic = await rejected(async () => Response.json(response));
    assert.equal(diagnostic.code, 'TASK_PROBE_INCOMPLETE'); noPrivate(diagnostic);
  });
}
for (const result of [undefined, [], [null], artifacts().slice(0, 1), [{ ...artifacts()[0], byte_size: 0 }, artifacts()[1]], [{ ...artifacts()[0], sha256: privateMarker }, artifacts()[1]]]) {
  test('missing, malformed or unverified artifacts never become a successful receipt', async () => {
    assert.equal((await rejected(async () => Response.json(generated()), async () => result)).code, 'TASK_PROBE_ARTIFACT');
  });
}
test('compilation exceptions are classified without publishing source or path', async () => {
  const diagnostic = await rejected(async () => Response.json(generated()), async () => { throw new Error(privateMarker); });
  assert.equal(diagnostic.code, 'TASK_PROBE_ARTIFACT'); noPrivate(diagnostic);
});
test('invalid secret is rejected before the fetcher can run', async () => {
  let called = false;
  await assert.rejects(probeTaskTools('bad', async () => { called = true; }), /TASK_PROBE_SECRET/);
  assert.equal(called, false);
});
test('diagnostic serialization admits only exact fixed labels and bounded numeric statuses', () => {
  const error = Object.assign(new Error(privateMarker), { code: privateMarker, httpStatus: '401', serviceCode: privateMarker, responseKind: privateMarker, stack: privateMarker });
  assert.deepEqual(releaseFailureDiagnostic(error, privateMarker), { verified: false, phase: 'unknown', code: 'TASK_RELEASE_UNKNOWN' });
  for (const status of [-1, 99, 600, Infinity, NaN, 401.5]) assert.equal(releaseFailureDiagnostic({ httpStatus: status }, 'probe').httpStatus, undefined);
  assert.deepEqual(releaseFailureDiagnostic(Object.assign(new Error(privateMarker), { code: 'EACCES' }), 'manifest'), { verified: false, phase: 'manifest', code: 'TASK_RELEASE_IO', ioCode: 'EACCES' });
});
test('schema errors retain their fixed diagnostic and still fail closed', () => {
  assert.throws(() => checkTaskSchema('after', [{ success: true, results: [] }], { 'table:ai_workbench_tasks': 'CREATE TABLE ai_workbench_tasks(id TEXT)' }), error => {
    assert.equal(releaseFailureDiagnostic(error, 'after').code, 'TASK_SCHEMA_INCOMPLETE'); return true;
  });
});
test('CLI failure exits nonzero and saves a private, non-overwriting diagnostic receipt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oa-probe-diagnostic-'));
  try {
    const receiptPath = join(dir, 'model-probe.json'), failurePath = `${receiptPath}.failure.json`;
    await writeFile(receiptPath, 'existing successful receipt');
    const script = fileURLToPath(new URL('../scripts/oa-workbench-release.mjs', import.meta.url));
    const run = () => spawnSync(process.execPath, [script, 'probe', receiptPath], { encoding: 'utf8', timeout: 10000, env: { ...process.env, GITHUB_ACTIONS: 'false', PUBLIC_LAB_AI_SERVICE_TOKEN: privateMarker } });
    const first = run(); assert.equal(first.status, 1); assert.equal(first.stdout, '');
    assert.match(first.stderr, /OA_WORKBENCH_RELEASE_CHECK_FAILED .*TASK_PROBE_AUTHORIZATION/);
    noPrivate(first.stderr);
    const saved = await readFile(failurePath, 'utf8');
    assert.deepEqual(JSON.parse(saved), { verified: false, phase: 'probe', code: 'TASK_PROBE_AUTHORIZATION' });
    if (process.platform !== 'win32') assert.equal((await stat(failurePath)).mode & 0o777, 0o600);
    const second = run(); assert.equal(second.status, 1);
    assert.match(second.stderr, /OA_WORKBENCH_DIAGNOSTIC_RECEIPT_NOT_SAVED/);
    assert.equal(await readFile(failurePath, 'utf8'), saved);
    assert.equal(await readFile(receiptPath, 'utf8'), 'existing successful receipt');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

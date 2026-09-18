import assert from 'node:assert/strict';
import test from 'node:test';
import { taskFailureDiagnostic, sanitizeTaskDiagnostic } from '../lib/ai-workbench-diagnostics.mjs';
import { createTaskToolModel } from '../chat-cloudflare/src/task-tool-model.mjs';
import { handleOaChatBridge, signOaChatRequest, OA_CHAT_PATH } from '../chat-cloudflare/src/oa-chat-bridge.mjs';
import { encryptSecret } from '../chat-cloudflare/src/crypto.mjs';
import { PublicError } from '../chat-cloudflare/src/errors.mjs';
import { probeTaskTools, releaseFailureDiagnostic } from '../scripts/oa-workbench-release.mjs';

// Only synthetic keys, storage and HTTP replies. Production HMAC, encryption,
// tool execution, Word construction and release error parsing are exercised.
const secret = 's'.repeat(43);
const encryption = 'synthetic-encryption-key-not-for-production'.repeat(2);
const privateValue = 'PRIVATE_DIAGNOSTIC_SENTINEL';
const apiKey = `synthetic-key-${privateValue}`;
const task = { kind: 'document', title: '合成测试报告', instruction: '整理材料为报告', material: `接口联调完成，验收待补充。${privateValue}` };
const markdown = '# 合成测试报告\n\n合成材料中的接口联调已完成，实机验收尚未进行；负责人和日期待补充。';
const expected = (code, phase, more = {}) => ({ version: 1, phase, code, ...more });

async function fixture(t) {
  const logs = [];
  t.mock.method(console, 'error', (...args) => { logs.push(args); });
  const count = { calls: 0, budget: 0, claims: 0, config: 0, fallback: 0 };
  const seen = new Set();
  const config = { model: 'synthetic-test-model', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', encryptedKey: await encryptSecret(apiKey, encryption) };
  const engine = {
    claimRequest: async nonce => { count.claims++; if (seen.has(nonce)) throw new Error(privateValue); seen.add(nonce); },
    getModelConfig: async () => { count.config++; return config; },
    modelProvider: () => ({ provider: 'bailian' }),
    globalBudget: async () => { count.budget++; },
    workersAiCall: async () => { count.fallback++; throw new Error('unexpected fallback'); },
  };
  const runtime = { fetch: async () => {
    count.calls++;
    const fn = count.calls === 1
      ? { name: 'read_material', arguments: JSON.stringify({ from_line: 1, count: 10 }) }
      : { name: 'prepare_document', arguments: JSON.stringify({ markdown }) };
    return Response.json({ choices: [{ message: { role: 'assistant', content: null,
      tool_calls: [{ id: `call_${count.calls}`, type: 'function', function: fn }] }, finish_reason: 'tool_calls' }] });
  } };
  const handle = (url, init) => handleOaChatBridge({ request: new Request(url, init),
    env: { PUBLIC_LAB_AI_SERVICE_TOKEN: secret, APP_ENCRYPTION_KEY: encryption, AI: { run() {} } }, runtime }, engine);
  const send = async (payload = { operation: 'task', task }, overrides = {}, options = {}) => {
    const body = JSON.stringify(payload);
    return handle(`https://chat.omindos.ai${OA_CHAT_PATH}`, { method: 'POST', body,
      headers: { ...await signOaChatRequest(body, secret, options), ...overrides } });
  };
  const failure = async (diagnostic, response = null) => {
    response ??= await send();
    assert.equal(response.status, 503); // Existing clients keep their contract.
    const value = await response.json();
    assert.deepEqual(value, { error: '问答服务暂不可用，请稍后重试', diagnostic });
    assert.deepEqual(logs.at(-1), [`OA_TASK_FAILED ${JSON.stringify(diagnostic)}`]);
    assert.ok(!JSON.stringify([logs, value]).includes(privateValue));
    assert.equal(count.fallback, 0);
    return value;
  };
  return { logs, count, config, engine, runtime, handle, send, failure };
}

for (const status of [302, 400, 401, 403, 404, 429, 500, 503]) {
  test(`task diagnostic retains upstream HTTP ${status}, not the bridge 503`, async t => {
    const f = await fixture(t);
    f.runtime.fetch = async () => { f.count.calls++; return Response.json({ error: privateValue }, { status }); };
    await f.failure(expected('TASK_MODEL_HTTP', 'model_request', { upstreamStatus: status }));
    assert.equal(f.count.calls, 1); assert.equal(f.count.budget, 1);
  });
}
for (const [stage, mutate] of [
  ['request_claim', f => { f.engine.claimRequest = async () => { throw new Error(privateValue); }; }],
  ['config_read', f => { f.engine.getModelConfig = async () => { throw new Error(privateValue); }; }],
  ['endpoint_validation', f => { f.config.baseUrl = `https://example.invalid/${privateValue}`; }],
  ['key_decryption', f => { f.config.encryptedKey = privateValue; }],
]) {
  test(`unknown failure records only the ${stage} boundary`, async t => {
    const f = await fixture(t); mutate(f);
    await f.failure(expected('TASK_INTERNAL_ERROR', stage));
    assert.equal(f.count.calls, 0); assert.equal(f.count.budget, 0);
  });
}
test('invalid model configuration is distinct and performs no model request', async t => {
  const f = await fixture(t); f.config.model = '';
  await f.failure(expected('TASK_MODEL_CONFIG', 'model_configuration'));
  assert.equal(f.count.calls, 0);
});
test('actual application quota rejection is not a GitHub or provider billing claim', async t => {
  const f = await fixture(t);
  f.engine.globalBudget = async () => { f.count.budget++; throw new PublicError(privateValue, 429); };
  await f.failure(expected('TASK_BUDGET_EXHAUSTED', 'budget'));
  assert.equal(f.count.calls, 0); assert.equal(f.count.budget, 1);
});
for (const error of [new Error(privateValue), Object.assign(new Error(privateValue), { status: 429 }), new PublicError(privateValue, 503)]) {
  test('storage or untyped budget errors must not be reported as quota exhaustion', async t => {
    const f = await fixture(t); f.engine.globalBudget = async () => { throw error; };
    await f.failure(expected('TASK_BUDGET_UNAVAILABLE', 'budget'));
    assert.equal(f.count.calls, 0);
  });
}
for (const name of ['AbortError', 'TimeoutError']) {
  test(`${name} is retained without raw exception text or another call`, async t => {
    const f = await fixture(t);
    f.runtime.fetch = async () => { f.count.calls++; throw new DOMException(privateValue, name); };
    await f.failure(expected('TASK_TOOL_TIMEOUT', 'model_request'));
    assert.equal(f.count.calls, 1);
  });
}
test('network transport failure is not an upstream HTTP response', async t => {
  const f = await fixture(t); f.runtime.fetch = async () => { f.count.calls++; throw new TypeError(privateValue); };
  await f.failure(expected('TASK_MODEL_TRANSPORT', 'model_request'));
  assert.equal(f.count.calls, 1);
});
test('invalid upstream JSON remains a protocol failure', async t => {
  const f = await fixture(t); f.runtime.fetch = async () => { f.count.calls++; return new Response(privateValue, { headers: { 'content-type': 'application/json' } }); };
  await f.failure(expected('TASK_MODEL_PROTOCOL', 'model_request'));
});
test('model narrative is diagnosed but never accepted as a prepared artifact', async t => {
  const f = await fixture(t); f.runtime.fetch = async () => {
    f.count.calls++;
    return Response.json({ choices: [{ message: { role: 'assistant', content: '我已经交付成果。' }, finish_reason: 'stop' }] });
  };
  await f.failure(expected('TASK_NO_ARTIFACT', 'tool_execution'));
  assert.equal(f.count.calls, 1);
});
test('successful tasks still execute two tools and build a real Word artifact', async t => {
  const f = await fixture(t); const response = await f.send(); const value = await response.json();
  assert.equal(response.status, 200); assert.equal(value.answer, markdown);
  assert.equal(value.execution.state, 'prepared'); assert.equal(value.execution.modelCalls, 2);
  assert.deepEqual(value.execution.steps.map(step => step.tool), ['read_material', 'prepare_document']);
  assert.ok(value.execution.artifact.docxBytes > 500);
  assert.match(value.execution.artifact.docxSha256, /^[a-f0-9]{64}$/u);
  assert.equal(f.count.budget, 2); assert.equal(f.count.fallback, 0);
  assert.equal(value.diagnostic, undefined); assert.deepEqual(f.logs, []);
});
for (const headers of [{ authorization: 'bad' }, { origin: 'https://oa.omindos.ai' }, { cookie: 'private-cookie' }]) {
  test('unauthorized or browser requests cannot obtain diagnostics or reach a model', async t => {
    const f = await fixture(t); const response = await f.send(undefined, headers);
    assert.equal(response.status, 401); assert.equal((await response.json()).diagnostic, undefined);
    assert.equal(f.count.config, 0); assert.equal(f.count.calls, 0); assert.equal(f.count.budget, 0);
    assert.deepEqual(f.logs, []);
  });
}
test('malformed task remains rejected before diagnostics and execution', async t => {
  const f = await fixture(t); const response = await f.send({ operation: 'task', task: { ...task, tools: ['shell'] } });
  assert.equal(response.status, 400); assert.equal((await response.json()).diagnostic, undefined);
  assert.equal(f.count.claims, 0); assert.deepEqual(f.logs, []);
});
test('ordinary answer errors do not acquire private task diagnostics', async t => {
  const f = await fixture(t); f.engine.getModelConfig = async () => { throw new Error(privateValue); };
  const response = await f.send({ operation: 'answer', question: '测试问题', history: [], documents: [] });
  assert.deepEqual(await response.json(), { error: '问答服务暂不可用，请稍后重试' }); assert.deepEqual(f.logs, []);
});
test('nonce replay is still stopped before a second paid task', async t => {
  const f = await fixture(t); const nonce = crypto.randomUUID();
  assert.equal((await f.send(undefined, {}, { nonce })).status, 200);
  await f.failure(expected('TASK_INTERNAL_ERROR', 'request_claim'), await f.send(undefined, {}, { nonce }));
  assert.equal(f.count.calls, 2); assert.equal(f.count.budget, 2);
});

test('upstream HTTP error bodies are cancelled without reading or following redirects', async () => {
  let read = 0, cancelled = 0, calls = 0;
  const call = createTaskToolModel({ endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey, model: 'test', consumeBudget: async () => {}, fetcher: async (_url, init) => {
    calls++; assert.equal(init.redirect, 'manual');
    return { ok: false, status: 302, body: { getReader() { read++; throw new Error(privateValue); }, async cancel() { cancelled++; } } };
  } });
  await assert.rejects(call({ messages: [], tools: [], deadline: Date.now() + 1000 }), error => {
    assert.equal(error.message, 'TASK_MODEL_HTTP'); assert.equal(error.upstreamStatus, 302); return true;
  });
  assert.equal(calls, 1); assert.equal(read, 0); assert.equal(cancelled, 1);
});

test('diagnostics contain only closed labels, never arbitrary message suffixes', () => {
  const value = taskFailureDiagnostic(Object.assign(new Error(`TASK_MODEL_HTTP ${privateValue}`), { upstreamStatus: 401, stack: privateValue }), privateValue);
  assert.deepEqual(value, expected('TASK_INTERNAL_ERROR', 'unknown'));
});
for (const value of [null, [], 'text', { version: 2 }, { version: 1, code: privateValue, phase: 'budget' }, { version: 1, code: 'TASK_MODEL_HTTP', phase: privateValue }]) {
  test('unknown or malformed received diagnostics are ignored', () => { assert.equal(sanitizeTaskDiagnostic(value), null); });
}
for (const upstreamStatus of ['401', 0, 200, 600, 401.5, NaN, Infinity]) {
  test('invalid upstream status cannot enter a diagnostic', () => {
    assert.deepEqual(sanitizeTaskDiagnostic(expected('TASK_MODEL_HTTP', 'model_request', { upstreamStatus })), expected('TASK_MODEL_HTTP', 'model_request'));
  });
}
test('extra fields and toJSON cannot leak through a valid diagnostic', () => {
  const value = expected('TASK_MODEL_HTTP', 'model_request', { upstreamStatus: 401, message: privateValue, url: privateValue, toJSON: () => privateValue });
  assert.deepEqual(sanitizeTaskDiagnostic(value), expected('TASK_MODEL_HTTP', 'model_request', { upstreamStatus: 401 }));
});
test('non-HTTP failures cannot claim an upstream HTTP status', () => {
  assert.deepEqual(sanitizeTaskDiagnostic(expected('TASK_BUDGET_EXHAUSTED', 'budget', { upstreamStatus: 429 })), expected('TASK_BUDGET_EXHAUSTED', 'budget'));
});

test('signed release probe retains bridge diagnostics and still fails closed', async t => {
  const f = await fixture(t); let compiled = 0;
  f.runtime.fetch = async () => { f.count.calls++; return Response.json({ error: privateValue }, { status: 401 }); };
  await assert.rejects(probeTaskTools(secret, f.handle, async () => { compiled++; }), error => {
    assert.deepEqual(releaseFailureDiagnostic(error, 'probe'), {
      verified: false, phase: 'probe', code: 'TASK_PROBE_HTTP', httpStatus: 503,
      serviceCode: 'service_unavailable', responseKind: 'json',
      taskDiagnostic: expected('TASK_MODEL_HTTP', 'model_request', { upstreamStatus: 401 }),
    }); return true;
  });
  assert.equal(compiled, 0); assert.equal(f.count.calls, 1);
});
test('legacy Chat errors without diagnostics remain supported', async () => {
  await assert.rejects(probeTaskTools(secret, async () => Response.json({ error: '问答服务暂不可用，请稍后重试' }, { status: 503 })), error => {
    assert.deepEqual(releaseFailureDiagnostic(error, 'probe'), {
      verified: false, phase: 'probe', code: 'TASK_PROBE_HTTP', httpStatus: 503,
      serviceCode: 'service_unavailable', responseKind: 'json',
    }); return true;
  });
});
test('release failure receipts re-sanitize diagnostics instead of serializing arbitrary bodies', async () => {
  const dirty = expected('TASK_MODEL_HTTP', 'model_request', { upstreamStatus: 429, body: privateValue, headers: privateValue });
  await assert.rejects(probeTaskTools(secret, async () => Response.json({ error: privateValue, diagnostic: dirty }, { status: 503 })), error => {
    const value = releaseFailureDiagnostic(error, 'probe');
    assert.deepEqual(value.taskDiagnostic, expected('TASK_MODEL_HTTP', 'model_request', { upstreamStatus: 429 }));
    assert.ok(!JSON.stringify(value).includes(privateValue)); return true;
  });
});

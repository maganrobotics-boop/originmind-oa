import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createServerMaintenanceConversation } from '../integrations/server-maintenance/conversation.mjs';

const secret = 'test-maintenance-secret-'.repeat(3);
const config = { servers: { aliyun: { url: 'http://127.0.0.1:18893/v1/maintenance', secret }, tencent: { url: 'https://omindos.cn/_maintenance/v1', secret } } };
const session = { registered: true, status: 'active', ndaCompleted: true, isAdmin: true, user: { email: 'ADMIN@example.com' } };
const response = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const planId = 'a'.repeat(64);
const backendResponse = (data, url, action) => response({ ...data, server: url.startsWith('http://127.0.0.1:') ? 'aliyun' : 'tencent', action });
const request = (cookie = 'session=valid') => new Request('https://oa.omindos.cn/api/ai-members/conversations/ai-research/messages', { headers: cookie ? { cookie } : {} });
const status = { ok: true, timestamp: '2026-10-15T06:00:00.000Z', disk: { totalBytes: 50 * 2 ** 30, usedBytes: 40 * 2 ** 30, availableBytes: 10 * 2 ** 30, usedPercent: 80 }, memory: { totalBytes: 4 * 2 ** 30, availableBytes: 2 * 2 ** 30 }, cpu: { cores: 2, usedPercent: 10 }, load: [0.1, 0.2, 0.3], uptimeSeconds: 3600, services: { 'originmind-oa': 'active' } };
function fixture(overrides = {}) {
  const calls = [], sessions = [];
  const handler = createServerMaintenanceConversation({ port: 3000, config,
    sessionFetch: async (url, options) => { sessions.push({ url, options }); return response(session); },
    backendFetch: async (url, options) => {
      const body = JSON.parse(options.body); calls.push({ url, options, body });
      if (body.action === 'status') return backendResponse(status, url, body.action);
      if (body.action === 'plan') return backendResponse({ ok: true, planId, candidateCount: 2, candidateBytes: 2048, categories: [{ name: 'maintenance_tmp', count: 2, bytes: 2048 }] }, url, body.action);
      return backendResponse({ ok: true, deletedCount: 2, deletedBytes: 2048, skippedCount: 0, diskBefore: { availableBytes: 10 * 2 ** 30 }, diskAfter: { availableBytes: 10 * 2 ** 30 + 2048 } }, url, body.action);
    }, ...overrides });
  return { handler, calls, sessions };
}

test('unrelated questions leave the existing research conversation untouched', async () => {
  const { handler, calls, sessions } = fixture();
  assert.equal(await handler(request(), '请查询我的周报和采购记录'), null);
  assert.equal(await handler(request(), '什么是CPU？'), null);
  assert.equal(await handler(request(), '服务器'.repeat(1000)), null);
  assert.equal(calls.length + sessions.length, 0);
});
test('requires a cookie and a current authenticated administrator with NDA admission', async () => {
  const f = fixture();
  assert.match((await f.handler(request(''), '查两个服务器空间')).answer, /仅向已登录/);
  assert.equal(f.calls.length, 0);
  for (const invalid of [{ ...session, isAdmin: false }, { ...session, ndaCompleted: false }, { ...session, registered: false }, { ...session, status: 'departed' }, { ...session, user: {} }]) {
    const g = fixture({ sessionFetch: async () => response(invalid) });
    assert.match((await g.handler(request(), '查两个服务器空间')).answer, /没有此权限/);
    assert.equal(g.calls.length, 0);
  }
  const broken = fixture({ sessionFetch: async () => { throw new Error('private failure'); } });
  assert.match((await broken.handler(request(), '查两个服务器空间')).answer, /会话验证失败/);
});
test('fixed loopback session verification ignores supplied identity headers', async () => {
  const f = fixture();
  await f.handler(new Request('https://evil.invalid/', { headers: { cookie: 'session=valid', 'x-forwarded-host': 'evil.invalid', authorization: 'Admin false' } }), '查阿里云空间');
  assert.equal(f.sessions[0].url, 'http://127.0.0.1:3000/api/session');
  assert.equal(f.sessions[0].options.headers.host, 'oa.omindos.cn');
  assert.equal(f.sessions[0].options.headers['x-forwarded-host'], 'oa.omindos.cn');
  assert.equal(f.sessions[0].options.headers.authorization, undefined);
  assert.equal(f.sessions[0].options.redirect, 'error');
});
test('queries both servers, signs each exact request, and formats verified status in Chinese', async () => {
  const f = fixture(), result = await f.handler(request(), '查询两个服务器磁盘、内存、CPU和服务状态');
  assert.equal(result.mode, 'server_maintenance');
  assert.match(result.answer, /阿里云[\s\S]*50.00 GiB[\s\S]*腾讯云/);
  assert.match(result.answer, /2026\/10\/15 14:00:00（北京时间）/);
  assert.match(result.answer, /originmind-oa：active/);
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) {
    assert.equal(call.body.actor, createHash('sha256').update('admin@example.com').digest('hex'));
    const headers = call.options.headers;
    assert.equal(headers.authorization, `Maintenance-HMAC ${createHmac('sha256', secret).update(`${headers['x-maintenance-time']}\n${headers['x-maintenance-nonce']}\n${call.options.body}`).digest('hex')}`);
    assert.equal(call.options.redirect, 'error');
    assert.equal(headers.cookie, undefined);
  }
});
test('denies SSRF configuration before sending backend requests', async () => {
  const f = fixture({ config: { servers: { aliyun: { url: 'http://169.254.169.254/latest/meta-data', secret } } } });
  assert.match((await f.handler(request(), '查阿里云磁盘空间')).answer, /连接配置无效/);
  assert.equal(f.calls.length, 0);
});
test('cleanup questions and quoted or combined commands only preview, negation never cleans', async () => {
  for (const question of ['可以清理两个服务器吗？', '怎么清理腾讯云临时文件', '“清理两个服务器的临时文件”', '清理阿里云临时文件；重启服务', '清理腾讯云 /tmp 文件', '清理两个服务器的临时文件吗？']) {
    const f = fixture(), result = await f.handler(request(), question);
    assert.match(result.answer, /清理预览/);
    assert.ok(f.calls.every(call => call.body.action === 'plan'));
  }
  for (const question of ['不要清理两个服务器的临时文件', '别清理腾讯云缓存', '取消清理阿里云临时文件']) {
    const f = fixture(); assert.match((await f.handler(request(), question)).answer, /未执行清理/); assert.equal(f.calls.length, 0);
  }
});
test('explicit current cleanup command plans then cleans both servers with bound plan IDs', async () => {
  const f = fixture(), result = await f.handler(request(), '清理两个服务器的临时文件');
  assert.match(result.answer, /实际删除 2 项/);
  assert.equal(f.calls.length, 4);
  for (const url of Object.values(config.servers).map(v => v.url)) {
    const calls = f.calls.filter(c => c.url === url);
    assert.deepEqual(calls.map(c => c.body.action), ['plan', 'clean']);
    assert.equal(calls[1].body.planId, planId);
  }
  const g = fixture(); await g.handler(request(), '请清理阿里云临时文件');
  assert.deepEqual(g.calls.map(c => c.body.action), ['plan', 'clean']);
});
test('reports each unavailable server separately and never invents cleanup success', async () => {
  const f = fixture({ backendFetch: async (url) => { if (url.startsWith('https:')) throw new Error('secret network error'); return backendResponse(status, url, 'status'); } });
  const result = await f.handler(request(), '查两个服务器空间');
  assert.match(result.answer, /阿里云[\s\S]*50.00 GiB[\s\S]*腾讯云：维护查询或操作未确认完成/);
  assert.doesNotMatch(result.answer, /secret network/);
  const g = fixture({ backendFetch: async () => response({ planId: 'bad' }) });
  assert.doesNotMatch((await g.handler(request(), '清理两个服务器的临时文件')).answer, /已完成/);
});
test('rejects redirected or oversized backend responses', async () => {
  for (const backendFetch of [async () => new Response(null, { status: 302, headers: { location: 'https://evil.invalid' } }), async () => response({ value: 'x'.repeat(33 * 1024) })]) {
    const f = fixture({ backendFetch });
    assert.match((await f.handler(request(), '查腾讯云空间')).answer, /当前不可用/);
  }
});

test('native session verification uses a real bounded loopback request', async () => {
  const seen = [];
  const server = createServer((incoming, outgoing) => {
    seen.push({ url: incoming.url, headers: incoming.headers });
    outgoing.writeHead(200, { 'content-type': 'application/json' }); outgoing.end(JSON.stringify(session));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const handler = createServerMaintenanceConversation({ port: server.address().port, config, backendFetch: async url => backendResponse(status, url, 'status') });
    assert.match((await handler(request(), '查阿里云空间')).answer, /50.00 GiB/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, '/api/session');
    assert.equal(seen[0].headers.cookie, 'session=valid');
    assert.equal(seen[0].headers.host, 'oa.omindos.cn');
    assert.equal(seen[0].headers['x-forwarded-proto'], 'https');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('native maintenance client posts signed requests without cookies or redirects', async t => {
  const seen = [];
  const server = createServer((incoming, outgoing) => {
    const chunks = [];
    incoming.on('data', chunk => chunks.push(chunk));
    incoming.on('end', () => {
      seen.push({ url: incoming.url, headers: incoming.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      outgoing.writeHead(200, { 'content-type': 'application/json' }); outgoing.end(JSON.stringify({ ...status, server: 'aliyun', action: 'status' }));
    });
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(18893, '127.0.0.1', resolve); });
  } catch (error) { if (error.code === 'EADDRINUSE') { t.skip('fixed maintenance port is already in use'); return; } throw error; }
  try {
    const handler = createServerMaintenanceConversation({ port: 3000, config, sessionFetch: async () => response(session) });
    assert.match((await handler(request(), '查阿里云空间')).answer, /50.00 GiB/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, '/v1/maintenance');
    assert.equal(seen[0].body.action, 'status');
    assert.match(seen[0].headers.authorization, /^Maintenance-HMAC [a-f0-9]{64}$/);
    assert.equal(seen[0].headers.cookie, undefined);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('malformed success receipts cannot produce a completed cleanup claim', async () => {
  const f = fixture({ backendFetch: async (url, options) => {
    const action = JSON.parse(options.body).action;
    return backendResponse(action === 'plan' ? { ok: true, planId } : { ok: true }, url, action);
  } });
  assert.doesNotMatch((await f.handler(request(), '清理两个服务器的临时文件')).answer, /已完成限定临时文件清理/);
});

test('binds every backend receipt to the requested server and action', async () => {
  for (const wrong of [{ server: 'tencent', action: 'status' }, { server: 'aliyun', action: 'clean' }]) {
    const f = fixture({ backendFetch: async () => response({ ...status, ...wrong }) });
    assert.match((await f.handler(request(), '查阿里云空间')).answer, /当前不可用/);
  }
  const f = fixture({ backendFetch: async (url) => backendResponse({ ok: true, planId: 'short-plan' }, url, 'plan') });
  assert.doesNotMatch((await f.handler(request(), '请清理阿里云临时文件')).answer, /已完成限定临时文件清理/);
});

test('uses collected time and CPU core count and presents category labels in Chinese', async () => {
  const f = fixture({ backendFetch: async url => backendResponse({ ...status, timestamp: undefined, collectedAt: '2026-10-15T07:00:00.000Z', cpu: undefined, cpuCount: 4 }, url, 'status') });
  const result = await f.handler(request(), '查阿里云状态');
  assert.match(result.answer, /15:00:00（北京时间）/);
  assert.match(result.answer, /CPU：4 核；负载/);
  const g = fixture(), plan = await g.handler(request(), '预览阿里云清理');
  assert.match(plan.answer, /维护临时文件 2 项/);
  assert.doesNotMatch(plan.answer, /maintenance_tmp/);
});

test('limits each administrator to ten queries and two cleanups per minute', async () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) assert.match((await f.handler(request(), '查阿里云空间')).answer, /50.00 GiB/);
  assert.match((await f.handler(request(), '查阿里云空间')).answer, /过于频繁/);
  assert.equal(f.calls.length, 10);
  const g = fixture();
  for (let i = 0; i < 2; i++) assert.match((await g.handler(request(), '请清理阿里云临时文件')).answer, /已完成限定/);
  assert.match((await g.handler(request(), '请清理阿里云临时文件')).answer, /过于频繁/);
  assert.equal(g.calls.length, 4);
});

test('prevents concurrent maintenance commands for the same administrator', async () => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  let backendCalls = 0;
  const f = fixture({ backendFetch: async url => { backendCalls += 1; started(); await blocked; return backendResponse(status, url, 'status'); } });
  const first = f.handler(request(), '查阿里云空间'); await ready;
  const second = await f.handler(request(), '请清理阿里云临时文件');
  assert.match(second.answer, /已有一项服务器维护/);
  assert.equal(backendCalls, 1);
  release(); assert.match((await first).answer, /50.00 GiB/);
});

test('reads only small root-owned protected regular configuration files', async t => {
  if (process.getuid?.() !== 0) { t.skip('root ownership configuration contract requires a root test process'); return; }
  const dir = await mkdtemp(join(tmpdir(), 'maintenance-config-'));
  try {
    const path = join(dir, 'client.json'), link = join(dir, 'link.json');
    await writeFile(path, JSON.stringify(config), { mode: 0o640 });
    const options = { port: 3000, configPath: path, sessionFetch: async () => response(session), backendFetch: async url => backendResponse(status, url, 'status') };
    assert.match((await createServerMaintenanceConversation(options)(request(), '查阿里云空间')).answer, /50.00 GiB/);
    await chmod(path, 0o644);
    assert.match((await createServerMaintenanceConversation(options)(request(), '查阿里云空间')).answer, /配置不可读取/);
    await chmod(path, 0o640); await symlink(path, link);
    assert.match((await createServerMaintenanceConversation({ ...options, configPath: link })(request(), '查阿里云空间')).answer, /配置不可读取/);
    await writeFile(path, 'x'.repeat(33 * 1024));
    assert.match((await createServerMaintenanceConversation(options)(request(), '查阿里云空间')).answer, /配置不可读取/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

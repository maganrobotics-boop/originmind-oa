// Real honor APIs and SQLite on a loopback-only server; all identities and new
// historical awards are synthetic. No production service or model is contacted.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { handleRequest } from '../src/app.mjs';
import { routeStaticRequest } from '../src/static-router.mjs';
import { sha256Hex } from '../src/crypto.mjs';
import { D1DatabaseAdapter } from '../test/d1-adapter.mjs';

if (!process.env.PLAYWRIGHT_MODULE) throw Error('Set PLAYWRIGHT_MODULE');
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const root = fileURLToPath(new URL('../public/', import.meta.url));
const output = resolve(process.env.BROWSER_REPORT_DIR || 'learning-honors-browser-report');
await mkdir(output, { recursive: true });
const canonical = 'https://honors.example.test';
const db = new D1DatabaseAdapter();
const fixtures = {
  admin: { cookie: `__Host-ma-session=${'a'.repeat(64)}` },
  cui: { email: 'synthetic-cui@stumail.sztu.edu.cn', name: '崔航阁', token: 'b'.repeat(64) },
  liu: { email: 'synthetic-liu@stumail.sztu.edu.cn', name: '刘奕鹏', token: 'c'.repeat(64) },
  qiu: { email: 'synthetic-qiu@stumail.sztu.edu.cn', name: '邱衡', token: 'd'.repeat(64) },
  other: { email: 'synthetic-nonwinner@stumail.sztu.edu.cn', name: '测试同学', token: 'e'.repeat(64) },
};
db.sqlite.prepare('INSERT INTO sessions(hash,expires) VALUES(?,?)').run(await sha256Hex('a'.repeat(64)), Date.now() + 3600000);
for (const fixture of Object.values(fixtures).filter(value => value.email)) {
  fixture.cookie = `__Host-om-chat-session=${fixture.token}`;
  db.sqlite.prepare('INSERT INTO visitor_sessions(hash,email,role,created_at,expires_at) VALUES(?,?,?,?,?)')
    .run(await sha256Hex(fixture.token), fixture.email, 'student', Date.now(), Date.now() + 3600000);
  db.sqlite.prepare('INSERT INTO newbie_profiles(email,display_name,created_at,updated_at) VALUES(?,?,?,?)')
    .run(fixture.email, fixture.name, Date.now(), Date.now());
}
const env = { DB: db, APP_ORIGIN: canonical, ADMIN_EMAIL: 'synthetic-admin@example.test',
  APP_ENCRYPTION_KEY: 'synthetic-key'.padEnd(48, 'e'), RATE_LIMIT_HMAC_KEY: 'synthetic-hmac'.padEnd(48, 'r'),
  ASSETS: { async fetch(request) {
    const filename = resolve(root, '.' + new URL(request.url).pathname);
    if (!filename.startsWith(resolve(root) + sep)) return new Response('not found', { status: 404 });
    try {
      return new Response(await readFile(filename), { headers: { 'Content-Type': ({
        '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8',
        '.mjs': 'text/javascript;charset=utf-8', '.css': 'text/css;charset=utf-8', '.svg': 'image/svg+xml',
      })[extname(filename)] || 'application/octet-stream' } });
    } catch { return new Response('not found', { status: 404 }); }
  } },
};
let origin;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, canonical);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
    // Test-only session injection lives solely in this loopback test server.
    const fixture = fixtures[req.headers['x-honors-test-role']];
    headers.set('Cookie', fixture?.cookie || '');
    if (headers.get('Origin') === origin) headers.set('Origin', canonical);
    const request = new Request(url, { method: req.method, headers, ...(body.length ? { body } : {}) });
    let response;
    if (url.pathname === '/__qa_font.woff2' && process.env.QA_CJK_FONT) {
      response = new Response(await readFile(process.env.QA_CJK_FONT), { headers: { 'Content-Type': 'font/woff2' } });
    } else if (url.pathname === '/api/newbie/dashboard') {
      // Isolate unrelated NDA/OA calls while exercising the actual profile UI.
      response = fixture?.email ? Response.json({
        user: { email: fixture.email, role: 'student', roleLabel: '学生' }, agreement: { approved: true },
        profile: { displayName: fixture.name, grade: '', major: '', direction: 'undecided', bio: '' },
        tasks: [], progress: { completed: 0, total: 7 },
      }) : Response.json({ error: '请先登录。' }, { status: 401 });
    } else response = await routeStaticRequest(request, env) || await handleRequest(request, env, {}, {
      fetch: () => { throw Error('External request forbidden in honor QA'); },
    });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { res.writeHead(500); res.end(error.message); }
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
  ...(process.env.PLAYWRIGHT_ARGS_JSON ? { args: JSON.parse(process.env.PLAYWRIGHT_ARGS_JSON) } : {}),
});
const assertions = [];
const contexts = [];
function passed(message) { assertions.push(message); console.log(`PASS ${message}`); }
async function context(role, viewport) {
  const result = await browser.newContext({ viewport, extraHTTPHeaders: { 'X-Honors-Test-Role': role } });
  result.setDefaultTimeout(15000);
  contexts.push(result);
  await result.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  if (process.env.QA_CJK_FONT) await result.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = '@font-face{font-family:"Microsoft YaHei";src:url("/__qa_font.woff2") format("woff2");font-weight:100 900;font-display:block;}';
      document.head.append(style);
    });
  });
  return result;
}
async function noOverflow(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
}
async function api(path, data, role = 'admin') {
  const response = await fetch(origin + path, { method: data ? 'POST' : 'GET',
    headers: { 'X-Honors-Test-Role': role, ...(data ? { 'Content-Type': 'application/json', Origin: origin } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}) });
  assert.ok(response.ok, `${path}: ${response.status}`); return response.json();
}

try {
  for (const [label, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }], ['small-mobile', { width: 320, height: 740 }]]) {
    const session = await context('guest', viewport); const page = await session.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/learning/honors');
    await page.locator('#honors-list .honors-card').first().waitFor();
    assert.equal(await page.locator('.honors-card').count(), 3);
    for (const name of ['崔航阁', '刘奕鹏', '邱衡']) assert.ok(await page.getByRole('heading', { name, exact: true }).isVisible());
    assert.doesNotMatch(await page.locator('body').innerText(), /synthetic-cui@|source_reference|账户核验/);
    await noOverflow(page);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: resolve(output, `honors-${label}.png`), fullPage: true });
    await page.getByRole('button', { name: '竞赛获奖', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '竞赛获奖', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.getByText('当前类别暂无公开荣誉。', { exact: true }).waitFor();
    assert.equal(await page.locator('.honors-card').count(), 0);
    await page.getByRole('button', { name: '新手村通关', exact: true }).click();
    await page.locator('.honors-card').first().waitFor();
    assert.equal(await page.locator('.honors-card').count(), 3);
    assert.deepEqual(errors, []); passed(`${label}: public awards, category filter, empty state, no overflow or script errors`);
    await session.close();
  }

  // Management moved to OA Future Stars on main. Verify the actual redirect
  // and operate only synthetic fixtures through the retained authenticated API.
  const moved = await fetch(origin + '/learning/honors/admin', { redirect: 'manual' });
  assert.equal(moved.status, 302);
  assert.equal(moved.headers.get('location'), 'https://oa.omindos.cn/#future-stars');
  assert.equal(moved.headers.get('cache-control'), 'no-store');
  const denied = await fetch(origin + '/api/admin/honors', { headers: { 'X-Honors-Test-Role': 'other' } });
  assert.equal(denied.status, 403);
  passed('management redirects to OA Future Stars; ordinary members cannot read private admin records');
  for (const [index, role] of [[1, 'cui'], [2, 'liu'], [3, 'qiu']]) {
    await api(`/api/admin/honors/newbie-20261004-${index}/action`, { action: 'bind', version: 1,
      recipientEmail: fixtures[role].email, confirmed: true, note: '合成测试：核验后关联账户。' });
  }
  for (const role of ['cui', 'liu', 'qiu', 'other', 'guest']) {
    const session = await context(role, { width: 390, height: 844 }); const page = await session.newPage();
    await page.goto(origin + '/newbie-village#profile');
    const target = page.locator('.personal-honors');
    await target.getByRole('heading', { name: '我的荣誉' }).waitFor();
    if (['cui', 'liu', 'qiu'].includes(role)) {
      await target.locator('.honors-card').waitFor();
      assert.equal(await target.locator('.honors-card').count(), 1);
      assert.equal(await target.getByRole('heading', { name: fixtures[role].name, exact: true }).isVisible(), true);
      assert.equal(await page.locator('.progress-number').innerText(), '0');
      await noOverflow(page);
      if (role === 'cui') await page.screenshot({ path: resolve(output, 'personal-trophy-mobile.png'), fullPage: true });
    } else {
      await target.getByText(role === 'guest' ? '登录后可查看管理员授予的个人奖杯。' : '暂未授予荣誉。', { exact: true }).waitFor();
      assert.equal(await target.locator('.honors-card').count(), 0);
    }
    passed(`${role}: only entitled private trophy; existing course progress remains unchanged`);
    await session.close();
  }
  // Keep one private response in flight, then switch the rendered account to a
  // guest. The late response must not resurrect another account's trophy.
  const raceContext = await context('cui', { width: 390, height: 844 }); const race = await raceContext.newPage();
  let release; const barrier = new Promise(resolveBarrier => { release = resolveBarrier; });
  let requested; const requestStarted = new Promise(resolveRequest => { requested = resolveRequest; });
  await race.route('**/api/learning/my-honors', async route => {
    const response = await route.fetch(); requested(); await barrier;
    await route.fulfill({ response });
  });
  await race.goto(origin + '/newbie-village#profile'); await requestStarted;
  await race.evaluate(() => {
    const target = document.querySelector('.personal-honors'); target.dataset.account = '';
    target.dispatchEvent(new Event('honors-account-change'));
  });
  release();
  await race.locator('.personal-honors').getByText('登录后可查看管理员授予的个人奖杯。').waitFor();
  await race.waitForLoadState('networkidle');
  assert.equal(await race.locator('.personal-honors .honors-card').count(), 0);
  passed('late private response after an account change is discarded');

  // Exercise visibility and its private audit trail against the real handler.
  // OA's management UI has separate Future Stars browser coverage.
  const honorPath = '/api/admin/honors/newbie-20261004-1';
  await api(honorPath + '/action', { action: 'hide', version: 2, note: '合成测试：仅本人可见。' });
  assert.equal((await api('/api/learning/honors', undefined, 'guest')).awards.some(a => a.id === 'newbie-20261004-1'), false);
  assert.equal((await api('/api/learning/my-honors', undefined, 'cui')).awards[0].visibility, 'hidden');
  await api(honorPath + '/action', { action: 'show', version: 3, note: '合成测试：恢复公开。' });
  assert.equal((await api('/api/learning/honors', undefined, 'guest')).awards.some(a => a.id === 'newbie-20261004-1'), true);
  await api(honorPath + '/action', { action: 'revoke', version: 4, note: '合成测试：撤回。' });
  assert.equal((await api('/api/learning/my-honors', undefined, 'cui')).awards.length, 0);
  const events = (await api(honorPath + '/events')).events;
  assert.equal(events.length, 5);
  assert.deepEqual(events.map(event => event.action).sort(), ['bind', 'hide', 'import', 'revoke', 'show']);
  passed('real honor API protects hidden/private awards, restoration, revocation and audit history');
  const insert = db.sqlite.prepare("INSERT INTO learning_honors(id,recipient_name,category,title,source_kind,source_reference,granted_by,granted_at,updated_at) VALUES(?,'分页测试同学','competition','合成测试荣誉','reference','TEST','synthetic-test',?,1)");
  for (let i = 0; i < 28; i++) insert.run(`browser-pagination-${i}`, Date.now() + i);
  const linkedContext = await context('guest', { width: 390, height: 844 }); const linked = await linkedContext.newPage();
  await linked.goto(origin + '/learning/honors#newbie-20261004-2');
  await linked.locator('#newbie-20261004-2').waitFor();
  assert.equal(await linked.locator('.honors-card').count(), 25);
  await linked.getByRole('button', { name: '查看更多' }).click();
  await linked.getByText('已展示 30 份荣誉 · 按授予时间展示', { exact: true }).waitFor();
  assert.equal(await linked.locator('#newbie-20261004-2').count(), 1);
  passed('a shared link locates an older honor beyond the first page without duplicating it during pagination');
  console.log(JSON.stringify({ checks: assertions.length, result: 'passed', screenshots: output }));
} finally {
  await Promise.allSettled(contexts.map(value => value.close()));
  await browser.close(); db.close(); await new Promise(resolveClose => server.close(resolveClose));
}

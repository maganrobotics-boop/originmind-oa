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

  const adminContext = await context('admin', { width: 1280, height: 900 });
  const admin = await adminContext.newPage(); const adminErrors = [];
  admin.on('pageerror', error => adminErrors.push(error.message));
  await admin.goto(origin + '/learning/honors/admin');
  await admin.locator('#honors-admin-list .honors-card').first().waitFor();
  assert.equal(await admin.locator('#honors-admin-list .honors-card').count(), 3);
  assert.equal(await admin.locator('#honors-grant-form').isVisible(), false);
  const first = admin.locator('#honors-admin-list .honors-card').filter({ has: admin.getByRole('heading', { name: '崔航阁 · 新手村通关 · 机器人探索者' }) });
  await first.getByRole('button', { name: '绑定账户', exact: true }).click();
  const bind = admin.locator('#honors-action-dialog');
  await bind.getByRole('button', { name: '查询账户' }).click();
  await bind.getByText('请核对真实身份后手动选择；同名账户需进一步确认。').waitFor();
  assert.equal(await bind.locator('[name="recipientEmail"]').inputValue(), '');
  await bind.getByLabel('选择已核对的账户').selectOption(fixtures.cui.email);
  await bind.getByLabel('我已人工确认该账户属于此获奖人。').check();
  await bind.getByLabel('操作说明（仅管理员可见）').fill('合成浏览器测试：核对测试账户与通关人身份。');
  await bind.getByRole('button', { name: '确认操作' }).click();
  await bind.waitFor({ state: 'hidden' });
  if (!await admin.locator('#honors-admin-app').isVisible()) {
    throw Error(`Admin unexpectedly returned to login: ${await admin.locator('#honors-login-status').innerText()}`);
  }
  await admin.getByText('已读取 3 条记录', { exact: true }).waitFor();
  assert.ok((await first.locator('.honors-private').innerText()).includes(fixtures.cui.email));
  passed('administrator searches and explicitly binds an account; no automatic selection');
  for (const [index, role] of [[2, 'liu'], [3, 'qiu']]) {
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

  // Historical grant through the real admin form, with manual provenance.
  const form = admin.locator('#honors-grant-form');
  await admin.getByRole('button', { name: '补录历史荣誉', exact: true }).click();
  assert.equal(await admin.locator('#honors-grant-toggle').getAttribute('aria-expanded'), 'true');
  await form.getByLabel('获奖人姓名').fill('历史测试同学');
  await form.getByRole('button', { name: '收起表单', exact: true }).click();
  assert.equal(await form.isVisible(), false);
  await admin.getByRole('button', { name: '补录历史荣誉', exact: true }).click();
  assert.equal(await form.getByLabel('获奖人姓名').inputValue(), '历史测试同学');
  await form.getByLabel('获奖人姓名').fill('历史测试同学');
  await form.getByLabel('荣誉类别').selectOption('alumni');
  await form.getByLabel('荣誉名称').fill('毕业纪念 · 合成测试');
  await form.getByLabel('公开事迹说明').fill('历史毕业项目，合成测试记录。');
  await form.getByLabel('事迹日期（未知可留空）').fill('2020-06-30');
  await form.getByLabel('确认依据（仅管理员可见）').fill('合成测试毕业项目归档 TEST-2020；仅用于隔离浏览器验证。');
  await form.getByLabel('我已核对荣誉事实与来源；如关联账户，已确认该账户属于获奖人。').check();
  await form.getByRole('button', { name: '确认授予' }).click();
  await admin.getByText('荣誉已保存。', { exact: true }).waitFor();
  assert.equal(await form.isVisible(), false);
  assert.equal(await admin.locator('#honors-grant-toggle').getAttribute('aria-expanded'), 'false');
  const alumni = admin.locator('#honors-admin-list .honors-card').filter({ has: admin.getByRole('heading', { name: '历史测试同学 · 毕业纪念 · 合成测试' }) });
  await alumni.waitFor(); assert.ok(await alumni.getByText('事迹日期：2020-06-30', { exact: false }).isVisible());
  passed('historical grant through the form records separate achievement and grant dates without requiring an account');

  await admin.getByLabel('记录状态').selectOption('public');
  await first.getByRole('button', { name: '隐藏公开展示', exact: true }).click();
  await bind.getByLabel('操作说明（仅管理员可见）').fill('合成测试：仅本人展示。');
  await bind.getByRole('button', { name: '确认操作' }).click(); await bind.waitFor({ state: 'hidden' });
  const publicAwards = (await api('/api/learning/honors', undefined, 'guest')).awards;
  assert.equal(publicAwards.some(award => award.id === 'newbie-20261004-1'), false);
  const hiddenMine = (await api('/api/learning/my-honors', undefined, 'cui')).awards;
  assert.equal(hiddenMine[0].visibility, 'hidden');
  await admin.getByLabel('记录状态').selectOption('hidden'); await first.waitFor();
  await first.getByRole('button', { name: '恢复公开展示', exact: true }).click();
  await bind.getByLabel('操作说明（仅管理员可见）').fill('合成测试：恢复公开。');
  await bind.getByRole('button', { name: '确认操作' }).click(); await bind.waitFor({ state: 'hidden' });
  await admin.getByLabel('记录状态').selectOption('public'); await first.waitFor();
  await first.getByRole('button', { name: '撤回荣誉', exact: true }).click();
  await bind.getByLabel('操作说明（仅管理员可见）').fill('合成测试：撤回，无生产数据。');
  await bind.getByRole('button', { name: '确认操作' }).click(); await bind.waitFor({ state: 'hidden' });
  assert.equal((await api('/api/learning/my-honors', undefined, 'cui')).awards.length, 0);
  await admin.getByLabel('记录状态').selectOption('revoked'); await first.waitFor();
  assert.equal(await first.getByRole('button', { name: '恢复公开展示', exact: true }).count(), 0);
  await first.getByRole('button', { name: '查看来源与操作记录' }).click();
  await admin.locator('#honors-audit-list .honors-audit-item').first().waitFor();
  assert.ok((await admin.locator('#honors-audit-list').innerText()).includes('马淦于2026-10-04明确确认'));
  assert.equal(await admin.locator('#honors-audit-list .honors-audit-item').count(), 5);
  await admin.locator('#honors-audit-dialog').getByRole('button', { name: '关闭', exact: true }).click();
  passed('hide, restore, revoke and preserved private audit trail through the real admin UI');
  await noOverflow(admin); assert.deepEqual(adminErrors, []);
  await admin.setViewportSize({ width: 320, height: 740 }); await noOverflow(admin);
  await admin.screenshot({ path: resolve(output, 'honors-admin-mobile.png'), fullPage: true });
  await admin.getByRole('button', { name: '补录历史荣誉', exact: true }).click();
  await noOverflow(admin);
  await admin.screenshot({ path: resolve(output, 'honors-grant-mobile.png'), fullPage: true });
  await form.getByRole('button', { name: '收起表单', exact: true }).click();
  passed('admin responsive layout at 320px, with no script errors');

  const member = await context('other', { width: 390, height: 844 }); const denied = await member.newPage();
  await denied.goto(origin + '/learning/honors/admin');
  await denied.locator('#honors-login-status').getByText('仅管理员可执行此操作', { exact: true }).waitFor();
  assert.equal(await denied.locator('#honors-admin-app').isVisible(), false);
  assert.equal(await denied.locator('#honors-admin-list .honors-card').count(), 0);
  passed('ordinary member sees no management records or provenance');
  await admin.getByRole('button', { name: '退出管理', exact: true }).click();
  await admin.locator('#honors-login').waitFor();
  assert.equal(await admin.locator('#honors-admin-list .honors-card').count(), 0);
  passed('admin logout clears rendered private records');
  const insert = db.sqlite.prepare("INSERT INTO learning_honors(id,recipient_name,category,title,source_kind,source_reference,granted_by,granted_at,updated_at) VALUES(?,'分页测试同学','competition','合成测试荣誉','reference','TEST','synthetic-test',?,1)");
  for (let i = 0; i < 28; i++) insert.run(`browser-pagination-${i}`, Date.now() + i);
  const linkedContext = await context('guest', { width: 390, height: 844 }); const linked = await linkedContext.newPage();
  await linked.goto(origin + '/learning/honors#newbie-20261004-2');
  await linked.locator('#newbie-20261004-2').waitFor();
  assert.equal(await linked.locator('.honors-card').count(), 25);
  await linked.getByRole('button', { name: '查看更多' }).click();
  await linked.getByText('已展示 31 份荣誉 · 按授予时间展示', { exact: true }).waitFor();
  assert.equal(await linked.locator('#newbie-20261004-2').count(), 1);
  passed('a shared link locates an older honor beyond the first page without duplicating it during pagination');
  console.log(JSON.stringify({ checks: assertions.length, result: 'passed', screenshots: output }));
} finally {
  await Promise.allSettled(contexts.map(value => value.close()));
  await browser.close(); db.close(); await new Promise(resolveClose => server.close(resolveClose));
}

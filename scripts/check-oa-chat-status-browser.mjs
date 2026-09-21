// Real OA UI with synthetic replies. Never access production or send member messages.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const root = resolve('parity-validation/browser-app');
const output = resolve('parity-validation/chat-status-report');
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const file = resolve(root, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
    if (!file.startsWith(root + sep)) throw Error('Invalid path');
    res.setHeader('content-type', ({ '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' })[extname(file)] || 'application/octet-stream');
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
const results = [];
const healthy = { authorized: true, bridgeReady: true, modelReady: true, budgetReady: true, knowledgeReady: true, retrievalReady: true };
const complete = { answer: '这是本次完整的测试回答。', mode: 'ai', citations: [], images: [] };
try {
  for (const [name, width, height] of [['desktop', 1280, 900], ['mobile', 390, 640]]) {
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [], writes = [], held = [];
    let reply = complete, httpStatus = 200, hold = false;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (request.method() !== 'GET') writes.push(url.pathname);
      if (url.pathname === '/api/lab-ai/ask') {
        if (hold) { held.push(route); return; }
        return route.fulfill({ status: httpStatus, json: reply });
      }
      const data = url.pathname === '/api/session' ? { registered: true, status: 'active', user: { email: 'status@example.test', displayName: '状态测试成员', authProvider: 'github' }, role: 'project_owner', isAdmin: true, canReviewKnowledge: true, canReviewMembers: true, ndaCompleted: true, needsNda: false }
        : url.pathname === '/api/lab-ai/status' ? healthy
        : url.pathname === '/api/approvals' ? { approvals: [] }
        : url.pathname === '/api/members' ? { members: [], pendingCount: 0 }
        : url.pathname === '/api/knowledge' ? { items: [], pendingCount: 0 }
        : url.pathname === '/api/people' ? { people: [] }
        : url.pathname === '/api/profile' ? { profile: {} }
        : { conversations: [], messages: [], unreadCount: 0 };
      return route.fulfill({ json: data });
    });
    const states = () => page.locator('.oa-chat-status > span').evaluateAll(elements => elements.map(el => el.className));
    const ask = async question => { await page.getByRole('button', { name: '发送问题', exact: true }).waitFor(); const input = page.getByPlaceholder('询问实验室大数据'); await input.fill(question); await input.press('Enter'); };
    try {
      await page.goto(origin);
      await page.locator('.collaboration-workspace').waitFor();
      await page.locator('.collaboration-ai-entry').click();
      await page.waitForFunction(() => document.querySelectorAll('.oa-chat-status > .ready').length === 4);
      assert.deepEqual(await states(), ['ready', 'ready', 'ready', 'ready', 'unknown']);
      assert.equal(await page.locator('.oa-topbar-secondary-title > strong').innerText(), 'AI 助手');
      const legend = page.locator('.oa-chat-status-details > summary');
      await legend.click();
      assert.equal(await page.locator('.oa-chat-status-panel').isVisible(), true);
      assert.deepEqual(await page.locator('.oa-chat-status-panel dt').allTextContents(), ['网络连接', 'OA 成员身份', '模型调用', '知识检索', '回答生成']);
      await legend.click();
      reply = { answer: '已检索到相关资料，但问答服务暂未能生成完整答复，请稍后重试。', mode: 'retrieval', fallbackReason: 'shared_model_unavailable', citations: [], images: [] };
      await ask('模拟检索成功但生成失败');
      await page.waitForFunction(() => document.querySelector('.oa-chat-status')?.dataset.summary.includes('回答生成失败'));
      const failed = ['ready', 'ready', 'unavailable', 'ready', 'unavailable'];
      assert.deepEqual(await states(), failed);
      await page.waitForFunction(() => document.querySelector('.message.assistant')?.textContent?.includes('暂未能生成完整答复'));
      await page.getByRole('button', { name: '重新回答', exact: true }).waitFor();
      await legend.click();
      await page.screenshot({ path: resolve(output, `${name}-generation-failure.png`), fullPage: true });
      await legend.click();
      const checked = page.waitForResponse(response => new URL(response.url()).pathname === '/api/lab-ai/status');
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await checked; await page.waitForTimeout(80);
      assert.deepEqual(await states(), failed, 'late green health probes must not overwrite failed question evidence');
      assert.equal(await page.locator('.oa-chat-status').getAttribute('data-source'), 'question');
      reply = complete;
      await page.getByRole('button', { name: '重新回答', exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('.oa-chat-status > .ready').length === 5);
      await page.waitForFunction(() => document.querySelector('.message.assistant')?.textContent?.includes('这是本次完整的测试回答'));
      assert.equal(await page.locator('.message.user').count(), 1, 'retry must replace the failed attempt, not add a duplicate question');
      reply = { answer: '目前知识库没有找到足够依据回答这个问题。', mode: 'no_evidence', citations: [], images: [] };
      await ask('模拟未找到知识资料');
      await page.waitForFunction(() => document.querySelector('.oa-chat-status')?.dataset.summary.includes('未找到足够资料'));
      await page.waitForFunction(() => [...document.querySelectorAll('.message.assistant')].some(element => element.textContent?.includes('目前知识库没有找到足够依据')));
      assert.deepEqual(await states(), ['ready', 'ready', 'unknown', 'warning', 'unknown']);
      httpStatus = 401; reply = { error: '请先完成成员注册。' };
      await ask('模拟身份校验失败');
      await page.waitForFunction(() => document.querySelectorAll('.oa-chat-status > span')[1]?.className === 'unavailable');
      assert.deepEqual(await states(), ['ready', 'unavailable', 'unknown', 'unknown', 'unavailable']);
      httpStatus = 429; reply = { error: '提问过于频繁，请稍后再试。' };
      await ask('模拟请求限流');
      await page.getByRole('alert').filter({ hasText: '提问过于频繁' }).waitFor();
      assert.deepEqual(await states(), ['ready', 'unknown', 'unknown', 'unknown', 'unavailable'], '429 is not a logged-out member');
      hold = true;
      await ask('停止本次等待');
      await page.getByRole('button', { name: '停止等待回答', exact: true }).waitFor();
      assert.equal((await states()).filter(state => state === 'pending').length, 3);
      await page.getByRole('button', { name: '停止等待回答', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.oa-chat-status')?.dataset.summary.includes('已停止'));
      assert.deepEqual(await states(), Array(5).fill('unknown'));
      for (const route of held) { try { await route.abort(); } catch { /* Client already cancelled. */ } }
      await page.getByRole('button', { name: '聊天选项', exact: true }).click();
      page.once('dialog', dialog => dialog.accept());
      await page.getByRole('button', { name: '清空聊天', exact: true }).click();
      await page.locator('.empty-hero').waitFor();
      assert.equal(await page.locator('.oa-chat-status').getAttribute('data-source'), 'probe');
      assert.equal((await states())[4], 'unknown', 'new conversation cannot inherit old generation success or failure');
      assert.deepEqual(errors, []);
      assert.ok(writes.every(path => path === '/api/lab-ai/ask'));
      results.push({ name, passed: true, probeNotGeneration: true, tappableLabels: true, fallbackAndRetry: true, lateProbePreservesFailure: true, noEvidence: true, authVsRateLimit: true, stoppedUnknown: true, clearResetsStatus: true });
      console.log(`${name}: question evidence, tappable labels, HTTP-200 fallback, late probes, retry, no evidence, 401/429 and stop passed`);
    } catch (error) {
      await page.screenshot({ path: resolve(output, `${name}-failure.png`), fullPage: true });
      results.push({ name, passed: false, error: error.message, errors }); throw error;
    } finally { await context.close(); }
  }
} finally {
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ syntheticApis: true, productionAccess: false, results }, null, 2));
  await browser.close(); await new Promise(done => server.close(done));
}

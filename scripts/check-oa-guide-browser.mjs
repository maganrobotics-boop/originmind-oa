// Build the actual guide for an isolated, read-only browser check. No OA APIs,
// production origins, login state or model calls are available to this fixture.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = path.join(root, '.wrangler/oa-guide-browser-fixture');
const output = path.join(root, 'parity-validation/guide-app');
const reportDir = path.join(root, 'parity-validation/guide-report');
await mkdir(fixture, { recursive: true });
await mkdir(reportDir, { recursive: true });
await writeFile(path.join(fixture, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OA guide isolated acceptance</title></head><body><div id="root"></div><script type="module" src="./entry.mjs"></script></body></html>');
await writeFile(path.join(fixture, 'entry.mjs'), "import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport '../../app/globals.css';\nimport GuidePage from '../../app/guide/page.tsx';\ncreateRoot(document.getElementById('root')).render(React.createElement(GuidePage));\n");
await build({ configFile: false, root, plugins: [react()], resolve: { alias: { '@': root } }, publicDir: path.join(root, 'public'), build: { outDir: output, emptyOutDir: true, sourcemap: false, rollupOptions: { input: path.join(fixture, 'index.html') } } });
async function htmlFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await htmlFiles(file));
    else if (entry.name.endsWith('.html')) result.push(file);
  }
  return result;
}
const pages = await htmlFiles(output);
const htmlFile = pages.find(file => file.endsWith('/oa-guide-browser-fixture/index.html')) || pages.find(file => file === path.join(output, 'index.html'));
assert.ok(htmlFile, 'actual guide fixture HTML must be emitted');
const html = await readFile(htmlFile);
const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (request.method !== 'GET') { response.writeHead(405).end(); return; }
    if (pathname === '/' || pathname === '/guide') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html); return; }
    const file = path.resolve(output, `.${decodeURIComponent(pathname)}`);
    if (!file.startsWith(`${output}${path.sep}`)) { response.writeHead(403).end(); return; }
    response.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' }).end(await readFile(file));
  } catch { if (!response.headersSent) response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const report = { passed: false, scope: 'actual guide component; isolated browser; no production or authenticated-data checks', viewports: [], errors: [] };
let browser;
try {
  assert.ok(process.env.PLAYWRIGHT_MODULE, 'use the installed isolated browser engine');
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
  browser = await chromium.launch({ headless: true });
  for (const [name, width, height] of [['desktop', 1280, 900], ['tablet', 768, 1024], ['mobile', 390, 844], ['mobile-small', 320, 700]]) {
    const context = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN' });
    const forbidden = [], errors = [];
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || url.pathname.startsWith('/api/') || route.request().method() !== 'GET') { forbidden.push(route.request().url()); await route.abort(); return; }
      await route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(`${origin}/guide`, { waitUntil: 'networkidle' });
      assert.equal(await page.getByRole('heading', { level: 1, name: '项目章程与使用指南', exact: true }).isVisible(), true);
      await page.keyboard.press('Tab');
      assert.equal(await page.locator('.guide-skip').evaluate(element => element === document.activeElement), true);
      await page.keyboard.press('Enter');
      assert.equal(new URL(page.url()).hash, '#guide-main');
      const anchors = await page.locator('a[href^="#"]').evaluateAll(elements => elements.map(element => ({ hash: element.getAttribute('href').slice(1), exists: Boolean(document.getElementById(element.getAttribute('href').slice(1))) })));
      assert.ok(anchors.length >= 14 && anchors.every(anchor => anchor.exists), 'all section and scenario links must resolve');
      assert.equal(await page.locator('.guide-entry-grid article').count(), 2);
      assert.equal(await page.locator('.guide-scope-grid article').count(), 3);
      assert.equal(await page.locator('.guide-examples .guide-example').count(), 4);
      assert.equal(await page.locator('.guide-clause').count(), 8);
      assert.match(await page.locator('#entry').innerText(), /内部公开 ≠ 对外公开/u);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(reportDir, `${name}-overview.png`) });
      await page.locator('.guide-contents').getByRole('link', { name: '资料归档与范围', exact: true }).click();
      assert.equal(new URL(page.url()).hash, '#knowledge');
      await page.locator('.guide-scope-grid').screenshot({ path: path.join(reportDir, `${name}-visibility.png`) });
      await page.locator('#meeting-example').screenshot({ path: path.join(reportDir, `${name}-meeting.png`) });
      const first = page.locator('.guide-faq details').first();
      await first.locator('summary').click();
      assert.notEqual(await first.getAttribute('open'), null);
      assert.equal(await first.locator('p').isVisible(), true);
      await first.locator('summary').press('Enter');
      assert.equal(await first.getAttribute('open'), null);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no page-level horizontal overflow');
      if (name === 'desktop') {
        await page.locator('.guide-faq details').evaluateAll(elements => elements.forEach(element => { element.open = true; }));
        await writeFile(path.join(reportDir, 'guide-text.txt'), await page.locator('main').innerText());
      }
      assert.deepEqual(forbidden, [], 'guide must not access private APIs or external sites');
      assert.deepEqual(errors, [], 'guide must have no uncaught browser error');
      report.viewports.push({ name, width, height, passed: true, anchors: anchors.length, keyboard: true, faq: true, overflow: false, apiCalls: 0 });
    } finally { await context.close(); }
  }
  report.passed = true;
} catch (error) {
  report.errors.push(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(reportDir, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));

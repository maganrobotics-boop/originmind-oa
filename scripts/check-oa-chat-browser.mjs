// Actual OA components; synthetic APIs only, with all external requests blocked.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to the repository-pinned Playwright installation');
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const root = resolve('parity-validation/browser-app');
const output = resolve('parity-validation/browser-report');
await mkdir(output, { recursive: true });
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(root + sep)) throw new Error('Invalid fixture path');
    const bytes = await readFile(file);
    response.setHeader('content-type', ({ '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml' })[extname(file)] || 'application/octet-stream');
    response.end(bytes);
  } catch { response.writeHead(404); response.end('not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const session = { registered:true, status:'active', user:{ email:'browser-test@example.test', displayName:'测试成员', authProvider:'github' }, role:'project_owner', isAdmin:true, canReviewKnowledge:true, canReviewMembers:true, ndaCompleted:true, needsNda:false };
const answer = String.raw`## 机器人运动模型

**核心结论：**速度与转弯半径共同影响运动状态；关键关系为 \(a=\frac{v^2}{r}\)。

### 状态矩阵

\[
A=\begin{bmatrix}1&2\\3&4\end{bmatrix},\quad x[999]=\sum_{i=1}^{n}x_i
\]

| **指标** | **表达式** |
| :--- | ---: |
| 范数 | $|x|$ |
| 误差 | $e_i^2$ |

1. **确认参数**，保留单位。
2. **复核结果**，结合实机测试。

**完整结尾**。`;
const ready = { authorized:true, modelReady:true, knowledgeReady:true, retrievalReady:true, budgetReady:true };
const responseBody = { answer, mode:'ai', images:[], citations:[{ id:'1', itemId:'11111111-2222-4333-8444-555555555555', title:'浏览器测试资料' }] };
const browser = await chromium.launch({ headless:true });
const results = [];
try {
  for (const [name,width,height] of [['desktop',1280,900],['tablet-wide',900,1000],['tablet',820,960],['mobile',390,844],['mobile-landscape',844,390]]) {
    const context = await browser.newContext({ viewport:{ width,height }, serviceWorkers:'block' });
    const page = await context.newPage();
    const errors = []; const requests = []; const held = [];
    let holdAnswer = false;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      requests.push({ path:url.pathname, method:route.request().method(), body:route.request().postData() });
      if (url.pathname === '/api/lab-ai/ask' && holdAnswer) { held.push(route); return; }
      const data = url.pathname === '/api/session' ? session : url.pathname === '/api/lab-ai/ask' ? responseBody : url.pathname === '/api/lab-ai/status' ? ready : url.pathname === '/api/approvals' ? { approvals:[] } : url.pathname === '/api/members' ? { members:[], pendingCount:0 } : url.pathname === '/api/knowledge' ? { items:[], pendingCount:0 } : url.pathname === '/api/people' ? { people:[] } : url.pathname === '/api/profile' ? { profile:{} } : { conversations:[], messages:[], unreadCount:0 };
      return route.fulfill({ json:data });
    });
    const metrics = () => page.evaluate(() => {
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom }; };
      return { width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,main:rect('.main-shell'),chat:rect('.oa-shared-chat'),composer:rect('.oa-chat-composer'),messages:rect('.oa-chat-messages') };
    });
    try {
      await page.goto(origin);
      await page.locator('.oa-shared-chat').waitFor();
      if (name === 'desktop') await page.getByRole('button', {name:'收起侧栏',exact:true}).click();
      const before = await metrics();
      assert.ok(Math.abs(before.main.width-width) < 1 && Math.abs(before.main.x) < 1, 'collapsed work area must fill viewport width');
      assert.ok(Math.abs(before.chat.bottom-height) < 1, 'conversation must fill viewport below header');
      assert.ok(before.composer.width >= width-40, 'composer must not retain the old 780px cap');
      assert.ok(height-before.composer.bottom >= 0 && height-before.composer.bottom <= 20, 'composer must remain at viewport bottom');
      assert.ok(before.messages.height > 60 && before.scrollWidth <= width+1);
      assert.equal(await page.locator('.topbar .chat-hub').isVisible(), false, 'old private-chat toolbar must not duplicate the Chat header');
      assert.equal(await page.locator('.topbar .oa-topbar-user').count(), 0, 'chat identity belongs in the lower-left account area');
      const more = page.getByRole('button', {name:'聊天选项',exact:true});
      await more.waitFor();
      assert.equal(await page.locator('.oa-conversation-tools').count(),0);
      const moreBox = await more.boundingBox();
      assert.ok(moreBox.width >= 44 && moreBox.height >= 44 && moreBox.x >= width-70, 'three-dot control belongs at the top right');
      await more.click();
      assert.equal(await page.getByRole('menuitem',{name:'清空聊天',exact:true}).getAttribute('data-disabled'), '');
      await page.keyboard.press('Escape');
      await page.getByRole('menu').waitFor({state:'hidden'});
      assert.equal(await more.evaluate(element=>element===document.activeElement),true);
      await page.screenshot({ path:resolve(output,`${name}-welcome.png`),fullPage:true });
      const input = page.getByPlaceholder('询问实验室大数据');
      await input.fill('请解释机器人运动模型和矩阵');
      const previousRequests = requests.filter(request => request.path === '/api/lab-ai/ask').length;
      await input.dispatchEvent('keydown', { key:'Enter',code:'Enter',isComposing:true });
      assert.equal(requests.filter(request => request.path === '/api/lab-ai/ask').length,previousRequests,'IME composition must not submit');
      await input.press('Enter');
      await page.waitForFunction(() => document.querySelectorAll('.message.assistant math').length === 4);
      assert.equal(await page.locator('.message.assistant table').count(),1);
      assert.ok(await page.locator('.message.assistant strong').count() >= 5);
      assert.ok((await page.locator('.message.assistant').innerText()).includes('完整结尾'));
      assert.equal(await page.locator('.message.assistant .copy-answer').count(),1);
      const after = await metrics();
      assert.ok(after.messages.height > 150 && after.scrollWidth <= width+1 && Math.abs(after.chat.bottom-height)<1);
      await page.screenshot({ path:resolve(output,`${name}-answer.png`),fullPage:true });
      await input.fill('切换审批与资料后保留的问题');
      const desktop = name === 'desktop';
      await page.getByRole('button',{name:desktop?'展开侧栏':'打开导航',exact:true}).click();
      const nav=page.locator(desktop?'.oa-desktop-navigation':'.mobile-sidebar');
      for (const group of ['office','knowledge']) {
        const button = nav.locator(`[data-sidebar-section="${group}"]`);
        assert.equal(await button.getAttribute('aria-expanded'),'true');
        const id = await button.getAttribute('aria-controls');
        await button.click();
        assert.equal(await button.getAttribute('aria-expanded'),'false');
        assert.equal(await page.locator(`[id="${id}"]`).isVisible(),false);
        await button.click();
        assert.equal(await button.getAttribute('aria-expanded'),'true');
      }
      assert.doesNotMatch(await nav.innerText(), /官网 OEM 申请|流程与规则/u);
      assert.equal(await nav.getByRole('button',{name:'打开个人账户菜单',exact:true}).getAttribute('title'), '测试成员');
      assert.equal(await nav.getByRole('button',{name:'打开个人账户菜单',exact:true}).isVisible(),true);
      await page.screenshot({ path:resolve(output,`${name}-navigation.png`),fullPage:true });
      await nav.getByRole('button',{name:'上传资料',exact:true}).click();
      assert.equal(await page.getByRole('button',{name:'上传 ZIP',exact:true}).isVisible(),true);
      assert.equal(await page.getByRole('button',{name:'上传文件夹',exact:true}).isVisible(),true);
      if (!desktop) await page.getByRole('button',{name:'打开导航',exact:true}).click();
      await nav.getByRole('button',{name:'审批工作台',exact:true}).click();
      assert.equal(await page.locator('.main-shell .dashboard-ai-entry').count(),0);
      assert.equal(await page.getByRole('button',{name:'进入 OA 内部实验室 AI',exact:true}).count(),0);
      assert.equal(await page.getByRole('button',{name:'聊天选项',exact:true}).count(),0);
      assert.equal(await page.locator('.main-shell .stats-grid').isVisible(),true);
      if (!desktop) await page.getByRole('button',{name:'打开导航',exact:true}).click();
      await nav.getByRole('button',{name:'AI 聊天',exact:true}).click();
      assert.equal(await input.inputValue(),'切换审批与资料后保留的问题');
      assert.equal(await page.locator('.message.assistant math').count(),4);
      if (desktop) await page.getByRole('button',{name:'收起侧栏',exact:true}).click();
      holdAnswer=true;
      await input.fill('中断后重新回答测试'); await input.press('Enter');
      await page.getByRole('button',{name:'停止等待回答',exact:true}).click();
      await page.getByRole('button',{name:'重新回答',exact:true}).waitFor();
      holdAnswer=false;
      for (const route of held) { try { await route.abort(); } catch { /* already cancelled */ } }
      await page.getByRole('button',{name:'重新回答',exact:true}).click();
      await page.waitForFunction(() => document.querySelectorAll('.message.assistant math').length === 8);
      // Cancelling a clear operation retains the current messages and draft.
      await input.fill('尚未发送的问题');
      await more.click();
      await page.screenshot({path:resolve(output,`${name}-chat-menu.png`),fullPage:true});
      page.once('dialog',dialog=>dialog.dismiss());
      await page.getByRole('menuitem',{name:'清空聊天',exact:true}).click();
      await page.getByRole('menu').waitFor({state:'detached'});
      await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='聊天选项');
      assert.equal(await input.inputValue(),'尚未发送的问题');
      assert.equal(await page.locator('.message.assistant math').count(),8);
      await more.click();
      page.once('dialog',dialog=>dialog.accept());
      await page.getByRole('menuitem',{name:'清空聊天',exact:true}).click();
      await page.getByRole('menu').waitFor({state:'detached'});
      await page.locator('.empty-hero').waitFor();
      assert.equal(await input.inputValue(),'');
      assert.equal(await page.locator('.message').count(),0);
      await page.waitForFunction(()=>document.activeElement?.getAttribute('placeholder')==='询问实验室大数据');
      // Clearing an in-flight answer cannot reinsert its late response or issue a deletion API request.
      held.length=0; holdAnswer=true;
      await input.fill('清空正在生成的回答'); await input.press('Enter');
      await page.getByRole('button',{name:'停止等待回答',exact:true}).waitFor();
      await more.click(); page.once('dialog',dialog=>dialog.accept());
      await page.getByRole('menuitem',{name:'清空聊天',exact:true}).click();
      await page.getByRole('menu').waitFor({state:'detached'});
      await page.locator('.empty-hero').waitFor();
      holdAnswer=false;
      for (const route of held) { try { await route.fulfill({json:responseBody}); } catch { /* the client already aborted */ } }
      await page.waitForTimeout(100);
      assert.equal(await page.locator('.message').count(),0);
      assert.equal(await page.getByRole('button',{name:'停止等待回答',exact:true}).count(),0);
      assert.equal(await page.locator('.oa-chat-error').count(),0);
      // The next question starts with no previous private chat history.
      await input.fill('清空后重新开始'); await input.press('Enter');
      await page.waitForFunction(()=>document.querySelectorAll('.message.assistant math').length===4);
      assert.deepEqual(JSON.parse(requests.filter(request=>request.path==='/api/lab-ai/ask').at(-1).body).history,[]);
      assert.deepEqual(errors,[]);
      const writes=requests.filter(request => request.method!=='GET');
      assert.ok(writes.every(request=>request.path==='/api/lab-ai/ask'),'browser acceptance must never write approvals or knowledge');
      results.push({name,passed:true,viewport:{width,height},before,after,mathFormulas:4,table:true,independentGroups:true,statePreserved:true,stopAndRetry:true,clearMenu:true,clearCancellation:true,clearPendingAnswer:true,sidebarIdentityOnly:true,approvalDashboardSeparated:true,errors});
      console.log(`${name}: viewport, Markdown/MathML, independent groups, upload entries, state preservation, IME and retry passed`);
    } catch (error) {
      await page.screenshot({path:resolve(output,`${name}-failure.png`),fullPage:true});
      results.push({name,passed:false,error:error.message,errors});
      throw error;
    } finally { await context.close(); }
  }
} finally {
  await writeFile(resolve(output,'report.json'),JSON.stringify({syntheticApis:true,productionAccess:false,browserVersion:browser.version(),results},null,2));
  await browser.close();
  await new Promise(resolve=>server.close(resolve));
}

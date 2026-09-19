// Real OA components; all document/task APIs are synthetic and all outside traffic is blocked.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { png, pdf, docxParts, zip } from '../tests/helpers/oa-attachment-fixtures.mjs';
import { randomUUID } from 'node:crypto';
import { prepareTaskArtifacts, verifiedArtifactBytes } from '../lib/ai-workbench-artifacts.mjs';
if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to the pinned Playwright installation');
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const root = resolve('parity-validation/browser-app'), output = resolve('parity-validation/chat-documents-report');
await mkdir(output, { recursive: true });
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(root + sep)) throw new Error('Invalid path');
    const bytes = await readFile(file);
    response.setHeader('content-type', ({ '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css' })[extname(file)] || 'application/octet-stream'); response.end(bytes);
  } catch { response.writeHead(404); response.end('not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const session = { registered:true, status:'active', user:{ email:'documents-test@example.test', displayName:'测试成员', authProvider:'github' }, role:'project_owner', isAdmin:true, canReviewKnowledge:true, canReviewMembers:true, ndaCompleted:true, needsNda:false };
const ready = { authorized:true, modelReady:true, knowledgeReady:true, retrievalReady:true, budgetReady:true };
const result = '# 项目周报\n\n## 已完成\n\n**原型装配已完成。**\n\n## 待验证\n\n实机测试尚未完成。\n\n## 下一步\n\n负责人和日期：待补充。\n';
const browser = await chromium.launch({ headless:true });
const results = [];
try {
  for (const [name, width, height] of [['desktop',1280,900],['mobile',390,844],['mobile-small',320,700],['landscape',844,390]]) {
    const context = await browser.newContext({ viewport:{ width,height }, serviceWorkers:'block', acceptDownloads:true });
    const page = await context.newPage(), requests = [], errors = [], held = [], tasks = new Map(), ids = new Map();
    const archived = new Map(); let failArchive = true, failSave = true;
    let clock = 10, mode = 'success', loseCreate = false, unavailable = false;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const body = request.headers()['content-type']?.includes('application/json') ? request.postDataJSON() : null;
      requests.push({ path:url.pathname, method:request.method(), body });
      if (url.pathname === '/api/lab-ai/extract') return route.fulfill({json:{text:`已解析 ${decodeURIComponent(request.headers()['x-oa-file-name'])}，这是一段用于浏览器回归的完整合成内容。`}});
      if (url.pathname === '/api/knowledge/import-chat') return route.fulfill({status:201,json:{received:true,item:{id:body.document.id,status:'pending',visibility:'internal'},assetUpload:{revisionId:'test-revision',uploadToken:'test-token'}}});
      if (url.pathname.startsWith('/api/knowledge/assets')) return route.fulfill({json:{received:true}});
      if (url.pathname === '/api/lab-ai/archive') {
        if (request.method() === 'GET') {
          const id = url.searchParams.get('id');
          return route.fulfill({json:{lifecycle:archived.get(id) || {state:'temporary',expiresAt:Date.now()+604800000,knowledgeItemId:null,knowledgeStatus:null}}});
        }
        assert.deepEqual(Object.keys(body).sort(),['confirmed','expectedUpdatedAt','id']); assert.equal(body.confirmed,true);
        assert.equal(body.expectedUpdatedAt,tasks.get(body.id)?.updated_at,'archive must use the exact saved version');
        const receipt = {id:body.id,status:'pending',visibility:'internal'};
        archived.set(body.id,{state:'submitted',expiresAt:null,knowledgeItemId:receipt.id,knowledgeStatus:'pending',visibility:'internal'});
        if (failArchive) { failArchive=false; return route.abort('failed'); }
        return route.fulfill({json:{received:true,item:receipt}});
      }
      if (url.pathname === '/api/lab-ai/tasks') {
        if (unavailable) return route.fulfill({ status:503, json:{ error:'文档处理服务暂不可用（合成测试）' } });
        if (request.method() === 'GET') {
          const id = url.searchParams.get('id'), format = url.searchParams.get('format');
          if (!id) return route.fulfill({ json:{ tasks:[...tasks.values()].map(({ result, material, instruction, ...task }) => task) } });
          const task = tasks.get(id);
          if (!task) return route.fulfill({ status:404, json:{ error:'任务不存在或无访问权限。' } });
          if (format) {
            if (task.status !== 'succeeded') return route.fulfill({ status:409, json:{ error:'尚无成果。' } });
            const prepared = await prepareTaskArtifacts(task.title, task.result);
            const bytes = await verifiedArtifactBytes(prepared.artifacts.find(item => item.format === format));
            return route.fulfill({ contentType:format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/markdown; charset=utf-8', body:Buffer.from(bytes) });
          }
          return route.fulfill({ json:{ task } });
        }
        if (body.action === 'create') {
          let id = ids.get(body.requestId);
          if (!id) { id = randomUUID(); ids.set(body.requestId,id); tasks.set(id,{ id,kind:body.kind,title:body.title,instruction:body.instruction,material:body.material,status:'queued',result:'',failure_code:'',attempts:0,updated_at:++clock }); }
          if (loseCreate) { loseCreate=false; return route.abort('failed'); }
          return route.fulfill({ status:201, json:{ task:tasks.get(id) } });
        }
        const task = tasks.get(body.id);
        if (!task) return route.fulfill({ status:404, json:{error:'无访问权限'} });
        if (body.action === 'saveDraft') {
          assert.deepEqual(Object.keys(body).sort(),['action','expectedUpdatedAt','id','result','title']);
          if (failSave) { failSave=false; return route.fulfill({status:503,json:{error:'合成保存失败，当前修改未提交。'}}); }
          if (archived.get(body.id)?.state === 'submitted' || body.expectedUpdatedAt !== task.updated_at) return route.fulfill({status:409,json:{error:'版本冲突或已送审，未覆盖。'}});
          const prepared = await prepareTaskArtifacts(body.title,body.result);
          task.title=body.title; task.result=prepared.markdown; task.updated_at=++clock;
          archived.set(body.id,{state:'draft',expiresAt:null,knowledgeItemId:null,knowledgeStatus:null});
          return route.fulfill({json:{saved:true,task}});
        }
        if (body.action === 'cancel') { task.status='cancelled'; task.updated_at=++clock; return route.fulfill({ json:{task} }); }
        task.status='running'; task.attempts++; task.updated_at=++clock;
        if (mode === 'hold') { held.push({route, task:{...task}}); return; }
        task.status=mode === 'failed' ? 'failed' : 'succeeded'; task.failure_code=mode === 'failed' ? 'TASK_GENERATION_FAILED' : ''; task.result=mode === 'failed' ? '' : result; task.updated_at=++clock;
        return route.fulfill({ json:{task} });
      }
      const data = url.pathname === '/api/session' ? session : url.pathname === '/api/lab-ai/status' ? ready : url.pathname === '/api/lab-ai/ask' ? {answer:'这是实验室普通知识问答的完整回答。', mode:'ai', images:[], citations:[]} : url.pathname === '/api/approvals' ? {approvals:[]} : url.pathname === '/api/members' ? {members:[],pendingCount:0} : url.pathname === '/api/knowledge' ? {items:[],pendingCount:0} : url.pathname === '/api/people' ? {people:[]} : url.pathname === '/api/profile' ? {profile:{}} : {conversations:[],messages:[],unreadCount:0};
      return route.fulfill({json:data});
    });
    const createRequests = () => requests.filter(item => item.path === '/api/lab-ai/tasks' && item.body?.action === 'create');
    const archiveRequests = () => requests.filter(item => item.path === '/api/lab-ai/archive' && item.method === 'POST');
    const importText = async (name, text) => {
      await page.locator('.oa-shared-chat input[type=file][accept*=".markdown"]').setInputFiles({name,mimeType:'text/plain',buffer:Buffer.from(text)});
      await page.getByRole('article',{name:`已导入 ${name}`,exact:true}).waitFor();
    };
    const input = page.getByPlaceholder('询问实验室大数据');
    const send = async text => { await input.fill(text); await input.press('Enter'); };
    const preview = page.getByRole('dialog',{name:'文档预览',exact:true});
    const closePreview = async () => { await preview.waitFor(); await preview.getByRole('button',{name:'返回聊天',exact:true}).click(); await preview.waitFor({state:'hidden'}); };
    try {
      await page.goto(origin); await page.locator('.oa-shared-chat').waitFor();
      if (name==='desktop') await page.getByRole('button',{name:'收起侧栏',exact:true}).click();
      assert.equal(await page.getByRole('heading',{name:'实验室大模型能做什么',exact:true}).isVisible(),true);
      assert.equal(await page.locator('.empty-hero p').innerText(),'知识问答、资料整理、会议纪要、项目总结等');
      assert.equal(await page.locator('.empty-hero p').isVisible(),true);
      assert.ok(await page.locator('.empty-hero').evaluate(element => [...element.querySelectorAll('h2,p')].every(child => child.scrollWidth <= child.clientWidth + 1)));
      const hints = page.locator('.oa-chat-examples button');
      assert.deepEqual(await hints.allTextContents(),['知识问答','资料整理','会议纪要','项目总结']);
      if (height > 520) {
        const prompts = [
          '实验室有哪些研究方向？',
          '请把材料整理成结构清晰的 Word 文档，保留关键事实。',
          '请整理成会议纪要，区分讨论、决定和待办，未明确的信息标注待补充。',
          '请把材料整理成项目总结文档，列出已完成工作、主要成果、存在问题和下一步计划，未明确的信息标注待补充。',
        ];
        for (let index = 0; index < prompts.length; index++) {
          await hints.nth(index).click();
          assert.equal(await input.inputValue(),prompts[index]);
        }
        assert.equal(createRequests().length,0,'choosing a capability must not submit a task');
        assert.equal(requests.filter(item => item.path === '/api/lab-ai/ask' && item.method === 'POST').length,0,'choosing a capability must not call the model');
        await input.fill('');
      }
      assert.equal(await page.locator('.oa-shared-chat a[href="/ai-workbench"]').count(),0);
      assert.equal(await page.getByRole('button',{name:'上传文件、图片、ZIP 或文件夹',exact:true}).isVisible(),true);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      await page.screenshot({path:resolve(output,`${name}-welcome.png`),fullPage:true});
      await send('实验室有哪些研究方向？'); await page.locator('.message.assistant').waitFor();
      assert.equal(createRequests().length,0,'ordinary questions must not create document tasks');
      const original = '## 原始资料\n原型装配已完成；实机测试尚未完成。\n'.repeat(70)+'END_SOURCE\n<img src=x onerror="window.importExecuted=true">';
      await importText('导入测试.MD',original);
      const imported = page.getByRole('article',{name:'已导入 导入测试.MD',exact:true});
      assert.ok((await imported.locator('pre').innerText()).includes('原型装配已完成'));
      await imported.getByRole('button',{name:/展开全文/u}).click();
      assert.equal(await imported.locator('pre').textContent(),original);
      assert.equal(await imported.locator('img').count(),0);
      assert.equal(await page.evaluate(()=>Boolean(window.importExecuted)),false);
      assert.equal(createRequests().length,0,'import alone must not submit private material');
      await page.screenshot({path:resolve(output,`${name}-import.png`),fullPage:true});
      await send('请整理成项目周报并生成 Word 文档'); await preview.waitFor();
      assert.equal(createRequests().length,1); assert.equal(createRequests()[0].body.material,original);
      assert.ok((await preview.innerText()).includes('实机测试尚未完成'));
      const downloaded = page.waitForEvent('download'); await preview.getByRole('button',{name:'下载 Word',exact:true}).click();
      const download = await downloaded; assert.match(download.suggestedFilename(),/\.docx$/u);
      const path = resolve(output,`${name}-synthetic.docx`); await download.saveAs(path);
      const bytes = await readFile(path); assert.equal(bytes.subarray(0,2).toString(),'PK'); assert.ok(bytes.length>100);
      await page.screenshot({path:resolve(output,`${name}-preview.png`),fullPage:true});
      // Editing never starts approval. A failed save preserves input and cannot send stale content.
      const archivePanel = preview.getByRole('region',{name:'文档编辑保存与提交'});
      await archivePanel.getByRole('button',{name:'编辑',exact:true}).click();
      const editedBody = '原型已完成装配；实机测试尚未完成。人工补充：下一步先核对接口，负责人和日期待补充。';
      await archivePanel.getByLabel('文档标题',{exact:true}).fill('人工核对稿');
      await archivePanel.getByLabel('文档正文',{exact:true}).fill(editedBody);
      await archivePanel.getByRole('button',{name:'保存并提交',exact:true}).click();
      await archivePanel.getByRole('checkbox').check();
      await archivePanel.getByRole('button',{name:'保存并提交 OA',exact:true}).click();
      await archivePanel.getByRole('alert').filter({hasText:'合成保存失败'}).waitFor();
      assert.equal(archiveRequests().length,0,'failed save must not submit the old version');
      assert.equal(await archivePanel.getByLabel('文档正文',{exact:true}).inputValue(),editedBody);
      await archivePanel.getByRole('button',{name:'取消',exact:true}).click();
      await archivePanel.getByRole('button',{name:'保存草稿',exact:true}).click();
      await archivePanel.getByRole('status').filter({hasText:'草稿已保存 · 未提交 OA'}).waitFor();
      assert.equal(archiveRequests().length,0,'saving a draft is not approval');
      const firstTask = [...tasks.values()][0]; assert.equal(firstTask.title,'人工核对稿');
      assert.equal(firstTask.result,`# 人工核对稿\n\n${editedBody}\n`);
      const editedDownload = page.waitForEvent('download'); await preview.getByRole('button',{name:'下载 Markdown',exact:true}).click();
      const editedFile = await editedDownload, editedPath=resolve(output,`${name}-edited.md`); await editedFile.saveAs(editedPath);
      assert.equal(await readFile(editedPath,'utf8'),firstTask.result);
      await closePreview();
      const firstCard=page.locator('.oa-document-card').first();
      await firstCard.getByRole('button',{name:'打开文档',exact:true}).click(); await preview.waitFor();
      assert.ok((await preview.innerText()).includes(editedBody));
      await archivePanel.getByRole('button',{name:'编辑',exact:true}).click();
      assert.equal(await archivePanel.getByLabel('文档标题',{exact:true}).inputValue(),'人工核对稿');
      const finalBody=`${editedBody}\n最终确认：保留待验证事项，不宣称实机验收完成。`;
      await archivePanel.getByLabel('文档正文',{exact:true}).fill(finalBody);
      await archivePanel.getByRole('button',{name:'保存并提交',exact:true}).click();
      const confirmArchive = archivePanel.getByRole('button',{name:'保存并提交 OA',exact:true});
      assert.equal(await confirmArchive.isDisabled(),true);
      await archivePanel.getByRole('checkbox').check(); await confirmArchive.click();
      // The server accepted the submission but the reply was lost: reconcile by GET, never duplicate POST.
      await archivePanel.getByRole('status').filter({hasText:'已提交·待审核'}).waitFor();
      assert.equal(archiveRequests().length,1); assert.equal(archiveRequests()[0].body.expectedUpdatedAt,firstTask.updated_at);
      assert.equal(await archivePanel.getByRole('button',{name:'编辑',exact:true}).isDisabled(),true);
      assert.equal(await archivePanel.getByRole('button',{name:'保存草稿',exact:true}).isDisabled(),true);
      assert.equal(firstTask.result,`# 人工核对稿\n\n${finalBody}\n`);
      const confirmedResult=firstTask.result;
      assert.equal(archived.size,1); await page.screenshot({path:resolve(output,`${name}-archive-pending.png`),fullPage:true});
      await closePreview(); assert.equal(new URL(page.url()).pathname,'/');
      await page.getByRole('button',{name:'不再使用这份材料',exact:true}).click();
      await send('Word 是什么？'); await page.waitForFunction(()=>document.querySelectorAll('.message.assistant').length===2);
      assert.equal(createRequests().length,1,'format questions must remain ordinary chat');
      await page.getByRole('button',{name:'继续修改',exact:true}).click();
      await send('请精简这份文档并生成 Word'); await preview.waitFor();
      assert.equal(createRequests().at(-1).body.material,confirmedResult,'continue editing uses the latest saved document'); await closePreview();
      // Failure must never manufacture an attachment; explicit retry uses the same task.
      mode='failed'; await importText('失败测试.txt','本次只包含真实测试材料。'); await send('整理材料');
      await page.getByRole('button',{name:'重试任务',exact:true}).waitFor();
      assert.equal(await preview.isVisible(),false);
      const lastCard = page.locator('.oa-document-card').last(); assert.equal(await lastCard.getByRole('button',{name:'下载 Word',exact:true}).count(),0);
      const beforeRetry=createRequests().length; mode='success'; await lastCard.getByRole('button',{name:'重试任务',exact:true}).click(); await preview.waitFor(); assert.equal(createRequests().length,beforeRetry); await closePreview();
      // Lost create acknowledgement: user recovery must repeat the same idempotency key.
      loseCreate=true; await importText('恢复测试.txt','用于核对提交编号的材料。'); await send('整理材料');
      await page.getByRole('button',{name:'核对提交',exact:true}).waitFor(); const lost=createRequests().at(-1).body;
      await page.getByRole('button',{name:'核对提交',exact:true}).click(); await preview.waitFor();
      assert.equal(createRequests().at(-1).body.requestId,lost.requestId); await closePreview();
      // Explicit cancellation must survive a late successful run response.
      mode='hold'; await importText('取消测试.txt','任务取消后不应显示迟到的成功文档。'); await send('整理材料');
      await page.getByRole('button',{name:'取消任务',exact:true}).waitFor();
      await page.getByRole('button',{name:'取消任务',exact:true}).click();
      await page.waitForFunction(()=>[...document.querySelectorAll('.oa-document-card [role=status]')].some(el=>el.textContent==='任务已取消'));
      for (const item of held.splice(0)) { try { await item.route.fulfill({json:{task:{...item.task,status:'succeeded',result,updated_at:++clock}}}); } catch {} }
      await page.waitForTimeout(100); assert.equal(await preview.isVisible(),false);
      assert.equal(await page.locator('.oa-document-card').last().getByRole('button',{name:'下载 Word',exact:true}).count(),0);
      // Reload can restore owner-authorized saved documents without a separate page.
      mode='success'; await page.reload(); await page.locator('.empty-hero').waitFor();
      await page.getByRole('button',{name:'已保存文档',exact:true}).click();
      const history=page.getByRole('dialog',{name:'本人已保存文档',exact:true}); await history.waitFor();
      await history.locator('.oa-document-history button').first().click(); await preview.waitFor();
      assert.ok((await preview.innerText()).includes(finalBody)); await closePreview();
      assert.equal(new URL(page.url()).pathname,'/');
      // Unsupported import leaves existing material/results intact.
      await page.locator('.oa-shared-chat input[type=file][accept*=".markdown"]').setInputFiles({name:'不支持.pdf',mimeType:'application/pdf',buffer:Buffer.from('not a document')});
      await page.getByRole('alert').filter({hasText:'文件格式无法识别'}).waitFor();
      // Service failure is explicit and does not break ordinary QA.
      unavailable=true; await importText('服务测试.md','模型不可用时不应出现伪造文档。'); await send('整理材料');
      await page.getByRole('alert').filter({hasText:'文档处理服务暂不可用'}).waitFor(); assert.equal(await preview.isVisible(),false);
      await page.getByRole('button',{name:'不再使用这份材料',exact:true}).click(); await send('实验室有哪些研究方向？'); await page.locator('.message.assistant').waitFor();
      assert.deepEqual(errors,[]);
      assert.ok(requests.filter(item=>item.method==='POST').every(item=>['/api/lab-ai/ask','/api/lab-ai/tasks','/api/lab-ai/archive'].includes(item.path)));
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      await page.screenshot({path:resolve(output,`${name}-conversation.png`),fullPage:true});
      // A generic archive is not constrained to index.md + assets/. The real ZIP validator runs in-browser.
      unavailable=false;
      const docx = zip(docxParts,{name:'报告.docx'});
      const packed = zip([['项目/记录.md','# 原始记录\n这份资料包含图片、PDF 和 DOCX。'],['项目/平台.png',png],['说明.pdf',pdf],['报告.docx',Buffer.from(await docx.arrayBuffer())]],{method:8});
      await page.getByRole('button',{name:'上传文件、图片、ZIP 或文件夹',exact:true}).click();
      await page.getByRole('group',{name:'聊天附件上传方式'}).waitFor();
      assert.equal(await page.getByRole('button',{name:'上传文件夹',exact:true}).isVisible(),true);
      await page.keyboard.press('Escape');
      const beforeImport=requests.filter(item=>item.path==='/api/knowledge/import-chat').length;
      await page.locator('.oa-shared-chat').getByLabel('选择聊天文件或 ZIP',{exact:true}).setInputFiles({name:'普通资料.zip',mimeType:'application/zip',buffer:Buffer.from(await packed.arrayBuffer())});
      const source=page.getByRole('article',{name:'已导入 资料包（4 个文件）',exact:true}); await source.waitFor();
      assert.equal(requests.filter(item=>item.path==='/api/knowledge/import-chat').length,beforeImport,'parsing does not submit knowledge');
      assert.equal(requests.filter(item=>item.path==='/api/lab-ai/extract').length,3);
      await source.locator('.oa-source-images summary').click(); await source.locator('img').waitFor();
      assert.ok((await source.locator('img').getAttribute('src')).startsWith('data:'));
      await source.getByRole('button',{name:'归档资料',exact:true}).click();
      const sourceConfirm=source.getByRole('button',{name:'确认归档并提交 OA',exact:true}); assert.equal(await sourceConfirm.isDisabled(),true);
      await source.getByRole('checkbox').check(); await sourceConfirm.click();
      await source.getByRole('status').filter({hasText:'已提交 OA，待审核'}).waitFor();
      assert.equal(requests.filter(item=>item.path==='/api/knowledge/assets' && item.method==='PUT').length,1);
      assert.equal(requests.filter(item=>item.path==='/api/knowledge/assets/finalize').length,1);
      await page.screenshot({path:resolve(output,`${name}-zip-upload.png`),fullPage:true});
      // Directory selection carries real relative paths; nothing is auto-archived.
      const directory=resolve(output,`${name}-folder`); await mkdir(directory,{recursive:true});
      await writeFile(resolve(directory,'记录.txt'),'文件夹中的完整实验记录。');
      await page.locator('.oa-shared-chat').getByLabel('选择聊天文件夹',{exact:true}).setInputFiles(directory);
      await page.getByRole('article',{name:'已导入 记录.txt',exact:true}).waitFor();
      assert.equal(requests.filter(item=>item.path==='/api/knowledge/import-chat').length,beforeImport+1);
      // The sidebar exposes the same parser and archive controls, not a text-only form.
      if(name==='desktop') {
        await page.getByRole('button',{name:'展开侧栏',exact:true}).click();
        await page.getByRole('button',{name:'上传资料',exact:true}).click();
        const sidebar=page.getByRole('region',{name:'通用资料上传'}); await sidebar.waitFor();
        await sidebar.getByLabel('选择聊天文件或 ZIP',{exact:true}).setInputFiles({name:'侧栏资料.txt',mimeType:'text/plain',buffer:Buffer.from('侧栏与聊天共用归档审批，未批准不入库。')});
        await sidebar.getByRole('button',{name:'归档资料',exact:true}).waitFor();
        assert.equal(requests.filter(item=>item.path==='/api/knowledge/import-chat').length,beforeImport+1);
        await page.screenshot({path:resolve(output,`${name}-sidebar-upload.png`),fullPage:true});
      }
      assert.deepEqual(errors,[]); assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      results.push({name,passed:true,approvedCopy:true,capabilityHints:true,ordinaryChat:true,rawImport:true,safeText:true,documentPreview:true,realDocxDownload:true,inlineEditing:true,draftPersistence:true,saveFailureStopsSubmission:true,latestVersionSubmission:true,editedDownload:true,continueEditing:true,manualRetry:true,idempotentRecovery:true,cancelLateResponse:true,restoreSaved:true,serviceFailure:true,zip:true,folder:true,pdf:true,docxImport:true,imagePreview:true,explicitArchive:true,archiveReconciliation:true,errors});
      console.log(`${name}: unified chat, edit, draft save, versioned approval, download, recovery, cancellation and history passed`);
    } catch (error) { await page.screenshot({path:resolve(output,`${name}-failure.png`),fullPage:true}); results.push({name,passed:false,error:error.message,errors}); throw error; }
    finally { await context.close(); }
  }
} finally {
  await writeFile(resolve(output,'report.json'),JSON.stringify({syntheticApis:true,productionAccess:false,browserVersion:browser.version(),results},null,2));
  await browser.close(); await new Promise(resolve=>server.close(resolve));
}

// Actual OA components, synthetic users/APIs; never touches production data.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const root=resolve('parity-validation/browser-app'),output=resolve('parity-validation/mobile-status-report');await mkdir(output,{recursive:true});
const server=createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost'),path=resolve(root,`.${url.pathname==='/'?'/index.html':url.pathname}`);if(!path.startsWith(root+sep))throw Error('path');const bytes=await readFile(path);res.setHeader('content-type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css'})[extname(path)]||'application/octet-stream');res.end(bytes);}catch{res.writeHead(404);res.end('not found');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true}),results=[];
const session={registered:true,status:'active',user:{email:'a@example.test',displayName:'成员甲',authProvider:'github'},role:'project_owner',isAdmin:true,canReviewKnowledge:true,canReviewMembers:true,ndaCompleted:true,needsNda:false};
const people=[{email:'b@example.test',name:'成员乙'},...Array.from({length:30},(_,i)=>({email:`m${i}@example.test`,name:`测试成员${i+1}`}))];
const ready={authorized:true,bridgeReady:true,modelReady:true,knowledgeReady:true,retrievalReady:true,budgetReady:true};
try{for(const [name,width,height] of [['desktop',1280,900],['mobile-toolbar',390,700],['mobile-short',390,540],['mobile-landscape',844,390]]){
 const context=await browser.newContext({viewport:{width,height},serviceWorkers:'block'}),page=await context.newPage(),errors=[],posts=[];
 let first=true,held,mode='retrieval',statusCode=200,directoryCode=200,signalStatus;const statusSeen=new Promise(r=>{signalStatus=r;});
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();if(!url.pathname.startsWith('/api/'))return route.continue();if(req.method()==='POST')posts.push(url.pathname);
  let data={conversations:[],messages:[],unreadCount:0};
  if(url.pathname==='/api/session')data=session;
  else if(url.pathname==='/api/lab-ai/status'){if(first){first=false;held=route;signalStatus();return;}return route.fulfill({status:statusCode,json:statusCode===200?ready:{error:'synthetic failure'}});}
  else if(url.pathname==='/api/lab-ai/ask')data={answer:mode==='ai'?'**完整回答**：隔离测试结果。':mode==='no_evidence'?'目前知识库没有找到足够依据回答这个问题。':'已检索到相关资料，但问答服务暂未能生成完整答复，请稍后重试。',mode,...(mode==='retrieval'?{fallbackReason:'shared_model_unavailable'}:{}),images:[],citations:[]};
  else if(url.pathname==='/api/direct-messages'&&url.searchParams.has('summary'))return route.fulfill({status:directoryCode,json:directoryCode===200?{conversations:[...people,people[0],{email:session.user.email,name:'成员甲'},{email:0,name:0}].map(peer=>({peer}))}:{error:'synthetic failure'}});
  else if(url.pathname==='/api/approvals')data={approvals:[]};else if(url.pathname==='/api/members')data={members:[],pendingCount:0};else if(url.pathname==='/api/knowledge')data={items:[],pendingCount:0};else if(url.pathname==='/api/people')data={people:[]};else if(url.pathname==='/api/profile')data={profile:{}};
  return route.fulfill({json:data});
 });
 const expectLights=states=>page.waitForFunction(wanted=>JSON.stringify([...document.querySelectorAll('.oa-chat-status > span')].map(n=>n.className))===JSON.stringify(wanted),states);
 try{
  await page.goto(origin);await page.locator('.oa-shared-chat').waitFor();await statusSeen;assert.equal(await page.locator('.oa-chat-title > strong').innerText(),'AI 助手');
  // Emulate the legacy large viewport being taller than visible browser content.
  await page.addStyleTag({content:'.sidebar-shell { min-height:calc(100dvh + 160px); }'});
  if(width<=960)await page.getByRole('button',{name:'打开导航',exact:true}).click();
  const nav=page.locator(width<=960?'.mobile-sidebar':'.oa-desktop-navigation'),account=nav.getByRole('button',{name:'打开个人账户菜单',exact:true});
  const accountVisible=async()=>{const b=await account.boundingBox();assert.ok(b&&b.y>=0&&b.y+b.height<=(await page.evaluate(()=>innerHeight))-8,'account must be fully above browser controls');assert.equal(await account.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true,'account must not be covered');return b;};
  await account.waitFor();const before=await accountVisible();await nav.locator('.oa-sidebar-scroll').evaluate(el=>{el.scrollTop=el.scrollHeight;});assert.ok(Math.abs((await accountVisible()).y-before.y)<1);
  await account.click();await nav.getByRole('menuitem',{name:'个人设置',exact:true}).waitFor();await page.screenshot({path:resolve(output,`${name}-account.png`),fullPage:true});await account.click();
  if(width<=960){await page.setViewportSize({width,height:height-60});await accountVisible();await page.setViewportSize({width,height});await page.locator('.mobile-nav-overlay').click({position:{x:width-15,y:100}});}else await page.getByRole('button',{name:'收起侧栏',exact:true}).click();
  const input=page.getByPlaceholder('询问实验室大数据');await input.fill('请检索机器人测试资料');await input.press('Enter');await page.getByText('本次未生成完整回答',{exact:true}).waitFor();await expectLights(['ready','ready','unavailable','ready','unavailable']);
  const resumed=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/lab-ai/status');await held.fulfill({json:ready});await resumed;await expectLights(['ready','ready','unavailable','ready','unavailable']);
  await page.getByRole('button',{name:'查看系统连接状态'}).click();await page.getByText('5. 本次回答',{exact:true}).waitFor();await page.getByText('本次已检索到相关资料',{exact:true}).waitFor();await page.screenshot({path:resolve(output,`${name}-status.png`),fullPage:true});await page.keyboard.press('Escape');
  mode='ai';await page.getByRole('button',{name:'重新回答',exact:true}).click();await page.getByText('完整回答',{exact:true}).waitFor();await expectLights(['ready','ready','ready','ready','ready']);
  await input.fill('保留的 AI 草稿');await page.getByRole('button',{name:'聊天选项',exact:true}).click();await page.getByRole('menuitem',{name:'成员乙',exact:true}).waitFor();
  assert.equal(await page.getByRole('menuitem',{name:'成员乙',exact:true}).count(),1);assert.equal(await page.getByRole('menuitem',{name:'与成员聊天',exact:true}).count(),0);assert.equal(await page.getByRole('menuitem',{name:'成员甲',exact:true}).count(),0);assert.equal(await page.getByRole('menuitem').first().innerText(),'AI 助手');assert.equal(await page.locator('.oa-conversation-roster').evaluate(el=>el.scrollHeight>el.clientHeight),true);
  await page.screenshot({path:resolve(output,`${name}-roster.png`),fullPage:true});await page.getByRole('menuitem',{name:'成员乙',exact:true}).click();await page.getByPlaceholder('发送消息给成员乙').waitFor();assert.equal(await page.locator('.oa-member-title strong').innerText(),'成员乙');assert.equal(await page.getByRole('dialog').count(),0);
  await page.getByRole('button',{name:'聊天选项',exact:true}).click();await page.getByRole('menuitem',{name:'AI 助手',exact:true}).click();await input.waitFor();assert.equal(await input.inputValue(),'保留的 AI 草稿');assert.ok((await page.locator('.message.assistant').innerText()).includes('完整回答'));
  directoryCode=503;await page.getByRole('button',{name:'聊天选项',exact:true}).click();await page.getByRole('menuitem',{name:'成员加载失败，点击重试',exact:true}).waitFor();directoryCode=200;await page.getByRole('menuitem',{name:'成员加载失败，点击重试',exact:true}).click();await page.getByRole('menuitem',{name:'成员乙',exact:true}).waitFor();await page.keyboard.press('Escape');
  statusCode=503;await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await expectLights(['ready','unknown','unknown','unknown','ready']);statusCode=401;await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await expectLights(['ready','unavailable','unknown','unknown','ready']);
  mode='no_evidence';await input.fill('不存在的资料');await input.press('Enter');await expectLights(['ready','ready','unknown','attention','attention']);
  assert.ok(posts.every(path=>path==='/api/lab-ai/ask'));assert.deepEqual(errors,[]);results.push({name,passed:true,fixedFooter:true,directRoster:true,truthfulStatus:true});console.log(`${name}: mobile footer, direct roster and truthful status passed`);
 }catch(error){await page.screenshot({path:resolve(output,`${name}-failure.png`),fullPage:true});results.push({name,passed:false,error:error.message,errors});throw error;}finally{await context.close();}
}}finally{await writeFile(resolve(output,'report.json'),JSON.stringify({browser:browser.version(),syntheticApis:true,productionMessagesSent:0,results},null,2));await browser.close();await new Promise(r=>server.close(r));}

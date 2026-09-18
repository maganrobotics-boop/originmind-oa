// Two independent authenticated users, real OA components, synthetic APIs only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const root=resolve('parity-validation/browser-app'), output=resolve('parity-validation/member-chat-report');
await mkdir(output,{recursive:true});
const server=createServer(async(req,res)=>{
  try { const url=new URL(req.url,'http://localhost');const path=resolve(root,`.${url.pathname==='/'?'/index.html':url.pathname}`);if(!path.startsWith(root+sep))throw Error('path');const bytes=await readFile(path);res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css'})[extname(path)]||'application/octet-stream');res.end(bytes); }
  catch {res.writeHead(404);res.end('not found');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true});const results=[];
const people=[{email:'a@example.test',name:'成员甲'},{email:'b@example.test',name:'成员乙'}];
const directory=[...people,...Array.from({length:24},(_,i)=>({email:`synthetic-${i}@example.test`,name:`测试成员${String(i+1).padStart(2,'0')}`}))];
const fullAnswer='# 机器人测试结果\n\n**可直接阅读的结论**\n\n|指标|结果|\n|---|---|\n|误差|$e^2$|\n\n'+'这段内容必须完整转发给成员。'.repeat(200)+'\n\n**正文完整结束**';
try {
 for(const [name,width,height] of [['desktop',1280,900],['mobile',390,844],['mobile-short',390,560]]){
  const store=[],posts=[],apiCalls=[],errors=[];const contexts=[];
  const open=async person=>{
   const context=await browser.newContext({viewport:{width,height},serviceWorkers:'block'});contexts.push(context);const page=await context.newPage();
   page.on('pageerror',e=>errors.push(e.message));page.on('dialog',dialog=>dialog.accept());
   await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();if(!url.pathname.startsWith('/api/'))return route.continue();
    apiCalls.push({user:person.email,path:url.pathname,method:req.method()});let data={conversations:[],messages:[],unreadCount:0};
    if(url.pathname==='/api/session') data={registered:true,status:'active',user:{email:person.email,displayName:person.name,authProvider:'github'},role:'project_owner',isAdmin:true,canReviewKnowledge:true,canReviewMembers:true,ndaCompleted:true,needsNda:false};
    else if(url.pathname==='/api/lab-ai/status')data={authorized:true,bridgeReady:true,modelReady:true,knowledgeReady:true,retrievalReady:true,budgetReady:true};
    else if(url.pathname==='/api/lab-ai/ask')data={answer:fullAnswer,mode:'ai',images:[],citations:[]};
    else if(url.pathname==='/api/direct-messages'){
     if(req.method()==='POST'){
      const input=req.postDataJSON();posts.push({person,input});assert.deepEqual(Object.keys(input).sort(),['body','clientMessageId','recipientEmail']);assert.ok(input.recipientEmail!==person.email);const target=people.find(p=>p.email===input.recipientEmail);assert.ok(target);
      let message=store.find(m=>m.id===input.clientMessageId);if(!message){message={id:input.clientMessageId,senderEmail:person.email,senderName:person.name,recipientEmail:target.email,recipientName:target.name,body:input.body,createdAt:new Date().toISOString()};store.push(message);}data={message};
     } else if(url.searchParams.has('with')){const peer=url.searchParams.get('with');data={messages:store.filter(m=>(m.senderEmail===person.email&&m.recipientEmail===peer)||(m.senderEmail===peer&&m.recipientEmail===person.email))};}
     else data={conversations:directory.filter(p=>p.email!==person.email).map(p=>({peer:p,latestMessageId:null,latestCreatedAt:null,latestIncomingId:null}))};
    }else if(url.pathname==='/api/approvals')data={approvals:[]};else if(url.pathname==='/api/members')data={members:[],pendingCount:0};else if(url.pathname==='/api/knowledge')data={items:[],pendingCount:0};else if(url.pathname==='/api/people')data={people:[]};else if(url.pathname==='/api/profile')data={profile:{}};
    return route.fulfill({json:data});
   });
   await page.goto(origin);await page.locator('.oa-shared-chat').waitFor();if(name==='desktop')await page.getByRole('button',{name:'收起侧栏',exact:true}).click();return page;
  };
  const alice=await open(people[0]),bob=await open(people[1]);
  try {
   assert.equal(await alice.locator('.topbar .oa-topbar-user').count(),0);
   assert.equal(await alice.locator('.oa-chat-title > strong').innerText(),'AI 助手');
   await alice.getByRole('button',{name:'聊天选项'}).click();
   await alice.getByRole('menuitem',{name:'成员乙',exact:true}).waitFor();
   assert.equal(await alice.getByRole('menuitem',{name:'AI 助手',exact:true}).count(),1);
   assert.equal(await alice.getByRole('menuitem',{name:'与成员聊天',exact:true}).count(),0);
   assert.equal(await alice.getByRole('menuitem',{name:'转发最近回答',exact:true}).count(),0);
   assert.equal(await alice.getByRole('menuitem',{name:'成员甲',exact:true}).count(),0,'never list the current user as a recipient');
   await alice.getByRole('menuitem',{name:'成员乙',exact:true}).click();
   await alice.locator('.oa-member-title strong').filter({hasText:'成员乙'}).waitFor();
   assert.equal(await alice.getByRole('dialog').count(),0,'a member name opens the conversation without another chooser');
   assert.equal(posts.length,0,'changing destination must not send anything');
   await alice.getByPlaceholder('发送消息给成员乙').fill('只属于成员乙的未发送草稿');
   await alice.getByRole('button',{name:'聊天选项'}).click();await alice.getByRole('menuitem',{name:'AI 助手',exact:true}).click();
   await alice.getByRole('button',{name:'聊天选项'}).click();await alice.getByRole('menuitem',{name:'成员乙',exact:true}).click();
   assert.equal(await alice.getByPlaceholder('发送消息给成员乙').inputValue(),'只属于成员乙的未发送草稿');
   await alice.getByRole('button',{name:'聊天选项'}).click();await alice.getByRole('menuitem',{name:'AI 助手',exact:true}).click();
   await alice.getByPlaceholder('询问实验室大数据').fill('请给出完整测试结果');await alice.getByPlaceholder('询问实验室大数据').press('Enter');
   await alice.locator('.message.assistant').waitFor();assert.ok((await alice.locator('.message.assistant').innerText()).includes('正文完整结束'));
   await alice.getByRole('button',{name:'转发回答给成员'}).click();await alice.getByRole('button',{name:'选择 成员乙'}).click();
   assert.equal(posts.length,0,'selecting a person must not send automatically');
   const preview=await alice.getByLabel('确认发送内容').inputValue();assert.ok(preview.includes('正文完整结束'));assert.ok(preview.length>1000);assert.ok(!preview.includes('http'));
   await alice.screenshot({path:resolve(output,`${name}-forward-preview.png`),fullPage:true});
   await alice.getByRole('button',{name:'取消',exact:true}).click();assert.equal(posts.length,0,'cancelling a preview must not send');
   await alice.getByRole('button',{name:'转发回答给成员'}).click();await alice.getByRole('button',{name:'选择 成员乙'}).click();
   await alice.getByRole('button',{name:'确认发送',exact:true}).click();await alice.locator('.oa-member-title strong').filter({hasText:'成员乙'}).waitFor();
   assert.equal(posts.length,1);assert.equal(posts[0].input.body,preview);assert.equal(store[0].senderName,'成员甲');
   await bob.getByRole('button',{name:'聊天选项'}).click();await bob.getByRole('menuitem',{name:'成员甲',exact:true}).click();
   await bob.locator('.oa-direct-message').filter({hasText:'正文完整结束'}).waitFor();assert.equal(await bob.locator('.oa-member-title strong').innerText(),'成员甲');
   assert.equal(await bob.locator('.oa-member-message-body table').count(),1);assert.ok((await bob.locator('.oa-direct-message-meta').innerText()).includes('成员甲'));
   await bob.getByPlaceholder('发送消息给成员甲').fill('已收到全部正文，我来复核。');await bob.getByRole('button',{name:'发送给成员甲',exact:true}).click();
   await alice.getByText('已收到全部正文，我来复核。',{exact:true}).waitFor({timeout:15000});
   assert.equal(apiCalls.filter(c=>c.path==='/api/lab-ai/ask').length,1,'member messages must never go through AI');
   await alice.screenshot({path:resolve(output,`${name}-two-way-chat.png`),fullPage:true});
   await alice.getByRole('button',{name:'聊天选项'}).click();await alice.getByRole('menuitem',{name:'AI 助手',exact:true}).click();await alice.locator('.oa-conversation-ai').waitFor({state:'visible'});await alice.locator('.oa-member-title').waitFor({state:'detached'});assert.ok((await alice.locator('.message.assistant').innerText()).includes('正文完整结束'));
   await alice.getByRole('button',{name:'聊天选项'}).click();await alice.getByRole('menuitem',{name:'清空聊天',exact:true}).click();await alice.getByText('想了解实验室的什么？',{exact:true}).waitFor();assert.equal(store.length,2,'clearing AI must not delete member messages');
   await alice.getByRole('button',{name:name==='desktop'?'展开侧栏':'打开导航',exact:true}).click();const nav=alice.locator(name==='desktop'?'.oa-desktop-navigation':'.mobile-sidebar');
   assert.equal(await nav.locator('.oa-sidebar-new-chat').count(),1);assert.equal(await nav.locator('.oa-sidebar-account').count(),1);
   // Wait only for the horizontal entrance animation. Never scroll the footer into view.
   if(name!=='desktop')await alice.waitForFunction(()=>{const el=document.querySelector('.mobile-sidebar.open');return el&&Math.abs(el.getBoundingClientRect().left)<0.5;});
   for(const visibleHeight of name==='desktop'?[height]:[height,480,720]){
    await alice.setViewportSize({width,height:visibleHeight});
    const footer=await nav.evaluate(element=>{
      const targets=['.oa-sidebar-new-chat','.oa-sidebar-account'].map(selector=>{
       const el=element.querySelector(selector),r=el.getBoundingClientRect();
       return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,hit:el.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))};
      });
      return {targets,height:innerHeight,width:innerWidth};
    });
    console.log(`${name} footer ${visibleHeight}: ${JSON.stringify(footer)}`);
    assert.ok(footer.targets.every(r=>r.top>=0&&r.bottom<=footer.height&&r.left>=0&&r.right<=footer.width&&r.hit),'account and new-chat controls must be visible and hittable without scrolling');
    const before=await nav.locator('.oa-sidebar-bottom').boundingBox();
    await nav.locator('.oa-sidebar-scroll').evaluate(el=>{el.scrollTop=el.scrollHeight;});
    const after=await nav.locator('.oa-sidebar-bottom').boundingBox();assert.ok(Math.abs(before.y-after.y)<1,'only the middle navigation scrolls');
   }
   await alice.screenshot({path:resolve(output,`${name}-visible-account-footer.png`),fullPage:true});
   await nav.getByRole('button',{name:'审批工作台',exact:true}).click();assert.equal(await alice.locator('.dashboard-ai-entry').count(),0);
   assert.ok(posts.every(p=>!('senderName'in p.input)&&!('senderEmail'in p.input)));assert.ok(apiCalls.every(c=>c.method==='GET'||['/api/lab-ai/ask','/api/direct-messages'].includes(c.path)));
   assert.deepEqual(errors,[]);results.push({name,passed:true,directMemberMenu:true,memberDraftRetained:true,footerHitTest:true,forwardedCharacters:preview.length,explicitConfirmation:true,currentUserSender:true,recipientReply:true,noAiOnPrivateMessages:true,noProductionData:true});
   console.log(`${name}: direct names, drafts, fixed account footer, explicit forwarding, full content and two-way reply passed`);
  }catch(error){await alice.screenshot({path:resolve(output,`${name}-failure.png`),fullPage:true});results.push({name,passed:false,error:error.message,errors});throw error;}
  finally{for(const c of contexts)await c.close();}
 }
}finally{await writeFile(resolve(output,'report.json'),JSON.stringify({syntheticApis:true,productionMessagesSent:0,results},null,2));await browser.close();await new Promise(r=>server.close(r));}

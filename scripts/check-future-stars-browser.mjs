import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
const require=createRequire(import.meta.url);
const { chromium }=require(require.resolve('playwright',{paths:[process.cwd(),process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES].filter(Boolean)}));
const root=fileURLToPath(new URL('..',import.meta.url));
const server=await createServer({root,configFile:false,appType:'custom',resolve:{alias:{'@':root}},plugins:[react(),{
 name:'stars-browser-fixture',configureServer(server){server.middlewares.use(async(req,res,next)=>{
  if(req.url!=='/')return next();res.setHeader('content-type','text/html');
  res.end(await server.transformIndexHtml('/', '<html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#f6f8f5}*{box-sizing:border-box}</style></head><body><div id="root"></div><script type="module" src="/tests/fixtures/future-stars-browser.tsx"></script></body></html>'));
 });}
}],server:{host:'127.0.0.1',port:0}, optimizeDeps:{entries:['tests/fixtures/future-stars-browser.tsx']}});
await server.listen();
const port=server.httpServer.address().port;
let browser;
const errors=[],checks=[];
const now=1791295200000;
const student=(name,progress)=>({email:name+'@test.cn',displayName:name,signerName:'',grade:'2026',major:'机器人',direction:'navigation',agreementStatus:'not_signed',registeredAt:now,lastActivityAt:now-1000,completed:0,
 learning:[{courseId:'final',title:'毕业项目',submissions:progress,reviewed:1}],recentSubmitted:1,currentCourseTitle:'毕业项目',currentStage:'实战营',
 stageProgress:[{id:'capstone',title:'实战营',total:4,submitted:progress,completed:progress,exempted:0}],overall:{total:4,submitted:progress,completed:progress,exempted:0,started:progress},
 progress:{foundationCourseIds:[],foundationCompletedCourseIds:[],submittedCourseIds:[],exemptedCourseIds:[]},graduation:{status:'not_attempted'}});
const result={id:'run-test',createdAt:new Date(now-1000).toISOString(),mapId:'map-a',mapName:'合成测试地图',status:'COMPLETE',ranked:true,rankTime:80,time:1,found:10,total:10,returned:true,quickPractice:false};
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.FUTURE_STARS_BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
 for(const width of [1280,390,320]){
  const page=await browser.newPage({viewport:{width,height:960}});page.on('pageerror',e=>errors.push(e.message));
  let source='connected';let delayed=false;const requests=[];
  await page.route('**/api/admin/future-stars?*',async route=>{
   const u=new URL(route.request().url()),view=u.searchParams.get('view'),window=u.searchParams.get('window');requests.push(u);
   let data;
   if(view==='students'){
    data={records:window==='24h'?[student('24小时学员',3)]:window==='3d'?[student('3天学员',2)]:[],courses:[{id:'final',title:'毕业项目'}],
     summary:{onlineCounts:{'24h':1,'3d':2,'7d':3},active:1,progressed:1,newSubmissions:1},asOf:now,pagination:{page:1,total:1,totalPages:1},progressNote:'合成测试数据'};
    if(delayed&&window==='3d')await new Promise(resolve=>setTimeout(resolve,250));
   } else if(view==='records')data={records:[{id:'evidence',title:'完整学习记录',createdAt:now,reviewState:'done',review:'合成点评'}],pagination:{totalPages:1}};
   else if(view==='arena')data={window,mode:'full',mapId:'map-a',maps:[{id:'map-a',name:'合成测试地图'}],asOf:now,source:{status:source,message:source==='not_connected'?'数据源未接入':'测试状态'},
    summary:{onlineCounts:{'24h':source==='connected'?4:null,'3d':source==='connected'?5:null,'7d':source==='connected'?6:null},active:4,tested:1,tests:1,completed:1,unavailable:source==='partial'?1:0},
    records:source==='connected'?[{email:'arena@test.cn',displayName:'竞技场用户',lastSeen:now,testCount:1,completedCount:1,best:result,latest:result,recentResults:[result],pendingJobs:0,resultsError:''}]:[],pagination:{page:1,total:1,totalPages:1},note:'合成测试数据'};
   else data={awards:[],hasMore:false};
   try{await route.fulfill({json:data});}catch{/* request intentionally cancelled during a window switch */}
  });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByRole('heading',{name:'24小时学员',exact:true}).waitFor();
  assert.equal(await page.getByLabel('排序方式',{exact:true}).inputValue(),'progress');
  await page.getByLabel('筛选课程',{exact:true}).selectOption('final');
  await page.getByRole('button',{name:'查看全部学习进度'}).click();
  await page.getByText('完整学习记录',{exact:true}).waitFor();
  assert.equal(requests.filter(u=>u.searchParams.get('view')==='records').at(-1).searchParams.has('courseId'),false);
  await page.keyboard.press('Escape');
  delayed=true;
  await page.getByRole('button',{name:/近3天/}).click();
  await page.getByRole('button',{name:/近7天/}).click();
  await page.getByText('所选时段没有符合条件的上线学员。',{exact:true}).waitFor();
  await page.waitForTimeout(300);
  assert.equal(await page.getByRole('heading',{name:'3天学员',exact:true}).count(),0);
  checks.push(`${width}px: course default order, all-record drilldown, latest-window response and empty state`);
  await page.getByRole('button',{name:'竞技场上线与成绩',exact:true}).click();
  await page.getByRole('heading',{name:'竞技场用户',exact:true}).waitFor();
  assert.ok(await page.getByText('已完成 · 平均用时 1分20.0秒',{exact:true}).count()>0);
  await page.getByRole('button',{name:/近3天/}).click();
  await page.getByRole('heading',{name:'竞技场用户',exact:true}).waitFor();
  assert.equal(requests.at(-1).searchParams.get('window'),'3d');
  source='not_connected';await page.getByRole('button',{name:'刷新',exact:true}).click();
  await page.getByText('数据源未接入',{exact:true}).waitFor();
  assert.equal(await page.getByText('所选时段没有符合条件的上线用户。',{exact:true}).count(),0);
  assert.equal((await page.locator('.fs-time-card strong').first().innerText()).replace(/\s/g,''),'—人上线');
  source='partial';await page.getByRole('button',{name:'刷新',exact:true}).click();
  await page.getByRole('alert').waitFor();
  assert.equal(await page.getByText('暂未读到符合条件的记录，数据不完整。',{exact:true}).count(),1);
  const dimensions=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth}));
  assert.ok(dimensions.scroll<=dimensions.width,JSON.stringify(dimensions));
  await page.getByRole('button',{name:'获奖登记',exact:true}).click();
  await page.getByRole('heading',{name:'竞技赛获奖',exact:true}).waitFor();
  checks.push(`${width}px: independent Arena windows, official score, disconnected/partial states, awards and no overflow`);
  await page.close();
 }
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({checks,errors,syntheticApi:true},null,2));
}finally{await browser?.close();await server.close();}

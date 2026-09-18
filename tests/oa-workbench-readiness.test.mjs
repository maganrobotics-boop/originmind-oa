/** Execute the real TSX event logic with synthetic React hooks and HTTP responses. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

function compile(path, modules) {
  const output=ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  const module={exports:{}};
  new Function('require','module','exports',output)(name=>{if(!Object.hasOwn(modules,name))throw new Error(`Unexpected test import: ${name}`);return modules[name];},module,module.exports);
  return module.exports;
}
function uiHarness() {
  const slots=[], effects=[]; let cursor=0;
  const same=(a,b)=>a&&b&&a.length===b.length&&a.every((value,index)=>Object.is(value,b[index]));
  const react={
    useState(initial){const index=cursor++;if(!slots[index])slots[index]={value:initial};return [slots[index].value,value=>{slots[index].value=typeof value==='function'?value(slots[index].value):value;}];},
    useRef(initial){const index=cursor++;return slots[index]||(slots[index]={current:initial});},
    useCallback(fn,deps){const index=cursor++;if(!slots[index]||!same(slots[index].deps,deps))slots[index]={deps,fn};return slots[index].fn;},
    useEffect(fn,deps){const index=cursor++;if(!slots[index]||!same(slots[index].deps,deps)){const previous=slots[index];slots[index]={deps};effects.push(()=>{previous?.cleanup?.();slots[index].cleanup=fn();});}},
  };
  const jsx=(type,props)=>({type,props:props||{}});
  const {default:Page}=compile('../app/ai-workbench/page.tsx',{
    react,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'fragment'},'next/link':{__esModule:true,default:'a'},
    '../../lib/ai-workbench-core.mjs':{TASK_KINDS:{document:'文档整理'}},
    '../../lib/oa-chat-renderer.mjs':{renderAnswerBody(){throw new Error('Not rendering generated content in readiness tests');}},'./workbench.css':{},
  });
  const walk=(node,predicate)=>{
    if(Array.isArray(node))return node.flatMap(item=>walk(item,predicate));
    if(!node||typeof node!=='object')return [];
    return [...(predicate(node)?[node]:[]),...walk(node.props?.children,predicate)];
  };
  return {
    render(){cursor=0;const tree=Page();while(effects.length)effects.shift()();return tree;},
    find(tree,predicate){const results=walk(tree,predicate);assert.ok(results.length,'Expected UI element is present');return results[0];},
    dispose(){for(const slot of slots)slot?.cleanup?.();},
  };
}
const settle=()=>new Promise(setImmediate);
const json=(body,status=200)=>Response.json(body,{status});
async function withUi(fetcher,run) {
  const originals={fetch:globalThis.fetch,window:globalThis.window,document:globalThis.document};
  globalThis.fetch=fetcher;
  globalThis.window={location:{search:''},setInterval:()=>1,clearInterval(){}};
  globalThis.document={visibilityState:'visible'};
  const ui=uiHarness();
  try {ui.render();await settle();await run(ui);} finally {ui.dispose();for(const [key,value] of Object.entries(originals)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
}
const primary=node=>node.props.className==='workbench-primary';
const status=node=>node.props.id==='workbench-submit-status';
const textareas=node=>node.type==='textarea'&&node.props.maxLength===20000;

test('disabled service shows its reason beside an actionable check button, without submitting', async()=>{
  const methods=[];
  await withUi(async(_url,options)=>{methods.push(options.method);return json({error:'AI 工作台尚未启用。'},503);},async ui=>{
    let tree=ui.render();
    ui.find(tree,textareas).props.onChange({target:{value:'不能丢失的合成材料'}});tree=ui.render();
    const button=ui.find(tree,primary);assert.equal(button.props.disabled,false);assert.equal(button.props.type,'button');
    assert.match(JSON.stringify(ui.find(tree,status)),/尚未启用/);
    button.props.onClick();await settle();tree=ui.render();
    assert.equal(ui.find(tree,textareas).props.value,'不能丢失的合成材料');
    assert.deepEqual(methods,['GET','GET']);assert.equal(ui.find(tree,primary).props.type,'button');
  });
});
test('rechecking after activation enables execution without reloading or clearing materials', async()=>{
  let active=false;const methods=[];
  await withUi(async(_url,options)=>{methods.push(options.method);return active?json({tasks:[]}):json({error:'任务数据库尚未就绪'},503);},async ui=>{
    let tree=ui.render();ui.find(tree,textareas).props.onChange({target:{value:'合成材料保留'}});tree=ui.render();
    active=true;ui.find(tree,primary).props.onClick();await settle();tree=ui.render();
    assert.equal(ui.find(tree,primary).props.type,'submit');assert.equal(ui.find(tree,primary).props.disabled,false);
    assert.equal(ui.find(tree,textareas).props.value,'合成材料保留');assert.match(JSON.stringify(ui.find(tree,status)),/服务已就绪/);
    assert.deepEqual(methods,['GET','GET']);
  });
});
test('HTML login responses and incomplete JSON cannot masquerade as a ready empty task list', async()=>{
  for(const makeResponse of [()=>new Response('<html>Sign in</html>'),()=>json({})]) {
    await withUi(async()=>makeResponse(),async ui=>{
      const tree=ui.render();assert.equal(ui.find(tree,primary).props.type,'button');
      assert.match(JSON.stringify(ui.find(tree,status)),/服务|响应/);
    });
  }
});
test('expired sessions show a local reason instead of a silent grey button', async()=>{
  await withUi(async()=>json({error:'请先登录 OA。'},401),async ui=>{
    const tree=ui.render();assert.equal(ui.find(tree,primary).props.disabled,false);
    assert.match(JSON.stringify(ui.find(tree,status)),/请先登录/);
  });
});
test('rapid repeated readiness clicks share one pending check', async()=>{
  let calls=0,resolve;
  await withUi(async()=>{calls++;if(calls===1)return json({error:'未启用'},503);return new Promise(r=>{resolve=r;});},async ui=>{
    const button=ui.find(ui.render(),primary);button.props.onClick();button.props.onClick();
    assert.equal(calls,2);resolve(json({tasks:[]}));await settle();assert.equal(ui.find(ui.render(),primary).props.type,'submit');
  });
});

function apiHarness({enabled=true,missing=false,user=true}={}) {
  const calls=[];let lists=0;
  const db={prepare(sql){calls.push(sql);return {async all(){if(missing&&sql.includes('ai_workbench_artifacts'))throw new Error('synthetic unavailable storage');return {results:[]};}};}};
  const actor=user?{ndaCompleted:true,memberId:'member',accountUserId:'account',memberMutationRevision:'revision'}:null;
  const api=compile('../app/api/lab-ai/tasks/route.ts',{
    '../../../../db':{getD1Database:async()=>db},'../../_lib/auth':{getAuthorizedUser:async()=>actor},
    '../../../../lib/bounded-json-request':{},'../../../../lib/oa-chat-client':{generateOaTask:async()=>{throw new Error('A readiness check must not call a model');}},
    '../../../../lib/ai-workbench-core.mjs':{},'../../../../lib/ai-workbench-artifacts.mjs':{},
    '../../../../lib/ai-workbench-store':{listTasks:async()=>{lists++;return [];}},
    'cloudflare:workers':{env:{OA_AI_TASKS_ENABLED:enabled?'true':'false'}},
  });
  return {api,calls,listCount:()=>lists};
}
const apiRequest=()=>new Request('https://oa.example.test/api/lab-ai/tasks');
test('API distinguishes a disabled workbench without accessing task storage',async()=>{
  const h=apiHarness({enabled:false});const result=await h.api.GET(apiRequest());
  assert.equal(result.status,503);assert.equal((await result.json()).code,'TASKS_DISABLED');assert.equal(h.calls.length,0);
});
test('API checks artifact storage before claiming task-list readiness',async()=>{
  const h=apiHarness({missing:true});const result=await h.api.GET(apiRequest());
  assert.equal(result.status,503);assert.equal((await result.json()).code,'TASK_SCHEMA_UNAVAILABLE');assert.equal(h.listCount(),0);
});
test('API retains admission gating and allows initialized authenticated task lists',async()=>{
  const h=apiHarness();assert.equal((await h.api.GET(apiRequest())).status,200);assert.equal(h.calls.length,2);assert.equal(h.listCount(),1);
  const other=apiHarness({user:false});assert.equal((await other.api.GET(apiRequest())).status,401);assert.equal(other.calls.length,0);
});

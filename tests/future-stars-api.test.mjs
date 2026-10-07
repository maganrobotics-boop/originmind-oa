import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
const key = '__futureStarsApiTest';
const admin = { isAdmin:true, ndaCompleted:true, memberId:'m', accountUserId:'account:admin', memberMutationRevision:'v1', user:{email:'admin@test.cn'} };
const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({ root, configFile:false, appType:'custom', optimizeDeps:{noDiscovery:true,include:[]}, server:{middlewareMode:true,hmr:false}, plugins:[{
  name:'future-stars-test-boundaries', enforce:'pre',
  resolveId(source) {
    if (source.endsWith('/_lib/auth')) return '\0stars-auth';
    if (source.endsWith('/future-stars-client')) return '\0stars-client';
    if (source.endsWith('/write-rate-limit')) return '\0stars-rate';
    if (source.endsWith('/db')) return '\0stars-db';
  },
  load(id) {
    if(id==='\0stars-auth') return `export async function getAuthorizedUser(options){globalThis.${key}.auth.push(options);return globalThis.${key}.user;}`;
    if(id==='\0stars-client') return `export class FutureStarsError extends Error{constructor(message,status){super(message);this.status=status;}} export async function callFutureStars(payload){globalThis.${key}.calls.push(payload);return {summary:{active:0}};}`;
    if(id==='\0stars-rate') return 'export async function consumeWriteRateLimit(){return true;}';
    if(id==='\0stars-db') return 'export async function getDb(){return {}};';
  },
}] });
const route=await server.ssrLoadModule('/app/api/admin/future-stars/route.ts');
beforeEach(()=>{globalThis[key]={user:admin,calls:[],auth:[]};});
after(async()=>{await server.close();delete globalThis[key];});
const get=(query)=>route.GET(new Request('https://oa.test/api/admin/future-stars?'+query));
test('anonymous and non-admin users cannot retrieve either dashboard',async()=>{
 for(const user of [null,{...admin,isAdmin:false},{...admin,ndaCompleted:false},{...admin,accountUserId:null}]){
  globalThis[key].user=user;
  for(const view of ['students','arena'])assert.equal((await get('view='+view)).status,user?403:401);
 }
 assert.equal(globalThis[key].calls.length,0);
});
test('all windows use read-only authorization, server actor and no-store responses',async()=>{
 for(const view of ['students','arena'])for(const window of ['24h','3d','7d']){
  const response=await get(`view=${view}&window=${window}`);
  assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/private, no-store/);
  assert.equal(response.headers.get('vary'),'Cookie');
  assert.deepEqual(globalThis[key].calls.at(-1).actor,{email:admin.user.email,subject:admin.accountUserId});
  assert.equal(globalThis[key].calls.at(-1).params.window,window);
 }
 assert.ok(globalThis[key].auth.every(options=>options.readOnly===true));
});
test('duplicate parameters, unsupported windows and identity or endpoint overrides are rejected',async()=>{
 for(const query of ['view=arena&window=all','view=students&window=','view=arena&window=7d&window=24h','view=arena&owner=forged','view=arena&url=https://other.test','view=students&actor=x','view=arena&sort=bad','view=arena&page=0','view=arena&mode=all'])assert.equal((await get(query)).status,400,query);
 assert.equal(globalThis[key].calls.length,0);
});
test('cross-site writes and POST arena controls never reach the service',async()=>{
 const response=await route.POST(new Request('https://oa.test/api/admin/future-stars',{method:'POST',headers:{origin:'https://evil.test','content-type':'application/json'},body:JSON.stringify({action:'arena'})}));
 assert.equal(response.status,403);
 const control=await route.POST(new Request('https://oa.test/api/admin/future-stars',{method:'POST',headers:{origin:'https://oa.test','content-type':'application/json'},body:JSON.stringify({action:'arena',body:{action:'delete'}})}));
 assert.equal(control.status,400);assert.equal(globalThis[key].calls.length,0);
});

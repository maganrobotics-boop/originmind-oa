/** Test-only runtime boundaries. Production task/store/artifact code stays unmodified. */
import { readFileSync, existsSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const root = new URL('../../', import.meta.url).href;
const mocks = {
  env: 'export const env = new Proxy({}, {get:(_,k)=>globalThis.__aiWorkbenchTest.env[k]});',
  auth: 'export const getAuthorizedUser = async()=>globalThis.__aiWorkbenchTest.actor;',
  db: 'export const getD1Database = async()=>globalThis.__aiWorkbenchTest.env.DB;',
  model: 'export const generateOaTask = async(input)=>globalThis.__aiWorkbenchTest.generate(input);',
};
export async function resolve(source, context, nextResolve) {
  if (context.parentURL?.endsWith('/chat-cloudflare/src/oa-chat-bridge.mjs') && ['./knowledge.mjs', './grounded-prompt.mjs'].includes(source)) {
    const name = source === './knowledge.mjs' ? 'fallbackAnswer' : 'buildGroundedChatMessages';
    return { url: `data:text/javascript,${encodeURIComponent(`export function ${name}(){throw new Error('Unexpected knowledge fallback in document-task test');}`)}`, shortCircuit: true };
  }
  if (context.parentURL?.startsWith(root)) {
    const mock = source === 'cloudflare:workers' ? 'env' : source.endsWith('/_lib/auth') ? 'auth'
      : source.endsWith('/oa-chat-client') ? 'model' : source.endsWith('/db') ? 'db' : null;
    if (mock) return { url: `data:text/javascript,${encodeURIComponent(mocks[mock])}`, shortCircuit: true };
    if (source.startsWith('.') && !/\.[cm]?[jt]sx?$/u.test(source)) {
      const url = new URL(`${source}.ts`, context.parentURL);
      if (existsSync(url)) return { url: url.href, shortCircuit: true };
    }
  }
  return nextResolve(source, context);
}
export async function load(url, context, nextLoad) {
  if (url.startsWith(root) && url.endsWith('.ts')) {
    return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'strip' }), shortCircuit: true };
  }
  return nextLoad(url, context);
}

import { readFileSync, existsSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const root = new URL('../../', import.meta.url).href;
const state = 'globalThis.__oaChatFileTests';
const mocks = {
  env: `export const env = new Proxy({}, {get:(_,k)=>${state}.env[k]});`,
  auth: `export const getAuthorizedUser = async()=>${state}.actor;`,
  db: `export const getD1Database=async()=>${state}.db; export const getDb=async()=>({$client:${state}.db});`,
  rate: `export const consumeWriteRateLimit=async()=>${state}.allowed;`,
};
export async function resolve(source, context, nextResolve) {
  if (context.parentURL?.startsWith(root)) {
    const mock = source === 'cloudflare:workers' ? 'env' : source.endsWith('/_lib/auth') ? 'auth'
      : source.endsWith('/write-rate-limit') ? 'rate' : source.endsWith('/db') ? 'db' : null;
    if (mock) return { url: `data:text/javascript,${encodeURIComponent(mocks[mock])}`, shortCircuit: true };
    if (source.startsWith('.') && !/\.[cm]?[jt]sx?$/u.test(source)) {
      const url = new URL(`${source}.ts`, context.parentURL);
      if (existsSync(url)) return { url: url.href, shortCircuit: true };
    }
  }
  return nextResolve(source, context);
}
export async function load(url, context, nextLoad) {
  if (url.startsWith(root) && url.endsWith('.ts')) return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'strip' }), shortCircuit: true };
  return nextLoad(url, context);
}

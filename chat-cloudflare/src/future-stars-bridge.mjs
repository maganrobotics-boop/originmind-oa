// Copyright (c) 2026 OriginMind. All rights reserved.
import { PublicError } from './errors.mjs';
import { ACTIVITY_WINDOWS } from './activity-windows.mjs';

export const FUTURE_STARS_PATH = '/api/internal/oa-future-stars';
export const FUTURE_STARS_ORIGIN = 'https://chat.omindos.cn';
const encoder = new TextEncoder();
const response = (value, status = 200) => Response.json(value, { status, headers: {
  'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
}});
const signedBytes = (timestamp, nonce, body) => encoder.encode(`oa-future-stars/v1\nPOST\n${FUTURE_STARS_PATH}\n${timestamp}\n${nonce}\n${body}`);
async function key(secret, usages) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('SERVICE_UNAVAILABLE');
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}
export async function signFutureStarsRequest(body, secret, { now = Date.now(), nonce = crypto.randomUUID() } = {}) {
  const timestamp = String(Math.floor(now / 1000));
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret, ['sign']), signedBytes(timestamp, nonce, body)));
  return { 'content-type': 'application/json', accept: 'application/json',
    'x-oa-stars-time': timestamp, 'x-oa-stars-nonce': nonce,
    authorization: `OA-STARS-HMAC ${Array.from(signature, byte => byte.toString(16).padStart(2, '0')).join('')}` };
}
export async function boundedStarsJson(request, maximum = 16000) {
  if (!request.headers.get('content-type')?.startsWith('application/json') || !request.body) throw new PublicError('请求格式不正确。', 415);
  const reader = request.body.getReader(), parts = []; let length = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break;
      length += value.length; if (length > maximum) { await reader.cancel(); throw new PublicError('请求内容过长。', 413); } parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
export function validStarsPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(k => !['actor', 'operation', 'params', 'body'].includes(k))) return false;
  const actor = value.actor;
  if (!actor || typeof actor !== 'object' || Array.isArray(actor) || Object.keys(actor).some(k => !['email', 'subject'].includes(k)) ||
      typeof actor.email !== 'string' || actor.email.length > 254 || !/^[^\s@]+@[^\s@]+$/u.test(actor.email) ||
      typeof actor.subject !== 'string' || actor.subject.length < 1 || actor.subject.length > 200) return false;
  const keys = { arena: ['q','page','window','sort','mapId','mode'], people: ['q', 'page', 'courseId', 'status', 'window', 'sort'], records: ['email', 'courseId', 'page'],
    honors: ['category', 'status', 'page'], recipients: ['q'], events: ['id'], grant: [], honor_action: ['id'] };
  if (!Object.hasOwn(keys, value.operation)) return false;
  const params = value.params ?? {};
  if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(k => !keys[value.operation].includes(k)) ||
      Object.values(params).some(v => typeof v !== 'string' || v.length > 254)) return false;
  if (['people', 'arena'].includes(value.operation)) {
    if (params.window !== undefined && !Object.hasOwn(ACTIVITY_WINDOWS, params.window)) return false;
    if (params.page !== undefined && !/^[1-9]\d{0,4}$/u.test(params.page)) return false;
    if (params.q !== undefined && params.q.length > 100) return false;
    const sorts = value.operation === 'people' ? ['progress', 'fastest', 'recent'] : ['best', 'recent', 'tests'];
    if (params.sort !== undefined && !sorts.includes(params.sort)) return false;
    if (value.operation === 'arena' && ((params.mode !== undefined && !['auto', 'full', 'quick'].includes(params.mode)) ||
      (params.mapId && !/^[A-Za-z0-9_-]{1,128}$/u.test(params.mapId)))) return false;
  }
  const writing = ['grant', 'honor_action'].includes(value.operation);
  return writing ? Boolean(value.body && typeof value.body === 'object' && !Array.isArray(value.body)) : value.body === undefined;
}
export async function handleFutureStarsBridge(context, engine, now = Date.now()) {
  const request = context.request;
  if (new URL(request.url).pathname !== FUTURE_STARS_PATH || request.method !== 'POST') return response({ error: '接口不存在。' }, 404);
  if (request.headers.has('origin') || request.headers.has('cookie')) return response({ error: '仅限 OA 管理服务。' }, 401);
  const timestamp = request.headers.get('x-oa-stars-time') || '', nonce = request.headers.get('x-oa-stars-nonce') || '';
  const signature = /^OA-STARS-HMAC ([a-f0-9]{64})$/u.exec(request.headers.get('authorization') || '')?.[1];
  if (!signature || !/^\d{10,12}$/u.test(timestamp) || Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 60 || !/^[a-f0-9-]{36}$/u.test(nonce)) return response({ error: '服务认证失败。' }, 401);
  try {
    const raw = await boundedStarsJson(request);
    const signatureBytes = Uint8Array.from(signature.match(/../gu), value => parseInt(value, 16));
    if (!await crypto.subtle.verify('HMAC', await key(context.env.PUBLIC_LAB_AI_SERVICE_TOKEN, ['verify']), signatureBytes, signedBytes(timestamp, nonce, raw))) return response({ error: '服务认证失败。' }, 401);
    let payload; try { payload = JSON.parse(raw); } catch { throw new PublicError('请求格式不正确。', 400); }
    if (!validStarsPayload(payload)) throw new PublicError('管理内容不正确。', 400);
    await engine.claimRequest(nonce);
    const result = await engine.handle(payload);
    const data = await result.json();
    return response({ ...data, ...(result.ok ? { received: true } : {}) }, result.status);
  } catch (error) {
    if (error instanceof PublicError) return response({ error: error.message }, error.status);
    return response({ error: '未来之星管理服务暂不可用。' }, 503);
  }
}

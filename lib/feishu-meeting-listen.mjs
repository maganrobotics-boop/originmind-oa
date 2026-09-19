/** Optional UAT-only Feishu listening. Existing OA login/approval flows are not changed. */
import { validMeetingId, normalizeMeetingEvents } from './oa-meeting-capture.mjs';
export const MEETING_SCOPE = 'vc:meeting.meetingevent:read';
export const MEETING_PATH = '/api/lab-ai/meeting-listen';
export const GRANT_COOKIE = '__Host-oa_meeting_grant';
export const STATE_COOKIE = '__Host-oa_meeting_state';
const API = 'https://open.feishu.cn';
const encoder = new TextEncoder();
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const b64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/=/gu, '').replace(/\+/gu, '-').replace(/\//gu, '_');
function bytes(value) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('MEETING_AUTH');
  return Uint8Array.from(atob(value.replace(/-/gu, '+').replace(/_/gu, '/')), c => c.charCodeAt(0));
}
export function validTokenKey(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/iu.test(value); }
async function cryptoKey(secret) {
  if (!validTokenKey(secret)) throw new Error('MEETING_CONFIG');
  return crypto.subtle.importKey('raw', Uint8Array.from(secret.match(/../gu), x => parseInt(x, 16)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(value, secret, audience) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(audience) }, await cryptoKey(secret), encoder.encode(JSON.stringify(value)));
  const result = `${b64(iv)}.${b64(new Uint8Array(encrypted))}`;
  if (result.length > 3600) throw new Error('MEETING_COOKIE_SIZE');
  return result;
}
export async function unseal(value, secret, audience, now = Date.now()) {
  try {
    if (typeof value !== 'string' || value.length > 3600) return null;
    const parts = value.split('.'); if (parts.length !== 2) return null;
    const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(parts[0]), additionalData: encoder.encode(audience) }, await cryptoKey(secret), bytes(parts[1]));
    const parsed = JSON.parse(new TextDecoder().decode(clear));
    return object(parsed) && Number.isSafeInteger(parsed.exp) && parsed.exp > now ? parsed : null;
  } catch { return null; }
}
export function readCookie(request, name) {
  const matches = (request.headers.get('cookie') || '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : '';
}
function cookie(name, value, age, lax = false) {
  return `${name}=${value}; Path=/; Max-Age=${Math.max(0, Math.floor(age))}; Secure; HttpOnly; SameSite=${lax ? 'Lax' : 'Strict'}`;
}
export function safeReturnPath(value, origin) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020]/u.test(value) || value.length > 1024) return '/';
  try {
    const url = new URL(value, origin);
    return url.origin === origin && !url.pathname.startsWith('/api/') ? `${url.pathname}${url.search}` : '/';
  } catch { return '/'; }
}
const errorLabels = {
  MEETING_AUTH: '飞书旁听授权已失效，请重新授权；OA 登录不等于旁听授权。',
  MEETING_CONFIG: '旁听尚未配置。管理员需设置独立加密密钥、飞书回调地址及启用开关。',
  MEETING_COOKIE_SIZE: '授权凭证超出本版安全存储上限，未保存；需改用服务端凭证库后接入。',
  MEETING_SCOPE: '尚未授予会议事件读取权限，请申请用户身份权限并重新发布飞书应用后授权。',
  MEETING_SCHEMA: '飞书返回格式不符合预期，已暂停；没有把不完整内容标记为成功。',
  MEETING_PERMISSION: '飞书未允许读取。请确认灰度资格、应用用户权限、本人在会和“允许智能体入会”开关。',
  MEETING_UPSTREAM: '飞书暂不可用，已暂停采集；已采集的文字仍在本页，可重试或导出。',
  MEETING_CURSOR: '会议分页游标异常，已暂停；未跳过尚未处理的页面。',
  MEETING_SELECTION: '当前会议信息已变化，请重新选择本人正在参加的会议。',
};
function json(value, status = 200, extra = {}) {
  return Response.json(value, { status, headers: { 'cache-control': 'private, no-store, max-age=0', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...extra } });
}
/** Fixed allowlisted origin, no redirects, bounded body, no raw upstream error/token logging. */
export async function feishuJson(path, options = {}, fetcher = fetch) {
  const allowed = ['/open-apis/vc/v1/bots/user_active_meeting', '/open-apis/vc/v1/bots/events', '/open-apis/authen/v2/oauth/token', '/open-apis/authen/v1/user_info'];
  const url = new URL(path, API);
  if (url.origin !== API || !allowed.includes(url.pathname)) throw new Error('MEETING_UPSTREAM');
  let response;
  try { response = await fetcher(url.href, { ...options, redirect: 'error', signal: AbortSignal.timeout(12000) }); }
  catch { throw new Error('MEETING_UPSTREAM'); }
  if ([401, 403].includes(response.status)) throw new Error('MEETING_PERMISSION');
  if (!response.ok) throw new Error('MEETING_UPSTREAM');
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json') || !response.body) throw new Error('MEETING_SCHEMA');
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 1024 * 1024) { await reader.cancel(); throw new Error('MEETING_SCHEMA'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const all = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  let body;
  try { body = JSON.parse(new TextDecoder().decode(all)); } catch { throw new Error('MEETING_SCHEMA'); }
  if (!object(body)) throw new Error('MEETING_SCHEMA');
  if (body.error || (body.code !== undefined && body.code !== 0)) throw new Error('MEETING_PERMISSION');
  return body;
}
const bearer = token => ({ accept: 'application/json', authorization: `Bearer ${token}` });
export async function activeMeetings(token, fetcher = fetch) {
  const body = await feishuJson('/open-apis/vc/v1/bots/user_active_meeting', { headers: bearer(token) }, fetcher);
  if (!object(body.data) || !Array.isArray(body.data.meetings) || body.data.meetings.length > 20) throw new Error('MEETING_SCHEMA');
  return body.data.meetings.map(item => {
    if (!object(item) || !validMeetingId(item.meeting_id)) throw new Error('MEETING_SCHEMA');
    return { id: item.meeting_id, number: typeof item.meeting_no === 'string' ? item.meeting_no : '', title: typeof item.meeting_title === 'string' ? item.meeting_title.slice(0, 200) : '飞书会议' };
  });
}
export async function eventPage(token, meetingId, cursor = '', fetcher = fetch) {
  if (!validMeetingId(meetingId) || typeof cursor !== 'string' || cursor.length > 4096) throw new Error('MEETING_SELECTION');
  const query = new URLSearchParams({ meeting_id: meetingId, page_size: '100' });
  if (cursor) query.set('page_token', cursor);
  const body = await feishuJson(`/open-apis/vc/v1/bots/events?${query}`, { headers: bearer(token) }, fetcher);
  const data = body.data;
  if (!object(data) || !Array.isArray(data.events) || typeof data.has_more !== 'boolean' || (data.page_token !== undefined && typeof data.page_token !== 'string')) throw new Error('MEETING_SCHEMA');
  const next = data.page_token || cursor;
  if (next.length > 4096 || (data.has_more && (!next || next === cursor))) throw new Error('MEETING_CURSOR');
  return { ...normalizeMeetingEvents(data.events), hasMore: data.has_more, cursor: next };
}
/** ctx is constructed only after current OA admission/NDA/revision has been checked. */
export async function handleMeetingRequest(request, ctx) {
  const { actor, config, key, fetcher = fetch } = ctx;
  const url = new URL(request.url);
  const aad = JSON.stringify(['oa-feishu-listen-v1', config.origin, config.clientId, config.tenantKey, actor]);
  const callback = new URL(MEETING_PATH, config.origin).href;
  const isCallback = request.method === 'GET' && (url.searchParams.has('state') || url.searchParams.has('code') || url.searchParams.has('error'));
  let returnTo = '/';
  try {
    if (url.origin !== config.origin || !validTokenKey(key)) throw new Error('MEETING_CONFIG');
    if (isCallback) {
      const state = await unseal(readCookie(request, STATE_COOKIE), key, `${aad}:state`);
      if (!state || state.state !== url.searchParams.get('state') || !/^[A-Za-z0-9_-]{32,128}$/u.test(state.verifier || '')) throw new Error('MEETING_AUTH');
      returnTo = safeReturnPath(state.returnTo, config.origin);
      const code = url.searchParams.get('code');
      if (!code || code.length > 2048 || url.searchParams.has('error')) throw new Error('MEETING_AUTH');
      const token = await feishuJson('/open-apis/authen/v2/oauth/token', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code', client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: callback, code_verifier: state.verifier }) }, fetcher);
      if (typeof token.access_token !== 'string' || !token.access_token || token.access_token.length > 2400 || /[\r\n]/u.test(token.access_token) || !Number.isFinite(token.expires_in) || token.expires_in < 60) throw new Error('MEETING_AUTH');
      if (typeof token.scope === 'string' && !token.scope.split(/[ ,]+/u).includes(MEETING_SCOPE)) throw new Error('MEETING_SCOPE');
      const identity = await feishuJson('/open-apis/authen/v1/user_info', { headers: bearer(token.access_token) }, fetcher);
      if (!object(identity.data) || identity.data.tenant_key !== config.tenantKey || typeof identity.data.open_id !== 'string' || !/^ou[_-][A-Za-z0-9_-]{4,125}$/u.test(identity.data.open_id)) throw new Error('MEETING_AUTH');
      const exp = Date.now() + Math.min(token.expires_in - 30, 7200) * 1000;
      const grant = { token: token.access_token, exp, name: typeof identity.data.name === 'string' ? identity.data.name.slice(0, 80) : '飞书用户', openId: identity.data.open_id };
      const target = new URL(returnTo, config.origin); target.searchParams.set('oaMeetingAuth', 'connected');
      const headers = new Headers({ location: target.href, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      headers.append('set-cookie', cookie(STATE_COOKIE, '', 0, true));
      headers.append('set-cookie', cookie(GRANT_COOKIE, await seal(grant, key, `${aad}:grant`), (exp - Date.now()) / 1000));
      return new Response(null, { status: 303, headers });
    }
    const grant = await unseal(readCookie(request, GRANT_COOKIE), key, `${aad}:grant`);
    if (request.method === 'GET' && !url.search) return json({ configured: true, authorized: Boolean(grant), name: grant?.name || '', expiresAt: grant?.exp || 0 });
    if (request.method !== 'POST' || url.search) return json({ error: '请求方式不正确。' }, 405);
    if (request.headers.get('origin') !== config.origin || request.headers.get('sec-fetch-site') === 'cross-site') return json({ error: '仅支持在 OA 本页操作旁听。' }, 403);
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json({ error: '请求格式不正确。' }, 415);
    // Small protocol payload only; meeting bodies are received from Feishu, never from this request.
    const reader = request.body?.getReader(); if (!reader) return json({ error: '请求为空。' }, 400);
    let text = '', byteCount = 0; const decoder = new TextDecoder();
    try {
      while (true) { const part = await reader.read(); if (part.done) break; byteCount += part.value.byteLength; if (byteCount > 12288) { await reader.cancel(); return json({ error: '请求过大。' }, 413); } text += decoder.decode(part.value, { stream: true }); }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    let input; try { input = JSON.parse(text); } catch { return json({ error: '请求格式不正确。' }, 400); }
    if (!object(input) || Object.keys(input).some(k => !['action', 'returnTo', 'meetingId', 'listenId', 'consent', 'cursor'].includes(k))) return json({ error: '请求格式不正确。' }, 400);
    if (input.action === 'authorize') {
      const verifier = b64(crypto.getRandomValues(new Uint8Array(32)));
      const state = b64(crypto.getRandomValues(new Uint8Array(32)));
      const challenge = b64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))));
      const authorize = new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
      for (const [name, value] of Object.entries({ client_id: config.clientId, response_type: 'code', redirect_uri: callback, state, scope: MEETING_SCOPE, code_challenge: challenge, code_challenge_method: 'S256' })) authorize.searchParams.set(name, value);
      const handoff = await seal({ verifier, state, returnTo: safeReturnPath(input.returnTo, config.origin), exp: Date.now() + 300000 }, key, `${aad}:state`);
      return json({ authorizationUrl: authorize.href }, 200, { 'set-cookie': cookie(STATE_COOKIE, handoff, 300, true) });
    }
    if (input.action === 'disconnect') return json({ disconnected: true }, 200, { 'set-cookie': cookie(GRANT_COOKIE, '', 0) });
    if (!grant) throw new Error('MEETING_AUTH');
    if (input.action === 'active') return json({ meetings: await activeMeetings(grant.token, fetcher) });
    if (input.action === 'start') {
      if (input.consent !== true || !validMeetingId(input.meetingId)) return json({ error: '请先选择会议，并确认已告知参会成员及获得内部整理许可。' }, 400);
      const meetings = await activeMeetings(grant.token, fetcher);
      const meeting = meetings.find(m => m.id === input.meetingId);
      if (!meeting) throw new Error('MEETING_SELECTION');
      grant.meetingId = meeting.id; grant.listenId = crypto.randomUUID(); grant.consentAt = Date.now();
      return json({ meeting, listenId: grant.listenId }, 200, { 'set-cookie': cookie(GRANT_COOKIE, await seal(grant, key, `${aad}:grant`), (grant.exp - Date.now()) / 1000) });
    }
    if (!grant.listenId || grant.listenId !== input.listenId || grant.meetingId !== input.meetingId) throw new Error('MEETING_SELECTION');
    if (input.action === 'stop') {
      delete grant.meetingId; delete grant.listenId; delete grant.consentAt;
      return json({ stopped: true }, 200, { 'set-cookie': cookie(GRANT_COOKIE, await seal(grant, key, `${aad}:grant`), (grant.exp - Date.now()) / 1000) });
    }
    if (input.action === 'poll') {
      const meetings = await activeMeetings(grant.token, fetcher);
      if (!meetings.some(m => m.id === grant.meetingId)) return json({ active: false, reason: '本人已不在此会议，或会议已结束；已停止继续拉取。' });
      const page = await eventPage(grant.token, grant.meetingId, input.cursor === undefined ? '' : input.cursor, fetcher);
      return json({ active: true, ...page, checkedAt: Date.now() });
    }
    return json({ error: '不支持的旁听操作。' }, 400);
  } catch (cause) {
    const code = cause instanceof Error && Object.hasOwn(errorLabels, cause.message) ? cause.message : 'MEETING_UPSTREAM';
    if (isCallback) {
      const target = new URL(returnTo, config.origin); target.searchParams.set('oaMeetingAuth', code);
      return new Response(null, { status: 303, headers: { location: target.href, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'set-cookie': cookie(STATE_COOKIE, '', 0, true) } });
    }
    return json({ error: errorLabels[code], code }, code === 'MEETING_AUTH' ? 401 : code === 'MEETING_PERMISSION' ? 403 : code === 'MEETING_SELECTION' ? 409 : 503);
  }
}

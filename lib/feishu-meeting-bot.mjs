/** Application-identity meeting control. Disabled by default; no OAuth/login changes.
 * API contract checked against larksuite/cli 32d198896816e9416711468c20b14df3dbbc63f3.
 * Tokens/passwords/transcripts are never stored in the control ledger.
 */
import { normalizeMeetingEvents, validMeetingId } from './oa-meeting-capture.mjs';

export const BOT_SCOPE = 'vc:meeting.bot.join:write';
const API = 'https://open.feishu.cn';
const TOKEN = '/open-apis/auth/v3/tenant_access_token/internal';
const JOIN = '/open-apis/vc/v1/bots/join';
const LEAVE = '/open-apis/vc/v1/bots/leave';
const EVENTS = '/open-apis/vc/v1/bots/events';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const reply = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'private, no-store, max-age=0', 'x-content-type-options': 'nosniff' } });
const text = value => typeof value === 'string' ? value.trim() : '';

export class MeetingBotError extends Error {
  constructor(code, message, status = 400, uncertain = false, trace = '') {
    super(message); this.code = code; this.status = status; this.uncertain = uncertain; this.trace = trace;
  }
}
const fail = (code, message, status = 400) => { throw new MeetingBotError(code, message, status); };

export function resolveMeetingBotConfig(env = {}) {
  if (text(env.OA_MEETING_BOT_ENABLED) !== 'true') return null;
  // Never mix half of a dedicated app credential pair with the login app.
  const dedicated = Boolean(text(env.OA_MEETING_BOT_APP_ID) || text(env.OA_MEETING_BOT_APP_SECRET) || text(env.OA_MEETING_BOT_TENANT_KEY));
  const clientId = text(dedicated ? env.OA_MEETING_BOT_APP_ID : env.FEISHU_LOGIN_APP_ID);
  const clientSecret = text(dedicated ? env.OA_MEETING_BOT_APP_SECRET : env.FEISHU_LOGIN_APP_SECRET);
  const tenantKey = text(dedicated ? env.OA_MEETING_BOT_TENANT_KEY : env.FEISHU_LOGIN_TENANT_KEY);
  if (!/^[A-Za-z0-9_-]{4,128}$/u.test(clientId) || !/^[A-Za-z0-9_-]{4,128}$/u.test(tenantKey) || !clientSecret || clientSecret.length > 4096) return null;
  try {
    const url = new URL(text(env.OA_PUBLIC_ORIGIN));
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return { clientId, clientSecret, tenantKey, origin: url.origin, binding: JSON.stringify([url.origin, clientId, tenantKey]) };
  } catch { return null; }
}

/** Parse only an explicit nine-digit number or the exact Feishu meeting URL form. */
export function meetingNumber(value) {
  if (typeof value !== 'string' || value.length > 256) fail('MEETING_NUMBER', '请输入 9 位会议号或飞书会议链接。');
  const input = value.trim();
  if (/^\d{9}$/u.test(input)) return input;
  if (/^\d{3} \d{3} \d{3}$/u.test(input)) return input.replaceAll(' ', '');
  try {
    const url = new URL(input);
    const matched = /^\/j\/(\d{9})\/?$/u.exec(url.pathname);
    if (url.protocol === 'https:' && url.hostname === 'vc.feishu.cn' && !url.port && !url.username && !url.password && !url.search && !url.hash && matched) return matched[1];
  } catch { /* Not a URL: report the same strict validation error. */ }
  fail('MEETING_NUMBER', '会议号必须是 9 位数字；不要填写长 meeting_id、其他网站链接或整段邀请文字。');
}

async function readJson(response, limit) {
  if (!(response.headers.get('content-type') || '').toLowerCase().includes('application/json')) throw new Error('NON_JSON');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('EMPTY_BODY');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('BODY_LIMIT');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const merged = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(merged));
  if (!object(data)) throw new Error('JSON_OBJECT');
  return data;
}

async function upstream(path, method, body, token, fetcher, mutation = false) {
  let response;
  try {
    response = await fetcher(`${API}${path}`, { method, redirect: 'error', headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json; charset=utf-8' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(12000) });
  } catch {
    throw new MeetingBotError('FEISHU_NETWORK', mutation ? '飞书写操作响应中断，结果未知。请先查看参会人列表，不要重复入会。' : '飞书连接失败；未确认会议状态。', 502, mutation);
  }
  const trace = text(response.headers.get('x-tt-logid'));
  const logId = /^[A-Za-z0-9_-]{1,128}$/u.test(trace) ? trace : '';
  let data;
  try { data = await readJson(response, path.startsWith(EVENTS) ? 2_000_000 : 65536); }
  catch { throw new MeetingBotError('FEISHU_RESPONSE', '飞书响应格式异常，未确认操作成功。', 502, mutation, logId); }
  if (!response.ok || data.code !== 0) {
    const code = Number.isSafeInteger(data.code) ? `FEISHU_${data.code}` : 'FEISHU_RESPONSE';
    const missing = data.code === 99991672 || data.code === 99991679;
    const permission = response.status === 403 || data.code === 121003 || missing;
    const message = permission
      ? '飞书拒绝当前应用操作。请检查已发布的 vc:meeting.bot.join:write 应用权限及数据范围、会议是否进行中、允许智能体入会、密码和等候室。不要重新做用户 OAuth 授权。'
      : '飞书未确认操作成功；请核对错误码及会议状态。';
    throw new MeetingBotError(code, message, permission ? 403 : 502, mutation && (response.status >= 500 || !Number.isSafeInteger(data.code)), logId);
  }
  return data;
}

async function accessToken(config, fetcher) {
  const data = await upstream(TOKEN, 'POST', { app_id: config.clientId, app_secret: config.clientSecret }, '', fetcher);
  if (typeof data.tenant_access_token !== 'string' || !/^[\x21-\x7e]{10,4096}$/u.test(data.tenant_access_token) || !Number.isFinite(data.expire) || data.expire <= 0) fail('BOT_TOKEN', '飞书应用凭据未通过校验；未发起入会。', 502);
  return data.tenant_access_token;
}

function view(row) {
  return { id: row.id, meeting: { id: row.meeting_id || '', number: row.meeting_no, title: row.title || '飞书会议' }, state: row.state, lastVerifiedAt: Number(row.last_verified_at) || 0, updatedAt: Number(row.updated_at) || 0, code: row.last_code || '' };
}

/** Store reservation is durable and atomic; a lost response never triggers automatic rejoin. */
export async function handleMeetingBotRequest(request, ctx) {
  const { config, actor, store, fetcher = fetch } = ctx;
  try {
    if (!actor?.isAdmin || !actor.memberId || !actor.accountId || !actor.revision) fail('BOT_ADMIN_REQUIRED', '独立机器人入会目前仅向已完成准入的 OA 管理员开放。', 403);
    if (!config) return reply({ configured: false, code: 'BOT_NOT_CONFIGURED', error: '独立入会尚未启用。需配置应用凭据、OA_MEETING_BOT_ENABLED，并初始化入会记录表；不需要开启飞书登录或用户 OAuth。' }, 503);
    if (new URL(request.url).origin !== config.origin) fail('BOT_ORIGIN', '请求站点与 OA 配置不一致。', 403);
    if (request.method === 'GET') {
      const sessions = await store.list(config.binding, actor);
      return reply({ configured: true, permissionsVerified: false, scope: BOT_SCOPE, sessions: sessions.map(view) });
    }
    if (request.method !== 'POST') fail('BOT_METHOD', '不支持的请求方法。', 405);
    if (request.headers.get('origin') !== config.origin || request.headers.get('sec-fetch-site') === 'cross-site') fail('BOT_CSRF', '请在 OA 页面内操作。', 403);
    let body;
    try { body = await readJson(request, 8192); } catch { fail('BOT_INPUT', '请求必须是大小受限的 JSON 对象。'); }
    if (!['join', 'poll', 'leave'].includes(body.action)) fail('BOT_ACTION', '不支持的机器人操作。');

    if (body.action === 'join') {
      const number = meetingNumber(body.meetingNumber);
      if (!uuid(body.requestId)) fail('BOT_REQUEST_ID', '入会请求编号不正确。');
      if (body.consent !== true) fail('BOT_CONSENT', '请确认会议号，告知参会成员，并同意 OA 助手作为可见参会者加入及读取字幕。');
      if (body.password !== undefined && (typeof body.password !== 'string' || body.password.length > 128 || /[\u0000-\u001f\u007f]/u.test(body.password))) fail('BOT_PASSWORD', '会议密码格式不正确。');
      const reservation = await store.reserve({ id: body.requestId, binding: config.binding, meeting_no: number, owner_member_id: actor.memberId, owner_account_id: actor.accountId }, actor);
      if (!reservation.created) {
        if (!reservation.row || reservation.row.meeting_no !== number) fail('BOT_MEETING_BUSY', '该会议已有入会操作，或请求编号已被使用；请先恢复并核对现有记录。', 409);
        return reply({ session: view(reservation.row), reused: true, message: '已恢复原操作记录，未再次发送入会请求。' });
      }
      let issued = false;
      try {
        const token = await accessToken(config, fetcher);
        // Re-check admission immediately before the externally visible mutation.
        if (!await store.allowed(actor)) fail('BOT_ADMISSION_CHANGED', '成员准入状态已变化，未发起入会。', 403);
        issued = true;
        const data = await upstream(JOIN, 'POST', { join_type: 1, join_identify: { meeting_no: number }, ...(text(body.password) ? { password: text(body.password) } : {}) }, token, fetcher, true);
        const meeting = data.data?.meeting;
        if (!object(meeting) || !validMeetingId(meeting.id) || meeting.meeting_no !== number) throw new MeetingBotError('BOT_JOIN_UNCONFIRMED', '飞书未返回匹配的会议长 ID，入会结果待核实；请先查看参会人列表，不要重复入会。', 502, true);
        const row = await store.receipt(body.requestId, 'joining', { state: 'accepted', meeting_id: meeting.id, title: text(meeting.topic).slice(0, 200), last_code: '' });
        if (!row) throw new MeetingBotError('BOT_RECEIPT', '入会响应已收到，但记录保存失败。请在飞书参会人列表核实，必要时由主持人移出助手。', 503, true);
        return reply({ session: view(row), joinedVerified: false, message: '飞书已接受入会请求；请核对参会人列表并检查字幕读取。等候室仍可能需要主持人放行。' });
      } catch (cause) {
        const uncertain = issued && (!(cause instanceof MeetingBotError) || cause.uncertain);
        await store.receipt(body.requestId, 'joining', { state: uncertain ? 'join_unknown' : 'failed', last_code: cause instanceof MeetingBotError ? cause.code : 'BOT_STORAGE' }).catch(() => {});
        throw cause;
      }
    }

    if (!uuid(body.sessionId)) fail('BOT_SESSION_ID', '入会记录编号不正确。');
    const current = await store.get(body.sessionId, config.binding, actor);
    if (!current) fail('BOT_SESSION_NOT_FOUND', '没有可由当前账号操作的入会记录。', 404);
    if (body.action === 'leave' && current.state === 'left') return reply({ session: view(current), left: true, reused: true });
    if (!validMeetingId(current.meeting_id)) fail('BOT_MEETING_UNKNOWN', '入会结果未核实且没有可用的会议长 ID。请主持人在飞书参会人列表核对并移出助手。', 409);

    if (body.action === 'poll') {
      if (!['accepted', 'verified'].includes(current.state)) fail('BOT_NOT_READABLE', '当前记录不允许采集；请先核对入会或退出状态。', 409);
      const cursor = body.cursor === undefined ? '' : body.cursor;
      if (typeof cursor !== 'string' || cursor.length > 4096 || /[\u0000-\u001f\u007f]/u.test(cursor)) fail('BOT_CURSOR', '分页游标不正确。');
      const query = new URLSearchParams({ meeting_id: current.meeting_id, page_size: '100' });
      if (cursor) query.set('page_token', cursor);
      const token = await accessToken(config, fetcher);
      if (!await store.allowed(actor)) fail('BOT_ADMISSION_CHANGED', '成员准入状态已变化，未继续读取会议。', 403);
      const data = (await upstream(`${EVENTS}?${query}`, 'GET', null, token, fetcher)).data;
      if (!object(data) || !Array.isArray(data.events) || typeof data.has_more !== 'boolean' || (data.page_token !== undefined && typeof data.page_token !== 'string') || (data.has_more && !data.page_token)) fail('BOT_EVENTS_SCHEMA', '会议事件格式异常；未推进游标，也未确认读取成功。', 502);
      let normalized;
      try { normalized = normalizeMeetingEvents(data.events); } catch { fail('BOT_EVENTS_SCHEMA', '会议事件无法完整解析，采集已暂停。', 502); }
      const checkedAt = Date.now();
      const row = await store.receipt(current.id, current.state, { state: 'verified', last_verified_at: checkedAt, last_code: '' });
      if (!row) fail('BOT_SESSION_CHANGED', '会话状态已变化，本页结果未采纳。', 409);
      return reply({ active: true, session: view(row), ...normalized, cursor: data.page_token || cursor, hasMore: data.has_more, checkedAt });
    }

    if (body.confirmLeave !== true) fail('BOT_LEAVE_CONSENT', '请明确确认只让 OA 助手退出，不结束整场会议。');
    if (!['accepted', 'verified'].includes(current.state)) fail('BOT_LEAVE_PENDING', '已有退出操作或结果待核实；请先检查飞书参会人列表，不重复发送。', 409);
    const token = await accessToken(config, fetcher);
    if (!await store.claimLeave(current.id, actor)) fail('BOT_LEAVE_PENDING', '状态已变化或已有退出操作，未重复发送。', 409);
    try {
      await upstream(LEAVE, 'POST', { meeting_id: current.meeting_id }, token, fetcher, true);
      const row = await store.receipt(current.id, 'leaving', { state: 'left', last_code: '' });
      if (!row) throw new MeetingBotError('BOT_RECEIPT', '退出响应已收到，但保存确认失败，请核对飞书参会人列表。', 503, true);
      return reply({ session: view(row), left: true });
    } catch (cause) {
      await store.receipt(current.id, 'leaving', { state: cause instanceof MeetingBotError && !cause.uncertain ? current.state : 'leave_unknown', last_code: cause instanceof MeetingBotError ? cause.code : 'BOT_STORAGE' }).catch(() => {});
      throw cause;
    }
  } catch (cause) {
    if (cause instanceof MeetingBotError) return reply({ error: cause.message, code: cause.code, uncertain: cause.uncertain, ...(cause.trace ? { logId: cause.trace } : {}) }, cause.status);
    return reply({ error: '入会记录服务不可用。尚不能确认本次操作；请核对初始化配置和飞书参会人列表。', code: 'BOT_STORAGE' }, 503);
  }
}

/** D1 control ledger. Admissions guard is a trusted server constant, never request data. */
export function createMeetingBotStore(db, admissionGuard) {
  const args = actor => [actor.memberId, actor.accountId, actor.revision];
  const owned = (id, binding, actor) => db.prepare('SELECT * FROM oa_meeting_bot_sessions WHERE id=? AND binding=? AND owner_member_id=? AND owner_account_id=?').bind(id, binding, actor.memberId, actor.accountId).first();
  return {
    async list(binding, actor) { const result = await db.prepare("SELECT * FROM oa_meeting_bot_sessions WHERE binding=? AND owner_member_id=? AND owner_account_id=? ORDER BY (state IN ('left','failed')) ASC,updated_at DESC LIMIT 50").bind(binding, actor.memberId, actor.accountId).all(); return result.results || []; },
    get: owned,
    async allowed(actor) { return Boolean(await db.prepare(`SELECT 1 AS allowed WHERE ${admissionGuard}`).bind(...args(actor)).first()); },
    async reserve(record, actor) {
      const now = Date.now();
      const result = await db.prepare(`INSERT OR IGNORE INTO oa_meeting_bot_sessions (id,binding,meeting_no,owner_member_id,owner_account_id,state,created_at,updated_at) SELECT ?,?,?,?,?,'joining',?,? WHERE ${admissionGuard}`).bind(record.id, record.binding, record.meeting_no, actor.memberId, actor.accountId, now, now, ...args(actor)).run();
      const row = await owned(record.id, record.binding, actor);
      return { created: result.meta.changes === 1, row };
    },
    async claimLeave(id, actor) { const result = await db.prepare(`UPDATE oa_meeting_bot_sessions SET state='leaving',updated_at=? WHERE id=? AND owner_member_id=? AND owner_account_id=? AND state IN ('accepted','verified') AND ${admissionGuard}`).bind(Date.now(), id, actor.memberId, actor.accountId, ...args(actor)).run(); return result.meta.changes === 1; },
    async receipt(id, previous, patch) {
      // Persist an external-operation receipt even if admission changed in flight.
      const fields = ['state', 'meeting_id', 'title', 'last_code', 'last_verified_at'].filter(key => Object.hasOwn(patch, key));
      const result = await db.prepare(`UPDATE oa_meeting_bot_sessions SET ${fields.map(key => `${key}=?`).join(',')},updated_at=? WHERE id=? AND state=?`).bind(...fields.map(key => patch[key]), Date.now(), id, previous).run();
      return result.meta.changes === 1 ? db.prepare('SELECT * FROM oa_meeting_bot_sessions WHERE id=?').bind(id).first() : null;
    },
  };
}

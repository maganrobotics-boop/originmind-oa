// Application-identity meeting control. No user OAuth, automatic calling or recording.
const API = 'https://open.feishu.cn/open-apis';
const HEADERS = { 'cache-control': 'private, no-store, max-age=0', 'x-content-type-options': 'nosniff', vary: 'Cookie' };
const json = (body, status = 200) => Response.json(status >= 400 ? { outcomeUnknown: false, ...body } : body, { status, headers: HEADERS });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{4,128}$/u.test(value);
const safeLog = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value) ? value : undefined;
const diagnosticCode = (phase, kind) => `${phase.toUpperCase()}_${kind}`;
class BotError extends Error {
  constructor(message, status = 400, detail = {}) { super(message); this.status = status; this.detail = detail; }
}
function upstreamFailure(phase, kind, attempt, upstreamStatus) {
  const diagnostic = diagnosticCode(phase, kind);
  // Keep Worker logs actionable without recording credentials, tokens, meeting data or upstream bodies.
  console.error({ event: 'feishu_meeting_bot_upstream_failure', phase, diagnostic, attempt, ...(upstreamStatus === undefined ? {} : { upstreamStatus }) });
  const mutation = phase === 'join' || phase === 'leave';
  const message = phase === 'auth' ? '无法连接飞书应用认证服务；未发送入会或退出请求。'
    : phase === 'probe' ? '飞书入会端点网络诊断失败；诊断使用无效凭据和无效会议号，未发送有效入会请求。'
      : '飞书操作结果暂不明确。请先查看参会人列表，勿重复发送入会请求；需要时由主持人移出机器人。';
  return new BotError(message, 502, { phase, diagnostic, ...(upstreamStatus === undefined ? {} : { upstreamStatus }), outcomeUnknown: mutation });
}
export function normalizeMeetingNumber(value) {
  if (typeof value !== 'string' || value.length > 512) return null;
  const trimmed = value.trim();
  const digits = trimmed.replace(/[ \t]/gu, '');
  if (/^\d{9}$/u.test(digits)) return digits;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' || url.hostname !== 'vc.feishu.cn' || url.port || url.username || url.password) return null;
    return /^\/j\/(\d{9})\/?$/u.exec(url.pathname)?.[1] || null;
  } catch { return null; }
}
export function botConfiguration(env) {
  let origin = '';
  try {
    const url = new URL(env.OA_PUBLIC_ORIGIN || '');
    if (url.protocol === 'https:' && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password) origin = url.origin;
  } catch { /* A missing origin fails closed. */ }
  const missing = [];
  if (!origin) missing.push('OA_PUBLIC_ORIGIN');
  if (!identifier(env.FEISHU_LOGIN_APP_ID)) missing.push('FEISHU_LOGIN_APP_ID');
  if (typeof env.FEISHU_LOGIN_APP_SECRET !== 'string' || env.FEISHU_LOGIN_APP_SECRET.length < 8 || env.FEISHU_LOGIN_APP_SECRET.length > 4096) missing.push('FEISHU_LOGIN_APP_SECRET');
  if (!identifier(env.FEISHU_LOGIN_TENANT_KEY)) missing.push('FEISHU_LOGIN_TENANT_KEY');
  return { origin, missing, configured: missing.length === 0, enabled: env.OA_MEETING_BOT_ENABLED === 'true' };
}
async function boundedJson(message, limit) {
  if (!message.body) throw new BotError('请求或响应内容为空。');
  const reader = message.body.getReader();
  const parts = []; let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); throw new BotError('请求或响应超过大小限制。', 413); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  try {
    const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!object(result)) throw new Error();
    return result;
  } catch { throw new BotError('请求或响应不是有效的 JSON 对象。'); }
}
async function callApi(fetchImpl, path, body, token, phase) {
  let response, data, finalAttempt = 1;
  const attempts = phase === 'auth' ? 2 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    finalAttempt = attempt;
    try {
      response = await fetchImpl(`${API}${path}`, {
        method: 'POST', redirect: phase === 'auth' ? 'manual' : 'error', signal: AbortSignal.timeout(10000),
        headers: { accept: 'application/json', 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      });
    } catch (error) {
      const kind = error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name) ? 'TIMEOUT' : 'NETWORK';
      // Token acquisition is idempotent. Mutation requests are intentionally never retried.
      if (phase === 'auth' && attempt < attempts) continue;
      throw upstreamFailure(phase, kind, attempt);
    }
    break;
  }
  if (!(response instanceof Response)) throw upstreamFailure(phase, 'RESPONSE_INVALID', finalAttempt);
  if (response.status >= 300 && response.status < 400) throw upstreamFailure(phase, 'REDIRECT', finalAttempt, response.status);
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) throw upstreamFailure(phase, 'CONTENT_TYPE', finalAttempt, response.status);
  try { data = await boundedJson(response, 262144); }
  catch { throw upstreamFailure(phase, 'RESPONSE_INVALID', finalAttempt, response.status); }
  // A malformed envelope is not proof of rejection after a mutation was sent.
  // Keep the UI's pending intent instead of unlocking a duplicate join.
  if (!Number.isSafeInteger(data.code)) throw upstreamFailure(phase, 'RESPONSE_INVALID', finalAttempt, response.status);
  if (!response.ok || data.code !== 0) {
    const rawMessage = typeof data.msg === 'string' ? data.msg : '';
    const code = Number.isSafeInteger(data.code) ? data.code : undefined;
    const outcomeUnknown = phase !== 'auth' && (response.status >= 500 || response.status === 408 || data.code === 0);
    let error = '飞书未确认操作成功，请检查应用权限、发布安装状态及会议设置。';
    if (phase === 'auth') error = '飞书应用认证未通过。请在服务器端核对应用凭据，不要将密钥发到聊天中。';
    else if (outcomeUnknown) error = '飞书操作结果暂不明确。请先查看参会人列表，勿重复发送入会请求；需要时由主持人移出机器人。';
    else if (/gray|ErrNotInGray/iu.test(rawMessage)) error = '飞书返回灰度资格限制。需由飞书确认会议归属者、应用或租户的开通资格。';
    else if (/scope|permission not applied/iu.test(rawMessage)) error = '飞书返回应用权限限制。请检查 vc:meeting.bot.join:write 应用身份权限及应用发布、安装和数据范围。';
    else if (code === 121003) error = '飞书拒绝入会：请检查会议号、密码、会议是否已开始、允许智能体加入及等候室放行。';
    // Never forward upstream messages, tokens, passwords or request bodies.
    throw new BotError(error, 502, { phase, code, upstreamStatus: response.status, logId: safeLog(response.headers.get('x-tt-logid') || data.log_id), outcomeUnknown });
  }
  return data;
}
async function probeJoinTransport(fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${API}/vc/v1/bots/join`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: 'Bearer invalid_transport_probe' },
      // Deliberately invalid identity and meeting data: this request can only be rejected, never join.
      body: JSON.stringify({ join_type: 0, join_identify: { meeting_no: '000000000' } }),
    });
  } catch (error) {
    const kind = error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name) ? 'TIMEOUT' : 'NETWORK';
    throw upstreamFailure('probe', kind, 1);
  }
  if (!(response instanceof Response)) throw upstreamFailure('probe', 'RESPONSE_INVALID', 1);
  if (response.status >= 300 && response.status < 400) throw upstreamFailure('probe', 'REDIRECT', 1, response.status);
  // A gateway failure, missing route or rate limit is not a healthy rejection response.
  if (![200, 400, 401, 403].includes(response.status)) throw upstreamFailure('probe', 'HTTP', 1, response.status);
  if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') || '')) throw upstreamFailure('probe', 'CONTENT_TYPE', 1, response.status);
  let data;
  try { data = await boundedJson(response, 262144); }
  catch { throw upstreamFailure('probe', 'RESPONSE_INVALID', 1, response.status); }
  if (!Number.isSafeInteger(data.code) || data.code <= 0) throw upstreamFailure('probe', 'RESPONSE_INVALID', 1, response.status);
  return { upstreamStatus: response.status, code: data.code };
}
export async function handleBotRequest(request, options) {
  const { env, actorKey, checkAdmission, claimWrite, fetchImpl = fetch } = options;
  try {
    if (!actorKey || !await checkAdmission()) return json({ error: '管理员准入状态已变化，请重新登录。' }, 403);
    const config = botConfiguration(env);
    if (new URL(request.url).search) return json({ error: '不接受查询参数。' }, 400);
    if (request.method === 'GET') return json({ ...config, actorKey, permissionVerified: false, scope: 'vc:meeting.bot.join:write' });
    if (request.method !== 'POST') return json({ error: '不支持此方法。' }, 405);
    if (!config.origin || request.headers.get('origin') !== config.origin || new URL(request.url).origin !== config.origin || request.headers.get('sec-fetch-site') === 'cross-site') return json({ error: '请从本站 OA 管理页面操作。' }, 403);
    if (!/^application\/json(?:\s*;|$)/iu.test(request.headers.get('content-type') || '')) return json({ error: '仅接受 JSON 请求。' }, 415);
    const input = await boundedJson(request, 4096);
    if (!['check', 'join', 'leave'].includes(input.action)) return json({ error: '操作不正确。' }, 400);
    const keys = input.action === 'join' ? ['action', 'meeting', 'password', 'confirmed'] : input.action === 'leave' ? ['action', 'meetingId', 'confirmed'] : ['action'];
    if (Object.keys(input).some(key => !keys.includes(key))) return json({ error: '含有不支持的参数。' }, 400);
    if (!config.configured) return json({ error: '服务器飞书配置尚未完成。', missing: config.missing }, 503);
    if (input.action === 'join' && !config.enabled) return json({ error: '独立机器人入会尚未启用；未发送入会请求。' }, 503);
    if (input.action !== 'check' && input.confirmed !== true) return json({ error: '请先确认本次入会或退出操作。' }, 400);
    let body;
    if (input.action === 'join') {
      const number = normalizeMeetingNumber(input.meeting);
      if (!number) return json({ error: '请输入九位会议号或飞书会议链接，不是长数字会议 ID。' }, 400);
      if (input.password !== undefined && (typeof input.password !== 'string' || input.password.length > 128 || /[\u0000-\u001f\u007f]/u.test(input.password))) return json({ error: '会议密码格式不正确。' }, 400);
      body = { join_type: 1, join_identify: { meeting_no: number }, ...(input.password ? { password: input.password } : {}) };
    } else if (input.action === 'leave') {
      if (typeof input.meetingId !== 'string' || !/^\d{10,32}$/u.test(input.meetingId)) return json({ error: '退出必须使用入会返回的长数字会议 ID，不能使用九位会议号。' }, 400);
      body = { meeting_id: input.meetingId };
    }
    if (!await claimWrite(input.action)) return json({ error: '操作过于频繁，请稍后再试。' }, 429);
    const auth = await callApi(fetchImpl, '/auth/v3/tenant_access_token/internal', { app_id: env.FEISHU_LOGIN_APP_ID, app_secret: env.FEISHU_LOGIN_APP_SECRET }, null, 'auth');
    const token = auth.tenant_access_token;
    if (typeof token !== 'string' || !token || token.length > 8192) return json({ error: '飞书未返回有效应用令牌；未发送入会或退出请求。' }, 502);
    if (!await checkAdmission()) return json({ error: '管理员权限已变化；未发送入会或退出请求。' }, 403);
    if (input.action === 'check') {
      try {
        const transportProbe = await probeJoinTransport(fetchImpl);
        return json({ credentialsVerified: true, joinTransportVerified: true, permissionVerified: false, transportProbe, message: '应用凭据验证通过；飞书入会地址已返回拒绝响应（仅连接诊断）。诊断使用无效凭据和无效会议号，未加入会议。尚未验证入会权限、接口业务可用性、会议开关或灰度资格。' });
      } catch (error) {
        const failure = error instanceof BotError ? error : upstreamFailure('probe', 'RESPONSE_INVALID', 1);
        return json({ error: `应用凭据验证通过；${failure.message}`, ...failure.detail, credentialsVerified: true, joinTransportVerified: false, permissionVerified: false, outcomeUnknown: false }, failure.status);
      }
    }
    const result = await callApi(fetchImpl, `/vc/v1/bots/${input.action}`, body, token, input.action);
    if (input.action === 'leave') return json({ state: 'leave_api_succeeded', meetingId: input.meetingId, message: '飞书退出接口已返回成功，请核对参会人列表。' });
    const meeting = object(result.data?.meeting) ? result.data.meeting : {};
    const meetingId = typeof meeting.id === 'string' && /^\d{10,32}$/u.test(meeting.id) ? meeting.id : null;
    return json({ state: 'join_api_succeeded', meetingId, meetingNumber: body.join_identify.meeting_no, participantVerified: false, message: '飞书入会接口已返回成功；请主持人在参会人列表确认机器人，必要时从等候室放行。尚未启动字幕采集或纪要生成。' });
  } catch (error) {
    if (error instanceof BotError) return json({ error: error.message, ...error.detail }, error.status);
    return json({ error: '会议控制服务暂不可用；请先核对参会人列表，不要重复入会。', outcomeUnknown: true }, 503);
  }
}


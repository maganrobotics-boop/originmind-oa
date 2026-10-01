const API_ORIGIN = 'https://qyapi.weixin.qq.com';
const RETRY_CODES = new Set([-1, 45009, 45011, 45033]);
const TOKEN_CODES = new Set([40001, 40014, 42001]);

export class KfApiError extends Error {
  constructor(code, { retryable = false } = {}) {
    super(code);
    this.name = 'KfApiError';
    this.code = code;
    this.retryable = retryable;
  }
}

function identifier(value, max = 128) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > max || /[\u0000-\u001f]/.test(value)) {
    throw new KfApiError('KF_INVALID_ARGUMENT');
  }
  return value;
}

async function boundedJson(response, maxBytes) {
  if (Number(response.headers?.get('content-length')) > maxBytes) throw new KfApiError('KF_RESPONSE_TOO_LARGE');
  const reader = response.body?.getReader();
  if (!reader) throw new KfApiError('KF_RESPONSE_INVALID');
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new KfApiError('KF_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch (error) {
    if (error instanceof KfApiError) throw error;
    throw new KfApiError('KF_RESPONSE_INVALID', { retryable: true });
  }
}

export function createKfApi({ corpId, secret, fetchImpl = globalThis.fetch, timeoutMs = 15000, now = Date.now }) {
  identifier(corpId);
  identifier(secret, 256);
  if (typeof fetchImpl !== 'function') throw new KfApiError('KF_CONFIG_INVALID');
  let cachedToken = null;
  let expiresAt = 0;
  let refresh = null;

  async function request(path, query, body) {
    // The caller cannot choose a host, URL, path, redirect, or credentials.
    const url = new URL(path, API_ORIGIN);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(100, Math.min(timeoutMs, 60000)));
    try {
      const response = await fetchImpl(url, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error', signal: controller.signal,
      });
      if (!response.ok) throw new KfApiError(`KF_HTTP_${response.status}`, { retryable: response.status === 429 || response.status >= 500 });
      return await boundedJson(response, 2 * 1024 * 1024);
    } catch (error) {
      if (error instanceof KfApiError) throw error;
      // Do not propagate fetch's URL-bearing errors, response errmsg, or secrets.
      throw new KfApiError('KF_NETWORK', { retryable: true });
    } finally { clearTimeout(timer); }
  }

  function apiError(result) {
    const code = Number(result.errcode);
    if (code !== 0) throw new KfApiError(Number.isInteger(code) ? `KF_API_${code}` : 'KF_RESPONSE_INVALID', { retryable: RETRY_CODES.has(code) });
  }

  async function accessToken() {
    if (cachedToken && now() < expiresAt) return cachedToken;
    if (!refresh) {
      refresh = (async () => {
        const result = await request('/cgi-bin/gettoken', { corpid: corpId, corpsecret: secret });
        apiError(result);
        const lifetime = Number(result.expires_in);
        if (typeof result.access_token !== 'string' || !result.access_token || !Number.isFinite(lifetime) || lifetime <= 0) throw new KfApiError('KF_RESPONSE_INVALID');
        cachedToken = result.access_token;
        expiresAt = now() + Math.max(1, lifetime - 60) * 1000;
        return cachedToken;
      })().finally(() => { refresh = null; });
    }
    return refresh;
  }

  async function call(path, body) {
    let result = await request(path, { access_token: await accessToken() }, body);
    if (TOKEN_CODES.has(Number(result.errcode))) {
      cachedToken = null;
      expiresAt = 0;
      result = await request(path, { access_token: await accessToken() }, body);
    }
    apiError(result);
    return result;
  }

  return Object.freeze({
    async syncMessages({ cursor = '', token, openKfId, limit = 100 }) {
      identifier(openKfId);
      if (cursor && Buffer.byteLength(cursor) > 64) throw new KfApiError('KF_INVALID_ARGUMENT');
      if (token) identifier(token, 128);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new KfApiError('KF_INVALID_ARGUMENT');
      const body = { open_kfid: openKfId, limit, voice_format: 0 };
      if (cursor) body.cursor = cursor;
      if (token) body.token = token;
      const result = await call('/cgi-bin/kf/sync_msg', body);
      if (!Array.isArray(result.msg_list) || typeof result.next_cursor !== 'string' || Buffer.byteLength(result.next_cursor) > 64
          || ![0, 1, false, true].includes(result.has_more)) throw new KfApiError('KF_RESPONSE_INVALID');
      return { messages: result.msg_list, nextCursor: result.next_cursor, hasMore: Boolean(result.has_more) };
    },
    async getServiceState({ openKfId, userId }) {
      const result = await call('/cgi-bin/kf/service_state/get', {
        open_kfid: identifier(openKfId), external_userid: identifier(userId),
      });
      if (![0, 1, 2, 3, 4].includes(result.service_state)) throw new KfApiError('KF_RESPONSE_INVALID');
      return result.service_state;
    },
    async sendText({ openKfId, userId, messageId, text }) {
      if (typeof messageId !== 'string' || !/^[0-9A-Za-z_-]{1,32}$/.test(messageId)
          || typeof text !== 'string' || !text || Buffer.byteLength(text) > 2048) throw new KfApiError('KF_INVALID_ARGUMENT');
      const result = await call('/cgi-bin/kf/send_msg', {
        touser: identifier(userId), open_kfid: identifier(openKfId),
        msgid: messageId, msgtype: 'text', text: { content: text },
      });
      if (result.msgid !== messageId) throw new KfApiError('KF_RESPONSE_INVALID', { retryable: true });
      return { messageId: result.msgid };
    },
  });
}

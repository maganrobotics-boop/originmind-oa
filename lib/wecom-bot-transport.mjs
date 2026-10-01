import { createHmac, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';

export const BRIDGE_PATH = '/api/integrations/wecom-bot/messages';
export const DEFAULT_BRIDGE_URL = `http://127.0.0.1:3000${BRIDGE_PATH}`;
export const MAX_BRIDGE_BYTES = 24 * 1024;
export const MAX_REPLY_CHARS = 10_000;
// Official long-connection protocol: UTF-8 bytes per independently finished bubble.
export const MAX_STREAM_BYTES = 20_480;
export const MAX_STREAM_REPLY_CHARS = 12_000;
export const MAX_STREAM_REPLY_BYTES = 36 * 1024;
export const MAX_NDJSON_BYTES = 192 * 1024;
export const PUBLIC_HELP = '我是 OA 助研试用机器人。请在单聊中发送文字；绑定 OA 账号后可查询本人负责或创建的未完成工作项，并向已审核 OA 资料提问。试用阶段不执行审批或修改。';
export const GROUP_HELP = '为保护个人和项目资料，请与 OA 助研机器人单聊。群聊不查询或展示 OA 数据。';
export const BUSY_REPLY = '当前请求较多，请稍后重新发送。';
export const FAILURE_REPLY = '暂时无法查询，请稍后重试或打开 OA。';
export const ACK_REPLY = '正在处理…';
export const EMPTY_REPLY = '请稍后重试。';
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/;
const STATUS_CODES = new Set([
  'startup_ready', 'startup_invalid', 'startup_failed', 'socket_connected',
  'socket_authenticated', 'socket_disconnected', 'socket_reconnecting',
  'socket_error', 'socket_replaced', 'shutdown', 'sdk_warning', 'sdk_error',
  'socket_auth_denied', 'socket_retry_exhausted',
  'message_rejected', 'message_duplicate', 'message_not_authenticated',
  'message_busy', 'message_queue_expired', 'message_help', 'message_replied',
  'bridge_failed', 'reply_failed', 'reply_rate_limited', 'message_stream_update', 'message_stream_continued',
]);

export class BotTransportError extends Error {
  constructor(code) {
    super(code);
    this.name = 'BotTransportError';
    this.code = code;
  }
}

export function safeIdentifier(value, maxLength = 128) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && ID.test(value);
}

export function validateBridgeSecret(secret) {
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(secret)) {
    throw new BotTransportError('invalid_bridge_secret');
  }
  const decoded = Buffer.from(secret, 'base64url');
  if (decoded.length < 32 || decoded.toString('base64url') !== secret) {
    throw new BotTransportError('invalid_bridge_secret');
  }
  return secret;
}

/** An operator selects a single exact endpoint; incoming frames never select URLs. */
export function validateBridgeUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new BotTransportError('invalid_bridge_url'); }
  if (typeof value !== 'string' || url.href !== value || url.username || url.password
    || url.search || url.hash || url.pathname !== BRIDGE_PATH
    || (url.protocol !== 'https:' && value !== DEFAULT_BRIDGE_URL)
    || !url.hostname) {
    throw new BotTransportError('invalid_bridge_url');
  }
  return value;
}

export function readBotEnvironment(env) {
  const botId = env.WECOM_BOT_ID;
  const botSecret = env.WECOM_BOT_SECRET;
  if (!safeIdentifier(botId) || typeof botSecret !== 'string'
    || botSecret.length < 16 || botSecret.length > 512 || /[\s\x00-\x1f\x7f]/.test(botSecret)) {
    throw new BotTransportError('invalid_bot_credentials');
  }
  return Object.freeze({
    botId,
    botSecret,
    bridgeSecret: validateBridgeSecret(env.WECOM_BOT_BRIDGE_SECRET),
    bridgeUrl: validateBridgeUrl(env.WECOM_BOT_BRIDGE_URL || DEFAULT_BRIDGE_URL),
  });
}

/** Only static allowlisted status words leave the process. SDK arguments are discarded. */
export function createSafeLogger(write = (line) => process.stdout.write(`${line}\n`)) {
  const status = (code) => {
    if (STATUS_CODES.has(code)) {
      try { write(JSON.stringify({ service: 'originmind-wecom-bot', status: code })); } catch { /* Logging cannot interrupt processing. */ }
    }
  };
  return {
    status,
    sdk: {
      debug() {},
      info() {},
      warn() { status('sdk_warning'); },
      error() { status('sdk_error'); },
    },
  };
}

function validPayload(payload) {
  return payload && safeIdentifier(payload.botId)
    && safeIdentifier(payload.userId) && safeIdentifier(payload.messageId)
    && typeof payload.text === 'string' && payload.text.trim().length > 0
    && payload.text.length <= 4000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(payload.text);
}

export function signBridgeBody(secret, timestamp, body) {
  validateBridgeSecret(secret);
  if (!/^\d{13}$/.test(String(timestamp))) throw new BotTransportError('invalid_timestamp');
  return createHmac('sha256', secret).update(`${timestamp}\n${body}`).digest('hex');
}

async function readBoundedResponse(response, signal) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BRIDGE_BYTES)) {
    await response.body?.cancel().catch(() => {});
    throw new BotTransportError('bridge_response_too_large');
  }
  if (!response.body) throw new BotTransportError('bridge_invalid_response');
  const reader = response.body.getReader();
  const cancelOnAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancelOnAbort, { once: true });
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw new BotTransportError('bridge_timeout');
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BRIDGE_BYTES) throw new BotTransportError('bridge_response_too_large');
      chunks.push(value);
    }
    if (signal.aborted) throw new BotTransportError('bridge_timeout');
    let data;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      data = JSON.parse(text);
    } catch { throw new BotTransportError('bridge_invalid_response'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)
      || data.ok !== true || typeof data.reply !== 'string'
      || data.reply.length > MAX_REPLY_CHARS) {
      throw new BotTransportError('bridge_invalid_response');
    }
    return data.reply;
  } finally {
    signal.removeEventListener('abort', cancelOnAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function wellFormedStreamText(text, allowPending = false) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 === text.length && allowPending) return text.slice(0, -1);
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new BotTransportError('bridge_invalid_response');
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new BotTransportError('bridge_invalid_response');
  }
  return text;
}

/** OA emits only visibility-checked deltas. Parse incrementally and reject
 * malformed, oversized or unterminated streams instead of accepting partial success. */
async function readBoundedStreamResponse(response, signal, onUpdate) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_NDJSON_BYTES)) {
    await response.body?.cancel().catch(() => {});
    throw new BotTransportError('bridge_response_too_large');
  }
  if (!response.body) throw new BotTransportError('bridge_invalid_response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const cancelOnAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancelOnAbort, { once: true });
  let bytes = 0;
  let buffer = '';
  let content = '';
  let terminal = false;
  const parseLine = async (line) => {
    if (!line || Buffer.byteLength(line, 'utf8') > MAX_BRIDGE_BYTES) {
      throw new BotTransportError('bridge_invalid_response');
    }
    let event;
    try { event = JSON.parse(line); } catch { throw new BotTransportError('bridge_invalid_response'); }
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new BotTransportError('bridge_invalid_response');
    const keys = Object.keys(event).sort().join(',');
    if (event.type === 'delta' && keys === 'text,type' && typeof event.text === 'string' && event.text.length > 0) {
      content += event.text;
      if (content.length > MAX_STREAM_REPLY_CHARS || Buffer.byteLength(content, 'utf8') > MAX_STREAM_REPLY_BYTES) {
        throw new BotTransportError('bridge_response_too_large');
      }
      const visibleContent = wellFormedStreamText(content, true);
      if (onUpdate && visibleContent) await onUpdate(visibleContent);
    } else if (event.type === 'done' && keys === 'type') {
      wellFormedStreamText(content);
      terminal = true;
    }
    else if (event.type === 'error' && keys === 'code,type' && ['unavailable', 'revoked'].includes(event.code)) {
      throw new BotTransportError(event.code === 'revoked' ? 'bridge_revoked' : 'bridge_unavailable');
    } else throw new BotTransportError('bridge_invalid_response');
  };
  try {
    while (true) {
      if (signal.aborted) throw new BotTransportError('bridge_cancelled');
      const { done, value } = await reader.read();
      if (signal.aborted) throw new BotTransportError('bridge_cancelled');
      if (done) {
        try { buffer += decoder.decode(); } catch { throw new BotTransportError('bridge_invalid_response'); }
        // Every event has a newline; EOF alone never proves model completion.
        if (buffer || !terminal) throw new BotTransportError('bridge_invalid_response');
        return content;
      }
      bytes += value.byteLength;
      if (bytes > MAX_NDJSON_BYTES) throw new BotTransportError('bridge_response_too_large');
      try { buffer += decoder.decode(value, { stream: true }); } catch { throw new BotTransportError('bridge_invalid_response'); }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (terminal) throw new BotTransportError('bridge_invalid_response');
        await parseLine(line);
        if (signal.aborted) throw new BotTransportError('bridge_cancelled');
      }
      if (Buffer.byteLength(buffer, 'utf8') > MAX_BRIDGE_BYTES) throw new BotTransportError('bridge_response_too_large');
    }
  } finally {
    signal.removeEventListener('abort', cancelOnAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Node fetch discards an overridden Host. The exact local adapter endpoint
 * needs http.request to put its pinned proxy-origin headers on the wire.
 * Return a web Response so the existing bounded parser and abort handling apply.
 */
function fetchBridge(endpoint, options) {
  if (endpoint !== DEFAULT_BRIDGE_URL) return globalThis.fetch(endpoint, options);
  return new Promise((resolve, reject) => {
    const request = httpRequest(endpoint, {
      method: options.method, headers: options.headers, signal: options.signal,
    }, (incoming) => {
      try {
        const headers = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
        }
        resolve(new Response(Readable.toWeb(incoming), { status: incoming.statusCode, headers }));
      } catch (error) {
        incoming.destroy();
        reject(error);
      }
    });
    request.once('error', reject);
    request.end(options.body);
  });
}

/** HTTP transport has no retry: persistent OA message IDs decide replay behavior. */
export function createBridgeClient({ endpoint, secret, fetchImpl = fetchBridge, now = Date.now, timeoutMs = 120_000 }) {
  validateBridgeUrl(endpoint);
  validateBridgeSecret(secret);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 150_000) {
    throw new BotTransportError('invalid_timeout');
  }
  return async (payload, { timeoutMs: remainingMs = timeoutMs, signal: parentSignal, onUpdate } = {}) => {
    if (onUpdate !== undefined && typeof onUpdate !== 'function') throw new BotTransportError('invalid_stream_callback');
    if (!validPayload(payload)) throw new BotTransportError('invalid_payload');
    if (!Number.isInteger(remainingMs) || remainingMs < 1 || remainingMs > 150_000) throw new BotTransportError('invalid_timeout');
    // Rebuild, so response_url, downloads and extra callback fields are never forwarded.
    const body = JSON.stringify({ botId: payload.botId, userId: payload.userId, messageId: payload.messageId, text: payload.text });
    if (Buffer.byteLength(body, 'utf8') > MAX_BRIDGE_BYTES) throw new BotTransportError('bridge_request_too_large');
    const timestamp = String(now());
    const controller = new AbortController();
    const cancelFromParent = () => controller.abort();
    parentSignal?.addEventListener('abort', cancelFromParent, { once: true });
    if (parentSignal?.aborted) controller.abort();
    let timer;
    let rejectCancelled;
    const cancelled = new Promise((_, reject) => { rejectCancelled = reject; });
    const rejectOnAbort = () => rejectCancelled(new BotTransportError(parentSignal?.aborted ? 'bridge_cancelled' : 'bridge_timeout'));
    controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
    if (controller.signal.aborted) rejectOnAbort();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new BotTransportError('bridge_timeout'));
      }, Math.min(timeoutMs, remainingMs));
    });
    const request = (async () => {
      const response = await fetchImpl(endpoint, {
        method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: {
          // The local Aliyun adapter trusts only this exact proxy origin. Never
          // override Host or add proxy headers to operator-selected HTTPS URLs.
          ...(endpoint === DEFAULT_BRIDGE_URL ? {
            host: 'oa.omindos.cn',
            'x-forwarded-host': 'oa.omindos.cn',
            'x-forwarded-proto': 'https',
          } : {}),
          'content-type': 'application/json',
          accept: 'application/x-ndjson, application/json',
          'x-oa-bot-timestamp': timestamp,
          'x-oa-bot-signature': signBridgeBody(secret, timestamp, body),
        },
        body,
      });
      if (controller.signal.aborted) throw new BotTransportError('bridge_timeout');
      if (response.redirected || (response.url && response.url !== endpoint)
        || (response.status >= 300 && response.status < 400)) {
        await response.body?.cancel().catch(() => {});
        throw new BotTransportError('bridge_redirect_rejected');
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        throw new BotTransportError('bridge_unavailable');
      }
      const contentType = response.headers.get('content-type') || '';
      if (/^application\/x-ndjson(?:\s*;|$)/i.test(contentType)) {
        return readBoundedStreamResponse(response, controller.signal, onUpdate);
      }
      if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
        await response.body?.cancel().catch(() => {});
        throw new BotTransportError('bridge_invalid_response');
      }
      return readBoundedResponse(response, controller.signal);
    })();
    try { return await Promise.race([request, timeout, cancelled]); }
    catch (error) {
      if (error instanceof BotTransportError) throw error;
      throw new BotTransportError(controller.signal.aborted ? 'bridge_timeout' : 'bridge_unavailable');
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', rejectOnAbort);
      parentSignal?.removeEventListener('abort', cancelFromParent);
    }
  };
}

/** Stable code-point boundaries let cumulative updates continue in a new bubble
 * without changing any already-finished bubble or discarding long answers. */
export function splitStreamReply(content) {
  if (typeof content !== 'string' || !content.trim()) return [FAILURE_REPLY];
  wellFormedStreamText(content);
  const pieces = [];
  let text = '';
  let bytes = 0;
  for (const point of content) {
    const size = Buffer.byteLength(point, 'utf8');
    if (bytes + size > MAX_STREAM_BYTES) {
      pieces.push(text);
      text = '';
      bytes = 0;
    }
    text += point;
    bytes += size;
  }
  if (text) pieces.push(text);
  return pieces;
}

function validateFrame(frame, botId) {
  if (!frame || frame.cmd !== 'aibot_msg_callback'
    || !safeIdentifier(frame.headers?.req_id, 256)) return null;
  const body = frame.body;
  if (!body || body.aibotid !== botId || !safeIdentifier(body.from?.userid)
    || !safeIdentifier(body.msgid)) return null;
  const replyFrame = { headers: { req_id: frame.headers.req_id } };
  const identity = { userId: body.from.userid, messageId: body.msgid };
  if (body.chattype === 'group') return { ...identity, replyFrame, rateKey: safeIdentifier(body.chatid) ? `group:${body.chatid}` : 'group:unknown', help: GROUP_HELP };
  // Unknown chat types and contradictory group fields fail closed.
  if (body.chattype !== 'single' || body.chatid) return null;
  if (body.msgtype !== 'text') return { ...identity, replyFrame, rateKey: `single:${identity.userId}`, help: PUBLIC_HELP };
  const payload = { botId, userId: body.from.userid, messageId: body.msgid, text: body.text?.content };
  if (!validPayload(payload)) return { ...identity, replyFrame, rateKey: `single:${identity.userId}`, help: PUBLIC_HELP };
  return { ...identity, replyFrame, rateKey: `single:${identity.userId}`, payload };
}

/** Bounded global queue with one active message per user and bounded replay cache. */
export function createBotMessageHandler({ botId, bridge, sendReply, logger = createSafeLogger(), now = Date.now,
  maxConcurrent = 4, maxPending = 32, maxPerUser = 4, maxSeen = 1024,
  dedupeTtlMs = 10 * 60_000, queueTimeoutMs = 30_000, replyTimeoutMs = 5000, streamUpdateIntervalMs = 2500 }) {
  if (!safeIdentifier(botId) || typeof bridge !== 'function' || typeof sendReply !== 'function'
    || ![maxConcurrent, maxPending, maxPerUser, maxSeen, dedupeTtlMs, queueTimeoutMs, replyTimeoutMs, streamUpdateIntervalMs].every((n) => Number.isInteger(n) && n > 0)
    || maxConcurrent > 16 || maxPending > 128 || maxPerUser > 8 || maxSeen > 4096
    || dedupeTtlMs > 60 * 60_000 || queueTimeoutMs > 30_000 || replyTimeoutMs > 5000 || streamUpdateIntervalMs > 10_000) throw new BotTransportError('invalid_handler_config');
  const seen = new Map();
  const users = new Map();
  const activeUsers = new Set();
  const queue = [];
  let active = 0;
  let stopped = false;
  const stopController = new AbortController();
  const activeControllers = new Set();
  const cancelActive = () => { for (const controller of activeControllers) controller.abort(); };
  // The official limit does not exempt updates: count every outgoing frame.
  // Intermediate refreshes leave four slots for a finish/continuation/failure.
  const replyBudgets = new Map();
  const budgetSlot = (key, intermediate) => {
    const time = now();
    for (const [entryKey, entry] of replyBudgets) {
      if (entry.lastUsed <= time - 60 * 60_000) replyBudgets.delete(entryKey);
    }
    let entry = replyBudgets.get(key);
    if (!entry) {
      if (replyBudgets.size >= 1024) return { blocked: true };
      entry = { times: [], lastUsed: time };
      replyBudgets.set(key, entry);
    }
    const times = entry.times;
    while (times.length && times[0] <= time - 60 * 60_000) times.shift();
    const minuteStart = times.findIndex((sent) => sent > time - 60_000);
    const minuteCount = minuteStart < 0 ? 0 : times.length - minuteStart;
    const minuteLimit = 30 - (intermediate ? 4 : 0);
    const hourLimit = 1000 - (intermediate ? 4 : 0);
    let availableAt = time;
    if (minuteCount >= minuteLimit) availableAt = Math.max(availableAt, times[times.length - minuteLimit] + 60_000);
    if (times.length >= hourLimit) availableAt = Math.max(availableAt, times[times.length - hourLimit] + 60 * 60_000);
    if (availableAt > time) return { availableAt };
    times.push(time);
    entry.lastUsed = time;
    return { granted: true };
  };
  const reserveReply = async (key, isReady, { intermediate, deadline, signal }) => {
    while (!stopped && isReady() && !signal?.aborted) {
      const slot = budgetSlot(key, intermediate);
      if (slot.granted) return true;
      if (intermediate) return 'deferred';
      if (slot.blocked || slot.availableAt >= deadline || deadline <= now()) {
        logger.status('reply_rate_limited');
        return false;
      }
      // Epoch changes also cancel queued ACKs that have no active controller.
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, Math.min(250, Math.max(1, slot.availableAt - now())));
        signal?.addEventListener('abort', done, { once: true });
        if (signal?.aborted) done();
      });
    }
    return false;
  };

  const safeReply = async (frame, text, isReady, { streamId = `oa_${randomUUID()}`, finish = true, deadline = now() + 5000, rateKey = 'group:unknown', intermediate = false, signal = stopController.signal } = {}) => {
    if (!isReady() || stopped || typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_STREAM_BYTES) return false;
    const reserved = await reserveReply(rateKey, isReady, { intermediate, deadline: deadline - replyTimeoutMs, signal });
    if (reserved !== true) return reserved;
    if (!isReady() || stopped || signal.aborted) return false;
    const remainingMs = Math.min(replyTimeoutMs, deadline - now());
    if (remainingMs <= 0) return false;
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => sendReply(frame, streamId, text, finish)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new BotTransportError('reply_timeout')), remainingMs); }),
      ]);
      return true;
    } catch {
      logger.status('reply_failed');
      return false;
    } finally { clearTimeout(timer); }
  };
  const pruneSeen = () => {
    const time = now();
    for (const [key, expiry] of seen) if (expiry !== null && expiry <= time) seen.delete(key);
  };
  const run = async (job) => {
    if (stopped || !job.isReady()) {
      logger.status('message_not_authenticated');
      return 'not_authenticated';
    }
    if (now() > job.deadline) {
      logger.status('message_queue_expired');
      await safeReply(job.parsed.replyFrame, BUSY_REPLY, job.isReady, { streamId: job.streamId, deadline: job.totalDeadline, rateKey: job.parsed.rateKey });
      return 'queue_expired';
    }
    if (job.parsed.help) {
      const delivered = await safeReply(job.parsed.replyFrame, job.parsed.help, job.isReady, { rateKey: job.parsed.rateKey, deadline: job.totalDeadline });
      if (delivered) logger.status('message_help');
      return delivered ? 'help' : 'reply_failed';
    }
    const replyOptions = { streamId: job.streamId, deadline: job.totalDeadline, rateKey: job.parsed.rateKey };
    // Only an acknowledged private query may reach the OA bridge.
    if (!await job.ackPromise) return 'reply_failed';
    if (!job.isReady() || stopped) return 'not_authenticated';
    const controller = new AbortController();
    const abortFromStop = () => controller.abort();
    stopController.signal.addEventListener('abort', abortFromStop, { once: true });
    if (stopController.signal.aborted) controller.abort();
    activeControllers.add(controller);
    let updateTimer;
    let updateChain = Promise.resolve();
    let latestText = '';
    let lastSentAt = -Infinity;
    let currentBubble = 0;
    let currentId = job.streamId;
    let currentText = ACK_REPLY;
    let ending = false;
    let sendFailed = false;
    let firstContent = true;
    const ready = () => !controller.signal.aborted && job.isReady() && !stopped;
    const send = async (text, finish, intermediate = false) => {
      if (!ready()) throw new BotTransportError('bridge_cancelled');
      const delivered = await safeReply(job.parsed.replyFrame, text, ready, {
        streamId: currentId, finish, deadline: job.totalDeadline, rateKey: job.parsed.rateKey,
        intermediate, signal: controller.signal,
      });
      if (delivered === 'deferred') return;
      if (!delivered) {
        sendFailed = true;
        controller.abort();
        throw new BotTransportError('reply_failed');
      }
      currentText = text;
      firstContent = false;
      lastSentAt = now();
      if (!finish) logger.status('message_stream_update');
    };
    const sendSnapshot = async (text, finish) => {
      const pieces = splitStreamReply(text);
      if (currentBubble >= pieces.length) throw new BotTransportError('bridge_invalid_response');
      let newBubble = false;
      for (; currentBubble < pieces.length - 1; currentBubble += 1) {
        // An acknowledged finish closes this bubble permanently. The following
        // bubble uses a fresh stream ID with the same original callback req_id.
        await send(pieces[currentBubble], true);
        currentId = `oa_${randomUUID()}`;
        currentText = '';
        firstContent = true;
        newBubble = true;
        logger.status('message_stream_continued');
      }
      const content = pieces[currentBubble];
      if (finish && newBubble) await send(content, false);
      if (finish || content !== currentText) await send(content, finish, !finish && !firstContent);
    };
    const enqueueUpdate = (finish = false) => {
      updateChain = updateChain.then(() => sendSnapshot(latestText, finish));
      // Timed updates run independently of reads; a failed ACK immediately
      // cancels the upstream stream, and is handled again at finalization.
      void updateChain.catch(() => { controller.abort(); });
      return updateChain;
    };
    const onUpdate = async (text) => {
      if (!ready()) throw new BotTransportError('bridge_cancelled');
      if (ending || typeof text !== 'string' || !text.startsWith(latestText)
        || text.length > MAX_STREAM_REPLY_CHARS || Buffer.byteLength(text, 'utf8') > MAX_STREAM_REPLY_BYTES) {
        throw new BotTransportError('bridge_invalid_response');
      }
      latestText = text;
      if (now() - lastSentAt >= streamUpdateIntervalMs) {
        clearTimeout(updateTimer);
        updateTimer = undefined;
        await enqueueUpdate();
      } else if (!updateTimer) {
        updateTimer = setTimeout(() => {
          updateTimer = undefined;
          if (!ending && ready()) void enqueueUpdate();
        }, Math.max(1, streamUpdateIntervalMs - (now() - lastSentAt)));
      }
    };
    try {
      const remainingMs = Math.min(120_000, job.totalDeadline - now() - replyTimeoutMs);
      if (remainingMs < 1) throw new BotTransportError('bridge_timeout');
      const reply = await bridge(job.parsed.payload, { timeoutMs: remainingMs, signal: controller.signal, onUpdate });
      if (typeof reply !== 'string' || reply.length > MAX_STREAM_REPLY_CHARS
        || Buffer.byteLength(reply, 'utf8') > MAX_STREAM_REPLY_BYTES
        || !reply.startsWith(latestText)) throw new BotTransportError('bridge_invalid_response');
      ending = true;
      clearTimeout(updateTimer);
      latestText = reply.trim() ? reply : EMPTY_REPLY;
      await enqueueUpdate(true);
      logger.status('message_replied');
      return 'replied';
    } catch {
      ending = true;
      clearTimeout(updateTimer);
      if (sendFailed) return 'reply_failed';
      if (!job.isReady() || stopped || controller.signal.aborted) return 'not_authenticated';
      logger.status('bridge_failed');
      // Stop any scheduled update before replacing the still-open bubble with
      // a static failure. Completed bubbles are never updated again.
      await updateChain.catch(() => {});
      if (sendFailed || !ready()) return sendFailed ? 'reply_failed' : 'not_authenticated';
      await safeReply(job.parsed.replyFrame, FAILURE_REPLY, ready, { ...replyOptions, streamId: currentId });
      return 'bridge_failed';
    } finally {
      clearTimeout(updateTimer);
      controller.abort();
      stopController.signal.removeEventListener('abort', abortFromStop);
      activeControllers.delete(controller);
    }

  };
  const pump = () => {
    if (stopped) return;
    while (active < maxConcurrent) {
      const index = queue.findIndex((job) => !activeUsers.has(job.userId));
      if (index < 0) break;
      const [job] = queue.splice(index, 1);
      active += 1;
      activeUsers.add(job.userId);
      Promise.resolve().then(() => run(job)).catch(() => 'bridge_failed').then((result) => {
        active -= 1;
        activeUsers.delete(job.userId);
        const count = users.get(job.userId) - 1;
        if (count) users.set(job.userId, count); else users.delete(job.userId);
        seen.set(job.key, now() + dedupeTtlMs);
        job.resolve(result);
        pump();
      });
    }
  };
  return {
    handle(frame, { isReady = () => true } = {}) {
      if (stopped || !isReady()) {
        logger.status('message_not_authenticated');
        return Promise.resolve('not_authenticated');
      }
      const parsed = validateFrame(frame, botId);
      if (!parsed) {
        logger.status('message_rejected');
        return Promise.resolve('rejected');
      }
      const userId = parsed.userId;
      const key = JSON.stringify([userId, parsed.messageId]);
      pruneSeen();
      if (seen.has(key)) {
        logger.status('message_duplicate');
        return Promise.resolve('duplicate');
      }
      if (seen.size >= maxSeen || queue.length >= maxPending || (users.get(userId) || 0) >= maxPerUser) {
        // No additional reply tasks are allocated when full; a flood stays bounded.
        logger.status('message_busy');
        return Promise.resolve('busy');
      }
      seen.set(key, null);
      users.set(userId, (users.get(userId) || 0) + 1);
      const time = now();
      const totalDeadline = time + 150_000;
      const streamId = `oa_${randomUUID()}`;
      // Accepted jobs are already bounded before an ACK promise is allocated.
      // A queued question receives a prompt static ACK without querying OA early.
      const ackPromise = parsed.payload
        ? safeReply(parsed.replyFrame, ACK_REPLY, isReady, { streamId, finish: false, deadline: totalDeadline, rateKey: parsed.rateKey })
        : null;
      const promise = new Promise((resolve) => queue.push({ parsed, userId, key, isReady, resolve, streamId, ackPromise,
        deadline: time + queueTimeoutMs, totalDeadline }));
      pump();
      return promise;
    },
    cancelActive,
    stop() {
      stopped = true;
      stopController.abort();
      for (const job of queue.splice(0)) {
        const count = users.get(job.userId) - 1;
        if (count) users.set(job.userId, count); else users.delete(job.userId);
        seen.delete(job.key);
        job.resolve('not_authenticated');
      }
    },
    getStats() { return { active, queued: queue.length, users: users.size, seen: seen.size }; },
    getRateStats() { return { conversations: replyBudgets.size, frames: [...replyBudgets.values()].reduce((sum, entry) => sum + entry.times.length, 0) }; },
  };
}

/** Attach once to the SDK's untyped message event to avoid handling messages twice. */
export function attachBotClient(client, handler, { botId, logger = createSafeLogger(), onIntentionalStop = () => {}, onFatalStop = () => {} } = {}) {
  let authenticated = false;
  let epoch = 0;
  let stopped = false;
  const stop = (replaced = false, fatal = false) => {
    if (stopped) return;
    stopped = true;
    authenticated = false;
    epoch += 1;
    handler.stop();
    client.disconnect();
    if (!fatal) logger.status(replaced ? 'socket_replaced' : 'shutdown');
    if (fatal) onFatalStop(); else onIntentionalStop();
  };
  client.on('connected', () => { logger.status('socket_connected'); });
  client.on('authenticated', () => {
    if (stopped) return;
    handler.cancelActive?.();
    authenticated = true;
    epoch += 1;
    logger.status('socket_authenticated');
  });
  client.on('disconnected', () => {
    authenticated = false;
    handler.cancelActive?.();
    epoch += 1;
    logger.status('socket_disconnected');
  });
  client.on('reconnecting', () => { logger.status('socket_reconnecting'); });
  client.on('error', (error) => {
    if (error?.code === 'WS_AUTH_FAILURE_EXHAUSTED') {
      logger.status('socket_auth_denied');
      stop(false, true);
    } else if (error?.code === 'WS_RECONNECT_EXHAUSTED') {
      logger.status('socket_retry_exhausted');
      stop(false, true);
    } else logger.status('socket_error');
  });
  client.on('message', (frame) => {
    const frameEpoch = epoch;
    void handler.handle(frame, { isReady: () => authenticated && !stopped && epoch === frameEpoch }).catch(() => { logger.status('bridge_failed'); });
  });
  client.on('event', (frame) => {
    // A provider replacement event must not cause a service/reconnection contest.
    if (frame?.cmd === 'aibot_event_callback' && frame.body?.aibotid === botId
      && frame.body?.event?.eventtype === 'disconnected_event') stop(true);
  });
  return { stop, isAuthenticated: () => authenticated && !stopped };
}

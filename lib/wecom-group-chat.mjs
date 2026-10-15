import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import { BotTransportError, GROUP_CHAT_HELP, safeIdentifier, MAX_STREAM_REPLY_CHARS, MAX_STREAM_REPLY_BYTES } from './wecom-bot-transport.mjs';

// Group questions use the anonymous public Chat route, never the private OA bridge.
// Neither callback credentials nor OA bindings can select a destination or be forwarded.
export const GROUP_CHAT_ENDPOINT = 'http://127.0.0.1:3001/api/chat';
const PUBLIC_ORIGIN = 'https://chat.omindos.cn';
const MAX_RESPONSE_BYTES = 256 * 1024;
const PRIVATE_HELP = '个人待办、审批、报酬和 OA 内部资料请与我单聊查询；群里可以直接提问普通问题、机器人技术和课程内容。';
const PERSONA = '你是源灵助手，正在企业微信群里回答问题。用自然、简洁的中文，先直接回答，一般控制在300字内，技术问题按需展开。可以聊天、解释机器人技术和公开课程。你没有个人OA、内部项目、成员档案、审批或报酬数据的访问权限，不声称查到这些记录。只有人名而没有具体问题时，先询问想了解什么，不编造真人经历或任职。';

export function groupQuestion(text) {
  if (typeof text !== 'string' || text.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text)) throw new BotTransportError('invalid_payload');
  return text.trim().replace(/^@[^\s@]+(?:\s+|$)/u, '').trim();
}

function privateOaQuestion(question) {
  return /(?:^\/(?:待办|绑定|解绑)|^(?:绑定|解绑)(?:\s|[：:]|[A-Za-z0-9_-]|$)|(?:我的|他的|她的|个人|内部).{0,16}(?:待办|审批|报销|工资|薪资|报酬|NDA|保密|资料)|\bOA\b.{0,16}(?:查询|查看|审批|待办|资料|数据)|(?:查询|查看|显示|读取).{0,16}(?:OA|内部资料|工资|薪资|报酬|审批))/iu.test(question);
}

function publicFetch(endpoint, options) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(endpoint, { method: 'POST', headers: options.headers, signal: options.signal, maxHeaderSize: 16 * 1024 }, incoming => {
      try {
        const headers = new Headers();
        for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
        resolve(new Response(Readable.toWeb(incoming), { status: incoming.statusCode, headers }));
      } catch (error) { incoming.destroy(); reject(error); }
    });
    outgoing.once('error', reject);
    outgoing.end(options.body);
  });
}

async function boundedJson(response, signal) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel().catch(() => {});
    throw new BotTransportError('bridge_response_too_large');
  }
  if (!response.body) throw new BotTransportError('bridge_invalid_response');
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw new BotTransportError('bridge_cancelled');
      const item = await reader.read();
      if (signal.aborted) throw new BotTransportError('bridge_cancelled');
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new BotTransportError('bridge_response_too_large');
      chunks.push(item.value);
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new BotTransportError('bridge_invalid_response'); }
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createGroupChatClient({ fetchImpl = publicFetch, now = Date.now, timeoutMs = 110_000, maxConversations = 128, conversationTtlMs = 30 * 60_000 } = {}) {
  if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000
    || !Number.isInteger(maxConversations) || maxConversations < 1 || maxConversations > 512
    || !Number.isInteger(conversationTtlMs) || conversationTtlMs < 1 || conversationTtlMs > 60 * 60_000) throw new BotTransportError('invalid_handler_config');
  const conversations = new Map();
  return async (payload, { signal: parentSignal, timeoutMs: remainingMs = timeoutMs } = {}) => {
    if (!payload || Object.keys(payload).sort().join(',') !== 'chatId,text,userId'
      || !safeIdentifier(payload.chatId) || !safeIdentifier(payload.userId)
      || !Number.isInteger(remainingMs) || remainingMs < 1 || remainingMs > 150_000) throw new BotTransportError('invalid_payload');
    if (parentSignal?.aborted) throw new BotTransportError('bridge_cancelled');
    const question = groupQuestion(payload.text);
    if (!question) return GROUP_CHAT_HELP;
    const key = JSON.stringify([payload.chatId, payload.userId]);
    for (const [id, entry] of conversations) if (entry.expires <= now()) conversations.delete(id);
    if (/^(?:清除上下文(?:关联)?|新建对话|\/reset)$/iu.test(question)) {
      conversations.delete(key);
      return '已清除你在本群的对话记录，可以开始新的提问。';
    }
    if (privateOaQuestion(question)) return PRIVATE_HELP;
    const controller = new AbortController();
    const abort = () => controller.abort();
    parentSignal?.addEventListener('abort', abort, { once: true });
    let rejectAbort;
    const cancelled = new Promise((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(new BotTransportError(parentSignal?.aborted ? 'bridge_cancelled' : 'bridge_timeout'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(abort, Math.min(timeoutMs, remainingMs));
    if (parentSignal?.aborted) abort();
    const work = async () => {
      if (controller.signal.aborted) throw new BotTransportError('bridge_cancelled');
      const token = conversations.get(key)?.token;
      const body = JSON.stringify({ topic: 'research', messages: [{ role: 'user', content: PERSONA }, { role: 'user', content: question }], ...(token ? { conversationToken: token } : {}) });
      const response = await fetchImpl(GROUP_CHAT_ENDPOINT, {
        method: 'POST', redirect: 'manual', credentials: 'omit', signal: controller.signal,
        headers: { host: 'chat.omindos.cn', origin: PUBLIC_ORIGIN, 'x-forwarded-host': 'chat.omindos.cn', 'x-forwarded-proto': 'https', 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'OriginMind-WeCom-Group/1.0' }, body,
      });
      if (controller.signal.aborted) throw new BotTransportError('bridge_cancelled');
      if (response.status !== 200 || response.redirected || (response.url && response.url !== GROUP_CHAT_ENDPOINT)
        || !/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') || '')) {
        await response.body?.cancel().catch(() => {});
        throw new BotTransportError('bridge_unavailable');
      }
      const data = await boundedJson(response, controller.signal);
      if (!data || typeof data.answer !== 'string' || !data.answer.trim()
        || !['ai', 'general', 'retrieval'].includes(data.mode)) throw new BotTransportError('bridge_invalid_response');
      if (data.fallbackReason && data.fallbackReason !== 'no_documents' && data.fallbackReason !== 'no_images') throw new BotTransportError('bridge_unavailable');
      const answer = data.answer.replace(/^\*\*来源类型：模型通用知识（未引用公开知识库资料）\*\*\s*/u, '');
      if (!answer.trim() || answer.length > MAX_STREAM_REPLY_CHARS || Buffer.byteLength(answer, 'utf8') > MAX_STREAM_REPLY_BYTES) throw new BotTransportError('bridge_response_too_large');
      if (controller.signal.aborted) throw new BotTransportError('bridge_cancelled');
      if (typeof data.conversationToken === 'string' && data.conversationToken.length > 0 && data.conversationToken.length <= 16000) {
        conversations.delete(key);
        while (conversations.size >= maxConversations) conversations.delete(conversations.keys().next().value);
        conversations.set(key, { token: data.conversationToken, expires: now() + conversationTtlMs });
      } else conversations.delete(key);
      return answer;
    };
    try { return await Promise.race([work(), cancelled]); }
    catch (error) {
      if (error instanceof BotTransportError) throw error;
      throw new BotTransportError(controller.signal.aborted ? (parentSignal?.aborted ? 'bridge_cancelled' : 'bridge_timeout') : 'bridge_unavailable');
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      parentSignal?.removeEventListener('abort', abort);
    }
  };
}

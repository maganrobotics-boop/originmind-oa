import { decryptSecret } from './crypto.mjs';
import { aliyunEndpoint } from './knowledge.mjs';
import { buildGeneralChatMessages, buildGroundedChatMessages } from './grounded-prompt.mjs';

const encoder = new TextEncoder();
const MAX_ANSWER_CHARS = 12_000;
const MAX_UPSTREAM_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_CHARS = 6_000;
const continuation = '严格从上一段回答的断点继续，不重复开头或已写内容。完成剩余内容，继续遵守原有资料依据、引用和安全规则。';
const failed = () => new Error('OA_ANSWER_STREAM_UNAVAILABLE');

function linkedAbort(signal, timeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  return { controller, cleanup() { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
}
function splitText(text, maximum = 1024) {
  const parts = [];
  while (text) {
    let length = Math.min(maximum, text.length);
    if (/[\uD800-\uDBFF]$/u.test(text.slice(0, length))) length--;
    if (!length) throw failed();
    parts.push(text.slice(0, length)); text = text.slice(length);
  }
  return parts;
}

/** Parses the authenticated provider's actual SSE response, with no raw-body logging. */
export async function* readModelSse(response, signal) {
  if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'text/event-stream' || !response.body) {
    await response.body?.cancel().catch(() => {}); throw failed();
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = ''; let bytes = 0; let finished = false; let terminal = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw failed();
      const { value, done } = await reader.read();
      if (signal?.aborted) throw failed();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_UPSTREAM_BYTES) throw failed();
      pending = (pending + decoder.decode(value, { stream: true })).replace(/\r\n/gu, '\n');
      if (finished) { if (pending.trim()) throw failed(); continue; }
      for (;;) {
        const end = pending.indexOf('\n\n');
        if (end < 0) break;
        const event = pending.slice(0, end); pending = pending.slice(end + 2);
        const lines = event.split('\n');
        if (lines.some(line => line.length > 24 * 1024)) throw failed();
        const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        if (data === '[DONE]') { finished = true; break; }
        let packet;
        try { packet = JSON.parse(data); } catch { throw failed(); }
        if (!packet || typeof packet !== 'object' || Array.isArray(packet) || packet.error || !Array.isArray(packet.choices)) throw failed();
        if (!packet.choices.length && packet.usage) continue;
        if (packet.choices.length !== 1 || packet.choices[0]?.index !== 0) throw failed();
        if (terminal) throw failed();
        const choice = packet.choices[0];
        if (!choice.delta || typeof choice.delta !== 'object' || Array.isArray(choice.delta) || choice.delta.tool_calls || choice.delta.function_call
          || (choice.delta.role !== undefined && choice.delta.role !== 'assistant')) throw failed();
        const text = choice.delta.content ?? '';
        if (typeof text !== 'string' || !text.isWellFormed() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw failed();
        const finishReason = choice.finish_reason;
        if (finishReason !== null && finishReason !== undefined && !['stop', 'length', 'content_filter'].includes(finishReason)) throw failed();
        if (finishReason) terminal = true;
        if (signal?.aborted) throw failed();
        yield { text, finishReason: finishReason || null };
      }
      if (pending.length > 64 * 1024) throw failed();
      if (finished && pending.trim()) throw failed();
    }
    pending += decoder.decode();
    if (!finished || !terminal || pending.trim() || signal?.aborted) throw failed();
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Only completed, independently filtered paragraphs leave this private bridge. */
export async function* validatedModelParagraphs(context, engine, config, payload, signal) {
  const general = payload.answerType === 'general';
  const messages = general
    ? buildGeneralChatMessages({ question: payload.question, messages: [...payload.history, { role: 'user', content: payload.question }] })
    : buildGroundedChatMessages({ documents: payload.documents, history: [], question: payload.question, messages: [...payload.history, { role: 'user', content: payload.question }], scope: 'internal' });
  messages[0].content += '\n本次回答显示在企业微信聊天中。先用1至2句给出短结论并换段，随后补充必要内容。默认约500至900字，简单问题更短；明确要求详细时才展开。每段约60至150字，最长不超过300字，段落间空一行，避免表格、代码块、链接、联系方式、HTML和图片；不要为了篇幅中断句子。' +
    (general ? '' : '每个有资料依据的段落都包含有效的资料编号，编号紧跟事实；标题与下一段正文放在同一段。');
  const endpoint = aliyunEndpoint(config.baseUrl);
  const apiKey = await decryptSecret(config.encryptedKey, context.env.APP_ENCRYPTION_KEY);
  let raw = ''; let pending = ''; let emitted = 0; let paragraphs = 0;
  const visibleParagraph = value => {
    if (!value.trim()) return '';
    if (/<!--|<\/?[a-z][^>]*>|!\[|\[[^\]\r\n]*\]\s*\([^)]*\)/iu.test(value) || /\+\d[\d\s()-]{7,}\d/u.test(value)) throw failed();
    const visible = general ? engine.visibleGeneralAnswer(value) : engine.visibleAiAnswer(value, payload.documents.length);
    if (typeof visible !== 'string' || !visible.trim() || !visible.isWellFormed()) throw failed();
    return visible.trim();
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) throw failed();
    if (attempt) await engine.globalBudget(context);
    if (signal?.aborted) throw failed();
    const requestMessages = attempt ? [...messages, { role: 'assistant', content: raw }, { role: 'user', content: continuation }] : messages;
    const response = await context.runtime.fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ model: config.model, messages: requestMessages, temperature: 0.25, max_tokens: 2000, enable_thinking: false, stream: true }),
      redirect: 'manual', cache: 'no-store', credentials: 'omit', signal,
    });
    let finishReason = null;
    for await (const delta of readModelSse(response, signal)) {
      if (delta.finishReason === 'content_filter') throw failed();
      if (delta.finishReason) finishReason = delta.finishReason;
      raw += delta.text; pending += delta.text;
      if (raw.length > MAX_ANSWER_CHARS || pending.length > MAX_PENDING_CHARS) throw failed();
      for (;;) {
        const boundary = pending.indexOf('\n\n');
        if (boundary < 0) break;
        const paragraph = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
        const visible = visibleParagraph(paragraph);
        if (!visible) continue;
        const text = (paragraphs++ ? '\n\n' : '') + visible;
        emitted += text.length;
        if (emitted > MAX_ANSWER_CHARS) throw failed();
        for (const part of splitText(text)) { if (signal?.aborted) throw failed(); yield part; }
      }
    }
    if (finishReason === 'content_filter' || !finishReason) throw failed();
    if (finishReason === 'length' && attempt === 0) continue;
    if (finishReason === 'length') throw failed();
    const visible = visibleParagraph(pending);
    if (visible) {
      const text = (paragraphs++ ? '\n\n' : '') + visible;
      emitted += text.length;
      if (emitted > MAX_ANSWER_CHARS) throw failed();
      for (const part of splitText(text)) { if (signal?.aborted) throw failed(); yield part; }
    }
    if (!paragraphs) throw failed();
    return;
  }
  throw failed();
}

export function createOaAnswerStream(context, engine, config, payload) {
  const linked = linkedAbort(context.request.signal, 75_000);
  const iterator = validatedModelParagraphs(context, engine, config, payload, linked.controller.signal);
  let closed = false;
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const value = await iterator.next();
        if (closed) return;
        if (linked.controller.signal.aborted) throw failed();
        if (value.done) {
          controller.enqueue(encoder.encode(JSON.stringify({ type: 'done' }) + '\n'));
          closed = true; controller.close(); linked.cleanup();
        } else {
          controller.enqueue(encoder.encode(JSON.stringify({ type: 'delta', text: value.value }) + '\n'));
        }
      } catch {
        if (closed) return;
        closed = true; linked.controller.abort(); linked.cleanup();
        if (context.request.signal.aborted) controller.error(failed());
        else { controller.enqueue(encoder.encode(JSON.stringify({ type: 'error', code: 'unavailable' }) + '\n')); controller.close(); }
      }
    },
    async cancel() {
      closed = true; linked.controller.abort(); linked.cleanup();
      await iterator.return().catch(() => {});
    },
  }, { highWaterMark: 0 });
  return new Response(body, { headers: {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'private, no-store, max-age=0', 'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer', vary: 'Authorization', 'x-accel-buffering': 'no',
  } });
}

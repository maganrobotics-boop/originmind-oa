import { OA_CHAT_ORIGIN, OA_CHAT_PATH, signOaChatRequest } from '../chat-cloudflare/src/oa-chat-bridge.mjs';
import { knowledgeImageReferences } from './knowledge-image-references.mjs';
import type { RankedKnowledgeChunk } from './knowledge-policy';
import { questionAllowsGeneralKnowledge, questionPrefersGeneralKnowledge, questionRequiresKnowledgeEvidence } from '../chat-cloudflare/src/question-scope.mjs';

const MAX_WIRE_BYTES = 192 * 1024;
const MAX_LINE_CHARS = 24 * 1024;
const MAX_ANSWER_CHARS = 12_000;
const failed = () => new Error('WECOM_ANSWER_STREAM_UNAVAILABLE');
function prefix(value: string, maximum: number) {
  const result = String(value || '').slice(0, maximum);
  return /[\uD800-\uDBFF]$/u.test(result) ? result.slice(0, -1) : result;
}
function* parts(value: string): Generator<string> {
  while (value) {
    const part = prefix(value, 1024);
    if (!part) throw failed();
    yield part; value = value.slice(part.length);
  }
}

/** Same HMAC service binding as OA chat; accepts only server-retrieved evidence. */
export async function* streamBotOaAnswer(question: string, ranked: RankedKnowledgeChunk[], signal: AbortSignal): AsyncGenerator<string> {
  const chunks = ranked.slice(0, 3);
  const general = chunks.length ? questionPrefersGeneralKnowledge(question) : questionAllowsGeneralKnowledge(question);
  if (!general && !chunks.length) {
    yield questionRequiresKnowledgeEvidence(question) ? '目前知识库没有找到足够依据回答这个内部或项目问题。' : '目前没有足够信息回答这个问题。';
    return;
  }
  const { env } = await import('cloudflare:workers');
  const bindings = env as unknown as { PUBLIC_LAB_AI_SERVICE_TOKEN?: string; CHAT_SERVICE?: { fetch: typeof fetch } };
  const secret = bindings.PUBLIC_LAB_AI_SERVICE_TOKEN || '';
  const service = bindings.CHAT_SERVICE;
  if (secret.length < 32 || !service || typeof service.fetch !== 'function' || signal.aborted) throw failed();
  const documents = general ? [] : chunks.map((chunk, index) => ({
    id: String(index + 1), title: prefix(chunk.title, 300), body: prefix(chunk.content, 2200),
    updatedAt: prefix(chunk.updatedAt || '', 40), origin: 'oa_internal',
    assets: [...knowledgeImageReferences(chunk.content).values()].slice(0, 8).map(alt => ({ alt: prefix(alt, 300) })),
  }));
  const body = JSON.stringify({ operation: 'answer_stream', answerType: general ? 'general' : 'grounded', question, history: [], documents });
  if (new TextEncoder().encode(body).length > 96 * 1024) throw failed();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 80_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancelReader = () => { void reader?.cancel().catch(() => {}); };
  controller.signal.addEventListener('abort', cancelReader, { once: true });
  try {
    const response = await service.fetch(`${OA_CHAT_ORIGIN}${OA_CHAT_PATH}`, {
      method: 'POST', headers: { ...await signOaChatRequest(body, secret), accept: 'application/x-ndjson' },
      body, redirect: 'manual', cache: 'no-store', credentials: 'omit', signal: controller.signal,
    });
    if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/x-ndjson' || !response.body) {
      await response.body?.cancel().catch(() => {}); throw failed();
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = ''; let wireBytes = 0; let answerChars = 0; let first = true; let doneSeen = false;
    for (;;) {
      if (controller.signal.aborted) throw failed();
      const { value, done } = await reader.read();
      if (controller.signal.aborted) throw failed();
      if (done) break;
      wireBytes += value.byteLength;
      if (wireBytes > MAX_WIRE_BYTES) throw failed();
      pending += decoder.decode(value, { stream: true });
      if (doneSeen) { if (pending.trim()) throw failed(); continue; }
      for (;;) {
        const end = pending.indexOf('\n');
        if (end < 0) break;
        if (end > MAX_LINE_CHARS) throw failed();
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        let record;
        try { record = JSON.parse(line); } catch { throw failed(); }
        if (!record || typeof record !== 'object' || Array.isArray(record)) throw failed();
        if (record.type === 'done' && Object.keys(record).length === 1) {
          if (first || pending.trim() || controller.signal.aborted) throw failed();
          doneSeen = true; break;
        }
        if (record.type !== 'delta' || Object.keys(record).length !== 2 || typeof record.text !== 'string'
          || !record.text || record.text.length > 1024 || !record.text.isWellFormed()
          || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(record.text)) throw failed();
        let text = record.text;
        if (first && general) text = '**来源类型：模型通用知识（未引用 OA 资料）**\n\n' + text;
        first = false; answerChars += text.length;
        if (answerChars > MAX_ANSWER_CHARS) throw failed();
        for (const part of parts(text)) { if (controller.signal.aborted) throw failed(); yield part; }
      }
      if (pending.length > MAX_LINE_CHARS) throw failed();
    }
    pending += decoder.decode();
    if (!doneSeen || pending.trim() || controller.signal.aborted) throw failed();
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', cancelReader);
    controller.abort();
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}

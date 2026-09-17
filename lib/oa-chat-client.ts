import { OA_CHAT_ORIGIN, OA_CHAT_PATH, signOaChatRequest } from '../chat-cloudflare/src/oa-chat-bridge.mjs';
import { getDb } from '../db';
import { listKnowledgeRevisionAssets } from './knowledge-assets';
import { knowledgeImageReferences } from './knowledge-image-references.mjs';
import type { RankedKnowledgeChunk } from './knowledge-policy';

export type OaChatImage = { url: string; alt: string; mimeType: string };
export type OaChatHistory = Array<{ role: 'user'; content: string }>;
type BridgeResponse = { received?: boolean; answer?: string; mode?: string; provider?: string; fallbackReason?: string; modelReady?: boolean; budgetReady?: boolean; bridgeReady?: boolean };
function prefix(value: string, maximum: number) {
  const result = String(value || '').slice(0, maximum);
  return /[\uD800-\uDBFF]$/u.test(result) ? result.slice(0, -1) : result;
}
async function bridge(payload: object, timeoutMs: number): Promise<BridgeResponse> {
  const { env } = await import('cloudflare:workers');
  const bindings = env as typeof env & {
    PUBLIC_LAB_AI_SERVICE_TOKEN?: string;
    CHAT_SERVICE?: { fetch: typeof fetch };
  };
  const secret = bindings.PUBLIC_LAB_AI_SERVICE_TOKEN || '';
  if (secret.length < 32) throw new Error('CHAT_BRIDGE_SECRET_MISSING');
  // Chat is a same-zone Worker route: global fetch cannot dispatch to it.
  // Keep the signed service API and fail closed rather than send internal
  // evidence through a public-network fallback or the anonymous Chat API.
  const service = bindings.CHAT_SERVICE;
  if (!service || typeof service.fetch !== 'function') throw new Error('CHAT_BRIDGE_SERVICE_BINDING_MISSING');
  const body = JSON.stringify(payload);
  if (new TextEncoder().encode(body).length > 96 * 1024) throw new Error('CHAT_BRIDGE_REQUEST_LIMIT');
  const response = await service.fetch(`${OA_CHAT_ORIGIN}${OA_CHAT_PATH}`, {
    method: 'POST', headers: await signOaChatRequest(body, secret), body,
    cache: 'no-store', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`CHAT_BRIDGE_HTTP_${response.status}`);
  }
  if (!response.headers.get('content-type')?.startsWith('application/json') || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error('CHAT_BRIDGE_INVALID_RESPONSE');
  }
  const reader = response.body.getReader(); const parts: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.length;
      if (length > 96 * 1024) { await reader.cancel(); throw new Error('CHAT_BRIDGE_RESPONSE_LIMIT'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  let data: BridgeResponse;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as BridgeResponse; }
  catch { throw new Error('CHAT_BRIDGE_INVALID_RESPONSE'); }
  if (!data || data.received !== true) throw new Error('CHAT_BRIDGE_INVALID_RESPONSE');
  return data;
}
function reportBridgeFailure(error: unknown) {
  // Only allowlisted codes are logged. Never log the request, response body,
  // upstream exception text, question, evidence, signature, or service secret.
  const message = error instanceof Error ? error.message : '';
  const allowed = ['CHAT_BRIDGE_SECRET_MISSING', 'CHAT_BRIDGE_SERVICE_BINDING_MISSING',
    'CHAT_BRIDGE_REQUEST_LIMIT', 'CHAT_BRIDGE_RESPONSE_LIMIT', 'CHAT_BRIDGE_INVALID_RESPONSE'];
  const code = allowed.includes(message) || /^CHAT_BRIDGE_HTTP_[1-5]\d{2}$/u.test(message)
    ? message
    : error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)
      ? 'CHAT_BRIDGE_TIMEOUT' : 'CHAT_BRIDGE_TRANSPORT_ERROR';
  console.warn('OA_CHAT_BRIDGE_FAILURE', code);
}
export async function oaChatModelStatus() {
  try {
    const result = await bridge({ operation: 'status' }, 12000);
    return { bridgeReady: result.bridgeReady === true, modelReady: result.modelReady === true, budgetReady: result.budgetReady === true };
  } catch { return { bridgeReady: false, modelReady: false, budgetReady: false }; }
}
async function answerImages(chunks: RankedKnowledgeChunk[]): Promise<OaChatImage[]> {
  const references = chunks.map(chunk => ({ chunk, refs: knowledgeImageReferences(chunk.content) })).filter(item => item.refs.size);
  if (!references.length) return [];
  const db = await getDb(); const images: OaChatImage[] = []; const seen = new Set<string>();
  for (const { chunk, refs } of references) {
    const assets = await listKnowledgeRevisionAssets(db.$client, chunk.revisionId);
    for (const asset of assets) {
      const identity = `${chunk.itemId}:${chunk.revisionId}:${asset.assetPath}`;
      if (asset.itemId !== chunk.itemId || !refs.has(asset.assetPath) || seen.has(identity)) continue;
      seen.add(identity);
      images.push({
        url: `/api/knowledge/${encodeURIComponent(chunk.itemId)}/assets/${asset.assetPath.split('/').map(encodeURIComponent).join('/')}?forChat=1&revision=${encodeURIComponent(chunk.revisionId)}`,
        alt: prefix(refs.get(asset.assetPath) || '资料插图', 300), mimeType: asset.mimeType,
      });
      if (images.length >= 4) return images;
    }
  }
  return images;
}
/** Receives only chunks obtained by the authenticated OA route. Browser input
 * cannot set documents, visibility, item IDs or a retrieval capability. */
export async function answerOaChatQuestion(question: string, ranked: RankedKnowledgeChunk[], history: OaChatHistory = []) {
  const chunks = ranked.slice(0, 6);
  if (!chunks.length) return { answer: '目前知识库没有找到足够依据回答这个问题。', citations: [], images: [], mode: 'no_evidence' };
  const documents = chunks.map((chunk, index) => ({
    id: String(index + 1), title: prefix(chunk.title, 300), body: prefix(chunk.content, 3500),
    updatedAt: prefix(chunk.updatedAt || '', 40), origin: 'oa_internal',
    assets: [...knowledgeImageReferences(chunk.content).values()].slice(0, 8).map(alt => ({ alt: prefix(alt, 300) })),
  }));
  let result: BridgeResponse;
  try { result = await bridge({ operation: 'answer', question, history: history.slice(-2), documents }, 70000); }
  catch (error) {
    reportBridgeFailure(error);
    return { answer: '已检索到相关资料，但问答服务暂未能生成完整答复，请稍后重试。', citations: [], images: [], mode: 'retrieval', fallbackReason: 'shared_model_unavailable' };
  }
  if (typeof result.answer !== 'string' || !result.answer.trim() || result.answer.length > 12000 || !result.answer.isWellFormed()) throw new Error('CHAT_BRIDGE_INVALID_ANSWER');
  const citations = chunks.map((chunk, index) => ({ id: String(index + 1), itemId: chunk.itemId, revisionId: chunk.revisionId, title: chunk.title, category: chunk.category, sectionTitle: chunk.sectionTitle, paragraphRef: chunk.paragraphRef, excerpt: prefix(chunk.content, 600) }));
  let images: OaChatImage[] = [];
  try { images = await answerImages(chunks); } catch { /* A failed image lookup must not discard the complete text. */ }
  return { answer: result.answer, citations, images, mode: result.mode, provider: result.provider, fallbackReason: result.fallbackReason };
}

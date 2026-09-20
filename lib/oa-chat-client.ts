import { OA_CHAT_ORIGIN, OA_CHAT_PATH, signOaChatRequest } from '../chat-cloudflare/src/oa-chat-bridge.mjs';
import { getDb } from '../db';
import { listKnowledgeRevisionAssets } from './knowledge-assets';
import { knowledgeImageReferences } from './knowledge-image-references.mjs';
import type { RankedKnowledgeChunk } from './knowledge-policy';
import { questionAllowsGeneralKnowledge, questionPrefersGeneralKnowledge, questionRequestsKnowledgeImages, questionRequiresKnowledgeEvidence } from '../chat-cloudflare/src/question-scope.mjs';
export { questionAllowsGeneralKnowledge, questionPrefersGeneralKnowledge, questionRequestsKnowledgeImages, questionRequiresKnowledgeEvidence } from '../chat-cloudflare/src/question-scope.mjs';

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
    // Manual mode works across workerd versions and never follows a Location.
    // The !response.ok guard below rejects every 3xx before reading its body.
    cache: 'no-store', redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs),
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
function retryableBridgeFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  if (['AbortError', 'TimeoutError'].includes(error.name)) return true;
  if (error.message === 'CHAT_BRIDGE_TRANSPORT_ERROR') return true;
  const status = error.message.match(/^CHAT_BRIDGE_HTTP_(\d{3})$/u)?.[1];
  return status ? Number(status) === 429 || Number(status) >= 500 : !error.message.startsWith('CHAT_BRIDGE_');
}
async function groundedBridge(payload: object): Promise<BridgeResponse> {
  try { return await bridge(payload, 70000); }
  catch (error) {
    if (!retryableBridgeFailure(error)) throw error;
    return bridge(payload, 70000);
  }
}
export async function oaChatModelStatus() {
  try {
    const result = await bridge({ operation: 'status' }, 12000);
    return { bridgeReady: result.bridgeReady === true, modelReady: result.modelReady === true, budgetReady: result.budgetReady === true };
  } catch { return { bridgeReady: false, modelReady: false, budgetReady: false }; }
}
async function answerImages(chunks: RankedKnowledgeChunk[], includeRevisionImages = false): Promise<OaChatImage[]> {
  const references = chunks.map(chunk => ({ chunk, refs: knowledgeImageReferences(chunk.content) }))
    .filter(item => includeRevisionImages || item.refs.size);
  if (!references.length) return [];
  const db = await getDb(); const images: OaChatImage[] = []; const seen = new Set<string>();
  for (const { chunk, refs } of references) {
    const assets = await listKnowledgeRevisionAssets(db.$client, chunk.revisionId);
    for (const asset of assets) {
      const identity = `${chunk.itemId}:${chunk.revisionId}:${asset.assetPath}`;
      if (asset.itemId !== chunk.itemId || (!includeRevisionImages && !refs.has(asset.assetPath)) || seen.has(identity)) continue;
      seen.add(identity);
      images.push({
        url: `/api/knowledge/${encodeURIComponent(chunk.itemId)}/assets/${asset.assetPath.split('/').map(encodeURIComponent).join('/')}?forChat=1&revision=${encodeURIComponent(chunk.revisionId)}`,
        alt: prefix(refs.get(asset.assetPath) || asset.assetPath.split('/').at(-1) || '资料插图', 300), mimeType: asset.mimeType,
      });
      if (images.length >= 4) return images;
    }
  }
  return images;
}
/** Receives only chunks obtained by the authenticated OA route. Browser input
 * cannot set documents, visibility, item IDs or a retrieval capability. */
export async function answerOaChatQuestion(question: string, ranked: RankedKnowledgeChunk[], history: OaChatHistory = []) {
  const imageRequest = questionRequestsKnowledgeImages(question);\n  // For image requests, keep a broader text-ranked window so a legacy\n  // text-only item cannot mask a newer approved revision with ready assets.\n  const chunks = ranked.slice(0, imageRequest ? 12 : 3);
  const generalKnowledge = chunks.length
    ? questionPrefersGeneralKnowledge(question)
    : questionAllowsGeneralKnowledge(question);
  if (generalKnowledge) {
    try {
      const result = await bridge({ operation: 'answer', answerType: 'general', question, history: history.slice(-2), documents: [] }, 70000);
      if (result.mode !== 'general' || typeof result.answer !== 'string' || !result.answer.trim() || result.answer.length > 12000 || !result.answer.isWellFormed()) throw new Error('CHAT_BRIDGE_INVALID_ANSWER');
      return { answer: `**来源类型：模型通用知识（未引用 OA 资料）**\n\n${result.answer.trim()}`, citations: [], images: [], mode: 'general', provider: result.provider, sourceType: 'model_general_knowledge' };
    } catch (error) {
      reportBridgeFailure(error);
      return { answer: '这是普通常识问题，但通用知识回答服务暂不可用，请稍后重试。', citations: [], images: [], mode: 'retrieval', fallbackReason: 'general_model_unavailable', sourceType: 'model_general_knowledge' };
    }
  }
  if (!chunks.length) return { answer: questionRequiresKnowledgeEvidence(question) ? '目前知识库没有找到足够依据回答这个内部或项目问题。' : '目前没有足够信息回答这个问题。', citations: [], images: [], mode: 'no_evidence', sourceType: 'oa_knowledge_required' };
  const documents = chunks.map((chunk, index) => ({
    id: String(index + 1), title: prefix(chunk.title, 300), body: prefix(chunk.content, 2200),
    updatedAt: prefix(chunk.updatedAt || '', 40), origin: 'oa_internal',
    assets: [...knowledgeImageReferences(chunk.content).values()].slice(0, 8).map(alt => ({ alt: prefix(alt, 300) })),
  }));
  const citations = chunks.map((chunk, index) => ({ id: String(index + 1), itemId: chunk.itemId, revisionId: chunk.revisionId, title: chunk.title, category: chunk.category, sectionTitle: chunk.sectionTitle, paragraphRef: chunk.paragraphRef, excerpt: prefix(chunk.content, 600) }));
  let images: OaChatImage[] = [];
  const imageRequest = questionRequestsKnowledgeImages(question);
  try { images = await answerImages(chunks, imageRequest); } catch { /* A failed image lookup must not discard the complete text. */ }
  if (imageRequest) {
    if (images.length) return { answer: `已找到 ${images.length} 张与问题相关的已审核资料图片，显示如下。`, citations, images, mode: 'ai', sourceType: 'oa_knowledge_images' };
    return { answer: '已找到相关文字资料，但当前已审核版本没有可展示的图片。请由管理员在知识资料中补充图片并完成审核后再试。', citations, images: [], mode: 'no_evidence', sourceType: 'oa_knowledge_images_unavailable' };
  }
  let result: BridgeResponse;
  try { result = await groundedBridge({ operation: 'answer', answerType: 'grounded', question, history: history.slice(-2), documents }); }
  catch (error) {
    reportBridgeFailure(error);
    return { answer: '已检索到相关资料，但问答服务暂未能生成完整答复，请稍后重试。', citations: [], images: [], mode: 'retrieval', fallbackReason: 'shared_model_unavailable' };
  }
  if (typeof result.answer !== 'string' || !result.answer.trim() || result.answer.length > 12000 || !result.answer.isWellFormed()) throw new Error('CHAT_BRIDGE_INVALID_ANSWER');
  return { answer: result.answer, citations, images, mode: result.mode, provider: result.provider, fallbackReason: result.fallbackReason };
}

/** Task material is supplied by the admitted task owner, not claimed as approved knowledge. */
export async function generateOaTask(input: { kind: string; title: string; instruction: string; material: string }): Promise<string> {
  const result = await bridge({ operation: 'task', task: input }, 70000);
  if (result.mode !== 'task' || typeof result.answer !== 'string' || !result.answer.trim()) throw new Error('TASK_MODEL_UNAVAILABLE');
  return result.answer;
}

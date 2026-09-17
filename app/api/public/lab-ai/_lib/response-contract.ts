import { answerCodeTokenAt, answerMathTokenAt } from "../../../../../chat-cloudflare/src/answer-math.mjs";
import { cleanPublicChatText } from "../../../../../chat-cloudflare/src/public-text.mjs";
import { knowledgeSearchTerms, type RankedKnowledgeChunk } from "../../../../../lib/knowledge-policy";
import type { PublicKnowledgeSuggestionCandidate } from "../../../../../lib/knowledge-store";

export const PUBLIC_LAB_AI_MAX_CHUNKS = 6;
export const PUBLIC_LAB_AI_MAX_SUGGESTIONS = 5;
export const PUBLIC_LAB_AI_MAX_EXCERPT_CHARS = 600;
export const PUBLIC_LAB_AI_MAX_TOTAL_EXCERPT_CHARS = 3_000;
export const PUBLIC_LAB_AI_MAX_TOTAL_TEXT_CHARS = 4_096;
export const PUBLIC_LAB_AI_MAX_RESPONSE_BYTES = 16 * 1_024;

type PublicLabAiAsset = { token: string; mimeType: string; alt: string };

type PublicLabAiChunk = {
  assets?: PublicLabAiAsset[];
  id: string;
  title: string;
  category: string;
  sectionTitle: string;
  paragraphRef: string;
  excerpt: string;
  sourceLabel: string;
  updatedAt: string;
};

export type PublicLabAiRetrieveResponse = { chunks: PublicLabAiChunk[] };

type PublicLabAiSuggestion = {
  id: string;
  question: string;
  updatedAt: string;
};

export type PublicLabAiSuggestionsResponse = { suggestions: PublicLabAiSuggestion[] };

const DAY_MS = 24 * 60 * 60 * 1_000;
const BEIJING_UTC_OFFSET_MS = 8 * 60 * 60 * 1_000;

export function publicLabAiSuggestionDayOrdinal(now = new Date()): number {
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp)) throw new RangeError("invalid public suggestion date");
  return Math.floor((timestamp + BEIJING_UTC_OFFSET_MS) / DAY_MS);
}

function makeWellFormed(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        result += value[index] + value[index + 1];
        index += 1;
      } else result += "\uFFFD";
    } else if (code >= 0xDC00 && code <= 0xDFFF) result += "\uFFFD";
    else result += value[index];
  }
  return result;
}

function safePrefix(value: string, maxLength: number): string {
  let end = Math.min(value.length, maxLength);
  if (end < value.length
    && /[\uD800-\uDBFF]/u.test(value[end - 1] ?? "")
    && /[\uDC00-\uDFFF]/u.test(value[end] ?? "")) end -= 1;
  return value.slice(0, end);
}

function boundedLine(value: string, maxLength: number): string {
  const normalized = makeWellFormed(value)
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return safePrefix(normalized, maxLength).trimEnd();
}

// Labels are single-line; document bodies are not. Flattening Markdown here
// destroys headings/tables before either the model or the renderer sees them.
function normalizedContent(value: string): string {
  return makeWellFormed(value).replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ").trim();
}

function boundedExcerpt(value: string, maxLength: number): string {
  const normalized = normalizedContent(value);
  if (normalized.length <= maxLength) return normalized;
  if (maxLength <= 1) return "…";
  let end = safePrefix(normalized, maxLength - 1).length;
  // Never send an unclosed formula or code token solely because the transport
  // budget ends inside it. Keep the same strict character and byte ceilings.
  let boundary = 0;
  for (let index = 0; index < end;) {
    const token = (normalized[index] === "`" || normalized[index] === "~" ? answerCodeTokenAt(normalized, index) : null)
      || (normalized[index] === "\\" || normalized[index] === "$" ? answerMathTokenAt(normalized, index) : null);
    if (token) {
      if (token.end > end) { end = index; break; }
      index = token.end;
    } else {
      if (normalized[index] === "\n") boundary = index;
      else if (/[。！？]/u.test(normalized[index])) boundary = index + 1;
      index += 1;
    }
  }
  const prefix = normalized.slice(0, boundary > end / 2 ? boundary : end);
  return `${prefix.trimEnd()}…`;
}

function validDate(value: string): string | null {
  const date = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
}

function textLength(value: Omit<PublicLabAiChunk, "excerpt">): number {
  return Object.values(value).reduce((total, field) => total + (typeof field === "string" ? field.length : 0), 0);
}

export function buildPublicLabAiRetrieveResponse(ranked: RankedKnowledgeChunk[], assetsByChunk: Map<string, PublicLabAiAsset[]> = new Map()): PublicLabAiRetrieveResponse {
  const candidates = ranked.slice(0, PUBLIC_LAB_AI_MAX_CHUNKS).flatMap((chunk, index) => {
    const title = boundedLine(chunk.title, 100);
    const category = boundedLine(chunk.category, 40);
    const content = normalizedContent(chunk.content);
    const updatedAt = validDate(chunk.updatedAt);
    if (title.length < 2 || !category || !content || !updatedAt) return [];
    return [{
      metadata: {
        ...(assetsByChunk.has(chunk.id) ? { assets: assetsByChunk.get(chunk.id) } : {}),
        id: String(index + 1),
        title,
        category,
        sectionTitle: boundedLine(chunk.sectionTitle, 100),
        paragraphRef: boundedLine(chunk.paragraphRef, 80),
        sourceLabel: boundedLine(chunk.sourceLabel, 160),
        updatedAt,
      },
      content,
    }];
  });

  candidates.forEach((candidate, index) => { candidate.metadata.id = String(index + 1); });
  const metadataLength = candidates.reduce((total, candidate) => total + textLength(candidate.metadata), 0);
  let excerptBudget = Math.min(
    PUBLIC_LAB_AI_MAX_TOTAL_EXCERPT_CHARS,
    Math.max(0, PUBLIC_LAB_AI_MAX_TOTAL_TEXT_CHARS - metadataLength),
  );
  const chunks = candidates.flatMap((candidate, index) => {
    const remainingChunks = candidates.length - index;
    const allowance = Math.min(PUBLIC_LAB_AI_MAX_EXCERPT_CHARS, Math.floor(excerptBudget / remainingChunks));
    if (allowance < 1) return [];
    const excerpt = boundedExcerpt(candidate.content, allowance);
    if (!excerpt) return [];
    excerptBudget -= excerpt.length;
    return [{ ...candidate.metadata, excerpt }];
  });
  chunks.forEach((chunk, index) => { chunk.id = String(index + 1); });
  // Text keeps its existing budget; optional image metadata must never break retrieval.
  if (new TextEncoder().encode(JSON.stringify({ chunks })).byteLength > PUBLIC_LAB_AI_MAX_RESPONSE_BYTES) {
    for (const chunk of chunks) delete chunk.assets;
  }
  return { chunks };
}

export function buildPublicLabAiSuggestionsResponse(
  candidates: readonly PublicKnowledgeSuggestionCandidate[],
  now = new Date(),
): PublicLabAiSuggestionsResponse {
  const eligible: Omit<PublicLabAiSuggestion, "id">[] = [];
  const seenTitles = new Set<string>();
  for (const candidate of candidates) {
    const title = cleanPublicChatText(boundedLine(candidate.title, 100));
    const sectionTitle = cleanPublicChatText(boundedLine(candidate.sectionTitle, 100));
    const updatedAt = validDate(candidate.updatedAt);
    const normalizedTitle = title.toLocaleLowerCase("zh-CN");
    const titleTerms = knowledgeSearchTerms(title);
    if (title.length < 2 || !titleTerms.length || !updatedAt || seenTitles.has(normalizedTitle)) continue;
    const meaningfulSection = sectionTitle.length >= 2 &&
      sectionTitle.toLocaleLowerCase("zh-CN") !== normalizedTitle &&
      knowledgeSearchTerms(sectionTitle).length > 0;
    const question = meaningfulSection
      ? `《${title}》中的“${sectionTitle}”有哪些值得关注的内容？`
      : `《${title}》有哪些值得关注的核心内容？`;
    const questionTerms = new Set(knowledgeSearchTerms(question));
    if (question.length > 300 || !questionTerms.size || !titleTerms.some((term) => questionTerms.has(term))) continue;
    seenTitles.add(normalizedTitle);
    eligible.push({ question, updatedAt });
  }

  if (!eligible.length) return { suggestions: [] };
  const day = publicLabAiSuggestionDayOrdinal(now);
  const offset = ((day % eligible.length) + eligible.length) % eligible.length;
  const rotated = [...eligible.slice(offset), ...eligible.slice(0, offset)];
  const suggestions = rotated.slice(0, PUBLIC_LAB_AI_MAX_SUGGESTIONS).map((suggestion, index) => ({
    id: String(index + 1),
    ...suggestion,
  }));
  return { suggestions };
}

export function publicLabAiJson(data: unknown, init: ResponseInit = {}): Response {
  const body = JSON.stringify(data);
  if (new TextEncoder().encode(body).byteLength > PUBLIC_LAB_AI_MAX_RESPONSE_BYTES) {
    throw new RangeError("public lab AI response exceeds its byte limit");
  }
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "private, no-store, max-age=0");
  return new Response(body, { ...init, headers });
}

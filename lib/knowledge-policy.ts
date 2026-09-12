export const KNOWLEDGE_PROJECT = "OriginMind × ARTS Robotics 联合研发项目";

export const KNOWLEDGE_STATUSES = ["pending", "returned", "rejected", "active", "revoked"] as const;
export type KnowledgeStatus = typeof KNOWLEDGE_STATUSES[number];

export const KNOWLEDGE_VISIBILITIES = ["internal", "public"] as const;
export type KnowledgeVisibility = typeof KNOWLEDGE_VISIBILITIES[number];
export const PUBLIC_KNOWLEDGE_CONFIRMATION = "publish_to_chat.omindos.ai";
export const KNOWLEDGE_ADMIN_SELF_AUDIT_MARKER = "[系统管理员本人操作]";

export function knowledgeAdminSelfAuditNote(note: string): string {
  return note ? `${KNOWLEDGE_ADMIN_SELF_AUDIT_MARKER} ${note}` : KNOWLEDGE_ADMIN_SELF_AUDIT_MARKER;
}

export function isKnowledgeAdminSelfAuditNote(value: unknown): value is string {
  return typeof value === "string"
    && (value === KNOWLEDGE_ADMIN_SELF_AUDIT_MARKER || value.startsWith(`${KNOWLEDGE_ADMIN_SELF_AUDIT_MARKER} `));
}

export const KNOWLEDGE_REVIEW_ACTIONS = ["approve", "return", "reject", "revoke"] as const;
export type KnowledgeReviewAction = typeof KNOWLEDGE_REVIEW_ACTIONS[number];

export const MAX_KNOWLEDGE_TITLE_LENGTH = 100;
export const MAX_KNOWLEDGE_CATEGORY_LENGTH = 40;
export const MAX_KNOWLEDGE_SUMMARY_LENGTH = 400;
export const MAX_KNOWLEDGE_SOURCE_LABEL_LENGTH = 160;
export const MAX_KNOWLEDGE_SOURCE_URL_LENGTH = 2_048;
export const MAX_KNOWLEDGE_CONTENT_LENGTH = 20_000;
export const MAX_KNOWLEDGE_REVIEW_NOTE_LENGTH = 1_000;
export const MAX_KNOWLEDGE_QUESTION_LENGTH = 500;
export const MAX_KNOWLEDGE_CHUNKS = 32;
const MAX_KNOWLEDGE_SEARCH_TERMS = 64;

export type KnowledgeSubmission = {
  title: string;
  category: string;
  summary: string;
  sourceLabel: string;
  sourceUrl: string;
  content: string;
};

export type KnowledgeChunkDraft = {
  chunkNo: number;
  sectionTitle: string;
  paragraphRef: string;
  content: string;
  searchText: string;
};

export type SearchableKnowledgeChunk = {
  id: string;
  itemId: string;
  revisionId: string;
  title: string;
  category: string;
  sourceLabel: string;
  sourceUrl: string;
  sectionTitle: string;
  paragraphRef: string;
  content: string;
  searchText: string;
  updatedAt: string;
};

export type RankedKnowledgeChunk = SearchableKnowledgeChunk & { score: number };

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xDC00 || next > 0xDFFF) return false;
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return false;
    }
  }
  return true;
}

export function normalizeKnowledgeText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{4,}/gu, "\n\n\n")
    .trim();
}

function oneLine(value: unknown): string {
  return normalizeKnowledgeText(stringValue(value)).replace(/\s+/gu, " ").trim();
}

function sourceUrl(value: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (value === undefined || value === "") return { ok: true, value: "" };
  if (typeof value !== "string") return { ok: false, error: "来源链接格式不正确。" };
  const raw = value.trim();
  if (raw.length > MAX_KNOWLEDGE_SOURCE_URL_LENGTH) return { ok: false, error: `来源链接不能超过 ${MAX_KNOWLEDGE_SOURCE_URL_LENGTH} 个字符。` };
  try {
    const parsed = new URL(raw);
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password) throw new Error("invalid source URL");
    parsed.hash = "";
    return { ok: true, value: parsed.toString() };
  } catch {
    return { ok: false, error: "来源链接必须是有效的 HTTP 或 HTTPS 地址。" };
  }
}

export function parseKnowledgeSubmission(value: Record<string, unknown>):
  | { ok: true; value: KnowledgeSubmission }
  | { ok: false; error: string } {
  const allowed = new Set(["title", "category", "summary", "sourceLabel", "sourceUrl", "content"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return { ok: false, error: "投稿包含不支持的字段。" };
  if (typeof value.title !== "string" || typeof value.category !== "string" || typeof value.content !== "string") {
    return { ok: false, error: "请填写标题、分类和正文。" };
  }
  if (["title", "category", "summary", "sourceLabel", "sourceUrl", "content"].some((field) => {
    const fieldValue = value[field];
    return typeof fieldValue === "string" && !isWellFormedUnicode(fieldValue);
  })) return { ok: false, error: "投稿文本包含无效的 Unicode 字符。" };

  const title = oneLine(value.title);
  const category = oneLine(value.category);
  const content = normalizeKnowledgeText(value.content);
  const suppliedSummary = value.summary === undefined ? "" : oneLine(value.summary);
  const sourceLabel = value.sourceLabel === undefined ? "" : oneLine(value.sourceLabel);
  const parsedSourceUrl = sourceUrl(value.sourceUrl);
  if (value.summary !== undefined && typeof value.summary !== "string") return { ok: false, error: "知识摘要格式不正确。" };
  if (value.sourceLabel !== undefined && typeof value.sourceLabel !== "string") return { ok: false, error: "来源名称格式不正确。" };
  if (title.length < 2 || title.length > MAX_KNOWLEDGE_TITLE_LENGTH) return { ok: false, error: `标题需为 2–${MAX_KNOWLEDGE_TITLE_LENGTH} 个字符。` };
  if (!category || category.length > MAX_KNOWLEDGE_CATEGORY_LENGTH) return { ok: false, error: `分类需为 1–${MAX_KNOWLEDGE_CATEGORY_LENGTH} 个字符。` };
  if (content.length < 10 || content.length > MAX_KNOWLEDGE_CONTENT_LENGTH) return { ok: false, error: `正文需为 10–${MAX_KNOWLEDGE_CONTENT_LENGTH} 个字符。` };
  if (suppliedSummary.length > MAX_KNOWLEDGE_SUMMARY_LENGTH) return { ok: false, error: `摘要不能超过 ${MAX_KNOWLEDGE_SUMMARY_LENGTH} 个字符。` };
  if (sourceLabel.length > MAX_KNOWLEDGE_SOURCE_LABEL_LENGTH) return { ok: false, error: `来源名称不能超过 ${MAX_KNOWLEDGE_SOURCE_LABEL_LENGTH} 个字符。` };
  if (!parsedSourceUrl.ok) return parsedSourceUrl;

  const normalizedSummary = content.replace(/\s+/gu, " ");
  const summary = suppliedSummary || safePrefix(normalizedSummary, 180);
  return { ok: true, value: { title, category, summary, sourceLabel, sourceUrl: parsedSourceUrl.value, content } };
}

export function parseKnowledgeReviewAction(value: unknown): KnowledgeReviewAction | null {
  return typeof value === "string" && (KNOWLEDGE_REVIEW_ACTIONS as readonly string[]).includes(value)
    ? value as KnowledgeReviewAction
    : null;
}

export function parseKnowledgeVisibility(value: unknown): KnowledgeVisibility | null {
  return typeof value === "string" && (KNOWLEDGE_VISIBILITIES as readonly string[]).includes(value)
    ? value as KnowledgeVisibility
    : null;
}

export function isPublicKnowledgeConfirmation(value: unknown): boolean {
  return value === PUBLIC_KNOWLEDGE_CONFIRMATION;
}

export function parseReviewNote(value: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (value !== undefined && typeof value !== "string") return { ok: false, error: "审核意见格式不正确。" };
  if (typeof value === "string" && !isWellFormedUnicode(value)) return { ok: false, error: "审核意见包含无效的 Unicode 字符。" };
  const note = oneLine(value);
  if (note.length > MAX_KNOWLEDGE_REVIEW_NOTE_LENGTH) return { ok: false, error: `审核意见不能超过 ${MAX_KNOWLEDGE_REVIEW_NOTE_LENGTH} 个字符。` };
  return { ok: true, value: note };
}

export function knowledgeActionAllowed(status: string, action: KnowledgeReviewAction): boolean {
  if (action === "approve" || action === "return" || action === "reject") return status === "pending";
  return action === "revoke" && status === "active";
}

export async function hashKnowledgeSubmission(submission: KnowledgeSubmission): Promise<string> {
  const canonical = JSON.stringify([submission.title, submission.category, submission.summary, submission.sourceLabel, submission.sourceUrl, submission.content]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizedSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/gu, " ").trim();
}

function safeChunkEnd(value: string, start: number, maxLength: number): number {
  let end = Math.min(start + maxLength, value.length);
  if (end < value.length
    && /[\uD800-\uDBFF]/u.test(value[end - 1])
    && /[\uDC00-\uDFFF]/u.test(value[end])) end -= 1;
  return end;
}

function safePrefix(value: string, maxLength: number): string {
  return value.slice(0, safeChunkEnd(value, 0, maxLength));
}

function splitLongParagraph(paragraph: string, maxLength: number): string[] {
  if (paragraph.length <= maxLength) return [paragraph];
  const segments = paragraph.split(/(?<=[。！？!?；;])\s*/u).filter(Boolean);
  if (segments.length === 1) {
    const pieces: string[] = [];
    for (let offset = 0; offset < paragraph.length;) {
      const end = safeChunkEnd(paragraph, offset, maxLength);
      pieces.push(paragraph.slice(offset, end));
      offset = end;
    }
    return pieces;
  }
  const pieces: string[] = [];
  let current = "";
  for (const segment of segments) {
    if (segment.length > maxLength) {
      if (current) pieces.push(current);
      pieces.push(...splitLongParagraph(segment, maxLength));
      current = "";
    } else if (!current || current.length + segment.length <= maxLength) {
      current += segment;
    } else {
      pieces.push(current);
      current = segment;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

export function chunkKnowledgeSubmission(submission: KnowledgeSubmission, maxLength = 900): KnowledgeChunkDraft[] {
  if (!Number.isSafeInteger(maxLength) || maxLength < 200 || maxLength > 2_000) throw new RangeError("invalid knowledge chunk length");
  const rawParagraphs = submission.content.split(/\n{2,}/u).map((part) => part.trim()).filter(Boolean);
  const paragraphs = rawParagraphs.flatMap((paragraph, sourceIndex) =>
    splitLongParagraph(paragraph, maxLength).map((content) => ({ content, sourceIndex: sourceIndex + 1 })),
  );
  const chunks: KnowledgeChunkDraft[] = [];
  let sectionTitle = "";
  let current: Array<{ content: string; sourceIndex: number }> = [];
  let currentLength = 0;

  const flush = () => {
    if (!current.length) return;
    const first = current[0].sourceIndex;
    const last = current[current.length - 1].sourceIndex;
    const content = current.map((part) => part.content).join("\n\n");
    chunks.push({
      chunkNo: chunks.length + 1,
      sectionTitle,
      paragraphRef: first === last ? `第 ${first} 段` : `第 ${first}–${last} 段`,
      content,
      searchText: normalizedSearchText([submission.title, submission.category, submission.summary, sectionTitle, content].filter(Boolean).join("\n")),
    });
    current = [];
    currentLength = 0;
  };

  for (const paragraph of paragraphs) {
    const heading = paragraph.content.match(/^#{1,6}\s+(.{1,80})$/u)?.[1]?.trim();
    if (heading) {
      flush();
      sectionTitle = heading;
    }
    const additional = paragraph.content.length + (current.length ? 2 : 0);
    if (current.length && currentLength + additional > maxLength) flush();
    current.push(paragraph);
    currentLength += paragraph.content.length + (current.length > 1 ? 2 : 0);
  }
  flush();
  if (chunks.length <= MAX_KNOWLEDGE_CHUNKS) return chunks;

  // Highly fragmented Markdown (for example thousands of tiny headings) must
  // not turn one accepted submission into thousands of D1 statements. Re-slice
  // the exact normalized text contiguously so both count and per-chunk size stay
  // bounded without dropping or duplicating any content.
  const bounded: KnowledgeChunkDraft[] = [];
  const paragraphBreaks = Array.from(submission.content.matchAll(/\n{2,}/gu), (match) => match.index);
  const paragraphAt = (offset: number) => 1 + paragraphBreaks.filter((index) => index < offset).length;
  for (let offset = 0; offset < submission.content.length;) {
    const end = safeChunkEnd(submission.content, offset, maxLength);
    const content = submission.content.slice(offset, end);
    const firstParagraph = paragraphAt(offset);
    const lastParagraph = paragraphAt(Math.max(offset, end - 1));
    const paragraphRef = firstParagraph === lastParagraph ? `第 ${firstParagraph} 段` : `第 ${firstParagraph}–${lastParagraph} 段`;
    bounded.push({
      chunkNo: bounded.length + 1,
      sectionTitle: "",
      paragraphRef,
      content,
      searchText: normalizedSearchText([submission.title, submission.category, submission.summary, content].filter(Boolean).join("\n")),
    });
    offset = end;
  }
  if (bounded.length > MAX_KNOWLEDGE_CHUNKS) throw new RangeError("knowledge content cannot be chunked within the safe limit");
  return bounded;
}

function searchTerms(question: string): string[] {
  const normalized = normalizedSearchText(question).replace(/[\p{P}\p{S}]+/gu, " ");
  const terms = new Set<string>();
  for (const token of normalized.match(/[a-z0-9][a-z0-9._+-]{1,31}/gu) ?? []) terms.add(token);
  for (const run of normalized.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    if (run.length <= 16) terms.add(run);
    for (let index = 0; index < run.length - 1; index += 1) terms.add(run.slice(index, index + 2));
    if (run.length >= 3) for (let index = 0; index < run.length - 2; index += 1) terms.add(run.slice(index, index + 3));
  }
  const useful = Array.from(terms)
    .filter((term) => !["什么", "怎么", "如何", "是否", "可以", "关于", "请问", "一下"].includes(term))
    .sort((left, right) => right.length - left.length);
  if (useful.length <= MAX_KNOWLEDGE_SEARCH_TERMS) return useful;
  return Array.from({ length: MAX_KNOWLEDGE_SEARCH_TERMS }, (_, index) => useful[Math.round(index * (useful.length - 1) / (MAX_KNOWLEDGE_SEARCH_TERMS - 1))]);
}

function occurrenceScore(haystack: string, needle: string, weight: number): number {
  if (!needle || !haystack.includes(needle)) return 0;
  let count = 0;
  let from = 0;
  while (count < 3) {
    const found = haystack.indexOf(needle, from);
    if (found < 0) break;
    count += 1;
    from = found + needle.length;
  }
  return weight * (1 + Math.max(0, count - 1) * 0.25);
}

export function rankKnowledgeChunks(question: string, candidates: SearchableKnowledgeChunk[], limit = 6): RankedKnowledgeChunk[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new RangeError("invalid knowledge result limit");
  const normalizedQuestion = normalizedSearchText(question).replace(/[\p{P}\p{S}\s]+/gu, "");
  const terms = searchTerms(question);
  if (!normalizedQuestion || !terms.length) return [];

  const ranked = candidates.map((candidate) => {
    const title = normalizedSearchText(candidate.title);
    const category = normalizedSearchText(candidate.category);
    const section = normalizedSearchText(candidate.sectionTitle);
    const content = normalizedSearchText(candidate.content);
    const searchText = normalizedSearchText(candidate.searchText);
    let score = occurrenceScore(title, normalizedQuestion, 18)
      + occurrenceScore(section, normalizedQuestion, 12)
      + occurrenceScore(content.replace(/\s+/gu, ""), normalizedQuestion, 10)
      + occurrenceScore(searchText.replace(/\s+/gu, ""), normalizedQuestion, 3);
    let matched = 0;
    for (const term of terms) {
      const termMatched = title.includes(term) || category.includes(term) || section.includes(term) || content.includes(term) || searchText.includes(term);
      if (termMatched) matched += 1;
      score += occurrenceScore(title, term, 5)
        + occurrenceScore(category, term, 2.5)
        + occurrenceScore(section, term, 3.5)
        + occurrenceScore(content, term, term.length >= 3 ? 1.6 : 0.8)
        + occurrenceScore(searchText, term, term.length >= 3 ? 0.4 : 0.2);
    }
    score += 5 * matched / terms.length;
    return { ...candidate, score: Math.round(score * 100) / 100 };
  }).filter((candidate) => candidate.score >= 2.5);

  ranked.sort((left, right) => right.score - left.score || right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
  const perItem = new Map<string, number>();
  return ranked.filter((candidate) => {
    const count = perItem.get(candidate.itemId) ?? 0;
    if (count >= 2) return false;
    perItem.set(candidate.itemId, count + 1);
    return true;
  }).slice(0, limit);
}

export function knowledgeExcerpt(value: string, maxLength = 260): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maxLength ? normalized : `${safePrefix(normalized, maxLength - 1).trimEnd()}…`;
}

export const __knowledgeTesting = { searchTerms };

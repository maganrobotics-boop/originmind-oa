import { hashKnowledgeSubmission, isWellFormedUnicode, parseKnowledgeSubmission, type KnowledgeSubmission } from "./knowledge-policy";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CATEGORIES: Record<string, string> = { student: "课题参与", research: "科研交流", business: "合作咨询" };

function safePrefix(value: string, length: number): string {
  const part = value.slice(0, length);
  return /[\uD800-\uDBFF]$/u.test(part) ? part.slice(0, -1) : part;
}

export function parseChatKnowledgeImport(body: Record<string, unknown>): { documentId: string; submissions: KnowledgeSubmission[] } {
  if (Object.keys(body).length !== 1 || !body.document || typeof body.document !== "object" || Array.isArray(body.document)) throw new Error("导入格式不正确。");
  const document = body.document as Record<string, unknown>;
  const fields = ["id", "title", "body", "url", "category", "updatedAt"];
  if (Object.keys(document).length !== fields.length || fields.some((field) => typeof document[field] !== "string" || !isWellFormedUnicode(document[field] as string))) throw new Error("导入资料字段不正确。");
  const value = document as Record<string, string>;
  if (!UUID.test(value.id) || value.title.trim().length < 2 || value.title.length > 120
    || value.body.trim().length < 10 || value.body.length > 30_000 || value.url.length > 1_500
    || !Object.hasOwn(CATEGORIES, value.category) || !/^\d{4}-\d{2}-\d{2}$/u.test(value.updatedAt)
    || !Number.isFinite(Date.parse(value.updatedAt)) || new Date(value.updatedAt).toISOString().slice(0, 10) !== value.updatedAt) throw new Error("导入资料的标题、正文、分类或日期不符合要求。");
  const parts = [];
  let remaining = value.body.trim();
  while (remaining) {
    const part = safePrefix(remaining, remaining.length > 20_000 ? Math.floor(remaining.length / 2) : remaining.length);
    parts.push(part);
    remaining = remaining.slice(part.length);
  }
  const submissions = parts.map((content, index) => {
    const parsed = parseKnowledgeSubmission({
      title: `${safePrefix(value.title.trim(), parts.length > 1 ? 85 : 100)}${parts.length > 1 ? `（${index + 1}/${parts.length}）` : ""}`,
      category: CATEGORIES[value.category],
      content,
      sourceLabel: safePrefix(`Chat 管理导入 · ${value.updatedAt} · ${value.title.trim()}`, 160),
      sourceUrl: value.url,
    });
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  });
  return { documentId: value.id, submissions };
}

export async function chatImportIdentity(accountUserId: string, documentId: string, submission: KnowledgeSubmission, part: number) {
  const contentHash = await hashKnowledgeSubmission(submission);
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["chat-import-v1", accountUserId, documentId, contentHash, part]))));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { contentHash, itemId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` };
}

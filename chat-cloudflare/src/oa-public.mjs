import { OA_PUBLIC_RETRIEVE_URL, PUBLIC_LAB_AI_SERVICE_TOKEN_PATTERN } from "./constants.mjs";

const MAX_QUESTION_LENGTH = 500;
const MAX_RESPONSE_BYTES = 16 * 1024;
const TIMEOUT_MS = 3_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export function isWellFormedUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function normalizedQuestion(value) {
  if (typeof value !== "string" || !isWellFormedUnicode(value)) return "";
  const clean = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  let end = Math.min(clean.length, MAX_QUESTION_LENGTH);
  if (
    end < clean.length &&
    /[\uD800-\uDBFF]/u.test(clean[end - 1]) &&
    /[\uDC00-\uDFFF]/u.test(clean[end])
  ) {
    end -= 1;
  }
  return clean.slice(0, end);
}

async function boundedJson(response) {
  const length = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error("OA_RESPONSE_TOO_LARGE");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("OA_RESPONSE_EMPTY");
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("OA_RESPONSE_TOO_LARGE");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const value of chunks) {
    all.set(value, offset);
    offset += value.length;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(all));
}

function stringField(value, { min = 0, max, trim = false, pattern } = {}) {
  if (typeof value !== "string" || !isWellFormedUnicode(value)) throw new Error("OA_RESPONSE_INVALID");
  const result = trim ? value.trim() : value;
  if (result.length < min || result.length > max || (pattern && !pattern.test(result))) {
    throw new Error("OA_RESPONSE_INVALID");
  }
  return result;
}

function exactObject(value, names) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("OA_RESPONSE_INVALID");
  const keys = Object.keys(value);
  if (keys.length !== names.length || names.some((name) => !Object.hasOwn(value, name))) {
    throw new Error("OA_RESPONSE_INVALID");
  }
  return value;
}

function validDate(value) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function parseOaResult(value) {
  const input = exactObject(value, ["chunks"]);
  if (!Array.isArray(input.chunks) || input.chunks.length > 6) throw new Error("OA_RESPONSE_INVALID");
  const items = input.chunks.map((candidate, index) => {
    const item = exactObject(candidate, [
      "id",
      "title",
      "category",
      "sectionTitle",
      "paragraphRef",
      "excerpt",
      "sourceLabel",
      "updatedAt",
    ]);
    const updatedAt = stringField(item.updatedAt, { max: 10, pattern: DATE_PATTERN });
    const parsed = {
      id: stringField(item.id, { max: 1, pattern: /^[1-6]$/u }),
      title: stringField(item.title, { trim: true, min: 2, max: 100 }),
      category: stringField(item.category, { trim: true, min: 1, max: 40 }),
      sectionTitle: stringField(item.sectionTitle, { max: 100 }),
      paragraphRef: stringField(item.paragraphRef, { max: 80 }),
      excerpt: stringField(item.excerpt, { trim: true, min: 1, max: 600 }),
      sourceLabel: stringField(item.sourceLabel, { max: 160 }),
      updatedAt,
    };
    if (!validDate(updatedAt) || parsed.id !== String(index + 1)) throw new Error("OA_RESPONSE_INVALID");
    return parsed;
  });
  if (items.reduce((total, item) => total + item.excerpt.length, 0) > 3_000) {
    throw new Error("OA_RESPONSE_INVALID");
  }
  if (items.reduce((total, item) => total + Object.values(item).reduce((sum, field) => sum + field.length, 0), 0) > 4_096) {
    throw new Error("OA_RESPONSE_INVALID");
  }
  return items;
}

export async function retrieveOa(question, context) {
  const token = context.env.PUBLIC_LAB_AI_SERVICE_TOKEN || "";
  const normalized = normalizedQuestion(question);
  if (!PUBLIC_LAB_AI_SERVICE_TOKEN_PATTERN.test(token)) {
    return { status: "not_configured", documents: [] };
  }
  if (normalized.length < 2) return { status: "unavailable", documents: [] };
  try {
    const response = await context.runtime.fetch(OA_PUBLIC_RETRIEVE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-originmind-public-lab-ai-service-token": token,
      },
      body: JSON.stringify({ question: normalized }),
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (!response.ok || mediaType !== "application/json") return { status: "unavailable", documents: [] };
    const chunks = parseOaResult(await boundedJson(response));
    return {
      status: "connected",
      documents: chunks.map((item) => ({
        id: `oa:${item.id}`,
        title: item.title,
        body: item.excerpt,
        url: "",
        category: item.category,
        updatedAt: item.updatedAt,
        published: 1,
        sectionTitle: item.sectionTitle,
        paragraphRef: item.paragraphRef,
        sourceLabel: item.sourceLabel,
        origin: "oa_public",
      })),
    };
  } catch {
    return { status: "unavailable", documents: [] };
  }
}

export async function retrieveOaPublicKnowledge(question, context) {
  return (await retrieveOa(question, context)).documents;
}

export async function probeOaPublicKnowledge(context) {
  return (await retrieveOa("公开知识连接检测", context)).status;
}

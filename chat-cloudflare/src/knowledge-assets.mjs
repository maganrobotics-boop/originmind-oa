import { OA_PUBLIC_RETRIEVE_URL, PUBLIC_LAB_AI_SERVICE_TOKEN_PATTERN, SECURITY_HEADERS } from "./constants.mjs";
import { KNOWLEDGE_ASSET_TOKEN_PATTERN, KNOWLEDGE_ASSET_MAX_BYTES, KNOWLEDGE_ASSET_MIMES, parseKnowledgeAssets } from "./knowledge-asset-token.mjs";
import { PublicError } from "./errors.mjs";
import { cleanPublicChatText } from "./public-text.mjs";

export function chatKnowledgeImages(documents) {
  const images = [];
  const seen = new Set();
  for (const document of documents) {
    for (const asset of parseKnowledgeAssets(document.assets || [])) {
      if (seen.has(asset.token)) continue;
      seen.add(asset.token);
      images.push({ url: `/api/knowledge/assets/${asset.token}`, mimeType: asset.mimeType, alt: cleanPublicChatText(asset.alt) || "资料插图" });
      if (images.length === 4) return images;
    }
  }
  return images;
}

function validSignature(bytes, mime) {
  const ascii = (start, end) => String.fromCharCode(...bytes.slice(start, end));
  if (mime === "image/png") return bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v);
  if (mime === "image/jpeg") return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return mime === "image/webp" && bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
}

export async function proxyKnowledgeAsset(context, token) {
  if (!KNOWLEDGE_ASSET_TOKEN_PATTERN.test(token) || new URL(context.request.url).search) throw new PublicError("知识图片不存在。", 404);
  const serviceToken = context.env.PUBLIC_LAB_AI_SERVICE_TOKEN || "";
  if (!PUBLIC_LAB_AI_SERVICE_TOKEN_PATTERN.test(serviceToken)) throw new PublicError("知识图片暂不可用。", 503);
  const url = new URL(`/api/public/lab-ai/assets/${token}`, OA_PUBLIC_RETRIEVE_URL).href;
  const init = {
    method: "GET", headers: { "x-originmind-public-lab-ai-service-token": serviceToken },
    redirect: "manual", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(12_000),
  };
  const service = context.env.OA_SERVICE;
  const response = typeof service?.fetch === "function"
    ? await service.fetch(new Request(url, init)) : await context.runtime.fetch(url, init);
  const mime = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  const length = Number(response.headers.get("content-length") || 0);
  if (response.status === 404) throw new PublicError("知识图片不存在或已撤回。", 404);
  if (response.status !== 200 || !KNOWLEDGE_ASSET_MIMES.has(mime) || !Number.isSafeInteger(length) || length < 0 || length > KNOWLEDGE_ASSET_MAX_BYTES) {
    await response.body?.cancel();
    throw new PublicError("知识图片暂不可用。", 502);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new PublicError("知识图片暂不可用。", 502);
  const pieces = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > KNOWLEDGE_ASSET_MAX_BYTES) throw new Error("IMAGE_SIZE");
      pieces.push(value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    throw new PublicError("知识图片暂不可用。", 502);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const piece of pieces) { bytes.set(piece, offset); offset += piece.length; }
  if (!validSignature(bytes, mime) || (length && total !== length)) throw new PublicError("知识图片暂不可用。", 502);
  return new Response(bytes, { headers: {
    ...SECURITY_HEADERS,
    "content-type": mime, "content-length": String(total),
    "Cache-Control": "private, no-store, max-age=0",
    "cross-origin-resource-policy": "same-origin", "Referrer-Policy": "no-referrer",
  } });
}

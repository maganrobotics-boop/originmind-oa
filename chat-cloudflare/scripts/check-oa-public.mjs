import { OA_PUBLIC_RETRIEVE_URL, PUBLIC_LAB_AI_SERVICE_TOKEN_PATTERN } from "../src/constants.mjs";
import { parseOaResult } from "../src/oa-public.mjs";

const MAX_RESPONSE_BYTES = 16 * 1024;
const PREFLIGHT_TIMEOUT_MS = 15_000;

async function boundedJson(response) {
  const length = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    throw new Error("OA public retrieve preflight returned an oversized response");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("OA public retrieve preflight returned an empty response");
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("OA public retrieve preflight returned an oversized response");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new Error("OA public retrieve preflight returned invalid JSON");
  }
}

export async function checkOaPublicRetrieve(publicToken, fetchImpl = fetch) {
  if (!PUBLIC_LAB_AI_SERVICE_TOKEN_PATTERN.test(publicToken)) {
    throw new Error("OA public retrieve preflight requires a normalized service token");
  }
  let response;
  try {
    response = await fetchImpl(OA_PUBLIC_RETRIEVE_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-originmind-public-lab-ai-service-token": publicToken,
      },
      body: JSON.stringify({ question: "公开知识连接检测" }),
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
    });
  } catch {
    throw new Error("OA public retrieve preflight could not reach the endpoint");
  }
  if (response.status !== 200) {
    throw new Error(`OA public retrieve preflight returned HTTP ${response.status}`);
  }
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new Error("OA public retrieve preflight did not return JSON");
  }
  const chunks = parseOaResult(await boundedJson(response));
  return {
    format: "originmind-chat-oa-public-preflight-v1",
    status: response.status,
    chunks: chunks.length,
  };
}

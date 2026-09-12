import { OA_PUBLIC_RETRIEVE_URL, PUBLIC_LAB_AI_SERVICE_TOKEN_PATTERN } from "../src/constants.mjs";
import { parseOaResult } from "../src/oa-public.mjs";

const MAX_RESPONSE_BYTES = 16 * 1024;
const PREFLIGHT_TIMEOUT_MS = 15_000;
const PREFLIGHT_QUESTION = "请根据公开资料简要说明 ARTS Robotics 的机器人研究方向。";
const OA_PUBLIC_ORIGIN = new URL(OA_PUBLIC_RETRIEVE_URL).origin;

async function boundedJson(response) {
  const length = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    throw new Error("oversized");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty");
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("oversized");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
}

function httpClassification(status) {
  if (status === 401 || status === 403) return "credential_rejected_or_wrong_live_target";
  if (status === 404 || status === 405) return "route_missing_or_wrong_live_target";
  if (status === 429) return "rate_limited";
  if (status === 503) return "service_unavailable";
  if (status >= 300 && status < 400) return "unexpected_redirect";
  return "edge_or_upstream_failure";
}

function receipt(clock, startedAt, classification, httpStatus = null, chunkCount = null) {
  const finishedAt = clock();
  return {
    format: "originmind-chat-oa-public-preflight-v1",
    checkedAt: new Date(finishedAt).toISOString(),
    origin: OA_PUBLIC_ORIGIN,
    classification,
    httpStatus,
    chunkCount,
    durationMs: Math.max(0, finishedAt - startedAt),
  };
}

export async function checkOaPublicRetrieve(
  publicToken,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = PREFLIGHT_TIMEOUT_MS,
    clock = () => Date.now(),
  } = {},
) {
  if (!PUBLIC_LAB_AI_SERVICE_TOKEN_PATTERN.test(publicToken)) {
    throw new Error("OA public retrieve preflight requires a normalized service token");
  }
  const startedAt = clock();
  let response;
  try {
    response = await fetchImpl(OA_PUBLIC_RETRIEVE_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-originmind-public-lab-ai-service-token": publicToken,
      },
      body: JSON.stringify({ question: PREFLIGHT_QUESTION }),
      redirect: "manual",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const classification = error?.name === "TimeoutError" || error?.name === "AbortError"
      ? "timeout"
      : "network_error";
    return receipt(clock, startedAt, classification);
  }

  if (response.status !== 200) {
    try {
      await response.body?.cancel();
    } catch {
      // The status is authoritative; response content is intentionally ignored.
    }
    return receipt(clock, startedAt, httpClassification(response.status), response.status);
  }

  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    try {
      await response.body?.cancel();
    } catch {
      // The response is already classified without reading its content.
    }
    return receipt(clock, startedAt, "invalid_contract", response.status);
  }

  try {
    const chunks = parseOaResult(await boundedJson(response));
    return receipt(
      clock,
      startedAt,
      chunks.length > 0 ? "connected_with_public_knowledge" : "credential_accepted_empty",
      response.status,
      chunks.length,
    );
  } catch {
    return receipt(clock, startedAt, "invalid_contract", response.status);
  }
}

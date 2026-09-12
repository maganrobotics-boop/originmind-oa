import { pathToFileURL } from "node:url";

const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function exactOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) {
    throw new Error("Smoke origin must be an exact HTTPS origin");
  }
  return url.origin;
}

async function request(origin, pathname, init = {}) {
  return fetch(`${origin}${pathname}`, {
    ...init,
    headers: {
      Accept: "application/json, text/html;q=0.9",
      "Cache-Control": "no-cache",
      "User-Agent": "OriginMind-Chat-Release-Smoke/1.0",
      ...(init.headers || {}),
    },
    redirect: "error",
    signal: AbortSignal.timeout(45_000),
  });
}

async function json(response, label) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error(`${label} did not return JSON`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function apiHeaders(response, label) {
  if ((response.headers.get("x-content-type-options") || "").toLowerCase() !== "nosniff") {
    throw new Error(`${label} is missing X-Content-Type-Options: nosniff`);
  }
  if (!(response.headers.get("cache-control") || "").toLowerCase().includes("no-store")) {
    throw new Error(`${label} is missing Cache-Control: no-store`);
  }
}

function expectedRelease(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}-[1-9][0-9]{0,5}$/u.test(value)) {
    throw new Error("Smoke check requires the exact Chat release ID");
  }
  return value;
}

export function validateReleaseEvidence({ health, status, chat }, releaseIdValue) {
  const releaseId = expectedRelease(releaseIdValue);
  if (
    health?.app !== "arts-robotics-ai-assistant" ||
    health?.ready !== true ||
    health?.releaseId !== releaseId
  ) {
    throw new Error("/_health did not identify the expected ready ARTS Robotics AI assistant release");
  }
  if (
    status?.storageReady !== true ||
    status?.modelReady !== true ||
    !["workers-ai", "bailian"].includes(status?.provider)
  ) {
    throw new Error("/api/status is not storage/model ready");
  }
  if (
    chat?.mode !== "ai" ||
    chat?.oaPublicStatus !== "connected" ||
    chat?.releaseId !== releaseId ||
    typeof chat?.answer !== "string" ||
    !chat.answer.trim()
  ) {
    throw new Error("/api/chat did not return an OA-backed AI answer from the expected release");
  }
  if (
    !Array.isArray(chat.sources) ||
    chat.sources.length < 1 ||
    !chat.sources.every((source) => source?.origin === "oa_public")
  ) {
    throw new Error("/api/chat sources were not exclusively OA-approved public knowledge");
  }
  return {
    app: health.app,
    ready: health.ready,
    releaseId,
    oaPublicStatus: chat.oaPublicStatus,
    provider: chat.provider || status.provider,
    model: status.model,
    sources: chat.sources.length,
  };
}

async function smokeOnce(origin, releaseId) {
  for (const pathname of ["/", "/manage"]) {
    const response = await request(origin, pathname, { headers: { Accept: "text/html" } });
    if (response.status !== 200) throw Object.assign(new Error(`${pathname} returned ${response.status}`), { status: response.status });
    if (!(response.headers.get("content-type") || "").toLowerCase().includes("text/html")) {
      throw new Error(`${pathname} did not return HTML`);
    }
    const body = await response.text();
    if (body.length < 200) throw new Error(`${pathname} returned an incomplete page`);
    if ((response.headers.get("x-content-type-options") || "").toLowerCase() !== "nosniff") {
      throw new Error(`${pathname} is missing X-Content-Type-Options: nosniff`);
    }
  }

  const healthResponse = await request(origin, "/_health");
  if (healthResponse.status !== 200) {
    throw Object.assign(new Error(`/_health returned ${healthResponse.status}`), { status: healthResponse.status });
  }
  apiHeaders(healthResponse, "/_health");
  const health = await json(healthResponse, "/_health");

  const statusResponse = await request(origin, "/api/status");
  if (statusResponse.status !== 200) {
    throw Object.assign(new Error(`/api/status returned ${statusResponse.status}`), { status: statusResponse.status });
  }
  apiHeaders(statusResponse, "/api/status");
  const status = await json(statusResponse, "/api/status");

  const hostileResponse = await request(origin, "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://invalid.example" },
    body: JSON.stringify({ messages: [{ role: "user", content: "研究方向是什么？" }], topic: "research" }),
  });
  if (hostileResponse.status !== 403) throw new Error("/api/chat accepted a hostile Origin");

  const missingResponse = await request(origin, "/api/release-smoke-missing");
  if (missingResponse.status !== 404) throw new Error("Unknown API route did not return 404");

  const chatResponse = await request(origin, "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({
      messages: [{ role: "user", content: "请根据公开资料简要说明 ARTS Robotics 的机器人研究方向。" }],
      topic: "research",
    }),
  });
  if (chatResponse.status !== 200) {
    throw Object.assign(new Error(`/api/chat returned ${chatResponse.status}`), { status: chatResponse.status });
  }
  apiHeaders(chatResponse, "/api/chat");
  const chat = await json(chatResponse, "/api/chat");
  return validateReleaseEvidence({ health, status, chat }, releaseId);
}

export async function smokeCloudflare(originValue, { attempts = 12, releaseId } = {}) {
  const origin = exactOrigin(originValue);
  const expectedReleaseId = expectedRelease(releaseId);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await smokeOnce(origin, expectedReleaseId);
    } catch (error) {
      lastError = error;
      const transient = error?.status === undefined || TRANSIENT_STATUSES.has(error.status);
      if (!transient || attempt === attempts) break;
      await sleep(Math.min(10_000, attempt * 1_500));
    }
  }
  throw lastError || new Error("Cloudflare smoke check failed");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const origin = process.argv[2];
  smokeCloudflare(origin, { releaseId: process.env.CHAT_RELEASE_ID })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : "Cloudflare smoke check failed"}\n`);
      process.exitCode = 1;
    });
}

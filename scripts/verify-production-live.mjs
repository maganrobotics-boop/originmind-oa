import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { productionTarget } from "../lib/standalone-config.mjs";

const PRODUCTION_ORIGIN = productionTarget(process.env).publicOrigin;

function receiptArgument(values) {
  if (values.length !== 2 || values[0] !== "--receipt" || !values[1]) {
    throw new Error("Usage: verify-production-live.mjs --receipt <new-json-file>");
  }
  return resolve(values[1]);
}

async function request(path, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetch(new URL(path, PRODUCTION_ORIGIN), {
      redirect: "manual",
      cache: "no-store",
      credentials: "omit",
      ...init,
      headers: {
        accept: init.headers?.accept || "*/*",
        "cache-control": "no-cache",
        "user-agent": "OriginMind-OA-production-release-check/1.0",
        ...init.headers,
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function successfulText(path) {
  const response = await request(path, { headers: { accept: "text/html" } });
  if (response.status !== 200) throw new Error(`${path} returned HTTP ${response.status}`);
  if (response.headers.get("x-content-type-options") !== "nosniff") throw new Error(`${path} is missing the production security headers`);
  return { response, text: await response.text() };
}

function scriptUrls(html) {
  const urls = new Set();
  const pattern = /(?:src|href)=["']([^"']+\.js(?:\?[^"']*)?)["']/giu;
  for (const match of html.matchAll(pattern)) {
    const url = new URL(match[1], PRODUCTION_ORIGIN);
    if (url.origin === PRODUCTION_ORIGIN) urls.add(url.href);
  }
  return [...urls].slice(0, 64);
}

async function checkOnce() {
  const [
    { text: rootHtml },
    { text: guideHtml },
    sessionResponse,
    approvalsResponse,
    knowledgeResponse,
    publicRetrieveAnonymousResponse,
  ] = await Promise.all([
    successfulText("/"),
    successfulText("/guide"),
    request("/api/session", { headers: { accept: "application/json" } }),
    request("/api/approvals", { headers: { accept: "application/json" } }),
    request("/api/knowledge", { headers: { accept: "application/json" } }),
    request("/api/public/lab-ai/retrieve", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ question: "发布验证" }),
    }),
  ]);
  if (sessionResponse.status !== 200) throw new Error(`/api/session returned HTTP ${sessionResponse.status}`);
  const session = await sessionResponse.json();
  if (typeof session?.registered !== "boolean" || typeof session?.feishuLoginEnabled !== "boolean") {
    throw new Error("/api/session did not return the expected anonymous session contract");
  }
  if (approvalsResponse.status !== 401 || knowledgeResponse.status !== 401) {
    throw new Error("Protected OA APIs did not fail closed for an anonymous request");
  }
  if (publicRetrieveAnonymousResponse.status !== 401) {
    throw new Error(`/api/public/lab-ai/retrieve returned HTTP ${publicRetrieveAnonymousResponse.status} without its service credential`);
  }
  if (!publicRetrieveAnonymousResponse.headers.get("cache-control")?.includes("no-store")) {
    throw new Error("/api/public/lab-ai/retrieve anonymous rejection is cacheable");
  }
  if (
    publicRetrieveAnonymousResponse.headers.has("access-control-allow-origin")
    || publicRetrieveAnonymousResponse.headers.has("access-control-allow-credentials")
  ) {
    throw new Error("/api/public/lab-ai/retrieve unexpectedly enables browser CORS");
  }
  await publicRetrieveAnonymousResponse.arrayBuffer();

  let searchable = `${rootHtml}\n${guideHtml}`;
  const assets = scriptUrls(searchable);
  if (!assets.length) throw new Error("The production HTML did not reference any JavaScript assets");
  const assetResponses = await Promise.all(assets.map(async (url) => {
    const response = await request(url, { headers: { accept: "application/javascript,*/*" } });
    if (response.status !== 200) throw new Error(`${url} returned HTTP ${response.status}`);
    return response.text();
  }));
  searchable += `\n${assetResponses.join("\n")}`;
  if (
    !searchable.includes("实验室 AI（内部）")
    || !searchable.includes("chat.omindos.ai")
    || !searchable.includes("/api/lab-ai/ask")
  ) {
    throw new Error("The deployed client does not expose the reviewed internal/public laboratory AI split");
  }
  return {
    origin: PRODUCTION_ORIGIN,
    rootStatus: 200,
    guideStatus: 200,
    sessionStatus: 200,
    approvalsAnonymousStatus: 401,
    knowledgeAnonymousStatus: 401,
    publicRetrieveAnonymousStatus: 401,
    checkedAssets: assets.length,
    laboratoryAiEntryFound: true,
    publicAssistantReferenceFound: true,
  };
}

const receiptPath = receiptArgument(process.argv.slice(2));
let result;
let lastError;
for (let attempt = 1; attempt <= 4; attempt += 1) {
  try {
    result = await checkOnce();
    break;
  } catch (error) {
    lastError = error;
    if (attempt < 4) await new Promise((resolvePromise) => setTimeout(resolvePromise, 3_000));
  }
}
if (!result) throw lastError;
await writeFile(receiptPath, `${JSON.stringify({
  format: "originmind-oa-production-live-smoke-v1",
  checkedAt: new Date().toISOString(),
  ...result,
}, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
process.stdout.write("Verified public OA routes, fail-closed APIs, public retrieval authentication, security headers, and laboratory AI entry.\n");

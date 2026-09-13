import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

// A newly published Worker or route can briefly return 404/421 while edge state converges.
const TRANSIENT_STATUSES = new Set([404, 408, 421, 425, 500, 502, 503, 504]);

export function isTransientSmokeStatus(status) {
  return TRANSIENT_STATUSES.has(status);
}

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
  const { timeoutMilliseconds = 45_000, ...fetchOptions } = init;
  try {
    return await fetch(`${origin}${pathname}`, {
      ...fetchOptions,
      headers: {
        Accept: "application/json, text/html;q=0.9",
        "Cache-Control": "no-cache",
        "User-Agent": "OriginMind-Chat-Release-Smoke/1.0",
        ...(fetchOptions.headers || {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });
  } catch {
    throw Object.assign(new Error("Smoke request failed"), { retryable: true });
  }
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

export function frontendAssetPaths(html) {
  if (typeof html !== "string") throw new Error("Frontend shell is not text");
  const app = [
    ...html.matchAll(
      /<script\b[^>]*\bsrc=["']\/assets\/(app-([a-f0-9]{16})\.js)["'][^>]*>/giu,
    ),
  ];
  const style = [
    ...html.matchAll(
      /<link\b(?=[^>]*\brel=["']stylesheet["'])[^>]*\bhref=["']\/assets\/(styles-([a-f0-9]{16})\.css)["'][^>]*>/giu,
    ),
  ];
  if (app.length !== 1 || style.length !== 1) {
    throw new Error("Frontend shell does not reference one generated JavaScript and stylesheet asset");
  }
  return [
    { pathname: `/assets/${app[0][1]}`, hash: app[0][2], mediaType: "javascript" },
    { pathname: `/assets/${style[0][1]}`, hash: style[0][2], mediaType: "css" },
  ];
}

async function verifyFrontendAsset(origin, asset) {
  const response = await request(origin, asset.pathname, {
    headers: { Accept: asset.mediaType === "css" ? "text/css" : "application/javascript" },
  });
  if (response.status !== 200) {
    throw Object.assign(new Error(`${asset.pathname} returned ${response.status}`), { status: response.status });
  }
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (
    (asset.mediaType === "css" && !contentType.includes("text/css")) ||
    (asset.mediaType === "javascript" && !/(?:application|text)\/javascript/u.test(contentType))
  ) {
    throw new Error(`${asset.pathname} returned an invalid Content-Type`);
  }
  if ((response.headers.get("x-content-type-options") || "").toLowerCase() !== "nosniff") {
    throw new Error(`${asset.pathname} is missing X-Content-Type-Options: nosniff`);
  }
  const cacheControl = (response.headers.get("cache-control") || "").toLowerCase();
  if (!cacheControl.includes("max-age=31536000") || !cacheControl.includes("immutable")) {
    throw new Error(`${asset.pathname} is missing immutable caching`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 200) throw new Error(`${asset.pathname} is incomplete`);
  if (createHash("sha256").update(bytes).digest("hex").slice(0, 16) !== asset.hash) {
    throw new Error(`${asset.pathname} does not match its content hash`);
  }
}

function expectedRelease(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}-[1-9][0-9]{0,5}$/u.test(value)) {
    throw new Error("Smoke check requires the exact Chat release ID");
  }
  return value;
}

export function validateServiceEvidence({ health, status, chat }, releaseIdValue) {
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
    status?.documentParsingReady !== true ||
    !["workers-ai", "bailian"].includes(status?.provider)
  ) {
    throw new Error("/api/status is not storage/model/document-parser ready");
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

function validateAdminAuth(adminAuth) {
  if (adminAuth?.status !== 401 || adminAuth?.error !== "密码不正确") {
    throw new Error("/api/auth/login did not execute a compatible administrator password check");
  }
}

export function releaseSmokePdf() {
  const stream = "BT\n/F1 18 Tf\n72 720 Td\n(OriginMind document parser smoke 2026) Tj\nET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`,
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source, "ascii"));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(source, "ascii");
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(source, "ascii");
}

export function releaseSmokePng() {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAPAAAABAAQAAAAAM5MdKAAAAsUlEQVR42mP8z4AXNOCTZGTCr5lFHp/pvwjoHpUelR4a0iwMDCcOfCx5++VcyRZtA6mX9zB0fzH518DAwJAh9eD84rOYhh9i+Akxh4NBAbvdjY0PBBgYHjBiddqZvw0MDAwMzy4YyhZjOo1B58U/BgYGBhkTTx5BTN12HOwMDgc4/jAwyGH4k4mBgYfhNwMjA8MMhgOMsQ7ols//jwf8HE0to9Kj0gwsDxkpqEMZ8VfQADQ7RHGKtQ37AAAAAElFTkSuQmCC",
    "base64",
  );
}

export function validateReleaseEvidence({ health, status, chat, adminAuth }, releaseIdValue) {
  const evidence = validateServiceEvidence({ health, status, chat }, releaseIdValue);
  validateAdminAuth(adminAuth);
  return { ...evidence, adminKdfCompatible: true };
}

async function smokeOnce(origin, releaseId) {
  let frontendAssets;
  for (const pathname of ["/", "/technology", "/research", "/originmind", "/ius", "/manage"]) {
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
    const paths = frontendAssetPaths(body);
    if (frontendAssets && JSON.stringify(paths) !== JSON.stringify(frontendAssets)) {
      throw new Error("Public and manager shells reference different frontend assets");
    }
    frontendAssets = paths;
  }

  for (const asset of frontendAssets) await verifyFrontendAsset(origin, asset);

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
  if (hostileResponse.status !== 403) {
    throw Object.assign(new Error("/api/chat accepted a hostile Origin"), { status: hostileResponse.status });
  }

  const missingResponse = await request(origin, "/api/release-smoke-missing");
  if (missingResponse.status !== 404) {
    throw Object.assign(new Error("Unknown API route did not return 404"), { status: missingResponse.status });
  }

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

  return validateServiceEvidence({ health, status, chat }, releaseId);
}

async function verifyAdminPasswordRuntime(origin) {
  // Run this once, outside the release retry loop. A high-entropy wrong
  // password forces the production runtime to execute the stored KDF without
  // creating a session or exposing a secret. This catches platform-
  // incompatible records without exhausting the login rate limit.
  const diagnosticPassword = `release-smoke-${randomBytes(24).toString("base64url")}`;
  const authResponse = await request(origin, "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ password: diagnosticPassword }),
  });
  if (authResponse.status !== 401 && isTransientSmokeStatus(authResponse.status)) {
    throw Object.assign(new Error("Administrator KDF check returned a transient response"), {
      status: authResponse.status,
      retryable: true,
    });
  }
  apiHeaders(authResponse, "/api/auth/login");
  const authPayload = await json(authResponse, "/api/auth/login");
  const adminAuth = { status: authResponse.status, error: authPayload?.error };
  if (adminAuth.status !== 401 || adminAuth.error !== "密码不正确") {
    throw Object.assign(
      new Error("/api/auth/login did not complete the administrator password check"),
      { status: authResponse.status, retryable: isTransientSmokeStatus(authResponse.status) },
    );
  }
  validateAdminAuth(adminAuth);
}

async function runAdminProbe(origin, verifyAdmin, { attempts = 2, sleepImpl = sleep } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await verifyAdmin(origin);
      return;
    } catch (error) {
      lastError = error;
      const transient = error?.retryable === true || isTransientSmokeStatus(error?.status);
      if (!transient || attempt === attempts) break;
      await sleepImpl(attempt * 1_500);
    }
  }
  throw lastError || new Error("Administrator smoke check failed");
}

async function revokeSmokeSession(origin, token, { attempts = 3, sleepImpl = sleep } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await request(origin, "/api/auth/logout", {
        method: "POST",
        headers: { Origin: origin, Cookie: `__Host-ma-session=${token}` },
      });
      if (response.status !== 200 && isTransientSmokeStatus(response.status)) {
        throw Object.assign(new Error("Administrator logout returned a transient response"), {
          status: response.status,
          retryable: true,
        });
      }
      apiHeaders(response, "/api/auth/logout");
      const payload = await json(response, "/api/auth/logout");
      if (response.status !== 200 || payload?.saved !== true) {
        throw Object.assign(new Error("Administrator smoke session was not revoked"), {
          status: response.status,
          retryable: false,
        });
      }
      return;
    } catch (error) {
      lastError = error;
      const transient = error?.retryable === true || isTransientSmokeStatus(error?.status);
      if (!transient || attempt === attempts) break;
      await sleepImpl(attempt * 1_500);
    }
  }
  throw lastError || new Error("Administrator smoke session was not revoked");
}

async function verifySavedAdminPasswordRuntime(origin, password, { logoutAttempts = 3, sleepImpl = sleep } = {}) {
  const loginResponse = await request(origin, "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ password }),
  });
  const cookie = loginResponse.headers.get("set-cookie") || "";
  const tokenMatch = /^__Host-ma-session=([a-f0-9]{64})(?:;|$)/u.exec(cookie);
  const validCookie = /^__Host-ma-session=[a-f0-9]{64}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=[1-9][0-9]*$/u.test(cookie);
  try {
    if (loginResponse.status !== 200 && isTransientSmokeStatus(loginResponse.status)) {
      throw Object.assign(new Error("Administrator login returned a transient response"), {
        status: loginResponse.status,
        retryable: false,
      });
    }
    apiHeaders(loginResponse, "/api/auth/login");
    const login = await json(loginResponse, "/api/auth/login");
    if (loginResponse.status !== 200 || login?.signedIn !== true) {
      throw Object.assign(new Error("The saved administrator password was not accepted"), {
        status: loginResponse.status,
        retryable: false,
      });
    }
    if (!validCookie) throw new Error("Administrator login did not return the expected session cookie");
  } finally {
    if (tokenMatch) {
      await revokeSmokeSession(origin, tokenMatch[1], { attempts: logoutAttempts, sleepImpl });
    }
  }
}

async function verifyDocumentParsingRuntime(origin, password, { logoutAttempts = 3, sleepImpl = sleep } = {}) {
  const loginResponse = await request(origin, "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ password }),
  });
  const cookie = loginResponse.headers.get("set-cookie") || "";
  const tokenMatch = /^__Host-ma-session=([a-f0-9]{64})(?:;|$)/u.exec(cookie);
  const validCookie = /^__Host-ma-session=[a-f0-9]{64}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=[1-9][0-9]*$/u.test(cookie);
  try {
    apiHeaders(loginResponse, "/api/auth/login");
    const login = await json(loginResponse, "/api/auth/login");
    if (loginResponse.status !== 200 || login?.signedIn !== true || !validCookie || !tokenMatch) {
      throw Object.assign(new Error("The saved administrator password could not start the parser smoke session"), {
        status: loginResponse.status,
        retryable: isTransientSmokeStatus(loginResponse.status),
      });
    }

    const fixtures = [
      { name: "originmind-release-smoke.pdf", mimeType: "application/pdf", body: releaseSmokePdf() },
      { name: "originmind-release-smoke.png", mimeType: "image/png", body: releaseSmokePng() },
    ];
    for (const fixture of fixtures) {
      const parseResponse = await request(origin, `/api/admin/parse-file?name=${fixture.name}`, {
        method: "POST",
        timeoutMilliseconds: 120_000,
        headers: {
          "Content-Type": fixture.mimeType,
          Origin: origin,
          Cookie: `__Host-ma-session=${tokenMatch[1]}`,
        },
        body: fixture.body,
      });
      apiHeaders(parseResponse, "/api/admin/parse-file");
      const parsed = await json(parseResponse, "/api/admin/parse-file");
      if (
        parseResponse.status !== 200 ||
        typeof parsed?.markdown !== "string" ||
        parsed.markdown.trim().length < 10 ||
        parsed.mimeType !== fixture.mimeType ||
        parsed.sourceStored !== false ||
        parsed.characterCount !== parsed.markdown.length
      ) {
        throw Object.assign(new Error(`The live ${fixture.mimeType} parser did not return valid Markdown`), {
          status: parseResponse.status,
          retryable: isTransientSmokeStatus(parseResponse.status),
        });
      }
    }
  } finally {
    if (tokenMatch) {
      await revokeSmokeSession(origin, tokenMatch[1], { attempts: logoutAttempts, sleepImpl });
    }
  }
}

export async function smokeAdminAuthentication(originValue, {
  verifyAdmin = verifyAdminPasswordRuntime,
  attempts = 2,
  sleepImpl = sleep,
} = {}) {
  const origin = exactOrigin(originValue);
  await runAdminProbe(origin, verifyAdmin, { attempts, sleepImpl });
  return { adminKdfCompatible: true };
}

export async function smokeSavedAdminAuthentication(originValue, {
  environment = process.env,
  verifyAdmin = verifySavedAdminPasswordRuntime,
  logoutAttempts = 3,
  sleepImpl = sleep,
} = {}) {
  const origin = exactOrigin(originValue);
  const password = environment.CHAT_ADMIN_PASSWORD;
  delete environment.CHAT_ADMIN_PASSWORD;
  if (typeof password !== "string" || password.length < 12 || password.length > 256) {
    throw new Error("A valid saved administrator password is required");
  }
  await verifyAdmin(origin, password, { logoutAttempts, sleepImpl });
  return { adminPasswordVerified: true, smokeSessionRevoked: true };
}

export async function smokeDocumentParsing(originValue, password, {
  verifyParser = verifyDocumentParsingRuntime,
  logoutAttempts = 3,
  sleepImpl = sleep,
} = {}) {
  const origin = exactOrigin(originValue);
  if (typeof password !== "string" || password.length < 12 || password.length > 256) {
    throw new Error("A valid saved administrator password is required for parser smoke");
  }
  await verifyParser(origin, password, { logoutAttempts, sleepImpl });
  return { documentParsingVerified: true, smokeSessionRevoked: true };
}

export async function smokeCloudflare(originValue, {
  attempts = 12,
  releaseId,
  adminPassword = "",
  smokeAttempt = smokeOnce,
  verifyAdmin = verifyAdminPasswordRuntime,
  verifyParser = verifyDocumentParsingRuntime,
  sleepImpl = sleep,
} = {}) {
  const origin = exactOrigin(originValue);
  const expectedReleaseId = expectedRelease(releaseId);
  let lastError;
  let evidence;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      evidence = await smokeAttempt(origin, expectedReleaseId);
      break;
    } catch (error) {
      lastError = error;
      const transient = error?.retryable === true || isTransientSmokeStatus(error?.status);
      if (!transient || attempt === attempts) break;
      await sleepImpl(Math.min(10_000, attempt * 1_500));
    }
  }
  if (!evidence) throw lastError || new Error("Cloudflare smoke check failed");
  await runAdminProbe(origin, verifyAdmin, { sleepImpl });
  if (!adminPassword) return { ...evidence, adminKdfCompatible: true };
  await verifyParser(origin, adminPassword, { sleepImpl });
  return { ...evidence, adminKdfCompatible: true, documentParsingVerified: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const origin = process.argv[2];
  const operation = process.argv[3] === "--admin-auth-only"
    ? smokeAdminAuthentication(origin)
    : process.argv[3] === "--admin-saved-secret"
      ? smokeSavedAdminAuthentication(origin)
      : smokeCloudflare(origin, { releaseId: process.env.CHAT_RELEASE_ID });
  operation
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : "Cloudflare smoke check failed"}\n`);
      process.exitCode = 1;
    });
}

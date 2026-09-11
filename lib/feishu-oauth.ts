const FEISHU_AUTHORIZE_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
const FEISHU_QR_AUTHORIZE_URL = "https://passport.feishu.cn/suite/passport/oauth/authorize";
// Feishu's v3 token endpoint currently rejects valid PKCE exchanges for
// enterprise-built apps. The v2 endpoint accepts the same authorization
// request and remains the endpoint used by Feishu's official CLI.
const FEISHU_TOKEN_URL = "https://open.feishu.cn/open-apis/authen/v2/oauth/token";
const FEISHU_USER_INFO_URL = "https://open.feishu.cn/open-apis/authen/v1/user_info";
const FEISHU_QR_TOKEN_URL = "https://passport.feishu.cn/suite/passport/oauth/token";
const FEISHU_QR_USER_INFO_URL = "https://passport.feishu.cn/suite/passport/oauth/userinfo";
const FEISHU_QR_TRANSACTION_PREFIX = "qr_login:";

export const FEISHU_PROVIDER = "feishu";
export const FEISHU_OAUTH_TRANSACTION_MAX_AGE_SECONDS = 5 * 60;
export const FEISHU_OAUTH_BROWSER_COOKIE = "__Host-oa_feishu_oauth";

export type FeishuOAuthConfig = {
  clientId: string;
  clientSecret: string;
  tenantKey: string;
  origin: string;
  callbackUrl: string;
};

export type FeishuIdentity = {
  providerSubject: string;
  openId: string;
  tenantKey: string;
  displayName: string;
};

export type FeishuOAuthFlow = "modern" | "qr";

function cleanText(value: unknown, maximumLength: number) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, maximumLength);
}

function cleanIdentifier(value: unknown, maximumLength: number) {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, "").trim();
  return normalized.length <= maximumLength ? normalized : "";
}

function resolveFeishuOAuthConfig(): FeishuOAuthConfig | null {
  if (process.env.FEISHU_LOGIN_ENABLED?.trim().toLowerCase() !== "true") return null;
  const clientId = process.env.FEISHU_LOGIN_APP_ID?.trim() || "";
  const clientSecret = process.env.FEISHU_LOGIN_APP_SECRET?.trim() || "";
  const tenantKey = process.env.FEISHU_LOGIN_TENANT_KEY?.trim() || "";
  const configuredOrigin = process.env.OA_PUBLIC_ORIGIN?.trim() || "";
  if (!clientId || !clientSecret || !tenantKey || !configuredOrigin) return null;
  if (!/^[A-Za-z0-9_-]{4,128}$/u.test(clientId) || !/^[A-Za-z0-9_-]{4,128}$/u.test(tenantKey)) return null;
  try {
    const parsedOrigin = new URL(configuredOrigin);
    const localDevelopment = parsedOrigin.hostname === "localhost" || parsedOrigin.hostname === "127.0.0.1";
    if ((parsedOrigin.protocol !== "https:" && !(localDevelopment && parsedOrigin.protocol === "http:")) || parsedOrigin.pathname !== "/" || parsedOrigin.search || parsedOrigin.hash || parsedOrigin.username || parsedOrigin.password) return null;
    const origin = parsedOrigin.origin;
    return { clientId, clientSecret, tenantKey, origin, callbackUrl: `${origin}/api/auth/feishu/callback` };
  } catch {
    return null;
  }
}

export function isFeishuLoginEnabled() {
  return resolveFeishuOAuthConfig() !== null;
}

export function getFeishuOAuthConfig(): FeishuOAuthConfig {
  const config = resolveFeishuOAuthConfig();
  if (!config) throw new Error("Feishu login is not configured");
  return config;
}

export function feishuProviderSubject(clientId: unknown, tenantKey: unknown, openId: unknown) {
  const normalizedClientId = cleanIdentifier(clientId, 128);
  const normalizedTenant = cleanIdentifier(tenantKey, 128);
  const normalizedOpenId = cleanIdentifier(openId, 128);
  if (!/^[A-Za-z0-9_-]{4,128}$/u.test(normalizedClientId) || !/^[A-Za-z0-9_-]{4,128}$/u.test(normalizedTenant) || !/^ou[-_][A-Za-z0-9_-]{4,125}$/u.test(normalizedOpenId)) {
    throw new Error("Feishu returned an invalid account identifier");
  }
  return `${normalizedClientId}:${normalizedTenant}:${normalizedOpenId}`;
}

export function buildFeishuAuthorizeUrl(config: FeishuOAuthConfig, state: string, codeChallenge: string) {
  const url = new URL(FEISHU_AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", config.callbackUrl);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url;
}

export function buildFeishuQrAuthorizeUrl(config: FeishuOAuthConfig, state: string) {
  const url = new URL(FEISHU_QR_AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", config.callbackUrl);
  url.searchParams.set("state", state);
  return url;
}

export function feishuQrTransactionVerifier(nonce: string) {
  const normalizedNonce = cleanIdentifier(nonce, 128);
  if (!/^[A-Za-z0-9_-]{32,128}$/u.test(normalizedNonce)) throw new Error("Feishu QR transaction nonce is invalid");
  return `${FEISHU_QR_TRANSACTION_PREFIX}${normalizedNonce}`;
}

export function feishuOAuthFlowForTransactionVerifier(value: string): FeishuOAuthFlow {
  return /^qr_login:[A-Za-z0-9_-]{32,128}$/u.test(value) ? "qr" : "modern";
}

async function jsonResponse(response: Response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) throw new Error("Feishu returned an unexpected response");
  return response.json() as Promise<unknown>;
}

export async function exchangeFeishuCode(
  config: FeishuOAuthConfig,
  code: string,
  codeVerifier: string,
  flow: FeishuOAuthFlow = "modern",
): Promise<FeishuIdentity> {
  const tokenBody = flow === "qr"
    ? new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.callbackUrl,
      })
    : JSON.stringify({
        grant_type: "authorization_code",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.callbackUrl,
        code_verifier: codeVerifier,
      });
  const tokenResponse = await fetch(flow === "qr" ? FEISHU_QR_TOKEN_URL : FEISHU_TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": flow === "qr" ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8",
    },
    body: tokenBody,
    signal: AbortSignal.timeout(10_000),
  });
  const tokenPayload = await jsonResponse(tokenResponse) as Record<string, unknown>;
  const accessToken = cleanText(tokenPayload.access_token, 4_096);
  if (!tokenResponse.ok || !accessToken || (typeof tokenPayload.code === "number" && tokenPayload.code !== 0) || tokenPayload.error) {
    throw new Error("Feishu authorization code exchange failed");
  }

  const userResponse = await fetch(flow === "qr" ? FEISHU_QR_USER_INFO_URL : FEISHU_USER_INFO_URL, {
    headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  const userPayload = await jsonResponse(userResponse) as Record<string, unknown>;
  const data = flow === "qr"
    ? userPayload
    : userPayload.data && typeof userPayload.data === "object" && !Array.isArray(userPayload.data)
      ? userPayload.data as Record<string, unknown>
      : {};
  if (!userResponse.ok || (typeof userPayload.code === "number" && userPayload.code !== 0) || userPayload.error) {
    throw new Error("Feishu user information request failed");
  }

  const tenantKey = cleanIdentifier(data.tenant_key, 128);
  if (tenantKey !== config.tenantKey) throw new Error("Feishu account does not belong to the configured organization");
  const openId = cleanIdentifier(data.open_id, 128);
  const providerSubject = feishuProviderSubject(config.clientId, tenantKey, openId);
  const displayName = cleanText(data.name, 80) || "飞书成员";
  return {
    providerSubject,
    openId,
    tenantKey,
    displayName,
  };
}

const WECOM_AUTHORIZE_URL = "https://open.weixin.qq.com/connect/oauth2/authorize";
const WECOM_TOKEN_URL = "https://qyapi.weixin.qq.com/cgi-bin/gettoken";
const WECOM_USER_INFO_URL = "https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo";
const WECOM_MEMBER_URL = "https://qyapi.weixin.qq.com/cgi-bin/user/get";

export const WECOM_PROVIDER = "wecom";

export type WecomOAuthConfig = {
  corpId: string;
  agentId: string;
  corpSecret: string;
  origin: string;
  callbackUrl: string;
};

export type WecomIdentity = {
  providerSubject: string;
  corpId: string;
  userId: string;
  displayName: string;
};

function resolveWecomOAuthConfig(): WecomOAuthConfig | null {
  if (process.env.WECOM_LOGIN_ENABLED?.trim().toLowerCase() !== "true") return null;
  const corpId = process.env.WECOM_LOGIN_CORP_ID?.trim() || "";
  const agentId = process.env.WECOM_LOGIN_AGENT_ID?.trim() || "";
  // Use this application's Secret, never a wider-scope address-book sync Secret.
  const corpSecret = process.env.WECOM_LOGIN_APP_SECRET?.trim() || "";
  const configuredOrigin = process.env.OA_PUBLIC_ORIGIN?.trim() || "";
  if (!/^[A-Za-z0-9_-]{4,128}$/u.test(corpId) || !/^[1-9][0-9]{0,19}$/u.test(agentId) || !corpSecret || corpSecret.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(corpSecret)) return null;
  try {
    const parsedOrigin = new URL(configuredOrigin);
    const localDevelopment = parsedOrigin.hostname === "localhost" || parsedOrigin.hostname === "127.0.0.1";
    if ((parsedOrigin.protocol !== "https:" && !(localDevelopment && parsedOrigin.protocol === "http:")) || parsedOrigin.pathname !== "/" || parsedOrigin.search || parsedOrigin.hash || parsedOrigin.username || parsedOrigin.password) return null;
    const origin = parsedOrigin.origin;
    return { corpId, agentId, corpSecret, origin, callbackUrl: `${origin}/api/auth/qr/callback/wecom` };
  } catch {
    return null;
  }
}

export function isWecomLoginEnabled() {
  return resolveWecomOAuthConfig() !== null;
}

export function getWecomOAuthConfig(): WecomOAuthConfig {
  const config = resolveWecomOAuthConfig();
  if (!config) throw new Error("WeCom login is not configured");
  return config;
}

function normalizeUserId(value: unknown) {
  // UserID is case-insensitive and enterprise-scoped. A slash indicates an
  // interconnected/upstream/downstream enterprise member, not this enterprise.
  if (typeof value !== "string" || !/^[A-Za-z0-9_@.-]{1,64}$/u.test(value)) throw new Error("WeCom returned an invalid account identifier");
  return value.toLowerCase();
}

export function wecomProviderSubject(corpId: unknown, userId: unknown) {
  if (typeof corpId !== "string" || !/^[A-Za-z0-9_-]{4,128}$/u.test(corpId)) throw new Error("WeCom returned an invalid enterprise identifier");
  return `${corpId}:${normalizeUserId(userId)}`;
}

export function buildWecomAuthorizeUrl(config: WecomOAuthConfig, state: string) {
  // WeCom's enterprise OAuth does not offer PKCE. Routes must independently
  // bind and consume this state together with the mobile browser's nonce.
  if (!/^[A-Za-z0-9_-]{32,128}$/u.test(state)) throw new Error("WeCom OAuth state is invalid");
  const callback = new URL(config.callbackUrl);
  if (callback.origin !== config.origin || !callback.pathname.startsWith("/api/auth/") || callback.search || callback.hash || callback.username || callback.password) throw new Error("WeCom OAuth callback is invalid");
  const url = new URL(WECOM_AUTHORIZE_URL);
  url.searchParams.set("appid", config.corpId);
  url.searchParams.set("agentid", config.agentId);
  url.searchParams.set("redirect_uri", callback.href);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "snsapi_base");
  url.searchParams.set("state", state);
  url.hash = "wechat_redirect";
  return url;
}

async function requestWecomJson(url: URL, errorMessage: string) {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(errorMessage);
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(errorMessage);
    const payload = value as Record<string, unknown>;
    if (payload.errcode !== 0) throw new Error(errorMessage);
    return payload;
  } catch {
    // Fetch URLs contain application secrets or tokens. Do not propagate
    // upstream errors/URLs/errmsg into route logs or browser responses.
    throw new Error(errorMessage);
  }
}

export async function exchangeWecomCode(config: WecomOAuthConfig, code: string): Promise<WecomIdentity> {
  if (typeof code !== "string" || !code || new TextEncoder().encode(code).length > 512 || /[\u0000-\u0020\u007f]/u.test(code)) throw new Error("WeCom authorization code is invalid");
  const tokenUrl = new URL(WECOM_TOKEN_URL);
  tokenUrl.searchParams.set("corpid", config.corpId);
  tokenUrl.searchParams.set("corpsecret", config.corpSecret);
  const token = await requestWecomJson(tokenUrl, "WeCom application token request failed");
  const accessToken = token.access_token;
  if (typeof accessToken !== "string" || !accessToken || accessToken.length > 4_096 || /[\u0000-\u0020\u007f]/u.test(accessToken) || typeof token.expires_in !== "number" || !Number.isInteger(token.expires_in) || token.expires_in <= 0) throw new Error("WeCom application token request failed");

  const userInfoUrl = new URL(WECOM_USER_INFO_URL);
  userInfoUrl.searchParams.set("access_token", accessToken);
  userInfoUrl.searchParams.set("code", code);
  const userInfo = await requestWecomJson(userInfoUrl, "WeCom authorization code exchange failed");
  const userId = normalizeUserId(userInfo.userid);
  if (userInfo.external_userid) throw new Error("WeCom external members cannot sign in to this OA");

  // auth/getuserinfo can return an enterprise UserID outside the application's
  // visible range. user/get, with this same app's token, enforces that range.
  // https://developer.work.weixin.qq.com/document/path/90196
  // https://cloud.tencent.com/document/product/1301/88712
  const memberUrl = new URL(WECOM_MEMBER_URL);
  memberUrl.searchParams.set("access_token", accessToken);
  memberUrl.searchParams.set("userid", userId);
  const member = await requestWecomJson(memberUrl, "WeCom application member access denied");
  if (normalizeUserId(member.userid) !== userId || member.status !== 1) throw new Error("WeCom application member access denied");
  const displayName = typeof member.name === "string" ? member.name.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, 80) : "";
  return {
    providerSubject: wecomProviderSubject(config.corpId, userId),
    corpId: config.corpId,
    userId,
    displayName: displayName || "企业微信成员",
  };
}

import { normalizeAccountEmail } from "./account-subject";
import { OAUTH_SESSION_COOKIE, OAUTH_SESSION_IDLE_MAX_AGE_MS, OAUTH_SESSION_MAX_AGE_SECONDS } from "./oauth-session";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const USER_AGENT = "OriginMind-OA";

export const GITHUB_PROVIDER = "github";
export const GITHUB_OAUTH_TRANSACTION_MAX_AGE_SECONDS = 10 * 60;
export const GITHUB_SESSION_MAX_AGE_SECONDS = OAUTH_SESSION_MAX_AGE_SECONDS;
export const GITHUB_SESSION_IDLE_MAX_AGE_MS = OAUTH_SESSION_IDLE_MAX_AGE_MS;
export const GITHUB_SESSION_COOKIE = OAUTH_SESSION_COOKIE;
export const GITHUB_OAUTH_BROWSER_COOKIE = "__Host-oa_github_oauth";

export type GitHubOAuthConfig = {
  clientId: string;
  clientSecret: string;
  origin: string;
  callbackUrl: string;
};

export type GitHubIdentity = {
  providerSubject: string;
  login: string;
  verifiedEmail: string;
  displayName: string;
};

type GitHubUserPayload = {
  id?: unknown;
  login?: unknown;
  name?: unknown;
};

type GitHubEmailPayload = {
  email?: unknown;
  primary?: unknown;
  verified?: unknown;
};

function cleanText(value: unknown, maximumLength: number) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, maximumLength);
}

function isNoreplyEmail(email: string) {
  return /@(?:users\.)?noreply\.github\.com$/iu.test(email);
}

function resolveGitHubOAuthConfig(): GitHubOAuthConfig | null {
  if (process.env.GITHUB_LOGIN_ENABLED?.trim().toLowerCase() !== "true") return null;
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID?.trim() || "";
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET?.trim() || "";
  const configuredOrigin = process.env.OA_PUBLIC_ORIGIN?.trim() || "";
  if (!clientId || !clientSecret || !configuredOrigin) return null;
  try {
    const parsedOrigin = new URL(configuredOrigin);
    const localDevelopment = parsedOrigin.hostname === "localhost" || parsedOrigin.hostname === "127.0.0.1";
    if ((parsedOrigin.protocol !== "https:" && !(localDevelopment && parsedOrigin.protocol === "http:")) || parsedOrigin.pathname !== "/" || parsedOrigin.search || parsedOrigin.hash || parsedOrigin.username || parsedOrigin.password) return null;
    const origin = parsedOrigin.origin;
    return { clientId, clientSecret, origin, callbackUrl: `${origin}/api/auth/github/callback` };
  } catch {
    return null;
  }
}

export function isGitHubLoginEnabled() {
  return resolveGitHubOAuthConfig() !== null;
}

export function getGitHubOAuthConfig(): GitHubOAuthConfig {
  const config = resolveGitHubOAuthConfig();
  if (!config) throw new Error("GitHub login is not configured");
  return config;
}

export function normalizeReturnPath(value: unknown) {
  if (typeof value !== "string" || value.length > 2_048 || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)) return "/";
  try {
    const parsed = new URL(value, "https://oa.invalid");
    return parsed.origin === "https://oa.invalid" ? `${parsed.pathname}${parsed.search}${parsed.hash}` : "/";
  } catch {
    return "/";
  }
}

export function randomBase64Url(byteLength = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

export async function sha256Hex(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Base64Url(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

export function buildGitHubAuthorizeUrl(config: GitHubOAuthConfig, state: string, codeChallenge: string) {
  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.callbackUrl);
  url.searchParams.set("scope", "user:email");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url;
}

export function selectVerifiedGitHubEmail(rows: GitHubEmailPayload[]) {
  const candidates = rows.flatMap((row) => {
    if (row.verified !== true || typeof row.email !== "string") return [];
    try {
      const email = normalizeAccountEmail(row.email);
      return isNoreplyEmail(email) ? [] : [{ email, primary: row.primary === true }];
    } catch {
      return [];
    }
  });
  return candidates.find((candidate) => candidate.primary)?.email ?? candidates[0]?.email ?? null;
}

export function githubProviderSubject(id: unknown) {
  const normalized = typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? String(id) : typeof id === "string" ? id.trim() : "";
  if (!/^[1-9]\d{0,31}$/u.test(normalized)) throw new Error("GitHub returned an invalid account identifier");
  return normalized;
}

function githubApiHeaders(accessToken: string) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${accessToken}`,
    "user-agent": USER_AGENT,
    "x-github-api-version": GITHUB_API_VERSION,
  };
}

async function githubJson(response: Response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) throw new Error("GitHub returned an unexpected response");
  return response.json() as Promise<unknown>;
}

export async function exchangeGitHubCode(config: GitHubOAuthConfig, code: string, codeVerifier: string): Promise<GitHubIdentity> {
  const tokenResponse = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": USER_AGENT,
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.callbackUrl,
      code_verifier: codeVerifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const tokenPayload = await githubJson(tokenResponse) as { access_token?: unknown; error?: unknown };
  const accessToken = typeof tokenPayload.access_token === "string" ? tokenPayload.access_token.trim() : "";
  if (!tokenResponse.ok || !accessToken || tokenPayload.error) throw new Error("GitHub authorization code exchange failed");

  const headers = githubApiHeaders(accessToken);
  const [userResponse, emailResponse] = await Promise.all([
    fetch(`${GITHUB_API_URL}/user`, { headers, signal: AbortSignal.timeout(10_000) }),
    fetch(`${GITHUB_API_URL}/user/emails`, { headers, signal: AbortSignal.timeout(10_000) }),
  ]);
  const userPayload = await githubJson(userResponse) as GitHubUserPayload;
  const emailPayload = await githubJson(emailResponse);
  if (!userResponse.ok || !emailResponse.ok || !Array.isArray(emailPayload)) throw new Error("GitHub account details could not be verified");
  const providerSubject = githubProviderSubject(userPayload.id);
  const verifiedEmail = selectVerifiedGitHubEmail(emailPayload as GitHubEmailPayload[]);
  if (!verifiedEmail) throw new Error("GitHub account has no usable verified email");
  const login = cleanText(userPayload.login, 100);
  if (!login) throw new Error("GitHub returned an invalid login name");
  const displayName = cleanText(userPayload.name, 100) || login;
  return { providerSubject, login, verifiedEmail, displayName };
}

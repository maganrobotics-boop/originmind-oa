import { and, eq, isNull, lt } from "drizzle-orm";
import { cookies } from "next/headers";
import { getDb } from "../../../../../db";
import { authIdentities, members, oauthTransactions } from "../../../../../db/schema";
import {
  buildFeishuAuthorizeUrl,
  buildFeishuQrAuthorizeUrl,
  FEISHU_OAUTH_BROWSER_COOKIE,
  FEISHU_OAUTH_TRANSACTION_MAX_AGE_SECONDS,
  FEISHU_PROVIDER,
  feishuQrTransactionVerifier,
  getFeishuOAuthConfig,
} from "../../../../../lib/feishu-oauth";
import {
  normalizeReturnPath,
  randomBase64Url,
  sha256Base64Url,
  sha256Hex,
} from "../../../../../lib/github-oauth";
import { consumeWriteRateLimit } from "../../../../../lib/write-rate-limit";
import { getAuthorizedUser } from "../../../_lib/auth";

type OAuthAction = "login" | "link";
type OAuthPresentation = "redirect" | "qr";

function noStoreJson(body: object, status: number) {
  return Response.json(body, { status, headers: { "cache-control": "private, no-store, max-age=0" } });
}

function noStoreRedirect(location: string | URL, status: 303 | 307 = 303) {
  return new Response(null, {
    status,
    headers: {
      location: location.toString(),
      "cache-control": "private, no-store, max-age=0",
      "referrer-policy": "no-referrer",
    },
  });
}

function redirectWithStatus(origin: string, returnPath: string, status: string) {
  const destination = new URL(returnPath, origin);
  destination.searchParams.set("feishu", status);
  return noStoreRedirect(destination);
}

function sameOriginPost(request: Request, expectedOrigin: string) {
  const fetchSite = request.headers.get("sec-fetch-site");
  return request.headers.get("origin") === expectedOrigin
    && new URL(request.url).origin === expectedOrigin
    && (!fetchSite || fetchSite === "same-origin");
}

async function linkedMemberId() {
  const authorized = await getAuthorizedUser();
  if (
    !authorized?.memberId
    || !authorized.memberMutationRevision
    || !authorized.accountUserId
    || !authorized.ndaCompleted
    || !authorized.ndaAcceptedAt
    || !authorized.ndaApprovalId
    || !authorized.ndaAgreementVersion
  ) return null;
  const [member] = await (await getDb())
    .select({ id: members.id })
    .from(members)
    .where(and(
      eq(members.id, authorized.memberId),
      eq(members.status, "active"),
      eq(members.accountUserId, authorized.accountUserId),
      eq(members.mutationRevision, authorized.memberMutationRevision),
      eq(members.ndaAcceptedAt, authorized.ndaAcceptedAt),
      eq(members.ndaApprovalId, authorized.ndaApprovalId),
      eq(members.ndaAgreementVersion, authorized.ndaAgreementVersion),
    ))
    .limit(1);
  return member?.id ?? null;
}

async function beginFeishuOAuth(request: Request, action: OAuthAction, presentation: OAuthPresentation = "redirect") {
  let config;
  try {
    config = getFeishuOAuthConfig();
  } catch {
    return noStoreJson({ error: "飞书登录尚未启用。" }, 503);
  }

  const requestUrl = new URL(request.url);
  const returnPath = normalizeReturnPath(requestUrl.searchParams.get("return_to"));
  if (presentation === "qr" && (action !== "login" || !sameOriginPost(request, config.origin))) {
    return noStoreJson({ error: "二维码登录请求来源无效，请刷新 OA 登录页重试。" }, 403);
  }
  if (action === "login" && presentation === "redirect" && requestUrl.origin !== config.origin) {
    const canonicalStart = new URL("/api/auth/feishu/start", config.origin);
    if (returnPath !== "/") canonicalStart.searchParams.set("return_to", returnPath);
    return noStoreRedirect(canonicalStart, 307);
  }
  if (action === "link" && !sameOriginPost(request, config.origin)) {
    return noStoreJson({ error: "账号绑定请求来源无效，请从 OA 个人设置重新发起。" }, 403);
  }

  const memberId = action === "link" ? await linkedMemberId() : null;
  if (action === "link" && !memberId) return redirectWithStatus(config.origin, returnPath, "link-not-ready");
  if (memberId) {
    const [existing] = await (await getDb())
      .select({ id: authIdentities.id })
      .from(authIdentities)
      .where(and(eq(authIdentities.memberId, memberId), eq(authIdentities.provider, FEISHU_PROVIDER), isNull(authIdentities.unlinkedAt)))
      .limit(1);
    if (existing) return redirectWithStatus(config.origin, returnPath, "already-linked");
  }

  const state = randomBase64Url(32);
  const browserNonce = randomBase64Url(32);
  const codeVerifier = presentation === "qr"
    ? feishuQrTransactionVerifier(randomBase64Url(48))
    : randomBase64Url(64);
  const [stateHash, browserNonceHash, codeChallenge] = await Promise.all([
    sha256Hex(state),
    sha256Hex(browserNonce),
    presentation === "qr" ? Promise.resolve("") : sha256Base64Url(codeVerifier),
  ]);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + FEISHU_OAUTH_TRANSACTION_MAX_AGE_SECONDS * 1000).toISOString();
  const db = await getDb();
  const clientFingerprint = await sha256Hex(request.headers.get("cf-connecting-ip") || "unknown");
  if (!(await consumeWriteRateLimit(db, { actorSubject: clientFingerprint, scope: "feishu_oauth_start", limit: 12, now }))) {
    return action === "link"
      ? redirectWithStatus(config.origin, returnPath, "rate-limited")
      : noStoreJson({ error: "飞书登录请求过于频繁，请稍后再试。" }, 429);
  }
  try {
    await db.batch([
      db.delete(oauthTransactions).where(lt(oauthTransactions.expiresAt, now.toISOString())),
      db.insert(oauthTransactions).values({
        stateHash,
        provider: FEISHU_PROVIDER,
        browserNonceHash,
        pkceVerifier: codeVerifier,
        action,
        memberId,
        returnPath,
        createdAt: now.toISOString(),
        expiresAt,
      }),
    ]);
  } catch {
    return action === "link"
      ? redirectWithStatus(config.origin, returnPath, "failed")
      : noStoreJson({ error: "飞书登录暂时不可用，请稍后重试。" }, 503);
  }
  (await cookies()).set(FEISHU_OAUTH_BROWSER_COOKIE, browserNonce, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: FEISHU_OAUTH_TRANSACTION_MAX_AGE_SECONDS,
  });
  if (presentation === "qr") {
    return noStoreJson({
      authorizeUrl: buildFeishuQrAuthorizeUrl(config, state).toString(),
      expiresIn: FEISHU_OAUTH_TRANSACTION_MAX_AGE_SECONDS,
    }, 200);
  }
  return noStoreRedirect(buildFeishuAuthorizeUrl(config, state, codeChallenge));
}

export async function GET(request: Request) {
  return beginFeishuOAuth(request, "login");
}

export async function POST(request: Request) {
  if (new URL(request.url).searchParams.get("mode") === "qr") return beginFeishuOAuth(request, "login", "qr");
  return beginFeishuOAuth(request, "link");
}

import { and, eq, isNull, lt } from "drizzle-orm";
import { cookies } from "next/headers";
import { getDb } from "../../../../../db";
import { authIdentities, memberEvents, members, oauthTransactions } from "../../../../../db/schema";
import { normalizeAccountEmail } from "../../../../../lib/account-subject";
import {
  buildGitHubAuthorizeUrl,
  getGitHubOAuthConfig,
  GITHUB_OAUTH_BROWSER_COOKIE,
  GITHUB_OAUTH_TRANSACTION_MAX_AGE_SECONDS,
  GITHUB_PROVIDER,
  normalizeReturnPath,
  randomBase64Url,
  sha256Base64Url,
  sha256Hex,
} from "../../../../../lib/github-oauth";
import { PROJECT_OWNER_PLEDGE_VERSION } from "../../../../../lib/nda-agreement";
import { consumeWriteRateLimit } from "../../../../../lib/write-rate-limit";
import { getAuthorizedUser, getPlatformUser, type AuthorizedUser } from "../../../_lib/auth";

type OAuthAction = "login" | "link";

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
  destination.searchParams.set("github", status);
  return noStoreRedirect(destination);
}

function sameOriginPost(request: Request, expectedOrigin: string) {
  const origin = request.headers.get("origin");
  return origin === expectedOrigin && new URL(request.url).origin === expectedOrigin;
}

async function prepareLinkableMember(authorized: AuthorizedUser) {
  if (
    !authorized.accountUserId
    || !authorized.ndaCompleted
    || !authorized.ndaAcceptedAt
    || !authorized.ndaApprovalId
    || !authorized.ndaAgreementVersion
  ) return null;

  const db = await getDb();
  if (authorized.memberId && authorized.memberMutationRevision) {
    const [existing] = await db
      .select({ id: members.id, mutationRevision: members.mutationRevision })
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
    return existing ? { ...existing, materialization: undefined } : null;
  }
  if (
    !authorized.isAdmin
    || authorized.user.authProvider !== "chatgpt"
    || authorized.ndaAgreementVersion !== PROJECT_OWNER_PLEDGE_VERSION
  ) return null;

  const chatgptAccount = normalizeAccountEmail(authorized.user.email);
  const fullName = authorized.user.displayName.trim();
  if (fullName.length < 2 || fullName.length > 40 || /[\u0000-\u001f\u007f]/u.test(fullName)) return null;
  const memberId = crypto.randomUUID();
  const mutationRevision = crypto.randomUUID();
  const now = new Date().toISOString();
  return {
    id: memberId,
    mutationRevision,
    materialization: {
      member: {
        id: memberId,
        fullName,
        identityNumber: null,
        schoolEmail: "",
        chatgptAccount,
        accountUserId: authorized.accountUserId,
        role: "member",
        permissionsJson: "[]",
        departmentCode: "",
        status: "active",
        ndaAcceptedAt: authorized.ndaAcceptedAt,
        ndaApprovalId: authorized.ndaApprovalId,
        ndaAgreementVersion: authorized.ndaAgreementVersion,
        mutationRevision,
        createdAt: now,
        lastSeenAt: now,
      },
      event: {
        memberId,
        actorName: fullName,
        actorEmail: chatgptAccount,
        action: "configured_admin_member_materialized",
        note: "配置管理员在完成项目负责人保密承诺书后，通过本人 ChatGPT 认证会话建立规范成员记录以绑定外部登录；管理员权限仍由服务端配置授予。",
        createdAt: now,
      },
    },
  };
}

async function beginGitHubOAuth(request: Request, action: OAuthAction) {
  let config;
  try {
    config = getGitHubOAuthConfig();
  } catch {
    return noStoreJson({ error: "GitHub 登录尚未启用。" }, 503);
  }

  const requestUrl = new URL(request.url);
  const returnPath = normalizeReturnPath(requestUrl.searchParams.get("return_to"));
  if (action === "login" && requestUrl.origin !== config.origin) {
    return noStoreRedirect(`${config.origin}/api/auth/github/start`, 307);
  }
  if (action === "link" && !sameOriginPost(request, config.origin)) {
    return noStoreJson({ error: "账号绑定请求来源无效，请从 OA 个人设置重新发起。" }, 403);
  }

  let memberId: string | null = null;
  let linkableMember: Awaited<ReturnType<typeof prepareLinkableMember>> = null;
  if (action === "link") {
    const [platformUser, authorized] = await Promise.all([getPlatformUser(), getAuthorizedUser()]);
    if (!platformUser || !authorized || !authorized.ndaCompleted || authorized.accountUserId !== platformUser.accountUserId) {
      return redirectWithStatus(config.origin, returnPath, "link-not-ready");
    }
    linkableMember = await prepareLinkableMember(authorized);
    if (!linkableMember) return redirectWithStatus(config.origin, returnPath, "link-not-ready");
    memberId = linkableMember.id;
    if (!linkableMember.materialization) {
      const [existing] = await (await getDb())
        .select({ id: authIdentities.id })
        .from(authIdentities)
        .where(and(eq(authIdentities.memberId, memberId), eq(authIdentities.provider, GITHUB_PROVIDER), isNull(authIdentities.unlinkedAt)))
        .limit(1);
      if (existing) return redirectWithStatus(config.origin, returnPath, "already-linked");
    }
  }

  const state = randomBase64Url(32);
  const browserNonce = randomBase64Url(32);
  const codeVerifier = randomBase64Url(64);
  const [stateHash, browserNonceHash, codeChallenge] = await Promise.all([
    sha256Hex(state),
    sha256Hex(browserNonce),
    sha256Base64Url(codeVerifier),
  ]);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + GITHUB_OAUTH_TRANSACTION_MAX_AGE_SECONDS * 1000).toISOString();
  const db = await getDb();
  const clientFingerprint = await sha256Hex(request.headers.get("cf-connecting-ip") || "unknown");
  if (!(await consumeWriteRateLimit(db, { actorSubject: clientFingerprint, scope: "github_oauth_start", limit: 12, now }))) {
    return action === "link"
      ? redirectWithStatus(config.origin, returnPath, "rate-limited")
      : Response.json({ error: "GitHub 登录请求过于频繁，请稍后再试。" }, { status: 429, headers: { "cache-control": "private, no-store, max-age=0", "retry-after": "60" } });
  }
  const transaction = {
    stateHash,
    provider: GITHUB_PROVIDER,
    browserNonceHash,
    pkceVerifier: codeVerifier,
    action,
    memberId,
    returnPath,
    createdAt: now.toISOString(),
    expiresAt,
  };
  if (action === "link" && linkableMember?.materialization) {
    try {
      await db.batch([
        db.insert(members).values(linkableMember.materialization.member),
        db.insert(memberEvents).values(linkableMember.materialization.event),
        db.delete(oauthTransactions).where(lt(oauthTransactions.expiresAt, now.toISOString())),
        db.insert(oauthTransactions).values(transaction),
      ]);
    } catch {
      // A concurrent request may have materialized this exact administrator.
      const authorized = await getAuthorizedUser();
      if (
        !authorized?.isAdmin
        || !authorized.accountUserId
        || !authorized.ndaAcceptedAt
        || !authorized.ndaApprovalId
        || !authorized.ndaAgreementVersion
      ) return redirectWithStatus(config.origin, returnPath, "link-not-ready");
      const chatgptAccount = normalizeAccountEmail(authorized.user.email);
      const [concurrentMember] = await db
        .select({
          id: members.id,
          mutationRevision: members.mutationRevision,
          ndaAcceptedAt: members.ndaAcceptedAt,
          ndaApprovalId: members.ndaApprovalId,
          ndaAgreementVersion: members.ndaAgreementVersion,
        })
        .from(members)
        .where(and(
          eq(members.chatgptAccount, chatgptAccount),
          eq(members.accountUserId, authorized.accountUserId),
          eq(members.status, "active"),
        ))
        .limit(1);
      if (
        !concurrentMember
        || concurrentMember.ndaAcceptedAt !== authorized.ndaAcceptedAt
        || concurrentMember.ndaApprovalId !== authorized.ndaApprovalId
        || concurrentMember.ndaAgreementVersion !== authorized.ndaAgreementVersion
      ) return redirectWithStatus(config.origin, returnPath, "link-not-ready");
      const [existingIdentity] = await db
        .select({ id: authIdentities.id })
        .from(authIdentities)
        .where(and(eq(authIdentities.memberId, concurrentMember.id), eq(authIdentities.provider, GITHUB_PROVIDER), isNull(authIdentities.unlinkedAt)))
        .limit(1);
      if (existingIdentity) return redirectWithStatus(config.origin, returnPath, "already-linked");
      transaction.memberId = concurrentMember.id;
      try {
        await db.batch([
          db.delete(oauthTransactions).where(lt(oauthTransactions.expiresAt, now.toISOString())),
          db.insert(oauthTransactions).values(transaction),
        ]);
      } catch {
        return redirectWithStatus(config.origin, returnPath, "failed");
      }
    }
  } else {
    try {
      await db.batch([
        db.delete(oauthTransactions).where(lt(oauthTransactions.expiresAt, now.toISOString())),
        db.insert(oauthTransactions).values(transaction),
      ]);
    } catch {
      if (action === "link") return redirectWithStatus(config.origin, returnPath, "failed");
      throw new Error("GitHub OAuth transaction could not be created");
    }
  }
  (await cookies()).set(GITHUB_OAUTH_BROWSER_COOKIE, browserNonce, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: GITHUB_OAUTH_TRANSACTION_MAX_AGE_SECONDS,
  });
  return noStoreRedirect(buildGitHubAuthorizeUrl(config, state, codeChallenge));
}

export async function GET(request: Request) {
  return beginGitHubOAuth(request, "login");
}

export async function POST(request: Request) {
  return beginGitHubOAuth(request, "link");
}

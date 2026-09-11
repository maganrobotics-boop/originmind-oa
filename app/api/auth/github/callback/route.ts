import { and, eq, exists, gt, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { getDb } from "../../../../../db";
import { authIdentities, memberEvents, members, oauthSessions, oauthTransactions } from "../../../../../db/schema";
import {
  exchangeGitHubCode,
  getGitHubOAuthConfig,
  GITHUB_OAUTH_BROWSER_COOKIE,
  GITHUB_PROVIDER,
  GITHUB_SESSION_COOKIE,
  GITHUB_SESSION_MAX_AGE_SECONDS,
  sha256Hex,
} from "../../../../../lib/github-oauth";
import { getAuthorizedUser, getPlatformUser, hashToken } from "../../../_lib/auth";

function redirectWithStatus(origin: string, returnPath: string, status: string) {
  const destination = new URL(returnPath, origin);
  destination.searchParams.set("github", status);
  return new Response(null, {
    status: 303,
    headers: {
      location: destination.toString(),
      "cache-control": "private, no-store, max-age=0",
      "referrer-policy": "no-referrer",
    },
  });
}

function clearOAuthBrowserCookie(cookieStore: Awaited<ReturnType<typeof cookies>>) {
  cookieStore.set(GITHUB_OAUTH_BROWSER_COOKIE, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export async function GET(request: Request) {
  let config;
  try {
    config = getGitHubOAuthConfig();
  } catch {
    return Response.json({ error: "GitHub 登录尚未启用。" }, { status: 503, headers: { "cache-control": "private, no-store, max-age=0" } });
  }
  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== config.origin) return Response.json({ error: "GitHub 回调域名不正确。" }, { status: 400, headers: { "cache-control": "private, no-store, max-age=0" } });

  const cookieStore = await cookies();
  const browserNonce = cookieStore.get(GITHUB_OAUTH_BROWSER_COOKIE)?.value || "";
  clearOAuthBrowserCookie(cookieStore);
  const oauthError = requestUrl.searchParams.get("error");
  const code = requestUrl.searchParams.get("code") || "";
  const state = requestUrl.searchParams.get("state") || "";
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(browserNonce) || !/^[A-Za-z0-9_-]{32,256}$/u.test(state) || (!oauthError && (!code || code.length > 1024))) return redirectWithStatus(config.origin, "/", "failed");

  const now = new Date().toISOString();
  const [stateHash, browserNonceHash] = await Promise.all([sha256Hex(state), sha256Hex(browserNonce)]);
  const db = await getDb();
  const transactionRows = await db
    .update(oauthTransactions)
    .set({ consumedAt: now })
    .where(and(
      eq(oauthTransactions.stateHash, stateHash),
      eq(oauthTransactions.provider, GITHUB_PROVIDER),
      eq(oauthTransactions.browserNonceHash, browserNonceHash),
      isNull(oauthTransactions.consumedAt),
      gt(oauthTransactions.expiresAt, now),
    ))
    .returning({
      action: oauthTransactions.action,
      memberId: oauthTransactions.memberId,
      returnPath: oauthTransactions.returnPath,
      pkceVerifier: oauthTransactions.pkceVerifier,
    });
  const transaction = transactionRows[0];
  if (!transaction || (transaction.action !== "login" && transaction.action !== "link")) return redirectWithStatus(config.origin, "/", "failed");
  if (oauthError) return redirectWithStatus(config.origin, transaction.returnPath, "denied");

  let githubIdentity;
  try {
    githubIdentity = await exchangeGitHubCode(config, code, transaction.pkceVerifier);
  } catch (error) {
    const status = error instanceof Error && /verified email/i.test(error.message) ? "no-email" : "failed";
    return redirectWithStatus(config.origin, transaction.returnPath, status);
  }

  if (transaction.action === "link") {
    const [platformUser, authorized] = await Promise.all([getPlatformUser(), getAuthorizedUser()]);
    if (!platformUser?.accountUserId || !authorized?.memberId || !authorized.memberMutationRevision || !authorized.accountUserId || !authorized.ndaCompleted || !authorized.ndaAcceptedAt || !authorized.ndaApprovalId || !authorized.ndaAgreementVersion || authorized.memberId !== transaction.memberId || authorized.accountUserId !== platformUser.accountUserId) {
      return redirectWithStatus(config.origin, transaction.returnPath, "link-session-expired");
    }
    const accountUserId = authorized.accountUserId;
    const linkedMemberGuard = and(
      eq(members.id, authorized.memberId),
      eq(members.status, "active"),
      eq(members.accountUserId, accountUserId),
      eq(members.mutationRevision, authorized.memberMutationRevision),
      eq(members.ndaAcceptedAt, authorized.ndaAcceptedAt),
      eq(members.ndaApprovalId, authorized.ndaApprovalId),
      eq(members.ndaAgreementVersion, authorized.ndaAgreementVersion),
    );
    const activeMemberExists = exists(db.select({ id: members.id }).from(members).where(linkedMemberGuard));
    const [[subjectIdentity], [memberIdentity]] = await Promise.all([
      db.select({ id: authIdentities.id, memberId: authIdentities.memberId, unlinkedAt: authIdentities.unlinkedAt })
        .from(authIdentities)
        .where(and(eq(authIdentities.provider, GITHUB_PROVIDER), eq(authIdentities.providerSubject, githubIdentity.providerSubject)))
        .limit(1),
      db.select({ providerSubject: authIdentities.providerSubject })
        .from(authIdentities)
        .where(and(eq(authIdentities.memberId, authorized.memberId), eq(authIdentities.provider, GITHUB_PROVIDER), isNull(authIdentities.unlinkedAt)))
        .limit(1),
    ]);
    if ((subjectIdentity && subjectIdentity.memberId !== authorized.memberId) || (memberIdentity && memberIdentity.providerSubject !== githubIdentity.providerSubject)) {
      return redirectWithStatus(config.origin, transaction.returnPath, "identity-conflict");
    }
    if (!subjectIdentity) {
      try {
        const auditNote = `成员本人通过现有认证会话显式绑定 GitHub 登录身份；GitHub 用户名 ${githubIdentity.login}，已验证邮箱 ${githubIdentity.verifiedEmail}。未保存 GitHub 访问令牌。`;
        const [identityRows, eventRows] = await db.batch([
          db.insert(authIdentities).select(db.select({
            id: sql<string>`${crypto.randomUUID()}`.as("id"),
            memberId: members.id,
            provider: sql<string>`${GITHUB_PROVIDER}`.as("provider"),
            providerSubject: sql<string>`${githubIdentity.providerSubject}`.as("provider_subject"),
            loginSnapshot: sql<string>`${githubIdentity.login}`.as("login_snapshot"),
            verifiedEmailSnapshot: sql<string>`${githubIdentity.verifiedEmail}`.as("verified_email_snapshot"),
            linkedAt: sql<string>`${now}`.as("linked_at"),
            lastSeenAt: sql<string>`${now}`.as("last_seen_at"),
            unlinkedAt: sql<string | null>`NULL`.as("unlinked_at"),
          }).from(members).where(linkedMemberGuard)).returning({ id: authIdentities.id }),
          db.insert(memberEvents).select(db.select({
            id: sql<number>`NULL`.as("id"),
            memberId: members.id,
            actorName: sql<string>`${authorized.user.displayName}`.as("actor_name"),
            actorEmail: sql<string>`${authorized.user.email}`.as("actor_email"),
            action: sql<string>`'github_identity_linked'`.as("action"),
            note: sql<string>`${auditNote}`.as("note"),
            createdAt: sql<string>`${now}`.as("created_at"),
          }).from(members).where(linkedMemberGuard)).returning({ id: memberEvents.id }),
        ]);
        if (!identityRows[0] || !eventRows[0]) return redirectWithStatus(config.origin, transaction.returnPath, "link-session-expired");
      } catch {
        return redirectWithStatus(config.origin, transaction.returnPath, "identity-conflict");
      }
    } else if (subjectIdentity.unlinkedAt) {
      const relinkNote = `成员本人通过现有认证会话重新绑定原 GitHub 登录身份；GitHub 用户名 ${githubIdentity.login}，已验证邮箱 ${githubIdentity.verifiedEmail}。未保存 GitHub 访问令牌。`;
      const reactivatedIdentityExists = exists(db.select({ id: authIdentities.id }).from(authIdentities).where(and(
        eq(authIdentities.id, subjectIdentity.id),
        eq(authIdentities.linkedAt, now),
        isNull(authIdentities.unlinkedAt),
      )));
      const [identityRows, eventRows] = await db.batch([
        db.update(authIdentities).set({ unlinkedAt: null, loginSnapshot: githubIdentity.login, verifiedEmailSnapshot: githubIdentity.verifiedEmail, linkedAt: now, lastSeenAt: now }).where(and(
          eq(authIdentities.id, subjectIdentity.id),
          eq(authIdentities.memberId, authorized.memberId),
          eq(authIdentities.unlinkedAt, subjectIdentity.unlinkedAt),
          activeMemberExists,
        )).returning({ id: authIdentities.id }),
        db.insert(memberEvents).select(db.select({
          id: sql<number>`NULL`.as("id"),
          memberId: members.id,
          actorName: sql<string>`${authorized.user.displayName}`.as("actor_name"),
          actorEmail: sql<string>`${authorized.user.email}`.as("actor_email"),
          action: sql<string>`'github_identity_relinked'`.as("action"),
          note: sql<string>`${relinkNote}`.as("note"),
          createdAt: sql<string>`${now}`.as("created_at"),
        }).from(members).where(and(linkedMemberGuard, reactivatedIdentityExists))).returning({ id: memberEvents.id }),
      ]);
      if (!identityRows[0] || !eventRows[0]) return redirectWithStatus(config.origin, transaction.returnPath, "link-session-expired");
    } else {
      const [activeMember] = await db.select({ id: members.id }).from(members).where(linkedMemberGuard).limit(1);
      if (!activeMember) return redirectWithStatus(config.origin, transaction.returnPath, "link-session-expired");
    }
    return redirectWithStatus(config.origin, transaction.returnPath, subjectIdentity && !subjectIdentity.unlinkedAt ? "already-linked" : "linked");
  }

  const [identity] = await db
    .select({ id: authIdentities.id, memberId: authIdentities.memberId, unlinkedAt: authIdentities.unlinkedAt })
    .from(authIdentities)
    .where(and(eq(authIdentities.provider, GITHUB_PROVIDER), eq(authIdentities.providerSubject, githubIdentity.providerSubject)))
    .limit(1);
  if (identity?.unlinkedAt) return redirectWithStatus(config.origin, transaction.returnPath, "identity-conflict");

  const memberId = identity?.memberId ?? null;
  if (memberId) {
    const [member] = await db.select({ id: members.id }).from(members).where(eq(members.id, memberId)).limit(1);
    if (!member) return redirectWithStatus(config.origin, transaction.returnPath, "identity-conflict");
    await db.update(authIdentities).set({ loginSnapshot: githubIdentity.login, verifiedEmailSnapshot: githubIdentity.verifiedEmail, lastSeenAt: now }).where(eq(authIdentities.id, identity!.id));
  }

  const sessionToken = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const sessionExpiresAt = new Date(Date.now() + GITHUB_SESSION_MAX_AGE_SECONDS * 1000).toISOString();
  const staleRevokedCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await db.batch([
    db.delete(oauthSessions).where(or(
      lt(oauthSessions.expiresAt, now),
      and(isNotNull(oauthSessions.revokedAt), lt(oauthSessions.revokedAt, staleRevokedCutoff)),
    )),
    db.update(oauthSessions).set({ revokedAt: now }).where(and(
      eq(oauthSessions.provider, GITHUB_PROVIDER),
      eq(oauthSessions.providerSubject, githubIdentity.providerSubject),
      isNull(oauthSessions.revokedAt),
    )),
    db.insert(oauthSessions).values({
      tokenHash: await hashToken(sessionToken),
      provider: GITHUB_PROVIDER,
      providerSubject: githubIdentity.providerSubject,
      memberId,
      loginSnapshot: githubIdentity.login,
      emailSnapshot: githubIdentity.verifiedEmail,
      displayNameSnapshot: githubIdentity.displayName,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: sessionExpiresAt,
    }),
  ]);
  cookieStore.set(GITHUB_SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: GITHUB_SESSION_MAX_AGE_SECONDS,
  });
  return redirectWithStatus(config.origin, transaction.returnPath, memberId ? "signed-in" : "register");
}

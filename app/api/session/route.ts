import { eq, inArray } from "drizzle-orm";
import { cookies } from "next/headers";
import { getDb } from "../../../db";
import { memberSessions, members, oauthSessions } from "../../../db/schema";
import { isChatGPTLoginEnabled } from "../../../lib/auth-capabilities";
import { isFeishuLoginEnabled } from "../../../lib/feishu-oauth";
import { isGitHubLoginEnabled } from "../../../lib/github-oauth";
import { LEGACY_GITHUB_SESSION_COOKIE, OAUTH_SESSION_COOKIE } from "../../../lib/oauth-session";
import { isMigrationExportWindowOpen } from "../../../lib/migration-export.mjs";
import { isMigrationUnfreezeEnabled } from "../../../lib/migration-freeze";
import { getAuthorizedUser, getCurrentUser, hashToken } from "../_lib/auth";

function sessionJson(body: object, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "private, no-store, max-age=0");
  return Response.json(body, { ...init, headers });
}

export async function GET() {
  const chatgptLoginEnabled = isChatGPTLoginEnabled();
  const githubLoginEnabled = isGitHubLoginEnabled();
  const feishuLoginEnabled = isFeishuLoginEnabled();
  const loginCapabilities = { chatgptLoginEnabled, githubLoginEnabled, feishuLoginEnabled };
  const authorized = await getAuthorizedUser();
  if (authorized) return sessionJson({
    registered: true,
    status: "active",
    user: authorized.user,
    role: authorized.role,
    canReviewMembers: authorized.canReviewMembers,
    canReviewKnowledge: authorized.canReviewKnowledge,
    canGrantMemberPermissions: authorized.canGrantMemberPermissions,
    isAdmin: authorized.isAdmin,
    isFinanceOwner: authorized.isFinanceOwner,
    ndaCompleted: authorized.ndaCompleted,
    needsNda: !authorized.ndaCompleted,
    ndaApprovalId: authorized.ndaApprovalId,
    migrationExportEnabled: authorized.isAdmin && isMigrationExportWindowOpen(),
    migrationUnfreezeEnabled: authorized.isAdmin && isMigrationUnfreezeEnabled(process.env),
    ...loginCapabilities,
  });
  const user = await getCurrentUser();
  const identity = user;
  if (!identity) return sessionJson({ registered: false, status: "unregistered", user: null, role: null, canReviewMembers: false, canReviewKnowledge: false, canGrantMemberPermissions: false, isAdmin: false, isFinanceOwner: false, ndaCompleted: false, needsNda: false, migrationExportEnabled: false, migrationUnfreezeEnabled: false, ...loginCapabilities });
  const publicIdentity = { email: identity.email, displayName: identity.displayName, authProvider: identity.authProvider };
  const [member] = await (await getDb()).select({ fullName: members.fullName, chatgptAccount: members.chatgptAccount, accountUserId: members.accountUserId, accountBindingPreviousStatus: members.accountBindingPreviousStatus, status: members.status, role: members.role }).from(members).where(eq(members.chatgptAccount, identity.email.toLowerCase())).limit(1);
  if (!member) return sessionJson({ registered: false, status: "unregistered", user: publicIdentity, role: null, canReviewMembers: false, canReviewKnowledge: false, canGrantMemberPermissions: false, isAdmin: false, isFinanceOwner: false, ndaCompleted: false, needsNda: false, migrationExportEnabled: false, migrationUnfreezeEnabled: false, ...loginCapabilities });
  const isOAuthIdentity = identity.authProvider === "github" || identity.authProvider === "feishu";
  const identityMatches = Boolean(identity.accountUserId && member.accountUserId === identity.accountUserId && (!isOAuthIdentity || identity.memberId));
  const externalIdentityLinkRequired = isOAuthIdentity && !identity.memberId;
  const githubIdentityLinkRequired = identity.authProvider === "github" && externalIdentityLinkRequired;
  const feishuIdentityLinkRequired = identity.authProvider === "feishu" && externalIdentityLinkRequired;
  const conflictingBoundIdentity = Boolean(member.accountUserId && identity.accountUserId && !identityMatches);
  if (externalIdentityLinkRequired || conflictingBoundIdentity || (member.status === "active" && !identityMatches)) return sessionJson({ registered: false, status: "unregistered", accountBindingRequired: true, accountBindingConflict: conflictingBoundIdentity, platformIdentityMissing: identity.authProvider === "legacy", externalIdentityLinkRequired, externalIdentityProvider: isOAuthIdentity ? identity.authProvider : undefined, githubIdentityLinkRequired, feishuIdentityLinkRequired, user: publicIdentity, role: null, canReviewMembers: false, canReviewKnowledge: false, canGrantMemberPermissions: false, isAdmin: false, isFinanceOwner: false, ndaCompleted: false, needsNda: false, migrationExportEnabled: false, migrationUnfreezeEnabled: false, ...loginCapabilities });
  const verifiedIdentity = identityMatches && !member.accountBindingPreviousStatus ? { email: member.chatgptAccount, displayName: member.fullName, authProvider: identity.authProvider } : publicIdentity;
  return sessionJson({ registered: member.status === "active" && identityMatches, status: member.status, user: verifiedIdentity, role: identityMatches ? member.role : null, canReviewMembers: false, canReviewKnowledge: false, canGrantMemberPermissions: false, isAdmin: false, isFinanceOwner: false, ndaCompleted: false, needsNda: member.status === "active" && identityMatches, migrationExportEnabled: false, migrationUnfreezeEnabled: false, ...loginCapabilities });
}

export async function DELETE() {
  const cookieStore = await cookies();
  const token = cookieStore.get("oa_session")?.value;
  const oauthTokens = Array.from(new Set([cookieStore.get(OAUTH_SESSION_COOKIE)?.value, cookieStore.get(LEGACY_GITHUB_SESSION_COOKIE)?.value].filter((value): value is string => Boolean(value))));
  let deletionFailed = false;
  try {
    if (token) await (await getDb()).delete(memberSessions).where(eq(memberSessions.tokenHash, await hashToken(token)));
    if (oauthTokens.length) {
      const tokenHashes = await Promise.all(oauthTokens.map((value) => hashToken(value)));
      await (await getDb()).delete(oauthSessions).where(inArray(oauthSessions.tokenHash, tokenHashes));
    }
  } catch {
    deletionFailed = true;
  }
  cookieStore.set("oa_session", "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
  cookieStore.set(OAUTH_SESSION_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
  cookieStore.set(LEGACY_GITHUB_SESSION_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
  return sessionJson({ ok: true, ...(deletionFailed ? { serverRevocationPending: true } : {}) });
}

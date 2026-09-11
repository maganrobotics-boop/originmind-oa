import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { getDb } from "../../../db";
import { accountProfiles, approvals, authIdentities, memberSessions, members, oauthSessions } from "../../../db/schema";
import { accountSubjectForEmail, normalizeAccountEmail } from "../../../lib/account-subject";
import { FEISHU_PROVIDER, isFeishuLoginEnabled } from "../../../lib/feishu-oauth";
import { GITHUB_PROVIDER, isGitHubLoginEnabled } from "../../../lib/github-oauth";
import { canReviewMemberRegistrations } from "../../../lib/member-attributes";
import { LEGACY_GITHUB_SESSION_COOKIE, OAUTH_SESSION_COOKIE, OAUTH_SESSION_IDLE_MAX_AGE_MS, OAUTH_SESSION_MAX_AGE_SECONDS, type OAuthProvider } from "../../../lib/oauth-session";
import { isMigrationWriteFrozen } from "../../../lib/migration-freeze";
import {
  confidentialityAgreementKindsAcceptedForRole,
  confidentialityAgreementVersions,
  ndaBusinessKeyForVersion,
  LEGACY_NDA_AGREEMENT_VERSION,
  PROJECT_OWNER_PLEDGE_VERSION,
  NDA_AGREEMENT_VERSION,
} from "../../../lib/nda-agreement";

const SESSION_ABSOLUTE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_IDLE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_TOUCH_INTERVAL_MS = 60 * 1000;

export type CurrentUser = {
  email: string;
  displayName: string;
  accountUserId?: string;
  authProvider: "chatgpt" | OAuthProvider | "legacy";
  externalSubject?: string;
  externalLogin?: string;
  memberId?: string;
};

export type AuthenticationReadOptions = {
  readOnly?: boolean;
  noTouch?: boolean;
};

export type AuthorizedUser = {
  user: { email: string; displayName: string; authProvider: "chatgpt" | OAuthProvider };
  role: string;
  accountUserId?: string;
  memberId?: string;
  memberMutationRevision?: string;
  canReviewMembers: boolean;
  canReviewKnowledge: boolean;
  canGrantMemberPermissions: boolean;
  isAdmin: boolean;
  isFinanceOwner: boolean;
  ndaCompleted: boolean;
  ndaAcceptedAt?: string;
  ndaApprovalId?: string;
  ndaAgreementVersion?: string;
};

export type MemberPermission = "technical_advisor" | "project_owner";

export type ProfileVisibility = {
  department: boolean;
  position: boolean;
  phone: boolean;
  bio: boolean;
};

export type AccountProfile = {
  department: string;
  position: string;
  phone: string;
  bio: string;
  visibility: ProfileVisibility;
};

export type Reviewer = {
  email: string;
  displayName: string;
  permissions: MemberPermission[];
  isAdmin: boolean;
  ndaCompleted: boolean;
};

function shouldSuppressAuthenticationWrites(options: AuthenticationReadOptions) {
  return options.readOnly === true || options.noTouch === true;
}

export async function getCurrentUser(options: AuthenticationReadOptions = {}): Promise<CurrentUser | null> {
  const noTouch = shouldSuppressAuthenticationWrites(options);
  const platformUser = await getPlatformUser();
  if (platformUser) return platformUser;

  const oauthUser = await getOAuthSessionUser({ noTouch });
  if (oauthUser) return oauthUser;

  const cookieStore = await cookies();
  const token = cookieStore.get("oa_session")?.value;
  if (!token) return null;
  const tokenHash = await hashToken(token);
  const db = await getDb();
  const [record] = await db
    .select({ session: memberSessions, member: members })
    .from(memberSessions)
    .innerJoin(members, eq(memberSessions.memberId, members.id))
    .where(eq(memberSessions.tokenHash, tokenHash))
    .limit(1);
  if (!record) return null;

  if (record.member.status === "rejected" || record.member.status === "departed") {
    if (!noTouch) {
      await db.delete(memberSessions).where(eq(memberSessions.tokenHash, tokenHash));
      cookieStore.set("oa_session", "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
    }
    return null;
  }

  const now = Date.now();
  const createdAt = parseStoredTimestamp(record.session.createdAt);
  const lastSeenAt = parseStoredTimestamp(record.session.lastSeenAt);
  const explicitExpiresAt = parseStoredTimestamp(record.session.expiresAt);
  const absoluteExpiresAt = createdAt + SESSION_ABSOLUTE_LIFETIME_MS;
  const expiresAt = Math.min(explicitExpiresAt, absoluteExpiresAt);
  const isExpired = !Number.isFinite(createdAt)
    || !Number.isFinite(lastSeenAt)
    || !Number.isFinite(explicitExpiresAt)
    || now >= expiresAt
    || now - lastSeenAt >= SESSION_IDLE_LIFETIME_MS;
  if (isExpired) {
    if (!noTouch) {
      await db.delete(memberSessions).where(eq(memberSessions.tokenHash, tokenHash));
      cookieStore.set("oa_session", "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
    }
    return null;
  }

  if (!noTouch && !isMigrationWriteFrozen(process.env) && now - lastSeenAt >= SESSION_TOUCH_INTERVAL_MS) {
    const touchedAt = new Date(now).toISOString();
    await db.update(memberSessions).set({ lastSeenAt: touchedAt }).where(eq(memberSessions.tokenHash, tokenHash));
    await db.update(members).set({ lastSeenAt: touchedAt }).where(eq(members.id, record.member.id));
  }
  // A staged legacy-account rebind belongs to an unreviewed new subject.  The
  // cookie must never reveal the previous subject's canonical real name when
  // a platform identity header is absent.
  return {
    email: record.member.chatgptAccount,
    displayName: record.member.accountBindingPreviousStatus ? record.member.chatgptAccount : record.member.fullName,
    authProvider: "legacy",
  };
}

async function clearOAuthSession(tokenHash?: string) {
  const cookieStore = await cookies();
  const tokenValues = [cookieStore.get(OAUTH_SESSION_COOKIE)?.value, cookieStore.get(LEGACY_GITHUB_SESSION_COOKIE)?.value].filter((value): value is string => Boolean(value));
  const tokenHashes = new Set<string>(tokenHash ? [tokenHash] : []);
  for (const hash of await Promise.all(tokenValues.map((value) => hashToken(value)))) tokenHashes.add(hash);
  try {
    if (tokenHashes.size) await (await getDb()).delete(oauthSessions).where(inArray(oauthSessions.tokenHash, Array.from(tokenHashes)));
  } catch {
    // Clearing browser credentials is still required when D1 is temporarily unavailable.
  }
  cookieStore.set(OAUTH_SESSION_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
  cookieStore.set(LEGACY_GITHUB_SESSION_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
}

function enabledOAuthProvider(value: string): OAuthProvider | null {
  if (value === GITHUB_PROVIDER && isGitHubLoginEnabled()) return GITHUB_PROVIDER;
  if (value === FEISHU_PROVIDER && isFeishuLoginEnabled()) return FEISHU_PROVIDER;
  return null;
}

async function getOAuthSessionUser(options: AuthenticationReadOptions = {}): Promise<CurrentUser | null> {
  const noTouch = shouldSuppressAuthenticationWrites(options);
  const cookieStore = await cookies();
  const token = cookieStore.get(OAUTH_SESSION_COOKIE)?.value || cookieStore.get(LEGACY_GITHUB_SESSION_COOKIE)?.value;
  if (!token) return null;
  const tokenHash = await hashToken(token);
  const db = await getDb();
  const [session] = await db.select().from(oauthSessions).where(eq(oauthSessions.tokenHash, tokenHash)).limit(1);
  const provider = session ? enabledOAuthProvider(session.provider) : null;
  if (!session || !provider || session.revokedAt) {
    if (!noTouch) await clearOAuthSession(session ? tokenHash : undefined);
    return null;
  }
  const nowMs = Date.now();
  const createdAt = parseStoredTimestamp(session.createdAt);
  const lastSeenAt = parseStoredTimestamp(session.lastSeenAt);
  const explicitExpiresAt = parseStoredTimestamp(session.expiresAt);
  const absoluteExpiresAt = createdAt + OAUTH_SESSION_MAX_AGE_SECONDS * 1000;
  const expiresAt = Math.min(explicitExpiresAt, absoluteExpiresAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(lastSeenAt) || !Number.isFinite(explicitExpiresAt) || nowMs >= expiresAt || nowMs - lastSeenAt >= OAUTH_SESSION_IDLE_MAX_AGE_MS) {
    if (!noTouch) await clearOAuthSession(tokenHash);
    return null;
  }

  const now = new Date(nowMs).toISOString();
  if (!session.memberId) {
    if (!noTouch && nowMs - lastSeenAt >= SESSION_TOUCH_INTERVAL_MS) await db.update(oauthSessions).set({ lastSeenAt: now }).where(eq(oauthSessions.tokenHash, tokenHash));
    try {
      return {
        email: normalizeAccountEmail(session.emailSnapshot),
        displayName: session.displayNameSnapshot || session.emailSnapshot,
        authProvider: provider,
        externalSubject: session.providerSubject,
        externalLogin: session.loginSnapshot,
      };
    } catch {
      if (!noTouch) await clearOAuthSession(tokenHash);
      return null;
    }
  }

  const [[member], [identity]] = await Promise.all([
    db.select({
      id: members.id,
      fullName: members.fullName,
      chatgptAccount: members.chatgptAccount,
      accountUserId: members.accountUserId,
      accountBindingPreviousStatus: members.accountBindingPreviousStatus,
      status: members.status,
    }).from(members).where(eq(members.id, session.memberId)).limit(1),
    db.select({ id: authIdentities.id }).from(authIdentities).where(and(
      eq(authIdentities.memberId, session.memberId),
      eq(authIdentities.provider, provider),
      eq(authIdentities.providerSubject, session.providerSubject),
      sql`${authIdentities.unlinkedAt} IS NULL`,
    )).limit(1),
  ]);
  if (!member || !identity) {
    if (!noTouch) await clearOAuthSession(tokenHash);
    return null;
  }
  if (member.status === "departed") {
    if (!noTouch) await clearOAuthSession(tokenHash);
    return null;
  }
  if (!noTouch && nowMs - lastSeenAt >= SESSION_TOUCH_INTERVAL_MS) {
    if (isMigrationWriteFrozen(process.env)) {
      await db.update(oauthSessions).set({ lastSeenAt: now }).where(eq(oauthSessions.tokenHash, tokenHash));
    } else {
    await db.batch([
      db.update(oauthSessions).set({ lastSeenAt: now }).where(eq(oauthSessions.tokenHash, tokenHash)),
      db.update(authIdentities).set({ lastSeenAt: now }).where(eq(authIdentities.id, identity.id)),
      db.update(members).set({ lastSeenAt: now }).where(eq(members.id, member.id)),
    ]);
    }
  }
  return {
    email: normalizeAccountEmail(member.chatgptAccount),
    displayName: member.accountBindingPreviousStatus ? member.chatgptAccount : member.fullName,
    accountUserId: member.accountUserId || undefined,
    authProvider: provider,
    externalSubject: session.providerSubject,
    externalLogin: session.loginSnapshot,
    memberId: member.id,
  };
}

export async function getPlatformUser(): Promise<CurrentUser | null> {
  const requestHeaders = await headers();
  const rawEmail = requestHeaders.get("oai-authenticated-user-email")?.trim();
  if (!rawEmail) return null;
  let email: string;
  let accountUserId: string;
  try {
    email = normalizeAccountEmail(rawEmail);
    accountUserId = accountSubjectForEmail(email);
  } catch {
    return null;
  }
  const encodedName = requestHeaders.get("oai-authenticated-user-full-name");
  const encoding = requestHeaders.get("oai-authenticated-user-full-name-encoding");
  let displayName = email;
  if (encodedName && encoding === "percent-encoded-utf-8") {
    try { displayName = decodeURIComponent(encodedName) || email; } catch { displayName = email; }
  }
  return { email, displayName, accountUserId, authProvider: "chatgpt" };
}

export async function getAuthorizedUser(options: AuthenticationReadOptions = {}): Promise<AuthorizedUser | null> {
  const noTouch = shouldSuppressAuthenticationWrites(options);
  const user = await getCurrentUser({ noTouch });
  // Business access requires the authenticated email subject injected by the
  // Sites edge on this request. An old OA cookie alone is not sufficient.
  if (!user?.accountUserId) return null;
  const normalizedEmail = user.email.trim().toLowerCase();
  const isAdmin = isAdministrator(user.email, user.accountUserId);
  const configuredAdmin = isAdmin
    ? getConfiguredAdministrators().find((admin) => admin.email === normalizedEmail && admin.accountUserId === user.accountUserId)
    : undefined;
  const isConfiguredProjectOwner = isProjectOwner(user.email, user.accountUserId);
  const isConfiguredFinanceOwner = isFinanceOwner(user.email, user.accountUserId);
  const db = await getDb();
  const memberIdentityCondition = user.authProvider !== "chatgpt" && user.memberId
    ? eq(members.id, user.memberId)
    : eq(members.chatgptAccount, normalizedEmail);
  const [member] = await db
    .select({
      id: members.id,
      fullName: members.fullName,
      chatgptAccount: members.chatgptAccount,
      accountUserId: members.accountUserId,
      role: members.role,
      permissionsJson: members.permissionsJson,
      status: members.status,
      ndaAcceptedAt: members.ndaAcceptedAt,
      ndaApprovalId: members.ndaApprovalId,
      ndaAgreementVersion: members.ndaAgreementVersion,
      mutationRevision: members.mutationRevision,
    })
    .from(members)
    .where(memberIdentityCondition)
    .limit(1);

  // A configured privileged role must not silently reactivate an account that
  // an administrator has rejected or marked as departed in the OA directory.
  // Runtime role lists grant capabilities only after normal member admission.
  // The administrator remains the sole bootstrap exception.
  if (!isAdmin && (!member || member.status !== "active" || !member.accountUserId)) return null;
  if (!isAdmin && member.accountUserId !== user.accountUserId) return null;

  if (isAdmin || isConfiguredProjectOwner || isConfiguredFinanceOwner) {
    // Server-side role configuration grants capability, not a second identity.
    // Once an account has an approved member record, all signatures and audit
    // events must use that reviewed real name instead of mutable SIWC profile text.
    const memberIdentityMatches = member?.accountUserId === user.accountUserId;
    const publicUser = { email: user.email, displayName: member?.status === "active" && memberIdentityMatches ? member.fullName : configuredAdmin?.displayName || user.displayName, authProvider: user.authProvider as "chatgpt" | OAuthProvider };
    const memberHasProjectOwnerPermission = member?.status === "active"
      && member.accountUserId === user.accountUserId
      && parseMemberPermissions(member.role, member.permissionsJson).includes("project_owner");
    const role = isAdmin || isConfiguredProjectOwner || memberHasProjectOwnerPermission ? "project_owner" : "finance_owner";
    const nda = await resolveNdaAcceptance(normalizedEmail, user.accountUserId, role, member, { noTouch });
    if (!noTouch) {
      try { await touchAccountPresence(user.email); } catch { /* Presence must not block a valid login. */ }
    }
    return {
      user: publicUser,
      role,
      accountUserId: user.accountUserId,
      memberId: member?.id,
      memberMutationRevision: member?.mutationRevision,
      canReviewMembers: canReviewMemberRegistrations(isAdmin),
      canReviewKnowledge: isAdmin || role === "project_owner",
      canGrantMemberPermissions: isAdmin,
      isAdmin,
      isFinanceOwner: isConfiguredFinanceOwner || isAdmin,
      ndaCompleted: nda.completed,
      ndaAcceptedAt: nda.acceptedAt,
      ndaApprovalId: nda.approvalId,
      ndaAgreementVersion: nda.agreementVersion,
    };
  }
  if (!member || member.status !== "active") return null;
  const publicUser = { email: user.email, displayName: member.fullName || user.displayName, authProvider: user.authProvider as "chatgpt" | OAuthProvider };
  const permissions = parseMemberPermissions(member.role, member.permissionsJson);
  const role = permissions.includes("project_owner") ? "project_owner" : permissions.includes("technical_advisor") ? "technical_advisor" : "member";
  const nda = await resolveNdaAcceptance(normalizedEmail, user.accountUserId, role, member, { noTouch });
  if (!noTouch) {
    try { await touchAccountPresence(user.email); } catch { /* Presence must not block a valid login. */ }
  }
  return {
    user: publicUser,
    role,
    accountUserId: user.accountUserId,
    memberId: member.id,
    memberMutationRevision: member.mutationRevision,
    canReviewMembers: canReviewMemberRegistrations(false),
    canReviewKnowledge: role === "project_owner",
    canGrantMemberPermissions: false,
    isAdmin: false,
    isFinanceOwner: isFinanceOwner(user.email, user.accountUserId),
    ndaCompleted: nda.completed,
    ndaAcceptedAt: nda.acceptedAt,
    ndaApprovalId: nda.approvalId,
    ndaAgreementVersion: nda.agreementVersion,
  };
}

/**
 * SQL-time guard for business writes.  Non-admin authorization is tied to the
 * exact member revision observed during authentication, so a concurrent
 * disable, identity rebind, permission change, or role revocation makes the
 * final mutation affect zero rows inside the same D1 batch.
 */
export function authorizedMemberGuard(authorized: AuthorizedUser) {
  if (authorized.isAdmin) return sql`1 = 1`;
  if (!authorized.memberId || !authorized.memberMutationRevision || !authorized.accountUserId) return sql`0 = 1`;
  const ndaGuard = authorized.ndaCompleted
    ? authorized.role === "project_owner"
      ? sql`AND actor_member.nda_accepted_at IS NOT NULL AND actor_member.nda_agreement_version = ${PROJECT_OWNER_PLEDGE_VERSION}`
      : sql`AND actor_member.nda_accepted_at IS NOT NULL AND actor_member.nda_agreement_version IN (${NDA_AGREEMENT_VERSION}, ${LEGACY_NDA_AGREEMENT_VERSION}, ${PROJECT_OWNER_PLEDGE_VERSION})`
    : sql``;
  return sql`EXISTS (
    SELECT 1 FROM members AS actor_member
    WHERE actor_member.id = ${authorized.memberId}
      AND actor_member.status = 'active'
      AND actor_member.account_user_id = ${authorized.accountUserId}
      AND actor_member.mutation_revision = ${authorized.memberMutationRevision}
      ${ndaGuard}
  )`;
}

type NdaMemberRecord = {
  id: string;
  accountUserId: string | null;
  ndaAcceptedAt: string | null;
  ndaApprovalId: string | null;
  ndaAgreementVersion: string | null;
  mutationRevision: string;
};

async function resolveNdaAcceptance(normalizedEmail: string, accountUserId: string, role: string, member?: NdaMemberRecord | null, options: AuthenticationReadOptions = {}): Promise<{ completed: boolean; acceptedAt?: string; approvalId?: string; agreementVersion?: string }> {
  const noTouch = shouldSuppressAuthenticationWrites(options);
  const db = await getDb();
  const writeFrozen = isMigrationWriteFrozen(process.env);
  if (!accountUserId || (member?.accountUserId && member.accountUserId !== accountUserId)) {
    if (!noTouch && !writeFrozen && (member?.ndaAcceptedAt || member?.ndaApprovalId || member?.ndaAgreementVersion)) {
      await db
        .update(members)
        .set({ ndaAcceptedAt: null, ndaApprovalId: null, ndaAgreementVersion: null })
        .where(and(eq(members.id, member.id), eq(members.mutationRevision, member.mutationRevision)));
    }
    return { completed: false };
  }
  const acceptedKinds = confidentialityAgreementKindsAcceptedForRole(role);
  const acceptedAgreementConditions = acceptedKinds.flatMap((kind) => confidentialityAgreementVersions(kind).map((version) => and(
    sql`CASE WHEN json_valid(${approvals.payloadJson}) THEN json_extract(${approvals.payloadJson}, '$.agreementVersion') = ${version} ELSE 0 END`,
    eq(approvals.businessKey, ndaBusinessKeyForVersion(accountUserId, version)),
  )));
  // Bind the agreement lookup to the exact member snapshot that determined
  // this request's role. If an administrator changes role, permissions,
  // status, or account binding between the member read and this query, the
  // old role must not be able to reuse its former agreement for admission.
  const memberSnapshotGuard = member
    ? sql`EXISTS (
        SELECT 1 FROM members AS nda_member
        WHERE nda_member.id = ${member.id}
          AND nda_member.account_user_id = ${accountUserId}
          AND nda_member.mutation_revision = ${member.mutationRevision}
      )`
    : sql`1 = 1`;
  const [archivedNda] = await db
    .select({
      id: approvals.id,
      archivedAt: approvals.updatedAt,
      agreementVersion: sql<string>`json_extract(${approvals.payloadJson}, '$.agreementVersion')`.as("agreement_version"),
    })
    .from(approvals)
    .where(and(
      eq(approvals.type, "保密协议"),
      eq(approvals.status, "已归档"),
      sql`lower(${approvals.requesterEmail}) = ${normalizedEmail}`,
      sql`CASE WHEN json_valid(${approvals.payloadJson}) THEN json_extract(${approvals.payloadJson}, '$.signerAccountUserId') = ${accountUserId} ELSE 0 END`,
      or(...acceptedAgreementConditions),
      memberSnapshotGuard,
    ))
    .orderBy(desc(approvals.updatedAt))
    .limit(1);
  if (!archivedNda) {
    if (!noTouch && !writeFrozen && (member?.ndaAcceptedAt || member?.ndaApprovalId || member?.ndaAgreementVersion)) {
      await db
        .update(members)
        .set({ ndaAcceptedAt: null, ndaApprovalId: null, ndaAgreementVersion: null })
        .where(and(eq(members.id, member.id), eq(members.mutationRevision, member.mutationRevision)));
    }
    return { completed: false };
  }
  if (!noTouch && !writeFrozen && member && (member.ndaAcceptedAt !== archivedNda.archivedAt || member.ndaApprovalId !== archivedNda.id || member.ndaAgreementVersion !== archivedNda.agreementVersion)) {
    await db
      .update(members)
      .set({ ndaAcceptedAt: archivedNda.archivedAt, ndaApprovalId: archivedNda.id, ndaAgreementVersion: archivedNda.agreementVersion })
      .where(and(
        eq(members.id, member.id),
        eq(members.accountUserId, accountUserId),
        eq(members.mutationRevision, member.mutationRevision),
      ));
  }
  return { completed: true, acceptedAt: archivedNda.archivedAt, approvalId: archivedNda.id, agreementVersion: archivedNda.agreementVersion };
}

function parseStoredTimestamp(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  return Date.parse(normalized);
}

export async function hashToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function parseMemberPermissions(role: string | null | undefined, permissionsJson: string | null | undefined): MemberPermission[] {
  const permissions = new Set<MemberPermission>();
  if (role === "technical_advisor" || role === "project_owner") permissions.add(role);
  try {
    const parsed = JSON.parse(permissionsJson ?? "[]") as unknown;
    if (Array.isArray(parsed)) {
      for (const value of parsed) {
        if (value === "technical_advisor" || value === "project_owner") permissions.add(value);
      }
    }
  } catch {
    // Keep legacy or malformed permission data from blocking member access.
  }
  return Array.from(permissions);
}

export function parseAccountProfile(profileJson: string | null | undefined): AccountProfile {
  try {
    const parsed = JSON.parse(profileJson ?? "{}") as unknown;
    const profile = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    const rawVisibility = profile.visibility && typeof profile.visibility === "object" && !Array.isArray(profile.visibility) ? profile.visibility as Record<string, unknown> : {};
    return {
      department: typeof profile.department === "string" ? profile.department : "",
      position: typeof profile.position === "string" ? profile.position : "",
      phone: typeof profile.phone === "string" ? profile.phone : "",
      bio: typeof profile.bio === "string" ? profile.bio : "",
      visibility: {
        department: rawVisibility.department === true,
        position: rawVisibility.position === true,
        phone: rawVisibility.phone === true,
        bio: rawVisibility.bio === true,
      },
    };
  } catch {
    return { department: "", position: "", phone: "", bio: "", visibility: { department: false, position: false, phone: false, bio: false } };
  }
}

function configuredList(key: string, fallback = "") {
  return (process.env[key] ?? fallback)
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function configuredNames(key: string, fallback = "") {
  return (process.env[key] ?? fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

type ConfiguredPrivilegedIdentity = { email: string; accountUserId: string; displayName: string };
type ConfiguredRoleName = "管理员" | "项目负责人" | "经费负责人";

function configuredRoleEntries(role: ConfiguredRoleName, emailKey: string, nameKey: string, required = false): ConfiguredPrivilegedIdentity[] {
  const isUnconfigured = process.env[emailKey] === undefined && process.env[nameKey] === undefined;
  if (isUnconfigured && !required) return [];
  const emails = configuredList(emailKey);
  const names = configuredNames(nameKey);
  if (!emails.length || emails.length !== names.length || new Set(emails).size !== emails.length) {
    throw new Error(`OA ${role}邮箱与姓名必须一一对应且不能重复。`);
  }
  return emails.map((email, index) => ({ email, accountUserId: accountSubjectForEmail(email), displayName: names[index] }));
}

function configuredPrivilegedRoles() {
  const roles = [
    { role: "管理员" as const, entries: configuredRoleEntries("管理员", "OA_ADMIN_EMAILS", "OA_ADMIN_NAMES", true) },
    { role: "项目负责人" as const, entries: configuredRoleEntries("项目负责人", "OA_PROJECT_OWNER_EMAILS", "OA_PROJECT_OWNER_NAMES") },
    { role: "经费负责人" as const, entries: configuredRoleEntries("经费负责人", "OA_FINANCE_OWNER_EMAILS", "OA_FINANCE_OWNER_NAMES") },
  ];
  const identitiesByEmail = new Map<string, { accountUserId: string; displayName: string; role: ConfiguredRoleName }>();
  const identitiesById = new Map<string, { email: string; displayName: string; role: ConfiguredRoleName }>();
  for (const group of roles) {
    for (const entry of group.entries) {
      const emailMatch = identitiesByEmail.get(entry.email);
      if (emailMatch && emailMatch.accountUserId !== entry.accountUserId) {
        throw new Error(`OA 特权角色配置冲突：同一邮箱不能在${emailMatch.role}与${group.role}中对应不同账户主体。`);
      }
      if (emailMatch && emailMatch.displayName !== entry.displayName) {
        throw new Error(`OA 特权角色配置冲突：同一实名账户在${emailMatch.role}与${group.role}中的姓名必须一致。`);
      }
      const idMatch = identitiesById.get(entry.accountUserId);
      if (idMatch && idMatch.email !== entry.email) {
        throw new Error(`OA 特权角色配置冲突：同一账户主体不能在${idMatch.role}与${group.role}中对应不同邮箱。`);
      }
      identitiesByEmail.set(entry.email, { accountUserId: entry.accountUserId, displayName: entry.displayName, role: group.role });
      identitiesById.set(entry.accountUserId, { email: entry.email, displayName: entry.displayName, role: group.role });
    }
  }
  return roles;
}

export function getConfiguredAdministrators(): ConfiguredPrivilegedIdentity[] {
  return configuredPrivilegedRoles()[0].entries;
}

export function getConfiguredProjectOwners(): ConfiguredPrivilegedIdentity[] {
  return configuredPrivilegedRoles()[1].entries;
}

export function getConfiguredFinanceOwners(): ConfiguredPrivilegedIdentity[] {
  return configuredPrivilegedRoles()[2].entries;
}

export async function touchAccountPresence(email: string): Promise<void> {
  if (isMigrationWriteFrozen(process.env)) return;
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) return;
  const db = await getDb();
  const [existing] = await db.select({ lastSeenAt: accountProfiles.lastSeenAt }).from(accountProfiles).where(eq(accountProfiles.chatgptAccount, normalizedEmail)).limit(1);
  const lastSeenAt = existing ? Date.parse(existing.lastSeenAt) : NaN;
  if (existing && Number.isFinite(lastSeenAt) && Date.now() - lastSeenAt < 60_000) return;
  const now = new Date().toISOString();
  if (existing) await db.update(accountProfiles).set({ lastSeenAt: now }).where(eq(accountProfiles.chatgptAccount, normalizedEmail));
  else await db.insert(accountProfiles).values({ chatgptAccount: normalizedEmail, lastSeenAt: now });
}

export async function getReviewerDirectory(extraOwner?: CurrentUser): Promise<Reviewer[]> {
  const configuredOwners = getConfiguredProjectOwners();
  const configuredAdmins = getConfiguredAdministrators();
  const rows = await (await getDb()).select({ id: members.id, fullName: members.fullName, chatgptAccount: members.chatgptAccount, accountUserId: members.accountUserId, role: members.role, permissionsJson: members.permissionsJson, ndaAcceptedAt: members.ndaAcceptedAt, ndaApprovalId: members.ndaApprovalId, ndaAgreementVersion: members.ndaAgreementVersion, mutationRevision: members.mutationRevision, status: members.status }).from(members);
  const membersByEmail = new Map(rows.map((row) => [row.chatgptAccount.toLowerCase(), row]));
  const reviewers = new Map<string, Reviewer>();
  for (const { email, accountUserId, displayName } of configuredAdmins) {
    const configuredMember = membersByEmail.get(email);
    const ndaCompleted = (await resolveNdaAcceptance(email, accountUserId, "project_owner", configuredMember)).completed;
    reviewers.set(email, { email, displayName: configuredMember?.status === "active" && configuredMember.accountUserId === accountUserId ? configuredMember.fullName : displayName, permissions: ["technical_advisor", "project_owner"], isAdmin: true, ndaCompleted });
  }
  for (const { email, accountUserId, displayName } of configuredOwners) {
    const configuredMember = membersByEmail.get(email);
    const configuredIdentityMatches = configuredMember?.accountUserId === accountUserId;
    const activeConfiguredIdentityMatches = configuredMember?.status === "active" && configuredIdentityMatches;
    if (!isAdministrator(email, accountUserId) && !activeConfiguredIdentityMatches) continue;
    const ndaCompleted = (await resolveNdaAcceptance(email, accountUserId, "project_owner", configuredMember)).completed;
    if (ndaCompleted) {
      const existing = reviewers.get(email);
      reviewers.set(email, { email, displayName: activeConfiguredIdentityMatches ? configuredMember?.fullName || displayName : existing?.displayName || displayName, permissions: ["technical_advisor", "project_owner"], isAdmin: existing?.isAdmin ?? false, ndaCompleted: true });
    }
  }
  if (extraOwner && isProjectOwner(extraOwner.email, extraOwner.accountUserId)) {
    const email = extraOwner.email.toLowerCase();
    const configuredMember = membersByEmail.get(email);
    if (isAdministrator(extraOwner.email, extraOwner.accountUserId) || (configuredMember?.status === "active" && configuredMember.accountUserId === extraOwner.accountUserId)) {
      const ndaCompleted = (await resolveNdaAcceptance(email, extraOwner.accountUserId || "", "project_owner", configuredMember)).completed;
      if (ndaCompleted) {
        const existing = reviewers.get(email);
        const activeMemberIdentityMatches = configuredMember?.status === "active" && configuredMember.accountUserId === extraOwner.accountUserId;
        reviewers.set(email, { email, displayName: activeMemberIdentityMatches ? configuredMember.fullName || extraOwner.displayName : existing?.displayName || extraOwner.displayName, permissions: ["technical_advisor", "project_owner"], isAdmin: existing?.isAdmin ?? isAdministrator(extraOwner.email, extraOwner.accountUserId), ndaCompleted: true });
      }
    }
  }
  for (const row of rows) {
    if (row.status !== "active") continue;
    const email = row.chatgptAccount.toLowerCase();
    if (!isNdaAdmittedMember(row)) continue;
    const permissions = parseMemberPermissions(row.role, row.permissionsJson);
    if (!permissions.length) continue;
    const existing = reviewers.get(email);
    reviewers.set(email, { email, displayName: existing?.displayName || row.fullName, permissions: Array.from(new Set([...(existing?.permissions ?? []), ...permissions])), isAdmin: existing?.isAdmin ?? isAdministrator(row.chatgptAccount, row.accountUserId || undefined), ndaCompleted: true });
  }
  return Array.from(reviewers.values()).sort((left, right) => left.displayName.localeCompare(right.displayName, "zh-CN"));
}

export function isProjectOwner(email: string, accountUserId?: string): boolean {
  if (isAdministrator(email, accountUserId)) return true;
  if (!accountUserId) return false;
  const normalizedEmail = email.trim().toLowerCase();
  return getConfiguredProjectOwners().some((owner) => owner.email === normalizedEmail && owner.accountUserId === accountUserId);
}

export function isAdministrator(email: string, accountUserId?: string): boolean {
  if (!accountUserId) return false;
  const normalizedEmail = email.trim().toLowerCase();
  return getConfiguredAdministrators().some((admin) => admin.email === normalizedEmail && admin.accountUserId === accountUserId);
}

export function isFinanceOwner(email: string, accountUserId?: string): boolean {
  if (!accountUserId) return false;
  const normalizedEmail = email.trim().toLowerCase();
  const financeOwners = getConfiguredFinanceOwners();
  return isAdministrator(email, accountUserId) || financeOwners.some((owner) => owner.email === normalizedEmail && owner.accountUserId === accountUserId);
}

export function isNdaAdmittedMember(member: { chatgptAccount: string; accountUserId?: string | null; role?: string | null; permissionsJson?: string | null; ndaAcceptedAt?: string | null; ndaAgreementVersion?: string | null }): boolean {
  if (!member.accountUserId || !member.ndaAcceptedAt || !member.ndaAgreementVersion) return false;
  const isOwner = isProjectOwner(member.chatgptAccount, member.accountUserId)
    || parseMemberPermissions(member.role, member.permissionsJson).includes("project_owner");
  const acceptedKinds = confidentialityAgreementKindsAcceptedForRole(isOwner ? "project_owner" : "member");
  return acceptedKinds.some((kind) => confidentialityAgreementVersions(kind).includes(member.ndaAgreementVersion || ""));
}

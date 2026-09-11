import { and, eq, exists, gt, isNull, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { getDb } from "../../../db";
import { authIdentities, memberEvents, memberSessions, members, oauthSessions } from "../../../db/schema";
import { accountSubjectForFeishu, accountSubjectForGitHub, isSupportedAccountSubject } from "../../../lib/account-subject";
import { FEISHU_PROVIDER } from "../../../lib/feishu-oauth";
import { GITHUB_PROVIDER } from "../../../lib/github-oauth";
import { LEGACY_GITHUB_SESSION_COOKIE, OAUTH_SESSION_COOKIE, type OAuthProvider } from "../../../lib/oauth-session";
import { conditionalMemberEvent } from "../../../lib/workflow-write-store";
import { readBoundedJsonObject } from "../../../lib/bounded-json-request";
import { getCurrentUser, hashToken } from "../_lib/auth";

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const MAX_REQUEST_BYTES = 4_096;

function oauthProviderLabel(provider: OAuthProvider) {
  return provider === GITHUB_PROVIDER ? "GitHub" : "飞书";
}

async function oauthAccountSubject(provider: OAuthProvider, providerSubject: string) {
  return provider === GITHUB_PROVIDER
    ? accountSubjectForGitHub(providerSubject)
    : accountSubjectForFeishu(providerSubject);
}

export async function POST(request: Request) {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return Response.json({ error: "注册资料必须使用 JSON 格式提交。" }, { status: 415 });
  const parsedBody = await readBoundedJsonObject(request, MAX_REQUEST_BYTES);
  if (!parsedBody.ok) return Response.json({ error: parsedBody.reason === "too_large" ? "注册资料过大。" : "注册资料格式不正确。" }, { status: parsedBody.reason === "too_large" ? 413 : 400 });
  const body: { fullName?: unknown; identityNumber?: unknown } = parsedBody.value;
  if (typeof body.fullName !== "string" || (body.identityNumber !== undefined && typeof body.identityNumber !== "string")) return Response.json({ error: "注册资料格式不正确。" }, { status: 400 });
  const fullName = body.fullName?.trim() ?? "";
  const identityNumber = typeof body.identityNumber === "string" ? body.identityNumber.trim() : "";
  if (fullName.length < 2 || fullName.length > 40 || /[\u0000-\u001f\u007f]/.test(fullName)) return Response.json({ error: "请填写有效姓名（2 至 40 个字符）。" }, { status: 400 });
  if (identityNumber.length > 64 || /[\u0000-\u001f\u007f]/.test(identityNumber)) return Response.json({ error: "学号/工号不能超过 64 个字符。" }, { status: 400 });
  const authenticatedUser = await getCurrentUser();
  if (!authenticatedUser || authenticatedUser.authProvider === "legacy") return Response.json({ error: "请先完成身份验证，再提交注册。" }, { status: 401 });
  const oauthProvider: OAuthProvider | null = authenticatedUser.authProvider === GITHUB_PROVIDER || authenticatedUser.authProvider === FEISHU_PROVIDER
    ? authenticatedUser.authProvider
    : null;
  if (authenticatedUser.authProvider !== "chatgpt" && !oauthProvider) return Response.json({ error: "当前登录方式已停用，请改用飞书、ChatGPT 或 GitHub 重新登录。" }, { status: 401 });
  const oauthSubject = oauthProvider ? authenticatedUser.externalSubject?.trim() || "" : "";
  const chatgptAccount = authenticatedUser.email.toLowerCase();
  let derivedOauthSubject = "";
  try {
    if (oauthProvider) derivedOauthSubject = await oauthAccountSubject(oauthProvider, oauthSubject);
  } catch {
    return Response.json({ error: `无法验证当前${oauthProvider ? oauthProviderLabel(oauthProvider) : "外部"}账户，请重新登录后再试。` }, { status: 400 });
  }
  const accountUserId = (authenticatedUser.accountUserId || derivedOauthSubject).trim();
  if (!accountUserId || !isSupportedAccountSubject(accountUserId)) return Response.json({ error: "无法读取当前登录账户的受支持身份标识，请重新登录后再试。" }, { status: 400 });
  if (chatgptAccount.length > 254 || !chatgptAccount.includes("@")) return Response.json({ error: "当前认证身份无效。" }, { status: 400 });
  const oauthSessionCookies = oauthProvider ? await cookies() : null;
  const oauthSessionToken = oauthSessionCookies?.get(OAUTH_SESSION_COOKIE)?.value || oauthSessionCookies?.get(LEGACY_GITHUB_SESSION_COOKIE)?.value || "";
  const oauthSessionTokenHash = oauthSessionToken ? await hashToken(oauthSessionToken) : "";
  if (oauthProvider && !oauthSessionTokenHash) return Response.json({ error: `${oauthProviderLabel(oauthProvider)}登录会话已失效，请重新登录。` }, { status: 401 });
  try {
    const db = await getDb();
    const [existingIdentity] = await db.select({ id: members.id, chatgptAccount: members.chatgptAccount }).from(members).where(eq(members.accountUserId, accountUserId)).limit(1);
    if (existingIdentity && existingIdentity.chatgptAccount !== chatgptAccount) {
      return Response.json({ error: `当前登录身份已绑定成员邮箱 ${existingIdentity.chatgptAccount}。邮箱变更必须由管理员核验，不能自动迁移历史审批归属。` }, { status: 409 });
    }
    const [existingAccount] = await db.select().from(members).where(eq(members.chatgptAccount, chatgptAccount)).limit(1);
    if (existingAccount) {
      if (oauthProvider) {
        const [linkedOAuthIdentity] = await db.select({ memberId: authIdentities.memberId }).from(authIdentities).where(and(eq(authIdentities.provider, oauthProvider), eq(authIdentities.providerSubject, oauthSubject), isNull(authIdentities.unlinkedAt))).limit(1);
        if (!linkedOAuthIdentity || linkedOAuthIdentity.memberId !== existingAccount.id) return Response.json({ error: `该认证邮箱已有成员记录。为防止误合并，请先使用原登录方式进入 OA，再在“个人设置”中显式绑定${oauthProviderLabel(oauthProvider)}；如无法使用原登录方式，请联系 OA 管理员人工核验。` }, { status: 409 });
      }
      if (existingAccount.accountUserId && existingAccount.accountUserId !== accountUserId) return Response.json({ error: "当前登录身份与原成员记录不一致，请联系管理员进行人工核验。" }, { status: 403 });
      if ((existingAccount.status === "active" || existingAccount.status === "departed") && !existingAccount.accountUserId) {
        const now = new Date().toISOString();
        const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
        const token = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
        const tokenHash = await hashToken(token);
        const mutationRevision = crypto.randomUUID();
        const stillLegacyAccount = exists(db.select({ id: members.id }).from(members).where(and(eq(members.id, existingAccount.id), eq(members.status, existingAccount.status), eq(members.mutationRevision, existingAccount.mutationRevision), sql`${members.accountUserId} IS NULL`)));
        const revokeOldSessions = db.delete(memberSessions).where(and(eq(memberSessions.memberId, existingAccount.id), stillLegacyAccount));
        const updateMember = db.update(members).set({ accountUserId, pendingFullName: fullName, pendingIdentityNumber: identityNumber || null, accountBindingPreviousStatus: existingAccount.status, role: "member", permissionsJson: "[]", departmentCode: "", status: "pending", ndaAcceptedAt: null, ndaApprovalId: null, ndaAgreementVersion: null, mutationRevision, lastSeenAt: now }).where(and(eq(members.id, existingAccount.id), eq(members.status, existingAccount.status), eq(members.mutationRevision, existingAccount.mutationRevision), sql`${members.accountUserId} IS NULL`)).returning({ id: members.id });
        const insertEvent = conditionalMemberEvent(db, existingAccount.id, mutationRevision, now, {
          actorName: fullName,
          actorEmail: chatgptAccount,
          action: "account_rebind_submitted",
          note: "历史成员提交认证账户主体重新绑定申请；原权限和保密协议准入已清除，须由管理员核验身份连续性后恢复成员资格，并重新签署当前实验室技术保密协议",
        });
        const insertSession = db.insert(memberSessions).select(db.select({
          tokenHash: sql<string>`${tokenHash}`.as("token_hash"),
          memberId: members.id,
          createdAt: sql<string>`${now}`.as("created_at"),
          lastSeenAt: sql<string>`${now}`.as("last_seen_at"),
          expiresAt: sql<string>`${expiresAt}`.as("expires_at"),
        }).from(members).where(and(eq(members.id, existingAccount.id), eq(members.mutationRevision, mutationRevision)))).returning({ tokenHash: memberSessions.tokenHash });
        const [, updatedRows, eventRows, sessionRows] = await db.batch([revokeOldSessions, updateMember, insertEvent, insertSession]);
        if (!updatedRows[0] || !eventRows[0] || !sessionRows[0]) return Response.json({ error: "账户绑定状态刚刚已更新，请刷新后重试。" }, { status: 409 });
        (await cookies()).set("oa_session", token, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: SESSION_MAX_AGE_SECONDS });
        return Response.json({ registered: false, status: "pending", user: { email: chatgptAccount, displayName: fullName, authProvider: authenticatedUser.authProvider }, role: null });
      }
      if (existingAccount.status === "pending" && !existingAccount.accountUserId) {
        const now = new Date().toISOString();
        const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
        const token = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
        const tokenHash = await hashToken(token);
        const mutationRevision = crypto.randomUUID();
        const stillPendingWithoutBinding = exists(db.select({ id: members.id }).from(members).where(and(eq(members.id, existingAccount.id), eq(members.status, "pending"), eq(members.mutationRevision, existingAccount.mutationRevision), sql`${members.accountUserId} IS NULL`)));
        const revokeOldSessions = db.delete(memberSessions).where(and(eq(memberSessions.memberId, existingAccount.id), stillPendingWithoutBinding));
        const updateMember = db.update(members).set({ fullName, identityNumber: identityNumber || null, accountUserId, pendingFullName: null, pendingIdentityNumber: null, accountBindingPreviousStatus: null, role: "member", permissionsJson: "[]", departmentCode: "", ndaAcceptedAt: null, ndaApprovalId: null, ndaAgreementVersion: null, mutationRevision, lastSeenAt: now }).where(and(eq(members.id, existingAccount.id), eq(members.status, "pending"), eq(members.mutationRevision, existingAccount.mutationRevision), sql`${members.accountUserId} IS NULL`)).returning({ id: members.id });
        const insertEvent = conditionalMemberEvent(db, existingAccount.id, mutationRevision, now, {
          actorName: fullName,
          actorEmail: chatgptAccount,
          action: "account_binding_completed",
          note: "待审核成员补充认证账户主体；保持待审核状态，未继承任何权限或保密协议准入",
        });
        const insertSession = db.insert(memberSessions).select(db.select({
          tokenHash: sql<string>`${tokenHash}`.as("token_hash"),
          memberId: members.id,
          createdAt: sql<string>`${now}`.as("created_at"),
          lastSeenAt: sql<string>`${now}`.as("last_seen_at"),
          expiresAt: sql<string>`${expiresAt}`.as("expires_at"),
        }).from(members).where(and(eq(members.id, existingAccount.id), eq(members.mutationRevision, mutationRevision)))).returning({ tokenHash: memberSessions.tokenHash });
        const [, updatedRows, eventRows, sessionRows] = await db.batch([revokeOldSessions, updateMember, insertEvent, insertSession]);
        if (!updatedRows[0] || !eventRows[0] || !sessionRows[0]) return Response.json({ error: "账户绑定状态刚刚已更新，请刷新后重试。" }, { status: 409 });
        (await cookies()).set("oa_session", token, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: SESSION_MAX_AGE_SECONDS });
        return Response.json({ registered: false, status: "pending", user: { email: chatgptAccount, displayName: fullName, authProvider: authenticatedUser.authProvider }, role: null });
      }
      if (existingAccount.status !== "rejected") return Response.json({ error: "该认证邮箱已提交过注册。" }, { status: 409 });
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
      const token = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
      const tokenHash = await hashToken(token);
      const mutationRevision = crypto.randomUUID();
      const stillRejected = exists(db.select({ id: members.id }).from(members).where(and(eq(members.id, existingAccount.id), eq(members.status, "rejected"), eq(members.mutationRevision, existingAccount.mutationRevision))));
      const revokeOldSessions = db.delete(memberSessions).where(and(eq(memberSessions.memberId, existingAccount.id), stillRejected));
      const updateMember = db.update(members).set({ fullName, identityNumber: identityNumber || null, accountUserId, pendingFullName: null, pendingIdentityNumber: null, accountBindingPreviousStatus: null, role: "member", permissionsJson: "[]", departmentCode: "", status: "pending", ndaAcceptedAt: null, ndaApprovalId: null, ndaAgreementVersion: null, mutationRevision, lastSeenAt: now }).where(and(eq(members.id, existingAccount.id), eq(members.status, "rejected"), eq(members.mutationRevision, existingAccount.mutationRevision))).returning({ id: members.id });
      const insertEvent = conditionalMemberEvent(db, existingAccount.id, mutationRevision, now, {
        actorName: fullName,
        actorEmail: chatgptAccount,
        action: "resubmitted",
        note: "上次成员注册已退回，本次修改资料后重新提交，等待管理员审核；学号/工号为待人工核验信息",
      });
      const insertSession = db.insert(memberSessions).select(db.select({
        tokenHash: sql<string>`${tokenHash}`.as("token_hash"),
        memberId: members.id,
        createdAt: sql<string>`${now}`.as("created_at"),
        lastSeenAt: sql<string>`${now}`.as("last_seen_at"),
        expiresAt: sql<string>`${expiresAt}`.as("expires_at"),
      }).from(members).where(and(eq(members.id, existingAccount.id), eq(members.mutationRevision, mutationRevision)))).returning({ tokenHash: memberSessions.tokenHash });
      const [, updatedRows, eventRows, sessionRows] = await db.batch([revokeOldSessions, updateMember, insertEvent, insertSession]);
      if (!updatedRows[0] || !eventRows[0] || !sessionRows[0]) return Response.json({ error: "注册状态刚刚已更新，请刷新后重试。" }, { status: 409 });
      (await cookies()).set("oa_session", token, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: SESSION_MAX_AGE_SECONDS });
      return Response.json({ registered: false, status: "pending", user: { email: chatgptAccount, displayName: fullName, authProvider: authenticatedUser.authProvider }, role: null });
    }
    const memberId = crypto.randomUUID();
    const token = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
    const mutationRevision = crypto.randomUUID();
    const insertMember = db.insert(members).values({ id: memberId, fullName, identityNumber: identityNumber || null, schoolEmail: "", chatgptAccount, accountUserId, role: "member", status: "pending", mutationRevision, createdAt: now, lastSeenAt: now }).returning({ id: members.id });
    const providerLabel = oauthProvider ? oauthProviderLabel(oauthProvider) : "ChatGPT";
    const insertEvent = db.insert(memberEvents).values({ memberId, actorName: fullName, actorEmail: chatgptAccount, action: "submitted", note: `通过 ${providerLabel} 登录提交成员注册，等待管理员审核（学号/工号为可选且待人工核验的信息）` }).returning({ id: memberEvents.id });
    if (oauthProvider) {
      const activeOAuthSession = and(
        eq(oauthSessions.tokenHash, oauthSessionTokenHash),
        eq(oauthSessions.provider, oauthProvider),
        eq(oauthSessions.providerSubject, oauthSubject),
        isNull(oauthSessions.memberId),
        isNull(oauthSessions.revokedAt),
        gt(oauthSessions.expiresAt, now),
      );
      const [memberRows, eventRows, identityRows, oauthSessionRows] = await db.batch([
        db.insert(members).select(db.select({
          id: sql<string>`${memberId}`.as("id"),
          fullName: sql<string>`${fullName}`.as("full_name"),
          identityNumber: sql<string | null>`${identityNumber || null}`.as("identity_number"),
          schoolEmail: sql<string>`${""}`.as("school_email"),
          chatgptAccount: sql<string>`${chatgptAccount}`.as("chatgpt_account"),
          accountUserId: sql<string>`${accountUserId}`.as("account_user_id"),
          pendingFullName: sql<string | null>`NULL`.as("pending_full_name"),
          pendingIdentityNumber: sql<string | null>`NULL`.as("pending_identity_number"),
          accountBindingPreviousStatus: sql<string | null>`NULL`.as("account_binding_previous_status"),
          role: sql<string>`'member'`.as("role"),
          permissionsJson: sql<string>`'[]'`.as("permissions_json"),
          departmentCode: sql<string>`${""}`.as("department_code"),
          status: sql<string>`'pending'`.as("status"),
          ndaAcceptedAt: sql<string | null>`NULL`.as("nda_accepted_at"),
          ndaApprovalId: sql<string | null>`NULL`.as("nda_approval_id"),
          ndaAgreementVersion: sql<string | null>`NULL`.as("nda_agreement_version"),
          mutationRevision: sql<string>`${mutationRevision}`.as("mutation_revision"),
          createdAt: sql<string>`${now}`.as("created_at"),
          lastSeenAt: sql<string>`${now}`.as("last_seen_at"),
        }).from(oauthSessions).where(activeOAuthSession)).returning({ id: members.id }),
        db.insert(memberEvents).select(db.select({
          id: sql<number>`NULL`.as("id"),
          memberId: sql<string>`${memberId}`.as("member_id"),
          actorName: sql<string>`${fullName}`.as("actor_name"),
          actorEmail: sql<string>`${chatgptAccount}`.as("actor_email"),
          action: sql<string>`'submitted'`.as("action"),
          note: sql<string>`${`通过 ${providerLabel} 登录提交成员注册，等待管理员审核（学号/工号为可选且待人工核验的信息）`}`.as("note"),
          createdAt: sql<string>`${now}`.as("created_at"),
        }).from(oauthSessions).where(activeOAuthSession)).returning({ id: memberEvents.id }),
        db.insert(authIdentities).select(db.select({
          id: sql<string>`${crypto.randomUUID()}`.as("id"),
          memberId: sql<string>`${memberId}`.as("member_id"),
          provider: sql<string>`${oauthProvider}`.as("provider"),
          providerSubject: sql<string>`${oauthSubject}`.as("provider_subject"),
          loginSnapshot: sql<string>`${authenticatedUser.externalLogin || ""}`.as("login_snapshot"),
          verifiedEmailSnapshot: sql<string>`${oauthProvider === FEISHU_PROVIDER ? "" : chatgptAccount}`.as("verified_email_snapshot"),
          linkedAt: sql<string>`${now}`.as("linked_at"),
          lastSeenAt: sql<string>`${now}`.as("last_seen_at"),
          unlinkedAt: sql<string | null>`NULL`.as("unlinked_at"),
        }).from(oauthSessions).where(activeOAuthSession)).returning({ id: authIdentities.id }),
        db.update(oauthSessions).set({ memberId }).where(activeOAuthSession).returning({ tokenHash: oauthSessions.tokenHash }),
      ]);
      if (!memberRows[0] || !eventRows[0] || !identityRows[0] || !oauthSessionRows[0]) return Response.json({ error: `${providerLabel}登录会话刚刚已失效，注册资料未保存，请重新登录。` }, { status: 409 });
    } else {
      const [memberRows, eventRows, sessionRows] = await db.batch([
        insertMember,
        insertEvent,
        db.insert(memberSessions).values({ tokenHash: await hashToken(token), memberId, createdAt: now, lastSeenAt: now, expiresAt }).returning({ tokenHash: memberSessions.tokenHash }),
      ]);
      if (!memberRows[0] || !eventRows[0] || !sessionRows[0]) return Response.json({ error: "注册记录未能完整保存，请稍后重试。" }, { status: 500 });
      (await cookies()).set("oa_session", token, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: SESSION_MAX_AGE_SECONDS });
    }
    return Response.json({ registered: false, status: "pending", user: { email: chatgptAccount, displayName: fullName, authProvider: authenticatedUser.authProvider }, role: null }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/unique constraint/i.test(message)) return Response.json({ error: "当前登录身份或认证邮箱已提交过注册。" }, { status: 409 });
    return Response.json({ error: "注册暂时失败，请稍后重试。" }, { status: 500 });
  }
}

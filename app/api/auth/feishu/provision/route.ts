import { and, eq, exists, gt, isNotNull, isNull, notExists, or, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { getDb } from "../../../../../db";
import { authIdentities, memberEvents, members, oauthSessions } from "../../../../../db/schema";
import { accountEmailForFeishu, accountSubjectForFeishu } from "../../../../../lib/account-subject";
import { readBoundedJsonObject } from "../../../../../lib/bounded-json-request";
import { FEISHU_PROVIDER, getFeishuOAuthConfig } from "../../../../../lib/feishu-oauth";
import { OAUTH_SESSION_COOKIE } from "../../../../../lib/oauth-session";
import { consumeWriteRateLimit } from "../../../../../lib/write-rate-limit";
import { getCurrentUser, hashToken } from "../../../_lib/auth";

const MAX_REQUEST_BYTES = 512;
const DECLINED_SAME_NAME_CONFIRMATION = "none-of-these-accounts-is-mine";

function noStoreJson(body: object, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "private, no-store, max-age=0" } });
}

function sameOriginPost(request: Request, expectedOrigin: string) {
  const fetchSite = request.headers.get("sec-fetch-site");
  return request.headers.get("origin") === expectedOrigin
    && new URL(request.url).origin === expectedOrigin
    && (!fetchSite || fetchSite === "same-origin");
}

function feishuMemberName(value: string) {
  const name = value.trim();
  return name.length >= 1 && name.length <= 40 && !/[\u0000-\u001f\u007f]/u.test(name) ? name : "飞书成员";
}

export async function POST(request: Request) {
  let config;
  try {
    config = getFeishuOAuthConfig();
  } catch {
    return noStoreJson({ error: "飞书登录尚未启用。" }, 503);
  }
  if (!sameOriginPost(request, config.origin)) return noStoreJson({ error: "登录请求来源无效，请刷新页面重试。" }, 403);
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return noStoreJson({ error: "登录确认必须使用 JSON 格式提交。" }, 415);
  }
  const parsedBody = await readBoundedJsonObject(request, MAX_REQUEST_BYTES);
  if (!parsedBody.ok) return noStoreJson({ error: parsedBody.reason === "too_large" ? "登录确认数据过大。" : "登录确认格式不正确。" }, parsedBody.reason === "too_large" ? 413 : 400);
  const body: { action?: unknown; confirmation?: unknown } = parsedBody.value;
  if (body.action !== "provision-feishu-member"
    || (body.confirmation !== undefined && body.confirmation !== DECLINED_SAME_NAME_CONFIRMATION)) {
    return noStoreJson({ error: "飞书成员开通请求无效。" }, 400);
  }

  const user = await getCurrentUser();
  if (user?.authProvider === FEISHU_PROVIDER && user.memberId) {
    return noStoreJson({ provisioned: true, alreadyProvisioned: true });
  }
  if (user?.authProvider !== FEISHU_PROVIDER || !user.externalSubject) {
    return noStoreJson({ error: "请先使用源灵智能飞书扫码登录。" }, 401);
  }
  const name = feishuMemberName(user.displayName);
  let accountUserId: string;
  let accountEmail: string;
  try {
    [accountUserId, accountEmail] = await Promise.all([
      accountSubjectForFeishu(user.externalSubject),
      accountEmailForFeishu(user.externalSubject),
    ]);
  } catch {
    return noStoreJson({ error: "当前飞书企业身份无效，请重新扫码。" }, 400);
  }

  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(OAUTH_SESSION_COOKIE)?.value || "";
  if (!sessionToken) return noStoreJson({ error: "飞书登录会话已失效，请重新扫码。" }, 401);
  const tokenHash = await hashToken(sessionToken);
  const now = new Date().toISOString();
  const explicitlyDeclinedMatches = body.confirmation === DECLINED_SAME_NAME_CONFIRMATION;

  try {
    const db = await getDb();
    const activeSameNameCandidate = and(
      eq(members.fullName, name),
      eq(members.status, "active"),
      isNotNull(members.accountUserId),
      isNull(members.accountBindingPreviousStatus),
      notExists(db.select({ id: authIdentities.id }).from(authIdentities).where(and(
        eq(authIdentities.memberId, members.id),
        eq(authIdentities.provider, FEISHU_PROVIDER),
        isNull(authIdentities.unlinkedAt),
      ))),
    );
    const [[existingIdentity], [existingMember], sameNameRows] = await Promise.all([
      db.select({ id: authIdentities.id }).from(authIdentities).where(and(
        eq(authIdentities.provider, FEISHU_PROVIDER),
        eq(authIdentities.providerSubject, user.externalSubject),
      )).limit(1),
      db.select({ id: members.id }).from(members).where(or(
        eq(members.accountUserId, accountUserId),
        eq(members.chatgptAccount, accountEmail),
      )).limit(1),
      db.select({ id: members.id }).from(members).where(activeSameNameCandidate).limit(1),
    ]);
    if (existingIdentity || existingMember) return noStoreJson({ error: "当前飞书身份状态已变化，请刷新页面。" }, 409);
    if (sameNameRows.length && !explicitlyDeclinedMatches) {
      return noStoreJson({ error: "找到姓名相同的原 OA 账户，请先核对是否需要绑定。", candidatesAvailable: true }, 409);
    }
    if (!(await consumeWriteRateLimit(db, { actorSubject: user.externalSubject, scope: "feishu_auto_provision", limit: 3, now: new Date(now) }))) {
      return noStoreJson({ error: "登录尝试过于频繁，请稍后重试。" }, 429);
    }

    const activeOAuthSession = and(
      eq(oauthSessions.tokenHash, tokenHash),
      eq(oauthSessions.provider, FEISHU_PROVIDER),
      eq(oauthSessions.providerSubject, user.externalSubject),
      isNull(oauthSessions.memberId),
      isNull(oauthSessions.revokedAt),
      gt(oauthSessions.expiresAt, now),
    );
    const subjectUnused = notExists(db.select({ id: authIdentities.id }).from(authIdentities).where(and(
      eq(authIdentities.provider, FEISHU_PROVIDER),
      eq(authIdentities.providerSubject, user.externalSubject),
    )));
    const memberIdentityUnused = notExists(db.select({ id: members.id }).from(members).where(or(
      eq(members.accountUserId, accountUserId),
      eq(members.chatgptAccount, accountEmail),
    )));
    const noUnconfirmedNameCandidate = explicitlyDeclinedMatches
      ? sql`1 = 1`
      : notExists(db.select({ id: members.id }).from(members).where(activeSameNameCandidate));
    const memberId = crypto.randomUUID();
    const identityId = crypto.randomUUID();
    const mutationRevision = crypto.randomUUID();
    const newMemberExists = exists(db.select({ id: members.id }).from(members).where(and(
      eq(members.id, memberId),
      eq(members.accountUserId, accountUserId),
      eq(members.chatgptAccount, accountEmail),
      eq(members.status, "active"),
      eq(members.mutationRevision, mutationRevision),
    )));
    const newIdentityExists = exists(db.select({ id: authIdentities.id }).from(authIdentities).where(and(
      eq(authIdentities.id, identityId),
      eq(authIdentities.memberId, memberId),
      eq(authIdentities.provider, FEISHU_PROVIDER),
      eq(authIdentities.providerSubject, user.externalSubject),
      isNull(authIdentities.unlinkedAt),
    )));
    const auditNote = explicitlyDeclinedMatches
      ? "源灵智能企业成员扫码验证后，明确确认同名候选均非本人账户，系统以飞书姓名直接开通新内部成员；未提交姓名、学号/工号或额外认证资料。"
      : "源灵智能企业成员扫码验证后未发现同名旧账户，系统以飞书姓名直接开通内部成员；未提交姓名、学号/工号或额外认证资料。";
    const [memberRows, identityRows, eventRows, sessionRows] = await db.batch([
      db.insert(members).select(db.select({
        id: sql<string>`${memberId}`.as("id"),
        fullName: sql<string>`${name}`.as("full_name"),
        identityNumber: sql<string | null>`NULL`.as("identity_number"),
        schoolEmail: sql<string>`''`.as("school_email"),
        chatgptAccount: sql<string>`${accountEmail}`.as("chatgpt_account"),
        accountUserId: sql<string>`${accountUserId}`.as("account_user_id"),
        pendingFullName: sql<string | null>`NULL`.as("pending_full_name"),
        pendingIdentityNumber: sql<string | null>`NULL`.as("pending_identity_number"),
        accountBindingPreviousStatus: sql<string | null>`NULL`.as("account_binding_previous_status"),
        role: sql<string>`'member'`.as("role"),
        permissionsJson: sql<string>`'[]'`.as("permissions_json"),
        departmentCode: sql<string>`''`.as("department_code"),
        status: sql<string>`'active'`.as("status"),
        ndaAcceptedAt: sql<string | null>`NULL`.as("nda_accepted_at"),
        ndaApprovalId: sql<string | null>`NULL`.as("nda_approval_id"),
        ndaAgreementVersion: sql<string | null>`NULL`.as("nda_agreement_version"),
        mutationRevision: sql<string>`${mutationRevision}`.as("mutation_revision"),
        createdAt: sql<string>`${now}`.as("created_at"),
        lastSeenAt: sql<string>`${now}`.as("last_seen_at"),
      }).from(oauthSessions).where(and(activeOAuthSession, subjectUnused, memberIdentityUnused, noUnconfirmedNameCandidate))).returning({ id: members.id }),
      db.insert(authIdentities).select(db.select({
        id: sql<string>`${identityId}`.as("id"),
        memberId: sql<string>`${memberId}`.as("member_id"),
        provider: sql<string>`${FEISHU_PROVIDER}`.as("provider"),
        providerSubject: sql<string>`${user.externalSubject}`.as("provider_subject"),
        loginSnapshot: sql<string>`${user.externalLogin || ""}`.as("login_snapshot"),
        verifiedEmailSnapshot: sql<string>`''`.as("verified_email_snapshot"),
        linkedAt: sql<string>`${now}`.as("linked_at"),
        lastSeenAt: sql<string>`${now}`.as("last_seen_at"),
        unlinkedAt: sql<string | null>`NULL`.as("unlinked_at"),
      }).from(members).where(and(eq(members.id, memberId), newMemberExists, subjectUnused, exists(
        db.select({ tokenHash: oauthSessions.tokenHash }).from(oauthSessions).where(activeOAuthSession),
      )))).returning({ id: authIdentities.id }),
      db.insert(memberEvents).select(db.select({
        id: sql<number>`NULL`.as("id"),
        memberId: sql<string>`${memberId}`.as("member_id"),
        actorName: sql<string>`${name}`.as("actor_name"),
        actorEmail: sql<string>`${accountEmail}`.as("actor_email"),
        action: sql<string>`'feishu_member_auto_provisioned'`.as("action"),
        note: sql<string>`${auditNote}`.as("note"),
        createdAt: sql<string>`${now}`.as("created_at"),
      }).from(members).where(and(eq(members.id, memberId), newMemberExists, newIdentityExists))).returning({ id: memberEvents.id }),
      db.update(oauthSessions).set({ memberId, emailSnapshot: accountEmail, displayNameSnapshot: name, lastSeenAt: now })
        .where(and(activeOAuthSession, newMemberExists, newIdentityExists)).returning({ tokenHash: oauthSessions.tokenHash }),
    ]);
    if (!memberRows[0] || !identityRows[0] || !eventRows[0] || !sessionRows[0]) {
      return noStoreJson({ error: "飞书成员状态刚刚发生变化，请刷新页面。" }, 409);
    }
    return noStoreJson({ provisioned: true, member: { fullName: name } }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/unique constraint/i.test(message)) return noStoreJson({ error: "当前飞书身份刚刚已完成开通，请刷新页面。" }, 409);
    return noStoreJson({ error: "暂时无法开通内部成员，请稍后重试。" }, 500);
  }
}

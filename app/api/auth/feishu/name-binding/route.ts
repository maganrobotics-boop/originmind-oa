import { and, eq, exists, gt, inArray, isNotNull, isNull, notExists, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { getDb } from "../../../../../db";
import { authIdentities, memberEvents, members, oauthSessions } from "../../../../../db/schema";
import { readBoundedJsonObject } from "../../../../../lib/bounded-json-request";
import { FEISHU_PROVIDER, getFeishuOAuthConfig } from "../../../../../lib/feishu-oauth";
import { memberDepartmentLabel } from "../../../../../lib/member-attributes";
import { OAUTH_SESSION_COOKIE } from "../../../../../lib/oauth-session";
import { consumeWriteRateLimit } from "../../../../../lib/write-rate-limit";
import { getCurrentUser, hashToken } from "../../../_lib/auth";

const MAX_REQUEST_BYTES = 1_024;

function noStoreJson(body: object, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "private, no-store, max-age=0" } });
}

function validName(value: string) {
  const name = value.trim();
  return name.length >= 1 && name.length <= 40 && !/[\u0000-\u001f\u007f]/u.test(name) ? name : "";
}

function maskAccount(value: string) {
  const [local, domain] = value.toLowerCase().split("@");
  if (!local || !domain) return "原 OA 账户";
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"*".repeat(Math.max(3, Math.min(6, local.length - visible.length)))}@${domain}`;
}

function sameOriginPost(request: Request, expectedOrigin: string) {
  const fetchSite = request.headers.get("sec-fetch-site");
  return request.headers.get("origin") === expectedOrigin
    && new URL(request.url).origin === expectedOrigin
    && (!fetchSite || fetchSite === "same-origin");
}

async function unboundFeishuUser(noTouch = false) {
  const user = await getCurrentUser({ noTouch });
  if (user?.authProvider !== FEISHU_PROVIDER || user.memberId || !user.externalSubject) return null;
  const displayName = validName(user.displayName);
  return displayName ? { ...user, displayName, externalSubject: user.externalSubject } : null;
}

export async function GET() {
  const user = await unboundFeishuUser(true);
  if (!user) return noStoreJson({ error: "当前飞书登录不需要同名账户绑定。" }, 409);
  try {
    const db = await getDb();
    const rows = await db.select({
      memberId: members.id,
      fullName: members.fullName,
      chatgptAccount: members.chatgptAccount,
      departmentCode: members.departmentCode,
    }).from(members).where(and(
      eq(members.fullName, user.displayName),
      eq(members.status, "active"),
      isNotNull(members.accountUserId),
      isNull(members.accountBindingPreviousStatus),
    )).limit(5);
    if (!rows.length) return noStoreJson({ matchedName: user.displayName, candidates: [] });
    const linkedRows = await db.select({ memberId: authIdentities.memberId }).from(authIdentities).where(and(
      inArray(authIdentities.memberId, rows.map((row) => row.memberId)),
      eq(authIdentities.provider, FEISHU_PROVIDER),
      isNull(authIdentities.unlinkedAt),
    ));
    const linkedMemberIds = new Set(linkedRows.map((row) => row.memberId));
    const candidates = rows.filter((row) => !linkedMemberIds.has(row.memberId)).map((row) => ({
      memberId: row.memberId,
      fullName: row.fullName,
      accountHint: maskAccount(row.chatgptAccount),
      department: memberDepartmentLabel(row.departmentCode) || "未设置部门",
    }));
    return noStoreJson({ matchedName: user.displayName, candidates });
  } catch {
    return noStoreJson({ error: "暂时无法查询同名旧账户，请稍后重试。" }, 500);
  }
}

export async function POST(request: Request) {
  let config;
  try {
    config = getFeishuOAuthConfig();
  } catch {
    return noStoreJson({ error: "飞书登录尚未启用。" }, 503);
  }
  if (!sameOriginPost(request, config.origin)) return noStoreJson({ error: "绑定请求来源无效，请刷新页面重试。" }, 403);
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return noStoreJson({ error: "绑定确认必须使用 JSON 格式提交。" }, 415);
  }
  const parsedBody = await readBoundedJsonObject(request, MAX_REQUEST_BYTES);
  if (!parsedBody.ok) return noStoreJson({ error: parsedBody.reason === "too_large" ? "绑定确认数据过大。" : "绑定确认格式不正确。" }, parsedBody.reason === "too_large" ? 413 : 400);
  const body: { memberId?: unknown; confirmation?: unknown } = parsedBody.value;
  if (typeof body.memberId !== "string" || !/^[0-9a-f-]{36}$/iu.test(body.memberId)
    || body.confirmation !== "confirm-feishu-name-binding") {
    return noStoreJson({ error: "请明确确认要绑定的旧账户。" }, 400);
  }
  const user = await unboundFeishuUser();
  if (!user) return noStoreJson({ error: "当前飞书登录状态已变化，请刷新页面。" }, 409);
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(OAUTH_SESSION_COOKIE)?.value || "";
  if (!sessionToken) return noStoreJson({ error: "飞书登录会话已失效，请重新扫码。" }, 401);
  const tokenHash = await hashToken(sessionToken);
  const now = new Date().toISOString();
  try {
    const db = await getDb();
    if (!(await consumeWriteRateLimit(db, { actorSubject: user.externalSubject, scope: "feishu_name_binding", limit: 5, now: new Date(now) }))) {
      return noStoreJson({ error: "绑定尝试过于频繁，请稍后再试。" }, 429);
    }
    const [candidate] = await db.select({
      id: members.id,
      fullName: members.fullName,
      chatgptAccount: members.chatgptAccount,
      accountUserId: members.accountUserId,
      mutationRevision: members.mutationRevision,
      status: members.status,
    }).from(members).where(eq(members.id, body.memberId)).limit(1);
    if (!candidate || candidate.fullName !== user.displayName || candidate.status !== "active" || !candidate.accountUserId) {
      return noStoreJson({ error: "该旧账户不再符合姓名匹配条件，请刷新页面。" }, 409);
    }
    const activeOAuthSession = and(
      eq(oauthSessions.tokenHash, tokenHash),
      eq(oauthSessions.provider, FEISHU_PROVIDER),
      eq(oauthSessions.providerSubject, user.externalSubject),
      isNull(oauthSessions.memberId),
      isNull(oauthSessions.revokedAt),
      gt(oauthSessions.expiresAt, now),
    );
    const noTargetFeishuIdentity = notExists(db.select({ id: authIdentities.id }).from(authIdentities).where(and(
      eq(authIdentities.memberId, candidate.id),
      eq(authIdentities.provider, FEISHU_PROVIDER),
      isNull(authIdentities.unlinkedAt),
    )));
    const subjectUnused = notExists(db.select({ id: authIdentities.id }).from(authIdentities).where(and(
      eq(authIdentities.provider, FEISHU_PROVIDER),
      eq(authIdentities.providerSubject, user.externalSubject),
    )));
    const candidateGuard = and(
      eq(members.id, candidate.id),
      eq(members.fullName, user.displayName),
      eq(members.status, "active"),
      eq(members.accountUserId, candidate.accountUserId),
      eq(members.mutationRevision, candidate.mutationRevision),
      isNull(members.accountBindingPreviousStatus),
      noTargetFeishuIdentity,
      subjectUnused,
      exists(db.select({ tokenHash: oauthSessions.tokenHash }).from(oauthSessions).where(activeOAuthSession)),
    );
    const identityId = crypto.randomUUID();
    const boundIdentityExists = exists(db.select({ id: authIdentities.id }).from(authIdentities).where(and(
      eq(authIdentities.id, identityId),
      eq(authIdentities.memberId, candidate.id),
      eq(authIdentities.provider, FEISHU_PROVIDER),
      eq(authIdentities.providerSubject, user.externalSubject),
      isNull(authIdentities.unlinkedAt),
    )));
    const [identityRows, eventRows, sessionRows] = await db.batch([
      db.insert(authIdentities).select(db.select({
        id: sql<string>`${identityId}`.as("id"),
        memberId: members.id,
        provider: sql<string>`${FEISHU_PROVIDER}`.as("provider"),
        providerSubject: sql<string>`${user.externalSubject}`.as("provider_subject"),
        loginSnapshot: sql<string>`${user.externalLogin || ""}`.as("login_snapshot"),
        verifiedEmailSnapshot: sql<string>`''`.as("verified_email_snapshot"),
        linkedAt: sql<string>`${now}`.as("linked_at"),
        lastSeenAt: sql<string>`${now}`.as("last_seen_at"),
        unlinkedAt: sql<string | null>`NULL`.as("unlinked_at"),
      }).from(members).where(candidateGuard)).returning({ id: authIdentities.id }),
      db.insert(memberEvents).select(db.select({
        id: sql<number>`NULL`.as("id"),
        memberId: members.id,
        actorName: sql<string>`${user.displayName}`.as("actor_name"),
        actorEmail: sql<string>`${user.email}`.as("actor_email"),
        action: sql<string>`'feishu_identity_name_confirmed'`.as("action"),
        note: sql<string>`'飞书认证用户扫码登录后，系统按飞书姓名展示同名旧账户；本人在页面明确确认后绑定。未按姓名静默合并。'`.as("note"),
        createdAt: sql<string>`${now}`.as("created_at"),
      }).from(members).where(and(eq(members.id, candidate.id), eq(members.mutationRevision, candidate.mutationRevision), boundIdentityExists))).returning({ id: memberEvents.id }),
      db.update(oauthSessions).set({ memberId: candidate.id, emailSnapshot: candidate.chatgptAccount, displayNameSnapshot: candidate.fullName, lastSeenAt: now }).where(and(activeOAuthSession, boundIdentityExists)).returning({ tokenHash: oauthSessions.tokenHash }),
    ]);
    if (!identityRows[0] || !eventRows[0] || !sessionRows[0]) return noStoreJson({ error: "旧账户刚刚已被绑定或状态已变化，请刷新页面。" }, 409);
    return noStoreJson({ bound: true, member: { fullName: candidate.fullName, accountHint: maskAccount(candidate.chatgptAccount) } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/unique constraint/i.test(message)) return noStoreJson({ error: "该飞书身份或旧账户刚刚已完成绑定，请刷新页面。" }, 409);
    return noStoreJson({ error: "暂时无法绑定旧账户，请稍后重试。" }, 500);
  }
}

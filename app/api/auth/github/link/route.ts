import { and, eq, exists, isNull, sql } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { authIdentities, memberEvents, members, oauthSessions } from "../../../../../db/schema";
import { GITHUB_PROVIDER } from "../../../../../lib/github-oauth";
import { getAuthorizedUser, getPlatformUser } from "../../../_lib/auth";

const NO_STORE_HEADERS = { "cache-control": "private, no-store, max-age=0" };

function json(body: object, status = 200) {
  return Response.json(body, { status, headers: NO_STORE_HEADERS });
}

export async function DELETE(request: Request) {
  const requestOrigin = new URL(request.url).origin;
  if (request.headers.get("origin") !== requestOrigin) return json({ error: "解绑请求来源无效，请从 OA 个人设置重新发起。" }, 403);

  const [platformUser, authorized] = await Promise.all([getPlatformUser(), getAuthorizedUser()]);
  if (!platformUser || !authorized?.memberId || !authorized.memberMutationRevision || !authorized.accountUserId || authorized.accountUserId !== platformUser.accountUserId) {
    return json({ error: "请先使用 ChatGPT 登录当前 OA 成员账号，再解绑 GitHub。" }, 403);
  }

  const now = new Date().toISOString();
  const nextMutationRevision = crypto.randomUUID();
  const db = await getDb();
  const memberGuard = and(
    eq(members.id, authorized.memberId),
    eq(members.status, "active"),
    eq(members.accountUserId, authorized.accountUserId),
    eq(members.mutationRevision, authorized.memberMutationRevision),
  );
  const activeMemberExists = exists(db.select({ id: members.id }).from(members).where(memberGuard));
  const tombstoneExists = exists(db.select({ id: authIdentities.id }).from(authIdentities).where(and(
    eq(authIdentities.memberId, authorized.memberId),
    eq(authIdentities.provider, GITHUB_PROVIDER),
    eq(authIdentities.unlinkedAt, now),
  )));
  const nextMemberGuard = and(
    eq(members.id, authorized.memberId),
    eq(members.status, "active"),
    eq(members.accountUserId, authorized.accountUserId),
    eq(members.mutationRevision, nextMutationRevision),
  );
  const [identityRows, memberRows, eventRows] = await db.batch([
    db.update(authIdentities).set({ unlinkedAt: now, lastSeenAt: now }).where(and(
      eq(authIdentities.memberId, authorized.memberId),
      eq(authIdentities.provider, GITHUB_PROVIDER),
      isNull(authIdentities.unlinkedAt),
      activeMemberExists,
    )).returning({ id: authIdentities.id }),
    db.update(members).set({ mutationRevision: nextMutationRevision, lastSeenAt: now }).where(and(
      memberGuard,
      tombstoneExists,
    )).returning({ id: members.id }),
    db.insert(memberEvents).select(db.select({
      id: sql<number>`NULL`.as("id"),
      memberId: members.id,
      actorName: sql<string>`${authorized.user.displayName}`.as("actor_name"),
      actorEmail: sql<string>`${authorized.user.email}`.as("actor_email"),
      action: sql<string>`'github_identity_unlinked'`.as("action"),
      note: sql<string>`'成员本人通过 ChatGPT 认证会话解绑 GitHub 登录；OA 成员、角色、保密协议与审批历史保持不变。'`.as("note"),
      createdAt: sql<string>`${now}`.as("created_at"),
    }).from(members).where(and(nextMemberGuard, tombstoneExists))).returning({ id: memberEvents.id }),
    db.update(oauthSessions).set({ revokedAt: now }).where(and(
      eq(oauthSessions.memberId, authorized.memberId),
      eq(oauthSessions.provider, GITHUB_PROVIDER),
      isNull(oauthSessions.revokedAt),
      tombstoneExists,
    )),
  ]);
  if (!identityRows[0] || !memberRows[0] || !eventRows[0]) return json({ error: "GitHub 尚未绑定，或成员状态刚刚发生变化。" }, 409);
  return json({ ok: true, githubLinked: false });
}

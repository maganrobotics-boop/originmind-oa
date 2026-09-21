import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { getD1Database, getDb } from "../../../db";
import { conversationMembers, conversations, members } from "../../../db/schema";
import { CONVERSATION_REQUEST_BYTES, parseCreateConversationInput } from "../../../lib/conversation-contract.mjs";
import { readBoundedJsonObject } from "../../../lib/bounded-json-request";
import { consumeWriteRateLimit } from "../../../lib/write-rate-limit";
import { getAuthorizedUser, isNdaAdmittedMember } from "../_lib/auth";

const MAX_CONVERSATIONS = 200;
const headers = { "cache-control": "private, no-store, max-age=0", "x-content-type-options": "nosniff" };
const json = (body: unknown, status = 200, extraHeaders?: HeadersInit) => Response.json(body, { status, headers: { ...headers, ...extraHeaders } });
const sameOrigin = (request: Request) => {
  const origin = request.headers.get("origin");
  return (!origin || origin === new URL(request.url).origin) && request.headers.get("sec-fetch-site") !== "cross-site";
};
const isJson = (request: Request) => request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() === "application/json";

async function actor() {
  const authorized = await getAuthorizedUser();
  return authorized?.ndaCompleted && authorized.memberId && authorized.accountUserId && authorized.memberMutationRevision ? authorized : null;
}

export async function GET() {
  const authorized = await actor();
  if (!authorized) return json({ error: "请先完成 OA 准入和保密协议。" }, 403);
  try {
    const rows = await (await getDb()).select({
      id: conversations.id,
      type: conversations.type,
      title: conversations.title,
      projectId: conversations.projectId,
      updatedAt: conversations.updatedAt,
      archivedAt: conversations.archivedAt,
      role: conversationMembers.role,
      lastReadMessageId: conversationMembers.lastReadMessageId,
      lastReadAt: conversationMembers.lastReadAt,
    }).from(conversationMembers)
      .innerJoin(conversations, eq(conversationMembers.conversationId, conversations.id))
      .where(and(eq(conversationMembers.memberId, authorized.memberId!), isNull(conversationMembers.leftAt)))
      .orderBy(desc(conversations.updatedAt), desc(conversations.id))
      .limit(MAX_CONVERSATIONS);
    return json({ conversations: rows, currentMemberId: authorized.memberId });
  } catch {
    return json({ error: "会话列表暂不可用。" }, 503);
  }
}

export async function POST(request: Request) {
  const authorized = await actor();
  if (!authorized) return json({ error: "请先完成 OA 准入和保密协议。" }, 403);
  if (!sameOrigin(request)) return json({ error: "请在 OA 内创建群聊。" }, 403);
  if (!isJson(request)) return json({ error: "请求格式不正确。" }, 415);
  const parsedBody = await readBoundedJsonObject(request, CONVERSATION_REQUEST_BYTES);
  const input = parsedBody.ok ? parseCreateConversationInput(parsedBody.value) : null;
  if (!input) return json({ error: "群聊名称或成员列表不正确。" }, parsedBody.ok ? 400 : parsedBody.reason === "too_large" ? 413 : 400);

  const memberIds = [...new Set([authorized.memberId!, ...input.memberIds])];
  if (memberIds.length < 2 || memberIds.length > 100) return json({ error: "群聊需要至少两位成员，且不能超过 100 人。" }, 400);
  const db = await getDb();
  const memberRows = await db.select({
    id: members.id,
    accountUserId: members.accountUserId,
    chatgptAccount: members.chatgptAccount,
    role: members.role,
    permissionsJson: members.permissionsJson,
    ndaAcceptedAt: members.ndaAcceptedAt,
    ndaAgreementVersion: members.ndaAgreementVersion,
    mutationRevision: members.mutationRevision,
    status: members.status,
  }).from(members).where(inArray(members.id, memberIds));
  if (memberRows.length !== memberIds.length || memberRows.some((member) => member.status !== "active" || !isNdaAdmittedMember(member))) {
    return json({ error: "群聊成员不存在、未完成准入或状态已变化。" }, 409);
  }
  const byId = new Map(memberRows.map((member) => [member.id, member]));
  const creator = byId.get(authorized.memberId!);
  if (!creator || creator.accountUserId !== authorized.accountUserId || creator.mutationRevision !== authorized.memberMutationRevision) {
    return json({ error: "当前成员状态已变化，请刷新后重试。" }, 409);
  }
  if (!(await consumeWriteRateLimit(db, { actorSubject: authorized.accountUserId!, scope: "conversation_create", limit: 10 }))) {
    return json({ error: "创建群聊过于频繁，请稍后再试。" }, 429, { "retry-after": "60" });
  }

  const conversationId = input.clientConversationId || crypto.randomUUID();
  const now = new Date().toISOString();
  const eligibility = memberRows.map(() => "(id=? AND mutation_revision=? AND status='active' AND account_user_id IS NOT NULL AND nda_accepted_at IS NOT NULL AND nda_agreement_version IS NOT NULL)").join(" OR ");
  const eligibilityBindings = memberRows.flatMap((member) => [member.id, member.mutationRevision]);
  const d1 = await getD1Database();
  const statements = [
    d1.prepare(`INSERT INTO conversations(id,type,title,direct_key,project_id,created_by_member_id,created_at,updated_at,archived_at)
      SELECT ?,'group',?,NULL,NULL,?,?,?,NULL
      WHERE (SELECT COUNT(*) FROM members WHERE ${eligibility})=?
        AND EXISTS (SELECT 1 FROM members WHERE id=? AND account_user_id=? AND mutation_revision=? AND status='active')
      RETURNING id,type,title,project_id,created_at,updated_at,archived_at`)
      .bind(conversationId, input.title, authorized.memberId!, now, now, ...eligibilityBindings, memberRows.length, authorized.memberId!, authorized.accountUserId!, authorized.memberMutationRevision!),
    ...memberIds.map((memberId) => d1.prepare(`INSERT INTO conversation_members(id,conversation_id,member_id,role,joined_at,left_at,last_read_message_id,last_read_at,added_by_member_id)
      SELECT ?,id,?,?,?,NULL,NULL,NULL,? FROM conversations WHERE id=?`)
      .bind(crypto.randomUUID(), memberId, memberId === authorized.memberId ? "owner" : "member", now, authorized.memberId!, conversationId)),
    d1.prepare(`INSERT INTO conversation_events(id,conversation_id,actor_member_id,action,subject_member_id,detail_json,created_at)
      SELECT ?,id,?,'created',NULL,?,? FROM conversations WHERE id=?`)
      .bind(crypto.randomUUID(), authorized.memberId!, JSON.stringify({ title: input.title, memberCount: memberIds.length }), now, conversationId),
  ];
  try {
    const results = await d1.batch(statements);
    const created = results[0]?.results?.[0] as Record<string, unknown> | undefined;
    if (!created) return json({ error: "成员状态刚刚发生变化，请刷新后重试。" }, 409);
    return json({ conversation: {
      id: created.id,
      type: created.type,
      title: created.title,
      projectId: created.project_id,
      createdAt: created.created_at,
      updatedAt: created.updated_at,
      archivedAt: created.archived_at,
      role: "owner",
    } }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return /UNIQUE constraint failed|constraint failed/iu.test(message)
      ? json({ error: "该群聊标识已被使用，请刷新后重试。" }, 409)
      : json({ error: "群聊创建失败。" }, 503);
  }
}

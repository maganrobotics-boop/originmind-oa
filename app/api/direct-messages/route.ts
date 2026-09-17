import { DIRECT_MESSAGE_REQUEST_BYTES, parseDirectMessageInput, sameDirectMessage } from "../../../lib/direct-message-contract.mjs";
import { and, asc, desc, eq, gte, max, or, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import { directMessages, members } from "../../../db/schema";
import { authorizedMemberGuard, getAuthorizedUser, getReviewerDirectory, isNdaAdmittedMember, parseMemberPermissions, type MemberPermission } from "../_lib/auth";
import { readBoundedJsonObject } from "../../../lib/bounded-json-request";
import { consumeWriteRateLimit } from "../../../lib/write-rate-limit";

const DEFAULT_MESSAGE_LIMIT = 100;
const MAX_MESSAGE_LIMIT = 100;
const MAX_REQUEST_LENGTH = DIRECT_MESSAGE_REQUEST_BYTES;
const MAX_MESSAGES_PER_MINUTE = 30;

type ConversationSummary = {
  peer: { email: string; name: string; role: string; permissions: MemberPermission[]; isAdmin: boolean };
  latestMessageId: string | null;
  latestCreatedAt: string | null;
  latestIncomingId: string | null;
};

async function findRecipient(email: string) {
  const db = await getDb();
  const [member] = await db.select({ fullName: members.fullName, chatgptAccount: members.chatgptAccount, accountUserId: members.accountUserId, role: members.role, permissionsJson: members.permissionsJson, ndaAcceptedAt: members.ndaAcceptedAt, ndaAgreementVersion: members.ndaAgreementVersion, status: members.status }).from(members).where(eq(members.chatgptAccount, email)).limit(1);
  if (member) return member.status === "active" && isNdaAdmittedMember(member) ? member.fullName : null;
  return (await getReviewerDirectory()).find((reviewer) => reviewer.email === email && reviewer.ndaCompleted && reviewer.permissions.includes("project_owner"))?.displayName || null;
}

function serializeMessage(row: typeof directMessages.$inferSelect) {
  return { id: row.id, senderEmail: row.senderEmail, senderName: row.senderName, recipientEmail: row.recipientEmail, recipientName: row.recipientName, body: row.body, createdAt: row.createdAt };
}

function parseLimit(value: string | null): number | null {
  if (value === null) return DEFAULT_MESSAGE_LIMIT;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= 1 && parsed <= MAX_MESSAGE_LIMIT ? parsed : null;
}

function parseAfter(value: string | null): string | null | undefined {
  if (value === null) return null;
  if (value === "") return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function isJsonRequest(request: Request): boolean {
  return request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

function hasNdaAccess(authorized: NonNullable<Awaited<ReturnType<typeof getAuthorizedUser>>>): boolean {
  return authorized.ndaCompleted;
}

function privateJson(data: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "private, no-store");
  return Response.json(data, { ...init, headers });
}

async function parseMessageRequest(request: Request) {
  const parsed = await readBoundedJsonObject(request, MAX_REQUEST_LENGTH);
  return parsed.ok ? parseDirectMessageInput(parsed.value) : null;
}

async function getConversationSummaries(email: string): Promise<ConversationSummary[]> {
  const db = await getDb();
  const peerEmail = sql<string>`lower(CASE WHEN ${directMessages.senderEmail} = ${email} THEN ${directMessages.recipientEmail} ELSE ${directMessages.senderEmail} END)`;
  const messageOrderKey = sql<string>`${directMessages.createdAt} || '|' || ${directMessages.id}`;
  const incomingOrderKey = sql<string>`CASE WHEN ${directMessages.recipientEmail} = ${email} THEN ${directMessages.createdAt} || '|' || ${directMessages.id} ELSE NULL END`;
  const [rows, memberRows, reviewerRows] = await Promise.all([
    db
      .select({
        peerEmail: peerEmail.as("peer_email"),
        latestKey: max(messageOrderKey).as("latest_key"),
        latestIncomingKey: max(incomingOrderKey).as("latest_incoming_key"),
      })
      .from(directMessages)
      .where(or(eq(directMessages.senderEmail, email), eq(directMessages.recipientEmail, email)))
      .groupBy(peerEmail),
    db
      .select({
        fullName: members.fullName,
        chatgptAccount: members.chatgptAccount,
        accountUserId: members.accountUserId,
        role: members.role,
        permissionsJson: members.permissionsJson,
        ndaAcceptedAt: members.ndaAcceptedAt,
        ndaAgreementVersion: members.ndaAgreementVersion,
        status: members.status,
      })
      .from(members),
    getReviewerDirectory(),
  ]);

  const eligibleReviewers = new Map(reviewerRows.filter((reviewer) => reviewer.ndaCompleted).map((reviewer) => [reviewer.email, reviewer]));
  const configuredOwners = new Map(reviewerRows.filter((reviewer) => reviewer.ndaCompleted && reviewer.permissions.includes("project_owner")).map((owner) => [owner.email, { email: owner.email, displayName: owner.displayName, isAdmin: owner.isAdmin }]));
  const knownMembers = new Map(memberRows.map((member) => [member.chatgptAccount.trim().toLowerCase(), member]));
  const summaries = new Map<string, ConversationSummary>();
  for (const member of memberRows) {
    const memberEmail = member.chatgptAccount.trim().toLowerCase();
    if (member.status !== "active" || (!isNdaAdmittedMember(member) && !eligibleReviewers.has(memberEmail))) continue;
    const peerEmail = member.chatgptAccount.trim().toLowerCase();
    if (!peerEmail || peerEmail === email) continue;
    const permissions = new Set([...parseMemberPermissions(member.role, member.permissionsJson), ...(eligibleReviewers.get(peerEmail)?.permissions ?? [])]);
    const normalizedPermissions = Array.from(permissions);
    summaries.set(peerEmail, {
      peer: {
        email: peerEmail,
        name: member.fullName,
        role: normalizedPermissions.includes("project_owner") ? "project_owner" : normalizedPermissions.includes("technical_advisor") ? "technical_advisor" : "member",
        permissions: normalizedPermissions,
        isAdmin: eligibleReviewers.get(peerEmail)?.isAdmin === true,
      },
      latestMessageId: null,
      latestCreatedAt: null,
      latestIncomingId: null,
    });
  }
  for (const owner of configuredOwners.values()) {
    const knownMember = knownMembers.get(owner.email);
    if (knownMember && knownMember.status !== "active") continue;
    if (owner.email === email || summaries.has(owner.email)) continue;
    summaries.set(owner.email, {
      peer: { email: owner.email, name: owner.displayName, role: "project_owner", permissions: ["technical_advisor", "project_owner"], isAdmin: owner.isAdmin },
      latestMessageId: null,
      latestCreatedAt: null,
      latestIncomingId: null,
    });
  }

  const parseOrderKey = (value: string | null) => {
    const separator = value?.lastIndexOf("|") ?? -1;
    return separator > 0 && value ? { createdAt: value.slice(0, separator), id: value.slice(separator + 1) } : null;
  };
  for (const row of rows) {
    const existing = summaries.get(row.peerEmail);
    if (!existing) continue;
    const latest = parseOrderKey(row.latestKey);
    const latestIncoming = parseOrderKey(row.latestIncomingKey);
    summaries.set(row.peerEmail, {
      peer: existing.peer,
      latestMessageId: latest?.id ?? null,
      latestCreatedAt: latest?.createdAt ?? null,
      latestIncomingId: latestIncoming?.id ?? null,
    });
  }

  return Array.from(summaries.values()).sort((left, right) => {
    if (left.latestCreatedAt && right.latestCreatedAt) return right.latestCreatedAt.localeCompare(left.latestCreatedAt) || (right.latestMessageId ?? "").localeCompare(left.latestMessageId ?? "");
    if (left.latestCreatedAt) return -1;
    if (right.latestCreatedAt) return 1;
    return left.peer.name.localeCompare(right.peer.name, "zh-CN");
  });
}

export async function GET(request: Request) {
  const authorized = await getAuthorizedUser();
  if (!authorized) return privateJson({ error: "请先完成成员注册。" }, { status: 401 });
  if (!hasNdaAccess(authorized)) return privateJson({ error: "请先完成保密协议签署与归档。" }, { status: 403 });

  const searchParams = new URL(request.url).searchParams;
  const peerEmail = searchParams.get("with")?.trim().toLowerCase() || "";
  if (searchParams.get("summary") === "1" || !peerEmail) {
    try {
      return privateJson({ conversations: await getConversationSummaries(authorized.user.email.trim().toLowerCase()) });
    } catch {
      return privateJson({ error: "私聊服务暂不可用。" }, { status: 500 });
    }
  }

  const limit = parseLimit(searchParams.get("limit"));
  const after = parseAfter(searchParams.get("after"));
  if (limit === null || after === undefined) return privateJson({ error: "消息查询参数不正确。" }, { status: 400 });

  try {
    const peerName = await findRecipient(peerEmail);
    if (!peerName) return privateJson({ error: "该成员不存在或尚未通过审核。" }, { status: 404 });

    const email = authorized.user.email.trim().toLowerCase();
    const conversation = or(
      and(eq(directMessages.senderEmail, email), eq(directMessages.recipientEmail, peerEmail)),
      and(eq(directMessages.senderEmail, peerEmail), eq(directMessages.recipientEmail, email)),
    );
    const db = await getDb();
    const rows = after
      ? await db.select().from(directMessages).where(and(conversation, gte(directMessages.createdAt, after))).orderBy(asc(directMessages.createdAt), asc(directMessages.id)).limit(limit)
      : (await db.select().from(directMessages).where(conversation).orderBy(desc(directMessages.createdAt), desc(directMessages.id)).limit(limit)).reverse();
    return privateJson({ messages: rows.map(serializeMessage), peer: { email: peerEmail, name: peerName } });
  } catch {
    return privateJson({ error: "私聊服务暂不可用。" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const authorized = await getAuthorizedUser();
  if (!authorized) return privateJson({ error: "请先完成成员注册。" }, { status: 401 });
  if (!hasNdaAccess(authorized)) return privateJson({ error: "请先完成保密协议签署与归档。" }, { status: 403 });
  const origin = request.headers.get("origin");
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") return privateJson({ error: "请在 OA 内发送私聊。" }, { status: 403 });
  if (!isJsonRequest(request)) return privateJson({ error: "请求格式不正确。" }, { status: 415 });

  const parsed = await parseMessageRequest(request);
  if (!parsed) return privateJson({ error: "请输入 1–16000 字的私聊内容；发送者由当前登录身份确定。" }, { status: 400 });

  const senderEmail = authorized.user.email.trim().toLowerCase();
  if (parsed.recipientEmail === senderEmail) return privateJson({ error: "不能给自己发送私聊消息。" }, { status: 400 });

  try {
    const recipientName = await findRecipient(parsed.recipientEmail);
    if (!recipientName) return privateJson({ error: "该成员不存在或尚未通过审核。" }, { status: 404 });

    const db = await getDb();
    if (!(await consumeWriteRateLimit(db, { actorSubject: authorized.accountUserId || "", scope: "direct_message", limit: MAX_MESSAGES_PER_MINUTE }))) {
      return privateJson({ error: "发送过于频繁，请稍后再试。" }, { status: 429, headers: { "Retry-After": "60" } });
    }

    const now = new Date().toISOString();
    const messageId = parsed.clientMessageId || crypto.randomUUID();
    const findExisting = async () => (await db.select().from(directMessages).where(eq(directMessages.id, messageId)).limit(1))[0];
    if (parsed.clientMessageId) {
      const existing = await findExisting();
      if (existing) return sameDirectMessage(existing, senderEmail, parsed.recipientEmail, parsed.messageBody)
        ? privateJson({ message: serializeMessage(existing) })
        : privateJson({ error: "消息标识已被使用，请重新确认发送内容。" }, { status: 409 });
    }
    const [created] = await db.insert(directMessages).select(db.select({
      id: sql<string>`${messageId}`.as("id"),
      senderEmail: sql<string>`${senderEmail}`.as("sender_email"),
      senderName: sql<string>`${authorized.user.displayName}`.as("sender_name"),
      recipientEmail: sql<string>`${parsed.recipientEmail}`.as("recipient_email"),
      recipientName: sql<string>`${recipientName}`.as("recipient_name"),
      body: sql<string>`${parsed.messageBody}`.as("body"),
      createdAt: sql<string>`${now}`.as("created_at"),
    }).from(sql`(SELECT 1) AS authorization_source`).where(authorizedMemberGuard(authorized))).onConflictDoNothing().returning();
    if (!created) {
      const existing = parsed.clientMessageId ? await findExisting() : null;
      if (sameDirectMessage(existing, senderEmail, parsed.recipientEmail, parsed.messageBody)) return privateJson({ message: serializeMessage(existing!) });
      return privateJson({ error: "成员状态、权限或消息标识刚刚发生变化，请刷新核对后重试。" }, { status: 409 });
    }
    return privateJson({ message: serializeMessage(created) }, { status: 201 });
  } catch {
    return privateJson({ error: "私聊消息发送失败。" }, { status: 500 });
  }
}

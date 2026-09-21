import { getD1Database, getDb } from "../../../../../db";
import { CONVERSATION_MESSAGE_MAX_LENGTH, CONVERSATION_REQUEST_BYTES, CONVERSATION_UUID, parseConversationMessageInput } from "../../../../../lib/conversation-contract.mjs";
import { readBoundedJsonObject } from "../../../../../lib/bounded-json-request";
import { consumeWriteRateLimit } from "../../../../../lib/write-rate-limit";
import { getAuthorizedUser } from "../../../_lib/auth";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;
const headers = { "cache-control": "private, no-store, max-age=0", "x-content-type-options": "nosniff" };
const json = (body: unknown, status = 200, extraHeaders?: HeadersInit) => Response.json(body, { status, headers: { ...headers, ...extraHeaders } });
const sameOrigin = (request: Request) => {
  const origin = request.headers.get("origin");
  return (!origin || origin === new URL(request.url).origin) && request.headers.get("sec-fetch-site") !== "cross-site";
};
const isJson = (request: Request) => request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() === "application/json";

type MessageRow = {
  id: string;
  conversation_id: string;
  sender_member_id: string;
  sender_name: string;
  body: string;
  message_type: string;
  reply_to_message_id: string | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
};

const serialize = (row: MessageRow) => ({
  id: row.id,
  conversationId: row.conversation_id,
  senderMemberId: row.sender_member_id,
  senderName: row.sender_name,
  body: row.body,
  messageType: row.message_type,
  replyToMessageId: row.reply_to_message_id,
  createdAt: row.created_at,
  editedAt: row.edited_at,
  deletedAt: row.deleted_at,
});

function limit(value: string | null) {
  if (value === null) return DEFAULT_LIMIT;
  if (!/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return parsed >= 1 && parsed <= MAX_LIMIT ? parsed : null;
}

function after(value: string | null): string | null | undefined {
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/iu.test(value)) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

async function actor() {
  const authorized = await getAuthorizedUser();
  return authorized?.ndaCompleted && authorized.memberId && authorized.accountUserId && authorized.memberMutationRevision ? authorized : null;
}

async function conversationId(params: Promise<{ id: string }>) {
  const id = (await params).id.toLowerCase();
  return CONVERSATION_UUID.test(id) ? id : null;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authorized = await actor();
  if (!authorized) return json({ error: "请先完成 OA 准入和保密协议。" }, 403);
  const id = await conversationId(params);
  const pageLimit = limit(new URL(request.url).searchParams.get("limit"));
  const pageAfter = after(new URL(request.url).searchParams.get("after"));
  if (!id || pageLimit === null || pageAfter === undefined) return json({ error: "消息查询参数不正确。" }, 400);
  const d1 = await getD1Database();
  try {
    const query = pageAfter
      ? d1.prepare(`SELECT m.* FROM conversation_messages m
          JOIN conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.member_id=? AND cm.left_at IS NULL
          WHERE m.conversation_id=? AND m.created_at>=? ORDER BY m.created_at ASC,m.id ASC LIMIT ?`)
        .bind(authorized.memberId!, id, pageAfter, pageLimit)
      : d1.prepare(`SELECT * FROM (SELECT m.* FROM conversation_messages m
          JOIN conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.member_id=? AND cm.left_at IS NULL
          WHERE m.conversation_id=? ORDER BY m.created_at DESC,m.id DESC LIMIT ?) ORDER BY created_at ASC,id ASC`)
        .bind(authorized.memberId!, id, pageLimit);
    const result = await query.all<MessageRow>();
    return json({ messages: result.results.map(serialize), currentMemberId: authorized.memberId });
  } catch {
    return json({ error: "会话消息暂不可用。" }, 503);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authorized = await actor();
  if (!authorized) return json({ error: "请先完成 OA 准入和保密协议。" }, 403);
  const id = await conversationId(params);
  if (!id) return json({ error: "会话标识不正确。" }, 400);
  if (!sameOrigin(request)) return json({ error: "请在 OA 内发送消息。" }, 403);
  if (!isJson(request)) return json({ error: "请求格式不正确。" }, 415);
  const parsedBody = await readBoundedJsonObject(request, CONVERSATION_REQUEST_BYTES);
  const input = parsedBody.ok ? parseConversationMessageInput(parsedBody.value) : null;
  if (!input) return json({ error: `请输入 1–${CONVERSATION_MESSAGE_MAX_LENGTH} 字的消息。` }, parsedBody.ok ? 400 : parsedBody.reason === "too_large" ? 413 : 400);

  const db = await getDb();
  if (!(await consumeWriteRateLimit(db, { actorSubject: authorized.accountUserId!, scope: "conversation_message", limit: 30 }))) {
    return json({ error: "发送过于频繁，请稍后再试。" }, 429, { "retry-after": "60" });
  }
  const d1 = await getD1Database();
  const messageId = input.clientMessageId || crypto.randomUUID();
  const now = new Date().toISOString();
  const existing = async () => d1.prepare(`SELECT m.* FROM conversation_messages m
      JOIN conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.member_id=? AND cm.left_at IS NULL
      WHERE m.id=? LIMIT 1`).bind(authorized.memberId!, messageId).first<MessageRow>();
  if (input.clientMessageId) {
    const row = await existing();
    if (row) return row.conversation_id === id && row.sender_member_id === authorized.memberId && row.body === input.body
      ? json({ message: serialize(row) })
      : json({ error: "消息标识已被使用，请重新确认发送内容。" }, 409);
  }
  try {
    const [insertResult] = await d1.batch([
      d1.prepare(`INSERT INTO conversation_messages(id,conversation_id,sender_member_id,sender_name,body,message_type,reply_to_message_id,created_at,edited_at,deleted_at)
        SELECT ?,c.id,?,?,?,'text',NULL,?,NULL,NULL
        FROM conversations c
        JOIN conversation_members cm ON cm.conversation_id=c.id AND cm.member_id=? AND cm.left_at IS NULL
        JOIN members m ON m.id=cm.member_id
        WHERE c.id=? AND c.archived_at IS NULL AND m.status='active' AND m.account_user_id=? AND m.mutation_revision=?
        ON CONFLICT DO NOTHING
        RETURNING id,conversation_id,sender_member_id,sender_name,body,message_type,reply_to_message_id,created_at,edited_at,deleted_at`)
        .bind(messageId, authorized.memberId!, authorized.user.displayName, input.body, now, authorized.memberId!, id, authorized.accountUserId!, authorized.memberMutationRevision!),
      d1.prepare(`UPDATE conversations SET updated_at=? WHERE id=? AND EXISTS (
        SELECT 1 FROM conversation_messages WHERE id=? AND conversation_id=conversations.id
      )`).bind(now, id, messageId),
    ]);
    const created = insertResult.results?.[0] as MessageRow | undefined;
    if (created) return json({ message: serialize(created) }, 201);
    const row = await existing();
    if (row && row.conversation_id === id && row.sender_member_id === authorized.memberId && row.body === input.body) return json({ message: serialize(row) });
    return json({ error: "会话成员资格或账号状态已变化，请刷新后重试。" }, 409);
  } catch {
    return json({ error: "消息发送失败。" }, 503);
  }
}

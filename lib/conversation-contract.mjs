export const CONVERSATION_TITLE_MAX_LENGTH = 120;
export const CONVERSATION_MEMBER_LIMIT = 100;
export const CONVERSATION_MESSAGE_MAX_LENGTH = 16000;
export const CONVERSATION_REQUEST_BYTES = 120000;
export const CONVERSATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MEMBER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const DISALLOWED_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

function safeText(value, maximum) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= maximum && text.isWellFormed() && !DISALLOWED_TEXT.test(text) ? text : null;
}

export function parseCreateConversationInput(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)
    || Object.keys(record).some((key) => !["type", "title", "memberIds", "clientConversationId"].includes(key))) return null;
  if (record.type !== "group" || !Array.isArray(record.memberIds) || record.memberIds.length < 1 || record.memberIds.length > CONVERSATION_MEMBER_LIMIT - 1) return null;
  const title = safeText(record.title, CONVERSATION_TITLE_MAX_LENGTH);
  if (!title) return null;
  const memberIds = [...new Set(record.memberIds)];
  if (memberIds.length !== record.memberIds.length || memberIds.some((id) => typeof id !== "string" || !MEMBER_ID.test(id))) return null;
  if (record.clientConversationId !== undefined
    && (typeof record.clientConversationId !== "string" || !CONVERSATION_UUID.test(record.clientConversationId))) return null;
  return { type: "group", title, memberIds, clientConversationId: record.clientConversationId?.toLowerCase() };
}

export function parseConversationMessageInput(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)
    || Object.keys(record).some((key) => !["body", "clientMessageId"].includes(key))) return null;
  const body = safeText(record.body, CONVERSATION_MESSAGE_MAX_LENGTH);
  if (!body) return null;
  if (record.clientMessageId !== undefined
    && (typeof record.clientMessageId !== "string" || !CONVERSATION_UUID.test(record.clientMessageId))) return null;
  return { body, clientMessageId: record.clientMessageId?.toLowerCase() };
}

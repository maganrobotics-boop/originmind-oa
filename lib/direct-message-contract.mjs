/** Shared bounds for full-text forwarding. No sender identity is accepted. */
export const DIRECT_MESSAGE_MAX_LENGTH = 16000;
export const DIRECT_MESSAGE_REQUEST_BYTES = 100000;
export const DIRECT_MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export function parseDirectMessageInput(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).some(key => !['recipientEmail', 'body', 'clientMessageId'].includes(key))) return null;
  if (typeof record.recipientEmail !== 'string' || typeof record.body !== 'string') return null;
  const recipientEmail = record.recipientEmail.trim().toLowerCase();
  const messageBody = record.body.trim();
  if (!recipientEmail || recipientEmail.length > 254 || !/^[^\s@]+@[^\s@]+$/u.test(recipientEmail) || !messageBody || messageBody.length > DIRECT_MESSAGE_MAX_LENGTH || !messageBody.isWellFormed() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(messageBody)) return null;
  if (record.clientMessageId !== undefined && (typeof record.clientMessageId !== 'string' || !DIRECT_MESSAGE_ID.test(record.clientMessageId))) return null;
  return { recipientEmail, messageBody, clientMessageId: record.clientMessageId?.toLowerCase() };
}
export function sameDirectMessage(row, senderEmail, recipientEmail, body) {
  return Boolean(row && row.senderEmail === senderEmail && row.recipientEmail === recipientEmail && row.body === body);
}

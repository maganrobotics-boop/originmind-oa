import { DIRECT_MESSAGE_MAX_LENGTH } from './direct-message-contract.mjs';

export type ConversationPeer = { email: string; name: string };
export type MemberMessage = {
  id: string; senderEmail: string; senderName: string; recipientEmail: string;
  recipientName: string; body: string; createdAt: string;
};
export type MessageEnvelope = { recipientEmail: string; body: string; clientMessageId: string };
export function messageEnvelope(recipientEmail: string, body: string): MessageEnvelope {
  const content = body.trim();
  if (!content || content.length > DIRECT_MESSAGE_MAX_LENGTH) throw new Error(`消息需为 1–${DIRECT_MESSAGE_MAX_LENGTH} 个字符，不能截断发送。`);
  return { recipientEmail: recipientEmail.toLowerCase(), body: content, clientMessageId: crypto.randomUUID() };
}
export async function sendMemberMessage(envelope: MessageEnvelope): Promise<MemberMessage> {
  const response = await fetch('/api/direct-messages', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(envelope), signal: AbortSignal.timeout(30000),
  });
  const data = await response.json() as { message?: MemberMessage; error?: string };
  if (!response.ok || !data.message?.id) throw new Error(data.error || '未能确认发送结果，请重试原内容；相同消息不会重复发送。');
  if (data.message.recipientEmail !== envelope.recipientEmail || data.message.body !== envelope.body) throw new Error('服务器返回的消息与本次发送不一致，请刷新核对。');
  return data.message;
}
export function mergeMemberMessages(current: MemberMessage[], incoming: MemberMessage[]): MemberMessage[] {
  const byId = new Map(current.map(item => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

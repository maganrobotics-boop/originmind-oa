"use client";
/* Explicit UI clear commands and remote message snapshots update local display state. */
/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUp, Forward, RefreshCw } from 'lucide-react';
import { renderAnswerBody } from '@/lib/oa-chat-renderer.mjs';
import { DIRECT_MESSAGE_MAX_LENGTH } from '@/lib/direct-message-contract.mjs';
import { mergeMemberMessages, messageEnvelope, sendMemberMessage, type ConversationPeer, type MemberMessage, type MessageEnvelope } from '@/lib/oa-direct-message-client';
import { useOaConversation } from './oa-conversation-context';

function MemberBody({ body }: { body: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    // Message bodies are data; only the existing DOM-safe renderer creates markup.
    element.replaceChildren(renderAnswerBody(body));
    return () => element.replaceChildren();
  }, [body]);
  return <div className="oa-member-message-body" ref={host} />;
}

export function OaMemberChat({ peer }: { peer: ConversationPeer }) {
  const chat = useOaConversation();
  const [messages, setMessages] = useState<MemberMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const alive = useRef(true);
  const lock = useRef(false);
  const packet = useRef<MessageEnvelope | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const nearEnd = useRef(true);
  const [hiddenIds, setHiddenIds] = useState(new Set<string>());
  const lastClear = useRef(chat.dmClearEpoch);
  const body = chat.drafts[peer.email] || '';
  const ownEmail = chat.user.email.toLowerCase();

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!chat.visible) return;
    let disposed = false; let loadingRequest = false;
    const controller = new AbortController();
    const load = async () => {
      if (loadingRequest || document.visibilityState === 'hidden') return;
      loadingRequest = true;
      try {
        const response = await fetch(`/api/direct-messages?with=${encodeURIComponent(peer.email)}&limit=100`, { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) });
        const data = await response.json() as { messages?: MemberMessage[]; error?: string };
        if (!response.ok || !Array.isArray(data.messages)) throw new Error(data.error || '私聊记录暂不可用。');
        const valid = data.messages.every(item => (item.senderEmail === ownEmail && item.recipientEmail === peer.email) || (item.senderEmail === peer.email && item.recipientEmail === ownEmail));
        if (!valid) throw new Error('会话记录与当前聊天对象不一致。');
        if (!disposed) setMessages(current => mergeMemberMessages(current, data.messages!));
      } catch (cause) { if (!disposed) setError(cause instanceof Error ? cause.message : '私聊记录暂不可用。'); }
      finally { loadingRequest = false; if (!disposed) setLoading(false); }
    };
    void load();
    const timer = window.setInterval(load, 5000);
    document.addEventListener('visibilitychange', load);
    return () => { disposed = true; controller.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', load); };
  }, [chat.visible, chat.messageEpoch, peer.email, ownEmail, reload]);
  useEffect(() => {
    if (nearEnd.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages, sending]);
  // Hide only already displayed messages in this mounted window. Never delete a
  // shared conversation or hide a later reply from the other participant.
  useEffect(() => {
    if (lastClear.current === chat.dmClearEpoch) return;
    lastClear.current = chat.dmClearEpoch;
    setHiddenIds(new Set(messages.map(message => message.id)));
  }, [chat.dmClearEpoch, messages]);
  const send = async (event: FormEvent) => {
    event.preventDefault();
    const text = body.trim();
    if (!text || lock.current) return;
    if (text.length > DIRECT_MESSAGE_MAX_LENGTH) { setError('消息过长，请分成两条发送；不会自动截断。'); return; }
    lock.current = true; setSending(true); setError(''); nearEnd.current = true;
    try {
      if (!packet.current || packet.current.body !== text) packet.current = messageEnvelope(peer.email, text);
      const message = await sendMemberMessage(packet.current);
      if (alive.current) { setMessages(current => mergeMemberMessages(current, [message])); chat.setMemberDraft(peer.email, ''); packet.current = null; }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '未能确认发送结果，重试原内容不会重复发送。'); }
    finally { lock.current = false; if (alive.current) setSending(false); }
  };
  const shown = messages.filter(message => !hiddenIds.has(message.id));
  return <section className="oa-shared-chat oa-member-chat" aria-label={`与${peer.name}的私聊`}><div className="chat-app oa-chat-surface">
    <div className="messages oa-chat-messages" ref={scroll} onScroll={() => { const element = scroll.current; if (element) nearEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96; }}>
      {loading && <p role="status">正在加载私聊记录…</p>}
      {!loading && !shown.length && <div className="empty-hero"><h2>{peer.name}</h2><p>这里是你与该成员的直接聊天，消息不会交给 AI 回答。</p></div>}
      {shown.map(message => <article key={message.id} data-message-id={message.id} className={`oa-direct-message ${message.senderEmail === ownEmail ? 'outgoing' : 'incoming'}`}>
        <div className="oa-direct-message-meta"><strong>{message.senderEmail === ownEmail ? chat.user.displayName : message.senderName}</strong><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></div>
        <MemberBody body={message.body} />
        <button type="button" className="oa-direct-forward" aria-label="转发这条消息" onClick={() => chat.forward({ body: message.body })}><Forward size={14} />转发</button>
      </article>)}
    </div>
    <div className="composer-area oa-chat-composer-area">
      {error && <div className="oa-chat-error" role="alert">{error}<button type="button" onClick={() => { setError(''); setReload(value => value + 1); }}><RefreshCw size={14} />刷新记录</button></div>}
      <form className="composer oa-chat-composer" onSubmit={event => void send(event)}>
        <label className="sr-only" htmlFor="oa-member-message">发送给{peer.name}</label>
        <textarea id="oa-member-message" value={body} disabled={sending} rows={1} maxLength={DIRECT_MESSAGE_MAX_LENGTH} placeholder={`发送消息给${peer.name}`} onChange={event => chat.setMemberDraft(peer.email, event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
        <button type="submit" className="send-button" disabled={sending || !body.trim()} aria-label={`发送给${peer.name}`}><ArrowUp size={24} /></button>
      </form>
      <p className="oa-direct-sender-note">以{chat.user.displayName}的身份发送 · {sending ? '正在发送…' : '对方可直接回复'}</p>
    </div>
  </div></section>;
}

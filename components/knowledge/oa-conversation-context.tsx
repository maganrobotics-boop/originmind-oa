"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Bot, Check, MessageCircle, MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { DIRECT_MESSAGE_MAX_LENGTH } from '@/lib/direct-message-contract.mjs';
import { messageEnvelope, sendMemberMessage, type ConversationPeer, type MessageEnvelope } from '@/lib/oa-direct-message-client';
import type { ChatOutcome } from '@/lib/oa-chat-health.mjs';
import './oa-conversations.css';

type ForwardContent = { body: string; omittedImages?: number };
type CurrentUser = { email: string; displayName: string };
type ContextValue = {
  user: CurrentUser; peer: ConversationPeer | null; visible: boolean;
  aiEpoch: number; aiDirty: boolean; setAiDirty: (dirty: boolean) => void; dmClearEpoch: number; messageEpoch: number;
  lastAnswer: ForwardContent | null; setLastAnswer: (answer: ForwardContent | null) => void;
  drafts: Record<string, string>; setMemberDraft: (email: string, body: string) => void;
  showAi: () => void; newAi: () => void; clearCurrent: () => boolean;
  selectMember: (peer: ConversationPeer) => void; forward: (content: ForwardContent) => void;
  outcome: ChatOutcome; setOutcome: (outcome: ChatOutcome) => void;
};
const Context = createContext<ContextValue | null>(null);
export function useOaConversation() {
  const value = useContext(Context);
  if (!value) throw new Error('OA conversation controls require the authenticated workspace provider');
  return value;
}

export function OaConversationProvider({ currentUser, visible, onOpenChat, children }: { currentUser?: CurrentUser; visible: boolean; onOpenChat: () => void; children: ReactNode }) {
  const user = currentUser || { email: '', displayName: '成员' };
  const [peer, setPeer] = useState<ConversationPeer | null>(null);
  const [outcome, setOutcome] = useState<ChatOutcome>({ state: 'idle', at: 0 });
  const [aiEpoch, setAiEpoch] = useState(0);
  const [aiDirty, setAiDirty] = useState(false);
  const [dmClearEpoch, setDmClearEpoch] = useState(0);
  const [messageEpoch, setMessageEpoch] = useState(0);
  const [lastAnswer, setLastAnswer] = useState<ForwardContent | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [picker, setPicker] = useState<{ content: ForwardContent | null } | null>(null);
  const showAi = () => { setPeer(null); onOpenChat(); };
  const resetAi = () => { setAiEpoch(value => value + 1); setLastAnswer(null); setAiDirty(false); setOutcome({ state: 'idle', at: 0 }); setPeer(null); onOpenChat(); };
  const newAi = () => { if (window.confirm('开始新的 AI 聊天？仅清除当前 AI 对话，不删除资料、审批或真人消息。')) resetAi(); };
  const clearCurrent = () => {
    if (peer) {
      if (window.confirm(`清空与${peer.name}聊天的本页显示？不会删除双方消息记录，重新打开仍可查看。`)) { setDmClearEpoch(value => value + 1); return true; }
    } else if (window.confirm('清空当前 AI 聊天？不会删除资料、审批或真人消息。')) { resetAi(); return true; }
    return false;
  };
  return <Context.Provider value={{
    user, peer, visible, aiEpoch, aiDirty, setAiDirty, dmClearEpoch, messageEpoch, lastAnswer, setLastAnswer, drafts,
    setMemberDraft: (email, body) => setDrafts(current => ({ ...current, [email]: body })),
    showAi, newAi, clearCurrent, selectMember: selected => { setPeer(selected); onOpenChat(); }, forward: content => setPicker({ content }), outcome, setOutcome,
  }}>
    {children}
    {picker && <MemberPicker key={picker.content ? 'forward' : 'chat'} content={picker.content} user={user} onClose={() => setPicker(null)} onSelect={selected => { setPeer(selected); setPicker(null); onOpenChat(); }} onSent={selected => { setPeer(selected); setMessageEpoch(value => value + 1); setPicker(null); onOpenChat(); }} />}
  </Context.Provider>;
}

export function OaConversationTitle({ children }: { children: ReactNode }) {
  const { peer } = useOaConversation();
  return peer ? <div className="oa-chat-title oa-member-title"><strong>{peer.name}</strong><small>成员私聊</small></div> : children;
}
export function OaConversationMenu() {
  const chat = useOaConversation();
  const [open, setOpen] = useState(false);
  const [peers, setPeers] = useState<ConversationPeer[]>([]);
  const [loading, setLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState('');
  const [directoryEpoch, setDirectoryEpoch] = useState(0);
  const resetDirectory = () => { setLoading(true); setDirectoryError(''); setPeers([]); };
  const changeOpen = (value: boolean) => { if (value) resetDirectory(); setOpen(value); };
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let active = true;
    void (async () => {
      try {
        const response = await fetch('/api/direct-messages?summary=1', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
        const data: unknown = await response.json();
        if (!response.ok || !data || typeof data !== 'object' || !('conversations' in data) || !Array.isArray(data.conversations)) throw new Error('成员列表暂不可用');
        const unique = new Map<string, ConversationPeer>();
        for (const row of data.conversations) {
          const person = row?.peer;
          if (person && typeof person.email === 'string' && typeof person.name === 'string' && person.email.trim() && person.name.trim() && person.email.toLowerCase() !== chat.user.email.toLowerCase()) unique.set(person.email.toLowerCase(), { email: person.email, name: person.name });
        }
        if (active) setPeers([...unique.values()]);
      } catch { if (active && !controller.signal.aborted) setDirectoryError('成员列表暂不可用'); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; controller.abort(); };
  }, [open, chat.user.email, directoryEpoch]);
  const focusComposer = useRef(false);
  const pendingNavigation = useRef<(() => void) | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [navigationPending, setNavigationPending] = useState(false);
  const afterMenuCloses = (action: () => void) => { pendingNavigation.current = action; setNavigationPending(true); };
  return <DropdownMenu modal={false} open={open} onOpenChange={changeOpen}><DropdownMenuTrigger asChild><button ref={trigger} disabled={navigationPending} type="button" className="oa-conversation-menu oa-chat-more-button" aria-label="聊天选项"><MoreHorizontal size={24} /></button></DropdownMenuTrigger><DropdownMenuContent align="end" className="oa-conversation-popover oa-chat-clear-menu" onCloseAutoFocus={event => {
    if (pendingNavigation.current) {
      event.preventDefault();
      const navigate = pendingNavigation.current;
      pendingNavigation.current = null;
      setNavigationPending(false);
      trigger.current?.focus();
      navigate();
      return;
    }
    if (focusComposer.current) {
      event.preventDefault(); focusComposer.current = false;
      window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(chat.peer ? '.oa-member-chat textarea' : '.oa-conversation-ai:not([hidden]) textarea')?.focus());
    }
  }}>
    <DropdownMenuItem onSelect={() => afterMenuCloses(chat.showAi)}><Bot /><span>AI 助手</span>{!chat.peer && <Check className="oa-selected-peer" aria-hidden="true" />}</DropdownMenuItem>
    <DropdownMenuSeparator />
    <div className="oa-conversation-roster">
      {loading ? <p role="status" className="oa-roster-note">正在加载成员…</p> : directoryError ? <DropdownMenuItem onSelect={event => { event.preventDefault(); resetDirectory(); setDirectoryEpoch(value => value + 1); }}>成员加载失败，点击重试</DropdownMenuItem> : peers.length ? peers.map(person => <DropdownMenuItem key={person.email} onSelect={() => afterMenuCloses(() => chat.selectMember(person))}><span className="oa-menu-person-avatar" aria-hidden="true">{Array.from(person.name)[0]}</span><span className="oa-menu-person-name">{person.name}</span>{chat.peer?.email.toLowerCase() === person.email.toLowerCase() && <Check className="oa-selected-peer" aria-hidden="true" />}</DropdownMenuItem>) : <p className="oa-roster-note">暂无可聊天成员</p>}
    </div>
    <DropdownMenuSeparator />
    <DropdownMenuItem disabled={!chat.peer && !chat.aiDirty} onSelect={() => { focusComposer.current = chat.clearCurrent(); }}><Trash2 />{chat.peer ? '清空本页显示' : '清空聊天'}</DropdownMenuItem>
  </DropdownMenuContent></DropdownMenu>;
}
export function OaNewChatButton() {
  const { newAi } = useOaConversation();
  return <button type="button" className="oa-sidebar-new-chat" onClick={newAi}><Plus size={18} />聊天</button>;
}

function MemberPicker({ content, user, onClose, onSelect, onSent }: { content: ForwardContent | null; user: CurrentUser; onClose: () => void; onSelect: (peer: ConversationPeer) => void; onSent: (peer: ConversationPeer) => void }) {
  const [peers, setPeers] = useState<ConversationPeer[]>([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ConversationPeer | null>(null);
  const [body, setBody] = useState(content?.body || '');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const sendLock = useRef(false);
  const envelope = useRef<MessageEnvelope | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    const controller = new AbortController(); alive.current = true;
    void (async () => {
      try {
        const response = await fetch('/api/direct-messages?summary=1', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' }, signal: controller.signal });
        const data = await response.json() as { conversations?: Array<{ peer: ConversationPeer }>; error?: string };
        if (!response.ok || !Array.isArray(data.conversations)) throw new Error(data.error || '成员列表暂不可用。');
        if (alive.current) setPeers(data.conversations.map(item => item.peer).filter(item => item.email && item.name && item.email.toLowerCase() !== user.email.toLowerCase()));
      } catch (cause) { if (!controller.signal.aborted && alive.current) setError(cause instanceof Error ? cause.message : '成员列表暂不可用。'); }
      finally { if (alive.current) setLoading(false); }
    })();
    return () => { alive.current = false; controller.abort(); };
  }, [user.email]);
  const confirm = async () => {
    if (!content || !selected || sendLock.current) return;
    const text = body.trim();
    if (!text || text.length > DIRECT_MESSAGE_MAX_LENGTH) { setError(`正文需为 1–${DIRECT_MESSAGE_MAX_LENGTH} 个字符，过长内容不会被截断。`); return; }
    sendLock.current = true; setSending(true); setError('');
    try {
      if (!envelope.current || envelope.current.recipientEmail !== selected.email.toLowerCase() || envelope.current.body !== text) envelope.current = messageEnvelope(selected.email, text);
      await sendMemberMessage(envelope.current);
      if (alive.current) onSent(selected);
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '未能确认发送结果，重试原内容不会重复发送。'); }
    finally { sendLock.current = false; if (alive.current) setSending(false); }
  };
  const filtered = peers.filter(item => `${item.name} ${item.email}`.toLowerCase().includes(search.toLowerCase()));
  return <Dialog open onOpenChange={open => { if (!open && !sendLock.current) onClose(); }}><DialogContent className="oa-member-picker" showCloseButton={!sending}>
    <DialogHeader><DialogTitle>{content ? selected ? `转发给 ${selected.name}` : '选择转发对象' : '与成员聊天'}</DialogTitle><DialogDescription>{content ? `发送者：${user.displayName}。对方直接收到下方正文，可在 OA 回复；不是 AI 代发，也不是分享链接。` : '选择已通过 OA 准入的成员，在当前窗口直接聊天。'}</DialogDescription></DialogHeader>
    {selected && content ? <>
      <label className="oa-forward-label" htmlFor="oa-forward-body">确认发送内容</label>
      <textarea id="oa-forward-body" className="oa-forward-body" value={body} disabled={sending} onChange={event => setBody(event.target.value)} rows={10} />
      <p className="oa-forward-note">内部内容仅发给有权知悉的成员。正文中的表格、公式将直接显示；不附加知识库链接。{content.omittedImages ? '本次仅转发正文，图片附件不随本条消息发送。' : ''}</p>
      <p className="oa-forward-count">{body.length} / {DIRECT_MESSAGE_MAX_LENGTH}</p>
    </> : <>
      <input type="search" className="oa-member-search" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索成员姓名" aria-label="搜索成员姓名" />
      <div className="oa-member-list">{loading ? <p role="status">正在加载可聊天成员…</p> : filtered.length ? filtered.map(item => <button type="button" key={item.email} className="oa-member-option" onClick={() => { if (content) setSelected(item); else onSelect(item); }} aria-label={content ? `选择 ${item.name}` : `与 ${item.name} 聊天`}><span className="oa-member-avatar">{item.name.slice(0, 1)}</span><span><strong>{item.name}</strong><small>{item.email}</small></span><MessageCircle size={18} /></button>) : !error && <p>没有找到可聊天的成员。</p>}</div>
    </>}
    {error && <p className="oa-chat-error" role="alert">{error}</p>}
    <DialogFooter>{selected && content && <button type="button" className="oa-dialog-secondary" disabled={sending} onClick={() => { setSelected(null); setError(''); }}>重新选择</button>}<button type="button" className="oa-dialog-secondary" disabled={sending} onClick={onClose}>取消</button>{selected && content && <button type="button" className="oa-dialog-primary" onClick={() => void confirm()} disabled={sending || !body.trim() || body.length > DIRECT_MESSAGE_MAX_LENGTH}>{sending ? '发送中…' : '确认发送'}</button>}</DialogFooter>
  </DialogContent></Dialog>;
}

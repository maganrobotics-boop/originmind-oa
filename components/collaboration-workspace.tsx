"use client";

/* Polling remains the compatibility transport until the realtime Worker is enabled. */
/* eslint-disable react-hooks/set-state-in-effect */

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Bot, ExternalLink, Mail, MessageCircle, Plus, RefreshCw, Send, UsersRound, X } from "lucide-react";
import { toast } from "sonner";
import { useOaConversation } from "@/components/knowledge/oa-conversation-context";
import "./collaboration-workspace.css";

type Conversation = {
  id: string;
  type: "direct" | "group" | "project" | "ai";
  title: string;
  projectId: string | null;
  updatedAt: string;
  archivedAt: string | null;
  role: "owner" | "admin" | "member";
};

type Message = {
  id: string;
  conversationId: string;
  senderMemberId: string;
  senderName: string;
  body: string;
  messageType: "text" | "system" | "file";
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
};

type DirectoryPerson = {
  id: string;
  fullName: string;
  email: string;
  role: string;
  ndaCompleted: boolean;
  profile?: { department?: string; position?: string };
};

const time = (value: string) => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : value;
};

export function CollaborationWorkspace({ currentUserEmail = "" }: { currentUserEmail?: string }) {
  const ai = useOaConversation();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [currentMemberId, setCurrentMemberId] = useState("");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [people, setPeople] = useState<DirectoryPerson[]>([]);
  const [selectedMembers, setSelectedMembers] = useState<Set<string>>(new Set());
  const messagesEnd = useRef<HTMLDivElement>(null);
  const selected = conversations.find((conversation) => conversation.id === selectedId) ?? null;

  const loadConversations = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const response = await fetch("/api/conversations", { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" });
      const data = await response.json() as { conversations?: Conversation[]; currentMemberId?: string; error?: string };
      if (!response.ok) throw new Error(data.error || "会话加载失败");
      const next = data.conversations ?? [];
      setConversations(next);
      setCurrentMemberId(data.currentMemberId || "");
      setSelectedId((current) => current && next.some((item) => item.id === current) ? current : next[0]?.id || "");
      setError("");
    } catch (cause) {
      if (!silent) setError(cause instanceof Error ? cause.message : "会话加载失败");
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    void loadConversations();
    const timer = window.setInterval(() => void loadConversations(true), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!creating || people.length) return;
    fetch("/api/people?scope=directory", { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as { people?: DirectoryPerson[]; error?: string };
        if (!response.ok) throw new Error(data.error || "通讯录加载失败");
        setPeople((data.people ?? []).filter((person) => person.ndaCompleted && person.email.toLowerCase() !== currentUserEmail.toLowerCase()));
      })
      .catch((cause: unknown) => toast.error(cause instanceof Error ? cause.message : "通讯录加载失败"));
  }, [creating, currentUserEmail, people.length]);

  useEffect(() => {
    if (!selectedId) { setMessages([]); return; }
    let cancelled = false;
    let inFlight = false;
    let latestCreatedAt = "";
    const load = async (initial = false) => {
      if (inFlight) return;
      inFlight = true;
      try {
        const query = !initial && latestCreatedAt ? `?after=${encodeURIComponent(latestCreatedAt)}` : "";
        const response = await fetch(`/api/conversations/${encodeURIComponent(selectedId)}/messages${query}`, { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" });
        const data = await response.json() as { messages?: Message[]; currentMemberId?: string; error?: string };
        if (!response.ok) throw new Error(data.error || "消息加载失败");
        if (!cancelled) {
          const received = data.messages ?? [];
          if (received.length) latestCreatedAt = received.at(-1)?.createdAt || latestCreatedAt;
          setCurrentMemberId(data.currentMemberId || "");
          setMessages((current) => {
            if (initial) return received;
            const byId = new Map(current.map((message) => [message.id, message]));
            received.forEach((message) => byId.set(message.id, message));
            return [...byId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
          });
          setError("");
        }
      } catch (cause) {
        if (!cancelled && initial) setError(cause instanceof Error ? cause.message : "消息加载失败");
      } finally { inFlight = false; }
    };
    setMessages([]);
    void load(true);
    const timer = window.setInterval(() => void load(false), 5_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [selectedId]);

  useEffect(() => { messagesEnd.current?.scrollIntoView({ block: "nearest" }); }, [messages.length]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const text = body.trim();
    if (!selectedId || !text || sending) return;
    setSending(true);
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(selectedId)}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ body: text, clientMessageId: crypto.randomUUID() }),
      });
      const data = await response.json() as { message?: Message; error?: string };
      if (!response.ok || !data.message) throw new Error(data.error || "消息发送失败");
      setMessages((current) => current.some((message) => message.id === data.message!.id) ? current : [...current, data.message!]);
      setBody("");
      await loadConversations(true);
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : "消息发送失败"); }
    finally { setSending(false); }
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || !selectedMembers.size) return;
    try {
      const response = await fetch("/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ type: "group", title, memberIds: [...selectedMembers], clientConversationId: crypto.randomUUID() }),
      });
      const data = await response.json() as { conversation?: Conversation; error?: string };
      if (!response.ok || !data.conversation) throw new Error(data.error || "群聊创建失败");
      setCreating(false); setTitle(""); setSelectedMembers(new Set());
      await loadConversations(true); setSelectedId(data.conversation.id);
      toast.success("群聊已创建");
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : "群聊创建失败"); }
  };

  const memberOptions = useMemo(() => [...people].sort((left, right) => left.fullName.localeCompare(right.fullName, "zh-CN")), [people]);

  return <section className="collaboration-workspace" aria-label="聊天工作区">
    <aside className="collaboration-list">
      <div className="collaboration-list-head"><div><span>实验室协作</span><h1>聊天</h1></div><button type="button" onClick={() => setCreating(true)}><Plus />建群</button></div>
      <button type="button" className="collaboration-ai-entry" onClick={() => ai.showAi()}><span><Bot /></span><div><strong>实验室 AI</strong><small>知识库、文档与会议助手</small></div></button>
      <div className="collaboration-section-label"><span>群聊与项目群</span><button type="button" aria-label="刷新会话" onClick={() => void loadConversations()}><RefreshCw /></button></div>
      {loading ? <p className="collaboration-empty">正在加载会话…</p> : conversations.length ? conversations.map((conversation) => <button type="button" key={conversation.id} className={`collaboration-conversation ${selectedId === conversation.id ? "active" : ""}`} onClick={() => setSelectedId(conversation.id)}><span><UsersRound /></span><div><strong>{conversation.title}</strong><small>{conversation.type === "project" ? "项目群" : "群聊"} · {time(conversation.updatedAt)}</small></div></button>) : <div className="collaboration-empty"><MessageCircle /><strong>还没有群聊</strong><p>创建实验室群或项目群，成员私聊仍可从通讯录发起。</p></div>}
    </aside>
    <div className="collaboration-thread">
      {selected ? <><header><div><span className="collaboration-room-icon"><UsersRound /></span><div><h2>{selected.title}</h2><p>{selected.type === "project" ? "项目群" : "实验室群聊"} · 消息仅当前成员可见</p></div></div><span>{selected.archivedAt ? "已归档" : "协作中"}</span></header><div className="collaboration-messages">{error && <p className="collaboration-error">{error}</p>}{messages.length ? messages.map((message) => <article key={message.id} className={message.senderMemberId === currentMemberId ? "outgoing" : "incoming"}><small><strong>{message.senderName}</strong><time>{time(message.createdAt)}</time></small><p>{message.deletedAt ? "消息已撤回" : message.body}</p></article>) : !error && <div className="collaboration-empty thread-empty"><MessageCircle /><strong>开始这个群的第一条消息</strong><p>项目决定仍建议同步到任务、审批或知识库。</p></div>}<div ref={messagesEnd} /></div><form className="collaboration-composer" onSubmit={send}><textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={16000} rows={2} placeholder={`发送到 ${selected.title}`} /><button type="submit" disabled={sending || !body.trim()}><Send />{sending ? "发送中" : "发送"}</button></form></> : <div className="collaboration-empty thread-empty"><MessageCircle /><strong>选择一个会话</strong><p>也可以打开实验室 AI，或从通讯录发起一对一私聊。</p></div>}
    </div>
    {creating && <div className="collaboration-create-backdrop" role="presentation"><form className="collaboration-create" onSubmit={create}><header><div><h2>新建群聊</h2><p>只有已准入并完成保密协议的成员可以加入。</p></div><button type="button" aria-label="关闭" onClick={() => setCreating(false)}><X /></button></header><label>群名称<input autoFocus maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：机器人底盘组" /></label><fieldset><legend>选择成员</legend>{memberOptions.length ? memberOptions.map((person) => <label key={person.id} className="collaboration-member-option"><input type="checkbox" checked={selectedMembers.has(person.id)} onChange={(event) => setSelectedMembers((current) => { const next = new Set(current); if (event.target.checked) next.add(person.id); else next.delete(person.id); return next; })} /><span>{person.fullName.slice(0, 1)}</span><div><strong>{person.fullName}</strong><small>{person.profile?.department || person.profile?.position || person.role || "实验室成员"}</small></div></label>) : <p className="collaboration-empty">暂无可邀请成员。</p>}</fieldset><footer><button type="button" onClick={() => setCreating(false)}>取消</button><button type="submit" disabled={!title.trim() || !selectedMembers.size}>创建群聊</button></footer></form></div>}
  </section>;
}

export function MailWorkspace() {
  const [webmailUrl, setWebmailUrl] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/integrations", { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as { webmail?: { configured?: boolean; url?: string } };
        if (!response.ok) throw new Error("邮箱配置读取失败");
        const value = data.webmail?.configured && typeof data.webmail.url === "string" ? data.webmail.url : "";
        if (!cancelled) setWebmailUrl(value);
      })
      .catch(() => { if (!cancelled) setWebmailUrl(""); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);
  return <section className="mail-workspace"><div className="mail-card"><span className="mail-icon"><Mail /></span><div><small>实验室邮箱</small><h1>{loading ? "正在读取邮箱配置" : webmailUrl ? "打开邮箱" : "邮箱服务待配置"}</h1><p>{webmailUrl ? "邮箱客户端独立运行，OA 不保存邮箱密码，也不会默认读取整箱邮件。" : "代码入口已经预留。接入前需要确认实验室现有邮件服务的 IMAP/SMTP 与 Roundcube 部署地址。"}</p></div>{webmailUrl ? <a href={webmailUrl} target="_top">进入 Webmail <ExternalLink /></a> : <span className="mail-pending">{loading ? "读取中" : "需要管理员配置"}</span>}</div><div className="mail-principles"><div><strong>独立故障域</strong><span>Roundcube 与 OA 分开部署和更新</span></div><div><strong>最小数据</strong><span>只保存明确关联到项目的邮件元数据</span></div><div><strong>禁止 iframe</strong><span>顶层跳转，保留安全响应头</span></div></div></section>;
}

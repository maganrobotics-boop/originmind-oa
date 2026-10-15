'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';

type Session = { registered?: boolean; status?: string; isAdmin?: boolean };
type Message = { id: number; role: 'user' | 'assistant'; text: string; confirmed?: boolean };
const shortcuts = [
  ['查询两台', '查询两个服务器状态'], ['阿里云', '查询阿里云服务器状态'],
  ['腾讯云', '查询腾讯云服务器状态'], ['预览清理', '预览两个服务器临时文件清理'],
];

export default function ServerAssistant() {
  const [access, setAccess] = useState<'loading' | 'admin' | 'login' | 'denied' | 'error'>('loading');
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const request = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/session', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error('session'); return await response.json() as Session; })
      .then(session => setAccess(session.registered !== true || session.status !== 'active' ? 'login' : session.isAdmin === true ? 'admin' : 'denied'))
      .catch(() => { if (!controller.signal.aborted) setAccess('error'); });
    return () => { controller.abort(); request.current?.abort(); };
  }, []);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages, busy]);

  async function send(value = question) {
    const text = value.trim();
    if (busy || request.current || access !== 'admin' || text.length < 2) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(''); setQuestion('');
    setMessages(current => [...current, { id: ++sequence.current, role: 'user', text }]);
    try {
      const response = await fetch('/api/server-maintenance', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ question: text }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(35000)]),
      });
      const data = await response.json() as { answer?: string; error?: string; operationConfirmed?: boolean };
      if (!response.ok || typeof data.answer !== 'string' || !data.answer.trim()) throw new Error(data.error || '暂未收到操作回执。');
      setMessages(current => [...current, { id: ++sequence.current, role: 'assistant', text: data.answer!, confirmed: data.operationConfirmed === true }]);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : '未收到操作回执，请稍后重试。');
        setQuestion(text);
      }
    } finally { if (request.current === controller) { setBusy(false); request.current = null; } }
  }
  function submit(event: FormEvent) { event.preventDefault(); void send(); }

  return <main className="server-assistant">
    <header className="server-assistant-header"><a href="/" className="server-assistant-brand">OriginMind <span>OA</span></a><a href="/" className="server-assistant-back">返回工作台 ↗</a></header>
    <section className="server-assistant-heading"><span className="server-assistant-eyebrow">管理专用</span><h1>服务器助手</h1><p>阿里云与腾讯云</p></section>
    {access !== 'admin' ? <section className="server-assistant-access" aria-live="polite">
      <h2>{access === 'loading' ? '正在核对登录状态…' : access === 'denied' ? '此通道仅供 OA 管理员使用' : access === 'error' ? '暂时无法核对登录状态' : '登录后使用服务器助手'}</h2>
      <p>{access === 'loading' ? '请稍候。' : '请使用您的 OA 管理员账号进入。'}</p>
      {access !== 'loading' && <a href="/" className="server-assistant-login">返回 OA 登录</a>}
    </section> : <>
      <section className="server-assistant-chat" aria-label="服务器查询与清理通道">
        <div className="server-assistant-chatbar"><span><i /> 管理员身份已验证</span><button type="button" disabled={busy || messages.length === 0} onClick={() => { setMessages([]); setError(''); }}>清空本页</button></div>
        <div className="server-assistant-messages" role="log" aria-live="polite" aria-relevant="additions text">
          {messages.length === 0 && <div className="server-assistant-welcome"><span aria-hidden="true">⌁</span><h2>随时查看两台服务器</h2><p>查询磁盘空间、内存、负载与服务状态，<br />或先预览可以清理的临时文件。</p></div>}
          {messages.map(message => <article key={message.id} className={`server-assistant-message ${message.role}`}><div className="server-assistant-message-meta">{message.role === 'user' ? '您' : '服务器助手'}{message.role === 'assistant' && <span className={message.confirmed ? 'confirmed' : 'unconfirmed'}>{message.confirmed ? '回执已核对' : '请查看回执说明'}</span>}</div><p>{message.text}</p></article>)}
          {busy && <p className="server-assistant-wait" role="status">正在等待服务器回执…</p>}
          <div ref={bottom} />
        </div>
        <div className="server-assistant-composer"><div className="server-assistant-shortcuts">{shortcuts.map(([label, prompt]) => <button type="button" key={label} disabled={busy} onClick={() => void send(prompt)}>{label}</button>)}</div>
          <form onSubmit={submit}><label htmlFor="server-assistant-question" className="server-assistant-sr">向服务器助手提问</label><textarea id="server-assistant-question" placeholder="例如：查一下两个服务器还有多少空间" value={question} maxLength={2000} rows={2} disabled={busy} onChange={event => setQuestion(event.target.value)} /><button type="submit" disabled={busy || question.trim().length < 2}>{busy ? '查询中' : '发送 ↑'}</button></form>
          {error && <p className="server-assistant-error" role="alert">{error}</p>}
        </div>
      </section>
      <footer className="server-assistant-note"><p>仅清理超过 7 天的限定临时文件和安装缓存。</p><p>执行清理时，请明确输入：清理两个服务器的临时文件。</p></footer>
    </>}
  </main>;
}

"use client";

import { FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowUp, Copy, Plus, RotateCcw, Square } from 'lucide-react';
import { renderAnswerBody, userFacingAnswer } from '@/lib/oa-chat-renderer.mjs';
import type { KnowledgeCitation } from '@/lib/knowledge-types';
import './shared-chat.generated.css';
import './oa-chat-panel.css';

type Image = { url: string; alt: string; mimeType: string };
type Turn = { id: string; question: string; answer: string; citations: KnowledgeCitation[]; images: Image[]; failed?: boolean };
type Reply = { answer?: string; citations?: KnowledgeCitation[]; images?: Image[]; error?: string; mode?: string };
const EXAMPLES = ['实验室有哪些研究方向？', '机器人底盘急停与恢复的操作流程是什么？', '最近有哪些已审核的测试结论？'];

function RichAnswer({ answer }: { answer: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    // The same DOM-safe renderer as public Chat handles Markdown and MathML.
    element.replaceChildren(renderAnswerBody(userFacingAnswer(answer)));
    return () => element.replaceChildren();
  }, [answer]);
  return <div ref={host} className="oa-rich-answer" />;
}
function validImage(image: Image): boolean {
  return Boolean(image && typeof image.url === 'string' && /^\/api\/knowledge\/[0-9a-f-]{36}\/assets\/assets\/[A-Za-z0-9._/%-]+\?forChat=1&revision=[0-9a-f-]{36}$/iu.test(image.url) && typeof image.alt === 'string' && ['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType));
}

export function OaChatStatus() {
  const [status, setStatus] = useState<Array<boolean | null>>([null, null, null, null, null]);
  const labels = ['网络连接', 'OA 成员身份', '共享模型服务', '已审核知识', '检索与调用状态'];
  useEffect(() => {
    let disposed = false; let controller: AbortController | undefined;
    const load = async () => {
      if (document.visibilityState === 'hidden') return;
      controller?.abort(); controller = new AbortController();
      try {
        const response = await fetch('/api/lab-ai/status', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
        if (!response.ok) { if (!disposed) setStatus([true, false, null, null, null]); return; }
        const value = await response.json();
        if (!disposed) setStatus([true, value.authorized === true, value.modelReady === true, value.knowledgeReady === true, value.retrievalReady === true && value.budgetReady === true]);
      } catch { if (!disposed && !controller?.signal.aborted) setStatus([false, null, null, null, null]); }
    };
    void load();
    const interval = window.setInterval(load, 60000);
    document.addEventListener('visibilitychange', load);
    return () => { disposed = true; controller?.abort(); window.clearInterval(interval); document.removeEventListener('visibilitychange', load); };
  }, []);
  return <div className="oa-chat-title"><strong>聊天</strong><div className="oa-chat-status" aria-label="系统连接状态">{status.map((ready, index) => <span key={labels[index]} className={ready === null ? 'unknown' : ready ? 'ready' : 'unavailable'} title={`${labels[index]}：${ready === null ? '待检查' : ready ? '正常' : '暂不可用'}`} aria-label={`${labels[index]}：${ready === null ? '待检查' : ready ? '正常' : '暂不可用'}`} />)}</div></div>;
}

export function OaChatPanel() {
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const requestRef = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);
  const sending = useRef(false);
  const scroll = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const composerId = useId();
  const stickToEnd = useRef(true);

  useEffect(() => () => { requestSequence.current++; requestRef.current?.abort(); }, []);
  useEffect(() => {
    if (stickToEnd.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [turns, asking, error]);
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 144)}px`;
  }, [question]);

  const ask = useCallback(async (retry?: Turn) => {
    if (sending.current) return;
    const normalized = (retry?.question || question).trim();
    if (normalized.length < 2 || normalized.length > 2000) { setError('问题需为 2–2000 个字符。'); return; }
    const id = retry?.id || crypto.randomUUID();
    const preceding = retry ? turns.slice(0, turns.findIndex(turn => turn.id === retry.id)) : turns;
    const history = preceding.slice(-2).map(turn => ({ role: 'user', content: turn.question }));
    const sequence = ++requestSequence.current;
    const controller = new AbortController(); requestRef.current = controller; sending.current = true;
    setAsking(true); setError(''); setQuestion(''); stickToEnd.current = true;
    setTurns([...preceding, { id, question: normalized, answer: '', citations: [], images: [] }]);
    try {
      const response = await fetch('/api/lab-ai/ask', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ question: normalized, history }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(80000)]) });
      const data = await response.json() as Reply;
      if (!response.ok || !data.answer?.trim()) throw new Error(data.error || '暂未收到完整回答，请重试。');
      if (sequence !== requestSequence.current) return;
      const images = (Array.isArray(data.images) ? data.images : []).filter(validImage).slice(0, 4);
      setTurns(current => current.map(turn => turn.id === id ? { ...turn, answer: data.answer!, citations: data.citations || [], images } : turn));
    } catch (cause) {
      if (sequence !== requestSequence.current) return;
      setTurns(current => current.map(turn => turn.id === id ? { ...turn, failed: true } : turn));
      setError(controller.signal.aborted ? '已停止等待。问题已保留，可以重试。' : cause instanceof Error ? cause.message : '发送失败，请重试。');
      setQuestion(normalized);
    } finally {
      if (sequence === requestSequence.current) { sending.current = false; setAsking(false); requestRef.current = null; }
    }
  }, [question, turns]);
  const submit = (event: FormEvent) => { event.preventDefault(); void ask(); };
  const newChat = () => {
    if (turns.length && !window.confirm('开始新聊天将清除当前页面的对话，是否继续？')) return;
    requestSequence.current++; requestRef.current?.abort(); requestRef.current = null; sending.current = false;
    setTurns([]); setQuestion(''); setAsking(false); setError(''); input.current?.focus();
  };
  const copy = async (turn: Turn) => {
    try { await navigator.clipboard.writeText(userFacingAnswer(turn.answer)); setCopied(turn.id); }
    catch { setError('浏览器未允许复制，请长按回答选择文字。'); }
  };

  return <section className="oa-shared-chat" aria-label="OA 实验室 AI 聊天">
    <div className="chat-app oa-chat-surface">
      <div className="oa-conversation-tools"><button type="button" onClick={newChat} aria-label="开始新聊天" title="开始新聊天"><Plus size={18} /></button></div>
      <div className="messages oa-chat-messages" ref={scroll} onScroll={() => { const element = scroll.current; if (element) stickToEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96; }}>
        {turns.length === 0 ? <section className="empty-hero" aria-labelledby={`${composerId}-welcome`}><h2 id={`${composerId}-welcome`}>想了解实验室的什么？</h2><p>从已审核的实验室公开及内部知识中检索并回答</p></section> : turns.map(turn => <div className="oa-chat-turn" key={turn.id}>
          <article className="message user"><div className="message-content"><p>{turn.question}</p><button type="button" className="oa-question-edit" onClick={() => { setQuestion(turn.question); input.current?.focus(); }} disabled={asking}>修改问题</button></div></article>
          {turn.answer && <article className="message assistant"><div className="message-content"><RichAnswer answer={turn.answer} />
            {!!turn.images.length && <div className="oa-answer-images">{turn.images.map(image => <figure key={image.url}><img src={image.url} alt={image.alt} loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.hidden = true; }} /><figcaption>{image.alt}</figcaption></figure>)}</div>}
            <div className="oa-answer-actions"><button type="button" className="copy-answer" onClick={() => void copy(turn)} aria-label="复制回答"><Copy size={15} />{copied === turn.id ? '已复制' : '复制'}</button>{!!turn.citations.length && <details><summary>参考已审核资料</summary>{turn.citations.map(citation => <p key={`${citation.id}-${citation.itemId}`}>{citation.title}{citation.sectionTitle ? ` · ${citation.sectionTitle}` : ''}</p>)}</details>}</div>
          </div></article>}
          {turn.failed && <button type="button" className="oa-chat-retry" disabled={asking} onClick={() => void ask(turn)}><RotateCcw size={16} />重新回答</button>}
        </div>)}
        {asking && <div className="knowledge-answer-loading" role="status">正在检索并生成回答…</div>}
      </div>
      <div className="composer-area oa-chat-composer-area">
        {!turns.length && <div className="oa-chat-examples"><p>推荐问题</p>{EXAMPLES.map(example => <button type="button" key={example} onClick={() => { setQuestion(example); input.current?.focus(); }}>{example}</button>)}</div>}
        {error && <p className="oa-chat-error" role="alert">{error}</p>}
        <form className="composer oa-chat-composer" onSubmit={submit}>
          <label className="sr-only" htmlFor={composerId}>询问实验室大数据</label>
          <textarea ref={input} id={composerId} value={question} rows={1} maxLength={2000} placeholder="询问实验室大数据" onChange={event => setQuestion(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void ask(); } }} />
          {asking ? <button type="button" className="send-button" onClick={() => requestRef.current?.abort()} aria-label="停止等待回答"><Square size={18} /></button> : <button type="submit" className="send-button" disabled={question.trim().length < 2} aria-label="发送问题"><ArrowUp size={24} /></button>}
        </form>
      </div>
    </div>
  </section>;
}

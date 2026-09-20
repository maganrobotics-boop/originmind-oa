"use client";

import { FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowUp, Copy, Forward, RotateCcw, Square } from 'lucide-react';
import { renderAnswerBody, userFacingAnswer } from '@/lib/oa-chat-renderer.mjs';
import { initialChatIndicators, probeChatIndicators, pendingChatIndicators, replyChatIndicators, failedChatIndicators } from '@/lib/oa-chat-indicators.mjs';
import { CHAT_DOCUMENT_HINTS, resolveChatCapability } from '@/lib/oa-chat-documents.mjs';
import { resolveMeetingModeCommand } from '@/lib/oa-meeting-mode.mjs';
import type { KnowledgeCitation } from '@/lib/knowledge-types';
import './shared-chat.generated.css';
import './oa-chat-panel.css';
import { useOaConversation } from './oa-conversation-context';
import { OaMemberChat } from './oa-member-chat';
import { OaChatDocumentEvent, OaDocumentDialogs, OaDocumentSource, OaDocumentUpload, useOaChatDocuments } from './oa-chat-documents';
import { OaMeetingMode, type OaMeetingModeHandle } from './oa-meeting-mode';

type Image = { url: string; alt: string; mimeType: string };
type Turn = { id: string; order: number; question: string; answer: string; citations: KnowledgeCitation[]; images: Image[]; failed?: boolean };
type Reply = { answer?: string; citations?: KnowledgeCitation[]; images?: Image[]; error?: string; mode?: string; fallbackReason?: string };

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
  const { requestStatus } = useOaConversation();
  const [probe, setProbe] = useState(() => ({ ...initialChatIndicators(), checkedAt: 0 }));
  useEffect(() => {
    let disposed = false; let controller: AbortController | undefined;
    const load = async () => {
      if (document.visibilityState === 'hidden') return;
      controller?.abort();
      const current = new AbortController(); controller = current;
      let httpStatus: number | null = null;
      try {
        const response = await fetch('/api/lab-ai/status', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([current.signal, AbortSignal.timeout(15000)]) });
        httpStatus = response.status;
        const payload: unknown = response.ok ? await response.json() : undefined;
        if (!disposed && !current.signal.aborted) setProbe(probeChatIndicators(httpStatus, payload));
      } catch { if (!disposed && !current.signal.aborted) setProbe(probeChatIndicators(httpStatus)); }
    };
    void load();
    const interval = window.setInterval(load, 60000);
    document.addEventListener('visibilitychange', load);
    return () => { disposed = true; controller?.abort(); window.clearInterval(interval); document.removeEventListener('visibilitychange', load); };
  }, []);
  // Background probes never overwrite the result of the displayed question.
  const status = requestStatus || probe;
  return <div className="oa-chat-title"><strong>AI 助手</strong><details className="oa-chat-status-details"><summary aria-label="查看 AI 助手状态" title={status.summary}><div className="oa-chat-status" aria-label="系统连接状态" data-source={status.source} data-summary={status.summary}>{status.items.map(item => <span key={item.label} className={item.state} title={`${item.label}：${item.detail}`} aria-label={`${item.label}：${item.detail}`} />)}</div></summary><div className="oa-chat-status-panel"><p className="oa-chat-status-stamp">{status.source === 'question' ? '最近一次提问' : '服务检查'} · {status.checkedAt ? new Date(status.checkedAt).toLocaleTimeString() : '尚未检查'}</p><p role="status">{status.summary}</p><dl>{status.items.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.detail}</dd></div>)}</dl><small>圆点从左到右对应以上五项。灰色为未知或未执行，黄色为等待或需注意；服务检查不代表回答已生成。</small></div></details></div>;
}

export function OaChatPanel() {
  const { peer, aiEpoch } = useOaConversation();
  return <><div className="oa-conversation-ai" hidden={Boolean(peer)}><OaAiChatPanel key={aiEpoch} /></div>{peer && <OaMemberChat key={peer.email} peer={peer} />}</>;
}

function OaAiChatPanel() {
  const { forward, setLastAnswer, setAiDirty, setRequestStatus } = useOaConversation();
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [meetingModeOpen, setMeetingModeOpen] = useState(false);
  const [meetingNumber, setMeetingNumber] = useState('');
  const [meetingCommandEpoch, setMeetingCommandEpoch] = useState(0);
  const order = useRef(0);
  const nextOrder = useCallback(() => ++order.current, []);
  const documents = useOaChatDocuments(nextOrder);
  const requestRef = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);
  const sending = useRef(false);
  const scroll = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const meetingMode = useRef<OaMeetingModeHandle>(null);
  const composerId = useId();
  const stickToEnd = useRef(true);
  const working = asking || documents.busy;
  const meetingSuggestionVisible = /^[@＠]会议(?:模)?$/u.test(question.trim());
  const timeline = [...turns.map(turn => ({ type: 'answer' as const, id: turn.id, order: turn.order, turn })), ...documents.entries].sort((a, b) => a.order - b.order);
  useEffect(() => { setAiDirty(Boolean(turns.length || question || asking || error || documents.entries.length || documents.busy || documents.error || meetingModeOpen)); }, [turns.length, question, asking, error, documents.entries.length, documents.busy, documents.error, meetingModeOpen, setAiDirty]);

  useEffect(() => () => { requestSequence.current++; requestRef.current?.abort(); }, []);
  useEffect(() => { stickToEnd.current = true; }, [documents.entries.length]);
  useEffect(() => {
    if (stickToEnd.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [turns, asking, error, documents.entries, documents.error]);
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 144)}px`;
  }, [question]);

  const ask = async (retry?: Turn) => {
    if (sending.current) return;
    const normalized = (retry?.question || question).trim();
    if (normalized.length < 2 || normalized.length > 2000) { setError('问题需为 2–2000 个字符。'); return; }
    const meetingCommand = retry ? null : resolveMeetingModeCommand(normalized);
    if (meetingCommand?.action === 'start') {
      setMeetingNumber(meetingCommand.meeting); setMeetingCommandEpoch(value => value + 1); setMeetingModeOpen(true);
      setQuestion(''); setError(''); stickToEnd.current = true; return;
    }
    if (meetingCommand?.action === 'end') {
      setQuestion('');
      if (!meetingModeOpen || !meetingMode.current) { setError('当前没有已开启的会议模式。请先输入 @会议模式。'); return; }
      await meetingMode.current.end(); stickToEnd.current = true; return;
    }
    if (meetingCommand?.action === 'minutes') {
      setQuestion('');
      if (!meetingModeOpen || !meetingMode.current) { setError('当前没有正在记录的会议。请先发送 @会议模式加九位会议号。'); return; }
      meetingMode.current.minutes(); stickToEnd.current = true; return;
    }
    if (documents.busy) return;
    const capability = resolveChatCapability(normalized);
    // An explicit knowledge command wins over a selected document source.
    const documentRequest = capability ? capability.kind !== null : documents.shouldHandle(normalized);
    if (!retry && documentRequest) {
      const previous = [...timeline].reverse().find(entry => entry.type === 'answer' ? Boolean(entry.turn.answer && !entry.turn.failed) : entry.type === 'task' && entry.task?.status === 'succeeded' && Boolean(entry.task.result));
      const previousAnswer = previous?.type === 'answer' ? previous.turn.answer : previous?.type === 'task' ? previous.task?.result || '' : '';
      if (documents.submit(normalized, previousAnswer)) { setQuestion(''); setError(''); stickToEnd.current = true; setLastAnswer(null); }
      return;
    }
    documents.dismissError();
    const modelQuestion = capability?.kind === null ? capability.instruction : normalized;
    if (modelQuestion.length < 2) { setError('请在功能名后填写至少 2 个字符的问题。'); return; }
    const id = retry?.id || crypto.randomUUID();
    const preceding = retry ? turns.slice(0, turns.findIndex(turn => turn.id === retry.id)) : turns;
    const history = preceding.slice(-2).map(turn => ({ role: 'user', content: turn.question }));
    const sequence = ++requestSequence.current;
    const controller = new AbortController(); requestRef.current = controller; sending.current = true;
    let httpStatus: number | null = null;
    setAsking(true); setError(''); setQuestion(''); stickToEnd.current = true;
    setRequestStatus(pendingChatIndicators()); setLastAnswer(null);
    setTurns([...preceding, { id, order: retry?.order || nextOrder(), question: normalized, answer: '', citations: [], images: [] }]);
    try {
      const response = await fetch('/api/lab-ai/ask', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ question: modelQuestion, history }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(80000)]) });
      httpStatus = response.status;
      const data = await response.json() as Reply;
      if (sequence !== requestSequence.current) return;
      if (!response.ok || typeof data?.answer !== 'string' || !data.answer.trim()) throw new Error(data?.error || '暂未收到完整回答，请重试。');
      const images = (Array.isArray(data.images) ? data.images : []).filter(validImage).slice(0, 4);
      const fallback = data.mode === 'retrieval' && data.fallbackReason !== 'no_documents';
      setRequestStatus(replyChatIndicators(data));
      setTurns(current => current.map(turn => turn.id === id ? { ...turn, answer: data.answer!, citations: data.citations || [], images, failed: fallback } : turn));
      setLastAnswer(fallback ? null : { body: userFacingAnswer(data.answer), omittedImages: images.length });
    } catch (cause) {
      if (sequence !== requestSequence.current) return;
      setRequestStatus(failedChatIndicators(httpStatus, controller.signal.aborted));
      setTurns(current => current.map(turn => turn.id === id ? { ...turn, failed: true } : turn));
      setError(controller.signal.aborted ? '已停止等待。问题已保留，可以重试。' : cause instanceof Error ? cause.message : '发送失败，请重试。');
      setQuestion(normalized);
    } finally {
      if (sequence === requestSequence.current) { sending.current = false; setAsking(false); requestRef.current = null; }
    }
  };
  const submit = (event: FormEvent) => { event.preventDefault(); void ask(); };
  const copy = async (turn: Turn) => {
    try { await navigator.clipboard.writeText(userFacingAnswer(turn.answer)); setCopied(turn.id); }
    catch { setError('浏览器未允许复制，请长按回答选择文字。'); }
  };
  const copyQuestion = async (turn: Turn) => {
    try { await navigator.clipboard.writeText(turn.question); setCopied(`question:${turn.id}`); }
    catch { setError('浏览器未允许复制，请长按提问选择文字。'); }
  };

  return <section className="oa-shared-chat" aria-label="OA 实验室 AI 助手">
    <div className="chat-app oa-chat-surface">
      <div className="messages oa-chat-messages" ref={scroll} onScroll={() => { const element = scroll.current; if (element) stickToEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96; }}>
        {timeline.length === 0 && !meetingModeOpen && <section className="empty-hero" aria-labelledby={`${composerId}-welcome`}><h2 id={`${composerId}-welcome`}>实验室大模型能做什么</h2><p>知识问答、资料整理、会议纪要、项目总结等</p></section>}
        <OaMeetingMode ref={meetingMode} visible={meetingModeOpen} commandMeeting={meetingNumber} commandEpoch={meetingCommandEpoch} onRestore={() => setMeetingModeOpen(true)} onClose={() => setMeetingModeOpen(false)} onMinutes={(title, material, final, onAccepted) => {
          const instruction = final
            ? '@会议纪要 输出“会议全文”和“会议纪要”两部分；全文逐条保留发言人、时间和原文，纪要整理讨论要点、决策、行动项、负责人、截止日期、风险和未决问题。材料未明确的信息标注“待补充”。这是最终稿，生成后直接提交 OA 管理员审批。'
            : '@会议纪要 输出“截至当前的会议全文”和“实时会议纪要”两部分；全文逐条保留发言人、时间和原文，纪要整理当前讨论要点、决策、行动项、负责人、截止日期、风险和未决问题。材料未明确的信息标注“待补充”。会议仍在进行，不要归档。';
          const submitted = documents.submitSource(instruction, { name: `${title}.md`, text: material }, onAccepted);
          if (submitted) { stickToEnd.current = true; setLastAnswer(null); }
          return submitted;
        }} />
        {timeline.map(entry => {
          if (entry.type !== 'answer') return <OaChatDocumentEvent key={entry.id} entry={entry} documents={documents} />;
          const turn = entry.turn;
          return <div className="oa-chat-turn" key={turn.id}>
          <article className="message user"><div className="message-content"><p>{turn.question}</p><button type="button" className="oa-question-edit" onClick={() => void copyQuestion(turn)}><Copy size={14} />{copied === `question:${turn.id}` ? '已复制' : '复制'}</button></div></article>
          {turn.answer && <article className="message assistant"><div className="message-content"><RichAnswer answer={turn.answer} />
            {!!turn.images.length && <div className="oa-answer-images">{turn.images.map(image => <figure key={image.url}><img src={image.url} alt={image.alt} loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.hidden = true; }} /><figcaption>{image.alt}</figcaption></figure>)}</div>}
            <div className="oa-answer-actions"><button type="button" className="copy-answer" onClick={() => void copy(turn)} aria-label="复制回答"><Copy size={15} />{copied === turn.id ? '已复制' : '复制'}</button><button type="button" aria-label="转发回答给成员" onClick={() => forward({ body: userFacingAnswer(turn.answer), omittedImages: turn.images.length })}><Forward size={15} />转发</button>{!!turn.citations.length && <details><summary>参考已审核资料</summary>{turn.citations.map(citation => <p key={`${citation.id}-${citation.itemId}`}>{citation.title}{citation.sectionTitle ? ` · ${citation.sectionTitle}` : ''}</p>)}</details>}</div>
          </div></article>}
          {turn.failed && <button type="button" className="oa-chat-retry" disabled={working} onClick={() => void ask(turn)}><RotateCcw size={16} />重新回答</button>}
        </div>;
        })}
        {asking && <div className="knowledge-answer-loading" role="status">正在检索并生成回答…</div>}
      </div>
      <div className="composer-area oa-chat-composer-area">
        <div className="oa-chat-examples" role="group" aria-label="AI 助手五项功能"><p id={`${composerId}-capabilities`}>点击功能，或在开头输入 @功能名 调用</p><button type="button" title="@会议模式919700881" disabled={working} onClick={() => { setQuestion('@会议模式919700881'); input.current?.focus(); }}>会议模式</button>{CHAT_DOCUMENT_HINTS.map(hint => <button type="button" key={hint.label} title={`@${hint.label}`} disabled={working} onClick={() => { if (hint.label === '知识问答') documents.useSource(null); setQuestion(hint.prompt); input.current?.focus(); }}>{hint.label}</button>)}</div>
        {(error || documents.error) && <p className="oa-chat-error" role="alert">{error || documents.error}</p>}
        <OaDocumentSource documents={documents} />
        {meetingSuggestionVisible && <div id={`${composerId}-meeting-suggestion`} className="oa-chat-command-suggestions" role="listbox" aria-label="命令补全"><button type="button" role="option" aria-selected="true" onMouseDown={event => event.preventDefault()} onClick={() => { setQuestion('@会议模式919700881'); input.current?.focus(); }}><strong>@会议模式919700881</strong><span>默认联合项目周会 · 发送后直接启动</span></button></div>}
        <form className="composer oa-chat-composer" onSubmit={submit}>
          <OaDocumentUpload documents={documents} disabled={asking} />
          <label className="sr-only" htmlFor={composerId}>询问实验室大数据</label>
          <textarea ref={input} id={composerId} aria-describedby={`${composerId}-capabilities`} aria-autocomplete="list" aria-controls={meetingSuggestionVisible ? `${composerId}-meeting-suggestion` : undefined} value={question} rows={1} maxLength={2000} placeholder="询问实验室大数据" onChange={event => setQuestion(event.target.value)} onKeyDown={event => { if (meetingSuggestionVisible && ['Enter', 'Tab'].includes(event.key) && !event.nativeEvent.isComposing) { event.preventDefault(); setQuestion('@会议模式919700881'); return; } if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void ask(); } }} />
          {/* Abort may synchronously replace the control. Cancel its default action
              before aborting and keep stop/send as separate DOM buttons. */}
          {asking ? <button key="stop" type="button" className="send-button" onClick={event => { event.preventDefault(); requestRef.current?.abort(); }} aria-label="停止等待回答"><Square size={18} /></button> : <button key="send" type="submit" className="send-button" disabled={documents.busy || question.trim().length < 2} aria-label="发送问题"><ArrowUp size={24} /></button>}
        </form>
      </div>
    </div>
    <OaDocumentDialogs documents={documents} />
  </section>;
}

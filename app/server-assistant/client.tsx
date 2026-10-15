'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { renderAnswerBody, userFacingAnswer } from '@/lib/oa-chat-renderer.mjs';

type Session = { registered?: boolean; status?: string; isAdmin?: boolean };
type ToolStep = { server: string; action: string; ok: boolean; summary?: string };
type Message = { id: number; role: 'user' | 'assistant'; text: string; confirmed?: boolean; steps?: ToolStep[] };
type UiAction = 'expand_layout' | 'compact_layout' | 'browser_fullscreen';
function readUiActions(value: unknown): UiAction[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).filter((action): action is UiAction => action === 'expand_layout' || action === 'compact_layout' || action === 'browser_fullscreen');
}
function layoutIntent(value: string): 'expand' | 'compact' | 'fullscreen' | null {
  const text = value.normalize('NFKC').replace(/[\s，。！？、,.!?]/gu, '');
  if (text.length > 100 || /(?:代码|CSS|教程|原理|什么是|是什么意思|怎么实现|如何实现)/iu.test(text)) return null;
  if (/^(?:退出全屏|取消全屏|恢复窄版|切换窄版|收窄页面)$/u.test(text)) return 'compact';
  if (!/(?:全屏|铺满(?:页面|屏幕)|占满(?:页面|屏幕))/u.test(text)) return null;
  if (/^(?:请)?(?:进入|打开|切换到|改成|改为)?(?:浏览器)?全屏(?:显示|模式)?(?:吧|的)?$/u.test(text)) return 'fullscreen';
  if (/(?:助手|页面|界面|窗口|聊天)/u.test(text) && /(?:改成|改为|调整为|变成|切换|打开|进入|能不能|可以|我要|我想|铺满|占满)/u.test(text)) return 'expand';
  return null;
}
const shortcuts = [
  ['检查两台健康', '检查两台服务器的健康状态，说明需要关注的问题'], ['腾讯云为什么慢', '帮我排查腾讯云服务器为什么慢'],
  ['分析阿里云磁盘占用', '分析阿里云服务器的磁盘占用，找出主要占用来源'], ['预览清理', '预览两个服务器临时文件清理'],
];
const generalShortcuts = [
  ['自由提问', '你能帮我做些什么？'], ['整理方案', '我想推进一个新任务，请先帮我梳理目标、步骤和需要补充的信息'],
  ['检查服务器', '检查两台服务器的健康状态，说明需要关注的问题'], ['预览清理', '预览两个服务器临时文件清理'],
];
const serverName = (server: string) => server === 'aliyun' ? '阿里云' : server === 'tencent' ? '腾讯云' : server === 'web' ? '联网检索' : server === 'interface' ? '界面与权限' : server;
const actionNames: Record<string, string> = {
  status: '查询状态', plan: '预览清理', clean: '清理临时文件',
  'diagnostic:processes': '检查进程', 'diagnostic:service': '检查服务',
  'diagnostic:logs': '检查日志', 'diagnostic:disk': '分析磁盘占用',
  ui_layout:'调整页面',web_search:'联网搜索',assistant_capabilities:'核对授权',
  'operations:file_list':'浏览工作区','operations:file_read':'读取文件','operations:file_write':'保存文件','operations:file_mkdir':'创建目录','operations:file_move':'移动文件','operations:file_trash':'移入回收站',
  'operations:command_start':'运行命令','operations:job_status':'查询任务','operations:job_cancel':'取消任务','operations:service':'管理服务',
};
const actionName = (action: string) => actionNames[action] ?? '服务器检查';
function readSteps(value: unknown): ToolStep[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 24).filter((step): step is ToolStep => step !== null && typeof step === 'object'
    && typeof step.server === 'string' && typeof step.action === 'string' && typeof step.ok === 'boolean'
    && (step.summary === undefined || typeof step.summary === 'string'));
}

function AssistantAnswer({ answer }: { answer: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const fragment = document.createDocumentFragment();
    let text: string[] = [];
    let code: string[] = [];
    let closingFence: RegExp | null = null;
    const appendText = () => {
      if (text.join('\n').trim()) fragment.append(renderAnswerBody(text.join('\n')));
      text = [];
    };
    const appendCode = () => {
      const pre = document.createElement('pre');
      const block = document.createElement('code');
      block.textContent = code.join('\n');
      pre.appendChild(block); fragment.appendChild(pre); code = [];
    };
    for (const line of userFacingAnswer(answer).split(/\r?\n/u)) {
      if (closingFence) {
        if (closingFence.test(line)) { appendCode(); closingFence = null; }
        else code.push(line);
      } else {
        const fence = line.match(/^ {0,3}(`{3,}|~{3,})[^`~]*$/u);
        if (fence) {
          appendText();
          closingFence = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}[ \\t]*$`, 'u');
        } else text.push(line);
      }
    }
    if (closingFence) appendCode();
    appendText();
    element.replaceChildren(fragment);
    return () => element.replaceChildren();
  }, [answer]);
  return <div ref={host} className="server-assistant-answer" />;
}

export default function ServerAssistant({ variant = 'server' }: { variant?: 'server' | 'general' }) {
  const general = variant === 'general';
  const assistantName = general ? '通用 AI 助手' : '服务器助手';
  const [access, setAccess] = useState<'loading' | 'admin' | 'login' | 'denied' | 'error'>('loading');
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(true);
  const [browserFullscreen, setBrowserFullscreen] = useState(false);
  const [layoutNotice, setLayoutNotice] = useState('');
  const page = useRef<HTMLElement>(null);
  const sequence = useRef(0);
  const conversationId = useRef<string | undefined>(undefined);
  const request = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/session', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error('session'); return await response.json() as Session; })
      .then(session => setAccess(session.registered !== true || session.status !== 'active' ? 'login' : session.isAdmin === true ? 'admin' : 'denied'))
      .catch(() => { if (!controller.signal.aborted) setAccess('error'); });
    return () => { controller.abort(); request.current?.abort(); request.current = null; };
  }, []);
  useEffect(() => {
    const update = () => setBrowserFullscreen(document.fullscreenElement === page.current);
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages, busy]);

  async function enterBrowserFullscreen() {
    setExpanded(true);
    if (!page.current?.requestFullscreen || !document.fullscreenEnabled) {
      setLayoutNotice('已铺满页面。当前浏览器未开放隐藏地址栏的全屏接口。');
      return false;
    }
    try {
      await page.current.requestFullscreen();
      setLayoutNotice('');
      return true;
    } catch {
      setLayoutNotice('已铺满页面。点击顶部「全屏」可再次尝试浏览器全屏。');
      return false;
    }
  }
  async function toggleBrowserFullscreen() {
    if (document.fullscreenElement === page.current) {
      try { await document.exitFullscreen(); setLayoutNotice(''); }
      catch { setLayoutNotice('可按 Esc 或使用浏览器返回操作退出全屏。'); }
    } else await enterBrowserFullscreen();
  }
  function applyResponseActions(value: unknown) {
    for (const action of readUiActions(value)) {
      setExpanded(action !== 'compact_layout');
      if (action === 'browser_fullscreen') setLayoutNotice('页面已铺满。点击顶部「全屏」可隐藏浏览器地址栏。');
    }
  }

  async function send(value = question) {
    const text = value.trim();
    if (busy || request.current || access !== 'admin' || text.length < 2) return;
    const intent = layoutIntent(text);
    if (intent) {
      setError(''); setQuestion('');
      setMessages(current => [...current, { id: ++sequence.current, role: 'user', text }]);
      let answer = '';
      if (intent === 'compact') {
        if (document.fullscreenElement === page.current) {
          try { await document.exitFullscreen(); } catch { /* Page layout still changes when the browser keeps fullscreen. */ }
        }
        setExpanded(false); setLayoutNotice('');
        answer = '已将当前助手切换为窄版布局。需要时可以说「铺满页面」，或点击顶部「铺满页面」。';
      } else if (intent === 'fullscreen') {
        const entered = await enterBrowserFullscreen();
        answer = entered ? '已进入浏览器全屏。点击顶部「退出全屏」即可恢复。' : '已将当前助手铺满页面。浏览器全屏还可以通过顶部「全屏」按钮开启。';
      } else {
        setExpanded(true); setLayoutNotice('');
        answer = '已将当前助手铺满页面。服务器助手和通用 AI 助手现在都默认使用铺满页面的布局；点击顶部「全屏」还可以隐藏浏览器地址栏。';
      }
      setMessages(current => [...current, { id: ++sequence.current, role: 'assistant', text: answer }]);
      return;
    }
    const controller = new AbortController(); request.current = controller;
    const timeout = AbortSignal.timeout(150000);
    setBusy(true); setError(''); setQuestion('');
    setMessages(current => [...current, { id: ++sequence.current, role: 'user', text }]);
    try {
      const response = await fetch(general ? '/api/ai-assistant' : '/api/server-maintenance', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ question: text, conversationId: conversationId.current }), signal: AbortSignal.any([controller.signal, timeout]),
      });
      const data = await response.json() as { answer?: string; error?: string; operationConfirmed?: boolean; conversationId?: string; steps?: unknown; uiActions?: unknown };
      if (!response.ok || typeof data.answer !== 'string' || !data.answer.trim()) throw new Error(typeof data.error === 'string' && /[\u3400-\u9fff]/u.test(data.error) ? data.error : `${assistantName}暂未完成本次请求，请稍后重试。`);
      if (typeof data.conversationId === 'string' && /^[a-f0-9]{48}$/u.test(data.conversationId)) conversationId.current = data.conversationId;
      applyResponseActions(data.uiActions);
      setMessages(current => [...current, { id: ++sequence.current, role: 'assistant', text: data.answer!, confirmed: data.operationConfirmed === true, steps: readSteps(data.steps) }]);
    } catch (cause) {
      if (request.current === controller) {
        setError(controller.signal.aborted ? '已停止等待本次回复。' : timeout.aborted ? '本次分析超时，请稍后重试。' : cause instanceof Error && /[\u3400-\u9fff]/u.test(cause.message) ? cause.message : `暂时无法连接${assistantName}，请稍后重试。`);
        setQuestion(text);
      }
    } finally { if (request.current === controller) { setBusy(false); request.current = null; } }
  }
  function submit(event: FormEvent) { event.preventDefault(); void send(); }

  return <main ref={page} className={`server-assistant ${expanded ? 'server-assistant-expanded' : 'server-assistant-compact'}`}>
    <header className="server-assistant-header"><Link href="/" className="server-assistant-brand">OriginMind <span>OA</span></Link><div className="server-assistant-header-actions"><button type="button" onClick={() => { setExpanded(current => !current); setLayoutNotice(''); }} aria-pressed={expanded}>{expanded ? '窄版布局' : '铺满页面'}</button><button type="button" onClick={() => void toggleBrowserFullscreen()} aria-pressed={browserFullscreen}>{browserFullscreen ? '退出全屏' : '全屏'}</button><Link href="/" className="server-assistant-back">返回工作台 ↗</Link></div></header>
    <section className="server-assistant-heading"><span className="server-assistant-eyebrow">管理专用</span><h1>{assistantName}</h1><p>{general ? '自由对话与已授权的任务' : '阿里云与腾讯云'}</p></section>
    {layoutNotice && <p className="server-assistant-layout-notice" role="status">{layoutNotice}</p>}
    {access !== 'admin' ? <section className="server-assistant-access" aria-live="polite">
      <h2>{access === 'loading' ? '正在核对登录状态…' : access === 'denied' ? '此通道仅供 OA 管理员使用' : access === 'error' ? '暂时无法核对登录状态' : `登录后使用${assistantName}`}</h2>
      <p>{access === 'loading' ? '请稍候。' : '请使用您的 OA 管理员账号进入。'}</p>
      {access !== 'loading' && <Link href="/" className="server-assistant-login">返回 OA 登录</Link>}
    </section> : <>
      <section className="server-assistant-chat" aria-label={general ? '通用 AI 自然语言对话通道' : '服务器自然语言运维通道'}>
        <div className="server-assistant-chatbar"><span><i /> 管理员身份已验证</span><button type="button" disabled={busy || messages.length === 0} onClick={() => { conversationId.current = undefined; setMessages([]); setError(''); }}>清空本页</button></div>
        <div className="server-assistant-messages" role="log" aria-live="polite" aria-relevant="additions text">
          {messages.length === 0 && <div className="server-assistant-welcome"><span aria-hidden="true">⌁</span><h2>{general ? '有什么想问，或想一起完成的事？' : '用自然语言检查服务器'}</h2><p>{general ? <>自由提问、梳理思路、整理方案，<br />也可以交办已接入并授权的服务器任务。</> : <>分析健康状态、进程、日志与磁盘占用，<br />支持继续追问，也可以预览临时文件清理。</>}</p></div>}
          {messages.map(message => <article key={message.id} className={`server-assistant-message ${message.role}`}><div className="server-assistant-message-meta">{message.role === 'user' ? '您' : assistantName}{message.role === 'assistant' && <span className={message.steps?.length ? message.confirmed ? 'confirmed' : 'unconfirmed' : ''}>{message.steps?.length ? message.confirmed ? '工具回执已核对' : '请查看工具回执' : '对话回复'}</span>}</div>{message.role === 'assistant' ? <AssistantAnswer answer={message.text} /> : <p>{message.text}</p>}{Boolean(message.steps?.length) && <details className="server-assistant-steps"><summary>查看 {message.steps!.length} 条工具回执</summary><ol>{message.steps!.map((step, index) => <li key={index}><span className={step.ok ? 'step-ok' : 'step-error'}>{step.ok ? '完成' : '未完成'}</span><span>{serverName(step.server)} · {actionName(step.action)}</span>{step.summary && <p>{step.summary}</p>}</li>)}</ol></details>}</article>)}
          {busy && <div className="server-assistant-wait" role="status"><span>{general ? '正在分析问题并准备回复…' : '正在分析问题并查询服务器…'}</span><button type="button" onClick={() => request.current?.abort()}>停止等待</button></div>}
          <div ref={bottom} />
        </div>
        <div className="server-assistant-composer"><div className="server-assistant-shortcuts">{(general ? generalShortcuts : shortcuts).map(([label, prompt]) => <button type="button" key={label} disabled={busy} onClick={() => void send(prompt)}>{label}</button>)}</div>
          <form onSubmit={submit}><label htmlFor="server-assistant-question" className="server-assistant-sr">向{assistantName}提问</label><textarea id="server-assistant-question" placeholder={general ? '任何问题都可以问，也可以直接交办任务' : '例如：腾讯云为什么慢？也可以继续追问上次结果'} value={question} maxLength={2000} rows={2} disabled={busy} onChange={event => setQuestion(event.target.value)} /><button type="submit" disabled={busy || question.trim().length < 2}>{busy ? '分析中' : '发送 ↑'}</button></form>
          {error && <p className="server-assistant-error" role="alert">{error}</p>}
        </div>
      </section>
      <footer className="server-assistant-note">{general ? <p>自由提问、连续追问；已接入的服务器操作按授权执行。</p> : <><p>助手按当前问题查询两台服务器，并根据实际工具回执给出分析。</p><p>清理范围为超过 7 天的限定临时文件和安装缓存；执行时请明确说明需要清理。</p></>}</footer>
    </>}
  </main>;
}

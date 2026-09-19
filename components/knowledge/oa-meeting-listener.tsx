'use client';

import { useEffect, useRef, useState } from 'react';
import { captureText, MEETING_INSTRUCTION, meetingParts, mergeCapture, type MeetingEntry } from '@/lib/oa-meeting-capture.mjs';
import './oa-meeting-listener.css';

type Meeting = { id: string; number: string; title: string };
type Reply = { error?: string; authorizationUrl?: string; configured?: boolean; authorized?: boolean; name?: string; meetings?: Meeting[]; meeting?: Meeting; listenId?: string; active?: boolean; reason?: string; entries?: MeetingEntry[]; unsupported?: number; cursor?: string; hasMore?: boolean; checkedAt?: number; task?: { id: string; status: string; failure_code?: string } };
type Session = { meeting: Meeting; listenId: string; cursor: string; pages: number; cursors: Set<string> };
type Part = { requestId: string; material: string; title: string; taskId?: string; done?: boolean };
const API = '/api/lab-ai/meeting-listen';
const reason = (cause: unknown) => cause instanceof Error ? cause.message : '操作未完成，请重试。';

/** Foreground capture only: no localStorage, hidden worker, microphone or autonomous archive. */
export function OaMeetingListener({ open, onOpen, onTask, onDirty }: { open: boolean; onOpen: () => void; onTask: (id: string) => Promise<void>; onDirty: (dirty: boolean) => void }) {
  const [state, setState] = useState('尚未连接飞书旁听');
  const [ready, setReady] = useState(false), [authorized, setAuthorized] = useState(false);
  const [meetings, setMeetings] = useState<Meeting[]>([]), [selected, setSelected] = useState('');
  const [consent, setConsent] = useState(false), [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false), [generating, setGenerating] = useState(false);
  const [started, setStarted] = useState(false), [ended, setEnded] = useState(false);
  const [count, setCount] = useState(0), [lastSync, setLastSync] = useState(0);
  const [preview, setPreview] = useState(''), [error, setError] = useState('');
  const [tasks, setTasks] = useState<Array<{ id: string; title: string }>>([]);
  const captured = useRef(new Map<string, MeetingEntry>()), session = useRef<Session | null>(null);
  const stopped = useRef(false), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const epoch = useRef(0), requests = useRef(new Set<AbortController>()), mounted = useRef(true);
  const parts = useRef<Part[] | null>(null), buildLock = useRef(false), actionLock = useRef(false);
  const onTaskRef = useRef(onTask), onDirtyRef = useRef(onDirty);
  useEffect(() => { onTaskRef.current = onTask; onDirtyRef.current = onDirty; }, [onTask, onDirty]);
  useEffect(() => {
    mounted.current = true;
    const warn = (event: BeforeUnloadEvent) => { if (session.current || captured.current.size) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => { mounted.current = false; epoch.current++; if (timer.current) clearTimeout(timer.current); for (const controller of requests.current) controller.abort(); window.removeEventListener('beforeunload', warn); };
  }, []);
  const request = async (body?: object, path = API, timeout = 30000): Promise<Reply> => {
    const controller = new AbortController(); requests.current.add(controller);
    try {
      const response = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]) });
      const result = await response.json().catch(() => ({})) as Reply;
      if (!response.ok) throw new Error(result.error || '服务暂不可用，未确认操作成功。');
      return result;
    } finally { requests.current.delete(controller); }
  };
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    const current = new URL(window.location.href); const auth = current.searchParams.get('oaMeetingAuth');
    if (auth) { current.searchParams.delete('oaMeetingAuth'); window.history.replaceState(window.history.state, '', current.pathname + current.search + current.hash); }
    const load = async () => {
      try {
        const response = await fetch(API, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) });
        const result = await response.json() as Reply;
        if (disposed) return;
        if (auth && auth !== 'connected') setError('旁听授权未完成，请检查飞书权限、回调地址，重新授权。');
        setReady(Boolean(response.ok && result.configured)); setAuthorized(Boolean(result.authorized));
        if (!session.current) setState(result.error || (result.authorized ? `已授权：${result.name || '飞书用户'}；尚未开始采集` : '需要单独授权读取飞书会议'));
      } catch { if (!disposed) setError('旁听配置检查暂不可用，未开始采集。'); }
    };
    void load(); return () => { disposed = true; };
  }, [open]);
  useEffect(() => { if (new URLSearchParams(window.location.search).has('oaMeetingAuth')) onOpen(); }, [onOpen]);

  const buildMinutes = async () => {
    if (buildLock.current || !session.current) return;
    const substantive = [...captured.current.values()].some(entry => (entry.kind === 'transcript' || entry.kind === 'chat') && entry.text.trim() && !entry.text.startsWith('[非文本消息'));
    if (!substantive) { setState('未采集到可用于纪要的字幕或文字聊天，未调用模型。'); return; }
    buildLock.current = true; setGenerating(true); setError('');
    try {
      if (!parts.current) {
        const materials = meetingParts(captureText(captured.current, session.current.meeting.title));
        parts.current = materials.map((text, index) => ({ requestId: crypto.randomUUID(), material: `第 ${index + 1}/${materials.length} 段，仅此段材料，不能视为全会总结。\n${text}`, title: `${session.current!.meeting.title.slice(0, 70)} · 纪要 ${index + 1}/${materials.length}` }));
      }
      for (const part of parts.current) {
        if (!mounted.current) break;
        if (part.done) continue;
        // Identical requestId and frozen payload make retries safe after a lost response.
        const result = await request({ action: 'create', requestId: part.requestId, kind: 'meeting_minutes', title: part.title, instruction: MEETING_INSTRUCTION, material: part.material }, '/api/lab-ai/tasks');
        if (!result.task?.id) throw new Error('未取得纪要任务编号；请保留此页并核对提交。');
        part.taskId = result.task.id;
        if (mounted.current) setTasks(old => old.some(item => item.id === part.taskId) ? old : [...old, { id: part.taskId!, title: part.title }]);
        let task = result.task;
        if (task.status === 'queued') task = (await request({ action: 'run', id: task.id }, '/api/lab-ai/tasks', 80000)).task || task;
        if (mounted.current) await onTaskRef.current(task.id);
        if (task.status !== 'succeeded') throw new Error('纪要任务已保存，但尚未成功生成。请在文档卡片中核对、重试后，再继续剩余分段。');
        part.done = true;
      }
      if (mounted.current) setState('已采集片段的纪要已生成；请核对并提交 OA 审核，不会自动入库或对外公开。');
    } catch (cause) { if (mounted.current) setError(reason(cause)); }
    finally { buildLock.current = false; if (mounted.current) setGenerating(false); }
  };
  const poll = async (version: number) => {
    const current = session.current;
    if (!current || stopped.current || version !== epoch.current || !mounted.current) return;
    try {
      const page = await request({ action: 'poll', meetingId: current.meeting.id, listenId: current.listenId, cursor: current.cursor });
      if (version !== epoch.current || !mounted.current || stopped.current) return;
      if (page.active === false) { stopped.current = true; setEnded(true); setRunning(false); setState(page.reason || '本人已不在此会议，停止采集。'); await buildMinutes(); return; }
      if (!page.active || !Array.isArray(page.entries) || typeof page.cursor !== 'string' || typeof page.hasMore !== 'boolean' || typeof page.checkedAt !== 'number') throw new Error('旁听响应格式异常，已暂停，未推进游标。');
      if (page.hasMore && (current.pages >= 200 || current.cursors.has(page.cursor))) throw new Error('分页达到安全上限或游标循环，已暂停；导出已采集内容后核对。');
      const next = mergeCapture(captured.current, page.entries);
      captured.current = next; current.cursor = page.cursor;
      if (page.hasMore) { current.pages++; current.cursors.add(page.cursor); } else { current.pages = 0; current.cursors.clear(); }
      const transcripts = [...next.values()].filter(entry => entry.kind === 'transcript').length;
      setCount(next.size); setLastSync(page.checkedAt); setPreview([...next.values()].slice(-6).map(entry => `${entry.actor.name}：${entry.text}`).join('\n'));
      onDirtyRef.current(true);
      setState(`${page.hasMore ? '正在补拉历史分页' : '轮询已成功'}；字幕 ${transcripts} 条${page.unsupported ? `；本页有 ${page.unsupported} 个未解析事件，纪要不覆盖这些内容` : ''}`);
      timer.current = setTimeout(() => void poll(version), page.hasMore ? 200 : 5000);
    } catch (cause) { if (version === epoch.current && mounted.current) { setRunning(false); setState('采集已暂停；不是正在旁听'); setError(reason(cause)); } }
  };
  const perform = async (action: 'authorize' | 'active' | 'start' | 'stop' | 'disconnect' | 'resume') => {
    if (actionLock.current) return;
    actionLock.current = true; setBusy(true); setError('');
    try {
      if (action === 'authorize') {
        const result = await request({ action, returnTo: window.location.pathname + window.location.search });
        const target = new URL(result.authorizationUrl || '');
        if (target.origin !== 'https://accounts.feishu.cn' || target.pathname !== '/open-apis/authen/v1/authorize') throw new Error('授权地址不正确。');
        window.location.assign(target.href);
      } else if (action === 'active') {
        const result = await request({ action }); const list = result.meetings || [];
        setMeetings(list); setSelected(list.length === 1 ? list[0].id : '');
        setState(list.length ? '请选择本人当前所在会议；会议号不作为接口 meeting_id 使用。' : '未发现本人正在参加的会议，请先在飞书入会。');
      } else if (action === 'start') {
        if (captured.current.size) throw new Error('本页已有未清空的采集资料，请先保存或导出。开始另一场会议请另开 OA 页面。');
        const result = await request({ action, meetingId: selected, consent });
        if (!result.listenId || !result.meeting) throw new Error('未取得真实旁听会话，未开始采集。');
        session.current = { meeting: result.meeting, listenId: result.listenId, cursor: '', pages: 0, cursors: new Set() };
        stopped.current = false; setEnded(false); setStarted(true); parts.current = null; setRunning(true); onDirtyRef.current(true); setState('已选择会议，正在等待首次真实拉取…');
        void poll(++epoch.current);
      } else if (action === 'resume') {
        if (stopped.current || parts.current) throw new Error('这次采集已经结束，不能修改已分段的源材料。');
        if (session.current) { session.current.pages = 0; session.current.cursors.clear(); }
        setRunning(true); void poll(++epoch.current);
      } else {
        epoch.current++; if (timer.current) clearTimeout(timer.current); stopped.current = true; setEnded(true); setRunning(false);
        const current = session.current;
        if (action === 'stop' && current) {
          // A failed stop does not restart local polling or discard captured material.
          try { await request({ action, meetingId: current.meeting.id, listenId: current.listenId }); }
          catch { setError('本页已停止轮询，但服务器停止确认失败；可断开授权。现有文字仍保留。'); }
          await buildMinutes();
        } else if (action === 'disconnect') { await request({ action }); setAuthorized(false); setState('本浏览器旁听授权已清除；不是撤销飞书平台全部授权。'); }
      }
    } catch (cause) { if (mounted.current) setError(reason(cause)); }
    finally { actionLock.current = false; if (mounted.current) setBusy(false); }
  };
  const download = () => {
    const blob = new Blob([captureText(captured.current, session.current?.meeting.title)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = '飞书旁听-已采集片段.txt'; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className="oa-meeting-listener" aria-label="飞书会议旁听">
    <button type="button" className="oa-document-text-button" onClick={onOpen} aria-expanded={open}>会议模式 · 飞书旁听</button>
    {open && <div className="oa-meeting-body">
      <p><strong>用户身份旁听</strong>：您本人须在飞书会议中，不显示独立机器人，不能发声。请保持 OA 页面打开；锁屏、后台节流、断网或关闭页面会中断采集，不保证覆盖全会。</p>
      <details><summary>首次接入条件</summary><p>飞书灰度账号；客户端 7.68+；应用申请用户身份权限 vc:meeting.meetingevent:read 并发布；会议所有者打开“允许智能体入会”（找不到时先开 AI 总结）。本功能使用文档给出的 HTTP API，不需要在手机安装 CLI。</p></details>
      <p role="status">{state}</p>
      <small>已采集 {count} 条；最近成功拉取：{lastSync ? new Date(lastSync).toLocaleTimeString() : '尚无'}</small>
      {error && <p role="alert" className="oa-chat-error">{error}</p>}
      {!authorized && <button type="button" disabled={!ready || busy || count > 0} onClick={() => void perform('authorize')}>授权读取我的会议</button>}
      {authorized && !running && !count && <button type="button" disabled={busy} onClick={() => void perform('active')}>查找我正在参加的会议</button>}
      {!!meetings.length && !started && <><label>选择会议<select value={selected} onChange={event => setSelected(event.target.value)}><option value="">请选择会议</option>{meetings.map(meeting => <option key={meeting.id} value={meeting.id}>{meeting.title}（{meeting.number}）</option>)}</select></label><label className="oa-meeting-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />已告知参会成员并获得许可；同意采集后由现有 AI 服务制作纪要，本人和 OA 管理员可查看，审批后才入库。</label><button type="button" disabled={!selected || !consent || busy} onClick={() => void perform('start')}>开始旁听</button></>}
      {started && !ended && <button type="button" disabled={busy || generating} onClick={() => void perform('stop')}>结束采集并生成纪要</button>}
      {started && !running && !ended && <button type="button" disabled={busy} onClick={() => void perform('resume')}>重试拉取</button>}
      {count > 0 && <button type="button" onClick={download}>导出已采集原文</button>}
      {count > 0 && !running && ended && <button type="button" disabled={busy || generating} onClick={() => void buildMinutes()}>核对／继续生成纪要</button>}
      {authorized && <button type="button" disabled={busy || generating} onClick={() => void perform('disconnect')}>断开旁听授权</button>}
      {generating && <p role="status">正在分段制作纪要，请勿关闭页面。每段单独标注，不冒充全会总结…</p>}
      {preview && <pre className="oa-meeting-preview">{preview}</pre>}
      {tasks.map(task => <button type="button" key={task.id} onClick={() => void onTaskRef.current(task.id)}>打开 {task.title}</button>)}
      <p><small>未生成的原文仅保存在本页内存，刷新会丢失。已创建的纪要任务可从“已保存文档”恢复。未读取共享文档、屏幕或原始音视频；没有收到字幕时，不会凭空生成纪要。</small></p>
    </div>}
  </section>;
}

'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Bot, CheckCircle2, CircleDot, FileText, LogOut, RotateCcw, X } from 'lucide-react';
import { buildMeetingMinutesMaterial, isMeetingModeSession, meetingModeStorageKey, type MeetingModeSession, type MeetingTranscriptItem } from '@/lib/oa-meeting-mode.mjs';
import { useOaConversation } from './oa-conversation-context';
import './oa-meeting-mode.css';

type BotReply = { error?: string; message?: string; state?: string; meetingId?: string | null; meetingNumber?: string; outcomeUnknown?: boolean; diagnostic?: string; code?: number };
type EventReply = { error?: string; state?: string; transcript?: MeetingTranscriptItem[]; participants?: string[]; pageToken?: string | null; hasMore?: boolean; contentTruncated?: boolean; meetingEnded?: boolean; meeting?: { topic?: string; startTime?: string; endTime?: string } };
type Props = {
  visible: boolean;
  commandMeeting?: string;
  commandEpoch?: number;
  onRestore: () => void;
  onClose: () => void;
  onMinutes: (title: string, material: string, final: boolean, onAccepted?: (taskId: string) => void) => boolean;
};
export type OaMeetingModeHandle = { end: () => Promise<void>; minutes: () => void };

const emptySession = (title = ''): MeetingModeSession => ({
  version: 1, phase: 'draft', title, meeting: '', meetingId: null, participants: '', agenda: '', startedAt: null, endedAt: null,
  exitStatus: 'not_requested', minutesTaskId: null, transcript: [], markers: [], observedParticipants: [],
});
const phaseLabels: Record<MeetingModeSession['phase'], string> = {
  draft: '草稿', waiting_to_join: '等待入会', in_meeting: '会议中', generating_minutes: '生成纪要', pending_confirmation: '待确认', archived: '已归档',
};
const errorText = (cause: unknown, fallback: string) => cause instanceof Error && !['AbortError', 'TimeoutError'].includes(cause.name) ? cause.message : fallback;

class MeetingBotRequestError extends Error {
  outcomeUnknown: boolean;
  constructor(message: string, outcomeUnknown: boolean) { super(message); this.name = 'MeetingBotRequestError'; this.outcomeUnknown = outcomeUnknown; }
}

async function botRequest(body: object, timeout = 20000): Promise<BotReply> {
  const action = 'action' in body && typeof body.action === 'string' ? body.action : '';
  let response: Response;
  try {
    response = await fetch('/api/admin/meeting-bot', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new MeetingBotRequestError('网络中断，操作结果不明确。请先查看飞书参会人列表，勿重复操作。', action === 'join' || action === 'leave');
  }
  const data = await response.json().catch(() => ({})) as BotReply;
  if (!response.ok) {
    const diagnostic = [data.diagnostic, data.code].filter(value => value !== undefined).join(' / ');
    throw new MeetingBotRequestError(`${data.error || '会议机器人请求失败。'}${diagnostic ? `（${diagnostic}）` : ''}`, data.outcomeUnknown === true);
  }
  return data;
}

export const OaMeetingMode = forwardRef<OaMeetingModeHandle, Props>(function OaMeetingMode({ visible, commandMeeting = '', commandEpoch = 0, onRestore, onClose, onMinutes }, ref) {
  const { user } = useOaConversation();
  const storageKey = meetingModeStorageKey(user.email);
  const [session, setSession] = useState<MeetingModeSession>(() => emptySession());
  const sessionRef = useRef(session);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('发送 @会议模式加九位会议号，即可让 OA 助手入会。');
  const [liveMinutes, setLiveMinutes] = useState('');
  const [minutesUpdating, setMinutesUpdating] = useState(false);
  const summarizedTranscriptCount = useRef(0);
  const lastSummaryAt = useRef(0);
  const pageToken = useRef<string | null>(null);
  const [remoteEnded, setRemoteEnded] = useState(false);
  const pollPromise = useRef<Promise<void> | null>(null);
  const mutationBusy = useRef(false);
  const restored = useRef(false);

  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => {
    const root = document.documentElement;
    const active = session.phase === 'in_meeting';
    root.classList.toggle('oa-meeting-cockpit-active', active);
    return () => root.classList.remove('oa-meeting-cockpit-active');
  }, [session.phase]);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    try {
      const value: unknown = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      if (isMeetingModeSession(value) && value.phase !== 'archived') { setSession(value); onRestore(); }
    } catch { /* Corrupt tab-local state is ignored. */ }
  }, [storageKey, onRestore]);
  useEffect(() => {
    if (!visible && session.phase === 'draft' && !session.title && !session.meeting) return;
    try { sessionStorage.setItem(storageKey, JSON.stringify(session)); }
    catch { setNotice('浏览器无法保存会议现场状态；请保持本页打开，并在结束后立即生成纪要。'); }
  }, [session, storageKey, visible]);
  useEffect(() => {
    if (session.phase !== 'pending_confirmation' || !session.minutesTaskId) return;
    let current = true;
    const verify = async () => {
      try {
        const taskResponse = await fetch(`/api/lab-ai/tasks?id=${encodeURIComponent(session.minutesTaskId!)}`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) });
        const taskData = await taskResponse.json().catch(() => ({})) as { task?: { status?: string; title?: string; result?: string } };
        if (!current || !taskResponse.ok) return;
        if (taskData.task?.status === 'succeeded' && taskData.task.result?.trim()) {
          const actionResponse = await fetch('/api/work-items', {
            method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'import_meeting', sourceId: session.minutesTaskId }),
            signal: AbortSignal.timeout(15000),
          });
          if (!actionResponse.ok) throw new Error('会议行动项尚未同步到统一待办。');
        }
        const lifecycleResponse = await fetch(`/api/lab-ai/archive?id=${encodeURIComponent(session.minutesTaskId!)}`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) });
        const lifecycleData = await lifecycleResponse.json().catch(() => ({})) as { lifecycle?: { state?: string; knowledgeStatus?: string | null } };
        if (!current || !lifecycleResponse.ok) return;
        if (lifecycleData.lifecycle?.state !== 'submitted' && taskData.task?.status === 'succeeded') {
          const submitResponse = await fetch('/api/lab-ai/archive', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: session.minutesTaskId, confirmed: true }), signal: AbortSignal.timeout(90000) });
          const submitted = await submitResponse.json().catch(() => ({})) as { received?: boolean; item?: { status?: string }; error?: string };
          if (!current) return;
          if (!submitResponse.ok || submitted.received !== true) throw new Error(submitted.error || '自动提交 OA 尚未确认。');
          setNotice(submitted.item?.status === 'active' ? '会议全文和纪要已由管理员批准并归档。' : '会议全文和纪要已自动提交 OA，正在等待管理员审批。');
          if (submitted.item?.status === 'active') setSession(previous => previous.minutesTaskId === session.minutesTaskId ? { ...previous, phase: 'archived' } : previous);
          window.dispatchEvent(new Event('oa-files-archived')); setError(''); return;
        }
        if (lifecycleData.lifecycle?.state === 'submitted' && lifecycleData.lifecycle.knowledgeStatus === 'active') {
          setSession(previous => previous.minutesTaskId === session.minutesTaskId ? { ...previous, phase: 'archived' } : previous);
          setNotice('会议全文和纪要已由管理员批准并归档。'); setError(''); return;
        }
        if (lifecycleData.lifecycle?.state === 'submitted') setNotice('会议全文和纪要已自动提交 OA，正在等待管理员审批。');
      } catch { /* The document editor remains the authoritative recovery UI. */ }
    };
    const update = () => { if (document.visibilityState !== 'hidden') void verify(); };
    void verify(); const timer = window.setInterval(update, 5000); window.addEventListener('oa-files-archived', update); document.addEventListener('visibilitychange', update);
    return () => { current = false; window.clearInterval(timer); window.removeEventListener('oa-files-archived', update); document.removeEventListener('visibilitychange', update); };
  }, [session.phase, session.minutesTaskId, session.title]);

  const patch = (values: Partial<MeetingModeSession>) => setSession(current => ({ ...current, ...values }));
  const start = useCallback(async (meeting: string) => {
    const normalizedMeeting = meeting.trim();
    const current = sessionRef.current;
    if (mutationBusy.current || current.phase !== 'draft') return;
    if (!/^[0-9]{9}$/u.test(normalizedMeeting)) { setError('请发送 @会议模式 加九位飞书会议号，例如 @会议模式919700881。'); return; }
    const prepared = { ...current, title: `飞书会议 ${normalizedMeeting}`, meeting: normalizedMeeting, phase: 'waiting_to_join' as const, exitStatus: 'not_requested' as const };
    setLiveMinutes(''); summarizedTranscriptCount.current = 0; lastSummaryAt.current = 0;
    sessionRef.current = prepared; setSession(prepared);
    mutationBusy.current = true; setBusy(true); setError(''); setNotice('正在请求 OA 助手加入飞书会议…');
    try {
      const data = await botRequest({ action: 'join', meeting: normalizedMeeting, confirmed: true });
      if (data.state !== 'join_api_succeeded' || !data.meetingId) {
        patch({ phase: 'waiting_to_join' });
        setError('飞书入会接口已响应，但没有返回可用于退出和读取转写的会议 ID。请先在参会人列表核对，勿重复入会。');
        return;
      }
      const startedAt = new Date().toISOString();
      patch({ phase: 'in_meeting', meetingId: data.meetingId, meeting: data.meetingNumber || normalizedMeeting, startedAt, endedAt: null, exitStatus: 'not_requested' });
      setNotice(data.message || 'OA 助手已请求入会，正在读取会中事件。'); pageToken.current = null; setRemoteEnded(false);
    } catch (cause) {
      const outcomeUnknown = cause instanceof MeetingBotRequestError && cause.outcomeUnknown;
      patch({ phase: outcomeUnknown ? 'waiting_to_join' : 'draft' });
      setError(outcomeUnknown ? `${errorText(cause, '入会结果未确认。')} 请先查看飞书参会人列表，勿重复入会。` : errorText(cause, '入会请求失败，未确认机器人加入。'));
    } finally { mutationBusy.current = false; setBusy(false); }
  }, []);
  useEffect(() => {
    if (!commandMeeting) return;
    if (['in_meeting', 'waiting_to_join'].includes(sessionRef.current.phase)) {
      setError(`已有会议 ${sessionRef.current.meeting || ''} 正在连接或记录，请先发送 @结束会议。`); return;
    }
    if (sessionRef.current.phase !== 'draft') {
      const draft = emptySession(); sessionRef.current = draft; setSession(draft);
    }
    void start(commandMeeting);
  }, [commandMeeting, commandEpoch, start]);

  const performEventRead = useCallback(async (force = false) => {
    const current = sessionRef.current;
    if (current.phase !== 'in_meeting' || !current.meetingId || (!force && document.visibilityState === 'hidden')) return;
    try {
      const body = { action: 'events', meetingId: current.meetingId,
        ...(pageToken.current ? { pageToken: pageToken.current } : current.startedAt ? { startTime: String(Math.floor(Date.parse(current.startedAt) / 1000)) } : {}) };
      const response = await fetch('/api/admin/meeting-bot', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      const data = await response.json().catch(() => ({})) as EventReply;
      if (!response.ok || data.state !== 'events_read') throw new Error(data.error || '实时转写暂不可用。');
      const base = sessionRef.current;
      const knownIds = new Set(base.transcript.map(item => item.id));
      const additions = (data.transcript || []).filter(item => item?.id && item.text && !knownIds.has(item.id)).length;
      const participantOverflow = new Set([...base.observedParticipants, ...(data.participants || [])]).size > 500;
      if (base.transcript.length + additions > 2000) {
        setNotice('实时转写已超过本期会议模式的 2,000 条现场上限；请尽快结束并生成纪要，完整原始记录仍以飞书为准。');
      } else {
        const byId = new Map(base.transcript.map(item => [item.id, item]));
        for (const item of data.transcript || []) if (item?.id && item.text) byId.set(item.id, item);
        const transcript = [...byId.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
        const participants = [...new Set([...base.observedParticipants, ...(data.participants || [])])].slice(0, 500);
        const updated = { ...base, title: data.meeting?.topic || base.title, transcript, observedParticipants: participants };
        sessionRef.current = updated; setSession(updated);
      }
      pageToken.current = data.hasMore && data.pageToken ? data.pageToken : null;
      if (data.contentTruncated) setNotice('飞书本页事件超过安全展示上限；OA 未将被截断内容写入纪要材料，完整原始记录以飞书为准。');
      else if (participantOverflow) setNotice('已识别参会人超过 500 人；会议模式仅保留前 500 个姓名，完整名单以飞书为准。');
      if (data.meetingEnded) {
        const ended = { ...sessionRef.current, exitStatus: 'confirmed' as const };
        sessionRef.current = ended; setSession(ended); setRemoteEnded(true); setNotice('飞书已报告会议结束。请生成纪要；无需再次让机器人退出。');
      }
      setError('');
    } catch (cause) { setError(errorText(cause, '实时转写连接暂时中断，OA 会继续重试。')); }
  }, []);
  const readEvents = useCallback(async (force = false) => {
    const inFlight = pollPromise.current;
    if (inFlight) { if (force) await inFlight; return; }
    const operation = performEventRead(force); pollPromise.current = operation;
    try { await operation; }
    finally { if (pollPromise.current === operation) pollPromise.current = null; }
  }, [performEventRead]);
  useEffect(() => {
    if (session.phase !== 'in_meeting' || !session.meetingId) return;
    void readEvents();
    const timer = window.setInterval(() => void readEvents(), 10000);
    const visibleAgain = () => { if (document.visibilityState === 'visible') void readEvents(); };
    document.addEventListener('visibilitychange', visibleAgain);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', visibleAgain); };
  }, [session.phase, session.meetingId, readEvents]);

  useEffect(() => {
    if (session.phase !== 'in_meeting' || !session.transcript.length || session.transcript.length === summarizedTranscriptCount.current) return;
    const controller = new AbortController();
    const elapsed = Date.now() - lastSummaryAt.current;
    const delay = Math.max(4000, 30000 - elapsed);
    const timer = window.setTimeout(async () => {
      const current = sessionRef.current;
      if (current.phase !== 'in_meeting' || !current.transcript.length) return;
      const material = current.transcript.slice(-24).map(item => `${item.speaker}：${item.text}`).join('\n').slice(-1800);
      setMinutesUpdating(true);
      try {
        const response = await fetch('/api/lab-ai/ask', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ question: `只根据以下实时会议字幕，生成简洁的中文实时纪要。按“讨论要点、决定、行动项、风险与未决问题”组织；没有的信息写“暂无”，不得编造。\n\n${material}`, history: [] }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]) });
        const data = await response.json().catch(() => ({})) as { answer?: string; error?: string };
        if (!response.ok || !data.answer?.trim()) throw new Error(data.error || '实时纪要暂未生成。');
        if (!controller.signal.aborted) { setLiveMinutes(data.answer.trim()); summarizedTranscriptCount.current = current.transcript.length; lastSummaryAt.current = Date.now(); }
      } catch (cause) {
        if (!controller.signal.aborted) setLiveMinutes(previous => previous || errorText(cause, '取得字幕后将自动生成实时纪要。'));
      } finally { if (!controller.signal.aborted) setMinutesUpdating(false); }
    }, delay);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [session.phase, session.transcript]);

  const submitMinutes = useCallback((completed: MeetingModeSession) => {
    let material = '';
    try { material = buildMeetingMinutesMaterial(completed); }
    catch (cause) {
      setError(cause instanceof Error && cause.message === 'MEETING_MATERIAL_TOO_LARGE' ? '会议材料超过 20,000 字，当前版本不会截断。请先在飞书保留完整记录，再分段整理。' : '会议材料不完整，暂时无法生成纪要。');
      return false;
    }
    sessionRef.current = completed; setSession(completed);
    const identity = `${completed.startedAt || ''}:${completed.endedAt || ''}`;
    const accepted = (taskId: string) => setSession(previous => `${previous.startedAt || ''}:${previous.endedAt || ''}` === identity ? { ...previous, minutesTaskId: taskId } : previous);
    if (!onMinutes(completed.title || '会议纪要', material, true, accepted)) { setError('纪要任务未能提交，会议材料仍保留在当前页面。'); return false; }
    setSession({ ...completed, phase: 'pending_confirmation' });
    setNotice('会议纪要任务已提交。生成后会自动打开；请核对正文，再点击“提交 OA”。'); setError('');
    return true;
  }, [onMinutes]);

  const generateLiveMinutes = useCallback(() => {
    const current = sessionRef.current;
    if (current.phase !== 'in_meeting') { setError('当前没有正在记录的会议。'); return; }
    let material = '';
    try { material = buildMeetingMinutesMaterial(current); }
    catch { setError('当前会议全文过大或格式不完整，暂时无法生成实时纪要。'); return; }
    if (!onMinutes(current.title || '实时会议纪要', material, false)) { setError('实时纪要任务未能提交，请稍后重试。'); return; }
    setNotice('已在聊天中生成截至当前的会议全文和实时纪要；会议仍在继续记录。'); setError('');
  }, [onMinutes]);

  const finish = useCallback(async () => {
    const initial = sessionRef.current;
    if (mutationBusy.current) return;
    if (initial.phase !== 'in_meeting' || !initial.meetingId) { setError('当前没有可结束的会议。'); return; }
    mutationBusy.current = true; setBusy(true); setError(''); setNotice('正在同步最后一批会中转写…');
    try {
      await readEvents(true);
      const current = sessionRef.current;
      const alreadyEnded = remoteEnded || current.exitStatus === 'confirmed';
      const completed: MeetingModeSession = { ...current, phase: 'generating_minutes', endedAt: new Date().toISOString(), exitStatus: alreadyEnded ? 'confirmed' : 'uncertain' };
      sessionRef.current = completed; setSession(completed);
      setNotice(alreadyEnded ? '正在整理会议材料…' : '正在让 OA 助手退出会议…');
      if (!alreadyEnded) {
        const result = await botRequest({ action: 'leave', meetingId: current.meetingId, confirmed: true });
        if (result.state !== 'leave_api_succeeded') throw new MeetingBotRequestError('退出接口响应不完整，结果暂不明确。', true);
      }
      const safeToSummarize = { ...completed, exitStatus: 'confirmed' as const };
      submitMinutes(safeToSummarize);
    } catch (cause) {
      setError(`${errorText(cause, '退出结果未确认。')} 请先在飞书参会人列表核对；确认机器人已离会后，可选择“仅生成纪要”。`);
    } finally { mutationBusy.current = false; setBusy(false); }
  }, [readEvents, remoteEnded, submitMinutes]);
  useEffect(() => {
    if (session.phase === 'in_meeting' && remoteEnded && !mutationBusy.current) void finish();
  }, [session.phase, remoteEnded, finish]);
  useImperativeHandle(ref, () => ({ end: finish, minutes: generateLiveMinutes }), [finish, generateLiveMinutes]);

  const reset = () => {
    if (session.phase === 'in_meeting' || session.phase === 'waiting_to_join') return;
    try { sessionStorage.removeItem(storageKey); } catch { /* Best effort. */ }
    setLiveMinutes(''); summarizedTranscriptCount.current = 0; lastSummaryAt.current = 0; setSession(emptySession()); pageToken.current = null; setRemoteEnded(false); setError(''); setNotice('发送 @会议模式加九位会议号，即可让 OA 助手入会。');
  };
  const clearJoinLock = () => {
    if (!window.confirm('请先在飞书确认机器人没有入会，或已经由主持人移出。此操作只解除本地锁定，不会控制飞书机器人。确认继续？')) return;
    const current = sessionRef.current;
    const draft: MeetingModeSession = { ...current, phase: 'draft', meetingId: null, startedAt: null, endedAt: null, exitStatus: 'not_requested', minutesTaskId: null, transcript: [], observedParticipants: [] };
    sessionRef.current = draft; setSession(draft); setError(''); setNotice('本地入会锁定已解除；请重新发送 @会议模式加九位会议号。');
  };
  if (!visible) return null;

  const active = session.phase === 'in_meeting';
  const latestSubtitle = session.transcript.at(-1);
  return <article className={`oa-meeting-mode ${active ? 'meeting-active' : ''}`} aria-label="会议模式">
    <header className="oa-meeting-header"><div><span className={active ? 'live' : ''}><CircleDot size={14} />{phaseLabels[session.phase]}</span><h2><Bot size={22} />{active ? `飞书会议 ${session.meeting}` : '会议模式'}</h2><p>{notice}</p></div>{!active && session.phase === 'draft' && <button type="button" className="oa-meeting-close" aria-label="关闭会议模式" onClick={() => { reset(); onClose(); }}><X size={20} /></button>}</header>
    {session.phase === 'draft' || session.phase === 'waiting_to_join' ? <div className="oa-meeting-compact-start">
      <p>{session.phase === 'waiting_to_join' ? `正在连接飞书会议 ${session.meeting}，请主持人在飞书中放行机器人。` : '在下方聊天框发送 @会议模式加九位会议号，例如 @会议模式919700881。发送即确认已告知参会人 OA 助手将记录会议。'}</p>
      {session.phase === 'waiting_to_join' && <button type="button" className="oa-meeting-recovery" disabled={busy} onClick={clearJoinLock}><RotateCcw size={17} />确认机器人未入会，解除锁定</button>}
    </div> : <div className="oa-meeting-console">
      <section className="oa-meeting-summary"><div><small>{session.startedAt ? new Date(session.startedAt).toLocaleString('zh-CN') : '尚未开始'} · {session.observedParticipants.length} 位已识别参会人</small></div><span><CircleDot size={14} />{active ? remoteEnded ? '飞书已结束' : '记录中' : phaseLabels[session.phase]}</span></section>
      {active && <div className="oa-meeting-live-view">
        <main className="oa-meeting-live-notes" aria-label="会议实时纪要">
          <h3><FileText size={17} />会议实时纪要 <small>{minutesUpdating ? '正在更新…' : `${session.transcript.length} 条字幕`}</small></h3>
          <section className="oa-meeting-ai-minutes">{liveMinutes ? <div>{liveMinutes}</div> : <div className="oa-meeting-empty">取得实时字幕后，OA 会自动生成并持续更新会议纪要，无需人工记录。</div>}</section>
        </main>
        <div className="oa-meeting-subtitle" role="status" aria-live="polite">{latestSubtitle ? <><strong>{latestSubtitle.speaker}</strong><span>{latestSubtitle.text}</span></> : <span>正在等待实时字幕…</span>}</div>
      </div>}
      {session.phase === 'pending_confirmation' && <div className="oa-meeting-complete"><CheckCircle2 size={22} /><div><strong>等待管理员审批</strong><p>会议全文和最终纪要生成后会自动提交 OA；管理员批准后正式归档。</p></div></div>}
      {session.phase === 'archived' && <div className="oa-meeting-complete"><CheckCircle2 size={22} /><div><strong>会议已归档</strong><p>会议全文和纪要已通过管理员审批并进入 OA 知识库。</p></div></div>}
      {session.phase === 'generating_minutes' && <div className="oa-meeting-complete"><FileText size={22} /><div><strong>会议材料已保留</strong><p>{session.exitStatus === 'uncertain' ? '请先在飞书确认机器人已经离会，再继续生成纪要。' : '纪要任务尚未成功提交，可以重试。'}</p></div></div>}
      <div className="oa-meeting-actions">{active && <><button type="button" disabled={busy} onClick={generateLiveMinutes}><FileText size={17} />生成当前全文和纪要</button><button type="button" className="oa-meeting-danger" disabled={busy} onClick={() => void finish()}><LogOut size={17} />{busy ? '正在结束…' : '结束会议'}</button></>}{session.phase === 'generating_minutes' && <button type="button" disabled={busy} onClick={() => { const current = sessionRef.current; if (current.exitStatus === 'uncertain' && !window.confirm('仅在飞书确认机器人已经离会或会议已经结束后继续。确认生成纪要？')) return; submitMinutes({ ...current, exitStatus: 'confirmed', endedAt: current.endedAt || new Date().toISOString() }); }}><FileText size={17} />{session.exitStatus === 'uncertain' ? '已确认离会，生成最终材料' : '重新提交最终材料'}</button>}{!active && ['pending_confirmation', 'archived'].includes(session.phase) && <button type="button" onClick={reset}><RotateCcw size={17} />新建会议</button>}</div>
    </div>}
    {error && <p className="oa-meeting-error" role="alert">{error}</p>}
    <footer>现场状态保存在当前浏览器标签页。发送会议号即表示已告知参会人；会议结束后全文和纪要自动提交 OA，管理员批准后归档。</footer>
  </article>;
});

'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Bot, CheckCircle2, CircleDot, FileText, Flag, LogOut, Plus, RotateCcw, UsersRound, X } from 'lucide-react';
import { buildMeetingMinutesMaterial, isMeetingModeSession, meetingModeStorageKey, MEETING_MARKER_LABELS, type MeetingMarkerType, type MeetingModeSession, type MeetingTranscriptItem } from '@/lib/oa-meeting-mode.mjs';
import { useOaConversation } from './oa-conversation-context';
import './oa-meeting-mode.css';

type BotReply = { error?: string; message?: string; state?: string; meetingId?: string | null; meetingNumber?: string; outcomeUnknown?: boolean; diagnostic?: string; code?: number };
type EventReply = { error?: string; state?: string; transcript?: MeetingTranscriptItem[]; participants?: string[]; pageToken?: string | null; hasMore?: boolean; contentTruncated?: boolean; meetingEnded?: boolean; meeting?: { topic?: string; startTime?: string; endTime?: string } };
type Props = {
  visible: boolean;
  initialTitle?: string;
  commandEpoch?: number;
  onRestore: () => void;
  onClose: () => void;
  onMinutes: (title: string, material: string, onAccepted: (taskId: string) => void) => boolean;
};
export type OaMeetingModeHandle = { end: () => Promise<void> };

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

export const OaMeetingMode = forwardRef<OaMeetingModeHandle, Props>(function OaMeetingMode({ visible, initialTitle = '', commandEpoch = 0, onRestore, onClose, onMinutes }, ref) {
  const { user } = useOaConversation();
  const storageKey = meetingModeStorageKey(user.email);
  const [session, setSession] = useState<MeetingModeSession>(() => emptySession(initialTitle));
  const sessionRef = useRef(session);
  const [password, setPassword] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('填写会议信息后，OA 助手会加入正在进行的飞书会议。');
  const [markerType, setMarkerType] = useState<MeetingMarkerType>('decision');
  const [markerText, setMarkerText] = useState('');
  const pageToken = useRef<string | null>(null);
  const [remoteEnded, setRemoteEnded] = useState(false);
  const pollPromise = useRef<Promise<void> | null>(null);
  const mutationBusy = useRef(false);
  const restored = useRef(false);

  useEffect(() => { sessionRef.current = session; }, [session]);
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
    if (initialTitle && sessionRef.current.phase === 'draft') setSession(current => ({ ...current, title: initialTitle }));
  }, [initialTitle, commandEpoch]);

  useEffect(() => {
    if (session.phase !== 'pending_confirmation' || !session.minutesTaskId) return;
    let current = true;
    const verify = async () => {
      try {
        const response = await fetch(`/api/lab-ai/archive?id=${encodeURIComponent(session.minutesTaskId!)}`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) });
        const data = await response.json().catch(() => ({})) as { lifecycle?: { state?: string } };
        if (!current || !response.ok || data.lifecycle?.state !== 'submitted') return;
        setSession(previous => previous.minutesTaskId === session.minutesTaskId ? { ...previous, phase: 'archived' } : previous);
        setNotice('会议纪要已提交 OA；后续审批与入库状态可在文档卡片和知识管理中核对。'); setError('');
      } catch { /* The document editor remains the authoritative recovery UI. */ }
    };
    const update = () => { if (document.visibilityState !== 'hidden') void verify(); };
    void verify(); window.addEventListener('oa-files-archived', update); document.addEventListener('visibilitychange', update);
    return () => { current = false; window.removeEventListener('oa-files-archived', update); document.removeEventListener('visibilitychange', update); };
  }, [session.phase, session.minutesTaskId]);

  const patch = (values: Partial<MeetingModeSession>) => setSession(current => ({ ...current, ...values }));
  const start = async () => {
    const current = sessionRef.current;
    if (mutationBusy.current || current.phase !== 'draft') return;
    if (!current.title.trim()) { setError('请填写会议标题。'); return; }
    if (!current.meeting.trim()) { setError('请填写九位会议号或飞书会议链接。'); return; }
    if (!confirmed) { setError('请先确认已告知参会人 OA 助手将加入并记录会议。'); return; }
    mutationBusy.current = true; setBusy(true); setError(''); setNotice('正在请求 OA 助手加入飞书会议…'); patch({ phase: 'waiting_to_join', exitStatus: 'not_requested' });
    try {
      const data = await botRequest({ action: 'join', meeting: current.meeting, password, confirmed: true });
      setPassword('');
      if (data.state !== 'join_api_succeeded' || !data.meetingId) {
        patch({ phase: 'waiting_to_join' });
        setError('飞书入会接口已响应，但没有返回可用于退出和读取转写的会议 ID。请先在参会人列表核对，勿重复入会。');
        return;
      }
      const startedAt = new Date().toISOString();
      patch({ phase: 'in_meeting', meetingId: data.meetingId, meeting: data.meetingNumber || current.meeting, startedAt, endedAt: null, exitStatus: 'not_requested' });
      setNotice(data.message || 'OA 助手已请求入会，正在读取会中事件。'); pageToken.current = null; setRemoteEnded(false);
    } catch (cause) {
      const outcomeUnknown = cause instanceof MeetingBotRequestError && cause.outcomeUnknown;
      patch({ phase: outcomeUnknown ? 'waiting_to_join' : 'draft' });
      setError(outcomeUnknown ? `${errorText(cause, '入会结果未确认。')} 请先查看飞书参会人列表，勿重复入会。` : errorText(cause, '入会请求失败，未确认机器人加入。'));
    } finally { mutationBusy.current = false; setPassword(''); setBusy(false); }
  };

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
        const updated = { ...base, title: base.title || data.meeting?.topic || '', transcript, observedParticipants: participants };
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
    if (!onMinutes(completed.title || '会议纪要', material, accepted)) { setError('纪要任务未能提交，会议材料仍保留在当前页面。'); return false; }
    setSession({ ...completed, phase: 'pending_confirmation' });
    setNotice('会议纪要任务已提交。生成后会自动打开；请核对正文，再点击“提交 OA”。'); setError('');
    return true;
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
  useImperativeHandle(ref, () => ({ end: finish }), [finish]);

  const addMarker = () => {
    const text = markerText.trim(); if (!text || text.length > 2000) { setError('标记内容需为 1–2,000 个字符。'); return; }
    if (session.markers.length >= 500) { setError('会中标记已达 500 条上限；请结束会议并生成纪要。'); return; }
    patch({ markers: [...session.markers, { id: crypto.randomUUID(), type: markerType, text, createdAt: new Date().toISOString() }] });
    setMarkerText(''); setError('');
  };
  const reset = () => {
    if (session.phase === 'in_meeting' || session.phase === 'waiting_to_join') return;
    try { sessionStorage.removeItem(storageKey); } catch { /* Best effort. */ }
    setSession(emptySession()); setPassword(''); setConfirmed(false); pageToken.current = null; setRemoteEnded(false); setError(''); setNotice('填写会议信息后，OA 助手会加入正在进行的飞书会议。');
  };
  const clearJoinLock = () => {
    if (!window.confirm('请先在飞书确认机器人没有入会，或已经由主持人移出。此操作只解除本地锁定，不会控制飞书机器人。确认继续？')) return;
    const current = sessionRef.current;
    const draft: MeetingModeSession = { ...current, phase: 'draft', meetingId: null, startedAt: null, endedAt: null, exitStatus: 'not_requested', minutesTaskId: null, transcript: [], observedParticipants: [] };
    sessionRef.current = draft; setSession(draft); setPassword(''); setConfirmed(false); setError(''); setNotice('本地入会锁定已解除；如需重试，请重新确认参会人知情。');
  };
  if (!visible) return null;

  const active = session.phase === 'in_meeting';
  const setupLocked = busy || session.phase === 'waiting_to_join';
  return <article className="oa-meeting-mode" aria-label="会议模式">
    <header className="oa-meeting-header"><div><span className={active ? 'live' : ''}><CircleDot size={14} />{phaseLabels[session.phase]}</span><h2><Bot size={22} />会议模式</h2><p>{notice}</p></div>{!active && session.phase === 'draft' && <button type="button" className="oa-meeting-close" aria-label="关闭会议模式" onClick={() => { reset(); onClose(); }}><X size={20} /></button>}</header>
    {session.phase === 'draft' || session.phase === 'waiting_to_join' ? <div className="oa-meeting-setup">
      <label>会议标题<input value={session.title} maxLength={100} disabled={setupLocked} onChange={event => patch({ title: event.target.value })} placeholder="例如：机器人项目周会" /></label>
      <label>飞书会议号或链接<input value={session.meeting} maxLength={512} disabled={setupLocked} onChange={event => patch({ meeting: event.target.value })} placeholder="123456789 或 https://vc.feishu.cn/j/…" /></label>
      <label>会议密码（没有则留空）<input type="password" value={password} maxLength={128} disabled={setupLocked} onChange={event => setPassword(event.target.value)} autoComplete="off" /></label>
      <label>参会人<textarea value={session.participants} maxLength={2000} disabled={setupLocked} onChange={event => patch({ participants: event.target.value })} rows={2} placeholder="姓名或团队，一行一个也可以" /></label>
      <label>议程<textarea value={session.agenda} maxLength={4000} disabled={setupLocked} onChange={event => patch({ agenda: event.target.value })} rows={3} placeholder="本次会议需要讨论和决定什么？" /></label>
      <label className="oa-meeting-consent"><input type="checkbox" checked={confirmed} disabled={setupLocked} onChange={event => setConfirmed(event.target.checked)} /><span>我确认会议号无误，并已告知参会人 OA 助手将加入、读取会中转写并用于生成内部会议纪要。</span></label>
      <button type="button" className="oa-meeting-primary" disabled={setupLocked || !confirmed || !session.title.trim() || !session.meeting.trim()} onClick={() => void start()}>{busy ? '正在连接…' : <><Bot size={17} />启动会议模式</>}</button>
      {session.phase === 'waiting_to_join' && <button type="button" className="oa-meeting-recovery" disabled={busy} onClick={clearJoinLock}><RotateCcw size={17} />主持人已核对，解除入会锁定</button>}
    </div> : <div className="oa-meeting-console">
      <section className="oa-meeting-summary"><div><strong>{session.title}</strong><small>{session.startedAt ? new Date(session.startedAt).toLocaleString('zh-CN') : '尚未开始'} · {session.observedParticipants.length} 位已识别参会人</small></div><span><CircleDot size={14} />{active ? remoteEnded ? '飞书已结束' : '记录中' : phaseLabels[session.phase]}</span></section>
      {active && <div className="oa-meeting-live-grid">
        <section><h3><UsersRound size={17} />实时转写 <small>{session.transcript.length} 条</small></h3><div className="oa-meeting-transcript">{session.transcript.length ? session.transcript.slice(-100).map(item => <p key={item.id}><time>{new Date(item.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time><strong>{item.speaker}</strong><span>{item.text}</span></p>) : <div className="oa-meeting-empty">正在等待飞书会中转写；主持人可能需要放行机器人，并确认应用具有事件读取权限。</div>}</div></section>
        <section><h3><Flag size={17} />会中标记</h3><div className="oa-meeting-marker-compose"><select value={markerType} onChange={event => setMarkerType(event.target.value as MeetingMarkerType)}>{Object.entries(MEETING_MARKER_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><textarea value={markerText} maxLength={2000} rows={3} onChange={event => setMarkerText(event.target.value)} placeholder="记录决策、待办、风险或重要内容" /><button type="button" disabled={!markerText.trim()} onClick={addMarker}><Plus size={16} />添加标记</button></div><div className="oa-meeting-markers">{session.markers.map(item => <p key={item.id}><b>{MEETING_MARKER_LABELS[item.type]}</b><span>{item.text}</span><button type="button" aria-label="删除标记" onClick={() => patch({ markers: session.markers.filter(marker => marker.id !== item.id) })}><X size={14} /></button></p>)}</div></section>
      </div>}
      {session.phase === 'pending_confirmation' && <div className="oa-meeting-complete"><CheckCircle2 size={22} /><div><strong>纪要正在生成或等待确认</strong><p>生成结果会作为“会议纪要”文档出现在聊天中。核对后可提交 OA，审批通过后才进入知识库。</p></div></div>}
      {session.phase === 'archived' && <div className="oa-meeting-complete"><CheckCircle2 size={22} /><div><strong>会议纪要已提交 OA</strong><p>会议模式已归档；文档仍需按 OA 审批流程核对，审批通过后才进入知识库。</p></div></div>}
      {session.phase === 'generating_minutes' && <div className="oa-meeting-complete"><FileText size={22} /><div><strong>会议材料已保留</strong><p>{session.exitStatus === 'uncertain' ? '请先在飞书确认机器人已经离会，再继续生成纪要。' : '纪要任务尚未成功提交，可以重试。'}</p></div></div>}
      <div className="oa-meeting-actions">{active && <button type="button" className="oa-meeting-danger" disabled={busy} onClick={() => void finish()}><LogOut size={17} />{busy ? '正在结束…' : '结束并生成纪要'}</button>}{session.phase === 'generating_minutes' && <button type="button" disabled={busy} onClick={() => { const current = sessionRef.current; if (current.exitStatus === 'uncertain' && !window.confirm('仅在飞书确认机器人已经离会或会议已经结束后继续。确认生成纪要？')) return; submitMinutes({ ...current, exitStatus: 'confirmed', endedAt: current.endedAt || new Date().toISOString() }); }}><FileText size={17} />{session.exitStatus === 'uncertain' ? '已确认离会，仅生成纪要' : '重新提交纪要'}</button>}{!active && ['pending_confirmation', 'archived'].includes(session.phase) && <button type="button" onClick={reset}><RotateCcw size={17} />新建会议</button>}</div>
    </div>}
    {error && <p className="oa-meeting-error" role="alert">{error}</p>}
    <footer>现场状态仅保存在当前浏览器标签页；密码不会保存。纪要任务提交后沿用 OA 现有权限、保存与审批流程。</footer>
  </article>;
});

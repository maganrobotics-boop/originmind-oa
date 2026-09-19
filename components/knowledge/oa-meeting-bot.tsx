'use client';

import { useEffect, useRef, useState } from 'react';
import { captureText, MEETING_INSTRUCTION, meetingParts, mergeCapture, type MeetingEntry } from '@/lib/oa-meeting-capture.mjs';

type BotSession = { id: string; meeting: { id: string; number: string; title: string }; state: string; lastVerifiedAt: number; code?: string };
type Reply = { error?: string; code?: string; logId?: string; configured?: boolean; sessions?: BotSession[]; session?: BotSession; message?: string; active?: boolean; entries?: MeetingEntry[]; cursor?: string; hasMore?: boolean; checkedAt?: number; unsupported?: number; left?: boolean; task?: { id: string; status: string } };
type Part = { requestId: string; title: string; material: string; done?: boolean };
const API = '/api/lab-ai/meeting-bot';
const readable = (session: BotSession | null) => Boolean(session && ['accepted', 'verified'].includes(session.state));
const labels: Record<string, string> = { joining: '入会请求处理中／待核实', accepted: '请求已接受，尚未核验读取', verified: '曾成功读取，当前状态需重新核验', join_unknown: '入会结果未知，勿重复呼叫', failed: '入会未完成', leaving: '退出请求处理中／待核实', leave_unknown: '退出结果未知，请主持人核对', left: '已收到退出成功响应' };
const message = (cause: unknown) => cause instanceof Error ? cause.message : '操作未完成，请核对会议状态。';

/** Visible application bot. Page closure stops capture, not the independent participant. */
export function OaMeetingBot({ open, onTask, onDirty }: { open: boolean; onTask: (id: string) => Promise<void>; onDirty: (dirty: boolean) => void }) {
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [running, setRunning] = useState(false);
  const [sessions, setSessions] = useState<BotSession[]>([]), [selected, setSelected] = useState<BotSession | null>(null);
  const [number, setNumber] = useState(''), [password, setPassword] = useState(''), [consent, setConsent] = useState(false);
  const [status, setStatus] = useState('尚未检查独立入会配置'), [error, setError] = useState('');
  const [count, setCount] = useState(0), [lastSync, setLastSync] = useState(0), [preview, setPreview] = useState('');
  const [tasks, setTasks] = useState<Array<{ id: string; title: string }>>([]);
  const mounted = useRef(true), lock = useRef(false), epoch = useRef(0), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controllers = useRef(new Set<AbortController>()), captured = useRef(new Map<string, MeetingEntry>());
  const active = useRef<BotSession | null>(null), cursor = useRef(''), pages = useRef(0), seen = useRef(new Set<string>());
  const frozen = useRef<Part[] | null>(null), attempt = useRef<{ target: string; id: string } | null>(null);
  const callbacks = useRef({ onTask, onDirty });
  useEffect(() => { callbacks.current = { onTask, onDirty }; }, [onTask, onDirty]);

  const pause = () => { epoch.current++; if (timer.current) clearTimeout(timer.current); timer.current = null; if (mounted.current) setRunning(false); };
  useEffect(() => {
    mounted.current = true;
    const hidden = () => { if (document.hidden) { epoch.current++; if (timer.current) clearTimeout(timer.current); setRunning(false); setStatus('页面进入后台，文字采集已暂停；机器人不会因此退出会议。'); } };
    const warn = (event: BeforeUnloadEvent) => { if (captured.current.size) { event.preventDefault(); event.returnValue = ''; } };
    document.addEventListener('visibilitychange', hidden); window.addEventListener('beforeunload', warn);
    return () => { mounted.current = false; epoch.current++; if (timer.current) clearTimeout(timer.current); for (const controller of controllers.current) controller.abort(); document.removeEventListener('visibilitychange', hidden); window.removeEventListener('beforeunload', warn); };
  }, []);

  const request = async (body?: object, path = API, timeout = 30000): Promise<Reply> => {
    const controller = new AbortController(); controllers.current.add(controller);
    try {
      const response = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]) });
      const result = await response.json().catch(() => ({})) as Reply;
      if (!response.ok) throw new Error(`${result.error || '服务暂不可用，未确认操作成功。'}${result.code ? ` [${result.code}]` : ''}${result.logId ? ` 日志编号：${result.logId}` : ''}`);
      return result;
    } finally { controllers.current.delete(controller); }
  };
  const remember = (session: BotSession) => {
    active.current = session; setSelected(session);
    setSessions(old => [session, ...old.filter(item => item.id !== session.id)]);
  };
  const refresh = async () => {
    const result = await request();
    if (!mounted.current) return;
    setReady(result.configured === true); setSessions(result.sessions || []);
    if (active.current) {
      const updated = result.sessions?.find(item => item.id === active.current?.id);
      if (updated) remember(updated);
    }
    setStatus('配置可用不等于入会成功。请选择已有记录，或确认会议号后发起独立入会。');
  };
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    void request().then(result => { if (!disposed) { setReady(result.configured === true); setSessions(result.sessions || []); setStatus('独立入会配置可用；尚未核实飞书权限及当前参会状态。'); } }).catch(cause => { if (!disposed) { setReady(false); setError(message(cause)); } });
    return () => { disposed = true; };
    // Opening the panel only reads configuration; it never joins or resumes capture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const poll = async (version: number) => {
    const current = active.current;
    if (!current || !mounted.current || version !== epoch.current) return;
    try {
      const page = await request({ action: 'poll', sessionId: current.id, cursor: cursor.current });
      if (!mounted.current || version !== epoch.current) return;
      if (page.active !== true || !page.session || !Array.isArray(page.entries) || typeof page.cursor !== 'string' || typeof page.hasMore !== 'boolean' || typeof page.checkedAt !== 'number') throw new Error('会议事件响应异常，未推进游标。');
      if (page.hasMore && (pages.current >= 200 || seen.current.has(page.cursor))) throw new Error('分页达到安全上限或游标循环，采集已暂停。');
      captured.current = mergeCapture(captured.current, page.entries); cursor.current = page.cursor;
      if (page.hasMore) { pages.current++; seen.current.add(page.cursor); } else { pages.current = 0; seen.current.clear(); }
      remember(page.session); setCount(captured.current.size); setLastSync(page.checkedAt);
      setPreview([...captured.current.values()].slice(-6).map(entry => `${entry.actor.name}：${entry.text}`).join('\n'));
      callbacks.current.onDirty(true);
      setStatus(`应用身份读取已核验；${page.hasMore ? '正在补拉分页' : '最近一次读取成功'}${page.unsupported ? `，本页 ${page.unsupported} 个事件未解析` : ''}。这不代表已覆盖整场会议。`);
      timer.current = setTimeout(() => void poll(version), page.hasMore ? 250 : 5000);
    } catch (cause) { if (mounted.current && version === epoch.current) { pause(); setError(message(cause)); setStatus('采集已暂停，当前参会状态未重新确认；错误不等于机器人已经退出。'); } }
  };

  const generate = async () => {
    const current = active.current;
    if (!current) throw new Error('请先选择对应的入会记录。');
    if (![...captured.current.values()].some(entry => (entry.kind === 'transcript' || entry.kind === 'chat') && entry.text.trim() && !entry.text.startsWith('[非文本消息'))) throw new Error('没有可用于纪要的字幕或文字聊天，不调用模型。');
    pause();
    if (!frozen.current) {
      const materials = meetingParts(captureText(captured.current, current.meeting.title));
      frozen.current = materials.map((material, index) => ({ requestId: crypto.randomUUID(), title: `${current.meeting.title.slice(0, 65)} · 纪要 ${index + 1}/${materials.length}`, material: `第 ${index + 1}/${materials.length} 段，仅此段材料，不能视为全会总结。\n${material}` }));
    }
    for (const part of frozen.current) {
      if (!mounted.current) return;
      if (part.done) continue;
      const created = await request({ action: 'create', requestId: part.requestId, kind: 'meeting_minutes', title: part.title, instruction: MEETING_INSTRUCTION, material: part.material }, '/api/lab-ai/tasks');
      if (!created.task?.id) throw new Error('未取得纪要任务编号，请保留页面并核对提交。');
      let task = created.task;
      setTasks(old => old.some(item => item.id === task.id) ? old : [...old, { id: task.id, title: part.title }]);
      if (task.status === 'queued') task = (await request({ action: 'run', id: task.id }, '/api/lab-ai/tasks', 80000)).task || task;
      await callbacks.current.onTask(task.id);
      if (task.status !== 'succeeded') throw new Error('纪要任务已保存但尚未生成成功。请在文档卡中核对或重试，再继续剩余分段。');
      part.done = true;
    }
    setStatus('已采集片段的纪要已生成，可编辑、下载及提交 OA 审核；不会自动入库或公开。机器人没有因此退出会议。');
  };
  const perform = async (action: 'join' | 'capture' | 'leave' | 'refresh' | 'generate') => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      if (action === 'refresh') await refresh();
      else if (action === 'join') {
        if (captured.current.size || frozen.current) throw new Error('本页已有会议材料，请先导出或保存；加入另一场会议请另开 OA 页面。');
        if (!consent) throw new Error('请先确认入会及采集告知。');
        if (!attempt.current || attempt.current.target !== number || sessions.some(item => item.id === attempt.current?.id && ['failed', 'left'].includes(item.state))) attempt.current = { target: number, id: crypto.randomUUID() };
        const result = await request({ action: 'join', requestId: attempt.current.id, meetingNumber: number, password, consent });
        setPassword('');
        if (!result.session) throw new Error('未取得入会记录，请刷新核对，不要连续呼叫。');
        remember(result.session); setStatus(result.message || labels[result.session.state] || '请核对会议状态');
      } else if (action === 'capture') {
        if (!readable(active.current)) throw new Error('请先选择已取得会议长 ID 的入会记录。');
        if (frozen.current) throw new Error('本页纪要源材料已冻结；继续采集请另开 OA 页面并恢复此记录。');
        pause(); pages.current = 0; seen.current.clear(); setRunning(true); setStatus('正在以应用身份核验并读取；尚不能视为采集成功…');
        void poll(++epoch.current);
      } else if (action === 'generate') await generate();
      else {
        const current = active.current;
        if (!current || !window.confirm(`确认只让 OA 助手退出会议 ${current.meeting.number}？不会结束其他人的会议。`)) return;
        pause();
        const result = await request({ action: 'leave', sessionId: current.id, confirmLeave: true });
        if (!result.left || !result.session) throw new Error('未取得退出成功确认，请核对参会人列表。');
        remember(result.session); setStatus('飞书已确认助手退出；已采集文字仍在本页，可继续制作纪要。');
      }
    } catch (cause) { if (mounted.current) setError(message(cause)); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const download = () => {
    const blob = new Blob([captureText(captured.current, active.current?.meeting.title)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `OA助手-${active.current?.meeting.number || '会议'}-已采集片段.txt`; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="oa-meeting-body" hidden={!open} style={open ? undefined : { display: 'none' }} aria-label="OA 助手独立入会">
    <h3>OA 助手独立入会</h3>
    <p>助手以飞书应用机器人身份加入，参会人可见。当前实现不发声、不自动接听飞书呼叫。请由 OA 管理员在这里明确发起入会。</p>
    <p role="status">{status}</p>{error && <p className="oa-chat-error" role="alert">{error}</p>}
    <button type="button" disabled={busy || running} onClick={() => void perform('refresh')}>检查配置／恢复入会记录</button>
    {!!sessions.length && <label>选择本账号的入会记录<select value={selected?.id || ''} disabled={busy || running} onChange={event => {
      if (captured.current.size || frozen.current) { setError('本页仍有会议材料，不能直接切换记录；请导出后另开页面。'); return; }
      const next = sessions.find(item => item.id === event.target.value) || null; active.current = next; setSelected(next); cursor.current = ''; if (next) setStatus(labels[next.state] || next.state);
    }}><option value="">请选择，不自动加入或开始采集</option>{sessions.map(item => <option key={item.id} value={item.id}>{item.meeting.number} · {labels[item.state] || item.state}</option>)}</select></label>}
    <label>会议号或飞书会议链接<input value={number} maxLength={256} autoComplete="off" onChange={event => { setNumber(event.target.value); setConsent(false); }} placeholder="9 位会议号，或 https://vc.feishu.cn/j/…" disabled={busy || running} /></label>
    <label>会议密码（有密码时填写）<input type="password" value={password} maxLength={128} autoComplete="off" onChange={event => setPassword(event.target.value)} disabled={busy || running} /></label>
    <label className="oa-meeting-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} disabled={busy} />已核对目标会议号并告知参会成员；同意 OA 助手作为可见参会者加入、读取字幕及聊天，纪要提交 OA 审核后才入库。</label>
    <button type="button" disabled={!ready || busy || running || !consent || !number.trim() || count > 0} onClick={() => void perform('join')}>让 OA 助手加入这场会议</button>
    {selected && <p>会议 {selected.meeting.number}：{labels[selected.state] || selected.state}。最近核验：{selected.lastVerifiedAt ? new Date(selected.lastVerifiedAt).toLocaleString() : '尚无'}。</p>}
    {readable(selected) && !running && <button type="button" disabled={busy || Boolean(frozen.current)} onClick={() => void perform('capture')}>核验入会并开始／继续采集</button>}
    {running && <button type="button" disabled={busy} onClick={() => { pause(); setStatus('本页采集已暂停，机器人仍可能在会中。'); }}>暂停本页采集（不退出会议）</button>}
    {readable(selected) && <button type="button" disabled={busy} onClick={() => void perform('leave')}>让 OA 助手退出会议</button>}
    <small>本页已采集 {count} 条；最近成功读取：{lastSync ? new Date(lastSync).toLocaleTimeString() : '尚无'}。</small>
    {!!count && <><button type="button" onClick={download}>导出已采集原文</button><button type="button" disabled={busy} onClick={() => void perform('generate')}>生成／继续生成已采集纪要</button></>}
    {preview && <pre className="oa-meeting-preview">{preview}</pre>}
    {tasks.map(task => <button type="button" key={task.id} onClick={() => void callbacks.current.onTask(task.id)}>打开 {task.title}</button>)}
    <p><strong>关闭页面不会让机器人退出。</strong> 当前字幕采集仍需页面保持前台；刷新会丢失未保存原文。入会记录可恢复，但不代表原文已保存，也不保证补齐断线期间内容。没有字幕时不会凭空生成纪要。</p>
    <details><summary>管理员接入条件</summary><p>应用需发布 vc:meeting.bot.join:write 权限并安装到对应租户；配置权限数据范围，取得飞书要求的开放资格，会议允许智能体加入。OA 需启用独立入会配置并初始化入会控制记录表。不会自动修改飞书权限、开放会控、接听呼叫或公开会议资料。</p></details>
  </div>;
}

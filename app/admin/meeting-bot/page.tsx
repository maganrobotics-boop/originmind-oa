'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

type Status = { configured: boolean; enabled: boolean; missing: string[]; actorKey: string };
type RecordItem = { meetingId: string | null; meetingNumber: string; requestedAt: string };
type Result = { error?: string; message?: string; code?: number; logId?: string; diagnostic?: string; state?: string; meetingId?: string | null; meetingNumber?: string; outcomeUnknown?: boolean };
function jsonRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function isStatus(value: unknown): value is Status {
  const row = jsonRecord(value);
  return typeof row.configured === 'boolean' && typeof row.enabled === 'boolean' && typeof row.actorKey === 'string'
    && Array.isArray(row.missing) && row.missing.every((item: unknown) => typeof item === 'string');
}
const endpoint = '/api/admin/meeting-bot';
const box = { padding: '16px', border: '1px solid #d9dee6', borderRadius: '12px', marginTop: '16px' };
const inputStyle = { display: 'block', width: '100%', padding: '12px', margin: '8px 0 16px', border: '1px solid #aeb8c6', borderRadius: '8px' };
const buttonStyle = { padding: '10px 16px', margin: '6px 8px 6px 0', border: '1px solid #aeb8c6', borderRadius: '8px' };

export default function MeetingBotPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [meeting, setMeeting] = useState('');
  const [password, setPassword] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('正在检查 OA 管理员权限和服务器配置…');
  const [last, setLast] = useState<RecordItem | null>(null);
  const [leaveId, setLeaveId] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const storageKey = status ? `oa:meeting-bot:v1:${status.actorKey}` : '';

  useEffect(() => {
    let active = true;
    void fetch(endpoint, { credentials: 'same-origin', cache: 'no-store' }).then(async response => {
      const data: unknown = await response.json();
      if (!active) return;
      if (!response.ok) { const error = jsonRecord(data).error; setNotice(typeof error === 'string' ? error : '无法检查管理员权限。'); return; }
      if (!isStatus(data)) { setNotice('OA 配置响应不完整；未启用入会。'); return; }
      setStatus(data);
      setNotice(data.configured ? (data.enabled ? '服务器已启用入会入口；尚未验证飞书权限或实际入会。' : '服务器配置已具备，但入会开关尚未启用。可先检查应用连接。') : `服务器还缺少配置：${data.missing.join('、')}。`);
      try {
        const saved = JSON.parse(sessionStorage.getItem(`oa:meeting-bot:v1:${data.actorKey}`) || 'null');
        if (saved && typeof saved.meetingNumber === 'string' && typeof saved.requestedAt === 'string' && (saved.meetingId === null || (typeof saved.meetingId === 'string' && /^\d{10,32}$/u.test(saved.meetingId)))) {
          setLast(saved); setLeaveId(typeof saved.meetingId === 'string' ? saved.meetingId : '');
          setUncertain(true);
          setNotice('发现本标签页之前的操作记录；这不是实时参会状态。请先在飞书核对机器人，勿重复入会。');
        }
      } catch { /* Browser storage is optional, never an authentication source. */ }
    }).catch(() => { if (active) setNotice('OA 状态读取失败；未发送入会请求。'); });
    return () => { active = false; };
  }, []);

  async function perform(action: 'check' | 'join' | 'leave') {
    if (busy || !status) return;
    if (action === 'leave' && !window.confirm('确认仅让 OA 应用机器人退出这场会议？不会结束整场会议。')) return;
    setBusy(true); setNotice('正在请求飞书…');
    const body = action === 'check' ? { action } : action === 'join' ? { action, meeting, password, confirmed } : { action, meetingId: leaveId, confirmed: true };
    // Persist intent before the network call, so a refresh does not suggest retrying a possibly successful join.
    if (action === 'join') {
      const pending = { meetingId: null, meetingNumber: meeting, requestedAt: new Date().toISOString() };
      setLast(pending); setUncertain(true);
      try { sessionStorage.setItem(storageKey, JSON.stringify(pending)); } catch { /* Warn below about non-persistent state. */ }
    }
    try {
      const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      const data = await response.json() as Result;
      setNotice((data.error || data.message || '接口未返回明确结果，请核对飞书参会人列表。') + (data.diagnostic ? ` 诊断码：${data.diagnostic}。` : '') + (data.code !== undefined ? ` 错误码：${data.code}。` : '') + (data.logId ? ` 日志号：${data.logId}。` : ''));
      if (!response.ok) {
        if (action === 'join' && data.outcomeUnknown === false) {
          setLast(null); setUncertain(false);
          try { sessionStorage.removeItem(storageKey); } catch { /* Local storage is best effort. */ }
        }
        return;
      }
      if (action === 'join' && data.state === 'join_api_succeeded') {
        const record = { meetingId: data.meetingId || null, meetingNumber: data.meetingNumber || meeting, requestedAt: new Date().toISOString() };
        setLast(record); setLeaveId(record.meetingId || ''); setUncertain(true);
        try { sessionStorage.setItem(storageKey, JSON.stringify(record)); } catch { setNotice(previous => `${previous} 浏览器不能保存记录，请立即记下会议 ID。`); }
      }
      if (action === 'leave' && data.state === 'leave_api_succeeded') {
        setLast(null); setUncertain(false); setLeaveId('');
        try { sessionStorage.removeItem(storageKey); } catch { /* Local storage is best effort. */ }
      }
    } catch {
      setNotice('网络中断，操作结果不明确。请先查看飞书参会人列表，勿重复入会；需要时由主持人移出机器人。');
      setUncertain(true);
    } finally { setBusy(false); if (action === 'join') setPassword(''); }
  }
  function clearAfterHostCheck() {
    if (!window.confirm('请先在飞书确认机器人已经离会。此按钮只清除本地记录，不执行退出。确认已离会？')) return;
    setLast(null); setLeaveId(''); setUncertain(false); setConfirmed(false);
    try { sessionStorage.removeItem(storageKey); } catch { /* Local storage is best effort. */ }
    setNotice('本地记录已清除；未向飞书发送任何入会或退出请求。');
  }

  return <main style={{ maxWidth: '760px', margin: '0 auto', padding: '24px 16px 60px', lineHeight: 1.7 }}>
    <nav><Link href="/">返回 OA</Link>{' · '}<Link href="/admin/meeting-minutes">成员会议纪要</Link></nav>
    <h1>飞书会议机器人</h1>
    <p>以 OA 应用机器人身份独立入会，不是使用您个人账号旁听。本页仅管理员可操作。</p>
    <section style={box}>
      <h2>1. 检查配置</h2>
      <p role="status" aria-live="polite">{notice}</p>
      <button style={buttonStyle} disabled={busy || !status?.configured} onClick={() => void perform('check')}>检查应用连接（不入会）</button>
      <p>“应用连接通过”不等于权限已开通。入会需飞书应用权限 <code>vc:meeting.bot.join:write</code>、应用发布安装及对应数据范围；会议需允许智能体加入。</p>
    </section>
    <section style={box}>
      <h2>2. 邀请 OA 助手入会</h2>
      <label htmlFor="bot-meeting">九位会议号或飞书会议链接</label>
      <input id="bot-meeting" style={inputStyle} value={meeting} onChange={event => setMeeting(event.target.value)} maxLength={512} placeholder="请输入当前会议号" autoComplete="off" disabled={busy} />
      <label htmlFor="bot-password">会议密码（没有则留空）</label>
      <input id="bot-password" type="password" style={inputStyle} value={password} onChange={event => setPassword(event.target.value)} maxLength={128} autoComplete="off" disabled={busy} />
      <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy} /> 我确认会议号无误，已告知参会人将邀请 OA 助手加入。</label>
      <div><button style={buttonStyle} disabled={busy || !status?.configured || !status.enabled || !confirmed || !meeting.trim() || uncertain || Boolean(last)} onClick={() => void perform('join')}>让 OA 助手加入会议</button></div>
      <p>不会自动接听飞书“呼叫”，不会自动开始会议。本入口尚未接入字幕采集、自动纪要或发言。关闭 OA 页面不会让已入会的机器人退出。</p>
    </section>
    <section style={box}>
      <h2>3. 退出与恢复</h2>
      {last && <p>本标签页操作记录：{last.meetingNumber}<br />请求时间：{last.requestedAt}<br />会议 ID：{last.meetingId || '接口尚未返回；请由主持人核对并移出机器人。'}<br />此记录不表示机器人当前仍在会议中。</p>}
      <label htmlFor="bot-leave-id">入会接口返回的长数字会议 ID（不是九位会议号）</label>
      <input id="bot-leave-id" style={inputStyle} inputMode="numeric" value={leaveId} onChange={event => setLeaveId(event.target.value)} maxLength={32} disabled={busy} autoComplete="off" />
      <button style={buttonStyle} disabled={busy || !status?.configured || !/^\d{10,32}$/u.test(leaveId)} onClick={() => void perform('leave')}>让 OA 助手退出</button>
      <button style={buttonStyle} disabled={busy || !status || (!last && !uncertain)} onClick={clearAfterHostCheck}>主持人已移出，清除本地记录</button>
      <p>记录仅保存在当前浏览器标签页，不是服务器参会记录。跨设备或记录丢失时，请直接在飞书参会人列表中移出 OA 助手。关闭入会开关后仍保留退出接口。</p>
    </section>
  </main>;
}


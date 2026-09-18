'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { MeetingDetail, MeetingSummary } from '@/lib/admin-meeting-minutes';
import './admin-meeting-minutes.css';

const endpoint = '/api/admin/meeting-minutes';
const labels: Record<string, string> = { queued: '材料已提交，等待处理', running: '正在处理', succeeded: '成果已生成', failed: '处理失败，材料仍可查看', cancelled: '任务已取消' };
const time = (value: number) => new Date(value).toLocaleString('zh-CN');
function jsonRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
async function readJson(response: Response): Promise<Record<string, unknown>> {
  return jsonRecord(await response.json().catch(() => null));
}
function isMeetingSummary(value: unknown): value is MeetingSummary {
  const row = jsonRecord(value);
  return typeof row.id === 'string' && typeof row.title === 'string' && typeof row.status === 'string'
    && typeof row.uploader_name === 'string' && typeof row.created_at === 'number' && Number.isFinite(row.created_at)
    && typeof row.updated_at === 'number' && Number.isFinite(row.updated_at);
}
function isMeetingDetail(value: unknown): value is MeetingDetail {
  const row = jsonRecord(value);
  return typeof row.material === 'string' && typeof row.result === 'string' && typeof row.instruction === 'string' && isMeetingSummary(row);
}
class ReadError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function read(query: string, signal: AbortSignal) {
  const response = await fetch(`${endpoint}${query}`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]) });
  const data = await readJson(response);
  if (!response.ok) throw new ReadError(typeof data?.error === 'string' ? data.error : '读取失败，请稍后重试。', response.status);
  return data;
}
export function AdminMeetingMinutesLink() {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/session', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]) })
      .then(async response => response.ok ? readJson(response) : null)
      .then(data => { if (!controller.signal.aborted) setAllowed(data?.isAdmin === true && data?.ndaCompleted === true); })
      .catch(() => { /* No admin shortcut without a verified session; API still authorizes every request. */ });
    return () => controller.abort();
  }, []);
  return allowed ? <Link className="oa-document-text-button" href="/admin/meeting-minutes">成员会议纪要</Link> : null;
}

export function AdminMeetingMinutes() {
  const [items, setItems] = useState<MeetingSummary[]>([]), [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [selected, setSelected] = useState(''), [cursor, setCursor] = useState<string | null>(null), [nextCursor, setNextCursor] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState(0), [loading, setLoading] = useState(true), [error, setError] = useState(''), [detailError, setDetailError] = useState('');
  const [denied, setDenied] = useState(false), [epoch, setEpoch] = useState(0), [downloading, setDownloading] = useState(false);
  const downloadController = useRef<AbortController | null>(null);
  useEffect(() => () => downloadController.current?.abort(), []);
  useEffect(() => {
    let disposed = false, busy = false, blocked = false;
    const controller = new AbortController();
    async function refresh() {
      if (disposed || busy || blocked || document.visibilityState === 'hidden') return;
      busy = true;
      try {
        const data = await read(cursor ? `?cursor=${encodeURIComponent(cursor)}` : '', controller.signal);
        if (disposed) return;
        if (!Array.isArray(data.items) || !data.items.every(isMeetingSummary) || typeof data.checkedAt !== 'number' || !Number.isFinite(data.checkedAt) || (data.nextCursor !== null && typeof data.nextCursor !== 'string')) throw new Error('未取得有效列表，请重新核对。');
        setItems(data.items); setNextCursor(data.nextCursor); setCheckedAt(data.checkedAt); setError(''); setDenied(false);
        if (selected) {
          try {
            const response = await read(`?id=${encodeURIComponent(selected)}`, controller.signal);
            if (disposed) return;
            if (!isMeetingDetail(response.item) || response.item.id !== selected) throw new Error('未取得完整会议纪要。');
            setDetail(response.item); setDetailError('');
          } catch (cause) {
            if (cause instanceof ReadError && [401, 403].includes(cause.status)) throw cause;
            if (!disposed) { setDetail(null); setDetailError(cause instanceof Error ? cause.message : '内容读取失败。'); }
          }
        }
      } catch (cause) {
        if (disposed) return;
        if (cause instanceof ReadError && [401, 403].includes(cause.status)) {
          blocked = true; downloadController.current?.abort(); setItems([]); setDetail(null); setNextCursor(null); setCheckedAt(0); setDenied(true);
        }
        setError(cause instanceof Error ? cause.message : '连接中断，无法核对最新记录。');
      } finally { busy = false; if (!disposed) setLoading(false); }
    }
    const initial = window.setTimeout(() => { void refresh(); }, 0);
    const interval = window.setInterval(() => { void refresh(); }, 5000);
    const visible = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { disposed = true; controller.abort(); window.clearTimeout(initial); window.clearInterval(interval); document.removeEventListener('visibilitychange', visible); };
  }, [cursor, selected, epoch]);

  const show = (id: string) => { downloadController.current?.abort(); setSelected(id); setDetail(null); setDetailError(''); };
  const changePage = (value: string | null) => { show(''); setCursor(value); setItems([]); setNextCursor(null); setLoading(true); setCheckedAt(0); };
  async function download(format: 'source' | 'md' | 'docx') {
    if (!detail || downloading || denied) return;
    const target = detail;
    const controller = new AbortController(); downloadController.current = controller; setDownloading(true); setDetailError('');
    try {
      const response = await fetch(`${endpoint}?id=${encodeURIComponent(target.id)}&format=${format}`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) });
      if (!response.ok) {
        const data = await readJson(response);
        if ([401, 403].includes(response.status)) { setDenied(true); setItems([]); setDetail(null); setCheckedAt(0); setError(typeof data.error === 'string' ? data.error : '访问权限已变化，请重新登录。'); }
        throw new Error(typeof data.error === 'string' ? data.error : '文件暂不可下载。');
      }
      const expected = format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : format === 'md' ? 'text/markdown' : 'text/plain';
      if (response.headers.get('content-type')?.split(';')[0].trim() !== expected) throw new Error('未收到正确的文件，请重新登录或核对状态。');
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      if (!blob.size) throw new Error('文件为空，未下载。');
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `${target.title.replace(/[\/\\:*?"<>|\r\n\t]/gu, '_')}${format === 'source' ? '-提交材料.txt' : `.${format}`}`;
      document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (cause) { if (!controller.signal.aborted) setDetailError(cause instanceof Error ? cause.message : '下载失败。'); }
    finally { if (downloadController.current === controller) { downloadController.current = null; setDownloading(false); } }
  }
  return <main className="oa-meeting-admin">
    <header><Link href="/">返回 OA</Link><h1>成员会议纪要</h1><p>成员提交“会议纪要”任务后即可查看，不必等待 AI 处理完成或归档审批。未发送的本地附件不在此列表。</p><p>仅管理员可跨成员查看；不开放普通聊天、私聊或其他文档。查看不等于归档，知识库入库仍走原审批。</p></header>
    <section className="oa-meeting-toolbar" aria-label="更新状态"><span role="status">{loading ? '正在读取…' : checkedAt ? `${error ? '连接异常，以下为旧记录。' : '每 5 秒自动刷新。'}上次列表更新：${time(checkedAt)}` : '尚未取得有效记录。'}切到后台时暂停。</span><button type="button" onClick={() => setEpoch(value => value + 1)}>立即刷新</button></section>
    {error && <p className="oa-meeting-error" role="alert">{error}</p>}
    {!denied && <><div className="oa-meeting-pagination">{cursor && <><strong>正在查看历史页</strong><button type="button" onClick={() => changePage(null)}>返回最新上传</button></>}{nextCursor && <button type="button" onClick={() => changePage(nextCursor)}>更早记录</button>}<span>本页 {items.length} 条，最多 50 条</span></div>
    <div className="oa-meeting-columns"><section aria-label="会议纪要列表">{!loading && !error && !items.length && <p>暂无已提交的会议纪要任务。</p>}{items.map(item => <button className="oa-meeting-row" type="button" key={item.id} onClick={() => show(item.id)} aria-pressed={selected === item.id}><strong>{item.title}</strong><span>{item.uploader_name} · {time(item.created_at)}</span><span>{labels[item.status] || '状态待核对'}</span></button>)}</section>
    <section className="oa-meeting-detail" aria-label="会议纪要内容">{detailError && <p className="oa-meeting-error" role="alert">{detailError}</p>}{!selected && <p>选择一份纪要，查看成员提交的材料和已生成成果。</p>}{selected && !detail && !detailError && <p role="status">正在核对内容…</p>}{detail && detail.id === selected && <><h2>{detail.title}</h2><p>{detail.uploader_name} · 提交于 {time(detail.created_at)} · {labels[detail.status] || '状态待核对'}</p><div className="oa-meeting-downloads"><button type="button" disabled={downloading || Boolean(error)} onClick={() => void download('source')}>下载提交文字</button>{detail.status === 'succeeded' && <><button type="button" disabled={downloading || Boolean(error)} onClick={() => void download('docx')}>下载 Word 成果</button><button type="button" disabled={downloading || Boolean(error)} onClick={() => void download('md')}>下载 Markdown 成果</button></>}</div><h3>成员提交材料</h3><small>此处为提交给任务的文字，不代表原 PDF、图片或 DOCX 已永久保存。</small><pre>{detail.material}</pre><h3>处理要求</h3><pre>{detail.instruction}</pre>{detail.status === 'succeeded' && detail.result && <><h3>生成成果</h3><pre>{detail.result}</pre></>}<p>保留和清理仍遵循原文件生命周期；需要长期入库时由成员提交归档审批。</p></>}</section></div></>}
  </main>;
}

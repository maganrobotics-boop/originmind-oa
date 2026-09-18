'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Archive, FileText, FolderOpen, Plus, RotateCcw } from 'lucide-react';
import { CHAT_ATTACHMENT_ACCEPT, type ChatAttachmentBundle } from '@/lib/oa-chat-attachments.mjs';
import { submitKnowledgePackage } from '@/lib/knowledge-package.mjs';
import type { ChatDocumentTask } from '@/lib/oa-chat-documents.mjs';
import './oa-file-controls.css';

export function OaFilePicker({ onFiles, disabled = false }: { onFiles: (files: File[], folder: boolean) => void; disabled?: boolean }) {
  const file = useRef<HTMLInputElement>(null), folder = useRef<HTMLInputElement>(null), root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false); const id = useId();
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, []);
  return <div ref={root} className="oa-attachment-picker">
    <input ref={file} className="oa-document-picker" hidden type="file" multiple accept={CHAT_ATTACHMENT_ACCEPT} aria-label="选择聊天文件或 ZIP" disabled={disabled} onChange={event => { const files = Array.from(event.currentTarget.files || []); event.currentTarget.value = ''; setOpen(false); if (files.length) onFiles(files, false); }} />
    <input ref={node => { folder.current = node; node?.setAttribute('webkitdirectory', ''); }} className="oa-document-picker" hidden type="file" multiple aria-label="选择聊天文件夹" disabled={disabled} onChange={event => { const files = Array.from(event.currentTarget.files || []); event.currentTarget.value = ''; setOpen(false); if (files.length) onFiles(files, true); }} />
    <button type="button" className="oa-document-add" aria-label="上传文件、图片、ZIP 或文件夹" aria-expanded={open} aria-controls={id} title="上传文件、图片、ZIP 或文件夹" disabled={disabled} onClick={() => setOpen(value => !value)}><Plus size={23} /></button>
    {open && !disabled && <div id={id} className="oa-attachment-menu" role="group" aria-label="聊天附件上传方式">
      <button type="button" onClick={() => file.current?.click()}><FileText size={18} />上传文件 / 图片 / ZIP</button>
      <button type="button" onClick={() => folder.current?.click()}><FolderOpen size={18} />上传文件夹</button>
      <small>TXT、MD、PDF、DOCX、PNG、JPG、WebP。最多 100 个文件；不支持文件夹选择时请用 ZIP。</small>
    </div>}
  </div>;
}
function LocalImage({ file, label }: { file: File; label: string }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const reader = new FileReader(); let live = true;
    reader.onload = () => { if (live && typeof reader.result === 'string') setUrl(reader.result); };
    reader.readAsDataURL(file);
    return () => { live = false; if (reader.readyState === FileReader.LOADING) reader.abort(); };
  }, [file]);
  return url ? <figure><img src={url} alt={label} loading="lazy" /><figcaption>{label}</figcaption></figure> : null;
}
export function OaSourceImages({ bundle }: { bundle: ChatAttachmentBundle }) {
  const [expanded, setExpanded] = useState(false), [visible, setVisible] = useState(6);
  return <>{bundle.pkg.images.length > 0 && <details className="oa-source-images" onToggle={event => setExpanded(event.currentTarget.open)}><summary>查看原图（{bundle.pkg.images.length} 张）</summary><div>{expanded && bundle.pkg.images.slice(0, visible).map(image => <LocalImage key={image.path} file={image.file} label={image.alt} />)}</div>{expanded && visible < bundle.pkg.images.length && <button type="button" className="oa-file-refresh" onClick={() => setVisible(value => value + 6)}>继续显示原图</button>}</details>}
    {bundle.warnings.length > 0 && <details className="oa-file-warning"><summary>有 {bundle.warnings.length} 条图片引用需要核对</summary>{bundle.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>}</>;
}
const statusText: Record<string, string> = { pending: '已提交 OA，待审核', active: '已通过审批，已入知识库', returned: 'OA 已退回，请到“我的资料”修改', rejected: 'OA 已拒绝，未入知识库', revoked: '已撤销，已停止知识检索' };
function ArchiveConfirm({ busy, confirmed, setConfirmed, onSubmit, onCancel }: { busy: boolean; confirmed: boolean; setConfirmed: (value: boolean) => void; onSubmit: () => void; onCancel: () => void }) {
  return <div className="oa-archive-confirm" role="group" aria-label="归档确认">
    <p>归档只提交 OA 待审核，不代表已入库。通过后按审批确定的对内 / 对外范围提供检索。</p>
    <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} /><span>已核对正文、图片及脱敏情况，确认提交 OA 审批。</span></label>
    <div className="oa-file-actions"><button type="button" disabled={!confirmed || busy} onClick={onSubmit}>{busy ? '正在核对并提交…' : '确认归档并提交 OA'}</button><button type="button" disabled={busy} onClick={onCancel}>取消</button></div>
  </div>;
}
export function OaSourceArchive({ bundle, onSubmitted }: { bundle: ChatAttachmentBundle; onSubmitted?: () => void }) {
  const [open, setOpen] = useState(false), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [progress, setProgress] = useState(''), [item, setItem] = useState<{ id: string; status: string } | null>(null);
  const lock = useRef(false), live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  async function submit() {
    if (lock.current || !confirmed || item) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const receipt = await submitKnowledgePackage(bundle.pkg, { onProgress: text => { if (live.current) setProgress(text); } });
      if (live.current) { setItem(receipt.item); setOpen(false); onSubmitted?.(); }
    } catch (cause) { if (live.current) setError(cause instanceof Error ? cause.message : '归档未确认，请重试。'); }
    finally { lock.current = false; if (live.current) setBusy(false); }
  }
  return <section className="oa-file-archive" aria-label="原始资料归档">
    {!item && !open && <button type="button" className="oa-file-archive-button" onClick={() => setOpen(true)}><Archive size={16} />归档资料</button>}
    {open && <ArchiveConfirm busy={busy} confirmed={confirmed} setConfirmed={setConfirmed} onSubmit={() => void submit()} onCancel={() => setOpen(false)} />}
    {progress && !item && <p role="status">{progress}</p>}{error && <p role="alert" className="oa-file-warning">{error}</p>}
    {item && <p role="status">{statusText[item.status] || 'OA 已接收，待核对审核状态'} · 编号 {item.id}</p>}
  </section>;
}
type Lifecycle = { state: string; expiresAt: number | null; knowledgeItemId: string | null; knowledgeStatus: string | null; visibility?: string | null };
export function OaTaskArchive({ task }: { task: ChatDocumentTask }) {
  return <TaskArchive key={task.id} task={task} />;
}
function TaskArchive({ task }: { task: ChatDocumentTask }) {
  const [lifecycle, setLifecycle] = useState<Lifecycle | null>(null), [open, setOpen] = useState(false), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const lock = useRef(false), mounted = useRef(true), revision = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++revision.current;
    try {
      const response = await fetch(`/api/lab-ai/archive?id=${encodeURIComponent(task.id)}`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) });
      const data = await response.json();
      if (!response.ok || typeof data.lifecycle?.state !== 'string') throw new Error(data.error || '归档状态暂时无法核对。');
      if (mounted.current && version === revision.current) { setLifecycle(data.lifecycle); setError(''); }
    } catch { if (mounted.current && version === revision.current) setError('归档状态暂时无法核对，请刷新核对；不要将状态未知当作已归档。'); }
  }, [task.id]);
  useEffect(() => {
    mounted.current = true; void refresh();
    const update = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    window.addEventListener('oa-files-archived', update); document.addEventListener('visibilitychange', update);
    return () => { mounted.current = false; window.removeEventListener('oa-files-archived', update); document.removeEventListener('visibilitychange', update); };
  }, [refresh]);
  async function submit() {
    if (lock.current || !confirmed) return;
    lock.current = true; revision.current++; setBusy(true); setError('');
    try {
      const response = await fetch('/api/lab-ai/archive', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: task.id, confirmed: true }), signal: AbortSignal.timeout(90000) });
      const data = await response.json();
      if (!response.ok || data.received !== true || !data.item?.id) throw new Error(data.error || '归档接收尚未确认。');
      if (mounted.current) { revision.current++; setLifecycle({ state: 'submitted', expiresAt: null, knowledgeItemId: data.item.id, knowledgeStatus: data.item.status, visibility: data.item.visibility }); setOpen(false); }
      window.dispatchEvent(new Event('oa-files-archived'));
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '归档结果尚未确认，请核对后重试。'); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  const submitted = lifecycle?.state === 'submitted';
  return <section className="oa-file-archive" aria-label="成果归档与保留期限">
    {lifecycle?.state === 'temporary' && lifecycle.expiresAt && <p>临时成果：未归档时，预计于 {new Date(lifecycle.expiresAt).toLocaleString('zh-CN')} 后定期清理。</p>}
    {lifecycle?.state === 'legacy' && <p>历史成果保留，不追溯自动清理。</p>}
    {lifecycle?.state === 'archiving' && <p>归档结果待核对；成果已受保护，不会被临时清理。</p>}
    {submitted && <p role="status">{statusText[lifecycle.knowledgeStatus || ''] || '已提交，暂无法核对 OA 状态'}{lifecycle.visibility === 'public' ? ' · 对外公开' : lifecycle.knowledgeStatus === 'active' ? ' · 仅 OA 内部' : ''} · 不参与临时清理</p>}
    {!submitted && !open && <button type="button" className="oa-file-archive-button" onClick={() => setOpen(true)} disabled={busy}><Archive size={16} />归档成果</button>}
    {open && <ArchiveConfirm busy={busy} confirmed={confirmed} setConfirmed={setConfirmed} onSubmit={() => void submit()} onCancel={() => setOpen(false)} />}
    {error && <p role="alert" className="oa-file-warning">{error}</p>}
    <button type="button" className="oa-file-refresh" disabled={busy} onClick={() => void refresh()}><RotateCcw size={13} />核对归档状态</button>
  </section>;
}

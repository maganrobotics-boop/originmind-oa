'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { isChatDocumentTask, type ChatDocumentTask } from '@/lib/oa-chat-documents.mjs';
import { TASK_LIMITS } from '@/lib/ai-workbench-core.mjs';
import './oa-document-editor.css';

type Lifecycle = { state: string; expiresAt: number | null; knowledgeItemId: string | null; knowledgeStatus: string | null };
type Edit = { title: string; result: string; expectedUpdatedAt: number };
type Props = { task: ChatDocumentTask; onSaved: (task: ChatDocumentTask) => void; onDirtyChange?: (dirty: boolean) => void };
const labels: Record<string, string> = { pending: '已提交·待审核', active: '已通过审批·已入知识库', returned: 'OA 已退回，请到“我的资料”修改', rejected: 'OA 已拒绝·未入知识库', revoked: '已撤销·已停止知识检索' };
const errorText = (cause: unknown) => cause instanceof Error && !['TimeoutError', 'AbortError'].includes(cause.name) ? cause.message : '处理结果尚未确认，请核对状态后重试；不要重复提交。';
function draftBody(task: ChatDocumentTask) {
  const text = (task.result || '').replace(/\r\n?/gu, '\n').trim();
  return text.split('\n')[0] === `# ${task.title}` ? text.split('\n').slice(1).join('\n').trim() : text;
}
export function OaDocumentEditor(props: Props) { return <Editor key={props.task.id} {...props} />; }
function Editor({ task, onSaved, onDirtyChange }: Props) {
  const [edit, setEdit] = useState<Edit | null>(null), [lifecycle, setLifecycle] = useState<Lifecycle | null>(null);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [open, setOpen] = useState(false), [confirmed, setConfirmed] = useState(false);
  const lock = useRef(false), mounted = useRef(true), revision = useRef(0), id = useId();
  const dirty = Boolean(edit && (edit.title !== task.title || edit.result !== draftBody(task)));
  const editable = Boolean(lifecycle && ['temporary', 'draft', 'legacy'].includes(lifecycle.state));
  const submitted = lifecycle?.state === 'submitted';
  const refresh = useCallback(async () => {
    const version = ++revision.current;
    try {
      const response = await fetch(`/api/lab-ai/archive?id=${encodeURIComponent(task.id)}`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) });
      const data = await response.json() as { lifecycle?: Lifecycle; error?: string };
      if (!response.ok || !data?.lifecycle || typeof data.lifecycle.state !== 'string') throw new Error(data?.error || '暂时无法核对状态。');
      if (mounted.current && version === revision.current) { setLifecycle(data.lifecycle); if (data.lifecycle.state === 'submitted') setError(''); }
    } catch (cause) { if (mounted.current && version === revision.current) { setLifecycle(null); setError(errorText(cause)); } }
  }, [task.id]);
  useEffect(() => {
    mounted.current = true;
    const initial = window.setTimeout(() => { void refresh(); }, 0);
    const update = () => { if (document.visibilityState !== 'hidden' && !lock.current) void refresh(); };
    window.addEventListener('oa-files-archived', update); document.addEventListener('visibilitychange', update);
    return () => { mounted.current = false; window.clearTimeout(initial); window.removeEventListener('oa-files-archived', update); document.removeEventListener('visibilitychange', update); };
  }, [refresh]);
  useEffect(() => {
    onDirtyChange?.(dirty);
    const leave = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', leave);
    return () => { window.removeEventListener('beforeunload', leave); onDirtyChange?.(false); };
  }, [dirty, onDirtyChange]);
  async function save() {
    const draft = edit || { title: task.title, result: draftBody(task), expectedUpdatedAt: task.updated_at };
    const response = await fetch('/api/lab-ai/tasks', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'saveDraft', id: task.id, ...draft }), signal: AbortSignal.timeout(30000) });
    const data = await response.json() as { saved?: boolean; task?: unknown; error?: string };
    if (!response.ok || data?.saved !== true || !isChatDocumentTask(data.task) || data.task.id !== task.id || !data.task.result) throw new Error(data?.error || '草稿保存尚未确认，未提交审批。');
    if (mounted.current) { revision.current++; onSaved(data.task); setEdit(null); setLifecycle({ state: 'draft', expiresAt: null, knowledgeItemId: null, knowledgeStatus: null }); setNotice('草稿已保存，未提交审批、未入知识库；不会被临时清理。'); }
    return data.task;
  }
  async function act(submit: boolean) {
    if (lock.current || (submit && !confirmed) || (!editable && lifecycle?.state !== 'archiving')) return;
    lock.current = true; revision.current++; setBusy(submit ? 'submit' : 'save'); setError(''); setNotice('');
    try {
      const current = !submit || dirty ? await save() : task;
      if (!submit) return;
      if (mounted.current) setNotice('');
      const response = await fetch('/api/lab-ai/archive', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: task.id, confirmed: true, expectedUpdatedAt: current.updated_at }), signal: AbortSignal.timeout(90000) });
      const data = await response.json() as { received?: boolean; item?: { id: string; status: string }; error?: string };
      if (!response.ok || data?.received !== true || !data.item?.id || !data.item.status) throw new Error(data?.error || 'OA 接收尚未确认，请核对状态。');
      if (mounted.current) { revision.current++; setLifecycle({ state: 'submitted', expiresAt: null, knowledgeItemId: data.item.id, knowledgeStatus: data.item.status }); setOpen(false); setConfirmed(false); setNotice('已提交当前确认版本；审批通过后才进入知识库。'); }
      window.dispatchEvent(new Event('oa-files-archived'));
    } catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { lock.current = false; if (mounted.current) { setBusy(''); void refresh(); } }
  }
  async function reload() {
    if (lock.current || (dirty && !window.confirm('当前修改尚未保存。确认放弃这些修改，载入服务器最新稿？'))) return;
    lock.current = true; setBusy('reload'); setError('');
    try {
      const response = await fetch(`/api/lab-ai/tasks?id=${encodeURIComponent(task.id)}`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) });
      const data = await response.json() as { task?: unknown; error?: string };
      if (!response.ok || !isChatDocumentTask(data?.task) || data.task.id !== task.id) throw new Error(data?.error || '未取得最新稿，当前修改仍保留。');
      if (mounted.current) { onSaved(data.task); setEdit(null); setNotice('已载入服务器最新稿。'); }
      await refresh();
    } catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { lock.current = false; if (mounted.current) setBusy(''); }
  }
  return <section className="oa-file-archive oa-document-editor" aria-label="文档编辑保存与提交">
    {edit && <div className="oa-draft-fields">
      <label htmlFor={`${id}-title`}>文档标题</label><input id={`${id}-title`} maxLength={100} value={edit.title} disabled={Boolean(busy) || !editable} onChange={event => { setEdit({ ...edit, title: event.target.value }); setConfirmed(false); }} />
      <label htmlFor={`${id}-body`}>文档正文</label><textarea id={`${id}-body`} rows={12} maxLength={TASK_LIMITS.result} value={edit.result} disabled={Boolean(busy) || !editable} onChange={event => { setEdit({ ...edit, result: event.target.value }); setConfirmed(false); }} />
      <small>{edit.result.length.toLocaleString()} / {TASK_LIMITS.result.toLocaleString()} 字 · 支持 Markdown；保存后同步更新 Word 和 Markdown 文件。</small>
    </div>}
    <div className="oa-document-actions oa-draft-actions" aria-label="文档操作">
      <button type="button" disabled={Boolean(busy) || !editable || Boolean(edit)} onClick={() => { setEdit({ title: task.title, result: draftBody(task), expectedUpdatedAt: task.updated_at }); setNotice(''); setError(''); }}>编辑</button>
      <button type="button" disabled={Boolean(busy) || !editable} onClick={() => void act(false)}>{busy === 'save' ? '正在保存…' : '保存草稿'}</button>
      <button type="button" disabled={Boolean(busy) || (!editable && lifecycle?.state !== 'archiving')} onClick={() => { setOpen(true); setConfirmed(false); }}>{submitted ? labels[lifecycle.knowledgeStatus || ''] || '已提交' : busy === 'submit' ? '正在提交…' : dirty ? '保存并提交' : '提交 OA'}</button>
      {edit && <button type="button" disabled={Boolean(busy)} onClick={() => { if (!dirty || window.confirm('确认放弃尚未保存的修改？')) { setEdit(null); setOpen(false); } }}>取消编辑</button>}
    </div>
    {dirty && <p role="status">有未保存修改；打开和下载仍以服务器已保存稿为准。</p>}
    {lifecycle?.state === 'draft' && <p role="status">草稿已保存 · 未提交 OA · 不参与临时清理</p>}
    {lifecycle?.state === 'temporary' && lifecycle.expiresAt && <p>未保存的临时成果预计于 {new Date(lifecycle.expiresAt).toLocaleString('zh-CN')} 后定期清理。</p>}
    {lifecycle?.state === 'legacy' && <p>历史成果保留，不追溯自动清理。</p>}
    {lifecycle?.state === 'archiving' && <p role="status">提交结果待核对；当前版本已锁定并受保护，请核对或重试提交。</p>}
    {submitted && <p role="status">{labels[lifecycle.knowledgeStatus || ''] || '已提交，审核状态待核对'} · 送审版本不可覆盖修改</p>}
    {open && !submitted && <div className="oa-archive-confirm" role="group" aria-label="提交 OA 确认">
      <p>{dirty ? '将先保存当前修改，再提交这一版本。' : '将提交当前已保存版本。'}提交仅进入 OA 待审核；审批通过后才按核定范围入库，不自动公开。</p>
      <label><input type="checkbox" checked={confirmed} disabled={Boolean(busy)} onChange={event => setConfirmed(event.target.checked)} /><span>已核对正文和脱敏情况，确认提交 OA 审批。</span></label>
      <div className="oa-document-actions"><button type="button" disabled={!confirmed || Boolean(busy)} onClick={() => void act(true)}>{busy ? '正在处理…' : dirty ? '保存并提交 OA' : '确认提交 OA'}</button><button type="button" disabled={Boolean(busy)} onClick={() => setOpen(false)}>取消</button></div>
    </div>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert" className="oa-file-warning">{error}</p>}
    <button type="button" className="oa-file-refresh" disabled={Boolean(busy)} onClick={() => { setError(''); void refresh(); }}>核对保存与审批状态</button>
    {error && <button type="button" className="oa-file-refresh" disabled={Boolean(busy)} onClick={() => void reload()}>重新载入最新稿</button>}
  </section>;
}

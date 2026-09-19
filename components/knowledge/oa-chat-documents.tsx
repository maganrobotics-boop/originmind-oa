'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Download, FileText, History, RotateCcw, X } from 'lucide-react';
import { renderAnswerBody } from '@/lib/oa-chat-renderer.mjs';
import { chatDocumentFailure, isChatDocumentTask, newerChatDocumentTask, planChatDocument, wantsChatDocument, type ChatDocumentPlan, type ChatDocumentSource, type ChatDocumentTask } from '@/lib/oa-chat-documents.mjs';
import { useOaConversation } from './oa-conversation-context';
import './oa-chat-documents.css';
import { readChatAttachments, type ChatAttachmentBundle } from '@/lib/oa-chat-attachments.mjs';
import { OaFilePicker, OaSourceArchive, OaSourceImages } from './oa-file-controls';
import { OaDocumentEditor } from './oa-document-editor';
import { AdminMeetingMinutesLink } from './admin-meeting-minutes';

type ImportedEntry = { type: 'import'; id: string; order: number; source: ChatDocumentSource; bundle?: ChatAttachmentBundle };
type TaskEntry = { type: 'task'; id: string; order: number; requestId?: string; plan?: ChatDocumentPlan; task?: ChatDocumentTask; problem?: string };
export type ChatDocumentEntry = ImportedEntry | TaskEntry;
const statusLabels = { queued: '材料已保存，等待处理', running: '正在处理材料、制作并保存文档…', succeeded: '文档已生成并保存', failed: '文档尚未生成', cancelled: '任务已取消' };
const message = (cause: unknown, fallback: string) => cause instanceof Error && !['AbortError', 'TimeoutError'].includes(cause.name) ? cause.message : fallback;

/** No material is put in localStorage or the shared knowledge base. Only meeting-minute tasks also have an admin read-only view. */
export function useOaChatDocuments(nextOrder: () => number) {
  const { setLastAnswer } = useOaConversation();
  const [entries, setEntries] = useState<ChatDocumentEntry[]>([]);
  const [source, setSource] = useState<ChatDocumentSource | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [preview, setPreview] = useState<ChatDocumentTask | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false), [historyLoading, setHistoryLoading] = useState(false);
  const [saved, setSaved] = useState<ChatDocumentTask[]>([]), [historyError, setHistoryError] = useState('');
  const [pending, setPending] = useState<string[]>([]);
  const [importProgress, setImportProgress] = useState('');
  const all = useRef<ChatDocumentEntry[]>([]), mounted = useRef(true), importing = useRef(0);
  const lock = useRef(false), controllers = useRef(new Set<AbortController>()), operations = useRef(new Set<string>());
  const previewed = useRef(new Set<string>()), noAutoPreview = useRef(new Set<string>());
  const lastGenerated = useRef<ChatDocumentSource | null>(null);
  const previewDirty = useRef(false);
  const setPreviewDirty = useCallback((dirty: boolean) => { previewDirty.current = dirty; }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; importing.current++; for (const controller of controllers.current) controller.abort(); controllers.current.clear(); };
  }, []);

  const change = useCallback((update: (old: ChatDocumentEntry[]) => ChatDocumentEntry[]) => {
    if (!mounted.current) return;
    all.current = update(all.current); setEntries(all.current);
  }, []);
  const request = useCallback(async (body?: object, query = '') => {
    const controller = new AbortController(); controllers.current.add(controller);
    try {
      const response = await fetch(`/api/lab-ai/tasks${query}`, {
        method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
        headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(body ? 80000 : 15000)]),
      });
      const data = await response.json().catch(() => ({})) as { task?: unknown; tasks?: unknown[]; error?: string };
      if (!response.ok) throw new Error(data.error || '文档处理服务暂不可用，已有记录仍保留。');
      return data;
    } finally { controllers.current.delete(controller); }
  }, []);
  const patch = useCallback((id: string, values: Partial<TaskEntry>) => {
    change(old => old.map(entry => entry.type === 'task' && entry.id === id ? { ...entry, ...values } : entry));
  }, [change]);
  const accept = useCallback((id: string, value: unknown, autoOpen = true) => {
    if (!mounted.current) return;
    if (!isChatDocumentTask(value)) throw new Error('未取得有效任务记录，请核对状态。');
    const previous = all.current.find(entry => entry.id === id);
    const task = newerChatDocumentTask(previous?.type === 'task' ? previous.task : undefined, value);
    if (!task) return;
    patch(id, { task, problem: undefined });
    if (task.status === 'succeeded' && task.result && !previewed.current.has(task.id)) {
      previewed.current.add(task.id);
      lastGenerated.current = { name: `${task.title}.md`, text: task.result };
      setLastAnswer({ body: task.result, omittedImages: 0 });
      if (autoOpen && !noAutoPreview.current.has(task.id)) setPreview(task);
    }
  }, [patch, setLastAnswer]);
  const acceptSavedTask = useCallback((task: ChatDocumentTask) => {
    if (!mounted.current || !isChatDocumentTask(task)) return;
    change(old => old.map(entry => entry.type === 'task' && entry.task?.id === task.id
      ? { ...entry, task: newerChatDocumentTask(entry.task, task) || entry.task, problem: undefined } : entry));
    setPreview(previous => previous?.id === task.id ? newerChatDocumentTask(previous, task) || previous : previous);
    setSaved(previous => previous.map(item => item.id === task.id ? newerChatDocumentTask(item, task) || item : item));
    if (task.result) { lastGenerated.current = { name: `${task.title}.md`, text: task.result }; setLastAnswer({ body: task.result, omittedImages: 0 }); }
  }, [change, setLastAnswer]);
  const operate = useCallback(async (id: string, action: 'run' | 'retry' | 'cancel' | 'refresh') => {
    const entry = all.current.find(item => item.id === id);
    if (entry?.type !== 'task' || !entry.task) return;
    const key = `${action}:${entry.task.id}`;
    if (operations.current.has(key)) return;
    operations.current.add(key); setPending([...operations.current]);
    if (action === 'cancel') noAutoPreview.current.add(entry.task.id);
    try {
      const data = action === 'refresh' ? await request(undefined, `?id=${encodeURIComponent(entry.task.id)}`) : await request({ action, id: entry.task.id });
      accept(id, data.task);
    } catch (cause) {
      patch(id, { problem: message(cause, '等待已结束，但服务器可能仍在处理。请核对状态，不要重复提交。') });
    } finally { operations.current.delete(key); if (mounted.current) setPending([...operations.current]); }
  }, [request, accept, patch]);
  const create = useCallback(async (entry: TaskEntry) => {
    if (!entry.plan || !entry.requestId || lock.current) return;
    lock.current = true; setBusy(true); setError(''); patch(entry.id, { problem: undefined });
    try {
      // Manual recovery repeats the SAME requestId and payload; the server deduplicates it.
      const data = await request({ action: 'create', requestId: entry.requestId, ...entry.plan });
      accept(entry.id, data.task);
      if (mounted.current && isChatDocumentTask(data.task) && data.task.status === 'queued') await operate(entry.id, 'run');
    } catch (cause) {
      patch(entry.id, { problem: message(cause, '提交结果尚未确认。点击“核对提交”沿用同一编号核对，不会新建重复任务。') });
    } finally { lock.current = false; if (mounted.current) setBusy(false); }
  }, [request, accept, operate, patch]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      for (const entry of all.current) if (entry.type === 'task' && entry.task && ['queued', 'running'].includes(entry.task.status)) void operate(entry.id, 'refresh');
    }, 5000);
    return () => window.clearInterval(timer);
  }, [operate]);

  const importFiles = async (files: File[], folder = false) => {
    if (lock.current || !files.length) return;
    lock.current = true; setBusy(true); setError('');
    const version = ++importing.current, controller = new AbortController(); controllers.current.add(controller);
    try {
      const bundle = await readChatAttachments(files, { folder, signal: controller.signal, onProgress: text => { if (mounted.current) setImportProgress(text); } });
      if (!mounted.current || version !== importing.current) return;
      const imported = { name: bundle.name, text: bundle.text };
      setSource(imported); setError(''); lastGenerated.current = null;
      change(old => [...old, { type: 'import', id: bundle.id, order: nextOrder(), source: imported, bundle }]);
    } catch (cause) { if (mounted.current && version === importing.current) setError(message(cause, '导入失败，原有材料未被替换。')); }
    finally { lock.current = false; controllers.current.delete(controller); if (mounted.current) { setBusy(false); setImportProgress(''); } }
  };
  const importFile = (file: File) => importFiles([file]);
  const submit = (instruction: string, previousAnswer = '') => {
    if (lock.current) return false;
    try {
      const plan = planChatDocument(instruction, source, previousAnswer || lastGenerated.current?.text || '');
      const entry: TaskEntry = { type: 'task', id: crypto.randomUUID(), order: nextOrder(), requestId: crypto.randomUUID(), plan };
      change(old => [...old, entry]); void create(entry); return true;
    } catch (cause) { setError(message(cause, '请检查材料与任务要求。')); return false; }
  };
  const download = async (task: ChatDocumentTask, format: 'docx' | 'md') => {
    const key = `download:${task.id}:${format}`;
    if (operations.current.has(key)) return;
    operations.current.add(key); setPending([...operations.current]); setError('');
    const controller = new AbortController(); controllers.current.add(controller);
    try {
      const response = await fetch(`/api/lab-ai/tasks?id=${encodeURIComponent(task.id)}&format=${format}`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) });
      if (!response.ok) { const data = await response.json().catch(() => ({})) as { error?: string }; throw new Error(data.error || '文件暂不可下载，请核对状态。'); }
      const mime = response.headers.get('content-type')?.split(';')[0].trim();
      const expected = format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/markdown';
      if (mime !== expected) throw new Error('未收到正确的文档文件，请重新登录或核对状态。');
      const blob = await response.blob(); if (!blob.size) throw new Error('未收到完整文件，请稍后重试。');
      if (!mounted.current) return;
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `${task.title.replace(/[\/\\:*?"<>|\r\n\t]/gu, '_')}.${format}`;
      document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (cause) { if (mounted.current) setError(message(cause, '下载未完成，已保存的文档仍保留。')); }
    finally { controllers.current.delete(controller); operations.current.delete(key); if (mounted.current) setPending([...operations.current]); }
  };
  const showHistory = async () => {
    setHistoryOpen(true); setHistoryLoading(true); setHistoryError('');
    try { const data = await request(); if (mounted.current) setSaved((Array.isArray(data.tasks) ? data.tasks : []).filter(isChatDocumentTask)); }
    catch (cause) { if (mounted.current) setHistoryError(message(cause, '暂时无法读取本人文档记录。')); }
    finally { if (mounted.current) setHistoryLoading(false); }
  };
  const restore = async (id: string) => {
    setHistoryLoading(true); setHistoryError('');
    try {
      const data = await request(undefined, `?id=${encodeURIComponent(id)}`);
      if (!mounted.current) return;
      if (!isChatDocumentTask(data.task)) throw new Error('文档不存在或无访问权限。');
      const found = all.current.find(entry => entry.type === 'task' && entry.task?.id === id);
      const localId = found?.id || crypto.randomUUID();
      if (!found) change(old => [...old, { type: 'task', id: localId, order: nextOrder(), task: data.task as ChatDocumentTask }]);
      accept(localId, data.task, false); setHistoryOpen(false);
      if (data.task.status === 'succeeded' && data.task.result) setPreview(data.task);
    } catch (cause) { if (mounted.current) setHistoryError(message(cause, '读取文档失败。')); }
    finally { if (mounted.current) setHistoryLoading(false); }
  };
  return { entries, source, busy, error, pending, preview, historyOpen, historyLoading, saved, historyError,
    importFile, importFiles, importProgress, submit, shouldHandle: (instruction: string) => Boolean(source) || wantsChatDocument(instruction),
    useSource: (value: ChatDocumentSource | null) => { setSource(value); setError(''); },
    dismissError: () => setError(''), operate, recover: create, download, showHistory, restore, acceptSavedTask, setPreviewDirty,
    openPreview: setPreview, closePreview: () => { if (previewDirty.current && !window.confirm('修改尚未保存，确认放弃修改并返回聊天？')) return; previewDirty.current = false; setPreview(null); }, closeHistory: () => setHistoryOpen(false) };
}

type Documents = ReturnType<typeof useOaChatDocuments>;
function TextPreview({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return <><pre className="oa-import-text">{expanded ? text : text.slice(0, 1200)}</pre>{text.length > 1200 && <button type="button" className="oa-document-text-button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '收起原文' : `展开全文（${text.length.toLocaleString()} 字）`}</button>}</>;
}
function DocumentBody({ text }: { text: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => { const node = host.current; if (!node) return; node.replaceChildren(renderAnswerBody(text)); return () => node.replaceChildren(); }, [text]);
  return <div ref={host} className="oa-rich-answer oa-document-body" />;
}
export function OaChatDocumentEvent({ entry, documents }: { entry: ChatDocumentEntry; documents: Documents }) {
  if (entry.type === 'import') return <article className="oa-import-card" aria-label={`已导入 ${entry.source.name}`}><header><FileText size={20} /><strong>{entry.source.name}</strong><span>{entry.source.text.length.toLocaleString()} 字</span></header><TextPreview text={entry.source.text} />{entry.bundle && <OaSourceImages bundle={entry.bundle} />}<footer><small>临时材料，不自动入库；关闭此页会释放未提交的原文件。以“会议纪要”任务发送后，管理员可查看文字材料和成果。单次 AI 处理最多 20,000 字，超出不截断，完整资料仍可归档送审。</small><button type="button" className="oa-document-text-button" disabled={documents.busy} onClick={() => documents.useSource(entry.source)}>使用这份材料</button></footer>{entry.bundle && <OaSourceArchive bundle={entry.bundle} />}</article>;
  const task = entry.task;
  const disabled = task ? documents.pending.some(key => key.endsWith(`:${task.id}`)) : documents.busy;
  return <div className="oa-chat-turn oa-document-turn">
    <article className="message user"><div className="message-content"><p>{entry.plan?.instruction || task?.instruction || '打开已保存文档'}</p></div></article>
    <article className="oa-document-card" aria-label="文档处理任务"><header><FileText size={24} /><div><strong>{task?.title || entry.plan?.title || '文档处理'}</strong><p role="status">{task ? statusLabels[task.status] : entry.problem ? '提交结果待核对' : '正在提交材料…'}</p></div></header>
      {task?.status === 'succeeded' && task.result && <><p className="oa-document-filename">{task.title}.docx <span>{task.kind === 'meeting_minutes' ? '本人和 OA 管理员可查看' : '仅本人可访问'}</span></p><div className="oa-document-actions"><button type="button" onClick={() => documents.openPreview(task)}>打开文档</button><button type="button" disabled={documents.pending.includes(`download:${task.id}:docx`)} onClick={() => void documents.download(task, 'docx')}><Download size={16} />下载 Word</button><button type="button" disabled={documents.busy} onClick={() => documents.useSource({ name: `${task.title}.md`, text: task.result! })}>继续修改</button></div><details className="oa-document-inline-preview"><summary>在对话中查看正文</summary><DocumentBody text={task.result} /></details><OaDocumentEditor task={task} onSaved={documents.acceptSavedTask} /></>}
      {task?.kind === 'meeting_minutes' && <p>会议纪要处理任务已记录，OA 管理员可查看材料与处理状态；成果送审请点击“提交 OA”，审批通过后才入库。</p>}
      {task?.status === 'failed' && <p className="oa-chat-error" role="alert">{chatDocumentFailure(task.failure_code)}</p>}
      {entry.problem && <p className="oa-chat-error" role="alert">{entry.problem}</p>}
      <div className="oa-document-actions">
        {!task && entry.problem && <button type="button" disabled={documents.busy} onClick={() => void documents.recover(entry)}><RotateCcw size={16} />核对提交</button>}
        {task && task.status !== 'succeeded' && <button type="button" disabled={disabled} onClick={() => void documents.operate(entry.id, 'refresh')}>核对状态</button>}
        {task?.status === 'failed' && task.attempts < 3 && <button type="button" disabled={disabled || documents.busy} onClick={() => void documents.operate(entry.id, 'retry')}>重试任务</button>}
        {task?.status === 'queued' && !documents.busy && <button type="button" disabled={disabled} onClick={() => void documents.operate(entry.id, 'run')}>继续执行</button>}
        {task && ['queued', 'running'].includes(task.status) && <button type="button" disabled={documents.pending.includes(`cancel:${task.id}`)} onClick={() => void documents.operate(entry.id, 'cancel')}>取消任务</button>}
      </div>
    </article>
  </div>;
}
export function OaDocumentUpload({ documents, disabled }: { documents: Documents; disabled: boolean }) {
  return <OaFilePicker disabled={disabled || documents.busy} onFiles={(files, folder) => void documents.importFiles(files, folder)} />;
}
export function OaDocumentSource({ documents }: { documents: Documents }) {
  return <div className="oa-document-tools">{documents.importProgress && <p className="oa-file-progress" role="status">{documents.importProgress}</p>}{documents.source && <span className="oa-document-source"><FileText size={16} /><span>本次使用：{documents.source.name}</span><button type="button" aria-label="不再使用这份材料" disabled={documents.busy} onClick={() => documents.useSource(null)}><X size={15} /></button></span>}<button type="button" className="oa-document-text-button" onClick={() => void documents.showHistory()}><History size={15} />已保存文档</button><AdminMeetingMinutesLink /></div>;
}
function DocumentDialog({ label, open, onClose, children }: { label: string; open: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const node = ref.current; if (!node) return; if (open && !node.open) node.showModal(); if (!open && node.open) node.close(); }, [open]);
  return <dialog ref={ref} className="oa-document-dialog" aria-label={label} onCancel={event => { event.preventDefault(); onClose(); }}><header><strong>{label}</strong><button type="button" aria-label={`关闭${label}`} onClick={onClose} autoFocus><X size={22} /></button></header>{children}</dialog>;
}
export function OaDocumentDialogs({ documents }: { documents: Documents }) {
  const { peer } = useOaConversation();
  const task = documents.preview;
  return <><DocumentDialog label="文档预览" open={Boolean(task) && !peer} onClose={documents.closePreview}>{task && <><div className="oa-document-dialog-content"><h2>{task.title}</h2><DocumentBody text={task.result || ''} /></div><footer>{documents.error && <p role="alert" className="oa-chat-error">{documents.error}</p>}<div className="oa-document-actions"><button type="button" disabled={documents.pending.includes(`download:${task.id}:docx`)} onClick={() => void documents.download(task, 'docx')}><Download size={16} />下载 Word</button><button type="button" disabled={documents.pending.includes(`download:${task.id}:md`)} onClick={() => void documents.download(task, 'md')}>下载 Markdown</button><button type="button" onClick={documents.closePreview}>返回聊天</button></div><OaDocumentEditor task={task} onSaved={documents.acceptSavedTask} onDirtyChange={documents.setPreviewDirty} /></footer></>}</DocumentDialog><DocumentDialog label="本人已保存文档" open={documents.historyOpen && !peer} onClose={documents.closeHistory}><div className="oa-document-dialog-content">{documents.historyLoading && <p role="status">正在读取…</p>}{documents.historyError && <p role="alert" className="oa-chat-error">{documents.historyError}</p>}{!documents.historyLoading && !documents.historyError && !documents.saved.length && <p>还没有文档任务。导入材料并发送处理要求后，成果会保存在这里。</p>}<div className="oa-document-history">{documents.saved.map(item => <button key={item.id} type="button" disabled={documents.historyLoading} onClick={() => void documents.restore(item.id)}><FileText size={20} /><span><strong>{item.title}</strong><small>{statusLabels[item.status]}</small></span></button>)}</div></div></DocumentDialog></>;
}

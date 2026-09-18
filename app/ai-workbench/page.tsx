'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { TASK_KINDS } from '../../lib/ai-workbench-core.mjs';
import { renderAnswerBody } from '../../lib/oa-chat-renderer.mjs';
import './workbench.css';

type Task = { id: string; kind: string; title: string; instruction?: string; material?: string; status: string; result?: string; failure_code: string; attempts: number; created_at: number; updated_at: number };
const statuses: Record<string, string> = { queued: '材料已保存，待执行', running: '正在生成正文、制作文件并归档', succeeded: '成果文件已保存', failed: '未完成', cancelled: '已取消' };
const examples: Record<string, string> = {
  document: '把以下材料整理成一份结构完整、可直接修改使用的文档。保留关键事实，缺失内容标注待补充。',
  weekly_report: '整理成项目周报，区分已完成、未完成和待验证事项，列出问题与下一步行动。不编造负责人、日期和实验结果。',
  meeting_minutes: '整理成会议纪要，区分讨论内容、明确决定和待办事项。只有材料明确给出的负责人和截止日期才能写为已确定。',
  project_plan: '整理成项目方案，包含目标、实施步骤、验收标准和风险。把已有事实、建议和待补充内容明确分开。',
};
async function request(body?: object, query = ''): Promise<{ task?: Task; tasks?: Task[] }> {
  const response = await fetch(`/api/lab-ai/tasks${query}`, { method: body ? 'POST' : 'GET', headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    credentials: 'same-origin', cache: 'no-store', ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(body ? 80000 : 15000) });
  const data = await response.json().catch(() => null) as { task?: Task; tasks?: Task[]; error?: string } | null;
  if (!response.ok || !data || typeof data !== 'object') throw new Error(typeof data?.error === 'string' ? data.error : '任务服务未返回有效结果，请检查登录或服务状态。');
  return data;
}
function failureText(code: string) {
  if (code === 'TASK_ACCESS_CHANGED') return '成员准入状态或任务执行权限已变化，未保存迟到的结果。';
  if (code === 'TASK_INTERRUPTED') return '执行连接中断，未取得完整成果；不会自动重复执行。';
  if (code === 'TASK_ARTIFACT_FAILED') return '文件制作或校验未通过，没有交付不完整文件。';
  if (code === 'TASK_SAVE_FAILED') return '成果归档未完成，任务没有标记为成功。请核对任务库后重试。';
  return '模型尚未返回完整可用正文，任务没有标记为成功。可手动重试。';
}
function ResultPreview({ answer }: { answer: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = host.current; if (!node) return;
    node.replaceChildren(renderAnswerBody(answer));
    return () => node.replaceChildren();
  }, [answer]);
  return <div ref={host} className="workbench-result workbench-rich" aria-label="成果预览" />;
}
export default function AiWorkbench() {
  const [kind, setKind] = useState('document'), [title, setTitle] = useState(''), [instruction, setInstruction] = useState(''), [material, setMaterial] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]), [selected, setSelected] = useState<Task | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [ready, setReady] = useState(false);
  const [serviceError, setServiceError] = useState('');
  const submitGuard = useRef(false), key = useRef({ body: '', id: '' }), pendingActions = useRef(new Set<string>());
  const activeId = useRef(''), mounted = useRef(true);
  const refresh = useCallback(async () => {
    try {
      const data = await request();
      if (!Array.isArray(data.tasks)) throw new Error('任务服务响应不完整，暂不能执行。');
      if (mounted.current) { setTasks(data.tasks); setReady(true); setServiceError(''); }
    } catch (cause) {
      if (mounted.current) { setReady(false); setServiceError(cause instanceof Error && cause.name !== 'TimeoutError' ? cause.message : '任务服务连接超时，请重试检查。'); }
      throw cause;
    }
    const id = activeId.current;
    if (id) { const detail = await request(undefined, `?id=${encodeURIComponent(id)}`); if (mounted.current && activeId.current === id) setSelected(detail.task || null); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const id = new URLSearchParams(window.location.search).get('id');
    if (id && /^[a-f0-9-]{36}$/u.test(id)) activeId.current = id;
    let cancelled = false;
    // Start the external check asynchronously; cleanup prevents stale starts.
    void Promise.resolve().then(() => { if (!cancelled) return refresh(); }).catch(() => {}).finally(() => { if (!cancelled && mounted.current) setLoading(false); });
    return () => { cancelled = true; mounted.current = false; };
  }, [refresh]);
  useEffect(() => {
    if (!tasks.some(task => ['queued', 'running'].includes(task.status)) && !['queued', 'running'].includes(selected?.status || '')) return;
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh().catch(() => {}); }, 5000);
    return () => window.clearInterval(interval);
  }, [tasks, selected?.status, refresh]);
  async function checkService() {
    if (pendingActions.current.has('check-service')) return;
    pendingActions.current.add('check-service'); setLoading(true); setError('');
    try { await refresh(); }
    catch (cause) { setError(cause instanceof Error && cause.name !== 'TimeoutError' ? cause.message : '连接超时，未提交任务；原材料仍保留在本页。'); }
    finally { setLoading(false); pendingActions.current.delete('check-service'); }
  }
  async function choose(id: string) {
    activeId.current = id; setSelected(null); setError('');
    try { const data = await request(undefined, `?id=${encodeURIComponent(id)}`); if (mounted.current && activeId.current === id) setSelected(data.task || null); }
    catch (cause) { if (activeId.current === id) setError(cause instanceof Error ? cause.message : '读取失败。'); }
  }
  async function action(name: string, id: string) {
    const guard = `${name}:${id}`; if (pendingActions.current.has(guard)) return;
    pendingActions.current.add(guard); setError('');
    try { const data = await request({ action: name, id }); if (activeId.current === id && data.task) setSelected(data.task); await refresh(); }
    catch (cause) { setError(cause instanceof Error && cause.name !== 'TimeoutError' ? cause.message : '等待超时，请刷新任务记录确认状态，不要重复提交。'); await refresh().catch(() => {}); }
    finally { pendingActions.current.delete(guard); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (submitGuard.current) return;
    if (!ready) { setError(serviceError || '任务服务尚未就绪，请先检查任务服务；没有提交任务。'); return; }
    submitGuard.current = true; setBusy(true); setError('');
    const resolvedTitle = title.trim() || instruction.trim().split(/[\r\n。！？]/u)[0].slice(0, 100);
    const payload = { kind, title: resolvedTitle, instruction, material }, signature = JSON.stringify(payload);
    if (key.current.body !== signature) key.current = { body: signature, id: crypto.randomUUID() };
    try {
      const data = await request({ action: 'create', requestId: key.current.id, ...payload });
      if (!data.task) throw new Error('尚未取得任务记录，请刷新核对。');
      activeId.current = data.task.id; setSelected(data.task); await refresh();
      if (data.task.status === 'queued') await action('run', data.task.id);
    } catch (cause) { setError(cause instanceof Error && cause.name !== 'TimeoutError' ? cause.message : '提交结果尚未确认，请刷新核对；再次提交将沿用同一编号。'); }
    finally { submitGuard.current = false; setBusy(false); }
  }
  async function download(task: Task, format: 'docx' | 'md') {
    const guard = `download:${task.id}:${format}`; if (pendingActions.current.has(guard)) return;
    pendingActions.current.add(guard); setError('');
    try {
      const response = await fetch(`/api/lab-ai/tasks?id=${encodeURIComponent(task.id)}&format=${format}`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(20000) });
      if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string }; throw new Error(body.error || '文件暂不可下载。'); }
      const file = await response.blob(), url = URL.createObjectURL(file), link = document.createElement('a');
      link.href = url; link.download = `${task.title.replace(/[\/\\:*?"<>|\r\n\t]/gu, '_')}.${format}`;
      document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '下载失败，已保存的成果仍保留。'); }
    finally { pendingActions.current.delete(guard); }
  }
  return <main className="ai-workbench">
    <header><Link href="/">← 返回 OA</Link><h1>AI 工作台</h1><p>交给 AI 完成任务，直接领取可编辑的成果文件。</p></header>
    <div className="workbench-note">文字材料 → 百炼生成正文 → 制作并校验 Word / Markdown → 私有归档。仅本人可见，不自动公开、不代替审批。第一版支持 TXT、Markdown 和粘贴文字；图片与公式暂不转换。</div>
    {(error || serviceError) && <div className="workbench-error" role="alert">{error || serviceError} <button type="button" disabled={loading} onClick={() => void checkService()}>重新检查（保留材料）</button></div>}
    <div className="workbench-grid">
      <section className="workbench-card"><h2>交给 AI 做什么</h2>
        <div className="workbench-actions" aria-label="常用任务">{Object.entries(TASK_KINDS).map(([value, label]) => <button key={value} type="button" disabled={busy} onClick={() => { setKind(value); setInstruction(examples[value]); }}>{String(label)}</button>)}</div>
        <form onSubmit={submit} onInvalid={() => setError('请填写完整的任务要求和文字材料；两项都至少需要2个字。')}>
          <label>任务要求<textarea required minLength={2} maxLength={2000} rows={4} value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="例如：把这些汇报整理成项目周报，给我可编辑的 Word 文件。" /></label>
          <label>成果标题（可留空，按任务要求命名）<input maxLength={100} value={title} onChange={e => setTitle(e.target.value)} placeholder="例如：机器人项目周报" /></label>
          <label>文字材料<textarea required minLength={2} maxLength={20000} rows={10} value={material} onChange={e => setMaterial(e.target.value)} placeholder="粘贴需要处理的原文。仅粘贴链接不会读取链接中的内容。" /></label>
          <div className="workbench-upload"><label>选择 TXT / Markdown 文件<input type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" onChange={async e => {
            const picker = e.currentTarget, file = picker.files?.[0]; if (!file) return;
            try {
              if (!/\.(txt|md|markdown)$/iu.test(file.name) || file.size > 90000) throw new Error('请选择90 KB以内的 TXT 或 Markdown 文件。');
              const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
              if (text.length > 20000 || text.trim().length < 2 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) throw new Error('仅接受2–20000字的 UTF-8 文字材料。');
              setMaterial(text); if (!title) setTitle(file.name.replace(/\.[^.]+$/u, '').slice(0, 100)); setError('');
            } catch (cause) { setError(cause instanceof Error ? cause.message : '读取文件失败。'); }
            finally { picker.value = ''; }
          }} /></label><small>{material.length.toLocaleString()} / 20,000 字</small></div>
          <div id="workbench-submit-status" role="status" aria-live="polite" className={(error || serviceError) ? 'workbench-error' : 'workbench-note'}>
            {loading ? '正在检查任务服务，请稍候…' : (error || serviceError || (ready ? '任务服务已就绪。' : '任务服务尚未就绪，请点击下方按钮检查。'))}
            {!ready && !loading && <p>尚未提交任务。请保留本页材料，不必反复点击或刷新整个页面。</p>}
          </div>
          <button className="workbench-primary" type={ready ? 'submit' : 'button'} disabled={busy || loading} aria-describedby="workbench-submit-status" onClick={ready ? undefined : () => void checkService()}>{loading ? '正在检查任务服务…' : busy ? '任务处理中，请在任务与成果中查看…' : ready ? '执行任务并交付文件' : '检查任务服务（保留材料）'}</button>
        </form>
      </section>
      <section className="workbench-card workbench-output"><h2>任务与成果</h2><div className="workbench-task-list" aria-label="本人任务记录">{loading ? <p>正在读取任务记录…</p> : tasks.length ? tasks.map(task => <button key={task.id} type="button" aria-pressed={selected?.id === task.id} onClick={() => void choose(task.id)}><strong>{task.title}</strong><span>{statuses[task.status] || task.status}</span></button>) : <p>提交任务后，材料与成果会保存在这里，刷新后可重新查看。</p>}</div>
        {selected && <article><h3>{selected.title}</h3><p role="status">{statuses[selected.status]} · 已执行 {selected.attempts} 次</p>
          {selected.status === 'failed' && <p className="workbench-error">{failureText(selected.failure_code)}</p>}
          <div className="workbench-actions">
            {selected.status === 'succeeded' && <><button type="button" onClick={() => void download(selected, 'docx')}>下载 Word</button><button type="button" onClick={() => void download(selected, 'md')}>下载 Markdown</button></>}
            {selected.status === 'failed' && selected.attempts < 3 && <button type="button" disabled={busy} onClick={() => void action('retry', selected.id)}>手动重试</button>}
            {['queued', 'running'].includes(selected.status) && <button type="button" onClick={() => void action('cancel', selected.id)}>取消任务</button>}
          </div>
          {selected.result && <ResultPreview answer={selected.result} />}
          <details><summary>查看本次要求与原始材料</summary><pre>{selected.instruction}{'\n\n'}{selected.material}</pre></details>
        </article>}
      </section>
    </div>
  </main>;
}

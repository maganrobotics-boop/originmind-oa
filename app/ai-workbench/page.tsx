'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { TASK_KINDS } from '../../lib/ai-workbench-core.mjs';
import { renderAnswerBody } from '../../lib/oa-chat-renderer.mjs';
import './workbench.css';

type Task = { id: string; kind: string; title: string; instruction?: string; material?: string; status: string; result?: string; failure_code: string; attempts: number; origin: string; delivery_status: string; created_at: number; updated_at: number };
const statuses: Record<string, string> = { queued: '已收材料，待执行', running: '正在生成', succeeded: '成果已保存', failed: '未完成', cancelled: '已取消' };
async function request(body?: object, query = ''): Promise<{ task?: Task; tasks?: Task[] }> {
  const response = await fetch(`/api/lab-ai/tasks${query}`, { method: body ? 'POST' : 'GET', headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    credentials: 'same-origin', cache: 'no-store', ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(body ? 80000 : 15000) });
  const data = await response.json().catch(() => ({})) as { task?: Task; tasks?: Task[]; error?: string };
  if (!response.ok) throw new Error(data.error || '任务服务暂不可用。');
  return data;
}
function failureText(code: string) {
  if (code === 'TASK_UNSUPPORTED_MATERIAL') return '这类飞书材料暂不能直接读取。请粘贴文字，或在这里选择 TXT / Markdown 文件。';
  if (code === 'TASK_MATERIAL_MISSING') return '没有收到可处理的文字材料，请补充材料后新建任务。';
  if (code === 'TASK_ACCESS_CHANGED') return '执行期间成员或飞书绑定状态发生变化，任务已停止。';
  if (code === 'TASK_INTERRUPTED') return '执行连接中断，未取得完整成果；不会自动重复执行。';
  return '模型尚未返回完整成果，未标记为成功。请检查模型服务后手动重试。';
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
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const submitGuard = useRef(false), key = useRef({ body: '', id: '' });
  const activeId = useRef(''), mounted = useRef(true);
  const refresh = useCallback(async () => {
    const data = await request();
    if (mounted.current) setTasks(data.tasks || []);
    const id = activeId.current;
    if (id) { const detail = await request(undefined, `?id=${encodeURIComponent(id)}`); if (mounted.current && activeId.current === id) setSelected(detail.task || null); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const id = new URLSearchParams(window.location.search).get('id');
    if (id && /^[a-f0-9-]{36}$/u.test(id)) activeId.current = id;
    void refresh().catch(cause => { if (mounted.current) setError(cause instanceof Error ? cause.message : '任务加载失败。'); }).finally(() => { if (mounted.current) setLoading(false); });
    return () => { mounted.current = false; };
  }, [refresh]);
  useEffect(() => {
    if (!tasks.some(task => ['queued','running'].includes(task.status))) return;
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh().catch(() => {}); }, 5000);
    return () => window.clearInterval(interval);
  }, [tasks, refresh]);
  async function choose(id: string) {
    activeId.current = id; setError('');
    try { const data = await request(undefined, `?id=${encodeURIComponent(id)}`); if (activeId.current === id) setSelected(data.task || null); }
    catch (cause) { setSelected(null); setError(cause instanceof Error ? cause.message : '读取失败。'); }
  }
  async function action(name: string, id: string) {
    setError('');
    try { const data = await request({ action: name, id }); if (activeId.current === id && data.task) setSelected(data.task); await refresh(); }
    catch (cause) { setError(cause instanceof Error && cause.name !== 'TimeoutError' ? cause.message : '等待超时，请刷新任务记录确认状态，不要重复提交。'); await refresh().catch(() => {}); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (submitGuard.current) return;
    submitGuard.current = true; setBusy(true); setError('');
    const payload = { kind, title, instruction, material }, signature = JSON.stringify(payload);
    if (key.current.body !== signature) key.current = { body: signature, id: crypto.randomUUID() };
    try {
      const data = await request({ action: 'create', requestId: key.current.id, ...payload });
      if (!data.task) throw new Error('尚未取得任务记录，请刷新核对。');
      activeId.current = data.task.id; setSelected(data.task); await refresh();
      if (data.task.status === 'queued') await action('run', data.task.id);
    } catch (cause) { setError(cause instanceof Error && cause.name !== 'TimeoutError' ? cause.message : '提交结果尚未确认，请刷新核对；再次提交将沿用同一编号。'); }
    finally { submitGuard.current = false; setBusy(false); }
  }
  return <main className="ai-workbench">
    <header><Link href="/">← 返回 OA</Link><h1>AI 工作台</h1><p>把材料和要求交给 AI，生成文档并保存到本人的任务记录。</p></header>
    <div className="workbench-note">仅本人可见，不自动公开，不代替审批。第一版支持文字、TXT 和 Markdown 材料；Word 导出保留标题、正文、加粗和简单表格，图片与公式暂不转换。</div>
    {error && <div className="workbench-error" role="alert">{error} <button type="button" onClick={() => { setError(''); void refresh().catch(cause => setError(cause.message)); }}>刷新核对</button></div>}
    <div className="workbench-grid">
      <section className="workbench-card"><h2>交给 AI 做什么</h2><form onSubmit={submit}>
        <label>任务类型<select value={kind} onChange={e => setKind(e.target.value)}>{Object.entries(TASK_KINDS).map(([value,label]) => <option key={value} value={value}>{String(label)}</option>)}</select></label>
        <label>成果标题<input required maxLength={100} value={title} onChange={e => setTitle(e.target.value)} placeholder="例如：机器人项目周报" /></label>
        <label>任务要求<textarea required minLength={2} maxLength={2000} rows={3} value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="例如：整理本周进展、未解决问题和下一步行动。没有依据的内容标注待补充。" /></label>
        <label>文字材料<textarea required minLength={2} maxLength={20000} rows={10} value={material} onChange={e => setMaterial(e.target.value)} placeholder="粘贴需要处理的原文。只粘贴一个链接不会读取链接里的内容。" /></label>
        <div className="workbench-upload"><label>选择 TXT / Markdown 文件<input type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" onChange={async e => {
          const file = e.target.files?.[0]; if (!file) return;
          try {
            if (!/\.(txt|md|markdown)$/iu.test(file.name) || file.size > 90000) throw new Error('请选择90 KB以内的纯文字或 Markdown 文件。');
            const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
            if (text.length>20000 || text.trim().length<2 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) throw new Error('仅接受2–20000字的 UTF-8 文字材料。');
            setMaterial(text); if (!title) setTitle(file.name.replace(/\.[^.]+$/u,'').slice(0,100)); setError('');
          } catch (cause) { setError(cause instanceof Error ? cause.message : '读取文件失败。'); }
          e.target.value='';
        }} /></label><small>{material.length.toLocaleString()} / 20,000 字</small></div>
        <button className="workbench-primary" type="submit" disabled={busy}>{busy ? '任务已提交，正在核对成果…' : '生成并保存成果'}</button>
      </form><details><summary>在飞书中使用</summary><p>启用机器人后，在私聊中发送：</p><pre>任务：把以下内容整理成项目周报{ '\n' }材料：这里填写原文</pre><p>也可先转发一条文字消息，再回复那条消息“/任务 整理成周报”。合并转发、附件、图片和云文档链接暂不直接读取。飞书账号须先绑定本人 OA 实名成员并完成保密协议。</p></details></section>
      <section className="workbench-card workbench-output"><h2>任务与成果</h2><div className="workbench-task-list" aria-label="本人任务记录">{loading ? <p>正在读取任务记录…</p> : tasks.length ? tasks.map(task => <button key={task.id} type="button" aria-pressed={selected?.id===task.id} onClick={() => void choose(task.id)}><strong>{task.title}</strong><span>{statuses[task.status] || task.status} · {task.origin==='feishu' ? '飞书' : 'OA'}</span></button>) : <p>暂无任务。提交后，材料和成果会保存在这里。</p>}</div>
        {selected && <article><h3>{selected.title}</h3><p role="status">{statuses[selected.status]} · 已执行 {selected.attempts} 次</p>
          {selected.status==='failed' && <p className="workbench-error">{failureText(selected.failure_code)}</p>}
          <div className="workbench-actions">
            {selected.status==='succeeded' && <><a href={`/api/lab-ai/tasks?id=${selected.id}&format=docx`}>下载 Word</a><a href={`/api/lab-ai/tasks?id=${selected.id}&format=md`}>下载 Markdown</a></>}
            {selected.status==='failed' && selected.attempts<3 && !['TASK_MATERIAL_MISSING','TASK_UNSUPPORTED_MATERIAL'].includes(selected.failure_code) && <button type="button" disabled={busy} onClick={() => void action('retry',selected.id)}>手动重试</button>}
            {['queued','running'].includes(selected.status) && <button type="button" onClick={() => void action('cancel',selected.id)}>取消任务</button>}
          </div>
          {selected.origin==='feishu' && <p>飞书回传：{({ pending:'待发送',sent:'已取得发送回执',needs_review:'发送结果需人工核对，停止自动重发',skipped:'身份或任务状态变化，未发送' } as Record<string,string>)[selected.delivery_status]}</p>}
          {selected.result && <ResultPreview answer={selected.result} />}
          <details><summary>查看本次要求与原始材料</summary><pre>{selected.instruction}{'\n\n'}{selected.material}</pre></details>
        </article>}
      </section>
    </div>
  </main>;
}

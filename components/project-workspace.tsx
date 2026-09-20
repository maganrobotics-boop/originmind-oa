'use client';

/* This view synchronizes server-owned work items into local interaction state. */
/* eslint-disable react-hooks/set-state-in-effect */

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarDays, CheckCircle2, CircleDot, ClipboardCheck, Flag, ListTodo, Plus, RefreshCw, Target, UsersRound } from 'lucide-react';
import { toast } from 'sonner';
import type { WorkItem } from '@/lib/project-work-items';
import './project-workspace.css';

type ApprovalSummary = { id: string; title: string; type: string; status: string; step: string; updatedAt: string; currentReviewerEmail?: string };
type KnowledgeReviewSummary = { id: string; title: string; category: string; summary?: string; submitterName?: string; submitterEmail?: string; createdAt: string };
type PersonOption = { email: string; name: string };
type Props = { mode: 'todos' | 'project'; approvals: ApprovalSummary[]; currentUserEmail?: string; people?: PersonOption[]; canReviewKnowledge?: boolean; onOpenApproval: (id: string) => void; onOpenKnowledgeReview: () => void };

const kindLabel: Record<WorkItem['kind'], string> = { task: '任务', meeting_action: '会议行动项', risk: '风险', milestone: '里程碑' };
const today = () => new Date().toISOString().slice(0, 10);

export function ProjectWorkspace({ mode, approvals, currentUserEmail = '', people = [], canReviewKnowledge = false, onOpenApproval, onOpenKnowledgeReview }: Props) {
  const [items, setItems] = useState<WorkItem[]>([]);
  const [knowledgeReviews, setKnowledgeReviews] = useState<KnowledgeReviewSummary[]>([]);
  const [directory, setDirectory] = useState<PersonOption[]>(people);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<'task' | 'risk' | 'milestone'>('task');
  const [priority, setPriority] = useState<'low' | 'normal' | 'high'>('normal');
  const [dueAt, setDueAt] = useState('');
  const [assigneeEmail, setAssigneeEmail] = useState(currentUserEmail);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [response, peopleResponse, knowledgeResponse] = await Promise.all([
        fetch('/api/work-items', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } }),
        fetch('/api/people', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } }),
        canReviewKnowledge ? fetch('/api/knowledge?scope=review', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } }) : Promise.resolve(null),
      ]);
      const data = await response.json() as { items?: WorkItem[]; error?: string };
      if (!response.ok) throw new Error(data.error || '读取失败');
      const peopleData = await peopleResponse.json().catch(() => ({})) as { people?: Array<{ email: string; fullName: string }> };
      const knowledgeData = knowledgeResponse ? await knowledgeResponse.json().catch(() => ({})) as { items?: KnowledgeReviewSummary[] } : {};
      setItems(data.items || []);
      if (knowledgeResponse?.ok) setKnowledgeReviews(knowledgeData.items || []);
      if (peopleResponse.ok && peopleData.people?.length) setDirectory(peopleData.people.map(person => ({ email: person.email, name: person.fullName })));
      setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '读取失败'); }
    finally { setLoading(false); }
  }, [canReviewKnowledge]);
  useEffect(() => { void load(); }, [load]);

  const pendingApprovals = useMemo(() => approvals.filter(item => ['待审核', '审批中'].includes(item.status) && item.currentReviewerEmail?.toLowerCase() === currentUserEmail.toLowerCase()), [approvals, currentUserEmail]);
  const mine = useMemo(() => items.filter(item => item.assigneeEmail.toLowerCase() === currentUserEmail.toLowerCase() && !['done', 'cancelled'].includes(item.status)), [items, currentUserEmail]);
  const openItems = items.filter(item => !['done', 'cancelled'].includes(item.status));
  const risks = openItems.filter(item => item.kind === 'risk' || item.priority === 'high');
  const milestones = items.filter(item => item.kind === 'milestone');
  const overdue = openItems.filter(item => item.dueAt && item.dueAt < today());
  const completion = items.length ? Math.round(items.filter(item => item.status === 'done').length / items.length * 100) : 0;

  const update = async (item: WorkItem, status: WorkItem['status']) => {
    const response = await fetch('/api/work-items', { method: 'PATCH', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: item.id, status }) });
    const data = await response.json() as { item?: WorkItem; error?: string };
    if (!response.ok || !data.item) { toast.error(data.error || '状态未保存'); return; }
    setItems(current => current.map(value => value.id === item.id ? data.item! : value));
  };
  const create = async (event: FormEvent) => {
    event.preventDefault();
    const person = directory.find(value => value.email === assigneeEmail);
    const response = await fetch('/api/work-items', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'create', title, kind, priority, dueAt: dueAt || null, assigneeEmail, assigneeName: person?.name || '' }) });
    const data = await response.json() as { item?: WorkItem; error?: string };
    if (!response.ok || !data.item) { toast.error(data.error || '工作项未创建'); return; }
    setItems(current => [data.item!, ...current]); setTitle(''); setDueAt(''); setCreating(false); toast.success('工作项已加入统一待办');
  };

  const WorkItemRow = ({ item }: { item: WorkItem }) => <article className={`project-task ${item.priority === 'high' ? 'urgent' : ''}`}>
    <button type="button" className="project-task-check" onClick={() => void update(item, item.status === 'done' ? 'open' : 'done')} aria-label={item.status === 'done' ? '重新打开' : '标记完成'}>{item.status === 'done' ? <CheckCircle2 /> : <CircleDot />}</button>
    <div><div className="project-task-title"><strong>{item.title}</strong><span>{kindLabel[item.kind]}</span></div><p>{item.assigneeName || '待指定负责人'}{item.dueAt ? ` · 截止 ${item.dueAt}` : ' · 暂无截止日期'}{item.sourceType === 'meeting' ? ' · 来自会议纪要' : ''}</p></div>
    <select value={item.status} onChange={event => void update(item, event.target.value as WorkItem['status'])} aria-label="工作项状态"><option value="open">待处理</option><option value="in_progress">进行中</option><option value="done">已完成</option><option value="cancelled">已取消</option></select>
  </article>;

  if (mode === 'todos') return <div className="project-page">
    <header className="project-page-head"><div><span>统一待办中心</span><h1>今天需要处理的事</h1><p>审批、项目任务与会议行动项集中在这里，完成状态会回写项目工作台。</p></div><button onClick={() => void load()}><RefreshCw />刷新</button></header>
    <div className="project-summary-strip"><div><strong>{pendingApprovals.length + knowledgeReviews.length + mine.length}</strong><span>待我处理</span></div><div><strong>{overdue.filter(item => item.assigneeEmail.toLowerCase() === currentUserEmail.toLowerCase()).length}</strong><span>已经逾期</span></div><div><strong>{mine.filter(item => item.sourceType === 'meeting').length}</strong><span>会议行动项</span></div></div>
    {error && <p className="project-error">{error}</p>}
    <section className="project-panel"><h2><ClipboardCheck />待我审批</h2>{pendingApprovals.length ? pendingApprovals.map(item => <button type="button" className="approval-todo" key={item.id} onClick={() => onOpenApproval(item.id)}><div><strong>{item.title}</strong><span>{item.type} · 当前节点：{item.step}</span></div><b>处理</b></button>) : <p className="project-empty">目前没有待你审批的申请。</p>}</section>
    {canReviewKnowledge && <section className="project-panel"><h2><ClipboardCheck />大模型与资料审批</h2>{knowledgeReviews.length ? knowledgeReviews.map(item => <button type="button" className="approval-todo" key={item.id} onClick={onOpenKnowledgeReview}><div><strong>{item.title}</strong><span>{item.category} · 提交人：{item.submitterName || item.submitterEmail || '项目成员'}</span></div><b>审核范围</b></button>) : <p className="project-empty">目前没有待审核的大模型成果或资料。</p>}</section>}
    <section className="project-panel"><h2><ListTodo />我的任务与行动项</h2>{loading ? <p className="project-empty">正在读取工作项…</p> : mine.length ? mine.map(item => <WorkItemRow key={item.id} item={item} />) : <p className="project-empty">目前没有分配给你的任务。</p>}</section>
  </div>;

  return <div className="project-page">
    <header className="project-page-head"><div><span>项目工作台</span><h1>OriginMind × ARTS Robotics 联合研发项目</h1><p>进度、任务、会议决定与风险集中展示。</p></div><button className="project-primary" onClick={() => setCreating(value => !value)}><Plus />新建工作项</button></header>
    {creating && <form className="project-create" onSubmit={create}><input required maxLength={240} value={title} onChange={event => setTitle(event.target.value)} placeholder="工作项标题" /><select value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="task">任务</option><option value="milestone">里程碑</option><option value="risk">风险</option></select><select value={priority} onChange={event => setPriority(event.target.value as typeof priority)}><option value="normal">普通</option><option value="high">高优先级</option><option value="low">低优先级</option></select><select value={assigneeEmail} onChange={event => setAssigneeEmail(event.target.value)}><option value="">待指定负责人</option>{people.map(person => <option key={person.email} value={person.email}>{person.name}</option>)}</select><input type="date" value={dueAt} onChange={event => setDueAt(event.target.value)} /><button type="submit">添加</button></form>}
    {error && <p className="project-error">{error}</p>}
    <section className="project-metrics"><div><Target /><span>总体完成</span><strong>{completion}%</strong></div><div><ListTodo /><span>未完成任务</span><strong>{openItems.length}</strong></div><div><AlertTriangle /><span>风险与逾期</span><strong>{new Set([...risks, ...overdue].map(item => item.id)).size}</strong></div><div><UsersRound /><span>项目成员</span><strong>{directory.length || '—'}</strong></div></section>
    <div className="project-columns"><div><section className="project-panel"><h2><Flag />里程碑</h2>{milestones.length ? milestones.map(item => <WorkItemRow key={item.id} item={item} />) : <p className="project-empty">尚未设置里程碑，可从“新建工作项”添加。</p>}</section><section className="project-panel"><h2><ListTodo />任务看板</h2>{loading ? <p className="project-empty">正在读取…</p> : items.length ? items.filter(item => item.kind !== 'milestone').map(item => <WorkItemRow key={item.id} item={item} />) : <p className="project-empty">暂无项目任务。</p>}</section></div><aside><section className="project-panel project-risk"><h2><AlertTriangle />风险与阻塞</h2>{risks.length || overdue.length ? [...new Map([...risks, ...overdue].map(item => [item.id, item])).values()].map(item => <WorkItemRow key={item.id} item={item} />) : <p className="project-empty">当前没有已登记风险或逾期事项。</p>}</section><section className="project-panel"><h2><CalendarDays />最近审批动态</h2>{approvals.slice(0, 6).map(item => <button type="button" className="project-activity" key={item.id} onClick={() => onOpenApproval(item.id)}><strong>{item.title}</strong><span>{item.status} · {item.updatedAt}</span></button>)}</section></aside></div>
  </div>;
}

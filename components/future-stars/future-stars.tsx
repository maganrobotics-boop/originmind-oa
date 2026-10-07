'use client';
/* Remote records are intentionally synchronized into this view's query state. */
/* eslint-disable react-hooks/set-state-in-effect */

import { FormEvent, useEffect, useRef, useState } from 'react';
import { Award, BookOpen, ChevronLeft, ChevronRight, ExternalLink, GraduationCap, History, Plus, RefreshCw, Search, ShieldCheck, Sparkles, Trophy, UsersRound } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import './future-stars.css';

type Tab = 'students' | 'awards' | 'honors';
type Course = { id: string; title: string; parentId?: string };
type Learning = { courseId: string; title: string; submissions: number; reviewed: number; lastSubmittedAt?: number; draft?: { updatedAt: number } };
type Student = { email: string; displayName: string; signerName: string; grade: string; major: string; direction: string; agreementStatus: string;
  registeredAt: number; lastLoginAt?: number; completed: number; learning: Learning[];
  progress: { foundationCourseIds: string[]; foundationCompletedCourseIds: string[]; submittedCourseIds: string[]; exemptedCourseIds: string[]; currentCourseId?: string; accessMode?: string };
  graduation: { status: string; passedAt?: number } };
type Honor = { id: string; name: string; recipientEmail?: string; category: string; title: string; message: string; achievementDate?: string;
  sourceKind: string; sourceReference: string; grantedBy: string; issuedAt: number; visibility: string; status: string; version: number };
type Event = { version: number; action: string; actor: string; occurredAt: number; note: string };
type Recipient = { email: string; displayName: string; signerName: string };
type Submission = { id: string; title: string; createdAt: number; reviewState: string; reflection?: string; review?: unknown; error?: string };
type Data = { records?: Student[]; awards?: Honor[]; courses?: Course[]; page?: number; hasMore?: boolean; progressNote?: string;
  pagination?: { page: number; total: number; totalPages: number } };
const categories: Record<string, string> = { newbie: '新手村通关', alumni: '毕业纪念', competition: '竞赛获奖', contribution: '项目贡献', other: '其他荣誉' };
const actionNames: Record<string, string> = { grant: '授予', import: '导入', bind: '绑定账户', hide: '隐藏', show: '恢复公开', revoke: '撤回' };
const directionNames: Record<string, string> = { undecided: '待选择', perception: '感知', navigation: '导航', control: '控制', mechanics: '机械', ai: '人工智能' };
const date = (value?: number) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '暂无记录';
const endpoint = '/api/admin/future-stars';
async function get<T = Data>(view: string, params: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
  const response = await fetch(endpoint + '?' + new URLSearchParams({ view, ...params }), { credentials: 'same-origin', cache: 'no-store', signal });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || '暂时无法读取，请重试。');
  return data;
}
async function post(body: object) {
  const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(25000) });
  const data = await response.json() as { error?: string };
  if (!response.ok) throw new Error(data.error || '操作未完成，请重试。');
  return data;
}
function RecipientPicker({ value, onChange }: { value: string; onChange: (email: string) => void }) {
  const [q, setQ] = useState(''), [records, setRecords] = useState<Recipient[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  async function search() {
    const token = ++sequence.current; setBusy(true); setError('');
    try { const data = await get<{ recipients: Recipient[] }>('recipients', { q: q.trim() }); if (token === sequence.current) setRecords(data.recipients); }
    catch (e) { if (token === sequence.current) setError(e instanceof Error ? e.message : '查询未完成。'); }
    finally { if (token === sequence.current) setBusy(false); }
  }
  useEffect(() => () => { sequence.current++; }, []);
  return <div className="fs-recipient">
    <span className="fs-label">关联账户（可留空，稍后核验绑定）</span>
    <div className="fs-inline"><input aria-label="搜索关联账户" value={q} onChange={e => setQ(e.target.value)} placeholder="姓名或校内邮箱" maxLength={254} /><button type="button" disabled={busy || !q.trim()} onClick={() => void search()}>{busy ? '查询中…' : '查账户'}</button></div>
    {error && <small role="alert">{error}</small>}
    <select aria-label="选择已核验账户" value={value} onChange={e => onChange(e.target.value)}><option value="">暂不绑定</option>
      {value && !records.some(row => row.email === value) && <option value={value}>{value}</option>}
      {records.map(row => <option key={row.email} value={row.email}>{row.signerName || row.displayName || '未填写姓名'} · {row.email}</option>)}
    </select>
    <small>选择准确的账户，并填写核验说明。同名不会自动绑定。</small>
  </div>;
}
export function FutureStars() {
  const [tab, setTab] = useState<Tab>('students'), [data, setData] = useState<Data | null>(null), [loading, setLoading] = useState(true);
  const [courses, setCourses] = useState<Course[]>([]);
  const [search, setSearch] = useState(''), [q, setQ] = useState(''), [courseId, setCourseId] = useState(''), [status, setStatus] = useState('all');
  const [category, setCategory] = useState(''), [page, setPage] = useState(1), [revision, setRevision] = useState(0);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [formOpen, setFormOpen] = useState(false), [busy, setBusy] = useState(false);
  const [student, setStudent] = useState<Student | null>(null), [submissions, setSubmissions] = useState<Submission[]>([]), [recordPage, setRecordPage] = useState(1);
  const [recordTotal, setRecordTotal] = useState(0), [recordLoading, setRecordLoading] = useState(false), [recordError, setRecordError] = useState('');
  const [history, setHistory] = useState<{ award: Honor; events: Event[] } | null>(null), [historyError, setHistoryError] = useState('');
  const [action, setAction] = useState<{ award: Honor; kind: string } | null>(null), [note, setNote] = useState(''), [bindingEmail, setBindingEmail] = useState(''), [bindingConfirmed, setBindingConfirmed] = useState(false);
  const [form, setForm] = useState({ name: '', category: 'other', title: '', message: '', achievementDate: '', sourceKind: 'manual_confirmation',
    sourceReference: '', recipientEmail: '', bindingNote: '', visibility: 'public', confirmed: false });
  const grantRequest = useRef<{ fingerprint: string; id: string } | null>(null), historySequence = useRef(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(''); setData(null);
    const params: Record<string, string> = tab === 'students' ? { q, courseId, status, page: String(page) } : { status, page: String(page), ...(tab === 'honors' && category ? { category } : {}) };
    void get(tab, params, controller.signal).then(value => { if (!controller.signal.aborted) { setData(value); if (value.courses) setCourses(value.courses); } })
      .catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '读取未完成。'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [tab, q, courseId, status, category, page, revision]);
  useEffect(() => {
    if (!student) return;
    const controller = new AbortController(); setRecordLoading(true); setRecordError(''); setSubmissions([]);
    void get<{ records: Submission[]; pagination: { totalPages: number } }>('records', { email: student.email, courseId, page: String(recordPage) }, controller.signal).then(value => {
      if (!controller.signal.aborted) { setSubmissions(value.records); setRecordTotal(value.pagination.totalPages); }
    }).catch(e => { if (!controller.signal.aborted) setRecordError(e instanceof Error ? e.message : '记录暂不可用。'); })
      .finally(() => { if (!controller.signal.aborted) setRecordLoading(false); });
    return () => controller.abort();
  }, [student, courseId, recordPage]);
  useEffect(() => () => { historySequence.current++; }, []);
  function selectTab(next: Tab) {
    historySequence.current++; setTab(next); setPage(1); setStatus('all'); setCategory(''); setQ(''); setSearch(''); setCourseId('');
    setStudent(null); setHistory(null); setHistoryError(''); setNotice(''); setFormOpen(false);
  }
  function openForm() {
    setForm(current => ({ ...current, category: tab === 'awards' ? 'competition' : current.category })); setFormOpen(true); setError('');
  }
  async function grant(event: FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError(''); setNotice('');
    const award = { ...form, category: tab === 'awards' ? 'competition' : form.category };
    const fingerprint = JSON.stringify(award);
    if (!grantRequest.current || grantRequest.current.fingerprint !== fingerprint) grantRequest.current = { fingerprint, id: crypto.randomUUID() };
    try { await post({ action: 'grant', body: { ...award, requestId: grantRequest.current.id } });
      grantRequest.current = null; setFormOpen(false); setForm(current => ({ ...current, name: '', title: '', message: '', achievementDate: '', sourceReference: '', recipientEmail: '', bindingNote: '', confirmed: false }));
      setNotice('已保存，荣誉墙和个人奖杯已同步。'); setPage(1); setRevision(n => n + 1);
    } catch (e) { setError(e instanceof Error ? e.message : '保存未完成。'); } finally { setBusy(false); }
  }
  async function changeHonor(event: FormEvent) {
    event.preventDefault(); if (!action || busy) return; setBusy(true); setError('');
    try { await post({ action: 'honor_action', id: action.award.id, body: { action: action.kind, version: action.award.version, note,
      ...(action.kind === 'bind' ? { recipientEmail: bindingEmail, confirmed: bindingConfirmed } : {}) } });
      setAction(null); setNotice('已' + actionNames[action.kind] + '，操作记录已保存。'); setRevision(n => n + 1); setHistory(null);
    } catch (e) { setError(e instanceof Error ? e.message : '操作未完成。'); } finally { setBusy(false); }
  }
  async function showHistory(award: Honor) {
    const token = ++historySequence.current; setHistoryError(''); setHistory({ award, events: [] });
    try { const value = await get<{ events: Event[] }>('events', { id: award.id }); if (token === historySequence.current) setHistory({ award, events: value.events }); }
    catch (e) { if (token === historySequence.current) setHistoryError(e instanceof Error ? e.message : '记录暂不可用。'); }
  }
  const titles: Record<Tab, string> = { students: '课程学生进度', awards: '竞技赛获奖', honors: '荣誉墙管理' };
  const filteredAwards = data?.awards || [], students = data?.records || [];
  const hasNext = tab === 'students' ? page < (data?.pagination?.totalPages || 0) : Boolean(data?.hasMore);
  return <section className="future-stars" aria-label="未来之星管理">
    <header className="fs-header"><div><span><Sparkles size={15} />ORIGINMIND · 成长与荣誉</span><h1>未来之星</h1><p>学生学习、竞技赛获奖与荣誉墙，集中在这里管理。</p></div>
      <a href="https://chat.omindos.cn/learning/honors" target="_blank" rel="noreferrer"><Trophy size={16} />查看公开荣誉墙<ExternalLink size={13} /></a>
    </header>
    <nav className="fs-tabs" aria-label="未来之星栏目">{([{ key: 'students', icon: GraduationCap }, { key: 'awards', icon: Award }, { key: 'honors', icon: Trophy }] as const).map(({ key, icon: Icon }) =>
      <button type="button" key={key} aria-current={tab === key ? 'page' : undefined} onClick={() => selectTab(key)}><Icon size={18} />{titles[key]}</button>)}</nav>
    <div className="fs-section-heading"><div><h2>{titles[tab]}</h2><p>{tab === 'students' ? '按学生或课程查找学习记录，查看提交、AI 点评和结业状态。' : tab === 'awards' ? '登记已确认的获奖事实，获奖记录同时进入荣誉墙。' : '补录、核验账户、调整展示范围，保留每次操作的依据。'}</p></div>
      <div className="fs-inline">{tab !== 'students' && <button className="fs-primary" type="button" onClick={openForm}><Plus size={16} />{tab === 'awards' ? '登记获奖' : '补录荣誉'}</button>}<button type="button" onClick={() => setRevision(n => n + 1)} disabled={loading}><RefreshCw size={15} />刷新</button></div>
    </div>
    {notice && <p className="fs-notice" role="status"><ShieldCheck size={17} />{notice}</p>}
    {error && <div className="fs-error" role="alert">{error}<button type="button" onClick={() => setRevision(n => n + 1)}>重新读取</button></div>}
    <form className="fs-filters" onSubmit={e => { e.preventDefault(); setQ(search.trim()); setPage(1); }}>
      {tab === 'students' ? <><label className="fs-search"><Search size={16} /><input aria-label="搜索学生姓名或邮箱" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索姓名或邮箱" maxLength={100} /></label>
        <select aria-label="筛选课程" value={courseId} onChange={e => { setCourseId(e.target.value); setPage(1); }}><option value="">全部课程</option>{courses.map(course => <option key={course.id} value={course.id}>{course.parentId ? '↳ ' : ''}{course.title}</option>)}</select>
        <select aria-label="筛选学生进度" value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}><option value="all">全部学生</option><option value="started">已有学习标记</option><option value="not_started">尚无学习标记</option></select><button type="submit">查询</button></> :
        <>{tab === 'honors' && <select aria-label="筛选荣誉类别" value={category} onChange={e => { setCategory(e.target.value); setPage(1); }}><option value="">全部类别</option>{Object.entries(categories).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>}
        <select aria-label="筛选荣誉状态" value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}><option value="all">全部状态</option><option value="public">公开展示</option><option value="hidden">仅本人可见</option><option value="unbound">待绑定账户</option><option value="revoked">已撤回</option></select>
        {tab === 'awards' && <a className="fs-competition-link" href="https://chat.omindos.cn/arena/" target="_blank" rel="noreferrer">查看竞技场成绩与规则<ExternalLink size={13} /></a>}</>}
    </form>
    {tab === 'students' && data?.progressNote && <p className="fs-footnote">{data.progressNote}</p>}
    {loading ? <div className="fs-empty" role="status"><RefreshCw size={22} />正在读取{titles[tab]}…</div> : !error && (
      tab === 'students' ? <div className="fs-students">{students.length === 0 ? <div className="fs-empty"><UsersRound size={26} />没有找到符合条件的学生。</div> :
        students.map(row => <article className="fs-student" key={row.email}><div className="fs-person"><span>{(row.signerName || row.displayName || '学').slice(0, 1)}</span><div><h3>{row.signerName || row.displayName || '未填写姓名'}</h3><p>{row.email}</p><small>{[row.grade, row.major, directionNames[row.direction]].filter(Boolean).join(' · ')}</small></div></div>
          <div className="fs-progress"><span>新手村进度 {row.progress.foundationCompletedCourseIds.length}/{row.progress.foundationCourseIds.length}</span><progress max={row.progress.foundationCourseIds.length || 1} value={row.progress.foundationCompletedCourseIds.length} /><small>学生完成标记 {row.completed} 关 · 已提交 {row.progress.submittedCourseIds.length} 节</small>
            {row.progress.exemptedCourseIds.length > 0 && <small>直通车免修 {row.progress.exemptedCourseIds.length} 节</small>}{row.progress.accessMode === 'all_courses' && <small>已获课程访问授权</small>}</div>
          <div className="fs-student-status"><span className={row.graduation.status === 'passed' ? 'fs-pill fs-green' : 'fs-pill'}>{row.graduation.status === 'passed' ? '结业已通过' : row.graduation.status === 'needs_retry' ? '结业需重试' : '尚未结业'}</span><small>最近登录 {date(row.lastLoginAt)}</small><button type="button" onClick={() => { setStudent(row); setRecordPage(1); }}>查看学习记录<ChevronRight size={14} /></button></div>
        </article>)}</div> :
      <div className="fs-honors">{filteredAwards.length === 0 ? <div className="fs-empty"><Trophy size={28} />{tab === 'awards' ? '还没有登记的竞技赛获奖记录。' : '没有符合条件的荣誉记录。'}</div> : filteredAwards.map(award => <article key={award.id} className="fs-honor">
        <div className="fs-honor-icon"><Trophy size={24} /></div><div className="fs-honor-body"><div className="fs-honor-title"><h3>{award.name}</h3><span className="fs-pill">{categories[award.category]}</span><span className={'fs-pill ' + (award.status === 'revoked' ? 'fs-muted' : award.visibility === 'public' ? 'fs-green' : '')}>{award.status === 'revoked' ? '已撤回' : award.visibility === 'public' ? '公开展示' : '仅本人可见'}</span></div>
          <strong>{award.title}</strong>{award.message && <p>{award.message}</p>}<small>{award.achievementDate ? '获奖 / 事迹日期 ' + award.achievementDate + ' · ' : ''}授予 {date(award.issuedAt)}</small><small>关联账户：{award.recipientEmail || '待核验绑定'}</small>
          <div className="fs-honor-actions"><button type="button" onClick={() => void showHistory(award)}><History size={14} />来源与操作记录</button>{award.status !== 'revoked' && <>{['bind', award.visibility === 'public' ? 'hide' : 'show', 'revoke'].map(kind => <button type="button" key={kind} className={kind === 'revoke' ? 'fs-danger-text' : ''} onClick={() => { setAction({ award, kind }); setNote(''); setBindingEmail(award.recipientEmail || ''); setBindingConfirmed(false); setError(''); }}>{actionNames[kind]}</button>)}</>}</div>
        </div></article>)}</div>
    )}
    {data && !loading && <div className="fs-pages"><span>{tab === 'students' ? '共 ' + data.pagination?.total + ' 位学生 · ' : ''}第 {page} 页</span><button type="button" disabled={page <= 1} onClick={() => setPage(n => n - 1)}><ChevronLeft size={14} />上一页</button><button type="button" disabled={!hasNext} onClick={() => setPage(n => n + 1)}>下一页<ChevronRight size={14} /></button></div>}

    <Dialog open={formOpen} onOpenChange={open => { if (!busy) setFormOpen(open); }}><DialogContent className="fs-dialog"><DialogHeader><DialogTitle>{tab === 'awards' ? '登记竞技赛获奖' : '补录荣誉'}</DialogTitle><DialogDescription>填写已确认的事实与来源，保存后同步至荣誉墙。未绑定账户也可先登记。</DialogDescription></DialogHeader>
      <form className="fs-form" onSubmit={grant}>
        <div className="fs-form-row"><label>获奖人姓名<input required maxLength={80} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label><label>类别<select value={tab === 'awards' ? 'competition' : form.category} disabled={tab === 'awards'} onChange={e => setForm({ ...form, category: e.target.value })}>{Object.entries(categories).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label></div>
        <label>{tab === 'awards' ? '比赛与奖项名称' : '荣誉名称'}<input required maxLength={100} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder={tab === 'awards' ? '例如：巡检导航竞技赛 · 一等奖' : '填写实际获得的荣誉'} /></label>
        <label>公开事迹<textarea maxLength={600} rows={2} value={form.message} onChange={e => setForm({ ...form, message: e.target.value })} placeholder="可公开的事迹、队伍或成绩说明" /></label>
        <div className="fs-form-row"><label>获奖 / 事迹日期（未知可留空）<input type="date" value={form.achievementDate} onChange={e => setForm({ ...form, achievementDate: e.target.value })} /></label><label>展示范围<select value={form.visibility} onChange={e => setForm({ ...form, visibility: e.target.value })}><option value="public">公开展示</option><option value="hidden">仅本人可见</option></select></label></div>
        <label>确认方式<select value={form.sourceKind} onChange={e => setForm({ ...form, sourceKind: e.target.value })}><option value="manual_confirmation">教师 / 管理员人工确认</option><option value="reference">获奖公告或可追溯材料</option></select></label>
        <label>确认依据（仅管理员可见）<textarea required rows={2} maxLength={1200} value={form.sourceReference} onChange={e => setForm({ ...form, sourceReference: e.target.value })} placeholder="填写确认人、比赛公告、成绩记录或材料地址" /></label>
        <RecipientPicker value={form.recipientEmail} onChange={email => setForm(current => ({ ...current, recipientEmail: email }))} />
        {form.recipientEmail && <label>账户核验说明<textarea required maxLength={600} rows={2} value={form.bindingNote} onChange={e => setForm({ ...form, bindingNote: e.target.value })} placeholder="说明如何确认此账户属于获奖人" /></label>}
        <label className="fs-checkbox"><input type="checkbox" checked={form.confirmed} onChange={e => setForm({ ...form, confirmed: e.target.checked })} required />我已核实荣誉事实、来源和选中的账户。</label>
        {error && <p className="fs-error" role="alert">{error}</p>}<div className="fs-form-actions"><button type="button" disabled={busy} onClick={() => setFormOpen(false)}>暂时收起</button><button type="submit" className="fs-primary" disabled={busy || !form.confirmed}>{busy ? '保存中…' : '确认并保存'}</button></div>
      </form>
    </DialogContent></Dialog>
    <Dialog open={Boolean(action)} onOpenChange={open => { if (!open && !busy) setAction(null); }}><DialogContent className="fs-dialog"><DialogHeader><DialogTitle>{actionNames[action?.kind || '']}荣誉</DialogTitle><DialogDescription>{action?.award.name} · {action?.award.title}</DialogDescription></DialogHeader>
      <form className="fs-form" onSubmit={changeHonor}>{action?.kind === 'bind' && <><RecipientPicker value={bindingEmail} onChange={setBindingEmail} /><label className="fs-checkbox"><input type="checkbox" checked={bindingConfirmed} onChange={e => setBindingConfirmed(e.target.checked)} required />已人工核对获奖人与此账户的身份。</label></>}
        <p className="fs-footnote">{action?.kind === 'revoke' ? '撤回后，公共墙和个人奖杯均不再展示；原记录与操作依据保留。' : action?.kind === 'hide' ? '隐藏后，公共墙不再展示，获奖人仍可查看自己的奖杯。' : action?.kind === 'show' ? '恢复至公共荣誉墙，原授予日期保持不变。' : '绑定后，获奖人在自己的账户中可以查看此奖杯。'}</p>
        <label>操作 / 核验说明<textarea required maxLength={1200} rows={3} value={note} onChange={e => setNote(e.target.value)} /></label>{error && <p className="fs-error" role="alert">{error}</p>}<div className="fs-form-actions"><button type="button" disabled={busy} onClick={() => setAction(null)}>取消</button><button type="submit" className="fs-primary" disabled={busy || !note.trim() || (action?.kind === 'bind' && (!bindingEmail || !bindingConfirmed))}>{busy ? '处理中…' : '确认' + actionNames[action?.kind || '']}</button></div>
      </form>
    </DialogContent></Dialog>
    <Dialog open={Boolean(student)} onOpenChange={open => { if (!open) setStudent(null); }}><DialogContent className="fs-dialog fs-record-dialog"><DialogHeader><DialogTitle>{student?.signerName || student?.displayName || '学生'}的学习记录</DialogTitle><DialogDescription>{student?.email} · {courseId ? courses.find(c => c.id === courseId)?.title : '全部课程'}</DialogDescription></DialogHeader>
      <div className="fs-detail-body">{student && <div className="fs-course-list">{student.learning.length === 0 ? <p>尚无保存在服务器上的草稿或提交。</p> : student.learning.filter(c => !courseId || c.courseId === courseId || courses.find(k => k.id === c.courseId)?.parentId === courseId).map(c => <div key={c.courseId}><BookOpen size={16} /><strong>{c.title}</strong><span>提交 {c.submissions} 次 · 已点评 {c.reviewed || 0} 次{c.draft ? ' · 有草稿' : ''}</span></div>)}</div>}
        <h3>提交与 AI 点评</h3>{recordLoading && <p role="status">读取中…</p>}{recordError && <p className="fs-error" role="alert">{recordError}</p>}{!recordLoading && !recordError && submissions.length === 0 && <p>暂无提交记录。</p>}
        {submissions.map(row => <article className="fs-submission" key={row.id}><strong>{row.title}</strong><small>{date(row.createdAt)} · {row.reviewState === 'done' ? 'AI 已点评' : row.reviewState === 'error' ? '点评未完成' : '等待点评'}</small>{row.reflection && <p>{row.reflection}</p>}{Boolean(row.review) && <pre>{typeof row.review === 'string' ? row.review : JSON.stringify(row.review, null, 2)}</pre>}{row.error && <p>{row.error}</p>}</article>)}
        <p className="fs-footnote">AI 点评供教学参考；保存、提交和免修分别记录，教师验收结果以实际确认记录为准。</p>
        <div className="fs-pages"><span>第 {recordPage} 页</span><button type="button" disabled={recordPage <= 1 || recordLoading} onClick={() => setRecordPage(n => n - 1)}>上一页</button><button type="button" disabled={recordPage >= recordTotal || recordLoading} onClick={() => setRecordPage(n => n + 1)}>下一页</button></div>
      </div>
    </DialogContent></Dialog>
    <Dialog open={Boolean(history)} onOpenChange={open => { if (!open) { historySequence.current++; setHistory(null); } }}><DialogContent className="fs-dialog"><DialogHeader><DialogTitle>来源与操作记录</DialogTitle><DialogDescription>{history?.award.name} · {history?.award.title}</DialogDescription></DialogHeader>
      <div className="fs-detail-body"><p className="fs-evidence">{history?.award.sourceReference}</p>{historyError && <p className="fs-error" role="alert">{historyError}</p>}{history?.events.map(event => <article className="fs-event" key={event.version}><strong>{actionNames[event.action]} · 第 {event.version} 版</strong><small>{date(event.occurredAt)} · {event.actor}</small><p>{event.note}</p></article>)}</div>
    </DialogContent></Dialog>
  </section>;
}

"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  Bot,
  Check,
  FileCheck2,
  FileText,
  Globe2,
  Info,
  LibraryBig,
  LoaderCircle,
  MessageCircle,
  Pencil,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { PUBLIC_KNOWLEDGE_CONFIRMATION } from "@/lib/knowledge-policy";
import type {
  KnowledgeAction,
  KnowledgeAskResponse,
  KnowledgeCitation,
  KnowledgeDetailResponse,
  KnowledgeEvent,
  KnowledgeItem,
  KnowledgeListResponse,
  KnowledgeRevision,
  KnowledgeStatus,
  KnowledgeVisibility,
} from "@/lib/knowledge-types";

type KnowledgeTab = "ask" | "submit" | "mine" | "review" | "manage";
type KnowledgeDraft = { title: string; category: string; summary: string; content: string; sourceLabel: string; sourceUrl: string };
type AskTurn = { id: string; question: string; answer: string; citations: KnowledgeCitation[]; mode?: string };
type ReviewDetail = Required<Pick<KnowledgeDetailResponse, "revisions" | "events">> & { item: KnowledgeItem };

const categories = ["技术方案", "实验记录", "设备与操作", "软件与代码", "项目规范", "常见问题", "其他"];
const emptyDraft = (): KnowledgeDraft => ({ title: "", category: categories[0], summary: "", content: "", sourceLabel: "", sourceUrl: "" });
const PUBLIC_DATA_ANONYMIZATION_NOTICE = "所有公开的数据需要脱敏处理。脱敏时，论文和学位材料保留摘要、研究方法、实验过程、结果与结论等技术正文，删除封面、参考文献作者表、致谢、评语、签字页等身份信息密集内容；对于扫描件，仅保留匿名化摘要和检索说明，不嵌入含姓名、学号、签名、地址等个人隐私的原始图片。";

const statusMeta: Record<KnowledgeStatus, { label: string; detail: string }> = {
  pending: { label: "待审核", detail: "等待项目负责人或 OA 管理员审核" },
  returned: { label: "已退回", detail: "请按审核意见修改后重提" },
  rejected: { label: "已拒绝", detail: "本版本不会进入知识库" },
  active: { label: "已入库", detail: "已按当前可见范围提供检索" },
  revoked: { label: "已撤销", detail: "已停止用于对应范围的知识问答" },
};

function knowledgeVisibility(item: KnowledgeItem): KnowledgeVisibility | undefined {
  if (item.status !== "active" && item.status !== "revoked") return undefined;
  const value = (item as KnowledgeItem & { visibility?: unknown }).visibility;
  if (value === "internal" || value === "public") return value;
  return "internal";
}

async function responseJson<T extends { error?: string }>(response: Response, fallback: string): Promise<T> {
  const data = await response.json().catch(() => ({})) as T;
  if (!response.ok) throw new Error(data.error || fallback);
  return data;
}

function formatDate(value?: string) {
  if (!value) return "时间未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date).replaceAll("/", "-");
}

function safeHttpUrl(value?: string) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password ? url.toString() : "";
  } catch {
    return "";
  }
}

function currentRevision(detail: ReviewDetail): KnowledgeRevision | undefined {
  return detail.revisions.find((revision) => revision.id === detail.item.currentRevisionId)
    || [...detail.revisions].sort((a, b) => (b.revisionNo || 0) - (a.revisionNo || 0))[0];
}

function askModeLabel(mode?: string) {
  if (!mode) return "知识库回答";
  if (["model", "rag", "grounded"].includes(mode)) return "大模型综合";
  if (["retrieval", "retrieval-only", "extractive"].includes(mode)) return "知识检索";
  return "知识库回答";
}

function KnowledgeStatusBadge({ status }: { status: KnowledgeStatus }) {
  const meta = statusMeta[status] || statusMeta.pending;
  return <Badge variant="outline" className={`knowledge-status knowledge-status-${status}`}><span />{meta.label}</Badge>;
}

function KnowledgeVisibilityBadge({ item }: { item: KnowledgeItem }) {
  const visibility = knowledgeVisibility(item);
  if (!visibility) return null;
  return <Badge variant="outline" className={`knowledge-visibility knowledge-visibility-${visibility}`}>{visibility === "public" ? <Globe2 className="size-3" /> : <ShieldCheck className="size-3" />}{visibility === "public" ? "对外公开" : "仅 OA 内部"}</Badge>;
}

function KnowledgeMultipartReviewMeta({ item }: { item: KnowledgeItem }) {
  if (!item.contentPartCount || item.contentPartCount <= 1) return null;
  return <span>1 个文件 · {item.contentPartCount} 个正文分片 · 统一审核</span>;
}

function EmptyPanel({ icon: Icon, title, description, action }: { icon: typeof BookOpen; title: string; description: string; action?: React.ReactNode }) {
  return <div className="knowledge-empty"><div className="knowledge-empty-icon"><Icon className="size-5" /></div><strong>{title}</strong><p>{description}</p>{action}</div>;
}

function LoadingPanel({ label }: { label: string }) {
  return <div className="knowledge-loading" role="status"><LoaderCircle className="size-4" />{label}</div>;
}

function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="knowledge-error" role="alert"><AlertTriangle className="size-5" /><div><strong>暂时无法加载</strong><p>{message}</p></div><Button type="button" variant="outline" size="sm" onClick={onRetry}><RotateCcw className="size-3.5" />重试</Button></div>;
}

function KnowledgeAnonymizationNotice() {
  return <div className="knowledge-submit-note knowledge-anonymization-note" role="note"><ShieldCheck className="size-4" /><p><strong>公开数据脱敏要求</strong>{PUBLIC_DATA_ANONYMIZATION_NOTICE}</p></div>;
}

function CitationList({ citations, turnId }: { citations: KnowledgeCitation[]; turnId: string }) {
  if (!citations.length) return null;
  return <section className="knowledge-citations" aria-label="回答引用">
    <div className="knowledge-citations-heading"><BookOpen className="size-3.5" /><strong>引用依据</strong><span>{citations.length} 条</span></div>
    <ol>{citations.map((citation, index) => {
      const location = citation.sectionTitle || citation.section || citation.paragraphRef;
      const sourceUrl = safeHttpUrl(citation.sourceUrl);
      return <li key={`${turnId}-${citation.id}-${index}`}>
        <div className="knowledge-citation-index">{citation.id || index + 1}</div>
        <div><div className="knowledge-citation-title"><strong>{citation.title}</strong>{citation.category && <span>{citation.category}</span>}</div>{(location || citation.sourceLabel) && <small>{[location && `${location}${citation.paragraphRef && citation.paragraphRef !== location ? ` · ${citation.paragraphRef}` : ""}`, citation.sourceLabel].filter(Boolean).join(" · ")}</small>}<p>{citation.excerpt}</p>{sourceUrl && <a className="knowledge-citation-link" href={sourceUrl} target="_blank" rel="noreferrer">查看来源</a>}</div>
      </li>;
    })}</ol>
  </section>;
}

function KnowledgeAskPanel() {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const [asking, setAsking] = useState(false);
  const examples = ["机器人底盘急停与恢复的操作流程是什么？", "最近有哪些已审核的测试结论？", "项目资料对外分享需要注意什么？"];

  const ask = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedQuestion = question.trim();
    if (normalizedQuestion.length < 2) {
      toast.info("问题至少需要 2 个字符");
      return;
    }
    setAsking(true);
    try {
      const response = await fetch("/api/lab-ai/ask", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ question: normalizedQuestion }),
      });
      const data = await responseJson<KnowledgeAskResponse>(response, "知识助手暂时无法回答");
      if (!data.answer?.trim()) throw new Error("知识助手没有返回有效回答");
      setTurns((current) => [...current, {
        id: `${Date.now()}-${current.length}`,
        question: normalizedQuestion,
        answer: data.answer!.trim(),
        citations: data.citations ?? [],
        mode: data.mode,
      }]);
      setQuestion("");
    } catch (error) {
      toast.error("问题未发送", { description: error instanceof Error ? error.message : "请稍后重试" });
    } finally {
      setAsking(false);
    }
  };

  return <div className="knowledge-ask-layout">
    <section className="knowledge-chat-card">
      <div className="knowledge-card-heading"><div className="knowledge-card-icon"><Bot className="size-[18px]" /></div><div><h2>在 OA 内向实验室 AI 提问</h2><p>仅已登录并完成准入与保密签署的成员可使用；助手检索已审核、仍有效的内部及公开知识，并列出依据。</p></div></div>
      <div className="knowledge-conversation" aria-live="polite">
        {turns.length === 0 ? <div className="knowledge-welcome"><div className="knowledge-welcome-mark"><Sparkles className="size-5" /></div><strong>从团队已经确认的知识开始</strong><p>可以询问实验步骤、设备操作、技术结论或项目规范。没有足够依据时，助手会明确说明。</p><div className="knowledge-example-list">{examples.map((example) => <button type="button" key={example} onClick={() => setQuestion(example)}>{example}</button>)}</div></div> : turns.map((turn) => <article className="knowledge-turn" key={turn.id}>
          <div className="knowledge-question"><span>你</span><p>{turn.question}</p></div>
          <div className="knowledge-answer"><div className="knowledge-answer-avatar"><Bot className="size-4" /></div><div className="knowledge-answer-content"><div className="knowledge-answer-label"><strong>实验室知识助手</strong><Badge variant="outline">{askModeLabel(turn.mode)}</Badge></div><p>{turn.answer}</p><CitationList citations={turn.citations} turnId={turn.id} />{turn.citations.length === 0 && <div className="knowledge-no-citations"><AlertTriangle className="size-3.5" />本次没有检索到可引用的已审核知识，请勿将回答作为关键操作依据。</div>}</div></div>
        </article>)}
        {asking && <div className="knowledge-answer knowledge-answer-loading" role="status"><div className="knowledge-answer-avatar"><Bot className="size-4" /></div><div><LoaderCircle className="size-4" />正在查找审核通过的知识…</div></div>}
      </div>
      <form className="knowledge-ask-form" onSubmit={ask}>
        <label htmlFor="knowledge-question">输入问题</label>
        <div><Textarea id="knowledge-question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：激光雷达标定前需要做哪些检查？" rows={3} minLength={2} maxLength={500} disabled={asking} /><Button type="submit" className="primary-button" disabled={asking || question.trim().length < 2}>{asking ? <LoaderCircle className="size-4" /> : <Send className="size-4" />}{asking ? "检索中" : "发送"}</Button></div>
        <small>回答用于项目协作参考；关键操作仍应结合原始记录和负责人要求核对。</small>
      </form>
    </section>
    <aside className="knowledge-principles">
      <div><ShieldCheck className="size-5" /><strong>先审核，再选择范围</strong><p>成员投稿不会立即参与问答；项目负责人或 OA 管理员批准时必须选择“对内”或“对外公开”。</p></div>
      <div><FileCheck2 className="size-5" /><strong>回答附带依据</strong><p>每次命中知识库时展示条目、章节和原文片段，方便回看。</p></div>
      <div><LibraryBig className="size-5" /><strong>仅使用有效版本</strong><p>被退回、拒绝或撤销的内容不会被知识问答调用。</p></div>
    </aside>
  </div>;
}

function KnowledgeSubmitPanel({
  draft,
  setDraft,
  editingItem,
  submitting,
  onSubmit,
  onCancelEdit,
}: {
  draft: KnowledgeDraft;
  setDraft: React.Dispatch<React.SetStateAction<KnowledgeDraft>>;
  editingItem: KnowledgeItem | null;
  submitting: boolean;
  onSubmit: (event: FormEvent) => void;
  onCancelEdit: () => void;
}) {
  return <section className="knowledge-form-card">
    <div className="knowledge-card-heading"><div className="knowledge-card-icon"><FileText className="size-[18px]" /></div><div><h2>{editingItem ? "修改并重新提交" : "提交一条实验室知识"}</h2><p>{editingItem ? "请按审核意见完善内容；重提后将重新进入审核队列。" : "所有已完成 OA 准入的成员都可以投稿；审核人批准时再选择对内或对外公开。"}</p></div></div>
    {editingItem && <div className="knowledge-editing-banner"><Pencil className="size-4" /><div><strong>正在修改：{editingItem.title}</strong><p>{editingItem.reviewNote || "请完善内容后重新提交。"}</p></div><button type="button" onClick={onCancelEdit} aria-label="取消修改"><X className="size-4" /></button></div>}
    <form className="knowledge-submit-form" onSubmit={onSubmit}>
      <div className="knowledge-form-grid">
        <label className="form-field"><span className="field-label">知识标题 <b className="required-mark">*</b></span><Input value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} placeholder="一句话说明这条知识解决什么问题" minLength={2} maxLength={100} required disabled={submitting} /></label>
        <label className="form-field"><span className="field-label">分类 <b className="required-mark">*</b></span><NativeSelect value={draft.category} onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value }))} disabled={submitting}>{categories.map((category) => <NativeSelectOption value={category} key={category}>{category}</NativeSelectOption>)}</NativeSelect></label>
      </div>
      <label className="form-field"><span className="field-label">摘要 <small>可选</small></span><Input value={draft.summary} onChange={(event) => setDraft((current) => ({ ...current, summary: event.target.value }))} placeholder="用一两句话概括适用场景和结论" maxLength={400} disabled={submitting} /></label>
      <label className="form-field"><span className="field-label">知识正文 <b className="required-mark">*</b></span><Textarea className="knowledge-content-input" value={draft.content} onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))} placeholder={"建议写清楚：\n1. 适用条件和前置准备\n2. 操作步骤或技术结论\n3. 风险、限制和验证方式"} rows={12} minLength={10} maxLength={20_000} required disabled={submitting} /><span className="knowledge-character-count">{draft.content.length.toLocaleString("zh-CN")} / 20,000</span></label>
      <div className="knowledge-form-grid">
        <label className="form-field"><span className="field-label">来源名称 <small>可选</small></span><Input value={draft.sourceLabel} onChange={(event) => setDraft((current) => ({ ...current, sourceLabel: event.target.value }))} placeholder="例如：底盘联调记录 2026-09" maxLength={160} disabled={submitting} /></label>
        <label className="form-field"><span className="field-label">来源链接 <small>可选，仅 http/https</small></span><Input type="url" inputMode="url" value={draft.sourceUrl} onChange={(event) => setDraft((current) => ({ ...current, sourceUrl: event.target.value }))} placeholder="https://…" maxLength={2048} disabled={submitting} /></label>
      </div>
      <KnowledgeAnonymizationNotice />
      <div className="knowledge-submit-note"><Info className="size-4" /><p><strong>提交前请确认</strong>内容不含个人隐私、账号密码或密钥；审核人批准时会选择仅供 OA 内部使用，或经二次确认后对外公开。</p></div>
      <div className="knowledge-form-actions">{editingItem && <Button type="button" variant="outline" onClick={onCancelEdit} disabled={submitting}>取消修改</Button>}<Button type="submit" className="primary-button" disabled={submitting}>{submitting ? <LoaderCircle className="size-4" /> : <Send className="size-4" />}{submitting ? "提交中" : editingItem ? "重新提交审核" : "提交审核"}</Button></div>
    </form>
  </section>;
}

function KnowledgeItemCard({ item, onEdit }: { item: KnowledgeItem; onEdit?: (item: KnowledgeItem) => void }) {
  const meta = statusMeta[item.status] || statusMeta.pending;
  const isMultipartImport = Boolean(item.contentPartCount && item.contentPartCount > 1);
  return <article className="knowledge-item-card">
    <div className="knowledge-item-topline"><span className="knowledge-category">{item.category}</span><div className="knowledge-item-badges"><KnowledgeVisibilityBadge item={item} /><KnowledgeStatusBadge status={item.status} /></div></div>
    <h3>{item.title}</h3>
    {item.summary && <p className="knowledge-item-summary">{item.summary}</p>}
    <div className="knowledge-item-state"><span>{meta.detail}</span>{item.currentRevisionNo && <small>第 {item.currentRevisionNo} 版</small>}</div>
    {item.reviewNote && <div className="knowledge-review-note"><MessageCircle className="size-3.5" /><div><strong>审核意见</strong><p>{item.reviewNote}</p></div></div>}
    <footer><time dateTime={item.updatedAt}>更新于 {formatDate(item.updatedAt)}</time>{item.status === "returned" && isMultipartImport ? <small>大文档请从 <a href={`https://chat.omindos.ai/manage?returnedKnowledgeItem=${encodeURIComponent(item.id)}`} target="_blank" rel="noreferrer">Chat 管理页面</a>重新导入；成功后会更新当前条目和审计记录</small> : item.status === "returned" && onEdit && <Button type="button" variant="outline" size="sm" onClick={() => onEdit(item)}><Pencil className="size-3.5" />修改并重提</Button>}</footer>
  </article>;
}

function KnowledgeMinePanel({ items, loading, error, onRetry, onEdit, editingId }: { items: KnowledgeItem[]; loading: boolean; error: string; onRetry: () => void; onEdit: (item: KnowledgeItem) => void; editingId: string }) {
  if (loading) return <LoadingPanel label="正在加载我的知识投稿…" />;
  if (error) return <ErrorPanel message={error} onRetry={onRetry} />;
  if (!items.length) return <EmptyPanel icon={FileText} title="还没有提交过知识" description="把经过验证的实验记录、操作方法或技术结论整理后提交给管理员审核。" />;
  return <div className="knowledge-list"><div className="knowledge-list-summary"><span>当前显示 {items.length} 条投稿</span><small>最多显示最近 100 条；审核记录和历史状态会保留</small></div><div className="knowledge-item-grid">{items.map((item) => <KnowledgeItemCard item={item} onEdit={editingId === item.id ? undefined : onEdit} key={item.id} />)}</div></div>;
}

function KnowledgeReviewPanel({ items, pendingCount, loading, error, onRetry, onOpen }: { items: KnowledgeItem[]; pendingCount: number; loading: boolean; error: string; onRetry: () => void; onOpen: (item: KnowledgeItem) => void }) {
  if (loading) return <LoadingPanel label="正在加载待审核知识…" />;
  if (error) return <ErrorPanel message={error} onRetry={onRetry} />;
  if (!items.length) return <EmptyPanel icon={Check} title="当前没有待审核知识" description="新的成员投稿会出现在这里；批准时必须选择仅在 OA 内部使用，或二次确认后对外公开。" />;
  return <div className="knowledge-list"><div className="knowledge-list-summary"><span>待审核 {pendingCount || items.length} 条{pendingCount > items.length ? `，当前显示前 ${items.length} 条` : ""}</span><small>请核对准确性、敏感信息，并为每条知识选择“对内”或“对外公开”</small></div><div className="knowledge-review-list">{items.map((item) => <article className="knowledge-review-row" key={item.id}><div className="knowledge-review-row-main"><div><span className="knowledge-category">{item.category}</span><time>{formatDate(item.createdAt)}</time></div><h3>{item.title}</h3>{item.summary && <p>{item.summary}</p>}{item.contentPartCount && item.contentPartCount > 1 && <small><KnowledgeMultipartReviewMeta item={item} /></small>}<small>提交人：{item.submitterName || item.submitterEmail || "项目成员"}</small></div><Button type="button" variant="outline" onClick={() => onOpen(item)}>查看并选择范围</Button></article>)}</div></div>;
}

function KnowledgeManagePanel({ items, loading, error, onRetry, onOpen, onRevoke }: { items: KnowledgeItem[]; loading: boolean; error: string; onRetry: () => void; onOpen: (item: KnowledgeItem) => void; onRevoke: (item: KnowledgeItem) => void }) {
  if (loading) return <LoadingPanel label="正在加载知识库条目…" />;
  if (error) return <ErrorPanel message={error} onRetry={onRetry} />;
  if (!items.length) return <EmptyPanel icon={LibraryBig} title="知识库还是空的" description="审核通过的投稿会成为有效知识；其他状态的历史记录也会保留在这里。" />;
  return <div className="knowledge-list"><div className="knowledge-list-summary"><span>当前显示 {items.length} 条知识记录</span><small>已入库知识可调整对内/公开；所有调整和撤销都会保留审核轨迹</small></div><div className="knowledge-manage-list">{items.map((item) => <article className="knowledge-manage-row" key={item.id}>
    <div className="knowledge-manage-main"><div><span className="knowledge-category">{item.category}</span><KnowledgeVisibilityBadge item={item} /><KnowledgeStatusBadge status={item.status} /></div><h3>{item.title}</h3>{item.summary && <p>{item.summary}</p>}<small>{item.submitterName || item.submitterEmail || "项目成员"} · 更新于 {formatDate(item.updatedAt)}</small></div>
    <div className="knowledge-manage-actions"><Button type="button" variant="outline" onClick={() => onOpen(item)}>{item.status === "active" && item.canSetVisibility ? "查看并调整范围" : "查看详情"}</Button>{item.status === "active" && item.canRevoke ? <Button type="button" variant="outline" className="knowledge-revoke-button" onClick={() => onRevoke(item)}>停止用于问答</Button> : item.status === "active" && !item.canSetVisibility ? <span className="knowledge-manage-state">本人投稿需由其他负责人处理</span> : item.status !== "active" ? <span className="knowledge-manage-state">{statusMeta[item.status]?.detail || "状态已记录"}</span> : null}</div>
  </article>)}</div></div>;
}

const eventLabels: Record<string, string> = {
  submitted: "提交审核",
  resubmitted: "重新提交",
  approved: "审核入库（仅 OA 内部）",
  approved_internal: "批准为仅 OA 内部",
  approved_public: "批准为对外公开",
  visibility_changed_internal: "调整为仅 OA 内部",
  visibility_changed_public: "调整为对外公开",
  returned: "退回修改",
  rejected: "拒绝入库",
  revoked: "停止问答",
};

function revisionStatusLabel(status?: KnowledgeRevision["status"]) {
  if (status === "superseded") return "已被新版替换";
  return status ? statusMeta[status]?.label || status : "状态未记录";
}

function KnowledgeHistory({ detail }: { detail: ReviewDetail }) {
  const revisions = [...detail.revisions].sort((left, right) => (right.revisionNo || 0) - (left.revisionNo || 0));
  const events = [...detail.events].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return <details className="knowledge-history">
    <summary>历史版本与审核记录 <span>{revisions.length} 个版本 · {events.length} 条事件</span></summary>
    <div className="knowledge-history-body">
      <div className="knowledge-history-revisions">{revisions.map((item) => <article key={item.id}>
        <header><strong>第 {item.revisionNo || 1} 版</strong><span>{revisionStatusLabel(item.status)}</span><time>{formatDate(item.createdAt)}</time></header>
        <small>提交人：{item.createdByName || item.createdByEmail || "项目成员"}</small>
        {item.summary && <p>{item.summary}</p>}
        {item.reviewNote && <div className="knowledge-history-note"><strong>审核意见</strong><p>{item.reviewNote}</p></div>}
        <details><summary>查看本版正文</summary><div className="knowledge-history-content">{item.content || "本版本没有可显示的正文。"}</div></details>
      </article>)}</div>
      <ol className="knowledge-event-history">{events.map((item: KnowledgeEvent) => <li key={item.id}>
        <div><strong>{eventLabels[item.action] || item.action}</strong><time>{formatDate(item.createdAt)}</time></div>
        <small>{item.actorName || item.actorEmail || "项目成员"}</small>
        {item.note && <p>{item.note}</p>}
      </li>)}</ol>
    </div>
  </details>;
}

function KnowledgeReviewDialog({ detail, open, loading, error, note, setNote, visibility, setVisibility, publicConfirmation, setPublicConfirmation, actioning, onOpenChange, onRetry, onAction }: { detail: ReviewDetail | null; open: boolean; loading: boolean; error: string; note: string; setNote: (value: string) => void; visibility: KnowledgeVisibility | ""; setVisibility: (value: KnowledgeVisibility) => void; publicConfirmation: string; setPublicConfirmation: (value: string) => void; actioning: KnowledgeAction | null; onOpenChange: (open: boolean) => void; onRetry: () => void; onAction: (action: Extract<KnowledgeAction, "approve" | "return" | "reject" | "set_visibility">, visibility?: KnowledgeVisibility, publicConfirmation?: string) => void }) {
  const revision = detail ? currentRevision(detail) : undefined;
  const reviewContent = revision?.content || detail?.item.content || "";
  const sourceUrl = safeHttpUrl(revision?.sourceUrl || detail?.item.sourceUrl);
  const actionable = Boolean(detail && detail.item.status === "pending" && detail.item.canReview !== false && reviewContent.trim() && !loading && !error);
  const canAct = actionable && !actioning;
  const canApprove = canAct && Boolean(visibility) && (visibility !== "public" || publicConfirmation === PUBLIC_KNOWLEDGE_CONFIRMATION);
  const savedVisibility = detail ? knowledgeVisibility(detail.item) : undefined;
  const visibilityEditable = Boolean(detail && detail.item.status === "active" && detail.item.canSetVisibility && reviewContent.trim() && !loading && !error);
  const canEditVisibility = visibilityEditable && !actioning;
  const publicConfirmationRequired = visibility === "public" && (actionable || savedVisibility !== "public");
  const canSaveVisibility = canEditVisibility && Boolean(visibility) && visibility !== savedVisibility && (!publicConfirmationRequired || publicConfirmation === PUBLIC_KNOWLEDGE_CONFIRMATION);
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="knowledge-review-dialog">
    <DialogHeader><div className="knowledge-dialog-icon"><ShieldCheck className="size-5" /></div><DialogTitle>{detail?.item.title || "知识投稿审核"}</DialogTitle><DialogDescription>{detail ? `${detail.item.submitterName || detail.item.submitterEmail || "项目成员"} · ${detail.item.category} · 第 ${detail.item.currentRevisionNo || revision?.revisionNo || 1} 版` : "核对投稿内容，并在批准时选择仅对内或对外公开。"}</DialogDescription></DialogHeader>
    {loading ? <LoadingPanel label="正在加载投稿正文…" /> : error ? <ErrorPanel message={error} onRetry={onRetry} /> : detail ? <div className="knowledge-review-detail">
      {(revision?.summary || detail.item.summary) && <section><h3>摘要</h3><p>{revision?.summary || detail.item.summary}</p></section>}
      {detail.item.contentPartCount && detail.item.contentPartCount > 1 && <section><h3>导入方式</h3><p><KnowledgeMultipartReviewMeta item={detail.item} /></p></section>}
      <section><h3>知识正文</h3><div className="knowledge-review-content">{reviewContent || "当前版本没有可显示的正文。"}</div>{!reviewContent && <p className="knowledge-review-blocked"><AlertTriangle className="size-4" />正文未完整加载，不能执行审核。请重新加载。</p>}</section>
      {(revision?.sourceLabel || detail.item.sourceLabel || sourceUrl) && <section><h3>来源</h3><p>{revision?.sourceLabel || detail.item.sourceLabel || "投稿人提供的参考链接"}</p>{sourceUrl && <a className="knowledge-source-link" href={sourceUrl} target="_blank" rel="noreferrer">打开来源链接</a>}</section>}
      {!actionable && savedVisibility && <section><h3>当前可见范围</h3><p><KnowledgeVisibilityBadge item={detail.item} />{savedVisibility === "public" ? " 已供 chat.omindos.ai 的 ARTS Robotics AI assistant 检索使用。" : " 仅已登录并完成准入与保密签署的成员可在 OA 内检索。"}</p></section>}
      <KnowledgeHistory detail={detail} />
      {actionable && <label className="form-field"><span className="field-label">审核意见 <small>退回或拒绝时至少填写 2 个字符</small></span><Textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="说明核对结论，或写清需要修改的具体内容" rows={4} minLength={2} maxLength={1000} disabled={Boolean(actioning)} /></label>}
      {(actionable || visibilityEditable) && <KnowledgeAnonymizationNotice />}
      {(actionable || visibilityEditable) && <fieldset className="knowledge-visibility-choice" disabled={Boolean(actioning)}><legend>{actionable ? "批准后的可见范围" : "调整可见范围"} <b className="required-mark">*</b></legend><p>{actionable ? "批准前必须选择一个范围；投稿人提交时不会自动决定公开范围。" : "已入库知识可以在对内与公开之间调整；每次调整都会保留审计记录。"}</p><div className="knowledge-visibility-options">
        <label className={visibility === "internal" ? "selected" : ""}><input type="radio" name="knowledge-visibility" value="internal" checked={visibility === "internal"} onChange={() => { setVisibility("internal"); setPublicConfirmation(""); }} /><ShieldCheck className="size-4" /><span><strong>对内</strong><small>仅登录 OA 且完成准入与保密签署的成员可见；在 OA 里提问。</small></span></label>
        <label className={visibility === "public" ? "selected public" : ""}><input type="radio" name="knowledge-visibility" value="public" checked={visibility === "public"} onChange={() => setVisibility("public")} /><Globe2 className="size-4" /><span><strong>对外公开</strong><small>供 chat.omindos.ai 的 ARTS Robotics AI assistant 检索；访客无需登录 OA。</small></span></label>
      </div>{publicConfirmationRequired && <label className="knowledge-public-confirmation"><span>二次确认：输入 <code>{PUBLIC_KNOWLEDGE_CONFIRMATION}</code></span><Input value={publicConfirmation} onChange={(event) => setPublicConfirmation(event.target.value)} placeholder={PUBLIC_KNOWLEDGE_CONFIRMATION} autoComplete="off" spellCheck={false} disabled={Boolean(actioning)} /><small>必须逐字一致。设为公开后，该知识仍可在 OA 内检索，并将同时供 chat.omindos.ai 对外检索。</small></label>}</fieldset>}
    </div> : null}
    {actionable && <DialogFooter className="knowledge-review-actions">{detail?.item.canReject !== false && <Button type="button" variant="outline" className="knowledge-reject-button" disabled={!canAct || note.trim().length < 2} onClick={() => onAction("reject")}>{actioning === "reject" ? <LoaderCircle className="size-4" /> : <X className="size-4" />}拒绝</Button>}{detail?.item.canReturn !== false && <Button type="button" variant="outline" className="knowledge-return-button" disabled={!canAct || note.trim().length < 2} onClick={() => onAction("return")}>{actioning === "return" ? <LoaderCircle className="size-4" /> : <RotateCcw className="size-4" />}退回修改</Button>}<Button type="button" className="primary-button" disabled={!canApprove} onClick={() => onAction("approve", visibility || undefined, visibility === "public" ? publicConfirmation : undefined)}>{actioning === "approve" ? <LoaderCircle className="size-4" /> : visibility === "public" ? <Globe2 className="size-4" /> : <Check className="size-4" />}{visibility === "public" ? "确认公开并入库" : visibility === "internal" ? "通过并仅在 OA 内入库" : "先选择可见范围"}</Button></DialogFooter>}
    {visibilityEditable && <DialogFooter className="knowledge-review-actions"><Button type="button" variant="outline" disabled={Boolean(actioning)} onClick={() => onOpenChange(false)}>取消</Button><Button type="button" className="primary-button" disabled={!canSaveVisibility} onClick={() => onAction("set_visibility", visibility || undefined, publicConfirmationRequired ? publicConfirmation : undefined)}>{actioning === "set_visibility" ? <LoaderCircle className="size-4" /> : visibility === "public" ? <Globe2 className="size-4" /> : <ShieldCheck className="size-4" />}{!visibility || visibility === savedVisibility ? "请选择新的范围" : visibility === "public" ? "确认调整为公开" : "确认调整为仅 OA 内部"}</Button></DialogFooter>}
  </DialogContent></Dialog>;
}

function KnowledgeRevokeDialog({ item, note, setNote, submitting, onOpenChange, onConfirm }: { item: KnowledgeItem | null; note: string; setNote: (value: string) => void; submitting: boolean; onOpenChange: (open: boolean) => void; onConfirm: () => void }) {
  return <Dialog open={Boolean(item)} onOpenChange={onOpenChange}><DialogContent className="knowledge-revoke-dialog"><DialogHeader><div className="knowledge-dialog-icon knowledge-dialog-icon-danger"><AlertTriangle className="size-5" /></div><DialogTitle>停止这条知识用于问答？</DialogTitle><DialogDescription>“{item?.title || "该知识"}”将立即退出可检索范围，已有记录和审核轨迹继续保留。</DialogDescription></DialogHeader><label className="form-field"><span className="field-label">撤销原因 <b className="required-mark">*</b></span><Textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="至少 2 个字符；说明信息错误、已经过期或不再适用的原因" rows={4} minLength={2} maxLength={1000} required disabled={submitting} /></label><DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>取消</Button><Button type="button" className="knowledge-revoke-confirm" onClick={onConfirm} disabled={submitting || note.trim().length < 2}>{submitting ? <LoaderCircle className="size-4" /> : <X className="size-4" />}确认停止用于问答</Button></DialogFooter></DialogContent></Dialog>;
}

export function KnowledgeView({ canReviewKnowledge }: { canReviewKnowledge: boolean }) {
  const [activeTab, setActiveTab] = useState<KnowledgeTab>("ask");
  const [draft, setDraft] = useState<KnowledgeDraft>(emptyDraft);
  const [editingItem, setEditingItem] = useState<KnowledgeItem | null>(null);
  const [editingLoadingId, setEditingLoadingId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [mine, setMine] = useState<KnowledgeItem[]>([]);
  const [mineLoading, setMineLoading] = useState(true);
  const [mineError, setMineError] = useState("");
  const [reviewItems, setReviewItems] = useState<KnowledgeItem[]>([]);
  const [reviewPendingCount, setReviewPendingCount] = useState(0);
  const [reviewLoading, setReviewLoading] = useState(canReviewKnowledge);
  const [reviewError, setReviewError] = useState("");
  const [manageItems, setManageItems] = useState<KnowledgeItem[]>([]);
  const [manageLoading, setManageLoading] = useState(canReviewKnowledge);
  const [manageError, setManageError] = useState("");
  const [reviewTarget, setReviewTarget] = useState<KnowledgeItem | null>(null);
  const [reviewDetail, setReviewDetail] = useState<ReviewDetail | null>(null);
  const [reviewDetailLoading, setReviewDetailLoading] = useState(false);
  const [reviewDetailError, setReviewDetailError] = useState("");
  const reviewDetailRequest = useRef<AbortController | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [reviewVisibility, setReviewVisibility] = useState<KnowledgeVisibility | "">("");
  const [publicConfirmation, setPublicConfirmation] = useState("");
  const [reviewAction, setReviewAction] = useState<KnowledgeAction | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<KnowledgeItem | null>(null);
  const [revokeNote, setRevokeNote] = useState("");
  const [revoking, setRevoking] = useState(false);

  const loadMine = useCallback(async (signal?: AbortSignal) => {
    setMineLoading(true);
    setMineError("");
    try {
      const response = await fetch("/api/knowledge?scope=mine", { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store", signal });
      const data = await responseJson<KnowledgeListResponse>(response, "我的投稿加载失败");
      setMine(data.items ?? []);
    } catch (error) {
      if (signal?.aborted) return;
      setMineError(error instanceof Error ? error.message : "请稍后重试");
    } finally {
      if (!signal?.aborted) setMineLoading(false);
    }
  }, []);

  const loadReview = useCallback(async (signal?: AbortSignal) => {
    if (!canReviewKnowledge) return;
    setReviewLoading(true);
    setReviewError("");
    try {
      const response = await fetch("/api/knowledge?scope=review", { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store", signal });
      const data = await responseJson<KnowledgeListResponse>(response, "待审核知识加载失败");
      setReviewItems(data.items ?? []);
      setReviewPendingCount(data.pendingCount ?? data.items?.length ?? 0);
    } catch (error) {
      if (signal?.aborted) return;
      setReviewError(error instanceof Error ? error.message : "请稍后重试");
    } finally {
      if (!signal?.aborted) setReviewLoading(false);
    }
  }, [canReviewKnowledge]);

  const loadManage = useCallback(async (signal?: AbortSignal) => {
    if (!canReviewKnowledge) return;
    setManageLoading(true);
    setManageError("");
    try {
      const response = await fetch("/api/knowledge?scope=all", { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store", signal });
      const data = await responseJson<KnowledgeListResponse>(response, "知识库记录加载失败");
      setManageItems(data.items ?? []);
    } catch (error) {
      if (signal?.aborted) return;
      setManageError(error instanceof Error ? error.message : "请稍后重试");
    } finally {
      if (!signal?.aborted) setManageLoading(false);
    }
  }, [canReviewKnowledge]);

  useEffect(() => {
    const controller = new AbortController();
    const timerId = window.setTimeout(() => {
      void loadMine(controller.signal);
      void loadReview(controller.signal);
      void loadManage(controller.signal);
    }, 0);
    return () => { window.clearTimeout(timerId); controller.abort(); };
  }, [loadManage, loadMine, loadReview]);

  useEffect(() => {
    const refreshVisibleKnowledge = () => {
      if (document.visibilityState !== "visible") return;
      void loadMine();
      void loadReview();
      void loadManage();
    };
    window.addEventListener("focus", refreshVisibleKnowledge);
    document.addEventListener("visibilitychange", refreshVisibleKnowledge);
    return () => {
      window.removeEventListener("focus", refreshVisibleKnowledge);
      document.removeEventListener("visibilitychange", refreshVisibleKnowledge);
    };
  }, [loadManage, loadMine, loadReview]);

  const submitKnowledge = async (event: FormEvent) => {
    event.preventDefault();
    const payload = {
      title: draft.title.trim(),
      category: draft.category.trim(),
      summary: draft.summary.trim() || undefined,
      content: draft.content.trim(),
      sourceLabel: draft.sourceLabel.trim() || undefined,
      sourceUrl: draft.sourceUrl.trim() || undefined,
    };
    if (!payload.title || !payload.category || !payload.content) {
      toast.info("请填写标题、分类和知识正文");
      return;
    }
    if (payload.sourceUrl && !safeHttpUrl(payload.sourceUrl)) {
      toast.info("来源链接格式不正确", { description: "请填写完整、可访问的来源链接。" });
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch(editingItem ? `/api/knowledge/${encodeURIComponent(editingItem.id)}` : "/api/knowledge", {
        method: editingItem ? "PATCH" : "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(editingItem ? { action: "resubmit", mutationRevision: editingItem.mutationRevision, ...payload } : payload),
      });
      await responseJson<{ item?: KnowledgeItem; error?: string }>(response, editingItem ? "知识未重新提交" : "知识未提交");
      toast.success(editingItem ? "知识已重新提交" : "知识已提交审核", { description: "审核人将核对内容，并在批准时选择对内或对外公开。" });
      setDraft(emptyDraft());
      setEditingItem(null);
      await loadMine();
      setActiveTab("mine");
    } catch (error) {
      toast.error(editingItem ? "知识未重新提交" : "知识未提交", { description: error instanceof Error ? error.message : "请稍后重试" });
    } finally {
      setSubmitting(false);
    }
  };

  const startEditing = async (item: KnowledgeItem) => {
    setEditingLoadingId(item.id);
    try {
      const response = await fetch(`/api/knowledge/${encodeURIComponent(item.id)}`, { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" });
      const data = await responseJson<KnowledgeDetailResponse>(response, "知识详情加载失败");
      if (!data.item) throw new Error("知识详情不完整");
      const detail: ReviewDetail = { item: data.item, revisions: data.revisions ?? [], events: data.events ?? [] };
      const revision = currentRevision(detail);
      setDraft({
        title: revision?.title || data.item.title || "",
        category: revision?.category || data.item.category || categories[0],
        summary: revision?.summary || data.item.summary || "",
        content: revision?.content || data.item.content || "",
        sourceLabel: revision?.sourceLabel || data.item.sourceLabel || "",
        sourceUrl: revision?.sourceUrl || data.item.sourceUrl || "",
      });
      setEditingItem(data.item);
      setActiveTab("submit");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      toast.error("暂时无法修改", { description: error instanceof Error ? error.message : "请稍后重试" });
    } finally {
      setEditingLoadingId("");
    }
  };

  const cancelEditing = () => {
    setEditingItem(null);
    setDraft(emptyDraft());
  };

  const loadReviewDetail = useCallback(async (item: KnowledgeItem) => {
    reviewDetailRequest.current?.abort();
    const controller = new AbortController();
    reviewDetailRequest.current = controller;
    setReviewDetailLoading(true);
    setReviewDetailError("");
    try {
      const response = await fetch(`/api/knowledge/${encodeURIComponent(item.id)}`, { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store", signal: controller.signal });
      const data = await responseJson<KnowledgeDetailResponse>(response, "知识详情加载失败");
      if (!data.item || data.item.id !== item.id) throw new Error("知识详情不完整");
      if (controller.signal.aborted) return;
      setReviewDetail({ item: data.item, revisions: data.revisions ?? [], events: data.events ?? [] });
    } catch (error) {
      if (controller.signal.aborted) return;
      setReviewDetailError(error instanceof Error ? error.message : "请稍后重试");
    } finally {
      if (reviewDetailRequest.current === controller) {
        reviewDetailRequest.current = null;
        setReviewDetailLoading(false);
      }
    }
  }, []);

  const openReview = (item: KnowledgeItem) => {
    setReviewTarget(item);
    setReviewDetail({ item, revisions: [], events: [] });
    setReviewNote("");
    setReviewVisibility("");
    setPublicConfirmation("");
    void loadReviewDetail(item);
  };

  const closeReview = () => {
    if (reviewAction) return;
    reviewDetailRequest.current?.abort();
    reviewDetailRequest.current = null;
    setReviewTarget(null);
    setReviewDetail(null);
    setReviewDetailLoading(false);
    setReviewDetailError("");
    setReviewNote("");
    setReviewVisibility("");
    setPublicConfirmation("");
  };

  const performReview = async (action: Extract<KnowledgeAction, "approve" | "return" | "reject" | "set_visibility">, visibility?: KnowledgeVisibility, confirmation?: string) => {
    if (!reviewTarget) return;
    if (!reviewDetail || reviewDetail.item.id !== reviewTarget.id) {
      toast.info("请等待当前投稿正文加载完成");
      return;
    }
    const note = reviewNote.trim();
    if ((action === "return" || action === "reject") && note.length < 2) {
      toast.info("审核意见至少需要 2 个字符", { description: action === "return" ? "请明确说明需要修改的内容。" : "请说明拒绝入库的原因。" });
      return;
    }
    if ((action === "approve" || action === "set_visibility") && !visibility) {
      toast.info("请先选择可见范围", { description: "选择“对内”或“对外公开”后才能批准。" });
      return;
    }
    if ((action === "approve" || action === "set_visibility") && visibility === "public" && knowledgeVisibility(reviewDetail.item) !== "public" && confirmation !== PUBLIC_KNOWLEDGE_CONFIRMATION) {
      toast.info("公开确认文字不一致", { description: `请逐字输入 ${PUBLIC_KNOWLEDGE_CONFIRMATION}` });
      return;
    }
    if (action === "set_visibility" && (reviewDetail.item.status !== "active" || visibility === knowledgeVisibility(reviewDetail.item))) {
      toast.info("请选择新的可见范围");
      return;
    }
    setReviewAction(action);
    try {
      const approvalScope = (action === "approve" || action === "set_visibility") && visibility
        ? { visibility, ...(visibility === "public" && knowledgeVisibility(reviewDetail.item) !== "public" ? { publicConfirmation: confirmation } : {}) }
        : {};
      const response = await fetch(`/api/knowledge/${encodeURIComponent(reviewTarget.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action, mutationRevision: reviewDetail.item.mutationRevision, note: note || undefined, ...approvalScope }),
      });
      await responseJson<{ item?: KnowledgeItem; error?: string }>(response, "审核动作未保存");
      toast.success(action === "set_visibility" ? visibility === "public" ? "知识已调整为对外公开" : "知识已调整为仅 OA 内部" : action === "approve" ? visibility === "public" ? "知识已对外公开" : "知识已在 OA 内部入库" : action === "return" ? "知识已退回修改" : "知识已拒绝", { description: action === "set_visibility" || action === "approve" ? visibility === "public" ? "该版本可供 chat.omindos.ai 的 ARTS Robotics AI assistant 检索。" : "该版本仅供已完成准入的 OA 成员检索。" : "投稿人可以在“我的提交”中查看审核意见。" });
      reviewDetailRequest.current?.abort();
      reviewDetailRequest.current = null;
      setReviewTarget(null);
      setReviewDetail(null);
      setReviewNote("");
      setReviewVisibility("");
      setPublicConfirmation("");
      await Promise.all([loadReview(), loadManage(), loadMine()]);
    } catch (error) {
      toast.error("审核动作未保存", { description: error instanceof Error ? error.message : "请稍后重试" });
    } finally {
      setReviewAction(null);
    }
  };

  const performRevoke = async () => {
    if (!revokeTarget || revokeNote.trim().length < 2) return;
    setRevoking(true);
    try {
      const response = await fetch(`/api/knowledge/${encodeURIComponent(revokeTarget.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action: "revoke", mutationRevision: revokeTarget.mutationRevision, note: revokeNote.trim() }),
      });
      await responseJson<{ item?: KnowledgeItem; error?: string }>(response, "知识未停止使用");
      toast.success("知识已停止用于问答", { description: "原文、版本和审核记录均已保留。" });
      setRevokeTarget(null);
      setRevokeNote("");
      await Promise.all([loadManage(), loadMine()]);
    } catch (error) {
      toast.error("知识未停止使用", { description: error instanceof Error ? error.message : "请稍后重试" });
    } finally {
      setRevoking(false);
    }
  };

  const tabCount = useMemo(() => reviewPendingCount > 99 ? "99+" : String(reviewPendingCount), [reviewPendingCount]);
  const visibleTab = !canReviewKnowledge && (activeTab === "review" || activeTab === "manage") ? "ask" : activeTab;

  return <div className="knowledge-view">
    <section className="page-heading knowledge-heading"><div><div className="eyebrow"><span className="eyebrow-line" />OA 内部知识与问答</div><h1>实验室 AI（内部）</h1><p>登录并完成 OA 准入与保密签署后，可在这里提问、投稿和查看审核状态。项目负责人或 OA 管理员批准时必须选择“对内”或“对外公开”。</p></div><div className="knowledge-live-note"><span /><div><strong>仅限 OA 成员</strong><small>登录并完成准入后使用</small></div></div></section>
    <section className="knowledge-scope-summary" aria-label="实验室知识可见范围说明"><div><ShieldCheck className="size-5" /><p><strong>对内：在 OA 里面问</strong><span>仅已登录并完成准入与保密签署的成员可检索。</span></p></div><div><Globe2 className="size-5" /><p><strong>对外：供 ARTS Robotics AI assistant 使用</strong><span>设为公开须二次确认，随后供 <a href="https://chat.omindos.ai" target="_blank" rel="noreferrer">chat.omindos.ai</a> 检索。</span></p></div></section>
    <Tabs className="knowledge-tabs" value={visibleTab} onValueChange={(value) => setActiveTab(value as KnowledgeTab)}>
      <TabsList aria-label="实验室 AI 功能"><TabsTrigger value="ask"><Bot className="size-4" />知识问答</TabsTrigger><TabsTrigger value="submit"><Send className="size-4" />提交知识</TabsTrigger><TabsTrigger value="mine"><FileText className="size-4" />我的提交</TabsTrigger>{canReviewKnowledge && <TabsTrigger value="review"><ShieldCheck className="size-4" />待审核{reviewPendingCount > 0 && <span className="knowledge-tab-count">{tabCount}</span>}</TabsTrigger>}{canReviewKnowledge && <TabsTrigger value="manage"><LibraryBig className="size-4" />知识库管理</TabsTrigger>}</TabsList>
      <TabsContent value="ask"><KnowledgeAskPanel /></TabsContent>
      <TabsContent value="submit"><KnowledgeSubmitPanel draft={draft} setDraft={setDraft} editingItem={editingItem} submitting={submitting} onSubmit={submitKnowledge} onCancelEdit={cancelEditing} /></TabsContent>
      <TabsContent value="mine"><KnowledgeMinePanel items={mine} loading={mineLoading || Boolean(editingLoadingId)} error={mineError} onRetry={() => void loadMine()} onEdit={(item) => void startEditing(item)} editingId={editingLoadingId} /></TabsContent>
      {canReviewKnowledge && <TabsContent value="review"><KnowledgeReviewPanel items={reviewItems} pendingCount={reviewPendingCount} loading={reviewLoading} error={reviewError} onRetry={() => void loadReview()} onOpen={openReview} /></TabsContent>}
      {canReviewKnowledge && <TabsContent value="manage"><KnowledgeManagePanel items={manageItems} loading={manageLoading} error={manageError} onRetry={() => void loadManage()} onOpen={openReview} onRevoke={(item) => { setRevokeTarget(item); setRevokeNote(""); }} /></TabsContent>}
    </Tabs>
    <KnowledgeReviewDialog detail={reviewDetail} open={Boolean(reviewTarget)} loading={reviewDetailLoading} error={reviewDetailError} note={reviewNote} setNote={setReviewNote} visibility={reviewVisibility} setVisibility={setReviewVisibility} publicConfirmation={publicConfirmation} setPublicConfirmation={setPublicConfirmation} actioning={reviewAction} onOpenChange={(open) => { if (!open) closeReview(); }} onRetry={() => { if (reviewTarget) void loadReviewDetail(reviewTarget); }} onAction={(action, visibility, confirmation) => void performReview(action, visibility, confirmation)} />
    <KnowledgeRevokeDialog item={revokeTarget} note={revokeNote} setNote={setRevokeNote} submitting={revoking} onOpenChange={(open) => { if (!open && !revoking) { setRevokeTarget(null); setRevokeNote(""); } }} onConfirm={() => void performRevoke()} />
  </div>;
}

"use client";

/* This screen intentionally synchronizes remote OA state into local form/UI state. */
/* eslint-disable react-hooks/set-state-in-effect */

import { FormEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Archive,
  AlertTriangle,
  ArrowUpRight,
  BadgeCheck,
  BookOpen,
  Bot,
  Building2,
  CircleDollarSign,
  BriefcaseBusiness,
  Camera,
  Check,
  ChevronRight,
  ClipboardCheck,
  Clock3,
  FileCheck2,
  FilePenLine,
  FileSignature,
  FolderKanban,
  GitBranch,
  Download,
  Home as HomeIcon,
  Info,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageCircle,
  MoreHorizontal,
  PackageCheck,
  Pencil,
  Plus,
  RotateCcw,
  Send,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Settings2,
  Trash2,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";

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
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { NotificationStatus } from "@/components/notification-status";
import { OemInbox } from "@/components/oem-inbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Toaster } from "@/components/ui/sonner";
import { KnowledgeView, type KnowledgeTab } from "@/components/knowledge/knowledge-view";
import "./oa-workspace.css";
import { OaChatStatus } from "@/components/knowledge/oa-chat-panel";
import {
  NDA_AGREEMENT_VERSION,
  buildNdaAgreementText,
  confidentialityAgreementKindForRole,
  confidentialityAgreementKindFromPayload,
  confidentialityAgreementReviewerStep,
  confidentialityAgreementTitle,
  confidentialityAgreementVersion,
  selectCurrentNdaApproval,
  shouldAutoArchiveConfidentialityAgreement,
  type ConfidentialityAgreementKind,
} from "@/lib/nda-agreement";
import { MEMBER_DEPARTMENTS, type MemberDepartmentCode } from "@/lib/member-attributes";
import { ndaAdmissionIdentityKey, shouldHighlightNdaTaskEntry } from "@/lib/nda-admission";
import { canonicalizeSignaturePngDataUrl } from "@/lib/png-signature";
import { toast } from "sonner";
import { circulationPeople, circulationPendingForEmail } from "@/lib/circulation-policy";

type ApprovalType = "技术审核" | "采购审核" | "保密协议" | "劳务报酬" | "流转审批";
type ApprovalStatus = "草稿" | "待审核" | "审批中" | "已通过" | "已退回" | "已撤回" | "已作废" | "已归档";
type ViewKey = "dashboard" | "requests" | "people" | "knowledge" | "rules" | "members" | "oem" | "notifications" | "profile";

type Approval = {
  id: string;
  title: string;
  type: ApprovalType;
  project: string;
  requester: string;
  createdAt: string;
  updatedAt: string;
  status: ApprovalStatus;
  step: string;
  amount?: string;
  summary: string;
  owner: string;
  signers: string[];
  requesterEmail?: string;
  currentReviewerName?: string;
  currentReviewerEmail?: string;
  reviewerEmail?: string;
  payload?: Record<string, unknown>;
  purchaseNote?: string;
  actualAmount?: number | string;
  archiveHash?: string;
  archiveContentHash?: string;
  evidenceRecordHash?: string;
  archiveSchemaVersion?: number;
  currentRevisionNo?: number;
  currentRevisionHash?: string;
  terminalRevisionNo?: number | null;
  terminalRevisionHash?: string | null;
  terminalStateHash?: string | null;
  archiveIntegrityError?: string;
  feishuPdfArchive?: { status: "pending" | "uploaded" | "failed"; fileName?: string; errorCode?: string | null; updatedAt?: string };
};

type Developer = { name: string; email?: string; memberId?: string; work: string; ratio: string };
type TechnicalContribution = { approval: Approval; totalWorkHours: number; contributionRate: number; weightedHours: number };
type MemberPermission = "technical_advisor" | "project_owner";
type Reviewer = { email: string; displayName: string; permissions: MemberPermission[]; isAdmin: boolean; ndaCompleted: boolean };
type MemberAuditRow = { id: string; fullName: string; identityNumber: string; chatgptAccount: string; status: string; createdAt: string; permissions: MemberPermission[]; departmentCode: MemberDepartmentCode | "" };
type ProfileVisibility = { department: boolean; position: boolean; phone: boolean; bio: boolean };
type ProfileField = Exclude<keyof PersonProfile, "visibility">;
type PersonProfile = { department: string; position: string; phone: string; bio: string; visibility: ProfileVisibility };
type Person = { id: string; fullName: string; email: string; role: string; permissions: MemberPermission[]; isAdmin: boolean; avatarDataUrl: string; profile: PersonProfile; lastSeenAt: string; online: boolean; ndaCompleted: boolean };
type DirectMessage = { id: string; senderEmail: string; senderName: string; recipientEmail: string; recipientName: string; body: string; createdAt: string };
type ConversationSummary = { peer: { email: string; name?: string; fullName?: string; role?: string; permissions?: MemberPermission[]; isAdmin?: boolean }; latestMessageId?: string | null; latestCreatedAt?: string | null; latestIncomingId?: string | null };
type MetricPanel = "approved" | "archive" | null;
type ApprovalEvent = { id: number; actorName: string; actorEmail: string; action: string; note: string; createdAt: string };
type AuthProvider = "chatgpt" | "github" | "feishu" | "legacy";
type SessionInfo = { registered: boolean; status?: "unregistered" | "pending" | "active" | "rejected" | "departed"; accountBindingRequired?: boolean; accountBindingConflict?: boolean; platformIdentityMissing?: boolean; externalIdentityLinkRequired?: boolean; externalIdentityProvider?: "github" | "feishu"; githubIdentityLinkRequired?: boolean; feishuIdentityLinkRequired?: boolean; chatgptLoginEnabled?: boolean; githubLoginEnabled?: boolean; feishuLoginEnabled?: boolean; migrationExportEnabled?: boolean; migrationUnfreezeEnabled?: boolean; user?: { email: string; displayName: string; authProvider?: AuthProvider } | null; role?: string | null; canReviewMembers?: boolean; canGrantMemberPermissions?: boolean; canReviewKnowledge?: boolean; isAdmin?: boolean; isFinanceOwner?: boolean; ndaCompleted?: boolean; needsNda?: boolean; ndaApprovalId?: string; error?: string };
type FeishuBindingCandidate = { memberId: string; fullName: string; accountHint: string; department: string };

async function loadApprovalDetail(id: string, signal: AbortSignal) {
  const timeoutSignal = AbortSignal.timeout(15_000);
  try {
    const response = await fetch(`/api/approvals/${id}`, { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store", signal: AbortSignal.any([signal, timeoutSignal]) });
    const data = await response.json() as { approval?: Approval; events?: ApprovalEvent[]; error?: string };
    if (!response.ok || !data.approval) throw new Error(data.error || "申请详情加载失败");
    return { approval: data.approval, events: data.events ?? [] };
  } catch (error) {
    if (!signal.aborted && timeoutSignal.aborted) throw new Error("申请详情加载超时，请点击重新加载。");
    throw error;
  }
}

function authProviderLabel(provider?: AuthProvider) {
  if (provider === "github") return "GitHub";
  if (provider === "feishu") return "飞书";
  if (provider === "legacy") return "旧版会话";
  return "ChatGPT";
}

function accountIdentityLabel(user?: SessionInfo["user"]) {
  if (!user) return "登录后自动读取";
  return user.authProvider === "feishu" ? `飞书 · ${user.displayName || "已验证成员"}` : user.email;
}

const emptyProfile = (): PersonProfile => ({ department: "", position: "", phone: "", bio: "", visibility: { department: false, position: false, phone: false, bio: false } });

function normalizeProfile(profile?: Partial<PersonProfile>): PersonProfile {
  return {
    department: profile?.department || "",
    position: profile?.position || "",
    phone: profile?.phone || "",
    bio: profile?.bio || "",
    visibility: {
      department: profile?.visibility?.department === true,
      position: profile?.visibility?.position === true,
      phone: profile?.visibility?.phone === true,
      bio: profile?.visibility?.bio === true,
    },
  };
}

function profileValue(person: Person, field: ProfileField, currentEmail?: string, fallback = "暂未填写") {
  if (person.email !== currentEmail?.toLowerCase() && !person.profile.visibility[field]) return "未公开";
  return person.profile[field] || fallback;
}

const officialBrand = "OriginMind × ARTS Robotics";
const officialName = "OriginMind × ARTS Robotics 联合研发 OA";
const officialDescription = "面向联合研发项目的技术成果、采购、劳务报酬及保密协议审批与归档平台。";
const projectName = "OriginMind × ARTS Robotics 联合研发项目";

function sessionRoleLabel(role?: string | null, isAdmin = false) {
  if (isAdmin) return "系统管理员";
  if (role === "project_owner") return "项目负责人";
  if (role === "technical_advisor") return "技术顾问";
  if (role === "finance_owner") return "经费负责人";
  return "项目成员";
}
const shanghaiMonthFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" });
const localMonthKey = () => {
  const parts = Object.fromEntries(shanghaiMonthFormatter.formatToParts(new Date()).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}`;
};
const todayLabel = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "long",
}).format(new Date());

// 生产环境只显示数据库中的真实申请，不在公开前端打包演示数据。
const initialApprovals: Approval[] = [];

function isStrandedCurrentMemberNda(approval: Approval) {
  return approval.type === "保密协议"
    && (approval.status === "待审核" || approval.status === "审批中")
    && confidentialityAgreementKindFromPayload(approval.payload) === "member"
    && approval.payload?.agreementVersion === NDA_AGREEMENT_VERSION
    && approval.payload?.autoArchived !== true;
}

const typeMeta: Record<ApprovalType, { label: string; icon: typeof ClipboardCheck; className: string }> = {
  技术审核: { label: "技术", icon: ClipboardCheck, className: "type-technical" },
  采购审核: { label: "采购", icon: PackageCheck, className: "type-procurement" },
  保密协议: { label: "保密", icon: ShieldCheck, className: "type-nda" },
  流转审批: { label: "流转", icon: GitBranch, className: "type-circulation" },
  劳务报酬: { label: "劳务", icon: CircleDollarSign, className: "type-labor" },
};

const statusMeta: Record<ApprovalStatus, { className: string; dot: string }> = {
  草稿: { className: "status-draft", dot: "bg-[#89959c]" },
  待审核: { className: "status-pending", dot: "bg-[#d99327]" },
  审批中: { className: "status-progress", dot: "bg-[#3a86c4]" },
  已通过: { className: "status-approved", dot: "bg-[#3d9b72]" },
  已退回: { className: "status-returned", dot: "bg-[#c9634c]" },
  已撤回: { className: "status-withdrawn", dot: "bg-[#8a6f4d]" },
  已作废: { className: "status-voided", dot: "bg-[#697178]" },
  已归档: { className: "status-archived", dot: "bg-[#7e8794]" },
};

function TypeBadge({ type }: { type: ApprovalType }) {
  const meta = typeMeta[type];
  const Icon = meta.icon;
  return <span className={`type-badge ${meta.className}`}><Icon className="size-3.5" />{meta.label}</span>;
}

function StatusBadge({ status }: { status: ApprovalStatus }) {
  const meta = statusMeta[status];
  return <Badge variant="outline" className={`status-badge ${meta.className}`}><span className={`status-dot ${meta.dot}`} />{status}</Badge>;
}

function Sidebar({ activeView, setActiveView, onNew, onProfile, userName = "马淦", userAvatarDataUrl = "", authProvider = "chatgpt", currentRole, isAdmin = false, canReviewKnowledge = false, selectedKnowledgeTab = "ask", onKnowledgeTab, onMyPending }: { activeView: ViewKey; setActiveView: (key: ViewKey) => void; onNew: () => void; onProfile: () => void; userName?: string; userAvatarDataUrl?: string; authProvider?: AuthProvider; currentRole?: string | null; isAdmin?: boolean; canReviewKnowledge?: boolean; selectedKnowledgeTab?: KnowledgeTab; onKnowledgeTab: (tab: KnowledgeTab) => void; onMyPending: () => void }) {
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [officeOpen, setOfficeOpen] = useState(true);
  const [knowledgeOpen, setKnowledgeOpen] = useState(true);
  const officeId = useId();
  const knowledgeId = useId();
  const [pendingApprovalCount, setPendingApprovalCount] = useState(0);
  const [pendingMemberCount, setPendingMemberCount] = useState(0);
  const [pendingKnowledgeCount, setPendingKnowledgeCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const loadAttention = async () => {
      let nextApprovalCount = 0;
      let nextMemberCount = 0;
      let approvalLoaded = false;
      let memberLoaded = !isAdmin;
      let knowledgeLoaded = !canReviewKnowledge;
      let nextKnowledgeCount = 0;
      try {
        const sessionResponse = await fetch("/api/session", { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" });
        if (sessionResponse.ok) {
          const sessionData = await sessionResponse.json() as SessionInfo;
          const email = sessionData.user?.email?.trim().toLowerCase();
          if (sessionData.registered && email) {
            try {
              const approvalsResponse = await fetch("/api/approvals", { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" });
              const approvalsData = await approvalsResponse.json() as { approvals?: Approval[] };
              if (approvalsResponse.ok) {
                approvalLoaded = true;
                nextApprovalCount = (approvalsData.approvals ?? []).filter((approval) => {
                  if (approval.status !== "待审核" && approval.status !== "审批中") return false;
                  if (isStrandedCurrentMemberNda(approval)) return false;
                  return approval.type === "流转审批" ? circulationPendingForEmail(approval.payload ?? {}, approval.step, email) : approval.currentReviewerEmail?.trim().toLowerCase() === email;
                }).length;
              }
            } catch {
              // Keep the current attention state when the background refresh is unavailable.
            }
          } else {
            approvalLoaded = true;
          }
        }
      } catch {
        // The main page handles the visible session state.
      }
      if (isAdmin) {
        try {
          const membersResponse = await fetch("/api/members", { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" });
          const membersData = await membersResponse.json() as { pendingCount?: number; members?: Array<{ status: string }> };
          if (membersResponse.ok) {
            memberLoaded = true;
            nextMemberCount = typeof membersData.pendingCount === "number" ? membersData.pendingCount : (membersData.members ?? []).filter((member) => member.status === "pending").length;
          }
        } catch {
          // Members are only loaded for accounts with review permission.
        }
      }
      if (canReviewKnowledge) {
        try {
          const knowledgeResponse = await fetch("/api/knowledge?scope=review", { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" });
          const knowledgeData = await knowledgeResponse.json() as { pendingCount?: number; items?: unknown[] };
          if (knowledgeResponse.ok) {
            knowledgeLoaded = true;
            nextKnowledgeCount = typeof knowledgeData.pendingCount === "number" ? knowledgeData.pendingCount : knowledgeData.items?.length ?? 0;
          }
        } catch {
          // Knowledge attention is best-effort and refreshes again in the background.
        }
      }
      if (!cancelled) {
        if (approvalLoaded) setPendingApprovalCount(nextApprovalCount);
        if (memberLoaded) setPendingMemberCount(nextMemberCount);
        if (knowledgeLoaded) setPendingKnowledgeCount(nextKnowledgeCount);
      }
    };
    void loadAttention();
    const intervalId = window.setInterval(loadAttention, 30_000);
    return () => { cancelled = true; window.clearInterval(intervalId); };
  }, [canReviewKnowledge, isAdmin]);
  const openProfile = () => {
    setUserMenuOpen(false);
    onProfile();
  };
  const logout = async () => {
    setUserMenuOpen(false);
    try {
      await fetch("/api/session", { method: "DELETE", credentials: "same-origin" });
    } finally {
      window.location.href = authProvider === "chatgpt" ? "/signout-with-chatgpt?return_to=%2F" : "/";
    }
  };
  const items: { key: ViewKey; label: string; icon: typeof HomeIcon }[] = [
    { key: "dashboard", label: "审批工作台", icon: LayoutDashboard },
    { key: "requests", label: "全部申请", icon: FolderKanban },
    { key: "people", label: "协作成员", icon: UsersRound },
    ...(isAdmin ? [{ key: "members" as ViewKey, label: "成员审核", icon: UsersRound }, { key: "notifications" as ViewKey, label: "飞书提醒", icon: MessageCircle }] : []),
  ];
  return <aside className="sidebar-shell">
    <button type="button" className="brand-lockup" onClick={() => setActiveView("dashboard")} aria-label="返回首页" title="返回首页"><div className="brand-copy"><div className="brand-name">{officialBrand}</div><div className="brand-subtitle">联合研发 OA</div></div></button>
    <button type="button" data-sidebar-section="office" className="sidebar-section-label sidebar-group-toggle" aria-expanded={officeOpen} aria-controls={officeId} onClick={() => setOfficeOpen(open => !open)}><span>审批办公</span><ChevronRight className="size-3.5" /></button>
    <div id={officeId} hidden={!officeOpen}>
    <nav className="sidebar-nav" aria-label="主导航">{items.map(({ key, label, icon: Icon }) => { const itemPendingCount = key === "dashboard" ? pendingApprovalCount : key === "members" ? pendingMemberCount : key === "knowledge" ? pendingKnowledgeCount : 0; const needsAttention = itemPendingCount > 0; const attentionClass = needsAttention ? `attention attention-${key}` : ""; return <button key={key} className={`sidebar-nav-item ${activeView === key ? "active" : ""} ${attentionClass}`} onClick={() => setActiveView(key)}><Icon className="size-[17px]" /><span>{label}</span>{needsAttention && <span className="nav-count nav-count-alert">{itemPendingCount > 99 ? "99+" : itemPendingCount}</span>}</button>; })}</nav>
    <button type="button" className="sidebar-nav-item" onClick={onMyPending}><Clock3 className="size-[17px]" /><span>待我审批</span></button>
    <button type="button" className="sidebar-nav-item" onClick={onNew}><Plus className="size-[17px]" /><span>新建审核申请</span></button>
    </div>
    <div className="sidebar-divider" />
    <button type="button" data-sidebar-section="knowledge" className="sidebar-section-label sidebar-group-toggle" aria-expanded={knowledgeOpen} aria-controls={knowledgeId} onClick={() => setKnowledgeOpen(open => !open)}><span>大模型与资料</span><ChevronRight className="size-3.5" /></button>
    <nav id={knowledgeId} hidden={!knowledgeOpen} className="oa-knowledge-nav" aria-label="大模型后台">
      {([{ tab: "ask", label: "AI 聊天", icon: Bot }, { tab: "submit", label: "上传资料", icon: Plus }, { tab: "mine", label: "我的资料", icon: FolderKanban }, ...(canReviewKnowledge ? [{ tab: "review", label: "资料审核", icon: ShieldCheck }, { tab: "manage", label: "知识资料管理", icon: BookOpen }] : [])] as { tab: KnowledgeTab; label: string; icon: typeof Bot }[]).map(({ tab, label, icon: Icon }) => <button type="button" key={tab} className={`sidebar-nav-item ${activeView === "knowledge" && selectedKnowledgeTab === tab ? "active" : ""}`} onClick={() => onKnowledgeTab(tab)}><Icon className="size-[17px]" /><span>{label}</span>{tab === "review" && pendingKnowledgeCount > 0 && <span className="nav-count nav-count-alert">{pendingKnowledgeCount > 99 ? "99+" : pendingKnowledgeCount}</span>}</button>)}
      {isAdmin && <a className="sidebar-nav-item" href="https://chat.omindos.ai/manage" target="_blank" rel="noreferrer"><Settings2 className="size-[17px]" /><span>Chat 后台（原入口）</span></a>}
    </nav>
    <a className="sidebar-nav-item" href="/guide"><BookOpen className="size-[17px]" /><span>项目章程与使用指南</span></a>
    <div className="sidebar-footer-card"><div className="footer-card-icon"><UsersRound className="size-4" /></div><div><div className="footer-card-title">联合研发工作区</div><div className="footer-card-text">{officialBrand}</div></div></div>
    <div className="sidebar-user"><div className="avatar avatar-dark sidebar-user-avatar">{userAvatarDataUrl ? <img src={userAvatarDataUrl} alt="" /> : userName.slice(0, 1)}</div><div className="sidebar-user-copy"><div className="sidebar-user-name">{userName}</div><div className="sidebar-user-role">{sessionRoleLabel(currentRole, isAdmin)}</div></div><div className="sidebar-user-control"><button type="button" className="sidebar-user-menu" onClick={() => setUserMenuOpen((open) => !open)} aria-expanded={userMenuOpen} aria-haspopup="menu" aria-label="打开个人账户菜单" title="个人账户菜单"><MoreHorizontal className="size-4" /></button>{userMenuOpen && <div className="sidebar-user-popover" role="menu"><button type="button" role="menuitem" onClick={openProfile}><Settings2 className="size-3.5" />个人设置</button><button type="button" role="menuitem" className="logout-action" onClick={logout}><LogOut className="size-3.5" />退出登录</button></div>}</div></div>
  </aside>;
}

function ApprovalRow({ approval, onOpen }: { approval: Approval; onOpen: (id: string) => void }) {
  const isActive = approval.status === "待审核" || approval.status === "审批中";
  return <TableRow className="approval-row" onClick={() => onOpen(approval.id)}>
    <TableCell><TypeBadge type={approval.type} /></TableCell>
    <TableCell className="min-w-[250px]"><div className="row-title">{approval.title}</div><div className="row-id">{approval.id}</div></TableCell>
    <TableCell><div className="row-person"><div className="avatar avatar-light">{approval.requester.slice(0, 1)}</div>{approval.requester}</div></TableCell>
    <TableCell><div className="row-step">{isActive && <span className="step-pulse" />}{approval.step}</div></TableCell>
    <TableCell className="text-right"><StatusBadge status={approval.status} /></TableCell>
    <TableCell className="text-right"><div className="request-row-actions"><div className="row-date">{approval.updatedAt}</div><ChevronRight className="mt-1 size-4 text-[#b1bac4]" /></div></TableCell>
  </TableRow>;
}

function MobileApprovalCard({ approval, onOpen }: { approval: Approval; onOpen: (id: string) => void }) {
  return <article className="mobile-approval-card"><button type="button" className="mobile-approval-open" onClick={() => onOpen(approval.id)} aria-label={`查看${approval.title}`}><span className="mobile-approval-topline"><TypeBadge type={approval.type} /><StatusBadge status={approval.status} /></span><strong className="mobile-approval-title">{approval.title}</strong><span className="mobile-approval-summary">{approval.summary}</span><span className="mobile-approval-meta"><span>发起人：{approval.requester}</span><span>当前节点：{approval.step}</span></span><span className="mobile-approval-actions"><time>{approval.updatedAt}</time><ChevronRight className="size-4 text-[#83939a]" /></span></button></article>;
}

function FlowCard() {
  const flows = [
    { type: "流转审批", className: "flow-circulation", description: "流转对象和审批人分别选择，可只流转、只审批，或流转后审批；多人分别确认后进入下一步。", steps: ["流转对象确认（可选）", "指定成员审批（可选）", "系统归档"] },
    { type: "技术审核", className: "flow-technical", description: "每位开发人须使用本人账号逐一确认工作内容和贡献占比，再进入两层审核。", steps: ["开发人逐一确认", "技术顾问", "项目负责人"] },
    { type: "采购审核", className: "flow-procurement", description: "项目负责人最终指定采购成员；实际金额不得超过批准金额，确认后归档。", steps: ["技术顾问", "项目负责人指定", "统一采购确认"] },
    { type: "劳务报酬", className: "flow-labor", description: "已归档成果折算值与本月其他工时分开申报，项目负责人说明金额依据，经费负责人终审归档。", steps: ["项目负责人", "经费负责人", "系统归档"] },
  ];
  return <section className="flow-card">
    <div className="flow-card-head"><div><div className="eyebrow"><span className="eyebrow-line" />审批流转规则</div><h2>四类事项，按需选择流转方式</h2></div><Badge variant="outline" className="rule-badge"><Info className="size-3.5" />流程说明</Badge></div>
    <div className="approval-flow-grid">{flows.map((flow) => <div className={`approval-flow-card ${flow.className}`} key={flow.type}><div className="approval-flow-card-head"><strong>{flow.type}</strong><span>正式流程</span></div><div className="approval-flow-steps">{flow.steps.map((step, index) => <div className="approval-flow-step" key={step}><span className="approval-flow-number">{String(index + 1).padStart(2, "0")}</span><span>{step}</span>{index < flow.steps.length - 1 && <ChevronRight className="approval-flow-arrow size-3.5" />}</div>)}</div><p>{flow.description}</p></div>)}</div>
  </section>;
}


function roleLabel(person: Person) {
  if (person.isAdmin) return "系统管理员";
  if (person.permissions.includes("project_owner")) return "项目负责人";
  if (person.permissions.includes("technical_advisor")) return "技术顾问";
  return "项目成员";
}

function formatLastSeen(person: Person) {
  if (!person.ndaCompleted) return (person.isAdmin || person.permissions.includes("project_owner")) ? "待签负责人保密承诺书" : "待签技术保密协议";
  if (person.online) return "在线";
  if (!person.lastSeenAt) return "暂未上线";
  const timestamp = Date.parse(person.lastSeenAt);
  if (!Number.isFinite(timestamp)) return "离线";
  const minutes = Math.max(1, Math.floor((Date.now() - timestamp) / 60_000));
  return minutes < 60 ? `${minutes} 分钟前在线` : `${Math.floor(minutes / 60)} 小时前在线`;
}

function formatChatTimestamp(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function conversationPeer(summary: ConversationSummary): Person {
  return {
    id: summary.peer.email,
    fullName: summary.peer.name || summary.peer.fullName || summary.peer.email,
    email: summary.peer.email.trim().toLowerCase(),
    role: summary.peer.role || "member",
    permissions: Array.isArray(summary.peer.permissions) ? summary.peer.permissions : [],
    isAdmin: summary.peer.isAdmin === true,
    avatarDataUrl: "",
    profile: emptyProfile(),
    lastSeenAt: summary.latestCreatedAt || "",
    online: false,
    ndaCompleted: true,
  };
}

function numericAmount(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;
  const parsed = Number(value.replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function PersonAvatar({ person, onClick, size = "large", interactive = true }: { person: Person; onClick: () => void; size?: "small" | "large"; interactive?: boolean }) {
  const content = <><span className="person-avatar-image">{person.avatarDataUrl ? <img src={person.avatarDataUrl} alt="" /> : person.fullName.slice(0, 1)}</span><i className={`person-online-dot ${person.online ? "online" : ""}`} /></>;
  if (!interactive) return <span className={`person-avatar person-avatar-${size}`} aria-hidden="true">{content}</span>;
  return <button type="button" className={`person-avatar person-avatar-${size}`} onClick={onClick} aria-label={`查看${person.fullName}的个人信息`}>{content}</button>;
}

function MetricDialog({ panel, approvals, monthlyApproved, archiveRatio, onOpenApproval, onOpenChange }: { panel: MetricPanel; approvals: Approval[]; monthlyApproved: Approval[]; archiveRatio: number; onOpenApproval: (id: string) => void; onOpenChange: (panel: MetricPanel) => void }) {
  const archived = approvals.filter((approval) => approval.status === "已归档");
  const archiveEligible = approvals.filter((approval) => !["草稿", "已撤回", "已作废"].includes(approval.status));
  const PanelIcon = panel === "archive" ? Archive : Check;
  return <Dialog open={Boolean(panel)} onOpenChange={(open) => onOpenChange(open ? panel : null)}><DialogContent className="metric-dialog"><DialogHeader><div className="dialog-title-icon"><PanelIcon className="size-5" /></div><DialogTitle>{panel === "archive" ? "归档完整率" : "本月已通过"}</DialogTitle><DialogDescription>{panel === "archive" ? "按正式流转记录统计已归档申请；草稿、已撤回和已作废不计入分母。" : "查看本月已完成审批的文档，点击文档可打开详情。"}</DialogDescription></DialogHeader>{panel === "approved" ? <div className="metric-document-list">{monthlyApproved.length ? monthlyApproved.map((approval) => <button type="button" className="metric-document" key={approval.id} onClick={() => { onOpenChange(null); onOpenApproval(approval.id); }}><div><TypeBadge type={approval.type} /><strong>{approval.title}</strong><small>{approval.createdAt} · {approval.requester}</small></div><div className="metric-document-end"><StatusBadge status={approval.status} /><ChevronRight className="size-4" /></div></button>) : <div className="metric-empty"><Check className="size-5" /><p>本月暂时没有已通过的文档</p></div>}</div> : <div className="archive-metric"><div className="archive-metric-hero"><strong>{archiveRatio}<span>%</span></strong><div><b>已归档比例</b><small>{archived.length} / {archiveEligible.length || 0} 条正式流转申请已归档</small></div></div><div className="archive-metric-bar"><span style={{ width: `${archiveRatio}%` }} /></div><div className="archive-metric-breakdown"><div><span className="archive-dot archived" /><b>{archived.length}</b><small>已归档</small></div><div><span className="archive-dot pending" /><b>{Math.max(archiveEligible.length - archived.length, 0)}</b><small>流转中</small></div></div>{archived.length ? <div className="metric-document-list">{archived.map((approval) => <button type="button" className="metric-document" key={approval.id} onClick={() => { onOpenChange(null); onOpenApproval(approval.id); }}><div><TypeBadge type={approval.type} /><strong>{approval.title}</strong><small>{approval.createdAt} · {approval.requester}</small></div><div className="metric-document-end"><StatusBadge status={approval.status} /><ChevronRight className="size-4" /></div></button>)}</div> : <div className="metric-empty"><Archive className="size-5" /><p>还没有已归档的申请</p></div>}</div>}</DialogContent></Dialog>;
}

function RequestsView({ approvals, filteredApprovals, myPendingApprovals, dataReady, activeFilter, setActiveFilter, showMineOnly, onClearMine, onOpen }: { approvals: Approval[]; filteredApprovals: Approval[]; myPendingApprovals: Approval[]; dataReady: boolean; activeFilter: "全部" | ApprovalType; setActiveFilter: (filter: "全部" | ApprovalType) => void; showMineOnly: boolean; onClearMine: () => void; onOpen: (id: string) => void }) {
  const scopedApprovals = showMineOnly ? myPendingApprovals : approvals;
  return <div className="requests-view"><div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />审批事项</div><h1>{showMineOnly ? "待我处理" : "全部申请"}</h1><p>{showMineOnly ? "点击任意申请查看详情，并完成当前审核节点。" : "集中查看技术、采购、劳务报酬与流转审批申请。"}</p></div>{showMineOnly && <Button variant="outline" onClick={onClearMine}>查看全部申请</Button>}</div><div className="requests-card requests-page-card"><div className="requests-card-head"><div><div className="eyebrow"><span className="eyebrow-line" />申请列表</div><h2>{showMineOnly ? "当前账号待处理" : "全部申请"}</h2></div><div className="request-head-actions"><div className="filter-tabs"><button className={activeFilter === "全部" ? "active" : ""} onClick={() => setActiveFilter("全部")}>全部 <span>{scopedApprovals.length}</span></button><button className={activeFilter === "技术审核" ? "active" : ""} onClick={() => setActiveFilter("技术审核")}>技术 <span>{scopedApprovals.filter((item) => item.type === "技术审核").length}</span></button><button className={activeFilter === "采购审核" ? "active" : ""} onClick={() => setActiveFilter("采购审核")}>采购 <span>{scopedApprovals.filter((item) => item.type === "采购审核").length}</span></button><button className={activeFilter === "劳务报酬" ? "active" : ""} onClick={() => setActiveFilter("劳务报酬")}>劳务 <span>{scopedApprovals.filter((item) => item.type === "劳务报酬").length}</span></button><button className={activeFilter === "流转审批" ? "active" : ""} onClick={() => setActiveFilter("流转审批")}>流转审批 <span>{scopedApprovals.filter((item) => item.type === "流转审批").length}</span></button></div></div></div><Table><TableHeader><TableRow><TableHead>类型</TableHead><TableHead>申请事项</TableHead><TableHead>发起人</TableHead><TableHead>当前节点</TableHead><TableHead className="text-right">状态</TableHead><TableHead className="text-right">更新时间</TableHead></TableRow></TableHeader><TableBody>{!dataReady ? <TableRow><TableCell colSpan={6}><div className="loading-cell"><Clock3 className="size-4" />正在连接正式审批数据…</div></TableCell></TableRow> : filteredApprovals.map((approval) => <ApprovalRow key={approval.id} approval={approval} onOpen={onOpen} />)}</TableBody></Table><div className="requests-mobile-list">{!dataReady ? <div className="mobile-requests-loading"><Clock3 className="size-4" />正在连接正式审批数据…</div> : filteredApprovals.map((approval) => <MobileApprovalCard key={approval.id} approval={approval} onOpen={onOpen} />)}</div>{dataReady && filteredApprovals.length === 0 && <div className="empty-state"><FolderKanban className="size-6" /><p>{showMineOnly ? "当前没有分配给你的待处理申请" : "当前筛选下暂无申请"}</p></div>}<div className="table-foot"><span>显示 {dataReady ? filteredApprovals.length : "—"} 条申请</span><span>申请记录不直接删除；申请人可按规则撤回、作废或追加归档说明</span></div></div></div>;
}

const profileVisibilityItems: Array<{ key: keyof ProfileVisibility; label: string; description: string }> = [
  { key: "department", label: "所在部门", description: "公开由管理员设置的部门" },
  { key: "position", label: "职务 / 负责方向", description: "方便成员了解你的分工" },
  { key: "phone", label: "联系方式", description: "允许成员查看你的联系方式" },
  { key: "bio", label: "个人简介", description: "在个人资料中展示简介" },
];

function ProfileVisibilityOptions({ visibility, onChange }: { visibility: ProfileVisibility; onChange: (key: keyof ProfileVisibility, value: boolean) => void }) {
  return <div className="profile-privacy"><div className="profile-privacy-head"><div><strong>选择公开内容</strong><span>仅对已通过审核的协作成员可见</span></div><ShieldCheck className="size-4" /></div><div className="profile-privacy-list">{profileVisibilityItems.map((item) => <label className={`profile-privacy-option ${visibility[item.key] ? "enabled" : ""}`} key={item.key}><input type="checkbox" checked={visibility[item.key]} onChange={(event) => onChange(item.key, event.target.checked)} /><span className="profile-privacy-copy"><strong>{item.label}</strong><small>{item.description}</small></span><span className="profile-privacy-state">{visibility[item.key] ? "已公开" : "未公开"}</span></label>)}</div></div>;
}

function ProfileDialog({ person, open, currentEmail, onOpenChange, onSaved, onChat }: { person: Person | null; open: boolean; currentEmail?: string; onOpenChange: (open: boolean) => void; onSaved: (person: Person) => void; onChat: (person: Person) => void }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [avatarDataUrl, setAvatarDataUrl] = useState("");
  const [profile, setProfile] = useState<PersonProfile>(emptyProfile());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isSelf = Boolean(person && currentEmail && person.email === currentEmail.toLowerCase());
  useEffect(() => {
    if (!person) return;
    setEditing(false);
    setAvatarDataUrl(person.avatarDataUrl || "");
    setProfile(normalizeProfile(person.profile));
    if (!open || !isSelf) return;
    fetch("/api/profile", { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" }).then(async (response) => {
      const data = await response.json() as { profile?: PersonProfile & { avatarDataUrl?: string }; error?: string };
      if (!response.ok) throw new Error(data.error || "个人资料加载失败");
      setAvatarDataUrl(data.profile?.avatarDataUrl || "");
      setProfile(normalizeProfile(data.profile));
    }).catch(() => undefined);
  }, [open, isSelf, person]);
  if (!person) return null;
  const updateProfile = (key: ProfileField, value: string) => setProfile((current) => ({ ...current, [key]: value }));
  const updateVisibility = (key: keyof ProfileVisibility, value: boolean) => setProfile((current) => ({ ...current, visibility: { ...current.visibility, [key]: value } }));
  const chooseAvatar = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 70_000) { toast.error("头像文件过大", { description: "请选择 70KB 以内的静态 PNG、JPEG 或 WebP；最长边不超过 2048 像素，总像素不超过 400 万。" }); return; }
    const reader = new FileReader();
    reader.onload = () => { if (typeof reader.result === "string") { setAvatarDataUrl(reader.result); setEditing(true); } };
    reader.readAsDataURL(file);
  };
  const save = async () => {
    setSaving(true);
    try {
      const response = await fetch("/api/profile", { method: "PATCH", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ avatarDataUrl, profile }) });
      const data = await response.json() as { profile?: PersonProfile & { avatarDataUrl?: string; lastSeenAt?: string }; error?: string };
      if (!response.ok || !data.profile) throw new Error(data.error || "个人资料保存失败");
      const nextProfile = normalizeProfile(data.profile);
      onSaved({ ...person, avatarDataUrl: data.profile.avatarDataUrl || "", profile: nextProfile, lastSeenAt: data.profile.lastSeenAt || person.lastSeenAt, online: true });
      setProfile(nextProfile); setAvatarDataUrl(data.profile.avatarDataUrl || ""); setEditing(false); toast.success("个人资料已更新");
    } catch (error) { toast.error("个人资料保存失败", { description: error instanceof Error ? error.message : "请稍后重试" }); }
    finally { setSaving(false); }
  };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="profile-dialog"><DialogHeader><div className="profile-dialog-identity"><div className="profile-avatar-large">{avatarDataUrl ? <img src={avatarDataUrl} alt={`${person.fullName}头像`} /> : <span>{person.fullName.slice(0, 1)}</span>}<i className={`person-online-dot ${person.online ? "online" : ""}`} />{isSelf && editing && <button type="button" className="profile-avatar-edit" onClick={() => fileInputRef.current?.click()} aria-label="更换头像"><Camera className="size-4" /></button>}</div><div><DialogTitle>{person.fullName}</DialogTitle><DialogDescription>{roleLabel(person)} · {person.online ? "当前在线" : formatLastSeen(person)}</DialogDescription></div></div></DialogHeader><input ref={fileInputRef} className="hidden" type="file" accept="image/png,image/jpeg,image/webp" onChange={chooseAvatar} />{editing && isSelf ? <div className="profile-form"><div className="form-grid-2"><Field label="所在部门（管理员设置）"><Input value={profile.department || "未设置"} readOnly /></Field><Field label="职务 / 负责方向"><Input value={profile.position} onChange={(event) => updateProfile("position", event.target.value)} placeholder="例如：嵌入式开发" /></Field></div><Field label="联系方式"><Input value={profile.phone} onChange={(event) => updateProfile("phone", event.target.value)} placeholder="可填写手机号或常用联系方式" /></Field><Field label="个人简介"><Textarea value={profile.bio} onChange={(event) => updateProfile("bio", event.target.value)} rows={3} placeholder="介绍当前负责的工作、技能或协作事项" /></Field><ProfileVisibilityOptions visibility={profile.visibility} onChange={(key, value) => updateVisibility(key, value)} /><p className="profile-edit-note">姓名请在“个人设置”中修改；登录身份和所在部门保持不变。</p></div> : <div className="profile-details"><div><span>认证邮箱</span><strong>{person.email}</strong></div><div><span>所在部门</span><strong>{profileValue(person, "department", currentEmail)}</strong></div><div><span>职务 / 负责方向</span><strong>{profileValue(person, "position", currentEmail)}</strong></div><div><span>联系方式</span><strong>{profileValue(person, "phone", currentEmail)}</strong></div><div className="profile-bio"><span>个人简介</span><strong>{profileValue(person, "bio", currentEmail, "这位成员还没有填写个人简介。")}</strong></div></div>}<DialogFooter className="profile-footer">{isSelf && !editing && <Button variant="outline" onClick={() => setEditing(true)}><Pencil className="size-4" />编辑我的资料</Button>}{isSelf && editing && <><Button variant="outline" onClick={() => { setEditing(false); setAvatarDataUrl(person.avatarDataUrl || ""); setProfile(normalizeProfile(person.profile)); }}>取消</Button><Button className="primary-button" onClick={save} disabled={saving}>{saving ? "保存中…" : "保存资料"}</Button></>}{!isSelf && person.ndaCompleted && <Button className="primary-button" onClick={() => { onOpenChange(false); onChat(person); }}><MessageCircle className="size-4" />私聊</Button>}</DialogFooter></DialogContent></Dialog>;
}

function ChatDialog({ person, currentPerson, currentRoleLabel, open, currentEmail, onOpenChange }: { person: Person | null; currentPerson?: Person; currentRoleLabel?: string; open: boolean; currentEmail?: string; onOpenChange: (open: boolean) => void }) {
  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const messagesRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const latestCreatedAtRef = useRef("");
  const personEmail = person?.email || "";
  useEffect(() => {
    if (!open || !personEmail) return;
    let cancelled = false;
    let requestInFlight = false;
    setMessages([]);
    setBody("");
    setError("");
    setLoading(true);
    autoScrollRef.current = true;
    latestCreatedAtRef.current = "";
    const loadMessages = async (initial = false) => {
      if (requestInFlight) return;
      requestInFlight = true;
      try {
        const after = !initial && latestCreatedAtRef.current ? `&after=${encodeURIComponent(latestCreatedAtRef.current)}` : "";
        const response = await fetch(`/api/direct-messages?with=${encodeURIComponent(personEmail)}&limit=100${after}`, { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" });
        const data = await response.json() as { messages?: DirectMessage[]; error?: string };
        if (!response.ok) throw new Error(data.error || "私聊记录加载失败");
        const received = data.messages ?? [];
        if (!cancelled) {
          setMessages((current) => {
            if (initial) return received;
            const byId = new Map(current.map((message) => [message.id, message]));
            received.forEach((message) => byId.set(message.id, message));
            return Array.from(byId.values()).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
          });
          const latest = received.at(-1)?.createdAt;
          if (latest) latestCreatedAtRef.current = latest;
          setError("");
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "私聊记录加载失败");
      } finally {
        requestInFlight = false;
        if (!cancelled && initial) setLoading(false);
      }
    };
    void loadMessages(true);
    const timer = window.setInterval(() => { void loadMessages(false); }, 5_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [open, personEmail, reloadKey]);
  useEffect(() => {
    if (autoScrollRef.current) messagesEndRef.current?.scrollIntoView({ behavior: "auto", block: "nearest" });
  }, [messages.length, open]);
  if (!person) return null;
  const sendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!body.trim() || sending) return;
    setSending(true);
    try {
      const response = await fetch("/api/direct-messages", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ recipientEmail: person.email, body }) });
      const data = await response.json() as { message?: DirectMessage; error?: string };
      if (!response.ok || !data.message) throw new Error(data.error || "私聊消息发送失败");
      autoScrollRef.current = true;
      setMessages((current) => current.some((message) => message.id === data.message?.id) ? current : [...current, data.message as DirectMessage]);
      setBody("");
      setError("");
    } catch (error) { toast.error("消息发送失败", { description: error instanceof Error ? error.message : "请稍后重试" }); }
    finally { setSending(false); }
  };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="chat-dialog"><DialogHeader><div className="chat-dialog-identity"><div><DialogTitle>与 {person.fullName} 私聊</DialogTitle><DialogDescription>{roleLabel(person)} · 消息仅对双方可见</DialogDescription></div></div></DialogHeader><div ref={messagesRef} className="chat-messages" aria-busy={loading} onScroll={() => { const container = messagesRef.current; if (container) autoScrollRef.current = container.scrollHeight - container.scrollTop - container.clientHeight <= 72; }}>{error && <div className="chat-error" role="alert"><span>{error}</span><button type="button" onClick={() => setReloadKey((current) => current + 1)}>重新加载</button></div>}{loading ? <div className="chat-empty">正在加载私聊记录…</div> : messages.length ? <>{messages.map((message, index) => {
    const normalizedSender = message.senderEmail.toLowerCase();
    const outgoing = normalizedSender === currentEmail?.toLowerCase();
    const sameSender = index > 0 && messages[index - 1].senderEmail.toLowerCase() === normalizedSender;
    const senderRole = outgoing ? (currentRoleLabel || (currentPerson ? roleLabel(currentPerson) : "本人")) : roleLabel(person);
    return <div className={`chat-message ${outgoing ? "outgoing" : "incoming"}`} key={message.id}><small className={`chat-message-meta ${sameSender ? "continuation" : ""}`}>{!sameSender && <><strong>{message.senderName}</strong><span>· {senderRole}</span></>}<time dateTime={message.createdAt}>{formatChatTimestamp(message.createdAt)}</time></small><div className="chat-message-body">{message.body}</div></div>;
  })}<div ref={messagesEndRef} /></> : !error && <div className="chat-empty"><MessageCircle className="size-5" /><p>还没有消息，开始私聊吧。</p><div ref={messagesEndRef} /></div>}</div><form className="chat-compose" onSubmit={sendMessage}><Textarea value={body} onChange={(event) => setBody(event.target.value)} rows={2} maxLength={1000} placeholder={`给 ${person.fullName} 发消息…`} /><Button className="primary-button" type="submit" disabled={sending || !body.trim()}><Send className="size-4" />{sending ? "发送中…" : "发送"}</Button></form></DialogContent></Dialog>;
}

function ChatHub({ currentUser, currentRole, isAdmin = false }: { currentUser?: SessionInfo["user"]; currentRole?: string | null; isAdmin?: boolean }) {
  const [open, setOpen] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [chatPerson, setChatPerson] = useState<Person | null>(null);
  const [unread, setUnread] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const unreadRef = useRef(new Set<string>());
  const latestRef = useRef(new Map<string, string>());
  const initializedRef = useRef(false);
  const currentEmail = currentUser?.email?.toLowerCase();
  useEffect(() => {
    if (!currentEmail) return;
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/direct-messages?summary=1", { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" });
        const data = await response.json() as { conversations?: ConversationSummary[]; error?: string };
        if (!response.ok) throw new Error(data.error || "会话列表加载失败");
        const nextConversations = (data.conversations ?? []).filter((conversation) => conversation.peer?.email && conversation.peer.email.trim().toLowerCase() !== currentEmail);
        const nextUnread = new Set(unreadRef.current);
        nextConversations.forEach((conversation) => {
          const peerEmail = conversation.peer.email.trim().toLowerCase();
          const latestIncomingId = conversation.latestIncomingId || "";
          if (latestIncomingId && initializedRef.current && latestRef.current.get(peerEmail) !== latestIncomingId && chatPerson?.email !== peerEmail) nextUnread.add(peerEmail);
          if (latestIncomingId) latestRef.current.set(peerEmail, latestIncomingId);
        });
        if (!cancelled) {
          setConversations(nextConversations);
          unreadRef.current = nextUnread;
          setUnread(nextUnread);
          initializedRef.current = true;
          setError("");
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "会话列表加载失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    setLoading(true);
    void load();
    const timer = window.setInterval(load, 15_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [currentEmail, chatPerson?.email]);
  const openChat = (person: Person) => { const email = person.email.trim().toLowerCase(); setChatPerson(person); setUnread((current) => { const next = new Set(current); next.delete(email); unreadRef.current = next; return next; }); setOpen(false); };
  return <><div className="chat-hub"><button type="button" className={`icon-button chat-hub-button ${unread.size ? "has-unread" : ""}`} onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-haspopup="dialog" aria-label="打开聊天" title="聊天"><MessageCircle className="size-[17px]" /><span className="chat-hub-label">聊天</span>{unread.size > 0 && <span className="chat-hub-badge">{unread.size > 9 ? "9+" : unread.size}</span>}</button>{open && <div className="chat-hub-popover" role="dialog" aria-label="会话列表"><div className="chat-hub-title"><strong>聊天</strong><span>{conversations.length} 个会话</span></div>{loading ? <div className="chat-hub-empty">正在加载会话…</div> : error ? <div className="chat-hub-empty chat-hub-error">{error}</div> : conversations.length ? conversations.map((conversation) => { const person = conversationPeer(conversation); const hasUnread = unread.has(person.email); return <button type="button" className={`chat-hub-person ${hasUnread ? "unread" : ""}`} key={person.email} onClick={() => openChat(person)}><span className="chat-person-copy"><strong>{person.fullName}</strong><small>{conversation.latestCreatedAt ? `最近消息 · ${formatChatTimestamp(conversation.latestCreatedAt)}` : "还没有消息"}</small></span>{hasUnread && <i aria-label="有新消息" />}</button>; }) : <div className="chat-hub-empty">暂无可聊天成员</div>}</div>}</div><ChatDialog key={chatPerson?.email || "chat-dialog"} person={chatPerson} currentRoleLabel={sessionRoleLabel(currentRole, isAdmin)} open={Boolean(chatPerson)} currentEmail={currentEmail} onOpenChange={(value) => { if (!value) setChatPerson(null); }} /></>;
}

function PeopleView({ currentUser }: { currentUser?: SessionInfo["user"] }) {
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedPerson, setSelectedPerson] = useState<Person | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [chatPerson, setChatPerson] = useState<Person | null>(null);
  const currentEmail = currentUser?.email?.toLowerCase();
  useEffect(() => {
    let cancelled = false;
    const loadPeople = async () => {
      try {
        const response = await fetch("/api/people?scope=directory", { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" });
        const data = await response.json() as { people?: Person[]; error?: string };
        if (!response.ok) throw new Error(data.error || "成员目录加载失败");
        if (!cancelled) { setPeople(data.people ?? []); setError(""); }
      } catch (loadError) { if (!cancelled) setError(loadError instanceof Error ? loadError.message : "成员目录加载失败"); }
      finally { if (!cancelled) setLoading(false); }
    };
    loadPeople();
    const timer = setInterval(loadPeople, 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [currentEmail]);
  const openProfile = (person: Person) => { setSelectedPerson(person); setProfileOpen(true); };
  const openChat = (person: Person) => { setChatPerson(person); };
  const updatePerson = (person: Person) => { setPeople((current) => current.map((item) => item.email === person.email ? person : item)); setSelectedPerson(person); };
  const onlineCount = people.filter((person) => person.online).length;
  const self = people.find((person) => person.email === currentEmail);
  return <div className="people-view"><div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />团队通讯录</div><h1>协作成员</h1><p>已通过审核的成员会自动加入；完成保密协议后可使用私聊和内部协作功能。</p></div><Button variant="outline" onClick={() => self && openProfile(self)} disabled={!self}><Pencil className="size-4" />编辑我的资料</Button></div><div className="people-summary"><div><UsersRound className="size-5" /><strong>{people.length}</strong><span>位协作成员</span></div><div><span className="people-online-indicator" /><strong>{onlineCount}</strong><span>人在线</span></div><small>在线状态每 30 秒刷新一次</small></div>{loading ? <div className="people-loading"><Clock3 className="size-5" />正在加载成员目录…</div> : error ? <div className="empty-state"><UsersRound className="size-6" /><p>{error}</p></div> : people.length === 0 ? <div className="empty-state"><UsersRound className="size-6" /><p>暂无已通过审核的成员</p></div> : <div className="people-grid">{people.map((person) => <article className="person-card" key={person.email}><div className="person-card-head"><PersonAvatar person={person} onClick={() => openProfile(person)} /><div className="person-card-identity"><button type="button" className="person-name" onClick={() => openProfile(person)}>{person.fullName}</button><span className="person-role">{roleLabel(person)}</span><span className={`person-status ${person.online ? "online" : ""}`}><i />{formatLastSeen(person)}</span></div></div><div className="person-card-profile"><span>{profileValue(person, "department", currentEmail, "未填写部门")}</span><span>{profileValue(person, "position", currentEmail, "未填写负责方向")}</span></div><div className="person-card-actions"><button type="button" onClick={() => openProfile(person)}><UserRound className="size-3.5" />查看资料</button>{person.email !== currentEmail && person.ndaCompleted && <button type="button" onClick={() => openChat(person)}><MessageCircle className="size-3.5" />私聊</button>}</div></article>)}</div>}<ProfileDialog person={selectedPerson} open={profileOpen} currentEmail={currentEmail} onOpenChange={setProfileOpen} onSaved={updatePerson} onChat={openChat} /><ChatDialog key={chatPerson?.email || "people-chat-dialog"} person={chatPerson} currentPerson={self} open={Boolean(chatPerson)} currentEmail={currentEmail} onOpenChange={(open) => { if (!open) setChatPerson(null); }} /></div>;
}

function ProfileSettingsView({ currentUser, currentRole, isAdmin = false, migrationExportEnabled = false, migrationUnfreezeEnabled = false, onIdentityChanged }: { currentUser?: SessionInfo["user"]; currentRole?: string | null; isAdmin?: boolean; migrationExportEnabled?: boolean; migrationUnfreezeEnabled?: boolean; onIdentityChanged: (fullName: string, avatarDataUrl: string) => void }) {
  const [profile, setProfile] = useState<PersonProfile>(emptyProfile());
  const [displayName, setDisplayName] = useState(currentUser?.displayName || "");
  const [avatarDataUrl, setAvatarDataUrl] = useState("");
  const [feishuLoginEnabled, setFeishuLoginEnabled] = useState(false);
  const [githubLoginEnabled, setGithubLoginEnabled] = useState(false);
  const [chatgptLoginEnabled, setChatgptLoginEnabled] = useState(false);
  const [chatgptLinked, setChatgptLinked] = useState(false);
  const [feishuLinked, setFeishuLinked] = useState(false);
  const [githubLinked, setGithubLinked] = useState(false);
  const [linkingFeishu, setLinkingFeishu] = useState(false);
  const [linkingGithub, setLinkingGithub] = useState(false);
  const [unlinkingGithub, setUnlinkingGithub] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const feishuLinkLockRef = useRef(false);
  const githubLinkLockRef = useRef(false);

  useEffect(() => {
    if (!currentUser?.email) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    fetch("/api/profile", { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as { officialName?: string; profile?: PersonProfile & { avatarDataUrl?: string }; chatgptLoginEnabled?: boolean; githubLoginEnabled?: boolean; feishuLoginEnabled?: boolean; chatgptLinked?: boolean; githubLinked?: boolean; feishuLinked?: boolean; error?: string };
        if (!response.ok || !data.profile) throw new Error(data.error || "个人资料加载失败");
        if (!cancelled) {
          setDisplayName(data.officialName || currentUser.displayName || "");
          setAvatarDataUrl(data.profile.avatarDataUrl || "");
          setProfile(normalizeProfile(data.profile));
          setChatgptLoginEnabled(data.chatgptLoginEnabled === true);
          setFeishuLoginEnabled(data.feishuLoginEnabled === true);
          setGithubLoginEnabled(data.githubLoginEnabled === true);
          setChatgptLinked(data.chatgptLinked === true);
          setFeishuLinked(data.feishuLinked === true);
          setGithubLinked(data.githubLinked === true);
          setError("");
        }
      })
      .catch((loadError: unknown) => { if (!cancelled) setError(loadError instanceof Error ? loadError.message : "个人资料加载失败"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [currentUser?.email, currentUser?.displayName]);

  const updateProfile = (key: ProfileField, value: string) => setProfile((current) => ({ ...current, [key]: value }));
  const updateVisibility = (key: keyof ProfileVisibility, value: boolean) => setProfile((current) => ({ ...current, visibility: { ...current.visibility, [key]: value } }));
  const chooseAvatar = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 70_000) { toast.error("头像文件过大", { description: "请选择 70KB 以内的静态 PNG、JPEG 或 WebP；最长边不超过 2048 像素，总像素不超过 400 万。" }); return; }
    const reader = new FileReader();
    reader.onload = () => { if (typeof reader.result === "string") setAvatarDataUrl(reader.result); };
    reader.readAsDataURL(file);
  };
  const save = async () => {
    setSaving(true);
    try {
      const response = await fetch("/api/profile", { method: "PATCH", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ fullName: displayName, avatarDataUrl, profile }) });
      const data = await response.json() as { officialName?: string; profile?: PersonProfile & { avatarDataUrl?: string }; error?: string };
      if (!response.ok || !data.profile) throw new Error(data.error || "个人资料保存失败");
      const nextProfile = normalizeProfile(data.profile);
      const nextDisplayName = data.officialName || displayName.trim();
      setProfile(nextProfile);
      setDisplayName(nextDisplayName);
      setAvatarDataUrl(data.profile.avatarDataUrl || "");
      onIdentityChanged(nextDisplayName, data.profile.avatarDataUrl || "");
      toast.success("个人设置已保存", { description: "姓名、资料和公开范围已更新；历史审批中的姓名快照保持不变。" });
    } catch (saveError: unknown) { toast.error("个人设置保存失败", { description: saveError instanceof Error ? saveError.message : "请稍后重试" }); }
    finally { setSaving(false); }
  };
  const beginFeishuLink = (event: FormEvent<HTMLFormElement>) => {
    if (feishuLinkLockRef.current) {
      event.preventDefault();
      return;
    }
    feishuLinkLockRef.current = true;
    setLinkingFeishu(true);
  };
  const beginGitHubLink = (event: FormEvent<HTMLFormElement>) => {
    if (githubLinkLockRef.current) {
      event.preventDefault();
      return;
    }
    githubLinkLockRef.current = true;
    setLinkingGithub(true);
  };
  const unlinkGitHub = async () => {
    if (!window.confirm("确认解绑 GitHub 登录？OA 成员、权限、保密协议和审批历史不会删除；解绑后仍可使用 ChatGPT 登录。")) return;
    setUnlinkingGithub(true);
    try {
      const response = await fetch("/api/auth/github/link", { method: "DELETE", headers: { accept: "application/json" }, credentials: "same-origin" });
      const data = await response.json() as { githubLinked?: boolean; error?: string };
      if (!response.ok || data.githubLinked !== false) throw new Error(data.error || "GitHub 解绑失败");
      setGithubLinked(false);
      toast.success("GitHub 已解绑", { description: "ChatGPT 登录和 OA 历史记录保持不变。" });
    } catch (unlinkError: unknown) {
      toast.error("GitHub 未解绑", { description: unlinkError instanceof Error ? unlinkError.message : "请稍后重试" });
    } finally {
      setUnlinkingGithub(false);
    }
  };

  return (
    <div className="profile-settings-view">
      <div className="page-heading profile-settings-heading">
        <div><div className="eyebrow"><span className="eyebrow-line" />账户设置</div><h1>个人设置</h1><p>完善协作资料，并自主决定哪些个人内容展示给团队成员。</p></div>
        <Badge variant="outline" className="profile-settings-badge"><ShieldCheck className="size-3.5" />个人资料仅本人可改</Badge>
      </div>
      {loading ? <div className="profile-settings-loading"><Clock3 className="size-5" />正在加载个人资料…</div> : error ? <div className="empty-state profile-settings-error"><UserRound className="size-6" /><p>{error}</p></div> : (
        <div className="profile-settings-grid">
          <section className="profile-settings-card profile-settings-identity-card">
            <div className="profile-settings-kicker">我的账号</div>
            <div className="profile-settings-avatar-wrap">
              <div className="profile-settings-avatar">
                {avatarDataUrl ? <img src={avatarDataUrl} alt={`${displayName}头像`} /> : <span>{displayName.slice(0, 1) || "成"}</span>}
                <button type="button" className="profile-avatar-edit" onClick={() => fileInputRef.current?.click()} aria-label="更换头像" title="更换头像"><Camera className="size-4" /></button>
              </div>
              <input ref={fileInputRef} className="hidden" type="file" accept="image/png,image/jpeg,image/webp" onChange={chooseAvatar} />
            </div>
            <h2>{displayName || "内部成员"}</h2>
            <p className="profile-settings-account">{accountIdentityLabel(currentUser)}</p>
            <div className="profile-settings-account-row"><span>成员状态</span><strong>已通过审核</strong></div>
            <div className="profile-settings-account-row"><span>系统角色</span><strong>{sessionRoleLabel(currentRole, isAdmin)}</strong></div>
            <div className="profile-settings-account-row"><span>当前登录</span><strong>{authProviderLabel(currentUser?.authProvider)}</strong></div>
            {(feishuLoginEnabled || feishuLinked) && (
              <div className={`feishu-link-panel ${feishuLinked ? "linked" : ""}`}>
                <div className="github-link-heading"><Building2 className="size-4" /><div><strong>飞书扫码登录</strong><span>{feishuLinked ? "已绑定，扫码后继续进入当前成员账号" : "绑定灵感智能飞书身份，保留当前成员的全部原数据"}</span></div></div>
                {feishuLinked
                  ? <Badge variant="outline" className="feishu-linked-badge"><Check className="size-3.5" />已绑定</Badge>
                  : <form method="post" action="/api/auth/feishu/start?return_to=%2F" target="_top" aria-busy={linkingFeishu} onSubmit={beginFeishuLink}><button type="submit" className="feishu-link-button" disabled={linkingFeishu}><Building2 className="size-4" />{linkingFeishu ? "正在打开飞书…" : "绑定飞书"}</button></form>}
                <small>原有成员请先用原 ChatGPT 账号进入，再在这里绑定。系统按当前成员 ID 关联，不按姓名或邮箱自动合并。</small>
              </div>
            )}
            {(githubLoginEnabled || githubLinked) && (
              <div className={`github-link-panel ${githubLinked ? "linked" : ""}`}>
                <div className="github-link-heading"><GitBranch className="size-4" /><div><strong>GitHub 登录</strong><span>{githubLinked ? chatgptLoginEnabled && chatgptLinked ? "已绑定，可作为并列登录方式" : "当前 GitHub 身份已绑定 OA 账号" : "绑定后可使用 GitHub 登录同一成员账号"}</span></div></div>
                {githubLinked ? <div className="github-linked-actions"><Badge variant="outline" className="github-linked-badge"><Check className="size-3.5" />已绑定</Badge>{chatgptLinked && currentUser?.authProvider === "chatgpt" && <button type="button" className="github-unlink-button" onClick={() => void unlinkGitHub()} disabled={unlinkingGithub}>{unlinkingGithub ? "解绑中…" : "解绑"}</button>}</div> : currentUser?.authProvider === "chatgpt" ? <form method="post" action="/api/auth/github/start?return_to=%2F" target="_top" aria-busy={linkingGithub} onSubmit={beginGitHubLink}><button type="submit" className="github-link-button" disabled={linkingGithub}><GitBranch className="size-4" />{linkingGithub ? "正在前往 GitHub…" : "绑定 GitHub"}</button></form> : <span className="github-link-hint">请使用已有登录方式进入后，由管理员协助绑定</span>}
                <small>仅读取 GitHub 数字账号 ID 与已验证邮箱，不申请仓库权限。</small>
              </div>
            )}
            {migrationExportEnabled && (
              <div className="github-link-panel migration-export-panel">
                <div className="github-link-heading"><Download className="size-4" /><div><strong>加密迁移包</strong><span>只在短时迁移窗口内向 OA 管理员开放</span></div></div>
                <form method="post" action="/api/admin/migration-export"><button type="submit" className="github-link-button"><Download className="size-4" />下载加密迁移包</button></form>
                <form method="post" action="/api/admin/migration-export?delivery=inline"><button type="submit" className="github-link-button">打开加密迁移包</button></form>
                <form method="post" action="/api/admin/migration-export?delivery=connector"><button type="submit" className="github-link-button">准备加密迁移副本</button></form>
                <small>文件已使用临时公钥加密并附带源站认证；请勿转发或改名。</small>
              </div>
            )}
            {migrationUnfreezeEnabled && (
              <div className="github-link-panel migration-export-panel">
                <div className="github-link-heading"><ShieldAlert className="size-4" /><div><strong>取消迁移冻结</strong><span>仅在迁移失败恢复窗口中显示</span></div></div>
                <form method="post" action="/api/admin/migration-unfreeze" onSubmit={(event) => { if (!window.confirm("确认取消本次迁移？系统仅在迁移包已经过期后允许解除冻结；旧迁移包必须销毁。")) event.preventDefault(); }}><input type="hidden" name="confirmation" value="discard-current-migration-package" /><button type="submit" className="github-link-button"><ShieldAlert className="size-4" />解除数据库迁移栅栏</button></form>
                <small>解除后必须销毁当前迁移包，并由维护人员关闭网页写入冻结；请勿在迁移正常进行时操作。</small>
              </div>
            )}
            <div className="profile-settings-privacy-note"><ShieldCheck className="size-4" /><span>所在部门由管理员设置；其他公开范围只影响协作成员通讯录。</span></div>
          </section>
          <section className="profile-settings-card profile-settings-editor-card">
            <div className="profile-settings-card-head"><div><div className="profile-settings-kicker">可编辑资料</div><h2>完善你的协作信息</h2></div><Settings2 className="size-5" /></div>
            <div className="profile-form">
              <Field label="姓名"><Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} minLength={2} maxLength={40} placeholder="请输入真实姓名" /></Field>
              <div className="form-grid-2"><Field label="所在部门（管理员设置）"><Input value={profile.department || "未设置"} readOnly /></Field><Field label="职务 / 负责方向"><Input value={profile.position} onChange={(event) => updateProfile("position", event.target.value)} placeholder="例如：嵌入式开发" /></Field></div>
              <Field label="联系方式"><Input value={profile.phone} onChange={(event) => updateProfile("phone", event.target.value)} placeholder="可填写手机号或常用联系方式" /></Field>
              <Field label="个人简介"><Textarea value={profile.bio} onChange={(event) => updateProfile("bio", event.target.value)} rows={4} placeholder="介绍当前负责的工作、技能或协作事项" /></Field>
              <ProfileVisibilityOptions visibility={profile.visibility} onChange={(key, value) => updateVisibility(key, value)} />
              <p className="profile-edit-note">姓名修改会记录审计轨迹；登录身份、所在部门和历史审批中的姓名快照不会随之改变。</p>
            </div>
            <div className="profile-settings-actions"><Button className="primary-button" onClick={save} disabled={saving}>{saving ? "保存中…" : "保存个人设置"}</Button></div>
          </section>
        </div>
      )}
    </div>
  );
}

function CirculationPeoplePicker({ label, people, selected, onChange, loading }: { label: string; people: Person[]; selected: string[]; onChange: (ids: string[]) => void; loading: boolean }) {
  const [search, setSearch] = useState("");
  const filtered = people.filter((person) => `${person.fullName} ${person.email}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <fieldset className="circulation-picker"><legend>{label}<span>已选 {selected.length} 人</span></legend>
    <Input aria-label={`搜索${label}`} placeholder="搜索姓名或账号" value={search} onChange={(event) => setSearch(event.target.value)} />
    {selected.length > 0 && <div className="circulation-selected">{selected.map((id) => <button type="button" key={id} onClick={() => onChange(selected.filter((value) => value !== id))} aria-label={`移除${people.find((person) => person.id === id)?.fullName || "已失效成员"}`}>{people.find((person) => person.id === id)?.fullName || "已失效成员"}<X className="size-3.5" /></button>)}<button type="button" onClick={() => onChange([])}>清空</button></div>}
    <div className="circulation-options">{loading ? <p>正在加载成员…</p> : filtered.length ? filtered.map((person) => <label key={person.id}><input type="checkbox" checked={selected.includes(person.id)} onChange={(event) => onChange(event.target.checked ? [...selected, person.id] : selected.filter((id) => id !== person.id))} /><span><strong>{person.fullName}</strong><small>{person.email}</small></span></label>) : <p>{search ? "没有匹配的成员" : "暂无可选成员"}</p>}</div>
  </fieldset>;
}

function NewRequestDialog({ open, onOpenChange, onCreate, approvals, currentUser, currentRole, isAdmin, draft, onDraftConsumed }: { open: boolean; onOpenChange: (open: boolean) => void; onCreate: (approval: Approval) => Promise<boolean> | boolean | void; approvals: Approval[]; currentUser?: SessionInfo["user"]; currentRole?: string | null; isAdmin?: boolean; draft?: Approval | null; onDraftConsumed?: () => void }) {
  const [circulationContent, setCirculationContent] = useState("");
  const [circulationRecipients, setCirculationRecipients] = useState<string[]>([]);
  const [circulationApprovers, setCirculationApprovers] = useState<string[]>([]);
  const [formType, setFormType] = useState<ApprovalType>("技术审核");
  const [title, setTitle] = useState("");
  const [robotPart, setRobotPart] = useState("运动控制 / 关节系统");
  const [technicalContent, setTechnicalContent] = useState("");
  const [technicalTotalHours, setTechnicalTotalHours] = useState("");
  const [amount, setAmount] = useState("");
  const [itemSpec, setItemSpec] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [purpose, setPurpose] = useState("");
  const [supplier, setSupplier] = useState("");
  const [purchaserEmail, setPurchaserEmail] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  const [peopleLoaded, setPeopleLoaded] = useState(false);
  const [signer, setSigner] = useState("");
  const [confidentialScope, setConfidentialScope] = useState("代码、图纸、BOM、测试数据");
  const [developers, setDevelopers] = useState<Developer[]>([{ name: "", work: "", ratio: "100" }]);
  const [laborMonth, setLaborMonth] = useState(localMonthKey);
  const [laborSourceIds, setLaborSourceIds] = useState<string[]>([]);
  const [laborMonthlyHours, setLaborMonthlyHours] = useState("");
  const [laborStatement, setLaborStatement] = useState("");
  const [signatureDataUrl, setSignatureDataUrl] = useState("");
  const [signatureResetKey, setSignatureResetKey] = useState(0);
  const [ndaPreviewed, setNdaPreviewed] = useState(false);
  const [ndaAgreed, setNdaAgreed] = useState(false);
  const [reviewers, setReviewers] = useState<Reviewer[]>([]);
  const [reviewerEmail, setReviewerEmail] = useState("");
  const [reviewerLoading, setReviewerLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submitLockRef = useRef(false);
  const creationKeyRef = useRef("");
  const confidentialityKind = confidentialityAgreementKindForRole(currentRole || "member");
  const ndaDirectArchive = formType === "保密协议" && shouldAutoArchiveConfidentialityAgreement(confidentialityKind, Boolean(isAdmin));
  const requiredPermission: MemberPermission = formType === "保密协议" || formType === "劳务报酬" ? "project_owner" : "technical_advisor";
  const eligibleReviewers = useMemo(() => reviewers.filter((reviewer) => {
    if (reviewer.email.toLowerCase() === currentUser?.email?.toLowerCase()) return false;
    if (formType === "保密协议" && confidentialityKind === "project_owner") return reviewer.isAdmin;
    return reviewer.ndaCompleted && reviewer.permissions.includes(requiredPermission);
  }), [reviewers, requiredPermission, currentUser?.email, formType, confidentialityKind]);
  const eligiblePurchasers = useMemo(() => people.filter((person) => {
    const email = person.email.trim().toLowerCase();
    return email !== currentUser?.email?.trim().toLowerCase() && email !== reviewerEmail.trim().toLowerCase();
  }), [people, currentUser?.email, reviewerEmail]);
  const usedLaborSourceIds = useMemo(() => new Set(approvals.filter((approval) => approval.type === "劳务报酬" && approval.id !== draft?.id && approval.requesterEmail?.toLowerCase() === currentUser?.email?.toLowerCase() && approval.status !== "草稿" && approval.status !== "已作废").flatMap((approval) => Array.isArray(approval.payload?.sourceApprovalIds) ? approval.payload.sourceApprovalIds.filter((id): id is string => typeof id === "string") : [])), [approvals, currentUser?.email, draft?.id]);
  const laborSourceOptions = useMemo<TechnicalContribution[]>(() => approvals.filter((approval) => approval.type === "技术审核" && approval.status === "已归档" && !usedLaborSourceIds.has(approval.id)).flatMap((approval) => {
    const payload = approval.payload ?? {};
    const totalWorkHours = Number(payload.totalWorkHours);
    const developersInPayload = Array.isArray(payload.developers) ? payload.developers as Array<{ name?: unknown; email?: unknown; ratio?: unknown }> : [];
    const developer = developersInPayload.find((item) => typeof item.email === "string" && item.email.trim().toLowerCase() === currentUser?.email?.trim().toLowerCase()) || developersInPayload.find((item) => typeof item.name === "string" && item.name.trim() === currentUser?.displayName?.trim());
    const contributionRate = Number(developer?.ratio);
    if (!(totalWorkHours > 0) || !developer || !(contributionRate >= 0 && contributionRate <= 100)) return [];
    return [{ approval, totalWorkHours, contributionRate, weightedHours: Number((totalWorkHours * contributionRate / 100).toFixed(2)) }];
  }), [approvals, currentUser?.displayName, currentUser?.email, usedLaborSourceIds]);
  const laborScore = useMemo(() => laborSourceOptions.filter((source) => laborSourceIds.includes(source.approval.id)).reduce((sum, source) => sum + source.weightedHours, 0), [laborSourceIds, laborSourceOptions]);
  const laborTotalScore = laborScore + (Number(laborMonthlyHours) > 0 ? Number(laborMonthlyHours) : 0);
  const laborAlreadySubmitted = useMemo(() => approvals.some((approval) => approval.type === "劳务报酬" && approval.id !== draft?.id && approval.requesterEmail?.toLowerCase() === currentUser?.email?.toLowerCase() && approval.status !== "草稿" && approval.status !== "已作废" && approval.payload?.month === laborMonth), [approvals, currentUser?.email, draft?.id, laborMonth]);
  useEffect(() => {
    if (!open) return;
    creationKeyRef.current = "";
    let cancelled = false;
    setReviewerLoading(true);
    setPeopleLoaded(false);
    fetch("/api/reviewers", { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as { reviewers?: Reviewer[]; error?: string };
        if (!response.ok) throw new Error(data.error || "审核人列表加载失败");
        if (!cancelled) setReviewers(data.reviewers ?? []);
      })
      .catch((error: unknown) => {
        if (!cancelled) toast.error("审核人列表加载失败", { description: error instanceof Error ? error.message : "请稍后重试" });
      })
      .finally(() => { if (!cancelled) setReviewerLoading(false); });
    const peopleRequest = fetch("/api/people", { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" }).then(async (response) => {
      const data = await response.json() as { people?: Person[] };
      if (!response.ok) throw new Error("成员列表加载失败");
      if (!cancelled) setPeople((data.people ?? []).filter((person) => person.ndaCompleted));
    }).catch(() => {
      if (!cancelled) setPeople([]);
    }).finally(() => {
      if (!cancelled) setPeopleLoaded(true);
    });
    void peopleRequest;
    return () => { cancelled = true; };
  }, [open]);
  useEffect(() => {
    if (!open || reviewerLoading) return;
    if (!eligibleReviewers.some((reviewer) => reviewer.email === reviewerEmail)) setReviewerEmail(eligibleReviewers[0]?.email ?? "");
  }, [eligibleReviewers, open, reviewerEmail, reviewerLoading]);
  useEffect(() => {
    if (!open || !peopleLoaded) return;
    setPurchaserEmail((current) => {
      const normalizedCurrent = current.trim().toLowerCase();
      if (!normalizedCurrent || eligiblePurchasers.some((person) => person.email.trim().toLowerCase() === normalizedCurrent)) return current;
      return "";
    });
  }, [eligiblePurchasers, open, peopleLoaded]);
  useEffect(() => {
    setNdaPreviewed(false);
    setNdaAgreed(false);
  }, [signer, confidentialScope]);
  useEffect(() => {
    if (!currentUser?.displayName) return;
    setSigner((current) => current || currentUser.displayName);
  }, [currentUser?.displayName]);
  useEffect(() => {
    if (!open || !draft) return;
    const payload = draft.payload ?? {};
    const draftDevelopers = Array.isArray(payload.developers) ? payload.developers as Array<{ name?: unknown; email?: unknown; memberId?: unknown; work?: unknown; ratio?: unknown }> : [];
    setFormType(draft.type);
    setCirculationContent(typeof payload.circulationContent === "string" ? payload.circulationContent : "");
    setCirculationRecipients(circulationPeople(payload.circulationRecipients).map((person) => person.memberId));
    setCirculationApprovers(circulationPeople(payload.circulationApprovers).map((person) => person.memberId));
    setTitle(draft.title.replace(/草稿$/, "").trim());
    setRobotPart(typeof payload.robotPart === "string" ? payload.robotPart : "运动控制 / 关节系统");
    setTechnicalContent(typeof payload.technicalContent === "string" ? payload.technicalContent : "");
    setTechnicalTotalHours(payload.totalWorkHours ? String(payload.totalWorkHours) : "");
    setItemSpec(typeof payload.itemSpec === "string" ? payload.itemSpec : "");
    setQuantity(payload.quantity ? String(payload.quantity) : "1");
    setAmount(payload.amount ? String(payload.amount) : "");
    setPurpose(typeof payload.purpose === "string" ? payload.purpose : "");
    setSupplier(typeof payload.supplier === "string" ? payload.supplier : "");
    setPurchaserEmail(typeof payload.suggestedPurchaserEmail === "string" ? payload.suggestedPurchaserEmail : typeof payload.purchaserEmail === "string" ? payload.purchaserEmail : "");
    setSigner(typeof payload.signerName === "string" ? payload.signerName : currentUser?.displayName || "");
    setConfidentialScope(typeof payload.confidentialScope === "string" ? payload.confidentialScope : "代码、图纸、BOM、测试数据");
    const requiresFreshNdaSignature = draft.type === "保密协议" && (draft.status === "已退回" || draft.status === "已撤回");
    setSignatureDataUrl(requiresFreshNdaSignature ? "" : typeof payload.signatureDataUrl === "string" ? payload.signatureDataUrl : "");
    setNdaPreviewed(!requiresFreshNdaSignature && payload.previewed === true);
    setNdaAgreed(!requiresFreshNdaSignature && payload.agreed === true);
    if (requiresFreshNdaSignature) setSignatureResetKey((current) => current + 1);
    setDevelopers(draftDevelopers.length ? draftDevelopers.map((developer) => ({ name: typeof developer.name === "string" ? developer.name : "", email: typeof developer.email === "string" ? developer.email : "", memberId: typeof developer.memberId === "string" ? developer.memberId : "", work: typeof developer.work === "string" ? developer.work : "", ratio: developer.ratio === undefined ? "0" : String(developer.ratio) })) : [{ name: "", work: "", ratio: "100" }]);
    setLaborMonth(typeof payload.month === "string" ? payload.month : localMonthKey());
    setLaborSourceIds(Array.isArray(payload.sourceApprovalIds) ? payload.sourceApprovalIds.filter((id): id is string => typeof id === "string") : []);
    setLaborMonthlyHours(payload.monthlyWorkHours ? String(payload.monthlyWorkHours) : "");
    setLaborStatement(typeof payload.monthlyStatement === "string" ? payload.monthlyStatement : "");
    setReviewerEmail(typeof payload.initialReviewerEmail === "string" ? payload.initialReviewerEmail : draft.currentReviewerEmail || "");
  }, [open, draft, currentUser?.displayName]);
  const reset = () => { setCirculationContent(""); setCirculationRecipients([]); setCirculationApprovers([]); creationKeyRef.current = ""; setFormType("技术审核"); setTitle(""); setRobotPart("运动控制 / 关节系统"); setTechnicalContent(""); setTechnicalTotalHours(""); setAmount(""); setItemSpec(""); setQuantity("1"); setPurpose(""); setSupplier(""); setPurchaserEmail(""); setSigner(""); setConfidentialScope("代码、图纸、BOM、测试数据"); setDevelopers([{ name: "", work: "", ratio: "100" }]); setLaborMonth(localMonthKey()); setLaborSourceIds([]); setLaborMonthlyHours(""); setLaborStatement(""); setReviewerEmail(""); setSignatureDataUrl(""); setSignatureResetKey((current) => current + 1); setNdaPreviewed(false); setNdaAgreed(false); };
  const updateDeveloper = (index: number, key: keyof Developer, value: string) => setDevelopers((current) => current.map((developer, currentIndex) => currentIndex === index ? { ...developer, [key]: value } : developer));
  const selectDeveloper = (index: number, email: string) => {
    const normalizedEmail = email.trim().toLowerCase();
    if (normalizedEmail && developers.some((developer, currentIndex) => currentIndex !== index && developer.email?.trim().toLowerCase() === normalizedEmail)) {
      toast.error("同一开发人不能重复添加");
      return;
    }
    const person = people.find((candidate) => candidate.email.trim().toLowerCase() === normalizedEmail);
    setDevelopers((current) => current.map((developer, currentIndex) => currentIndex === index ? { ...developer, memberId: person?.id || "", email: person?.email || "", name: person?.fullName || "" } : developer));
  };
  const addDeveloper = () => setDevelopers((current) => [...current, { name: "", work: "", ratio: "0" }]);
  const submitRequest = async (isDraft: boolean) => {
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    setSubmitting(true);
    try {
    if (!isDraft && formType === "保密协议" && (!signatureDataUrl || !ndaPreviewed || !ndaAgreed)) {
      toast.error("请先完成签署并预览确认", { description: "需要手写签名、预览协议并勾选同意后才能提交。" });
      return;
    }
    if (!isDraft && formType === "技术审核") {
      const totalHours = Number(technicalTotalHours);
      const ratioTotal = developers.reduce((sum, developer) => sum + Number(developer.ratio), 0);
      const developerEmails = developers.map((developer) => developer.email?.trim().toLowerCase() || "");
      const activeEmails = new Set(people.map((person) => person.email.trim().toLowerCase()));
      if (!title.trim() || !technicalContent.trim()) { toast.error("请填写技术事项名称和技术内容与用途"); return; }
      if (!(totalHours > 0)) { toast.error("请填写技术事项总工作时间", { description: "总工作时间必须大于 0 小时。" }); return; }
      if (developers.some((developer) => !developer.memberId || !developer.email || !developer.name.trim() || !developer.work.trim())) { toast.error("请从已激活成员中选择每位开发人，并填写实际工作"); return; }
      if (developerEmails.some((email) => !activeEmails.has(email))) { toast.error("开发人必须是当前已激活成员", { description: "请重新选择成员后提交。" }); return; }
      if (new Set(developerEmails).size !== developerEmails.length) { toast.error("同一开发人不能重复添加"); return; }
      if (Math.abs(ratioTotal - 100) > 0.01) { toast.error("开发人贡献占比合计必须为 100%", { description: `当前合计为 ${ratioTotal.toFixed(2)}%。` }); return; }
    }
    if (!isDraft && formType === "劳务报酬") {
      if (!currentUser?.displayName) { toast.error("当前登录信息不完整，请刷新后重试"); return; }
      if (laborAlreadySubmitted) { toast.error("本月已提交过劳务报酬申请", { description: "每个自然月只能提交一份劳务报酬申请。" }); return; }
      if (!laborSourceIds.length) { toast.error("请至少选择一项已完成的技术成果"); return; }
      if (!laborMonthlyHours.trim() || Number(laborMonthlyHours) < 0) { toast.error("请填写本月其他工时", { description: "本月其他工时可以为 0，但不能小于 0；不要重复填写已选成果工时。" }); return; }
      if (laborStatement.trim().length < 10) { toast.error("请补充本月工作与贡献陈述", { description: "陈述至少需要 10 个字。" }); return; }
    }
    if (!isDraft && formType === "采购审核" && (!title.trim() || !itemSpec.trim() || !(Number(quantity) > 0) || !Number.isInteger(Number(quantity)) || !(Number(amount) >= 0) || !purpose.trim() || !supplier.trim())) {
      toast.error("请完整填写采购事项、规格、数量、用途、金额和供应商/购买链接");
      return;
    }
    if (!isDraft && formType === "流转审批") {
      if (!title.trim() || !circulationContent.trim()) { toast.error("请填写事项标题和内容"); return; }
      if (!circulationRecipients.length && !circulationApprovers.length) { toast.error("请至少选择流转对象或审批人"); return; }
      if ([...circulationRecipients, ...circulationApprovers].some((id) => !people.some((person) => person.id === id))) { toast.error("所选成员已失效，请重新选择"); return; }
    }
    const reviewer = eligibleReviewers.find((item) => item.email === reviewerEmail);
    if (!isDraft && formType !== "流转审批" && !ndaDirectArchive && !reviewer) {
      toast.error("请先选择审核人", { description: reviewerLoading ? "正在加载可选审核人，请稍候。" : "当前类型需要先指定有对应权限的成员。" });
      return;
    }
    const finalTitle = formType === "劳务报酬" ? `劳务报酬申请 · ${laborMonth}` : title.trim() || (formType === "采购审核" ? itemSpec || "采购申请" : formType === "保密协议" ? `${confidentialityAgreementTitle(confidentialityKind)} · ${signer || "待签署人"}` : formType === "流转审批" ? "流转审批事项" : "技术开发事项");
    const summary = formType === "流转审批" ? circulationContent.trim() || "待补充流转事项" : formType === "技术审核" ? `${robotPart}：${technicalContent || "待补充技术内容"}；总工时 ${Number(technicalTotalHours || 0)} 小时` : formType === "采购审核" ? `${itemSpec || "待补充物品"} × ${quantity || 1}；用途：${purpose || "待补充"}` : formType === "保密协议" ? `签署人：${signer || "待补充"}；接触范围：${confidentialScope}` : `${laborMonth}：已归档技术贡献折算 ${laborScore.toFixed(2)} 小时；本月其他工时 ${Number(laborMonthlyHours || 0).toFixed(2)} 小时；综合核算 ${laborTotalScore.toFixed(2)} 小时`;
    const reviewerLabel = ndaDirectArchive ? "系统自动归档" : reviewer ? `${reviewer.displayName}（${formType === "保密协议" && confidentialityKind === "project_owner" ? "OA 管理员" : requiredPermission === "project_owner" ? "项目负责人" : "技术顾问"}）` : "待指定审核人";
    const technicalPayload = formType === "技术审核" ? { totalWorkHours: Number(Number(technicalTotalHours || 0).toFixed(2)), robotPart, technicalContent: technicalContent.trim(), developers: developers.map((developer) => ({ name: developer.name.trim(), email: developer.email?.trim().toLowerCase() || "", memberId: developer.memberId || "", work: developer.work.trim(), ratio: Number(Number(developer.ratio || 0).toFixed(2)) })), developerConfirmations: [] } : undefined;
    const suggestedPurchaser = people.find((person) => person.email === purchaserEmail);
    const procurementPayload = formType === "采购审核" ? { itemSpec: itemSpec.trim(), quantity: Number(quantity || 0), amount: Number(Number(amount || 0).toFixed(2)), purpose: purpose.trim(), supplier: supplier.trim(), purchaseLink: supplier.trim().startsWith("http") ? supplier.trim() : "", suggestedPurchaserEmail: purchaserEmail, suggestedPurchaserName: suggestedPurchaser?.fullName || "", suggestedPurchaserMemberId: suggestedPurchaser?.id || "" } : undefined;
    const laborPayload = formType === "劳务报酬" ? { month: laborMonth, sourceApprovalIds: laborSourceIds, monthlyWorkHours: Number(Number(laborMonthlyHours || 0).toFixed(2)), otherMonthlyWorkHours: Number(Number(laborMonthlyHours || 0).toFixed(2)), monthlyWorkHoursDefinition: "不含已选技术成果工作时间的本月其他工时", monthlyStatement: laborStatement.trim(), archivedContributionHours: Number(laborScore.toFixed(2)), totalScore: Number(laborTotalScore.toFixed(2)), selectedSources: laborSourceOptions.filter((source) => laborSourceIds.includes(source.approval.id)).map((source) => ({ id: source.approval.id, title: source.approval.title, totalWorkHours: source.totalWorkHours, contributionRate: source.contributionRate, weightedHours: source.weightedHours })) } : undefined;
    if (!draft?.id && !creationKeyRef.current) creationKeyRef.current = crypto.randomUUID();
    const newApproval: Approval = {
      id: draft?.id || creationKeyRef.current,
      title: finalTitle,
      type: formType,
      project: projectName,
      requester: currentUser?.displayName || "成员",
      requesterEmail: currentUser?.email,
      createdAt: new Date().toISOString().slice(0, 10),
      updatedAt: "刚刚",
      status: isDraft ? "草稿" : ndaDirectArchive ? "已归档" : "待审核",
      step: isDraft ? "草稿" : formType === "流转审批" ? circulationRecipients.length ? "流转确认" : "指定审批" : ndaDirectArchive ? "已归档" : formType === "技术审核" ? "开发人确认" : formType === "采购审核" ? "技术顾问" : formType === "保密协议" ? confidentialityAgreementReviewerStep(confidentialityKind) : "项目负责人",
      currentReviewerName: isDraft || ndaDirectArchive ? undefined : formType === "技术审核" ? developers[0]?.name : reviewer?.displayName,
      currentReviewerEmail: isDraft || ndaDirectArchive ? undefined : formType === "技术审核" ? developers[0]?.email : reviewer?.email,
      reviewerEmail: reviewer?.email,
      payload: formType === "流转审批" ? { circulationContent: circulationContent.trim(), circulationRecipients, circulationApprovers } : formType === "保密协议" ? { agreementKind: confidentialityKind, agreementVersion: confidentialityAgreementVersion(confidentialityKind), signerName: signer.trim(), signerEmail: currentUser?.email, confidentialScope, signatureDataUrl, previewed: ndaPreviewed, agreed: ndaAgreed } : technicalPayload ?? procurementPayload ?? laborPayload,
      amount: formType === "采购审核" && amount ? `¥ ${Number(amount).toLocaleString("zh-CN")}` : undefined,
      summary,
      owner: formType === "保密协议" || formType === "劳务报酬" ? ndaDirectArchive ? confidentialityKind === "member" ? "系统自动归档" : "OA 管理员本人承诺" : reviewer?.displayName || "" : "",
      signers: formType === "技术审核"
        ? developers.filter((developer) => developer.name).map((developer) => `${developer.name}（开发人确认）`).concat([reviewerLabel, "待指定项目负责人（项目负责人）"])
        : formType === "采购审核"
          ? [reviewerLabel, "待指定项目负责人（项目负责人）"]
        : formType === "保密协议"
          ? ndaDirectArchive ? [`${signer || "待签署人"}（本人实名认证电子签）`, "系统自动归档"] : [`${signer || "待签署人"}（本人实名认证电子签）`, reviewerLabel, "系统归档"]
          : [`${currentUser?.displayName || "成员"}（月度工作与贡献陈述）`, `${reviewer?.displayName || "待指定项目负责人"}（项目负责人建议）`, "经费负责人（终审）", "系统归档"],
    };
    const saved = await onCreate(newApproval);
    if (saved === false) return;
    reset(); onDraftConsumed?.();
    } finally {
      submitLockRef.current = false;
      setSubmitting(false);
    }
  };
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void submitRequest(false); };
  return <Dialog open={open} onOpenChange={(nextOpen) => { if (!submitting) onOpenChange(nextOpen); }}><DialogContent className="request-dialog" aria-busy={submitting}><DialogHeader><div className="dialog-title-icon"><FilePenLine className="size-5" /></div><DialogTitle>新建审核申请</DialogTitle><DialogDescription>选择事项类型，填写核心信息后提交到对应审批节点。日期将自动生成。</DialogDescription></DialogHeader><form id="new-request-form" onSubmit={handleSubmit} className="request-form"><Tabs value={formType} onValueChange={(value) => setFormType(value as ApprovalType)}><TabsList className="request-type-tabs"><TabsTrigger value="技术审核"><ClipboardCheck className="size-4" />技术审核</TabsTrigger><TabsTrigger value="采购审核"><PackageCheck className="size-4" />采购审核</TabsTrigger><TabsTrigger value="劳务报酬"><CircleDollarSign className="size-4" />劳务报酬</TabsTrigger><TabsTrigger value="流转审批"><GitBranch className="size-4" />流转审批</TabsTrigger></TabsList><div className="form-project-note"><BriefcaseBusiness className="size-4" /><span>归属项目：<strong>{projectName}</strong></span></div>
    <TabsContent value="流转审批" className="form-content">
      <Field label="事项标题" required><Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} placeholder="填写需要流转或审批的事项" /></Field>
      <Field label="事项内容" required><Textarea value={circulationContent} onChange={(event) => setCirculationContent(event.target.value)} rows={5} maxLength={4000} placeholder="说明事项、需要对方处理的内容和相关材料链接" /></Field>
      <div className="form-callout blue"><GitBranch className="size-4" /><span>可只选流转对象、只选审批人，或两项都选。只流转：全部确认后归档；只审批：全部同意后归档；两项都选：流转确认完成后进入审批。</span></div>
      <div className="circulation-picker-grid"><CirculationPeoplePicker label="流转给谁（可多选）" people={people} selected={circulationRecipients} onChange={setCirculationRecipients} loading={!peopleLoaded} /><CirculationPeoplePicker label="给谁审批（可多选）" people={people.filter((person) => person.email.toLowerCase() !== currentUser?.email?.toLowerCase())} selected={circulationApprovers} onChange={setCirculationApprovers} loading={!peopleLoaded} /></div>
      <p className="reviewer-help">可选择所有已完成准入的在用 OA 成员，不限职务或部门。申请人不能审批自己的申请。</p>
    </TabsContent>
    <TabsContent value="技术审核" className="form-content"><Field label="技术事项名称" required><Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：D50W 关节驱动器 CAN 通信适配" /></Field><div className="form-grid-2"><Field label="用于机器人哪个部分" required><NativeSelect value={robotPart} onChange={(event) => setRobotPart(event.target.value)} className="w-full"><NativeSelectOption>运动控制 / 关节系统</NativeSelectOption><NativeSelectOption>定位与导航系统</NativeSelectOption><NativeSelectOption>感知与识别系统</NativeSelectOption><NativeSelectOption>机身结构与防护</NativeSelectOption><NativeSelectOption>测试验证与数据采集</NativeSelectOption></NativeSelect></Field><Field label="总工作时间（小时）" required><Input value={technicalTotalHours} onChange={(event) => setTechnicalTotalHours(event.target.value)} type="number" min="0.01" step="0.01" placeholder="例如：120" /></Field></div><Field label="技术内容与用途" required><Textarea value={technicalContent} onChange={(event) => setTechnicalContent(event.target.value)} placeholder="说明要开发或审核的技术，以及它在机器人系统中的具体用途。" rows={3} /></Field><div className="developer-head"><FieldLabel>开发人及贡献占比 <span>合计应为 100%</span></FieldLabel><button type="button" className="inline-add" onClick={addDeveloper} disabled={submitting}><Plus className="size-3.5" />添加开发人</button></div><div className="developer-list">{developers.map((developer, index) => { const selectedElsewhere = new Set(developers.filter((_, currentIndex) => currentIndex !== index).map((item) => item.email?.trim().toLowerCase()).filter(Boolean)); return <div className="developer-row" key={index}><NativeSelect value={developer.email || ""} onChange={(event) => selectDeveloper(index, event.target.value)} aria-label={`选择第 ${index + 1} 位开发人`}><NativeSelectOption value="">请选择开发人</NativeSelectOption>{developer.email && !people.some((person) => person.email === developer.email) && <NativeSelectOption value={developer.email} disabled>{developer.name || developer.email}（当前不可选）</NativeSelectOption>}{people.map((person) => <NativeSelectOption key={person.id || person.email} value={person.email} disabled={selectedElsewhere.has(person.email.trim().toLowerCase())}>{person.fullName} · {person.email}</NativeSelectOption>)}</NativeSelect><Input value={developer.work} onChange={(event) => updateDeveloper(index, "work", event.target.value)} placeholder="实际承担工作" /><div className="ratio-input"><Input value={developer.ratio} onChange={(event) => updateDeveloper(index, "ratio", event.target.value)} type="number" min="0" max="100" step="0.01" aria-label={`${developer.name || `第 ${index + 1} 位开发人`}贡献占比`} /><span>%</span></div>{developers.length > 1 && <button type="button" className="remove-row" onClick={() => setDevelopers((current) => current.filter((_, rowIndex) => rowIndex !== index))} aria-label={`移除${developer.name || `第 ${index + 1} 位开发人`}`}><X className="size-4" /></button>}</div>; })}</div><div className="developer-confirmation-preview">{developers.filter((developer) => developer.name).map((developer, index) => <div key={developer.email || `${developer.name}-${index}`}><BadgeCheck className="size-3.5" /><span><strong>{developer.name}</strong>提交后须使用本人账号逐一确认工作内容与贡献占比</span></div>)}</div><div className="form-callout blue"><Info className="size-4" /><span>只能选择当前已激活成员。同一成员不可重复；所有开发人逐一实名确认后，申请才会进入技术顾问审核。</span></div></TabsContent>
    <TabsContent value="采购审核" className="form-content"><Field label="采购事项名称" required><Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：D50W 关节驱动器样机采购" /></Field><div className="form-grid-2"><Field label="物品名称 / 型号规格" required><Input value={itemSpec} onChange={(event) => setItemSpec(event.target.value)} placeholder="名称、品牌、型号或关键规格" /></Field><Field label="数量" required><Input value={quantity} onChange={(event) => setQuantity(event.target.value)} type="number" min="1" /></Field></div><div className="form-grid-2"><Field label="预计金额（元）" required><Input value={amount} onChange={(event) => setAmount(event.target.value)} type="number" min="0" placeholder="0.00" /></Field><Field label="建议采购成员（可选）"><NativeSelect value={purchaserEmail} onChange={(event) => setPurchaserEmail(event.target.value)} className="w-full"><NativeSelectOption value="">暂不建议</NativeSelectOption>{eligiblePurchasers.map((person) => <NativeSelectOption key={person.email} value={person.email}>{person.fullName} · {person.email}</NativeSelectOption>)}</NativeSelect></Field></div><Field label="采购用途" required><Textarea value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder="用于哪个机器人版本、哪个测试环节，为什么需要采购。" rows={3} /></Field><Field label="购买链接 / 供应商" required><Input value={supplier} onChange={(event) => setSupplier(event.target.value)} placeholder="粘贴链接或填写供应商名称" /></Field><div className="form-callout amber"><Info className="size-4" /><span>申请人只能建议采购成员；技术顾问、项目负责人和最终采购人必须分别由不同实名账号担任。</span></div></TabsContent>
    <TabsContent value="保密协议" className="form-content"><Field label="签署人" required><Input value={signer} readOnly placeholder="当前登录成员姓名" /></Field><Field label="接触的未公开信息范围" required><Textarea value={confidentialScope} onChange={(event) => setConfidentialScope(event.target.value)} rows={3} /></Field><NdaAgreement kind={confidentialityKind} signer={signer} confidentialScope={confidentialScope} /><div className="signature-heading"><div><strong>本人手写电子签</strong><span>可用手指、触控笔或鼠标签名</span></div><FileSignature className="size-5" /></div><SignaturePad key={signatureResetKey} onChange={(signature) => { setSignatureDataUrl(signature); setNdaPreviewed(false); setNdaAgreed(false); }} /><div className="nda-preview-actions"><Button type="button" variant="outline" disabled={!signatureDataUrl} onClick={() => setNdaPreviewed(true)}><FileCheck2 className="size-4" />{ndaPreviewed ? "已预览文件" : "预览已签文件"}</Button>{ndaPreviewed && <span className="preview-confirmed"><Check className="size-3.5" />预览完成，请确认后提交</span>}</div>{ndaPreviewed && <div className="nda-signed-preview"><div className="nda-signed-preview-label"><FileCheck2 className="size-4" />签署后预览</div><NdaAgreement kind={confidentialityKind} signer={signer} confidentialScope={confidentialScope} signatureDataUrl={signatureDataUrl} /></div>}<label className="nda-consent"><input type="checkbox" checked={ndaAgreed} onChange={(event) => setNdaAgreed(event.target.checked)} disabled={!ndaPreviewed} /><span>我已阅读以上{confidentialityAgreementTitle(confidentialityKind)}正文，确认签名为本人手写，并同意按对应流程提交归档。</span></label><div className="form-callout purple"><ShieldCheck className="size-4" /><span>{ndaDirectArchive ? confidentialityKind === "member" ? "本人签署后立即生效并由系统自动归档；项目负责人可查阅，无需另行审核。" : "OA 管理员本人签署后由系统自动归档。" : "本人签署后提交 OA 管理员确认并归档。"}</span></div></TabsContent>
    <TabsContent value="劳务报酬" className="form-content"><Field label="报酬所属月份" required><Input value={laborMonth} onChange={(event) => setLaborMonth(event.target.value)} type="month" /></Field><div className="labor-source-heading"><FieldLabel>已归档技术成果与我的贡献</FieldLabel><span>折算公式：成果总工时 × 我的贡献率</span></div>{laborSourceOptions.length ? <div className="labor-source-list">{laborSourceOptions.map((source) => { const selected = laborSourceIds.includes(source.approval.id); return <label className={`labor-source-option ${selected ? "selected" : ""}`} key={source.approval.id}><input type="checkbox" checked={selected} onChange={() => setLaborSourceIds((current) => current.includes(source.approval.id) ? current.filter((id) => id !== source.approval.id) : [...current, source.approval.id])} /><span className="labor-source-copy"><strong>{source.approval.title}</strong><small>{source.approval.id} · 总工时 {source.totalWorkHours} 小时 · 你的贡献 {source.contributionRate}%</small><small>折算贡献：{source.weightedHours.toFixed(2)} 小时</small></span><Check className="labor-source-check size-4" /></label>; })}</div> : <div className="form-callout amber"><Info className="size-4" /><span>当前没有可申报的已归档技术成果。请先登记本人实际工作与贡献占比并完成归档；已在其他劳务申请中使用的成果不能重复选择。</span></div>}<div className="labor-score"><div><span>已选技术成果折算值</span><strong>{laborScore.toFixed(2)} 小时</strong></div><div className="labor-total-score"><span>加上本月其他工时后的综合核算</span><strong>{laborTotalScore.toFixed(2)} 小时</strong></div><small>本月其他工时不得包含上方已选成果的工时；系统提交时会依据正式归档记录重新核算。</small></div><Field label="本月其他工作时间（小时，不含已选成果工时）" required><Input value={laborMonthlyHours} onChange={(event) => setLaborMonthlyHours(event.target.value)} type="number" min="0" step="0.01" placeholder="没有其他工时可填 0" /></Field><Field label="本月工作与贡献陈述" required><Textarea value={laborStatement} onChange={(event) => setLaborStatement(event.target.value)} rows={5} placeholder="说明本月其他工作、已归档成果贡献、协作情况和下月计划；不要重复计算已选成果工时。" /></Field><div className="form-callout amber"><CircleDollarSign className="size-4" /><span>综合核算值用于形成申报依据，不自动等同劳务金额。项目负责人须填写建议金额及不少于 10 字的依据，系统自动显示折算单价；经费负责人终审后归档。</span></div></TabsContent>
   </Tabs></form>{formType !== "流转审批" && <ReviewerAssignment formType={formType} agreementKind={confidentialityKind} autoArchive={ndaDirectArchive} reviewers={eligibleReviewers} reviewerEmail={reviewerEmail} onReviewerChange={setReviewerEmail} loading={reviewerLoading} />}<DialogFooter className="request-footer" aria-busy={submitting}><Button type="button" variant="outline" onClick={() => void submitRequest(true)} disabled={submitting}><FilePenLine className="size-4" />{submitting ? "保存中…" : "保存草稿"}</Button><Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>取消</Button><Button type="submit" className="primary-button" form="new-request-form" disabled={submitting || (formType === "流转审批" ? !peopleLoaded || (!circulationRecipients.length && !circulationApprovers.length) : !ndaDirectArchive && (reviewerLoading || eligibleReviewers.length === 0 || !reviewerEmail))}><Send className="size-4" />{submitting ? "提交中…" : ndaDirectArchive && formType === "保密协议" ? "签署并归档" : "提交审核申请"}</Button></DialogFooter></DialogContent></Dialog>;
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) { return <label className="form-field"><FieldLabel>{label} {required && <span className="required-mark">*</span>}</FieldLabel>{children}</label>; }
function FieldLabel({ children }: { children: React.ReactNode }) { return <span className="field-label">{children}</span>; }

function ReviewerAssignment({ formType, agreementKind, autoArchive, reviewers, reviewerEmail, onReviewerChange, loading }: { formType: ApprovalType; agreementKind: ConfidentialityAgreementKind; autoArchive: boolean; reviewers: Reviewer[]; reviewerEmail: string; onReviewerChange: (email: string) => void; loading: boolean }) {
  if (formType === "保密协议" && autoArchive) return <div className="reviewer-assignment"><div className="form-callout purple"><ShieldCheck className="size-4" /><span>{agreementKind === "member" ? "成员本人完成实名手写签署后，系统将直接归档；项目负责人可查阅，不生成额外审核待办。" : "你是 OA 管理员。本人完成实名手写签署后，系统将直接归档《项目负责人保密承诺书》，不会生成本人审核本人的记录。"}</span></div></div>;
  const permission: MemberPermission = formType === "保密协议" || formType === "劳务报酬" ? "project_owner" : "technical_advisor";
  const eligibleReviewers = reviewers.filter((reviewer) => reviewer.permissions.includes(permission));
  const label = formType === "保密协议" && agreementKind === "project_owner" ? "OA 管理员" : permission === "project_owner" ? "项目负责人" : "首位技术顾问";
  return <div className="reviewer-assignment"><Field label={`选择${label}`} required><NativeSelect value={reviewerEmail} onChange={(event) => onReviewerChange(event.target.value)} disabled={loading || eligibleReviewers.length === 0} className="reviewer-select"><NativeSelectOption value="">{loading ? "正在加载可选审核人…" : eligibleReviewers.length ? `请选择${label}` : `暂无已授权的${label}`}</NativeSelectOption>{eligibleReviewers.map((reviewer) => <NativeSelectOption key={reviewer.email} value={reviewer.email}>{reviewer.displayName} · {reviewer.email}</NativeSelectOption>)}</NativeSelect></Field><p className="reviewer-help">{formType === "保密协议" ? "项目负责人本人签署后，由 OA 管理员确认并归档。" : formType === "劳务报酬" ? "劳务报酬先由所选项目负责人提出建议金额，再转交经费负责人终审并归档。" : "提交后先由所选审核人处理；通过时还需选择具体项目负责人，或直接退回补充材料。"}</p></div>;
}

function NdaAgreement({ kind, signer, confidentialScope, signatureDataUrl, agreementTextSnapshot, agreementVersion }: { kind: ConfidentialityAgreementKind; signer: string; confidentialScope: string; signatureDataUrl?: string; agreementTextSnapshot?: string; agreementVersion?: string }) {
  const displayedText = agreementTextSnapshot?.trim() || buildNdaAgreementText(
    signer.trim() || (kind === "project_owner" ? "待填写承诺人" : "待填写签署人"),
    confidentialScope.trim() || "待填写",
    kind,
  );
  const lines = displayedText.split("\n").filter(Boolean);
  const signatureLabel = kind === "project_owner" ? "承诺人手写签名" : "乙方手写签名";
  return <div className="nda-agreement"><div className="nda-agreement-head"><div><strong>{lines[0] || confidentialityAgreementTitle(kind)}</strong><span>{lines[1] || `${projectName} · ${kind === "project_owner" ? "项目负责人版" : "项目参与成员版"}`}</span></div><Badge variant="outline">{agreementVersion || (agreementTextSnapshot ? "签署快照" : "正式正文")}</Badge></div><div className="nda-agreement-body">{lines.slice(2).map((line, index) => <p key={`${index}-${line.slice(0, 16)}`}>{line}</p>)}{signatureDataUrl && <div className="nda-signature-preview"><div><span>{signatureLabel}</span><small>已完成电子签署</small></div><img src={signatureDataUrl} alt={signatureLabel} /></div>}</div></div>;
}

function SignaturePad({ onChange }: { onChange: (signatureDataUrl: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const pathLengthRef = useRef(0);
  const [hasSignature, setHasSignature] = useState(false);
  const getPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * (canvas.width / rect.width), y: (event.clientY - rect.top) * (canvas.height / rect.height) };
  };
  const startDrawing = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    const point = getPoint(event);
    context.beginPath();
    context.moveTo(point.x, point.y);
    lastPointRef.current = point;
    drawingRef.current = true;
  };
  const draw = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!drawingRef.current || !canvas || !context) return;
    event.preventDefault();
    const point = getPoint(event);
    const lastPoint = lastPointRef.current;
    if (lastPoint) pathLengthRef.current += Math.hypot(point.x - lastPoint.x, point.y - lastPoint.y);
    lastPointRef.current = point;
    context.lineTo(point.x, point.y);
    context.stroke();
  };
  const finishDrawing = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    lastPointRef.current = null;
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (pathLengthRef.current < 80) return;
    setHasSignature(true);
    onChange(canonicalizeSignaturePngDataUrl(canvas.toDataURL("image/png")));
  };
  const clear = () => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    pathLengthRef.current = 0;
    lastPointRef.current = null;
    setHasSignature(false);
    onChange("");
  };
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.lineWidth = 4;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "#29443f";
  }, []);
  return <div className="signature-pad"><div className="signature-canvas-wrap"><canvas ref={canvasRef} width={900} height={260} className="signature-canvas" aria-label="手写签名区域" onPointerDown={startDrawing} onPointerMove={draw} onPointerUp={finishDrawing} onPointerCancel={finishDrawing} /></div><div className="signature-pad-footer"><span>请用手指或鼠标在框内签名</span><button type="button" className="clear-signature" onClick={clear} disabled={!hasSignature}>清除重签</button></div></div>;
}

function NdaAdmissionGate({ session, onRefresh }: { session: SessionInfo; onRefresh: () => void }) {
  const [confidentialScope, setConfidentialScope] = useState("代码、图纸、BOM、测试数据、样机资料和客户资料");
  const [signatureDataUrl, setSignatureDataUrl] = useState("");
  const [signatureResetKey, setSignatureResetKey] = useState(0);
  const [previewed, setPreviewed] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [reviewers, setReviewers] = useState<Reviewer[]>([]);
  const [reviewerEmail, setReviewerEmail] = useState("");
  const [existingApproval, setExistingApproval] = useState<Approval | null>(null);
  const [hasHistoricalArchivedNda, setHasHistoricalArchivedNda] = useState(false);
  const [enteredNdaForm, setEnteredNdaForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [withdrawReason, setWithdrawReason] = useState("");
  const [withdrawing, setWithdrawing] = useState(false);
  const [ndaVoidConfirmed, setNdaVoidConfirmed] = useState(false);
  const [voidingNda, setVoidingNda] = useState(false);
  const submitLockRef = useRef(false);
  const creationKeyRef = useRef("");
  const signer = session.user?.displayName || "当前成员";
  const agreementKind = confidentialityAgreementKindForRole(session.role || "member");
  const isOwnerPledge = agreementKind === "project_owner";
  const ndaDirectArchive = shouldAutoArchiveConfidentialityAgreement(agreementKind, Boolean(session.isAdmin));
  const eligibleReviewers = reviewers.filter((reviewer) => reviewer.email.toLowerCase() !== session.user?.email?.toLowerCase()
    && (isOwnerPledge ? reviewer.isAdmin : reviewer.ndaCompleted && reviewer.permissions.includes("project_owner")));

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setLoadError("");
      setExistingApproval(null);
      setHasHistoricalArchivedNda(false);
      setReviewers([]);
      setReviewerEmail("");
      setSignatureDataUrl("");
      setSignatureResetKey((key) => key + 1);
      setPreviewed(false);
      setAgreed(false);
      creationKeyRef.current = "";
      try {
        const approvalsResponse = await fetch("/api/approvals", { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" });
        const approvalsData = await approvalsResponse.json() as { approvals?: Approval[]; error?: string };
        if (!approvalsResponse.ok) throw new Error(approvalsData.error || "保密协议状态加载失败");
        let reviewersData: { reviewers?: Reviewer[]; error?: string } = { reviewers: [] };
        if (!ndaDirectArchive) {
          const reviewersResponse = await fetch("/api/reviewers", { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" });
          reviewersData = await reviewersResponse.json() as { reviewers?: Reviewer[]; error?: string };
          if (!reviewersResponse.ok) throw new Error(reviewersData.error || (isOwnerPledge ? "OA 管理员列表加载失败" : "项目负责人列表加载失败"));
        }
        if (cancelled) return;
        const ndaApprovals = (approvalsData.approvals ?? []).filter((approval) => approval.type === "保密协议");
        const existing = selectCurrentNdaApproval(ndaApprovals, session.ndaApprovalId, agreementKind);
        const nextReviewers = (reviewersData.reviewers ?? []).filter((reviewer) => isOwnerPledge ? reviewer.isAdmin : reviewer.ndaCompleted && reviewer.permissions.includes("project_owner"));
        setExistingApproval(existing);
        setHasHistoricalArchivedNda(ndaApprovals.some((approval) => approval.status === "已归档"));
        setReviewers(nextReviewers);
        if (existing?.status === "已退回" || existing?.status === "已撤回") {
          const payload = existing.payload ?? {};
          if (typeof payload.confidentialScope === "string") setConfidentialScope(payload.confidentialScope);
          const previousReviewer = typeof payload.initialReviewerEmail === "string" ? payload.initialReviewerEmail : existing.reviewerEmail || existing.currentReviewerEmail || "";
          setReviewerEmail(nextReviewers.some((reviewer) => reviewer.email === previousReviewer) ? previousReviewer : nextReviewers[0]?.email || "");
        } else {
          setReviewerEmail(nextReviewers[0]?.email || "");
        }
      } catch (requestError) {
        if (!cancelled) setLoadError(requestError instanceof Error ? requestError.message : "保密协议状态加载失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [session, agreementKind, ndaDirectArchive, isOwnerPledge]);

  useEffect(() => {
    setPreviewed(false);
    setAgreed(false);
  }, [confidentialScope, signatureDataUrl]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitLockRef.current) return;
    if (!signatureDataUrl || !previewed || !agreed) { toast.error("请完成手写签名、协议预览与本人确认"); return; }
    const reviewer = eligibleReviewers.find((item) => item.email === reviewerEmail);
    if (!ndaDirectArchive && !reviewer) { toast.error("请选择 OA 管理员"); return; }
    submitLockRef.current = true;
    setSubmitting(true);
    try {
      if (!creationKeyRef.current) creationKeyRef.current = crypto.randomUUID();
      const reusableApproval = existingApproval && ["已退回", "已撤回"].includes(existingApproval.status) ? existingApproval : null;
      const id = reusableApproval?.id || creationKeyRef.current;
      const approval: Approval = {
        id,
        title: `${confidentialityAgreementTitle(agreementKind)} · ${signer}`,
        type: "保密协议",
        project: projectName,
        requester: signer,
        requesterEmail: session.user?.email,
        createdAt: reusableApproval?.createdAt || new Date().toISOString().slice(0, 10),
        updatedAt: "刚刚",
        status: ndaDirectArchive ? "已归档" : "待审核",
        step: ndaDirectArchive ? "已归档" : confidentialityAgreementReviewerStep(agreementKind),
        currentReviewerName: reviewer?.displayName,
        currentReviewerEmail: reviewer?.email,
        reviewerEmail: reviewer?.email,
        payload: { agreementKind, agreementVersion: confidentialityAgreementVersion(agreementKind), signerName: signer, signerEmail: session.user?.email, confidentialScope: confidentialScope.trim(), signatureDataUrl, previewed: true, agreed: true, initialReviewerEmail: reviewer?.email || "" },
        summary: `签署人：${signer}；接触范围：${confidentialScope.trim()}`,
        owner: ndaDirectArchive ? agreementKind === "member" ? "系统自动归档" : "OA 管理员本人承诺" : reviewer?.displayName || "",
        signers: ndaDirectArchive ? [`${signer}（本人实名认证电子签）`, "系统自动归档"] : [`${signer}（本人实名认证电子签）`, `${reviewer?.displayName || "待确认"}（OA 管理员）`, "系统归档"],
      };
      const response = await fetch("/api/approvals", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify(approval) });
      const data = await response.json() as { approval?: Approval; error?: string };
      if (!response.ok || !data.approval) throw new Error(data.error || "保密协议提交失败");
      setExistingApproval(data.approval);
      if (data.approval.status === "已归档") {
        toast.success(`${confidentialityAgreementTitle(agreementKind)}已签署并归档`);
        onRefresh();
      } else {
        toast.success(`${confidentialityAgreementTitle(agreementKind)}已提交`, { description: "等待 OA 管理员确认；通过前不会加载 OA 内部数据。" });
      }
    } catch (submitError) {
      toast.error("保密协议未提交", { description: submitError instanceof Error ? submitError.message : "请稍后重试" });
    } finally {
      submitLockRef.current = false;
      setSubmitting(false);
    }
  };

  const withdrawPendingNda = async () => {
    if (!existingApproval || withdrawReason.trim().length < 2 || withdrawing) return;
    setWithdrawing(true);
    try {
      const response = await fetch(`/api/approvals/${existingApproval.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ action: "withdraw", note: withdrawReason.trim() }) });
      const data = await response.json() as { approval?: Approval; error?: string };
      if (!response.ok || !data.approval) throw new Error(data.error || "保密文件撤回失败");
      setExistingApproval(data.approval);
      setWithdrawReason("");
      setSignatureDataUrl("");
      setSignatureResetKey((key) => key + 1);
      setPreviewed(false);
      setAgreed(false);
      toast.success("保密文件已撤回", { description: "原记录已保留，请修改后重新手写签署并提交。" });
    } catch (withdrawError) {
      toast.error("保密文件未撤回", { description: withdrawError instanceof Error ? withdrawError.message : "请稍后重试" });
    } finally {
      setWithdrawing(false);
    }
  };

  const voidWithdrawnNda = async () => {
    if (!existingApproval || existingApproval.status !== "已撤回" || withdrawReason.trim().length < 2 || !ndaVoidConfirmed || voidingNda) return;
    setVoidingNda(true);
    try {
      const response = await fetch(`/api/approvals/${existingApproval.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ action: "void", note: withdrawReason.trim() }) });
      const data = await response.json() as { approval?: Approval; error?: string };
      if (!response.ok || !data.approval) throw new Error(data.error || "保密文件作废失败");
      setExistingApproval(null);
      setWithdrawReason("");
      setNdaVoidConfirmed(false);
      creationKeyRef.current = "";
      toast.success("撤回记录已作废", { description: "原记录继续保留；如仍需准入，请重新填写并提交一份新保密文件。" });
    } catch (voidError) {
      toast.error("保密文件未作废", { description: voidError instanceof Error ? voidError.message : "请稍后重试" });
    } finally {
      setVoidingNda(false);
    }
  };

  const awaitingReview = existingApproval?.status === "待审核" || existingApproval?.status === "审批中";
  const currentMemberNdaInLegacyReview = Boolean(awaitingReview
    && agreementKind === "member"
    && existingApproval?.payload?.agreementVersion === confidentialityAgreementVersion("member"));
  const upgradingLegacyNda = hasHistoricalArchivedNda && !existingApproval;
  const showNdaTaskEntry = shouldHighlightNdaTaskEntry({
    hasCurrentApproval: Boolean(existingApproval),
    hasHistoricalArchivedNda,
    enteredNdaForm,
    loadFailed: Boolean(loadError),
  });
  const agreementTitle = confidentialityAgreementTitle(agreementKind);
  const reviewerLabel = isOwnerPledge ? "OA 管理员" : "项目负责人";
  if (loading) return <div className="registration-shell"><div className="registration-card nda-gate-card"><div className="registration-brand-lockup"><strong>{officialBrand}</strong><span>联合研发 OA</span></div><a className="oa-gate-guide-link" href="/guide"><BookOpen className="size-4" />项目章程与使用指南</a><p className="registration-intro">正在核对{agreementTitle}状态…</p></div></div>;
  if (currentMemberNdaInLegacyReview) return <div className="registration-shell"><div className="registration-card nda-gate-card"><div className="registration-brand-lockup"><strong>{officialBrand}</strong><span>联合研发 OA</span></div><a className="oa-gate-guide-link" href="/guide"><BookOpen className="size-4" />项目章程与使用指南</a><div className="eyebrow"><span className="eyebrow-line" />流程状态需修复</div><h1>这份保密协议不应等待审核</h1><p className="registration-intro">当前版本应在本人签署后由系统直接归档。为避免把新协议误送入旧审批流程，请先撤回该记录，再按当前正文重新手写签署。</p><div className="registration-notice"><AlertTriangle className="size-4" /><span>项目负责人不能代为确认这份异常记录。</span></div><div className="nda-withdraw-box"><strong>撤回后重新签署</strong><Textarea value={withdrawReason} onChange={(event) => setWithdrawReason(event.target.value)} rows={2} placeholder="填写至少 2 个字的撤回原因" disabled={withdrawing} /><Button type="button" variant="outline" className="return-button" disabled={withdrawing || withdrawReason.trim().length < 2} onClick={() => void withdrawPendingNda()}><RotateCcw className="size-4" />{withdrawing ? "撤回中…" : "撤回异常记录"}</Button><small>原记录和操作轨迹会保留；撤回后可重新签署并直接归档。</small></div></div></div>;
  if (awaitingReview) return <div className="registration-shell"><div className="registration-card nda-gate-card"><div className="registration-brand-lockup"><strong>{officialBrand}</strong><span>联合研发 OA</span></div><a className="oa-gate-guide-link" href="/guide"><BookOpen className="size-4" />项目章程与使用指南</a><div className="eyebrow"><span className="eyebrow-line" />等待{reviewerLabel}确认</div><h1>{agreementTitle}已提交</h1><p className="registration-intro">{reviewerLabel}确认并归档后，你才能进入内部工作区；等待期间系统不会加载审批、成员或聊天数据。</p><div className="registration-notice"><Clock3 className="size-4" /><span>当前账户：{accountIdentityLabel(session.user) || "已登录账户"}</span></div><Button type="button" className="primary-button registration-button" onClick={onRefresh}>刷新审核状态</Button><div className="nda-withdraw-box"><strong>提交后发现需要修改？</strong><Textarea value={withdrawReason} onChange={(event) => setWithdrawReason(event.target.value)} rows={2} placeholder="填写至少 2 个字的撤回原因" disabled={withdrawing} /><Button type="button" variant="outline" className="return-button" disabled={withdrawing || withdrawReason.trim().length < 2} onClick={() => void withdrawPendingNda()}><RotateCcw className="size-4" />{withdrawing ? "撤回中…" : "撤回并重新签署"}</Button><small>撤回会保留原记录和操作轨迹，不会进入内部工作区。</small></div></div></div>;
  if (showNdaTaskEntry) return <div className="registration-shell"><div className="registration-card nda-gate-card"><div className="registration-brand-lockup"><strong>{officialBrand}</strong><span>联合研发 OA</span></div><a className="oa-gate-guide-link" href="/guide"><BookOpen className="size-4" />项目章程与使用指南</a><div className="eyebrow"><span className="eyebrow-line" />{session.isAdmin ? "系统管理员待办" : isOwnerPledge ? "项目负责人待办" : "新成员待办"}</div><h1>完成{agreementTitle}后进入 OA</h1><p className="registration-intro">{session.isAdmin ? "你已具备系统管理员角色，必须先完成负责人专用承诺书。" : isOwnerPledge ? "你已具备项目负责人角色，必须先完成负责人专用承诺书。" : "成员注册已经审核通过。"} 请点击下面的高亮任务进入本人实名签署；归档前系统不会加载内部工作区数据。</p><div className="nda-taskbar" aria-label="待办任务"><div className="nda-taskbar-label"><span>待办任务</span><strong>1</strong></div><button type="button" className="nda-taskbar-item attention" onClick={() => setEnteredNdaForm(true)}><span className="nda-taskbar-icon"><ShieldCheck className="size-5" /></span><span className="nda-taskbar-copy"><strong>{isOwnerPledge ? "签署项目负责人保密承诺书" : "签署并归档保密协议"}</strong><small>点击进入本人实名签署</small></span><span className="nav-count nav-count-alert">1</span><ChevronRight className="size-4" /></button></div></div></div>;
  const isNdaRevision = existingApproval?.status === "已退回" || existingApproval?.status === "已撤回";
  return <div className="registration-shell nda-admission-shell"><div className="registration-card nda-admission-card"><div className="registration-brand-lockup"><strong>{officialBrand}</strong><span>联合研发 OA</span></div><a className="oa-gate-guide-link" href="/guide"><BookOpen className="size-4" />项目章程与使用指南</a><div className="eyebrow"><span className="eyebrow-line" />内部资料准入</div><h1>{isNdaRevision ? `修改并重新签署${agreementTitle}` : upgradingLegacyNda ? "角色要求已更新，请重新签署" : `先完成${agreementTitle}`}</h1><p className="registration-intro">在接触代码、图纸、BOM、测试数据、样机和客户资料前，须由本人实名手写签署。{ndaDirectArchive ? agreementKind === "member" ? "签署后立即生效并由系统自动归档，项目负责人可查阅。" : "签署后由系统自动归档。" : `签署后提交${reviewerLabel}确认。`} 归档前不会加载 OA 主工作区数据。</p>{upgradingLegacyNda && <div className="nda-returned-note"><RotateCcw className="size-4" /><span>{session.isAdmin ? "原成员保密协议仍保留；由于你已成为系统管理员，需另行签署《项目负责人保密承诺书》。" : isOwnerPledge ? "原成员保密协议仍保留；由于你已成为项目负责人，需另行签署《项目负责人保密承诺书》。" : "之前签署的协议仍保留在归档记录中；请阅读当前正文并重新手写签署。"}</span></div>}{isNdaRevision && <div className="nda-returned-note"><RotateCcw className="size-4" /><span>{existingApproval?.status === "已撤回" ? "文件已由你撤回，原记录已保留；请修改内容并重新手写签名。" : "上次文件已退回，请核对范围、重新手写签名并提交。"}</span></div>}{loadError && <div className="nda-gate-error" role="alert"><AlertTriangle className="size-4" /><span>{loadError}。为避免重复申请，暂时不能提交。</span></div>}<form className="nda-admission-form" onSubmit={submit} aria-busy={submitting}><Field label="签署人" required><Input value={signer} readOnly /></Field><Field label="当前认证身份" required><Input value={accountIdentityLabel(session.user)} readOnly /></Field><Field label="接触的未公开信息范围" required><Textarea value={confidentialScope} onChange={(event) => setConfidentialScope(event.target.value)} rows={3} disabled={submitting} /></Field><NdaAgreement kind={agreementKind} signer={signer} confidentialScope={confidentialScope} /><div className="signature-heading"><div><strong>本人手写电子签</strong><span>请由本人使用手指、触控笔或鼠标签名</span></div><FileSignature className="size-5" /></div><SignaturePad key={signatureResetKey} onChange={(signature) => setSignatureDataUrl(signature)} /><div className="nda-preview-actions"><Button type="button" variant="outline" disabled={!signatureDataUrl || submitting} onClick={() => setPreviewed(true)}><FileCheck2 className="size-4" />{previewed ? "已预览文件" : "预览已签文件"}</Button>{previewed && <button type="button" className="clear-signature" onClick={() => { setSignatureDataUrl(""); setSignatureResetKey((key) => key + 1); }}>重新签名</button>}</div>{previewed && <div className="nda-signed-preview"><div className="nda-signed-preview-label"><FileCheck2 className="size-4" />签署后预览</div><NdaAgreement kind={agreementKind} signer={signer} confidentialScope={confidentialScope} signatureDataUrl={signatureDataUrl} /></div>}<label className="nda-consent"><input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} disabled={!previewed || submitting} /><span>我已阅读{agreementTitle}正文，确认签名为本人手写，并同意按对应流程归档。</span></label>{!ndaDirectArchive && <Field label={`选择${reviewerLabel}`} required><NativeSelect value={reviewerEmail} onChange={(event) => setReviewerEmail(event.target.value)} disabled={submitting || eligibleReviewers.length === 0 || Boolean(loadError)}><NativeSelectOption value="">{eligibleReviewers.length ? `请选择${reviewerLabel}` : `暂无可选${reviewerLabel}`}</NativeSelectOption>{eligibleReviewers.map((reviewer) => <NativeSelectOption key={reviewer.email} value={reviewer.email}>{reviewer.displayName} · {reviewer.email}</NativeSelectOption>)}</NativeSelect></Field>}<Button type="submit" className="primary-button registration-button" disabled={submitting || Boolean(loadError) || !signatureDataUrl || !previewed || !agreed || (!ndaDirectArchive && !reviewerEmail)}>{submitting ? "正在提交…" : ndaDirectArchive ? `签署并归档${agreementTitle}` : isNdaRevision ? `重新提交${agreementTitle}` : `提交${agreementTitle}`}</Button>{existingApproval?.status === "已退回" && <div className="nda-withdraw-box"><strong>想终止这份退回记录？</strong><Textarea value={withdrawReason} onChange={(event) => setWithdrawReason(event.target.value)} rows={2} placeholder="先填写至少 2 个字的撤回原因" disabled={withdrawing} /><Button type="button" variant="outline" className="return-button" disabled={withdrawing || withdrawReason.trim().length < 2} onClick={() => void withdrawPendingNda()}><RotateCcw className="size-4" />{withdrawing ? "撤回中…" : "先撤回这份申请"}</Button><small>退回记录需先撤回，之后才可选择作废。</small></div>}{existingApproval?.status === "已撤回" && <div className="nda-withdraw-box nda-void-box"><strong>不再继续这份申请？</strong><Textarea value={withdrawReason} onChange={(event) => setWithdrawReason(event.target.value)} rows={2} placeholder="填写至少 2 个字的作废原因" disabled={voidingNda} /><label className="void-confirm"><input type="checkbox" checked={ndaVoidConfirmed} onChange={(event) => setNdaVoidConfirmed(event.target.checked)} /><span>我确认终止这份撤回记录；记录保留但不再流转。</span></label><Button type="button" className="danger-button" disabled={voidingNda || !ndaVoidConfirmed || withdrawReason.trim().length < 2} onClick={() => void voidWithdrawnNda()}><Trash2 className="size-4" />{voidingNda ? "作废中…" : "确认作废"}</Button></div>}</form></div></div>;
}

type FeishuQrLoginInstance = {
  matchOrigin(origin: string): boolean;
  matchData(data: unknown): boolean;
};

type FeishuQrLoginFactory = (options: {
  id: string;
  goto: string;
  width: string;
  height: string;
  style: string;
}) => FeishuQrLoginInstance;

declare global {
  interface Window {
    QRLogin?: FeishuQrLoginFactory;
  }
}

const FEISHU_QR_SDK_URL = "https://lf-package-cn.feishucdn.com/obj/feishu-static/lark/passport/qrcode/LarkSSOSDKWebQRCode-1.0.3.js";
let feishuQrSdkPromise: Promise<void> | null = null;

function loadFeishuQrSdk() {
  if (window.QRLogin) return Promise.resolve();
  if (feishuQrSdkPromise) return feishuQrSdkPromise;
  feishuQrSdkPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = FEISHU_QR_SDK_URL;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.addEventListener("load", () => window.QRLogin ? resolve() : reject(new Error("飞书二维码组件未就绪")), { once: true });
    script.addEventListener("error", () => reject(new Error("飞书二维码组件加载失败")), { once: true });
    document.head.appendChild(script);
  }).catch((error) => {
    feishuQrSdkPromise = null;
    throw error;
  });
  return feishuQrSdkPromise;
}

function FeishuQrLogin({ enabled }: { enabled: boolean }) {
  const reactId = useId();
  const containerId = useMemo(() => `feishu-qr-${reactId.replace(/[^A-Za-z0-9_-]/gu, "")}`, [reactId]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let removeMessageListener = () => {};
    const initialize = async () => {
      setStatus("loading");
      const response = await fetch("/api/auth/feishu/start?mode=qr", {
        method: "POST",
        headers: { accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      const payload = await response.json() as { authorizeUrl?: string; error?: string };
      if (!response.ok || !payload.authorizeUrl) throw new Error(payload.error || "二维码暂时无法生成");
      const authorizeUrl = new URL(payload.authorizeUrl);
      if (authorizeUrl.origin !== "https://passport.feishu.cn" || authorizeUrl.pathname !== "/suite/passport/oauth/authorize") {
        throw new Error("二维码授权地址无效");
      }
      await loadFeishuQrSdk();
      if (!active || !window.QRLogin) return;
      const container = document.getElementById(containerId);
      if (!container) throw new Error("二维码容器未就绪");
      container.replaceChildren();
      const qrLogin = window.QRLogin({
        id: containerId,
        goto: authorizeUrl.href,
      width: "260",
      height: "260",
      style: "width:260px;height:260px;border:0",
      });
      const handleMessage = (event: MessageEvent<unknown>) => {
        if (!qrLogin.matchOrigin(event.origin) || !qrLogin.matchData(event.data)) return;
        const data = event.data && typeof event.data === "object" && !Array.isArray(event.data)
          ? event.data as { tmp_code?: unknown }
          : {};
        const temporaryCode = typeof data.tmp_code === "string" ? data.tmp_code.trim() : "";
        if (!temporaryCode || temporaryCode.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(temporaryCode)) return;
        authorizeUrl.searchParams.set("tmp_code", temporaryCode);
        window.location.assign(authorizeUrl.href);
      };
      window.addEventListener("message", handleMessage, false);
      removeMessageListener = () => window.removeEventListener("message", handleMessage, false);
      setStatus("ready");
    };
    void initialize().catch(() => {
      if (active) setStatus("error");
    });
    return () => {
      active = false;
      removeMessageListener();
    };
  }, [containerId, enabled, retryKey]);

  if (!enabled) return <div className="login-provider-unavailable">飞书登录正在配置，请稍后再试。</div>;
  return (
    <div className="feishu-qr-login">
      <div className="feishu-qr-frame">
        <div id={containerId} className="feishu-qr-container" aria-label="飞书扫码登录二维码" />
        {status === "loading" && <div className="feishu-qr-state"><Clock3 className="size-4" />正在生成二维码…</div>}
        {status === "error" && <div className="feishu-qr-state error"><AlertTriangle className="size-4" />二维码加载失败<button type="button" onClick={() => setRetryKey((value) => value + 1)}>重新加载</button></div>}
      </div>
      <strong>源灵智能飞书</strong>
      <span>打开手机飞书，扫描并确认企业身份</span>
      <a className="feishu-current-device-login" href="/api/auth/feishu/start" target="_top">本机已登录飞书，直接继续 <ArrowUpRight className="size-3.5" /></a>
    </div>
  );
}

async function provisionCurrentFeishuMember(confirmation?: "none-of-these-accounts-is-mine") {
  const response = await fetch("/api/auth/feishu/provision", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ action: "provision-feishu-member", ...(confirmation ? { confirmation } : {}) }),
  });
  const result = await response.json() as { provisioned?: boolean; error?: string };
  if (!response.ok || result.provisioned !== true) throw new Error(result.error || "飞书成员开通失败");
  const sessionResponse = await fetch("/api/session", { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" });
  const nextSession = await sessionResponse.json() as SessionInfo;
  if (!sessionResponse.ok || !nextSession.registered) throw new Error(nextSession.error || "飞书登录结果暂时无法确认");
  return nextSession;
}

function RegistrationGate({ initialUser, initialStatus, chatgptLoginEnabled = true, githubLoginEnabled = false, feishuLoginEnabled = false, onRegistered }: { initialUser?: SessionInfo["user"]; initialStatus?: SessionInfo["status"]; chatgptLoginEnabled?: boolean; githubLoginEnabled?: boolean; feishuLoginEnabled?: boolean; onRegistered: (session: SessionInfo) => void }) {
  const [refreshing, setRefreshing] = useState(false);
  const [switchingAccount, setSwitchingAccount] = useState(false);
  const [bindingCandidates, setBindingCandidates] = useState<FeishuBindingCandidate[]>([]);
  const [bindingLookupState, setBindingLookupState] = useState<"idle" | "loading" | "ready" | "provisioning" | "error">("idle");
  const [bindingError, setBindingError] = useState("");
  const [bindingLookupKey, setBindingLookupKey] = useState(0);
  const [bindingCandidateId, setBindingCandidateId] = useState("");
  const [provisioning, setProvisioning] = useState(false);
  const providerLabel = authProviderLabel(initialUser?.authProvider);
  const alternativeProviders = [chatgptLoginEnabled ? "ChatGPT" : "", githubLoginEnabled ? "GitHub" : ""].filter(Boolean);
  const unboundFeishuLogin = initialUser?.authProvider === "feishu" && initialStatus === "unregistered";
  useEffect(() => {
    if (!unboundFeishuLogin) {
      setBindingCandidates([]);
      setBindingLookupState("idle");
      return;
    }
    let cancelled = false;
    setBindingLookupState("loading");
    setBindingError("");
    fetch("/api/auth/feishu/name-binding", { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as { candidates?: FeishuBindingCandidate[]; error?: string };
        if (!response.ok || !Array.isArray(data.candidates)) throw new Error(data.error || "同名账户查询失败");
        if (cancelled) return;
        setBindingCandidates(data.candidates);
        if (data.candidates.length) {
          setBindingLookupState("ready");
          return;
        }
        setBindingLookupState("provisioning");
        const nextSession = await provisionCurrentFeishuMember();
        if (cancelled) return;
        onRegistered(nextSession);
        toast.success("飞书登录成功", { description: "源灵智能企业成员身份已确认，无需填写注册资料。" });
      })
      .catch((lookupError: unknown) => {
        if (!cancelled) {
          setBindingLookupState("error");
          setBindingError(lookupError instanceof Error ? lookupError.message : "请稍后重试");
        }
      });
    return () => { cancelled = true; };
  }, [bindingLookupKey, unboundFeishuLogin, onRegistered]);
  const refreshLoginState = async () => {
    setRefreshing(true);
    try {
      const response = await fetch("/api/session", { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" });
      const data = await response.json() as SessionInfo;
      onRegistered(data);
      if (data.registered) toast.success("企业成员身份已确认");
      else if (data.user?.email) toast.info(`已识别 ${authProviderLabel(data.user.authProvider)} 登录`, { description: "请使用源灵智能飞书扫码进入。" });
      else toast.info("尚未识别到登录状态", { description: "请使用源灵智能飞书扫码。" });
    } catch { toast.error("登录状态刷新失败", { description: "请稍后重试。" }); }
    finally { setRefreshing(false); }
  };
  const switchLogin = async () => {
    setSwitchingAccount(true);
    try { await fetch("/api/session", { method: "DELETE", credentials: "same-origin" }); }
    finally { window.location.href = initialUser?.authProvider === "chatgpt" ? "/signout-with-chatgpt?return_to=%2F" : "/"; }
  };
  const bindFeishuCandidate = async (candidate: FeishuBindingCandidate) => {
    setBindingCandidateId(candidate.memberId);
    try {
      const response = await fetch("/api/auth/feishu/name-binding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ memberId: candidate.memberId, confirmation: "confirm-feishu-name-binding" }),
      });
      const result = await response.json() as { bound?: boolean; error?: string };
      if (!response.ok || result.bound !== true) throw new Error(result.error || "旧账户绑定失败");
      const sessionResponse = await fetch("/api/session", { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" });
      const nextSession = await sessionResponse.json() as SessionInfo;
      if (!sessionResponse.ok || !nextSession.registered) throw new Error(nextSession.error || "绑定结果暂时无法确认");
      onRegistered(nextSession);
      toast.success("已绑定原 OA 账户", { description: `${candidate.fullName} 的原数据、权限和历史审批已恢复。` });
    } catch (bindError: unknown) {
      toast.error("旧账户未绑定", { description: bindError instanceof Error ? bindError.message : "请稍后重试" });
      setBindingLookupKey((value) => value + 1);
    } finally {
      setBindingCandidateId("");
    }
  };
  const enterAsNewFeishuMember = async () => {
    setProvisioning(true);
    try {
      const nextSession = await provisionCurrentFeishuMember("none-of-these-accounts-is-mine");
      onRegistered(nextSession);
      toast.success("飞书登录成功", { description: "已按当前飞书企业身份进入 OA。" });
    } catch (error) {
      toast.error("飞书登录未完成", { description: error instanceof Error ? error.message : "请稍后重试" });
      setBindingLookupKey((value) => value + 1);
    } finally {
      setProvisioning(false);
    }
  };
  return (
    <div className="registration-shell">
      <div className="registration-card login-entry-card">
        <div className="registration-brand-lockup"><strong>{officialBrand}</strong><span>联合研发 OA</span></div>
        <div className="login-entry-heading"><h1>请登录账号</h1><p>使用源灵智能飞书扫码确认企业身份后即可进入 OA；登录并完成准入与保密签署后，才会显示实验室 AI 等内部功能。</p></div>
        <div className="oa-intro"><strong>OA 是做什么的？</strong><p>记录研发贡献、提交采购和劳务申请、签署保密协议，并查看审批进度。</p><a href="/guide"><BookOpen className="size-4" />第一次使用？先看使用指南</a></div>
        {unboundFeishuLogin ? (
          <><div className="registration-notice login-notice login-confirmed">
            <Check className="size-4" />
            <div className="login-notice-copy"><strong>已通过源灵智能飞书验证</strong><span>{initialUser?.displayName || "飞书成员"}</span></div>
            <button type="button" className="registration-login" onClick={switchLogin} disabled={switchingAccount}>{switchingAccount ? "正在退出…" : "更换登录账户"} <ArrowUpRight className="size-3.5" /></button>
          </div>
          {(bindingLookupState === "loading" || bindingLookupState === "provisioning") && <div className="feishu-name-match-state"><Clock3 className="size-4" />{bindingLookupState === "loading" ? "正在查找是否有同名原 OA 账户…" : "正在进入内部 OA…"}</div>}
          {bindingLookupState === "error" && <div className="feishu-name-match-state error"><AlertTriangle className="size-4" /><span>{bindingError || "暂时无法确认飞书成员身份。"}</span><button type="button" onClick={() => setBindingLookupKey((value) => value + 1)}>重新检查</button></div>}
          {bindingLookupState === "ready" && bindingCandidates.length > 0 && <div className="feishu-name-match"><div className="feishu-name-match-head"><BadgeCheck className="size-5" /><div><strong>找到姓名相同的原 OA 账户</strong><span>这是你的账户时确认绑定，即可恢复原数据；系统不会仅凭姓名自动合并。</span></div></div><div className="feishu-name-match-list">{bindingCandidates.map((candidate) => <div className="feishu-name-match-candidate" key={candidate.memberId}><div><strong>{candidate.fullName}</strong><span>{candidate.accountHint} · {candidate.department}</span></div><button type="button" onClick={() => void bindFeishuCandidate(candidate)} disabled={Boolean(bindingCandidateId) || provisioning}>{bindingCandidateId === candidate.memberId ? "正在绑定…" : "这是我的账户，确认绑定"}</button></div>)}</div><button type="button" className="feishu-name-match-skip" onClick={() => void enterAsNewFeishuMember()} disabled={Boolean(bindingCandidateId) || provisioning}>{provisioning ? "正在进入…" : "都不是我的，以当前飞书身份进入"}</button></div>}
          </>
        ) : (
          <div className="login-entry-panel">
            <FeishuQrLogin enabled={feishuLoginEnabled} />
            {alternativeProviders.length > 0 && (
              <details className="other-login-options">
                <summary>采用其他方式登录</summary>
                <div className="login-provider-actions">
                  {chatgptLoginEnabled && <a className="registration-login" href="/signin-with-chatgpt?return_to=%2F" target="_top">使用 ChatGPT 登录 <ArrowUpRight className="size-3.5" /></a>}
                  {githubLoginEnabled && <a className="registration-login github-login" href="/api/auth/github/start" target="_top"><GitBranch className="size-4" />使用 GitHub 登录</a>}
                </div>
                <small>其他方式仅用于进入已绑定的原 OA 账户；新成员请使用源灵智能飞书扫码。</small>
              </details>
            )}
            {initialUser?.email && <div className="feishu-name-match-state"><AlertTriangle className="size-4" />当前 {providerLabel} 账户尚未绑定企业成员，请改用飞书扫码。</div>}
            <button type="button" className="login-refresh" onClick={refreshLoginState} disabled={refreshing}>{refreshing ? "正在检查…" : "已扫码但未跳转？刷新状态"}</button>
          </div>
        )}
      </div>
    </div>
  );
}
function IdentityAccessGate({ session, onRefresh }: { session: SessionInfo; onRefresh: () => void }) {
  const missingPlatformIdentity = session.platformIdentityMissing;
  const externalLinkRequired = session.externalIdentityLinkRequired || session.githubIdentityLinkRequired || session.feishuIdentityLinkRequired;
  const fallbackProvider: AuthProvider | undefined = session.feishuIdentityLinkRequired ? "feishu" : session.githubIdentityLinkRequired ? "github" : undefined;
  const externalProvider = authProviderLabel(session.externalIdentityProvider || fallbackProvider);
  return <div className="registration-shell"><div className="registration-card"><div className="registration-brand-lockup"><strong>{officialBrand}</strong><span>联合研发 OA</span></div><a className="oa-gate-guide-link" href="/guide"><BookOpen className="size-4" />项目章程与使用指南</a><div className="eyebrow"><span className="eyebrow-line" />账户身份保护</div><h1>{externalLinkRequired ? "请先绑定已有成员账号" : missingPlatformIdentity ? "暂时无法确认登录身份" : "账户身份需要管理员核验"}</h1><p className="registration-intro">{externalLinkRequired ? `这个${externalProvider}身份尚未与已有 OA 成员绑定。为防止误合并账号，系统不会按姓名或邮箱自动开放原成员权限。` : missingPlatformIdentity ? "当前请求没有提供受支持的认证身份。为避免误认身份，系统不会开放业务数据。" : "当前登录身份与该邮箱原成员记录不一致。系统已停止加载原成员姓名、权限、保密协议状态和历史业务数据。"}</p><div className="registration-notice"><ShieldCheck className="size-4" /><span>{accountIdentityLabel(session.user)}</span></div>{externalLinkRequired && session.chatgptLoginEnabled && <a className="registration-login identity-link-login" href="/signin-with-chatgpt?return_to=%2F" target="_top">先用原 ChatGPT 账号登录 <ArrowUpRight className="size-3.5" /></a>}<Button type="button" className="primary-button registration-button" onClick={onRefresh}>重新检查登录身份</Button><p className="registration-intro">{externalLinkRequired ? session.chatgptLoginEnabled ? `已有成员必须先用原 ChatGPT 账号进入 OA，再到“个人设置”显式绑定${externalProvider}；绑定后原成员记录、权限和历史审批保持不变。` : "当前站点不能恢复旧 ChatGPT 登录，请联系 OA 管理员按成员 ID 完成人工核验；系统不会按姓名或邮箱迁移历史权限。" : "请联系 OA 管理员完成人工身份核验；系统不会自动迁移历史审批归属。"}</p></div></div>;
}

function PendingGate({ session, onRefresh }: { session: SessionInfo; onRefresh: () => void }) {
  const [switchingAccount, setSwitchingAccount] = useState(false);
  const [accountSwitchReady, setAccountSwitchReady] = useState(false);
  const isGitHubAccount = session.user?.authProvider === "github";
  const beginAccountSwitch = async () => {
    setSwitchingAccount(true);
    try {
      const response = await fetch("/api/session", { method: "DELETE", credentials: "same-origin" });
      if (!response.ok) throw new Error("当前 OA 会话未能退出");
      if (session.user?.authProvider === "chatgpt") {
        window.location.href = new URL("/signout-with-chatgpt?return_to=%2F", window.location.origin).href;
        return;
      }
      setAccountSwitchReady(true);
    } catch (error) {
      toast.error("暂时无法切换账户", { description: error instanceof Error ? error.message : "请稍后重试。" });
    } finally {
      setSwitchingAccount(false);
    }
  };

  if (accountSwitchReady) {
    return (
      <div className="registration-shell">
        <div className="registration-card">
          <div className="registration-brand-lockup"><strong>{officialBrand}</strong><span>联合研发 OA</span></div><a className="oa-gate-guide-link" href="/guide"><BookOpen className="size-4" />项目章程与使用指南</a>
          <div className="eyebrow"><span className="eyebrow-line" />切换登录账户</div>
          <h1>当前 OA 账户已退出</h1>
          <p className="registration-intro">请使用源灵智能飞书二维码登录。已绑定成员会自动进入原账户；企业新成员扫码验证后直接进入。</p>
          <FeishuQrLogin enabled={session.feishuLoginEnabled === true} />
          <details className="other-login-options account-switch-alternatives">
            <summary>采用其他方式登录</summary>
            <div className="login-provider-actions">
              {session.chatgptLoginEnabled && <a className="registration-login" href="/signin-with-chatgpt?return_to=%2F" target="_top">使用 ChatGPT 登录 <ArrowUpRight className="size-3.5" /></a>}
              {session.githubLoginEnabled && <a className="registration-login github-login" href="/api/auth/github/start" target="_top"><GitBranch className="size-4" />使用 GitHub 登录</a>}
            </div>
          </details>
          <small className="account-switch-help">切换登录方式不会删除原账户的注册、审核或业务记录。</small>
        </div>
      </div>
    );
  }

  return <div className="registration-shell"><div className="registration-card"><div className="registration-brand-lockup"><strong>{officialBrand}</strong><span>联合研发 OA</span></div><a className="oa-gate-guide-link" href="/guide"><BookOpen className="size-4" />项目章程与使用指南</a><div className="eyebrow"><span className="eyebrow-line" />人工审核中</div><h1>资料已提交</h1><p className="registration-intro">管理员正在核对你的姓名、学号/工号（如填写）和当前认证身份。审核通过后，刷新页面进入保密协议待办；协议归档后才能进入内部工作区。</p><div className="registration-notice"><Clock3 className="size-4" /><span>当前账户：{accountIdentityLabel(session.user)}</span></div><Button type="button" className="primary-button registration-button" onClick={onRefresh}>刷新审核状态</Button><Button type="button" variant="outline" className="account-switch-button" onClick={() => void beginAccountSwitch()} disabled={switchingAccount}><LogOut className="size-4" />{switchingAccount ? "正在退出当前账户…" : isGitHubAccount ? "切换 GitHub 账户登录" : "切换账户登录"}</Button><small className="account-switch-help">将先退出当前 OA 会话；当前账户的申请记录仍会保留。</small></div></div>;
}

function MembersView({ currentEmail }: { currentEmail?: string }) {
  const [rows, setRows] = useState<MemberAuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [permissionDrafts, setPermissionDrafts] = useState<Record<string, MemberPermission[]>>({});
  const [departmentDrafts, setDepartmentDrafts] = useState<Record<string, MemberDepartmentCode | "">>({});
  const [deleteTarget, setDeleteTarget] = useState<MemberAuditRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = () => {
    setLoading(true);
    setError("");
    fetch("/api/members", { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as { members?: MemberAuditRow[]; error?: string };
        if (!response.ok) throw new Error(data.error || "成员申请加载失败");
        const nextRows = data.members ?? [];
        setRows(nextRows);
        setPermissionDrafts(Object.fromEntries(nextRows.map((member) => [member.id, member.permissions ?? []])));
        setDepartmentDrafts(Object.fromEntries(nextRows.map((member) => [member.id, member.departmentCode || ""])));
      })
      .catch((requestError: unknown) => setError(requestError instanceof Error ? requestError.message : "成员申请加载失败"))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const togglePermission = (id: string, permission: MemberPermission) => setPermissionDrafts((current) => {
    const selected = current[id] ?? [];
    return { ...current, [id]: selected.includes(permission) ? selected.filter((item) => item !== permission) : [...selected, permission] };
  });

  const review = async (id: string, action: "approve" | "reject" | "update_permissions") => {
    if (action !== "reject" && !departmentDrafts[id]) {
      toast.error("请先选择成员部门");
      return;
    }
    const body = action === "reject" ? { action } : { action, permissions: permissionDrafts[id] ?? [], departmentCode: departmentDrafts[id] };
    const response = await fetch(`/api/members/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (response.ok) {
      toast.success(action === "approve" ? "成员已通过" : action === "reject" ? "成员已拒绝" : "成员设置已保存");
      load();
    } else {
      const data = await response.json() as { error?: string };
      toast.error(data.error || "处理失败");
    }
  };

  const memberSettingsChanged = (member: MemberAuditRow) => member.departmentCode !== (departmentDrafts[member.id] || "") || JSON.stringify(member.permissions ?? []) !== JSON.stringify(permissionDrafts[member.id] ?? []);
  const removeMember = async () => {
    const target = deleteTarget;
    if (!target || deleting) return;
    setDeleting(true);
    try {
      const response = await fetch(`/api/members/${target.id}`, { method: "DELETE", headers: { accept: "application/json" }, credentials: "same-origin" });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "删除成员失败");
      setDeleteTarget(null);
      toast.success("成员已停用", { description: `${target.fullName} 已移除协作成员目录和登录资格，历史审批记录仍保留。` });
      load();
    } catch (requestError) {
      toast.error("成员删除失败", { description: requestError instanceof Error ? requestError.message : "请稍后重试" });
    } finally {
      setDeleting(false);
    }
  };

  return <>
    <div className="members-view">
      <div className="page-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" />成员管理</div>
          <h1>成员审核</h1>
        <p>核对姓名、学号/工号和认证邮箱；成员注册只能由你这个 OA 管理员审核，同时设置成员部门、顾问和项目负责人权限。</p>
        </div>
        <Button variant="outline" onClick={load}>刷新列表</Button>
      </div>
      <div className="members-card">
        {loading ? <div className="loading-cell">正在加载成员申请…</div> : error ? <div className="empty-state"><ShieldCheck className="size-6" /><p>{error}</p></div> : rows.length === 0 ? <div className="empty-state"><UsersRound className="size-6" /><p>暂无成员注册申请</p></div> : <Table>
          <TableHeader><TableRow><TableHead>姓名</TableHead><TableHead>学号 / 工号</TableHead><TableHead>认证邮箱</TableHead><TableHead>部门与权限</TableHead><TableHead>状态</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
          <TableBody>{rows.map((member) => {
            const isCurrentUser = currentEmail?.trim().toLowerCase() === member.chatgptAccount.trim().toLowerCase();
            const canRemove = !isCurrentUser && (member.status === "active" || member.status === "rejected");
            return <TableRow key={member.id}>
              <TableCell className="font-semibold">{member.fullName}</TableCell>
              <TableCell>{member.identityNumber || "未填写"}</TableCell>
              <TableCell>{member.chatgptAccount}</TableCell>
              <TableCell><div className="member-attribute-options"><NativeSelect value={departmentDrafts[member.id] || ""} onChange={(event) => setDepartmentDrafts((current) => ({ ...current, [member.id]: event.target.value as MemberDepartmentCode | "" }))} aria-label={`设置${member.fullName}的部门`} className="w-full" disabled={isCurrentUser}><NativeSelectOption value="">请选择部门</NativeSelectOption>{MEMBER_DEPARTMENTS.map((department) => <NativeSelectOption key={department.code} value={department.code}>{department.label}</NativeSelectOption>)}</NativeSelect><div className="permission-options"><label className="permission-option"><input type="checkbox" checked={(permissionDrafts[member.id] ?? []).includes("technical_advisor")} onChange={() => togglePermission(member.id, "technical_advisor")} disabled={isCurrentUser} /><span>顾问</span></label><label className="permission-option"><input type="checkbox" checked={(permissionDrafts[member.id] ?? []).includes("project_owner")} onChange={() => togglePermission(member.id, "project_owner")} disabled={isCurrentUser} /><span>项目负责人</span></label></div></div></TableCell>
              <TableCell>{member.status === "pending" ? <StatusBadge status="待审核" /> : member.status === "active" ? <StatusBadge status="已通过" /> : member.status === "departed" ? <Badge variant="outline" className="status-badge status-archived"><span className="status-dot bg-[#7e8794]" />已停用</Badge> : <StatusBadge status="已退回" />}</TableCell>
              <TableCell className="text-right"><div className="member-actions">
                {member.status === "pending" && <><Button size="sm" className="primary-button" onClick={() => review(member.id, "approve")} disabled={isCurrentUser || !departmentDrafts[member.id]}>通过</Button><Button size="sm" variant="outline" onClick={() => review(member.id, "reject")} disabled={isCurrentUser}>拒绝</Button></>}
                {!isCurrentUser && member.status === "active" && memberSettingsChanged(member) && <Button size="sm" className="primary-button" onClick={() => review(member.id, "update_permissions")} disabled={!departmentDrafts[member.id]}>保存设置</Button>}
                {canRemove && <Button size="sm" variant="outline" className="delete-member-button" onClick={() => setDeleteTarget(member)}><Trash2 className="size-3.5" />删除</Button>}
              </div></TableCell>
            </TableRow>;
          })}</TableBody>
        </Table>}
      </div>
    </div>
    <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open && !deleting) setDeleteTarget(null); }}>
      <DialogContent className="member-delete-dialog">
        <DialogHeader>
          <div className="dialog-title-icon danger"><AlertTriangle className="size-5" /></div>
          <DialogTitle>删除成员</DialogTitle>
        <DialogDescription>此操作仅用于已经离职或退出项目的成员。</DialogDescription>
        </DialogHeader>
        {deleteTarget && <div className="member-delete-summary"><div><span>成员</span><strong>{deleteTarget.fullName}</strong></div><div><span>认证邮箱</span><strong>{deleteTarget.chatgptAccount}</strong></div><div><span>当前状态</span><strong>{deleteTarget.status === "active" ? "已通过" : "已退回"}</strong></div></div>}
        <div className="member-delete-warning"><AlertTriangle className="size-4" /><span>确认后将立即撤销该成员的登录资格并从协作成员中移除；历史审批记录和成员操作记录会保留。</span></div>
        <DialogFooter><Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>取消</Button><Button className="danger-button" onClick={removeMember} disabled={deleting}>{deleting ? "删除中…" : "确认删除"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}

function DetailSheet({ approval, events, open, loading, error, currentEmail, isAdmin, onOpenChange, onRetry, onApprove, onConfirmPurchase, onReturn, onForceReturn, onResubmit, onWithdraw, onVoid, onArchiveNote, onEditDraft }: { approval: Approval | null; events: ApprovalEvent[]; open: boolean; loading: boolean; error: string; currentEmail?: string; isAdmin?: boolean; onOpenChange: (open: boolean) => void; onRetry: () => void; onApprove: (nextReviewerEmail?: string, suggestedAmount?: string, finalAmount?: string, financeNote?: string, compensationBasis?: string, purchaserEmail?: string, circulationNote?: string) => void; onConfirmPurchase: (purchaseNote: string, actualAmount: string) => void; onReturn: (note: string) => void; onForceReturn: (note: string) => void; onResubmit: (note: string) => void; onWithdraw: (note: string) => void; onVoid: (note: string) => void; onArchiveNote: (noticeType: "correction" | "void", note: string) => Promise<boolean>; onEditDraft: () => void }) {
  const [nextReviewers, setNextReviewers] = useState<Reviewer[]>([]);
  const [nextReviewerEmail, setNextReviewerEmail] = useState("");
  const [suggestedAmount, setSuggestedAmount] = useState("");
  const [compensationBasis, setCompensationBasis] = useState("");
  const [finalAmount, setFinalAmount] = useState("");
  const [financeNote, setFinanceNote] = useState("");
  const [purchaseNote, setPurchaseNote] = useState("");
  const [actualAmount, setActualAmount] = useState("");
  const [purchasePeople, setPurchasePeople] = useState<Person[]>([]);
  const [selectedPurchaserEmail, setSelectedPurchaserEmail] = useState("");
  const [purchasePeopleLoading, setPurchasePeopleLoading] = useState(false);
  const [actionNote, setActionNote] = useState("");
  const [lifecycleNote, setLifecycleNote] = useState("");
  const [archiveNoticeType, setArchiveNoticeType] = useState<"correction" | "void">("correction");
  const [voidConfirmed, setVoidConfirmed] = useState(false);
  const needsNextReviewer = approval?.step === "技术顾问";
  const isLaborRecommendation = approval?.type === "劳务报酬" && approval.step === "项目负责人";
  const isFinanceApproval = approval?.type === "劳务报酬" && approval.step === "经费负责人";
  const isPurchaseConfirmation = approval?.type === "采购审核" && approval.step === "统一采购";
  const needsPurchaserAssignment = approval?.type === "采购审核" && approval.step === "项目负责人";
  const isRequester = Boolean(approval && currentEmail && approval.requesterEmail?.toLowerCase() === currentEmail.toLowerCase());
  const purchaseApprovalId = approval?.id || "";
  const purchaseRequesterEmail = approval?.requesterEmail || "";
  const purchaseOwnerEmail = approval?.currentReviewerEmail || currentEmail || "";
  const purchaseInitialReviewerEmail = typeof approval?.payload?.initialReviewerEmail === "string" ? approval.payload.initialReviewerEmail : "";
  const purchaseSuggestedEmail = typeof approval?.payload?.suggestedPurchaserEmail === "string" ? approval.payload.suggestedPurchaserEmail : typeof approval?.payload?.purchaserEmail === "string" ? approval.payload.purchaserEmail : "";
  useEffect(() => {
    if (!open || !needsNextReviewer) {
      setNextReviewers([]);
      setNextReviewerEmail("");
      return;
    }
    let cancelled = false;
    fetch("/api/reviewers", { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as { reviewers?: Reviewer[]; error?: string };
        if (!response.ok) throw new Error(data.error || "项目负责人列表加载失败");
        const excluded = new Set([
          currentEmail?.trim().toLowerCase(),
          approval?.requesterEmail?.trim().toLowerCase(),
          ...(Array.isArray(approval?.payload?.developers) ? approval.payload.developers.flatMap((developer) => developer && typeof developer === "object" && !Array.isArray(developer) && typeof (developer as { email?: unknown }).email === "string" ? [(developer as { email: string }).email.trim().toLowerCase()] : []) : []),
        ].filter((email): email is string => Boolean(email)));
        const eligible = (data.reviewers ?? []).filter((reviewer) => reviewer.ndaCompleted && reviewer.permissions.includes("project_owner") && !excluded.has(reviewer.email.trim().toLowerCase()));
        if (!cancelled) {
          setNextReviewers(eligible);
          setNextReviewerEmail((current) => eligible.some((reviewer) => reviewer.email === current) ? current : eligible[0]?.email ?? "");
        }
      })
      .catch((error: unknown) => { if (!cancelled) toast.error("下一位审核人加载失败", { description: error instanceof Error ? error.message : "请稍后重试" }); });
    return () => { cancelled = true; };
  }, [open, needsNextReviewer, currentEmail, approval]);
  useEffect(() => {
    setSuggestedAmount("");
    setCompensationBasis("");
    setFinalAmount("");
    setFinanceNote("");
    setPurchaseNote("");
    setActualAmount("");
    setSelectedPurchaserEmail("");
    setActionNote("");
    setLifecycleNote("");
    setArchiveNoticeType("correction");
    setVoidConfirmed(false);
  }, [approval?.id, approval?.step]);
  useEffect(() => {
    if (!open || !needsPurchaserAssignment) {
      setPurchasePeople([]);
      setSelectedPurchaserEmail("");
      setPurchasePeopleLoading(false);
      return;
    }
    let cancelled = false;
    setPurchasePeople([]);
    setPurchasePeopleLoading(true);
    fetch("/api/people", { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as { people?: Person[]; error?: string };
        if (!response.ok) throw new Error(data.error || "采购成员列表加载失败");
        if (cancelled) return;
        const excluded = new Set([purchaseRequesterEmail, purchaseOwnerEmail, purchaseInitialReviewerEmail].map((email) => email.trim().toLowerCase()).filter(Boolean));
        const nextPeople = (data.people ?? []).filter((person) => person.ndaCompleted && !excluded.has(person.email.trim().toLowerCase()));
        setPurchasePeople(nextPeople);
        setSelectedPurchaserEmail((current) => {
          const currentMatch = nextPeople.find((person) => person.email.trim().toLowerCase() === current.trim().toLowerCase());
          if (currentMatch) return currentMatch.email;
          const suggestedMatch = nextPeople.find((person) => person.email.trim().toLowerCase() === purchaseSuggestedEmail.trim().toLowerCase());
          return suggestedMatch?.email || nextPeople[0]?.email || "";
        });
      })
      .catch((requestError: unknown) => {
        if (!cancelled) {
          setPurchasePeople([]);
          setSelectedPurchaserEmail("");
          toast.error("采购成员列表加载失败", { description: requestError instanceof Error ? requestError.message : "请稍后重试" });
        }
      })
      .finally(() => { if (!cancelled) setPurchasePeopleLoading(false); });
    return () => { cancelled = true; };
  }, [open, needsPurchaserAssignment, purchaseApprovalId, purchaseRequesterEmail, purchaseOwnerEmail, purchaseInitialReviewerEmail, purchaseSuggestedEmail]);
  if (!approval) return <Sheet open={open} onOpenChange={onOpenChange}>
    <SheetContent side="right" className="detail-sheet">
      <SheetHeader className="detail-header"><SheetTitle>{loading ? "正在加载申请详情" : "申请详情暂不可用"}</SheetTitle><SheetDescription>{loading ? "正在读取完整正文、签署证据与审批轨迹。" : "未展示任何裁剪记录或替代正文。"}</SheetDescription></SheetHeader>
      <div className="detail-scroll"><div className="empty-state" role={error ? "alert" : "status"}>{loading ? <><Clock3 className="size-6" /><p>正在安全加载完整申请详情…</p></> : <><AlertTriangle className="size-6" /><p>{error || "申请详情加载失败，请重试。"}</p><Button type="button" variant="outline" onClick={onRetry}><RotateCcw className="size-4" />重新加载</Button></>}</div></div>
      <SheetFooter className="detail-footer"><Button variant="outline" className="w-full" onClick={() => onOpenChange(false)}>关闭详情</Button></SheetFooter>
    </SheetContent>
  </Sheet>;
  const isDone = approval.status === "已通过" || approval.status === "已归档";
  const isDraft = approval.status === "草稿";
  const isReturned = approval.status === "已退回";
  const isWithdrawn = approval.status === "已撤回";
  const isVoided = approval.status === "已作废";
  const isAssigned = Boolean(currentEmail && (approval.type === "流转审批" ? circulationPendingForEmail(approval.payload ?? {}, approval.step, currentEmail) : approval.currentReviewerEmail?.toLowerCase() === currentEmail.toLowerCase()));
  const ndaPayload = approval.type === "保密协议" ? approval.payload : undefined;
  const ndaAgreementKind = confidentialityAgreementKindFromPayload(ndaPayload) || "member";
  const ndaAutoArchived = ndaPayload?.autoArchived === true;
  const ndaRequiresApplicantResign = isStrandedCurrentMemberNda(approval);
  const ndaSigner = typeof ndaPayload?.signerName === "string" ? ndaPayload.signerName : approval.requester;
  const ndaScope = typeof ndaPayload?.confidentialScope === "string" ? ndaPayload.confidentialScope : "";
  const ndaSignature = typeof ndaPayload?.signatureDataUrl === "string" ? ndaPayload.signatureDataUrl : undefined;
  const ndaAgreementTextSnapshot = typeof ndaPayload?.agreementTextSnapshot === "string" && ndaPayload.agreementTextSnapshot.trim()
    ? ndaPayload.agreementTextSnapshot
    : "";
  const technicalPayload = approval.type === "技术审核" ? approval.payload : undefined;
  const technicalDevelopers = Array.isArray(technicalPayload?.developers) ? technicalPayload.developers as Array<{ memberId?: unknown; email?: unknown; name?: unknown; work?: unknown; ratio?: unknown }> : [];
  const developerConfirmations = Array.isArray(technicalPayload?.developerConfirmations) ? technicalPayload.developerConfirmations as Array<{ memberId?: unknown; email?: unknown; name?: unknown; confirmedAt?: unknown }> : [];
  const isCurrentDeveloper = technicalDevelopers.some((developer) => typeof developer.email === "string" && developer.email.trim().toLowerCase() === currentEmail?.trim().toLowerCase());
  const canAct = !ndaRequiresApplicantResign && !isDone && !isDraft && !isReturned && !isWithdrawn && !isVoided && (approval.step === "开发人确认" ? isAssigned && isCurrentDeveloper : isAssigned);
  const canWithdraw = isRequester && ["待审核", "审批中", "已退回"].includes(approval.status);
  const canVoid = isRequester && (isDraft || isWithdrawn);
  const canAddArchiveNote = isRequester && approval.status === "已归档";
  const procurementPayload = approval.type === "采购审核" ? approval.payload : undefined;
  const laborPayload = approval.type === "劳务报酬" ? approval.payload : undefined;
  const laborSources = Array.isArray(laborPayload?.selectedSources) ? laborPayload.selectedSources as Array<{ id?: unknown; title?: unknown; totalWorkHours?: unknown; contributionRate?: unknown; weightedHours?: unknown }> : [];
  const timelineSteps = approval.type === "流转审批" ? [...(circulationPeople(approval.payload?.circulationRecipients).length ? ["流转确认"] : []), ...(circulationPeople(approval.payload?.circulationApprovers).length ? ["指定审批"] : []), "系统归档"] : approval.type === "技术审核" ? ["开发人确认", "技术顾问", "项目负责人"] : approval.type === "采购审核" ? ["技术顾问", "项目负责人", "统一采购"] : approval.type === "保密协议" ? ndaAutoArchived || ndaRequiresApplicantResign ? ["本人签署", "系统自动归档"] : ndaAgreementKind === "project_owner" ? ["本人签署", "OA管理员", "系统归档"] : ["本人签署", "项目负责人", "系统归档"] : ["项目负责人", "经费负责人", "系统归档"];
  const currentIndex = timelineSteps.indexOf(approval.step);
  const completedCount = isDone ? timelineSteps.length : currentIndex < 0 ? 0 : currentIndex;
  const suggestedAmountValue = numericAmount(laborPayload?.suggestedAmount ?? approval.amount);
  const laborTotalValue = Number(laborPayload?.totalScore || 0);
  const suggestedUnitRate = suggestedAmount && laborTotalValue > 0 ? numericAmount(suggestedAmount) / laborTotalValue : Number(laborPayload?.unitRate || 0);
  const finalAmountDiffers = isFinanceApproval && Boolean(finalAmount.trim()) && Math.abs(numericAmount(finalAmount) - suggestedAmountValue) > 0.005;
  const approvedPurchaseAmount = numericAmount(procurementPayload?.amount ?? approval.amount);
  const actualPurchaseAmount = numericAmount(actualAmount);
  const purchaseAmountTooHigh = isPurchaseConfirmation && Boolean(actualAmount.trim()) && actualPurchaseAmount > approvedPurchaseAmount + 0.005;
  const sendApprove = () => onApprove(needsNextReviewer ? nextReviewerEmail : undefined, isLaborRecommendation ? suggestedAmount : undefined, isFinanceApproval ? finalAmount : undefined, isFinanceApproval ? financeNote : undefined, isLaborRecommendation ? compensationBasis : undefined, needsPurchaserAssignment ? selectedPurchaserEmail : undefined, approval.type === "流转审批" ? actionNote.trim() : undefined);
  return <Sheet open={open} onOpenChange={onOpenChange}>
    <SheetContent side="right" className="detail-sheet print-source">
      <SheetHeader className="detail-header"><div className="detail-topline"><TypeBadge type={approval.type} /><span className="detail-id">{approval.id}</span></div><SheetTitle>{approval.title}</SheetTitle><SheetDescription>{approval.project}</SheetDescription></SheetHeader>
      <div className="detail-scroll">
        <div className="detail-status-row"><StatusBadge status={approval.status} /><span>更新于 {approval.updatedAt}</span></div>
        <div className="detail-record-meta"><div><span>申请人</span><strong>{approval.requester}</strong><small>{approval.requesterEmail || "未记录账户"}</small></div><div><span>创建时间</span><strong>{approval.createdAt}</strong><small>最后更新：{approval.updatedAt}</small></div><div><span>实名签署人</span><strong>{approval.signers.length ? approval.signers.join("、") : "尚无"}</strong><small>实名邮箱与精确时间见审批轨迹</small></div>{approval.archiveHash && <div className="detail-record-hashes"><span>脱敏归档记录 SHA-256 · Schema v{approval.archiveSchemaVersion || 1}</span><code>{approval.archiveHash}</code>{approval.terminalRevisionNo && <><span>终局材料版本 · 第 {approval.terminalRevisionNo} 版</span>{approval.terminalRevisionHash && <code>{approval.terminalRevisionHash}</code>}{approval.terminalStateHash && <><span>终局材料 SHA-256</span><code>{approval.terminalStateHash}</code></>}</>}{approval.archiveContentHash && <><span>归档文件 SHA-256</span><code>{approval.archiveContentHash}</code></>}{approval.evidenceRecordHash && <><span>受限原始证据记录 SHA-256</span><code>{approval.evidenceRecordHash}</code></>}</div>}</div>
        {approval.currentReviewerName && <div className="detail-assignee"><span>当前处理人</span><strong>{approval.currentReviewerName}</strong>{approval.currentReviewerEmail && <small>{approval.currentReviewerEmail}</small>}</div>}
        <div className="detail-summary">{approval.summary}</div>
        {approval.amount && <div className="detail-amount"><span>{approval.type === "劳务报酬" ? "当前劳务报酬金额" : "预计金额"}</span><strong>{approval.amount}</strong></div>}
        {approval.type === "采购审核" && procurementPayload && <div className="detail-section"><div className="detail-section-title"><PackageCheck className="size-4" />采购明细</div><div className="detail-procurement-grid"><div><span>物品 / 规格</span><strong>{String(procurementPayload.itemSpec || "未填写")}</strong></div><div><span>数量</span><strong>{String(procurementPayload.quantity || "未填写")}</strong></div><div><span>{procurementPayload.purchaserEmail ? "最终指定采购人" : "建议采购人"}</span><strong>{String(procurementPayload.purchaserName || procurementPayload.suggestedPurchaserName || "未建议")}</strong></div><div><span>供应商 / 链接</span><strong>{String(procurementPayload.supplier || procurementPayload.purchaseLink || "未填写")}</strong></div>{(procurementPayload.actualAmount !== undefined || approval.actualAmount !== undefined) && <div><span>实际采购金额</span><strong>¥ {numericAmount(procurementPayload.actualAmount ?? approval.actualAmount).toLocaleString("zh-CN")}</strong></div>}{(typeof procurementPayload.purchaseNote === "string" || approval.purchaseNote) && <div><span>实际采购说明</span><strong>{typeof procurementPayload.purchaseNote === "string" ? procurementPayload.purchaseNote : approval.purchaseNote}</strong></div>}</div></div>}
        {approval.type === "技术审核" && technicalDevelopers.length > 0 && <div className="detail-section technical-contribution-detail"><div className="detail-section-title"><ClipboardCheck className="size-4" />技术工时、贡献与实名确认</div><div className="technical-hours-summary"><span>总工作时间</span><strong>{Number(technicalPayload?.totalWorkHours || 0).toFixed(2)} 小时</strong></div><div className="technical-contribution-list developer-confirmation-list">{technicalDevelopers.map((developer, index) => { const confirmation = developerConfirmations.find((item) => (typeof developer.memberId === "string" && developer.memberId && item.memberId === developer.memberId) || (typeof developer.email === "string" && typeof item.email === "string" && item.email.toLowerCase() === developer.email.toLowerCase())); const confirmedAt = typeof confirmation?.confirmedAt === "string" ? confirmation.confirmedAt : ""; return <div key={`${String(developer.memberId || developer.email || developer.name)}-${index}`}><span>{typeof developer.name === "string" ? developer.name : "未命名成员"}</span><small>{typeof developer.work === "string" ? developer.work : "未填写实际工作"}</small><b>{Number(developer.ratio || 0).toFixed(2)}%</b><em className={confirmedAt ? "confirmed" : "pending"}>{confirmedAt ? `已实名确认 · ${formatChatTimestamp(confirmedAt)}` : approval.status === "草稿" ? "提交后待本人确认" : "待本人实名确认"}</em></div>; })}</div></div>}
        {approval.type === "劳务报酬" && laborPayload && <div className="detail-section labor-calculation-detail"><div className="detail-section-title"><CircleDollarSign className="size-4" />劳务报酬核算依据</div><div className="labor-calculation-hero"><span>已归档技术贡献折算值</span><strong>{Number(laborPayload.archivedContributionHours || 0).toFixed(2)} 小时</strong></div><div className="technical-contribution-list">{laborSources.map((source, index) => <div key={`${String(source.id)}-${index}`}><span>{typeof source.title === "string" ? source.title : "技术成果"}</span><small>总工时 {Number(source.totalWorkHours || 0).toFixed(2)} h × 贡献 {Number(source.contributionRate || 0).toFixed(2)}%</small><b>{Number(source.weightedHours || 0).toFixed(2)} h</b></div>)}</div><div className="labor-monthly-summary"><span>本月其他工时（不含已选成果）</span><strong>{Number(laborPayload.otherMonthlyWorkHours ?? laborPayload.otherWorkHours ?? laborPayload.monthlyWorkHours ?? 0).toFixed(2)} 小时</strong><span className="labor-total-inline">综合核算 {Number(laborPayload.totalScore || 0).toFixed(2)} 小时</span><p>{typeof laborPayload.monthlyStatement === "string" ? laborPayload.monthlyStatement : "未填写本月陈述"}</p></div>{typeof laborPayload.compensationBasis === "string" && <div className="labor-compensation-record"><span>项目负责人金额依据</span><p>{laborPayload.compensationBasis}</p>{Number(laborPayload.unitRate || 0) > 0 && <strong>自动折算单价：¥ {Number(laborPayload.unitRate).toFixed(2)} / 核算小时</strong>}</div>}{typeof laborPayload.financeNote === "string" && laborPayload.financeNote && <div className="labor-compensation-record"><span>经费终审意见</span><p>{laborPayload.financeNote}</p></div>}</div>}
        {approval.type === "保密协议" && <div className="detail-section detail-nda"><div className="detail-section-title"><FileCheck2 className="size-4" />{confidentialityAgreementTitle(ndaAgreementKind)}正文与签名</div>{ndaPayload && ndaAgreementTextSnapshot ? <NdaAgreement kind={ndaAgreementKind} signer={ndaSigner} confidentialScope={ndaScope} signatureDataUrl={ndaSignature} agreementTextSnapshot={ndaAgreementTextSnapshot} agreementVersion={typeof ndaPayload.agreementVersion === "string" ? ndaPayload.agreementVersion : undefined} /> : <div className="detail-nda-empty">该记录缺少已签署正文快照，已停止预览；请联系 OA 管理员核验原始证据。</div>}</div>}
        <div className="detail-section"><div className="detail-section-title"><Clock3 className="size-4" />审批轨迹</div><div className="timeline">{timelineSteps.map((step, index) => <div className={`timeline-item ${index < completedCount ? "done" : index === currentIndex && !isDone ? "current" : ""}`} key={step}><div className="timeline-mark">{index < completedCount ? <Check className="size-3" /> : index === currentIndex && !isDone ? <span /> : null}</div><div><div className="timeline-label">{step}</div><div className="timeline-detail">{index < completedCount ? "已完成" : index === currentIndex && !isDone ? "当前节点" : "未开始"}</div></div></div>)}</div>{events.length > 0 && <div className="approval-event-list">{events.map((event) => <div className="approval-event" key={event.id}><div><strong>{event.action}</strong><span>{event.actorName} · {event.actorEmail}</span></div><small>{event.createdAt}</small>{event.note && <p>{event.note}</p>}</div>)}</div>}</div>
        <div className="detail-section"><div className="detail-section-title"><FileCheck2 className="size-4" />必要资料</div><div className="detail-doc-list"><div><span className="doc-check"><Check className="size-3" /></span>审核主表</div><div><span className={`doc-check ${approval.type === "采购审核" ? "pending" : ""}`}>{approval.type === "采购审核" ? <Clock3 className="size-3" /> : <Check className="size-3" />}</span>{approval.type === "采购审核" ? "采购清单附录（待核对）" : "项目资料与责任人记录"}</div><div><span className="doc-check muted"><Archive className="size-3" /></span>电子签署证据与归档记录</div></div></div>
        <div className="detail-section detail-policy"><div className="detail-section-title"><Info className="size-4" />执行提示</div><p>{approval.type === "采购审核" ? "实际金额超过批准金额，或清单内容发生变化时，必须重新提交并完成两层签字。" : approval.type === "技术审核" ? "开发人确认不属于审批层级；技术顾问通过后选择项目负责人，完成两层审核后技术成果才可归档。" : approval.type === "劳务报酬" ? "劳务报酬按月提交，技术成果贡献折算、本月工时和陈述均保留在申请中；经费负责人完成终审后归档。" : ndaRequiresApplicantResign ? "这份当前版成员协议异常停留在旧审核节点，负责人不能审核或退回。请由签署人撤回并重新手写签署，系统随后直接归档；管理员仅可在流程无法继续时强制退回。" : ndaAutoArchived ? ndaAgreementKind === "project_owner" ? "OA 管理员本人完成实名手写签署后由系统自动归档；这是一方承诺的归档，不属于本人审核本人。" : "成员本人完成实名手写签署后协议立即生效并由系统自动归档；无需项目负责人审核，但项目负责人可以查阅。" : ndaAgreementKind === "project_owner" ? "项目负责人完成实名手写签署后，由 OA 管理员确认并归档；已归档版本不可覆盖。" : "这是旧流程保留记录：本人签署后由项目负责人审核并归档；已归档版本不可覆盖。"}</p></div>
        {needsNextReviewer && canAct && <div className="transfer-box"><div className="transfer-title"><Send className="size-4" />通过后转交项目负责人</div><NativeSelect value={nextReviewerEmail} onChange={(event) => setNextReviewerEmail(event.target.value)} disabled={nextReviewers.length === 0} className="reviewer-select"><NativeSelectOption value="">{nextReviewers.length ? "请选择项目负责人" : "暂无可独立签署的项目负责人"}</NativeSelectOption>{nextReviewers.map((reviewer) => <NativeSelectOption key={reviewer.email} value={reviewer.email}>{reviewer.displayName} · {reviewer.email}</NativeSelectOption>)}</NativeSelect><p>项目负责人必须与申请人、技术顾问和技术开发人使用不同实名账号；如需补充材料，请填写意见并点击“退回补充”。</p></div>}
        {needsPurchaserAssignment && canAct && <div className="transfer-box purchase-assignment-box"><div className="transfer-title"><PackageCheck className="size-4" />项目负责人指定采购成员</div><NativeSelect value={selectedPurchaserEmail} onChange={(event) => setSelectedPurchaserEmail(event.target.value)} disabled={purchasePeopleLoading || purchasePeople.length === 0} className="reviewer-select"><NativeSelectOption value="">{purchasePeopleLoading ? "正在加载已激活成员…" : purchasePeople.length ? "请选择采购成员" : "暂无可独立执行的采购成员"}</NativeSelectOption>{purchasePeople.map((person) => <NativeSelectOption key={person.id || person.email} value={person.email}>{person.fullName} · {person.email}</NativeSelectOption>)}</NativeSelect><p>最终采购人必须与申请人、技术顾问和项目负责人使用不同实名账号；通过后由其本人确认采购结果。</p></div>}
        {isLaborRecommendation && canAct && <div className="transfer-box labor-recommendation-box"><div className="transfer-title"><CircleDollarSign className="size-4" />项目负责人建议劳务报酬</div><Field label="建议金额（元）" required><Input value={suggestedAmount} onChange={(event) => setSuggestedAmount(event.target.value)} type="number" min="0.01" step="0.01" placeholder="请输入建议金额" /></Field><Field label="金额依据（至少 10 个字）" required><Textarea value={compensationBasis} onChange={(event) => setCompensationBasis(event.target.value)} rows={3} placeholder="结合技术贡献、其他工作、交付质量和协作情况说明建议金额依据。" /></Field><div className="unit-rate-preview"><span>系统自动折算单价</span><strong>{suggestedUnitRate > 0 ? `¥ ${suggestedUnitRate.toFixed(2)} / 核算小时` : "填写建议金额后显示"}</strong></div><p>折算单价仅用于复核金额依据，不代表预设或固定劳务单价。提交后申请会转交经费负责人。</p></div>}
        {isFinanceApproval && canAct && <div className="transfer-box labor-recommendation-box"><div className="transfer-title"><CircleDollarSign className="size-4" />经费负责人最终审核</div>{suggestedAmountValue > 0 && <div className="unit-rate-preview"><span>项目负责人建议金额</span><strong>¥ {suggestedAmountValue.toLocaleString("zh-CN")}</strong></div>}<Field label="最终审核金额（元）" required><Input value={finalAmount} onChange={(event) => setFinalAmount(event.target.value)} type="number" min="0.01" step="0.01" placeholder="请输入最终审核金额" /></Field><Field label={finalAmountDiffers ? "金额调整意见（必填）" : "经费审核意见（可选）"}><Textarea value={financeNote} onChange={(event) => setFinanceNote(event.target.value)} rows={3} placeholder={finalAmountDiffers ? "最终金额与建议金额不同，请说明调整原因。" : "可补充经费审核意见。"} /></Field>{finalAmountDiffers && !financeNote.trim() && <div className="amount-difference-warning"><AlertTriangle className="size-4" />最终金额与建议金额不同，必须填写调整意见。</div>}<p>最终金额和审核意见会随劳务报酬申请一并归档。</p></div>}
        {isPurchaseConfirmation && canAct && <div className="transfer-box purchase-confirmation-box"><div className="transfer-title"><PackageCheck className="size-4" />指定采购成员确认</div><Field label="实际采购说明（至少 5 个字）" required><Textarea value={purchaseNote} onChange={(event) => setPurchaseNote(event.target.value)} rows={3} placeholder="说明实际购买内容、供应商及采购完成情况。" /></Field><Field label="实际采购金额（元）" required><Input value={actualAmount} onChange={(event) => setActualAmount(event.target.value)} type="number" min="0" max={approvedPurchaseAmount} step="0.01" placeholder={`不得高于批准金额 ¥ ${approvedPurchaseAmount.toLocaleString("zh-CN")}`} /></Field>{purchaseAmountTooHigh && <div className="amount-difference-warning"><AlertTriangle className="size-4" />实际金额超过批准金额，不能直接归档；请填写退回意见并重新走审批。</div>}<p>实际金额可为 0，但不得高于批准预计金额。仅指定采购成员可确认；确认后本申请正式归档。</p></div>}
        {approval.type === "流转审批" && <div className="detail-section"><div className="detail-section-title"><GitBranch className="size-4" />流转与审批</div><p className="circulation-content">{String(approval.payload?.circulationContent || approval.summary)}</p>{[{ key: "circulationRecipients", decisions: "circulationConfirmations", title: "流转对象", done: "已确认" }, { key: "circulationApprovers", decisions: "circulationApprovals", title: "审批人", done: "已同意" }].map((group) => <div className="circulation-progress" key={group.key}><strong>{group.title}</strong>{circulationPeople(approval.payload?.[group.key]).length ? circulationPeople(approval.payload?.[group.key]).map((person) => { const done = circulationPeople(approval.payload?.[group.decisions]).some((decision) => decision.memberId === person.memberId && decision.accountUserId === person.accountUserId); return <div key={person.memberId}><span>{person.name}</span><Badge variant="outline">{done ? group.done : group.key === "circulationApprovers" && approval.step === "流转确认" ? "等待流转完成" : "待处理"}</Badge></div>; }) : <p>未选择，跳过此环节</p>}</div>)}</div>}
        <div className="detail-section archive-actions-section"><div className="detail-section-title"><Archive className="size-4" />PDF 与飞书归档</div><p className="archive-actions-help">{approval.archiveIntegrityError || (approval.status === "已归档" ? "系统已生成包含审批正文、签署证据、完整流转记录和校验值的正式 PDF，并按“年份 / 月份 / 文件类型”自动保存到公司飞书云空间。" : "可随时下载当前审批版本的 PDF；完成全部审核并归档后，系统会生成带完整校验值的正式 PDF，并自动保存到公司飞书云空间。")}</p>{approval.archiveIntegrityError && <div className="amount-difference-warning" role="alert"><AlertTriangle className="size-4" />正文和签署记录未被隐藏；管理员核验完成后即可恢复 PDF。</div>}<div className="detail-footer-actions">{approval.archiveIntegrityError ? <Button type="button" variant="outline" className="print-approval-button" disabled><AlertTriangle className="size-4" />正式 PDF 暂不可用</Button> : <Button asChild variant="outline" className="print-approval-button"><a href={`/api/approvals/${encodeURIComponent(approval.id)}/pdf`}><Download className="size-4" />{approval.status === "已归档" ? "下载正式 PDF" : "下载当前版本 PDF"}</a></Button>}{approval.status === "已归档" && !approval.archiveIntegrityError && <span className={`archive-upload-status ${approval.feishuPdfArchive?.status || "pending"}`}>{approval.feishuPdfArchive?.status === "uploaded" ? "飞书已保存" : approval.feishuPdfArchive?.status === "failed" ? "飞书保存待重试" : "正在保存到飞书"}</span>}</div>{approval.feishuPdfArchive?.fileName && <small className="archive-file-name">{approval.feishuPdfArchive.fileName}</small>}</div>
        {canAddArchiveNote && <div className="detail-section applicant-lifecycle-panel archive-notice-panel"><div className="detail-section-title"><FilePenLine className="size-4" />追加归档说明</div><p>已归档记录不能直接作废或覆盖。这里仅追加“更正说明”或“废止说明”，原正文、签字、版本和历史归档文件保持不变。</p><NativeSelect value={archiveNoticeType} onChange={(event) => setArchiveNoticeType(event.target.value as "correction" | "void")}><NativeSelectOption value="correction">更正说明</NativeSelectOption><NativeSelectOption value="void">废止说明</NativeSelectOption></NativeSelect><Textarea value={lifecycleNote} onChange={(event) => setLifecycleNote(event.target.value)} rows={4} placeholder="填写至少 10 个字，说明需要更正或废止的内容、原因及处理依据" /><Button type="button" variant="outline" disabled={lifecycleNote.trim().length < 10} onClick={() => { const submittedNote = lifecycleNote.trim(); void onArchiveNote(archiveNoticeType, submittedNote).then((saved) => { if (saved) setLifecycleNote(""); }); }}><FilePenLine className="size-4" />追加{archiveNoticeType === "correction" ? "更正" : "废止"}说明</Button></div>}
        {canWithdraw && <div className="detail-section applicant-lifecycle-panel"><div className="detail-section-title"><RotateCcw className="size-4" />申请人撤回</div><p>撤回后记录和已发生的流转轨迹都会保留；你可以修改后重新提交。劳务申请的月份和成果占用在作废前继续保留。</p><Textarea value={lifecycleNote} onChange={(event) => setLifecycleNote(event.target.value)} rows={3} placeholder="填写至少 2 个字的撤回原因" /><Button type="button" variant="outline" className="return-button" disabled={lifecycleNote.trim().length < 2} onClick={() => onWithdraw(lifecycleNote.trim())}><RotateCcw className="size-4" />撤回申请</Button></div>}
        {canVoid && <div className="detail-section applicant-lifecycle-panel void-panel"><div className="detail-section-title"><Trash2 className="size-4" />终止并作废</div><p>作废后记录仍会保留，但不再流转，也不能恢复或直接重新提交。劳务占用会在作废成功后释放。</p><Textarea value={lifecycleNote} onChange={(event) => setLifecycleNote(event.target.value)} rows={3} placeholder="填写至少 2 个字的作废原因" /><label className="void-confirm"><input type="checkbox" checked={voidConfirmed} onChange={(event) => setVoidConfirmed(event.target.checked)} /><span>我确认终止这份申请，并保留其历史记录。</span></label><Button type="button" className="danger-button" disabled={!voidConfirmed || lifecycleNote.trim().length < 2} onClick={() => onVoid(lifecycleNote.trim())}><Trash2 className="size-4" />确认作废</Button></div>}
        {isAdmin && !isDone && !isDraft && !isReturned && !isWithdrawn && !isVoided && !canAct && <div className="detail-section detail-policy"><div className="detail-section-title"><AlertTriangle className="size-4" />异常流程恢复</div><p>{ndaRequiresApplicantResign ? "当前版成员协议不能沿旧审核节点继续；管理员不会代签，只能强制退回申请人重新手写签署并直接归档。" : "仅在当前处理人已失效或流程无法继续时使用。管理员不会代替任何审核人签字；操作只会把材料退回申请人并完整留痕。"}</p><Textarea value={actionNote} onChange={(event) => setActionNote(event.target.value)} rows={3} placeholder="填写至少 10 个字的异常原因" /><Button type="button" variant="outline" className="return-button" disabled={actionNote.trim().length < 10} onClick={() => onForceReturn(actionNote.trim())}><RotateCcw className="size-4" />管理员强制退回</Button></div>}
      </div>
      <SheetFooter className="detail-footer">
        {isDraft ? <><Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button><Button className="primary-button" onClick={onEditDraft}><Pencil className="size-4" />继续编辑草稿</Button></> : (isReturned || isWithdrawn) ? isRequester ? <>{approval.type !== "保密协议" && <Textarea value={actionNote} onChange={(event) => setActionNote(event.target.value)} rows={3} placeholder="填写本次补充或修改说明" />}<div className="detail-footer-actions"><Button variant="outline" onClick={onEditDraft}><Pencil className="size-4" />{approval.type === "保密协议" ? "重新签名并提交" : "修改材料"}</Button>{approval.type !== "保密协议" && <Button className="primary-button" disabled={actionNote.trim().length < 2} onClick={() => onResubmit(actionNote.trim())}><Send className="size-4" />修改后重新提交</Button>}</div></> : <Button variant="outline" className="w-full" onClick={() => onOpenChange(false)}>关闭详情</Button> : canAct ? <><Textarea value={actionNote} onChange={(event) => setActionNote(event.target.value)} rows={2} placeholder="审核意见（退回时必填）" /><div className="detail-footer-actions"><Button variant="outline" className="return-button" disabled={!actionNote.trim()} onClick={() => onReturn(actionNote.trim())}><RotateCcw className="size-4" />退回补充</Button><Button className="primary-button" disabled={Boolean((needsNextReviewer && !nextReviewerEmail) || (needsPurchaserAssignment && !selectedPurchaserEmail) || (isLaborRecommendation && (!suggestedAmount.trim() || compensationBasis.trim().length < 10)) || (isFinanceApproval && (!finalAmount.trim() || (finalAmountDiffers && !financeNote.trim()))) || (isPurchaseConfirmation && (purchaseNote.trim().length < 5 || !actualAmount.trim() || actualPurchaseAmount < 0 || purchaseAmountTooHigh)))} onClick={() => isPurchaseConfirmation ? onConfirmPurchase(purchaseNote.trim(), actualAmount.trim()) : sendApprove()}><BadgeCheck className="size-4" />{approval.type === "流转审批" ? approval.step === "流转确认" ? "确认已处理" : "同意审批" : approval.step === "开发人确认" ? "确认本人工作与占比" : needsNextReviewer ? "通过并转交" : isPurchaseConfirmation ? "确认采购并归档" : approval.type === "保密协议" ? ndaAgreementKind === "project_owner" ? "确认并归档" : "审核并归档" : approval.type === "劳务报酬" ? approval.step === "项目负责人" ? "通过并提交建议" : "审核并归档" : approval.type === "采购审核" ? "通过并进入统一采购" : "通过并归档"}</Button></div></> : <><div className="detail-readonly-note">{isVoided ? "该申请已作废，记录仅供查阅，不再继续流转。" : approval.status === "已归档" ? "该申请已归档；原记录不可覆盖，申请人可在详情中追加更正或废止说明。" : "当前节点由其他成员处理，你可以查看审批详情和流转记录。"}</div><Button variant="outline" className="w-full" onClick={() => onOpenChange(false)}>关闭详情</Button></>}
      </SheetFooter>
    </SheetContent>
  </Sheet>;
}

function RulesView() {
  const rules = [
    { number: "01", className: "", title: "技术审核", description: "仅受理直接用于机器人本体、控制 / 软件系统或测试验证的事项。只能选择已激活且完成实验室技术保密协议归档的成员作为开发人，贡献占比合计 100%；每位开发人须使用本人账号逐一确认。", steps: ["开发人逐一确认", "技术顾问", "项目负责人"] },
    { number: "02", className: "orange", title: "采购审核", description: "写清物品、规格、数量、用途、预计金额和供应商。项目负责人从已激活且完成实验室技术保密协议归档的成员中最终指定采购人；实际金额不得超过批准金额，超额须退回重审。", steps: ["技术顾问", "项目负责人指定", "统一采购确认"] },
    { number: "03", className: "purple", title: "保密文件与准入", description: "普通成员本人实名签署后由系统直接归档，项目负责人可查阅且无需审核；所有项目负责人必须另签《项目负责人保密承诺书》，由 OA 管理员确认归档。OA 管理员本人签署时由系统自动归档。", steps: ["成员：本人签署即归档", "负责人：管理员确认后归档"] },
    { number: "04", className: "labor", title: "劳务报酬", description: "每月一次。已归档成果按总工时 × 个人贡献率折算；本月其他工时不得包含已选成果工时。项目负责人须填写建议金额及依据，经费负责人终审。", steps: ["项目负责人建议", "经费负责人", "系统归档"] },
    { number: "05", className: "orange", title: "撤回、作废与归档说明", description: "未归档申请可由申请人撤回，保留记录并修改后重提；草稿和已撤回申请可作废，记录保留但停止流转。已归档记录不能直接作废，只能追加更正或废止说明。", steps: ["撤回后修改", "可重新提交 / 作废", "归档后仅追加说明"] },
  ];
  return <div className="rules-view"><div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />制度底稿</div><h1>流程与规则</h1><p>{officialDescription}</p></div></div><div className="rules-grid">{rules.map((rule) => <div className="rule-large" key={rule.number}><div className={`rule-large-number ${rule.className}`}>{rule.number}</div><div><h3>{rule.title}</h3><p>{rule.description}</p><div className="rule-sequence">{rule.steps.map((step, index) => <span className="rule-step-group" key={step}><span>{step}</span>{index < rule.steps.length - 1 && <ChevronRight className="size-4" />}</span>)}</div></div></div>)}</div><div className="rules-footnote"><ShieldCheck className="size-5" /><div><strong>版本说明</strong><p>{officialName}当前对应正式流程 V1.8。系统记录保留申请内容、逐人确认、贡献核算、审核人、撤回与作废原因、时间和电子签署证据；已归档版本不可覆盖。</p></div></div></div>;
}

export default function Home() {
  const [activeView, setActiveView] = useState<ViewKey>("knowledge");
  const [knowledgeTab, setKnowledgeTab] = useState<KnowledgeTab>("ask");
  const [chatActionsTarget, setChatActionsTarget] = useState<HTMLDivElement | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  useEffect(() => { try { setSidebarCollapsed(localStorage.getItem("oa.sidebar.collapsed") === "true"); } catch { /* optional preference */ } }, []);
  const toggleSidebar = () => setSidebarCollapsed(current => {
    const next = !current;
    try { localStorage.setItem("oa.sidebar.collapsed", String(next)); } catch { /* storage may be blocked */ }
    return next;
  });
  const [approvals, setApprovals] = useState<Approval[]>(initialApprovals);
  const [dataReady, setDataReady] = useState(false);
  const [activeFilter, setActiveFilter] = useState<"全部" | ApprovalType>("全部");
  const [showMineOnly, setShowMineOnly] = useState(false);
  const [metricPanel, setMetricPanel] = useState<MetricPanel>(null);
  const [peopleCount, setPeopleCount] = useState<number | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [requestDialogEpoch, setRequestDialogEpoch] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [myAvatarDataUrl, setMyAvatarDataUrl] = useState("");
  const [detailApproval, setDetailApproval] = useState<Approval | null>(null);
  const [detailEvents, setDetailEvents] = useState<ApprovalEvent[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [detailReloadKey, setDetailReloadKey] = useState(0);
  const [editingDraft, setEditingDraft] = useState<Approval | null>(null);
  const createLockRef = useRef(false);
  const lifecycleLockRef = useRef(false);
  const detailRequestSequenceRef = useRef(0);
  const detailAbortRef = useRef<AbortController | null>(null);
  const archiveStatusPollsRef = useRef(new Map<string, number>());
  const mobileSidebarRef = useRef<HTMLDivElement>(null);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const selectedApproval = detailApproval;
  const selectedListApproval = approvals.find((approval) => approval.id === selectedId);
  const selectedListRevision = selectedListApproval
    ? `${selectedListApproval.currentRevisionHash || selectedListApproval.currentRevisionNo || 0}|${selectedListApproval.status}|${selectedListApproval.step}|${selectedListApproval.updatedAt}`
    : "";
  const needsNda = Boolean(session?.registered && (session.needsNda === true || session.ndaCompleted === false));
  const mainAccessReady = Boolean(session?.registered && session.status !== "pending" && !needsNda);
  useEffect(() => {
    fetch("/api/session", { headers: { accept: "application/json" } })
      .then((response) => response.json() as Promise<SessionInfo>)
      .then(setSession)
      .catch(() => setSession({ registered: false }));
  }, []);
  useEffect(() => {
    if (!session) return;
    const url = new URL(window.location.href);
    const githubStatus = url.searchParams.get("github");
    if (!githubStatus) return;
    url.searchParams.delete("github");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    if (githubStatus === "linked") {
      setActiveView("profile");
      toast.success("GitHub 已绑定", { description: "以后可以用 GitHub 登录同一 OA 成员账号。" });
    } else if (githubStatus === "already-linked") {
      setActiveView("profile");
      toast.info("GitHub 已经绑定", { description: "无需重复操作。" });
    } else if (githubStatus === "signed-in") {
      setActiveView("knowledge");
      setShowMineOnly(false);
      setMobileNavOpen(false);
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      toast.success("GitHub 登录成功");
    } else if (githubStatus === "register") {
      toast.success("GitHub 身份已验证", { description: "请继续提交实名注册资料。" });
    } else if (githubStatus === "denied") {
      toast.info("已取消 GitHub 授权");
    } else if (githubStatus === "no-email") {
      toast.error("GitHub 缺少可用邮箱", { description: "请先在 GitHub 验证一个非 noreply 邮箱。" });
    } else if (githubStatus === "link-session-expired") {
      toast.error("绑定会话已失效", { description: "请重新使用 ChatGPT 登录后再绑定。" });
    } else if (githubStatus === "link-not-ready") {
      setActiveView("profile");
      toast.error("暂时无法绑定 GitHub", { description: "请确认当前 ChatGPT 账号已完成 OA 准入，再重试。" });
    } else if (githubStatus === "rate-limited") {
      setActiveView("profile");
      toast.error("操作过于频繁", { description: "请稍后再尝试绑定 GitHub。" });
    } else if (githubStatus === "identity-conflict") {
      toast.error("GitHub 身份已被占用", { description: "请联系 OA 管理员人工核验，系统不会自动合并账号。" });
    } else {
      toast.error("GitHub 登录未完成", { description: "授权状态无效或已经过期，请重试。" });
    }
  }, [session]);
  useEffect(() => {
    if (!session) return;
    const url = new URL(window.location.href);
    const feishuStatus = url.searchParams.get("feishu");
    if (!feishuStatus) return;
    url.searchParams.delete("feishu");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    if (feishuStatus === "linked") {
      setActiveView("profile");
      toast.success("飞书已绑定", { description: "以后扫码即可进入同一 OA 成员账号，原数据和权限保持不变。" });
    } else if (feishuStatus === "already-linked") {
      setActiveView("profile");
      toast.info("飞书已经绑定", { description: "无需重复操作。" });
    } else if (feishuStatus === "signed-in") {
      setActiveView("knowledge");
      setShowMineOnly(false);
      setMobileNavOpen(false);
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      toast.success("飞书登录成功");
    } else if (feishuStatus === "register") {
      toast.success("飞书企业身份已验证", { description: "系统会先查询同名旧账户；没有匹配时直接进入，有匹配时由本人确认是否绑定。" });
    } else if (feishuStatus === "denied") {
      toast.info("已取消飞书授权");
    } else if (feishuStatus === "wrong-tenant") {
      toast.error("飞书组织不匹配", { description: "请使用灵感智能组织内的飞书账号扫码。" });
    } else if (feishuStatus === "member-disabled") {
      toast.error("成员账号当前不可用", { description: "请联系 OA 管理员核验成员状态。" });
    } else if (feishuStatus === "link-session-expired") {
      toast.error("绑定会话已失效", { description: "请重新登录原成员账号后再绑定飞书。" });
    } else if (feishuStatus === "link-not-ready") {
      setActiveView("profile");
      toast.error("暂时无法绑定飞书", { description: "请确认当前账号已完成 OA 准入，再重试。" });
    } else if (feishuStatus === "rate-limited") {
      setActiveView("profile");
      toast.error("操作过于频繁", { description: "请稍后再尝试飞书登录或绑定。" });
    } else if (feishuStatus === "identity-conflict") {
      toast.error("飞书身份已被占用", { description: "请联系 OA 管理员按成员 ID 核验，系统不会自动合并账号。" });
    } else {
      toast.error("飞书登录未完成", { description: "授权状态无效或已经过期，请重试。" });
    }
  }, [session]);
  useEffect(() => {
    if (!mainAccessReady) return;
    let cancelled = false;
    let firstLoad = true;
    const loadApprovals = () => fetch("/api/approvals", { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as { approvals?: Approval[]; error?: string };
        if (!response.ok) throw new Error(data.error || "申请数据加载失败");
        if (!cancelled) {
          setApprovals(data.approvals ?? []); setDataReady(true);
          const linked = window.location.hash.match(/^#approval=([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/u)?.[1];
          if (linked) {
            window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
            if (data.approvals?.some((approval) => approval.id === linked)) setSelectedId(linked);
            else toast.error("该申请已不可访问，请核对当前登录账号。");
          }
        }
      })
      .catch((error: unknown) => {
        if (!cancelled && firstLoad) { setApprovals([]); setDataReady(true); toast.error("系统数据暂不可用", { description: error instanceof Error ? error.message : "请联系管理员" }); }
      })
      .finally(() => { firstLoad = false; });
    void loadApprovals();
    const intervalId = window.setInterval(loadApprovals, 30_000);
    return () => { cancelled = true; window.clearInterval(intervalId); };
  }, [mainAccessReady]);
  useEffect(() => {
    if (!mainAccessReady) return;
    fetch("/api/people?scope=directory", { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as { people?: Person[] };
        if (response.ok) setPeopleCount(data.people?.length ?? 0);
      })
      .catch(() => undefined);
  }, [activeView, mainAccessReady]);
  useEffect(() => {
    if (!mainAccessReady || !session?.user?.email) {
      setMyAvatarDataUrl("");
      return;
    }
    let cancelled = false;
    fetch("/api/profile", { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as { profile?: { avatarDataUrl?: string } };
        if (!cancelled && response.ok) setMyAvatarDataUrl(data.profile?.avatarDataUrl || "");
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [mainAccessReady, session?.user?.email]);
  useEffect(() => {
    if (!selectedId || !mainAccessReady) {
      detailRequestSequenceRef.current += 1;
      detailAbortRef.current?.abort();
      detailAbortRef.current = null;
      setDetailApproval(null);
      setDetailEvents([]);
      setDetailLoading(false);
      setDetailError("");
      return;
    }
    detailAbortRef.current?.abort();
    const controller = new AbortController();
    const requestSequence = detailRequestSequenceRef.current + 1;
    detailRequestSequenceRef.current = requestSequence;
    detailAbortRef.current = controller;
    setDetailApproval(null);
    setDetailEvents([]);
    setDetailLoading(true);
    setDetailError("");
    void loadApprovalDetail(selectedId, controller.signal)
      .then((detail) => {
        if (controller.signal.aborted || detailRequestSequenceRef.current !== requestSequence) return;
        setDetailApproval(detail.approval);
        setDetailEvents(detail.events);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || detailRequestSequenceRef.current !== requestSequence) return;
        const message = error instanceof Error ? error.message : "请稍后重试";
        setDetailError(message);
        toast.error("申请详情加载失败", { description: message });
      })
      .finally(() => {
        if (controller.signal.aborted || detailRequestSequenceRef.current !== requestSequence) return;
        setDetailLoading(false);
        if (detailAbortRef.current === controller) detailAbortRef.current = null;
      });
    return () => { controller.abort(); };
  }, [selectedId, mainAccessReady, detailReloadKey, selectedListRevision]);
  useEffect(() => {
    if (!selectedId) return;
    if (detailApproval?.status === "已归档" && detailApproval.feishuPdfArchive?.status && detailApproval.feishuPdfArchive.status !== "pending") {
      archiveStatusPollsRef.current.delete(selectedId);
      return;
    }
    if (detailApproval?.status !== "已归档" || detailApproval.feishuPdfArchive?.status !== "pending") return;
    const attempts = archiveStatusPollsRef.current.get(selectedId) || 0;
    if (attempts >= 8) return;
    archiveStatusPollsRef.current.set(selectedId, attempts + 1);
    const timer = window.setTimeout(() => setDetailReloadKey((current) => current + 1), 2_500);
    return () => window.clearTimeout(timer);
  }, [selectedId, detailApproval?.status, detailApproval?.feishuPdfArchive?.status]);
  const refreshSession = () => { fetch("/api/session", { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" }).then((response) => response.json() as Promise<SessionInfo>).then(setSession).catch(() => toast.error("登录状态刷新失败")); };
  useEffect(() => {
    if (!mobileNavOpen) return;
    const sidebar = mobileSidebarRef.current;
    const firstControl = sidebar?.querySelector<HTMLElement>("button:not([disabled])");
    firstControl?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMobileNavOpen(false);
      window.setTimeout(() => mobileMenuButtonRef.current?.focus(), 0);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileNavOpen]);
  const myPendingApprovals = useMemo(() => {
    const email = session?.user?.email?.trim().toLowerCase();
    if (!email) return [];
    return approvals.filter((approval) => {
      if (approval.status !== "待审核" && approval.status !== "审批中") return false;
      if (isStrandedCurrentMemberNda(approval)) return false;
      return approval.type === "流转审批" ? circulationPendingForEmail(approval.payload ?? {}, approval.step, email) : approval.currentReviewerEmail?.trim().toLowerCase() === email;
    });
  }, [approvals, session?.user?.email]);
  const filteredApprovals = useMemo(() => {
    const scopedApprovals = showMineOnly ? myPendingApprovals : approvals;
    return activeFilter === "全部" ? scopedApprovals : scopedApprovals.filter((approval) => approval.type === activeFilter);
  }, [activeFilter, approvals, myPendingApprovals, showMineOnly]);
  const pendingCount = myPendingApprovals.length;
  const currentMonthKey = localMonthKey();
  const monthlyApproved = useMemo(() => approvals.filter((approval) => approval.createdAt.slice(0, 7) === currentMonthKey && (approval.status === "已通过" || approval.status === "已归档")), [approvals, currentMonthKey]);
  const archivedCount = approvals.filter((approval) => approval.status === "已归档").length;
  const archiveEligibleCount = approvals.filter((approval) => !["草稿", "已撤回", "已作废"].includes(approval.status)).length;
  const archiveRatio = archiveEligibleCount ? Math.round((archivedCount / archiveEligibleCount) * 100) : 0;
  const openNewRequest = () => { setEditingDraft(null); setRequestDialogEpoch((current) => current + 1); setNewOpen(true); };
  const closeApproval = () => {
    if (selectedId) archiveStatusPollsRef.current.delete(selectedId);
    detailRequestSequenceRef.current += 1;
    detailAbortRef.current?.abort();
    detailAbortRef.current = null;
    setSelectedId(null);
    setDetailApproval(null);
    setDetailEvents([]);
    setDetailLoading(false);
    setDetailError("");
  };
  const openApproval = (id: string) => {
    archiveStatusPollsRef.current.delete(id);
    detailRequestSequenceRef.current += 1;
    detailAbortRef.current?.abort();
    detailAbortRef.current = null;
    setDetailApproval(null);
    setDetailEvents([]);
    setDetailError("");
    setDetailLoading(true);
    setSelectedId(id);
    setDetailReloadKey((current) => current + 1);
  };
  const retryApprovalDetail = () => {
    if (!selectedId) return;
    setDetailReloadKey((current) => current + 1);
  };
  const createApproval = async (approval: Approval): Promise<boolean> => {
    if (createLockRef.current) return false;
    createLockRef.current = true;
    try {
      const response = await fetch("/api/approvals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(approval) });
      const data = await response.json() as { approval?: Approval; error?: string };
      if (!response.ok || !data.approval) throw new Error(data.error || "申请保存失败");
      const savedApproval = data.approval as Approval;
      setApprovals((current) => [savedApproval, ...current.filter((item) => item.id !== savedApproval.id)]);
      setNewOpen(false);
      setEditingDraft(null);
      const savedForEditing = savedApproval.status === "草稿" || savedApproval.status === "已撤回" || savedApproval.status === "已退回";
      const ndaArchivedDirectly = savedApproval.type === "保密协议" && savedApproval.status === "已归档" && savedApproval.payload?.autoArchived === true;
      toast.success(savedForEditing ? "修改已保存" : ndaArchivedDirectly ? "保密协议已签署并归档" : "申请已提交", { description: savedForEditing ? `${savedApproval.id} 可在全部申请中继续编辑` : ndaArchivedDirectly ? "系统已直接归档；项目负责人可查阅，不生成审核待办。" : `${savedApproval.id} 已进入 ${savedApproval.step} 节点` });
      return true;
    } catch (error) { toast.error("申请未提交", { description: error instanceof Error ? error.message : "请稍后重试" }); return false; }
    finally { createLockRef.current = false; }
  };
  const updateSelected = async (nextStatus: ApprovalStatus, nextStep: string, message: string, action: "approve" | "return" | "force_return" | "confirm_developer" | "confirm_purchase" | "confirm_circulation" | "resubmit" = nextStatus === "已退回" ? "return" : "approve", nextReviewerEmail?: string, suggestedAmount?: string, finalAmount?: string, financeNote?: string, note?: string, compensationBasis?: string, purchaseNote?: string, actualAmount?: string, purchaserEmail?: string) => {
    if (!selectedId) return;
    const approvalId = selectedId;
    try {
      const response = await fetch(`/api/approvals/${approvalId}`, { method: "PATCH", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ action, ...(nextReviewerEmail ? { nextReviewerEmail } : {}), ...(suggestedAmount ? { suggestedAmount } : {}), ...(finalAmount ? { finalAmount } : {}), ...(financeNote ? { financeNote } : {}), ...(note ? { note } : {}), ...(compensationBasis ? { compensationBasis } : {}), ...(purchaseNote ? { purchaseNote } : {}), ...(actualAmount !== undefined ? { actualAmount } : {}), ...(purchaserEmail ? { purchaserEmail } : {}) }) });
      const data = await response.json() as { error?: string; approval?: { status: string; currentStep: string; currentReviewerName?: string; currentReviewerEmail?: string; amount?: string | null } };
      if (!response.ok || !data.approval) throw new Error(data.error || "审核动作保存失败");
      setApprovals((current) => current.map((approval) => approval.id === approvalId ? { ...approval, status: data.approval?.status as ApprovalStatus ?? nextStatus, step: data.approval?.currentStep ?? nextStep, currentReviewerName: data.approval?.currentReviewerName || undefined, currentReviewerEmail: data.approval?.currentReviewerEmail || undefined, amount: data.approval?.amount || approval.amount, updatedAt: "刚刚" } : approval));
      setDetailReloadKey((current) => current + 1);
      toast.success(message);
    } catch (error) { toast.error("审核动作未保存", { description: error instanceof Error ? error.message : "请稍后重试" }); }
  };
  const applyApplicantAction = async (action: "withdraw" | "void" | "archive_note", note: string, noticeType?: "correction" | "void") => {
    if (!selectedId || lifecycleLockRef.current) return false;
    const approvalId = selectedId;
    lifecycleLockRef.current = true;
    try {
      const response = await fetch(`/api/approvals/${approvalId}`, { method: "PATCH", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ action, note, ...(noticeType ? { noticeType } : {}) }) });
      const data = await response.json() as { error?: string; approval?: Approval & { currentStep?: string } };
      if (!response.ok || !data.approval) throw new Error(data.error || "申请状态保存失败");
      const saved = data.approval;
      setApprovals((current) => current.map((approval) => approval.id === approvalId ? { ...approval, ...saved, step: saved.currentStep || saved.step || approval.step } : approval));
      setDetailReloadKey((current) => current + 1);
      toast.success(action === "withdraw" ? "申请已撤回" : action === "void" ? "申请已作废" : noticeType === "void" ? "归档废止说明已追加" : "归档更正说明已追加", { description: action === "withdraw" ? "记录和流转轨迹已保留，可修改后重新提交。" : action === "void" ? "记录继续保留，但不会再流转。" : "原归档正文与历史文件没有被覆盖。" });
      return true;
    } catch (error) {
      toast.error(action === "withdraw" ? "申请未撤回" : action === "void" ? "申请未作废" : "归档说明未保存", { description: error instanceof Error ? error.message : "请稍后重试" });
      return false;
    } finally {
      lifecycleLockRef.current = false;
    }
  };
  const approveSelected = (nextReviewerEmail?: string, suggestedAmount?: string, finalAmount?: string, financeNote?: string, compensationBasis?: string, purchaserEmail?: string, circulationNote?: string) => {
    if (!selectedApproval) return;
    if (selectedApproval.type === "劳务报酬" && selectedApproval.step === "项目负责人") {
      if (!(numericAmount(suggestedAmount) > 0)) { toast.info("请填写有效的建议劳务报酬", { description: "建议金额必须大于 0，提交后申请才会转交经费负责人。" }); return; }
      if ((compensationBasis?.trim().length || 0) < 10) { toast.info("请填写金额依据", { description: "金额依据至少需要 10 个字。" }); return; }
      void updateSelected("审批中", "经费负责人", "项目负责人已提出建议劳务报酬，已转交经费负责人", "approve", undefined, suggestedAmount, undefined, undefined, undefined, compensationBasis?.trim());
      return;
    }
    if (selectedApproval.type === "劳务报酬" && selectedApproval.step === "经费负责人") {
      if (!(numericAmount(finalAmount) > 0)) { toast.info("请填写有效的最终审核金额", { description: "最终金额必须大于 0，经费负责人填写后才能归档。" }); return; }
      const suggested = numericAmount(selectedApproval.payload?.suggestedAmount ?? selectedApproval.amount);
      if (suggested > 0 && Math.abs(numericAmount(finalAmount) - suggested) > 0.005 && !financeNote?.trim()) { toast.info("请填写金额调整意见", { description: "最终金额与项目负责人建议金额不同时必须说明原因。" }); return; }
      void updateSelected("已归档", "已归档", "劳务报酬已由经费负责人审核并归档", "approve", undefined, undefined, finalAmount, financeNote?.trim());
      return;
    }
    if (selectedApproval.type === "流转审批") {
      void updateSelected("审批中", selectedApproval.step, selectedApproval.step === "流转确认" ? "流转确认已记录" : "审批意见已记录", selectedApproval.step === "流转确认" ? "confirm_circulation" : "approve", undefined, undefined, undefined, undefined, circulationNote);
      return;
    }
    if (selectedApproval.step === "开发人确认") { void updateSelected("审批中", "开发人确认", "本人实名确认已记录", "confirm_developer"); return; }
    if (selectedApproval.step === "技术顾问") {
      if (!nextReviewerEmail) { toast.info("请选择下一位项目负责人", { description: "审核通过后必须指定下一位审核人，或点击退回补充。" }); return; }
      void updateSelected("审批中", "项目负责人", "技术顾问审核已通过，已转交项目负责人", "approve", nextReviewerEmail);
      return;
    }
    if (selectedApproval.type === "采购审核" && selectedApproval.step === "项目负责人") {
      if (!purchaserEmail?.trim()) { toast.info("请指定采购成员"); return; }
      void updateSelected("审批中", "统一采购", "采购审核已通过，已转交指定采购成员确认", "approve", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, purchaserEmail.trim());
      return;
    }
    if (selectedApproval.type === "保密协议") {
      const agreementKind = confidentialityAgreementKindFromPayload(selectedApproval.payload) || "member";
      void updateSelected("已归档", "已归档", agreementKind === "project_owner" ? "项目负责人保密承诺书已由 OA 管理员确认并归档" : "旧流程保密协议已由项目负责人确认并归档");
      return;
    }
    void updateSelected("已归档", "已归档", "申请已审核并归档");
  };
  const confirmPurchaseSelected = (purchaseNote: string, actualAmount: string) => {
    if (purchaseNote.trim().length < 5) { toast.info("请填写实际采购说明", { description: "采购说明至少需要 5 个字。" }); return; }
    if (!actualAmount.trim() || numericAmount(actualAmount) < 0) { toast.info("请填写正确的实际采购金额"); return; }
    const approvedAmount = numericAmount(selectedApproval?.payload?.amount ?? selectedApproval?.amount);
    if (numericAmount(actualAmount) > approvedAmount + 0.005) { toast.info("实际金额超过批准金额", { description: "请退回补充并重新完成审批。" }); return; }
    void updateSelected("已归档", "已归档", "指定采购成员已确认实际采购并归档", "confirm_purchase", undefined, undefined, undefined, undefined, undefined, undefined, purchaseNote.trim(), actualAmount);
  };
  const returnSelected = (note: string) => updateSelected("已退回", "补充材料", "已退回申请人补充材料", "return", undefined, undefined, undefined, undefined, note);
  const forceReturnSelected = (note: string) => updateSelected("已退回", "补充材料", "异常流程已由管理员退回申请人", "force_return", undefined, undefined, undefined, undefined, note);
  const resubmitSelected = (note: string) => updateSelected("待审核", selectedApproval?.type === "技术审核" ? "开发人确认" : selectedApproval?.type === "采购审核" ? "技术顾问" : selectedApproval?.type === "保密协议" ? confidentialityAgreementReviewerStep(confidentialityAgreementKindFromPayload(selectedApproval.payload) || "member") : "项目负责人", "申请已补充并重新提交", "resubmit", undefined, undefined, undefined, undefined, note);
  const withdrawSelected = (note: string) => { void applyApplicantAction("withdraw", note); };
  const voidSelected = (note: string) => { void applyApplicantAction("void", note); };
  const archiveNoteSelected = (noticeType: "correction" | "void", note: string) => applyApplicantAction("archive_note", note, noticeType);
  const openDraftEditor = () => { if (!selectedApproval) return; const draft = selectedApproval; closeApproval(); setEditingDraft(draft); setRequestDialogEpoch((current) => current + 1); setNewOpen(true); };
  const openMyPending = () => { setActiveView("requests"); setActiveFilter("全部"); setShowMineOnly(true); setMobileNavOpen(false); };
  const navigate = (view: ViewKey) => { setActiveView(view); setShowMineOnly(false); setMobileNavOpen(false); };
  const openMetricApproval = (id: string) => { setMetricPanel(null); openApproval(id); };
  if (!session) return <div className="registration-shell"><div className="registration-card"><div className="registration-brand-lockup"><strong>{officialBrand}</strong><span>联合研发 OA</span></div><a className="oa-gate-guide-link" href="/guide"><BookOpen className="size-4" />项目章程与使用指南</a><h1>请登录账号</h1><p className="registration-intro">正在确认登录状态。实验室 AI 仅在登录并完成 OA 准入与保密签署后显示。</p></div></div>;
  if (!session.registered && (session.accountBindingRequired || session.accountBindingConflict || session.platformIdentityMissing || session.externalIdentityLinkRequired || session.githubIdentityLinkRequired || session.feishuIdentityLinkRequired)) return <><Toaster position="top-right" /><IdentityAccessGate session={session} onRefresh={refreshSession} /></>;
  if (session.status === "pending") return <><Toaster position="top-right" /><PendingGate session={session} onRefresh={refreshSession} /></>;
  if (!session.registered) return <><Toaster position="top-right" /><RegistrationGate initialUser={session.user} initialStatus={session.status} chatgptLoginEnabled={session.chatgptLoginEnabled} githubLoginEnabled={session.githubLoginEnabled} feishuLoginEnabled={session.feishuLoginEnabled} onRegistered={setSession} /></>;
  if (needsNda) return <><Toaster position="top-right" /><NdaAdmissionGate key={ndaAdmissionIdentityKey(session.user?.email)} session={session} onRefresh={refreshSession} /></>;
  return (
    <div className={`oa-app oa-workspace ${sidebarCollapsed ? "oa-sidebar-collapsed" : ""} ${activeView === "knowledge" && knowledgeTab === "ask" ? "oa-chat-open" : ""}`}>
      <Toaster position="top-right" />
      <button type="button" className={`mobile-nav-overlay ${mobileNavOpen ? "visible" : ""}`} onClick={() => { setMobileNavOpen(false); mobileMenuButtonRef.current?.focus(); }} aria-label="关闭导航" aria-hidden={!mobileNavOpen} tabIndex={mobileNavOpen ? 0 : -1} />
      <div ref={mobileSidebarRef} id="mobile-navigation" className={`mobile-sidebar ${mobileNavOpen ? "open" : ""}`} role="dialog" aria-modal="true" aria-label="移动导航" aria-hidden={!mobileNavOpen}>
        <Sidebar activeView={activeView} setActiveView={navigate} onNew={() => { openNewRequest(); setMobileNavOpen(false); }} onProfile={() => navigate("profile")} userName={session.user?.displayName} userAvatarDataUrl={myAvatarDataUrl} authProvider={session.user?.authProvider} currentRole={session.role} isAdmin={Boolean(session.isAdmin)} canReviewKnowledge={Boolean(session.canReviewKnowledge)} selectedKnowledgeTab={knowledgeTab} onKnowledgeTab={(tab) => { setKnowledgeTab(tab); navigate("knowledge"); }} onMyPending={openMyPending} />
      </div>
      <div id="oa-desktop-navigation" className="oa-desktop-navigation"><Sidebar activeView={activeView} setActiveView={navigate} onNew={openNewRequest} onProfile={() => navigate("profile")} userName={session.user?.displayName} userAvatarDataUrl={myAvatarDataUrl} authProvider={session.user?.authProvider} currentRole={session.role} isAdmin={Boolean(session.isAdmin)} canReviewKnowledge={Boolean(session.canReviewKnowledge)} selectedKnowledgeTab={knowledgeTab} onKnowledgeTab={(tab) => { setKnowledgeTab(tab); navigate("knowledge"); }} onMyPending={openMyPending} /></div>
      <main className="main-shell">
        <header className="topbar">
          <button type="button" className="workspace-sidebar-toggle" onClick={toggleSidebar} aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"} aria-expanded={!sidebarCollapsed} aria-controls="oa-desktop-navigation"><Menu className="size-5" /></button>
          <button ref={mobileMenuButtonRef} className="mobile-menu-button" onClick={() => setMobileNavOpen(true)} aria-label="打开导航" aria-expanded={mobileNavOpen} aria-controls="mobile-navigation"><Menu className="size-5" /></button>
          <div className="breadcrumbs">
            <button type="button" className="breadcrumb-home" onClick={() => navigate("dashboard")} aria-label={`返回${officialName}`} title="返回首页"><span className="breadcrumb-brand">{officialBrand}</span><span className="breadcrumb-subtitle">联合研发 OA</span></button>
            <ChevronRight className="size-3.5" />
            <strong>{activeView === "dashboard" ? "审批工作台" : activeView === "requests" ? showMineOnly ? "待我处理" : "全部申请" : activeView === "people" ? "协作成员" : activeView === "knowledge" ? "实验室 AI（内部）" : activeView === "members" ? "成员审核" : activeView === "oem" ? "官网 OEM 申请" : activeView === "notifications" ? "飞书提醒" : activeView === "profile" ? "个人设置" : "流程与规则"}</strong>
          </div>
          {activeView === "knowledge" && knowledgeTab === "ask" && <OaChatStatus />}
          <div className="topbar-actions">
            <div className="topbar-date">{todayLabel}</div>
            {activeView === "knowledge" && knowledgeTab === "ask" ? <div className="oa-chat-menu-host" ref={setChatActionsTarget} /> : <button type="button" className="oa-topbar-user" onClick={() => navigate("profile")} aria-label="打开个人设置"><UserRound className="size-4" />{session.user?.displayName || "成员"}</button>}
            <ChatHub currentUser={session.user} currentRole={session.role} isAdmin={session.isAdmin} />
          </div>
        </header>
        <div className="oa-knowledge-pane" hidden={activeView !== "knowledge"}><KnowledgeView canReviewKnowledge={Boolean(session.canReviewKnowledge)} activeSection={knowledgeTab} onSectionChange={setKnowledgeTab} chatActionsTarget={chatActionsTarget} /></div>
        {activeView === "notifications" ? <NotificationStatus /> : activeView === "oem" ? <OemInbox /> : activeView === "members" ? <MembersView currentEmail={session.user?.email} /> : activeView === "people" ? <PeopleView currentUser={session.user} /> : activeView === "knowledge" ? null : activeView === "profile" ? <ProfileSettingsView currentUser={session.user} currentRole={session.role} isAdmin={Boolean(session.isAdmin)} migrationExportEnabled={session.migrationExportEnabled} migrationUnfreezeEnabled={session.migrationUnfreezeEnabled} onIdentityChanged={(fullName, avatarDataUrl) => { setMyAvatarDataUrl(avatarDataUrl); setSession((current) => current?.user ? { ...current, user: { ...current.user, displayName: fullName } } : current); }} /> : activeView === "rules" ? <RulesView /> : activeView === "requests" ? <RequestsView approvals={approvals} filteredApprovals={filteredApprovals} myPendingApprovals={myPendingApprovals} dataReady={dataReady} activeFilter={activeFilter} setActiveFilter={setActiveFilter} showMineOnly={showMineOnly} onClearMine={() => setShowMineOnly(false)} onOpen={openApproval} /> : <>
          <section className="page-heading dashboard-heading">
            <div>
              <div className="eyebrow"><span className="eyebrow-line" />{officialName}</div>
              <h1>早上好，{session.user?.displayName || "成员"} <span className="heading-spark">✦</span></h1>
              <p>{officialDescription}</p>
            </div>
            <div className="heading-actions"><button className="secondary-action" onClick={() => setActiveView("rules")}><SlidersHorizontal className="size-4" />查看规则</button><Button className="primary-button new-button" onClick={openNewRequest}><Plus className="size-4" />新建审核</Button></div>
          </section>
          <div className="oa-guide-banner"><div><strong>让你的工作有记录，申请有进度，成果可查阅。</strong><p>完成阶段成果、需要采购或申请月度劳务时，从“新建审核”开始。</p></div><a href="/guide">项目章程与使用指南 <ArrowUpRight className="size-4" /></a></div>
          <section className="stats-grid">
            <button type="button" className="stat-card stat-card-action stat-card-approved" onClick={() => setMetricPanel("approved")} aria-label="查看本月已通过的文档"><div className="stat-label">本月已通过</div><div className="stat-value">{monthlyApproved.length}<span>条</span></div><div className="stat-foot positive"><span className="stat-icon"><Check className="size-4" /></span><span>点击查看已完成审批文档</span><ArrowUpRight className="stat-action-arrow size-4" /></div></button>
            <button type="button" className="stat-card stat-card-action stat-card-archive" onClick={() => setMetricPanel("archive")} aria-label="查看归档完整率详情"><div className="stat-label">归档完整率</div><div className="stat-value">{archiveRatio}<span>%</span></div><div className="stat-foot positive"><span className="stat-icon"><Archive className="size-4" /></span><span>点击查看归档统计</span><ArrowUpRight className="stat-action-arrow size-4" /></div></button>
            <button type="button" className="stat-card stat-card-action stat-card-people" onClick={() => navigate("people")} aria-label="查看协作成员"><div className="stat-label">协作成员</div><div className="stat-value">{peopleCount === null ? "—" : peopleCount}<span>人</span></div><div className="stat-foot"><span className="stat-icon"><UsersRound className="size-4" /></span><span>点击查看在线成员与私聊</span><ArrowUpRight className="stat-action-arrow size-4" /></div></button>
            <button type="button" className="stat-card stat-card-highlight stat-card-action" onClick={openMyPending} aria-label="查看待我处理申请"><div className="stat-label">待我处理</div><div className="stat-value">{pendingCount}<span>条</span></div><div className="stat-foot"><span className="stat-icon"><Clock3 className="size-4" /></span><span>点击查看当前需要你处理的申请</span><ArrowUpRight className="stat-action-arrow size-4" /></div></button>
          </section>
          <FlowCard />
        </>}
      </main>
      <NewRequestDialog key={requestDialogEpoch} open={newOpen} onOpenChange={setNewOpen} onCreate={createApproval} approvals={approvals} currentUser={session.user} currentRole={session.role} isAdmin={session.isAdmin} draft={editingDraft} onDraftConsumed={() => setEditingDraft(null)} />
      <DetailSheet approval={selectedApproval} events={detailEvents} loading={detailLoading} error={detailError} currentEmail={session.user?.email} isAdmin={session.isAdmin} open={Boolean(selectedId)} onOpenChange={(open) => { if (!open) closeApproval(); }} onRetry={retryApprovalDetail} onApprove={approveSelected} onConfirmPurchase={confirmPurchaseSelected} onReturn={returnSelected} onForceReturn={forceReturnSelected} onResubmit={resubmitSelected} onWithdraw={withdrawSelected} onVoid={voidSelected} onArchiveNote={archiveNoteSelected} onEditDraft={openDraftEditor} />
      <MetricDialog panel={metricPanel} approvals={approvals} monthlyApproved={monthlyApproved} archiveRatio={archiveRatio} onOpenApproval={openMetricApproval} onOpenChange={setMetricPanel} />
    </div>
  );
}

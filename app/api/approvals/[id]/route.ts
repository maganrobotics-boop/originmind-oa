import { and, asc, eq, exists, isNull, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { approvalEvents, approvalRevisions, approvals, externalArchives, laborSourceClaims, members } from "../../../../db/schema";
import {
  asNumber,
  createNdaIntegrityRecord,
  getPendingDeveloper,
  hasCompletedNda,
  hasDistinctVerifiedEmails,
  holdsLaborReservation,
  isApprovalAction,
  isApprovalRelated,
  isApprovalType,
  isValidLaborMonth,
  monthKeyInShanghai,
  nextWorkflowStep,
  normalizeEmail,
  normalizeTechnicalDevelopers,
  parseJsonObject,
  round,
  textValue,
  validatePngSignatureDataUrl,
  validatePngSignatureInk,
  workflowAllows,
  workflowRevisionsNeededAfterMaterial,
  type ApprovalAction,
  type TechnicalDeveloper,
} from "../../../../lib/approval-policy";
import { circulationPeople, pendingCirculationPeople, validateStoredCirculation } from "../../../../lib/circulation-policy";
import { addApprovalSigner } from "../../../../lib/approval-signers";
import { conditionalApprovalEvent, conditionalArchivedApplicantEvent, conditionalLaborClaimInsert } from "../../../../lib/workflow-write-store";
import { readBoundedJsonObject } from "../../../../lib/bounded-json-request";
import { consumeWriteRateLimit } from "../../../../lib/write-rate-limit";
import { authorizedMemberGuard, getAuthorizedUser, getConfiguredAdministrators, getConfiguredFinanceOwners, getConfiguredProjectOwners, getReviewerDirectory, isNdaAdmittedMember, isProjectOwner, parseMemberPermissions } from "../../_lib/auth";
import { buildArchiveManifest } from "../../../../lib/archive-manifest";
import {
  NDA_AGREEMENT_VERSION,
  LEGACY_NDA_AGREEMENT_VERSION,
  confidentialityAgreementKindForRole,
  confidentialityAgreementKindFromPayload,
  confidentialityAgreementReviewerStep,
  confidentialityAgreementVersions,
  ndaBusinessKeyForVersion,
} from "../../../../lib/nda-agreement";
import { conditionalApprovalRevisionInsert, planApprovalRevisions } from "../../../../lib/approval-revision-store";
import { FEISHU_PDF_ARCHIVE_DESTINATION } from "../../../../lib/feishu-drive-archive";
import { serializeApproval } from "../route";

const REVIEW_EVENT_ACTIONS = new Set(["approve", "return", "confirm_developer", "confirm_purchase", "confirm_circulation"]);
const PRIVATE_JSON_HEADERS = { "cache-control": "private, no-store" };
const MAX_WORKFLOW_WRITES_PER_MINUTE = 20;
const MAX_APPROVAL_REVISIONS = 128;
const MAX_EMERGENCY_FORCE_RETURN_REVISION = 129;

type LaborSourceClaimInput = {
  claimantMemberId: string;
  claimantEmail: string;
  technicalApprovalId: string;
};

function formatAmount(value: number) {
  return `¥ ${value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
}

function eventActionLabel(action: string) {
  return action === "confirm_circulation" ? "流转确认" : action === "submitted" ? "提交"
    : action === "auto_archived" ? "系统自动归档"
    : action === "draft_saved" ? "保存草稿"
      : action === "confirm_developer" ? "开发人确认"
        : action === "confirm_purchase" ? "采购完成确认"
          : action === "approve" ? "审核通过"
            : action === "return" ? "退回补充"
              : action === "force_return" ? "管理员强制退回"
              : action === "resubmit" ? "重新提交"
                : action === "withdraw" ? "申请人撤回"
                  : action === "void" ? "申请作废"
                    : action === "archive_correction" ? "归档更正说明"
                      : action === "archive_void_notice" ? "归档废止说明"
                        : action === "feishu_archived" ? "历史外部归档"
                : action;
}

function publicEventNote(action: string, note: string) {
  return action === "feishu_archived" ? note.replace(/；飞书文件 Token：[^；]+/g, "") : note;
}

function serializeActionApproval(row: typeof approvals.$inferSelect, authorized: NonNullable<Awaited<ReturnType<typeof getAuthorizedUser>>>) {
  return { ...serializeApproval(row, authorized, true), currentStep: row.currentStep };
}

function extractLaborSourceIds(payload: Record<string, unknown>) {
  if (Array.isArray(payload.sourceApprovalIds)) return Array.from(new Set(payload.sourceApprovalIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim())));
  if (!Array.isArray(payload.selectedSources)) return [];
  return Array.from(new Set(payload.selectedSources.flatMap((source) => source && typeof source === "object" && !Array.isArray(source) && textValue((source as Record<string, unknown>).id) ? [textValue((source as Record<string, unknown>).id)] : [])));
}

function stepRoleAllowed(step: string, authorized: NonNullable<Awaited<ReturnType<typeof getAuthorizedUser>>>) {
  if (step === "技术顾问") return authorized.isAdmin || authorized.role === "technical_advisor" || authorized.role === "project_owner";
  if (step === "项目负责人") return authorized.isAdmin || authorized.role === "project_owner";
  if (step === "OA管理员") return authorized.isAdmin;
  if (step === "经费负责人") return authorized.isAdmin || authorized.isFinanceOwner;
  return true;
}

async function activeMembers(db: Awaited<ReturnType<typeof getDb>>) {
  const rows = await db.select({ id: members.id, fullName: members.fullName, chatgptAccount: members.chatgptAccount, accountUserId: members.accountUserId, role: members.role, permissionsJson: members.permissionsJson, status: members.status, ndaAcceptedAt: members.ndaAcceptedAt, ndaAgreementVersion: members.ndaAgreementVersion }).from(members).where(eq(members.status, "active"));
  return rows.filter(isNdaAdmittedMember);
}

async function eligibleFinanceOwner(db: Awaited<ReturnType<typeof getDb>>, excludedEmails: Iterable<string> = []) {
  const excluded = new Set(Array.from(excludedEmails, normalizeEmail));
  const administrators = getConfiguredAdministrators();
  const completedReviewerEmails = new Set((await getReviewerDirectory()).filter((reviewer) => reviewer.ndaCompleted).map((reviewer) => reviewer.email));
  const administratorsByEmail = new Map(administrators.map((administrator) => [normalizeEmail(administrator.email), administrator]));
  const memberRows = await db.select({ email: members.chatgptAccount, fullName: members.fullName, chatgptAccount: members.chatgptAccount, accountUserId: members.accountUserId, role: members.role, permissionsJson: members.permissionsJson, ndaAcceptedAt: members.ndaAcceptedAt, ndaAgreementVersion: members.ndaAgreementVersion, status: members.status }).from(members);
  const membersByEmail = new Map(memberRows.map((member) => [normalizeEmail(member.email), member]));
  const configuredFinanceOwner = getConfiguredFinanceOwners().find((owner) => {
    const email = normalizeEmail(owner.email);
    const member = membersByEmail.get(email);
    const configuredIdentityMatches = member?.accountUserId === owner.accountUserId;
    const administratorIdentityMatches = administratorsByEmail.get(email)?.accountUserId === owner.accountUserId;
    return !excluded.has(email) && ((administratorIdentityMatches && completedReviewerEmails.has(email)) || Boolean(member?.status === "active" && configuredIdentityMatches && isNdaAdmittedMember(member)));
  });
  if (configuredFinanceOwner) {
    const email = normalizeEmail(configuredFinanceOwner.email);
    const member = membersByEmail.get(email);
    return { email, displayName: member?.status === "active" && member.accountUserId === configuredFinanceOwner.accountUserId ? member.fullName : configuredFinanceOwner.displayName };
  }
  const administrator = administrators.find((candidate) => !excluded.has(normalizeEmail(candidate.email)) && completedReviewerEmails.has(normalizeEmail(candidate.email)));
  if (!administrator) return null;
  const administratorEmail = normalizeEmail(administrator.email);
  const administratorMember = membersByEmail.get(administratorEmail);
  return { email: administratorEmail, displayName: administratorMember?.status === "active" && administratorMember.accountUserId === administrator.accountUserId ? administratorMember.fullName : administrator.displayName };
}

function canCombineLaborReviewRoles(authorized: NonNullable<Awaited<ReturnType<typeof getAuthorizedUser>>>) {
  const email = normalizeEmail(authorized.user.email);
  const matchesIdentity = (owner: ReturnType<typeof getConfiguredFinanceOwners>[number]) =>
    normalizeEmail(owner.email) === email && owner.accountUserId === authorized.accountUserId;
  // Administrator fallback alone does not authorize combining financial duties.
  return authorized.role === "project_owner" && authorized.isFinanceOwner
    && getConfiguredProjectOwners().some(matchesIdentity)
    && getConfiguredFinanceOwners().some(matchesIdentity);
}

async function normalizeStoredDevelopers(db: Awaited<ReturnType<typeof getDb>>, payload: Record<string, unknown>) {
  return normalizeTechnicalDevelopers(payload.developers, await activeMembers(db));
}

async function rebuildNdaPayload(payload: Record<string, unknown>, requesterName: string, requesterEmail: string, requesterAccountUserId: string) {
  const agreementKind = confidentialityAgreementKindFromPayload(payload);
  const agreementVersion = textValue(payload.agreementVersion);
  if (!agreementKind || !confidentialityAgreementVersions(agreementKind).includes(agreementVersion)) return { error: "保密文件正文版本无法验证，请由申请人按当前版本重新阅读并签署。" };
  if (agreementKind === "project_owner" && payload.agreementKind !== "project_owner") return { error: "项目负责人保密承诺书缺少明确的文件类型，请重新阅读并签署。" };
  const signerName = textValue(payload.signerName);
  const signerEmail = normalizeEmail(payload.signerEmail);
  const signerAccountUserId = textValue(payload.signerAccountUserId);
  const confidentialScope = textValue(payload.confidentialScope);
  const signatureDataUrl = textValue(payload.signatureDataUrl);
  const signedAt = textValue(payload.signedAt);
  if (signerName !== requesterName || signerEmail !== normalizeEmail(requesterEmail) || !requesterAccountUserId || signerAccountUserId !== requesterAccountUserId) return { error: "保密协议签署身份与申请人的认证账户主体不一致，请重新编辑并签署。" };
  if (!confidentialScope || payload.previewed !== true || payload.agreed !== true) return { error: "保密协议缺少范围、预览或同意记录，请重新编辑并签署。" };
  const signatureError = validatePngSignatureDataUrl(signatureDataUrl);
  if (signatureError) return { error: signatureError };
  const signatureInkError = await validatePngSignatureInk(signatureDataUrl);
  if (signatureInkError) return { error: signatureInkError };
  if (Number.isNaN(Date.parse(signedAt))) return { error: "保密协议签署时间无效，请重新编辑并签署。" };
  const integrity = await createNdaIntegrityRecord({ signerName, signerEmail, signerAccountUserId, confidentialScope, signatureDataUrl, signedAt, agreementKind, agreementVersion });
  return { payload: { ...payload, agreementKind, agreementVersion, ...integrity }, agreementKind, agreementVersion };
}

async function rebuildLaborPayload(db: Awaited<ReturnType<typeof getDb>>, approval: typeof approvals.$inferSelect, payload: Record<string, unknown>) {
  const month = textValue(payload.month);
  const otherMonthlyWorkHours = asNumber(payload.otherMonthlyWorkHours ?? payload.monthlyWorkHours);
  const monthlyStatement = textValue(payload.monthlyStatement);
  const sourceIds = extractLaborSourceIds(payload);
  if (!isValidLaborMonth(month) || month > monthKeyInShanghai()) return { error: "劳务报酬所属月份无效或晚于当前月份。" };
  if (!(otherMonthlyWorkHours >= 0) || monthlyStatement.length < 10 || !sourceIds.length) return { error: "劳务报酬材料不完整，请重新编辑本月其他工时、贡献陈述和技术成果。" };
  const expectedPeriodKey = `${normalizeEmail(approval.requesterEmail)}|${month}`;
  const [currentMember] = await db.select({ id: members.id }).from(members).where(and(eq(members.chatgptAccount, normalizeEmail(approval.requesterEmail)), eq(members.status, "active"))).limit(1);
  if (!currentMember) return { error: "劳务报酬申请人已不是当前有效成员。" };
  const laborRows = await db.select().from(approvals).where(eq(approvals.type, "劳务报酬"));
  const otherFormalRows = laborRows.filter((row) => row.id !== approval.id && holdsLaborReservation(row.status) && (normalizeEmail(row.requesterEmail) === normalizeEmail(approval.requesterEmail) || textValue(parseJsonObject(row.payloadJson).claimantMemberId) === currentMember.id));
  if (otherFormalRows.some((row) => row.periodKey === expectedPeriodKey || textValue(parseJsonObject(row.payloadJson).month) === month)) return { error: `${month} 已有另一份正式劳务报酬申请。`, conflict: true };
  const claimedSourceIds = new Set(otherFormalRows.flatMap((row) => extractLaborSourceIds(parseJsonObject(row.payloadJson))));
  if (sourceIds.some((sourceId) => claimedSourceIds.has(sourceId))) return { error: "所选技术成果已计入当前成员的另一份劳务报酬申请。", conflict: true };
  const persistedClaims = await db.select({ technicalApprovalId: laborSourceClaims.technicalApprovalId, laborApprovalId: laborSourceClaims.laborApprovalId }).from(laborSourceClaims).where(eq(laborSourceClaims.claimantMemberId, currentMember.id));
  if (sourceIds.some((sourceId) => persistedClaims.some((claim) => claim.technicalApprovalId === sourceId && claim.laborApprovalId !== approval.id))) return { error: "所选技术成果已被当前成员的另一份正式劳务报酬申请占用。", conflict: true };

  const technicalRows = await db.select().from(approvals).where(eq(approvals.type, "技术审核"));
  const selectedRows = sourceIds.map((sourceId) => technicalRows.find((row) => row.id === sourceId));
  if (selectedRows.some((row) => !row || row.status !== "已归档" || row.currentStep !== "已归档")) return { error: "劳务报酬只能选择已完成全部审核并归档的技术成果。" };
  if (selectedRows.some((row) => {
    if (!row) return true;
    const sourcePayload = parseJsonObject(row.payloadJson);
    const archivedMonth = monthKeyInShanghai(textValue(sourcePayload.archivedAt) || row.updatedAt);
    return !archivedMonth || archivedMonth > month;
  })) return { error: "所选技术成果归档时间无效，或归档月份晚于申报月份。" };

  const requesterEmail = normalizeEmail(approval.requesterEmail);
  const selectedSources = selectedRows.map((row) => {
    if (!row) return null;
    const sourcePayload = parseJsonObject(row.payloadJson);
    const totalWorkHours = asNumber(sourcePayload.totalWorkHours);
    const developers = Array.isArray(sourcePayload.developers) ? sourcePayload.developers as TechnicalDeveloper[] : [];
    const developer = developers.find((item) => normalizeEmail(item.email) === requesterEmail && textValue(item.memberId) === currentMember.id);
    const contributionRate = asNumber(developer?.ratio);
    if (!(totalWorkHours > 0) || !developer || !(contributionRate >= 0 && contributionRate <= 100)) return null;
    return { id: row.id, title: row.title, archivedAt: textValue(sourcePayload.archivedAt) || row.updatedAt, totalWorkHours: round(totalWorkHours), contributionRate: round(contributionRate), weightedHours: round(totalWorkHours * contributionRate / 100) };
  });
  if (selectedSources.some((source) => !source)) return { error: "所选技术成果中没有当前申请人的有效开发贡献记录。" };
  const normalizedSources = selectedSources as NonNullable<typeof selectedSources[number]>[];
  const archivedContributionHours = round(normalizedSources.reduce((sum, source) => sum + source.weightedHours, 0));
  const normalizedOtherHours = round(otherMonthlyWorkHours);
  const totalScore = round(archivedContributionHours + normalizedOtherHours);
  if (!(totalScore > 0)) return { error: "技术贡献折算与本月其他工时合计必须大于 0。" };
  const laborClaimRevision = crypto.randomUUID();
  return {
    periodKey: expectedPeriodKey,
    claims: normalizedSources.map((source) => ({ claimantMemberId: currentMember.id, claimantEmail: requesterEmail, technicalApprovalId: source.id })),
    payload: {
      ...payload,
      month,
      claimantMemberId: currentMember.id,
      laborClaimRevision,
      sourceApprovalIds: normalizedSources.map((source) => source.id),
      selectedSources: normalizedSources,
      monthlyWorkHours: normalizedOtherHours,
      otherMonthlyWorkHours: normalizedOtherHours,
      monthlyWorkHoursDefinition: "不含已选技术成果工作时间的本月其他工时",
      monthlyStatement,
      archivedContributionHours,
      totalScore,
    },
  };
}

async function validateLaborClaimIntegrity(db: Awaited<ReturnType<typeof getDb>>, approval: typeof approvals.$inferSelect, payload: Record<string, unknown>) {
  const claimantMemberId = textValue(payload.claimantMemberId);
  const claimantEmail = normalizeEmail(approval.requesterEmail);
  const month = textValue(payload.month);
  const sourceIds = extractLaborSourceIds(payload);
  if (!claimantMemberId || !isValidLaborMonth(month) || !sourceIds.length) return "劳务报酬的申报成员、月份或技术成果占用记录不完整，请退回申请人重新提交。";
  const [member] = await db.select({ id: members.id, chatgptAccount: members.chatgptAccount, status: members.status }).from(members).where(eq(members.id, claimantMemberId)).limit(1);
  if (!member || !["active", "departed"].includes(member.status) || normalizeEmail(member.chatgptAccount) !== claimantEmail) return "劳务报酬申请人的成员身份不一致，请退回申请人重新提交。";
  if (approval.periodKey !== `${claimantEmail}|${month}`) return "劳务报酬月份占用键异常，请退回申请人重新提交。";
  const claims = await db.select({ claimantMemberId: laborSourceClaims.claimantMemberId, claimantEmail: laborSourceClaims.claimantEmail, technicalApprovalId: laborSourceClaims.technicalApprovalId }).from(laborSourceClaims).where(eq(laborSourceClaims.laborApprovalId, approval.id));
  const expected = new Set(sourceIds);
  const actual = new Set(claims.map((claim) => claim.technicalApprovalId));
  const identityMismatch = claims.some((claim) => claim.claimantMemberId !== claimantMemberId || normalizeEmail(claim.claimantEmail) !== claimantEmail);
  if (identityMismatch || claims.length !== expected.size || actual.size !== expected.size || sourceIds.some((sourceId) => !actual.has(sourceId))) return "劳务报酬技术成果占用记录与申请数据不一致，请退回申请人重新提交。";
  return null;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authorized = await getAuthorizedUser();
  if (!authorized) return Response.json({ error: "请先完成成员注册。" }, { status: 401 });
  const { id } = await params;
  try {
    const db = await getDb();
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, id)).limit(1);
    if (!approval) return Response.json({ error: "申请不存在。" }, { status: 404 });
    const [events, revisions] = await Promise.all([
      db.select().from(approvalEvents).where(eq(approvalEvents.approvalId, id)).orderBy(asc(approvalEvents.createdAt), asc(approvalEvents.id)),
      db.select().from(approvalRevisions).where(eq(approvalRevisions.approvalId, id)).orderBy(asc(approvalRevisions.revisionNo)),
    ]);
    const email = normalizeEmail(authorized.user.email);
    const historicalActors = new Set(events.filter((event) => REVIEW_EVENT_ACTIONS.has(event.action)).map((event) => normalizeEmail(event.actorEmail)));
    const canView = !hasCompletedNda(authorized)
      ? approval.type === "保密协议" && normalizeEmail(approval.requesterEmail) === email
      : authorized.isAdmin || authorized.role === "project_owner"
        ? true
        : (authorized.isFinanceOwner && approval.type === "劳务报酬") || isApprovalRelated(approval, email, historicalActors);
    if (!canView) return Response.json({ error: "申请不存在或当前账号无权查看。" }, { status: 404 });
    const agreementKind = approval.type === "保密协议"
      ? confidentialityAgreementKindFromPayload(parseJsonObject(approval.payloadJson))
      : null;
    const canSeeSignature = approval.type !== "保密协议"
      || authorized.isAdmin
      || (authorized.role === "project_owner" && agreementKind === "member")
      || normalizeEmail(approval.requesterEmail) === email
      || normalizeEmail(approval.currentReviewerEmail) === email
      || historicalActors.has(email);
    const serialized = serializeApproval(approval, authorized, true, canSeeSignature);
    const businessEvents = events.filter((event) => event.action !== "feishu_archived");
    let manifest: Awaited<ReturnType<typeof buildArchiveManifest>> | null = null;
    let archiveIntegrityError = "";
    if (approval.status === "已归档") {
      try {
        manifest = await buildArchiveManifest(approval, businessEvents, revisions);
      } catch {
        archiveIntegrityError = "归档完整性校验未通过，申请正文仍可查看；正式 PDF 暂不可用，请联系管理员核验。";
      }
    }
    const [pdfArchive] = manifest ? await db.select({
      status: externalArchives.status,
      fileName: externalArchives.fileName,
      errorCode: externalArchives.errorCode,
      updatedAt: externalArchives.updatedAt,
    }).from(externalArchives).where(and(
      eq(externalArchives.approvalId, approval.id),
      eq(externalArchives.destination, FEISHU_PDF_ARCHIVE_DESTINATION),
      eq(externalArchives.manifestHash, manifest.hash),
    )).limit(1) : [];
    return Response.json({
      approval: manifest
        ? { ...serialized, archiveHash: manifest.hash, archiveContentHash: manifest.fileHash, evidenceRecordHash: manifest.evidenceRecordHash, archiveSchemaVersion: manifest.schemaVersion, terminalRevisionNo: manifest.terminalRevisionNo, terminalRevisionHash: manifest.terminalRevisionHash, terminalStateHash: manifest.terminalStateHash, feishuPdfArchive: pdfArchive || { status: "pending" } }
        : archiveIntegrityError ? { ...serialized, archiveIntegrityError } : serialized,
      events: events.map((event) => ({ id: event.id, actorName: event.actorName, actorEmail: event.actorEmail, action: eventActionLabel(event.action), note: publicEventNote(event.action, event.note), createdAt: event.createdAt })),
    }, { headers: PRIVATE_JSON_HEADERS });
  } catch {
    return Response.json({ error: "申请详情暂不可用，请稍后重试。" }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authorized = await getAuthorizedUser();
  if (!authorized) return Response.json({ error: "请先完成成员注册。" }, { status: 401 });
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return Response.json({ error: "审核动作必须使用 JSON 格式提交。" }, { status: 415 });
  const user = authorized.user;
  const { id } = await params;
  const parsedBody = await readBoundedJsonObject(request, 65_536);
  if (!parsedBody.ok) return Response.json({ error: parsedBody.reason === "too_large" ? "审核动作数据过大。" : "审核动作格式不正确。" }, { status: parsedBody.reason === "too_large" ? 413 : 400 });
  const body = parsedBody.value;
  const actionValue = textValue(body.action);
  if (!isApprovalAction(actionValue)) return Response.json({ error: "不支持的审核动作。" }, { status: 400 });
  const action: ApprovalAction = actionValue;
  const note = textValue(body.note);
  if (note.length > 1000) return Response.json({ error: "审核意见不能超过 1000 字。" }, { status: 400 });

  try {
    const db = await getDb();
    const actorGuard = authorizedMemberGuard(authorized);
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, id)).limit(1);
    if (!approval) return Response.json({ error: "申请不存在。" }, { status: 404 });
    const requesterEmail = normalizeEmail(approval.requesterEmail);
    const currentEmail = normalizeEmail(user.email);
    if (!(await consumeWriteRateLimit(db, { actorSubject: authorized.accountUserId || "", scope: "approval_write", limit: MAX_WORKFLOW_WRITES_PER_MINUTE }))) {
      return Response.json({ error: "审核操作过于频繁，请稍后再试。" }, { status: 429, headers: { "retry-after": "60" } });
    }
    if (action !== "archive_note" && approval.currentRevisionNo >= MAX_APPROVAL_REVISIONS && !(action === "force_return" && approval.currentRevisionNo < MAX_EMERGENCY_FORCE_RETURN_REVISION)) {
      return Response.json({ error: "该申请的不可变材料版本已达安全上限，请联系管理员核验并制定迁移处理方案。" }, { status: 409 });
    }
    let payload = parseJsonObject(approval.payloadJson);
    const isApplicantAction = action === "resubmit" || action === "withdraw" || action === "void" || action === "archive_note";
    if (isApplicantAction) {
      if (requesterEmail !== currentEmail) return Response.json({ error: "申请不存在或当前账号不可操作。" }, { status: 404 });
    } else if (action === "force_return") {
      if (!authorized.isAdmin) return Response.json({ error: "只有管理员可以执行异常流程强制退回。" }, { status: 403 });
    } else {
      const isAssignedCirculationActor = approval.type === "流转审批" && pendingCirculationPeople(payload, approval.currentStep).some((person) => person.email === currentEmail && person.memberId === authorized.memberId && person.accountUserId === authorized.accountUserId);
      if (approval.type === "流转审批" ? !isAssignedCirculationActor : normalizeEmail(approval.currentReviewerEmail) !== currentEmail) return Response.json({ error: "申请不存在或当前账号不可操作。" }, { status: 404 });
      if (!stepRoleAllowed(approval.currentStep, authorized)) return Response.json({ error: "当前账号没有该审核节点的处理权限。" }, { status: 403 });
    }
    if (!isApprovalType(approval.type)) return Response.json({ error: "申请类型异常，无法继续流转。" }, { status: 409 });
    const ownNdaApplicantAction = approval.type === "保密协议" && requesterEmail === currentEmail && isApplicantAction;
    if (!hasCompletedNda(authorized) && !ownNdaApplicantAction) return Response.json({ error: "保密协议归档前只能提交、撤回、作废或补充本人的保密文件，不能处理其他申请。" }, { status: 403 });
    if (!workflowAllows(approval.type, approval.currentStep, action, approval.status)) return Response.json({ error: `“${approval.type} / ${approval.currentStep}”节点不允许执行“${eventActionLabel(action)}”动作。` }, { status: 409 });
    if (action === "force_return" && note.length < 10) return Response.json({ error: "管理员强制退回必须填写至少 10 个字的异常原因。" }, { status: 400 });
    if ((action === "withdraw" || action === "void") && note.length < 2) return Response.json({ error: action === "withdraw" ? "请填写至少 2 个字的撤回原因。" : "请填写至少 2 个字的作废原因。" }, { status: 400 });
    if (action === "approve" && requesterEmail === currentEmail) return Response.json({ error: "申请人不能审核自己的申请，请退回并改由其他实名审核人处理。" }, { status: 403 });

    const currentMemberNdaRequiresFreshSignature = approval.type === "保密协议"
      && confidentialityAgreementKindFromPayload(payload) === "member"
      && textValue(payload.agreementVersion) === NDA_AGREEMENT_VERSION
      && payload.autoArchived !== true;
    if (currentMemberNdaRequiresFreshSignature && (action === "approve" || action === "return" || action === "resubmit")) {
      return Response.json({ error: "当前版本成员保密协议不能进入旧审核流；请由申请人撤回或重新手写签署，管理员仅可在异常时强制退回。" }, { status: 409 });
    }

    if (action === "archive_note") {
      const noticeType = body.noticeType === "correction" ? "correction" : body.noticeType === "void" ? "void" : "";
      if (!noticeType) return Response.json({ error: "请选择“更正说明”或“废止说明”。" }, { status: 400 });
      if (note.length < 10) return Response.json({ error: "归档说明至少需要 10 个字，以便保留清晰、可核验的依据。" }, { status: 400 });
      const now = new Date().toISOString();
      const storedAction = noticeType === "correction" ? "archive_correction" : "archive_void_notice";
      const eventRows = await conditionalArchivedApplicantEvent(db, approval, currentEmail, actorGuard, {
        actorName: user.displayName,
        actorEmail: currentEmail,
        action: storedAction,
        note,
        createdAt: now,
      });
      if (!eventRows[0]) return Response.json({ error: "归档记录刚刚发生变化，或当前账号已失去操作资格，请刷新后重试。" }, { status: 409 });
      return Response.json({ approval: serializeActionApproval(approval, authorized), noteAdded: true }, { headers: PRIVATE_JSON_HEADERS });
    }

    if (action === "withdraw" || action === "void") {
      const now = new Date().toISOString();
      const workflowMutationRevision = crypto.randomUUID();
      const isVoid = action === "void";
      const eventNote = isVoid ? `申请人作废：${note}` : `申请人撤回：${note}`;
      payload = {
        ...payload,
        workflowMutationRevision,
        ...(isVoid
          ? { voidedAt: now, voidedBy: { email: currentEmail, name: user.displayName }, voidReason: note }
          : { withdrawnAt: now, withdrawnBy: { email: currentEmail, name: user.displayName }, withdrawReason: note }),
      };
      const nextState = {
        ...approval,
        status: isVoid ? "已作废" : "已撤回",
        currentStep: isVoid ? "已作废" : "申请人修改",
        currentReviewerName: isVoid ? "" : approval.requesterName,
        currentReviewerEmail: isVoid ? "" : approval.requesterEmail,
        payloadJson: JSON.stringify(payload),
        periodKey: isVoid && approval.type === "劳务报酬" ? null : approval.periodKey,
        businessKey: isVoid && approval.type === "保密协议" ? null : approval.businessKey,
        updatedAt: now,
      };
      const revisionPlan = await planApprovalRevisions({
        previousApproval: approval as unknown as Record<string, unknown>,
        nextApproval: nextState as unknown as Record<string, unknown>,
        workflowMutationRevision,
        event: { actorName: user.displayName, actorEmail: currentEmail, action, note: eventNote, occurredAt: now },
        shouldWrite: true,
      });
      const previousRevisionPointerMatches = approval.currentRevisionHash ? eq(approvals.currentRevisionHash, approval.currentRevisionHash) : isNull(approvals.currentRevisionHash);
      const update = db.update(approvals).set({ ...nextState, currentRevisionNo: revisionPlan.currentRevisionNo, currentRevisionHash: revisionPlan.currentRevisionHash }).where(and(
        eq(approvals.id, id),
        eq(approvals.updatedAt, approval.updatedAt),
        eq(approvals.payloadJson, approval.payloadJson),
        eq(approvals.currentRevisionNo, approval.currentRevisionNo),
        previousRevisionPointerMatches,
        sql`lower(${approvals.requesterEmail}) = ${currentEmail}`,
        actorGuard,
      )).returning();
      const revisionWrites = revisionPlan.revisions.map((revision) => conditionalApprovalRevisionInsert(db, id, now, workflowMutationRevision, revisionPlan.currentRevisionNo, revisionPlan.currentRevisionHash!, revision));
      const event = conditionalApprovalEvent(db, id, now, workflowMutationRevision, { actorName: user.displayName, actorEmail: currentEmail, action, note: eventNote });
      if (isVoid && approval.type === "劳务报酬") {
        const approvalWasVoided = exists(db.select({ id: approvals.id }).from(approvals).where(and(
          eq(approvals.id, id),
          eq(approvals.status, "已作废"),
          eq(approvals.updatedAt, now),
          isNull(approvals.periodKey),
          sql`json_extract(${approvals.payloadJson}, '$.workflowMutationRevision') = ${workflowMutationRevision}`,
        )));
        const releaseClaims = db.delete(laborSourceClaims).where(and(eq(laborSourceClaims.laborApprovalId, id), approvalWasVoided)).returning({ id: laborSourceClaims.id });
        const results = await db.batch([update, releaseClaims, ...revisionWrites, event]);
        const updated = (results[0] as Array<typeof approvals.$inferSelect>)[0];
        if (!updated) return Response.json({ error: "申请刚刚已被其他操作更新，请刷新后重试。" }, { status: 409 });
        const revisionResults = results.slice(2, -1) as Array<Array<{ revisionHash: string }>>;
        const eventRows = results.at(-1) as Array<{ id: number }>;
        if (revisionResults.length !== revisionWrites.length || revisionResults.some((rows) => !rows[0]) || !eventRows[0]) return Response.json({ error: "申请已作废，但材料版本或审计记录未完整写入，请联系管理员核查。" }, { status: 500 });
        return Response.json({ approval: serializeActionApproval(updated, authorized) }, { headers: PRIVATE_JSON_HEADERS });
      }
      const results = await db.batch([update, ...revisionWrites, event]);
      const updated = (results[0] as Array<typeof approvals.$inferSelect>)[0];
      if (!updated) return Response.json({ error: "申请刚刚已被其他操作更新，请刷新后重试。" }, { status: 409 });
      const revisionResults = results.slice(1, -1) as Array<Array<{ revisionHash: string }>>;
      const eventRows = results.at(-1) as Array<{ id: number }>;
      if (revisionResults.length !== revisionWrites.length || revisionResults.some((rows) => !rows[0]) || !eventRows[0]) return Response.json({ error: "申请状态已更新，但材料版本或审计记录未完整写入，请联系管理员核查。" }, { status: 500 });
      return Response.json({ approval: serializeActionApproval(updated, authorized) }, { headers: PRIVATE_JSON_HEADERS });
    }

    if (action === "return" && approval.currentRevisionNo + 2 + workflowRevisionsNeededAfterMaterial(approval.type, payload) > MAX_APPROVAL_REVISIONS) {
      return Response.json({ error: "该申请剩余的不可变版本空间不足以完成退回、重新提交和后续实名节点；请联系管理员核验并制定迁移处理方案。" }, { status: 409 });
    }
    if (approval.type === "劳务报酬" && action === "approve") {
      const integrityError = await validateLaborClaimIntegrity(db, approval, payload);
      if (integrityError) return Response.json({ error: integrityError }, { status: 409 });
    }

    if (action === "resubmit") {
      if (note.length < 2) return Response.json({ error: "请填写本次补充或修改说明。" }, { status: 400 });
      const ndaAgreementKind = approval.type === "保密协议" ? confidentialityAgreementKindFromPayload(payload) : null;
      if (approval.type === "保密协议" && !ndaAgreementKind) return Response.json({ error: "保密文件类型或版本无效，请重新新建当前角色对应的保密文件。" }, { status: 409 });
      if (ndaAgreementKind && ndaAgreementKind !== confidentialityAgreementKindForRole(authorized.role)) {
        return Response.json({ error: "成员角色已经变化，请新建当前角色对应的保密文件。" }, { status: 409 });
      }
      let nextReviewer: { email: string; displayName: string };
      let nextPeriodKey = approval.periodKey;
      let replacementLaborClaims: LaborSourceClaimInput[] = [];
      let laborClaimRevision = "";
      if (approval.type === "流转审批") {
        const error = validateStoredCirculation(payload, await activeMembers(db), requesterEmail);
        if (error) return Response.json({ error }, { status: 409 });
        payload = { ...payload, circulationConfirmations: [], circulationApprovals: [] };
        const person = [...circulationPeople(payload.circulationRecipients), ...circulationPeople(payload.circulationApprovers)][0];
        nextReviewer = { email: person.email, displayName: person.name };
      } else if (approval.type === "技术审核") {
        if (!(asNumber(payload.totalWorkHours) > 0) || !textValue(payload.robotPart) || !textValue(payload.technicalContent)) return Response.json({ error: "技术事项材料不完整，请重新编辑机器人部分、技术内容与总工时。" }, { status: 409 });
        const normalized = await normalizeStoredDevelopers(db, payload);
        if (!normalized.developers) return Response.json({ error: normalized.error || "技术开发人信息已失效，请重新编辑申请。" }, { status: 409 });
        const firstDeveloper = normalized.developers[0];
        payload = { ...payload, developers: normalized.developers, developerConfirmations: [] };
        nextReviewer = { email: firstDeveloper.email, displayName: firstDeveloper.name };
      } else {
        const initialReviewerEmail = normalizeEmail(payload.initialReviewerEmail);
        const initialReviewerName = textValue(payload.initialReviewerName);
        const requiredPermission = approval.type === "采购审核" ? "technical_advisor" : "project_owner";
        const reviewer = (await getReviewerDirectory({ ...user, accountUserId: authorized.accountUserId })).find((item) => item.email === initialReviewerEmail
          && (approval.type === "保密协议" && ndaAgreementKind === "project_owner" ? item.isAdmin : item.ndaCompleted && item.permissions.includes(requiredPermission)));
        if (!reviewer) return Response.json({ error: "原首位审核人已失效，请重新编辑申请并选择审核人。" }, { status: 409 });
        if (reviewer.email === requesterEmail) return Response.json({ error: "申请人不能审核自己的申请，请重新编辑并选择其他实名审核人。" }, { status: 409 });
        nextReviewer = { email: reviewer.email, displayName: reviewer.displayName || initialReviewerName };
      }
      if (approval.type === "采购审核") {
        const quantity = asNumber(payload.quantity);
        const amount = asNumber(payload.amount);
        if (!textValue(payload.itemSpec) || !(quantity > 0 && Number.isInteger(quantity)) || !(amount >= 0) || !textValue(payload.purpose) || (!textValue(payload.supplier) && !textValue(payload.purchaseLink))) return Response.json({ error: "采购材料不完整，请重新编辑采购事项、数量、用途、金额和供应商/链接。" }, { status: 409 });
      }
      if (approval.type === "保密协议") {
        const rebuilt = await rebuildNdaPayload(payload, approval.requesterName, approval.requesterEmail, authorized.accountUserId || "");
        if (!rebuilt.payload) return Response.json({ error: rebuilt.error }, { status: 409 });
        payload = rebuilt.payload;
        const rebuiltKind = rebuilt.agreementKind || ndaAgreementKind || "member";
        const rebuiltVersion = rebuilt.agreementVersion || textValue(payload.agreementVersion);
        const [duplicateNda] = await db.select({ id: approvals.id }).from(approvals).where(and(eq(approvals.businessKey, ndaBusinessKeyForVersion(authorized.accountUserId || "", rebuiltVersion)), sql`${approvals.id} <> ${approval.id}`)).limit(1);
        if (duplicateNda) return Response.json({ error: "当前版本的保密协议已有另一份正式记录，不能重新提交。" }, { status: 409 });
      }
      if (approval.type === "劳务报酬") {
        const rebuilt = await rebuildLaborPayload(db, approval, payload);
        if (!rebuilt.payload || !rebuilt.periodKey) return Response.json({ error: rebuilt.error }, { status: rebuilt.conflict ? 409 : 400 });
        payload = rebuilt.payload;
        nextPeriodKey = rebuilt.periodKey;
        replacementLaborClaims = rebuilt.claims ?? [];
        laborClaimRevision = textValue(payload.laborClaimRevision);
        if (!laborClaimRevision || !replacementLaborClaims.length) return Response.json({ error: "劳务成果占用版本生成失败，请稍后重试。" }, { status: 500 });
        for (const key of ["suggestedAmount", "compensationBasis", "unitRate", "unitRateUnit", "compensationCalculation", "suggestedAmountAt", "suggestedAmountBy", "finalAmount", "financeNote", "finalAmountAt", "finalAmountBy"]) delete payload[key];
      }
      if (approval.type === "采购审核") {
        for (const key of ["purchaserEmail", "purchaserMemberId", "purchaserName", "purchaserAssignedAt", "purchaserAssignedBy", "purchaseNote", "actualAmount", "purchaseConfirmedAt", "purchaseCompletion"]) delete payload[key];
      }
      delete payload.archivedAt;
      delete payload.archivedBy;
      if (approval.currentRevisionNo + 1 + workflowRevisionsNeededAfterMaterial(approval.type, payload) > MAX_APPROVAL_REVISIONS) {
        return Response.json({ error: "该申请剩余的不可变版本空间不足以完成重新提交后的全部实名节点；请联系管理员核验并制定迁移处理方案。" }, { status: 409 });
      }
      const workflowMutationRevision = crypto.randomUUID();
      payload = { ...payload, lastResubmissionNote: note, lastResubmittedAt: new Date().toISOString(), workflowMutationRevision };
      const initialStep = approval.type === "流转审批" ? circulationPeople(payload.circulationRecipients).length ? "流转确认" : "指定审批" : approval.type === "技术审核"
        ? "开发人确认"
        : approval.type === "采购审核"
          ? "技术顾问"
          : approval.type === "保密协议" && ndaAgreementKind
            ? confidentialityAgreementReviewerStep(ndaAgreementKind)
            : "项目负责人";
      const now = new Date().toISOString();
      const resetSigners = addApprovalSigner("[]", { name: approval.requesterName, email: requesterEmail, accountUserId: authorized.accountUserId, memberId: authorized.memberId, signedAt: now });
      const resubmitAuditNote = approval.type === "劳务报酬" ? `申请人重新提交：${note}；技术成果占用已同步` : `申请人重新提交：${note}`;
      const nextBusinessKey = approval.type === "保密协议" ? ndaBusinessKeyForVersion(textValue(payload.signerAccountUserId), textValue(payload.agreementVersion)) : approval.businessKey;
      const nextState = {
        ...approval,
        status: "待审核",
        currentStep: initialStep,
        currentReviewerName: nextReviewer.displayName,
        currentReviewerEmail: nextReviewer.email,
        summary: `${approval.summary}\n\n补充说明：${note}`.slice(0, 4000),
        amount: approval.type === "采购审核" ? approval.amount : null,
        payloadJson: JSON.stringify(payload),
        periodKey: nextPeriodKey,
        signersJson: resetSigners,
        businessKey: nextBusinessKey,
        updatedAt: now,
      };
      const revisionPlan = await planApprovalRevisions({
        previousApproval: approval as unknown as Record<string, unknown>,
        nextApproval: nextState as unknown as Record<string, unknown>,
        workflowMutationRevision,
        event: { actorName: user.displayName, actorEmail: currentEmail, action, note: resubmitAuditNote, occurredAt: now },
        shouldWrite: true,
      });
      const previousRevisionPointerMatches = approval.currentRevisionHash ? eq(approvals.currentRevisionHash, approval.currentRevisionHash) : isNull(approvals.currentRevisionHash);
      const update = db.update(approvals).set({ ...nextState, currentRevisionNo: revisionPlan.currentRevisionNo, currentRevisionHash: revisionPlan.currentRevisionHash }).where(and(eq(approvals.id, id), eq(approvals.updatedAt, approval.updatedAt), eq(approvals.payloadJson, approval.payloadJson), eq(approvals.currentRevisionNo, approval.currentRevisionNo), previousRevisionPointerMatches, sql`lower(${approvals.requesterEmail}) = ${currentEmail}`, actorGuard)).returning();
      const revisionWrites = revisionPlan.revisions.map((revision) => conditionalApprovalRevisionInsert(db, id, now, workflowMutationRevision, revisionPlan.currentRevisionNo, revisionPlan.currentRevisionHash!, revision));
      if (approval.type === "劳务报酬") {
        const approvalWasUpdated = exists(db.select({ id: approvals.id }).from(approvals).where(and(
          eq(approvals.id, id),
          eq(approvals.updatedAt, now),
          sql`json_extract(${approvals.payloadJson}, '$.workflowMutationRevision') = ${workflowMutationRevision}`,
          sql`json_extract(${approvals.payloadJson}, '$.laborClaimRevision') = ${laborClaimRevision}`,
        )));
        const deleteOldClaims = db.delete(laborSourceClaims).where(and(eq(laborSourceClaims.laborApprovalId, id), approvalWasUpdated)).returning({ id: laborSourceClaims.id });
        const insertClaims = replacementLaborClaims.map((claim) => conditionalLaborClaimInsert(db, id, now, laborClaimRevision, claim));
        const event = conditionalApprovalEvent(db, id, now, workflowMutationRevision, { actorName: user.displayName, actorEmail: currentEmail, action, note: resubmitAuditNote });
        const results = await db.batch([update, deleteOldClaims, ...insertClaims, ...revisionWrites, event]);
        const updated = (results[0] as Array<typeof approvals.$inferSelect>)[0];
        if (!updated) return Response.json({ error: "申请刚刚已被其他操作更新，请刷新后重试。" }, { status: 409 });
        const claimResults = results.slice(2, 2 + insertClaims.length) as Array<Array<{ id: string }>>;
        if (claimResults.length !== replacementLaborClaims.length || claimResults.some((claimRows) => !claimRows[0])) return Response.json({ error: "劳务成果占用未能同步，请联系管理员核查。" }, { status: 500 });
        const revisionResults = results.slice(2 + insertClaims.length, -1) as Array<Array<{ revisionHash: string }>>;
        if (revisionResults.length !== revisionWrites.length || revisionResults.some((revisionRows) => !revisionRows[0])) return Response.json({ error: "申请状态已更新，但不可变材料版本未写入，请联系管理员核查。" }, { status: 500 });
        const eventRows = results.at(-1) as Array<{ id: number }>;
        if (!eventRows[0]) return Response.json({ error: "申请状态已更新，但审核记录未写入，请联系管理员核查。" }, { status: 500 });
        return Response.json({ approval: serializeActionApproval(updated, authorized) }, { headers: PRIVATE_JSON_HEADERS });
      }
      const event = conditionalApprovalEvent(db, id, now, workflowMutationRevision, { actorName: user.displayName, actorEmail: currentEmail, action, note: resubmitAuditNote });
      const results = await db.batch([update, ...revisionWrites, event]);
      const updatedRows = results[0] as Array<typeof approvals.$inferSelect>;
      const eventRows = results.at(-1) as Array<{ id: number }>;
      const updated = updatedRows[0];
      if (!updated) return Response.json({ error: "申请刚刚已被其他操作更新，请刷新后重试。" }, { status: 409 });
      const revisionResults = results.slice(1, -1) as Array<Array<{ revisionHash: string }>>;
      if (revisionResults.length !== revisionWrites.length || revisionResults.some((revisionRows) => !revisionRows[0])) return Response.json({ error: "申请状态已更新，但不可变材料版本未写入，请联系管理员核查。" }, { status: 500 });
      if (!eventRows[0]) return Response.json({ error: "申请状态已更新，但审核记录未写入，请联系管理员核查。" }, { status: 500 });
      return Response.json({ approval: serializeActionApproval(updated, authorized) }, { headers: PRIVATE_JSON_HEADERS });
    }

    if (action === "return" && !note) return Response.json({ error: "退回申请必须填写退回原因。" }, { status: 400 });

    let nextStep = nextWorkflowStep(approval.type, approval.currentStep, action as Exclude<ApprovalAction, "resubmit" | "withdraw" | "void" | "archive_note">);
    if (!nextStep) return Response.json({ error: "当前节点没有定义下一步流程。" }, { status: 409 });
    let nextReviewer: { email: string; displayName: string } | null = null;
    let signersJson = approval.signersJson;
    let nextAmount = approval.amount;
    const now = new Date().toISOString();
    const initialReviewerEmail = normalizeEmail(payload.initialReviewerEmail);

    if (approval.type === "流转审批" && (action === "confirm_circulation" || action === "approve")) {
      const error = validateStoredCirculation(payload, await activeMembers(db), requesterEmail);
      if (error) return Response.json({ error }, { status: 409 });
      if (action === "approve" && pendingCirculationPeople(payload, "流转确认").length) return Response.json({ error: "仍有流转对象未确认，暂不能审批。" }, { status: 409 });
      const key = action === "confirm_circulation" ? "circulationConfirmations" : "circulationApprovals";
      const decisions = Array.isArray(payload[key]) ? payload[key] as unknown[] : [];
      payload = { ...payload, [key]: [...decisions, { memberId: authorized.memberId, accountUserId: authorized.accountUserId, email: currentEmail, name: user.displayName, confirmedAt: now, note }] };
      signersJson = addApprovalSigner(signersJson, { name: user.displayName, email: currentEmail, accountUserId: authorized.accountUserId, memberId: authorized.memberId, signedAt: now });
      const remaining = pendingCirculationPeople(payload, approval.currentStep);
      if (remaining.length) nextStep = approval.currentStep;
      else if (action === "confirm_circulation") nextStep = circulationPeople(payload.circulationApprovers).length ? "指定审批" : "已归档";
      else nextStep = "已归档";
      const nextPeople = pendingCirculationPeople(payload, nextStep);
      if (nextPeople.length) nextReviewer = { email: nextPeople[0].email, displayName: nextPeople.map((person) => person.name).join("、") };
    }

    // Re-check duty separation at every decisive transition so records created
    // before this policy cannot be completed through a legacy role collision.
    if (action === "approve" && approval.currentStep === "项目负责人") {
      if (!hasDistinctVerifiedEmails(requesterEmail, currentEmail)) return Response.json({ error: "申请人与项目负责人必须由不同实名账号担任。" }, { status: 409 });
      if ((approval.type === "技术审核" || approval.type === "采购审核") && !hasDistinctVerifiedEmails(requesterEmail, initialReviewerEmail, currentEmail)) {
        return Response.json({ error: "申请人、技术顾问与项目负责人必须由不同实名账号担任；请退回后重新指定。" }, { status: 409 });
      }
      if (approval.type === "技术审核" && Array.isArray(payload.developers) && payload.developers.some((item) => normalizeEmail((item as TechnicalDeveloper).email) === currentEmail)) {
        return Response.json({ error: "技术开发人不能同时担任本事项的项目负责人审核人；请退回后重新指定。" }, { status: 409 });
      }
    }
    if (action === "approve" && approval.type === "劳务报酬" && approval.currentStep === "经费负责人" && !hasDistinctVerifiedEmails(requesterEmail, initialReviewerEmail, currentEmail)) {
      const recommendationIdentity = payload.suggestedAmountBy as { email?: unknown; accountUserId?: unknown } | undefined;
      const configuredDualReview = initialReviewerEmail === currentEmail
        && requesterEmail !== currentEmail
        && normalizeEmail(recommendationIdentity?.email) === currentEmail
        && textValue(recommendationIdentity?.accountUserId) === authorized.accountUserId
        && canCombineLaborReviewRoles(authorized);
      if (!configuredDualReview) return Response.json({ error: "劳务申请人不能审核本人申请；只有明确配置兼任的同一实名负责人可以分别完成项目建议与经费终审。" }, { status: 409 });
    }

    if (action === "confirm_developer") {
      const normalized = await normalizeStoredDevelopers(db, payload);
      if (!normalized.developers) return Response.json({ error: normalized.error || "技术开发人信息异常。" }, { status: 409 });
      const pending = getPendingDeveloper(normalized.developers, payload.developerConfirmations);
      if (!pending.pendingDeveloper || !pending.confirmations) return Response.json({ error: pending.error || "所有开发人均已确认，请刷新流程。" }, { status: 409 });
      if (pending.pendingDeveloper.email !== currentEmail || pending.pendingDeveloper.name !== user.displayName.trim() || pending.pendingDeveloper.memberId !== authorized.memberId) return Response.json({ error: `当前只能由第 ${(pending.pendingIndex ?? 0) + 1} 位开发人 ${pending.pendingDeveloper.name} 本人确认。` }, { status: 403 });
      const confirmations = [...pending.confirmations, { memberId: pending.pendingDeveloper.memberId, email: pending.pendingDeveloper.email, name: pending.pendingDeveloper.name, confirmedAt: now }];
      payload = { ...payload, developers: normalized.developers, developerConfirmations: confirmations };
      signersJson = addApprovalSigner(signersJson, { name: pending.pendingDeveloper.name, email: currentEmail, accountUserId: authorized.accountUserId, memberId: authorized.memberId, signedAt: now });
      const followingDeveloper = normalized.developers[confirmations.length];
      if (followingDeveloper) {
        nextStep = "开发人确认";
        nextReviewer = { email: followingDeveloper.email, displayName: followingDeveloper.name };
      } else {
        const advisorEmail = normalizeEmail(payload.initialReviewerEmail);
        const advisor = (await getReviewerDirectory({ ...user, accountUserId: authorized.accountUserId })).find((item) => item.email === advisorEmail && item.ndaCompleted && item.permissions.includes("technical_advisor"));
        if (!advisor) return Response.json({ error: "原指定技术顾问已失效，请联系申请人重新提交。" }, { status: 409 });
        if (advisor.email === requesterEmail) return Response.json({ error: "申请人不能担任本人申请的技术顾问，请联系管理员退回后重新选择。" }, { status: 409 });
        if (normalized.developers.some((developer) => developer.email === advisor.email)) return Response.json({ error: "技术开发人不能同时担任本事项的技术顾问，请联系管理员退回后重新选择。" }, { status: 409 });
        nextStep = "技术顾问";
        nextReviewer = { email: advisor.email, displayName: advisor.displayName };
      }
    }

    if (action === "approve" && approval.currentStep === "技术顾问") {
      const nextReviewerEmail = normalizeEmail(body.nextReviewerEmail);
      if (!nextReviewerEmail) return Response.json({ error: "请选择下一位项目负责人，或选择退回。" }, { status: 400 });
      const candidate = (await getReviewerDirectory({ ...user, accountUserId: authorized.accountUserId })).find((item) => item.email === nextReviewerEmail && item.ndaCompleted && item.permissions.includes("project_owner"));
      if (!candidate) return Response.json({ error: "下一位审核人必须是已授权的项目负责人。" }, { status: 400 });
      if (!hasDistinctVerifiedEmails(requesterEmail, currentEmail, candidate.email)) return Response.json({ error: "申请人、技术顾问与项目负责人必须由三个不同的实名账号担任。" }, { status: 400 });
      if (approval.type === "技术审核" && Array.isArray(payload.developers) && payload.developers.some((item) => normalizeEmail((item as TechnicalDeveloper).email) === candidate.email)) return Response.json({ error: "技术开发人不能同时担任本事项的项目负责人审核人。" }, { status: 400 });
      nextReviewer = { email: candidate.email, displayName: candidate.displayName };
      signersJson = addApprovalSigner(signersJson, { name: user.displayName, email: currentEmail, accountUserId: authorized.accountUserId, memberId: authorized.memberId, signedAt: now });
    }

    if (action === "approve" && approval.type === "采购审核" && approval.currentStep === "项目负责人") {
      const purchaserEmail = normalizeEmail(body.purchaserEmail);
      if (!purchaserEmail) return Response.json({ error: "请由项目负责人指定统一采购成员。" }, { status: 400 });
      if (!hasDistinctVerifiedEmails(requesterEmail, initialReviewerEmail, currentEmail, purchaserEmail)) return Response.json({ error: "申请人、技术顾问、项目负责人和统一采购成员必须由不同实名账号担任。" }, { status: 400 });
      const [purchaser] = await db.select({ id: members.id, fullName: members.fullName, chatgptAccount: members.chatgptAccount, accountUserId: members.accountUserId, role: members.role, permissionsJson: members.permissionsJson, ndaAcceptedAt: members.ndaAcceptedAt, ndaAgreementVersion: members.ndaAgreementVersion }).from(members).where(and(eq(members.chatgptAccount, purchaserEmail), eq(members.status, "active"))).limit(1);
      if (!purchaser || !isNdaAdmittedMember(purchaser)) return Response.json({ error: "指定采购成员必须是已完成保密协议归档的当前有效成员。" }, { status: 400 });
      payload = { ...payload, purchaserEmail: normalizeEmail(purchaser.chatgptAccount), purchaserMemberId: purchaser.id, purchaserName: purchaser.fullName, purchaserAssignedAt: now, purchaserAssignedBy: { email: currentEmail, name: user.displayName } };
      nextReviewer = { email: normalizeEmail(purchaser.chatgptAccount), displayName: purchaser.fullName };
      signersJson = addApprovalSigner(signersJson, { name: user.displayName, email: currentEmail, accountUserId: authorized.accountUserId, memberId: authorized.memberId, signedAt: now });
    }

    if (action === "confirm_purchase") {
      const purchaserEmail = normalizeEmail(payload.purchaserEmail);
      if (purchaserEmail !== currentEmail) return Response.json({ error: "只有申请中指定的采购成员本人可以确认采购完成。" }, { status: 403 });
      const purchaserAssignment = payload.purchaserAssignedBy && typeof payload.purchaserAssignedBy === "object" && !Array.isArray(payload.purchaserAssignedBy) ? payload.purchaserAssignedBy as Record<string, unknown> : {};
      const projectOwnerEmail = normalizeEmail(purchaserAssignment.email);
      if (!hasDistinctVerifiedEmails(requesterEmail, initialReviewerEmail, projectOwnerEmail, currentEmail) || textValue(payload.purchaserMemberId) !== authorized.memberId) {
        return Response.json({ error: "采购职责分离或实名成员绑定记录不完整，不能直接归档；请退回后重新指定。" }, { status: 409 });
      }
      const purchaseNote = textValue(body.purchaseNote ?? body.note);
      if (purchaseNote.length < 5) return Response.json({ error: "请填写实际采购说明，至少 5 个字。" }, { status: 400 });
      if (purchaseNote.length > 1000) return Response.json({ error: "实际采购说明不能超过 1000 字。" }, { status: 400 });
      const actualAmountInput = body.actualAmount;
      const hasActualAmount = typeof actualAmountInput === "number" ? Number.isFinite(actualAmountInput) : textValue(actualAmountInput) !== "";
      const actualAmount = hasActualAmount ? asNumber(actualAmountInput) : NaN;
      const approvedAmount = asNumber(payload.amount);
      if (!hasActualAmount || !(actualAmount >= 0)) return Response.json({ error: "请填写实际采购金额，金额必须大于或等于 0。" }, { status: 400 });
      if (!(approvedAmount >= 0)) return Response.json({ error: "获批采购金额记录无效，不能确认归档。" }, { status: 409 });
      if (round(actualAmount) > round(approvedAmount)) return Response.json({ error: "实际采购金额不能高于获批预计金额；如需超额采购，请退回并重新提交审核。" }, { status: 409 });
      payload = {
        ...payload,
        purchaseNote,
        actualAmount: round(actualAmount),
        purchaseConfirmedAt: now,
        purchaseCompletion: { purchaserMemberId: textValue(payload.purchaserMemberId), purchaserEmail: currentEmail, purchaserName: user.displayName, purchaseNote, actualAmount: round(actualAmount), confirmedAt: now },
      };
      nextAmount = formatAmount(round(actualAmount));
      signersJson = addApprovalSigner(signersJson, { name: user.displayName, email: currentEmail, accountUserId: authorized.accountUserId, memberId: authorized.memberId, signedAt: now });
    }

    if (action === "approve" && approval.type === "劳务报酬" && approval.currentStep === "项目负责人") {
      const amount = asNumber(body.suggestedAmount);
      const compensationBasis = textValue(body.compensationBasis ?? body.suggestedAmountBasis);
      const totalScore = asNumber(payload.totalScore);
      if (!(amount > 0)) return Response.json({ error: "请填写项目负责人建议的劳务报酬金额。" }, { status: 400 });
      if (compensationBasis.length < 10) return Response.json({ error: "请填写建议劳务报酬依据，至少 10 个字。" }, { status: 400 });
      if (compensationBasis.length > 2000) return Response.json({ error: "建议劳务报酬依据不能超过 2000 字。" }, { status: 400 });
      if (!(totalScore > 0)) return Response.json({ error: "劳务贡献总分无效，不能计算劳务报酬单价。" }, { status: 409 });
      const suggestedAmount = round(amount);
      const unitRate = round(suggestedAmount / totalScore, 4);
      payload = {
        ...payload,
        suggestedAmount,
        compensationBasis,
        unitRate,
        unitRateUnit: "元/贡献分",
        compensationCalculation: { formula: "建议金额 ÷ 贡献总分", totalScore: round(totalScore), suggestedAmount, unitRate, calculatedAt: now },
        suggestedAmountAt: now,
        suggestedAmountBy: { email: currentEmail, name: user.displayName, accountUserId: authorized.accountUserId },
      };
      const excludedFinanceEmails = canCombineLaborReviewRoles(authorized) ? [requesterEmail] : [requesterEmail, currentEmail];
      const financeOwner = await eligibleFinanceOwner(db, excludedFinanceEmails);
      if (!financeOwner) return Response.json({ error: "没有符合职责配置且已完成保密协议的经费负责人，暂时无法流转劳务报酬申请。" }, { status: 503 });
      nextReviewer = financeOwner;
      nextAmount = formatAmount(suggestedAmount);
      signersJson = addApprovalSigner(signersJson, { name: user.displayName, email: currentEmail, accountUserId: authorized.accountUserId, memberId: authorized.memberId, signedAt: now });
    }

    if (action === "approve" && approval.type === "劳务报酬" && approval.currentStep === "经费负责人") {
      const finalAmount = asNumber(body.finalAmount);
      const suggestedAmount = asNumber(payload.suggestedAmount);
      const financeNote = textValue(body.financeNote);
      if (!(finalAmount > 0) || !(suggestedAmount > 0)) return Response.json({ error: "请填写有效的最终审核金额。" }, { status: 400 });
      if (round(finalAmount) !== round(suggestedAmount) && !financeNote) return Response.json({ error: "最终金额与建议金额不一致时，必须填写经费审核说明。" }, { status: 400 });
      if (financeNote.length > 1000) return Response.json({ error: "经费审核说明不能超过 1000 字。" }, { status: 400 });
      payload = { ...payload, finalAmount: round(finalAmount), financeNote, finalAmountAt: now, finalAmountBy: { email: currentEmail, name: user.displayName, accountUserId: authorized.accountUserId } };
      nextAmount = formatAmount(round(finalAmount));
      signersJson = addApprovalSigner(signersJson, { name: user.displayName, email: currentEmail, accountUserId: authorized.accountUserId, memberId: authorized.memberId, signedAt: now });
    }

    if (action === "approve" && approval.type === "保密协议" && (approval.currentStep === "项目负责人" || approval.currentStep === "OA管理员")) {
      const [ndaRequester] = await db.select({ accountUserId: members.accountUserId, role: members.role, permissionsJson: members.permissionsJson }).from(members).where(and(eq(members.chatgptAccount, requesterEmail), eq(members.status, "active"))).limit(1);
      if (!ndaRequester?.accountUserId) return Response.json({ error: "保密协议申请人尚未绑定有效的认证账户主体，不能完成归档。" }, { status: 409 });
      const requesterRole = isProjectOwner(requesterEmail, ndaRequester.accountUserId)
        || parseMemberPermissions(ndaRequester.role, ndaRequester.permissionsJson).includes("project_owner")
        ? "project_owner"
        : "member";
      const expectedAgreementKind = confidentialityAgreementKindForRole(requesterRole);
      const storedAgreementKind = confidentialityAgreementKindFromPayload(payload);
      if (storedAgreementKind !== expectedAgreementKind || approval.currentStep !== confidentialityAgreementReviewerStep(expectedAgreementKind)) {
        return Response.json({ error: "申请人的角色或保密文件类型已经变化，请由申请人重新签署当前角色对应的保密文件。" }, { status: 409 });
      }
      if (expectedAgreementKind === "member" && textValue(payload.agreementVersion) !== LEGACY_NDA_AGREEMENT_VERSION) {
        return Response.json({ error: "当前版本成员保密协议应由本人签署后直接归档；请由申请人撤回并重新签署。" }, { status: 409 });
      }
      const rebuilt = await rebuildNdaPayload(payload, approval.requesterName, approval.requesterEmail, ndaRequester.accountUserId);
      if (!rebuilt.payload) return Response.json({ error: rebuilt.error }, { status: 409 });
      payload = rebuilt.payload;
      signersJson = addApprovalSigner(signersJson, { name: user.displayName, email: currentEmail, accountUserId: authorized.accountUserId, memberId: authorized.memberId, signedAt: now });
    }

    if (action === "approve" && approval.currentStep === "项目负责人" && approval.type !== "采购审核" && approval.type !== "劳务报酬" && approval.type !== "保密协议") {
      signersJson = addApprovalSigner(signersJson, { name: user.displayName, email: currentEmail, accountUserId: authorized.accountUserId, memberId: authorized.memberId, signedAt: now });
    }

    const isReturn = action === "return" || action === "force_return";
    const isFinal = nextStep === "已归档";
    if (isFinal) payload = { ...payload, archivedAt: now, archivedBy: { email: currentEmail, name: user.displayName } };
    const workflowMutationRevision = crypto.randomUUID();
    payload = { ...payload, workflowMutationRevision };
    const nextStatus = isReturn ? "已退回" : isFinal ? "已归档" : "审批中";
    const nextReviewerName = isReturn ? approval.requesterName : nextReviewer?.displayName ?? (isFinal ? "" : approval.currentReviewerName);
    const nextReviewerEmail = isReturn ? approval.requesterEmail : nextReviewer?.email ?? (isFinal ? "" : approval.currentReviewerEmail);
    const transitionNote = isReturn
      ? action === "force_return"
        ? `管理员未代签；因异常流程强制退回申请人补充材料。原处理人：${approval.currentReviewerName}（${approval.currentReviewerEmail}）；原因：${note}`
        : `已退回申请人补充材料：${note}`
      : nextReviewer
        ? `已转交给${nextReviewer.displayName}（${nextReviewer.email}）`
        : isFinal ? "流程完成并归档" : "流程节点已更新";
    const laborReviewLabel = approval.type === "劳务报酬" && action === "approve"
      ? approval.currentStep === "项目负责人" ? "项目负责人建议；" : "经费负责人终审；"
      : "";
    const eventNote = action === "force_return" ? transitionNote : `${laborReviewLabel}${note}${note ? "；" : ""}${transitionNote}`;
    const finalAgreementKind = approval.type === "保密协议" ? confidentialityAgreementKindFromPayload(payload) : null;
    if (approval.type === "保密协议" && isFinal && !finalAgreementKind) return Response.json({ error: "保密文件类型或版本无效，不能归档。" }, { status: 409 });
    const nextBusinessKey = approval.type === "保密协议" && isFinal ? ndaBusinessKeyForVersion(textValue(payload.signerAccountUserId), textValue(payload.agreementVersion)) : approval.businessKey;
    const nextState = {
      ...approval,
      status: nextStatus,
      currentStep: nextStep,
      currentReviewerName: nextReviewerName,
      currentReviewerEmail: nextReviewerEmail,
      amount: nextAmount,
      payloadJson: JSON.stringify(payload),
      periodKey: approval.periodKey,
      signersJson,
      businessKey: nextBusinessKey,
      updatedAt: now,
    };
    const revisionPlan = await planApprovalRevisions({
      previousApproval: approval as unknown as Record<string, unknown>,
      nextApproval: nextState as unknown as Record<string, unknown>,
      workflowMutationRevision,
      event: { actorName: user.displayName, actorEmail: currentEmail, action, note: eventNote, occurredAt: now },
      shouldWrite: true,
    });
    const previousRevisionPointerMatches = approval.currentRevisionHash ? eq(approvals.currentRevisionHash, approval.currentRevisionHash) : isNull(approvals.currentRevisionHash);
    const ndaSignerAccountUserId = textValue(payload.signerAccountUserId);
    const ndaRequesterIsConfiguredOwner = approval.type === "保密协议" && finalAgreementKind
      ? isProjectOwner(requesterEmail, ndaSignerAccountUserId)
      : false;
    const ndaSubjectRoleGuard = finalAgreementKind === "project_owner"
      ? ndaRequesterIsConfiguredOwner
        ? sql`1 = 1`
        : sql`(nda_subject.role = 'project_owner' OR CASE WHEN json_valid(nda_subject.permissions_json) THEN EXISTS (SELECT 1 FROM json_each(nda_subject.permissions_json) WHERE value = 'project_owner') ELSE 0 END)`
      : ndaRequesterIsConfiguredOwner
        ? sql`0 = 1`
        : sql`NOT (nda_subject.role = 'project_owner' OR CASE WHEN json_valid(nda_subject.permissions_json) THEN EXISTS (SELECT 1 FROM json_each(nda_subject.permissions_json) WHERE value = 'project_owner') ELSE 0 END)`;
    const ndaSubjectGuard = approval.type === "保密协议" && isFinal
      ? sql`EXISTS (SELECT 1 FROM members AS nda_subject WHERE lower(nda_subject.chatgpt_account) = ${requesterEmail} AND nda_subject.status = 'active' AND nda_subject.account_user_id = ${ndaSignerAccountUserId} AND ${ndaSubjectRoleGuard})`
      : sql`1 = 1`;
    const update = db.update(approvals).set({ ...nextState, currentRevisionNo: revisionPlan.currentRevisionNo, currentRevisionHash: revisionPlan.currentRevisionHash }).where(and(eq(approvals.id, id), eq(approvals.updatedAt, approval.updatedAt), eq(approvals.payloadJson, approval.payloadJson), eq(approvals.currentRevisionNo, approval.currentRevisionNo), previousRevisionPointerMatches, actorGuard, ndaSubjectGuard)).returning();
    const revisionWrites = revisionPlan.revisions.map((revision) => conditionalApprovalRevisionInsert(db, id, now, workflowMutationRevision, revisionPlan.currentRevisionNo, revisionPlan.currentRevisionHash!, revision));
    const event = conditionalApprovalEvent(db, id, now, workflowMutationRevision, { actorName: user.displayName, actorEmail: currentEmail, action, note: eventNote });

    let updated: typeof approvals.$inferSelect | undefined;
    if (isFinal && approval.type === "保密协议") {
      const signerAccountUserId = textValue(payload.signerAccountUserId);
      const agreementKind = finalAgreementKind || "member";
      const archivedAgreementVersion = textValue(payload.agreementVersion);
      if (!confidentialityAgreementVersions(agreementKind).includes(archivedAgreementVersion)) return Response.json({ error: "保密文件正文版本无法验证，不能完成归档。" }, { status: 409 });
      const canonicalNdaBusinessKey = ndaBusinessKeyForVersion(signerAccountUserId, archivedAgreementVersion);
      const [ndaMember] = await db.select({ id: members.id, accountUserId: members.accountUserId, role: members.role, permissionsJson: members.permissionsJson }).from(members).where(and(eq(members.chatgptAccount, requesterEmail), eq(members.status, "active"), eq(members.accountUserId, signerAccountUserId))).limit(1);
      if (!ndaMember) return Response.json({ error: "保密协议申请人已不是有效成员，不能完成归档。" }, { status: 409 });
      const currentRequesterRole = isProjectOwner(requesterEmail, signerAccountUserId)
        || parseMemberPermissions(ndaMember.role, ndaMember.permissionsJson).includes("project_owner")
        ? "project_owner"
        : "member";
      if (confidentialityAgreementKindForRole(currentRequesterRole) !== agreementKind) return Response.json({ error: "申请人的角色已经变化，当前保密文件不能用于准入。" }, { status: 409 });
      const ndaMemberRoleGuard = agreementKind === "project_owner"
        ? ndaRequesterIsConfiguredOwner
          ? sql`1 = 1`
          : sql`(${members.role} = 'project_owner' OR CASE WHEN json_valid(${members.permissionsJson}) THEN EXISTS (SELECT 1 FROM json_each(${members.permissionsJson}) WHERE value = 'project_owner') ELSE 0 END)`
        : ndaRequesterIsConfiguredOwner
          ? sql`0 = 1`
          : sql`NOT (${members.role} = 'project_owner' OR CASE WHEN json_valid(${members.permissionsJson}) THEN EXISTS (SELECT 1 FROM json_each(${members.permissionsJson}) WHERE value = 'project_owner') ELSE 0 END)`;
      const approvalWasArchived = exists(db.select({ id: approvals.id }).from(approvals).where(and(
        eq(approvals.id, approval.id),
        eq(approvals.updatedAt, now),
        eq(approvals.status, "已归档"),
        eq(approvals.businessKey, canonicalNdaBusinessKey),
        sql`json_extract(${approvals.payloadJson}, '$.agreementKind') = ${agreementKind}`,
        sql`json_extract(${approvals.payloadJson}, '$.agreementVersion') = ${archivedAgreementVersion}`,
        sql`json_extract(${approvals.payloadJson}, '$.workflowMutationRevision') = ${workflowMutationRevision}`,
        sql`json_extract(${approvals.payloadJson}, '$.signerAccountUserId') = ${signerAccountUserId}`,
      )));
      const updateMember = db.update(members).set({ ndaAcceptedAt: now, ndaApprovalId: approval.id, ndaAgreementVersion: archivedAgreementVersion }).where(and(eq(members.id, ndaMember.id), eq(members.status, "active"), eq(members.accountUserId, signerAccountUserId), ndaMemberRoleGuard, approvalWasArchived)).returning({ id: members.id });
      const results = await db.batch([update, ...revisionWrites, event, updateMember]);
      const updatedRows = results[0] as Array<typeof approvals.$inferSelect>;
      const eventRows = results.at(-2) as Array<{ id: number }>;
      const updatedMembers = results.at(-1) as Array<{ id: string }>;
      updated = updatedRows[0];
      if (!updated) return Response.json({ error: "申请刚刚已被其他操作更新，请刷新后重试。" }, { status: 409 });
      const revisionResults = results.slice(1, -2) as Array<Array<{ revisionHash: string }>>;
      if (revisionResults.length !== revisionWrites.length || revisionResults.some((revisionRows) => !revisionRows[0])) return Response.json({ error: "保密协议已归档，但不可变材料版本未写入，请联系管理员核查。" }, { status: 500 });
      if (!eventRows[0]) return Response.json({ error: "保密协议已归档，但审核记录未写入，请联系管理员核查。" }, { status: 500 });
      if (!updatedMembers[0]) return Response.json({ error: "成员保密协议状态未能同步，请刷新后重试。" }, { status: 409 });
    } else {
      const results = await db.batch([update, ...revisionWrites, event]);
      const updatedRows = results[0] as Array<typeof approvals.$inferSelect>;
      const eventRows = results.at(-1) as Array<{ id: number }>;
      updated = updatedRows[0];
      if (!updated) return Response.json({ error: "申请刚刚已被其他操作更新，请刷新后重试。" }, { status: 409 });
      const revisionResults = results.slice(1, -1) as Array<Array<{ revisionHash: string }>>;
      if (revisionResults.length !== revisionWrites.length || revisionResults.some((revisionRows) => !revisionRows[0])) return Response.json({ error: "申请状态已更新，但不可变材料版本未写入，请联系管理员核查。" }, { status: 500 });
      if (!eventRows[0]) return Response.json({ error: "申请状态已更新，但审核记录未写入，请联系管理员核查。" }, { status: 500 });
    }
    return Response.json({ approval: serializeActionApproval(updated, authorized) }, { headers: PRIVATE_JSON_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/period_key/i.test(message)) return Response.json({ error: "该月份已有正式劳务报酬申请，请刷新后查看。" }, { status: 409 });
    if (/labor_source_claims|member_technical_unique/i.test(message)) return Response.json({ error: "所选技术成果已被当前成员的另一份正式劳务报酬申请占用。" }, { status: 409 });
    return Response.json({ error: "审核动作保存失败，请稍后重试。" }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authorized = await getAuthorizedUser();
  if (!authorized) return Response.json({ error: "请先完成成员注册。" }, { status: 401 });
  const { id } = await params;
  try {
    const db = await getDb();
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, id)).limit(1);
    if (!approval) return Response.json({ error: "申请不存在。" }, { status: 404 });
    const isOwnRecord = normalizeEmail(approval.requesterEmail) === normalizeEmail(authorized.user.email);
    if (!isOwnRecord) return Response.json({ error: "申请不存在或当前账号不可操作。" }, { status: 404 });
    return Response.json({ error: "申请记录不再直接删除。草稿或已撤回申请请使用“作废”，系统会保留完整记录并停止流转。" }, { status: 409, headers: PRIVATE_JSON_HEADERS });
  } catch {
    return Response.json({ error: "申请状态读取失败，请稍后重试。" }, { status: 500 });
  }
}

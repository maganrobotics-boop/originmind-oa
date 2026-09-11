import { and, count, desc, eq, exists, isNull, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import { approvalRevisions, approvals, laborSourceClaims, members } from "../../../db/schema";
import {
  APPROVAL_TYPES,
  asNumber,
  createNdaIntegrityRecord,
  hasDistinctVerifiedEmails,
  hasCompletedNda,
  holdsLaborReservation,
  isApprovalType,
  isReusedReturnedNdaSignature,
  isValidLaborMonth,
  monthKeyInShanghai,
  normalizeEmail,
  normalizeTechnicalDevelopers,
  parseJsonObject,
  round,
  textValue,
  validatePngSignatureDataUrl,
  validatePngSignatureInk,
  workflowRevisionsNeededAfterMaterial,
  type ApprovalType,
  type TechnicalDeveloper,
} from "../../../lib/approval-policy";
import { circulationPeople, isCirculationParticipant, normalizeCirculationSelection } from "../../../lib/circulation-policy";
import { addApprovalSigner, approvalSignerLabels } from "../../../lib/approval-signers";
import { assertMemberNdaAdmissionInBatch, conditionalApprovalEvent, conditionalLaborClaimInsert } from "../../../lib/workflow-write-store";
import { readBoundedJsonObject } from "../../../lib/bounded-json-request";
import { consumeWriteRateLimit } from "../../../lib/write-rate-limit";
import {
  confidentialityAgreementKindForRole,
  confidentialityAgreementKindFromPayload,
  confidentialityAgreementReviewerStep,
  confidentialityAgreementTitle,
  confidentialityAgreementVersion,
  ndaBusinessKey,
  shouldAutoArchiveConfidentialityAgreement,
} from "../../../lib/nda-agreement";
import { conditionalApprovalRevisionInsert, planApprovalRevisions } from "../../../lib/approval-revision-store";
import { authorizedMemberGuard, getAuthorizedUser, getReviewerDirectory, isNdaAdmittedMember } from "../_lib/auth";

const PROJECT = "OriginMind × ARTS Robotics 联合研发项目";
const PRIVATE_JSON_HEADERS = { "cache-control": "private, no-store" };
const MAX_APPROVAL_REQUEST_BYTES = 160_000;
const MAX_WRITES_PER_MINUTE = 20;
const MAX_RETURNED_MATERIAL_REVISIONS = 20;
const MAX_STANDARD_APPROVAL_REVISIONS = 128;

type LaborSourceClaimInput = {
  claimantMemberId: string;
  claimantEmail: string;
  technicalApprovalId: string;
};

function canSeePayload(row: typeof approvals.$inferSelect, authorized: NonNullable<Awaited<ReturnType<typeof getAuthorizedUser>>>) {
  const email = normalizeEmail(authorized.user.email);
  return authorized.isAdmin
    || authorized.role === "project_owner"
    || (authorized.isFinanceOwner && row.type === "劳务报酬")
    || (row.type === "流转审批" && row.status !== "草稿" && isCirculationParticipant(parseJsonObject(row.payloadJson), email))
    || normalizeEmail(row.requesterEmail) === email
    || normalizeEmail(row.currentReviewerEmail) === email;
}

function approvalListSelection(currentEmail: string) {
  return {
    id: approvals.id,
    type: approvals.type,
    title: approvals.title,
    project: approvals.project,
    requesterName: approvals.requesterName,
    requesterEmail: approvals.requesterEmail,
    clientCreationKey: approvals.clientCreationKey,
    businessKey: approvals.businessKey,
    createdAt: approvals.createdAt,
    updatedAt: approvals.updatedAt,
    status: approvals.status,
    currentStep: approvals.currentStep,
    currentReviewerName: approvals.currentReviewerName,
    currentReviewerEmail: approvals.currentReviewerEmail,
    summary: approvals.summary,
    owner: approvals.owner,
    amount: approvals.amount,
    periodKey: approvals.periodKey,
    signersJson: approvals.signersJson,
    // List views receive editable material only for the current user's own
    // draft/returned record. Other rows expose a bounded projection needed for
    // contribution/month selectors; full materials load through the detail API.
    payloadJson: sql<string>`CASE
      WHEN NOT json_valid(${approvals.payloadJson}) THEN '{}'
      WHEN lower(${approvals.requesterEmail}) = ${currentEmail} AND ${approvals.status} IN ('草稿', '已退回', '已撤回') THEN json_remove(${approvals.payloadJson}, '$.signatureDataUrl')
      WHEN ${approvals.type} = '保密协议' THEN json_object(
        'agreementKind', json_extract(${approvals.payloadJson}, '$.agreementKind'),
        'agreementVersion', json_extract(${approvals.payloadJson}, '$.agreementVersion'),
        'autoArchived', CASE json_type(${approvals.payloadJson}, '$.autoArchived')
          WHEN 'true' THEN json('true')
          WHEN 'false' THEN json('false')
          ELSE NULL
        END
      )
      WHEN ${approvals.type} = '流转审批' THEN json_object(
        'circulationRecipients', json_extract(${approvals.payloadJson}, '$.circulationRecipients'),
        'circulationApprovers', json_extract(${approvals.payloadJson}, '$.circulationApprovers'),
        'circulationConfirmations', json_extract(${approvals.payloadJson}, '$.circulationConfirmations'),
        'circulationApprovals', json_extract(${approvals.payloadJson}, '$.circulationApprovals')
      )
      WHEN ${approvals.type} = '技术审核' THEN json_object(
        'totalWorkHours', json_extract(${approvals.payloadJson}, '$.totalWorkHours'),
        'developers', json_extract(${approvals.payloadJson}, '$.developers'),
        'archivedAt', json_extract(${approvals.payloadJson}, '$.archivedAt')
      )
      WHEN ${approvals.type} = '劳务报酬' AND lower(${approvals.requesterEmail}) = ${currentEmail} THEN json_object(
        'sourceApprovalIds', json_extract(${approvals.payloadJson}, '$.sourceApprovalIds'),
        'month', json_extract(${approvals.payloadJson}, '$.month')
      )
      ELSE '{}'
    END`.as("payload_json"),
    currentRevisionNo: approvals.currentRevisionNo,
    currentRevisionHash: approvals.currentRevisionHash,
  };
}

export function serializeApproval(row: typeof approvals.$inferSelect, authorized: NonNullable<Awaited<ReturnType<typeof getAuthorizedUser>>>, related = false, includeSignature = true) {
  const payload = related || canSeePayload(row, authorized) ? parseJsonObject(row.payloadJson) : {};
  if (!includeSignature && row.type === "保密协议") delete payload.signatureDataUrl;
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    project: row.project,
    requester: row.requesterName,
    requesterEmail: row.requesterEmail,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    status: row.status,
    step: row.currentStep,
    currentReviewerName: row.currentReviewerName || undefined,
    currentReviewerEmail: row.currentReviewerEmail || undefined,
    amount: row.amount ?? undefined,
    summary: row.summary,
    owner: row.owner,
    signers: approvalSignerLabels(row.signersJson),
    payload,
    currentRevisionNo: row.currentRevisionNo,
    currentRevisionHash: row.currentRevisionHash ?? undefined,
  };
}

async function findPurchaser(db: Awaited<ReturnType<typeof getDb>>, purchaserEmail: string) {
  const normalizedEmail = normalizeEmail(purchaserEmail);
  const [member] = await db.select({ id: members.id, fullName: members.fullName, chatgptAccount: members.chatgptAccount, accountUserId: members.accountUserId, role: members.role, permissionsJson: members.permissionsJson, ndaAcceptedAt: members.ndaAcceptedAt, ndaAgreementVersion: members.ndaAgreementVersion }).from(members).where(and(eq(members.chatgptAccount, normalizedEmail), eq(members.status, "active"))).limit(1);
  if (member && isNdaAdmittedMember(member)) return { id: member.id, email: normalizedEmail, displayName: member.fullName };
  return null;
}

function extractLaborSourceIds(payload: Record<string, unknown>) {
  if (Array.isArray(payload.sourceApprovalIds)) return payload.sourceApprovalIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim());
  if (!Array.isArray(payload.selectedSources)) return [];
  return payload.selectedSources.flatMap((source) => source && typeof source === "object" && !Array.isArray(source) && textValue((source as Record<string, unknown>).id) ? [textValue((source as Record<string, unknown>).id)] : []);
}

function archiveMonth(row: typeof approvals.$inferSelect) {
  const payload = parseJsonObject(row.payloadJson);
  return monthKeyInShanghai(textValue(payload.archivedAt) || row.updatedAt);
}

function draftDevelopers(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const developer = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const ratio = asNumber(developer.ratio);
    return {
      memberId: textValue(developer.memberId),
      email: normalizeEmail(developer.email),
      name: textValue(developer.name),
      work: textValue(developer.work),
      ratio: Number.isFinite(ratio) ? round(ratio) : 0,
    };
  });
}

function conditionalApprovalInsert(
  db: Awaited<ReturnType<typeof getDb>>,
  row: typeof approvals.$inferSelect,
  actorGuard: ReturnType<typeof authorizedMemberGuard>,
) {
  return db.insert(approvals).select(db.select({
    id: sql<string>`${row.id}`.as("id"),
    type: sql<string>`${row.type}`.as("type"),
    title: sql<string>`${row.title}`.as("title"),
    project: sql<string>`${row.project}`.as("project"),
    requesterName: sql<string>`${row.requesterName}`.as("requester_name"),
    requesterEmail: sql<string>`${row.requesterEmail}`.as("requester_email"),
    clientCreationKey: sql<string | null>`${row.clientCreationKey}`.as("client_creation_key"),
    businessKey: sql<string | null>`${row.businessKey}`.as("business_key"),
    createdAt: sql<string>`${row.createdAt}`.as("created_at"),
    updatedAt: sql<string>`${row.updatedAt}`.as("updated_at"),
    status: sql<string>`${row.status}`.as("status"),
    currentStep: sql<string>`${row.currentStep}`.as("current_step"),
    currentReviewerName: sql<string>`${row.currentReviewerName}`.as("current_reviewer_name"),
    currentReviewerEmail: sql<string>`${row.currentReviewerEmail}`.as("current_reviewer_email"),
    summary: sql<string>`${row.summary}`.as("summary"),
    owner: sql<string>`${row.owner}`.as("owner"),
    amount: sql<string | null>`${row.amount}`.as("amount"),
    periodKey: sql<string | null>`${row.periodKey}`.as("period_key"),
    signersJson: sql<string>`${row.signersJson}`.as("signers_json"),
    payloadJson: sql<string>`${row.payloadJson}`.as("payload_json"),
    currentRevisionNo: sql<number>`${row.currentRevisionNo}`.as("current_revision_no"),
    currentRevisionHash: sql<string | null>`${row.currentRevisionHash}`.as("current_revision_hash"),
  }).from(sql`(SELECT 1) AS authorization_source`).where(actorGuard)).returning();
}

export async function GET() {
  const authorized = await getAuthorizedUser();
  if (!authorized) return Response.json({ error: "请先完成成员注册。" }, { status: 401 });
  try {
    const db = await getDb();
    const currentEmail = normalizeEmail(authorized.user.email);
    const visibilityGuard = !hasCompletedNda(authorized)
      ? and(eq(approvals.type, "保密协议"), sql`lower(${approvals.requesterEmail}) = ${currentEmail}`)
      : authorized.isAdmin || authorized.role === "project_owner"
        ? undefined
        : sql`(
          ${authorized.isFinanceOwner ? sql`${approvals.type} = '劳务报酬' OR` : sql``}
          lower(${approvals.requesterEmail}) = ${currentEmail}
          OR lower(${approvals.currentReviewerEmail}) = ${currentEmail}
          OR EXISTS (
            SELECT 1 FROM approval_events AS visibility_event
            WHERE visibility_event.approval_id = ${approvals.id}
              AND lower(visibility_event.actor_email) = ${currentEmail}
              AND visibility_event.action IN ('approve', 'return', 'confirm_developer', 'confirm_purchase', 'confirm_circulation')
          )
          OR (
            ${approvals.type} = '流转审批' AND ${approvals.status} <> '草稿'
            AND (
              EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(${approvals.payloadJson}) THEN ${approvals.payloadJson} ELSE '{}' END, '$.circulationRecipients') AS recipient WHERE lower(json_extract(recipient.value, '$.email')) = ${currentEmail})
              OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(${approvals.payloadJson}) THEN ${approvals.payloadJson} ELSE '{}' END, '$.circulationApprovers') AS reviewer WHERE lower(json_extract(reviewer.value, '$.email')) = ${currentEmail})
            )
          )
          OR (
            ${approvals.type} = '技术审核'
            AND EXISTS (
              SELECT 1
              FROM json_each(CASE WHEN json_valid(${approvals.payloadJson}) THEN ${approvals.payloadJson} ELSE '{"developers":[]}' END, '$.developers') AS developer
              WHERE lower(json_extract(developer.value, '$.email')) = ${currentEmail}
            )
          )
        )`;
    const selection = approvalListSelection(currentEmail);
    const rows = visibilityGuard
      ? await db.select(selection).from(approvals).where(visibilityGuard).orderBy(desc(approvals.updatedAt)).limit(200)
      : await db.select(selection).from(approvals).orderBy(desc(approvals.updatedAt)).limit(200);
    return Response.json({ approvals: rows.map((row) => serializeApproval(row, authorized, true, false)), user: authorized.user, truncated: rows.length === 200 }, { headers: PRIVATE_JSON_HEADERS });
  } catch {
    return Response.json({ error: "审批列表暂不可用，请稍后重试。" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const authorized = await getAuthorizedUser();
  if (!authorized) return Response.json({ error: "请先完成成员注册。" }, { status: 401 });
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return Response.json({ error: "申请数据必须使用 JSON 格式提交。" }, { status: 415 });
  const parsedBody = await readBoundedJsonObject(request, MAX_APPROVAL_REQUEST_BYTES);
  if (!parsedBody.ok) return Response.json({ error: parsedBody.reason === "too_large" ? "申请数据过大，请缩小签名图片或材料内容。" : "申请数据格式不正确。" }, { status: parsedBody.reason === "too_large" ? 413 : 400 });
  const body = parsedBody.value;

  const typeValue = textValue(body.type);
  if (!isApprovalType(typeValue)) return Response.json({ error: "不支持的申请类型。" }, { status: 400 });
  const type: ApprovalType = typeValue;
  const agreementKind = type === "保密协议" ? confidentialityAgreementKindForRole(authorized.role) : null;
  const agreementVersion = agreementKind ? confidentialityAgreementVersion(agreementKind) : "";
  if (!hasCompletedNda(authorized) && type !== "保密协议") return Response.json({ error: "完成保密协议签署并归档后，才能提交其他业务申请。" }, { status: 403 });

  const saveAsDraft = body.status === "草稿" || body.saveAsDraft === true;
  const requestedId = textValue(body.id);
  if (requestedId && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(requestedId)) return Response.json({ error: "申请编号格式不正确。" }, { status: 400 });
  const title = textValue(body.title);
  const summary = textValue(body.summary);
  const reviewerEmail = normalizeEmail(body.reviewerEmail);
  const rawPayload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? body.payload as Record<string, unknown> : {};
  if (!saveAsDraft && (!title || !summary)) return Response.json({ error: "申请标题和事项摘要不能为空。" }, { status: 400 });
  if (title.length > 160) return Response.json({ error: "申请标题不能超过 160 字。" }, { status: 400 });
  if (summary.length > 4000) return Response.json({ error: "事项摘要不能超过 4000 字。" }, { status: 400 });

  try {
    const db = await getDb();
    const actorGuard = authorizedMemberGuard(authorized);
    const currentEmail = normalizeEmail(authorized.user.email);
    if (!(await consumeWriteRateLimit(db, { actorSubject: authorized.accountUserId || "", scope: "approval_write", limit: MAX_WRITES_PER_MINUTE }))) {
      return Response.json({ error: "申请保存过于频繁，请稍后再试。" }, { status: 429, headers: { "retry-after": "60" } });
    }
    let [existing] = requestedId ? await db.select().from(approvals).where(eq(approvals.id, requestedId)).limit(1) : [];
    if (!existing && requestedId) {
      const [idempotentApproval] = await db.select().from(approvals).where(and(
        eq(approvals.requesterEmail, currentEmail),
        eq(approvals.clientCreationKey, requestedId),
      )).limit(1);
      if (idempotentApproval) {
        if (idempotentApproval.type !== type) return Response.json({ error: "同一创建标识不能用于不同业务类型。" }, { status: 409, headers: PRIVATE_JSON_HEADERS });
        if (type === "保密协议" && agreementKind && confidentialityAgreementKindFromPayload(parseJsonObject(idempotentApproval.payloadJson)) !== agreementKind) {
          return Response.json({ error: "同一创建标识对应的是其他角色的保密文件，请刷新页面后重新签署。" }, { status: 409, headers: PRIVATE_JSON_HEADERS });
        }
        if (["草稿", "已退回", "已撤回"].includes(idempotentApproval.status)) existing = idempotentApproval;
        else return Response.json({ approval: serializeApproval(idempotentApproval, authorized, true), idempotent: true }, { headers: PRIVATE_JSON_HEADERS });
      }
    }
    if (existing) {
      if (normalizeEmail(existing.requesterEmail) !== currentEmail) return Response.json({ error: "申请不存在或当前账号不可编辑。" }, { status: 404 });
      if (!["草稿", "已退回", "已撤回"].includes(existing.status)) return Response.json({ error: "只有草稿、已退回或已撤回的申请可以修改。" }, { status: 409 });
      if (existing.type !== type) return Response.json({ error: "已保存申请不能更改业务类型。" }, { status: 409 });
      if (type === "保密协议" && agreementKind && confidentialityAgreementKindFromPayload(parseJsonObject(existing.payloadJson)) !== agreementKind) {
        return Response.json({ error: "成员角色或保密文件版本已经变化，请新建当前角色对应的保密文件。" }, { status: 409 });
      }
    }
    const id = existing?.id || crypto.randomUUID();
    if (!existing) {
      if (!(await consumeWriteRateLimit(db, { actorSubject: authorized.accountUserId || "", scope: "approval_create", limit: 10 }))) {
        return Response.json({ error: "申请创建过于频繁，请稍后再试。" }, { status: 429, headers: { "retry-after": "60" } });
      }
      const draftRows = saveAsDraft ? await db.select({ value: count() }).from(approvals).where(and(eq(approvals.requesterEmail, currentEmail), eq(approvals.status, "草稿"))) : [{ value: 0 }];
      if ((draftRows[0]?.value ?? 0) >= 50) return Response.json({ error: "草稿数量已达上限，请先整理或作废旧草稿。" }, { status: 409 });
    }

    let payload: Record<string, unknown> = {};
    let periodKey: string | null = existing?.periodKey ?? null;
    let firstTechnicalDeveloper: TechnicalDeveloper | undefined;
    let laborClaims: LaborSourceClaimInput[] = [];

    if (type === "技术审核") {
      const totalWorkHours = asNumber(rawPayload.totalWorkHours);
      const robotPart = textValue(rawPayload.robotPart);
      const technicalContent = textValue(rawPayload.technicalContent);
      if (robotPart.length > 500 || technicalContent.length > 5000) return Response.json({ error: "机器人应用部分不能超过 500 字，技术内容不能超过 5000 字。" }, { status: 400 });
      if (Array.isArray(rawPayload.developers) && rawPayload.developers.length > 50) return Response.json({ error: "单份技术审核最多填写 50 名开发人。" }, { status: 400 });
      if (!saveAsDraft) {
        if (!robotPart || !technicalContent) return Response.json({ error: "请填写技术用于机器人的具体部分、技术内容与用途。" }, { status: 400 });
        if (!(totalWorkHours > 0)) return Response.json({ error: "请填写技术事项总工作时间，且必须大于 0 小时。" }, { status: 400 });
        const activeMembers = await db.select({ id: members.id, fullName: members.fullName, chatgptAccount: members.chatgptAccount, accountUserId: members.accountUserId, role: members.role, permissionsJson: members.permissionsJson, status: members.status, ndaAcceptedAt: members.ndaAcceptedAt, ndaAgreementVersion: members.ndaAgreementVersion }).from(members).where(eq(members.status, "active"));
        const normalized = normalizeTechnicalDevelopers(rawPayload.developers, activeMembers.filter(isNdaAdmittedMember));
        if (!normalized.developers) return Response.json({ error: normalized.error || "技术开发人信息不正确。" }, { status: 400 });
        firstTechnicalDeveloper = normalized.developers[0];
        payload = { totalWorkHours: round(totalWorkHours), robotPart, technicalContent, developers: normalized.developers, developerConfirmations: [] };
      } else {
        const developers = draftDevelopers(rawPayload.developers);
        if (developers.some((developer) => developer.memberId.length > 128 || developer.email.length > 254 || developer.name.length > 40 || developer.work.length > 2000)) return Response.json({ error: "技术开发人草稿中的姓名、邮箱、成员编号或工作说明过长。" }, { status: 400 });
        payload = { totalWorkHours: totalWorkHours > 0 ? round(totalWorkHours) : 0, robotPart, technicalContent, developers, developerConfirmations: [] };
      }
    }

    if (type === "采购审核") {
      const itemSpec = textValue(rawPayload.itemSpec);
      const quantity = asNumber(rawPayload.quantity);
      const amount = asNumber(rawPayload.amount);
      const purpose = textValue(rawPayload.purpose);
      const supplier = textValue(rawPayload.supplier);
      const purchaseLink = textValue(rawPayload.purchaseLink);
      const purchaserEmail = normalizeEmail(rawPayload.suggestedPurchaserEmail ?? rawPayload.purchaserEmail);
      if (itemSpec.length > 1000 || purpose.length > 3000 || supplier.length > 500 || purchaseLink.length > 2048) return Response.json({ error: "采购明细内容过长，请精简后提交。" }, { status: 400 });
      if (!saveAsDraft && (!itemSpec || !(quantity > 0) || !Number.isInteger(quantity) || !(amount >= 0) || !purpose || (!supplier && !purchaseLink))) return Response.json({ error: "请完整填写采购事项、规格、数量、用途、金额和供应商/购买链接。" }, { status: 400 });
      const purchaser = purchaserEmail ? await findPurchaser(db, purchaserEmail) : null;
      if (!saveAsDraft && purchaserEmail && !purchaser) return Response.json({ error: "建议采购成员必须是已完成保密协议归档的当前有效成员；也可以留空，由项目负责人指定。" }, { status: 400 });
      payload = { itemSpec, quantity: quantity > 0 && Number.isInteger(quantity) ? quantity : 0, amount: amount >= 0 ? round(amount) : 0, purpose, supplier, purchaseLink, suggestedPurchaserEmail: purchaser?.email || "", suggestedPurchaserMemberId: purchaser?.id || "", suggestedPurchaserName: purchaser?.displayName || "" };
    }

    if (type === "保密协议") {
      if (!agreementKind) return Response.json({ error: "无法确定当前角色所需的保密文件。" }, { status: 400 });
      const signerName = textValue(rawPayload.signerName) || authorized.user.displayName.trim();
      const signerEmail = normalizeEmail(authorized.user.email);
      const signerAccountUserId = authorized.accountUserId || "";
      const confidentialScope = textValue(rawPayload.confidentialScope);
      const signatureDataUrl = textValue(rawPayload.signatureDataUrl);
      if (confidentialScope.length > 4000) return Response.json({ error: "保密信息范围不能超过 4000 字。" }, { status: 400 });
      if (signatureDataUrl) {
        const signatureError = validatePngSignatureDataUrl(signatureDataUrl);
        if (signatureError) return Response.json({ error: signatureError }, { status: 400 });
        const signatureInkError = await validatePngSignatureInk(signatureDataUrl);
        if (signatureInkError) return Response.json({ error: signatureInkError }, { status: 400 });
      }
      if (!saveAsDraft && (existing?.status === "已退回" || existing?.status === "已撤回") && isReusedReturnedNdaSignature(parseJsonObject(existing.payloadJson).signatureDataUrl, signatureDataUrl)) {
        return Response.json({ error: "保密文件退回或撤回后必须清空旧签名，并由本人重新手写签署。" }, { status: 409 });
      }
      if (!saveAsDraft) {
        if (!signerAccountUserId) return Response.json({ error: "无法读取签署人的认证账户主体，请重新登录后再签署。" }, { status: 403 });
        if (signerName !== authorized.user.displayName.trim()) return Response.json({ error: "签署人必须与当前已审核成员姓名一致。" }, { status: 400 });
        if (!confidentialScope) return Response.json({ error: "请填写保密信息范围。" }, { status: 400 });
        if (!signatureDataUrl) return Response.json({ error: "请使用手写签名完成保密协议签署。" }, { status: 400 });
        if (rawPayload.previewed !== true || rawPayload.agreed !== true) return Response.json({ error: "请先预览协议并确认同意后再提交。" }, { status: 400 });
        if (rawPayload.agreementKind !== agreementKind || rawPayload.agreementVersion !== agreementVersion) {
          return Response.json({ error: "页面中的保密文件版本与当前成员角色不一致，请刷新页面后重新预览并签署。" }, { status: 409 });
        }
        const [duplicateNda] = await db.select({ id: approvals.id }).from(approvals).where(and(eq(approvals.businessKey, ndaBusinessKey(signerAccountUserId, agreementKind)), sql`${approvals.id} <> ${id}`)).limit(1);
        if (duplicateNda) return Response.json({ error: `当前版本的${confidentialityAgreementTitle(agreementKind)}已正式提交，不能重复创建。` }, { status: 409 });
      }
      const signedAt = !saveAsDraft && signatureDataUrl ? new Date().toISOString() : "";
      const integrity = signedAt ? await createNdaIntegrityRecord({ signerName, signerEmail, signerAccountUserId, confidentialScope, signatureDataUrl, signedAt, agreementKind }) : null;
      payload = { agreementKind, agreementVersion, signerName, signerEmail, signerAccountUserId, confidentialScope, signatureDataUrl, previewed: rawPayload.previewed === true, agreed: rawPayload.agreed === true, signedAt, ...(integrity ?? {}) };
    }

    if (type === "劳务报酬") {
      const month = textValue(rawPayload.month);
      const monthlyWorkHours = asNumber(rawPayload.monthlyWorkHours);
      const monthlyStatement = textValue(rawPayload.monthlyStatement);
      const sourceIds = Array.from(new Set(extractLaborSourceIds(rawPayload)));
      if (sourceIds.length > 100) return Response.json({ error: "单份劳务报酬申请最多选择 100 项技术成果。" }, { status: 400 });
      if (sourceIds.some((sourceId) => sourceId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sourceId))) return Response.json({ error: "劳务报酬技术成果编号格式不正确。" }, { status: 400 });
      if (monthlyStatement.length > 4000) return Response.json({ error: "本月工作与贡献陈述不能超过 4000 字。" }, { status: 400 });
      const previousMonth = existing ? textValue(parseJsonObject(existing.payloadJson).month) : "";
      if (existing?.periodKey && existing.status !== "已撤回" && previousMonth && month && previousMonth !== month) return Response.json({ error: "劳务报酬正式提交后不能更改所属月份；申请人撤回后可以修改，或将原申请作废后新建。" }, { status: 409 });
      if (!saveAsDraft && !isValidLaborMonth(month)) return Response.json({ error: "请选择有效的劳务报酬所属月份（01 至 12 月）。" }, { status: 400 });
      if (!saveAsDraft && !(monthlyWorkHours >= 0)) return Response.json({ error: "请填写不含已选技术成果工作时间的本月其他工时，且不能小于 0。" }, { status: 400 });
      if (!saveAsDraft && monthlyStatement.length < 10) return Response.json({ error: "请填写本月工作与贡献陈述，至少 10 个字。" }, { status: 400 });
      if (!saveAsDraft && !sourceIds.length) return Response.json({ error: "请至少选择一项已归档的技术成果用于贡献折算。" }, { status: 400 });
      if (!saveAsDraft) {
        if (month > monthKeyInShanghai()) return Response.json({ error: "不能提前提交未来月份的劳务报酬。" }, { status: 400 });
        const currentEmail = normalizeEmail(authorized.user.email);
        const [currentMember] = await db.select({ id: members.id }).from(members).where(and(eq(members.chatgptAccount, currentEmail), eq(members.status, "active"))).limit(1);
        if (!currentMember) return Response.json({ error: "劳务报酬申请人必须是当前有效成员。" }, { status: 403 });
        periodKey = existing?.status === "已撤回" ? `${currentEmail}|${month}` : existing?.periodKey || `${currentEmail}|${month}`;
        const laborRows = await db.select().from(approvals).where(eq(approvals.type, "劳务报酬"));
        const otherFormalRows = laborRows.filter((row) => {
          const otherPayload = parseJsonObject(row.payloadJson);
          return row.id !== id && holdsLaborReservation(row.status) && (normalizeEmail(row.requesterEmail) === currentEmail || textValue(otherPayload.claimantMemberId) === currentMember.id);
        });
        const duplicateLabor = otherFormalRows.some((row) => row.periodKey === periodKey || textValue(parseJsonObject(row.payloadJson).month) === month);
        if (duplicateLabor) return Response.json({ error: `${month} 已提交过劳务报酬申请；退回记录仍保留该月份，每月只能有一份正式申请。` }, { status: 409 });
        const alreadyClaimedSourceIds = new Set(otherFormalRows.flatMap((row) => extractLaborSourceIds(parseJsonObject(row.payloadJson))));
        if (sourceIds.some((sourceId) => alreadyClaimedSourceIds.has(sourceId))) return Response.json({ error: "同一名开发人的同一项技术成果只能计入一份劳务报酬申请，所选成果中存在已计入记录。" }, { status: 409 });
        const persistedClaims = await db.select({ technicalApprovalId: laborSourceClaims.technicalApprovalId, laborApprovalId: laborSourceClaims.laborApprovalId }).from(laborSourceClaims).where(eq(laborSourceClaims.claimantMemberId, currentMember.id));
        if (sourceIds.some((sourceId) => persistedClaims.some((claim) => claim.technicalApprovalId === sourceId && claim.laborApprovalId !== id))) return Response.json({ error: "所选技术成果已被当前成员的另一份正式劳务报酬申请占用。" }, { status: 409 });

        const technicalRows = await db.select().from(approvals).where(eq(approvals.type, "技术审核"));
        const selectedRows = sourceIds.map((sourceId) => technicalRows.find((row) => row.id === sourceId));
        if (selectedRows.some((row) => !row || row.status !== "已归档" || row.currentStep !== "已归档")) return Response.json({ error: "劳务报酬只能选择已完成全部审核并归档的技术成果。" }, { status: 400 });
        if (selectedRows.some((row) => row && (!archiveMonth(row) || archiveMonth(row) > month))) return Response.json({ error: "所选技术成果归档时间无效，或归档月份晚于劳务报酬申报月份。" }, { status: 400 });

        const laborSources = selectedRows.map((row) => {
          if (!row) return null;
          const sourcePayload = parseJsonObject(row.payloadJson);
          const totalWorkHours = asNumber(sourcePayload.totalWorkHours);
          const developers = Array.isArray(sourcePayload.developers) ? sourcePayload.developers as TechnicalDeveloper[] : [];
          const developer = developers.find((item) => normalizeEmail(item.email) === currentEmail && textValue(item.memberId) === currentMember.id);
          const contributionRate = asNumber(developer?.ratio);
          if (!(totalWorkHours > 0) || !developer || !(contributionRate >= 0 && contributionRate <= 100)) return null;
          return { id: row.id, title: row.title, archivedAt: textValue(sourcePayload.archivedAt) || row.updatedAt, totalWorkHours: round(totalWorkHours), contributionRate: round(contributionRate), weightedHours: round(totalWorkHours * contributionRate / 100) };
        });
        if (laborSources.some((source) => !source)) return Response.json({ error: "所选技术成果中未找到当前账号对应的有效开发人贡献记录。" }, { status: 400 });
        const normalizedSources = laborSources as NonNullable<typeof laborSources[number]>[];
        const archivedContributionHours = round(normalizedSources.reduce((sum, source) => sum + source.weightedHours, 0));
        const otherMonthlyWorkHours = round(monthlyWorkHours);
        const totalScore = round(archivedContributionHours + otherMonthlyWorkHours);
        if (!(totalScore > 0)) return Response.json({ error: "技术贡献折算与本月其他工时合计必须大于 0。" }, { status: 400 });
        laborClaims = normalizedSources.map((source) => ({ claimantMemberId: currentMember.id, claimantEmail: currentEmail, technicalApprovalId: source.id }));
        payload = { month, claimantMemberId: currentMember.id, laborClaimRevision: crypto.randomUUID(), sourceApprovalIds: normalizedSources.map((source) => source.id), selectedSources: normalizedSources, monthlyWorkHours: otherMonthlyWorkHours, otherMonthlyWorkHours, monthlyWorkHoursDefinition: "不含已选技术成果工作时间的本月其他工时", monthlyStatement, archivedContributionHours, totalScore };
      } else {
        const archivedContributionHours = asNumber(rawPayload.archivedContributionHours);
        const otherMonthlyWorkHours = monthlyWorkHours >= 0 ? round(monthlyWorkHours) : 0;
        const rawSelectedSources = Array.isArray(rawPayload.selectedSources) ? rawPayload.selectedSources : [];
        if (rawSelectedSources.length > 100) return Response.json({ error: "劳务报酬草稿最多保留 100 项技术成果摘要。" }, { status: 400 });
        const selectedSources = rawSelectedSources.map((source) => {
          const record = source && typeof source === "object" && !Array.isArray(source) ? source as Record<string, unknown> : {};
          return { id: textValue(record.id).slice(0, 128), title: textValue(record.title).slice(0, 160), totalWorkHours: round(Math.max(0, asNumber(record.totalWorkHours) || 0)), contributionRate: round(Math.max(0, Math.min(100, asNumber(record.contributionRate) || 0))), weightedHours: round(Math.max(0, asNumber(record.weightedHours) || 0)) };
        });
        payload = { month: existing?.periodKey && existing.status !== "已撤回" ? previousMonth : month, sourceApprovalIds: sourceIds, selectedSources, monthlyWorkHours: otherMonthlyWorkHours, otherMonthlyWorkHours, monthlyWorkHoursDefinition: "不含已选技术成果工作时间的本月其他工时", monthlyStatement, archivedContributionHours: archivedContributionHours > 0 ? round(archivedContributionHours) : 0, totalScore: round((archivedContributionHours > 0 ? archivedContributionHours : 0) + otherMonthlyWorkHours) };
      }
    }

    if (type === "流转审批") {
      const directory = (await db.select().from(members).where(eq(members.status, "active"))).filter(isNdaAdmittedMember);
      const recipients = normalizeCirculationSelection(rawPayload.circulationRecipients ?? [], directory, "流转对象", true);
      const approvers = normalizeCirculationSelection(rawPayload.circulationApprovers ?? [], directory, "审批人", true);
      if (recipients.error || approvers.error) return Response.json({ error: recipients.error || approvers.error }, { status: 400 });
      const content = textValue(rawPayload.circulationContent);
      if (content.length > 4000) return Response.json({ error: "事项内容不能超过 4000 字。" }, { status: 400 });
      if (!saveAsDraft && (!content || (!recipients.people.length && !approvers.people.length))) return Response.json({ error: "请填写事项内容，并至少选择流转对象或审批人。" }, { status: 400 });
      if (approvers.people.some((person) => person.email === currentEmail)) return Response.json({ error: "申请人不能审批自己的申请，请选择其他成员。" }, { status: 400 });
      payload = { circulationContent: content, circulationRecipients: recipients.people, circulationApprovers: approvers.people, circulationConfirmations: [], circulationApprovals: [] };
    }

    const ndaDirectArchive = type === "保密协议" && agreementKind !== null
      && shouldAutoArchiveConfidentialityAgreement(agreementKind, authorized.isAdmin)
      && !saveAsDraft;
    let reviewer: { email: string; displayName: string } | null = null;
    if (!saveAsDraft && !ndaDirectArchive && type !== "流转审批") {
      if (!reviewerEmail) return Response.json({ error: "请选择首位审核人。" }, { status: 400 });
      if (reviewerEmail === currentEmail) return Response.json({ error: "申请人与审核人必须是不同的实名账号，请选择其他审核人。" }, { status: 400 });
      const reviewerRecord = (await getReviewerDirectory({ ...authorized.user, accountUserId: authorized.accountUserId })).find((item) => item.email === reviewerEmail);
      const requiredPermission = type === "保密协议" || type === "劳务报酬" ? "project_owner" : "technical_advisor";
      if (type === "保密协议" && agreementKind === "project_owner") {
        if (!reviewerRecord?.isAdmin) return Response.json({ error: "项目负责人保密承诺书只能由 OA 管理员确认归档。" }, { status: 400 });
      } else if (!reviewerRecord || !reviewerRecord.ndaCompleted || !reviewerRecord.permissions.includes(requiredPermission)) {
        return Response.json({ error: requiredPermission === "project_owner" ? `${type}只能选择项目负责人审核。` : "该成员没有技术顾问审核权限。" }, { status: 400 });
      }
      if (type === "技术审核" && Array.isArray(payload.developers) && payload.developers.some((item) => normalizeEmail((item as TechnicalDeveloper).email) === reviewerEmail)) return Response.json({ error: "技术开发人不能同时担任本事项的技术顾问，请选择独立审核人。" }, { status: 400 });
      reviewer = { email: reviewerRecord.email, displayName: reviewerRecord.displayName };
      if (type === "采购审核" && textValue(payload.suggestedPurchaserEmail) && !hasDistinctVerifiedEmails(currentEmail, reviewer.email, payload.suggestedPurchaserEmail)) {
        return Response.json({ error: "申请人、技术顾问与建议采购成员必须由不同实名账号担任。" }, { status: 400 });
      }
    }

    const now = new Date().toISOString();
    const preserveReturned = saveAsDraft && existing?.status === "已退回";
    const preserveWithdrawn = saveAsDraft && existing?.status === "已撤回";
    const preserveApplicantEdit = preserveReturned || preserveWithdrawn;
    const initialStep = type === "流转审批" ? circulationPeople(payload.circulationRecipients).length ? "流转确认" : "指定审批" : type === "技术审核"
      ? "开发人确认"
      : type === "采购审核"
        ? "技术顾问"
        : type === "保密协议" && agreementKind
          ? confidentialityAgreementReviewerStep(agreementKind)
          : "项目负责人";
    const currentReviewer = saveAsDraft
      ? preserveApplicantEdit && existing ? { email: existing.requesterEmail, displayName: existing.requesterName } : null
      : ndaDirectArchive
        ? null
      : type === "流转审批"
        ? (() => { const person = [...circulationPeople(payload.circulationRecipients), ...circulationPeople(payload.circulationApprovers)][0]; return person ? { email: person.email, displayName: person.name } : null; })()
      : type === "技术审核"
        ? { email: firstTechnicalDeveloper?.email || "", displayName: firstTechnicalDeveloper?.name || "" }
        : reviewer;
    const previousPayload = parseJsonObject(existing?.payloadJson);
    const workflowMutationRevision = crypto.randomUUID();
    payload = {
      ...payload,
      initialReviewerEmail: ndaDirectArchive ? "" : reviewer?.email || normalizeEmail(previousPayload.initialReviewerEmail),
      initialReviewerName: ndaDirectArchive ? "" : reviewer?.displayName || textValue(previousPayload.initialReviewerName),
      workflowMutationRevision,
      ...(ndaDirectArchive ? { archivedAt: now, archivedBy: authorized.user.displayName, archivedByEmail: currentEmail, autoArchived: true } : {}),
    };
    const auditAction = saveAsDraft ? "draft_saved" : ndaDirectArchive ? "auto_archived" : "submitted";
    const auditNote = ndaDirectArchive
      ? agreementKind === "member"
        ? existing
          ? "重新完成实名手写签署，系统直接归档；项目负责人可查阅"
          : "本人完成实名手写签署，系统直接归档；项目负责人可查阅"
        : "OA 管理员本人签署项目负责人保密承诺书，系统自动归档"
      : existing
        ? type === "劳务报酬" && !saveAsDraft
        ? "补充后重新提交审核；技术成果占用已同步"
        : saveAsDraft
          ? preserveReturned ? "补充材料已保存，原流程与月份占用继续保留" : preserveWithdrawn ? "撤回后的修改已保存，原记录与占用继续保留" : "更新并保存草稿"
          : "补充后重新提交审核"
      : type === "劳务报酬" && !saveAsDraft
        ? "提交劳务报酬申请；技术成果占用已同步"
        : saveAsDraft ? "保存草稿" : "提交审核申请";

    const row: typeof approvals.$inferInsert = {
      id,
      title: type === "保密协议" && agreementKind && !saveAsDraft
        ? `${confidentialityAgreementTitle(agreementKind)} · ${authorized.user.displayName}`
        : title || existing?.title || `${type}草稿`,
      type,
      project: PROJECT,
      requesterName: authorized.user.displayName,
      requesterEmail: currentEmail,
      clientCreationKey: existing?.clientCreationKey ?? requestedId ?? null,
      businessKey: type === "保密协议" && (!saveAsDraft || preserveReturned)
        ? ndaBusinessKey(authorized.accountUserId || "", agreementKind || "member")
        : existing?.businessKey ?? null,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      status: saveAsDraft ? preserveReturned ? "已退回" : preserveWithdrawn ? "已撤回" : "草稿" : ndaDirectArchive ? "已归档" : "待审核",
      currentStep: saveAsDraft ? preserveReturned ? "补充材料" : preserveWithdrawn ? "申请人修改" : "草稿" : ndaDirectArchive ? "已归档" : initialStep,
      currentReviewerName: currentReviewer?.displayName || "",
      currentReviewerEmail: currentReviewer?.email || "",
      summary: summary || existing?.summary || "尚未填写完整，等待继续编辑。",
      owner: type === "劳务报酬" || type === "保密协议" ? ndaDirectArchive ? agreementKind === "member" ? "系统自动归档" : "OA 管理员本人承诺" : reviewer?.displayName || existing?.owner || "" : "",
      amount: type === "采购审核" && asNumber(payload.amount) >= 0 ? `¥ ${asNumber(payload.amount).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}` : preserveApplicantEdit ? existing?.amount ?? null : null,
      periodKey,
      signersJson: !saveAsDraft
        ? addApprovalSigner("[]", { name: authorized.user.displayName, email: currentEmail, accountUserId: authorized.accountUserId, memberId: authorized.memberId, signedAt: now })
        : "[]",
      payloadJson: JSON.stringify(payload),
    };
    if (existing && saveAsDraft) {
      const previousMaterialPayload = parseJsonObject(existing.payloadJson);
      const nextMaterialPayload = parseJsonObject(row.payloadJson as string);
      delete previousMaterialPayload.workflowMutationRevision;
      delete nextMaterialPayload.workflowMutationRevision;
      const materialUnchanged = existing.title === row.title
        && existing.summary === row.summary
        && existing.owner === row.owner
        && existing.amount === row.amount
        && existing.periodKey === row.periodKey
        && existing.currentStep === row.currentStep
        && existing.currentReviewerEmail === row.currentReviewerEmail
        && JSON.stringify(previousMaterialPayload) === JSON.stringify(nextMaterialPayload);
      if (materialUnchanged) return Response.json({ approval: serializeApproval(existing, authorized, true), idempotent: true }, { headers: PRIVATE_JSON_HEADERS });
      if (existing.status === "已退回" || existing.status === "已撤回") {
        const [returnedRevisionRows] = await db.select({ value: count() }).from(approvalRevisions).where(and(
          eq(approvalRevisions.approvalId, existing.id),
          sql`CASE WHEN json_valid(${approvalRevisions.eventJson}) THEN json_extract(${approvalRevisions.eventJson}, '$.event.action') = 'draft_saved' ELSE 0 END`,
        ));
        if ((returnedRevisionRows?.value ?? 0) >= MAX_RETURNED_MATERIAL_REVISIONS) return Response.json({ error: "该申请的退回材料编辑版本已达上限，请联系管理员核验并处理。" }, { status: 409 });
      }
    }
    const materialRevisionWillBeWritten = !saveAsDraft || existing?.status === "已退回" || existing?.status === "已撤回" || (existing?.currentRevisionNo ?? 0) > 0;
    const futureSubmissionRevision = saveAsDraft && materialRevisionWillBeWritten ? 1 : 0;
    if (existing && existing.currentRevisionNo + (materialRevisionWillBeWritten ? 1 : 0) + futureSubmissionRevision + workflowRevisionsNeededAfterMaterial(type, payload) > MAX_STANDARD_APPROVAL_REVISIONS) {
      return Response.json({ error: "该申请剩余的不可变版本空间不足以完成全部实名节点，已停止继续扩充材料；请联系管理员核验并制定迁移处理方案。" }, { status: 409 });
    }
    const revisionPlan = await planApprovalRevisions({
      previousApproval: existing as unknown as Record<string, unknown> | undefined,
      nextApproval: row as unknown as Record<string, unknown>,
      workflowMutationRevision,
      event: { actorName: authorized.user.displayName, actorEmail: currentEmail, action: auditAction, note: auditNote, occurredAt: now },
      shouldWrite: materialRevisionWillBeWritten,
    });
    row.currentRevisionNo = revisionPlan.currentRevisionNo;
    row.currentRevisionHash = revisionPlan.currentRevisionHash;

    if (ndaDirectArchive && agreementKind) {
      const previousRevisionPointerMatches = existing?.currentRevisionHash
        ? eq(approvals.currentRevisionHash, existing.currentRevisionHash)
        : isNull(approvals.currentRevisionHash);
      const persistApproval = existing
        ? db.update(approvals).set(row).where(and(
          eq(approvals.id, id),
          eq(approvals.updatedAt, existing.updatedAt),
          eq(approvals.payloadJson, existing.payloadJson),
          eq(approvals.currentRevisionNo, existing.currentRevisionNo),
          previousRevisionPointerMatches,
          actorGuard,
        )).returning()
        : conditionalApprovalInsert(db, row as typeof approvals.$inferSelect, actorGuard);
      const approvalWasArchived = exists(db.select({ id: approvals.id }).from(approvals).where(and(
        eq(approvals.id, id),
        eq(approvals.status, "已归档"),
        eq(approvals.businessKey, ndaBusinessKey(authorized.accountUserId || "", agreementKind)),
        sql`json_extract(${approvals.payloadJson}, '$.agreementKind') = ${agreementKind}`,
        sql`json_extract(${approvals.payloadJson}, '$.agreementVersion') = ${agreementVersion}`,
        sql`json_extract(${approvals.payloadJson}, '$.workflowMutationRevision') = ${workflowMutationRevision}`,
      )));
      const syncMemberAdmission = db.update(members).set({
        ndaAcceptedAt: now,
        ndaApprovalId: id,
        ndaAgreementVersion: agreementVersion,
      }).where(and(
        eq(members.chatgptAccount, currentEmail),
        eq(members.accountUserId, authorized.accountUserId || ""),
        eq(members.status, "active"),
        approvalWasArchived,
      )).returning({ id: members.id });
      const revisionWrites = revisionPlan.revisions.map((revision) => conditionalApprovalRevisionInsert(
        db,
        id,
        now,
        workflowMutationRevision,
        revisionPlan.currentRevisionNo,
        revisionPlan.currentRevisionHash!,
        revision,
      ));
      const event = conditionalApprovalEvent(db, id, now, workflowMutationRevision, { actorName: authorized.user.displayName, actorEmail: currentEmail, action: auditAction, note: auditNote });
      const requireMemberAdmission = agreementKind === "member";
      const admissionAssertion = requireMemberAdmission
        ? assertMemberNdaAdmissionInBatch(db, id, now, currentEmail, authorized.accountUserId || "", agreementVersion)
        : null;
      const results = await db.batch([persistApproval, ...revisionWrites, event, syncMemberAdmission, ...(admissionAssertion ? [admissionAssertion] : [])]);
      const savedRows = results[0] as Array<typeof approvals.$inferSelect>;
      const revisionRows = results.slice(1, 1 + revisionWrites.length) as Array<Array<{ revisionHash: string }>>;
      const eventRows = results[1 + revisionWrites.length] as Array<{ id: number }>;
      const admissionRows = results[2 + revisionWrites.length] as Array<{ id: string }>;
      const saved = savedRows[0];
      if (!saved) return Response.json({ error: "成员状态或保密文件刚刚发生变化，请刷新后重新签署。" }, { status: 409 });
      if (revisionRows.length !== revisionWrites.length || revisionRows.some((rows) => !rows[0]) || !eventRows[0] || (requireMemberAdmission && !admissionRows[0])) {
        return Response.json({ error: "保密文件记录、不可变版本、审计轨迹或成员准入状态未完整同步，请联系管理员核查。" }, { status: 500 });
      }
      return Response.json({ approval: serializeApproval(saved, authorized, true) }, { status: existing ? 200 : 201, headers: PRIVATE_JSON_HEADERS });
    }

    if (existing) {
      const previousRevisionPointerMatches = existing.currentRevisionHash
        ? eq(approvals.currentRevisionHash, existing.currentRevisionHash)
        : isNull(approvals.currentRevisionHash);
      const revisionWrites = revisionPlan.revisions.map((revision) => conditionalApprovalRevisionInsert(
        db,
        id,
        now,
        workflowMutationRevision,
        revisionPlan.currentRevisionNo,
        revisionPlan.currentRevisionHash!,
        revision,
      ));
      if (type === "劳务报酬" && !saveAsDraft) {
        const laborClaimRevision = textValue(payload.laborClaimRevision);
        if (!laborClaimRevision) return Response.json({ error: "劳务成果占用版本生成失败，请稍后重试。" }, { status: 500 });
        const update = db.update(approvals).set(row).where(and(eq(approvals.id, id), eq(approvals.updatedAt, existing.updatedAt), eq(approvals.payloadJson, existing.payloadJson), eq(approvals.currentRevisionNo, existing.currentRevisionNo), previousRevisionPointerMatches, actorGuard)).returning();
        const approvalWasUpdated = exists(db.select({ id: approvals.id }).from(approvals).where(and(
          eq(approvals.id, id),
          eq(approvals.updatedAt, now),
          sql`json_extract(${approvals.payloadJson}, '$.workflowMutationRevision') = ${workflowMutationRevision}`,
          sql`json_extract(${approvals.payloadJson}, '$.laborClaimRevision') = ${laborClaimRevision}`,
        )));
        const deleteOldClaims = db.delete(laborSourceClaims).where(and(eq(laborSourceClaims.laborApprovalId, id), approvalWasUpdated)).returning({ id: laborSourceClaims.id });
        const insertClaims = laborClaims.map((claim) => conditionalLaborClaimInsert(db, id, now, laborClaimRevision, claim));
        const event = conditionalApprovalEvent(db, id, now, workflowMutationRevision, { actorName: authorized.user.displayName, actorEmail: currentEmail, action: auditAction, note: auditNote });
        const results = await db.batch([update, deleteOldClaims, ...insertClaims, ...revisionWrites, event]);
        const updated = (results[0] as Array<typeof approvals.$inferSelect>)[0];
        if (!updated) return Response.json({ error: "申请刚刚已被其他操作更新，请刷新后重试。" }, { status: 409 });
        const claimResults = results.slice(2, 2 + insertClaims.length) as Array<Array<{ id: string }>>;
        if (claimResults.length !== laborClaims.length || claimResults.some((claimRows) => !claimRows[0])) return Response.json({ error: "劳务成果占用未能同步，请联系管理员核查。" }, { status: 500 });
        const revisionResults = results.slice(2 + insertClaims.length, -1) as Array<Array<{ revisionHash: string }>>;
        if (revisionResults.length !== revisionWrites.length || revisionResults.some((revisionRows) => !revisionRows[0])) return Response.json({ error: "审批状态已更新，但不可变材料版本未写入，请联系管理员核查。" }, { status: 500 });
        const eventRows = results.at(-1) as Array<{ id: number }>;
        if (!eventRows[0]) return Response.json({ error: "申请状态已更新，但审核记录未写入，请联系管理员核查。" }, { status: 500 });
        return Response.json({ approval: serializeApproval(updated, authorized, true) }, { headers: PRIVATE_JSON_HEADERS });
      }
      const update = db.update(approvals).set(row).where(and(eq(approvals.id, id), eq(approvals.updatedAt, existing.updatedAt), eq(approvals.payloadJson, existing.payloadJson), eq(approvals.currentRevisionNo, existing.currentRevisionNo), previousRevisionPointerMatches, actorGuard)).returning();
      const event = conditionalApprovalEvent(db, id, now, workflowMutationRevision, { actorName: authorized.user.displayName, actorEmail: currentEmail, action: auditAction, note: auditNote });
      const results = await db.batch([update, ...revisionWrites, event]);
      const updatedRows = results[0] as Array<typeof approvals.$inferSelect>;
      const eventRows = results.at(-1) as Array<{ id: number }>;
      const updated = updatedRows[0];
      if (!updated) return Response.json({ error: "申请刚刚已被其他操作更新，请刷新后重试。" }, { status: 409 });
      const revisionResults = results.slice(1, -1) as Array<Array<{ revisionHash: string }>>;
      if (revisionResults.length !== revisionWrites.length || revisionResults.some((revisionRows) => !revisionRows[0])) return Response.json({ error: "审批状态已更新，但不可变材料版本未写入，请联系管理员核查。" }, { status: 500 });
      if (!eventRows[0]) return Response.json({ error: "申请状态已更新，但审核记录未写入，请联系管理员核查。" }, { status: 500 });
      return Response.json({ approval: serializeApproval(updated, authorized, true) }, { headers: PRIVATE_JSON_HEADERS });
    }
    if (type === "劳务报酬" && !saveAsDraft) {
      const laborClaimRevision = textValue(payload.laborClaimRevision);
      const insertApproval = conditionalApprovalInsert(db, row as typeof approvals.$inferSelect, actorGuard);
      const insertClaims = laborClaims.map((claim) => conditionalLaborClaimInsert(db, id, now, laborClaimRevision, claim));
      const insertRevisions = revisionPlan.revisions.map((revision) => conditionalApprovalRevisionInsert(db, id, now, workflowMutationRevision, revisionPlan.currentRevisionNo, revisionPlan.currentRevisionHash!, revision));
      const insertEvent = conditionalApprovalEvent(db, id, now, workflowMutationRevision, { actorName: authorized.user.displayName, actorEmail: currentEmail, action: auditAction, note: auditNote });
      const results = await db.batch([insertApproval, ...insertClaims, ...insertRevisions, insertEvent]);
      const createdRows = results[0] as Array<typeof approvals.$inferSelect>;
      const claimRows = results.slice(1, 1 + insertClaims.length) as Array<Array<{ id: string }>>;
      const revisionRows = results.slice(1 + insertClaims.length, -1) as Array<Array<{ revisionHash: string }>>;
      const eventRows = results.at(-1) as Array<{ id: number }>;
      const created = createdRows[0];
      if (!created) return Response.json({ error: "成员状态或权限刚刚发生变化，本次申请未保存，请刷新后重试。" }, { status: 409 });
      if (claimRows.length !== laborClaims.length || claimRows.some((rows) => !rows[0]) || revisionRows.length !== insertRevisions.length || revisionRows.some((rows) => !rows[0]) || !eventRows[0]) return Response.json({ error: "劳务申请、不可变材料版本及成果占用未能完整保存，请稍后重试。" }, { status: 500 });
      return Response.json({ approval: serializeApproval(created, authorized, true) }, { status: 201, headers: PRIVATE_JSON_HEADERS });
    }
    const insertApproval = conditionalApprovalInsert(db, row as typeof approvals.$inferSelect, actorGuard);
    const insertRevisions = revisionPlan.revisions.map((revision) => conditionalApprovalRevisionInsert(db, id, now, workflowMutationRevision, revisionPlan.currentRevisionNo, revisionPlan.currentRevisionHash!, revision));
    const insertEvent = conditionalApprovalEvent(db, id, now, workflowMutationRevision, { actorName: authorized.user.displayName, actorEmail: currentEmail, action: auditAction, note: auditNote });
    const results = await db.batch([insertApproval, ...insertRevisions, insertEvent]);
    const createdRows = results[0] as Array<typeof approvals.$inferSelect>;
    const revisionRows = results.slice(1, -1) as Array<Array<{ revisionHash: string }>>;
    const eventRows = results.at(-1) as Array<{ id: number }>;
    const created = createdRows[0];
    if (!created) return Response.json({ error: "成员状态或权限刚刚发生变化，本次申请未保存，请刷新后重试。" }, { status: 409 });
    if (revisionRows.length !== insertRevisions.length || revisionRows.some((rows) => !rows[0]) || !eventRows[0]) return Response.json({ error: "申请、不可变材料版本与审核记录未能完整保存，请稍后重试。" }, { status: 500 });
    return Response.json({ approval: serializeApproval(created, authorized, true) }, { status: 201, headers: PRIVATE_JSON_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/approvals_requester_creation_unique|client_creation_key/i.test(message) && requestedId) {
      try {
        const db = await getDb();
        const [idempotentApproval] = await db.select().from(approvals).where(and(
          eq(approvals.requesterEmail, normalizeEmail(authorized.user.email)),
          eq(approvals.clientCreationKey, requestedId),
        )).limit(1);
        if (idempotentApproval && idempotentApproval.type === type) {
          if (type === "保密协议" && agreementKind && confidentialityAgreementKindFromPayload(parseJsonObject(idempotentApproval.payloadJson)) !== agreementKind) {
            return Response.json({ error: "同一创建标识对应的是其他角色的保密文件，请刷新页面后重新签署。" }, { status: 409, headers: PRIVATE_JSON_HEADERS });
          }
          return Response.json({ approval: serializeApproval(idempotentApproval, authorized, true), idempotent: true }, { headers: PRIVATE_JSON_HEADERS });
        }
      } catch {
        // The winning row may not be visible yet; return a stable retry-safe conflict.
      }
      return Response.json({ error: "该申请已提交，请刷新审批列表查看。" }, { status: 409, headers: PRIVATE_JSON_HEADERS });
    }
    if (/approvals_business_key_unique|business_key/i.test(message) && type === "保密协议") return Response.json({ error: "当前版本的保密协议已正式提交，不能重复创建。" }, { status: 409, headers: PRIVATE_JSON_HEADERS });
    if (/period_key/i.test(message) && type === "劳务报酬") return Response.json({ error: "该月份已有正式劳务报酬申请，请刷新后查看。" }, { status: 409 });
    if (/labor_source_claims|member_technical_unique/i.test(message) && type === "劳务报酬") return Response.json({ error: "所选技术成果已被当前成员的另一份正式劳务报酬申请占用。" }, { status: 409 });
    return Response.json({ error: "申请保存失败，请稍后重试。" }, { status: 500 });
  }
}

export { APPROVAL_TYPES };

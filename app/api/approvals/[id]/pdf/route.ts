import { asc, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { approvalEvents, approvalRevisions, approvals } from "../../../../../db/schema";
import { approvalSignerLabels } from "../../../../../lib/approval-signers";
import { buildArchiveManifest } from "../../../../../lib/archive-manifest";
import { approvalEventActionLabel, buildApprovalPdf, safeApprovalPdfFileName } from "../../../../../lib/approval-pdf";
import { hasCompletedNda, isApprovalRelated, normalizeEmail, parseJsonObject } from "../../../../../lib/approval-policy";
import { confidentialityAgreementKindFromPayload } from "../../../../../lib/nda-agreement";
import { getAuthorizedUser } from "../../../_lib/auth";

const REVIEW_EVENT_ACTIONS = new Set(["approve", "return", "confirm_developer", "confirm_purchase", "confirm_circulation"]);

function safeAsciiFileName(id: string) {
  return `${id.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 80) || "approval"}.pdf`;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authorized = await getAuthorizedUser({ readOnly: true, noTouch: true });
  if (!authorized) return Response.json({ error: "请先登录并完成成员准入。" }, { status: 401 });
  const { id } = await params;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) return Response.json({ error: "申请不存在或当前账号无权查看。" }, { status: 404 });
  try {
    const db = await getDb();
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, id)).limit(1);
    if (!approval) return Response.json({ error: "申请不存在或当前账号无权查看。" }, { status: 404 });
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

    const fullPayload = parseJsonObject(approval.payloadJson);
    const agreementKind = approval.type === "保密协议" ? confidentialityAgreementKindFromPayload(fullPayload) : null;
    const canSeeSignature = approval.type !== "保密协议"
      || authorized.isAdmin
      || (authorized.role === "project_owner" && agreementKind === "member")
      || normalizeEmail(approval.requesterEmail) === email
      || normalizeEmail(approval.currentReviewerEmail) === email
      || historicalActors.has(email);
    const payload = { ...fullPayload };
    if (!canSeeSignature) delete payload.signatureDataUrl;
    const businessEvents = events.filter((event) => event.action !== "feishu_archived");
    const manifest = approval.status === "已归档" ? await buildArchiveManifest(approval, businessEvents, revisions) : null;
    const pdf = await buildApprovalPdf({
      approval: {
        id: approval.id,
        type: approval.type,
        title: approval.title,
        project: approval.project,
        requesterName: approval.requesterName,
        requesterEmail: approval.requesterEmail,
        createdAt: approval.createdAt,
        updatedAt: approval.updatedAt,
        status: approval.status,
        currentStep: approval.currentStep,
        currentReviewerName: approval.currentReviewerName,
        currentReviewerEmail: approval.currentReviewerEmail,
        summary: approval.summary,
        owner: approval.owner,
        amount: approval.amount,
        signers: approvalSignerLabels(approval.signersJson),
        payload,
      },
      events: businessEvents.map((event) => ({
        id: event.id,
        actorName: event.actorName,
        actorEmail: event.actorEmail,
        action: approvalEventActionLabel(event.action),
        note: event.note,
        createdAt: event.createdAt,
      })),
      integrity: manifest ? {
        archiveHash: manifest.hash,
        evidenceRecordHash: manifest.evidenceRecordHash,
        schemaVersion: manifest.schemaVersion,
        terminalRevisionNo: manifest.terminalRevisionNo,
        terminalRevisionHash: manifest.terminalRevisionHash,
        terminalStateHash: manifest.terminalStateHash,
      } : null,
    });
    const fileName = safeApprovalPdfFileName({ id: approval.id, title: approval.title, updatedAt: approval.updatedAt }, manifest?.hash);
    return new Response(new Blob([pdf], { type: "application/pdf" }), {
      headers: {
        "cache-control": "private, no-store, max-age=0",
        "content-disposition": `attachment; filename="${safeAsciiFileName(approval.id)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        "content-type": "application/pdf",
        "x-oa-approval-id": approval.id,
        ...(manifest ? { "x-oa-archive-hash": manifest.hash } : {}),
      },
    });
  } catch {
    return Response.json({ error: "PDF 暂时无法生成，请稍后重试。" }, { status: 500 });
  }
}

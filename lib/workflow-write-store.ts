import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { getDb } from "../db";
import { approvalEvents, approvals, laborSourceClaims, memberEvents, members } from "../db/schema";

type Database = Awaited<ReturnType<typeof getDb>>;

type AuditEvent = {
  actorName: string;
  actorEmail: string;
  action: string;
  note: string;
};

type LaborSourceClaim = {
  claimantMemberId: string;
  claimantEmail: string;
  technicalApprovalId: string;
};

export function conditionalApprovalEvent(
  db: Database,
  approvalId: string,
  updatedAt: string,
  workflowMutationRevision: string,
  event: AuditEvent,
) {
  const approvalMatchesMutation = and(
    eq(approvals.id, approvalId),
    eq(approvals.updatedAt, updatedAt),
    sql`json_extract(${approvals.payloadJson}, '$.workflowMutationRevision') = ${workflowMutationRevision}`,
  );
  return db.insert(approvalEvents).select(
    db.select({
      id: sql<number>`NULL`.as("id"),
      approvalId: approvals.id,
      actorName: sql<string>`${event.actorName}`.as("actor_name"),
      actorEmail: sql<string>`${event.actorEmail}`.as("actor_email"),
      action: sql<string>`${event.action}`.as("action"),
      note: sql<string>`${event.note}`.as("note"),
      createdAt: sql<string>`${updatedAt}`.as("created_at"),
    }).from(approvals).where(approvalMatchesMutation),
  ).returning({ id: approvalEvents.id });
}

/**
 * D1 batch statements are atomic only when a statement fails. A conditional
 * UPDATE that matches zero members would otherwise commit the approval,
 * revision, and event before the route can inspect their result arrays.
 *
 * When the member NDA cache is incomplete, this INSERT deliberately copies
 * the just-written event's primary key and raises a uniqueness error, rolling
 * the whole batch back. When the cache is complete it selects no rows.
 */
export function assertMemberNdaAdmissionInBatch(
  db: Database,
  approvalId: string,
  createdAt: string,
  memberEmail: string,
  accountUserId: string,
  agreementVersion: string,
) {
  return db.insert(approvalEvents).select(
    db.select({
      id: approvalEvents.id,
      approvalId: approvalEvents.approvalId,
      actorName: approvalEvents.actorName,
      actorEmail: approvalEvents.actorEmail,
      action: approvalEvents.action,
      note: approvalEvents.note,
      createdAt: approvalEvents.createdAt,
    }).from(approvalEvents).where(and(
      eq(approvalEvents.approvalId, approvalId),
      eq(approvalEvents.createdAt, createdAt),
      eq(approvalEvents.action, "auto_archived"),
      sql`NOT EXISTS (
        SELECT 1 FROM ${members} AS admitted_member
        WHERE admitted_member.chatgpt_account = ${memberEmail}
          AND admitted_member.account_user_id = ${accountUserId}
          AND admitted_member.status = 'active'
          AND admitted_member.nda_accepted_at = ${createdAt}
          AND admitted_member.nda_approval_id = ${approvalId}
          AND admitted_member.nda_agreement_version = ${agreementVersion}
      )`,
    )).limit(1),
  );
}

export function conditionalMemberEvent(
  db: Database,
  memberId: string,
  mutationRevision: string,
  createdAt: string,
  event: AuditEvent,
) {
  return db.insert(memberEvents).select(
    db.select({
      id: sql<number>`NULL`.as("id"),
      memberId: members.id,
      actorName: sql<string>`${event.actorName}`.as("actor_name"),
      actorEmail: sql<string>`${event.actorEmail}`.as("actor_email"),
      action: sql<string>`${event.action}`.as("action"),
      note: sql<string>`${event.note}`.as("note"),
      createdAt: sql<string>`${createdAt}`.as("created_at"),
    }).from(members).where(and(eq(members.id, memberId), eq(members.mutationRevision, mutationRevision))),
  ).returning({ id: memberEvents.id });
}

export function conditionalArchivedApplicantEvent(
  db: Database,
  approval: {
    id: string;
    requesterEmail: string;
    updatedAt: string;
    payloadJson: string;
    currentRevisionNo: number;
    currentRevisionHash: string | null;
  },
  requesterEmail: string,
  actorGuard: SQL,
  event: AuditEvent & { createdAt: string },
) {
  const revisionPointerMatches = approval.currentRevisionHash
    ? eq(approvals.currentRevisionHash, approval.currentRevisionHash)
    : isNull(approvals.currentRevisionHash);
  return db.insert(approvalEvents).select(
    db.select({
      id: sql<number>`NULL`.as("id"),
      approvalId: approvals.id,
      actorName: sql<string>`${event.actorName}`.as("actor_name"),
      actorEmail: sql<string>`${event.actorEmail}`.as("actor_email"),
      action: sql<string>`${event.action}`.as("action"),
      note: sql<string>`${event.note}`.as("note"),
      createdAt: sql<string>`${event.createdAt}`.as("created_at"),
    }).from(approvals).where(and(
      eq(approvals.id, approval.id),
      eq(approvals.status, "已归档"),
      sql`lower(${approvals.requesterEmail}) = ${requesterEmail}`,
      eq(approvals.updatedAt, approval.updatedAt),
      eq(approvals.payloadJson, approval.payloadJson),
      eq(approvals.currentRevisionNo, approval.currentRevisionNo),
      revisionPointerMatches,
      actorGuard,
    )),
  ).returning({ id: approvalEvents.id });
}

export function conditionalLaborClaimInsert(
  db: Database,
  approvalId: string,
  updatedAt: string,
  laborClaimRevision: string,
  claim: LaborSourceClaim,
) {
  return db.insert(laborSourceClaims).select(
    db.select({
      id: sql<string>`${crypto.randomUUID()}`.as("id"),
      claimantMemberId: sql<string>`${claim.claimantMemberId}`.as("claimant_member_id"),
      claimantEmail: sql<string>`${claim.claimantEmail}`.as("claimant_email"),
      technicalApprovalId: sql<string>`${claim.technicalApprovalId}`.as("technical_approval_id"),
      laborApprovalId: approvals.id,
      createdAt: sql<string>`${updatedAt}`.as("created_at"),
    }).from(approvals).where(and(
      eq(approvals.id, approvalId),
      eq(approvals.updatedAt, updatedAt),
      sql`json_extract(${approvals.payloadJson}, '$.laborClaimRevision') = ${laborClaimRevision}`,
    )),
  ).returning({ id: laborSourceClaims.id });
}

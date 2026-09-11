import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { approvalRevisions, approvals } from "../db/schema";
import { buildApprovalRevision, type ApprovalRevision } from "./approval-revisions";

const SHA256_HEX = /^[a-f0-9]{64}$/;

export type RevisionAuditEvent = {
  actorName: string;
  actorEmail: string;
  action: string;
  note: string;
  occurredAt: string;
};

export type PlannedApprovalRevision = ApprovalRevision & {
  mutationRevision: string;
  createdAt: string;
};

export type ApprovalRevisionPlan = {
  currentRevisionNo: number;
  currentRevisionHash: string | null;
  revisions: PlannedApprovalRevision[];
};

type ApprovalProjection = Record<string, unknown>;

export async function planApprovalRevisions({
  previousApproval,
  nextApproval,
  workflowMutationRevision,
  event,
  shouldWrite,
}: {
  previousApproval?: ApprovalProjection;
  nextApproval: ApprovalProjection;
  workflowMutationRevision: string;
  event: RevisionAuditEvent;
  shouldWrite: boolean;
}): Promise<ApprovalRevisionPlan> {
  const previousRevisionNo = Number(previousApproval?.currentRevisionNo ?? 0);
  const previousRevisionHash = typeof previousApproval?.currentRevisionHash === "string" ? previousApproval.currentRevisionHash : null;
  if (!shouldWrite) return { currentRevisionNo: previousRevisionNo, currentRevisionHash: previousRevisionHash, revisions: [] };
  if (!workflowMutationRevision) throw new TypeError("A workflow mutation revision is required");
  if (!Number.isSafeInteger(previousRevisionNo) || previousRevisionNo < 0) throw new TypeError("Stored approval revision number is invalid");
  if (previousRevisionNo > 0 && (!previousRevisionHash || !SHA256_HEX.test(previousRevisionHash))) throw new TypeError("Stored approval revision hash is invalid");
  if (previousRevisionNo === 0 && previousRevisionHash) throw new TypeError("Stored approval revision pointer is inconsistent");

  const revisions: PlannedApprovalRevision[] = [];
  let revisionNo = previousRevisionNo;
  let parentHash = previousRevisionHash;

  // Records created before the immutable chain existed receive an explicit
  // baseline snapshot before their first post-migration mutation. We do not
  // pretend to reconstruct historical intermediate payloads.
  if (previousApproval && previousRevisionNo === 0 && previousApproval.status !== "草稿") {
    const baselineMutationRevision = crypto.randomUUID();
    const baselineEvent: RevisionAuditEvent = {
      actorName: "系统迁移",
      actorEmail: "system@originmind.local",
      action: "legacy_baseline",
      note: "首次链式变更前保存迁移基线；早期流转事件仍保留在审批事件表。",
      occurredAt: event.occurredAt,
    };
    const baseline = await buildApprovalRevision({
      nextApproval: previousApproval,
      revisionNo: 1,
      previousRevisionHash: null,
      mutation: { workflowMutationRevision: baselineMutationRevision, kind: "legacy_baseline" },
      event: baselineEvent,
    });
    revisions.push({ ...baseline, mutationRevision: baselineMutationRevision, createdAt: event.occurredAt });
    revisionNo = 1;
    parentHash = baseline.revisionHash;
  }

  const next = await buildApprovalRevision({
    nextApproval,
    revisionNo: revisionNo + 1,
    previousRevisionHash: parentHash,
    mutation: { workflowMutationRevision },
    event,
  });
  revisions.push({ ...next, mutationRevision: workflowMutationRevision, createdAt: event.occurredAt });
  return { currentRevisionNo: next.revisionNo, currentRevisionHash: next.revisionHash, revisions };
}

export function approvalRevisionValues(approvalId: string, revision: PlannedApprovalRevision): typeof approvalRevisions.$inferInsert {
  return {
    revisionHash: revision.revisionHash,
    approvalId,
    revisionNo: revision.revisionNo,
    previousRevisionHash: revision.previousRevisionHash,
    mutationRevision: revision.mutationRevision,
    stateJson: revision.stateJson,
    stateHash: revision.stateHash,
    eventJson: revision.eventJson,
    createdAt: revision.createdAt,
  };
}

export function conditionalApprovalRevisionInsert(
  db: Awaited<ReturnType<typeof getDb>>,
  approvalId: string,
  updatedAt: string,
  workflowMutationRevision: string,
  terminalRevisionNo: number,
  terminalRevisionHash: string,
  revision: PlannedApprovalRevision,
) {
  return db.insert(approvalRevisions).select(
    db.select({
      revisionHash: sql<string>`${revision.revisionHash}`.as("revision_hash"),
      approvalId: approvals.id,
      revisionNo: sql<number>`${revision.revisionNo}`.as("revision_no"),
      previousRevisionHash: sql<string | null>`${revision.previousRevisionHash}`.as("previous_revision_hash"),
      mutationRevision: sql<string>`${revision.mutationRevision}`.as("mutation_revision"),
      stateJson: sql<string>`${revision.stateJson}`.as("state_json"),
      stateHash: sql<string>`${revision.stateHash}`.as("state_hash"),
      eventJson: sql<string>`${revision.eventJson}`.as("event_json"),
      createdAt: sql<string>`${revision.createdAt}`.as("created_at"),
    }).from(approvals).where(and(
      eq(approvals.id, approvalId),
      eq(approvals.updatedAt, updatedAt),
      eq(approvals.currentRevisionNo, terminalRevisionNo),
      eq(approvals.currentRevisionHash, terminalRevisionHash),
      sql`json_extract(${approvals.payloadJson}, '$.workflowMutationRevision') = ${workflowMutationRevision}`,
    )),
  ).returning({ revisionHash: approvalRevisions.revisionHash });
}

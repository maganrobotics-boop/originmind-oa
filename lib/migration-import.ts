import { inspectRevisionChain, type ApprovalRevision } from "./approval-revisions";
import { canonicalJson } from "./canonical-json";
import { chunkKnowledgeSubmission, isKnowledgeAdminSelfAuditNote } from "./knowledge-policy";

type MigrationTable = {
  name: string;
  columns: string[];
  rows: Array<Array<string | number | null>>;
  rowCount: number;
  sha256: string;
};

export type MigrationPayload = {
  tables: MigrationTable[];
  manifestSha256: string;
  schemaSha256: string;
  freezeId: string;
};

export {
  migrationImportD1QueryCount,
  migrationImportInsertStatementCount,
  MIGRATION_IMPORT_FIXED_D1_QUERIES,
  MIGRATION_IMPORT_MAX_D1_QUERIES,
  MIGRATION_IMPORT_TABLE_ORDER,
} from "./migration-import-plan.mjs";

function tableRecord(payload: MigrationPayload, name: string) {
  const table = payload.tables.find((candidate) => candidate.name === name);
  if (!table) throw new Error(`Migration table ${name} is missing`);
  return {
    table,
    rows: table.rows.map((row) => Object.fromEntries(table.columns.map((column, index) => [column, row[index]])) as Record<string, string | number | null>),
  };
}

function requiredText(row: Record<string, string | number | null>, key: string) {
  const value = row[key];
  if (typeof value !== "string" || !value) throw new Error(`Migration row is missing ${key}`);
  return value;
}

function optionalText(row: Record<string, string | number | null>, key: string) {
  const value = row[key];
  if (value !== null && typeof value !== "string") throw new Error(`Migration row has an invalid ${key}`);
  return value;
}

function requiredInteger(row: Record<string, string | number | null>, key: string) {
  const value = row[key];
  if (!Number.isSafeInteger(value)) throw new Error(`Migration row has an invalid ${key}`);
  return value as number;
}

function uniqueIds(rows: Array<Record<string, string | number | null>>, key: string, table: string) {
  const ids = new Set<string | number>();
  for (const row of rows) {
    const id = row[key];
    if ((typeof id !== "string" || !id) && !Number.isSafeInteger(id)) throw new Error(`Migration table ${table} has an invalid ${key}`);
    if (ids.has(id as string | number)) throw new Error(`Migration table ${table} has a duplicate ${key}`);
    ids.add(id as string | number);
  }
  return ids;
}

function assertReferences(rows: Array<Record<string, string | number | null>>, key: string, referenced: Set<string | number>, label: string) {
  for (const row of rows) {
    if (!referenced.has(row[key] as string | number)) throw new Error(`Migration ${label} reference is broken`);
  }
}

function assertOptionalReferences(rows: Array<Record<string, string | number | null>>, key: string, referenced: Set<string | number>, label: string) {
  for (const row of rows) {
    const value = row[key];
    if (value !== null && !referenced.has(value as string | number)) throw new Error(`Migration ${label} reference is broken`);
  }
}

function parseJsonObject(value: string, label: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`Migration ${label} JSON is invalid`);
  }
}

async function knowledgeContentHash(row: Record<string, string | number | null>) {
  const encoded = new TextEncoder().encode(JSON.stringify([
    requiredText(row, "title"),
    requiredText(row, "category"),
    typeof row.summary === "string" ? row.summary : "",
    typeof row.source_label === "string" ? row.source_label : "",
    typeof row.source_url === "string" ? row.source_url : "",
    requiredText(row, "content"),
  ]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const APPROVAL_PROJECTION_COLUMNS = Object.freeze([
  ["id", "id"],
  ["type", "type"],
  ["title", "title"],
  ["project", "project"],
  ["requester_name", "requesterName"],
  ["requester_email", "requesterEmail"],
  ["client_creation_key", "clientCreationKey"],
  ["business_key", "businessKey"],
  ["created_at", "createdAt"],
  ["updated_at", "updatedAt"],
  ["status", "status"],
  ["current_step", "currentStep"],
  ["current_reviewer_name", "currentReviewerName"],
  ["current_reviewer_email", "currentReviewerEmail"],
  ["summary", "summary"],
  ["owner", "owner"],
  ["amount", "amount"],
  ["period_key", "periodKey"],
  ["signers_json", "signersJson"],
  ["payload_json", "payloadJson"],
] as const);

function approvalProjection(row: Record<string, string | number | null>) {
  return Object.fromEntries(APPROVAL_PROJECTION_COLUMNS.map(([column, property]) => [property, row[column]]));
}

export async function assertMigrationPayloadRelationships(payload: MigrationPayload) {
  const approvals = tableRecord(payload, "approvals").rows;
  const approvalEvents = tableRecord(payload, "approval_events").rows;
  const approvalRevisions = tableRecord(payload, "approval_revisions").rows;
  const laborClaims = tableRecord(payload, "labor_source_claims").rows;
  const archives = tableRecord(payload, "external_archives").rows;
  const members = tableRecord(payload, "members").rows;
  const memberEvents = tableRecord(payload, "member_events").rows;
  const identities = tableRecord(payload, "auth_identities").rows;
  const messages = tableRecord(payload, "direct_messages").rows;
  const knowledgeItems = tableRecord(payload, "knowledge_items").rows;
  const knowledgeRevisions = tableRecord(payload, "knowledge_revisions").rows;
  const knowledgeChunks = tableRecord(payload, "knowledge_chunks").rows;
  const knowledgeEvents = tableRecord(payload, "knowledge_events").rows;

  const approvalIds = uniqueIds(approvals, "id", "approvals");
  const memberIds = uniqueIds(members, "id", "members");
  uniqueIds(approvalEvents, "id", "approval_events");
  uniqueIds(approvalRevisions, "revision_hash", "approval_revisions");
  uniqueIds(laborClaims, "id", "labor_source_claims");
  uniqueIds(archives, "id", "external_archives");
  uniqueIds(memberEvents, "id", "member_events");
  uniqueIds(identities, "id", "auth_identities");
  uniqueIds(messages, "id", "direct_messages");
  const knowledgeItemIds = uniqueIds(knowledgeItems, "id", "knowledge_items");
  const knowledgeRevisionIds = uniqueIds(knowledgeRevisions, "id", "knowledge_revisions");
  uniqueIds(knowledgeChunks, "id", "knowledge_chunks");
  uniqueIds(knowledgeEvents, "id", "knowledge_events");

  assertReferences(approvalEvents, "approval_id", approvalIds, "approval event");
  assertReferences(approvalRevisions, "approval_id", approvalIds, "approval revision");
  assertReferences(archives, "approval_id", approvalIds, "external archive");
  const deletedMemberTrails = new Map<string, Array<Record<string, string | number | null>>>();
  for (const event of memberEvents) {
    const memberId = requiredText(event, "member_id");
    if (memberIds.has(memberId)) continue;
    const trail = deletedMemberTrails.get(memberId) ?? [];
    trail.push(event);
    deletedMemberTrails.set(memberId, trail);
  }
  // Earlier OA versions deliberately kept audit events after deleting a member.
  // Preserve that evidence without recreating the deleted identity or its access.
  for (const trail of deletedMemberTrails.values()) {
    trail.sort((left, right) => requiredInteger(left, "id") - requiredInteger(right, "id"));
    if (trail.at(-1)?.action !== "delete") throw new Error("Migration member event reference is broken without a terminal deletion event");
  }
  assertReferences(identities, "member_id", memberIds, "authentication identity");
  assertReferences(laborClaims, "claimant_member_id", memberIds, "labor claimant");
  assertReferences(laborClaims, "technical_approval_id", approvalIds, "technical approval");
  assertReferences(laborClaims, "labor_approval_id", approvalIds, "labor approval");
  assertReferences(knowledgeItems, "submitter_member_id", memberIds, "knowledge submitter");
  assertReferences(knowledgeRevisions, "item_id", knowledgeItemIds, "knowledge revision item");
  assertReferences(knowledgeRevisions, "created_by_member_id", memberIds, "knowledge revision author");
  assertOptionalReferences(knowledgeRevisions, "reviewed_by_member_id", memberIds, "knowledge revision reviewer");
  assertReferences(knowledgeChunks, "item_id", knowledgeItemIds, "knowledge chunk item");
  assertReferences(knowledgeChunks, "revision_id", knowledgeRevisionIds, "knowledge chunk revision");
  assertReferences(knowledgeEvents, "item_id", knowledgeItemIds, "knowledge event item");
  assertOptionalReferences(knowledgeEvents, "revision_id", knowledgeRevisionIds, "knowledge event revision");
  assertReferences(knowledgeEvents, "actor_member_id", memberIds, "knowledge event actor");

  for (const message of messages) {
    requiredText(message, "sender_email");
    requiredText(message, "recipient_email");
  }

  for (const identity of identities) {
    const provider = requiredText(identity, "provider");
    if (provider !== "github" && provider !== "feishu") throw new Error("Migration authentication identity has an unsupported provider");
    const subject = requiredText(identity, "provider_subject");
    if (provider === "github" && !/^[1-9]\d{0,31}$/u.test(subject)) throw new Error("Migration GitHub identity has an invalid provider subject");
    if (provider === "feishu" && !/^[A-Za-z0-9_-]{4,128}:[A-Za-z0-9_-]{4,128}:ou[-_][A-Za-z0-9_-]{4,125}$/u.test(subject)) throw new Error("Migration Feishu identity has an invalid provider subject");
  }

  const revisionsByApproval = new Map<string, ApprovalRevision[]>();
  const revisionOwnerByHash = new Map<string, string>();
  for (const row of approvalRevisions) {
    const approvalId = requiredText(row, "approval_id");
    const revision: ApprovalRevision = {
      revisionHash: requiredText(row, "revision_hash"),
      revisionNo: requiredInteger(row, "revision_no"),
      previousRevisionHash: optionalText(row, "previous_revision_hash"),
      stateJson: requiredText(row, "state_json"),
      stateHash: requiredText(row, "state_hash"),
      eventJson: requiredText(row, "event_json"),
    };
    revisionOwnerByHash.set(revision.revisionHash, approvalId);
    const existing = revisionsByApproval.get(approvalId) ?? [];
    existing.push(revision);
    revisionsByApproval.set(approvalId, existing);
  }
  const sortedRevisionRows = [...approvalRevisions].sort((left, right) => {
    const leftApproval = requiredText(left, "approval_id");
    const rightApproval = requiredText(right, "approval_id");
    if (leftApproval < rightApproval) return -1;
    if (leftApproval > rightApproval) return 1;
    return requiredInteger(left, "revision_no") - requiredInteger(right, "revision_no");
  });
  if (sortedRevisionRows.some((row, index) => row !== approvalRevisions[index])) throw new Error("Migration approval revisions are not in deterministic chain order");
  for (const approval of approvals) {
    const id = requiredText(approval, "id");
    const revisionNo = requiredInteger(approval, "current_revision_no");
    const revisionHash = optionalText(approval, "current_revision_hash");
    const revisions = revisionsByApproval.get(id) ?? [];
    if (revisionNo === 0) {
      if (revisionHash !== null || revisions.length) throw new Error(`Migration approval ${id} has an inconsistent empty revision pointer`);
      continue;
    }
    const inspection = await inspectRevisionChain(revisions);
    if (!inspection.valid) throw new Error(`Migration approval ${id} has an invalid revision chain: ${inspection.reason}`);
    const terminal = revisions.at(-1);
    if (!terminal || terminal.revisionNo !== revisionNo || terminal.revisionHash !== revisionHash) throw new Error(`Migration approval ${id} has an inconsistent terminal revision pointer`);
    if (canonicalJson(approvalProjection(approval)) !== terminal.stateJson) throw new Error(`Migration approval ${id} does not match its terminal revision state`);
  }

  for (const archive of archives) {
    const destination = requiredText(archive, "destination");
    const status = requiredText(archive, "status");
    if (status === "pending") throw new Error(`Migration contains a pending external archive (${destination})`);
    const sourceRevisionHash = optionalText(archive, "source_revision_hash");
    if (sourceRevisionHash !== null && revisionOwnerByHash.get(sourceRevisionHash) !== requiredText(archive, "approval_id")) {
      throw new Error("Migration external archive source revision reference is broken");
    }
  }

  const approvalsById = new Map(approvals.map((row) => [requiredText(row, "id"), row]));
  for (const member of members) {
    const ndaAcceptedAt = optionalText(member, "nda_accepted_at");
    const ndaApprovalId = optionalText(member, "nda_approval_id");
    const ndaAgreementVersion = optionalText(member, "nda_agreement_version");
    if (ndaAcceptedAt === null && ndaApprovalId === null && ndaAgreementVersion === null) continue;
    if ((ndaAcceptedAt === null) !== (ndaApprovalId === null)) throw new Error("Migration member has incomplete historical NDA evidence");
    if (ndaAcceptedAt === null || ndaApprovalId === null) throw new Error("Migration member has an agreement version without NDA evidence");
    const ndaApproval = approvalsById.get(ndaApprovalId as string);
    if (!ndaApproval || ndaApproval.type !== "保密协议" || ndaApproval.status !== "已归档") throw new Error("Migration member NDA approval reference is invalid");
    if (requiredText(ndaApproval, "requester_email").toLowerCase() !== requiredText(member, "chatgpt_account").toLowerCase()) throw new Error("Migration member NDA email does not match");
    if (ndaAgreementVersion === null) continue;
    const ndaPayload = parseJsonObject(requiredText(ndaApproval, "payload_json"), "NDA payload");
    if (ndaPayload.agreementVersion !== ndaAgreementVersion || ndaPayload.signerAccountUserId !== member.account_user_id) throw new Error("Migration member NDA subject or version does not match");
  }

  const knowledgeItemStatuses = new Set(["pending", "returned", "rejected", "active", "revoked"]);
  const knowledgeRevisionStatuses = new Set(["pending", "returned", "rejected", "active", "superseded", "revoked"]);
  const knowledgeApprovalActions = new Set(["approved", "approved_internal", "approved_public"]);
  const knowledgeVisibilityActions = new Set(["visibility_changed_internal", "visibility_changed_public"]);
  const knowledgeItemById = new Map<string, Record<string, string | number | null>>();
  for (const item of knowledgeItems) {
    const id = requiredText(item, "id");
    requiredText(item, "project");
    requiredText(item, "title");
    requiredText(item, "category");
    requiredText(item, "submitter_name");
    requiredText(item, "submitter_email");
    requiredText(item, "mutation_revision");
    requiredText(item, "created_at");
    requiredText(item, "updated_at");
    const status = requiredText(item, "status");
    if (!knowledgeItemStatuses.has(status)) throw new Error(`Migration knowledge item ${id} has an invalid status`);
    const visibility = requiredText(item, "visibility");
    if (visibility !== "internal" && visibility !== "public") throw new Error(`Migration knowledge item ${id} has an invalid visibility`);
    if (visibility === "public" && status !== "active" && status !== "revoked") {
      throw new Error(`Migration knowledge item ${id} exposes unapproved knowledge`);
    }
    const revokedAt = optionalText(item, "revoked_at");
    if ((status === "revoked") !== (revokedAt !== null)) throw new Error(`Migration knowledge item ${id} has inconsistent revocation evidence`);
    knowledgeItemById.set(id, item);
  }

  const knowledgeRevisionById = new Map<string, Record<string, string | number | null>>();
  const knowledgeRevisionsByItem = new Map<string, Array<Record<string, string | number | null>>>();
  for (const revision of knowledgeRevisions) {
    const id = requiredText(revision, "id");
    const itemId = requiredText(revision, "item_id");
    const revisionNo = requiredInteger(revision, "revision_no");
    if (revisionNo <= 0) throw new Error(`Migration knowledge revision ${id} has an invalid revision number`);
    requiredText(revision, "title");
    requiredText(revision, "category");
    requiredText(revision, "content");
    if (typeof revision.summary !== "string" || typeof revision.source_label !== "string" || typeof revision.source_url !== "string" || typeof revision.review_note !== "string") {
      throw new Error(`Migration knowledge revision ${id} has malformed text metadata`);
    }
    requiredText(revision, "created_by_name");
    requiredText(revision, "created_by_email");
    requiredText(revision, "created_at");
    const contentHash = requiredText(revision, "content_hash");
    if (!/^[0-9a-f]{64}$/u.test(contentHash) || contentHash !== await knowledgeContentHash(revision)) {
      throw new Error(`Migration knowledge revision ${id} has an invalid content hash`);
    }
    const status = requiredText(revision, "status");
    if (!knowledgeRevisionStatuses.has(status)) throw new Error(`Migration knowledge revision ${id} has an invalid status`);
    const reviewerMemberId = optionalText(revision, "reviewed_by_member_id");
    const reviewerName = optionalText(revision, "reviewed_by_name");
    const reviewerEmail = optionalText(revision, "reviewed_by_email");
    const reviewedAt = optionalText(revision, "reviewed_at");
    const reviewValues = [reviewerMemberId, reviewerName, reviewerEmail, reviewedAt];
    const hasReview = reviewValues.every((value) => value !== null && value !== "");
    if (reviewValues.some((value) => value !== null) && !hasReview) throw new Error(`Migration knowledge revision ${id} has incomplete review evidence`);
    const item = knowledgeItemById.get(itemId);
    const reviewerMemberMatchesSubmitter = reviewerMemberId === item?.submitter_member_id;
    const reviewerEmailMatchesSubmitter = reviewerEmail?.toLowerCase() === String(item?.submitter_email || "").toLowerCase();
    const reviewIdentityOverlapsSubmitter = reviewerMemberMatchesSubmitter || reviewerEmailMatchesSubmitter;
    const adminSelfReview = reviewerMemberMatchesSubmitter
      && reviewerEmailMatchesSubmitter
      && isKnowledgeAdminSelfAuditNote(revision.review_note);
    if (hasReview && reviewIdentityOverlapsSubmitter && !adminSelfReview) {
      throw new Error(`Migration knowledge revision ${id} was self-reviewed`);
    }
    const activatedAt = optionalText(revision, "activated_at");
    const retiredAt = optionalText(revision, "retired_at");
    if (status === "pending") {
      if (hasReview || activatedAt !== null || retiredAt !== null) throw new Error(`Migration pending knowledge revision ${id} has terminal review evidence`);
    } else if (status === "returned" || status === "rejected") {
      if (!hasReview || activatedAt !== null || retiredAt !== null) throw new Error(`Migration reviewed knowledge revision ${id} has inconsistent lifecycle evidence`);
    } else if (status === "active") {
      if (!hasReview || activatedAt === null || retiredAt !== null) throw new Error(`Migration active knowledge revision ${id} has inconsistent lifecycle evidence`);
    } else if (!hasReview || activatedAt === null || retiredAt === null) {
      throw new Error(`Migration retired knowledge revision ${id} has incomplete lifecycle evidence`);
    }
    if ((status === "active" || status === "superseded" || status === "revoked") && activatedAt !== reviewedAt) {
      throw new Error(`Migration knowledge revision ${id} has inconsistent activation evidence`);
    }
    if ((status === "superseded" || status === "revoked")
      && (!Number.isFinite(Date.parse(activatedAt as string))
        || !Number.isFinite(Date.parse(retiredAt as string))
        || Date.parse(retiredAt as string) < Date.parse(activatedAt as string))) {
      throw new Error(`Migration knowledge revision ${id} has an impossible retirement timeline`);
    }
    if ((status === "returned" || status === "rejected") && String(revision.review_note).trim().length < 2) {
      throw new Error(`Migration knowledge revision ${id} has an incomplete review reason`);
    }
    if (hasReview) {
      const reviewActions = status === "returned"
        ? new Set(["returned"])
        : status === "rejected"
          ? new Set(["rejected"])
          : knowledgeApprovalActions;
      const matchingEvents = knowledgeEvents.filter((event) => event.revision_id === id
        && reviewActions.has(event.action as string)
        && event.actor_member_id === reviewerMemberId
        && event.actor_name === reviewerName
        && event.actor_email === reviewerEmail
        && event.note === revision.review_note
        && event.created_at === reviewedAt);
      if (matchingEvents.length !== 1) throw new Error(`Migration knowledge revision ${id} has no unique matching review event`);
    }
    knowledgeRevisionById.set(id, revision);
    const itemRevisions = knowledgeRevisionsByItem.get(itemId) ?? [];
    itemRevisions.push(revision);
    knowledgeRevisionsByItem.set(itemId, itemRevisions);
  }

  const sortedKnowledgeRevisions = [...knowledgeRevisions].sort((left, right) => {
    const leftItem = requiredText(left, "item_id");
    const rightItem = requiredText(right, "item_id");
    if (leftItem < rightItem) return -1;
    if (leftItem > rightItem) return 1;
    const revisionDifference = requiredInteger(left, "revision_no") - requiredInteger(right, "revision_no");
    return revisionDifference || requiredText(left, "id").localeCompare(requiredText(right, "id"));
  });
  if (sortedKnowledgeRevisions.some((row, index) => row !== knowledgeRevisions[index])) throw new Error("Migration knowledge revisions are not in deterministic chain order");

  const finalVisibilityByRevision = new Map<string, "internal" | "public">();
  for (const revision of knowledgeRevisions) {
    const revisionId = requiredText(revision, "id");
    const itemId = requiredText(revision, "item_id");
    const item = knowledgeItemById.get(itemId);
    const revisionStatus = requiredText(revision, "status");
    const reclassificationEvents = knowledgeEvents.filter((event) => event.revision_id === revisionId
      && knowledgeVisibilityActions.has(event.action as string));
    if (!["active", "superseded", "revoked"].includes(revisionStatus)) {
      if (reclassificationEvents.length) throw new Error(`Migration knowledge revision ${revisionId} changes visibility before approval`);
      continue;
    }
    const approvalEvents = knowledgeEvents.filter((event) => event.revision_id === revisionId
      && knowledgeApprovalActions.has(event.action as string));
    if (approvalEvents.length !== 1) throw new Error(`Migration knowledge revision ${revisionId} has no unique visibility approval event`);
    const approvalEvent = approvalEvents[0];
    let visibility: "internal" | "public" = approvalEvent.action === "approved_public" ? "public" : "internal";
    let previousTimestamp = Date.parse(requiredText(approvalEvent, "created_at"));
    if (!Number.isFinite(previousTimestamp)) throw new Error(`Migration knowledge revision ${revisionId} has an invalid visibility timeline`);
    const orderedEvents = [...reclassificationEvents].sort((left, right) => {
      const timestampOrder = requiredText(left, "created_at").localeCompare(requiredText(right, "created_at"));
      return timestampOrder || requiredText(left, "id").localeCompare(requiredText(right, "id"));
    });
    for (const event of orderedEvents) {
      const eventTimestamp = Date.parse(requiredText(event, "created_at"));
      if (!Number.isFinite(eventTimestamp) || eventTimestamp <= previousTimestamp) {
        throw new Error(`Migration knowledge revision ${revisionId} has an invalid visibility timeline`);
      }
      const actorMemberMatchesSubmitter = event.actor_member_id === item?.submitter_member_id;
      const actorEmailMatchesSubmitter = String(event.actor_email || "").toLowerCase() === String(item?.submitter_email || "").toLowerCase();
      const visibilityIdentityOverlapsSubmitter = actorMemberMatchesSubmitter || actorEmailMatchesSubmitter;
      const adminSelfManagement = actorMemberMatchesSubmitter
        && actorEmailMatchesSubmitter
        && isKnowledgeAdminSelfAuditNote(event.note);
      if (visibilityIdentityOverlapsSubmitter && !adminSelfManagement) {
        throw new Error(`Migration knowledge revision ${revisionId} has a self-managed visibility event`);
      }
      if (!adminSelfManagement && event.note !== "") throw new Error(`Migration knowledge revision ${revisionId} has a malformed visibility event`);
      const nextVisibility: "internal" | "public" = event.action === "visibility_changed_public" ? "public" : "internal";
      if (nextVisibility === visibility) throw new Error(`Migration knowledge revision ${revisionId} has a redundant visibility event`);
      visibility = nextVisibility;
      previousTimestamp = eventTimestamp;
    }
    const retiredAt = optionalText(revision, "retired_at");
    if (orderedEvents.length && retiredAt !== null) {
      const retiredTimestamp = Date.parse(retiredAt);
      if (!Number.isFinite(retiredTimestamp) || previousTimestamp >= retiredTimestamp) {
        throw new Error(`Migration knowledge revision ${revisionId} changes visibility after retirement`);
      }
    }
    finalVisibilityByRevision.set(revisionId, visibility);
  }

  for (const item of knowledgeItems) {
    const itemId = requiredText(item, "id");
    const revisions = knowledgeRevisionsByItem.get(itemId) ?? [];
    if (!revisions.length) throw new Error(`Migration knowledge item ${itemId} has no revision`);
    const submitterMemberId = requiredText(item, "submitter_member_id");
    for (let index = 0; index < revisions.length; index += 1) {
      const revision = revisions[index];
      const expectedNo = index + 1;
      if (requiredInteger(revision, "revision_no") !== expectedNo) throw new Error(`Migration knowledge item ${itemId} has a revision gap`);
      const expectedPreviousId = index === 0 ? null : requiredText(revisions[index - 1], "id");
      if (optionalText(revision, "previous_revision_id") !== expectedPreviousId) throw new Error(`Migration knowledge item ${itemId} has a broken revision chain`);
      if (requiredText(revision, "created_by_member_id") !== submitterMemberId) throw new Error(`Migration knowledge item ${itemId} has a foreign revision author`);
      if (index < revisions.length - 1 && !["returned", "superseded"].includes(requiredText(revision, "status"))) {
        throw new Error(`Migration knowledge item ${itemId} has an impossible revision transition`);
      }
      const creationAction = index === 0 ? "submitted" : "resubmitted";
      const creationEvents = knowledgeEvents.filter((event) => event.item_id === itemId
        && event.revision_id === revision.id
        && event.action === creationAction
        && event.actor_member_id === revision.created_by_member_id
        && event.actor_name === revision.created_by_name
        && event.actor_email === revision.created_by_email
        && event.note === ""
        && event.created_at === revision.created_at);
      if (creationEvents.length !== 1) throw new Error(`Migration knowledge revision ${requiredText(revision, "id")} has no unique ${creationAction} event`);
    }
    const current = revisions.at(-1) as Record<string, string | number | null>;
    if (requiredInteger(item, "current_revision_no") !== revisions.length
      || optionalText(item, "current_revision_id") !== requiredText(current, "id")) throw new Error(`Migration knowledge item ${itemId} has an inconsistent current revision pointer`);
    if (requiredText(item, "title") !== requiredText(current, "title")
      || requiredText(item, "category") !== requiredText(current, "category")) throw new Error(`Migration knowledge item ${itemId} does not match its current revision metadata`);

    const itemStatus = requiredText(item, "status");
    const activeRevisionId = optionalText(item, "active_revision_id");
    const activeRevisions = revisions.filter((revision) => revision.status === "active");
    if (itemStatus === "active") {
      if (activeRevisions.length !== 1
        || activeRevisionId !== requiredText(activeRevisions[0], "id")
        || activeRevisionId !== requiredText(current, "id")
        || requiredText(current, "status") !== "active") {
        throw new Error(`Migration knowledge item ${itemId} has an inconsistent active revision pointer`);
      }
    } else {
      if (activeRevisionId !== null || activeRevisions.length) throw new Error(`Migration knowledge item ${itemId} retains active knowledge while ${itemStatus}`);
      if (requiredText(current, "status") !== itemStatus) throw new Error(`Migration knowledge item ${itemId} does not match its current revision status`);
    }
    if (itemStatus === "revoked") {
      const revokedAt = requiredText(item, "revoked_at");
      const revokeEvents = knowledgeEvents.filter((event) => event.item_id === itemId
        && event.revision_id === current.id
        && event.action === "revoked"
        && event.created_at === revokedAt
        && typeof event.note === "string"
        && event.note.trim().length >= 2
        && event.actor_member_id !== submitterMemberId
        && String(event.actor_email || "").toLowerCase() !== requiredText(item, "submitter_email").toLowerCase());
      if (revokeEvents.length !== 1 || optionalText(current, "retired_at") !== revokedAt) {
        throw new Error(`Migration knowledge item ${itemId} has no unique matching revoke event`);
      }
    }
    if (itemStatus === "active" || itemStatus === "revoked") {
      const finalVisibility = finalVisibilityByRevision.get(requiredText(current, "id"));
      if (!finalVisibility || requiredText(item, "visibility") !== finalVisibility) {
        throw new Error(`Migration knowledge item ${itemId} has inconsistent approval visibility`);
      }
      const currentVisibilityEvents = knowledgeEvents.filter((event) => event.revision_id === current.id
        && knowledgeVisibilityActions.has(event.action as string));
      if (currentVisibilityEvents.length) {
        const lastEvent = [...currentVisibilityEvents].sort((left, right) => {
          const timestampOrder = requiredText(left, "created_at").localeCompare(requiredText(right, "created_at"));
          return timestampOrder || requiredText(left, "id").localeCompare(requiredText(right, "id"));
        }).at(-1) as Record<string, string | number | null>;
        if (itemStatus === "active" && requiredText(item, "updated_at") !== requiredText(lastEvent, "created_at")) {
          throw new Error(`Migration knowledge item ${itemId} has inconsistent visibility update evidence`);
        }
      }
    }
  }

  const chunkNumbersByRevision = new Map<string, Set<number>>();
  const chunksByRevision = new Map<string, Array<Record<string, string | number | null>>>();
  for (const chunk of knowledgeChunks) {
    const id = requiredText(chunk, "id");
    const itemId = requiredText(chunk, "item_id");
    const revisionId = requiredText(chunk, "revision_id");
    const revision = knowledgeRevisionById.get(revisionId);
    if (!revision || requiredText(revision, "item_id") !== itemId) throw new Error(`Migration knowledge chunk ${id} crosses item boundaries`);
    const chunkNo = requiredInteger(chunk, "chunk_no");
    if (chunkNo <= 0) throw new Error(`Migration knowledge chunk ${id} has an invalid chunk number`);
    const numbers = chunkNumbersByRevision.get(revisionId) ?? new Set<number>();
    if (numbers.has(chunkNo)) throw new Error(`Migration knowledge revision ${revisionId} has duplicate chunk numbers`);
    numbers.add(chunkNo);
    chunkNumbersByRevision.set(revisionId, numbers);
    if (typeof chunk.section_title !== "string" || typeof chunk.paragraph_ref !== "string") throw new Error(`Migration knowledge chunk ${id} has malformed citation metadata`);
    requiredText(chunk, "content");
    requiredText(chunk, "search_text");
    requiredText(chunk, "created_at");
    if (chunk.is_active !== 0 && chunk.is_active !== 1) throw new Error(`Migration knowledge chunk ${id} has an invalid active marker`);
    const item = knowledgeItemById.get(itemId);
    if ((chunk.is_active === 1) !== (item?.active_revision_id === revisionId && revision.status === "active")) {
      throw new Error(`Migration knowledge chunk ${id} has an inconsistent active marker`);
    }
    const revisionChunks = chunksByRevision.get(revisionId) ?? [];
    revisionChunks.push(chunk);
    chunksByRevision.set(revisionId, revisionChunks);
  }
  for (const revision of knowledgeRevisions) {
    const revisionId = requiredText(revision, "id");
    const chunks = chunksByRevision.get(revisionId) ?? [];
    const status = requiredText(revision, "status");
    if (["active", "superseded", "revoked"].includes(status) && !chunks.length) throw new Error(`Migration knowledge revision ${revisionId} has no indexed chunks`);
    if (["pending", "returned", "rejected"].includes(status) && chunks.length) throw new Error(`Migration unapproved knowledge revision ${revisionId} has indexed chunks`);
    const sortedChunks = [...chunks].sort((left, right) => requiredInteger(left, "chunk_no") - requiredInteger(right, "chunk_no"));
    if (sortedChunks.some((chunk, index) => requiredInteger(chunk, "chunk_no") !== index + 1)) throw new Error(`Migration knowledge revision ${revisionId} has a chunk-number gap`);
    if (chunks.length) {
      const expectedChunks = chunkKnowledgeSubmission({
        title: requiredText(revision, "title"),
        category: requiredText(revision, "category"),
        summary: typeof revision.summary === "string" ? revision.summary : "",
        sourceLabel: typeof revision.source_label === "string" ? revision.source_label : "",
        sourceUrl: typeof revision.source_url === "string" ? revision.source_url : "",
        content: requiredText(revision, "content"),
      });
      const matchesCanonicalChunks = sortedChunks.length === expectedChunks.length && sortedChunks.every((chunk, index) => {
        const expected = expectedChunks[index];
        return chunk.chunk_no === expected.chunkNo
          && chunk.section_title === expected.sectionTitle
          && chunk.paragraph_ref === expected.paragraphRef
          && chunk.content === expected.content
          && chunk.search_text === expected.searchText;
      });
      if (!matchesCanonicalChunks) throw new Error(`Migration knowledge revision ${revisionId} has non-canonical indexed chunks`);
      const activatedAt = requiredText(revision, "activated_at");
      if (sortedChunks.some((chunk) => chunk.created_at !== activatedAt)) {
        throw new Error(`Migration knowledge revision ${revisionId} has inconsistent chunk activation times`);
      }
    }
  }

  for (const event of knowledgeEvents) {
    const id = requiredText(event, "id");
    const itemId = requiredText(event, "item_id");
    const revisionId = requiredText(event, "revision_id");
    if (requiredText(knowledgeRevisionById.get(revisionId) as Record<string, string | number | null>, "item_id") !== itemId) {
      throw new Error(`Migration knowledge event ${id} crosses item boundaries`);
    }
    requiredText(event, "actor_name");
    requiredText(event, "actor_email");
    const action = requiredText(event, "action");
    if (!["submitted", "resubmitted", "approved", "approved_internal", "approved_public", "visibility_changed_internal", "visibility_changed_public", "returned", "rejected", "revoked"].includes(action)) {
      throw new Error(`Migration knowledge event ${id} has an unsupported action`);
    }
    if (knowledgeVisibilityActions.has(action) && !finalVisibilityByRevision.has(revisionId)) {
      throw new Error(`Migration knowledge event ${id} changes visibility outside an approved revision`);
    }
    if (typeof event.note !== "string") throw new Error(`Migration knowledge event ${id} has a malformed note`);
    requiredText(event, "created_at");
  }

  for (const item of knowledgeItems) {
    const itemId = requiredText(item, "id");
    const revisions = knowledgeRevisionsByItem.get(itemId) ?? [];
    for (let index = 0; index < revisions.length; index += 1) {
      const revision = revisions[index];
      const revisionId = requiredText(revision, "id");
      const status = requiredText(revision, "status");
      const expectedActions = [index === 0 ? "submitted" : "resubmitted"];
      if (status === "returned") expectedActions.push("returned");
      else if (status === "rejected") expectedActions.push("rejected");
      else if (status === "active" || status === "superseded") expectedActions.push("approved");
      else if (status === "revoked") expectedActions.push("approved", "revoked");
      const actualActions = knowledgeEvents
        .filter((event) => event.revision_id === revisionId)
        .filter((event) => !knowledgeVisibilityActions.has(requiredText(event, "action")))
        .map((event) => knowledgeApprovalActions.has(requiredText(event, "action")) ? "approved" : requiredText(event, "action"))
        .sort();
      expectedActions.sort();
      if (actualActions.length !== expectedActions.length || actualActions.some((action, actionIndex) => action !== expectedActions[actionIndex])) {
        throw new Error(`Migration knowledge revision ${revisionId} has a contradictory event history`);
      }
    }
  }

  return true;
}

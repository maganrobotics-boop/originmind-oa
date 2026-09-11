import { getD1Database } from "../db";
import {
  KNOWLEDGE_PROJECT,
  MAX_KNOWLEDGE_CHUNKS,
  chunkKnowledgeSubmission,
  type KnowledgeReviewAction,
  type KnowledgeStatus,
  type KnowledgeSubmission,
  type SearchableKnowledgeChunk,
} from "./knowledge-policy";

const KNOWLEDGE_LIST_LIMIT = 100;
const KNOWLEDGE_SEARCH_CANDIDATE_LIMIT = 1_500;

export type KnowledgeActor = {
  memberId: string;
  accountUserId: string;
  memberMutationRevision: string;
  name: string;
  email: string;
  isAdmin: boolean;
  configuredReviewer?: boolean;
};

export type KnowledgeItemRow = {
  id: string;
  project: string;
  title: string;
  category: string;
  submitter_member_id: string;
  submitter_name: string;
  submitter_email: string;
  status: KnowledgeStatus;
  current_revision_no: number;
  current_revision_id: string | null;
  active_revision_id: string | null;
  mutation_revision: string;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
};

type KnowledgeRevisionStatus = KnowledgeStatus | "superseded";

type KnowledgeRevisionRow = {
  id: string;
  item_id: string;
  revision_no: number;
  previous_revision_id: string | null;
  title: string;
  category: string;
  content: string;
  summary: string;
  source_label: string;
  source_url: string;
  content_hash: string;
  status: KnowledgeRevisionStatus;
  created_by_member_id: string;
  created_by_name: string;
  created_by_email: string;
  reviewed_by_member_id: string | null;
  reviewed_by_name: string | null;
  reviewed_by_email: string | null;
  review_note: string;
  created_at: string;
  reviewed_at: string | null;
  activated_at: string | null;
  retired_at: string | null;
};

type KnowledgeEventRow = {
  id: string;
  item_id: string;
  revision_id: string | null;
  actor_member_id: string;
  actor_name: string;
  actor_email: string;
  action: string;
  note: string;
  created_at: string;
};

export type KnowledgeItemWithRevisionRow = KnowledgeItemRow & {
  summary: string | null;
  source_label: string | null;
  source_url: string | null;
  content: string | null;
  content_hash: string | null;
  revision_status: KnowledgeRevisionStatus | null;
  reviewed_by_member_id: string | null;
  reviewed_by_name: string | null;
  reviewed_by_email: string | null;
  review_note: string | null;
  reviewed_at: string | null;
  activated_at: string | null;
  retired_at: string | null;
};

type KnowledgeItemListRow = Omit<KnowledgeItemWithRevisionRow, "content" | "content_hash">;

export type KnowledgeListScope = "mine" | "review" | "all";

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function resultRows<T>(result: D1Result<T> | undefined): T[] {
  return result?.results ?? [];
}

function actorGuard(actor: KnowledgeActor, requireReviewer = false): { sql: string; values: unknown[] } {
  return {
    sql: `EXISTS (
      SELECT 1 FROM members AS knowledge_actor
      WHERE knowledge_actor.id = ?
        AND knowledge_actor.status = 'active'
        AND knowledge_actor.account_user_id = ?
        AND knowledge_actor.mutation_revision = ?
        AND knowledge_actor.nda_accepted_at IS NOT NULL
        AND knowledge_actor.nda_agreement_version IS NOT NULL
        ${requireReviewer ? `AND (
          ? = 1
          OR knowledge_actor.role = 'project_owner'
          OR EXISTS (
            SELECT 1
            FROM json_each(CASE WHEN json_valid(knowledge_actor.permissions_json) THEN knowledge_actor.permissions_json ELSE '[]' END)
            WHERE value = 'project_owner'
          )
        )` : ""}
    )`,
    values: [actor.memberId, actor.accountUserId, actor.memberMutationRevision, ...(requireReviewer ? [(actor.isAdmin || actor.configuredReviewer) ? 1 : 0] : [])],
  };
}

function serializeItem(row: KnowledgeItemWithRevisionRow | KnowledgeItemListRow | KnowledgeItemRow) {
  const revision = row as KnowledgeItemWithRevisionRow;
  return {
    id: row.id,
    project: row.project,
    title: row.title,
    category: row.category,
    submitterMemberId: row.submitter_member_id,
    submitterName: row.submitter_name,
    submitterEmail: row.submitter_email,
    status: row.status,
    currentRevisionNo: Number(row.current_revision_no),
    currentRevisionId: row.current_revision_id || undefined,
    activeRevisionId: row.active_revision_id || undefined,
    mutationRevision: row.mutation_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at || undefined,
    ...(Object.hasOwn(revision, "summary") ? {
      summary: revision.summary || "",
      sourceLabel: revision.source_label || "",
      sourceUrl: revision.source_url || "",
      ...(Object.hasOwn(revision, "content") ? { content: revision.content || "", contentHash: revision.content_hash || "" } : {}),
      revisionStatus: revision.revision_status || undefined,
      reviewedByMemberId: revision.reviewed_by_member_id || undefined,
      reviewedByName: revision.reviewed_by_name || undefined,
      reviewedByEmail: revision.reviewed_by_email || undefined,
      reviewNote: revision.review_note || "",
      reviewedAt: revision.reviewed_at || undefined,
      activatedAt: revision.activated_at || undefined,
      retiredAt: revision.retired_at || undefined,
    } : {}),
  };
}

function serializeRevision(row: KnowledgeRevisionRow) {
  return {
    id: row.id,
    itemId: row.item_id,
    revisionNo: Number(row.revision_no),
    previousRevisionId: row.previous_revision_id || undefined,
    title: row.title,
    category: row.category,
    content: row.content,
    summary: row.summary,
    sourceLabel: row.source_label,
    sourceUrl: row.source_url,
    contentHash: row.content_hash,
    status: row.status,
    createdByMemberId: row.created_by_member_id,
    createdByName: row.created_by_name,
    createdByEmail: row.created_by_email,
    reviewedByMemberId: row.reviewed_by_member_id || undefined,
    reviewedByName: row.reviewed_by_name || undefined,
    reviewedByEmail: row.reviewed_by_email || undefined,
    reviewNote: row.review_note,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at || undefined,
    activatedAt: row.activated_at || undefined,
    retiredAt: row.retired_at || undefined,
  };
}

function serializePublicItem(row: KnowledgeItemWithRevisionRow | KnowledgeItemListRow) {
  return {
    id: row.id,
    project: row.project,
    title: row.title,
    category: row.category,
    status: row.status,
    currentRevisionNo: Number(row.current_revision_no),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    summary: row.summary || "",
    sourceLabel: row.source_label || "",
    sourceUrl: row.source_url || "",
  };
}

function itemCapabilities(row: KnowledgeItemRow, actor: KnowledgeActor, canReview: boolean) {
  const isSubmitter = row.submitter_member_id === actor.memberId
    || normalizeEmail(row.submitter_email) === normalizeEmail(actor.email);
  return {
    canReview: canReview && !isSubmitter && row.status === "pending",
    canRevoke: canReview && !isSubmitter && row.status === "active",
  };
}

function serializeEvent(row: KnowledgeEventRow) {
  return {
    id: row.id,
    itemId: row.item_id,
    revisionId: row.revision_id || undefined,
    actorMemberId: row.actor_member_id,
    actorName: row.actor_name,
    actorEmail: row.actor_email,
    action: row.action,
    note: row.note,
    createdAt: row.created_at,
  };
}

const ITEM_WITH_REVISION_SELECT = `
  SELECT
    i.*,
    r.summary,
    r.source_label,
    r.source_url,
    r.content,
    r.content_hash,
    r.status AS revision_status,
    r.reviewed_by_member_id,
    r.reviewed_by_name,
    r.reviewed_by_email,
    r.review_note,
    r.reviewed_at,
    r.activated_at,
    r.retired_at
  FROM knowledge_items AS i
  LEFT JOIN knowledge_revisions AS r ON r.id = i.current_revision_id
`;

const LIST_ITEM_WITH_REVISION_SELECT = `
  SELECT
    i.*,
    r.summary,
    r.source_label,
    r.source_url,
    r.status AS revision_status,
    r.reviewed_by_member_id,
    r.reviewed_by_name,
    r.reviewed_by_email,
    r.review_note,
    r.reviewed_at,
    r.activated_at,
    r.retired_at
  FROM knowledge_items AS i
  LEFT JOIN knowledge_revisions AS r ON r.id = i.current_revision_id
`;

export async function listKnowledgeItems(scope: KnowledgeListScope, actor: KnowledgeActor, canReview: boolean) {
  const database = await getD1Database();
  const guard = actorGuard(actor, canReview);
  let statement: D1PreparedStatement;
  if (scope === "mine") {
    statement = database.prepare(`${LIST_ITEM_WITH_REVISION_SELECT}
      WHERE i.submitter_member_id = ? AND lower(i.submitter_email) = ? AND ${guard.sql}
      ORDER BY i.updated_at DESC, i.id DESC LIMIT ?
    `).bind(actor.memberId, normalizeEmail(actor.email), ...guard.values, KNOWLEDGE_LIST_LIMIT);
  } else if (scope === "review") {
    if (!canReview) return [];
    statement = database.prepare(`${LIST_ITEM_WITH_REVISION_SELECT}
      WHERE i.status = 'pending'
        AND i.submitter_member_id <> ? AND lower(i.submitter_email) <> ?
        AND ${guard.sql}
      ORDER BY i.created_at ASC, i.id ASC LIMIT ?
    `).bind(actor.memberId, normalizeEmail(actor.email), ...guard.values, KNOWLEDGE_LIST_LIMIT);
  } else if (canReview) {
    statement = database.prepare(`${LIST_ITEM_WITH_REVISION_SELECT}
      WHERE ${guard.sql}
      ORDER BY CASE i.status WHEN 'pending' THEN 0 ELSE 1 END, i.updated_at DESC, i.id DESC LIMIT ?
    `).bind(...guard.values, KNOWLEDGE_LIST_LIMIT);
  } else {
    statement = database.prepare(`${LIST_ITEM_WITH_REVISION_SELECT}
      WHERE (i.status = 'active' OR (i.submitter_member_id = ? AND lower(i.submitter_email) = ?))
        AND ${guard.sql}
      ORDER BY i.updated_at DESC, i.id DESC LIMIT ?
    `).bind(actor.memberId, normalizeEmail(actor.email), ...guard.values, KNOWLEDGE_LIST_LIMIT);
  }
  const result = await statement.all<KnowledgeItemListRow>();
  return result.results.map((row) => {
    const isOwner = row.submitter_member_id === actor.memberId && normalizeEmail(row.submitter_email) === normalizeEmail(actor.email);
    const item = canReview || isOwner ? serializeItem(row) : serializePublicItem(row);
    return { ...item, ...itemCapabilities(row, actor, canReview) };
  });
}

export async function countPendingKnowledgeItems(actor: KnowledgeActor): Promise<number> {
  const database = await getD1Database();
  const guard = actorGuard(actor, true);
  const row = await database.prepare(`SELECT COUNT(*) AS total FROM knowledge_items
    WHERE status = 'pending' AND submitter_member_id <> ? AND lower(submitter_email) <> ? AND ${guard.sql}`)
    .bind(actor.memberId, normalizeEmail(actor.email), ...guard.values).first<{ total: number | string }>();
  return Number(row?.total ?? 0);
}

export async function findKnowledgeItem(id: string, actor: KnowledgeActor, requireReviewer = false): Promise<KnowledgeItemWithRevisionRow | null> {
  const database = await getD1Database();
  const guard = actorGuard(actor, requireReviewer);
  return database.prepare(`${ITEM_WITH_REVISION_SELECT} WHERE i.id = ? AND ${guard.sql} LIMIT 1`)
    .bind(id, ...guard.values).first<KnowledgeItemWithRevisionRow>();
}

export async function knowledgeRevisionHashExists(itemId: string, contentHash: string): Promise<boolean> {
  const database = await getD1Database();
  return Boolean(await database.prepare("SELECT 1 AS present FROM knowledge_revisions WHERE item_id = ? AND content_hash = ? LIMIT 1").bind(itemId, contentHash).first());
}

export async function getKnowledgeItemDetail(id: string, actor: KnowledgeActor, canReview: boolean) {
  const database = await getD1Database();
  const guard = actorGuard(actor, canReview);
  const item = await database.prepare(`${ITEM_WITH_REVISION_SELECT} WHERE i.id = ? AND ${guard.sql} LIMIT 1`)
    .bind(id, ...guard.values).first<KnowledgeItemWithRevisionRow>();
  if (!item) return null;
  const isOwner = item.submitter_member_id === actor.memberId || normalizeEmail(item.submitter_email) === normalizeEmail(actor.email);
  if (item.status !== "active" && !isOwner && !canReview) return null;

  if (!isOwner && !canReview) {
    return { item: { ...serializePublicItem(item), ...itemCapabilities(item, actor, canReview) }, revisions: item.content === null ? [] : [{
      id: item.current_revision_id,
      itemId: item.id,
      revisionNo: Number(item.current_revision_no),
      title: item.title,
      category: item.category,
      content: item.content,
      summary: item.summary || "",
      sourceLabel: item.source_label || "",
      sourceUrl: item.source_url || "",
      status: item.revision_status,
      createdAt: item.updated_at,
    }], events: [] };
  }

  const [revisionsResult, eventsResult] = await database.batch([
    database.prepare("SELECT * FROM knowledge_revisions WHERE item_id = ? ORDER BY revision_no DESC, id DESC").bind(id),
    database.prepare("SELECT * FROM knowledge_events WHERE item_id = ? ORDER BY created_at ASC, id ASC").bind(id),
  ]);
  return {
    item: { ...serializeItem(item), ...itemCapabilities(item, actor, canReview) },
    revisions: resultRows(revisionsResult as D1Result<KnowledgeRevisionRow>).map(serializeRevision),
    events: resultRows(eventsResult as D1Result<KnowledgeEventRow>).map(serializeEvent),
  };
}

export async function createKnowledgeItem(actor: KnowledgeActor, submission: KnowledgeSubmission, contentHash: string) {
  const database = await getD1Database();
  const now = new Date().toISOString();
  const itemId = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  const mutationRevision = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const guard = actorGuard(actor);
  const [itemResult] = await database.batch([
    database.prepare(`
      INSERT INTO knowledge_items (
        id, project, title, category, submitter_member_id, submitter_name, submitter_email,
        status, current_revision_no, current_revision_id, active_revision_id, mutation_revision,
        created_at, updated_at, revoked_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, NULL, ?, ?, ?, NULL
      WHERE ${guard.sql}
      RETURNING *
    `).bind(itemId, KNOWLEDGE_PROJECT, submission.title, submission.category, actor.memberId, actor.name,
      normalizeEmail(actor.email), revisionId, mutationRevision, now, now, ...guard.values),
    database.prepare(`
      INSERT INTO knowledge_revisions (
        id, item_id, revision_no, previous_revision_id, title, category, content, summary, source_label, source_url,
        content_hash, status, created_by_member_id, created_by_name, created_by_email,
        reviewed_by_member_id, reviewed_by_name, reviewed_by_email, review_note,
        created_at, reviewed_at, activated_at, retired_at
      )
      SELECT ?, ?, 1, NULL, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL, NULL, NULL, '', ?, NULL, NULL, NULL
      WHERE EXISTS (SELECT 1 FROM knowledge_items WHERE id = ? AND current_revision_id = ? AND mutation_revision = ? AND status = 'pending')
    `).bind(revisionId, itemId, submission.title, submission.category, submission.content, submission.summary,
      submission.sourceLabel, submission.sourceUrl, contentHash, actor.memberId, actor.name, normalizeEmail(actor.email), now,
      itemId, revisionId, mutationRevision),
    database.prepare(`
      INSERT INTO knowledge_events (id, item_id, revision_id, actor_member_id, actor_name, actor_email, action, note, created_at)
      SELECT ?, ?, ?, ?, ?, ?, 'submitted', '', ?
      WHERE EXISTS (SELECT 1 FROM knowledge_items WHERE id = ? AND current_revision_id = ? AND mutation_revision = ? AND status = 'pending')
    `).bind(eventId, itemId, revisionId, actor.memberId, actor.name, normalizeEmail(actor.email), now,
      itemId, revisionId, mutationRevision),
  ]);
  const created = resultRows(itemResult as D1Result<KnowledgeItemRow>)[0];
  return created ? serializeItem({
    ...created,
    summary: submission.summary,
    source_label: submission.sourceLabel,
    source_url: submission.sourceUrl,
    content: submission.content,
    content_hash: contentHash,
    revision_status: "pending",
    reviewed_by_member_id: null,
    reviewed_by_name: null,
    reviewed_by_email: null,
    review_note: "",
    reviewed_at: null,
    activated_at: null,
    retired_at: null,
  }) : null;
}

export async function resubmitKnowledgeItem(
  existing: KnowledgeItemWithRevisionRow,
  actor: KnowledgeActor,
  submission: KnowledgeSubmission,
  contentHash: string,
) {
  const database = await getD1Database();
  const now = new Date().toISOString();
  const revisionId = crypto.randomUUID();
  const mutationRevision = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const revisionNo = Number(existing.current_revision_no) + 1;
  const guard = actorGuard(actor);
  const [itemResult] = await database.batch([
    database.prepare(`
      UPDATE knowledge_items SET
        title = ?, category = ?, status = 'pending', current_revision_no = ?, current_revision_id = ?,
        active_revision_id = NULL, mutation_revision = ?, updated_at = ?, revoked_at = NULL
      WHERE id = ? AND status = 'returned' AND current_revision_id = ? AND mutation_revision = ?
        AND submitter_member_id = ? AND lower(submitter_email) = ? AND ${guard.sql}
      RETURNING *
    `).bind(submission.title, submission.category, revisionNo, revisionId, mutationRevision, now,
      existing.id, existing.current_revision_id, existing.mutation_revision, actor.memberId, normalizeEmail(actor.email), ...guard.values),
    database.prepare(`
      INSERT INTO knowledge_revisions (
        id, item_id, revision_no, previous_revision_id, title, category, content, summary, source_label, source_url,
        content_hash, status, created_by_member_id, created_by_name, created_by_email,
        reviewed_by_member_id, reviewed_by_name, reviewed_by_email, review_note,
        created_at, reviewed_at, activated_at, retired_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL, NULL, NULL, '', ?, NULL, NULL, NULL
      WHERE EXISTS (SELECT 1 FROM knowledge_items WHERE id = ? AND current_revision_id = ? AND mutation_revision = ? AND status = 'pending')
    `).bind(revisionId, existing.id, revisionNo, existing.current_revision_id, submission.title, submission.category,
      submission.content, submission.summary, submission.sourceLabel, submission.sourceUrl, contentHash,
      actor.memberId, actor.name, normalizeEmail(actor.email), now, existing.id, revisionId, mutationRevision),
    database.prepare(`
      INSERT INTO knowledge_events (id, item_id, revision_id, actor_member_id, actor_name, actor_email, action, note, created_at)
      SELECT ?, ?, ?, ?, ?, ?, 'resubmitted', '', ?
      WHERE EXISTS (SELECT 1 FROM knowledge_items WHERE id = ? AND current_revision_id = ? AND mutation_revision = ? AND status = 'pending')
    `).bind(eventId, existing.id, revisionId, actor.memberId, actor.name, normalizeEmail(actor.email), now,
      existing.id, revisionId, mutationRevision),
  ]);
  const updated = resultRows(itemResult as D1Result<KnowledgeItemRow>)[0];
  return updated ? serializeItem({
    ...updated,
    summary: submission.summary,
    source_label: submission.sourceLabel,
    source_url: submission.sourceUrl,
    content: submission.content,
    content_hash: contentHash,
    revision_status: "pending",
    reviewed_by_member_id: null,
    reviewed_by_name: null,
    reviewed_by_email: null,
    review_note: "",
    reviewed_at: null,
    activated_at: null,
    retired_at: null,
  }) : null;
}

export async function reviewKnowledgeItem(
  existing: KnowledgeItemWithRevisionRow,
  actor: KnowledgeActor,
  action: KnowledgeReviewAction,
  note: string,
) {
  const database = await getD1Database();
  const now = new Date().toISOString();
  const mutationRevision = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const nextStatus: KnowledgeStatus = action === "approve" ? "active" : action === "return" ? "returned" : action === "reject" ? "rejected" : "revoked";
  const expectedStatus: KnowledgeStatus = action === "revoke" ? "active" : "pending";
  const guard = actorGuard(actor, true);
  const chunks = action === "approve" ? chunkKnowledgeSubmission({
    title: existing.title,
    category: existing.category,
    summary: existing.summary || "",
    sourceLabel: existing.source_label || "",
    sourceUrl: existing.source_url || "",
    content: existing.content || "",
  }) : [];
  if (chunks.length > MAX_KNOWLEDGE_CHUNKS) throw new Error("knowledge chunk limit exceeded");
  const statements: D1PreparedStatement[] = [
    database.prepare(`
      UPDATE knowledge_items SET
        status = ?, active_revision_id = ?, mutation_revision = ?, updated_at = ?, revoked_at = ?
      WHERE id = ? AND status = ? AND current_revision_id = ? AND mutation_revision = ?
        AND submitter_member_id <> ? AND lower(submitter_email) <> ? AND ${guard.sql}
      RETURNING *
    `).bind(nextStatus, action === "approve" ? existing.current_revision_id : null, mutationRevision, now,
      action === "revoke" ? now : null, existing.id, expectedStatus, existing.current_revision_id,
      existing.mutation_revision, actor.memberId, normalizeEmail(actor.email), ...guard.values),
  ];
  if (action === "revoke") {
    statements.push(database.prepare(`
      UPDATE knowledge_revisions SET status = 'revoked', retired_at = ?
      WHERE id = ? AND item_id = ? AND status = 'active'
        AND EXISTS (SELECT 1 FROM knowledge_items WHERE id = ? AND mutation_revision = ? AND status = 'revoked' AND active_revision_id IS NULL)
    `).bind(now, existing.current_revision_id, existing.id, existing.id, mutationRevision));
  } else {
    statements.push(database.prepare(`
      UPDATE knowledge_revisions SET
        status = ?, reviewed_by_member_id = ?, reviewed_by_name = ?, reviewed_by_email = ?,
        review_note = ?, reviewed_at = ?, activated_at = ?, retired_at = NULL
      WHERE id = ? AND item_id = ? AND status = 'pending'
        AND EXISTS (SELECT 1 FROM knowledge_items WHERE id = ? AND mutation_revision = ? AND status = ?)
    `).bind(nextStatus, actor.memberId, actor.name, normalizeEmail(actor.email), note, now,
      action === "approve" ? now : null, existing.current_revision_id, existing.id, existing.id, mutationRevision, nextStatus));
  }
  statements.push(database.prepare(`
    UPDATE knowledge_chunks SET is_active = 0
    WHERE item_id = ?
      AND EXISTS (SELECT 1 FROM knowledge_items WHERE id = ? AND mutation_revision = ? AND status = ?)
  `).bind(existing.id, existing.id, mutationRevision, nextStatus));
  if (action === "approve") {
    for (const chunk of chunks) {
      statements.push(database.prepare(`
        INSERT INTO knowledge_chunks (
          id, item_id, revision_id, chunk_no, section_title, paragraph_ref, content, search_text, is_active, created_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1, ?
        WHERE EXISTS (
          SELECT 1 FROM knowledge_items
          WHERE id = ? AND active_revision_id = ? AND mutation_revision = ? AND status = 'active'
        )
      `).bind(crypto.randomUUID(), existing.id, existing.current_revision_id, chunk.chunkNo, chunk.sectionTitle,
        chunk.paragraphRef, chunk.content, chunk.searchText, now, existing.id, existing.current_revision_id, mutationRevision));
    }
  }
  statements.push(database.prepare(`
    INSERT INTO knowledge_events (id, item_id, revision_id, actor_member_id, actor_name, actor_email, action, note, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM knowledge_items WHERE id = ? AND current_revision_id = ? AND mutation_revision = ? AND status = ?)
  `).bind(eventId, existing.id, existing.current_revision_id, actor.memberId, actor.name, normalizeEmail(actor.email),
    action === "approve" ? "approved" : action === "return" ? "returned" : action === "reject" ? "rejected" : "revoked",
    note, now, existing.id, existing.current_revision_id, mutationRevision, nextStatus));

  const [itemResult] = await database.batch(statements);
  const updated = resultRows(itemResult as D1Result<KnowledgeItemRow>)[0];
  if (!updated) return null;
  return serializeItem({
    ...updated,
    summary: existing.summary,
    source_label: existing.source_label,
    source_url: existing.source_url,
    content: existing.content,
    content_hash: existing.content_hash,
    revision_status: nextStatus,
    reviewed_by_member_id: action === "revoke" ? existing.reviewed_by_member_id : actor.memberId,
    reviewed_by_name: action === "revoke" ? existing.reviewed_by_name : actor.name,
    reviewed_by_email: action === "revoke" ? existing.reviewed_by_email : normalizeEmail(actor.email),
    review_note: action === "revoke" ? existing.review_note : note,
    reviewed_at: action === "revoke" ? existing.reviewed_at : now,
    activated_at: action === "approve" ? now : existing.activated_at,
    retired_at: action === "revoke" ? now : null,
  });
}

export async function getActiveKnowledgeChunks(actor: KnowledgeActor): Promise<SearchableKnowledgeChunk[]> {
  const database = await getD1Database();
  const guard = actorGuard(actor);
  const result = await database.prepare(`
    SELECT
      c.id, c.item_id, c.revision_id, r.title, r.category, r.source_label, r.source_url, c.section_title, c.paragraph_ref,
      c.content, c.search_text, i.updated_at
    FROM knowledge_chunks AS c
    INNER JOIN knowledge_items AS i ON i.id = c.item_id
    INNER JOIN knowledge_revisions AS r ON r.id = c.revision_id AND r.item_id = i.id
    WHERE c.is_active = 1
      AND i.status = 'active'
      AND r.status = 'active'
      AND i.active_revision_id = c.revision_id
      AND ${guard.sql}
    ORDER BY i.updated_at DESC, c.item_id ASC, c.chunk_no ASC
    LIMIT ?
  `).bind(...guard.values, KNOWLEDGE_SEARCH_CANDIDATE_LIMIT).all<{
    id: string;
    item_id: string;
    revision_id: string;
    title: string;
    category: string;
    source_label: string;
    source_url: string;
    section_title: string;
    paragraph_ref: string;
    content: string;
    search_text: string;
    updated_at: string;
  }>();
  return result.results.map((row) => ({
    id: row.id,
    itemId: row.item_id,
    revisionId: row.revision_id,
    title: row.title,
    category: row.category,
    sourceLabel: row.source_label,
    sourceUrl: row.source_url,
    sectionTitle: row.section_title,
    paragraphRef: row.paragraph_ref,
    content: row.content,
    searchText: row.search_text,
    updatedAt: row.updated_at,
  }));
}

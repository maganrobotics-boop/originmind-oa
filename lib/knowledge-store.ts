import { getD1Database } from "../db";
import {
  KNOWLEDGE_PROJECT,
  MAX_KNOWLEDGE_CONTENT_LENGTH,
  MAX_KNOWLEDGE_CHUNKS,
  chunkKnowledgeSubmission,
  hashKnowledgeSubmission,
  isWellFormedUnicode,
  isPublicKnowledgeConfirmation,
  knowledgeAdminSelfAuditNote,
  knowledgeSearchTerms,
  type KnowledgeReviewAction,
  type KnowledgeStatus,
  type KnowledgeSubmission,
  type KnowledgeVisibility,
  type SearchableKnowledgeChunk,
} from "./knowledge-policy";
import {
  KNOWLEDGE_LIST_QUERY_MAX_LENGTH,
  KNOWLEDGE_LIST_SORTS,
  type KnowledgeListOptions,
  type KnowledgeListSort,
} from "./knowledge-types";

const KNOWLEDGE_LIST_LIMIT = 100;
// Retrieval ranks at most six chunks. Keep the candidate pool large enough for
// cross-document recall without hydrating the 4,096-chunk storage ceiling on
// every question.
export const KNOWLEDGE_SEARCH_CANDIDATE_LIMIT = 256;
const KNOWLEDGE_SQL_SEARCH_TERM_LIMIT = 16;
const KNOWLEDGE_TITLE_COLLATOR = new Intl.Collator("zh-CN-u-co-pinyin", {
  usage: "sort",
  sensitivity: "base",
  numeric: true,
});
// D1 allows at most 2 MiB of bound data and 50 queries per free-plan Worker
// invocation. Packing at most 1.5 MB/256 rows leaves headroom for JSON and
// keeps a worst-case 5 MiB Markdown approval comfortably below that budget.
const JSON_BULK_MAX_ROWS = 256;
const JSON_BULK_MAX_BYTES = 1_500_000;

function searchTermRowsSql(termCount: number): string {
  if (!Number.isSafeInteger(termCount) || termCount < 1 || termCount > KNOWLEDGE_SQL_SEARCH_TERM_LIMIT) {
    throw new RangeError("invalid knowledge search term count");
  }
  const baseQuota = Math.floor(KNOWLEDGE_SEARCH_CANDIDATE_LIMIT / termCount);
  const remainder = KNOWLEDGE_SEARCH_CANDIDATE_LIMIT % termCount;
  return Array.from({ length: termCount }, (_, index) => (
    `(${index + 1}, ?, ${baseQuota + (index < remainder ? 1 : 0)})`
  )).join(", ");
}

function sqlKnowledgeSearchTerms(question: string): string[] {
  const terms = knowledgeSearchTerms(question);
  if (terms.length <= KNOWLEDGE_SQL_SEARCH_TERM_LIMIT) return terms;

  // Keep the longest terms (the policy orders them first), then sample the
  // entire bounded list so late question concepts are still represented. The
  // application ranker continues to use all policy terms after this SQL pass.
  const selected: string[] = [];
  const seen = new Set<string>();
  const add = (term: string) => {
    if (!seen.has(term) && selected.length < KNOWLEDGE_SQL_SEARCH_TERM_LIMIT) {
      seen.add(term);
      selected.push(term);
    }
  };
  for (const term of terms.slice(0, KNOWLEDGE_SQL_SEARCH_TERM_LIMIT / 2)) add(term);
  for (let index = 1; index <= KNOWLEDGE_SQL_SEARCH_TERM_LIMIT / 2; index += 1) {
    add(terms[Math.round(index * (terms.length - 1) / (KNOWLEDGE_SQL_SEARCH_TERM_LIMIT / 2))]);
  }
  for (const term of terms) add(term);
  if (selected.some((term) => !term || term.length > 64 || !isWellFormedUnicode(term))) {
    throw new RangeError("invalid knowledge search term");
  }
  return selected;
}

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
  visibility: KnowledgeVisibility;
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
  content_part_count: number | string | null;
};

type KnowledgeRevisionPartRow = {
  revision_id: string;
  part_no: number;
  content: string;
};

export type KnowledgeContentPartInput = string | { content: string };

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
  content_part_count: number | string | null;
};

export type PublicKnowledgeSuggestionCandidate = {
  title: string;
  sectionTitle: string;
  updatedAt: string;
};

type KnowledgeItemListRow = Omit<KnowledgeItemWithRevisionRow, "content" | "content_hash">;

export type KnowledgeListScope = "mine" | "review" | "all";

function normalizeKnowledgeListOptions(options?: KnowledgeListOptions): { query: string; sort?: KnowledgeListSort } {
  const query = options?.query?.trim() || "";
  if (Array.from(query).length > KNOWLEDGE_LIST_QUERY_MAX_LENGTH) {
    throw new RangeError("knowledge list query is too long");
  }
  const sort = options?.sort;
  if (sort && !(KNOWLEDGE_LIST_SORTS as readonly string[]).includes(sort)) {
    throw new RangeError("invalid knowledge list sort");
  }
  return { query, sort };
}

function knowledgeListSearchFilter(query: string): { sql: string; values: string[] } {
  if (!query) return { sql: "", values: [] };
  return {
    sql: `AND (
      instr(lower(COALESCE(i.title, '')), lower(?)) > 0
      OR instr(lower(COALESCE(i.category, '')), lower(?)) > 0
      OR instr(lower(COALESCE(r.summary, '')), lower(?)) > 0
      OR instr(lower(COALESCE(r.source_label, '')), lower(?)) > 0
      OR instr(lower(COALESCE(r.content, '')), lower(?)) > 0
      OR EXISTS (
        SELECT 1
        FROM knowledge_revision_parts AS list_part
        WHERE list_part.item_id = i.id
          AND list_part.revision_id = i.current_revision_id
          AND instr(lower(list_part.content), lower(?)) > 0
      )
    )`,
    values: Array.from({ length: 6 }, () => query),
  };
}

function compareKnowledgeTitles(left: KnowledgeItemListRow, right: KnowledgeItemListRow, sort: KnowledgeListSort): number {
  const titleOrder = KNOWLEDGE_TITLE_COLLATOR.compare(left.title, right.title);
  return (sort === "title_desc" ? -titleOrder : titleOrder)
    || right.updated_at.localeCompare(left.updated_at)
    || left.id.localeCompare(right.id);
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function submitterIdentity(row: Pick<KnowledgeItemRow, "submitter_member_id" | "submitter_email">, actor: KnowledgeActor) {
  const memberIdMatches = row.submitter_member_id === actor.memberId;
  const emailMatches = normalizeEmail(row.submitter_email) === normalizeEmail(actor.email);
  return {
    overlaps: memberIdMatches || emailMatches,
    exact: memberIdMatches && emailMatches,
  };
}

function timestampAfter(value: string): string {
  const now = Date.now();
  const previous = Date.parse(value);
  return new Date(Number.isFinite(previous) ? Math.max(now, previous + 1) : now).toISOString();
}

function resultRows<T>(result: D1Result<T> | undefined): T[] {
  return result?.results ?? [];
}

function contentPartCount(row: Pick<KnowledgeItemWithRevisionRow, "current_revision_id" | "content_part_count">): number {
  if (!row.current_revision_id) return 0;
  return Math.max(1, Number(row.content_part_count ?? 0));
}

function revisionContentPartCount(row: Pick<KnowledgeRevisionRow, "content_part_count">): number {
  return Math.max(1, Number(row.content_part_count ?? 0));
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

function normalizedStorageParts(submission: KnowledgeSubmission, contentParts?: readonly KnowledgeContentPartInput[]): string[] {
  if (!contentParts?.length) {
    if (submission.content.length > MAX_KNOWLEDGE_CONTENT_LENGTH) {
      throw new Error("large knowledge content requires storage parts");
    }
    return [];
  }
  const parts = contentParts.map((part) => typeof part === "string" ? part : part.content);
  if (parts.some((part) => !part || part.length > MAX_KNOWLEDGE_CONTENT_LENGTH || !isWellFormedUnicode(part))) {
    throw new Error("invalid knowledge storage parts");
  }
  if (parts.join("") !== submission.content) throw new Error("knowledge storage parts do not reconstruct content");
  return submission.content.length > MAX_KNOWLEDGE_CONTENT_LENGTH ? parts : [];
}

function jsonBulkPayloads(rows: Record<string, unknown>[]): string[] {
  const encoder = new TextEncoder();
  const payloads: string[] = [];
  let encodedRows: string[] = [];
  let byteLength = 2;
  const flush = () => {
    if (!encodedRows.length) return;
    payloads.push(`[${encodedRows.join(",")}]`);
    encodedRows = [];
    byteLength = 2;
  };
  for (const row of rows) {
    const encoded = JSON.stringify(row);
    const encodedBytes = encoder.encode(encoded).byteLength;
    if (encodedBytes + 2 > JSON_BULK_MAX_BYTES) throw new Error("knowledge bulk row is too large");
    if (encodedRows.length >= JSON_BULK_MAX_ROWS || byteLength + encodedBytes + (encodedRows.length ? 1 : 0) > JSON_BULK_MAX_BYTES) flush();
    encodedRows.push(encoded);
    byteLength += encodedBytes + (encodedRows.length > 1 ? 1 : 0);
  }
  flush();
  return payloads;
}

function knowledgePartInsertStatements(
  database: D1Database,
  itemId: string,
  revisionId: string,
  mutationRevision: string,
  now: string,
  parts: readonly string[],
): D1PreparedStatement[] {
  const rows = parts.map((content, index) => ({ id: crypto.randomUUID(), partNo: index + 1, content }));
  return jsonBulkPayloads(rows).map((payload) => database.prepare(`
    INSERT INTO knowledge_revision_parts (id, item_id, revision_id, part_no, content, created_at)
    SELECT
      json_extract(part.value, '$.id'), ?, ?, CAST(json_extract(part.value, '$.partNo') AS INTEGER),
      json_extract(part.value, '$.content'), ?
    FROM json_each(?) AS part
    WHERE EXISTS (
      SELECT 1 FROM knowledge_items
      WHERE id = ? AND current_revision_id = ? AND mutation_revision = ? AND status = 'pending'
    )
  `).bind(itemId, revisionId, now, payload, itemId, revisionId, mutationRevision));
}

function knowledgeChunkInsertStatements(
  database: D1Database,
  itemId: string,
  revisionId: string,
  mutationRevision: string,
  now: string,
  chunks: ReturnType<typeof chunkKnowledgeSubmission>,
): D1PreparedStatement[] {
  const rows = chunks.map((chunk) => ({
    id: crypto.randomUUID(),
    chunkNo: chunk.chunkNo,
    sectionTitle: chunk.sectionTitle,
    paragraphRef: chunk.paragraphRef,
    content: chunk.content,
    searchText: chunk.searchText,
  }));
  return jsonBulkPayloads(rows).map((payload) => database.prepare(`
    INSERT INTO knowledge_chunks (
      id, item_id, revision_id, chunk_no, section_title, paragraph_ref, content, search_text, is_active, created_at
    )
    SELECT
      json_extract(chunk.value, '$.id'), ?, ?, CAST(json_extract(chunk.value, '$.chunkNo') AS INTEGER),
      json_extract(chunk.value, '$.sectionTitle'), json_extract(chunk.value, '$.paragraphRef'),
      json_extract(chunk.value, '$.content'), json_extract(chunk.value, '$.searchText'), 1, ?
    FROM json_each(?) AS chunk
    WHERE EXISTS (
      SELECT 1 FROM knowledge_items
      WHERE id = ? AND active_revision_id = ? AND mutation_revision = ? AND status = 'active'
    )
  `).bind(itemId, revisionId, now, payload, itemId, revisionId, mutationRevision));
}

function reassembleRevisionContent<T extends { content: string | null; content_part_count: number | string | null }>(
  row: T,
  parts: readonly KnowledgeRevisionPartRow[],
): T {
  const expectedCount = Number(row.content_part_count ?? 0);
  if (!expectedCount) return row;
  if (row.content) throw new Error("knowledge revision has conflicting inline and multipart content");
  if (parts.length !== expectedCount || parts.some((part, index) => Number(part.part_no) !== index + 1)) {
    throw new Error("knowledge revision parts are incomplete");
  }
  return { ...row, content: parts.map((part) => part.content).join("") };
}

async function assertMultipartContentHash(row: KnowledgeRevisionRow | KnowledgeItemWithRevisionRow): Promise<void> {
  if (!Number(row.content_part_count ?? 0) || !row.content || !row.content_hash) return;
  const actual = await hashKnowledgeSubmission({
    title: row.title,
    category: row.category,
    summary: row.summary || "",
    sourceLabel: row.source_label || "",
    sourceUrl: row.source_url || "",
    content: row.content,
  });
  if (actual !== row.content_hash) throw new Error("knowledge revision parts do not match content hash");
}

async function hydrateCurrentRevisionContent(
  database: D1Database,
  row: KnowledgeItemWithRevisionRow,
): Promise<KnowledgeItemWithRevisionRow> {
  const storedPartCount = Number(row.content_part_count ?? 0);
  if (!row.current_revision_id || !storedPartCount) return row;
  const result = await database.prepare(`
    SELECT revision_id, part_no, content
    FROM knowledge_revision_parts
    WHERE item_id = ? AND revision_id = ?
    ORDER BY part_no ASC
  `).bind(row.id, row.current_revision_id).all<KnowledgeRevisionPartRow>();
  const hydrated = reassembleRevisionContent(row, result.results);
  await assertMultipartContentHash(hydrated);
  return hydrated;
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
    visibility: row.visibility,
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
      contentPartCount: contentPartCount(revision),
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
    contentPartCount: revisionContentPartCount(row),
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
    visibility: row.visibility,
    currentRevisionNo: Number(row.current_revision_no),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    summary: row.summary || "",
    sourceLabel: row.source_label || "",
    sourceUrl: row.source_url || "",
    contentPartCount: contentPartCount(row),
  };
}

function itemCapabilities(row: KnowledgeItemRow, actor: KnowledgeActor, canReview: boolean) {
  const identity = submitterIdentity(row, actor);
  const canAdminManageOwn = actor.isAdmin && identity.exact;
  const canApprove = canReview && (!identity.overlaps || canAdminManageOwn);
  const canModerate = canReview && !identity.overlaps;
  return {
    canReview: canApprove && row.status === "pending",
    canReturn: canModerate && row.status === "pending",
    canReject: canModerate && row.status === "pending",
    canRevoke: canModerate && row.status === "active",
    canSetVisibility: canApprove && row.status === "active",
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
    (SELECT COUNT(*) FROM knowledge_revision_parts AS rp WHERE rp.revision_id = r.id AND rp.item_id = i.id) AS content_part_count,
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
    (SELECT COUNT(*) FROM knowledge_revision_parts AS rp WHERE rp.revision_id = r.id AND rp.item_id = i.id) AS content_part_count,
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

export async function listKnowledgeItems(scope: KnowledgeListScope, actor: KnowledgeActor, canReview: boolean, options?: KnowledgeListOptions) {
  const database = await getD1Database();
  const guard = actorGuard(actor, canReview);
  let statement: D1PreparedStatement;
  let titleSort: KnowledgeListSort | undefined;
  if (scope === "mine") {
    statement = database.prepare(`${LIST_ITEM_WITH_REVISION_SELECT}
      WHERE i.submitter_member_id = ? AND lower(i.submitter_email) = ? AND ${guard.sql}
      ORDER BY i.updated_at DESC, i.id DESC LIMIT ?
    `).bind(actor.memberId, normalizeEmail(actor.email), ...guard.values, KNOWLEDGE_LIST_LIMIT);
  } else if (scope === "review") {
    if (!canReview) return [];
    statement = database.prepare(`${LIST_ITEM_WITH_REVISION_SELECT}
      WHERE i.status = 'pending'
        AND (
          (i.submitter_member_id <> ? AND lower(i.submitter_email) <> ?)
          OR (? = 1 AND i.submitter_member_id = ? AND lower(i.submitter_email) = ?)
        )
        AND ${guard.sql}
      ORDER BY i.created_at ASC, i.id ASC LIMIT ?
    `).bind(actor.memberId, normalizeEmail(actor.email), actor.isAdmin ? 1 : 0,
      actor.memberId, normalizeEmail(actor.email), ...guard.values, KNOWLEDGE_LIST_LIMIT);
  } else if (canReview) {
    const normalizedOptions = normalizeKnowledgeListOptions(options);
    const search = knowledgeListSearchFilter(normalizedOptions.query);
    titleSort = normalizedOptions.sort === "title_asc" || normalizedOptions.sort === "title_desc" ? normalizedOptions.sort : undefined;
    const orderAndLimit = titleSort
      ? ""
      : normalizedOptions.sort === "updated_asc"
        ? "ORDER BY i.updated_at ASC, i.id ASC LIMIT ?"
        : normalizedOptions.sort === "updated_desc"
          ? "ORDER BY i.updated_at DESC, i.id DESC LIMIT ?"
          : "ORDER BY CASE i.status WHEN 'pending' THEN 0 ELSE 1 END, i.updated_at DESC, i.id DESC LIMIT ?";
    statement = database.prepare(`${LIST_ITEM_WITH_REVISION_SELECT}
      WHERE ${guard.sql}
        ${search.sql}
      ${orderAndLimit}
    `).bind(...guard.values, ...search.values, ...(titleSort ? [] : [KNOWLEDGE_LIST_LIMIT]));
  } else {
    statement = database.prepare(`${LIST_ITEM_WITH_REVISION_SELECT}
      WHERE (i.status = 'active' OR (i.submitter_member_id = ? AND lower(i.submitter_email) = ?))
        AND ${guard.sql}
      ORDER BY i.updated_at DESC, i.id DESC LIMIT ?
    `).bind(actor.memberId, normalizeEmail(actor.email), ...guard.values, KNOWLEDGE_LIST_LIMIT);
  }
  const result = await statement.all<KnowledgeItemListRow>();
  const appliedTitleSort = titleSort;
  const rows = appliedTitleSort
    ? [...result.results].sort((left, right) => compareKnowledgeTitles(left, right, appliedTitleSort)).slice(0, KNOWLEDGE_LIST_LIMIT)
    : result.results;
  return rows.map((row) => {
    const isOwner = row.submitter_member_id === actor.memberId && normalizeEmail(row.submitter_email) === normalizeEmail(actor.email);
    const item = canReview || isOwner ? serializeItem(row) : serializePublicItem(row);
    return { ...item, ...itemCapabilities(row, actor, canReview) };
  });
}

export async function countPendingKnowledgeItems(actor: KnowledgeActor): Promise<number> {
  const database = await getD1Database();
  const guard = actorGuard(actor, true);
  const row = await database.prepare(`SELECT COUNT(*) AS total FROM knowledge_items
    WHERE status = 'pending'
      AND (
        (submitter_member_id <> ? AND lower(submitter_email) <> ?)
        OR (? = 1 AND submitter_member_id = ? AND lower(submitter_email) = ?)
      )
      AND ${guard.sql}`)
    .bind(actor.memberId, normalizeEmail(actor.email), actor.isAdmin ? 1 : 0,
      actor.memberId, normalizeEmail(actor.email), ...guard.values).first<{ total: number | string }>();
  return Number(row?.total ?? 0);
}

export async function findKnowledgeItem(id: string, actor: KnowledgeActor, requireReviewer = false): Promise<KnowledgeItemWithRevisionRow | null> {
  const database = await getD1Database();
  const guard = actorGuard(actor, requireReviewer);
  const item = await database.prepare(`${ITEM_WITH_REVISION_SELECT} WHERE i.id = ? AND ${guard.sql} LIMIT 1`)
    .bind(id, ...guard.values).first<KnowledgeItemWithRevisionRow>();
  return item ? hydrateCurrentRevisionContent(database, item) : null;
}

export async function knowledgeRevisionHashExists(itemId: string, contentHash: string): Promise<boolean> {
  const database = await getD1Database();
  return Boolean(await database.prepare("SELECT 1 AS present FROM knowledge_revisions WHERE item_id = ? AND content_hash = ? LIMIT 1").bind(itemId, contentHash).first());
}

export async function getKnowledgeItemDetail(id: string, actor: KnowledgeActor, canReview: boolean) {
  const database = await getD1Database();
  const guard = actorGuard(actor, canReview);
  const storedItem = await database.prepare(`${ITEM_WITH_REVISION_SELECT} WHERE i.id = ? AND ${guard.sql} LIMIT 1`)
    .bind(id, ...guard.values).first<KnowledgeItemWithRevisionRow>();
  if (!storedItem) return null;
  const item = await hydrateCurrentRevisionContent(database, storedItem);
  const isOwner = submitterIdentity(item, actor).exact;
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
      contentPartCount: contentPartCount(item),
      status: item.revision_status,
      createdAt: item.updated_at,
    }], events: [] };
  }

  const [revisionsResult, partsResult, eventsResult] = await database.batch([
    database.prepare(`
      SELECT r.*,
        (SELECT COUNT(*) FROM knowledge_revision_parts AS rp WHERE rp.revision_id = r.id AND rp.item_id = r.item_id) AS content_part_count
      FROM knowledge_revisions AS r
      WHERE r.item_id = ?
      ORDER BY r.revision_no DESC, r.id DESC
    `).bind(id),
    database.prepare(`
      SELECT revision_id, part_no, content
      FROM knowledge_revision_parts
      WHERE item_id = ?
      ORDER BY revision_id ASC, part_no ASC
    `).bind(id),
    database.prepare("SELECT * FROM knowledge_events WHERE item_id = ? ORDER BY created_at ASC, id ASC").bind(id),
  ]);
  const partsByRevision = new Map<string, KnowledgeRevisionPartRow[]>();
  for (const part of resultRows(partsResult as D1Result<KnowledgeRevisionPartRow>)) {
    const parts = partsByRevision.get(part.revision_id) || [];
    parts.push(part);
    partsByRevision.set(part.revision_id, parts);
  }
  const revisions = await Promise.all(resultRows(revisionsResult as D1Result<KnowledgeRevisionRow>).map(async (revision) => {
    const hydrated = reassembleRevisionContent(revision, partsByRevision.get(revision.id) || []);
    await assertMultipartContentHash(hydrated);
    return serializeRevision(hydrated);
  }));
  return {
    item: { ...serializeItem(item), ...itemCapabilities(item, actor, canReview) },
    revisions,
    events: resultRows(eventsResult as D1Result<KnowledgeEventRow>).map(serializeEvent),
  };
}

export async function createKnowledgeItem(
  actor: KnowledgeActor,
  submission: KnowledgeSubmission,
  contentHash: string,
  itemId = crypto.randomUUID(),
  contentParts?: readonly KnowledgeContentPartInput[],
) {
  const storageParts = normalizedStorageParts(submission, contentParts);
  const database = await getD1Database();
  const now = new Date().toISOString();
  const revisionId = crypto.randomUUID();
  const mutationRevision = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const guard = actorGuard(actor);
  const statements: D1PreparedStatement[] = [
    database.prepare(`
      INSERT INTO knowledge_items (
        id, project, title, category, submitter_member_id, submitter_name, submitter_email,
        status, visibility, current_revision_no, current_revision_id, active_revision_id, mutation_revision,
        created_at, updated_at, revoked_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', 'internal', 1, ?, NULL, ?, ?, ?, NULL
      WHERE ${guard.sql}
      ON CONFLICT(id) DO NOTHING
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
    `).bind(revisionId, itemId, submission.title, submission.category, storageParts.length ? "" : submission.content, submission.summary,
      submission.sourceLabel, submission.sourceUrl, contentHash, actor.memberId, actor.name, normalizeEmail(actor.email), now,
      itemId, revisionId, mutationRevision),
  ];
  statements.push(...knowledgePartInsertStatements(database, itemId, revisionId, mutationRevision, now, storageParts));
  statements.push(
    database.prepare(`
      INSERT INTO knowledge_events (id, item_id, revision_id, actor_member_id, actor_name, actor_email, action, note, created_at)
      SELECT ?, ?, ?, ?, ?, ?, 'submitted', '', ?
      WHERE EXISTS (SELECT 1 FROM knowledge_items WHERE id = ? AND current_revision_id = ? AND mutation_revision = ? AND status = 'pending')
    `).bind(eventId, itemId, revisionId, actor.memberId, actor.name, normalizeEmail(actor.email), now,
      itemId, revisionId, mutationRevision),
  );
  const [itemResult] = await database.batch(statements);
  const created = resultRows(itemResult as D1Result<KnowledgeItemRow>)[0];
  return created ? serializeItem({
    ...created,
    summary: submission.summary,
    source_label: submission.sourceLabel,
    source_url: submission.sourceUrl,
    content: submission.content,
    content_hash: contentHash,
    content_part_count: storageParts.length,
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

export async function createChatImportedKnowledgeItem(
  actor: KnowledgeActor,
  submission: KnowledgeSubmission,
  contentHash: string,
  itemId: string,
  contentParts?: readonly KnowledgeContentPartInput[],
) {
  const created = await createKnowledgeItem(actor, submission, contentHash, itemId, contentParts);
  if (created) return created;
  // The deterministic ID makes retries and concurrent submissions idempotent.
  // Re-reading uses the live member/NDA guard and exact submitter identity.
  const existing = await findKnowledgeItem(itemId, actor);
  if (!existing || existing.submitter_member_id !== actor.memberId
    || normalizeEmail(existing.submitter_email) !== normalizeEmail(actor.email)
    || existing.content_hash !== contentHash) return null;
  return serializeItem(existing);
}

export async function resubmitKnowledgeItem(
  existing: KnowledgeItemWithRevisionRow,
  actor: KnowledgeActor,
  submission: KnowledgeSubmission,
  contentHash: string,
  contentParts?: readonly KnowledgeContentPartInput[],
) {
  const storageParts = normalizedStorageParts(submission, contentParts);
  const database = await getD1Database();
  const now = timestampAfter(existing.updated_at);
  const revisionId = crypto.randomUUID();
  const mutationRevision = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const revisionNo = Number(existing.current_revision_no) + 1;
  const guard = actorGuard(actor);
  const statements: D1PreparedStatement[] = [
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
      storageParts.length ? "" : submission.content, submission.summary, submission.sourceLabel, submission.sourceUrl, contentHash,
      actor.memberId, actor.name, normalizeEmail(actor.email), now, existing.id, revisionId, mutationRevision),
  ];
  statements.push(...knowledgePartInsertStatements(database, existing.id, revisionId, mutationRevision, now, storageParts));
  statements.push(
    database.prepare(`
      INSERT INTO knowledge_events (id, item_id, revision_id, actor_member_id, actor_name, actor_email, action, note, created_at)
      SELECT ?, ?, ?, ?, ?, ?, 'resubmitted', '', ?
      WHERE EXISTS (SELECT 1 FROM knowledge_items WHERE id = ? AND current_revision_id = ? AND mutation_revision = ? AND status = 'pending')
    `).bind(eventId, existing.id, revisionId, actor.memberId, actor.name, normalizeEmail(actor.email), now,
      existing.id, revisionId, mutationRevision),
  );
  const [itemResult] = await database.batch(statements);
  const updated = resultRows(itemResult as D1Result<KnowledgeItemRow>)[0];
  return updated ? serializeItem({
    ...updated,
    summary: submission.summary,
    source_label: submission.sourceLabel,
    source_url: submission.sourceUrl,
    content: submission.content,
    content_hash: contentHash,
    content_part_count: storageParts.length,
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
  visibility?: KnowledgeVisibility,
  publicConfirmation?: unknown,
) {
  if (action === "approve") {
    if (visibility !== "internal" && visibility !== "public") return null;
    if (visibility === "public" && !isPublicKnowledgeConfirmation(publicConfirmation)) return null;
    if (visibility === "internal" && publicConfirmation !== undefined) return null;
  } else if (visibility !== undefined || publicConfirmation !== undefined) {
    return null;
  }
  const database = await getD1Database();
  const now = timestampAfter(existing.updated_at);
  const mutationRevision = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const identity = submitterIdentity(existing, actor);
  const adminSelfApproval = action === "approve" && actor.isAdmin && identity.exact;
  const eventNote = adminSelfApproval ? knowledgeAdminSelfAuditNote(note) : note;
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
  }, existing.content && existing.content.length > MAX_KNOWLEDGE_CONTENT_LENGTH ? 2_000 : 900) : [];
  if (chunks.length > MAX_KNOWLEDGE_CHUNKS) throw new Error("knowledge chunk limit exceeded");
  const statements: D1PreparedStatement[] = [
    database.prepare(`
      UPDATE knowledge_items SET
        status = ?, visibility = ?, active_revision_id = ?, mutation_revision = ?, updated_at = ?, revoked_at = ?
      WHERE id = ? AND status = ? AND current_revision_id = ? AND mutation_revision = ?
        AND (? = 1 OR (submitter_member_id <> ? AND lower(submitter_email) <> ?))
        AND ${guard.sql}
      RETURNING *
    `).bind(nextStatus, action === "approve" ? visibility : existing.visibility,
      action === "approve" ? existing.current_revision_id : null, mutationRevision, now,
      action === "revoke" ? now : null, existing.id, expectedStatus, existing.current_revision_id,
      existing.mutation_revision, adminSelfApproval ? 1 : 0, actor.memberId, normalizeEmail(actor.email), ...guard.values),
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
    statements.push(...knowledgeChunkInsertStatements(
      database,
      existing.id,
      existing.current_revision_id || "",
      mutationRevision,
      now,
      chunks,
    ));
  }
  statements.push(database.prepare(`
    INSERT INTO knowledge_events (id, item_id, revision_id, actor_member_id, actor_name, actor_email, action, note, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM knowledge_items WHERE id = ? AND current_revision_id = ? AND mutation_revision = ? AND status = ?)
  `).bind(eventId, existing.id, existing.current_revision_id, actor.memberId, actor.name, normalizeEmail(actor.email),
    action === "approve" ? visibility === "public" ? "approved_public" : "approved_internal"
      : action === "return" ? "returned" : action === "reject" ? "rejected" : "revoked",
    eventNote, now, existing.id, existing.current_revision_id, mutationRevision, nextStatus));

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
    content_part_count: existing.content_part_count,
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

export async function setKnowledgeItemVisibility(
  existing: KnowledgeItemWithRevisionRow,
  actor: KnowledgeActor,
  visibility: KnowledgeVisibility,
  publicConfirmation?: unknown,
) {
  if (existing.status !== "active" || !existing.current_revision_id || existing.active_revision_id !== existing.current_revision_id) return null;
  if (visibility !== "internal" && visibility !== "public") return null;
  if (visibility === existing.visibility) return null;
  if (visibility === "public" && !isPublicKnowledgeConfirmation(publicConfirmation)) return null;
  if (visibility === "internal" && publicConfirmation !== undefined) return null;

  const database = await getD1Database();
  const now = timestampAfter(existing.updated_at);
  const mutationRevision = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const identity = submitterIdentity(existing, actor);
  const adminSelfManagement = actor.isAdmin && identity.exact;
  const eventNote = adminSelfManagement ? knowledgeAdminSelfAuditNote("") : "";
  const guard = actorGuard(actor, true);
  const [itemResult] = await database.batch([
    database.prepare(`
      UPDATE knowledge_items SET
        visibility = ?, mutation_revision = ?, updated_at = ?
      WHERE id = ? AND status = 'active' AND visibility = ?
        AND current_revision_id = ? AND active_revision_id = current_revision_id
        AND mutation_revision = ?
        AND (? = 1 OR (submitter_member_id <> ? AND lower(submitter_email) <> ?))
        AND ${guard.sql}
      RETURNING *
    `).bind(visibility, mutationRevision, now, existing.id, existing.visibility,
      existing.current_revision_id, existing.mutation_revision, adminSelfManagement ? 1 : 0,
      actor.memberId, normalizeEmail(actor.email), ...guard.values),
    database.prepare(`
      INSERT INTO knowledge_events (id, item_id, revision_id, actor_member_id, actor_name, actor_email, action, note, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM knowledge_items
        WHERE id = ? AND status = 'active' AND visibility = ?
          AND current_revision_id = ? AND active_revision_id = current_revision_id
          AND mutation_revision = ? AND updated_at = ?
      )
    `).bind(eventId, existing.id, existing.current_revision_id, actor.memberId, actor.name, normalizeEmail(actor.email),
      visibility === "public" ? "visibility_changed_public" : "visibility_changed_internal", eventNote, now,
      existing.id, visibility, existing.current_revision_id, mutationRevision, now),
  ]);
  const updated = resultRows(itemResult as D1Result<KnowledgeItemRow>)[0];
  if (!updated) return null;
  return serializeItem({
    ...updated,
    summary: existing.summary,
    source_label: existing.source_label,
    source_url: existing.source_url,
    content: existing.content,
    content_hash: existing.content_hash,
    content_part_count: existing.content_part_count,
    revision_status: existing.revision_status,
    reviewed_by_member_id: existing.reviewed_by_member_id,
    reviewed_by_name: existing.reviewed_by_name,
    reviewed_by_email: existing.reviewed_by_email,
    review_note: existing.review_note,
    reviewed_at: existing.reviewed_at,
    activated_at: existing.activated_at,
    retired_at: existing.retired_at,
  });
}

export async function getActiveKnowledgeChunks(actor: KnowledgeActor, question?: string): Promise<SearchableKnowledgeChunk[]> {
  const terms = question === undefined ? undefined : sqlKnowledgeSearchTerms(question);
  if (terms && !terms.length) return [];
  const database = await getD1Database();
  const guard = actorGuard(actor);
  const result = terms ? await database.prepare(`
    WITH search_terms(term_no, term, quota) AS (
      VALUES ${searchTermRowsSql(terms.length)}
    ), item_term_candidates AS (
      SELECT
        c.id, c.item_id, c.revision_id, c.chunk_no,
        i.updated_at, search_terms.term_no, search_terms.term, search_terms.quota,
        COUNT(*) OVER (PARTITION BY search_terms.term_no) AS term_frequency,
        ROW_NUMBER() OVER (
          PARTITION BY search_terms.term_no, c.item_id
          ORDER BY c.chunk_no ASC
        ) AS item_term_rank
      FROM knowledge_chunks AS c
      INNER JOIN knowledge_items AS i ON i.id = c.item_id
      INNER JOIN knowledge_revisions AS r ON r.id = c.revision_id AND r.item_id = i.id
      INNER JOIN search_terms ON instr(c.search_text, search_terms.term) > 0
      WHERE c.is_active = 1
        AND i.status = 'active'
        AND i.visibility IN ('internal', 'public')
        AND r.status = 'active'
        AND i.active_revision_id = c.revision_id
        AND ${guard.sql}
    ), term_candidates AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY term_no
        ORDER BY item_term_rank ASC, updated_at DESC, item_id ASC, chunk_no ASC
      ) AS term_rank
      FROM item_term_candidates
    ), scored_candidates AS (
      SELECT *,
        MAX(CASE WHEN term_rank <= quota THEN 1 ELSE 0 END) OVER (PARTITION BY id) AS quota_selected,
        MIN(term_frequency) OVER (PARTITION BY id) AS rarest_term_frequency,
        MAX(length(term)) OVER (PARTITION BY id) AS best_term_length,
        ROW_NUMBER() OVER (PARTITION BY id ORDER BY term_no ASC) AS duplicate_rank
      FROM term_candidates
    ), unique_candidates AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY item_id
        ORDER BY quota_selected DESC, rarest_term_frequency ASC, best_term_length DESC, chunk_no ASC
      ) AS item_candidate_rank
      FROM scored_candidates
      WHERE duplicate_rank = 1
    ), limited_candidates AS (
      SELECT
        id, item_id, revision_id, chunk_no, updated_at,
        quota_selected, rarest_term_frequency, best_term_length, item_candidate_rank
      FROM unique_candidates
      ORDER BY
        quota_selected DESC, rarest_term_frequency ASC, best_term_length DESC,
        item_candidate_rank ASC, updated_at DESC, item_id ASC, chunk_no ASC
      LIMIT ?
    )
    SELECT
      c.id, c.item_id, c.revision_id, r.title, r.category, r.source_label, r.source_url,
      c.section_title, c.paragraph_ref, c.content, c.search_text, limited.updated_at
    FROM limited_candidates AS limited
    INNER JOIN knowledge_chunks AS c
      ON c.id = limited.id AND c.item_id = limited.item_id AND c.revision_id = limited.revision_id
    INNER JOIN knowledge_revisions AS r ON r.id = c.revision_id AND r.item_id = c.item_id
    ORDER BY
      limited.quota_selected DESC, limited.rarest_term_frequency ASC, limited.best_term_length DESC,
      limited.item_candidate_rank ASC, limited.updated_at DESC, limited.item_id ASC, limited.chunk_no ASC
  `).bind(...terms, ...guard.values, KNOWLEDGE_SEARCH_CANDIDATE_LIMIT).all<{
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
  }>() : await database.prepare(`
    SELECT
      c.id, c.item_id, c.revision_id, r.title, r.category, r.source_label, r.source_url, c.section_title, c.paragraph_ref,
      c.content, c.search_text, i.updated_at
    FROM knowledge_chunks AS c
    INNER JOIN knowledge_items AS i ON i.id = c.item_id
    INNER JOIN knowledge_revisions AS r ON r.id = c.revision_id AND r.item_id = i.id
    WHERE c.is_active = 1
      AND i.status = 'active'
      AND i.visibility IN ('internal', 'public')
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

export async function getPublicActiveKnowledgeChunks(question?: string): Promise<SearchableKnowledgeChunk[]> {
  const terms = question === undefined ? undefined : sqlKnowledgeSearchTerms(question);
  if (terms && !terms.length) return [];
  const database = await getD1Database();
  const result = terms ? await database.prepare(`
    WITH search_terms(term_no, term, quota) AS (
      VALUES ${searchTermRowsSql(terms.length)}
    ), item_term_candidates AS (
      SELECT
        c.id, c.item_id, c.revision_id, c.chunk_no,
        i.updated_at, search_terms.term_no, search_terms.term, search_terms.quota,
        COUNT(*) OVER (PARTITION BY search_terms.term_no) AS term_frequency,
        ROW_NUMBER() OVER (
          PARTITION BY search_terms.term_no, c.item_id
          ORDER BY c.chunk_no ASC
        ) AS item_term_rank
      FROM knowledge_chunks AS c
      INNER JOIN knowledge_items AS i ON i.id = c.item_id
      INNER JOIN knowledge_revisions AS r ON r.id = c.revision_id AND r.item_id = i.id
      INNER JOIN search_terms ON instr(c.search_text, search_terms.term) > 0
      WHERE c.is_active = 1
        AND i.status = 'active'
        AND i.visibility = 'public'
        AND r.status = 'active'
        AND i.active_revision_id = c.revision_id
    ), term_candidates AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY term_no
        ORDER BY item_term_rank ASC, updated_at DESC, item_id ASC, chunk_no ASC
      ) AS term_rank
      FROM item_term_candidates
    ), scored_candidates AS (
      SELECT *,
        MAX(CASE WHEN term_rank <= quota THEN 1 ELSE 0 END) OVER (PARTITION BY id) AS quota_selected,
        MIN(term_frequency) OVER (PARTITION BY id) AS rarest_term_frequency,
        MAX(length(term)) OVER (PARTITION BY id) AS best_term_length,
        ROW_NUMBER() OVER (PARTITION BY id ORDER BY term_no ASC) AS duplicate_rank
      FROM term_candidates
    ), unique_candidates AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY item_id
        ORDER BY quota_selected DESC, rarest_term_frequency ASC, best_term_length DESC, chunk_no ASC
      ) AS item_candidate_rank
      FROM scored_candidates
      WHERE duplicate_rank = 1
    ), limited_candidates AS (
      SELECT
        id, item_id, revision_id, chunk_no, updated_at,
        quota_selected, rarest_term_frequency, best_term_length, item_candidate_rank
      FROM unique_candidates
      ORDER BY
        quota_selected DESC, rarest_term_frequency ASC, best_term_length DESC,
        item_candidate_rank ASC, updated_at DESC, item_id ASC, chunk_no ASC
      LIMIT ?
    )
    SELECT
      ROW_NUMBER() OVER (ORDER BY limited.updated_at DESC, limited.item_id ASC, limited.chunk_no ASC) AS public_chunk_no,
      DENSE_RANK() OVER (ORDER BY limited.item_id ASC) AS public_item_no,
      c.item_id AS asset_item_id, c.revision_id AS asset_revision_id,
      r.title, r.category, r.source_label, c.section_title, c.paragraph_ref,
      c.content, c.search_text, limited.updated_at
    FROM limited_candidates AS limited
    INNER JOIN knowledge_chunks AS c
      ON c.id = limited.id AND c.item_id = limited.item_id AND c.revision_id = limited.revision_id
    INNER JOIN knowledge_revisions AS r ON r.id = c.revision_id AND r.item_id = c.item_id
    ORDER BY
      limited.quota_selected DESC, limited.rarest_term_frequency ASC, limited.best_term_length DESC,
      limited.item_candidate_rank ASC, limited.updated_at DESC, limited.item_id ASC, limited.chunk_no ASC
  `).bind(...terms, KNOWLEDGE_SEARCH_CANDIDATE_LIMIT).all<{
    public_chunk_no: number;
    public_item_no: number;
    asset_item_id: string;
    asset_revision_id: string;
    title: string;
    category: string;
    source_label: string;
    section_title: string;
    paragraph_ref: string;
    content: string;
    search_text: string;
    updated_at: string;
  }>() : await database.prepare(`
    WITH limited_candidates AS (
      SELECT c.id, c.item_id, c.revision_id, c.chunk_no, i.updated_at
      FROM knowledge_chunks AS c
      INNER JOIN knowledge_items AS i ON i.id = c.item_id
      INNER JOIN knowledge_revisions AS r ON r.id = c.revision_id AND r.item_id = i.id
      WHERE c.is_active = 1
        AND i.status = 'active'
        AND i.visibility = 'public'
        AND r.status = 'active'
        AND i.active_revision_id = c.revision_id
      ORDER BY i.updated_at DESC, c.item_id ASC, c.chunk_no ASC
      LIMIT ?
    )
    SELECT
      ROW_NUMBER() OVER (ORDER BY limited.updated_at DESC, limited.item_id ASC, limited.chunk_no ASC) AS public_chunk_no,
      DENSE_RANK() OVER (ORDER BY limited.item_id ASC) AS public_item_no,
      c.item_id AS asset_item_id, c.revision_id AS asset_revision_id,
      r.title, r.category, r.source_label, c.section_title, c.paragraph_ref,
      c.content, c.search_text, limited.updated_at
    FROM limited_candidates AS limited
    INNER JOIN knowledge_chunks AS c
      ON c.id = limited.id AND c.item_id = limited.item_id AND c.revision_id = limited.revision_id
    INNER JOIN knowledge_revisions AS r ON r.id = c.revision_id AND r.item_id = c.item_id
    ORDER BY limited.updated_at DESC, limited.item_id ASC, limited.chunk_no ASC
  `).bind(KNOWLEDGE_SEARCH_CANDIDATE_LIMIT).all<{
    public_chunk_no: number;
    public_item_no: number;
    asset_item_id: string;
    asset_revision_id: string;
    title: string;
    category: string;
    source_label: string;
    section_title: string;
    paragraph_ref: string;
    content: string;
    search_text: string;
    updated_at: string;
  }>();
  return result.results.map((row) => ({
    id: `public-chunk-${row.public_chunk_no}`,
    itemId: `public-item-${row.public_item_no}`,
    revisionId: `public-revision-${row.public_item_no}`,
    title: row.title,
    category: row.category,
    sourceLabel: row.source_label,
    sourceUrl: "",
    assetScope: { itemId: row.asset_item_id, revisionId: row.asset_revision_id },
    sectionTitle: row.section_title,
    paragraphRef: row.paragraph_ref,
    content: row.content,
    searchText: row.search_text,
    updatedAt: row.updated_at,
  }));
}

export async function getLatestPublicKnowledgeSuggestionCandidates(
  limit = 12,
): Promise<PublicKnowledgeSuggestionCandidate[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    throw new RangeError("invalid public knowledge suggestion candidate limit");
  }
  const database = await getD1Database();
  const result = await database.prepare(`
    SELECT r.title, representative.section_title, i.updated_at
    FROM knowledge_items AS i
    INNER JOIN knowledge_revisions AS r
      ON r.id = i.active_revision_id AND r.item_id = i.id
    INNER JOIN knowledge_chunks AS representative
      ON representative.item_id = i.id
      AND representative.revision_id = i.active_revision_id
      AND representative.is_active = 1
      AND representative.id = (
        SELECT c.id
        FROM knowledge_chunks AS c
        WHERE c.item_id = i.id
          AND c.revision_id = i.active_revision_id
          AND c.is_active = 1
        ORDER BY
          CASE WHEN trim(c.section_title) = '' THEN 1 ELSE 0 END ASC,
          c.chunk_no ASC,
          c.id ASC
        LIMIT 1
      )
    WHERE i.status = 'active'
      AND i.visibility = 'public'
      AND r.status = 'active'
    ORDER BY i.updated_at DESC, i.id ASC
    LIMIT ?
  `).bind(limit).all<{
    title: string;
    section_title: string;
    updated_at: string;
  }>();
  return result.results.map((row) => ({
    title: row.title,
    sectionTitle: row.section_title,
    updatedAt: row.updated_at,
  }));
}

export async function hasPublicActiveKnowledge(): Promise<boolean> {
  const database = await getD1Database();
  const row = await database.prepare(`
    SELECT EXISTS (
      SELECT 1
      FROM knowledge_chunks AS c
      INNER JOIN knowledge_items AS i ON i.id = c.item_id
      INNER JOIN knowledge_revisions AS r ON r.id = c.revision_id AND r.item_id = i.id
      WHERE c.is_active = 1
        AND i.status = 'active'
        AND i.visibility = 'public'
        AND r.status = 'active'
        AND i.active_revision_id = c.revision_id
      LIMIT 1
    ) AS ready
  `).first<{ ready: number | string }>();
  return Number(row?.ready ?? 0) === 1;
}

import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    project: text("project").notNull(),
    requesterName: text("requester_name").notNull(),
    requesterEmail: text("requester_email").notNull(),
    clientCreationKey: text("client_creation_key"),
    businessKey: text("business_key"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    status: text("status").notNull(),
    currentStep: text("current_step").notNull(),
    currentReviewerName: text("current_reviewer_name").notNull().default(""),
    currentReviewerEmail: text("current_reviewer_email").notNull().default(""),
    summary: text("summary").notNull().default(""),
    owner: text("owner").notNull(),
    amount: text("amount"),
    periodKey: text("period_key"),
    signersJson: text("signers_json").notNull().default("[]"),
    payloadJson: text("payload_json").notNull().default("{}"),
    currentRevisionNo: integer("current_revision_no").notNull().default(0),
    currentRevisionHash: text("current_revision_hash"),
  },
  (table) => [
    uniqueIndex("approvals_period_key_active_unique")
      .on(table.periodKey)
      .where(sql`${table.periodKey} IS NOT NULL`),
    uniqueIndex("approvals_requester_creation_unique")
      .on(table.requesterEmail, table.clientCreationKey)
      .where(sql`${table.clientCreationKey} IS NOT NULL`),
    uniqueIndex("approvals_business_key_unique")
      .on(table.businessKey)
      .where(sql`${table.businessKey} IS NOT NULL`),
  ],
);

export const approvalEvents = sqliteTable("approval_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  approvalId: text("approval_id").notNull(),
  actorName: text("actor_name").notNull(),
  actorEmail: text("actor_email").notNull(),
  action: text("action").notNull(),
  note: text("note").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("approval_events_actor_created_idx").on(table.actorEmail, table.createdAt),
]);

export const writeRateBuckets = sqliteTable(
  "write_rate_buckets",
  {
    bucketKey: text("bucket_key").primaryKey(),
    actorSubject: text("actor_subject").notNull(),
    scope: text("scope").notNull(),
    windowStartedAt: text("window_started_at").notNull(),
    used: integer("used").notNull().default(1),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("write_rate_buckets_updated_idx").on(table.updatedAt),
  ],
);

// A persistent database gate used only during a controlled migration freeze.
// Business-table triggers consult this row at commit time, so requests that
// entered an older Worker before the freeze cannot write after the snapshot.
export const migrationControl = sqliteTable("migration_control", {
  freezeId: text("freeze_id").primaryKey(),
  activatedAt: text("activated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  deactivatedAt: text("deactivated_at"),
});

export const approvalRevisions = sqliteTable(
  "approval_revisions",
  {
    revisionHash: text("revision_hash").primaryKey(),
    approvalId: text("approval_id").notNull(),
    revisionNo: integer("revision_no").notNull(),
    previousRevisionHash: text("previous_revision_hash"),
    mutationRevision: text("mutation_revision").notNull(),
    stateJson: text("state_json").notNull(),
    stateHash: text("state_hash").notNull(),
    eventJson: text("event_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("approval_revisions_approval_no_unique").on(table.approvalId, table.revisionNo),
    uniqueIndex("approval_revisions_approval_mutation_unique").on(table.approvalId, table.mutationRevision),
    index("approval_revisions_approval_created_idx").on(table.approvalId, table.createdAt),
  ],
);

export const laborSourceClaims = sqliteTable(
  "labor_source_claims",
  {
    id: text("id").primaryKey(),
    claimantMemberId: text("claimant_member_id").notNull(),
    claimantEmail: text("claimant_email").notNull(),
    technicalApprovalId: text("technical_approval_id").notNull(),
    laborApprovalId: text("labor_approval_id").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("labor_source_claims_member_technical_unique").on(table.claimantMemberId, table.technicalApprovalId),
    index("labor_source_claims_labor_approval_idx").on(table.laborApprovalId),
  ],
);

export const externalArchives = sqliteTable(
  "external_archives",
  {
    id: text("id").primaryKey(),
    approvalId: text("approval_id").notNull(),
    destination: text("destination").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    contentHash: text("content_hash").notNull(),
    fileName: text("file_name").notNull(),
    status: text("status").notNull().default("pending"),
    fileToken: text("file_token"),
    sourceRevisionHash: text("source_revision_hash"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: text("lease_expires_at"),
    errorCode: text("error_code"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("external_archives_approval_destination_manifest_unique").on(table.approvalId, table.destination, table.manifestHash),
    index("external_archives_approval_destination_status_idx").on(table.approvalId, table.destination, table.status),
  ],
);

export const members = sqliteTable("members", {
  id: text("id").primaryKey(),
  fullName: text("full_name").notNull(),
  identityNumber: text("identity_number"),
  schoolEmail: text("school_email").notNull().default(""),
  chatgptAccount: text("chatgpt_account").notNull().unique(),
  accountUserId: text("account_user_id"),
  pendingFullName: text("pending_full_name"),
  pendingIdentityNumber: text("pending_identity_number"),
  accountBindingPreviousStatus: text("account_binding_previous_status"),
  role: text("role").notNull().default("member"),
  permissionsJson: text("permissions_json").notNull().default("[]"),
  departmentCode: text("department_code").notNull().default(""),
  status: text("status").notNull().default("active"),
  ndaAcceptedAt: text("nda_accepted_at"),
  ndaApprovalId: text("nda_approval_id"),
  ndaAgreementVersion: text("nda_agreement_version"),
  mutationRevision: text("mutation_revision").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  lastSeenAt: text("last_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("members_identity_number_active_unique")
    .on(table.identityNumber)
    .where(sql`${table.status} = 'active' AND ${table.identityNumber} IS NOT NULL`),
  uniqueIndex("members_account_user_id_unique")
    .on(table.accountUserId)
    .where(sql`${table.accountUserId} IS NOT NULL`),
]);

export const memberEvents = sqliteTable("member_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  memberId: text("member_id").notNull(),
  actorName: text("actor_name").notNull(),
  actorEmail: text("actor_email").notNull(),
  action: text("action").notNull(),
  note: text("note").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const memberSessions = sqliteTable("member_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  memberId: text("member_id").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  lastSeenAt: text("last_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  expiresAt: text("expires_at"),
});

export const authIdentities = sqliteTable("auth_identities", {
  id: text("id").primaryKey(),
  memberId: text("member_id").notNull(),
  provider: text("provider").notNull(),
  providerSubject: text("provider_subject").notNull(),
  loginSnapshot: text("login_snapshot").notNull().default(""),
  verifiedEmailSnapshot: text("verified_email_snapshot").notNull().default(""),
  linkedAt: text("linked_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  lastSeenAt: text("last_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  unlinkedAt: text("unlinked_at"),
}, (table) => [
  uniqueIndex("auth_identities_provider_subject_unique").on(table.provider, table.providerSubject),
  uniqueIndex("auth_identities_member_provider_active_unique")
    .on(table.memberId, table.provider)
    .where(sql`${table.unlinkedAt} IS NULL`),
  index("auth_identities_member_active_idx").on(table.memberId, table.unlinkedAt),
]);

export const oauthTransactions = sqliteTable("oauth_transactions", {
  stateHash: text("state_hash").primaryKey(),
  provider: text("provider").notNull().default("github"),
  browserNonceHash: text("browser_nonce_hash").notNull(),
  pkceVerifier: text("pkce_verifier").notNull(),
  action: text("action").notNull(),
  memberId: text("member_id"),
  returnPath: text("return_path").notNull().default("/"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  expiresAt: text("expires_at").notNull(),
  consumedAt: text("consumed_at"),
}, (table) => [
  index("oauth_transactions_expires_idx").on(table.expiresAt),
]);

export const oauthSessions = sqliteTable("oauth_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  provider: text("provider").notNull(),
  providerSubject: text("provider_subject").notNull(),
  memberId: text("member_id"),
  loginSnapshot: text("login_snapshot").notNull().default(""),
  emailSnapshot: text("email_snapshot").notNull(),
  displayNameSnapshot: text("display_name_snapshot").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  lastSeenAt: text("last_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),
}, (table) => [
  index("oauth_sessions_provider_subject_idx").on(table.provider, table.providerSubject),
  index("oauth_sessions_member_idx").on(table.memberId),
  index("oauth_sessions_expires_idx").on(table.expiresAt),
]);

export const accountProfiles = sqliteTable("account_profiles", {
  chatgptAccount: text("chatgpt_account").primaryKey(),
  avatarDataUrl: text("avatar_data_url").notNull().default(""),
  profileJson: text("profile_json").notNull().default("{}"),
  lastSeenAt: text("last_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const directMessages = sqliteTable(
  "direct_messages",
  {
    id: text("id").primaryKey(),
    senderEmail: text("sender_email").notNull(),
    senderName: text("sender_name").notNull(),
    recipientEmail: text("recipient_email").notNull(),
    recipientName: text("recipient_name").notNull(),
    body: text("body").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("direct_messages_sender_recipient_created_idx").on(table.senderEmail, table.recipientEmail, table.createdAt),
    index("direct_messages_recipient_sender_created_idx").on(table.recipientEmail, table.senderEmail, table.createdAt),
    index("direct_messages_sender_created_idx").on(table.senderEmail, table.createdAt),
  ],
);

// OA V2 keeps the existing member and authentication records authoritative.
// Organization, project, and conversation records refer to members by their
// stable member ID; email/name snapshots live only on historical messages.
export const departments = sqliteTable(
  "departments",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    parentId: text("parent_id"),
    status: text("status").notNull().default("active"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdByMemberId: text("created_by_member_id").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check("departments_code_check", sql`length(trim(${table.code})) BETWEEN 1 AND 64`),
    check("departments_name_check", sql`length(trim(${table.name})) BETWEEN 1 AND 120`),
    check("departments_status_check", sql`${table.status} IN ('active', 'archived')`),
    uniqueIndex("departments_code_unique").on(table.code),
    index("departments_parent_sort_idx").on(table.parentId, table.sortOrder, table.name),
  ],
);

export const departmentMemberships = sqliteTable(
  "department_memberships",
  {
    id: text("id").primaryKey(),
    departmentId: text("department_id").notNull(),
    memberId: text("member_id").notNull(),
    membershipType: text("membership_type").notNull().default("primary"),
    title: text("title").notNull().default(""),
    joinedAt: text("joined_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    leftAt: text("left_at"),
    createdByMemberId: text("created_by_member_id").notNull(),
  },
  (table) => [
    check("department_memberships_type_check", sql`${table.membershipType} IN ('primary', 'collaborator')`),
    uniqueIndex("department_memberships_active_unique")
      .on(table.departmentId, table.memberId)
      .where(sql`${table.leftAt} IS NULL`),
    uniqueIndex("department_memberships_member_primary_unique")
      .on(table.memberId)
      .where(sql`${table.leftAt} IS NULL AND ${table.membershipType} = 'primary'`),
    index("department_memberships_member_active_idx").on(table.memberId, table.leftAt),
  ],
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    projectKey: text("project_key").notNull(),
    name: text("name").notNull(),
    summary: text("summary").notNull().default(""),
    status: text("status").notNull().default("active"),
    ownerMemberId: text("owner_member_id").notNull(),
    createdByMemberId: text("created_by_member_id").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    archivedAt: text("archived_at"),
  },
  (table) => [
    check("projects_key_check", sql`length(trim(${table.projectKey})) BETWEEN 1 AND 80`),
    check("projects_name_check", sql`length(trim(${table.name})) BETWEEN 1 AND 160`),
    check("projects_status_check", sql`${table.status} IN ('planned', 'active', 'paused', 'completed', 'archived')`),
    uniqueIndex("projects_key_unique").on(table.projectKey),
    index("projects_status_updated_idx").on(table.status, table.updatedAt),
  ],
);

export const projectMembers = sqliteTable(
  "project_members",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    memberId: text("member_id").notNull(),
    role: text("role").notNull().default("member"),
    joinedAt: text("joined_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    leftAt: text("left_at"),
    addedByMemberId: text("added_by_member_id").notNull(),
  },
  (table) => [
    check("project_members_role_check", sql`${table.role} IN ('owner', 'manager', 'member', 'observer')`),
    uniqueIndex("project_members_active_unique")
      .on(table.projectId, table.memberId)
      .where(sql`${table.leftAt} IS NULL`),
    index("project_members_member_active_idx").on(table.memberId, table.leftAt),
  ],
);

export const projectLinks = sqliteTable(
  "project_links",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    label: text("label").notNull().default(""),
    linkedByMemberId: text("linked_by_member_id").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check("project_links_type_check", sql`${table.resourceType} IN ('approval', 'knowledge', 'meeting', 'work_item', 'conversation', 'email')`),
    uniqueIndex("project_links_resource_unique").on(table.projectId, table.resourceType, table.resourceId),
    index("project_links_resource_idx").on(table.resourceType, table.resourceId),
  ],
);

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    title: text("title").notNull().default(""),
    directKey: text("direct_key"),
    projectId: text("project_id"),
    createdByMemberId: text("created_by_member_id").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    archivedAt: text("archived_at"),
  },
  (table) => [
    check("conversations_type_check", sql`${table.type} IN ('direct', 'group', 'project', 'ai')`),
    check("conversations_direct_key_check", sql`(${table.type} = 'direct' AND ${table.directKey} IS NOT NULL) OR (${table.type} <> 'direct' AND ${table.directKey} IS NULL)`),
    check("conversations_project_check", sql`(${table.type} = 'project' AND ${table.projectId} IS NOT NULL) OR ${table.type} <> 'project'`),
    uniqueIndex("conversations_direct_key_unique")
      .on(table.directKey)
      .where(sql`${table.directKey} IS NOT NULL`),
    index("conversations_project_updated_idx").on(table.projectId, table.updatedAt),
  ],
);

export const conversationMembers = sqliteTable(
  "conversation_members",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    memberId: text("member_id").notNull(),
    role: text("role").notNull().default("member"),
    joinedAt: text("joined_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    leftAt: text("left_at"),
    lastReadMessageId: text("last_read_message_id"),
    lastReadAt: text("last_read_at"),
    addedByMemberId: text("added_by_member_id").notNull(),
  },
  (table) => [
    check("conversation_members_role_check", sql`${table.role} IN ('owner', 'admin', 'member')`),
    uniqueIndex("conversation_members_active_unique")
      .on(table.conversationId, table.memberId)
      .where(sql`${table.leftAt} IS NULL`),
    index("conversation_members_member_active_idx").on(table.memberId, table.leftAt, table.conversationId),
  ],
);

export const conversationMessages = sqliteTable(
  "conversation_messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    senderMemberId: text("sender_member_id").notNull(),
    senderName: text("sender_name").notNull(),
    body: text("body").notNull(),
    messageType: text("message_type").notNull().default("text"),
    replyToMessageId: text("reply_to_message_id"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    editedAt: text("edited_at"),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    check("conversation_messages_body_check", sql`length(${table.body}) BETWEEN 1 AND 16000`),
    check("conversation_messages_type_check", sql`${table.messageType} IN ('text', 'system', 'file')`),
    index("conversation_messages_conversation_created_idx").on(table.conversationId, table.createdAt, table.id),
    index("conversation_messages_sender_created_idx").on(table.senderMemberId, table.createdAt),
  ],
);

export const conversationEvents = sqliteTable(
  "conversation_events",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    actorMemberId: text("actor_member_id").notNull(),
    action: text("action").notNull(),
    subjectMemberId: text("subject_member_id"),
    detailJson: text("detail_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check("conversation_events_action_check", sql`${table.action} IN ('created', 'renamed', 'member_added', 'member_removed', 'archived', 'restored')`),
    index("conversation_events_conversation_created_idx").on(table.conversationId, table.createdAt),
  ],
);

export const knowledgeItems = sqliteTable(
  "knowledge_items",
  {
    id: text("id").primaryKey(),
    project: text("project").notNull(),
    title: text("title").notNull(),
    category: text("category").notNull().default(""),
    submitterMemberId: text("submitter_member_id").notNull(),
    submitterName: text("submitter_name").notNull(),
    submitterEmail: text("submitter_email").notNull(),
    status: text("status").notNull().default("pending"),
    visibility: text("visibility").notNull().default("internal"),
    currentRevisionNo: integer("current_revision_no").notNull().default(0),
    currentRevisionId: text("current_revision_id"),
    activeRevisionId: text("active_revision_id"),
    mutationRevision: text("mutation_revision").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    check("knowledge_items_status_check", sql`${table.status} IN ('pending', 'returned', 'rejected', 'active', 'revoked')`),
    check("knowledge_items_visibility_check", sql`${table.visibility} IN ('internal', 'public')`),
    check("knowledge_items_mutation_revision_check", sql`length(${table.mutationRevision}) > 0`),
    check("knowledge_items_revision_pointer_check", sql`(${table.currentRevisionNo} = 0 AND ${table.currentRevisionId} IS NULL) OR (${table.currentRevisionNo} > 0 AND ${table.currentRevisionId} IS NOT NULL)`),
    check("knowledge_items_active_pointer_check", sql`(${table.status} = 'active' AND ${table.activeRevisionId} IS NOT NULL) OR (${table.status} <> 'active' AND ${table.activeRevisionId} IS NULL)`),
    index("knowledge_items_status_updated_idx").on(table.status, table.updatedAt),
    index("knowledge_items_visibility_status_updated_idx").on(table.visibility, table.status, table.updatedAt),
    index("knowledge_items_submitter_created_idx").on(table.submitterMemberId, table.createdAt),
    uniqueIndex("knowledge_items_current_revision_unique")
      .on(table.currentRevisionId)
      .where(sql`${table.currentRevisionId} IS NOT NULL`),
    uniqueIndex("knowledge_items_active_revision_unique")
      .on(table.activeRevisionId)
      .where(sql`${table.activeRevisionId} IS NOT NULL`),
  ],
);

export const knowledgeRevisions = sqliteTable(
  "knowledge_revisions",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id").notNull(),
    revisionNo: integer("revision_no").notNull(),
    previousRevisionId: text("previous_revision_id"),
    title: text("title").notNull(),
    category: text("category").notNull().default(""),
    content: text("content").notNull(),
    summary: text("summary").notNull().default(""),
    sourceLabel: text("source_label").notNull().default(""),
    sourceUrl: text("source_url").notNull().default(""),
    contentHash: text("content_hash").notNull(),
    status: text("status").notNull().default("pending"),
    createdByMemberId: text("created_by_member_id").notNull(),
    createdByName: text("created_by_name").notNull(),
    createdByEmail: text("created_by_email").notNull(),
    reviewedByMemberId: text("reviewed_by_member_id"),
    reviewedByName: text("reviewed_by_name"),
    reviewedByEmail: text("reviewed_by_email"),
    reviewNote: text("review_note").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    reviewedAt: text("reviewed_at"),
    activatedAt: text("activated_at"),
    retiredAt: text("retired_at"),
  },
  (table) => [
    check("knowledge_revisions_number_check", sql`${table.revisionNo} > 0`),
    check("knowledge_revisions_status_check", sql`${table.status} IN ('pending', 'returned', 'rejected', 'active', 'superseded', 'revoked')`),
    check("knowledge_revisions_content_hash_check", sql`length(${table.contentHash}) = 64 AND ${table.contentHash} NOT GLOB '*[^0-9a-f]*'`),
    uniqueIndex("knowledge_revisions_item_no_unique").on(table.itemId, table.revisionNo),
    uniqueIndex("knowledge_revisions_item_hash_unique").on(table.itemId, table.contentHash),
    index("knowledge_revisions_item_status_created_idx").on(table.itemId, table.status, table.createdAt),
  ],
);

export const knowledgeRevisionParts = sqliteTable(
  "knowledge_revision_parts",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id").notNull(),
    revisionId: text("revision_id").notNull(),
    partNo: integer("part_no").notNull(),
    content: text("content").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check("knowledge_revision_parts_number_check", sql`${table.partNo} > 0`),
    check("knowledge_revision_parts_content_length_check", sql`length(${table.content}) BETWEEN 1 AND 20000`),
    uniqueIndex("knowledge_revision_parts_revision_no_unique").on(table.revisionId, table.partNo),
    index("knowledge_revision_parts_item_revision_idx").on(table.itemId, table.revisionId, table.partNo),
  ],
);

// SQL migrations also enforce asset integrity and the staged-to-ready transition.
export const knowledgeRevisionAssets = sqliteTable(
  "knowledge_revision_assets",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id").notNull(),
    revisionId: text("revision_id").notNull(),
    assetPath: text("asset_path").notNull(),
    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    uploadToken: text("upload_token").notNull().default(""),
    // The inline CHECK in immutable migration 0032 restricts these two states.
    uploadState: text("upload_state").$type<"staged" | "ready">().notNull().default("ready"),
  },
  (table) => [
    uniqueIndex("knowledge_revision_assets_revision_path_unique").on(table.revisionId, table.assetPath),
    uniqueIndex("knowledge_revision_assets_storage_key_unique").on(table.storageKey),
    index("knowledge_revision_assets_item_revision_idx").on(table.itemId, table.revisionId, table.assetPath),
    index("knowledge_revision_assets_upload_idx").on(table.revisionId, table.uploadToken, table.uploadState),
  ],
);

export const knowledgeChunks = sqliteTable(
  "knowledge_chunks",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id").notNull(),
    revisionId: text("revision_id").notNull(),
    chunkNo: integer("chunk_no").notNull(),
    sectionTitle: text("section_title").notNull().default(""),
    paragraphRef: text("paragraph_ref").notNull().default(""),
    content: text("content").notNull(),
    searchText: text("search_text").notNull(),
    isActive: integer("is_active").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check("knowledge_chunks_number_check", sql`${table.chunkNo} > 0`),
    check("knowledge_chunks_active_check", sql`${table.isActive} IN (0, 1)`),
    uniqueIndex("knowledge_chunks_revision_no_unique").on(table.revisionId, table.chunkNo),
    index("knowledge_chunks_active_item_chunk_idx").on(table.isActive, table.itemId, table.chunkNo),
    index("knowledge_chunks_item_active_idx").on(table.itemId, table.isActive),
  ],
);

export const knowledgeEvents = sqliteTable(
  "knowledge_events",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id").notNull(),
    revisionId: text("revision_id"),
    actorMemberId: text("actor_member_id").notNull(),
    actorName: text("actor_name").notNull(),
    actorEmail: text("actor_email").notNull(),
    action: text("action").notNull(),
    note: text("note").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("knowledge_events_item_created_idx").on(table.itemId, table.createdAt),
    index("knowledge_events_actor_created_idx").on(table.actorMemberId, table.createdAt),
  ],
);

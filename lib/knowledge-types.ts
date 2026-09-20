export type KnowledgeStatus = "pending" | "returned" | "rejected" | "active" | "revoked";
export type KnowledgeVisibility = "internal" | "public";
export type KnowledgeRevisionStatus = KnowledgeStatus | "superseded";

export const KNOWLEDGE_LIST_QUERY_MAX_LENGTH = 100;
export const KNOWLEDGE_LIST_SORTS = ["updated_desc", "updated_asc", "title_asc", "title_desc"] as const;
export type KnowledgeListSort = typeof KNOWLEDGE_LIST_SORTS[number];
export type KnowledgeListOptions = {
  query?: string;
  sort?: KnowledgeListSort;
};

export type KnowledgeItem = {
  id: string;
  project?: string;
  title: string;
  category: string;
  summary?: string;
  content?: string;
  sourceLabel?: string;
  sourceUrl?: string;
  contentPartCount?: number;
  submitterMemberId?: string;
  submitterName?: string;
  submitterEmail?: string;
  status: KnowledgeStatus;
  visibility: KnowledgeVisibility;
  currentRevisionNo?: number;
  currentRevisionId?: string;
  activeRevisionId?: string;
  mutationRevision?: string;
  createdAt: string;
  updatedAt: string;
  reviewedByName?: string;
  reviewedByEmail?: string;
  reviewedAt?: string;
  reviewNote?: string;
  revokedAt?: string;
  canReview?: boolean;
  canReturn?: boolean;
  canReject?: boolean;
  canRevoke?: boolean;
  canSetVisibility?: boolean;
  canAdminEdit?: boolean;
};

export type KnowledgeRevision = {
  id: string;
  itemId?: string;
  revisionNo?: number;
  previousRevisionId?: string;
  title?: string;
  category?: string;
  summary?: string;
  content: string;
  sourceLabel?: string;
  sourceUrl?: string;
  contentHash?: string;
  contentPartCount?: number;
  status?: KnowledgeRevisionStatus;
  createdByMemberId?: string;
  createdByName?: string;
  createdByEmail?: string;
  createdAt?: string;
  reviewedByMemberId?: string;
  reviewedByName?: string;
  reviewedByEmail?: string;
  reviewNote?: string;
  reviewedAt?: string;
  activatedAt?: string;
  retiredAt?: string;
};

export type KnowledgeAsset = {
  path: string;
  mimeType: string;
  byteSize: number;
  url: string;
};

export type KnowledgeEvent = {
  id: string | number;
  action: string;
  actorName?: string;
  actorEmail?: string;
  note?: string;
  createdAt: string;
};

export type KnowledgeCitation = {
  id: string;
  itemId?: string;
  revisionId?: string;
  title: string;
  category?: string;
  section?: string;
  sectionTitle?: string;
  paragraphRef?: string;
  excerpt: string;
  sourceLabel?: string;
  sourceUrl?: string;
};

export type KnowledgeListResponse = {
  items?: KnowledgeItem[];
  pendingCount?: number;
  canReviewKnowledge?: boolean;
  error?: string;
};

export type KnowledgeDetailResponse = {
  item?: KnowledgeItem;
  revisions?: KnowledgeRevision[];
  assets?: KnowledgeAsset[];
  events?: KnowledgeEvent[];
  error?: string;
};

export type KnowledgeAskResponse = {
  answer?: string;
  citations?: KnowledgeCitation[];
  mode?: string;
  error?: string;
};

export type KnowledgeAction = "approve" | "return" | "reject" | "revoke" | "resubmit" | "set_visibility" | "activate_admin_edit";

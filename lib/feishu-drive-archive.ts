import { buildArchiveManifest } from "./archive-manifest";
import { approvalEventActionLabel, buildApprovalPdf, safeFeishuArchivePdfFileName, type ApprovalPdfRecord } from "./approval-pdf";

export const FEISHU_PDF_ARCHIVE_DESTINATION = "feishu_drive_pdf_v2";
const ROOT_FOLDER_NAME = "OriginMind OA 归档";
const LEASE_DURATION_MS = 5 * 60 * 1000;
const API_TIMEOUT_MS = 20_000;

export type FeishuArchiveEnv = {
  DB: D1Database;
  FEISHU_PDF_ARCHIVE_ENABLED?: string;
  FEISHU_LOGIN_APP_ID?: string;
  FEISHU_LOGIN_APP_SECRET?: string;
  OA_ADMIN_EMAILS?: string;
};

type ApprovalRow = {
  id: string;
  type: string;
  title: string;
  project: string;
  requester_name: string;
  requester_email: string;
  client_creation_key: string | null;
  business_key: string | null;
  created_at: string;
  updated_at: string;
  status: string;
  current_step: string;
  current_reviewer_name: string;
  current_reviewer_email: string;
  summary: string;
  owner: string;
  amount: string | null;
  period_key: string | null;
  signers_json: string;
  payload_json: string;
  current_revision_no: number;
  current_revision_hash: string | null;
};

type EventRow = {
  id: number;
  approval_id: string;
  actor_name: string;
  actor_email: string;
  action: string;
  note: string;
  created_at: string;
};

type RevisionRow = {
  revision_hash: string;
  approval_id: string;
  revision_no: number;
  previous_revision_hash: string | null;
  mutation_revision: string;
  state_json: string;
  state_hash: string;
  event_json: string;
  created_at: string;
};

type ArchiveRow = {
  id: string;
  content_hash: string;
  status: string;
  file_token: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
};

type FeishuEnvelope = {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  data?: Record<string, unknown>;
};

class FeishuArchiveError extends Error {
  readonly failureCode: string;

  constructor(failureCode: string) {
    super(failureCode);
    this.name = "FeishuArchiveError";
    this.failureCode = failureCode;
  }
}

function parseObject(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseStringArray(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

async function sha256Bytes(value: Uint8Array) {
  const buffer = new ArrayBuffer(value.byteLength);
  new Uint8Array(buffer).set(value);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function failureCode(error: unknown) {
  if (error instanceof FeishuArchiveError) return error.failureCode;
  if (error instanceof DOMException && error.name === "TimeoutError") return "FEISHU_API_TIMEOUT";
  return "FEISHU_PDF_ARCHIVE_FAILED";
}

function safeFolderName(value: string) {
  return value.normalize("NFKC").replace(/[\p{Cf}\u2028\u2029]/gu, "").replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "-").replace(/\s+/gu, " ").trim().slice(0, 80) || "其他审批";
}

function shanghaiArchivePath(value: string, approvalType: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new FeishuArchiveError("ARCHIVE_DATE_INVALID");
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return [`${parts.year}年`, `${parts.month}月`, safeFolderName(approvalType)];
}

async function feishuJson(url: string, init: RequestInit, expectedData = true) {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") throw error;
    throw new FeishuArchiveError("FEISHU_NETWORK_ERROR");
  }
  let envelope: FeishuEnvelope;
  try {
    envelope = await response.json() as FeishuEnvelope;
  } catch {
    throw new FeishuArchiveError(`FEISHU_HTTP_${response.status || 500}`);
  }
  if (!response.ok || envelope.code !== 0 || (expectedData && !envelope.data)) {
    const code = typeof envelope.code === "number" ? envelope.code : response.status || 500;
    throw new FeishuArchiveError(`FEISHU_API_${code}`);
  }
  return envelope;
}

async function tenantAccessToken(env: FeishuArchiveEnv) {
  const appId = env.FEISHU_LOGIN_APP_ID?.trim() || "";
  const appSecret = env.FEISHU_LOGIN_APP_SECRET?.trim() || "";
  if (!appId || !appSecret) throw new FeishuArchiveError("FEISHU_ARCHIVE_CONFIG_MISSING");
  const envelope = await feishuJson("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  }, false);
  if (!envelope.tenant_access_token) throw new FeishuArchiveError("FEISHU_TOKEN_MISSING");
  return envelope.tenant_access_token;
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

type DriveEntry = { token: string; name: string; type: string };

function driveEntries(data: Record<string, unknown> | undefined) {
  const files = Array.isArray(data?.files) ? data.files : [];
  return files.flatMap((value): DriveEntry[] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    const token = typeof record.token === "string" ? record.token : typeof record.folder_token === "string" ? record.folder_token : "";
    const name = typeof record.name === "string" ? record.name : "";
    const type = typeof record.type === "string" ? record.type : "";
    return token && name ? [{ token, name, type }] : [];
  });
}

async function listFolder(token: string, parentToken: string) {
  const entries: DriveEntry[] = [];
  const seenTokens = new Set<string>();
  let pageToken = "";
  for (let page = 0; page < 50; page += 1) {
    const url = new URL("https://open.feishu.cn/open-apis/drive/v1/files");
    if (parentToken) url.searchParams.set("folder_token", parentToken);
    if (pageToken) url.searchParams.set("page_token", pageToken);
    url.searchParams.set("page_size", "200");
    url.searchParams.set("order_by", "CreatedTime");
    url.searchParams.set("direction", "ASC");
    const envelope = await feishuJson(url.toString(), { headers: bearer(token) });
    entries.push(...driveEntries(envelope.data));
    if (envelope.data?.has_more !== true) return entries;
    const nextToken = typeof envelope.data.next_page_token === "string" ? envelope.data.next_page_token : "";
    if (!nextToken || seenTokens.has(nextToken)) throw new FeishuArchiveError("FEISHU_FOLDER_PAGINATION_INVALID");
    seenTokens.add(nextToken);
    pageToken = nextToken;
  }
  throw new FeishuArchiveError("FEISHU_FOLDER_PAGINATION_LIMIT");
}

async function ensureFolder(token: string, parentToken: string, name: string) {
  const entries = await listFolder(token, parentToken);
  const existing = entries.find((entry) => entry.type === "folder" && entry.name === name);
  if (existing) return { token: existing.token, created: false };
  try {
    const envelope = await feishuJson("https://open.feishu.cn/open-apis/drive/v1/files/create_folder", {
      method: "POST",
      headers: { ...bearer(token), "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ name, folder_token: parentToken }),
    });
    const folderToken = typeof envelope.data?.token === "string" ? envelope.data.token
      : typeof envelope.data?.folder_token === "string" ? envelope.data.folder_token
        : "";
    if (!folderToken) throw new FeishuArchiveError("FEISHU_FOLDER_TOKEN_MISSING");
    return { token: folderToken, created: true };
  } catch (error) {
    const afterRace = (await listFolder(token, parentToken)).find((entry) => entry.type === "folder" && entry.name === name);
    if (afterRace) return { token: afterRace.token, created: false };
    throw error;
  }
}

function containsMemberIdentity(value: unknown, openId: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsMemberIdentity(item, openId));
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if ((record.member_id === openId || record.open_id === openId) && (record.member_type === "openid" || record.member_type === "open_id" || !record.member_type)) return true;
  return Object.values(record).some((item) => containsMemberIdentity(item, openId));
}

async function ensureAdminCanManageRoot(token: string, folderToken: string, adminOpenId: string) {
  const baseUrl = new URL(`https://open.feishu.cn/open-apis/drive/v1/permissions/${encodeURIComponent(folderToken)}/members`);
  const seenTokens = new Set<string>();
  let pageToken = "";
  for (let page = 0; page < 50; page += 1) {
    const url = new URL(baseUrl);
    url.searchParams.set("type", "folder");
    url.searchParams.set("page_size", "100");
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const current = await feishuJson(url.toString(), { headers: bearer(token) });
    if (containsMemberIdentity(current.data, adminOpenId)) return;
    if (current.data?.has_more !== true) break;
    const nextToken = typeof current.data.next_page_token === "string" ? current.data.next_page_token : "";
    if (!nextToken || seenTokens.has(nextToken)) throw new FeishuArchiveError("FEISHU_PERMISSION_PAGINATION_INVALID");
    seenTokens.add(nextToken);
    pageToken = nextToken;
    if (page === 49) throw new FeishuArchiveError("FEISHU_PERMISSION_PAGINATION_LIMIT");
  }
  await feishuJson(`${baseUrl.origin}${baseUrl.pathname}?type=folder&need_notification=false`, {
    method: "POST",
    headers: { ...bearer(token), "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ member_type: "openid", member_id: adminOpenId, perm: "full_access", type: "user" }),
  }, false);
}

async function uploadPdf(token: string, folderToken: string, fileName: string, pdf: Uint8Array) {
  if (pdf.byteLength > 20 * 1024 * 1024) throw new FeishuArchiveError("PDF_EXCEEDS_FEISHU_20MB_LIMIT");
  const form = new FormData();
  form.set("file_name", fileName);
  form.set("parent_type", "explorer");
  form.set("parent_node", folderToken);
  form.set("size", String(pdf.byteLength));
  const fileBuffer = new ArrayBuffer(pdf.byteLength);
  new Uint8Array(fileBuffer).set(pdf);
  form.set("file", new File([fileBuffer], fileName, { type: "application/pdf" }));
  const envelope = await feishuJson("https://open.feishu.cn/open-apis/drive/v1/files/upload_all", {
    method: "POST",
    headers: bearer(token),
    body: form,
  });
  const fileToken = typeof envelope.data?.file_token === "string" ? envelope.data.file_token : "";
  if (!fileToken) throw new FeishuArchiveError("FEISHU_FILE_TOKEN_MISSING");
  return fileToken;
}

async function adminOpenId(env: FeishuArchiveEnv) {
  const adminEmails = new Set((env.OA_ADMIN_EMAILS || "").split(",").map(normalizeEmail).filter(Boolean));
  if (!adminEmails.size) throw new FeishuArchiveError("FEISHU_ARCHIVE_ADMIN_MISSING");
  const rows = await env.DB.prepare(`
    SELECT m.chatgpt_account AS email, ai.login_snapshot AS open_id
    FROM auth_identities ai
    INNER JOIN members m ON m.id = ai.member_id
    WHERE ai.provider = 'feishu' AND ai.unlinked_at IS NULL AND m.status = 'active'
    ORDER BY ai.linked_at ASC
  `).all<{ email: string; open_id: string }>();
  const identity = rows.results.find((row) => adminEmails.has(normalizeEmail(row.email)) && row.open_id);
  if (!identity) throw new FeishuArchiveError("FEISHU_ARCHIVE_ADMIN_NOT_LINKED");
  return identity.open_id;
}

async function approvalBundle(env: FeishuArchiveEnv, approvalId: string) {
  const approval = await env.DB.prepare(`SELECT * FROM approvals WHERE id = ? AND status = '已归档' LIMIT 1`).bind(approvalId).first<ApprovalRow>();
  if (!approval) return null;
  const [eventResult, revisionResult] = await Promise.all([
    env.DB.prepare(`SELECT * FROM approval_events WHERE approval_id = ? AND action <> 'feishu_archived' ORDER BY created_at ASC, id ASC`).bind(approvalId).all<EventRow>(),
    env.DB.prepare(`SELECT * FROM approval_revisions WHERE approval_id = ? ORDER BY revision_no ASC`).bind(approvalId).all<RevisionRow>(),
  ]);
  const events = eventResult.results.map((event) => ({
    id: event.id,
    actorName: event.actor_name,
    actorEmail: event.actor_email,
    action: event.action,
    note: event.note,
    createdAt: event.created_at,
  }));
  const revisions = revisionResult.results.map((revision) => ({
    revisionHash: revision.revision_hash,
    approvalId: revision.approval_id,
    revisionNo: revision.revision_no,
    previousRevisionHash: revision.previous_revision_hash,
    mutationRevision: revision.mutation_revision,
    stateJson: revision.state_json,
    stateHash: revision.state_hash,
    eventJson: revision.event_json,
    createdAt: revision.created_at,
  }));
  const manifestApproval = {
    id: approval.id,
    type: approval.type,
    title: approval.title,
    project: approval.project,
    requesterName: approval.requester_name,
    requesterEmail: approval.requester_email,
    clientCreationKey: approval.client_creation_key,
    businessKey: approval.business_key,
    createdAt: approval.created_at,
    updatedAt: approval.updated_at,
    status: approval.status,
    currentStep: approval.current_step,
    currentReviewerName: approval.current_reviewer_name,
    currentReviewerEmail: approval.current_reviewer_email,
    summary: approval.summary,
    owner: approval.owner,
    amount: approval.amount,
    periodKey: approval.period_key,
    signersJson: approval.signers_json,
    payloadJson: approval.payload_json,
    currentRevisionNo: approval.current_revision_no,
    currentRevisionHash: approval.current_revision_hash,
  };
  const pdfApproval: ApprovalPdfRecord = {
    ...manifestApproval,
    currentReviewerName: approval.current_reviewer_name,
    currentReviewerEmail: approval.current_reviewer_email,
    signers: parseStringArray(approval.signers_json),
    payload: parseObject(approval.payload_json),
  };
  return { approval, manifestApproval, pdfApproval, events, revisions };
}

async function acquireArchiveLease(env: FeishuArchiveEnv, input: { approvalId: string; manifestHash: string; contentHash: string; fileName: string; sourceRevisionHash: string | null }) {
  const now = new Date().toISOString();
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(Date.now() + LEASE_DURATION_MS).toISOString();
  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT OR IGNORE INTO external_archives (
      id, approval_id, destination, manifest_hash, content_hash, file_name, status,
      source_revision_hash, lease_token, lease_expires_at, error_code, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL, ?, ?)
  `).bind(id, input.approvalId, FEISHU_PDF_ARCHIVE_DESTINATION, input.manifestHash, input.contentHash, input.fileName, input.sourceRevisionHash, leaseToken, leaseExpiresAt, now, now).run();
  let row = await env.DB.prepare(`
    SELECT id, content_hash, status, file_token, lease_token, lease_expires_at
    FROM external_archives WHERE approval_id = ? AND destination = ? AND manifest_hash = ? LIMIT 1
  `).bind(input.approvalId, FEISHU_PDF_ARCHIVE_DESTINATION, input.manifestHash).first<ArchiveRow>();
  if (!row) throw new FeishuArchiveError("ARCHIVE_LEDGER_INSERT_FAILED");
  if (row.status === "uploaded") {
    if (row.content_hash !== input.contentHash || !row.file_token) throw new FeishuArchiveError("ARCHIVE_LEDGER_INTEGRITY_MISMATCH");
    return { state: "uploaded" as const, archiveId: row.id, fileToken: row.file_token, leaseToken: "" };
  }
  if (row.lease_token === leaseToken) return { state: "acquired" as const, archiveId: row.id, fileToken: null, leaseToken };
  if (row.status === "pending" && row.lease_expires_at && row.lease_expires_at > now) return { state: "busy" as const, archiveId: row.id, fileToken: null, leaseToken: "" };
  const claimed = await env.DB.prepare(`
    UPDATE external_archives
    SET content_hash = ?, file_name = ?, status = 'pending', source_revision_hash = ?, lease_token = ?, lease_expires_at = ?, error_code = NULL, updated_at = ?
    WHERE id = ? AND status <> 'uploaded' AND (status = 'failed' OR lease_expires_at IS NULL OR lease_expires_at <= ?)
  `).bind(input.contentHash, input.fileName, input.sourceRevisionHash, leaseToken, leaseExpiresAt, now, row.id, now).run();
  if ((claimed.meta.changes || 0) !== 1) return { state: "busy" as const, archiveId: row.id, fileToken: null, leaseToken: "" };
  row = { ...row, content_hash: input.contentHash, status: "pending", lease_token: leaseToken, lease_expires_at: leaseExpiresAt };
  return { state: "acquired" as const, archiveId: row.id, fileToken: null, leaseToken };
}

async function uploadedArchive(env: FeishuArchiveEnv, approvalId: string, manifestHash: string) {
  const row = await env.DB.prepare(`
    SELECT id, content_hash, status, file_token, lease_token, lease_expires_at
    FROM external_archives WHERE approval_id = ? AND destination = ? AND manifest_hash = ? LIMIT 1
  `).bind(approvalId, FEISHU_PDF_ARCHIVE_DESTINATION, manifestHash).first<ArchiveRow>();
  if (!row || row.status !== "uploaded") return null;
  if (!row.content_hash || !row.file_token) throw new FeishuArchiveError("ARCHIVE_LEDGER_INTEGRITY_MISMATCH");
  return row.file_token;
}

async function prepareDriveContext(env: FeishuArchiveEnv) {
  const [accessToken, openId] = await Promise.all([tenantAccessToken(env), adminOpenId(env)]);
  const root = await ensureFolder(accessToken, "", ROOT_FOLDER_NAME);
  await ensureAdminCanManageRoot(accessToken, root.token, openId);
  return { accessToken, rootToken: root.token };
}

export async function archiveApprovalPdfToFeishu(env: FeishuArchiveEnv, approvalId: string, driveContext?: () => Promise<Awaited<ReturnType<typeof prepareDriveContext>>>) {
  if (env.FEISHU_PDF_ARCHIVE_ENABLED?.trim().toLowerCase() !== "true") return { status: "disabled" as const };
  const bundle = await approvalBundle(env, approvalId);
  if (!bundle) return { status: "not_archived" as const };
  const manifest = await buildArchiveManifest(bundle.manifestApproval, bundle.events, bundle.revisions);
  const existingFileToken = await uploadedArchive(env, approvalId, manifest.hash);
  if (existingFileToken) return { status: "uploaded" as const, fileToken: existingFileToken };
  const pdf = await buildApprovalPdf({
    approval: bundle.pdfApproval,
    events: bundle.events.map((event) => ({ ...event, action: approvalEventActionLabel(event.action) })),
    integrity: {
      archiveHash: manifest.hash,
      evidenceRecordHash: manifest.evidenceRecordHash,
      schemaVersion: manifest.schemaVersion,
      terminalRevisionNo: manifest.terminalRevisionNo,
      terminalRevisionHash: manifest.terminalRevisionHash,
      terminalStateHash: manifest.terminalStateHash,
    },
  });
  const contentHash = await sha256Bytes(pdf);
  const fileName = safeFeishuArchivePdfFileName(bundle.pdfApproval, manifest.hash);
  const lease = await acquireArchiveLease(env, {
    approvalId,
    manifestHash: manifest.hash,
    contentHash,
    fileName,
    sourceRevisionHash: bundle.approval.current_revision_hash,
  });
  if (lease.state === "uploaded") return { status: "uploaded" as const, fileToken: lease.fileToken };
  if (lease.state === "busy") return { status: "busy" as const };
  try {
    const { accessToken, rootToken } = await (driveContext ? driveContext() : prepareDriveContext(env));
    let parentToken = rootToken;
    for (const folderName of shanghaiArchivePath(bundle.approval.updated_at, bundle.approval.type)) {
      parentToken = (await ensureFolder(accessToken, parentToken, folderName)).token;
    }
    const remoteFile = (await listFolder(accessToken, parentToken)).find((entry) => entry.type === "file" && entry.name === fileName);
    const fileToken = remoteFile?.token || await uploadPdf(accessToken, parentToken, fileName, pdf);
    const now = new Date().toISOString();
    const saved = await env.DB.prepare(`
      UPDATE external_archives
      SET status = 'uploaded', file_token = ?, lease_token = NULL, lease_expires_at = NULL, error_code = NULL, updated_at = ?
      WHERE id = ? AND status = 'pending' AND lease_token = ?
    `).bind(fileToken, now, lease.archiveId, lease.leaseToken).run();
    if ((saved.meta.changes || 0) !== 1) throw new FeishuArchiveError("ARCHIVE_LEDGER_FINALIZE_FAILED");
    return { status: "uploaded" as const, fileToken };
  } catch (error) {
    const now = new Date().toISOString();
    await env.DB.prepare(`
      UPDATE external_archives
      SET status = 'failed', lease_token = NULL, lease_expires_at = NULL, error_code = ?, updated_at = ?
      WHERE id = ? AND status = 'pending' AND lease_token = ?
    `).bind(failureCode(error), now, lease.archiveId, lease.leaseToken).run();
    throw error;
  }
}

export async function archiveApprovalPdfsToFeishu(env: FeishuArchiveEnv, approvalIds: string[]) {
  const uniqueIds = Array.from(new Set(approvalIds.filter((id) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)))).slice(0, 200);
  const results: Array<PromiseSettledResult<Awaited<ReturnType<typeof archiveApprovalPdfToFeishu>>>> = [];
  let sharedContext: Promise<Awaited<ReturnType<typeof prepareDriveContext>>> | undefined;
  const driveContext = () => sharedContext ??= prepareDriveContext(env);
  const startedAt = Date.now();
  for (let index = 0; index < uniqueIds.length; index += 3) {
    if (index > 0 && Date.now() - startedAt > 15_000) break;
    results.push(...await Promise.allSettled(uniqueIds.slice(index, index + 3).map((id) => archiveApprovalPdfToFeishu(env, id, driveContext))));
  }
  return results;
}

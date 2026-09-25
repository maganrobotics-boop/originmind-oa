import { eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { approvalEvents, approvalRevisions, approvals } from "../../../../../db/schema";
import { addApprovalSigner } from "../../../../../lib/approval-signers";
import {
  approvalRevisionValues,
  planApprovalRevisions,
} from "../../../../../lib/approval-revision-store";
import { readBoundedJsonObject } from "../../../../../lib/bounded-json-request";
import { sha256Hex } from "../../../../../lib/canonical-json";
import { isMigrationWriteFrozen } from "../../../../../lib/migration-freeze";
import { authorizePublicLabAiRequest } from "../_lib/service-auth";

const PROJECT = "OriginMind × ARTS Robotics 联合研发项目";
const PRIVATE_JSON_HEADERS = { "cache-control": "private, no-store, max-age=0" };
const MAX_REQUEST_BYTES = 32 * 1024;
const CAMPUS_EMAIL = /^[a-z0-9._%+-]+@(?:stumail\.)?sztu\.edu\.cn$/u;
const AGREEMENT_VERSION = /^\d{4}-\d{2}-\d{2}-v[1-9]\d{0,5}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;

type AgreementClause = { title: string; text: string };
type NewbieAgreement = {
  version: string;
  title: string;
  effectiveDate: string;
  introduction: string;
  clauses: AgreementClause[];
  privacyNotice: string;
};

function response(data: unknown, status = 200, headers: HeadersInit = {}) {
  return Response.json(data, { status, headers: { ...PRIVATE_JSON_HEADERS, ...headers } });
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) return null;
  return record;
}

function boundedText(value: unknown, minimum: number, maximum: number) {
  if (typeof value !== "string" || !value.isWellFormed()) return null;
  const text = value.trim();
  return text.length >= minimum && text.length <= maximum ? text : null;
}

function parseAgreement(value: unknown): NewbieAgreement | null {
  const record = exactRecord(value, [
    "version",
    "title",
    "effectiveDate",
    "introduction",
    "clauses",
    "privacyNotice",
  ]);
  if (!record || !AGREEMENT_VERSION.test(String(record.version)) ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(String(record.effectiveDate)) ||
      !Array.isArray(record.clauses) || record.clauses.length < 1 || record.clauses.length > 20) {
    return null;
  }
  const title = boundedText(record.title, 2, 160);
  const introduction = boundedText(record.introduction, 2, 2_000);
  const privacyNotice = boundedText(record.privacyNotice, 2, 2_000);
  const clauses = record.clauses.map((value) => {
    const clause = exactRecord(value, ["title", "text"]);
    const clauseTitle = boundedText(clause?.title, 1, 160);
    const clauseText = boundedText(clause?.text, 2, 4_000);
    return clauseTitle && clauseText ? { title: clauseTitle, text: clauseText } : null;
  });
  if (!title || !introduction || !privacyNotice || clauses.some((clause) => clause === null)) return null;
  const effectiveDate = String(record.effectiveDate);
  const parsedDate = new Date(`${effectiveDate}T00:00:00.000Z`);
  if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== effectiveDate) return null;
  return {
    version: String(record.version),
    title,
    effectiveDate,
    introduction,
    clauses: clauses as AgreementClause[],
    privacyNotice,
  };
}

function agreementText(agreement: NewbieAgreement) {
  return [
    agreement.title,
    `协议版本：${agreement.version}`,
    `生效日期：${agreement.effectiveDate}`,
    agreement.introduction,
    ...agreement.clauses.flatMap((clause) => [clause.title, clause.text]),
    `隐私说明：${agreement.privacyNotice}`,
  ].join("\n");
}

function existingPayload(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export async function POST(request: Request): Promise<Response> {
  const { env } = await import("cloudflare:workers");
  const serviceEnv = env as typeof env & { PUBLIC_LAB_AI_SERVICE_TOKEN?: string };
  const authorization = authorizePublicLabAiRequest(request, serviceEnv.PUBLIC_LAB_AI_SERVICE_TOKEN);
  if (authorization === "unauthorized") return response({ error: "服务凭证无效。" }, 401);
  if (authorization === "not_configured") return response({ error: "新手村协议归档服务暂不可用。" }, 503);
  if (isMigrationWriteFrozen(serviceEnv as unknown as Record<string, unknown>)) {
    return response({ error: "OA 正在生成迁移快照，暂时无法归档新手村协议。" }, 503, { "retry-after": "300" });
  }
  if (new URL(request.url).search) return response({ error: "请求格式不正确。" }, 400);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return response({ error: "请求数据必须使用 JSON 格式。" }, 415);
  }

  const parsed = await readBoundedJsonObject(request, MAX_REQUEST_BYTES);
  if (!parsed.ok) {
    return response(
      { error: parsed.reason === "too_large" ? "新手村协议记录过大。" : "请求数据格式不正确。" },
      parsed.reason === "too_large" ? 413 : 400,
    );
  }
  const input = exactRecord(parsed.value, [
    "email",
    "signerName",
    "acceptedAt",
    "contentSha256",
    "agreement",
    "agreementText",
  ]);
  const email = boundedText(input?.email, 3, 254)?.toLowerCase() || "";
  const signerName = boundedText(input?.signerName, 2, 80) || "";
  const acceptedAt = boundedText(input?.acceptedAt, 20, 32) || "";
  const contentSha256 = boundedText(input?.contentSha256, 64, 64) || "";
  const suppliedAgreementText = boundedText(input?.agreementText, 10, 16_000) || "";
  const agreement = parseAgreement(input?.agreement);
  const acceptedTimestamp = Date.parse(acceptedAt);
  if (!input || !CAMPUS_EMAIL.test(email) || !signerName || !agreement ||
      !SHA256_HEX.test(contentSha256) || !Number.isFinite(acceptedTimestamp) ||
      acceptedTimestamp < Date.UTC(2020, 0, 1) || acceptedTimestamp > Date.now() + 5 * 60_000 ||
      acceptedAt !== new Date(acceptedTimestamp).toISOString() || suppliedAgreementText !== agreementText(agreement) ||
      contentSha256 !== await sha256Hex(JSON.stringify(agreement))) {
    return response({ error: "新手村协议记录校验失败。" }, 400);
  }

  const businessKey = `newbie-agreement|${email}|${agreement.version}|${contentSha256}`;
  const db = await getDb();
  const findExisting = async () => (await db.select().from(approvals)
    .where(eq(approvals.businessKey, businessKey)).limit(1))[0];
  const existing = await findExisting();
  if (existing) {
    const payload = existingPayload(existing.payloadJson);
    if (existing.type !== "保密协议" || existing.status !== "已归档" ||
        existing.requesterEmail.toLowerCase() !== email || payload.signerName !== signerName ||
        payload.contentSha256 !== contentSha256 || payload.agreementVersion !== agreement.version ||
        payload.sourceSystem !== "chat.omindos.ai/newbie-village") {
      return response({ error: "OA 中已有冲突的新手村协议记录，请联系管理员核查。" }, 409);
    }
    return response({ approval: { id: existing.id, status: existing.status }, idempotent: true });
  }

  const id = `newbie-${crypto.randomUUID()}`;
  const workflowMutationRevision = crypto.randomUUID();
  const archivedAt = acceptedAt;
  const payload = {
    agreementKind: "newbie",
    agreementVersion: agreement.version,
    agreementEffectiveDate: agreement.effectiveDate,
    agreementTextSnapshot: suppliedAgreementText,
    signerName,
    signerEmail: email,
    signedAt: acceptedAt,
    signatureMethod: "校园邮箱验证码认证 + 本人姓名确认",
    contentSha256,
    sourceSystem: "chat.omindos.ai/newbie-village",
    sourceRecordKey: businessKey,
    autoArchived: true,
    archivedAt,
    archivedBy: "新手村自动审核",
    archivedByEmail: "system@chat.omindos.ai",
    workflowMutationRevision,
  };
  const row: typeof approvals.$inferInsert = {
    id,
    type: "保密协议",
    title: `${agreement.title} · ${signerName}`,
    project: PROJECT,
    requesterName: signerName,
    requesterEmail: email,
    clientCreationKey: businessKey,
    businessKey,
    createdAt: acceptedAt,
    updatedAt: acceptedAt,
    status: "已归档",
    currentStep: "已归档",
    currentReviewerName: "",
    currentReviewerEmail: "",
    summary: "新手村保密协议已由已验证校园邮箱账户签署，并由系统自动审核归档。",
    owner: "系统自动审核",
    amount: null,
    periodKey: null,
    signersJson: addApprovalSigner("[]", { name: signerName, email, signedAt: acceptedAt }),
    payloadJson: JSON.stringify(payload),
    currentRevisionNo: 0,
    currentRevisionHash: null,
  };
  const event = {
    actorName: "新手村自动审核",
    actorEmail: "system@chat.omindos.ai",
    action: "auto_archived",
    note: "校园邮箱身份已验证；签署后自动审核通过，并由 Chat 服务同步归档。",
    occurredAt: archivedAt,
  };
  const revisionPlan = await planApprovalRevisions({
    nextApproval: row as unknown as Record<string, unknown>,
    workflowMutationRevision,
    event,
    shouldWrite: true,
  });
  row.currentRevisionNo = revisionPlan.currentRevisionNo;
  row.currentRevisionHash = revisionPlan.currentRevisionHash;

  try {
    const insertApproval = db.insert(approvals).values(row)
      .returning({ id: approvals.id, status: approvals.status });
    const insertRevisions = revisionPlan.revisions.map((revision) => db.insert(approvalRevisions)
      .values(approvalRevisionValues(id, revision))
      .returning({ revisionHash: approvalRevisions.revisionHash }));
    const insertEvent = db.insert(approvalEvents).values({
      approvalId: id,
      actorName: event.actorName,
      actorEmail: event.actorEmail,
      action: event.action,
      note: event.note,
      createdAt: archivedAt,
    }).returning({ id: approvalEvents.id });
    const results = await db.batch([insertApproval, ...insertRevisions, insertEvent]);
    const approvalRows = results[0] as Array<{ id: string; status: string }>;
    const revisionRows = results.slice(1, -1) as Array<Array<{ revisionHash: string }>>;
    const eventRows = results.at(-1) as Array<{ id: number }>;
    if (!approvalRows[0] || revisionRows.length !== revisionPlan.revisions.length ||
        revisionRows.some((rows) => !rows[0]) || !eventRows[0]) {
      return response({ error: "OA 未完整保存新手村协议的归档与审计记录。" }, 500);
    }
    return response({ approval: approvalRows[0], idempotent: false }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/approvals_(?:business_key|requester_creation)_unique|business_key|client_creation_key/iu.test(message)) {
      const concurrent = await findExisting();
      if (concurrent?.status === "已归档") {
        return response({ approval: { id: concurrent.id, status: concurrent.status }, idempotent: true });
      }
    }
    return response({ error: "OA 保存新手村协议失败，请稍后重试。" }, 500);
  }
}

type ArchiveEvent = {
  id?: number;
  actorName: string;
  actorEmail: string;
  action: string;
  note: string;
  createdAt: string;
};

type ArchiveApproval = {
  id: string;
  type: string;
  title: string;
  project: string;
  requesterName: string;
  requesterEmail: string;
  clientCreationKey?: string | null;
  businessKey?: string | null;
  createdAt: string;
  updatedAt: string;
  status: string;
  currentStep: string;
  currentReviewerName?: string;
  currentReviewerEmail?: string;
  summary: string;
  owner: string;
  amount: string | null;
  periodKey?: string | null;
  signersJson: string;
  payloadJson: string;
  currentRevisionNo?: number;
  currentRevisionHash?: string | null;
};

type ArchiveRevision = ApprovalRevision & {
  approvalId: string;
  mutationRevision: string;
  createdAt: string;
};

function parseJson(value: string, fallback: unknown): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return fallback;
  }
}

function parseJsonObject(value: string) {
  const parsed = parseJson(value, {});
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function parseJsonArray(value: string) {
  const parsed = parseJson(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function markdownText(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[\p{Cf}\u2028\u2029]/gu, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/([\\`*_{}[\]<>#+|])/g, "\\$1")
    .replace(/(^|\n)(\s*)([-+>]|\d+\.)\s/g, "$1$2\\$3 ");
}

async function sha256Bytes(value: BufferSource) {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signatureEvidence(payload: Record<string, unknown>) {
  const signature = typeof payload.signatureDataUrl === "string" ? payload.signatureDataUrl : "";
  if (!signature) return null;
  const evidence: Record<string, unknown> = {
    format: signature.startsWith("data:image/png;base64,") ? "image/png" : "unknown",
    encoding: "data-url",
    dataUrlByteLength: new TextEncoder().encode(signature).byteLength,
    dataUrlSha256: await sha256Hex(signature),
  };
  const encoded = signature.startsWith("data:image/png;base64,") ? signature.slice("data:image/png;base64,".length) : "";
  if (encoded) {
    try {
      const decoded = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      evidence.pngByteLength = decoded.byteLength;
      evidence.pngSha256 = await sha256Bytes(decoded);
    } catch {
      evidence.decoded = false;
    }
  }
  return evidence;
}

function indentedJson(value: unknown) {
  return JSON.stringify(value, null, 2).split("\n").map((line) => `    ${line}`).join("\n");
}

function revisionStateProjection(approval: ArchiveApproval) {
  return Object.fromEntries(Object.entries(approval as Record<string, unknown>).filter(([key]) => !["currentRevisionNo", "currentRevisionHash", "current_revision_no", "current_revision_hash"].includes(key)));
}

export async function buildArchiveManifest(approval: ArchiveApproval, events: ArchiveEvent[], revisions: ArchiveRevision[] = []) {
  const payload = parseJsonObject(approval.payloadJson);
  const signers = parseJsonArray(approval.signersJson);
  const sortedEvents = [...events].sort((left, right) => left.createdAt.localeCompare(right.createdAt)
    || (left.id ?? 0) - (right.id ?? 0)
    || left.action.localeCompare(right.action)
    || left.actorEmail.localeCompare(right.actorEmail));
  const sortedRevisions = [...revisions].sort((left, right) => left.revisionNo - right.revisionNo);
  const revisionBacked = (approval.currentRevisionNo ?? 0) > 0;
  if (revisionBacked) {
    const verification = await inspectRevisionChain(sortedRevisions);
    if (!verification.valid) throw new Error(`审批修订链校验失败：${verification.reason}`);
    const terminal = sortedRevisions.at(-1);
    if (!terminal || terminal.approvalId !== approval.id || terminal.revisionNo !== approval.currentRevisionNo || terminal.revisionHash !== approval.currentRevisionHash) throw new Error("审批终局修订指针不一致。");
    if (sortedRevisions.some((revision) => revision.approvalId !== approval.id)) throw new Error("审批修订链包含其他申请记录。");
    const projectedStateJson = canonicalJson(revisionStateProjection(approval));
    if (projectedStateJson !== terminal.stateJson || await sha256Hex(projectedStateJson) !== terminal.stateHash) throw new Error("审批当前投影与终局修订材料不一致。");
  } else if (revisions.length) {
    throw new Error("历史审批修订指针为空但存在修订记录。");
  }
  const terminalRevision = sortedRevisions.at(-1);
  const schemaVersion = revisionBacked ? 2 : 1;
  const revisionSummaries = sortedRevisions.map((revision) => {
    const eventRecord = parseJsonObject(revision.eventJson);
    return {
      revisionNo: revision.revisionNo,
      previousRevisionHash: revision.previousRevisionHash,
      revisionHash: revision.revisionHash,
      stateHash: revision.stateHash,
      mutationRevision: revision.mutationRevision,
      createdAt: revision.createdAt,
      event: eventRecord.event ?? null,
    };
  });
  const immutableRecord = {
    schemaVersion,
    terminalRevisionNo: terminalRevision?.revisionNo ?? null,
    terminalRevisionHash: terminalRevision?.revisionHash ?? null,
    terminalStateHash: terminalRevision?.stateHash ?? null,
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
      summary: approval.summary,
      owner: approval.owner,
      amount: approval.amount,
      signers,
      payload,
    },
    events: sortedEvents.map((event) => ({
      id: event.id ?? null,
      actorName: event.actorName,
      actorEmail: event.actorEmail,
      action: event.action,
      note: event.note,
      createdAt: event.createdAt,
    })),
    revisions: revisionSummaries,
  };
  const canonical = canonicalJson(immutableRecord);
  const evidenceRecordHash = await sha256Hex(canonical);
  const evidence = await signatureEvidence(payload);
  const displayPayload = { ...payload };
  if ("signatureDataUrl" in displayPayload) {
    displayPayload.signatureDataUrl = evidence ? { redacted: true, ...evidence } : null;
  }
  const archiveRecord = {
    ...immutableRecord,
    approval: { ...immutableRecord.approval, payload: displayPayload },
    evidenceRecordHash,
  };
  const archiveCanonical = canonicalJson(archiveRecord);
  const hash = await sha256Hex(archiveCanonical);
  const markdown = [
    `# ${markdownText(approval.title)}`,
    "",
    `- 归档编号：${markdownText(approval.id)}`,
    `- 申请类型：${markdownText(approval.type)}`,
    `- 联合项目：${markdownText(approval.project)}`,
    `- 申请人：${markdownText(approval.requesterName)}（${markdownText(approval.requesterEmail)}）`,
    `- 创建时间：${markdownText(approval.createdAt)}`,
    `- 归档时间：${markdownText(approval.updatedAt)}`,
    `- 状态：${markdownText(approval.status)} / ${markdownText(approval.currentStep)}`,
    `- 金额：${markdownText(approval.amount || "不适用")}`,
    `- 脱敏归档校验值（SHA-256）：${hash}`,
    `- 原始证据记录校验值（SHA-256）：${evidenceRecordHash}`,
    `- 证据模式：${revisionBacked ? "不可变材料修订链 v2" : "历史基线归档 v1"}`,
    ...(terminalRevision ? [`- 终局材料版本：第 ${terminalRevision.revisionNo} 版`, `- 终局修订 SHA-256：${terminalRevision.revisionHash}`, `- 终局材料 SHA-256：${terminalRevision.stateHash}`] : []),
    "",
    "## 事项摘要",
    "",
    markdownText(approval.summary || "无"),
    "",
    "## 申请数据",
    "",
    indentedJson(displayPayload),
    "",
    "## 签署与流转记录",
    "",
    ...sortedEvents.flatMap((event) => [
      `### ${markdownText(event.createdAt)} · ${markdownText(event.action)}`,
      "",
      `- 操作人：${markdownText(event.actorName)}（${markdownText(event.actorEmail)}）`,
      `- 记录：${markdownText(event.note || "无")}`,
      "",
    ]),
    ...(revisionBacked ? [
      "## 不可变材料版本链",
      "",
      ...revisionSummaries.flatMap((revision) => [
        `### 第 ${revision.revisionNo} 版 · ${markdownText(revision.createdAt)}`,
        "",
        `- 修订 SHA-256：${revision.revisionHash}`,
        `- 材料 SHA-256：${revision.stateHash}`,
        `- 上一版 SHA-256：${revision.previousRevisionHash || "无（首版）"}`,
        "",
      ]),
    ] : []),
    "## 脱敏归档记录（校验原文）",
    "",
    "以下规范化 JSON 是本归档的权威数据，可用于独立复算本文件顶部的脱敏归档校验值。原始签名只公开 data URL 与解码 PNG 的长度及 SHA-256；含原始签名的证据记录由 OA 限权保存。",
    "",
    indentedJson(JSON.parse(archiveCanonical)),
    "",
    "---",
    "本文件由 OriginMind × ARTS Robotics 联合研发 OA 生成。脱敏归档校验值可由上方规范化 JSON 独立复算；原始证据记录校验值对应 OA 内受限保存的完整签名证据。",
    "",
  ].join("\n");
  const fileHash = await sha256Hex(markdown);
  return { schemaVersion, hash, fileHash, canonical, archiveCanonical, evidenceRecordHash, markdown, signatureEvidence: evidence, terminalRevisionNo: terminalRevision?.revisionNo ?? null, terminalRevisionHash: terminalRevision?.revisionHash ?? null, terminalStateHash: terminalRevision?.stateHash ?? null };
}

export function safeArchiveFileName(approval: Pick<ArchiveApproval, "id" | "title">, hash: string) {
  const id = approval.id.normalize("NFKC").replace(/[\p{Cf}\u2028\u2029]/gu, "").replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 64) || "approval";
  const title = approval.title.normalize("NFKC").replace(/[\p{Cf}\u2028\u2029]/gu, "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "审批归档";
  return `${id}-${title}-${hash.slice(0, 12)}.md`;
}
import { inspectRevisionChain, type ApprovalRevision } from "./approval-revisions";
import { canonicalJson, sha256Hex } from "./canonical-json";

export { canonicalJson, sha256Hex } from "./canonical-json";

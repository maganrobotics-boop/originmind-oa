import {
  buildNdaAgreementText,
  buildNdaAgreementTextForVersion,
  confidentialityAgreementVersion,
  confidentialityAgreementVersions,
  type ConfidentialityAgreementKind,
} from "./nda-agreement";
import { circulationPeople, isCirculationParticipant } from "./circulation-policy";

const SIGNATURE_CANVAS_WIDTH = 900;
const SIGNATURE_CANVAS_HEIGHT = 260;
const STANDARD_SRGB_CHRM = [31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000] as const;
const STANDARD_RGBA_SBIT = [8, 8, 8, 8] as const;

export const APPROVAL_TYPES = ["技术审核", "采购审核", "保密协议", "劳务报酬", "流转审批"] as const;
export type ApprovalType = typeof APPROVAL_TYPES[number];

export const APPROVAL_ACTIONS = ["approve", "return", "force_return", "confirm_developer", "confirm_purchase", "confirm_circulation", "resubmit", "withdraw", "void", "archive_note"] as const;
export type ApprovalAction = typeof APPROVAL_ACTIONS[number];

export type TechnicalDeveloper = {
  memberId: string;
  email: string;
  name: string;
  work: string;
  ratio: number;
  ratioBasisPoints: number;
};

export type DeveloperConfirmation = {
  memberId: string;
  email: string;
  name: string;
  confirmedAt: string;
};

type ActiveMember = {
  id: string;
  fullName: string;
  chatgptAccount: string;
  status: string;
};

type ApprovalAccessRecord = {
  type: string;
  status?: string;
  requesterEmail: string;
  currentReviewerEmail: string;
  payloadJson: string;
};

const WORKFLOW_ACTIONS: Record<ApprovalType, Record<string, readonly ApprovalAction[]>> = {
  流转审批: {
    流转确认: ["confirm_circulation", "return"],
    指定审批: ["approve", "return"],
    补充材料: ["resubmit"],
  },
  技术审核: {
    开发人确认: ["confirm_developer"],
    技术顾问: ["approve", "return"],
    项目负责人: ["approve", "return"],
    补充材料: ["resubmit"],
  },
  采购审核: {
    技术顾问: ["approve", "return"],
    项目负责人: ["approve", "return"],
    统一采购: ["confirm_purchase", "return"],
    补充材料: ["resubmit"],
  },
  保密协议: {
    项目负责人: ["approve", "return"],
    OA管理员: ["approve", "return"],
    // A returned NDA must go through the material-edit POST path so the signer
    // supplies a fresh handwritten signature and receives a new signedAt value.
    补充材料: [],
  },
  劳务报酬: {
    项目负责人: ["approve", "return"],
    经费负责人: ["approve", "return"],
    补充材料: ["resubmit"],
  },
};

export function textValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeEmail(value: unknown) {
  return textValue(value).toLowerCase();
}

export function hasDistinctVerifiedEmails(...values: unknown[]) {
  const emails = values.map(normalizeEmail);
  return emails.every(Boolean) && new Set(emails).size === emails.length;
}

export function workflowRevisionsNeededAfterMaterial(type: ApprovalType, payload: Record<string, unknown>) {
  if (type === "流转审批") return circulationPeople(payload.circulationRecipients).length + circulationPeople(payload.circulationApprovers).length;
  if (type === "技术审核") return (Array.isArray(payload.developers) ? payload.developers.length : 0) + 2;
  if (type === "采购审核") return 3;
  if (type === "保密协议") return payload.autoArchived === true ? 0 : 1;
  return 2;
}

export function asNumber(value: unknown) {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? number : NaN;
}

export function round(value: number, digits = 2) {
  return Number(value.toFixed(digits));
}

export function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function isApprovalType(value: string): value is ApprovalType {
  return APPROVAL_TYPES.includes(value as ApprovalType);
}

export function isApprovalAction(value: string): value is ApprovalAction {
  return APPROVAL_ACTIONS.includes(value as ApprovalAction);
}

export function workflowAllows(type: string, step: string, action: ApprovalAction, status: string) {
  if (!isApprovalType(type)) return false;
  if (action === "withdraw") return ["待审核", "审批中", "已退回"].includes(status);
  if (action === "void") return status === "草稿" || status === "已撤回";
  if (action === "archive_note") return status === "已归档";
  if (action === "resubmit") {
    const applicantEditing = (status === "已退回" && step === "补充材料") || (status === "已撤回" && step === "申请人修改");
    return applicantEditing && type !== "保密协议" && WORKFLOW_ACTIONS[type].补充材料?.includes(action) === true;
  }
  if (action === "force_return") return (status === "待审核" || status === "审批中") && !["草稿", "补充材料", "已归档"].includes(step);
  if (status !== "待审核" && status !== "审批中") return false;
  return WORKFLOW_ACTIONS[type][step]?.includes(action) === true;
}

export function nextWorkflowStep(type: ApprovalType, step: string, action: Exclude<ApprovalAction, "resubmit" | "withdraw" | "void" | "archive_note">) {
  if (action === "force_return") return workflowAllows(type, step, action, "审批中") ? "补充材料" : null;
  if (!workflowAllows(type, step, action, action === "return" ? "审批中" : "待审核")) return null;
  if (action === "return") return "补充材料";
  if (type === "流转审批") return step === "流转确认" ? "指定审批" : step === "指定审批" ? "已归档" : null;
  if (type === "技术审核") {
    if (step === "开发人确认") return "技术顾问";
    if (step === "技术顾问") return "项目负责人";
    if (step === "项目负责人") return "已归档";
  }
  if (type === "采购审核") {
    if (step === "技术顾问" && action === "approve") return "项目负责人";
    if (step === "项目负责人" && action === "approve") return "统一采购";
    if (step === "统一采购" && action === "confirm_purchase") return "已归档";
    return null;
  }
  if (type === "保密协议") return step === "项目负责人" || step === "OA管理员" ? "已归档" : null;
  if (type === "劳务报酬") return step === "项目负责人" ? "经费负责人" : step === "经费负责人" ? "已归档" : null;
  return null;
}

export function holdsLaborReservation(status: string) {
  return status !== "草稿" && status !== "已作废";
}

export function hasCompletedNda(authorized: { ndaCompleted?: boolean; isAdmin: boolean }) {
  return authorized.ndaCompleted === true;
}

export function normalizeTechnicalDevelopers(raw: unknown, activeMembers: ActiveMember[]): { developers?: TechnicalDeveloper[]; error?: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "请至少填写一名开发人及其贡献占比。" };
  if (raw.length > 50) return { error: "单份技术审核最多填写 50 名开发人。" };
  const membersById = new Map(activeMembers.filter((member) => member.status === "active").map((member) => [member.id, member]));
  const memberIds = new Set<string>();
  const emails = new Set<string>();
  const developers: TechnicalDeveloper[] = [];

  for (const item of raw) {
    const developer = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const memberId = textValue(developer.memberId);
    const email = normalizeEmail(developer.email);
    const name = textValue(developer.name);
    const work = textValue(developer.work);
    const ratio = asNumber(developer.ratio);
    if (!memberId || !email || !name || !work || !Number.isFinite(ratio)) return { error: "每位技术开发人都必须填写成员、姓名、邮箱、实际工作和贡献占比。" };
    if (work.length > 2000) return { error: `${name} 的实际工作说明不能超过 2000 字。` };
    const member = membersById.get(memberId);
    if (!member || normalizeEmail(member.chatgptAccount) !== email || textValue(member.fullName) !== name) return { error: `${name || email} 不是当前有效成员，或成员身份信息不一致。` };
    if (memberIds.has(memberId) || emails.has(email)) return { error: `技术开发人 ${name} 重复，请每人只填写一次。` };
    const scaledRatio = ratio * 100;
    const ratioBasisPoints = Math.round(scaledRatio);
    if (ratio < 0 || ratio > 100 || Math.abs(scaledRatio - ratioBasisPoints) > 1e-6) return { error: `${name} 的贡献占比必须为 0% 至 100%，且最多保留两位小数。` };
    memberIds.add(memberId);
    emails.add(email);
    developers.push({ memberId, email, name: member.fullName.trim(), work, ratio: ratioBasisPoints / 100, ratioBasisPoints });
  }

  const totalBasisPoints = developers.reduce((sum, developer) => sum + developer.ratioBasisPoints, 0);
  if (totalBasisPoints !== 10000) return { error: `开发人贡献占比合计必须精确为 100%，当前为 ${(totalBasisPoints / 100).toFixed(2)}%。` };
  return { developers };
}

export function parseDeveloperConfirmations(value: unknown): DeveloperConfirmation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const confirmation = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const memberId = textValue(confirmation.memberId);
    const email = normalizeEmail(confirmation.email);
    const name = textValue(confirmation.name);
    const confirmedAt = textValue(confirmation.confirmedAt);
    return memberId && email && name && !Number.isNaN(Date.parse(confirmedAt)) ? [{ memberId, email, name, confirmedAt }] : [];
  });
}

export function getPendingDeveloper(developers: TechnicalDeveloper[], rawConfirmations: unknown) {
  const confirmations = parseDeveloperConfirmations(rawConfirmations);
  if (confirmations.length > developers.length) return { error: "开发人确认记录数量异常，请联系管理员。" };
  for (let index = 0; index < confirmations.length; index += 1) {
    const developer = developers[index];
    const confirmation = confirmations[index];
    if (developer.memberId !== confirmation.memberId || developer.email !== confirmation.email || developer.name !== confirmation.name) return { error: "开发人确认顺序或身份记录异常，请联系管理员。" };
  }
  return { confirmations, pendingDeveloper: developers[confirmations.length], pendingIndex: confirmations.length };
}

export function isTechnicalDeveloper(payload: Record<string, unknown>, email: string) {
  if (!Array.isArray(payload.developers)) return false;
  const normalizedEmail = normalizeEmail(email);
  return payload.developers.some((item) => item && typeof item === "object" && !Array.isArray(item) && normalizeEmail((item as Record<string, unknown>).email) === normalizedEmail);
}

export function isApprovalRelated(row: ApprovalAccessRecord, email: string, historicalActorEmails: ReadonlySet<string>) {
  const normalizedEmail = normalizeEmail(email);
  return normalizeEmail(row.requesterEmail) === normalizedEmail
    || normalizeEmail(row.currentReviewerEmail) === normalizedEmail
    || historicalActorEmails.has(normalizedEmail)
    || (row.type === "流转审批" && row.status !== "草稿" && isCirculationParticipant(parseJsonObject(row.payloadJson), normalizedEmail))
    || (row.type === "技术审核" && isTechnicalDeveloper(parseJsonObject(row.payloadJson), normalizedEmail));
}

export function isValidLaborMonth(month: string) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
}

export function monthKeyInShanghai(value: Date | string = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return year && month ? `${year}-${month}` : "";
}

export function validatePngSignatureDataUrl(value: string) {
  const prefix = "data:image/png;base64,";
  if (!value.startsWith(prefix) || value.length > 100000) return "请使用 PNG 格式且不超过 100KB 的本人手写签名。";
  const encoded = value.slice(prefix.length);
  if (encoded.length < 128 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || !encoded.startsWith("iVBORw0KGgo")) return "手写签名数据无效，请清空后重新签署。";
  try {
    const bytes = atob(encoded);
    if (bytes.length < 96 || bytes.charCodeAt(0) !== 0x89 || bytes.slice(1, 4) !== "PNG") return "手写签名不是有效的 PNG 图片。";
    if (bytes.slice(12, 16) !== "IHDR") return "手写签名缺少有效的 PNG 图像头。";
    const dimension = (offset: number) => ((bytes.charCodeAt(offset) << 24) >>> 0) + (bytes.charCodeAt(offset + 1) << 16) + (bytes.charCodeAt(offset + 2) << 8) + bytes.charCodeAt(offset + 3);
    const width = dimension(16);
    const height = dimension(20);
    if (width !== SIGNATURE_CANVAS_WIDTH || height !== SIGNATURE_CANVAS_HEIGHT) return "手写签名图片尺寸无效，请清空后重新签署。";
  } catch {
    return "手写签名数据无法读取，请清空后重新签署。";
  }
  return null;
}

function pngUint32(bytes: Uint8Array, offset: number) {
  return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}

function pngCrc32(bytes: Uint8Array, start: number, end: number) {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function paethPredictor(left: number, above: number, upperLeft: number) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance ? left : aboveDistance <= upperLeftDistance ? above : upperLeft;
}

async function inflatePngBounded(compressed: Uint8Array, expectedLength: number) {
  const compressedBuffer = new ArrayBuffer(compressed.byteLength);
  new Uint8Array(compressedBuffer).set(compressed);
  const reader = new Blob([compressedBuffer]).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalLength += value.byteLength;
      if (totalLength > expectedLength) {
        await reader.cancel("PNG decompressed data exceeds the declared dimensions");
        throw new Error("PNG decompressed data exceeds the declared dimensions");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (totalLength !== expectedLength) throw new Error("PNG decompressed data length does not match the declared dimensions");
  const output = new Uint8Array(totalLength);
  let outputOffset = 0;
  for (const chunk of chunks) {
    output.set(chunk, outputOffset);
    outputOffset += chunk.byteLength;
  }
  return output;
}

export async function validatePngSignatureInk(value: string) {
  const prefix = "data:image/png;base64,";
  const structuralError = validatePngSignatureDataUrl(value);
  if (structuralError) return structuralError;
  try {
    const encoded = value.slice(prefix.length);
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    let offset = 8;
    let width = 0;
    let height = 0;
    let colorType = -1;
    let bitDepth = -1;
    let interlace = -1;
    let seenIhdr = false;
    let seenIdat = false;
    let idatEnded = false;
    let seenIend = false;
    let seenSrgb = false;
    let seenGamma = false;
    let seenChromaticity = false;
    let seenSignificantBits = false;
    let seenPhysicalResolution = false;
    let seenModifiedTime = false;
    const idatChunks: Uint8Array[] = [];
    while (offset + 12 <= bytes.length) {
      const length = pngUint32(bytes, offset);
      const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
      if (!/^[A-Za-z]{4}$/.test(type)) return "手写签名 PNG 数据块类型无效，请重新签署。";
      const dataStart = offset + 8;
      const dataEnd = dataStart + length;
      if (dataEnd + 4 > bytes.length) return "手写签名 PNG 结构不完整，请重新签署。";
      if (pngUint32(bytes, dataEnd) !== pngCrc32(bytes, offset + 4, dataEnd)) return "手写签名 PNG 数据校验失败，请重新签署。";
      const data = bytes.slice(dataStart, dataEnd);
      if (type === "IHDR") {
        if (seenIhdr || length !== 13 || offset !== 8) return "手写签名 PNG 图像头无效，请重新签署。";
        seenIhdr = true;
        width = pngUint32(data, 0);
        height = pngUint32(data, 4);
        bitDepth = data[8];
        colorType = data[9];
        if (data[10] !== 0 || data[11] !== 0) return "手写签名 PNG 压缩或滤镜方式无效，请重新签署。";
        interlace = data[12];
      } else if (type === "IDAT") {
        if (!seenIhdr || idatEnded) return "手写签名 PNG 像素数据顺序无效，请重新签署。";
        seenIdat = true;
        idatChunks.push(data);
      } else if (type === "sRGB") {
        if (seenSrgb || seenIdat || length !== 1 || data[0] > 3) return "手写签名 PNG 的 sRGB 配置无效，请重新签署。";
        seenSrgb = true;
      } else if (type === "gAMA") {
        if (seenGamma || seenIdat || length !== 4 || pngUint32(data, 0) !== 45455) return "手写签名 PNG 的标准色彩配置无效，请重新签署。";
        seenGamma = true;
      } else if (type === "cHRM") {
        if (seenChromaticity || seenIdat || length !== 32 || STANDARD_SRGB_CHRM.some((expected, index) => pngUint32(data, index * 4) !== expected)) return "手写签名 PNG 的标准色彩配置无效，请重新签署。";
        seenChromaticity = true;
      } else if (type === "sBIT") {
        // Android Skia canvas exports declare every RGBA8888 channel as 8 significant bits.
        if (!seenIhdr || seenSignificantBits || seenIdat || colorType !== 6 || bitDepth !== 8 || length !== 4 || STANDARD_RGBA_SBIT.some((expected, index) => data[index] !== expected)) return "手写签名 PNG 的有效位配置无效，请重新签署。";
        seenSignificantBits = true;
      } else if (["tRNS", "iCCP", "PLTE", "bKGD", "acTL", "fcTL", "fdAT"].includes(type)) {
        return "手写签名 PNG 含有不受支持的显示或透明度配置，请重新签署。";
      } else if (type === "pHYs") {
        if (seenPhysicalResolution || seenIdat || length !== 9 || pngUint32(data, 0) !== 3780 || pngUint32(data, 4) !== 3780 || data[8] !== 1) return "手写签名 PNG 的分辨率配置无效，请重新签署。";
        seenPhysicalResolution = true;
      } else if (type === "tIME") {
        const year = length === 7 ? (data[0] << 8) + data[1] : 0;
        if (seenModifiedTime || length !== 7 || !year || data[2] < 1 || data[2] > 12 || data[3] < 1 || data[3] > 31 || data[4] > 23 || data[5] > 59 || data[6] > 60) return "手写签名 PNG 的时间数据无效，请重新签署。";
        seenModifiedTime = true;
      } else if (type === "IEND") {
        if (length !== 0 || dataEnd + 4 !== bytes.length) return "手写签名 PNG 结束标记无效，请重新签署。";
        seenIend = true;
        break;
      } else if ((bytes[offset + 4] & 0x20) === 0) {
        return "手写签名 PNG 含有未知的关键数据块，请重新签署。";
      } else {
        return "手写签名 PNG 含有不受支持的附加数据块，请重新签署。";
      }
      if (seenIdat && type !== "IDAT") idatEnded = true;
      offset = dataEnd + 4;
    }
    // Browser canvas signatures are RGBA. Restricting evidence to that one
    // fully implemented representation avoids hidden tRNS/palette semantics.
    const bytesPerPixel = colorType === 6 ? 4 : 0;
    if (!seenIhdr || !seenIdat || !seenIend || width !== SIGNATURE_CANVAS_WIDTH || height !== SIGNATURE_CANVAS_HEIGHT || bitDepth !== 8 || interlace !== 0 || !bytesPerPixel || !idatChunks.length) return "手写签名 PNG 编码不受支持，请清空后重新签署。";
    const compressedLength = idatChunks.reduce((total, chunk) => total + chunk.length, 0);
    const compressed = new Uint8Array(compressedLength);
    let compressedOffset = 0;
    for (const chunk of idatChunks) {
      compressed.set(chunk, compressedOffset);
      compressedOffset += chunk.length;
    }
    const stride = width * bytesPerPixel;
    const filtered = await inflatePngBounded(compressed, (stride + 1) * height);
    const pixels = new Uint8Array(stride * height);
    let sourceOffset = 0;
    for (let y = 0; y < height; y += 1) {
      const filter = filtered[sourceOffset];
      sourceOffset += 1;
      if (filter > 4) return "手写签名 PNG 滤镜数据无效，请重新签署。";
      for (let x = 0; x < stride; x += 1) {
        const raw = filtered[sourceOffset + x];
        const target = y * stride + x;
        const left = x >= bytesPerPixel ? pixels[target - bytesPerPixel] : 0;
        const above = y > 0 ? pixels[target - stride] : 0;
        const upperLeft = y > 0 && x >= bytesPerPixel ? pixels[target - stride - bytesPerPixel] : 0;
        pixels[target] = filter === 0 ? raw
          : filter === 1 ? (raw + left) & 0xff
            : filter === 2 ? (raw + above) & 0xff
              : filter === 3 ? (raw + Math.floor((left + above) / 2)) & 0xff
                : (raw + paethPredictor(left, above, upperLeft)) & 0xff;
      }
      sourceOffset += stride;
    }
    let inkPixels = 0;
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * bytesPerPixel;
        const red = pixels[index];
        const green = pixels[index + 1];
        const blue = pixels[index + 2];
        const alpha = pixels[index + 3];
        const compositedRed = Math.round((red * alpha + 255 * (255 - alpha)) / 255);
        const compositedGreen = Math.round((green * alpha + 255 * (255 - alpha)) / 255);
        const compositedBlue = Math.round((blue * alpha + 255 * (255 - alpha)) / 255);
        if (alpha >= 64 && compositedRed + compositedGreen + compositedBlue < 660) {
          inkPixels += 1;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
    }
    if (inkPixels < 180 || maxX - minX + 1 < 40 || maxY - minY + 1 < 12) return "手写签名未检测到足够的有效笔迹，请清空后完整签署。";
    return null;
  } catch {
    return "手写签名像素无法验证，请清空后重新签署。";
  }
}

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function isReusedReturnedNdaSignature(previousSignatureDataUrl: unknown, nextSignatureDataUrl: unknown): boolean {
  const previous = textValue(previousSignatureDataUrl);
  const next = textValue(nextSignatureDataUrl);
  return Boolean(previous && next && previous === next);
}

export async function createNdaIntegrityRecord(input: { signerName: string; signerEmail: string; signerAccountUserId: string; confidentialScope: string; signatureDataUrl: string; signedAt: string; agreementKind?: ConfidentialityAgreementKind; agreementVersion?: string }) {
  const agreementKind = input.agreementKind ?? "member";
  const agreementVersion = input.agreementVersion ?? confidentialityAgreementVersion(agreementKind);
  if (!confidentialityAgreementVersions(agreementKind).includes(agreementVersion)) throw new TypeError("NDA agreement version is invalid");
  const agreementTextSnapshot = input.agreementVersion
    ? buildNdaAgreementTextForVersion(input.signerName, input.confidentialScope, agreementKind, agreementVersion)
    : buildNdaAgreementText(input.signerName, input.confidentialScope, agreementKind);
  const agreementHash = await sha256Hex(agreementTextSnapshot);
  const signatureHash = await sha256Hex(input.signatureDataUrl);
  const recordHash = await sha256Hex(JSON.stringify({ agreementVersion, agreementHash, signatureHash, signerName: input.signerName, signerEmail: normalizeEmail(input.signerEmail), signerAccountUserId: input.signerAccountUserId, signedAt: input.signedAt }));
  return { agreementTextSnapshot, agreementHash, signatureHash, recordHash };
}

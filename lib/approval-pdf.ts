import { buildNdaAgreementTextForVersion, confidentialityAgreementKindFromPayload } from "./nda-agreement";
import {
  PDF_EMBEDDED_FONT_CID_MAP_COMPRESSED_BASE64,
  PDF_EMBEDDED_FONT_COMPRESSED_BASE64,
  PDF_EMBEDDED_FONT_LENGTH,
  PDF_EMBEDDED_FONT_NAME,
  PDF_EMBEDDED_FONT_SUPPORTED_BITS_BASE64,
} from "./pdf-font-data";

export type ApprovalPdfEvent = {
  id?: number;
  actorName: string;
  actorEmail: string;
  action: string;
  note: string;
  createdAt: string;
};

export type ApprovalPdfRecord = {
  id: string;
  type: string;
  title: string;
  project: string;
  requesterName: string;
  requesterEmail: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  currentStep: string;
  currentReviewerName?: string;
  currentReviewerEmail?: string;
  summary: string;
  owner: string;
  amount: string | null;
  signers: string[];
  payload: Record<string, unknown>;
};

export type ApprovalPdfIntegrity = {
  archiveHash: string;
  evidenceRecordHash: string;
  schemaVersion: number;
  terminalRevisionNo: number | null;
  terminalRevisionHash: string | null;
  terminalStateHash: string | null;
};

export type ApprovalPdfInput = {
  approval: ApprovalPdfRecord;
  events: ApprovalPdfEvent[];
  integrity?: ApprovalPdfIntegrity | null;
};

type TextItem = {
  kind: "text";
  text: string;
  size: number;
  color: [number, number, number];
  indent?: number;
  gapAfter?: number;
  leading?: number;
  section?: boolean;
};

type ImageItem = { kind: "signature"; gapAfter?: number };
type LayoutItem = TextItem | ImageItem;
type SignatureImage = { width: number; height: number; compressedRgb: Uint8Array };

const encoder = new TextEncoder();
const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const PAGE_LEFT = 48;
const PAGE_RIGHT = 48;
const PAGE_TOP = 790;
const PAGE_BOTTOM = 58;
let embeddedFontCompressedCache: Uint8Array | undefined;
let embeddedFontCidMapCompressedCache: Uint8Array | undefined;
let embeddedFontSupportedBitsCache: Uint8Array | undefined;

const FIELD_LABELS: Record<string, string> = {
  circulationContent: "流转事项内容",
  circulationRecipients: "流转对象",
  circulationApprovers: "指定审批人",
  circulationConfirmations: "流转确认记录",
  circulationApprovals: "审批记录",
  agreementKind: "协议类别",
  agreementVersion: "协议版本",
  archivedAt: "归档时间",
  archivedBy: "归档操作人",
  archivedContributionHours: "已归档成果折算工时",
  claimantMemberId: "申报成员编号",
  compensationBasis: "金额依据",
  confidentialScope: "保密范围",
  developerConfirmations: "开发人确认",
  developers: "开发人员及贡献",
  finalAmount: "最终审核金额",
  finalAmountAt: "最终审核时间",
  finalAmountBy: "最终审核人",
  financeNote: "经费审核意见",
  initialReviewerEmail: "初审人账号",
  itemSpec: "物品与规格",
  laborClaimRevision: "劳务占用版本",
  lastResubmissionNote: "最近补充说明",
  lastResubmittedAt: "最近重提时间",
  month: "所属月份",
  monthlyStatement: "本月工作与贡献陈述",
  monthlyWorkHours: "本月其他工时",
  monthlyWorkHoursDefinition: "工时口径",
  otherMonthlyWorkHours: "本月其他工时",
  purchaseLink: "采购链接",
  purchaseNote: "实际采购说明",
  purchaserAssignedAt: "采购人指定时间",
  purchaserAssignedBy: "采购人指定者",
  purchaserEmail: "采购人账号",
  purchaserMemberId: "采购人成员编号",
  purchaserName: "采购人",
  purpose: "用途",
  quantity: "数量",
  robotPart: "机器人技术模块",
  selectedSources: "已选技术成果",
  signedAt: "签署时间",
  signerAccountUserId: "签署账户主体",
  signerEmail: "签署账号",
  signerName: "签署人",
  sourceApprovalIds: "技术成果编号",
  suggestedAmount: "建议金额",
  suggestedPurchaserEmail: "建议采购人账号",
  suggestedPurchaserMemberId: "建议采购人成员编号",
  suggestedPurchaserName: "建议采购人",
  supplier: "供应商",
  technicalContent: "技术内容",
  totalScore: "核算总工时",
  totalWorkHours: "总工时",
  workflowMutationRevision: "流程写入版本",
};

const OMITTED_PAYLOAD_FIELDS = new Set(["signatureDataUrl", "previewed", "agreed", "autoArchived"]);

export function approvalEventActionLabel(action: string) {
  return action === "confirm_circulation" ? "流转确认" : action === "submitted" ? "提交"
    : action === "auto_archived" ? "系统自动归档"
      : action === "draft_saved" ? "保存草稿"
        : action === "confirm_developer" ? "开发人确认"
          : action === "confirm_purchase" ? "采购完成确认"
            : action === "approve" ? "审核通过"
              : action === "return" ? "退回补充"
                : action === "force_return" ? "管理员强制退回"
                  : action === "resubmit" ? "重新提交"
                    : action === "withdraw" ? "申请人撤回"
                      : action === "void" ? "申请作废"
                        : action === "archive_correction" ? "归档更正说明"
                          : action === "archive_void_notice" ? "归档废止说明"
                            : action;
}

function cleanText(value: string) {
  return value.normalize("NFKC").replace(/[\p{Cf}\u2028\u2029]/gu, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").trim();
}

function displayValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") return Number.isFinite(value) ? value.toLocaleString("zh-CN", { maximumFractionDigits: 4 }) : "—";
  return cleanText(String(value)) || "—";
}

function fieldLabel(key: string) {
  return FIELD_LABELS[key] || key.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

function flattenPayload(value: unknown, key = "", depth = 0): Array<{ label: string; value: string; depth: number }> {
  if (depth > 5) return [{ label: fieldLabel(key), value: "[内容层级过深]", depth }];
  if (Array.isArray(value)) {
    if (!value.length) return [{ label: fieldLabel(key), value: "无", depth }];
    if (value.every((item) => item === null || ["string", "number", "boolean"].includes(typeof item))) {
      return [{ label: fieldLabel(key), value: value.map(displayValue).join("、"), depth }];
    }
    return value.flatMap((item, index) => [
      { label: `${fieldLabel(key)} · 第 ${index + 1} 项`, value: "", depth },
      ...flattenPayload(item, "", depth + 1),
    ]);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([childKey]) => !OMITTED_PAYLOAD_FIELDS.has(childKey));
    if (!entries.length) return key ? [{ label: fieldLabel(key), value: "无", depth }] : [];
    return entries.flatMap(([childKey, childValue]) => flattenPayload(childValue, childKey, depth + (key ? 1 : 0)));
  }
  return [{ label: key ? fieldLabel(key) : "内容", value: displayValue(value), depth }];
}

function textItem(text: string, size = 10, options: Partial<Omit<TextItem, "kind" | "text" | "size">> = {}): TextItem {
  return { kind: "text", text: cleanText(text), size, color: [0.15, 0.22, 0.24], leading: Math.max(14, size * 1.5), gapAfter: 3, ...options };
}

function section(text: string): TextItem {
  return textItem(text, 13, { color: [0.08, 0.37, 0.34], leading: 22, gapAfter: 7, section: true });
}

function buildLayoutItems(input: ApprovalPdfInput): LayoutItem[] {
  const { approval, events, integrity } = input;
  const items: LayoutItem[] = [
    textItem("OriginMind × ARTS Robotics 联合研发 OA", 9, { color: [0.30, 0.47, 0.45], gapAfter: 12 }),
    textItem(approval.title, 22, { color: [0.05, 0.19, 0.24], leading: 31, gapAfter: 5 }),
    textItem(`${approval.type} · ${approval.status} / ${approval.currentStep}`, 11, { color: [0.35, 0.42, 0.46], gapAfter: 16 }),
    section("基本信息"),
    textItem(`归档编号：${approval.id}`),
    textItem(`联合项目：${approval.project}`),
    textItem(`申请人：${approval.requesterName}（${approval.requesterEmail}）`),
    textItem(`创建时间：${approval.createdAt}`),
    textItem(`${approval.status === "已归档" ? "归档" : "更新时间"}：${approval.updatedAt}`),
    textItem(`事项负责人：${approval.owner || "—"}`),
    textItem(`当前处理人：${approval.currentReviewerName ? `${approval.currentReviewerName}${approval.currentReviewerEmail ? `（${approval.currentReviewerEmail}）` : ""}` : "—"}`),
    textItem(`金额：${approval.amount || "不适用"}`, 10, { gapAfter: 12 }),
    section("事项摘要"),
    textItem(approval.summary || "无", 10, { gapAfter: 12 }),
  ];

  if (approval.type === "保密协议") {
    const kind = confidentialityAgreementKindFromPayload(approval.payload);
    const signerName = displayValue(approval.payload.signerName);
    const scope = displayValue(approval.payload.confidentialScope);
    const version = displayValue(approval.payload.agreementVersion);
    if (kind && version !== "—") {
      try {
        items.push(section("协议正文"));
        for (const paragraph of buildNdaAgreementTextForVersion(signerName, scope, kind, version).split("\n")) {
          items.push(textItem(paragraph, paragraph === "保密协议" || paragraph === "项目负责人保密承诺书" ? 13 : 10, { gapAfter: 6 }));
        }
        items.push(textItem("本人确认已阅读上述正文，并以本人实名认证账户完成电子手写签署。", 10, { color: [0.24, 0.42, 0.39], gapAfter: 9 }));
      } catch {
        // Historical records with an unsupported version still retain their raw fields below.
      }
    }
  }

  items.push(section("申请数据"));
  for (const field of flattenPayload(approval.payload)) {
    const prefix = field.value ? `${field.label}：` : `${field.label}`;
    items.push(textItem(`${prefix}${field.value}`, 9.5, { indent: Math.min(field.depth, 4) * 12, gapAfter: field.value ? 3 : 5 }));
  }
  if (!flattenPayload(approval.payload).length) items.push(textItem("无"));

  if (approval.type === "保密协议" && typeof approval.payload.signatureDataUrl === "string") {
    items.push(section("本人手写签名"));
    items.push({ kind: "signature", gapAfter: 10 });
    items.push(textItem(`签署人：${displayValue(approval.payload.signerName)}　签署时间：${displayValue(approval.payload.signedAt)}`, 9.5, { gapAfter: 12 }));
  }

  items.push(section("签署与流转记录"));
  if (!events.length) items.push(textItem("暂无流转记录。"));
  for (const event of events) {
    items.push(textItem(`${event.createdAt} · ${event.action}`, 10.5, { color: [0.09, 0.33, 0.31], gapAfter: 1 }));
    items.push(textItem(`操作人：${event.actorName}（${event.actorEmail}）`, 9, { indent: 10, color: [0.35, 0.41, 0.44], gapAfter: 1 }));
    items.push(textItem(`记录：${event.note || "无"}`, 9.5, { indent: 10, gapAfter: 7 }));
  }

  if (integrity) {
    items.push(section("归档完整性校验"));
    items.push(textItem(`归档结构版本：${integrity.schemaVersion}`));
    items.push(textItem(`脱敏归档 SHA-256：${integrity.archiveHash}`, 8.5));
    items.push(textItem(`原始证据记录 SHA-256：${integrity.evidenceRecordHash}`, 8.5));
    items.push(textItem(`终局材料版本：${integrity.terminalRevisionNo === null ? "历史基线" : `第 ${integrity.terminalRevisionNo} 版`}`, 8.5));
    if (integrity.terminalRevisionHash) items.push(textItem(`终局修订 SHA-256：${integrity.terminalRevisionHash}`, 8.5));
    if (integrity.terminalStateHash) items.push(textItem(`终局材料 SHA-256：${integrity.terminalStateHash}`, 8.5));
  }

  items.push(textItem("本文件由 OriginMind × ARTS Robotics 联合研发 OA 自动生成。归档 PDF 与 OA 不可变材料版本、流转记录及校验值一一对应。", 8.5, { color: [0.38, 0.45, 0.47], gapAfter: 0 }));
  return items;
}

function textUnits(value: string) {
  let units = 0;
  for (const character of value) units += /^[\u0000-\u00ff]$/u.test(character) ? 1 : 2;
  return units;
}

function splitLongToken(token: string, maximumUnits: number) {
  const parts: string[] = [];
  let current = "";
  let units = 0;
  for (const character of token) {
    const characterUnits = /^[\u0000-\u00ff]$/u.test(character) ? 1 : 2;
    if (current && units + characterUnits > maximumUnits) {
      parts.push(current);
      current = "";
      units = 0;
    }
    current += character;
    units += characterUnits;
  }
  if (current) parts.push(current);
  return parts;
}

function wrapText(value: string, maximumUnits: number) {
  if (!value) return [""];
  const lines: string[] = [];
  let current = "";
  let units = 0;
  for (const paragraph of value.split(/\n/u)) {
    for (const character of paragraph) {
      const characterUnits = /^[\u0000-\u00ff]$/u.test(character) ? 1 : 2;
      if (current && units + characterUnits > maximumUnits) {
        lines.push(current.trimEnd());
        current = "";
        units = 0;
      }
      current += character;
      units += characterUnits;
    }
    lines.push(current.trimEnd());
    current = "";
    units = 0;
  }
  if (lines.at(-1) === "" && value.at(-1) !== "\n") lines.pop();
  return lines.flatMap((line) => textUnits(line) <= maximumUnits ? [line] : splitLongToken(line, maximumUnits));
}

function unicodeHex(value: string) {
  let hex = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0x3f;
    const safeCodePoint = codePoint <= 0xffff ? codePoint : 0x3f;
    hex += safeCodePoint.toString(16).padStart(4, "0");
  }
  return hex.toUpperCase();
}

function base64Bytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function embeddedFontCompressed() {
  return embeddedFontCompressedCache ??= base64Bytes(PDF_EMBEDDED_FONT_COMPRESSED_BASE64);
}

function embeddedFontCidMapCompressed() {
  return embeddedFontCidMapCompressedCache ??= base64Bytes(PDF_EMBEDDED_FONT_CID_MAP_COMPRESSED_BASE64);
}

function embeddedFontSupports(character: string) {
  const codePoint = character.codePointAt(0) ?? 0x3f;
  if (codePoint > 0xffff) return false;
  const bits = embeddedFontSupportedBitsCache ??= base64Bytes(PDF_EMBEDDED_FONT_SUPPORTED_BITS_BASE64);
  return (bits[codePoint >> 3] & (1 << (codePoint & 7))) !== 0;
}

function textCommand(value: string, size: number, color: [number, number, number], x: number, y: number) {
  const runs: Array<{ embedded: boolean; text: string }> = [];
  for (const character of value) {
    const embedded = embeddedFontSupports(character);
    const current = runs.at(-1);
    if (current?.embedded === embedded) current.text += character;
    else runs.push({ embedded, text: character });
  }
  const commands = [`BT ${color.map(pdfNumber).join(" ")} rg 1 0 0 1 ${pdfNumber(x)} ${pdfNumber(y)} Tm`];
  for (const run of runs) commands.push(`/${run.embedded ? "F1" : "F2"} ${pdfNumber(size)} Tf <${unicodeHex(run.text)}> Tj`);
  commands.push("ET");
  return commands.join(" ");
}

function embeddedFontToUnicodeCMap(values: Iterable<string>) {
  const characterCodes = new Set<number>();
  for (const value of values) {
    for (const character of value) {
      const codePoint = character.codePointAt(0) ?? 0x3f;
      if (codePoint <= 0xffff && embeddedFontSupports(character)) characterCodes.add(codePoint);
    }
  }
  const sortedCodes = [...characterCodes].sort((left, right) => left - right);
  const mappings: string[] = [];
  for (let offset = 0; offset < sortedCodes.length; offset += 100) {
    const chunk = sortedCodes.slice(offset, offset + 100);
    mappings.push(`${chunk.length} beginbfchar`);
    for (const codePoint of chunk) {
      const code = codePoint.toString(16).padStart(4, "0").toUpperCase();
      mappings.push(`<${code}> <${code}>`);
    }
    mappings.push("endbfchar");
  }
  return `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /${PDF_EMBEDDED_FONT_NAME}-ToUnicode def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${mappings.join("\n")}
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
}

function pdfNumber(value: number) {
  return Number(value.toFixed(3)).toString();
}

async function streamToBytes(stream: ReadableStream<Uint8Array>) {
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

function pngUint32(bytes: Uint8Array, offset: number) {
  return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}

function paeth(left: number, above: number, upperLeft: number) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance ? left : aboveDistance <= upperLeftDistance ? above : upperLeft;
}

async function decodeSignatureImage(dataUrl: string): Promise<SignatureImage | null> {
  const prefix = "data:image/png;base64,";
  if (!dataUrl.startsWith(prefix)) return null;
  try {
    const bytes = Uint8Array.from(atob(dataUrl.slice(prefix.length)), (character) => character.charCodeAt(0));
    if (bytes.length < 96 || pngUint32(bytes, 16) !== 900 || pngUint32(bytes, 20) !== 260 || bytes[24] !== 8 || bytes[25] !== 6 || bytes[28] !== 0) return null;
    const compressedChunks: Uint8Array[] = [];
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = pngUint32(bytes, offset);
      const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
      const dataStart = offset + 8;
      const dataEnd = dataStart + length;
      if (dataEnd + 4 > bytes.length) return null;
      if (type === "IDAT") compressedChunks.push(bytes.slice(dataStart, dataEnd));
      offset = dataEnd + 4;
      if (type === "IEND") break;
    }
    const compressedLength = compressedChunks.reduce((total, chunk) => total + chunk.length, 0);
    const compressed = new Uint8Array(compressedLength);
    let compressedOffset = 0;
    for (const chunk of compressedChunks) {
      compressed.set(chunk, compressedOffset);
      compressedOffset += chunk.length;
    }
    const filtered = await streamToBytes(new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate")));
    const sourceWidth = 900;
    const sourceHeight = 260;
    const stride = sourceWidth * 4;
    if (filtered.byteLength !== (stride + 1) * sourceHeight) return null;
    const rgba = new Uint8Array(stride * sourceHeight);
    let sourceOffset = 0;
    for (let y = 0; y < sourceHeight; y += 1) {
      const filter = filtered[sourceOffset++];
      if (filter > 4) return null;
      for (let x = 0; x < stride; x += 1) {
        const raw = filtered[sourceOffset++];
        const left = x >= 4 ? rgba[y * stride + x - 4] : 0;
        const above = y > 0 ? rgba[(y - 1) * stride + x] : 0;
        const upperLeft = y > 0 && x >= 4 ? rgba[(y - 1) * stride + x - 4] : 0;
        rgba[y * stride + x] = filter === 0 ? raw
          : filter === 1 ? (raw + left) & 0xff
            : filter === 2 ? (raw + above) & 0xff
              : filter === 3 ? (raw + Math.floor((left + above) / 2)) & 0xff
                : (raw + paeth(left, above, upperLeft)) & 0xff;
      }
    }
    const targetWidth = 300;
    const targetHeight = 87;
    const rgb = new Uint8Array(targetWidth * targetHeight * 3);
    for (let y = 0; y < targetHeight; y += 1) {
      const sourceY = Math.min(sourceHeight - 1, Math.floor(y * sourceHeight / targetHeight));
      for (let x = 0; x < targetWidth; x += 1) {
        const sourceX = Math.min(sourceWidth - 1, x * 3);
        const sourceIndex = sourceY * stride + sourceX * 4;
        const targetIndex = (y * targetWidth + x) * 3;
        const alpha = rgba[sourceIndex + 3] / 255;
        rgb[targetIndex] = Math.round(rgba[sourceIndex] * alpha + 255 * (1 - alpha));
        rgb[targetIndex + 1] = Math.round(rgba[sourceIndex + 1] * alpha + 255 * (1 - alpha));
        rgb[targetIndex + 2] = Math.round(rgba[sourceIndex + 2] * alpha + 255 * (1 - alpha));
      }
    }
    const compressedRgb = await streamToBytes(new Blob([rgb]).stream().pipeThrough(new CompressionStream("deflate")));
    return { width: targetWidth, height: targetHeight, compressedRgb };
  } catch {
    return null;
  }
}

function ascii(value: string) {
  return encoder.encode(value);
}

function concatBytes(parts: Uint8Array[]) {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function objectBytes(id: number, body: Uint8Array | string) {
  const content = typeof body === "string" ? ascii(body) : body;
  return concatBytes([ascii(`${id} 0 obj\n`), content, ascii("\nendobj\n")]);
}

function streamObjectBytes(id: number, dictionary: string, body: Uint8Array) {
  return objectBytes(id, concatBytes([ascii(`<< ${dictionary} /Length ${body.byteLength} >>\nstream\n`), body, ascii("\nendstream")]));
}

export async function buildApprovalPdf(input: ApprovalPdfInput) {
  const signatureDataUrl = typeof input.approval.payload.signatureDataUrl === "string" ? input.approval.payload.signatureDataUrl : "";
  const signature = signatureDataUrl ? await decodeSignatureImage(signatureDataUrl) : null;
  const pageItems: LayoutItem[][] = [[]];
  let y = PAGE_TOP;
  const nextPage = () => {
    pageItems.push([]);
    y = PAGE_TOP;
  };
  for (const item of buildLayoutItems(input)) {
    if (item.kind === "signature") {
      const needed = 90 + (item.gapAfter || 0);
      if (y - needed < PAGE_BOTTOM) nextPage();
      pageItems.at(-1)?.push(item);
      y -= needed;
      continue;
    }
    const indent = item.indent || 0;
    const availableWidth = PAGE_WIDTH - PAGE_LEFT - PAGE_RIGHT - indent;
    const maximumUnits = Math.max(12, Math.floor(availableWidth / (item.size * 0.54)));
    const lines = wrapText(item.text, maximumUnits);
    let lineOffset = 0;
    let firstChunk = true;
    while (lineOffset < lines.length) {
      const leading = item.leading || 15;
      const reserved = (lineOffset === lines.length - 1 ? item.gapAfter || 0 : 0) + (firstChunk && item.section ? 3 : 0);
      let capacity = Math.floor((y - PAGE_BOTTOM - reserved) / leading);
      if (capacity < 1 && pageItems.at(-1)?.length) {
        nextPage();
        capacity = Math.floor((y - PAGE_BOTTOM - reserved) / leading);
      }
      capacity = Math.max(1, capacity);
      const chunk = lines.slice(lineOffset, lineOffset + capacity);
      const chunkItem: TextItem = {
        ...item,
        text: chunk.join("\n"),
        section: firstChunk && item.section,
        gapAfter: lineOffset + chunk.length >= lines.length ? item.gapAfter : 0,
      };
      pageItems.at(-1)?.push(chunkItem);
      y -= chunk.length * leading + (chunkItem.gapAfter || 0) + (chunkItem.section ? 3 : 0);
      lineOffset += chunk.length;
      firstChunk = false;
      if (lineOffset < lines.length) nextPage();
    }
  }

  const imageObjectId = signature ? 11 : null;
  const firstPageObjectId = signature ? 12 : 11;
  const pageObjectIds = pageItems.map((_, index) => firstPageObjectId + index * 2);
  const contentObjectIds = pageItems.map((_, index) => firstPageObjectId + index * 2 + 1);
  const objects = new Map<number, Uint8Array>();
  objects.set(1, objectBytes(1, "<< /Type /Catalog /Pages 2 0 R >>"));
  objects.set(2, objectBytes(2, `<< /Type /Pages /Count ${pageItems.length} /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] >>`));
  objects.set(3, objectBytes(3, `<< /Type /Font /Subtype /Type0 /BaseFont /${PDF_EMBEDDED_FONT_NAME} /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 8 0 R >>`));
  objects.set(4, objectBytes(4, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${PDF_EMBEDDED_FONT_NAME} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 5 0 R /CIDToGIDMap 7 0 R /DW 1000 /W [32 126 500] >>`));
  objects.set(5, objectBytes(5, `<< /Type /FontDescriptor /FontName /${PDF_EMBEDDED_FONT_NAME} /Flags 4 /FontBBox [-1002 -1048 2928 1808] /ItalicAngle 0 /Ascent 1000 /Descent -200 /CapHeight 733 /StemV 80 /MissingWidth 1000 /FontFile2 6 0 R >>`));
  objects.set(6, streamObjectBytes(6, `/Filter /FlateDecode /Length1 ${PDF_EMBEDDED_FONT_LENGTH}`, embeddedFontCompressed()));
  objects.set(7, streamObjectBytes(7, "/Filter /FlateDecode", embeddedFontCidMapCompressed()));
  const toUnicodeText = pageItems.flatMap((items, pageIndex) => [
    ...items.filter((item): item is TextItem => item.kind === "text").map((item) => item.text),
    pageIndex > 0 ? `${input.approval.title} · 续页` : "",
    input.approval.id,
    `第 ${pageIndex + 1} / ${pageItems.length} 页`,
    "签名图像不可用于当前导出",
  ]);
  objects.set(8, streamObjectBytes(8, "", ascii(embeddedFontToUnicodeCMap(toUnicodeText))));
  objects.set(9, objectBytes(9, "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [10 0 R] >>"));
  objects.set(10, objectBytes(10, "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 5 >> /DW 1000 /W [32 126 500] >>"));
  if (signature && imageObjectId) {
    objects.set(imageObjectId, streamObjectBytes(imageObjectId, `/Type /XObject /Subtype /Image /Width ${signature.width} /Height ${signature.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`, signature.compressedRgb));
  }

  pageItems.forEach((items, pageIndex) => {
    let cursorY = PAGE_TOP;
    const commands: string[] = [];
    if (pageIndex > 0) {
      commands.push(textCommand(`${input.approval.title} · 续页`, 8, [0.36, 0.45, 0.46], PAGE_LEFT, 812));
    }
    for (const item of items) {
      if (item.kind === "signature") {
        commands.push(`${pdfNumber(PAGE_LEFT)} ${pdfNumber(cursorY - 79)} 300 87 re 0.97 0.98 0.98 rg f`);
        if (signature && imageObjectId) commands.push(`q 300 0 0 87 ${PAGE_LEFT} ${pdfNumber(cursorY - 79)} cm /Sig Do Q`);
        else commands.push(textCommand("签名图像不可用于当前导出", 9, [0.45, 0.48, 0.49], PAGE_LEFT + 16, cursorY - 42));
        cursorY -= 90 + (item.gapAfter || 0);
        continue;
      }
      const indent = item.indent || 0;
      const availableWidth = PAGE_WIDTH - PAGE_LEFT - PAGE_RIGHT - indent;
      const maximumUnits = Math.max(12, Math.floor(availableWidth / (item.size * 0.54)));
      const lines = wrapText(item.text, maximumUnits);
      if (item.section) commands.push(`${PAGE_LEFT - 5} ${pdfNumber(cursorY - lines.length * (item.leading || 15) + 3)} ${PAGE_WIDTH - PAGE_LEFT - PAGE_RIGHT + 10} ${pdfNumber(lines.length * (item.leading || 15) + 3)} re 0.93 0.97 0.96 rg f`);
      for (const line of lines) {
        commands.push(textCommand(line, item.size, item.color, PAGE_LEFT + indent, cursorY));
        cursorY -= item.leading || 15;
      }
      cursorY -= (item.gapAfter || 0) + (item.section ? 3 : 0);
    }
    commands.push(`${PAGE_LEFT} 43 ${PAGE_WIDTH - PAGE_LEFT - PAGE_RIGHT} 0.5 re 0.79 0.85 0.85 rg f`);
    commands.push(textCommand(input.approval.id, 8, [0.40, 0.46, 0.48], PAGE_LEFT, 29));
    commands.push(textCommand(`第 ${pageIndex + 1} / ${pageItems.length} 页`, 8, [0.40, 0.46, 0.48], 500, 29));
    const content = ascii(commands.join("\n"));
    const resources = signature && imageObjectId ? `<< /Font << /F1 3 0 R /F2 9 0 R >> /XObject << /Sig ${imageObjectId} 0 R >> >>` : "<< /Font << /F1 3 0 R /F2 9 0 R >> >>";
    objects.set(pageObjectIds[pageIndex], objectBytes(pageObjectIds[pageIndex], `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources ${resources} /Contents ${contentObjectIds[pageIndex]} 0 R >>`));
    objects.set(contentObjectIds[pageIndex], streamObjectBytes(contentObjectIds[pageIndex], "", content));
  });

  const objectCount = Math.max(...objects.keys());
  const header = concatBytes([ascii("%PDF-1.7\n%"), new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3]), ascii("\n")]);
  const parts: Uint8Array[] = [header];
  const offsets = new Array<number>(objectCount + 1).fill(0);
  let offset = header.byteLength;
  for (let id = 1; id <= objectCount; id += 1) {
    const object = objects.get(id);
    if (!object) throw new Error(`PDF object ${id} is missing`);
    offsets[id] = offset;
    parts.push(object);
    offset += object.byteLength;
  }
  const xrefOffset = offset;
  const xref = [
    `xref\n0 ${objectCount + 1}`,
    "0000000000 65535 f ",
    ...offsets.slice(1).map((value) => `${value.toString().padStart(10, "0")} 00000 n `),
    `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  ].join("\n");
  parts.push(ascii(xref));
  return concatBytes(parts);
}

export function safeApprovalPdfFileName(approval: Pick<ApprovalPdfRecord, "id" | "title" | "updatedAt">, archiveHash = "") {
  const date = Number.isNaN(Date.parse(approval.updatedAt)) ? "00000000-0000" : new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(approval.updatedAt)).replace(/[^0-9]/gu, "").slice(0, 12);
  const id = cleanText(approval.id).replace(/[^A-Za-z0-9._-]/gu, "-").replace(/-+/gu, "-").replace(/^[-.]+|[-.]+$/gu, "").slice(0, 60) || "approval";
  const title = cleanText(approval.title).replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "-").replace(/\s+/gu, " ").slice(0, 72) || "审批归档";
  const suffix = archiveHash ? `-${archiveHash.slice(0, 12)}` : "";
  return `${date}-${id}-${title}${suffix}.pdf`;
}

export function safeFeishuArchivePdfFileName(approval: Pick<ApprovalPdfRecord, "id" | "title" | "updatedAt">, archiveHash = "") {
  const readableStem = safeApprovalPdfFileName(approval, archiveHash).replace(/\.pdf$/iu, "");
  const asciiStem = readableStem
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[-.]+|[-.]+$/gu, "")
    .slice(0, 173);
  return `OA-${asciiStem || "approval"}.pdf`;
}

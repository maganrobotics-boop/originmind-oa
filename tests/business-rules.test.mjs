import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false },
});

after(async () => {
  await vite.close();
});

const approvalPolicy = await vite.ssrLoadModule("/lib/approval-policy.ts");
const archiveManifest = await vite.ssrLoadModule("/lib/archive-manifest.ts");
const approvalRevisions = await vite.ssrLoadModule("/lib/approval-revisions.ts");
const accountSubject = await vite.ssrLoadModule("/lib/account-subject.ts");
const githubOAuth = await vite.ssrLoadModule("/lib/github-oauth.ts");
const ndaAgreement = await vite.ssrLoadModule("/lib/nda-agreement.ts");
const approvalSigners = await vite.ssrLoadModule("/lib/approval-signers.ts");
const imageDataUrl = await vite.ssrLoadModule("/lib/image-data-url.ts");
const pngSignature = await vite.ssrLoadModule("/lib/png-signature.ts");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function signaturePngDataUrl(withInk, {
  inkRgba = [41, 68, 63, 255],
  duplicateIhdr = false,
  extraInflatedBytes = 0,
  colorType = 6,
  transparencyChunk = false,
  unknownCriticalChunk = false,
  unknownAncillaryChunk = false,
  semanticAncillaryChunk = false,
  significantBits,
  duplicateSignificantBits = false,
  lateSignificantBits = false,
  trailingBytes = false,
  corruptCrc = false,
  splitIdat = false,
  standardSrgb = false,
  duplicateSrgb = false,
  invalidGamma = false,
  standardPhys = false,
  invalidPhys = false,
} = {}) {
  const width = 900;
  const height = 260;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * 4;
      if (withInk && x >= 100 && x <= 180 && y >= 80 && y <= 110) {
        scanlines[pixel] = inkRgba[0];
        scanlines[pixel + 1] = inkRgba[1];
        scanlines[pixel + 2] = inkRgba[2];
        scanlines[pixel + 3] = inkRgba[3];
      }
    }
  }
  const inflated = extraInflatedBytes ? Buffer.concat([scanlines, Buffer.alloc(extraInflatedBytes)]) : scanlines;
  const compressed = deflateSync(inflated);
  const midpoint = Math.max(1, Math.floor(compressed.length / 2));
  const standardChromaticity = Buffer.alloc(32);
  [31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000].forEach((value, index) => standardChromaticity.writeUInt32BE(value, index * 4));
  const gamma = Buffer.alloc(4);
  gamma.writeUInt32BE(invalidGamma ? 1 : 45455, 0);
  const physicalResolution = Buffer.alloc(9);
  physicalResolution.writeUInt32BE(invalidPhys ? 1 : 3780, 0);
  physicalResolution.writeUInt32BE(3780, 4);
  physicalResolution[8] = 1;
  const significantBitChunks = significantBits ? [
    pngChunk("sBIT", Buffer.from(significantBits)),
    ...(duplicateSignificantBits ? [pngChunk("sBIT", Buffer.from(significantBits))] : []),
  ] : [];
  const chunks = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    ...(duplicateIhdr ? [pngChunk("IHDR", ihdr)] : []),
    ...(standardSrgb || invalidGamma ? [pngChunk("gAMA", gamma)] : []),
    ...(standardSrgb ? [pngChunk("cHRM", standardChromaticity), pngChunk("sRGB", Buffer.from([0]))] : []),
    ...(duplicateSrgb ? [pngChunk("sRGB", Buffer.from([0]))] : []),
    ...(standardPhys || invalidPhys ? [pngChunk("pHYs", physicalResolution)] : []),
    ...(lateSignificantBits ? [] : significantBitChunks),
    ...(transparencyChunk ? [pngChunk("tRNS", Buffer.alloc(6))] : []),
    ...(unknownCriticalChunk ? [pngChunk("ABCD", Buffer.alloc(0))] : []),
    ...(unknownAncillaryChunk ? [pngChunk("vpAg", Buffer.alloc(0))] : []),
    ...(semanticAncillaryChunk ? [pngChunk("cICP", Buffer.alloc(4))] : []),
    ...(splitIdat ? [pngChunk("IDAT", compressed.subarray(0, midpoint)), pngChunk("tIME", Buffer.from([0x07, 0xea, 9, 1, 0, 0, 0])), pngChunk("IDAT", compressed.subarray(midpoint))] : [pngChunk("IDAT", compressed)]),
    ...(lateSignificantBits ? significantBitChunks : []),
    pngChunk("IEND", Buffer.alloc(0)),
    ...(trailingBytes ? [Buffer.from("trailing")] : []),
  ];
  const png = Buffer.concat(chunks);
  if (corruptCrc) png.writeUInt32BE(0, 29);
  return `data:image/png;base64,${png.toString("base64")}`;
}

const activeMembers = [
  {
    id: "member-a",
    fullName: "开发人甲",
    chatgptAccount: "dev-a@example.com",
    status: "active",
  },
  {
    id: "member-b",
    fullName: "开发人乙",
    chatgptAccount: "dev-b@example.com",
    status: "active",
  },
  {
    id: "member-inactive",
    fullName: "离组成员",
    chatgptAccount: "inactive@example.com",
    status: "rejected",
  },
];

const validDevelopers = [
  {
    memberId: "member-a",
    email: "dev-a@example.com",
    name: "开发人甲",
    work: "控制算法",
    ratio: 33.33,
  },
  {
    memberId: "member-b",
    email: "dev-b@example.com",
    name: "开发人乙",
    work: "系统集成",
    ratio: 66.67,
  },
];

test("技术审核的开发人确认节点拒绝通用 approve", () => {
  assert.equal(
    approvalPolicy.workflowAllows("技术审核", "开发人确认", "approve", "待审核"),
    false,
  );
  assert.equal(
    approvalPolicy.workflowAllows(
      "技术审核",
      "开发人确认",
      "confirm_developer",
      "待审核",
    ),
    true,
  );
});

test("退回的 NDA 不能复用旧签名直接重新提交", () => {
  assert.equal(
    approvalPolicy.workflowAllows("保密协议", "补充材料", "resubmit", "已退回"),
    false,
  );
  assert.equal(approvalPolicy.isReusedReturnedNdaSignature("old-signature", "old-signature"), true);
  assert.equal(approvalPolicy.isReusedReturnedNdaSignature("old-signature", "new-signature"), false);
  assert.equal(approvalPolicy.isReusedReturnedNdaSignature("", "new-signature"), false);
});

test("申请人生命周期只允许按撤回、作废和归档说明矩阵流转", () => {
  for (const status of ["待审核", "审批中", "已退回"]) {
    assert.equal(approvalPolicy.workflowAllows("技术审核", status === "已退回" ? "补充材料" : "技术顾问", "withdraw", status), true);
  }
  for (const status of ["草稿", "已撤回", "已作废", "已归档"]) {
    assert.equal(approvalPolicy.workflowAllows("技术审核", "申请人修改", "withdraw", status), false);
  }
  assert.equal(approvalPolicy.workflowAllows("技术审核", "草稿", "void", "草稿"), true);
  assert.equal(approvalPolicy.workflowAllows("技术审核", "申请人修改", "void", "已撤回"), true);
  assert.equal(approvalPolicy.workflowAllows("技术审核", "补充材料", "void", "已退回"), false);
  assert.equal(approvalPolicy.workflowAllows("技术审核", "已归档", "archive_note", "已归档"), true);
  assert.equal(approvalPolicy.workflowAllows("技术审核", "申请人修改", "archive_note", "已撤回"), false);
  assert.equal(approvalPolicy.workflowAllows("技术审核", "申请人修改", "resubmit", "已撤回"), true);
  assert.equal(approvalPolicy.workflowAllows("保密协议", "申请人修改", "resubmit", "已撤回"), false);
});

test("劳务占用在撤回期间保留，只有草稿和已作废不占用", () => {
  assert.equal(approvalPolicy.holdsLaborReservation("草稿"), false);
  assert.equal(approvalPolicy.holdsLaborReservation("待审核"), true);
  assert.equal(approvalPolicy.holdsLaborReservation("审批中"), true);
  assert.equal(approvalPolicy.holdsLaborReservation("已退回"), true);
  assert.equal(approvalPolicy.holdsLaborReservation("已撤回"), true);
  assert.equal(approvalPolicy.holdsLaborReservation("已归档"), true);
  assert.equal(approvalPolicy.holdsLaborReservation("已作废"), false);
});

test("技术开发人必须按声明顺序逐人实名确认", () => {
  const normalized = approvalPolicy.normalizeTechnicalDevelopers(
    validDevelopers,
    activeMembers,
  );
  assert.equal(normalized.error, undefined);

  const first = approvalPolicy.getPendingDeveloper(normalized.developers, []);
  assert.equal(first.error, undefined);
  assert.equal(first.pendingDeveloper.memberId, "member-a");

  const afterFirst = approvalPolicy.getPendingDeveloper(normalized.developers, [
    {
      memberId: "member-a",
      email: "dev-a@example.com",
      name: "开发人甲",
      confirmedAt: "2026-09-01T01:02:03.000Z",
    },
  ]);
  assert.equal(afterFirst.error, undefined);
  assert.equal(afterFirst.pendingDeveloper.memberId, "member-b");

  const outOfOrder = approvalPolicy.getPendingDeveloper(normalized.developers, [
    {
      memberId: "member-b",
      email: "dev-b@example.com",
      name: "开发人乙",
      confirmedAt: "2026-09-01T01:02:03.000Z",
    },
  ]);
  assert.match(outOfOrder.error, /顺序|身份/);
});

test("技术开发人绑定有效成员身份并拒绝重复成员", () => {
  const mismatchedIdentity = approvalPolicy.normalizeTechnicalDevelopers(
    [
      { ...validDevelopers[0], email: "other@example.com", ratio: 100 },
    ],
    activeMembers,
  );
  assert.match(mismatchedIdentity.error, /有效成员|身份信息不一致/);

  const inactiveIdentity = approvalPolicy.normalizeTechnicalDevelopers(
    [
      {
        memberId: "member-inactive",
        email: "inactive@example.com",
        name: "离组成员",
        work: "历史工作",
        ratio: 100,
      },
    ],
    activeMembers,
  );
  assert.match(inactiveIdentity.error, /有效成员|身份信息不一致/);

  const duplicate = approvalPolicy.normalizeTechnicalDevelopers(
    [
      { ...validDevelopers[0], ratio: 50 },
      { ...validDevelopers[0], ratio: 50 },
    ],
    activeMembers,
  );
  assert.match(duplicate.error, /重复/);
});

test("技术开发人贡献占比必须以两位小数精确合计 100%", () => {
  const normalized = approvalPolicy.normalizeTechnicalDevelopers(
    validDevelopers,
    activeMembers,
  );
  assert.equal(normalized.error, undefined);
  assert.equal(
    normalized.developers.reduce(
      (total, developer) => total + developer.ratioBasisPoints,
      0,
    ),
    10_000,
  );

  const shortTotal = approvalPolicy.normalizeTechnicalDevelopers(
    [
      { ...validDevelopers[0], ratio: 33.33 },
      { ...validDevelopers[1], ratio: 66.66 },
    ],
    activeMembers,
  );
  assert.match(shortTotal.error, /精确为 100%/);

  const excessivePrecision = approvalPolicy.normalizeTechnicalDevelopers(
    [{ ...validDevelopers[0], ratio: 100.001 }],
    activeMembers,
  );
  assert.match(excessivePrecision.error, /最多保留两位小数/);
});

test("劳务归属月份只接受 01 至 12", () => {
  assert.equal(approvalPolicy.isValidLaborMonth("2026-01"), true);
  assert.equal(approvalPolicy.isValidLaborMonth("2026-12"), true);
  assert.equal(approvalPolicy.isValidLaborMonth("2026-00"), false);
  assert.equal(approvalPolicy.isValidLaborMonth("2026-13"), false);
  assert.equal(approvalPolicy.isValidLaborMonth("2026-1"), false);
});

test("劳务月份按 Asia/Shanghai 自然月计算", () => {
  assert.equal(
    approvalPolicy.monthKeyInShanghai("2026-01-31T15:59:59.999Z"),
    "2026-01",
  );
  assert.equal(
    approvalPolicy.monthKeyInShanghai("2026-01-31T16:00:00.000Z"),
    "2026-02",
  );
});

test("采购统一采购节点仅接受采购确认或退回", () => {
  assert.equal(
    approvalPolicy.workflowAllows(
      "采购审核",
      "统一采购",
      "confirm_purchase",
      "审批中",
    ),
    true,
  );
  assert.equal(
    approvalPolicy.workflowAllows("采购审核", "统一采购", "return", "审批中"),
    true,
  );
  assert.equal(
    approvalPolicy.workflowAllows("采购审核", "统一采购", "approve", "审批中"),
    false,
  );
});

test("多节点职责分离拒绝同一实名账号兼任", () => {
  assert.equal(approvalPolicy.hasDistinctVerifiedEmails("applicant@example.com", "advisor@example.com", "owner@example.com"), true);
  assert.equal(approvalPolicy.hasDistinctVerifiedEmails("applicant@example.com", "advisor@example.com", "ADVISOR@example.com"), false);
  assert.equal(approvalPolicy.hasDistinctVerifiedEmails("applicant@example.com", "", "owner@example.com"), false);
});

test("材料修订预算按全部剩余实名节点动态预留", () => {
  const technicalPayload = { developers: Array.from({ length: 50 }, (_, index) => ({ memberId: `member-${index}` })) };
  assert.equal(approvalPolicy.workflowRevisionsNeededAfterMaterial("技术审核", technicalPayload), 52);
  assert.equal(75 + 1 + approvalPolicy.workflowRevisionsNeededAfterMaterial("技术审核", technicalPayload), 128);
  assert.ok(76 + 1 + approvalPolicy.workflowRevisionsNeededAfterMaterial("技术审核", technicalPayload) > 128);
  assert.equal(approvalPolicy.workflowRevisionsNeededAfterMaterial("采购审核", {}), 3);
});

test("同名签署人按认证账户主体分别保留并在汇总中消歧", () => {
  let value = approvalSigners.addApprovalSigner("[]", { name: "张伟", email: "zhang.one@example.com", accountUserId: "account-one", signedAt: "2026-09-01T00:00:00.000Z" });
  value = approvalSigners.addApprovalSigner(value, { name: "张伟", email: "zhang.two@example.com", accountUserId: "account-two", signedAt: "2026-09-01T01:00:00.000Z" });
  value = approvalSigners.addApprovalSigner(value, { name: "张伟", email: "zhang.one@example.com", accountUserId: "account-one", signedAt: "2026-09-01T02:00:00.000Z" });
  assert.equal(approvalSigners.parseApprovalSigners(value).length, 2);
  assert.deepEqual(approvalSigners.approvalSignerLabels(value), ["张伟（zhang.one@example.com）", "张伟（zhang.two@example.com）"]);
});

test("成员头像只接受匹配真实文件头的 PNG、JPEG 或 WebP", () => {
  const jpegBytes = Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0x00, 0xff, 0xd9,
  ]);
  assert.equal(imageDataUrl.isAllowedAvatarDataUrl(`data:image/jpeg;base64,${jpegBytes.toString("base64")}`), true);
  assert.equal(imageDataUrl.isAllowedAvatarDataUrl(`data:image/png;base64,${jpegBytes.toString("base64")}`), false);
  assert.equal(imageDataUrl.isAllowedAvatarDataUrl("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="), false);
});

test("NDA 拒绝伪造、截断或非 PNG 的签名数据", () => {
  assert.match(
    approvalPolicy.validatePngSignatureDataUrl(
      `data:image/jpeg;base64,${"A".repeat(128)}`,
    ),
    /PNG/,
  );
  assert.match(
    approvalPolicy.validatePngSignatureDataUrl(
      `data:image/png;base64,${"A".repeat(128)}`,
    ),
    /无效|PNG/,
  );
  assert.match(
    approvalPolicy.validatePngSignatureDataUrl(
      "data:image/png;base64,iVBORw0KGgo=",
    ),
    /无效|重新签署/,
  );
});

test("NDA 服务端解压 PNG 并拒绝透明空白签名", async () => {
  const inked = signaturePngDataUrl(true);
  const blank = signaturePngDataUrl(false);
  const barelyVisible = signaturePngDataUrl(true, { inkRgba: [229, 229, 229, 32] });
  const duplicateHeader = signaturePngDataUrl(true, { duplicateIhdr: true });
  const oversizedPixels = signaturePngDataUrl(true, { extraInflatedBytes: 4096 });
  const unsupportedRgb = signaturePngDataUrl(true, { colorType: 2 });
  const hiddenTransparency = signaturePngDataUrl(true, { transparencyChunk: true });
  const unknownCritical = signaturePngDataUrl(true, { unknownCriticalChunk: true });
  const trailingData = signaturePngDataUrl(true, { trailingBytes: true });
  const invalidCrc = signaturePngDataUrl(true, { corruptCrc: true });
  const separatedIdat = signaturePngDataUrl(true, { splitIdat: true });
  const standardColorProfile = signaturePngDataUrl(true, { standardSrgb: true });
  const nonstandardGamma = signaturePngDataUrl(true, { invalidGamma: true });
  const alternateColorSemantics = signaturePngDataUrl(true, { semanticAncillaryChunk: true });
  const standardSignificantBits = signaturePngDataUrl(true, { significantBits: [8, 8, 8, 8] });
  const nonstandardSignificantBits = signaturePngDataUrl(true, { significantBits: [8, 8, 8, 7] });
  const malformedSignificantBits = signaturePngDataUrl(true, { significantBits: [8, 8, 8] });
  const duplicateSignificantBits = signaturePngDataUrl(true, { significantBits: [8, 8, 8, 8], duplicateSignificantBits: true });
  const lateSignificantBits = signaturePngDataUrl(true, { significantBits: [8, 8, 8, 8], lateSignificantBits: true });
  const unknownAncillary = signaturePngDataUrl(true, { unknownAncillaryChunk: true });
  const duplicateColorProfile = signaturePngDataUrl(true, { standardSrgb: true, duplicateSrgb: true });
  const conflictingColorProfile = signaturePngDataUrl(true, { standardSrgb: true, invalidGamma: true });
  const standardResolution = signaturePngDataUrl(true, { standardPhys: true });
  const nonstandardResolution = signaturePngDataUrl(true, { invalidPhys: true });
  assert.equal(approvalPolicy.validatePngSignatureDataUrl(inked), null);
  assert.equal(await approvalPolicy.validatePngSignatureInk(inked), null);
  assert.match(await approvalPolicy.validatePngSignatureInk(blank), /笔迹|重新签署/);
  assert.match(await approvalPolicy.validatePngSignatureInk(barelyVisible), /笔迹|重新签署/);
  assert.match(await approvalPolicy.validatePngSignatureInk(duplicateHeader), /图像头|重新签署/);
  assert.match(await approvalPolicy.validatePngSignatureInk(oversizedPixels), /像素|重新签署/);
  assert.match(await approvalPolicy.validatePngSignatureInk(unsupportedRgb), /编码|重新签署/);
  assert.match(await approvalPolicy.validatePngSignatureInk(hiddenTransparency), /透明度|重新签署/);
  assert.match(await approvalPolicy.validatePngSignatureInk(unknownCritical), /关键数据块|重新签署/);
  assert.match(await approvalPolicy.validatePngSignatureInk(trailingData), /结束标记|重新签署/);
  assert.match(await approvalPolicy.validatePngSignatureInk(invalidCrc), /数据校验|重新签署/);
  assert.match(await approvalPolicy.validatePngSignatureInk(separatedIdat), /像素数据顺序|重新签署/);
  assert.equal(await approvalPolicy.validatePngSignatureInk(standardColorProfile), null);
  assert.match(await approvalPolicy.validatePngSignatureInk(nonstandardGamma), /色彩配置|重新签署/);
  assert.match(await approvalPolicy.validatePngSignatureInk(alternateColorSemantics), /附加数据块|重新签署/);
  assert.equal(await approvalPolicy.validatePngSignatureInk(pngSignature.canonicalizeSignaturePngDataUrl(alternateColorSemantics)), null);
  assert.equal(await approvalPolicy.validatePngSignatureInk(standardSignificantBits), null);
  assert.match(await approvalPolicy.validatePngSignatureInk(nonstandardSignificantBits), /有效位|重新签署/);
  assert.match(await approvalPolicy.validatePngSignatureInk(malformedSignificantBits), /有效位|重新签署/);
  assert.match(await approvalPolicy.validatePngSignatureInk(duplicateSignificantBits), /有效位|重新签署/);
  assert.match(await approvalPolicy.validatePngSignatureInk(lateSignificantBits), /有效位|重新签署/);
  assert.match(await approvalPolicy.validatePngSignatureInk(unknownAncillary), /附加数据块|重新签署/);
  assert.equal(await approvalPolicy.validatePngSignatureInk(pngSignature.canonicalizeSignaturePngDataUrl(unknownAncillary)), null);
  assert.match(await approvalPolicy.validatePngSignatureInk(duplicateColorProfile), /sRGB|重新签署/);
  assert.match(await approvalPolicy.validatePngSignatureInk(conflictingColorProfile), /色彩配置|重新签署/);
  assert.equal(await approvalPolicy.validatePngSignatureInk(standardResolution), null);
  assert.match(await approvalPolicy.validatePngSignatureInk(nonstandardResolution), /分辨率|重新签署/);
});

test("Sites 登录邮箱生成规范账户主体并绑定 NDA 业务主键", () => {
  assert.equal(accountSubject.accountSubjectForEmail(" Signer@Example.com "), "email:signer@example.com");
  assert.equal(
    ndaAgreement.ndaBusinessKey("email:signer@example.com"),
    "nda|account:email:signer@example.com|NDA-2026-09-R2",
  );
  assert.equal(
    ndaAgreement.ndaBusinessKeyForVersion("email:signer@example.com", ndaAgreement.LEGACY_NDA_AGREEMENT_VERSION),
    "nda|account:email:signer@example.com|NDA-2026-09",
  );
  assert.throws(() => ndaAgreement.ndaBusinessKey("signer@example.com"), /invalid/i);
  assert.throws(() => accountSubject.accountSubjectForEmail("invalid|subject@example.com"), /invalid/i);
});

test("GitHub 登录以稳定数字 ID 建立独立账户主体", () => {
  assert.equal(accountSubject.accountSubjectForGitHub("123456789"), "github_123456789");
  assert.equal(accountSubject.isSupportedAccountSubject("github_123456789"), true);
  assert.throws(() => accountSubject.accountSubjectForGitHub("octocat"), /invalid/i);
  assert.equal(githubOAuth.githubProviderSubject(583231), "583231");
  assert.throws(() => githubOAuth.githubProviderSubject("octocat"), /invalid/i);
});

test("飞书登录以应用、租户和 open_id 的哈希建立独立账户主体", async () => {
  const providerSubject = "cli_originmind_app:tenant_originmind:ou_feishu_1234";
  const subject = await accountSubject.accountSubjectForFeishu(providerSubject);
  const internalEmail = await accountSubject.accountEmailForFeishu(providerSubject);
  assert.match(subject, /^feishu_[0-9a-f]{64}$/u);
  assert.equal(accountSubject.isSupportedAccountSubject(subject), true);
  assert.match(internalEmail, /^feishu_[0-9a-f]+@feishu\.invalid$/u);
  assert.equal(internalEmail.length <= 254, true);
  await assert.rejects(accountSubject.accountSubjectForFeishu("ou_feishu_1234"), /invalid/i);
});

test("GitHub OAuth 只接受安全回跳路径并选择已验证邮箱", () => {
  assert.equal(githubOAuth.normalizeReturnPath("/settings?tab=login"), "/settings?tab=login");
  assert.equal(githubOAuth.normalizeReturnPath("//attacker.example/path"), "/");
  assert.equal(githubOAuth.normalizeReturnPath("https://attacker.example/path"), "/");
  assert.equal(githubOAuth.normalizeReturnPath(`/${"a".repeat(2_048)}`), "/");
  assert.equal(githubOAuth.selectVerifiedGitHubEmail([
    { email: "123+octocat@users.noreply.github.com", primary: true, verified: true },
    { email: "Other@Example.com", primary: false, verified: true },
    { email: "Primary@Example.com", primary: true, verified: true },
  ]), "primary@example.com");
  assert.equal(githubOAuth.selectVerifiedGitHubEmail([{ email: "unverified@example.com", primary: true, verified: false }]), null);
  const url = githubOAuth.buildGitHubAuthorizeUrl({
    clientId: "client-id",
    clientSecret: "secret",
    origin: "https://oa.example.com",
    callbackUrl: "https://oa.example.com/api/auth/github/callback",
  }, "state-value", "challenge-value");
  assert.equal(url.origin, "https://github.com");
  assert.equal(url.searchParams.get("scope"), "user:email");
  assert.equal(url.searchParams.get("redirect_uri"), "https://oa.example.com/api/auth/github/callback");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

test("GitHub OAuth 用短时请求完成令牌交换且不申请仓库权限", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, init });
    assert.ok(init.signal instanceof AbortSignal, `${url} 必须设置超时信号`);
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: "mock", token_type: "bearer", scope: "user:email" });
    }
    if (url === "https://api.github.com/user") {
      return Response.json({ id: 583231, login: "octocat", name: "The Octocat" });
    }
    if (url === "https://api.github.com/user/emails") {
      return Response.json([
        { email: "octocat@users.noreply.github.com", primary: true, verified: true },
        { email: "Octocat@Example.com", primary: false, verified: true },
      ]);
    }
    throw new Error(`unexpected GitHub URL: ${url}`);
  };
  try {
    const identity = await githubOAuth.exchangeGitHubCode({
      clientId: "client-id",
      clientSecret: "client-secret",
      origin: "https://oa.example.com",
      callbackUrl: "https://oa.example.com/api/auth/github/callback",
    }, "authorization-code", "pkce-verifier");
    assert.deepEqual(identity, {
      providerSubject: "583231",
      login: "octocat",
      verifiedEmail: "octocat@example.com",
      displayName: "The Octocat",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 3);
  const tokenBody = new URLSearchParams(requests[0].init.body);
  assert.equal(tokenBody.get("code"), "authorization-code");
  assert.equal(tokenBody.get("code_verifier"), "pkce-verifier");
  assert.equal(tokenBody.get("redirect_uri"), "https://oa.example.com/api/auth/github/callback");
  for (const request of requests.slice(1)) {
    const headers = new Headers(request.init.headers);
    assert.equal(headers.get("authorization"), "Bearer mock");
    assert.equal(headers.get("x-github-api-version"), "2026-03-10");
  }
});

test("GitHub OAuth 对限流、非 JSON、部分 API 失败和超时均失败关闭", async (t) => {
  const config = {
    clientId: "client-id",
    clientSecret: "client-secret",
    origin: "https://oa.example.com",
    callbackUrl: "https://oa.example.com/api/auth/github/callback",
  };
  const originalFetch = globalThis.fetch;
  async function expectFailure(mockFetch, pattern) {
    globalThis.fetch = mockFetch;
    try {
      await assert.rejects(
        githubOAuth.exchangeGitHubCode(config, "authorization-code", "pkce-verifier"),
        pattern,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  await t.test("令牌接口限流", async () => {
    await expectFailure(async () => Response.json({ error: "rate_limited" }, { status: 429 }), /exchange failed/i);
  });
  await t.test("令牌接口返回非 JSON", async () => {
    await expectFailure(async () => new Response("upstream error", { status: 502, headers: { "content-type": "text/plain" } }), /unexpected response/i);
  });
  await t.test("邮箱接口部分失败", async () => {
    await expectFailure(async (input) => {
      const url = String(input);
      if (url.includes("access_token")) return Response.json({ access_token: "mock" });
      if (url.endsWith("/user")) return Response.json({ id: 583231, login: "octocat" });
      return Response.json({ message: "rate limited" }, { status: 429 });
    }, /could not be verified/i);
  });
  await t.test("上游请求超时", async () => {
    await expectFailure(async () => { throw new DOMException("request timed out", "TimeoutError"); }, /timed out/i);
  });
});

test("NDA 准入只把当前协议版本视为可继续流转的记录", () => {
  const legacy = { id: "nda-legacy", type: "保密协议", status: "已归档", payload: { agreementVersion: "NDA-2026-08" } };
  const current = { id: "nda-current", type: "保密协议", status: "待审核", payload: { agreementVersion: ndaAgreement.NDA_AGREEMENT_VERSION } };
  const inconsistentArchive = { id: "nda-current-archive", type: "保密协议", status: "已归档", payload: { agreementVersion: ndaAgreement.NDA_AGREEMENT_VERSION } };
  assert.equal(ndaAgreement.isCurrentNdaAgreementPayload(legacy.payload), false);
  assert.equal(ndaAgreement.isCurrentNdaAgreementPayload(current.payload), true);
  assert.equal(ndaAgreement.isCurrentNdaAgreementPayload({}), false);
  assert.equal(ndaAgreement.selectCurrentNdaApproval([legacy, current], "nda-legacy"), current);
  assert.equal(ndaAgreement.selectCurrentNdaApproval([legacy], "nda-legacy"), null);
  assert.equal(ndaAgreement.selectCurrentNdaApproval([inconsistentArchive], inconsistentArchive.id), null);
});

test("撤回的 NDA 复用同一记录重签，作废记录不再阻塞新签署", () => {
  const withdrawn = { id: "nda-withdrawn", type: "保密协议", status: "已撤回", payload: { agreementVersion: ndaAgreement.NDA_AGREEMENT_VERSION } };
  const voided = { id: "nda-voided", type: "保密协议", status: "已作废", payload: { agreementVersion: ndaAgreement.NDA_AGREEMENT_VERSION } };
  assert.equal(ndaAgreement.selectCurrentNdaApproval([withdrawn], withdrawn.id), withdrawn);
  assert.equal(ndaAgreement.selectCurrentNdaApproval([voided], voided.id), null);
});

test("保密文件按角色使用独立模板、版本和审核节点", () => {
  assert.equal(ndaAgreement.confidentialityAgreementKindForRole("member"), "member");
  assert.equal(ndaAgreement.confidentialityAgreementKindForRole("technical_advisor"), "member");
  assert.equal(ndaAgreement.confidentialityAgreementKindForRole("project_owner"), "project_owner");
  assert.equal(ndaAgreement.confidentialityAgreementVersion("member"), ndaAgreement.NDA_AGREEMENT_VERSION);
  assert.equal(ndaAgreement.confidentialityAgreementVersion("project_owner"), ndaAgreement.PROJECT_OWNER_PLEDGE_VERSION);
  assert.equal(ndaAgreement.confidentialityAgreementTitle("project_owner"), "项目负责人保密承诺书");
  assert.equal(ndaAgreement.confidentialityAgreementReviewerStep("member"), "项目负责人");
  assert.equal(ndaAgreement.confidentialityAgreementReviewerStep("project_owner"), "OA管理员");
});

test("成员保密协议签署后直接归档，负责人承诺书仍按管理员身份分流", () => {
  assert.equal(ndaAgreement.shouldAutoArchiveConfidentialityAgreement("member", false), true);
  assert.equal(ndaAgreement.shouldAutoArchiveConfidentialityAgreement("member", true), true);
  assert.equal(ndaAgreement.shouldAutoArchiveConfidentialityAgreement("project_owner", false), false);
  assert.equal(ndaAgreement.shouldAutoArchiveConfidentialityAgreement("project_owner", true), true);

  const memberText = ndaAgreement.buildNdaAgreementText("签署成员", "代码与图纸", "member");
  assert.match(memberText, /协议立即生效并由系统自动归档/);
  assert.match(memberText, /无需项目负责人另行审核/);
  assert.match(memberText, /项目负责人可在 OA 中查阅/);
  assert.doesNotMatch(memberText, /提交项目负责人审核/);

  assert.equal(approvalPolicy.workflowRevisionsNeededAfterMaterial("保密协议", { autoArchived: true }), 0);
  assert.equal(approvalPolicy.workflowRevisionsNeededAfterMaterial("保密协议", {}), 1);
});

test("负责人承诺书可满足成员准入，成员协议不能满足负责人准入", () => {
  assert.equal(ndaAgreement.isConfidentialityAgreementVersionAcceptedForRole("member", ndaAgreement.NDA_AGREEMENT_VERSION), true);
  assert.equal(ndaAgreement.isConfidentialityAgreementVersionAcceptedForRole("member", ndaAgreement.LEGACY_NDA_AGREEMENT_VERSION), true);
  assert.equal(ndaAgreement.isConfidentialityAgreementVersionAcceptedForRole("member", ndaAgreement.PROJECT_OWNER_PLEDGE_VERSION), true);
  assert.equal(ndaAgreement.isConfidentialityAgreementVersionAcceptedForRole("project_owner", ndaAgreement.LEGACY_NDA_AGREEMENT_VERSION), false);
  assert.equal(ndaAgreement.isConfidentialityAgreementVersionAcceptedForRole("project_owner", ndaAgreement.NDA_AGREEMENT_VERSION), false);
  assert.equal(ndaAgreement.isConfidentialityAgreementVersionAcceptedForRole("project_owner", ndaAgreement.PROJECT_OWNER_PLEDGE_VERSION), true);
});

test("旧成员协议保持兼容，负责人准入只选择负责人承诺书", () => {
  const legacyMember = { id: "member-old", type: "保密协议", status: "待审核", payload: { agreementVersion: ndaAgreement.LEGACY_NDA_AGREEMENT_VERSION } };
  const ownerPledge = { id: "owner-pledge", type: "保密协议", status: "待审核", payload: { agreementKind: "project_owner", agreementVersion: ndaAgreement.PROJECT_OWNER_PLEDGE_VERSION } };
  assert.equal(ndaAgreement.isCurrentNdaAgreementPayload(legacyMember.payload, "member"), false);
  assert.equal(ndaAgreement.isCurrentNdaAgreementPayload(legacyMember.payload, "project_owner"), false);
  assert.equal(ndaAgreement.isCurrentNdaAgreementPayload(ownerPledge.payload, "project_owner"), true);
  assert.equal(ndaAgreement.selectCurrentNdaApproval([legacyMember], legacyMember.id, "member"), legacyMember);
  assert.equal(ndaAgreement.selectCurrentNdaApproval([legacyMember, ownerPledge], legacyMember.id, "project_owner"), ownerPledge);
});

test("成员协议与负责人承诺书使用不同业务主键和不可变证据", async () => {
  const subject = "email:signer@example.com";
  assert.notEqual(ndaAgreement.ndaBusinessKey(subject), ndaAgreement.ndaBusinessKey(subject, "project_owner"));
  const common = {
    signerName: "签署人",
    signerEmail: "signer@example.com",
    signerAccountUserId: subject,
    confidentialScope: "项目技术资料",
    signatureDataUrl: "data:image/png;base64,aW1tdXRhYmxlLXNpZ25hdHVyZQ==",
    signedAt: "2026-09-02T00:00:00.000Z",
  };
  const member = await approvalPolicy.createNdaIntegrityRecord({ ...common, agreementKind: "member" });
  const owner = await approvalPolicy.createNdaIntegrityRecord({ ...common, agreementKind: "project_owner" });
  assert.notEqual(member.agreementTextSnapshot, owner.agreementTextSnapshot);
  assert.notEqual(member.agreementHash, owner.agreementHash);
  assert.notEqual(member.recordHash, owner.recordHash);
  assert.equal(member.signatureHash, owner.signatureHash);
});

test("旧版成员协议按原正文重算，新版直归档正文使用独立版本与哈希", async () => {
  const common = {
    signerName: "签署人",
    signerEmail: "signer@example.com",
    signerAccountUserId: "email:signer@example.com",
    confidentialScope: "项目技术资料",
    signatureDataUrl: "data:image/png;base64,aW1tdXRhYmxlLXNpZ25hdHVyZQ==",
    signedAt: "2026-09-02T00:00:00.000Z",
    agreementKind: "member",
  };
  const legacy = await approvalPolicy.createNdaIntegrityRecord({
    ...common,
    agreementVersion: ndaAgreement.LEGACY_NDA_AGREEMENT_VERSION,
  });
  const current = await approvalPolicy.createNdaIntegrityRecord({
    ...common,
    agreementVersion: ndaAgreement.NDA_AGREEMENT_VERSION,
  });

  assert.match(legacy.agreementTextSnapshot, /提交项目负责人审核/);
  assert.doesNotMatch(legacy.agreementTextSnapshot, /系统自动归档，无需项目负责人/);
  assert.match(current.agreementTextSnapshot, /系统自动归档，无需项目负责人/);
  assert.notEqual(legacy.agreementHash, current.agreementHash);
  assert.notEqual(legacy.recordHash, current.recordHash);
  assert.equal(
    ndaAgreement.buildNdaAgreementTextForVersion("签署人", "项目技术资料", "member", ndaAgreement.LEGACY_NDA_AGREEMENT_VERSION),
    legacy.agreementTextSnapshot,
  );
});

test("项目负责人保密承诺书由 OA 管理员确认后归档", () => {
  assert.equal(approvalPolicy.workflowAllows("保密协议", "OA管理员", "approve", "待审核"), true);
  assert.equal(approvalPolicy.workflowAllows("保密协议", "OA管理员", "return", "审批中"), true);
  assert.equal(approvalPolicy.nextWorkflowStep("保密协议", "OA管理员", "approve"), "已归档");
  assert.equal(approvalPolicy.nextWorkflowStep("保密协议", "OA管理员", "return"), "补充材料");
});

test("OA 管理员身份本身不再绕过保密文件准入", () => {
  assert.equal(approvalPolicy.hasCompletedNda({ isAdmin: true, ndaCompleted: false }), false);
  assert.equal(approvalPolicy.hasCompletedNda({ isAdmin: true, ndaCompleted: true }), true);
});

test("NDA 证据哈希区分不同认证账户主体", async () => {
  const common = {
    signerName: "签署人",
    signerEmail: "recycled@example.com",
    confidentialScope: "项目源代码",
    signatureDataUrl: "data:image/png;base64,aW1tdXRhYmxlLXNpZ25hdHVyZQ==",
    signedAt: "2026-09-01T00:00:00.000Z",
  };
  const first = await approvalPolicy.createNdaIntegrityRecord({ ...common, signerAccountUserId: "email:first@example.com" });
  const second = await approvalPolicy.createNdaIntegrityRecord({ ...common, signerAccountUserId: "email:second@example.com" });
  assert.notEqual(first.recordHash, second.recordHash);
});

function archiveFixture(payloadJson) {
  return {
    approval: {
      id: "approval-001",
      type: "保密协议",
      title: "研发保密协议",
      project: "OriginMind × ARTS Robotics",
      requesterName: "签署人",
      requesterEmail: "signer@example.com",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T02:00:00.000Z",
      status: "已归档",
      currentStep: "已归档",
      summary: "NDA 已实名签署并审批通过",
      owner: "项目负责人",
      amount: null,
      signersJson: '[{"name":"签署人","email":"signer@example.com"}]',
      payloadJson,
    },
    events: [
      {
        actorName: "签署人",
        actorEmail: "signer@example.com",
        action: "submit",
        note: "本人签署",
        createdAt: "2026-09-01T00:00:00.000Z",
      },
      {
        actorName: "项目负责人",
        actorEmail: "owner@example.com",
        action: "approve",
        note: "同意归档",
        createdAt: "2026-09-01T02:00:00.000Z",
      },
    ],
  };
}

test("归档 canonical 与 SHA-256 对同一记录保持确定性", async () => {
  const signatureDataUrl = `data:image/png;base64,${"c2lnbmF0dXJl".repeat(16)}`;
  const fixture = archiveFixture(
    JSON.stringify({ signatureDataUrl, zeta: 2, nested: { beta: 2, alpha: 1 } }),
  );

  const first = await archiveManifest.buildArchiveManifest(
    fixture.approval,
    fixture.events,
  );
  const second = await archiveManifest.buildArchiveManifest(
    fixture.approval,
    fixture.events,
  );

  assert.equal(first.canonical, second.canonical);
  assert.equal(first.hash, second.hash);
  assert.match(first.hash, /^[a-f0-9]{64}$/);
  assert.equal(
    archiveManifest.canonicalJson({ zeta: 2, nested: { beta: 2, alpha: 1 } }),
    archiveManifest.canonicalJson({ nested: { alpha: 1, beta: 2 }, zeta: 2 }),
  );
});

test("v2 可核验归档 manifest 从真实退回重提链生成确定性终局证据", async () => {
  const signatureDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const approvalId = "approval-nda-v2-chain";
  const baseApproval = {
    id: approvalId,
    type: "保密协议",
    title: "OriginMind 联合研发保密协议",
    project: "OriginMind × ARTS Robotics",
    requesterName: "签署人",
    requesterEmail: "signer@example.com",
    createdAt: "2026-09-01T00:00:00.000Z",
    owner: "项目负责人",
    amount: null,
  };
  const stages = [
    {
      mutationRevision: "00000000-0000-4000-8000-000000000001",
      state: {
        ...baseApproval,
        updatedAt: "2026-09-01T00:00:00.000Z",
        status: "待审核",
        currentStep: "项目负责人",
        summary: "签署人提交 NDA 实名签署材料",
        signersJson: JSON.stringify(["签署人"]),
        payloadJson: JSON.stringify({
          agreementVersion: "NDA-2026-09",
          signerAccountUserId: "account-signer-001",
          signatureDataUrl,
          workflowMutationRevision: "00000000-0000-4000-8000-000000000001",
        }),
      },
      event: {
        actorName: "签署人",
        actorEmail: "signer@example.com",
        action: "submit",
        note: "本人签署并提交",
        occurredAt: "2026-09-01T00:00:00.000Z",
      },
    },
    {
      mutationRevision: "00000000-0000-4000-8000-000000000002",
      state: {
        ...baseApproval,
        updatedAt: "2026-09-01T01:00:00.000Z",
        status: "已退回",
        currentStep: "补充材料",
        summary: "签署人提交 NDA 实名签署材料\n\n退回原因：签署范围需要补充",
        signersJson: JSON.stringify(["签署人"]),
        payloadJson: JSON.stringify({
          agreementVersion: "NDA-2026-09",
          signerAccountUserId: "account-signer-001",
          signatureDataUrl,
          workflowMutationRevision: "00000000-0000-4000-8000-000000000002",
        }),
      },
      event: {
        actorName: "项目负责人",
        actorEmail: "owner@example.com",
        action: "return",
        note: "请补充联合研发源代码与技术资料范围",
        occurredAt: "2026-09-01T01:00:00.000Z",
      },
    },
    {
      mutationRevision: "00000000-0000-4000-8000-000000000003",
      state: {
        ...baseApproval,
        updatedAt: "2026-09-01T02:00:00.000Z",
        status: "待审核",
        currentStep: "项目负责人",
        summary: "签署人提交 NDA 实名签署材料\n\n补充说明：已补充保密范围",
        signersJson: JSON.stringify(["签署人"]),
        payloadJson: JSON.stringify({
          agreementVersion: "NDA-2026-09",
          confidentialScope: "联合研发源代码、模型、图纸与技术资料",
          signerAccountUserId: "account-signer-001",
          signatureDataUrl,
          workflowMutationRevision: "00000000-0000-4000-8000-000000000003",
        }),
      },
      event: {
        actorName: "签署人",
        actorEmail: "signer@example.com",
        action: "resubmit",
        note: "已补充保密范围并重新提交",
        occurredAt: "2026-09-01T02:00:00.000Z",
      },
    },
    {
      mutationRevision: "00000000-0000-4000-8000-000000000004",
      state: {
        ...baseApproval,
        updatedAt: "2026-09-01T03:00:00.000Z",
        status: "已归档",
        currentStep: "已归档",
        summary: "签署人提交 NDA 实名签署材料\n\n补充说明：已补充保密范围",
        signersJson: JSON.stringify(["签署人", "项目负责人"]),
        payloadJson: JSON.stringify({
          agreementVersion: "NDA-2026-09",
          archivedAt: "2026-09-01T03:00:00.000Z",
          confidentialScope: "联合研发源代码、模型、图纸与技术资料",
          signerAccountUserId: "account-signer-001",
          signatureDataUrl,
          workflowMutationRevision: "00000000-0000-4000-8000-000000000004",
        }),
      },
      event: {
        actorName: "项目负责人",
        actorEmail: "owner@example.com",
        action: "approve",
        note: "实名复核通过并归档",
        occurredAt: "2026-09-01T03:00:00.000Z",
      },
    },
  ];

  const revisions = [];
  let previousRevisionHash = null;
  for (const [index, stage] of stages.entries()) {
    const revision = await approvalRevisions.buildApprovalRevision({
      nextApproval: stage.state,
      revisionNo: index + 1,
      previousRevisionHash,
      mutation: { workflowMutationRevision: stage.mutationRevision },
      event: stage.event,
    });
    revisions.push({
      ...revision,
      approvalId,
      mutationRevision: stage.mutationRevision,
      createdAt: stage.event.occurredAt,
    });
    previousRevisionHash = revision.revisionHash;
  }

  const terminalRevision = revisions.at(-1);
  const terminalApproval = {
    ...stages.at(-1).state,
    currentRevisionNo: terminalRevision.revisionNo,
    currentRevisionHash: terminalRevision.revisionHash,
  };
  const events = stages.map((stage, index) => ({
    id: index + 1,
    actorName: stage.event.actorName,
    actorEmail: stage.event.actorEmail,
    action: stage.event.action,
    note: stage.event.note,
    createdAt: stage.event.occurredAt,
  }));

  const first = await archiveManifest.buildArchiveManifest(
    terminalApproval,
    events,
    revisions,
  );
  const reordered = await archiveManifest.buildArchiveManifest(
    terminalApproval,
    [...events].reverse(),
    [revisions[2], revisions[0], revisions[3], revisions[1]],
  );
  const archivedRecord = JSON.parse(first.archiveCanonical);

  assert.equal(first.schemaVersion, 2);
  assert.equal(first.terminalRevisionNo, 4);
  assert.equal(first.terminalRevisionHash, terminalRevision.revisionHash);
  assert.equal(first.terminalStateHash, terminalRevision.stateHash);
  assert.deepEqual(archivedRecord.revisions.map((revision) => revision.revisionNo), [1, 2, 3, 4]);
  assert.deepEqual(
    archivedRecord.revisions.map((revision) => revision.event.action),
    ["submit", "return", "resubmit", "approve"],
  );
  assert.equal(archivedRecord.revisions[1].previousRevisionHash, revisions[0].revisionHash);
  assert.equal(archivedRecord.revisions[3].revisionHash, terminalRevision.revisionHash);
  assert.equal(archivedRecord.approval.status, "已归档");
  assert.equal(archivedRecord.approval.payload.signatureDataUrl.redacted, true);
  assert.equal(first.archiveCanonical.includes(signatureDataUrl), false);
  assert.equal(first.canonical.includes(signatureDataUrl), true);
  assert.match(first.markdown, /证据模式：不可变材料修订链 v2/);
  assert.match(first.markdown, /终局材料版本：第 4 版/);
  assert.match(first.markdown, /## 不可变材料版本链/);
  assert.equal(first.hash, reordered.hash);
  assert.equal(first.fileHash, reordered.fileHash);
  assert.equal(await archiveManifest.sha256Hex(first.archiveCanonical), first.hash);
  assert.equal(await archiveManifest.sha256Hex(first.markdown), first.fileHash);
});

test("归档事件以时间和事件编号稳定排序", async () => {
  const fixture = archiveFixture(JSON.stringify({ value: 1 }));
  const sameTime = "2026-09-01T03:00:00.000Z";
  const events = [
    { ...fixture.events[0], id: 8, createdAt: sameTime, action: "second" },
    { ...fixture.events[1], id: 7, createdAt: sameTime, action: "first" },
  ];

  const forward = await archiveManifest.buildArchiveManifest(fixture.approval, events);
  const reversed = await archiveManifest.buildArchiveManifest(fixture.approval, [...events].reverse());

  assert.equal(forward.hash, reversed.hash);
  assert.equal(forward.archiveCanonical, reversed.archiveCanonical);
  assert.ok(forward.archiveCanonical.indexOf('"id":7') < forward.archiveCanonical.indexOf('"id":8'));
});

test("归档更正或废止说明只改变补充版 manifest，不覆盖原归档正文", async () => {
  const fixture = archiveFixture(JSON.stringify({ archivedAt: "2026-09-01T02:00:00.000Z", value: 1 }));
  const originalApproval = structuredClone(fixture.approval);
  const original = await archiveManifest.buildArchiveManifest(fixture.approval, fixture.events);
  const supplemented = await archiveManifest.buildArchiveManifest(fixture.approval, [
    ...fixture.events,
    {
      id: 99,
      actorName: "签署人",
      actorEmail: "signer@example.com",
      action: "archive_void_notice",
      note: "因后续业务条件变化，追加废止说明但保留原归档证据。",
      createdAt: "2026-09-02T00:00:00.000Z",
    },
  ]);
  assert.notEqual(supplemented.hash, original.hash);
  assert.notEqual(supplemented.fileHash, original.fileHash);
  assert.deepEqual(fixture.approval, originalApproval);
  assert.equal(JSON.parse(supplemented.archiveCanonical).approval.status, "已归档");
  assert.match(supplemented.archiveCanonical, /archive_void_notice/);
});

test("归档 Markdown 不泄露签名原文且可独立复算脱敏记录哈希", async () => {
  const signatureDataUrl = `data:image/png;base64,${"c2VjcmV0LXNpZ25hdHVyZQ==".repeat(8)}`;
  const fixture = archiveFixture(
    JSON.stringify({ confidentialScope: "项目源代码", signatureDataUrl }),
  );
  const result = await archiveManifest.buildArchiveManifest(
    fixture.approval,
    fixture.events,
  );

  assert.ok(result.signatureEvidence);
  assert.equal(result.signatureEvidence.format, "image/png");
  assert.doesNotMatch(result.markdown, new RegExp(signatureDataUrl));
  assert.match(result.markdown, /"redacted": true/);
  assert.equal(result.signatureEvidence.encoding, "data-url");
  assert.match(result.markdown, new RegExp(result.signatureEvidence.dataUrlSha256));
  assert.equal(await archiveManifest.sha256Hex(result.archiveCanonical), result.hash);
  assert.equal(await archiveManifest.sha256Hex(result.markdown), result.fileHash);
  assert.match(result.markdown, new RegExp(result.hash));
  assert.match(result.markdown, new RegExp(result.evidenceRecordHash));
  assert.match(result.canonical, /data:image\/png;base64/);
});

test("归档文件名净化路径与操作系统保留字符", () => {
  const fileName = archiveManifest.safeArchiveFileName(
    {
      id: "approval-001",
      title: '  NDA / 研发\\签署 : * ? " < > |  ',
    },
    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  );

  assert.equal(fileName, "approval-001-NDA - 研发-签署 - - - - - - --abcdef012345.md");
  assert.doesNotMatch(fileName, /[\\/:*?"<>|]/);
});

test("归档文件名同时净化外部传入的申请编号", () => {
  const fileName = archiveManifest.safeArchiveFileName(
    { id: "../../审批/../evil", title: "归档" },
    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  );

  assert.equal(fileName, "evil-归档-abcdef012345.md");
  assert.doesNotMatch(fileName, /\.\.|\//);
});

test("归档文件名移除 Unicode 双向控制字符", () => {
  const fileName = archiveManifest.safeArchiveFileName(
    { id: "approval-001", title: "安全\u202Efdp.exe" },
    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  );

  assert.equal(fileName, "approval-001-安全fdp.exe-abcdef012345.md");
  assert.doesNotMatch(fileName, /[\u202a-\u202e]/);
});

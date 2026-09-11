import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

const approvalPdf = await vite.ssrLoadModule("/lib/approval-pdf.ts");
const approvalRevisions = await vite.ssrLoadModule("/lib/approval-revisions.ts");
const feishuArchive = await vite.ssrLoadModule("/lib/feishu-drive-archive.ts");

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
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

function signatureDataUrl() {
  const width = 900;
  const height = 260;
  const rows = Buffer.alloc((width * 4 + 1) * height, 255);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (width * 4 + 1);
    rows[rowOffset] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = rowOffset + 1 + x * 4;
      const ink = x >= 230 && x <= 660 && Math.abs(y - (70 + Math.floor((x - 230) / 4))) < 8;
      rows[pixel] = ink ? 24 : 255;
      rows[pixel + 1] = ink ? 60 : 255;
      rows[pixel + 2] = ink ? 55 : 255;
      rows[pixel + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return `data:image/png;base64,${Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]).toString("base64")}`;
}

function archivedApproval() {
  return {
    id: "NDA-20260905-001",
    type: "保密协议",
    title: "源灵智能项目成员保密协议",
    project: "OriginMind × ARTS Robotics 联合研发项目",
    requesterName: "王心远",
    requesterEmail: "member@example.com",
    createdAt: "2026-09-05T01:10:00.000Z",
    updatedAt: "2026-09-05T02:20:00.000Z",
    status: "已归档",
    currentStep: "已归档",
    currentReviewerName: "",
    currentReviewerEmail: "",
    summary: "确认项目保密范围并完成本人实名手写签署。",
    owner: "王心远",
    amount: null,
    signers: ["王心远"],
    payload: {
      agreementKind: "member",
      agreementVersion: "NDA-2026-09-R2",
      signerName: "王心远",
      signerEmail: "member@example.com",
      signerAccountUserId: "acct_chatgpt_1234567890abcdefghijklmnopqrstuvwxyz",
      confidentialScope: "代码、图纸、BOM、测试数据和样机资料",
      signedAt: "2026-09-05T01:12:00.000Z",
      signatureDataUrl: signatureDataUrl(),
      previewed: true,
      agreed: true,
    },
  };
}

test("正式 PDF 对相同归档确定生成，并包含中文字体、手写签名和分页结构", async () => {
  const input = {
    approval: archivedApproval(),
    events: [{ id: 1, actorName: "王心远", actorEmail: "member@example.com", action: "系统自动归档", note: "本人签署后直接归档", createdAt: "2026-09-05T02:20:00.000Z" }],
    integrity: {
      archiveHash: "a".repeat(64),
      evidenceRecordHash: "b".repeat(64),
      schemaVersion: 1,
      terminalRevisionNo: null,
      terminalRevisionHash: null,
      terminalStateHash: null,
    },
  };
  const first = await approvalPdf.buildApprovalPdf(input);
  const second = await approvalPdf.buildApprovalPdf(input);
  assert.deepEqual(first, second);
  const binary = Buffer.from(first);
  assert.equal(binary.subarray(0, 8).toString("latin1"), "%PDF-1.7");
  assert.match(binary.toString("latin1"), /\/BaseFont \/STSong-Light/u);
  assert.match(binary.toString("latin1"), /\/FontFile2/u);
  assert.match(binary.toString("latin1"), /\/CIDToGIDMap 7 0 R/u);
  assert.match(binary.toString("latin1"), /\/BaseFont \/NotoSansSC-OA/u);
  assert.match(binary.toString("latin1"), /<6E90> <6E90>/u);
  assert.match(binary.toString("latin1"), /\/Subtype \/Image/u);
  assert.match(binary.toString("latin1"), /\/Type \/Pages \/Count [1-9]/u);
  assert.ok(binary.length > 5_000);
  const fileName = approvalPdf.safeApprovalPdfFileName(input.approval, input.integrity.archiveHash);
  assert.match(fileName, /^202609051020-NDA-20260905-001-源灵智能项目成员保密协议-a{12}\.pdf$/u);
  const feishuFileName = approvalPdf.safeFeishuArchivePdfFileName(input.approval, input.integrity.archiveHash);
  assert.match(feishuFileName, /^OA-202609051020-NDA-20260905-001-a{12}\.pdf$/u);
  assert.match(feishuFileName, /^[\x20-\x7e]+$/u);
  const longFeishuFileName = approvalPdf.safeFeishuArchivePdfFileName({ ...input.approval, title: "超长标题".repeat(80) }, input.integrity.archiveHash);
  assert.ok(longFeishuFileName.length <= 180);
  assert.match(longFeishuFileName, /\.pdf$/u);
});

test("技术、采购、保密和劳务四种审批都能生成独立 PDF", async () => {
  const base = archivedApproval();
  const cases = [
    { type: "技术审核", payload: { robotPart: "运动控制", technicalContent: "完成关节控制算法和测试验证", totalWorkHours: 42, developers: [{ name: "成员甲", email: "a@example.com", work: "控制算法", ratio: 100 }] } },
    { type: "采购审核", payload: { itemSpec: "测试传感器 A1", quantity: 2, amount: 1800, purpose: "样机测试", supplier: "合格供应商", purchaserName: "成员乙", purchaseNote: "已验收并入库" } },
    { type: "保密协议", payload: base.payload },
    { type: "劳务报酬", payload: { month: "2026-09", selectedSources: [{ id: "TECH-001", title: "关节控制开发", weightedHours: 32 }], otherMonthlyWorkHours: 8, monthlyStatement: "完成算法、测试及问题修复", totalScore: 40, finalAmount: 4000 } },
  ];
  for (const [index, item] of cases.entries()) {
    const pdf = await approvalPdf.buildApprovalPdf({
      approval: { ...base, id: `OA-${index + 1}`, type: item.type, title: `${item.type}测试文件`, payload: item.payload },
      events: [],
    });
    assert.equal(Buffer.from(pdf).subarray(0, 8).toString("latin1"), "%PDF-1.7");
    assert.ok(pdf.byteLength > 2_000);
  }
});

class FakeD1 {
  constructor(approval) {
    this.approval = {
      id: approval.id,
      type: approval.type,
      title: approval.title,
      project: approval.project,
      requester_name: approval.requesterName,
      requester_email: approval.requesterEmail,
      client_creation_key: "client-nda-001",
      business_key: "nda|account-member-001|member",
      created_at: approval.createdAt,
      updated_at: approval.updatedAt,
      status: approval.status,
      current_step: approval.currentStep,
      current_reviewer_name: "",
      current_reviewer_email: "",
      summary: approval.summary,
      owner: approval.owner,
      amount: null,
      period_key: null,
      signers_json: JSON.stringify(approval.signers),
      payload_json: JSON.stringify(approval.payload),
      current_revision_no: 0,
      current_revision_hash: null,
    };
    this.revisions = [];
    this.archive = null;
  }

  prepare(sql) {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    let args = [];
    return {
      bind: (...values) => { args = values; return this.prepareBound(normalized, () => args); },
      first: () => this.first(normalized, args),
      all: () => this.all(normalized, args),
      run: () => this.run(normalized, args),
    };
  }

  prepareBound(sql, getArgs) {
    return {
      first: () => this.first(sql, getArgs()),
      all: () => this.all(sql, getArgs()),
      run: () => this.run(sql, getArgs()),
    };
  }

  async first(sql) {
    if (sql.includes("FROM approvals WHERE")) return this.approval;
    if (sql.includes("FROM external_archives WHERE")) return this.archive;
    throw new Error(`Unexpected first SQL: ${sql}`);
  }

  async all(sql) {
    if (sql.includes("FROM approval_events")) return { results: [{ id: 1, approval_id: this.approval.id, actor_name: "王心远", actor_email: "member@example.com", action: "auto_archived", note: "本人签署后直接归档", created_at: this.approval.updated_at }] };
    if (sql.includes("FROM approval_revisions")) return { results: this.revisions };
    if (sql.includes("FROM auth_identities")) return { results: [{ email: "admin@example.com", open_id: "ou_admin123456" }] };
    throw new Error(`Unexpected all SQL: ${sql}`);
  }

  async run(sql, args) {
    if (sql.startsWith("INSERT OR IGNORE INTO external_archives")) {
      if (!this.archive) this.archive = { id: args[0], approval_id: args[1], destination: args[2], manifest_hash: args[3], content_hash: args[4], file_name: args[5], status: "pending", file_token: null, source_revision_hash: args[6], lease_token: args[7], lease_expires_at: args[8], error_code: null };
      return { meta: { changes: this.archive.id === args[0] ? 1 : 0 } };
    }
    if (sql.includes("SET status = 'uploaded'")) {
      if (this.archive?.id === args[2] && this.archive.lease_token === args[3]) {
        this.archive = { ...this.archive, status: "uploaded", file_token: args[0], lease_token: null, lease_expires_at: null, error_code: null };
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (sql.includes("SET status = 'failed'")) return { meta: { changes: 1 } };
    if (sql.includes("SET content_hash = ?")) return { meta: { changes: 0 } };
    throw new Error(`Unexpected run SQL: ${sql}`);
  }
}

test("飞书归档按年月和文件类型建目录、授予管理员权限，并通过台账避免重复上传", async () => {
  const originalFetch = globalThis.fetch;
  const folders = new Map([["", []]]);
  let folderSequence = 0;
  let permissionGranted = false;
  let uploadCount = 0;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push(`${init.method || "GET"} ${url.pathname}`);
    if (url.pathname.endsWith("/tenant_access_token/internal")) return Response.json({ code: 0, msg: "ok", tenant_access_token: "tenant-token" });
    if (url.pathname === "/open-apis/drive/v1/files" && (init.method || "GET") === "GET") {
      const parent = url.searchParams.get("folder_token") || "";
      return Response.json({ code: 0, msg: "ok", data: { files: folders.get(parent) || [] } });
    }
    if (url.pathname === "/open-apis/drive/v1/files/create_folder") {
      const body = JSON.parse(String(init.body));
      const token = `fld_${++folderSequence}`;
      const entries = folders.get(body.folder_token) || [];
      entries.push({ token, name: body.name, type: "folder" });
      folders.set(body.folder_token, entries);
      folders.set(token, []);
      return Response.json({ code: 0, msg: "ok", data: { token } });
    }
    if (url.pathname.includes("/permissions/") && (init.method || "GET") === "GET") {
      return Response.json({ code: 0, msg: "ok", data: { members: permissionGranted ? [{ member_type: "openid", member_id: "ou_admin123456", perm: "full_access" }] : [] } });
    }
    if (url.pathname.includes("/permissions/") && init.method === "POST") {
      permissionGranted = true;
      return Response.json({ code: 0, msg: "ok", data: {} });
    }
    if (url.pathname === "/open-apis/drive/v1/files/upload_all") {
      uploadCount += 1;
      const form = init.body;
      assert.equal(form.get("parent_type"), "explorer");
      assert.match(form.get("file_name"), /\.pdf$/u);
      assert.ok(Number(form.get("size")) > 5_000);
      assert.equal((await form.get("file").text()).slice(0, 8), "%PDF-1.7");
      return Response.json({ code: 0, msg: "ok", data: { file_token: "box_pdf_001" } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const db = new FakeD1(archivedApproval());
    const revisionState = {
      id: db.approval.id,
      type: db.approval.type,
      title: db.approval.title,
      project: db.approval.project,
      requesterName: db.approval.requester_name,
      requesterEmail: db.approval.requester_email,
      clientCreationKey: db.approval.client_creation_key,
      businessKey: db.approval.business_key,
      createdAt: db.approval.created_at,
      updatedAt: db.approval.updated_at,
      status: db.approval.status,
      currentStep: db.approval.current_step,
      currentReviewerName: db.approval.current_reviewer_name,
      currentReviewerEmail: db.approval.current_reviewer_email,
      summary: db.approval.summary,
      owner: db.approval.owner,
      amount: db.approval.amount,
      periodKey: db.approval.period_key,
      signersJson: db.approval.signers_json,
      payloadJson: db.approval.payload_json,
    };
    const terminalRevision = await approvalRevisions.buildApprovalRevision({
      nextApproval: revisionState,
      revisionNo: 1,
      previousRevisionHash: null,
      mutation: { workflowMutationRevision: "00000000-0000-4000-8000-000000000001" },
      event: { actorName: "王心远", actorEmail: "member@example.com", action: "auto_archived", note: "本人签署后直接归档", occurredAt: db.approval.updated_at },
    });
    db.approval.current_revision_no = terminalRevision.revisionNo;
    db.approval.current_revision_hash = terminalRevision.revisionHash;
    db.revisions = [{
      revision_hash: terminalRevision.revisionHash,
      approval_id: db.approval.id,
      revision_no: terminalRevision.revisionNo,
      previous_revision_hash: terminalRevision.previousRevisionHash,
      mutation_revision: "00000000-0000-4000-8000-000000000001",
      state_json: terminalRevision.stateJson,
      state_hash: terminalRevision.stateHash,
      event_json: terminalRevision.eventJson,
      created_at: db.approval.updated_at,
    }];
    const env = { DB: db, FEISHU_PDF_ARCHIVE_ENABLED: "true", FEISHU_LOGIN_APP_ID: "cli_test", FEISHU_LOGIN_APP_SECRET: "secret", OA_ADMIN_EMAILS: "admin@example.com" };
    const first = await feishuArchive.archiveApprovalPdfToFeishu(env, archivedApproval().id);
    assert.deepEqual(first, { status: "uploaded", fileToken: "box_pdf_001" });
    assert.equal(uploadCount, 1);
    assert.equal(permissionGranted, true);
    assert.deepEqual(Array.from(folders.values()).flat().map((entry) => entry.name), ["OriginMind OA 归档", "2026年", "09月", "保密协议"]);
    assert.equal(db.archive.destination, "feishu_drive_pdf_v2");
    assert.equal(db.archive.status, "uploaded");
    const callCountAfterFirst = calls.length;
    const second = await feishuArchive.archiveApprovalPdfToFeishu(env, archivedApproval().id);
    assert.deepEqual(second, { status: "uploaded", fileToken: "box_pdf_001" });
    assert.equal(uploadCount, 1);
    assert.equal(calls.length, callCountAfterFirst);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

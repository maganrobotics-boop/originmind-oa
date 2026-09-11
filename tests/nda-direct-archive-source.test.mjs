import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageUrl = new URL("../app/page.tsx", import.meta.url);
const createRouteUrl = new URL("../app/api/approvals/route.ts", import.meta.url);
const detailRouteUrl = new URL("../app/api/approvals/[id]/route.ts", import.meta.url);

test("member NDA UI signs and archives without a project-owner review task", async () => {
  const source = await readFile(pageUrl, "utf8");

  assert.match(source, /shouldAutoArchiveConfidentialityAgreement\(agreementKind, Boolean\(session\.isAdmin\)\)/u);
  assert.match(source, /成员本人完成实名手写签署后，系统将直接归档；项目负责人可查阅，不生成额外审核待办/u);
  assert.match(source, /普通成员本人实名签署后由系统直接归档，项目负责人可查阅且无需审核/u);
  assert.match(source, /buildNdaAgreementText\(/u);
  assert.doesNotMatch(source, /乙方完成本人实名认证电子签后，本协议提交项目负责人审核/u);
});

test("member NDA direct archive clears legacy reviewer metadata and verifies admission sync", async () => {
  const source = await readFile(createRouteUrl, "utf8");

  assert.match(source, /initialReviewerEmail: ndaDirectArchive \? ""/u);
  assert.match(source, /initialReviewerName: ndaDirectArchive \? ""/u);
  assert.match(source, /action: auditAction/u);
  assert.match(source, /const admissionRows = results\[2 \+ revisionWrites\.length\]/u);
  assert.match(source, /assertMemberNdaAdmissionInBatch\(db, id, now, currentEmail/u);
  assert.match(source, /\.\.\.\(admissionAssertion \? \[admissionAssertion\] : \[\]\)/u);
  assert.match(source, /requireMemberAdmission && !admissionRows\[0\]/u);
  assert.match(source, /'autoArchived', CASE json_type\([\s\S]*WHEN 'true' THEN json\('true'\)/u);
});

test("project owners can inspect the complete signed member NDA detail", async () => {
  const source = await readFile(detailRouteUrl, "utf8");

  assert.match(source, /authorized\.role === "project_owner" && agreementKind === "member"/u);
  assert.doesNotMatch(source, /\|\| authorized\.role === "project_owner"\s*\|\|/u);
  assert.match(source, /createNdaIntegrityRecord\(\{[\s\S]*agreementVersion \}\)/u);
  assert.match(source, /ndaBusinessKeyForVersion\(signerAccountUserId, archivedAgreementVersion\)/u);
  assert.doesNotMatch(source, /const archivedAgreementVersion = confidentialityAgreementVersion\(agreementKind\)/u);
});

test("current member NDA cannot fall back into the legacy reviewer workflow", async () => {
  const [source, pageSource] = await Promise.all([readFile(detailRouteUrl, "utf8"), readFile(pageUrl, "utf8")]);

  assert.match(source, /textValue\(payload\.agreementVersion\) !== LEGACY_NDA_AGREEMENT_VERSION/u);
  assert.match(source, /当前版本成员保密协议应由本人签署后直接归档/u);
  assert.match(source, /currentMemberNdaRequiresFreshSignature && \(action === "approve" \|\| action === "return" \|\| action === "resubmit"\)/u);
  assert.match(source, /管理员仅可在异常时强制退回/u);
  assert.match(pageSource, /function isStrandedCurrentMemberNda\(approval: Approval\)/u);
  assert.match(pageSource, /if \(isStrandedCurrentMemberNda\(approval\)\) return false;/u);
  assert.match(pageSource, /const canAct = !ndaRequiresApplicantResign/u);
  assert.match(pageSource, /负责人不能审核或退回/u);
});

test("historical external archive events stay auditable without exposing connector tokens", async () => {
  const source = await readFile(detailRouteUrl, "utf8");

  assert.match(source, /action === "feishu_archived" \? "历史外部归档"/u);
  assert.match(source, /note\.replace\(\/；飞书文件 Token：\[\^；\]\+\/g, ""\)/u);
  assert.match(source, /events\.filter\(\(event\) => event\.action !== "feishu_archived"\)/u);
});

test("NDA details wait for the complete snapshot and ignore stale requests", async () => {
  const source = await readFile(pageUrl, "utf8");

  assert.match(source, /const selectedApproval = detailApproval;/u);
  assert.doesNotMatch(source, /detailApproval \|\| approvals\.find/u);
  assert.match(source, /cache: "no-store", signal/u);
  assert.match(source, /controller\.signal\.aborted \|\| detailRequestSequenceRef\.current !== requestSequence/u);
  assert.match(source, /detailAbortRef\.current\?\.abort\(\)/u);
  assert.match(source, /ndaPayload && ndaAgreementTextSnapshot \? <NdaAgreement/u);
  assert.match(source, /缺少已签署正文快照，已停止预览/u);
  assert.match(source, /const requiresFreshNdaSignature = draft\.type === "保密协议"/u);
  assert.match(source, /setSignatureDataUrl\(requiresFreshNdaSignature \? ""/u);
  assert.match(source, /setNdaPreviewed\(!requiresFreshNdaSignature/u);
  assert.match(source, /setNdaAgreed\(!requiresFreshNdaSignature/u);
});

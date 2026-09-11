import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

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

const memberAttributes = await vite.ssrLoadModule("/lib/member-attributes.ts");
const ndaAdmission = await vite.ssrLoadModule("/lib/nda-admission.ts");
const ndaAgreement = await vite.ssrLoadModule("/lib/nda-agreement.ts");

test("成员注册审核只允许 OA 管理员", () => {
  assert.equal(memberAttributes.canReviewMemberRegistrations(true), true);
  assert.equal(memberAttributes.canReviewMemberRegistrations(false), false, "项目负责人不能审核注册");
  assert.equal(memberAttributes.canReviewMemberRegistrations(false), false, "技术顾问不能审核注册");
  assert.equal(memberAttributes.canReviewMemberRegistrations(false), false, "经费负责人不能审核注册");
});

test("首次未提交 NDA 时高亮待办，点击进入后停止高亮", () => {
  const initial = { hasCurrentApproval: false, hasHistoricalArchivedNda: false, enteredNdaForm: false, loadFailed: false };
  assert.equal(ndaAdmission.shouldHighlightNdaTaskEntry(initial), true);
  assert.equal(ndaAdmission.shouldHighlightNdaTaskEntry({ ...initial, enteredNdaForm: true }), false);
  assert.equal(ndaAdmission.shouldHighlightNdaTaskEntry({ ...initial, hasCurrentApproval: true }), false);
  assert.equal(ndaAdmission.shouldHighlightNdaTaskEntry({ ...initial, hasHistoricalArchivedNda: true }), false);
  assert.equal(ndaAdmission.shouldHighlightNdaTaskEntry({ ...initial, loadFailed: true }), false);
});

test("NDA 准入组件按规范账户邮箱隔离本地签署状态", () => {
  assert.equal(ndaAdmission.ndaAdmissionIdentityKey(" Member@Example.COM "), "member@example.com");
  assert.notEqual(ndaAdmission.ndaAdmissionIdentityKey("a@example.com"), ndaAdmission.ndaAdmissionIdentityKey("b@example.com"));
  assert.equal(ndaAdmission.ndaAdmissionIdentityKey(undefined), "nda-admission-unknown");
});

test("成员部门固定为三个选项并使用稳定代码", () => {
  assert.deepEqual(
    memberAttributes.MEMBER_DEPARTMENTS.map(({ code, label }) => ({ code, label })),
    [
      { code: "agent_hardware", label: "Agent Hardware" },
      { code: "agent_os", label: "Agent OS" },
      { code: "agent_application", label: "Agent Application" },
    ],
  );
  for (const department of memberAttributes.MEMBER_DEPARTMENTS) {
    assert.equal(memberAttributes.isMemberDepartmentCode(department.code), true);
    assert.equal(memberAttributes.memberDepartmentLabel(department.code), department.label);
  }
});

test("管理员可提交固定部门，其他审核人不能提交部门字段", () => {
  assert.deepEqual(memberAttributes.validateMemberDepartmentInput(undefined, false), { ok: true, provided: false });
  assert.deepEqual(memberAttributes.validateMemberDepartmentInput("agent_os", true), { ok: true, provided: true, value: "agent_os" });
  assert.deepEqual(memberAttributes.validateMemberDepartmentInput("agent_os", false), { ok: false, reason: "forbidden" });
  assert.deepEqual(memberAttributes.validateMemberDepartmentInput("", true), { ok: false, reason: "invalid" });
  assert.deepEqual(memberAttributes.validateMemberDepartmentInput("Agent OS", true), { ok: false, reason: "invalid" });
  assert.deepEqual(memberAttributes.validateMemberDepartmentInput("agent_sales", true), { ok: false, reason: "invalid" });
  assert.deepEqual(memberAttributes.validateMemberDepartmentInput(null, true), { ok: false, reason: "invalid" });
});

test("管理员批准成员时必须已有或同时提交合法部门", () => {
  assert.equal(memberAttributes.administratorApprovalNeedsDepartment("approve", true, false, ""), true);
  assert.equal(memberAttributes.administratorApprovalNeedsDepartment("approve", true, true, ""), false);
  assert.equal(memberAttributes.administratorApprovalNeedsDepartment("approve", true, false, "agent_hardware"), false);
  assert.equal(memberAttributes.administratorApprovalNeedsDepartment("approve", false, false, ""), false);
  assert.equal(memberAttributes.administratorApprovalNeedsDepartment("reject", true, false, ""), false);
});

test("授予项目负责人权限时要求负责人承诺书", () => {
  const shouldReset = memberAttributes.shouldResetConfidentialityForProjectOwnerPromotion;
  assert.equal(shouldReset([], ["project_owner"], ndaAgreement.NDA_AGREEMENT_VERSION), true);
  assert.equal(shouldReset(["technical_advisor"], ["technical_advisor", "project_owner"], null), true);
  assert.equal(shouldReset([], ["project_owner"], ndaAgreement.PROJECT_OWNER_PLEDGE_VERSION), false);
  assert.equal(shouldReset(["project_owner"], ["project_owner"], ndaAgreement.NDA_AGREEMENT_VERSION), false);
  assert.equal(shouldReset([], ["technical_advisor"], ndaAgreement.NDA_AGREEMENT_VERSION), false);
  assert.equal(shouldReset(["project_owner"], [], ndaAgreement.PROJECT_OWNER_PLEDGE_VERSION), false);
});

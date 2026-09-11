import { isSupportedAccountSubject } from "./account-subject";

export const NDA_AGREEMENT_VERSION = "NDA-2026-09-R2";
export const LEGACY_NDA_AGREEMENT_VERSION = "NDA-2026-09";
export const PROJECT_OWNER_PLEDGE_VERSION = "PROJECT-OWNER-PLEDGE-2026-09";
export const NDA_PROJECT_NAME = "OriginMind × ARTS Robotics 联合研发项目";

export type ConfidentialityAgreementKind = "member" | "project_owner";

type NdaApprovalLike = {
  id: string;
  type: string;
  status?: string;
  payload?: unknown;
};

export function confidentialityAgreementKindForRole(role: string): ConfidentialityAgreementKind {
  return role === "project_owner" ? "project_owner" : "member";
}

export function confidentialityAgreementVersion(kind: ConfidentialityAgreementKind): string {
  return kind === "project_owner" ? PROJECT_OWNER_PLEDGE_VERSION : NDA_AGREEMENT_VERSION;
}

export function confidentialityAgreementVersions(kind: ConfidentialityAgreementKind): string[] {
  return kind === "project_owner"
    ? [PROJECT_OWNER_PLEDGE_VERSION]
    : [NDA_AGREEMENT_VERSION, LEGACY_NDA_AGREEMENT_VERSION];
}

export function confidentialityAgreementTitle(kind: ConfidentialityAgreementKind): string {
  return kind === "project_owner" ? "项目负责人保密承诺书" : "保密协议";
}

export function confidentialityAgreementSubtitle(kind: ConfidentialityAgreementKind): string {
  return kind === "project_owner" ? "项目负责人版" : "项目参与成员版";
}

export function confidentialityAgreementReviewerStep(kind: ConfidentialityAgreementKind): "项目负责人" | "OA管理员" {
  return kind === "project_owner" ? "OA管理员" : "项目负责人";
}

export function shouldAutoArchiveConfidentialityAgreement(kind: ConfidentialityAgreementKind, isAdmin: boolean): boolean {
  return kind === "member" || isAdmin;
}

export function confidentialityAgreementKindsAcceptedForRole(role: string): ConfidentialityAgreementKind[] {
  return role === "project_owner" ? ["project_owner"] : ["member", "project_owner"];
}

export function isConfidentialityAgreementVersionAcceptedForRole(role: string, version: unknown): boolean {
  return confidentialityAgreementKindsAcceptedForRole(role).some((kind) => confidentialityAgreementVersions(kind).includes(String(version)));
}

export function confidentialityAgreementKindFromPayload(payload: unknown): ConfidentialityAgreementKind | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (record.agreementKind === "member" || record.agreementKind === "project_owner") return record.agreementKind;
  if (record.agreementVersion === PROJECT_OWNER_PLEDGE_VERSION) return "project_owner";
  if (record.agreementVersion === NDA_AGREEMENT_VERSION || record.agreementVersion === LEGACY_NDA_AGREEMENT_VERSION) return "member";
  return null;
}

export function isCurrentNdaAgreementPayload(payload: unknown, kind: ConfidentialityAgreementKind = "member"): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  const payloadKind = confidentialityAgreementKindFromPayload(record);
  return record.agreementVersion === confidentialityAgreementVersion(kind) && payloadKind === kind;
}

export function selectCurrentNdaApproval<T extends NdaApprovalLike>(approvals: T[], preferredId?: string, kind: ConfidentialityAgreementKind = "member"): T | null {
  const compatibleApprovals = approvals.filter((approval) => {
    const payload = approval.payload && typeof approval.payload === "object" && !Array.isArray(approval.payload)
      ? approval.payload as Record<string, unknown>
      : {};
    return approval.type === "保密协议"
      && confidentialityAgreementKindFromPayload(payload) === kind
      && confidentialityAgreementVersions(kind).includes(String(payload.agreementVersion))
      && ["待审核", "审批中", "已退回", "已撤回"].includes(approval.status || "");
  });
  return compatibleApprovals.find((approval) => approval.id === preferredId)
    || compatibleApprovals.find((approval) => isCurrentNdaAgreementPayload(approval.payload, kind))
    || compatibleApprovals[0]
    || null;
}

export function ndaBusinessKey(accountUserId: string, kind: ConfidentialityAgreementKind = "member") {
  return ndaBusinessKeyForVersion(accountUserId, confidentialityAgreementVersion(kind));
}

export function ndaBusinessKeyForVersion(accountUserId: string, version: string) {
  const normalizedId = accountUserId.trim();
  if (!isSupportedAccountSubject(normalizedId)) throw new TypeError("NDA signer account subject is invalid");
  if (![NDA_AGREEMENT_VERSION, LEGACY_NDA_AGREEMENT_VERSION, PROJECT_OWNER_PLEDGE_VERSION].includes(version)) throw new TypeError("NDA agreement version is invalid");
  return `nda|account:${normalizedId}|${version}`;
}

export function buildNdaAgreementTextForVersion(signerName: string, confidentialScope: string, kind: ConfidentialityAgreementKind, version: string) {
  if (!confidentialityAgreementVersions(kind).includes(version)) throw new TypeError("NDA agreement version is invalid");
  if (kind === "project_owner") {
    return [
      "项目负责人保密承诺书",
      `${NDA_PROJECT_NAME} · 项目负责人版`,
      `承诺书版本：${version}`,
      `项目：${NDA_PROJECT_NAME}`,
      `承诺人：${signerName}`,
      `第一条　保密范围：承诺人对项目中尚未公开的代码、图纸、BOM、算法与模型、测试数据、样机资料、客户信息、商务信息，以及本承诺书中填写的范围承担保密义务：${confidentialScope}。`,
      "第二条　管理职责：承诺人应按最小权限原则管理资料与系统访问，明确共享边界，不得未经授权向外披露、复制、拍摄、上传或用于本项目以外的目的。",
      "第三条　成员与权限管理：承诺人仅可向已完成保密文件归档的成员开放项目资料；成员角色变化、退出项目或不再需要访问时，应及时撤销权限；发现泄露、丢失或误发时，应立即向 OA 管理员报告并配合处置。",
      "第四条　技术对外交流：未经书面授权，承诺人不得向外透露所在实验室、合作单位或本项目的技术细节、研发成果与未公开计划。",
      "第五条　生效与归档：承诺人完成本人实名认证电子签后，本承诺书由 OA 管理员确认并归档；OA 管理员本人签署时由系统直接归档。已归档版本不得覆盖或替换。",
    ].join("\n");
  }
  return [
    "保密协议",
    `${NDA_PROJECT_NAME} · 项目参与成员版`,
    `协议版本：${version}`,
    `甲方：${NDA_PROJECT_NAME}`,
    `乙方：${signerName}`,
    `第一条　保密信息：乙方在项目参与、技术开发、测试验证、采购或协作过程中接触到的未公开信息，包括但不限于代码、图纸、BOM、测试数据、样机资料、客户资料以及本协议中填写的范围：${confidentialScope}。`,
    "第二条　保密义务：乙方仅可为本项目使用保密信息，不得向无关人员披露、转发、复制、拍照、上传至未经授权的平台，或用于与本项目无关的目的。确需共享时，应先取得项目负责人书面同意。",
    "第三条　资料管理：项目结束、退出或收到返还要求时，乙方应按要求返还或删除所持资料，并继续承担保密义务。发现泄露、丢失或误发时，应立即报告项目负责人。",
    version === LEGACY_NDA_AGREEMENT_VERSION
      ? "第四条　生效与归档：乙方完成本人实名认证电子签后，本协议提交项目负责人审核；审核通过后由系统归档，已归档版本不得覆盖或替换。"
      : "第四条　生效与归档：乙方完成本人实名认证电子签后，本协议立即生效并由系统自动归档，无需项目负责人另行审核；项目负责人可在 OA 中查阅。已归档版本不得覆盖或替换。",
  ].join("\n");
}

export function buildNdaAgreementText(signerName: string, confidentialScope: string, kind: ConfidentialityAgreementKind = "member") {
  return buildNdaAgreementTextForVersion(signerName, confidentialScope, kind, confidentialityAgreementVersion(kind));
}

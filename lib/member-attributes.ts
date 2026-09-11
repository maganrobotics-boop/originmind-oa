export const MEMBER_DEPARTMENTS = [
  { code: "agent_hardware", label: "Agent Hardware" },
  { code: "agent_os", label: "Agent OS" },
  { code: "agent_application", label: "Agent Application" },
] as const;

export type MemberDepartmentCode = (typeof MEMBER_DEPARTMENTS)[number]["code"];

export function canReviewMemberRegistrations(isAdmin: boolean): boolean {
  return isAdmin;
}

export function isMemberDepartmentCode(value: unknown): value is MemberDepartmentCode {
  return typeof value === "string" && MEMBER_DEPARTMENTS.some((department) => department.code === value);
}

export function memberDepartmentLabel(value: unknown): string {
  return MEMBER_DEPARTMENTS.find((department) => department.code === value)?.label || "";
}

export function validateMemberDepartmentInput(value: unknown, canSetDepartment: boolean) {
  if (value === undefined) return { ok: true, provided: false } as const;
  if (!canSetDepartment) return { ok: false, reason: "forbidden" } as const;
  if (!isMemberDepartmentCode(value)) return { ok: false, reason: "invalid" } as const;
  return { ok: true, provided: true, value } as const;
}

export function administratorApprovalNeedsDepartment(action: string, canSetDepartment: boolean, departmentProvided: boolean, existingDepartment: unknown) {
  return action === "approve" && canSetDepartment && !departmentProvided && !isMemberDepartmentCode(existingDepartment);
}

export function shouldResetConfidentialityForProjectOwnerPromotion(
  existingPermissions: readonly string[],
  nextPermissions: readonly string[],
  currentAgreementVersion: unknown,
): boolean {
  return !existingPermissions.includes("project_owner")
    && nextPermissions.includes("project_owner")
    && currentAgreementVersion !== PROJECT_OWNER_PLEDGE_VERSION;
}
import { PROJECT_OWNER_PLEDGE_VERSION } from "./nda-agreement";

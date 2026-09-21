export const DEPARTMENT_NAME_MAX_LENGTH = 120;
export const DEPARTMENT_TITLE_MAX_LENGTH = 120;
export const DEPARTMENT_REQUEST_BYTES = 16_384;

const DEPARTMENT_CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const DISALLOWED_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

function safeText(value, maximum, optional = false) {
  if (value === undefined && optional) return "";
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text && optional) return "";
  return text && text.length <= maximum && text.isWellFormed() && !DISALLOWED_TEXT.test(text) ? text : null;
}

export function parseCreateDepartmentInput(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)
    || Object.keys(record).some((key) => !["code", "name", "parentId"].includes(key))) return null;
  const code = typeof record.code === "string" ? record.code.trim().toLowerCase() : "";
  const name = safeText(record.name, DEPARTMENT_NAME_MAX_LENGTH);
  const parentId = record.parentId === undefined || record.parentId === null || record.parentId === "" ? null : record.parentId;
  if (!DEPARTMENT_CODE.test(code) || !name || (parentId !== null && (typeof parentId !== "string" || !RECORD_ID.test(parentId)))) return null;
  return { code, name, parentId };
}

export function parseAssignDepartmentInput(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)
    || Object.keys(record).some((key) => !["action", "memberId", "departmentId", "title"].includes(key))) return null;
  const title = safeText(record.title, DEPARTMENT_TITLE_MAX_LENGTH, true);
  if (record.action !== "assign_primary" || typeof record.memberId !== "string" || !RECORD_ID.test(record.memberId)
    || typeof record.departmentId !== "string" || !RECORD_ID.test(record.departmentId) || title === null) return null;
  return { action: record.action, memberId: record.memberId, departmentId: record.departmentId, title };
}

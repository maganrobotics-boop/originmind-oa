const EMAIL_SUBJECT_PREFIX = "email:";
const MAX_EMAIL_LENGTH = 254;

export function normalizeAccountEmail(email: string) {
  const normalized = email.trim().toLowerCase();
  const separator = normalized.indexOf("@");
  if (
    !normalized
    || normalized.length > MAX_EMAIL_LENGTH
    || separator <= 0
    || separator !== normalized.lastIndexOf("@")
    || separator === normalized.length - 1
    || /[\s|]/u.test(normalized)
  ) {
    throw new TypeError("Authenticated email is invalid");
  }
  return normalized;
}

export function accountSubjectForEmail(email: string) {
  return `${EMAIL_SUBJECT_PREFIX}${normalizeAccountEmail(email)}`;
}

export function accountSubjectForGitHub(providerSubject: string) {
  const normalized = providerSubject.trim();
  if (!/^[1-9]\d{0,31}$/u.test(normalized)) throw new TypeError("GitHub account identifier is invalid");
  return `github_${normalized}`;
}

export async function accountSubjectForFeishu(providerSubject: string) {
  const normalized = providerSubject.trim();
  if (!/^[A-Za-z0-9_-]{4,128}:[A-Za-z0-9_-]{4,128}:ou[-_][A-Za-z0-9_-]{4,125}$/u.test(normalized)) {
    throw new TypeError("Feishu account identifier is invalid");
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized)));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `feishu_${hex}`;
}

export async function accountEmailForFeishu(providerSubject: string) {
  const subject = await accountSubjectForFeishu(providerSubject);
  return `${subject.slice(0, 63)}@feishu.invalid`;
}

export function isSupportedAccountSubject(value: string) {
  const normalized = value.trim();
  if (/^[A-Za-z0-9_-]{1,128}$/.test(normalized)) return true;
  if (!normalized.startsWith(EMAIL_SUBJECT_PREFIX)) return false;
  try {
    return accountSubjectForEmail(normalized.slice(EMAIL_SUBJECT_PREFIX.length)) === normalized;
  } catch {
    return false;
  }
}

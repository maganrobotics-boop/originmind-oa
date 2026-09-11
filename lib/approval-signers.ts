export type ApprovalSigner = {
  name: string;
  email?: string;
  accountUserId?: string;
  memberId?: string;
  signedAt?: string;
};

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedSigner(value: unknown): ApprovalSigner | null {
  if (typeof value === "string") {
    const name = text(value);
    return name ? { name } : null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const name = text(record.name);
  if (!name) return null;
  const email = text(record.email).toLowerCase();
  const accountUserId = text(record.accountUserId);
  const memberId = text(record.memberId);
  const signedAt = text(record.signedAt);
  return {
    name,
    ...(email ? { email } : {}),
    ...(accountUserId ? { accountUserId } : {}),
    ...(memberId ? { memberId } : {}),
    ...(signedAt && !Number.isNaN(Date.parse(signedAt)) ? { signedAt } : {}),
  };
}

function signerKey(signer: ApprovalSigner) {
  return signer.accountUserId
    ? `account:${signer.accountUserId}`
    : signer.memberId
      ? `member:${signer.memberId}`
      : signer.email
        ? `email:${signer.email}`
        : `legacy-name:${signer.name}`;
}

export function parseApprovalSigners(value: string): ApprovalSigner[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const signers: ApprovalSigner[] = [];
    for (const item of parsed) {
      const signer = normalizedSigner(item);
      if (!signer) continue;
      const key = signerKey(signer);
      if (seen.has(key)) continue;
      seen.add(key);
      signers.push(signer);
    }
    return signers;
  } catch {
    return [];
  }
}

export function addApprovalSigner(value: string, signerInput: ApprovalSigner) {
  const signer = normalizedSigner(signerInput);
  if (!signer || (!signer.accountUserId && !signer.memberId && !signer.email)) throw new Error("A verified signer identity is required.");
  const signers = parseApprovalSigners(value);
  const key = signerKey(signer);
  if (!signers.some((existing) => signerKey(existing) === key)) signers.push(signer);
  return JSON.stringify(signers);
}

export function approvalSignerLabels(value: string) {
  const signers = parseApprovalSigners(value);
  const nameCounts = new Map<string, number>();
  for (const signer of signers) nameCounts.set(signer.name, (nameCounts.get(signer.name) ?? 0) + 1);
  return signers.map((signer) => {
    if ((nameCounts.get(signer.name) ?? 0) < 2) return signer.name;
    return signer.email ? `${signer.name}（${signer.email}）` : signer.name;
  });
}

import { canonicalJson, sha256Hex } from "./canonical-json";

export const APPROVAL_REVISION_SCHEMA_VERSION = 1;

const CURRENT_REVISION_POINTER_KEYS = new Set([
  "currentRevisionId",
  "currentRevisionNo",
  "currentRevisionHash",
  "current_revision_id",
  "current_revision_no",
  "current_revision_hash",
]);

export type ApprovalProjection = Readonly<Record<string, unknown>>;
export type ApprovalRevisionMutation = Readonly<Record<string, unknown>>;
export type ApprovalRevisionEvent = Readonly<Record<string, unknown>>;

export type BuildApprovalRevisionInput = {
  nextApproval: ApprovalProjection;
  revisionNo: number;
  previousRevisionHash?: string | null;
  mutation: ApprovalRevisionMutation;
  event: ApprovalRevisionEvent;
};

export type ApprovalRevision = {
  revisionNo: number;
  previousRevisionHash: string | null;
  stateJson: string;
  stateHash: string;
  eventJson: string;
  revisionHash: string;
};

export type RevisionChainVerification =
  | { valid: true }
  | { valid: false; index: number; reason: string };

const SHA256_HEX = /^[a-f0-9]{64}$/;

function assertRevisionNumber(revisionNo: number) {
  if (!Number.isSafeInteger(revisionNo) || revisionNo < 1) {
    throw new TypeError("revisionNo must be a positive safe integer");
  }
}

function normalizePreviousHash(revisionNo: number, previousRevisionHash?: string | null) {
  const normalized = previousRevisionHash ?? null;
  if (revisionNo === 1) {
    if (normalized !== null) {
      throw new TypeError("The first revision cannot have a previous revision hash");
    }
    return null;
  }
  if (typeof normalized !== "string" || !SHA256_HEX.test(normalized)) {
    throw new TypeError("A non-first revision requires a lowercase SHA-256 previous hash");
  }
  return normalized;
}

function stateWithoutRevisionPointers(nextApproval: ApprovalProjection) {
  const state: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(nextApproval)) {
    if (!CURRENT_REVISION_POINTER_KEYS.has(key)) state[key] = value;
  }
  return state;
}

function revisionEnvelope(
  revisionNo: number,
  previousRevisionHash: string | null,
  stateHash: string,
  event: unknown,
) {
  return {
    schemaVersion: APPROVAL_REVISION_SCHEMA_VERSION,
    revisionNo,
    previousRevisionHash,
    stateHash,
    event,
  };
}

/**
 * Builds a self-contained immutable approval snapshot and links it to its predecessor.
 * The current-revision pointer columns are omitted to avoid a self-referential hash.
 */
export async function buildApprovalRevision({
  nextApproval,
  revisionNo,
  previousRevisionHash,
  mutation,
  event,
}: BuildApprovalRevisionInput): Promise<ApprovalRevision> {
  assertRevisionNumber(revisionNo);
  const normalizedPreviousHash = normalizePreviousHash(revisionNo, previousRevisionHash);
  const stateJson = canonicalJson(stateWithoutRevisionPointers(nextApproval));
  const stateHash = await sha256Hex(stateJson);
  const eventRecord = { mutation, event };
  const eventJson = canonicalJson(eventRecord);
  const revisionHash = await sha256Hex(canonicalJson(revisionEnvelope(
    revisionNo,
    normalizedPreviousHash,
    stateHash,
    eventRecord,
  )));

  return {
    revisionNo,
    previousRevisionHash: normalizedPreviousHash,
    stateJson,
    stateHash,
    eventJson,
    revisionHash,
  };
}

function parseCanonicalJson(value: string) {
  const parsed = JSON.parse(value) as unknown;
  if (canonicalJson(parsed) !== value) {
    throw new TypeError("Stored JSON is not canonical");
  }
  return parsed;
}

/** Returns the first broken link or digest, if any, for diagnostics. */
export async function inspectRevisionChain(
  revisions: readonly ApprovalRevision[],
): Promise<RevisionChainVerification> {
  let previousRevisionHash: string | null = null;

  for (let index = 0; index < revisions.length; index += 1) {
    const revision = revisions[index];
    const expectedRevisionNo = index + 1;

    if (revision.revisionNo !== expectedRevisionNo) {
      return { valid: false, index, reason: "Revision numbers are not contiguous" };
    }
    if (revision.previousRevisionHash !== previousRevisionHash) {
      return { valid: false, index, reason: "Previous revision hash does not match" };
    }

    let state: unknown;
    let event: unknown;
    try {
      state = parseCanonicalJson(revision.stateJson);
      event = parseCanonicalJson(revision.eventJson);
    } catch {
      return { valid: false, index, reason: "Revision contains invalid canonical JSON" };
    }

    if (!state || typeof state !== "object" || Array.isArray(state)) {
      return { valid: false, index, reason: "Revision state is not an approval projection" };
    }
    if (Object.keys(state).some((key) => CURRENT_REVISION_POINTER_KEYS.has(key))) {
      return { valid: false, index, reason: "Revision state contains a current-revision pointer" };
    }

    const expectedStateHash = await sha256Hex(revision.stateJson);
    if (revision.stateHash !== expectedStateHash) {
      return { valid: false, index, reason: "Revision state hash does not match" };
    }

    const expectedRevisionHash = await sha256Hex(canonicalJson(revisionEnvelope(
      revision.revisionNo,
      revision.previousRevisionHash,
      revision.stateHash,
      event,
    )));
    if (revision.revisionHash !== expectedRevisionHash) {
      return { valid: false, index, reason: "Revision hash does not match" };
    }

    previousRevisionHash = revision.revisionHash;
  }

  return { valid: true };
}

/** Verifies canonical state/event data, every digest, and the full predecessor chain. */
export async function verifyRevisionChain(revisions: readonly ApprovalRevision[]) {
  return (await inspectRevisionChain(revisions)).valid;
}

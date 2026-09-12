export const MIGRATION_IMPORT_TABLE_ORDER = Object.freeze([
  "approvals",
  "members",
  "auth_identities",
  "account_profiles",
  "approval_revisions",
  "approval_events",
  "member_events",
  "labor_source_claims",
  "external_archives",
  "direct_messages",
  "knowledge_items",
  "knowledge_revisions",
  "knowledge_chunks",
  "knowledge_events",
]);

export const MIGRATION_IMPORT_MAX_D1_QUERIES = 50;
export const MIGRATION_IMPORT_MAX_JSON_BINDING_BYTES = 1_900_000;
// Preflight (3), guarded commit setup (2), combined exact verification plus
// transient-state check (2), and verified guard cleanup (2).
export const MIGRATION_IMPORT_FIXED_D1_QUERIES = 9;

const encoder = new TextEncoder();

function* jsonRowBatches(rows) {
  let batch = [];
  let byteLength = 2;
  for (const row of rows) {
    const rowBytes = encoder.encode(JSON.stringify(row)).byteLength;
    if (rowBytes + 2 > MIGRATION_IMPORT_MAX_JSON_BINDING_BYTES) throw new Error("Migration row exceeds the safe D1 JSON binding size");
    const nextLength = byteLength + rowBytes + (batch.length ? 1 : 0);
    if (batch.length && nextLength > MIGRATION_IMPORT_MAX_JSON_BINDING_BYTES) {
      yield batch;
      batch = [];
      byteLength = 2;
    }
    batch.push(row);
    byteLength += rowBytes + (batch.length > 1 ? 1 : 0);
  }
  if (batch.length) yield batch;
}

export function* migrationImportRowBatches(table) {
  if (!table || !Array.isArray(table.columns) || !table.columns.length || table.columns.length > 100 || !Array.isArray(table.rows)) throw new Error("Migration table is missing or malformed");
  if (table.name !== "approval_revisions") {
    yield* jsonRowBatches(table.rows);
    return;
  }
  const approvalIndex = table.columns.indexOf("approval_id");
  if (approvalIndex < 0) throw new Error("Migration revisions are missing approval_id");
  const chains = new Map();
  for (const row of table.rows) {
    const approvalId = row[approvalIndex];
    if (typeof approvalId !== "string" || !approvalId) throw new Error("Migration revision approval_id is invalid");
    if (!chains.has(approvalId)) chains.set(approvalId, []);
    chains.get(approvalId).push(row);
  }
  // The authenticated payload already has validated, ordered revision chains.
  // Each statement contains independent approvals only: every predecessor is in
  // an earlier statement, regardless of SQLite's order within INSERT SELECT.
  for (let depth = 0; chains.size; depth += 1) {
    const rowsAtDepth = [];
    for (const [approvalId, rows] of chains) {
      rowsAtDepth.push(rows[depth]);
      if (depth + 1 === rows.length) chains.delete(approvalId);
    }
    yield* jsonRowBatches(rowsAtDepth);
  }
}

export function migrationImportInsertStatementCount(payload) {
  let statements = 0;
  for (const tableName of MIGRATION_IMPORT_TABLE_ORDER) {
    const table = payload?.tables?.find((candidate) => candidate.name === tableName);
    if (!table || !Array.isArray(table.columns) || !table.columns.length || !Array.isArray(table.rows)) throw new Error(`Migration table ${tableName} is missing or malformed`);
    for (const batch of migrationImportRowBatches(table)) if (batch.length) statements += 1;
  }
  return statements;
}

export function migrationImportD1QueryCount(payload) {
  return MIGRATION_IMPORT_FIXED_D1_QUERIES + migrationImportInsertStatementCount(payload);
}

function tableRecords(payload, name) {
  const table = payload?.tables?.find((candidate) => candidate.name === name);
  if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows)) throw new Error(`Migration table ${name} is missing or malformed`);
  return table.rows.map((row) => Object.fromEntries(table.columns.map((column, index) => [column, row[index]])));
}

function normalizedEmail(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  const at = email.indexOf("@");
  if (!email || email.length > 254 || at <= 0 || at !== email.lastIndexOf("@") || at === email.length - 1 || /[\s|]/u.test(email)) throw new Error("Target administrator email is invalid");
  return email;
}

export function migrationAdministratorEmails(value) {
  if (typeof value !== "string") throw new Error("Migration administrator email list is invalid");
  const administratorEmails = value.split(",").map(normalizedEmail);
  if (!administratorEmails.length || new Set(administratorEmails).size !== administratorEmails.length) {
    throw new Error("Migration administrator email list is invalid");
  }
  return administratorEmails;
}

export function targetAdministratorEmails(variables) {
  let administratorEmails;
  try {
    administratorEmails = migrationAdministratorEmails(variables?.OA_ADMIN_EMAILS);
  } catch {
    throw new Error("Target administrator tuple is invalid");
  }
  const administratorNames = typeof variables?.OA_ADMIN_NAMES === "string"
    ? variables.OA_ADMIN_NAMES.split(",").map((value) => value.trim()).filter(Boolean)
    : [];
  if (administratorEmails.length !== administratorNames.length) throw new Error("Target administrator tuple is invalid");
  return administratorEmails;
}

export function assertTargetAdministratorReentry(payload, variables) {
  const administratorEmails = targetAdministratorEmails(variables);
  const members = tableRecords(payload, "members");
  const identities = tableRecords(payload, "auth_identities");
  const githubEnabled = variables?.GITHUB_LOGIN_ENABLED === "true";
  const feishuPrefix = variables?.FEISHU_LOGIN_ENABLED === "true"
    && typeof variables.FEISHU_LOGIN_APP_ID === "string"
    && typeof variables.FEISHU_LOGIN_TENANT_KEY === "string"
    ? `${variables.FEISHU_LOGIN_APP_ID}:${variables.FEISHU_LOGIN_TENANT_KEY}:`
    : "";
  for (const email of administratorEmails) {
    const member = members.find((row) => row.status === "active"
      && row.chatgpt_account === email
      && row.account_user_id === `email:${email}`);
    if (!member || typeof member.id !== "string" || !member.id) continue;
    const canReenter = identities.some((identity) => {
      if (identity.member_id !== member.id || identity.unlinked_at !== null || typeof identity.provider_subject !== "string") return false;
      if (identity.provider === "github" && githubEnabled) return /^[1-9]\d{0,31}$/u.test(identity.provider_subject);
      if (identity.provider === "feishu" && feishuPrefix && identity.provider_subject.startsWith(feishuPrefix)) {
        return /^ou[-_][A-Za-z0-9_-]{4,125}$/u.test(identity.provider_subject.slice(feishuPrefix.length));
      }
      return false;
    });
    if (canReenter) return true;
  }
  throw new Error("No configured target administrator can re-enter with a migrated GitHub or Feishu identity");
}

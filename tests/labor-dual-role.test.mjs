import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import test, { after, beforeEach } from "node:test";
import { drizzle } from "drizzle-orm/d1";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const stateKey = "__oaLaborDualRoleTest";
globalThis[stateKey] = {};
const vite = await createServer({
  appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false },
  plugins: [{
    name: "labor-dual-role-fixture", enforce: "pre",
    resolveId(source) {
      if (/(^|\/)_lib\/auth$/.test(source)) return "\0labor-test-auth";
      if (/^(?:\.\.\/)+db$/.test(source)) return "\0labor-test-db";
      return null;
    },
    load(id) {
      if (id === "\0labor-test-db") return `export async function getDb() { return globalThis.${stateKey}.db; }`;
      if (id === "\0labor-test-auth") return `
        import { sql } from "drizzle-orm";
        const state = () => globalThis.${stateKey};
        export async function getAuthorizedUser() { return state().actor; }
        export function authorizedMemberGuard(actor) {
          return sql\`EXISTS (SELECT 1 FROM members WHERE id = \${actor.memberId} AND account_user_id = \${actor.accountUserId} AND status = 'active')\`;
        }
        export const getConfiguredAdministrators = () => state().admins;
        export const getConfiguredFinanceOwners = () => state().finance;
        export const getConfiguredProjectOwners = () => state().projects;
        export async function getReviewerDirectory() { return state().reviewers; }
        export function isNdaAdmittedMember(member) { return Boolean(member.accountUserId && member.ndaAcceptedAt); }
        export function isProjectOwner() { return true; }
        export function parseMemberPermissions() { return []; }
      `;
      return null;
    },
  }],
});
const route = await vite.ssrLoadModule("/app/api/approvals/[id]/route.ts");
const pdf = await vite.ssrLoadModule("/lib/approval-pdf.ts");
let sqlite;
after(async () => { sqlite?.close(); delete globalThis[stateKey]; await vite.close(); });

// Execute the real route's Drizzle queries against SQLite, including all schema
// triggers and atomic batches. Only authenticated identities are test doubles.
function d1Adapter(database) {
  function prepare(query, params = []) {
    const execute = () => {
      const statement = database.prepare(query);
      const results = statement.all(...params);
      return { success: true, results, meta: { changes: Number(database.prepare("SELECT changes() n").get().n) } };
    };
    return {
      bind(...values) { return prepare(query, values); },
      async all() { return execute(); },
      async run() { return execute(); },
      async raw() {
        const statement = database.prepare(query);
        statement.setReturnArrays(true);
        return statement.all(...params);
      },
    };
  }
  return {
    prepare,
    async batch(statements) {
      database.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.all());
        database.exec("COMMIT");
        return results;
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    },
  };
}
const owner = { email: "owner@example.com", displayName: "测试负责人", accountUserId: "email:owner@example.com" };
const otherFinance = { email: "finance@example.com", displayName: "独立经费负责人", accountUserId: "email:finance@example.com" };
function actor(identity = owner) {
  return {
    user: { email: identity.email, displayName: identity.displayName },
    accountUserId: identity.accountUserId, memberId: identity.email,
    role: "project_owner", isAdmin: true, isFinanceOwner: true, ndaCompleted: true,
  };
}
function insertApproval({ id = "labor-test", type = "劳务报酬", step = "项目负责人", requester = "applicant@example.com", payload }) {
  const now = "2026-09-01T00:00:00.000Z";
  sqlite.prepare(`INSERT INTO approvals (id,type,title,project,requester_name,requester_email,created_at,updated_at,status,current_step,current_reviewer_email,current_reviewer_name,owner,payload_json,period_key)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, type, "仅本地测试", "测试项目", "测试申请人", requester, now, now, "审批中", step, owner.email, owner.displayName, owner.displayName, JSON.stringify(payload), type === "劳务报酬" ? `${requester}|2026-09` : null);
}
beforeEach(() => {
  sqlite?.close();
  sqlite = new DatabaseSync(":memory:");
  const migrationDirectory = new URL("../drizzle/", import.meta.url);
  for (const name of readdirSync(migrationDirectory).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort()) {
    for (const statement of readFileSync(new URL(name, migrationDirectory), "utf8").split("--> statement-breakpoint").filter(s => s.trim())) sqlite.exec(statement);
  }
  for (const identity of [owner, otherFinance, { email: "applicant@example.com", displayName: "测试申请人", accountUserId: "email:applicant@example.com" }]) {
    sqlite.prepare("INSERT INTO members(id,full_name,chatgpt_account,account_user_id,nda_accepted_at,nda_agreement_version) VALUES(?,?,?,?,?,?)")
      .run(identity.email, identity.displayName, identity.email, identity.accountUserId, "2026-09-01", "OWNER-2026-09-R1");
  }
  globalThis[stateKey] = {
    db: drizzle(d1Adapter(sqlite)), actor: actor(), admins: [owner], projects: [owner], finance: [owner],
    reviewers: [owner, otherFinance].map(identity => ({ ...identity, ndaCompleted: true, permissions: ["project_owner", "technical_advisor"] })),
  };
  insertApproval({ payload: { claimantMemberId: "applicant@example.com", month: "2026-09", sourceApprovalIds: ["technical-source"], initialReviewerEmail: owner.email, totalScore: 10 } });
  sqlite.prepare("INSERT INTO labor_source_claims(id,claimant_member_id,claimant_email,technical_approval_id,labor_approval_id) VALUES(?,?,?,?,?)")
    .run("claim", "applicant@example.com", "applicant@example.com", "technical-source", "labor-test");
});
async function patch(body) {
  const response = await route.PATCH(new Request("https://oa.example.test/api/approvals/labor-test", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "approve", ...body }),
  }), { params: Promise.resolve({ id: "labor-test" }) });
  return { status: response.status, body: await response.json() };
}
const recommendation = { suggestedAmount: 100, compensationBasis: "仅本地自动化测试的金额依据，不产生付款" };
const ledger = () => sqlite.prepare("SELECT * FROM approval_events WHERE approval_id = 'labor-test' ORDER BY id").all();

test("configured dual role requires two requests and preserves both audit events, revisions and PDF", async () => {
  const first = await patch(recommendation);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.approval.step, "经费负责人");
  assert.equal(first.body.approval.status, "审批中");
  assert.equal(first.body.approval.currentReviewerEmail, owner.email);
  assert.equal(first.body.approval.payload.finalAmount, undefined);
  assert.equal(ledger().length, 1);
  // Replaying the recommendation must not act as a second confirmation.
  assert.equal((await patch(recommendation)).status, 400);
  assert.equal(ledger().length, 1);
  const final = await patch({ finalAmount: 100, financeNote: "本地验收终审" });
  assert.equal(final.status, 200, JSON.stringify(final.body));
  assert.equal(final.body.approval.status, "已归档");
  const payload = final.body.approval.payload;
  assert.equal(payload.suggestedAmountBy.accountUserId, owner.accountUserId);
  assert.equal(payload.finalAmountBy.accountUserId, owner.accountUserId);
  assert.equal(payload.suggestedAmount, 100);
  assert.equal(payload.finalAmount, 100);
  const events = ledger();
  assert.equal(events.length, 2);
  assert.match(events[0].note, /项目负责人建议/);
  assert.match(events[1].note, /经费负责人终审/);
  const storedRevisions = sqlite.prepare("SELECT * FROM approval_revisions ORDER BY revision_no").all();
  assert.equal(storedRevisions.length, 3);
  assert.equal(storedRevisions[2].previous_revision_hash, storedRevisions[1].revision_hash);
  assert.equal(storedRevisions[1].previous_revision_hash, storedRevisions[0].revision_hash);
  for (const revision of storedRevisions) assert.equal(createHash("sha256").update(revision.state_json).digest("hex"), revision.state_hash);
  const bytes = await pdf.buildApprovalPdf({ approval: { ...final.body.approval, requesterName: "测试申请人", currentStep: "已归档" }, events: events.map(e => ({ actorName: e.actor_name, actorEmail: e.actor_email, action: e.action, note: e.note, createdAt: e.created_at })) });
  assert.equal(Buffer.from(bytes).subarray(0, 8).toString(), "%PDF-1.7");
  assert.equal((await patch({ finalAmount: 100 })).status, 404);
  assert.equal(ledger().length, 2);
});

test("administrator fallback and one-sided role configuration cannot combine duties", async () => {
  const state = globalThis[stateKey];
  for (const [projects, finance] of [[[], []], [[owner], []], [[], [owner]]]) {
    state.projects = projects; state.finance = finance;
    const result = await patch(recommendation);
    assert.equal(result.status, 503, JSON.stringify(result.body));
    assert.equal(ledger().length, 0);
  }
});

test("configured email with a different account identity does not authorize overlap", async () => {
  globalThis[stateKey].finance = [{ ...owner, accountUserId: "different-account" }];
  assert.equal((await patch(recommendation)).status, 503);
  assert.equal(ledger().length, 0);
});

test("removing explicit dual-role permission before final review stops the second step", async () => {
  assert.equal((await patch(recommendation)).status, 200);
  globalThis[stateKey].projects = [];
  assert.equal((await patch({ finalAmount: 100 })).status, 409);
  assert.equal(ledger().length, 1);
});

test("dual-role reviewer still cannot approve their own application", async () => {
  sqlite.prepare("UPDATE approvals SET requester_email = ? WHERE id = 'labor-test'").run(owner.email);
  assert.equal((await patch(recommendation)).status, 403);
  assert.equal(ledger().length, 0);
});

test("independent finance reviewer continues to work without the overlap exception", async () => {
  globalThis[stateKey].finance = [otherFinance];
  const first = await patch(recommendation);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.approval.currentReviewerEmail, otherFinance.email);
  globalThis[stateKey].actor = actor(otherFinance);
  const final = await patch({ finalAmount: 100 });
  assert.equal(final.status, 200, JSON.stringify(final.body));
  assert.equal(final.body.approval.status, "已归档");
});

test("changed final amount still needs an explanation", async () => {
  assert.equal((await patch(recommendation)).status, 200);
  assert.equal((await patch({ finalAmount: 90 })).status, 400);
  assert.equal(ledger().length, 1);
  assert.equal((await patch({ finalAmount: 90, financeNote: "本地测试：调整核算" })).status, 200);
});

test("technical and purchase reviews retain their distinct-reviewer requirement", async () => {
  for (const type of ["技术审核", "采购审核"]) {
    sqlite.prepare("UPDATE approvals SET type = ? WHERE id = 'labor-test'").run(type);
    assert.equal((await patch({ nextReviewerEmail: owner.email })).status, 409);
    assert.equal(ledger().length, 0);
  }
});

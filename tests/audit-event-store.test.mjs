import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";
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

const workflowWrites = await vite.ssrLoadModule("/lib/workflow-write-store.ts");
const db = drizzle({
  prepare() {
    throw new Error("query construction tests must not execute SQL");
  },
});

test("approval audit insert-select includes the autoincrement id in schema order", () => {
  const query = workflowWrites.conditionalApprovalEvent(
    db,
    "approval-001",
    "2026-09-01T12:00:00.000Z",
    "mutation-001",
    { actorName: "审核人", actorEmail: "reviewer@example.com", action: "approve", note: "通过" },
  );

  const built = query.toSQL();
  assert.match(built.sql, /insert into "approval_events" \("id", "approval_id", "actor_name", "actor_email", "action", "note", "created_at"\)/);
  assert.match(built.sql, /select NULL as "id", "id", \? as "actor_name"/);
});

test("member audit insert-select supplies id and created_at in schema order", () => {
  const query = workflowWrites.conditionalMemberEvent(
    db,
    "member-001",
    "mutation-001",
    "2026-09-01T12:00:00.000Z",
    { actorName: "管理员", actorEmail: "admin@example.com", action: "approve", note: "通过" },
  );

  const built = query.toSQL();
  assert.match(built.sql, /insert into "member_events" \("id", "member_id", "actor_name", "actor_email", "action", "note", "created_at"\)/);
  assert.match(built.sql, /select NULL as "id", "id", \? as "actor_name"/);
});

test("post-archive applicant note is guarded by the immutable archived state", () => {
  const query = workflowWrites.conditionalArchivedApplicantEvent(
    db,
    {
      id: "approval-archived-001",
      requesterEmail: "applicant@example.com",
      updatedAt: "2026-09-01T12:00:00.000Z",
      payloadJson: "{}",
      currentRevisionNo: 4,
      currentRevisionHash: "a".repeat(64),
    },
    "applicant@example.com",
    sql`1 = 1`,
    { actorName: "申请人", actorEmail: "applicant@example.com", action: "archive_correction", note: "追加更正说明", createdAt: "2026-09-02T12:00:00.000Z" },
  );

  const built = query.toSQL();
  assert.match(built.sql, /insert into "approval_events" \("id", "approval_id", "actor_name", "actor_email", "action", "note", "created_at"\)/);
  assert.match(built.sql, /"status" = \?/);
  assert.match(built.sql, /lower\("approvals"\."requester_email"\) = \?/);
  assert.match(built.sql, /"current_revision_no" = \?/);
  assert.match(built.sql, /"current_revision_hash" = \?/);
});

test("labor claim insert-select supplies the defaulted created_at column", () => {
  const query = workflowWrites.conditionalLaborClaimInsert(
    db,
    "approval-001",
    "2026-09-01T12:00:00.000Z",
    "claim-mutation-001",
    {
      claimantMemberId: "member-001",
      claimantEmail: "member@example.com",
      technicalApprovalId: "technical-001",
    },
  );

  const built = query.toSQL();
  assert.match(built.sql, /insert into "labor_source_claims" \("id", "claimant_member_id", "claimant_email", "technical_approval_id", "labor_approval_id", "created_at"\)/);
  assert.match(built.sql, /"id", \? as "created_at" from "approvals"/);
});

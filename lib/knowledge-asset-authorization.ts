import type { KnowledgeActor } from "./knowledge-store";

function normalizeEmail(value: string) { return value.trim().toLowerCase(); }

export async function authorizeKnowledgeAssetRevision(
  database: D1Database,
  actor: KnowledgeActor,
  itemId: string,
  revisionId: string,
): Promise<boolean> {
  const row = await database.prepare(`
    SELECT 1 AS allowed
    FROM knowledge_items i
    JOIN knowledge_revisions r ON r.id = i.current_revision_id AND r.item_id = i.id
    JOIN members m ON m.id = ?
    WHERE i.id = ? AND i.current_revision_id = ?
      AND r.status = 'pending'
      AND ((i.status = 'pending' AND i.submitter_member_id = ? AND lower(i.submitter_email) = ?)
        OR (i.status = 'active' AND i.active_revision_id <> i.current_revision_id AND ? = 1
          AND r.created_by_member_id = ? AND lower(r.created_by_email) = ?))
      AND m.status = 'active' AND m.account_user_id = ? AND m.mutation_revision = ?
      AND m.nda_accepted_at IS NOT NULL AND m.nda_agreement_version IS NOT NULL
    LIMIT 1
  `).bind(actor.memberId, itemId, revisionId, actor.memberId, normalizeEmail(actor.email), actor.isAdmin ? 1 : 0,
    actor.memberId, normalizeEmail(actor.email), actor.accountUserId, actor.memberMutationRevision).first<{ allowed: number }>();
  return Boolean(row?.allowed);
}

import { lt, sql } from "drizzle-orm";
import type { getDb } from "../db";
import { writeRateBuckets } from "../db/schema";

type Database = Awaited<ReturnType<typeof getDb>>;

export async function consumeWriteRateLimit(
  db: Database,
  input: { actorSubject: string; scope: "approval_write" | "approval_create" | "direct_message" | "github_oauth_start" | "feishu_oauth_start" | "feishu_name_binding" | "feishu_auto_provision" | "knowledge_submit" | "knowledge_review" | "lab_ai_ask" | "lab_ai_status" | "lab_ai_extract"; limit: number; now?: Date },
) {
  const actorSubject = input.actorSubject.trim();
  if (!actorSubject || !Number.isInteger(input.limit) || input.limit < 1) return false;
  const now = input.now ?? new Date();
  const windowStartedAt = new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();
  const updatedAt = now.toISOString();
  const bucketKey = JSON.stringify([input.scope, actorSubject, windowStartedAt]);
  const [bucket] = await db.insert(writeRateBuckets).values({
    bucketKey,
    actorSubject,
    scope: input.scope,
    windowStartedAt,
    used: 1,
    updatedAt,
  }).onConflictDoUpdate({
    target: writeRateBuckets.bucketKey,
    set: { used: sql`${writeRateBuckets.used} + 1`, updatedAt },
  }).returning({ used: writeRateBuckets.used });

  // Keep the ledger bounded without placing cleanup on every write.  The first
  // claim by each actor/scope in every fifteenth UTC minute removes buckets
  // older than two days; the indexed timestamp makes the common no-row case cheap.
  if (bucket?.used === 1 && now.getUTCMinutes() % 15 === 0) {
    const cutoff = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
    await db.delete(writeRateBuckets).where(lt(writeRateBuckets.updatedAt, cutoff));
  }
  return Boolean(bucket && bucket.used <= input.limit);
}

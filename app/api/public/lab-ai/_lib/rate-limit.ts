export const PUBLIC_LAB_AI_RETRIEVE_LIMIT_PER_MINUTE = 120;
export const PUBLIC_LAB_AI_SUGGESTIONS_LIMIT_PER_MINUTE = 600;

const RATE_LIMIT_ACTOR = "chat.omindos.ai";
const RETRIEVE_RATE_LIMIT_SCOPE = "public_lab_ai_retrieve";
const SUGGESTIONS_RATE_LIMIT_SCOPE = "public_lab_ai_suggestions";

function rateLimitBucket(scope: string, now: Date): { bucketKey: string; windowStartedAt: string } {
  const windowStartedAt = new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();
  return {
    bucketKey: JSON.stringify([scope, RATE_LIMIT_ACTOR, windowStartedAt]),
    windowStartedAt,
  };
}

export async function isPublicLabAiRetrieveAvailable(database: D1Database, now = new Date()): Promise<boolean> {
  const { bucketKey } = rateLimitBucket(RETRIEVE_RATE_LIMIT_SCOPE, now);
  const bucket = await database.prepare("SELECT used FROM write_rate_buckets WHERE bucket_key = ?")
    .bind(bucketKey)
    .first<{ used: number }>();
  return Number(bucket?.used ?? 0) < PUBLIC_LAB_AI_RETRIEVE_LIMIT_PER_MINUTE;
}

async function consumePublicLabAiRateLimit(
  database: D1Database,
  scope: string,
  limit: number,
  now: Date,
): Promise<boolean> {
  const { bucketKey, windowStartedAt } = rateLimitBucket(scope, now);
  const updatedAt = now.toISOString();
  const bucket = await database.prepare(`
    INSERT INTO write_rate_buckets (bucket_key, actor_subject, scope, window_started_at, used, updated_at)
    VALUES (?, ?, ?, ?, 1, ?)
    ON CONFLICT(bucket_key) DO UPDATE SET
      used = min(write_rate_buckets.used + 1, ?),
      updated_at = excluded.updated_at
    RETURNING used
  `).bind(
    bucketKey,
    RATE_LIMIT_ACTOR,
    scope,
    windowStartedAt,
    updatedAt,
    limit + 1,
  ).first<{ used: number }>();

  if (bucket?.used === 1 && now.getUTCMinutes() % 15 === 0) {
    const cutoff = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1_000).toISOString();
    try {
      await database.prepare("DELETE FROM write_rate_buckets WHERE scope = ? AND updated_at < ?")
        .bind(scope, cutoff)
        .run();
    } catch {
      // Opportunistic cleanup must not change the current rate-limit result.
    }
  }
  return Boolean(bucket && Number(bucket.used) <= limit);
}

export async function consumePublicLabAiRetrieveRateLimit(database: D1Database, now = new Date()): Promise<boolean> {
  return consumePublicLabAiRateLimit(
    database,
    RETRIEVE_RATE_LIMIT_SCOPE,
    PUBLIC_LAB_AI_RETRIEVE_LIMIT_PER_MINUTE,
    now,
  );
}

export async function consumePublicLabAiSuggestionsRateLimit(database: D1Database, now = new Date()): Promise<boolean> {
  return consumePublicLabAiRateLimit(
    database,
    SUGGESTIONS_RATE_LIMIT_SCOPE,
    PUBLIC_LAB_AI_SUGGESTIONS_LIMIT_PER_MINUTE,
    now,
  );
}

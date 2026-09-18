import { generateOaTask } from './oa-chat-client';
import { runTask } from './ai-workbench-store';

export type TaskEnv = { DB: D1Database; OA_AI_TASKS_ENABLED?: string };

/** Run only OA-owned tasks. No chat-platform credentials or external sends. */
export async function processAiWorkbench(env: TaskEnv) {
  if (env.OA_AI_TASKS_ENABLED !== 'true') return;
  try {
    const rows = (await env.DB.prepare(`SELECT id FROM ai_workbench_tasks
      WHERE origin='oa' AND (status='queued' OR (status='running' AND lease_until<?))
      ORDER BY created_at LIMIT 2`).bind(Date.now()).all<{ id: string }>()).results;
    for (const row of rows) await runTask(env.DB, row.id, generateOaTask);
  } catch {
    // Never log private source material, model output, or upstream credentials.
    console.warn('OA_AI_TASK_PROCESSING_UNAVAILABLE');
  }
}

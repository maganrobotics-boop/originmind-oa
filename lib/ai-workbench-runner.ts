import { generateOaTask } from './oa-chat-client';
import { runTask } from './ai-workbench-store';
import { deliverFeishuTasks, type TaskEnv } from './ai-workbench-feishu';
export async function processAiWorkbench(env: TaskEnv) {
  if (env.OA_AI_TASKS_ENABLED !== 'true') return;
  try {
    await env.DB.prepare('DELETE FROM ai_workbench_feishu_inbox WHERE created_at<?').bind(Date.now()-86400000).run();
    const rows = (await env.DB.prepare(`SELECT id FROM ai_workbench_tasks WHERE status='queued' OR (status='running' AND lease_until<?) ORDER BY created_at LIMIT 2`).bind(Date.now()).all<{id: string}>()).results;
    for (const row of rows) await runTask(env.DB,row.id,generateOaTask);
    await deliverFeishuTasks(env);
  } catch { console.warn('OA_AI_TASK_PROCESSING_UNAVAILABLE'); }
}

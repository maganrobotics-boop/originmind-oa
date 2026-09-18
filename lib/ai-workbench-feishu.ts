import { parseFeishuCommand, parseFeishuText, splitFeishuText, validTaskInput } from './ai-workbench-core.mjs';
import { feishuDigest, readFeishuEvent } from './ai-workbench-feishu-crypto.mjs';
import { createTask, type TaskActor, type TaskRow } from './ai-workbench-store';

export type TaskEnv = { DB: D1Database; OA_AI_TASKS_ENABLED?: string; FEISHU_AI_TASKS_ENABLED?: string;
  FEISHU_LOGIN_APP_ID?: string; FEISHU_LOGIN_APP_SECRET?: string; FEISHU_LOGIN_TENANT_KEY?: string;
  FEISHU_AI_ENCRYPT_KEY?: string; FEISHU_AI_VERIFICATION_TOKEN?: string };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
function enabled(env: TaskEnv) { return env.OA_AI_TASKS_ENABLED === 'true' && env.FEISHU_AI_TASKS_ENABLED === 'true' && Boolean(env.FEISHU_LOGIN_APP_ID && env.FEISHU_LOGIN_APP_SECRET && env.FEISHU_LOGIN_TENANT_KEY); }
const namespace = (env: TaskEnv) => `${env.FEISHU_LOGIN_APP_ID}:${env.FEISHU_LOGIN_TENANT_KEY}:`;
async function actorFor(db: D1Database, subject: string): Promise<TaskActor | null> {
  return db.prepare(`SELECT m.id AS memberId,m.account_user_id AS accountUserId,m.mutation_revision AS memberMutationRevision
    FROM members m JOIN auth_identities a ON a.member_id=m.id WHERE a.provider='feishu' AND a.provider_subject=? AND a.unlinked_at IS NULL
      AND m.status='active' AND m.account_user_id IS NOT NULL AND m.mutation_revision IS NOT NULL AND m.nda_accepted_at IS NOT NULL AND m.nda_agreement_version IS NOT NULL`).bind(subject).first<TaskActor>();
}
export async function receiveFeishuTask(request: Request, env: TaskEnv) {
  if (!enabled(env)) return json({ error: '飞书 AI 任务入口尚未启用。' }, 503);
  let event;
  try { event = await readFeishuEvent(request, env.FEISHU_AI_ENCRYPT_KEY, env.FEISHU_AI_VERIFICATION_TOKEN); }
  catch { return json({ error: '事件认证失败。' }, 401); }
  if (event.type === 'url_verification') return json({ challenge: event.challenge });
  const h = event.header, sender = event.event?.sender, message = event.event?.message;
  if (event.schema !== '2.0' || h?.event_type !== 'im.message.receive_v1' || h.app_id !== env.FEISHU_LOGIN_APP_ID || h.tenant_key !== env.FEISHU_LOGIN_TENANT_KEY
    || sender?.sender_type !== 'user' || sender.tenant_key !== env.FEISHU_LOGIN_TENANT_KEY || message?.chat_type !== 'p2p') return json({ ignored: true });
  const openId = sender.sender_id?.open_id;
  if (typeof openId !== 'string' || !/^ou[-_][A-Za-z0-9_-]{4,125}$/u.test(openId) || typeof message.message_id !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/u.test(message.message_id)
    || typeof message.chat_id !== 'string' || message.chat_id.length > 128) return json({ ignored: true });
  const subject = namespace(env) + openId;
  try {
    const actor = await actorFor(env.DB, subject); if (!actor) return json({ ignored: true });
    const text = parseFeishuText(message), command = text ? parseFeishuCommand(text) : null;
    if (text && !command) {
      // Forwarded text is only stored, never executed without a separate command.
      await env.DB.prepare(`INSERT OR IGNORE INTO ai_workbench_feishu_inbox(message_id,member_id,account_user_id,chat_id,content,created_at)
        SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM ai_workbench_feishu_inbox WHERE member_id=? AND created_at>?)<50`)
        .bind(message.message_id,actor.memberId,actor.accountUserId,message.chat_id,text,Date.now(),actor.memberId,Date.now()-86400000).run();
      return json({ received: true, materialOnly: true });
    }
    let material = command?.material || '';
    if (!material && command && typeof message.parent_id === 'string') {
      const source = await env.DB.prepare(`SELECT content FROM ai_workbench_feishu_inbox WHERE message_id=? AND member_id=? AND account_user_id=? AND chat_id=? AND created_at>?`)
        .bind(message.parent_id,actor.memberId,actor.accountUserId,message.chat_id,Date.now()-86400000).first<{content: string}>();
      material = source?.content || '';
    }
    const instruction = command?.instruction || '请到 OA 上传可读取的文字材料。';
    const input = { kind: 'document', title: instruction.slice(0,80), instruction, material: material || '[未提供可读取的文字材料]' };
    if (!validTaskInput(input)) return json({ ignored: true });
    const task = await createTask(env.DB,actor,input,`feishu:${message.message_id}`,'feishu',subject);
    if (!material) await env.DB.prepare(`UPDATE ai_workbench_tasks SET status='failed',failure_code=?,updated_at=? WHERE id=? AND status='queued' AND attempts=0`)
      .bind(text ? 'TASK_MATERIAL_MISSING' : 'TASK_UNSUPPORTED_MATERIAL', Date.now(), task.id).run();
    return json({ received: true, taskId: task.id });
  } catch { return json({ error: '任务接收暂不可用。' }, 503); }
}

async function api(path: string, payload: unknown, token = '') {
  const response = await fetch(`https://open.feishu.cn/open-apis/${path}`, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000) });
  const data = await response.json() as { code?: number; tenant_access_token?: string; data?: { message_id?: string } };
  if (!response.ok || data?.code !== 0) throw new Error('FEISHU_DELIVERY_FAILED');
  return data;
}
export async function deliverFeishuTasks(env: TaskEnv) {
  if (!enabled(env)) return;
  const rows = (await env.DB.prepare(`SELECT * FROM ai_workbench_tasks WHERE origin='feishu' AND status IN ('succeeded','failed') AND delivery_status='pending' AND (delivery_lease IS NULL OR delivery_lease_until<?) ORDER BY created_at LIMIT 3`).bind(Date.now()).all<TaskRow>()).results;
  let token = '';
  for (const item of rows) {
    const lease = crypto.randomUUID(), now = Date.now();
    const row = await env.DB.prepare(`UPDATE ai_workbench_tasks SET delivery_lease=?,delivery_lease_until=?,delivery_started_at=COALESCE(delivery_started_at,?)
      WHERE id=? AND status IN ('succeeded','failed') AND delivery_status='pending' AND (delivery_lease IS NULL OR delivery_lease_until<?) RETURNING *`).bind(lease,now+180000,now,item.id,now).first<TaskRow>();
    if (!row) continue;
    const stop = async (state: string) => { await env.DB.prepare(`UPDATE ai_workbench_tasks SET delivery_status=?,delivery_lease=NULL,delivery_lease_until=NULL WHERE id=? AND delivery_lease=?`).bind(state,row.id,lease).run(); };
    if (now-(row.delivery_started_at || now)>50*60000) { await stop('needs_review'); continue; }
    try {
      const actor = await actorFor(env.DB,row.feishu_subject);
      if (!actor || actor.memberId !== row.member_id || actor.accountUserId !== row.account_user_id || actor.memberMutationRevision !== row.member_revision || !row.feishu_subject.startsWith(namespace(env))) { await stop('skipped'); continue; }
      const link = `https://oa.omindos.ai/ai-workbench?id=${row.id}`;
      const failure = row.failure_code === 'TASK_UNSUPPORTED_MATERIAL'
        ? '暂不支持直接读取图片、附件、合并转发或云文档链接。请把文字粘贴到 OA，或私聊发送“任务：要求”换行后附文字材料。'
        : row.failure_code === 'TASK_MATERIAL_MISSING'
          ? '没有找到任务材料。请在同一条消息中写“任务：要求”，换行后附材料；也可先转发文字，再回复那条消息“/任务 要求”。'
          : '任务未生成完整成果。请到 OA 核对状态后手动重试，不会自动重复执行。';
      const parts = splitFeishuText(row.status === 'succeeded' ? `${row.title}\n\n${row.result}\n\nWord / Markdown 成果：${link}` : `${failure}\n任务记录：${link}`);
      for (let i=row.delivery_parts;i<parts.length;i++) {
        // Revalidate membership and the current task before every private send.
        const fresh = await actorFor(env.DB,row.feishu_subject);
        const current = await env.DB.prepare(`SELECT id FROM ai_workbench_tasks WHERE id=? AND delivery_lease=? AND status=? AND attempts=?`).bind(row.id,lease,row.status,row.attempts).first();
        if (!fresh || fresh.memberId!==row.member_id || fresh.accountUserId!==row.account_user_id || fresh.memberMutationRevision!==row.member_revision || !current) { await stop('skipped'); break; }
        if (!token) token = (await api('auth/v3/tenant_access_token/internal',{ app_id: env.FEISHU_LOGIN_APP_ID, app_secret: env.FEISHU_LOGIN_APP_SECRET })).tenant_access_token || '';
        if (!token) throw new Error('FEISHU_TOKEN_MISSING');
        const ack = await api('im/v1/messages?receive_id_type=open_id',{ receive_id: row.feishu_subject.slice(namespace(env).length), msg_type: 'text',
          content: JSON.stringify({ text: parts.length>1 ? `【${i+1}/${parts.length}】\n${parts[i]}` : parts[i] }), uuid: (await feishuDigest(`oa-task:${row.id}:${row.attempts}:${i}`)).slice(0,40) },token);
        if (!ack.data?.message_id) throw new Error('FEISHU_ACK_MISSING');
        await env.DB.prepare(`UPDATE ai_workbench_tasks SET delivery_parts=? WHERE id=? AND delivery_lease=?`).bind(i+1,row.id,lease).run();
        if (i===parts.length-1) await stop('sent');
      }
      // Covers a crash after the final acknowledgement but before state update.
      if (row.delivery_parts>=parts.length) await stop('sent');
    } catch {
      // Stable per-part UUIDs permit retries only inside the service dedupe window.
      await env.DB.prepare(`UPDATE ai_workbench_tasks SET delivery_lease=NULL,delivery_lease_until=NULL WHERE id=? AND delivery_lease=?`).bind(row.id,lease).run();
    }
  }
}

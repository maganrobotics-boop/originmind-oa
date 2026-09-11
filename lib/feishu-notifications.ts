import { pendingCirculationPeople } from "./circulation-policy";

export type NotificationEnv = {
  DB: D1Database;
  FEISHU_NOTIFICATIONS_ENABLED?: string;
  FEISHU_LOGIN_APP_ID?: string;
  FEISHU_LOGIN_APP_SECRET?: string;
  FEISHU_LOGIN_TENANT_KEY?: string;
};
type Member = { id: string; account_user_id: string; chatgpt_account: string };
type Approval = { id: string; type: string; status: string; current_step: string; current_reviewer_email: string; requester_email: string; payload_json: string; cycle_id: number; return_id: number };
type Notice = { approvalId: string; memberId: string; accountUserId: string; kind: "pending" | "returned"; step: string; cycle: number; key: string };
type Outbox = { id: string; dedupe_key: string; approval_id: string | null; target_member_id: string; target_account_user_id: string; kind: string; step: string; cycle_id: number; attempts: number; first_attempt_at: number | null };
const email = (value: string) => value.trim().toLowerCase();

async function currentNotices(db: D1Database, id: string): Promise<Notice[]> {
  const approval = await db.prepare(`SELECT a.id, a.type, a.status, a.current_step, a.current_reviewer_email, a.requester_email,
    json_object('circulationRecipients', json_extract(a.payload_json, '$.circulationRecipients'),
      'circulationApprovers', json_extract(a.payload_json, '$.circulationApprovers'),
      'circulationConfirmations', json_extract(a.payload_json, '$.circulationConfirmations'),
      'circulationApprovals', json_extract(a.payload_json, '$.circulationApprovals')) AS payload_json,
    COALESCE((SELECT MAX(id) FROM approval_events WHERE approval_id = a.id AND action IN ('submitted', 'resubmit')), 0) AS cycle_id,
    COALESCE((SELECT MAX(id) FROM approval_events WHERE approval_id = a.id AND action IN ('return', 'force_return')), 0) AS return_id
    FROM approvals a WHERE a.id = ?`).bind(id).first<Approval>();
  if (!approval || !["待审核", "审批中", "已退回"].includes(approval.status)) return [];
  const kind = approval.status === "已退回" ? "returned" : "pending";
  const cycle = kind === "returned" ? approval.return_id : approval.cycle_id;
  if (!cycle) return [];
  const step = kind === "returned" ? "补充材料" : approval.current_step;
  const payload = JSON.parse(approval.payload_json) as Record<string, unknown>;
  const selected = kind === "pending" && approval.type === "流转审批"
    ? pendingCirculationPeople(payload, step).map((person) => ({ email: person.email, memberId: person.memberId, accountUserId: person.accountUserId }))
    : [{ email: kind === "returned" ? approval.requester_email : approval.current_reviewer_email, memberId: "", accountUserId: "" }];
  const result: Notice[] = [];
  const addresses = [...new Set(selected.map((person) => email(person.email)).filter(Boolean))];
  if (!addresses.length) return [];
  const { results: members } = await db.prepare(`SELECT id, account_user_id, chatgpt_account FROM members WHERE lower(chatgpt_account) IN (${addresses.map(() => "?").join(",")}) AND status = 'active' AND account_user_id IS NOT NULL`).bind(...addresses).all<Member>();
  for (const person of selected) {
    if (!person.email) continue;
    const member = members.find((member) => email(member.chatgpt_account) === email(person.email));
    if (!member || (person.memberId && (member.id !== person.memberId || member.account_user_id !== person.accountUserId))) continue;
    result.push({ approvalId: id, memberId: member.id, accountUserId: member.account_user_id, kind, step, cycle, key: JSON.stringify([id, cycle, kind, step, member.id, member.account_user_id]) });
  }
  return result;
}

export async function enqueueApprovalNotifications(db: D1Database) {
  const control = await db.prepare("SELECT last_event_id FROM notification_control WHERE id = 1").first<{ last_event_id: number }>();
  if (!control) throw new Error("NOTIFICATION_SCHEMA_MISSING");
  const { results: events } = await db.prepare("SELECT id, approval_id FROM approval_events WHERE id > ? ORDER BY id LIMIT 5").bind(control.last_event_id).all<{ id: number; approval_id: string }>();
  if (!events.length) return;
  for (const approvalId of new Set(events.map((event) => event.approval_id))) {
    const notices = await currentNotices(db, approvalId);
    const inserts = notices.map((notice) => {
      const now = Date.now();
      return db.prepare(`INSERT OR IGNORE INTO notification_outbox
        (id, dedupe_key, approval_id, target_member_id, target_account_user_id, kind, step, cycle_id, next_attempt_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), notice.key, notice.approvalId, notice.memberId, notice.accountUserId, notice.kind, notice.step, notice.cycle, now, now);
    });
    if (inserts.length) await db.batch(inserts);
  }
  // Reprocessing a crashed or competing scan is safe: notice keys are unique.
  await db.prepare("UPDATE notification_control SET last_event_id = MAX(last_event_id, ?) WHERE id = 1").bind(events.at(-1)!.id).run();
}

class DeliveryError extends Error { constructor(readonly code: string, readonly uncertain = false) { super(code); } }
async function feishuRequest(path: string, body: unknown, token?: string) {
  let response: Response;
  try { response = await fetch(`https://open.feishu.cn/open-apis/${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) }); }
  catch { throw new DeliveryError("FEISHU_NETWORK_ERROR", Boolean(token)); }
  const data = await response.json().catch(() => null) as { code?: number; tenant_access_token?: string; data?: { message_id?: string } } | null;
  if (!response.ok || !data || data.code !== 0) throw new DeliveryError(`FEISHU_${data?.code ?? response.status}`, !data || response.status >= 500);
  return data;
}

export async function deliverApprovalNotifications(env: NotificationEnv) {
  const { results: rows } = await env.DB.prepare(`SELECT id, dedupe_key, approval_id, target_member_id, target_account_user_id, kind, step, cycle_id, attempts, first_attempt_at
    FROM notification_outbox WHERE (status = 'pending' OR (status = 'sending' AND lease_expires_at < ?)) AND next_attempt_at <= ? ORDER BY created_at LIMIT 5`).bind(Date.now(), Date.now()).all<Outbox>();
  let token = "";
  const started = Date.now();
  for (const row of rows) {
    if (Date.now() - started > 20000) break;
    const now = Date.now(); const lease = crypto.randomUUID();
    const claimed = await env.DB.prepare(`UPDATE notification_outbox SET status = 'sending', lease_token = ?, lease_expires_at = ?, attempts = attempts + 1, first_attempt_at = COALESCE(first_attempt_at, ?)
      WHERE id = ? AND (status = 'pending' OR (status = 'sending' AND lease_expires_at < ?)) AND next_attempt_at <= ? RETURNING id`).bind(lease, now + 120000, now, row.id, now, now).first();
    if (!claimed) continue;
    const finish = (status: string, code: string | null, messageId: string | null = null, retryAt = now) => env.DB.prepare("UPDATE notification_outbox SET status = ?, failure_code = ?, message_id = ?, sent_at = ?, next_attempt_at = ?, lease_token = NULL, lease_expires_at = NULL WHERE id = ? AND lease_token = ?").bind(status, code, messageId, status === "sent" ? Date.now() : null, retryAt, row.id, lease).run();
    try {
      if (row.approval_id && !(await currentNotices(env.DB, row.approval_id)).some((notice) => notice.key === row.dedupe_key)) { await finish("skipped", "NO_LONGER_PENDING"); continue; }
      const identity = await env.DB.prepare(`SELECT i.provider_subject FROM auth_identities i JOIN members m ON m.id = i.member_id
        WHERE m.id = ? AND m.account_user_id = ? AND m.status = 'active' AND i.provider = 'feishu' AND i.unlinked_at IS NULL`).bind(row.target_member_id, row.target_account_user_id).first<{ provider_subject: string }>();
      const prefix = `${env.FEISHU_LOGIN_APP_ID}:${env.FEISHU_LOGIN_TENANT_KEY}:`;
      const openId = identity?.provider_subject.startsWith(prefix) ? identity.provider_subject.slice(prefix.length) : "";
      if (!/^ou[-_][A-Za-z0-9_-]{4,125}$/u.test(openId)) { await finish("failed", "FEISHU_MEMBER_NOT_LINKED"); continue; }
      // Feishu deduplicates uuid for one hour. Never blindly resend outside that window.
      if (row.first_attempt_at && now - row.first_attempt_at > 50 * 60000) { await finish("needs_review", "DELIVERY_WINDOW_EXPIRED"); continue; }
      if (!env.FEISHU_LOGIN_APP_ID || !env.FEISHU_LOGIN_APP_SECRET) throw new DeliveryError("FEISHU_CONFIG_MISSING");
      if (!token) {
        const credentials = await feishuRequest("auth/v3/tenant_access_token/internal", { app_id: env.FEISHU_LOGIN_APP_ID, app_secret: env.FEISHU_LOGIN_APP_SECRET });
        token = credentials.tenant_access_token || "";
        if (!token) throw new DeliveryError("FEISHU_TOKEN_MISSING");
      }
      const description = row.kind === "test" ? "【测试】OA 飞书提醒连接测试。无需办理任何审批。" : row.kind === "returned" ? "您的一项 OA 申请已退回，请登录查看原因并补充材料。" : `您有一项 OA 待办，当前节点：${row.step}。请登录处理。`;
      const link = row.approval_id ? `https://oa.omindos.ai/#approval=${encodeURIComponent(row.approval_id)}` : "https://oa.omindos.ai/";
      const text = `${description}\n${link}\n审批正文和处理权限以 OA 系统为准。`;
      const sent = await feishuRequest("im/v1/messages?receive_id_type=open_id", { receive_id: openId, msg_type: "text", content: JSON.stringify({ text }), uuid: row.id }, token);
      if (!sent.data?.message_id) throw new DeliveryError("FEISHU_MESSAGE_ID_MISSING", true);
      await finish("sent", null, sent.data.message_id);
    } catch (error) {
      const code = error instanceof DeliveryError ? error.code : "NOTIFICATION_DELIVERY_FAILED";
      const attempts = row.attempts + 1;
      await finish(attempts >= 6 ? "needs_review" : "pending", code, null, now + Math.min(16 * 60000, 60000 * 2 ** (attempts - 1)));
    }
  }
}

export async function processApprovalNotifications(env: NotificationEnv) {
  if (env.FEISHU_NOTIFICATIONS_ENABLED !== "true") return;
  try { await enqueueApprovalNotifications(env.DB); await deliverApprovalNotifications(env); }
  catch { console.error(JSON.stringify({ event: "feishu_notifications_failed", code: "NOTIFICATION_PROCESS_FAILED" })); }
}

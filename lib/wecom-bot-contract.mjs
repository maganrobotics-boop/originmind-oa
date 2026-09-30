export const BOT_MAX_BODY_BYTES = 24 * 1024;
export const BOT_MAX_TEXT_LENGTH = 4000;
export const BOT_CLOCK_WINDOW_MS = 60_000;
export const BOT_PAIRING_LIFETIME_MS = 5 * 60_000;
export const BOT_LEDGER_LIFETIME_MS = 2 * 24 * 60 * 60_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/u;
const PAIRING_CODE = /^[A-Za-z0-9_-]{22}$/u;

export function botConfiguration(environment) {
  const secret = environment.WECOM_BOT_BRIDGE_SECRET;
  const botId = environment.WECOM_BOT_ID;
  if (environment.WECOM_BOT_ENABLED !== 'true' || typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(secret)
    || typeof botId !== 'string' || !SAFE_ID.test(botId)) return null;
  return { secret, botId };
}

export function parseBotMessage(value, configuredBotId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'botId,messageId,text,userId') return null;
  if (value.botId !== configuredBotId || !SAFE_ID.test(value.botId)
    || typeof value.userId !== 'string' || !SAFE_ID.test(value.userId)
    || typeof value.messageId !== 'string' || !SAFE_ID.test(value.messageId)
    || typeof value.text !== 'string' || !value.text.trim() || value.text.length > BOT_MAX_TEXT_LENGTH
    || !value.text.isWellFormed() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.text)) return null;
  return { botId: value.botId, userId: value.userId, messageId: value.messageId, text: value.text.trim() };
}

export function parseBotCommand(text) {
  if (/^(?:\/帮助|帮助|help|\/help)$/iu.test(text)) return { kind: 'help' };
  const binding = /^(?:\/绑定|绑定)\s+([A-Za-z0-9_-]+)$/u.exec(text);
  if (binding) return PAIRING_CODE.test(binding[1]) ? { kind: 'bind', code: binding[1] } : { kind: 'invalid_binding' };
  if (/^(?:\/解绑|解绑)$/u.test(text)) return { kind: 'unlink' };
  if (/^(?:\/待办|我的待办|查一下我的待办|查看我的待办)$/u.test(text)) return { kind: 'work_items' };
  return { kind: 'question', question: text };
}

export function strictBotBrowserOrigin(request, environment) {
  let configured;
  try {
    const raw = environment.OA_PUBLIC_ORIGIN;
    if (typeof raw !== 'string') return false;
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
    configured = url.origin;
  } catch { return false; }
  return request.headers.get('origin') === configured
    && new URL(request.url).origin === configured
    && request.headers.get('sec-fetch-site') !== 'cross-site';
}

export function parseBotLinkAction(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { action } = value;
  if (action === 'create' || action === 'unlink') return Object.keys(value).length === 1 ? { action } : null;
  if (action !== 'confirm' && action !== 'cancel') return null;
  if (Object.keys(value).sort().join(',') !== 'action,pairingId'
    || typeof value.pairingId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.pairingId)) return null;
  return { action, pairingId: value.pairingId };
}

export function maskBotUserId(value) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) return '';
  return value.length <= 4 ? '*'.repeat(value.length) : `${value.slice(0, 2)}…${value.slice(-2)}`;
}

const encoder = new TextEncoder();
const hex = (bytes) => Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
export async function hashBotPairingCode(code) {
  if (!PAIRING_CODE.test(code)) throw new Error('invalid bot pairing code');
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(code))));
}
export function createBotPairingCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export async function signBotBody(secret, timestamp, body) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}\n${body}`))));
}

export async function readSignedBotMessage(request, configuration, now = Date.now()) {
  const timestamp = request.headers.get('x-oa-bot-timestamp') || '';
  const signature = request.headers.get('x-oa-bot-signature') || '';
  if (!/^[1-9]\d{12}$/u.test(timestamp) || Math.abs(now - Number(timestamp)) > BOT_CLOCK_WINDOW_MS
    || !/^[0-9a-f]{64}$/u.test(signature)) return { ok: false, status: 401 };
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return { ok: false, status: 415 };
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > BOT_MAX_BODY_BYTES) return { ok: false, status: 413 };
  if (!request.body) return { ok: false, status: 400 };
  const reader = request.body.getReader();
  const bytes = new Uint8Array(BOT_MAX_BODY_BYTES);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > BOT_MAX_BODY_BYTES - length) { await reader.cancel().catch(() => {}); return { ok: false, status: 413 }; }
      bytes.set(value, length); length += value.byteLength;
    }
  } catch { return { ok: false, status: 400 }; }
  finally { reader.releaseLock(); }
  let body;
  try { body = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)); } catch { return { ok: false, status: 400 }; }
  const key = await crypto.subtle.importKey('raw', encoder.encode(configuration.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const signatureBytes = Uint8Array.from(signature.match(/../gu), (value) => Number.parseInt(value, 16));
  if (!await crypto.subtle.verify('HMAC', key, signatureBytes, encoder.encode(`${timestamp}\n${body}`))) return { ok: false, status: 401 };
  let value;
  try { value = JSON.parse(body); } catch { return { ok: false, status: 400 }; }
  const message = parseBotMessage(value, configuration.botId);
  return message ? { ok: true, message } : { ok: false, status: 400 };
}

// All parameters are server-constructed and passed as one JSON SQL binding.
// Keeping the actual statements here lets SQLite tests exercise the same atomic
// transitions used by D1 and the standalone OA database adapter.
const j = (key) => `(SELECT json_extract(value, '$.${key}') FROM ctx)`;
const context = `WITH ctx AS (SELECT json(?) AS value)`;
const unfrozen = `NOT EXISTS (SELECT 1 FROM migration_control WHERE deactivated_at IS NULL)`;
const memberGuard = `EXISTS (SELECT 1 FROM members AS m WHERE m.id = ${j('memberId')}
  AND m.status = 'active' AND m.account_user_id = ${j('accountUserId')}
  AND m.mutation_revision = ${j('memberRevision')} AND m.account_binding_previous_status IS NULL
  AND (${j('isAdmin')} = 1 OR EXISTS (SELECT 1 FROM approvals AS nda
    WHERE nda.id=${j('ndaApprovalId')} AND nda.type='保密协议' AND nda.status='已归档'
      AND lower(trim(nda.requester_email))=lower(trim(m.chatgpt_account)) AND nda.updated_at=${j('ndaAcceptedAt')}
      AND CASE WHEN json_valid(nda.payload_json) THEN json_extract(nda.payload_json,'$.signerAccountUserId')=${j('accountUserId')}
        AND json_extract(nda.payload_json,'$.agreementVersion')=${j('ndaAgreementVersion')} ELSE 0 END)))`;
const pairingMemberGuard = `EXISTS (SELECT 1 FROM members AS m WHERE m.id = wecom_bot_pairings.member_id
  AND m.status = 'active' AND m.account_user_id = wecom_bot_pairings.account_user_id
  AND m.mutation_revision = wecom_bot_pairings.member_revision AND m.account_binding_previous_status IS NULL
  AND (wecom_bot_pairings.member_is_admin = 1 OR EXISTS (SELECT 1 FROM approvals AS nda
    WHERE nda.id=wecom_bot_pairings.member_nda_approval_id AND nda.type='保密协议' AND nda.status='已归档'
      AND lower(trim(nda.requester_email))=lower(trim(m.chatgpt_account)) AND nda.updated_at=wecom_bot_pairings.member_nda_accepted_at
      AND CASE WHEN json_valid(nda.payload_json) THEN json_extract(nda.payload_json,'$.signerAccountUserId')=wecom_bot_pairings.account_user_id
        AND json_extract(nda.payload_json,'$.agreementVersion')=wecom_bot_pairings.member_nda_agreement_version ELSE 0 END)))`;
const pairingOwner = `member_id = ${j('memberId')} AND account_user_id = ${j('accountUserId')}`;
const pairingSnapshot = `${pairingOwner} AND member_revision = ${j('memberRevision')}
  AND member_is_admin = ${j('isAdmin')} AND member_nda_accepted_at IS ${j('ndaAcceptedAt')}
  AND member_nda_approval_id IS ${j('ndaApprovalId')}
  AND member_nda_agreement_version IS ${j('ndaAgreementVersion')}`;
const linkGuard = `EXISTS (SELECT 1 FROM wecom_bot_links AS live_link
  WHERE live_link.bot_id = ${j('botId')} AND live_link.user_id = ${j('userId')} AND live_link.revoked_at IS NULL
  AND live_link.member_id = ${j('memberId')} AND live_link.account_user_id = ${j('accountUserId')}
  AND live_link.revision = ${j('linkRevision')})`;

export const BOT_SQL = {
  cleanupMessages: `${context} DELETE FROM wecom_bot_messages WHERE expires_at < ${j('now')} AND ${unfrozen}`,
  cleanupPairings: `${context} DELETE FROM wecom_bot_pairings WHERE expires_at < ${j('cutoff')} AND ${unfrozen}`,
  claimMessage: `${context} INSERT INTO wecom_bot_messages (bot_id,message_id,user_id,created_at,expires_at)
    SELECT ${j('botId')},${j('messageId')},${j('userId')},${j('now')},${j('expiresAt')} FROM ctx
    WHERE ${unfrozen}
      AND (SELECT count(*) FROM wecom_bot_messages WHERE bot_id=${j('botId')} AND user_id=${j('userId')} AND created_at>=${j('rateCutoff')}) < 20
      AND (SELECT count(*) FROM wecom_bot_messages WHERE bot_id=${j('botId')} AND created_at>=${j('rateCutoff')}) < 1000
    ON CONFLICT(bot_id,message_id) DO NOTHING RETURNING message_id`,
  cancelPrevious: `${context} UPDATE wecom_bot_pairings SET state='cancelled',updated_at=${j('now')}
    WHERE bot_id=${j('botId')} AND member_id=${j('memberId')} AND state IN ('pending','candidate') AND ${memberGuard} AND ${unfrozen}
      AND (SELECT count(*) FROM wecom_bot_pairings WHERE bot_id=${j('botId')} AND member_id=${j('memberId')} AND created_at>=${j('rateCutoff')}) < 5`,
  revokeStaleLink: `${context} UPDATE wecom_bot_links SET revoked_at=${j('now')},updated_at=${j('now')},revision=${j('staleRevision')}
    WHERE bot_id=${j('botId')} AND member_id=${j('memberId')} AND account_user_id<>${j('accountUserId')}
      AND revoked_at IS NULL AND ${memberGuard} AND ${unfrozen} RETURNING user_id`,
  staleLinkEvent: `${context} INSERT INTO member_events (member_id,actor_name,actor_email,action,note,created_at)
    SELECT ${j('memberId')},${j('name')},${j('email')},'wecom_bot_unlinked','OA 账号变更后，已清理旧的企微机器人连接；新账号须重新确认绑定。',${j('now')}
    FROM ctx WHERE ${unfrozen} AND EXISTS (SELECT 1 FROM wecom_bot_links WHERE bot_id=${j('botId')} AND member_id=${j('memberId')}
      AND revision=${j('staleRevision')} AND revoked_at=${j('now')})`,
  createPairing: `${context} INSERT INTO wecom_bot_pairings
    (id,bot_id,code_hash,member_id,account_user_id,member_revision,member_nda_approval_id,member_nda_accepted_at,member_nda_agreement_version,member_is_admin,state,created_at,expires_at,updated_at)
    SELECT ${j('pairingId')},${j('botId')},${j('codeHash')},${j('memberId')},${j('accountUserId')},${j('memberRevision')},
      ${j('ndaApprovalId')},${j('ndaAcceptedAt')},${j('ndaAgreementVersion')},${j('isAdmin')},'pending',${j('now')},${j('expiresAt')},${j('now')}
    FROM ctx WHERE ${memberGuard} AND ${unfrozen}
      AND (SELECT count(*) FROM wecom_bot_pairings WHERE bot_id=${j('botId')} AND member_id=${j('memberId')} AND created_at>=${j('rateCutoff')}) < 5
      AND NOT EXISTS (SELECT 1 FROM wecom_bot_links WHERE bot_id=${j('botId')} AND member_id=${j('memberId')} AND revoked_at IS NULL)
    RETURNING id`,
  claimPairing: `${context} UPDATE wecom_bot_pairings SET state='candidate',candidate_user_id=${j('userId')},updated_at=${j('now')}
    WHERE bot_id=${j('botId')} AND code_hash=${j('codeHash')} AND state='pending' AND expires_at>${j('now')}
      AND ${pairingMemberGuard} AND ${unfrozen}
      AND NOT EXISTS (SELECT 1 FROM wecom_bot_links WHERE bot_id=${j('botId')} AND user_id=${j('userId')} AND revoked_at IS NULL)
    RETURNING id`,
  confirmLink: `${context} INSERT INTO wecom_bot_links
    (bot_id,user_id,member_id,account_user_id,linked_member_revision,revision,created_at,updated_at,revoked_at)
    SELECT bot_id,candidate_user_id,member_id,account_user_id,member_revision,${j('newRevision')},${j('now')},${j('now')},NULL
    FROM wecom_bot_pairings WHERE id=${j('pairingId')} AND bot_id=${j('botId')} AND ${pairingSnapshot}
      AND state='candidate' AND expires_at>${j('now')} AND ${memberGuard} AND ${unfrozen}
      AND NOT EXISTS (SELECT 1 FROM wecom_bot_links WHERE bot_id=${j('botId')} AND member_id=${j('memberId')} AND revoked_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM wecom_bot_links WHERE bot_id=${j('botId')} AND user_id=candidate_user_id AND revoked_at IS NULL)
    ON CONFLICT(bot_id,user_id) DO UPDATE SET member_id=excluded.member_id,account_user_id=excluded.account_user_id,
      linked_member_revision=excluded.linked_member_revision,revision=excluded.revision,created_at=excluded.created_at,
      updated_at=excluded.updated_at,revoked_at=NULL WHERE wecom_bot_links.revoked_at IS NOT NULL RETURNING user_id`,
  finishPairing: `${context} UPDATE wecom_bot_pairings SET state='confirmed',link_revision=${j('newRevision')},updated_at=${j('now')}
    WHERE id=${j('pairingId')} AND bot_id=${j('botId')} AND ${pairingSnapshot} AND state='candidate'
      AND ${memberGuard} AND ${unfrozen} AND EXISTS (SELECT 1 FROM wecom_bot_links WHERE bot_id=${j('botId')}
        AND user_id=candidate_user_id AND member_id=${j('memberId')} AND account_user_id=${j('accountUserId')}
        AND revision=${j('newRevision')} AND revoked_at IS NULL) RETURNING id`,
  linkEvent: `${context} INSERT INTO member_events (member_id,actor_name,actor_email,action,note,created_at)
    SELECT ${j('memberId')},${j('name')},${j('email')},'wecom_bot_linked','企业微信智能机器人账号已由本人在 OA 确认绑定。',${j('now')}
    FROM ctx WHERE ${unfrozen} AND EXISTS (SELECT 1 FROM wecom_bot_pairings WHERE id=${j('pairingId')}
      AND member_id=${j('memberId')} AND state='confirmed' AND link_revision=${j('newRevision')})`,
  cancelPairing: `${context} UPDATE wecom_bot_pairings SET state='cancelled',updated_at=${j('now')}
    WHERE id=${j('pairingId')} AND bot_id=${j('botId')} AND ${pairingOwner} AND state IN ('pending','candidate') AND ${memberGuard} AND ${unfrozen} RETURNING id`,
  unlink: `${context} UPDATE wecom_bot_links SET revoked_at=${j('now')},updated_at=${j('now')},revision=${j('newRevision')}
    WHERE bot_id=${j('botId')} AND member_id=${j('memberId')} AND account_user_id=${j('accountUserId')}
      AND revision=${j('linkRevision')} AND revoked_at IS NULL AND ${memberGuard} AND ${unfrozen} RETURNING user_id`,
  unlinkEvent: `${context} INSERT INTO member_events (member_id,actor_name,actor_email,action,note,created_at)
    SELECT ${j('memberId')},${j('name')},${j('email')},'wecom_bot_unlinked','企业微信智能机器人账号已由本人解绑。',${j('now')}
    FROM ctx WHERE ${unfrozen} AND EXISTS (SELECT 1 FROM wecom_bot_links WHERE bot_id=${j('botId')} AND member_id=${j('memberId')}
      AND account_user_id=${j('accountUserId')} AND revision=${j('newRevision')} AND revoked_at=${j('now')})`,
  ownPairing: `${context} SELECT id,state,candidate_user_id,expires_at,member_revision FROM wecom_bot_pairings
    WHERE bot_id=${j('botId')} AND ${pairingOwner} AND state IN ('pending','candidate') AND expires_at>${j('now')}
      AND member_revision=${j('memberRevision')} AND ${memberGuard} ORDER BY created_at DESC LIMIT 1`,
  ownLink: `${context} SELECT * FROM wecom_bot_links WHERE bot_id=${j('botId')} AND member_id=${j('memberId')}
    AND account_user_id=${j('accountUserId')} AND revoked_at IS NULL AND ${memberGuard} LIMIT 1`,
  senderLink: `${context} SELECT * FROM wecom_bot_links WHERE bot_id=${j('botId')} AND user_id=${j('userId')} AND revoked_at IS NULL LIMIT 1`,
  currentLink: `${context} SELECT revision FROM wecom_bot_links WHERE bot_id=${j('botId')} AND user_id=${j('userId')}
    AND member_id=${j('memberId')} AND account_user_id=${j('accountUserId')} AND revision=${j('linkRevision')}
    AND revoked_at IS NULL AND ${memberGuard} LIMIT 1`,
  ownWorkItems: `${context} SELECT id,title,status,priority,due_at FROM project_work_items WHERE project=${j('project')}
    AND status IN ('open','in_progress') AND (lower(trim(assignee_email))=${j('email')} OR lower(trim(created_by_email))=${j('email')})
    AND ${memberGuard} AND ${linkGuard}
    ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,COALESCE(due_at,'9999-12-31'),updated_at DESC LIMIT 20`,
  activeKnowledge: `${context}, bot_candidates AS (
    SELECT c.id,c.item_id,c.revision_id,r.title,r.category,r.source_label,r.source_url,
      c.section_title,c.paragraph_ref,c.content,c.search_text,i.updated_at,
      (SELECT sum(length(search_term.value)) FROM json_each(${j('terms')}) AS search_term
        WHERE instr(c.search_text,search_term.value)>0) AS keyword_score,
      ROW_NUMBER() OVER (PARTITION BY c.item_id ORDER BY c.chunk_no ASC) AS item_candidate_rank
    FROM knowledge_chunks AS c
    INNER JOIN knowledge_items AS i ON i.id=c.item_id
    INNER JOIN knowledge_revisions AS r ON r.id=c.revision_id AND r.item_id=i.id
    WHERE c.is_active=1 AND i.status='active' AND i.visibility IN ('internal','public')
      AND r.status='active' AND i.active_revision_id=c.revision_id AND ${memberGuard} AND ${linkGuard}
      AND EXISTS (SELECT 1 FROM json_each(${j('terms')}) AS search_term WHERE instr(c.search_text,search_term.value)>0)
  ) SELECT id,item_id,revision_id,title,category,source_label,source_url,section_title,paragraph_ref,content,search_text,updated_at
    FROM bot_candidates ORDER BY keyword_score DESC,item_candidate_rank ASC,updated_at DESC,item_id ASC,id ASC LIMIT 256`,
  currentEvidence: `${context} SELECT count(*) AS matched_count
    FROM json_each(${j('evidence')}) AS selected
    INNER JOIN knowledge_chunks AS c ON c.id=json_extract(selected.value,'$.id')
      AND c.item_id=json_extract(selected.value,'$.itemId') AND c.revision_id=json_extract(selected.value,'$.revisionId')
    INNER JOIN knowledge_items AS i ON i.id=c.item_id
    INNER JOIN knowledge_revisions AS r ON r.id=c.revision_id AND r.item_id=i.id
    WHERE c.is_active=1 AND i.status='active' AND i.visibility IN ('internal','public')
      AND r.status='active' AND i.active_revision_id=c.revision_id AND ${memberGuard} AND ${linkGuard}
      AND c.content=json_extract(selected.value,'$.content') AND r.title=json_extract(selected.value,'$.title')`,
};

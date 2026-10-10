// Copyright (c) 2026 OriginMind. All rights reserved.
import { PublicError } from './errors.mjs';

export const HONOR_CATEGORIES = Object.freeze({
  newbie: '新手村通关', alumni: '毕业纪念', competition: '竞赛获奖',
  contribution: '项目贡献', other: '其他荣誉',
});
const ID = /^[a-z0-9-]{10,64}$/u;
const PUBLIC_COLUMNS = 'id,recipient_name AS name,category,title,message,' +
  'achievement_date AS achievementDate,granted_at AS issuedAt';
const ADMIN_COLUMNS = `${PUBLIC_COLUMNS},recipient_email AS recipientEmail,` +
  'source_kind AS sourceKind,source_reference AS sourceReference,granted_by AS grantedBy,' +
  'visibility,status,version,updated_at AS updatedAt';

function object(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !keys.includes(key))) {
    throw new PublicError('荣誉内容格式不正确。', 400);
  }
}
function text(value, maximum, label, required = false) {
  if (typeof value !== 'string') throw new PublicError(`${label}格式不正确。`, 400);
  const result = value.trim();
  if ((required && !result) || result.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(result)) {
    throw new PublicError(`${label}不能为空或超过 ${maximum} 个字符。`, 400);
  }
  return result;
}
function category(value, optional = false) {
  if (optional && !value) return null;
  if (!Object.hasOwn(HONOR_CATEGORIES, value)) throw new PublicError('荣誉类别不正确。', 400);
  return value;
}
function date(value) {
  if (value === '' || value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value ||
      value > new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)) {
    throw new PublicError('请填写真实的历史日期（YYYY-MM-DD），未知可留空。', 400);
  }
  return value;
}
function publicAward(row) {
  // Explicit allowlist: account IDs, evidence, actors and audit notes stay private.
  return {
    id: row.id, name: row.name, category: row.category,
    categoryLabel: HONOR_CATEGORIES[row.category], title: row.title, message: row.message,
    achievementDate: row.achievementDate, issuedAt: row.issuedAt,
    issuedBy: 'OriginMind × ARTS Robotics', confirmation: '经人工确认',
    image: '/learning/honors-trophy.svg',
  };
}
function query(url, allowed) {
  if ([...url.searchParams.keys()].some(key => !allowed.includes(key)) ||
      allowed.some(key => url.searchParams.getAll(key).length > 1)) {
    throw new PublicError('查询参数不正确。', 400);
  }
}
function pageNumber(url) {
  const raw = url.searchParams.get('page') ?? '1';
  if (!/^[1-9]\d{0,4}$/u.test(raw)) throw new PublicError('页码不正确。', 400);
  return Number(raw);
}
async function account(db, value) {
  if (value === '' || value === null || value === undefined) return null;
  const email = text(value, 254, '账户邮箱', true).toLowerCase();
  if (!/^[a-z0-9._%+-]+@(?:stumail\.)?sztu\.edu\.cn$/u.test(email)) {
    throw new PublicError('请选择系统内的校内账户；无账户的历届学生可暂不绑定。', 400);
  }
  const found = await db.prepare(
    'SELECT email FROM newbie_profiles WHERE email=? UNION SELECT email FROM newbie_agreement_acceptances WHERE email=? ' +
    'UNION SELECT email FROM visitor_sessions WHERE email=? LIMIT 1',
  ).bind(email, email, email).first();
  if (!found) throw new PublicError('未找到此账户，请先核对系统内的账号。', 400);
  return email;
}

export async function handleHonorsRequest(context, helpers) {
  const { request, env } = context;
  const { json, readJson, currentVisitor, requireOwner, sameOrigin, limit } = helpers;
  const db = env.DB;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const reply = (data, status = 200) => json(data, status, { 'Cache-Control': 'no-store' });
  const detail = path.match(/^\/api\/learning\/honors\/([a-z0-9-]{10,64})$/u);

  if (path === '/api/learning/honors' || path === '/api/learning/my-honors' || detail) {
    if (method !== 'GET') return reply({ error: '此接口仅支持查看。' }, 405);
    if (detail) {
      query(url, []);
      await limit(context, 'honors-read', 1200, 3600);
      const row = await db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM learning_honors ` +
        "WHERE id=? AND status='granted' AND visibility='public'").bind(detail[1]).first();
      if (!row) throw new PublicError('此荣誉暂不可查看。', 404);
      return reply({ awards: [publicAward(row)] });
    }
    if (path.endsWith('/my-honors')) {
      query(url, []);
      const visitor = await currentVisitor(context);
      if (!visitor) throw new PublicError('请先登录后查看个人奖杯。', 401);
      const rows = await db.prepare(`SELECT ${PUBLIC_COLUMNS},visibility FROM learning_honors ` +
        "WHERE recipient_email=? AND status='granted' ORDER BY granted_at DESC,id LIMIT 201")
        .bind(visitor.email).all();
      return reply({ awards: rows.results.slice(0, 200).map(row => ({ ...publicAward(row), visibility: row.visibility })),
        hasMore: rows.results.length > 200 });
    }
    query(url, ['category', 'page']);
    await limit(context, 'honors-read', 1200, 3600);
    const type = category(url.searchParams.get('category'), true);
    const page = pageNumber(url);
    const rows = await db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM learning_honors ` +
      "WHERE status='granted' AND visibility='public' AND (? IS NULL OR category=?) " +
      'ORDER BY granted_at DESC,id LIMIT 25 OFFSET ?').bind(type, type, (page - 1) * 24).all();
    return reply({ awards: rows.results.slice(0, 24).map(publicAward), page, hasMore: rows.results.length > 24 });
  }

  const owner = await requireOwner(context);
  if (method === 'POST') {
    sameOrigin(context);
    await limit(context, 'honors-write', 120, 900);
  }
  if (path === '/api/admin/honors/recipients' && method === 'GET') {
    query(url, ['q']);
    const search = text(url.searchParams.get('q') ?? '', 254, '查询内容', true);
    // Search is only a suggestion. Never resolve a name into an account automatically.
    const rows = await db.prepare(
      "SELECT emails.email,p.display_name AS displayName,a.signer_name AS signerName,a.accepted_at AS acceptedAt " +
      'FROM (SELECT email FROM newbie_profiles UNION SELECT email FROM newbie_agreement_acceptances ' +
      'UNION SELECT email FROM visitor_sessions) emails LEFT JOIN newbie_profiles p ON p.email=emails.email ' +
      'LEFT JOIN newbie_agreement_acceptances a ON a.email=emails.email AND a.agreement_version=' +
      '(SELECT agreement_version FROM newbie_agreement_acceptances WHERE email=emails.email ORDER BY accepted_at DESC,agreement_version LIMIT 1) ' +
      'WHERE instr(emails.email,?)>0 OR instr(p.display_name,?)>0 OR instr(a.signer_name,?)>0 ORDER BY emails.email LIMIT 25',
    ).bind(search.toLowerCase(), search, search).all();
    return reply({ recipients: rows.results });
  }
  if (path === '/api/admin/honors' && method === 'GET') {
    query(url, ['status', 'category', 'page']);
    const status = url.searchParams.get('status') || 'all';
    if (!['all', 'public', 'hidden', 'revoked', 'unbound'].includes(status)) throw new PublicError('状态不正确。', 400);
    const type = category(url.searchParams.get('category'), true);
    const page = pageNumber(url);
    const clauses = {
      all: '1=1', public: "status='granted' AND visibility='public'", hidden: "status='granted' AND visibility='hidden'",
      revoked: "status='revoked'", unbound: "recipient_email IS NULL AND status='granted'",
    };
    const rows = await db.prepare(`SELECT ${ADMIN_COLUMNS} FROM learning_honors WHERE ${clauses[status]} ` +
      'AND (? IS NULL OR category=?) ORDER BY granted_at DESC,id LIMIT 25 OFFSET ?')
      .bind(type, type, (page - 1) * 24).all();
    return reply({ awards: rows.results.slice(0, 24), page, hasMore: rows.results.length > 24 });
  }
  if (path === '/api/admin/honors' && method === 'POST') {
    query(url, []);
    const input = await readJson(request, 12000);
    object(input, ['requestId', 'name', 'recipientEmail', 'category', 'title', 'message', 'achievementDate',
      'sourceKind', 'sourceReference', 'confirmed', 'visibility', 'bindingNote']);
    if (typeof input.requestId !== 'string' || !ID.test(input.requestId) || input.confirmed !== true) throw new PublicError('请确认荣誉事实和来源。', 400);
    const name = text(input.name, 80, '获奖人姓名', true);
    const type = category(input.category);
    const title = text(input.title, 100, '荣誉名称', true);
    const message = text(input.message ?? '', 600, '公开事迹');
    const achievementDate = date(input.achievementDate);
    if (!['manual_confirmation', 'reference'].includes(input.sourceKind)) throw new PublicError('确认方式不正确。', 400);
    const source = text(input.sourceReference, 1200, '确认依据', true);
    const email = await account(db, input.recipientEmail);
    const bindingNote = text(input.bindingNote ?? '', 600, '账户核验说明', Boolean(email));
    const visibility = input.visibility ?? 'public';
    if (!['public', 'hidden'].includes(visibility)) throw new PublicError('展示范围不正确。', 400);
    const now = Date.now();
    const results = await db.batch([
      db.prepare('INSERT OR IGNORE INTO learning_honors ' +
        '(id,recipient_name,recipient_email,category,title,message,achievement_date,source_kind,source_reference,granted_by,granted_at,visibility,updated_at) ' +
        'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(input.requestId, name, email, type, title, message,
        achievementDate, input.sourceKind, source, owner.email, now, visibility, now),
      db.prepare("INSERT OR IGNORE INTO learning_honor_events(honor_id,version,action,actor,occurred_at,note) " +
        "SELECT id,1,'grant',granted_by,granted_at,? FROM learning_honors WHERE id=? AND version=1")
        .bind(source + (email ? `\n账户核验：${bindingNote}\n关联账户：${email}` : ''), input.requestId),
    ]);
    const row = await db.prepare(`SELECT ${ADMIN_COLUMNS} FROM learning_honors WHERE id=?`).bind(input.requestId).first();
    if (!row || row.name !== name || row.recipientEmail !== email || row.category !== type || row.title !== title ||
        row.message !== message || row.achievementDate !== achievementDate || row.sourceKind !== input.sourceKind ||
        row.sourceReference !== source || row.grantedBy !== owner.email || row.visibility !== visibility) {
      throw new PublicError('此次提交标识已被使用，请刷新后重试。', 409);
    }
    return reply({ saved: true, award: row, replayed: !results[0].meta.changes }, results[0].meta.changes ? 201 : 200);
  }
  const match = path.match(/^\/api\/admin\/honors\/([a-z0-9-]{10,64})(?:\/(events|action))?$/u);
  if (match && match[2] === 'events' && method === 'GET') {
    query(url, []);
    const row = await db.prepare('SELECT id FROM learning_honors WHERE id=?').bind(match[1]).first();
    if (!row) throw new PublicError('荣誉记录不存在。', 404);
    const rows = await db.prepare('SELECT version,action,actor,occurred_at AS occurredAt,note ' +
      'FROM learning_honor_events WHERE honor_id=? ORDER BY version DESC LIMIT 200').bind(match[1]).all();
    return reply({ events: rows.results });
  }
  if (match && match[2] === 'action' && method === 'POST') {
    query(url, []);
    const input = await readJson(request, 5000);
    object(input, ['action', 'version', 'note', 'recipientEmail', 'confirmed']);
    if (!['bind', 'hide', 'show', 'revoke'].includes(input.action) || !Number.isSafeInteger(input.version) || input.version < 1) {
      throw new PublicError('荣誉操作格式不正确。', 400);
    }
    const note = text(input.note ?? '', 1200, '操作说明', true);
    let email = null;
    if (input.action === 'bind') {
      if (input.confirmed !== true) throw new PublicError('请先人工核对账户身份。', 400);
      email = await account(db, input.recipientEmail);
      if (!email) throw new PublicError('绑定需要选择准确的账户。', 400);
    } else if (input.recipientEmail !== undefined || input.confirmed !== undefined) {
      throw new PublicError('此操作不能更改账户。', 400);
    }
    const now = Date.now();
    const edits = { bind: 'recipient_email=?', hide: "visibility='hidden'", show: "visibility='public'", revoke: "status='revoked'" };
    // Audit insertion and guarded update run in one atomic batch. A stale version
    // inserts nothing and updates nothing; a constraint failure rolls both back.
    const results = await db.batch([
      db.prepare('INSERT INTO learning_honor_events(honor_id,version,action,actor,occurred_at,note) ' +
        "SELECT id,version+1,?,?,?,? FROM learning_honors WHERE id=? AND version=? AND status='granted'")
        .bind(input.action, owner.email, now, note + (email ? `\n关联账户：${email}` : ''), match[1], input.version),
      db.prepare(`UPDATE learning_honors SET ${edits[input.action]},version=version+1,updated_at=? ` +
        "WHERE id=? AND version=? AND status='granted'").bind(...(email ? [email] : []), now, match[1], input.version),
    ]);
    if (!results[1].meta.changes) throw new PublicError('记录已变更或已撤回，请刷新后重试。', 409);
    const row = await db.prepare(`SELECT ${ADMIN_COLUMNS} FROM learning_honors WHERE id=?`).bind(match[1]).first();
    return reply({ saved: true, award: row });
  }
  return reply({ error: '没有找到此荣誉接口。' }, 404);
}

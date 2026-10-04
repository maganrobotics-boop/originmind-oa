// Copyright (c) 2026 OriginMind. All rights reserved.
import { honorDate } from '/learning/honors.mjs';

const $ = selector => document.querySelector(selector);
const state = { awards: [], generation: 0, auditGeneration: 0, page: 0, selected: null, requestId: '', grantSignature: '', searchGeneration: new WeakMap() };
const actionLabels = { bind: '绑定账户', hide: '隐藏公开展示', show: '恢复公开展示', revoke: '撤回荣誉', grant: '授予', import: '导入既有荣誉' };
const actionExplanation = { bind: '核对姓名与系统内的准确账户，确认后个人主页会展示奖杯。',
  hide: '隐藏后，荣誉仅在获奖人登录后的个人主页展示。', show: '恢复后，所有人均可在荣誉墙查看此荣誉。', revoke: '撤回后，个人奖杯与公共荣誉墙均停止展示此荣誉，历史记录仍会保留。' };
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
async function request(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options,
    headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || '操作未确认成功，请稍后重试。'); error.status = response.status; throw error; }
  return data;
}
function showLogin(message = '') {
  state.generation++; state.awards = []; state.selected = null;
  $('#honors-admin-list').replaceChildren();
  $('#honors-audit-list').replaceChildren();
  $('#honors-grant-form').reset();
  setGrantOpen(false);
  $('#honors-grant-status').textContent = '';
  document.querySelectorAll('.honors-account-picker [name="recipientEmail"]').forEach(select => select.replaceChildren(new Option('暂不绑定账户', '')));
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  $('#honors-admin-app').hidden = true; $('#honors-login').hidden = false; $('#honors-logout').hidden = true;
  $('#honors-login-status').textContent = message;
}
function adminError(error, status) {
  if ([401, 403].includes(error.status)) { showLogin(error.message); return; }
  status.textContent = error.message;
}
function setGrantOpen(open) {
  $('#honors-grant-form').hidden = !open;
  $('#honors-grant-toggle').setAttribute('aria-expanded', String(open));
  $('#honors-grant-toggle').textContent = open ? '收起补录' : '补录历史荣誉';
  if (open) $('#honors-grant-form [name="name"]').focus();
}
function record(award) {
  const card = el('article', undefined, 'honors-card');
  const head = el('div', undefined, 'honors-card-top');
  head.append(el('h2', `${award.name} · ${award.title}`), el('span', award.status === 'revoked' ? '已撤回' : award.visibility === 'public' ? '公开展示' : '仅本人可见', 'honors-badge'));
  card.append(head, el('p', `账户：${award.recipientEmail || '待核验绑定'}\n授予日期：${honorDate(award.issuedAt)}${award.achievementDate ? `\n事迹日期：${award.achievementDate}` : ''}`, 'honors-private'));
  const actions = el('div', undefined, 'honors-actions');
  if (award.status === 'granted') {
    for (const action of ['bind', award.visibility === 'public' ? 'hide' : 'show', 'revoke']) {
      const button = el('button', action === 'bind' && award.recipientEmail ? '更正账户绑定' : actionLabels[action], `honors-button ${action === 'revoke' ? 'danger' : 'secondary'}`);
      button.type = 'button'; button.addEventListener('click', () => openAction(award, action)); actions.append(button);
    }
  }
  const audit = el('button', '查看来源与操作记录', 'honors-button secondary');
  audit.type = 'button'; audit.addEventListener('click', () => void showAudit(award)); actions.append(audit);
  card.append(actions);
  return card;
}
async function load(reset = false) {
  if (reset) { state.generation++; state.page = 0; state.awards = []; $('#honors-admin-list').replaceChildren(); }
  const current = state.generation;
  $('#honors-admin-more').hidden = true; $('#honors-admin-status').textContent = '正在读取荣誉记录…';
  try {
    const data = await request(`/api/admin/honors?status=${encodeURIComponent($('#honors-admin-filter').value)}&page=${state.page + 1}`);
    if (current !== state.generation) return;
    $('#honors-admin-app').hidden = false; $('#honors-login').hidden = true; $('#honors-logout').hidden = false;
    state.page = data.page; state.awards.push(...data.awards);
    $('#honors-admin-list').append(...data.awards.map(record));
    $('#honors-admin-more').hidden = !data.hasMore;
    $('#honors-admin-status').textContent = state.awards.length ? `已读取 ${state.awards.length} 条记录` : '当前没有符合条件的荣誉记录。';
  } catch (error) { if (current === state.generation) adminError(error, $('#honors-admin-status')); }
}
async function searchAccounts(picker) {
  const sessionGeneration = state.generation;
  const generation = (state.searchGeneration.get(picker) || 0) + 1;
  state.searchGeneration.set(picker, generation);
  const input = picker.querySelector('[name="recipientSearch"]');
  const select = picker.querySelector('[name="recipientEmail"]');
  const status = picker.querySelector('[data-search-status]');
  select.replaceChildren(new Option('暂不绑定账户', ''));
  status.textContent = '正在查询…';
  try {
    const data = await request(`/api/admin/honors/recipients?q=${encodeURIComponent(input.value.trim())}`);
    if (generation !== state.searchGeneration.get(picker) || sessionGeneration !== state.generation || !$('#honors-login').hidden) return;
    for (const candidate of data.recipients) select.append(new Option(`${candidate.email} · 签署姓名：${candidate.signerName || '暂无'} · 个人姓名：${candidate.displayName || '暂无'}`, candidate.email));
    status.textContent = data.recipients.length ? '请核对真实身份后手动选择；同名账户需进一步确认。' : '未找到匹配的系统账户，可先不绑定。';
  } catch (error) { if (generation === state.searchGeneration.get(picker)) adminError(error, status); }
}
function openAction(award, action) {
  state.selected = { award, action };
  const form = $('#honors-action-form'); form.reset();
  const picker = $('#honors-bind-fields');
  state.searchGeneration.set(picker, (state.searchGeneration.get(picker) || 0) + 1);
  picker.querySelector('[name="recipientEmail"]').replaceChildren(new Option('请选择准确的账户', ''));
  picker.querySelector('[data-search-status]').textContent = '';
  $('#honors-action-title').textContent = actionLabels[action];
  $('#honors-action-person').textContent = `${award.name} · ${award.title}`;
  $('#honors-action-explanation').textContent = actionExplanation[action];
  picker.hidden = action !== 'bind';
  picker.disabled = action !== 'bind';
  picker.querySelector('[name="confirmed"]').required = action === 'bind';
  picker.querySelector('[name="recipientEmail"]').required = action === 'bind';
  picker.querySelector('[name="recipientSearch"]').value = award.name;
  $('#honors-action-status').textContent = '';
  $('#honors-action-dialog').showModal();
}
async function showAudit(award) {
  const auditGeneration = ++state.auditGeneration;
  $('#honors-audit-list').replaceChildren(); $('#honors-audit-status').textContent = '正在读取历史记录…';
  $('#honors-audit-dialog').showModal();
  const generation = state.generation;
  try {
    const data = await request(`/api/admin/honors/${encodeURIComponent(award.id)}/events`);
    if (generation !== state.generation || auditGeneration !== state.auditGeneration || !$('#honors-audit-dialog').open) return;
    $('#honors-audit-list').append(el('p', `确认方式：${award.sourceKind === 'reference' ? '可追溯来源' : '人工确认'}\n确认依据：${award.sourceReference}\n授予记录：${award.grantedBy}`, 'honors-private'));
    for (const event of data.events) {
      const entry = el('article', undefined, 'honors-audit-item');
      entry.append(el('h3', `第 ${event.version} 版 · ${actionLabels[event.action]}`),
        el('p', `${new Date(event.occurredAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n操作者：${event.actor}\n${event.note}`, 'honors-private'));
      $('#honors-audit-list').append(entry);
    }
    $('#honors-audit-status').textContent = `${data.events.length} 条记录`;
  } catch (error) { if (generation === state.generation) adminError(error, $('#honors-audit-status')); }
}
$('#honors-grant-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('[type="submit"]'); button.disabled = true;
  const fields = new FormData(form);
  const data = Object.fromEntries(['name', 'category', 'title', 'message', 'achievementDate', 'visibility', 'sourceKind', 'sourceReference', 'recipientEmail', 'bindingNote'].map(key => [key, String(fields.get(key) || '')]));
  data.confirmed = fields.get('confirmed') === 'on';
  const signature = JSON.stringify(data);
  if (state.grantSignature !== signature) { state.requestId = crypto.randomUUID(); state.grantSignature = signature; }
  data.requestId = state.requestId;
  $('#honors-grant-status').textContent = '正在保存…';
  try {
    await request('/api/admin/honors', { method: 'POST', body: JSON.stringify(data) });
    form.reset(); state.requestId = ''; state.grantSignature = '';
    setGrantOpen(false);
    $('#honors-grant-toggle').focus();
    $('#honors-grant-status').textContent = '荣誉已保存。'; await load(true);
  } catch (error) { adminError(error, $('#honors-grant-status')); }
  finally { button.disabled = false; }
});
$('#honors-action-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!state.selected) return;
  const { award, action } = state.selected; const form = event.currentTarget; const button = form.querySelector('[type="submit"]'); button.disabled = true;
  const fields = new FormData(form); const data = { action, version: award.version, note: String(fields.get('note') || '') };
  if (action === 'bind') { data.recipientEmail = fields.get('recipientEmail'); data.confirmed = fields.get('confirmed') === 'on'; }
  $('#honors-action-status').textContent = '正在保存…';
  try {
    await request(`/api/admin/honors/${encodeURIComponent(award.id)}/action`, { method: 'POST', body: JSON.stringify(data) });
    $('#honors-action-dialog').close(); state.selected = null; await load(true);
  } catch (error) { adminError(error, $('#honors-action-status')); if (error.status === 409) await load(true); }
  finally { button.disabled = false; }
});
$('#honors-login-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); button.disabled = true;
  try {
    await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: new FormData(form).get('password') }) });
    form.reset(); await load(true);
  } catch (error) { $('#honors-login-status').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#honors-logout').addEventListener('click', async () => {
  try { await request('/api/auth/logout', { method: 'POST', body: '{}' }); showLogin(); }
  catch (error) { $('#honors-admin-status').textContent = error.message; }
});
$('#honors-admin-filter').addEventListener('change', () => void load(true));
$('#honors-admin-refresh').addEventListener('click', () => void load(true));
$('#honors-admin-more').addEventListener('click', () => void load());
$('#honors-grant-toggle').addEventListener('click', () => setGrantOpen($('#honors-grant-form').hidden));
$('#honors-grant-cancel').addEventListener('click', () => { setGrantOpen(false); $('#honors-grant-toggle').focus(); });
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => document.getElementById(button.dataset.close).close()));
document.querySelectorAll('[data-search]').forEach(button => button.addEventListener('click', () => void searchAccounts(button.closest('.honors-account-picker'))));
void load(true);

// Copyright (c) 2026 OriginMind. All rights reserved.
function element(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}
export function honorDate(value) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeZone: 'Asia/Shanghai' }).format(new Date(value));
}
export function honorCard(award, personal = false) {
  const card = element('article', undefined, 'honors-card');
  card.id = award.id;
  const head = element('div', undefined, 'honors-card-top');
  const badge = element('span', award.categoryLabel, 'honors-badge');
  const image = element('img');
  image.src = '/learning/honors-trophy.svg';
  image.alt = `${award.name}的荣誉奖杯`;
  image.width = 52; image.height = 52;
  head.append(image, badge);
  card.append(head, element(personal ? 'h3' : 'h2', award.name), element('p', award.title, 'honors-title'));
  if (award.message) card.append(element('p', award.message, 'honors-message'));
  if (award.achievementDate) card.append(element('span', `事迹日期：${award.achievementDate}`, 'honors-date'));
  card.append(element('span', `授予日期：${honorDate(award.issuedAt)}`, 'honors-date'),
    element('span', `${award.confirmation} · ${award.issuedBy}`, 'honors-confirmation'));
  if (personal) {
    if (award.visibility === 'hidden') card.append(element('span', '仅本人可见', 'honors-confirmation'));
    else {
      const link = element('a', '在荣誉墙查看');
      link.href = `/learning/honors#${encodeURIComponent(award.id)}`;
      card.append(link);
    }
  }
  return card;
}
async function request(path) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(data.awards)) {
    const error = new Error(data.error || '荣誉暂时无法读取，请稍后刷新。');
    error.status = response.status;
    throw error;
  }
  return data;
}
function startWall() {
  const list = document.getElementById('honors-list');
  const status = document.getElementById('honors-status');
  const filter = document.getElementById('honors-category');
  const more = document.getElementById('honors-more');
  let generation = 0, page = 0, category = '';
  const records = new Map();
  async function load(reset = false) {
    if (reset) { generation++; page = 0; records.clear(); list.replaceChildren(); }
    const current = generation;
    more.hidden = true;
    status.textContent = '正在读取荣誉…';
    const params = new URLSearchParams({ page: String(page + 1) });
    if (category) params.set('category', category);
    try {
      const data = await request(`/api/learning/honors?${params}`);
      if (current !== generation) return;
      page = data.page;
      data.awards.forEach(award => records.set(award.id, award));
      let targetId = '';
      try { targetId = decodeURIComponent(location.hash.slice(1)); } catch { /* Ignore malformed anchors. */ }
      // Keep shared trophy links useful after the wall grows beyond one page.
      // The detail endpoint applies the same visibility checks as the wall.
      if (reset && !category && /^[a-z0-9-]{10,64}$/u.test(targetId) && !records.has(targetId)) {
        try {
          const linked = await request(`/api/learning/honors/${encodeURIComponent(targetId)}`);
          if (current !== generation) return;
          linked.awards.forEach(award => records.set(award.id, award));
        } catch { /* Hidden, withdrawn and unavailable records are not displayed. */ }
      }
      if (current !== generation) return;
      list.replaceChildren(...[...records.values()].sort((a, b) => b.issuedAt - a.issuedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(award => honorCard(award)));
      more.hidden = !data.hasMore;
      status.textContent = records.size ? `已展示 ${records.size} 份荣誉${data.hasMore ? '，可继续查看更多' : ''} · 按授予时间展示` : '当前类别暂无公开荣誉。';
      if (!records.size) list.append(element('p', '认真完成的成果，都会在这里留下记录。', 'honors-empty'));
      if (targetId) document.getElementById(targetId)?.scrollIntoView({ block: 'nearest' });
    } catch (error) {
      if (current === generation) { status.textContent = error.message; more.hidden = page === 0; }
    }
  }
  filter.addEventListener('click', event => {
    const button = event.target.closest('button[data-category]');
    if (!button || !filter.contains(button) || button.dataset.category === category) return;
    category = button.dataset.category;
    filter.querySelectorAll('button').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    void load(true);
  });
  document.getElementById('honors-refresh').addEventListener('click', () => void load(true));
  more.addEventListener('click', () => void load());
  window.addEventListener('pageshow', event => { if (event.persisted) void load(true); });
  void load(true);
}
function startPersonal(target) {
  let generation = 0;
  async function refresh() {
    const current = ++generation;
    const account = target.dataset.account;
    target.replaceChildren();
    target.append(element('h2', '我的荣誉'));
    const status = element('p', account ? '正在读取个人奖杯…' : '登录后可查看管理员授予的个人奖杯。', 'honors-status');
    target.append(status);
    if (!account) return;
    try {
      // Identity is always resolved by the server session, never a query parameter.
      const data = await request('/api/learning/my-honors');
      if (current !== generation || target.dataset.account !== account) return;
      const list = element('div', undefined, 'honors-grid');
      list.append(...data.awards.map(award => honorCard(award, true)));
      target.append(list);
      status.textContent = data.awards.length ? '每枚奖杯都记录一份经确认的成果。' : '暂未授予荣誉。';
      if (data.hasMore) status.textContent += '更多荣誉可联系管理员查看。';
    } catch (error) {
      if (current !== generation || target.dataset.account !== account) return;
      status.textContent = error.status === 401 ? '请重新登录后查看个人奖杯。' : error.message;
    }
  }
  target.addEventListener('honors-account-change', () => void refresh());
  document.querySelector('[data-view="profile"]')?.addEventListener('click', () => void refresh());
  window.addEventListener('pageshow', event => { if (event.persisted) void refresh(); });
  void refresh();
}
if (typeof document !== 'undefined') {
  if (document.getElementById('honors-list')) startWall();
  else {
    const target = document.querySelector('.personal-honors');
    if (target) startPersonal(target);
  }
}

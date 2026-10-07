// Copyright (c) 2026 OriginMind. All rights reserved.
// Read-only adapter over the deployed Chat account index and account-scoped referee history.
import { ACTIVITY_WINDOWS, activityStamp as stamp, inActivityWindow, validateActivityWindow } from '../chat-cloudflare/src/activity-windows.mjs';
const complete = run => run?.status === 'COMPLETE' && run.returned === true && run.found >= run.total && run.total > 0;
const elapsed = run => {
  const time = run?.ranked && !run.quickPractice ? run.rankTime : run?.time;
  return typeof time === 'number' && Number.isFinite(time) && time >= 0 ? time : Infinity;
};
export function compareArenaResults(a, b) {
  if (!a) return b ? 1 : 0;
  if (!b) return -1;
  return Number(complete(b)) - Number(complete(a)) ||
    b.found / Math.max(1, b.total) - a.found / Math.max(1, a.total) ||
    Number(b.returned) - Number(a.returned) || elapsed(a) - elapsed(b) || stamp(b.createdAt) - stamp(a.createdAt) || a.id.localeCompare(b.id);
}
function validate(params) {
  validateActivityWindow(params.window);
  if (Object.keys(params).some(key => !['window','sort','q','page','mapId','mode'].includes(key)) ||
      !['best','recent','tests'].includes(params.sort || 'best') || !['auto','full','quick'].includes(params.mode || 'auto') ||
      !/^[1-9]\d{0,4}$/.test(params.page || '1') || (params.q || '').length > 100 ||
      (params.mapId && !/^[A-Za-z0-9_-]{1,128}$/.test(params.mapId))) {
    throw Object.assign(new Error('竞技场筛选参数不正确。'), { status: 400 });
  }
}
function validRun(run) {
  return run && typeof run.id === 'string' && run.id.length > 0 && stamp(run.createdAt) > 0 &&
    typeof run.mapId === 'string' && run.mapId.length > 0 && typeof run.status === 'string' &&
    typeof run.quickPractice === 'boolean' && typeof run.returned === 'boolean' &&
    Number.isFinite(run.found) && Number.isFinite(run.total) && run.found >= 0 && run.total > 0 && run.found <= run.total &&
    Number.isFinite(run.time) && run.time >= 0 &&
    (!run.ranked || run.quickPractice || (Number.isFinite(run.rankTime) && run.rankTime >= 0));
}
export function summarizeArenaActivity(people, params = {}, now = Date.now()) {
  validate(params);
  const window = params.window || '24h', sort = params.sort || 'best', q = (params.q || '').trim().toLowerCase();
  const since = now - ACTIVITY_WINDOWS[window];
  const unique = new Map();
  for (const person of people) {
    const email = person.email.trim().toLowerCase(), previous = unique.get(email);
    unique.set(email, { ...person, email, lastSeen: Math.max(stamp(person.lastSeen), stamp(previous?.lastSeen)),
      runs: [...(previous?.runs || []), ...(person.runs || [])], jobs: [...(previous?.jobs || []), ...(person.jobs || [])],
      resultsError: previous?.resultsError || person.resultsError || '' });
  }
  const recent = [...unique.values()].map(person => {
    const valid = person.runs.filter(validRun);
    const runs = [...new Map(valid.map(run => [run.id, run])).values()].filter(run => inActivityWindow(run.createdAt, now - ACTIVITY_WINDOWS['7d'], now));
    const jobs = [...new Map(person.jobs.map(job => [job.id, job])).values()].filter(job => inActivityWindow(job.createdAt, now - ACTIVITY_WINDOWS['7d'], now));
    return { ...person, runs, jobs, resultsError: person.resultsError || (valid.length !== person.runs.length ? '成绩字段不完整，无法确认统计。' : ''),
      lastSeen: Math.max(inActivityWindow(person.lastSeen, 1, now) ? stamp(person.lastSeen) : 0, ...runs.map(run => stamp(run.createdAt)), ...jobs.map(job => stamp(job.createdAt))) };
  });
  const mapCounts = new Map();
  for (const person of recent) for (const run of person.runs) {
    if (!inActivityWindow(run.createdAt, since, now)) continue;
    const previous = mapCounts.get(run.mapId);
    if (!previous || stamp(run.createdAt) > previous.lastAt) mapCounts.set(run.mapId, {
      id: run.mapId, name: run.mapName || run.mapId, lastAt: stamp(run.createdAt), mode: run.quickPractice ? 'quick' : 'full',
    });
  }
  const maps = [...mapCounts.values()].sort((a, b) => b.lastAt - a.lastAt || a.id.localeCompare(b.id));
  const mapId = params.mapId || maps[0]?.id || '', map = maps.find(item => item.id === mapId);
  const mode = params.mode && params.mode !== 'auto' ? params.mode : map?.mode || 'full';
  const active = recent.filter(person => inActivityWindow(person.lastSeen, since, now));
  const rows = active.map(person => {
    const tests = person.runs.filter(run => inActivityWindow(run.createdAt, since, now) && run.mapId === mapId && run.quickPractice === (mode === 'quick'))
      .sort((a, b) => stamp(b.createdAt) - stamp(a.createdAt) || a.id.localeCompare(b.id));
    // Never present a partial page or malformed score as an exact count or best result.
    const reliable = !person.resultsError;
    return { email: person.email, displayName: person.displayName || person.email, lastSeen: person.lastSeen, resultsError: person.resultsError,
      testCount: reliable ? tests.length : null, completedCount: reliable ? tests.filter(complete).length : null,
      best: reliable ? [...tests].sort(compareArenaResults)[0] || null : null, latest: reliable ? tests[0] || null : null,
      recentResults: reliable ? tests.slice(0, 10) : [],
      pendingJobs: person.jobs.filter(job => inActivityWindow(job.createdAt, since, now) && (!mapId || job.mapId === mapId) && ['QUEUED','RUNNING','CANCELLING'].includes(job.status)).length };
  });
  const filtered = rows.filter(row => !q || [row.email, row.displayName].some(value => value.toLowerCase().includes(q)));
  filtered.sort((a, b) => (sort === 'best' ? compareArenaResults(a.best, b.best) : sort === 'tests' ? (b.testCount ?? -1) - (a.testCount ?? -1) : b.lastSeen - a.lastSeen) || b.lastSeen - a.lastSeen || a.email.localeCompare(b.email));
  const unavailable = recent.filter(row => row.resultsError).length, page = Number(params.page || '1'), offset = (page - 1) * 20;
  return { window, sort, mapId, mode, maps, asOf: now,
    source: { status: unavailable ? 'partial' : 'connected', message: unavailable ? '部分竞技场记录读取不完整；汇总暂不显示，不能视为零。' : '腾讯裁判个人测试记录' },
    summary: { onlineCounts: Object.fromEntries(Object.entries(ACTIVITY_WINDOWS).map(([key, ms]) => [key, unavailable ? null : recent.filter(row => inActivityWindow(row.lastSeen, now - ms, now)).length])),
      active: unavailable ? null : active.length, tested: unavailable ? null : rows.filter(row => row.testCount > 0).length,
      tests: unavailable ? null : rows.reduce((sum, row) => sum + row.testCount, 0), completed: unavailable ? null : rows.reduce((sum, row) => sum + row.completedCount, 0), unavailable },
    records: filtered.slice(offset, offset + 20), pagination: { page, total: filtered.length, totalPages: Math.ceil(filtered.length / 20) },
    note: '活跃人数按竞技场账户去重，依据竞技场访问、策略活动和裁判记录；不含游客及系统基准，与课程人数独立。测试次数为所选时段、地图和模式已保存的结果数，不含排队任务；完成并返回优先，再比较采集比例、返回和用时。正式成绩使用裁判保存的平均用时，快速练习单独比较。历史未记录的访问无法补计。' };
}
export function createArenaAdmin({ db, ownerFor, activity, clock = Date.now, budgetMs = 12000 }) {
  return async function overview(params = {}) {
    validate(params);
    const now = clock();
    const [accounts, online, versions, attempts] = await Promise.all([
      db.prepare(`WITH accounts AS (SELECT lower(email) email FROM visitor_accounts UNION SELECT lower(email) FROM arena_public_accounts),
        profiles AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY lower(email) ORDER BY updated_at DESC,email) rank FROM newbie_profiles)
        SELECT a.email,COALESCE(NULLIF(p.display_name,''),a.email) displayName FROM accounts a LEFT JOIN profiles p ON lower(p.email)=a.email AND p.rank=1`).all(),
      db.prepare('SELECT owner,last_seen lastSeen FROM arena_account_activity').all(),
      db.prepare('SELECT owner,MAX(created) lastAt FROM arena_policy_versions GROUP BY owner').all(),
      db.prepare('SELECT owner,MAX(created) lastAt FROM arena_policy_attempts GROUP BY owner').all(),
    ]);
    for (const result of [accounts, online, versions, attempts]) if (!Array.isArray(result.results) || result.success === false) throw new Error('ARENA_INDEX_UNAVAILABLE');
    const seen = new Map();
    for (const row of [...online.results, ...versions.results, ...attempts.results]) {
      const time = stamp(row.lastSeen ?? row.lastAt);
      if (inActivityWindow(time, 1, now)) seen.set(row.owner, Math.max(seen.get(row.owner) || 0, time));
    }
    // Include accounts without a local visit: historical referee results can establish activity.
    const candidates = accounts.results.map(row => ({ ...row, owner: ownerFor(row.email) }));
    const results = [], controller = new AbortController();
    let cursor = 0;
    const timeout = setTimeout(() => controller.abort(), budgetMs);
    async function read(owner, offset) {
      if (controller.signal.aborted) throw new Error('ARENA_READ_TIMEOUT');
      let onAbort;
      const expired = new Promise((_, reject) => { onAbort = () => reject(new Error('ARENA_READ_TIMEOUT')); controller.signal.addEventListener('abort', onAbort, { once: true }); });
      try { return await Promise.race([activity(owner, { action: 'list', offset }, { signal: controller.signal }), expired]); }
      finally { controller.signal.removeEventListener('abort', onAbort); }
    }
    async function next() {
      while (cursor < candidates.length) {
        const person = candidates[cursor++], runs = [], jobs = [];
        let resultsError = '';
        try {
          for (let offset = 0; offset < 2000; offset += 20) {
            const page = await read(person.owner, offset);
            if (!Array.isArray(page.runs) || typeof page.hasMore !== 'boolean' || !Array.isArray(page.jobs)) throw new Error('INVALID_RESULTS');
            if (page.runs.some(run => !validRun(run))) throw new Error('INVALID_RESULTS');
            runs.push(...page.runs); if (offset === 0) jobs.push(...page.jobs);
            // The deployed personal_activity.py orders history by created DESC,id DESC.
            if (!page.hasMore || page.runs.some(run => stamp(run.createdAt) < now - ACTIVITY_WINDOWS['7d'])) break;
            if (!page.runs.length || offset === 1980) throw new Error('RESULTS_INCOMPLETE');
          }
        } catch { resultsError = '成绩暂未完整读取，请刷新重试。'; }
        results.push({ email: person.email, displayName: person.displayName, lastSeen: seen.get(person.owner) || 0, runs, jobs, resultsError });
      }
    }
    try { await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, next)); }
    finally { clearTimeout(timeout); }
    return summarizeArenaActivity(results, params, now);
  };
}

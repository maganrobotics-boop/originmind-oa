// Rolling windows share one server timestamp; boundaries are inclusive.
export const ACTIVITY_WINDOWS = Object.freeze({ '24h': 86400000, '3d': 259200000, '7d': 604800000 });
export const activityStamp = value => {
  const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > 0 ? time : 0;
};
export const inActivityWindow = (value, since, now) => {
  const time = activityStamp(value);
  return time > 0 && time >= since && time <= now;
};
export function validateActivityWindow(window = '24h') {
  if (!Object.hasOwn(ACTIVITY_WINDOWS, window)) throw Object.assign(new Error('时间窗口不正确。'), { status: 400 });
  return window;
}
export function unavailableArena(params = {}, now = Date.now(), status = 'not_connected') {
  const window = validateActivityWindow(params.window);
  return { window, asOf: now, source: { status, message: status === 'not_connected' ? '数据源未接入' : '竞技场数据源暂不可用，请稍后重试。' },
    summary: { onlineCounts: { '24h': null, '3d': null, '7d': null }, active: null, tested: null, tests: null, completed: null, unavailable: null },
    records: [], maps: [], mapId: '', mode: params.mode || 'full', pagination: { page: 1, total: 0, totalPages: 0 },
    note: '尚不能确认竞技场活跃人数、测试次数或成绩。' };
}

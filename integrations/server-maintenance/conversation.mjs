import { createHash, createHmac, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const LIMIT = 32 * 1024;
const TIMEOUT = 10_000;
const TARGETS = Object.freeze({
  aliyun: { name: '阿里云', url: 'http://127.0.0.1:18893/v1/maintenance' },
  tencent: { name: '腾讯云', url: 'https://omindos.cn/_maintenance/v1' },
});
const PRIVATE_HEADERS = Object.freeze({ host: 'oa.omindos.cn', 'x-forwarded-host': 'oa.omindos.cn',
  'x-forwarded-proto': 'https', origin: 'https://oa.omindos.cn', accept: 'application/json' });
const CATEGORY_NAMES = Object.freeze({ apt_packages: '安装包缓存', maintenance_tmp: '维护临时文件', maintenance_cache: '维护缓存' });

function intent(question) {
  if (typeof question !== 'string' || question.length > 2000) return null;
  const text = question.trim();
  const scoped = /阿里(?:云)?|腾讯(?:云)?|服务器/u.test(text);
  if (!scoped || !/查询|查看|检查|查一下|空间|容量|磁盘|内存|CPU|负载|运行|状态|清理|删除|缓存|临时文件|服务|可用|剩余|多少/iu.test(text)) return null;
  const servers = /两(?:台|个)服务器|两个云|两台云|阿里[\s\S]*腾讯|腾讯[\s\S]*阿里/u.test(text)
    ? ['aliyun', 'tencent'] : /阿里/u.test(text) ? ['aliyun'] : /腾讯/u.test(text) ? ['tencent'] : ['aliyun', 'tencent'];
  const cleanup = /清理|删除|缓存|临时文件|释放.{0,6}空间/u.test(text);
  if (!cleanup) return { servers, action: 'status' };
  if (/不(?:要|用|能|可|准|必)?清理|别清理|禁止|停止|取消|不要删除|不删除|别删除/u.test(text)) return { servers, action: 'explain' };
  // A full, explicit command is required every time; history and model output are never commands.
  const clean = /^(?:请|请帮我|帮我)?清理(?:阿里(?:云)?(?:服务器)?|腾讯(?:云)?(?:服务器)?|两(?:台|个)服务器)(?:的)?(?:过期的?|安全的?)?(?:临时文件|缓存)[。！!]?$/u.test(text);
  return { servers, action: clean ? 'clean' : 'plan' };
}

async function responseJson(response) {
  if (!response || response.ok !== true || response.status < 200 || response.status >= 300) throw new Error('REQUEST_FAILED');
  if (!String(response.headers?.get('content-type') || '').toLowerCase().includes('application/json')) throw new Error('INVALID_RESPONSE');
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > LIMIT) throw new Error('RESPONSE_LIMIT');
  if (!response.body?.getReader) throw new Error('INVALID_RESPONSE');
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > LIMIT) throw new Error('RESPONSE_LIMIT');
      chunks.push(Buffer.from(chunk.value));
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const value = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_RESPONSE');
  return value;
}

function nativeSession(port, cookie, signal) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ hostname: '127.0.0.1', port, path: '/api/session', method: 'GET',
      headers: { ...PRIVATE_HEADERS, cookie }, signal, agent: false, maxHeaderSize: 16384 }, incoming => {
      if (incoming.statusCode !== 200 || !String(incoming.headers['content-type']).includes('application/json') || Number(incoming.headers['content-length']) > LIMIT) {
        incoming.destroy(); reject(new Error('SESSION_FAILED')); return;
      }
      const chunks = []; let size = 0;
      incoming.on('data', chunk => {
        size += chunk.length;
        if (size > LIMIT) { incoming.destroy(); reject(new Error('SESSION_LIMIT')); return; }
        chunks.push(chunk);
      });
      incoming.once('aborted', () => reject(new Error('SESSION_ABORTED')));
      incoming.once('error', reject);
      incoming.once('end', () => {
        if (!incoming.complete) { reject(new Error('SESSION_INCOMPLETE')); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks, size).toString('utf8'))); } catch { reject(new Error('SESSION_INVALID')); }
      });
    });
    outgoing.once('error', reject); outgoing.end();
  });
}

function nativeBackend(url, options) {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(url);
    const outgoing = (endpoint.protocol === 'https:' ? httpsRequest : httpRequest)(endpoint, {
      method: 'POST', headers: options.headers, signal: options.signal, agent: false, maxHeaderSize: 16384,
    }, incoming => {
      const code = incoming.statusCode || 502;
      if (code < 200 || code >= 300 || Number(incoming.headers['content-length']) > LIMIT) {
        incoming.destroy(); reject(new Error('BACKEND_FAILED')); return;
      }
      const chunks = []; let size = 0;
      incoming.on('data', chunk => {
        size += chunk.length;
        if (size > LIMIT) { incoming.destroy(); reject(new Error('RESPONSE_LIMIT')); return; }
        chunks.push(chunk);
      });
      incoming.once('aborted', () => reject(new Error('BACKEND_ABORTED')));
      incoming.once('error', reject);
      incoming.once('end', () => {
        if (!incoming.complete) { reject(new Error('BACKEND_INCOMPLETE')); return; }
        resolve(new Response(Buffer.concat(chunks, size), { status: code,
          headers: { 'content-type': String(incoming.headers['content-type'] || '') } }));
      });
    });
    outgoing.once('error', reject); outgoing.end(options.body);
  });
}

async function readConfig(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o027) !== 0 || info.size > LIMIT) throw new Error('CONFIG_INVALID');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.uid !== 0 || (opened.mode & 0o027) !== 0 || opened.size > LIMIT || opened.ino !== info.ino || opened.dev !== info.dev) throw new Error('CONFIG_INVALID');
    const buffer = Buffer.alloc(LIMIT + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > LIMIT) throw new Error('CONFIG_INVALID');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally { await file.close(); }
}

function number(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }
function display(value, suffix = '') { const n = number(value); return n === null ? '未提供' : `${Math.round(n * 100) / 100}${suffix}`; }
function gib(value) { const n = number(value); return n === null ? '未提供' : `${(n / 2 ** 30).toFixed(2)} GiB`; }
function cleanText(value) { return typeof value === 'string' ? value.replace(/[\r\n\u0000-\u001f\u007f]/gu, ' ').slice(0, 100) : '未提供'; }
function time(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '未提供';
  const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
  if (!Number.isFinite(date.getTime())) return '未提供';
  return `${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date)}（北京时间）`;
}
function statusAnswer(data) {
  const disk = data.disk || {}, memory = data.memory || {}, cpu = data.cpu || {};
  const load = data.load || data.loadavg || cpu.load || cpu.loadavg;
  const services = Array.isArray(data.services) ? data.services.map(s => `${cleanText(s.name || s.service)}：${cleanText(s.state || s.status || s.active)}`).join('；')
    : data.services && typeof data.services === 'object' ? Object.entries(data.services).slice(0, 20).map(([name, s]) => `${cleanText(name)}：${cleanText(typeof s === 'string' ? s : s?.state || s?.status || s?.active)}`).join('；') : '未提供';
  const cores = cpu.cores ?? cpu.count ?? data.cpuCount, percent = cpu.usedPercent ?? cpu.used_percent ?? cpu.percent;
  return `查询时间：${time(data.collectedAt || data.timestamp || data.observedAt || data.checkedAt || Date.now())}\n磁盘：总计 ${gib(disk.totalBytes ?? disk.total_bytes ?? disk.total)}，已用 ${gib(disk.usedBytes ?? disk.used_bytes ?? disk.used)}，可用 ${gib(disk.freeBytes ?? disk.free_bytes ?? disk.availableBytes ?? disk.free)}，使用率 ${display(disk.usedPercent ?? disk.used_percent ?? disk.percent, '%')}\n内存：总计 ${gib(memory.totalBytes ?? memory.total_bytes ?? memory.total)}，可用 ${gib(memory.availableBytes ?? memory.available_bytes ?? memory.available ?? memory.freeBytes)}\nCPU：${number(cores) === null ? '核数未提供' : `${display(cores)} 核`}${number(percent) === null ? '' : `，使用率 ${display(percent, '%')}`}；负载（1/5/15 分钟）：${Array.isArray(load) ? load.map(n => display(n)).join(' / ') : '未提供'}\n运行时间：${display(data.uptimeSeconds ?? data.uptime_seconds ?? data.uptime, ' 秒')}\n服务：${services || '未提供'}`;
}
function summary(data) {
  const categories = data.categories || data.summary?.categories || [];
  const items = Array.isArray(categories) ? categories : Object.entries(categories).map(([category, values]) => ({ category, ...values }));
  const detail = items.slice(0, 20).map(c => `${CATEGORY_NAMES[c.category || c.name || c.kind] || '其他限定临时文件'} ${display(c.count ?? c.fileCount)} 项 / ${gib(c.bytes ?? c.totalBytes)}`).join('；');
  return `临时文件：${display(data.candidateCount ?? data.count ?? data.fileCount ?? data.summary?.count)} 项，${gib(data.candidateBytes ?? data.bytes ?? data.totalBytes ?? data.summary?.bytes)}${detail ? `\n分类：${detail}` : ''}${data.limited ? '\n已达到本次扫描上限，以上仅包含本次候选文件。' : ''}`;
}
function cleanAnswer(data) {
  const count = data.deletedCount ?? data.deleted_count ?? data.removedCount ?? data.removed?.count ?? data.count;
  const bytes = data.deletedBytes ?? data.deleted_bytes ?? data.removedBytes ?? data.removed?.bytes ?? data.bytes;
  const before = data.diskBefore?.availableBytes ?? data.beforeFreeBytes ?? data.before_free_bytes ?? data.before?.freeBytes ?? data.before?.disk?.freeBytes;
  const after = data.diskAfter?.availableBytes ?? data.afterFreeBytes ?? data.after_free_bytes ?? data.after?.freeBytes ?? data.after?.disk?.freeBytes;
  if (data.ok !== true || data.error || [count, bytes, before, after].some(n => number(n) === null)) throw new Error('CLEAN_FAILED');
  return `已完成限定临时文件清理：实际删除 ${display(count)} 项，${gib(bytes)}${number(data.skippedCount) !== null ? `，跳过 ${display(data.skippedCount)} 项` : ''}。\n可用空间：${gib(before)} → ${gib(after)}`;
}

export function createServerMaintenanceConversation({ port, configPath = '/etc/originmind-maintenance/oa-client.json', config, sessionFetch, backendFetch = nativeBackend } = {}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid OA port');
  const actors = new Map();
  return async (request, question, { signal } = {}) => {
    const command = intent(question);
    if (!command) return null;
    const reply = answer => ({ answer, mode: 'server_maintenance' });
    const cookie = request.headers.get('cookie');
    if (!cookie || cookie.length > 16384) return reply('服务器查询和临时文件清理仅向已登录的 OA 管理员开放，请先登录管理员账号。');
    const combined = () => AbortSignal.any([AbortSignal.timeout(TIMEOUT), ...(signal ? [signal] : [])]);
    let session;
    try {
      session = sessionFetch ? await responseJson(await sessionFetch(`http://127.0.0.1:${port}/api/session`, {
        method: 'GET', headers: { ...PRIVATE_HEADERS, cookie }, redirect: 'error', signal: combined(),
      })) : await nativeSession(port, cookie, combined());
    } catch { return reply('管理员会话验证失败，未查询或清理服务器，请重新登录后重试。'); }
    if (session?.registered !== true || session.status !== 'active' || session.ndaCompleted !== true || session.isAdmin !== true ||
      typeof session.user?.email !== 'string' || !session.user.email.trim() || session.user.email.length > 320) {
      return reply('服务器查询和临时文件清理仅向已完成准入的 OA 管理员开放。当前账号没有此权限。');
    }
    if (command.action === 'explain') return reply('未执行清理。可发送“查询两个服务器状态”或“预览两个服务器临时文件清理”。');
    const actor = createHash('sha256').update(session.user.email.trim().toLowerCase()).digest('hex');
    const now = Date.now();
    for (const [key, state] of actors) if (!state.inflight && now - state.windowStart >= 60_000) actors.delete(key);
    let state = actors.get(actor);
    if (!state) {
      if (actors.size >= 512) return reply('服务器维护当前繁忙，请稍后重试。未执行查询或清理。');
      state = { windowStart: now, count: 0, cleanCount: 0, inflight: false }; actors.set(actor, state);
    }
    if (state.inflight) return reply('您已有一项服务器维护正在处理，请等待回执后再操作。未重复执行。');
    if (state.count >= 10 || (command.action === 'clean' && state.cleanCount >= 2)) return reply('服务器维护请求过于频繁，请一分钟后重试。未执行本次查询或清理。');
    state.count += 1;
    if (command.action === 'clean') state.cleanCount += 1;
    state.inflight = true;
    try {
    let settings;
    try { settings = config ?? await readConfig(configPath); }
    catch { return reply('服务器维护连接尚未配置或配置不可读取，未执行查询或清理。'); }
    const results = await Promise.all(command.servers.map(async id => {
      const target = TARGETS[id], connection = settings?.servers?.[id];
      try {
        if (!connection || connection.url !== target.url || typeof connection.secret !== 'string' || connection.secret.length < 32 || connection.secret.length > 4096) throw new Error('CONFIG_INVALID');
        const call = async (action, planId) => {
          const body = JSON.stringify({ action, actor, ...(planId ? { planId } : {}) });
          const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(24).toString('hex');
          const signature = createHmac('sha256', connection.secret).update(`${timestamp}\n${nonce}\n${body}`).digest('hex');
          const response = await backendFetch(target.url, { method: 'POST', redirect: 'error', signal: combined(),
            headers: { 'content-type': 'application/json', accept: 'application/json', 'x-maintenance-time': timestamp,
              'x-maintenance-nonce': nonce, authorization: `Maintenance-HMAC ${signature}` }, body });
          const data = await responseJson(response);
          if (data.ok !== true || data.error || data.server !== id || data.action !== action) throw new Error('BACKEND_FAILED');
          return data;
        };
        if (command.action === 'status') return `${target.name}\n${statusAnswer(await call('status'))}`;
        const plan = await call('plan');
        if (command.action === 'plan') return `${target.name}：清理预览（尚未删除）\n${summary(plan)}`;
        const planId = plan.planId ?? plan.plan_id;
        if (typeof planId !== 'string' || !/^[a-f0-9]{64}$/u.test(planId)) throw new Error('INVALID_PLAN');
        return `${target.name}\n${cleanAnswer(await call('clean', planId))}`;
      } catch (error) {
        return `${target.name}：${error?.message === 'CONFIG_INVALID' ? '维护连接配置无效' : '维护查询或操作未确认完成'}，当前不可用。未取得成功回执，请稍后重查。`;
      }
    }));
    return reply(results.join('\n\n'));
    } finally { state.inflight = false; }
  };
}

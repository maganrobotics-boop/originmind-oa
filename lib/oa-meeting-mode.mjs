const PHASES = new Set(['draft', 'waiting_to_join', 'in_meeting', 'generating_minutes', 'pending_confirmation', 'archived']);
const MARKER_TYPES = new Set(['decision', 'task', 'risk', 'highlight']);
const EXIT_STATUSES = new Set(['not_requested', 'uncertain', 'confirmed']);
const SESSION_KEYS = new Set(['version', 'phase', 'title', 'meeting', 'meetingId', 'participants', 'agenda', 'startedAt', 'endedAt', 'exitStatus', 'minutesTaskId', 'transcript', 'markers', 'observedParticipants']);
const clean = (value, maximum) => typeof value === 'string' && value.isWellFormed()
  ? value.trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').slice(0, maximum)
  : '';

export const MEETING_MARKER_LABELS = Object.freeze({
  decision: '决策', task: '待办', risk: '风险', highlight: '重要内容',
});

/** Only an exact leading command switches modes; quoted or embedded text stays ordinary chat. */
export function resolveMeetingModeCommand(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  const start = /^[@＠]会议模式[\s:：,，、]*([0-9]{9})$/u.exec(normalized);
  if (start) return { action: 'start', meeting: start[1] };
  if (/^[@＠]结束会议$/u.test(normalized)) return { action: 'end' };
  if (/^(?:[@＠])?生成会议纪要$/u.test(normalized)) return { action: 'minutes' };
  return null;
}

export function meetingModeStorageKey(email) {
  const identity = clean(email, 320).toLowerCase();
  return identity ? `oa:meeting-mode:v1:${identity}` : 'oa:meeting-mode:v1:anonymous';
}

export function extractFeishuDocumentLinks(transcript) {
  if (!Array.isArray(transcript)) return [];
  const links = new Map();
  for (const item of transcript) {
    if (!item || typeof item.text !== 'string') continue;
    for (const match of item.text.matchAll(/https:\/\/[^\s<>()\]，。！？、]+/gu)) {
      try {
        const url = new URL(match[0]);
        const host = url.hostname.toLowerCase();
        if (!(host === 'feishu.cn' || host.endsWith('.feishu.cn'))) continue;
        if (!/^\/(?:docx?|docs|sheets|wiki|base|mindnotes)\//u.test(url.pathname)) continue;
        url.hash = '';
        const href = url.toString();
        if (!links.has(href)) links.set(href, { href, label: clean(item.text.replace(match[0], ''), 80) || '飞书会议共享文档' });
        if (links.size >= 20) return [...links.values()];
      } catch { /* Ignore malformed or unsupported URLs. */ }
    }
  }
  return [...links.values()];
}

export function isMeetingModeSession(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || !PHASES.has(value.phase)) return false;
  if (Object.keys(value).some(key => !SESSION_KEYS.has(key)) || [...SESSION_KEYS].some(key => !Object.hasOwn(value, key))) return false;
  if (typeof value.title !== 'string' || value.title.length > 100 || typeof value.meeting !== 'string' || value.meeting.length > 512) return false;
  if (typeof value.participants !== 'string' || value.participants.length > 2000 || typeof value.agenda !== 'string' || value.agenda.length > 4000) return false;
  if (value.meetingId !== null && (typeof value.meetingId !== 'string' || !/^\d{10,32}$/u.test(value.meetingId))) return false;
  if (value.startedAt !== null && (typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt)))) return false;
  if (value.endedAt !== null && (typeof value.endedAt !== 'string' || !Number.isFinite(Date.parse(value.endedAt)))) return false;
  if (!EXIT_STATUSES.has(value.exitStatus)) return false;
  if (value.minutesTaskId !== null && (typeof value.minutesTaskId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(value.minutesTaskId))) return false;
  if (!Array.isArray(value.transcript) || value.transcript.length > 2000 || !Array.isArray(value.markers) || value.markers.length > 500 || !Array.isArray(value.observedParticipants) || value.observedParticipants.length > 500) return false;
  if (!value.transcript.every(item => item && typeof item.id === 'string' && item.id.length <= 256 && typeof item.speaker === 'string' && item.speaker.length <= 200 && typeof item.text === 'string' && item.text.length <= 4000 && typeof item.time === 'string' && item.time.length <= 64)) return false;
  if (!value.markers.every(item => item && typeof item.id === 'string' && item.id.length <= 128 && MARKER_TYPES.has(item.type) && typeof item.text === 'string' && item.text.length <= 2000 && typeof item.createdAt === 'string' && item.createdAt.length <= 64)) return false;
  return value.observedParticipants.every(item => typeof item === 'string' && item.length <= 200);
}

const displayTime = value => {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return '时间待补充';
  return new Date(milliseconds).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/u, 'Z');
};

export function buildMeetingMinutesMaterial(session) {
  if (!isMeetingModeSession(session)) throw new Error('MEETING_SESSION_INVALID');
  const title = clean(session.title, 100) || '未命名会议';
  const declared = clean(session.participants, 2000);
  const observed = [...new Set(session.observedParticipants.map(item => clean(item, 200)).filter(Boolean))];
  const lines = [
    '# 会议信息',
    `- 会议标题：${title}`,
    `- 飞书会议：${clean(session.meeting, 512) || '待补充'}`,
    `- 开始时间：${session.startedAt ? displayTime(session.startedAt) : '待补充'}`,
    `- 结束时间：${session.endedAt ? displayTime(session.endedAt) : '待补充'}`,
    `- 会前填写参会人：${declared || '待补充'}`,
    `- 会中识别参会人：${observed.join('、') || '未取得参会事件'}`,
    '', '# 议程', clean(session.agenda, 4000) || '待补充',
    '', '# 实时转写',
  ];
  if (session.transcript.length) {
    for (const item of session.transcript) lines.push(`- [${displayTime(item.time)}] ${clean(item.speaker, 200) || '未知发言人'}：${clean(item.text, 4000) || '（空转写）'}`);
  } else lines.push('- 未取得转写；请依据人工标记整理，缺失内容标注“待补充”。');
  lines.push('', '# 会中标记');
  for (const type of MARKER_TYPES) {
    const items = session.markers.filter(item => item.type === type);
    lines.push('', `## ${MEETING_MARKER_LABELS[type]}`);
    if (!items.length) lines.push('- 无');
    else for (const item of items) lines.push(`- [${displayTime(item.createdAt)}] ${clean(item.text, 2000)}`);
  }
  const material = lines.join('\n');
  if (material.length > 20000) throw new Error('MEETING_MATERIAL_TOO_LARGE');
  return material;
}

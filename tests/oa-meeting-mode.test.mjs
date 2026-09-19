import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMeetingMinutesMaterial, extractFeishuDocumentLinks, isMeetingModeSession, meetingModeStorageKey, resolveMeetingModeCommand } from '../lib/oa-meeting-mode.mjs';

const session = {
  version: 1, phase: 'in_meeting', title: '机器人项目周会', meeting: '123456789', meetingId: '7512345678901234567',
  participants: '张三、李四', agenda: '确认联调计划', startedAt: '2026-09-19T01:00:00.000Z', endedAt: '2026-09-19T02:00:00.000Z', exitStatus: 'confirmed', minutesTaskId: null,
  observedParticipants: ['张三', '李四'],
  transcript: [{ id: 'event:0', speaker: '张三', text: '下周完成联调。', time: '2026-09-19T01:01:00.000Z' }],
  markers: [{ id: 'marker:0', type: 'task', text: '李四周五前提交测试记录', createdAt: '2026-09-19T01:02:00.000Z' }],
};

for (const prefix of ['@', '＠']) test(`${prefix}会议模式 starts from a nine-digit meeting number`, () => {
  assert.deepEqual(resolveMeetingModeCommand(`${prefix}会议模式919700881`), { action: 'start', meeting: '919700881' });
  assert.deepEqual(resolveMeetingModeCommand(`${prefix}会议模式 919700881`), { action: 'start', meeting: '919700881' });
  assert.deepEqual(resolveMeetingModeCommand(`${prefix}结束会议`), { action: 'end' });
  assert.deepEqual(resolveMeetingModeCommand('生成会议纪要'), { action: 'minutes' });
});
for (const value of ['解释 @会议模式', '"@会议模式919700881"', '@会议模式', '@会议模式ABC', '@会议模式12345678', '@会议模式1234567890', '@结束会议 现在', null, 42]) test(`embedded or malformed command stays ordinary: ${String(value)}`, () => assert.equal(resolveMeetingModeCommand(value), null));
test('meeting session validation is strict and never accepts a stored password', () => {
  assert.equal(isMeetingModeSession(session), true);
  assert.equal(isMeetingModeSession({ ...session, password: 'secret' }), false);
  assert.equal(isMeetingModeSession({ ...session, meetingId: 7512345678901234567 }), false);
  assert.equal(isMeetingModeSession({ ...session, exitStatus: 'probably' }), false);
  assert.equal(isMeetingModeSession({ ...session, minutesTaskId: '../../other-task' }), false);
  assert.equal(isMeetingModeSession({ ...session, transcript: [{ ...session.transcript[0], text: 'a'.repeat(4001) }] }), false);
});
test('minutes material preserves transcript, agenda and explicit markers', () => {
  const material = buildMeetingMinutesMaterial(session);
  assert.match(material, /机器人项目周会/u); assert.match(material, /确认联调计划/u);
  assert.match(material, /张三：下周完成联调/u); assert.match(material, /## 待办/u); assert.match(material, /李四周五前提交测试记录/u);
  assert.match(material, /## 决策[\s\S]*- 无/u);
});
test('minutes material is rejected rather than silently truncated', () => {
  const oversized = { ...session, transcript: Array.from({ length: 6 }, (_, index) => ({ id: `e${index}`, speaker: '张三', text: '长'.repeat(3900), time: session.startedAt })) };
  assert.throws(() => buildMeetingMinutesMaterial(oversized), /MEETING_MATERIAL_TOO_LARGE/u);
});
test('meeting storage is scoped to the signed-in OA identity', () => {
  assert.equal(meetingModeStorageKey('ADMIN@EXAMPLE.COM'), 'oa:meeting-mode:v1:admin@example.com');
});
test('only supported Feishu document links are exposed by the meeting cockpit', () => {
  const links = extractFeishuDocumentLinks([
    { text: '请看方案 https://originmind.feishu.cn/docx/abc123 ，继续讨论' },
    { text: '表格 https://originmind.feishu.cn/sheets/sht123' },
    { text: '伪造 https://originmind.feishu.cn.evil.test/docx/nope' },
    { text: '普通网页 https://originmind.feishu.cn/help/index' },
  ]);
  assert.equal(links.length, 2);
  assert.equal(links[0].href, 'https://originmind.feishu.cn/docx/abc123');
  assert.match(links[0].label, /请看方案/u);
});

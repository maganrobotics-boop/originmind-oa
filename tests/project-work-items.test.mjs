import assert from 'node:assert/strict';
import test from 'node:test';
import { extractMeetingActions } from '../lib/project-work-items.ts';

test('meeting actions are extracted only from the action section and deduplicated', () => {
  const result = extractMeetingActions(`# 会议纪要
## 讨论要点
- 已完成联调
## 行动项
- 马淦在周五前完成底盘测试
2. 李工整理 BOM
- 马淦在周五前完成底盘测试
## 风险与未决问题
- 供应商尚未确认`);
  assert.deepEqual(result, ['马淦在周五前完成底盘测试', '李工整理 BOM']);
});

test('empty placeholders never become work items', () => {
  assert.deepEqual(extractMeetingActions('## 行动项\n- 暂无\n- 待补充\n## 结论\n完成'), []);
});

test('legacy meeting headings are supported', () => {
  assert.deepEqual(extractMeetingActions(`**待办事项**
* 完成机器人底盘联调
* 整理项目甘特图
**会议结论**
* 本周继续推进`), ['完成机器人底盘联调', '整理项目甘特图']);
  assert.deepEqual(extractMeetingActions('### 后续安排：\n1、确认传感器清单\n2. 更新周会材料'), ['确认传感器清单', '更新周会材料']);
});

/** Browser-side planning only. The existing authenticated task API remains authoritative. */
import { TASK_LIMITS, validTaskInput } from './ai-workbench-core.mjs';

export const CHAT_DOCUMENT_MAX_BYTES = 90000;
export const CHAT_DOCUMENT_HINTS = Object.freeze([
  { label: '整理资料 · 生成 Word', prompt: '请把材料整理成结构清晰的 Word 文档，保留关键事实。' },
  { label: '会议纪要 · 提取待办', prompt: '请整理成会议纪要，区分讨论、决定和待办，未明确的信息标注待补充。' },
  { label: '项目周报 · 编写方案', prompt: '请整理成项目周报，列出已完成、存在问题和下一步计划。' },
  { label: '实验室知识问答', prompt: '实验室有哪些研究方向？' },
]);
const UUID = /^[a-f0-9-]{36}$/u;
const STATES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled']);

export function wantsChatDocument(instruction) {
  // Mentioning Word, a report or a plan alone is not authorization to create a task.
  return typeof instruction === 'string' && (
    /(?:整理成|生成|制作|导出|写一份|编写|起草|改成|转成|输出|做成|写成|形成).{0,36}(?:文档|文件|报告|周报|纪要|方案|word|docx|markdown)/iu.test(instruction)
    || /(?:文档|报告|周报|纪要|方案).{0,12}(?:整理一下|整理下|润色|改写|精简)/u.test(instruction)
    || /\b(?:create|generate|export|draft|write)\b.{0,36}\b(?:word|docx|markdown|document|report|minutes|plan)\b/iu.test(instruction)
  );
}

export async function readChatDocument(file) {
  if (!file || typeof file.name !== 'string' || !/\.(txt|md|markdown)$/iu.test(file.name)) throw new Error('只支持 TXT 和 MD（Markdown）文档。');
  if (!Number.isFinite(file.size) || file.size > CHAT_DOCUMENT_MAX_BYTES) throw new Error('文档不能超过 90 KB；请拆分后导入，内容不会被自动截断。');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
  catch { throw new Error('无法读取文档，请使用 UTF-8 编码的 TXT 或 MD 文件。'); }
  const sample = { kind: 'document', title: '导入材料', instruction: '整理材料', material: text };
  if (!validTaskInput(sample)) throw new Error('文档须包含 2–20,000 字有效文字，不能含二进制控制字符；内容不会被截断。');
  return { name: file.name, text };
}

export function planChatDocument(instruction, source, previousAnswer = '') {
  const normalized = typeof instruction === 'string' ? instruction.trim() : '';
  const material = source?.text || previousAnswer || `未提供原始资料；以下仅为用户的写作要求，事实、日期、数据和负责人缺失时须标注“待补充”，不得编造。\n\n${normalized}`;
  const title = (source?.name ? source.name.replace(/\.(txt|md|markdown|docx)$/iu, '') : normalized.split(/[\r\n。！？]/u)[0]).replace(/[\r\n\t\/\\:*?"<>|]/gu, '_').slice(0, 100).trim() || '整理文档';
  const kind = /会议纪要|meeting\s+minutes/iu.test(normalized) ? 'meeting_minutes'
    : /周报|weekly\s+report/iu.test(normalized) ? 'weekly_report'
    : /项目方案|项目计划|project\s+plan/iu.test(normalized) ? 'project_plan' : 'document';
  const plan = { kind, title, instruction: normalized, material };
  if (!validTaskInput(plan)) throw new Error(`任务要求须为 2–${TASK_LIMITS.instruction} 字，材料须为 2–20,000 字。请缩短或拆分材料后再提交。`);
  return plan;
}

export function isChatDocumentTask(value) {
  return Boolean(value && typeof value === 'object' && typeof value.id === 'string' && UUID.test(value.id)
    && typeof value.title === 'string' && value.title.length > 0 && value.title.length <= 100
    && STATES.has(value.status) && Number.isFinite(value.attempts) && Number.isFinite(value.updated_at)
    && (value.result === undefined || typeof value.result === 'string'));
}

export function newerChatDocumentTask(current, incoming) {
  if (!isChatDocumentTask(incoming)) return current;
  if (!current) return incoming;
  if (incoming.id !== current.id || incoming.updated_at < current.updated_at) return current;
  // A late run/poll reply must never resurrect a cancelled task or undo success.
  if (['succeeded', 'cancelled'].includes(current.status) && incoming.status !== current.status) return current;
  if (incoming.attempts < current.attempts) return current;
  return incoming;
}

export function chatDocumentFailure(code) {
  if (code === 'TASK_ACCESS_CHANGED') return '准入或访问权限已变化，没有保存迟到的结果。';
  if (code === 'TASK_INTERRUPTED') return '执行连接中断，尚未取得完整成果；不会自动重复执行。';
  if (code === 'TASK_ARTIFACT_FAILED') return '文档制作或校验未通过，没有交付不完整文件。';
  if (code === 'TASK_SAVE_FAILED') return '文档保存未完成，不能标记为成功，请核对状态后重试。';
  return '模型未返回完整可用正文，尚未生成文档。可以手动重试。';
}

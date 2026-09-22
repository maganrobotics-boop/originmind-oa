const COMPLEX_TASK = /(?:项目总结|总结.{0,8}(?:项目|文档|报告)|长文档|完整报告|方案设计|设计.{0,12}(?:方案|项目)|深度分析|系统分析|技术路线|可行性分析|对比评估|综合评估|撰写.{0,8}(?:报告|方案|文档))/iu;
const SHORT_REQUEST = /(?:简短|简要|一句话|精简|不超过\s*\d+\s*字)/iu;

export function answerMode(question) { return COMPLEX_TASK.test(String(question || '')) ? 'deep' : 'fast'; }
export function answerLengthInstruction(question) {
  if (SHORT_REQUEST.test(String(question || ''))) return '用户要求简短：直接给结论，通常控制在 150–250 个中文字。';
  if (answerMode(question) === 'deep') return '这是复杂任务：优先完整性，通常控制在 1000–1300 个中文字；除非用户明确要求更长，不超过 1300 个中文字。';
  return '默认回答要更充分，平均约 1000 个中文字；简单事实问题可控制在 500–800 字，技术、成果、合作边界、课程体系、项目介绍等问题使用 900–1200 字；除非用户明确要求更长，不超过 1200 个中文字。';
}
export function answerStructureInstruction() { return '先给结论；需要展开时按“说明 / 依据 / 下一步”组织。不要为了套格式而重复或添加空洞段落。'; }

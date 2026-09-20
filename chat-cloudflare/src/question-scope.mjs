const INTERNAL_QUESTION_PATTERN = /(?:我们|我司|本公司|公司内部|内部|本项目|项目|OriginMind|ARTS\s*Robotics|OA|团队|实验室|成员|员工|负责人|客户|供应商|合同|报价|预算|订单|交付|进度|排期|会议|纪要|审批|制度|流程|权限|账号|资料|文档|文件|数据|实验|测试|样机|设备|机器人|机械臂|底盘|代码|仓库|BOM|图纸|故障|复位|参数|配置|部署|服务器|密钥|密码)/iu;
const CLEAR_GENERAL_KNOWLEDGE_PATTERN = /(?:天气|气温|温度|降雨|下雨|台风|空气质量|几点|星期几|今天几号|日期|时区|汇率|换算|翻译|计算|沸点|熔点|首都|人口|面积|元素符号|化学式|weather|temperature|forecast|rain|time\s+is\s+it|time\s+in|date|time\s*zone|exchange\s+rate|convert|translate|calculate|boiling\s+point|melting\s+point|capital\s+of|population\s+of|area\s+of)/iu;

/** Conservative boundary: organization-specific and operational questions must
 * be grounded. Only clearly ordinary questions may use model general knowledge. */
export function questionRequiresKnowledgeEvidence(question) {
  return INTERNAL_QUESTION_PATTERN.test(String(question || '').normalize('NFKC'));
}

export function questionAllowsGeneralKnowledge(question) {
  const normalized = String(question || '').normalize('NFKC').trim();
  if (questionRequiresKnowledgeEvidence(normalized)) return false;
  return /\p{Script=Han}.*\p{Script=Han}/u.test(normalized)
    || /\b(?:what|why|how|when|where|who|which|explain|define|calculate|compare|is|are|can|does|do)\b/iu.test(normalized);
}

/** When retrieval produced candidates, bypass them only for unmistakably
 * ordinary questions. This prevents weak semantic matches (for example a
 * campus document for a weather question) from overriding common knowledge,
 * without taking real knowledge-base questions away from grounded answering. */
export function questionPrefersGeneralKnowledge(question) {
  const normalized = String(question || '').normalize('NFKC').trim();
  return questionAllowsGeneralKnowledge(normalized)
    && CLEAR_GENERAL_KNOWLEDGE_PATTERN.test(normalized);
}

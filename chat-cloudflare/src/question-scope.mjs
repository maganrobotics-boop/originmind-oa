const INTERNAL_QUESTION_PATTERN = /(?:我们|我司|本公司|公司内部|内部|本项目|项目|OriginMind|ARTS\s*Robotics|OA|团队|实验室|成员|员工|负责人|客户|供应商|合同|报价|预算|订单|交付|进度|排期|会议|纪要|审批|制度|流程|权限|账号|资料|文档|文件|数据|实验|测试|样机|设备|机器人|机械臂|底盘|代码|仓库|BOM|图纸|故障|复位|参数|配置|部署|服务器|密钥|密码)/iu;

/** Conservative boundary: organization-specific and operational questions must
 * be grounded. Only clearly ordinary questions may use model general knowledge. */
export function questionRequiresKnowledgeEvidence(question) {
  return INTERNAL_QUESTION_PATTERN.test(String(question || '').normalize('NFKC'));
}

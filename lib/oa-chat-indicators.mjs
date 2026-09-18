// UI evidence only: a health probe is not proof that a question was answered.
const labels = ['网络连接', 'OA 成员身份', '模型调用', '知识检索', '回答生成'];
const unknown = detail => ['unknown', detail];
const ready = detail => ['ready', detail];
const unavailable = detail => ['unavailable', detail];
const warning = detail => ['warning', detail];
function snapshot(source, summary, entries) {
  return { source, summary, checkedAt: Date.now(), items: entries.map(([state, detail], index) => ({ label: labels[index], state, detail })) };
}
export function initialChatIndicators() {
  return snapshot('probe', '尚未检查服务；尚未提问', labels.map(() => unknown('尚未检查')));
}
function flag(value, success, failure) {
  return value === true ? ready(success) : value === false ? unavailable(failure) : unknown('服务未返回该项状态');
}
export function probeChatIndicators(status, payload) {
  const value = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  if (status !== 200) {
    return snapshot('probe', status === 401 || status === 403 ? 'OA 身份或准入校验未通过' : '服务检查暂未完成', [
      status ? ready('已收到 OA 的 HTTP 响应') : warning('未收到检查响应，不能确定是网络还是服务故障'),
      status === 401 || status === 403 ? unavailable('请检查登录、成员准入和保密协议状态') : unknown('本次检查未确认身份；不能判定为掉线'),
      unknown('尚未确认模型状态'), unknown('尚未确认检索状态'), unknown('尚未执行本次提问'),
    ]);
  }
  const model = value.bridgeReady === false || value.budgetReady === false ? false : value.modelReady;
  return snapshot('probe', '服务检查结果（不代表回答已生成）', [
    ready('已收到 OA 的 HTTP 响应'), flag(value.authorized, 'OA 准入校验通过', 'OA 准入校验未通过'),
    flag(model, '探测可用；尚未确认本次模型调用', '模型、桥接或调用额度暂不可用'),
    value.retrievalReady === true && value.knowledgeReady === false ? warning('检索服务可用，但没有可用的已审核资料') : flag(value.retrievalReady, '检索服务可用；尚未执行本次问题检索', '知识检索服务暂不可用'),
    unknown('尚未执行本次提问；不会因健康检查成功而变绿'),
  ]);
}
export function pendingChatIndicators() {
  return snapshot('question', '正在等待本次提问结果', [unknown('等待本次 HTTP 响应'), unknown('等待本次身份校验结果'), ['pending', '等待本次调用结果'], ['pending', '等待本次检索结果'], ['pending', '尚未收到完整回答']]);
}
export function replyChatIndicators(payload) {
  const value = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const received = [ready('已收到本次提问响应'), ready('本次提问通过 OA 身份校验')];
  if (value.mode === 'ai' && typeof value.answer === 'string' && value.answer.trim()) {
    return snapshot('question', '本次提问：检索成功，回答生成成功', [...received, ready('本次模型调用成功'), ready('本次知识检索成功'), ready('已收到完整 AI 回答')]);
  }
  if (value.mode === 'no_evidence' || value.fallbackReason === 'no_documents') {
    return snapshot('question', '本次提问：检索完成，未找到足够资料', [...received, unknown('没有足够资料，本次未调用模型'), warning('本次检索完成，未找到足够依据'), unknown('显示无资料提示，不是 AI 生成的回答')]);
  }
  if (value.mode === 'retrieval') {
    const reason = value.fallbackReason;
    const detail = reason === 'answer_validation_failed' ? '模型输出未通过校验' : reason === 'generation_failed' ? '本次模型未能生成回答' : '本次未能取得可用模型回答';
    return snapshot('question', '本次提问：检索成功，回答生成失败', [...received, unavailable(detail), ready('本次已检索到相关资料'), unavailable('当前是降级提示或资料摘录，不是完整 AI 回答；可以重试')]);
  }
  return snapshot('question', '本次提问：接口未确认生成结果', [...received, unknown('接口未返回可识别的模型结果'), unknown('接口未明确本次检索结果'), warning('不能仅凭 HTTP 200 或非空正文判定生成成功')]);
}
export function failedChatIndicators(status = null, stopped = false) {
  return snapshot('question', stopped ? '本次提问已停止；后端结果未知' : '本次提问未完成，可以重试', [
    status ? ready('已收到本次 HTTP 响应') : stopped ? unknown('已停止等待响应') : warning('未收到有效响应；网络、超时或服务异常尚未区分'),
    status === 401 || status === 403 ? unavailable('本次 OA 身份或准入校验未通过') : unknown('没有证据表明身份校验失败'),
    unknown('本次模型结果未知'), unknown('本次检索结果未知'),
    stopped ? unknown('停止等待不代表后端已停止生成') : unavailable('本次没有收到有效的完整回答'),
  ]);
}

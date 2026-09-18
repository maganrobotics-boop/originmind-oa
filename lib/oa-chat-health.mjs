// Five independent observations, not five copies of configuration readiness.
export function replyOutcome(reply, at = Date.now()) {
  if (reply.mode === 'no_evidence') return { state: 'no_evidence', at, received: true, httpStatus: 200 };
  if (reply.mode === 'retrieval' || reply.fallbackReason) return { state: 'degraded', at, received: true, httpStatus: 200 };
  return { state: 'answered', at, received: true, httpStatus: 200 };
}
export function chatHealthLights(snapshot, outcome) {
  const labels = ['网络连接', 'OA 成员身份', '共享模型服务', '知识检索', '本次回答'];
  const lights = labels.map(label => ({ label, state: 'unknown', detail: '尚未检查' }));
  const set = (index, state, detail) => { lights[index] = { label: labels[index], state, detail }; };
  const bool = (index, value, yes, no) => {
    if (typeof value === 'boolean') set(index, value ? 'ready' : 'unavailable', value ? yes : no);
  };
  if (snapshot.kind === 'network') set(0, 'unavailable', '状态请求未完成；未据此判断其他服务');
  if (snapshot.kind === 'http' || snapshot.kind === 'invalid') {
    set(0, 'ready', '已收到 OA 响应');
    if ([401, 403].includes(snapshot.httpStatus)) set(1, 'unavailable', '请检查登录或 OA 准入状态');
    else set(1, 'unknown', snapshot.httpStatus === 429 ? '状态查询限流，不等于身份失效' : '本次未取得有效状态，不能判断身份或模型');
  }
  if (snapshot.kind === 'ready') {
    const data = snapshot.data || {};
    set(0, 'ready', 'OA 状态接口可达');
    bool(1, data.authorized, 'OA 准入已通过', 'OA 身份未通过');
    if (data.bridgeReady === false) set(2, 'unavailable', 'OA 到模型服务的连接检查未通过');
    else if (data.budgetReady === false) set(2, 'unavailable', '模型调用额度暂不可用；不影响知识检索的独立判断');
    else bool(2, data.modelReady, '模型状态检查通过；本次回答结果见第五项', '模型状态检查未通过');
    if (data.retrievalReady === false) set(3, 'unavailable', '知识读取未完成');
    else if (data.knowledgeReady === false) set(3, 'attention', '当前没有可检索的已审核资料');
    else bool(3, data.retrievalReady, '知识检索服务可用', '知识检索服务不可用');
  }
  set(4, 'unknown', '尚未提问');
  const latest = (outcome.at || 0) >= (snapshot.at || 0);
  if (latest && outcome.state !== 'idle') {
    if (outcome.received === true) set(0, 'ready', '已收到本次问答响应');
    if ([401, 403].includes(outcome.httpStatus)) set(1, 'unavailable', '本次请求未通过身份或准入检查');
    if (['answered', 'degraded', 'no_evidence'].includes(outcome.state)) set(1, 'ready', '本次问答已通过 OA 准入');
    if (outcome.state === 'answered') {
      set(2, 'ready', '本次模型回答已返回'); set(3, 'ready', '本次资料检索已完成');
    } else if (outcome.state === 'degraded') {
      set(2, 'unavailable', '资料已检索，但模型未生成完整回答'); set(3, 'ready', '本次已检索到相关资料');
    } else if (outcome.state === 'no_evidence') set(3, 'attention', '本题未检索到足够资料，不是网络故障');
  }
  const answers = {
    asking: ['attention', '正在检索并生成回答'], answered: ['ready', '本次已返回完整回答'],
    degraded: ['unavailable', '本次未生成完整回答，可重新回答'], no_evidence: ['attention', '本题资料不足，可补充或修改问题'],
    failed: ['unavailable', '本次请求失败，不能据此断言模型或身份失效'], stopped: ['attention', '已停止等待，不作为模型故障'],
  };
  if (answers[outcome.state]) set(4, ...answers[outcome.state]);
  return lights;
}

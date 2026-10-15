import { randomBytes } from 'node:crypto';
import { validServerToolCall } from './tool-policy.mjs';
import { executeAssistantOperation, operationSummary } from './operation-runner.mjs';
import { serviceAuthority } from './operation-policy.mjs';

const SERVERS = ['aliyun', 'tencent'];
const NAMES = { aliyun: '阿里云', tencent: '腾讯云',web:'联网检索',interface:'页面' };
const TTL = 30 * 60_000;
const MAX_CONTEXT = 72 * 1024;
const readable = value => typeof value === 'string' && value.isWellFormed() && value.length <= 12000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
const bytes = value => Buffer.byteLength(JSON.stringify(value));

// Only the current user's imperative can offer a write tool. The model and
// quoted history cannot create that permission. Confirmation may refer to the
// last real, unexpired preview in this actor's server-owned conversation.
export function cleanupAuthority(question, previews, now = Date.now()) {
  const text = question.normalize('NFKC').trim();
  if (/[?？“”"'「」『』;；\n]/u.test(text) || /不要|不用|不清理|不删除|不执行|别|取消|停止|禁止|怎么|如何|为什么|是否|可以|能否|能不能|会不会|建议|例如|比如|假如|如果|重启|修改|部署|数据库|备份|日志|上传|\/|\$|`/u.test(text)) return [];
  const explicit = /^(?:(?:请|帮我|请帮我|现在|立即|确认)\s*)*(?:执行)?(?:清理|删除|清除)(?:一下)?(?:阿里(?:云)?(?:服务器)?(?:和腾讯(?:云)?(?:服务器)?)?|腾讯(?:云)?(?:服务器)?(?:和阿里(?:云)?(?:服务器)?)?|两(?:台|个)(?:服务器)?|全部服务器|所有服务器|这些|上述|刚才预览的)?(?:的)?(?:(?:过期|安全|限定)的?|(?:超过)?7天(?:前|以上)?的?)*(?:临时文件(?:和缓存)?|缓存|安装包缓存)(?:一下)?[。！!]?$/u.test(text);
  const confirmation = /^(?:请)?确认(?:执行)?清理[。！!]?$/u.test(text);
  if (!explicit && !confirmation) return [];
  const selected = /两(?:台|个)|全部|所有|阿里[\s\S]*腾讯|腾讯[\s\S]*阿里/u.test(text) ? SERVERS
    : /阿里/u.test(text) ? ['aliyun'] : /腾讯/u.test(text) ? ['tencent'] : [];
  return selected.length ? selected : SERVERS.filter(server => previews[server]?.expiresAt > now);
}

function stepSummary(action, data) {
  if (action === 'status') return `可用空间 ${(data.disk?.availableBytes / 2 ** 30).toFixed(2)} GiB`;
  if (action === 'plan') return `可清理 ${data.candidateCount} 项，${data.candidateBytes} 字节；尚未删除`;
  if (action === 'clean') return `实际删除 ${data.deletedCount} 项，${data.deletedBytes} 字节`;
  return data.topic === 'disk' ? `目录 ${data.path}；${data.limited ? '扫描达到上限' : '扫描完成'}`
    : data.topic === 'logs' ? `${data.service} 最近一小时日志`
    : data.topic === 'service' ? `${data.service} 服务详情` : '进程资源快照';
}

function trimHistory(turns) {
  const kept = turns.slice(-4);
  while (kept.length && (bytes(kept.flat()) > 40 * 1024 || kept.flat().length > 28)) kept.shift();
  return kept;
}
function remember(turn) {
  if (bytes(turn) <= 20 * 1024 && turn.length <= 14) return turn;
  const summary = turn.at(-1).content.slice(0, 4000).replace(/[\uD800-\uDBFF]$/u, '');
  return [turn[0], { role: 'assistant', content: summary }];
}

/** Stateful private agent. Tools only receive actor-bound signed RPC capability;
 * neither a browser transcript nor a model-supplied shell command is accepted. */
export function createServerAgentConversation({ now = Date.now } = {}) {
  const conversations = new Map();
  return async ({ actor, question, conversationId, call, model, webSearch, capabilities = [], signal, general = false, allowCleanup = true }) => {
    const timestamp = now();
    for (const [id, item] of conversations) if (!item.busy && timestamp - item.touched > TTL) conversations.delete(id);
    let state = conversationId ? conversations.get(conversationId) : null;
    const uiActions=[];
    const envelope = (answer, steps = []) => ({ answer, mode: 'server_maintenance', conversationId: state.id,
      steps, ...(uiActions.length ? {uiActions:[...new Set(uiActions)]} : {}), operationConfirmed: steps.length > 0 && steps.every(step => step.ok) });
    if (conversationId && (!state || state.actor !== actor || state.general !== general)) {
      return { answer: '这段服务器会话已过期或不属于当前账号，请清空会话后重新描述问题。', mode: 'server_maintenance', operationConfirmed: false, steps: [] };
    }
    if (!state) {
      if (conversations.size >= 128) {
        return { answer: '服务器助手会话已满，请稍后重试。', mode: 'server_maintenance', operationConfirmed: false, steps: [] };
      }
      state = { id: randomBytes(24).toString('hex'), actor, general, touched: timestamp, turns: [], previews: {}, pendingCleanup: {}, pendingOperations: {}, busy: false };
      conversations.set(state.id, state);
    }
    if (state.busy) return envelope('这段会话正在处理上一条请求，请等待回执。');
    state.busy = true; state.touched = timestamp;
    const steps = [], turn = [{ role: 'user', content: question }];
    const allowed = allowCleanup ? cleanupAuthority(question, state.previews, timestamp) : [];
    const serviceGrants=serviceAuthority(question);
    const offeredCapabilities=capabilities.filter(capability=>capability!=='services' || serviceGrants.length>0);
    const freshTargets = allowCleanup ? cleanupAuthority(question, {}, timestamp) : [];
    const deadline = now() + 135_000;
    const controller = AbortSignal.any([AbortSignal.timeout(135_000), ...(signal ? [signal] : [])]);
    const check = () => { if (controller.aborted || now() >= deadline) throw new Error('AGENT_TIMEOUT'); };
    const executed = new Map();
    try {
      for (let round = 0; round < 7; round++) {
        check();
        const history = trimHistory(state.turns);
        while (history.length && (history.flat().length + turn.length > 40 || bytes([...history.flat(), ...turn]) > MAX_CONTEXT)) history.shift();
        const messages = [...history.flat(), ...turn];
        if (bytes(messages) > MAX_CONTEXT) throw new Error('AGENT_CONTEXT_LIMIT');
        const result = await model({ operation: 'server_agent_turn', messages: structuredClone(messages), allowCleanup: allowed, ...(offeredCapabilities.length ? {capabilities:offeredCapabilities} : {}), ...(general ? { purpose: 'general' } : {}) }, { signal: controller, deadline });
        check();
        const message = result?.message;
        if (!message || message.role !== 'assistant' || (message.content != null && !readable(message.content))) throw new Error('AGENT_MODEL_PROTOCOL');
        const calls = message.tool_calls;
        if (!calls?.length) {
          if (result.finishReason !== 'stop' || !readable(message.content) || !message.content.trim()) throw new Error('AGENT_MODEL_PROTOCOL');
          turn.push({ role: 'assistant', content: message.content.trim() });
          state.turns = trimHistory([...state.turns, remember(turn)]);
          return envelope(message.content.trim(), steps);
        }
        if (result.finishReason !== 'tool_calls' || !Array.isArray(calls) || calls.length > 4 || steps.length + calls.length > 12) throw new Error('AGENT_TOOL_LIMIT');
        // Validate every call before performing any action in the batch.
        const ids = new Set();
        const parsed = calls.map(item => {
          if (item?.type !== 'function' || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/u.test(item.id) || ids.has(item.id) || typeof item.function?.arguments !== 'string' || item.function.arguments.length > 22000) throw new Error('AGENT_MODEL_PROTOCOL');
          ids.add(item.id);
          const args = JSON.parse(item.function.arguments);
          if (!validServerToolCall(item.function.name, args, { allowCleanup: allowed, capabilities:offeredCapabilities })) throw new Error('AGENT_TOOL_DENIED');
          // Scope tool IDs to this conversation turn, even if a provider reuses
          // an ID from a completed historical turn.
          return { item: { ...item, id: `oa_${randomBytes(12).toString('hex')}` }, args, name: item.function.name };
        });
        turn.push({ role: 'assistant', content: message.content || '', tool_calls: parsed.map(({ item }) => ({
          id: item.id, type: 'function', function: { name: item.function.name, arguments: item.function.arguments },
        })) });
        for (const { item, args, name } of parsed) {
          check();
          const server = args.server || (name === 'web_search' ? 'web' : 'interface');
          let output;
          try {
            const operation=await executeAssistantOperation(name,args,{state,call,webSearch,signal:controller,cache:executed,capabilities,serviceGrants});
            if (operation) {
              output=operation;
              if (output.uiAction) uiActions.push(output.uiAction);
              const ok=!['failed','uncertain','running'].includes(output.state) && (output.state!=='cancelled' || name==='command_cancel') && (output.operation!=='service' || output.statusVerified===true);
              steps.push({server,action:output.action==='operations' ? `operations:${output.operation}` : output.action,ok,summary:operationSummary(output)});
            } else {
            if (name === 'cleanup_execute' && executed.has(server)) output = executed.get(server);
            else {
              let action, parameters = {};
              if (name === 'server_status') action = 'status';
              else if (name === 'server_diagnostic') {
                action = 'diagnostic'; parameters = { topic: args.topic };
                if (args.service) parameters.service = args.service.endsWith('.service') ? args.service : `${args.service}.service`;
                if (args.topic === 'disk') parameters.path = args.path || '/';
              }
              else if (name === 'cleanup_preview') action = 'plan';
              else if (name === 'cleanup_execute') {
                action = 'clean';
                let plan = state.pendingCleanup[server] || state.previews[server];
                if (!state.pendingCleanup[server] && (!plan || plan.expiresAt <= now())) {
                  if (!freshTargets.includes(server)) throw new Error('AGENT_PREVIEW_EXPIRED');
                  plan = await call(server, 'plan', {}, { signal: controller });
                  check();
                  if (!/^[a-f0-9]{64}$/u.test(plan.planId)) throw new Error('AGENT_INVALID_PLAN');
                  if (!Number.isFinite(plan.expiresAt) || plan.expiresAt * 1000 <= now()) throw new Error('AGENT_INVALID_PLAN');
                  state.previews[server] = { ...plan, expiresAt: plan.expiresAt * 1000 };
                }
                parameters = { planId: plan.planId };
                // An uncertain cleanup is retried with the same idempotent plan,
                // even if a later read-only preview is requested.
                state.pendingCleanup[server] = plan;
              } else throw new Error('AGENT_TOOL_DENIED');
              check();
              output = await call(server, action, parameters, { signal: controller });
              if (action === 'plan') {
                if (!/^[a-f0-9]{64}$/u.test(output.planId) || !Number.isFinite(output.expiresAt) || output.expiresAt * 1000 <= now()) throw new Error('AGENT_INVALID_PLAN');
                state.previews[server] = { ...output, expiresAt: output.expiresAt * 1000 };
              }
              if (action === 'clean') {
                if (![output.deletedCount, output.deletedBytes, output.diskBefore?.availableBytes, output.diskAfter?.availableBytes].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) throw new Error('AGENT_INVALID_CLEAN');
                executed.set(server, output); delete state.previews[server]; delete state.pendingCleanup[server];
              }
              if (action === 'diagnostic' && (output.topic !== args.topic || (parameters.service && output.service !== parameters.service) || (parameters.path && output.path !== parameters.path))) throw new Error('AGENT_INVALID_DIAGNOSTIC');
            }
            const action = output.action;
            steps.push({ server, action: action === 'diagnostic' ? `${action}:${args.topic}` : action, ok: true, summary: stepSummary(action, output) });
            }
          } catch (error) {
            output = { ok: false, server, error: '工具没有返回可核对的成功回执。不要推测操作已经完成。', ...(error?.operationError ? {code:error.operationError} : {}) };
            steps.push({ server, action: name, ok: false, summary: '未取得成功回执' });
          }
          // Plan IDs stay inside OA. The model selects a server, never a token.
          const visible = { ...output }; delete visible.planId;
          delete visible.requestId;
          for (const field of ['content','output']) if (typeof visible[field] === 'string' && visible[field].length > 12000) {visible[field]=visible[field].slice(0,12000).toWellFormed();visible.outputLimited=true;}
          if (Array.isArray(visible.entries)) {
            while (JSON.stringify(visible).length > 15000 && visible.entries.length) { visible.entries.shift(); visible.limited = true; }
          }
          const content = JSON.stringify(visible);
          if (Buffer.byteLength(content) > 24 * 1024) throw new Error('AGENT_TOOL_RESPONSE_LIMIT');
          turn.push({ role: 'tool', tool_call_id: item.id, content });
        }
      }
      throw new Error('AGENT_TOOL_LIMIT');
    } catch (error) {
      const explanation = controller.aborted || error?.message === 'AGENT_TIMEOUT' ? '本次诊断已超时。' : '本次模型诊断未能完成。';
      const completed = steps.filter(step => step.ok);
      const detail = completed.length ? `\n已取得的服务器回执：\n${completed.map(step => `${NAMES[step.server]}：${step.summary}`).join('\n')}` : '\n尚未取得服务器操作成功回执。';
      // Keep only a completed user/assistant turn; unfinished tool call chains
      // must never be replayed into the next model request.
      const answer = `${explanation}${detail}\n可以继续提问；清理结果以实际回执为准。`;
      state.turns = trimHistory([...state.turns, [{ role: 'user', content: question }, { role: 'assistant', content: answer }]]);
      return { ...envelope(answer, steps), operationConfirmed: false };
    } finally { state.busy = false; state.touched = now(); }
  };
}

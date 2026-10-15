import { createTaskToolModel } from './task-tool-model.mjs';
import { decryptSecret } from './crypto.mjs';
import { aliyunEndpoint } from './knowledge.mjs';
import { SERVER_AGENT_SYSTEM_PROMPT, GENERAL_AGENT_SYSTEM_PROMPT, serverAgentTools, validServerAgentPayload, normalizeServerAgentReply } from '../../integrations/server-maintenance/tool-policy.mjs';

export { validServerAgentPayload } from '../../integrations/server-maintenance/tool-policy.mjs';

/** One service-authenticated model turn. OA retains all server/tool authority;
 * Chat retains its encrypted provider configuration and per-call model budget.
 * Call only after the existing OA bridge HMAC/replay authentication succeeds.
 */
export async function completeServerAgentTurn(context, engine, config, payload) {
  if (!validServerAgentPayload(payload)) throw new Error('SERVER_AGENT_INPUT');
  if (engine.modelProvider(context, config)?.provider !== 'bailian') throw new Error('SERVER_AGENT_MODEL_UNAVAILABLE');
  const transport = createTaskToolModel({
    endpoint: aliyunEndpoint(config.baseUrl),
    apiKey: await decryptSecret(config.encryptedKey, context.env.APP_ENCRYPTION_KEY),
    model: config.model,
    fetcher: (...args) => context.runtime.fetch(...args),
    consumeBudget: async () => { await engine.globalBudget(context); },
  });
  const reply = await transport({
    messages: [{ role: 'system', content: payload.purpose === 'general' ? GENERAL_AGENT_SYSTEM_PROMPT : SERVER_AGENT_SYSTEM_PROMPT }, ...payload.messages],
    tools: serverAgentTools({ allowCleanup: payload.allowCleanup, capabilities: payload.capabilities }),
    deadline: Date.now() + 45000,
  });
  return { received: true, mode: 'server_agent_turn', provider: 'bailian',
    message: normalizeServerAgentReply(reply, payload.allowCleanup, payload.capabilities), finishReason: reply.finishReason };
}

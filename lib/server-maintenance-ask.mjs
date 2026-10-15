// The fixed host module owns administrator verification, command matching,
// signed server calls and cleanup limits. Other runtimes keep normal OA chat.
const maintenanceModule = 'file:///opt/originmind-maintenance/conversation.mjs';
let conversation;

export async function answerServerMaintenanceQuestion(request, question, options = {}) {
  if (process.env.OA_RUNTIME !== 'aliyun') return null;
  conversation ??= import(/* webpackIgnore: true */ /* @vite-ignore */ maintenanceModule)
    .then(({ createServerMaintenanceConversation }) => createServerMaintenanceConversation({
      port: Number(process.env.PORT || 3000),
    }));
  const answer = await conversation;
  const model = options.dedicated
    ? (await import('./oa-chat-client')).serverAgentModelTurn : undefined;
  const webSearch = options.dedicated
    ? (await import('./oa-chat-client')).serverAgentWebSearch : undefined;
  // Browser history cannot provide tools or authority; the private host owns it.
  return answer(request, question, { ...options, model, webSearch, signal: request.signal });
}

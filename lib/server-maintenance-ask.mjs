// The fixed host module owns administrator verification, command matching,
// signed server calls and cleanup limits. Other runtimes keep normal OA chat.
const maintenanceModule = 'file:///opt/originmind-maintenance/conversation.mjs';
let conversation;

export async function answerServerMaintenanceQuestion(request, question) {
  if (process.env.OA_RUNTIME !== 'aliyun') return null;
  conversation ??= import(/* webpackIgnore: true */ /* @vite-ignore */ maintenanceModule)
    .then(({ createServerMaintenanceConversation }) => createServerMaintenanceConversation({
      port: Number(process.env.PORT || 3000),
    }));
  const answer = await conversation;
  // Only the current validated question can authorize a server action.
  return answer(request, question, { signal: request.signal });
}

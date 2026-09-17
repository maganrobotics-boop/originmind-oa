/** POST/PUT accepts only the authenticated OA origin or the existing Chat origin. Missing/null origins fail closed. */
export function isKnowledgeUploadOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin || origin === 'null') return false;
  return origin === 'https://chat.omindos.ai' || origin === new URL(request.url).origin;
}

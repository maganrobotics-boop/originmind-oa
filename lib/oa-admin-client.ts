import { OA_ADMIN_ORIGIN, OA_ADMIN_PATH, signOaAdminRequest } from '../chat-cloudflare/src/oa-admin-bridge.mjs';

export type OaAdminResult = {
  initialized?: boolean;
  signedIn?: boolean;
  sessionToken?: string;
  baseUrl?: string;
  model?: string;
  keyConfigured?: boolean;
  encryptionReady?: boolean;
  activeProvider?: string | null;
  workersAiReady?: boolean;
  verifiedAt?: string | null;
  saved?: boolean;
  connected?: boolean;
};

export class OaAdminBridgeError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function boundedJson(response: Response, maximum = 16 * 1024): Promise<Record<string, unknown>> {
  if (!response.headers.get('content-type')?.startsWith('application/json') || !response.body) throw new Error('OA_ADMIN_INVALID_RESPONSE');
  const reader = response.body.getReader(); const parts: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.length;
      if (length > maximum) { await reader.cancel(); throw new Error('OA_ADMIN_RESPONSE_LIMIT'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('OA_ADMIN_INVALID_RESPONSE');
  return value as Record<string, unknown>;
}

export async function callOaAdmin(payload: object): Promise<OaAdminResult> {
  const { env } = await import('cloudflare:workers');
  const bindings = env as typeof env & {
    PUBLIC_LAB_AI_SERVICE_TOKEN?: string;
    CHAT_SERVICE?: { fetch: typeof fetch };
  };
  const secret = bindings.PUBLIC_LAB_AI_SERVICE_TOKEN || '';
  if (secret.length < 32) throw new Error('OA_ADMIN_SECRET_MISSING');
  if (!bindings.CHAT_SERVICE || typeof bindings.CHAT_SERVICE.fetch !== 'function') throw new Error('OA_ADMIN_SERVICE_BINDING_MISSING');
  const body = JSON.stringify(payload);
  if (new TextEncoder().encode(body).length > 8 * 1024) throw new OaAdminBridgeError('请求内容过长。', 413);
  const response = await bindings.CHAT_SERVICE.fetch(`${OA_ADMIN_ORIGIN}${OA_ADMIN_PATH}`, {
    method: 'POST', headers: await signOaAdminRequest(body, secret), body,
    cache: 'no-store', redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(70000),
  });
  const data = await boundedJson(response);
  if (!response.ok) throw new OaAdminBridgeError(typeof data.error === 'string' ? data.error : '管理服务暂不可用。', response.status);
  if (data.received !== true) throw new Error('OA_ADMIN_INVALID_RESPONSE');
  delete data.received;
  return data as OaAdminResult;
}

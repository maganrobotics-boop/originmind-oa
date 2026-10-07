import { FUTURE_STARS_ORIGIN, FUTURE_STARS_PATH, signFutureStarsRequest } from '../chat-cloudflare/src/future-stars-bridge.mjs';

export class FutureStarsError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export async function callFutureStars(payload: object): Promise<Record<string, unknown>> {
  const { env } = await import('cloudflare:workers');
  const bindings = env as typeof env & { PUBLIC_LAB_AI_SERVICE_TOKEN?: string; CHAT_SERVICE?: { fetch: typeof fetch } };
  const secret = bindings.PUBLIC_LAB_AI_SERVICE_TOKEN || '';
  if (secret.length < 32 || !bindings.CHAT_SERVICE) throw new FutureStarsError('未来之星管理服务暂不可用。', 503);
  const body = JSON.stringify(payload);
  if (new TextEncoder().encode(body).length > 16000) throw new FutureStarsError('请求内容过长。', 413);
  const response = await bindings.CHAT_SERVICE.fetch(`${FUTURE_STARS_ORIGIN}${FUTURE_STARS_PATH}`, {
    method: 'POST', headers: await signFutureStarsRequest(body, secret), body,
    credentials: 'omit', redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(20000),
  });
  if (!response.headers.get('content-type')?.startsWith('application/json') || !response.body) throw new FutureStarsError('管理数据暂不可用。', 503);
  const reader = response.body.getReader(); const parts: Uint8Array[] = []; let length = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break;
      length += value.length; if (length > 512 * 1024) { await reader.cancel(); throw new FutureStarsError('数据过多，请缩小筛选范围。', 502); } parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<string, unknown>;
  if (!response.ok) throw new FutureStarsError(typeof data.error === 'string' ? data.error : '操作失败，请稍后重试。', response.status);
  if (data.received !== true) throw new FutureStarsError('管理数据暂不可用。', 503);
  delete data.received;
  return data;
}

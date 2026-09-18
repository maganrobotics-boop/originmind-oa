/** Feishu encrypted event format; signature is checked over the untouched body.
 * https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case
 */
const encoder = new TextEncoder();
export async function feishuDigest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let different = 0; for (let i = 0; i < a.length; i++) different |= a.charCodeAt(i) ^ b.charCodeAt(i); return different === 0;
}
export async function readFeishuEvent(request, encryptKey, verificationToken, now = Date.now()) {
  if (typeof encryptKey !== 'string' || encryptKey.length < 16 || typeof verificationToken !== 'string' || verificationToken.length < 16) throw new Error('FEISHU_EVENT_DISABLED');
  if (request.method !== 'POST' || request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json' || !request.body) throw new Error('FEISHU_EVENT_INVALID');
  const reader = request.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 160000) { await reader.cancel(); throw new Error('FEISHU_EVENT_TOO_LARGE'); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes), outer = JSON.parse(raw);
  if (typeof outer?.encrypt !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(outer.encrypt)) throw new Error('FEISHU_EVENT_UNENCRYPTED');
  const encrypted = Uint8Array.from(atob(outer.encrypt), ch => ch.charCodeAt(0));
  if (encrypted.length < 32 || encrypted.length % 16 !== 0) throw new Error('FEISHU_EVENT_INVALID');
  const key = await crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', encoder.encode(encryptKey)), 'AES-CBC', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: encrypted.slice(0,16) }, key, encrypted.slice(16));
  const event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
  if (!equal(event?.header?.token ?? event?.token, verificationToken)) throw new Error('FEISHU_EVENT_UNAUTHORIZED');
  // Endpoint-verification challenges are encrypted and token-authenticated;
  // ordinary events additionally require the timestamped request signature.
  if (event.type === 'url_verification' && typeof event.challenge === 'string' && event.challenge.length <= 512) return event;
  const time = request.headers.get('x-lark-request-timestamp') || '', nonce = request.headers.get('x-lark-request-nonce') || '';
  const signature = request.headers.get('x-lark-signature') || '';
  if (!/^\d{10,12}$/u.test(time) || Math.abs(Math.floor(now/1000) - Number(time)) > 300 || !/^[A-Za-z0-9_-]{1,128}$/u.test(nonce)
    || !equal(signature, await feishuDigest(time + nonce + encryptKey + raw))) throw new Error('FEISHU_EVENT_UNAUTHORIZED');
  return event;
}
